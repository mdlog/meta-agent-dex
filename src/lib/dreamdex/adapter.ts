/**
 * The seam between Meta-Agent DEX and DreamDEX.
 *
 * PRD §12 ("Maintainability"): "Adapter DreamDEX dipisahkan dari UI agar
 * perubahan SDK tidak menyebar ke seluruh aplikasi." Everything above this file
 * speaks {@link ArenaMarket}; only the implementations below speak SDK.
 */

import type { ArenaMarket, ArenaOrderBook, MarketStatus, MarketVenue, Outcome } from "@/lib/domain/types";

export interface MarketFilter {
  /**
   * Restrict to one side of the board. `"somnia"` is the trading venue — the
   * price series the agents send orders into; `"meta"` is this project's own
   * NAV session contracts. Both come back when this is unset.
   */
  venue?: MarketVenue;
  asset?: string;
  /** Series cadence in seconds: 900 | 3600 | 14400 | 86400. */
  intervalSec?: number;
  /** Only markets expiring within this many seconds. */
  withinSec?: number;
  limit?: number;
}

/**
 * A market's state read straight from chain — the authority for whether an
 * order may be sent (FR-046, FR-055). The indexer is a cache; this is not.
 */
export interface OnchainMarketState {
  marketId: string;
  status: MarketStatus;
  expiry: number;
  isResolved: boolean;
  isVoided: boolean;
  winningOutcome: Outcome | null;
  finalized: boolean;
  decimals: number;
  poolAddress: string;
  /** True when an order placed right now would be accepted. */
  acceptsOrders: boolean;
}

export interface AdapterHealth {
  mode: "live" | "sim";
  ok: boolean;
  chainId: number;
  /** Last block the indexer has processed; null in sim mode. */
  indexerBlock: number | null;
  /** Set when the adapter is degraded — surfaces as the UI's "syncing" state. */
  message: string | null;
  checkedAt: number;
}

/** A settled market, as scoring needs it. */
export interface SettledMarket {
  marketId: string;
  resolvedOutcome: Outcome | null;
  resolvedAt: number | null;
  voided: boolean;
}

export interface DreamDexAdapter {
  readonly mode: "live" | "sim";

  /** Live Event Contracts (`expiry > now`), soonest to expire first. */
  listMarkets(filter?: MarketFilter): Promise<ArenaMarket[]>;

  getMarket(marketId: string): Promise<ArenaMarket | null>;

  /** Full-depth book at chain head. Null when the market has no pool binding. */
  getOrderBook(marketId: string, depth?: number): Promise<ArenaOrderBook | null>;

  /** Chain-head state, for pre-write validation. */
  getOnchainState(marketId: string): Promise<OnchainMarketState | null>;

  /** Resolution status for a set of markets — drives settlement + scoring. */
  getSettlements(marketIds: string[]): Promise<SettledMarket[]>;

  /** Recently settled contracts, newest first. */
  listSettledMarkets(limit?: number): Promise<ArenaMarket[]>;

  health(): Promise<AdapterHealth>;

  close(): Promise<void>;
}

/** Assets Meta-Agent DEX surfaces on the Explore filters. */
export const KNOWN_ASSETS = ["BTC", "ETH"] as const;

/**
 * Derive the status a *reader* cares about.
 *
 * The indexer's `clobStatus` is event-derived, and the SDK is explicit that the
 * Listed→Trading→Settling transitions emit no event — so a contract that sailed
 * past its expiry still reads "Trading". The spike in `scripts/probe-testnet.ts`
 * hit exactly that: 20 markets reported Trading, all long expired, none with a
 * book. Timestamps decide; the event status only wins once it says something
 * the clock cannot (resolved / voided).
 */
export function deriveStatus(
  raw: string,
  tradingStart: number,
  expiry: number,
  nowSec: number,
  voided: boolean,
  winningOutcome: number | null,
): MarketStatus {
  if (voided || raw === "Voided") return "voided";
  if (raw === "Resolved" || raw === "Finalized" || winningOutcome !== null) return "resolved";
  if (raw === "Settling") return "settling";
  if (nowSec >= expiry) return raw === "Locked" ? "locked" : "locked";
  if (nowSec < tradingStart) return "upcoming";
  return "trading";
}

/** 0 = YES = Up, 1 = NO = Down. Anything else has no usable outcome. */
export function outcomeFromIndex(idx: number | null | undefined): Outcome | null {
  if (idx === 0) return "up";
  if (idx === 1) return "down";
  return null;
}
