'use strict';
/**
 * Sniper v2 pair verification — READ ONLY, sends nothing.
 * For each chain: check whether a wrapped-native pair exists on the
 * chain's V2 factory, read its reserves, and quote a small round trip
 * both ways. Falls back to the AGNA pair where no wrapped-native pair
 * exists. Writes sniper/pairs-verification.json.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
  'function allPairsLength() external view returns (uint256)',
  'function allPairs(uint256) external view returns (address pair)',
];
const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
];
const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function totalSupply() external view returns (uint256)',
];

const CHAINS = {
  sepolia: {
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    factory: '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
    router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    candidates: [
      { name: 'WETH/USDC', tokenA: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', tokenB: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', testBuyIn: '0.00005', buyIsNative: true },
    ],
  },
  'arc-testnet': {
    rpc: 'https://arc-testnet-rpc.publicnode.com',
    factory: '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d',
    router: '0x96ec1BE94202E5F8b10123B1677A57E45b7BB9A7',
    candidates: [
      { name: 'USDC/WETH9', tokenA: '0x3600000000000000000000000000000000000000', tokenB: '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce', testBuyIn: '0.01', buyIsNative: false, buyDecimals: 6 },
    ],
    enumeratePairs: true,
  },
  'robinhood-testnet': {
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    factory: '0xe9f116220486AB52b8D245aF3C19de5C025Adea8',
    router: '0x4524D50c3fa8aeA4f44db5EA1e02753cB0A8ac58',
    candidates: [
      { name: 'WETH9/FUSD', tokenA: '0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09', tokenB: '0x1f93de989cd9d30b2c31f3227769632729858196', testBuyIn: '0.000005', buyIsNative: true },
      { name: 'WETH9/SPY', tokenA: '0xf04aD68aCCaf3f7170C5588692F15e02b1B4BE09', tokenB: '0x8823b40A23387Df76E127744FFB38b26eB012A5c', testBuyIn: '0.000005', buyIsNative: true },
    ],
    enumeratePairs: true,
  },
  'litvm-testnet': {
    rpc: 'https://rpc.testnet.liteforge.zeeve.net/',
    factory: '0x4AcDbaeE32c928A782056EF0b7bA58FE06ffCbce',
    router: '0x87125aBCE7a1d6e675AC0C0dE07283C4105daF1d',
    candidates: [],
    enumeratePairs: true,
  },
};
const AGNA = {
  sepolia: '0xA69000408A00F35F70C5dD5f73e8c687514BF522',
  'arc-testnet': '0xa69000Fb025DDe35F126332331c2746979845E56',
  'robinhood-testnet': '0xa69000FF81232ac079eC2265fD4da3100F243fc3',
  'litvm-testnet': '0xa69000FF81232ac079eC2265fD4da3100F243fc3',
};
const AGNA_PAIR = {
  sepolia: '0x43E54E53dafe9467725be66Aa34d799d0Ff6F630',
  'arc-testnet': '0xba3746f46Fbfe22E4E17083F1769b359A0b8956a',
  'robinhood-testnet': '0x699d97ACc97bB067842Bbe8CE89dC52d805D0a22',
  'litvm-testnet': '0xE887AaA2f85Ed40e68A5cf19F986EC460ccCC7E9',
};

async function checkPair(provider, router, factory, cand) {
  const out = { name: cand.name, tokenA: cand.tokenA, tokenB: cand.tokenB, exists: false };
  const pairAddr = await factory.getPair(cand.tokenA, cand.tokenB);
  if (pairAddr === ethers.ZeroAddress) return out;
  out.exists = true;
  out.pair = pairAddr;
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [t0, t1, res] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  out.token0 = t0; out.token1 = t1;
  out.reserve0 = res[0].toString(); out.reserve1 = res[1].toString();
  // Token metadata for both sides.
  for (const [key, addr] of [['tokenA', cand.tokenA], ['tokenB', cand.tokenB]]) {
    try {
      const t = new ethers.Contract(addr, ERC20_ABI, provider);
      const [sym, dec, sup] = await Promise.all([t.symbol(), t.decimals(), t.totalSupply()]);
      out[key + 'Meta'] = { symbol: sym, decimals: Number(dec), totalSupply: sup.toString() };
    } catch (e) { out[key + 'Meta'] = { error: (e.shortMessage || e.message || '').slice(0, 120) }; }
  }
  // Quote a small round trip both ways (buy side A->B, then sell B->A).
  try {
    const buyIn = cand.buyIsNative
      ? ethers.parseEther(cand.testBuyIn)
      : ethers.parseUnits(cand.testBuyIn, cand.buyDecimals ?? 18);
    const buyOut = await router.getAmountsOut(buyIn, [cand.tokenA, cand.tokenB]);
    out.buyQuote = { in: buyIn.toString(), out: buyOut[1].toString() };
    const sellOut = await router.getAmountsOut(buyOut[1], [cand.tokenB, cand.tokenA]);
    out.sellQuote = { in: buyOut[1].toString(), out: sellOut[1].toString() };
    out.roundTripReturnBps = buyIn > 0n ? Number((sellOut[1] * 10000n) / buyIn) : 0;
  } catch (e) { out.quoteError = (e.shortMessage || e.message || '').slice(0, 200); }
  return out;
}

async function main() {
  const result = { version: 2, verifiedAt: new Date().toISOString(), chains: {} };
  for (const [key, c] of Object.entries(CHAINS)) {
    const provider = new ethers.JsonRpcProvider(c.rpc);
    const factory = new ethers.Contract(c.factory, FACTORY_ABI, provider);
    const router = new ethers.Contract(c.router, ROUTER_ABI, provider);
    const entry = { factory: c.factory, router: c.router, candidates: [] };
    if (c.enumeratePairs) {
      try {
        const n = Number(await factory.allPairsLength());
        entry.factoryPairsCount = n;
        entry.factoryPairs = [];
        for (let i = 0; i < n; i++) {
          const p = await factory.allPairs(i);
          const pc = new ethers.Contract(p, PAIR_ABI, provider);
          const [t0, t1, res] = await Promise.all([pc.token0(), pc.token1(), pc.getReserves()]);
          entry.factoryPairs.push({ pair: p, token0: t0, token1: t1, reserve0: res[0].toString(), reserve1: res[1].toString() });
        }
      } catch (e) { entry.enumerateError = (e.shortMessage || e.message || '').slice(0, 200); }
    }
    for (const cand of c.candidates) {
      entry.candidates.push(await checkPair(provider, router, factory, cand));
    }
    // Always record the AGNA fallback pair's current reserves.
    const agnaPair = new ethers.Contract(AGNA_PAIR[key], PAIR_ABI, provider);
    const [r0, r1] = await (async () => { const r = await agnaPair.getReserves(); return [r[0].toString(), r[1].toString()]; })();
    entry.agnaFallback = { token: AGNA[key], pair: AGNA_PAIR[key], reserve0: r0, reserve1: r1 };
    result.chains[key] = entry;
    console.log(`--- ${key} ---`);
    console.log(JSON.stringify(entry, null, 2));
  }
  fs.writeFileSync(path.join(__dirname, 'pairs-verification.json'), JSON.stringify(result, null, 2));
  console.log('WROTE pairs-verification.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
