/**
 * The agent registry endpoint (design §3 Layer 0).
 *
 * GET is the board — every registered agent, plus the ranking `standings()`
 * computes. POST is registration, and it is the only route in this app that
 * authorises a caller at all.
 *
 * WHY IT IS A SIGNATURE AND NOT A HEADER. This app used to resolve a person
 * from an `fa_session` cookie, with an `x-wallet-address` header as a
 * self-asserted upgrade. That is gone with the human trading path, and it was
 * never enough here anyway: registration writes an owner address into a row
 * that is permanent, and the `configHash` derived alongside it goes into the
 * meta-market's on-chain `context` at mint time, where it can never be
 * corrected. A self-asserted header would let anyone register an agent — and a
 * strategy declaration — under a wallet they do not hold, against a vault they
 * do not control. So the owner proves the key with an EIP-191 signature, which
 * is the only claim on this route the server can actually check.
 */

import { verifyMessage } from "viem";
import { json, fail } from "@/lib/http";
import { AgentError, createAgent, listAgents } from "@/lib/services/agents";
import { standings } from "@/lib/services/agentStandings";
import type { AgentStrategy } from "@/lib/domain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounds on the signed message, not a format. What the nonce *says* is the
 * client's business — a wallet shows the user whatever string it is handed, so
 * a good one reads as a sentence — but it is handed straight to `verifyMessage`
 * and hashed, so it needs a length and it needs to be something a wallet can
 * legibly display before someone approves it.
 *
 * Deliberately NOT an ASCII allow-list. EIP-191 signs UTF-8 and a prompt that
 * reads well contains typography: the first draft of this guard was
 * `[\x20-\x7e\n]` and it rejected a signature over "Meta-Agent DEX — register
 * agent", refusing a valid registration because of one em dash. Newline is the
 * one control character kept, because a legible prompt is multi-line.
 */
const NONCE_MIN = 12;
const NONCE_MAX = 500;
/** Newline is the one control character a multi-line prompt needs; the rest
 *  are unreadable in a wallet dialog and have no business in a signed claim. */
const NEWLINE = 0x0a;

function nonceIsWellFormed(nonce: string): boolean {
  if (nonce.length < NONCE_MIN || nonce.length > NONCE_MAX) return false;
  for (const ch of nonce) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === NEWLINE) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/** A 65-byte ECDSA signature, hex. Longer forms exist; none are produced here. */
const SIGNATURE_SHAPE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Nonces already spent, keyed by owner so one developer's choice of string
 * cannot block another's.
 *
 * Honest about what this is: a process-local replay guard, lost on restart, not
 * a durable one — there is no nonce table and inventing a fifth agent table
 * here would put schema in a route. It closes the cheap attack (replaying a
 * captured registration signature to keep minting agents under someone else's
 * address) while the durable guard stays where it already is: `agents` has
 * UNIQUE(vaultAddress), so every replay still needs a fresh BotVault, and a
 * BotVault the replayer does not hold the owner key to is not capital they can
 * ever withdraw.
 */
const MAX_REMEMBERED_NONCES = 1000;

const globalRef = globalThis as typeof globalThis & { __agentRegistrationNonces?: Set<string> };

/**
 * Claim a nonce, or refuse because it is already claimed.
 *
 * Taken BEFORE `createAgent` and given back if that fails, rather than simply
 * spent up front. Both halves matter and the first draft had neither:
 *
 *  - Reserving before the write is what makes the guard a guard. `createAgent`
 *    is synchronous, but `verifyMessage` before it is not, so two requests
 *    carrying one signature can both be past the check when the first reaches
 *    the insert.
 *  - Releasing on failure is what keeps it from punishing a typo. Measured on
 *    the real route: a body with a nested `strategyParams` was rejected *after*
 *    the nonce was spent, and every retry of the corrected body then failed 409
 *    — a developer who mistyped an agent name had to go back to their wallet
 *    and sign again. The rule is one signature, one *registered agent*; a
 *    registration that created nothing has not used anything up.
 */
function reserveNonce(key: string): boolean {
  const seen = (globalRef.__agentRegistrationNonces ??= new Set<string>());
  if (seen.has(key)) return false;
  // Insertion-ordered, so the first key is the oldest. Evicting one at a time
  // keeps the guard bounded without a sweep that could drop a nonce still in
  // flight during a burst.
  if (seen.size >= MAX_REMEMBERED_NONCES) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.add(key);
  return true;
}

function releaseNonce(key: string): void {
  globalRef.__agentRegistrationNonces?.delete(key);
}

/**
 * Narrow the parsed JSON to the shape `createAgent` is typed for. It applies
 * its own bounds afterwards (at most 16 params, finite numbers, strings capped)
 * — this only rejects what would not survive the type at all, so a caller gets
 * "that parameter is not a number or a string" instead of a 500 three frames
 * deeper.
 */
function readStrategyParams(v: unknown): Record<string, number | string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new AgentError("strategyParams must be a JSON object of numbers and strings.", "invalid", {
      nextStep: 'Send strategyParams as an object, e.g. {"lookback": 20, "threshold": 0.6}.',
    });
  }
  const out: Record<string, number | string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "number" && typeof raw !== "string") {
      throw new AgentError(`Strategy parameter "${k}" must be a number or a string.`, "invalid", {
        nextStep: "Flatten nested parameters before declaring them.",
      });
    }
    out[k] = raw;
  }
  return out;
}

export async function GET() {
  // Both views of the same rows, deliberately. `standings` is ranked, and its
  // order is a claim: an agent that has finished a session outranks one that
  // has not, before any metric is compared. `agents` is registration order,
  // which claims nothing, and is what a "point my runner at an agent" picker
  // wants. Serving one and asking the client to re-sort would put the ranking
  // rule in a second place, which is how the two stop agreeing.
  return json({ agents: listAgents(), standings: standings() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const ownerAddress = String(body.ownerAddress ?? "").trim();
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = String(body.signature ?? "").trim();

  if (!nonceIsWellFormed(nonce)) {
    return fail("The registration nonce is missing or malformed.", {
      code: "invalid",
      // The app issues no nonces — the caller picks the string and signs it, and
      // this route only recovers the signer from it. The old wording sent a
      // developer hunting for an endpoint that has never existed; it was written
      // when a browser form chose the string on their behalf.
      nextStep:
        "Choose any printable string of 12-500 characters, sign it with the owner key, and send both.",
    });
  }
  if (!SIGNATURE_SHAPE.test(signature)) {
    return fail("That signature is not a 65-byte hex signature.", {
      code: "invalid",
      nextStep: "Sign the nonce with the owner wallet and send the 0x-prefixed result.",
    });
  }

  // Checked against the address exactly as it was sent, before it is lowercased
  // for storage: `verifyMessage` recovers a key and compares it to the address
  // the caller is claiming, so that comparison has to be against the claim
  // itself. `createAgent` lowercases and re-validates afterwards.
  const owner = ownerAddress as `0x${string}`;
  try {
    const proved = await verifyMessage({
      address: owner,
      message: nonce,
      signature: signature as `0x${string}`,
    });
    if (!proved) {
      return fail("That signature was not produced by the owner address.", {
        code: "invalid",
        status: 401,
        nextStep: "Sign the nonce with the wallet you are registering as the owner.",
      });
    }
  } catch {
    // A malformed address makes `verifyMessage` throw rather than return false.
    // That means the same thing to the caller as a mismatch — the proof did not
    // check out — and neither is worth a 500.
    return fail("That signature could not be checked against the owner address.", {
      code: "invalid",
      status: 401,
      nextStep: "Send ownerAddress as a 20-byte hex address and sign the nonce with it.",
    });
  }

  const nonceKey = `${owner.toLowerCase()}:${nonce}`;
  if (!reserveNonce(nonceKey)) {
    return fail("That nonce has already been used to register an agent.", {
      code: "invalid",
      status: 409,
      nextStep: "Sign a fresh nonce — a signature is good for one registration.",
    });
  }

  try {
    const agent = createAgent({
      name: String(body.name ?? ""),
      ownerAddress,
      vaultAddress: String(body.vaultAddress ?? ""),
      operatorAddress: String(body.operatorAddress ?? ""),
      // `createAgent` re-checks this against its own list and rejects anything
      // it does not know, with the message that names the valid set. The
      // assertion is a bridge over `JSON.parse`, not the guard — duplicating
      // the list here would give one condition two error messages.
      strategy: String(body.strategy ?? "") as AgentStrategy,
      strategyParams: readStrategyParams(body.strategyParams),
      repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : null,
      blurb: typeof body.blurb === "string" ? body.blurb : null,
    });

    // Nothing here spends STT or moves collateral — the vault is deployed and
    // funded by the keeper — so an abandoned registration costs one row. The
    // agent is returned whole because `configHash` is what the meta-market's
    // on-chain context will carry, and the developer should be able to check it
    // against their own declaration before a session opens against it.
    return json({ agent }, { status: 201 });
  } catch (e) {
    // No agent was written, so the signature is still unspent. Released before
    // the error goes out, so the developer's next attempt with the corrected
    // body is not met with a 409 about a nonce they never got to use.
    releaseNonce(nonceKey);
    if (e instanceof AgentError) {
      return fail(e.message, { code: e.code, status: e.status, nextStep: e.nextStep });
    }
    throw e;
  }
}
