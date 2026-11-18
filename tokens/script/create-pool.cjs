#!/usr/bin/env node
// create-pool.cjs — creates the $AGNA liquidity pool on a chain (prepared, NOT executed on live chains by any agent).
//
// Pool funding rule (agnarez, FINAL 2026-11-18 — supersedes the
// equal-split default):
//   The token deploys PER CHAIN, each chain minting its own 404T.
//   (1) Each pool pairs AGNA with that chain's NATIVE GAS token:
//       ETH on Sepolia/Robinhood, USDC on Arc (USDC is Arc's gas
//       token), zkLTC on LitVM.
//   (2) Gas side: 40.4% of the wallet's native-gas balance per chain
//       (Sepolia 0.05 ETH -> 0.0202, Arc 80 USDC -> 32.32, LitVM
//       0.05 zkLTC -> 0.0202, Robinhood 0.01005 ETH -> 0.00406).
//   (3) AGNA side: 99% of THAT chain's burner AGNA after the 10%
//       agent allocation (363.6T -> ~360T per chain, ~3.6T stays with
//       the burner). Per-chain pool numbers: Sepolia ~360T + 0.0202
//       ETH; Arc ~360T + 32.32 USDC; LitVM ~360T + 0.0202 zkLTC;
//       Robinhood ~360T + 0.00406 ETH.
//   The per-chain AGNA fraction is a parameter, not hardcoded:
//   override it per run with AGNA_FRACTION, or per chain with
//   chains.<id>.poolAgnaFractionBps in config. Fractions apply to the
//   LIVE balances at pool time; for an exact AGNA amount, pass an
//   explicit TOKEN_AMOUNT instead (see below).
//   Only Sepolia has a verified V2 DEX today, so the first pool is
//   Sepolia AGNA/ETH regardless; other chains' pools open once a
//   DEX/router is verified on that chain.
//
// The script first CHECKS whether a pool already exists: if
// factory.getPair(token, quote) returns a pair with non-zero reserves,
// it reports the existing pool and exits WITHOUT creating anything.
// Otherwise it adds liquidity (addLiquidityETH on native-gas chains,
// addLiquidity on ERC-20-quote chains like Arc). The LP tokens go to
// the burner (owner) — removable/withdrawable at any time, never
// locked or burned.
//
// Honest caveat: the pair address is set by the Uniswap V2 factory
// formula (CREATE2 over the sorted token pair) and CANNOT be vanity.
// Only the token, NFT, and deployer addresses carry the 0xa69000
// prefix. The pool is identified by its pair address, not its prefix.
//
// After the pool is created, the script points the token's pair-based
// tax at the new pair with token.setPair(pair) — but ONLY if the
// token's pair is still address(0) (tax not yet active). The 5% tax
// applies only to buys/sells via the pair, so the tax activates here,
// after the initial liquidity add (which is untaxed: the pair was
// address(0) during the add, and the owner/router/contract are
// tax-exempt anyway). If the pair is already set, it is left alone —
// the owner can change it manually with setPair().
//
// The deployer key comes from PRIVATE_KEY in tokens/.env (gitignored)
// or the process environment. NEVER commit a real .env.
//
// Usage (from tokens/):
//   cp .env.example .env   # fill in PRIVATE_KEY — never commit it
//   npm install
//   node script/create-pool.cjs --dry-run        # show what WOULD be done, send nothing
//   node script/create-pool.cjs                  # defaults: gas 40.4%, AGNA 99% of live balances
//   AGNA_FRACTION=0.2475 node script/create-pool.cjs  # quarter-split (old default) — only if a smaller share is wanted
//   GAS_FRACTION=0.5 AGNA_FRACTION=0.99 node script/create-pool.cjs
//   ETH_AMOUNT=0.01 TOKEN_AMOUNT=360000000000000 node script/create-pool.cjs  # explicit amounts (human units)
// Env:
//   PRIVATE_KEY   burner key (required)
//   RPC_URL       overrides the config RPC for the chain
//   CHAIN_ID      default 11155111 (Sepolia)
//   TOKEN         token address (default: deployments/<chainId>-vanity.json)
//   GAS_FRACTION  e.g. 0.404 (default: config token.poolGasFractionBps / 10000)
//   AGNA_FRACTION e.g. 0.99 (default: chain poolAgnaFractionBps, else config token.poolAgnaFractionBps / 10000)
//   ETH_AMOUNT    explicit quote amount (human units) — overrides the gas fraction
//   TOKEN_AMOUNT  explicit AGNA amount (human units) — overrides the AGNA fraction
//   TOKEN_MIN / QUOTE_MIN   slippage floors (default 0 — fine on testnet; set on mainnet)
//   ROUTER / FACTORY / WETH / QUOTE_TOKEN   overrides (used by the Anvil test with mock contracts)
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const TOKENS_DIR = path.resolve(__dirname, "..");
const MAINNET_CHAIN_ID = 1;

const ROUTER_ABI = [
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function WETH() view returns (address)",
  "function factory() view returns (address)",
];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  // TaxToken pair pointer (buys/sells-only tax): the pool script points
  // the tax at the new pair after the pool is created.
  "function pair() view returns (address)",
  "function setPair(address pair_)",
];

// Point the token's pair-based tax at the pair, but ONLY if the tax is
// not active yet (pair == address(0)). Never fails the pool run: if the
// caller is not the token owner (or the call reverts for any reason),
// print a warning with the manual command instead.
async function ensurePairSet(token, pairAddr, dryRun, nonces) {
  const current = await token.pair();
  if (current !== ethers.ZeroAddress) {
    console.log(`  token pair already set to ${current} — leaving it (change manually with token.setPair() if needed)`);
    return;
  }
  if (dryRun) {
    console.log(`  --dry-run: would call token.setPair(${pairAddr}) to activate the buy/sell tax`);
    return;
  }
  console.log(`  activating the buy/sell tax: token.setPair(${pairAddr})...`);
  try {
    const tx = await token.setPair(pairAddr, { nonce: nonces.take() });
    await tx.wait();
    console.log(`  setPair tx ${tx.hash} — the 5% tax now applies to buys/sells via this pair`);
  } catch (e) {
    console.log(`  WARNING: setPair failed (${e.message || e}) — the pool is live but the tax is NOT active.`);
    console.log(`  Activate it manually as the token owner: token.setPair(${pairAddr})`);
  }
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.config = argv[++i];
    else if (a === "--rpc-url") out.rpcUrl = argv[++i];
    else if (a === "--chain-id") out.chainId = Number(argv[++i]);
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function fail(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

function fractionBps(envName, defBps) {
  if (process.env[envName] === undefined) return defBps;
  const bps = Math.round(Number(process.env[envName]) * 10000);
  if (!(bps > 0 && bps <= 10000)) fail(`bad ${envName}: ${process.env[envName]} (want 0 < f <= 1)`);
  return bps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chainId = args.chainId || Number(process.env.CHAIN_ID || "11155111");
  if (chainId === MAINNET_CHAIN_ID) fail("refusing to touch mainnet (chain 1)");
  const configPath = args.config || path.join(TOKENS_DIR, "config", "token-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === "0x...") {
    fail("PRIVATE_KEY is not set — copy tokens/.env.example to tokens/.env and fill in the burner key (never commit it)");
  }
  const rpcUrl = args.rpcUrl || process.env.RPC_URL || (config.chains[String(chainId)] || {}).rpc;
  if (!rpcUrl) fail(`no RPC for chain ${chainId} — pass --rpc-url or set RPC_URL`);
  const chainCfg = config.chains[String(chainId)];
  if (!chainCfg) fail(`chain ${chainId} is not in ${configPath}`);

  const burner = config.wallets.burner;
  const routerAddr = process.env.ROUTER || chainCfg.router;
  const factoryAddr = process.env.FACTORY || chainCfg.factory;
  if (!routerAddr) fail(`chain ${chainId} (${chainCfg.name}) has no verified V2 router in config — no pool can be created here yet`);
  if (!factoryAddr) fail(`chain ${chainId} (${chainCfg.name}) has no V2 factory in config — pass FACTORY=... (Anvil test) or wait for a verified DEX`);
  // Quote asset: the chain's native gas token. Native path when the
  // config has no quoteToken (Sepolia/Robinhood/LitVM: ETH/zkLTC);
  // ERC-20 path when it does (Arc: USDC predeploy).
  const quoteTokenAddr = process.env.QUOTE_TOKEN || chainCfg.quoteToken || ethers.ZeroAddress;
  const nativePath = quoteTokenAddr === ethers.ZeroAddress;
  const wethAddr = process.env.WETH || chainCfg.weth;
  if (nativePath && !wethAddr) fail(`chain ${chainId} (${chainCfg.name}) has no WETH in config (native-gas path needs it)`);

  // Token address: explicit --token, else the vanity deploy receipt.
  let tokenAddr = args.token || process.env.TOKEN;
  if (!tokenAddr) {
    const receiptPath = path.join(TOKENS_DIR, "deployments", `${chainId}-vanity.json`);
    if (!fs.existsSync(receiptPath)) {
      fail(`no --token given and no deploy receipt at ${receiptPath} — deploy the token first (npm run deploy:vanity)`);
    }
    tokenAddr = JSON.parse(fs.readFileSync(receiptPath, "utf8")).token;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(pk, provider);
  const deployer = await signer.getAddress();
  if (deployer.toLowerCase() !== burner.toLowerCase()) {
    fail(`PRIVATE_KEY belongs to ${deployer}, not the burner ${burner} from config — refusing`);
  }
  // Track the nonce locally and pass it explicitly on every send (see
  // nonce-tracker.cjs — ethers' default "pending" nonce is unreliable
  // on Anvil right after a mined tx).
  const { NonceTracker } = require("./nonce-tracker.cjs");
  const nonces = new NonceTracker(provider, deployer);
  await nonces.init();
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== chainId) fail(`RPC chain id is ${net.chainId}, expected ${chainId}`);

  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const decimals = Number(await token.decimals());
  const symbol = await token.symbol();
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const quoteAddr = nativePath ? wethAddr : quoteTokenAddr;
  const quote = nativePath ? null : new ethers.Contract(quoteTokenAddr, ERC20_ABI, signer);
  const quoteSymbol = nativePath ? chainCfg.gasToken || "native" : await quote.symbol();
  const quoteDecimals = nativePath ? 18 : Number(await quote.decimals());

  // --- Live balances + the funding rule ------------------------------------
  // Gas side: GAS_FRACTION of the native-gas balance (native balance on
  // native-gas chains; quote-token balance on ERC-20-quote chains like Arc).
  // AGNA side: AGNA_FRACTION of the live AGNA balance (default 99% of
  // THIS chain's AGNA — each chain mints its own 404T, so each chain's
  // pool takes 99% of that chain's balance after the agent allocation).
  const gasFractionBps = fractionBps("GAS_FRACTION", config.token.poolGasFractionBps ?? 4040);
  const agnaFractionBps = fractionBps(
    "AGNA_FRACTION",
    chainCfg.poolAgnaFractionBps ?? config.token.poolAgnaFractionBps ?? 9900,
  );
  const ethBal = await provider.getBalance(deployer);
  const agnaBal = await token.balanceOf(deployer);
  const quoteBal = nativePath ? ethBal : await quote.balanceOf(deployer);
  const quoteAmount = process.env.ETH_AMOUNT
    ? ethers.parseUnits(process.env.ETH_AMOUNT, quoteDecimals)
    : (quoteBal * BigInt(gasFractionBps)) / 10000n;
  const tokenAmount = process.env.TOKEN_AMOUNT
    ? ethers.parseUnits(process.env.TOKEN_AMOUNT, decimals)
    : (agnaBal * BigInt(agnaFractionBps)) / 10000n;

  console.log(`\n$AGNA pool — chain ${chainCfg.name} (${chainId})`);
  console.log(`  token: ${tokenAddr} (${symbol}, ${decimals} decimals)`);
  console.log(`  quote: ${nativePath ? "native gas (" + quoteSymbol + ") via addLiquidityETH" : quoteSymbol + " (ERC-20 quote) via addLiquidity"} — pair ${symbol}/${quoteSymbol}`);
  console.log(`  burner: ${deployer}`);
  console.log(`  live balances: ${ethers.formatUnits(quoteBal, quoteDecimals)} ${quoteSymbol}, ${ethers.formatUnits(agnaBal, decimals)} ${symbol}`);
  console.log(`  fractions: gas ${gasFractionBps / 100}% of ${quoteSymbol}, AGNA ${agnaFractionBps / 100}% of live ${symbol}${process.env.ETH_AMOUNT || process.env.TOKEN_AMOUNT ? " (explicit amount override in use)" : ""}`);
  console.log(`  -> pool amounts: ${ethers.formatUnits(quoteAmount, quoteDecimals)} ${quoteSymbol} + ${ethers.formatUnits(tokenAmount, decimals)} ${symbol}`);
  if (quoteAmount === 0n || tokenAmount === 0n) fail("computed pool amount is zero — balances too small for these fractions");
  // Leave gas money: the approve + addLiquidity txs must still be payable.
  // (On Arc the native gas IS the quote token, so this also guards the quote reserve.)
  const nativeLeft = nativePath ? ethBal - quoteAmount : ethBal;
  if (nativeLeft < ethers.parseEther("0.005")) {
    fail(`only ${ethers.formatEther(nativeLeft)} native left after the pool — not enough gas reserve (need >= 0.005). Lower the fractions or fund the burner.`);
  }
  console.log(`  native left after pool (gas reserve): ${ethers.formatEther(nativeLeft)}`);

  // --- Does a pool already exist? -----------------------------------------
  const pairAddr = await factory.getPair(tokenAddr, quoteAddr);
  if (pairAddr !== ethers.ZeroAddress) {
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const t0 = await pair.token0();
    const agnaReserve = t0.toLowerCase() === tokenAddr.toLowerCase() ? r0 : r1;
    const quoteReserve = t0.toLowerCase() === tokenAddr.toLowerCase() ? r1 : r0;
    console.log(`\n  pair already exists at ${pairAddr} (set by the V2 factory — NOT a vanity address)`);
    console.log(`  reserves: ${ethers.formatUnits(agnaReserve, decimals)} ${symbol} / ${ethers.formatUnits(quoteReserve, quoteDecimals)} ${quoteSymbol}`);
    if (r0 > 0n && r1 > 0n) {
      console.log("  pool already has liquidity — nothing to create.");
      // The pool exists but the tax may never have been pointed at it
      // (e.g. created before setPair existed). Activate it if unset.
      await ensurePairSet(token, pairAddr, args.dryRun, nonces);
      console.log("  Exiting.");
      return;
    }
    console.log("  pair exists but is empty — adding the initial liquidity below.");
  } else {
    console.log(`\n  no pair exists yet — adding liquidity will create the ${symbol}/${quoteSymbol} pair.`);
  }

  const tokenMin = process.env.TOKEN_MIN ? ethers.parseUnits(process.env.TOKEN_MIN, decimals) : 0n;
  const quoteMin = process.env.QUOTE_MIN ? ethers.parseUnits(process.env.QUOTE_MIN, quoteDecimals) : 0n;
  if (tokenMin === 0n && quoteMin === 0n) {
    console.log("  NOTE: slippage floors are 0 (fine on testnet; set TOKEN_MIN/QUOTE_MIN on mainnet).");
  }
  if (args.dryRun) {
    console.log("\n  --dry-run: no transaction sent. Re-run without --dry-run to create the pool.");
    return;
  }

  // --- Approve + add liquidity (LP tokens to the burner) -----------------
  const deadline = Math.floor(Date.now() / 1000) + 600;
  if (nativePath) {
    const allowance = await token.allowance(deployer, routerAddr);
    if (allowance < tokenAmount) {
      console.log(`\n  approving router to spend ${ethers.formatUnits(tokenAmount, decimals)} ${symbol}...`);
      await (await token.approve(routerAddr, tokenAmount, { nonce: nonces.take() })).wait();
    }
    console.log("  calling router.addLiquidityETH (LP tokens -> burner, withdrawable)...");
    const tx = await router.addLiquidityETH(tokenAddr, tokenAmount, tokenMin, quoteMin, deployer, deadline, { value: quoteAmount, nonce: nonces.take() });
    const receipt = await tx.wait();
    console.log(`  addLiquidity tx ${tx.hash} (gas ${receipt.gasUsed})`);
  } else {
    for (const [c, amt, label] of [[token, tokenAmount, symbol], [quote, quoteAmount, quoteSymbol]]) {
      const allowance = await c.allowance(deployer, routerAddr);
      if (allowance < amt) {
        console.log(`\n  approving router to spend ${ethers.formatUnits(amt, label === symbol ? decimals : quoteDecimals)} ${label}...`);
        await (await c.approve(routerAddr, amt, { nonce: nonces.take() })).wait();
      }
    }
    console.log("  calling router.addLiquidity (LP tokens -> burner, withdrawable)...");
    const tx = await router.addLiquidity(tokenAddr, quoteTokenAddr, tokenAmount, quoteAmount, tokenMin, quoteMin, deployer, deadline, { nonce: nonces.take() });
    const receipt = await tx.wait();
    console.log(`  addLiquidity tx ${tx.hash} (gas ${receipt.gasUsed})`);
  }
  const pairAfter = await factory.getPair(tokenAddr, quoteAddr);
  const pair = new ethers.Contract(pairAfter, PAIR_ABI, provider);
  const lpBal = await pair.balanceOf(deployer);
  const [r0, r1] = await pair.getReserves();
  console.log(`\nDONE. Pool live:`);
  console.log(`  pair: ${pairAfter} (V2 factory address — cannot be vanity)`);
  console.log(`  reserves: ${ethers.formatUnits(r0, decimals)} / ${ethers.formatUnits(r1, quoteDecimals)} (token0/token1 order)`);
  console.log(`  LP tokens in burner wallet: ${ethers.formatEther(lpBal)} (removable/withdrawable any time)`);
  // Point the buy/sell tax at the new pair (only if not set yet).
  await ensurePairSet(token, pairAfter, args.dryRun, nonces);
}

main().catch((e) => fail(e.message || String(e)));
