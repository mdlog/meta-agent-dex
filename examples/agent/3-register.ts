/**
 * Step 3 — register the agent.
 *
 * Signature-gated, not token-gated: anyone may register. The proof matters
 * because registration writes an owner address into a permanent row and derives
 * the `configHash` that goes into your meta-market's on-chain `context`, where it
 * can never be corrected. A self-asserted header would let anyone publish a
 * strategy declaration under a wallet they do not hold.
 *
 * WHAT YOU DECLARE HERE IS A PROMISE, NOT A SETTING. `strategyParams` is hashed
 * and published; the runner never reads it. Nothing forces the numbers you
 * declare to match the numbers your bot runs on — so this script sends the exact
 * values from your `.env`, which is the only way to keep them honest without
 * hoping you remembered.
 */

import { privateKeyToAccount } from "viem/accounts";
import { ARENA, hexKey, env, num } from "./env.ts";

const owner = privateKeyToAccount(hexKey("OWNER_PRIVATE_KEY", "The wallet that owns the vault."));
const operator = privateKeyToAccount(hexKey("OPERATOR_PRIVATE_KEY", "Run `npm run keys` first."));
const vault = env("VAULT_ADDRESS");
if (!vault) {
  console.error("\nVAULT_ADDRESS is not set. Run `npm run deploy` first.\n");
  process.exit(1);
}

// The declaration and the runtime configuration are the same object, read once.
// Two copies would drift, and the drift would be invisible: the hash would still
// verify against what was declared while the bot ran on something else.
const strategyParams = {
  lookbackSec: num("LOOKBACK_SEC", 90),
  driftThreshold: num("DRIFT_THRESHOLD", 45000),
  maxEntry: num("MAX_ENTRY", 650000),
  maxOrder: num("MAX_ORDER", 15000000),
};

const nonce = `Meta-Agent DEX — register agent ${new Date().toISOString()}`;
const signature = await owner.signMessage({ message: nonce });

const res = await fetch(`${ARENA}/api/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: env("AGENT_NAME") ?? "Example Agent",
    ownerAddress: owner.address,
    vaultAddress: vault,
    operatorAddress: operator.address,
    strategy: "momentum",
    strategyParams,
    blurb: env("AGENT_BLURB") ?? "Buys a move that is bigger than the spread it costs to buy it.",
    nonce,
    signature,
  }),
});

const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
if (!res.ok) {
  console.error(`\nHTTP ${res.status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

const agent = body.agent as { slug: string; configHash: string; name: string } | undefined;
if (!agent) {
  console.error("\nRegistered, but the response carried no agent:");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`\nregistered  ${agent.name}`);
console.log(`  slug        ${agent.slug}`);
console.log(`  configHash  ${agent.configHash}`);
console.log(`  declared    ${JSON.stringify(strategyParams)}`);
console.log(`\n  ${ARENA}/agents/${agent.slug}`);
console.log(`\nCheck that configHash against what you meant to declare — after the`);
console.log(`first mint it is on chain for good. Then add to .env:\n`);
console.log(`  AGENT_SLUG=${agent.slug}\n`);
