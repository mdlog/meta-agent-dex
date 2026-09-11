/**
 * Spike 7 — the load-bearing test.
 *
 * Deploys a BotVault, funds it, opens a session, and has the vault place a real
 * order on a live DreamDEX BTC market. What must hold afterwards:
 *   - the vault, not the operator key, owns the ERC-6909 position;
 *   - protocolCash fell by what the trade actually cost, measured on chain;
 *   - a faucet top-up moves balanceOf and leaves protocolCash untouched.
 * The last one is the whole security claim, so it is asserted, not assumed.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
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

const vaultAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function openSession(uint64 endsAt)",
  "function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType)",
  "function nav() view returns (uint256)",
  "function protocolCash() view returns (uint256)",
  "function unaccounted() view returns (uint256)",
  "function touchedMarkets() view returns (bytes32[])",
  "function sessionOpen() view returns (bool)",
]);
const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const moduleReads = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);
const cloneReads = parseAbi(["function outcomeToken() view returns (address)"]);
const faucetAbi = parseAbi(["function faucet(uint256 amount)"]);

const wait = (h: `0x${string}`) => pub.waitForTransactionReceipt({ hash: h });
const u6 = (v: bigint) => formatUnits(v, 6);

async function main() {
  const exchange = new SomniaMarkets({
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  // Pick a live BTC market with enough runway to trade before it expires.
  const now = Math.floor(Date.now() / 1000);
  const all = await exchange.client.listLiveBinaryMarkets({ limit: 40 });
  const cand = all.filter((m: any) => m.asset === "BTC" && Number(m.expiry) > now + 240 && Number(m.expiry) < now + 5400)
                  .sort((a: any, b: any) => Number(a.expiry) - Number(b.expiry))[0];
  if (!cand) throw new Error("no BTC market with usable runway right now");
  const marketId = cand.marketId as `0x${string}`;
  const expiry = Number(cand.expiry);
  console.log(`market  ${marketId}`);
  console.log(`        ${cand.question}`);
  console.log(`        expiry ${expiry} (+${expiry - now}s)  pool ${cand.poolAddress}\n`);

  const book = await exchange.client.getBinaryOrderBook(cand.poolAddress, { depth: 5, decimals: 6 });
  const params = await exchange.client.getBinaryBookParams(cand.poolAddress);
  console.log("book params: tick", params.tickSize?.toString(), "lot", params.lotSize?.toString(), "minQty", params.minQuantity?.toString());
  const bestAsk = book.asks?.[0];
  console.log("best ask   :", bestAsk ? `${bestAsk.price} x ${bestAsk.quantity}` : "(empty)");

  // 1. deploy
  console.log("\n1/6 deploy BotVault …");
  const dh = await wallet.deployContract({
    abi: (typeof art.abi === "string" ? JSON.parse(art.abi) : art.abi),
    bytecode: `0x${art.bin}`,
    args: [COLLATERAL, MODULE, account.address, account.address],
  } as never);
  const vault = (await wait(dh)).contractAddress!;
  console.log("    vault:", vault);

  // 2. fund
  console.log("2/6 approve + deposit 200 tUSDC …");
  await wait(await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [vault, 200_000_000n] }));
  await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [200_000_000n] }));
  console.log("    protocolCash:", u6(await pub.readContract({ address: vault, abi: vaultAbi, functionName: "protocolCash" })));

  // 3. session must outlive the market
  console.log("3/6 openSession …");
  await wait(await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "openSession", args: [BigInt(expiry + 120)] }));

  // 4. cross the spread so the vault ends up holding a position
  const tick = BigInt(params.tickSize ?? 1000n);
  const lot = BigInt(params.lotSize ?? 1000n);
  const rawAsk = bestAsk ? BigInt(Math.round(bestAsk.price * 1e6)) : 500_000n;
  const price = ((rawAsk + tick * 5n) / tick) * tick > 990_000n ? 990_000n : ((rawAsk + tick * 5n) / tick) * tick;
  const quantity = (10_000_000n / lot) * lot;   // 10 contracts
  console.log(`4/6 vault.trade BUY_YES price=${price} qty=${quantity} (IOC) …`);
  const cashBefore = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "protocolCash" }) as bigint;
  const th = await wallet.writeContract({
    address: vault, abi: vaultAbi, functionName: "trade",
    args: [marketId, 0, price, quantity, BigInt(expiry) * 1_000_000_000n, 2],
  });
  const trc = await wait(th);
  console.log("    tx:", th, "status:", trc.status);

  // 5. who owns the position?
  const m = await pub.readContract({ address: MODULE, abi: moduleReads, functionName: "markets", args: [marketId] }) as any[];
  const [, , , , , , , , clone, , yesId] = m;
  const token = await pub.readContract({ address: clone, abi: cloneReads, functionName: "outcomeToken" }) as `0x${string}`;
  const [vaultPos, eoaPos, cashAfter] = await Promise.all([
    pub.readContract({ address: token, abi: erc6909, functionName: "balanceOf", args: [vault, yesId] }),
    pub.readContract({ address: token, abi: erc6909, functionName: "balanceOf", args: [account.address, yesId] }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "protocolCash" }),
  ]) as bigint[];
  console.log(`\n5/6 position: vault holds ${u6(vaultPos)} YES, operator EOA holds ${u6(eoaPos)}`);
  console.log(`    protocolCash ${u6(cashBefore)} → ${u6(cashAfter)}  (delta ${u6(cashAfter - cashBefore)})`);
  console.log(`    touched markets: ${(await pub.readContract({ address: vault, abi: vaultAbi, functionName: "touchedMarkets" }) as string[]).length}`);

  // 6. the security claim, asserted
  console.log("\n6/6 top-up attack: faucet 10,000 tUSDC straight into the vault …");
  await wait(await wallet.writeContract({ address: COLLATERAL, abi: faucetAbi, functionName: "faucet", args: [10_000_000_000n] }));
  await wait(await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "transfer", args: [vault, 10_000_000_000n] }));
  const [navAfter, held, unacc] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }),
    pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "unaccounted" }),
  ]) as bigint[];
  console.log(`    balanceOf(vault) = ${u6(held)}   nav() = ${u6(navAfter)}   unaccounted() = ${u6(unacc)}`);

  const ok = navAfter === cashAfter && vaultPos > 0n && eoaPos === 0n;
  console.log("\n" + "=".repeat(64));
  console.log(vaultPos > 0n && eoaPos === 0n ? "✅ the VAULT owns the position, not the operator key" : "❌ position ownership wrong");
  console.log(navAfter === cashAfter ? "✅ a 10,000 tUSDC top-up moved NAV by ZERO" : `❌ NAV moved on a top-up: ${u6(cashAfter)} → ${u6(navAfter)}`);

  fs.writeFileSync(".data/spike-vault.json", JSON.stringify({ vault, marketId, expiry, sessionEnd: expiry + 120, tradeTx: th, yesId: yesId.toString(), outcomeToken: token }, null, 2));
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
