import { json, fail } from "@/lib/http";
import { getAgentBySlug } from "@/lib/services/agents";
import { listOpenSessions, recordTrade } from "@/lib/services/agentSessions";
import { readVaultTrade } from "@/lib/agents/chain";
import type { AgentTradeKind } from "@/lib/domain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The trade tape. A runner posts a transaction hash here after an order is mined.
 *
 * The chain is the source of truth, and this route now enforces that rather than
 * asserting it. It used to store `marketId`, `kind`, `price`, `quantity` and
 * `cashDelta` exactly as the caller sent them, read the hash back never, and
 * carry no token — so any client that could reach it could write an invented
 * trade for any agent with an open session, and the tape would show it beside
 * the real ones with nothing to tell them apart.
 *
 * So the body is no longer believed. `txHash` is the only field that matters:
 * the receipt is fetched, the transaction must have gone to THIS agent's vault,
 * it must have emitted that vault's own `Traded` event, and every number written
 * is taken from the event. A forged row cannot be written without first mining a
 * real trade through the agent's own vault — which is the thing the tape claims.
 *
 * The runner reports which market it traded, never which session: it knows its
 * vault, not our row ids. So the session is resolved here, from the agent's
 * currently open one. A trade arriving with no open session is dropped rather
 * than attached to the previous one — a trade cannot belong to a window the
 * vault had already closed, and mis-attributing it would corrupt the P&L the
 * meta-market settles on.
 */
const KINDS: readonly AgentTradeKind[] = [0, 1, 2, 3];

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const agent = getAgentBySlug(slug);
  if (!agent) return fail("No agent with that name.", { status: 404, code: "agent_unknown" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Send a JSON body.", { status: 400, code: "bad_json" });
  }

  const t = body as { txHash?: string; symbol?: string | null };
  if (!t.txHash) {
    return fail("txHash is required.", {
      status: 400,
      code: "missing_fields",
      nextStep: "Send the hash of the mined trade; every other field is read from the chain.",
    });
  }

  const session = listOpenSessions().find(
    (s) => s.agentId === agent.id && (s.status === "open" || s.status === "pending"),
  );
  if (!session) {
    return fail("That agent has no open session to attach a trade to.", {
      status: 409,
      code: "no_open_session",
      nextStep: "Open a session before trading; the vault rejects orders outside one anyway.",
    });
  }

  // The gate. Everything after this is the chain's account of the trade.
  let onchain;
  try {
    onchain = await readVaultTrade({ txHash: t.txHash, vault: agent.vaultAddress });
  } catch (err) {
    return fail((err as Error).message, {
      status: 422,
      code: "trade_unverified",
      nextStep: "A tape row needs a mined transaction to this agent's own vault that emitted Traded.",
    });
  }

  if (!KINDS.includes(onchain.kind as AgentTradeKind)) {
    return fail(`The vault emitted an unknown trade kind: ${onchain.kind}.`, {
      status: 422,
      code: "trade_unverified",
    });
  }

  try {
    const trade = recordTrade({
      sessionId: session.id,
      agentId: agent.id,
      marketId: onchain.marketId,
      // The only field still taken from the caller: a display label the chain
      // does not carry. It cannot change what the row means.
      symbol: t.symbol ?? null,
      kind: onchain.kind as AgentTradeKind,
      // The pool's price is in the market's own quote decimals, which is 6 on
      // every market this app trades — the same scale `recordTrade` validates
      // against. A market quoted in other decimals would land outside 0..1e6 and
      // be rejected there, which is the loud failure, not a silent rescaling.
      price: Number(onchain.price),
      quantity: onchain.quantity.toString(),
      cashDelta: onchain.cashDelta.toString(),
      txHash: t.txHash,
      at: onchain.at,
    });
    return json({ trade, verified: { blockNumber: onchain.blockNumber } });
  } catch (err) {
    return fail((err as Error).message, { status: 400, code: "trade_rejected" });
  }
}
