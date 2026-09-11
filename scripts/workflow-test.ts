/**
 * End-to-end workflow test.
 *
 * Drives the running application over HTTP: the data source it is reading, the
 * contracts it can discover, one contract in detail with its book, the agent
 * registry, the session journal, and the fact that the browser trading path is
 * actually gone rather than merely hidden. Nothing is stubbed — the markets are
 * the real DreamDEX series on Somnia Shannon.
 *
 * It ran seven more sections until the human trading path was removed: a
 * practice forecast, an order preview, a signed receipt, an arena, settlement,
 * scoring and telemetry. Every route those drove has been deleted, so §6 below
 * asserts their absence instead.
 *
 *   npm run workflow            # against http://localhost:3009
 *   BASE=http://host npm run workflow
 */

const BASE = process.env.BASE ?? "http://localhost:3009";

let pass = 0;
let fail = 0;
const failures: string[] = [];

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  // No cookie jar: this app sets no session cookie any more, so a run is
  // stateless and two runs in a row cannot influence one another.
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ${g("PASS")} ${name}${detail ? dim(` — ${detail}`) : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ${r("FAIL")} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ---------------------------------------------------------------------------

console.log(`\n\x1b[1mMeta-Agent DEX — end-to-end workflow\x1b[0m`);
console.log(dim(`target ${BASE}\n`));

section("1 · Network and data source");
let healthMode: string | undefined;
{
  const { status, body } = await api("/api/health");
  healthMode = body?.mode;
  check("health endpoint responds", status === 200, `chain ${body?.chainId}`);
  check("reports Somnia Shannon (50312)", body?.chainId === 50312);
  check(
    "declares its data source honestly",
    body?.mode === "live" || body?.mode === "sim",
    `mode=${body?.mode}${body?.mode === "sim" ? " (simulation — labelled in the UI)" : ""}`,
  );
  if (body?.mode === "live" && body?.ok) {
    check("indexer has a processed block", Number(body.indexerBlock) > 0, `block ${body.indexerBlock}`);
  }
}

section("2 · Market discovery (AC-002, FR-010…FR-015)");
let market: any = null;
{
  const { status, body } = await api("/api/markets?limit=25");
  check("markets endpoint responds", status === 200);
  check("returns live Event Contracts", (body?.markets?.length ?? 0) > 0, `${body?.markets?.length} open`);

  const nowSec = Math.floor(Date.now() / 1000);
  // `listMarkets` filters on `expiry > now` when it builds its list, and that
  // list is cached for MARKET_TTL_MS (4s) so a card grid does not cost one
  // indexer round trip per render. A 1-minute contract can therefore expire
  // inside the cache window and legitimately still be in this response —
  // which made this check fail intermittently against a perfectly correct app.
  // Tolerate exactly the documented staleness, and no more.
  const MARKET_CACHE_S = 5;
  const allFuture = body.markets.every((m: any) => m.expiry > nowSec - MARKET_CACHE_S);
  check("every listed contract is still open (FR-011)", allFuture,
    allFuture ? "" : `${body.markets.filter((m: any) => m.expiry <= nowSec - MARKET_CACHE_S).length} past expiry`);

  const sorted = body.markets.map((m: any) => m.expiry);
  check("sorted soonest-to-expire first", [...sorted].sort((a, b) => a - b).join() === sorted.join());

  const shaped = body.markets.every(
    (m: any) => m.id && m.asset && m.question && m.symbol && typeof m.expiry === "number",
  );
  check("cards have everything the UI renders", shaped);

  const probsValid = body.markets.every(
    (m: any) => m.upProbability === null || (m.upProbability > 0 && m.upProbability < 1),
  );
  check("Up probability is a real probability or explicitly null (FR-013)", probsValid);

  const quoted = body.markets.filter((m: any) => m.bestBid !== null || m.bestAsk !== null);
  check("at least one contract is quoted", quoted.length > 0, `${quoted.length}/${body.markets.length} quoted`);

  // The bug this guards is the app declaring one source and serving another:
  // `mode` was once hardcoded "live", so an unreachable indexer rendered two
  // dozen generated contracts under "Live Event Contracts". Every market now
  // carries where it came from, and the banner and the data have to agree.
  const simulated = body.markets.filter((m: any) => m.simulated === true).length;
  check(
    "every card declares its source, and it matches the banner",
    body.markets.every((m: any) => typeof m.simulated === "boolean") &&
      body.markets.every((m: any) => m.simulated === (healthMode === "sim")),
    `${simulated}/${body.markets.length} simulated, health says ${healthMode}`,
  );

  // Prefer a quoted, tradable contract with room left to run.
  market =
    body.markets.find((m: any) => m.tradable && m.expiry - nowSec > 90) ??
    body.markets.find((m: any) => m.status === "trading") ??
    body.markets[0];

  console.log(dim(`       using ${market.symbol} — "${market.question}"`));
  console.log(dim(`       P(Up) ${market.upProbability !== null ? (market.upProbability * 100).toFixed(1) + "%" : "no quote"}, expires in ${market.expiry - nowSec}s`));
}

section("3 · Market detail and order book (FR-020…FR-024)");
{
  const { status, body } = await api(`/api/markets/${market.id}`);
  check("market detail responds", status === 200);
  check("returns the same contract", body?.market?.id === market.id);

  if (body?.book) {
    const b = body.book;
    check("order book is four-sided", Array.isArray(b.upBids) && Array.isArray(b.downAsks));
    if (b.upBids.length && b.upAsks.length) {
      check("best bid sits below best ask", b.upBids[0].price < b.upAsks[0].price,
        `${b.upBids[0].price.toFixed(3)} / ${b.upAsks[0].price.toFixed(3)}`);
      check("Down is the Up book inverted (PRD §11.2)",
        Math.abs(b.downBids[0].price - (1 - b.upAsks[0].price)) < 1e-6);
    }
    check("book carries a capture timestamp for the live indicator", typeof b.capturedAt === "number");
  } else {
    console.log(dim("       no resting book on this contract — FR-014 path"));
  }

  check("on-chain state is read for write-eligibility (FR-055)", body?.onchain !== undefined);
  if (body?.onchain) {
    check("chain expiry matches the indexed expiry", body.onchain.expiry === body.market.expiry);
  }
}

section("4 · The agent registry (design §3 Layer 0)");
{
  const { status, body } = await api("/api/agents");
  check("agent board responds", status === 200);
  check("returns a standings array", Array.isArray(body?.standings));

  // Registration is the only authorised write left in the app, and the only
  // claim it accepts is an EIP-191 signature. A body without one must be
  // refused before anything is written — this is the check that the removal of
  // the session cookie did not quietly leave the route open.
  const unsigned = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name: "Workflow Probe",
      ownerAddress: "0x000000000000000000000000000000000000dEaD",
      vaultAddress: "0x000000000000000000000000000000000000bEEF",
      operatorAddress: "0x000000000000000000000000000000000000cAFE",
      strategy: "momentum",
    }),
  });
  check("refuses a registration with no signature", unsigned.status >= 400, unsigned.body?.code);

  for (const standing of (body?.standings ?? []).slice(0, 3)) {
    const rate = standing?.winRate;
    check(
      `${standing?.agent?.slug ?? "agent"} has no win rate before it finishes a session`,
      standing?.sessionsRun > 0 ? typeof rate === "number" : rate === null,
      `sessionsRun=${standing?.sessionsRun}`,
    );
  }
}

section("5 · The session journal");
{
  const { status, body } = await api("/api/agents/sessions?limit=10");
  check("session board responds", status === 200);
  // The route answers { open, recent, vaults, now } and each row is
  // { session, vault, agent } — this asserted a flat `sessions` array the route
  // has never returned, so it failed on a healthy server AND, worse, left the
  // baseline invariant below iterating an empty list. It never once ran.
  check("returns the open and recent journals", Array.isArray(body?.open) && Array.isArray(body?.recent));

  const journal = [...(body?.open ?? []), ...(body?.recent ?? [])];
  check("journal carries rows to check", journal.length > 0, `${body?.open?.length ?? 0} open, ${body?.recent?.length ?? 0} recent`);

  for (const row of journal.slice(0, 5)) {
    const s = row?.session;
    // A meta-market may not exist before the oracle has snapshotted the
    // baseline: minting against a NAV that already moved is the one ordering
    // mistake this whole pipeline is built to prevent.
    check(
      `session ${s?.sessionNumber} does not carry a market before its baseline`,
      s?.metaMarketId === null || s?.navT0 !== null,
      `metaMarketId=${s?.metaMarketId ? "set" : "null"} navT0=${s?.navT0 ?? "null"}`,
    );
  }
}

section("6 · The human trading path is gone");
{
  // These routes signed orders from a browser. They are deleted, not disabled,
  // and a 404 is the proof — a 405 or a 400 would mean the handler is still
  // mounted and something is still reachable behind it.
  for (const path of ["/api/orders", "/api/orders/preview", "/api/predictions", "/api/portfolio", "/api/leaderboard", "/api/arenas", "/api/settle"]) {
    const { status } = await api(path);
    check(`${path} is gone`, status === 404, `status ${status}`);
  }
}


// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(64)}`);
console.log(`${fail === 0 ? g("ALL CHECKS PASSED") : r(`${fail} CHECK(S) FAILED`)}  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log(r("\nFailed:"));
  for (const f of failures) console.log(r(`  · ${f}`));
}
console.log("");
process.exit(fail === 0 ? 0 : 1);

export {};
