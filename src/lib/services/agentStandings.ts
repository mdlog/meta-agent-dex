/**
 * The agent board.
 *
 * An agent is ranked on what it finished, not on what it holds. A finished
 * session is one the oracle has frozen an answer for — `finalized` (the answer
 * exists and can never be restated) or `settled` (DreamDEX has paid the
 * meta-market out on it) — and never a voided one: a committee that could not
 * agree produced no result, and refunding both sides is not a loss any more
 * than it is a win (the FR-066 rule, applied a layer up).
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import type { AgentSession, AgentStanding } from "@/lib/domain/types";
import { listAgents } from "./agents";
import { latestNavPoint, listSessions } from "./agentSessions";

/**
 * The one definition of a finished session, exported because more than one
 * screen counts them.
 *
 * The Overview's "Sessions settled" tile used to count `status === "settled"`
 * on its own while the leaderboard column directly beneath it counted this —
 * two different numbers under two labels a reader reads as the same word, on
 * the same paint. A count is only checkable if there is one rule behind it, so
 * the rule lives here and the tile imports it.
 */
export function isFinished(s: AgentSession): boolean {
  return !s.voided && (s.status === "finalized" || s.status === "settled");
}

function isLive(s: AgentSession): boolean {
  return s.status === "pending" || s.status === "open" || s.status === "closing";
}

/** Raw 6dp money, ordered without ever becoming a float. */
function cmpRaw(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Rank every registered agent.
 *
 * One query per agent, as `leaderboard.ts` does per user: the field is
 * tens of agents, and the shape does not change if this ever has to become a
 * GROUP BY.
 */
export function standings(db: DatabaseSync = getDb()): AgentStanding[] {
  const rows = listAgents(db).map((agent) => {
    const sessions = listSessions(agent.id, db);
    const finished = sessions.filter(isFinished);

    // 1 = YES = "NAV rose" (`BotNavOracle.OUTCOME_YES`), read from the oracle's
    // own answer rather than recomputed from navT0/navT1. That answer is what
    // DreamDEX settled the meta-market on, so a board that derived its own
    // would be scoring a different game from the one people took a position in.
    //
    // This read `=== 2` until the encoding was checked against the deployed
    // contract, and the board was therefore ranking losses as wins.
    const sessionsWon = finished.filter((s) => s.outcomeValue === 1).length;

    // Sessions whose NAV pair never landed still count as run — the oracle
    // answered — but contribute nothing here. Inventing a delta from one
    // endpoint would put a number on the board that no block confirms.
    let netPnl = 0n;
    for (const s of finished) {
      if (s.navT0 === null || s.navT1 === null) continue;
      netPnl += BigInt(s.navT1) - BigInt(s.navT0);
    }

    // The newest sample, carried WITH the two facts that make it readable: when
    // it was taken and which block it was read at.
    //
    // It used to be one bare string called `currentNav`, and it used to fall
    // back to the last finished session's `navT1` when no sample existed. Both
    // are gone. A bare figure has no age, so every screen that received it was
    // free to print it under a "now" label — which is how a row written 92.9
    // minutes earlier came to sit 400px below the live read of the same
    // quantity, at 206.12 against 10.00. And `navT1` is a *settled close*, a
    // historical answer the oracle froze; standing it in for the current figure
    // meant the one value on the board with no timestamp at all was also the
    // one furthest from now.
    const sample = latestNavPoint(agent.id, db);

    return {
      agent,
      sessionsRun: finished.length,
      sessionsWon,
      winRate: finished.length > 0 ? sessionsWon / finished.length : null,
      netPnl: netPnl.toString(),
      lastNav: sample?.nav ?? null,
      lastNavAt: sample?.at ?? null,
      lastNavBlock: sample?.blockNumber ?? null,
      // `listSessions` is newest-first, so this is the current one.
      liveSession: sessions.find(isLive) ?? null,
    } satisfies AgentStanding;
  });

  // The first comparison is deliberately not a metric.
  //
  // An agent with no finished session has no win rate — not a zero, and not a
  // win. This repo has already shipped the other version of that mistake:
  // `realisedPnlOf` counted "never traded" as 0.00, and 60/60 seeded runs put a
  // forecaster who had never staked anything at rank 1 of a board titled
  // *Profit* (docs/HACKATHON_READINESS.md:149). The same trap is waiting here
  // — a null win rate sorting as if it beat 0.40, an agent that has never
  // opened a session topping a board of agents that have traded real Event
  // Contracts. So anyone who has finished a session ranks above everyone who
  // has not, before any number is compared.
  rows.sort((a, b) => {
    const aRan = a.sessionsRun > 0;
    const bRan = b.sessionsRun > 0;
    if (aRan !== bRan) return aRan ? -1 : 1;

    // Among agents with no record, registration order claims nothing about
    // them. Anything else here would read as a ranking.
    if (!aRan) return a.agent.createdAt - b.agent.createdAt;

    // Win rate over finished sessions, then realised NAV change as the
    // tie-break — compared as BigInt, because these are uint256 deltas in
    // 6-decimal units and a Number loses the low digits past 2^53.
    if (a.winRate !== b.winRate) return (b.winRate ?? 0) - (a.winRate ?? 0);
    const byPnl = cmpRaw(b.netPnl, a.netPnl);
    if (byPnl !== 0) return byPnl;

    // A longer record breaks a dead heat, and the slug breaks that, so the
    // board is stable across reloads instead of depending on sort stability
    // over a row order that itself came from the database.
    if (a.sessionsRun !== b.sessionsRun) return b.sessionsRun - a.sessionsRun;
    return a.agent.slug.localeCompare(b.agent.slug);
  });

  return rows;
}
