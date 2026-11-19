#!/usr/bin/env node
// deploy-dex-base.cjs — deploy the AGNAmuse Factory (official Uniswap
// contracts, burner-owned) on Base Sepolia (84532): V2 + V3 + V4.
//
// Why our own factories: there is NO canonical Uniswap V2/V3 on Base
// Sepolia (verified live 2026-11-20 — official V2 deployments page lists
// no Base Sepolia entry; Base mainnet V2 factory has NO code here and its
// router's factory()/WETH() calls revert; canonical V3 factory has NO
// code). Same path as Arc / Robinhood / LitVM. Permit2 canonical
// 0x000000000022D473030F116dDEE9F6B43aC78BA3 IS already deployed here and
// is reused for V4 (not redeployed).
//
// Artifacts: official @uniswap/v2-core, v2-periphery, v3-core,
// v3-periphery, v4-core, v4-periphery, universal-router npm packages
// (installed in tokens/node_modules, declared in tokens/package.json).
//
// Key: read from the stored burner backup at runtime only. NEVER log it.
// Usage (from tokens/):
//   node script/deploy-dex-base.cjs
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { NonceTracker } = require("./nonce-tracker.cjs");

const TOKENS_DIR = path.resolve(__dirname, "..");
const BURNER = "0x6F311641923246e7f4fE2F1F679c75f4DE107621";
const TOKEN = "0xa69000FF81232ac079eC2265fD4da3100F243fc3";
const BASE_RPC = "https://sepolia.base.org";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CHAIN_ID = 84532;
const NATIVE_LABEL = ethers.encodeBytes32String("WETH");
const V4_UNSUBSCRIBE_GAS_LIMIT = 300000;

function fail(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

function loadKey() {
  const p = path.join(process.env.HOME, "workspace/user/files/burner_wallet_backup__JSON__0_mnno.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j.chains.ethereum_evm.privateKey;
}

function loadArtifact(rel) {
  return JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, "node_modules", rel), "utf8"));
}

function creationBytecode(artifact) {
  // hardhat-style artifacts: bytecode is an object { object, linkReferences }
  // forge-style (v4-core out/): bytecode is { object, linkReferences }
  // v2-core build jsons: bytecode is a plain hex string.
  // NOTE: v2-core build jsons store the hex WITHOUT a 0x prefix —
  // ethers' ContractFactory tolerates that, but keccak256() does not,
  // so always normalize to a 0x-prefixed string here.
  let bc;
  if (typeof artifact.bytecode === "string") bc = artifact.bytecode;
  else if (artifact.bytecode && typeof artifact.bytecode.object === "string") bc = artifact.bytecode.object;
  else if (artifact.bytecode && typeof artifact.bytecode === "object" && artifact.bytecode.object) bc = artifact.bytecode.object;
  else fail(`cannot find creation bytecode in artifact`);
  return bc.startsWith("0x") ? bc : "0x" + bc;
}

function linkLibraries(bytecode, artifact, libs) {
  // Replace __$hash$__ placeholders using the artifact's linkReferences.
  // Hardhat artifacts carry linkReferences at the TOP level
  // (artifact.linkReferences); forge out/ artifacts nest it under
  // bytecode.linkReferences. Check both.
  let out = bytecode;
  const refs = artifact.linkReferences || (artifact.bytecode && artifact.bytecode.linkReferences) || {};
  for (const [file, contracts] of Object.entries(refs)) {
    for (const [name, positions] of Object.entries(contracts)) {
      const addr = libs[name] || libs[`${file}:${name}`];
      if (!addr) fail(`no library address supplied for ${file}:${name}`);
      for (const { start, length } of positions) {
        const placeholder = out.slice(start * 2 + 2, (start + length) * 2 + 2);
        if (!placeholder.startsWith("__$") || !placeholder.endsWith("$__")) {
          fail(`unexpected link placeholder for ${name}: ${placeholder}`);
        }
        out = out.slice(0, start * 2 + 2) + addr.toLowerCase().replace(/^0x/, "") + out.slice((start + length) * 2 + 2);
      }
    }
  }
  if (out.includes("__$")) fail("bytecode still contains an unlinked library placeholder after linking");
  return out;
}

async function deploy(signer, nonces, artifact, args, label, libraries) {
  let bytecode = creationBytecode(artifact);
  if (libraries) bytecode = linkLibraries(bytecode, artifact, libraries);
  const factory = new ethers.ContractFactory(artifact.abi, bytecode, signer);
  const contract = await factory.deploy(...args, { nonce: nonces.take() });
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const rc = await contract.deploymentTransaction().wait();
  console.log(`  ${label}: ${addr} (tx ${rc.hash}, gas ${rc.gasUsed})`);
  const code = await signer.provider.getCode(addr);
  if (code === "0x") fail(`${label} deployed to ${addr} but has no code`);
  return { address: addr, tx: rc.hash, contract };
}

async function maybeDeploy(signer, nonces, artifact, args, label, libraries, existing) {
  // Resume support: if this contract was already deployed in a previous
  // (partially failed) run, reuse it instead of deploying a second copy.
  if (existing && existing.address) {
    const code = await signer.provider.getCode(existing.address);
    if (code === "0x") fail(`resumed ${label} at ${existing.address} has no code — refusing`);
    console.log(`  ${label}: ${existing.address} (already deployed, tx ${existing.tx} — reusing)`);
    return { address: existing.address, tx: existing.tx, contract: new ethers.Contract(existing.address, artifact.abi, signer) };
  }
  return deploy(signer, nonces, artifact, args, label, libraries);
}

async function main() {
  const pk = loadKey();
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new ethers.Wallet(pk, provider);
  const me = await signer.getAddress();
  if (me.toLowerCase() !== BURNER.toLowerCase()) fail("key is not the burner");
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) fail(`RPC chain id is ${net.chainId}, expected ${CHAIN_ID}`);
  const bal = await provider.getBalance(me);
  console.log(`\nAGNAmuse Factory deploy — Base Sepolia (${CHAIN_ID})`);
  console.log(`  deployer (burner): ${me}  balance ${ethers.formatEther(bal)} ETH`);
  const permit2Code = await provider.getCode(PERMIT2);
  if (permit2Code === "0x") fail(`canonical Permit2 ${PERMIT2} has no code — refusing (V4 needs it)`);
  console.log(`  canonical Permit2 present (${(permit2Code.length - 2) / 2} bytes) — reusing, not redeploying`);

  const nonces = new NonceTracker(provider, me);
  await nonces.init();
  const outPath = path.join(TOKENS_DIR, "deployments", `${CHAIN_ID}-dex.json`);
  const saveOut = () => fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  // Resume: a previous partial run may have written this file already.
  let out = {
    brand: "AGNAmuse Factory",
    chain: "Base Sepolia",
    chainId: CHAIN_ID,
    token: TOKEN,
    tokenOwner: BURNER,
    v2: {},
    v3: {},
    v4: { permit2: PERMIT2, permit2Note: "canonical Permit2, already deployed on this chain (not deployed by us)", unsubscribeGasLimit: V4_UNSUBSCRIBE_GAS_LIMIT },
  };
  if (fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
    out = { ...out, ...prev, v2: { ...out.v2, ...(prev.v2 || {}) }, v3: { ...out.v3, ...(prev.v3 || {}) }, v4: { ...out.v4, ...(prev.v4 || {}) } };
    console.log("  resuming from partial deployments/84532-dex.json (already-deployed contracts will be reused)");
  }

  // --- V2 ---------------------------------------------------------------
  console.log("\n[V2] WETH9 + factory + router (official @uniswap/v2-core + v2-periphery)...");
  const wethA = loadArtifact("@uniswap/v2-periphery/build/WETH9.json");
  const v2fA = loadArtifact("@uniswap/v2-core/build/UniswapV2Factory.json");
  const v2rA = loadArtifact("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const pairA = loadArtifact("@uniswap/v2-core/build/UniswapV2Pair.json");
  const weth = await maybeDeploy(signer, nonces, wethA, [], "WETH9", null, out.v2.weth9 ? { address: out.v2.weth9, tx: out.v2.weth9Tx } : null);
  const v2f = await maybeDeploy(signer, nonces, v2fA, [BURNER], "UniswapV2Factory (feeToSetter=burner)", null, out.v2.factory ? { address: out.v2.factory, tx: out.v2.factoryTx } : null);
  const v2r = await maybeDeploy(signer, nonces, v2rA, [v2f.address, weth.address], "UniswapV2Router02", null, out.v2.router ? { address: out.v2.router, tx: out.v2.routerTx } : null);
  out.v2 = {
    weth9: weth.address, weth9Tx: weth.tx,
    factory: v2f.address, factoryTx: v2f.tx,
    feeToSetter: BURNER,
    router: v2r.address, routerTx: v2r.tx,
    verified: true,
  };
  // Verify the wiring on-chain.
  const fts = await v2f.contract.feeToSetter();
  const rf = await v2r.contract.factory();
  const rw = await v2r.contract.WETH();
  if (fts.toLowerCase() !== BURNER.toLowerCase()) fail(`V2 factory feeToSetter is ${fts}, expected burner`);
  if (rf.toLowerCase() !== v2f.address.toLowerCase()) fail(`V2 router factory() is ${rf}, expected ${v2f.address}`);
  if (rw.toLowerCase() !== weth.address.toLowerCase()) fail(`V2 router WETH() is ${rw}, expected ${weth.address}`);
  console.log("  V2 wiring verified: feeToSetter=burner, router.factory()=factory, router.WETH()=WETH9");
  saveOut();

  // --- V3 ---------------------------------------------------------------
  console.log("\n[V3] factory + descriptor + position manager + swap router + quoter (official @uniswap/v3-core + v3-periphery)...");
  const v3fA = loadArtifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const nftDescLibA = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
  const descA = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
  const npmA = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const srA = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
  const quoterA = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json");
  const v3f = await maybeDeploy(signer, nonces, v3fA, [], "UniswapV3Factory", null, out.v3.factory ? { address: out.v3.factory, tx: out.v3.factoryTx } : null);
  const nftDescLib = await maybeDeploy(signer, nonces, nftDescLibA, [], "NFTDescriptor library", null, out.v3.nftDescriptorLib ? { address: out.v3.nftDescriptorLib, tx: out.v3.nftDescriptorLibTx } : null);
  const desc = await maybeDeploy(signer, nonces, descA, [weth.address, NATIVE_LABEL], "NonfungibleTokenPositionDescriptor", { NFTDescriptor: nftDescLib.address }, out.v3.descriptor ? { address: out.v3.descriptor, tx: out.v3.descriptorTx } : null);
  const npm = await maybeDeploy(signer, nonces, npmA, [v3f.address, weth.address, desc.address], "NonfungiblePositionManager", null, out.v3.positionManager ? { address: out.v3.positionManager, tx: out.v3.positionManagerTx } : null);
  const sr = await maybeDeploy(signer, nonces, srA, [v3f.address, weth.address], "SwapRouter", null, out.v3.swapRouter ? { address: out.v3.swapRouter, tx: out.v3.swapRouterTx } : null);
  const quoter = await maybeDeploy(signer, nonces, quoterA, [v3f.address, weth.address], "Quoter", null, out.v3.quoter ? { address: out.v3.quoter, tx: out.v3.quoterTx } : null);
  out.v3 = {
    factory: v3f.address, factoryTx: v3f.tx,
    factoryOwner: BURNER,
    nftDescriptorLib: nftDescLib.address, nftDescriptorLibTx: nftDescLib.tx,
    descriptor: desc.address, descriptorTx: desc.tx,
    positionManager: npm.address, positionManagerTx: npm.tx,
    swapRouter: sr.address, swapRouterTx: sr.tx,
    quoter: quoter.address, quoterTx: quoter.tx,
    verified: true,
  };
  const v3owner = await v3f.contract.owner();
  const npmFactory = await npm.contract.factory();
  if (v3owner.toLowerCase() !== BURNER.toLowerCase()) fail(`V3 factory owner is ${v3owner}, expected burner`);
  if (npmFactory.toLowerCase() !== v3f.address.toLowerCase()) fail(`V3 NPM factory() is ${npmFactory}, expected ${v3f.address}`);
  console.log("  V3 wiring verified: factory owner=burner, NPM.factory()=factory");
  saveOut();

  // --- V4 ---------------------------------------------------------------
  console.log("\n[V4] PoolManager + descriptors + quoter/stateView + UniversalRouter 2.1.0 (official @uniswap/v4-core + v4-periphery + universal-router)...");
  const pmA = loadArtifact("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");
  const posDescA = loadArtifact("@uniswap/v4-periphery/foundry-out/PositionDescriptor.sol/PositionDescriptor.json");
  const posmA = loadArtifact("@uniswap/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json");
  const v4qA = loadArtifact("@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json");
  const svA = loadArtifact("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json");
  const urA = loadArtifact("@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json");
  const pm = await maybeDeploy(signer, nonces, pmA, [BURNER], "PoolManager (initialOwner=burner)", null, out.v4.poolManager ? { address: out.v4.poolManager, tx: out.v4.poolManagerTx } : null);
  const posDesc = await maybeDeploy(signer, nonces, posDescA, [pm.address, weth.address, NATIVE_LABEL], "PositionDescriptor", null, out.v4.positionDescriptor ? { address: out.v4.positionDescriptor, tx: out.v4.positionDescriptorTx } : null);
  const posm = await maybeDeploy(signer, nonces, posmA, [pm.address, PERMIT2, V4_UNSUBSCRIBE_GAS_LIMIT, posDesc.address, weth.address], "PositionManager", null, out.v4.positionManager ? { address: out.v4.positionManager, tx: out.v4.positionManagerTx } : null);
  const v4q = await maybeDeploy(signer, nonces, v4qA, [pm.address], "V4Quoter", null, out.v4.v4Quoter ? { address: out.v4.v4Quoter, tx: out.v4.v4QuoterTx } : null);
  const sv = await maybeDeploy(signer, nonces, svA, [pm.address], "StateView", null, out.v4.stateView ? { address: out.v4.stateView, tx: out.v4.stateViewTx } : null);
  // Init code hashes (same computation as the other chains — from the
  // official artifacts; the pair hash must match the canonical V2 hash).
  const pairInitCodeHash = ethers.keccak256(creationBytecode(pairA));
  const poolA = loadArtifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
  const poolInitCodeHash = ethers.keccak256(creationBytecode(poolA));
  console.log(`  pairInitCodeHash: ${pairInitCodeHash}`);
  console.log(`  poolInitCodeHash: ${poolInitCodeHash}`);
  if (pairInitCodeHash !== "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f") {
    fail(`pair init code hash ${pairInitCodeHash} != canonical V2 hash — artifact mismatch, aborting before UniversalRouter`);
  }
  const urParams = {
    permit2: PERMIT2,
    weth9: weth.address,
    v2Factory: v2f.address,
    v3Factory: v3f.address,
    pairInitCodeHash,
    poolInitCodeHash,
    v4PoolManager: pm.address,
    v3NFTPositionManager: npm.address,
    v4PositionManager: posm.address,
    spokePool: ethers.ZeroAddress,
  };
  const ur = await maybeDeploy(signer, nonces, urA, [urParams], "UniversalRouter 2.1.0", null, out.v4.universalRouter ? { address: out.v4.universalRouter, tx: out.v4.universalRouterTx } : null);
  out.v4.poolManager = pm.address;
  out.v4.poolManagerTx = pm.tx;
  out.v4.poolManagerOwner = BURNER;
  out.v4.positionDescriptor = posDesc.address;
  out.v4.positionDescriptorTx = posDesc.tx;
  out.v4.positionManager = posm.address;
  out.v4.positionManagerTx = posm.tx;
  out.v4.v4Quoter = v4q.address;
  out.v4.v4QuoterTx = v4q.tx;
  out.v4.stateView = sv.address;
  out.v4.stateViewTx = sv.tx;
  out.v4.universalRouter = ur.address;
  out.v4.universalRouterTx = ur.tx;
  out.v4.universalRouterNote = "UniversalRouter 2.1.0, wired to our V2+V3+V4 factories (V4Router is abstract in v4-periphery; UniversalRouter is the deployable V4 router)";
  out.v4.pairInitCodeHash = pairInitCodeHash;
  out.v4.poolInitCodeHash = poolInitCodeHash;
  out.v4.initCodeHashNote = "computed from the official @uniswap/v2-core / v3-core artifacts (same compile as our factories); differs from the mainnet canonical hashes only in the metadata suffix, and the pair hash was verified live: CREATE2(factory, salt, hash) reproduces the live pair address on all three chains";
  out.v4.verified = true;
  const pmOwner = await pm.contract.owner();
  const posmPm = await posm.contract.poolManager();
  if (pmOwner.toLowerCase() !== BURNER.toLowerCase()) fail(`PoolManager owner is ${pmOwner}, expected burner`);
  if (posmPm.toLowerCase() !== pm.address.toLowerCase()) fail(`V4 PositionManager poolManager() is ${posmPm}, expected ${pm.address}`);
  console.log("  V4 wiring verified: PoolManager owner=burner, PositionManager.poolManager()=PoolManager");

  saveOut();
  console.log(`\nDONE. Receipt written to ${outPath}`);
  console.log(`  V2 factory: ${v2f.address}  router: ${v2r.address}  WETH9: ${weth.address}`);
  console.log(`  V3 factory: ${v3f.address}  NPM: ${npm.address}  SwapRouter: ${sr.address}`);
  console.log(`  V4 PoolManager: ${pm.address}  PositionManager: ${posm.address}  UniversalRouter: ${ur.address}`);
  console.log("  next: update config with router/factory/weth, then create the pool (npm run create-pool -- --chain-id 84532)");
}

main().catch((e) => fail(e.message || String(e)));
