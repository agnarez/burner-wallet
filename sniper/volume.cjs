'use strict';

/**
 * AGNA sniper volume runner — fixed-size buy/sell round trips ("spam sniper")
 * on our own AGNAmuse V2 DEX: 500 round trips = 1,000 trading txns per chain,
 * 4,000 total across Sepolia, Arc Testnet, Robinhood Chain testnet, LitVM testnet.
 *
 * Trade sizes (fixed per round trip; <~0.5% price impact per trade and
 * total AGNA burned < ~5% of the 404T supply):
 *   sepolia            0.00005  ETH
 *   arc-testnet        0.01     USDC (ERC-20 path, 6 decimals)
 *   robinhood-testnet  0.000005 ETH (thinnest pool — do NOT raise)
 *   litvm-testnet      0.00005  zkLTC
 *
 * Sell size: 93% of the QUOTED buy output. Why not 98%: the AGNA token
 * takes a 5% transfer tax on buys, so the buyer actually receives only
 * ~95% of the quoted output. Selling 98% of the quote would exceed what
 * each buy delivers and drain the burner's AGNA balance after ~140 round
 * trips (starting 3.6-4.0T, net -0.03x quote per trip). 93% of the quote
 * is ~98% of what was actually received, keeps the balance growing, and
 * keeps total burn under ~5% of supply.
 * Sell proceeds go back to the BURNER (not the agent wallet) so the loop
 * is self-funding; otherwise the burner would bleed base tokens dry.
 * Slippage: buy minOut = 95% of quote; sell minOut = 90% of the sell
 * quote (the sell's input is taxed 5% before the pair sees it, so the
 * pair's actual output is ~95% of the quote — 90% leaves headroom).
 *
 * Approves (AGNA -> router, and on Arc predeploy USDC -> router) are
 * one-time setup txns, awaited, NOT counted in the 1,000.
 *
 * Resumable: checkpoints every 25 round trips; per-chain locks; a resume
 * cron re-runs this script and it picks up where it left off. Never
 * re-sends a nonce already submitted; fills nonce gaps with a 0-value
 * self-transfer so the queue never stalls.
 *
 * Safety brakes (stop the chain, do not force it): burner gas balance
 * under Sepolia 0.005 ETH / RH 0.001 ETH / LitVM 0.005 zkLTC / Arc 5 USDC;
 * pool reserves moved > ~15% from baseline; same nonce failing 3 times.
 *
 * Usage:
 *   node volume.cjs --chain sepolia            # run one chain, 500 rounds (default)
 *   node volume.cjs --chain sepolia --rounds 50 # run one chain, 50 more rounds
 *   node volume.cjs --chain all                # all four, sequentially
 *   node volume.cjs --chain all --resume-only  # resume in-flight batches only;
 *                                              # never starts a new batch (resume cron)
 *   node volume.cjs --chain sepolia --smoke    # quote + build only, send nothing
 *   node volume.cjs --chain sepolia --verify   # poll receipts, print final summary
 *   node volume.cjs --chain all --verify
 *
 * Batches: --rounds N applies ONLY when starting a new batch. A batch's
 * target (cumulative rounds) is stored in the checkpoint; a later run
 * resumes that target as-is and never inflates it. So the big first run
 * (default 500) resumed by the 5-minute cron keeps its 500 total, while
 * the hourly cron (--rounds 50) starts a fresh 50-round batch each hour
 * once the previous batch is complete. The per-chain lock keeps
 * concurrent runs out; a stale lock (dead PID or heartbeat > 10 min old)
 * is cleared so a later run can proceed.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { loadConfig } = require('./src/config');
const { routerContract, pairContract, tokenContract } = require('./src/swap');
const { applySlippage, parseToDecimals, formatDecimals } = require('./src/strategy');

const BURNER = '0x6F311641923246e7f4fE2F1F679c75f4DE107621';
const BACKUP_PATH = process.env.BACKUP_PATH || '/home/hatch/workspace/user/files/burner_wallet_backup__JSON__0_mnno.json';
const STATE_DIR = process.env.VOLUME_STATE_DIR || '/home/hatch/workspace/goals/burner-wallet/hidden_files';
const STATE_FILE = path.join(STATE_DIR, 'txn-volume-sniper.json');
const TARGET_ROUNDS = 500; // default --rounds: the big first run does 500 per chain
const CHECKPOINT_EVERY = 25;

const AGNA = {
  sepolia: '0xA69000408A00F35F70C5dD5f73e8c687514BF522',
  'arc-testnet': '0xa69000Fb025DDe35F126332331c2746979845E56',
  'robinhood-testnet': '0xa69000FF81232ac079eC2265fD4da3100F243fc3',
  'litvm-testnet': '0xa69000FF81232ac079eC2265fD4da3100F243fc3',
};
const PAIRS = {
  sepolia: '0x43E54E53dafe9467725be66Aa34d799d0Ff6F630',
  'arc-testnet': '0xba3746f46Fbfe22E4E17083F1769b359A0b8956a',
  'robinhood-testnet': '0x699d97ACc97bB067842Bbe8CE89dC52d805D0a22',
  'litvm-testnet': '0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9',
};
const TRADE_SIZE = {
  sepolia: '0.00005',
  'arc-testnet': '0.01',
  'robinhood-testnet': '0.000005',
  'litvm-testnet': '0.00005',
};
const GAS_FLOOR_GWEI = {
  // Sepolia was 17 wei (0.000000017 gwei). On 2026-11-19 that left ~72 txns
  // stuck unmined in a mempool (base fee ~16 wei; a 17-wei legacy txn is
  // barely includable and gets evicted/deprioritised). Raised to 0.01 gwei
  // (~600,000x the base fee): the remaining ~880 Sepolia txns cost only
  // ~0.0015 ETH at this price, and the txns can no longer be evicted.
  sepolia: '0.01',
  'arc-testnet': '31.625',
  'robinhood-testnet': '0.01',
  'litvm-testnet': '0.01',
};
// Stop the chain if the burner's gas balance falls under these.
const GAS_BRAKE = {
  sepolia: ethers.parseEther('0.005'),
  'arc-testnet': ethers.parseUnits('5', 18),
  'robinhood-testnet': ethers.parseEther('0.001'),
  'litvm-testnet': ethers.parseEther('0.005'),
};
const SELL_OF_QUOTE_BPS = 9300; // sell 93% of quoted buy output
const BUY_SLIPPAGE_BPS = 500; // buy minOut = 95% of quote
const SELL_SLIPPAGE_BPS = 1000; // sell minOut = 90% of sell quote
const DEADLINE_SECONDS = 60 * 20;
const MAX_GAS_GWEI = 100;

const ERC20_FULL_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function totalSupply() external view returns (uint256)',
];
// swap.js's ERC20_ABI has no totalSupply — use this for the AGNA token.
function tokenContractFull(addr, runner) { return new ethers.Contract(addr, ERC20_FULL_ABI, runner); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deadline() { return Math.floor(Date.now() / 1000) + DEADLINE_SECONDS; }
function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

function parseArgs(argv) {
  const args = { chain: null, smoke: false, verify: false, rounds: TARGET_ROUNDS, resumeOnly: false, sendDelayMs: 0 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain') args.chain = argv[++i];
    else if (argv[i] === '--smoke') args.smoke = true;
    else if (argv[i] === '--verify') args.verify = true;
    else if (argv[i] === '--resume-only') args.resumeOnly = true;
    else if (argv[i] === '--send-delay-ms') {
      args.sendDelayMs = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.sendDelayMs) || args.sendDelayMs < 0) throw new Error('--send-delay-ms must be a non-negative integer (ms)');
    }
    else if (argv[i] === '--rounds') {
      args.rounds = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.rounds) || args.rounds <= 0) throw new Error('--rounds must be a positive integer');
    }
  }
  if (!args.chain) throw new Error('Usage: node volume.cjs --chain <sepolia|arc-testnet|robinhood-testnet|litvm-testnet|all> [--rounds N] [--resume-only] [--send-delay-ms N] [--smoke|--verify]');
  return args;
}

function loadPrivateKey() {
  const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const pk = raw?.chains?.ethereum_evm?.privateKey || raw?.ethereum_evm?.privateKey;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('Burner EVM private key not found in backup file');
  const w = new ethers.Wallet(pk);
  if (w.address.toLowerCase() !== BURNER.toLowerCase()) {
    throw new Error(`Backup key does not match burner address (got ${w.address})`);
  }
  return pk;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { version: 1, chains: {} }; }
}
// Chains this process modified (only these are merged back on save —
// other chains' entries on disk belong to sibling processes and must
// never be clobbered by our stale in-memory copy).
const DIRTY_CHAINS = new Set();
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Serialize writers across processes: mkdir is atomic.
  const lockDir = STATE_FILE + '.writelock';
  const start = Date.now();
  while (true) {
    try { fs.mkdirSync(lockDir); break; } catch {
      if (Date.now() - start > 10000) break; // proceed best-effort
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    let disk = { version: 1, chains: {} };
    try { disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* missing/corrupt */ }
    for (const k of DIRTY_CHAINS) { if (s.chains[k]) disk.chains[k] = s.chains[k]; }
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
  }
}
function chainState(state, key) {
  if (!state.chains[key]) {
    state.chains[key] = {
      baseline: null, approvesDone: false, approveHashes: [],
      roundsDone: 0, txnsSubmitted: 0, nextNonce: null,
      batchStart: null, batchTarget: null,
      hashes: [], tradeHashes: [], firstBuyHash: null, firstSellHash: null,
      lastBuyHash: null, lastSellHash: null,
      failures: [], fillers: [], status: 'new', stopReason: null, lastError: null, errorCount: 0,
      gasSpentWei: '0', updatedAt: null,
    };
  }
  return state.chains[key];
}

function lockPath(key) { return path.join(STATE_DIR, `txn-volume-sniper.${key}.lock`); }
function acquireLock(key) {
  const lp = lockPath(key);
  try {
    const old = JSON.parse(fs.readFileSync(lp, 'utf8'));
    try { process.kill(old.pid, 0); } catch { /* pid dead -> stale lock */ 
      fs.unlinkSync(lp);
    }
    if (fs.existsSync(lp)) {
      // PID alive — but is it our script? Check heartbeat freshness.
      const ageMs = Date.now() - new Date(old.updatedAt).getTime();
      if (ageMs < 10 * 60 * 1000) return null; // live lock, another instance is running
      fs.unlinkSync(lp); // stale heartbeat
    }
  } catch { /* no lock file */ }
  const lock = { pid: process.pid, chain: key, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(lp, JSON.stringify(lock, null, 2));
  return lock;
}
function heartbeatLock(key) {
  const lp = lockPath(key);
  try {
    const lock = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (lock.pid !== process.pid) return;
    lock.updatedAt = new Date().toISOString();
    fs.writeFileSync(lp, JSON.stringify(lock, null, 2));
  } catch { /* ignore */ }
}
function releaseLock(key) { try { fs.unlinkSync(lockPath(key)); } catch { /* ignore */ } }

async function fetchGasPrice(provider, cfg) {
  const fee = await provider.getFeeData();
  const live = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const floor = ethers.parseUnits(GAS_FLOOR_GWEI[cfg.chainKey], 'gwei');
  let gp = live > floor ? live : floor;
  gp = (gp * 110n) / 100n; // 1.1x bump so txns don't stall
  if (gp > ethers.parseUnits(String(MAX_GAS_GWEI), 'gwei')) {
    throw new Error(`gas price ${ethers.formatUnits(gp, 'gwei')} gwei exceeds cap ${MAX_GAS_GWEI} gwei — stopping chain`);
  }
  return gp;
}

async function readBaseline(provider, cfg) {
  const agna = tokenContractFull(AGNA[cfg.chainKey], provider);
  const pair = pairContract(PAIRS[cfg.chainKey], provider);
  const [nonce, bal, agnaBal, supply, reserves] = await Promise.all([
    provider.getTransactionCount(BURNER, 'pending'),
    provider.getBalance(BURNER),
    agna.balanceOf(BURNER),
    agna.totalSupply(),
    pair.getReserves(),
  ]);
  return {
    startNonce: nonce,
    nativeBalance: bal.toString(),
    agnaBalance: agnaBal.toString(),
    agnaTotalSupply: supply.toString(),
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    gasPriceGwei: ethers.formatUnits((await provider.getFeeData()).gasPrice ?? 0n, 'gwei'),
  };
}

async function pollReceipts(provider, hashes, { timeoutMs = 600000, batchSize = 50 } = {}) {
  const results = new Map();
  const pending = new Set(hashes.filter(Boolean));
  const start = Date.now();
  while (pending.size > 0 && Date.now() - start < timeoutMs) {
    const batch = [...pending].slice(0, batchSize);
    const rs = await Promise.all(batch.map((h) => provider.getTransactionReceipt(h).catch(() => null)));
    rs.forEach((r, i) => { if (r) { results.set(batch[i], r); pending.delete(batch[i]); } });
    if (pending.size > 0) await sleep(2000);
  }
  return { results, unmined: [...pending] };
}

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await sleep(1000 * (i + 1)); }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.shortMessage || lastErr.message}`);
}

async function sendWithRetry(wallet, tx, label) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await wallet.sendTransaction(tx);
    } catch (e) {
      lastErr = e;
      const msg = ((e.shortMessage || e.message || '') + ' ' + (e.code || '')).toLowerCase();
      if (msg.includes('already known') || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced')) {
        throw new Error(`${label}: ${e.shortMessage || e.message} — stopping chain (nonce conflict)`);
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`${label}: send failed after 3 attempts: ${lastErr.shortMessage || lastErr.message}`);
}

async function runChain(chainKey, { smoke = false, verifyOnly = false, rounds = TARGET_ROUNDS, resumeOnly = false, sendDelayMs = 0 } = {}) {
  const pk = loadPrivateKey();
  const cfg = loadConfig({
    CHAIN: chainKey,
    PRIVATE_KEY: pk,
    DRY_RUN: 'false',
    BUY_AMOUNT_NATIVE: TRADE_SIZE[chainKey],
    SLIPPAGE_BPS: BUY_SLIPPAGE_BPS,
  });
  // 30s request timeout: ethers has no default timeout, so a stalled RPC
  // connection hangs forever (Sepolia did exactly that on 2026-11-19 via
  // Tenderly — the first send never returned). With a timeout the call
  // throws, and withRetry / sendWithRetry retries it instead of hanging.
  const req = new ethers.FetchRequest(cfg.rpcUrl);
  req.timeout = 30000;
  const provider = new ethers.JsonRpcProvider(req);
  const wallet = new ethers.Wallet(pk, provider);
  const agnaAddr = AGNA[chainKey];
  const pairAddr = PAIRS[chainKey];
  const router = routerContract(cfg.router, provider);
  const agnaC = tokenContractFull(agnaAddr, provider);
  const pairC = pairContract(pairAddr, provider);
  const baseC = tokenContract(cfg.baseToken, provider);
  const amountIn = cfg.buyWithERC20
    ? parseToDecimals(TRADE_SIZE[chainKey], cfg.baseDecimals ?? 18)
    : ethers.parseEther(TRADE_SIZE[chainKey]);

  if (verifyOnly) return verifyChain(provider, cfg, chainKey);

  // ---- smoke: quote + build one round trip, send nothing ----
  if (smoke) {
    const base = await readBaseline(provider, cfg);
    log(`[smoke:${chainKey}] nonce=${base.startNonce} native=${ethers.formatEther(base.nativeBalance)} AGNA=${formatDecimals(BigInt(base.agnaBalance), 18)} supply=${formatDecimals(BigInt(base.agnaTotalSupply), 18)}`);
    log(`[smoke:${chainKey}] reserves r0=${base.reserve0} r1=${base.reserve1}`);
    const amounts = await router.getAmountsOut(amountIn, [cfg.baseToken, agnaAddr]);
    const quotedOut = amounts[amounts.length - 1];
    const buyMinOut = applySlippage(quotedOut, BUY_SLIPPAGE_BPS);
    log(`[smoke:${chainKey}] buy ${TRADE_SIZE[chainKey]} ${cfg.nativeSymbol} -> quoted ${formatDecimals(quotedOut, 18)} AGNA, minOut ${formatDecimals(buyMinOut, 18)}`);
    const sellAmount = (quotedOut * BigInt(SELL_OF_QUOTE_BPS)) / 10000n;
    const sellAmounts = await router.getAmountsOut(sellAmount, [agnaAddr, cfg.baseToken]);
    const sellQuoted = sellAmounts[sellAmounts.length - 1];
    const sellMinOut = applySlippage(sellQuoted, SELL_SLIPPAGE_BPS);
    log(`[smoke:${chainKey}] sell ${formatDecimals(sellAmount, 18)} AGNA (${SELL_OF_QUOTE_BPS / 100}% of quoted buy) -> quoted ${formatDecimals(sellQuoted, cfg.baseDecimals ?? 18)} ${cfg.baseSymbol}, minOut ${formatDecimals(sellMinOut, cfg.baseDecimals ?? 18)}`);
    log(`[smoke:${chainKey}] est. burn/round-trip ~${formatDecimals((quotedOut * 386n) / 10000n, 18)} AGNA (buy tax 2% + sell tax ~1.86% of quote)`);
    const gasPrice = await fetchGasPrice(provider, cfg);
    log(`[smoke:${chainKey}] gasPrice ${ethers.formatUnits(gasPrice, 'gwei')} gwei (live, floored, +10%)`);
    log(`[smoke:${chainKey}] OK — no transactions sent`);
    return { chain: chainKey, smoke: true, quotedOut: quotedOut.toString(), sellAmount: sellAmount.toString() };
  }

  // ---- live run ----
  const lock = acquireLock(chainKey);
  if (!lock) { log(`[${chainKey}] another instance holds the lock — exiting`); return { chain: chainKey, skipped: true }; }
  const state = loadState();
  const cs = chainState(state, chainKey);
  DIRTY_CHAINS.add(chainKey);
  try {
    if (cs.status === 'stopped') { log(`[${chainKey}] previously stopped: ${cs.stopReason} — not auto-resuming a stopped chain`); return { chain: chainKey, stopped: true, reason: cs.stopReason }; }

    // Batch logic: --rounds N applies ONLY when starting a new batch.
    // A stored batchTarget is resumed as-is, so a resume/hourly run
    // never inflates an in-flight batch.
    const batchInFlight = cs.batchTarget != null && cs.roundsDone < cs.batchTarget;
    if (resumeOnly && !batchInFlight) { log(`[${chainKey}] --resume-only and no batch in flight — nothing to do`); return { chain: chainKey, skipped: true }; }
    if (!batchInFlight) {
      cs.batchStart = cs.roundsDone;
      cs.batchTarget = cs.roundsDone + rounds;
      cs.status = 'running';
      saveState(state);
      log(`[${chainKey}] new batch: ${rounds} rounds (cumulative ${cs.batchStart} -> ${cs.batchTarget})`);
    } else {
      cs.status = 'running';
      saveState(state);
      log(`[${chainKey}] resuming batch: ${cs.roundsDone - cs.batchStart}/${cs.batchTarget - cs.batchStart} rounds done (cumulative target ${cs.batchTarget})`);
    }

    // Baseline + approves (once).
    if (!cs.baseline) {
      cs.baseline = await readBaseline(provider, cfg);
      cs.nextNonce = cs.baseline.startNonce;
      saveState(state);
      log(`[${chainKey}] baseline nonce=${cs.baseline.startNonce} native=${ethers.formatEther(cs.baseline.nativeBalance)} AGNA=${formatDecimals(BigInt(cs.baseline.agnaBalance), 18)} supply=${formatDecimals(BigInt(cs.baseline.agnaTotalSupply), 18)}`);
    }
    if (!cs.approvesDone) {
      const needAgna = (await agnaC.allowance(BURNER, cfg.router)) < ethers.MaxUint256 / 2n;
      const needBase = cfg.buyWithERC20 && (await baseC.allowance(BURNER, cfg.router)) < ethers.MaxUint256 / 2n;
      const gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${chainKey} gas price`);
      if (needAgna) {
        const tx = await agnaC.approve.populateTransaction(cfg.router, ethers.MaxUint256);
        const sent = await sendWithRetry(wallet, { ...tx, gasPrice, nonce: cs.nextNonce }, `${chainKey} approve AGNA`);
        log(`[${chainKey}] approve AGNA sent ${sent.hash} nonce=${cs.nextNonce}`);
        const rc = await sent.wait();
        if (rc.status !== 1) throw new Error('AGNA approve reverted');
        cs.approveHashes.push(sent.hash);
        cs.hashes.push(sent.hash);
        cs.nextNonce += 1;
      }
      if (needBase) {
        const tx = await baseC.approve.populateTransaction(cfg.router, ethers.MaxUint256);
        const sent = await sendWithRetry(wallet, { ...tx, gasPrice, nonce: cs.nextNonce }, `${chainKey} approve base`);
        log(`[${chainKey}] approve base sent ${sent.hash} nonce=${cs.nextNonce}`);
        const rc = await sent.wait();
        if (rc.status !== 1) throw new Error('base approve reverted');
        cs.approveHashes.push(sent.hash);
        cs.hashes.push(sent.hash);
        cs.nextNonce += 1;
      }
      cs.approvesDone = true;
      cs.txnsSubmitted = cs.tradeHashes.length;
      cs.status = 'running';
      saveState(state);
      log(`[${chainKey}] approves done, nextNonce=${cs.nextNonce}`);
    }

    // Resume: fill any nonce gaps left by an interrupted run.
    {
      const pendingNonce = await provider.getTransactionCount(BURNER, 'pending');
      if (pendingNonce < cs.nextNonce) {
        log(`[${chainKey}] gap detected: node pending nonce=${pendingNonce}, checkpoint nextNonce=${cs.nextNonce} — filling ${cs.nextNonce - pendingNonce} nonce(s)`);
        const gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${chainKey} gas price`);
        for (let n = pendingNonce; n < cs.nextNonce; n++) {
          const sent = await sendWithRetry(wallet, { to: BURNER, value: 0n, gasLimit: 21000n, gasPrice, nonce: n }, `${chainKey} gap-fill nonce ${n}`);
          await sent.wait();
          cs.fillers.push({ nonce: n, hash: sent.hash });
          cs.hashes.push(sent.hash);
          log(`[${chainKey}] gap-fill nonce=${n} hash=${sent.hash}`);
        }
        cs.txnsSubmitted = cs.tradeHashes.length;
        cs.status = 'running';
        saveState(state);
      }
    }

    // Gas limits: estimate once from the first round's txs, reuse after.
    let buyGasLimit = null;
    let sellGasLimit = null;
    let gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${chainKey} gas price`);

    const checkBrakes = async () => {
      const bal = await withRetry(() => provider.getBalance(BURNER), `${chainKey} gas balance`);
      if (bal < GAS_BRAKE[chainKey]) {
        throw new Error(`BRAKE: gas balance ${ethers.formatEther(bal)} under floor ${ethers.formatEther(GAS_BRAKE[chainKey])}`);
      }
      const [r0, r1] = await withRetry(() => pairC.getReserves(), `${chainKey} reserves`);
      const b0 = BigInt(cs.baseline.reserve0);
      const b1 = BigInt(cs.baseline.reserve1);
      const move0 = Number((r0 > b0 ? (r0 - b0) * 10000n / b0 : (b0 - r0) * 10000n / b0)) / 100;
      const move1 = Number((r1 > b1 ? (r1 - b1) * 10000n / b1 : (b1 - r1) * 10000n / b1)) / 100;
      if (move0 > 15 || move1 > 15) {
        throw new Error(`BRAKE: pool reserves moved >15% from baseline (r0 ${move0.toFixed(1)}%, r1 ${move1.toFixed(1)}%)`);
      }
    };

    while (cs.roundsDone < cs.batchTarget) {
      if (cs.roundsDone % CHECKPOINT_EVERY === 0) {
        await checkBrakes();
        gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${chainKey} gas price`);
      }
      heartbeatLock(chainKey);
      const round = cs.roundsDone;

      // Quote buy (fresh reserves every round).
      const amounts = await withRetry(() => router.getAmountsOut(amountIn, [cfg.baseToken, agnaAddr]), `${chainKey} buy quote`);
      const quotedOut = amounts[amounts.length - 1];
      const buyMinOut = applySlippage(quotedOut, BUY_SLIPPAGE_BPS);
      const sellAmount = (quotedOut * BigInt(SELL_OF_QUOTE_BPS)) / 10000n;
      const sellAmounts = await withRetry(() => router.getAmountsOut(sellAmount, [agnaAddr, cfg.baseToken]), `${chainKey} sell quote`);
      const sellQuoted = sellAmounts[sellAmounts.length - 1];
      const sellMinOut = applySlippage(sellQuoted, SELL_SLIPPAGE_BPS);

      // Build buy + sell txs.
      let buyTx;
      let sellTx;
      if (cfg.buyWithERC20) {
        buyTx = await router.swapExactTokensForTokens.populateTransaction(amountIn, buyMinOut, [cfg.baseToken, agnaAddr], BURNER, deadline());
        sellTx = await router.swapExactTokensForTokens.populateTransaction(sellAmount, sellMinOut, [agnaAddr, cfg.baseToken], BURNER, deadline());
      } else {
        buyTx = await router.swapExactETHForTokens.populateTransaction(buyMinOut, [cfg.baseToken, agnaAddr], BURNER, deadline(), { value: amountIn });
        sellTx = await router.swapExactTokensForETH.populateTransaction(sellAmount, sellMinOut, [agnaAddr, cfg.baseToken], BURNER, deadline());
      }
      if (buyGasLimit === null) {
        try { buyGasLimit = (await withRetry(() => provider.estimateGas({ ...buyTx, from: BURNER }), `${chainKey} buy gas estimate`)) * 120n / 100n; } catch { buyGasLimit = cfg.chainKey === 'sepolia' ? 460000n : 220000n; }
        try { sellGasLimit = (await withRetry(() => provider.estimateGas({ ...sellTx, from: BURNER }), `${chainKey} sell gas estimate`)) * 120n / 100n; } catch { sellGasLimit = cfg.chainKey === 'sepolia' ? 460000n : 220000n; }
        log(`[${chainKey}] gas limits buy=${buyGasLimit} sell=${sellGasLimit}`);
      }

      const nonceBuy = cs.nextNonce;
      const nonceSell = cs.nextNonce + 1;
      const buySent = await sendWithRetry(wallet, { ...buyTx, gasPrice, gasLimit: buyGasLimit, nonce: nonceBuy }, `${chainKey} buy round ${round}`);
      // --send-delay-ms: pause between sends so a load-balanced RPC's
      // backends can gossip each txn before the next is sent. Without
      // it, rapid sends scatter across backends, fragment the nonce
      // sequence, and txns get dropped (Sepolia lost ~189 this way).
      if (sendDelayMs > 0) await sleep(sendDelayMs);
      const sellSent = await sendWithRetry(wallet, { ...sellTx, gasPrice, gasLimit: sellGasLimit, nonce: nonceSell }, `${chainKey} sell round ${round}`);
      if (sendDelayMs > 0) await sleep(sendDelayMs);
      cs.hashes.push(buySent.hash, sellSent.hash);
      cs.tradeHashes.push(buySent.hash, sellSent.hash);
      if (!cs.firstBuyHash) cs.firstBuyHash = buySent.hash;
      if (!cs.firstSellHash) cs.firstSellHash = sellSent.hash;
      cs.lastBuyHash = buySent.hash;
      cs.lastSellHash = sellSent.hash;
      cs.nextNonce += 2;
      cs.txnsSubmitted = cs.tradeHashes.length;
      cs.roundsDone += 1;
      if (cs.roundsDone % CHECKPOINT_EVERY === 0 || cs.roundsDone === cs.batchTarget) {
        cs.updatedAt = new Date().toISOString();
        cs.errorCount = 0; // healthy progress — transient errors don't accumulate
        saveState(state);
        log(`[${chainKey}] batch ${cs.roundsDone - cs.batchStart}/${cs.batchTarget - cs.batchStart} (cumulative ${cs.roundsDone}), txns=${cs.txnsSubmitted}, nextNonce=${cs.nextNonce}`);
      }
    }

    // Final receipt poll for this batch.
    log(`[${chainKey}] batch of ${cs.batchTarget - cs.batchStart} rounds submitted — polling receipts...`);
    const { results, unmined } = await pollReceipts(provider, cs.hashes, { timeoutMs: 900000 });
    let ok = 0;
    let failed = 0;
    let gasSpent = 0n;
    const tradeHashes = cs.tradeHashes || cs.hashes.slice(cs.approveHashes.length + cs.fillers.length);
    for (const h of tradeHashes) {
      const r = results.get(h);
      if (!r) continue;
      if (r.status === 1) ok += 1; else { failed += 1; cs.failures.push({ hash: h, status: r.status }); }
      gasSpent += r.gasUsed * r.gasPrice;
    }
    cs.gasSpentWei = gasSpent.toString();
    cs.status = unmined.length === 0 ? 'done' : 'submitted-unconfirmed';
    cs.updatedAt = new Date().toISOString();
    saveState(state);
    log(`[${chainKey}] receipts: ${ok} ok, ${failed} failed, ${unmined.length} unmined. gasSpent=${ethers.formatEther(gasSpent)} ${cfg.nativeSymbol}`);
    return { chain: chainKey, done: cs.status === 'done', rounds: cs.roundsDone, ok, failed, unmined: unmined.length };
  } catch (e) {
    const state2 = loadState();
    const cs2 = chainState(state2, chainKey);
    DIRTY_CHAINS.add(chainKey);
    const msg = e.message || String(e);
    if (msg.startsWith('BRAKE:')) {
      // Deliberate safety stop — terminal, never auto-resumed.
      cs2.status = 'stopped';
      cs2.stopReason = msg;
    } else {
      // Transient error (RPC drop, socket hang up, ...) — leave the
      // batch resumable; only stop after 5 consecutive failed runs.
      cs2.errorCount = (cs2.errorCount || 0) + 1;
      cs2.lastError = msg;
      if (cs2.errorCount >= 5) {
        cs2.status = 'stopped';
        cs2.stopReason = `repeated errors (${cs2.errorCount}x, last: ${msg})`;
      } else {
        cs2.status = 'running';
        cs2.stopReason = null;
      }
    }
    cs2.updatedAt = new Date().toISOString();
    saveState(state2);
    log(`[${chainKey}] ${cs2.status === 'stopped' ? 'STOPPED' : 'ERROR (will resume)'}: ${msg}`);
    return { chain: chainKey, stopped: cs2.status === 'stopped', reason: msg };
  } finally {
    releaseLock(chainKey);
  }
}

async function verifyChain(provider, cfg, chainKey) {
  const state = loadState();
  const cs = state.chains[chainKey];
  if (!cs || !cs.baseline) { log(`[${chainKey}] no checkpoint/baseline — nothing to verify`); return { chain: chainKey, verified: false }; }
  const { results, unmined } = await pollReceipts(provider, cs.hashes, { timeoutMs: 600000 });
  let ok = 0;
  let failed = 0;
  let gasSpent = 0n;
  const tradeHashes = cs.tradeHashes || cs.hashes.slice(cs.approveHashes.length + cs.fillers.length);
  for (const h of tradeHashes) {
    const r = results.get(h);
    if (!r) continue;
    if (r.status === 1) ok += 1; else failed += 1;
    gasSpent += r.gasUsed * r.gasPrice;
  }
  const endNonce = await provider.getTransactionCount(BURNER, 'latest');
  const agnaC = tokenContractFull(AGNA[chainKey], provider);
  const pairC = pairContract(PAIRS[chainKey], provider);
  const [finalSupply, finalAgnaBal, finalNative, reserves] = await Promise.all([
    agnaC.totalSupply(), agnaC.balanceOf(BURNER), provider.getBalance(BURNER), pairC.getReserves(),
  ]);
  const burned = BigInt(cs.baseline.agnaTotalSupply) - finalSupply;
  const summary = {
    chain: chainKey,
    roundsDone: cs.roundsDone,
    tradingTxnsSubmitted: cs.txnsSubmitted,
    approves: cs.approveHashes.length,
    fillers: cs.fillers.length,
    receiptsOk: ok,
    receiptsFailed: failed,
    unmined: unmined.length,
    startNonce: cs.baseline.startNonce,
    endNonce,
    nonceDelta: endNonce - cs.baseline.startNonce,
    gasSpent: ethers.formatEther(gasSpent),
    gasSymbol: cfg.nativeSymbol,
    agnaBurned: formatDecimals(burned, 18),
    agnaBurnedPctOfSupply: (Number(burned) / Number(BigInt(cs.baseline.agnaTotalSupply)) * 100).toFixed(2),
    finalAgnaBalance: formatDecimals(finalAgnaBal, 18),
    finalNativeBalance: ethers.formatEther(finalNative),
    finalReserve0: reserves[0].toString(),
    finalReserve1: reserves[1].toString(),
    baselineReserve0: cs.baseline.reserve0,
    baselineReserve1: cs.baseline.reserve1,
    firstBuyHash: cs.firstBuyHash,
    firstSellHash: cs.firstSellHash,
    lastBuyHash: cs.lastBuyHash,
    lastSellHash: cs.lastSellHash,
    status: cs.status,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const chains = args.chain === 'all'
    ? ['sepolia', 'arc-testnet', 'robinhood-testnet', 'litvm-testnet']
    : [args.chain];
  const results = [];
  for (const c of chains) {
    if (!AGNA[c]) throw new Error(`Unknown chain ${c}`);
    results.push(await runChain(c, { smoke: args.smoke, verifyOnly: args.verify, rounds: args.rounds, resumeOnly: args.resumeOnly, sendDelayMs: args.sendDelayMs }));
  }
  console.log(JSON.stringify({ results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
