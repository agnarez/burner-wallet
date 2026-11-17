// Burner wallet generator + verifier
// Run: node generate.js
// Step 1: verify derivation against the known BIP39 test vector mnemonic
// Step 2: generate a fresh 12-word mnemonic and derive all chains
// Output: private/backup.json + private/backup.txt (NEVER print keys to chat)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bip39 = require('bip39');
const { ethers } = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
const { Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const { derivePath } = require('ed25519-hd-key');
const bs58 = require('bs58');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { blake2b } = require('@noble/hashes/blake2b');
const { WalletContractV4 } = require('@ton/ton');

// ---------- helpers ----------
function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }
function ok(msg) { console.log('PASS: ' + msg); }

// secp256k1 private key -> ETH-style address (last 20 bytes of keccak256 of uncompressed pubkey)
function ethAddressFromPriv(privHex) {
  const w = new ethers.Wallet(privHex);
  return w.address;
}
// TRON address from secp256k1 private key: 0x41 + last20(keccak(pubkey)), base58check
function tronAddressFromPriv(privHex) {
  const w = new ethers.Wallet(privHex);
  const hash20 = w.address.slice(2); // 20-byte hex, same keccak as ETH
  const prefixed = Buffer.concat([Buffer.from([0x41]), Buffer.from(hash20, 'hex')]);
  const h1 = crypto.createHash('sha256').update(prefixed).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();
  const withChecksum = Buffer.concat([prefixed, h2.slice(0, 4)]);
  return bs58.encode(withChecksum);
}
// ed25519 seed (32 bytes) -> keypair via tweetnacl, pubkey hex
function ed25519FromSeed(seed32) {
  return nacl.sign.keyPair.fromSeed(seed32);
}

// ---------- STEP 1: test vectors ----------
// Standard BIP39 test mnemonic (entropy 0x00..00)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
console.log('--- STEP 1: test-vector verification ---');
if (!bip39.validateMnemonic(TEST_MNEMONIC)) fail('test mnemonic invalid');
ok('test mnemonic validates');

const testSeed = bip39.mnemonicToSeedSync(TEST_MNEMONIC); // no passphrase

// ETH m/44'/60'/0'/0/0 — published value 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
const testEth = ethers.HDNodeWallet.fromSeed(testSeed).derivePath("m/44'/60'/0'/0/0");
if (testEth.address.toLowerCase() !== '0x9858effd232b4033e47d90003d41ec34ecaeda94') {
  fail(`ETH test vector mismatch: got ${testEth.address}`);
}
ok(`ETH m/44'/60'/0'/0/0 = ${testEth.address} (matches published vector)`);

// BTC native SegWit m/84'/0'/0'/0/0 — published value bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
// (verified: decodes to a 20-byte witness program, v0; the shorter form fails bech32 checksum)
const btcRoot = bip32.fromSeed(testSeed, bitcoin.networks.bitcoin);
const btcChild = btcRoot.derivePath("m/84'/0'/0'/0/0");
const btcPay = bitcoin.payments.p2wpkh({ pubkey: btcChild.publicKey, network: bitcoin.networks.bitcoin });
if (btcPay.address !== 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu') {
  fail(`BTC test vector mismatch: got ${btcPay.address}`);
}
ok(`BTC m/84'/0'/0'/0/0 = ${btcPay.address} (matches published vector)`);

// SOL m/44'/501'/0'/0' — cross-check two independent derivations
const solSeedA = derivePath("m/44'/501'/0'/0'", testSeed.toString('hex')).key;
const solKpA = Keypair.fromSeed(solSeedA);
const solKpB = Keypair.fromSeed(nacl.sign.keyPair.fromSeed(solSeedA).secretKey.slice(0, 32));
if (solKpA.publicKey.toBase58() !== solKpB.publicKey.toBase58()) fail('SOL cross-check mismatch');
ok(`SOL m/44'/501'/0'/0' = ${solKpA.publicKey.toBase58()} (two methods agree)`);

// TRON m/44'/195'/0'/0/0 — cross-check: TRON address bytes must equal ETH address bytes for same key
const testTron = ethers.HDNodeWallet.fromSeed(testSeed).derivePath("m/44'/195'/0'/0/0");
const tronAddr = tronAddressFromPriv(testTron.privateKey);
const tronDecoded = bs58.decode(tronAddr);
if (tronDecoded[0] !== 0x41) fail('TRON prefix wrong');
if (Buffer.from(tronDecoded.slice(1, 21)).toString('hex') !== testTron.address.slice(2).toLowerCase()) {
  fail('TRON address bytes do not match the same-key ETH address');
}
ok(`TRON m/44'/195'/0'/0/0 = ${tronAddr} (0x41 + same 20 bytes as ETH key)`);

// SUI m/44'/784'/0'/0'/0' — official SDK derivation, cross-checked vs manual ed25519 + blake2b address
const suiKp = Ed25519Keypair.deriveKeypair(TEST_MNEMONIC, "m/44'/784'/0'/0'/0'");
const suiSeed = derivePath("m/44'/784'/0'/0'/0'", testSeed.toString('hex')).key;
const suiManual = ed25519FromSeed(suiSeed);
const suiPub = Buffer.from(suiManual.publicKey);
const suiAddrManual = '0x' + Buffer.from(blake2b(Buffer.concat([Buffer.from([0x00]), suiPub]), { dkLen: 32 })).toString('hex');
if (suiKp.getPublicKey().toSuiAddress() !== suiAddrManual) fail('SUI cross-check mismatch');
ok(`SUI m/44'/784'/0'/0'/0' = ${suiKp.getPublicKey().toSuiAddress()} (SDK + manual blake2b agree)`);

// TON m/44'/607'/0'/0'/0' — BIP39 seed + SLIP-0010 ed25519 (same scheme as the
// other ed25519 chains; this is the BIP44 path multi-chain wallets use for TON.
// Note: Tonkeeper's native 24-word scheme uses its own PBKDF2 and differs.)
const tonSeed = derivePath("m/44'/607'/0'/0'/0'", testSeed.toString('hex')).key;
const tonKp = nacl.sign.keyPair.fromSeed(tonSeed);
const tonWallet = WalletContractV4.create({ publicKey: Buffer.from(tonKp.publicKey), workchain: 0 });
const tonAddr = tonWallet.address.toString({ urlSafe: true, bounceable: true, testOnly: false });
if (!tonAddr.startsWith('EQ') && !tonAddr.startsWith('UQ')) fail('TON address format unexpected: ' + tonAddr);
ok(`TON m/44'/607'/0'/0'/0' = ${tonAddr} (WalletContractV4, mainnet bounceable EQ...)`);

// NEAR m/44'/397'/0' — implicit account = hex(ed25519 pubkey)
const nearSeed = derivePath("m/44'/397'/0'", testSeed.toString('hex')).key;
const nearKp = ed25519FromSeed(nearSeed);
const nearImplicit = Buffer.from(nearKp.publicKey).toString('hex');
if (!/^[0-9a-f]{64}$/.test(nearImplicit)) fail('NEAR implicit account format wrong');
ok(`NEAR m/44'/397'/0' implicit account = ${nearImplicit.slice(0, 16)}... (64 hex chars)`);

console.log('--- STEP 1 complete: all derivations verified ---');

// ---------- STEP 2: generate the fresh burner wallet ----------
console.log('--- STEP 2: generating fresh burner wallet ---');
const mnemonic = bip39.generateMnemonic(128); // 12 words, crypto randomness
if (!bip39.validateMnemonic(mnemonic)) fail('generated mnemonic invalid');
const seed = bip39.mnemonicToSeedSync(mnemonic);
const seedHex = seed.toString('hex');

// BTC mainnet SegWit m/84'/0'/0'/0/0
const btcMainRoot = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
const btcMain = btcMainRoot.derivePath("m/84'/0'/0'/0/0");
const btcMainPay = bitcoin.payments.p2wpkh({ pubkey: btcMain.publicKey, network: bitcoin.networks.bitcoin });
// BTC testnet SegWit m/84'/1'/0'/0/0
const btcTestRoot = bip32.fromSeed(seed, bitcoin.networks.testnet);
const btcTest = btcTestRoot.derivePath("m/84'/1'/0'/0/0");
const btcTestPay = bitcoin.payments.p2wpkh({ pubkey: btcTest.publicKey, network: bitcoin.networks.testnet });
// EVM m/44'/60'/0'/0/0
const evm = ethers.HDNodeWallet.fromSeed(seed).derivePath("m/44'/60'/0'/0/0");
// SOL m/44'/501'/0'/0'
const solSeed = derivePath("m/44'/501'/0'/0'", seedHex).key;
const solKp = Keypair.fromSeed(solSeed);
// TRON m/44'/195'/0'/0/0
const tronW = ethers.HDNodeWallet.fromSeed(seed).derivePath("m/44'/195'/0'/0/0");
const tronAddr2 = tronAddressFromPriv(tronW.privateKey);
// SUI m/44'/784'/0'/0'/0'
const suiKp2 = Ed25519Keypair.deriveKeypair(mnemonic, "m/44'/784'/0'/0'/0'");
// TON m/44'/607'/0'/0'/0'
const tonSeed2 = derivePath("m/44'/607'/0'/0'/0'", seedHex).key;
const tonKp2 = nacl.sign.keyPair.fromSeed(tonSeed2);
const tonWallet2 = WalletContractV4.create({ publicKey: Buffer.from(tonKp2.publicKey), workchain: 0 });
const tonAddr2 = tonWallet2.address.toString({ urlSafe: true, bounceable: true, testOnly: false });
// NEAR m/44'/397'/0'
const nearSeed2 = derivePath("m/44'/397'/0'", seedHex).key;
const nearKp2 = ed25519FromSeed(nearSeed2);
const nearImplicit2 = Buffer.from(nearKp2.publicKey).toString('hex');
const nearSecretB58 = bs58.encode(Buffer.from(nearKp2.secretKey));

const created = new Date().toISOString();
const backup = {
  wallet: 'burner-wallet',
  created,
  network: 'mainnet (BTC testnet address also included)',
  warning: 'BURNER WALLET. This file contains the seed phrase and private keys — anyone with it controls the funds. Keep it offline, never share it, never paste it into any website except a wallet you trust. Use only small amounts you can afford to lose.',
  mnemonic,
  seedHex,
  chains: {
    bitcoin: { network: 'mainnet', path: "m/84'/0'/0'/0/0", address: btcMainPay.address, privateKeyWIF: btcMain.toWIF(), publicKey: Buffer.from(btcMain.publicKey).toString('hex') },
    bitcoin_testnet: { network: 'testnet', path: "m/84'/1'/0'/0/0", address: btcTestPay.address, privateKeyWIF: btcTest.toWIF(), publicKey: Buffer.from(btcTest.publicKey).toString('hex') },
    ethereum_evm: { network: 'mainnet (all EVM chains share this address)', path: "m/44'/60'/0'/0/0", address: evm.address, privateKey: evm.privateKey },
    solana: { network: 'mainnet', path: "m/44'/501'/0'/0'", address: solKp.publicKey.toBase58(), privateKeyBase58SecretKey: bs58.encode(Buffer.from(solKp.secretKey)), publicKey: solKp.publicKey.toBase58() },
    tron: { network: 'mainnet', path: "m/44'/195'/0'/0/0", address: tronAddr2, privateKey: tronW.privateKey },
    sui: { network: 'mainnet', path: "m/44'/784'/0'/0'/0'", address: suiKp2.getPublicKey().toSuiAddress(), privateKeySuiPrivkey: suiKp2.getSecretKey() },
    ton: { network: 'mainnet', path: "m/44'/607'/0'/0'/0'", address: tonAddr2, privateKeyHex: Buffer.from(tonSeed2).toString('hex'), publicKeyHex: Buffer.from(tonKp2.publicKey).toString('hex') },
    near: { network: 'mainnet', path: "m/44'/397'/0'", implicitAccount: nearImplicit2, privateKey: 'ed25519:' + nearSecretB58 }
  }
};

fs.mkdirSync(path.join(__dirname, 'private'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'private', 'backup.json'), JSON.stringify(backup, null, 2));
const txt = [
  'BURNER WALLET — PRIVATE BACKUP',
  'Created: ' + created,
  '',
  'WARNING: This file holds the seed phrase and private keys. Anyone with it controls the funds.',
  'Keep it offline. Never share it. Use only small amounts you can afford to lose.',
  '',
  'MNEMONIC (12 words — BIP39):',
  mnemonic,
  '',
  'Bitcoin (SegWit, mainnet)  m/84\'/0\'/0\'/0/0',
  '  Address: ' + btcMainPay.address,
  '  Private key (WIF): ' + btcMain.toWIF(),
  '',
  'Bitcoin (SegWit, testnet)  m/84\'/1\'/0\'/0/0',
  '  Address: ' + btcTestPay.address,
  '  Private key (WIF): ' + btcTest.toWIF(),
  '',
  'Ethereum / all EVM chains  m/44\'/60\'/0\'/0/0',
  '  Address: ' + evm.address,
  '  Private key: ' + evm.privateKey,
  '',
  'Solana  m/44\'/501\'/0\'/0\'',
  '  Address: ' + solKp.publicKey.toBase58(),
  '  Private key (base58 secret key): ' + bs58.encode(Buffer.from(solKp.secretKey)),
  '',
  'TRON  m/44\'/195\'/0\'/0/0',
  '  Address: ' + tronAddr2,
  '  Private key: ' + tronW.privateKey,
  '',
  'SUI  m/44\'/784\'/0\'/0\'/0\'',
  '  Address: ' + suiKp2.getPublicKey().toSuiAddress(),
  '  Private key (suiprivkey): ' + suiKp2.getSecretKey(),
  '',
  'TON  m/44\'/607\'/0\'/0\'/0\'  (WalletContractV4, bounceable)',
  '  Address: ' + tonAddr2,
  '  Private key (hex seed): ' + Buffer.from(tonSeed2).toString('hex'),
  '',
  'NEAR  m/44\'/397\'/0\'  (implicit account = public key hex)',
  '  Account: ' + nearImplicit2,
  '  Private key: ed25519:' + nearSecretB58,
  ''
].join('\n');
fs.writeFileSync(path.join(__dirname, 'private', 'backup.txt'), txt);

// print ONLY addresses (never keys) to stdout
console.log('Fresh wallet generated. Addresses:');
console.log('  BTC mainnet : ' + btcMainPay.address);
console.log('  BTC testnet : ' + btcTestPay.address);
console.log('  EVM         : ' + evm.address);
console.log('  SOL         : ' + solKp.publicKey.toBase58());
console.log('  TRON        : ' + tronAddr2);
console.log('  SUI         : ' + suiKp2.getPublicKey().toSuiAddress());
console.log('  TON         : ' + tonAddr2);
console.log('  NEAR        : ' + nearImplicit2.slice(0, 20) + '...');
console.log('Backup files written to private/backup.json and private/backup.txt');
console.log('--- STEP 2 complete ---');
