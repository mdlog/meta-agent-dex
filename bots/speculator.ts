/**
 * Meta-Agent DEX — the speculator agent.
 *
 * `runner.ts` is the FIRST layer: an agent trading DreamDEX Event Contracts out
 * of a `BotVault`, being measured. This is the SECOND: an agent taking YES/NO
 * positions on the meta-markets that ask whether one of those sessions closes
 * with a higher NAV than it opened. Same SDK, same headless shape, same one-line
 * log — and no human anywhere in the path. That is the point of the file: with
 * it, every transaction in this application is signed by an agent through the
 * NPM SDK.
 *
 * Three things about it differ from the runner, and each one is a consequence of
 * what a speculator IS rather than a style choice:
 *
 *  - IT HOLDS ITS OWN FUNDED EOA. There is no vault, because a speculator is not
 *    being measured; it is doing the measuring. `AGENT_SPECULATOR_KEY` signs
 *    directly through `client.createTrader({ privateKey })`, and the collateral
 *    it escrows is its own. Nothing here reads a key the web app can see.
 *  - IT MAY REST AN ORDER. The runner is IOC-only because `BotVault` exposes
 *    `trade` and no `cancelOrder`, so a resting order could never be pulled back.
 *    This process signs for itself and can cancel, and it MUST be able to rest:
 *    a meta-market's book starts empty, and an order that only ever crosses can
 *    never be the first quote on one. A LIMIT order fills whatever it crosses
 *    and rests the remainder, which is exactly the behaviour that lets two
 *    speculators with opposing theses meet in the middle and put a price on a
 *    market nobody has priced yet. Every order also expires with the meta-market
 *    it is written on, so an unfilled quote clears itself at session close.
 *  - IT MINTS ITS OWN STAKE, AND SAYS SO. The collateral has a permissionless,
 *    cooldown-free `faucet(uint256)`. When this process is short it calls it, and
 *    logs a `faucet` line at WARN — because minting your own stake is precisely
 *    the thing this project proved a NAV oracle must not count. `BotVault.nav()`
 *    excludes it by construction (a 10,000 tUSDC top-up moved a vault's NAV by
 *    exactly zero); a speculator's balance is not NAV and is not scored, so the
 *    faucet is legitimate here and noisy on purpose.
 *
 * Settlement of the market this bets on is DEFINED by `BotNavOracle` and
 * ATTESTED by DreamDEX's oracle committee reading `outcomeValue()` through six
 * JSON sources and one contract source. This file only takes a side and, after
 * the committee has voted, redeems — a winning outcome token is worthless until
 * it is redeemed.
 *
 * Run it:  node --experimental-strip-types bots/speculator.ts   (see bots/README.md)
 *
 * Nothing is imported from `runner.ts` or from `src/`. The app's modules resolve
 * through the `@/` path alias that node cannot follow without a loader, and a
 * relative `./runner.ts` import needs `allowImportingTsExtensions`, which this
 * repo does not set — so the handful of shared pure helpers are restated here
 * and this file runs anywhere it is copied to, exactly like its sibling.
 */

import {
  BaseError,
  createPublicClient,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { makeSender, type Sender } from "./send.ts";
import {
  ContractRevertError,
  SomniaMarkets,
  SomniaMarketsError,
  SOMNIA_TESTNET_ADDRESSES,
  type BinaryBookParams,
  type BinaryOrderBook,
  type MarketOnchain,
  type Trader,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/**
 * `MarketStatus` on a BinaryMarket: 0 Listed · 1 Trading · 2 Locked ·
 * 3 Settling · 4 Resolved · 5 Voided. Only 1 accepts an order.
 */
const STATUS_TRADING = 1;
const STATUS_NAMES = ["Listed", "Trading", "Locked", "Settling", "Resolved", "Voided"] as const;

/**
 * `OrderType`: 0 LIMIT (fills what crosses, rests the remainder) · 1 FOK ·
 * 2 IOC · 3 POST_ONLY. LIMIT is the one that can open an empty book — see the
 * header. The remainder is not orphaned: it expires with the meta-market.
 */
const ORDER_TYPE_LIMIT = 0;

/** The pool takes order expiry in NANOseconds; every other clock here is ms or s. */
const NS_PER_SEC = 1_000_000_000n;

/**
 * Decimals of the meta-markets' collateral — 6dp tUSDC on Shannon. Used only to
 * print balances and stakes; every per-market amount is formatted with that
 * market's own `decimals` instead.
 */
const COLLATERAL_DECIMALS = 6;

/**
 * The scale the thesis knobs and the log lines speak: 6-decimal probability
 * units, so 620_000 is 0.62.
 *
 * A pool's own prices are in its collateral's units. For these markets those are
 * the same six decimals — every meta-market is minted against 6dp tUSDC — but
 * the conversion is written out anyway, because "they happen to match" is not a
 * thing to bake into the arithmetic that decides what an order pays.
 */
const WIRE = 1_000_000n;

/** How far a probability may be pushed by evidence. Nothing here is certain. */
const P_FLOOR = 50_000n; // 0.05
const P_CEIL = 950_000n; // 0.95

/** A raw money column as the app's JSON carries it: a plain decimal integer. */
const RAW_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** A pool price, in that pool's collateral scale, as wire probability units. */
export function toWire(price: bigint, one: bigint): bigint {
  return (price * WIRE) / one;
}

/** A wire probability as a price in the pool's own collateral scale. */
export function fromWire(wirePrice: bigint, one: bigint): bigint {
  return (wirePrice * one) / WIRE;
}

// ---------------------------------------------------------------------------
// Logging — one line per action, logfmt. Identical shape to runner.ts, so one
// terminal can tail both layers and the columns still line up.
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

/** Display only. Every number that reaches the chain stays a bigint. */
function money(rawAmount: bigint, decimals: number): string {
  return formatUnits(rawAmount, decimals);
}

/** A wire price as the probability it means, for the log. Display only. */
function probability(wirePrice: bigint): string {
  return (Number((wirePrice * 1000n) / WIRE) / 1000).toFixed(3);
}

/** A signed wire fraction as a percentage, e.g. `-9.9%`. Display only. */
function percent(wireFraction: bigint): string {
  const pct = Number((wireFraction * 1000n) / WIRE) / 10;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Thesis = "backer" | "skeptic" | "contrarian";

export interface Config {
  speculatorKey: Hex;
  thesis: Thesis;
  api: string;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  collateral: Address;
  pollMs: number;
  /** Most collateral ONE order may escrow. Raw 6dp, so 20_000_000 = 20 tUSDC. */
  maxStake: bigint;
  /** Total this process will commit to any one meta-market across a run. */
  maxPerMarket: bigint;
  /** Faucet when the balance falls below this — the stake has to come from somewhere. */
  minBalance: bigint;
  faucetAmount: bigint;
  cooldownMs: number;
  /** A meta-market closing sooner than this cannot repay the gas of an opinion. */
  minRunwaySec: number;
  /** Minimum gap between this agent's view and the price it will accept. */
  edge: bigint;
  /** Refuse to pay more than this per contract, either leg. */
  maxEntry: bigint;
  /**
   * How much relative cash drawdown counts as "still holding up" at the END of a
   * session, wire fraction. Widened earlier in the session by {@link drawdownGate},
   * because mid-session cash is depressed by DEPLOYMENT, not only by loss.
   */
  drawdownBand: bigint;
  /** How hard a relative cash move tilts the probability. */
  cashSensitivity: bigint;
  /** Most settled meta-markets to sweep for redemption per poll. */
  redeemBatch: number;
  /**
   * Stop opening positions, keep closing them.
   *
   * Killing this process outright is not the way to retire the layer: an
   * outcome token is worthless until it is redeemed, so a speculator with legs
   * on markets that have not settled yet strands that collateral for good. With
   * this set it still polls, still sweeps settled markets back into cash, and
   * refuses every entry — so it walks itself flat and can then be stopped with
   * nothing left behind.
   */
  windDown: boolean;
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
      `${name} must be a raw 6-decimal integer — 20000000 for 20 tUSDC, 900000 for a price of 0.90 (got ${value}).`,
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
    "AGENT_SPECULATOR_KEY",
    "Generate a throwaway key and fund it with STT for gas — it signs its own orders and holds its own collateral.",
  );
  if (!PRIVATE_KEY.test(key)) {
    throw new Error("AGENT_SPECULATOR_KEY must be a 32-byte hex private key.");
  }

  const thesis = env("AGENT_THESIS") ?? "backer";
  if (thesis !== "backer" && thesis !== "skeptic" && thesis !== "contrarian") {
    throw new Error(`AGENT_THESIS must be "backer", "skeptic" or "contrarian" (got "${thesis}").`);
  }

  const collateral =
    env("AGENT_COLLATERAL") ??
    SOMNIA_TESTNET_ADDRESSES.collateral ??
    SOMNIA_TESTNET_ADDRESSES.testUsdc ??
    "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
  if (!ADDRESS.test(collateral)) throw new Error("AGENT_COLLATERAL must be a 20-byte hex address.");

  const maxEntry = envRaw("AGENT_MAX_ENTRY", 900_000n);
  if (maxEntry <= 0n || maxEntry >= WIRE) {
    throw new Error("AGENT_MAX_ENTRY is a price in 6dp probability units, strictly between 0 and 1000000.");
  }

  const edge = envRaw("AGENT_EDGE", 30_000n);
  if (edge <= 0n || edge >= WIRE / 2n) {
    throw new Error("AGENT_EDGE is a probability gap in 6dp units, strictly between 0 and 500000.");
  }

  const maxStake = envRaw("AGENT_MAX_STAKE", 20_000_000n);
  if (maxStake <= 0n) throw new Error("AGENT_MAX_STAKE must be greater than zero.");

  return {
    speculatorKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    thesis,
    // 3009, the port this app actually serves on. It defaulted to 3971, which
    // nothing in this repo has ever listened on, so every heartbeat and trade
    // report from a runner started without AGENT_API went to a closed socket.
    api: (env("AGENT_API") ?? "http://localhost:3009").replace(/\/+$/, ""),
    rpcUrl: env("SOMNIA_RPC_URL") ?? "https://dream-rpc.somnia.network",
    wsRpcUrl: env("SOMNIA_WS_RPC_URL") ?? "wss://api.infra.testnet.somnia.network/ws",
    indexerUrl: env("SOMNIA_INDEXER_URL") ?? "https://dev.smk.somnia.host/v1/graphql",
    collateral: collateral.toLowerCase() as Address,
    // A meta-market moves on the pace of a whole vault session, not on a spot
    // tick, so polling faster than this only spends the indexer's budget.
    pollMs: envInt("AGENT_POLL_MS", 20_000, 3_000),
    maxStake,
    maxPerMarket: envRaw("AGENT_MAX_PER_MARKET", 60_000_000n),
    minBalance: envRaw("AGENT_MIN_BALANCE", 50_000_000n),
    faucetAmount: envRaw("AGENT_FAUCET_AMOUNT", 10_000_000_000n),
    cooldownMs: envInt("AGENT_COOLDOWN_MS", 120_000, 0),
    minRunwaySec: envInt("AGENT_MIN_RUNWAY_SEC", 120, 0),
    edge,
    maxEntry,
    drawdownBand: envRaw("AGENT_DRAWDOWN_BAND", 50_000n),
    cashSensitivity: BigInt(envInt("AGENT_CASH_SENSITIVITY", 5, 1)),
    redeemBatch: envInt("AGENT_REDEEM_BATCH", 4, 0),
    windDown: envFlag("AGENT_WIND_DOWN"),
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

export function clamp(value: bigint, low: bigint, high: bigint): bigint {
  if (value < low) return low;
  return value > high ? high : value;
}

/**
 * What this meta-market's own book thinks the chance of "NAV rose" is, in wire
 * units — the mid of a two-sided book, else the last fill, else nothing.
 *
 * Nothing, not 0.50. A market that has never quoted has no opinion, and reading
 * one as even would invent the exact number the contrarian thesis is supposed to
 * be fading. Every meta-market starts here, which is why this returns `null` far
 * more often on this layer than it does on the first one.
 */
export function bookPrice(book: BinaryOrderBook, lastPrice: bigint | null, one: bigint): bigint | null {
  const bid = book.yesBids[0]?.price;
  const ask = book.yesAsks[0]?.price;
  if (bid !== undefined && ask !== undefined) return toWire((bid + ask) / 2n, one);
  if (lastPrice !== null) return toWire(lastPrice, one);
  return null;
}

/** A crossed book is not a price, it is a bug or a race. Never quote against one. */
export function bookIsCrossed(book: BinaryOrderBook): boolean {
  const bid = book.yesBids[0]?.price;
  const ask = book.yesAsks[0]?.price;
  return bid !== undefined && ask !== undefined && bid >= ask;
}

// ---------------------------------------------------------------------------
// The view. Evidence in, one probability out — and a sentence saying which
// piece of evidence carried it.
// ---------------------------------------------------------------------------

/** An agent's finished sessions, as the arena settled them. */
export interface AgentRecord {
  wins: number;
  losses: number;
}

export interface Evidence {
  /** Cash the vault held when the session opened — `navT0`, raw 6dp. */
  navT0: bigint;
  /** `BotVault.nav()` right now. CASH, not NAV, while the session is open. */
  cash: bigint;
  /** Markets this session has traded in — where the cash went. */
  touched: number;
  opensAt: number;
  closesAt: number;
  now: number;
  record: AgentRecord;
}

export interface View {
  /** Wire probability that this session closes with a higher NAV than it opened. */
  fair: bigint;
  /** The agent's finished-session record, as a probability. */
  recordP: bigint;
  /** Cash now against cash at open, as a signed wire fraction. -20000 = -2%. */
  cashRel: bigint;
  /** That same move read as a probability. */
  cashP: bigint;
  /** How far through the session, wire: 0 at open, 1000000 at close. */
  phase: bigint;
  /** The weight `cashRel` carries in `fair`. */
  weight: bigint;
  /** True when the vault has traded nothing at all this session. */
  idle: boolean;
  why: string;
}

/**
 * The agent's record as a probability, by the rule of succession: (w+1)/(n+2).
 *
 * Zero finished sessions gives exactly 0.50 — genuinely no information, and the
 * theses below are written so that 0.50 fires nothing. One win gives 0.67 rather
 * than 1.00, which is the whole reason for the +1/+2: a single session is not a
 * record, and an agent that has won once should not be priced as a certainty.
 */
export function recordProbability(rec: AgentRecord): bigint {
  const n = BigInt(rec.wins + rec.losses);
  return ((BigInt(rec.wins) + 1n) * WIRE) / (n + 2n);
}

/**
 * Form a view of one open session from evidence that is actually on the card.
 *
 * The load-bearing subtlety is what `cash` means mid-session. It is
 * `BotVault.nav()`, which is `protocolCash` — collateral sitting in the vault
 * right now — so an agent that has spent 90 tUSDC on outcome tokens reads 90
 * LOWER while still holding every one of those positions. Nothing converts back
 * until `redeemAll()` runs at close. So:
 *
 *  - EARLY in a session, cash-versus-open is mostly a measure of DEPLOYMENT, and
 *    a position taken then is a bet on the strategy — which is what the agent's
 *    finished-session record is evidence about.
 *  - LATE in a session, positions are expiring and redeeming back into cash, so
 *    cash-versus-open converges on the answer the oracle is about to freeze.
 *
 * That is the whole blend: `weight` is `phase²`, so cash carries a quarter of the
 * view at the halfway mark and four fifths of it at 90%. Squared rather than
 * linear because the first half of a session is when deployment is heaviest and
 * the cash reading is least honest.
 *
 * One piece of evidence overrides the blend, because it is not a probability but
 * a fact: a session that has touched NO markets cannot have moved NAV. `nav()`
 * counts only collateral a DreamDEX call delivered, and `finalize()` writes
 * `navT1 > navT0 ? YES : NO` — strictly greater. An agent that never traded
 * settles NO, and the later it is with nothing traded, the less that is a lull
 * and the more it is the result.
 */
export function formView(ev: Evidence, cfg: Config): View {
  const span = BigInt(Math.max(1, ev.closesAt - ev.opensAt));
  const phase = clamp((BigInt(Math.max(0, ev.now - ev.opensAt)) * WIRE) / span, 0n, WIRE);

  const recordP = recordProbability(ev.record);
  const cashRel = ev.navT0 > 0n ? ((ev.cash - ev.navT0) * WIRE) / ev.navT0 : 0n;
  const cashP = clamp(WIRE / 2n + cashRel * cfg.cashSensitivity, P_FLOOR, P_CEIL);
  const weight = (phase * phase) / WIRE;

  const idle = ev.touched === 0;
  if (idle) {
    // Decays from 0.50 at open to the floor at close: at 10% through, an untraded
    // vault is a vault whose runner has not woken up yet; at 90%, it is a vault
    // that is going to settle exactly where it started.
    const fair = clamp(WIRE / 2n - (phase * (WIRE / 2n)) / WIRE, P_FLOOR, WIRE / 2n);
    return {
      fair,
      recordP,
      cashRel,
      cashP,
      phase,
      weight,
      idle,
      why: `no markets touched, ${probability(phase)} through — NAV cannot rise without a DreamDEX call`,
    };
  }

  const fair = clamp(((WIRE - weight) * recordP + weight * cashP) / WIRE, P_FLOOR, P_CEIL);
  // `weight` is literally the fraction of the view cash carries, so the sentence
  // quotes it rather than asserting a vaguer "mostly" that could be wrong.
  const why =
    weight < WIRE / 2n
      ? `record ${ev.record.wins}/${ev.record.wins + ev.record.losses}, ${probability(phase)} through, ` +
        `${ev.touched} markets touched — cash is still deployment, so this prices the strategy ` +
        `(cash weight ${probability(weight)})`
      : `cash ${percent(cashRel)} vs open, ${probability(phase)} through, ` +
        `${ev.touched} markets touched — positions are closing, so cash carries ` +
        `${probability(weight)} of this view`;

  return { fair, recordP, cashRel, cashP, phase, weight, idle, why };
}

// ---------------------------------------------------------------------------
// The three theses. Each states a claim, each can be wrong, and each refuses
// with the clause that failed. None of them consults a random number.
// ---------------------------------------------------------------------------

export interface Intent {
  side: "BUY_YES" | "BUY_NO";
  /**
   * The limit as a YES price in wire units — what `placeBinaryOrder` takes for
   * BOTH legs. For a YES buy it is a ceiling on what we pay. For a NO buy it is
   * a FLOOR, because a NO costs `1 − yesPrice`: the higher the YES price we
   * accept, the cheaper the NO we are buying.
   */
  limitYes: bigint;
  /** How far past its threshold the thesis fired — used to rank markets. */
  edge: bigint;
  why: string;
}

/** A stated reason not to trade. A speculator that always trades is a coin. */
export interface Refusal {
  reason: string;
}

export type Decision = Intent | Refusal;

/** Generic over the success shape, so the same guard reads a decision or a sized order. */
export function isRefusal<T extends object>(d: T | Refusal): d is Refusal {
  return "reason" in d;
}

/**
 * How much relative drawdown still counts as "holding up", at this point in the
 * session.
 *
 * The gate carries exactly the weight the cash term carries in `fair`. Early,
 * when a cash reading is mostly deployment, it is effectively no gate at all —
 * refusing an agent for spending its collateral on the positions it exists to
 * take would refuse every agent that is actually working. Late, when positions
 * have redeemed back into cash, it tightens onto `AGENT_DRAWDOWN_BAND`, which is
 * the point at which a drawdown really is a drawdown.
 */
export function drawdownGate(view: View, cfg: Config): bigint {
  if (view.weight === 0n) return WIRE;
  return clamp((cfg.drawdownBand * WIRE) / view.weight, cfg.drawdownBand, WIRE);
}

/**
 * `backer` — buys YES on agents whose cash is holding up and whose finished
 * sessions won.
 *
 * The claim is that a strategy that has been profitable keeps being profitable
 * over one more session, and that an agent whose cash has not fallen apart
 * mid-session is on track. It is wrong exactly when a winning record was luck,
 * or when the last hour of a session gives it all back — which is why it refuses
 * on a losing record and on a drawdown past the band rather than talking itself
 * into either.
 *
 * The band is not a fixed number — see {@link drawdownGate}. A mid-session cash
 * reading is depressed by open positions, so requiring cash to be flat would
 * refuse every agent that is actually working; the gate widens early and closes
 * onto `AGENT_DRAWDOWN_BAND` as the session ends and positions redeem back.
 */
export function backer(view: View, cfg: Config): Decision {
  if (view.recordP < WIRE / 2n) {
    return { reason: `record is losing (${probability(view.recordP)}) — a backer has nothing to back` };
  }
  const gate = drawdownGate(view, cfg);
  if (view.cashRel < -gate) {
    return { reason: `cash ${percent(view.cashRel)} vs open, past the ${percent(-gate)} this session is worth tolerating` };
  }
  if (view.fair < WIRE / 2n + cfg.edge) {
    return { reason: `view ${probability(view.fair)} is not above 0.5 by ${probability(cfg.edge)}` };
  }
  return {
    side: "BUY_YES",
    // Never pay more than the view minus the edge: the edge is the margin this
    // thesis demands for being wrong, not a rounding allowance.
    limitYes: view.fair - cfg.edge,
    edge: view.fair - WIRE / 2n,
    why: view.why,
  };
}

/**
 * `skeptic` — buys NO on agents that are down on the session or have a losing
 * record.
 *
 * The mirror claim, and not merely the negation of `backer`: it fires on EITHER
 * a losing record OR a drawdown past the band, so it will take the other side of
 * an agent with a good record that is currently bleeding, which is the position
 * a backer refuses to hold. It is wrong when a drawdown is deployment rather
 * than loss — the same ambiguity, priced from the other end.
 */
export function skeptic(view: View, cfg: Config): Decision {
  const losingRecord = view.recordP < WIRE / 2n;
  const drawdown = view.cashRel < -drawdownGate(view, cfg);
  if (!losingRecord && !drawdown && !view.idle) {
    return {
      reason: `record ${probability(view.recordP)} is not losing and cash ${percent(view.cashRel)} is holding — nothing to doubt`,
    };
  }
  if (view.fair > WIRE / 2n - cfg.edge) {
    return { reason: `view ${probability(view.fair)} is not below 0.5 by ${probability(cfg.edge)}` };
  }
  // Paying at most `(1 − fair) − edge` for the NO leg is a YES-price FLOOR of
  // `fair + edge`; see {@link Intent.limitYes}.
  return {
    side: "BUY_NO",
    limitYes: view.fair + cfg.edge,
    edge: WIRE / 2n - view.fair,
    why: view.why,
  };
}

/**
 * `contrarian` — fades the book, against the agent's own record.
 *
 * Its reference is `recordP` alone, deliberately: it is not forming an
 * independent view of this session, it is asking whether the price the other
 * speculators have put on this agent is consistent with what that agent has
 * actually done. When the book is cheaper than the record justifies it buys YES;
 * when it is dearer it buys NO.
 *
 * It is the only one of the three that REQUIRES a book, and therefore the only
 * one that cannot open an empty market — by construction it is the second agent
 * into any meta-market, and it is the one that stops a lone backer or skeptic
 * from marking its own price.
 */
export function contrarian(view: View, market: bigint | null, cfg: Config): Decision {
  if (market === null) {
    return { reason: "the book has never quoted — a contrarian has nothing to fade" };
  }
  const gap = view.recordP - market;
  if (gap >= cfg.edge) {
    return {
      side: "BUY_YES",
      limitYes: view.recordP - cfg.edge,
      edge: gap,
      why: `book ${probability(market)} under the record's ${probability(view.recordP)} — YES is cheap`,
    };
  }
  if (-gap >= cfg.edge) {
    return {
      side: "BUY_NO",
      limitYes: view.recordP + cfg.edge,
      edge: -gap,
      why: `book ${probability(market)} over the record's ${probability(view.recordP)} — NO is cheap`,
    };
  }
  return {
    reason: `book ${probability(market)} already agrees with the record ${probability(view.recordP)}`,
  };
}

export function decide(thesis: Thesis, view: View, market: bigint | null, cfg: Config): Decision {
  if (thesis === "backer") return backer(view, cfg);
  if (thesis === "skeptic") return skeptic(view, cfg);
  return contrarian(view, market, cfg);
}

// ---------------------------------------------------------------------------
// Order construction
// ---------------------------------------------------------------------------

export interface Order {
  side: "BUY_YES" | "BUY_NO";
  /** Always the YES price, both legs, in the POOL's collateral scale. */
  price: bigint;
  quantity: bigint;
  /** Collateral the pool will escrow, ceil-rounded exactly as the pool rounds it. */
  cost: bigint;
}

/**
 * Turn an intent into an order the pool will accept, or say why it cannot.
 *
 * Unlike the runner's sizing this does NOT bound the quantity by the resting
 * depth: an order that outsizes the book fills what it crosses and rests the
 * remainder, and that remainder is the quote the opposing thesis needs to find.
 * The stake is bounded by the budget instead, which is the honest limit — how
 * much this agent is willing to be wrong by.
 *
 * The two alignments go in opposite directions and both go toward safety: a YES
 * limit rounds DOWN (pay no more than intended), a NO limit rounds its YES price
 * UP (accept fewer bids, so the NO stays at least as cheap as intended).
 */
export function sizeOrder(
  intent: Intent,
  grid: BinaryBookParams,
  one: bigint,
  /** Spendable collateral for THIS order, in the pool's collateral units. */
  budget: bigint,
  cfg: Config,
): Order | Refusal {
  const tick = grid.tickSize;
  const raw = fromWire(intent.limitYes, one);
  const price = clamp(
    intent.side === "BUY_YES" ? alignDown(raw, tick) : alignUp(raw, tick),
    tick,
    one - tick,
  );

  const perUnit = intent.side === "BUY_YES" ? price : one - price;
  if (perUnit <= 0n) return { reason: "the limit leaves nothing to pay per contract" };

  const perUnitWire = toWire(perUnit, one);
  if (perUnitWire > cfg.maxEntry) {
    return {
      reason: `${probability(perUnitWire)} per contract is above AGENT_MAX_ENTRY ${probability(cfg.maxEntry)}`,
    };
  }

  // The smallest order this pool accepts. If even that costs more than the stake
  // cap, there is no order to place — and saying so is more useful than sizing
  // one and watching it revert QuantityBelowMinimum.
  const floorCost = (grid.minQuantity * perUnit + one - 1n) / one;
  if (floorCost > cfg.maxStake) {
    return {
      reason:
        `the pool's minimum lot costs ${money(floorCost, COLLATERAL_DECIMALS)}, ` +
        `above AGENT_MAX_STAKE ${money(cfg.maxStake, COLLATERAL_DECIMALS)}`,
    };
  }
  if (floorCost > budget) {
    return {
      reason:
        `the pool's minimum lot costs ${money(floorCost, COLLATERAL_DECIMALS)}, ` +
        `above the ${money(budget, COLLATERAL_DECIMALS)} this poll has to stake here`,
    };
  }

  const quantity = alignDown((budget * one) / perUnit, grid.lotSize);
  if (quantity < grid.minQuantity || quantity === 0n) {
    return { reason: "the budget does not reach the pool's minimum lot once aligned" };
  }

  return {
    side: intent.side,
    price,
    quantity,
    // The pool ceil-rounds the escrow; matching it means the budget check never
    // authorises one unit less than the pool is about to pull.
    cost: (quantity * perUnit + one - 1n) / one,
  };
}

// ---------------------------------------------------------------------------
// The app's API — the only place meta-markets come from
// ---------------------------------------------------------------------------

/**
 * One open meta-market, flattened out of a `/api/agents/sessions` card.
 *
 * The card carries three things this agent cannot get anywhere else: which
 * DreamDEX market belongs to which vault session, the vault's `navT0` (the
 * figure the oracle will compare against, frozen at open and not readable from
 * the pool), and a live vault read. Everything else — status, grid, book,
 * settlement — is read from chain.
 */
export interface Candidate {
  sessionId: string;
  label: string;
  agentId: string;
  metaMarketId: Hex;
  metaPool: Address;
  opensAt: number;
  closesAt: number;
  navT0: bigint;
  cash: bigint;
  unaccounted: bigint;
  touched: number;
}

/** A finished session: a record entry, and possibly a position to redeem. */
export interface Finished {
  agentId: string;
  label: string;
  metaMarketId: Hex | null;
  /** 1 = YES (NAV rose), 2 = NO. `BotNavOracle.OUTCOME_YES` is 1; read the contract, not this line. */
  outcomeValue: 1 | 2 | null;
  voided: boolean;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Money arrives as a decimal string because that is what it is on chain. */
function asRaw(value: unknown): bigint | null {
  const text = asString(value);
  return text !== null && RAW_INTEGER.test(text) ? BigInt(text) : null;
}

export interface Board {
  open: Candidate[];
  finished: Finished[];
  /**
   * Open cards that arrived without a usable live vault read.
   *
   * `liveVaultBySession` is deadlined and failure-tolerant, so a slow RPC gives
   * the route a `vault: null` on a session that is genuinely open and taking
   * positions. There is no evidence to form a view from, so the card is dropped
   * — but it is COUNTED, because "three sessions I could not read" and "no
   * sessions" are different states and only one of them is a quiet arena.
   */
  blind: number;
  /**
   * The SERVER's clock, shipped with the body.
   *
   * Every session on that page is a countdown, and the route sends its own now
   * for exactly this reason: a process whose clock is a few minutes fast would
   * otherwise compute a phase past 1.0 and refuse markets that are still taking
   * positions. Falls back to the local clock only if the field is missing.
   */
  now: number;
}

function readCandidate(card: unknown): Candidate | null {
  if (!isRecordObject(card)) return null;
  const session = isRecordObject(card.session) ? card.session : null;
  const agent = isRecordObject(card.agent) ? card.agent : null;
  const vault = isRecordObject(card.vault) ? card.vault : null;
  if (session === null || agent === null || vault === null) return null;

  const metaMarketId = asString(session.metaMarketId);
  const metaPool = asString(session.metaPoolAddress);
  const sessionId = asString(session.id);
  const agentId = asString(agent.id);
  const opensAt = asNumber(session.opensAt);
  const closesAt = asNumber(session.closesAt);
  const navT0 = asRaw(session.navT0);
  const cash = asRaw(vault.cash);
  const touched = asNumber(vault.touchedCount);

  // A `pending` session has a vault open and an oracle armed but no market
  // minted — there is genuinely nothing to bet on, so it is dropped here rather
  // than refused later with a reason that would repeat every poll.
  if (metaMarketId === null || !BYTES32.test(metaMarketId)) return null;
  if (metaPool === null || !ADDRESS.test(metaPool)) return null;
  if (sessionId === null || agentId === null) return null;
  if (opensAt === null || closesAt === null || navT0 === null || cash === null || touched === null) return null;

  const slug = asString(agent.slug) ?? agentId;
  const sessionNumber = asNumber(session.sessionNumber);

  return {
    sessionId,
    label: `${slug}#${sessionNumber ?? "?"}`,
    agentId,
    metaMarketId: metaMarketId.toLowerCase() as Hex,
    metaPool: metaPool.toLowerCase() as Address,
    opensAt,
    closesAt,
    navT0,
    cash,
    unaccounted: asRaw(vault.unaccounted) ?? 0n,
    touched,
  };
}

function readFinished(card: unknown): Finished | null {
  if (!isRecordObject(card)) return null;
  const session = isRecordObject(card.session) ? card.session : null;
  const agent = isRecordObject(card.agent) ? card.agent : null;
  if (session === null || agent === null) return null;

  const agentId = asString(agent.id);
  if (agentId === null) return null;

  const metaMarketId = asString(session.metaMarketId);
  const outcome = asNumber(session.outcomeValue);
  const slug = asString(agent.slug) ?? agentId;
  const sessionNumber = asNumber(session.sessionNumber);

  return {
    agentId,
    label: `${slug}#${sessionNumber ?? "?"}`,
    metaMarketId: metaMarketId !== null && BYTES32.test(metaMarketId) ? (metaMarketId.toLowerCase() as Hex) : null,
    outcomeValue: outcome === 1 ? 1 : outcome === 2 ? 2 : null,
    voided: session.voided === true,
  };
}

/**
 * Read the board, or say why it could not be read.
 *
 * The runner treats a dead app as survivable, because the chain is what its
 * meta-market settles against and it can keep trading regardless. That reasoning
 * does NOT transfer here: this process learns which DreamDEX market belongs to
 * which vault session from this endpoint and nowhere else, so an unreachable app
 * means a poll with nothing to have an opinion about. It idles and says so.
 */
async function readBoard(cfg: Config): Promise<Board | null> {
  const url = `${cfg.api}/api/agents/sessions?limit=50`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecordObject(payload)) {
      log("warn", "api", { path: "/api/agents/sessions", status: res.status });
      return null;
    }
    const open = Array.isArray(payload.open) ? payload.open : [];
    const recent = Array.isArray(payload.recent) ? payload.recent : [];
    const candidates = open.map(readCandidate).filter((c): c is Candidate => c !== null);
    return {
      open: candidates,
      finished: recent.map(readFinished).filter((f): f is Finished => f !== null),
      blind: open.length - candidates.length,
      now: asNumber(payload.now) ?? Date.now(),
    };
  } catch (e) {
    log("warn", "api", { path: "/api/agents/sessions", note: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    return null;
  }
}

/**
 * Each agent's finished-session record.
 *
 * A voided session is skipped entirely — the committee declined to answer and
 * both sides were refunded, so counting it as either a win or a loss would put
 * a result on the leaderboard that nobody was paid for.
 */
export function records(finished: readonly Finished[]): Map<string, AgentRecord> {
  const out = new Map<string, AgentRecord>();
  for (const session of finished) {
    if (session.voided || session.outcomeValue === null) continue;
    const rec = out.get(session.agentId) ?? { wins: 0, losses: 0 };
    if (session.outcomeValue === 1) rec.wins += 1;
    else rec.losses += 1;
    out.set(session.agentId, rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * Name the revert if we can, and never lose the detail if we cannot.
 *
 * Shorter than the runner's equivalent because the SDK does the decoding: every
 * write here goes through `Trader`, which decodes a revert against the
 * protocol's custom-error ABIs and rethrows it as `ContractRevertError` with the
 * Solidity name already on it. The runner writes to `BotVault` through viem
 * directly, so it has to carry its own error ABI.
 */
function describeFailure(e: unknown): string {
  if (e instanceof ContractRevertError) {
    return e.errorName ?? e.reason ?? (e.data !== undefined ? `unknown revert ${e.data.slice(0, 10)}` : e.message);
  }
  if (e instanceof SomniaMarketsError) return e.message;
  if (e instanceof BaseError) return e.shortMessage;
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
    // waiting for. A submitted order is already the chain's problem, and an
    // unredeemed position stays redeemable forever — so exiting mid-poll costs
    // a log line and nothing else.
    log("warn", "shutdown", { signal, note: "forced" });
    process.exit(130);
  }
  stopping = true;
  log("info", "shutdown", { signal, note: "finishing this poll — ctrl-c again to force" });
  interruptSleep?.();
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/**
 * Redeem one settled meta-market, and report what came back.
 *
 * A winning outcome token is worthless until it is redeemed: the ERC-6909
 * balance is a claim on the settlement singleton, not collateral. Redemption is
 * module-routed in settlement-extraction v2 — the module pulls the winning
 * tokens, finalizes the market if nobody has yet, and pays out through
 * `BinarySettlement` — so this needs only the market id, the winning index and
 * an amount.
 *
 * `winningOutcome` is the outcome INDEX, not the oracle's answer: index 0 is the
 * Up/YES leg, because our questions register the intervals [(1,1),(2,2)] with
 * YES first, so answer 1 (NAV rose) lands in index 0. The two encodings are not
 * the same number and confusing them pays the wrong side.
 *
 * Recovery is measured as an ERC-20 balance delta around the call rather than
 * inferred from the position size, for the same reason the runner reads the
 * vault's own `Traded` event: the number that matters is the one the chain
 * actually moved.
 */
async function redeemSettled(
  sender: Sender,
  exchange: SomniaMarkets,
  trader: Trader,
  cfg: Config,
  me: Address,
  session: Finished,
  marketId: Hex,
): Promise<{ outcome: "redeemed" | "nothing" | "pending"; recovered: bigint }> {
  const chain = await exchange.client.getMarketOnchain(marketId);
  if (!chain.isResolved && !chain.isVoided) return { outcome: "pending", recovered: 0n };

  // A void pays both legs at par on complete sets, so both are worth pulling; a
  // resolution pays exactly one. Reading the losing leg on a resolved market
  // would burn tokens for nothing, so it is never in this list.
  const legs: Array<{ idx: 0 | 1; id: bigint; name: string }> = chain.isVoided
    ? [
        { idx: 0, id: chain.yesId, name: "YES" },
        { idx: 1, id: chain.noId, name: "NO" },
      ]
    : chain.winningOutcome === 0
      ? [{ idx: 0, id: chain.yesId, name: "YES" }]
      : [{ idx: 1, id: chain.noId, name: "NO" }];

  let redeemedAny = false;
  let recovered = 0n;
  for (const leg of legs) {
    const amount = await exchange.client.getOutcomeBalance({
      outcomeToken: chain.outcomeToken,
      account: me,
      id: leg.id,
    });
    if (amount === 0n) continue;

    if (cfg.dryRun) {
      log("info", "dry-run", {
        market: session.label,
        note: `AGENT_DRY_RUN is set — would redeem ${money(amount, chain.decimals)} ${leg.name}`,
      });
      redeemedAny = true;
      continue;
    }

    // The module pulls the winning tokens out of this key's ERC-6909 balance,
    // so it has to be an operator on the outcome token first. Without this every
    // redeem of a winning leg reverted, and the sweep below retried it forever.
    await sender.ensureOutcomeOperator({
      outcomeToken: chain.outcomeToken,
      operator: SOMNIA_TESTNET_ADDRESSES.binaryModule as Address,
    });

    const before = await exchange.client.getErc20Balance(cfg.collateral, me);
    const res = await sender.redeem({ module: SOMNIA_TESTNET_ADDRESSES.binaryModule as `0x${string}`, marketId: marketId as `0x${string}`, outcomeIdx: leg.idx as 0 | 1, amount });
    const after = await exchange.client.getErc20Balance(cfg.collateral, me);
    const gained = after > before ? after - before : 0n;

    redeemedAny = true;
    recovered += gained;
    log("info", "redeemed", {
      market: session.label,
      leg: leg.name,
      voided: chain.isVoided,
      burned: money(amount, chain.decimals),
      // Par is 1.0 per winning contract, so a recovery under the burn is the
      // settlement singleton's fee skim, not a short payout.
      recovered: money(gained, COLLATERAL_DECIMALS),
      tx: res.transactionHash,
    });
  }

  return { outcome: redeemedAny ? "redeemed" : "nothing", recovered };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const REDEEM_MAX_ATTEMPTS = 3;

async function main(): Promise<void> {
  const cfg = readConfig();
  const account = privateKeyToAccount(cfg.speculatorKey);

  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(cfg.rpcUrl) });
  const exchange = new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: somniaShannon,
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });
  // An explicit HTTP read client for allowance checks and receipts. The trader
  // would otherwise share the SDK's WebSocket for both signing and reading, and
  // a dropped socket would then take the reads down with the writes.
  const trader = exchange.client.createTrader({
    privateKey: cfg.speculatorKey,
    publicClient,
    decimals: COLLATERAL_DECIMALS,
  });
  /**
   * Writes go through `sender`, reads through `trader`/`exchange`. Measured, not
   * preferred: every SDK write against the public Shannon RPC comes back
   * "Missing or invalid parameters" while the identical viem call is mined. See
   * the header of ./send.ts and docs/DREAMDEX_SDK_FEEDBACK.md.
   */
  const sender = makeSender({ privateKey: cfg.speculatorKey, rpcUrl: cfg.rpcUrl });

  log("info", "boot", {
    thesis: cfg.thesis,
    speculator: account.address,
    api: cfg.api,
    chain: somniaShannon.id,
    collateral: cfg.collateral,
    poll_ms: cfg.pollMs,
    max_stake: money(cfg.maxStake, COLLATERAL_DECIMALS),
    edge: probability(cfg.edge),
    dry_run: cfg.dryRun,
    wind_down: cfg.windDown,
  });

  // ---- preflight: the two ways a speculator is dead on arrival -------------
  const [gas, balance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    exchange.client.getErc20Balance(cfg.collateral, account.address),
  ]);
  if (gas === 0n) {
    log("warn", "preflight", {
      note: "the speculator address holds 0 STT — every order and every redemption will fail to pay for gas.",
    });
  }
  log("info", "preflight", {
    gas_stt: formatUnits(gas, 18),
    balance: money(balance, COLLATERAL_DECIMALS),
    faucet_below: money(cfg.minBalance, COLLATERAL_DECIMALS),
  });

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  /** Cumulative stake per meta-market, so one session cannot absorb the balance. */
  const stakedByMarket = new Map<string, bigint>();
  const lastOrderAt = new Map<string, number>();
  /** Settled markets already swept clean. In memory: a restart re-checks them all. */
  const swept = new Set<string>();
  /** Attempts per market, so a transient failure gets a few tries and no more. */
  const redeemAttempts = new Map<string, number>();
  const startedAt = Date.now();
  let ordersSent = 0;
  let ordersFilled = 0;
  let staked = 0n;
  let recovered = 0n;
  let faucetCalls = 0;

  while (!stopping) {
    try {
      const board = await readBoard(cfg);
      if (board === null) {
        log("info", "idle", { reason: "the arena API did not answer — nothing to have an opinion about" });
        await sleep(cfg.pollMs);
        continue;
      }

      const now = board.now;
      const nowSec = Math.floor(now / 1000);
      const byAgent = records(board.finished);

      // ---- redeem first ---------------------------------------------------
      // Before staking anything new: a settled position is collateral this
      // process already owns and has not collected, and collecting it can be the
      // difference between affording the next order and calling the faucet for
      // stake it did not need.
      let sweptThisPoll = 0;
      for (const session of board.finished) {
        if (sweptThisPoll >= cfg.redeemBatch || stopping) break;
        const marketId = session.metaMarketId;
        if (marketId === null || swept.has(marketId)) continue;
        sweptThisPoll += 1;
        try {
          const sweep = await redeemSettled(
      sender,
      exchange, trader, cfg, account.address, session, marketId);
          if (sweep.outcome === "pending") continue; // the committee has not voted yet
          recovered += sweep.recovered;
          swept.add(marketId);
        } catch (e) {
          // `swept` used to be reached only on success, so a redeem that could
          // never succeed was retried once per poll for as long as the process
          // lived. A revert is deterministic — the next identical call returns
          // the identical revert — so give up on it and say so once. Anything
          // else (an RPC blip, a nonce race) is transient and gets a few tries.
          const reason = describeFailure(e);
          const deterministic = /revert|execution reverted|0x[0-9a-f]{8}/i.test(reason);
          const tries = (redeemAttempts.get(marketId) ?? 0) + 1;
          redeemAttempts.set(marketId, tries);

          if (deterministic || tries >= REDEEM_MAX_ATTEMPTS) {
            swept.add(marketId);
            log("warn", "redeem", {
              market: session.label,
              reason,
              gave_up_after: tries,
              note: deterministic
                ? "reverted — deterministic, so this market is not retried"
                : "retry budget spent — not retried",
            });
          } else {
            log("error", "redeem", { market: session.label, reason, attempt: tries });
          }
        }
      }

      // ---- stake ----------------------------------------------------------
      if (board.open.length === 0) {
        log("info", "idle", {
          reason:
            board.blind > 0
              ? "every open session came back without a live vault read — no evidence to price"
              : "no open meta-markets",
          blind: board.blind,
          finished_known: board.finished.length,
        });
        await sleep(cfg.pollMs);
        continue;
      }

      let cash = await exchange.client.getErc20Balance(cfg.collateral, account.address);
      if (cash < cfg.minBalance && cfg.dryRun) {
        // Said explicitly, because otherwise a dry run reads as a broken agent:
        // the balance stays at zero and every market refuses on budget.
        log("info", "dry-run", {
          balance: money(cash, COLLATERAL_DECIMALS),
          note: `AGENT_DRY_RUN is set — would faucet ${money(cfg.faucetAmount, COLLATERAL_DECIMALS)} before staking`,
        });
      }
      if (cash < cfg.minBalance && !cfg.dryRun) {
        // WARN, not info. This is the process minting the money it is about to
        // stake. It is legitimate — a speculator's balance is not NAV and is not
        // what any oracle reads — but it is exactly the move that must never be
        // silent in a project whose central claim is that a vault's NAV cannot
        // be topped up into a win.
        try {
          const res = await sender.faucet({ collateral: cfg.collateral, amount: cfg.faucetAmount });
          faucetCalls += 1;
          cash = await exchange.client.getErc20Balance(cfg.collateral, account.address);
          log("warn", "faucet", {
            minted: money(cfg.faucetAmount, COLLATERAL_DECIMALS),
            balance: money(cash, COLLATERAL_DECIMALS),
            note: "self-minted stake — permissionless faucet, and never counted by BotVault.nav()",
            tx: res.transactionHash,
          });
        } catch (e) {
          log("error", "faucet", { reason: describeFailure(e) });
        }
      }

      log("info", "scan", {
        thesis: cfg.thesis,
        open: board.open.length,
        blind: board.blind,
        balance: money(cash, COLLATERAL_DECIMALS),
        agents_with_record: byAgent.size,
      });

      interface Move {
        candidate: Candidate;
        view: View;
        intent: Intent;
        order: Order;
        chain: MarketOnchain;
        one: bigint;
      }
      let best: Move | null = null;

      for (const candidate of board.open) {
        const refuse = (reason: string): void => {
          log("warn", "refuse", { market: candidate.label, thesis: cfg.thesis, reason });
        };

        if (cfg.windDown) {
          refuse("AGENT_WIND_DOWN is set — this speculator only redeems now");
          continue;
        }

        const cooldownLeft = cfg.cooldownMs - (now - (lastOrderAt.get(candidate.metaMarketId) ?? -cfg.cooldownMs));
        if (cooldownLeft > 0) {
          refuse(`traded ${Math.round(cooldownLeft / 1000)}s inside the ${Math.round(cfg.cooldownMs / 1000)}s cooldown`);
          continue;
        }

        const closesIn = Math.floor(candidate.closesAt / 1000) - nowSec;
        if (closesIn < cfg.minRunwaySec) {
          refuse(`the session closes in ${closesIn}s, under the ${cfg.minRunwaySec}s that makes a position worth taking`);
          continue;
        }

        // Chain, not the indexer: `status` is derived from lifecycle events and
        // the Listed→Trading→Settling transitions emit none, so a freshly minted
        // meta-market can sit at Listed in the index while the pool is taking
        // orders. `getMarketOnchain` reads the market contract itself.
        const chain = await exchange.client.getMarketOnchain(candidate.metaMarketId);
        if (chain.status !== STATUS_TRADING) {
          refuse(`the market is ${STATUS_NAMES[chain.status] ?? `status ${chain.status}`}, not Trading`);
          continue;
        }

        const one = 10n ** BigInt(chain.decimals);
        const [book, grid, indexed] = await Promise.all([
          exchange.client.getBinaryOrderBook(candidate.metaPool, { depth: 5, decimals: chain.decimals }),
          exchange.client.getBinaryBookParams(candidate.metaPool),
          // Null means "not indexed yet" — a mint is on chain seconds before the
          // indexer sees it — and must never be read as "not trading".
          exchange.client.getBinaryMarket(candidate.metaMarketId).catch(() => null),
        ]);

        if (bookIsCrossed(book)) {
          refuse("the book is crossed — best bid is at or above best ask, so it has no price");
          continue;
        }

        const lastRaw = indexed?.lastPrice ?? null;
        const last = lastRaw !== null && RAW_INTEGER.test(lastRaw) ? BigInt(lastRaw) : null;
        const market = bookPrice(book, last, one);

        const view = formView(
          {
            navT0: candidate.navT0,
            cash: candidate.cash,
            touched: candidate.touched,
            opensAt: candidate.opensAt,
            closesAt: candidate.closesAt,
            now,
            record: byAgent.get(candidate.agentId) ?? { wins: 0, losses: 0 },
          },
          cfg,
        );

        log("info", "view", {
          market: candidate.label,
          fair: probability(view.fair),
          book: market === null ? "unquoted" : probability(market),
          record: probability(view.recordP),
          cash: money(candidate.cash, COLLATERAL_DECIMALS),
          open: money(candidate.navT0, COLLATERAL_DECIMALS),
          touched: candidate.touched,
          closes_in_s: closesIn,
          why: view.why,
        });

        const decision = decide(cfg.thesis, view, market, cfg);
        if (isRefusal(decision)) {
          refuse(decision.reason);
          continue;
        }

        const committed = stakedByMarket.get(candidate.metaMarketId) ?? 0n;
        const room = cfg.maxPerMarket > committed ? cfg.maxPerMarket - committed : 0n;
        if (room === 0n) {
          refuse(`already committed ${money(committed, COLLATERAL_DECIMALS)}, the AGENT_MAX_PER_MARKET cap`);
          continue;
        }

        const allowance = cash < cfg.maxStake ? cash : cfg.maxStake;
        const budget = allowance < room ? allowance : room;
        if (budget === 0n) {
          refuse(
            `nothing to stake — balance ${money(cash, COLLATERAL_DECIMALS)}, ` +
              `${money(committed, COLLATERAL_DECIMALS)} already committed of the ` +
              `${money(cfg.maxPerMarket, COLLATERAL_DECIMALS)} per-market cap`,
          );
          continue;
        }

        const sized = sizeOrder(decision, grid, one, budget, cfg);
        if (isRefusal(sized)) {
          refuse(sized.reason);
          continue;
        }

        if (best === null || decision.edge > best.intent.edge) {
          best = { candidate, view, intent: decision, order: sized, chain, one };
        }
      }

      if (best === null) {
        log("info", "hold", { reason: "no meta-market cleared the thesis", thesis: cfg.thesis, watched: board.open.length });
        await sleep(cfg.pollMs);
        continue;
      }

      const { candidate, intent, order, chain, one } = best;
      const perUnit = order.side === "BUY_YES" ? order.price : one - order.price;
      log("info", "intent", {
        market: candidate.label,
        thesis: cfg.thesis,
        side: order.side,
        yes_price: probability(toWire(order.price, one)),
        pay_per_contract: probability(toWire(perUnit, one)),
        qty: money(order.quantity, chain.decimals),
        stake: money(order.cost, COLLATERAL_DECIMALS),
        rule: intent.why,
      });

      if (cfg.dryRun) {
        log("info", "dry-run", { market: candidate.label, note: "AGENT_DRY_RUN is set — no transaction sent" });
        await sleep(cfg.pollMs);
        continue;
      }

      try {
        // The cooldown starts at the ATTEMPT, not at the receipt. An order that
        // reverts is exactly the one not to retry three times a minute.
        lastOrderAt.set(candidate.metaMarketId, Date.now());

        // The pool pulls collateral on a buy, so it must be allowed to.
        await sender.ensureApproval({ collateral: cfg.collateral, spender: candidate.metaPool, need: order.cost });

        const res = await sender.placeOrder({
          pool: candidate.metaPool,
          // The pool speaks OrderKind; the thesis speaks in sides.
          kind: order.side === "BUY_YES" ? 0 : 2,
          price: order.price,
          quantity: order.quantity,
          orderType: ORDER_TYPE_LIMIT,
          // Written out rather than left to the SDK's default, which is this same
          // value: an order on a meta-market must not outlive the session it is
          // an opinion about, and that rule deserves to be visible.
          expireTimestampNs: chain.expiry * NS_PER_SEC,
        });
        ordersSent += 1;

        const filled = res.filled;
        const resting = order.quantity - filled;
        if (filled > 0n) ordersFilled += 1;
        staked += order.cost;
        stakedByMarket.set(candidate.metaMarketId, (stakedByMarket.get(candidate.metaMarketId) ?? 0n) + order.cost);

        log("info", filled > 0n ? "filled" : "resting", {
          market: candidate.label,
          side: order.side,
          filled: money(filled, chain.decimals),
          // The remainder is not stranded: it expires with the meta-market, and
          // until then it is the quote the opposing thesis crosses.
          resting: money(resting, chain.decimals),
          gas_used: res.receipt.gasUsed,
          tx: res.receipt.transactionHash,
        });
      } catch (e) {
        log("error", "order", {
          market: candidate.label,
          side: order.side,
          price: order.price,
          qty: order.quantity,
          reason: describeFailure(e),
        });
      }
    } catch (e) {
      // One bad poll — an indexer hiccup, an RPC timeout — is not a reason to
      // stop being the agent. The next poll re-reads the board from scratch.
      log("error", "poll", { reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }

    if (!stopping) await sleep(cfg.pollMs);
  }

  log("info", "stopped", {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    thesis: cfg.thesis,
    orders_sent: ordersSent,
    orders_filled: ordersFilled,
    staked: money(staked, COLLATERAL_DECIMALS),
    recovered: money(recovered, COLLATERAL_DECIMALS),
    faucet_calls: faucetCalls,
  });

  await exchange.close();
  // The SDK holds a WebSocket for chain reads and for sending; closing it
  // releases the handle, and exiting explicitly means a stuck socket cannot turn
  // ctrl-c into a hang in the middle of a demo.
  process.exit(0);
}

/**
 * Running this file starts the daemon; importing it does not.
 *
 * Everything above the API section is pure — evidence in, a view out; a view in,
 * an intent out; an intent and a grid in, an order out — so the arithmetic that
 * has to be right *before* an order costs money can be exercised against a real
 * order book, or a hand-built one, without a key, a balance or an open session.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((e: unknown) => {
    log("error", "fatal", { reason: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
