export {}; // module: top-level await

/**
 * The funding wallet for the agent fleet.
 *
 * Every key in this system has one job and holds only what that job needs. The
 * treasury is the exception: it holds the balance so that no working key has to.
 * That separation is not bookkeeping — an operator key lives on a laptop through
 * a demo, and the reason it can be treated as disposable is that it never holds
 * anything worth taking.
 *
 *   npm run treasury                    # what everything holds right now
 *   npm run treasury -- --keeper 20     # send 20 STT to the keeper (it pays for minting)
 *   npm run treasury -- --agents        # top every operator and speculator key up to its floor
 *
 * Minting is the only real drain: a meta-market costs ~1.496 STT and three are
 * minted per session. Gas for trading is rounding error beside it.
 */

import fs from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const hex = (v: string) => (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });

if (!env.TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY missing from .env.local");
const treasury = privateKeyToAccount(hex(env.TREASURY_PRIVATE_KEY));
const wallet = createWalletClient({ account: treasury, chain: somniaShannon, transport: http(RPC) });
const keeper = privateKeyToAccount(hex(env.DEPLOYER_PRIVATE_KEY));

/** Enough gas for a long session of trading, and no more. */
/** Below this, a key is refilled. Roughly 50 trades at the measured 0.0057 STT. */
const AGENT_FLOOR = parseEther("0.3");
/** Sent as a flat amount when the floor is breached — NOT a top-up to this
 *  balance. A key at 0.01 ends at 0.61, not at 0.6. */
const AGENT_TOP_UP = parseEther("0.6");

interface Holder { label: string; address: `0x${string}` }

const holders: Holder[] = [{ label: "keeper (mints markets)", address: keeper.address }];
for (const f of [".data/demo-operators.json", ".data/speculators.json"]) {
  if (!fs.existsSync(f)) continue;
  for (const row of JSON.parse(fs.readFileSync(f, "utf8")) as { name?: string; thesis?: string; operator?: string; address?: string }[]) {
    const address = (row.operator ?? row.address) as `0x${string}` | undefined;
    if (address) holders.push({ label: row.name ?? row.thesis ?? "agent", address });
  }
}

/**
 * The keeper signs from inside the app on its own schedule, so a nonce we read
 * can be taken before our send lands. Re-read and retry rather than pre-allocating.
 */
async function send(to: `0x${string}`, value: bigint, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const nonce = await pub.getTransactionCount({ address: treasury.address, blockTag: "pending" });
      const hash = await wallet.sendTransaction({ to, value, nonce });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  → ${label}: sent ${formatEther(value)} STT (${hash.slice(0, 14)}…)`);
      return;
    } catch (err) {
      if (!/nonce/i.test((err as Error).message ?? "") || attempt === 6) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const balance = await pub.getBalance({ address: treasury.address });
console.log(`treasury ${treasury.address}`);
console.log(`  balance ${formatEther(balance)} STT\n`);

const args = process.argv.slice(2);
const keeperIdx = args.indexOf("--keeper");

if (keeperIdx !== -1) {
  const amount = parseEther(args[keeperIdx + 1] ?? "20");
  if (balance <= amount) throw new Error(`treasury holds ${formatEther(balance)} STT, cannot send ${formatEther(amount)}`);
  await send(keeper.address, amount, "keeper");
} else if (args.includes("--agents")) {
  for (const h of holders.slice(1)) {
    const held = await pub.getBalance({ address: h.address });
    if (held >= AGENT_FLOOR) { console.log(`  ${h.label}: ${formatEther(held)} STT, enough`); continue; }
    await send(h.address, AGENT_TOP_UP, h.label);
  }
} else {
  for (const h of holders) {
    console.log(`  ${h.label.padEnd(24)} ${h.address}  ${formatEther(await pub.getBalance({ address: h.address }))} STT`);
  }
  console.log(`\n  --keeper <stt>   fund the wallet that pays ~1.496 STT per meta-market`);
  console.log(`  --agents         send ${formatEther(AGENT_TOP_UP)} STT to every trading and speculator key under ${formatEther(AGENT_FLOOR)} STT`);
}
