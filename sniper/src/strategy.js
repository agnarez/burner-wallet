'use strict';

/**
 * Pure buy/sell decision logic — no network, no wallet, no side effects.
 * Everything here is unit-testable with plain numbers/bigints.
 *
 * "Base token" is the chain's native-side token a new pair is measured
 * against: WETH on Sepolia / Base Sepolia, native USDC on Arc Testnet,
 * ETH on Robinhood Chain testnet.
 */

/**
 * Decide whether a newly-created pair is worth sniping.
 * @param {object} p
 * @param {string} p.token - candidate token address (the non-base side)
 * @param {string} p.baseToken - base-token address on this chain
 * @param {bigint} p.baseLiquidityWei - base-side reserve of the new pair
 * @param {bigint} p.tokenLiquidityRaw - token-side reserve (raw units)
 * @param {object} cfg - config from loadConfig()
 * @returns {{buy: boolean, reason: string}}
 */
function shouldBuy({ token, baseToken, baseLiquidityWei, tokenLiquidityRaw, cfg }) {
  if (!token || token.toLowerCase() === baseToken.toLowerCase()) {
    return { buy: false, reason: 'pair has no non-base token side' };
  }
  if (baseLiquidityWei <= 0n || tokenLiquidityRaw <= 0n) {
    return { buy: false, reason: 'pair launched with zero liquidity on one side' };
  }
  // Compare in native units without floats: minBaseLiquidity is a decimal
  // number of native tokens, scaled to wei with 1e18 precision.
  const minWei = parseNativeToWei(cfg.minBaseLiquidity);
  if (baseLiquidityWei < minWei) {
    return {
      buy: false,
      reason: `base liquidity too low (${formatNative(baseLiquidityWei)} < ${cfg.minBaseLiquidity} ${cfg.baseSymbol})`,
    };
  }
  return { buy: true, reason: `base liquidity ${formatNative(baseLiquidityWei)} ${cfg.baseSymbol} >= ${cfg.minBaseLiquidity} ${cfg.baseSymbol}` };
}

/** Parse a decimal native-token string/number to wei (bigint), no float rounding. */
function parseNativeToWei(v) {
  const s = String(v);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000000000000000').slice(0, 18);
  return BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0');
}

function formatNative(wei) {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18) || '0';
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Percentage change from entry price to current price.
 * Prices are "native token per 1 token" (or any consistent unit) as numbers.
 */
function pnlPct(entryPrice, currentPrice) {
  if (!(entryPrice > 0)) throw new Error('entryPrice must be > 0');
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

/**
 * Decide what to do with an open position.
 * @param {object} p
 * @param {number} p.entryPrice - native token per token at buy time
 * @param {number} p.currentPrice - native token per token now
 * @param {number} p.boughtAtMs - Date.now() at buy time
 * @param {number} p.nowMs - Date.now() now
 * @param {object} cfg - config from loadConfig()
 * @returns {'hold'|'take-profit'|'stop-loss'|'timeout'}
 */
function decideExit({ entryPrice, currentPrice, boughtAtMs, nowMs, cfg }) {
  const pnl = pnlPct(entryPrice, currentPrice);
  // EPS absorbs float noise at the exact boundary (e.g. -20% computing
  // as -19.999999999999996), so a price sitting exactly on a trigger fires.
  const EPS = 1e-9;
  if (pnl >= cfg.takeProfitPct - EPS) return 'take-profit';
  if (pnl <= -cfg.stopLossPct + EPS) return 'stop-loss';
  if (nowMs - boughtAtMs >= cfg.maxHoldSeconds * 1000) return 'timeout';
  return 'hold';
}

/**
 * Minimum acceptable output after slippage, in raw token units.
 * @param {bigint} amountOut - quoted output (no slippage)
 * @param {number} slippageBps - e.g. 500 = 5%
 * @returns {bigint}
 */
function applySlippage(amountOut, slippageBps) {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new Error('slippageBps must be between 0 and 10000');
  }
  return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
}

/** Gas price (bigint wei) against the configured cap. */
function gasTooHigh(gasPriceWei, maxGasGwei) {
  return gasPriceWei > BigInt(maxGasGwei) * 10n ** 9n;
}

module.exports = { shouldBuy, pnlPct, decideExit, applySlippage, gasTooHigh, parseNativeToWei, formatNative };
