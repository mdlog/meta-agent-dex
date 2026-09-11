/**
 * Turn chain and SDK failures into something a reader can act on.
 *
 * FR-045: "Error revert ditampilkan dalam bahasa yang dapat dipahami … Pengguna
 * mendapatkan next step tanpa melihat stack trace mentah." Every message below
 * therefore names a cause *and* a next step.
 */

export type ErrorCategory =
  | "wrong_network"
  | "user_rejected"
  | "insufficient_balance"
  | "insufficient_allowance"
  | "market_not_trading"
  | "order_expiry"
  | "price_precision"
  | "quantity_precision"
  | "no_liquidity"
  | "indexer_unavailable"
  | "rpc_unavailable"
  | "unknown";

export interface TranslatedError {
  category: ErrorCategory;
  /** One line the user reads. */
  message: string;
  /** What to do about it. */
  nextStep: string;
  /** Original text, kept for the telemetry log — never rendered raw. */
  raw: string;
}

/**
 * Contract reverts the BinaryPool raises, mapped to plain language. Matched on
 * the revert *name* the SDK surfaces in `ContractRevertError`.
 *
 * Every name here except the two marked below was checked against the SDK's
 * `contractErrorsAbi` — the generated table it decodes revert data with. A name
 * that is not in that table can never fire, and its absence used to hide the
 * ones that do: the pool's quantity and price gates are what a mis-sized order
 * actually trips.
 *
 * Order matters: the match is a substring test, so the longer, more specific
 * name has to come first (`ERC20InsufficientBalance` contains
 * `InsufficientBalance`).
 */
const REVERTS: Record<string, Omit<TranslatedError, "raw">> = {
  // -- quantity grid: the gates a stake-sized order trips first ---------------
  QuantityNotAlignedToLotSize: {
    category: "quantity_precision",
    message: "That size is not a whole multiple of this pool's lot.",
    nextStep: "The ticket sizes orders on the pool's lot grid. Reopen it and review the ticket again.",
  },
  QuantityBelowMinimum: {
    category: "quantity_precision",
    message: "The stake buys less than the smallest order this pool accepts.",
    nextStep: "Raise the stake. The ticket shows the smallest one that clears the pool's minimum.",
  },
  InvalidQuantity: {
    category: "quantity_precision",
    message: "The pool rejected that size — it is off the lot grid or under the minimum.",
    nextStep: "Reopen the ticket so it re-sizes against the live book, then sign again.",
  },
  // -- price grid ------------------------------------------------------------
  PriceNotAlignedToTickSize: {
    category: "price_precision",
    message: "That limit price is off the market's price grid.",
    nextStep: "The ticket snaps the limit to the pool's tick. Reopen it and review again.",
  },
  PriceOutOfBounds: {
    category: "price_precision",
    message: "That limit price sits outside what a probability can be.",
    nextStep: "A binary contract prices between 0 and 1. Reopen the ticket for a fresh quote.",
  },
  InvalidPrice: {
    category: "price_precision",
    message: "That limit price is off the market's price grid.",
    nextStep: "Nudge the price by one tick. The ticket snaps to a valid value.",
  },
  // -- nothing crossed -------------------------------------------------------
  ImmediateOrCancelNoFill: {
    category: "no_liquidity",
    message: "Nothing crossed your limit, so the order was cancelled.",
    nextStep: "No collateral moved. The book moved away between the quote and the block — retry for a fresh price.",
  },
  FillOrKillNotFillable: {
    category: "no_liquidity",
    message: "The book could not fill the whole order at once.",
    nextStep: "No collateral moved. Lower the stake, or use immediate-or-cancel to take what rests.",
  },
  // -- market state ----------------------------------------------------------
  TradingNotActive: {
    category: "market_not_trading",
    message: "This Event Contract is no longer accepting orders.",
    nextStep: "It has locked for settlement. Choose a live market from Explore.",
  },
  MarketRestricted: {
    category: "market_not_trading",
    message: "This Event Contract is restricted and will not take your order.",
    nextStep: "Pick another contract from Explore.",
  },
  OrderExpiryBeyondMarket: {
    category: "order_expiry",
    message: "The order would outlive the contract it trades.",
    nextStep: "Meta-Agent DEX caps order expiry at the market's own expiry. Reload the market and try again.",
  },
  OrderAlreadyExpired: {
    category: "order_expiry",
    message: "This Event Contract expired while the ticket was open.",
    nextStep: "Pick the next contract in the series. Expiry moves every interval.",
  },
  // -- collateral ------------------------------------------------------------
  ERC20InsufficientAllowance: {
    category: "insufficient_allowance",
    message: "The pool is not yet approved to escrow your collateral.",
    nextStep: "Approve the token when your wallet asks. It is a one-off per pool.",
  },
  ERC20InsufficientBalance: {
    category: "insufficient_balance",
    message: "Not enough testnet collateral for this stake.",
    nextStep: "Lower the stake, or claim test USDC from the faucet on the ticket.",
  },
  InsufficientBalance: {
    category: "insufficient_balance",
    message: "Not enough testnet collateral for this stake.",
    nextStep: "Lower the stake, or top up test USDC from the faucet.",
  },
  // -- not contract errors ---------------------------------------------------
  // `MarketNotTrading` is Meta-Agent DEX's own wording for the refusal
  // `assertTradable` raises before anything is signed; it is kept here so both
  // spellings of that condition reach the same explanation.
  MarketNotTrading: {
    category: "market_not_trading",
    message: "This Event Contract is no longer accepting orders.",
    nextStep: "It has locked for settlement. Choose a live market from Explore.",
  },
};

/** Substring probes for wallet / transport failures that carry no revert name. */
const PATTERNS: Array<[RegExp, Omit<TranslatedError, "raw">]> = [
  [
    /user rejected|user denied|4001/i,
    {
      category: "user_rejected",
      message: "You declined the signature.",
      nextStep: "Nothing was sent and no collateral moved. Sign again when ready.",
    },
  ],
  [
    /chain (mismatch|not )|unsupported chain|wrong network|switch/i,
    {
      category: "wrong_network",
      message: "Your wallet is on a different network.",
      nextStep: "Switch to Somnia Shannon testnet (chain 50312) to trade Event Contracts.",
    },
  ],
  [
    /insufficient (funds|balance)|exceeds balance/i,
    {
      category: "insufficient_balance",
      message: "Not enough testnet balance for this order.",
      nextStep: "Lower the stake, or claim test collateral from the faucet.",
    },
  ],
  [
    /allowance|approve/i,
    {
      category: "insufficient_allowance",
      message: "The pool is not yet approved to escrow your collateral.",
      nextStep: "Approve the token when your wallet asks. It is a one-off per pool.",
    },
  ],
  [
    /indexer .* failed|Hasura|graphql/i,
    {
      category: "indexer_unavailable",
      message: "The DreamDEX indexer did not answer.",
      nextStep: "Market data may be a few blocks stale. Retry in a moment.",
    },
  ],
  [
    /websocket|ws |rpc|timeout|aborted|fetch failed|ENOTFOUND|ECONNREFUSED/i,
    {
      category: "rpc_unavailable",
      message: "Could not reach the Somnia testnet RPC.",
      nextStep: "Check your connection. Meta-Agent DEX will keep retrying in the background.",
    },
  ],
];

export function translateError(error: unknown): TranslatedError {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  for (const [name, mapped] of Object.entries(REVERTS)) {
    if (raw.includes(name)) return { ...mapped, raw };
  }
  for (const [pattern, mapped] of PATTERNS) {
    if (pattern.test(raw)) return { ...mapped, raw };
  }

  return {
    category: "unknown",
    message: "The order could not be completed.",
    nextStep: "Nothing was charged. Retry, or pick another market if this repeats.",
    raw,
  };
}
