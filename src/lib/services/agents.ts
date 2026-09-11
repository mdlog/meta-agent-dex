/**
 * The agent registry
 * (docs/superpowers/specs/2026-09-07-meta-agent-dex-design.md §3).
 *
 * The chain stays the source of truth. A BotVault holds the capital, owns every
 * ERC-6909 position, and its `nav()` — `protocolCash`, which moves only by
 * collateral deltas measured inside an allowlisted DreamDEX call — is the
 * number a meta-market settles on. This module is the index over *who*: which
 * developer registered which vault, under which declared strategy. What each
 * agent then did lives in `./agentSessions`; how they rank, in
 * `./agentStandings`.
 *
 * Nothing in the agent index may derive a NAV, and nothing may hold money in a
 * float. Every money column is a raw 6-decimal integer carried as its decimal
 * string exactly as it came off chain, and compared as a BigInt. `protocolCash`
 * is a uint256; a double carries 15 significant digits, and the digits it drops
 * are inside the number people took a position on.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { keccak256, toHex } from "viem";
import { getDb } from "@/lib/db";
import type { Agent, AgentStrategy } from "@/lib/domain/types";

export class AgentError extends Error {
  readonly code: "invalid" | "not_found" | "duplicate" | "vault_taken" | "agent_unknown";
  /** What the reader can actually do about it — routes serve this verbatim (FR-045). */
  readonly nextStep: string;
  /** The HTTP status a route should answer with; 400 unless the row is missing. */
  readonly status: number;

  constructor(
    message: string,
    code: AgentError["code"],
    opts: { nextStep?: string; status?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.nextStep = opts.nextStep ?? "";
    this.status = opts.status ?? 400;
    this.name = "AgentError";
  }
}

// ---------------------------------------------------------------------------
// Shapes that arrive off a request body or a chain read, and must not be
// trusted. Each guard exists because the alternative is a silently wrong row.
//
// Exported because `./agentSessions` writes the same column families — an
// address, a bytes32, a raw 6dp integer, a millisecond clock. Two copies of
// these rules would drift, and the half that drifted would be the half that
// accepted a malformed NAV.
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/**
 * A money column, as a plain decimal string. `BigInt()` alone is not this
 * check: it happily accepts `" 42"`, `"0x2a"` and `""` (which becomes 0n), so
 * a malformed NAV would land in the table looking like a real one and only
 * surface as a wrong settlement number.
 */
const RAW_UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
/** The same number signed — a sell returns collateral, a buy spends it. */
const RAW_SIGNED = /^-?(?:0|[1-9][0-9]*)$/;

const STRATEGIES: readonly AgentStrategy[] = ["momentum", "mean-reversion", "market-making", "custom"];

/**
 * Every timestamp in this schema is milliseconds, as `Date.now()` writes them.
 * The vault and the oracle both take `uint64` *seconds*, so a caller that
 * forwards `endsAt` straight off the contract would store a 1970 date — and
 * `listOpenSessions()` would report a session that just opened as long closed.
 * No plausible value for this project is below 1e12, so refuse one.
 */
const MS_FLOOR = 1_000_000_000_000;

export function normAddress(v: string, field: string): string {
  const a = String(v ?? "").trim().toLowerCase();
  if (!ADDRESS.test(a)) {
    throw new AgentError(`${field} must be a 20-byte hex address.`, "invalid");
  }
  return a;
}

/** bytes32 — a marketId or a transaction hash. Lowercased, as the adapter stores ids. */
export function normHash(v: string, field: string): string {
  const h = String(v ?? "").trim().toLowerCase();
  if (!BYTES32.test(h)) {
    throw new AgentError(`${field} must be a 32-byte hex value.`, "invalid");
  }
  return h;
}

export function normHashOrNull(v: string | null | undefined, field: string): string | null {
  return v == null || v === "" ? null : normHash(v, field);
}

export function normAddressOrNull(v: string | null | undefined, field: string): string | null {
  return v == null || v === "" ? null : normAddress(v, field);
}

export function rawUnsigned(v: string, field: string): string {
  const s = String(v ?? "").trim();
  if (!RAW_UNSIGNED.test(s)) {
    throw new AgentError(`${field} must be a raw 6-decimal integer written as a decimal string.`, "invalid");
  }
  return s;
}

export function rawSigned(v: string, field: string): string {
  const s = String(v ?? "").trim();
  if (!RAW_SIGNED.test(s)) {
    throw new AgentError(`${field} must be a signed raw 6-decimal integer written as a decimal string.`, "invalid");
  }
  return s;
}

export function msTimestamp(v: number | undefined, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < MS_FLOOR) {
    throw new AgentError(`${field} must be a millisecond timestamp, not seconds.`, "invalid");
  }
  return v;
}

function isStrategy(v: string): v is AgentStrategy {
  return STRATEGIES.some((s) => s === v);
}

// ---------------------------------------------------------------------------
// Identity: slug and configHash
// ---------------------------------------------------------------------------

function slugBase(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return base || "agent";
}

/**
 * A slug that is free right now.
 *
 * The UNIQUE index on `agents.slug` is the actual guard — two registrations
 * racing here both see the name free — so {@link createAgent} still catches the
 * constraint. This loop exists so the common case gets `momentum-bot` rather
 * than a rejected request.
 */
export function uniqueAgentSlug(name: string, db: DatabaseSync = getDb()): string {
  const base = slugBase(name);
  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!db.prepare("SELECT 1 FROM agents WHERE slug = ?").get(candidate)) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * The exact bytes {@link configHashOf} hashes.
 *
 * Emitted as text rather than by `JSON.stringify` over a rebuilt object,
 * because JavaScript does not preserve insertion order for array-index-like
 * keys: `Object.fromEntries([["10",1],["a",2],["2",3]])` stringifies as
 * `{"2":…,"10":…,"a":…}`, so sorting the entries first buys nothing. Writing
 * the sorted keys out ourselves is the only form that is stable, and it has to
 * be — this digest goes into the meta-market's on-chain `context` blob at mint
 * time and can never be corrected afterwards.
 */
export function canonicalAgentConfig(input: {
  name: string;
  strategy: AgentStrategy;
  strategyParams: Record<string, number | string>;
}): string {
  const params = Object.keys(input.strategyParams)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(input.strategyParams[k])}`)
    .join(",");
  return `{"name":${JSON.stringify(input.name)},"strategy":${JSON.stringify(input.strategy)},"strategyParams":{${params}}}`;
}

/** keccak256 of the declared strategy — what "the agent did what it said" is checked against. */
export function configHashOf(input: {
  name: string;
  strategy: AgentStrategy;
  strategyParams: Record<string, number | string>;
}): string {
  return keccak256(toHex(canonicalAgentConfig(input)));
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const MAX_PARAMS = 16;

/**
 * Strategy parameters are declared by a developer, hashed on chain, and printed
 * on the agent page. Bounded here so none of those three has to defend itself.
 */
function normaliseParams(p: Record<string, number | string>): Record<string, number | string> {
  const keys = Object.keys(p ?? {});
  if (keys.length > MAX_PARAMS) {
    throw new AgentError(`Declare at most ${MAX_PARAMS} strategy parameters.`, "invalid");
  }
  const out: Record<string, number | string> = {};
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw new AgentError(`Strategy parameter "${k}" must be a finite number.`, "invalid");
      }
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = v.slice(0, 120);
    } else {
      throw new AgentError(`Strategy parameter "${k}" must be a number or a string.`, "invalid");
    }
  }
  return out;
}

/**
 * The repo link is rendered as an anchor on the agent page, so the scheme is
 * settled here rather than wherever it happens to be printed: `javascript:` in
 * an href is stored XSS, and one gate beats remembering at every call site.
 */
function normaliseRepoUrl(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new AgentError("The repository link must be a full https:// URL.", "invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgentError("The repository link must be an http:// or https:// URL.", "invalid");
  }
  return parsed.toString().slice(0, 200);
}

function rowToAgent(r: Record<string, unknown>): Agent {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    ownerAddress: r.ownerAddress as string,
    vaultAddress: r.vaultAddress as string,
    operatorAddress: r.operatorAddress as string,
    strategy: r.strategy as AgentStrategy,
    strategyParams: JSON.parse((r.strategyParams as string) ?? "{}") as Record<string, number | string>,
    configHash: r.configHash as string,
    repoUrl: (r.repoUrl as string | null) ?? null,
    blurb: (r.blurb as string | null) ?? null,
    createdAt: r.createdAt as number,
    lastHeartbeat: (r.lastHeartbeat as number | null) ?? null,
  };
}

export interface CreateAgentInput {
  name: string;
  /** Developer wallet, proved by an EIP-191 signature rather than a header. */
  ownerAddress: string;
  /** The BotVault. One per agent — it is the identity the chain knows. */
  vaultAddress: string;
  /** The runner's hot key. May only call `trade`; can never move funds. */
  operatorAddress: string;
  strategy: AgentStrategy;
  strategyParams: Record<string, number | string>;
  repoUrl?: string | null;
  blurb?: string | null;
}

export function createAgent(input: CreateAgentInput, db: DatabaseSync = getDb()): Agent {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 60) {
    throw new AgentError("An agent name must be between 3 and 60 characters.", "invalid");
  }
  if (!isStrategy(input.strategy)) {
    throw new AgentError(`Strategy must be one of ${STRATEGIES.join(", ")}.`, "invalid");
  }

  const strategyParams = normaliseParams(input.strategyParams);
  const agent: Agent = {
    id: randomUUID(),
    name,
    slug: uniqueAgentSlug(name, db),
    ownerAddress: normAddress(input.ownerAddress, "ownerAddress"),
    vaultAddress: normAddress(input.vaultAddress, "vaultAddress"),
    operatorAddress: normAddress(input.operatorAddress, "operatorAddress"),
    strategy: input.strategy,
    strategyParams,
    // Hashed over the trimmed name that is actually stored, not the raw input:
    // otherwise the same declaration submitted with a trailing space hashes
    // differently from the row it produced, and the on-chain context stops
    // matching the agent it describes.
    configHash: configHashOf({ name, strategy: input.strategy, strategyParams }),
    repoUrl: normaliseRepoUrl(input.repoUrl),
    blurb: (input.blurb ?? "").trim().slice(0, 280) || null,
    createdAt: Date.now(),
    lastHeartbeat: null,
  };

  try {
    db.prepare(
      `INSERT INTO agents
         (id, name, slug, ownerAddress, vaultAddress, operatorAddress, strategy, strategyParams,
          configHash, repoUrl, blurb, createdAt, lastHeartbeat)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).run(
      agent.id, agent.name, agent.slug, agent.ownerAddress, agent.vaultAddress,
      agent.operatorAddress, agent.strategy, JSON.stringify(agent.strategyParams),
      agent.configHash, agent.repoUrl, agent.blurb, agent.createdAt,
    );
  } catch (e) {
    const msg = String(e);
    // A vault already registered is the interesting collision: it means someone
    // is pointing a second agent at capital that is already being scored.
    if (msg.includes("UNIQUE") && msg.includes("vaultAddress")) {
      throw new AgentError("That BotVault is already registered to an agent.", "vault_taken", {
        nextStep: "Deploy a fresh BotVault for this agent, or open the agent that already owns it.",
      });
    }
    if (msg.includes("UNIQUE")) {
      throw new AgentError("That agent name is already taken.", "duplicate", {
        nextStep: "Pick a different name.",
      });
    }
    throw e;
  }

  return agent;
}

export function getAgentBySlug(slug: string, db: DatabaseSync = getDb()): Agent | null {
  const r = db.prepare("SELECT * FROM agents WHERE slug = ?").get(slug);
  return r ? rowToAgent(r as Record<string, unknown>) : null;
}

export function getAgentById(id: string, db: DatabaseSync = getDb()): Agent | null {
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return r ? rowToAgent(r as Record<string, unknown>) : null;
}

/** Lookup by the identity the chain knows, for a runner that only holds its vault address. */
export function getAgentByVault(vaultAddress: string, db: DatabaseSync = getDb()): Agent | null {
  const r = db.prepare("SELECT * FROM agents WHERE vaultAddress = ?").get(normAddress(vaultAddress, "vaultAddress"));
  return r ? rowToAgent(r as Record<string, unknown>) : null;
}

export function listAgents(db: DatabaseSync = getDb()): Agent[] {
  return db
    .prepare("SELECT * FROM agents ORDER BY createdAt ASC LIMIT 200")
    .all()
    .map((r) => rowToAgent(r as Record<string, unknown>));
}

/**
 * Record that the runner is alive.
 *
 * Monotonic on purpose: heartbeats arrive from a daemon over an unordered
 * network, and a late one carrying an older clock must not rewind "last seen"
 * — a stale-agent badge that flickers is worse than none.
 */
export function touchHeartbeat(agentId: string, at: number = Date.now(), db: DatabaseSync = getDb()): void {
  db.prepare(
    "UPDATE agents SET lastHeartbeat = ? WHERE id = ? AND (lastHeartbeat IS NULL OR lastHeartbeat < ?)",
  ).run(at, agentId, at);
}

