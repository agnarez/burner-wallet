#!/usr/bin/env node
// deploy-vanity.cjs — deploys $AGNA (AGNAmuse) at a vanity address on a testnet.
//
// Flow (all on the target chain, in one run, from the burner wallet):
//   1. Read the burner nonce, compute the CREATE address the factory
//      WILL have (the factory is deployed by plain CREATE, so its own
//      address cannot be vanity — see tokens/README.md).
//   2. Mine the token salt for (factory address, TaxToken init code)
//      so the token deploys at 0xa69000... (C miner, Node fallback).
//   3. Deploy the Create2Factory, re-checking the nonce first — if the
//      burner sent any other transaction since step 1, abort: the
//      mined salt would be for the wrong factory address.
//   4. Deploy AGNA via factory.deploy(initCode, salt); verify the
//      0xa69000 prefix and the on-chain token params on the spot.
//   5. Mine the NFT salt for (token address, NameSBT init code with
//      the burner as explicit owner) and deploy the registry via
//      token.deploy(initCode, salt) — the TOKEN contract is the
//      deployer. Verify the prefix, the owner, and that
//      token.predictDeploy() matches the deployed address.
//   6. Transfer the agent allocation (10%) to the Circle agent wallet —
//      but ONLY on chains where that wallet exists (Sepolia/Arc/Base
//      Sepolia, chains.<id>.agentWallet). On Robinhood/LitVM the agent
//      wallet does not exist, so the allocation STAYS with the burner:
//      never send tokens to an address nobody controls on that chain.
//      AGENT_ADDRESS env overrides (used by the Anvil e2e test).
//   7. Write deployments/<chainId>-vanity.json (receipt).
//
// The deployer key comes from PRIVATE_KEY in tokens/.env (gitignored)
// or the process environment. It MUST be the burner wallet's key
// (checked against config). NEVER commit a real .env. The live deploy
// is run by a human, not by an agent, after the local Anvil test passes.
//
// Usage (from tokens/):
//   cp .env.example .env   # fill in PRIVATE_KEY — never commit it
//   npm install            # ethers + dotenv
//   npm run deploy:vanity  # defaults: Sepolia (11155111), config/token-config.json
//   CHAIN_ID=5042002 node script/deploy-vanity.cjs   # another chain
//   node script/deploy-vanity.cjs --config /tmp/test-config.json --rpc-url http://127.0.0.1:8545 --chain-id 31337
// Env:
//   PRIVATE_KEY   burner deployer key (required)
//   RPC_URL       overrides the config RPC for the chain
//   CHAIN_ID      default 11155111 (Sepolia)
//   NFT_NAME      NameSBT collection name (default "Burner Names")
//   NFT_SYMBOL    NameSBT collection symbol (default "BNAME")
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { NonceTracker } = require("./nonce-tracker.cjs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const TOKENS_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(TOKENS_DIR, "..");
const PREFIX = "a69000"; // vanity prefix, lowercase compare
const MAINNET_CHAIN_ID = 1;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.config = argv[++i];
    else if (a === "--rpc-url") out.rpcUrl = argv[++i];
    else if (a === "--chain-id") out.chainId = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function fail(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

function loadArtifact(relPath) {
  const p = path.join(REPO_DIR, relPath);
  if (!fs.existsSync(p)) {
    fail(
      `missing artifact ${relPath} — run 'forge build' in tokens/ and 'npx hardhat compile' in names/ first`,
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Mine a CREATE2 salt. Prefers the native C miner, falls back to Node. */
function mineSalt(deployer, initCodeHash, label) {
  const cBin = path.join(__dirname, "vanity-miner");
  const cSrc = path.join(__dirname, "vanity-miner.c");
  let cmd = null;
  let args = [];
  if (fs.existsSync(cBin)) {
    cmd = cBin;
  } else {
    const gcc = spawnSync("which", ["gcc"], { encoding: "utf8" });
    if (gcc.status === 0) {
      console.log("  compiling the C vanity miner (one-time)...");
      try {
        execFileSync("gcc", ["-O3", "-march=native", "-pthread", "-o", cBin, cSrc], { stdio: "inherit" });
        cmd = cBin;
      } catch {
        console.log("  gcc build failed — falling back to the Node miner (slower)");
      }
    } else {
      console.log("  no C miner binary and no gcc — falling back to the Node miner (slower)");
    }
  }
  if (!cmd) {
    cmd = process.execPath;
    args = [path.join(__dirname, "vanity-miner.mjs")];
  }
  args.push("--deployer", deployer, "--init-code-hash", initCodeHash, "--prefix", PREFIX, "--threads", "4");
  console.log(`  mining ${label} salt (prefix 0x${PREFIX}) with ${cmd === cBin ? "C miner" : "Node miner"}...`);
  const t0 = Date.now();
  let out;
  try {
    // stderr streams live so the miner's progress is visible.
    out = execFileSync(cmd, args, { encoding: "utf8", timeout: 30 * 60 * 1000, stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    fail(`salt mining failed for ${label}: ${e.message}`);
  }
  const m = out.match(/SALT=(0x[0-9a-fA-F]+)\s+ADDRESS=(0x[0-9a-fA-F]+)\s+TRIES=(\d+)\s+ELAPSED_S=([\d.]+)\s+RATE=([\d.]+)/);
  if (!m) fail(`could not parse miner output for ${label}: ${out}`);
  const [, salt, address, tries, elapsed, rate] = m;
  if (!address.toLowerCase().startsWith("0x" + PREFIX)) {
    fail(`miner returned a non-vanity address for ${label}: ${address}`);
  }
  console.log(`  ${label}: salt ${salt} -> ${address} (${tries} tries, ${elapsed}s, ${rate} hashes/s)`);
  return { salt, address };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chainId = args.chainId || Number(process.env.CHAIN_ID || "11155111");
  if (chainId === MAINNET_CHAIN_ID) fail("refusing to deploy on mainnet (chain 1)");
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
  if (chainCfg.deployable === false) fail(`chain ${chainId} (${chainCfg.name}) is not deployable — no gas funded (see config)`);

  const t = config.token;
  const burner = config.wallets.burner;
  // Per-chain agent wallet. A chain with agentWallet: null (Robinhood,
  // LitVM) has no usable Circle agent wallet, so the 10% allocation
  // stays with the burner. A chain with no agentWallet entry falls back
  // to the global agent address. AGENT_ADDRESS env wins (Anvil e2e).
  const agent = process.env.AGENT_ADDRESS
    || (chainCfg && "agentWallet" in chainCfg ? chainCfg.agentWallet : config.wallets.agent)
    || null;
  const router = chainCfg.router ? chainCfg.router : ethers.ZeroAddress;
  const quoteToken = chainCfg.quoteToken ? chainCfg.quoteToken : ethers.ZeroAddress;
  const decimals = Number(t.decimals);
  const initialSupply = BigInt(t.initialSupplyTokens) * 10n ** BigInt(decimals);
  const nftName = process.env.NFT_NAME || "Burner Names";
  const nftSymbol = process.env.NFT_SYMBOL || "BNAME";

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(pk, provider);
  const deployer = await signer.getAddress();
  if (deployer.toLowerCase() !== burner.toLowerCase()) {
    fail(`PRIVATE_KEY belongs to ${deployer}, not the burner ${burner} from config — refusing to deploy`);
  }
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== chainId) {
    fail(`RPC chain id is ${net.chainId}, expected ${chainId}`);
  }
  const balance = await provider.getBalance(deployer);
  console.log(`\n$AGNA vanity deploy — chain ${chainCfg.name} (${chainId})`);
  console.log(`  deployer (burner): ${deployer}  balance ${ethers.formatEther(balance)} native`);
  console.log(`  token: ${t.name} (${t.symbol}), supply ${t.initialSupplyTokens} x 10^${decimals}, tax ${t.taxBps} bps`);
  console.log(`  router: ${router}  quote: ${quoteToken}`);

  // --- Artifacts + init codes -------------------------------------------
  const taxArtifact = loadArtifact("tokens/out/TaxToken.sol/TaxToken.json");
  const factoryArtifact = loadArtifact("tokens/out/Create2Factory.sol/Create2Factory.json");
  const sbtArtifact = loadArtifact("names/artifacts/contracts/NameSBT.sol/NameSBT.json");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const tokenInitCode = ethers.concat([
    taxArtifact.bytecode.object,
    coder.encode(
      ["string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "address", "address"],
      [t.name, t.symbol, initialSupply, t.taxBps, t.burnShareBps, t.buybackShareBps, t.liquidityShareBps, router, quoteToken, deployer],
    ),
  ]);
  const tokenInitCodeHash = ethers.keccak256(tokenInitCode);
  const sbtInitCode = ethers.concat([
    sbtArtifact.bytecode,
    coder.encode(["string", "string", "address"], [nftName, nftSymbol, deployer]),
  ]);
  const sbtInitCodeHash = ethers.keccak256(sbtInitCode);

  // --- Step 1: factory address from the live nonce ----------------------
  // The nonce is read once, stably, and then tracked locally: every tx
  // below passes its nonce explicitly (see nonce-tracker.cjs — ethers'
  // default "pending" nonce is unreliable on Anvil right after a mined
  // tx and has already caused NONCE_EXPIRED here).
  const nonces = new NonceTracker(provider, deployer);
  let nonce = await nonces.init();
  const factoryAddress = ethers.getCreateAddress({ from: deployer, nonce });
  console.log(`\n[1/6] burner nonce is ${nonce}; factory WILL deploy at ${factoryAddress}`);
  console.log("      (factory address is CREATE-derived, so it cannot be vanity — only token + NFT carry the prefix)");

  // --- Step 2: mine the token salt --------------------------------------
  console.log("[2/6] mining token salt...");
  const tokenSalt = mineSalt(factoryAddress, tokenInitCodeHash, "token");
  // Cross-check with ethers before spending gas.
  const predictedToken = ethers.getCreate2Address(factoryAddress, tokenSalt.salt, tokenInitCodeHash);
  if (predictedToken.toLowerCase() !== tokenSalt.address.toLowerCase()) {
    fail(`miner/ethers disagree on the token address: ${tokenSalt.address} vs ${predictedToken}`);
  }

  // --- Step 3: deploy the factory (nonce must not have moved) -----------
  console.log("[3/6] deploying Create2Factory...");
  const nonceNow = await nonces.stableRead();
  if (nonceNow !== nonce) {
    fail(`burner nonce moved ${nonce} -> ${nonceNow} while mining (another transaction used this key?) — aborting, re-run to mine against the fresh nonce`);
  }
  const factoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object, signer);
  const factory = await factoryFactory.deploy({ nonce: nonces.take() });
  await factory.waitForDeployment();
  const factoryDeployed = await factory.getAddress();
  if (factoryDeployed.toLowerCase() !== factoryAddress.toLowerCase()) {
    fail(`factory landed at ${factoryDeployed}, expected ${factoryAddress} — nonce moved mid-flight, aborting`);
  }
  console.log(`  factory deployed at ${factoryDeployed}`);

  // --- Step 4: deploy AGNA via the factory ------------------------------
  console.log("[4/6] deploying AGNA via factory CREATE2...");
  const factoryContract = new ethers.Contract(factoryDeployed, factoryArtifact.abi, signer);
  let tx = await factoryContract.deploy(tokenInitCode, tokenSalt.salt, { nonce: nonces.take() });
  let receipt = await tx.wait();
  console.log(`  token deploy tx ${receipt.hash} (gas ${receipt.gasUsed})`);
  if (predictedToken.toLowerCase().startsWith("0x" + PREFIX) === false) {
    fail(`token address ${predictedToken} does not start with 0x${PREFIX}`);
  }
  const code = await provider.getCode(predictedToken);
  if (code === "0x") fail(`no code at the predicted token address ${predictedToken}`);
  const token = new ethers.Contract(predictedToken, taxArtifact.abi, signer);
  const onChain = {
    name: await token.name(),
    symbol: await token.symbol(),
    totalSupply: await token.totalSupply(),
    taxBps: await token.taxBps(),
    owner: await token.owner(),
  };
  if (onChain.name !== t.name || onChain.symbol !== t.symbol) fail(`on-chain name/symbol mismatch: ${onChain.name}/${onChain.symbol}`);
  if (onChain.totalSupply !== initialSupply) fail(`on-chain supply mismatch: ${onChain.totalSupply}`);
  if (Number(onChain.taxBps) !== Number(t.taxBps)) fail(`on-chain tax mismatch: ${onChain.taxBps}`);
  if (onChain.owner.toLowerCase() !== deployer.toLowerCase()) fail(`on-chain owner mismatch: ${onChain.owner}`);
  console.log(`  AGNA deployed at ${predictedToken} — name/symbol/supply/tax/owner all verified on-chain`);

  // --- Step 5: deploy the NameSBT via the token contract ----------------
  console.log("[5/6] mining NFT salt (deployer = token contract)...");
  const nftSalt = mineSalt(predictedToken, sbtInitCodeHash, "NFT");
  const predictedNft = ethers.getCreate2Address(predictedToken, nftSalt.salt, sbtInitCodeHash);
  if (predictedNft.toLowerCase() !== nftSalt.address.toLowerCase()) {
    fail(`miner/ethers disagree on the NFT address: ${nftSalt.address} vs ${predictedNft}`);
  }
  const predictedByToken = await token.predictDeploy(sbtInitCodeHash, nftSalt.salt);
  if (predictedByToken.toLowerCase() !== predictedNft.toLowerCase()) {
    fail(`token.predictDeploy() disagrees: ${predictedByToken} vs ${predictedNft}`);
  }
  console.log(`  token.predictDeploy() agrees: ${predictedNft}`);
  tx = await token.deploy(sbtInitCode, nftSalt.salt, { nonce: nonces.take() });
  receipt = await tx.wait();
  console.log(`  NFT deploy tx ${receipt.hash} (gas ${receipt.gasUsed})`);
  const nftCode = await provider.getCode(predictedNft);
  if (nftCode === "0x") fail(`no code at the predicted NFT address ${predictedNft}`);
  const sbt = new ethers.Contract(predictedNft, sbtArtifact.abi, signer);
  const nftOwner = await sbt.owner();
  if (nftOwner.toLowerCase() !== deployer.toLowerCase()) {
    fail(`NFT owner is ${nftOwner}, expected the burner ${deployer}`);
  }
  console.log(`  NameSBT deployed at ${predictedNft} — prefix OK, owner is the burner (token contract was the deployer)`);

  // --- Step 6: agent allocation ------------------------------------------
  // 10% of the supply goes to the agent wallet — but only where that
  // wallet exists on this chain. On Robinhood/LitVM it does not, so the
  // allocation stays with the burner instead of being stranded at an
  // address nobody controls there.
  let allocation = (initialSupply * BigInt(t.agentAllocationBps)) / 10000n;
  if (allocation > 0n && agent) {
    console.log(`[6/6] transferring agent allocation (${ethers.formatUnits(allocation, decimals)} ${t.symbol}) to ${agent}...`);
    tx = await token.transfer(agent, allocation, { nonce: nonces.take() });
    receipt = await tx.wait();
    console.log(`  allocation tx ${receipt.hash}`);
    const agentBal = await token.balanceOf(agent);
    if (agentBal !== allocation) fail(`agent balance mismatch: ${agentBal}`);
  } else if (allocation > 0n) {
    console.log(`[6/6] no agent wallet on ${chainCfg.name} — the 10% agent allocation stays with the burner (never sent to an address nobody controls on this chain)`);
    allocation = 0n;
  } else {
    console.log("[6/6] agent allocation is 0 — skipping");
  }

  // --- Receipt ------------------------------------------------------------
  const receiptJson = {
    chainId,
    chain: chainCfg.name,
    factory: factoryDeployed,
    token: predictedToken,
    nft: predictedNft,
    name: t.name,
    symbol: t.symbol,
    deployer,
    agent,
    agentAllocation: allocation.toString(),
    router,
    quoteToken,
    tokenSalt: tokenSalt.salt,
    nftSalt: nftSalt.salt,
  };
  const outDir = path.join(TOKENS_DIR, "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${chainId}-vanity.json`);
  fs.writeFileSync(outPath, JSON.stringify(receiptJson, null, 2) + "\n");
  console.log(`\nDONE. Receipt written to ${outPath}`);
  console.log(`  factory: ${factoryDeployed} (NOT vanity — bootstrap, see README)`);
  console.log(`  token:   ${predictedToken}`);
  console.log(`  NFT:     ${predictedNft}`);
  console.log(`  next: create the pool with: npm run create-pool  (40.4% rule, see tokens/README.md)`);
}

main().catch((e) => fail(e.message || String(e)));
