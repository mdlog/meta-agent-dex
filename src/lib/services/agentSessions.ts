/**
 * Agent sessions, and the journal that hangs off them
 * (docs/superpowers/specs/2026-09-07-meta-agent-dex-design.md §3).
 *
 * A session is the window a second-layer Event Contract is written against: the
 * vault locks deposits and opens, `BotNavOracle` snapshots navT0, the agent
 * trades, and after `closesAt` anyone may finalize an answer nobody can then
 * restate. These rows *mirror* that sequence — they never drive it, and no
 * caller may treat a row here as evidence of what the chain did.
 *
 * Money stays raw: every NAV, quantity and cash delta is the 6-decimal integer
 * that came off chain, carried as its decimal string and compared as a BigInt.
 * The guards that enforce that live in `./agents` alongside {@link AgentError},
 * so the two halves of the agent index cannot drift apart in what they accept.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getDb, toBit, fromBit } from "@/lib/db";
import type {
  AgentNavPoint,
  AgentSession,
  AgentSessionStatus,
  AgentTrade,
  AgentTradeKind,
} from "@/lib/domain/types";
import {
  AgentError,
  getAgentById,
  msTimestamp,
  normAddress,
  normAddressOrNull,
  normHash,
  normHashOrNull,
  rawSigned,
  rawUnsigned,
} from "./agents";

const SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "pending", "open", "closing", "finalized", "settled", "void",
];
/** The statuses a keeper still owes work on: mint, trade, redeem, finalize. */
const LIVE_STATUSES: readonly AgentSessionStatus[] = ["pending", "open", "closing"];

/** A binary outcome token can never cost more than one unit of collateral. */
const MAX_WIRE_PRICE = 1_000_000;

/** `kind` is validated on write, so this narrows a stored value rather than deciding it. */
function asTradeKind(v: unknown): AgentTradeKind {
  const n = Number(v);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new AgentError(`Unknown order kind ${String(v)} in agent_trades.`, "invalid");
}

function rowToSession(r: Record<string, unknown>): AgentSession {
  // 0 is the oracle's "no answer yet" and is never an outcome. Mapping it to
  // null here means no caller can read an unanswered session as NO — the one
  // confusion `BotNavOracle`'s 1/2 interval encoding exists to prevent.
  const outcome = r.outcomeValue as number | null;
  const resolved = r.resolvedOutcome as number | null;

  return {
    id: r.id as string,
    agentId: r.agentId as string,
    sessionNumber: Number(r.sessionNumber),
    oracleAddress: r.oracleAddress as string,
    metaMarketId: (r.metaMarketId as string | null) ?? null,
    metaPoolAddress: (r.metaPoolAddress as string | null) ?? null,
    opensAt: r.opensAt as number,
    closesAt: r.closesAt as number,
    navT0: (r.navT0 as string | null) ?? null,
    navT1: (r.navT1 as string | null) ?? null,
    outcomeValue: outcome === 1 || outcome === 2 ? outcome : null,
    resolvedOutcome: resolved === 0 || resolved === 1 ? resolved : null,
    voided: fromBit(r.voided),
    status: r.status as AgentSessionStatus,
    openTx: (r.openTx as string | null) ?? null,
    mintTx: (r.mintTx as string | null) ?? null,
    finalizeTx: (r.finalizeTx as string | null) ?? null,
    createdAt: r.createdAt as number,
  };
}

export interface CreateSessionInput {
  agentId: string;
  /** The vault's own session counter, so chain and index agree. */
  sessionNumber: number;
  oracleAddress: string;
  /** Milliseconds, never the vault's `uint64` seconds — `msTimestamp` refuses those. */
  opensAt: number;
  closesAt: number;
  openTx?: string | null;
}

export function createSession(input: CreateSessionInput, db: DatabaseSync = getDb()): AgentSession {
  if (!getAgentById(input.agentId, db)) {
    throw new AgentError("That agent does not exist.", "agent_unknown", {
      status: 404,
      nextStep: "Register the agent before opening a session for it.",
    });
  }
  if (!Number.isInteger(input.sessionNumber) || input.sessionNumber < 0) {
    throw new AgentError("sessionNumber must be the vault's own session counter.", "invalid");
  }

  const opensAt = msTimestamp(input.opensAt, "opensAt");
  const closesAt = msTimestamp(input.closesAt, "closesAt");
  // A session that closes before it opens has no window for the agent to trade
  // in, and the oracle would freeze navT1 against a navT0 it never took.
  if (closesAt <= opensAt) {
    throw new AgentError("A session must close after it opens.", "invalid");
  }

  const session: AgentSession = {
    id: randomUUID(),
    agentId: input.agentId,
    sessionNumber: input.sessionNumber,
    oracleAddress: normAddress(input.oracleAddress, "oracleAddress"),
    metaMarketId: null,
    metaPoolAddress: null,
    opensAt,
    closesAt,
    navT0: null,
    navT1: null,
    outcomeValue: null,
    resolvedOutcome: null,
    voided: false,
    // The market is not minted yet; nobody can bet on this session until it is.
    status: "pending",
    openTx: normHashOrNull(input.openTx, "openTx"),
    mintTx: null,
    finalizeTx: null,
    createdAt: Date.now(),
  };

  try {
    db.prepare(
      `INSERT INTO agent_sessions
         (id, agentId, sessionNumber, oracleAddress, metaMarketId, metaPoolAddress, opensAt, closesAt,
          navT0, navT1, outcomeValue, resolvedOutcome, voided, status, openTx, mintTx, finalizeTx, createdAt)
       VALUES (?,?,?,?,NULL,NULL,?,?,NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,?)`,
    ).run(
      session.id, session.agentId, session.sessionNumber, session.oracleAddress,
      session.opensAt, session.closesAt, toBit(session.voided), session.status,
      session.openTx, session.createdAt,
    );
  } catch (e) {
    // UNIQUE (agentId, sessionNumber): the vault counter is what makes a retried
    // openSession idempotent here instead of forking the index off the chain.
    if (String(e).includes("UNIQUE")) {
      throw new AgentError(`Session ${input.sessionNumber} already exists for this agent.`, "duplicate", {
        nextStep: "Read the vault's sessionId() and use the next one.",
      });
    }
    throw e;
  }

  return session;
}

/**
 * Columns a patch may move. Identity is deliberately absent: `id`, `agentId`,
 * `sessionNumber` and `createdAt` are how every trade and NAV point finds this
 * row, and `updateSession(s.id, { ...s, status: "open" })` is a normal thing to
 * write — so those keys are ignored rather than allowed to silently re-parent
 * a session's whole history.
 */
const SESSION_PATCH_COLUMNS = [
  "metaMarketId", "metaPoolAddress", "opensAt", "closesAt", "navT0", "navT1",
  "outcomeValue", "resolvedOutcome", "voided", "status", "openTx", "mintTx", "finalizeTx",
] as const;

type SessionPatchColumn = (typeof SESSION_PATCH_COLUMNS)[number];

function sessionPatchValue(column: SessionPatchColumn, patch: Partial<AgentSession>): string | number | null {
  switch (column) {
    case "metaMarketId":
      return normHashOrNull(patch.metaMarketId, "metaMarketId");
    case "metaPoolAddress":
      return normAddressOrNull(patch.metaPoolAddress, "metaPoolAddress");
    case "opensAt":
      return msTimestamp(patch.opensAt, "opensAt");
    case "closesAt":
      return msTimestamp(patch.closesAt, "closesAt");
    case "navT0":
      return patch.navT0 == null ? null : rawUnsigned(patch.navT0, "navT0");
    case "navT1":
      return patch.navT1 == null ? null : rawUnsigned(patch.navT1, "navT1");
    case "outcomeValue":
      // 0 means the committee has not answered. Storing it would make "no
      // answer yet" and "NAV fell" the same row.
      if (patch.outcomeValue == null) return null;
      if (patch.outcomeValue !== 1 && patch.outcomeValue !== 2) {
        throw new AgentError("outcomeValue is 1 (YES, NAV rose) or 2 (NO); 0 is not an answer.", "invalid");
      }
      return patch.outcomeValue;
    case "resolvedOutcome":
      if (patch.resolvedOutcome == null) return null;
      if (patch.resolvedOutcome !== 0 && patch.resolvedOutcome !== 1) {
        throw new AgentError("resolvedOutcome must be 0 or 1.", "invalid");
      }
      return patch.resolvedOutcome;
    case "voided":
      return toBit(patch.voided === true);
    case "status":
      if (!patch.status || !SESSION_STATUSES.some((s) => s === patch.status)) {
        throw new AgentError(`Session status must be one of ${SESSION_STATUSES.join(", ")}.`, "invalid");
      }
      return patch.status;
    case "openTx":
    case "mintTx":
    case "finalizeTx":
      return normHashOrNull(patch[column], column);
  }
}

/** Apply a partial update and return the row as it now stands. */
export function updateSession(
  id: string,
  patch: Partial<AgentSession>,
  db: DatabaseSync = getDb(),
): AgentSession {
  const current = getSession(id, db);
  if (!current) {
    throw new AgentError("That session does not exist.", "not_found", { status: 404 });
  }

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  for (const column of SESSION_PATCH_COLUMNS) {
    if (!(column in patch)) continue;
    sets.push(`${column} = ?`);
    args.push(sessionPatchValue(column, patch));
  }
  if (sets.length === 0) return current;

  args.push(id);
  db.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  const updated = getSession(id, db);
  if (!updated) {
    throw new AgentError("That session does not exist.", "not_found", { status: 404 });
  }
  return updated;
}

export function getSession(id: string, db: DatabaseSync = getDb()): AgentSession | null {
  const r = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
  return r ? rowToSession(r as Record<string, unknown>) : null;
}

/**
 * The reverse lookup DreamDEX forces on us: a meta-market page knows only the
 * bytes32 it was opened with, and has to find the session it settles from.
 */
export function getSessionByMarketId(marketId: string, db: DatabaseSync = getDb()): AgentSession | null {
  const r = db
    .prepare("SELECT * FROM agent_sessions WHERE metaMarketId = ?")
    .get(marketId.trim().toLowerCase());
  return r ? rowToSession(r as Record<string, unknown>) : null;
}

/** Newest first — the session an agent page leads with is its latest. */
export function listSessions(agentId: string, db: DatabaseSync = getDb()): AgentSession[] {
  return db
    .prepare("SELECT * FROM agent_sessions WHERE agentId = ? ORDER BY sessionNumber DESC LIMIT 200")
    .all(agentId)
    .map((r) => rowToSession(r as Record<string, unknown>));
}

/**
 * Every session still owed work — the keeper's queue, across all agents.
 *
 * Ordered by `closesAt` so the thing that expires soonest is handled first;
 * `finalize()` and the meta-market resolve path are both permissionless, so
 * falling behind here delays a settlement rather than losing one.
 */
export function listOpenSessions(db: DatabaseSync = getDb()): AgentSession[] {
  const holes = LIVE_STATUSES.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM agent_sessions WHERE status IN (${holes}) ORDER BY closesAt ASC LIMIT 200`)
    .all(...LIVE_STATUSES)
    .map((r) => rowToSession(r as Record<string, unknown>));
}

/**
 * Sessions whose oracle is frozen but whose committee verdict is not in yet.
 *
 * Deliberately its own query rather than a filter over {@link listOpenSessions}:
 * `finalized` is not a live status, so that filter matched nothing and the
 * keeper's "follow the committee" pass silently never ran — six meta-markets
 * resolved on chain while every row on `/settlement` still read "not read yet".
 * A queue that can never be non-empty is indistinguishable from a queue that
 * happens to be empty, which is why this is a query with a name.
 */
export function listAwaitingCommittee(db: DatabaseSync = getDb()): AgentSession[] {
  return db
    .prepare(
      "SELECT * FROM agent_sessions WHERE status = 'finalized' AND metaMarketId IS NOT NULL ORDER BY closesAt ASC LIMIT 200",
    )
    .all()
    .map((r) => rowToSession(r as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Trades and NAV samples
// ---------------------------------------------------------------------------

function rowToTrade(r: Record<string, unknown>): AgentTrade {
  return {
    id: r.id as string,
    sessionId: r.sessionId as string,
    agentId: r.agentId as string,
    marketId: r.marketId as string,
    symbol: (r.symbol as string | null) ?? null,
    kind: asTradeKind(r.kind),
    price: Number(r.price),
    quantity: r.quantity as string,
    cashDelta: (r.cashDelta as string | null) ?? null,
    txHash: r.txHash as string,
    at: r.at as number,
  };
}

export interface RecordTradeInput {
  sessionId: string;
  agentId: string;
  marketId: string;
  symbol?: string | null;
  kind: AgentTradeKind;
  /** Wire price in 6dp probability units, e.g. 620000 for 0.62. */
  price: number;
  /** Outcome-token quantity, raw. */
  quantity: string;
  /** Signed change in the vault's protocolCash, measured on chain. */
  cashDelta?: string | null;
  txHash: string;
  at?: number;
}

/**
 * Append one order to the session's tape.
 *
 * Idempotent by the tuple that identifies an order rather than by `txHash`
 * alone: the vault's `trade()` is one order per transaction today, but the
 * schema carries no UNIQUE on the hash and a batching wrapper would make one
 * wrong. A replayed receipt — the runner retrying, or a reorg re-delivering the
 * same log — returns the row already stored instead of doubling the tape and,
 * with it, any cashDelta sum drawn from it (§9.3 deduplication).
 */
export function recordTrade(input: RecordTradeInput, db: DatabaseSync = getDb()): AgentTrade {
  if (!Number.isInteger(input.price) || input.price < 0 || input.price > MAX_WIRE_PRICE) {
    throw new AgentError(
      `price must be a whole number of 6-decimal units between 0 and ${MAX_WIRE_PRICE}.`,
      "invalid",
    );
  }

  const trade: AgentTrade = {
    id: randomUUID(),
    sessionId: input.sessionId,
    agentId: input.agentId,
    marketId: normHash(input.marketId, "marketId"),
    symbol: (input.symbol ?? "").trim().slice(0, 60) || null,
    kind: asTradeKind(input.kind),
    price: input.price,
    quantity: rawUnsigned(input.quantity, "quantity"),
    cashDelta: input.cashDelta == null ? null : rawSigned(input.cashDelta, "cashDelta"),
    txHash: normHash(input.txHash, "txHash"),
    at: input.at ?? Date.now(),
  };

  const existing = db
    .prepare(
      `SELECT * FROM agent_trades
        WHERE txHash = ? AND marketId = ? AND kind = ? AND price = ? AND quantity = ?`,
    )
    .get(trade.txHash, trade.marketId, trade.kind, trade.price, trade.quantity);
  if (existing) return rowToTrade(existing as Record<string, unknown>);

  db.prepare(
    `INSERT INTO agent_trades (id, sessionId, agentId, marketId, symbol, kind, price, quantity, cashDelta, txHash, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    trade.id, trade.sessionId, trade.agentId, trade.marketId, trade.symbol, trade.kind,
    trade.price, trade.quantity, trade.cashDelta, trade.txHash, trade.at,
  );

  return trade;
}

/**
 * A session's tape, oldest first, so it reads alongside the NAV curve it
 * explains — both are drawn on the same axis on the agent page. `rowid` breaks
 * ties because two orders in one block share a millisecond.
 */
export function listTrades(sessionId: string, db: DatabaseSync = getDb()): AgentTrade[] {
  return db
    .prepare("SELECT * FROM agent_trades WHERE sessionId = ? ORDER BY at ASC, rowid ASC LIMIT 500")
    .all(sessionId)
    .map((r) => rowToTrade(r as Record<string, unknown>));
}

/** What one agent has done in total, across every session it has ever run. */
export interface TradeHistory {
  trades: number;
  sessions: number;
  /** Millisecond timestamp of the oldest trade, or null when there are none. */
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * The totals behind the tape.
 *
 * `listTrades` is scoped to one session because the profile draws one tape
 * against one NAV curve, and merging sessions would put orders from one window
 * under a heading about another. That is the right call for the tape and the
 * wrong one for a reader deciding whether anything was kept: when a new session
 * opens, the previous session's orders leave the screen, and a page that shows
 * nothing else looks like a page that lost them.
 *
 * So this counts, rather than fetching. One aggregate instead of the
 * hundred-thousand-row body the detail route's comment declines to serve.
 */
export function tradeHistory(agentId: string, db: DatabaseSync = getDb()): TradeHistory {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS trades,
              COUNT(DISTINCT sessionId) AS sessions,
              MIN(at) AS firstAt,
              MAX(at) AS lastAt
         FROM agent_trades
        WHERE agentId = ?`,
    )
    .get(agentId) as { trades: number; sessions: number; firstAt: number | null; lastAt: number | null };

  return {
    trades: Number(r.trades),
    sessions: Number(r.sessions),
    firstAt: r.firstAt === null ? null : Number(r.firstAt),
    lastAt: r.lastAt === null ? null : Number(r.lastAt),
  };
}

function rowToNavPoint(r: Record<string, unknown>): AgentNavPoint {
  return {
    id: r.id as string,
    agentId: r.agentId as string,
    sessionId: (r.sessionId as string | null) ?? null,
    nav: r.nav as string,
    unaccounted: (r.unaccounted as string | null) ?? null,
    blockNumber: (r.blockNumber as string | null) ?? null,
    at: r.at as number,
  };
}

export interface RecordNavPointInput {
  agentId: string;
  sessionId?: string | null;
  /** `vault.nav()`, raw 6dp. Never a token balance — the faucet is permissionless. */
  nav: string;
  unaccounted?: string | null;
  blockNumber?: string | null;
  at?: number;
}

/**
 * Sample the vault's NAV.
 *
 * Deduplicated on `(agentId, blockNumber)` when a block is given: NAV is a
 * function of chain state, so two reads at the same height are the same
 * measurement, and a poller running faster than the chain would otherwise draw
 * a staircase of identical points and make the curve look busier than the
 * agent was.
 *
 * PASS THE BLOCK. It is optional in the type because a read that could not pin
 * a height is still worth storing, but both call sites omitted it for the life
 * of the product, so `blockNumber` was NULL on every row while the Overview
 * promised "a number anyone can re-derive from two published block numbers".
 * `readVault` returns the height it pinned its calls to; hand it over.
 */
export function recordNavPoint(input: RecordNavPointInput, db: DatabaseSync = getDb()): AgentNavPoint {
  const point: AgentNavPoint = {
    id: randomUUID(),
    agentId: input.agentId,
    sessionId: input.sessionId ?? null,
    nav: rawUnsigned(input.nav, "nav"),
    unaccounted: input.unaccounted == null ? null : rawUnsigned(input.unaccounted, "unaccounted"),
    blockNumber: input.blockNumber == null ? null : rawUnsigned(input.blockNumber, "blockNumber"),
    at: input.at ?? Date.now(),
  };

  if (point.blockNumber !== null) {
    const existing = db
      .prepare("SELECT * FROM agent_nav_points WHERE agentId = ? AND blockNumber = ?")
      .get(point.agentId, point.blockNumber);
    if (existing) return rowToNavPoint(existing as Record<string, unknown>);
  }

  db.prepare(
    `INSERT INTO agent_nav_points (id, agentId, sessionId, nav, unaccounted, blockNumber, at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    point.id, point.agentId, point.sessionId, point.nav, point.unaccounted,
    point.blockNumber, point.at,
  );

  return point;
}

/** The NAV curve, oldest first — a chart plots forward in time, unlike a feed. */
export function navSeries(agentId: string, sinceTs = 0, db: DatabaseSync = getDb()): AgentNavPoint[] {
  return db
    .prepare("SELECT * FROM agent_nav_points WHERE agentId = ? AND at >= ? ORDER BY at ASC, rowid ASC LIMIT 2000")
    .all(agentId, sinceTs)
    .map((r) => rowToNavPoint(r as Record<string, unknown>));
}

/**
 * The most recent sample. NOT "NAV now", and there is no staleness bound here
 * on purpose.
 *
 * Rows land at exactly two moments — agent registration and session close — so
 * the newest one can be arbitrarily old, and this function has no way to know
 * how old is too old for a given screen. That judgement belongs to the caller,
 * which is why the whole row comes back rather than the figure: `at` and
 * `blockNumber` are what let a surface label the number, age it, or decide to
 * read the vault instead. `standings()` carries all three as `lastNav*` for
 * that reason. Callers that took the `nav` field alone are how a 93-minute-old
 * row came to print under "NAV now" beside a live read of 10.00.
 */
export function latestNavPoint(agentId: string, db: DatabaseSync = getDb()): AgentNavPoint | null {
  const r = db
    .prepare("SELECT * FROM agent_nav_points WHERE agentId = ? ORDER BY at DESC, rowid DESC LIMIT 1")
    .get(agentId);
  return r ? rowToNavPoint(r as Record<string, unknown>) : null;
}
