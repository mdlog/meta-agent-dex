import { parseAbi, encodeFunctionData } from "viem";
const RPC = "https://dream-rpc.somnia.network";
const POOL = "0x54d90260fe949940a80602e7fda8ebd729c5be00";
const CONTRACT = "0xa2caf0958a5f93dc2845c55c2a7e1de4a33b2229";
const EOA = "0x1111111111111111111111111111111111111111";

const abi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool, uint128)",
  "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool, uint128)",
]);
const expireNs = BigInt(Math.floor(Date.now()/1000)+600)*1_000_000_000n;
const tail = [0, 300000n, 1000000n, expireNs, 0, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] as const;

async function raw(from: string, fn: "placeBinaryOrder"|"placeBinaryOrderFor") {
  const data = fn === "placeBinaryOrder"
    ? encodeFunctionData({ abi, functionName: fn, args: tail as never })
    : encodeFunctionData({ abi, functionName: fn, args: [from, ...tail] as never });
  const body = { jsonrpc:"2.0", id:1, method:"eth_call", params:[
    { from, to: POOL, data },
    "latest",
    { [from]: { balance: "0x56bc75e2d63100000" } },
  ]};
  const r = await fetch(RPC, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
  const j: any = await r.json();
  const err = j.error;
  return { code: err?.code, message: err?.message, data: err?.data ?? j.result };
}

// The SDK ships 418 custom errors; resolve selectors against them.
const { contractErrorsAbi } = await import("@somnia-chain/markets-sdk/dist/contractErrors.js").catch(() => ({ contractErrorsAbi: null })) as any;
import { keccak256, toHex } from "viem";
let sigByeSel = new Map<string,string>();
if (contractErrorsAbi) {
  for (const e of contractErrorsAbi) {
    if (e.type !== "error") continue;
    const sig = `${e.name}(${(e.inputs??[]).map((i:any)=>i.type).join(",")})`;
    sigByeSel.set(keccak256(toHex(sig)).slice(0,10), sig);
  }
}
const name = (d?: string) => (d && sigByeSel.get(d.slice(0,10))) || d?.slice(0,10) || "(no data)";

for (const fn of ["placeBinaryOrder","placeBinaryOrderFor"] as const) {
  console.log(`\n### ${fn}`);
  for (const [label, from] of [["EOA     ", EOA], ["CONTRACT", CONTRACT]] as const) {
    const res = await raw(from, fn);
    console.log(`  ${label}  data=${(res.data ?? "").toString().slice(0,10)}  → ${name(res.data as string)}`);
    if (res.message) console.log(`            msg: ${res.message.slice(0,100)}`);
  }
}
console.log(`\n(errors resolved from SDK table: ${sigByeSel.size} entries)`);
