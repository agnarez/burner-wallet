"use strict";
// nonce-tracker.cjs — local nonce tracking for burner-signed scripts.
//
// WHY THIS EXISTS: ethers v6 fetches the nonce with the "pending" tag by
// default, and Anvil's "pending" nonce is unreliable right after a mined
// transaction — it has returned a STALE value twice in this repo's e2e
// (the second tx from the same signer was sent with the first tx's nonce
// and rejected with NONCE_EXPIRED / "nonce has already been used").
// The "latest" tag can lag briefly too, right after a block is mined.
//
// The fix: read the nonce ONCE while the account is quiescent (polling
// until two consecutive reads agree), then increment locally and pass
// the nonce explicitly on every send. This is safe here because each
// script is the ONLY sender from the burner key while it runs — no
// other process sends from this key concurrently. If a send fails, the
// script aborts, so a "gap" from a rejected broadcast can never cause
// a later tx to fail.
//
// Usage:
//   const { NonceTracker } = require("./nonce-tracker.cjs");
//   const nonces = new NonceTracker(provider, deployerAddress);
//   const startNonce = await nonces.init();      // stable read
//   const tx = await contract.method(a, b, { nonce: nonces.take() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NonceTracker {
  constructor(provider, address) {
    this.provider = provider;
    this.address = address;
    this.next = null;
  }

  // Read the on-chain nonce until it is stable: two consecutive reads
  // 100 ms apart must agree. Returns the stable nonce and seeds the
  // local counter. Call once, before sending anything.
  async stableRead() {
    let a = Number(await this.provider.getTransactionCount(this.address, "latest"));
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const b = Number(await this.provider.getTransactionCount(this.address, "latest"));
      if (b === a) return b;
      a = b;
    }
    return a; // still moving after 2s — return the last read; caller decides
  }

  async init() {
    this.next = await this.stableRead();
    return this.next;
  }

  // Re-read the on-chain nonce and reset the counter — call after
  // another process has sent txs from this address (e.g. the e2e after
  // a child pool-script run), so the counter does not go stale.
  async resync() {
    this.next = await this.stableRead();
    return this.next;
  }

  // Take the next nonce for a send, advancing the counter. Only call
  // when the tx is actually about to be sent; on send failure the
  // script aborts, so the counter is never reused after a gap.
  take() {
    if (this.next === null) throw new Error("NonceTracker.init() must be called before take()");
    return this.next++;
  }
}

module.exports = { NonceTracker };
