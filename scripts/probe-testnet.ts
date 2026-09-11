/**
 * Sprint 0 technical spike (PRD §14).
 *
 * Proves, against the real Somnia Shannon testnet, that: the SDK constructs,
 * the indexer serves live Event Contracts, the top-of-book read works, the
 * chain-head book read works, and market status is verifiable on-chain before
 * a write. Run with `npm run probe`.
 */
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, priceToProbability, toHuman } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const INDEXER = process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS = process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";

const line = (s: string) => console.log(s);
const ok = (s: string) => console.log(`  \x1b[32mPASS\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${s}`);

const exchange = new SomniaMarkets({
  indexerUrl: INDEXER,
  chain: somniaShannon,
  wsRpcUrl: WS,
  addresses: SOMNIA_TESTNET_ADDRESSES,
});
const client = exchange.client;

let failures = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    ok(`${name} (${Date.now() - t0}ms)`);
    return r;
  } catch (e) {
    failures++;
    bad(`${name} — ${(e as Error).message.slice(0, 220)}`);
    return null;
  }
}

line("\n=== Forecast Arena · DreamDEX Sprint-0 spike ===");
line(`indexer ${INDEXER}`);
line(`chain   ${somniaShannon.name} (${somniaShannon.id})\n`);

const sync = await step("indexer sync status", () => client.getSyncStatus(somniaShannon.id));
if (sync) line(`       head block ${(sync as any).blockNumber ?? JSON.stringify(sync)}`);

const trading = await step("listLiveBinaryMarkets (expiry > now)", () =>
  client.listLiveBinaryMarkets({ limit: 25 }),
);
line(`       ${trading?.length ?? 0} live Event Contracts`);

if (trading?.length) {
  const m = trading[0];
  line(`       sample: ${m.asset} "${m.question}" expiry=${new Date(Number(m.expiry) * 1000).toISOString()} interval=${m.interval}`);

  const tops = await step("client.getBookTops (batch, indexer)", () =>
    client.getBookTops(trading.map((x) => x.id)),
  );
  const quoted = tops ? Object.values(tops).filter((t: any) => t.bestBid || t.bestAsk).length : 0;
  line(`       ${quoted}/${trading.length} markets have a resting quote`);

  const withBook = trading.find((x) => tops?.[x.id]?.bestBid && tops?.[x.id]?.bestAsk) ?? m;
  const top: any = tops?.[withBook.id];
  if (top?.bestBid && top?.bestAsk) {
    line(
      `       ${withBook.asset} book: bid ${priceToProbability(top.bestBid, withBook.quoteDecimals).toFixed(3)} / ask ${priceToProbability(top.bestAsk, withBook.quoteDecimals).toFixed(3)} → P(Up) ${(priceToProbability(top.mid, withBook.quoteDecimals) * 100).toFixed(1)}%`,
    );
  }

  const book = await step("getBinaryOrderBook (chain head, via WS RPC)", () =>
    client.getBinaryOrderBook(withBook.poolAddress as `0x${string}`, { depth: 5, decimals: withBook.quoteDecimals }),
  );
  if (book) {
    line(`       depth: ${book.yesBids.length} up-bids / ${book.yesAsks.length} up-asks`);
    if (book.yesBids[0]) line(`       best up-bid ${priceToProbability(book.yesBids[0].price, withBook.quoteDecimals).toFixed(3)} × ${toHuman(book.yesBids[0].quantity, withBook.quoteDecimals)}`);
  }

  await step("getMarketOnchain (write-eligibility source of truth)", () =>
    client.getMarketOnchain(withBook.marketId),
  );
}

const past = await step("listPastBinaryMarkets (settled history for scoring)", () =>
  client.listPastBinaryMarkets({ limit: 5 }),
);
if (past?.length) {
  const r = past.find((p) => p.winningOutcome !== null) ?? past[0];
  line(`       ${past.length} settled; sample winner=${r.winningOutcome === 0 ? "UP" : r.winningOutcome === 1 ? "DOWN" : "void"} status=${r.status}`);
}

await step("getPortfolio (empty wallet is a valid read)", () =>
  client.getPortfolio("0x000000000000000000000000000000000000dead", { ordersLimit: 10, tradesLimit: 10 }),
);

line(`\n=== ${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`} ===\n`);
await exchange.close();
process.exit(failures === 0 ? 0 : 1);
