'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, BURNER_WALLET_DEFAULT, AGENT_WALLET_DEFAULT } = require('../src/config');

test('defaults: Arc Testnet, dry-run on, burner signs, agent holds', () => {
  const cfg = loadConfig({ PRIVATE_KEY: '' });
  assert.equal(cfg.chainKey, 'arc-testnet');
  assert.equal(cfg.chainId, 5042002);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.signerAddress, BURNER_WALLET_DEFAULT);
  assert.equal(cfg.agentAddress, AGENT_WALLET_DEFAULT);
  assert.equal(cfg.profitRecipient, AGENT_WALLET_DEFAULT);
  assert.equal(cfg.factory, null);
  assert.equal(cfg.router, null);
  assert.equal(cfg.baseSymbol, 'USDC');
  assert.equal(cfg.buyAmountNative, 0.01);
});

test('sepolia: verified V2 deployment, WETH base', () => {
  const cfg = loadConfig({ CHAIN: 'sepolia', PRIVATE_KEY: '' });
  assert.equal(cfg.chainId, 11155111);
  assert.equal(cfg.factory, '0xF62c03E08ada871A0bEb309762E260a7a6a880E6');
  assert.equal(cfg.router, '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3');
  assert.equal(cfg.baseToken, '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
  assert.equal(cfg.baseSymbol, 'WETH');
});

test('robinhood-testnet: chain 46630, ETH base, no DEX yet', () => {
  const cfg = loadConfig({ CHAIN: 'robinhood-testnet', PRIVATE_KEY: '' });
  assert.equal(cfg.chainId, 46630);
  assert.equal(cfg.factory, null);
  assert.equal(cfg.baseSymbol, 'ETH');
});

test('base-sepolia: no V2 at the known addresses', () => {
  const cfg = loadConfig({ CHAIN: 'base-sepolia', PRIVATE_KEY: '' });
  assert.equal(cfg.chainId, 84532);
  assert.equal(cfg.factory, null);
  assert.equal(cfg.router, null);
  assert.equal(cfg.baseToken, null);
});

test('unknown chain is rejected', () => {
  assert.throws(() => loadConfig({ CHAIN: 'mainnet' }), /Unknown CHAIN/);
  assert.throws(() => loadConfig({ CHAIN: 'ethereum' }), /Unknown CHAIN/);
});

test('live mode without a key is refused', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'false', PRIVATE_KEY: '' }), /no PRIVATE_KEY/);
});

test('malformed private key is rejected', () => {
  assert.throws(
    () => loadConfig({ DRY_RUN: 'false', PRIVATE_KEY: 'not-a-key' }),
    /PRIVATE_KEY must be/,
  );
});

test('slippage above 50% is rejected', () => {
  assert.throws(() => loadConfig({ SLIPPAGE_BPS: '6000' }), /SLIPPAGE_BPS/);
});

test('BUY_AMOUNT_ETH alias still works', () => {
  const cfg = loadConfig({ BUY_AMOUNT_ETH: '0.05', PRIVATE_KEY: '' });
  assert.equal(cfg.buyAmountNative, 0.05);
});

test('PROFIT_RECIPIENT override is honoured', () => {
  const cfg = loadConfig({ PROFIT_RECIPIENT: BURNER_WALLET_DEFAULT, PRIVATE_KEY: '' });
  assert.equal(cfg.profitRecipient, BURNER_WALLET_DEFAULT);
});

test('bad wallet addresses are rejected', () => {
  assert.throws(() => loadConfig({ BURNER_WALLET_ADDRESS: '0x123' }), /BURNER_WALLET_ADDRESS/);
  assert.throws(() => loadConfig({ AGENT_WALLET_ADDRESS: 'zzz' }), /AGENT_WALLET_ADDRESS/);
});
