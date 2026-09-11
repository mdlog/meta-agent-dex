# Demo video — design

Date: 2026-09-11. Status: draft, awaiting review.

The DoraHacks submission requires a 2–3 minute demo video, and `docs/SUBMISSION.md`
and `README.md` still carry `TODO — video URL`. `docs/DEMO_RUNBOOK.md` is a
complete shootable script for a human presenter; this document turns it into a
video that a pipeline produces end to end — browser recording, real terminal
logs, synthetic English narration, burned-in captions — so it can be re-shot in
twenty minutes whenever Shannon changes the numbers on screen.

## 1. Deliverable

| Output | Spec |
|---|---|
| `video/out/meta-agent-dex-demo.mp4` | 1920×1080, 30 fps, H.264 yuv420p (CRF 18), AAC 48 kHz stereo. **Length ≤ 3:00**, target 2:45–2:55. |
| `video/out/meta-agent-dex-demo.srt` | The same captions as the burned-in ones, for the YouTube upload. |
| `video/` | The pipeline, committed, so the video can be re-shot. `video/out/` and `video/node_modules/` are gitignored; the MP4 is never committed. |

Out of scope: uploading the video, filling in the two `TODO — video URL` lines
(needs the YouTube link first), and fixing the speculator order path (§9).

## 2. Constraints, inherited from the runbook

- Hard ceiling 3:00 — "a video that runs over is a video a judge stops watching".
- **Never script a line the screen can contradict.** Every UI string the
  narration quotes is verified against `src/` (§7). Five strings in the runbook
  no longer exist in the UI and are replaced by their current copy.
- Never say: "no oracle", "settled purely by code", "atomic settlement",
  "trustless", "anyone can come and buy a side", any user / TVL / volume figure,
  or any speculator fill that is not on screen.
- Numbers come only from the runbook's "Numbers you may say out loud" list or
  are read off the screen at record time (§4).
- Do not restart the app, reprovision agents, or faucet into a live vault.
- The video is in English: the judges are the Somnia × DreamDEX panel and the
  runbook, README and submission copy are already English.

## 3. Pipeline

```
  localhost:3009 ──► video/select.ts ──► out/take.json   (which agent, which markets, which Beat-3 case)
                                              │
  video/script.ts (beats + narration templates) ──► video/tts.py ──► out/audio/NN.mp3 + NN.words.json
                                              │
  .data/logs/*.log ──► video/terminal.html ◄── video/record.ts ──► out/clips/NN.webm  (one clip per beat,
                                                                                        held ≥ narration length)
                                              │
                                        video/build.sh (ffmpeg) ──► out/meta-agent-dex-demo.mp4 + .srt
```

| File | Responsibility |
|---|---|
| `video/package.json` | Private package with `playwright` pinned. Its own `node_modules`, so the app's dependency tree is untouched. Chromium `1228` is already in `~/.cache/ms-playwright`. |
| `video/script.ts` | **Single source of truth.** An ordered array of beats: `{ id, route, narration (template), actions[] }`. Actions are a small DSL — `goto`, `waitFor(selector)`, `scrollTo(selector)`, `hover(selector)`, `click(selector)`, `hold(ms)`, `terminal(spec)`, `reload`, `card(name)`. No narration text lives anywhere else. |
| `video/select.ts` | Runs the runbook's T-10 checks against the API and writes `out/take.json` (§4). Aborts loudly if the take is not filmable. |
| `video/tts.py` | `edge-tts` (`pip install --user edge-tts`), voice `en-US-AndrewNeural`, rate `+0%` by default. One MP3 per beat, plus word-boundary timestamps → `NN.words.json`. Fills narration variables from `take.json`. |
| `video/terminal.html` | A 1920×1080 page styled as a terminal (dark, monospace 22 px). Loads `out/term/NN.json` and reveals lines one at a time. The lines are copied verbatim from `.data/logs/runner-*.log` and `speculator-*.log` by `record.ts` (§6); nothing is typed in by hand. |
| `video/cards.html` | Title card and end card, same page, rendered by Playwright into the clip stream. |
| `video/record.ts` | Playwright Chromium headless, viewport 1920×1080, DSF 1, `recordVideo` with one browser context per beat so each beat is its own `.webm`. Injects a 22 px cursor ring that follows `page.mouse` so hovers and clicks are visible. Holds the last frame so `clip ≥ audio + 0.4 s`. |
| `video/build.sh` | ffmpeg: trim each clip to `max(audio + 0.4 s, visual minimum)`, concat, mux audio, burn ASS captions and the route chip, encode. Fails if total > 3:00. Also emits the SRT. |
| `video/README.md` | The re-shoot procedure in ten lines: start speculators, `select`, `tts`, `record`, `build`, restore speculators. |

Order of operations matters: `select` → `tts` → `record` → `build`. TTS runs
before recording because the recorder needs each narration's duration to know
how long to hold a beat; the narration only depends on `take.json`, never on the
recording.

If Playwright's VP8 recording turns out too soft for 22 px terminal text, the
fallback is a 30 fps `page.screenshot` sequence per beat encoded by ffmpeg. Same
script, same DSL; only `record.ts` changes.

## 4. Record-time selection (`select.ts`)

Everything below is decided from the live API immediately before recording and
written to `out/take.json`, so a re-shoot next week picks next week's numbers.

1. `/api/health` must return `mode: "live"` and `ok: true`; otherwise abort.
   (Verified today: live, chain 50312.)
2. **Agent A** (Beats 2, 3, 4): among agents with an open session whose
   meta-market is minted (no `NONE`) and does not 404, prefer one whose
   meta-market book is non-empty; tie-break by number of trades on the live
   session. If every book is empty, take the most trades. Today: **Kestrel 7**,
   28 trades on session #32.
3. **Beat 3 market**: A's live meta-market. Today `0x…1a3b3`.
4. **Beat 5 market**: A's most recent session with `status: settled` whose
   `/api/markets/<id>.onchain` reads `isResolved: true, isVoided: false`. If A
   has none, any agent's — the narration variables follow whichever it is.
   Today: Kestrel 7 #30, `0x…1a16e`, `winningOutcome: up`, navT0 225.64 →
   navT1 441.33, resolved 181 s after expiry, 23 real trades in the tape.
5. **Beat 4 tape**: A's profile must show ≥ 1 trade with a transaction hash
   (the explorer click). Today: yes.
6. **Beat 3 case** (see §5, Beat 3):
   - **A — quotes on the book**: book has ≥ 1 resting order.
   - **C — orders rejected**: book empty and the last 3 minutes of
     `speculator-*.log` contain `error order`.
   - **B — thesis refused**: everything else.
7. Anything showing `SIMULATED DATA` or "The agent board could not load" aborts
   the take. Never film a 404.

Variables written for the narration: `{agent}`, `{sOpen}`, `{sSettled}`,
`{navT0}`, `{navT1}`, `{answer}` (YES/NO), `{paid}` (Up/Down).

## 5. Shot list and narration

Budget: 460 words at ~160 wpm ≈ 2:52 of speech; the cards and the explorer hold
sit under narration, so they add no time; six 0.4 s gaps add 2.4 s. Rule: after
`tts.py` measures the real total, if it exceeds **2:52**, re-render at rate
`+6%`; if still over, apply the cut list at the end of this section, in order.

Captions: the narration split at clause boundaries into cues of ≤ 2 lines ×
42 characters, ≥ 1.2 s each, timed from the TTS word boundaries. A route chip
in the top-right shows the public path (`meta-agent.mdloglabs.org/agents/kestrel-7`)
because the address bar is not part of the recording.

### Beat 1 — what this is — `/` — 68 words

Title card for 3 s (narration starts at 0.5 s): **Meta-Agent DEX** · *Agents
trade. Other agents price the traders.* · Somnia × DreamDEX Event Contracts
Hackathon. Cut to `/`: hold the hero (eyebrow `AGENT PERFORMANCE, MEASURED ON
CHAIN`, headline `Back the agents…`) 5 s; hover the `DATA SOURCE` panel reading
`Reading Somnia` 3 s; smooth-scroll to the metric strip (`Agents registered`,
`Sessions open`, `Meta-markets live`, `Sessions finished`) and the `Agent
leaderboard`; hold. Numbers on the strip are not read aloud.

> AI agents trade real DreamDEX Event Contracts on Somnia. You can't verify a
> bot's track record from a screenshot, and nobody could put a price on one.
> Meta-Agent DEX's answer is a second layer: a native Event Contract on whether
> an agent's session ends with more money than it started — and a second set of
> agents that trade it. Every transaction here is signed by a program. There is
> no trade ticket.

### Beat 2 — the agents being measured — `/agents` + terminal — 60 words

`/agents` (`SIGNAL INDEX` / `Agent leaderboard`): hover the `Finished` column
header, then `{agent}`'s row. Cut to the terminal (§6, runner window, ~6 s).
Back to `/agents`, click `{agent}` → `/agents/{slug}`; hover the header button
`This session's contract`; click it (lands on Beat 3's page). The number of
agents is never spoken — the board has eleven today and had three when the
runbook was written.

> Every trading agent has its own vault and its own key, and is ranked on
> sessions it finished — not on what it holds. NAV is nav() on the vault
> contract, never a token balance. Here is one of them deciding, one line per
> decision. The key it holds can call exactly one function on its vault —
> trade. It cannot withdraw.

### Beat 3 — the agents that price the agents — `/market/{openId}` + terminals — 87 words

Market page: hover the symbol (`BOTNAV-90m@…`) and the question; hover the
`This contract prices` panel (`NAV at open`, `Vault cash now`); scroll to `How
orders reach this book` (`LAYER 1 · bots/runner.ts` → `BotVault.trade()`,
`LAYER 2 · bots/speculator.ts`, `Run one against this venue`). Cut to the
two-pane terminal (backer | skeptic, §6, ~6 s). Back to the market page,
`reload`, hover the order-book panel. The first two sentences are shared; the
third differs by case.

> This is the contract on the agent: ticker BOTNAV — will {agent} close session
> {sOpen} with a higher NAV? It is the same market page as any BTC contract
> here, because it is a native DreamDEX Event Contract, minted with
> scheduleAndCreateMarket on an operator and venue we registered ourselves.

**Case A — quotes on the book** (the runbook's good take):

> Orders reach this book from the two reference speculator agents we ship — a
> backer and a skeptic — reading the same evidence and disagreeing, and each
> names the clause behind every decision. Those levels were put there by the
> two processes you just saw: a price on an agent's performance, formed by two
> programs that staked collateral to say it.

**Case B — the thesis refused** (book empty, `refuse` lines on screen; the rail
reads `No quote on this contract yet`):

> The book is empty, and the terminal says exactly why: the two reference
> speculators we ship — a backer and a skeptic — read the same evidence, and
> each names the clause that made it refuse. A refusal is a decision. Anyone can
> run one against this venue, and the first quote to accept this contract is
> the one that sets its price.

**Case C — orders rejected** (book empty, `intent` then `error order` on screen):

> The book is empty, and the terminal says exactly why: the two reference
> speculators we ship — a backer and a skeptic — priced this contract and
> signed an order, and the public RPC rejected the send: the write-path issue
> documented in our SDK feedback. The pricing is real and the contract is real;
> the gap between them is one RPC.

"Reference speculators we ship" is deliberate: both keys are ours, and the
launcher (`scripts/start-speculators.ts`) wound the layer down on 2026-09-08
precisely because a project quoting its own meta-markets is trading with
itself. The narration never calls them independent, and `Run one against this
venue` is on screen when it says anyone can run one. See §9 for the decision
this leaves open.

### Beat 4 — the number that settles, and the number that cannot — `/agents/{slug}` — 87 words

Profile: scroll to `THE NUMBER THAT SETTLES`; hover `Cash · nav()` (the label
while a session is live) then `Unaccounted · unaccounted()` and its caption
(`Tokens sitting in the vault that no DreamDEX call delivered. Visible to
anyone, counted by nothing — it can never reach NAV.`); scroll to `CUSTODY` /
`The vault holds it` (`Owner`, `Operator`); scroll to the trade tape; click the
first `Transaction` link; the Shannon explorer loads; **hold 2 s**. The faucet
measurement (10,197.91 / 197.91 / 10,000.00) is not on this page, so it is not
spoken here — it moves to Beat 6, where the rows that show it are on screen.

> NAV is not a balance. Somnia's test collateral has a permissionless faucet:
> ten thousand per call, no cooldown. If NAV were a token balance, a stranger
> could forge an agent's profit for free. So nav() counts only collateral a
> DreamDEX call delivered; anything else lands in unaccounted(), visible to
> anyone and counted by nothing. The operator key may only call trade;
> withdrawals belong to a different owner. Every row in the tape is a real IOC
> order on a live contract — here is one, on the Shannon explorer.

### Beat 5 — settlement, on a session that already settled — `/market/{settledId}` → `/settlement` — 78 words

Resolved market: hover the `Resolved` pill; hover `This contract prices`
(`NAV at open`, and the sentence `The oracle answered YES, and DreamDEX's
committee read that number to settle this market.`). Cut to `/settlement`:
hover the banner, then `How a market resolves` (01 Snapshot → 04 Attest); scroll
to `Settled and voided sessions`; hover `{agent}` #`{sSettled}` (`Oracle answer`
`YES · NAV rose`, `DreamDEX paid` `index 0 · Up`). The last sentence plays over
`/settlement`, whose own eyebrow reads `Defined by code. Attested by the
committee.`

> This session already closed. The vault's own oracle snapshotted NAV before the
> market existed. At close, redeemAll, closeSession and finalize ran — all three
> permissionless. finalize writes one number that can never be restated, and
> 180 seconds after expiry a DreamDEX validator subcommittee read it and voted.
> {agent} opened at {navT0} and closed at {navT1}; the oracle answered {answer},
> and DreamDEX paid the {paid} side. Settlement is defined by code and attested
> by DreamDEX's oracle committee.

### Beat 6 — the receipts, then stop — `/audit` → end card — 80 words

`/audit`: hover `MINED AND CHECKED BEFORE THE DEMO`; scroll to `NAV INTEGRITY`
and hover the three rows under `A wallet top-up cannot move NAV`
(`balanceOf(vault) 10,197.91`, `nav() 197.91`, `unaccounted() 10,000.00`);
scroll to `THIS DEPLOYMENT`. The last two sentences play over the end card:
**Meta-Agent DEX** · meta-agent.mdloglabs.org · github.com/mdlog/meta-agent-dex ·
*Every number in this video is on /audit.* Hold 1 s of silence, end.

> Every claim here is a transaction on this page: the operator and venue we
> registered, the first meta-market we minted, and the faucet test — ten
> thousand tUSDC pushed into a live vault; the balance read 10,197.91 and nav()
> stayed at 197.91. Every agent anyone deploys generates a new,
> machine-resolvable question every session, and DreamDEX settles it on its own
> rails. Agents trade it, agents price it, a contract measures it — and nothing
> in that loop waits for somebody to click.

### Cut list, in order, if the measured total is still over 2:52 at +6%

1. Beat 3: "and each names the clause behind every decision" (−8 words).
2. Beat 6: "the balance read 10,197.91 and nav() stayed at 197.91" → "and it moved nav() by exactly zero" (−4).
3. Beat 1: "There is no trade ticket." (−5).
4. Beat 4: "no cooldown" (−2).
5. Beat 2: "It cannot withdraw." (−3).

## 6. Terminal shots

Both shots are copies of real log lines; the only edits are dropping ANSI codes
(there are none) and the log-file path. Keys are never logged, so nothing needs
redacting — `record.ts` still refuses any line containing `0x` followed by 64
hex characters that is not a `tx=` field, as a guard.

- **Beat 2 — runner window.** From `.data/logs/runner-{slug}.log`: the most
  recent `filled` line and the ~7 lines before it, so the shot always contains
  a `scan`, a `signal` (whose `rule="…"` is the rule in words), a `sent` and a
  `filled`. Header: `$ AGENT_SLUG={slug} node --experimental-strip-types
  bots/runner.ts`.
- **Beat 3 — two panes.** Left `AGENT_THESIS=backer npm run speculator`, right
  `skeptic`. Each pane shows the last 6 lines of its log whose kind is in the
  case's set — A: `view intent resting filled`; B: `view refuse hold`; C: `view
  intent error`. Long `why="…"` values wrap.
- Lines appear every 350 ms; a shot never exceeds 6 s. Timestamps stay.

## 7. UI strings the narration or captions rely on

| Runbook said | Current copy (verified in `src/`) | Where |
|---|---|---|
| "Take a side" | `This session's contract` (profile header button); `Open the meta-market` (session card) | `AgentProfile.tsx:232`, `AgentSessionCard.tsx:230` |
| "Sessions settled" (metric) | `Sessions finished` | `app/page.tsx:323` |
| "Open meta-markets" cards | no such section; the board links to profiles, profiles link to markets | `AgentBoard.tsx:512` |
| "EXECUTION TAPE / Trades" | a table with a `Transaction` column, under `SESSIONS` | `AgentTradeTape.tsx:88-100` |
| "No implied probability" / "Nobody is quoting both sides" | `No quote on this contract yet`; `An empty book is the state a speculator agent is looking for — the first quote on it is the one that sets the price.` | `ProbabilityRail.tsx:55`, `OrderBookPanel.tsx:40` |
| "NAV · nav()" | `Cash · nav()` while a session is live, `NAV · nav()` otherwise | `AgentProfile.tsx:262-270` |
| unchanged | `Reading Somnia`, `DATA SOURCE`, `THE NUMBER THAT SETTLES`, `Unaccounted · unaccounted()`, `CUSTODY`, `The vault holds it`, `This contract prices`, `How orders reach this book`, `Run one against this venue`, `Resolved`, `Voided`, `How a market resolves`, `Settled and voided sessions`, `Oracle answer`, `DreamDEX paid`, `A wallet top-up cannot move NAV`, `Finished` | see `grep -rF` in the implementation plan |

The product name on screen is `Meta-Agent DEX` (`layout.tsx:31`); the package
is still called `forecast-arena`, which the video never shows.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| `select.ts` finds no filmable agent / market / resolved session | Abort before anything is recorded, printing which check failed and the runbook row that covers it. |
| A page is not `networkidle` within 20 s, shows `SIMULATED DATA`, or the board says it could not load | Abort the take naming the beat. No partial assembly. |
| Meta-market 404 (indexer lag) | Next candidate agent per §4; never film a 404. |
| `edge-tts` network failure | Retry ×3 with backoff, then abort; clips already recorded are kept. |
| Measured total > 3:00 | `build.sh` fails, printing the total and the cut list. |
| Speculators cannot be restarted (no gas, `holds 0 STT`) | Film case B or C as the logs dictate; never `AGENT_DRY_RUN=1`. |

## 9. The speculator layer during the take

Agreed on 2026-09-11: for the recording only, restart both speculators without
wind-down, then restore them.

```
pkill -f bots/speculator.ts
AGENT_WIND_DOWN=0 npm run speculators        # keys persist in .data/speculators.json
# wait ≤ 10 min for a `resting` or an `error order` line, then select → tts → record → build
pkill -f bots/speculator.ts
npm run speculators                          # default AGENT_WIND_DOWN=1
```

Two facts the reviewer should weigh before the take:

- **The order path has been failing since 2026-09-08.** After the last
  `resting` line (backer 16:20Z, skeptic 11:11Z) every speculator order — 797
  attempts, normal sizes, 10,747 tUSDC of balance — came back `Missing or
  invalid parameters` on the viem path that `bots/send.ts` adopted because the
  SDK path fails the same way. The runners never see this error. If it recurs,
  the take is case C, and the honest narration for it is above. Diagnosing it
  is a separate task, and worth doing before recording if the good take
  matters.
- **Wind-down was a product decision, not an accident.** The launcher's comment
  says a speculator taking the other side of a market this project minted is
  the project trading with itself. Case B with the wind-down framing is a
  legitimate alternative to restarting; this spec supports both, and the
  narration for A never claims independence.

## 10. Verification before "done"

1. `ffprobe`: one video stream 1920×1080 30 fps, one AAC stream, duration ≤ 3:00.
2. A contact sheet (one frame every 5 s) reviewed for: a `SIMULATED DATA` bar,
   an empty table, a 404, overlapping or clipped captions, the wrong route chip.
3. The SRT parses and its cue count equals the caption count in the ASS file.
4. Every number in the narration matches `take.json` or the runbook list.
5. `pgrep -af bots/speculator.ts` shows exactly two processes, both with
   `AGENT_WIND_DOWN=1`, after the take.
6. `git status` shows only `video/` and this spec; no MP4 staged.

## 11. Follow-ups this spec does not cover

- Upload to YouTube (unlisted is fine for judging) and fill the two
  `TODO — video URL` lines.
- `docs/SUBMISSION.md:3` still says the submission closes 2026-09-08 — stale or
  extended?
- The speculator `Missing or invalid parameters` regression (§9).
