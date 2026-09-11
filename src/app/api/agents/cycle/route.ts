import { json, fail } from "@/lib/http";
import { getAgentById, listAgents } from "@/lib/services/agents";
import { listOpenSessions } from "@/lib/services/agentSessions";
import {
  dueForSettlement,
  openAgentSession,
  retryPendingMints,
  settleAgentSession,
  syncSettlements,
} from "@/lib/agents/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The keeper pass: settle what is due, follow the committee, optionally open
 * what is idle.
 *
 * Meta-Agent DEX settled opportunistically on page reads, which was fine when
 * the only cost of nobody looking was a stale board. It is not fine here: a
 * session that closes unattended leaves real bettors unresolved and, worse,
 * leaves the oracle unfrozen past the moment the committee reads it — which
 * voids the market. So this runs on a clock (`npm run cycle`), and every step it
 * takes is one anyone else could also take, because redeemAll, closeSession and
 * finalize are all permissionless. The keeper is a convenience, not an
 * authority.
 *
 * Writes are gated on a shared token when one is configured. Opening sessions
 * spends STT, so it is opt-in per call rather than something a stray POST can
 * trigger.
 */
export async function POST(req: Request) {
  const expected = process.env.AGENT_CYCLE_TOKEN;
  if (expected && req.headers.get("x-cycle-token") !== expected) {
    return fail("This endpoint is not open.", {
      status: 401,
      code: "cycle_unauthorised",
      nextStep: "Send the x-cycle-token header that matches AGENT_CYCLE_TOKEN.",
    });
  }

  const url = new URL(req.url);
  const alsoOpen = url.searchParams.get("open") === "1";
  const durationSec = Number(url.searchParams.get("duration") ?? 900);

  const settled: { sessionId: string; agent: string; navT0: string; navT1: string; outcome: number | null }[] = [];
  const opened: { sessionId: string; agent: string; marketId: string | null; closesAt: number }[] = [];
  const errors: { where: string; message: string }[] = [];

  // 1. Close out anything past its window. One failure must not strand the rest,
  //    so each session is attempted on its own.
  for (const due of dueForSettlement()) {
    try {
      const done = await settleAgentSession(due.id);
      const agent = getAgentById(done.agentId);
      settled.push({
        sessionId: done.id,
        agent: agent?.name ?? done.agentId,
        navT0: done.navT0 ?? "0",
        navT1: done.navT1 ?? "0",
        outcome: done.outcomeValue,
      });
    } catch (err) {
      errors.push({ where: `settle ${due.id}`, message: (err as Error).message });
    }
  }

  // 2. A session whose mint failed still has an open vault and a recorded navT0,
  //    so it is worth a market. Retry before giving up on it.
  let mints = { minted: 0, failed: [] as { agent: string; message: string }[] };
  try {
    mints = await retryPendingMints();
    for (const f of mints.failed) errors.push({ where: `mint ${f.agent}`, message: f.message });
  } catch (err) {
    errors.push({ where: "retryPendingMints", message: (err as Error).message });
  }

  // 3. Ask the indexer what the committee decided about the ones already frozen.
  let sync = { checked: 0, settled: 0, voided: 0 };
  try {
    sync = await syncSettlements();
  } catch (err) {
    errors.push({ where: "syncSettlements", message: (err as Error).message });
  }

  // 4. Give idle agents something to be judged on.
  if (alsoOpen) {
    const busy = new Set(
      listOpenSessions()
        .filter((s) => s.status === "open" || s.status === "pending" || s.status === "closing")
        .map((s) => s.agentId),
    );
    for (const agent of listAgents()) {
      if (busy.has(agent.id)) continue;
      try {
        const session = await openAgentSession({ agentId: agent.id, durationSec });
        opened.push({
          sessionId: session.id,
          agent: agent.name,
          marketId: session.metaMarketId,
          closesAt: session.closesAt,
        });
      } catch (err) {
        errors.push({ where: `open ${agent.name}`, message: (err as Error).message });
      }
    }
  }

  return json({ settled, opened, minted: mints.minted, sync, errors });
}
