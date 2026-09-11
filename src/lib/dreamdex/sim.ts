/**
 * A deterministic stand-in for DreamDEX.
 *
 * Why it exists: PRD §17 lists "market testnet tidak memiliki liquidity" and
 * "indexer tertinggal dari chain" as the two risks most likely to break a live
 * demo. This adapter keeps every screen, the scoring pipeline and the whole
 * test suite working with no network at all — same interface, same shapes.
 *
 * What it is NOT: a fake trade. Nothing here produces a transaction hash, and
 * `mode: "sim"` is surfaced in the UI banner and in `/api/health`, so a
 * simulated market can never be mistaken for a settled on-chain one (PRD §15.4:
 * "Fallback tidak boleh memalsukan transaksi").
 */

import type { ArenaMarket, ArenaOrderBook, BookLevel, Outcome } from "@/lib/domain/types";
import {
  deriveStatus,
  type AdapterHealth,
  type DreamDexAdapter,
  type MarketFilter,
  type OnchainMarketState,
  type SettledMarket,
} from "./adapter";

const INTERVALS = [
  { sec: 900, label: "15m" },
  { sec: 3600, label: "1h" },
  { sec: 14400, label: "4h" },
  { sec: 86400, label: "24h" },
] as const;

const ASSETS = ["BTC", "ETH"] as const;
const DECIMALS = 6;

/**
 * The order grid every Shannon binary pool reports today, in raw units at 6dp:
 * 1000 == 0.001. Simulated markets carry the real one so a ticket built here
 * exercises the same lot and tick alignment a live order has to satisfy — a
 * fallback that quietly accepted any quantity would hide the bug it exists to
 * survive.
 */
const GRID = { tickSize: "1000", lotSize: "1000", minQuantity: "1000" } as const;

/** Deterministic 32-bit hash — the only randomness source in this module. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable pseudo-random in [0,1) for a given key. */
function rand(key: string): number {
  return hash32(key) / 4294967296;
}

/** A bytes32-shaped id, so nothing downstream has to special-case sim ids. */
function simMarketId(asset: string, intervalSec: number, window: number): string {
  const h = hash32(`${asset}:${intervalSec}:${window}`).toString(16).padStart(8, "0");
  return `0x${"51".repeat(12)}${h}${(window & 0xffff).toString(16).padStart(4, "0")}`;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

/**
 * The market's "true" probability at a moment in time — a slow random walk
 * anchored per market, so a book looks alive across polls without ever jumping.
 */
function trueProbability(marketId: string, tradingStart: number, nowS: number, expiry: number): number {
  const base = 0.25 + rand(`${marketId}:base`) * 0.5;
  const span = Math.max(1, expiry - tradingStart);
  const elapsed = Math.min(1, Math.max(0, (nowS - tradingStart) / span));
  // Drift toward the eventual outcome as expiry approaches — the same shape a
  // real event contract shows as uncertainty resolves.
  const target = simOutcome(marketId) === "up" ? 0.92 : 0.08;
  const wobble = (rand(`${marketId}:${Math.floor(nowS / 30)}`) - 0.5) * 0.06;
  return Math.min(0.97, Math.max(0.03, base + (target - base) * elapsed ** 1.6 + wobble));
}

/** The outcome a sim market will settle to — fixed at creation, never re-rolled. */
function simOutcome(marketId: string): Outcome {
  return rand(`${marketId}:outcome`) > 0.5 ? "up" : "down";
}

function buildMarket(asset: string, interval: (typeof INTERVALS)[number], window: number, nowS: number): ArenaMarket {
  const tradingStart = window * interval.sec;
  const expiry = tradingStart + interval.sec;
  const id = simMarketId(asset, interval.sec, window);
  const settled = nowS >= expiry;

  const p = trueProbability(id, tradingStart, Math.min(nowS, expiry), expiry);
  const halfSpread = 0.008 + rand(`${id}:spread`) * 0.02;
  const bestBid = Math.max(0.01, p - halfSpread);
  const bestAsk = Math.min(0.99, p + halfSpread);

  const status = deriveStatus(
    settled ? "Resolved" : "Trading",
    tradingStart,
    expiry,
    nowS,
    false,
    settled ? (simOutcome(id) === "up" ? 0 : 1) : null,
  );

  const d = new Date(expiry * 1000);

  return {
    id,
    poolAddress: `0x${hash32(`${id}:pool`).toString(16).padStart(40, "0").slice(0, 40)}`,
    symbol: `${asset}-${interval.label}@${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    asset,
    question: `${asset} closes at or above its opening price`,
    status,
    tradingStart,
    expiry,
    interval: interval.label,
    upProbability: settled ? (simOutcome(id) === "up" ? 1 : 0) : p,
    // A settled sim market's "probability" is its own outcome, not anything a
    // book said, and a live one always gets both sides quoted here — so the
    // basis is never a bound in the simulation. It is still carried, because a
    // card must be able to tell the two apart without knowing which adapter
    // built it.
    priceBasis: settled ? "settled" : "mid",
    bestBid: settled ? null : bestBid,
    bestAsk: settled ? null : bestAsk,
    spread: settled ? null : bestAsk - bestBid,
    quoted: !settled,
    resolvedOutcome: settled ? simOutcome(id) : null,
    resolvedAt: settled ? expiry : null,
    quoteDecimals: DECIMALS,
    // The simulation only ever stands in for Somnia's price series; it never
    // invents a session contract, because those are minted by this project and
    // an invented one would name an agent that has no such session.
    venue: "somnia",
    collateral: "0x0000000000000000000000000000000000000000",
    tradable: status === "trading",
    ...GRID,
  };
}

export class SimDreamDexAdapter implements DreamDexAdapter {
  readonly mode = "sim" as const;

  private readonly clock: () => number;

  /** Overridable clock so tests can settle a market without waiting for one. */
  constructor(clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.clock = clock;
  }

  private allMarkets(nowS: number): ArenaMarket[] {
    const out: ArenaMarket[] = [];
    for (const asset of ASSETS) {
      for (const interval of INTERVALS) {
        const current = Math.floor(nowS / interval.sec);
        // Two upcoming, the live one, and six settled — enough history for a
        // leaderboard to have something to rank on a cold start.
        for (let w = current - 6; w <= current + 2; w++) {
          out.push(buildMarket(asset, interval, w, nowS));
        }
      }
    }
    return out;
  }

  async listMarkets(filter: MarketFilter = {}): Promise<ArenaMarket[]> {
    const nowS = this.clock();
    let markets = this.allMarkets(nowS)
      .filter((m) => m.expiry > nowS)
      .sort((a, b) => a.expiry - b.expiry);

    // The simulation mints no session contracts, so a request for the meta
    // side is answered with nothing rather than with price contracts wearing
    // the wrong label.
    if (filter.venue) markets = markets.filter((m) => m.venue === filter.venue);
    if (filter.asset) markets = markets.filter((m) => m.asset.toUpperCase() === filter.asset!.toUpperCase());
    if (filter.intervalSec) markets = markets.filter((m) => m.expiry - m.tradingStart === filter.intervalSec);
    if (filter.withinSec) markets = markets.filter((m) => m.expiry - nowS <= filter.withinSec!);

    return markets.slice(0, filter.limit ?? 40);
  }

  async getMarket(marketId: string): Promise<ArenaMarket | null> {
    return this.allMarkets(this.clock()).find((m) => m.id === marketId) ?? null;
  }

  async getOrderBook(marketId: string, depth = 8): Promise<ArenaOrderBook | null> {
    const m = await this.getMarket(marketId);
    if (!m || m.bestBid === null || m.bestAsk === null) return null;
    // Same rule the live adapter enforces: a contract that has stopped trading
    // has no book of its own. Keeping the two adapters shape-identical is what
    // lets an offline rehearsal exercise the screens a live run would.
    if (m.status !== "trading") return null;

    // Seeded, and deliberately not `depth` levels. A book that is always
    // exactly as deep as the caller asked reads as truncated to anything that
    // checks — which is how the Overview decides whether a total is a
    // measurement or a floor — so the sim would permanently claim "at least".
    // A real book has the number of levels it has; so does this one.
    const levels = Math.min(depth, 4 + Math.floor(rand(`${marketId}:levels`) * 4));

    const mk = (from: number, dir: 1 | -1, seed: string): BookLevel[] =>
      Array.from({ length: levels }, (_, i) => ({
        price: Math.min(0.99, Math.max(0.01, from + dir * i * 0.01)),
        quantity: Math.round((50 + rand(`${seed}:${i}`) * 450) * 100) / 100,
      }));

    const upBids = mk(m.bestBid, -1, `${marketId}:bid`);
    const upAsks = mk(m.bestAsk, 1, `${marketId}:ask`);

    return {
      marketId,
      upBids,
      upAsks,
      // Down is the same book inverted — exactly as BinaryPool prices it.
      downBids: upAsks.map((l) => ({ price: 1 - l.price, quantity: l.quantity })),
      downAsks: upBids.map((l) => ({ price: 1 - l.price, quantity: l.quantity })),
      capturedAt: Date.now(),
    };
  }

  async getOnchainState(marketId: string): Promise<OnchainMarketState | null> {
    const m = await this.getMarket(marketId);
    if (!m) return null;
    const nowS = this.clock();
    return {
      marketId,
      status: m.status,
      expiry: m.expiry,
      isResolved: m.status === "resolved",
      isVoided: m.status === "voided",
      winningOutcome: m.resolvedOutcome,
      finalized: m.status === "resolved",
      decimals: DECIMALS,
      poolAddress: m.poolAddress,
      acceptsOrders: m.status === "trading" && nowS < m.expiry,
    };
  }

  async getSettlements(marketIds: string[]): Promise<SettledMarket[]> {
    const nowS = this.clock();
    const all = this.allMarkets(nowS);
    return marketIds.flatMap((id) => {
      const m = all.find((x) => x.id === id);
      if (!m || m.status !== "resolved") return [];
      return [{ marketId: id, resolvedOutcome: m.resolvedOutcome, resolvedAt: m.resolvedAt, voided: false }];
    });
  }

  async listSettledMarkets(limit = 20): Promise<ArenaMarket[]> {
    const nowS = this.clock();
    return this.allMarkets(nowS)
      .filter((m) => m.status === "resolved")
      .sort((a, b) => b.expiry - a.expiry)
      .slice(0, limit);
  }

  async health(): Promise<AdapterHealth> {
    return {
      mode: "sim",
      ok: true,
      chainId: 50312,
      indexerBlock: null,
      message: "Simulation mode. Markets are generated locally, not read from Somnia testnet.",
      checkedAt: Date.now(),
    };
  }

  async close() {}
}
