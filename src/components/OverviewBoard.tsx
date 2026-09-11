"use client";

/**
 * The head of the agent leaderboard, in the Signal Room's table.
 *
 * The top `OVERVIEW_ROWS` rows and nothing else: `/` is the overview, `/agents`
 * is the leaderboard, and this file used to print the whole ranked table with
 * its own search box — which made the two pages the same page and left
 * `README.md`'s UX claim standing on a difference that was not there.
 *
 * Same ranking rule as `/agents`, and it is the one thing here that must not be
 * relaxed for a prettier board: an agent with no *finished* session carries no
 * rank number, no win rate and no P&L, because a null is not a zero. This repo
 * has already shipped the other version once — "never staked" sorted as 0.00
 * and took rank 1 of a board titled Profit (docs/HACKATHON_READINESS.md) — so
 * the dash is deliberate everywhere it appears below.
 *
 * The design's "Risk" column is gone: nothing in this product measures an
 * agent's risk, and a Low/Medium/High chip would have been the invented number
 * on a page whose whole argument is that its numbers are checkable. Its slot
 * holds `BotVault.nav()` — a figure a reader can re-derive.
 *
 * THAT COLUMN IS WHY THIS FILE HAS A THIRD PARAGRAPH. It was headed "NAV now"
 * and it printed `agent_nav_points`' newest row, which is written twice per
 * session — at registration and at close — and therefore ages without bound.
 * Measured: 206.12 for Alpha-Z, from a row 92.9 minutes old, on the same paint
 * as a panel 400px above showing the live read of the same `nav()` at 10.00. A
 * reader given two values for one quantity has to decide which page to believe,
 * and every one of them is right to stop believing both. So the column reads
 * the vault, and where the vault does not answer it falls back to the stored
 * sample WITH ITS AGE and in the muted tone, so a figure that is not live can
 * never be scanned down the column as though it were.
 */

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import type { AgentSessionStatus } from "@/lib/domain/types";
import { addressUrl } from "@/lib/wallet/chain";
import { ageLabel, blockLabel, moneyTone, shortHex, signedUsdc, usdc } from "./agentFormat";
import { SessionSignalPill, type AgentAccent } from "./AgentStatusPill";
import { NavSpark, navSampleCount, navSparkDomain, type NavPoint } from "./NavSpark";

export interface BoardRow {
  id: string;
  slug: string;
  name: string;
  strategy: string;
  vaultAddress: string;
  /** 1-based placing, or null when the agent has finished nothing to be placed on. */
  rank: number | null;
  /** Raw 6dp NAV change across finished sessions. */
  netPnl: string;
  /** Fraction in [0,1]; null until a session has been answered. */
  winRate: number | null;
  /** Finished sessions only — the oracle answered and the answer stands. */
  sessionsRun: number;
  /** `nav()` read from this agent's vault on this request; null if it failed. */
  liveNav: string | null;
  /** The height that read was pinned to, when the node served one. */
  liveNavBlock: string | null;
  /**
   * True when the live read found a session open, so `liveNav` is CASH — the
   * vault's outcome-token holdings are not in it until `redeemAll()` at close.
   */
  liveSessionOpen: boolean;
  /** The newest stored sample. Shown only when the live read did not answer. */
  sampledNav: string | null;
  /** When that sample was taken. Null exactly when `sampledNav` is null. */
  sampledAt: number | null;
  /** The live session's state, or null when the agent is between sessions. */
  status: AgentSessionStatus | null;
  nav: NavPoint[];
  tone: AgentAccent;
}

/** What the NAV cell prints, and the one line underneath saying what it is. */
function navCell(row: BoardRow, renderedAt: number): { figure: string; note: string; live: boolean } {
  const block = blockLabel(row.liveNavBlock);

  if (row.liveNav !== null) {
    return {
      figure: usdc(row.liveNav),
      // `nav()` is `protocolCash`, so mid-session it is cash alone and saying
      // "NAV" would report an agent holding positions as an agent that lost the
      // money it spent on them.
      note: row.liveSessionOpen
        ? "cash · read now"
        : block
          ? `read now · block ${block}`
          : "read now",
      live: true,
    };
  }

  if (row.sampledNav !== null && row.sampledAt !== null) {
    return { figure: usdc(row.sampledNav), note: `sample · ${ageLabel(row.sampledAt, renderedAt)}`, live: false };
  }

  // Nothing measured. The dash says so and the note says why, which is the
  // whole of what this app knows.
  return { figure: "—", note: "vault did not answer", live: false };
}

/**
 * What the chart in the P&L cell is, in the few characters the cell has.
 *
 * The sample count is the load-bearing part: two samples are drawn as two dots
 * and a dashed connector because two points are an interpolation and not a
 * path, and this is the line that says so in words.
 */
function sparkNote(points: readonly NavPoint[]): string {
  const n = navSampleCount(points);
  if (n === 0) return "no nav() samples";
  if (n === 1) return "1 nav() sample";
  // The word does the work of the dashed stroke and the two dots: what sits
  // between two reads was drawn, not measured.
  if (n === 2) return "2 samples · interpolated";
  return `${n} samples`;
}

/**
 * How many rows an overview shows.
 *
 * `/` is the overview and `/agents` is the leaderboard — the split `README.md`
 * promises under the UX criterion. A page that reprints the entire ranked table
 * with its own search box is not an overview of that table, it is a second copy
 * of it, and for eleven agents the two pages were indistinguishable.
 */
const OVERVIEW_ROWS = 5;

export function OverviewBoard({
  rows,
  renderedAt,
}: {
  rows: BoardRow[];
  /**
   * The instant the page was built, used to age every sample below.
   *
   * Passed in rather than read here: this component renders on the server and
   * hydrates in the browser, and a `Date.now()` in the body would produce two
   * different ages for the same row — a hydration mismatch, on a number whose
   * entire job is to be trustworthy.
   */
  renderedAt: number;
}) {
  // ONE SCALE FOR THE WHOLE COLUMN, and it is built from `rows` rather than
  // from `visible`: a domain computed over five rows would draw the same agent
  // at a different height here than on `/agents`, which reads as a data change
  // when it is only a change of audience.
  const sparkDomain = useMemo(() => navSparkDomain(rows.map((row) => row.nav)), [rows]);

  // An overview shows the head of the board, not the board. Searching and
  // filtering a five-row table is furniture, and it was the whole of what
  // distinguished this page from `/agents` — the same rows, the same ranking
  // rule, twice. `standings()` already sorts the unproven to the bottom, so
  // this slice is the top of a ranking rather than an arbitrary sample.
  const visible = useMemo(() => rows.slice(0, OVERVIEW_ROWS), [rows]);

  return (
    <>
      {/* The ordering rule, stated rather than hidden behind a filter drawer.
          It is the thing a reader is most likely to misread: an unranked row is
          not a bad agent, it is an agent nothing has settled on yet. */}
      <p className="section-description">
        Ranked on finished sessions only. An agent with none carries no placing — no rank, no win
        rate, no P&amp;L.
      </p>

      <div className="agent-table-wrap">
        <table className="agent-table">
          <thead>
            <tr>
              <th scope="col" className="rank-col">
                #
              </th>
              <th scope="col">Agent</th>
              <th scope="col">Strategy</th>
              <th scope="col">Net NAV change</th>
              <th scope="col">Win rate</th>
              {/* "Finished", not "Settled". This column is `sessionsRun` —
                  finalized *or* settled, never voided — which is not what a
                  reader means by settled, and the count strip above the board
                  used the narrower word for a narrower number. One word, one
                  rule: `isFinished` in `agentStandings`. */}
              <th scope="col">Finished</th>
              {/* Named for the function, not for a moment. Each cell says which
                  moment it is: read now, or a sample with its age. */}
              <th scope="col">Vault nav()</th>
              <th scope="col">Session</th>
              <th scope="col">
                <span className="sr-only">Open agent</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const proven = row.sessionsRun > 0;
              const tone = proven ? moneyTone(row.netPnl) : null;
              const nav = navCell(row, renderedAt);
              return (
                <tr key={row.id}>
                  <td className="rank-cell mono">{row.rank === null ? "—" : String(row.rank).padStart(2, "0")}</td>

                  <td>
                    <div className="agent-cell">
                      <div className={`agent-avatar ${row.tone} text-xs font-semibold`} aria-hidden>
                        {/* The initial, not a robot glyph: it is the one mark
                            that differs per agent without inventing a face. */}
                        {row.name.trim().charAt(0).toUpperCase() || "?"}
                      </div>
                      <div>
                        <strong>
                          <Link href={`/agents/${row.slug}`} className="row-link hover:underline">
                            {row.name}
                          </Link>
                        </strong>
                        <a
                          className="address mono"
                          href={addressUrl(row.vaultAddress)}
                          target="_blank"
                          rel="noreferrer"
                          title={`Vault ${row.vaultAddress} on the Shannon explorer`}
                        >
                          {shortHex(row.vaultAddress)} <ExternalLink size={11} strokeWidth={1.8} />
                        </a>
                      </div>
                    </div>
                  </td>

                  <td>
                    <span className="strategy-chip">{row.strategy}</span>
                  </td>

                  <td>
                    {/* THE FIGURE AND THE PICTURE ARE DIFFERENT QUANTITIES, so
                        each is labelled. The figure is `netPnl` — NAV change
                        summed over sessions the oracle has answered. The chart
                        beside it is the agent's stored `nav()` samples plotted
                        as change from its own first read, on a scale shared by
                        every row, which includes movement inside a session that
                        has not settled. They can legitimately disagree; the two
                        captions are what let a reader see why. */}
                    <div className="performance-cell">
                      <strong className={tone === "good" ? "positive" : tone === "danger" ? "negative" : ""}>
                        {proven ? signedUsdc(row.netPnl) : "—"}
                      </strong>
                      <span>{proven ? "tUSDC across finished sessions" : "nothing finished yet"}</span>
                      <span className="performance-spark">
                        <NavSpark points={row.nav} domain={sparkDomain} />
                        <span>{sparkNote(row.nav)}</span>
                      </span>
                    </div>
                  </td>

                  <td>
                    <strong>{row.winRate === null ? "—" : `${Math.round(row.winRate * 100)}%`}</strong>
                  </td>

                  <td className="mono muted-cell">{row.sessionsRun}</td>

                  <td className="mono">
                    {/* The figure and its provenance are one cell, never two
                        columns: a reader who scans the numbers and misses the
                        note is exactly the reader this fix is for, so a
                        non-live figure is also muted. */}
                    <span className="flex flex-col items-start gap-1">
                      <strong className={nav.live ? "" : "text-fg-muted"}>{nav.figure}</strong>
                      <span className="text-xs text-fg-subtle">{nav.note}</span>
                    </span>
                  </td>

                  <td>
                    <SessionSignalPill status={row.status} />
                  </td>

                  <td>
                    <Link className="row-action" href={`/agents/${row.slug}`} aria-label={`Inspect ${row.name}`}>
                      <ArrowUpRight size={16} strokeWidth={1.8} />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {visible.length === 0 && (
          // There is no search to come up empty any more, so the only way this
          // renders is an arena with no agents registered at all.
          <div className="empty-state">
            <span>No agent has registered yet.</span>
          </div>
        )}
      </div>

      {rows.length > visible.length && (
        <Link href="/agents" className="view-link">
          All {rows.length} agents, with search and filters{" "}
          <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
        </Link>
      )}
    </>
  );
}
