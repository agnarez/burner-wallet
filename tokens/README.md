# ERC-20 Token Launcher

A Foundry project that deploys an OpenZeppelin-based ERC-20 with a
**capped, transparent transfer tax** split three ways: **burn**,
**buyback-and-burn**, and **auto-liquidity**. Built for agnarez's
burner-wallet project. Testnet first — mainnet launch is the user's
own call, never automatic.

## How the tax works

Every transfer between non-excluded addresses pays a tax (default **5%**,
hard-capped at **10%** — the cap is a constant in the contract, no owner
can ever raise it). The tax is split:

| Share | Default | What happens |
|---|---|---|
| Burn | 40% of the tax | Burned immediately, supply shrinks |
| Buyback | 30% of the tax | Tokens pile up in the contract; anyone may call `processBuyback()` to sell them for the quote asset, buy tokens back on the market, and burn what was bought |
| Liquidity | 30% of the tax | Tokens pile up; anyone may call `addLiquidity()` to swap half for the quote asset and add both halves as liquidity (LP tokens go to the owner) |

Split dust from integer division goes to the liquidity share, so
burn + buyback + liquidity always equals the tax exactly — nothing is
ever lost to rounding.

**Excluded from tax by default:** the owner (deployer), the contract
itself (internal reserve moves must stay untaxed), and the router.
The owner can exclude/un-exclude other addresses with `setExcluded()`,
except the contract itself.

## Why this is not a honeypot

Read the contract — everything is public and there is nothing hidden:

- **No mint function.** Supply is fixed at deploy. It can only go down (burns).
- **No blacklist, no pause, no max-transaction, no trading toggle.** Any
  address can buy, sell, and transfer at any time.
- **Tax capped at 10% forever** (`MAX_TAX_BPS = 1000`, a constant).
  `setTax()` reverts above it, and the three shares must sum to exactly
  10000 (100% of the tax).
- **Owner can renounce.** After `renounceOwnership()` the tax, router,
  and exclusions can never change again — while `processBuyback()` and
  `addLiquidity()` stay callable by anyone.
- **Buyback / LP are permissionless.** No keeper key, no owner-only
  processing.
- **Two honest limits:** swaps use `amountOutMin = 0`, so a public
  buyback/LP call on mainnet could be sandwiched — mainnet needs
  slippage protection or a trusted keeper. And LP tokens go to the
  owner — on mainnet they should go to a locker (e.g. Unicrypt) or be
  burned, not sit in a wallet.

The unit tests (`forge test`) prove all of the above, including fuzzed
tax math and low-level calls showing `mint()` / `blacklist()` do not
exist.

## Two quote modes

- **Native ETH path** (`quoteToken == address(0)`): swaps go through
  the router's WETH. Used on Sepolia, Base Sepolia, Robinhood testnet.
- **ERC-20 quote path** (`quoteToken != address(0)`): swaps go
  token ↔ quote token. Used on **Arc**, where USDC is the native gas
  token and the router's WETH paths revert — the quote token is the
  USDC predeploy `0x3600000000000000000000000000000000000000`.

The router is optional at deploy: with `router == address(0)` the
token deploys fine, tax + burn work, and `processBuyback()` /
`addLiquidity()` revert with `RouterNotSet` until the owner sets a
verified router with `setRouter()`.

## Chains & wallets (verified live 2026-11-18)

| Chain | Chain ID | Gas | Router (V2-style) | Deployable |
|---|---|---|---|---|
| **Arc Testnet** (primary) | 5042002 | USDC native — burner 80, agent 20 | none verified — mainnet router/factory hold no code here | ✅ burner deploys |
| **Sepolia** | 11155111 | ETH — **burner 0.05** (funded by agnarez, tx `0x2af1f29f…c035`, receipt 0x1), agent 0 | `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3` — verified (WETH + factory check out) | ✅ burner deploys |
| Robinhood testnet | 46630 | ETH — burner 0.01005 | none verified — mainnet addresses hold no code here | ✅ burner deploys (router empty) |
| Base Sepolia | 84532 | ETH — both wallets 0 | none — the Base mainnet router address holds code but `WETH()`/`factory()` revert, so it is NOT a V2 router | ❌ no gas — do not deploy |

Robinhood testnet's public RPC is verified working: `https://rpc.testnet.chain.robinhood.com` (chainId 46630), explorer API `https://explorer.testnet.chain.robinhood.com/api/v2/`.

**Wallet roles:** the **burner wallet** (`0x6F31…7621`) is the
deployer — we hold its key, so it signs. The **Circle agent wallet**
(`0xd305…53cf7`) is MPC-held by Circle with no exportable key: it can
only move USDC via the Circle CLI and act as a holder/recipient (it
receives its allocation at deploy). Nothing in this project ever needs
its raw private key — there isn't one.

**Gas gap (Base Sepolia):** both wallets hold 0 ETH and the Circle
faucet only gives USDC, not ETH. The deploy script refuses
non-deployable chains. Do not go fetch ETH gas yourself — that is
agnarez's call.

## Quick start

```bash
cd tokens
forge build
forge test
```

Deploy (testnet only — never mainnet from here):

```bash
cp .env.example .env   # put the BURNER deployer key in PRIVATE_KEY, never commit .env
source .env
# Arc Testnet (default, primary)
forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL --broadcast
# Sepolia (burner holds 0.05 ETH)
CHAIN_ID=11155111 forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
# Dry run first (no broadcast) to check the deployment:
forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL
```

The script writes the deployment to `deployments/<chainId>.json`
(token address, deployer, agent allocation, router, quote token).

After deploy, the owner can:

```bash
# Point at a verified router once one exists on that chain:
cast send <token> "setRouter(address)" <router> --private-key $PRIVATE_KEY --rpc-url $RPC
# Watch reserves build up, then anyone can process them:
cast send <token> "processBuyback()" --private-key $PRIVATE_KEY --rpc-url $RPC
cast send <token> "addLiquidity()" --private-key $PRIVATE_KEY --rpc-url $RPC
# When the token is trusted, renounce ownership so the tax can never change:
cast send <token> "renounceOwnership()" --private-key $PRIVATE_KEY --rpc-url $RPC
```

## Files

| File | What it is |
|---|---|
| `src/TaxToken.sol` | The token: ERC-20 + capped tax + burn/buyback/LP |
| `src/interfaces/IUniswapV2Router02.sol` | Minimal V2-style router interface |
| `script/Deploy.s.sol` | Deploy script, driven by `config/token-config.json` |
| `config/token-config.json` | Token params, wallets, per-chain router/gas status |
| `test/TaxToken.t.sol` | 17 tests: tax math (+fuzz), burn, buyback, LP, anti-honeypot |
| `test/mocks/MockRouter.sol` | 1:1 mock V2 router for tests |
| `test/mocks/MockERC20.sol` | Mintable ERC-20 stand-in (WETH / USDC) for tests |
| `deployments/` | Deployment receipts, one JSON per chain |

## Risks — read before any mainnet launch

- **It needs real liquidity on mainnet.** A tax token with no pool is
  untradeable; the first pool needs real tokens + real quote asset
  from the deployer, and that money is at risk.
- **Tax tokens look like honeypots to strangers.** The only defence is
  staying clean and transparent: fixed supply, no mint/blacklist,
  capped tax, verified source on the explorer, renounced ownership
  once the parameters are final. Even then, strangers may not trust it.
- **Buyback/LP calls can be sandwiched** (`amountOutMin = 0`).
  Mainnet needs slippage limits or a keeper.
- **LP tokens go to the owner.** On mainnet, lock them or burn them.
- **Mainnet launch is agnarez's call.** This repo deploys to testnets
  only. Nothing here spends real money.

## Still needs a decision

- Token name, symbol, total supply, and the agent wallet's allocation %
  (placeholders in `config/token-config.json`: "Burner Test Token" /
  `BURN` / 1,000,000,000 / 10%).
- Tax rate and split (placeholders: 5% total, 40% burn / 30% buyback /
  30% LP).
- Which chain launches first (Arc Testnet primary, Sepolia ready too).
- A verified V2-style router on Arc Testnet / Robinhood testnet, if
  buyback/LP must run there (or deploy a test DEX / use Sepolia where
  the router is verified).
- Initial liquidity plan: how much of the supply + quote asset seeds
  the first pool, and where the LP tokens go (locker vs burn).
- Whether to renounce ownership after launch.
