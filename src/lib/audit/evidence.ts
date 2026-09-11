/**
 * The fixed on-chain trail: transactions mined on Somnia Shannon before the
 * demo, one row per claim this project makes.
 *
 * Transcribed from `docs/ONCHAIN_EVIDENCE.md`, which is the record of what was
 * measured. It lives as data rather than prose because `/audit` renders it as a
 * ledger and because a hash typed twice is a hash that will eventually differ
 * from itself. If the doc and this file ever disagree, the explorer settles it.
 *
 * Nothing here is derived, computed or refreshed. These are historical facts
 * with a block behind them; the *live* half of the audit page — everything this
 * deployment has done since — is read from the session journal instead.
 */

/**
 * Which of the four claims a row belongs to. Rendered as the ledger's first
 * column, in place of a timestamp: the doc records what was mined, not when,
 * and inventing a wall clock for it would be the one dishonest thing on a page
 * whose entire subject is honesty.
 */
export type EvidenceStage = "Control plane" | "Meta-market" | "Vault" | "Session";

/** The colour roles the theme gives an `.outcome` cell. */
export type EvidenceTone = "cyan" | "violet" | "lime" | "up" | "down" | "void";

export interface EvidenceRow {
  stage: EvidenceStage;
  /** The call, in the chain's own vocabulary. Doubles as the row's link text. */
  event: string;
  /** What it acted on — an address, a market, a NAV pair. */
  subject: string;
  /** Null only where no transaction exists; `note` then says why. */
  txHash: string | null;
  note?: string;
  /** What the transaction proved, short enough to read in a column. */
  result: string;
  tone: EvidenceTone;
}

/** Deployer and keeper. Every transaction below was sent from this address. */
export const KEEPER_ADDRESS = "0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE";

/** The operator and venue this project registered, so no third party can close it. */
export const OPERATOR_ID = 20;
export const VENUE_ID = "0xa3c034a0398f2cd3465cee88fec2489b78fe26933af4d394d6c87fc4cf00fa77";

/** The vault the faucet test was measured against (§4 of the evidence doc). */
export const TOPUP_VAULT = "0x8b25998ddd7107f660764a8f5a730bcc4ef9db03";

/** The vault that ran the full session, loss included (§5). */
export const SESSION_VAULT = "0x610736e132abbf36e94a198b74a3a6938b227593";

/**
 * The faucet reading, in the three numbers that make the point.
 *
 * Somnia's collateral has a permissionless `faucet(uint256)` with no cooldown,
 * so anyone can push 10,000 tUSDC into any address for the price of gas. A
 * balance-based NAV oracle would be forgeable by a stranger; this one is not.
 */
export const TOPUP_READING: readonly { call: string; value: string }[] = [
  { call: "balanceOf(vault)", value: "10,197.91" },
  { call: "nav()", value: "197.91" },
  { call: "unaccounted()", value: "10,000.00" },
];

export const EVIDENCE: readonly EvidenceRow[] = [
  {
    stage: "Control plane",
    event: "registerOperator",
    subject: "OracleHub",
    txHash: "0x716c2c447d8f997de78ae11cdd96ca70e65cb2ced8da2405f2d53b2cf11623c3",
    result: `operatorId ${OPERATOR_ID}`,
    tone: "cyan",
  },
  {
    stage: "Control plane",
    event: "createVenue",
    subject: "policy and signer both zero",
    txHash: "0xc2c2b236c39a56157a353425f2464a3dc39a47021fcd5446dee5367d12027da7",
    result: "venue 0xa3c0…fa77",
    tone: "cyan",
  },
  {
    stage: "Meta-market",
    event: "deploy BotNavOracle",
    subject: "one oracle per session, write-once",
    txHash: "0x94969a691199fed4c33883d82b86fc88992fd1cd4aee2a252eca9a19081fd61b",
    result: "0xa2ca…2229",
    tone: "cyan",
  },
  {
    stage: "Meta-market",
    event: "scheduleAndCreateMarket",
    subject: "asset BOTNAV, oracle-sourced",
    txHash: "0x695323cff5d5a127483967e305ae5d978dc9f24950d45c83a4a5eb1fcf38d2f1",
    result: "market 0x…01580a",
    tone: "violet",
  },
  {
    stage: "Meta-market",
    event: "finalize",
    subject: "navT0 0.00 → navT1 25.00 tUSDC",
    txHash: "0x338e1f019cf009f69729ac1cfde13ac0dbaeeaf4d9ef0a2f6ee37c32b2be4ded",
    result: "outcomeValue 1 · YES",
    tone: "up",
  },
  {
    stage: "Meta-market",
    event: "committee resolution",
    subject: "winningOutcome 1, voided false, payout [0, 1e7]",
    txHash: null,
    // The committee's verdict is an event on DreamDEX's own module, not a
    // transaction this project sent. Saying so is the point of the row.
    note: "committee event · via indexer",
    result: "PAID",
    tone: "lime",
  },
  {
    stage: "Vault",
    event: "placeBinaryOrder",
    subject: "a live BTC Event Contract, called by the vault",
    txHash: "0x8658d9ac0aebc615a557158041174cc25003a7a82c3a0c7e2ffbb251db4835af",
    result: "vault 10 YES · operator EOA 0",
    tone: "cyan",
  },
  {
    stage: "Session",
    event: "redeemAll",
    subject: "BUY_YES 20 lost; navT0 100.00 → navT1 92.60",
    txHash: "0x241bc7644c2e2c2731dbb8a944ade5094d66d5fdd7f6dba047bb6fe1ca9bbee8",
    result: "−7.40 tUSDC",
    tone: "down",
  },
];

/**
 * Findings from testing that the published documentation contradicts.
 *
 * Kept because they are the reason the system is shaped the way it is — the
 * void rate in particular is why every meta-market pays for six JSON sources it
 * could technically do without.
 */
export interface Contradiction {
  claim: string;
  measured: string;
}

export const CONTRADICTIONS: readonly Contradiction[] = [
  {
    claim: "Somnia supports EIP-7702, per its own JSON-RPC documentation",
    measured:
      "Type-4 transactions are rejected `invalid transaction` on all three RPCs, while types 0, 1 and 2 reach nonce validation.",
  },
  {
    claim: "Session keys can scope an agent's Event-Contract trading",
    measured:
      "Spot only. The SDK says it outright: a BinaryPool escrows through the module and has no operator gate. So the vault holds the capital instead, and the operator key may only call trade().",
  },
  {
    claim: "Contract oracle sources are a supported settlement path",
    measured:
      "The OracleHub prices them at 0.00 STT, so nothing funds a validator to service one. 7 of 10 live contract-sourced samples voided, against 122 of 20,617 (0.59%) for the paid six-JSON tier.",
  },
  {
    claim: "getSchedulingCost is stable, so the mint cost can be hardcoded",
    measured:
      "The resolve reserve derives from maxFeePerGas, so it is re-quoted on every mint rather than assumed.",
  },
];
