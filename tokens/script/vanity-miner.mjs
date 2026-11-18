// vanity-miner.mjs — Node fallback for the CREATE2 vanity salt miner.
//
// Same job as vanity-miner.c (find a 32-byte salt so the CREATE2 address
// starts with a given hex prefix), same CLI and same one-line output,
// but pure Node + ethers. It is ~25x slower than the C miner (ethers
// keccak256 manages ~26k hashes/s on this VM, so a 0xa69000 salt takes
// ~11 minutes instead of ~30 seconds). Use the C miner when gcc is
// available; this file exists so the deploy flow works on machines
// without a C toolchain.
//
// Usage:
//   node vanity-miner.mjs --deployer 0x... --init-code-hash 0x... [--prefix a69000] [--start 0]
//
// Output on success (stdout, one line, machine-readable):
//   SALT=0x... ADDRESS=0x... TRIES=12345678 ELAPSED_S=123.45 RATE=26000
import { ethers } from "ethers";

function parseArgs(argv) {
  const out = { prefix: "a69000", start: 0n };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--deployer") out.deployer = argv[++i];
    else if (a === "--init-code-hash") out.initCodeHash = argv[++i];
    else if (a === "--prefix") out.prefix = argv[++i];
    else if (a === "--start") out.start = BigInt(argv[++i]);
    else if (a === "--threads") { i++; /* accepted for CLI parity; Node version is single-threaded */ }
    else { throw new Error(`unknown argument: ${a}`); }
  }
  if (!out.deployer || !out.initCodeHash) {
    throw new Error(
      "usage: node vanity-miner.mjs --deployer 0x... --init-code-hash 0x... [--prefix a69000] [--start 0]",
    );
  }
  return out;
}

const { deployer, initCodeHash, prefix, start } = parseArgs(process.argv.slice(2));
const want = prefix.toLowerCase().replace(/^0x/, "");
console.error(`mining prefix 0x${want} for deployer ${deployer} (node fallback, single-threaded)`);

const t0 = Date.now();
let salt = start;
let tries = 0n;
for (;;) {
  const saltHex = "0x" + salt.toString(16).padStart(64, "0");
  const addr = ethers.getCreate2Address(deployer, saltHex, initCodeHash);
  tries++;
  if (addr.toLowerCase().startsWith("0x" + want)) {
    const elapsed = (Date.now() - t0) / 1000;
    console.log(
      `SALT=${saltHex} ADDRESS=${addr} TRIES=${tries} ELAPSED_S=${elapsed.toFixed(2)} RATE=${(Number(tries) / elapsed).toFixed(0)}`,
    );
    break;
  }
  salt++;
  if (tries % 100000n === 0n) {
    const elapsed = (Date.now() - t0) / 1000;
    console.error(`  ... ${tries} tries in ${elapsed.toFixed(0)}s (${(Number(tries) / elapsed).toFixed(0)}/s)`);
  }
}
