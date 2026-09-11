# Bring your own agent

Run your own trading agent in the Meta-Agent DEX arena, on Somnia Shannon
testnet, against real DreamDEX Event Contracts.

Nothing here asks you for a private key. The arena never holds one of yours, and
the two transactions that move your money — deploying your vault and funding it —
are sent by you, from your own wallet. What the arena does is the part that costs
*it* money: deploying your session's NAV oracle and minting the meta-market that
other people price your agent on.

**Everything below was run end to end against the live deployment.** Where a step
can fail, the failure is written down with it.

**Prefer running code to `curl`?** [`examples/agent/`](../examples/agent/) is this
whole guide as five scripts — `npm run keys`, `deploy`, `register`, `session`,
`start` — plus an agent you can read in one sitting and edit: ~440 lines of
deterministic trading in `agent.ts`, and the model gate beside it in `brain.ts`.

---

## What you are signing up for

Your agent trades out of a `BotVault` you deploy and own. You appoint an
**operator** key — the one your bot runs with. That key may call exactly one
function, `trade`, and it forwards straight to a DreamDEX pool. It cannot
withdraw, cannot deposit, cannot change the operator, and cannot open a
session. If your laptop is stolen mid-demo, the thief gets the ability to trade
your vault badly, and nothing else.

A **session** is a fixed window your agent trades inside. At the start the vault's
NAV is frozen as `navT0`; at the end, `navT1`. A second-layer market asks whether
`navT1 > navT0`, and other people take positions on the answer. That is what makes
this an arena rather than a bot host: your declared strategy is written into the
market's on-chain `context` and cannot be edited afterwards.

**Your NAV is `protocolCash`, not your token balance.** Collateral that arrives at
the vault any way other than through an allowlisted DreamDEX call lands in
`unaccounted()` and can never count. That is deliberate — Shannon's test
collateral has a public faucet, so a balance-based NAV would be forgeable by a
stranger for the price of gas.

---

## Before you start

| | |
|---|---|
| Node | 22.6 or newer (`node --version`). `.nvmrc` pins what this was built on. |
| Arena API | `https://meta-agent.mdloglabs.org` — every `curl` below uses it |
| Chain | Somnia Shannon testnet, chain id **50312** |
| RPC | `https://dream-rpc.somnia.network` |
| Explorer | `https://shannon-explorer.somnia.network` |
| STT | Native gas. From the Somnia testnet faucet — there is no contract to call. |
| tUSDC | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, 6 decimals, public `faucet(uint256)` capped at 10,000 per call, no cooldown |

You need **two wallets**:

- **owner** — deploys and funds the vault, opens sessions. Needs STT and tUSDC.
- **operator** — your bot. Needs STT only, and only ever a little.

Keep them separate. Using one wallet for both works and gives up the entire
security argument, which is the thing worth demonstrating.

---

## 1. Make the operator key

```bash
node --input-type=module -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k = generatePrivateKey(); console.log('AGENT_OPERATOR_KEY=' + k); console.log('# operator address: ' + privateKeyToAccount(k).address);"
```

Send that address a little STT. Measured cost: **0.0057 STT per trade**, so 0.6 STT
is about a hundred orders. It never needs tUSDC.

---

## 2. Deploy your vault

```bash
solc --combined-json abi,bin --optimize --via-ir \
     contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json
```

`--via-ir` is required, not cosmetic: `redeemAll` destructures a 14-field return
and the legacy pipeline fails it with "stack too deep".

The constructor takes five addresses, in this order:

```
constructor(collateral_, module_, outcomeToken_, owner_, operator_)
```

| Argument | Value on Shannon |
|---|---|
| `collateral_` | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| `module_` | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| `outcomeToken_` | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| `owner_` | your owner address |
| `operator_` | the operator address from step 1 |

**`owner` is `immutable`.** It is compiled into the runtime bytecode and there is
no setter, on purpose: two vaults that differ only in those twenty bytes are proof
on chain that the deployer of one holds no power over the other. Get it right —
a wrong owner means redeploying.

The constructor also calls `outcomeToken.setOperator(module_, true)`. Without it
the module cannot pull winning legs and `redeemAll` reverts, so do not deploy a
modified constructor that skips it.

---

## 3. Fund the vault

`deposit` is `onlyOwner` and pulls with `transferFrom`, so approve first:

```
tUSDC.approve(yourVault, amount)
yourVault.deposit(amount)
```

The demo fleet runs at **200 tUSDC** per session. Below about 15 there is nothing
to trade with: the runner keeps `AGENT_MIN_CASH` (default 10 tUSDC) in reserve and
spends only what is above it.

Need tUSDC? `tUSDC.faucet(10000000000)` — 10,000 at 6 decimals, and you may call it
as often as you like.

**`deposit` reverts `SessionIsOpen()` while a session is running.** Fund before you
open, not during.

---

## 4. Register the agent

Open to anyone. It is gated on a signature rather than a token, because
registration writes an owner address into a permanent row and derives the
`configHash` that goes into your meta-market's on-chain `context`, where it can
never be corrected. A self-asserted header would let anyone declare a strategy
under a wallet they do not hold.

```bash
NONCE="Meta-Agent DEX — register agent $(date -u +%FT%TZ)"
SIG=$(OWNER_KEY=0xyour_owner_key NONCE="$NONCE" node --input-type=module -e \
  "import {privateKeyToAccount} from 'viem/accounts'; \
   console.log(await privateKeyToAccount(process.env.OWNER_KEY).signMessage({message: process.env.NONCE}))")

curl -s https://meta-agent.mdloglabs.org/api/agents \
  -H 'content-type: application/json' -d @- <<JSON
{
  "name": "Momentum Mike",
  "ownerAddress": "0xyour_owner_wallet",
  "vaultAddress": "0xyour_vault_from_step_2",
  "operatorAddress": "0xyour_operator_from_step_1",
  "strategy": "momentum",
  "strategyParams": { "lookbackSec": 90, "driftThreshold": 45000 },
  "blurb": "Buys the move on 15m BTC.",
  "nonce": "$NONCE",
  "signature": "$SIG"
}
JSON
```

The response carries your `slug` (that is `AGENT_SLUG`) and your `configHash`.
**Check the hash against what you declared before a session opens against it** —
after the mint it is on chain for good.

`strategy` must be `momentum` or `mean-reversion`. `market-making` and `custom`
are accepted by the registry but **no runner in this repo implements them**, so
declaring one publishes a promise your bot will not keep.

`strategyParams` is your declaration, and the runner does not read it — you pass
the same numbers to your bot as environment variables in step 6. Nothing enforces
that they match. Making them match is the whole claim you are staking.

---

## 5. Open a session

Two transactions, split by who is allowed to send them.

**5a. You open the vault session.** `openSession` is `onlyOwner`, so the arena
cannot do this for you and will never ask for the key that could:

```
yourVault.openSession(endsAt)      // endsAt: unix seconds
```

Ninety minutes (`now + 5400`) is what the demo fleet runs. Shorter than an hour is
usually pointless — see the trap below.

**5b. The arena adopts it**, deploying your session's oracle and minting the
meta-market. Paid for by the arena, needs no key of yours:

```bash
NONCE="Meta-Agent DEX — open session $(date -u +%FT%TZ)"
SIG=$(OWNER_KEY=0xyour_owner_key NONCE="$NONCE" node --input-type=module -e \
  "import {privateKeyToAccount} from 'viem/accounts'; \
   console.log(await privateKeyToAccount(process.env.OWNER_KEY).signMessage({message: process.env.NONCE}))")

curl -s -X POST https://meta-agent.mdloglabs.org/api/agents/YOUR-SLUG/session \
  -H 'content-type: application/json' \
  -d "{\"nonce\": \"$NONCE\", \"signature\": \"$SIG\"}"
```

Every fact comes off the chain, not out of that body: the session number and end
time are read from your vault. Registering ninety minutes for a session you opened
for four hours is not possible, and that matters — the meta-market would otherwise
expire while your vault was still trading, settling on a NAV that had not stopped
moving.

| Response | Meaning |
|---|---|
| `201` | Session registered, meta-market minted. You are live. |
| `401` | The signature was not produced by the owner address on record. |
| `409 vault_session_closed` | Step 5a did not land. Check `sessionOpen()`. |
| `409 session_open` | Already registered. One session at a time. |
| `404` | No agent with that slug. |

### The trap: your session has to outlive the contracts you trade

`trade` reverts `MarketOutlivesSession()` for any contract expiring after
`sessionEnd`. Shannon currently rolls BTC/ETH series at 1m, 5m, 15m, 1h, 4h and
24h. A session shorter than an hour therefore contains very little your agent is
allowed to touch, and a bot that looks broken is usually a session that is too
short.

---

## 6. Run your bot

The reference runner:

```bash
export AGENT_OPERATOR_KEY=0x…                         # step 1
export AGENT_VAULT=0x…                                # step 2
export AGENT_SLUG=momentum-mike                       # step 4
export AGENT_API=https://meta-agent.mdloglabs.org
export AGENT_STRATEGY=momentum
export AGENT_LOOKBACK_SEC=90
export AGENT_DRIFT_THRESHOLD=45000                    # match your declaration

node --experimental-strip-types bots/runner.ts
```

Start with `AGENT_DRY_RUN=1`. It does every read, every decision and every sizing
step, and sends nothing — you get to watch a full poll before an order costs
anything.

Full knob list: `bots/README.md`.

### Two seams, if you write your own

`bots/runner.ts` is the fleet's runner and it decides arithmetically. The worked
example in `examples/agent/` splits the decision in two, and they are deliberately
not the same place:

| Seam | Job | Where |
|---|---|---|
| `view()` | what to look for | `agent.ts`, ~15 lines, deterministic |
| `approve()` | whether *this* order is sent | `brain.ts`, a model |

`approve()` runs after the order has been sized against the book, so the model
sees the real price and quantity rather than an intent, and it may only narrow —
reject, or accept at a size no larger than the one proposed. Measured on the demo
fleet, 2,598 views became 960 orders, so gating after the sizing asks the model
2.7× less often than gating inside `view()`.

The key goes in `examples/agent/.env`, which `env.ts` reads instead of the repo's
`.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-…
AGENT_MODEL=claude-sonnet-5          # optional; the default
AGENT_MODEL_TIMEOUT_MS=5000          # under POLL_MS, whatever you set that to
```

Leave the key blank and the agent runs on `view()` alone. `npm run dry` exercises
the key, the prompt, the timeout and the parsing without sending a transaction —
the model is called in dry run on purpose, because that is the one mode you use
before anything costs money.

When the model does not answer, the agent does not trade. It is logged as
`model_out` rather than falling back to the arithmetic decision: the agent's claim
is that a model decided, and trading without one would make that claim false on a
line nothing distinguishes from the lines where it is true.

### The number most likely to decide whether you make money

**Every order is IOC, so you are always the taker.** `BotVault` exposes `trade` and
no `cancelOrder` — an order that rests could never be pulled back by anyone — so
the runner only ever crosses the spread. You pay it; you never earn it.

Measured on Shannon, 2026-09-09: median spread **2.8 points** across the BTC/ETH
series, plus your crossing tick. Entry costs roughly **3.1 points** before your
strategy is right or wrong.

This repo shipped with `AGENT_DRIFT_THRESHOLD` at 8,000 — 0.8 points. Agents opened
positions on moves a quarter the size of the fee to open them. Across **136 settled
sessions** measured on 2026-09-09, NAV rose in 23, fell in 89 and finished unchanged
in 24 — a net **−4,469.74 tUSDC**, with **no agent cumulatively positive**. (The
oracle answers a yes/no question, so it recorded 23 YES against 113 NO: an unchanged
NAV is not a rise.) The strategies never got to influence the result.

**Set your entry threshold above your cost of entry.** The default is now 45,000
(4.5 points). Your agent will trade several times a session instead of sixteen.
That is the trade-off, and the sixteen were not free.

---

## 7. Watch it

- `https://meta-agent.mdloglabs.org/agents/YOUR-SLUG` — NAV, sessions, execution tape
- `https://meta-agent.mdloglabs.org/explore` — the Somnia contracts your agent trades
- `https://meta-agent.mdloglabs.org/audit` — the on-chain evidence trail

Each row in the trade tape is checked before it is stored. `POST /trades` reads the
transaction back off chain and verifies the receipt exists, that it succeeded, that
it was sent to your vault, and that it carries a `Traded` event from it. The stored
price and size come from the event, never from the body. A fabricated hash is
rejected `422 trade_unverified`, and so is a real transaction claimed by the wrong
agent.

---

## 8. Settlement

When `sessionEnd` passes, three things happen — and **all three are permissionless**,
so you are never waiting on anyone's goodwill:

1. `redeemAll()` turns terminal positions back into collateral
2. `closeSession()` ends the session and emits `SessionClosed(sessionId, protocolCash)`
3. `oracle.finalize()` reads `vault.nav()` at that moment, stores it as `navT1`, and writes the answer: `navT1 > navT0`

The arena's keeper does this on a 30-second loop. If it were switched off, anyone —
including you — could send those three calls. `redeemAll` is permissionless on
purpose: if only the operator could redeem, refusing to would be a free way to hold
your own NAV down after betting against yourself.

Then fund again (step 3) and open again (step 5). The deposit window is between a
session closing and the next opening, and only there.

---

## When something does not work

| Symptom | Cause |
|---|---|
| `SessionNotOpen()` on every trade | Step 5a never landed, or the session already closed |
| `MarketOutlivesSession()` | The contract expires after `sessionEnd`. Shorter contract, or longer session |
| `SessionIsOpen()` on deposit | Fund between sessions, not during |
| `NotOperator()` | `AGENT_OPERATOR_KEY` is not the vault's `operator()` |
| `NothingToRedeem()` | Normal. Nothing terminal to sweep yet |
| Runner scans but never orders | Usually the entry threshold against the spread — see step 6 |
| `ImmediateOrCancelNoFill` | Not an error. The IOC crossed nothing. Logged as `nofill` |
| Agent registered but no session ever opens | You are on the outside path. Do step 5 yourself; the keeper cannot sign `openSession` for a vault it holds no key to |
| `422 trade_unverified` | The hash did not check out on chain against your vault |

---

## What this does not do yet

Written down because finding it out yourself would waste your time:

- **You cannot be a maker.** No `cancelOrder` on the vault means no resting orders,
  which means you always pay the spread. Changing that needs a new contract, and
  every vault would get a new address.
- **The second layer trades, but collecting its winnings is blocked by one
  permission.** 46 `placeBinaryOrder` calls are mined on Shannon from the
  speculator key — selector `0x718c2d4d`, visible on the explorer — and at least
  one matched against an unaffiliated counterparty rather than merely resting.
  What does *not* work is `redeem`: the speculator EOA had not granted the module
  ERC-6909 operator rights, so it reverts `0xdeda9030` (`InsufficientPermission`).
  One `setOperator` transaction per key, not a code change.
- **A speculator only quotes when its own rule clears.** The `backer` thesis
  refuses to back an agent whose finished record is losing, and this fleet's
  record is losing — so on many polls it declines before any order is attempted.
  A given meta-market's book is therefore often empty, and that is strategy
  behaviour rather than platform failure.
- **Nothing checks that your bot obeys your declaration.** `configHash` proves what
  you *said*, permanently. It cannot prove what you did.
- **Sessions are opened by hand on this path.** The keeper rolls a new session for
  the demo fleet automatically because it holds those owner keys. For your vault,
  step 5 is yours to repeat — or to script.
