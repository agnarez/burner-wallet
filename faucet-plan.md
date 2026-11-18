# Burner Wallet — Faucet Plan

Testnet tokens only — for testing sends, swaps and the dashboard. No real money value. Nothing here costs anything.

## Claimed so far (2026-11-18, first round)

| Network | Token | Amount | Proof |
|---|---|---|---|
| Ethereum Sepolia | USDC (testnet) | 20 | Tx 0xe7eeff8c37fe6df4ddd837f6ed1f38a7ea49f7b298bf276754df5c686c91f92b — receipt verified on-chain, status success |
| Base Sepolia | USDC (testnet) | 20 | Confirmation page said "Tokens sent"; no tx hash shown |
| Arc Testnet | USDC (testnet) | 20 | Tx 0x6b07ff25d2f43de493cd40efbb1062f4c9345e388f0b7cc95621749a8ad6e644 — confirmed on screen; receipt check timed out, re-verify next run |
| Bitcoin testnet4 | tBTC | 0.00046 | Confirmed on-chain: 46,000 sats, 1 tx |
| Robinhood Chain testnet | testnet ETH + stock tokens | 0.01 ETH + 5 each TSLA/AMZN/PLTR/NFLX/AMD | Claimed manually by agnarez 2026-11-18 to the burner address (contract call sendTokensAndEther from his own wallet 0xF691…); verified on-chain in the burner |

## Auto-claimed daily (no login, no captcha)

| Faucet | Gives | Cooldown | Address used |
|---|---|---|---|
| faucet.circle.com | 20 testnet USDC per chain (Arc, Base Sepolia, Sepolia) | 2 hours | 0x6F311641923246e7f4fE2F1F679c75f4DE107621 |
| testnet-faucet.com | BTC testnet4 (amount varies) | not stated (IP-limited) | tb1qu487485kq4p2lald5khy47v4ckquzynuvql4qx |

Daily job: **Burner Wallet Faucet Claims**, every morning ~10:00 WIB. Re-claims the two above, verifies on-chain (Sepolia receipt + mempool testnet4 balance), reports what landed.

## Manual only — needs the user (captcha / login / wallet connect)

| Faucet | Gives | Why manual |
|---|---|---|
| faucet.solana.com | 0.5–5 SOL devnet, max 2 per 8h | Cloudflare captcha |
| cloud.google.com/application/web3/faucet | Sepolia 0.05 ETH, Hoodi 1 ETH, PYUSD 100, + more | Google sign-in + min 0.001 mainnet ETH |
| faucets.chain.link | 0.5 ETH per network, 25 LINK, 0.5 AVAX Fuji | Connect wallet (MetaMask / WalletConnect / Coinbase) |
| Polygon faucet (via docs.polygon.technology) | Amoy POL / Sepolia ETH | Cloudflare captcha |
| faucet.testnet.chain.robinhood.com | 0.01 testnet ETH + 5 each TSLA/AMZN/PLTR/NFLX/AMD stock tokens, 24h | Cloudflare + Google sign-in |
| faucet.zalalena.com/robinhood | 0.005 Robinhood Chain testnet ETH, 10/day | hCaptcha + Cloudflare |
| chainstack.com/faucets | up to 0.5 Sepolia ETH / 24h | API key + min 0.08 mainnet ETH |
| tools.gizmolab.io/faucet | 0.5 SOL devnet / 4h | Wallet connect + email + sign message |
| thirdweb faucet | 0.01 Sepolia ETH / day | Connect wallet |
| CDP faucet (via Base docs) | up to 0.1 Base Sepolia ETH / 24h + USDC/EURC/cbBTC | Coinbase sign-in |
| Alchemy faucets | 0.1 Sepolia ETH / 0.1 Amoy POL, 24h | Free Alchemy account |

## Directories (not faucets themselves)

- faucetlink.to — faucet directory (Sepolia list incl. Alchemy 0.1, QuickNode 0.25–1.0, GetBlock 0.1, Tatum 0.002; most need a mainnet balance)
- thirdweb.com/chainlist/testnets — directory of 1,523 testnets
- blockchair.com/awesome/faucets — directory; its testnet entry is testnet-faucet.com (claimed above)
- ethereum.org/developers/docs/networks/#sepolia — Sepolia guide + faucet list
- docs.base.org/get-started/get-funds — Base Sepolia faucet guide
- docs.polygon.technology/tools/gas/matic-faucet — Polygon faucet guide

## Testnet addresses (burner wallet)

- Bitcoin testnet: tb1qu487485kq4p2lald5khy47v4ckquzynuvql4qx
- EVM testnets: 0x6F311641923246e7f4fE2F1F679c75f4DE107621
- Solana devnet: 9QMdu5ENdobub4ZkwB2tyNEx9PqPRQ4EHsZKG6MGYENU
- SUI testnet: 0x0b82bc539a2ef944d3ee04799253ed960bd318d6088389eb5916352cb73af69e
- TRON Nile: TH4h7KTc55KCjXNwWtRVuiaZyCeg1rMFo8
- TON testnet: kQAzTI-eWYDj4doIRmozWtvLTkALBX6PqWTLkUojRDhuDBpi
- NEAR testnet: 7d392d7c46c922de68361f6594f43d52d0838ee59a6978aa76430052d5dcd64a

No faucet visited dispensed SUI, TRON, TON or NEAR testnet tokens via a paste-address form. If agnarez wants those, the manual routes are their chains' own faucets (SUI testnet faucet, TRON Nile faucet, TON testnet faucet, NEAR testnet faucet) — ask before adding them.
