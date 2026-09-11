import { createPublicClient, http, keccak256, toHex } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
const pub = createPublicClient({ chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const TX = "0x7497f4f7d283fca8fdb37fe0e1b30127c73d7206254bc3e0c35907f501c2d138";

const tx = await pub.getTransaction({ hash: TX });
const rc = await pub.getTransactionReceipt({ hash: TX });
console.log(`to ${tx.to}  value ${Number(tx.value)/1e18} STT  gas ${rc.gasUsed}/${tx.gas}  status ${rc.status}`);

// Replay the exact call at the block it failed in to recover the revert data.
const res = await fetch("https://dream-rpc.somnia.network", {
  method:"POST", headers:{"content-type":"application/json"},
  body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_call", params:[
    { from: tx.from, to: tx.to, data: tx.input, value: `0x${tx.value.toString(16)}`, gas: `0x${tx.gas.toString(16)}` },
    `0x${(rc.blockNumber - 1n).toString(16)}`,
  ]}),
}).then(r=>r.json()) as { error?: { data?: string; message?: string } };
const data = res.error?.data ?? "";
console.log(`replay revert: ${data} ${res.error?.message ?? ""}`);

const candidates = [
  "InsufficientPayment()","InsufficientValue()","InsufficientFee()","BadPayment()",
  "TooManySources()","InvalidSource()","InvalidSourceType()","UnsupportedSource()",
  "InvalidParams()","InvalidQuestion()","InvalidDefinition()","InvalidAnswerType()",
  "InvalidInterval()","InvalidIntervals()","BadIntervals()","InvalidResolutionTime()",
  "VenuePolicyDenied()","VenueDisabled()","OperatorDisabled()","CreationDisabled()",
  "InvalidExpiry()","InvalidTradingStart()","InvalidBookParams()","AdapterNotApproved()",
  "QuestionAlreadyExists()","DuplicateQuestion()","InvalidCollateral()","Reentrancy()",
];
for (const s of candidates) {
  const sel = keccak256(toHex(s)).slice(0,10);
  if (data.startsWith(sel)) console.log(`  MATCH -> ${s}`);
}
if (data && data.length > 10) {
  console.log(`  extra data: ${data.slice(10, 200)}`);
}
console.log(`\nselector table:`);
for (const s of candidates) console.log(`  ${keccak256(toHex(s)).slice(0,10)}  ${s}`);
