export {}; // module: top-level await

/**
 * Close vault sessions the journal has already finished with.
 *
 * A settle that dies partway leaves the chain and the journal disagreeing: the
 * row says the session is done, `sessionOpen` says it is not. The keeper then
 * reads an idle agent, calls `openSession`, and the vault reverts
 * `SessionIsOpen()` — once per pass, forever. Eleven vaults drifted this way
 * after the RPC returned `Missing or invalid parameters` mid-settle.
 *
 * `dueForSettlement` now retries a `closing` row, which covers the sessions the
 * journal still knows about. This covers the other half: vaults whose row is
 * already `settled` or `finalized`, so nothing will ever come back for them.
 *
 * `redeemAll` and `closeSession` are both permissionless and both refuse before
 * `sessionEnd`, so this can only finish a window the chain agrees is over.
 *
 *   npm run reconcile              # report only
 *   npm run reconcile -- --write
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const WRITE = process.argv.includes("--write");
const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const abi = parseAbi([
  "function sessionOpen() view returns (bool)",
  "function sessionEnd() view returns (uint64)",
  "function nav() view returns (uint256)",
  "function touchedCount() view returns (uint256)",
  "function redeemAll()",
  "function closeSession()",
  "error SessionNotOpen()",
  "error SessionNotEnded()",
]);

// Permissionless calls, so the deployer signs simply because it is the key this
// server already holds — not because closing needs an owner.
const signer = privateKeyToAccount(
  (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as Hex,
);
const wallet = createWalletClient({ account: signer, chain: somniaShannon, transport: http(RPC) });
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });

const db = new DatabaseSync(".data/forecast-arena.db");
const ops = JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as { slug: string; vault: Address }[];
const LIVE = new Set(["open", "pending", "closing"]);
const now = Math.floor(Date.now() / 1000);
let fixed = 0, waiting = 0;

for (const o of ops) {
  const row = db.prepare(
    "SELECT s.status FROM agent_sessions s JOIN agents a ON a.id = s.agentId " +
    "WHERE a.slug = ? ORDER BY s.sessionNumber DESC LIMIT 1",
  ).get(o.slug) as { status?: string } | undefined;

  const [open, endsAt, touched] = await Promise.all([
    pub.readContract({ address: o.vault, abi, functionName: "sessionOpen" }) as Promise<boolean>,
    pub.readContract({ address: o.vault, abi, functionName: "sessionEnd" }) as Promise<bigint>,
    pub.readContract({ address: o.vault, abi, functionName: "touchedCount" }) as Promise<bigint>,
  ]);

  if (!open) { console.log(`  ${o.slug.padEnd(15)} vault already closed`); continue; }
  // The journal still owns this one; `dueForSettlement` will come back for it.
  if (row && LIVE.has(row.status ?? "")) {
    console.log(`  ${o.slug.padEnd(15)} open, journal says "${row.status}" — the keeper retries this`);
    continue;
  }
  if (now < Number(endsAt)) {
    console.log(`  ${o.slug.padEnd(15)} open, window ends in ${Math.round((Number(endsAt) - now) / 60)}m`);
    waiting += 1;
    continue;
  }

  console.log(`  ${o.slug.padEnd(15)} ORPHANED — journal "${row?.status ?? "none"}", vault still open, ${touched} touched`);
  if (!WRITE) continue;

  // Redeem first: closing with positions outstanding strands them until someone
  // calls `redeemMarket`, and NAV would read low in the meantime.
  if (touched > 0n) {
    await wait(await wallet.writeContract({ address: o.vault, abi, functionName: "redeemAll" }));
    console.log(`  ${" ".repeat(15)} redeemAll done`);
  }
  await wait(await wallet.writeContract({ address: o.vault, abi, functionName: "closeSession" }));
  const nav = await pub.readContract({ address: o.vault, abi, functionName: "nav" }) as bigint;
  console.log(`  ${" ".repeat(15)} closed — nav ${formatUnits(nav, 6)} tUSDC`);
  fixed += 1;
}

console.log(`\n  ${fixed} closed, ${waiting} still inside their window.`);
if (!WRITE) console.log("  report only — pass --write to close them.");
