> **Dated audit, taken before the pivot.** This report was written against
> **Forecast Arena** — the human-forecaster product — and its findings describe
> that codebase: no git repository, a 404 deployment, an order path that could not
> clear `lotSize`. All three were fixed, and the product became **Meta-Agent DEX**
> on 2026-09-07. It is kept unedited because an audit rewritten after the fact is
> not an audit.

# Forecast Arena — Submission Readiness Report

> **This is a superseded record, kept deliberately.** It audits *Forecast
> Arena*, the human-facing prediction product this repository started as, and it
> was written on 1 Sep 2026 — before the pivot to Meta-Agent DEX. Its verdicts,
> its scores and the test files it names describe that earlier product and are
> not claims about what ships today. It stays in the tree because four source
> files cite it by path as the record of a bug they were written to prevent
> (`src/app/page.tsx`, `src/components/OverviewBoard.tsx`,
> `src/components/AgentBoard.tsx`, `src/lib/services/agentStandings.ts`).
> For what this project is now, read [`../README.md`](../README.md); for the
> submission copy, [`SUBMISSION.md`](./SUBMISSION.md).

**Date: 1 Sep 2026 · Deadline: 8 Sep 2026, 18:00:00 UTC (JSON-LD `endDate`, epoch 1788890400) · ~6.9 days**

---

## 0. Status — what has been fixed since this report was written

This report is the **pre-remediation audit**. Sections 1–8 below are preserved
verbatim as the record of what was found; several of their findings are now
closed. Read this section first.

**Closed in code, verified:**

| # | Finding | State |
|---|---|---|
| B1 | `.agents/`, `.claude/`, `skills-lock.json` tracked | **Closed** — added to `.gitignore`. |
| B3 | Every order the app builds is rejected by the pool | **Closed** — sizing now goes through the SDK's own `quoteBinaryStakeOverBook` over the live four-sided book, with `getBinaryBookParams` read once per pool and cached. Quantity is lot-aligned and the protective limit tick-aligned before the wallet sees them, and both travel to `placeOrder` as raw values rather than being re-derived from a rounded float. The revert table was rebuilt against the SDK's `contractErrorsAbi`. A refused quote is one of four specific, user-readable refusals, not a generic failure. |
| B6 | The public leaderboard hands out account credentials | **Closed** — `publicLeaderboard()` is the only shape any route serves: no `userId`, no full wallet address, `walletShort` truncated as `/privacy` promises, and a server-computed `isViewer` instead of echoing the caller's own `fa_session` value back to JavaScript. Locked by three tests. |
| B7 | The demo's decisive beat is false and non-reproducible | **Closed** — `demoSeed.ts` is fully deterministic (mulberry32 off a pinned constant, Fisher-Yates sampling), and `DEMO_RUNBOOK.md` now states the beat that is actually true and stable. See the caveat below. |
| §2 crit. 2 | `/api/orders` phase=receipt trusted client fills | **Closed** — `src/lib/dreamdex/receipt.ts` reads the mined receipt from Shannon RPC, checks the sender is the connected wallet, and decodes the pool's own `OrderFilled` logs. A hash the chain does not know is *rejected* (a block-number probe separates "no such transaction" from "RPC down"), a fill naming no transaction is refused, and a receipt the server could not verify is recorded but never scored. Proven from outside with curl: four forgery routes, all refused, zero scored positions — now five permanent checks in `npm run workflow` §6b, plus a live test that decodes a real Shannon fill and cross-checks it against the indexer. |
| §2 crit. 2 | Second-browser wallet connect threw an uncaught 500 | **Closed** — the merge runs in a SQLite `SAVEPOINT` across every table that references `users(id)`, and `getSessionUser` can no longer poison a session. Four regression tests. |
| §2 crit. 3 | Three unlayered CSS rules defeating `@layer utilities` | **Closed** — `.field` and `.input` are separate tokens with every call site migrated, and `body > *` / `a { color: inherit }` moved into `@layer base`. The header sticks; nav colour utilities win. |
| §2 crit. 3 | `--color-dim` failed AA | **Closed** — `#5C6E85` (3.36:1) → `#7D8C9B` (5.08:1 on panel). |
| §2 crit. 3 | Three client screens failed silently | **Closed** — portfolio, profile and leaderboard now keep loading / empty / failed apart, each with a retry. |
| §2 crit. 4 | Landing CTA picked a contract with seconds left | **Closed** — the hero requires >600s of life and a quote inside [0.15, 0.85], with a fallback ladder. |
| §2 crit. 4 | The public profile page was unreachable from the UI | **Closed** — every leaderboard row links to `/profile/<handle>` with the copy *"See the calibration behind this score"*, and your own profile links to its public view. |
| §2 crit. 4 | A judge following the README never seeds | **Closed** — the README now has a *"Fill the leaderboard before you judge it"* section. |
| §4 #5 | Four false README claims (SDK boundary, source of truth, Postgres boundary, test counts) | **Closed** — the SDK-boundary claim now names `src/lib/wallet/trade.ts` as the second and only other importer (verified by grep), the Postgres claim now says a port touches the eight service modules rather than one file, the source-of-truth paragraph states the receipt rule, and every count is re-measured. |
| — | An unknown contract / arena / profile URL returned **200 OK** | **Closed** — the root `loading.tsx` was committing the response before `notFound()` could set a status. Moved to `/explore`, the one route that waits on the indexer and never 404s. Verified on a production build: `/market/0xdeadbeef` → 404. |
| §5 #18 | Degraded mode presented generated contracts as live | **Closed, end to end.** `ResilientAdapter.mode` follows the adapter that answered, every market and book leaving that file carries `simulated`, and the flag is now on `ArenaMarket` itself rather than an augmentation. What a reader sees during an outage: a solid red **SIMULATED DATA** bar above the nav; the strip reading *"SIMULATED DATA — not Somnia testnet"*; `/explore` retitled *Simulated Event Contracts* with a matching eyebrow, lede, readout label and browser-tab title; a **SIMULATED** pill on every card, on the market page and on affected portfolio and profile rows; "generated locally" where the spread would be; the landing hero's *"Live on Somnia testnet"* replaced; the "Open right now" heading replaced; and the Trade tab refusing to price or sign at all. The cooldown and the health poll are both 5s. `npm run workflow` now asserts the cards and the banner agree. |
| §5 #9 | Arena lock could be walked around via `/api/orders` | **Closed** — one `assertArenaWritable` called from both write routes, enforcing existence, contract membership, lifecycle *and* the arena's own mode. In the intent phase a refusal refuses the request; in the receipt phase, where the transaction already exists, the arena claim is dropped and the position is kept as a personal trade. Six route tests and six service tests. |
| §5 #15 | Market and explore pages were frozen snapshots | **Closed** — `LiveRefresh` re-runs the server render every 5s and once at the lock boundary, stops on a settled contract, pauses on a hidden tab, and carries a pause control plus a "re-read Ns ago" age measured between server renders — so a cached answer would show the age climbing instead of resetting. Both API market routes send `no-store`, and `json()` now defaults every API response to it. |
| — | A verified receipt's **side** was still taken on trust | **Closed** — `OrderFilled` carries no direction, so a genuine own-wallet BUY_YES receipt could be posted as `outcome: "down"` and scored at the inverted price. `receipt.ts` now also decodes the taker's own `OrderPlaced` from the same transaction and reports the side and the order's owner. Measured against live Shannon before shipping: BUY_YES → `isBid: true` and BUY_NO → `isBid: false`, 8/8 each on the indexer's own kind field and 4/4 decoded off chain; the taker's placement was present in 10 of 10 real fill transactions. A decoded side that disagrees is refused (`side_mismatch`); an absent one is left unproven rather than assumed. The owner check also fixes a false negative: a relayer-submitted order is now attributable to the wallet that owns it, which the `receipt.from` check alone rejected. |
| — | A forecast made during an outage was indistinguishable from a real one | **Closed** — `MarketSnapshot` carries `simulated` and `snapshotOf` stores it, so a row settled by the fallback says so in the database and in the portfolio, not only on the screen it was made from. |
| — | `/terms` overstated the anti-farming cap | **Closed** — it now matches `MIN_MARKETS_FOR_CAP = 4` and the relaxation below it, which `tests/scoring.test.ts` pins. |

**Explicitly deferred by the project owner — still open, and each is a hard
platform requirement:**

- **B2 — no git repository.** Deferred. `.gitignore` is prepared for it.
- **B4 — no deployment.** Deferred. Note the finding stands: `node:sqlite` is
  file-backed, so Vercel is structurally unsuitable; use a host with a
  persistent volume and set `FORECAST_ARENA_DB` to a path on it.
- **B5 — no demo video.** Deferred. `DEMO_RUNBOOK.md` is corrected and ready to
  shoot from.

**Caveat on B7.** The seed is deterministic, but the ranks it produces still
depend on which contracts DreamDEX settled that hour. Measured live on the day
this was written, the Overconfident Punter is **first on profit and fourth of
five on skill** — a 0.1-point margin from last. Do not say "last on skill" on
camera; say "top of the money board, bottom of the skill board", which held in
every regime tested. The runbook says so, and the test suite asserts only the
durable half.

**Still open, not deferred, judged not worth the risk this close to the
deadline:** redemption is not driven from `client.getClaimable`, so the button
re-offers itself after a reload and a second press reverts rather than
double-paying; the void-redemption path is correct by construction but has never
been executed against a real voided market, because none exists in the last 60
settled on Shannon.

**Verified state at the time of writing:** `npx tsc --noEmit` clean;
`npm test` 47 tests, 40 passing with the 7 live-testnet tests skipped offline
and 47 passing with them; `npm run build` clean; `npm run workflow` green against a
production build (93/93 on a warm database, 85/85 on a cold one — the count
grows with what settles during the run).

---

## 1. Verdict

**Not submittable today, and not close.** DoraHacks enforces two platform badges on this event — "GitHub/Gitlab/Bitbucket Link Required" and "Demo Video Required" — and Forecast Arena has neither: `git status` returns `fatal: not a git repository (or any parent up to mount point /)`, and a full media scan of the tree returns exactly one file, `src/app/icon.svg`. There is also no deployment; the only URL the app advertises (`src/app/layout.tsx:14`, `metadataBase: new URL("https://forecast-arena.vercel.app")`) returns HTTP 404 with `x-vercel-error: DEPLOYMENT_NOT_FOUND`. Those three are a day and a half of work and are not what will cost you the prize. **The single thing most likely to cost you the prize is that the write path does not work and you have no proof it ever did.** `buildPreview` computes `const contracts = stake / price;` (`src/lib/services/orders.ts:108`) and rounds to 6dp (`orders.ts:132`), but every live pool reports `{tickSize: 1000, minQuantity: 1000, lotSize: 1000}` and rejects non-lot quantities — simulated live today on two Shannon pools, the app's quantity reverts `InvalidQuantity(["50761421","1000"])` while the lot-floored quantity reaches the escrow check. `grep -rn "lotSize\|minQuantity\|getBinaryBookParams" src/` returns **zero hits**. About 91% of ordinary integer stakes produce an invalid quantity, `InvalidQuantity` is not in the error table, and there is no recorded transaction hash anywhere in `docs/` or `README.md`. On a hackathon whose first criterion is "how effectively does the project use DreamDEX Event Contracts," you are shipping a client that cannot place an order and cannot point at one it placed.

**Probability of placing in the money ($5,000 pool, 13 BUIDLs submitted / 23+ repos found, likely 3–5 paid slots):**
- Submitted as-is today: **0%** — the form will not accept it.
- Three platform blockers closed, code untouched: **~15%**. Judge opens the URL, clicks Trade, gets `InvalidQuantity` reported as "The order could not be completed," and the leaderboard is empty on the documented path.
- Full plan below executed: **~40%**. The scoring kernel, the test suite and the two genuine SDK findings are above the median of this field; the ceiling is capped by three competitors (ProofCast, brier, palpito) shipping the same "score the forecaster, not the price" thesis, two of whom beat you on verifiability.

---

## 2. Rubric scorecard

Scored against the four criteria in your brief. **Note: the official event page carries five weighted criteria, not four** — Innovation & Originality 20%, Technical Implementation 25%, UX & Design 20%, Business & Ecosystem Impact 20%, Presentation & Demo 15%. Your four map to only 45% of the score. Second table covers the gap.

| Criterion | Now | Why (anchored) | By 8 Sep |
|---|---|---|---|
| **1. DreamDEX Event Contracts / API / SDK usage** | **4** | Read path is genuinely correct on the hard parts — stale `clobStatus` handled in `adapter.ts:95-109`, Up/Down inversion right at `orders.ts:69-71`, bytes32 `marketId` (not pool address) at `live.ts:212`, chain-head write gate never simulated (`index.ts:80-83`). But: 7 of 190 `SomniaMarketsClient` methods used, realtime tier 100% unused (`grep watchMarket` → zero), price feed unconfigured, `getPortfolio`/`getCandles`/`getFills`/`getClaimable` unused, and **the write path reverts**. No tx hash exists to prove one order ever landed. | **7** |
| **2. Technical implementation** | **4** | Real strengths: `src/lib/scoring/index.ts` is genuinely pure (one type-only import at line 9), the fixed-point 30% market-share cap is mathematically correct under exhaustive brute force, settlement is idempotent by construction (`predictions.ts:227,246`), 105 tests pass with 6 hitting live Shannon, zero SQL injection surface. Against that: the leaderboard hands out session credentials (`leaderboard.ts:119` returns `userId`, which IS the `fa_session` cookie value), `/api/orders` phase=receipt writes `filledQuantity`/`averagePrice`/`txHash` verbatim from the request body with no chain read (`route.ts:99-100`), connecting the same wallet from a second browser throws an uncaught `FOREIGN KEY constraint failed` 500 (`users.ts:64-72`), and four README architecture claims are false. | **6.5** |
| **3. Intuitiveness / accessibility / usability** | **4** | Empty states are written and complete on every screen, `:focus-visible` gives a 2px ring on all 14 tabbable elements on the market page, `prefers-reduced-motion` collapses delays not just durations. Then three unlayered CSS rules defeat Tailwind's `@layer utilities` on **every screen**: `.field` declared twice (`globals.css:218` and `:311`) so ~35 text labels render as bordered input boxes; `body > * { position: relative }` (`:171`) beats `.sticky` so the network/nav header never sticks; `a { color: inherit }` (`:264`) kills every text-colour utility so active nav is indistinguishable from inactive. Plus: `--color-dim` fails AA at all 74 uses including every `<th>`, leaderboard rows are mouse-only, three client screens fail silently, and clicking "Connect wallet" with no extension does literally nothing. | **7** |
| **4. Overall UX / compelling experience** | **3** | The signature instrument works — the Brier square renders and is legible at 1440px and 390px with a numeric caption. Everything around it undercuts it: the landing CTA always picks a contract with seconds left (measured 0m02s–1m53s over 5 loads), nothing on any screen ever refreshes (only two `setInterval`s exist app-wide, both cosmetic), the public profile page with the calibration plot is **unreachable from anywhere in the UI** (`grep -nE "Link\|href\|/profile" src/components/LeaderboardView.tsx` → zero), and a judge following the README verbatim gets an empty leaderboard because `.env.example:25` ships `ALLOW_DEMO_SEED=0` and the README never mentions seeding. | **7** |

**The three criteria your brief is missing (55% of the official score):**

| Official criterion | Now | Why | By 8 Sep |
|---|---|---|---|
| Innovation & Originality (20%) | **4** | The thesis is not novel in this field — ProofCast, brier and palpito all shipped "score the forecaster." Your three genuinely unique things (no-wallet scored practice, the rail/Brier-square as one instrument, shareable arenas) are not what the README leads with. | 6.5 |
| Business & Ecosystem Impact (20%) | **2** | The argument exists only in Indonesian at `docs/PRD.md` §20. The English README's Known Limitations *opens* with "Order fills need testnet liquidity." | 6 |
| Presentation & Demo (15%) | **0** | No video, no screenshots, no deck, no live URL. And `DEMO_RUNBOOK.md:45-47`'s scripted climax is false in 5 of 5 live runs. | 7 |

---

## 3. Blockers — must fix before submitting

**Ordering matters. #1 must happen before #2 or the damage is permanent in git history.**

### B1. `.gitignore` does not cover vendored agent tooling — 10 min
**What:** `.agents/` (14 third-party `SKILL.md` files, 6,670 lines, 384 KB, sourced per `skills-lock.json:4-8` from `Leonxlnx/taste-skill`), `.claude/` (a session lock + 13 symlinks), and `skills-lock.json` are all outside `.gitignore`. A simulated `git add -A` stages them as 29 of 118 files.
**Why:** GitHub sorts dotfiles first, so `.agents/skills/gpt-taste/SKILL.md` is literally the first thing a judge sees, above `src/`. It frames 9.5k lines of genuinely good engineering as agent output before anyone reads a line of it. After a push it is in history forever.
**Fix:** Append `.agents/`, `.claude/`, `skills-lock.json`, `tsconfig.tsbuildinfo` to `.gitignore`. Verify: `git status --porcelain | grep -E '\.agents|\.claude|skills-lock'` returns nothing.
**Time: 10 min.**

### B2. No git repository — hard DQ — 2 h
**What:** No `.git`, no commits, no remote.
**Why:** Platform-enforced badge. Without a repo URL the Submit BUIDL form cannot be completed. All 100% of the rubric is unreachable.
**Fix:** After B1: `git init && git branch -M main`. Do **not** squash 9.5k lines into one "initial commit" — split into 6–10 thematic commits (scaffold, dreamdex adapter, scoring kernel, services, API routes, UI, tests, docs) so history reads as engineering. Public GitHub repo `forecast-arena`, description = the sharpened positioning, topics = `somnia, dreamdex, event-contracts, prediction-market, brier-score, calibration, nextjs, typescript, hackathon`. Then verify the judge's path in a clean clone: `git clone <url> /tmp/fa && cd /tmp/fa && npm ci && cp .env.example .env.local && SKIP_LIVE_TESTS=1 npm test && npm run build`.
**Time: 2 h** (most of it slicing commits).

### B3. Every order the app builds is rejected by the pool — 3–4 h
**What:** `orders.ts:108` `const contracts = stake / price;` → `orders.ts:132` `Math.round(contracts * 1e6) / 1e6` → `trade.ts:82` `quantity: fromHuman(intent.quantity, intent.decimals)`. Pool `lotSize` is 1000 raw units. Proven by `eth_call` on two live Shannon pools: `InvalidQuantity(["50761421","1000"])` vs lot-floored `50761000` reaching `ERC20InsufficientAllowance`. 18 of 200 integer stakes happen to align.
**Why:** This is the headline claim ("place a real Event Contract order on Somnia testnet") failing on the demo path, guts criterion #1 and Technical Implementation, and destroys the video's decisive beat. `InvalidQuantity` is not in `REVERTS` (`errors.ts:33-64`) so the user sees only "The order could not be completed."
**Fix — one change closes three findings.** Replace the arithmetic in `buildPreview` with the SDK's own kernel:
```ts
const params = await client.getBinaryBookParams(pool);      // cache per pool, immutable
const q = quoteBinaryStakeOverBook(book, side, fromHuman(stake, decimals),
            10n ** BigInt(decimals), { ...params, slippageBps: 100 });
```
Surface `q.quantity`, `q.limitPrice`, `q.escrow` as contracts / limit / max-loss; render `null` as a disabled Trade button with "this stake cannot cross the book". Pass `q.limitPrice` straight into `trader.placeOrder` — `somniaMarketsClient.d.ts:315-317` says the result feeds directly into that call. **This simultaneously fixes: the lot-alignment revert, the 57%-overstated payout (measured on live pool `0x3bf5a438…`: preview claims 314.47 contracts when 200 rest at that ask), and the zero-slippage IOC** (`derivedReads.d.ts:240-247`: "pinning that limit to the exact crossing price means any tick of book churn … leaves it uncrossable — the order fills nothing"). Add `InvalidQuantity`, `QuantityNotAlignedToLotSize`, `QuantityBelowMinimum`, `PriceNotAlignedToTickSize`, `ImmediateOrCancelNoFill`, `TradingNotActive` to `REVERTS`; drop `MarketNotTrading` and `ZeroQuantity`, which do not exist in `contractErrorsAbi`.
**Time: 3–4 h.**

### B4. No working prototype on testnet, and Vercel is structurally impossible — 3–4 h
**What:** Required deliverable. `src/lib/db/index.ts:144-147` does `mkdirSync` + opens a file-backed `node:sqlite` DB on every session-resolving request. Proven with a chmod-555 directory: `/api/health` → 200 (banner still says "LIVE DreamDEX data") while `/api/leaderboard` → 500 and `/api/portfolio` → 500, with pages still rendering 200. A judge would see a confident live banner over dead interactive surfaces.
**Why:** A judge with 15 minutes clicks a link; they do not `npm install`. 7 of 23 sampled competitors already have live URLs.
**Fix:** **Do not deploy to Vercel.** Railway / Render / Fly with a persistent volume mounted at `/data`; set `FORECAST_ARENA_DB=/data/forecast-arena.db`, `DREAMDEX_MODE=live`, `ALLOW_DEMO_SEED=1`, all `NEXT_PUBLIC_SOMNIA_*`. Add `"engines": { "node": ">=22.6" }` to `package.json` so the host picks a runtime with `node:sqlite` (currently no engines field; local is v22.23.1). Seed once after deploy. Update `layout.tsx:14` `metadataBase` to the real host — the OG image route (`src/app/opengraph-image.tsx`) already works and emits a finished 1200×630 PNG, it just resolves against a dead domain.
**Time: 3–4 h** including a cold incognito verification with a fresh wallet.

### B5. No demo video — hard DQ — 6 h including a re-shoot
**What:** Zero video, zero screenshots, zero fallback stills. `docs/PRD.md:639` requires the stills you do not have.
**Why:** Platform badge + the only channel scoring Presentation & Demo (15%).
**Fix:** Shoot off `DEMO_RUNBOOK.md` **after B7 corrects it**. 2:00–2:59, hard. Must show on camera: a real Shannon tx hash opened in `shannon-explorer.somnia.network`, and the skill-vs-profit toggle. Capture the three fallback stills first (settled forecast + Brier square; explorer tx page; populated boards). YouTube **Unlisted or Public — never Private**.
**Time: 6 h.**

### B6. The public leaderboard hands out account credentials — 30 min
**What:** For a practice user the `fa_session` cookie value **is** `users.id` (`users.ts:97`), and `leaderboard.ts:119` returns `userId` on every row, served by `/api/leaderboard` and `/api/arenas/[slug]` to anyone. Proven live: read a userId off the board → `curl -H "Cookie: fa_session=<that id>" /api/portfolio` returned a stranger's `"reasoning":"funding looks stretched","reasoningPublic":false`; `POST /api/profile` renamed them to "PWNED BY CURL". `leaderboard.ts:132` also returns the full untruncated wallet address, contradicting `src/app/privacy/page.tsx:50-51` ("a truncated address. Nothing else about you is public").
**Why:** You are about to deploy this publicly. A judge with devtools open on the leaderboard sees session tokens in the JSON, on the project whose pitch is a verifiable record.
**Fix:** Delete `userId` from `LeaderboardRow`; compute the `isYou` flag server-side and return a boolean `isViewer` (`LeaderboardView.tsx:149` currently compares `r.userId === viewerId`). Return `shortAddress(r.walletAddress)` — already imported at `leaderboard.ts:16`. That makes the privacy page true as written. Keep a derived public id (`sha256(userId + SERVER_SALT).slice(0,16)`) if you want the profile links from win #2.
**Time: 30 min.**

### B7. The demo's decisive beat is false and non-reproducible — 1.5 h
**What:** `DEMO_RUNBOOK.md:45-47`: "the Overconfident Punter tops the profit board and sits fourth on skill." `demoSeed.ts` calls `Math.random()` **8 times** with no seed (`:121` shuffles the contract pool, `:129` decides each outcome). Across 5 seeds against live settled contracts the Punter was 5th on skill in 5/5 runs and topped profit in 2/5; both halves held together in **0/5**. Also `realisedPnlOf` treats "never traded" as 0.00, so the two `stake: null` archetypes (`demoSeed.ts:59,75`) outrank every trader who lost money on a board labelled **Profit** — 60/60 sim reseeds put a non-trader at rank 1.
**Why:** This is the one moment the whole video is built around. Narrating a line the screen contradicts is the fastest way to make a judge conclude the scoring is theatre.
**Fix:** Replace the 8 `Math.random()` calls with a 12-line mulberry32 keyed off a constant. Give Cautious Hedger and Patient Specialist a real stake so the Profit board has five real values. Run the seed, read the actual board, rewrite `DEMO_RUNBOOK.md:45-47` from it. Add a test asserting the expected orderings so script and data cannot drift again.
**Time: 1.5 h.**

**Blocker total: ~17 hours.**

---

## 4. High-value wins, ranked by (judge points) / (hours)

Everything above the cut line is worth more per hour than anything below it. Do them in order.

| # | Win | Hrs | Criteria hit | Why the ratio is this high |
|---|---|---|---|---|
| **1** | **Four CSS layer fixes.** Rename `.field` at `globals.css:311` → `.input` (4 call sites: `ForecastTicket.tsx:370,425`, `CreateArenaForm.tsx:67,79`); scope `:171` to `body > main, body > footer`; scope `:264` to `a:where(:not([class]))`. | **0.3** | 3, 4 | Three one-line edits fix a defect visible on **literally every screen** — 35 labels stop rendering as input boxes, the header starts sticking, links get their colours and hover states back. Nothing else in this list changes this much per minute. |
| **2** | **Link leaderboard rows to `/profile/[userId]`.** Add `import Link` + one `<Link href={\`/profile/${r.userId}\`}>See the calibration behind this score →</Link>` inside the expanded row at `LeaderboardView.tsx:194`. | **0.3** | 1, 4, Innov | `src/app/profile/[userId]/page.tsx` is 140 lines of your most differentiating screen — calibration plot, weighted breakdown, per-call Brier squares — and **nothing in the app links to it**. Two lines makes "verifiable by design" demonstrable and makes the runbook's scripted click real. Also fires `score_explanation_opened`, an allow-listed telemetry event nothing currently emits. |
| **3** | **README header block.** Above "What it does": live URL · 2-min video link · "Try it in 60 seconds" (open /explore → record a Practice forecast with no wallet → connect Shannon 50312 → Claim test USDC → place a real order) · one hero screenshot · "Built for the Somnia × DreamDEX Event Contracts Hackathon". Plus "Requires Node 22.6+" above `npm install`, and `npm run seed -- --reset` as a Quick-start step. | **2** | 3, 4, Pres | `grep -ni "hackathon\|demo video\|judge" README.md` → **no matches**; `grep -n "!\[\|<img\|youtu" README.md` → **no matches**. For a large share of judging the README *is* the product. This is the single highest-leverage 2 hours in the list. |
| **4** | **Place ONE real order on testnet and publish the hash.** After B3: fund with native STT, faucet, small IOC buy on a quoted market, capture the hash. Add a "Proof on chain" README section with the `shannon-explorer` link, market symbol, fill, screenshot. Repeat for one `redeem`. | **1** | 1, 2, Pres | `grep -rniE "0x[0-9a-f]{64}" docs/ README.md` → **nothing**. `PRD.md:655` AC-007 requires exactly this. It is the answer to the #1 question a judge will ask, and it is the video's strongest 10 seconds. Liquidity exists: `npm run probe` reports "15/16 markets have a resting quote". |
| **5** | **Fix the four false README claims.** `:106` (SDK-only-in-dreamdex), `:122` (source of truth), `:198-199` (Postgres boundary), `:54/:56/:172/:173/:174` (test counts → **105 tests, 6 live**; drop the hardcoded workflow number entirely, it legitimately varies 79↔81 with book liquidity). | **0.5** | 2, Pres | Each is a ten-second grep away. A judge who catches one false architecture claim discounts the true ones — and the true ones are your real strength. See §6. |
| **6** | **Always recompute the viewer's score in `/api/portfolio`.** Delete the `if (settlement.settled + settlement.voided > 0)` gate at `portfolio/route.ts:23-27`. | **0.2** | 2, 3 | `runSettlement` settles **everyone's** predictions, so the first user to load any page settles the board and every other user's portfolio then finds `checked: 0`, skips the recompute, and renders the pre-settlement all-zero snapshot. Reproduced: user B's portfolio shows `composite 0, sample 0, provisional` while their actual score is `90.63, sample 5`. Two judges on one deployment = the second sees a zero. One-line fix. |
| **7** | **Hero market predicate.** At `page.tsx:59-63` require `m.expiry - now > 600` and `0.15 < upProbability < 0.85`. | **0.3** | 3, 4, Pres | Five consecutive loads gave countdowns of 0m02s, 1m53s, 0m43s, 0m34s, 0m24s. The primary CTA on the landing page routes to a contract that has already expired, and the rail is pinned against one end so the "you vs the market" argument is being made on a decided market. |
| **8** | **LICENSE + `engines` + `.nvmrc`.** MIT file (README:216-218 claims it, no file exists), `"engines": {"node": ">=22.6"}`, `.nvmrc` = `22`. | **0.2** | 2, Pres | `src/lib/db/index.ts:14` imports `node:sqlite` (Node ≥22.5) and every script runs `--experimental-strip-types` (≥22.6). A judge on Node 20 LTS gets `ERR_UNKNOWN_BUILTIN_MODULE` with nothing in the README explaining it. 11 of 23 competitor repos show a licence badge; yours will not. |
| **9** | **Arena lock guard on `/api/orders`.** Extract `predictions/route.ts:41-56` into `assertArenaWritable(arenaId, marketId)` and call it from both routes. | **0.3** | 2, Innov | Proven: after an arena locked, `POST /api/predictions` correctly returned `arena_locked`; the same arenaId via `POST /api/orders` phase=receipt **on a different market** landed a scored row. Arenas are one of your three defensible edges; a lock you can walk around is not a competition. |
| **10** | **Down-order price unit fix.** In `orders/route.ts`, convert the Up-terms `averagePrice` at the boundary: `const outcomePrice = outcome === 'up' ? avgUp : 1 - avgUp;` and use it for both `entryPrice` and `stake`. Rename the client field `averageUpPrice`. | **1** | 2 | `trade.ts:32-33` documents `averagePrice` as "in Up terms"; `route.ts:128-129` stores it as `entryPrice`, which everywhere else means the chosen outcome's own price (`demoSeed.ts:133` proves the convention). A winning Down trade is under-credited 36%, a losing one over-charged 56% — and the portfolio shows a loss **larger than the "max loss capped at the stake"** the presenter is told to say on camera (`DEMO_RUNBOOK.md:37`). |
| **11** | **Collateral + gas balance in the ticket.** `client.getErc20Balance(collateral, account)` in the ticket header; disable Review-and-sign with "Not enough collateral" below stake; warn "needs STT for gas" when native is zero; route the faucet error through `translateError` instead of `(e as Error).message.slice(0,160)`. | **1.5** | 1, 3 | `grep -rniE "balance" src/components/ src/hooks/ src/lib/wallet/ src/app/api/` returns **one comment**. `PRD.md:653` AC-005 requires it. The faucet button is itself a transaction needing gas, so a judge with a fresh wallet clicks it and gets a raw MetaMask string. This is the most likely way a judge's own 15-minute trial fails. |
| **12** | **Live spot price vs strike.** Add `priceFeed: SOMNIA_TESTNET_PRICE_FEED` to the config at `live.ts:64-69`, one adapter method `getSpot(asset)` → `client.fetchPrice(asset)`, render spot-vs-strike on the card and detail header. | **1.5** | 1, 4 | Every contract is a BTC/ETH strike question and the app shows a strike and a probability with **no way to see how far spot is from it** — the single most useful number for a forecaster. Verified: adding the one config key makes `fetchPrice("BTC")` return `{price: 78819.75, ema: 78819.94, blockNumber: 476708730}` immediately. Currently every price-feed call throws `NotConfiguredError`. Scale: `strike: 7884310` = 78,843.10, verify /100 against `fetchPrice` before shipping. |
| **13** | **`docs/DREAMDEX_SDK_FEEDBACK.md`.** The stale `clobStatus` behaviour with the 20-market evidence; the Up/Down shared-book inversion and the missing price-orientation convention in the docs; the `getBinaryBookParams`/lot-size trap; loose types in 0.28.1. Link from README, attach to the BUIDL. | **1.5** | 1, Eco | An explicitly invited optional deliverable, and **the content is already written** at `README.md:128-141` and `adapter.ts:85-93`. It is a gift to the people choosing winners, and it is direct evidence for "meaningful use of DreamDEX APIs and/or SDKs". market-dungeon already shipped theirs. |
| **14** | **Error branches on the three client screens.** `PortfolioView.tsx:48-56` (try/finally with no catch → renders `null`), `ProfileView.tsx:25-30` (permanent skeleton), `LeaderboardView.tsx:33-41` (no `.catch`, so a 500 renders as "No settled forecasts yet"). Add `if (!r.ok) throw`, a catch, and an error branch distinct from empty. Also check `res.ok` before `res.json()` in `ForecastTicket`. | **1** | 2, 3 | The leaderboard one matters most: it displays a **server failure as a truthful empty state**, which is exactly the opposite of the honest-degradation stance you take everywhere else — and it is the observed failure mode of a misconfigured deploy. |
| **15** | **Market page refresh.** A `"use client"` wrapper calling `router.refresh()` every 5s, plus once when `Countdown` hits zero. | **2** | 1, 3, 4 | `grep -rn "setInterval\|router.refresh\|useSWR\|refetch" src/` returns exactly **two** hits, both cosmetic (`NetworkBar.tsx:37`, `Countdown.tsx:14`). 6 of 16 live contracts are 1m or 5m; `/explore` advertises "Read from chain head · refreshed each request" and is a frozen snapshot. A judge who reads for a minute clicks a locked contract with a stale book and a live "Review and sign" button. |
| **16** | **English "Why this grows the venue" section** (~400 words extracted from `PRD.md` §20) + reuse verbatim as the BUIDL long description, structured on the four scored headings. | **1** | Eco (20%), Innov | Business & Ecosystem Impact is 20% of the official score and your argument for it is currently 759 lines of Indonesian. Meanwhile English Known Limitations *opens* with "Order fills need testnet liquidity." |
| **17** | **Session adoption crash.** Wrap `users.ts:64-72` in a transaction; also migrate `orders`, `arenas.hostUserId`, `arena_participants`, `score_snapshots` before the delete; handle the `idx_pred_unique` collision; wrap the `getSessionUser` call site in try/catch falling back to the anon session. | **1.5** | 2, 3 | Reproduced two ways: `FOREIGN KEY constraint failed` (anon recomputed a score, then connects an existing wallet) and `UNIQUE constraint failed: index 'idx_pred_unique'`. Every route awaits `getSessionUser` on line 1, so it is a bare 500 that **recurs on every subsequent request** with that cookie. "Practice with no wallet, then connect" is your signature onboarding claim and the first 50 seconds of the demo. The existing test at `services.test.ts:71-81` only exercises the promote branch. |
| **18** | **Degraded-state labelling.** Return `this.degraded ? "sim" : "live"` from `ResilientAdapter` (currently `index.ts:36` hardcodes `"live"`), thread a `simulated` flag onto `ArenaMarket`, swap the explore H1/lede, add a SIMULATED pill, change `LandingDemo.tsx:43`. Drop the cooldown and the health poll to 5s. Correct `DEMO_RUNBOOK.md:60` to the literal string `Degraded: serving fallback markets`. | **2** | 2, honesty | With an unreachable indexer, `/explore` renders **24 fabricated contracts** under "Live Event Contracts" / "Every contract below is open on Somnia testnet right now" with green TRADING pills. Somnia's own team is judging. If their indexer flakes and a judge sees invented BTC contracts presented as live, the honesty the README leads with is gone. |
| **19** | **Contrast + small a11y batch.** Lighten `--color-dim` (`globals.css:24`, currently 3.35:1 on panel across all 74 uses including every `<th>`); add `{label:"5m",value:"300"}` to `CADENCES` and derive the list from loaded markets; fix the asset filter erasing the other asset (`explore/page.tsx:43`); `Countdown` null-until-mounted (kills a React hydration error visible as a red "1 Issue" badge on the landing page in `next dev`); render `wallet.error` in `ForecastTicket`; collapse the two dead ternaries (`orders.ts:282`, `adapter.ts:106`); fix `probe-testnet.ts:46` printing a raw JSON blob where it promises a block number. | **2** | 2, 3 | Nine small defects a judge hits in the first five minutes, batched. `probe` is the first artefact a technical judge runs and it currently opens with what looks like a bug. |

---
### ⛔ HARD CUT LINE — everything below is dropped if you are behind at end of Day 4
---

| # | Win | Hrs | Verdict |
|---|---|---|---|
| 20 | On-chain receipt verification (`getTransactionReceipt`, assert `from`/`to`, decode fill logs) | 3–4 | Highest credibility fix in the repo, but **do the 30-minute honest-README version instead** (see §6) unless Day 7 is genuinely free. |
| 21 | Probability sparkline from `client.getCandles(pool, 60, {limit:60})` + trade tape from `getFills` | 2–3 | Most demo-visible addition available; fills the emptiest part of the market page. Only if ahead. |
| 22 | On-chain portfolio block (`getPortfolio` + `getClaimable` + `getOpenPositionsWithPnL`) beside the local ledger | 2–3 | Visible SDK-depth win, does not touch the write path. All verified answering on Shannon. |
| 23 | Redeem driven off `getClaimable` instead of `(stake/entryPrice)` with hardcoded `decimals: 6` | 2 | Also unlocks void redemption, which is currently unreachable (`PortfolioView.tsx:211` gates on `status === 'correct'`; a voided market pays 0.5:1 with no UI path). |
| 24 | Keyboard-accessible leaderboard expansion (real `<button>` with `aria-controls` + caret) | 1.5 | Criterion #3 names accessibility explicitly; currently `focusablesInTable: 0`. |
| 25 | Security headers + `secure` cookie flag in `next.config.ts` / `session.ts:37` | 0.5 | Five minutes of signal for a judge running a header scanner on the required public URL. |

---

## 5. Seven-day plan

Internal hard stop **8 Sep 12:00 UTC** — six hours of buffer before the real 18:00 UTC cutoff. A BUIDL lands in "In review" and needs organiser verification before it appears publicly; submitting at T-2h leaves no room for that round-trip. **Register as Hacker today** — it is a separate action from Submit BUIDL.

**Mon 1 Sep — ship the repo, then the free wins (≈5 h remaining today)**
`.gitignore` (B1) → `git init` + thematic commits + public push + description/topics (B2) → LICENSE/engines/.nvmrc (win 8) → register as Hacker on DoraHacks → CSS layer fixes (win 1) → leaderboard→profile link (win 2) → hero predicate (win 7) → portfolio recompute (win 6).
*End state: a repo a judge can open, and four screen-wide defects gone.*

**Tue 2 Sep — the write path (≈7 h)**
B3 in full: `getBinaryBookParams` cached per pool, `quoteBinaryStakeOverBook`, `slippageForCrossing`, regenerated `REVERTS` table, a test asserting `fromHuman(preview.contracts, decimals) % lotSize === 0n`. Then fund a wallet with native STT, faucet, **place one real order, capture the hash**, redeem one position, capture that hash (win 4). Down-order unit fix (win 10).
*End state: the product's headline action works and you have two explorer links.*

**Wed 3 Sep — deploy (≈7 h)**
B4: Railway/Render with a volume, env, seed, cold incognito verification with a fresh wallet, `metadataBase` pointed at the real host. Then B6 (leaderboard credential leak), win 9 (arena guard), win 14 (error branches).
*End state: a URL a judge can open, and no session tokens in the JSON.*

**Thu 4 Sep — demo truth + the last correctness batch (≈7 h)**
B7 (seeded PRNG, stakes for the two archetypes, runbook rewritten from the real board). Win 11 (balance + gas), win 15 (market page refresh), win 17 (session adoption crash), win 18 (degraded labelling), win 19 (the a11y batch).
**⛔ Decision point: if anything from Mon–Thu is unfinished at the end of today, stop coding. Drop wins 20–25 and everything unstarted, and spend Fri–Sun entirely on Days 5–7. The submission requires a repo, a URL and a video; nothing in the cut-line list is worth missing those.**

**Fri 5 Sep — writing and assets (≈7 h)**
README rewrite (win 3) including the "Proof on chain" section with Tuesday's hashes and corrected claims (win 5). Four screenshots into `docs/screenshots/` (rail with the slider dragged; settled forecast with the square at the outcome; leaderboard mid-toggle with Skill and Profit disagreeing; the calibration plot). Square logo + confirm the OG route resolves on the live host. `docs/DREAMDEX_SDK_FEEDBACK.md` (win 13). English ecosystem section (win 16).

**Sat 6 Sep — record (≈6 h)**
Capture the three fallback stills first. Rehearse twice against the deployed URL. Shoot 2:00–2:59. Budget a full re-shoot: testnet windows roll, and all cadence-mates share one expiry to the second, so pick your primary and fallback contracts by **different displayed countdowns**, not by different cadence labels. Edit, upload Unlisted.

**Sun 7 Sep — submit (≈5 h)**
Fill and **submit the BUIDL early in the day**: logo, tagline, long description on the four rubric headings, repo link, live URL, video link, SDK feedback doc. BUIDLs stay editable after submission. Then ping the hackathon dev group to confirm verification cleared. Remaining time: cut-line items 20–25 in order, redeploying as you go.

**Mon 8 Sep, until 12:00 UTC — verification only. No code.**
Clean-machine clone test. Deployed URL in a fresh incognito profile with an unfunded wallet. Video link opens logged-out. BUIDL is out of "In review". Every number in the README matches what the commands print.

---

## 6. What to say — and what to stop saying

### The four strongest claims you can make, and each is true

**1. On criterion #1 — the SDK trap you found and handled.**
> "The DreamDEX indexer's `clobStatus` is event-derived, and the Listed→Trading→Settling transitions emit no event — so an expired contract still reads 'Trading'. All 16 live markets report 'Trading' from the indexer right now. We derive status from the clock instead, in `deriveStatus`, and unit-test it. And we never let the indexer authorise a write: `getOnchainState` is the one method that is never simulated, because it decides whether a real order may be sent."

Verified: `adapter.ts:95-109`, `tests/dreamdex.test.ts:14`, `index.ts:80-83`. This is the most credible evidence of real integration you have — it is knowledge you could only get by hitting the chain.

**2. On trust — say this exactly, it survives an exhaustive grep.**
> "No private key is ever read, stored or configured anywhere in this project. Every write is signed in the browser by the user's own wallet. The server builds an order intent; it never signs one."

Verified: no `PRIVATE_KEY`, no `privateKeyToAccount`, no mnemonic in `src/`, `scripts/` or `tests/`; all three write paths use `createWalletClient({ transport: custom(ethereum) })` (`trade.ts:52-59, 118-125, 163-170`); `orders/route.ts:71-85` returns an intent object.

**3. On the scoring kernel — the maths is genuinely right and it is your differentiator.**
> "The scoring module is pure — one type-only import, no clock, no I/O — so a score cannot move because a page refreshed. And no single contract can dominate a profile: the 30% market-share cap is a fixed point, `T = Σ(uncapped) / (1 − |C| × share)`, not a naive `cap/k`. We brute-forced every count vector up to 6 markets × 10 forecasts plus 200,000 random vectors and found zero cap violations."

Verified: `scoring/index.ts:9` is the only import; `:104-123` is the fixed point; the brute force found `worst over-cap share: 0`. **One qualifier is required** — `:99` relaxes the cap to `Math.max(0.3, 1/counts.size)`, so say *"across at least four distinct contracts"*. The unqualified sentence currently on screen at `LeaderboardView.tsx:213-215` is false for a 1-, 2- or 3-market profile.

**4. On ecosystem impact — the claim nobody else in this field can make.**
> "This is the only place you can be scored on a live DreamDEX Event Contract with no wallet, no capital and no signature. Practice mode is a real forecast against a real contract, settled by the real oracle, and it costs nothing to enter — then the same instrument converts you into a signed Event Contract order."

Lead with this, not with "we score calibration." Three other entries in this field ship calibration scoring; ProofCast's stated thesis is nearly word-for-word your README's opening. The *access path* and the *single instrument* are what is actually yours.

### Stop saying these — each is false or unbacked

| Claim | Where | Status |
|---|---|---|
| "`src/lib/dreamdex/` is the only place that imports the SDK" | `README.md:106` | **False.** `wallet/trade.ts` imports it 6 times across 2 entry points and uses `ORDER_TYPE`, `probabilityToPrice`, `fromHuman`, `toHuman`, `SOMNIA_TESTNET_ADDRESSES` directly. Your own diagram at `:86-91` draws this correctly. Replace with: *"The SDK is imported in exactly two places: `src/lib/dreamdex/` for every server-side read, and `src/lib/wallet/trade.ts` for the browser write path — where it must be, because the order is signed by the user's wallet and no key ever reaches the server."* That version is true, matches the diagram, and is more impressive. |
| "Source of truth. Chain state decides orders, fills, settlement and redemption." | `README.md:122` | **False for orders and fills.** `orders/route.ts:99-100` takes `filledQuantity`, `averagePrice` and `txHash` verbatim from the request body. Proven: one unauthenticated curl recorded `"filledQuantity":999999, "txHash":"0xFAKE_NEVER_HAPPENED", "status":"filled"` — a hash that is not even valid hex — and the portfolio renders it as a live explorer link (`PortfolioView.tsx:164`). Say instead: *"Chain state decides settlement and redemption. Orders and fills are recorded from the receipt the browser decodes and are not yet re-verified server-side — that is the next thing we would build,"* and put it in Known Limitations. |
| "swapping in Postgres touches `src/lib/db/` only" | `README.md:198-199` | **False.** 35 raw `.prepare()` statements across 8 service files, all importing `DatabaseSync` from `node:sqlite` — which is synchronous, so the swap would force `async` through the whole service layer. Naming the trade-off deliberately reads as judgement; claiming a boundary that is not there reads as not knowing your own codebase. |
| "103 tests (5 live) · 79 workflow checks" | `README.md:54,56,172,173,174` | **Wrong.** Measured today: `Tests 99 passed | 6 skipped (105)`. It is **105 tests, 6 of which hit live Shannon**. Drop the hardcoded workflow number entirely — it legitimately varies between 79 and 81 depending on whether the sampled contract has a two-sided book (`workflow-test.ts:129`). |
| "the Overconfident Punter tops the profit board and sits fourth on skill" | `DEMO_RUNBOOK.md:45-47` | **False in 5/5 live runs.** Fix the seed first (B7), then rewrite the line from the board that seed actually produces. |
| "Click a row → *See the calibration behind this score* → the plot" | `DEMO_RUNBOOK.md:46-48` | **That interaction does not exist.** `grep -nE "Link\|href\|/profile" src/components/LeaderboardView.tsx` → nothing. Ship win #2 or rewrite the beat. |
| "The banner turns red and reads 'DEGRADED — showing fallback markets'. Simulated data is labelled as simulated, on every screen." | `DEMO_RUNBOOK.md:60` | ~~Wrong string and wrong claim.~~ **Now true, and the runbook quotes the literal strings.** Degraded mode shows a solid red `SIMULATED DATA` bar, the strip reads `SIMULATED DATA — not Somnia testnet`, and the pill is on every card, the market page, the portfolio and the profile. See §0. |
| "Your calibration becomes a record anyone can open and check" / "Verifiable by design" | landing copy, PRD principle | **Unbacked.** Identity is an unsigned `x-wallet-address` header (`session.ts:41-44`, validated only against `/^0x[0-9a-fA-F]{40}$/`) and fills come from the browser. Until you ship SIWE or on-chain receipt verification, say *"auditable against chain settlement"* — not that the record itself is verifiable. Two competitors were built to beat exactly this claim. |
| "Read from chain head · refreshed each request" | `explore/page.tsx:49` | ~~Reads as live; it is a static per-navigation snapshot.~~ **Now true.** The eyebrow reads *"Chain head · re-read every 5s"* and `LiveRefresh` makes that literally so, with a visible age that would climb rather than reset if the route were ever answered from a cache. |
| "MIT" | `README.md:216-218` | No LICENSE file exists. Add the file. |
| "we deploy **no contract of our own**" | `DEMO_RUNBOOK.md` | Do not volunteer this to a Somnia judge in a field where LevelField, ProofCast, oraclelane and rampart all have on-chain footprints. Reframe forward: *"No new trust assumptions — every write is a DreamDEX Event Contract order signed by the user's own wallet. We added no custody, no token and no oracle of our own."* |
| AC-005 "user can see their testnet balance" | `PRD.md:653` | Not implemented — a grep for `balance` across components/hooks/wallet/api returns one comment saying the portfolio is *not* a balance sheet. Either ship win #11 or stop citing AC-005 as met. |

---

## 7. Judge Q&A — the eight questions that will hurt

**Q1. "Show me an order this app actually placed on chain."**
*Today:* You cannot. No tx hash exists in `docs/` or `README.md`, and until B3 lands every order reverts `InvalidQuantity` because `orders.ts:108` never reads `lotSize`. *After Tue:* Open `shannon-explorer.somnia.network/tx/<hash>` from the README's "Proof on chain" section. **Do not attempt this question without doing win #4.**

**Q2. "What stops me POSTing a fake fill to your leaderboard?"**
*Honest answer:* Nothing today. `src/app/api/orders/route.ts:99-100` reads `filledQuantity`, `averagePrice` and `txHash` straight from the body, and `validatePreview` — which enforces `MAX_STAKE = 500` — runs only on the intent branch at `:57`, not the receipt branch. `submitPrediction` at `:122-131` then turns it into a scored trade. *What to say:* "The write is real and user-signed; the receipt is currently taken on trust from the browser that decoded it. Verifying it server-side with `getTransactionReceipt` plus the SDK's `orderBookEventsAbi` is the next thing we would build, and we say so in Known Limitations." **Say this before they find it.**

**Q3. "Your README says only `src/lib/dreamdex/` imports the SDK. What is `wallet/trade.ts:47`?"**
Fix the sentence (win 5) and this becomes your best answer instead of your worst: two import sites, one per side of the trust boundary, because the key never reaches the server.

**Q4. "This contract settled ten minutes ago. Where is this order book coming from?"**
*Honest answer:* A pool-address cache that is never invalidated. `live.ts:184-193` resolves `marketId → poolAddress` from a `Map` written once at `:129-135` and never evicted, then calls the pool-keyed `getBinaryOrderBook`. Shannon recycles pools hard — 63 of the last 200 past markets sit on a pool currently serving a *live* market, and one pool has served 20 different markets. So a settled market's page can render a different market's live depth. The SDK warns about this twice (`markets.d.ts:281-285`). *Cheap mitigation before the demo:* gate `getOrderBook` on `status === 'trading'` and render a "settled — book closed" state.

**Q5. "It's a 1-minute contract and the page hasn't changed in ninety seconds."**
*Honest answer:* There is no client-side refresh anywhere — `grep -rn "setInterval\|router.refresh\|useSWR" src/` returns two hits, a 1s local clock and a 20s health poll. Every page is one `force-dynamic` server render. *What to say after win 15:* "The page re-reads chain head every five seconds and flips to the locked state the moment the window closes." *What not to say:* the current `/explore` eyebrow, "refreshed each request."

**Q6. "Your ticket quoted me 250 contracts and I got 200."**
*Honest answer, pre-fix:* `buildPreview` divides the whole stake by top-of-book with no book walk. Measured on live pool `0x3bf5a438…` with asks `0.318×200, 0.333×330, 0.338×460`, a 100 tUSDC stake previews 314.47 contracts against 200 resting — a 57% overstatement, and the IOC cancels the rest. *After B3:* "We quote with the SDK's own `quoteBinaryStakeOverBook`, so the number on the ticket is what the book will actually fill, snapped down to a whole lot and padded with a two-tick protective limit."

**Q7. "You've used seven of the SDK's 190 client methods and none of the realtime tier. Why?"**
*Honest answer:* "We spent the budget on getting the read path right rather than wide — the stale-`clobStatus` derivation, the Up/Down single-book inversion, the bytes32 `marketId` breaking change in 0.13.0, and a chain-head gate on every write that we deliberately never route through the fallback. `watchMarkets` and the price feed are the next two things, and we know exactly where they go." Then hand them `docs/DREAMDEX_SDK_FEEDBACK.md` — this question is your opening to the sponsor.

**Q8. "You deployed no contract. What of yours is actually on chain, and how do I know this leaderboard is real?"**
*The hardest one, because two competitors were built to answer it better.* Honest answer: "Nothing of ours is on chain. Every order is a DreamDEX Event Contract order signed by the user's own wallet — we added no custody, no token, no oracle. The forecast record is tamper-proof against backdating: `submittedAt` and the market snapshot are both taken from a server-side adapter read (`predictions.ts:118-139`), there is no UPDATE path on predictions outside settlement, and settlement is idempotent by construction. What is *not* yet verifiable is the identity binding — the wallet arrives as a header — and that is our top post-hackathon item." Do not oversell. If you have a spare half-day on Day 7, a ~40-line commitment contract storing `keccak(wallet, marketId, side, confidence, timestamp)` converts this from your weakest answer into your strongest — but only after everything above the cut line ships.

**Bonus, likely:** *"What happens if I connect the same wallet in a second browser?"* → today, an uncaught 500 that recurs on every request with that cookie (`users.ts:64-72`). Fix it (win 17) — it is your signature onboarding flow.

---

## 8. Do not bother

- **Full EIP-4361 / SIWE authentication.** ~4 h and it touches `session.ts`, `useWallet.ts`, a nonce table and every route. Do the 30-minute version instead: drop `userId` from the leaderboard payload, truncate the wallet server-side, and soften the verifiability claim in the README. Same credibility per judge-minute, one-eighth the cost.
- **The SDK realtime tier (`watchMarkets` + the 30 React hooks).** The highest-scoring thing on the SDK-depth list, and a 4–6 hour rewrite of the market page into a client component under `SomniaMarketsProvider`. A 5-second `router.refresh()` gets ~80% of the visible benefit for 2 hours (win 15). Mention the realtime tier as the roadmap in the video instead — you know exactly what it does and that shows.
- **Translating the 759-line Indonesian PRD.** Extract 400 English words of §20 (win 16), add one English line at the top of `PRD.md` labelling it the internal spec, and leave it. Framed that way it reads as rigour.
- **A presentation deck.** Explicitly optional. Its entire content survives inside the video narration. Zero marginal points against seven days.
- **Postgres / a repository abstraction.** 35 raw SQL statements across 8 files plus a sync→async conversion of the whole service layer. Fix the *sentence* (win 5), not the architecture.
- **Sell-side, cancel/amend, mint/merge.** Half the Event Contract lifecycle is genuinely absent and it is a real depth gap, but "Close position" alone is 3+ hours and every hour is better spent making Buy actually work.
- **Rate limiting, request-size caps, `POST /api/settle` hardening.** Real code-quality gaps, zero judge exposure in a 15-minute local or hosted trial. Do add the five-minute security headers (`poweredByHeader: false`, CSP `frame-ancestors 'none'`, nosniff, Referrer-Policy) if a scanner is a worry.
- **`npm run lint`.** It hangs on an interactive ESLint config prompt because there is no eslint dependency at all (reproduced: `EXIT=124` after 45s in a pty), and pressing Enter would npm-install eslint into the judge's clone. But `lint` is the script a 15-minute judge is least likely to run. If you want it gone in 60 seconds, change `package.json:10` to `"lint": "tsc --noEmit"`.
- **Reworking the arena lifecycle** (`locked` is unreachable because `locksAt === endsAt`; `refreshArenaStatus` is dead code; `arenas.status` is permanently `'open'`). Real, but invisible unless a judge reads `arenas.ts`. Ship the **write-path guard** (win 9) — that one is reachable and exploitable — and leave the state machine.
- **Reworking `consistencyScore` to honour the cap, or wiring `MIN_MARKETS_FOR_CAP`.** Half a day of scoring surgery. Instead, add four words to the on-screen sentence: *"across at least four distinct contracts."* Precision costs nothing; overstating a genuinely good thing is worse than stating it precisely.
- **Rewriting the leaderboard as mobile cards.** Half a day. Judges will mostly open the live URL on a desktop after watching the video. If you want the phone case covered cheaply, drop to three columns below `sm` and put the rest in the expansion.