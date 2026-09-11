export {}; // module: top-level await

/**
 * Stand up agents whose vaults are not ours.
 *
 * Every agent provisioned through the keeper is deployed by, and owned by, the
 * one `DEPLOYER_PRIVATE_KEY` the server holds — so a reader checking the
 * contracts finds a single creator behind all of them, which is a weak answer
 * to "are these independent agents?". This registers ones that are genuinely
 * separate: a fresh wallet sends the creation transaction, is the vault's
 * `owner`, funds it from its own balance, and proves the key with an EIP-191
 * signature through `POST /api/agents` — the registration path that exists for
 * a vault the developer deployed themselves. The keeper's `/provision` route is
 * deliberately not used: that one spends our STT and makes us the creator again.
 *
 * The separation is checkable on chain, and is visible in the bytecode itself:
 * `owner` is `immutable`, so it is baked into each vault's runtime code.
 *   creator    — the new wallet sent the CREATE, so the explorer names it
 *   owner()    — the same wallet; only it may deposit, withdraw, openSession
 *   operator() — a third key, which may only call trade()
 *
 * TWO PHASES, because the wallets are funded by hand:
 *
 *   npm run new-agent -- --prepare --count 3
 *       generates the keys, writes .data/pending-agents.json, prints the
 *       addresses to fund. Sends nothing.
 *
 *   npm run new-agent -- --finish
 *       for every pending agent whose wallets have arrived: deploy, deposit,
 *       register, and hand the keeper its owner key. Skips the ones still short
 *       and says what they are waiting for, so it is safe to re-run.
 *
 * `--self-fund` on --prepare funds the new wallets from the deployer instead,
 * which is the one-shot path used before the wallets were funded by hand.
 */

import fs from "node:fs";
import {
  concatHex, createPublicClient, createWalletClient, encodeAbiParameters, formatEther,
  formatUnits, http, parseAbi, parseAbiParameters, parseEther, parseUnits, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const PREPARE = args.includes("--prepare");
const FINISH = args.includes("--finish");
const SELF_FUND = args.includes("--self-fund");
const COUNT = Number(flag("count") ?? 1);
const NAMES = (flag("names") ?? flag("name") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const STRATEGY = flag("strategy") ?? "momentum";
const BASE = process.env.BASE ?? "http://localhost:3009";
const RPC = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;
const BINARY_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as Address;
const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as Address;
const PENDING = ".data/pending-agents.json";
const OWNERS_FILE = ".data/agent-owners.json";

/**
 * Floors, not budgets. Measured on the first independent agent: the owner spent
 * 0.143 STT to deploy, faucet, approve and deposit, and the operator 0.034 STT
 * across an hour of trading. These leave room for a long session clock without
 * asking for STT nobody will burn.
 */
const OWNER_GAS_FLOOR = parseEther("0.3");
const OPERATOR_GAS_FLOOR = parseEther("0.1");
const OWNER_GAS_SUGGESTED = parseEther("1.5");
const OPERATOR_GAS_SUGGESTED = parseEther("1");
const TUSDC_SUGGESTED = parseUnits("200", 6);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const vaultAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function nav() view returns (uint256)",
]);

const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
const readPending = (): PendingAgent[] =>
  fs.existsSync(PENDING) ? (JSON.parse(fs.readFileSync(PENDING, "utf8")) as PendingAgent[]) : [];
const writePending = (rows: PendingAgent[]) => {
  fs.mkdirSync(".data", { recursive: true });
  fs.writeFileSync(PENDING, JSON.stringify(rows, null, 2));
};

/**
 * Declared parameter name -> the runner env that sets it.
 *
 * The declaration is hashed into `configHash` and written to the meta-market's
 * on-chain context, and NOTHING checks that the runner was actually started
 * with what the agent declared — the runner never reads its own declaration.
 * So the link has to be made here: these keys are the runner's own Config field
 * names, and `--finish` prints the exact env for each agent from the values it
 * registered. A declaration nobody can act on differently is the only kind
 * worth hashing.
 */
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

interface PendingAgent {
  name: string;
  strategy: string;
  params: Record<string, number | string>;
  ownerKey: Hex;
  ownerAddress: Address;
  operatorKey: Hex;
  operatorAddress: Address;
}

if (!PREPARE && !FINISH) {
  console.log("Pass --prepare (generate wallets to fund) or --finish (deploy the funded ones).");
  console.log("  npm run new-agent -- --prepare --count 3");
  console.log("  npm run new-agent -- --finish");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// --prepare
// ---------------------------------------------------------------------------
if (PREPARE) {
  const pending = readPending();
  // A spec file is how agents get DIFFERENT declarations. Without one every
  // agent from a single --prepare shares one strategy and declares no
  // parameters at all, which is how four agents ended up with `{}` in their
  // configHash — a hash over nothing, on a page that calls it "hashed before
  // anyone bet".
  const specPath = flag("spec");
  const spec: { name: string; strategy: string; params?: Record<string, number | string> }[] =
    specPath ? JSON.parse(fs.readFileSync(specPath, "utf8")) : [];
  const count = spec.length > 0 ? spec.length : COUNT;

  const made: PendingAgent[] = [];
  for (let i = 0; i < count; i += 1) {
    const ownerKey = generatePrivateKey();
    const operatorKey = generatePrivateKey();
    const from = spec[i];
    const params = from?.params ?? {};
    for (const k of Object.keys(params)) {
      if (!(k in PARAM_ENV)) {
        throw new Error(`"${k}" is not a parameter the runner reads. Known: ${Object.keys(PARAM_ENV).join(", ")}`);
      }
    }
    made.push({
      name: from?.name ?? NAMES[i] ?? `Agent ${pending.length + i + 1}`,
      strategy: from?.strategy ?? STRATEGY,
      params,
      ownerKey,
      ownerAddress: privateKeyToAccount(ownerKey).address,
      operatorKey,
      operatorAddress: privateKeyToAccount(operatorKey).address,
    });
  }
  writePending([...pending, ...made]);

  console.log(`Prepared ${made.length} agent${made.length === 1 ? "" : "s"}. Nothing has been sent.\n`);
  console.log("Fund these, then run:  npm run new-agent -- --finish\n");
  for (const a of made) {
    console.log(`${a.name}  (${a.strategy})`);
    console.log(`  declares  ${Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(" ") || "(nothing)"}`);
    console.log(`  owner     ${a.ownerAddress}`);
    console.log(`            needs ${formatEther(OWNER_GAS_SUGGESTED)} STT  +  ${formatUnits(TUSDC_SUGGESTED, 6)} tUSDC`);
    console.log(`            the STT is gas for the deploy and every openSession; the tUSDC becomes the vault's capital`);
    console.log(`  operator  ${a.operatorAddress}`);
    console.log(`            needs ${formatEther(OPERATOR_GAS_SUGGESTED)} STT  (gas only — this key can never hold collateral)`);
    console.log("");
  }
  console.log(`Totals: ${formatEther(OWNER_GAS_SUGGESTED * BigInt(made.length) + OPERATOR_GAS_SUGGESTED * BigInt(made.length))} STT` +
    ` and ${formatUnits(TUSDC_SUGGESTED * BigInt(made.length), 6)} tUSDC across ${made.length * 2} wallets.`);
  console.log(`Keys are in ${PENDING} (gitignored). --finish deposits whatever tUSDC the owner holds.`);

  if (SELF_FUND) {
    const funder = privateKeyToAccount(
      (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as Hex,
    );
    const w = createWalletClient({ account: funder, chain: somniaShannon, transport: http(RPC) });
    console.log("\n--self-fund: sending from the deployer instead");
    for (const a of made) {
      await wait(await w.sendTransaction({ to: a.ownerAddress, value: OWNER_GAS_SUGGESTED }));
      await wait(await w.sendTransaction({ to: a.operatorAddress, value: OPERATOR_GAS_SUGGESTED }));
      console.log(`   ${a.name}: gas sent to both keys`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --finish
// ---------------------------------------------------------------------------
const pending = readPending();
if (pending.length === 0) {
  console.log(`Nothing pending in ${PENDING}. Run --prepare first.`);
  process.exit(0);
}

const artifact = JSON.parse(fs.readFileSync("contracts/out/contracts.json", "utf8")) as
  { contracts: Record<string, { bin: string }> };
const bin = artifact.contracts["contracts/BotVault.sol:BotVault"].bin;

const stillWaiting: PendingAgent[] = [];
let done = 0;

for (const a of pending) {
  const [gas, cash, opGas] = await Promise.all([
    pub.getBalance({ address: a.ownerAddress }),
    pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [a.ownerAddress] }) as Promise<bigint>,
    pub.getBalance({ address: a.operatorAddress }),
  ]);

  const short: string[] = [];
  if (gas < OWNER_GAS_FLOOR) short.push(`owner STT ${formatEther(gas)} < ${formatEther(OWNER_GAS_FLOOR)}`);
  if (cash === 0n) short.push("owner holds no tUSDC");
  if (opGas < OPERATOR_GAS_FLOOR) short.push(`operator STT ${formatEther(opGas)} < ${formatEther(OPERATOR_GAS_FLOOR)}`);
  if (short.length > 0) {
    console.log(`${a.name}: waiting — ${short.join("; ")}`);
    stillWaiting.push(a);
    continue;
  }

  // Deposit exactly what the owner was given: the funding decision is the
  // human's, and second-guessing it here would leave collateral stranded in a
  // wallet that has no other job.
  const funding = flag("funding") ? parseUnits(flag("funding")!, 6) : cash;
  console.log(`${a.name}: owner ${formatEther(gas)} STT, ${formatUnits(cash, 6)} tUSDC — depositing ${formatUnits(funding, 6)}`);

  const owner = privateKeyToAccount(a.ownerKey);
  const ownerWallet = createWalletClient({ account: owner, chain: somniaShannon, transport: http(RPC) });

  // Constructor order is the separation of powers: collateral, module, outcome
  // token, then owner and operator. Sent from the OWNER's wallet, which is what
  // makes it the creator on the explorer.
  const deployTx = await ownerWallet.sendTransaction({
    data: concatHex([
      (bin.startsWith("0x") ? bin : `0x${bin}`) as Hex,
      encodeAbiParameters(parseAbiParameters("address, address, address, address, address"), [
        COLLATERAL, BINARY_MODULE, OUTCOME_TOKEN, owner.address, a.operatorAddress,
      ]),
    ]),
  });
  const receipt = await wait(deployTx);
  const vault = receipt.contractAddress;
  if (!vault) throw new Error(`${a.name}: deploy mined with no contract address (tx ${deployTx})`);
  console.log(`   vault ${vault}  (${deployTx.slice(0, 14)}…)`);

  await wait(await ownerWallet.writeContract({ address: COLLATERAL, abi: erc20, functionName: "approve", args: [vault, funding] }));
  await wait(await ownerWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [funding] }));

  const nonce = `Meta-Agent DEX — register ${a.name} at ${new Date().toISOString()}`;
  const signature = await ownerWallet.signMessage({ account: owner, message: nonce });
  const res = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: a.name, strategy: a.strategy, strategyParams: a.params, ownerAddress: owner.address,
      vaultAddress: vault, operatorAddress: a.operatorAddress,
      blurb: "Deployed and owned by its own wallet, registered by signature.",
      nonce, signature,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${a.name}: registration failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  const agent = body.agent as { slug: string; name: string };

  // Without the owner key the keeper cannot call `openSession` — it is
  // onlyOwner, and the owner is no longer the deployer.
  const owners: Record<string, string> = fs.existsSync(OWNERS_FILE)
    ? JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8")) : {};
  owners[vault.toLowerCase()] = a.ownerKey;
  fs.writeFileSync(OWNERS_FILE, JSON.stringify(owners, null, 2));

  const ops = JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as unknown[];
  // The params travel with the key, so whatever starts this runner can set the
  // env the agent declared rather than the demo's defaults.
  ops.push({
    name: agent.name, slug: agent.slug, vault: vault.toLowerCase(),
    operatorKey: a.operatorKey, operator: a.operatorAddress,
    strategy: a.strategy, params: a.params,
  });
  fs.writeFileSync(".data/demo-operators.json", JSON.stringify(ops, null, 2));

  const nav = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }) as bigint;
  console.log(`   registered /agents/${agent.slug} — nav ${formatUnits(nav, 6)} tUSDC, creator and owner ${owner.address}`);
  const envLine = Object.entries(a.params).map(([k, v]) => `${PARAM_ENV[k]}=${v}`).join(" ");
  console.log(`   run it with: AGENT_STRATEGY=${a.strategy} ${envLine}\n`);
  done += 1;
}

writePending(stillWaiting);
console.log(`${done} registered, ${stillWaiting.length} still waiting on funds.`);
if (done > 0) console.log("Rebuild runners.txt and start their runners; the keeper opens their first sessions on its own.");
