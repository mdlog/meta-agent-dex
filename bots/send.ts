/**
 * The write half of an agent, over plain viem.
 *
 * WHY THIS EXISTS, measured rather than assumed. The SDK's trader is the natural
 * way to write to DreamDEX, and every read in these bots still goes through it.
 * Its WRITE path does not work against the public Shannon RPC: `faucet`,
 * `approve` and `placeBinaryOrder` each come back
 * `Missing or invalid parameters` (JSON-RPC -32000, data 0x03), while the
 * byte-identical call sent with viem to the same address with the same ABI and
 * arguments is mined successfully. Verified on 2026-09-07 against
 * https://dream-rpc.somnia.network with a funded key, both with
 * `createTrader({ privateKey })` and with an HTTP `walletClient`, and with the
 * pool pre-approved so the failure could not be the approve leg:
 *
 *     trader.placeOrder(...)            -> placeBinaryOrder reverted: Missing or invalid parameters
 *     walletClient.writeContract(...)   -> status success, gas 3,436,427
 *
 * The SDK sends through `realtime_sendRawTransaction`; that is the only material
 * difference we could find, and it is reported in docs/DREAMDEX_SDK_FEEDBACK.md.
 *
 * So: the SDK stays the source of market data, ABIs and pricing, and the send is
 * a local signature to the same contracts the SDK targets. Nothing here invents
 * a protocol surface — every ABI below is the SDK's own, restated.
 */

import {
  createPublicClient,
  parseEventLogs,
  createWalletClient,
  http,
  maxUint256,
  parseAbi,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

/** The pool's order entry point. `kind` is 0 BUY_YES · 1 SELL_YES · 2 BUY_NO · 3 SELL_NO. */
const poolAbi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function cancelOrder(uint128 orderId)",
]);

/** Redemption is a module call, and the module knows which venue minted the market. */
const moduleAbi = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
  "function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)",
]);

const faucetAbi = parseAbi(["function faucet(uint256 amount)"]);

/**
 * The outcome-token singleton. `redeem` is module-routed: the module pulls the
 * winning ERC-6909 tokens out of the holder's balance, so the holder has to have
 * made the module an operator first. Nothing did that, and the result was a
 * `redeem` that reverted every single time a speculator held a winning leg —
 * observed as 0xdeda9030 against markets whose NO leg had genuinely won, retried
 * once per poll for hours. `isOperator` is the read that proves it: it came back
 * false for both speculator keys.
 */
const outcomeTokenAbi = parseAbi([
  "function isOperator(address owner, address spender) view returns (bool)",
  "function setOperator(address spender, bool approved) returns (bool)",
]);

/**
 * The pool's fill event. Decoded from the receipt because a locally-sent order
 * gets no fill summary handed back the way the SDK's trader hands one back —
 * and "how much of my order actually crossed" is not a question to guess at.
 */
const fillEventAbi = parseAbi([
  "event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)",
]);

export interface Fill {
  quantityFilled: bigint;
  fillPrice: bigint;
}

export interface PlacedOrder {
  receipt: TransactionReceipt;
  fills: Fill[];
  /** Total quantity that crossed, summed over the fills in this transaction. */
  filled: bigint;
}

export type OrderKind = 0 | 1 | 2 | 3;

export interface Sender {
  readonly address: Address;
  readonly publicClient: PublicClient;
  placeOrder(p: {
    pool: Address;
    kind: OrderKind;
    price: bigint;
    quantity: bigint;
    expireTimestampNs: bigint;
    orderType: number;
  }): Promise<PlacedOrder>;
  faucet(p: { collateral: Address; amount: bigint }): Promise<TransactionReceipt>;
  redeem(p: { module: Address; marketId: Hex; outcomeIdx: 0 | 1; amount: bigint }): Promise<TransactionReceipt>;
  /** Idempotent: reads the allowance first, so a warm agent pays for it once. */
  ensureApproval(p: { collateral: Address; spender: Address; need: bigint }): Promise<TransactionReceipt | null>;
  /**
   * ERC-6909 operator grant, the outcome-token counterpart of `ensureApproval`.
   * Idempotent for the same reason: `isOperator` is read first, so the grant is
   * paid for once per key and not once per redeem.
   */
  ensureOutcomeOperator(p: { outcomeToken: Address; operator: Address }): Promise<TransactionReceipt | null>;
  balanceOf(token: Address): Promise<bigint>;
}

export function makeSender(config: { privateKey: Hex; rpcUrl: string }): Sender {
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: somniaShannon, transport }) as PublicClient;
  const wallet: WalletClient = createWalletClient({ account, chain: somniaShannon, transport });

  const confirm = async (hash: Hex, what: string): Promise<TransactionReceipt> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} reverted on chain (tx ${hash})`);
    return receipt;
  };

  return {
    address: account.address,
    publicClient,

    async placeOrder(p) {
      const hash = await wallet.writeContract({
        account,
        chain: somniaShannon,
        address: p.pool,
        abi: poolAbi,
        functionName: "placeBinaryOrder",
        args: [
          p.kind,
          p.price,
          p.quantity,
          p.expireTimestampNs,
          p.orderType,
          0,
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
        ],
      });
      const receipt = await confirm(hash, "placeBinaryOrder");
      const fills = parseEventLogs({ abi: fillEventAbi, logs: receipt.logs })
        .filter((entry) => entry.address.toLowerCase() === p.pool.toLowerCase())
        .map((entry) => ({ quantityFilled: entry.args.quantityFilled, fillPrice: entry.args.fillPrice }));
      return { receipt, fills, filled: fills.reduce((sum, f) => sum + f.quantityFilled, 0n) };
    },

    async faucet(p) {
      const hash = await wallet.writeContract({
        account,
        chain: somniaShannon,
        address: p.collateral,
        abi: faucetAbi,
        functionName: "faucet",
        args: [p.amount],
      });
      return confirm(hash, "faucet");
    },

    async redeem(p) {
      const market = (await publicClient.readContract({
        address: p.module,
        abi: moduleAbi,
        functionName: "markets",
        args: [p.marketId],
      })) as readonly unknown[];
      const operatorId = market[4] as number;
      const venueId = market[5] as Hex;

      const hash = await wallet.writeContract({
        account,
        chain: somniaShannon,
        address: p.module,
        abi: moduleAbi,
        functionName: "redeem",
        args: [operatorId, venueId, p.marketId, p.outcomeIdx, p.amount],
      });
      return confirm(hash, "redeem");
    },

    async ensureApproval(p) {
      const current = (await publicClient.readContract({
        address: p.collateral,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, p.spender],
      })) as bigint;
      if (current >= p.need) return null;

      const hash = await wallet.writeContract({
        account,
        chain: somniaShannon,
        address: p.collateral,
        abi: erc20Abi,
        functionName: "approve",
        args: [p.spender, maxUint256],
      });
      return confirm(hash, "approve");
    },

    async ensureOutcomeOperator(p) {
      const already = (await publicClient.readContract({
        address: p.outcomeToken,
        abi: outcomeTokenAbi,
        functionName: "isOperator",
        args: [account.address, p.operator],
      })) as boolean;
      if (already) return null;

      const hash = await wallet.writeContract({
        account,
        chain: somniaShannon,
        address: p.outcomeToken,
        abi: outcomeTokenAbi,
        functionName: "setOperator",
        args: [p.operator, true],
      });
      return confirm(hash, "setOperator");
    },

    async balanceOf(token) {
      return (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
    },
  };
}
