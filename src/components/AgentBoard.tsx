"use client";

/**
 * The agent board — the front door of the second layer.
 *
 * It ranks on what an agent *finished*, which is the ordering `agentStandings`
 * enforces and this screen must not quietly undo: an agent with no finished
 * session has no win rate, so it carries no rank number here either. The board
 * has already shipped the other version of that mistake once, on the profit
 * leaderboard, where "never staked" sorted as 0.00 and took rank 1
 * (docs/HACKATHON_READINESS.md). Search and the state filter subtract rows;
 * neither is allowed to reorder them.
 *
 * A request that fails renders as a failure, never as an empty field — those
 * two look identical if you are careless, and only one of them is true.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Bot,
  Filter,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  AgentSession,
  AgentStanding,
  AgentVaultReading,
  SessionVaultState,
} from "@/lib/domain/types";
import { addressUrl } from "@/lib/wallet/chain";
import { Countdown } from "./Countdown";
import { ExternalLink } from "./Primitives";
import { AgentStatusPill, agentAccent } from "./AgentStatusPill";
import { loadStandings, loadVaultReadings, type VaultReadings } from "./agentApi";
import {
  ageLabel,
  blockLabel,
  isTakingPositions,
  moneyTone,
  shortHex,
  signedUsdc,
  sumRaw,
  usdc,
} from "./agentFormat";

/**
 * Sessions run for minutes, and the keeper samples NAV at block cadence, so a
 * board left open goes stale inside a demo. 10s rather than the 5s `/explore`
 * uses: this read is a database projection over every agent, not a single
 * cached market, and nothing on it moves faster than a settlement.
 */
const POLL_MS = 10_000;

function isLive(s: AgentSession | null): s is AgentSession {
  return s !== null && (s.status === "pending" || s.status === "open" || s.status === "closing");
}

type StateFilter = "all" | "trading" | "settling" | "idle" | "record";

const FILTERS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "All agents" },
  { value: "trading", label: "Session open" },
  { value: "settling", label: "Settling" },
  { value: "idle", label: "No open session" },
  { value: "record", label: "Has a finished session" },
];

function matchesState(row: AgentStanding, filter: StateFilter): boolean {
  const s = row.liveSession;
  switch (filter) {
    case "trading":
      return s !== null && (s.status === "open" || s.status === "pending");
    case "settling":
      return s !== null && s.status === "closing";
    case "idle":
      return !isLive(s);
    case "record":
      return row.sessionsRun > 0;
    default:
      return true;
  }
}

/**
 * What the NAV column prints for one agent, and the line under it saying what
 * that figure is.
 *
 * Three states and they are kept apart on purpose: a live read, a stored sample
 * with its age, and nothing. Collapsing the first two into one figure is the
 * bug — the column had no way to say which it was showing, so it said "NAV" and
 * left the reader to assume the better of the two.
 */
function navCell(
  row: AgentStanding,
  reading: AgentVaultReading | null,
  now: number,
): { figure: string; note: string; live: boolean } {
  if (reading !== null) {
    const block = blockLabel(reading.blockNumber);
    return {
      figure: usdc(reading.cash),
      // `nav()` is `protocolCash`. Mid-session it excludes every position the
      // vault is holding, so calling it NAV would report an agent that spent 90
      // tUSDC on outcome tokens as an agent 90 tUSDC poorer.
      note: reading.sessionOpen ? "cash · read now" : block ? `read now · block ${block}` : "read now",
      live: true,
    };
  }

  if (row.lastNav !== null && row.lastNavAt !== null) {
    return { figure: usdc(row.lastNav), note: `sample · ${ageLabel(row.lastNavAt, now)}`, live: false };
  }

  return { figure: "—", note: "vault did not answer", live: false };
}

/** How far through its window a session is, for the card's telemetry bar. */
function elapsedFraction(s: AgentSession, now: number): number {
  const span = s.closesAt - s.opensAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - s.opensAt) / span));
}

export function AgentBoard() {
  const [rows, setRows] = useState<AgentStanding[] | null>(null);
  /**
   * Live cash per OPEN session, keyed by session id.
   *
   * The ranking and this are two requests because they are two different costs:
   * `/api/agents` is a database projection, `/api/agents/sessions` touches
   * chain. A board that could not draw its ranking because an RPC was slow
   * would be a worse board than one whose live column is briefly a dash.
   */
  const [vaults, setVaults] = useState<Map<string, SessionVaultState>>(new Map());
  /**
   * Live `nav()` per AGENT, keyed by agent id — the same request, other half.
   *
   * The one above is checked against a session and so covers only agents that
   * have one open. The NAV column and the capital tile have a row for every
   * agent, and they used to fill it from `AgentStanding.currentNav`: the newest
   * `agent_nav_points` row, written at registration and at session close and at
   * no other moment. So the column printed 206.12 from 92.9 minutes earlier
   * while the cards a screen above showed the live read of the same `nav()` at
   * 10.00. Same quantity, same paint, 20x apart.
   */
  const [agentVaults, setAgentVaults] = useState<Map<string, AgentVaultReading>>(new Map());
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  /**
   * The board's own clock, re-read on every poll and again at each expiry.
   *
   * The cards run a per-second `Countdown`; the board re-renders on the 10s
   * poll. Reading `Date.now()` at render would leave the summary tile claiming
   * a session was still taking positions for up to ten seconds after that
   * session's own card had switched to "awaiting settlement". One scheduled
   * timeout per boundary is cheaper than re-rendering a table every second and
   * lands on the same instant the countdown does.
   */
  const [clock, setClock] = useState(() => Date.now());

  const load = useCallback(async (signal: AbortSignal) => {
    // Started together, awaited apart. The ranking is the board; the vault
    // readings are an enrichment, and a failure of the second must not take
    // the first down with it.
    const ranking = loadStandings(signal);
    const live = loadVaultReadings(signal).catch(
      (): VaultReadings => ({ bySession: new Map(), byAgent: new Map() }),
    );

    try {
      const next = await ranking;
      if (signal.aborted) return;
      setRows(next);
      setFailed(null);
    } catch (e) {
      if (signal.aborted) return;
      // Rows already on screen are kept: a poll that failed has not
      // invalidated the last answer, and blanking the board would claim it had.
      setFailed((e as Error).message);
    }

    const readings = await live;
    if (signal.aborted) return;
    // Fresh rows, fresh clock: everything derived from `closesAt` below is
    // read against the same instant the rows arrived.
    setClock(Date.now());
    // Replaced wholesale rather than merged. A session or an agent missing from
    // this answer no longer has a reading, and carrying the previous one
    // forward would print a figure from before the vault stopped responding as
    // "read now" — the stale-under-a-live-label bug, rebuilt in the client.
    setVaults(readings.bySession);
    setAgentVaults(readings.byAgent);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const t = setInterval(() => void load(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [load, attempt]);

  useEffect(() => {
    if (rows === null) return;
    // The next window still ahead of us. Sessions already past their close have
    // nothing left to announce.
    const next = rows
      .map((r) => r.liveSession?.closesAt ?? null)
      .filter((at): at is number => at !== null && at > clock)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    // A little past the boundary rather than on it, so the re-render never
    // lands a tick early and re-asserts a window that has just shut.
    const t = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()) + 500);
    return () => clearTimeout(t);
  }, [rows, clock]);

  const visible = useMemo(() => {
    if (rows === null) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesState(r, filter)) return false;
      if (q === "") return true;
      return `${r.agent.name} ${r.agent.slug} ${r.agent.strategy} ${r.agent.vaultAddress}`
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, filter]);

  if (rows === null && failed === null) {
    return (
      <div className="page-card" aria-busy="true" aria-label="Loading the agent board">
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="skeleton h-4 w-6" />
              <div className="skeleton h-4" style={{ width: `${32 - i * 4}%` }} />
              <div className="skeleton ml-auto h-4 w-20" />
              <div className="skeleton hidden h-4 w-16 sm:block" />
              <div className="skeleton hidden h-4 w-16 md:block" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="page-card" role="alert">
        <div className="eyebrow">
          <span className="eyebrow-line" aria-hidden /> BOARD UNAVAILABLE
        </div>
        <h2 className="mt-3 font-display text-[22px] tracking-[-0.04em]">
          The agent board could not load
        </h2>
        <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-fg-muted">
          {failed} Every session and every trade is recorded on chain regardless — this is a display
          failure, and the board rebuilds from the vaults on the next load.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="secondary-button mt-5"
        >
          Try again
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="subpage-callout">
        <div className="callout-icon">
          <Bot size={18} strokeWidth={1.8} aria-hidden />
        </div>
        <div>
          <strong>No agents registered yet</strong>
          <p>
            An agent needs a deployed BotVault, collateral delivered through a DreamDEX call, and an
            operator key. Registering records it; its owner then opens the first session, and that is
            what mints a market anyone can take the other side of.
          </p>
        </div>
        <Link href="/docs" className="primary-button">
          <Plus size={15} strokeWidth={1.8} aria-hidden /> Set up the first agent
        </Link>
      </div>
    );
  }

  const live = rows.filter((r) => isLive(r.liveSession));
  const proven = rows.filter((r) => r.sessionsRun > 0);

  // Capital is summed as BigInt and printed once. A Number would drop the low
  // digits of a uint256 in 6-decimal units, and this is the headline figure.
  //
  // Summed from the LIVE readings, and only from the vaults that answered. This
  // read `sumRaw(rows.map((r) => r.currentNav))` — the newest stored sample per
  // agent, added up — under a subtitle that said "measured as nav()". It named
  // the on-chain function while showing a database row, which is the worst
  // version of this bug in the product: a label that tells the reader exactly
  // where to go and check, pointing at something else. A sum over samples taken
  // at different unstated moments is not a quantity anyone can re-derive.
  const liveCash = rows.map((r) => agentVaults.get(r.agent.id)?.cash ?? null);
  const vaultsRead = liveCash.filter((c) => c !== null).length;
  const capital = vaultsRead > 0 ? sumRaw(liveCash) : null;
  const finished = rows.reduce((n, r) => n + r.sessionsRun, 0);
  const now = clock;

  // Read off the same clock the cards below read.
  //
  // `open` says only that no keeper has called `closeSession()` yet, which is a
  // fact about our keeper and not about the market. This tile counted those
  // rows and printed "taking bets right now" while, in the same paint, all
  // three cards under it read "closes in awaiting settlement" — the countdown
  // had already crossed `closesAt`. A market past its expiry takes nothing, so
  // the subtitle now comes from `closesAt` and the tile's pulse goes out with
  // the last live window.
  const takingPositions = live.filter(
    (r) => r.liveSession !== null && isTakingPositions(r.liveSession, now),
  ).length;
  const pastExpiry = live.length - takingPositions;

  const openFoot =
    live.length === 0
      ? "none taking positions right now"
      : pastExpiry === 0
        ? "taking positions right now"
        : takingPositions === 0
          ? `past the close · ${pastExpiry === 1 ? "awaiting settlement" : "all awaiting settlement"}`
          : `${takingPositions} taking positions · ${pastExpiry} awaiting settlement`;

  return (
    <div>
      <div className="stat-grid four">
        <div className="stat-card">
          <span className="metric-label">Agents registered</span>
          <strong className="num">{rows.length}</strong>
          <span className="metric-delta neutral">
            {proven.length} with a finished session
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Sessions open</span>
          <strong className="num">{live.length}</strong>
          <span className="metric-delta neutral">
            {takingPositions > 0 && <span className="tiny-signal" aria-hidden />}
            {openFoot}
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Capital in vaults</span>
          <strong className="num">{capital === null ? "—" : usdc(capital)}</strong>
          {/* The subtitle now names both the function AND the moment, because
              "measured as nav()" was true of neither the figure above it nor
              the row it came from. When no vault answers, the tile says that
              rather than printing a sum of nothing as 0.00. */}
          <span className="metric-delta neutral">
            {capital === null
              ? "no vault answered this read"
              : `tUSDC · nav() read now from ${vaultsRead} of ${rows.length} vaults`}
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Sessions finished</span>
          <strong className="num">{finished}</strong>
          <span className="metric-delta neutral">oracle answered · void excluded</span>
        </div>
      </div>

      <section className="section-block">
        <div className="page-card">
          <div className="card-header-row">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" aria-hidden /> SIGNAL INDEX
              </div>
              <h2>Standings</h2>
              <p className="section-description">
                Ranked by win rate over finished sessions. An agent that has finished one outranks
                every agent that has not, before any number is compared.
              </p>
            </div>
            <span className="live-chip">
              {/* `.status-dot` only gets its size from `.status-pill`, and this
                  is a chip, not a pill — so the dot draws itself here. */}
              <span className="live-dot h-[5px] w-[5px] rounded-full bg-accent" aria-hidden /> refreshed
              every 10s
            </span>
          </div>

          {failed && (
            <p className="callout callout-warn mb-4 text-fg-muted" role="status">
              The last refresh failed, so these rows are the previous answer rather than the current
              one. {failed}
            </p>
          )}

          <div className="table-toolbar">
            <div className="search-box">
              <Search size={16} strokeWidth={1.8} aria-hidden />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agent, strategy or vault"
                aria-label="Search agent, strategy or vault"
              />
            </div>
            <div className="toolbar-actions">
              <button
                type="button"
                className={`filter-button ${showFilters ? "active" : ""}`}
                onClick={() => setShowFilters((v) => !v)}
                aria-expanded={showFilters}
              >
                <Filter size={15} strokeWidth={1.8} aria-hidden /> How this is ranked
              </button>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as StateFilter)}
                aria-label="Filter by session state"
              >
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {showFilters && (
            <div className="filter-drawer gap-6">
              <span>
                Win rate counts sessions where the oracle answered &ldquo;NAV rose&rdquo; — its own
                frozen answer, not a recomputation, because that is what DreamDEX settled the
                meta-market on. Voided sessions are excluded from the record entirely.
              </span>
              <button
                type="button"
                className="shrink-0 self-start"
                onClick={() => {
                  setFilter("all");
                  setSearch("");
                  setShowFilters(false);
                }}
              >
                Clear filters <X size={13} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          )}

          <div className="agent-table-wrap">
            <table className="agent-table extended">
              <thead>
                <tr>
                  <th scope="col" className="rank-col">
                    #
                  </th>
                  <th scope="col">Agent</th>
                  <th scope="col">Strategy</th>
                  {/* Named for the function, not for a moment — each cell says
                      which moment it is. "NAV" alone let a stored sample and a
                      chain read share one heading. */}
                  <th scope="col">Vault nav()</th>
                  <th scope="col">Net P&amp;L</th>
                  <th scope="col">Win rate</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Session</th>
                  <th scope="col">
                    <span className="sr-only">Open profile</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  // The rank is the row's place on the *board*, not its place in
                  // the filtered view: hiding four agents does not promote the
                  // fifth. `rows` is the server's order and is never re-sorted.
                  const place = rows.indexOf(r) + 1;
                  const s = r.liveSession;
                  const tone = moneyTone(r.netPnl);
                  const accent = agentAccent(r.agent.slug);
                  const nav = navCell(r, agentVaults.get(r.agent.id) ?? null, now);

                  return (
                    <tr key={r.agent.id}>
                      <td className="rank-cell mono">
                        {/* No rank for an agent with nothing finished. A number
                            here would read as a placing it has not earned. */}
                        {r.sessionsRun > 0 ? String(place).padStart(2, "0") : "—"}
                      </td>

                      <td>
                        <div className="agent-cell">
                          <span className={`agent-avatar ${accent}`} aria-hidden>
                            <Bot size={17} strokeWidth={1.8} />
                          </span>
                          <div className="min-w-0">
                            <strong>
                              <Link href={`/agents/${r.agent.slug}`} className="row-link hover:text-accent">
                                {r.agent.name}
                              </Link>
                            </strong>
                            <ExternalLink
                              href={addressUrl(r.agent.vaultAddress)}
                              className="address hover:text-fg-muted"
                            >
                              vault {shortHex(r.agent.vaultAddress)}
                            </ExternalLink>
                          </div>
                        </div>
                      </td>

                      <td>
                        <span className="strategy-chip">{r.agent.strategy}</span>
                      </td>

                      <td className="num font-mono">
                        {/* Figure and provenance in one cell. A non-live figure
                            is muted as well as labelled, so it cannot be
                            scanned down the column as though it were current. */}
                        <span className="flex flex-col items-start gap-1">
                          <strong className={nav.live ? "" : "text-fg-muted"}>{nav.figure}</strong>
                          <span className="text-[9px] text-fg-subtle">{nav.note}</span>
                        </span>
                      </td>

                      <td>
                        <div className="performance-cell">
                          {r.sessionsRun === 0 ? (
                            <strong className="text-fg-subtle">—</strong>
                          ) : (
                            <strong className={tone === "good" ? "positive" : tone === "danger" ? "negative" : ""}>
                              {signedUsdc(r.netPnl)}
                            </strong>
                          )}
                          <span>
                            {r.sessionsRun === 0 ? "no settled session" : "across finished sessions"}
                          </span>
                        </div>
                      </td>

                      <td>
                        {r.winRate === null ? (
                          <span className="text-fg-subtle">—</span>
                        ) : (
                          <strong className="num">{Math.round(r.winRate * 100)}%</strong>
                        )}
                      </td>

                      <td className="num muted-cell font-mono">
                        {r.sessionsRun === 0 ? "—" : `${r.sessionsWon}/${r.sessionsRun}`}
                      </td>

                      <td>
                        {isLive(s) ? (
                          <span className="flex flex-col items-start gap-1.5">
                            <AgentStatusPill status={s.status} />
                            <span className="num font-mono text-[9px] text-fg-subtle">
                              <Countdown to={s.closesAt / 1000} />
                            </span>
                          </span>
                        ) : (
                          <span className="status-pill">
                            <span className="status-dot rounded-full" aria-hidden />
                            Idle
                          </span>
                        )}
                      </td>

                      <td>
                        <Link
                          href={`/agents/${r.agent.slug}`}
                          className="row-action inline-flex"
                          aria-label={`Open ${r.agent.name}`}
                        >
                          <ArrowUpRight size={16} strokeWidth={1.8} aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {visible.length === 0 && (
              <div className="empty-state">
                <Search size={18} strokeWidth={1.8} aria-hidden />
                <span>
                  No agent matches this view. {rows.length} agent{rows.length === 1 ? " is" : "s are"}{" "}
                  registered.
                </span>
              </div>
            )}
          </div>
        </div>

        <p className="mt-4 max-w-[86ch] text-[11px] leading-relaxed text-fg-subtle">
          <span className="mono">nav()</span> is the vault&apos;s own figure — collateral an
          allowlisted DreamDEX call delivered — and never a token balance, because the Shannon faucet
          is open to anyone. The column reads it from each vault as this board refreshes; while a
          session is open that is cash alone, since collateral spent on outcome tokens only converts
          back when <span className="mono">redeemAll()</span> runs at close. A vault that does not
          answer shows the last stored sample instead, greyed and with its age — those samples are
          written when an agent registers and when a session closes, so one can be hours old. Net
          P&amp;L is the sum of NAV changes across finished sessions, compared as integers in
          6-decimal units so no digit is lost on the way to the page.
        </p>
      </section>
    </div>
  );
}
