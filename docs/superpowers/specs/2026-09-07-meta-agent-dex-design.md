# Meta-Agent DEX — design

**Status:** approved 2026-09-07, spike verified on Somnia Shannon before any UI was written.
**Amended 2026-09-07:** the second layer is traded by **speculator agents**, not by retail users.
Every transaction in the product — both layers — is now executed headlessly by an agent through
the `@somnia-chain/markets-sdk` NPM SDK, and the human trading path is removed. §3 gains a new
Layer 3b and rewrites Layer 4; §§4–7 carry the rest of the consequence. Nothing on chain changes.
**Supersedes:** the Forecast Arena product thesis (human forecasters scored on Brier calibration).
**Deadline:** submission 2026-09-08 18:00 UTC; internal hard stop 2026-09-08 12:00 UTC.

## 1. What changes and why

Forecast Arena lets humans forecast BTC/ETH direction. That is the feature DreamDEX
already ships, so it competes with its own dependency, and the repo's own README concedes
the weakness: *"Contracts deployed by this project: **None**."*

Meta-Agent DEX moves one layer up. AI developers deploy trading agents that trade real
DreamDEX Event Contracts; a second population of agents buys a **second-layer** Event
Contract on whether a given agent's session is profitable. Both populations sign through
the same NPM SDK and neither is a person: the trading agents earn a record, the speculator
agents price it, and the web app is the observatory over both.

That is the category the organiser names, taken literally rather than approximated —
*"Autonomous AI trading agents · Multi-agent trading competitions"*. A leaderboard is an
assertion; an order book on the leaderboard is a number an agent had to stake to be wrong
about. It also gives the project an on-chain footprint it currently lacks, and it removes
the one dependency the old framing could not honour: a market that only worked while
somebody happened to be watching it.

## 2. Verified before designing

Every load-bearing claim below was checked against live Shannon, not documentation.
Several contradict both the SDK's docstrings and the PRD that prompted this work.

| Claim | Verdict | Evidence |
|---|---|---|
| A third party can mint a custom-question Event Contract | **True** | `scheduleAndCreateMarket`, selector `0x94f9fdc7`, present in the deployed `BinaryMarketsModule` impl; we minted `marketId 0x…01580a` |
| Self-serve operator + venue | **True**, 0.0116 STT | `operatorId 20`, `venueId 0xa3c034a0…`, txs `0x716c2c44…` / `0xc2c2b236…` |
| The oracle committee will read a contract we deploy | **True** | Our `BotNavOracle` returned 1; market settled `winningOutcome 1`, `voided false`, payout `10000000/10000000` |
| Venue creation needs a policy set (SDK docstring) | **False** | Both venues that demonstrably accept third-party creation run `policy=0x0`, `signer=0x0` |
| EIP-7702 works on Somnia | **False** | Type-4 tx → `invalid transaction` on all three RPCs; types 0/1/2 reach nonce validation |
| Session keys can scope an agent's Event-Contract trading | **False** | SDK: *"A BinaryPool escrows through the module and has no operator gate"* |
| A contract may call `placeBinaryOrder` | **True** | EOA and contract callers both revert `ERC20InsufficientAllowance` (`0xfb8f41b2`) — no caller-type gate. `placeBinaryOrderFor`'s `OnlyApprovedContracts()` (`0x3fb0ba2e`) is a router allowlist and fires identically for both |
| NAV can be `collateral.balanceOf(bot)` | **False, and fatal** | `tUSDC.faucet(uint256)` is permissionless, uncapped in frequency, 10,000/call — anyone can forge a profit for gas |
| Contract oracle sources are reliable | **False** | OracleHub prices Contract sources at **0.00 STT** — unpaid, therefore unserviced. 70% void (7/10) vs 0.59% (122/20,617) for the 6-JSON tier |

The last two are the reasons this design departs from the PRD.

## 3. Architecture

### Layer 0 — Agent registration
The developer generates an EOA locally (`npm run keys` in `examples/agent/`); the key never
leaves their machine and the
server stores only an address. Ownership is proved with EIP-191 `personal_sign` verified by
`verifyMessage`, replacing the unauthenticated `x-wallet-address` header for the one place
it must be load-bearing. Strategy metadata is hashed to `configHash` and written into the
meta-market's on-chain `context` blob.

### Layer 1 — Agents trade real Event Contracts
`bots/runner.ts` is a Node daemon using `createTrader({ privateKey })` — the SDK's headless
signing path this app never used. Agents trade live BTC/ETH Up/Down markets and every order
produces a real Shannon transaction hash.

### Layer 2 — BotVault owns the capital and the positions
The agent does not hold funds. A per-agent `BotVault` contract is the trader: the runner's
key may only call the vault's allowlisted `trade()` wrapper, which forwards to
`BinaryPool.placeBinaryOrder`. Because the vault is `msg.sender`, it owns every ERC-6909
position and can record every `marketId` it touches into a sealed session universe — the
enumeration the chain otherwise cannot provide.

NAV is **mark-to-settlement over that sealed set**, never a wallet balance:

```
NAV = protocolCash + Σ balanceOf(vault, outcomeId) × payoutNumerator / payoutDenominator
```

`protocolCash` moves only by collateral deltas measured inside an allowlisted DreamDEX
call, so a faucet top-up raises `balanceOf` and changes nothing. A permissionless
`sweepUnaccounted()` burns any difference, turning "trust our accounting" into an invariant
anyone can check.

Deposits and withdrawals are locked for the duration of a session.

### Layer 3 — Meta-market as a native DreamDEX Event Contract
Minted with `scheduleAndCreateMarket` on our own operator/venue, using the recipe recovered
from DreamDEX's own production markets rather than the one that voids:

- **6 JSON sources** (`sourceType 1`) plus **1 Contract source** (`sourceType 2`, free)
  reading `BotNavOracle.outcomeValue()`. *As built, those six are six reads of one mirror
  this project hosts, differing only by a `?v=` the hub keys sources by — they buy
  committee servicing, not independence. Six genuinely independent gateways reading the
  same on-chain value is the fix and is not done; `README.md` says so in its limitations.*
- `minAgreement = 4`, `subcommitteeSize = 3`, `subcommitteeThreshold = 2`
- `answerType = 0` (Numeric), intervals `[(1,1),(2,2)]` — **1 = YES (NAV rose), 2 = NO**,
  registered in that order, because `winningOutcome` is the *index* of the matching
  interval and index 0 is the market's Up/YES leg. Register NO first and every market
  inverts while looking perfectly reasonable in review. Zero must never be a valid answer,
  or "the oracle has not answered" and "NAV fell" become indistinguishable, and that cannot
  be fixed after minting.
- `context = abi.encode(vault, sessionId, configHash)`
- Value: re-quote `getSchedulingCost(def) + resolveReserve()` every mint with a small
  overpay buffer; excess refunds in-transaction. Never hardcode — the reserve is derived
  from `maxFeePerGas` and admins retune it. Currently ≈1.496 STT.

`BotNavOracle.outcomeValue()` must never revert and must be stable across the committee's
reads, because a subcommittee that disagrees voids the market.

### Layer 3b — Speculator agents price the meta-market
`bots/speculator.ts`, the same `createTrader({ privateKey })` path as the runner, signing
for its own funded EOA rather than a vault — it is not being measured, so it needs no
custody shape. Each poll reads the arena's open sessions, forms a view from evidence that
actually exists about that agent (its finished-session record under the rule of succession,
its cash against cash at open weighted by how far the session has run, how many markets it
has touched, how much runway is left), runs one of three theses, and places an order.

Two properties are load-bearing:

- **Orders REST.** `orderType 0` (LIMIT), not the runner's IOC. The runner cannot rest
  because `BotVault` has no `cancelOrder`; a speculator signs for itself and can cancel, and
  it *must* rest, or it can never post the first quote on an empty book. `expireTimestampNs`
  is the meta-market's own expiry, so an unfilled quote clears at session close.
- **Two opposing theses make the price.** One agent quoting alone is marking its own price.
  A `backer` and a `skeptic` on separate keys cross each other; a `contrarian` then fades
  whatever they printed, against the agent's record, and is the only thesis that requires a
  book to exist.

It mints its own stake from the collateral's permissionless faucet and logs every call at
`warn`. That is legitimate here and nowhere else: a speculator's balance is not NAV, is not
scored, and settles nothing — the whole point of §2's faucet finding is that `BotVault.nav()`
refuses to count exactly this kind of token.

### Layer 4 — The observatory
Because meta-markets are native Event Contracts, `/market/[id]`, `OrderBookPanel`,
`ProbabilityRail`, `Countdown`, `StatusPill`, `LiveRefresh` and the whole `globals.css`
token system work on them unchanged. New: `/agents`, `/agents/[id]`, `/agents/register`,
`/settlement`, `/audit`.

The frontend takes no side. Since every order on both layers is signed by a daemon outside
the app, there is no ticket to design, no connect-wallet flow, no faucet button and no
approval step — the agent that needs collateral calls the faucet itself. What the app owes a
visitor is the record: who is trading, what they did, what it is priced at, when it settles,
and a transaction hash beside each claim. A key never enters the web process.

## 4. Attack table

| Attack | Mitigation |
|---|---|
| Operator faucets tUSDC into the agent to force YES | NAV counts `protocolCash`, which only moves through allowlisted DreamDEX calls; `sweepUnaccounted()` burns the rest |
| Operator declines to redeem so NAV looks flat | Mark-to-settlement values unredeemed positions at their payout; redemption is not required to settle |
| Agent trades a market that expires after the session | Vault rejects entry when `expiry > sessionEnd` |
| Third party stalls settlement | `finalize()` and the meta-market's resolve path are both permissionless |
| Venue owner closes the venue mid-demo | We own operator 20; four other open venues are a one-line config fallback |
| One hand runs both speculator theses and marks its own price | Not preventable on chain, and not claimed to be: two addresses under one operator are wash trading. The mitigation is disclosure — the theses are separate processes on separate keys, both public, and a price is only worth what the reader's trust in the hands behind it is worth. A meta-market is a public Event Contract, so a third party's quote is what actually resolves this |

## 5. Claims we may and may not make

Not *"no oracle — the contract settles itself."* That is false and a judge who checks will
find it. Instead: **"Settlement is defined by code and attested by DreamDEX's oracle
committee. NAV is mark-to-settlement over a sealed set of markets the vault itself
recorded, and anyone can re-derive it from two published block numbers."** Never
"trustless", never "purely by code", never "atomic".

On the agent framing, the claim we may make is: **"every transaction in this product is
executed by an agent through the NPM SDK, on both layers."** The claim we may *not* make is
that anybody has yet traded against a speculator's quote. `bots/speculator.ts` is written,
dry-run-verified end to end against the live board, and unfunded; until two theses run on
funded keys, every meta-market book reads `unquoted` and we say so.

## 6. Scope and cut-line

Build order: contracts → market minting → runner → data model → UI → speculator. If time
runs short, cut in this order: (1) `sweepUnaccounted` reclaim UI, (2) the CLOB allowlist,
trading only via `mintCompleteSet`/`mergeCompleteSet`/`redeem`, (3) `MetaMarketFactory.sol`,
minting from the backend with viem instead — the on-chain result is identical. `BotVault`
and `BotNavOracle` are not cuttable; they are what makes the settlement claim true. The
speculator is not cuttable either now that the human path is gone: without it the second
layer has no other side at all.

Sessions run **90 minutes**, never 24 hours: a settlement must be able to land inside a
demo. Ninety is a floor as well as a ceiling — Shannon rolls BTC/ETH series at 3600s and
longer, and the vault refuses any contract outliving the session, so a shorter session gives
a trading agent nothing it is permitted to trade. Mint sessions continuously from now so
that several have already resolved by recording time, and play the settlement beat from an
already-settled `marketId`.

## 7. Known risks

- Contract sources void 70% of the time. We keep one only because it is free and adds
  on-chain verifiability; the 6 JSON sources carry `minAgreement`.
- Our single spike market used the doomed contract-only configuration and resolved cleanly
  anyway. With n=1 that proves nothing about the 70% rate — it is not evidence the design
  is safe, and the production recipe is used regardless.
- `scheduleAndCreateMarket` costs ~21.9M gas, near block-limit territory. Mint sequentially
  with confirmation waits, never in a parallel burst.
- The second layer has no other side until speculator keys are funded. Removing the human
  path means the book is empty *by construction* rather than by neglect, and the mitigation
  is entirely operational: fund two keys, start two theses, leave them running. Until that
  happens the honest word for every meta-market book is `unquoted`, and it is what the UI
  prints.
