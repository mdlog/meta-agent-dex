/**
 * Step 2 — deploy your vault and fund it.
 *
 * Reads the creation bytecode from `contracts/out/contracts.json`, which the
 * repo root builds with:
 *
 *   solc --combined-json abi,bin --optimize --via-ir \
 *        contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json
 *
 * `--via-ir` is required, not cosmetic: `redeemAll` destructures a 14-field
 * return and the legacy pipeline fails it with "stack too deep".
 *
 * `owner` is IMMUTABLE — compiled into the runtime bytecode, with no setter. Two
 * vaults that differ only in those twenty bytes are the on-chain proof that the
 * deployer of one holds no power over the other. Get it wrong and the only fix
 * is another deployment.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SHANNON, hexKey, env } from "./env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = env("CONTRACT_ARTIFACTS") ?? path.join(HERE, "../../contracts/out/contracts.json");

const owner = privateKeyToAccount(hexKey("OWNER_PRIVATE_KEY", "The wallet that will own the vault."));
const operator = privateKeyToAccount(hexKey("OPERATOR_PRIVATE_KEY", "Run `npm run keys` first."));

const pub = createPublicClient({ chain: somniaShannon, transport: http(SHANNON.rpc) });
const wallet = createWalletClient({ account: owner, chain: somniaShannon, transport: http(SHANNON.rpc) });

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(uint256 amount)",
]);
const vaultAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function nav() view returns (uint256)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
]);

const FUND = parseUnits(env("FUND_TUSDC") ?? "200", 6);

if (!fs.existsSync(ARTIFACTS)) {
  console.error(`\nNo compiled contracts at ${ARTIFACTS}.`);
  console.error("Build them from the repo root:\n");
  console.error("  solc --combined-json abi,bin --optimize --via-ir \\");
  console.error("       contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json\n");
  process.exit(1);
}
const combined = JSON.parse(fs.readFileSync(ARTIFACTS, "utf8")) as {
  contracts?: Record<string, { bin?: string }>;
};
const entry = Object.entries(combined.contracts ?? {}).find(([k]) => k.endsWith(":BotVault"));
if (!entry?.[1].bin) {
  console.error(`\n${ARTIFACTS} has no BotVault bytecode. Recompile it.\n`);
  process.exit(1);
}
const bin = (entry[1].bin.startsWith("0x") ? entry[1].bin : `0x${entry[1].bin}`) as `0x${string}`;

console.log(`owner    ${owner.address}`);
console.log(`operator ${operator.address}`);

const gas = await pub.getBalance({ address: owner.address });
if (gas === 0n) {
  console.error("\nThe owner address holds 0 STT. Deploying costs gas — fund it from the Somnia faucet.\n");
  process.exit(1);
}

// --- deploy ------------------------------------------------------------------
console.log("\ndeploying BotVault…");
const deployHash = await wallet.deployContract({
  abi: parseAbi(["constructor(address,address,address,address,address)"]),
  bytecode: bin,
  args: [SHANNON.collateral, SHANNON.binaryModule, SHANNON.outcomeToken, owner.address, operator.address],
});
const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
const vault = receipt.contractAddress;
if (!vault) {
  console.error("\nDeployment mined but produced no contract address. Check the transaction.\n");
  process.exit(1);
}
console.log(`  VAULT_ADDRESS=${vault}`);
console.log(`  ${deployHash}`);

// Read them back rather than trusting the arguments we just sent. `owner` is
// immutable, so this is the last chance to notice it is wrong while it is still
// cheap to fix.
const [onchainOwner, onchainOperator] = await Promise.all([
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "operator" }),
]);
console.log(`  owner()    ${onchainOwner}`);
console.log(`  operator() ${onchainOperator}`);

// --- fund --------------------------------------------------------------------
let held = (await pub.readContract({
  address: SHANNON.collateral, abi: erc20, functionName: "balanceOf", args: [owner.address],
})) as bigint;

if (held < FUND) {
  // Shannon's test collateral has a public faucet capped at 10,000 per call with
  // no cooldown, so this loops rather than failing.
  const CAP = 10_000_000_000n;
  const calls = Number((FUND - held + CAP - 1n) / CAP);
  console.log(`\nfaucet: ${calls} call(s) for ${formatUnits(FUND - held, 6)} tUSDC…`);
  for (let i = 0; i < calls; i += 1) {
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: SHANNON.collateral, abi: erc20, functionName: "faucet", args: [CAP] }),
    });
  }
  held = (await pub.readContract({
    address: SHANNON.collateral, abi: erc20, functionName: "balanceOf", args: [owner.address],
  })) as bigint;
}

console.log(`\ndepositing ${formatUnits(FUND, 6)} tUSDC…`);
await pub.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: SHANNON.collateral, abi: erc20, functionName: "approve", args: [vault, FUND] }),
});
const depositHash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [FUND] });
await pub.waitForTransactionReceipt({ hash: depositHash });

const nav = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" })) as bigint;
console.log(`  nav() = ${formatUnits(nav, 6)} tUSDC`);
console.log(`  ${depositHash}`);

console.log(`\nAdd this to .env, then run \`npm run register\`:\n\n  VAULT_ADDRESS=${vault}\n`);
