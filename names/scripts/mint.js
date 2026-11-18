import { network } from "hardhat";

// Mints a name on an ALREADY-DEPLOYED NameSBT contract.
// Env:
//   NAME_SBT_ADDRESS    deployed contract address (required)
//   BURNER_PRIVATE_KEY  signer (burner wallet). Required on live networks.
//   NAME                name to mint, e.g. agnarez.arc (required unless MINT_TO used)
//   MINT_TO             optional: mint the name to this address instead of
//                       the deployer (owner-only; used for the agent wallet)
//   AGENT_WALLET_ADDRESS default recipient when MINT_TO=agent
//
// Usage:
//   NAME_SBT_ADDRESS=0x... NAME=agnarez.arc npm run mint -- --network arcTestnet
//   NAME_SBT_ADDRESS=0x... NAME=agent.arc MINT_TO=agent npm run mint -- --network arcTestnet

const { ethers } = await network.getOrCreate();

const contractAddress = process.env.NAME_SBT_ADDRESS;
if (!contractAddress) {
  throw new Error(
    "Set NAME_SBT_ADDRESS in names/.env to the deployed NameSBT address.",
  );
}
const name = process.env.NAME;
if (!name) {
  throw new Error("Set NAME in the environment, e.g. NAME=agnarez.arc");
}

const signers = await ethers.getSigners();
if (signers.length === 0) {
  throw new Error(
    "No signer configured. Set BURNER_PRIVATE_KEY in names/.env " +
      "(copy names/.env.example first). Never commit the real .env.",
  );
}
const [deployer] = signers;
const chain = await ethers.provider.getNetwork();

const sbt = await ethers.getContractAt("NameSBT", contractAddress);
console.log(`Network:   ${network.name} (chain ${chain.chainId})`);
console.log(`Contract:  ${contractAddress}`);
console.log(`Signer:    ${deployer.address} (burner wallet)`);

if (await sbt.isNameTaken(name)) {
  const owner = await sbt.resolveName(name);
  throw new Error(`Name "${name}" is already taken by ${owner}.`);
}

let tx;
if (process.env.MINT_TO === "agent") {
  const agentAddress =
    process.env.AGENT_WALLET_ADDRESS ??
    "0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7";
  tx = await sbt.mintTo(agentAddress, name);
  console.log(`Minting "${name}" to agent wallet ${agentAddress} ...`);
} else if (process.env.MINT_TO) {
  tx = await sbt.mintTo(process.env.MINT_TO, name);
  console.log(`Minting "${name}" to ${process.env.MINT_TO} ...`);
} else {
  tx = await sbt.mint(name);
  console.log(`Minting "${name}" to deployer ...`);
}
const receipt = await tx.wait();
console.log(`Minted (tx ${receipt.hash})`);
console.log(`Owner of "${name}": ${await sbt.resolveName(name)}`);
