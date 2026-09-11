"use client";

/**
 * Live meta-markets, as the Overview shows them: one feature panel and a list
 * that drives it.
 *
 * Every row here is a session that exists — a `BotVault` window with a minted
 * DreamDEX Event Contract behind it — and every price is that contract's own
 * book. Where the design carried a mocked "68¢ / $42.8k / 02h 18m", this shows
 * what that book has said, its resting depth, and a countdown to the session's
 * real `closesAt`; when the book has never quoted, it shows a dash, because a
 * made-up midpoint on an unquoted market is the one number a reader would act
 * on.
 *
 * "What that book has said" is not always a probability. A meta-market opens
 * with its session and has minutes to attract a quote, so one-sided books are
 * the ordinary case here, and one resting order bounds fair value rather than
 * locating it. The panel prints the bound with its sign and drops the fill bar
 * rather than drawing a split nobody quoted — see `priceFormat`.
 *
 * "Its resting depth" is a chain read of the pool's own levels, taken by the
 * page — not a flag dressed up as a size, which is what this panel printed
 * before ("Book 1 contracts" over 182.5 resting). Depth arrives as a
 * {@link BookDepth}, so a book that is empty, a book whose contract has closed,
 * and a book nobody could read each get their own sentence. The last one is the
 * important one: an unread book must never render as an empty one.
 *
 * The feature panel does not open a second market UI. A meta-market is a native
 * Event Contract, so the button goes to `/market/[id]` — the same instrument
 * face and the same book as every other contract on the venue.
 */

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Clock3, Hexagon, Plus } from "lucide-react";
import type { AgentSessionStatus, PriceBasis, SessionVaultState } from "@/lib/domain/types";
import type { BookDepth } from "@/lib/domain/book";
import { depthLabel, depthLabelShort, depthTone } from "./bookFormat";
import { Countdown } from "./Countdown";
import { NavField, type NavPoint } from "./NavSpark";
import { sessionLabel, type AgentAccent } from "./AgentStatusPill";
import { moneyTone, usdc } from "./agentFormat";
import { basisNote, basisSentence, downText, upText } from "./priceFormat";

/**
 * The contract's question, or the reason this screen has none.
 *
 * A union rather than `string | null` because the missing case has to survive
 * all the way to the markup: an `<h3>` is where a reader looks for the sentence
 * the contract settles on, and anything sitting there is read as that sentence.
 * The page is not allowed to compose one.
 */
export type MetaMarketQuestion =
  | { readonly source: "contract"; readonly text: string }
  | { readonly source: "unread"; readonly reason: string };

export interface MetaMarketRow {
  sessionId: string;
  sessionNumber: number;
  agentName: string;
  /** Null only when a session outlived its agent row — a broken key, shown not hidden. */
  agentSlug: string | null;
  /** bytes32 of the minted Event Contract. Rows without one never reach this list. */
  marketId: string;
  question: MetaMarketQuestion;
  /**
   * What the contract's book says about P(YES), in [0,1]; null when nothing
   * has quoted and nothing has traded.
   *
   * Only a probability when {@link yesBasis} is `"mid"`. On a one-sided book it
   * is the resting side itself, which bounds fair value rather than locating
   * it, and the panel writes it with a ≥ or a ≤ for that reason.
   */
  yes: number | null;
  /** How `yes` was arrived at — carried from the adapter, never inferred here. */
  yesBasis: PriceBasis;
  /**
   * Resting size on that book — measured, empty, closed, or unread, and never
   * collapsed into one of those. `bookDepth: number | null` used to arrive here
   * as the adapter's 1-or-0 "something is quoted" flag and print as
   * "1 contracts"; null (a read that failed) shared its string with zero and
   * printed "no resting orders" about books nobody had seen.
   */
  depth: BookDepth;
  /** Unix ms — the session's own deadline, not the browser's guess at one. */
  closesAt: number;
  status: AgentSessionStatus;
  /** Raw 6dp NAV the session opened at: the level the contract settles against. */
  navT0: string | null;
  /**
   * The vault as chain reads it right now, or null when that read did not
   * answer. Every session in this list is OPEN, so `vault.cash` is cash and
   * never the vault's worth — the panel below is required to say which.
   */
  vault: SessionVaultState | null;
  nav: NavPoint[];
  tone: AgentAccent;
}

/** Whole percent, for the bar's width only — never for a figure a reader sees.
 *  The pool's tick is finer, but a headline that moves on the third decimal
 *  reads as noise; `/market/[id]` carries the exact book. */
function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * Collateral in the vault that no DreamDEX call delivered, when there is any.
 * `moneyTone` is the parser as well as the sign test, so an unreadable field
 * reads as "nothing to show" rather than as a zero somebody measured.
 */
function unaccountedOf(row: MetaMarketRow): string | null {
  if (row.vault === null) return null;
  return moneyTone(row.vault.unaccounted) === "good" ? row.vault.unaccounted : null;
}

export function OverviewMarkets({ rows }: { rows: MetaMarketRow[] }) {
  const [selected, setSelected] = useState(0);
  // The page renders its own empty state rather than mounting this, so an empty
  // list here means the two got out of step. Render nothing rather than crash.
  if (rows.length === 0) return null;

  const feature = rows[Math.min(selected, rows.length - 1)];
  const yes = feature.yes;
  const yesBasis = feature.yesBasis;
  // The fill bar draws a split, so only a reading that IS a split may fill it:
  // a bound has not said where the line falls, and a last print says where one
  // trade went rather than where the book stands. Both leave the empty track,
  // which keeps the panel's rhythm without asserting a position on it.
  const yesSplit = yesBasis === "mid" || yesBasis === "settled";

  return (
    <div className="market-layout">
      <article className="market-feature">
        <div className="market-image">
          <div className="image-tag">
            <span className="status-dot" aria-hidden /> {sessionLabel(feature.status).toUpperCase()}
          </div>
          {/* The panel's artwork is the agent's measured cash against the level
              this contract settles on. Nothing is drawn when the vault has not
              been sampled twice yet — the generated field stands on its own.
              Drawn neutral because every session here is still open: below the
              dashed baseline means "holding positions", not "losing". */}
          <NavField
            points={feature.nav}
            baseline={feature.navT0}
            neutral
            label={`${feature.agentName} vault cash this session, against the level the contract settles on`}
          />
        </div>

        <div className="market-feature-body">
          <div className="market-overline">
            {feature.agentSlug === null ? (
              <span>{feature.agentName}</span>
            ) : (
              <Link href={`/agents/${feature.agentSlug}`} className="hover:underline">
                {feature.agentName}
              </Link>
            )}
            <span className="mono">
              SESSION {String(feature.sessionNumber).padStart(2, "0")} · CLOSES{" "}
              <Countdown to={feature.closesAt / 1000} />
            </span>
          </div>

          {feature.question.source === "contract" ? (
            <h3>{feature.question.text}</h3>
          ) : (
            /* Nothing stands in for the contract's sentence. The heading says
               what is missing and the line under it says why — a reader who
               cannot see the question at least knows that is what they are
               looking at, rather than reading ours as the contract's. */
            <div className="mt-5 mb-7">
              <h3 className="my-0 text-fg-subtle">Question not read</h3>
              <p className="mt-2 max-w-[46ch] text-[10px] leading-relaxed text-fg-subtle">
                {feature.question.reason}. Only the contract states what it settles on; open it
                below to read the question from the market itself.
              </p>
            </div>
          )}

          {/* THE PAIR IS A SPLIT ONLY WHEN BOTH SIDES REST. A meta-market's
              book is thin by construction — it opens with the session and has
              minutes to attract a quote — so one-sided is the common case, and
              a confident "YES 14% / 86% NO" over a single resting bid is the
              panel asserting a probability the contract never quoted. The signs
              come from `priceBasis`, and the fill under the pair stays empty
              wherever the reading is not a split: a bar drawn to 14% is a
              picture of a number, and a bound is not that number. The empty
              track stays, so the panel keeps its shape without claiming one. */}
          <div className="market-probability">
            <div className="probability-main">
              <strong>{upText(yes, yesBasis)}</strong>
              <span>YES · NAV RISES</span>
            </div>
            <div className="probability-divider" />
            <div className="probability-secondary">
              <strong>{downText(yes, yesBasis)}</strong>
              <span>NO · NAV FALLS</span>
            </div>
            <div className="probability-bar">
              <span style={{ width: yesSplit && yes !== null ? pct(yes) : "0%" }} />
            </div>
          </div>

          {yesBasis !== "mid" && (
            <p className="mb-4 max-w-[62ch] text-[10px] leading-relaxed text-fg-subtle">
              {basisSentence(yesBasis)}
            </p>
          )}

          {/* The two figures the oracle will eventually compare, and the reason
              they do not compare yet. Neither is tinted: while the session is
              open the left one is `protocolCash` alone, so an agent holding
              outcome tokens reads below its own baseline and a colour here
              would call that a loss. */}
          <div className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-line pt-4">
            <span className="text-[11px] text-fg-muted">
              <span className="muted-label">Vault cash</span>{" "}
              <span className="num font-mono text-fg">{usdc(feature.vault?.cash ?? null)}</span>
              {" / "}
              <span className="num font-mono text-fg">{usdc(feature.navT0)}</span> at open
            </span>
            {/* NOT "markets traded this session". `touchedCount()` is the
                length of the vault's redeem list, and `openSession()`
                COMPACTS that list instead of clearing it
                (contracts/BotVault.sol:150-168): any market still holding a
                position from an earlier session is kept so `redeemAll()` can
                still reach it. That is deliberate — clearing it once stranded
                17.22 tUSDC in a resolved market the vault could no longer
                redeem — and it means this number can include carryover, under
                a panel headed SESSION 03. So it is labelled for the list it
                counts, not for the session it sits beside. */}
            {feature.vault !== null && (
              <span className="text-[11px] text-fg-subtle">
                <span className="mono">touched()</span> holds {feature.vault.touchedCount}{" "}
                {feature.vault.touchedCount === 1 ? "market" : "markets"}
              </span>
            )}
          </div>

          <p className="mb-5 max-w-[62ch] text-[10px] leading-relaxed text-fg-subtle">
            {feature.vault === null
              ? "No live cash figure right now — the vault did not answer this read. The figure at open is the level this contract settles against."
              : "Cash, not NAV — positions convert back to cash when redeemAll() runs at close, and settlement compares cash at close to cash at open. touched() is the vault's redeem list rather than a per-session tally: opening a session keeps any market still holding a position from an earlier one, so the count can include carryover."}
            {unaccountedOf(feature) !== null && (
              <>
                {" "}
                <span className="mono">unaccounted()</span> holds{" "}
                {usdc(unaccountedOf(feature))} tUSDC that no DreamDEX call delivered, excluded from
                NAV by construction.
              </>
            )}
          </p>

          <div className="market-footer">
            <span className={depthTone(feature.depth)}>
              <span className="muted-label">Book</span> {depthLabel(feature.depth)}
            </span>
            <Link className="secondary-button" href={`/market/${feature.marketId}`}>
              Open the contract <ArrowUpRight size={15} strokeWidth={1.8} />
            </Link>
          </div>
        </div>
      </article>

      <div className="market-list">
        {rows.map((row, index) => (
          <button
            key={row.sessionId}
            type="button"
            className={`market-row ${selected === index ? "selected" : ""}`}
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            <div className={`market-icon ${row.tone}`}>
              <Hexagon size={19} strokeWidth={1.8} />
            </div>
            {/* Block children of a button, as the ported CSS expects:
                `.market-row-copy > span` styles the question line, so the meta
                row below it has to be a div or it inherits that treatment. */}
            <div className="market-row-copy">
              <strong>{row.agentName}</strong>
              {row.question.source === "contract" ? (
                <span>{row.question.text}</span>
              ) : (
                <span className="text-fg-subtle">Question not read</span>
              )}
              {/* The same rule as the panel, at row width: `upText` writes a
                  one-sided book as "YES ≥ 14%", and the basis note beside it
                  says which side is resting. A row that printed a bare
                  "YES 14%" for a lone bid is the panel's bug at a smaller
                  size. */}
              <div className="market-row-meta">
                <span>{row.yes === null ? "No quote" : `YES ${upText(row.yes, row.yesBasis)}`}</span>
                {row.yesBasis !== "mid" && row.yes !== null && (
                  <>
                    <span>·</span>
                    <span>{basisNote(row.yesBasis)}</span>
                  </>
                )}
                <span>·</span>
                <span className={depthTone(row.depth)}>{depthLabelShort(row.depth)}</span>
              </div>
            </div>
            <div className="market-row-right">
              <span className="expiry">
                <Clock3 size={12} strokeWidth={1.8} />
                <Countdown to={row.closesAt / 1000} />
              </span>
              <ChevronDown size={16} strokeWidth={1.8} className="market-chevron" />
            </div>
          </button>
        ))}

        {/* The design's "Create a meta-market" was an action nobody has: a
            meta-market is minted by the keeper when a session opens, never by a
            visitor. Registering an agent is the real door to the same place. */}
        <Link className="market-add" href="/docs">
          <Plus size={16} strokeWidth={1.8} /> Set up an agent
        </Link>
      </div>
    </div>
  );
}
