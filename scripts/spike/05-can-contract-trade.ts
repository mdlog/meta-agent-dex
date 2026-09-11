/**
 * Spike 5 — decides the BotVault design.
 *
 * If a contract may call BinaryPool.placeBinaryOrder as msg.sender, the vault
 * can be the trader and own its positions, which makes NAV unforgeable. If a
 * contract is gated out, NAV has to be derived from positions instead.
 *
 * The test is differential: simulate the same call from an EOA and from an
 * address that has code, both unfunded. Identical revert reasons mean the pool
 * does not care what the caller is; a distinct one for the contract means a gate.
 */
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const RPC = "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaShannon, transport: http(RPC) });

const POOL = "0x54d90260fe949940a80602e7fda8ebd729c5be00" as const;   // live BTC pool
const CONTRACT_CALLER = "0xa2caf0958a5f93dc2845c55c2a7e1de4a33b2229" as const; // our BotNavOracle — has code
const EOA_CALLER = "0x1111111111111111111111111111111111111111" as const;      // no code

const abi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);

const expireNs = BigInt(Math.floor(Date.now() / 1000) + 600) * 1_000_000_000n;
const args = [0, 300000n, 1000000n, expireNs, 0, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] as const;

async function probe(label: string, from: `0x${string}`, fn: "placeBinaryOrder" | "placeBinaryOrderFor") {
  const data = fn === "placeBinaryOrder"
    ? encodeFunctionData({ abi, functionName: fn, args: args as never })
    : encodeFunctionData({ abi, functionName: fn, args: [from, ...args] as never });
  try {
    const r = await pub.call({ to: POOL, data, account: from, stateOverride: [{ address: from, balance: 10n ** 20n }] });
    console.log(`  ${label.padEnd(26)} → OK ${r.data}`);
    return "OK";
  } catch (e: any) {
    const raw = (e?.cause?.data ?? e?.data ?? e?.details ?? e?.shortMessage ?? "").toString();
    const sel = /0x[0-9a-fA-F]{8}/.exec(raw)?.[0] ?? "";
    const msg = (e?.shortMessage ?? e?.message ?? "").split("\n")[0];
    console.log(`  ${label.padEnd(26)} → REVERT ${sel} ${msg.slice(0, 90)}`);
    return sel || msg.slice(0, 60);
  }
}

console.log(`pool ${POOL}`);
console.log(`code size — EOA caller: ${((await pub.getCode({ address: EOA_CALLER })) ?? "0x").length / 2 - 1} B, contract caller: ${((await pub.getCode({ address: CONTRACT_CALLER })) ?? "0x").length / 2 - 1} B\n`);

console.log("placeBinaryOrder (the path a vault would use):");
const a = await probe("from EOA", EOA_CALLER, "placeBinaryOrder");
const b = await probe("from CONTRACT", CONTRACT_CALLER, "placeBinaryOrder");

console.log("\nplaceBinaryOrderFor (known router-only path, control):");
const c = await probe("from EOA", EOA_CALLER, "placeBinaryOrderFor");
const d = await probe("from CONTRACT", CONTRACT_CALLER, "placeBinaryOrderFor");

console.log("\n" + "=".repeat(70));
if (a === b) {
  console.log("✅ placeBinaryOrder treats a contract EXACTLY like an EOA →");
  console.log("   a BotVault CAN be the trader and own its own positions.");
} else {
  console.log("❌ placeBinaryOrder discriminates by caller type →");
  console.log(`   EOA: ${a}   CONTRACT: ${b}`);
  console.log("   the vault cannot trade; NAV must come from positions instead.");
}
console.log(`control (…For): EOA ${c} / CONTRACT ${d}`);
