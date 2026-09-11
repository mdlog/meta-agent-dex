/**
 * Spike 8 — close the loop the whole product depends on.
 *
 * redeemAll() and closeSession() are permissionless on purpose: if only the
 * operator could redeem, refusing to would be a free way to hold NAV down after
 * betting against your own agent. This proves both run, and that the position
 * the vault held converts back into protocolCash.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;
const pk = (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const wallet = createWalletClient({ account, chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const s = JSON.parse(fs.readFileSync(".data/spike-vault.json", "utf8"));

const vaultAbi = parseAbi([
  "function redeemAll()", "function closeSession()",
  "function nav() view returns (uint256)",
  "function unaccounted() view returns (uint256)",
  "function sessionOpen() view returns (bool)",
  "function touchedMarkets() view returns (bytes32[])",
]);
const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const u6 = (v: bigint) => formatUnits(v, 6);
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h });

const now = Math.floor(Date.now() / 1000);
console.log(`vault ${s.vault}  sessionEnd ${s.sessionEnd} (${s.sessionEnd - now}s from now)`);
if (now < s.sessionEnd) { console.log("session has not ended yet — rerun later"); process.exit(3); }

const before = {
  nav: await pub.readContract({ address: s.vault, abi: vaultAbi, functionName: "nav" }) as bigint,
  pos: await pub.readContract({ address: s.outcomeToken, abi: erc6909, functionName: "balanceOf", args: [s.vault, BigInt(s.yesId)] }) as bigint,
};
console.log(`before: nav ${u6(before.nav)}   YES position ${u6(before.pos)}`);

console.log("redeemAll() …");
const r1 = await wait(await wallet.writeContract({ address: s.vault, abi: vaultAbi, functionName: "redeemAll" }));
console.log("  tx", r1.transactionHash, r1.status, `gas ${r1.gasUsed}`);

console.log("closeSession() …");
const r2 = await wait(await wallet.writeContract({ address: s.vault, abi: vaultAbi, functionName: "closeSession" }));
console.log("  tx", r2.transactionHash, r2.status);

const after = {
  nav: await pub.readContract({ address: s.vault, abi: vaultAbi, functionName: "nav" }) as bigint,
  pos: await pub.readContract({ address: s.outcomeToken, abi: erc6909, functionName: "balanceOf", args: [s.vault, BigInt(s.yesId)] }) as bigint,
  open: await pub.readContract({ address: s.vault, abi: vaultAbi, functionName: "sessionOpen" }) as boolean,
  unacc: await pub.readContract({ address: s.vault, abi: vaultAbi, functionName: "unaccounted" }) as bigint,
};
console.log(`\nafter : nav ${u6(after.nav)}   YES position ${u6(after.pos)}   sessionOpen ${after.open}`);
console.log(`        unaccounted ${u6(after.unacc)}  (the 10,000 top-up, still excluded)`);
console.log(`        NAV delta over the session: ${u6(after.nav - 200_000_000n)} tUSDC vs the 200 deposited`);
console.log(after.open === false ? "\n✅ session closed permissionlessly" : "\n❌ session still open");
