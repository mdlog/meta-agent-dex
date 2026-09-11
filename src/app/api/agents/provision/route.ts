import { json, fail } from "@/lib/http";
import { provisionAgent } from "@/lib/agents/orchestrator";
import type { AgentStrategy } from "@/lib/domain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deploy a vault, fund it, and register an agent against it — the operator path.
 *
 * This is separate from `POST /api/agents`, which registers an agent whose vault
 * the developer deployed themselves and proves ownership of by signature. This
 * one spends the keeper's STT and tUSDC, so it is gated on the same shared token
 * as the keeper cycle and is never reachable without it. Registration by
 * signature stays open; spending our money does not.
 */
const STRATEGIES: readonly AgentStrategy[] = ["momentum", "mean-reversion", "market-making", "custom"];

export async function POST(req: Request) {
  const expected = process.env.AGENT_CYCLE_TOKEN;
  if (!expected || req.headers.get("x-cycle-token") !== expected) {
    return fail("This endpoint is not open.", {
      status: 401,
      code: "provision_unauthorised",
      nextStep: "Set AGENT_CYCLE_TOKEN and send it as x-cycle-token.",
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Send a JSON body.", { status: 400, code: "bad_json" });
  }

  const input = body as {
    name?: string;
    strategy?: string;
    strategyParams?: Record<string, number | string>;
    ownerAddress?: string;
    operatorAddress?: string;
    funding?: string;
    blurb?: string;
    repoUrl?: string;
  };

  if (!input.name || !input.ownerAddress || !input.operatorAddress) {
    return fail("name, ownerAddress and operatorAddress are required.", { status: 400, code: "missing_fields" });
  }
  const strategy = (input.strategy ?? "momentum") as AgentStrategy;
  if (!STRATEGIES.includes(strategy)) {
    return fail(`strategy must be one of ${STRATEGIES.join(", ")}.`, { status: 400, code: "bad_strategy" });
  }

  try {
    const { agent, vaultTx, fundTx } = await provisionAgent({
      name: input.name,
      ownerAddress: input.ownerAddress,
      operatorAddress: input.operatorAddress,
      strategy,
      strategyParams: input.strategyParams ?? {},
      blurb: input.blurb ?? null,
      repoUrl: input.repoUrl ?? null,
      funding: input.funding ? BigInt(input.funding) : undefined,
    });
    return json({ agent, vaultTx, fundTx });
  } catch (err) {
    return fail((err as Error).message, {
      status: 500,
      code: "provision_failed",
      nextStep: "Check the keeper wallet's STT balance and that the vault bytecode in contracts/out is current.",
    });
  }
}
