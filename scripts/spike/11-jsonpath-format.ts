/**
 * Spike 11 — what jsonPath syntax does the oracle committee actually accept?
 *
 * A malformed source fails at RESOLUTION, not at mint: the market is created,
 * takes bets, and then voids. So the format is worth recovering from a market
 * that demonstrably resolved rather than guessing it.
 */
import { createPublicClient, http, decodeFunctionData, parseAbi, decodeAbiParameters, parseAbiParameters } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const pub = createPublicClient({ chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const abi = parseAbi([
  "function scheduleAndCreateMarket(uint32 operatorId, bytes32 venueId, address adapter, (string questionText,(uint8 sourceType,bytes params)[] sources,(uint8 answerType,string[] discreteOutcomes,(int256,int256)[] numericIntervals,uint64 numericDecimals) validAnswers,uint256 resolutionTime,uint256 minAgreement,uint256 subcommitteeSize,uint256 subcommitteeThreshold) def, (uint256 oracleQuestionId,address oracle,address collateral,(uint256 tickSize,uint256 minQuantity,uint256 lotSize) bookParams,string asset,uint256 slot9,uint64 tradingStart,uint64 expiry,uint64 intervalSec,string question,uint256 strike,bytes context) params, (uint256 deadline,uint256 nonce,bytes signature) venueAuth) payable",
]);

// A production BTC/ETH roll that resolved cleanly, recovered earlier by tracing.
const TX = "0xa7c82825816ccedf975fb2a01c7446e25fccd1672a201239777986e4fef72af7";
const trace = await fetch("https://dream-rpc.somnia.network", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [TX, { tracer: "callTracer" }] }),
}).then((r) => r.json()) as { result?: { calls?: unknown[] } };

type Call = { to?: string; input?: string; calls?: Call[] };
const found: string[] = [];
const walk = (c: Call) => {
  if (c.input?.startsWith("0x94f9fdc7")) found.push(c.input);
  c.calls?.forEach(walk);
};
walk((trace.result ?? {}) as Call);
console.log(`found ${found.length} scheduleAndCreateMarket calls in ${TX.slice(0, 12)}…\n`);

for (const input of found.slice(0, 1)) {
  const d = decodeFunctionData({ abi, data: input as `0x${string}` });
  const def = (d.args as readonly unknown[])[3] as {
    questionText: string;
    sources: readonly { sourceType: number; params: `0x${string}` }[];
    validAnswers: { answerType: number; numericIntervals: readonly (readonly [bigint, bigint])[]; numericDecimals: bigint };
    minAgreement: bigint; subcommitteeSize: bigint; subcommitteeThreshold: bigint;
  };
  console.log("questionText :", def.questionText);
  console.log("minAgreement :", def.minAgreement, " subcommittee:", def.subcommitteeSize, "/", def.subcommitteeThreshold);
  console.log("answerType   :", def.validAnswers.answerType, " decimals:", def.validAnswers.numericDecimals);
  console.log("intervals    :", JSON.stringify(def.validAnswers.numericIntervals.map((i) => i.map(String))));
  console.log(`\n${def.sources.length} sources:`);
  for (const [i, s] of def.sources.entries()) {
    if (s.sourceType === 1) {
      const [url, jsonPath, decimals] = decodeAbiParameters(parseAbiParameters("string, string, uint256"), s.params);
      console.log(`  [${i}] JSON`);
      console.log(`       url      ${url}`);
      console.log(`       jsonPath ${JSON.stringify(jsonPath)}`);
      console.log(`       decimals ${decimals}`);
    } else {
      console.log(`  [${i}] sourceType=${s.sourceType} params=${s.params.slice(0, 66)}…`);
    }
  }
}
