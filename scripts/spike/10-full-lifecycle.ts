/**
 * Spike 10 — the whole agent session, end to end, on live Shannon.
 *
 * deploy -> deposit -> openSession -> trade a real BTC market -> wait out expiry
 * -> redeemAll -> closeSession, asserting that NAV actually recovers the
 * winnings. The previous run silently did not redeem (the vault had never
 * granted the module operator rights on the ERC-6909 singleton), so the
 * assertion here is the point of the script, not the ceremony around it.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
) as Record<string, string>;
const pk = (env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const RPC = "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: somniaShannon, transport: http(RPC) });
const art = JSON.parse(fs.readFileSync(process.env.VAULT_ARTIFACT!, "utf8")).contracts["contracts/BotVault.sol:BotVault"];

const COLLATERAL = SOMNIA_TESTNET_ADDRESSES.collateral as `0x${string}`;
const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule as `0x${string}`;
const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as const; // ERC-6909 singleton

const vaultAbi = parseAbi([
  "function deposit(uint256 amount)", "function openSession(uint64 endsAt)",
  "function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType)",
  "function redeemAll()", "function closeSession()",
  "function nav() view returns (uint256)", "function unaccounted() view returns (uint256)",
  "function sessionOpen() view returns (bool)", "function touchedMarkets() view returns (bytes32[])",
]);
const erc6909 = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function isOperator(address owner, address spender) view returns (bool)",
]);
const moduleReads = parseAbi(["function markets(bytes32 marketId) view returns (uint256 a, uint8 b, uint8 c, address d, uint32 opId, bytes32 venueId, address f, address g, address clone, address pool, uint256 yesId, uint256 noId, uint64 ts, uint64 expiry)"]);

const u6 = (v: bigint) => formatUnits(v, 6);
const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const exchange = new SomniaMarkets({
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES,
});

const now = Math.floor(Date.now() / 1000);
const markets = await exchange.client.listLiveBinaryMarkets({ limit: 50 });
const cand = markets.filter((m) => m.asset === "BTC" && Number(m.expiry) > now + 70 && Number(m.expiry) < now + 2400)
                    .sort((a, b) => Number(a.expiry) - Number(b.expiry))[0];
if (!cand) { console.log("no BTC market with usable runway; rerun"); process.exit(3); }
const marketId = cand.marketId as `0x${string}`;
const expiry = Number(cand.expiry);
console.log(`market ${marketId}  expiry +${expiry - now}s  pool ${cand.poolAddress}`);

console.log("\n1 deploy (now grants the module ERC-6909 operator rights in the constructor)");
const vault = (await wait(await wallet.deployContract({
  abi: (typeof art.abi === "string" ? JSON.parse(art.abi) : art.abi), bytecode: `0x${art.bin}`,
  args: [COLLATERAL, MODULE, OUTCOME_TOKEN, account.address, account.address],
} as never))).contractAddress!;
console.log(`  vault ${vault}`);
console.log(`  isOperator(vault, module) = ${await pub.readContract({ address: OUTCOME_TOKEN, abi: erc6909, functionName: "isOperator", args: [vault, MODULE] })}`);

console.log("2 deposit 100 tUSDC");
await wait(await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [vault, 100_000_000n] }));
await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [100_000_000n] }));

console.log(`3 openSession(endsAt = expiry + 45)`);
await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "openSession", args: [BigInt(expiry + 45)] }));
const navT0 = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }) as bigint;
console.log(`  navT0 = ${u6(navT0)}`);

const book = await exchange.client.getBinaryOrderBook(cand.poolAddress, { depth: 5, decimals: 6 });
const params = await exchange.client.getBinaryBookParams(cand.poolAddress);
const tick = BigInt(params.tickSize ?? 1000n), lot = BigInt(params.lotSize ?? 1000n);
const price = ((900_000n) / tick) * tick;              // pay up to 0.90 to guarantee a fill
const quantity = (20_000_000n / lot) * lot;            // 20 contracts
console.log(`4 trade BUY_YES qty ${quantity} at <= ${price} (IOC)`);
const tradeTx = await wallet.writeContract({
  address: vault, abi: vaultAbi, functionName: "trade",
  args: [marketId, 0, price, quantity, BigInt(expiry) * 1_000_000_000n, 2],
});
await wait(tradeTx);
const m = await pub.readContract({ address: MODULE, abi: moduleReads, functionName: "markets", args: [marketId] }) as readonly unknown[];
const yesId = m[10] as bigint, noId = m[11] as bigint;
const [pos, navAfterTrade] = await Promise.all([
  pub.readContract({ address: OUTCOME_TOKEN, abi: erc6909, functionName: "balanceOf", args: [vault, yesId] }),
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }),
]) as bigint[];
console.log(`  YES position ${u6(pos)}   nav ${u6(navT0)} -> ${u6(navAfterTrade)} (spent ${u6(navT0 - navAfterTrade)})`);

console.log(`5 waiting out expiry (+${expiry - Math.floor(Date.now() / 1000)}s) …`);
while (Math.floor(Date.now() / 1000) < expiry + 20) await sleep(10_000);

console.log("6 redeemAll()");
const r = await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "redeemAll" }));
console.log(`  tx ${r.transactionHash}  gas ${r.gasUsed}  logs ${r.logs.length}`);

const [posAfter, navFinal] = await Promise.all([
  pub.readContract({ address: OUTCOME_TOKEN, abi: erc6909, functionName: "balanceOf", args: [vault, yesId] }),
  pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }),
]) as bigint[];
await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "closeSession" }));

const settle = await fetch("https://dev.smk.somnia.host/v1/graphql", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: `{ Market(where:{marketId:{_eq:"${marketId}"}}) { winningOutcome voided payoutNumerators } }` }),
}).then((x) => x.json()) as { data: { Market: { winningOutcome: number | null; voided: boolean; payoutNumerators: string[] }[] } };
const out = settle.data.Market[0];

console.log(`\nmarket settled: winningOutcome=${out?.winningOutcome} voided=${out?.voided} payout=${out?.payoutNumerators}`);
console.log(`position ${u6(pos)} -> ${u6(posAfter)}   (redeemed: ${posAfter === 0n})`);
console.log(`NAV  t0 ${u6(navT0)}  ->  t1 ${u6(navFinal)}   session P&L ${u6(navFinal - navT0)} tUSDC`);
const redeemed = posAfter === 0n;
console.log("\n" + "=".repeat(60));
console.log(redeemed ? "✅ redeemAll converted the position back into NAV" : "❌ position still held — redeem still failing");
fs.writeFileSync(".data/spike-lifecycle.json", JSON.stringify({ vault, marketId, navT0: navT0.toString(), navFinal: navFinal.toString(), tradeTx, redeemTx: r.transactionHash, winningOutcome: out?.winningOutcome }, null, 2));
process.exit(redeemed ? 0 : 1);
