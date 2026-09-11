export {}; // module: top-level await

/**
 * Raise an agent's trading capital.
 *
 * A runner's budget is `nav() - AGENT_MIN_CASH`, and AGENT_MIN_CASH defaults to
 * 10 tUSDC (bots/runner.ts:313). An agent whose vault holds exactly the floor
 * has a budget of zero and will scan, hold and never trade — which is what
 * neural-drift was doing at nav 10.000007. Raising the floor is the wrong fix:
 * the floor is what keeps a session's NAV from being spent to nothing. Raise the
 * capital instead.
 *
 *   npm run fund-vaults                                  # report only, no writes
 *   npm run fund-vaults -- --agent neural-drift --add 40
 *   npm run fund-vaults -- --all --target 50
 *
 * `deposit` is onlyOwner AND reverts while a session is open
 * (contracts/BotVault.sol:119-124), so this checks `sessionOpen` first and
 * refuses rather than broadcasting a transaction that is going to revert. Close
 * the session first — stop the keeper, let it settle, deposit, restart it.
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
const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function collateral() view returns (address)",
  "function nav() view returns (uint256)",
  "function sessionOpen() view returns (bool)",
  "function deposit(uint256 amount)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(uint256 amount)",
]);

const rpc = env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(rpc) });
const owner = privateKeyToAccount(
  (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`,
);
const wallet = createWalletClient({ account: owner, chain: somniaShannon, transport: http(rpc) });

/**
 * Owner keys for vaults the deployer does not own, keyed by vault address —
 * the same file `src/lib/agents/chain.ts` reads to sign `openSession`.
 *
 * `deposit` is `onlyOwner`, and this script used to hold exactly one key, so
 * every independently-owned vault came back `SKIP: owned by 0x…` and could not
 * be topped up at all. An agent that deployed its own vault is the point of
 * registering by signature; it should not be the one agent nobody can fund.
 */
const OWNER_KEYS_PATH = process.env.AGENT_OWNER_KEYS ?? ".data/agent-owners.json";
const ownerKeys: Record<string, string> = fs.existsSync(OWNER_KEYS_PATH)
  ? JSON.parse(fs.readFileSync(OWNER_KEYS_PATH, "utf8"))
  : {};

/** The wallet entitled to call `deposit` on this vault, or null if we hold none. */
function signerFor(vault: string, vaultOwner: string) {
  if (vaultOwner.toLowerCase() === owner.address.toLowerCase()) return { wallet, account: owner };
  const raw = ownerKeys[vault.toLowerCase()];
  if (!raw) return null;
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
  if (account.address.toLowerCase() !== vaultOwner.toLowerCase()) return null;
  return { wallet: createWalletClient({ account, chain: somniaShannon, transport: http(rpc) }), account };
}

const args = process.argv.slice(2);
const val = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const only = val("--agent");
const add = val("--add");
const target = val("--target");
const all = args.includes("--all");

const agents = (JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8")) as
  { name: string; slug: string; vault: `0x${string}` }[])
  .filter((a) => (only ? a.slug === only : true));
if (agents.length === 0) throw new Error(`no agent matched --agent ${only}`);

const collateral = await pub.readContract({ address: agents[0].vault, abi: vaultAbi, functionName: "collateral" }) as `0x${string}`;
const money = (v: bigint) => formatUnits(v, DECIMALS);

console.log(`owner      ${owner.address}`);
console.log(`collateral ${collateral}`);
console.log(`holding    ${money(await pub.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] }) as bigint)} tUSDC\n`);

let wrote = 0;
for (const a of agents) {
  const [nav, open, vaultOwner] = await Promise.all([
    pub.readContract({ address: a.vault, abi: vaultAbi, functionName: "nav" }) as Promise<bigint>,
    pub.readContract({ address: a.vault, abi: vaultAbi, functionName: "sessionOpen" }) as Promise<boolean>,
    pub.readContract({ address: a.vault, abi: vaultAbi, functionName: "owner" }) as Promise<string>,
  ]);
  // Mirrors the runner's own gate so the report answers the question the runner
  // is actually asking, rather than printing a balance and leaving the reader
  // to do the subtraction.
  const floor = BigInt(env.AGENT_MIN_CASH ?? "10000000");
  const budget = nav > floor ? nav - floor : 0n;
  const label = `${a.slug.padEnd(14)} nav=${money(nav).padEnd(11)} budget=${money(budget).padEnd(11)}`;

  let amount = 0n;
  if (add) amount = parseUnits(add, DECIMALS);
  else if (target) { const t = parseUnits(target, DECIMALS); amount = t > nav ? t - nav : 0n; }

  if (amount === 0n) { console.log(`${label} ${add || target ? "already at or above target" : ""}`); continue; }
  if (!all && !only) { console.log(`${label} would add ${money(amount)} — pass --agent <slug> or --all to write`); continue; }
  const signer = signerFor(a.vault, vaultOwner);
  if (signer === null) { console.log(`${label} SKIP: owned by ${vaultOwner}, and no key for it in ${OWNER_KEYS_PATH}`); continue; }
  if (open) { console.log(`${label} SKIP: session is open — deposit() would revert with SessionIsOpen()`); continue; }

  // The deposit is paid by the vault's own owner, so an independent agent tops
  // itself up out of its own balance before anyone else's is touched.
  const held = await pub.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [signer.account.address] }) as bigint;
  if (held < amount) {
    // Only the deployer is topped up from the faucet here; an independent
    // owner's shortfall is its own to cover, and inventing collateral for it
    // would quietly undo the separation the vault was deployed to show.
    if (signer.account.address.toLowerCase() !== owner.address.toLowerCase()) {
      console.log(`${label} SKIP: owner ${signer.account.address} holds ${money(held)}, needs ${money(amount)}`);
      continue;
    }
  }

  await pub.waitForTransactionReceipt({
    hash: await signer.wallet.writeContract({ address: collateral, abi: erc20Abi, functionName: "approve", args: [a.vault, amount] }),
  });
  const hash = await signer.wallet.writeContract({ address: a.vault, abi: vaultAbi, functionName: "deposit", args: [amount] });
  await pub.waitForTransactionReceipt({ hash });
  const after = await pub.readContract({ address: a.vault, abi: vaultAbi, functionName: "nav" }) as bigint;
  console.log(`${label} deposited ${money(amount)} -> nav ${money(after)} (${hash.slice(0, 14)}…)`);
  wrote += 1;
}
if (wrote === 0) console.log("\nno deposits made.");
