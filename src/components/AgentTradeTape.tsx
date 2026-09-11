import Link from "next/link";
import { Activity } from "lucide-react";
import type { AgentTrade } from "@/lib/domain/types";
import type { MarketOutcome } from "./agentApi";
import { txUrl } from "@/lib/wallet/chain";
import { ExternalLink, OutcomeTag } from "./Primitives";
import { clockTime, moneyTone, preciseUnits, pricePercent, shortHex, signedPrecise, tradeSide } from "./agentFormat";

/**
 * What the agent actually did.
 *
 * These are real orders against real DreamDEX BTC and ETH Event Contracts,
 * signed by the operator key and paid for out of the vault — which is the whole
 * claim the second layer rests on, so the tape is on the page rather than
 * behind a tab. Every row carries its transaction, because a trade nobody can
 * open on the explorer is a screenshot.
 *
 * `cash` is the signed change in the vault's `protocolCash` measured across the
 * call, not a fill price times a size: it is the only figure here that the NAV
 * the meta-market settles on is actually made of.
 *
 * Both money columns print through `preciseUnits` rather than `usdc`. An IOC
 * that takes one level moves 0.001 outcome tokens for 0.000155 tUSDC, and at
 * two decimals every one of those rows read "0.00" and "-0.00" — a real order
 * against a real book, displayed as an order that did nothing. A dash here
 * means the vault recorded no cash change at all, and the note under the table
 * says why rather than leaving the reader to guess.
 */
/**
 * What one order was worth once its market settled.
 *
 * A winning leg redeems at 1.0 per contract and a losing one at nothing, so the
 * result is `quantity` on a win and zero on a loss, against what the order cost.
 * `kind` 0 buys the Up leg and 2 the Down leg; `winningOutcome` 0 means Up paid.
 *
 * A void refunds, so it is neither a win nor a loss and prints as par rather
 * than as a zero — a voided order that reads "−14.14" would be a loss the vault
 * never took.
 */
function settleTrade(t: AgentTrade, o: MarketOutcome | undefined):
  | { state: "open" | "unread"; payout: null; pnl: null }
  | { state: "won" | "lost" | "void"; payout: bigint; pnl: bigint } {
  if (o === undefined) return { state: "unread", payout: null, pnl: null };
  if (!o.resolved && !o.voided) return { state: "open", payout: null, pnl: null };
  const cost = t.cashDelta === null ? 0n : -BigInt(t.cashDelta);
  if (o.voided) return { state: "void", payout: cost, pnl: 0n };
  const wonUp = o.winningOutcome === 0;
  const won = (t.kind === 0 && wonUp) || (t.kind === 2 && !wonUp);
  const payout = won ? BigInt(t.quantity) : 0n;
  return { state: won ? "won" : "lost", payout, pnl: payout - cost };
}

export function AgentTradeTape({
  trades,
  outcomes = {},
  className = "",
}: {
  trades: AgentTrade[];
  outcomes?: Record<string, MarketOutcome>;
  className?: string;
}) {
  if (trades.length === 0) {
    return (
      <div className={`empty-state ${className}`}>
        <Activity size={18} strokeWidth={1.8} aria-hidden />
        <span>
          No trades yet. The tape fills as the runner calls <span className="mono">trade()</span> —
          the only vault function the operator key can reach.
        </span>
      </div>
    );
  }

  // Counted, not assumed. A missing cash delta is a gap in what was measured,
  // and a tape that shows the gap without naming it is asking the reader to
  // read a dash as a zero.
  const unmeasured = trades.filter((t) => t.cashDelta === null).length;

  return (
    // The note sits outside `.agent-table-wrap`, which scrolls sideways on a
    // narrow screen; a sentence that scrolls away from the column it explains
    // is a sentence nobody reads.
    <div className={className}>
      <div className="agent-table-wrap">
        <table className="agent-table extended">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Contract</th>
              <th scope="col">Side</th>
              <th scope="col">Price</th>
              {/* Units in the header: the size is outcome tokens and the delta
                  is collateral, and they are not the same asset. */}
              <th scope="col">Size (tokens)</th>
              <th scope="col">Cash delta (tUSDC)</th>
              {/* Named "Result", not "Payout": a voided market refunds, which is
                  a result and not a payout. */}
              <th scope="col">Result</th>
              <th scope="col">P&amp;L (tUSDC)</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const { verb, outcome } = tradeSide(t.kind);
              const tone = moneyTone(t.cashDelta);
              const r = settleTrade(t, outcomes[t.marketId]);
              return (
                <tr key={t.id}>
                  <td className="num muted-cell whitespace-nowrap font-mono">{clockTime(t.at)}</td>
                  <td>
                    <Link href={`/market/${t.marketId}`} className="mono link">
                      {t.symbol ?? shortHex(t.marketId)}
                    </Link>
                  </td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium">{verb}</span>
                      <OutcomeTag outcome={outcome} />
                    </span>
                  </td>
                  <td className="num font-mono">{pricePercent(t.price)}</td>
                  <td className="num muted-cell font-mono">{preciseUnits(t.quantity)}</td>
                  <td
                    className={`num font-mono font-semibold ${
                      tone === "good" ? "positive" : tone === "danger" ? "negative" : "text-fg-muted"
                    }`}
                  >
                    {/* Not a zero. `cashDelta` is null when the vault's own
                        `Traded` event was not in the transaction's receipt, so
                        nothing measured what this order cost. */}
                    <span
                      title={
                        t.cashDelta === null
                          ? "No Traded event in this transaction's receipt — the vault measured no cash change for this order"
                          : undefined
                      }
                    >
                      {signedPrecise(t.cashDelta)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    {r.state === "won" ? (
                      <span className="positive font-medium">Won</span>
                    ) : r.state === "lost" ? (
                      <span className="negative font-medium">Lost</span>
                    ) : r.state === "void" ? (
                      <span className="text-fg-muted">Void · refunded</span>
                    ) : (
                      <span
                        className="text-fg-subtle"
                        title={
                          r.state === "unread"
                            ? "This market's settlement did not answer on this read"
                            : "This market has not settled yet"
                        }
                      >
                        {r.state === "unread" ? "unread" : "open"}
                      </span>
                    )}
                  </td>
                  <td
                    className={`num font-mono font-semibold ${
                      r.pnl === null ? "text-fg-subtle" : r.pnl > 0n ? "positive" : r.pnl < 0n ? "negative" : "text-fg-muted"
                    }`}
                  >
                    {r.pnl === null ? "—" : signedPrecise(r.pnl.toString())}
                  </td>
                  <td>
                    <ExternalLink href={txUrl(t.txHash)} className="font-mono text-[10px] text-fg-subtle hover:text-fg-muted">
                      {shortHex(t.txHash, 6, 4)}
                    </ExternalLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {unmeasured > 0 && (
        <p className="mt-3 text-[10px] leading-relaxed text-fg-subtle">
          {unmeasured === 1 ? "One order carries" : `${unmeasured} orders carry`} a dash instead of a
          cash delta: the vault&rsquo;s <span className="mono">Traded</span> event was not in that
          transaction&rsquo;s receipt, so nothing measured what the order cost. The transaction is
          still linked, and the receipt on the explorer is the record.
        </p>
      )}
    </div>
  );
}
