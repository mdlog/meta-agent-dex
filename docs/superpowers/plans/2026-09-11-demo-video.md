# Demo Video Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `video/out/meta-agent-dex-demo.mp4` (+ `.srt`), a ≤3:00 narrated demo of the live app, from a pipeline in `video/` that can be re-run for a re-shoot.

**Architecture:** `select.ts` reads the live API and writes `out/take.json` (agent, markets, Beat-3 case). `script.ts` turns a take into six beats (actions + resolved narration). `tts.py` renders narration with edge-tts and measures it; `record.ts` drives Playwright through the beats, holding each clip at least as long as its narration, and renders real log lines through `terminal.html`; `captions.py` builds ASS/SRT from the TTS word timings; `build.py` assembles everything with ffmpeg.

**Tech Stack:** Node 22 (`--experimental-strip-types`, `node:test`), Playwright 1.61.1 (Chromium 1228 already cached), Python 3.12 + `edge-tts`, ffmpeg (static build in `~/.local/bin`).

**Spec:** `docs/superpowers/specs/2026-09-11-demo-video-design.md`

## Global Constraints

- Final MP4: 1920×1080, 30 fps, H.264 yuv420p CRF 18, AAC 48 kHz stereo, **duration ≤ 180 s**; target 165–175 s.
- Narration is the spec's §5 text, verbatim; variables `{agent} {sOpen} {sSettled} {navT0} {navT1} {answer} {paid}` come from `out/take.json`. If measured speech > 172 s at rate `+0%`, re-render at `+6%`; if still over, apply the spec's cut list in order.
- Never film `SIMULATED DATA`, "The agent board could not load", or a 404. Never fabricate a log line: terminal shots are verbatim copies from `.data/logs/`.
- Record from `http://localhost:3009`; the route chip shows the public host `meta-agent.mdloglabs.org`.
- The app's dependency tree is not touched: `video/` has its own `package.json`. `video/out/` and `video/node_modules/` are gitignored; the MP4 is never committed.
- Product name on screen: `Meta-Agent DEX`. Repo: `github.com/mdlog/meta-agent-dex`.
- All commands run from the repo root `/home/mdlog/Project-MDlabs/Dorahacks/somnia`. Commit messages carry no AI attribution trailers (user's global rule).

---

### Task 1: Scaffold `video/` and prove the toolchain

**Files:**
- Create: `video/package.json`, `video/.gitignore`, `video/README.md`
- Modify: `.gitignore` (append two lines)

**Interfaces:**
- Produces: a working `import { chromium } from "playwright"` from any `video/*.ts`; `python3 -c "import edge_tts"`.

- [ ] **Step 1: Create the package and ignore files**

`video/package.json`:
```json
{
  "name": "meta-agent-dex-video",
  "private": true,
  "type": "module",
  "description": "Re-shootable demo video pipeline. See README.md.",
  "devDependencies": {
    "playwright": "1.61.1"
  }
}
```

`video/.gitignore`:
```
node_modules/
out/
```

Append to the root `.gitignore`:
```
# demo video pipeline outputs
video/out/
video/node_modules/
```

- [ ] **Step 2: Install**

Run: `npm --prefix video install --no-audit --no-fund && pip3 install --user --quiet edge-tts`
Expected: `added 2 packages` (playwright + playwright-core); pip prints nothing.

- [ ] **Step 3: Verify the browser binary is the cached one, not a download**

Run: `node --experimental-strip-types -e 'import("playwright").then(async p => { const b = await p.chromium.launch(); console.log("chromium", b.version()); await b.close(); })'` from `video/` (`cd video && … && cd ..`).
Expected: prints `chromium 1xx.x.xxxx.xx` with no "Executable doesn't exist" error. If it errors, run `npx --prefix video playwright install chromium` (it will find `~/.cache/ms-playwright/chromium-1228`).

- [ ] **Step 4: Verify edge-tts, ffmpeg, fonts**

Run: `python3 -c "import edge_tts, sys; print('edge-tts', edge_tts.__version__ if hasattr(edge_tts,'__version__') else 'ok')" && ffmpeg -hide_banner -version | head -1 && fc-list | grep -c -i "inter"`
Expected: three non-error lines.

- [ ] **Step 5: README skeleton**

`video/README.md`:
```markdown
# Demo video pipeline

Produces `out/meta-agent-dex-demo.mp4` (+ `.srt`) from the live app on
`localhost:3009`. Spec: `docs/superpowers/specs/2026-09-11-demo-video-design.md`.

## Re-shoot, start to finish (≈20 min)

    bash video/speculators.sh on            # optional: lets the layer-2 agents quote during the take
    node --experimental-strip-types video/select.ts        # → out/take.json (aborts if not filmable)
    python3 video/tts.py                                   # → out/audio/*.mp3 + index.json
    node --experimental-strip-types video/record.ts --probe # every selector resolves?
    node --experimental-strip-types video/record.ts        # → out/clips/*.webm
    python3 video/captions.py                              # → out/captions.ass + .srt
    python3 video/build.py                                 # → out/meta-agent-dex-demo.mp4
    bash video/speculators.sh off           # back to redeem-only

Tests: `node --experimental-strip-types --test video/test/*.test.ts` and
`python3 -m unittest discover -s video/test -p "test_*.py"`.
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore video/package.json video/package-lock.json video/.gitignore video/README.md
git commit -m "chore(video): scaffold the demo video pipeline package"
```

---

### Task 2: `video/script.ts` — beats, actions and narration from a take

**Files:**
- Create: `video/script.ts`
- Test: `video/test/script.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Take = {
    base: string; explorer: string; case: "A" | "B" | "C";
    agent: { slug: string; name: string };
    openSession: number; openMarketId: string; openQuestion: string;
    settledSession: number; settledMarketId: string;
    navT0: string; navT1: string; answer: "YES" | "NO"; paid: "Up" | "Down";
  };
  export type Action = ... (below); export type TerminalPane = { title: string; log: string; kinds: string[]; lines: number; mode: "window" | "kinds" };
  export type Beat = { id: string; minVisualMs: number; narrationDelayMs: number; narration: string; actions: Action[] };
  export function beats(take: Take): Beat[];              // six beats, narration resolved
  export function narrationFor(take: Take): { id: string; text: string; delayMs: number; minVisualMs: number }[];
  ```
- CLI: `node --experimental-strip-types video/script.ts --narration` reads `video/out/take.json`, prints `narrationFor(take)` as JSON.

- [ ] **Step 1: Write the failing test**

`video/test/script.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { beats, narrationFor, type Take } from "../script.ts";

const take: Take = {
  base: "http://localhost:3009", explorer: "https://shannon-explorer.somnia.network", case: "A",
  agent: { slug: "kestrel-7", name: "Kestrel 7" },
  openSession: 32, openMarketId: "0xopen", openQuestion: "Will agent Kestrel 7 close session #32 with a higher NAV?",
  settledSession: 30, settledMarketId: "0xsettled",
  navT0: "225.64", navT1: "441.33", answer: "YES", paid: "Up",
};

test("six beats, every variable resolved, no braces left", () => {
  const b = beats(take);
  assert.equal(b.length, 6);
  for (const beat of b) assert.doesNotMatch(beat.narration, /[{}]/, beat.id);
  assert.match(b[2].narration, /will Kestrel 7 close session 32/);
  assert.match(b[4].narration, /opened at 225\.64 and closed at 441\.33; the oracle answered YES, and DreamDEX paid the Up side/);
});

test("beat 3 narration follows the case", () => {
  assert.match(beats({ ...take, case: "A" })[2].narration, /What is on this book came from/);
  assert.match(beats({ ...take, case: "B" })[2].narration, /made it refuse/);
  assert.match(beats({ ...take, case: "C" })[2].narration, /the send was rejected/);
});

test("terminal panes name real log files and the case's kinds", () => {
  const b = beats({ ...take, case: "B" });
  const term2 = b[1].actions.find((a) => a.kind === "terminal");
  assert.ok(term2 && term2.kind === "terminal");
  assert.equal(term2.panes[0].log, "runner-kestrel-7.log");
  const term3 = b[2].actions.find((a) => a.kind === "terminal");
  assert.ok(term3 && term3.kind === "terminal");
  assert.deepEqual(term3.panes.map((p) => p.log), ["speculator-backer.log", "speculator-skeptic.log"]);
  assert.deepEqual(term3.panes[0].kinds, ["view", "refuse", "hold"]);
});

test("narrationFor carries delay and minimum visual length", () => {
  const n = narrationFor(take);
  assert.equal(n[0].delayMs, 500);
  assert.ok(n.every((x) => x.minVisualMs >= 8000));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test video/test/script.test.ts`
Expected: FAIL — `Cannot find module '../script.ts'`.

- [ ] **Step 3: Write `video/script.ts`**

```ts
/**
 * The single source of truth for the demo video: six beats, their on-screen
 * actions and their narration. Nothing else under video/ contains narration.
 * Every quoted UI string below was checked against src/ on 2026-09-11 — see the
 * spec's §7 before changing one.
 */
import fs from "node:fs";
import path from "node:path";

export type Take = {
  base: string;
  explorer: string;
  case: "A" | "B" | "C";
  agent: { slug: string; name: string };
  openSession: number;
  openMarketId: string;
  openQuestion: string;
  settledSession: number;
  settledMarketId: string;
  navT0: string;
  navT1: string;
  answer: "YES" | "NO";
  paid: "Up" | "Down";
};

export type TerminalPane = {
  title: string;
  /** file name under .data/logs */
  log: string;
  kinds: string[];
  lines: number;
  /** window: the N lines ending at the last `filled`; kinds: last N lines whose kind is listed */
  mode: "window" | "kinds";
};

/** `at` = do not start this action before the narration reaches this phrase. */
export type Action = (
  | { kind: "card"; name: "title" | "end"; ms: number }
  | { kind: "goto"; path: string; route: string }
  | { kind: "wait"; ms: number }
  | { kind: "hover"; selector: string; ms?: number }
  | { kind: "click"; selector: string; route: string }
  | { kind: "scrollTo"; selector: string; ms?: number }
  | { kind: "explorer"; selector: string; ms: number }
  | { kind: "terminal"; panes: TerminalPane[]; ms: number }
) & { at?: string };

export type Beat = {
  id: string;
  minVisualMs: number;
  narrationDelayMs: number;
  narration: string;
  actions: Action[];
};

export const PUBLIC_HOST = "meta-agent.mdloglabs.org";

const N = {
  beat1: `AI agents trade real DreamDEX Event Contracts on Somnia. You can't verify a bot's track record from a screenshot, and nobody could put a price on one. Meta-Agent DEX's answer is a second layer: a native Event Contract on whether an agent's session ends with more money than it started — and a second set of agents that trade it. Every transaction here is signed by a program.`,
  beat2: `Every trading agent has its own vault and its own key, and is ranked on sessions it finished — not on what it holds. NAV is nav() on the vault, never a token balance. Here is one of them deciding, one line per decision. The key it holds can call exactly one function on its vault — trade. It cannot withdraw.`,
  beat3shared: `This is the contract on the agent: will {agent} close session {sOpen} with a higher NAV? It is the same market page as any BTC contract, because it is a native DreamDEX Event Contract — minted with scheduleAndCreateMarket on an operator and venue we registered ourselves.`,
  beat3A: `Orders reach this book from the two reference speculator agents we ship — a backer and a skeptic — each reading the same evidence and naming the clause behind its decision. What is on this book came from the processes you just saw: a price on an agent's performance that a program staked collateral to state.`,
  beat3B: `The book is empty, and the terminal says why: the two reference speculators we ship — a backer and a skeptic — read the same evidence, and each names the clause that made it refuse. A refusal is a decision, and the first quote to accept this contract is the one that sets its price. Anyone can run one against this venue.`,
  beat3C: `The book is empty, and the terminal says why: the two reference speculators we ship — a backer and a skeptic — priced this contract and signed an order, and the send was rejected. The log shows the error instead of hiding it. The pricing is real, the contract is real, and the rejection is on the record too.`,
  beat4: `NAV is not a balance. Somnia's test collateral has a permissionless faucet — ten thousand per call. If NAV were a token balance, a stranger could forge an agent's profit for free. So nav() counts only collateral a DreamDEX call delivered; anything else lands in unaccounted(), visible to anyone and counted by nothing. The operator key may only call trade; withdrawals belong to a different owner. Every row in the tape is a real IOC order on a live contract — here is one on the explorer.`,
  beat5: `This session already closed. The vault's own oracle snapshotted NAV before the market existed. At close, redeemAll, closeSession and finalize ran — all three permissionless. finalize writes one number that can never be restated, and 180 seconds after expiry a DreamDEX validator subcommittee read it and voted. {agent} opened at {navT0} and closed at {navT1}; the oracle answered {answer}, and DreamDEX paid the {paid} side. Settlement is defined by code and attested by DreamDEX's oracle committee.`,
  beat6: `Every claim here is a transaction on this page: the operator and venue we registered, the first meta-market we minted, and the faucet test — ten thousand tUSDC pushed into a live vault, and nav() moved by exactly zero. Every agent anyone deploys generates a new, machine-resolvable question every session, and DreamDEX settles it on its own rails. Agents trade it, agents price it, a contract measures it — and nothing in that loop waits for somebody to click.`,
};

function fill(template: string, take: Take): string {
  const vars: Record<string, string> = {
    agent: take.agent.name,
    sOpen: String(take.openSession),
    sSettled: String(take.settledSession),
    navT0: take.navT0,
    navT1: take.navT1,
    answer: take.answer,
    paid: take.paid,
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`narration variable {${k}} is not in the take`);
    return vars[k];
  });
}

const CASE_KINDS: Record<Take["case"], string[]> = {
  A: ["view", "intent", "resting", "filled"],
  B: ["view", "refuse", "hold"],
  C: ["view", "intent", "error"],
};

export function beats(take: Take): Beat[] {
  const { slug, name } = take.agent;
  const open = `/market/${take.openMarketId}`;
  const settled = `/market/${take.settledMarketId}`;
  const rowLink = `a.row-link:has-text("${name}")`;
  const beat3tail = take.case === "A" ? N.beat3A : take.case === "B" ? N.beat3B : N.beat3C;
  const beat3cut = take.case === "A" ? "Orders reach this book" : "The book is empty";

  return [
    {
      id: "01-what-this-is",
      minVisualMs: 12000,
      narrationDelayMs: 500,
      narration: fill(N.beat1, take),
      actions: [
        { kind: "card", name: "title", ms: 3000 },
        { kind: "goto", path: "/", route: "/" },
        { kind: "wait", ms: 4500 },
        { kind: "hover", selector: "text=Reading Somnia", ms: 3000 },
        { kind: "scrollTo", selector: '[aria-label="Protocol counts"]', ms: 2500 },
        { kind: "hover", selector: "h2:has-text('Agent leaderboard')", ms: 1500 },
      ],
    },
    {
      id: "02-agents-measured",
      minVisualMs: 12000,
      narrationDelayMs: 0,
      narration: fill(N.beat2, take),
      actions: [
        { kind: "goto", path: "/agents", route: "/agents" },
        { kind: "hover", selector: 'th:has-text("Finished")', ms: 2500 },
        { kind: "hover", selector: rowLink, ms: 1500 },
        {
          kind: "terminal",
          at: "Here is one of them deciding",
          ms: 7000,
          panes: [{ title: `AGENT_SLUG=${slug} node --experimental-strip-types bots/runner.ts`, log: `runner-${slug}.log`, kinds: ["scan", "signal", "sent", "filled"], lines: 8, mode: "window" }],
        },
        { kind: "goto", path: "/agents", route: "/agents" },
        { kind: "click", selector: rowLink, route: `/agents/${slug}` },
        { kind: "hover", selector: "a.primary-button:has-text(\"This session\")", ms: 1500 },
        { kind: "click", selector: "a.primary-button:has-text(\"This session\")", route: open },
      ],
    },
    {
      id: "03-agents-pricing",
      minVisualMs: 14000,
      narrationDelayMs: 0,
      narration: `${fill(N.beat3shared, take)} ${fill(beat3tail, take)}`,
      actions: [
        { kind: "goto", path: open, route: open },
        { kind: "hover", selector: "h1", ms: 2500 },
        { kind: "hover", selector: '[aria-label="The agent this contract prices"]', ms: 2500 },
        { kind: "scrollTo", selector: '[aria-label="How orders reach this book"]', ms: 2000 },
        {
          kind: "terminal",
          at: beat3cut,
          ms: 7000,
          panes: [
            { title: "AGENT_THESIS=backer npm run speculator", log: "speculator-backer.log", kinds: CASE_KINDS[take.case], lines: 6, mode: "kinds" },
            { title: "AGENT_THESIS=skeptic npm run speculator", log: "speculator-skeptic.log", kinds: CASE_KINDS[take.case], lines: 6, mode: "kinds" },
          ],
        },
        { kind: "goto", path: open, route: open },
        { kind: "scrollTo", selector: "text=Order book", ms: 1500 },
        { kind: "hover", selector: '[aria-label="Market-implied probability"]', ms: 2000 },
      ],
    },
    {
      id: "04-number-that-settles",
      minVisualMs: 14000,
      narrationDelayMs: 0,
      narration: fill(N.beat4, take),
      actions: [
        { kind: "goto", path: `/agents/${slug}`, route: `/agents/${slug}` },
        { kind: "scrollTo", selector: "text=THE NUMBER THAT SETTLES", ms: 1500 },
        { kind: "hover", selector: "text=/^(Cash|NAV) · nav\\(\\)$/", ms: 2500 },
        { kind: "hover", selector: "text=Unaccounted · unaccounted()", ms: 2500 },
        { kind: "scrollTo", selector: "text=The vault holds it", at: "The operator key", ms: 1500 },
        { kind: "hover", selector: "text=Operator", ms: 1500 },
        { kind: "scrollTo", selector: 'th:has-text("Transaction")', at: "Every row in the tape", ms: 1500 },
        { kind: "explorer", selector: `table a[href*="${new URL(take.explorer).host}"]`, at: "here is one", ms: 2500 },
      ],
    },
    {
      id: "05-settlement",
      minVisualMs: 14000,
      narrationDelayMs: 0,
      narration: fill(N.beat5, take),
      actions: [
        { kind: "goto", path: settled, route: settled },
        { kind: "hover", selector: "text=Resolved", ms: 2000 },
        { kind: "hover", selector: '[aria-label="The agent this contract prices"]', ms: 3000 },
        { kind: "goto", path: "/settlement", route: "/settlement", at: "Settlement is defined by code" },
        { kind: "hover", selector: "text=How a market resolves", ms: 1500 },
        { kind: "scrollTo", selector: "text=Settled and voided sessions", ms: 1500 },
        { kind: "hover", selector: `tr:has-text("${name}")`, ms: 1500 },
      ],
    },
    {
      id: "06-receipts",
      minVisualMs: 14000,
      narrationDelayMs: 0,
      narration: fill(N.beat6, take),
      actions: [
        { kind: "goto", path: "/audit", route: "/audit" },
        { kind: "hover", selector: "text=MINED AND CHECKED BEFORE THE DEMO", ms: 2000 },
        { kind: "scrollTo", selector: "text=A wallet top-up cannot move NAV", at: "and the faucet test", ms: 1000 },
        { kind: "hover", selector: "text=A wallet top-up cannot move NAV", ms: 2500 },
        { kind: "scrollTo", selector: "text=THIS DEPLOYMENT", at: "Every agent anyone deploys", ms: 1000 },
        { kind: "card", name: "end", at: "Agents trade it", ms: 12000 },
      ],
    },
  ];
}

export function narrationFor(take: Take) {
  return beats(take).map((b) => ({ id: b.id, text: b.narration, delayMs: b.narrationDelayMs, minVisualMs: b.minVisualMs }));
}

export const VIDEO_DIR = path.dirname(new URL(import.meta.url).pathname);
export const OUT_DIR = path.join(VIDEO_DIR, "out");

export function readTake(): Take {
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, "take.json"), "utf8")) as Take;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv.includes("--narration")) {
  process.stdout.write(JSON.stringify(narrationFor(readTake()), null, 2) + "\n");
}
```

- [ ] **Step 4: Run the test**

Run: `node --experimental-strip-types --test video/test/script.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add video/script.ts video/test/script.test.ts
git commit -m "feat(video): beats, actions and narration as one script"
```

---

### Task 3: `video/select.ts` — the T-10 checks, as code

**Files:**
- Create: `video/select.ts`
- Test: `video/test/select.test.ts`

**Interfaces:**
- Consumes: `Take` from `script.ts`.
- Produces:
  ```ts
  export type Candidate = { slug: string; name: string; sessionNumber: number; marketId: string; question: string; bookNonEmpty: boolean; trades: number };
  export function choose(cands: Candidate[]): Candidate;                      // throws if empty
  export function caseFor(bookNonEmpty: boolean, logTails: string[], nowMs: number): "A" | "B" | "C";
  export function fmtUsdc(raw: string): string;                                 // "225641000" -> "225.64"
  ```
- CLI writes `video/out/take.json`.

- [ ] **Step 1: Write the failing test**

`video/test/select.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { choose, caseFor, fmtUsdc, type Candidate } from "../select.ts";

const c = (o: Partial<Candidate>): Candidate => ({ slug: "a", name: "A", sessionNumber: 1, marketId: "0x1", question: "q", bookNonEmpty: false, trades: 0, ...o });

test("a quoted book beats more trades; otherwise most trades", () => {
  assert.equal(choose([c({ slug: "many", trades: 30 }), c({ slug: "quoted", trades: 2, bookNonEmpty: true })]).slug, "quoted");
  assert.equal(choose([c({ slug: "few", trades: 3 }), c({ slug: "many", trades: 30 })]).slug, "many");
  assert.throws(() => choose([]), /no filmable agent/);
});

test("case A on a quoted book, C on a recent order error, else B", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  const recentErr = `2026-09-11T11:58:30.000Z error order     market=x reason="Missing or invalid parameters."`;
  const oldErr = `2026-09-11T10:00:00.000Z error order     market=x reason="Missing or invalid parameters."`;
  const refuse = `2026-09-11T11:59:00.000Z warn  refuse    market=x thesis=backer reason="record is losing"`;
  assert.equal(caseFor(true, [recentErr], now), "A");
  assert.equal(caseFor(false, [recentErr, refuse], now), "C");
  assert.equal(caseFor(false, [oldErr, refuse], now), "B");
});

test("fmtUsdc renders 6-decimal integers with two decimals", () => {
  assert.equal(fmtUsdc("225641000"), "225.64");
  assert.equal(fmtUsdc("441328007"), "441.33");
  assert.equal(fmtUsdc("10000000"), "10.00");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test video/test/select.test.ts`
Expected: FAIL — cannot find `../select.ts`.

- [ ] **Step 3: Write `video/select.ts`**

```ts
/**
 * The runbook's "T-10 minutes" checks, as code. Reads the live API, picks the
 * agent and the two markets the video will show, decides which Beat-3 variant
 * is true right now, and writes video/out/take.json. Aborts if the take is not
 * filmable — a bad take is cheaper to refuse than to edit out.
 */
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR, VIDEO_DIR, type Take } from "./script.ts";

const BASE = process.env.BASE ?? "http://localhost:3009";
const LOGS = path.join(VIDEO_DIR, "..", ".data", "logs");

export type Candidate = {
  slug: string;
  name: string;
  sessionNumber: number;
  marketId: string;
  question: string;
  bookNonEmpty: boolean;
  trades: number;
};

export function choose(cands: Candidate[]): Candidate {
  if (cands.length === 0) throw new Error("no filmable agent: every open session lacks a minted, reachable meta-market");
  return [...cands].sort((a, b) => Number(b.bookNonEmpty) - Number(a.bookNonEmpty) || b.trades - a.trades)[0];
}

/** Log tails are raw logfmt lines; only the last three minutes count. */
export function caseFor(bookNonEmpty: boolean, logTails: string[], nowMs: number): "A" | "B" | "C" {
  if (bookNonEmpty) return "A";
  const cutoff = nowMs - 3 * 60 * 1000;
  const recentError = logTails.some((line) => {
    const ts = Date.parse(line.slice(0, 24));
    return Number.isFinite(ts) && ts >= cutoff && / error order/.test(line);
  });
  return recentError ? "C" : "B";
}

export function fmtUsdc(raw: string): string {
  const n = Number(BigInt(raw)) / 1e6;
  return n.toFixed(2);
}

async function j<T>(p: string): Promise<T | null> {
  const r = await fetch(BASE + p);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

function tail(file: string, lines = 200): string[] {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

async function main() {
  const health = await j<{ mode: string; ok: boolean; explorer: string }>("/api/health");
  if (!health || health.mode !== "live" || !health.ok) throw new Error(`not filmable: /api/health = ${JSON.stringify(health)}`);

  const sessions = await j<{ open: { agent: { slug: string; name: string }; session: { sessionNumber: number; metaMarketId: string | null } }[] }>("/api/agents/sessions");
  if (!sessions) throw new Error("not filmable: /api/agents/sessions 404");

  const cands: Candidate[] = [];
  for (const e of sessions.open) {
    const id = e.session.metaMarketId;
    if (!id) continue; // mint has not landed — the runbook says film a different agent
    const market = await j<{ market: { question: string }; book: Record<string, unknown[]> | null }>(`/api/markets/${id}`);
    if (!market) continue; // indexer lag: never film a 404
    const book = market.book ?? {};
    const bookNonEmpty = ["upBids", "upAsks", "downBids", "downAsks"].some((k) => Array.isArray(book[k]) && (book[k] as unknown[]).length > 0);
    const profile = await j<{ trades: unknown[] }>(`/api/agents/${e.agent.slug}`);
    cands.push({ slug: e.agent.slug, name: e.agent.name, sessionNumber: e.session.sessionNumber, marketId: id, question: market.market.question, bookNonEmpty, trades: profile?.trades.length ?? 0 });
  }
  const pick = choose(cands);

  type Sess = { sessionNumber: number; metaMarketId: string; navT0: string; navT1: string; outcomeValue: number; status: string };
  const profile = (await j<{ sessions: Sess[]; trades: { txHash: string }[] }>(`/api/agents/${pick.slug}`))!;
  if (!profile.trades.some((t) => t.txHash)) throw new Error(`not filmable: ${pick.slug} has no trade with a transaction hash`);

  // Beat 5: the most recent settled session of this agent that the chain says is resolved.
  const settledSessions = profile.sessions.filter((s) => s.status === "settled").sort((a, b) => b.sessionNumber - a.sessionNumber).slice(0, 5);
  let settled: (Sess & { winning: "up" | "down" }) | null = null;
  for (const s of settledSessions) {
    const m = await j<{ onchain: { isResolved: boolean; isVoided: boolean; winningOutcome: "up" | "down" | null } | null }>(`/api/markets/${s.metaMarketId}`);
    const oc = m?.onchain;
    if (oc && oc.isResolved && !oc.isVoided && oc.winningOutcome) {
      settled = { ...s, winning: oc.winningOutcome };
      break;
    }
  }
  if (!settled) throw new Error(`not filmable: ${pick.slug} has no session that is resolved on chain (runbook check 3: wait ten minutes and re-run)`);

  const logTails = [...tail(path.join(LOGS, "speculator-backer.log")), ...tail(path.join(LOGS, "speculator-skeptic.log"))];
  const take: Take = {
    base: BASE,
    explorer: health.explorer,
    case: caseFor(pick.bookNonEmpty, logTails, Date.now()),
    agent: { slug: pick.slug, name: pick.name },
    openSession: pick.sessionNumber,
    openMarketId: pick.marketId,
    openQuestion: pick.question,
    settledSession: settled.sessionNumber,
    settledMarketId: settled.metaMarketId,
    navT0: fmtUsdc(settled.navT0),
    navT1: fmtUsdc(settled.navT1),
    answer: settled.outcomeValue === 1 ? "YES" : "NO",
    paid: settled.winning === "up" ? "Up" : "Down",
  };
  if ((take.answer === "YES") !== (take.paid === "Up")) throw new Error(`oracle answer ${take.answer} does not match the paid side ${take.paid} — do not film this market`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "take.json"), JSON.stringify(take, null, 2) + "\n");
  console.log(JSON.stringify(take, null, 2));
  console.log(`\ncase ${take.case} — ${take.case === "A" ? "quotes on the book" : take.case === "B" ? "thesis refused" : "orders rejected"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the unit tests**

Run: `node --experimental-strip-types --test video/test/select.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Run it for real**

Run: `node --experimental-strip-types video/select.ts`
Expected: prints a take with `agent.slug` (today `kestrel-7`), `settledMarketId` ending `1a16e`, `navT0 "225.64"`, `answer "YES"`, `paid "Up"`, and a `case` line. `video/out/take.json` exists.

- [ ] **Step 6: Commit**

```bash
git add video/select.ts video/test/select.test.ts
git commit -m "feat(video): select the agent, markets and Beat-3 case from the live API"
```

---

### Task 4: `video/logs.ts` + `video/terminal.html` — verbatim log lines as a terminal shot

**Files:**
- Create: `video/logs.ts`, `video/terminal.html`, `video/preview.ts`
- Test: `video/test/logs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TermLine = { ts: string; level: string; kind: string; rest: string; raw: string };
  export function parseLine(raw: string): TermLine | null;
  export function pickWindow(text: string, endKind: string, n: number): TermLine[];   // n lines ending at the last line of endKind
  export function pickByKinds(text: string, kinds: string[], n: number): TermLine[]; // last n lines with kind in kinds
  export function guard(lines: TermLine[]): TermLine[];                              // throws on a bare 64-hex value that is not tx=
  ```
- `terminal.html` exposes `window.render({ panes: [{ title, lines: TermLine[] }], intervalMs }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`video/test/logs.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, pickWindow, pickByKinds, guard } from "../logs.ts";

const LOG = [
  "2026-09-11T14:23:05.522Z info  scan      live=27 tradable=10 nav=65.318796 budget=55.318796 session_ends_in_s=4195",
  '2026-09-11T14:23:09.336Z info  signal    market=ETH-5m@14:25 strategy=momentum p=0.369 rule="up +3.8pt/30s" side=BUY_YES price=0.385 qty=38.961 cost=14.999985',
  "2026-09-11T14:23:11.249Z info  sent      market=ETH-5m@14:25 side=BUY_YES tx=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996",
  "2026-09-11T14:23:11.629Z info  filled    market=ETH-5m@14:25 side=BUY_YES cash_delta=-12.701286 gas_used=490215 tx=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996",
  "2026-09-11T14:24:11.574Z warn  nofill    market=ETH-5m@14:25 side=BUY_YES gas_used=109233 tx=0xb815d5d5047b20dc0891ffecbaf489963e3c36739c899a0099870f6b6df29dfa",
].join("\n");

test("parseLine splits timestamp, level, kind and the rest", () => {
  const l = parseLine(LOG.split("\n")[1])!;
  assert.equal(l.ts, "2026-09-11T14:23:09.336Z");
  assert.equal(l.level, "info");
  assert.equal(l.kind, "signal");
  assert.match(l.rest, /^market=ETH-5m@14:25 strategy=momentum/);
  assert.equal(parseLine("garbage"), null);
});

test("pickWindow ends at the last `filled` and keeps the lines before it", () => {
  const w = pickWindow(LOG, "filled", 3);
  assert.deepEqual(w.map((l) => l.kind), ["signal", "sent", "filled"]);
});

test("pickByKinds keeps only the listed kinds, most recent last", () => {
  assert.deepEqual(pickByKinds(LOG, ["scan", "nofill"], 5).map((l) => l.kind), ["scan", "nofill"]);
  assert.deepEqual(pickByKinds(LOG, ["scan", "nofill"], 1).map((l) => l.kind), ["nofill"]);
});

test("guard passes tx= hashes and refuses a bare 64-hex value", () => {
  assert.equal(guard(pickWindow(LOG, "filled", 4)).length, 4);
  const bad = parseLine("2026-09-11T14:23:11.249Z info  boot      key=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996")!;
  assert.throws(() => guard([bad]), /refusing to render/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test video/test/logs.test.ts`
Expected: FAIL — cannot find `../logs.ts`.

- [ ] **Step 3: Write `video/logs.ts`**

```ts
/** Picks verbatim lines out of the bots' logfmt logs for the terminal shots. */
export type TermLine = { ts: string; level: string; kind: string; rest: string; raw: string };

const LINE = /^(\S+Z) (\w+)\s+(\S+)\s*(.*)$/;

export function parseLine(raw: string): TermLine | null {
  const m = LINE.exec(raw);
  if (!m) return null;
  return { ts: m[1], level: m[2], kind: m[3], rest: m[4], raw };
}

function parsed(text: string): TermLine[] {
  return text.split("\n").map(parseLine).filter((l): l is TermLine => l !== null);
}

export function pickWindow(text: string, endKind: string, n: number): TermLine[] {
  const lines = parsed(text);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].kind === endKind) { end = i; break; }
  if (end < 0) throw new Error(`no "${endKind}" line in the log — the runbook says pick another agent`);
  return lines.slice(Math.max(0, end - n + 1), end + 1);
}

export function pickByKinds(text: string, kinds: string[], n: number): TermLine[] {
  const set = new Set(kinds);
  const hits = parsed(text).filter((l) => set.has(l.kind));
  if (hits.length === 0) throw new Error(`no line of kind ${kinds.join("|")} in the log`);
  return hits.slice(-n);
}

/** Keys are never logged, but a shot is the one place a leak would be permanent. */
export function guard(lines: TermLine[]): TermLine[] {
  for (const l of lines) {
    const stripped = l.rest.replace(/\btx=0x[0-9a-fA-F]{64}\b/g, "");
    if (/0x[0-9a-fA-F]{64}/.test(stripped)) throw new Error(`refusing to render a 64-hex value that is not a tx hash: ${l.raw.slice(0, 80)}…`);
  }
  return lines;
}
```

- [ ] **Step 4: Run the test**

Run: `node --experimental-strip-types --test video/test/logs.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Write `video/terminal.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>terminal</title>
<style>
  :root { --bg:#0D1118; --panel:#0A0E14; --line:#242B35; --fg:#F0F3EC; --muted:#78868F; --dim:#9AA6AC; --cyan:#61D8E8; --amber:#F2C14E; --red:#F0685E; --green:#7BD88F; }
  html, body { margin:0; width:1920px; height:1080px; background:var(--bg); color:var(--fg); overflow:hidden;
    font: 22px/1.5 "IBM Plex Mono", "JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace; }
  .panes { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:24px; padding:40px; height:1000px; box-sizing:border-box; }
  .pane { background:var(--panel); border:1px solid var(--line); border-radius:10px; display:flex; flex-direction:column; min-width:0; }
  .bar { display:flex; align-items:center; gap:10px; padding:12px 18px; border-bottom:1px solid var(--line); color:var(--dim); font-size:18px; }
  .dot { width:12px; height:12px; border-radius:50%; background:var(--line); }
  .dot:first-child { background:#F0685E } .dot:nth-child(2) { background:#F2C14E } .dot:nth-child(3) { background:#7BD88F }
  .title { margin-left:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .body { padding:16px 20px; overflow:hidden; flex:1; }
  .l { white-space:pre-wrap; word-break:break-word; opacity:0; transform:translateY(4px); transition:opacity .18s ease, transform .18s ease; }
  .l.on { opacity:1; transform:none; }
  .ts { color:var(--muted); } .lv { font-weight:700; } .lv.info { color:var(--cyan); } .lv.warn { color:var(--amber); } .lv.error { color:var(--red); }
  .k { color:var(--fg); font-weight:700; } .key { color:var(--dim); } .val { color:var(--fg); } .q { color:var(--green); }
  .cursor { display:inline-block; width:11px; height:24px; background:var(--fg); vertical-align:-4px; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity:0 } }
</style>
<div class="panes" id="panes"></div>
<script>
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function fmtRest(rest) {
    // key=value pairs; quoted values in green, like the eye expects from logfmt.
    return rest.replace(/(\S+?)=("[^"]*"|\S+)/g, (_, k, v) =>
      `<span class="key">${esc(k)}=</span><span class="${v.startsWith('"') ? "q" : "val"}">${esc(v)}</span>`);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.render = async ({ panes, intervalMs = 350 }) => {
    const root = document.getElementById("panes");
    root.innerHTML = "";
    const bodies = panes.map((p) => {
      const el = document.createElement("div"); el.className = "pane";
      el.innerHTML = `<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="title">${esc(p.title)}</span></div><div class="body"></div>`;
      root.appendChild(el);
      const body = el.querySelector(".body");
      body.innerHTML = `<div class="l on"><span class="ts">$</span> ${esc(p.title)}</div>`;
      return body;
    });
    const max = Math.max(...panes.map((p) => p.lines.length));
    for (let i = 0; i < max; i++) {
      panes.forEach((p, pi) => {
        const l = p.lines[i]; if (!l) return;
        const div = document.createElement("div"); div.className = "l";
        div.innerHTML = `<span class="ts">${esc(l.ts)}</span> <span class="lv ${esc(l.level)}">${esc(l.level.padEnd(5))}</span> <span class="k">${esc(l.kind.padEnd(9))}</span> ${fmtRest(l.rest)}`;
        bodies[pi].appendChild(div);
        requestAnimationFrame(() => div.classList.add("on"));
        bodies[pi].scrollTop = bodies[pi].scrollHeight;
      });
      await sleep(intervalMs);
    }
    bodies.forEach((b) => { const c = document.createElement("div"); c.className = "l on"; c.innerHTML = '<span class="cursor"></span>'; b.appendChild(c); });
  };
</script>
```

- [ ] **Step 6: Write `video/preview.ts` and look at the result**

```ts
/** Screenshots the terminal and the two cards so a human can look before the take. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { OUT_DIR, VIDEO_DIR, readTake } from "./script.ts";
import { guard, pickByKinds, pickWindow } from "./logs.ts";

const LOGS = path.join(VIDEO_DIR, "..", ".data", "logs");
const take = readTake();
const dir = path.join(OUT_DIR, "preview");
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const runner = fs.readFileSync(path.join(LOGS, `runner-${take.agent.slug}.log`), "utf8");
await page.goto("file://" + path.join(VIDEO_DIR, "terminal.html"));
await page.evaluate((data) => (window as any).render(data), {
  intervalMs: 0,
  panes: [{ title: `AGENT_SLUG=${take.agent.slug} node --experimental-strip-types bots/runner.ts`, lines: guard(pickWindow(runner, "filled", 8)) }],
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(dir, "terminal-runner.png") });

const kinds = { A: ["view", "intent", "resting", "filled"], B: ["view", "refuse", "hold"], C: ["view", "intent", "error"] }[take.case];
await page.evaluate((data) => (window as any).render(data), {
  intervalMs: 0,
  panes: ["backer", "skeptic"].map((t) => ({ title: `AGENT_THESIS=${t} npm run speculator`, lines: guard(pickByKinds(fs.readFileSync(path.join(LOGS, `speculator-${t}.log`), "utf8"), kinds, 6)) })),
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(dir, "terminal-speculators.png") });

for (const name of ["title", "end"] as const) {
  await page.goto("file://" + path.join(VIDEO_DIR, "cards.html"));
  await page.evaluate((n) => (window as any).render({ card: n }), name);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `card-${name}.png`) });
}
await browser.close();
console.log("previews in", dir);
```

Run (after Task 5 adds `cards.html`; for now expect the terminal PNGs and a cards error): `node --experimental-strip-types video/preview.ts`
Expected: `video/out/preview/terminal-runner.png` and `terminal-speculators.png` exist. Open them with the Read tool: 8 runner lines ending in `filled`; two panes with 6 lines each; nothing clipped horizontally; text legible.

- [ ] **Step 7: Commit**

```bash
git add video/logs.ts video/terminal.html video/preview.ts video/test/logs.test.ts
git commit -m "feat(video): render verbatim runner and speculator log lines as terminal shots"
```

---

### Task 5: `video/cards.html` — title and end cards

**Files:**
- Create: `video/cards.html`

**Interfaces:**
- `window.render({ card: "title" | "end" })`.

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<meta charset="utf-8">
<title>cards</title>
<style>
  :root { --bg:#0D1118; --fg:#F0F3EC; --muted:#9AA6AC; --subtle:#78868F; --line:#242B35; --cyan:#61D8E8; }
  html, body { margin:0; width:1920px; height:1080px; background:var(--bg); color:var(--fg); overflow:hidden;
    font-family: "Inter", "Inter Display", "DM Sans", ui-sans-serif, system-ui, sans-serif; }
  .card { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; padding:0 160px; box-sizing:border-box; opacity:0; transition:opacity .35s ease; }
  .card.on { opacity:1; }
  .eyebrow { display:flex; align-items:center; gap:14px; color:var(--cyan); font: 600 20px/1 ui-monospace, "IBM Plex Mono", "DejaVu Sans Mono", monospace; letter-spacing:.14em; text-transform:uppercase; }
  .eyebrow::before { content:""; width:40px; height:2px; background:var(--cyan); }
  h1 { font-family:"Inter Display", "Inter", sans-serif; font-size:128px; line-height:1; letter-spacing:-.045em; margin:28px 0 22px; font-weight:600; }
  .sub { font-size:44px; line-height:1.25; color:var(--muted); max-width:24ch; letter-spacing:-.01em; }
  .foot { position:absolute; left:160px; right:160px; bottom:96px; display:flex; justify-content:space-between; align-items:flex-end; border-top:1px solid var(--line); padding-top:28px; color:var(--subtle); font: 22px/1.4 ui-monospace, "IBM Plex Mono", "DejaVu Sans Mono", monospace; }
  .links { display:grid; gap:14px; font: 30px/1.2 ui-monospace, "IBM Plex Mono", "DejaVu Sans Mono", monospace; color:var(--fg); margin-top:40px; }
  .links span { color:var(--subtle); }
</style>
<div class="card" id="title">
  <div class="eyebrow">Somnia × DreamDEX Event Contracts Hackathon</div>
  <h1>Meta-Agent DEX</h1>
  <div class="sub">Agents trade. Other agents price the traders.</div>
  <div class="foot"><span>Native DreamDEX Event Contracts · Somnia Shannon testnet</span><span>Every order on both layers is signed by a program</span></div>
</div>
<div class="card" id="end">
  <div class="eyebrow">Every number in this video is on /audit</div>
  <h1>Meta-Agent DEX</h1>
  <div class="links">
    <div><span>live &nbsp;</span>meta-agent.mdloglabs.org</div>
    <div><span>code &nbsp;</span>github.com/mdlog/meta-agent-dex</div>
  </div>
  <div class="foot"><span>Somnia × DreamDEX Event Contracts Hackathon</span><span>Somnia Shannon testnet · chain 50312</span></div>
</div>
<script>
  window.render = ({ card }) => {
    document.querySelectorAll(".card").forEach((c) => c.classList.toggle("on", c.id === card));
    return new Promise((r) => setTimeout(r, 400));
  };
</script>
```

- [ ] **Step 2: Preview and look**

Run: `node --experimental-strip-types video/preview.ts`
Expected: `video/out/preview/card-title.png` and `card-end.png`. Read both: headline not clipped, footer inside the frame, no fallback serif font.

- [ ] **Step 3: Commit**

```bash
git add video/cards.html
git commit -m "feat(video): title and end cards"
```

---

### Task 6: `video/tts.py` — narration audio with word timings and the length rule

**Files:**
- Create: `video/tts.py`
- Test: `video/test/test_tts.py`

**Interfaces:**
- Produces `video/out/audio/NN-<id>.mp3`, `NN-<id>.words.json` (`[{start, end, text}]` seconds), and `video/out/audio/index.json`:
  ```json
  [{"id": "01-what-this-is", "mp3": "01-what-this-is.mp3", "words": "01-what-this-is.words.json",
    "delayMs": 500, "minVisualMs": 12000, "audioS": 24.9, "segmentS": 25.8}]
  ```
  `segmentS = max(audioS + delayMs/1000 + 0.4, minVisualMs/1000)`; the recorder holds each beat to `segmentS` and `build.py` trims to it.
- Pure helper `segment_seconds(audio_s, delay_ms, min_visual_ms)` and `apply_rule(total_s, rate)` for tests.

- [ ] **Step 1: Write the failing test**

`video/test/test_tts.py`:
```python
import sys, pathlib, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import tts

class Rules(unittest.TestCase):
    def test_segment_is_audio_plus_gap_or_visual_minimum(self):
        self.assertAlmostEqual(tts.segment_seconds(24.9, 500, 12000), 25.8)
        self.assertAlmostEqual(tts.segment_seconds(6.0, 0, 12000), 12.0)

    def test_length_rule(self):
        self.assertEqual(tts.apply_rule(170.0, "+0%"), ("ok", "+0%"))
        self.assertEqual(tts.apply_rule(175.0, "+0%"), ("rerender", "+6%"))
        self.assertEqual(tts.apply_rule(175.0, "+6%"), ("cut", "+6%"))

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest discover -s video/test -p "test_*.py"`
Expected: FAIL — `No module named 'tts'`.

- [ ] **Step 3: Write `video/tts.py`**

```python
#!/usr/bin/env python3
"""Narration via edge-tts, one file per beat, with word boundaries for captions.

Runs the spec's length rule: > 172 s at +0% -> re-render at +6%; still over ->
stop and print the cut list, because a faster voice would cost the judges more
than a shorter script does.
"""
import asyncio, json, pathlib, subprocess, sys

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out" / "audio"
VOICE = "en-US-AndrewNeural"
GAP_S = 0.4
LIMIT_S = 172.0
CUT_LIST = [
    'Beat 3: "What is on this book came from the processes you just saw:" -> "That is"',
    'Beat 4: drop "visible to anyone and counted by nothing"',
    'Beat 6: drop "the first meta-market we minted,"',
    'Beat 2: drop "It cannot withdraw."',
]

def segment_seconds(audio_s: float, delay_ms: int, min_visual_ms: int) -> float:
    return max(audio_s + delay_ms / 1000 + GAP_S, min_visual_ms / 1000)

def apply_rule(total_s: float, rate: str):
    if total_s <= LIMIT_S:
        return ("ok", rate)
    if rate == "+0%":
        return ("rerender", "+6%")
    return ("cut", rate)

def narration():
    raw = subprocess.check_output(["node", "--experimental-strip-types", str(VIDEO / "script.ts"), "--narration"], text=True)
    return json.loads(raw)

def duration_s(mp3: pathlib.Path) -> float:
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)], text=True)
    return float(out.strip())

async def synth(text: str, mp3: pathlib.Path, rate: str):
    import edge_tts
    words = []
    com = edge_tts.Communicate(text, VOICE, rate=rate)
    with mp3.open("wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({"start": chunk["offset"] / 1e7, "end": (chunk["offset"] + chunk["duration"]) / 1e7, "text": chunk["text"]})
    return words

async def render(rate: str):
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for i, beat in enumerate(narration(), start=1):
        base = f"{beat['id']}"
        mp3 = OUT / f"{base}.mp3"
        for attempt in range(3):
            try:
                words = await synth(beat["text"], mp3, rate)
                break
            except Exception as e:  # network hiccup: retry, then give up loudly
                if attempt == 2:
                    raise
                print(f"  {base}: {e!r}; retrying", file=sys.stderr)
                await asyncio.sleep(2 * (attempt + 1))
        (OUT / f"{base}.words.json").write_text(json.dumps(words, indent=1))
        audio_s = duration_s(mp3)
        seg = segment_seconds(audio_s, beat["delayMs"], beat["minVisualMs"])
        index.append({"id": beat["id"], "mp3": mp3.name, "words": f"{base}.words.json", "delayMs": beat["delayMs"],
                      "minVisualMs": beat["minVisualMs"], "audioS": round(audio_s, 3), "segmentS": round(seg, 3), "rate": rate})
        print(f"  {base}: {audio_s:6.2f}s speech -> {seg:6.2f}s segment")
    return index

def main():
    rate = "+0%"
    while True:
        print(f"rendering at rate {rate}")
        index = asyncio.run(render(rate))
        total = sum(b["segmentS"] for b in index)
        print(f"total {total:.1f}s (limit {LIMIT_S:.0f}s)")
        verdict, rate = apply_rule(total, rate)
        if verdict == "ok":
            break
        if verdict == "cut":
            print("still over after +6%. Apply the cut list, in order, in video/script.ts:")
            for c in CUT_LIST:
                print("  -", c)
            sys.exit(2)
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print("wrote", OUT / "index.json")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the unit test, then the real render**

Run: `python3 -m unittest discover -s video/test -p "test_*.py"` → 2 passing.
Run: `python3 video/tts.py`
Expected: six lines of per-beat durations, a total ≤ 172 s (or one re-render at +6%), and `video/out/audio/index.json`. Listen-check is not possible here; instead confirm `ffprobe` durations are plausible (Beat 1 ≈ 24–28 s) and that each `.words.json` has > 40 entries.

- [ ] **Step 5: Commit**

```bash
git add video/tts.py video/test/test_tts.py
git commit -m "feat(video): edge-tts narration with word timings and the length rule"
```

---

### Task 7: `video/record.ts` — Playwright recorder with `--probe`

**Files:**
- Create: `video/record.ts`

**Interfaces:**
- Consumes: `beats(take)` from `script.ts`; `out/audio/index.json` (segment lengths, word timings); `logs.ts`.
- Produces: `video/out/clips/NN-<id>.webm` and `video/out/clips/index.json`:
  ```json
  [{"id": "01-what-this-is", "clip": "01-what-this-is.webm", "recordedS": 26.3,
    "routes": [{"atS": 0, "route": ""}, {"atS": 3.1, "route": "/"}]}]
  ```
  `route: ""` hides the chip (cards, terminal).
- `--probe`: runs every action with zero waits, no video, and reports the selectors that did not resolve; exit 1 if any.

- [ ] **Step 1: Write `video/record.ts`**

```ts
/**
 * Drives the live app through the six beats and records one clip per beat.
 * Waits are driven by the narration: an action with `at` does not start until
 * the TTS reaches that phrase, and every beat is held to its segment length so
 * build.py never has to freeze a frame.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type BrowserContext } from "playwright";
import { beats, readTake, OUT_DIR, VIDEO_DIR, PUBLIC_HOST, type Action, type TerminalPane } from "./script.ts";
import { guard, pickByKinds, pickWindow } from "./logs.ts";

const PROBE = process.argv.includes("--probe");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const LOGS = path.join(VIDEO_DIR, "..", ".data", "logs");
const CLIPS = path.join(OUT_DIR, "clips");
const RAW = path.join(OUT_DIR, "raw");
const NAV_TIMEOUT = 20_000;

type AudioRow = { id: string; words: string; delayMs: number; segmentS: number };
type Word = { start: number; end: number; text: string };

const CURSOR = `
  (() => {
    const make = () => {
      if (document.getElementById("__cursor")) return;
      const c = document.createElement("div"); c.id = "__cursor";
      c.style.cssText = "position:fixed;left:-100px;top:-100px;width:22px;height:22px;border:3px solid #61D8E8;border-radius:50%;box-shadow:0 0 0 2px rgba(13,17,24,.85);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform .12s ease;";
      document.documentElement.appendChild(c);
      document.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
      document.addEventListener("mousedown", () => { c.style.transform = "translate(-50%,-50%) scale(.6)"; }, true);
      document.addEventListener("mouseup", () => { c.style.transform = "translate(-50%,-50%)"; }, true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make); else make();
  })();`;

function norm(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

/** Seconds from narration start at which `phrase` begins, per the TTS word boundaries. */
function phraseStart(words: Word[], phrase: string): number {
  const target = norm(phrase).split(" ");
  const toks = words.map((w) => norm(w.text));
  for (let i = 0; i + target.length <= toks.length; i++) {
    if (target.every((t, k) => toks[i + k] === t)) return words[i].start;
  }
  throw new Error(`phrase not found in narration: "${phrase}"`);
}

function terminalData(panes: TerminalPane[]) {
  return {
    intervalMs: 350,
    panes: panes.map((p) => {
      const text = fs.readFileSync(path.join(LOGS, p.log), "utf8");
      const lines = p.mode === "window" ? pickWindow(text, "filled", p.lines) : pickByKinds(text, p.kinds, p.lines);
      return { title: p.title, lines: guard(lines) };
    }),
  };
}

async function settled(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});
  const bad = await page.evaluate(() => {
    const t = document.body.innerText;
    return t.includes("SIMULATED DATA") ? "SIMULATED DATA" : t.includes("could not load") ? "could not load" : t.includes("404") && t.includes("not be found") ? "404" : null;
  });
  if (bad) throw new Error(`not filmable: page shows "${bad}" at ${page.url()}`);
}

async function main() {
  const take = readTake();
  const audio: AudioRow[] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "audio", "index.json"), "utf8"));
  const wordsOf = (id: string): Word[] => JSON.parse(fs.readFileSync(path.join(OUT_DIR, "audio", audio.find((a) => a.id === id)!.words), "utf8"));
  fs.mkdirSync(CLIPS, { recursive: true });
  fs.mkdirSync(RAW, { recursive: true });

  const browser = await chromium.launch();
  const index: { id: string; clip: string; recordedS: number; routes: { atS: number; route: string }[] }[] = [];
  const missing: string[] = [];

  for (const beat of beats(take)) {
    if (ONLY && beat.id !== ONLY) continue;
    const row = audio.find((a) => a.id === beat.id);
    if (!row) throw new Error(`no audio for ${beat.id}; run tts.py first`);
    const words = wordsOf(beat.id);
    const delayS = row.delayMs / 1000;

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "no-preference",
      ...(PROBE ? {} : { recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } } }),
    });
    await context.addInitScript(CURSOR);
    const page = await context.newPage();
    const t0 = Date.now();
    const elapsedS = () => (Date.now() - t0) / 1000;
    const routes: { atS: number; route: string }[] = [];
    const setRoute = (route: string) => routes.push({ atS: Number(elapsedS().toFixed(2)), route });
    const wait = (ms: number) => (PROBE ? Promise.resolve() : page.waitForTimeout(ms));
    const loc = (sel: string) => page.locator(sel).first();

    console.log(`\n▶ ${beat.id} (${PROBE ? "probe" : `hold ${row.segmentS}s`})`);
    for (const a of beat.actions) {
      if (a.at && !PROBE) {
        const startS = delayS + phraseStart(words, a.at);
        const dt = startS - elapsedS();
        if (dt > 0) await page.waitForTimeout(dt * 1000);
      }
      try {
        switch (a.kind) {
          case "card":
            setRoute("");
            await page.goto("file://" + path.join(VIDEO_DIR, "cards.html"));
            await page.evaluate((n) => (window as any).render({ card: n }), a.name);
            await wait(a.ms);
            break;
          case "goto":
            await page.goto(take.base + a.path, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
            await settled(page);
            setRoute(a.route);
            await page.mouse.move(960, 540);
            break;
          case "wait":
            await wait(a.ms);
            break;
          case "hover":
            await loc(a.selector).waitFor({ timeout: 8000 });
            await loc(a.selector).scrollIntoViewIfNeeded();
            await loc(a.selector).hover({ steps: PROBE ? 1 : 25 });
            await wait(a.ms ?? 1500);
            break;
          case "click":
            await loc(a.selector).waitFor({ timeout: 8000 });
            await loc(a.selector).hover({ steps: PROBE ? 1 : 20 });
            await wait(400);
            await loc(a.selector).click();
            await settled(page);
            setRoute(a.route);
            await wait(1200);
            break;
          case "scrollTo":
            await loc(a.selector).waitFor({ timeout: 8000 });
            await loc(a.selector).evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
            await wait(a.ms ?? 1500);
            break;
          case "explorer": {
            const href = await loc(a.selector).getAttribute("href");
            if (!href) throw new Error(`no href on ${a.selector}`);
            await loc(a.selector).hover({ steps: PROBE ? 1 : 20 });
            await wait(600);
            if (!PROBE) {
              const ok = await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).then(() => true).catch(() => false);
              if (ok) setRoute(new URL(href).host + new URL(href).pathname.replace(/(0x[0-9a-f]{8})[0-9a-f]+/i, "$1…"));
              else console.warn("  explorer did not load in time; holding on the tape instead");
            }
            await wait(a.ms);
            break;
          }
          case "terminal":
            setRoute("");
            await page.goto("file://" + path.join(VIDEO_DIR, "terminal.html"));
            await page.evaluate((d) => (window as any).render(d), { ...terminalData(a.panes), intervalMs: PROBE ? 0 : 350 });
            await wait(a.ms);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (PROBE && "selector" in a) { missing.push(`${beat.id}: ${a.kind} ${(a as { selector: string }).selector} — ${msg.split("\n")[0]}`); continue; }
        await context.close();
        await browser.close();
        throw new Error(`${beat.id} / ${a.kind}: ${msg}`);
      }
    }

    if (!PROBE) {
      const holdS = row.segmentS + 0.3 - elapsedS();
      if (holdS > 0) await page.waitForTimeout(holdS * 1000);
      const recordedS = elapsedS();
      const video = page.video();
      await context.close();
      const raw = await video!.path();
      const clip = `${beat.id}.webm`;
      fs.renameSync(raw, path.join(CLIPS, clip));
      index.push({ id: beat.id, clip, recordedS: Number(recordedS.toFixed(2)), routes });
      console.log(`  recorded ${recordedS.toFixed(1)}s → ${clip}`);
    } else {
      await context.close();
    }
  }
  await browser.close();

  if (PROBE) {
    if (missing.length) { console.error("\nunresolved selectors:\n  " + missing.join("\n  ")); process.exit(1); }
    console.log("\nprobe ok: every selector resolved");
    return;
  }
  const prev = fs.existsSync(path.join(CLIPS, "index.json")) && ONLY ? JSON.parse(fs.readFileSync(path.join(CLIPS, "index.json"), "utf8")) : [];
  const merged = [...prev.filter((p: { id: string }) => !index.some((n) => n.id === p.id)), ...index].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(CLIPS, "index.json"), JSON.stringify(merged, null, 1));
  console.log("\nwrote", path.join(CLIPS, "index.json"), "public host for the chip:", PUBLIC_HOST);
}

main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
```

- [ ] **Step 2: Probe**

Run: `node --experimental-strip-types video/record.ts --probe`
Expected: `probe ok: every selector resolved`. If it lists unresolved selectors, fix them **in `script.ts`** by reading the component (`grep -rn "<text>" src/`) — the copy on screen wins, never the other way round. Typical fixes: the tape hidden behind a tab (add a `click` on the tab before `scrollTo th:has-text("Transaction")`), `text=Resolved` matching a sidebar word (tighten to the pill's element).

- [ ] **Step 3: Record one beat and look at frames**

Run: `node --experimental-strip-types video/record.ts --only=01-what-this-is && ffmpeg -hide_banner -loglevel error -y -i video/out/clips/01-what-this-is.webm -vf "fps=1/3,scale=640:-1,tile=4x3" video/out/preview/beat1-frames.png`
Expected: a contact sheet with the title card, then the hero, the hovered `Reading Somnia`, and the metric strip. Read the PNG. If text is soft, switch `recordVideo` to a `page.screenshot` loop at 30 fps (the spec's fallback) before recording the rest.

- [ ] **Step 4: Commit**

```bash
git add video/record.ts
git commit -m "feat(video): playwright recorder driven by the narration's word timings"
```

---

### Task 8: `video/captions.py` — ASS + SRT from word timings, plus the route chip

**Files:**
- Create: `video/captions.py`
- Test: `video/test/test_captions.py`

**Interfaces:**
- Consumes: `out/audio/index.json` (+ words files), `out/clips/index.json` (routes).
- Produces: `out/captions.ass`, `out/captions.srt`, `out/timeline.json` (`[{id, startS, segmentS}]`).
- Pure: `cues(words, offset_s, delay_s, max_chars=42, max_lines=2, min_s=1.2) -> list[dict(start,end,text)]`.

- [ ] **Step 1: Write the failing test**

`video/test/test_captions.py`:
```python
import sys, pathlib, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import captions

def W(text, t0=0.0, dt=0.3):
    out, t = [], t0
    for w in text.split():
        out.append({"start": t, "end": t + dt, "text": w}); t += dt + 0.05
    return out

class Cues(unittest.TestCase):
    def test_lines_never_exceed_42_chars_and_cues_two_lines(self):
        cs = captions.cues(W("AI agents trade real DreamDEX Event Contracts on Somnia. You can't verify a bot's track record from a screenshot, and nobody could put a price on one."), 0.0, 0.0)
        for c in cs:
            lines = c["text"].split("\\N")
            self.assertLessEqual(len(lines), 2)
            for l in lines: self.assertLessEqual(len(l), 42, l)

    def test_cues_break_at_sentence_end_and_are_offset(self):
        cs = captions.cues(W("Short one. Then another short one."), 10.0, 0.5)
        self.assertEqual(cs[0]["text"], "Short one.")
        self.assertAlmostEqual(cs[0]["start"], 10.5, places=2)

    def test_min_duration_is_enforced_without_overlap(self):
        cs = captions.cues(W("A b. C d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd."), 0.0, 0.0)
        for a, b in zip(cs, cs[1:]):
            self.assertLessEqual(a["end"], b["start"] + 1e-6)
        self.assertGreaterEqual(cs[-1]["end"] - cs[-1]["start"], 1.2)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest discover -s video/test -p "test_*.py"`
Expected: FAIL — `No module named 'captions'`.

- [ ] **Step 3: Write `video/captions.py`**

```python
#!/usr/bin/env python3
"""Burned-in captions (ASS) and the upload SRT, from edge-tts word boundaries.
Also writes the route chip events and the segment timeline build.py consumes."""
import json, pathlib

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out"
PUBLIC_HOST = "meta-agent.mdloglabs.org"

def _flush(lines, start, end, out):
    if lines:
        out.append({"start": start, "end": end, "text": "\\N".join(lines)})

def cues(words, offset_s, delay_s, max_chars=42, max_lines=2, min_s=1.2):
    """Greedy: fill a line to max_chars, a cue to max_lines, and always end a cue
    at sentence-final punctuation so a thought is never split across cards."""
    out, lines, cur, start = [], [], "", None
    for w in words:
        t = w["text"]
        if start is None:
            start = offset_s + delay_s + w["start"]
        if cur and len(cur) + 1 + len(t) > max_chars:
            lines.append(cur); cur = ""
            if len(lines) == max_lines:
                _flush(lines, start, offset_s + delay_s + prev_end, out)
                lines, start = [], offset_s + delay_s + w["start"]
        cur = (cur + " " + t).strip()
        prev_end = w["end"]
        if t.endswith((".", "?", "!")):
            lines.append(cur); cur = ""
            _flush(lines, start, offset_s + delay_s + prev_end, out)
            lines, start = [], None
    if cur:
        lines.append(cur)
    if lines:
        _flush(lines, start, offset_s + delay_s + prev_end, out)
    # minimum readable duration, without overlapping the next cue
    for i, c in enumerate(out):
        want = c["start"] + min_s
        nxt = out[i + 1]["start"] if i + 1 < len(out) else float("inf")
        c["end"] = max(c["end"], min(want, nxt))
    return out

def ass_time(s):
    h, rem = divmod(s, 3600); m, sec = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{sec:05.2f}"

def srt_time(s):
    h, rem = divmod(s, 3600); m, sec = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(sec):02d},{int(round((sec - int(sec)) * 1000)):03d}"

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter,40,&H00F3F0EC,&H00FFFFFF,&H00000000,&H8C000000,0,0,0,0,100,100,0,0,3,0,0,2,200,200,64,1
Style: Chip,DejaVu Sans Mono,24,&H00ECF3F0,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,0,0,9,0,28,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

def main():
    audio = json.loads((OUT / "audio" / "index.json").read_text())
    clips = {c["id"]: c for c in json.loads((OUT / "clips" / "index.json").read_text())}
    timeline, events, srt, t = [], [], [], 0.0
    for row in audio:
        words = json.loads((OUT / "audio" / row["words"]).read_text())
        for c in cues(words, t, row["delayMs"] / 1000):
            events.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'])},Cap,,0,0,0,,{c['text']}")
            srt.append((c["start"], c["end"], c["text"].replace("\\N", "\n")))
        routes = clips[row["id"]]["routes"]
        for i, r in enumerate(routes):
            if not r["route"]:
                continue
            end = routes[i + 1]["atS"] if i + 1 < len(routes) else row["segmentS"]
            label = r["route"] if "." in r["route"].split("/")[0] else PUBLIC_HOST + r["route"]
            events.append(f"Dialogue: 1,{ass_time(t + r['atS'])},{ass_time(t + end)},Chip,,0,0,0,,{label}")
        timeline.append({"id": row["id"], "startS": round(t, 3), "segmentS": row["segmentS"]})
        t += row["segmentS"]
    (OUT / "captions.ass").write_text(HEADER + "\n".join(events) + "\n")
    (OUT / "captions.srt").write_text("".join(f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{txt}\n\n" for i, (a, b, txt) in enumerate(srt, 1)))
    (OUT / "timeline.json").write_text(json.dumps(timeline, indent=1))
    print(f"{len(srt)} cues, total {t:.1f}s -> captions.ass / captions.srt / timeline.json")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests, then the real thing**

Run: `python3 -m unittest discover -s video/test -p "test_*.py"` → 5 passing (2 tts + 3 captions).
Run: `python3 video/captions.py` → `N cues, total ≤ 180s`.

- [ ] **Step 5: Commit**

```bash
git add video/captions.py video/test/test_captions.py
git commit -m "feat(video): captions and route chip from the narration's word timings"
```

---

### Task 9: `video/build.py` — ffmpeg assembly and the checks

**Files:**
- Create: `video/build.py`

**Interfaces:**
- Consumes: `out/clips/*.webm`, `out/audio/*.mp3`, `out/timeline.json`, `out/captions.ass`.
- Produces: `out/meta-agent-dex-demo.mp4`, `out/meta-agent-dex-demo.srt` (copy of `captions.srt`), `out/contact.png`.

- [ ] **Step 1: Write `video/build.py`**

```python
#!/usr/bin/env python3
"""Trims each clip to its segment, muxes its narration, concatenates, burns the
captions and the route chip, and refuses to emit anything over 3:00."""
import json, pathlib, shutil, subprocess, sys

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out"
SEG = OUT / "seg"
FINAL = OUT / "meta-agent-dex-demo.mp4"
LIMIT_S = 180.0

def run(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)

def probe(path, stream="format=duration"):
    return subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", stream, "-of", "csv=p=0", str(path)], text=True).strip()

def main():
    timeline = json.loads((OUT / "timeline.json").read_text())
    audio = {a["id"]: a for a in json.loads((OUT / "audio" / "index.json").read_text())}
    clips = {c["id"]: c for c in json.loads((OUT / "clips" / "index.json").read_text())}
    SEG.mkdir(exist_ok=True)
    parts = []
    for row in timeline:
        i, seg_s = row["id"], row["segmentS"]
        clip = OUT / "clips" / clips[i]["clip"]
        rec_s = float(probe(clip))
        if rec_s + 0.05 < seg_s:
            sys.exit(f"{i}: clip is {rec_s:.2f}s but the segment needs {seg_s:.2f}s — re-record it (record.ts --only={i})")
        delay_ms = audio[i]["delayMs"]
        out = SEG / f"{i}.mp4"
        run("-i", str(clip), "-i", str(OUT / "audio" / audio[i]["mp3"]),
            "-filter_complex",
            f"[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,trim=duration={seg_s},setpts=PTS-STARTPTS[v];"
            f"[1:a]aresample=48000,adelay={delay_ms}|{delay_ms},apad,atrim=duration={seg_s},asetpts=PTS-STARTPTS[a]",
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(out))
        parts.append(out)
        print(f"  {i}: {seg_s:.2f}s")
    lst = SEG / "list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts))
    concat = SEG / "concat.mp4"
    run("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(concat))
    # burn captions: run from OUT so the ass filter gets a plain relative path
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(concat.relative_to(OUT)),
                    "-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-c:a", "copy", "-movflags", "+faststart", FINAL.name], cwd=OUT, check=True)
    shutil.copy(OUT / "captions.srt", FINAL.with_suffix(".srt"))
    total = float(probe(FINAL))
    wh = probe(FINAL, "stream=width,height,r_frame_rate")
    run("-i", str(FINAL), "-vf", "fps=1/5,scale=480:-1,tile=6x6", str(OUT / "contact.png"))
    print(f"\n{FINAL.name}: {total:.1f}s, {wh}")
    if total > LIMIT_S:
        sys.exit(f"over the 3:00 ceiling by {total - LIMIT_S:.1f}s — apply the cut list in video/tts.py and re-run tts → record → captions → build")
    print("ok: under 3:00. Contact sheet:", OUT / "contact.png")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Build**

Run: `python3 video/build.py`
Expected: six segment lines, then `meta-agent-dex-demo.mp4: NNN.Ns, 1920,1080,30/1` and `ok: under 3:00`.

- [ ] **Step 3: Verify (spec §10)**

1. Read `video/out/contact.png`: no `SIMULATED DATA` bar, no empty table where the spec expects rows, no 404, captions inside the frame and not overlapping the chip, the chip route matches the page.
2. `grep -c "^[0-9]" video/out/meta-agent-dex-demo.srt` equals `grep -c "Style: Cap" ...` hmm — simpler: `python3 -c "import re;a=open('video/out/captions.ass').read().count(',Cap,');b=open('video/out/meta-agent-dex-demo.srt').read().count('-->');print(a,b);assert a==b"`.
3. `ffprobe -v error -show_entries format=duration -of csv=p=0 video/out/meta-agent-dex-demo.mp4` ≤ 180.
4. Every narrated number: `python3 -c "import json;t=json.load(open('video/out/take.json'));print(t)"` and compare with the narration in `video/out/audio/../..` (`node --experimental-strip-types video/script.ts --narration`).

- [ ] **Step 4: Commit**

```bash
git add video/build.py
git commit -m "feat(video): ffmpeg assembly with the 3:00 ceiling enforced"
```

---

### Task 10: `video/speculators.sh`, the take itself, README

**Files:**
- Create: `video/speculators.sh`
- Modify: `video/README.md` (already has the procedure; add the "what to look at" list)

- [ ] **Step 1: Write `video/speculators.sh`**

```bash
#!/usr/bin/env bash
# on  = restart both speculators quoting (AGENT_WIND_DOWN=0) for the take
# off = back to the launcher's default, redeem-only (AGENT_WIND_DOWN=1)
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  on)  MODE=0 ;;
  off) MODE=1 ;;
  *) echo "usage: bash video/speculators.sh on|off" >&2; exit 64 ;;
esac
pkill -f "bots/speculator.ts" || true
sleep 2
AGENT_WIND_DOWN=$MODE npm run --silent speculators
sleep 3
echo "--- running speculators (want two, AGENT_WIND_DOWN=$MODE):"
for pid in $(pgrep -f "bots/speculator.ts"); do
  printf "  pid %s  " "$pid"; tr '\0' '\n' < "/proc/$pid/environ" | grep -E "^AGENT_(THESIS|WIND_DOWN)=" | paste -sd' '
done
```

- [ ] **Step 2: The take, in order**

```bash
bash video/speculators.sh on
# watch for up to 10 minutes; stop early on the first `resting` or `error order`
timeout 600 tail -n0 -F .data/logs/speculator-backer.log .data/logs/speculator-skeptic.log | grep -m1 -E " (resting|error order|intent) " || true
node --experimental-strip-types video/select.ts
python3 video/tts.py
node --experimental-strip-types video/record.ts --probe
node --experimental-strip-types video/record.ts
python3 video/captions.py
python3 video/build.py
bash video/speculators.sh off
```

Expected: `select.ts` prints the case; `build.py` ends with `ok: under 3:00`; `speculators.sh off` lists two processes with `AGENT_WIND_DOWN=1`.

- [ ] **Step 3: Verify per spec §10 and record the result in the README**

Append to `video/README.md`:
```markdown
## What to look at before sending it

- `out/contact.png` — one frame every 5 s. No SIMULATED DATA bar, no 404, no empty
  table where the narration says there are rows.
- `out/take.json` — the agent, both markets and the Beat-3 case the video claims.
- `out/meta-agent-dex-demo.srt` — read it once; it is exactly what the voice says.
- `pgrep -af bots/speculator.ts` — two processes, both back on AGENT_WIND_DOWN=1.
```

- [ ] **Step 4: Commit**

```bash
git add video/speculators.sh video/README.md
git commit -m "feat(video): speculator toggle for the take and the re-shoot notes"
```

---

## Self-review

**Spec coverage.** §1 deliverable → Task 9. §2 constraints → narration text in Task 2 (verbatim from spec §5), guards in Task 7 (`settled()`), 3:00 rule in Task 9, length rule in Task 6. §3 pipeline files → Tasks 1–10 (build.sh became `build.py`; spec's file table is otherwise matched). §4 selection → Task 3. §5 beats → Task 2 actions; cut list → Task 6 prints it. §6 terminal → Task 4. §7 strings → selectors in Task 2, probe in Task 7. §8 error handling → Tasks 3, 6, 7, 9. §9 speculators → Task 10. §10 verification → Task 9 step 3 and Task 10 step 3. §11 follow-ups → not in scope, unchanged.

**Placeholders.** None: every code step is complete; the only "fix it if" is Task 7 step 2, which names the exact fix location.

**Type consistency.** `Take` fields used in Task 3 (`openQuestion`, `navT0` as formatted string) match Task 2's type. `TerminalPane.mode` is set in Task 2 and consumed in Task 7's `terminalData`. `AudioRow` in Task 7 matches Task 6's `index.json`. `clips/index.json` `routes[].atS` in Task 7 is what Task 8 reads. `timeline.json` fields (`id`, `startS`, `segmentS`) match between Tasks 8 and 9.
