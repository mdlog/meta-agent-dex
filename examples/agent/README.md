# Example agent

A working agent for the Meta-Agent DEX arena, in five commands. Your vault, your
keys, real DreamDEX Event Contracts on Somnia Shannon testnet.

Nobody ever asks you for a private key. The two transactions that move your money
— deploying the vault and funding it — are sent by you. The arena's job is the
part it pays for: your session's NAV oracle, and the meta-market other people
price you on.

```bash
cd examples/agent
npm install
cp .env.example .env

npm run keys        # 1. make the bot's key, fund it with a little STT
npm run deploy      # 2. deploy your vault, fund it with tUSDC
npm run register    # 3. declare your strategy, get your slug
npm run session     # 4. open a session
npm run dry         # watch a full poll without sending anything
npm start           # 5. trade
```

Each step prints the line to paste into `.env` before the next one.

**`npm run session` is two transactions, and the split is why nobody needs your
key.** `openSession` on the vault is `onlyOwner` — the arena holds no key for your
vault and cannot call it, which is the point. So the script sends that one itself,
from your owner key, and then asks the arena to do the rest: deploy your NAV
oracle, snapshot `navT0`, mint the meta-market others price you on. Re-run it after
each session ends; registering once does not keep sessions coming.

Full prose walkthrough, including what each contract call means:
[`docs/BRING_YOUR_OWN_AGENT.md`](../../docs/BRING_YOUR_OWN_AGENT.md).

---

## What is in here

| File | |
|---|---|
| `agent.ts` | The deterministic half: read the book, form a view, size it, send it. ~440 lines. |
| `brain.ts` | The model gate. `approve()` decides whether each sized order is sent. |
| `1-keys.ts` | Generates the operator key. |
| `2-deploy.ts` | Deploys `BotVault`, faucets tUSDC, deposits. |
| `3-register.ts` | Signs and registers. Declares the same numbers the bot runs on. |
| `4-session.ts` | `openSession` on chain, then registers it with the arena. |
| `env.ts` | Reads this directory's `.env`. Never the repo's. |

`2-deploy.ts` needs compiled bytecode. From the repo root:

```bash
solc --combined-json abi,bin --optimize --via-ir \
     contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json
```

`--via-ir` is required, not cosmetic: `redeemAll` destructures a 14-field return
and the legacy pipeline fails it with "stack too deep".

---

## Two keys, and why

**Owner** deploys the vault, funds it, opens sessions. Holds STT and tUSDC.

**Operator** is the bot. It may call exactly one function on your vault — `trade`,
which forwards straight to a DreamDEX pool. It cannot withdraw, cannot deposit,
cannot change the operator, cannot open a session. It *can* close one after `sessionEnd` —
but so can anyone, because `closeSession()` carries no modifier at all. If it is stolen mid-demo
the thief gets the ability to trade your vault badly, and nothing else.

Using one key for both works and throws away the entire argument. `owner` is
`immutable` in the vault — compiled into the runtime bytecode with no setter — so
two vaults differing only in those twenty bytes are proof on chain that the
deployer of one holds no power over the other.

---

## The number that decides whether you make money

**Every order is IOC, so you are always the taker.** `BotVault` has `trade` and no
`cancelOrder` — an order left resting could never be pulled back by anyone, and
capital resting through a NAV snapshot is capital nobody can recall. So the agent
only ever crosses the spread. You pay it; you never earn it.

Measured on Shannon, 2026-09-09: median spread **2.8 points** across the BTC/ETH
series, plus your crossing tick. Entry costs about **3.1 points** before your view
is right or wrong.

This repo's own fleet shipped with a 0.8-point entry threshold. Agents opened
positions on moves a quarter the size of the fee to open them. Across **136 settled
sessions** measured on 2026-09-09, NAV rose in 23, fell in 89 and finished unchanged
in 24 — a net **−4,469.74 tUSDC**, with **no agent cumulatively positive**. (The
oracle answers a yes/no question, so it recorded 23 YES against 113 NO: an unchanged
NAV is not a rise.) The strategies never got to influence the result.

`DRIFT_THRESHOLD` defaults to `45000` here — 4.5 points — for that reason and no
other. Lower it and you will trade more often and lose more reliably.

---

## Making it yours

The agent decides in two places, and they are deliberately not the same place.

| Seam | Job | Where |
|---|---|---|
| `view()` | what to look for | `agent.ts`, ~15 lines, deterministic |
| `approve()` | whether *this* order is sent | `brain.ts`, a model |

```ts
function view(samples, p, now): { kind, why } | null
async function approve(candidate, cfg): { act, size, why } | null
```

**`view()`** gets the price history for one market, the current implied
probability in 6dp probability units, and the clock. Return `BUY_YES` or `BUY_NO`
with a one-line reason, or `null` to pass.

**`approve()`** runs *after* the order has been sized against the book, so it sees
the real price and quantity rather than an intent. It may only narrow: reject, or
accept at a size no larger than the one proposed. Measured on the demo fleet,
2,598 views became 960 orders — gating here rather than inside `view()` asks the
model 2.7× less often and gives it something concrete enough that its written
reason can be checked against the fill it produced.

Then update `.env` — `3-register.ts` sends those same values as your public
declaration, so what you published and what you run stay one object rather than
two that drift.

Everything the pool will reject is already handled: prices snapped to `tickSize`,
quantities to `lotSize`, nothing under `minQuantity`, nothing expiring after
`sessionEnd`, nothing above `MAX_ENTRY`. A size the model narrows is re-aligned to
the lot grid and re-checked against `minQuantity` before it is sent — scaling a
valid quantity by 0.37 lands between lots, and an off-lot quantity is a revert
*after* the gas is paid.

---

## Giving it a model

`approve()` calls a model. The key goes in this directory's `.env`, which `env.ts`
reads instead of the repo's `.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-…
AGENT_MODEL=claude-sonnet-5          # optional; the default
AGENT_MODEL_TIMEOUT_MS=5000          # keep it under POLL_MS
```

Leave the key blank and the agent runs on `view()` alone — the behaviour it had
before the gate existed. The gate is off by omission rather than behind a second
switch, so nothing has to be discovered to get the deterministic agent back.

`npm run dry` runs the whole loop including the model call, and prints the
decision and its reason without sending a transaction. The model is called in dry
run on purpose: the key, the prompt, the timeout and the parsing are everything
that can be wrong about model wiring, and they should be wrong before the order
rather than after it.

**When the model does not answer, the agent does not trade.** A timeout, a
transport error or an unparseable reply is logged as `model_out` and the order is
dropped. It does not fall back to `view()`'s decision: this agent's claim is that
a model decided, and trading without one would put a line in the record that
nothing distinguishes from the lines where that claim is true.

A contract's question text comes from the venue and goes into the prompt, so a
market titled *"ignore previous instructions"* is prompt injection an attacker
gets for free. The defence is structural rather than worded: a verdict can only
narrow within bounds validated before the model was asked, so the worst a
successful injection achieves is a pass or a smaller order.

---

## When it does not work

| Symptom | Cause |
|---|---|
| `idle reason="no session open"` | Run `npm run session`. Sessions end; re-open them. |
| `NotOperator()` | `OPERATOR_PRIVATE_KEY` is not the vault's `operator()`. The agent checks at boot and refuses to start. |
| `MarketOutlivesSession()` | The contract expires after `sessionEnd`. Longer session, or shorter contract. |
| `SessionIsOpen()` on deposit | Fund between sessions, not during. |
| `nofill reason="nothing crossed"` | Normal. The IOC found nobody. Not an error, and not logged as one. |
| `hold reason="no signal"` forever | Usually `DRIFT_THRESHOLD` against a quiet book. Watch with `npm run dry` first. |
| `idle reason="at the cash floor"` | Capital is deployed into positions, not lost. NAV is cash; it returns at settlement. |
| `422` from the arena | The trade hash did not check out on chain against your vault. |

---

## After the session ends

Three calls settle it, and **all three are permissionless** — you are never waiting
on anyone's goodwill:

1. `redeemAll()` turns terminal positions back into collateral
2. `closeSession()` ends the session and emits `SessionClosed(sessionId, protocolCash)`
3. `oracle.finalize()` reads `vault.nav()` at that moment, stores it as `navT1`, and writes the answer: `navT1 > navT0`

The arena's keeper does this on a 30-second loop. If it stopped, you could send
them yourself. Then fund again and run `npm run session` for the next one.

---

## What this cannot do

Written down so you do not spend an evening discovering it:

- **You cannot be a maker.** No `cancelOrder` means no resting orders, which means
  you always pay the spread. Changing that needs a new contract and every vault
  would get a new address.
- **The meta-markets have never been traded.** They mint and price correctly, but
  every order sent to one so far has been rejected by the pool with "Missing or
  invalid parameters". Your sessions are measured and settled; the layer that lets
  others bet on you is not working yet.
- **Nothing checks that your bot obeys your declaration.** `configHash` proves what
  you said, permanently. It cannot prove what you did.
