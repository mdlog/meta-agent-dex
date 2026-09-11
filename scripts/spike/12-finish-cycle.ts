import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()];})) as Record<string,string>;
const pk=(env.DEPLOYER_PRIVATE_KEY.startsWith("0x")?env.DEPLOYER_PRIVATE_KEY:`0x${env.DEPLOYER_PRIVATE_KEY}`) as `0x${string}`;
const account=privateKeyToAccount(pk);
const pub=createPublicClient({chain:somniaShannon,transport:http("https://dream-rpc.somnia.network")});
const wallet=createWalletClient({account,chain:somniaShannon,transport:http("https://dream-rpc.somnia.network")});

const VAULT="0x610736e132abbf36e94a198b74a3a6938b227593" as const;
const MARKET="0x0000000000000000000000000000000000000000000000000000000000015861" as const;
const TOKEN="0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as const;
const MODULE="0x3ecC694Cef705358864a646142ac17A90E29e388" as const;

const vaultAbi=parseAbi([
  "function redeemAll()","function closeSession()","function nav() view returns (uint256)",
  "function sessionOpen() view returns (bool)","function sessionEnd() view returns (uint64)",
  "event Redeemed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount, int256 cashDelta)",
  "event RedeemFailed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount)",
]);
const erc6909=parseAbi(["function balanceOf(address owner,uint256 id) view returns (uint256)"]);
const moduleReads=parseAbi(["function markets(bytes32 m) view returns (uint256 a,uint8 b,uint8 c,address d,uint32 e,bytes32 f,address g,address h,address i,address j,uint256 yesId,uint256 noId,uint64 k,uint64 expiry)"]);
const u6=(v:bigint)=>formatUnits(v,6);
const wait=(h:`0x${string}`)=>pub.waitForTransactionReceipt({hash:h});

const sessionEnd=await pub.readContract({address:VAULT,abi:vaultAbi,functionName:"sessionEnd"}) as bigint;
const now=Math.floor(Date.now()/1000);
console.log(`sessionEnd ${sessionEnd}  now ${now}  (${now-Number(sessionEnd)}s past)`);
const m=await pub.readContract({address:MODULE,abi:moduleReads,functionName:"markets",args:[MARKET]}) as readonly unknown[];
const yesId=m[10] as bigint;
const navBefore=await pub.readContract({address:VAULT,abi:vaultAbi,functionName:"nav"}) as bigint;
const posBefore=await pub.readContract({address:TOKEN,abi:erc6909,functionName:"balanceOf",args:[VAULT,yesId]}) as bigint;
console.log(`before: nav ${u6(navBefore)}  YES ${u6(posBefore)}`);

const rc=await wait(await wallet.writeContract({address:VAULT,abi:vaultAbi,functionName:"redeemAll"}));
console.log(`redeemAll tx ${rc.transactionHash}  gas ${rc.gasUsed}`);
for(const log of rc.logs){
  try{ const d=decodeEventLog({abi:vaultAbi,data:log.data,topics:log.topics});
       console.log(`  event ${d.eventName}`, JSON.stringify(d.args,(_k,v)=>typeof v==="bigint"?v.toString():v)); }catch{}
}
await wait(await wallet.writeContract({address:VAULT,abi:vaultAbi,functionName:"closeSession"}));
const navAfter=await pub.readContract({address:VAULT,abi:vaultAbi,functionName:"nav"}) as bigint;
const posAfter=await pub.readContract({address:TOKEN,abi:erc6909,functionName:"balanceOf",args:[VAULT,yesId]}) as bigint;
const s=await fetch("https://dev.smk.somnia.host/v1/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:`{ Market(where:{marketId:{_eq:"${MARKET}"}}) { winningOutcome voided payoutNumerators } }`})}).then(r=>r.json()) as any;
console.log(`\nmarket: winningOutcome=${s.data.Market[0]?.winningOutcome} voided=${s.data.Market[0]?.voided} payout=${s.data.Market[0]?.payoutNumerators}`);
console.log(`after : nav ${u6(navAfter)}  YES ${u6(posAfter)}`);
console.log(`\nsession P&L: navT0 100 → navT1 ${u6(navAfter)}  =  ${u6(navAfter-100_000_000n)} tUSDC`);
console.log(posAfter===0n ? "✅ redeemAll converted the position into NAV" : "❌ position still held");
