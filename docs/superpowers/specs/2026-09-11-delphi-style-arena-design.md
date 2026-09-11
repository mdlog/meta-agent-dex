# Delphi-style Arena — design

**Status:** approved in conversation 2026-09-11, sections 1–4. Not yet implemented.
**Supersedes:** Layers 3 and 3b of `2026-09-07-meta-agent-dex-design.md` — the meta-market
and the speculator population are removed from the product. Layers 0, 1, 2 and 4 survive.
**Does not touch:** `main`, which remains the DoraHacks submission under judging. See §6.
**Reference:** https://competition.delphi.fyi (Gensyn Delphi agent competition), read
2026-09-10. Delphi is the presentation model only; the chain stays Somnia Shannon and the
venue stays DreamDEX.

## 1. What changes and why

Meta-Agent DEX presents its implementation rather than its contest. The board's columns are
`Vault nav()`, `Session`, `Win rate`, `Finished`, and the cards carry `redeemAll()`,
`unaccounted()`, `CASH AT OPEN`, `REDEEMABLE NOW`. Contract function names leak to the
surface as UI labels. A reader has to learn the machine before they can read the standings.

Delphi shows the same kind of system — agents, an SDK, a chain, prediction markets — as
**four numbers per agent**: `Account Value`, `PnL`, `Trades`, `Volume`, ranked. Everyone
starts at 1000 TST, so PnL is `Account Value − 1000` and the ranking needs no explanation.

This design takes that model and, on the operator's decision, takes it all the way into the
engine: the NAV oracle, the meta-market, the speculator fleet and the session machinery are
removed, not merely hidden. What remains is the part that was always the strongest claim —
agents trading real Event Contracts out of a vault they hold no withdrawal key to.

A second motive is operational, and it is measured rather than asserted. §2 records a burn
rate that makes the current architecture unable to stay up.

## 2. Verified before designing

Every line here was checked against the running system or the source on 2026-09-10/11, not
recalled.

| Claim | Evidence |
|---|---|
| `trade()` is gated on an open session | `contracts/BotVault.sol:179-181` — `if (!sessionOpen) revert SessionNotOpen();` and `if (expiry > sessionEnd) revert MarketOutlivesSession();` |
| `deposit`/`withdraw` are refused while a session is open | `BotVault.sol:120,127` |
| `redeemMarket(bytes32)` is permissionless and valid at any time | `BotVault.sol:207`, and its doc comment |
| `redeemAll`/`closeSession` are permissionless but refuse before `sessionEnd` | `BotVault.sol:193-196,223-226` |
| The runner's coupling to sessions is 24 references, all reads of `sessionOpen`/`sessionEnd` | `grep -c session bots/runner.ts` |
| Trades, price, quantity, cash delta and tx hash are already stored | `agent_trades(id, sessionId, agentId, marketId, symbol, kind, price, quantity, cashDelta, txHash, at)`, 3063 rows |
| Equity-curve data already exists | table `agent_nav_points` |
| One meta-market is minted per session, not three | 120 distinct `mintTx` over 120 minted sessions — ratio 1.00 |
| A meta-market costs ~1.496 STT | the `value` on the reverted `scheduleAndCreateMarket`, and `scripts/treasury.ts:16` |
| A full round of 11 agents costs ~19.5 STT including gas | keeper fell 49.75 → 28.53 STT across one round |
| The current architecture cannot stay up | 28.53 STT bought 1.7 rounds ≈ 3 h; keeper then degraded for 15 h, logging 5509 `insufficient balance` and 3753 `ERROR settle` into a 48 MB file while the site still looked alive |
| Delphi's columns | `Rank · Agent · Account Value · PnL · Trades · Volume`; global strip `Markets · Total Trades · Volume`; 164 agents, all starting at 1000 TST |

## 3. Architecture

### Layer 0 — Agent registration

Unchanged. An agent is a row with a slug, an owner address, a vault address, an operator
address and a strategy.

### Layer 1 — Agents trade real Event Contracts

Unchanged. `bots/runner.ts` polls DreamDEX, forms a signal, and calls `vault.trade()`
through the operator key. Momentum and mean-reversion strategies survive as they are.

### Layer 2 — BotVault owns the capital

Unchanged contract, **new lifecycle**. `openSession(endsAt)` is called exactly once per
vault, with `endsAt` set to the end of the competition. There is never a second session, so
nothing in the product needs to open, close, settle or finalise one.

The contract's existing guards then read as competition rules rather than session plumbing:

- `deposit`/`withdraw` revert while the session is open, so **equal starting capital is
  enforced by the contract**. No one can add capital mid-competition, including us.
- `expiry > sessionEnd` reverts, so an agent may only trade contracts that resolve before
  the competition ends. This is the rule we would have had to write anyway.
- `redeemMarket(bytes32)` stays available throughout, so positions are converted back to
  collateral as each market settles, without waiting for the end.

`endsAt` is therefore a commitment: capital is locked until that timestamp. Setting it too
far out strands the fleet's funds until it passes.

**Ordering is not optional.** Because `deposit` reverts while a session is open, the sequence
per vault is `deposit(1000e6)` **then** `openSession(endsAt)` — never the reverse. A vault
whose session is opened before it is funded cannot be funded at all until `endsAt` passes,
and would sit at zero for the whole competition. The provisioning script must assert the
vault's balance is at the target before it sends `openSession`, and must refuse otherwise.

### Layer 3 — Removed

The NAV oracle (`deployOracle`, `openOracle`), the meta-market mint (`mintMetaMarket`), the
keeper cycle (`scripts/agent-cycle.ts`), the speculator fleet (`bots/speculator.ts`) and the
settle/finalise path (`settleAgentSession`, `retryPendingMints`, `reconcile-vaults`) are no
longer invoked. The code stays in the repository as the record of what `main` submitted.

A much smaller keeper replaces the old one: a loop that calls `redeemMarket` for markets
that have settled and refreshes the ranking aggregates. It signs nothing expensive.

### Layer 4 — The observatory

The web app remains read-only over the chain. Its vocabulary changes; its role does not.

## 4. Ranking model

| Column | Definition | Source |
|---|---|---|
| Rank | `Account Value` descending | derived |
| Account Value | `protocolCash` + value of unredeemed positions | `nav()` + indexer prices |
| PnL | `Account Value − 1000` | derived |
| Trades | `count(*)` per agent | `agent_trades` |
| Volume | `sum(abs(cashDelta))` per agent | `agent_trades` |

Starting capital is **1000 tUSDC** per agent, raised from 200 for legibility: `+12967` reads
where `+16.60` does not, and the collateral faucet is permissionless so the figure costs
nothing. Integrity comes from the contract, not from the number.

Account Value is a **floor, not a total**. The server prices only markets the indexer
reports finalised, unvoided and decided, and counts everything else at nothing. The count of
markets it passed over must travel with the figure wherever it is shown — this caveat exists
in today's code (`AgentBoard.tsx`, `unpricedTouched`) and must not be lost in the rewrite.

The board starts from a clean line: all agents open at 1000. The 146 historical sessions stay
in the database but do not appear in the standings.

## 5. UI surface

Delphi's structure, mapped to data the repository already holds.

| Delphi block | Ours | Source |
|---|---|---|
| Hero + stat strip | title, then `Agents · Total Trades · Volume` | aggregates over `agent_trades` |
| TOP PERFORMERS | equity curves, top 5 | `agent_nav_points` |
| OPERATIONS | trade tape: side · agent · market · size · **tx link** | `agent_trades.txHash` |
| Podium | top 3 | derived |
| RANKINGS | `Rank · Agent · Account Value · PnL · Trades · Volume` | derived |

The tape is where we can beat the reference: Delphi prints truncated addresses, we hold a
transaction hash for every fill and can link each row to Shannon explorer. Simplifying the
product makes the on-chain evidence *more* prominent, not less.

**Routes**

| Route | Disposition |
|---|---|
| `/` | becomes the full rankings board |
| `/agents/[slug]` | kept — equity curve, open positions, trade tape |
| `/explore`, `/market/[id]` | kept |
| `/audit` | kept; gains `unaccounted()` from the retired board cards |
| `/settlement` | folded into `/audit` |
| `/agents` | alias of `/` |
| `/docs`, `/privacy`, `/terms` | kept |

**Components.** `AgentBoard.tsx` (820 lines) collapses to a six-column table; most of its
current bulk is session machinery. `AgentSessionCard.tsx` and the `MARKET PULSE` section are
deleted — the latter's subject is literally "Open meta-markets". `AgentNavChart`/`NavSpark`
are reused for equity curves. `AgentTradeTape` becomes OPERATIONS. `MarketCard`,
`ProbabilityRail`, `OrderBookPanel` and `Countdown` are untouched.

**Vocabulary.** `nav()` → Account Value · `Net NAV change` → PnL · `CASH AT OPEN` →
Starting capital · `REDEEMABLE NOW` → Open positions · `Session`, `Finished`, `Win rate` →
removed.

Composition follows the existing `globals.css` token system (88 tokens) and keeps the
green-up / red-down convention already in use.

## 6. Migration and isolation

`main` is the artefact under judging: `docs/SUBMISSION.md:38` lists
`https://somnia.mdloglabs.org` as the live prototype and `:44` its audit trail. It must not
change while judging is open.

**The vaults cannot be shared.** The eleven vaults are single on-chain contracts. The moment
v2 calls `openSession(endsAt)` with a distant deadline, any v1 keeper hits `SessionIsOpen()`
permanently — the exact deadlock observed on 2026-09-09 and 09-11. v2 therefore deploys
**eleven new vaults**. Operator keys are reused: an operator is only a signer, and the
existing ones already hold gas.

| | v1 (under judging) | v2 |
|---|---|---|
| Branch | `main` | `feat/delphi-board` |
| Port / URL | 3009 → somnia.mdloglabs.org | 3010 → v2.mdloglabs.org |
| PM2 app | `somnia-forecast-arena` | `somnia-forecast-arena-v2` |
| Database | `.data/forecast-arena.db` | `.data/forecast-arena-v2.db` |
| Vaults | the existing eleven, untouched | eleven newly deployed |

A Cloudflare tunnel route for `v2.mdloglabs.org` → `localhost:3010` is required.

**Vault ownership is an open decision (§9).** `deposit` and `openSession` are both
`onlyOwner`, so whoever owns a v2 vault must hold 1000 tUSDC at provisioning time. v1 split
ownership across eight independent wallets to demonstrate that agents fund themselves, and
that property is real — but it is also what stranded `tailward` on 2026-09-09, when its owner
held 29.49 of the 69.03 tUSDC needed and `chain.ts:562` correctly refused to mint the
difference from the faucet. Either the same split is kept and `fund-owners` runs first, or
v2 vaults are deployer-owned and the independence claim is dropped from the product.

v1's fleet was stopped on 2026-09-11 09:03 UTC and its state cleaned, so the submitted site
stands still and legible rather than degrading. The runbook gains a v2 section; existing v1
copy is left unchanged.

## 7. Testing

The ranking model is pure arithmetic over stored rows, so it is testable without a chain:
Account Value composition, `PnL = value − 1000`, `Volume = sum(abs(cashDelta))`, rank
ordering, and the unpriced-markets caveat propagating with the figure. These go in the
existing vitest suite.

The one-long-session lifecycle needs a single integration check: that `openSession` is called
once and never again, and that `redeemMarket` converts a settled position without it.

## 8. Known risks

| Risk | Handling |
|---|---|
| `endsAt` locks capital until it passes | Choose it deliberately; it is the one irreversible parameter in the design. |
| Fresh vaults cost deploy gas | Keeper holds 35.97 STT as of 2026-09-11; no mint costs remain, so this is the only significant spend. |
| Account Value understates while markets are unpriced | Ship the unpriced count beside the figure, as today's code already does. |
| Removing the meta-market removes the submission's differentiator | Accepted by the operator with the trade-off stated. `main` preserves the submitted version intact. |
| A silently dead keeper looks identical to a healthy one | The v2 keeper signs nothing expensive and cannot exhaust a balance, which removes the 2026-09-09/11 failure mode at its source rather than monitoring for it. |

## 9. Open questions

- `endsAt` for the single session: how long should the competition run? Capital is locked
  until it passes, so this is the one parameter that cannot be corrected later.
- Are v2 vaults deployer-owned, or split across independent owner wallets as in v1? The
  split is a genuine trust property and a genuine provisioning cost — see §6.
- Whether `/audit` should also expose a frozen view of the v1 meta-market history.
