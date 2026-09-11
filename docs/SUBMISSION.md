# DoraHacks submission — Meta-Agent DEX

Somnia × DreamDEX Event Contracts Hackathon. Submission closes **2026-09-08
18:00 UTC**; internal hard stop **12:00 UTC**.

This file is the copy that goes into the submission form. Each section is
labelled with the form field it fills. Nothing in it is a number we did not
measure on Somnia Shannon.

---

## Field: Project name

Meta-Agent DEX

## Field: Tagline (one line)

**Agents trade, and other agents price the traders — a second-layer DreamDEX
Event Contract on whether an AI trading agent's session ends in profit, settled
on a NAV a faucet cannot forge, with no human on either side of the book.**

## Field: Short description (≈60 words)

AI agents trade real DreamDEX Event Contracts on Somnia Shannon out of a
`BotVault` they hold no withdrawal key to. Every session mints a **second**
Event Contract — native, on our own operator and venue — asking whether that
agent's NAV rises, and a second fleet of agents takes sides on it. Every
transaction is signed headlessly through the NPM SDK; the web app only watches.
Settlement is defined by a contract we deployed and attested by DreamDEX's
oracle committee.

---

## Field: Links

| | |
|---|---|
| **Live testnet prototype** | https://somnia.mdloglabs.org |
| **GitHub repo** | https://github.com/mdlog/meta-agent-dex |
| **Demo video (2–3 min)** | `TODO — video URL` |
| Chain | Somnia Shannon testnet, chainId **50312** |
| Explorer | https://shannon-explorer.somnia.network |
| Deployer / keeper | `0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE` |
| Audit trail, live | https://somnia.mdloglabs.org/audit |
| Audit trail, written | `docs/ONCHAIN_EVIDENCE.md` |

Nothing costs real money. Shannon is a testnet and every balance on it is test
value.

---

## Field: Full description

### The problem

DreamDEX answers *"will BTC be up in an hour"* well. What no venue on Somnia
answers is *"is this operator any good"* — and in every other market that is the
larger question. Nobody buys a fund because they have a view on the index; they
buy it because they have a view on the manager.

Two things stop that market existing today. You cannot verify an agent's track
record, because a screenshot is not evidence and a wallet balance can be topped
up by anyone. And there is no venue where a view on an operator can be priced at
all.

### What we built

Five layers, all live on Shannon right now, and **every transaction on every one
of them is signed by an agent, headless.** The `@somnia-chain/markets-sdk` NPM
SDK is the source of market data, ABIs and pricing throughout; the send is a
local viem signature to the same contracts, because the SDK's write path returns
`Missing or invalid parameters` on the public Shannon RPC — measured, and
reported upstream in [`DREAMDEX_SDK_FEEDBACK.md`](./DREAMDEX_SDK_FEEDBACK.md).
There is no human trading path in this product.

1. **The trading agent trades.** A Node daemon (`bots/runner.ts`) holds one hot
   key and places real IOC orders on live BTC/ETH Event Contracts. 211 verified
   transactions on Shannon so far, every one of them openable on the explorer
   from `/audit`.
2. **A vault owns the capital.** `BotVault.sol` is the trader at the pool, so it
   owns every ERC-6909 position. The runner's key may call exactly one function,
   `trade()`. `deposit`, `withdraw` and `setOperator` are `onlyOwner`, and the
   owner is a different address that never goes near the daemon.
3. **NAV is measured, not claimed.** `nav()` returns `protocolCash` and
   nothing else — collateral a DreamDEX call actually delivered, moved only by
   the balance delta measured around each call. It deliberately does not mark
   open positions to a book, because a thin book is a number an operator could
   move against their own settlement. Tokens arriving any other way land in
   `unaccounted()`, visible to anyone. Cost of that choice, and we show it: a
   vault mid-session reads at the cash it has not spent, so the agent board
   prints what its held legs would redeem for beside it.
4. **The meta-market is a native Event Contract.** Each session mints one with
   `scheduleAndCreateMarket` on an operator and venue we registered, asking
   whether that vault's NAV rises across the window. It is listed in the same
   indexer, priced in the same collateral, and rendered by the same market page
   as any BTC contract on the venue.
5. **Speculator agents price it.** A second daemon (`bots/speculator.ts`) holds
   its own funded EOA, reads the board, forms a view from the vault's own
   evidence — the agent's finished-session record, its cash against its opening
   cash, how many markets it has touched, how much of the session is left — and
   rests a LIMIT order. It rests rather than crosses because an order that only
   ever crosses can never be the first quote on an empty book. Run a `backer`
   and a `skeptic` on two keys and they take each other's side; that crossing is
   the price on an agent.

The web app is the **observatory** over those five layers: the leaderboard, the
live meta-markets, the settlement queue and the audit ledger. It reads chain,
holds no trading key, and takes no side.

### Innovation and originality — 20%

The novel object is a **second-layer Event Contract written on a number a
program produced**, rather than on a price feed and a clock — and both sides of
it are priced by autonomous agents.

That second half is not a detail. The organiser's own category for this
hackathon is *"Autonomous AI trading agents · Multi-agent trading
competitions"*. A competition where agents merely trade an existing venue is
that category approximated; a venue where autonomous agents **price each other's
performance**, and where the number that settles the price is a contract reading
anyone can re-derive in one `eth_call`, is that category taken literally.
Nothing in the loop waits for a human to click: an agent trades, a contract
measures it, other agents stake collateral on the measurement, and a committee
attests the number at a fixed second.

That matters beyond trading bots. An exchange's ceiling is the number of
questions it can ask, and DreamDEX's current catalogue grows linearly with
assets × intervals. Agent sessions are a different generator: every agent anyone
deploys produces a new, genuinely uncertain, machine-resolvable question every
session. The reusable primitive is *any* program whose result is a single number
the program's own operator cannot forge — a vault's NAV, a model's score against
a held-out set, an indexer's uptime — published from a write-once contract,
registered as an oracle source with paid JSON servicing alongside it, and
attested by the committee.

The hard part was not the idea. It was finding out which parts of the platform
actually support it, and three of the answers contradict the published
documentation (see the Q&A below).

### Technical implementation — 25%

- **Two Solidity contracts**, both deployed per-instance on Shannon.
  `BotVault.sol` (one per agent) is the trader, the custodian and the NAV
  accountant. `BotNavOracle.sol` (one per session, write-once) snapshots navT0
  at open, navT1 after close, and freezes `finalValue` to 1 (YES) or 2 (NO).
- **An undocumented selector, recovered from live calldata.**
  `scheduleAndCreateMarket` (`0x94f9fdc7`) exists in the deployed
  `BinaryMarketsModule` implementation but is not exported by the SDK. We
  decoded a production market's calldata and call it directly with viem.
- **A settlement recipe derived from measurement, not documentation.** Six paid
  JSON sources beside one free contract source, `minAgreement 4`,
  `subcommitteeSize 3`, `subcommitteeThreshold 2`, and `resolutionTime` at
  close + 180s. Every one of those choices is a response to a void rate we
  measured.
- **Three clocks that must line up.** `vault.sessionEnd`, `market.expiry` and
  `resolutionTime` are set to close, close, and close + 180s. The vault enforces
  the first against the second: `trade` reverts `MarketOutlivesSession`, which
  is what guarantees every position is terminal before the oracle freezes NAV.
- **A keeper that is a convenience, not an authority.** It redeems, closes and
  finalizes on a 30-second clock — and all three of those calls are
  permissionless, so if it dies a stranger can finish the job.
- **Two headless SDK signers, and one of them rests orders.** `bots/runner.ts`
  is IOC-only because `BotVault` exposes `trade` and no `cancelOrder`, so an
  order it rested could never be pulled back. `bots/speculator.ts` signs for its
  own EOA, can cancel, and therefore posts LIMIT orders with the meta-market's
  own expiry — the difference between an agent that can only take a price and an
  agent that can make one. Each of its theses names the clause that failed when
  it refuses, and none of them consults a random number.
- **47 tests** (`npm test`), 40 of which run with no network; 7 hit live
  Shannon and are skipped by `SKIP_LIVE_TESTS=1`. They cover market-status
  derivation, revert translation, the live→sim fallback and pool recycling.
- TypeScript strict throughout, no `any`. Money is carried as integers end to
  end — the env knobs are raw 6-decimal units precisely so no float gets near a
  settlement figure.

### UX and design — 20%

The design decision that drives everything: **a meta-market is a real Event
Contract, so it gets the real contract page.** `/market/[id]`, the order book
panel, the probability rail, the countdown and the status pill work on it
unchanged. There is no parallel "agent market" UI to learn.

The second decision follows from the first: **the app is an observatory, not a
terminal.** Since every order on both layers is signed by a daemon outside it,
there is no ticket to design, no connect-wallet dance and no approval flow. What
is left is the part a visitor actually needs — who is trading, what they did,
what it is priced at, and when it settles.

- `/` — the overview. Live meta-markets, the agent board, and a DATA SOURCE
  panel that prints what `/api/health` actually measured. It says "Reading
  Somnia", never "synced", because nothing in the app compares the indexer
  against chain head.
- `/agents` — ranked on sessions **finished**, so an agent with one finished
  session outranks every agent with none before any number is compared. An agent
  with no record carries no rank number at all.
- `/agents/[slug]` — built around one panel, **THE NUMBER THAT SETTLES**:
  `nav()` and `unaccounted()` side by side, because the comparison is the
  argument. Below it, the NAV curve, the declared strategy with its `configHash`,
  and the execution tape with a transaction hash per order.
- `/settlement` — the queue, the four mechanics steps, and a table with an
  **Oracle answer** column beside a **DreamDEX paid** column, so a reader can
  see the two are different things.
- `/audit` — the fixed trail with a hash per row, then the live stream of
  whatever this deployment has done since.

Two rules the UI follows without exception. **A value that does not exist prints
as a dash and says why**, never as zero. **A failed read renders as a failure**,
never as an empty field — those look identical if you are careless, and only one
of them is true.

### Business and ecosystem impact — 20%

`docs/ECOSYSTEM.md` is the long version. In short:

- **Agent developers** get a track record they cannot fake, because the vault is
  the trader and NAV counts only collateral a DreamDEX call delivered.
- **Speculator agents** get something that does not exist anywhere else on
  Somnia: a settleable claim on another program's performance, priced against a
  number that program's own operator cannot forge. Being wrong costs them the
  stake they escrowed and nothing more, and the agent they are pricing cannot
  abscond with anything, because its operator key cannot withdraw.
- **DreamDEX** gets volume on two layers from one event. Each session is
  simultaneously a *taker* of existing BTC/ETH contracts and the *subject* of a
  new contract on the same venue — and nothing about it asks DreamDEX to ship
  anything.

Measured cost of running it: **0.0116 STT** once for the operator and venue,
**≈1.496 STT** per meta-market re-quoted at mint. That per-market cost is the
real constraint and the obvious lever is longer sessions — which trades directly
against demo-ability, and is why sessions here are 90 minutes rather than a day.
Ninety is also a floor rather than a preference: Shannon is currently rolling
BTC/ETH series at 3600s and longer, and `BotVault.trade` refuses any contract
that outlives the session, so a shorter session contains nothing an agent may
trade at all.

**There are no user numbers, no TVL and no testimonials in this submission,
because there are none.** Three agents have run real sessions with real losses
recorded. That is enough to argue the mechanism works and not enough to argue
anyone wants it.

### Presentation and demo — 15%

The demo is the running system, and `/audit` is its receipt: every session open,
mint, freeze and trade this deployment has done, each with a hash that opens in
the Shannon explorer. The 2–3 minute video follows `docs/DEMO_RUNBOOK.md`, which
is timed beat by beat, opens by starting the agents on camera rather than
clicking anything, and includes what to say when a market voids on camera.

The runbook is also explicit about the one thing that cannot be filmed live: a
session runs 90 minutes and the committee reads the oracle 180 seconds after
expiry, so the settlement beat is filmed on a session that has **already**
settled. Nothing in the video waits.

---

## Field: Tech stack

| Layer | What |
|---|---|
| Contracts | Solidity, `solc --optimize --via-ir`. `BotVault.sol`, `BotNavOracle.sol` |
| Chain access | `@somnia-chain/markets-sdk` 0.28.1 for market discovery, order books, ABIs and the crossing kernel; viem 2.x for every write. The SDK's write path returns `Missing or invalid parameters` on the public Shannon RPC — measured, and reported upstream in [`docs/DREAMDEX_SDK_FEEDBACK.md`](./DREAMDEX_SDK_FEEDBACK.md) |
| Trading agent | `bots/runner.ts` — Node 22 daemon, TypeScript run directly with `--experimental-strip-types`; reads through the SDK, signs locally with viem (`bots/send.ts` documents why) |
| Speculator agent | `bots/speculator.ts` — same idiom, same SDK, its own funded EOA; rests LIMIT orders on the meta-markets and redeems what settles |
| App | Next.js 15 App Router, React 19, TypeScript strict, Tailwind v4 — read-only observatory |
| Store | `node:sqlite` — a journal of what the keeper observed, never the source of truth for money |
| Data source | DreamDEX indexer (GraphQL) for discovery, JSON-RPC and WS RPC for chain reads |
| Tests | Vitest, 47 tests — 40 offline, 7 against live Shannon |

No trading key is ever read, stored or configured by the app. Every order on
both layers is signed by an agent daemon running outside it —
`AGENT_OPERATOR_KEY` for a trading agent, `AGENT_SPECULATOR_KEY` for a
speculator — and neither key is ever read from a file the web process can see.

---

## Field: What is deployed where

| Thing | Where |
|---|---|
| Operator | **operatorId 20**, registered by us — `registerOperator` tx `0x716c2c44…23c3` |
| Venue | `0xa3c034a0398f2cd3465cee88fec2489b78fe26933af4d394d6c87fc4cf00fa77` — `createVenue` tx `0xc2c2b236…7da7`, `policy` and `signer` both zero |
| `BotVault` | One deployed per agent, live on Shannon. Three running now |
| `BotNavOracle` | One deployed per session, write-once. First one at `0xa2caf095…2229` |
| Meta-markets | Native DreamDEX Event Contracts on operator 20 / venue `0xa3c0…fa77`, asset ticker **BOTNAV**, minted with `scheduleAndCreateMarket` |
| Trading agents | Three `bots/runner.ts` processes, one per vault, off chain, each holding an operator key that may only call `trade()`. 211 verified transactions between them |
| Speculator agents | `bots/speculator.ts`, off chain, one process per thesis on its own EOA. Written and dry-run-verified against the live board; **no key funded, so no order mined yet** |
| Web app | https://somnia.mdloglabs.org — Next.js production build, read-only |
| Keeper | A 30-second loop against `POST /api/agents/cycle`. Every call it makes is one a stranger could also make |

The first meta-market we minted (`0x…01580a`) took a real committee resolution:
**`winningOutcome 1`, `voided false`, payout `[0, 10000000] / 10000000`** — paid
on the value our own contract returned.

---

## Judge Q&A

Short answers with the evidence attached. The long version of every one of these
is in `docs/ONCHAIN_EVIDENCE.md`.

### "What stops the operator from just topping up the wallet before settlement?"

Nothing stops them sending the tokens — Shannon's collateral has a
permissionless, cooldown-free `faucet(uint256)` capped at 10,000 per call, so
*anyone* can push tokens into *any* address for the price of gas. What stops it
mattering is that `nav()` returns `protocolCash`, which moves only by collateral
deltas measured inside an allowlisted DreamDEX call; everything else lands in
`unaccounted()`, where anyone can read the gap rather than take our word for
it. We measured this on a live vault: 10,000 tUSDC faucet'd in took `balanceOf` to **10,197.91**
while `nav()` moved by **exactly zero** and `unaccounted()` showed the full
10,000 gap.

### "Is settlement really trustless?"

No, and we do not claim it is. Settlement is **defined by code and attested by
DreamDEX's oracle committee**: `BotNavOracle` publishes one number that can
never be restated, and a validator subcommittee reads it at `resolutionTime` and
votes on what it saw — if the subcommittee disagrees with itself, the market
voids and both sides are refunded. What *is* true without qualification is that
NAV is one ERC-20 quantity anyone can re-derive from two published block
numbers, and that `redeemAll()`, `closeSession()` and `finalize()` are all
permissionless, so no operator can strand the other side by refusing to act.

### "Did you deploy contracts, or are you just calling DreamDEX's?"

Both, and the split is the point. We deploy `BotVault.sol` per agent and
`BotNavOracle.sol` per session — those are what make the settlement claim true,
and they are not cuttable. Everything else runs on DreamDEX's own rails: we
registered our own operator and venue for 0.0116 STT and mint markets through
`scheduleAndCreateMarket` on the deployed `BinaryMarketsModule`, so a
meta-market is a native Event Contract rather than a shadow of one.

### "What did you measure that surprised you?"

**EIP-7702 does not work on Somnia** despite its own JSON-RPC docs saying it
does — type-4 transactions are rejected `invalid transaction` on all three RPCs
while types 0/1/2 reach nonce validation — and session keys turn out to be
spot-only for Event Contracts, so the honest primitive here is capital
segregation rather than key restriction. **Contract-type oracle sources are
priced at 0.00 STT by the OracleHub**, meaning nothing funds a validator to
service one: 7 of 10 live contract-sourced samples voided against 122 of 20,617
(0.59%) for the paid six-JSON tier, which is why every meta-market buys six JSON
sources and puts `resolutionTime` 180 seconds after expiry instead of on it.
And **the answer encoding is the payout wiring** — `winningOutcome` is the
*index* of the matching numeric interval, so registering NO first would invert
every market on the platform while looking perfectly reasonable in review, and
we had it backwards in our own documentation until it was re-derived from
`finalize()`.

### "Can I verify an agent's NAV myself, without your app?"

Yes, in one `eth_call` per number. `nav()` and `unaccounted()` are public views
on the vault, the vault address is on the agent page and links into the
explorer, and the session's navT0/navT1 pair is frozen in that session's
`BotNavOracle`. The app's database is a journal of what the keeper observed; it
is never what a market settles on.

### "What happens if your keeper dies mid-session?"

The session is not stuck, because every call the keeper makes is permissionless
— `redeemAll()`, `closeSession()` and `finalize()` can be sent by anyone. What
is at risk is the *clock*: if nobody freezes the oracle inside the 180-second
window before `resolutionTime`, the committee reads a zero, which lands outside
both registered intervals and voids the market, refunding both sides. That is
the designed failure and it costs nobody their stake, but it is a real
single-process dependency and we say so in the README's limitations.

### "If agents are on both sides, who is the market for?"

The mechanism is the product. What this produces is a thing that does not exist
on Somnia today: **an auditable price on a program's performance, formed by
other programs that had to stake collateral to express the view.** A leaderboard
is an assertion; a book is a number someone paid to be wrong about. The
speculators are not decoration on a human market — they are what turns the
second layer from a scoreboard into a price, and every one of them names the
clause that made it act, in a log line you can read.

That price is useful to anyone downstream who needs to allocate to an agent:
another agent choosing which strategy to copy, a treasury deciding which
operator to fund, an evaluator who wants a number rather than a screenshot. None
of those consumers has to be human, and none of them has to trust us — the
settlement figure is `BotNavOracle.outcomeValue()`, one `eth_call`.

Human participation is a **routing question, not an architectural one**. The
meta-market is a native DreamDEX Event Contract on a public venue: nothing stops
a person taking the other side of a speculator today, and if we wanted a retail
front end we would put a ticket back on the market page and change nothing
underneath it. We removed it because it was the weakest part of the story, not
because the architecture excludes it. What the architecture *does* exclude is
the thing that made the old framing dishonest — a market that only worked when
somebody happened to be watching.

### "Your meta-markets have no order book. Isn't that the whole product?"

It was the honest gap, and it now has a named agent aimed at it:
`bots/speculator.ts` rests LIMIT orders so that a `backer` and a `skeptic` on
separate keys cross each other and print a price. Every stage of it has been
exercised end to end in dry run against the live deployment — the board read,
the per-market chain reads, the view, the three theses, the sizing, the
refusals, the redemption path — and the write path is type-checked against the
SDK's own parameter types.

What has **not** happened is a live fill: that needs funded speculator keys, and
none have been funded. So the honest status is that a minted meta-market is
real, listed, settleable and still `unquoted`, and the remaining distance is a
funded key rather than a missing component. What *is* proven, with transaction
hashes, is every part a market maker would need to trust: the mint, the NAV, the
freeze, and the committee resolution.

### "Why should a losing agent be interesting?"

Because a market on "will this agent profit" is only worth trading if the answer
can be no. We ran a full session to a real loss — navT0 **100.00** → navT1
**92.60**, −7.40 tUSDC — after `redeemAll()` converted a position that expired
worthless back into cash. The agent bought YES, NO won, and the meta-market on
that session paid the Down leg.

### "What breaks if this gets popular?"

`scheduleAndCreateMarket` costs ~21.9M gas and is sent with an 80M cap after a
26M ceiling reverted with **empty revert data after burning 24M**, so mints are
serialised behind confirmation waits — market creation is one agent-session per
confirmed block round, not a parallel burst. The keeper's single deployer key
serialises every write behind one nonce, and `node:sqlite` with inline SQL means
a Postgres port changes the signature of nearly every service function. And the
six "independent" JSON sources are six reads of one mirror we host: they buy
committee *servicing*, not independence, and six genuinely independent gateways
reading the same on-chain value is the fix we have not done.

---

## Honest limitations, stated up front

Repeated from the README because a judge who finds these unprompted trusts the
rest less.

- **Testnet only.** Somnia Shannon, chainId 50312. Every balance is test value.
- **Speculator redemptions revert, and we know why.** The second layer trades:
  19 `placeBinaryOrder` transactions are mined on Shannon from
  `0xb4f2cFf5…5DD5`, and at least one of them matched rather than merely rested
  — in `0x91d5c29e…` the speculator paid 19.999980 tUSDC into the pool, took
  1.184040 back as price improvement, and both outcome legs were minted, one to
  the speculator and one to an unaffiliated address. What does *not* work is
  collecting the winnings: neither speculator EOA granted the module ERC-6909
  operator rights, so `redeem` reverts `0xdeda9030` (`InsufficientPermission`).
  It is one `setOperator` transaction per key, not a code change, and until it
  is sent those winnings sit unredeemed.
- **No browser-signing path remains, and the one signature left is not trading.**
  Registering an agent needs an EIP-191 `personal_sign` from the owner key,
  because `configHash` goes on chain — produced locally by `npm run register` or
  the signed curl documented at `/docs`. The market page's trade ticket is gone,
  and so is the browser registration form.
- **Settlement depends on DreamDEX's committee.** We resolve nothing. A void
  refunds both sides and is the designed failure, not an error state.
- **The six JSON oracle sources are one origin.** They buy servicing, not
  independence.
- **A voided meta-market's refund path is correct by construction but
  unobserved.** We have watched markets settle; we have not watched one of ours
  void and be refunded.
- **The keeper is a single process.** Everything it does is permissionless, so
  nothing is stuck if it dies — but nothing is automatic either.
- **Agent ownership is signature-proved; browsing identity is not.** Registering
  an agent needs an EIP-191 `personal_sign` from the owner key because
  `configHash` goes on chain. There is no browsing identity at all any more — the
  unsigned header, the session cookie and the users table went out with the human
  trading path, so there is nothing left for SIWE to secure.
- **The strategies are deliberately simple.** Momentum and mean-reversion over
  the pool's own implied probability, there to produce an honest NAV curve that
  can go down — not to be alpha.

---

## Pre-submission checklist

- [ ] Repo pushed and public; `scripts/push-to-github.sh` refuses to publish if
      a private key is staged — run it and read its output.
- [ ] `.data/demo-operators.json` and `.data/runners.txt` are **not** in the
      repo. They hold real operator keys.
- [ ] Repo URL filled in above and in `README.md`'s "For judges" table.
- [ ] Video recorded per `docs/DEMO_RUNBOOK.md`, 2–3 minutes, URL filled in
      above and in `README.md`.
- [ ] https://somnia.mdloglabs.org returns `"mode":"live"` from `/api/health`.
- [ ] The keeper and the three trading agents are running, and have been for an
      hour, so `/agents` and `/audit` are not empty when a judge opens them.
- [ ] At least a `backer` and a `skeptic` speculator are running on separate
      funded keys, so a judge who opens a meta-market sees a book rather than
      `unquoted`. If they are not funded, the liquidity limitation above stays
      written exactly as it is.
- [ ] At least one meta-market on the venue has `isResolved: true` on chain.
- [ ] `npx tsc --noEmit` is clean and `npm test` passes.
