/**
 * The single source of truth for the demo video: six beats, their on-screen
 * actions and their narration. Nothing else under video/ contains narration.
 * Every quoted UI string below was checked against src/ on 2026-09-11 — see the
 * spec's §7 (docs/superpowers/specs/2026-09-11-demo-video-design.md) before
 * changing one, and run `record.ts --probe` after.
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

// Spec §5, verbatim. Variables in braces are filled from the take.
const N = {
  beat1: `AI agents trade real DreamDEX Event Contracts on Somnia. You can't verify a bot's track record from a screenshot, and nobody could put a price on one. Meta-Agent DEX's answer is a second layer: a native Event Contract on whether an agent's session ends with more money than it started — and a second set of agents that trade it. Every transaction here is signed by a program.`,
  beat2: `Every trading agent has its own vault and its own key, and is ranked on sessions it finished — not on what it holds. NAV is nav() on the vault, never a token balance. Here is one of them deciding, one line per decision. The key it holds can call exactly one function on its vault — trade.`,
  beat3shared: `This is the contract on the agent: will {agent} close session {sOpen} with a higher NAV? It is the same market page as any BTC contract, because it is a native DreamDEX Event Contract — minted with scheduleAndCreateMarket on an operator and venue we registered ourselves.`,
  beat3A: `Orders reach this book from the two reference speculator agents we ship — a backer and a skeptic — each reading the same evidence and naming the clause behind its decision. That is a price on an agent's performance that a program staked collateral to state.`,
  beat3B: `The book is empty, and the terminal says why: the two reference speculators we ship — a backer and a skeptic — read the same evidence, and each names the clause that made it refuse. A refusal is a decision, and the first quote to accept this contract is the one that sets its price. Anyone can run one against this venue.`,
  beat3C: `The book is empty, and the terminal says why: the two reference speculators we ship — a backer and a skeptic — priced this contract and signed an order, and the send was rejected. The log shows the error instead of hiding it. The pricing is real, the contract is real, and the rejection is on the record too.`,
  beat4: `NAV is not a balance. Somnia's test collateral has a permissionless faucet — ten thousand per call. If NAV were a token balance, a stranger could forge an agent's profit for free. So nav() counts only collateral a DreamDEX call delivered; anything else lands in unaccounted(). The operator key may only call trade; withdrawals belong to a different owner. Every row in the tape is a real IOC order on a live contract — here is one on the explorer.`,
  beat5: `This session already closed. The vault's own oracle snapshotted NAV before the market existed. At close, redeemAll, closeSession and finalize ran — all three permissionless. finalize writes one number that can never be restated, and 180 seconds after expiry a DreamDEX validator subcommittee read it and voted. {agent} opened at {navT0} and closed at {navT1}; the oracle answered {answer}, and DreamDEX paid the {paid} side. Settlement is defined by code and attested by DreamDEX's oracle committee.`,
  beat6: `Every claim here is a transaction on this page: the operator and venue we registered, and the faucet test — ten thousand tUSDC pushed into a live vault, and nav() moved by exactly zero. Every agent anyone deploys generates a new, machine-resolvable question every session, and DreamDEX settles it on its own rails. Agents trade it, agents price it, a contract measures it — and nothing in that loop waits for somebody to click.`,
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
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
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
          panes: [
            {
              title: `AGENT_SLUG=${slug} node --experimental-strip-types bots/runner.ts`,
              log: `runner-${slug}.log`,
              kinds: ["scan", "signal", "sent", "filled"],
              lines: 8,
              mode: "window",
            },
          ],
        },
        { kind: "goto", path: "/agents", route: "/agents" },
        { kind: "click", selector: rowLink, route: `/agents/${slug}` },
        { kind: "hover", selector: 'a.primary-button:has-text("This session")', ms: 1500 },
        { kind: "click", selector: 'a.primary-button:has-text("This session")', route: open },
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain && process.argv.includes("--narration")) {
  process.stdout.write(JSON.stringify(narrationFor(readTake()), null, 2) + "\n");
}
