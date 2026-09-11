/**
 * Display rules for agent money, identifiers and clocks.
 *
 * Every figure on the agent screens arrives as a raw 6-decimal integer in a
 * string, because that is what `BotVault.nav()` returns and a double drops
 * digits inside the number a meta-market settles on. Nothing here turns one
 * into a float except {@link unitsFloat}, which exists only to place a pixel on
 * a chart and is never the value a reader is shown.
 *
 * It is a module rather than a component for the same reason `icons.ts` is: the
 * board, the profile and the tape all print these, and three copies of the
 * rounding rule would drift.
 */

import type { AgentSession, AgentTradeKind, Outcome } from "@/lib/domain/types";

/** tUSDC on Shannon. The collateral this whole product is denominated in. */
const SCALE = 1_000_000n;

function toBigInt(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined || raw === "") return null;
  // `BigInt()` accepts " 42", "0x2a" and "" — the service layer guards writes
  // with the same regex, and this guards a payload that arrived over HTTP.
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(raw.trim())) return null;
  return BigInt(raw.trim());
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A raw 6dp integer as tUSDC.
 *
 * Truncated, not rounded: 199.999999 displayed as "200.00" is a claim the vault
 * cannot honour, and the digits below the cent are never the point of the
 * reading. `—` for anything missing, so an absent NAV never renders as 0.00 —
 * "nothing measured yet" and "measured, and it is zero" are different facts.
 */
export function usdc(raw: string | null | undefined, places = 2): string {
  const n = toBigInt(raw);
  if (n === null) return "—";
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = group((abs / SCALE).toString());
  if (places <= 0) return `${neg ? "-" : ""}${whole}`;
  const frac = (abs % SCALE).toString().padStart(6, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** The same, with the sign always shown — a P&L column that reads as one. */
export function signedUsdc(raw: string | null | undefined, places = 2): string {
  const n = toBigInt(raw);
  if (n === null) return "—";
  return `${n > 0n ? "+" : ""}${usdc(raw, places)}`;
}

/**
 * A raw 6dp figure printed with enough digits that a real movement never reads
 * as nothing.
 *
 * {@link usdc} stops at the cent, which is right for a NAV in the hundreds and
 * wrong for the two columns on the trade tape. Outcome-token sizes go down to
 * 0.001 and the vault's own `cashDelta` down to 0.000025 — every one of those
 * was printing "0.00" and "-0.00", so an order that moved collateral read as an
 * order that did nothing, on the one page whose whole argument is that its
 * numbers are checkable.
 *
 * Two places whenever two places carry the value; otherwise every digit the
 * chain recorded, trailing zeros trimmed. Nothing is rounded up to look like
 * something: these are exact integers of micro-units, so the longer form is the
 * same number written out rather than a more precise guess. A measured zero
 * still prints as `0.00`, because "it filled for nothing" is a fact and is not
 * the same claim as `—`.
 */
export function preciseUnits(raw: string | null | undefined, places = 2): string {
  const n = toBigInt(raw);
  if (n === null) return "—";
  const abs = n < 0n ? -n : n;
  // The smallest amount `places` decimals can show. Below it, and non-zero, is
  // exactly the case that was truncating to zero.
  const floorUnit = places >= 0 && places < 6 ? SCALE / 10n ** BigInt(places) : 1n;
  if (abs === 0n || abs >= floorUnit) return usdc(raw, places);
  // `abs < SCALE` here, so the whole part is 0 and the fraction is non-zero —
  // the trim can never eat the last digit and leave a bare "0.".
  return usdc(raw, 6).replace(/0+$/, "");
}

/** The same, with the sign always shown — the tape's cash column reads as one. */
export function signedPrecise(raw: string | null | undefined, places = 2): string {
  const n = toBigInt(raw);
  if (n === null) return "—";
  return `${n > 0n ? "+" : ""}${preciseUnits(raw, places)}`;
}

/** Sign of a raw money column, as a tone. `null` when there is nothing to read. */
export function moneyTone(raw: string | null | undefined): "good" | "danger" | "muted" | null {
  const n = toBigInt(raw);
  if (n === null) return null;
  return n > 0n ? "good" : n < 0n ? "danger" : "muted";
}

/**
 * Add raw money columns without ever leaving BigInt.
 *
 * Unreadable entries are skipped rather than coerced to zero: a payload that
 * lost a NAV must not quietly reduce a total, and it must never throw on a
 * board that is otherwise fine.
 */
export function sumRaw(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const v of values) {
    const n = toBigInt(v);
    if (n !== null) total += n;
  }
  return total.toString();
}

/** navT1 − navT0, as a raw string. Null unless the chain confirmed both ends. */
export function navDelta(navT0: string | null, navT1: string | null): string | null {
  const a = toBigInt(navT0);
  const b = toBigInt(navT1);
  if (a === null || b === null) return null;
  return (b - a).toString();
}

/**
 * A raw money column as a float, for chart geometry only.
 *
 * The precision loss is real and irrelevant here: the result is multiplied by a
 * pixel height and rounded to a viewBox coordinate. It must never reach a
 * readout — every visible number goes through {@link usdc}.
 */
export function unitsFloat(raw: string | null | undefined): number | null {
  const n = toBigInt(raw);
  return n === null ? null : Number(n) / 1e6;
}

/**
 * `8412093` → `8,412,093`, and `null` for anything that is not a height.
 *
 * Grouped by regex over the digits rather than through `Number` and
 * `toLocaleString`: a block height is a `uint256` from chain, it is the thing
 * this product asks a stranger to go and check, and it must not pass through a
 * double on its way to the page. Fixed grouping for the same reason
 * `utcClock` is fixed — a server render and a browser render that punctuate it
 * differently are a hydration mismatch.
 *
 * `null` in means the sampler recorded no height for that read; the caller
 * prints nothing rather than inventing one.
 */
export function blockLabel(raw: string | null | undefined): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  return group(raw);
}

/** `0x1234…cdef`. The elision is the point: a full 32-byte hash is unreadable in a row. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * A wire price as a probability.
 *
 * The pool quotes in whole 6-decimal units, so 625_000 is 62.5% — one decimal,
 * because the tick is finer than a percent and rounding to whole percents makes
 * two different fills print the same price.
 */
export function pricePercent(price: number): string {
  return `${(price / 10_000).toFixed(1)}%`;
}

/** OrderKind, split into the two things it says: a verb and a side. */
export function tradeSide(kind: AgentTradeKind): { verb: "Buy" | "Sell"; outcome: Outcome } {
  return { verb: kind % 2 === 0 ? "Buy" : "Sell", outcome: kind <= 1 ? "up" : "down" };
}

/**
 * Is this session still taking positions?
 *
 * The status column cannot answer that on its own. `open` means the keeper has
 * not run `closeSession()` yet, which is a statement about our keeper and not
 * about the market: a session whose `closesAt` has passed is over, and the
 * cards say so, because {@link Countdown} switches to "awaiting settlement" at
 * exactly this boundary. A summary tile that counted rows instead of reading
 * the clock printed "3 sessions open · taking bets right now" over three cards
 * that all read "closes in awaiting settlement" — same paint, opposite claims.
 *
 * `closing` is excluded for the same reason: the window is shut and the vault
 * is being wound down, whatever the clock says.
 *
 * `deriveStatus` already settles this argument one layer down — the indexer
 * reports "Trading" long after expiry because the transition emits no event,
 * and the clock wins there too (tests/dreamdex.test.ts). This is the same rule
 * applied to our own session rows.
 */
export function isTakingPositions(session: AgentSession, now: number): boolean {
  return session.status !== "closing" && session.closesAt > now;
}

/**
 * A millisecond timestamp, in the reader's own locale.
 *
 * Only ever called from a component that renders after its fetch resolves. A
 * server render of a locale time and a browser render of the same value
 * disagree whenever the two are in different timezones, and React reports that
 * as a hydration mismatch — the bug `Countdown` documents at length.
 */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * How old a reading is — the sentence that has to sit beside any figure this
 * app did not just measure.
 *
 * BOTH INSTANTS ARE ARGUMENTS. Reading the clock in here would make a component
 * that renders on the server and hydrates in the browser compute two different
 * ages, which React reports as a hydration mismatch (the bug `Countdown`
 * documents at length). Server-rendered callers pass the page's own
 * `renderedAt`; client-only callers pass `Date.now()` after their fetch has
 * resolved.
 *
 * Nothing below a minute is given a number. A NAV sample's freshness is not
 * measured to the second and printing "18s old" would imply a sampler that runs
 * every second — there isn't one; rows land at registration and at session
 * close, which is exactly why this function has to exist.
 */
export function ageLabel(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000);
  // A reader's clock can sit behind the server's. "Ahead of the clock" is not a
  // fact worth printing, and a negative age would read as a typo.
  if (mins < 1) return "under a minute old";
  if (mins < 60) return `${mins}m old`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest === 0 ? `${hours}h old` : `${hours}h ${rest}m old`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "a day old" : `${days}d old`;
}

/**
 * The same instant in UTC, which is the sibling {@link clockTime} cannot be.
 *
 * The protocol pages render on the server, where "the reader's locale" is the
 * host's locale and therefore a guess. More importantly, what they timestamp is
 * a chain trail: block times, `resolutionTime`, and every row in the Shannon
 * explorer are UTC, and a judge holding this page beside the explorer should
 * not have to do timezone arithmetic to see that the two agree.
 *
 * Built by slicing the ISO string rather than through `Intl`, so the output is
 * byte-identical wherever it renders.
 *
 * TO THE MINUTE, AND THERE IS NO SECONDS OPTION. There was one, and the audit
 * ledger used it: second-precision UTC printed in the column beside an explorer
 * link, over values that are `Date.now()` on the app server at the moment a row
 * was written. Nothing in this app carries a block timestamp, so seconds there
 * were precision the source does not have, stated next to the one clock a
 * reader would check it against. Minutes, and a column that says whose clock it
 * is, are what those values can support.
 */
export function utcClock(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
