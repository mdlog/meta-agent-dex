export {}; // module: top-level await

/**
 * Give each agent's operator key enough STT to pay gas — and nothing else.
 *
 * The operator signs `vault.trade` and nothing more: deposits and withdrawals
 * are `onlyOwner`, so a compromised operator key can move an agent's positions
 * but can never take its money. Funding it with gas alone keeps that visible.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const raw = env.DEPLOYER_PRIVATE_KEY;
if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env.local");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
const rpc = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: somniaShannon, transport: http(rpc) });

const TOP_UP = parseEther("0.6");
const FLOOR = parseEther("0.3");

const operators = JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as
  { name: string; operator: `0x${string}` }[];

for (const op of operators) {
  const balance = await pub.getBalance({ address: op.operator });
  if (balance >= FLOOR) {
    console.log(`    ${op.name}: ${formatEther(balance)} STT, enough`);
    continue;
  }
  const hash = await wallet.sendTransaction({ to: op.operator, value: TOP_UP });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`    ${op.name}: funded ${formatEther(TOP_UP)} STT (${hash.slice(0, 14)}…)`);
}
console.log(`    keeper wallet: ${formatEther(await pub.getBalance({ address: account.address }))} STT left`);
