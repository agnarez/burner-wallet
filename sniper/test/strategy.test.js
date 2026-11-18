'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldBuy, pnlPct, decideExit, applySlippage, gasTooHigh,
  parseNativeToWei, formatNative, parseToDecimals, formatDecimals,
} = require('../src/strategy');

const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

function baseCfg(over = {}) {
  return {
    baseSymbol: 'WETH',
    minBaseLiquidity: 0.1,
    takeProfitPct: 50,
    stopLossPct: 20,
    maxHoldSeconds: 3600,
    ...over,
  };
}

test('shouldBuy: buys when base liquidity meets the minimum', () => {
  const d = shouldBuy({
    token: TOKEN, baseToken: WETH,
    baseLiquidityWei: parseNativeToWei('1'), tokenLiquidityRaw: 1000000n,
    cfg: baseCfg(),
  });
  assert.equal(d.buy, true);
});

test('shouldBuy: rejects low base liquidity', () => {
  const d = shouldBuy({
    token: TOKEN, baseToken: WETH,
    baseLiquidityWei: parseNativeToWei('0.05'), tokenLiquidityRaw: 1000000n,
    cfg: baseCfg(),
  });
  assert.equal(d.buy, false);
  assert.match(d.reason, /too low/);
});

test('shouldBuy: rejects zero liquidity on either side', () => {
  assert.equal(shouldBuy({
    token: TOKEN, baseToken: WETH,
    baseLiquidityWei: 0n, tokenLiquidityRaw: 1000000n, cfg: baseCfg(),
  }).buy, false);
  assert.equal(shouldBuy({
    token: TOKEN, baseToken: WETH,
    baseLiquidityWei: parseNativeToWei('1'), tokenLiquidityRaw: 0n, cfg: baseCfg(),
  }).buy, false);
});

test('shouldBuy: rejects a pair whose token is the base token itself', () => {
  assert.equal(shouldBuy({
    token: WETH, baseToken: WETH,
    baseLiquidityWei: parseNativeToWei('1'), tokenLiquidityRaw: 1000000n, cfg: baseCfg(),
  }).buy, false);
});

test('shouldBuy: 6-decimal base (Arc USDC) compares in base units, not wei', () => {
  // Arc: min 0.1 USDC = 100_000 raw units at 6 decimals.
  const arcCfg = baseCfg({ baseSymbol: 'USDC', baseDecimals: 6 });
  assert.equal(shouldBuy({
    token: TOKEN, baseToken: '0x3600000000000000000000000000000000000000',
    baseLiquidityWei: 100000n, tokenLiquidityRaw: 1000000n, cfg: arcCfg,
  }).buy, true);
  assert.equal(shouldBuy({
    token: TOKEN, baseToken: '0x3600000000000000000000000000000000000000',
    baseLiquidityWei: 50000n, tokenLiquidityRaw: 1000000n, cfg: arcCfg,
  }).buy, false);
  // Regression: the same raw amount at 18 decimals is dust and must fail.
  assert.equal(shouldBuy({
    token: TOKEN, baseToken: WETH,
    baseLiquidityWei: 100000n, tokenLiquidityRaw: 1000000n, cfg: baseCfg(),
  }).buy, false);
});

test('parseToDecimals / formatDecimals round-trip at 6 and 18 decimals', () => {
  assert.equal(parseToDecimals('0.01', 6), 10000n);
  assert.equal(parseToDecimals('1', 6), 1000000n);
  assert.equal(parseToDecimals('0.01', 18), 10n ** 16n);
  assert.equal(formatDecimals(10000n, 6), '0.01');
  assert.equal(formatDecimals(64492214n, 6), '64.492214');
  assert.equal(formatDecimals(0n, 6), '0');
});

test('decideExit: hold inside the band', () => {
  const now = Date.now();
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 1.1, boughtAtMs: now - 1000, nowMs: now, cfg: baseCfg(),
  }), 'hold');
});

test('decideExit: take-profit at +50%', () => {
  const now = Date.now();
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 1.5, boughtAtMs: now - 1000, nowMs: now, cfg: baseCfg(),
  }), 'take-profit');
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 2, boughtAtMs: now - 1000, nowMs: now, cfg: baseCfg(),
  }), 'take-profit');
});

test('decideExit: stop-loss at -20%', () => {
  const now = Date.now();
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 0.8, boughtAtMs: now - 1000, nowMs: now, cfg: baseCfg(),
  }), 'stop-loss');
});

test('decideExit: timeout after max hold', () => {
  const now = Date.now();
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 1.1,
    boughtAtMs: now - 3601 * 1000, nowMs: now, cfg: baseCfg(),
  }), 'timeout');
});

test('decideExit: take-profit wins over timeout when both apply', () => {
  const now = Date.now();
  assert.equal(decideExit({
    entryPrice: 1, currentPrice: 1.6,
    boughtAtMs: now - 99999 * 1000, nowMs: now, cfg: baseCfg(),
  }), 'take-profit');
});

test('applySlippage: 5% off 10000 is 9500', () => {
  assert.equal(applySlippage(10000n, 500), 9500n);
  assert.equal(applySlippage(10000n, 0), 10000n);
  assert.equal(applySlippage(10000n, 10000), 0n);
  assert.throws(() => applySlippage(10000n, 10001), /slippageBps/);
});

test('gasTooHigh: respects the cap', () => {
  const gwei = (n) => BigInt(n) * 10n ** 9n;
  assert.equal(gasTooHigh(gwei(100), 100), false);
  assert.equal(gasTooHigh(gwei(101), 100), true);
  assert.equal(gasTooHigh(gwei(1), 100), false);
});

test('pnlPct: +50% and -20%', () => {
  assert.equal(pnlPct(1, 1.5), 50);
  assert.equal(pnlPct(1, 0.8), -19.999999999999996);
  assert.throws(() => pnlPct(0, 1), /entryPrice/);
});

test('parseNativeToWei / formatNative round-trip', () => {
  assert.equal(parseNativeToWei('0.01'), 10n ** 16n);
  assert.equal(parseNativeToWei('1'), 10n ** 18n);
  assert.equal(parseNativeToWei(0.5), 5n * 10n ** 17n);
  assert.equal(formatNative(10n ** 16n), '0.01');
  assert.equal(formatNative(10n ** 18n), '1');
  assert.equal(formatNative(0n), '0');
});
