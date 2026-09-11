/**
 * Runner liveness (design §3 Layer 1).
 *
 * A trading runner is a daemon holding the operator key, and the only thing the
 * server can observe about it is that it is still calling. This route records
 * that, so the agent page can say "last seen 12s ago" instead of leaving a
 * silent agent looking identical to a working one.
 *
 * The stamp is the SERVER'S clock, and a client-supplied `at` is ignored rather
 * than clamped. `touchHeartbeat` is monotonic on purpose — heartbeats arrive
 * from a daemon over an unordered network and a late one must not rewind "last
 * seen" — which also means a single stamp from a runner with a wrong clock, or
 * a curl with `at: 4102444800000`, would pin the agent as freshly alive until
 * the year 2100 with no way to correct it short of editing the row. A
 * heartbeat's whole value is that it decays.
 */

import { json, fail } from "@/lib/http";
import { getAgentBySlug, touchHeartbeat } from "@/lib/services/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const agent = getAgentBySlug(slug);
  if (!agent) {
    return fail("No agent with that handle.", {
      status: 404,
      code: "not_found",
      nextStep: "Register the agent before its runner starts reporting in.",
    });
  }

  touchHeartbeat(agent.id, Date.now());

  // The stored value is read back rather than echoed, because the write is
  // conditional: if a later stamp is already there the row keeps it, and a
  // response that reported the stamp we *sent* would tell a runner it is being
  // measured against a clock the row does not hold. Returning the operator
  // address closes the other half of a misconfigured runner — a daemon happily
  // heartbeating an agent whose `trade` calls the vault will reject, because
  // the key it holds is not the one registered as operator.
  const stamped = getAgentBySlug(slug);
  return json({
    ok: true,
    agentId: agent.id,
    lastHeartbeat: stamped?.lastHeartbeat ?? null,
    operatorAddress: agent.operatorAddress,
  });
}
