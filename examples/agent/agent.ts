/**
 * A minimal trading agent, whole, in one file.
 *
 * `bots/runner.ts` is the production one — two strategies, budget ledgers per
 * market, cooldowns, heartbeats, dry runs, revert decoding. This is the part
 * underneath all of that: read the book, form a view, size an order the pool
 * will accept, send it through the vault, report it. Read it top to bottom, then
 * replace `view()` with your own idea.
 *
 * The three things it will not let you get wrong:
 *
 *  1. THE ORDER GRID. The pool rejects any price off `tickSize`, any quantity off
 *     `lotSize`, and anything under `minQuantity` — as a revert, after you have
 *     paid gas. Every order here is snapped before it is sent.
 *
 *  2. THE SESSION BOUNDARY. `trade` reverts `MarketOutlivesSession()` for any
 *     contract expiring after `sessionEnd`. That is what keeps every position
 *     terminal before NAV is measured, and it is the single most common reason a
 *     working bot looks broken.
 *
 *  3. THE COST OF ENTRY. Every order is IOC, because `BotVault` has `trade` and
 *     no `cancelOrder` — an order left resting could never be pulled back by
 *     anyone. So you are always the taker and always pay the spread. Measured on
 *     Shannon: 2.8 points median, plus your crossing tick, so roughly 3.1 points
 *     per entry before your view is right or wrong. A signal smaller than that
 *     loses on average no matter how good it is. `DRIFT_THRESHOLD` defaults to
 *     4.5 points for that reason and nothing else.
 */

import {
  createPublicClient, createWalletClient, http, parseAbi, parseEventLogs,
  formatUnits, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, type BinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { ARENA, SHANNON, hexKey, env, num, big } from "./env.ts";
import { approve, narrow, promptHash, type Candidate } from "./brain.ts";

// --- wire constants ----------------------------------------------------------
/** `OrderKind` on a BinaryPool: buy the Up leg, or buy the Down leg. */
const BUY_YES = 0;
const BUY_NO = 2;
/** `OrderType`: 0 LIMIT (rests) · 1 FOK · 2 IOC · 3 POST_ONLY. Only IOC is reachable — see the header. */
const ORDER_TYPE_IOC = 2;
const NS_PER_SEC = 1_000_000_000n;

const vaultAbi = parseAbi([
  "function trade(bytes32 marketId, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType)",
  "function nav() view returns (uint256)",
  "function sessionOpen() view returns (bool)",
  "function sessionEnd() view returns (uint64)",
  "function operator() view returns (address)",
  "event Traded(bytes32 indexed marketId, uint8 kind, uint256 price, uint256 quantity, int256 cashDelta)",
]);

// --- configuration -----------------------------------------------------------
const operator = privateKeyToAccount(hexKey("OPERATOR_PRIVATE_KEY", "Run `npm run keys` first."));
const vault = env("VAULT_ADDRESS") as Address | undefined;
const slug = env("AGENT_SLUG");
if (!vault) { console.error("\nVAULT_ADDRESS is not set. Run `npm run deploy`.\n"); process.exit(1); }
if (!slug) { console.error("\nAGENT_SLUG is not set. Run `npm run register`.\n"); process.exit(1); }

const cfg = {
  pollMs: Math.max(3_000, num("POLL_MS", 8_000)),
  lookbackSec: num("LOOKBACK_SEC", 90),
  driftThreshold: big("DRIFT_THRESHOLD", 45_000n),
  maxEntry: big("MAX_ENTRY", 650_000n),
  maxOrder: big("MAX_ORDER", 15_000_000n),
  minCash: big("MIN_CASH", 10_000_000n),
  assets: (env("ASSETS") ?? "BTC,ETH").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean),
  /** Skip a contract expiring sooner than this — an IOC needs someone to cross. */
  minRunwaySec: num("MIN_RUNWAY_SEC", 45),
  dryRun: env("DRY_RUN") === "1",

  /**
   * The model that decides whether each sized order is actually sent.
   *
   * Absent key means the gate is off and the agent runs on `view()` alone, which
   * is the behaviour this example had before the gate existed. It is off by
   * omission rather than by a flag so that nobody has to discover a second
   * switch to get the old thing back.
   */
  apiKey: env("ANTHROPIC_API_KEY"),
  model: env("AGENT_MODEL") ?? "claude-sonnet-5",
  // The poll floor is 3s, so a timeout above it would let one slow call swallow
  // a whole cycle. 5s fits inside the 8s default with room to send the order.
  modelTimeoutMs: num("AGENT_MODEL_TIMEOUT_MS", 5_000),
};

const pub = createPublicClient({ chain: somniaShannon, transport: http(SHANNON.rpc) });
const wallet = createWalletClient({ account: operator, chain: somniaShannon, transport: http(SHANNON.rpc) });
const exchange = new SomniaMarkets({
  indexerUrl: SHANNON.indexer, chain: somniaShannon, addresses: SOMNIA_TESTNET_ADDRESSES,
});

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    new Date().toISOString().slice(11, 19),
    event.padEnd(9),
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" "),
  );

// --- price history, for the view ---------------------------------------------
/** marketId -> samples, oldest first. Trimmed to the lookback so it cannot grow. */
const history = new Map<string, { at: number; p: bigint }[]>();

function remember(id: string, p: bigint, now: number): { at: number; p: bigint }[] {
  const kept = (history.get(id) ?? []).filter((s) => now - s.at <= cfg.lookbackSec * 1000 * 2);
  kept.push({ at: now, p });
  history.set(id, kept);
  return kept;
}

/**
 * The whole strategy: has the implied probability moved more than the threshold
 * over the lookback? Buy the direction it moved.
 *
 * This is the piece to replace. Everything around it — the grid, the session
 * gate, the reporting — stays the same whatever you decide here.
 */
function view(samples: { at: number; p: bigint }[], p: bigint, now: number): { kind: number; why: string } | null {
  let past: { at: number; p: bigint } | null = null;
  for (const s of samples) {
    if (now - s.at < cfg.lookbackSec * 1000) break;
    past = s;
  }
  if (past === null) return null;

  const drift = p - past.p;
  const pts = (d: bigint) => (Number(d) / 10_000).toFixed(1);
  if (drift >= cfg.driftThreshold) return { kind: BUY_YES, why: `up ${pts(drift)}pt/${cfg.lookbackSec}s` };
  if (-drift >= cfg.driftThreshold) return { kind: BUY_NO, why: `down ${pts(-drift)}pt/${cfg.lookbackSec}s` };
  return null;
}

// --- order construction ------------------------------------------------------
const alignDown = (v: bigint, step: bigint) => (step <= 0n ? v : (v / step) * step);
const alignUp = (v: bigint, step: bigint) => (step <= 0n ? v : ((v + step - 1n) / step) * step);
const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Turn a view into an order the pool will accept, or into nothing.
 *
 * Returning null is the normal outcome and not a failure: no resting depth on
 * the side we want, a price above `maxEntry`, or a size that would round below
 * `minQuantity`. Refusing here costs a read; finding out on chain costs gas.
 */
function sizeOrder(
  kind: number,
  book: { yesBids: { price: bigint; quantity: bigint }[]; yesAsks: { price: bigint; quantity: bigint }[] },
  grid: { tickSize: bigint; lotSize: bigint; minQuantity: bigint },
  one: bigint,
  budget: bigint,
): { price: bigint; quantity: bigint } | null {
  // A YES buy lifts the ask; a NO buy hits the bid, and its cost is `one - price`.
  const best = kind === BUY_YES ? book.yesAsks[0]?.price : book.yesBids[0]?.price;
  if (best === undefined) return null;

  // Reach one tick past the touch so an IOC crosses at all. More than one buys
  // no extra depth an IOC could not already reach — it only widens the worst
  // price you are willing to accept.
  const price =
    kind === BUY_YES
      ? clamp(alignUp(best + grid.tickSize, grid.tickSize), grid.tickSize, one - grid.tickSize)
      : clamp(alignDown(best > grid.tickSize ? best - grid.tickSize : grid.tickSize, grid.tickSize), grid.tickSize, one - grid.tickSize);

  const perUnit = kind === BUY_YES ? price : one - price;
  if (perUnit <= 0n) return null;
  // The cap, in the same units on both legs: what one contract costs you.
  if ((perUnit * 1_000_000n) / one > cfg.maxEntry) return null;

  // Only depth this order would actually cross counts toward what it can fill.
  const levels = kind === BUY_YES ? book.yesAsks : book.yesBids;
  let depth = 0n;
  for (const l of levels) {
    const crosses = kind === BUY_YES ? l.price <= price : l.price >= price;
    if (!crosses) break;
    depth += l.quantity;
  }
  if (depth === 0n) return null;

  const affordable = (budget * one) / perUnit;
  const quantity = alignDown(depth < affordable ? depth : affordable, grid.lotSize);
  if (quantity < grid.minQuantity || quantity === 0n) return null;
  return { price, quantity };
}

/** Mid, or the one side that exists. Null means the book has never quoted. */
function implied(book: { yesBids: { price: bigint }[]; yesAsks: { price: bigint }[] }): bigint | null {
  const bid = book.yesBids[0]?.price;
  const ask = book.yesAsks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2n;
  return bid ?? ask ?? null;
}

// --- reporting ---------------------------------------------------------------
/**
 * Tell the arena. It does not take your word for any of it: the route reads the
 * transaction back off chain and checks the receipt exists, that it succeeded,
 * that it was sent to your vault, and that it carries a `Traded` event from it.
 * Price and size are taken from the event, never from this body. A hash that
 * does not check out comes back 422.
 */
async function report(
  txHash: string,
  market: BinaryMarket,
  kind: number,
  price: bigint,
  quantity: bigint,
  /** The model's sentence, when a model decided this order. Null when none did. */
  modelWhy: string | null,
) {
  try {
    const res = await fetch(`${ARENA}/api/agents/${slug}/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        marketId: market.id,
        symbol: `${market.asset}-${market.interval ?? "?"}`,
        kind,
        price: Number(price),
        quantity: quantity.toString(),
        txHash,
        at: Date.now(),
        // Sent together so a reader never has a reason without the model that
        // produced it, or a model name without the prompt it was running.
        ...(modelWhy === null ? {} : { model: cfg.model, promptHash: promptHash(), modelWhy }),
      }),
    });
    if (!res.ok) log("report", { status: res.status, note: (await res.text()).slice(0, 120) });
  } catch (e) {
    // A reporting failure must never stop the agent trading. The chain already
    // has the trade; this is the arena's copy of it.
    log("report", { note: (e as Error).message.slice(0, 120) });
  }
}

// --- the loop ----------------------------------------------------------------
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });

const onchainOperator = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: "operator" })) as Address;
if (onchainOperator.toLowerCase() !== operator.address.toLowerCase()) {
  console.error(`\nVault ${vault} has operator ${onchainOperator}, but this key is ${operator.address}.`);
  console.error("Every trade would revert NotOperator(). Check OPERATOR_PRIVATE_KEY.\n");
  process.exit(1);
}
const gas = await pub.getBalance({ address: operator.address });
if (gas === 0n) log("preflight", { note: "operator holds 0 STT — every order will fail to pay for gas" });

log("boot", {
  agent: slug, vault, operator: operator.address,
  drift_threshold: cfg.driftThreshold, max_entry: cfg.maxEntry, dry_run: cfg.dryRun,
  // Which brain is running is the first thing to check when the agent behaves
  // unlike the one you thought you configured, so it is on the first line.
  brain: cfg.apiKey ? `${cfg.model} (${promptHash().slice(0, 10)}…)` : "deterministic — no ANTHROPIC_API_KEY",
});

while (!stopping) {
  try {
    const [sessionOpen, sessionEnd, nav] = (await Promise.all([
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "sessionOpen" }),
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "sessionEnd" }),
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "nav" }),
    ])) as [boolean, bigint, bigint];

    if (!sessionOpen) {
      log("idle", { reason: "no session open — run `npm run session`" });
      await new Promise((r) => setTimeout(r, cfg.pollMs));
      continue;
    }

    // NAV is cash. It falls as capital goes into positions and returns at
    // settlement — a vault at the floor mid-session is fully deployed, not lost.
    const budget = nav > cfg.minCash ? nav - cfg.minCash : 0n;
    if (budget === 0n) {
      log("idle", { reason: "at the cash floor", nav: formatUnits(nav, 6) });
      await new Promise((r) => setTimeout(r, cfg.pollMs));
      continue;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const live = await exchange.client.listLiveBinaryMarkets({ limit: 80 });
    const candidates = live.filter((m) => {
      if (!cfg.assets.includes(m.asset.toUpperCase())) return false;
      if (m.voided || m.winningOutcome !== null) return false;
      if (m.collateral.toLowerCase() !== SHANNON.collateral.toLowerCase()) return false;
      // The session boundary. Everything else here is preference; this one is
      // the contract's own rule and `trade` enforces it with a revert.
      if (Number(m.expiry) > Number(sessionEnd)) return false;
      if (Number(m.expiry) - nowSec < cfg.minRunwaySec) return false;
      return Number(m.tradingStart) <= nowSec;
    });

    log("scan", {
      live: live.length, tradable: candidates.length,
      nav: formatUnits(nav, 6), session_ends_in_s: Number(sessionEnd) - nowSec,
    });

    let acted = false;
    for (const market of candidates) {
      if (stopping) break;
      const pool = market.poolAddress as Address;
      const one = 10n ** BigInt(market.quoteDecimals);
      const [book, grid] = await Promise.all([
        exchange.client.getBinaryOrderBook(pool, { depth: 5, decimals: market.quoteDecimals }),
        exchange.client.getBinaryBookParams(pool),
      ]);

      const p = implied(book);
      if (p === null) continue;
      // In 6dp probability units, whatever the market's own decimals are.
      const wire = (p * 1_000_000n) / one;
      const samples = remember(market.id, wire, Date.now());

      const signal = view(samples, wire, Date.now());
      if (signal === null) continue;

      const allowance = budget < cfg.maxOrder ? budget : cfg.maxOrder;
      const order = sizeOrder(signal.kind, book, grid, one, allowance);
      if (order === null) continue;

      const symbol = `${market.asset}-${market.interval ?? "?"}`;
      log("signal", {
        market: symbol, side: signal.kind === BUY_YES ? "BUY_YES" : "BUY_NO",
        price: formatUnits(order.price, market.quoteDecimals),
        qty: formatUnits(order.quantity, market.quoteDecimals), why: `"${signal.why}"`,
      });

      // --- the model gate ------------------------------------------------
      // Placed after `sizeOrder` so the model is shown the order that would
      // actually be sent, and BEFORE the dry-run break so that a dry run
      // exercises the key, the prompt, the timeout and the parsing — which is
      // everything that can be wrong about the model wiring. Only `trade()` is
      // skipped by DRY_RUN. A developer who cannot test the model without
      // spending money will test it with money.
      let sent = order;
      let modelWhy: string | null = null;

      if (cfg.apiKey) {
        const perUnit = signal.kind === BUY_YES ? order.price : one - order.price;
        const candidate: Candidate = {
          question: market.question ?? symbol,
          symbol,
          side: signal.kind === BUY_YES ? "BUY_YES" : "BUY_NO",
          why: signal.why,
          impliedProb: Number(wire) / 1_000_000,
          secondsLeft: Number(market.expiry) - nowSec,
          cashUsdc: Number(formatUnits(nav, 6)),
          priceUsdc: Number(formatUnits(perUnit, market.quoteDecimals)),
          costUsdc: Number(formatUnits((perUnit * order.quantity) / one, market.quoteDecimals)),
          history: samples.map((s) => ({
            agoSec: Math.round((Date.now() - s.at) / 1000),
            p: Number(s.p) / 1_000_000,
          })),
        };

        const verdict = await approve(candidate, {
          apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.modelTimeoutMs,
        });

        // No usable answer is not a weak yes. The agent claims a model decided;
        // trading here would put a line in the record indistinguishable from the
        // lines where that is true.
        if (verdict === null) {
          log("model_out", { market: symbol, note: "no usable answer — not trading" });
          continue;
        }
        if (!verdict.act) {
          log("model_pass", { market: symbol, why: `"${verdict.why}"` });
          continue;
        }

        // A narrowed size still has to land on the pool's grid — see `narrow`.
        const quantity = narrow(order.quantity, verdict.size, grid.lotSize, grid.minQuantity);
        if (quantity === null) {
          log("model_pass", {
            market: symbol, why: `"${verdict.why}"`,
            note: `size ${verdict.size} rounds below minQuantity`,
          });
          continue;
        }
        sent = { price: order.price, quantity };

        modelWhy = verdict.why;
        log("model_act", {
          market: symbol, size: verdict.size,
          qty: formatUnits(sent.quantity, market.quoteDecimals), why: `"${verdict.why}"`,
        });
      }

      if (cfg.dryRun) { acted = true; break; }

      try {
        const expireNs = BigInt(nowSec + 30) * NS_PER_SEC;
        const hash = await wallet.writeContract({
          address: vault, abi: vaultAbi, functionName: "trade",
          args: [market.id as `0x${string}`, signal.kind, sent.price, sent.quantity, expireNs, ORDER_TYPE_IOC],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });

        // `Traded.cashDelta` is the vault's own measurement of what the order
        // cost, folded into protocolCash. It is the only number that knows what
        // actually filled: an IOC can take one level, all of them, or none.
        const traded = parseEventLogs({
          abi: vaultAbi, eventName: "Traded",
          logs: receipt.logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase()),
        })[0];
        const delta = traded?.args.cashDelta ?? 0n;

        log(delta === 0n ? "nofill" : "filled", {
          market: symbol,
          cash_delta: formatUnits(delta, market.quoteDecimals),
          gas_used: receipt.gasUsed, tx: hash,
        });
        await report(hash, market, signal.kind, sent.price, sent.quantity, modelWhy);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        // 0xd48c4403 is ImmediateOrCancelNoFill — the IOC crossed nothing. Not a
        // fault, and logging it as one buries the faults that are.
        if (msg.includes("0xd48c4403")) log("nofill", { market: symbol, reason: "nothing crossed" });
        else log("error", { market: symbol, reason: msg.slice(0, 160) });
      }
      acted = true;
      break; // One order per poll. Re-read NAV before deciding again.
    }

    if (!acted) log("hold", { reason: "no signal", watched: candidates.length });
  } catch (e) {
    // One bad poll — an indexer hiccup, an RPC timeout — is not a reason to stop
    // being the agent. The next poll re-reads everything from chain head.
    log("error", { reason: (e as Error).message.slice(0, 160) });
  }

  if (!stopping) await new Promise((r) => setTimeout(r, cfg.pollMs));
}

log("stopped");
process.exit(0);
