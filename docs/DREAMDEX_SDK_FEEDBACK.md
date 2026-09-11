# Integration report for the DreamDEX team

**From:** Forecast Arena, a client of DreamDEX Event Contracts
**Against:** `@somnia-chain/markets-sdk` **0.28.1**, Somnia Shannon testnet, chain 50312
**Written:** 1 Sep 2026. Every number below was measured against the live testnet
on that day, and the command that produced it is named.

Forecast Arena deploys no contract. It is a pure client: discovery, book depth,
order placement, settlement and redemption all go through this SDK. That makes
it a reasonable test of what the SDK is like to integrate against for the first
time, which is what this document is about.

The short version: **the type documentation is unusually good and the surface
documentation does not lead you to it.** All four traps below are described,
correctly and in detail, inside the `.d.ts` files. None of the four appears
anywhere in the package README — the 309 lines a developer actually reads
first. We hit all four, in the order below, and each one cost real time.

---

## 1. Lifecycle status is event-derived, and two of the transitions emit no event

`BinaryMarket.status` (aliased from the indexer's `clobStatus`) is derived from
lifecycle events. The Listed → Trading → Settling transitions are
timestamp-implicit and emit none, so a contract that has sailed past its expiry
can still read `"Trading"` with no book behind it.

The SDK says so, in `dist/markets.d.ts`:

> Lifecycle status (aliased from the indexer's `clobStatus`). Derived from
> lifecycle EVENTS only — the timestamp-implicit Listed→Trading→Settling
> transitions emit none, so derive the live trading state from
> `tradingStart`/`expiry` between events rather than trusting this alone.

That sentence is exactly right and it is the single most useful line in the
package. It is also in a `.d.ts` file, which means a developer reads it *after*
they have already written the code that trusts `status`.

**What we measured.** Our Sprint-0 spike hit the bad case hard: 20 markets
reporting `Trading`, all long expired, none with a book. Today the same read
looks clean — 14 of 14 live markets report `Trading` and all 14 are genuinely
unexpired; `listPastBinaryMarkets(200)` returns `Finalized` for all 200. We
watched one 1m contract cross expiry to find the width of the window, and on
today's series it is small: at expiry + 5s the indexer already read `Finalized`,
the chain read `status: 4` (Resolved), and the market had already dropped out of
`listLiveBinaryMarkets`. So the stale-`Trading` window is bounded by how fast the
oracle resolves, and today that is seconds.

That is the trap. The failure is **invisible when the oracle is fast and
unbounded when it is not** — which is precisely the shape of bug that passes a
demo and fails in production.

**How we handle it.** `deriveStatus()` in `src/lib/dreamdex/adapter.ts` treats
timestamps as authoritative and lets the event status win only when it says
something the clock cannot know: `voided`, or `resolved` (including a
non-null `winningOutcome`). Everything else — `upcoming`, `trading`, `locked` —
is decided by `tradingStart`, `expiry` and the clock. Discovery uses
`listLiveBinaryMarkets` (`expiry > now`) rather than a status filter, and every
write is gated on a fresh `getMarketOnchain` read rather than on any indexed
status at all.

**Ask.** Put that `.d.ts` paragraph in the README, next to the first code sample
that reads a market. One paragraph, high in the surface documentation, would
have saved us the spike.

---

## 2. Up and Down are one book, and prices travel in YES terms

A Down (NO) token at 0.38 *is* the resting order for an Up (YES) token at 0.62.
There is one book; `BinaryOrderBook` presents four sides, of which two are
derived: `noBids` from `yesAsks` inverted, `noAsks` from `yesBids` inverted.

Downstream of that, the whole write path is YES-terms whether you are buying Up
or Down:

- `placeOrder` takes `price` in YES terms for both sides.
- `BinaryStakeQuote` returns **two** prices for exactly this reason — `yesPrice`
  ("what `placeOrder` takes") and `limitPrice` ("the same protective limit in the
  traded outcome's OWN terms … Display this").
- `OrderFilled.fillPrice` is always YES-terms, so a NO fill has to be read as
  `1 − fillPrice` before it can be shown to a user or turned into a P&L number.

Each of those three facts is documented in the types. Together they form a
convention — *prices cross every boundary in YES terms; invert only at the two
edges, display and interpretation* — and the convention itself is never stated
in one place.

**Why it matters more than it sounds.** This is the bug class where nothing
throws. A Down order priced at `1 − p` instead of `p` is a perfectly valid order
at a wildly wrong price. A Down fill recorded at the YES price is a perfectly
valid number on a leaderboard. We got this wrong once in each direction and both
times the symptom was a plausible number, not an error. Our regression suite now
has a dedicated test for it (`tests/orders.test.ts`, "the Down/Up unit split")
and another that drives the route end to end (`tests/routes.test.ts`: a Down fill
at an on-chain Up price of 0.60 must record an entry price of 0.40).

**Ask.** A short "Price orientation" section in the README: one book, YES terms
on the wire, `limitPrice` for display, `1 − fillPrice` for a NO fill. Naming
`BinaryStakeQuote`'s two fields side by side in that section would carry most of
it.

---

## 3. The lot/tick grid: `stake / price` almost never lands on it

This one cost us the most, and it is the one we would most like to see moved
into the README.

Every live BinaryPool on Shannon reports
`{ tickSize: 1000n, minQuantity: 1000n, lotSize: 1000n }` via
`getBinaryBookParams`, against tUSDC with `decimals() === 6`. So `lotSize` 1000
raw is **0.001 outcome tokens** — the pool accepts three decimal places, and the
obvious naive sizing produces six.

The obvious naive sizing is `quantity = stake / price`. It is what a first
implementation writes, and it is wrong. Measured by `eth_call` against two live
Shannon pools:

```
pool 0x4e83efca63853d0760b3141ea0297971cd5e8ef9, bestAsk 0.197, stake 10
  quantity 50761421  ->  InvalidQuantity(["50761421","1000"])
  quantity 50761000  ->  clears the quantity gate (fails later, on escrow)

pool 0x4d0028954607a7d9c0cdc0d4a1faf2393f519ff0
  quantity 17857143  ->  InvalidQuantity(["17857143","1000"])
```

A remainder of 421 out of 50,761,421 — 0.0008% of the order — is the difference
between a fill and a revert. And it is not a rare corner: swept across every tick
price from 0.010 to 0.990 crossed with integer stakes 1…200, **7,856 of 196,200
combinations align — 4.0%**. At the 0.197 ask above, 1 of 200 integer stakes
aligns. Only "round" prices (0.5, 0.25, 0.2, 0.125) divide cleanly, and a live
1m crypto book does not sit on those.

Nothing in the call path rescues you. `binaryOrderCall` forwards `quantity`
verbatim and guards only `quantity <= 0n`, which is correct — the pool is the
right place for that check — but it means the first signal a developer gets is a
custom error at the end of a signed transaction.

**The SDK already ships the fix, and we did not find it.** `getBinaryBookParams`
reads the grid; `quoteBinaryStakeOverBook` walks the live book, snaps the price
UP to the tick grid and the quantity DOWN to a whole lot, enforces `minQuantity`,
pads a slippage cushion with a ten-tick floor for long shots, and re-fits the
quantity so the escrow can never exceed the stake. Its own source comment reads
*"The pool rejects a non-lot quantity (`InvalidQuantity`)"*. It is exactly the
function we needed and we hand-rolled `stake / price` instead, because nothing
we read first mentioned that a grid existed.

Forecast Arena now sizes every order through that kernel (over the raw four-sided
book, `slippageBps: 100n`), sends the lot-aligned `quantity` and tick-aligned
`yesPrice` verbatim rather than re-deriving them from a rounded float, and
translates all of `InvalidQuantity`, `QuantityNotAlignedToLotSize`,
`QuantityBelowMinimum`, `PriceNotAlignedToTickSize` and `PriceOutOfBounds` into
copy a user can act on.

**Asks, in order of value:**

1. **A README section titled "Sizing an order".** Three sentences: pools enforce
   a tick/lot/minimum grid, read it with `getBinaryBookParams`, and let
   `quoteBinaryStakeOverBook` do the arithmetic. This single addition prevents
   the entire class.
2. **Consider a dev-mode guard in `binaryOrderCall`.** It already validates
   `quantity <= 0n`; a cached `getBinaryBookParams` read and a thrown
   `"quantity 50761421 is not a multiple of lotSize 1000 — use
   quoteBinaryStakeOverBook"` would turn a post-signature revert into a
   pre-signature error message that names its own fix.
3. **The indexer returns `tickSize`, `lotSize` and `minQuantity` as `null`** on
   binary market rows, so the chain read is the only route. Populating them would
   let a client that already has the market row skip an `eth_call` — worth it
   given a discovery page can hold 40 markets.

---

## 4. Pool recycling: only the live-store book read is guarded

A BinaryPool is reused across successive markets. We measured it: over the 14
live and 200 most recent settled binary markets on Shannon today, those 214
markets are served by **28 distinct pool addresses**, and **23 of the 28 serve
more than one `marketId`** — the busiest serves 20.

The consequence is sharper than "addresses repeat". Right now:

```
pool 0xefa394da8e8dc1f94b3d8cd0d28f8982a2442cfb
  settled market  expiry 2026-09-01T10:30:00Z   status Finalized, winner NO
  live market     expiry 2026-09-01T10:34:00Z   status Trading

getBinaryOrderBook(<that pool>) -> bestBid 234000, bestAsk 261000, 6 levels
```

Both markets report that address as their `poolAddress`, and
`getMarketOnchain(<settled id>).pool` returns it too. So a client holding the
**settled** market's id, following the only chain-read path the SDK offers,
receives a live two-sided book that belongs to a **different contract**. Not an
empty book. Not an error. The successor's real liquidity, correctly formatted,
under the wrong market's id. 28 of the last 100 settled markets are in that
position at this moment.

**The SDK already knows about this, in exactly one place.**
`getLiveBinaryOrderBookByMarket` documents it precisely:

> Because a BinaryPool is RECYCLED across markets (one pool serves successive
> markets, never concurrently), a page keyed on a `marketId` must never render
> the pool's NEXT market's orders once its own market has ended. This read
> resolves the market's current pool and, if `marketId` is no longer the pool's
> current binding (stale/ended), returns an EMPTY book.

That is the right behaviour and the right warning. **The gap is that it exists
only on the live-store side.** The chain-read family is pool-keyed with no market
guard: `getBinaryOrderBook(pool, …)` is the only `eth_call` book read, and there
is no `getBinaryOrderBookByMarket`. An application that reads depth from chain
head rather than from the websocket tail — which we do deliberately, because the
indexer is a cache and we do not want a cached answer deciding a write — has no
protected path and no warning on the function it is actually calling.

We shipped this bug ourselves before catching it, which is the best argument we
can make that the warning belongs on the chain-read call. `LiveDreamDexAdapter`
kept a `marketId → pool` map with no eviction and called
`getBinaryOrderBook(pool)` unconditionally, so our market page rendered a
resolved contract's page with its successor's live depth — real numbers, a fresh
`capturedAt`, the wrong contract. Nothing about the SDK call we were making
suggested that was possible.

It is fixed now, and the fix is worth quoting because it is what every client
will have to write independently until ask 1 lands: resolve the market first,
refuse to touch the pool unless `status === "trading"`, and render "this contract
no longer has a book" instead of somebody else's liquidity. A live test pins it
(`tests/dreamdex.test.ts`, *"never serves a closed contract the successor's
book"*), asserting against whichever settled contracts currently share a pool
with a trading one.

**Asks:**

1. **A chain-read `getBinaryOrderBookByMarket(marketId, opts)`** with the same
   stale-binding guard as the live-store version. This is the one that closes the
   class.
2. Failing that, an optional `expectMarketId` on `getBinaryOrderBook` that
   returns an empty book (or throws) when the pool's current binding does not
   match.
3. Repeat the recycling warning on `getBinaryOrderBook`, `getBinaryBookParams`
   and `BinaryMarket.poolAddress` — anywhere a developer can pick up a pool
   address and hold onto it. The `OnchainOrder` doc already carries the same
   idea ("Order ids are unique per POOL, not globally"); the book read deserves
   it more.

---

## What worked, specifically

Not padding — these are the four things that saved us the most time, and they are
worth knowing are load-bearing:

- **`listLiveBinaryMarkets` + a batched `getBookTops`** gives a whole discovery
  page in two round-trips with no N+1 fan-out. That shaped our entire read
  strategy and it has never been the bottleneck.
- **`quoteBinaryStakeOverBook` is a better function than its own README lets on.**
  Once found, it replaced about sixty lines of our own arithmetic — book walk,
  tick alignment, lot flooring, minimum enforcement, slippage cushion, escrow
  re-fit — with one call, and it is the reason our order sizing is now correct
  rather than approximately correct. The ten-tick slippage floor for long-shot
  outcomes is a detail somebody thought carefully about; at a 0.069 price it is
  the difference between a 1% cushion that rounds to nothing and a real one.
- **`contractErrorsAbi` is exhaustive and generated**, so we could rebuild our
  revert-translation table against it programmatically instead of guessing. We
  have a test that reads it back and asserts every name we map actually exists —
  which promptly found one we had invented (`MarketNotTrading`, which no deployed
  contract can raise).
- **`OrderPlaced` carrying `placedOrder.isBid` and `placedOrder.owner`** is what
  let us verify the *side* of a fill from chain. `OrderFilled` alone carries no
  direction, so without that second event a genuine own-wallet Up receipt could be
  relabelled Down and scored at the inverted price. We check both, and the `owner`
  field also fixed a false negative: a relayer-submitted order is attributable to
  the wallet that owns it, which a `receipt.from` check alone rejects. We saw a
  real relayer-submitted fill on Shannon while measuring this, so that is not
  hypothetical.

## One-line summary of the asks

Move four paragraphs that already exist in the `.d.ts` files into the README —
status is event-derived; prices are YES-terms on the wire; pools enforce a
tick/lot grid and `quoteBinaryStakeOverBook` respects it; pool addresses are
recycled — and add a **chain-read** book-by-market call so the recycling guard is
not live-store-only.

---

*Measurements in this document are reproducible from this repository:
`npm run probe` (Sprint-0 connectivity spike), `npm test` (7 tests hit live
Shannon, including one that decodes a real fill from its own `OrderFilled` and
`OrderPlaced` logs), and `npm run workflow` (83–93 end-to-end checks against a
running instance). The pool-recycling and status-window figures came from
ad-hoc probes written against this SDK during the audit; the collision they
describe is re-derivable from `listLiveBinaryMarkets` and
`listPastBinaryMarkets` in about ten lines.*

---

## Addendum — 2026-09-07, from building a two-layer agent market

Three findings from running agents against Shannon all day. Each was measured
twice, and each cost real debugging time, so each is written the way we would
have wanted to read it.

### 1. Every SDK write fails on the public RPC; the identical viem call succeeds

`trader.faucet`, the trader's internal `approve`, and `trader.placeOrder` each
come back:

```
@somnia-chain/markets-sdk: <call> reverted: Missing or invalid parameters.
JSON-RPC -32000, data 0x03
```

against `https://dream-rpc.somnia.network`, with a funded key that has STT and
tUSDC. The same contract, ABI and arguments sent with a plain viem
`writeContract` are mined:

```
trader.placeOrder(...)          -> placeBinaryOrder reverted: Missing or invalid parameters
walletClient.writeContract(...) -> status success, gas 3,436,427
```

Reproduced with `createTrader({ privateKey })`, with an HTTP `walletClient`, and
with an explicit HTTP `publicClient`; and with the pool pre-approved, so the
failure is not the approve leg. Reads through the same client are fine
throughout. The one structural difference we could find is that the SDK
broadcasts through `realtime_sendRawTransaction` over its WebSocket, while viem
uses `eth_sendRawTransaction` over HTTP.

Notably, `createOperatorAdmin(...).registerOperator()` and `createVenue()` DID
land through the SDK earlier the same day, so the machinery writer's
`eth_sendRawTransaction` fallback appears to work where the trader's path does
not.

**What would have helped:** the error surfaced is the raw node message. Naming
the leg that failed (`realtime_sendRawTransaction` vs the fallback) and
including the request body in the thrown error would have turned a two-hour
investigation into a five-minute one. An opt-out — `createTrader({ broadcast:
"eth_sendRawTransaction" })` — would have removed it entirely.

### 2. A resting order is invisible to both book reads

After a successful `placeBinaryOrder` that escrowed collateral (a 20 tUSDC
ERC-20 `Transfer` in the receipt), the order could not be seen through either
`getBinaryOrderBook(pool, …)` or the indexer's `getBookTops`, and
`getBookLevels(isBid, n)` read empty on both sides. It was genuinely resting:
a later crossing order from a second key filled against it, and the two accounts
ended holding 20 YES and 20 NO of the same market.

The pool emitted three events on that transaction whose topic0 values match
nothing in the SDK's `eventsAbi` — `0x74d63d9f…`, `0xd90f62f6…`, `0xcdd45acd…` —
so a consumer decoding fills from the receipt with the shipped ABI sees zero
fills on a transaction that traded.

**What would have helped:** publishing the deployed pool's event ABI, and saying
which of the book reads is authoritative for an order that has not been indexed
yet.

### 3. `scheduleAndCreateMarket` is not in the SDK, and its gas is not guessable

Third-party market creation exists on the deployed `BinaryMarketsModule`
(selector `0x94f9fdc7`) but is not exported. We recovered the signature from a
third party's live calldata. Two things then cost time:

- A 26,000,000 gas ceiling reverts with **empty revert data** after burning
  24,041,403 — an inner call starved of its 63/64 allowance, indistinguishable
  from a rejected argument. Seven sources need ~35M. Somnia's block limit is 15
  billion, so the ceiling was pure self-harm.
- `getSchedulingCost` prices `sourceType 2` (Contract) at **0.00 STT**, which is
  a strong signal that nothing services it. Empirically: 7 of 10 live
  contract-sourced markets void, against 122 of 20,617 (0.59%) for the paid
  6-JSON tier. We register six JSON sources alongside the free contract source
  and have settled cleanly since.

**What would have helped:** exporting the creation ABI, and documenting that a
zero-priced source type is unserviced rather than free.
