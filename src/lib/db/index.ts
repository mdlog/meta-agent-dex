/**
 * App database.
 *
 * The chain is the source of truth for every order, fill, NAV reading and
 * settlement in this product. This file holds only the index over it: which
 * owner registered which BotVault under which declared strategy, which session
 * maps to which meta-market id, and the trade and NAV log the UI reads without
 * re-deriving it from logs on every request. Nothing here is authoritative, so
 * nothing here is ever written back to chain.
 *
 * It carried a second half until the human trading path was removed —
 * `users`, `predictions`, `orders`, `arenas`, `arena_participants`,
 * `score_snapshots` and `telemetry`, the store behind a product where people
 * forecast prices. No code reaches them any more, so they are no longer
 * created, and {@link LEGACY_TABLES} drops them from any file that still has
 * them. That second step is not tidiness: `/privacy` tells a reader the user
 * table and the analytics table are gone, and for a while that was true of the
 * code and false of the database — `users` rows holding a wallet address and a
 * pseudonym, and the `telemetry` rows keyed to them, were still sitting in the
 * live file with nothing but an unused table name over them. A privacy notice
 * is a factual claim about data handling, so the claim and the schema ship
 * together.
 *
 * `node:sqlite` is built into Node 22, so the whole store is one file and no
 * service to run before a demo.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  ownerAddress    TEXT NOT NULL,
  vaultAddress    TEXT NOT NULL UNIQUE,
  operatorAddress TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  strategyParams  TEXT NOT NULL,
  configHash      TEXT NOT NULL,
  repoUrl         TEXT,
  blurb           TEXT,
  createdAt       INTEGER NOT NULL,
  lastHeartbeat   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(ownerAddress);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id              TEXT PRIMARY KEY,
  agentId         TEXT NOT NULL REFERENCES agents(id),
  sessionNumber   INTEGER NOT NULL,
  oracleAddress   TEXT NOT NULL,
  metaMarketId    TEXT,
  metaPoolAddress TEXT,
  opensAt         INTEGER NOT NULL,
  closesAt        INTEGER NOT NULL,
  navT0           TEXT,
  navT1           TEXT,
  outcomeValue    INTEGER,
  resolvedOutcome INTEGER,
  voided          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  openTx          TEXT,
  mintTx          TEXT,
  finalizeTx      TEXT,
  createdAt       INTEGER NOT NULL,
  UNIQUE (agentId, sessionNumber)
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent  ON agent_sessions(agentId);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_market ON agent_sessions(metaMarketId);

CREATE TABLE IF NOT EXISTS agent_trades (
  id        TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES agent_sessions(id),
  agentId   TEXT NOT NULL,
  marketId  TEXT NOT NULL,
  symbol    TEXT,
  kind      INTEGER NOT NULL,
  price     INTEGER NOT NULL,
  quantity  TEXT NOT NULL,
  cashDelta TEXT,
  txHash    TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_session ON agent_trades(sessionId);
CREATE INDEX IF NOT EXISTS idx_trades_agent   ON agent_trades(agentId);

-- Sampled so the agent page can draw a NAV curve without replaying the chain.
CREATE TABLE IF NOT EXISTS agent_nav_points (
  id          TEXT PRIMARY KEY,
  agentId     TEXT NOT NULL,
  sessionId   TEXT,
  nav         TEXT NOT NULL,
  unaccounted TEXT,
  blockNumber TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nav_agent ON agent_nav_points(agentId, at);
`;

/**
 * Tables from the forecasting product this app used to be, dropped on open.
 *
 * Children before parents, so the foreign keys never trip on the way out:
 * `telemetry` and `score_snapshots` reference `users`, `arena_participants`
 * references both `arenas` and `users`, and `arenas`, `orders` and
 * `predictions` reference `users` too.
 *
 * A fresh install never creates these, so this is a no-op on every file this
 * version wrote. It matters exactly once per deployment whose file predates
 * the rewrite — and it runs where the claim is made, rather than in a
 * migration note someone has to remember to run.
 */
const LEGACY_TABLES = [
  "telemetry",
  "score_snapshots",
  "arena_participants",
  "arenas",
  "orders",
  "predictions",
  "users",
] as const;

/**
 * Deliberately not wrapped in a try: if the drop cannot run, the app must not
 * come up serving a privacy page that says it did. The names are a literal
 * constant, never anything a request can reach, so there is nothing here to
 * interpolate unsafely.
 */
function dropLegacyTables(db: DatabaseSync): void {
  for (const table of LEGACY_TABLES) db.exec(`DROP TABLE IF EXISTS ${table};`);
}

const globalRef = globalThis as typeof globalThis & { __forecastArenaDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalRef.__forecastArenaDb) return globalRef.__forecastArenaDb;

  const file = resolve(process.env.FORECAST_ARENA_DB ?? ".data/forecast-arena.db");
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  dropLegacyTables(db);
  globalRef.__forecastArenaDb = db;
  return db;
}

/** Test helper: a schema-identical in-memory database with no shared state. */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

/** SQLite has no boolean type; these two keep the coercion in one place. */
export const toBit = (b: boolean) => (b ? 1 : 0);
export const fromBit = (n: unknown) => n === 1 || n === true;
