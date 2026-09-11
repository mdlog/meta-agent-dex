/**
 * Reading an Event Contract's resting depth, honestly.
 *
 * `ArenaMarket` carries no size: the list read is one batched top-of-book query
 * (`getBookTops`) and top-of-book has no depth in it. Depth is a separate chain
 * read — the pool's own `getBookLevels(isBid, n)`, which `getOrderBook` wraps —
 * so a screen gets a real number only by paying for it. This is the one place
 * that decides whether it was paid, and what to say when it was not.
 */

import type { ArenaMarket } from "@/lib/domain/types";
import { measureDepth, type BookDepth } from "@/lib/domain/book";
import type { DreamDexAdapter } from "./adapter";

/**
 * Price levels per side to ask the pool for.
 *
 * Far more than these books hold — the meta-markets are quoted by a handful of
 * agents — so in practice the total is complete rather than a floor. It is a
 * bound and not a promise, which is why {@link BookDepth} carries `atLeast`:
 * two `eth_call`s cannot prove they saw the bottom of a book.
 */
export const BOOK_LEVELS = 40;

/**
 * The depth of one contract's book, or the reason there is no number.
 *
 * Takes the market the caller already read rather than an id, for two reasons:
 * the status check below needs it, and a market read a moment ago has warmed
 * the adapter's per-market cache, so the resolution inside `getOrderBook` costs
 * nothing instead of a second round-trip.
 */
export async function readBookDepth(
  adapter: DreamDexAdapter,
  market: ArenaMarket | null,
  levels: number = BOOK_LEVELS,
): Promise<BookDepth> {
  if (market === null) {
    return { state: "unread", reason: "the contract read did not answer" };
  }

  // A contract that has stopped trading has no book of its own: BinaryPools are
  // recycled down a series, so reading this pool now would return the SUCCESSOR
  // contract's depth. `getOrderBook` refuses for exactly that reason, and the
  // refusal has to reach the reader as "closed", never as "empty".
  if (market.status !== "trading") {
    return { state: "closed", status: market.status };
  }

  const book = await adapter.getOrderBook(market.id, levels).catch(() => null);

  // Null here is a read that did not answer. The one case where `getOrderBook`
  // returns null for a healthy contract — it has stopped trading — is handled
  // above; if the contract locked in the seconds between these two reads it
  // lands here and reports "not read", which understates what we know but never
  // overstates it. Saying "no resting orders" about this is the lie the whole
  // module exists to prevent.
  if (book === null) {
    return { state: "unread", reason: "the book read did not answer" };
  }

  return measureDepth(book, levels);
}
