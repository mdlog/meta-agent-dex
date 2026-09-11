export {}; // module: top-level await

/**
 * Stand up the layer-2 speculator agents.
 *
 * Two theses on two keys, on purpose: a backer and a skeptic looking at the
 * same board reach opposite conclusions, and their resting orders cross. That
 * is the only way a meta-market gets a price — until now every book on the
 * venue has been empty, because nothing was quoting.
 *
 * Each speculator signs for itself with a key generated here. It is never the
 * deployer key: the deployer owns the vaults being measured, and a measurer
 * that shares a key with the measured is not evidence of anything. The tUSDC
 * stake comes from the collateral's own permissionless faucet, which the agent
 * calls and logs — the same faucet whose existence is why BotVault.nav() counts
 * DreamDEX deliveries rather than balances.
 *
 *   node --experimental-strip-types scripts/start-speculators.ts
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const API = process.env.AGENT_API ?? "http://localhost:3009";
const funder = privateKeyToAccount(
  (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`,
);
const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wallet = createWalletClient({ account: funder, chain: somniaShannon, transport: http(RPC) });

const THESES = ["backer", "skeptic"] as const;
const GAS = parseEther("0.4");

const existing: { thesis: string; key: string; address: string }[] =
  fs.existsSync(".data/speculators.json") ? JSON.parse(fs.readFileSync(".data/speculators.json", "utf8")) : [];

const fleet = THESES.map((thesis) => {
  const found = existing.find((e) => e.thesis === thesis);
  if (found) return found;
  const key = generatePrivateKey();
  return { thesis, key, address: privateKeyToAccount(key).address };
});
fs.mkdirSync(".data", { recursive: true });
fs.writeFileSync(".data/speculators.json", JSON.stringify(fleet, null, 2));

/**
 * The keeper signs with this same deployer key from inside the app, where a
 * queue serialises its writes. This is a separate process, so that queue does
 * not cover us: viem fetches a pending nonce, the keeper takes it first, and our
 * send comes back "nonce too low". Re-read and retry rather than pre-allocating,
 * because the keeper may land several transactions between our attempts.
 */
async function fundWithRetry(to: `0x${string}`, value: bigint, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const nonce = await pub.getTransactionCount({ address: funder.address, blockTag: "pending" });
      const hash = await wallet.sendTransaction({ to, value, nonce });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  ${label} funded ${formatEther(value)} STT (${hash.slice(0, 14)}…)`);
      return;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!/nonce/i.test(message) || attempt === 6) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

for (const s of fleet) {
  const balance = await pub.getBalance({ address: s.address as `0x${string}` });
  if (balance < parseEther("0.15")) {
    await fundWithRetry(s.address as `0x${string}`, GAS, `${s.thesis.padEnd(10)} ${s.address}`);
  } else {
    console.log(`  ${s.thesis.padEnd(10)} ${s.address} has ${formatEther(balance)} STT`);
  }
}

fs.mkdirSync(".data/logs", { recursive: true });
for (const s of fleet) {
  const out = fs.openSync(`.data/logs/speculator-${s.thesis}.log`, "a");
  const child = spawn("node", ["--experimental-strip-types", "bots/speculator.ts"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      AGENT_SPECULATOR_KEY: s.key,
      AGENT_THESIS: s.thesis,
      AGENT_API: API,
      AGENT_POLL_MS: process.env.AGENT_POLL_MS ?? "15000",
      AGENT_MIN_RUNWAY_SEC: process.env.AGENT_MIN_RUNWAY_SEC ?? "120",
      AGENT_MAX_STAKE: process.env.AGENT_MAX_STAKE ?? "20000000",
      // Wound down by default. The trading this project is judged on happens
      // on Somnia's own price series; the BOTNAV meta-markets these two price
      // are minted here, so a speculator taking the other side of one is this
      // project trading with itself. They stay up to redeem — an outcome token
      // is worthless until it is — and take no new position.
      //
      // Turn the layer back on deliberately, not by forgetting:
      //   AGENT_WIND_DOWN=0 npm run speculators
      AGENT_WIND_DOWN: process.env.AGENT_WIND_DOWN ?? "1",
      SOMNIA_RPC_URL: RPC,
      SOMNIA_INDEXER_URL: env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
      SOMNIA_WS_RPC_URL: env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
    },
  });
  child.unref();
  console.log(`  started ${s.thesis} (pid ${child.pid}) -> .data/logs/speculator-${s.thesis}.log`);
}
console.log("\nup. tail -f .data/logs/speculator-backer.log");
