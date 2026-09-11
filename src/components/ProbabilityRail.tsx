import type { Outcome, PriceBasis } from "@/lib/domain/types";
import { isBound } from "./priceFormat";

/**
 * The probability rail — Meta-Agent DEX's one recurring instrument.
 *
 * A binary Event Contract is a single line from 0 to 1 with a split point: Up
 * holds the left share, Down the right, and they always sum to the whole track.
 * Drawing it that way is the honest reading of one order book with two sides,
 * and it is why the same component can carry a live quote and a settled
 * outcome without changing shape.
 *
 * It carried a third thing until the human trading path was removed: a
 * draggable handle for the reader's own forecast, and the Brier square that
 * scored it. Nobody forecasts here now, so the handle, its keyboard control
 * and the diagram are gone rather than left as props with no caller.
 *
 * WHAT THE PICTURE MAY ASSERT DEPENDS ON THE BOOK. Two resting sides give a
 * midpoint, and the split is real: Up's share ends where Down's begins, with
 * the bid-ask band drawn across the join because the implied probability
 * genuinely is that range. ONE resting side gives an inequality instead —
 * fair value is somewhere in [bid, 1] or in [0, ask] — and a two-colour split
 * would be the rail stating a number the book never did. So a one-sided book
 * draws the range it does know, in the neutral tone, with a hard edge only at
 * the end the book actually stated. Green and red are earned by a midpoint.
 */

interface Props {
  /**
   * The book's reading of P(Up) in [0,1]; null when there is none. On a
   * one-sided book this is the resting side itself — a bound — which is why
   * `basis` is not optional.
   */
  probability: number | null;
  /** Which of the five things `probability` is. See {@link PriceBasis}. */
  basis: PriceBasis;
  bestBid?: number | null;
  bestAsk?: number | null;
  /**
   * The settled outcome, pinned to its own end of the track: "up" at 100%,
   * "down" at 0%. Named for the direction rather than an index, because the
   * index form of this prop was read backwards more than once.
   */
  settled?: Outcome | null;
  showScale?: boolean;
  height?: number;
  className?: string;
  animate?: boolean;
}

const pct = (v: number) => `${Math.min(100, Math.max(0, v * 100))}%`;

/** What a screen reader is told, which is the same sentence the pixels make. */
function describe(p: number | null, basis: PriceBasis): string {
  if (p === null) return "No quote on this contract yet";
  const up = Math.round(p * 100);
  if (basis === "bid")
    return `Only a bid rests on this book, at ${up} percent. Fair value is at or above it; the market has not said where`;
  if (basis === "ask")
    return `Only an ask rests on this book, at ${up} percent. Fair value is at or below it; the market has not said where`;
  if (basis === "last")
    return `Nothing rests on this book. The last trade printed at ${up} percent Up`;
  return `Market implies ${up} percent Up, ${100 - up} percent Down`;
}

export function ProbabilityRail({
  probability,
  basis,
  bestBid,
  bestAsk,
  settled,
  showScale = false,
  height = 8,
  className = "",
  animate = false,
}: Props) {
  const p = probability;
  const bound = isBound(basis);
  // The coloured split is a statement about where the line falls, so only a
  // midpoint (or a resolved contract, whose "probability" is its own outcome)
  // is allowed to draw one. A `last` print is a past trade with nothing behind
  // it now, and gets the marker alone.
  const split = p !== null && (basis === "mid" || basis === "settled");

  return (
    <div className={className}>
      <div
        className="rail"
        style={{ ["--rail-h" as string]: `${height}px` }}
        role="img"
        aria-label={describe(p, basis) + (settled ? `. Settled ${settled}.` : "")}
      >
        <div className={`rail__track ${animate ? "animate-in" : ""}`}>
          {split && (
            <>
              <div className="rail__up" style={{ width: pct(p) }} />
              <div className="rail__down" style={{ width: pct(1 - p) }} />
            </>
          )}

          {/* The band across the join, drawn only where there are two sides to
              span. This is the bid-ask spread and nothing else is. */}
          {basis === "mid" && bestBid != null && bestAsk != null && bestAsk > bestBid && (
            <div
              className="rail__spread"
              style={{ left: pct(bestBid), width: pct(bestAsk - bestBid) }}
              title={`Spread ${(bestAsk - bestBid).toFixed(3)}`}
            />
          )}

          {/* One side only: shade the interval fair value is known to lie in,
              which runs from the resting bid up to 1, or from 0 down to the
              resting ask. It is deliberately not a spread — there is no second
              side to measure one against — so it takes the neutral tone and a
              hard edge at the single end the book stated. */}
          {bound && p !== null && (
            <div
              className={`rail__range ${basis === "bid" ? "rail__range--floor" : "rail__range--ceiling"}`}
              style={
                basis === "bid"
                  ? { left: pct(p), right: "0" }
                  : { left: "0", width: pct(p) }
              }
              title={
                basis === "bid"
                  ? `Bid ${p.toFixed(3)} — fair value is at or above it`
                  : `Ask ${p.toFixed(3)} — fair value is at or below it`
              }
            />
          )}
        </div>

        {p !== null && <div className="rail__marker" style={{ left: pct(p) }} />}

        {settled != null && (
          <div className="rail__marker rail__marker--outcome" style={{ left: settled === "up" ? "100%" : "0%" }} />
        )}
      </div>

      {showScale && (
        <div className="num mt-2 flex justify-between text-xs text-fg-subtle">
          <span>0% Up</span>
          <span>50%</span>
          <span>100% Up</span>
        </div>
      )}
    </div>
  );
}
