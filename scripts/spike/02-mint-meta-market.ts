/**
 * Spike 2 — mint one real meta-market end to end.
 *
 * Deploys a BotNavOracle, opens the session, funds the bot so NAV rises, and
 * mints a native DreamDEX Event Contract whose settlement source is that
 * contract. Making NAV rise on purpose is the point: if the committee really
 * reads our oracle, the market must resolve to outcome 1. A coin flip would not
 * prove anything.
 *
 * Parameters are copied from a decoded, known-good third-party creation
 * (tx 0x963320cf…), with one deliberate change: resolutionTime gets a buffer
 * instead of sitting exactly on expiry.
 */
import fs from "node:fs";
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther,
  formatUnits, erc20Abi, encodeAbiParameters, parseAbiParameters,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const pk = (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: somniaShannon, transport: http(RPC) });

const cp = JSON.parse(fs.readFileSync(".data/spike-control-plane.json", "utf8"));
const artifact = JSON.parse(fs.readFileSync(process.env.ARTIFACT!, "utf8"))
  .contracts["contracts/BotNavOracle.sol:BotNavOracle"];

const COLLATERAL = SOMNIA_TESTNET_ADDRESSES.collateral as `0x${string}`;
const ORACLE_HUB = SOMNIA_TESTNET_ADDRESSES.oracleHub as `0x${string}`;
const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule as `0x${string}`;

const oracleAbi = parseAbi([
  "function open()",
  "function finalize()",
  "function outcomeValue() view returns (uint256)",
  "function navT0() view returns (uint256)",
]);

// Recovered from live calldata; the SDK does not ship this.
const moduleAbi = parseAbi([
  "function scheduleAndCreateMarket(uint32 operatorId, bytes32 venueId, address adapter, (string questionText,(uint8 sourceType,bytes params)[] sources,(uint8 answerType,string[] discreteOutcomes,(int256,int256)[] numericIntervals,uint64 numericDecimals) validAnswers,uint256 resolutionTime,uint256 minAgreement,uint256 subcommitteeSize,uint256 subcommitteeThreshold) def, (uint256 oracleQuestionId,address oracle,address collateral,(uint256 tickSize,uint256 minQuantity,uint256 lotSize) bookParams,string asset,uint256 slot9,uint64 tradingStart,uint64 expiry,uint64 intervalSec,string question,uint256 strike,bytes context) params, (uint256 deadline,uint256 nonce,bytes signature) venueAuth) payable returns (uint256 questionId, bytes32 marketId, address marketAddress)",
]);

const wait = (h: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash: h });

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const TRADING_START = now + 30;
  const EXPIRY = now + 420;          // 7 minutes — short enough to watch settle
  const RESOLUTION = EXPIRY + 90;    // buffer, unlike DECEDO's zero
  const botKey = generatePrivateKey();
  const bot = privateKeyToAccount(botKey).address;

  console.log("deployer :", account.address);
  console.log("bot      :", bot, "(fresh, balance 0)");
  console.log("expiry   :", EXPIRY, `(+${EXPIRY - now}s)  resolution +${RESOLUTION - EXPIRY}s after expiry`);
  console.log("");

  console.log("1/5 deploy BotNavOracle …");
  const deployHash = await wallet.deployContract({
    abi: (typeof artifact.abi === "string" ? JSON.parse(artifact.abi) : artifact.abi), bytecode: `0x${artifact.bin}`,
    args: [COLLATERAL, bot, BigInt(EXPIRY)],
  } as never);
  const deployed = await wait(deployHash);
  const oracle = deployed.contractAddress!;
  console.log("    oracle :", oracle, "| tx", deployHash);

  console.log("2/5 open() — snapshot navT0 …");
  await wait(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: "open" }));
  console.log("    navT0 :", (await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "navT0" })).toString());

  console.log("3/5 fund the bot so NAV rises (makes the outcome falsifiable) …");
  await wait(await wallet.writeContract({
    address: COLLATERAL, abi: erc20Abi, functionName: "transfer", args: [bot, 25_000_000n],
  }));
  const ov = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "outcomeValue" });
  console.log("    bot tUSDC :", formatUnits(await publicClient.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [bot] }), 6));
  console.log("    outcomeValue() now =", ov.toString(), ov === 1n ? "→ we expect the market to resolve YES (index 1)" : "→ unexpected");

  console.log("4/5 scheduleAndCreateMarket …");
  const sourceParams = encodeAbiParameters(
    parseAbiParameters("address, string, string, uint256"),
    [oracle, "outcomeValue()", "", 0n],
  );
  const hash = await wallet.writeContract({
    address: MODULE, abi: moduleAbi, functionName: "scheduleAndCreateMarket",
    args: [
      cp.operatorId, cp.venueId, ORACLE_HUB,
      {
        questionText: `Did agent ${bot.slice(0, 10)} close the session with a higher NAV?`,
        sources: [{ sourceType: 2, params: sourceParams }],
        validAnswers: { answerType: 0, discreteOutcomes: [], numericIntervals: [[0n, 0n], [1n, 1n]], numericDecimals: 0n },
        resolutionTime: BigInt(RESOLUTION),
        minAgreement: 1n, subcommitteeSize: 3n, subcommitteeThreshold: 2n,
      },
      {
        oracleQuestionId: 0n, oracle: ORACLE_HUB, collateral: COLLATERAL,
        bookParams: { tickSize: 1000n, minQuantity: 1000n, lotSize: 1000n },
        asset: "BOTNAV", slot9: 0n,
        tradingStart: BigInt(TRADING_START), expiry: BigInt(EXPIRY), intervalSec: 300n,
        question: `Will agent ${bot.slice(0, 10)} close session #1 with positive NAV?`,
        strike: 0n,
        context: encodeAbiParameters(parseAbiParameters("address, uint256, bytes32"), [bot, 1n, `0x${"00".repeat(32)}` as `0x${string}`]),
      },
      { deadline: 0n, nonce: 0n, signature: "0x" },
    ],
    value: 900000000000000000n,
  } as never);
  const rc = await wait(hash);
  console.log("    tx     :", hash, "| status", rc.status);

  console.log("5/5 recording …");
  const out = { ...cp, bot, botKey, oracle, marketCreateTx: hash, tradingStart: TRADING_START, expiry: EXPIRY, resolutionTime: RESOLUTION, expectedOutcome: 1 };
  fs.writeFileSync(".data/spike-meta-market.json", JSON.stringify(out, null, 2));
  console.log("    saved .data/spike-meta-market.json");
  console.log("STT left :", formatEther(await publicClient.getBalance({ address: account.address })));
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); if (e?.metaMessages) console.error(e.metaMessages.join("\n")); process.exit(1); });
