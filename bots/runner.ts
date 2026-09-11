/**
 * Meta-Agent DEX — the autonomous agent runner.
 *
 * This is the process a developer runs on their own machine. It holds ONE key,
 * the operator hot key, and that key's only privilege on chain is
 * `BotVault.trade(...)`: `deposit`, `withdraw` and `setOperator` are `onlyOwner`
 * and the owner is a different address entirely. So a stolen runner key can lose
 * money by trading badly — which is what the meta-market is a bet on — and can
 * never move a single unit of collateral out of the vault. Nothing in this file
 * touches an ERC-20 or an ERC-6909 directly, and nothing here needs to.
 *
 * Two rules the vault's own surface forces on the strategy, both load-bearing:
 *
 *  - EVERY ORDER IS IOC. `BotVault` exposes `trade` and no `cancelOrder`, so an
 *    order that rests on the book cannot be pulled back by anyone — not the
 *    operator, not the owner — until the market expires. A limit order left
 *    resting through a NAV snapshot is capital nobody can recall, so the runner
 *    only ever crosses the spread and cancels the remainder.
 *  - EVERY ORDER IS A BUY. Selling escrows outcome tokens, which the pool pulls
 *    off the ERC-6909 singleton as an approved operator; `BotVault`'s
 *    constructor grants that operator role to the *module* (so `redeem` works),
 *    never to a pool. A `SELL_YES` from the vault reverts
 *    `InsufficientPermission()`. Flattening is done by buying the other leg:
 *    one YES plus one NO is a complete set and redeems at par.
 *
 * Run it:  node --experimental-strip-types bots/runner.ts     (see bots/README.md)
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  type BinaryBookParams,
  type BinaryMarket,
  type BinaryOrderBook,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/**
 * The ticker every BOTNAV session contract is minted under.
 *
 * Duplicated from `META_ASSET` in `src/lib/domain/types.ts` rather than
 * imported: this file runs under `node --experimental-strip-types`, outside
 * Next's `@/` resolver, and a runner that cannot start is worse than a constant
 * written twice. Both sites mint and read the same string.
 */
const META_ASSET = "BOTNAV";

/**
 * Rows to pull per scan. Sized for both sides of the board at once — see the
 * `listLiveBinaryMarkets` call — not for the ~8 that clear the gate.
 */
const LISTING_LIMIT = 80;

/** `OrderKind` on a BinaryPool — the `kind` byte `BotVault.trade` forwards. */
const BUY_YES = 0;
const BUY_NO = 2;

/**
 * The only two kinds this runner can send. 1 (SELL_YES) and 3 (SELL_NO) are
 * absent from the type on purpose — see the header: a sell escrows outcome
 * tokens the pool is not approved to pull off the vault, so it reverts.
 */
export type BuyKind = typeof BUY_YES | typeof BUY_NO;

/**
 * `OrderType`: 0 LIMIT (rests) · 1 FOK · 2 IOC · 3 POST_ONLY. Only IOC is
 * reachable from here — see the header: the vault cannot cancel.
 */
const ORDER_TYPE_IOC = 2;

/** The pool takes order expiry in NANOseconds; every other clock here is ms or s. */
const NS_PER_SEC = 1_000_000_000n;

/**
 * Decimals of the vault's collateral — 6dp tUSDC on Shannon. Used only to print
 * NAV and budgets; every per-market amount is formatted with that market's own
 * `quoteDecimals` instead.
 */
const COLLATERAL_DECIMALS = 6;

/**
 * The scale the strategy knobs, the log lines and the app's trade tape all
 * speak: 6-decimal probability units, so 620_000 is 0.62.
 *
 * A pool's own prices are in its collateral's units instead. For this vault
 * those are the same six decimals — it only trades markets collateralised in
 * its own token, which is 6dp tUSDC — but the conversion is done explicitly
 * anyway, because "they happen to match" is not a thing to hardcode into the
 * arithmetic that decides an order's price.
 */
const WIRE = 1_000_000n;

/** A pool price, in that pool's collateral scale, as wire probability units. */
export function toWire(price: bigint, one: bigint): bigint {
  return (price * WIRE) / one;
}

/** A raw money column as the services layer accepts it: a plain decimal integer. */
const RAW_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;

/**
 * Only these signatures are decoded from a revert. The SDK ships all 418 of the
 * protocol's custom errors but does not export them, and a deep import is
 * blocked by its `exports` map — so this is the short list that a misconfigured
 * runner actually hits, and an unmatched revert still reports its selector.
 */
const knownErrorsAbi = parseAbi([
  // Not a fault: an IOC that crossed nothing. The pool reverts rather than
  // returning empty, so it arrives here looking like a failure. See NO_FILL.
  "error ImmediateOrCancelNoFill()",
  "error PriceNotAlignedToTickSize()",
  "error QuantityNotAlignedToLotSize()",
  "error QuantityBelowMinimum()",
  "error PriceOutOfBounds()",
  "error OrderExpiryBeyondMarket()",
  "error OrderAlreadyExpired()",
  "error InsufficientPermission()",
  "error MarketOutlivesSession()",
  "error SessionNotOpen()",
  "error NotOperator()",
]);

/**
 * The vault's surface, as this process uses it. Mirrored from `contracts/BotVault.sol`
 * rather than imported from `src/lib/agents/abi.ts` on purpose: the runner is meant
 * to be copied out of this repo and run anywhere, and the app's modules resolve
 * through the `@/` path alias, which node cannot follow without a loader.
 */
const vaultAbi = parseAbi([
  "function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType)",
  "function nav() view returns (uint256)",
  "function unaccounted() view returns (uint256)",
  "function sessionOpen() view returns (bool)",
  "function sessionId() view returns (uint256)",
  "function sessionEnd() view returns (uint64)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function collateral() view returns (address)",
  "event Traded(bytes32 indexed marketId, uint8 kind, uint256 price, uint256 quantity, int256 cashDelta)",
]);

// ---------------------------------------------------------------------------
// Logging — one line per action, logfmt. A demo is watched through this.
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, string | number | bigint | boolean | null | undefined>;

function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const parts = [new Date().toISOString(), level.padEnd(5), event.padEnd(9)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    // Quote anything with whitespace so one action stays one parseable line.
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Display only. Every number that reaches the chain or the API stays a bigint. */
function money(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/** A wire price as the probability it means, for the log. Display only. */
function probability(wirePrice: bigint): string {
  return (Number((wirePrice * 1000n) / WIRE) / 1000).toFixed(3);
}

/** `BTC-15m@14:00` — the same label the app's cards use, so logs match the UI. */
function symbolOf(market: BinaryMarket): string {
  const at = new Date(Number(market.expiry) * 1000);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${market.asset}-${market.interval ?? "?"}@${hh}:${mm}`;
}

/** Signed drift in probability points, e.g. `+2.8pt`. Display only. */
function points(wireDelta: bigint): string {
  const pt = Number((wireDelta * 1000n) / WIRE) / 10;
  return `${pt >= 0 ? "+" : ""}${pt.toFixed(1)}pt`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type StrategyName = "momentum" | "mean-reversion";

export interface Config {
  operatorKey: Hex;
  vault: Address;
  api: string;
  slug: string;
  strategy: StrategyName;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  pollMs: number;
  assets: readonly string[];
  /** Raw collateral units. The vault's collateral is 6dp tUSDC, so 25_000_000 = 25 tUSDC. */
  maxOrder: bigint;
  /** Never spend the vault below this — a NAV of zero has nothing left to trade with. */
  minCash: bigint;
  /** Total this process will commit to any one market. */
  maxPerMarket: bigint;
  cooldownMs: number;
  /** Skip a contract expiring sooner than this: an IOC needs a book to cross. */
  minRunwaySec: number;
  /** How far through the spread to reach, in ticks. */
  crossTicks: bigint;
  /** Refuse to pay more than this per contract, either leg. */
  maxEntry: bigint;
  /** momentum: the move that counts as a trend, in raw probability units. */
  driftThreshold: bigint;
  lookbackSec: number;
  /** mean-reversion: how far from 0.50 counts as an extreme. */
  reversionBand: bigint;
  /** mean-reversion: an extreme this close to expiry is information, not an anomaly. */
  minRevertSec: number;
  dryRun: boolean;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function requireEnv(name: string, hint: string): string {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

function envInt(name: string, fallback: number, min: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be a whole number >= ${min} (got ${value}).`);
  }
  return parsed;
}

/**
 * A raw 6-decimal integer, never a human amount — collateral units for the money
 * knobs, probability units for the price ones. `25` means 0.000025, not 25, and
 * that is deliberate: the whole stack carries these as the integers the chain
 * uses, so the env does too rather than introducing one float at the edge.
 */
function envRaw(name: string, fallback: bigint): bigint {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!RAW_INTEGER.test(value)) {
    throw new Error(
      `${name} must be a raw 6-decimal integer — 25000000 for 25 tUSDC, 900000 for a price of 0.90 (got ${value}).`,
    );
  }
  return BigInt(value);
}

function envFlag(name: string): boolean {
  const value = env(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readConfig(): Config {
  const key = requireEnv(
    "AGENT_OPERATOR_KEY",
    "Generate a throwaway key for the bot — it may only call trade(), never move funds.",
  );
  if (!PRIVATE_KEY.test(key)) {
    throw new Error("AGENT_OPERATOR_KEY must be a 32-byte hex private key.");
  }

  const vault = requireEnv("AGENT_VAULT", "This is the BotVault address the app deployed for your agent.");
  if (!ADDRESS.test(vault)) throw new Error("AGENT_VAULT must be a 20-byte hex address.");

  const strategy = env("AGENT_STRATEGY") ?? "momentum";
  if (strategy !== "momentum" && strategy !== "mean-reversion") {
    throw new Error(`AGENT_STRATEGY must be "momentum" or "mean-reversion" (got "${strategy}").`);
  }

  const assets = (env("AGENT_ASSETS") ?? "BTC,ETH")
    .split(",")
    .map((a) => a.trim().toUpperCase())
    .filter((a) => a.length > 0);
  if (assets.length === 0) throw new Error("AGENT_ASSETS listed no assets.");

  // 0.65, not the 0.90 this shipped with.
  //
  // Paying 0.80 for a contract stakes 80 cents to win 20: one loss erases four
  // wins, so the strategy has to be right about 80% of the time merely to break
  // even, and neither momentum nor mean-reversion claims that. Measured over one
  // hour on the live fleet: 86 orders, 60% of them entered above 0.65 and 33
  // above 0.80, spending 853.60 tUSDC — Kinetic Arc went 194.78 -> 24.67 and
  // Fade Nine 166.46 -> 10.00 inside six minutes. The cap is what makes a losing
  // trade cost less than a winning one gains.
  const maxEntry = envRaw("AGENT_MAX_ENTRY", 650_000n);
  if (maxEntry <= 0n || maxEntry >= 1_000_000n) {
    throw new Error("AGENT_MAX_ENTRY is a price in 6dp probability units, strictly between 0 and 1000000.");
  }

  return {
    operatorKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    vault: vault.toLowerCase() as Address,
    // 3009, the port this app actually serves on. It defaulted to 3971, which
    // nothing in this repo has ever listened on, so every heartbeat and trade
    // report from a runner started without AGENT_API went to a closed socket.
    api: (env("AGENT_API") ?? "http://localhost:3009").replace(/\/+$/, ""),
    slug: requireEnv("AGENT_SLUG", "The agent's slug from registration — the API is keyed by it."),
    strategy,
    rpcUrl: env("SOMNIA_RPC_URL") ?? "https://dream-rpc.somnia.network",
    wsRpcUrl: env("SOMNIA_WS_RPC_URL") ?? "wss://api.infra.testnet.somnia.network/ws",
    indexerUrl: env("SOMNIA_INDEXER_URL") ?? "https://dev.smk.somnia.host/v1/graphql",
    // 3s is the floor because the poll costs an indexer read plus a chain read
    // per candidate; below that the runner is rate-limiting itself, not trading.
    pollMs: envInt("AGENT_POLL_MS", 15_000, 3_000),
    assets,
    maxOrder: envRaw("AGENT_MAX_ORDER", 25_000_000n),
    minCash: envRaw("AGENT_MIN_CASH", 10_000_000n),
    maxPerMarket: envRaw("AGENT_MAX_PER_MARKET", 75_000_000n),
    cooldownMs: envInt("AGENT_COOLDOWN_MS", 90_000, 0),
    minRunwaySec: envInt("AGENT_MIN_RUNWAY_SEC", 120, 0),
    // One tick, not three. An IOC fills at the resting price it crosses, so
    // reaching three ticks past the touch buys no extra depth that one tick
    // does not already reach — it only widens the worst price the order is
    // willing to accept, at 0.1 point per tick.
    crossTicks: BigInt(envInt("AGENT_CROSS_TICKS", 1, 0)),
    maxEntry,
    // 4.5 points, above the ~3.1 it costs to enter (2.8 median spread plus the
    // crossing tick). At the old 2.0 the strategy paid more to open a position
    // than the move it opened on was worth — see the fallback block in
    // scripts/start-declared-runners.ts for the measurement.
    driftThreshold: envRaw("AGENT_DRIFT_THRESHOLD", 45_000n),
    lookbackSec: envInt("AGENT_LOOKBACK_SEC", 90, 1),
    reversionBand: envRaw("AGENT_REVERSION_BAND", 220_000n),
    minRevertSec: envInt("AGENT_MIN_REVERT_SEC", 240, 0),
    dryRun: envFlag("AGENT_DRY_RUN"),
  };
}

// ---------------------------------------------------------------------------
// Book arithmetic. All bigint, all in the market's own price scale.
// ---------------------------------------------------------------------------

/** Round down onto the pool's grid — an off-grid value reverts `…NotAlignedTo…`. */
export function alignDown(value: bigint, step: bigint): bigint {
  return (value / step) * step;
}

export function alignUp(value: bigint, step: bigint): bigint {
  return ((value + step - 1n) / step) * step;
}

function clamp(value: bigint, low: bigint, high: bigint): bigint {
  if (value < low) return low;
  return value > high ? high : value;
}

/**
 * What the pool thinks the chance of Up is, in raw price units.
 *
 * The mid of a two-sided book, else the last fill, else nothing — a contract
 * that has never quoted has no signal, and reading it as 0.50 would invent one
 * (the same rule the app's market cards follow).
 */
export function impliedProbability(book: BinaryOrderBook, market: BinaryMarket): bigint | null {
  const bid = book.yesBids[0]?.price;
  const ask = book.yesAsks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2n;
  if (market.lastPrice !== null && RAW_INTEGER.test(market.lastPrice)) return BigInt(market.lastPrice);
  return null;
}

/**
 * Size resting at or inside our limit — the quantity an IOC could actually take.
 *
 * A BUY_YES lifts the YES asks. A BUY_NO is filled by the YES *bids*: the two
 * orders mint a complete set between them, which is why the SDK derives the NO
 * asks from the YES bids (price = 1 − yesPrice) rather than keeping a fifth book.
 */
export function fillableDepth(book: BinaryOrderBook, kind: BuyKind, limit: bigint): bigint {
  const levels = kind === BUY_YES ? book.yesAsks : book.yesBids;
  let total = 0n;
  for (const level of levels) {
    const crosses = kind === BUY_YES ? level.price <= limit : level.price >= limit;
    if (!crosses) break; // levels arrive best-first, so the first miss ends it
    total += level.quantity;
  }
  return total;
}

export interface Order {
  kind: BuyKind;
  side: "BUY_YES" | "BUY_NO";
  /** Always the YES price, both legs — that is what `placeBinaryOrder` takes. */
  price: bigint;
  quantity: bigint;
  /** Collateral the pool will escrow, ceil-rounded exactly as the pool rounds it. */
  cost: bigint;
}

/**
 * Turn a decision into an order the pool will accept, or nothing.
 *
 * Price crosses the spread by `crossTicks` because an IOC that does not cross
 * fills nothing and still costs gas. Quantity is the smaller of what the book
 * can fill and what the budget can pay for, floored onto the lot grid, and the
 * order is abandoned rather than shrunk below `minQuantity`.
 */
export function sizeOrder(
  kind: BuyKind,
  book: BinaryOrderBook,
  grid: BinaryBookParams,
  one: bigint,
  /** Spendable collateral for THIS order, in the pool's collateral units. */
  budget: bigint,
  cfg: Config,
): Order | null {
  const tick = grid.tickSize;
  const reach = tick * cfg.crossTicks;

  // A YES buy pays `price`; a NO buy pays `one − price`. So crossing means
  // raising the YES price for a YES buy and LOWERING it for a NO buy.
  const best = kind === BUY_YES ? book.yesAsks[0]?.price : book.yesBids[0]?.price;
  if (best === undefined) return null;

  const limit =
    kind === BUY_YES
      ? clamp(alignUp(best + reach, tick), tick, one - tick)
      : clamp(alignDown(best > reach ? best - reach : tick, tick), tick, one - tick);

  const perUnit = kind === BUY_YES ? limit : one - limit;
  if (perUnit <= 0n || toWire(perUnit, one) > cfg.maxEntry) return null;

  const depth = fillableDepth(book, kind, limit);
  if (depth === 0n) return null;

  const affordable = (budget * one) / perUnit;
  const quantity = alignDown(depth < affordable ? depth : affordable, grid.lotSize);
  if (quantity < grid.minQuantity || quantity === 0n) return null;

  return {
    kind,
    side: kind === BUY_YES ? "BUY_YES" : "BUY_NO",
    price: limit,
    quantity,
    // The pool ceil-rounds the escrow; matching it means the budget check never
    // authorises one unit less than the pool is about to pull.
    cost: (quantity * perUnit + one - 1n) / one,
  };
}

export interface TradableGate {
  assets: readonly string[];
  /** The vault's own collateral token — anything else it cannot pay for. */
  collateral: string;
  /** `BotVault.sessionEnd()`, in seconds. */
  sessionEndSec: number;
  nowSec: number;
  minRunwaySec: number;
}

/**
 * Can this vault trade this contract right now?
 *
 * Every clause is a rule that already exists somewhere else and would otherwise
 * be discovered as a revert:
 *
 *  - the vault approves ONLY its own collateral to the pool, so a market backed
 *    by a different token is one it cannot pay for;
 *  - `trade` reverts `MarketOutlivesSession` if the contract expires after
 *    `sessionEnd`, which is the rule that keeps every position terminal before
 *    the oracle freezes NAV — checked here so the log says why, in the same
 *    second, instead of a wasted transaction saying it later;
 *  - the pool only accepts orders between `tradingStart` and `expiry`, and an
 *    IOC needs enough runway left to find a counterparty at all.
 *
 * The SDK's own note on `status` is why the window is derived from timestamps
 * rather than trusted from the field: the Listed→Trading→Settling transitions
 * are timestamp-implicit and emit no event for the indexer to follow.
 */
export function tradableForSession(market: BinaryMarket, gate: TradableGate): boolean {
  // A runner trades Somnia's price series and nothing else. The same listing
  // also carries this project's own BOTNAV session contracts — one per open
  // vault session, written against an agent's NAV — and an agent bidding on
  // its own scorecard is not a strategy, it is a way to move its own mark. The
  // asset gate below already excludes them while it reads `BTC,ETH`; this says
  // so on its own terms, so widening `AGENT_ASSETS` cannot quietly open the
  // meta side.
  if (market.asset.toUpperCase() === META_ASSET) return false;
  if (!gate.assets.includes(market.asset.toUpperCase())) return false;
  if (market.voided || market.winningOutcome !== null) return false;
  if (market.collateral.toLowerCase() !== gate.collateral.toLowerCase()) return false;

  const expiry = Number(market.expiry);
  if (expiry > gate.sessionEndSec) return false;
  if (expiry - gate.nowSec < gate.minRunwaySec) return false;
  return Number(market.tradingStart) <= gate.nowSec;
}

// ---------------------------------------------------------------------------
// Strategies. Two of them, both honest: each states a view and can be wrong.
// ---------------------------------------------------------------------------

export interface Sample {
  at: number;
  /** Wire units, so a sample means the same thing on any pool. */
  p: bigint;
}

export interface Signal {
  kind: BuyKind;
  /** How far past its threshold the rule fired — used to pick between markets. */
  edge: bigint;
  why: string;
}

/** Per-market price history, kept in memory: a restart starts the trend fresh. */
const history = new Map<string, Sample[]>();

function remember(marketId: string, p: bigint, now: number, lookbackSec: number): Sample[] {
  const samples = history.get(marketId) ?? [];
  samples.push({ at: now, p });
  // Three lookbacks is enough to answer "where was this a lookback ago" after a
  // couple of missed polls, and bounds the map on a long-running process.
  const floor = now - lookbackSec * 3_000;
  const kept = samples.filter((s) => s.at >= floor);
  history.set(marketId, kept);
  return kept;
}

/**
 * Momentum — trade with the move.
 *
 * The claim is that a repricing this large inside `lookbackSec` is information
 * arriving (a spot move the book is still absorbing) rather than noise, and that
 * it continues. It is wrong whenever the move was the noise, which is why the
 * threshold is a knob and the position is capped.
 */
export function momentum(samples: readonly Sample[], p: bigint, now: number, cfg: Config): Signal | null {
  const lookbackMs = cfg.lookbackSec * 1_000;
  // Samples are oldest-first, so ages descend: the last one still old enough is
  // the sample sitting closest to the lookback boundary.
  let past: Sample | null = null;
  for (const sample of samples) {
    if (now - sample.at < lookbackMs) break;
    past = sample;
  }
  if (past === null) return null;

  const drift = p - past.p;
  if (drift >= cfg.driftThreshold) {
    return { kind: BUY_YES, edge: drift, why: `up ${points(drift)}/${cfg.lookbackSec}s` };
  }
  if (-drift >= cfg.driftThreshold) {
    return { kind: BUY_NO, edge: -drift, why: `down ${points(drift)}/${cfg.lookbackSec}s` };
  }
  return null;
}

/**
 * Mean reversion — fade the extreme.
 *
 * The claim is that a short-dated book pushed far from even is overreacting and
 * drifts back. The time gate is the part that makes it a strategy rather than a
 * losing habit: minutes from expiry a price of 0.95 is not an overreaction, it
 * is the market having already decided, and fading it is buying a near-certain
 * loser at a discount that is not a discount.
 */
export function meanReversion(p: bigint, secondsToExpiry: number, cfg: Config): Signal | null {
  if (secondsToExpiry < cfg.minRevertSec) return null;

  const half = WIRE / 2n;
  const distance = p > half ? p - half : half - p;
  if (distance < cfg.reversionBand) return null;

  const edge = distance - cfg.reversionBand;
  return p > half
    ? { kind: BUY_NO, edge, why: `up at ${probability(p)}, fading` }
    : { kind: BUY_YES, edge, why: `up at ${probability(p)}, fading` };
}

// ---------------------------------------------------------------------------
// The app's API — heartbeat and tape. Best-effort: the chain is the record.
// ---------------------------------------------------------------------------

interface TradeReport {
  marketId: string;
  symbol: string;
  kind: BuyKind;
  /** Whole 6dp probability units, as `recordTrade` validates them. */
  price: number;
  quantity: string;
  cashDelta: string | null;
  txHash: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * POST to the app and hand back what it answered, or log why it failed and
 * carry on.
 *
 * A runner that stopped trading because a web server was down would be
 * reporting an outage by inventing a different one: the vault, not the
 * database, is what the meta-market settles against. Every call here is
 * best-effort and none of them gate an order.
 */
async function report(cfg: Config, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const url = `${cfg.api}/api/agents/${cfg.slug}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
      log("warn", "api", { path, status: res.status, note: detail.slice(0, 160) });
      return null;
    }
    return isRecord(payload) ? payload : {};
  } catch (e) {
    log("warn", "api", { path, note: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * The revert that means "nobody was there", not "something is wrong".
 *
 * An IOC order that crosses no resting size reverts `ImmediateOrCancelNoFill()`
 * — the same outcome as an order that lands and fills zero, which this file
 * already logs as `nofill`. Reaching the catch block instead made it an
 * `error trade … unknown revert 0xd48c4403`: 1,261 of them in one hour on the
 * live fleet, against a handful of real faults. An error log that fires on
 * normal operation hides the failures it exists to surface.
 */
const NO_FILL = "ImmediateOrCancelNoFill";

/** Name the revert if we can, and never lose the selector if we cannot. */
function describeFailure(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName !== undefined) return reverted.data.errorName;
      if (reverted.reason !== undefined) return reverted.reason;
      if (reverted.raw !== undefined) {
        try {
          return decodeErrorResult({ abi: knownErrorsAbi, data: reverted.raw }).errorName;
        } catch {
          return `unknown revert ${reverted.raw.slice(0, 10)}`;
        }
      }
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let stopping = false;
let interruptSleep: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      interruptSleep = null;
      resolve();
    }, ms);
    interruptSleep = () => {
      clearTimeout(timer);
      interruptSleep = null;
      resolve();
    };
  });
}

function requestStop(signal: string): void {
  if (stopping) {
    // Second ctrl-c: the operator has decided the in-flight poll is not worth
    // waiting for. Nothing here holds funds, so exiting mid-poll loses only a
    // log line — a submitted order is already the chain's problem, not ours.
    log("warn", "shutdown", { signal, note: "forced" });
    process.exit(130);
  }
  stopping = true;
  log("info", "shutdown", { signal, note: "finishing this poll — ctrl-c again to force" });
  interruptSleep?.();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = readConfig();
  const account = privateKeyToAccount(cfg.operatorKey);

  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain: somniaShannon, transport: http(cfg.rpcUrl) });
  const exchange = new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: somniaShannon,
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  /** Spread into every vault read so the return types stay viem-inferred. */
  const vaultRead = { address: cfg.vault, abi: vaultAbi } as const;

  log("info", "boot", {
    agent: cfg.slug,
    strategy: cfg.strategy,
    vault: cfg.vault,
    operator: account.address,
    api: cfg.api,
    chain: somniaShannon.id,
    poll_ms: cfg.pollMs,
    assets: cfg.assets.join("+"),
    // The risk control, printed where an operator can see which one is running.
    // Without it the only way to tell 0.65 from 0.90 was to read the source of
    // whichever copy of this file the process was started from.
    max_entry: probability(cfg.maxEntry),
    dry_run: cfg.dryRun,
  });

  // ---- preflight: the three ways a runner is misconfigured ----------------
  const [onchainOperator, onchainOwner, collateral, gas] = await Promise.all([
    publicClient.readContract({ ...vaultRead, functionName: "operator" }),
    publicClient.readContract({ ...vaultRead, functionName: "owner" }),
    publicClient.readContract({ ...vaultRead, functionName: "collateral" }),
    publicClient.getBalance({ address: account.address }),
  ]);

  if (onchainOperator.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `AGENT_OPERATOR_KEY is ${account.address}, but the vault's operator is ${onchainOperator}. ` +
        "Every trade would revert NotOperator(). Ask the vault owner to call setOperator, or run the key that owns that address.",
    );
  }
  if (onchainOwner.toLowerCase() === account.address.toLowerCase()) {
    // Not fatal — the vault still works — but the whole claim this project makes
    // is that the hot key cannot move money, and here it can.
    log("warn", "preflight", {
      note: "the operator key is ALSO the vault owner, so it can deposit and withdraw. Use a separate throwaway key.",
    });
  }
  if (gas === 0n) {
    log("warn", "preflight", { note: "the operator address holds 0 STT — every trade will fail to pay for gas." });
  }
  log("info", "preflight", {
    operator_ok: true,
    collateral,
    gas_stt: formatUnits(gas, 18),
  });

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  /** Cumulative commitment per market, so one contract cannot absorb the vault. */
  const spentByMarket = new Map<string, bigint>();
  const lastTradeAt = new Map<string, number>();
  const startedAt = Date.now();
  let ordersSent = 0;
  let ordersFilled = 0;
  let cashSpent = 0n;
  /** Said once, not once per poll — a misconfiguration is not news at 4/minute. */
  let operatorMismatchLogged = false;

  while (!stopping) {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      const [nav, unaccounted, sessionOpen, sessionEnd, blockNumber] = await Promise.all([
        publicClient.readContract({ ...vaultRead, functionName: "nav" }),
        publicClient.readContract({ ...vaultRead, functionName: "unaccounted" }),
        publicClient.readContract({ ...vaultRead, functionName: "sessionOpen" }),
        publicClient.readContract({ ...vaultRead, functionName: "sessionEnd" }),
        publicClient.getBlockNumber(),
      ]);

      // The heartbeat carries a NAV sample with it. The route stamps its own
      // clock and ignores this body today — deliberately, so a runner with a
      // wrong clock cannot pin itself as alive — but the runner is already at
      // chain head every poll, and a mid-session NAV point is the one thing the
      // curve is otherwise missing between open and settle. It costs one JSON
      // object to send and a `recordNavPoint` call to start using.
      const ack = await report(cfg, "/heartbeat", {
        at: now,
        nav: nav.toString(),
        unaccounted: unaccounted.toString(),
        blockNumber: blockNumber.toString(),
        sessionOpen,
      });

      // The route answers with the operator the agent was REGISTERED under.
      // The preflight already proved this key is the vault's operator; this
      // catches the other half — a runner heartbeating one agent's row while
      // trading a different agent's vault.
      const registered = ack !== null && typeof ack.operatorAddress === "string" ? ack.operatorAddress : null;
      if (registered !== null && registered.toLowerCase() !== account.address.toLowerCase() && !operatorMismatchLogged) {
        operatorMismatchLogged = true;
        log("warn", "api", {
          note: `agent ${cfg.slug} is registered to operator ${registered}, but this runner signs as ${account.address}`,
        });
      }

      const endsIn = Number(sessionEnd) - nowSec;
      if (!sessionOpen) {
        log("info", "idle", { reason: "no open vault session", nav: money(nav, COLLATERAL_DECIMALS) });
        await sleep(cfg.pollMs);
        continue;
      }
      if (endsIn <= cfg.minRunwaySec) {
        log("info", "idle", { reason: "session closing", ends_in_s: endsIn, nav: money(nav, COLLATERAL_DECIMALS) });
        await sleep(cfg.pollMs);
        continue;
      }

      const budget = nav > cfg.minCash ? nav - cfg.minCash : 0n;
      if (budget === 0n) {
        log("info", "idle", { reason: "nav at the cash floor", nav: money(nav, COLLATERAL_DECIMALS), floor: money(cfg.minCash, COLLATERAL_DECIMALS) });
        await sleep(cfg.pollMs);
        continue;
      }

      // The page has to hold both kinds. One BOTNAV session contract mints per
      // open vault session, and they sort by expiry alongside Somnia's series,
      // so at 40 a fleet of 25 agents would push the price contracts this
      // runner actually trades off the end of the listing and it would go idle
      // against a full board. The listing is one indexer query either way.
      const live = await exchange.client.listLiveBinaryMarkets({ limit: LISTING_LIMIT });
      const candidates = live.filter((m) =>
        tradableForSession(m, {
          assets: cfg.assets,
          collateral,
          sessionEndSec: Number(sessionEnd),
          nowSec,
          minRunwaySec: cfg.minRunwaySec,
        }),
      );

      log("info", "scan", {
        live: live.length,
        tradable: candidates.length,
        nav: money(nav, COLLATERAL_DECIMALS),
        budget: money(budget, COLLATERAL_DECIMALS),
        session_ends_in_s: endsIn,
      });

      // A rolling series mints a fresh contract every cadence, so a long run
      // accumulates dead history. Pruned by staleness rather than by "absent
      // from this poll", so one short indexer page cannot erase a live trend.
      const staleBefore = now - cfg.lookbackSec * 3_000;
      for (const [id, samples] of history) {
        const newest = samples[samples.length - 1];
        if (newest === undefined || newest.at < staleBefore) history.delete(id);
      }

      // Read every candidate's book, then act on the strongest signal — one
      // order per poll. Picking the best beats taking the first, and a single
      // order per poll keeps the operator key's nonce strictly serial.
      interface Move {
        market: BinaryMarket;
        signal: Signal;
        order: Order;
        /** Wire units — see {@link WIRE}. */
        p: bigint;
        one: bigint;
      }
      let best: Move | null = null;

      for (const market of candidates) {
        const pool = market.poolAddress as Address;
        const one = 10n ** BigInt(market.quoteDecimals);
        const [book, grid] = await Promise.all([
          exchange.client.getBinaryOrderBook(pool, { depth: 5, decimals: market.quoteDecimals }),
          exchange.client.getBinaryBookParams(pool),
        ]);

        const raw = impliedProbability(book, market);
        if (raw === null) continue;
        const p = toWire(raw, one);
        // Sampled before the cooldown and budget gates on purpose: a contract
        // this poll may not trade is still a contract whose trend has to be
        // unbroken by the time it may.
        const samples = remember(market.id, p, now, cfg.lookbackSec);

        const cooldownLeft = cfg.cooldownMs - (now - (lastTradeAt.get(market.id) ?? -cfg.cooldownMs));
        if (cooldownLeft > 0) continue;

        const committed = spentByMarket.get(market.id) ?? 0n;
        const room = cfg.maxPerMarket > committed ? cfg.maxPerMarket - committed : 0n;
        if (room === 0n) continue;

        const secondsToExpiry = Number(market.expiry) - nowSec;
        const signal =
          cfg.strategy === "momentum"
            ? momentum(samples, p, now, cfg)
            : meanReversion(p, secondsToExpiry, cfg);
        if (signal === null) continue;

        const allowance = budget < cfg.maxOrder ? budget : cfg.maxOrder;
        const order = sizeOrder(signal.kind, book, grid, one, allowance < room ? allowance : room, cfg);
        if (order === null) {
          log("info", "skip", {
            market: symbolOf(market),
            reason: "nothing fillable inside the limit",
            p: probability(p),
          });
          continue;
        }

        if (best === null || signal.edge > best.signal.edge) {
          best = { market, signal, order, p, one };
        }
      }

      if (best === null) {
        log("info", "hold", { reason: "no signal", strategy: cfg.strategy, watched: candidates.length });
        await sleep(cfg.pollMs);
        continue;
      }

      const { market, signal, order, p, one } = best;
      log("info", "signal", {
        market: symbolOf(market),
        strategy: cfg.strategy,
        p: probability(p),
        rule: signal.why,
        side: order.side,
        price: probability(toWire(order.price, one)),
        qty: money(order.quantity, market.quoteDecimals),
        cost: money(order.cost, market.quoteDecimals),
      });

      if (cfg.dryRun) {
        log("info", "dry-run", { market: symbolOf(market), note: "AGENT_DRY_RUN is set — no transaction sent" });
        await sleep(cfg.pollMs);
        continue;
      }

      // The order expires with the contract it is written on. The pool enforces
      // `0 < expireNs <= marketExpiryNs`; anything later reverts OrderExpiryBeyondMarket.
      const expireNs = BigInt(market.expiry) * NS_PER_SEC;

      try {
        // The cooldown starts at the ATTEMPT, not at the receipt. An order that
        // reverts is exactly the one not to retry four times a minute, and the
        // first draft only recorded successes — so a market that rejected an
        // order would have been re-sent on every poll until it expired.
        lastTradeAt.set(market.id, Date.now());

        const hash = await wallet.writeContract({
          address: cfg.vault,
          abi: vaultAbi,
          functionName: "trade",
          args: [market.marketId, order.kind, order.price, order.quantity, expireNs, ORDER_TYPE_IOC],
        });
        log("info", "sent", { market: symbolOf(market), side: order.side, tx: hash });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        ordersSent += 1;

        // `Traded.cashDelta` is the vault's own measurement of what the order
        // cost: the collateral balance before and after the pool call, folded
        // into protocolCash. It is the only number that knows what actually
        // filled — an IOC can take one level, all of them, or none.
        // Filtered to the vault: the same receipt carries the pool's own logs,
        // and a `Traded` on another contract is not this vault's measurement.
        const vaultLogs = receipt.logs.filter((entry) => entry.address.toLowerCase() === cfg.vault);
        const traded = parseEventLogs({ abi: vaultAbi, eventName: "Traded", logs: vaultLogs })[0];
        const cashDelta = traded?.args.cashDelta ?? null;
        const filled = cashDelta !== null && cashDelta !== 0n;
        const spend = cashDelta !== null && cashDelta < 0n ? -cashDelta : 0n;
        if (filled) {
          ordersFilled += 1;
          cashSpent += spend;
          spentByMarket.set(market.id, (spentByMarket.get(market.id) ?? 0n) + spend);
        }

        log(filled ? "info" : "warn", filled ? "filled" : "nofill", {
          market: symbolOf(market),
          side: order.side,
          cash_delta: cashDelta === null ? null : money(cashDelta, market.quoteDecimals),
          gas_used: receipt.gasUsed,
          tx: hash,
        });

        const trade: TradeReport = {
          marketId: market.marketId,
          symbol: symbolOf(market),
          kind: order.kind,
          price: Number(toWire(order.price, one)),
          quantity: order.quantity.toString(),
          cashDelta: cashDelta === null ? null : cashDelta.toString(),
          txHash: hash,
          at: Date.now(),
        };
        await report(cfg, "/trades", trade);
      } catch (e) {
        const reason = describeFailure(e);
        const noFill = reason === NO_FILL;
        log(noFill ? "warn" : "error", noFill ? "nofill" : "trade", {
          market: symbolOf(market),
          side: order.side,
          price: order.price,
          qty: order.quantity,
          reason,
        });
      }
    } catch (e) {
      // One bad poll — an indexer hiccup, an RPC timeout — is not a reason to
      // stop being the agent. The next poll re-reads everything from chain head.
      log("error", "poll", { reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }

    if (!stopping) await sleep(cfg.pollMs);
  }

  log("info", "stopped", {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    orders_sent: ordersSent,
    orders_filled: ordersFilled,
    cash_deployed: money(cashSpent, COLLATERAL_DECIMALS),
  });

  await exchange.close();
  // The SDK holds a WebSocket for chain reads; closing it releases the handle,
  // and exiting explicitly means a stuck socket cannot turn ctrl-c into a hang
  // in the middle of a demo.
  process.exit(0);
}

/**
 * Running this file starts the daemon; importing it does not.
 *
 * The price and quantity arithmetic above is the part that has to be right
 * *before* an order costs money, and it is pure — a book, a grid and a budget
 * in, an order out. The guard is what lets it be exercised against a real
 * order book, or a hand-built one, without a key, a vault or a session.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((e: unknown) => {
    log("error", "fatal", { reason: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
