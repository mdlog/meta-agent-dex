# Meta-Agent DEX

**AI agents trade real [DreamDEX Event Contracts](https://docs.dreamdex.io/developers/event-contracts)
on Somnia Shannon out of a vault they hold no withdrawal key to, and every
session mints a *second* Event Contract — on an operator and venue this project
registered — asking whether that agent's NAV rises. A second fleet of agents
buys Up or Down on it. The first layer is the exchange that already exists; the
second is a market on the operator, settled by one number a contract publishes
and anyone can re-derive. Every transaction on both layers is signed headlessly
by an agent: there is no human trading path and nobody connects a wallet. The
web app is the observatory over both, and it reads chain without a key.**

---

## For judges

Built for the **Somnia x DreamDEX Event Contracts Hackathon**.

| | |
|---|---|
| **Live app** | https://meta-agent.mdloglabs.org |
| **GitHub repo** | https://github.com/mdlog/meta-agent-dex |
| **Demo video** | `TODO — demo video link` |
| Chain | Somnia Shannon testnet, chainId **50312** |
| Deployer / keeper | [`0x71a89a7e…7BaE`](https://shannon-explorer.somnia.network/address/0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE) |
| Control plane we registered | **operatorId 20** · venue `0xa3c034a0…fa77` |
| Contracts this project deploys | [`BotVault.sol`](./contracts/BotVault.sol) (one per agent), [`BotNavOracle.sol`](./contracts/BotNavOracle.sol) (one per session, write-once) |
| Who signs | Two headless daemons and nobody else — [`bots/runner.ts`](./bots/runner.ts) trades, [`bots/speculator.ts`](./bots/speculator.ts) prices the traders ([docs](./bots/README.md)) |
| Audit trail | [`/audit`](https://meta-agent.mdloglabs.org/audit), and the written trail in [`docs/ONCHAIN_EVIDENCE.md`](./docs/ONCHAIN_EVIDENCE.md) |

### Where the evidence for each criterion lives

| Criterion | Weight | Open this |
|---|---|---|
| **Innovation** | 20% | [What is real](#what-is-real) — a second-layer Event Contract written on a number a program produced, minted on our own operator/venue, priced by agents on both sides. Mint path: `mintMetaMarket` in [`chain.ts`](./src/lib/agents/chain.ts). Settlement source: [`BotNavOracle.sol`](./contracts/BotNavOracle.sol). |
| **Technical implementation** | 25% | Two Solidity contracts, an undocumented selector recovered from live calldata, a keeper lining up three clocks, two headless signers. 68 tests (`npm test`), 61 of which need no network. |
| **UX & design** | 20% | An observatory, not a terminal: `/` overview, `/agents` leaderboard, `/agents/[slug]`, `/settlement`, `/audit`. Every number is read from chain or from the session journal; a value that does not exist yet prints as a dash **and says why**. |
| **Business & ecosystem** | 20% | [`docs/ECOSYSTEM.md`](./docs/ECOSYSTEM.md) — what this adds to DreamDEX that an order book does not, and the limit of that claim. |
| **Presentation & demo** | 15% | [Try it](#try-it-in-90-seconds), then `/audit` — the demo's own receipt, every session open, mint, freeze and trade with a transaction hash. |

### Try it in 90 seconds

Nothing costs real money and nothing asks you to connect a wallet.

1. **Open `/`.** Eleven agents with their NAV curves and open sessions. The block
   height and the data-source word are what `/api/health` measured, not decoration.
2. **Open `/agents/alpha-z`.** Vault address, operator address, a trade tape with
   a transaction hash per order, and the meta-market minted against this session.
   Follow any hash into the explorer.
3. **Open `/audit`.** Top half is the fixed record, including the faucet reading
   that is the centre of the security argument. Bottom half is whatever this
   deployment has done since. `?agent=<slug>` narrows it to one agent.
4. **Open a meta-market.** `/explore` lists every live Event Contract; the
   meta-markets carry asset `BOTNAV`. Open one — it is an ordinary contract page,
   because it is an ordinary contract. **Up wins when the agent's NAV rises.**
5. **Watch it settle.** `/settlement` shows the queue and the clock. At close the
   keeper redeems, freezes the oracle, and 180 seconds later the committee reads it.

---

## What is real

Every claim below is a transaction anyone can open. Full reasoning in
[`docs/ONCHAIN_EVIDENCE.md`](./docs/ONCHAIN_EVIDENCE.md).

**We run our own control plane.** `registerOperator` → operatorId 20, `createVenue`
→ venue `0xa3c034a0…fa77`, 0.0116 STT for both. No third party can close the venue
mid-demo.

**A meta-market is a native Event Contract, not a shadow of one.** Minted with
`scheduleAndCreateMarket`, selector `0x94f9fdc7` — present in the deployed
`BinaryMarketsModule` but **not exported by the SDK**. The signature was recovered
from live calldata and is called directly with viem. The first one took a real
committee resolution: `winningOutcome 1`, `voided false`, payout
`[0, 10000000] / 10000000` — on the value our own contract returned.

**The vault is the trader, not the bot.** After a fill on a live BTC contract the
**vault held 10 YES and the operator EOA held 0**.

**A full session ran to a real loss.** navT0 100.00 → navT1 **92.60 tUSDC** after
`redeemAll()` converted the position back to cash. The agent bought YES, NO won,
the contracts expired worthless. That loss is the product working — a market on
"will this agent profit" is only worth trading if the answer can be no.

**Current deployment:** over 3,700 agent trades across 236 sessions, 225 finalised
on chain. The fleet is still running, so a fixed number here would be wrong within
the hour — [`/audit`](https://meta-agent.mdloglabs.org/audit) counts the journal on
every request and is the figure to quote.

### The security argument, in one paragraph

Shannon's test collateral has a permissionless faucet with no cooldown, so a
stranger could forge any agent's profit for the price of gas if NAV were a token
balance. It is not. `nav()` returns `protocolCash` — collateral an allowlisted
DreamDEX call actually delivered, moved only by the balance delta measured around
each call. Anything arriving another way lands in `unaccounted()`, visible to
anyone and never counted. The cost of that choice is shown rather than hidden: a
vault mid-session reads at the cash it has not spent, so the board prints what its
held legs would redeem for beside it.

The operator key can trade badly. It cannot withdraw — `deposit`, `withdraw` and
`setOperator` are `onlyOwner`, and `owner` is `immutable`. `redeemAll()`,
`closeSession()` and `finalize()` are **permissionless**: the keeper is a
convenience, not an authority.

---

## Honest limitations

- **Testnet only.** Every balance, price and position is test value with no
  monetary worth. The collateral's faucet is open, which is exactly why NAV is
  defined the way it is.
- **Settlement depends on DreamDEX's oracle committee.** We resolve nothing. A
  void refunds both sides and is the designed failure, not an error state — but
  it is still a dependency, and on the free contract-source tier it fires ~70% of
  the time, which is why we pay for six JSON sources.
- **Those six JSON sources are one origin.** Six reads of one mirror this project
  hosts. They buy servicing, not independence. Six genuinely independent gateways
  reading the same on-chain value is the fix, and it is not done.
- **The second layer trades, but its winnings are stuck.** 27 `placeBinaryOrder`
  calls are mined on Shannon from the speculator key — selector `0x718c2d4d` — and
  at least one matched against an unaffiliated counterparty rather than merely
  resting: 19.999980 tUSDC paid into the pool, 1.184040 back as price improvement,
  both outcome legs minted. What does **not** work is `redeem`: the speculator EOA
  had not granted the module ERC-6909 operator rights, so it reverts `0xdeda9030`
  (`InsufficientPermission`). One `setOperator` transaction per key, not a code
  change.
- **A speculator only quotes when its own rule clears.** The `backer` thesis
  refuses to back an agent whose finished record is losing, and this fleet's
  record is losing — so it often declines before any order is attempted. An empty
  book is usually the strategy working, not the platform failing.
- **No resting orders for the trading agent.** `BotVault` has `trade` and no
  `cancelOrder`, so an agent is always the taker and pays the spread — 2.8 points
  median on Shannon. The speculator can rest; the agent being measured cannot.
- **`configHash` proves what an operator declared**, permanently. It cannot prove
  what they ran.
- **The keeper is a single process.** Everything it does is permissionless, so
  nothing is stuck if it dies — but nothing is automatic either.

---

## Architecture

```
bots/runner.ts      → BotVault.trade()          → DreamDEX BinaryPool
                      (operator key, IOC only)
BotNavOracle.sol    ← nav() at open and close   → committee reads at resolutionTime
bots/speculator.ts  → placeBinaryOrder()        → the meta-market's book
src/app             → reads chain, holds no key
```

`BotVault.sol` is the trader, the custodian and the NAV accountant, one per agent.
`BotNavOracle.sol` is write-once, one per session: it snapshots navT0 at open,
navT1 after close, and freezes the answer to 1 (YES) or 2 (NO).

Three clocks must line up — the session window, the contract's expiry, and the
committee's `resolutionTime`. `trade()` reverts `MarketOutlivesSession()` for any
contract expiring after `sessionEnd`, which is what keeps every position terminal
before NAV is measured.

Deeper: [`specs/2026-09-07-meta-agent-dex-design.md`](./docs/superpowers/specs/2026-09-07-meta-agent-dex-design.md)
(the design this ships from) · [`bots/README.md`](./bots/README.md) ·
[`docs/ECOSYSTEM.md`](./docs/ECOSYSTEM.md)

---

## Running it

```bash
npm ci
cp .env.example .env.local        # fill in the keys it names
npm run build && npm start        # serves on :3009
SKIP_LIVE_TESTS=1 npm test        # 61 tests, no network
```

The fleet and keeper are one command — `npm run demo` funds the operator keys,
starts the runners, and starts the keeper. Full operational detail, including the
STT each round costs, is in [`docs/DEMO_RUNBOOK.md`](./docs/DEMO_RUNBOOK.md).

**Bringing your own agent:** [`examples/agent/`](./examples/agent/) is the whole
thing in five commands — deploy a vault you own, fund it, register by signature,
open a session, run the bot. The strategy is one ~15-line `view()` function, with
an optional model gate in `approve()` that may only *narrow* an order the
deterministic layer already sized. Walkthrough:
[`docs/BRING_YOUR_OWN_AGENT.md`](./docs/BRING_YOUR_OWN_AGENT.md).

---

## Risk disclaimer

Meta-Agent DEX runs on Somnia Shannon **testnet**. Every balance, price and
position is test value with no monetary worth. Nothing here is investment advice,
nothing recommends a position, and an agent's past NAV curve is a record of what
it did, not a claim about what it will do.

## Licence

MIT — the full text is in [`LICENSE`](./LICENSE).
