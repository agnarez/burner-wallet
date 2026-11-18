'use strict';

/**
 * Configuration for the burner-wallet sniper.
 *
 * Two wallets, two roles:
 *   - Burner wallet (BURNER_WALLET_ADDRESS, default 0x6F31…): the OPERATOR.
 *     We hold its key, so it signs trades. Its private key comes ONLY from
 *     the PRIVATE_KEY environment variable.
 *   - Circle agent wallet (AGENT_WALLET_ADDRESS, default 0xd305…): the
 *     HOLDER / profit recipient. It is MPC-held by Circle — there is NO
 *     exportable private key. It can only move USDC via the Circle CLI
 *     (`circle wallet ...`). Nothing in this tool ever asks for its key,
 *     and sell proceeds can be sent to it (PROFIT_RECIPIENT).
 *
 * Chains, verified live 2026-11-18:
 *   - Arc Testnet (DEFAULT, primary): burner 80 USDC, agent 20 USDC.
 *     USDC is the native gas token. No Uniswap V2-style DEX at the
 *     canonical factory/router addresses (checked: no code there).
 *   - Robinhood Chain testnet: burner 0.01 testnet ETH (gas). Agent
 *     wallet does not exist on this chain. No V2-style DEX on testnet
 *     at the Uniswap-listed addresses (mainnet-only deployment).
 *   - Sepolia: Uniswap V2 IS deployed — at Sepolia-specific addresses
 *     (factory 0xF62c…, router 0xeE56…, WETH 0xfFf9…), verified live
 *     2026-11-18 (18,772 pairs). The burner holds 0.05 ETH gas here,
 *     funded by agnarez himself (tx 0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035,
 *     receipt 0x1), so Sepolia is a usable live testnet target
 *     alongside Arc Testnet. The agent wallet holds 0 ETH.
 *   - Base Sepolia: no V2 at the known addresses (the Base-mainnet
 *     factory address has no code; the contract at the mainnet router
 *     address is not a V2 router), and no gas either.
 *
 * Testnets only. There is deliberately no mainnet entry in the chain
 * table: mainnet use is the user's own call.
 */

require('dotenv').config();

const BURNER_WALLET_DEFAULT = '0x6F311641923246e7f4fE2F1F679c75f4DE107621';
const AGENT_WALLET_DEFAULT = '0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7';

const CHAINS = {
  'arc-testnet': {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://arc-testnet-rpc.publicnode.com',
    // USDC is the native gas token. There is no known wrapped-USDC token
    // that a V2-style DEX pairs against — set BASE_TOKEN_ADDRESS when a
    // DEX deployment is known.
    baseToken: null,
    baseSymbol: 'USDC',
    nativeSymbol: 'USDC',
    baseDecimals: 18, // native balances are 18-decimal on Arc
    factory: null,
    router: null,
    gasNote: 'USDC is the native gas token. Burner 80 USDC, agent wallet 20 USDC (verified 2026-11-18).',
    dexNote: 'No Uniswap V2-style DEX on Arc Testnet at the checked addresses (verified: no code — neither the canonical addresses nor the Eco-docs Arc addresses). Set FACTORY_ADDRESS / ROUTER_ADDRESS / BASE_TOKEN_ADDRESS to point at a V2-style deployment.',
  },
  'robinhood-testnet': {
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    baseToken: null,
    baseSymbol: 'ETH',
    nativeSymbol: 'ETH',
    baseDecimals: 18,
    factory: null,
    router: null,
    gasNote: 'Burner holds 0.01 testnet ETH (verified 2026-11-18). The agent wallet does not exist on this chain.',
    dexNote: 'No Uniswap V2 on testnet at the listed addresses (verified: no code — the Uniswap deployment is mainnet-only). Set FACTORY_ADDRESS / ROUTER_ADDRESS / BASE_TOKEN_ADDRESS to point at a V2-style deployment.',
  },
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    // Uniswap V2 deployment for Sepolia, per developers.uniswap.org —
    // NOT the mainnet canonical addresses. Verified live 2026-11-18:
    // factory has code, allPairsLength = 18,772; router WETH() returns
    // 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14.
    baseToken: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    baseSymbol: 'WETH',
    nativeSymbol: 'ETH',
    baseDecimals: 18,
    factory: '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
    router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    gasNote: 'Burner holds 0.05 ETH (verified live 2026-11-18) — gas IS available for testnet trades. Agent wallet holds 0 ETH. The 0.05 ETH was funded by agnarez himself (tx 0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035, receipt 0x1).',
    dexNote: 'Uniswap V2 deployment verified live (18,772 pairs). The only chain here with a working V2 DEX — and the burner has gas, so the watcher can run here.',
  },
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpc: 'https://sepolia.base.org',
    // No Uniswap V2 at the known addresses (checked 2026-11-18): the
    // Base-mainnet factory address has no code here, and the contract at
    // the mainnet router address is not a V2 router (factory()/WETH()
    // revert). Uniswap's deployment list does not include Base Sepolia.
    baseToken: null,
    baseSymbol: 'WETH',
    nativeSymbol: 'ETH',
    baseDecimals: 18,
    factory: null,
    router: null,
    gasNote: 'BOTH wallets hold 0 ETH — no gas (same as Sepolia).',
    dexNote: 'No Uniswap V2 at the known addresses (verified: factory has no code; the contract at the mainnet router address is not a V2 router). Set FACTORY_ADDRESS / ROUTER_ADDRESS / BASE_TOKEN_ADDRESS to point at a V2-style deployment.',
  },
};

function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function envInt(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Bad ${name}: ${JSON.stringify(v)} (expected integer)`);
  return n;
}

function envFloat(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`Bad ${name}: ${JSON.stringify(v)} (expected number)`);
  return n;
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const chainKey = (env.CHAIN || 'arc-testnet').toLowerCase();
  const chain = CHAINS[chainKey];
  if (!chain) {
    throw new Error(
      `Unknown CHAIN ${JSON.stringify(chainKey)}. ` +
      `Supported testnets: ${Object.keys(CHAINS).join(', ')}. ` +
      `Mainnet is not configured in this tool on purpose.`,
    );
  }

  const signerAddress = env.BURNER_WALLET_ADDRESS || BURNER_WALLET_DEFAULT;
  const agentAddress = env.AGENT_WALLET_ADDRESS || AGENT_WALLET_DEFAULT;
  const profitRecipient = env.PROFIT_RECIPIENT || agentAddress;
  if (!isAddress(signerAddress)) throw new Error(`Bad BURNER_WALLET_ADDRESS: ${signerAddress}`);
  if (!isAddress(agentAddress)) throw new Error(`Bad AGENT_WALLET_ADDRESS: ${agentAddress}`);
  if (!isAddress(profitRecipient)) throw new Error(`Bad PROFIT_RECIPIENT: ${profitRecipient}`);

  const baseToken = env.BASE_TOKEN_ADDRESS || chain.baseToken;
  if (baseToken !== null && baseToken !== undefined && !isAddress(baseToken)) {
    throw new Error(`Bad BASE_TOKEN_ADDRESS: ${baseToken}`);
  }

  const cfg = {
    chainKey,
    chainName: chain.name,
    chainId: chain.chainId,
    rpcUrl: env.RPC_URL || chain.rpc,
    factory: env.FACTORY_ADDRESS || chain.factory,
    router: env.ROUTER_ADDRESS || chain.router,
    baseToken: baseToken || null,
    baseSymbol: chain.baseSymbol,
    nativeSymbol: chain.nativeSymbol,
    baseDecimals: chain.baseDecimals,
    gasNote: chain.gasNote,
    dexNote: chain.dexNote,
    dryRun: (env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    // Buy size per snipe, in the chain's native token (USDC on Arc,
    // ETH on the other testnets). BUY_AMOUNT_ETH is kept as an alias.
    buyAmountNative: envFloat(env, 'BUY_AMOUNT_NATIVE', envFloat(env, 'BUY_AMOUNT_ETH', 0.01)),
    slippageBps: envInt(env, 'SLIPPAGE_BPS', 500),
    maxGasGwei: envInt(env, 'MAX_GAS_GWEI', 100),
    takeProfitPct: envFloat(env, 'TAKE_PROFIT_PCT', 50),
    stopLossPct: envFloat(env, 'STOP_LOSS_PCT', 20),
    maxHoldSeconds: envInt(env, 'MAX_HOLD_SECONDS', 3600),
    // Min base-token-side liquidity a new pair must launch with to snipe.
    minBaseLiquidity: envFloat(env, 'MIN_BASE_LIQUIDITY', envFloat(env, 'MIN_WETH_LIQUIDITY', 0.1)),
    // Wallets. The burner signs; the agent wallet only holds/receives.
    signerAddress,
    agentAddress,
    profitRecipient,
    // Private key ONLY from env, and ONLY the burner's key. There is no
    // variable for an agent-wallet key because none exists (MPC-held).
    privateKey: (env.PRIVATE_KEY || '').trim(),
  };

  if (!cfg.dryRun && !cfg.privateKey) {
    throw new Error('DRY_RUN=false but no PRIVATE_KEY set. Refusing to trade without a key.');
  }
  if (cfg.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-hex-character key.');
  }
  if (!(cfg.buyAmountNative > 0)) throw new Error('BUY_AMOUNT_NATIVE must be > 0');
  if (cfg.slippageBps < 0 || cfg.slippageBps > 5000) {
    throw new Error('SLIPPAGE_BPS must be between 0 and 5000 (0–50%)');
  }
  if (!(cfg.maxGasGwei > 0)) throw new Error('MAX_GAS_GWEI must be > 0');
  if (!(cfg.takeProfitPct > 0)) throw new Error('TAKE_PROFIT_PCT must be > 0');
  if (!(cfg.stopLossPct > 0)) throw new Error('STOP_LOSS_PCT must be > 0');
  if (!(cfg.maxHoldSeconds > 0)) throw new Error('MAX_HOLD_SECONDS must be > 0');
  if (!(cfg.minBaseLiquidity >= 0)) throw new Error('MIN_BASE_LIQUIDITY must be >= 0');

  return cfg;
}

module.exports = { CHAINS, BURNER_WALLET_DEFAULT, AGENT_WALLET_DEFAULT, loadConfig };
