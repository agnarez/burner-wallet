# ERC-20 Token Launcher — $AGNA (AGNAmuse)

A Foundry project that deploys an OpenZeppelin-based ERC-20 with a
**capped, transparent transfer tax** split three ways: **burn**,
**buyback-and-burn**, and **auto-liquidity**. Built for agnarez's
burner-wallet project. Testnet first — mainnet launch is the user's
own call, never automatic.

**The token is $AGNA (AGNAmuse)** — fixed supply **404T**
(404,000,000,000,000), no mint. 10% of the supply goes to the Circle
agent wallet at deploy (on chains where that wallet exists — see
below). The token deploys per chain, each chain minting its own 404T.

## How the tax works

The tax is **5%** (hard-capped at **10%** — the cap is a constant in
the contract, no owner can ever raise it) and it applies **only to
buys and sells**: a transfer **to** the liquidity-pool pair (a sell)
or **from** the pair (a buy). **Plain wallet-to-wallet transfers are
tax-free.**

The pair address is set by the owner with `setPair()` **after** the
pool is created — until then `pair == address(0)` and no transfer is
taxed. The pool script (`script/create-pool.cjs`) calls `setPair()`
automatically once the pool exists. The pair itself can never be
tax-excluded, or the trigger would silently stop working.

The tax is split:

| Share | Default | What happens |
|---|---|---|
| Burn | 40% of the tax | Burned immediately, supply shrinks |
| Buyback | 30% of the tax | Tokens pile up in the contract; anyone may call `processBuyback()` to sell them for the quote asset, buy tokens back on the market, and burn what was bought |
| Liquidity | 30% of the tax | Tokens pile up; anyone may call `addLiquidity()` to swap half for the quote asset and add both halves as liquidity (LP tokens go to the owner) |

Split dust from integer division goes to the liquidity share, so
burn + buyback + liquidity always equals the tax exactly — nothing is
ever lost to rounding.

**Excluded from tax by default:** the owner (deployer), the contract
itself (internal reserve moves must stay untaxed), and the router —
so the initial liquidity add and the agent allocation are never
taxed. The owner can exclude/un-exclude other addresses with
`setExcluded()`, except the contract itself and the pair.

## Why this is not a honeypot

Read the contract — everything is public and there is nothing hidden:

- **No mint function.** Supply is fixed at deploy. It can only go down (burns).
- **No blacklist, no pause, no max-transaction, no trading toggle.** Any
  address can buy, sell, and transfer at any time. Wallet-to-wallet
  transfers are tax-free.
- **Tax capped at 10% forever** (`MAX_TAX_BPS = 1000`, a constant).
  `setTax()` reverts above it, and the three shares must sum to exactly
  10000 (100% of the tax).
- **Owner can renounce.** After `renounceOwnership()` the tax, router,
  pair, and exclusions can never change again — while
  `processBuyback()` and `addLiquidity()` stay callable by anyone.
- **Buyback / LP are permissionless.** No keeper key, no owner-only
  processing.
- **Two honest limits:** swaps use `amountOutMin = 0`, so a public
  buyback/LP call on mainnet could be sandwiched — mainnet needs
  slippage protection or a trusted keeper. And LP tokens go to the
  owner — on mainnet they should go to a locker (e.g. Unicrypt) or be
  burned, not sit in a wallet.

The unit tests (`forge test`) prove all of the above, including fuzzed
buy/sell tax math, tax-free wallet transfers, and low-level calls
showing `mint()` / `blacklist()` do not exist.

## Vanity addresses — 0xa69000

Every contract address (token, NFT registry) starts with the prefix
**`0xa69000`** (6 hex chars, lowercase compare), mined as CREATE2
salts — never by mining an EOA key (that would take ~6 h on this VM
for a 6-char prefix; CREATE2 salt mining is pure keccak and runs at
~610k–770k hashes/s here, so a salt takes ~27 s on average).

- **`src/Create2Factory.sol`** — minimal CREATE2 factory,
  `deploy(bytes initCode, bytes32 salt)` + `predict(...)`. It is
  bootstrap infrastructure, deployed by the burner via CREATE, so its
  own address **cannot** be vanity (it is derived from the fixed burner
  address + nonce) — documented honestly, not hidden.
- **`TaxToken.deploy(bytes initCode, bytes32 salt)`** — owner-only
  CREATE2 deploy with the **token contract itself as the deployer**
  (agnarez: "use our token contract also as deployer"). The NameSBT
  registry is deployed through it, so the NFT address carries the
  prefix too.
- **`names/contracts/NameSBT.sol`** — its constructor takes an explicit
  `address initialOwner`, so the token contract can deploy it with the
  burner as owner (otherwise the token contract would own the registry
  and nobody could mint names).

**Deploy flow** (`script/deploy-vanity.cjs`, run by a human with the
burner key in `tokens/.env` — never committed, never live-deployed by
an agent):

1. Read the burner nonce on the target chain, compute the factory
   address from it.
2. Mine the token salt for (factory address, finalized TaxToken init
   code) — the C miner (`script/vanity-miner.c`, Node fallback
   `script/vanity-miner.mjs`).
3. Deploy the factory, re-checking the nonce first (abort if it moved).
4. Deploy AGNA via the factory CREATE2 with the mined salt; verify the
   `0xa69000` prefix and the on-chain name/symbol/supply/tax/owner.
5. Mine the NFT salt for (token address, NameSBT init code with the
   burner as explicit owner) and deploy the registry via
   `token.deploy(...)`; verify the prefix, the owner, and that
   `token.predictDeploy()` matches.
6. Transfer the 10% agent allocation — **only on chains where the
   Circle agent wallet exists** (Sepolia/Arc/Base Sepolia,
   `chains.<id>.agentWallet` in config). On Robinhood/LitVM it does
   not exist, so the allocation **stays with the burner** — never sent
   to an address nobody controls there.
7. Write `deployments/<chainId>-vanity.json` (receipt).

**Nonce handling:** every script in this flow tracks the burner nonce
locally and passes it explicitly on every send
(`script/nonce-tracker.cjs`). Ethers v6 fetches the nonce with the
"pending" tag by default, and Anvil's "pending" nonce is unreliable
right after a mined transaction — it returned a stale value twice
during testing (`NONCE_EXPIRED` on the second tx from the same
signer). Local tracking fixes it on Anvil and is equally correct on
live chains, where this process is the only sender from the burner
key while it runs.

**Local end-to-end test** (`script/e2e-vanity.sh` → `e2e-vanity.cjs`):
runs the whole flow on a local Anvil chain with throwaway keys, then
creates a pool with mock V2 contracts (native + ERC-20 quote paths)
and re-runs the pool script against the non-empty pair (must be a
no-op). Last run 2026-11-18: **all 23 checks passed** — token
`0xA6900029d70E99b9CC1A849D5421a17C7F31c965`, NFT
`0xA69000a2b2466E8ebeB2d0C9cc923506710deE60` (addresses change per run:
new bytecode ⇒ new salts).

## Pools — the funding rule (final, 2026-11-18)

The token deploys **per chain**, each chain minting its own 404T.
Each chain's pool pairs AGNA with that chain's **native gas token**
(ETH on Sepolia/Robinhood, USDC on Arc since USDC is Arc's gas token,
zkLTC on LitVM). Per chain:

- **Gas side:** 40.4% of the wallet's native-gas balance
  (Sepolia 0.05 ETH → 0.0202, Arc 80 USDC → 32.32, LitVM 0.05 zkLTC →
  0.0202, Robinhood 0.01005 ETH → 0.00406).
- **AGNA side:** 99% of that chain's burner AGNA after the 10% agent
  allocation (~360T per chain; ~3.6T stays with the burner).

Per-chain pool numbers: Sepolia ~360T AGNA + 0.0202 ETH; Arc ~360T +
32.32 USDC; LitVM ~360T + 0.0202 zkLTC; Robinhood ~360T + 0.00406 ETH.

`script/create-pool.cjs` (prepared, **never executed on a live chain
by an agent**) computes both amounts from **live balances** at pool
time (`poolGasFractionBps` 4040, `poolAgnaFractionBps` 9900 in
`config/token-config.json`; override per run with `GAS_FRACTION` /
`AGNA_FRACTION` or explicit `ETH_AMOUNT` / `TOKEN_AMOUNT`). It first
checks `factory.getPair`: if the pair already has liquidity it reports
the existing pool and exits without sending anything. LP tokens go to
the burner (owner) — removable/withdrawable any time, never locked or
burned. After the pool is created it calls `token.setPair(pair)` if the
tax is not active yet (see above).

**Honest caveat:** the pair address is set by the Uniswap V2 factory
formula (CREATE2 over the sorted token pair) and **cannot** be vanity.
Only the token, NFT, and deployer addresses carry the `0xa69000`
prefix. Pools open per chain only once a DEX/router is verified on
that chain — **Sepolia first** (only chain with a verified V2 DEX
today).

## Two quote modes

- **Native ETH path** (`quoteToken == address(0)`): swaps go through
  the router's WETH. Used on Sepolia, Base Sepolia, Robinhood testnet —
  and on **LitVM testnet**, where the native gas token is zkLTC instead
  of ETH (same mechanism, quote is the chain's native token).
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
| LitVM testnet ("LiteForge") | 4441 | zkLTC — burner 0.05 (claimed from the faucet), agent 0 | none verified | ✅ burner deploys (router empty) |

Robinhood testnet's public RPC is verified working: `https://rpc.testnet.chain.robinhood.com` (chainId 46630), explorer API `https://explorer.testnet.chain.robinhood.com/api/v2/`.

**Wallet roles:** the **burner wallet** (`0x6F31…7621`) is the
deployer — we hold its key, so it signs. The **Circle agent wallet**
(`0xd305…53cf7`) is MPC-held by Circle with no exportable key: it can
only move USDC via the Circle CLI and act as a holder/recipient (it
receives its 10% allocation at deploy, on chains where it exists).
Nothing in this project ever needs its raw private key — there isn't
one.

**Gas gap (Base Sepolia):** both wallets hold 0 ETH and the Circle
faucet only gives USDC, not ETH. The deploy script refuses
non-deployable chains. Do not go fetch ETH gas yourself — that is
agnarez's call.

## Quick start

```bash
cd tokens
forge build
forge test          # 32 tests: 29 TaxToken + 3 Create2Factory
```

Vanity deploy (testnet only — never mainnet from here, and only run
by a human with the burner key; the live deploy is on hold pending
agnarez's go):

```bash
cp .env.example .env   # put the BURNER deployer key in PRIVATE_KEY, never commit .env
npm install            # ethers + dotenv
npm run deploy:vanity  # defaults: Sepolia (CHAIN_ID=11155111)
```

Non-vanity deploy (the original path, still works):

```bash
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
```

The vanity script writes its receipt to
`deployments/<chainId>-vanity.json` (factory, token, NFT, salts,
agent allocation). The classic script writes
`deployments/<chainId>.json`.

Pool creation (prepared only — never run on a live chain by an agent):

```bash
node script/create-pool.cjs --dry-run   # show what WOULD be done, send nothing
node script/create-pool.cjs             # defaults: gas 40.4%, AGNA 99% of live balances
AGNA_FRACTION=0.2475 node script/create-pool.cjs   # a smaller share, if wanted
ETH_AMOUNT=0.0202 TOKEN_AMOUNT=360000000000000 node script/create-pool.cjs  # explicit amounts
```

After deploy, the owner can:

```bash
# Point at a verified router once one exists on that chain:
cast send <token> "setRouter(address)" <router> --private-key $PRIVATE_KEY --rpc-url $RPC
# Point the tax at the pool pair (the pool script does this automatically):
cast send <token> "setPair(address)" <pair> --private-key $PRIVATE_KEY --rpc-url $RPC
# Watch reserves build up, then anyone can process them:
cast send <token> "processBuyback()" --private-key $PRIVATE_KEY --rpc-url $RPC
cast send <token> "addLiquidity()" --private-key $PRIVATE_KEY --rpc-url $RPC
# When the token is trusted, renounce ownership so the tax can never change:
cast send <token> "renounceOwnership()" --private-key $PRIVATE_KEY --rpc-url $RPC
```

## Files

| File | What it is |
|---|---|
| `src/TaxToken.sol` | The token: ERC-20 + capped buys/sells-only tax + burn/buyback/LP + CREATE2 `deploy()` |
| `src/Create2Factory.sol` | Minimal CREATE2 factory (vanity bootstrap) |
| `src/interfaces/IUniswapV2Router02.sol` | Minimal V2-style router interface |
| `script/Deploy.s.sol` | Classic deploy script, driven by `config/token-config.json` |
| `script/deploy-vanity.cjs` | Vanity deploy driver (factory → AGNA → NFT → agent allocation) |
| `script/create-pool.cjs` | Pool creation (prepared only) + `setPair` activation |
| `script/vanity-miner.c` / `vanity-miner.mjs` | CREATE2 salt miner (native ~610k–770k H/s, Node fallback) |
| `script/nonce-tracker.cjs` | Local nonce tracking (works around Anvil's stale "pending" nonce) |
| `script/e2e-vanity.cjs` + `e2e-vanity.sh` | Full local Anvil end-to-end test (deploy + both pool paths + no-op re-run) |
| `config/token-config.json` | Token params ($AGNA/AGNAmuse/404T), wallets, per-chain router/gas/agentWallet status, pool fractions |
| `test/TaxToken.t.sol` | 29 tests: buy/sell tax math (+fuzz), tax-free wallet transfers, pair pointer, burn, buyback, LP, anti-honeypot, CREATE2 deploy |
| `test/Create2Factory.t.sol` | 3 tests: deploy + predict |
| `test/mocks/MockRouter.sol` | 1:1 mock V2 router for tests |
| `test/mocks/MockERC20.sol` | Mintable ERC-20 stand-in (WETH / USDC) for tests |
| `test/mocks/MockV2Factory.sol` / `MockV2Pair.sol` | Minimal V2 factory/pair for the Anvil pool test |
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

- A verified V2-style router on Arc Testnet / Robinhood testnet /
  LitVM, if buyback/LP must run there (or deploy a test DEX / use
  Sepolia where the router is verified).
- Whether to renounce ownership after launch (locks the tax, router,
  pair, and exclusions forever).
- Mainnet launch itself — testnets only until agnarez says otherwise.
