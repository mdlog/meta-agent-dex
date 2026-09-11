/**
 * Spike 4 — the moment of truth.
 *
 * Waits for expiry, freezes the oracle answer, then polls until DreamDEX's
 * committee either resolves the market or voids it. We funded the bot on
 * purpose, so a correct resolution MUST be outcome 1. Outcome 0 would mean the
 * committee did not read our contract; a void would mean it disagreed with
 * itself, which is what happens to most third-party markets on this venue.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;
const pk = (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const RPC = "https://dream-rpc.somnia.network";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: somniaShannon, transport: http(RPC) });
const s = JSON.parse(fs.readFileSync(".data/spike-meta-market.json", "utf8"));
const MARKET_ID = "0x000000000000000000000000000000000000000000000000000000000001580a";

const oracleAbi = parseAbi([
  "function finalize()",
  "function outcomeValue() view returns (uint256)",
  "function finalized() view returns (bool)",
  "function navT0() view returns (uint256)",
  "function navT1() view returns (uint256)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function marketState() {
  const r = await fetch(INDEXER, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ Market(where:{marketId:{_eq:"${MARKET_ID}"}}) { voided winningOutcome finalized payoutNumerators payoutDenominator resolvedAtTimestamp status: clobStatus } }` }),
  });
  return (await r.json() as any).data?.Market?.[0];
}

async function main() {
  console.log(`market ${MARKET_ID}`);
  console.log(`expiry ${s.expiry}  resolutionTime ${s.resolutionTime}  expected outcome ${s.expectedOutcome}\n`);

  // 1. Wait out the trading window.
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= s.expiry) break;
    console.log(`${stamp()}  ${s.expiry - now}s to expiry …`);
    await sleep(30_000);
  }

  // 2. Freeze the answer so every committee member reads the same number.
  console.log(`${stamp()}  expiry reached — finalize()`);
  try {
    const h = await wallet.writeContract({ address: s.oracle, abi: oracleAbi, functionName: "finalize" });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`${stamp()}  finalize tx ${h}`);
  } catch (e: any) {
    console.log(`${stamp()}  finalize failed (may already be final): ${e?.shortMessage ?? e?.message}`);
  }
  const [fin, ov, n0, n1] = await Promise.all([
    pub.readContract({ address: s.oracle, abi: oracleAbi, functionName: "finalized" }),
    pub.readContract({ address: s.oracle, abi: oracleAbi, functionName: "outcomeValue" }),
    pub.readContract({ address: s.oracle, abi: oracleAbi, functionName: "navT0" }),
    pub.readContract({ address: s.oracle, abi: oracleAbi, functionName: "navT1" }),
  ]);
  console.log(`${stamp()}  oracle frozen=${fin} navT0=${n0} navT1=${n1} outcomeValue=${ov}\n`);

  // 3. Poll for the committee's verdict.
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const m = await marketState();
    console.log(`${stamp()}  status=${m?.status} finalized=${m?.finalized} voided=${m?.voided} winningOutcome=${m?.winningOutcome} payout=${m?.payoutNumerators}`);
    if (m?.voided === true) { console.log("\n❌ VOIDED — the committee disagreed."); process.exit(2); }
    if (m?.winningOutcome !== null && m?.winningOutcome !== undefined) {
      const ok = Number(m.winningOutcome) === s.expectedOutcome;
      console.log(`\n${ok ? "✅" : "❌"} RESOLVED outcome=${m.winningOutcome} (expected ${s.expectedOutcome}) payout=${m.payoutNumerators}/${m.payoutDenominator}`);
      console.log(ok ? "The committee read OUR contract and returned OUR value." : "Resolved, but not to our value — investigate.");
      process.exit(ok ? 0 : 3);
    }
    await sleep(20_000);
  }
  console.log("\n⏳ still unresolved after 20 minutes.");
  process.exit(4);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
