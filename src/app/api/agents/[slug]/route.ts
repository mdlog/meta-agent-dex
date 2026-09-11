/**
 * One agent, with everything its page draws (design §3 Layer 0/1).
 *
 * This is a read of the index, not of the chain, and that is the whole point of
 * the split: `agent_sessions`, `agent_trades` and `agent_nav_points` are a
 * journal of what a keeper observed, and a page that re-read the vault on every
 * request would make a 20-agent board cost 20 `eth_call`s a paint while still
 * showing whatever the last keeper pass recorded for the tape underneath it.
 * The one surface that must agree with chain head instantly is the oracle
 * mirror, and it does its own read (`/api/oracle/session/[oracle]`).
 *
 * Nothing here re-derives what an outcome means. `outcomeValue` is passed
 * through as the oracle answered it and the win count comes from `standings()`,
 * so the record on this page and the record on the board cannot disagree.
 *
 * THE ONE EXCEPTION to "index, not chain" is `vault`, and it is bounded to the
 * agent's own live session: one vault, one deadlined read, shared with a cache.
 * The journal has nothing to say about an open session between `navT0` and
 * `navT1`, so without this the page would print the opening figure as though it
 * were the current one. What comes back is CASH — see `SessionVaultState`.
 */

import { json, fail } from "@/lib/http";
import { getAgentBySlug } from "@/lib/services/agents";
import { listSessions, listTrades, navSeries } from "@/lib/services/agentSessions";
import { getAdapter } from "@/lib/dreamdex";
import { standings } from "@/lib/services/agentStandings";
import { liveVaultForSession } from "@/lib/agents/vaultState";
import type { AgentSession } from "@/lib/domain/types";

/** Mirrors `listOpenSessions` — the states a keeper still owes work on. */
function isLive(s: AgentSession): boolean {
  return s.status === "pending" || s.status === "open" || s.status === "closing";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const agent = getAgentBySlug(slug);
  if (!agent) {
    return fail("No agent with that handle.", {
      status: 404,
      code: "not_found",
      nextStep: "Open the agent board and pick one from there.",
    });
  }

  const url = new URL(req.url);
  const sessions = listSessions(agent.id);

  // The tape is served for ONE session rather than all of them. `listSessions`
  // caps at 200 and `listTrades` at 500 each, so "every trade this agent ever
  // made" is a 100,000-row body nobody renders — and the page draws one tape
  // against one NAV curve anyway. `?session=` picks a past one; otherwise the
  // head of a newest-first list is the live session when one is live, which is
  // what a visitor arriving mid-session came to watch.
  const requested = url.searchParams.get("session");
  const focus = (requested ? sessions.find((s) => s.id === requested) : null) ?? sessions[0] ?? null;

  // `?since=` is a millisecond clock, matching every other timestamp in this
  // schema. A malformed value widens the window rather than narrowing it: a
  // truncated curve reads as "the agent did nothing", which is a lie, where a
  // full one is merely more data than was asked for.
  const sinceParam = Number(url.searchParams.get("since"));
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.floor(sinceParam) : 0;

  // Taken from the board rather than recomputed here. The ordering rule that
  // ranks a finished session above an empty record lives in `standings()`, and
  // an agent page that counted its own wins would eventually disagree with the
  // page that ranks it — the readiness lesson, one layer up.
  const board = standings();
  const index = board.findIndex((row) => row.agent.id === agent.id);
  const standing = index >= 0 ? board[index] : null;

  // Only while a session is open. A closed one already has `navT1`, which is
  // the number its meta-market settled on, and re-reading the vault would
  // report whatever it has done since under a heading about that session.
  const live = sessions.find(isLive) ?? null;
  const vault = live
    ? await liveVaultForSession({
        sessionId: live.id,
        sessionNumber: live.sessionNumber,
        vaultAddress: agent.vaultAddress,
      })
    : null;

  const trades = focus ? listTrades(focus.id) : [];

  // How each traded market resolved, so the tape can say which orders won.
  //
  // Every row on that tape is a BUY — the runner never sells — so `cashDelta` is
  // what an order COST and is negative on a winner and a loser alike. The result
  // only exists at settlement, when `redeemAll()` pays a winning leg 1.0 per
  // contract and a losing one nothing, and none of that is in `agent_trades`.
  //
  // Keyed by market rather than folded into each trade: several orders hit the
  // same contract, and one resolution serves them all. `getOnchainState` reads
  // the module and settlement singleton through a PublicClient, so this survives
  // an indexer outage that would blank the rest of the venue's data.
  const tradeMarkets = [...new Set(trades.map((t) => t.marketId))];
  const outcomes: Record<string, { resolved: boolean; voided: boolean; winningOutcome: 0 | 1 | null }> = {};
  await Promise.all(
    tradeMarkets.map(async (id) => {
      const state = await getAdapter().getOnchainState(id).catch(() => null);
      if (state === null) return;
      outcomes[id] = {
        resolved: state.isResolved,
        voided: state.isVoided,
        winningOutcome: state.winningOutcome === "up" ? 0 : state.winningOutcome === "down" ? 1 : null,
      };
    }),
  );

  return json({
    agent,
    /** Live cash for `liveSessionId`, or null when there is nothing to read. */
    vault,
    liveSessionId: live?.id ?? null,
    // `rank` is 1-based to match what the board prints. Null only if the agent
    // vanished between the two reads, which a request cannot make interesting.
    rank: index >= 0 ? index + 1 : null,
    standing,
    sessions,
    tradesSessionId: focus?.id ?? null,
    trades,
    /** marketId -> how it settled. Absent means the read did not answer. */
    outcomes,
    nav: navSeries(agent.id, since),
  });
}
