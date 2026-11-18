import { network } from "hardhat";

// Deploys NameSBT.
// Default network is Arc Testnet (see hardhat.config.js) — the only chain
// where BOTH wallets hold gas right now (USDC is Arc's gas token).
// Sepolia is also deployable: the burner holds 0.05 ETH there (funded
// 2026-11-18); the agent wallet holds 0 ETH on Sepolia so it can only
// receive names via mintTo. Base Sepolia still has 0 ETH in both wallets,
// so a deploy there will fail on gas until ETH is obtained (see README.md).
//
// Env:
//   BURNER_PRIVATE_KEY    signer (burner wallet). Required on live networks.
//   NAME                  optional: name to mint to the deployer, e.g. agnarez.arc
//   AGENT_NAME            optional: name to mint to the agent wallet
//   AGENT_WALLET_ADDRESS  the Circle agent wallet (holder only — it never signs)
//                         default: 0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7
//
// Usage:
//   npm run deploy:arc
//   NAME=agnarez.arc AGENT_NAME=agent.arc npm run deploy:arc
//   npm run deploy:sepolia   (needs Sepolia ETH gas — see README)

const { ethers } = await network.getOrCreate();

const signers = await ethers.getSigners();
if (signers.length === 0) {
  throw new Error(
    "No signer configured. Set BURNER_PRIVATE_KEY in names/.env " +
      "(copy names/.env.example first). Never commit the real .env.",
  );
}
const [deployer] = signers;
const chain = await ethers.provider.getNetwork();

console.log(`Network:   ${network.name} (chain ${chain.chainId})`);
console.log(`Deployer:  ${deployer.address} (burner wallet)`);
console.log(
  `Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} native`,
);

const sbt = await ethers.deployContract("NameSBT", ["Burner Names", "BNAME"]);
await sbt.waitForDeployment();
const address = await sbt.getAddress();
console.log(`NameSBT deployed at: ${address}`);
console.log("Save this address as NAME_SBT_ADDRESS in names/.env");

if (process.env.NAME) {
  const tx = await sbt.mint(process.env.NAME);
  const receipt = await tx.wait();
  console.log(
    `Minted "${process.env.NAME}" to deployer (tx ${receipt.hash})`,
  );
}

const agentAddress =
  process.env.AGENT_WALLET_ADDRESS ??
  "0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7";
if (process.env.AGENT_NAME) {
  const tx = await sbt.mintTo(agentAddress, process.env.AGENT_NAME);
  const receipt = await tx.wait();
  console.log(
    `Minted "${process.env.AGENT_NAME}" to agent wallet ${agentAddress} (tx ${receipt.hash})`,
  );
}

console.log("Done.");
