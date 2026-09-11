/**
 * Register a session for an agent whose vault this server holds no key to.
 *
 * THE ROUTE THAT MAKES "BRING YOUR OWN AGENT" TRUE. Registration
 * (`POST /api/agents`) has always been open — it is signature-gated, not
 * token-gated, so anyone may register. But nothing after it worked for an
 * outsider: `openSession` is `onlyOwner`, the keeper signs it with a key from
 * `.data/agent-owners.json`, and for a vault someone else deployed there is no
 * such key. The keeper threw, the cycle route logged the error and carried on,
 * and the visitor's agent stayed registered with no session for ever — runner
 * polling, `trade` reverting `SessionNotOpen()`, and no page explaining it.
 *
 * The division of labour here is the point. The owner sends the one transaction
 * only the owner can send, from their own wallet. Then this route does the part
 * that needs no key of theirs and that the arena pays for: deploy the session's
 * `BotNavOracle`, arm it at navT0, mint the meta-market that measures them. No
 * private key ever changes hands.
 *
 * WHAT THE SIGNATURE IS FOR. Opening a session is not free to the arena — an
 * oracle deployment plus a mint costs the keeper about 1.5 STT — and it writes a
 * row that a public leaderboard ranks. So the caller proves they hold the owner
 * key registered against that agent, the same EIP-191 proof registration uses.
 * The chain is still the authority on everything factual: this route reads the
 * session number and end time off the vault and ignores anything the body says
 * about them.
 */

import { verifyMessage } from "viem";
import { json, fail } from "@/lib/http";
import { adoptAgentSession } from "@/lib/agents/orchestrator";
import { getAgentBySlug } from "@/lib/services/agents";
import { listOpenSessions } from "@/lib/services/agentSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_MIN = 12;
const NONCE_MAX = 500;
const SIGNATURE_SHAPE = /^0x[0-9a-fA-F]{130}$/;

/** Same rule as registration: printable UTF-8 a wallet can display, newline kept. */
function nonceIsWellFormed(nonce: string): boolean {
  if (nonce.length < NONCE_MIN || nonce.length > NONCE_MAX) return false;
  for (const ch of nonce) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Replay guard, process-local and deliberately separate from the registration
 * set: a nonce spent registering an agent is not thereby spent opening its
 * sessions, and one developer's string must not block another's.
 *
 * The durable guard is the one below it — a vault may hold one open session at
 * a time, and the arena keeps one row per session — so a replayed signature
 * cannot mint a second market against the same session even if this set is lost
 * on restart.
 */
const MAX_REMEMBERED_NONCES = 1000;
const globalRef = globalThis as typeof globalThis & { __agentSessionNonces?: Set<string> };

function reserveNonce(key: string): boolean {
  const seen = (globalRef.__agentSessionNonces ??= new Set<string>());
  if (seen.has(key)) return false;
  if (seen.size >= MAX_REMEMBERED_NONCES) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.add(key);
  return true;
}

function releaseNonce(key: string): void {
  globalRef.__agentSessionNonces?.delete(key);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const agent = getAgentBySlug(slug);
  if (!agent) {
    return fail("No agent with that slug.", {
      status: 404,
      code: "unknown_agent",
      nextStep: "Register the agent first with POST /api/agents.",
    });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = String(body.signature ?? "").trim();

  if (!nonceIsWellFormed(nonce)) {
    return fail("The nonce is missing or malformed.", {
      code: "invalid",
      nextStep: "Sign a fresh string of 12–500 printable characters with the owner wallet.",
    });
  }
  if (!SIGNATURE_SHAPE.test(signature)) {
    return fail("That signature is not a 65-byte hex signature.", {
      code: "invalid",
      nextStep: "Sign the nonce with the owner wallet and send the 0x-prefixed result.",
    });
  }

  // Against the address the AGENT was registered with, never one from the body:
  // the claim being checked is "I am this agent's owner", so the address has to
  // come from the row, not from the request making the claim.
  const owner = agent.ownerAddress as `0x${string}`;
  try {
    const proved = await verifyMessage({ address: owner, message: nonce, signature: signature as `0x${string}` });
    if (!proved) {
      return fail("That signature was not produced by this agent's owner address.", {
        status: 401,
        code: "invalid",
        nextStep: `Sign the nonce with ${owner}.`,
      });
    }
  } catch {
    return fail("That signature could not be checked.", {
      status: 401,
      code: "invalid",
      nextStep: `Sign the nonce with ${owner} and send the 0x-prefixed 65-byte result.`,
    });
  }

  // Checked before the nonce is spent: a caller whose session is already
  // registered has made a duplicate request, not used up a signature.
  const already = listOpenSessions().find((s) => s.agentId === agent.id);
  if (already) {
    return fail("That agent already has a session the arena is following.", {
      status: 409,
      code: "session_open",
      nextStep: `Session #${already.sessionNumber} closes at ${new Date(already.closesAt).toISOString()}.`,
    });
  }

  const nonceKey = `${owner.toLowerCase()}:${nonce}`;
  if (!reserveNonce(nonceKey)) {
    return fail("That nonce has already been used.", {
      status: 409,
      code: "invalid",
      nextStep: "Sign a fresh nonce — a signature is good for one session.",
    });
  }

  try {
    const session = await adoptAgentSession({ agentId: agent.id });
    return json({ session }, { status: 201 });
  } catch (e) {
    releaseNonce(nonceKey);
    const message = (e as Error).message;
    // The two the caller can act on are told apart, because "open a session
    // first" and "the mint failed, try again" need opposite responses.
    const notOpen = message.includes("no open session");
    return fail(notOpen ? "That vault has no open session." : "Could not register the session.", {
      status: notOpen ? 409 : 502,
      code: notOpen ? "vault_session_closed" : "session_adopt_failed",
      nextStep: message.slice(0, 240),
    });
  }
}
