# Burner Wallet

A multi-chain burner wallet generated from a single mnemonic seed phrase, with a dashboard that runs entirely in your browser.

**By [agnarez](https://github.com/agnarez)** — developer, researcher, Bitcoin puzzle hunter.

## Chains

One seed, one address per chain (standard BIP39 / BIP44 paths):

| Chain | Path | Address |
|---|---|---|
| Bitcoin SegWit | m/84'/0'/0'/0/0 | `bc1q…` |
| EVM (Ethereum, BSC, Polygon, Arbitrum, Optimism, Avalanche, Base) | m/44'/60'/0'/0/0 | `0x6F31…` (one address, all EVM chains) |
| Solana | m/44'/501'/0'/0' | `9QMdu5…` |
| TRON | m/44'/195'/0'/0/0 | `TH4h7K…` |
| SUI | m/44'/784'/0'/0'/0' | `0x0b82…` |
| TON | m/44'/607'/0'/0'/0' | `EQAzTI…` |
| NEAR | m/44'/397'/0' | implicit account |

Your addresses are in the dashboard after import. The seed phrase and private keys are **never** in this repo.

## Dashboard

`burner-wallet.html` — the wallet dashboard (also live on GitHub Pages at the repo's site). Import-only: it starts locked, you paste a seed phrase or import a backup file, and keys live only in browser memory until you lock it.

- Mainnet / testnet switch
- Every EVM chain at once, each with its native balance + USDC, auto-loaded
- Live balances with auto background sync (45s refresh, re-syncs when you come back to the tab)
- Receive with QR codes, in-browser sends for EVM + Solana
- Swap quotes (OpenOcean) + limit-order watches
- Custom ERC-20 import by contract address
- Remember-me: your seed can be stored encrypted with a password, in your browser only
- One-click backup downloads (JSON + keys.txt), built-in self-test

## Faucets

Testnet tokens for trying the wallet: see [faucet-plan.md](faucet-plan.md). Claimed so far: 20 testnet USDC each on Sepolia, Base Sepolia and Arc Testnet, plus 0.00046 testnet4 BTC. Testnet only, no real value.

## Scripts

- `generate.js` — generate + verify the wallet (test vectors first, then a fresh mnemonic). Requires Node.js 18+.
- `sync.js` — read-only background sync: checks the wallet's public addresses (mainnet + testnet) for balances and new transactions. Never touches private keys.

```bash
npm install
node generate.js   # test vectors + fresh wallet (prints addresses, saves backup to private/)
node sync.js       # balance check (writes sync-status.json)
```

## Safety

- This is a **burner** wallet. Small amounts only, never a vault.
- The seed was generated on a shared machine — treat it as a burner, never long-term storage.
- Never share a seed phrase or private key with anyone, ever.
- TON note: this uses the standard multi-chain BIP44 path. It imports into Trust Wallet / SafePal etc., but Tonkeeper uses its own scheme, so the address differs there.
- Test on testnet first with tiny amounts before mainnet.

## Links

- GitHub: https://github.com/agnarez
- X: https://x.com/agnarez_
- Telegram / Farcaster: @agnarez
- Linktree: https://linktr.ee/agnarez
- Bitcoin Puzzle Hunt research: https://muse.ai/s/bitcoin-puzzle-hunt-research-xtxu6xa8ubzdgx0/axoghp0rB4ISigDvMiSogBS0IxjdLZeOHVcGPvN2LQQ
