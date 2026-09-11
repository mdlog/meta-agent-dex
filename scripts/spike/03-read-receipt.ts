import fs from "node:fs";
import { createPublicClient, http } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
const c = createPublicClient({ chain: somniaShannon, transport: http("https://dream-rpc.somnia.network") });
const s = JSON.parse(fs.readFileSync(".data/spike-meta-market.json","utf8"));
const rc = await c.getTransactionReceipt({ hash: s.marketCreateTx });
console.log("status:", rc.status, "| gasUsed:", rc.gasUsed.toString(), "| logs:", rc.logs.length);
for (const [i, l] of rc.logs.entries()) {
  console.log(`  [${i}] ${l.address}  topic0=${l.topics[0]?.slice(0,18)}…  topics=${l.topics.length}`);
}
// The module emits the market id; surface every 32-byte topic that looks like one.
const module_ = "0x3ecc694cef705358864a646142ac17a90e29e388";
for (const l of rc.logs) {
  if (l.address.toLowerCase() === module_) {
    console.log("\nMODULE LOG topics:", l.topics);
    console.log("data:", l.data.slice(0, 400));
  }
}
