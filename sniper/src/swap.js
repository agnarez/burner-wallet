'use strict';

/**
 * Swap construction + execution (ethers v6, Uniswap V2-style router).
 *
 * Nothing here sends a transaction unless `execute()` is called with
 * dryRun=false. In dry-run mode it only builds the unsigned transaction
 * and returns it for logging.
 *
 * Roles: buys are signed by the burner wallet and the bought tokens go
 * to the burner (it must hold them to sell later). Sells send the
 * proceeds to cfg.profitRecipient (default: the Circle agent wallet,
 * the holder). The agent wallet never signs anything.
 */

const { ethers } = require('ethers');
const { applySlippage, gasTooHigh } = require('./strategy');

const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
];

const DEADLINE_SECONDS = 60 * 20; // 20 minutes

function deadline() {
  return Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
}

function routerContract(routerAddress, runner) {
  return new ethers.Contract(routerAddress, ROUTER_ABI, runner);
}

function factoryContract(factoryAddress, runner) {
  return new ethers.Contract(factoryAddress, FACTORY_ABI, runner);
}

function pairContract(pairAddress, runner) {
  return new ethers.Contract(pairAddress, PAIR_ABI, runner);
}

function tokenContract(tokenAddress, runner) {
  return new ethers.Contract(tokenAddress, ERC20_ABI, runner);
}

function requireDex(cfg) {
  if (!cfg.router || !cfg.baseToken) {
    throw new Error(
      `No DEX configured for ${cfg.chainName}. ${cfg.dexNote || ''} ` +
      'Set FACTORY_ADDRESS / ROUTER_ADDRESS / BASE_TOKEN_ADDRESS, or pick a chain with a known deployment (sepolia).',
    );
  }
}

/**
 * Quote + build an unsigned buy transaction (native token -> token).
 * The bought tokens go to the signer (the burner wallet).
 * @returns {{tx: object, quotedOut: bigint, minOut: bigint}}
 */
async function buildBuyTx({ provider, cfg, token, walletAddress }) {
  requireDex(cfg);
  const router = routerContract(cfg.router, provider);
  const amountIn = ethers.parseEther(String(cfg.buyAmountNative));
  const path = [cfg.baseToken, token];
  const amounts = await router.getAmountsOut(amountIn, path);
  const quotedOut = amounts[amounts.length - 1];
  const minOut = applySlippage(quotedOut, cfg.slippageBps);
  const tx = await router.swapExactETHForTokens.populateTransaction(
    minOut, path, walletAddress, deadline(), { value: amountIn },
  );
  return { tx, quotedOut, minOut };
}

/**
 * Quote + build unsigned buy transactions on an ERC-20 base chain
 * (Arc Testnet only). The base token is the chain's native token in
 * ERC-20 form (Arc's USDC predeploy, 6 decimals), so the buy pays in
 * that ERC-20 instead of native value: approve the router first, then
 * swapExactTokensForTokens with path [baseToken, token]. The bought
 * tokens go to the signer (the burner wallet). No native value is sent.
 * @returns {{txs: object[], quotedOut: bigint, minOut: bigint}}
 */
async function buildBuyTxERC20({ provider, cfg, token, walletAddress }) {
  requireDex(cfg);
  const router = routerContract(cfg.router, provider);
  const baseC = tokenContract(cfg.baseToken, provider);
  // Base amounts are in the base token's decimals (6 on Arc), not wei.
  const amountIn = ethers.parseUnits(String(cfg.buyAmountNative), cfg.baseDecimals ?? 18);
  const path = [cfg.baseToken, token];
  const amounts = await router.getAmountsOut(amountIn, path);
  const quotedOut = amounts[amounts.length - 1];
  const minOut = applySlippage(quotedOut, cfg.slippageBps);

  const txs = [];
  const allowance = await baseC.allowance(walletAddress, cfg.router);
  if (allowance < amountIn) {
    txs.push(await baseC.approve.populateTransaction(cfg.router, amountIn));
  }
  txs.push(await router.swapExactTokensForTokens.populateTransaction(
    amountIn, minOut, path, walletAddress, deadline(),
  ));
  return { txs, quotedOut, minOut };
}

/**
 * Quote + build unsigned sell transactions (token -> native).
 * Proceeds go to cfg.profitRecipient (default: the agent wallet).
 * @returns {{txs: object[], quotedOut: bigint, minOut: bigint, tokenBalance: bigint}}
 */
async function buildSellTx({ provider, cfg, token, walletAddress, percent = 100 }) {
  requireDex(cfg);
  const tokenC = tokenContract(token, provider);
  const router = routerContract(cfg.router, provider);
  const balance = await tokenC.balanceOf(walletAddress);
  const amountIn = (balance * BigInt(percent)) / 100n;
  if (amountIn <= 0n) throw new Error(`Nothing to sell: token balance is ${balance}`);
  const path = [token, cfg.baseToken];
  const amounts = await router.getAmountsOut(amountIn, path);
  const quotedOut = amounts[amounts.length - 1];
  const minOut = applySlippage(quotedOut, cfg.slippageBps);

  const txs = [];
  const allowance = await tokenC.allowance(walletAddress, cfg.router);
  if (allowance < amountIn) {
    txs.push(await tokenC.approve.populateTransaction(cfg.router, amountIn));
  }
  txs.push(await router.swapExactTokensForETH.populateTransaction(amountIn, minOut, path, cfg.profitRecipient, deadline()));
  return { txs, quotedOut, minOut, tokenBalance: balance };
}

/**
 * Quote + build unsigned sell transactions on an ERC-20 base chain
 * (Arc Testnet only). swapExactTokensForETH would fail here: it expects
 * path[last] to be the router's WETH, but the base token is the USDC
 * predeploy, not WETH. So the sell goes token -> base token with
 * swapExactTokensForTokens, and the proceeds arrive as base-token
 * ERC-20 at cfg.profitRecipient (default: the agent wallet, which
 * holds Arc USDC natively — the predeploy IS the native token's
 * ERC-20 form, so the proceeds land in its usable balance).
 * @returns {{txs: object[], quotedOut: bigint, minOut: bigint, tokenBalance: bigint}}
 */
async function buildSellTxERC20({ provider, cfg, token, walletAddress, percent = 100 }) {
  requireDex(cfg);
  const tokenC = tokenContract(token, provider);
  const router = routerContract(cfg.router, provider);
  const balance = await tokenC.balanceOf(walletAddress);
  const amountIn = (balance * BigInt(percent)) / 100n;
  if (amountIn <= 0n) throw new Error(`Nothing to sell: token balance is ${balance}`);
  const path = [token, cfg.baseToken];
  const amounts = await router.getAmountsOut(amountIn, path);
  const quotedOut = amounts[amounts.length - 1];
  const minOut = applySlippage(quotedOut, cfg.slippageBps);

  const txs = [];
  const allowance = await tokenC.allowance(walletAddress, cfg.router);
  if (allowance < amountIn) {
    txs.push(await tokenC.approve.populateTransaction(cfg.router, amountIn));
  }
  txs.push(await router.swapExactTokensForTokens.populateTransaction(
    amountIn, minOut, path, cfg.profitRecipient, deadline(),
  ));
  return { txs, quotedOut, minOut, tokenBalance: balance };
}

/** Current price of 1 token in base-token units (as a float), via the router quote. */
async function getTokenPrice({ provider, cfg, token }) {
  requireDex(cfg);
  const tokenC = tokenContract(token, provider);
  const decimals = await tokenC.decimals();
  const oneToken = 10n ** BigInt(decimals);
  const router = routerContract(cfg.router, provider);
  const amounts = await router.getAmountsOut(oneToken, [token, cfg.baseToken]);
  // The quote is in base-token units: 18 decimals on WETH chains,
  // 6 on Arc (USDC predeploy). formatEther would understate an Arc
  // price by 1e12, so use the base token's decimals.
  return Number(ethers.formatUnits(amounts[amounts.length - 1], cfg.baseDecimals ?? 18));
}

/**
 * Send (or dry-run) one unsigned transaction.
 * @returns {{sent: boolean, hash: string|null, tx: object}}
 */
async function execute({ provider, wallet, cfg, tx, label }) {
  const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
  if (gasTooHigh(gasPrice, cfg.maxGasGwei)) {
    throw new Error(
      `${label}: gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei exceeds cap ${cfg.maxGasGwei} gwei — skipping`,
    );
  }
  if (cfg.dryRun) {
    return { sent: false, hash: null, tx };
  }
  if (!wallet) throw new Error(`${label}: no wallet — set PRIVATE_KEY to trade live`);
  const sent = await wallet.sendTransaction(tx);
  const receipt = await sent.wait();
  return { sent: true, hash: sent.hash, receipt, tx };
}

module.exports = {
  FACTORY_ABI, ROUTER_ABI, PAIR_ABI, ERC20_ABI,
  routerContract, factoryContract, pairContract, tokenContract,
  buildBuyTx, buildSellTx, buildBuyTxERC20, buildSellTxERC20, getTokenPrice, execute,
};
