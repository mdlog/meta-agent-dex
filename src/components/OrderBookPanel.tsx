import type { ArenaOrderBook, MarketStatus, Outcome } from "@/lib/domain/types";

/**
 * The resting book, read at chain head.
 *
 * Shown in the terms of the side the reader is looking at, so nobody has to
 * invert prices in their head (PRD §11.2).
 * Depth bars are drawn relative to the largest level on screen, so the shape of
 * the book is legible at a glance.
 */
export function OrderBookPanel({
  book,
  outcome,
  capturedAt,
  status,
}: {
  book: ArenaOrderBook | null;
  outcome: Outcome;
  capturedAt?: number;
  /** Why the book is empty, when it is. A closed contract has no book at all. */
  status?: MarketStatus;
}) {
  if (!book || (book.upBids.length === 0 && book.upAsks.length === 0)) {
    // "No resting orders" is the right sentence only while the contract is
    // still open. Past that the adapter deliberately declines to read the pool
    // — it gets recycled to the next contract in the series — so the honest
    // answer is that this contract no longer has a book, not that it is empty.
    const closed = status !== undefined && status !== "trading";
    return (
      <div className="card p-5">
        <p className="text-sm font-semibold">Order book</p>
        <p className="mt-3 text-base text-fg-muted">
          {closed
            ? "This contract has stopped trading, so it no longer has a book."
            : "No resting orders on this contract right now."}
        </p>
        <p className="mt-1 text-sm text-fg-subtle">
          {closed
            ? "Its pool is reused by the next contract in the series, so showing depth here would be someone else's liquidity."
            : "An empty book is the state a speculator agent is looking for — the first quote on it is the one that sets the price."}
        </p>
      </div>
    );
  }

  const asks = (outcome === "up" ? book.upAsks : book.downAsks).slice(0, 6);
  const bids = (outcome === "up" ? book.upBids : book.downBids).slice(0, 6);
  const max = Math.max(...[...asks, ...bids].map((l) => l.quantity), 1);

  const spread = asks[0] && bids[0] ? Math.abs(asks[0].price - bids[0].price) : null;

  const Row = ({ level, kind }: { level: { price: number; quantity: number }; kind: "ask" | "bid" }) => (
    <div className="relative flex items-center justify-between rounded-sm px-2 py-1">
      <span
        className={`depth-bar ${kind === "ask" ? "depth-bar--ask" : "depth-bar--bid"}`}
        style={{ width: `${(level.quantity / max) * 100}%` }}
        aria-hidden
      />
      <span className={`num relative text-sm font-medium ${kind === "ask" ? "text-down" : "text-up"}`}>
        {level.price.toFixed(3)}
      </span>
      <span className="num relative text-sm text-fg-muted">{level.quantity.toLocaleString()}</span>
    </div>
  );

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Order book</p>
        <p className="num text-xs text-fg-subtle">
          {outcome === "up" ? "Up terms" : "Down terms"} · read at chain head
          {capturedAt ? ` · ${new Date(capturedAt).toLocaleTimeString()}` : ""}
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between px-2 text-xs font-medium text-fg-muted">
        <span>Price</span>
        <span>Size</span>
      </div>

      <div className="mt-1">
        {[...asks].reverse().map((l, i) => (
          <Row key={`a${i}`} level={l} kind="ask" />
        ))}
      </div>

      <div className="my-1.5 flex items-center justify-between border-y border-line-soft px-2 py-1.5">
        <span className="text-xs font-medium text-fg-muted">Spread</span>
        <span className="num text-sm font-medium">{spread === null ? "one-sided" : spread.toFixed(3)}</span>
      </div>

      <div>
        {bids.map((l, i) => (
          <Row key={`b${i}`} level={l} kind="bid" />
        ))}
      </div>
    </div>
  );
}
