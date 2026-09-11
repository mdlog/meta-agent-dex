/**
 * What the app is allowed to say about an Event Contract's resting depth.
 *
 * Depth is the one figure on the Overview a reader could act on, and it has
 * three ways of not existing that look identical the moment they share a
 * string: a book that is genuinely empty, a book that has stopped existing
 * because its contract locked, and a book nobody managed to read. The union
 * below makes a renderer answer which one it is — a page that says "no resting
 * orders" about a read that failed has asserted something it never measured,
 * and that is the one claim this product cannot afford to get wrong.
 */

import type { ArenaOrderBook, MarketStatus } from "./types";

/**
 * Resting size across the whole book, in outcome tokens ("contracts").
 *
 * Only the Up side is summed, and that IS the whole book. The SDK builds the
 * Down side by mirroring the Up one (`toBinaryBook`: `downBids` is `upAsks`
 * repriced to `1 - p`, `downAsks` is `upBids`), because a YES bid at 0.40 and
 * a NO ask at 0.60 are one resting order seen from two sides. Summing all four
 * arrays would double every number the page prints.
 */
export function restingSize(book: ArenaOrderBook): number {
  return [...book.upBids, ...book.upAsks].reduce((total, level) => total + level.quantity, 0);
}

/**
 * A depth reading, with the reason attached when there is no number.
 *
 * `resting` is the only variant carrying a quantity, and it is the only one a
 * caller may print as one.
 */
export type BookDepth =
  /** Measured: this much size rests on the book right now. */
  | {
      readonly state: "resting";
      /** Outcome tokens across both sides, counted once. */
      readonly contracts: number;
      /**
       * True when the pool returned as many price levels as were asked for, so
       * there may be more behind them and this total is a floor rather than a
       * measurement. The label has to say so.
       */
      readonly atLeast: boolean;
    }
  /** Read, and there is nothing on it. */
  | { readonly state: "empty" }
  /** The contract has stopped trading, so it has no book of its own to read. */
  | { readonly state: "closed"; readonly status: MarketStatus }
  /** The read did not answer. Never rendered as a quantity, of any size. */
  | { readonly state: "unread"; readonly reason: string };

/**
 * Classify a book that was actually read.
 *
 * `levelsRead` is the number of price levels per side the pool was asked for:
 * `getBookLevels(isBid, n)` returns at most that many, so a side that came back
 * full may have more behind it and the total becomes a lower bound.
 */
export function measureDepth(book: ArenaOrderBook, levelsRead: number): BookDepth {
  const contracts = restingSize(book);
  if (contracts <= 0) return { state: "empty" };
  return {
    state: "resting",
    contracts,
    atLeast: book.upBids.length >= levelsRead || book.upAsks.length >= levelsRead,
  };
}
