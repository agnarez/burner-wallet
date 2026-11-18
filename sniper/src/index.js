'use strict';

/**
 * Entry point for the sniper watcher.
 *   node src/index.js [--chain arc-testnet|robinhood-testnet|sepolia|base-sepolia]
 *
 * Dry-run is ON by default (DRY_RUN=true in .env). Live trading needs
 * DRY_RUN=false AND a PRIVATE_KEY (the burner wallet's key) in the env.
 *
 * On chains with no known DEX deployment (Arc Testnet, Robinhood Chain
 * testnet) the tool prints the wallet + gas status and stops with
 * guidance instead of pretending to watch — set FACTORY_ADDRESS /
 * ROUTER_ADDRESS / BASE_TOKEN_ADDRESS to point it at a V2-style DEX.
 */

const { ethers } = require('ethers');
const { loadConfig } = require('./config');
const { watchNewPairs } = require('./watch');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chain' && argv[i + 1]) out.CHAIN = argv[++i];
  }
  return out;
}

async function printStatus(provider, cfg) {
  console.log(`Chain: ${cfg.chainName} (id ${cfg.chainId}) via ${cfg.rpcUrl}`);
  console.log(`Gas: ${cfg.gasNote}`);
  console.log(`DEX: ${cfg.dexNote}`);
  const signerBal = await provider.getBalance(cfg.signerAddress);
  const agentBal = await provider.getBalance(cfg.agentAddress);
  console.log(`Burner wallet (signer):  ${cfg.signerAddress} — ${ethers.formatEther(signerBal)} ${cfg.nativeSymbol}`);
  console.log(`Agent wallet (holder):   ${cfg.agentAddress} — ${ethers.formatEther(agentBal)} ${cfg.nativeSymbol}`);
  console.log(`Profit recipient:        ${cfg.profitRecipient}`);
  return { signerBal, agentBal };
}

async function main() {
  const cfg = loadConfig(parseArgs(process.argv.slice(2)));
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== cfg.chainId) {
    throw new Error(
      `RPC ${cfg.rpcUrl} is chain ${net.chainId}, expected ${cfg.chainId} (${cfg.chainName}). ` +
      'Check RPC_URL / CHAIN.',
    );
  }
  console.log(`Connected to ${cfg.chainName} (chain ${net.chainId})`);
  const { signerBal } = await printStatus(provider, cfg);

  let wallet = null;
  if (cfg.privateKey) {
    wallet = new ethers.Wallet(cfg.privateKey, provider);
    if (wallet.address.toLowerCase() !== cfg.signerAddress.toLowerCase()) {
      throw new Error(
        `PRIVATE_KEY belongs to ${wallet.address}, not the burner wallet ${cfg.signerAddress}. ` +
        'Refusing to trade with the wrong key.',
      );
    }
    console.log(`Signer key loaded for burner wallet ${wallet.address}`);
  } else if (!cfg.dryRun) {
    throw new Error('Live mode needs PRIVATE_KEY (the burner wallet key).');
  } else {
    console.log('No PRIVATE_KEY set — dry-run only.');
  }

  if (!cfg.dryRun && signerBal === 0n) {
    throw new Error(
      `Live mode, but the burner wallet holds 0 ${cfg.nativeSymbol} on ${cfg.chainName} — no gas, no trade possible. ` +
      'Fund gas first (see README: the Circle faucet gives USDC, not ETH, on Sepolia/Base Sepolia).',
    );
  }
  if (cfg.dryRun && signerBal === 0n) {
    console.log(`Note: burner holds 0 ${cfg.nativeSymbol} here — live trading on this chain is impossible until gas is funded.`);
  }

  if (!cfg.factory || !cfg.baseToken) {
    console.log('');
    console.log('WATCHER NOT STARTED — no DEX is configured on this chain yet.');
    console.log('To watch for launches here, point the tool at a Uniswap V2-style');
    console.log('deployment with FACTORY_ADDRESS, ROUTER_ADDRESS and BASE_TOKEN_ADDRESS');
    console.log('in .env, or run with --chain sepolia (V2 deployed there, and the burner has 0.05 ETH gas).');
    return;
  }

  if (!cfg.dryRun) {
    console.log('!!! LIVE MODE — real transactions will be sent. Ctrl+C now to abort. !!!');
  }

  const { stop } = watchNewPairs({ provider, wallet, cfg, walletAddress: cfg.signerAddress });
  process.on('SIGINT', () => {
    console.log('\nStopping watcher…');
    stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
