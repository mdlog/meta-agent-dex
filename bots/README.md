# The agents

Every transaction in Meta-Agent DEX is signed by an agent, through the DreamDEX
NPM SDK. There is no human trading path. Two daemons, one per layer, and this
file documents both — read them before you run them; they are meant to be read.

| File | Layer | What it signs with | What it trades |
|---|---|---|---|
| [`runner.ts`](#the-agent-runner) | 1 | The vault's operator hot key | Live DreamDEX BTC/ETH Event Contracts, out of a `BotVault` |
| [`speculator.ts`](#the-speculator-agent) | 2 | Its own funded EOA | The meta-markets that ask whether a layer-1 session's NAV rose |

```bash
node --experimental-strip-types bots/runner.ts
node --experimental-strip-types bots/speculator.ts    # or: npm run speculator
```

That is the whole product, and it is deliberate. The organiser's category for
this hackathon is *"Autonomous AI trading agents · Multi-agent trading
competitions"*, and a venue where one population of agents earns a record while
another population **prices** it — against a settlement number anyone can
re-derive from a contract — is that category taken literally. The web app is the
observatory over the two: it reads chain, holds no key, and takes no side.

---

# The agent runner

The autonomous half of Meta-Agent DEX. This is a daemon you run on your own
machine: it watches live DreamDEX BTC/ETH Event Contracts, decides, and places
real orders on Somnia Shannon through **your agent's `BotVault`** — while the
speculator agents on the layer above stake collateral on whether your vault's
NAV goes up.

One file, `runner.ts`.

```bash
node --experimental-strip-types bots/runner.ts
```

---

## The key this holds cannot take your money

The runner holds one private key, `AGENT_OPERATOR_KEY`, and on chain that key can
call exactly one function: `BotVault.trade(...)`.

```solidity
modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }

function deposit(uint256 amount)  external onlyOwner { … }
function withdraw(uint256 amount) external onlyOwner { … }
function setOperator(address o)   external onlyOwner { … }

function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity,
               uint64 expireTimestampNs, uint8 orderType) external onlyOperator { … }
```

`deposit`, `withdraw` and `setOperator` are `onlyOwner`, and the owner is a
different address — your wallet, which never goes near this process. So the worst
a leaked runner key can do is **trade badly**, which is the thing the meta-market
is a bet on in the first place. It cannot move a unit of collateral out of the
vault, and it cannot even reassign itself.

Two consequences the code follows to the letter:

- **The vault owns the positions, not the key.** `msg.sender` on the pool is the
  vault, so every ERC-6909 outcome token lands in the vault. Verified live in
  `scripts/spike/07-vault-trades.ts`: after a vault trade, the operator EOA holds
  zero.
- **NAV cannot be gamed by sending tokens.** `nav()` is `protocolCash`, which
  moves only by collateral deltas measured *inside* an allowlisted DreamDEX call.
  Shannon's test collateral has a permissionless faucet, so anyone can push 10,000
  tUSDC into the vault for the price of gas; that raises `balanceOf` and moves
  `nav()` by exactly zero. `unaccounted()` shows the gap to anyone who wants to
  check.

Nothing in `runner.ts` touches an ERC-20 or an ERC-6909 directly. It does not need
to, and it is written so that a reader can confirm that in one pass.

---

## Quickstart

Four steps. Node 22.6+ (`.nvmrc` pins the version this was built on).

### 1. Generate a throwaway key for the bot

```bash
node --input-type=module -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k = generatePrivateKey(); console.log('AGENT_OPERATOR_KEY=' + k); console.log('# operator address: ' + privateKeyToAccount(k).address);"
```

Keep it throwaway anyway. It is the key that lives on a laptop through a demo.

### 2. Fund it with gas — and nothing else

Send the operator address a little **STT** from the Somnia Shannon faucet. That is
all it ever spends: gas. It never needs tUSDC, because it never holds collateral —
the vault does, and the vault is funded by its owner.

The runner checks this at startup and warns if the address holds 0 STT, because a
funded strategy that cannot pay for gas looks identical to a broken one.

### 3. Register the agent

Registration is signature-gated: the owner wallet proves it holds the key, because
the `configHash` derived from your declaration goes into the meta-market's on-chain
`context` where it can never be corrected.

```bash
# sign a nonce with the OWNER key (not the operator key)
NONCE="Meta-Agent DEX — register agent $(date -u +%FT%TZ)"
SIG=$(OWNER_KEY=0xyour_owner_key NONCE="$NONCE" node --input-type=module -e \
  "import {privateKeyToAccount} from 'viem/accounts'; \
   console.log(await privateKeyToAccount(process.env.OWNER_KEY).signMessage({message: process.env.NONCE}))")

curl -s http://localhost:3009/api/agents -H 'content-type: application/json' -d @- <<JSON
{
  "name": "Momentum Mike",
  "ownerAddress": "0xyour_owner_wallet",
  "vaultAddress": "0xthe_botvault_deployed_for_you",
  "operatorAddress": "0xthe_operator_address_from_step_1",
  "strategy": "momentum",
  "strategyParams": { "lookbackSec": 90, "driftThreshold": 20000 },
  "blurb": "Buys the move on 15m BTC.",
  "nonce": "$NONCE",
  "signature": "$SIG"
}
JSON
```

The response carries the agent whole, including its `slug` (that is your
`AGENT_SLUG`) and its `configHash`. Check the hash against what you declared before
a session opens against it.

**Where the vault comes from.** Deploy your own from `contracts/BotVault.sol` —
`docs/BRING_YOUR_OWN_AGENT.md` has the constructor arguments and the Shannon
addresses. The runner does not care how the vault came to exist, only that your
key is its `operator`.

There is also `provisionAgent`, which deploys and funds a vault for you, but it
spends the keeper's STT and tUSDC and is therefore gated behind
`AGENT_CYCLE_TOKEN` — `POST /api/agents/provision` answers 401 without it. **It is
not available to visitors.** Registration by signature stays open to anyone;
spending the arena's money does not.

**And you must open your own sessions.** `openSession` is `onlyOwner`. The keeper
signs it for the demo fleet because it holds those owner keys; for your vault it
holds none and cannot. Call `openSession(endsAt)` yourself, then
`POST /api/agents/<slug>/session` with an owner signature so the arena deploys the
oracle and mints the meta-market. Skipping that second call leaves your agent
trading with nothing measuring it.

### 4. Run it

```bash
export AGENT_OPERATOR_KEY=0x…          # from step 1
export AGENT_VAULT=0x…                 # the BotVault
export AGENT_SLUG=momentum-mike        # from the registration response
export AGENT_API=http://localhost:3009
export AGENT_STRATEGY=momentum         # or mean-reversion

node --experimental-strip-types bots/runner.ts
```

Start with `AGENT_DRY_RUN=1` the first time. It does everything except send the
transaction, so you can watch a full poll — scan, signal, sizing — before an order
costs anything.

### Your session has to outlive a contract

This is the thing most likely to make a working bot look broken. `BotVault.trade`
reverts `MarketOutlivesSession` for any contract expiring after `sessionEnd`, so
the runner filters those out — and if the session is shorter than everything on the
board, every poll logs `scan tradable=0` and the agent never trades.

That is not hypothetical. The live Shannon board, measured while writing this:

```
ETH 1h    expires in 2633 s      ETH 24h   expires in 78233 s
BTC 1h    expires in 2633 s      BTC 24h   expires in 78233 s
BTC 4h    expires in 6233 s      ETH 1080h expires in 3620633 s
ETH 4h    expires in 6233 s      BTC 1080h expires in 3620633 s
```

No 15-minute series at all, and the soonest expiry 44 minutes out — so a
15-minute session, which is still what the cycle *route* falls back to when no
`duration` is passed, would have had **zero** candidates. That is why
`npm run cycle` sends `duration=5400`: a 90-minute session is the shortest one
that can hold anything Shannon is currently rolling. Check the board before you
open a session:

```bash
node --input-type=module -e "
import {SomniaMarkets, SOMNIA_TESTNET_ADDRESSES} from '@somnia-chain/markets-sdk';
import {somniaShannon} from '@somnia-chain/markets-sdk/chains';
const x = new SomniaMarkets({indexerUrl:'https://dev.smk.somnia.host/v1/graphql', chain:somniaShannon, wsRpcUrl:'wss://api.infra.testnet.somnia.network/ws', addresses:SOMNIA_TESTNET_ADDRESSES});
const now = Math.floor(Date.now()/1000);
for (const m of await x.client.listLiveBinaryMarkets({limit:20})) console.log(m.asset, m.interval, 'expires in', Number(m.expiry)-now, 's');
await x.close();"
```

Then open a session that ends *after* the contracts you intend to trade — with the
keeper, `POST /api/agents/cycle?open=1&duration=4200` for a session that can hold
the 1h series.

---

## Configuration

Required:

| Variable | What it is |
|---|---|
| `AGENT_OPERATOR_KEY` | The hot key. May only call `trade`. |
| `AGENT_VAULT` | The `BotVault` address. |
| `AGENT_SLUG` | The agent's slug — the app's endpoints are keyed by it. |

Everything else has a working default:

| Variable | Default | What it does |
|---|---|---|
| `AGENT_API` | `http://localhost:3009` | Where heartbeats and trades are reported. |
| `AGENT_STRATEGY` | `momentum` | `momentum` or `mean-reversion`. |
| `AGENT_POLL_MS` | `15000` | Poll interval, floor 3000. |
| `AGENT_ASSETS` | `BTC,ETH` | Which underlyings to look at. |
| `AGENT_MAX_ORDER` | `25000000` | Most collateral one order may escrow (25 tUSDC). |
| `AGENT_MIN_CASH` | `10000000` | Never spend the vault below this. |
| `AGENT_MAX_PER_MARKET` | `75000000` | Total this process will commit to one contract. |
| `AGENT_COOLDOWN_MS` | `90000` | Minimum gap between two orders on the same contract. |
| `AGENT_MIN_RUNWAY_SEC` | `120` | Skip a contract expiring sooner than this. |
| `AGENT_CROSS_TICKS` | `1` | How far through the spread an IOC reaches. Each tick past the touch costs 0.1 point and buys no depth the touch does not already offer. |
| `AGENT_MAX_ENTRY` | `650000` | Refuse to pay more than 0.65 per contract, either leg. Above that the payoff no longer covers being wrong. |
| `AGENT_DRIFT_THRESHOLD` | `45000` | momentum: the move that counts as a trend (0.045). Set above the ~3.1 points it costs to enter — every order is IOC, so the agent always pays the spread. |
| `AGENT_LOOKBACK_SEC` | `90` | momentum: over what window. |
| `AGENT_REVERSION_BAND` | `220000` | mean-reversion: how far from 0.50 counts as extreme. |
| `AGENT_MIN_REVERT_SEC` | `240` | mean-reversion: refuse to fade this close to expiry. |
| `AGENT_DRY_RUN` | off | Decide and log, send nothing. |
| `SOMNIA_RPC_URL` | `https://dream-rpc.somnia.network` | HTTP RPC for the vault. |
| `SOMNIA_WS_RPC_URL` | `wss://api.infra.testnet.somnia.network/ws` | The SDK's chain transport — it has no HTTP fallback. |
| `SOMNIA_INDEXER_URL` | `https://dev.smk.somnia.host/v1/graphql` | Market discovery. |

**Every money knob is a raw 6-decimal integer**, the same integer the chain uses.
`25000000` is 25 tUSDC. This is not an inconvenience worth fixing: the whole stack
carries money as integers precisely so no float ever gets near a settlement number,
and the env is the edge where that discipline is easiest to lose.

---

## The two strategies

Both are small enough to read in a minute, and both can be wrong — that is the
point. Neither is a random number generator dressed as a strategy.

**`momentum` — trade with the move.** Each poll samples the pool's implied
probability (the mid of a two-sided book; the last fill if only one side rests;
*nothing* if the contract has never quoted — a market with no quote is not 50/50,
it is unknown). If it has moved by more than `AGENT_DRIFT_THRESHOLD` over
`AGENT_LOOKBACK_SEC`, buy the side it moved toward. The claim is that a repricing
that large that fast is information arriving rather than noise, and that it
continues. It loses whenever the move *was* the noise.

**`mean-reversion` — fade the extreme.** If the book sits more than
`AGENT_REVERSION_BAND` away from 0.50, buy the cheap side. The claim is that a
short-dated book pushed far from even is overreacting.

The time gate is what makes it a strategy rather than a losing habit: within
`AGENT_MIN_REVERT_SEC` of expiry it refuses to fire at all. Four minutes from
expiry, 0.95 is not an overreaction — it is a market that has already decided —
and fading it is buying a near-certain loser at a discount that is not a discount.

Both then go through the same order construction, which is where most of the
actual work is: cross the spread by `AGENT_CROSS_TICKS`, size against the resting
depth *and* the budget, snap the price onto `tickSize` and the quantity onto
`lotSize`, refuse anything below `minQuantity`, and refuse any entry above
`AGENT_MAX_ENTRY`.

---

## What a poll does

1. Read `nav()`, `unaccounted()`, `sessionOpen()`, `sessionEnd()` from the vault.
2. Heartbeat to the app.
3. If no session is open, or it is closing, or NAV is at the cash floor — idle.
4. `listLiveBinaryMarkets` from the indexer, then filter to contracts that are
   the right asset, still trading, collateralised in **the vault's own token**,
   and **expiring before `sessionEnd`**.
5. Read each candidate's book and grid, sample its price, run the strategy.
6. Take the single strongest signal, size it, send it, wait for the receipt.
7. Decode the vault's own `Traded` event for what it actually cost, and report
   that to the app.

One order per poll, deliberately: the strongest signal beats the first one found,
and a single order per poll keeps the operator key's nonce strictly serial.

### Reading the log

Every action is one logfmt line — timestamp, level, event, then fields. This is a
real boot against Shannon (the vault's session had already been closed, so it
idles):

```
2026-09-07T02:04:52.832Z info  boot      agent=spike-bot strategy=momentum vault=0x8b25998d… operator=0x71a89a7e… api=http://localhost:3009 chain=50312 poll_ms=20000 assets=BTC+ETH dry_run=true
2026-09-07T02:04:53.343Z warn  preflight note="the operator key is ALSO the vault owner, so it can deposit and withdraw. Use a separate throwaway key."
2026-09-07T02:04:53.344Z info  preflight operator_ok=true collateral=0x70a86D88… gas_stt=49.404291734
2026-09-07T02:04:53.793Z warn  api       path=/heartbeat note="fetch failed"
2026-09-07T02:04:53.793Z info  idle      reason="no open vault session" nav=197.91
2026-09-07T02:05:52.563Z info  shutdown  signal=SIGTERM note="finishing this poll — ctrl-c again to force"
2026-09-07T02:05:52.563Z info  stopped   uptime_s=59 orders_sent=0 orders_filled=0 cash_deployed=0
```

A trading poll adds these, in this order:

| Event | Means |
|---|---|
| `scan` | How many contracts are live, how many are tradable for this vault, NAV, budget, seconds left in the session. |
| `signal` | The strategy fired: which contract, at what implied probability, the rule in words, the side, the limit price, the size, the escrow. |
| `sent` | Transaction submitted, with its hash. |
| `filled` / `nofill` | The vault's own `cashDelta` — an IOC can take one level, all of them, or none. `nofill` is a `warn`, not a failure. |
| `skip` / `hold` | Nothing was fillable inside the limit, or no contract met the rule this poll. |
| `trade` (error) | The order was rejected. The field `reason` carries the decoded Solidity error. |

Note that `warn api path=/heartbeat` line: the app was not running, and the bot
kept going. That is deliberate — a runner that stopped trading because a web
server was down would be reporting an outage by inventing a different one. The
vault, not the database, is what the meta-market settles against.

`SIGINT` (ctrl-c) finishes the poll in flight and prints a summary. A second
ctrl-c exits immediately; nothing here holds funds, so the only thing lost is a
log line.

---

## What it deliberately will not do

| It never | Because |
|---|---|
| Rests a limit order | `BotVault` has `trade` and no `cancelOrder`. A resting order could not be pulled back by anyone — not the operator, not the owner — until the market expires. Every order is **IOC**. |
| Sells | A sell escrows outcome tokens, which the pool pulls off the ERC-6909 singleton as an approved operator. The vault grants that role to the *module* (so `redeem` works), never to a pool, so a sell reverts `InsufficientPermission()`. To flatten, it buys the other leg — one YES plus one NO is a complete set and redeems at par. |
| Trades a contract outliving the session | `trade` reverts `MarketOutlivesSession`. The runner fails that fast, client-side, with the reason in the log; the on-chain rule is what keeps every position terminal by the time the oracle freezes NAV. |
| Trades a contract in another collateral | The vault approves its own collateral token to the pool. A market backed by something else could not be paid for. |
| Spend the vault to zero | `AGENT_MIN_CASH` is a floor. A NAV of zero has nothing left to trade with, and the meta-market still has to settle on it. |
| Hold, move, or approve collateral | It has no code that could. |

---

## What it reports to the app

Both calls are best-effort and neither gates an order.

**`POST /api/agents/{slug}/heartbeat`** — every poll. The route stamps its *own*
clock and ignores the body, deliberately: a heartbeat's whole value is that it
decays, and one stamp from a runner with a wrong clock would pin an agent as alive
until 2100. The runner sends a body anyway —

```json
{ "at": 1788746606000, "nav": "197910000", "unaccounted": "10000000000",
  "blockNumber": "12345678", "sessionOpen": true }
```

— because it is already at chain head every poll, and a mid-session NAV sample is
the one thing the agent's curve is otherwise missing between open and settle. A
route that wants it needs one `recordNavPoint` call.

The response is read back: if it names an `operatorAddress` that is not this
runner's, the runner warns once. That catches the misconfiguration the preflight
cannot — a daemon heartbeating one agent's row while trading a different agent's
vault.

**`POST /api/agents/{slug}/trades`** — after every order that reaches the chain,
filled or not.

```json
{ "marketId": "0x…", "symbol": "BTC-15m@14:00", "kind": 0, "price": 620000,
  "quantity": "12000000", "cashDelta": "-7404000",
  "txHash": "0x…", "at": 1788746612000 }
```

The fields are `recordTrade`'s input minus `sessionId` and `agentId`, which the
route resolves from the slug's open session. `kind` is the pool's `OrderKind`
(0 BUY_YES, 2 BUY_NO — the runner sends no others), `price` is in 6dp probability
units, `quantity` is raw outcome-token units, and `cashDelta` is the **vault's own
measurement** of what the order cost, decoded from its `Traded` event rather than
inferred from the order. `recordTrade` deduplicates on
`(txHash, marketId, kind, price, quantity)`, so a retry cannot double the tape.

> This endpoint is the one piece of the contract that must exist on the app side
> for the trade tape to appear in the UI. If it 404s, the runner logs one `warn`
> per order and keeps trading.

---

## Troubleshooting

| Log line | What happened | Fix |
|---|---|---|
| `fatal reason="AGENT_OPERATOR_KEY is not set…"` | No config. | See the quickstart. |
| `fatal reason="…the vault's operator is 0x…"` | The key is not the vault's operator; every trade would revert `NotOperator()`. Checked at startup so it fails in one second rather than one order. | Run the right key, or have the owner call `setOperator`. |
| `warn preflight …operator key is ALSO the vault owner` | Works, but the hot key can `withdraw`. The whole security claim is gone. | Use a separate key. |
| `warn preflight …holds 0 STT` | No gas. | Fund the operator address. |
| `error trade reason=PriceNotAlignedToTickSize` / `QuantityNotAlignedToLotSize` | An order missed the pool's grid — should not happen; the runner aligns both. | File it: the grid read and the alignment disagree. |
| `error trade reason=MarketOutlivesSession` | A contract expiring after `sessionEnd` got through the filter. | Same — the client-side gate should have caught it. |
| `error trade reason=InsufficientPermission` | A sell reached the pool. The runner cannot generate one. | Same. |
| `warn nofill` | The IOC crossed nothing. Normal on a thin book. | Raise `AGENT_CROSS_TICKS`, or accept it. |
| `info idle reason="no open vault session"` | Nobody has opened a session on this vault. | Open one (`POST /api/agents/cycle?open=1`, or the keeper). |
| `info hold reason="no signal"` | The strategy did not fire. Also normal. | Loosen `AGENT_DRIFT_THRESHOLD` / `AGENT_REVERSION_BAND` if you want more trades — and expect worse ones. |

---

## Verifying it without spending anything

`AGENT_DRY_RUN=1` runs every read, every strategy decision and every sizing
calculation, and sends no transaction.

Importing the file does not start the daemon, so the order arithmetic — the part
that has to be right *before* an order costs money — can be exercised on its own:

```ts
import {
  sizeOrder, momentum, meanReversion, impliedProbability, tradableForSession,
} from "./runner.ts";
```

`sizeOrder(kind, book, grid, one, budget, cfg)` is pure: a real order book in, an
order the pool will accept (or `null`) out. Checked against live Shannon books —
tick alignment, lot alignment, the minimum, the budget bound, the entry cap, that
the limit crosses, that it never sizes past the depth it can take, and that its
cost matches the pool's own ceil-rounded escrow formula.

`tradableForSession(market, gate)` is the candidate filter, and it is worth
checking on its own before a demo: run it over `listLiveBinaryMarkets` with your
intended `sessionEndSec` and count what survives. Zero survivors an hour before
the demo is a fixable problem; zero survivors during it is not.

---
---

# The speculator agent

`runner.ts` is layer 1: an agent being **measured**. `speculator.ts` is layer 2:
an agent doing the **measuring**. It reads the arena's open meta-markets — the
native DreamDEX Event Contracts that ask *"will this agent close its session with
a higher NAV than it opened?"* — forms a view from evidence that is actually
available about that agent, prices it against the market's own book, and places
a real order through the SDK trader. After settlement it redeems, because a
winning outcome token is worthless until it is.

```bash
npm run speculator
# or: node --experimental-strip-types bots/speculator.ts
```

## Why this agent exists: an empty book is not a price

Right now every meta-market on the board reads `book=unquoted`. Nobody has
quoted one, so there is no price on any agent's session — which makes the second
layer a scoreboard rather than a market.

One speculator cannot fix that by itself, and the honest reason is worth being
precise about: a lone agent posting quotes is marking its own price. **Two
speculators with opposing theses cross each other's orders, and that is what
puts a real price on a meta-market.** Run a `backer` and a `skeptic` against the
same board and they will meet: the backer bids YES up to its view minus its
edge, the skeptic bids NO up to its own, and where those two limits overlap
there is a fill and a printed price. Then start a `contrarian`, which does
nothing at all until a book exists and from that moment trades only against it.

```bash
AGENT_THESIS=backer     AGENT_SPECULATOR_KEY=0x… npm run speculator &
AGENT_THESIS=skeptic    AGENT_SPECULATOR_KEY=0x… npm run speculator &
AGENT_THESIS=contrarian AGENT_SPECULATOR_KEY=0x… npm run speculator &
```

Three separate keys. Two processes on one key would collide on the nonce.

### This is the one place an order is allowed to rest

The runner is IOC-only, and the reason is in its own header: `BotVault` exposes
`trade` and no `cancelOrder`, so an order that rested could not be pulled back by
anyone — not the operator, not the owner — until the market expired.

None of that is true here. A speculator signs for itself and can cancel, and it
**must** be able to rest, because an order that only ever crosses can never be
the first quote on an empty book. So every order is a **LIMIT** (`orderType 0`):
it fills whatever it crosses right now and rests the remainder, and the
remainder is precisely the quote the opposing thesis comes and takes. Nothing is
stranded — the order's `expireTimestampNs` is the meta-market's own expiry, so an
unfilled quote clears itself when the session closes.

---

## Signing and safety

**A speculator holds its own funded EOA.** It has no vault, because it is not
being measured. The key comes from `AGENT_SPECULATOR_KEY` and from nowhere else
— never from `.env.local` or anything the web app reads, because the app is a
read-only observatory and a key it can see is a key its process can spend.

Use a throwaway:

```bash
node --input-type=module -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k = generatePrivateKey(); console.log('AGENT_SPECULATOR_KEY=' + k); console.log('# address: ' + privateKeyToAccount(k).address);"
```

Send that address some **STT** for gas. It checks at startup and warns on zero,
because a funded thesis that cannot pay for gas looks identical to a broken one.

**It mints its own tUSDC, and says so at `warn`.** The collateral,
`0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, has a permissionless, cooldown-free
`faucet(uint256)` that hands out 10,000 per call. When the balance falls below
`AGENT_MIN_BALANCE` this process calls it, and logs:

```
warn  faucet    minted=10000 balance=10000 note="self-minted stake — permissionless faucet, and never counted by BotVault.nav()" tx=0x…
```

That line is loud on purpose. Minting your own stake is exactly the thing this
project had to prove a NAV oracle must not count: `BotVault.nav()` is
`protocolCash`, which moves only by collateral deltas measured *inside* an
allowlisted DreamDEX call, and a 10,000 tUSDC faucet top-up into a vault moved
its NAV by **exactly zero**. A speculator's balance is not NAV, is not scored,
and settles nothing — so the faucet is legitimate here, and it is still logged
every single time rather than folded into a startup message.

---

## What a poll does

1. `GET /api/agents/sessions?limit=50`. This is the only place meta-markets come
   from: the endpoint is what maps a DreamDEX market id to a vault session, and
   it carries `navT0` (the figure the oracle compares against, frozen at open and
   not readable from the pool) plus a live vault read `{ cash, unaccounted,
   touchedCount }`.
2. **Redeem first.** Settled positions are collateral this process already owns
   and has not collected, and collecting can be the difference between affording
   the next order and calling a faucet it did not need.
3. Top up from the faucet if short, and say so.
4. For each open meta-market: read the market **from chain** (`getMarketOnchain`
   — status is authoritative there, see below), its book and its grid, form a
   view, run the thesis, size the order, place it.
5. One order per poll, the strongest signal first — the same rule the runner
   follows, and for the same reason: it keeps the key's nonce strictly serial.

The runner survives a dead app by design, because the chain is what its
meta-market settles against and it can keep trading regardless. **That reasoning
does not transfer here.** This process learns which market belongs to which
session from that endpoint and nowhere else, so an unreachable app is a poll with
nothing to have an opinion about. It idles and names the reason.

### Market status comes from chain, not the index

`BinaryMarket.status` is derived from lifecycle *events*, and the
Listed→Trading→Settling transitions emit none — so a freshly minted meta-market
can sit at `Listed` in the indexer while its pool is already taking orders.
`getMarketOnchain(marketId)` reads the market contract itself, and that is what
the Trading gate below is checked against. The indexer is still read, for
`lastPrice` only, and a `null` from it means *not indexed yet*, never *not
trading*.

---

## Forming a view

Four pieces of evidence, all of them on the card, blended into one probability
that the session's NAV rises.

**The agent's record over finished sessions**, as `(wins + 1) / (n + 2)` — the
rule of succession. Zero finished sessions gives exactly 0.500, which is
genuinely no information, and every thesis below is written so that 0.500 fires
nothing. One win gives 0.667 rather than 1.000: a single session is not a record.
Voided sessions are skipped entirely, because the committee declined to answer
and both sides were refunded, so counting one as a win or a loss would put a
result on the board that nobody was paid for.

**Cash now against cash at open** — and this is the part that needs care.
`vault.cash` is `BotVault.nav()`, which is `protocolCash`: collateral sitting in
the vault *right now*. An agent that has spent 90 tUSDC on outcome tokens reads
90 lower while still holding every one of those positions, and nothing converts
back until `redeemAll()` runs at close. So:

- **Early in a session, cash-versus-open is mostly a measure of deployment**, and
  a position taken then is a bet on the strategy — which is what the agent's
  finished-session record is evidence about.
- **Late in a session, positions are expiring and redeeming back into cash**, and
  cash-versus-open converges on the answer the oracle is about to freeze.

That is the whole blend. The weight cash carries is `phase²` — a quarter of the
view at the halfway mark, four fifths at 90% — squared rather than linear because
the first half of a session is when deployment is heaviest and the cash reading
is least honest. The log line says which one carried it, and quotes the weight
rather than asserting a vaguer "mostly":

```
why="record 0/1, 0.656 through, 2 markets touched — cash is still deployment, so this prices the strategy (cash weight 0.431)"
why="cash +6.0% vs open, 0.900 through, 5 markets touched — positions are closing, so cash carries 0.810 of this view"
```

**How many markets it has traded this session** (`touchedCount`) — the sharpest
piece of evidence on the board, and the one that overrides the blend, because it
is not a probability but a consequence. A session that has touched **no** markets
cannot have moved NAV: `nav()` counts only collateral a DreamDEX call delivered,
and `finalize()` writes `navT1 > navT0 ? YES : NO`, strictly greater. An agent
that never traded settles NO. Early in a session that is a runner which has not
woken up yet; late in one it is the result, so the view decays from 0.500 at open
toward the floor at close.

**How much of the session remains**, which is the `phase` every weight above is
built on. It is computed against the **server's** clock, shipped in the response
body — the route sends it precisely because every card on that page is a
countdown, and a process whose clock ran a few minutes fast would otherwise
compute a phase past 1.0 and refuse markets that are still taking positions.

---

## The three theses

Each states a claim, each can be wrong, and each names the clause that failed
when it refuses. None of them consults a random number.

**`backer` — buys YES on agents whose cash is holding up and whose finished
sessions won.** The claim is that a strategy that has been profitable keeps being
profitable over one more session, and that an agent whose cash has not fallen
apart mid-session is on track. It is wrong exactly when a winning record was
luck, or when the last hour gives it all back.

> The drawdown band is not a fixed number, and that matters. A mid-session cash
> reading is depressed by open positions, so requiring cash to be flat would
> refuse every agent that is actually working. The gate carries the same weight
> cash carries in the view: early it is effectively no gate at all, and it closes
> onto `AGENT_DRAWDOWN_BAND` as the session ends and positions redeem back.

**`skeptic` — buys NO on agents that are down on the session or have a losing
record.** Not merely the negation of `backer`: it fires on **either** clause, so
it will take the other side of an agent with a good record that is currently
bleeding — the position a backer refuses to hold. It is wrong when a drawdown was
deployment rather than loss. It also fires on an untraded vault, which is the
same fact the view above encodes.

**`contrarian` — fades the book, against the agent's own record.** Its reference
is the record alone, deliberately: it is not forming an independent view of this
session, it is asking whether the price the other speculators have put on this
agent is consistent with what that agent has actually *done*. Book under the
record → YES is cheap → buy YES. Book over it → NO is cheap → buy NO. Book
already agrees → refuse.

It is the only one of the three that **requires** a book, and therefore the only
one that cannot open an empty market. By construction it is the second agent into
any meta-market, and it is what stops a lone backer or skeptic from marking its
own price unopposed.

### The price each one will pay

Every order carries a YES price, both legs — that is what the pool takes. For a
YES buy it is a ceiling on what you pay. For a NO buy it is a **floor**, because
a NO costs `1 − yesPrice`: the higher the YES price you accept, the cheaper the
NO you are buying. The limits fall out of that:

| Thesis | Side | YES-price limit |
|---|---|---|
| `backer` | BUY_YES | `fair − AGENT_EDGE` |
| `skeptic` | BUY_NO | `fair + AGENT_EDGE` |
| `contrarian` | BUY_YES | `record − AGENT_EDGE` |
| `contrarian` | BUY_NO | `record + AGENT_EDGE` |

`AGENT_EDGE` is the margin the thesis demands for being wrong, not a rounding
allowance. The price is then snapped onto `tickSize` — **down** for a YES buy and
**up** for a NO buy, both toward safety — and clamped strictly inside `(0, 1)`.

---

## When it refuses, and why that is the feature

A speculator that always finds a trade is a random number generator with extra
steps. Every refusal is one `warn refuse` line naming the clause:

| Refusal | Why |
|---|---|
| `the market is Listed/Locked/Settling/Resolved/Voided, not Trading` | Read from chain, not the index. A pool outside its trading window rejects the order; failing here costs a read instead of a transaction. |
| `the session closes in Ns, under the …s that makes a position worth taking` | The meta-market expires with the vault session. Minutes from close there is not enough left for a view to be worth the gas. |
| `the book is crossed — best bid is at or above best ask` | That is not a price, it is a bug or a race. Never quote against one. |
| `the book has never quoted — a contrarian has nothing to fade` | Only `contrarian`. `backer` and `skeptic` have a view without a book, which is how the first quote gets posted at all. |
| `the pool's minimum lot costs X, above AGENT_MAX_STAKE` | The smallest order this pool will accept is bigger than the cap. There is no order to place, and saying so beats sizing one and watching it revert `QuantityBelowMinimum`. |
| `nothing to stake — balance X, Y already committed of the Z per-market cap` | Out of collateral, or this one market has already absorbed its share. |
| `traded Ns inside the …s cooldown` | The clock starts at the **attempt**, not the receipt: an order that reverted is exactly the one not to retry three times a minute. |
| `record is losing (0.285) — a backer has nothing to back` | Thesis-specific. Each one names its own failing clause. |
| `view 0.495 is not above 0.5 by 0.030` | The evidence does not clear `AGENT_EDGE`. A fresh agent with no finished sessions sits here permanently, and correctly. |
| `0.950 per contract is above AGENT_MAX_ENTRY 0.650` | Refuses to pay near-par for a near-certainty. |

---

## Redemption

A winning outcome token is an ERC-6909 claim on the settlement singleton, not
collateral. Until it is redeemed it is worth nothing, so every poll sweeps up to
`AGENT_REDEEM_BATCH` settled meta-markets before it stakes anything new.

Settlement itself is **defined** by `BotNavOracle` — `finalize()` writes
`navT1 > navT0 ? OUTCOME_YES : OUTCOME_NO` — and **attested** by DreamDEX's
oracle committee, which reads `BotNavOracle.outcomeValue()` through six JSON
sources and one contract source. Three meta-markets have settled 3/3 with zero
voids on that wiring. This agent takes a side and collects; it does not resolve
anything.

Two encodings meet here and they are **not the same number**:

- `outcomeValue` — what the oracle answered about the agent. `1` = NAV rose,
  `2` = it did not. That is what the arena's session rows store.
- `winningOutcome` — the DreamDEX outcome **index**, which is what the order book
  paid out on and what `redeem` takes. Index `0` is the Up/YES leg.

Our questions register the intervals `[(1,1), (2,2)]` with YES first, so answer
`1` lands in interval index `0`, the Up leg — an agent holding Up wins exactly
when the agent it priced profits. Reversing those two is how a winning agent gets
paid as a loser, so the translation lives in one place and is never re-derived.

A **voided** market pays both legs at par on complete sets, so both are worth
pulling; a resolved one pays exactly one, and the losing leg is never read
(burning it would spend gas for nothing). What came back is measured as an ERC-20
balance delta around the call rather than inferred from the position size — the
same discipline the runner applies when it decodes the vault's own `Traded`
event. Par is 1.0 per winning contract, so a recovery under the burn is the
settlement singleton's fee skim, not a short payout.

```
info  redeemed  market=alpha-z#2 leg=YES voided=false burned=30.0 recovered=29.85 tx=0x…
```

---

## Configuration

Required — one variable:

| Variable | What it is |
|---|---|
| `AGENT_SPECULATOR_KEY` | The speculator's own key. It signs its own orders and holds its own collateral. Never read from a file the app reads. |

Everything else has a working default:

| Variable | Default | What it does |
|---|---|---|
| `AGENT_THESIS` | `backer` | `backer`, `skeptic` or `contrarian`. |
| `AGENT_API` | `http://localhost:3009` | Where the open meta-markets come from. |
| `AGENT_POLL_MS` | `20000` | Poll interval, floor 3000. |
| `AGENT_MAX_STAKE` | `20000000` | Most collateral **one** order may escrow (20 tUSDC). |
| `AGENT_MAX_PER_MARKET` | `60000000` | Total this process will commit to one meta-market. |
| `AGENT_MIN_BALANCE` | `50000000` | Call the faucet below this. |
| `AGENT_FAUCET_AMOUNT` | `10000000000` | How much to mint per faucet call (10,000 tUSDC). |
| `AGENT_COOLDOWN_MS` | `120000` | Minimum gap between two orders on the same meta-market. |
| `AGENT_MIN_RUNWAY_SEC` | `120` | Refuse a session closing sooner than this. |
| `AGENT_EDGE` | `30000` | Margin demanded over the book, 0.03. |
| `AGENT_MAX_ENTRY` | `650000` | Refuse to pay more than 0.65 per contract, either leg. Above that the payoff no longer covers being wrong. |
| `AGENT_DRAWDOWN_BAND` | `50000` | End-of-session drawdown tolerated as "holding up", 5%. Widened earlier in the session. |
| `AGENT_CASH_SENSITIVITY` | `5` | How hard a relative cash move tilts the probability. |
| `AGENT_REDEEM_BATCH` | `4` | Most settled markets swept per poll. |
| `AGENT_COLLATERAL` | the SDK's testnet collateral | The tUSDC the meta-markets are backed by. |
| `AGENT_DRY_RUN` | off | Decide, price and size; send nothing. |
| `AGENT_WIND_DOWN` | off | Refuse every entry, keep redeeming. The way to retire this layer: killing the process instead strands the collateral behind any leg that has not settled yet. |
| `SOMNIA_RPC_URL` | `https://dream-rpc.somnia.network` | HTTP RPC for allowances and receipts. |
| `SOMNIA_WS_RPC_URL` | `wss://api.infra.testnet.somnia.network/ws` | The SDK's chain transport — it has no HTTP fallback. |
| `SOMNIA_INDEXER_URL` | `https://dev.smk.somnia.host/v1/graphql` | Market discovery and `lastPrice`. |

**Every money knob is a raw 6-decimal integer**, exactly as in `runner.ts` and
for the same reason: `20000000` is 20 tUSDC, `900000` is a price of 0.90, and the
env is the edge where the no-floats-near-settlement discipline is easiest to
lose.

---

## Reading the log

Same logfmt shape as the runner, so one terminal can tail both layers and the
columns still line up. This is a real dry run against the live Shannon board:

```
2026-09-07T05:19:14.373Z info  boot      thesis=contrarian speculator=0xF90235fb… api=http://localhost:3009 chain=50312 collateral=0x70a86d88… poll_ms=5000 max_stake=20 edge=0.030 dry_run=true
2026-09-07T05:19:15.284Z warn  preflight note="the speculator address holds 0 STT — every order and every redemption will fail to pay for gas."
2026-09-07T05:19:15.284Z info  preflight gas_stt=0 balance=0 faucet_below=50
2026-09-07T05:19:20.529Z info  dry-run   balance=0 note="AGENT_DRY_RUN is set — would faucet 10000 before staking"
2026-09-07T05:19:20.529Z info  scan      thesis=contrarian open=3 blind=0 balance=0 agents_with_record=3
2026-09-07T05:19:24.821Z info  view      market=alpha-z#2 fair=0.211 book=unquoted record=0.333 cash=100.000026 open=250 touched=2 closes_in_s=1854 why="record 0/1, 0.656 through, 2 markets touched — cash is still deployment, so this prices the strategy (cash weight 0.431)"
2026-09-07T05:19:24.821Z warn  refuse    market=alpha-z#2 thesis=contrarian reason="the book has never quoted — a contrarian has nothing to fade"
2026-09-07T05:19:30.752Z info  hold      reason="no meta-market cleared the thesis" thesis=contrarian watched=3
2026-09-07T05:19:58.323Z info  stopped   uptime_s=49 thesis=contrarian orders_sent=0 orders_filled=0 staked=0 recovered=0 faucet_calls=0
```

| Event | Means |
|---|---|
| `scan` | How many meta-markets are open, how many came back `blind`, the balance, how many agents have a finished-session record. |
| `view` | The evidence and the number it produced, per market — including what the book says, or `unquoted`. Printed before the thesis runs, so a refusal can be checked against the view that caused it. |
| `refuse` | A named clause failed. `warn`, because a refusal is a decision, not noise. |
| `intent` | The thesis fired: side, YES price, what that costs per contract, size, stake, and the rule in words. |
| `filled` / `resting` | What crossed now and what is sitting on the book waiting for the opposing thesis. `resting` is not a failure — on an empty book it is the entire point. |
| `redeemed` | A settled position collected: which leg, how much burned, how much collateral actually came back. |
| `faucet` | `warn`. Self-minted stake. |
| `order` (error) | The pool rejected it. `reason` carries the Solidity error name, decoded by the SDK. |
| `hold` / `idle` | Nothing cleared the thesis this poll, or there was nothing to look at. |

`blind=N` on a `scan` line means N open sessions arrived without a usable live
vault read — `liveVaultBySession` is deadlined and failure-tolerant, so a slow
RPC gives the route a `vault: null` on a session that is genuinely open. There is
no evidence to price, so the card is dropped, but it is **counted**: "three
sessions I could not read" and "no sessions" are different states and only one of
them is a quiet arena.

`SIGINT` (ctrl-c) finishes the poll in flight and prints a summary. A second
ctrl-c exits immediately — a submitted order is already the chain's problem, and
an unredeemed position stays redeemable forever, so the only thing lost is a log
line.

---

## Troubleshooting

| Log line | What happened | Fix |
|---|---|---|
| `fatal reason="AGENT_SPECULATOR_KEY is not set…"` | No key. | Generate one; see above. |
| `warn preflight …holds 0 STT` | No gas. Orders and redemptions will both fail. | Fund the speculator address. |
| `info idle reason="the arena API did not answer…"` | The app is down, and unlike the runner this agent cannot work without it. | Start the app, or point `AGENT_API` at the right origin. |
| `info idle reason="every open session came back without a live vault read…"` | Sessions are open but their vault reads timed out. | Check the RPC; it clears on its own when the reads land. |
| `warn refuse …the book has never quoted` on every market, `AGENT_THESIS=contrarian` | Working as designed — nothing to fade yet. | Run a `backer` and a `skeptic` first; the contrarian trades once they have printed a price. |
| `warn refuse …view 0.4xx is not above 0.5 by …` on every market | Every agent has zero finished sessions, so the record carries no information. | Let a session finish, or lower `AGENT_EDGE` and expect worse positions. |
| `error order reason=PriceNotAlignedToTickSize` / `QuantityNotAlignedToLotSize` | An order missed the pool's grid — should not happen; both are aligned. | File it: the grid read and the alignment disagree. |
| `error order reason=OrderExpiryBeyondMarket` | The order outlived its meta-market. | Same — the expiry is read from the market contract itself. |
| `info resting` and never `filled` | Nobody is on the other side. | Start the opposing thesis. That is the whole design. |

---

## Verifying it without spending anything

`AGENT_DRY_RUN=1` runs every read, every view, every thesis and every sizing
calculation, and sends no transaction — including the faucet, which it announces
instead so a zero balance does not read as a broken agent.

Importing the file does not start the daemon, so the arithmetic that has to be
right *before* an order costs money can be exercised on its own:

```ts
import {
  formView, recordProbability, drawdownGate, decide,
  backer, skeptic, contrarian, sizeOrder, bookPrice, bookIsCrossed, records,
} from "./speculator.ts";
```

Each stage is pure: evidence in → a view out; a view in → an intent out; an
intent and a grid in → an order the pool will accept, or a refusal with a reason.
No key, no balance, no open session required.
