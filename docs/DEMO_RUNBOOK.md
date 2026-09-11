# Demo runbook

A shootable script for the 2–3 minute submission video, plus what to do when
Shannon does not cooperate.

**The shape of this demo is: you start agents, and then you narrate what they
do.** Every transaction in this product is signed by an agent — trading agents
on layer 1, speculator agents on layer 2, all of them reading through the NPM
SDK and signing locally with viem — and there is no human trading path left to
film. You never click "buy". The set is terminals and
browser tabs: seven processes for the full fleet, four tabs, and a hand on
neither side of the book.

Target length **2:36**. Hard ceiling 3:00 — the brief says 2–3 minutes and a
video that runs over is a video a judge stops watching.

Every quoted string below is the literal copy in the component that renders it.
Every number is either read off the screen at record time or comes from
`docs/ONCHAIN_EVIDENCE.md`, which has the transaction behind it. **Never script
a line the screen can contradict.**

---

## READ THIS FIRST — you cannot wait for a settlement on camera

A session runs **90 minutes**, and DreamDEX's committee reads the oracle
**180 seconds after the market expires**. Open to committee read is therefore
**93 minutes minimum**, and the committee answers when it answers.

There is no version of this video where you press record, open a session, and
show it settle. So:

1. **Start the fleet at least two hours before you record.** One session round
   is 90 minutes plus the committee's 180 seconds, so an hour is not enough to
   produce a single finished session. You need finished ones to exist before you
   can film one.
2. **The settlement beat is filmed on an ALREADY-SETTLED session.** You open a
   past session's meta-market, which is already `Resolved` on chain, and you
   read what happened to it. You never wait.
3. **Do not restart the app or re-provision agents after the fleet has been
   running.** `npm run provision` creates *new* vaults with zero history. The
   agent names survive; the record does not. If someone reprovisions 20 minutes
   before your slot, your settled sessions are gone and you wait another two
   hours.

The second-loudest thing on this page is in **Beat 3**: a meta-market's book is
quoted by **speculator agents and by nobody else**, so it holds exactly as many
orders as you funded and started. Nineteen speculator orders are already mined
from `0xb4f2cFf5…5DD5`, and `0x91d5c29e…` matched against an unaffiliated
counterparty — so the claim on camera is "agents have priced each other here",
and it is checkable. But a book only holds quotes while a funded speculator is
running: fund two keys before you record (T-120, step 4). If you do not, the
book is empty on camera and Beat 3 has a written fallback that says so plainly.
Pretending otherwise on camera is the one failure this project cannot recover
from.

---

## T-120 minutes — stand it up

Run from `/home/mdlog/Project-MDlabs/Dorahacks/somnia`. Node 22.6+. Four kinds
of process: the observatory, the keeper, the trading agents, the speculators.

### 1. The observatory

```bash
npm run build
npx next start -p 3009                              # terminal 1, leave running
```

It holds no trading key and signs nothing. Everything it shows was done by one
of the processes below.

### 2. The keeper

Opens sessions, closes them, freezes each oracle, and asks the indexer what the
committee decided. Every call it makes is one a stranger could also make:

```bash
# terminal 2 — leave running for the whole two hours
BASE=http://localhost:3009 AGENT_CYCLE_TOKEN=… npm run cycle -- --open
```

`npm run cycle` opens 90-minute sessions (`CYCLE_DURATION_SEC`, default 5400).
Do not shorten it to get a faster round: Shannon is currently rolling BTC/ETH
series at 3600s and longer, and `BotVault.trade` reverts `MarketOutlivesSession`
for any contract expiring after the session closes, so a session under an hour
gives the trading agents nothing they are permitted to trade and every poll
logs `scan tradable=0`.

### 3. The trading agents — layer 1, the ones being measured

Three runners, one per agent. The operator keys are in
`.data/demo-operators.json` (gitignored, real keys — do not open that file on
camera and do not paste it into a chat).

```bash
# terminal 3, 4, 5 — one per agent
export AGENT_API=http://localhost:3009
export AGENT_OPERATOR_KEY=0x…        # from .data/demo-operators.json
export AGENT_VAULT=0x…               # same file, same row
export AGENT_SLUG=alpha-z            # then neural-drift, then kestrel-7
export AGENT_STRATEGY=momentum       # mean-reversion for neural-drift
node --experimental-strip-types bots/runner.ts
```

Each of these holds a key that can call exactly one function, `BotVault.trade`.
Between them they have already produced **211 verified transactions** on Shannon.

**Some sessions will have an empty trade tape**, because the 1h series is not
always inside the window a given session can reach. That is why you start two
hours early: you need *a* session with trades, not every session with trades.

### 4. The speculator agents — layer 2, the ones doing the measuring

This is the half that puts a price on an agent, and it is the half most likely
to be missing on the day, because it needs keys you have funded yourself.

```bash
# generate two throwaway keys — run twice, keep both lines
node --input-type=module -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k = generatePrivateKey(); console.log('AGENT_SPECULATOR_KEY=' + k); console.log('# address: ' + privateKeyToAccount(k).address);"
```

Send each address a little **STT** for gas from the Somnia faucet. Send them no
collateral: each process mints its own tUSDC from the token's permissionless
faucet and logs every call at `warn`, which is a line worth having on camera.

```bash
# terminal 6
export AGENT_API=http://localhost:3009
AGENT_THESIS=backer  AGENT_SPECULATOR_KEY=0x… npm run speculator

# terminal 7
export AGENT_API=http://localhost:3009
AGENT_THESIS=skeptic AGENT_SPECULATOR_KEY=0x… npm run speculator
```

**Two theses, two keys, not one of each.** A single speculator quoting alone is
marking its own price; a `backer` bids YES up to its view minus its edge and a
`skeptic` bids NO up to its own, and where those limits overlap there is a fill
and a printed price. Two processes on one key would collide on the nonce.

A third terminal running `AGENT_THESIS=contrarian` is optional and does nothing
until a book exists — which makes it a good closing line if you have the seconds
for it, and nothing lost if you do not.

**If you have not funded speculator keys, say so on camera and film Beat 3's
fallback.** Do not run them in `AGENT_DRY_RUN=1` and imply the orders were real.

---

## T-10 minutes — the five checks that decide the take

Run all five. Any one of them failing changes what you film.

**1. The app is reading Shannon, not the offline simulation.**

```bash
curl -s https://meta-agent.mdloglabs.org/api/health
```

You need `"mode":"live"` and `"ok":true`. If it says `"mode":"sim"`, stop —
every contract on screen would be generated locally, the UI would correctly
brand itself **SIMULATED DATA**, and there is nothing worth filming.

**2. There is at least one open session with a minted meta-market.**

```bash
curl -s https://meta-agent.mdloglabs.org/api/agents/sessions | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("open:",len(d["open"]),"finished:",len(d["recent"]))
for e in d["open"]+d["recent"]:
    s=e["session"]
    print(e["agent"]["name"], "| session", s["sessionNumber"], "|", s["status"], "| oracle", s["outcomeValue"], "| https://meta-agent.mdloglabs.org/market/" + (s["metaMarketId"] or "NONE"))'
```

You want `open: 3` and `finished:` at least 3. A row printing `NONE` is a
session whose mint failed — do not film that agent's card.

**3. Pick the settled session you will film in Beat 5, and prove it on chain.**
Take a `finished` row's market URL from check 2 and read the chain's own view:

```bash
curl -s https://meta-agent.mdloglabs.org/api/markets/<MARKET_ID> \
| python3 -c 'import json,sys; print(json.load(sys.stdin)["onchain"])'
```

You are looking for `'isResolved': True, 'isVoided': False` and a
`'winningOutcome'` of `'up'` or `'down'`. **Write that market URL on a sticky
note.** That is your Beat 5. If every finished market says `isResolved: False`,
the committee has not answered yet — wait ten minutes and re-run.

**4. Pick the agent you will film in Beat 4, and check its tape is not empty.**

```bash
curl -s https://meta-agent.mdloglabs.org/api/agents/alpha-z \
| python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["trades"]),"trades on session",d["tradesSessionId"])'
```

Try all three slugs — `alpha-z`, `neural-drift`, `kestrel-7` — and film whichever
has the most trades. Zero trades everywhere means no eligible series was inside
that session's window; wait for the next session round.

**5. Check whether the speculators have put anything on a book.** This decides
which version of Beat 3 you film, and it is the check most likely to fail.

```bash
curl -s https://meta-agent.mdloglabs.org/api/markets/<OPEN_META_MARKET_ID> \
| python3 -c 'import json,sys; b=json.load(sys.stdin).get("book") or {}; print("up bids", len(b.get("upBids",[])), "| up asks", len(b.get("upAsks",[])))'
```

Any non-zero count means an agent order is resting and **Beat 3 is the good
take**: you point at a book that two programs built. All zeros means either the
speculators are not funded or they have refused every market so far — check
terminals 6 and 7 for `warn refuse` lines, which name the failing clause, and
film **Beat 3's fallback** instead. Do not film a book you cannot explain.

Last: open the four pages in tabs in this order and leave them loaded —
`/`, `/agents`, your Beat 5 market URL, `/audit`. Keep terminals 6 and 7 visible
on a second workspace; Beat 3 cuts to them. Set the browser to 1440px wide or
wider; below that the agent table drops columns.

---

## The run

### Beat 1 — 0:00–0:18 — what this is

**On screen:** `https://meta-agent.mdloglabs.org/`

The hero reads **"Back the agents that leave a trail."** The thing doing the
backing is a process called `backer`, running in terminal 6 since T-120 — say so
if you have the second for it; you cut to it in Beat 3. Point at the DATA SOURCE panel on the right: it
says **Reading Somnia** with the indexer block number underneath. That is what
`/api/health` measured, not a decoration.

**Say:**

> AI agents trade real DreamDEX Event Contracts on Somnia. You cannot verify a
> bot's track record from a screenshot, and nobody has ever been able to put a
> price on one. So this adds a second layer: a native Event Contract on whether
> the agent's session ends with more money than it started — and a second set of
> agents that trade it. Every transaction you are about to see was signed by a
> program through the DreamDEX SDK. There is no trade ticket in this product.

Scroll once so the metric strip is in frame — **Agents registered**, **Sessions
open**, **Meta-markets live**, **Sessions settled**. Do not read the numbers
aloud; they change between takes.

### Beat 2 — 0:18–0:44 — the agents being measured

**On screen:** `/agents`, then cut to terminal 3 for four seconds.

Three agents: **Alpha-Z** (momentum), **Neural Drift** (mean-reversion),
**Kestrel 7** (momentum). Point at the **Standings** table columns: NAV, Net
P&L, Win rate, Finished.

**Say:**

> Three trading agents, each with its own vault and its own key. Ranked on
> sessions they finished, not on what they are holding — an agent that has
> finished one outranks every agent that has not, before any number is compared.
> NAV here is `nav()` on the vault contract, never a token balance, and in a
> moment I will show you why that distinction is the whole project.

**Cut to terminal 3** and let one `scan` and one `signal` line land on camera.
The log is logfmt, one line per decision, and the `signal` line carries the rule
in words — that is the shot, not the scrollback.

> That is one of them deciding. The key it holds can call exactly one function
> on its vault, `trade`. It cannot withdraw, and it cannot even reassign itself.

If **Net P&L** is negative on every row, say so and move on. Losses are the
product working; a market on "will this agent profit" is only worth trading if
the answer can be no.

Back to `/agents`, scroll up to the **Open meta-markets** cards and open one
with **Take a side** — it is a link to the contract page, and it is the last
button anybody presses in this demo.

### Beat 3 — 0:44–1:16 — the agents that price the agents

**On screen:** the `/market/<id>` page you just opened, then terminals 6 and 7,
then back.

**Say, pointing at each thing as you name it:**

> This is the contract on the agent. Ticker **BOTNAV**. The question is
> *"Will agent Alpha-Z close session 3 with a higher NAV?"* — and this is not a
> page we built for it. It is the same market page, the same order book panel,
> the same probability rail and the same countdown that any BTC or ETH contract
> on this venue gets, because this **is** a native DreamDEX Event Contract. We
> minted it with `scheduleAndCreateMarket` on an operator and a venue we
> registered ourselves for 0.0116 STT — the mint itself is about 1.496 STT,
> re-quoted every time.

Point at the **This contract prices** panel — the agent's name, the session
number, **NAV at open** beside the vault's cash now. Then at the panel below it,
**How orders reach this book**, which names both daemons and the one command:

> There is no ticket on this page and no wallet button anywhere in this product.
> Every order that reaches this book is signed by an agent — a vault's operator
> key on the layer below, a speculator's own key on this one, both reading the
> book through the DreamDEX SDK. So instead of a buy button, the page tells you
> the command.

**Cut to terminals 6 and 7.** This is the shot the whole beat exists for. Let a
`view` line and an `intent` line land, then a `resting` or a `filled`:

> The backer reads the same evidence you just saw — the agent's finished-session
> record, its cash against its opening cash, how many markets it has touched,
> how much of the session is left — and prices it. The skeptic reads the same
> board and disagrees. Neither of them consults a random number, and both of
> them name the clause that made them refuse when they refuse.
>
> Their orders **rest**. That is the difference between the two layers: the
> trading agent can only cross, because its vault has no `cancelOrder` and an
> order it left on the book could never be pulled back. A speculator signs for
> itself, so it can quote — and a quote is what an empty book needs.

**Back to the market page and reload.** Point at the book panel: those levels
were put there by the two processes you just filmed.

> That is a price on an agent's performance, formed by two programs that had to
> stake collateral to say it.

**Optional, 4 seconds, and worth it:** open `/explore` and point at the list.
The BOTNAV contract is sitting in the same index as **BTC-1h**, **ETH-4h** and
**BTC-24h**. One sentence: *"the venue's own index does not treat it as a
special case."*

#### Beat 3, fallback — when no speculator key is funded

If check 5 came back all zeros, film this instead. It is shorter and it is
honest, and it is far better than implying a fill that did not happen.

The rail reads **"No implied probability"** and **"Nobody is quoting both sides
of this contract yet."** Do not skip past it:

> This book is empty, and I will tell you exactly why. The agent that quotes
> this layer exists — it is in the repo, it is documented, and every stage of it
> runs against this live board. What it has not had is a funded key, so nothing
> it decided has been mined. The contract is real, listed and settleable; the
> distance between "it exists and settles" and "it trades" is a funded key.

Then point at **How orders reach this book** and read the `npm run speculator`
line off the screen. Do **not** substitute a first-layer BTC order and let it
read as a meta-market fill.

### Beat 4 — 1:16–1:46 — the number that settles, and the number that cannot

**On screen:** `/agents/<slug>` for the agent you picked in check 4.

Go straight to the panel headed **THE NUMBER THAT SETTLES**. Two readouts, side
by side: **NAV · nav()** and **Unaccounted · unaccounted()**.

**Say:**

> Somnia's test collateral has a permissionless faucet — no cooldown, ten
> thousand per call. Anyone can push tokens into any address for the price of
> gas. So if NAV were a token balance, a stranger could forge this agent's
> profit for free, right before settlement.

Point at the callout under the two readouts and read the measurement on it:

> We faucet'd ten thousand tUSDC into a live vault. Its balance went to
> **10,197.91**. `nav()` moved by **exactly zero**, and the whole ten thousand
> showed up in `unaccounted()`. NAV counts only collateral a DreamDEX call
> actually delivered.

Then scroll down through, naming each:

- the **NAV curve** — each point is a read of `BotVault.nav()` at a block;
- **CUSTODY / The vault holds it** in the sidebar — the operator key may only
  call `trade()`; `deposit`, `withdraw` and `setOperator` are `onlyOwner` and
  the owner is a different address;
- **EXECUTION TAPE / Trades** — real IOC orders on live BTC and ETH contracts,
  every one of them signed by `bots/runner.ts` and by nothing else.

**Click one transaction hash in the tape and let the Shannon explorer load.**
Hold on it for two full seconds. This is the shot that makes the rest credible.

> The vault is `msg.sender` at the pool, so the vault owns every position. We
> checked: after a vault trade, the operator's own address held zero.

### Beat 5 — 1:46–2:16 — settlement, on a session that already settled

**On screen:** the market URL from check 3. **Do not** wait for anything.

The status pill reads **Resolved**. Say what happened to it, in this order:

> This is a session that already closed. Here is what happened, and none of it
> is a claim about the future.
>
> The vault's own oracle snapshotted NAV *before* the market existed, so no
> speculator staked against a baseline that had already moved. At close, three calls ran —
> `redeemAll()`, `closeSession()`, `finalize()` — and **all three are
> permissionless. Anyone can call them.** Our keeper is a convenience, not an
> authority.
>
> `finalize()` writes one number and it can never be restated. Then, 180 seconds
> after expiry, a DreamDEX validator subcommittee read that number and voted.
> **Settlement is defined by code and attested by DreamDEX's oracle committee.**
> NAV is one ERC-20 quantity anyone can re-derive from two published block
> numbers.

Now switch to `/settlement` and let the page do the rest.

- The banner states the same sentence you just said.
- The **How a market resolves** card walks 01 Snapshot → 02 Trade → 03 Freeze →
  04 Attest.
- The **Settled and voided sessions** table has an **Oracle answer** column
  (`YES · NAV rose` / `NO · did not rise`) and a **DreamDEX paid** column
  (`index 0 · Up` / `index 1 · Down` / `refunded both sides`).

One line worth saying over that table:

> The encoding is the payout wiring. One is YES, two is NO, and `winningOutcome`
> is the *index* of the matching interval — so YES has to be registered first or
> every market on the platform inverts while looking perfectly reasonable in
> review. Zero is deliberately outside both intervals, so "the oracle has not
> answered" voids and refunds instead of paying someone.

### Beat 6 — 2:16–2:36 — the receipts, then stop

**On screen:** `/audit`

**Say:**

> Every claim I just made is a transaction on this page. The top half was mined
> and checked before this recording — the operator and venue we registered, the
> first meta-market we minted and the committee resolution it took, the vault's
> real order on a live BTC contract, and the faucet reading. The bottom half is
> whatever this deployment has done since I started it.

Point at **A wallet top-up cannot move NAV** with its three rows —
`balanceOf(vault) 10,197.91`, `nav() 197.91`, `unaccounted() 10,000.00`.

Close on two sentences, and then stop talking:

> Every agent anyone deploys generates a new, genuinely uncertain,
> machine-resolvable question every session — and DreamDEX settles it on its own
> rails, with no new infrastructure. Agents trade it, agents price it, a contract
> measures it, and nothing in that loop is waiting for somebody to click.

---

## When Shannon misbehaves

| What you see | What to do |
|---|---|
| **A market voids on camera** | Say why, do not cut. Voids are the designed failure mode of an attested settlement: a subcommittee that cannot agree refuses to answer and **both sides are refunded — a void is not a loss.** The reason is measured and on `/settlement`: the OracleHub prices contract-type oracle sources at **0.00 STT**, so nothing funds a validator to service one, and **7 of 10** live contract-sourced samples voided. That is exactly why every meta-market also registers six paid JSON sources — the tier that voided **122 times in 20,617** samples, 0.59% — and why `resolutionTime` sits 180s after expiry rather than on it. The UI renders `Voided` as a real state with a real colour, because it is one. |
| **A freshly minted meta-market 404s** | Wait. The indexer takes a few minutes to pick up a new market; two minted at 03:56 were still 404 at 04:01 and resolved fine afterwards. Film a different agent's card and come back. Never film a 404. |
| **An agent card has no "Take a side" button** | It reads *"The vault session is open on chain; the meta-market mints on the next keeper pass…"* — that session's mint has not landed. The vault session is genuinely open and will still settle; there is simply nothing for a speculator to price yet. Film a different agent. |
| **The trade tape is empty** | No eligible BTC/ETH series sat inside that session's window. Pick another agent, or another session from **SESSION HISTORY**. Do not narrate a tape that is not there. |
| **The meta-market book is still empty** | Film **Beat 3's fallback**, which is written for exactly this. Say that the agent which quotes this layer exists, is documented and is unfunded, and that a funded key is the whole remaining distance. Never substitute a first-layer BTC fill and let it read as a meta-market trade. |
| **A speculator logs `warn refuse` on every market** | Read the reason aloud — it names the clause. `view 0.4xx is not above 0.5 by 0.030` means every agent has zero finished sessions, so the record carries no information and the thesis correctly declines. `the book has never quoted` on a `contrarian` means it is waiting for the other two, which is the design. A refusal is a decision, and it films better than a forced trade. |
| **A speculator logs `warn faucet`** | Leave it in frame and explain it: the process minted its own stake from the collateral's permissionless faucet. Then say why that is safe here — a speculator's balance is not NAV, is not scored and settles nothing, and `BotVault.nav()` was built to refuse exactly this kind of token. It is the same faucet as the `/audit` reading. |
| **A speculator exits with `holds 0 STT`** | It has no gas. Fund the address and restart it; nothing is lost, because an order it never sent is not a state. |
| **`unaccounted()` reads 0.00** | Correct and expected — nobody has faucet'd into that vault. The measured proof is the callout underneath it and the panel on `/audit`; use those. Do not faucet into a live vault mid-take to make the number move. |
| **Every agent shows 0% win rate** | Say it. Flat and losing sessions are what these strategies produced, the oracle answered `NO`, and the meta-markets paid the Down leg. That is the machine working end to end. |
| **The board says "The agent board could not load"** | A display failure, not a chain failure, and the page says so. Reload. Every session and trade is on chain regardless. |
| **A red bar reading SIMULATED DATA** | Stop recording. The indexer is unreachable and every contract on screen was generated locally. The app returns to live data on its own within about six seconds of the indexer coming back. |
| **`/settlement` "Resolved / void" reads 0 / 0 while markets are resolved on chain** | The keeper's committee-follow pass is not landing. Check terminal 2 for `committee:` lines. Film Beat 5 from the market page instead, which reads the chain directly. |

Do not fabricate a transaction hash, a settlement, a NAV or a user. Everything
above is recoverable on camera; a faked receipt is not, and this repository has
already been burned once by demo data that outranked real traders.

---

## Sentences that are true, and the ones that are not

Say these:

- "Settlement is **defined by code and attested by** DreamDEX's oracle
  committee."
- "`redeemAll()`, `closeSession()` and `finalize()` are **permissionless** —
  anyone can call them."
- "NAV is one ERC-20 number anyone can re-derive from two published block
  numbers."
- "The operator key can trade badly. It cannot withdraw."
- "Every transaction in this product is signed by an agent. There is no browser
  signing path." (If asked about the SDK: it is our source of market data, ABIs
  and pricing; the send is a local viem signature, because the SDK's write path
  returns `Missing or invalid parameters` on the public RPC — written up in
  `docs/DREAMDEX_SDK_FEEDBACK.md`.)
- "The trading agent cannot rest an order. The speculator can, and that is what
  puts the first quote on an empty book."
- "A speculator's stake is not NAV, is not scored, and settles nothing."

Never say these, in any form:

- ~~"No oracle."~~ There is one, and a judge who checks will find it.
- ~~"Settled purely by code."~~
- ~~"Atomic settlement."~~ Resolution happens at `resolutionTime`, and the
  committee answers when it answers.
- ~~"Trustless."~~
- ~~"Anyone can come and buy a side."~~ Not false about the chain — a
  meta-market is a public Event Contract — but it is the old framing, and it
  invites the question this demo has a better answer to.
- Any claim that a speculator order filled, unless you are looking at one. If
  the keys were not funded, say the keys were not funded.
- Any user count, TVL, volume figure, or testimonial. There are none.

---

## Numbers you may say out loud

Each was measured on Somnia Shannon and has a transaction in
`docs/ONCHAIN_EVIDENCE.md`.

- **operatorId 20**, venue `0xa3c034a0…fa77`, registered for **0.0116 STT**.
- A meta-market mint costs **≈1.496 STT** and needs real gas headroom: 21.9M for
  one source, and a 26M ceiling reverted with **empty revert data after burning
  24M**. Sent with an 80M cap.
- The faucet reading: balance **10,197.91**, `nav()` **197.91**,
  `unaccounted()` **10,000.00**.
- A full session ran to a real loss: navT0 **100.00** → navT1 **92.60**,
  **−7.40 tUSDC**, after `redeemAll()` converted the position back to cash.
- Contract-type oracle sources are priced at **0.00 STT** by the hub and voided
  **7 of 10** live samples, against **122 of 20,617** (0.59%) for the paid
  6-JSON tier.
- **EIP-7702 does not work on Somnia** — type-4 transactions are rejected on all
  three RPCs — and session keys are spot-only for Event Contracts. That is why
  the primitive here is capital segregation, not key restriction.
- **211 verified on-chain transactions** from the layer-1 trading agents.
- **Three meta-markets have settled 3 of 3, with zero voids**, on six JSON
  sources plus one contract source.
- The collateral's faucet hands out **10,000 per call**, permissionless and with
  no cooldown — which is where a speculator's stake comes from, and exactly what
  `nav()` refuses to count.

If a judge asks what you would tell the DreamDEX team,
`docs/DREAMDEX_SDK_FEEDBACK.md` is the written answer.
