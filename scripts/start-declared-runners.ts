export {}; // module: top-level await

/**
 * Start each agent's runner with the parameters that agent DECLARED.
 *
 * `configHash` is keccak256 over {name, strategy, strategyParams}, and it is
 * written into the meta-market's on-chain context at mint. Nothing checks that
 * the runner was started with those values — the runner never reads its own
 * declaration — so "the agent did what it said" is only true if whatever
 * launches it uses the declaration as the source of its env. That is this file.
 *
 * An agent that declared no parameters gets the demo defaults and is named in
 * the output, because a hash over `{}` promises nothing and the operator should
 * see which agents are in that state.
 *
 *   npm run runners                      # every registered agent
 *   npm run runners -- kinetic-arc longwave
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

/** Declared parameter name -> the runner env that sets it. */
const PARAM_ENV: Record<string, string> = {
  driftThreshold: "AGENT_DRIFT_THRESHOLD",
  lookbackSec: "AGENT_LOOKBACK_SEC",
  reversionBand: "AGENT_REVERSION_BAND",
  minRevertSec: "AGENT_MIN_REVERT_SEC",
  maxOrder: "AGENT_MAX_ORDER",
  cooldownMs: "AGENT_COOLDOWN_MS",
  maxPerMarket: "AGENT_MAX_PER_MARKET",
  minCash: "AGENT_MIN_CASH",
};

/**
 * Only where the declaration is silent.
 *
 * THE THRESHOLD HAS TO CLEAR THE COST OF ENTRY, and it did not. Every order is
 * IOC — `BotVault` has `trade` and no `cancelOrder`, so an agent is always the
 * taker and always pays the spread rather than earning it. Measured on Shannon
 * 2026-09-09: median spread 2.8 points across the BTC/ETH series they trade,
 * plus 3 ticks of deliberate crossing, so entry costs about 3.1 points. This
 * fallback asked for 0.8 (`AGENT_DRIFT_THRESHOLD: "8000"`), which means an
 * agent opened a position on a move a quarter the size of the fee it paid to
 * open it. Over 114 settled sessions that produced 20 wins against 70 losses
 * and −3,097.76 tUSDC, with no agent cumulatively positive — a result the
 * strategies never had the chance to influence.
 *
 * 45000 is 4.5 points: entry cost plus roughly half again, so a correct call
 * is worth making. The cost of it is frequency — the agents trade several times
 * a session instead of sixteen — and that trade-off is the honest one, because
 * the sixteen were not free.
 */
const FALLBACK = {
  AGENT_POLL_MS: "8000",
  AGENT_LOOKBACK_SEC: "30",
  AGENT_DRIFT_THRESHOLD: "45000",
  AGENT_MIN_RUNWAY_SEC: "45",
  // A fade needs the same clearance. 0.12 from even was under the old threshold
  // logic worth taking; against a 3.1-point round trip it is not.
  AGENT_MIN_REVERT_SEC: "60",
  AGENT_REVERSION_BAND: "180000",
  AGENT_COOLDOWN_MS: "30000",
  AGENT_MAX_ORDER: "15000000",
  // Reach one tick through the touch, not three. The extra two bought nothing
  // an IOC could not get at the touch, and cost 0.2 points on every fill.
  AGENT_CROSS_TICKS: "1",
};

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

interface Operator {
  name: string; slug: string; vault: string; operatorKey: string;
  strategy?: string; params?: Record<string, number | string>;
}
const ops = JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as Operator[];
const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = want.length > 0 ? ops.filter((o) => want.includes(o.slug)) : ops;
if (targets.length === 0) throw new Error(`no agent matched ${want.join(", ")}`);

fs.mkdirSync(".data/logs", { recursive: true });
const undeclared: string[] = [];

for (const o of targets) {
  const declared: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.params ?? {})) {
    const name = PARAM_ENV[k];
    if (name) declared[name] = String(v);
  }
  if (Object.keys(declared).length === 0) undeclared.push(o.slug);

  const out = fs.openSync(`.data/logs/runner-${o.slug}.log`, "a");
  const child = spawn("node", ["--experimental-strip-types", "bots/runner.ts"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ...FALLBACK,
      // The declaration wins over every default above it.
      ...declared,
      AGENT_STRATEGY: o.strategy ?? "momentum",
      AGENT_OPERATOR_KEY: o.operatorKey,
      AGENT_VAULT: o.vault,
      AGENT_SLUG: o.slug,
      AGENT_API: process.env.AGENT_API ?? "http://localhost:3009",
      SOMNIA_RPC_URL: env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network",
      SOMNIA_INDEXER_URL: env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
      SOMNIA_WS_RPC_URL: env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
    },
  });
  child.unref();
  const shown = Object.entries(declared).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`  ${o.slug.padEnd(15)} ${(o.strategy ?? "momentum").padEnd(15)} pid ${child.pid}`);
  console.log(`     ${shown || "(declared nothing — running on demo defaults)"}`);
}

if (undeclared.length > 0) {
  console.log(`\n  ${undeclared.length} agent(s) declared no parameters: ${undeclared.join(", ")}`);
  console.log("  Their configHash is a hash over {}, so it promises nothing about how they trade.");
}
