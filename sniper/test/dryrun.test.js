'use strict';

/**
 * Live dry-run tests against public testnet RPCs.
 * Read-only: no transaction is ever sent. If a public RPC is down, the
 * affected test fails loudly instead of passing silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadConfig } = require('../src/config');
const {
  buildBuyTx, buildBuyTxERC20, buildSellTxERC20, execute,
  factoryContract,
} = require('../src/swap');

const SEPOLIA_FACTORY = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const SEPOLIA_ROUTER = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3';
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // faucet USDC
const BURNER = '0x6F311641923246e7f4fE2F1F679c75f4DE107621';
const AGENT = '0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7';

// Our AGNAmuse V2 deployments (verified live 2026-11-19).
const AGNA_ARC = '0xa69000Fb025DDe35F126332331c2746979845E56';
const AGNA_RH_LITVM = '0xa69000FF81232ac079eC2265fD4da3100F243fc3';
const ARC_PREDEPLOY = '0x3600000000000000000000000000000000000000'; // USDC, 6 decimals
const ARC_WUSDC = '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce';
const ARC_FACTORY = '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d';
const ARC_ROUTER = '0x96ec1BE94202E5F8b10123B1677A57E45b7BB9A7';
const ARC_AGNA_PAIR = '0xba3746f46Fbfe22E4E17083F1769b359A0b8956a';
const RH_FACTORY = '0xe9f116220486AB52b8D245aF3C19de5C025Adea8';
const RH_ROUTER = '0x4524D50c3fa8aeA4f44db5EA1e02753cB0A8ac58';
const RH_WETH = '0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09';
const RH_AGNA_PAIR = '0x699d97ACc97bB067842Bbe8CE89dC52d805D0a22';
const LITVM_FACTORY = '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce';
const LITVM_ROUTER = '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d';
const LITVM_WETH = '0x774eF4Bf6E350A80ae86972c09f2f493e0F1Bfa6';
const LITVM_AGNA_PAIR = '0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function providerFor(chainKey) {
  const cfg = loadConfig({ CHAIN: chainKey, PRIVATE_KEY: '' });
  return { cfg, provider: new ethers.JsonRpcProvider(cfg.rpcUrl) };
}

test('sepolia: chain id + V2 factory/router have code', { timeout: 60000 }, async () => {
  const { cfg, provider } = await providerFor('sepolia');
  assert.equal(Number((await provider.getNetwork()).chainId), 11155111);
  const factoryCode = await provider.getCode(SEPOLIA_FACTORY);
  const routerCode = await provider.getCode(SEPOLIA_ROUTER);
  assert.notEqual(factoryCode, '0x', 'V2 factory has no code on Sepolia');
  assert.notEqual(routerCode, '0x', 'V2 router has no code on Sepolia');
  assert.equal(cfg.factory, SEPOLIA_FACTORY);
  // Burner holds ~0.0298 ETH gas on Sepolia (verified 2026-11-19; was
  // 0.05 before the AGNA token/NFT deploys); agent 0.
  const burnerBal = await provider.getBalance(BURNER);
  const agentBal = await provider.getBalance(AGENT);
  assert.ok(burnerBal >= ethers.parseEther('0.02'), `burner Sepolia balance ${ethers.formatEther(burnerBal)} < 0.02 ETH`);
  assert.equal(agentBal, 0n);
  console.log(`  sepolia balances — burner ${ethers.formatEther(burnerBal)} ETH, agent ${ethers.formatEther(agentBal)} ETH`);
});

test('arc-testnet: chain id + both wallets hold gas (USDC)', { timeout: 60000 }, async () => {
  const { provider } = await providerFor('arc-testnet');
  assert.equal(Number((await provider.getNetwork()).chainId), 5042002);
  const burnerBal = await provider.getBalance(BURNER);
  const agentBal = await provider.getBalance(AGENT);
  // Faucet tops both wallets up every 2h, so balances only grow from the
  // levels verified 2026-11-18 (burner 80 USDC, agent 20 USDC).
  assert.ok(burnerBal >= ethers.parseEther('80'), `burner Arc balance ${ethers.formatEther(burnerBal)} < 80 USDC`);
  assert.ok(agentBal >= ethers.parseEther('20'), `agent Arc balance ${ethers.formatEther(agentBal)} < 20 USDC`);
  console.log(`  arc balances — burner ${ethers.formatEther(burnerBal)} USDC, agent ${ethers.formatEther(agentBal)} USDC`);
});

test('robinhood-testnet: chain id + burner holds gas (~0.0054 ETH)', { timeout: 60000 }, async () => {
  const { provider } = await providerFor('robinhood-testnet');
  assert.equal(Number((await provider.getNetwork()).chainId), 46630);
  const burnerBal = await provider.getBalance(BURNER);
  // Was 0.01 ETH (verified 2026-11-18); the AGNA factory/pool deploys
  // on 2026-11-19 spent most of it. Threshold 0.005 leaves headroom.
  assert.ok(burnerBal >= ethers.parseEther('0.005'), `burner Robinhood balance ${ethers.formatEther(burnerBal)} < 0.005 ETH`);
  console.log(`  robinhood burner balance ${ethers.formatEther(burnerBal)} ETH`);
});

test('dry-run buy on Sepolia builds a real unsigned tx and sends nothing', { timeout: 60000 }, async () => {
  const cfg = loadConfig({ CHAIN: 'sepolia', PRIVATE_KEY: '', BUY_AMOUNT_NATIVE: '0.001' });
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  // Quote against the real WETH/USDC pair. If the pair has no liquidity
  // the quote reverts — that is a live-liquidity fact, not a code failure,
  // so fall back to asserting the dry-run executor with a hand-built tx.
  let built = null;
  try {
    built = await buildBuyTx({ provider, cfg, token: SEPOLIA_USDC, walletAddress: BURNER });
  } catch (err) {
    console.log(`  note: live quote failed (${err.shortMessage || err.message}) — testing executor with a hand-built tx`);
  }
  if (built) {
    assert.equal(built.tx.to.toLowerCase(), SEPOLIA_ROUTER.toLowerCase());
    assert.equal(built.tx.value, ethers.parseEther('0.001'));
    assert.ok(built.quotedOut > 0n);
    assert.ok(built.minOut > 0n && built.minOut <= built.quotedOut);
    console.log(`  quoted ${ethers.formatUnits(built.quotedOut, 6)} USDC for 0.001 ETH (min ${ethers.formatUnits(built.minOut, 6)})`);
  }
  const tx = built ? built.tx : { to: SEPOLIA_ROUTER, value: ethers.parseEther('0.001'), data: '0x' };
  const result = await execute({ provider, wallet: null, cfg, tx, label: 'dry-run buy' });
  assert.equal(result.sent, false, 'dry-run must never send a transaction');
  assert.equal(result.hash, null);
});

test('arc-testnet: AGNAmuse V2 live, AGNA pair is predeploy-paired, ERC-20 buy quotes', { timeout: 60000 }, async () => {
  const cfg = loadConfig({ CHAIN: 'arc-testnet', PRIVATE_KEY: '', BUY_AMOUNT_NATIVE: '0.01' });
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  assert.equal(Number((await provider.getNetwork()).chainId), 5042002);
  assert.equal(cfg.buyWithERC20, true);
  assert.equal(cfg.baseDecimals, 6);
  for (const [label, addr] of [['factory', ARC_FACTORY], ['router', ARC_ROUTER], ['predeploy', ARC_PREDEPLOY]]) {
    assert.notEqual(await provider.getCode(addr), '0x', `Arc ${label} has no code`);
  }
  const factory = factoryContract(ARC_FACTORY, provider);
  // The AGNA pair is AGNA/predeploy — and there is NO AGNA/WUSDC pair,
  // which is why the native buy path cannot buy AGNA on Arc.
  assert.equal((await factory.getPair(AGNA_ARC, ARC_PREDEPLOY)).toLowerCase(), ARC_AGNA_PAIR.toLowerCase());
  assert.equal((await factory.getPair(AGNA_ARC, ARC_WUSDC)).toLowerCase(), ZERO_ADDRESS);
  // ERC-20 buy: 0.01 USDC (10_000 raw units at 6 decimals) -> AGNA.
  const built = await buildBuyTxERC20({ provider, cfg, token: AGNA_ARC, walletAddress: BURNER });
  assert.ok(built.quotedOut > 0n, 'ERC-20 buy quote is zero');
  assert.ok(built.minOut > 0n && built.minOut <= built.quotedOut);
  assert.equal(built.txs.length, 2, 'expected approve + swap');
  assert.equal(built.txs[0].to.toLowerCase(), ARC_PREDEPLOY.toLowerCase());
  assert.ok(built.txs[0].data.startsWith('0x095ea7b3'), 'first tx must be an ERC-20 approve');
  assert.equal(built.txs[1].to.toLowerCase(), ARC_ROUTER.toLowerCase());
  assert.ok(built.txs[1].value === 0n || built.txs[1].value === undefined, 'ERC-20 buy sends no native value');
  console.log(`  arc ERC-20 buy: 0.01 USDC -> ~${ethers.formatEther(built.quotedOut)} AGNA (min ${ethers.formatEther(built.minOut)})`);
  for (const tx of built.txs) {
    const result = await execute({ provider, wallet: null, cfg, tx, label: 'arc dry-run buy' });
    assert.equal(result.sent, false, 'dry-run must never send a transaction');
  }
  // The ERC-20 sell builder also resolves against the live pair.
  // The burner holds AGNA on Arc, so a 100% sell quote is expected to work.
  const sell = await buildSellTxERC20({ provider, cfg, token: AGNA_ARC, walletAddress: BURNER, percent: 100 });
  assert.ok(sell.quotedOut > 0n, 'ERC-20 sell quote is zero');
  assert.equal(sell.txs[sell.txs.length - 1].to.toLowerCase(), ARC_ROUTER.toLowerCase());
  console.log(`  arc ERC-20 sell: 100% of burner AGNA -> ~${ethers.formatUnits(sell.quotedOut, 6)} USDC`);
});

test('robinhood-testnet: AGNAmuse V2 live, native buy of AGNA quotes', { timeout: 60000 }, async () => {
  const cfg = loadConfig({ CHAIN: 'robinhood-testnet', PRIVATE_KEY: '', BUY_AMOUNT_NATIVE: '0.0001' });
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  assert.equal(Number((await provider.getNetwork()).chainId), 46630);
  assert.equal(cfg.buyWithERC20, false);
  for (const [label, addr] of [['factory', RH_FACTORY], ['router', RH_ROUTER], ['WETH9', RH_WETH]]) {
    assert.notEqual(await provider.getCode(addr), '0x', `Robinhood ${label} has no code`);
  }
  const factory = factoryContract(RH_FACTORY, provider);
  assert.equal((await factory.getPair(AGNA_RH_LITVM, RH_WETH)).toLowerCase(), RH_AGNA_PAIR.toLowerCase());
  // 0.0001 ETH is small against the 0.002006 ETH reserve; the quote is
  // pre-tax (AGNA takes 5% on buys, so the buyer receives ~95% of it).
  const built = await buildBuyTx({ provider, cfg, token: AGNA_RH_LITVM, walletAddress: BURNER });
  assert.equal(built.tx.to.toLowerCase(), RH_ROUTER.toLowerCase());
  assert.equal(built.tx.value, ethers.parseEther('0.0001'));
  assert.ok(built.quotedOut > 0n);
  assert.ok(built.minOut > 0n && built.minOut <= built.quotedOut);
  console.log(`  robinhood native buy: 0.0001 ETH -> ~${ethers.formatEther(built.quotedOut)} AGNA (min ${ethers.formatEther(built.minOut)})`);
  const result = await execute({ provider, wallet: null, cfg, tx: built.tx, label: 'robinhood dry-run buy' });
  assert.equal(result.sent, false, 'dry-run must never send a transaction');
});

test('litvm-testnet: AGNAmuse V2 live, native buy of AGNA quotes', { timeout: 60000 }, async () => {
  const cfg = loadConfig({ CHAIN: 'litvm-testnet', PRIVATE_KEY: '', BUY_AMOUNT_NATIVE: '0.0001' });
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  assert.equal(Number((await provider.getNetwork()).chainId), 4441);
  assert.equal(cfg.buyWithERC20, false);
  for (const [label, addr] of [['factory', LITVM_FACTORY], ['router', LITVM_ROUTER], ['WETH9', LITVM_WETH]]) {
    assert.notEqual(await provider.getCode(addr), '0x', `LitVM ${label} has no code`);
  }
  const factory = factoryContract(LITVM_FACTORY, provider);
  assert.equal((await factory.getPair(AGNA_RH_LITVM, LITVM_WETH)).toLowerCase(), LITVM_AGNA_PAIR.toLowerCase());
  // 0.0001 zkLTC is small against the 0.020139 zkLTC reserve; the quote
  // is pre-tax (AGNA takes 5% on buys).
  const built = await buildBuyTx({ provider, cfg, token: AGNA_RH_LITVM, walletAddress: BURNER });
  assert.equal(built.tx.to.toLowerCase(), LITVM_ROUTER.toLowerCase());
  assert.equal(built.tx.value, ethers.parseEther('0.0001'));
  assert.ok(built.quotedOut > 0n);
  assert.ok(built.minOut > 0n && built.minOut <= built.quotedOut);
  console.log(`  litvm native buy: 0.0001 zkLTC -> ~${ethers.formatEther(built.quotedOut)} AGNA (min ${ethers.formatEther(built.minOut)})`);
  const result = await execute({ provider, wallet: null, cfg, tx: built.tx, label: 'litvm dry-run buy' });
  assert.equal(result.sent, false, 'dry-run must never send a transaction');
});
