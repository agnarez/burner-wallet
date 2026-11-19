'use strict';

/**
 * AGNA sniper volume runner — fixed-size buy/sell round trips ("spam sniper")
 * on our own AGNAmuse V2 DEX: 500 round trips = 1,000 trading txns per chain,
 * 4,000 total across Sepolia, Arc Testnet, Robinhood Chain testnet, LitVM testnet.
 *
 * V2 (2026-11-19): multi-token. Each chain trades the pair in pairs-v2.json —
 * the wrapped-native pair where one exists (Sepolia: Uniswap V2 WETH/USDC),
 * otherwise the AGNA pair (Arc/RH/LitVM factories hold only the AGNA pair).
 * Two gates run before/around every trade (see src/gates.js):
 *   - GAS BUDGET: live gas price vs a per-chain ceiling, estimated round-trip
 *     cost vs a per-round cap, and a running daily spend accumulator. A hit
 *     stops the batch RESUMABLY (the 5-min resume cron retries it; the
 *     accumulator resets each calendar day).
 *   - SELL-VERIFY (honeypot gate): static pre-checks + a live micro-test
 *     (buy dust, immediately sell it all; only graduate if the sell
 *     succeeds and returns >=90%) for every new pair; a sell-quote check
 *     before EVERY sell; a per-round return threshold (AGNA 80% — the 5%
 *     tax makes its normal return ~88%; other pairs 90%). A failed token
 *     goes to token-blacklist.json and the chain falls back to AGNA.
 *
 * Trade sizes (fixed per round trip; <~0.5% price impact per trade and
 * total AGNA burned < ~5% of the 404T supply):
 *   sepolia            0.00005  ETH
 *   arc-testnet        0.01     USDC (ERC-20 path, 6 decimals)
 *   robinhood-testnet  0.000005 ETH (thinnest pool — do NOT raise)
 *   litvm-testnet      0.00005  zkLTC
 *   base-sepolia       0.00005  ETH (same pool depth as LitVM)
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
  'base-sepolia': '0xa69000FF81232ac079eC2265fD4da3100F243fc3',
};
const PAIRS = {
  sepolia: '0x43E54E53dafe9467725be66Aa34d799d0Ff6F630',
  'arc-testnet': '0xba3746f46Fbfe22E4E17083F1769b359A0b8956a',
  'robinhood-testnet': '0x699d97ACc97bB067842Bbe8CE89dC52d805D0a22',
  'litvm-testnet': '0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9',
  'base-sepolia': '0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9',
};
const TRADE_SIZE = {
  sepolia: '0.00005',
  'arc-testnet': '0.01',
  'robinhood-testnet': '0.000005',
  'litvm-testnet': '0.00005',
  'base-sepolia': '0.00005',
};
const GAS_FLOOR_GWEI = {
  // Sepolia was 17 wei (0.000000017 gwei). On 2026-11-19 that left ~72 txns
  // stuck unmined in a mempool (base fee ~16 wei; a 17-wei legacy txn is
  // barely includable and gets evicted/deprioritised). Raised to 0.01 gwei
  // (~600,000x the base fee). Then raised again to 0.02 gwei: the
  // resend must REPLACE old 0.011-gwei txns still sitting in some
  // backends' mempools, and a replacement needs >=10% higher gas
  // price — 0.022 gwei (0.02 floor x1.1) is 2x the old price, so it
  // replaces cleanly. Cost for the remaining ~174 txns is ~0.0006 ETH.
  sepolia: '0.02',
  'arc-testnet': '31.625',
  'robinhood-testnet': '0.01',
  'litvm-testnet': '0.01',
  // Base Sepolia live gas is ~0.006 gwei (micro-test 2026-11-20 paid
  // exactly 0.006). Floor 0.001 gwei = ~10x the typical base fee here,
  // so inclusion is safe; the 1.1x bump on live gas dominates anyway.
  // A 0.01 floor would force 0.011 gwei/txn and nearly halve the
  // ~11-day runway for no inclusion benefit.
  'base-sepolia': '0.001',
};
// Stop the chain if the burner's gas balance falls under these.
const GAS_BRAKE = {
  sepolia: ethers.parseEther('0.005'),
  'arc-testnet': ethers.parseUnits('5', 18),
  'robinhood-testnet': ethers.parseEther('0.001'),
  'litvm-testnet': ethers.parseEther('0.005'),
  'base-sepolia': ethers.parseEther('0.001'),
};
const SELL_OF_QUOTE_BPS = 9300; // sell 93% of quoted buy output
const BUY_SLIPPAGE_BPS = 500; // buy minOut = 95% of quote
const SELL_SLIPPAGE_BPS = 1000; // sell minOut = 90% of sell quote
const DEADLINE_SECONDS = 60 * 20;
const MAX_GAS_GWEI = 100;

// ---- Sniper v2: pair map, gas budget, blacklist, gates ----
// pairs-v2.json is the source of truth for which pair each chain trades.
// AGNA entries are the pre-verified fallback (live-traded 2026-11-19).
const PAIRS_V2_FILE = path.join(__dirname, 'pairs-v2.json');
const BLACKLIST_FILE = path.join(__dirname, 'token-blacklist.json');
function loadPairsV2() {
  try { return JSON.parse(fs.readFileSync(PAIRS_V2_FILE, 'utf8')); } catch { return { version: 1, chains: {} }; }
}
function savePairsV2(doc) {
  fs.writeFileSync(PAIRS_V2_FILE, JSON.stringify(doc, null, 2));
}
// Effective trade config for a chain: the pairs-v2 entry, or the AGNA
// fallback if the file is missing / the pair is unverified / blacklisted.
function tradeCfgFor(chainKey) {
  const doc = loadPairsV2();
  const entry = doc.chains && doc.chains[chainKey];
  const black = loadBlacklist();
  if (entry && entry.verified && !black.tokens.includes(entry.token.toLowerCase())) {
    return { ...entry, source: 'pairs-v2' };
  }
  return {
    token: AGNA[chainKey], tokenSymbol: 'AGNA', tokenDecimals: 18,
    pair: PAIRS[chainKey], pairName: 'AGNA pair (fallback)',
    sellOfQuoteBps: SELL_OF_QUOTE_BPS, minReturnBps: 8000,
    tradeSize: TRADE_SIZE[chainKey], buyWithERC20: chainKey === 'arc-testnet',
    verified: true, microTested: true, source: 'agna-fallback',
  };
}
function loadBlacklist() {
  try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')); } catch { return { version: 1, tokens: [] }; }
}
function blacklistToken(tokenAddr, reason) {
  const bl = loadBlacklist();
  const t = tokenAddr.toLowerCase();
  if (!bl.tokens.includes(t)) {
    bl.tokens.push(t);
    bl[t] = { reason, at: new Date().toISOString() };
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(bl, null, 2));
    log(`[blacklist] ${tokenAddr} blacklisted: ${reason}`);
  }
  return bl;
}
// Gas budget per chain (native units; Arc's "native" is USDC).
// Daily budget / per-round cap / live-gas ceiling. Defaults come from the
// measured 2026-11-19 run (Sepolia 0.0018 ETH/day, Arc 4.22 USDC/day,
// RH 0.001145 ETH/day, LitVM 0.001153 zkLTC/day for 500 rounds).
const GAS_BUDGET = {
  sepolia: { daily: '0.002', perRound: '0.000005', ceilingGwei: '0.1' },
  'arc-testnet': { daily: '5', perRound: '0.01', ceilingGwei: '100' },
  'robinhood-testnet': { daily: '0.0015', perRound: '0.000005', ceilingGwei: '0.1' },
  'litvm-testnet': { daily: '0.0015', perRound: '0.000005', ceilingGwei: '0.1' },
  // Base Sepolia (added 2026-11-20, 5th chain). Caps from MEASURED data:
  // micro-test receipts 2026-11-20: 262,070 gas/round @ 0.006 gwei =
  // 0.00000157 ETH/round true cost. Per-round cap 0.000005 = ~3.2x true
  // cost — headroom for estimateGas overstating ~1.5x (est ~390k gas x
  // 0.0066 gwei floored = ~0.0000026) and live gas up to ~0.013 gwei.
  // Daily 0.002 = 500 rounds x 0.000004; true daily at live gas
  // ~0.00087 ETH. NEVER set perRound below measured true cost — that
  // exact mistake paused Sepolia (cap 0.000005 vs true 0.0000068).
  'base-sepolia': { daily: '0.002', perRound: '0.000005', ceilingGwei: '0.1' },
};
// Measured per-round gas (total, both swaps) — sampled from REAL
// receipts of the 2026-11-19 run (8-txn sample: 133,890–158,706 gas
// per swap, avg 142,682). Used as the cost-estimate fallback when
// estimateGas is unavailable. The old Sepolia figure (143k) was derived
// from the day's blended ETH total, which mixed 17-wei early txns with
// 0.022-gwei later ones — at the current 0.022 gwei floor the true cost
// is ~285k gas/round (~0.0000063 ETH). Arc/RH/LitVM figures are the
// same derivation and are approximate (their gas prices were
// floor-dominated all day, so they are closer to true).
const MEASURED_ROUND_GAS = { sepolia: 285000n, 'arc-testnet': 266000n, 'robinhood-testnet': 229000n, 'litvm-testnet': 230000n, 'base-sepolia': 262000n };
function todayKey() { return new Date().toISOString().slice(0, 10); }
function budgetState(cs) {
  if (!cs.gasBudget || cs.gasBudget.date !== todayKey()) cs.gasBudget = { date: todayKey(), spentWei: '0' };
  return cs.gasBudget;
}

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
  if (!args.chain) throw new Error('Usage: node volume.cjs --chain <sepolia|arc-testnet|robinhood-testnet|litvm-testnet|base-sepolia|all> [--rounds N] [--resume-only] [--send-delay-ms N] [--smoke|--verify]');
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

async function readBaseline(provider, cfg, trade) {
  const token = tokenContractFull(trade.token, provider);
  const pair = pairContract(trade.pair, provider);
  const [nonce, bal, tokenBal, supply, reserves] = await Promise.all([
    provider.getTransactionCount(BURNER, 'pending'),
    provider.getBalance(BURNER),
    token.balanceOf(BURNER),
    token.totalSupply(),
    pair.getReserves(),
  ]);
  return {
    startNonce: nonce,
    nativeBalance: bal.toString(),
    tokenAddress: trade.token,
    tokenSymbol: trade.tokenSymbol,
    tokenBalance: tokenBal.toString(),
    tokenTotalSupply: supply.toString(),
    pairAddress: trade.pair,
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
      // "already submitted" errors: the txn is already in the mempool
      // (usually because the first send succeeded but its response was
      // lost, so this retry re-sends the same nonce). Retrying is futile
      // — fail fast instead of burning 3 attempts. The txn itself is
      // fine; the receipt poll / checkpoint rebuild will confirm it.
      if (msg.includes('already known') || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced') || msg.includes('replacement fee too low')) {
        throw new Error(`${label}: ${e.shortMessage || e.message} — stopping chain (nonce conflict)`);
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`${label}: send failed after 3 attempts: ${lastErr.shortMessage || lastErr.message}`);
}

// V2: approve the traded token (and the base token on ERC-20-buy chains)
// for the router. Skips any approval already at max. Awaited, one-time,
// NOT counted in the 1,000 trading txns.
async function approveForTrade({ provider, wallet, cfg, trade, cs, save }) {
  const tokenC = tokenContractFull(trade.token, provider);
  const baseC = tokenContract(cfg.baseToken, provider);
  const needToken = (await tokenC.allowance(BURNER, cfg.router)) < ethers.MaxUint256 / 2n;
  const needBase = cfg.buyWithERC20 && (await baseC.allowance(BURNER, cfg.router)) < ethers.MaxUint256 / 2n;
  const gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${cfg.chainKey} gas price`);
  if (needToken) {
    const tx = await tokenC.approve.populateTransaction(cfg.router, ethers.MaxUint256);
    const sent = await sendWithRetry(wallet, { ...tx, gasPrice, nonce: cs.nextNonce }, `${cfg.chainKey} approve ${trade.tokenSymbol}`);
    log(`[${cfg.chainKey}] approve ${trade.tokenSymbol} sent ${sent.hash} nonce=${cs.nextNonce}`);
    const rc = await sent.wait();
    if (rc.status !== 1) throw new Error(`${trade.tokenSymbol} approve reverted`);
    cs.approveHashes.push(sent.hash);
    cs.hashes.push(sent.hash);
    cs.nextNonce += 1;
  }
  if (needBase) {
    const tx = await baseC.approve.populateTransaction(cfg.router, ethers.MaxUint256);
    const sent = await sendWithRetry(wallet, { ...tx, gasPrice, nonce: cs.nextNonce }, `${cfg.chainKey} approve base`);
    log(`[${cfg.chainKey}] approve base sent ${sent.hash} nonce=${cs.nextNonce}`);
    const rc = await sent.wait();
    if (rc.status !== 1) throw new Error('base approve reverted');
    cs.approveHashes.push(sent.hash);
    cs.hashes.push(sent.hash);
    cs.nextNonce += 1;
  }
  cs.approvesDone = true;
  cs.txnsSubmitted = cs.tradeHashes.length;
  cs.status = 'running';
  save();
  log(`[${cfg.chainKey}] approves done, nextNonce=${cs.nextNonce}`);
}

// V2 SELL-VERIFY micro-test: the only definitive honeypot check is a live
// one — buy a dust amount of the new token, then immediately sell ALL of
// it. Pass requires: buy receipt ok, sell quote > 0, sell receipt ok,
// round-trip return >= 90% of the buy cost, and the token balance back
// to ~0 afterwards. On failure the caller blacklists the token and falls
// back to AGNA. Consumes 2 nonces (tracked in cs like approves).
async function microTestPair({ provider, wallet, router, cfg, trade, cs, save, sendDelayMs = 0 }) {
  const out = { passed: false, retryable: false, reason: '', buyHash: null, sellHash: null, returnBps: null };
  const tokenC = tokenContractFull(trade.token, provider);
  const pairC = pairContract(trade.pair, provider);
  try {
    // (a) Static pre-checks — no gas spent.
    if ((await provider.getCode(trade.token)) === '0x') { out.reason = 'token has no code'; return out; }
    const [sym, dec, supply, reserves] = await Promise.all([
      tokenC.symbol().catch(() => null), tokenC.decimals().catch(() => null),
      tokenC.totalSupply().catch(() => 0n), pairC.getReserves(),
    ]);
    if (sym === null || dec === null) { out.reason = 'token symbol/decimals unreadable'; return out; }
    if (supply === 0n) { out.reason = 'token totalSupply is 0'; return out; }
    if (reserves[0] === 0n || reserves[1] === 0n) { out.reason = 'pair has zero liquidity on one side'; return out; }
    // V2 (2026-11-19 fix): the checkpoint nonce can be stale — a
    // previous run may have sent txns that never reached a checkpoint
    // (see the catch fix). Re-read the live pending nonce and use the
    // freshest one, so the buy cannot collide with an already-mined txn.
    const liveNonce = await provider.getTransactionCount(BURNER, 'pending');
    if (liveNonce > cs.nextNonce) {
      log(`[${cfg.chainKey}] micro-test nonce fast-forward: checkpoint ${cs.nextNonce} -> live ${liveNonce}`);
      cs.nextNonce = liveNonce;
    }
    // (b) Live micro-test: dust buy = 20% of a normal round.
    const dustIn = cfg.buyWithERC20
      ? parseToDecimals(trade.tradeSize, cfg.baseDecimals ?? 18) / 5n
      : ethers.parseEther(trade.tradeSize) / 5n;
    const buyQuote = await router.getAmountsOut(dustIn, [cfg.baseToken, trade.token]);
    const buyOut = buyQuote[buyQuote.length - 1];
    if (buyOut === 0n) { out.reason = 'buy quote is 0'; return out; }
    const buyMinOut = applySlippage(buyOut, BUY_SLIPPAGE_BPS);
    const tokenBalBefore = await tokenC.balanceOf(BURNER);
    const baseBalBefore = await provider.getBalance(BURNER);
    const gasPrice = await withRetry(() => fetchGasPrice(provider, cfg), `${cfg.chainKey} micro-test gas price`);
    let buyTx;
    if (cfg.buyWithERC20) {
      buyTx = await router.swapExactTokensForTokens.populateTransaction(dustIn, buyMinOut, [cfg.baseToken, trade.token], BURNER, deadline());
    } else {
      buyTx = await router.swapExactETHForTokens.populateTransaction(buyMinOut, [cfg.baseToken, trade.token], BURNER, deadline(), { value: dustIn });
    }
    let buyGas;
    try { buyGas = (await provider.estimateGas({ ...buyTx, from: BURNER })) * 120n / 100n; } catch { buyGas = 200000n; }
    const buySent = await sendWithRetry(wallet, { ...buyTx, gasPrice, gasLimit: buyGas, nonce: cs.nextNonce }, `${cfg.chainKey} micro-test buy ${trade.tokenSymbol}`);
    out.buyHash = buySent.hash;
    cs.hashes.push(buySent.hash);
    cs.nextNonce += 1;
    save();
    if (sendDelayMs > 0) await sleep(sendDelayMs);
    const buyRc = await buySent.wait();
    if (buyRc.status !== 1) { out.reason = 'micro-test buy reverted'; return out; }
    out.buyGasUsed = buyRc.gasUsed.toString();
    const tokenBalAfterBuy = await tokenC.balanceOf(BURNER);
    const gained = tokenBalAfterBuy - tokenBalBefore;
    if (gained <= 0n) { out.reason = 'micro-test buy delivered 0 tokens'; return out; }
    // (c) Immediately sell ALL of what the buy delivered.
    let sellQuote;
    try {
      sellQuote = await router.getAmountsOut(gained, [trade.token, cfg.baseToken]);
    } catch (e) { out.reason = `sell quote reverted: ${(e.shortMessage || e.message || '').slice(0, 120)}`; return out; }
    const sellOut = sellQuote[sellQuote.length - 1];
    if (sellOut === 0n) { out.reason = 'sell quote is 0 — token cannot be sold (honeypot signature)'; return out; }
    out.returnBps = Number((sellOut * 10000n) / dustIn);
    if (out.returnBps < 9000) { out.reason = `round-trip return ${out.returnBps} bps < 9000`; return out; }
    const sellMinOut = applySlippage(sellOut, SELL_SLIPPAGE_BPS);
    let sellTx;
    if (cfg.buyWithERC20) {
      sellTx = await router.swapExactTokensForTokens.populateTransaction(gained, sellMinOut, [trade.token, cfg.baseToken], BURNER, deadline());
    } else {
      sellTx = await router.swapExactTokensForETH.populateTransaction(gained, sellMinOut, [trade.token, cfg.baseToken], BURNER, deadline());
    }
    let sellGas;
    try { sellGas = (await provider.estimateGas({ ...sellTx, from: BURNER })) * 120n / 100n; } catch { sellGas = 200000n; }
    const sellSent = await sendWithRetry(wallet, { ...sellTx, gasPrice, gasLimit: sellGas, nonce: cs.nextNonce }, `${cfg.chainKey} micro-test sell ${trade.tokenSymbol}`);
    out.sellHash = sellSent.hash;
    cs.hashes.push(sellSent.hash);
    cs.nextNonce += 1;
    save();
    if (sendDelayMs > 0) await sleep(sendDelayMs);
    const sellRc = await sellSent.wait();
    if (sellRc.status !== 1) { out.reason = 'micro-test sell reverted — token cannot be sold (honeypot signature)'; return out; }
    out.sellGasUsed = sellRc.gasUsed.toString();
    const tokenBalAfterSell = await tokenC.balanceOf(BURNER);
    if (tokenBalAfterSell - tokenBalBefore > gained / 100n) { out.reason = 'micro-test sell left >1% of bought tokens behind'; return out; }
    const baseBalAfter = await provider.getBalance(BURNER);
    const gasSpentMicro = (buyRc.gasUsed * buyRc.gasPrice) + (sellRc.gasUsed * sellRc.gasPrice);
    if (baseBalAfter + gasSpentMicro <= baseBalBefore) { out.reason = 'sell proceeds never arrived in base balance'; return out; }
    out.passed = true;
    out.reason = `buy+sell ok, return ${out.returnBps} bps`;
    return out;
  } catch (e) {
    const msg = (e.shortMessage || e.message || String(e));
    out.reason = msg.slice(0, 200);
    // V2 (2026-11-19 fix): a nonce collision is an infrastructure /
    // stale-checkpoint error, NOT a token failure. Never blacklist on
    // it — the caller retries once after re-syncing, then defers the
    // micro-test and relies on the per-round sell-quote gates.
    if (/nonce|already known|replacement/i.test(msg)) out.retryable = true;
    return out;
  }
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
  // 120s request timeout: ethers has no default timeout, so a stalled RPC
  // connection hangs forever (Sepolia did exactly that on 2026-11-19 via
  // Tenderly — the first send never returned). With a timeout the call
  // throws, and withRetry / sendWithRetry retries it instead of hanging.
  // 120s (not 30s): publicnode's sends are slow but functional, and a
  // 30s timeout fired mid-send, so the retry re-sent the same nonce and
  // failed with "replacement fee too low" — the txn had actually gone
  // through. 120s gives a slow send time to return its hash.
  const req = new ethers.FetchRequest(cfg.rpcUrl);
  req.timeout = 120000;
  const provider = new ethers.JsonRpcProvider(req);
  const wallet = new ethers.Wallet(pk, provider);
  // V2: resolve which pair this chain trades. On resume, the pair stored
  // in the checkpoint wins — never switch pairs mid-batch. Otherwise the
  // pairs-v2.json entry (or the AGNA fallback) decides.
  const state0 = loadState();
  const cs0 = state0.chains[chainKey];
  const batchInFlight0 = !!(cs0 && cs0.batchTarget != null && cs0.roundsDone < cs0.batchTarget);
  let trade = (batchInFlight0 && cs0.tradeToken && cs0.tradePair)
    ? {
        token: cs0.tradeToken, tokenSymbol: cs0.tradeSymbol || 'AGNA',
        tokenDecimals: cs0.tradeDecimals ?? 18, pair: cs0.tradePair,
        pairName: cs0.tradePairName || '', sellOfQuoteBps: cs0.tradeSellBps ?? SELL_OF_QUOTE_BPS,
        minReturnBps: cs0.tradeMinReturnBps ?? 8000,
        tradeSize: cs0.tradeSize || TRADE_SIZE[chainKey],
        // V2: on resume, the micro-test counts as passed ONLY if the
        // checkpoint records a passed micro-test for this pair. A batch
        // that died before the micro-test ran must re-run it.
        // EXCEPT the AGNA pair: it is pre-verified by live trading and
        // must never be micro-tested — a failed micro-test record for
        // AGNA can only be a nonce/infra error (2026-11-19), never a
        // sell-ability signal, and re-testing it every resume would
        // spam dust trades.
        verified: true,
        microTested: (cs0.tradeToken && cs0.tradeToken.toLowerCase() === AGNA[chainKey].toLowerCase())
          ? true
          : !!(cs0.microTest && cs0.microTest.passed) || !!cs0.microTestDeferredAt,
        source: 'batch-resume',
      }
    : tradeCfgFor(chainKey);
  let tokenAddr = trade.token;
  let pairAddr = trade.pair;
  const router = routerContract(cfg.router, provider);
  let pairC = pairContract(pairAddr, provider);
  let amountIn = cfg.buyWithERC20
    ? parseToDecimals(trade.tradeSize, cfg.baseDecimals ?? 18)
    : ethers.parseEther(trade.tradeSize);
  // V2: actual per-leg gas from a passed micro-test (ground truth for
  // the budget gate — estimateGas overstates this pair, see below).
  let measuredEst = null;

  if (verifyOnly) return verifyChain(provider, cfg, chainKey);

  // ---- smoke: quote + build one round trip, send nothing ----
  if (smoke) {
    const base = await readBaseline(provider, cfg, trade);
    log(`[smoke:${chainKey}] pair ${trade.pairName || trade.pair} token=${trade.tokenSymbol} (${trade.token})`);
    log(`[smoke:${chainKey}] nonce=${base.startNonce} native=${ethers.formatEther(base.nativeBalance)} ${trade.tokenSymbol}=${formatDecimals(BigInt(base.tokenBalance), trade.tokenDecimals)} supply=${formatDecimals(BigInt(base.tokenTotalSupply), trade.tokenDecimals)}`);
    log(`[smoke:${chainKey}] reserves r0=${base.reserve0} r1=${base.reserve1}`);
    const amounts = await router.getAmountsOut(amountIn, [cfg.baseToken, tokenAddr]);
    const quotedOut = amounts[amounts.length - 1];
    const buyMinOut = applySlippage(quotedOut, BUY_SLIPPAGE_BPS);
    log(`[smoke:${chainKey}] buy ${trade.tradeSize} ${cfg.nativeSymbol} -> quoted ${formatDecimals(quotedOut, trade.tokenDecimals)} ${trade.tokenSymbol}, minOut ${formatDecimals(buyMinOut, trade.tokenDecimals)}`);
    const sellAmount = (quotedOut * BigInt(trade.sellOfQuoteBps)) / 10000n;
    const sellAmounts = await router.getAmountsOut(sellAmount, [tokenAddr, cfg.baseToken]);
    const sellQuoted = sellAmounts[sellAmounts.length - 1];
    const sellMinOut = applySlippage(sellQuoted, SELL_SLIPPAGE_BPS);
    const returnBps = amountIn > 0n ? Number((sellQuoted * 10000n) / amountIn) : 0;
    log(`[smoke:${chainKey}] sell ${formatDecimals(sellAmount, trade.tokenDecimals)} ${trade.tokenSymbol} (${trade.sellOfQuoteBps / 100}% of quoted buy) -> quoted ${formatDecimals(sellQuoted, cfg.baseDecimals ?? 18)} ${cfg.baseSymbol}, minOut ${formatDecimals(sellMinOut, cfg.baseDecimals ?? 18)}`);
    log(`[smoke:${chainKey}] round-trip return ${returnBps} bps (min ${trade.minReturnBps})`);
    const gasPrice = await fetchGasPrice(provider, cfg);
    log(`[smoke:${chainKey}] gasPrice ${ethers.formatUnits(gasPrice, 'gwei')} gwei (live, floored, +10%)`);
    log(`[smoke:${chainKey}] OK — no transactions sent`);
    return { chain: chainKey, smoke: true, pair: trade.pair, token: trade.token, quotedOut: quotedOut.toString(), sellAmount: sellAmount.toString(), returnBps };
  }

  // ---- live run ----
  const lock = acquireLock(chainKey);
  if (!lock) { log(`[${chainKey}] another instance holds the lock — exiting`); return { chain: chainKey, skipped: true }; }
  const state = loadState();
  const cs = chainState(state, chainKey);
  DIRTY_CHAINS.add(chainKey);
  const save = () => saveState(state);
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
      // V2: pin the pair for this batch (a resume keeps the same pair).
      cs.tradeToken = trade.token;
      cs.tradeSymbol = trade.tokenSymbol;
      cs.tradeDecimals = trade.tokenDecimals;
      cs.tradePair = trade.pair;
      cs.tradePairName = trade.pairName || '';
      cs.tradeSellBps = trade.sellOfQuoteBps;
      cs.tradeMinReturnBps = trade.minReturnBps;
      cs.tradeSize = trade.tradeSize;
      saveState(state);
      log(`[${chainKey}] new batch: ${rounds} rounds (cumulative ${cs.batchStart} -> ${cs.batchTarget}) pair=${trade.pairName || trade.pair} token=${trade.tokenSymbol}`);
    } else {
      cs.status = 'running';
      saveState(state);
      log(`[${chainKey}] resuming batch: ${cs.roundsDone - cs.batchStart}/${cs.batchTarget - cs.batchStart} rounds done (cumulative target ${cs.batchTarget}) pair=${cs.tradePairName || cs.tradePair || trade.pair}`);
    }

    // V2: a new batch always refreshes the baseline for the CURRENT pair
    // and re-syncs the nonce to the live pending nonce — external txns
    // (e.g. Florin trove/faucet calls) may have consumed nonces since
    // the last batch, and reserves/token balances move between batches.
    if (!batchInFlight) {
      cs.baseline = await readBaseline(provider, cfg, trade);
      cs.nextNonce = cs.baseline.startNonce;
      cs.approvesDone = false;
      cs.gasBudget = { date: todayKey(), spentWei: '0' };
      saveState(state);
      log(`[${chainKey}] baseline (new batch) nonce=${cs.baseline.startNonce} native=${ethers.formatEther(cs.baseline.nativeBalance)} ${trade.tokenSymbol}=${formatDecimals(BigInt(cs.baseline.tokenBalance), trade.tokenDecimals)} supply=${formatDecimals(BigInt(cs.baseline.tokenTotalSupply), trade.tokenDecimals)}`);
    } else if (!cs.baseline) {
      cs.baseline = await readBaseline(provider, cfg, trade);
      cs.nextNonce = cs.baseline.startNonce;
      saveState(state);
      log(`[${chainKey}] baseline nonce=${cs.baseline.startNonce} native=${ethers.formatEther(cs.baseline.nativeBalance)} ${trade.tokenSymbol}=${formatDecimals(BigInt(cs.baseline.tokenBalance), trade.tokenDecimals)}`);
    }
    if (!cs.approvesDone) {
      await approveForTrade({ provider, wallet, cfg, trade, cs, save });
    }

    // V2: on resume, recover the micro-test's actual gas for the gate.
    if (!measuredEst && cs.microTest && cs.microTest.passed && cs.microTest.buyGasUsed && cs.microTest.sellGasUsed) {
      measuredEst = { buy: BigInt(cs.microTest.buyGasUsed), sell: BigInt(cs.microTest.sellGasUsed) };
    }

    // V2: live micro-test for a new pair (AGNA pairs are pre-verified).
    // On a REAL failure (sell reverted / quote 0 / return < 90%):
    // blacklist the token, fall back to AGNA, re-setup. On a RETRYABLE
    // failure (nonce collision — infra, not the token): retry once
    // after re-syncing, then DEFER without blacklisting — sell-ability
    // was never tested, and the per-round sell-quote gates still guard
    // every round. The deferral is recorded so a resume does not
    // re-test in a loop; the next NEW batch re-tests the pair.
    if (!trade.microTested) {
      let mt = await microTestPair({ provider, wallet, router, cfg, trade, cs, save, sendDelayMs });
      if (!mt.passed && mt.retryable) {
        log(`[${chainKey}] micro-test hit a nonce collision (retryable, not a token failure) — re-syncing nonce and retrying once`);
        cs.nextNonce = await provider.getTransactionCount(BURNER, 'pending');
        saveState(state);
        mt = await microTestPair({ provider, wallet, router, cfg, trade, cs, save, sendDelayMs });
      }
      cs.microTest = { pair: trade.pair, token: trade.token, ...mt, at: new Date().toISOString() };
      saveState(state);
      if (!mt.passed) {
        if (mt.retryable) {
          cs.microTestDeferredAt = new Date().toISOString();
          saveState(state);
          log(`[${chainKey}] MICRO-TEST DEFERRED for ${trade.tokenSymbol}: ${mt.reason} — proceeding without blacklist; per-round sell gates remain active`);
        } else {
        log(`[${chainKey}] MICRO-TEST FAILED for ${trade.tokenSymbol} (${trade.token}): ${mt.reason} — blacklisting, falling back to AGNA`);
        blacklistToken(trade.token, `micro-test failed: ${mt.reason}`);
        trade = tradeCfgFor(chainKey); // AGNA fallback now
        tokenAddr = trade.token;
        pairAddr = trade.pair;
        pairC = pairContract(pairAddr, provider);
        amountIn = cfg.buyWithERC20
          ? parseToDecimals(trade.tradeSize, cfg.baseDecimals ?? 18)
          : ethers.parseEther(trade.tradeSize);
        cs.tradeToken = trade.token;
        cs.tradeSymbol = trade.tokenSymbol;
        cs.tradeDecimals = trade.tokenDecimals;
        cs.tradePair = trade.pair;
        cs.tradePairName = trade.pairName || '';
        cs.tradeSellBps = trade.sellOfQuoteBps;
        cs.tradeMinReturnBps = trade.minReturnBps;
        cs.tradeSize = trade.tradeSize;
        cs.baseline = await readBaseline(provider, cfg, trade);
        cs.nextNonce = cs.baseline.startNonce;
        cs.approvesDone = false;
        saveState(state);
        log(`[${chainKey}] fallback baseline nonce=${cs.baseline.startNonce} pair=${trade.pair}`);
        await approveForTrade({ provider, wallet, cfg, trade, cs, save });
        }
      } else {
        const doc = loadPairsV2();
        if (doc.chains[chainKey]) {
          doc.chains[chainKey].microTested = true;
          doc.chains[chainKey].microTest = { ...mt, at: new Date().toISOString() };
          savePairsV2(doc);
        }
        // Ground truth for the budget gate: the micro-test's ACTUAL gas.
        if (mt.buyGasUsed && mt.sellGasUsed) {
          measuredEst = { buy: BigInt(mt.buyGasUsed), sell: BigInt(mt.sellGasUsed) };
        }
        log(`[${chainKey}] MICRO-TEST PASSED for ${trade.tokenSymbol}: ${mt.reason} buy=${mt.buyHash} sell=${mt.sellHash}`);
      }
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
      } else if (pendingNonce > cs.nextNonce) {
        // V2: nonces were consumed outside this script (external wallet
        // txns, or sniper txns sent but not checkpointed before a kill).
        // Those nonces are already submitted — fast-forward, never
        // re-send them (re-sending would fail "nonce too low").
        log(`[${chainKey}] nonce fast-forward: live pending nonce=${pendingNonce} > checkpoint nextNonce=${cs.nextNonce} — skipping ${pendingNonce - cs.nextNonce} consumed nonce(s)`);
        cs.nextNonce = pendingNonce;
        cs.txnsSubmitted = cs.tradeHashes.length;
        cs.status = 'running';
        saveState(state);
      }
    }

    // Gas limits: estimate once from the first round's txs, reuse after.
    // buyGasEst/sellGasEst hold the RAW estimates (no buffer) — the
    // budget gate prices the round trip at the expected ACTUAL cost.
    // The 1.2x-buffered limits are for execution safety only; pricing
    // the gate off them would overstate the cost ~1.32x (1.2x limit x
    // 1.1x gas price) and trip the Arc per-round cap on a normal round.
    let buyGasLimit = null;
    let sellGasLimit = null;
    let buyGasEst = null;
    let sellGasEst = null;
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

      // V2 GAS-BUDGET GATE: live gas vs ceiling, then estimated round
      // cost vs the per-round cap and the daily budget. A hit stops the
      // batch RESUMABLY (BUDGET: prefix) — the resume cron retries it.
      {
        const feeNow = await provider.getFeeData();
        const liveGas = feeNow.gasPrice ?? feeNow.maxFeePerGas ?? 0n;
        const ceiling = ethers.parseUnits(GAS_BUDGET[chainKey].ceilingGwei, 'gwei');
        if (liveGas > ceiling) {
          throw new Error(`BUDGET: live gas ${ethers.formatUnits(liveGas, 'gwei')} gwei exceeds ceiling ${GAS_BUDGET[chainKey].ceilingGwei} gwei on ${chainKey} — pausing batch (resumable)`);
        }
        const roundGas = (buyGasEst ?? MEASURED_ROUND_GAS[chainKey]) + (sellGasEst ?? 0n);
        const estRoundCost = roundGas * gasPrice;
        const perRoundCap = ethers.parseEther(GAS_BUDGET[chainKey].perRound);
        if (estRoundCost > perRoundCap) {
          throw new Error(`BUDGET: estimated round cost ${ethers.formatEther(estRoundCost)} exceeds per-round cap ${GAS_BUDGET[chainKey].perRound} on ${chainKey} — pausing batch (resumable)`);
        }
        const b = budgetState(cs);
        const dailyBudget = ethers.parseEther(GAS_BUDGET[chainKey].daily);
        if (BigInt(b.spentWei) + estRoundCost > dailyBudget) {
          throw new Error(`BUDGET: daily gas budget hit on ${chainKey} (spent ${ethers.formatEther(BigInt(b.spentWei))} + est ${ethers.formatEther(estRoundCost)} > ${GAS_BUDGET[chainKey].daily}) — pausing batch until tomorrow (resumable)`);
        }
      }

      // Quote buy (fresh reserves every round).
      const amounts = await withRetry(() => router.getAmountsOut(amountIn, [cfg.baseToken, tokenAddr]), `${chainKey} buy quote`);
      const quotedOut = amounts[amounts.length - 1];
      const buyMinOut = applySlippage(quotedOut, BUY_SLIPPAGE_BPS);
      const sellAmount = (quotedOut * BigInt(trade.sellOfQuoteBps)) / 10000n;
      // V2 SELL-VERIFY GATE: the sell quote must exist and the round
      // trip must return at least the pair minimum (AGNA 80% — its 5%
      // tax makes the normal return ~88%; other pairs 90%). A 0 or
      // reverting quote, or a sub-minimum return, stops the chain
      // immediately (SELL-VERIFY: prefix) and blacklists a non-AGNA
      // token. Re-verified every round, including round 0 of each batch.
      let sellAmounts;
      try {
        sellAmounts = await withRetry(() => router.getAmountsOut(sellAmount, [tokenAddr, cfg.baseToken]), `${chainKey} sell quote`);
      } catch (e) {
        if (trade.tokenSymbol !== 'AGNA') blacklistToken(trade.token, `sell quote reverted: ${(e.shortMessage || e.message || '').slice(0, 120)}`);
        throw new Error(`SELL-VERIFY: sell quote reverted for ${trade.tokenSymbol} on ${chainKey} — stopping chain`);
      }
      const sellQuoted = sellAmounts[sellAmounts.length - 1];
      if (sellQuoted === 0n) {
        if (trade.tokenSymbol !== 'AGNA') blacklistToken(trade.token, 'sell quote returned 0');
        throw new Error(`SELL-VERIFY: sell quote is 0 for ${trade.tokenSymbol} on ${chainKey} — stopping chain`);
      }
      const returnBps = Number((sellQuoted * 10000n) / amountIn);
      if (returnBps < trade.minReturnBps) {
        if (trade.tokenSymbol !== 'AGNA') blacklistToken(trade.token, `round-trip return ${returnBps} bps < ${trade.minReturnBps}`);
        throw new Error(`SELL-VERIFY: round-trip return ${returnBps} bps below minimum ${trade.minReturnBps} for ${trade.tokenSymbol} on ${chainKey} — stopping chain`);
      }
      const sellMinOut = applySlippage(sellQuoted, SELL_SLIPPAGE_BPS);

      // Build buy + sell txs.
      let buyTx;
      let sellTx;
      if (cfg.buyWithERC20) {
        buyTx = await router.swapExactTokensForTokens.populateTransaction(amountIn, buyMinOut, [cfg.baseToken, tokenAddr], BURNER, deadline());
        sellTx = await router.swapExactTokensForTokens.populateTransaction(sellAmount, sellMinOut, [tokenAddr, cfg.baseToken], BURNER, deadline());
      } else {
        buyTx = await router.swapExactETHForTokens.populateTransaction(buyMinOut, [cfg.baseToken, tokenAddr], BURNER, deadline(), { value: amountIn });
        sellTx = await router.swapExactTokensForETH.populateTransaction(sellAmount, sellMinOut, [tokenAddr, cfg.baseToken], BURNER, deadline());
      }
      if (buyGasLimit === null) {
        if (measuredEst) {
          // Prefer the micro-test's ACTUAL gas: estimateGas overstates
          // this pair (Sepolia WETH/USDC: 185k/291k estimated vs a
          // ~143k/round measured reality on the AGNA pair).
          buyGasEst = measuredEst.buy;
          sellGasEst = measuredEst.sell;
          buyGasLimit = buyGasEst * 120n / 100n;
          sellGasLimit = sellGasEst * 120n / 100n;
        } else {
          try { buyGasEst = await withRetry(() => provider.estimateGas({ ...buyTx, from: BURNER }), `${chainKey} buy gas estimate`); buyGasLimit = buyGasEst * 120n / 100n; } catch { buyGasLimit = cfg.chainKey === 'sepolia' ? 460000n : 220000n; buyGasEst = MEASURED_ROUND_GAS[chainKey] / 2n; }
          try { sellGasEst = await withRetry(() => provider.estimateGas({ ...sellTx, from: BURNER }), `${chainKey} sell gas estimate`); sellGasLimit = sellGasEst * 120n / 100n; } catch { sellGasLimit = cfg.chainKey === 'sepolia' ? 460000n : 220000n; sellGasEst = MEASURED_ROUND_GAS[chainKey] / 2n; }
        }
        log(`[${chainKey}] gas limits buy=${buyGasLimit} sell=${sellGasLimit} (est buy=${buyGasEst} sell=${sellGasEst})`);
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
      // V2: accrue the estimated gas cost to the daily budget accumulator.
      {
        const b = budgetState(cs);
        const roundGas = (buyGasEst ?? MEASURED_ROUND_GAS[chainKey]) + (sellGasEst ?? 0n);
        b.spentWei = (BigInt(b.spentWei) + roundGas * gasPrice).toString();
        if (cs.roundsDone % 5 === 0) { cs.updatedAt = new Date().toISOString(); saveState(state); }
      }
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
    // V2 (2026-11-19 fix): use the IN-MEMORY state, not a fresh disk
    // reload. The old code reloaded from disk here, silently discarding
    // up to 25 rounds of progress (roundsDone, nextNonce, hashes) that
    // had not reached a checkpoint yet — the next run then re-used a
    // stale nonce and collided with the already-mined txns ("nonce has
    // already been used"). saveState() merges only DIRTY_CHAINS, so
    // other chains' disk entries are untouched by using the live state.
    const cs2 = cs;
    DIRTY_CHAINS.add(chainKey);
    const msg = e.message || String(e);
    if (msg.startsWith('BRAKE:') || msg.startsWith('SELL-VERIFY:')) {
      // Deliberate safety stop — terminal, never auto-resumed.
      cs2.status = 'stopped';
      cs2.stopReason = msg;
    } else if (msg.startsWith('BUDGET:')) {
      // V2 gas-budget pause — resumable: leave the batch in flight so
      // the 5-min resume cron retries it (gas may drop; the daily
      // budget resets at midnight). Does not count toward the 5-error
      // stop, and does not clobber the batch target.
      cs2.status = 'running';
      cs2.stopReason = msg;
      cs2.lastError = msg;
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
    saveState(state);
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
  // V2: resolve the pair from the checkpoint (a V2 batch pins it) so
  // verification reports the pair actually traded.
  const vtrade = (cs.tradeToken && cs.tradePair)
    ? { token: cs.tradeToken, tokenSymbol: cs.tradeSymbol || 'AGNA', tokenDecimals: cs.tradeDecimals ?? 18, pair: cs.tradePair, pairName: cs.tradePairName || '' }
    : tradeCfgFor(chainKey);
  const tokenC = tokenContractFull(vtrade.token, provider);
  const pairC = pairContract(vtrade.pair, provider);
  const [finalSupply, finalTokenBal, finalNative, reserves] = await Promise.all([
    tokenC.totalSupply(), tokenC.balanceOf(BURNER), provider.getBalance(BURNER), pairC.getReserves(),
  ]);
  // Old (pre-V2) baselines stored agnaBalance/agnaTotalSupply; V2 stores
  // tokenBalance/tokenTotalSupply. Both describe the same traded token.
  const baseTokenBal = BigInt(cs.baseline.tokenBalance ?? cs.baseline.agnaBalance ?? '0');
  const baseSupply = BigInt(cs.baseline.tokenTotalSupply ?? cs.baseline.agnaTotalSupply ?? '0');
  const supplyDelta = baseSupply - finalSupply; // >0 means supply shrank (AGNA burn)
  const tokenDelta = finalTokenBal - baseTokenBal;
  const summary = {
    chain: chainKey,
    pair: vtrade.pair,
    pairName: vtrade.pairName,
    token: vtrade.token,
    tokenSymbol: vtrade.tokenSymbol,
    roundsDone: cs.roundsDone,
    batchStart: cs.batchStart,
    batchTarget: cs.batchTarget,
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
    gasBudget: cs.gasBudget || null,
    gasBudgetDaily: GAS_BUDGET[chainKey].daily,
    tokenSupplyDelta: formatDecimals(supplyDelta, vtrade.tokenDecimals),
    tokenSupplyDeltaPct: baseSupply > 0n ? (Number(supplyDelta) / Number(baseSupply) * 100).toFixed(2) : '0.00',
    finalTokenBalance: formatDecimals(finalTokenBal, vtrade.tokenDecimals),
    tokenBalanceDelta: formatDecimals(tokenDelta, vtrade.tokenDecimals),
    finalNativeBalance: ethers.formatEther(finalNative),
    finalReserve0: reserves[0].toString(),
    finalReserve1: reserves[1].toString(),
    baselineReserve0: cs.baseline.reserve0,
    baselineReserve1: cs.baseline.reserve1,
    microTest: cs.microTest || null,
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
    ? ['sepolia', 'arc-testnet', 'robinhood-testnet', 'litvm-testnet', 'base-sepolia']
    : [args.chain];
  const results = [];
  for (const c of chains) {
    if (!AGNA[c]) throw new Error(`Unknown chain ${c}`);
    results.push(await runChain(c, { smoke: args.smoke, verifyOnly: args.verify, rounds: args.rounds, resumeOnly: args.resumeOnly, sendDelayMs: args.sendDelayMs }));
  }
  console.log(JSON.stringify({ results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
