/**
 * Step 1 — make the operator key.
 *
 * Prints a fresh key and its address. Put the key in `.env` as
 * OPERATOR_PRIVATE_KEY, then send the address a little STT from the Somnia
 * faucet.
 *
 * WHY A SECOND KEY AT ALL. This one lives on your laptop through a demo. It may
 * call exactly one function on your vault — `trade` — which forwards straight to
 * a DreamDEX pool. It cannot withdraw, deposit, change the operator, or open a
 * session — it can only close one after `sessionEnd`, which `closeSession()` lets
 * anyone do. Losing it costs you the ability to trade badly, and nothing
 * else. That is the entire point of the split, and it disappears the moment you
 * use one key for both roles.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatEther } from "viem";
import { SHANNON, env } from "./env.ts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

console.log("\nOPERATOR_PRIVATE_KEY=" + key);
console.log("# address: " + account.address);
console.log("\nPut that key in .env, then send the address ~0.6 STT.");
console.log("Measured cost is 0.0057 STT per trade, so 0.6 is about a hundred orders.");
console.log("It never needs tUSDC — the vault holds the collateral, not the bot.\n");

// If the file already names an operator, report what it holds. Someone running
// this a second time usually wants that, not another key.
const existing = env("OPERATOR_PRIVATE_KEY");
if (existing !== undefined && /^0x?[0-9a-fA-F]{64}$/.test(existing)) {
  const current = privateKeyToAccount((existing.startsWith("0x") ? existing : `0x${existing}`) as `0x${string}`);
  const pub = createPublicClient({ transport: http(SHANNON.rpc) });
  const gas = await pub.getBalance({ address: current.address });
  console.log(`.env already names ${current.address} — it holds ${formatEther(gas)} STT.`);
  console.log("Ignore the key above unless you meant to start over.\n");
}
