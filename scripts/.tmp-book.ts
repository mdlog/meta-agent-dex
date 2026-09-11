export {};
import fs from "node:fs";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { formatUnits } from "viem";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()];})) as Record<string,string>;
const ex = new SomniaMarkets({ indexerUrl: env.SOMNIA_INDEXER_URL, chain: somniaShannon,
  wsRpcUrl: env.SOMNIA_WS_RPC_URL, addresses: SOMNIA_TESTNET_ADDRESSES });
const live = (await ex.client.listLiveBinaryMarkets({limit:60})) as any[];
const t = live.filter(m=>["BTC","ETH"].includes(m.asset) && Number(m.intervalSec)<=14400);
console.log("matched", t.length, "markets\n");
for (const m of t) {
  const b = await ex.client.getBinaryOrderBook(m.poolAddress, {depth:5, decimals:m.quoteDecimals});
  const now = Date.now()/1000;
  console.log(m.asset, m.intervalSec+"s", "expires in", Math.round((Number(m.expiry)-now)/60)+"m", "pool", m.poolAddress.slice(0,10));
  console.log("   yesBids:", (b.yesBids??[]).map((l:any)=>formatUnits(l.price,6)+"@"+formatUnits(l.quantity??0n,6)).join(", ") || "(empty)");
  console.log("   yesAsks:", (b.yesAsks??[]).map((l:any)=>formatUnits(l.price,6)+"@"+formatUnits(l.quantity??0n,6)).join(", ") || "(empty)");
}
