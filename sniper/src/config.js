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
 * Chains, verified live 2026-11-18, DEX deployments verified 2026-11-19:
 *   - Arc Testnet (DEFAULT, primary): burner ~93.68 USDC, agent 100 USDC.
 *     USDC is the native gas token. Our own AGNAmuse V2 is deployed
 *     (factory 0x87125a…, router 0x96ec1B…); the AGNA pool pairs AGNA
 *     against the USDC predeploy (0x3600…0000), not WETH9 — so buys here
 *     use the ERC-20 path (approve + swapExactTokensForTokens), with
 *     base amounts in 6 decimals.
 *   - Robinhood Chain testnet: burner ~0.0054 testnet ETH (gas). Agent
 *     wallet does not exist on this chain. Our own AGNAmuse V2 is
 *     deployed (factory 0xe9f116…, router 0x4524D5…); the AGNA pool
 *     pairs AGNA against WETH9, so the native buy path works as-is.
 *   - LitVM testnet (4441): burner ~0.0298 zkLTC. Our own AGNAmuse V2
 *     is deployed (factory 0x4AcDba…, router 0x87125a…); the AGNA pool
 *     pairs AGNA against WETH9, so the native buy path works as-is.
 *   - Sepolia: Uniswap V2 IS deployed — at Sepolia-specific addresses
 *     (factory 0xF62c…, router 0xeE56…, WETH 0xfFf9…), verified live
 *     2026-11-18 (18,772 pairs). The burner holds ~0.0298 ETH gas here
 *     (was 0.05, funded by agnarez himself — tx 0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035,
 *     receipt 0x1; the rest went to the AGNA token/NFT deploys), so
 *     Sepolia is a usable live testnet target alongside Arc Testnet.
 *     The agent wallet holds 0 ETH.
 *   - Base Sepolia: no V2 at the known addresses (the Base-mainnet
 *     factory address has no code; the contract at the mainnet router
 *     address is not a V2 router), and no gas either.
 *   - LitVM testnet ("LiteForge", Litecoin's EVM rollup, verified
 *     2026-11-18): chain 4441, gas token zkLTC, RPC
 *     https://rpc.testnet.liteforge.zeeve.net/. Our own AGNAmuse V2
 *     is deployed there now (see the chain table below).
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
    // AGNAmuse V2 — our own deployment, verified live 2026-11-19:
    // factory 0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d,
    // router 0x96ec1BE94202E5F8b10123B1677A57E45b7BB9A7,
    // WETH9 (wrapped USDC) 0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce.
    // The AGNA pool (0xba3746f46Fbfe22E4E17083F1769b359A0b8956a,
    // 359.964T AGNA + 64.49 USDC) pairs AGNA against the USDC predeploy
    // (0x3600…0000), NOT against WETH9 — getPair(AGNA, WETH9) is the
    // zero address. The predeploy IS the native token's ERC-20 form:
    // balanceOf(burner) == the native balance (93.68 USDC, 2026-11-19).
    // So buys here use the ERC-20 path (approve + swapExactTokensForTokens)
    // and base amounts are 6-decimal. The native path
    // (swapExactETHForTokens, path[0] = router.WETH()) cannot buy the
    // AGNA pair and must not be used on this chain.
    baseToken: '0x3600000000000000000000000000000000000000',
    baseSymbol: 'USDC',
    nativeSymbol: 'USDC',
    baseDecimals: 6, // base token is 6-decimal; native balances stay 18-decimal
    buyWithERC20: true,
    factory: '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d',
    router: '0x96ec1BE94202E5F8b10123B1677A57E45b7BB9A7',
    gasNote: 'USDC is the native gas token. Burner 93.68 USDC, agent wallet 100 USDC (verified 2026-11-19).',
    dexNote: 'AGNAmuse V2 live (factory 0x87125a…, router 0x96ec1B…, verified 2026-11-19). AGNA/USDC pool 0xba3746… (359.964T AGNA + 64.49 USDC). Buys use the ERC-20 path — see the baseToken note above.',
  },
  'robinhood-testnet': {
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    // AGNAmuse V2 — our own deployment, verified live 2026-11-19:
    // factory 0xe9f116220486AB52b8D245aF3C19de5C025Adea8,
    // router 0x4524D50c3fa8aeA4f44db5EA1e02753cB0A8ac58,
    // WETH9 0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09.
    // The AGNA pool (0x699d97ACc97bB067842Bbe8CE89dC52d805D0a22,
    // 399.96T AGNA + 0.002006 ETH) pairs AGNA against WETH9, so the
    // native buy path works as-is (swapExactETHForTokens, path [WETH9, token]).
    baseToken: '0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09',
    baseSymbol: 'WETH',
    nativeSymbol: 'ETH',
    baseDecimals: 18,
    buyWithERC20: false,
    factory: '0xe9f116220486AB52b8D245aF3C19de5C025Adea8',
    router: '0x4524D50c3fa8aeA4f44db5EA1e02753cB0A8ac58',
    gasNote: 'Burner holds ~0.0054 testnet ETH (verified 2026-11-19; was 0.01 before the AGNA factory/pool deploys). The agent wallet does not exist on this chain.',
    dexNote: 'AGNAmuse V2 live (factory 0xe9f116…, router 0x4524D5…, verified 2026-11-19). AGNA/WETH9 pool 0x699d97… (399.96T AGNA + 0.002006 ETH).',
  },
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    // Tenderly public gateway (single node). publicnode is load-balanced
    // and it fragmented the rapid sends: the backends disagreed about
    // the mempool, ~189 Sepolia txns (nonces 825-1013) never propagated
    // and were dropped, stalling the run at 406/500 mined rounds.
    // A single node keeps one contiguous mempool so sequential nonces
    // propagate and mine. Tenderly hung once on a replacement send
    // (90s, no response); volume.cjs now has a 30s RPC timeout so a
    // stall fails fast and retries instead of hanging. The 0.01 gwei
    // gas floor (volume.cjs) is what keeps txns includable.
    rpc: 'https://sepolia.gateway.tenderly.co',
    // Uniswap V2 deployment for Sepolia, per developers.uniswap.org —
    // NOT the mainnet canonical addresses. Verified live 2026-11-18:
    // factory has code, allPairsLength = 18,772; router WETH() returns
    // 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14.
    baseToken: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    baseSymbol: 'WETH',
    nativeSymbol: 'ETH',
    baseDecimals: 18,
    buyWithERC20: false,
    factory: '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
    router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    gasNote: 'Burner holds ~0.0298 ETH (verified live 2026-11-19) — gas IS available for testnet trades. Agent wallet holds 0 ETH. The 0.05 ETH was funded by agnarez himself (tx 0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035, receipt 0x1).',
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
    buyWithERC20: false,
    factory: null,
    router: null,
    gasNote: 'BOTH wallets hold 0 ETH — no gas (same as Sepolia).',
    dexNote: 'No Uniswap V2 at the known addresses (verified: factory has no code; the contract at the mainnet router address is not a V2 router). Set FACTORY_ADDRESS / ROUTER_ADDRESS / BASE_TOKEN_ADDRESS to point at a V2-style deployment.',
  },
  'litvm-testnet': {
    name: 'LitVM Testnet',
    chainId: 4441,
    rpc: 'https://rpc.testnet.liteforge.zeeve.net/',
    // Litecoin's EVM rollup ("LiteForge"), Arbitrum Orbit/Nitro stack.
    // Verified 2026-11-18: chain ID 4441, gas token zkLTC, RPC above,
    // explorer https://explorer.testnet.liteforge.zeeve.net/.
    // AGNAmuse V2 — our own deployment, verified live 2026-11-19:
    // factory 0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce
    // (same address as Arc's WETH9 — same deployer + nonce sequence),
    // router 0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d
    // (same address as Arc's factory),
    // WETH9 0x774eF4Bf6E350A80ae86972c09f2f493e0F1Bfa6.
    // The AGNA pool (0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9,
    // 399.96T AGNA + 0.020139 zkLTC) pairs AGNA against WETH9, so the
    // native buy path works as-is (swapExactETHForTokens, path [WETH9, token]).
    baseToken: '0x774eF4Bf6E350A80ae86972c09f2f493e0F1Bfa6',
    baseSymbol: 'WETH',
    nativeSymbol: 'zkLTC',
    baseDecimals: 18,
    buyWithERC20: false,
    factory: '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce',
    router: '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d',
    gasNote: 'Burner holds ~0.0298 zkLTC (verified 2026-11-19; 0.05 claimed 2026-11-18 from the LitVM faucet, 24h cooldown; the rest went to the AGNA factory/pool deploys); agent wallet holds 0 zkLTC.',
    dexNote: 'AGNAmuse V2 live (factory 0x4AcDba…, router 0x87125a…, verified 2026-11-19). AGNA/WETH9 pool 0xE887Aa… (399.96T AGNA + 0.020139 zkLTC).',
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
    // Arc Testnet only: the base token is the 6-decimal USDC predeploy
    // (the native token's ERC-20 form), so buys/sells go through
    // approve + swapExactTokensForTokens instead of the native
    // swapExactETHForTokens / swapExactTokensForETH path.
    buyWithERC20: chain.buyWithERC20 === true,
    gasNote: chain.gasNote,
    dexNote: chain.dexNote,
    dryRun: (env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    // Buy size per snipe, in the chain's native token (USDC on Arc,
    // ETH on Sepolia / Base Sepolia / Robinhood, zkLTC on LitVM).
    // BUY_AMOUNT_ETH is kept as an alias.
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
