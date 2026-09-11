/**
 * Live vault state for sessions that are still open.
 *
 * SERVER ONLY — it reaches chain through `./chain`, which reads the deployer
 * key at client construction.
 *
 * The stored session row carries `navT0` at open and `navT1` at close, and
 * between those two moments it carries nothing. A list rendered from the row
 * alone therefore has one number to print twice, which is how `/agents` came to
 * show "NAV NOW 250.00" beside "OPENED AT 250.00" on a vault that was actually
 * holding 166.81. This module is the second number.
 *
 * Three rules, all of them about not making a fast list slow or a wrong one
 * confident:
 *
 *  - CONCURRENT. Every vault is read at once, and each read is one height plus
 *    six `eth_call`s pinned to it, which `readVault` already batches with
 *    `Promise.all`. (viem caches the height for its polling interval, so a
 *    batch of vaults usually costs one `eth_blockNumber` between them.)
 *  - DEADLINED. A hung RPC must not hold the page. Past the deadline the read
 *    resolves `null`, the card prints a dash, and the request finishes; the
 *    read itself is left running so the cache below still gets its answer.
 *  - TOLERANT. A vault that reverts, a missing deployer key, an RPC that 500s —
 *    all of it becomes `null`. A live figure is a nicety on top of the journal,
 *    and it may never be the reason a route fails.
 */

import { readRedeemable, readVault } from "./chain";
import type { AgentVaultReading, SessionVaultState } from "@/lib/domain/types";

/**
 * How long a caller waits before giving up on the chain and rendering a dash.
 * Shorter than any of the polls that drive these screens (10s on the board,
 * 15s on the Overview), so a slow RPC costs one stale cell rather than a page
 * that hangs until the next refresh replaces it anyway.
 */
const DEADLINE_MS = 2_500;

/**
 * How long one vault's reading is reused.
 *
 * These screens poll, and every open browser polls independently: three agents
 * at 18 `eth_call`s a pass, times however many people have the arena open, is a
 * lot of RPC for a number that moves when a trade lands. The window is short
 * enough that a single client's own 10s poll always crosses it — nobody is
 * shown a cached figure on a refresh they asked for — and long enough that a
 * burst of simultaneous viewers collapses onto one read.
 */
const CACHE_MS = 3_000;

/** Registered agents number in the tens; this is a leak guard, not a policy. */
const MAX_CACHED_VAULTS = 200;

/**
 * The reading plus the redeem list it was taken from.
 *
 * `AgentVaultReading` publishes a `touchedCount` and not the ids, because a
 * screen has no use for them. Pricing what the vault is holding does, and
 * re-reading `touchedMarkets()` to get them back would be a second call for
 * something the first one already returned.
 */
interface InternalReading extends AgentVaultReading {
  touched: string[];
}

interface CacheEntry {
  at: number;
  /** Never rejects: the failure is folded into `null` before it is stored. */
  reading: Promise<InternalReading | null>;
}

/** Dev-mode module reloading would otherwise start a fresh cache per edit. */
const globalRef = globalThis as typeof globalThis & {
  __agentVaultReadings?: Map<string, CacheEntry>;
};

/**
 * How long one vault's REDEEMABLE figure is reused.
 *
 * Shorter than the 10s board poll for the same reason as `CACHE_MS`: a client
 * asking for a refresh must never be handed the answer it already had. Longer
 * than `CACHE_MS` would be wrong too — the figure moves on every trade, and a
 * card showing cash from this second beside holdings from the last one is the
 * mismatched-moments bug this module exists to prevent.
 */
const REDEEM_CACHE_MS = 3_000;

/**
 * The extra budget pricing may spend, on top of the vault read itself.
 *
 * A cold pricing pass costs one indexer round-trip plus two `eth_call`s per
 * resolved market, against six calls for the whole vault — so it is the larger
 * half of the request and gets its own timer rather than eating the vault
 * read's. Once `chain.ts` has cached a market's leg ids and its decided
 * outcome, both of which are write-once, the steady-state cost is a single
 * round of `balanceOf` and this budget is never approached.
 * Past it the figure is `null`, the card prints only what it measured, and the
 * read is left running so the cache still gets its answer.
 */
const REDEEM_DEADLINE_MS = 3_500;

interface RedeemEntry {
  at: number;
  /** Never rejects; a failure is folded into `null` before it is stored. */
  priced: Promise<{ redeemable: string; unpriced: number } | null>;
}

const redeemRef = globalThis as typeof globalThis & {
  __agentRedeemReadings?: Map<string, RedeemEntry>;
};

/**
 * Price one vault's holdings, cached and never throwing.
 *
 * Keyed by vault and by the redeem list it was priced from: the list changes
 * only at `openSession` and when a market is first touched, so including it
 * means a vault that starts holding something is repriced immediately instead
 * of showing a stale floor for the rest of the cache window.
 */
function priceOnce(vaultAddress: string, touched: readonly string[]): Promise<{ redeemable: string; unpriced: number } | null> {
  const store = (redeemRef.__agentRedeemReadings ??= new Map<string, RedeemEntry>());
  const key = `${vaultAddress.toLowerCase()}:${touched.join(",")}`;
  const now = Date.now();

  const hit = store.get(key);
  if (hit && now - hit.at < REDEEM_CACHE_MS) return hit.priced;

  const priced = readRedeemable(vaultAddress, touched).then(
    (r) => ({ redeemable: r.redeemable, unpriced: r.unpriced }),
    // Swallowed here rather than at the call site, so a vault whose pricing
    // fails caches the failure for the window instead of being retried by
    // every session row that shares it.
    () => null,
  );

  store.set(key, { at: now, priced });

  if (store.size > MAX_CACHED_VAULTS) {
    for (const [k, entry] of store) {
      if (now - entry.at >= REDEEM_CACHE_MS) store.delete(k);
    }
  }

  return priced;
}

/**
 * Price a batch of already-read vaults under ONE deadline.
 *
 * Same rule as `readBatch` and for the same reason: the caller's budget is
 * wall-clock, so N timers would let N slow vaults spend N x the deadline. A
 * vault that misses it comes back `null` and its card simply does not print
 * the figure.
 */
async function priceBatch(
  rows: readonly { key: string; vaultAddress: string; touched: readonly string[] }[],
): Promise<Map<string, { redeemable: string; unpriced: number }>> {
  const out = new Map<string, { redeemable: string; unpriced: number }>();
  if (rows.length === 0) return out;

  let expire: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    expire = setTimeout(() => resolve(null), REDEEM_DEADLINE_MS);
  });

  try {
    const settled = await Promise.all(
      rows.map(async (row) => [row.key, await Promise.race([priceOnce(row.vaultAddress, row.touched), deadline])] as const),
    );
    for (const [key, priced] of settled) {
      if (priced !== null) out.set(key, priced);
    }
  } finally {
    if (expire !== undefined) clearTimeout(expire);
  }

  return out;
}

function readOnce(vaultAddress: string): Promise<InternalReading | null> {
  const store = (globalRef.__agentVaultReadings ??= new Map<string, CacheEntry>());
  const key = vaultAddress.toLowerCase();
  const now = Date.now();

  const hit = store.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.reading;

  const reading = readVault(key).then(
    (v): InternalReading => ({
      cash: v.nav,
      unaccounted: v.unaccounted,
      touchedCount: v.touched.length,
      touched: v.touched,
      // Priced separately, by whoever wants it: this is the audited six-call
      // read and it does not grow to carry a figure most callers never print.
      redeemable: null,
      unpricedTouched: null,
      // Carried through so a screen can say which block it is quoting. A live
      // figure with a height beside it is checkable; one without is a claim.
      blockNumber: v.blockNumber,
      sessionOpen: v.sessionOpen,
      sessionNumber: v.sessionNumber,
    }),
    // Swallowed deliberately, and swallowed here rather than at the call site,
    // so a bad address caches its own failure for CACHE_MS instead of being
    // retried by every row of the same list.
    () => null,
  );

  store.set(key, { at: now, reading });

  if (store.size > MAX_CACHED_VAULTS) {
    for (const [k, entry] of store) {
      if (now - entry.at >= CACHE_MS) store.delete(k);
    }
  }

  return reading;
}

/**
 * Read a batch of vaults under ONE deadline, in the caller's own order.
 *
 * One timer for the whole batch: the caller's budget is wall-clock, not
 * per-vault, and N timers would let N slow vaults spend N × DEADLINE_MS. A
 * vault that misses the deadline comes back `null` here — the read itself is
 * left running so the cache still gets its answer for whoever asks next.
 */
async function readBatch<T extends { vaultAddress: string }>(
  rows: readonly T[],
): Promise<ReadonlyArray<readonly [T, InternalReading | null]>> {
  if (rows.length === 0) return [];

  let expire: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    expire = setTimeout(() => resolve(null), DEADLINE_MS);
  });

  try {
    return await Promise.all(
      rows.map(async (row) => {
        const reading = await Promise.race([readOnce(row.vaultAddress), deadline]);
        return [row, reading] as const;
      }),
    );
  } finally {
    // Node keeps the process awake for a pending timer, and a route that
    // resolved from cache in a millisecond should not hold the loop for 2.5s.
    if (expire !== undefined) clearTimeout(expire);
  }
}

/** One session's identity, as much of it as a vault read needs. */
export interface SessionVaultQuery {
  sessionId: string;
  /** The vault's own counter for this session — `agent_sessions.sessionNumber`. */
  sessionNumber: number;
  /** Null when the session outlived its agent row; such a row gets no reading. */
  vaultAddress: string | null;
}

/**
 * Read the vault behind each session, keyed by session id.
 *
 * A reading is attached only when the vault says it is still on THAT session.
 * A vault whose counter has moved on has already closed the session this row
 * describes and may have opened another, so its `nav()` is a different
 * session's cash — printing it against this row would be the same class of
 * mistake as printing `navT0` twice, with a number that looks live enough to
 * be believed. Mismatches come back `null`, and the card prints a dash.
 *
 * Every session id in `rows` is present in the result, so a caller can look up
 * without deciding what a missing key means.
 */
export async function liveVaultBySession(
  rows: readonly SessionVaultQuery[],
): Promise<Map<string, SessionVaultState | null>> {
  const out = new Map<string, SessionVaultState | null>();
  for (const row of rows) out.set(row.sessionId, null);
  // Rebuilt rather than filtered, so `vaultAddress` is a `string` below without
  // a cast telling the compiler something the filter already knows.
  const withVault = rows.flatMap((r) =>
    r.vaultAddress === null ? [] : [{ sessionId: r.sessionId, sessionNumber: r.sessionNumber, vaultAddress: r.vaultAddress }],
  );
  if (withVault.length === 0) return out;

  // Two passes on purpose. The vault read decides WHICH rows get a reading at
  // all — a vault that has moved on from this session is dropped here — and
  // only the survivors are worth spending an indexer round-trip on. Pricing a
  // row that is about to be discarded would be latency bought for nothing.
  const matched: { key: string; vaultAddress: string; touched: readonly string[]; reading: InternalReading }[] = [];
  for (const [row, reading] of await readBatch(withVault)) {
    if (reading === null) continue;
    if (!reading.sessionOpen || reading.sessionNumber !== row.sessionNumber) continue;
    matched.push({ key: row.sessionId, vaultAddress: row.vaultAddress, touched: reading.touched, reading });
  }

  const priced = await priceBatch(matched);

  for (const row of matched) {
    const value = priced.get(row.key) ?? null;
    out.set(row.key, {
      cash: row.reading.cash,
      unaccounted: row.reading.unaccounted,
      touchedCount: row.reading.touchedCount,
      blockNumber: row.reading.blockNumber,
      // Null when pricing failed or ran out of time. The card prints nothing
      // rather than a zero, because "we did not price it" and "it is worth
      // nothing" are opposite claims about an agent.
      redeemable: value?.redeemable ?? null,
      unpricedTouched: value?.unpriced ?? null,
    });
  }

  return out;
}

/** {@link liveVaultBySession} for a single session, which is what a profile needs. */
export async function liveVaultForSession(row: SessionVaultQuery): Promise<SessionVaultState | null> {
  const byId = await liveVaultBySession([row]);
  return byId.get(row.sessionId) ?? null;
}

/** One agent's identity, as much of it as a vault read needs. */
export interface AgentVaultQuery {
  agentId: string;
  vaultAddress: string;
}

/**
 * Read every agent's vault, keyed by agent id.
 *
 * The sibling above asks a question about a session and refuses to answer when
 * the vault has moved on from it. This one asks about the VAULT, which is the
 * question a leaderboard is really asking: every agent gets a row whether or
 * not a session is open, and the ones between sessions have no session for a
 * reading to be checked against.
 *
 * It exists because the alternative was what the board actually shipped —
 * `agent_nav_points`' newest row printed under "NAV now". Those rows are
 * written twice per session, at registration and at close, so the column aged
 * without bound: 206.12 from 92.9 minutes earlier, on the same paint as the
 * live 10.00 this function returns. The reading carries `sessionOpen` so the
 * screen can say which of the two things `nav()` means at that moment: cash
 * alone while positions are held, the whole of NAV between sessions.
 *
 * Cost is bounded by the same three rules as every read here — concurrent, one
 * shared deadline, and a 3s cache keyed by vault address, which the session
 * reads share, so an agent that appears in both batches is read once. The field
 * is tens of agents; if it ever stops being, this is where the cap goes.
 */
export async function liveVaultByAgent(
  rows: readonly AgentVaultQuery[],
): Promise<Map<string, AgentVaultReading | null>> {
  const out = new Map<string, AgentVaultReading | null>();
  // Every agent asked about is present in the answer, so a caller never has to
  // decide what a missing key means — it means the read failed, and that is a
  // dash with a reason, not an absence.
  for (const row of rows) out.set(row.agentId, null);

  for (const [row, reading] of await readBatch(rows)) {
    // `touched` is dropped rather than forwarded: it is the internal list that
    // made pricing possible, and the board's NAV column has no use for a
    // per-agent array of market ids. This list is also NOT priced — it covers
    // every registered agent including the ones between sessions, and pricing
    // all of them per poll would multiply the cost of a column that only
    // reports cash.
    out.set(
      row.agentId,
      reading === null
        ? null
        : {
            cash: reading.cash,
            unaccounted: reading.unaccounted,
            touchedCount: reading.touchedCount,
            blockNumber: reading.blockNumber,
            redeemable: reading.redeemable,
            unpricedTouched: reading.unpricedTouched,
            sessionOpen: reading.sessionOpen,
            sessionNumber: reading.sessionNumber,
          },
    );
  }

  return out;
}
