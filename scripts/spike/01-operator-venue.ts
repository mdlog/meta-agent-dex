/**
 * Spike 1 — prove the self-serve control plane.
 *
 * Registers our own operator and an open BINARY_V1 venue, so that minting
 * meta-markets never depends on someone else's venue policy staying open.
 * Both venues that demonstrably accept third-party creation (op6, op18) run
 * policy=0x0 / signer=0x0, so that is what we replicate — the SDK docstring
 * claiming creation "needs SOME create-side policy set" is contradicted by
 * 16 and 57 live markets respectively.
 *
 * Writes its results to .data/spike-control-plane.json for later steps.
 */
import fs from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatEther } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, MARKET_TYPE_BINARY_V1 } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const rawKey = env.DEPLOYER_PRIVATE_KEY;
if (!rawKey) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env.local");
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
const account = privateKeyToAccount(privateKey);

const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const INDEXER = env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";

const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC) });

/** Copy the fee-params blob from a venue that demonstrably accepts creation. */
async function provenFeeParams(): Promise<`0x${string}`> {
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ Venue(where:{operatorId:{_eq:18}}) { feeParams marketCount } }`,
    }),
  });
  const body = (await res.json()) as { data?: { Venue?: { feeParams: string; marketCount: number }[] } };
  const v = body.data?.Venue?.[0];
  if (!v?.feeParams) throw new Error("could not read a proven venue's feeParams from the indexer");
  console.log(`  fee params copied from operator 18's venue (${v.marketCount} markets created there)`);
  return v.feeParams as `0x${string}`;
}

async function main() {
  console.log("Deployer :", account.address);
  console.log("STT      :", formatEther(await publicClient.getBalance({ address: account.address })));
  console.log("MarketsCore:", SOMNIA_TESTNET_ADDRESSES.marketsCore);
  console.log("");

  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: somniaShannon,
    wsRpcUrl: env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  const admin = exchange.client.createOperatorAdmin({ privateKey, publicClient });

  console.log("1/2 registerOperator …");
  const op = await admin.registerOperator({
    feeRecipient: account.address,
    enabled: true,
    policy: "0x0000000000000000000000000000000000000000",
    context: "0x",
  });
  console.log("    operatorId :", op.operatorId);
  console.log("    tx         :", op.receipt.transactionHash);

  console.log("2/2 createVenue …");
  const feeParams = await provenFeeParams();
  const venue = await admin.createVenue({
    operatorId: op.operatorId,
    marketType: MARKET_TYPE_BINARY_V1,
    config: {
      feeParams,
      feeRecipientOverride: "0x0000000000000000000000000000000000000000",
      policy: "0x0000000000000000000000000000000000000000",
      signer: "0x0000000000000000000000000000000000000000",
      creationEnabled: true,
      context: "0x",
    },
  });
  console.log("    venueId :", venue.venueId);
  console.log("    tx      :", venue.receipt.transactionHash);

  const out = {
    deployer: account.address,
    operatorId: op.operatorId,
    venueId: venue.venueId,
    marketType: MARKET_TYPE_BINARY_V1,
    operatorTx: op.receipt.transactionHash,
    venueTx: venue.receipt.transactionHash,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(".data", { recursive: true });
  fs.writeFileSync(path.join(".data", "spike-control-plane.json"), JSON.stringify(out, null, 2));
  console.log("\nSaved .data/spike-control-plane.json");
  console.log("STT left :", formatEther(await publicClient.getBalance({ address: account.address })));
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
