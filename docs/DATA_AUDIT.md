# Data reality audit — 2026-09-07

Four adversarial auditors were asked to PROVE that a page renders fabricated
data, and to trace every number to one of four acceptable origins: an on-chain
read, the DreamDEX indexer, a database row written by a real event, or a
measured constant recorded in docs/. Source inspection alone was not accepted —
each auditor had to check what renders after hydration, because an earlier
audit was fooled by exactly that.

**Nothing invented was found.** No fabricated agent, no synthetic user, no
hardcoded metric, no literal data array. Every figure traced to a real origin.

What they did find is presentation: figures that assert more than the app
measured. Those are listed below with what a visitor actually saw.

## [misleading] / — Live meta-markets (feature panel + every row). src/lib/dreamdex/live.ts:129, consumed at src/app/page.tsx:169, rendered by src/components/OverviewMarkets.tsx:65-69 (depthOf), :178 and :208

**Rendered:** "Book 1 contracts" under the feature panel, and "1 contracts" in each market row's meta line.

**Why it is not real enough:** bookDepth is not a size. live.ts:129 is `bookDepth: hasQuote ? 1 : 0`, where hasQuote = (bestBid !== null || bestAsk !== null). It is a boolean printed with a quantity unit. Captured live at 07:23 UTC, market 0x…15ae9 (Neural Drift) had upAsks 30.257+30.395+30.581 and downBids 30.257+30.395+30.581 = 182.5 contracts resting across the book, and the page said "1 contracts"; 0x…15aec had ~163 and also said "1 contracts". live.ts's own comment concedes "Depth needs the full book; the batched top-of-book read cannot see it… the detail page fills this in from the chain-head read" — but getMarket() (live.ts:217-228) returns toArenaMarket() unchanged, so nothing ever fills it in and the Overview consumes the flag raw. Not (a),(b),(c) or (d): no read anywhere measures this number.

## [misleading] / — Live meta-markets, same depthOf. src/components/OverviewMarkets.tsx:66 (the `row.bookDepth === null` branch shares a string with the `<= 0` branch)

**Rendered:** "no resting orders" on all three market rows and on the feature panel — the current live state of the front door as of 07:26 UTC.

**Why it is not real enough:** This is the fallback that renders when the fetch fails. Session-4 contracts 0x…15bcf / 15bd0 / 15bd1 had just minted; `curl localhost:3009/api/markets/0x…15bcf` returns HTTP 404 {"error":"That Event Contract is not on the module."}. So `market` is null, page.tsx:169 sets bookDepth to null, and the page asserts a positive fact about a book it never saw. A visitor is told there are no resting orders on three markets the app could not read at all.

## [misleading] / — Agent leaderboard "NAV now" column. Header src/components/OverviewBoard.tsx:146, value :207; source standings().currentNav → latestNavPoint() at src/lib/services/agentSessions.ts:473-478 (no staleness bound); written only at src/lib/agents/orchestrator.ts:128 and :237

**Rendered:** At 07:22 UTC: "NAV now 206.12" for Alpha-Z — while the Live meta-markets panel on the same render, ~400px above, said "Vault cash 10.00".

**Why it is not real enough:** Both figures are BotVault.nav(). I confirmed nav() == protocolCash at contracts/BotVault.sol:233, so they are the same quantity. One is a live chain read (vaultState.ts:82 → chain.ts:795); the other is an agent_nav_points row written 92.9 minutes earlier (at = 1788760386620, render at 1788765958407), at the close of the *previous* session. NAV samples are only ever written at registration and at session close, so the column is exact for a moment after a keeper cycle and then drifts by up to the agent's whole deployed capital while the label still says "now". The page contradicts itself on one screen by a factor of 20.

## [misleading] / — metric strip, "Meta-markets live" tile subtitle. src/app/page.tsx:216 (capital = sumRaw(board.map(s => s.currentNav))) rendered at :293

**Rendered:** "506 tUSDC in vaults" at 07:22 UTC; "297 tUSDC in vaults" at 07:26.

**Why it is not real enough:** Same stale source as the NAV now column — the sum of the three latest agent_nav_points rows, not a vault read. At 07:26, immediately after a keeper cycle, it matched my own eth_calls to the cent (178.368018 + 108.778016 + 10.000007 = 297.146). At 07:22 it counted 206.12 for Alpha-Z while the same page's live read of that vault was 10.00, so the headline overstated capital in vaults by roughly 196 tUSDC on one of three agents. The number traces to (c), but the label "in vaults" claims a present-tense chain fact the row does not carry.

## [misleading] / — metric strip "Sessions settled" (src/app/page.tsx:214, rendered :296) versus the leaderboard's "Settled" column (src/components/OverviewBoard.tsx:145 header, :205 value, backed by agentStandings.ts:18-20)

**Rendered:** The tile says "Sessions settled 5". The Settled column directly below reads 3, 2, 3 — which sums to 8.

**Why it is not real enough:** The tile counts only status === 'settled'; the column counts sessionsRun, which is (finalized || settled) && !voided. The three session-3 rows are currently 'finalized', so they are in one number and not the other. Both trace to agent_sessions, so neither is invented — but the two carry the same word on the same screen and disagree by 3, and nothing on the page tells a reader which definition of "settled" is in force.

## [misleading] /agents leaderboard — src/components/AgentBoard.tsx:217, :241-242, :517, :590-594 (value from src/lib/services/agentStandings.ts:71)

**Rendered:** Headline stat card "Capital in vaults 506.22 / tUSDC, measured as nav()", and a "NAV" column reading 100.01 (Neural Drift), 206.12 (Alpha-Z), 200.08 (Kestrel 7), under a footnote "NAV is the vault's nav()". At the same instant I read the three vaults directly: nav() = 10.000018, 10.000007, 10.000016 — a real total of 30.00 tUSDC, not 506.22.

**Why it is not real enough:** `AgentStanding.currentNav` is `latestNavPoint()` — the newest row in `agent_nav_points`, which the keeper writes only at provisioning and at session close (src/lib/agents/orchestrator.ts:128 and :237). So the number is a real measurement (origin c), but it is the value at the last session boundary, which was 90 minutes stale at render time, while the label "measured as nav()" and the footnote assert it is the vault's current nav(). The board already has a live chain figure in hand for exactly these agents (`vaults` from /api/agents/sessions, used two cards higher up as "CASH NOW 10.00"), so the page shows 10.00 and 206.12 for the same quantity in two places. Overstated by ~16.9x at the moment of measurement.

## [misleading] /agents/[slug] NAV chart — src/components/AgentNavChart.tsx:119, :135-137, :213-222

**Rendered:** On all three live profiles: a green headline "206.12 tUSDC" (Alpha-Z) / "100.02" (Neural Drift) / "200.09" (Kestrel 7), and the caption "The dashed line is the NAV this session opened at. Above it by 0.00 tUSDC right now — the meta-market pays the Up side if it closes here."

**Why it is not real enough:** `last` is the newest `agent_nav_points` row and `reference` is `live.navT0`; for an open session those are the same integer, so delta is always exactly 0.00, `rose` is always true, and the caption always says the Up side pays. The words "right now" are not traceable to anything current: the same page's hero, 300px above, printed the live chain read of 10.00 tUSDC — 196.12 below the baseline. The chart is asserting a present-tense settlement verdict from a sample taken at the previous session's close. Underlying points are real (origin c); the temporal claim and the Up/Down verdict are not.

## [misleading] /agents/[slug] hero readout — src/components/AgentProfile.tsx:153 (`navNow = liveVault?.cash ?? chain?.nav ?? latestPoint?.nav ?? standing.currentNav`), rendered at :228-246

**Rendered:** When the vault read fails or times out, the 40px hero reads "Cash · nav()  178.36 tUSDC" with a 9px sub-line "last sampled Sep 7, 03:25 PM" — while the session card directly below correctly renders "Cash now · nav() —" and "Markets traded —". 178.36 is exactly session 4's navT0, so the page prints the opening figure as the current one: the documented navT0-twice bug, re-entered through the fallback chain.

**Why it is not real enough:** I reproduced this rather than inferred it: I started the same production build on port 3010 against a dead RPC (SOMNIA_RPC_URL=http://127.0.0.1:9) with a copy of the database, and rendered /agents/alpha-z in headless Chrome. `detail.vault` came back null, `detail.chain` is always null (the route at src/app/api/agents/[slug]/route.ts:88-101 never emits a `chain`/`reading` key), so the expression falls through to `latestPoint.nav`. The board handles the same failure honestly ("— CASH NOW" plus "No live cash figure right now — the vault did not answer this read"); the profile hero does not. The number itself is a real sample, but it renders under a live label with only a small timestamp to disclose it, and during a longer keeper or RPC outage it would keep rendering at 40px indefinitely.

## [misleading] /agents leaderboard stat card — src/components/AgentBoard.tsx:234-237

**Rendered:** "Sessions open 3 · taking bets right now" while, in the same paint, all three Open meta-market cards below showed "closes in awaiting settlement" — i.e. every one of those sessions' windows had already expired (closesAt 1788765815000/…826000/…836000 vs a render at 1788765833372).

**Why it is not real enough:** The phrase is driven purely by `live.length > 0`, which counts DB status in {pending, open, closing}, and never consults `closesAt`. Between a session's close and the keeper's next pass — or for the whole duration of a keeper outage — the page asserts markets are taking bets when their trading window has ended, and keeps an "Open the contract" CTA beside it. The count 3 is real; the sentence attached to it is not derived from anything.

## [misleading] /audit — src/app/audit/page.tsx:214-231 (live trade rows), :221 (subject), :226 (result), :240 (liveTx counter); root cause bots/runner.ts:933-971

**Rendered:** Right now on the live page: `2026-09-07 07:31:54 UTC | placeBinaryOrder | Buy YES 0 · ETH-1h@08:00 | 0x1ed8e0…4dc1 | cash delta not measured`, with the call name hyperlinked to shannon-explorer. At my 07:22 capture five such rows were on screen: `Buy NO 18 · BTC-5m@06:00` (0x849cab…1bf5), `Buy NO 17 · BTC-5m@06:00` (0xc5d237…21ec), `Buy YES 22 · BTC-1h@07:00` (0x1aeb14…0be2), `Buy NO 32 · ETH-1h@07:00` (0x543642…0376), `Buy NO 0 · ETH-1h@07:00` (0x711432…acf1). Each is styled with tone `cyan`, identical to a successful order.

**Why it is not real enough:** Every one of these transactions REVERTED. eth_getTransactionReceipt on 0x1ed8e0904dfb65c2401725c510ab41a2e1df8709b78b665fb0c72d2ab5614dc1 returns status 0x0; same for 0x15509eba1655…, 0x849cabd1…, 0xc5d237ef…, 0x1aeb14e7…, 0x5436424c…, 0x711432b9…, 0x4d9a938b…. No Traded event was emitted and no order exists on chain. The quantity in the subject (`18`, `17`, `22`, `32`) is the size the bot REQUESTED, read from agent_trades.quantity — it has no on-chain origin at all, it is the runner's intent. bots/runner.ts calls waitForTransactionReceipt at :933 and never inspects receipt.status; it posts the trade to /api/agents/[slug]/trades regardless (:971). The absent Traded log is what makes cashDelta null, and the page turns that into 'cash delta not measured' — which reads as a measurement gap, not a failure. In the DB the invariant is exact: all 6 rows with cashDelta IS NULL at my snapshot were the 6 reverted receipts out of 127 hashes checked. The page's headline 'Transactions you can open — 170 · 7 from the verified trail · 163 from this deployment' counts them as openable evidence.

## [misleading] /explore (all cards) and /market/[id] — src/lib/dreamdex/live.ts:97-99, rendered by src/components/ProbabilityRail.tsx:61 and src/app/market/[id]/page.tsx:114-122

**Rendered:** 6 of the 8 cards on /explore right now show a confident split — BTC-24h "Up 14% / 86% Down", BTC-1h "16%/84%", ETH-1h "35%/65%" — with the rail marker planted at that point and the screen-reader label "Market implies 14 percent Up, 86 percent Down". All six have bestBid=null AND bestAsk=null, i.e. a completely empty book, and each card's own footer says "no resting quote" directly beneath the number. On /market/[id] the same value renders as a 3xl heading under the label "Implied by the book", whose sub-line simultaneously reads "no two-sided quote".

**Why it is not real enough:** The number is real — it matched the indexer to 1e-9 — but it is NOT the book. `upProbability = mid ?? last` falls back to `BinaryMarket.lastPrice`, the last executed trade. With bookDepth 0 there is nothing implying anything, so "Market implies" and "Implied by the book" misdescribe the value's origin. Nothing on screen dates it: I read `lastTradeAt` off the indexer and the prints were 383s to 4,966s old (BTC-24h's 14% is an 83-minute-old trade). The indexer also returns lastTradeAt, tradeCount and cumulative volume; the app renders none of them. live.ts:96 states the FR-014 intent — never render a made-up midpoint — and that holds for never-traded markets, but a market that traded once and then emptied gets a firm reading with no provenance and no age.

## [misleading] /privacy — src/app/privacy/page.tsx:32-37 and 42-48

**Rendered:** "This app used to set a session cookie and keep a row per forecaster… The cookie, the user table and the product-analytics table were removed rather than left empty." and "What the database does hold: One index over public chain activity…"

**Why it is not real enough:** False about the deployed artifact. FORECAST_ARENA_DB=.data/forecast-arena.db is the exact file the running server opens, and it still contains the retired product's tables, not empty: users 10 rows, telemetry 54 rows (31 leaderboard_viewed, 14 portfolio_viewed, 5 order_previewed, 2 score_explanation_opened, 1 prediction_submitted, 1 order_failed), predictions 1, orders 1, score_snapshots 2, plus arenas and arena_participants. Two user rows carry real wallet addresses — 0x71a89a7e…87bae (the same address that owns all three agents) and 0x264f4635…7b80 — so the page tells a visitor no per-person row exists while the shipped database holds ten of them with two wallets attached. "One index over public chain activity" is likewise not all the file holds. Mitigating and worth stating plainly: I grepped src/, scripts/ and bots/ and NO code reads these tables, lib/db/index.ts no longer creates them, and no page renders a byte of them — so this is a false factual claim rather than synthetic data reaching a visitor.

## [misleading] /explore — src/app/explore/page.tsx:104 (the live-mode lede)

**Rendered:** "Every contract below is open on Somnia testnet right now, soonest to expire first. The rail shows what the market implies; the band on it is the bid-ask spread. Every order behind those numbers was signed by an agent."

**Why it is not real enough:** The final sentence is a provenance claim about third-party order flow that this app cannot verify and does not read from anywhere. The contracts on /explore are DreamDEX's own BTC/ETH venue series — the app says so itself two clicks away in MarketObserverPanel.tsx:133 ("This is a DreamDEX venue contract, not one this project minted"). The resting orders and last trades behind those probabilities were placed by whoever trades that public venue; this project's bots are some of them, not provably all. Nothing in the adapter reads order authorship, there is no such claim in ONCHAIN_EVIDENCE.md or DREAMDEX_SDK_FEEDBACK.md (I grepped both), and it is not derivable from (a)-(d). It is the one sentence on the live board that asserts a fact about data the app never fetched.

## [unclear] / — market question, src/app/page.tsx:163-165, rendered into the <h3> at src/components/OverviewMarkets.tsx:125 and the row copy at :204

**Rendered:** Right now: "Will Alpha-Z close session 4 with a higher NAV?" on all three rows. Twenty minutes earlier the same slot rendered the contract's real question, "Will agent Alpha-Z close session #3 with a higher NAV?"

**Why it is not real enough:** When the market read returns null the page writes its own question string and renders it in the identical slot with no marker. The two wordings differ (the real one carries "agent" and "#"), so I can tell them apart by diffing renders — a visitor cannot. The condition it states is honest, but its provenance is a local template, not the contract's `question` field, and this state persists for the whole mint→index window.

## [unclear] / — Live meta-markets feature panel, "N markets traded". src/components/OverviewMarkets.tsx:154-159; source src/lib/agents/vaultState.ts:82 (touchedCount: v.touched.length ← touchedMarkets())

**Rendered:** "7 markets traded" at 07:22 (inside the SESSION 03 panel); "1 market traded" at 07:26 (inside the SESSION 04 panel).

**Why it is not real enough:** The value is a genuine chain read, but it is not a per-session count. contracts/BotVault.sol:150-168 shows openSession() *compacts* the touched list rather than clearing it, deliberately retaining any market with an unredeemed outcome-token balance from an earlier session. Rendered with no session qualifier inside a panel headed SESSION 03 / SESSION 04, it reads as this session's trade count and can include carryover legs.

## [unclear] / — leaderboard sparklines. src/components/NavSpark.tsx:41-79 (geometry), :88-99 (NavSpark), fed from src/app/page.tsx:191

**Rendered:** At 07:22 all three agents rendered a byte-identical path: M0.00 4.00 L59.00 4.00 L118.00 36.00 — the same curve for a 0.00, a −43.87 and a −49.91 record. At 07:26 the three differ only in one middle vertex (L78.67 23.60 / 24.00 / 15.31) and still share both endpoints exactly.

**Why it is not real enough:** The values are real (each matches agent_nav_points, and those match my own eth_call to nav()), so this is not the design's hardcoded squiggle — but geometry() min-max normalises per series, pinning the first sample to y=4 and the lowest to y=36 on every row forever. The curve therefore carries no magnitude and no cross-agent comparison, while sitting in the "Net NAV change" cell where a reader will read it as both. Separately, all 12 rows of agent_nav_points have blockNumber = NULL, because both recordNavPoint call sites (orchestrator.ts:128, :237) omit it: the x-axis is Date.now() on the app server, not block time, and the point is not independently re-derivable — which page.tsx's own comment ("a read of BotVault.nav() at a block") claims it is.

## [unclear] / — "Why this matters" card (src/app/page.tsx, point 01 paragraph) and the sidebar rail note (src/components/AppShell.tsx:154-155)

**Rendered:** "…one NAV number pinned by two published block numbers." and "NAV is one number anyone can re-derive from two published block numbers."

**Why it is not real enough:** Nothing on this surface or in the database publishes a block number. agent_sessions has no block column; agent_nav_points.blockNumber is NULL on all 12 rows; readOracle (chain.ts:825+) returns navT0/navLive/closesAt and no block. What is actually published is a transaction hash (openTx/finalizeTx), from which a block is derivable on the explorer — a defensible claim, but not the one the copy makes, on the page whose whole argument is checkability.

## [unclear] /agents copy — src/app/agents/page.tsx:78-79; the block-number rendering it promises is src/components/AgentNavChart.tsx:227-232 and src/components/AgentProfile.tsx:155, :244

**Rendered:** "What is worth something is a number a stranger can read off the chain: the vault's own NAV at two published block numbers, with the contract that produced it deployed in the open." No block number is rendered anywhere on the agent surface.

**Why it is not real enough:** `agent_nav_points.blockNumber` is NULL for 12 of 12 rows, because both `recordNavPoint` call sites (src/lib/agents/orchestrator.ts:128 and :237) omit the field. So the chart's "block A → B" line and the profile's "· block N" suffix are unreachable, and the page's central verifiability claim is not backed by anything it publishes. Related residue: the fabricated design's "Block 8,412,093" survives verbatim as the worked example in the JSDoc of both `blockLabel` helpers (AgentNavChart.tsx:36, AgentProfile.tsx:45) — comment only, never rendered.

## [unclear] /settlement — src/app/settlement/page.tsx:108-110 (settled/voided counters), :400-440 ("Why a market voids" card); /audit — src/app/audit/page.tsx:239-240, :277-284 ("from this deployment")

**Rendered:** Settlement stat card: `Resolved / void  5 / 1`, directly above an insight card titled "Why a market voids, and what we did about it". Audit overview: `163 from this deployment`.

**Why it is not real enough:** Both counters describe the SQLite journal, not this deployment's chain history, while the labels ("this deployment", and a void count sitting under a heading about voids) read as the chain. Querying the DreamDEX indexer for asset BOTNAV returns 19 markets on THIS project's operator 20 and venue 0xa3c034a0…fa77, with questions naming Alpha-Z / Neural Drift / Kestrel 7. The journal held only the 9 most recent. Nine earlier meta-markets this project minted are absent, three of them voided: 0x…000159bf ("Will agent Alpha-Z close session #3 with a higher NAV?", voided true), 0x…000159c2, 0x…000159c3. So the chain shows 4 voids for this project where the page shows 1, and the earlier generation's transactions are simply not counted in "from this deployment". Nothing is invented — the count is a true count of a silently truncated dataset.

## [cosmetic] / — metric strip "Meta-markets live" count. src/app/page.tsx:45 (FEATURED = 5), :137 (.slice(0, FEATURED)), :292 ({minted.length})

**Rendered:** "Meta-markets live 3"

**Why it is not real enough:** minted is the *feature list*, truncated to 5 by a display constant, and the tile prints its length as a protocol total. It is correct today because there are 3 agents. With 6 or more open sessions the tile would read "5" indefinitely while claiming to count live meta-markets. Latent rather than currently wrong.

## [cosmetic] /agents/[slug] NAV chart footer — src/components/AgentNavChart.tsx:225-226 (usdc() vs last.value.toFixed(2))

**Rendered:** "baseline 100.01 · latest 100.02 tUSDC" on Neural Drift, and "baseline 200.08 · latest 200.09 tUSDC" on Kestrel 7 — the same measured integer printed as two different numbers on one line, implying a +0.01 gain that did not happen.

**Why it is not real enough:** `usdc()` truncates (src/components/agentFormat.ts:47, deliberately: "199.999999 displayed as 200.00 is a claim the vault cannot honour"), but the chart's headline and "latest" go through `unitsFloat()` → `toFixed(2)`, which rounds. Neural Drift's baseline and last sample are both the integer 100016033; Kestrel's are both 200087141. The rounded half is not a rendering of any measured value the rest of the product would produce, and it manufactures a visible one-cent divergence between two printings of one number.

## [cosmetic] /agents/[slug] execution tape — src/components/AgentTradeTape.tsx:67 and :73 (truncation in src/components/agentFormat.ts:40-49)

**Rendered:** Rows reading "Size 0.00" and "Cash delta -0.00" for trades that really happened. Example: tx 0x207e3b08…ba280, whose vault `Traded` event I decoded straight off chain as quantity=1000, cashDelta=-381 — i.e. 0.001 and -0.000381 tUSDC. 16 of 102 stored trades render size 0.00 and 18 render a ±0.00 cash delta.

**Why it is not real enough:** The values are chain-verbatim (origin a — I decoded the BotVault `Traded` event and it matches the `agent_trades` row field for field), but two-decimal truncation of a sub-cent quantity renders a real order as a zero-size, zero-cash trade — and the minus sign is kept, so the tape shows "-0.00" tinted red. A visitor reads it as a trade that moved nothing. Nothing on the tape says the display floor is a cent.

## [cosmetic] /agents/alpha-z session history — src/components/AgentSessionCard.tsx:56 and :120-129

**Rendered:** Session 1: "NAV at open 250.00 / NAV at close 250.00 / Change 0.00" with the Change cell carrying the `negative` class (rendered red).

**Why it is not real enough:** `rose = BigInt(delta) > 0n`, so a delta of exactly zero takes the false branch and is tinted as a loss. The three numbers are chain-verified (I read the session's own BotNavOracle at 0x5b071d34…9554: navT0 250000000, navT1 250000000, finalValue 2), but the colour asserts a loss the vault did not take. Colour is load-bearing elsewhere in this product (green Up / red Down), so this is a claim, not decoration.

## [cosmetic] /audit — src/app/audit/page.tsx:221 (`usdc(t.quantity, 0)`) and :226 (`signedUsdc(t.cashDelta)`)

**Rendered:** `placeBinaryOrder | Buy YES 0 · BTC-4h@08:00 | 0xaceb13…a768 | -0.00 cash` — an order row whose size and whose cash effect both read as zero.

**Why it is not real enough:** quantity is a 6-decimal integer and usdc(raw, 0) truncates. The row above is quantity `6000` = 0.006 contracts, rendered `0`; another is quantity `64000` = 0.064 contracts with cashDelta -0.033 tUSDC, rendered `Buy NO 0 … -0.00 cash`. 27 of the 122 trades in agent_trades are below one contract, so roughly a fifth of the ledger prints an order size of zero for a real, non-zero order. The underlying values are real (origin: agent_trades, written from the on-chain Traded event); the display turns them into a number that says nothing happened, on the one page whose purpose is exactness.

## [cosmetic] /audit — src/app/audit/page.tsx:84-86 (`stamp(at, exact)`), column header "When (UTC)" at :369; sources src/lib/agents/orchestrator.ts:150 (`opensAt = nowSec()`) and bots/runner.ts:968 (`at: Date.now()`)

**Rendered:** Second-precision timestamps in the live ledger's first column, e.g. `2026-09-07 07:31:54 UTC` next to a hash a reader can open on the explorer.

**Why it is not real enough:** These are the keeper's and the bot's local wall clocks at the moment the call was ISSUED, not the block timestamp of the mined transaction — and the page's own doc-comment at :78-83 calls them "exact", reserving the "after" hedge for mint and finalize only. Measured against the block each hash landed in: all 12 openSession rows are 2.0–4.0s EARLIER than their block, and sampled trades are 1.1–2.0s LATER. Small, but a reader cross-checking a row against the explorer on a page built for cross-checking will find the seconds disagree, and openSession's drift is systematically signed rather than noise.

## [cosmetic] /market/<any unknown id> — src/app/not-found.tsx:14-20

**Rendered:** "404 · no such contract" / "This window has already closed." / "Event Contracts roll on a cadence. A 15-minute window that was open when this link was shared has since expired and been replaced by the next one. The address is fine; the contract behind it is gone."

**Why it is not real enough:** I requested /market/0xdeadbeef…deadbeef — an id that has never existed on the venue — and got exactly this copy, HTTP 404. The page asserts a specific history it has not checked: that a contract existed, that it was a 15-minute window, that it was open when the link was shared, and that a successor replaced it. `refuse()` (market/[id]/page.tsx:210-218) correctly separates a failed chain read from a missing contract, but past that gate every null becomes this one invented story. For the common case (a genuinely stale shared link) it is true; for a typo or a probe it is fabricated. Low impact, one-line fix.

## [cosmetic] .data/forecast-arena.db (freed pages) — no page or API reads it

**Rendered:** Nothing. No surface renders these bytes.

**Why it is not real enough:** Reported because the brief asked me to verify the five synthetic profiles are gone. They are gone from the `users` table — I queried `walletAddress LIKE '0xdemo%'` and got zero rows — but `strings` on the db file still recovers the deleted rows from freed pages: 0xdemo43616c69627261746564… ("Calibrated Analyst"), 0xdemo43617574696f757320486564676572 ("Cautious Hedger"), 0xdemo4d6f6d656e74756d20436861736572 ("Momentum Chaser"), 0xdemo4f766572636f6e666964656e742050756e74 ("Overconfident Punter"), 0xdemo50617469656e74205370656369616c697374 ("Patient Specialist"). SQLite does not zero freed pages and there is no VACUUM anywhere in src/ or scripts/, so the purge is logical only. Nothing renders them and no code path can reach them; this is data hygiene, and it disappears with a VACUUM or by dropping the retired tables — which would also fix the /privacy finding above.

