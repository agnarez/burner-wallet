'use strict';

/**
 * Watches a Uniswap V2-style factory for PairCreated events and snipes
 * new pairs whose other side is the chain's base token (WETH on Sepolia /
 * Base Sepolia, native USDC on Arc Testnet, ETH on Robinhood Chain).
 *
 * Flow per new pair:
 *   1. PairCreated(token0, token1, pair)
 *   2. Skip unless one side is the base token
 *   3. Read reserves -> base-side liquidity -> strategy.shouldBuy()
 *   4. Buy (or log the dry-run buy), record the entry price
 *   5. Poll the price every POLL_MS and sell on take-profit / stop-loss /
 *      max-hold, per strategy.decideExit(). Sell proceeds go to the
 *      profit recipient (default: the Circle agent wallet).
 *
 * Dry-run mode (default): steps 4–5 are simulated and logged only.
 * The burner wallet signs; the agent wallet never signs.
 */

const { ethers } = require('ethers');
const { shouldBuy, decideExit, formatDecimals } = require('./strategy');
const {
  factoryContract, pairContract, buildBuyTx, buildSellTx,
  buildBuyTxERC20, buildSellTxERC20, getTokenPrice, execute,
} = require('./swap');

const POLL_MS = 15_000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * @param {object} opts
 * @param {ethers.JsonRpcProvider} opts.provider
 * @param {ethers.Wallet|null} opts.wallet - null in dry-run without a key
 * @param {object} opts.cfg - config from loadConfig()
 * @param {string|null} opts.walletAddress - the burner (signer) address
 * @returns {{positions: Map, stop: function}} — stop() removes the listener
 */
function watchNewPairs({ provider, wallet, cfg, walletAddress }) {
  if (!cfg.factory || !cfg.baseToken) {
    throw new Error(
      `No DEX factory configured for ${cfg.chainName}. ${cfg.dexNote || ''}`,
    );
  }
  const factory = factoryContract(cfg.factory, provider);
  const positions = new Map(); // token (lowercase) -> { pair, entryPrice, boughtAtMs, amountNative }

  async function onPairCreated(token0, token1, pair) {
    try {
      const baseLc = cfg.baseToken.toLowerCase();
      const token = token0.toLowerCase() === baseLc ? token1 : token1.toLowerCase() === baseLc ? token0 : null;
      if (!token) return; // neither side is the base token — not a launch we snipe
      if (positions.has(token.toLowerCase())) return; // already holding it

      const pairC = pairContract(pair, provider);
      const [r0, r1] = await pairC.getReserves();
      const baseIs0 = token0.toLowerCase() === baseLc;
      const baseLiquidityWei = baseIs0 ? r0 : r1;
      const tokenLiquidityRaw = baseIs0 ? r1 : r0;

      const decision = shouldBuy({ token, baseToken: cfg.baseToken, baseLiquidityWei, tokenLiquidityRaw, cfg });
      log(`[new pair] ${token} / ${cfg.baseSymbol}  pair=${pair}  base liq=${formatDecimals(baseLiquidityWei, cfg.baseDecimals ?? 18)} ${cfg.baseSymbol}`);
      if (!decision.buy) {
        log(`  skip: ${decision.reason}`);
        return;
      }
      log(`  snipe: ${decision.reason}`);

      // Arc Testnet buys with the ERC-20 path (approve + swapExactTokensForTokens);
      // every other chain buys with the native path (swapExactETHForTokens).
      let quotedOut;
      if (cfg.buyWithERC20) {
        const built = await buildBuyTxERC20({ provider, cfg, token, walletAddress });
        quotedOut = built.quotedOut;
        for (const tx of built.txs) {
          const result = await execute({ provider, wallet, cfg, tx, label: `buy ${token}` });
          if (cfg.dryRun) {
            log(`  [DRY-RUN] would send tx to=${tx.to} value=${ethers.formatEther(tx.value ?? 0n)} ${cfg.nativeSymbol} data=${String(tx.data).slice(0, 66)}…`);
          } else {
            log(`  sent: tx ${result.hash}`);
          }
        }
        if (cfg.dryRun) {
          log(`  [DRY-RUN] would buy ${cfg.buyAmountNative} ${cfg.baseSymbol} -> ~${ethers.formatEther(quotedOut)} tokens (min ${ethers.formatEther(built.minOut)})`);
        }
      } else {
        const { tx, quotedOut: q, minOut } = await buildBuyTx({ provider, cfg, token, walletAddress });
        quotedOut = q;
        const result = await execute({ provider, wallet, cfg, tx, label: `buy ${token}` });
        if (cfg.dryRun) {
          log(`  [DRY-RUN] would buy ${cfg.buyAmountNative} ${cfg.baseSymbol} -> ~${ethers.formatEther(quotedOut)} tokens (min ${ethers.formatEther(minOut)})`);
          log(`  [DRY-RUN] unsigned tx: to=${tx.to} value=${ethers.formatEther(tx.value ?? 0n)} ${cfg.baseSymbol} data=${String(tx.data).slice(0, 66)}…`);
        } else {
          log(`  bought: tx ${result.hash}`);
        }
      }

      // Entry price = native token per token, from the quote (dry-run or live alike).
      const entryPrice = Number(cfg.buyAmountNative) / Number(ethers.formatEther(quotedOut));
      positions.set(token.toLowerCase(), {
        pair, entryPrice, boughtAtMs: Date.now(), amountNative: cfg.buyAmountNative,
      });
      log(`  entry price ${entryPrice} ${cfg.baseSymbol}/token — watching for exit (TP +${cfg.takeProfitPct}% / SL -${cfg.stopLossPct}% / ${cfg.maxHoldSeconds}s), proceeds to ${cfg.profitRecipient}`);
    } catch (err) {
      log(`[new pair] error handling ${pair}:`, err.shortMessage || err.message);
    }
  }

  async function tickPositions() {
    for (const [token, pos] of [...positions.entries()]) {
      try {
        const price = await getTokenPrice({ provider, cfg, token });
        const action = decideExit({
          entryPrice: pos.entryPrice, currentPrice: price,
          boughtAtMs: pos.boughtAtMs, nowMs: Date.now(), cfg,
        });
        const pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        if (action === 'hold') {
          log(`[hold] ${token} price=${price} ${cfg.baseSymbol}/token pnl=${pnl.toFixed(1)}%`);
          continue;
        }
        log(`[exit:${action}] ${token} price=${price} ${cfg.baseSymbol}/token pnl=${pnl.toFixed(1)}% — selling to ${cfg.profitRecipient}`);
        // Arc Testnet sells with the ERC-20 path (swapExactTokensForTokens);
        // every other chain sells with the native path (swapExactTokensForETH).
        const sellBuilt = cfg.buyWithERC20
          ? await buildSellTxERC20({ provider, cfg, token, walletAddress, percent: 100 })
          : await buildSellTx({ provider, cfg, token, walletAddress, percent: 100 });
        const sellQuoted = sellBuilt.quotedOut;
        for (const tx of sellBuilt.txs) {
          const result = await execute({ provider, wallet, cfg, tx, label: `sell ${token}` });
          if (cfg.dryRun) {
            log(`  [DRY-RUN] would sell -> ~${ethers.formatUnits(sellQuoted, cfg.baseDecimals ?? 18)} ${cfg.baseSymbol} (tx to=${tx.to})`);
          } else {
            log(`  sold: tx ${result.hash}`);
          }
        }
        positions.delete(token);
      } catch (err) {
        log(`[position] error on ${token}:`, err.shortMessage || err.message);
      }
    }
  }

  factory.on('PairCreated', onPairCreated);
  const timer = setInterval(() => { tickPositions().catch((e) => log('[tick] error:', e.message)); }, POLL_MS);

  log(`Watching ${cfg.chainName} factory ${cfg.factory} for new ${cfg.baseSymbol} pairs…`);
  log(`Mode: ${cfg.dryRun ? 'DRY-RUN (no transactions will be sent)' : 'LIVE — real transactions'}`);
  log(`Signer (burner): ${walletAddress} | Profit recipient (agent wallet): ${cfg.profitRecipient}`);
  log(`Buy ${cfg.buyAmountNative} ${cfg.baseSymbol} per snipe, slippage ${cfg.slippageBps} bps, gas cap ${cfg.maxGasGwei} gwei`);

  return {
    positions,
    stop() {
      factory.off('PairCreated', onPairCreated);
      clearInterval(timer);
    },
  };
}

module.exports = { watchNewPairs, POLL_MS };
