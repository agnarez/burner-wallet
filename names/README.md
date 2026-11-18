# Names — soul-bound name tokens (ERC-5192)

A name registry for the burner wallet: one ERC-721 token per name, locked
forever to its owner. Mint `agnarez.arc` once and it can never be sold,
sent, or stolen — it can only be burned (which frees the name).

This is a **standalone registry**. It is not ENS and not Base names, and a
name minted here does **not** resolve in wallets or dapps the way a `.eth`
or `.base.eth` name does. See [how this differs](#how-this-differs-from-ens--base-names)
below.

## Quickstart

```bash
cd names
npm install
npm run compile   # compile contracts
npm test          # 17 unit tests, all on a local in-process chain
```

To deploy on a testnet:

```bash
cp .env.example .env   # then fill in BURNER_PRIVATE_KEY — never commit .env
npm run deploy:arc     # default chain; see gas status below
npm run deploy:sepolia # burner-funded (0.05 ETH) — deployable now
NAME=agnarez.arc AGENT_NAME=agent.arc npm run deploy:arc
```

To mint more names on an already-deployed contract:

```bash
NAME_SBT_ADDRESS=0x... NAME=second.arc npm run mint -- --network arcTestnet
NAME_SBT_ADDRESS=0x... NAME=agent2.arc MINT_TO=agent npm run mint -- --network arcTestnet
```

## Gas status (verified live 2026-11-18)

| Chain | Burner wallet | Agent wallet | Can deploy? |
|---|---|---|---|
| **Arc Testnet** (chain 5042002) — **default** | 80 USDC (USDC *is* Arc's gas token) | 20 USDC | ✅ Yes — both wallets funded |
| **Sepolia** (11155111) | 0.05 ETH (agnarez funded it 2026-11-18, [tx](https://sepolia.etherscan.io/tx/0x2af1f29f9451b5203d2a14b9ef12a348d8742ed2372da3f6fa1f9fa9dc7fc035)) | 0 ETH | ✅ Burner only |
| Robinhood Chain testnet (46630) | 0.01005 testnet ETH (0.01 + 0.00005 from agnarez's Zalalena faucet claim, [tx](https://explorer.testnet.chain.robinhood.com/tx/0x6d339411e3466ae8636d5665b2a72bccfb2b89591d2f9634cf86ae09a4209c44)) | — (wallet doesn't exist here) | ✅ Burner only — public RPC verified: `https://rpc.testnet.chain.robinhood.com` |
| Base Sepolia (84532) | 0 ETH | 0 ETH | ❌ No gas — see below |
| LitVM testnet (4441) | 0.05 zkLTC (claimed 2026-11-18, [tx](https://explorer.testnet.liteforge.zeeve.net/tx/0xa40ea16a88a550c83031b0c7dce297648d080d1547bd0e82663b48a75ca2cf23)) | 0 zkLTC | ✅ Burner gas-funded — deploy ready (RPC verified: `https://rpc.testnet.liteforge.zeeve.net/`) |

**Sepolia gas math (measured, not guessed):** deploying NameSBT costs
~3,825,133 gas, a mint ~230,000 gas. Sepolia's gas price is currently
18 wei, so a deploy right now costs ~0.00000000007 ETH — effectively free.
The 0.05 ETH covers a deploy as long as gas stays under ~13 gwei, plus
dozens of mints. If gas ever spikes above that, wait for it to drop or top
the burner up first. The agent wallet holds 0 ETH on Sepolia, so it can
never deploy or mint there itself — it can only *receive* names via
`mintTo`, which the burner pays for.

**The Base Sepolia gas gap:** the Circle faucet gives USDC, not ETH, and
both wallets hold 0 ETH on Base Sepolia — so no transaction (deploy or
mint) is possible there yet. The scripts are already chain-configurable
(`npm run deploy:base-sepolia`), they just need ETH gas first. To get
Base Sepolia ETH, use a faucet that hands out ETH (e.g. Alchemy's Base
Sepolia faucet needs a free account) — do that by hand, don't automate it
around captchas/logins, and never send mainnet funds for it. Once either
wallet holds Base Sepolia ETH, the same scripts work.

## Wallet roles

- **Burner wallet `0x6F31…7621`** — the deployer and minter. We hold its
  key, so it signs (`BURNER_PRIVATE_KEY` in `.env`).
- **Circle agent wallet `0xd305…53cf7`** (testnet) — MPC-held by Circle,
  **no exportable key exists**. It can never sign a transaction. It can
  only be a **holder/recipient**: the deployer mints a name *to* it with
  `mintTo` (see `scripts/deploy.js` `AGENT_NAME`, or `scripts/mint.js`
  `MINT_TO=agent`). It moves USDC only via the Circle CLI.
- **Mainnet agent wallet `0x619a…13efb`** — empty, and nothing in this
  project ever funds or deploys to mainnet. Deploy scripts are testnet
  only by design (no mainnet network is configured).

## How this differs from ENS / Base names

| | This (NameSBT) | ENS (`.eth`) | Base names (`.base.eth`) |
|---|---|---|---|
| Transferable? | **No — soul-bound (ERC-5192)**. Transfers, approvals all revert. | Yes — ordinary ERC-721, can be sold/sent | Yes — ordinary ERC-721 |
| Cost | Free to mint (gas only, testnet) | Real registration fee on mainnet (yearly rent + gas) | Real registration fee on mainnet |
| Resolves in wallets/dapps? | No — only this contract's `resolveName` / `primaryNameOf` | Yes — the ENS registry, reverse records, etc. | Yes — via the Base name system |
| Expiry | Never — burn it or keep it | Yearly renewal, or it expires | Yearly renewal, or it expires |
| Uniqueness | Enforced on-chain, first come first served | Enforced by the registrar | Enforced by the registrar |
| Who can hold it | Any address; agent wallet can only receive via `mintTo` | Anyone who can sign | Anyone who can sign |

**In short:** ENS/Base names are rented, transferable identity that the
whole ecosystem understands. NameSBT is a free, permanent, non-transferable
badge of a name inside this project only. If you want a name the world
resolves, register the real thing (below) — this contract doesn't replace
that.

## How to register a real ENS / Base name separately

If you want `agnarez.eth` (or similar) for real, that is a separate,
mainnet, paid process — nothing in this repo does it for you:

**ENS (`.eth`)**
1. Go to https://app.ens.domains and connect a wallet that holds real ETH.
2. Search the name, check availability and the yearly price (usually a few
   dollars a year for a 5+ character name, plus gas).
3. Register for 1+ years, then set the reverse record so your address
   displays as the name. Renew yearly or it expires and anyone can take it.

**Base names (`.base.eth`)**
1. Base names are ENS names on Base — register at https://www.base.org/names
   (or via the Base app) with a wallet holding ETH on Base mainnet.
2. Same idea: pay the registration fee, set it as your primary name.
   A Base name also works as an ENS name.

Both cost real money on mainnet. Both are transferable — if the wallet is
compromised, the name can be taken. That's exactly the risk this soul-bound
token is designed to avoid, at the cost of not being recognized outside
this project.

## Contract

`contracts/NameSBT.sol` — ERC-721 + ERC-721Enumerable + ERC-5192
(`contracts/interfaces/IERC5192.sol`, defined locally because OpenZeppelin
doesn't ship it) + Ownable. Solidity 0.8.28, Cancun EVM.

The constructor takes `(string name, string symbol, address
initialOwner)` — the owner is set explicitly, not taken from
`msg.sender`, so the $AGNA token contract can deploy the registry via
CREATE2 with the burner as owner (otherwise the token contract would
own the registry and nobody could mint names).

- `mint(name)` — mint a name for yourself. First name becomes primary.
- `mintTo(to, name)` — owner-only; how the deployer gives a name to the
  agent wallet (which can't sign).
- `burn(tokenId)` — owner only; frees the name for re-minting.
- `setPrimary(tokenId)` / `primaryNameOf(owner)` — reverse lookup.
- `resolveName(name)` → owner address (`address(0)` if free).
- `nameOf(tokenId)` / `tokenIdOf(name)` / `isNameTaken(name)`.
- `locked(tokenId)` → always `true` (ERC-5192); `supportsInterface(0xb45a3c0e)`.
- Transfers (`transferFrom`, `safeTransferFrom`) and approvals (`approve`,
  `setApprovalForAll`) all revert.
- `tokenURI` returns on-chain base64 JSON metadata.

Name rules: 3–64 chars, `[a-z0-9.-]`, lowercased automatically, no
leading/trailing dot or hyphen, no `..`. Names are first come, first
served — anyone can mint any free name, including yours, so mint the
names you care about first.

## Tests

`npm test` — 19 tests on a local chain:

- mint (owner recorded, primary set, lowercase normalization, invalid
  names rejected, owner-only `mintTo`)
- ownership (explicit `initialOwner` is set, non-owner cannot
  `mintTo`, zero owner reverts)
- soul-bound (all transfer forms blocked, approvals blocked, `locked()`
  true, ERC-5192 interface id)
- uniqueness (same name twice reverts, case-insensitive)
- resolution (forward + reverse, `setPrimary`, unknown names/owners)
- burn (frees the name, primary falls back, only owner can burn)
- metadata (on-chain JSON names the token)

## Security notes

- **Testnet only.** No mainnet network is configured; don't add one
  without thinking twice.
- **Never commit `.env`** — it holds the burner private key. It is
  gitignored, and the repo root `.gitignore` also excludes `private/`,
  `*.pem`, `*.key`, `backup.json`, `backup.txt`.
- The contract is unaudited and written for a personal project. Don't put
  real value behind it, and don't mint a name you couldn't afford to lose
  to a squatter — minting is first come, first served.
- The deployer is the contract owner and the only account that can
  `mintTo` others. Ownership is not renounced; if the burner key is ever
  compromised, the owner could mint names to arbitrary addresses (they
  still couldn't move or take existing names — transfers are impossible).
