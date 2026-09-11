export {}; // module: top-level await

/**
 * Move collateral from the deployer to the agent owner wallets.
 *
 * `fund-vaults` moves collateral OWNER -> VAULT. Nothing moved it DEPLOYER ->
 * OWNER, so an independently-owned agent whose owner ran dry could not be topped
 * up at all: `fund-vaults` printed `SKIP: owner 0x… holds 0, needs 189.97` and
 * stopped there, correctly, because inventing collateral out of the faucet for
 * an owner that is supposed to be independent would fake the separation the
 * vault exists to demonstrate. Measured on 2026-09-09: five of eight independent
 * owners held nothing, and tessellate sat a whole session at the 10 tUSDC cash
 * floor unable to place a single order.
 *
 *   npm run fund-owners                        # report only, no writes
 *   npm run fund-owners -- --write             # top every owner up to 500
 *   npm run fund-owners -- --write --target 200
 *   npm run fund-owners -- --write --agent tessellate
 *
 * WHAT THIS DOES TO THE AUDIT STORY, said plainly rather than hidden: it makes
 * the deployer the visible source of every agent's capital. That was already
 * true — tailward and fade-nine were seeded the same way — and a transfer is the
 * honest form of it, because an `ERC20.Transfer` from a known address is a fact
 * anyone can read off chain. What stays true is the thing being proven: `owner`
 * is `immutable` on each vault (contracts/BotVault.sol:66) and is NOT the
 * deployer, so the deployer can hand an agent money and still hold no power to
 * trade it, withdraw it, or open a session with it.
 *
 * The faucet is deliberately not used here. Same reason as `fund-vaults`: a
 * balance that appears from nowhere at an owner address reads as self-funding.
 */

import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const DECIMALS = 6;
/** Matches `TUSDC_SUGGESTED` in create-independent-agent.ts, times a few sessions
 *  of runway so this does not have to run every 90 minutes. */
const DEFAULT_TARGET = "500";

const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function collateral() view returns (address)",
  "function nav() view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const rpc = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(rpc) });
const deployer = privateKeyToAccount(
  (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`,
);
const wallet = createWalletClient({ account: deployer, chain: somniaShannon, transport: http(rpc) });

const args = process.argv.slice(2);
const val = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const only = val("--agent");
const write = args.includes("--write");
const target = parseUnits(val("--target") ?? DEFAULT_TARGET, DECIMALS);

const agents = (JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as
  { name: string; slug: string; vault: `0x${string}` }[])
  .filter((a) => (only ? a.slug === only : true));
if (agents.length === 0) throw new Error(`no agent matched --agent ${only}`);

const collateral = await pub.readContract({
  address: agents[0].vault, abi: vaultAbi, functionName: "collateral",
}) as `0x${string}`;
const money = (v: bigint) => formatUnits(v, DECIMALS);

/**
 * The keeper signs with this same deployer key from inside the app, where its
 * own queue serialises its writes. This is a separate process, so that queue
 * does not cover us: viem fetches a pending nonce, the keeper takes it first,
 * and the send comes back "nonce too low". Re-read and retry rather than
 * pre-allocating, because the keeper may land several transactions in between.
 */
async function sendWithRetry(to: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
  let last: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const nonce = await pub.getTransactionCount({ address: deployer.address, blockTag: "pending" });
      const hash = await wallet.writeContract({
        address: collateral, abi: erc20Abi, functionName: "transfer", args: [to, amount], nonce,
      });
      await pub.waitForTransactionReceipt({ hash });
      return hash;
    } catch (err) {
      last = err;
      if (!/nonce|replacement/i.test((err as Error).message ?? "")) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

let held = await pub.readContract({
  address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address],
}) as bigint;

console.log(`deployer   ${deployer.address}`);
console.log(`collateral ${collateral}`);
console.log(`holding    ${money(held)} tUSDC`);
console.log(`target     ${money(target)} tUSDC per independent owner\n`);

let sent = 0n;
let moves = 0;
for (const a of agents) {
  const vaultOwner = await pub.readContract({
    address: a.vault, abi: vaultAbi, functionName: "owner",
  }) as `0x${string}`;

  // The deployer's own vaults need no transfer: `fund-vaults` already deposits
  // straight out of this balance.
  if (vaultOwner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log(`  ${a.slug.padEnd(15)} deployer-owned — nothing to move`);
    continue;
  }

  const balance = await pub.readContract({
    address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [vaultOwner],
  }) as bigint;
  const label = `  ${a.slug.padEnd(15)} ${vaultOwner}  holds ${money(balance).padStart(10)}`;

  if (balance >= target) { console.log(`${label}  at or above target`); continue; }
  const amount = target - balance;

  if (!write) { console.log(`${label}  would send ${money(amount)}`); sent += amount; moves += 1; continue; }
  if (held < amount) { console.log(`${label}  SKIP: deployer holds only ${money(held)}`); continue; }

  const hash = await sendWithRetry(vaultOwner, amount);
  held -= amount;
  sent += amount;
  moves += 1;
  console.log(`${label}  sent ${money(amount)} -> ${money(target)} (${hash.slice(0, 14)}…)`);
}

console.log(
  write
    ? `\n${moves} transfer(s), ${money(sent)} tUSDC moved. Deployer now holds ${money(held)}.`
    : `\n${moves} transfer(s) would move ${money(sent)} tUSDC. Pass --write to send.`,
);
