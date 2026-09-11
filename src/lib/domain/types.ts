/**
 * Meta-Agent DEX domain model.
 *
 * These types are the *application's* vocabulary. Nothing outside
 * `src/lib/dreamdex/` may import DreamDEX SDK types directly — the adapter
 * translates the SDK's raw, bigint-exact shapes into these human-unit structs
 * (PRD §11.3 `marketAdapter`, §12 "Maintainability").
 */

/** Which side of an Event Contract a position takes. */
export type Outcome = "up" | "down";

/**
 * Lifecycle of a DreamDEX binary market, narrowed to what the UI must
 * distinguish. Mirrors `BinaryMarketStatus` from the SDK but collapses the
 * states that mean the same thing to a reader.
 */
export type MarketStatus =
  | "upcoming" // Listed, tradingStart in the future
  | "trading" // open for orders
  | "locked" // past expiry, awaiting oracle
  | "settling" // oracle answering
  | "resolved" // outcome known
  | "voided"; // no valid outcome; both sides refunded

/** A single aggregated price level, in human units. */
export interface BookLevel {
  /** Probability price in [0,1] — the cost of one outcome token. */
  price: number;
  /** Outcome-token quantity. */
  quantity: number;
}

/**
 * Where {@link ArenaMarket.upProbability} came from, and therefore what it is
 * entitled to claim.
 *
 * A binary book bounds fair value from both ends: best bid ≤ fair ≤ best ask.
 * With BOTH sides resting, the midpoint is a genuine implied probability. With
 * only one side, all the book has said is which end of that inequality it
 * holds — `fair ∈ [bid, 1]` or `fair ∈ [0, ask]` — which is a BOUND, not a
 * probability, and a screen that prints it as "Up 14% / 86% Down" has asserted
 * a split nobody quoted. Measured on the live board: 6 of 8 cards did exactly
 * that.
 *
 * So the basis rides with the number. Anything rendering `upProbability` must
 * read this first and say which of the five things it is showing.
 */
export type PriceBasis =
  /** Both sides rest; the figure is their midpoint. The only true implied probability. */
  | "mid"
  /** Only a bid rests; the figure IS that bid, and fair value is at or above it. */
  | "bid"
  /** Only an ask rests; the figure IS that ask, and fair value is at or below it. */
  | "ask"
  /** Nothing rests; the figure is the last print, which is a past trade and not a quote. */
  | "last"
  /** The contract resolved; the figure is the outcome itself, not anything a book said. */
  | "settled"
  /** Nothing to show. `upProbability` is null. */
  | "none";

/**
 * An Event Contract as Meta-Agent DEX presents it.
 *
 * `upProbability` is what the book says about the contract's condition, and
 * {@link ArenaMarket.priceBasis} says in what sense it says it. Down is always
 * `1 - up` — the same book, inverted (PRD §8.2 FR-013) — which means the
 * inversion of a bound is a bound the other way: `P(Up) ≥ 0.14` is exactly
 * `P(Down) ≤ 0.86`, and neither is "86% Down".
 */
/**
 * Somnia's own price series, or one of this project's NAV session contracts.
 * Derived from the market's `asset`: every meta-market is minted with
 * {@link META_ASSET} and nothing on Somnia's series uses that ticker.
 */
export type MarketVenue = "somnia" | "meta";

/** The asset ticker every BOTNAV session contract is minted under. */
export const META_ASSET = "BOTNAV";

/** True for a session contract this project minted, false for a Somnia one. */
export function venueOf(asset: string): MarketVenue {
  return asset.toUpperCase() === META_ASSET ? "meta" : "somnia";
}

export interface ArenaMarket {
  /** bytes32 marketId, lowercased. Stable across pool recycling. */
  id: string;
  /** The BinaryPool address currently serving this market. */
  poolAddress: string;
  /** Human symbol, e.g. `BTC-1h-0901T12`. */
  symbol: string;
  asset: string;
  question: string;
  status: MarketStatus;
  /** Unix seconds. */
  tradingStart: number;
  /** Unix seconds. Trading ends and the outcome is decided. */
  expiry: number;
  /** Series cadence label, e.g. "15m" | "1h" | "4h" | "24h". */
  interval: string | null;
  /**
   * P(Up) in [0,1] as far as the book goes, or null when nothing does.
   *
   * READ {@link priceBasis} BEFORE PRINTING IT. Only `basis === "mid"` makes
   * this an implied probability; `"bid"` and `"ask"` make it one END of the
   * range fair value is known to lie in, and `"last"` makes it a print from the
   * past.
   */
  upProbability: number | null;
  /** How `upProbability` was arrived at. Never inferred at the render site. */
  priceBasis: PriceBasis;
  /** Best resting bid/ask in YES (Up) terms, [0,1]; null when that side is empty. */
  bestBid: number | null;
  bestAsk: number | null;
  /** bestAsk - bestBid, null unless both sides rest. */
  spread: number | null;
  /**
   * True when at least one side of the book carries a resting order.
   *
   * A state, not a size, and named so it cannot be printed as one. A market
   * arrives here from a batched top-of-book read, which sees the best bid and
   * the best ask and nothing behind them — there is no quantity in it to round,
   * total or suffix with "contracts". Resting size is a separate chain read of
   * the pool's own levels; `readBookDepth` in `@/lib/dreamdex/depth` is the only
   * thing entitled to produce one.
   *
   * This field was `bookDepth: number`, set to 1 or 0, and rendered as
   * "1 contracts" over a book holding 182.5.
   */
  quoted: boolean;
  /** Winning outcome once resolved. */
  resolvedOutcome: Outcome | null;
  resolvedAt: number | null;
  /** Collateral token decimals — every human/raw conversion uses this. */
  quoteDecimals: number;
  collateral: string;
  /** True when the market is quotable *right now* (status + a live book). */
  tradable: boolean;

  /**
   * Who put this contract on chain.
   *
   * `"somnia"` — a DreamDEX price contract, minted by Somnia's own rolling
   * series. These are the contracts the agents trade.
   *
   * `"meta"` — a BOTNAV session contract, minted by this project against one
   * agent's NAV. It is a declaration and an audit record, not part of the
   * trading board, and it is reached from the agent it belongs to.
   *
   * The two arrive in the same `listLiveBinaryMarkets` page because they live
   * on the same binary module, so anything that means "the market the agents
   * trade" has to say so rather than assume the listing only holds one kind.
   */
  venue: MarketVenue;

  /**
   * True when this contract was generated by the local simulation and does not
   * exist on Somnia. Anything rendering a market must label it.
   *
   * Optional, and deliberately not defaulted: an adapter used directly (the live
   * one in tests) legitimately sets nothing. Every market the *app* serves comes
   * through `getAdapter()` and carries an explicit boolean, so absence means
   * "nobody said", never "it is real".
   */
  simulated?: boolean;

  /**
   * The pool's order grid, in RAW units, carried as decimal strings because a
   * market crosses the API boundary as JSON and a bigint does not survive it.
   * Convert at the edges.
   *
   * The pool rejects any price off `tickSize` and any quantity off `lotSize` or
   * below `minQuantity` — so no agent may send an order without them, and the
   * contract panel prints them for whoever is writing one. They are optional
   * because a market still *lists* and still quotes when the grid read fails;
   * the page then says the grid was not read rather than printing a plausible
   * default (PRD §17).
   */
  tickSize?: string;
  lotSize?: string;
  minQuantity?: string;
}

/** Four-sided book: Up (YES) and Down (NO) are the same book, inverted. */
export interface ArenaOrderBook {
  marketId: string;
  upBids: BookLevel[];
  upAsks: BookLevel[];
  downBids: BookLevel[];
  downAsks: BookLevel[];
  /** When this snapshot was taken (ms) — drives the "live/stale" indicator. */
  capturedAt: number;
  /** Same meaning as on {@link ArenaMarket}: these levels were generated. */
  simulated?: boolean;
}

// ---------------------------------------------------------------------------
// Meta-Agent DEX
//
// An agent trades real DreamDEX Event Contracts through a BotVault it does not
// control the keys to; a session is the window a second-layer market is written
// against. NAV is always the vault's `protocolCash` — collateral delivered by a
// DreamDEX call — and never a token balance, because the Shannon collateral has
// a permissionless faucet and a balance is therefore forgeable by anyone.
// ---------------------------------------------------------------------------

/** How the agent claims to decide. Declared at registration, hashed on chain. */
export type AgentStrategy = "momentum" | "mean-reversion" | "market-making" | "custom";

export interface Agent {
  id: string;
  name: string;
  slug: string;
  /** Developer wallet, proved by an EIP-191 signature rather than a header. */
  ownerAddress: string;
  /** The BotVault. Holds the capital and owns every position. */
  vaultAddress: string;
  /** The runner's hot key. May only call `trade`; can never move funds. */
  operatorAddress: string;
  strategy: AgentStrategy;
  strategyParams: Record<string, number | string>;
  /** keccak of the declared strategy, written into the meta-market's context. */
  configHash: string;
  repoUrl: string | null;
  blurb: string | null;
  createdAt: number;
  lastHeartbeat: number | null;
}

export type AgentSessionStatus =
  /** Vault session opened, meta-market not minted yet. */
  | "pending"
  /** Meta-market is live and taking bets; the agent is trading. */
  | "open"
  /** Past close: redeeming positions, freezing the oracle. */
  | "closing"
  /** Oracle frozen — outcomeValue is final and the committee can read it. */
  | "finalized"
  /** DreamDEX resolved the meta-market. */
  | "settled"
  /** The committee could not agree; both sides refunded. */
  | "void";

export interface AgentSession {
  id: string;
  agentId: string;
  /** The vault's own session counter, so chain and index agree. */
  sessionNumber: number;
  /** One BotNavOracle per session; its answer can never be restated. */
  oracleAddress: string;
  /** The second-layer DreamDEX market people bet on. */
  metaMarketId: string | null;
  metaPoolAddress: string | null;
  opensAt: number;
  closesAt: number;
  /** Raw 6-decimal collateral units, as strings — these are chain numbers. */
  navT0: string | null;
  navT1: string | null;
  /**
   * What the oracle returned: 1 = YES (navT1 > navT0), 2 = NO. 0 is "no
   * answer", never valid.
   *
   * The encoding is `BotNavOracle.OUTCOME_YES = 1` — read the contract, not
   * this comment, if they ever disagree again. It read 1 = NO here until the
   * mapping was checked against `finalize()`, and everything downstream that
   * trusted the comment scored a losing session as a win.
   */
  outcomeValue: 1 | 2 | null;
  /** What DreamDEX settled to, once the committee has voted. */
  resolvedOutcome: 0 | 1 | null;
  voided: boolean;
  status: AgentSessionStatus;
  openTx: string | null;
  mintTx: string | null;
  finalizeTx: string | null;
  createdAt: number;
}

/**
 * A live read of the vault behind a session, as the screens receive it.
 *
 * THE FIELD IS CALLED `cash` AND NOT `nav` ON PURPOSE. It is `BotVault.nav()`,
 * but `nav()` returns `protocolCash` — collateral sitting in the vault right
 * now — and mid-session that is only part of what the vault is worth: an agent
 * that has spent 90 tUSDC on outcome tokens reads 90 lower here while holding
 * every one of those positions. Nothing converts back until `redeemAll()` runs
 * at close. A field named `nav` would be printed under a "NAV" label by the
 * next person to touch a card, and the reader would see a catastrophic loss
 * that never happened; a field named `cash` cannot be mislabelled by accident.
 *
 * The settled figure — the one the meta-market pays on — is
 * `AgentSession.navT1`, and it exists only after the session closes.
 */
export interface SessionVaultState {
  /** Raw 6dp `nav()` at read time. Cash only while the session is open. */
  cash: string;
  /**
   * Raw 6dp `unaccounted()`: tokens held that no DreamDEX call delivered. The
   * collateral's faucet is permissionless, so a stranger can push 10,000 tUSDC
   * in here; it is reported so the exclusion can be checked rather than
   * believed, and it can never reach NAV.
   */
  unaccounted: string;
  /**
   * `touchedCount()`: the length of the vault's REDEEM LIST, not a tally for
   * this session.
   *
   * `openSession()` compacts that list rather than clearing it
   * (contracts/BotVault.sol:150-168) — an entry survives into the next session
   * whenever the vault still holds either outcome token in it, so `redeemAll()`
   * can still reach the position. That is deliberate: clearing the list once
   * stranded 17.22 tUSDC in a resolved market the vault could no longer redeem.
   *
   * So the count can include carryover from earlier sessions, and an entry can
   * also be a market this session traded and has already redeemed, because
   * entries are dropped at the NEXT open and not on redemption. Anything
   * printing it must name the list, never "markets traded this session".
   */
  touchedCount: number;
  /**
   * The height the read was pinned to, or null when the node served it from
   * `latest` without one. It is what turns "read from the vault on this
   * request" from a promise into something a stranger can repeat.
   */
  blockNumber: string | null;
  /**
   * Raw 6dp collateral the vault's held WINNING legs would return if redeemed
   * now, or null when it was not read.
   *
   * NOT part of NAV and never added to `cash` by anything downstream. `nav()`
   * is `protocolCash` and that is what the meta-market settles on; this exists
   * because a card printing only `cash` mid-session lets a reader conclude that
   * every unit an agent deployed was lost. It counts only markets the indexer
   * calls finalized, unvoided and decided — see {@link RedeemableReadout} — so
   * it is a floor, and `unpricedTouched` says how many entries it had to pass
   * over. Null is "not measured" and must never render as 0.00.
   */
  redeemable: string | null;
  /**
   * Touched-list entries `redeemable` could not price: unresolved, voided, or
   * not in the index yet. Carried so a screen can say the figure is partial
   * rather than quietly presenting a floor as a total.
   */
  unpricedTouched: number | null;
}

/**
 * A whole-vault read that is not tied to any session.
 *
 * {@link SessionVaultState} is only ever attached to a session the vault agrees
 * it is still on. A board also has to show agents that are *between* sessions,
 * and for those there is no session to check the reading against — so this
 * carries what the vault said about itself instead, and the screen labels the
 * figure accordingly: mid-session `cash` is cash alone, between sessions it is
 * the whole of NAV.
 */
export interface AgentVaultReading extends SessionVaultState {
  /** True when the vault is mid-session, so `cash` excludes held positions. */
  sessionOpen: boolean;
  /** The vault's own session counter at the moment of the read. */
  sessionNumber: number;
}

/** OrderKind on a binary pool. */
export type AgentTradeKind = 0 | 1 | 2 | 3; // BUY_YES · SELL_YES · BUY_NO · SELL_NO

export interface AgentTrade {
  id: string;
  sessionId: string;
  agentId: string;
  marketId: string;
  symbol: string | null;
  kind: AgentTradeKind;
  /** Wire price, 6dp probability units. */
  price: number;
  quantity: string;
  /** Signed change in the vault's protocolCash, measured on chain. */
  cashDelta: string | null;
  txHash: string;
  at: number;
}

export interface AgentNavPoint {
  id: string;
  agentId: string;
  sessionId: string | null;
  nav: string;
  /** Collateral held that no DreamDEX call delivered. Never part of NAV. */
  unaccounted: string | null;
  blockNumber: string | null;
  at: number;
}

/** A row on the agent leaderboard. */
export interface AgentStanding {
  agent: Agent;
  sessionsRun: number;
  sessionsWon: number;
  /** Fraction in [0,1]; null until the agent has finished a session. */
  winRate: number | null;
  /** Net protocolCash change across finalized sessions, raw 6dp. */
  netPnl: string;
  /**
   * The most recent `nav()` SAMPLE for this agent — the newest row in
   * `agent_nav_points` — and never a live read.
   *
   * It was called `currentNav`, and it is not current. Samples are written at
   * exactly two moments, agent registration and session close, so between them
   * this figure ages without any bound at all. Measured on the live board: the
   * leaderboard printed "NAV now 206.12" from a row written 92.9 minutes
   * earlier while a panel 400px above it showed the live read of the same
   * `nav()` as 10.00 — one quantity, two values, one screen.
   *
   * So it is named for what it is, and it arrives with the two facts that make
   * it readable. Anything rendering it must print its age beside it or read the
   * vault itself; a bare figure under a "now" label is the bug.
   */
  lastNav: string | null;
  /** When that sample was taken, ms. Null exactly when `lastNav` is null. */
  lastNavAt: number | null;
  /** The height it was read at, when the sampler recorded one. */
  lastNavBlock: string | null;
  liveSession: AgentSession | null;
}
