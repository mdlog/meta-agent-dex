/**
 * The ABIs Meta-Agent DEX needs and the DreamDEX SDK does not ship.
 *
 * Two of these are ours (`BotVault`, `BotNavOracle`, mirrored from
 * `contracts/*.sol`). The other two are DreamDEX's own and are here because the
 * SDK's write surface stops short of them: `scheduleAndCreateMarket` is the
 * entry point third parties actually mint through — the SDK only wraps the
 * MarketCreator rolling-series path — and `markets(bytes32)` is the module read
 * that returns a market's pool and outcome ids in one call.
 *
 * Everything below is either mirrored from source we compile ourselves or
 * recovered by decoding live Shannon calldata (see
 * `scripts/spike/00-decode-reference.ts`). Nothing here is inferred from docs.
 */

import { parseAbi } from "viem";

/**
 * The per-agent trading account. `nav()` is `protocolCash` and nothing else —
 * the number the second-layer market settles on — so it is read here rather
 * than derived from a token balance anywhere in the app.
 *
 * `redeemAll` / `closeSession` carry no arguments and no access control on
 * purpose; anyone may end a session once its window has passed.
 */
export const botVaultAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function setOperator(address operator_)",
  "function openSession(uint64 endsAt)",
  "function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType)",
  "function redeemAll()",
  "function closeSession()",
  "function nav() view returns (uint256)",
  "function protocolCash() view returns (uint256)",
  "function unaccounted() view returns (uint256)",
  "function sessionOpen() view returns (bool)",
  "function sessionId() view returns (uint256)",
  "function sessionEnd() view returns (uint64)",
  "function touchedMarkets() view returns (bytes32[])",
  "function touchedCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function sessionEnd() view returns (uint64)",
  "function operator() view returns (address)",
  "function collateral() view returns (address)",
  "function outcomeToken() view returns (address)",
  // Declared so viem can name a revert. Omitted, a failing keeper pass prints
  // the raw selector and the operator has to hash candidate signatures by hand.
  "error NotOwner()",
  "error NotOperator()",
  "error SessionIsOpen()",
  "error SessionNotOpen()",
  "error SessionNotEnded()",
  "error MarketOutlivesSession()",
  "error NothingToRedeem()",
  "event SessionOpened(uint256 indexed sessionId, uint64 endsAt, uint256 navT0)",
  "event Traded(bytes32 indexed marketId, uint8 kind, uint256 price, uint256 quantity, int256 cashDelta)",
  "event Redeemed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount, int256 cashDelta)",
  // A leg the module refused. Surfaced because a skipped redemption understates
  // NAV, and NAV is what the meta-market pays out on.
  "event RedeemFailed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount)",
  "event SessionClosed(uint256 indexed sessionId, uint256 navT1)",
]);

/**
 * One oracle per session; the DreamDEX committee calls `outcomeValue()` at the
 * market's resolutionTime.
 *
 * `state()` exists so the UI gets navT0, the live NAV and the freeze flags in a
 * single `eth_call` instead of five — a session page polls this every few
 * seconds and the RPC is shared with the trading path.
 */
export const botNavOracleAbi = parseAbi([
  "function open()",
  "function finalize()",
  "function outcomeValue() view returns (uint256)",
  "function state() view returns (uint256 navT0, uint256 navLive, uint64 closesAt, bool opened, bool finalized, uint256 value)",
  "function navT0() view returns (uint256)",
  "function navT1() view returns (uint256)",
  "function opened() view returns (bool)",
  "function finalized() view returns (bool)",
  "function closesAt() view returns (uint64)",
  "function sessionId() view returns (uint256)",
  "function vault() view returns (address)",
  "event SessionOpened(address indexed vault, uint256 sessionId, uint256 navT0, uint64 at)",
  "event SessionFinalized(address indexed vault, uint256 navT0, uint256 navT1, uint256 value, uint64 at)",
]);

/**
 * `BinaryMarketsModule.scheduleAndCreateMarket` — schedules the oracle question
 * and mints the Event Contract in one transaction.
 *
 * The signature is recovered from live calldata, not from a header file, and
 * the tuple components are written FLAT (`(int256,int256)[]`, not
 * `(int256 low, int256 high)[]`). That is deliberate: this exact string decodes
 * the two known-good third-party creations byte for byte, and viem's
 * human-readable parser rejects the named-struct spelling of the interval pair.
 * Component names do not enter the selector, so the flat form is the same
 * function — it is only the parser that cares.
 */
export const marketCreationAbi = parseAbi([
  "function scheduleAndCreateMarket(uint32 operatorId, bytes32 venueId, address adapter, (string questionText,(uint8 sourceType,bytes params)[] sources,(uint8 answerType,string[] discreteOutcomes,(int256,int256)[] numericIntervals,uint64 numericDecimals) validAnswers,uint256 resolutionTime,uint256 minAgreement,uint256 subcommitteeSize,uint256 subcommitteeThreshold) def, (uint256 oracleQuestionId,address oracle,address collateral,(uint256 tickSize,uint256 minQuantity,uint256 lotSize) bookParams,string asset,uint256 slot9,uint64 tradingStart,uint64 expiry,uint64 intervalSec,string question,uint256 strike,bytes context) params, (uint256 deadline,uint256 nonce,bytes signature) venueAuth) payable returns (uint256 questionId, bytes32 marketId, address marketAddress)",
]);

/**
 * The module read the vault itself depends on: pool address, outcome ids and
 * expiry for one market. Field order mirrors `BinaryMarketsModule.markets` and
 * is asserted by `BotVault.trade`, which destructures the tenth slot as the
 * pool and the fourteenth as the expiry.
 */
/**
 * The outcome-token singleton, read-only.
 *
 * ERC-6909, not ERC-20: one contract carries every market's Up and Down leg
 * under a numeric id, which is why the balance takes an id alongside the owner.
 * The ids come from `markets(marketId)` above — slot eleven and slot twelve —
 * and pairing a balance with the wrong one is how a losing leg gets counted as
 * a winning one, so they are never derived anywhere but from that call.
 */
export const outcomeTokenReadsAbi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

export const moduleReadsAbi = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);

/**
 * The module's own creation event — 20 fields, and a different topic0 from the
 * 13-field `MarketCreated` the MarketCreator factory emits under the same name.
 * This is the one that fires for a direct `scheduleAndCreateMarket`, and the
 * only creation event carrying (operatorId, venueId) attribution, so a mint
 * receipt is decoded against it and filtered to the module's own address.
 *
 * It is how the mint learns its own marketId: the function returns one, but a
 * return value is unreadable from a mined receipt, and re-simulating a
 * 26M-gas call to recover it is not worth an extra round-trip that can
 * disagree with what was actually mined.
 */
export const binaryModuleCreationEventAbi = parseAbi([
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 oracleQuestionId, uint32 operatorId, bytes32 venueId, address creator, address collateral, uint256 yesId, uint256 noId, uint64 nonce, uint8 outcomeSlotCount, uint8 marketType, uint64 tradingStart, uint64 expiry, uint8 voidPolicy, string asset, uint256 strike, string question, bytes context)",
]);

/**
 * The two OracleHub views that price a mint. Mirrored from the SDK's
 * `machineryAbi.ts`, with the definition tuple respelled flat so ONE definition
 * object serialises against both this and {@link marketCreationAbi} — quoting a
 * different object than the one you mint with is how a create silently
 * underpays.
 *
 * Attach `getSchedulingCost(def) + resolveReserve()` as the create value, every
 * time, re-read per mint. The reserve is derived from the hub's `maxFeePerGas`
 * and admins retune it; the surplus is refunded in-transaction, so over-reading
 * is free and a stale constant reverts the mint.
 */
export const oracleHubCostAbi = parseAbi([
  "function getSchedulingCost((string questionText,(uint8 sourceType,bytes params)[] sources,(uint8 answerType,string[] discreteOutcomes,(int256,int256)[] numericIntervals,uint64 numericDecimals) validAnswers,uint256 resolutionTime,uint256 minAgreement,uint256 subcommitteeSize,uint256 subcommitteeThreshold) def) view returns (uint256 cost)",
  "function resolveReserve() view returns (uint256 reserve)",
]);
