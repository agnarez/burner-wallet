#!/usr/bin/env node
// e2e-vanity.cjs — end-to-end test of the $AGNA vanity deploy + pool flow on a LOCAL Anvil chain.
//
// Run via: bash script/e2e-vanity.sh  (it starts Anvil, builds, and runs this file).
// Uses ONLY Anvil's well-known throwaway test keys — never a real key, never a live chain.
//
// What it proves:
//   1. deploy-vanity.cjs runs end-to-end from the repo: factory -> AGNA (0xa69000...) ->
//      NameSBT (0xa69000...) deployed BY the token contract, NFT owned by the burner.
//   2. On-chain token params match config (AGNAmuse / AGNA / 404T / 5% tax).
//   3. The agent allocation (10%) landed in the agent wallet.
//   4. create-pool.cjs computes the 40.4% rule from LIVE balances and calls
//      router.addLiquidityETH with exactly those amounts, LP to the burner.
//   5. A second pool run sees the existing (non-empty) pair and sends nothing.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const TOKENS_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(TOKENS_DIR, "..");
const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const PREFIX = "a69000";

// Anvil's default throwaway accounts (public test keys — local only, never real funds).
// NOTE: the addresses are DERIVED from the keys at runtime (never hardcoded):
// a hardcoded address here once mismatched its key and broke the deploy
// check, so the e2e computes both from the key itself.
const BURNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const BURNER = {
  key: BURNER_KEY,
  address: new ethers.Wallet(BURNER_KEY).address,
};
const AGENT = {
  key: AGENT_KEY,
  address: new ethers.Wallet(AGENT_KEY).address,
};

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function run(cmd, args, env, label) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    console.error(`\n${label} FAILED (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const burner = new ethers.Wallet(BURNER.key, provider);
  console.log("Anvil e2e — $AGNA vanity deploy + pool\n");

  // --- Test config: Anvil chain, burner = account 0, agent = account 1. ---
  const config = JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, "config", "token-config.json"), "utf8"));
  config.chains[String(CHAIN_ID)] = {
    name: "anvil-local",
    deployable: true,
    router: "",
    quoteToken: "",
    rpc: RPC_URL,
  };
  config.wallets.burner = BURNER.address;
  config.wallets.agent = AGENT.address;
  const testConfigPath = "/tmp/agna-e2e-config.json";
  fs.writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

  // --- 1. Run the deploy driver --------------------------------------------
  console.log("[1] running deploy-vanity.cjs against Anvil...");
  run(
    process.execPath,
    ["script/deploy-vanity.cjs", "--config", testConfigPath, "--rpc-url", RPC_URL, "--chain-id", String(CHAIN_ID)],
    { PRIVATE_KEY: BURNER.key },
    "deploy-vanity.cjs",
  );
  console.log("  deploy driver exited 0");
  // Burner-signed calls from this process use explicitly tracked nonces
  // (see nonce-tracker.cjs): ethers' default "pending" nonce is
  // unreliable on Anvil right after a mined tx and already caused
  // NONCE_EXPIRED here twice. The tracker reads the nonce stably once
  // the driver has exited, then increments locally per send.
  const { NonceTracker } = require("./nonce-tracker.cjs");
  const nonces = new NonceTracker(provider, BURNER.address);
  console.log(`  burner nonce after deploy driver: ${await nonces.init()}`);

  const receipt = JSON.parse(
    fs.readFileSync(path.join(TOKENS_DIR, "deployments", `${CHAIN_ID}-vanity.json`), "utf8"),
  );
  console.log(`  factory: ${receipt.factory}`);
  console.log(`  token:   ${receipt.token}`);
  console.log(`  NFT:     ${receipt.nft}`);
  check("token address starts with 0xa69000", receipt.token.toLowerCase().startsWith("0x" + PREFIX), receipt.token);
  check("NFT address starts with 0xa69000", receipt.nft.toLowerCase().startsWith("0x" + PREFIX), receipt.nft);
  check("factory address is NOT vanity (expected — bootstrap)", !receipt.factory.toLowerCase().startsWith("0x" + PREFIX));

  // --- 2. Verify on-chain state ---------------------------------------------
  const taxArtifact = JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, "out", "TaxToken.sol", "TaxToken.json"), "utf8"));
  const sbtArtifact = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "names", "artifacts", "contracts", "NameSBT.sol", "NameSBT.json"), "utf8"));
  const token = new ethers.Contract(receipt.token, taxArtifact.abi, provider);
  const sbt = new ethers.Contract(receipt.nft, sbtArtifact.abi, provider);
  check("token name is AGNAmuse", (await token.name()) === "AGNAmuse");
  check("token symbol is AGNA", (await token.symbol()) === "AGNA");
  check("total supply is 404T", (await token.totalSupply()) === 404000000000000n * 10n ** 18n);
  check("tax is 5%", Number(await token.taxBps()) === 500);
  check("token owner is the burner", (await token.owner()).toLowerCase() === BURNER.address.toLowerCase());
  check("agent got 10% (40.4T)", (await token.balanceOf(AGENT.address)) === 40400000000000n * 10n ** 18n);
  check(
    "burner holds 363.6T after allocation",
    (await token.balanceOf(BURNER.address)) === 363600000000000n * 10n ** 18n,
  );
  check("NFT owner is the burner", (await sbt.owner()).toLowerCase() === BURNER.address.toLowerCase());
  check("NFT name is Burner Names", (await sbt.name()) === "Burner Names");

  // Prove the token contract was the deployer: recompute the NFT init code
  // and check token.predictDeploy() returns the NFT address.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const sbtInitCode = ethers.concat([
    sbtArtifact.bytecode,
    coder.encode(["string", "string", "address"], ["Burner Names", "BNAME", BURNER.address]),
  ]);
  const predictedByToken = await token.predictDeploy(ethers.keccak256(sbtInitCode), receipt.nftSalt);
  check("token.predictDeploy() == NFT address (token was the deployer)", predictedByToken.toLowerCase() === receipt.nft.toLowerCase());
  // And the token itself matches the factory's CREATE2 prediction.
  const factoryArtifact = JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, "out", "Create2Factory.sol", "Create2Factory.json"), "utf8"));
  const factory = new ethers.Contract(receipt.factory, factoryArtifact.abi, provider);
  const tokenInitCode = ethers.concat([
    taxArtifact.bytecode.object,
    coder.encode(
      ["string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "address", "address"],
      [
        "AGNAmuse", "AGNA", 404000000000000n * 10n ** 18n, 500, 4000, 3000, 3000,
        ethers.ZeroAddress, ethers.ZeroAddress, BURNER.address,
      ],
    ),
  ]);
  const predictedByFactory = await factory.predict(ethers.keccak256(tokenInitCode), receipt.tokenSalt);
  check("factory.predict() == token address (factory deployed the token)", predictedByFactory.toLowerCase() === receipt.token.toLowerCase());

  // --- 3. Deploy mock V2 contracts for the pool test -------------------------
  console.log("\n[2] deploying mock V2 (factory/pair/router/WETH) on Anvil...");
  const loadMock = (name) =>
    JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, "out", `${name}.sol`, `${name}.json`), "utf8"));
  const deployMock = async (artifact, args) => {
    const f = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, burner);
    const c = await f.deploy(...args, { nonce: nonces.take() });
    await c.waitForDeployment();
    return c;
  };
  const weth = await deployMock(loadMock("MockERC20"), ["Wrapped Ether", "WETH"]);
  const mockFactory = await deployMock(loadMock("MockV2Factory"), []);
  const mockRouter = await deployMock(loadMock("MockRouter"), [await weth.getAddress(), await mockFactory.getAddress()]);
  // Sort token0/token1 the way real V2 does (lower address first).
  const tokenAddr = receipt.token;
  const wethAddr = await weth.getAddress();
  const [t0, t1] = [tokenAddr, wethAddr].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const mockPair = await deployMock(loadMock("MockV2Pair"), [t0, t1]);
  await (await mockFactory.setPair(await mockPair.getAddress(), { nonce: nonces.take() })).wait();
  console.log(`  WETH ${wethAddr}  factory ${await mockFactory.getAddress()}  router ${await mockRouter.getAddress()}  pair ${await mockPair.getAddress()}`);

  // --- 4. Pool script, native path: gas 40.4%, AGNA 99% (per-chain rule) ---
  console.log("\n[3] running create-pool.cjs, native path (Sepolia-style: gas 40.4%, AGNA 99%)...");
  const ethBefore = await provider.getBalance(BURNER.address);
  const agnaBefore = await token.balanceOf(BURNER.address);
  const expectedEth = (ethBefore * 4040n) / 10000n;
  const expectedAgna = (agnaBefore * 9900n) / 10000n;
  console.log(`  live balances before pool: ${ethers.formatEther(ethBefore)} ETH, ${ethers.formatUnits(agnaBefore, 18)} AGNA`);
  console.log(`  expected pool amounts: ${ethers.formatEther(expectedEth)} ETH + ${ethers.formatUnits(expectedAgna, 18)} AGNA`);
  const poolEnv = {
    PRIVATE_KEY: BURNER.key,
    TOKEN: tokenAddr,
    ROUTER: await mockRouter.getAddress(),
    FACTORY: await mockFactory.getAddress(),
    WETH: wethAddr,
  };
  run(
    process.execPath,
    ["script/create-pool.cjs", "--config", testConfigPath, "--rpc-url", RPC_URL, "--chain-id", String(CHAIN_ID)],
    poolEnv,
    "create-pool.cjs",
  );
  // The pool script sent txs as the burner from its own tracker — re-sync
  // ours before the next send.
  await nonces.resync();
  check("router got the LP call (lastLpTo == burner)", (await mockRouter.lastLpTo()).toLowerCase() === BURNER.address.toLowerCase());
  check("LP ETH amount == 40.4% of live ETH balance", (await mockRouter.lastLpEth()) === expectedEth, `${ethers.formatEther(await mockRouter.lastLpEth())} ETH`);
  check("LP AGNA amount == 99% of live AGNA balance", (await mockRouter.lastLpAmountA()) === expectedAgna, `${ethers.formatUnits(await mockRouter.lastLpAmountA(), 18)} AGNA`);
  check("LP was the ETH path", (await mockRouter.lastLpWasEth()) === true);

  // --- 4b. Pool script, ERC-20 quote path (Arc-style: USDC is the gas token) ---
  console.log("\n[3b] running create-pool.cjs, ERC-20 quote path (Arc-style)...");
  const usdc = await deployMock(loadMock("MockERC20"), ["USD Coin", "USDC"]);
  const usdcAddr = await usdc.getAddress();
  await (await usdc.mint(BURNER.address, ethers.parseUnits("1000000", 18), { nonce: nonces.take() })).wait();
  const [u0, u1] = [tokenAddr, usdcAddr].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const erc20Pair = await deployMock(loadMock("MockV2Pair"), [u0, u1]);
  await (await mockFactory.setPair(await erc20Pair.getAddress(), { nonce: nonces.take() })).wait();
  const quoteBefore = await usdc.balanceOf(BURNER.address);
  const agnaBefore2 = await token.balanceOf(BURNER.address);
  const expectedQuote = (quoteBefore * 4040n) / 10000n;
  const expectedAgna2 = (agnaBefore2 * 9900n) / 10000n;
  console.log(`  live balances before pool: ${ethers.formatUnits(quoteBefore, 18)} USDC, ${ethers.formatUnits(agnaBefore2, 18)} AGNA`);
  console.log(`  expected pool amounts: ${ethers.formatUnits(expectedQuote, 18)} USDC + ${ethers.formatUnits(expectedAgna2, 18)} AGNA`);
  run(
    process.execPath,
    ["script/create-pool.cjs", "--config", testConfigPath, "--rpc-url", RPC_URL, "--chain-id", String(CHAIN_ID)],
    { ...poolEnv, QUOTE_TOKEN: usdcAddr },
    "create-pool.cjs (ERC-20 quote)",
  );
  // The pool script sent txs as the burner from its own tracker — re-sync
  // ours before the next send.
  await nonces.resync();
  check("LP quote token is the USDC mock", (await mockRouter.lastLpTokenB()).toLowerCase() === usdcAddr.toLowerCase());
  check("LP USDC amount == 40.4% of live USDC balance", (await mockRouter.lastLpAmountB()) === expectedQuote, `${ethers.formatUnits(await mockRouter.lastLpAmountB(), 18)} USDC`);
  check("LP AGNA amount == 99% of live AGNA balance", (await mockRouter.lastLpAmountA()) === expectedAgna2, `${ethers.formatUnits(await mockRouter.lastLpAmountA(), 18)} AGNA`);
  check("LP was the ERC-20 path (not ETH)", (await mockRouter.lastLpWasEth()) === false);

  // --- 5. Second pool run: existing pair with liquidity -> no-op ---------------
  console.log("\n[4] second pool run with a non-empty pair (must send nothing)...");
  await (await mockFactory.setPair(await mockPair.getAddress(), { nonce: nonces.take() })).wait();
  await (await mockPair.setReserves(ethers.parseUnits("1000", 18), ethers.parseEther("1"), { nonce: nonces.take() })).wait();
  const lpStateBefore = {
    to: await mockRouter.lastLpTo(),
    amountA: await mockRouter.lastLpAmountA(),
    amountB: await mockRouter.lastLpAmountB(),
    eth: await mockRouter.lastLpEth(),
    wasEth: await mockRouter.lastLpWasEth(),
  };
  const out = run(
    process.execPath,
    ["script/create-pool.cjs", "--config", testConfigPath, "--rpc-url", RPC_URL, "--chain-id", String(CHAIN_ID)],
    poolEnv,
    "create-pool.cjs (2nd run)",
  );
  check("second run reports the existing pool", out.includes("already has liquidity"));
  const lpStateAfter = {
    to: await mockRouter.lastLpTo(),
    amountA: await mockRouter.lastLpAmountA(),
    amountB: await mockRouter.lastLpAmountB(),
    eth: await mockRouter.lastLpEth(),
    wasEth: await mockRouter.lastLpWasEth(),
  };
  check(
    "router state unchanged (no second LP call)",
    lpStateAfter.to === lpStateBefore.to && lpStateAfter.amountA === lpStateBefore.amountA
      && lpStateAfter.amountB === lpStateBefore.amountB && lpStateAfter.eth === lpStateBefore.eth
      && lpStateAfter.wasEth === lpStateBefore.wasEth,
  );

  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nE2E FATAL: ${e.message || e}`);
  process.exit(1);
});
