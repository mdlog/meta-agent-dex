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
  return (Number(BigInt(raw)) / 1e6).toFixed(2);
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

type SessionRow = { agent: { slug: string; name: string }; session: { sessionNumber: number; metaMarketId: string | null } };
type MarketRes = {
  market: { question: string };
  book: Record<string, unknown> | null;
  onchain: { isResolved: boolean; isVoided: boolean; winningOutcome: "up" | "down" | null } | null;
};
type Sess = { sessionNumber: number; metaMarketId: string; navT0: string; navT1: string; outcomeValue: number; status: string };
type Profile = { sessions: Sess[]; trades: { txHash: string }[] };

async function main() {
  const health = await j<{ mode: string; ok: boolean; explorer: string }>("/api/health");
  if (!health || health.mode !== "live" || !health.ok) throw new Error(`not filmable: /api/health = ${JSON.stringify(health)}`);

  const sessions = await j<{ open: SessionRow[] }>("/api/agents/sessions");
  if (!sessions) throw new Error("not filmable: /api/agents/sessions 404");

  const cands: Candidate[] = [];
  for (const e of sessions.open) {
    const id = e.session.metaMarketId;
    if (!id) continue; // mint has not landed — the runbook says film a different agent
    const market = await j<MarketRes>(`/api/markets/${id}`);
    if (!market) continue; // indexer lag: never film a 404
    const book = market.book ?? {};
    const bookNonEmpty = ["upBids", "upAsks", "downBids", "downAsks"].some((k) => Array.isArray(book[k]) && (book[k] as unknown[]).length > 0);
    const profile = await j<Profile>(`/api/agents/${e.agent.slug}`);
    cands.push({
      slug: e.agent.slug,
      name: e.agent.name,
      sessionNumber: e.session.sessionNumber,
      marketId: id,
      question: market.market.question,
      bookNonEmpty,
      trades: profile?.trades.length ?? 0,
    });
  }
  const pick = choose(cands);

  const profile = (await j<Profile>(`/api/agents/${pick.slug}`))!;
  if (!profile.trades.some((t) => t.txHash)) throw new Error(`not filmable: ${pick.slug} has no trade with a transaction hash`);

  // Beat 5: the most recent settled session of this agent that the chain says is resolved.
  const settledSessions = profile.sessions
    .filter((s) => s.status === "settled")
    .sort((a, b) => b.sessionNumber - a.sessionNumber)
    .slice(0, 5);
  let settled: (Sess & { winning: "up" | "down" }) | null = null;
  for (const s of settledSessions) {
    const m = await j<MarketRes>(`/api/markets/${s.metaMarketId}`);
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
  if ((take.answer === "YES") !== (take.paid === "Up")) {
    throw new Error(`oracle answer ${take.answer} does not match the paid side ${take.paid} — do not film this market`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "take.json"), JSON.stringify(take, null, 2) + "\n");
  console.log(JSON.stringify(take, null, 2));
  const label = take.case === "A" ? "quotes on the book" : take.case === "B" ? "thesis refused" : "orders rejected";
  console.log(`\ncase ${take.case} — ${label}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
