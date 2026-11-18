// Finish the Sepolia $AGNA deploy: the token is live (step 4 done), but the
// NFT deploy (step 5) needs ~27.3M gas — more than the 20M limit used in the
// retry. This script does steps 5-6 only: NFT via token.deploy() with a
// 28M gas limit, then the 10% agent allocation, then writes the receipt.
// Re-mines the NFT salt (deterministic — same salt/address as the retry).
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { NonceTracker } = require('./script/nonce-tracker.cjs');

const CHAIN_ID = 11155111;
const TOKEN = '0xA69000408A00F35F70C5dD5f73e8c687514BF522';
const FACTORY = '0x5923e3B758c1029830beE4731Cce2C9da94D70ed';
const TOKEN_SALT = '0x0000000000000000000000000000000000000000000000000000000000340de3';
const PREFIX = 'a69000';
const GAS_LIMIT = 28000000n;

const fail = (m) => { console.error('ABORT:', m); process.exit(1); };

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'token-config.json'), 'utf8'));
  const t = cfg.token;
  const chainCfg = cfg.chains[String(CHAIN_ID)];
  const pk = process.env.PRIVATE_KEY;
  if (!pk) fail('no PRIVATE_KEY in .env');
  const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
  const signer = new ethers.Wallet(pk, provider);
  const deployer = await signer.getAddress();
  const burner = '0x6F311641923246e7f4fE2F1F679c75f4DE107621';
  if (deployer.toLowerCase() !== burner.toLowerCase()) fail('signer is not the burner');
  const agent = chainCfg.agentWallet;
  const router = chainCfg.router;
  const quoteToken = chainCfg.quoteToken;

  const taxArtifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'TaxToken.sol', 'TaxToken.json'), 'utf8'));
  const sbtArtifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'names', 'artifacts', 'contracts', 'NameSBT.sol', 'NameSBT.json'), 'utf8'));
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const sbtInitCode = ethers.concat([sbtArtifact.bytecode, coder.encode(['string','string','address'], ['Burner Names','BNAME', deployer])]);
  const sbtInitCodeHash = ethers.keccak256(sbtInitCode);

  const token = new ethers.Contract(TOKEN, taxArtifact.abi, signer);
  // sanity: token is live and owned by the burner
  const onChain = { name: await token.name(), symbol: await token.symbol(), totalSupply: await token.totalSupply(), owner: await token.owner() };
  if (onChain.name !== t.name || onChain.symbol !== t.symbol) fail('token name/symbol mismatch');
  if (onChain.owner.toLowerCase() !== deployer.toLowerCase()) fail('token owner is not the burner');
  console.log('token live:', TOKEN, '| supply:', ethers.formatUnits(onChain.totalSupply, 18), '| owner: burner');

  const nonces = new NonceTracker(provider, deployer);
  await nonces.init();
  console.log('burner nonce:', await provider.getTransactionCount(deployer));

  // mine the NFT salt (same C miner the driver uses)
  const cBin = path.join(__dirname, 'script', 'vanity-miner');
  const out = execFileSync(cBin, ['--deployer', TOKEN, '--init-code-hash', sbtInitCodeHash, '--prefix', PREFIX, '--threads', '4'], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
  const m = out.match(/SALT=(0x[0-9a-fA-F]+)\s+ADDRESS=(0x[0-9a-fA-F]+)\s+TRIES=(\d+)\s+ELAPSED_S=([\d.]+)\s+RATE=([\d.]+)/);
  if (!m) fail('could not parse miner output: ' + out);
  const [, nftSalt, nftAddr] = m;
  console.log('NFT salt:', nftSalt, '->', nftAddr);
  const predictedNft = ethers.getCreate2Address(TOKEN, nftSalt, sbtInitCodeHash);
  if (predictedNft.toLowerCase() !== nftAddr.toLowerCase()) fail('miner/ethers disagree on NFT address');
  const predictedByToken = await token.predictDeploy(sbtInitCodeHash, nftSalt);
  if (predictedByToken.toLowerCase() !== predictedNft.toLowerCase()) fail('token.predictDeploy disagrees');
  console.log('token.predictDeploy agrees:', predictedNft);

  // deploy the NFT via the token (28M gas — the estimate is ~27.3M)
  console.log('deploying NameSBT via token.deploy() (gasLimit 28M)...');
  let tx = await token.deploy(sbtInitCode, nftSalt, { nonce: nonces.take(), gasLimit: GAS_LIMIT });
  let receipt = await tx.wait();
  console.log('NFT deploy tx:', receipt.hash, 'status:', receipt.status, 'gas:', receipt.gasUsed.toString());
  if (receipt.status !== 1) fail('NFT deploy tx reverted');
  const nftCode = await provider.getCode(predictedNft);
  if (nftCode === '0x') fail('no code at the predicted NFT address');
  const sbt = new ethers.Contract(predictedNft, sbtArtifact.abi, signer);
  const nftOwner = await sbt.owner();
  if (nftOwner.toLowerCase() !== deployer.toLowerCase()) fail('NFT owner is not the burner');
  console.log('NameSBT live at', predictedNft, '| owner: burner');

  // agent allocation: 10% of supply to the Sepolia agent wallet
  const decimals = Number(t.decimals);
  const initialSupply = BigInt(t.initialSupplyTokens) * 10n ** BigInt(decimals);
  let allocation = (initialSupply * BigInt(t.agentAllocationBps)) / 10000n;
  if (allocation > 0n && agent) {
    console.log('transferring agent allocation', ethers.formatUnits(allocation, decimals), t.symbol, 'to', agent);
    tx = await token.transfer(agent, allocation, { nonce: nonces.take(), gasLimit: 300000n });
    receipt = await tx.wait();
    console.log('allocation tx:', receipt.hash, 'status:', receipt.status);
    if (receipt.status !== 1) fail('allocation tx reverted');
    const agentBal = await token.balanceOf(agent);
    if (agentBal !== allocation) fail('agent balance mismatch: ' + agentBal);
    console.log('agent balance verified:', ethers.formatUnits(agentBal, decimals));
  } else {
    console.log('no agent allocation');
    allocation = 0n;
  }

  const receiptJson = {
    chainId: CHAIN_ID,
    chain: chainCfg.name,
    factory: FACTORY,
    token: TOKEN,
    nft: predictedNft,
    name: t.name,
    symbol: t.symbol,
    deployer,
    agent,
    agentAllocation: allocation.toString(),
    router,
    quoteToken,
    tokenSalt: TOKEN_SALT,
    nftSalt,
  };
  const outDir = path.join(__dirname, 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${CHAIN_ID}-vanity.json`);
  fs.writeFileSync(outPath, JSON.stringify(receiptJson, null, 2) + '\n');
  console.log('DONE. Receipt written to', outPath);
  console.log('  token:', TOKEN);
  console.log('  NFT:  ', predictedNft);
})().catch(e => { console.error('FINISH FAILED:', e.message); process.exit(1); });
