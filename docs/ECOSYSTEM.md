# Business and ecosystem impact

*Everything below describes behaviour that exists in this repository today.
There are no user numbers, no TVL and no testimonials, because there are none —
this is a hackathon prototype, and inventing traction would undermine the only
thing it can honestly claim. Where a number appears it was measured on Somnia
Shannon and the transaction is in [`ONCHAIN_EVIDENCE.md`](./ONCHAIN_EVIDENCE.md).*

## The gap this fills

DreamDEX already answers "will BTC be up in an hour" very well. What it does not
have is a way to trade the *operator* rather than the underlying — and that is
the larger market in every other venue. Nobody buys a fund because they have a
view on the S&P; they buy it because they have a view on the manager.

Meta-Agent DEX supplies the missing instrument, and it supplies it **as a native
Event Contract on DreamDEX's own rails** rather than as a parallel system:
minted with `scheduleAndCreateMarket` on an operator and venue this project
registered for 0.0116 STT, settled by DreamDEX's own oracle committee, priced in
the same collateral, listed in the same indexer, rendered by the same market
page. Nothing about it asks DreamDEX to ship anything.

## Both sides of that market are agents

The instrument is traded by programs, not people. **Every transaction in this
project is signed headlessly by an agent** — reading through the
`@somnia-chain/markets-sdk` NPM SDK and signing locally with viem, because the
SDK's write path does not reach the public Shannon RPC (see
`DREAMDEX_SDK_FEEDBACK.md`):
trading agents (`bots/runner.ts`) earn a record against live BTC/ETH contracts,
speculator agents (`bots/speculator.ts`) stake collateral on whether that record
is about to improve, and the web app watches. Nobody connects a wallet to take a
side.

That is a stronger position for this venue, not a narrower one. The organiser's
category is *"Autonomous AI trading agents · Multi-agent trading
competitions"* — and a competition whose scoreboard is a leaderboard is an
assertion, while a competition whose scoreboard is an **order book** is a number
somebody had to stake to be wrong about. Agents pricing each other's performance
against a contract reading anyone can re-derive is that category taken literally.
Nothing in the loop waits for a human to click, which means the venue keeps
generating markets, quotes and settlements at three in the morning with nobody
watching.

## Three constituencies, three different reasons to show up

**AI and agent developers get a public track record they cannot fake.** Running a
strategy is easy; proving it ran is not. Here the vault is the trader, so every
position is on chain under the vault's address, and NAV is `protocolCash` —
collateral a DreamDEX call actually delivered — so a developer cannot top up a
losing session from a faucet and call it alpha. We measured that directly: 10,000
tUSDC pushed into a live vault moved `nav()` by exactly zero. A curve produced
under those rules is worth showing to someone.

**Speculator agents get exposure to a strategy without custody.** Funding a
trading bot means handing over the money. Taking a side on one does not: the
speculator buys a contract on the *outcome*, and the agent's capital stays in a
vault whose owner is someone else entirely. A losing session costs the
speculator the stake it escrowed, nothing more, and the agent's operator cannot
abscond with anything because the operator key cannot withdraw — it can only
trade. That is what makes an agent a safe thing for another agent to have an
opinion about: the counterparty risk is a price, not a deposit.

**DreamDEX gets volume on two layers from one event.** Each agent session is
simultaneously a *taker* of existing BTC/ETH contracts (the agent trades them
with real orders — see the vault's fill on a live BTC market) and the *subject*
of a new contract on the same venue, which a second fleet of agents then quotes.
One 90-minute session touches the order books that already exist and creates one
more that did not.

## Why the supply of markets is the interesting part

An exchange's ceiling is the number of questions it can ask. DreamDEX's current
questions come from a price feed and a clock, so the catalogue grows linearly
with assets × intervals. Agent sessions are a different generator: every agent
anyone deploys produces a new, genuinely uncertain, machine-resolvable question
every session, and the resolution source is a contract the agent's own operator
cannot corrupt.

That is the reusable primitive here, and it is not specific to trading bots. Any
program whose result is a single monotonic number the program cannot forge —
a vault's NAV, a model's score against a held-out set, an indexer's uptime — can
be minted into an Event Contract by the same path: publish the number from a
write-once contract, register it as an oracle source with paid JSON servicing
alongside it, and let the committee attest. `BotNavOracle` is 98 lines of
Solidity, comments included. The interesting work was not writing it — it was
finding out which parts of the platform actually support this, and that is
written down in [`ONCHAIN_EVIDENCE.md`](./ONCHAIN_EVIDENCE.md) §6 for the next
team.

## What it costs to run, measured

| | |
|---|---|
| Register an operator and a venue | 0.0116 STT, once, ever |
| Mint one meta-market | ≈1.496 STT, re-quoted per mint — the resolve reserve derives from `maxFeePerGas` and is never hardcoded |
| Gas for the mint | 21.9M for one source, ~0.35M per extra JSON source; sent with an 80M cap because a 26M ceiling reverted with empty revert data after burning 24M |
| Committee attestation | Six JSON sources at the paid tier, which is what buys a 0.59% void rate instead of 70% |

That per-market cost is the real economic constraint, and it is worth stating
plainly rather than hiding: a venue running thousands of short agent sessions
pays it thousands of times. Longer sessions — one market per agent per day
rather than per ninety minutes — is the obvious lever, and it trades directly
against demo-ability, which is why sessions here are 90 minutes and not 24
hours. Ninety is also the floor: Shannon currently rolls BTC/ETH series at 3600s
and longer, and `BotVault.trade` refuses any contract that outlives the session,
so a shorter session gives a trading agent nothing it is allowed to trade.

## The honest claim, and its limit

Meta-Agent DEX creates markets DreamDEX cannot generate from a price feed, and
it routes agent capital into the order books DreamDEX already has. What it does
**not** yet do is make those new markets tradeable in practice. The market side
now exists and has traded — `bots/speculator.ts` rests LIMIT orders precisely so
a `backer` and a `skeptic` on separate keys can cross each other and print a
price, and nineteen of its orders are mined on Shannon from `0xb4f2cFf5…5DD5`.
One of them, `0x91d5c29e…`, matched rather than merely rested: both outcome legs
were minted, one to the speculator and one to an unaffiliated address. What is
still missing is durability rather than a component. The books are only quoted
while a funded speculator is running, and the winnings are stranded until each
speculator key grants the module ERC-6909 operator rights — without that,
`redeem` reverts `0xdeda9030`. That is one transaction per key. So the distance
between "the market exists and settles" and "the market trades continuously" is
now operational, not architectural — and it is still a gap.

Nor has any of this been tested with users. There is no cohort, no conversion
rate and no retention curve, and there will not be an honest one before someone
who is not us runs an agent against it. Three agents have run real sessions on
Shannon with real losses recorded; that is the whole of the evidence, and it is
enough to argue the mechanism works and not enough to argue anyone wants it.

Worth being precise about one thing rather than hiding behind it: removing the
human trading path removes a demand story we were never entitled to tell. We had
no retail users and no way to get them inside a hackathon. What is left is a
claim we can actually support — that the mechanism produces an auditable price
on a program's performance, formed by programs that had to stake to express a
view. Whether humans are ever routed into that book is a product decision on top
of it, not a change to it: the meta-market is a native Event Contract on a
public venue, and nothing about it excludes a person who wants the other side.
