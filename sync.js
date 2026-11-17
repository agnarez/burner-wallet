// Burner wallet background sync — READ-ONLY.
// Reads ONLY the public addresses from private/backup.json (never the keys)
// and fetches balances (+ recent activity where the API gives it cheaply)
// from public endpoints. Writes public-safe results to sync-status.json.
// Run: node sync.js
const fs = require('fs');
const path = require('path');

const BACKUP = path.join(__dirname, 'private', 'backup.json');
const OUT = path.join(__dirname, 'sync-status.json');

const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const A = {};
for (const [k, v] of Object.entries(backup.chains)) A[k] = v.address || v.implicitAccount;

const EVM_RPCS = {
  ethereum: 'https://cloudflare-eth.com',
  bsc: 'https://bsc-dataseed.bnbchain.org',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  base: 'https://mainnet.base.org',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
};

async function jfetch(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function rpc(url, method, params) {
  return jfetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
const weiToEth = (hex) => (BigInt(hex) / BigInt(10) ** BigInt(18)).toString() + '.' + (BigInt(hex) % BigInt(10) ** BigInt(18)).toString().padStart(18, '0').replace(/0+$/, '') || '0';

async function check(name, fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 120) }; }
}

async function main() {
  const out = { checkedAt: new Date().toISOString(), wallet: 'burner-wallet', chains: {} };

  out.chains.bitcoin = await check('bitcoin', async () => {
    const d = await jfetch(`https://mempool.space/api/address/${A.bitcoin}`);
    const sats = (d.chain_stats.funded_txo_sum || 0) - (d.chain_stats.spent_txo_sum || 0);
    return { address: A.bitcoin, balanceBTC: sats / 1e8, txCount: d.chain_stats.tx_count || 0 };
  });

  out.chains.evm = {};
  for (const [chain, url] of Object.entries(EVM_RPCS)) {
    out.chains.evm[chain] = await check(chain, async () => {
      const r = await rpc(url, 'eth_getBalance', [A.ethereum_evm, 'latest']);
      return { address: A.ethereum_evm, balance: weiToEth(r.result || '0x0') };
    });
  }

  out.chains.solana = await check('solana', async () => {
    const r = await rpc('https://api.mainnet-beta.solana.com', 'getBalance', [A.solana]);
    const sigs = await rpc('https://api.mainnet-beta.solana.com', 'getSignaturesForAddress', [A.solana, { limit: 3 }]);
    return { address: A.solana, balanceSOL: (r.result?.value || 0) / 1e9, recentTx: (sigs.result || []).map((s) => s.signature) };
  });

  out.chains.tron = await check('tron', async () => {
    const d = await jfetch(`https://api.trongrid.io/v1/accounts/${A.tron}`);
    const acc = (d.data || [])[0] || {};
    return { address: A.tron, balanceTRX: (acc.balance || 0) / 1e6 };
  });

  out.chains.sui = await check('sui', async () => {
    const r = await rpc('https://fullnode.mainnet.sui.io:443', 'suix_getBalance', [A.sui, '0x2::sui::SUI']);
    return { address: A.sui, balanceSUI: (Number(r.result?.totalBalance || 0)) / 1e9 };
  });

  out.chains.ton = await check('ton', async () => {
    const d = await jfetch(`https://toncenter.com/api/v2/getAddressBalance?address=${A.ton}`);
    return { address: A.ton, balanceTON: (Number(d.result || 0)) / 1e9 };
  });

  out.chains.near = await check('near', async () => {
    const r = await rpc('https://rpc.mainnet.near.org', 'query', { request_type: 'view_account', account_id: A.near, finality: 'final' });
    return { address: A.near, balanceNEAR: (Number(r.result?.amount || 0)) / 1e24 };
  });

  // ---- Testnet: faucet funds (auto background sync also watches these) ----
  out.testnet = {};

  out.testnet.bitcoinTestnet4 = await check('bitcoinTestnet4', async () => {
    const d = await jfetch(`https://mempool.space/testnet4/api/address/${A.bitcoin_testnet}`);
    const sats = (d.chain_stats.funded_txo_sum || 0) - (d.chain_stats.spent_txo_sum || 0);
    return { address: A.bitcoin_testnet, balanceBTC: sats / 1e8, txCount: d.chain_stats.tx_count || 0 };
  });

  // EVM testnet token balances via Blockscout (no contract address guessing:
  // the explorer lists every token the address holds).
  const TESTNETS = {
    sepolia: 'https://eth-sepolia.blockscout.com',
    baseSepolia: 'https://base-sepolia.blockscout.com',
    arc: 'https://testnet.arcscan.app',
  };
  const TESTNET_RPCS = {
    sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
    baseSepolia: 'https://base-sepolia-rpc.publicnode.com',
    arc: 'https://rpc.testnet.arc.network',
  };
  for (const [name, base] of Object.entries(TESTNETS)) {
    out.testnet[name] = await check(name, async () => {
      const toks = await jfetch(`${base}/api/v2/addresses/${A.ethereum_evm}/token-balances`);
      const tokens = (Array.isArray(toks) ? toks : []).map((t) => ({
        symbol: t.token.symbol,
        balance: Number(t.value) / 10 ** Number(t.token.decimals || 0),
        contract: t.token.address_hash,
      }));
      let native = null;
      try {
        const r = await rpc(TESTNET_RPCS[name], 'eth_getBalance', [A.ethereum_evm, 'latest']);
        native = weiToEth(r.result || '0x0');
      } catch (e) { native = 'ERR'; }
      return { address: A.ethereum_evm, native, tokens };
    });
  }

  // never write keys: only addresses + balances
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const summary = Object.entries(out.chains).map(([k, v]) => {
    if (k === 'evm') {
      const parts = Object.entries(v).map(([c, r]) => `${c}:${r.ok ? r.balance : 'ERR'}`).join(' ');
      return `EVM[${parts}]`;
    }
    return `${k}:${v.ok ? (v.balanceBTC ?? v.balanceSOL ?? v.balanceTRX ?? v.balanceSUI ?? v.balanceTON ?? v.balanceNEAR ?? '?') : 'ERR'}`;
  });
  console.log('sync done @ ' + out.checkedAt);
  console.log(summary.join(' | '));
  const tSummary = Object.entries(out.testnet || {}).map(([k, v]) => {
    if (!v.ok) return `${k}:ERR`;
    if (k === 'bitcoinTestnet4') return `${k}: ${v.balanceBTC} tBTC (${v.txCount} tx)`;
    const toks = (v.tokens || []).map((t) => `${t.balance} ${t.symbol}`).join(', ') || 'no tokens';
    return `${k}: native ${v.native} | ${toks}`;
  });
  console.log('testnet: ' + tSummary.join(' | '));
  const errs = [];
  if (!out.chains.bitcoin.ok) errs.push('btc');
  if (!out.chains.solana.ok) errs.push('sol');
  if (!out.chains.tron.ok) errs.push('tron');
  if (!out.chains.sui.ok) errs.push('sui');
  if (!out.chains.ton.ok) errs.push('ton');
  if (!out.chains.near.ok) errs.push('near');
  for (const [c, r] of Object.entries(out.chains.evm)) if (!r.ok) errs.push('evm/' + c);
  if (errs.length) console.log('errors: ' + errs.join(', '));
}

main().catch((e) => { console.error('sync failed:', e.message); process.exit(1); });
