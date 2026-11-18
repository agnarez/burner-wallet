'use strict';

/**
 * Manual buy / sell / buy-then-sell cycle for a given token address.
 *
 *   node src/manual.js buy   --token 0x... [--amount 0.01] [--chain arc-testnet]
 *   node src/manual.js sell  --token 0x... [--percent 100]
 *   node src/manual.js cycle --token 0x... [--amount 0.01]
 *
 * `cycle` buys, then watches the price until take-profit / stop-loss /
 * max-hold triggers a sell (same exit rules as the watcher).
 * Dry-run is ON by default — nothing is sent unless DRY_RUN=false.
 * The burner wallet signs; sell proceeds go to the profit recipient
 * (default: the Circle agent wallet).
 */

const { ethers } = require('ethers');
const { loadConfig } = require('./config');
const { decideExit } = require('./strategy');
const { buildBuyTx, buildSellTx, getTokenPrice, execute } = require('./swap');

const POLL_MS = 15_000;

function parseArgs(argv) {
  const cmd = argv[0];
  const out = { cmd };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (argv[i] === '--amount' && argv[i + 1]) out.BUY_AMOUNT_NATIVE = argv[++i];
    else if (argv[i] === '--percent' && argv[i + 1]) out.percent = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--chain' && argv[i + 1]) out.CHAIN = argv[++i];
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['buy', 'sell', 'cycle'].includes(args.cmd)) {
    console.error('Usage: node src/manual.js <buy|sell|cycle> --token 0x... [--amount 0.01] [--percent 100] [--chain arc-testnet]');
    process.exit(1);
  }
  if (!args.token || !ethers.isAddress(args.token)) {
    console.error('A valid --token address is required.');
    process.exit(1);
  }
  const cfg = loadConfig(args);
  if (!cfg.router || !cfg.baseToken) {
    throw new Error(`No DEX configured for ${cfg.chainName}. ${cfg.dexNote || ''}`);
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== cfg.chainId) {
    throw new Error(`RPC is chain ${net.chainId}, expected ${cfg.chainId} (${cfg.chainName}).`);
  }
  console.log(`Connected to ${cfg.chainName} (chain ${net.chainId}). Mode: ${cfg.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Signer (burner): ${cfg.signerAddress} | Profit recipient (agent wallet): ${cfg.profitRecipient}`);

  let wallet = null;
  if (cfg.privateKey) {
    wallet = new ethers.Wallet(cfg.privateKey, provider);
    if (wallet.address.toLowerCase() !== cfg.signerAddress.toLowerCase()) {
      throw new Error(`PRIVATE_KEY belongs to ${wallet.address}, not the burner wallet ${cfg.signerAddress}. Refusing to trade with the wrong key.`);
    }
  } else if (!cfg.dryRun) {
    throw new Error('Live mode needs PRIVATE_KEY (the burner wallet key).');
  } else {
    console.log('No PRIVATE_KEY — dry-run only.');
  }

  const signerBal = await provider.getBalance(cfg.signerAddress);
  if (!cfg.dryRun && signerBal === 0n) {
    throw new Error(`Live mode, but the burner wallet holds 0 ${cfg.nativeSymbol} on ${cfg.chainName} — no gas.`);
  }
  if (cfg.dryRun && signerBal === 0n) {
    console.log(`Note: burner holds 0 ${cfg.nativeSymbol} here — live trading on this chain is impossible until gas is funded.`);
  }

  const token = args.token;

  async function doBuy() {
    const { tx, quotedOut, minOut } = await buildBuyTx({ provider, cfg, token, walletAddress: cfg.signerAddress });
    const result = await execute({ provider, wallet, cfg, tx, label: `buy ${token}` });
    if (cfg.dryRun) {
      console.log(`[DRY-RUN] would buy ${cfg.buyAmountNative} ${cfg.baseSymbol} -> ~${ethers.formatEther(quotedOut)} tokens (min ${ethers.formatEther(minOut)})`);
    } else {
      console.log(`Bought: tx ${result.hash}`);
    }
    return Number(cfg.buyAmountNative) / Number(ethers.formatEther(quotedOut));
  }

  async function doSell(percent) {
    const { txs, quotedOut } = await buildSellTx({ provider, cfg, token, walletAddress: cfg.signerAddress, percent });
    for (const tx of txs) {
      const result = await execute({ provider, wallet, cfg, tx, label: `sell ${token}` });
      if (cfg.dryRun) {
        console.log(`[DRY-RUN] would sell ${percent}% -> ~${ethers.formatEther(quotedOut)} ${cfg.baseSymbol} to ${cfg.profitRecipient} (tx to=${tx.to})`);
      } else {
        console.log(`Sold: tx ${result.hash}`);
      }
    }
  }

  if (args.cmd === 'buy') {
    await doBuy();
  } else if (args.cmd === 'sell') {
    const percent = args.percent ?? 100;
    if (!(percent > 0 && percent <= 100)) throw new Error('--percent must be 1–100');
    await doSell(percent);
  } else {
    // cycle: buy, then poll until an exit rule fires, then sell.
    const entryPrice = await doBuy();
    const boughtAtMs = Date.now();
    console.log(`Entry price ${entryPrice} ${cfg.baseSymbol}/token. Watching (TP +${cfg.takeProfitPct}% / SL -${cfg.stopLossPct}% / ${cfg.maxHoldSeconds}s)…`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(POLL_MS);
      const price = await getTokenPrice({ provider, cfg, token });
      const action = decideExit({ entryPrice, currentPrice: price, boughtAtMs, nowMs: Date.now(), cfg });
      const pnl = ((price - entryPrice) / entryPrice) * 100;
      console.log(`price=${price} ${cfg.baseSymbol}/token pnl=${pnl.toFixed(1)}% -> ${action}`);
      if (action !== 'hold') {
        console.log(`Exit: ${action}`);
        await doSell(100);
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
