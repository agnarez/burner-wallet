# Burner Wallet Sniper

On-chain sniper tool for the burner wallet: watches for new token launches
on a DEX (Uniswap V2-style `PairCreated` events), buys immediately, and
sells on a configured exit (take-profit, stop-loss, or max hold time).

**Dry-run is ON by default.** In dry-run the tool only logs what it *would*
do — it never sends a transaction. Live trading needs `DRY_RUN=false` and
the burner wallet's private key in the environment.

## Two wallets, two roles

| Wallet | Address | Role |
|---|---|---|
| Burner wallet | `0x6F311641923246e7f4fE2F1F679c75f4DE107621` | **Operator / signer.** We hold its key, so it signs trades. |
| Circle agent wallet | `0xd305dc7b4f3c4dc0cf1da53bf20cd96ad1653cf7` | **Holder / profit recipient.** MPC-held by Circle — there is **no exportable private key**. It can only move USDC via the Circle CLI (`circle wallet ...`). Sell proceeds go here by default (`PROFIT_RECIPIENT`). |

Nothing in this tool ever asks for the agent wallet's key, because none
exists. If a flow needs the agent wallet to move funds, that happens
through `circle wallet ...`, not here.

## Chains and gas — verified live 2026-11-18

| Chain | Gas token | Burner | Agent wallet | DEX status |
|---|---|---|---|---|
| **Arc Testnet** (default, primary) | USDC (native) | 80 USDC | 20 USDC | **No V2-style DEX** at the checked addresses (canonical + Eco-docs Arc addresses — no code). Watcher stays off until a DEX is configured. |
| Robinhood Chain testnet | testnet ETH | 0.01005 ETH | — (doesn't exist here) | **No V2 on testnet** at the Uniswap-listed addresses (mainnet-only deployment). |
| Sepolia | ETH | **0.05 ETH** | 0 ETH | Uniswap V2 **is** deployed — Sepolia-specific addresses (factory `0xF62c…`, router `0xeE56…`, 18,772 pairs, verified live). The burner has gas — funded by agnarez himself ([tx](https://sepolia.etherscan.io/tx/0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035)) — so Sepolia is a usable live testnet target alongside Arc Testnet. |
| Base Sepolia | ETH | 0 ETH | 0 ETH | **No V2** at the known addresses (factory has no code; the contract at the mainnet router address isn't a V2 router). No gas either. |
| LitVM testnet ("LiteForge") | zkLTC | **0.05 zkLTC** (claimed 2026-11-18, [tx](https://explorer.testnet.liteforge.zeeve.net/tx/0xa40ea16a88a550c83031b0c7dce297648d080d1547bd0e82663b48a75ca2cf23)) | 0 zkLTC | **No V2 verified** on LitVM yet — config only until a DEX is found. Burner has gas now. |

Balances only grow from here: the faucet job tops both wallets up with 20
USDC per chain every 2 hours. The Sepolia / Base Sepolia gas gap is
partial: the burner holds 0.05 ETH on Sepolia (verified live — enough for
testnet trades), but 0 ETH on Base Sepolia, and the agent wallet holds 0
ETH on both. The Circle faucet gives USDC, not ETH. This tool does **not**
try to obtain ETH gas itself. If ETH gas is ever funded on Base Sepolia,
point the tool at a V2-style deployment there first — none is known.

On Arc, USDC is the native gas token: native balances are 18-decimal
(80 USDC shows as `80e18`), while ERC-20 USDC transfer amounts are
6-decimal. Buy sizes in this tool are in native units.

## Setup

```bash
cd sniper
npm install
cp .env.example .env
# edit .env — for dry-run, nothing else is needed.
```

The private key is read **only** from the `PRIVATE_KEY` environment
variable, and only the burner's key. `.env` is gitignored. Never commit a
key, a seed phrase, or a backup file.

## Run

```bash
# Watch for new launches (default chain: Arc Testnet)
npm start
# or: node src/index.js --chain sepolia

# Manual buy / sell / buy-then-sell cycle for a known token
npm run manual -- buy   --token 0x... [--amount 0.01]
npm run manual -- sell  --token 0x... [--percent 100]
npm run manual -- cycle --token 0x... [--amount 0.01]
```

On Arc Testnet / Robinhood testnet / LitVM testnet today, `npm start` prints the wallet +
gas status and stops with guidance, because no DEX is configured there
yet. To point it at a V2-style deployment when one appears, set in `.env`:

```
FACTORY_ADDRESS=0x...
ROUTER_ADDRESS=0x...
BASE_TOKEN_ADDRESS=0x...   # the token pairs launch against (e.g. wrapped USDC)
```

## Config

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN` | `arc-testnet` | `arc-testnet` / `robinhood-testnet` / `sepolia` / `base-sepolia` |
| `PRIVATE_KEY` | — | Burner wallet key. Empty = dry-run only. |
| `BURNER_WALLET_ADDRESS` | `0x6F31…` | Signer. The tool refuses a key that belongs to another address. |
| `AGENT_WALLET_ADDRESS` | `0xd305…` | Holder. Never signs. |
| `PROFIT_RECIPIENT` | agent wallet | Where sell proceeds go. |
| `DRY_RUN` | `true` | `false` to actually trade. |
| `BUY_AMOUNT_NATIVE` | `0.01` | Buy size per snipe, in native token (USDC on Arc, ETH elsewhere). |
| `SLIPPAGE_BPS` | `500` | Max slippage, basis points (500 = 5%). |
| `MAX_GAS_GWEI` | `100` | Never pay more than this; above it, the buy is skipped. |
| `TAKE_PROFIT_PCT` | `50` | Sell at +50%. |
| `STOP_LOSS_PCT` | `20` | Sell at −20%. |
| `MAX_HOLD_SECONDS` | `3600` | Sell after 1h no matter what. |
| `MIN_BASE_LIQUIDITY` | `0.1` | Only snipe pairs launching with at least this much base-token liquidity. |
| `FACTORY_ADDRESS` / `ROUTER_ADDRESS` / `BASE_TOKEN_ADDRESS` | per-chain | DEX overrides. |

Live-mode guards: the tool refuses to start live without a key, refuses a
key that doesn't belong to the burner wallet, and refuses live trading
when the burner holds no gas on the selected chain.

## Tests

```bash
npm test
```

- `test/strategy.test.js` — unit tests for the buy/sell decision logic.
- `test/config.test.js` — defaults, both wallets, validation.
- `test/dryrun.test.js` — live checks against public testnet RPCs
  (read-only, nothing is sent): chain IDs, both wallets' Arc balances,
  Robinhood gas, Sepolia V2 deployment, and a dry-run buy quote + unsigned
  transaction build on Sepolia.

## Honest risks — read before going live

- **Gas costs.** Every trade costs gas, win or lose. On mainnet that is
  real money, every single transaction, including failed ones.
- **Most sniped launches lose money.** New tokens are where honeypots,
  rug pulls, and buy/sell taxes live. A snipe can buy a token that can
  never be sold. This tool does not check for honeypots — it only checks
  liquidity and price movement.
- **Manufactured volume is wash trading.** Buying and selling to yourself
  (or between your own wallets) to create daily transaction volume is
  wash trading. Airdrop and activity programs can detect it and flag or
  ban the wallet. Use this tool to trade, not to fake activity.
- **Slippage and frontrunning.** Snipes race other bots; a buy can land
  at a far worse price than quoted, or fail after paying gas.
- **Testnet first, tiny amounts first.** Nothing here has been proven
  with a real transaction yet — the tests are dry-run only. Try it on
  testnet with tiny amounts before any mainnet use. Mainnet use is the
  user's own call; this tool defaults to testnet and ships no mainnet
  configuration.
