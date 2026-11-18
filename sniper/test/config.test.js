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
  // Our AGNAmuse V2 on Arc (verified 2026-11-19): factory, router, and
  // the USDC predeploy as base token, with the ERC-20 buy path.
  assert.equal(cfg.factory, '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d');
  assert.equal(cfg.router, '0x96ec1BE94202E5F8b10123B1677A57E45b7BB9A7');
  assert.equal(cfg.baseToken, '0x3600000000000000000000000000000000000000');
  assert.equal(cfg.baseSymbol, 'USDC');
  assert.equal(cfg.baseDecimals, 6);
  assert.equal(cfg.buyWithERC20, true);
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

test('robinhood-testnet: our AGNAmuse V2, WETH base, native buy path', () => {
  const cfg = loadConfig({ CHAIN: 'robinhood-testnet', PRIVATE_KEY: '' });
  assert.equal(cfg.chainId, 46630);
  assert.equal(cfg.factory, '0xe9f116220486AB52b8D245aF3C19de5C025Adea8');
  assert.equal(cfg.router, '0x4524D50c3fa8aeA4f44db5EA1e02753cB0A8ac58');
  assert.equal(cfg.baseToken, '0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09');
  assert.equal(cfg.baseSymbol, 'WETH');
  assert.equal(cfg.baseDecimals, 18);
  assert.equal(cfg.buyWithERC20, false);
});

test('litvm-testnet: our AGNAmuse V2, WETH base, native buy path', () => {
  const cfg = loadConfig({ CHAIN: 'litvm-testnet', PRIVATE_KEY: '' });
  assert.equal(cfg.chainId, 4441);
  assert.equal(cfg.factory, '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce');
  assert.equal(cfg.router, '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d');
  assert.equal(cfg.baseToken, '0x774eF4Bf6E350A80ae86972c09f2f493e0F1Bfa6');
  assert.equal(cfg.baseSymbol, 'WETH');
  assert.equal(cfg.baseDecimals, 18);
  assert.equal(cfg.buyWithERC20, false);
});

test('sepolia: native buy path (no ERC-20 flag)', () => {
  const cfg = loadConfig({ CHAIN: 'sepolia', PRIVATE_KEY: '' });
  assert.equal(cfg.buyWithERC20, false);
  assert.equal(cfg.baseDecimals, 18);
});

test('DEX env overrides still win over the chain table', () => {
  const cfg = loadConfig({
    CHAIN: 'robinhood-testnet', PRIVATE_KEY: '',
    FACTORY_ADDRESS: '0x1111111111111111111111111111111111111111',
    ROUTER_ADDRESS: '0x2222222222222222222222222222222222222222',
    BASE_TOKEN_ADDRESS: '0x3333333333333333333333333333333333333333',
  });
  assert.equal(cfg.factory, '0x1111111111111111111111111111111111111111');
  assert.equal(cfg.router, '0x2222222222222222222222222222222222222222');
  assert.equal(cfg.baseToken, '0x3333333333333333333333333333333333333333');
  // The buy-path flag still comes from the chain, not the override.
  assert.equal(cfg.buyWithERC20, false);
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
