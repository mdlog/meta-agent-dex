/**
 * Step 4 — open a session.
 *
 * Two transactions, split by who is allowed to send them, and the split is the
 * reason you never hand anyone a key:
 *
 *   4a. YOU call `openSession(endsAt)`. It is `onlyOwner`. The arena holds no key
 *       for your vault and cannot do this — nor should it be able to.
 *   4b. THE ARENA deploys the session's `BotNavOracle`, arms it at navT0, and
 *       mints the meta-market other people price you on. It pays for that, and it
 *       needs nothing of yours but a signature proving you are the owner.
 *
 * Every fact the arena records comes off the chain, not out of the request body:
 * it reads the session number and end time from your vault. So a session opened
 * for four hours cannot be registered as ninety minutes — which matters, because
 * the meta-market would otherwise expire while the vault was still trading and
 * settle on a NAV that had not stopped moving.
 *
 * Re-run this after each session ends. Fund first if you want to (`deposit`
 * reverts `SessionIsOpen()` once 4a has landed).
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { ARENA, SHANNON, hexKey, env, num } from "./env.ts";

const owner = privateKeyToAccount(hexKey("OWNER_PRIVATE_KEY", "The wallet that owns the vault."));
const vault = env("VAULT_ADDRESS") as `0x${string}` | undefined;
const slug = env("AGENT_SLUG");
if (!vault) { console.error("\nVAULT_ADDRESS is not set. Run `npm run deploy`.\n"); process.exit(1); }
if (!slug) { console.error("\nAGENT_SLUG is not set. Run `npm run register`.\n"); process.exit(1); }

const pub = createPublicClient({ chain: somniaShannon, transport: http(SHANNON.rpc) });
const wallet = createWalletClient({ account: owner, chain: somniaShannon, transport: http(SHANNON.rpc) });

const vaultAbi = parseAbi([
  "function openSession(uint64 endsAt)",
  "function sessionOpen() view returns (bool)",
  "function sessionEnd() view returns (uint64)",
  "function sessionId() view returns (uint256)",
  "function nav() view returns (uint256)",
]);

const durationSec = num("SESSION_SEC", 5400);
if (durationSec < 3600) {
  // Not a hard stop — it is legal, just usually a mistake worth naming.
  console.warn(
    `\nSESSION_SEC is ${durationSec}. Shannon rolls BTC/ETH series at 1m, 5m, 15m, 1h, 4h and 24h,\n` +
    `and \`trade\` reverts MarketOutlivesSession for anything expiring after sessionEnd — so a\n` +
    `session under an hour contains very little your agent is allowed to touch.\n`,
  );
}

const [alreadyOpen, nav] = await Promise.all([
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "sessionOpen" }) as Promise<boolean>,
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }) as Promise<bigint>,
]);

console.log(`vault ${vault}`);
console.log(`nav   ${formatUnits(nav, 6)} tUSDC`);

// --- 4a: the transaction only the owner may send -----------------------------
if (alreadyOpen) {
  const end = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: "sessionEnd" })) as bigint;
  console.log(`\nA session is already open on chain, ending ${new Date(Number(end) * 1000).toISOString()}.`);
  console.log("Skipping openSession — going straight to registering it with the arena.");
} else {
  const endsAt = BigInt(Math.floor(Date.now() / 1000) + durationSec);
  console.log(`\nopenSession(${endsAt}) — ${durationSec}s…`);
  const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "openSession", args: [endsAt] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${hash}`);
}

// --- 4b: the part the arena does for you -------------------------------------
const nonce = `Meta-Agent DEX — open session ${new Date().toISOString()}`;
const signature = await owner.signMessage({ message: nonce });

console.log("\nregistering the session with the arena…");
const res = await fetch(`${ARENA}/api/agents/${slug}/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nonce, signature }),
});
const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

if (!res.ok) {
  console.error(`\nHTTP ${res.status}`);
  console.error(JSON.stringify(body, null, 2));
  // The vault session is genuinely open at this point, so say what that means
  // rather than leaving a half-finished state unexplained.
  console.error(
    "\nYour vault session is open on chain and your agent can trade. What is missing is the\n" +
    "meta-market that measures it. Re-run this script — 4a is skipped automatically.\n",
  );
  process.exit(1);
}

const session = body.session as {
  sessionNumber: number; closesAt: number; metaMarketId: string | null; navT0: string | null;
} | undefined;

console.log(`\nsession #${session?.sessionNumber}`);
console.log(`  closes     ${session ? new Date(session.closesAt).toISOString() : "?"}`);
console.log(`  navT0      ${session?.navT0 ? formatUnits(BigInt(session.navT0), 6) : "?"} tUSDC`);
console.log(`  metaMarket ${session?.metaMarketId ?? "not minted — the session still settles, nothing to bet on"}`);
console.log(`\n  ${ARENA}/agents/${slug}`);
console.log("\nNow run `npm start`.\n");
