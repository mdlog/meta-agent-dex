/**
 * How a book's reading is allowed to be written down.
 *
 * A binary book bounds fair value from both ends — best bid ≤ fair ≤ best ask —
 * so the sentence a screen may print about it depends entirely on how many
 * sides are resting. Both sides give a midpoint, which is a probability. ONE
 * side gives an inequality, which is not: a bid at 0.14 says fair value is
 * somewhere in [0.14, 1], and rendering that as "Up 14% / 86% Down" asserts a
 * split that nobody quoted and that the book contradicts as often as not.
 * Measured on the live Explore board: 6 of 8 cards were doing exactly that.
 *
 * The rule lives here rather than in each card because there are four screens
 * printing the same reading — the Explore grid, the contract face, the Overview
 * feature panel and its list — and four copies of "when is this a bound" would
 * drift apart within a week.
 *
 * Down is always the same book inverted, so the inversion of a bound is a bound
 * the other way round: P(Up) ≥ 0.14 IS P(Down) ≤ 0.86. Never "86% Down".
 */

import type { PriceBasis } from "@/lib/domain/types";

/** Whole percent. The tick is finer, but a headline that moves on the third decimal reads as noise. */
function whole(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * True when the figure is one end of a range rather than a point.
 *
 * Callers use it to decide whether a *picture* may draw a split at all — a
 * two-colour rail is a claim about where the line falls, and a bound has not
 * told anyone where it falls.
 */
export function isBound(basis: PriceBasis): boolean {
  return basis === "bid" || basis === "ask";
}

/** The Up side, written as the book entitles it to be written. */
export function upText(p: number | null, basis: PriceBasis): string {
  if (p === null) return "—";
  // A resting bid is what someone will pay, so fair value is at or above it; a
  // resting ask is what someone will sell at, so fair value is at or below it.
  if (basis === "bid") return `≥ ${whole(p)}`;
  if (basis === "ask") return `≤ ${whole(p)}`;
  return whole(p);
}

/** The Down side. Same book inverted, so a floor on Up is a ceiling on Down. */
export function downText(p: number | null, basis: PriceBasis): string {
  if (p === null) return "—";
  if (basis === "bid") return `≤ ${whole(1 - p)}`;
  if (basis === "ask") return `≥ ${whole(1 - p)}`;
  return whole(1 - p);
}

/**
 * The short label that has to sit beside the figure — a footer cell, a 9px
 * caption. It names what the number is, never how good it is.
 */
export function basisNote(basis: PriceBasis): string {
  switch (basis) {
    case "mid":
      return "book mid";
    case "bid":
      return "bid only · a floor";
    case "ask":
      return "ask only · a ceiling";
    case "last":
      return "last print · nothing resting";
    case "settled":
      return "settled outcome";
    case "none":
      return "no quote";
  }
}

/** The same fact with room to explain itself, for a panel rather than a cell. */
export function basisSentence(basis: PriceBasis): string {
  switch (basis) {
    case "mid":
      return "Both sides of this book are resting, so the figure is the midpoint between them — the market's implied probability.";
    case "bid":
      return "Only the bid side of this book is resting. A bid puts a floor under fair value and says nothing about the ceiling, so this is a bound, not a split.";
    case "ask":
      return "Only the ask side of this book is resting. An ask caps fair value and says nothing about the floor, so this is a bound, not a split.";
    case "last":
      return "Nothing is resting on either side. The figure is the last price that traded, which is a print from the past rather than a reading of the book now.";
    case "settled":
      return "This contract has resolved. The figure is its outcome, not anything a book said.";
    case "none":
      return "Nothing has quoted this contract and nothing has traded on it, so there is no reading to show.";
  }
}
