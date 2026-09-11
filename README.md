# Meta-Agent DEX

**AI trading agents trade real [DreamDEX Event Contracts](https://docs.dreamdex.io/developers/event-contracts)
on Somnia Shannon, out of a vault they hold no withdrawal key to. A second fleet
of agents buys Up or Down on a *second* Event Contract — minted by this project,
on an operator and venue it registered — asking whether a given agent's session
ends with more money than it started.**

**Every transaction in this repository is executed by an agent, headless.**
The `@somnia-chain/markets-sdk` NPM SDK is the source of market data, ABIs and
pricing on both layers; the send itself is a local viem signature to the same
contracts the SDK targets, because the SDK's write path returns `Missing or
invalid parameters` on the public Shannon RPC — measured, and reported upstream
in [`docs/DREAMDEX_SDK_FEEDBACK.md`](./docs/DREAMDEX_SDK_FEEDBACK.md). There is
no human trading path and nobody connects a wallet to take a side. Trading agents earn a record;
speculator agents price it. The web app is the observatory over both — the
leaderboard, the live meta-markets, the settlement engine, the audit ledger —
and it reads chain without a key.

The first layer is the exchange that already exists. The second layer is a
market on the agent, and it is a native Event Contract: same venue, same order
book, same contract page, same oracle committee. What makes it settleable is one
number a contract publishes — the vault's NAV — and the whole design is about
making that number impossible to forge.

The organiser's own category for this hackathon is *"Autonomous AI trading
agents · Multi-agent trading competitions"*. A venue where autonomous agents
price each other's performance, and where the number that settles that price is
a contract reading anyone can re-derive, is that category taken literally rather
than approximated. Nothing in it is waiting for a human to click.

---

## For judges

Built for the **Somnia x DreamDEX Event Contracts Hackathon**.

| | |
|---|---|
| **Live app** | https://somnia.mdloglabs.org |
| **GitHub repo** | https://github.com/mdlog/meta-agent-dex |
| **Demo video** | `TODO — demo video link` |
| Chain | Somnia Shannon testnet, chainId **50312** |
| Deployer / keeper | [`0x71a89a7e…7BaE`](https://shannon-explorer.somnia.network/address/0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE) |
| Control plane we registered | **operatorId 20** · venue `0xa3c034a0398f2cd3465cee88fec2489b78fe26933af4d394d6c87fc4cf00fa77` |
| Contracts this project deploys | [`contracts/BotVault.sol`](./contracts/BotVault.sol) (one per agent) and [`contracts/BotNavOracle.sol`](./contracts/BotNavOracle.sol) (one per session) |
| Second-layer markets | Native DreamDEX Event Contracts, minted by us with `scheduleAndCreateMarket` |
| Who signs | Two headless SDK daemons and nobody else — [`bots/runner.ts`](./bots/runner.ts) trades the venue, [`bots/speculator.ts`](./bots/speculator.ts) prices the traders. [Both documented together](./bots/README.md) |
| Audit trail | [`docs/ONCHAIN_EVIDENCE.md`](./docs/ONCHAIN_EVIDENCE.md), and the same ledger live at [`/audit`](https://somnia.mdloglabs.org/audit) |

### Where the evidence for each rubric criterion lives

| Criterion | Weight | Open this |
|---|---|---|
| **Innovation** | 20% | [What is real](#what-is-real) — a second-layer Event Contract written on a number a program produced, minted on our own operator/venue, and priced by agents on both sides. The mint path is `mintMetaMarket` in [`src/lib/agents/chain.ts`](./src/lib/agents/chain.ts); the settlement source is [`contracts/BotNavOracle.sol`](./contracts/BotNavOracle.sol). |
| **Technical implementation** | 25% | Two Solidity contracts, an undocumented selector recovered from live calldata, a keeper that lines up [three clocks](#three-clocks-that-must-line-up), and **two** headless agent signers — [`bots/runner.ts`](./bots/runner.ts) and [`bots/speculator.ts`](./bots/speculator.ts) ([their own docs](./bots/README.md)), both reading through the SDK and signing locally with viem. 47 tests (`npm test`), 40 of which run with no network. |
| **UX & design** | 20% | An observatory, not a terminal: `/` overview, `/agents` leaderboard, `/agents/[slug]`, `/settlement`, `/audit`. Every number on those pages is read from chain or from the session journal; a value that does not exist yet prints as a dash and says why. Tokens in [`src/app/globals.css`](./src/app/globals.css). |
| **Business & ecosystem impact** | 20% | [`docs/ECOSYSTEM.md`](./docs/ECOSYSTEM.md) — what this adds to DreamDEX that an order book does not, and the limit of that claim. |
| **Presentation & demo** | 15% | [Try it](#try-it-in-90-seconds) below, and `/audit`, which is the demo's own receipt: every session open, mint, freeze and trade this deployment has done, each with a transaction hash. |

### Try it in 90 seconds

Nothing here costs real money, and nothing here asks you to connect a wallet.
Only step 5 needs a terminal — it is how you put an agent on the other side of
the book yourself.

1. **Open `/`.** Three agents — Alpha-Z (momentum), Neural Drift
   (mean-reversion), Kestrel 7 (momentum) — with their NAV curves and their open
   sessions. The block height and the data-source word are what `/api/health`
   measured, not decoration.
2. **Open `/agents/alpha-z`.** The vault address, the operator address, the
   trade tape with a transaction hash per order, and the meta-market minted
   against the current session. Follow any hash into the Shannon explorer.
3. **Open `/audit`.** The top half is the fixed record — the transactions in
   [`docs/ONCHAIN_EVIDENCE.md`](./docs/ONCHAIN_EVIDENCE.md), including the
   faucet reading that is the centre of this project's security argument. The
   bottom half is whatever this deployment has done since.
4. **Open a meta-market.** `/explore` lists every live Event Contract on
   Shannon, and the meta-markets sit at the top of it — asset `BOTNAV`, one per
   open session, one line of question text each. Open one: it is an ordinary
   contract page, because it is an ordinary contract. **Up wins when the agent's
   NAV rises.** The book on it is quoted by speculator agents and by nobody
   else, so read the [liquidity caveat](#honest-limitations) before you read a
   price off it.
5. **Put an agent on the other side.** The second layer is a daemon, not a
   button. Generate two throwaway keys, send each a little STT for gas — the
   collateral it stakes it mints itself from the open faucet — and run two
   opposing theses against the same board:

   ```bash
   AGENT_THESIS=backer  AGENT_SPECULATOR_KEY=0x… AGENT_API=http://localhost:3009 npm run speculator &
   AGENT_THESIS=skeptic AGENT_SPECULATOR_KEY=0x… AGENT_API=http://localhost:3009 npm run speculator &
   ```

   The backer bids YES up to its view minus its edge, the skeptic bids NO up to
   its own, and where those limits overlap there is a fill and a printed price.
   `AGENT_DRY_RUN=1` runs the whole decision and sends nothing. Full
   documentation: [`bots/README.md`](./bots/README.md#the-speculator-agent).
6. **Watch it settle.** `/settlement` shows the queue and the clock. At the
   session's close the keeper redeems, freezes the oracle, and 180 seconds later
   DreamDEX's committee reads it.

---

## What is real

Every row below is a transaction anyone can open. The full trail, with the
reasoning, is in [`docs/ONCHAIN_EVIDENCE.md`](./docs/ONCHAIN_EVIDENCE.md).

**We run our own control plane.** `registerOperator`
([`0x716c2c44…23c3`](https://shannon-explorer.somnia.network/tx/0x716c2c447d8f997de78ae11cdd96ca70e65cb2ced8da2405f2d53b2cf11623c3))
→ operatorId 20, and `createVenue`
([`0xc2c2b236…7da7`](https://shannon-explorer.somnia.network/tx/0xc2c2b236c39a56157a353425f2464a3dc39a47021fcd5446dee5367d12027da7))
→ venue `0xa3c034a0…fa77`. 0.0116 STT for both. No third party can close the
venue mid-demo, and the SDK's docstring that venue creation "needs SOME
create-side policy set" is contradicted by the chain: both venues that
demonstrably accept third-party creation run `policy = 0x0`, `signer = 0x0`.

**A meta-market is a native Event Contract, not a shadow of one.** It is minted
with `scheduleAndCreateMarket`, selector `0x94f9fdc7` — present in the deployed
`BinaryMarketsModule` implementation but **not exported by the SDK**. The
signature was recovered from live calldata and is called directly with viem. The
first one we minted
([`0x695323cf…d2f1`](https://shannon-explorer.somnia.network/tx/0x695323cff5d5a127483967e305ae5d978dc9f24950d45c83a4a5eb1fcf38d2f1),
marketId `0x…01580a`, asset `BOTNAV`) took a real committee resolution:
**`winningOutcome 1`, `voided false`, payout `[0, 10000000] / 10000000`** — on
the value our own contract returned.

**A vault placed a real order on a live BTC contract.**
[`0x8658d9ac…35af`](https://shannon-explorer.somnia.network/tx/0x8658d9ac0aebc615a557158041174cc25003a7a82c3a0c7e2ffbb251db4835af).
After the fill the **vault held 10 YES and the operator EOA held 0**.
`placeBinaryOrder` turns out to have no caller-type gate at all: an EOA and a
contract both revert `ERC20InsufficientAllowance` (`0xfb8f41b2`) when unfunded.

**A full session ran to a real loss.** navT0 100.00 → navT1 **92.60 tUSDC**,
−7.40, after `redeemAll()`
([`0x241bc764…bee8`](https://shannon-explorer.somnia.network/tx/0x241bc7644c2e2c2731dbb8a944ade5094d66d5fdd7f6dba047bb6fe1ca9bbee8))
converted the position back to cash. The agent bought YES, NO won, the contracts
expired worthless. That loss is the product working — a market on "will this
agent profit" is only worth trading if the answer can be no.

### How settlement is actually worded

Not "no oracle". Not "settled purely by code". Not "atomic". The true sentence
is stronger than any of those:

> **Settlement is *defined* by code and *attested* by DreamDEX's oracle
> committee.** `BotNavOracle` publishes one number. A validator subcommittee
> reads that number at the market's `resolutionTime` and votes on what it saw.
> NAV is one ERC-20 quantity anyone can re-derive from two published block
> numbers.

Separately, and also true: `redeemAll()`, `closeSession()` and `finalize()` are
**permissionless**. Anyone may call them. The keeper is a convenience, not an
authority — if it dies, a stranger can still close the session and free the
oracle for the committee to read.

**The answer encoding is the payout wiring.** Answers are registered as numeric
intervals `[(1,1),(2,2)]` — **1 = YES (NAV rose), 2 = NO**. `winningOutcome` is
the *index* of the matching interval, and index 0 is the market's Up/YES leg, so
YES has to be registered first or every market on the platform inverts while
looking perfectly reasonable in review. Zero is deliberately outside both
intervals: an unfinalized session reads 0, lands in no interval, and **voids** —
refunding both sides — rather than being scored as a loss.

---

## The security argument

This is the strongest thing in the repository, so it gets stated plainly.

### The vault owns the positions; the operator key can trade but never withdraw

```solidity
modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }

function deposit(uint256 amount)  external onlyOwner { … }
function withdraw(uint256 amount) external onlyOwner { … }
function setOperator(address o)   external onlyOwner { … }

function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity,
               uint64 expireTimestampNs, uint8 orderType) external onlyOperator { … }
```

The agent runner holds one hot key, and on chain that key can call exactly one
function. `deposit`, `withdraw` and `setOperator` are `onlyOwner`, and the owner
is a different address that never goes near the runner process. The worst a
leaked runner key can do is **trade badly** — which is the thing the meta-market
is a bet on in the first place. It cannot move a unit of collateral out, and it
cannot even reassign itself.

Because the vault is `msg.sender` at the pool, it owns every ERC-6909 outcome
token, and it can record every `marketId` it touched into a sealed session
universe — the enumeration the chain otherwise cannot provide.

### NAV counts only collateral a DreamDEX call delivered

Shannon's test collateral has a **permissionless, cooldown-free `faucet(uint256)`
capped at 10,000 per call**. Anyone can push tokens into any address for the
price of gas. So a NAV oracle reading `collateral.balanceOf(vault)` would be
forgeable by a stranger, for free, at will — and it would be forgeable in the
profitable direction, right before the committee reads.

We faucet'd 10,000 tUSDC straight into a live vault and measured:

```
balanceOf(vault) = 10,197.91
nav()            =    197.91     ← moved by EXACTLY ZERO
unaccounted()    = 10,000.00     ← the gap, visible to anyone
```

`nav()` returns `protocolCash`, which moves **only** by collateral deltas
measured inside an allowlisted DreamDEX call. Tokens that arrive any other way
land in `unaccounted()`, which anyone can read. That turns "trust our
accounting" into an invariant a stranger can check in one `eth_call`.

It is cash, and only cash — `nav()` is literally `return protocolCash;`. It does
**not** mark open positions to a book, because a thin book is a number an
operator could move against their own settlement. The cost is real and we show
it rather than hide it: a vault mid-session reads at the cash it has not spent,
so the agent board prints what its held legs would redeem for beside that
figure. Measured on Alpha-Z session 8 — `nav()` read 10.000006 while three
resolved winning legs stood at 18.097000, and `redeemAll()` at close brought
`navT1` in at exactly 28.097006.

### What else the shape forecloses

| Attack | Why it fails |
|---|---|
| Faucet tUSDC into the agent to force YES | NAV counts `protocolCash`, which a transfer cannot move; the gap shows in `unaccounted()` |
| Refuse to redeem so NAV looks flat | `redeemAll()` and `redeemMarket()` are permissionless — anyone can convert the positions before `finalize()` |
| Trade a contract that expires after the session | `BotVault.trade` reverts `MarketOutlivesSession` |
| Stall settlement to strand the other side | `redeemAll()`, `closeSession()` and `finalize()` are all permissionless |
| Sell the vault's positions out from under it | The vault grants ERC-6909 operator rights to the *module* (so `redeem` works), never to a pool — a sell reverts `InsufficientPermission()` |
| Rest an order nobody can cancel | `BotVault` has `trade` and no `cancelOrder`, so every order is IOC |

That last row is a property of `BotVault`, not of the platform, and it is why
the two layers sign differently. A trading agent is forbidden to rest an order
because nobody — not the operator, not the owner — could pull it back before
expiry. A speculator agent signs for its own EOA, can cancel, and therefore
rests **LIMIT** orders: an order that only ever crosses can never be the first
quote on an empty book, and the first quote is exactly what a market on an
agent needs.

---

## What we measured that contradicts the documentation

None of this is an apology. It is the reason the system has the shape it has,
and each row cost a spike script in [`scripts/spike/`](./scripts/spike) to
establish.

| The documented claim | What Shannon actually does |
|---|---|
| **Somnia supports EIP-7702** (its own JSON-RPC docs) | Type-4 transactions are rejected `invalid transaction` on **all three RPCs**, while types 0/1/2 reach nonce validation. So there is no delegated-account path for an agent. |
| **Session keys can scope an agent's Event-Contract trading** | Spot only. The SDK says it outright: *"A BinaryPool escrows through the module and has no operator gate."* |
| **Contract oracle sources are a supported settlement path** | The OracleHub prices them at **0.00 STT**, so nothing funds a validator to service one. **7 of 10** live contract-sourced samples voided, against **122 of 20,617 (0.59%)** for the paid six-JSON tier. |
| **`getSchedulingCost` is stable, so the mint cost can be hardcoded** | The resolve reserve derives from `maxFeePerGas` and admins retune it. It is re-quoted on every mint. Currently ≈**1.496 STT**. |
| **Venue creation needs a create-side policy** | Both venues that demonstrably accept third-party creation run `policy = 0x0`, `signer = 0x0`. |

Two of those changed the architecture outright.

**Because 7702 and session keys are both dead ends, the honest primitive is
capital segregation, not key restriction.** We do not claim a scoped key. We
claim a contract that owns the money and exposes one function to the hot key.

**Because free contract sources go unserviced and void ~70% of the time**, every
meta-market registers **six JSON sources plus one free contract source**,
`minAgreement 4`, `subcommitteeSize 3`, `subcommitteeThreshold 2` — and
`resolutionTime` sits **180 seconds after expiry**, because every voided
third-party sample we decoded had put the read exactly *on* expiry, with no
window for the close-out transactions to land.

And the six JSON sources are described honestly in the code that builds them:

> Six reads of **one HTTP mirror of one on-chain number**, not six independent
> sources. They do not add evidence. They buy *servicing* — the hub prices JSON
> sources and therefore pays committee members to fetch them.

The mirror (`/api/oracle/session/[oracle]`) reads `outcomeValue()` at chain head
on every request, never from the database, and **answers `0` on every failure
path** — a bad address, a dead RPC, a slow RPC, a value the contract could not
have returned, a bug in the file. Zero voids the market and refunds both sides,
which is the only safe direction: serving a wrong `1` or `2` would pay one side
of a real market off a guess.

One more measured thing, because it burns an afternoon otherwise: the mint needs
real gas headroom. A one-source mint costs 21.9M gas and each extra JSON source
adds ~0.35M; seven sources at a **26M ceiling reverted with EMPTY revert data
after burning 24.0M** — an inner call starved of its 63/64 allowance, not a
rejected argument. The same calldata at 60M succeeds. Somnia's block limit is 15
billion and unused gas refunds, so the mint is sent with an 80M cap.

---

## Architecture

```
 ┌─ Layer 0 ── Agent registration ────────────────────────────────────────────┐
 │ Owner wallet signs EIP-191; server verifies with verifyMessage and stores  │
 │ an address, never a key. Strategy → configHash → the market's on-chain     │
 │ context blob, where it can never be quietly restated.                      │
 └────────────────────────────────────────────────────────────────────────────┘
                                    │
 ┌─ Layer 1 ── The agent trades ─────┼────────────────────────────────────────┐
 │ bots/runner.ts · SDK reads + local viem signature · one hot key            │
 │ scan live BTC/ETH contracts → strategy → size to the pool's grid → IOC     │
 └────────────────────────────────────┬───────────────────────────────────────┘
                                      │ vault.trade(...)   onlyOperator
 ┌─ Layer 2 ── BotVault owns the capital ─────────────────────────────────────┐
 │ msg.sender at the pool, so it owns every ERC-6909 position and seals the   │
 │ set of markets it touched. nav() = protocolCash, cash only.                │
 │ deposit/withdraw/setOperator are onlyOwner. redeemAll/closeSession are     │
 │ permissionless.                                                            │
 └────────────────────────────────────┬───────────────────────────────────────┘
                                      │ BotNavOracle.finalize() → 1 YES / 2 NO
 ┌─ Layer 3 ── The meta-market ───────┴───────────────────────────────────────┐
 │ scheduleAndCreateMarket (0x94f9fdc7) on operator 20 / venue 0xa3c0…fa77    │
 │ 6 JSON sources + 1 contract source · minAgreement 4 · intervals            │
 │ [(1,1),(2,2)] · resolutionTime = close + 180s                              │
 │ → DreamDEX's committee reads, votes, and pays the winning interval index   │
 └────────────────────────────────────┬───────────────────────────────────────┘
                                      │ a normal binary Event Contract
 ┌─ Layer 3b ─ Speculator agents pric─┴─it ───────────────────────────────────┐
 │ bots/speculator.ts · SDK reads + local viem signature · its own funded EOA │
 │ read the board → form a view from the vault's own evidence → LIMIT order,  │
 │ which RESTS, so a backer and a skeptic cross each other → redeem at close  │
 └────────────────────────────────────┬───────────────────────────────────────┘
                                      │ every order on both layers is an agent's
 ┌─ Layer 4 ── The observatory ───────┴───────────────────────────────────────┐
 │ Next 15 App Router · React 19 · the existing market page, order book,      │
 │ probability rail and countdown work on meta-markets unchanged, because     │
 │ they ARE Event Contracts. New: /agents, /agents/[slug], /settlement,       │
 │ /audit. It reads chain, holds no key, and takes no side.                   │
 └────────────────────────────────────────────────────────────────────────────┘
```

### The two contracts

**[`contracts/BotVault.sol`](./contracts/BotVault.sol)** — one per agent. Holds
the collateral, is the trader at the pool, records the session universe, and
computes NAV. `redeemAll` emits `RedeemFailed` rather than swallowing a failure,
because a redemption that quietly does not happen understates the number the
meta-market pays out on.

**[`contracts/BotNavOracle.sol`](./contracts/BotNavOracle.sol)** — one per
session, write-once. `open()` snapshots navT0, `finalize()` snapshots navT1 after
the close and freezes `finalValue` to `OUTCOME_YES` (1) or `OUTCOME_NO` (2).
`outcomeValue()` must never revert and must be stable across the committee's
reads: a subcommittee that disagrees with itself voids the market.

Compile them with the exact flags the loader expects — `--via-ir` is required,
not cosmetic, because `redeemAll` destructures a 14-field return:

```bash
solc --combined-json abi,bin --optimize --via-ir \
     contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json
```

### The keeper loop

`npm run cycle` pokes `POST /api/agents/cycle` every 30 seconds. One pass:

1. **Settle what is due** — for each session past its close: `redeemAll()`,
   `closeSession()`, then `finalize()` on its oracle. Each session is attempted
   on its own, so one failure cannot strand the rest.
2. **Retry pending mints** — a session whose mint failed still has an open vault
   and a recorded navT0, so it is still worth a market.
3. **Follow the committee** — ask the indexer what was decided about the markets
   already frozen, and record settled / voided.
4. **Open what is idle** (`?open=1`) — deploy an oracle, `openSession` on the
   vault, mint the meta-market.

It runs on a clock rather than on page reads because *a session that closes
while nobody is looking still owes the speculators holding it a resolution* — and worse, an
oracle left unfrozen past the moment the committee reads voids the market.
Everything the keeper does, a stranger can also do.

### Three clocks that must line up

```
vault.sessionEnd    the last second the agent may hold a position   = close
market.expiry       the last second a speculator may take a side    = close
resolutionTime      when the committee reads the oracle             = close + 180s
```

The 180 seconds are not padding. Three transactions — `redeemAll`,
`closeSession`, `finalizeOracle` — have to be mined inside that window, and it
is sized for a bad minute on the chain rather than a good one. Every voided
third-party market we decoded had `resolutionTime == expiry`.

The vault enforces the first clock against the second: `trade` reverts
`MarketOutlivesSession` for any contract expiring after `sessionEnd`, which is
what guarantees every position is terminal by the time the oracle freezes NAV.
The practical consequence is the single most common way to make a working bot
look broken — **open a session that ends after the contracts you intend to
trade**, or every poll logs `scan tradable=0`. See
[`bots/README.md`](./bots/README.md#your-session-has-to-outlive-a-contract).

---

## Running it

**Requires Node 22.6 or newer** (`.nvmrc` pins it). The store is `node:sqlite`,
which arrived in 22.5, and the scripts run TypeScript directly with
`--experimental-strip-types`, which arrived in 22.6. On Node 20 the app dies at
import with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`.

```bash
node --version                 # v22.6.0 or newer
npm install
cp .env.example .env.local     # defaults already point at Shannon testnet
npm run build
npx next start -p 3009         # http://localhost:3009
```

The app **reads** chain with no key at all; `/explore`, `/agents`, `/settlement`
and `/audit` all render against a fresh install. A key is only needed for the
half that spends STT: deploying vaults, opening sessions and minting markets.
The keys that trade belong to the agents and live in their own processes —
[`bots/README.md`](./bots/README.md) — never in the app's environment.

### Environment

Everything below is in [`.env.example`](./.env.example) except the private key,
which has no safe default.

| Variable | Default | What it does |
|---|---|---|
| `DREAMDEX_MODE` | `live` | `live` reads real markets; `sim` is the deterministic offline simulation. |
| `SOMNIA_INDEXER_URL` | `https://dev.smk.somnia.host/v1/graphql` | Market discovery (server). |
| `SOMNIA_WS_RPC_URL` | `wss://api.infra.testnet.somnia.network/ws` | Chain reads: book depth, market status. The SDK's transport has no HTTP fallback. |
| `SOMNIA_RPC_URL` | `https://dream-rpc.somnia.network` | HTTP RPC for receipts, vault reads and every keeper write. |
| `NEXT_PUBLIC_SOMNIA_INDEXER_URL` | same | Carried for the browser bundle. Nothing in the observatory reads it; the agents read `SOMNIA_INDEXER_URL` in their own processes. |
| `NEXT_PUBLIC_SOMNIA_WS_RPC_URL` | same | |
| `NEXT_PUBLIC_SOMNIA_RPC_URL` | `https://dream-rpc.somnia.network` | Goes into `wallet_addEthereumChain`. |
| `NEXT_PUBLIC_SOMNIA_EXPLORER` | `https://shannon-explorer.somnia.network` | Transaction links. |
| `NEXT_PUBLIC_SOMNIA_CHAIN_ID` | `50312` | Carried for completeness; the chain is compiled in from the SDK's own `somniaShannon` and `src/lib/wallet/chain.ts`. |
| **`NEXT_PUBLIC_APP_ORIGIN`** | — | **The public origin the oracle committee fetches the settlement mirror from. A `localhost` value here voids every meta-market it mints.** |
| **`DEPLOYER_PRIVATE_KEY`** | — | Keeper key. Deploys vaults and oracles, opens/closes sessions, mints markets. Needs STT. Required only for the write half. |
| `AGENT_CYCLE_TOKEN` | — | Shared secret for `POST /api/agents/cycle` and `/provision`. They spend STT, so they refuse to run unguarded. |
| `AGENT_OPERATOR_ID` | `20` | Our operator. Override to mint on your own. |
| `AGENT_VENUE_ID` | `0xa3c034a0…fa77` | Our venue. |
| `AGENT_CONTRACT_ARTIFACTS` | `contracts/out/contracts.json` | solc `--combined-json abi,bin` output. |
| `SOMNIA_OUTCOME_TOKEN` | `0xB52c5934…55b9` | The ERC-6909 singleton every binary market shares. |
| `FORECAST_ARENA_DB` | `.data/forecast-arena.db` | `node:sqlite` file. The name is historical. |

No trading key is ever read, stored or configured here. Every order on either
layer is signed by an agent daemon running outside the app, holding a key the
server never sees: `AGENT_OPERATOR_KEY` for a trading agent, `AGENT_SPECULATOR_KEY`
for a speculator. The web tier's job is to read chain and show what the agents
did.

### The keeper

```bash
# once, to stand up three agents with three separate operator keys
AGENT_CYCLE_TOKEN=… BASE=http://localhost:3009 npm run provision

# then leave this running
BASE=http://localhost:3009 AGENT_CYCLE_TOKEN=… npm run cycle          # every 30s
BASE=http://localhost:3009 AGENT_CYCLE_TOKEN=… npm run cycle -- --once
BASE=http://localhost:3009 AGENT_CYCLE_TOKEN=… npm run cycle -- --open  # also opens idle sessions
```

Every script now defaults to `:3009`, the port this app actually serves on. They
used to disagree — `cycle` assumed `:3100` and `workflow` and the two bots assumed
`:3971`, neither of which anything here has ever listened on — so a runner started
without `AGENT_API` reported its trades to a closed socket. Pass `BASE` (or
`AGENT_API`) explicitly anyway when you are pointing at the hosted arena:
`https://somnia.mdloglabs.org`.

`--open` spends STT — roughly 1.5 STT per meta-market plus deploys — so it is
opt-in per call rather than something a stray POST can trigger.

### Bringing your own agent

Everything above stands up *this* fleet, whose owner keys this server holds. To run
an agent against the live arena from outside — your vault, your keys, no key ever
handed over — follow `docs/BRING_YOUR_OWN_AGENT.md`. The short version: registration
is open and signature-gated, but `openSession` is `onlyOwner`, so you send that one
transaction yourself and then `POST /api/agents/<slug>/session` with an owner
signature, and the arena deploys your oracle and mints your meta-market.

`examples/agent/` is that walkthrough as runnable code: five numbered scripts and
one readable agent, self-contained enough to copy out of this repo.

### The agents

This is where every transaction comes from. Two daemons, one per layer, each
run on your own machine with a key the server never sees, each reading through
the SDK and signing locally with viem. Both are documented
together — strategy parameters, theses, log vocabulary, dry-run mode, refusal
tables, and the session-length trap:

**→ [`bots/README.md`](./bots/README.md)**

**Layer 1 — a trading agent.** Holds a key that can only call `BotVault.trade`,
and has already produced 211 verified transactions on Shannon.

```bash
export AGENT_OPERATOR_KEY=0x…      # generated locally, never sent to the server
export AGENT_VAULT=0x…
export AGENT_SLUG=alpha-z
export AGENT_API=http://localhost:3009
AGENT_DRY_RUN=1 node --experimental-strip-types bots/runner.ts
```

**Layer 2 — a speculator agent.** Holds its own funded EOA, takes YES or NO on
the meta-markets that ask whether a trading agent's NAV rises, and redeems what
it wins. It needs STT for gas and nothing else: it mints its stake from the
collateral's open faucet and says so at `warn` every time.

```bash
export AGENT_SPECULATOR_KEY=0x…    # never from a file the app reads
export AGENT_API=http://localhost:3009
AGENT_THESIS=backer AGENT_DRY_RUN=1 npm run speculator
```

Run at least two theses. One speculator quoting alone is marking its own price;
a `backer` and a `skeptic` on separate keys cross each other, and that is what
puts a price on an agent.

`provision` writes the three generated operator keys to
`.data/demo-operators.json`, which is gitignored because it holds real keys.

### Verify it before you trust it

```bash
npm test                      # 47 tests
SKIP_LIVE_TESTS=1 npm test    # offline: 40 pass, the 7 live-testnet ones skip
npm run lint                  # tsc --noEmit; there is no ESLint config and none is installed
npm run probe                 # does the SDK reach Shannon at all?
```

| Suite | Covers |
|---|---|
| `tests/dreamdex.test.ts` | The whole suite: status derivation, revert translation, the simulation adapter, the live→sim fallback and what it may say about itself, pool recycling, **and seven integration tests against live Shannon**. |
| `scripts/spike/` | The fourteen scripts that established every measured claim above, from decoding `scheduleAndCreateMarket`'s calldata to the faucet-versus-NAV reading. |

---

## Honest limitations

- **Testnet only.** Somnia Shannon, chainId 50312. Every balance, price and
  position is test value with no monetary worth. The collateral's faucet is
  open, which is exactly why NAV is defined the way it is.
- **Settlement depends on DreamDEX's oracle committee.** We do not resolve
  anything. If the committee does not answer, a market sits unresolved; if a
  subcommittee disagrees with itself, the market voids and both sides are
  refunded. Voiding is the designed failure, not an error state — but it is
  still a dependency, and on the free contract-source tier it fires ~70% of the
  time, which is why we pay for six JSON sources.
- **Those six JSON sources are one origin.** They are six reads of one mirror
  this project hosts, differing only by a `?v=` the hub keys sources by. They
  buy servicing, not independence. A committee that could not reach our origin
  would fall back to the single free contract source and probably void. Six
  genuinely independent gateways reading the same on-chain value is the fix, and
  it is not done.
- **The meta-market books are quoted by agents, and no agent order has been
  mined yet.** `bots/speculator.ts` is the market side of the design: it rests
  LIMIT orders, so a `backer` and a `skeptic` on separate keys cross each other
  and print a price. Every stage of it — the board read, the per-market chain
  reads, the view, the three theses, the sizing, the refusals, the redemption
  path — has been exercised end to end in dry run against this live deployment,
  and the write path is type-checked against the SDK's own parameter types.
  Nineteen of its orders are mined on Shannon from `0xb4f2cFf5…5DD5`, and
  `0x91d5c29e…` matched rather than merely rested: the speculator paid 19.999980
  tUSDC into the pool, took 1.184040 back as price improvement, and both outcome
  legs were minted — one to the speculator, one to an unaffiliated address. What
  does **not** work is collecting the winnings. Neither speculator EOA granted
  the module ERC-6909 operator rights, so `redeem` reverts `0xdeda9030`
  (`InsufficientPermission`). That is one `setOperator` transaction per key, not
  a code change, and until it is sent those winnings sit unredeemed.
- **The keeper is a single process.** Everything it does is permissionless, so
  nothing is *stuck* if it dies — but nothing is automatic either, and the
  180-second settlement window is the thing most likely to be missed. Two
  keepers racing the same session is untested.
- **What breaks at scale.** `scheduleAndCreateMarket` is sent with an 80M gas cap
  and mints are serialised behind confirmation waits, so market creation is
  sequential by construction — one agent-session per confirmed block round, not
  a parallel burst. `node:sqlite` is synchronous and the SQL is written inline
  across the service modules rather than behind a repository layer, so a
  Postgres port changes the signature of nearly every service function. And the
  keeper's single deployer key serialises every write behind one nonce.
- **A voided meta-market's refund path is correct by construction but
  unobserved.** We have watched markets settle; we have not watched one of ours
  void and be redeemed at 0.5:1 on both sides.
- **Agent ownership is signature-proved, and it is now the only thing that is
  proved.** Registering an agent requires an EIP-191 `personal_sign` from the
  owner wallet, because `configHash` goes on chain where it can never be
  corrected. Everything else on the site is a read. The unsigned
  `x-wallet-address` header that used to identify a browsing session is gone
  along with the session cookie, the `users` table and the demo seeder — with no
  human trading path there is nothing for a browsing identity to own, and an
  unsigned identity nobody needs is a liability rather than a feature.
  No browser wallet is used anywhere in the app: the registration signature is
  produced locally by `npm run register` or the signed curl documented at
  `/docs`, and the market page's trade ticket is gone, replaced by a panel that
  names the two daemons that sign instead.
- **The strategies are deliberately simple.** Momentum and mean-reversion over
  the pool's own implied probability. They are there to produce an honest NAV
  curve that can go down, not to be alpha.
- **`npm audit` reports two advisories, both Next 15's own vendored
  `postcss@8.4.31`** — build-time CSS tooling, not anything a request reaches.
  This project's own `postcss` is above every affected range. The only remedy npm
  offers is a major upgrade to `next@16`.

---

## Risk disclaimer

Meta-Agent DEX runs on Somnia Shannon **testnet**. Every balance, price and
position is test value with no monetary worth. Nothing here is investment
advice, nothing recommends a position, and an agent's past NAV curve is a record
of what it did, not a claim about what it will do.

---

## Licence

MIT — the full text is in [`LICENSE`](./LICENSE).
