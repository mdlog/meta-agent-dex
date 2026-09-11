/**
 * Keeper loop for agent sessions.
 *
 * Sessions have to be opened, settled and followed on a clock, and none of that
 * can ride on page reads the way the old forecast settlement did — a session
 * that closes while nobody is looking at the site still owes its bettors a
 * resolution. This pokes the app's cycle route on an interval instead.
 *
 *   npm run cycle                 # run forever, 30s apart
 *   npm run cycle -- --once       # one pass, for a runbook step
 *   npm run cycle -- --open       # also open a new session for idle agents
 *
 * BASE defaults to the local server; point it at the public origin to keep a
 * demo alive from somewhere else.
 */

export {}; // this file is a module: top-level await needs it

import fs from "node:fs";

/**
 * Read `.env.local` the way every other script here does (fund-vaults,
 * treasury, start-speculators), rather than relying on whoever launched this to
 * have exported the token.
 *
 * It used to take the token from the environment alone. Started without one —
 * `nohup node --experimental-strip-types scripts/agent-cycle.ts --open &`, which
 * is exactly how a keeper gets restarted by hand — it fell back to "" and then
 * posted an unauthorised request every 30 seconds. Measured 2026-09-09: 80
 * minutes of 401s, eleven sessions past their close with nothing settled, no
 * NAV finalised and no vault able to take a deposit, because the failure looked
 * identical to a healthy loop from the outside. A keeper that cannot
 * authenticate is not a degraded keeper, it is a stopped one.
 *
 * An explicit environment variable still wins, so a remote BASE with its own
 * token keeps working.
 */
function fromEnvFile(name: string): string | undefined {
  try {
    for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === name) return trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .env.local is legitimate — a deployment may pass the token in the
    // environment. The check below is what catches having neither.
  }
  return undefined;
}

const BASE = process.env.BASE ?? "http://localhost:3009";
const TOKEN = process.env.AGENT_CYCLE_TOKEN ?? fromEnvFile("AGENT_CYCLE_TOKEN") ?? "";

// Fail at the top rather than once a minute forever. The route answers 401 to
// an empty token, and a loop that can only 401 should say so and stop.
if (TOKEN === "") {
  console.error(
    "AGENT_CYCLE_TOKEN is not set, and none was found in .env.local.\n" +
    "The cycle route answers 401 without it, so this loop would never settle a session.\n" +
    "Set it in .env.local, or export AGENT_CYCLE_TOKEN before starting the keeper.",
  );
  process.exit(1);
}
const once = process.argv.includes("--once");
const alsoOpen = process.argv.includes("--open");
const intervalMs = Number(process.env.CYCLE_INTERVAL_MS ?? 30_000);
/**
 * Session length, in seconds. Ninety minutes is not a preference: Shannon is
 * currently only rolling BTC/ETH series at 3600s and longer, and the vault
 * refuses any market that outlives the session — so a session shorter than an
 * hour contains nothing an agent may trade. It also holds minting to ~3 STT an
 * hour, which is what makes a day-long demo affordable.
 */
const DURATION_SEC = Number(process.env.CYCLE_DURATION_SEC ?? 5400);

const stamp = () => new Date().toISOString().slice(11, 19);

interface CycleResult {
  settled?: { sessionId: string; agent: string; navT0: string; navT1: string; outcome: number | null }[];
  opened?: { sessionId: string; agent: string; marketId: string | null; closesAt: number }[];
  sync?: { checked: number; settled: number; voided: number };
  errors?: { where: string; message: string }[];
}

async function pass(): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/cycle${alsoOpen ? `?open=1&duration=${DURATION_SEC}` : ""}`, {
    method: "POST",
    headers: TOKEN ? { "x-cycle-token": TOKEN } : {},
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`${stamp()}  ${res.status} ${text.slice(0, 300)}`);
    return;
  }

  const body = (await res.json()) as CycleResult;
  for (const s of body.settled ?? []) {
    const delta = BigInt(s.navT1) - BigInt(s.navT0);
    const dir = delta > 0n ? "UP" : delta < 0n ? "DOWN" : "FLAT";
    console.log(`${stamp()}  settled  ${s.agent}  NAV ${s.navT0} -> ${s.navT1} (${dir})  oracle answer ${s.outcome}`);
  }
  for (const o of body.opened ?? []) {
    console.log(`${stamp()}  opened   ${o.agent}  market ${o.marketId ?? "(mint failed)"}  closes ${new Date(o.closesAt).toISOString().slice(11, 19)}`);
  }
  if (body.sync && (body.sync.settled || body.sync.voided)) {
    console.log(`${stamp()}  committee: ${body.sync.settled} settled, ${body.sync.voided} voided (of ${body.sync.checked} waiting)`);
  }
  for (const e of body.errors ?? []) {
    console.error(`${stamp()}  ERROR ${e.where}: ${e.message}`);
  }
  if (!body.settled?.length && !body.opened?.length && !body.errors?.length) {
    console.log(`${stamp()}  idle`);
  }
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\nstopping after the current pass");
});

await pass();
if (!once) {
  while (!stopping) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stopping) break;
    try {
      await pass();
    } catch (err) {
      console.error(`${stamp()}  pass failed: ${(err as Error).message}`);
    }
  }
}
