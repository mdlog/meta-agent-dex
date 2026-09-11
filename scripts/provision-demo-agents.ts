export {}; // module: top-level await

/**
 * Stand up the demo fleet: three agents, three vaults, three declared strategies.
 *
 * Each agent gets its OWN operator key, generated here and never sent to the
 * server — the server is told an address and nothing else. That is not
 * ceremony: BotVault's `trade` is onlyOperator while `deposit`/`withdraw` are
 * onlyOwner, so a leaked operator key can move the agent's positions but can
 * never take its money. Reusing one key across three agents would also collide
 * their nonces, which is the failure the SDK warns about.
 *
 *   AGENT_CYCLE_TOKEN=… npm run provision
 *
 * Writes .data/demo-operators.json with the operator keys so the runners can be
 * started against them. That file is gitignored; it holds real keys.
 */

import fs from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = process.env.BASE ?? "http://localhost:3009";
const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const TOKEN = process.env.AGENT_CYCLE_TOKEN ?? env.AGENT_CYCLE_TOKEN;
if (!TOKEN) throw new Error("AGENT_CYCLE_TOKEN is not set");
const OWNER = privateKeyToAccount(
  (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`,
).address;

const FLEET = [
  {
    name: "Alpha-Z",
    strategy: "momentum",
    strategyParams: { edgeBps: 1500, maxStakeUsdc: 25, lookbackSec: 120 },
    blurb: "Trades with the move: takes the side the pool's implied probability is drifting toward.",
  },
  {
    name: "Neural Drift",
    strategy: "mean-reversion",
    strategyParams: { extremeBps: 2200, minSecondsToExpiry: 45, maxStakeUsdc: 25 },
    blurb: "Fades extremes: buys the cheap leg when the book prices a contract far from even.",
  },
  {
    name: "Kestrel 7",
    strategy: "momentum",
    strategyParams: { edgeBps: 2800, maxStakeUsdc: 15, lookbackSec: 60 },
    blurb: "A stricter Alpha-Z: same rule, higher bar, smaller size. Trades rarely and on purpose.",
  },
] as const;

const out: { name: string; slug: string; vault: string; operatorKey: string; operator: string }[] = [];

for (const spec of FLEET) {
  const operatorKey = generatePrivateKey();
  const operator = privateKeyToAccount(operatorKey).address;
  process.stdout.write(`provisioning ${spec.name} (operator ${operator.slice(0, 10)}…) `);

  const res = await fetch(`${BASE}/api/agents/provision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cycle-token": TOKEN },
    body: JSON.stringify({
      name: spec.name,
      strategy: spec.strategy,
      strategyParams: spec.strategyParams,
      blurb: spec.blurb,
      ownerAddress: OWNER,
      operatorAddress: operator,
      funding: "250000000",
    }),
  });

  const body = (await res.json()) as { agent?: { slug: string; vaultAddress: string }; error?: string; nextStep?: string };
  if (!res.ok || !body.agent) {
    console.log(`\n  FAILED ${res.status}: ${body.error ?? "unknown"}${body.nextStep ? ` — ${body.nextStep}` : ""}`);
    continue;
  }
  console.log(`→ vault ${body.agent.vaultAddress}`);
  out.push({ name: spec.name, slug: body.agent.slug, vault: body.agent.vaultAddress, operatorKey, operator });
}

fs.mkdirSync(".data", { recursive: true });
fs.writeFileSync(".data/demo-operators.json", JSON.stringify(out, null, 2));
console.log(`\n${out.length}/${FLEET.length} provisioned. Operator keys in .data/demo-operators.json (gitignored).`);
