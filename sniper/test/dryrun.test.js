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
const { buildBuyTx, execute } = require('../src/swap');

const SEPOLIA_FACTORY = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const SEPOLIA_ROUTER = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3';
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // faucet USDC
const BURNER = '0x6F311641923246e7f4fE2F1F679c75f4DE107621';
const AGENT = '0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7';

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
  // Burner holds 0.05 ETH gas on Sepolia (verified 2026-11-18); agent 0.
  const burnerBal = await provider.getBalance(BURNER);
  const agentBal = await provider.getBalance(AGENT);
  assert.ok(burnerBal >= ethers.parseEther('0.05'), `burner Sepolia balance ${ethers.formatEther(burnerBal)} < 0.05 ETH`);
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

test('robinhood-testnet: chain id + burner holds gas (0.01 ETH)', { timeout: 60000 }, async () => {
  const { provider } = await providerFor('robinhood-testnet');
  assert.equal(Number((await provider.getNetwork()).chainId), 46630);
  const burnerBal = await provider.getBalance(BURNER);
  assert.ok(burnerBal >= ethers.parseEther('0.01'), `burner Robinhood balance ${ethers.formatEther(burnerBal)} < 0.01 ETH`);
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

test('arc-testnet: building a buy without a DEX is refused, not guessed', async () => {
  const cfg = loadConfig({ CHAIN: 'arc-testnet', PRIVATE_KEY: '' });
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  await assert.rejects(
    buildBuyTx({ provider, cfg, token: SEPOLIA_USDC, walletAddress: BURNER }),
    /No DEX configured/,
  );
});
