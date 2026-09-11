/**
 * THE ORACLE MIRROR — the endpoint the DreamDEX committee fetches to settle
 * real money (design §3 Layer 2).
 *
 * `mintMetaMarket` registers six JSON sources against one meta-market, all of
 * them this route, differing only by the `?v=1..6` the hub keys sources by. The
 * registered `jsonPath` is `value` with `decimals: 0` — dot/bracket notation,
 * recovered from DreamDEX's own production sources ("[0][4]", "data[0][4]",
 * "result.list[0][4]"), where a bare key is just the key. So the body must be
 * exactly `{"value":<0|1|2>}` and nothing else may sit at the top level: a
 * committee member walks that one path and anything it cannot walk is a source
 * that failed to serve. That contract is frozen the moment a market is minted
 * and can never be restated, so this shape is not a convention here — it is the
 * ABI of a settlement.
 *
 * WHY IT MIRRORS RATHER THAN CACHES. `value` is read from
 * `BotNavOracle.outcomeValue()` at chain head on every request, never from
 * `agent_sessions`. The database is an index of what a keeper *observed*; the
 * contract is what `finalize()` actually froze. Those two disagree for as long
 * as a keeper is behind, down, or writing a row from a reorged block — and the
 * committee reads during exactly that window, right after `closesAt`. A mirror
 * that served the index would be claiming the contract said something it did
 * not, and the money would move on the claim.
 *
 * WHY EVERY FAILURE IS ZERO. `mintMetaMarket` registers the answer intervals
 * [1,1] and [2,2]; 0 is deliberately outside both, so an answer of 0 lands in
 * no interval and the market VOIDS — both sides refunded — instead of settling.
 * So the safe direction is fixed and asymmetric: serving 0 when the truth was
 * 1 or 2 costs everyone a refund, while serving 1 or 2 when we do not actually
 * know pays one side of a real market off a guess. Every path out of here that
 * is not a completed `outcomeValue()` read therefore answers 0 — a bad address,
 * a dead RPC, a slow RPC, a value the contract could not have returned, a bug
 * in this file. Nothing throws to the framework: a 500 is not a safe answer, it
 * is an unpredictable one, and six sources failing in an unpredictable way is
 * how a market gets settled by whatever the other members happened to see.
 *
 * WHY THE IMPORTS STOP HERE. This route deliberately does not use `json()` from
 * `@/lib/http` or anything else in the app's service graph, and does not
 * touch `@/lib/agents/chain`. Two reasons, both about failure: a module that
 * throws while *loading* 500s the request before any `try` in this file runs,
 * and `chain.ts` builds its clients from `DEPLOYER_PRIVATE_KEY` and throws
 * without it — a missing deploy key would silently void every live meta-market
 * on the platform. The read needs viem, a chain object and one ABI, so that is
 * all it is allowed to depend on.
 */

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { botNavOracleAbi } from "@/lib/agents/abi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

/**
 * Committee members fetch six URLs across some window they control and we do
 * not, so slow is functionally the same as down. One retry is worth having —
 * a single dropped packet should not void a market — and the numbers are sized
 * so both attempts plus setup finish inside {@link DEADLINE_MS}.
 */
const READ_TIMEOUT_MS = 2_500;
const RETRY_COUNT = 1;
const RETRY_DELAY_MS = 150;

/**
 * The hard ceiling on the whole handler. viem's transport timeout aborts one
 * HTTP attempt; it does not bound DNS, TLS setup and a retry stacking on top of
 * each other. This is the guarantee that the route answers *something* — and
 * the something is 0.
 */
const DEADLINE_MS = 6_000;

/**
 * Shape only, and deliberately not viem's `isAddress`: that verifies EIP-55
 * checksum casing on any mixed-case input, and a well-formed address written
 * with the wrong case would come back as "not an address" and void a live
 * market. Case has no bearing on which contract this is.
 *
 * The shape check alone is not enough, which is why {@link GET} lowercases
 * before the read rather than passing the param through. Measured: viem asserts
 * the checksum again inside `readContract`, so `0xA2caF095…2229` (this repo's
 * real oracle, miscased) reached the RPC as an `InvalidAddressError` and the
 * mirror answered 0 for a market that had already been finalized to 1. An
 * all-lowercase address skips that assertion entirely.
 */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * One read-only client per process, pinned to `globalThis` exactly as
 * `dreamdex/receipt.ts` does — Next's dev-mode module reloading would otherwise
 * leak one transport per edit, and this route is polled.
 */
const globalRef = globalThis as typeof globalThis & { __oracleMirrorRpc?: PublicClient };

function rpc(): PublicClient {
  globalRef.__oracleMirrorRpc ??= createPublicClient({
    chain: somniaShannon,
    transport: http(RPC_URL, {
      timeout: READ_TIMEOUT_MS,
      retryCount: RETRY_COUNT,
      retryDelay: RETRY_DELAY_MS,
    }),
  }) as PublicClient;
  return globalRef.__oracleMirrorRpc;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`oracle read exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `outcomeValue()` and not `state()`: it is the single function the contract
 * documents as never reverting, and it is the exact call whose 0/1/2 encoding
 * the market's intervals were registered against. Reading the same number out
 * of a wider struct would be one more place for the two to drift apart.
 *
 * A value our own contract could not have returned is mapped to 0 rather than
 * reported. "Unrecognised" and "not answered yet" have the same correct
 * consequence, and only one of the two is safe to guess at.
 */
async function readOutcomeValue(oracle: Address): Promise<0 | 1 | 2> {
  const raw = await rpc().readContract({
    address: oracle,
    abi: botNavOracleAbi,
    functionName: "outcomeValue",
  });
  return raw === 1n ? 1 : raw === 2n ? 2 : 0;
}

/**
 * The only body this route may produce. `no-store` because the answer flips
 * exactly once, at `finalize()`, and a proxy holding the pre-finalize 0 for
 * sixty seconds would void a market that had already been answered.
 */
function answer(value: 0 | 1 | 2): Response {
  return Response.json({ value }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ oracle: string }> }): Promise<Response> {
  // The query string is read by nobody here on purpose: the six registered
  // source URLs differ only by `?v=`, because the hub keys sources by exact URL
  // and would otherwise collapse them into one. They are six reads of one
  // mirror, and the honest way to serve them is identically.
  let oracle = "";
  try {
    oracle = (await ctx.params).oracle;
    if (typeof oracle !== "string" || !ADDRESS_SHAPE.test(oracle)) return answer(0);

    return answer(await withDeadline(readOutcomeValue(oracle.toLowerCase() as Address), DEADLINE_MS));
  } catch (e) {
    // Logged, never surfaced. A committee member cannot act on a message, and
    // an operator watching a session that voided needs to know it was the RPC
    // and not the contract — so the address goes in the line. Only the first
    // line of the error: viem prints the whole ABI on a contract error, and six
    // sources failing would bury the log that says which market it was.
    const why = e instanceof Error ? e.message.split("\n", 1)[0] : String(e);
    console.error(`[oracle-mirror] ${oracle} answering 0 after a failed read: ${why}`);
    return answer(0);
  }
}
