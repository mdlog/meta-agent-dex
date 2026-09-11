/**
 * The agent screens' one door to the server.
 *
 * Rows are picked out of a payload by the guard they satisfy, not by the first
 * key that happens to hold an array. That is not defensive decoration: `GET
 * /api/agents` answers `{ agents, standings }` where `agents` is the *registry*
 * in registration order and `standings` is the ranked board, and a reader that
 * took whichever came first would render the registry as a leaderboard — an
 * ordering that claims something it was explicitly built not to claim.
 *
 * Everything is checked before it is used, so a shape this file does not
 * recognise produces an empty list and an honest error rather than a
 * half-built object rendered as fact. The one thing it will not do is invent a
 * value: a missing NAV stays null and prints as `—`.
 */

import type {
  Agent,
  AgentNavPoint,
  AgentSession,
  AgentStanding,
  AgentTrade,
  AgentVaultReading,
  SessionVaultState,
} from "@/lib/domain/types";

/**
 * A live read of the vault, when the detail route makes one.
 *
 * `nav` is `protocolCash`; `unaccounted` is collateral sitting in the vault
 * that no DreamDEX call delivered. The pair is the product's central claim, so
 * the profile shows both and falls back to the last sampled NAV point when the
 * route does not read chain itself.
 */
export interface VaultReading {
  nav: string;
  unaccounted: string | null;
  sessionOpen: boolean | null;
  sessionNumber: number | null;
  touched: string[];
}

export interface MarketOutcome {
  resolved: boolean;
  voided: boolean;
  /** 0 = the Up/YES leg paid, 1 = the Down/NO leg paid. */
  winningOutcome: 0 | 1 | null;
}

export interface AgentDetail {
  agent: Agent;
  standing: AgentStanding | null;
  /** 1-based position on the board, as the board itself prints it. */
  rank: number | null;
  sessions: AgentSession[];
  /**
   * One session's tape, not the agent's whole history: the detail route serves
   * the focused session's trades so a busy agent's page stays a page. The id
   * says which one, so the tape can name it instead of implying it is all of
   * them.
   */
  trades: AgentTrade[];
  tradesSessionId: string | null;
  /**
   * Totals across every session this agent has run, so a page showing one
   * session's tape can say what it is a slice OF. Deliberately not named
   * `history`: that key is already an accepted alias for the sessions array.
   */
  tradeHistory: { trades: number; sessions: number };
  /**
   * How each traded market settled, keyed by marketId.
   *
   * A trade row cannot say on its own whether it won: every order is a buy, so
   * `cashDelta` is what it cost and is negative either way. The result arrives
   * at settlement, and it belongs to the market rather than to the order — one
   * resolution serves every order that hit the same contract. A market missing
   * from this map is one the read did not answer for, which is not the same as
   * one that has not resolved.
   */
  outcomes: Record<string, MarketOutcome>;
  nav: AgentNavPoint[];
  chain: VaultReading | null;
  /**
   * Live cash for the agent's open session, read at request time.
   *
   * Null whenever there is nothing honest to show: no open session, a vault
   * read that failed or timed out, or a vault whose session counter has moved
   * past the row. It is deliberately NOT merged into `chain` — `chain` is a
   * whole-vault reading, this one is only valid against `liveSessionId`.
   */
  vault: SessionVaultState | null;
  liveSessionId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * The first array under these keys whose rows survive the guard.
 *
 * Order matters and emptiness is not a match: `{ agents, standings }` holds two
 * arrays of different things, and an agent registry filtered through the
 * standing guard comes back empty rather than wrong — so keep looking.
 */
function pickTyped<T>(payload: unknown, keys: readonly string[], guard: (v: unknown) => v is T): T[] {
  if (Array.isArray(payload)) return payload.filter(guard);
  if (!isRecord(payload)) return [];
  for (const k of keys) {
    const v = payload[k];
    if (!Array.isArray(v)) continue;
    const rows = v.filter(guard);
    if (rows.length > 0) return rows;
  }
  return [];
}

function pickRecord(payload: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  for (const k of keys) {
    const v = payload[k];
    if (isRecord(v)) return v;
  }
  return null;
}

// The guards check the fields these screens actually read. An agent without a
// slug cannot be linked to, and a session without a status cannot be drawn on
// the timeline — those are the columns worth refusing a row over.
function isAgent(v: unknown): v is Agent {
  return isRecord(v) && str(v.id) && str(v.name) && str(v.slug) && str(v.vaultAddress);
}

function isSession(v: unknown): v is AgentSession {
  return isRecord(v) && str(v.id) && str(v.agentId) && str(v.status) && typeof v.sessionNumber === "number";
}

function isTrade(v: unknown): v is AgentTrade {
  return isRecord(v) && str(v.id) && str(v.txHash) && str(v.marketId) && typeof v.kind === "number";
}

function isNavPoint(v: unknown): v is AgentNavPoint {
  return isRecord(v) && str(v.id) && str(v.nav) && typeof v.at === "number";
}

function isStanding(v: unknown): v is AgentStanding {
  return isRecord(v) && isAgent(v.agent) && typeof v.sessionsRun === "number";
}

/**
 * All three fields or nothing. A half-read vault would let a card print a cash
 * figure with no position count beside it, which is the reading — cash alone,
 * unqualified — this shape exists to prevent.
 *
 * `redeemable` and `unpricedTouched` are deliberately NOT required. They are
 * the priced half of the reading and the server omits them whenever pricing
 * failed or timed out; demanding them would make a slow indexer delete the
 * whole card, which is a strictly worse answer than the card without its
 * second figure. {@link vaultState} normalises their absence to `null`.
 */
function isVaultShape(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && str(v.cash) && str(v.unaccounted) && typeof v.touchedCount === "number";
}

/**
 * A vault reading with every optional field resolved to an explicit `null`.
 *
 * `undefined` and `null` render identically today, which is exactly why this
 * exists: the difference between "the server did not send it" and "the server
 * measured nothing" is invisible at the call site, so it is collapsed here,
 * once, into the one of the two that every screen already knows how to print.
 */
function vaultState(v: Record<string, unknown>): SessionVaultState {
  return {
    cash: v.cash as string,
    unaccounted: v.unaccounted as string,
    touchedCount: v.touchedCount as number,
    blockNumber: str(v.blockNumber) ? v.blockNumber : null,
    redeemable: str(v.redeemable) ? v.redeemable : null,
    unpricedTouched: typeof v.unpricedTouched === "number" ? v.unpricedTouched : null,
  };
}

function isVaultState(v: unknown): v is SessionVaultState {
  return isVaultShape(v);
}

/**
 * The same, plus what the vault said about its own session.
 *
 * `sessionOpen` is required rather than defaulted, because it decides which of
 * two things `cash` means — cash alone mid-session, the whole of NAV between
 * sessions — and a default would pick one of those meanings silently.
 */
function isAgentVaultShape(v: unknown): v is Record<string, unknown> {
  return isVaultShape(v) && typeof v.sessionOpen === "boolean";
}

/** {@link vaultState}, plus what the vault said about its own session. */
function agentVaultReading(v: Record<string, unknown>): AgentVaultReading {
  return {
    ...vaultState(v),
    sessionOpen: v.sessionOpen as boolean,
    sessionNumber: typeof v.sessionNumber === "number" ? v.sessionNumber : 0,
  };
}

function toVaultReading(v: Record<string, unknown> | null): VaultReading | null {
  if (!v || !str(v.nav)) return null;
  return {
    nav: v.nav,
    unaccounted: str(v.unaccounted) ? v.unaccounted : null,
    sessionOpen: typeof v.sessionOpen === "boolean" ? v.sessionOpen : null,
    sessionNumber: typeof v.sessionNumber === "number" ? v.sessionNumber : null,
    touched: Array.isArray(v.touched) ? v.touched.filter(str) : [],
  };
}

/**
 * One fetch, one error sentence.
 *
 * The routes answer failures with the shared `{ error, nextStep }` envelope
 * that `fail()` writes, so prefer the server's own words — they are written for
 * the reader (FR-045) — and fall back to the status code only when there are
 * none.
 */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const envelope = isRecord(body) ? body : null;
    const message = envelope && str(envelope.error) ? envelope.error : `The server answered ${res.status}.`;
    const next = envelope && str(envelope.nextStep) && envelope.nextStep ? ` ${envelope.nextStep}` : "";
    throw new Error(`${message}${next}`);
  }
  return res.json();
}

export async function loadStandings(signal?: AbortSignal): Promise<AgentStanding[]> {
  const payload = await getJson("/api/agents", signal);
  return pickTyped(payload, ["standings", "agents", "rows"], isStanding);
}

/** Both halves of one chain-touching answer. See {@link loadVaultReadings}. */
export interface VaultReadings {
  /** Keyed by session id, and valid only against that session. */
  bySession: Map<string, SessionVaultState>;
  /**
   * Keyed by agent id, for every registered agent — including those between
   * sessions, which `bySession` can say nothing about.
   */
  byAgent: Map<string, AgentVaultReading>;
}

/**
 * Live vault state, by session and by agent, from one request.
 *
 * A separate request from {@link loadStandings} on purpose. `/api/agents` is a
 * database projection that answers in a millisecond and ranks the whole board;
 * this one touches chain. Folding them together would make the ranking wait on
 * an RPC, and a board that cannot draw because a node is slow is a worse board
 * than one whose live column is briefly a dash.
 *
 * A key absent from either map is a vault with no reading — the read failed,
 * timed out, or reported a different session number. That is not the same as a
 * reading of zero and must never be rendered as one.
 *
 * `byAgent` is the half that is new, and it is here because the board's NAV
 * column and its capital total were built from the newest `agent_nav_points`
 * row — written at registration and at session close, and nowhere between — so
 * the column read 206.12 from 92.9 minutes earlier while the cards directly
 * above it showed the live 10.00 for the same `nav()`. The standing still
 * carries that sample, now named `lastNav` and shipped with its timestamp, but
 * this is the figure that replaces it on screen.
 */
export async function loadVaultReadings(signal?: AbortSignal): Promise<VaultReadings> {
  const payload = await getJson("/api/agents/sessions", signal);
  const bySession = new Map<string, SessionVaultState>();
  const byAgent = new Map<string, AgentVaultReading>();
  if (!isRecord(payload)) return { bySession, byAgent };

  if (Array.isArray(payload.open)) {
    for (const row of payload.open) {
      if (!isRecord(row)) continue;
      const session = row.session;
      const vault = row.vault;
      if (!isRecord(session) || !str(session.id)) continue;
      if (!isVaultShape(vault)) continue;
      bySession.set(session.id, vaultState(vault));
    }
  }

  // Only agents whose vault actually answered land in the map. A row carrying a
  // null reading is the route saying "asked, no answer", which is the same
  // thing to a caller as an absent key and must not become a zero.
  if (Array.isArray(payload.vaults)) {
    for (const row of payload.vaults) {
      if (!isRecord(row) || !str(row.agentId)) continue;
      if (!isAgentVaultShape(row.vault)) continue;
      byAgent.set(row.agentId, agentVaultReading(row.vault));
    }
  }

  return { bySession, byAgent };
}

export async function loadAgent(
  slug: string,
  /**
   * Which session's tape to serve. Null means the route picks — the live
   * session when there is one, otherwise the newest. The route has always
   * accepted `?session=`; nothing on the page had a way to ask for it, so a
   * busy agent's earlier trades were reachable only by hand-editing a URL.
   */
  sessionId: string | null = null,
  signal?: AbortSignal,
): Promise<AgentDetail> {
  const query = sessionId === null ? "" : `?session=${encodeURIComponent(sessionId)}`;
  const payload = await getJson(`/api/agents/${encodeURIComponent(slug)}${query}`, signal);

  const standingRecord = pickRecord(payload, ["standing"]);
  const standing = isStanding(standingRecord) ? standingRecord : null;

  // The agent may arrive on its own or inside the standing that wraps it.
  const direct = pickRecord(payload, ["agent"]);
  const agent = isAgent(direct) ? direct : standing?.agent ?? null;
  if (!agent) throw new Error("That answer did not contain an agent.");

  const envelope = isRecord(payload) ? payload : null;
  const liveVault: unknown = envelope?.vault;

  return {
    agent,
    standing,
    rank: envelope && typeof envelope.rank === "number" ? envelope.rank : null,
    outcomes: isRecord(envelope?.outcomes) ? (envelope.outcomes as Record<string, MarketOutcome>) : {},
    sessions: pickTyped(payload, ["sessions", "history"], isSession),
    trades: pickTyped(payload, ["trades", "tape"], isTrade),
    tradesSessionId: envelope && str(envelope.tradesSessionId) ? envelope.tradesSessionId : null,
    tradeHistory: {
      // Absent or malformed counts as zero, which renders as no line at all
      // rather than as "0 orders" under an agent that has traded.
      trades: isRecord(envelope?.tradeHistory) && typeof envelope.tradeHistory.trades === "number" ? envelope.tradeHistory.trades : 0,
      sessions: isRecord(envelope?.tradeHistory) && typeof envelope.tradeHistory.sessions === "number" ? envelope.tradeHistory.sessions : 0,
    },
    nav: pickTyped(payload, ["nav", "navPoints", "navSeries"], isNavPoint),
    // `chain` only — `vault` is deliberately not in this key list any more.
    // The two shapes overlap enough that `toVaultReading` would accept a
    // `SessionVaultState`, and a cash figure landing in a field the profile
    // prints as NAV is exactly the confusion this pair is separated to avoid.
    chain: toVaultReading(pickRecord(payload, ["chain", "reading"])),
    vault: isVaultShape(liveVault) ? vaultState(liveVault) : null,
    liveSessionId: envelope && str(envelope.liveSessionId) ? envelope.liveSessionId : null,
  };
}

export interface RegisterAgentBody {
  name: string;
  ownerAddress: string;
  vaultAddress: string;
  operatorAddress: string;
  strategy: string;
  strategyParams: Record<string, number | string>;
  repoUrl: string | null;
  blurb: string | null;
  /**
   * The exact text the owner signed. It is the replay guard as well as the
   * prompt — the route spends it once per owner — so it carries a timestamp.
   */
  nonce: string;
  /** EIP-191 `personal_sign` over `message` — the proof of `ownerAddress` (design §3 Layer 0). */
  signature: string;
}

/** Registration. Returns the created agent's slug, which is where the caller goes next. */
export async function registerAgent(body: RegisterAgentBody): Promise<string> {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  const envelope = isRecord(payload) ? payload : null;

  if (!res.ok) {
    const message = envelope && str(envelope.error) ? envelope.error : `The server answered ${res.status}.`;
    const next = envelope && str(envelope.nextStep) && envelope.nextStep ? ` ${envelope.nextStep}` : "";
    throw new Error(`${message}${next}`);
  }

  const created = pickRecord(payload, ["agent"]);
  if (isAgent(created)) return created.slug;
  if (envelope && str(envelope.slug)) return envelope.slug;
  throw new Error("The agent was created but the server did not say where to find it.");
}
