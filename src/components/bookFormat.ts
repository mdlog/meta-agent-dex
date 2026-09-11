/**
 * How a {@link BookDepth} is worded, in one place.
 *
 * The Overview and the contract page both print the resting size of the same
 * book, and a reader clicking from one to the other must not meet two different
 * numbers or two different words for the same fact. That is why the wording is
 * a module and not a local helper: the panel said "Book 1 contracts" while the
 * contract page said "resting size 183" about the same pool, and each of them
 * looked internally consistent.
 *
 * Not a component and deliberately not `"use client"`: the contract page is a
 * server component, and a formatter that lived inside a client module could not
 * be called from it.
 */

import type { BookDepth } from "@/lib/domain/book";
import type { MarketStatus } from "@/lib/domain/types";

/**
 * A resting-size figure.
 *
 * Fixed locale, deliberately: a browser formatting this differently from the
 * server render is a hydration mismatch, and depth is not prose. Two decimals
 * rather than whole contracts because the pool's lot size is finer than one —
 * rounding turned a real 0.4-contract order into "0", which is the same false
 * claim as any other made-up number, only quieter. Anything that would still
 * round away prints as a bound instead of a zero.
 */
export function contractsLabel(n: number): string {
  if (n < 0.01) return "<0.01";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Why a contract that is not trading has no book of its own to read. */
export function closedBecause(status: MarketStatus): string {
  switch (status) {
    case "locked":
      return "closed at expiry";
    case "settling":
      return "closed, oracle answering";
    case "resolved":
      return "closed, contract resolved";
    case "voided":
      return "closed, contract voided";
    default:
      // `upcoming` — minted, not open for orders yet. (`trading` never reaches
      // the closed variant.)
      return "not open yet";
  }
}

/**
 * The full book line.
 *
 * Four states, four strings, and the separation is the point. "no resting
 * orders" is a measurement, so it is only ever said about a book that was
 * actually read; a read that did not answer says so and names which read
 * failed. The alternative — the one this replaced — asserts an empty book on no
 * evidence, which is the most expensive kind of wrong a venue can be.
 */
export function depthLabel(depth: BookDepth): string {
  switch (depth.state) {
    case "resting":
      return `${depth.atLeast ? "at least " : ""}${contractsLabel(depth.contracts)} contracts resting`;
    case "empty":
      return "no resting orders";
    case "closed":
      return `no live book — ${closedBecause(depth.status)}`;
    case "unread":
      return `not read — ${depth.reason}`;
  }
}

/** The same reading, at the width a 9px list row has for it. */
export function depthLabelShort(depth: BookDepth): string {
  switch (depth.state) {
    case "resting":
      return `${depth.atLeast ? "≥" : ""}${contractsLabel(depth.contracts)} resting`;
    case "empty":
      return "no resting orders";
    case "closed":
      return "no live book";
    case "unread":
      return "depth not read";
  }
}

/**
 * Amber marks the one state that is a gap in the reading rather than a reading.
 * Never the direction tokens: depth has no side, so green or red here would
 * both be claims about a market nothing measured. Empty string, not a colour,
 * for every state that is an answer.
 */
export function depthTone(depth: BookDepth): string {
  return depth.state === "unread" ? "text-warn" : "";
}
