import { notFound } from "next/navigation";
import { getAdapter, type DreamDexAdapter } from "@/lib/dreamdex";
import { BOOK_LEVELS } from "@/lib/dreamdex/depth";
import { measureDepth, type BookDepth } from "@/lib/domain/book";
import { depthLabel, depthTone } from "@/components/bookFormat";
import { ProbabilityRail } from "@/components/ProbabilityRail";
import { basisNote, basisSentence, downText, upText } from "@/components/priceFormat";
import { OrderBookPanel } from "@/components/OrderBookPanel";
import { MarketObserverPanel } from "@/components/MarketObserverPanel";
import { StatusPill, SimulatedPill } from "@/components/StatusPill";
import { Countdown } from "@/components/Countdown";
import { LiveRefresh } from "@/components/LiveRefresh";
import { addressUrl } from "@/lib/wallet/chain";
import { BackLink, ExternalLink } from "@/components/Primitives";

/**
 * Never cached, at any layer. `force-dynamic` opts the route out of the full
 * route cache and `revalidate = 0` says the same thing to the data cache, which
 * matters because `LiveRefresh` below re-requests this render every five
 * seconds: a page that answered one of those from a cache would tick a clock
 * over a book that had stopped moving.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const adapter = getAdapter();

  // `refuse` never returns — it decides between the 404 and the error boundary.
  const market = (await adapter.getMarket(id).catch(() => null)) ?? refuse(adapter, id);

  // The book is a slower chain read; a failure degrades to "no quote" rather
  // than taking the page down with it.
  //
  // Read at the same level count the Overview uses, from the same two
  // `getBookLevels` calls, so the resting size printed here and the one printed
  // on the Overview are the same reading of the same book. The panel below
  // still draws six levels a side; the extra levels cost nothing on the wire
  // and are what makes the total a total.
  const book = await adapter.getOrderBook(id, BOOK_LEVELS).catch(() => null);

  const p = market.upProbability;
  const basis = market.priceBasis;

  // `getOrderBook` returns null both for a contract that has stopped trading
  // and for a read that did not answer, and the market's own status is what
  // separates them. It used to collapse to `depth = 0` and print "resting size
  // 0" for either — a measurement, asserted about a book nobody had seen.
  const depth: BookDepth =
    book !== null
      ? measureDepth(book, BOOK_LEVELS)
      : market.status !== "trading"
        ? { state: "closed", status: market.status }
        : { state: "unread", reason: "the book read did not answer" };

  return (
    <div>
      <BackLink href="/explore">Explore</BackLink>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-xs text-fg-subtle">{market.symbol}</span>
            {market.simulated && <SimulatedPill />}
            <StatusPill status={market.status} />
          </div>
          <h1 className="mt-2.5 max-w-[40ch] text-2xl">{market.question}</h1>

          {/* This page is a full instrument face — rail, book, contract — and
              every part of it renders identically for a contract that does not
              exist. The pill above is the marker; this is the consequence. */}
          {market.simulated && (
            <div className="callout callout-danger mt-3 max-w-[60ch] text-fg-muted">
              This contract was generated locally while the DreamDEX indexer is unreachable. It does
              not exist on Somnia, so no agent is trading it and nothing on this page was read from
              a chain. Every figure below is fallback data.
            </div>
          )}

          <p className="mt-2 text-sm text-fg-muted">
            {market.asset}, {market.interval ?? "custom"} window, settles{" "}
            {new Date(market.expiry * 1000).toUTCString()}
          </p>
        </div>

        <div className="card min-w-[200px] px-4 py-3 text-right">
          {/* Once the committee has answered, the clock is the wrong readout.
              `Countdown` prints "awaiting settlement" for any past time, which on
              a contract that HAS settled contradicted the "settled" line two rows
              below it and the Resolved badge beside the title. A resolved market
              gets the answer instead — which is what a reader arriving at a
              finished contract came for. */}
          <p className="label">{market.resolvedOutcome === null ? "Time to settlement" : "Settled on"}</p>
          {market.resolvedOutcome === null ? (
            <Countdown to={market.expiry} className="stat-value mt-1 block" />
          ) : (
            <p className="stat-value mt-1 block">
              {market.resolvedOutcome === "up" ? "Up" : "Down"}
            </p>
          )}
          <p className={`help num mt-1 ${depthTone(depth)}`}>{depthLabel(depth)}</p>
          {/* Directly under the clock, because it answers the question the
              clock provokes: the countdown is the reader's own clock, this is
              the age of everything else on the page. */}
          <LiveRefresh
            renderedAt={Date.now()}
            lockAt={market.expiry}
            status={market.status}
            className="mt-1.5"
          />
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="space-y-6">
          {/* The rail, at the size the whole product is organised around. */}
          <section className="card p-5 sm:p-6" aria-label="Market-implied probability">
            {/* THE HEADLINE PAIR IS NOT ALWAYS A SPLIT. Both sides resting give
                a midpoint and a real "62% / 38%"; one side gives an inequality,
                and `upText`/`downText` write it as one. This block used to
                treat a null probability as "one-sided" and a non-null one as a
                midpoint, which put a confident split over any book carrying a
                last print — the branch below now asks `priceBasis`, which the
                adapter set from the sides it actually read. */}
            {p === null ? (
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="label">No reading on this book</p>
                  <p className="mt-2 max-w-[44ch] text-lg font-medium">
                    Nothing is resting on either side of this contract.
                  </p>
                  <p className="mt-2 max-w-[52ch] text-sm text-fg-muted">
                    {basisSentence(basis)} A speculator agent can still rest the first quote on it —
                    that is what an unquoted book is waiting for.
                  </p>
                </div>
                <p className="num text-sm text-fg-subtle">no resting orders</p>
              </div>
            ) : (
              <>
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="label">Up</p>
                    <p className="num mt-1 text-3xl font-semibold text-up">{upText(p, basis)}</p>
                  </div>
                  <div className="hidden text-center sm:block">
                    <p className="label">{basis === "mid" ? "Implied by the book" : "What the book said"}</p>
                    <p className="num mt-1 text-sm text-fg-muted">
                      {basis === "mid" && market.bestBid !== null && market.bestAsk !== null
                        ? `bid ${market.bestBid.toFixed(3)} · ask ${market.bestAsk.toFixed(3)} · spread ${market.spread?.toFixed(3)}`
                        : basisNote(basis)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="label">Down</p>
                    <p className="num mt-1 text-3xl font-semibold text-down">{downText(p, basis)}</p>
                  </div>
                </div>

                {/* Said in words as well as in signs, because the ≥ is one
                    character and the claim it changes is the whole panel. */}
                {basis !== "mid" && (
                  <p className="mt-3 max-w-[68ch] text-sm text-fg-muted">{basisSentence(basis)}</p>
                )}
              </>
            )}

            <div className="mt-5">
              <ProbabilityRail
                probability={p}
                basis={basis}
                bestBid={market.bestBid}
                bestAsk={market.bestAsk}
                settled={market.resolvedOutcome}
                height={12}
                showScale
                animate
              />
            </div>
          </section>

          <OrderBookPanel book={book} outcome="up" capturedAt={book?.capturedAt} status={market.status} />

          <section className="card p-5">
            <p className="text-sm font-semibold">Contract</p>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-fg-muted">Market id</dt>
              <dd className="mono truncate">{market.id}</dd>

              <dt className="text-fg-muted">Pool</dt>
              <dd className="mono truncate">
                <ExternalLink href={addressUrl(market.poolAddress)} className="link">
                  {market.poolAddress}
                </ExternalLink>
              </dd>

              <dt className="text-fg-muted">Collateral</dt>
              <dd className="mono truncate">{market.collateral}</dd>

              <dt className="text-fg-muted">Trading opened</dt>
              <dd className="num">{new Date(market.tradingStart * 1000).toUTCString()}</dd>

              {/* The grid, in the pool's own raw units. An order off any of the
                  three is refused by the contract, so this is the first thing
                  someone writing an agent against this book has to read — and
                  the adapter already carries it. A failed grid read prints as a
                  dash rather than a plausible default. */}
              <dt className="text-fg-muted">Order grid</dt>
              <dd className="num">
                {market.tickSize && market.lotSize && market.minQuantity ? (
                  <>
                    tick {market.tickSize} · lot {market.lotSize} · min {market.minQuantity}
                    <span className="text-fg-subtle"> (raw, {market.quoteDecimals}dp)</span>
                  </>
                ) : (
                  <span className="text-fg-subtle">not read from the pool</span>
                )}
              </dd>
            </dl>
            <p className="mt-4 border-t border-line-soft pt-4 text-xs leading-relaxed text-fg-subtle">
              Up and Down are two sides of one order book: a Down token at 0.38 is the same resting
              order as an Up token at 0.62. Prices always sum to 1.
            </p>
          </section>
        </div>

        <div className="lg:sticky lg:top-[calc(var(--header-h)+20px)]">
          <MarketObserverPanel market={market} />
        </div>
      </div>
    </div>
  );
}

/**
 * Decide what a missing market actually means.
 *
 * A contract the module has never heard of and a live read that has just failed
 * arrive here as the same `null`: the resilient adapter serves a failed live
 * read out of the simulation, and the simulation knows no real market id.
 *
 * `adapter.mode` reports which side actually answered: on a live install it
 * reads "sim" here only because the live read failed. That is a chain problem
 * rather than a missing contract, so it throws and the error boundary says
 * exactly that and offers a retry. An offline rehearsal is "sim" for its whole
 * life and carries no such signal, so there a null is taken at face value.
 */
function refuse(adapter: DreamDexAdapter, id: string): never {
  const rehearsal = (process.env.DREAMDEX_MODE ?? "live").toLowerCase() === "sim";
  if (adapter.mode === "sim" && !rehearsal) {
    throw new Error(
      `DreamDEX reads are failing, so ${id} could not be looked up. This is a failed chain read, not a contract that does not exist.`,
    );
  }
  notFound();
}
