/**
 * The real thing: Meta-Agent DEX on DreamDEX Event Contracts, Somnia Shannon.
 *
 * Read strategy, chosen from the Sprint-0 spike (`scripts/probe-testnet.ts`):
 *  - discovery + card quotes come from the indexer in two round-trips
 *    (`listLiveBinaryMarkets` then a batched `getBookTops`) — no N+1 fan-out;
 *  - depth and write-eligibility come from chain head, because the indexer is a
 *    cache and FR-055 forbids treating it as the source of truth for writes.
 */

import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  priceToProbability,
  toHuman,
  type BinaryMarket,
  type BookTop,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { ArenaMarket, ArenaOrderBook, BookLevel, PriceBasis } from "@/lib/domain/types";
import { venueOf } from "@/lib/domain/types";
import {
  deriveStatus,
  outcomeFromIndex,
  type AdapterHealth,
  type DreamDexAdapter,
  type MarketFilter,
  type OnchainMarketState,
  type SettledMarket,
} from "./adapter";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Short TTL: long enough to spare the indexer, short enough that a 15m contract still feels live. */
/**
 * Rows read from the indexer per listing, regardless of what the caller asked
 * for. The module serves Somnia's price series and this project's BOTNAV
 * session contracts from one page, so a limit sized for one side gets crowded
 * by the other as the agent fleet grows.
 */
const LISTING_LIMIT = 80;

const MARKET_TTL_MS = 4_000;
/**
 * Twelve seconds, not two.
 *
 * The pages that read a book re-request on a 15s LiveRefresh tick, so a 2s cache
 * expired between every pair of requests and each visitor paid the full chain
 * read again — measured at 5.1s for the Overview against 1.5s on a cache hit.
 * Twelve seconds is inside the refresh interval, so a reader still sees a book
 * no older than the tick that fetched it, and concurrent viewers collapse onto
 * one read instead of one each.
 *
 * It stays well under the shortest thing anyone acts on here: a meta-market
 * session runs 90 minutes, and the underlying BTC/ETH contracts roll hourly.
 */
const BOOK_TTL_MS = 12_000;

interface Cached<T> {
  value: T;
  at: number;
}

/** The three grid fields as they sit on {@link ArenaMarket} — raw, JSON-safe. */
type PoolGridFields = Pick<ArenaMarket, "tickSize" | "lotSize" | "minQuantity">;

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

/** `BTC-1h@14:00`. Compact, sortable, readable in a leaderboard row. */
function buildSymbol(m: BinaryMarket): string {
  const d = new Date(Number(m.expiry) * 1000);
  const interval = m.interval ?? "?";
  return `${m.asset}-${interval}@${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export class LiveDreamDexAdapter implements DreamDexAdapter {
  readonly mode = "live" as const;

  private exchange: SomniaMarkets;
  private marketCache: Cached<ArenaMarket[]> | null = null;
  private bookCache = new Map<string, Cached<ArenaOrderBook>>();
  /**
   * Per-market, with its own stamp. Freshness cannot be keyed off the list
   * cache: a market detail page reads one market and then its book, and neither
   * call fills `marketCache`, so a shared stamp meant every such read went to
   * the network twice.
   */
  private byId = new Map<string, Cached<ArenaMarket>>();
  /** Keyed by pool address. The grid is admin-set, never per-order, so one read lasts. */
  private gridByPool = new Map<string, PoolGridFields>();

  constructor(config: { indexerUrl: string; wsRpcUrl: string }) {
    this.exchange = new SomniaMarkets({
      indexerUrl: config.indexerUrl,
      chain: somniaShannon,
      wsRpcUrl: config.wsRpcUrl,
      addresses: SOMNIA_TESTNET_ADDRESSES,
    });
  }

  private get client() {
    return this.exchange.client;
  }

  /** Fold an SDK market plus its top-of-book into the app's market struct. */
  private toArenaMarket(m: BinaryMarket, top: BookTop | undefined, at: number): ArenaMarket {
    const decimals = m.quoteDecimals;
    const expiry = Number(m.expiry);
    const tradingStart = Number(m.tradingStart);

    const bestBid = top?.bestBid ? priceToProbability(top.bestBid, decimals) : null;
    const bestAsk = top?.bestAsk ? priceToProbability(top.bestAsk, decimals) : null;

    // Mid is the honest implied probability; null means "this market has never
    // quoted", which the UI must render as "no quote" rather than as 50%
    // (FR-014).
    const mid = top?.mid ? priceToProbability(top.mid, decimals) : null;
    const last = m.lastPrice ? priceToProbability(m.lastPrice, decimals) : null;

    // WHAT THIS BRANCH IS FOR. It was `mid ?? last`, which collapses four
    // different states of a book into one confident number: a one-sided book
    // that carries a mid, and an empty book that carries a last print, both
    // arrived at the cards as "the market implies 14%" and rendered as
    // "Up 14% / 86% Down". Measured on the live board, 6 of 8 cards were that.
    //
    // Fair value is bounded by the book from both ends — bid ≤ fair ≤ ask — so
    // one side is a bound and only two sides are a midpoint. The side test is
    // done here on `bestBid`/`bestAsk`, the two fields we read ourselves, and
    // NOT on whether the SDK happened to hand back a `mid`: a mid computed off
    // a single side is the exact number this is guarding against.
    let upProbability: number | null;
    let priceBasis: PriceBasis;
    if (bestBid !== null && bestAsk !== null) {
      // The SDK's own mid is preferred over averaging these two, because it is
      // computed in wire units before the probability conversion rounds.
      upProbability = mid ?? (bestBid + bestAsk) / 2;
      priceBasis = "mid";
    } else if (bestBid !== null) {
      upProbability = bestBid;
      priceBasis = "bid";
    } else if (bestAsk !== null) {
      upProbability = bestAsk;
      priceBasis = "ask";
    } else if (last !== null) {
      upProbability = last;
      priceBasis = "last";
    } else {
      upProbability = null;
      priceBasis = "none";
    }

    const status = deriveStatus(
      m.status,
      tradingStart,
      expiry,
      at,
      m.voided,
      m.winningOutcome,
    );

    const hasQuote = bestBid !== null || bestAsk !== null;

    return {
      id: m.id,
      poolAddress: m.poolAddress,
      symbol: buildSymbol(m),
      asset: m.asset,
      question: m.question,
      status,
      tradingStart,
      expiry,
      interval: m.interval ?? null,
      upProbability,
      priceBasis,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      // A state, and only a state. Depth needs the pool's own levels and the
      // batched top-of-book read cannot see them, so nothing here invents a
      // size: a screen that wants resting size reads it through
      // `readBookDepth`, which pays for the chain call and says so when it
      // fails. (This used to leave a 1 or a 0 in a field called `bookDepth`,
      // which the Overview then printed as "1 contracts".)
      quoted: hasQuote,
      resolvedOutcome: outcomeFromIndex(m.winningOutcome),
      resolvedAt: m.resolvedAtTimestamp ? Number(m.resolvedAtTimestamp) : null,
      quoteDecimals: decimals,
      collateral: m.collateral,
      tradable: status === "trading" && hasQuote,
      venue: venueOf(m.asset),
    };
  }

  private index(markets: ArenaMarket[]) {
    const at = Date.now();
    for (const m of markets) this.byId.set(m.id, { value: m, at });
  }

  /**
   * The pool's tick/lot/minimum grid — the increments it validates every order
   * against. One `eth_call`, cached for the process because a pool's grid is
   * admin-set and never moves per order.
   *
   * A failure resolves to null rather than throwing: a market whose grid we
   * cannot read still lists and still quotes, and the ticket degrades to the
   * fallback grid (see `gridOf`) instead of the page failing.
   */
  private async grid(pool: string): Promise<PoolGridFields | null> {
    const key = pool.toLowerCase();
    const hit = this.gridByPool.get(key);
    if (hit) return hit;
    try {
      const p = await this.client.getBinaryBookParams(pool);
      const fields: PoolGridFields = {
        tickSize: p.tickSize.toString(),
        lotSize: p.lotSize.toString(),
        minQuantity: p.minQuantity.toString(),
      };
      this.gridByPool.set(key, fields);
      return fields;
    } catch {
      return null;
    }
  }

  /**
   * Attach the pool's grid to a market. Deliberately not done in `listMarkets`:
   * a card never places an order, and one `eth_call` per card would undo the
   * batching the list read exists for. The order path goes through `getMarket`.
   */
  private async withGrid(m: ArenaMarket): Promise<ArenaMarket> {
    if (m.tickSize !== undefined) return m;
    const grid = await this.grid(m.poolAddress);
    if (!grid) return m;
    const merged = { ...m, ...grid };
    // Keep the entry's original stamp: attaching the grid is not a re-read, and
    // letting it refresh the clock would keep a stale market alive indefinitely.
    const at = this.byId.get(merged.id)?.at ?? Date.now();
    this.byId.set(merged.id, { value: merged, at });
    return merged;
  }

  async listMarkets(filter: MarketFilter = {}): Promise<ArenaMarket[]> {
    const at = nowSec();
    const fresh = this.marketCache && Date.now() - this.marketCache.at < MARKET_TTL_MS;

    let all: ArenaMarket[];
    if (fresh) {
      all = this.marketCache!.value;
    } else {
      // `filter.limit` caps what the CALLER gets back, not what is read: the
      // cache behind this holds both sides of the board, and a venue-filtered
      // caller asking for 40 Somnia contracts would otherwise be served a page
      // that spent a third of its rows on BOTNAV session contracts. Read wide,
      // filter below, slice at the end.
      const raw = await this.client.listLiveBinaryMarkets({
        limit: Math.max(filter.limit ?? 40, LISTING_LIMIT),
      });
      // One batched round-trip for every card's quote, instead of one per card.
      const tops = raw.length ? await this.client.getBookTops(raw.map((m) => m.id)) : {};
      all = raw.map((m) => this.toArenaMarket(m, tops[m.id.toLowerCase()] ?? tops[m.id], at));
      this.marketCache = { value: all, at: Date.now() };
      this.index(all);
    }

    const matched = all.filter((m) => {
      if (filter.venue && m.venue !== filter.venue) return false;
      if (filter.asset && m.asset.toUpperCase() !== filter.asset.toUpperCase()) return false;
      if (filter.withinSec && m.expiry - at > filter.withinSec) return false;
      if (filter.intervalSec) {
        const want = filter.intervalSec;
        const actual = m.expiry - m.tradingStart;
        // Series windows drift by a second or two; the first market of a series
        // is a short bootstrap, so allow 20% slack rather than an exact match.
        if (Math.abs(actual - want) > want * 0.2) return false;
      }
      return true;
    });

    return typeof filter.limit === "number" ? matched.slice(0, filter.limit) : matched;
  }

  async getMarket(marketId: string): Promise<ArenaMarket | null> {
    const cached = this.byId.get(marketId);
    if (cached && Date.now() - cached.at < MARKET_TTL_MS) return this.withGrid(cached.value);

    const m = await this.client.getBinaryMarket(marketId);
    if (!m) return cached ? this.withGrid(cached.value) : null;

    const tops = await this.client.getBookTops([m.id]);
    const market = this.toArenaMarket(m, tops[m.id.toLowerCase()] ?? tops[m.id], nowSec());
    this.index([market]);
    return this.withGrid(market);
  }

  async getOrderBook(marketId: string, depth = 8): Promise<ArenaOrderBook | null> {
    // Keyed by depth as well as market: the Overview totals resting size and
    // asks for 40 levels a side, the contract page draws six and asks for 8.
    // A key without the depth in it would let the shallow read answer the
    // deep one for two seconds and quietly understate the total.
    const key = `${marketId}:${depth}`;
    const hit = this.bookCache.get(key);
    if (hit && Date.now() - hit.at < BOOK_TTL_MS) return hit.value;

    // BinaryPools are recycled down a series: measured on Shannon, 23 of the
    // last 50 settled contracts share a pool with one that is trading now. So
    // `getBinaryOrderBook(pool)` on a contract that has closed returns its
    // SUCCESSOR's live depth — real numbers, a fresh `capturedAt`, and the
    // wrong contract. Resolve the market first and read the pool only while
    // this contract still owns it; a closed contract has no book of its own and
    // must render as having none. (The SDK's own by-market helper takes the
    // same position; there is no chain-read equivalent, so it is done here.)
    const m = await this.getMarket(marketId);
    if (!m) return null;
    if (m.status !== "trading") return null;

    const pool = m.poolAddress;
    const decimals = m.quoteDecimals;

    // The grid rides along with the book read: the ticket needs both together,
    // and pipelining them costs one round-trip instead of two.
    const [raw] = await Promise.all([
      this.client.getBinaryOrderBook(pool as `0x${string}`, { depth, decimals }),
      this.grid(pool),
    ]);
    const level = (l: { price: bigint; quantity: bigint }): BookLevel => ({
      price: priceToProbability(l.price, decimals),
      quantity: toHuman(l.quantity, decimals),
    });

    const book: ArenaOrderBook = {
      marketId,
      upBids: raw.yesBids.map(level),
      upAsks: raw.yesAsks.map(level),
      downBids: raw.noBids.map(level),
      downAsks: raw.noAsks.map(level),
      capturedAt: Date.now(),
    };
    this.bookCache.set(key, { value: book, at: Date.now() });
    return book;
  }

  async getOnchainState(marketId: string): Promise<OnchainMarketState | null> {
    const s = await this.client.getMarketOnchain(marketId as `0x${string}`);
    if (!s) return null;

    const expiry = Number(s.expiry);
    const at = nowSec();
    // MarketStatus enum: 0 Listed · 1 Trading · 2 Locked · 3 Settling · 4 Resolved · 5 Voided
    const rawName = ["Listed", "Trading", "Locked", "Settling", "Resolved", "Voided"][s.status] ?? "Listed";
    const status = deriveStatus(
      rawName,
      0,
      expiry,
      at,
      s.isVoided,
      s.isResolved ? s.winningOutcome : null,
    );

    return {
      marketId,
      status,
      expiry,
      isResolved: s.isResolved,
      isVoided: s.isVoided,
      winningOutcome: s.isResolved ? outcomeFromIndex(s.winningOutcome) : null,
      finalized: s.finalized,
      decimals: s.decimals,
      poolAddress: s.pool,
      // The pool itself only accepts orders while it is Trading and unexpired.
      acceptsOrders: s.status === 1 && at < expiry && !s.isResolved && !s.isVoided,
    };
  }

  async getSettlements(marketIds: string[]): Promise<SettledMarket[]> {
    const out: SettledMarket[] = [];
    // Read one market at a time on purpose: a resolution is the answer a
    // position is paid on, so it comes from chain-head state rather than the
    // indexer's event-derived status.
    for (const id of marketIds) {
      try {
        const s = await this.getOnchainState(id);
        if (!s) continue;
        if (!s.isResolved && !s.isVoided) continue;
        out.push({
          marketId: id,
          resolvedOutcome: s.winningOutcome,
          resolvedAt: s.expiry,
          voided: s.isVoided,
        });
      } catch {
        // A market the module cannot resolve is simply not settled yet.
      }
    }
    return out;
  }

  async listSettledMarkets(limit = 20): Promise<ArenaMarket[]> {
    const raw = await this.client.listPastBinaryMarkets({ limit });
    const at = nowSec();
    const markets = raw.map((m) => this.toArenaMarket(m, undefined, at));
    // Index these too. A settled contract is exactly what the market page looks
    // up by id, and without an entry every such read is a fresh
    // `getBinaryMarket` + `getBookTops` pair.
    this.index(markets);
    return markets;
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = Date.now();
    try {
      const sync = await this.client.getSyncStatus(somniaShannon.id);
      const block = sync ? Number((sync as { blockHeight?: number }).blockHeight ?? 0) : null;
      return {
        mode: "live",
        ok: true,
        chainId: somniaShannon.id,
        indexerBlock: block,
        message: null,
        checkedAt,
      };
    } catch (e) {
      return {
        mode: "live",
        ok: false,
        chainId: somniaShannon.id,
        indexerBlock: null,
        message: (e as Error).message.slice(0, 160),
        checkedAt,
      };
    }
  }

  async close() {
    await this.exchange.close();
  }
}
