import { createPublicClient, http, parseAbi, encodeFunctionData, keccak256, toHex } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import fs from "node:fs";

const pub = createPublicClient({ chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const s = JSON.parse(fs.readFileSync(".data/spike-vault.json", "utf8"));
const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule as `0x${string}`;

const moduleReads = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
  "function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)",
]);
const erc6909 = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function isOperator(address owner, address spender) view returns (bool)",
]);

const m = await pub.readContract({ address: MODULE, abi: moduleReads, functionName: "markets", args: [s.marketId] }) as readonly unknown[];
const opId = m[4] as number, venueId = m[5] as `0x${string}`, clone = m[8] as string, yesId = m[10] as bigint;
console.log(`market ${s.marketId}`);
console.log(`  originOperatorId ${opId}  originVenueId ${venueId}`);
console.log(`  clone ${clone}  outcomeToken ${s.outcomeToken}`);

const bal = await pub.readContract({ address: s.outcomeToken, abi: erc6909, functionName: "balanceOf", args: [s.vault, yesId] }) as bigint;
const isOp = await pub.readContract({ address: s.outcomeToken, abi: erc6909, functionName: "isOperator", args: [s.vault, MODULE] }) as boolean;
console.log(`  vault YES balance ${bal}`);
console.log(`  outcomeToken.isOperator(vault, module) = ${isOp}   <-- suspected cause`);

// Raw revert bytes from the redeem the vault would make.
const data = encodeFunctionData({ abi: moduleReads, functionName: "redeem", args: [opId, venueId, s.marketId, 0, bal] });
const res = await fetch("https://dream-rpc.somnia.network", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: s.vault, to: MODULE, data }, "latest"] }),
});
const j = await res.json() as { error?: { data?: string; message?: string }; result?: string };
console.log(`\n  redeem simulated from the vault -> ${j.error ? `REVERT ${j.error.data ?? ""} ${j.error.message}` : `OK ${j.result}`}`);

for (const sig of [
  "InsufficientPermission()", "NotAuthorized()", "Unauthorized()", "OnlyApprovedContracts()",
  "MarketNotResolved()", "NotFinalized()", "InsufficientBalance(address,uint256,uint256,uint256)",
  "InvalidOutcome()", "NothingToRedeem()", "ZeroAmount()", "MarketNotFinalized()", "SettlementNotFinalized()",
]) console.log(`   ${keccak256(toHex(sig)).slice(0, 10)}  ${sig}`);

// Is the outcome token a singleton shared by every market?
const other = await pub.readContract({ address: MODULE, abi: moduleReads, functionName: "markets", args: ["0x000000000000000000000000000000000000000000000000000000000001580a"] }) as readonly unknown[];
const otherClone = other[8] as `0x${string}`;
const otherToken = await pub.readContract({ address: otherClone, abi: parseAbi(["function outcomeToken() view returns (address)"]), functionName: "outcomeToken" });
console.log(`\n  outcomeToken of a DIFFERENT market: ${otherToken}`);
console.log(`  singleton? ${String(otherToken).toLowerCase() === String(s.outcomeToken).toLowerCase()}`);
