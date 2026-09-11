import { createPublicClient, http, decodeFunctionData, parseAbi } from "viem";
const RPC = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(RPC) });

const abi = parseAbi([
  "function scheduleAndCreateMarket(uint32 operatorId, bytes32 venueId, address adapter, (string questionText,(uint8 sourceType,bytes params)[] sources,(uint8 answerType,string[] discreteOutcomes,(int256,int256)[] numericIntervals,uint64 numericDecimals) validAnswers,uint256 resolutionTime,uint256 minAgreement,uint256 subcommitteeSize,uint256 subcommitteeThreshold) def, (uint256 oracleQuestionId,address oracle,address collateral,(uint256 tickSize,uint256 minQuantity,uint256 lotSize) bookParams,string asset,uint256 unknown9,uint64 tradingStart,uint64 expiry,uint64 intervalSec,string question,uint256 strike,bytes context) params, (uint256 deadline,uint256 nonce,bytes signature) venueAuth) payable",
]);

const hashes = [
  "0x963320cf448066b8f68e079c7f88bba245296674679a02a2fc6d99501edf8f45",
  "0xf184618d07f7050e81917e12b06fb02d9653875c283ae2f4ac8d2f8a479f549f",
];

for (const h of hashes) {
  const tx = await client.getTransaction({ hash: h as `0x${string}` });
  console.log("=".repeat(78));
  console.log("tx    :", h);
  console.log("to    :", tx.to, " value:", Number(tx.value) / 1e18, "STT");
  let d;
  try { d = decodeFunctionData({ abi, data: tx.input }); }
  catch (e: any) { console.log("DECODE FAILED:", e.shortMessage ?? e.message); continue; }
  const [operatorId, venueId, adapter, def, params, venueAuth] = d.args as any[];
  console.log("operatorId:", operatorId, " venueId:", venueId);
  console.log("adapter   :", adapter);
  console.log("-- QuestionDefinition --");
  console.log("  questionText          :", def.questionText);
  console.log("  sources               :", JSON.stringify(def.sources, (_k,v)=>typeof v==="bigint"?v.toString():v));
  console.log("  validAnswers.answerType:", def.validAnswers.answerType);
  console.log("  validAnswers.intervals :", JSON.stringify(def.validAnswers.numericIntervals, (_k,v)=>typeof v==="bigint"?v.toString():v));
  console.log("  validAnswers.decimals  :", def.validAnswers.numericDecimals);
  console.log("  resolutionTime        :", def.resolutionTime.toString());
  console.log("  minAgreement          :", def.minAgreement.toString());
  console.log("  subcommitteeSize      :", def.subcommitteeSize.toString());
  console.log("  subcommitteeThreshold :", def.subcommitteeThreshold.toString());
  console.log("-- MarketParams --");
  console.log("  oracleQuestionId :", params.oracleQuestionId.toString());
  console.log("  oracle           :", params.oracle);
  console.log("  collateral       :", params.collateral);
  console.log("  bookParams       : tick", params.bookParams.tickSize.toString(), "minQty", params.bookParams.minQuantity.toString(), "lot", params.bookParams.lotSize.toString());
  console.log("  asset            :", params.asset, "| unknown9:", params.unknown9.toString());
  console.log("  tradingStart     :", params.tradingStart.toString());
  console.log("  expiry           :", params.expiry.toString(), " (expiry-tradingStart =", Number(params.expiry)-Number(params.tradingStart), "s)");
  console.log("  resolutionTime - expiry =", Number(def.resolutionTime) - Number(params.expiry), "s");
  console.log("  intervalSec      :", params.intervalSec.toString());
  console.log("  question         :", params.question);
  console.log("  strike           :", params.strike.toString());
  console.log("  context          :", params.context);
  console.log("-- venueAuth --");
  console.log("  deadline", venueAuth.deadline.toString(), "nonce", venueAuth.nonce.toString(), "sig", venueAuth.signature);
}
