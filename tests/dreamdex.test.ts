import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SimDreamDexAdapter } from "@/lib/dreamdex/sim";
import { LiveDreamDexAdapter } from "@/lib/dreamdex/live";
import { deriveStatus, outcomeFromIndex, type DreamDexAdapter } from "@/lib/dreamdex/adapter";
import { ResilientAdapter } from "@/lib/dreamdex";
import { translateError, type ErrorCategory } from "@/lib/dreamdex/errors";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const HOUR = 3600;
const T0 = 1_800_000_000;

describe("market status derivation (FR-011, FR-023)", () => {
  it("reads the clock, not the event status, while a market is live", () => {
    // The indexer says "Trading" long after expiry because the
    // Trading->Settling transition emits no event. The clock wins.
    expect(deriveStatus("Trading", T0, T0 + HOUR, T0 + HOUR + 60, false, null)).toBe("locked");
  });

  it("is upcoming before trading opens", () => {
    expect(deriveStatus("Listed", T0, T0 + HOUR, T0 - 60, false, null)).toBe("upcoming");
  });

  it("is trading inside the window", () => {
    expect(deriveStatus("Trading", T0, T0 + HOUR, T0 + 60, false, null)).toBe("trading");
  });

  it("lets a resolution event override the clock", () => {
    expect(deriveStatus("Resolved", T0, T0 + HOUR, T0 + 60, false, 0)).toBe("resolved");
    expect(deriveStatus("Trading", T0, T0 + HOUR, T0 + 60, false, 1)).toBe("resolved");
  });

  it("treats a voided market as voided whatever else it says", () => {
    expect(deriveStatus("Trading", T0, T0 + HOUR, T0 + 60, true, null)).toBe("voided");
    expect(deriveStatus("Voided", T0, T0 + HOUR, T0 + 60, false, null)).toBe("voided");
  });

  it("maps outcome indices: 0 = Up (YES), 1 = Down (NO)", () => {
    expect(outcomeFromIndex(0)).toBe("up");
    expect(outcomeFromIndex(1)).toBe("down");
    expect(outcomeFromIndex(null)).toBeNull();
    expect(outcomeFromIndex(7)).toBeNull();
  });
});

describe("error translation (FR-045)", () => {
  it("never surfaces a raw stack trace and always offers a next step", () => {
    const cases: unknown[] = [
      new Error("execution reverted: MarketNotTrading"),
      new Error("User rejected the request. (code 4001)"),
      new Error("insufficient funds for gas * price + value"),
      new Error("OrderExpiryBeyondMarket"),
      new Error("@somnia-chain/markets-sdk: indexer Portfolio failed: timeout"),
      "some string failure",
      { weird: true },
    ];

    for (const c of cases) {
      const t = translateError(c);
      expect(t.message.length).toBeGreaterThan(0);
      expect(t.nextStep.length).toBeGreaterThan(0);
      expect(t.message).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    }
  });

  it("categorises the failures the order flow actually hits", () => {
    expect(translateError(new Error("MarketNotTrading")).category).toBe("market_not_trading");
    expect(translateError(new Error("User rejected")).category).toBe("user_rejected");
    expect(translateError(new Error("OrderAlreadyExpired")).category).toBe("order_expiry");
    expect(translateError(new Error("nothing recognisable")).category).toBe("unknown");
  });

  it("keeps the raw text for the log without rendering it", () => {
    const t = translateError(new Error("execution reverted: MarketNotTrading"));
    expect(t.raw).toContain("MarketNotTrading");
    expect(t.message).not.toContain("execution reverted");
  });
});

/**
 * The revert table has to describe the pool that actually exists.
 *
 * It used to list `ZeroQuantity` — a name no Somnia contract declares, so it
 * could never fire — while the gates a mis-sized order really trips
 * (`QuantityNotAlignedToLotSize`, `PriceNotAlignedToTickSize`,
 * `ImmediateOrCancelNoFill`) fell through to "Something went wrong". A wrong
 * table is worse than a thin one: it reads as coverage.
 */
describe("the pool's own reverts (FR-045)", () => {
  /** [revert name, the category the ticket must file it under]. */
  const POOL_REVERTS: Array<[string, ErrorCategory]> = [
    ["QuantityNotAlignedToLotSize", "quantity_precision"],
    ["QuantityBelowMinimum", "quantity_precision"],
    ["InvalidQuantity", "quantity_precision"],
    ["PriceNotAlignedToTickSize", "price_precision"],
    ["PriceOutOfBounds", "price_precision"],
    ["InvalidPrice", "price_precision"],
    ["ImmediateOrCancelNoFill", "no_liquidity"],
    ["FillOrKillNotFillable", "no_liquidity"],
    ["TradingNotActive", "market_not_trading"],
    ["MarketRestricted", "market_not_trading"],
    ["OrderExpiryBeyondMarket", "order_expiry"],
    ["OrderAlreadyExpired", "order_expiry"],
    ["ERC20InsufficientAllowance", "insufficient_allowance"],
    ["ERC20InsufficientBalance", "insufficient_balance"],
  ];

  it.each(POOL_REVERTS)("files %s under %s, with a next step", (name, category) => {
    const t = translateError(new Error(`ContractRevertError: ${name}`));
    expect(t.category).toBe(category);
    expect(t.nextStep.length).toBeGreaterThan(0);
    expect(t.message).not.toContain(name); // the Solidity name never reaches the user
    expect(t.raw).toContain(name); //          but the log keeps it
  });

  /**
   * Cross-check the names against the SDK's generated `contractErrorsAbi` — the
   * table it decodes revert data with. It is read off disk rather than imported
   * because the package's export map does not expose it; the dependency is
   * pinned to an exact version, so the path is stable, and nothing here touches
   * the network.
   */
  it("names only reverts the deployed contracts can actually raise", () => {
    const source = readFileSync(
      "node_modules/@somnia-chain/markets-sdk/dist/contractErrorsAbi.js",
      "utf8",
    );
    const declared = new Set(
      [...source.matchAll(/name: *"([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(100); // the extraction still works

    for (const [name] of POOL_REVERTS) {
      expect(declared.has(name), `${name} is not a real contract error`).toBe(true);
    }
    // The name the old table carried. Keeping it would have been a comforting
    // lie: it cannot be raised, so it can never be the reason an order failed.
    expect(declared.has("ZeroQuantity")).toBe(false);
  });

  it("still refuses to guess at something it does not recognise", () => {
    const t = translateError(new Error("SomeUnmappedProtocolError"));
    expect(t.category).toBe("unknown");
    expect(t.nextStep.length).toBeGreaterThan(0);
  });
});

describe("simulation adapter", () => {
  const clock = () => 1_800_003_600;
  const sim = new SimDreamDexAdapter(clock);

  it("is deterministic across instances — same clock, same markets", async () => {
    const a = await new SimDreamDexAdapter(clock).listMarkets({ limit: 5 });
    const b = await new SimDreamDexAdapter(clock).listMarkets({ limit: 5 });
    expect(a).toEqual(b);
  });

  it("only lists markets that have not expired", async () => {
    for (const m of await sim.listMarkets()) {
      expect(m.expiry).toBeGreaterThan(clock());
    }
  });

  it("sorts soonest-to-expire first", async () => {
    const markets = await sim.listMarkets();
    const expiries = markets.map((m) => m.expiry);
    expect([...expiries].sort((x, y) => x - y)).toEqual(expiries);
  });

  it("filters by asset and by cadence", async () => {
    expect((await sim.listMarkets({ asset: "BTC" })).every((m) => m.asset === "BTC")).toBe(true);
    expect((await sim.listMarkets({ intervalSec: 3600 })).every((m) => m.expiry - m.tradingStart === 3600)).toBe(true);
  });

  it("prices Down as the inverse of Up on the same book (PRD §11.2)", async () => {
    const [m] = await sim.listMarkets({ limit: 1 });
    const book = await sim.getOrderBook(m.id);
    expect(book).not.toBeNull();

    // Best Down ask mirrors the best Up bid.
    expect(book!.downAsks[0].price).toBeCloseTo(1 - book!.upBids[0].price, 9);
    expect(book!.downBids[0].price).toBeCloseTo(1 - book!.upAsks[0].price, 9);
  });

  it("keeps bids below asks and every price inside (0,1)", async () => {
    for (const m of (await sim.listMarkets()).slice(0, 6)) {
      const book = await sim.getOrderBook(m.id);
      if (!book) continue;
      expect(book.upBids[0].price).toBeLessThan(book.upAsks[0].price);
      for (const lvl of [...book.upBids, ...book.upAsks, ...book.downBids, ...book.downAsks]) {
        expect(lvl.price).toBeGreaterThan(0);
        expect(lvl.price).toBeLessThan(1);
        expect(lvl.quantity).toBeGreaterThan(0);
      }
    }
  });

  it("never lets a simulated market claim to be tradable on chain", async () => {
    const health = await sim.health();
    expect(health.mode).toBe("sim");
    expect(health.message).toMatch(/simulation/i);
  });

  it("resolves past markets with a stable outcome", async () => {
    const settled = await sim.listSettledMarkets(5);
    expect(settled.length).toBeGreaterThan(0);
    for (const m of settled) {
      expect(m.status).toBe("resolved");
      expect(["up", "down"]).toContain(m.resolvedOutcome);
    }
    // Re-reading gives the same outcome; a score can never flip on refresh.
    const again = await sim.listSettledMarkets(5);
    expect(again.map((m) => m.resolvedOutcome)).toEqual(settled.map((m) => m.resolvedOutcome));
  });

  it("reports settlements only for markets that actually resolved", async () => {
    const live = await sim.listMarkets({ limit: 3 });
    const settled = await sim.listSettledMarkets(3);
    const result = await sim.getSettlements([...live.map((m) => m.id), ...settled.map((m) => m.id)]);
    expect(result.map((r) => r.marketId).sort()).toEqual(settled.map((m) => m.id).sort());
  });

  // The pool-recycling rule, held here too so an offline rehearsal exercises
  // the same screens a live run would. See the live adapter's own test below.
  it("serves no book for a contract that has stopped trading", async () => {
    const settled = await sim.listSettledMarkets(3);
    expect(settled.length).toBeGreaterThan(0);
    for (const m of settled) {
      expect(m.status).not.toBe("trading");
      expect(await sim.getOrderBook(m.id)).toBeNull();
    }
  });

  it("still serves a book for a contract that is trading", async () => {
    const [open] = await sim.listMarkets({ limit: 1 });
    expect(open.status).toBe("trading");
    expect(await sim.getOrderBook(open.id)).not.toBeNull();
  });
});

/**
 * The fallback, and what it is allowed to say about itself.
 *
 * The bug these exist for: `mode` was a hardcoded `"live"`, so an unreachable
 * indexer rendered two dozen generated contracts under "Live Event Contracts"
 * with a green TRADING pill on each. The rule now is that provenance follows
 * the data — both in `mode` and on every object that leaves the adapter.
 */
describe("the live→sim fallback (PRD §17)", () => {
  const sim = new SimDreamDexAdapter(() => 1_800_003_600);

  /** A live adapter that fails on demand, so an outage can start and end. */
  const flakyLive = (state: { up: boolean }): DreamDexAdapter => ({
    mode: "live",
    listMarkets: async () => (state.up ? sim.listMarkets({ limit: 3 }) : Promise.reject(new Error("indexer down"))),
    getMarket: async (id) => (state.up ? sim.getMarket(id) : Promise.reject(new Error("indexer down"))),
    getOrderBook: async (id, d) => (state.up ? sim.getOrderBook(id, d) : Promise.reject(new Error("indexer down"))),
    getOnchainState: async () => null,
    getSettlements: async () => [],
    listSettledMarkets: async () => [],
    health: async () => ({
      mode: "live", ok: state.up, chainId: 50312, indexerBlock: state.up ? 1 : null,
      message: state.up ? null : "indexer down", checkedAt: 0,
    }),
    close: async () => {},
  });

  it("stamps every market and book with the source that answered", async () => {
    const state = { up: true };
    const a = new ResilientAdapter(flakyLive(state), sim, 50);

    const live = await a.listMarkets();
    expect(live.every((m) => m.simulated === false)).toBe(true);
    expect(a.mode).toBe("live");

    state.up = false;
    const fallback = await a.listMarkets();
    expect(fallback.every((m) => m.simulated === true)).toBe(true);
    expect((await a.getOrderBook(fallback[0].id))?.simulated).toBe(true);
    expect(a.mode).toBe("sim");
  });

  /**
   * The cooldown is five seconds, and a leaderboard or a portfolio does no
   * market reads at all — so keying the banner on the cooldown alone let it
   * flip back to "live" while a grid of generated contracts was still on
   * screen. Measured before the fix: `sim` for 5s after a failed read, `live`
   * 6s after it.
   */
  it("keeps reporting the source that produced the data after the cooldown lapses", async () => {
    const state = { up: false };
    const a = new ResilientAdapter(flakyLive(state), sim, 5);

    await a.listMarkets();
    expect(a.mode).toBe("sim");

    await new Promise((r) => setTimeout(r, 20)); // well past the cooldown
    expect(a.mode).toBe("sim");
    expect((await a.health()).mode).toBe("sim");
    expect((await a.health()).message).toMatch(/generated locally/);
  });

  it("returns to live once the indexer answers again, without needing a market read", async () => {
    const state = { up: false };
    const a = new ResilientAdapter(flakyLive(state), sim, 5);

    await a.listMarkets();
    expect(a.mode).toBe("sim");

    state.up = true;
    await new Promise((r) => setTimeout(r, 20));
    // The health probe alone clears the stale memory: a page with no market
    // cards on it would otherwise hold a red banner for the life of the tab.
    expect((await a.health()).ok).toBe(true);
    expect(a.mode).toBe("live");
  });

  it("never serves a simulated chain-head state — that would authorise a real write", async () => {
    const state = { up: false };
    const live = flakyLive(state);
    const a = new ResilientAdapter(
      { ...live, getOnchainState: async () => { throw new Error("indexer down"); } },
      sim,
      5_000,
    );

    await a.listMarkets(); // put it firmly on the fallback
    expect(a.mode).toBe("sim");
    await expect(a.getOnchainState("0xanything")).rejects.toThrow(/indexer down/);
  });
});

/**
 * Integration against the real Somnia Shannon testnet (PRD §15.2).
 * Skipped when `SKIP_LIVE_TESTS=1`, so the suite still runs offline.
 */
const describeLive = process.env.SKIP_LIVE_TESTS === "1" ? describe.skip : describe;

describeLive("live DreamDEX integration (Somnia Shannon testnet)", () => {
  const adapter = new LiveDreamDexAdapter({
    indexerUrl: process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
  });

  it("reports the indexer as healthy and on chain 50312", async () => {
    const h = await adapter.health();
    expect(h.ok).toBe(true);
    expect(h.chainId).toBe(50312);
    expect(h.indexerBlock).toBeGreaterThan(0);
  });

  it("lists live Event Contracts with the fields the UI needs (AC-002)", async () => {
    const markets = await adapter.listMarkets({ limit: 10 });
    expect(markets.length).toBeGreaterThan(0);

    const nowSec = Math.floor(Date.now() / 1000);
    for (const m of markets) {
      expect(m.id).toMatch(/^0x[0-9a-f]+$/i);
      expect(m.expiry).toBeGreaterThan(nowSec);
      expect(m.asset).toBeTruthy();
      expect(m.question).toBeTruthy();
      expect(["upcoming", "trading"]).toContain(m.status);
      if (m.upProbability !== null) {
        expect(m.upProbability).toBeGreaterThan(0);
        expect(m.upProbability).toBeLessThan(1);
      }
    }
  });

  it("reads a real 4-sided order book at chain head (FR-021)", async () => {
    const markets = await adapter.listMarkets({ limit: 10 });
    const quoted = markets.find((m) => m.bestBid !== null && m.bestAsk !== null);
    if (!quoted) {
      // Legitimate testnet state, not a failure — FR-014 covers this path.
      return;
    }

    expect(quoted.spread).toBeGreaterThanOrEqual(0);

    const book = await adapter.getOrderBook(quoted.id, 5);
    expect(book).not.toBeNull();
    expect(book!.upBids.length + book!.upAsks.length).toBeGreaterThan(0);

    if (book!.upBids.length && book!.upAsks.length) {
      expect(book!.upBids[0].price).toBeLessThan(book!.upAsks[0].price);
      // The NO side is the YES book inverted, as BinaryPool prices it.
      expect(book!.downBids[0].price).toBeCloseTo(1 - book!.upAsks[0].price, 6);
    }
  });

  it("verifies write-eligibility from chain, not from the indexer (FR-055)", async () => {
    const [m] = await adapter.listMarkets({ limit: 1 });
    const state = await adapter.getOnchainState(m.id);

    expect(state).not.toBeNull();
    expect(state!.marketId).toBe(m.id);
    expect(state!.expiry).toBe(m.expiry);
    expect(typeof state!.acceptsOrders).toBe("boolean");
    expect(state!.poolAddress.toLowerCase()).toBe(m.poolAddress.toLowerCase());
  });

  it("returns settled contracts with a usable outcome for scoring", async () => {
    // FORTY, not ten. A contract is "past" the moment it expires, but its
    // outcome only exists once DreamDEX's committee has voted, and on a venue
    // minting 5- and 15-minute BTC/ETH series the most recent expiries are
    // always still inside that lag. Measured on 2026-09-08: of the newest 10
    // past contracts, 0 carried a winning outcome; of 20, 10 did; of 40, 30.
    // Asking for 10 was therefore a sample that structurally could not contain
    // the thing this test asserts about, and the suite went red on a healthy
    // chain. The assertion below is unchanged — only the window is wide enough
    // to clear the lag.
    const settled = await adapter.listSettledMarkets(40);
    expect(settled.length).toBeGreaterThan(0);

    const resolved = settled.filter((m) => m.resolvedOutcome !== null);
    expect(resolved.length).toBeGreaterThan(0);
    for (const m of resolved) {
      expect(["up", "down"]).toContain(m.resolvedOutcome);
      expect(m.status).toBe("resolved");
    }
  });

  it("serves a repeated market read from cache without changing the answer", async () => {
    const a = await adapter.listMarkets({ limit: 5 });
    const b = await adapter.listMarkets({ limit: 5 });
    expect(b.map((m) => m.id)).toEqual(a.map((m) => m.id));
  });

  /**
   * DreamDEX recycles a BinaryPool down a series, so a settled contract's
   * `poolAddress` is frequently the pool a *currently trading* contract is
   * using. Reading it returns real depth with a fresh timestamp that belongs to
   * a different contract — which the market page rendered as this contract's
   * own book. Measured when this was written: 23 of the last 50 settled
   * contracts shared a pool with a live one.
   */
  it("never serves a closed contract the successor's book (pool recycling)", async () => {
    const settled = await adapter.listSettledMarkets(20);
    const live = await adapter.listMarkets({ limit: 40 });
    expect(settled.length).toBeGreaterThan(0);

    // Only the collisions are interesting: a settled contract whose pool a
    // contract trading *right now* is using is precisely the case that used to
    // return real depth belonging to somebody else.
    const livePools = new Set(live.map((m) => m.poolAddress.toLowerCase()));
    const recycled = settled.filter((m) => livePools.has(m.poolAddress.toLowerCase()));
    if (recycled.length === 0) {
      // Legitimate venue state (a quiet series, every pool retired), not a
      // failure — the same shape the one-sided-book test above uses.
      return;
    }

    // A handful is enough to discriminate, and each read costs a round trip.
    for (const m of recycled.slice(0, 4)) {
      expect(m.status).not.toBe("trading");
      expect(await adapter.getOrderBook(m.id)).toBeNull();
    }
  });
});
