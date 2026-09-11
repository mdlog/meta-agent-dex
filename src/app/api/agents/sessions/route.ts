/**
 * Sessions across every agent — what the home page leads with (design §3).
 *
 * Two lists, because a visitor arriving cold needs both answers and they are
 * different questions. `open` is what can still be bet on: sessions a keeper
 * still owes work to, ordered by the deadline that expires soonest, which is
 * also the order in which their meta-markets stop taking positions. `recent` is
 * what already happened, newest first, and it is what makes an empty arena look
 * like a platform between sessions rather than a broken one.
 *
 * Composed here from the two service reads rather than added as a third query,
 * because "recent" is a presentation choice — how many finished sessions a
 * landing page shows — and not a rule about sessions.
 *
 * Open cards also carry a live read of their vault, because the stored row has
 * nothing to say between `navT0` and `navT1` and a card built from the row
 * alone can only print the opening figure twice. What that read returns is
 * CASH, not NAV — see `SessionVaultState` — and every screen consuming it is
 * required to say so.
 *
 * A third list, `vaults`, carries one reading per REGISTERED AGENT rather than
 * per session. The board's NAV column and its capital total were built from
 * `agent_nav_points`, whose rows land twice per session, so they printed a
 * figure that could be hours old directly above cards showing the live read of
 * the same `nav()` — 206.12 against 10.00 on one screen. An agent between
 * sessions has no session for a reading to be checked against, which is why
 * this cannot be folded into `open`.
 *
 * NOTE ON THE PATH. `/api/agents/sessions` is a static segment, so Next matches
 * it ahead of `/api/agents/[slug]`. An agent whose slug came out as literally
 * `sessions` would therefore be unreachable at its own URL. `uniqueAgentSlug`
 * does not reserve the word, so this is a real if narrow collision; it is
 * recorded here rather than defended against, because the fix belongs in the
 * slug generator and not in the route it would shadow.
 */

import { json } from "@/lib/http";
import { listAgents } from "@/lib/services/agents";
import { listOpenSessions, listSessions } from "@/lib/services/agentSessions";
import { liveVaultByAgent, liveVaultBySession } from "@/lib/agents/vaultState";
import type {
  Agent,
  AgentSession,
  AgentSessionStatus,
  AgentVaultReading,
  SessionVaultState,
} from "@/lib/domain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

/** Mirrors `listOpenSessions`'s own set — the statuses a keeper still owes work on. */
const LIVE_STATUSES: readonly AgentSessionStatus[] = ["pending", "open", "closing"];

/**
 * Enough of the agent to render a row and link to it, and no more. The full
 * registry is one request away at `/api/agents`; repeating `strategyParams` and
 * a blurb per session would make the home page's body grow with the number of
 * sessions rather than the number of agents.
 */
interface SessionCard {
  session: AgentSession;
  agent: Pick<Agent, "id" | "slug" | "name" | "strategy" | "vaultAddress"> | null;
  /**
   * Chain, right now, for an OPEN session — and `null` for everything else.
   *
   * A closed session has `navT1`, which is the figure its meta-market settled
   * on; re-reading the vault for one of those would produce a number that
   * belongs to whatever the vault has done since. An open session has only
   * `navT0`, and without this field a card has exactly one number to print
   * twice — the bug this carries the fix for.
   */
  vault: SessionVaultState | null;
}

function card(
  session: AgentSession,
  agents: Map<string, Agent>,
  vaults?: Map<string, SessionVaultState | null>,
): SessionCard {
  const agent = agents.get(session.agentId);
  return {
    session,
    vault: vaults?.get(session.id) ?? null,
    // Null rather than a dropped row: a session whose agent is missing is a
    // broken foreign key, and hiding it would hide the breakage too.
    agent: agent
      ? {
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          strategy: agent.strategy,
          vaultAddress: agent.vaultAddress,
        }
      : null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const agents = new Map(listAgents().map((a) => [a.id, a] as const));

  const openSessions = listOpenSessions();

  // Concurrent, deadlined and failure-tolerant inside `vaultState`, so the
  // worst a dead RPC costs this route is a `null` per card and a wait bounded
  // well under the poll interval that will ask again.
  //
  // Two readings, one round of RPC. `bySession` is checked against the session
  // it is attached to and is what the open cards print; `byAgent` covers every
  // registered agent, including the ones between sessions, because the board's
  // NAV column and its capital total have a row for those too. They share the
  // per-vault cache, so an agent in both lists is read once.
  const [vaults, agentVaults] = await Promise.all([
    liveVaultBySession(
      openSessions.map((s) => ({
        sessionId: s.id,
        sessionNumber: s.sessionNumber,
        vaultAddress: agents.get(s.agentId)?.vaultAddress ?? null,
      })),
    ),
    liveVaultByAgent([...agents.values()].map((a) => ({ agentId: a.id, vaultAddress: a.vaultAddress }))),
  ]);

  const open = openSessions.map((s) => card(s, agents, vaults));

  // Emitted as a list rather than an object keyed by id, so a client decodes it
  // with the same row-at-a-time guard it uses for everything else here. An
  // agent whose vault did not answer is present with a null reading: "we asked
  // and got nothing" is a fact the board prints, and it is not the same as an
  // agent that was never asked about.
  const vaultRows: { agentId: string; vault: AgentVaultReading | null }[] = [...agentVaults].map(
    ([agentId, vault]) => ({ agentId, vault }),
  );

  // Finished sessions, newest close first. Gathered per agent because that is
  // the only listing the journal exposes, and the field is tens of agents —
  // the same shape `leaderboard.ts` uses per user, and it becomes a GROUP BY
  // without changing this body if that ever stops being true.
  const live = new Set(LIVE_STATUSES);
  const recent = [...agents.keys()]
    .flatMap((agentId) => listSessions(agentId))
    .filter((s) => !live.has(s.status))
    .sort((a, b) => b.closesAt - a.closesAt)
    .slice(0, limit)
    .map((s) => card(s, agents));

  // The server's clock ships with the body because every card on this page is a
  // countdown to `closesAt`. A browser whose clock is a few minutes fast would
  // otherwise show a market as closed while it is still taking positions, and
  // the visitor would believe the page over the chain.
  return json({ open, recent, vaults: vaultRows, now: Date.now() });
}
