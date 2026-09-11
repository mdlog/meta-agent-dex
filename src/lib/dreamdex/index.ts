/**
 * Adapter selection and the live→sim safety net.
 *
 * PRD §17 names indexer lag and a dead testnet market as the two risks most
 * likely to kill a demo. {@link ResilientAdapter} answers both: it always
 * prefers real DreamDEX data, and when a read throws it serves the simulation
 * *and says so*, so the UI can show a degraded banner instead of a blank page.
 *
 * "And says so" is the load-bearing half, and it used to be false. `mode` was a
 * hardcoded `"live"`, so an unreachable indexer rendered two dozen generated
 * contracts under the heading "Live Event Contracts" with a green TRADING pill
 * on each one. PRD §15.4 forbids a fallback that fakes a transaction; faking a
 * *market* is the same promise. Two things fix it here: `mode` now follows the
 * adapter that actually answered, and every market that leaves this file
 * carries where it came from, so a card can label itself without knowing
 * anything about adapters.
 */

import type { ArenaMarket, ArenaOrderBook } from "@/lib/domain/types";
import type {
  AdapterHealth,
  DreamDexAdapter,
  MarketFilter,
  OnchainMarketState,
  SettledMarket,
} from "./adapter";
import { LiveDreamDexAdapter } from "./live";
import { SimDreamDexAdapter } from "./sim";
import { translateError } from "./errors";

export * from "./adapter";
export { translateError } from "./errors";
export type { TranslatedError, ErrorCategory } from "./errors";

export type DreamDexMode = "live" | "sim";

/**
 * How long one failure keeps us on the fallback before retrying live.
 *
 * Short on purpose. The cost of a small number is one failed live read per
 * window during a real outage; the cost of a large one is that the app goes on
 * serving generated contracts for twenty seconds after the indexer is back.
 * The second is worse — the whole point of the fallback is that it is temporary
 * and visibly so.
 */
const FALLBACK_COOLDOWN_MS = 5_000;

/**
 * Provenance travels with the data, not beside it.
 *
 * A card is rendered from one {@link ArenaMarket} and has no view of which
 * adapter answered, so this cannot live only in the status banner — a banner is
 * one line the reader has already scrolled past by the time they are looking at
 * the grid.
 */
function stamp(market: ArenaMarket, simulated: boolean): ArenaMarket {
  return { ...market, simulated };
}

/**
 * The book gets the same stamp, for the same reason one level down: a panel of
 * generated bids and asks is as much a claim about Somnia as a card is.
 */
function stampBook(book: ArenaOrderBook, simulated: boolean): ArenaOrderBook {
  return { ...book, simulated };
}

/**
 * Serves live DreamDEX data, and falls back to the simulation for the duration
 * of an outage rather than failing the request.
 *
 * Writes are deliberately NOT proxied here — an order is signed in the browser
 * against the real pool or not at all. There is no simulated transaction.
 */
export class ResilientAdapter implements DreamDexAdapter {
  private degradedUntil = 0;
  private lastError: string | null = null;
  /**
   * Which adapter last actually answered a read.
   *
   * The cooldown alone is not enough to describe what is on screen. It is five
   * seconds long on purpose, so on any page that does not re-read markets —
   * the audit ledger, an agent dossier — it lapses while a grid of generated
   * contracts is still being looked at, and `mode` would flip back to "live"
   * with nothing live about the page. Measured: `mode` read `sim` for 5s after
   * a failed market read and `live` 6s after it.
   *
   * This is the memory the banner needs: the source that produced the data,
   * which stays true until a read replaces it. Null before the first read —
   * a fresh process with a failing health probe has served nothing yet, and
   * saying "simulated" about no data would be its own invention.
   */
  private lastServed: DreamDexMode | null = null;

  private readonly live: DreamDexAdapter;
  private readonly sim: DreamDexAdapter;
  /** How long one failure keeps us on the fallback before retrying live. */
  private readonly cooldownMs: number;

  constructor(live: DreamDexAdapter, sim: DreamDexAdapter, cooldownMs = FALLBACK_COOLDOWN_MS) {
    this.live = live;
    this.sim = sim;
    this.cooldownMs = cooldownMs;
  }

  /**
   * The source reads are being served from *right now* — not the source we
   * prefer. `/api/health` and the status strip both key off this, so it has to
   * describe the data on screen rather than the configuration.
   */
  get mode(): DreamDexMode {
    return this.degraded ? "sim" : "live";
  }

  /**
   * True when the reads being served are the simulation's — either because a
   * failure is still inside its cooldown, or because the last read that
   * actually happened came from the fallback and nothing has replaced it.
   */
  get degraded() {
    return this.inCooldown || this.lastServed === "sim";
  }

  /**
   * Whether to skip the live adapter on the next read. Only the cooldown, never
   * {@link lastServed} — folding the memory in here would mean one failure
   * pinned the app to the simulation for the life of the process.
   */
  private get inCooldown() {
    return Date.now() < this.degradedUntil;
  }

  /** Runs `op` against live where possible, and reports which side answered. */
  private async attempt<T>(op: (a: DreamDexAdapter) => Promise<T>): Promise<{ value: T; simulated: boolean }> {
    if (!this.inCooldown) {
      try {
        const value = await op(this.live);
        this.lastError = null;
        this.lastServed = "live";
        return { value, simulated: false };
      } catch (e) {
        this.lastError = translateError(e).message;
        this.degradedUntil = Date.now() + this.cooldownMs;
      }
    }
    const value = await op(this.sim);
    this.lastServed = "sim";
    return { value, simulated: true };
  }

  async listMarkets(filter?: MarketFilter): Promise<ArenaMarket[]> {
    const { value, simulated } = await this.attempt((a) => a.listMarkets(filter));
    return value.map((m) => stamp(m, simulated));
  }
  async getMarket(id: string): Promise<ArenaMarket | null> {
    const { value, simulated } = await this.attempt((a) => a.getMarket(id));
    return value ? stamp(value, simulated) : null;
  }
  async getOrderBook(id: string, depth?: number): Promise<ArenaOrderBook | null> {
    const { value, simulated } = await this.attempt((a) => a.getOrderBook(id, depth));
    return value ? stampBook(value, simulated) : null;
  }
  getOnchainState(id: string): Promise<OnchainMarketState | null> {
    // Never simulated: this decides whether a real order may be sent (FR-055).
    // Deliberately not routed through `attempt` — a fallback here would let a
    // generated "trading" state authorise a transaction against a real pool.
    return this.live.getOnchainState(id);
  }
  async getSettlements(ids: string[]): Promise<SettledMarket[]> {
    return (await this.attempt((a) => a.getSettlements(ids))).value;
  }
  async listSettledMarkets(limit?: number): Promise<ArenaMarket[]> {
    const { value, simulated } = await this.attempt((a) => a.listSettledMarkets(limit));
    return value.map((m) => stamp(m, simulated));
  }

  async health(): Promise<AdapterHealth> {
    const h = await this.live.health();

    // A healthy probe outside the cooldown is evidence the indexer is answering
    // again, so the memory of the last fallback read has become stale rather
    // than informative — the next read will be live. Clearing it is what lets
    // the banner recover on a page that does no market reads of its own; left
    // in place, a leaderboard opened during an outage would stay red for ever.
    // Note this only ever *drops* a memory: the probe still cannot claim a live
    // read happened, which is why it sets null rather than "live".
    if (h.ok && !this.inCooldown) this.lastServed = null;

    if (h.ok && !this.degraded) return h;

    // Two different failures, and the banner has to tell them apart. The sync
    // probe can fail while market reads still succeed — that is real data with
    // an unverifiable lag, and calling it "simulated" would be its own lie. The
    // health probe deliberately does not arm the cooldown either: a flaky
    // `getSyncStatus` must never be able to push the app onto generated markets
    // while the market queries themselves are answering.
    const retrySec = Math.max(1, Math.round(this.cooldownMs / 1000));
    return {
      ...h,
      mode: this.mode,
      ok: false,
      message: this.degraded
        ? `Simulated markets. ${this.lastError ?? "DreamDEX reads are failing."} Every contract being served right now is generated locally, exists nowhere on Somnia, and cannot take an order. Live reads are retried every ${retrySec}s.`
        : (h.message ??
          "The DreamDEX indexer did not answer its health check. Markets are still read live, but their lag cannot be confirmed."),
    };
  }

  async close() {
    await Promise.allSettled([this.live.close(), this.sim.close()]);
  }
}

/**
 * The simulation, with every market stamped.
 *
 * `DREAMDEX_MODE=sim` hands the simulation straight to the app, never touching
 * {@link ResilientAdapter} — and an offline rehearsal is still a screen someone
 * can be looking at. Labelling is a property of the data source, so it belongs
 * on both paths out of {@link build}, not only the fallback one.
 */
function labelledSim(sim: DreamDexAdapter): DreamDexAdapter {
  return {
    mode: "sim",
    listMarkets: async (filter) => (await sim.listMarkets(filter)).map((m) => stamp(m, true)),
    getMarket: async (id) => {
      const m = await sim.getMarket(id);
      return m ? stamp(m, true) : null;
    },
    getOrderBook: async (id, depth) => {
      const b = await sim.getOrderBook(id, depth);
      return b ? stampBook(b, true) : null;
    },
    getOnchainState: (id) => sim.getOnchainState(id),
    getSettlements: (ids) => sim.getSettlements(ids),
    listSettledMarkets: async (limit) => (await sim.listSettledMarkets(limit)).map((m) => stamp(m, true)),
    health: () => sim.health(),
    close: () => sim.close(),
  };
}

function build(): DreamDexAdapter {
  const mode = (process.env.DREAMDEX_MODE ?? "live").toLowerCase();
  if (mode === "sim") return labelledSim(new SimDreamDexAdapter());

  const live = new LiveDreamDexAdapter({
    indexerUrl: process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
  });
  return new ResilientAdapter(live, new SimDreamDexAdapter());
}

// One adapter per process. Pinned to globalThis so Next's dev-mode module
// reloading doesn't leak a WebSocket per edit.
const globalRef = globalThis as typeof globalThis & { __forecastArenaAdapter?: DreamDexAdapter };

export function getAdapter(): DreamDexAdapter {
  globalRef.__forecastArenaAdapter ??= build();
  return globalRef.__forecastArenaAdapter;
}
