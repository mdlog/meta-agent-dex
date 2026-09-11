import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ExternalLink, Network, ShieldCheck } from "lucide-react";
import { listAgents } from "@/lib/services/agents";
import { listSessions, listTrades } from "@/lib/services/agentSessions";
import { SETTLE_WINDOW_SEC } from "@/lib/agents/orchestrator";
import { addressUrl, txUrl } from "@/lib/wallet/chain";
import { preciseUnits, shortHex, signedPrecise, tradeSide, usdc, utcClock } from "@/components/agentFormat";
import { LiveRefresh } from "@/components/LiveRefresh";
import {
  CONTRADICTIONS,
  EVIDENCE,
  KEEPER_ADDRESS,
  OPERATOR_ID,
  SESSION_VAULT,
  TOPUP_READING,
  TOPUP_VAULT,
  VENUE_ID,
  type EvidenceTone,
} from "@/lib/audit/evidence";
import type { Agent } from "@/lib/domain/types";

/**
 * The evidence page, for the reader who intends to check.
 *
 * Two halves, kept visibly apart because they are worth different things. The
 * top half is fixed: transactions mined before the demo, transcribed from the
 * record in `docs/ONCHAIN_EVIDENCE.md`, each one a link into the Shannon
 * explorer. The bottom half is whatever this deployment has done since — every
 * session open, mint, freeze and trade the journal has a hash for — so the page
 * grows while the demo runs instead of being a museum.
 *
 * Nothing on it is invented. A row without a transaction says why it has none
 * rather than borrowing a neighbour's hash, and the live half renders an empty
 * state when nothing has run, because an empty ledger is a true ledger. Its
 * left column is this app's clock and is headed as such: no row here carries a
 * block timestamp, and the explorer link is where the mined time lives.
 *
 * The design this is ported from counted "1,284,093 verified events" and
 * streamed five fictional ones. The number here is the length of a list you can
 * open.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Audit ledger",
  description:
    "Every claim this project makes, as a transaction on Somnia Shannon: the operator and venue it registered, the first meta-market it settled, the vault's real order, and the faucet top-up that moved NAV by zero.",
};

/** One line in either ledger. The live half fills the same shape as the fixed half. */
interface LedgerLine {
  key: string;
  /**
   * Sort key for the live half, in milliseconds. Never displayed — `when` is —
   * because the displayed string carries an "after" prefix on the two events
   * that do not record their own time, and sorting on that text would file
   * every one of them together instead of in sequence.
   */
  sortAt: number;
  /**
   * Left column. A stage name in the fixed trail; in the live one, the moment
   * THIS APP observed the event — see {@link stamp}. Never a block time.
   */
  when: string;
  event: string;
  subject: string;
  /** Null where no transaction exists; `note` then explains the absence. */
  txHash: string | null;
  note: string | null;
  result: string;
  tone: EvidenceTone;
  /** Where the event's link goes when it is not a transaction. */
  href: string | null;
}

/**
 * When THIS APP saw a live event — never when the chain did.
 *
 * NONE OF THESE IS A BLOCK TIME. `opensAt` and a trade's `at` are `Date.now()`
 * read on the app server as the keeper wrote the row, and the journal has no
 * column for the block timestamp of the receipt. Printed to the second beside
 * an explorer link they read as the mined time, and they are not it: they lead
 * or lag it by whatever the round trip and the node's inclusion took, and a
 * reader comparing this page against the explorer would find two clocks and no
 * way to tell which was lying.
 *
 * So two things changed and both are deliberate. The seconds are gone —
 * precision the source does not have is a claim about the source — and the
 * column is headed "Observed by this app" rather than "When", which is what the
 * figure actually is. Where the block time matters, it is one click away in the
 * transaction the event name links to.
 *
 * `exact` still separates the two kinds. `openSession` and every trade were
 * observed at a moment this app recorded; the mint lands inside the same call
 * as the open and the freeze lands some time after the window closes, and
 * neither is observed at all — those are labelled "after" the boundary that is
 * known, because inventing a minute for them would be the one fabricated number
 * on a page whose subject is that there are none.
 */
function stamp(at: number, exact: boolean): string {
  return exact ? utcClock(at) : `after ${utcClock(at)}`;
}

function LedgerRows({ lines }: { lines: readonly LedgerLine[] }) {
  return (
    <>
      {lines.map((line) => (
        <div className="ledger-row" key={line.key}>
          <span className="mono muted-cell">{line.when}</span>
          <span>
            {/* The link lives on the event, not on the hash. Below 760px the
                theme hides the transaction column to keep the row readable, and
                a ledger whose links disappear on a phone is not a ledger. */}
            {line.txHash !== null ? (
              <a className="link event-type" href={txUrl(line.txHash)} target="_blank" rel="noreferrer">
                {line.event}
              </a>
            ) : line.href !== null ? (
              <Link className="link event-type" href={line.href}>
                {line.event}
              </Link>
            ) : (
              <strong className="event-type">{line.event}</strong>
            )}
          </span>
          <span>{line.subject}</span>
          <span className="mono muted-cell">
            {line.txHash !== null ? shortHex(line.txHash, 8, 4) : line.note}
          </span>
          <span className={`outcome ${line.tone}`}>{line.result}</span>
        </div>
      ))}
    </>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  /**
   * `?agent=<slug>` narrows the live ledger to one agent.
   *
   * The profile page's tape is scoped to a single session, so it links here for
   * the whole record — and a link promising "every trade this agent made" that
   * lands on an unfiltered four-thousand-row page has not kept its promise.
   * The verified trail above is never filtered: it is the project's own
   * provenance, not any one agent's.
   */
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent: agentFilter } = await searchParams;

  // Straight through the service layer: this is the same journal
  // `/api/agents/sessions` serves, and a server component holding the database
  // handle has no reason to ask itself over HTTP for it.
  const allAgents = listAgents();
  // An unknown slug narrows to nothing rather than silently showing everything:
  // a filter that fails open tells the reader they are looking at one agent
  // while they are looking at eleven.
  const focused = agentFilter ? allAgents.find((a) => a.slug === agentFilter) ?? null : null;
  const agents = agentFilter ? (focused ? [focused] : []) : allAgents;
  const byId = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const sessions = agents.flatMap((a) => listSessions(a.id));

  const live: LedgerLine[] = [];

  for (const s of sessions) {
    const agent = byId.get(s.agentId);
    const who = agent ? `${agent.name} · session ${s.sessionNumber}` : `session ${s.sessionNumber}`;

    if (s.openTx !== null) {
      live.push({
        key: `${s.id}-open`,
        sortAt: s.opensAt,
        when: stamp(s.opensAt, true),
        event: "openSession",
        subject: `${who} · oracle ${shortHex(s.oracleAddress)}`,
        txHash: s.openTx,
        note: null,
        result: s.navT0 !== null ? `navT0 ${usdc(s.navT0)}` : "navT0 not read",
        tone: "cyan",
        href: null,
      });
    }

    if (s.mintTx !== null) {
      live.push({
        key: `${s.id}-mint`,
        // A hair after the open, inside the same call. Nudged so the mint files
        // below its own openSession rather than tying with it.
        sortAt: s.opensAt + 1,
        when: stamp(s.opensAt, false),
        event: "scheduleAndCreateMarket",
        subject: s.metaMarketId !== null ? `market ${shortHex(s.metaMarketId)}` : who,
        txHash: s.mintTx,
        note: null,
        result: "MINTED",
        tone: "violet",
        href: null,
      });
    }

    if (s.finalizeTx !== null) {
      live.push({
        key: `${s.id}-finalize`,
        sortAt: s.closesAt,
        when: stamp(s.closesAt, false),
        event: "finalize",
        subject:
          s.navT0 !== null && s.navT1 !== null
            ? `navT0 ${usdc(s.navT0)} → navT1 ${usdc(s.navT1)}`
            : who,
        txHash: s.finalizeTx,
        note: null,
        // 1 = YES = NAV rose, the encoding BotNavOracle.OUTCOME_YES declares.
        result:
          s.outcomeValue === 1
            ? "outcomeValue 1 · YES"
            : s.outcomeValue === 2
              ? "outcomeValue 2 · NO"
              : "no answer",
        tone: s.outcomeValue === 1 ? "up" : s.outcomeValue === 2 ? "down" : "void",
        href: null,
      });
    }

    if (s.status === "settled" || s.status === "void") {
      live.push({
        key: `${s.id}-committee`,
        // The committee reads at resolutionTime; it votes when it votes.
        sortAt: s.closesAt + SETTLE_WINDOW_SEC * 1000,
        when: stamp(s.closesAt + SETTLE_WINDOW_SEC * 1000, false),
        event: "committee resolution",
        subject: s.metaMarketId !== null ? `market ${shortHex(s.metaMarketId)}` : who,
        txHash: null,
        note: "committee event · via indexer",
        result: s.voided
          ? "REFUNDED"
          : s.resolvedOutcome === 0
            ? "PAID index 0 · Up"
            : s.resolvedOutcome === 1
              ? "PAID index 1 · Down"
              : "NOT READ",
        tone: s.voided ? "void" : s.resolvedOutcome === 0 ? "up" : s.resolvedOutcome === 1 ? "down" : "void",
        // No transaction of ours to link, but the market itself is a page.
        href: s.metaMarketId !== null ? `/market/${s.metaMarketId}` : null,
      });
    }

    for (const t of listTrades(s.id)) {
      const { verb, outcome } = tradeSide(t.kind);
      live.push({
        key: `trade-${t.id}`,
        sortAt: t.at,
        when: stamp(t.at, true),
        event: "placeBinaryOrder",
        // `usdc(quantity, 0)` printed whole outcome tokens, so every order
        // below one token — 35 of the 131 in the journal as this was written —
        // read "Buy YES 0" on a ledger whose entire purpose is that a stranger
        // can check it. `preciseUnits` keeps two places where two places carry
        // the size and falls through to the exact figure where they do not.
        //
        // The unit is named because the size is outcome tokens while the result
        // beside it is collateral: two 6-decimal figures in one row, and only
        // the labels say they are different assets.
        subject: `${verb} ${outcome === "up" ? "YES" : "NO"} ${preciseUnits(t.quantity)} tokens · ${
          t.symbol ?? shortHex(t.marketId)
        }`,
        txHash: t.txHash,
        note: null,
        // The absence has a reason and the reason is the interesting part: the
        // vault's own `Traded` event was not in that receipt, so nothing
        // measured the order's cost. "not measured" alone reads like a shrug.
        result:
          t.cashDelta !== null
            ? `${signedPrecise(t.cashDelta)} cash`
            : "no Traded event in receipt",
        tone:
          t.cashDelta === null ? "cyan" : BigInt(t.cashDelta) > 0n ? "up" : BigInt(t.cashDelta) < 0n ? "down" : "cyan",
        href: null,
      });
    }
  }

  // Newest first. The list is capped so a long-running demo does not turn the
  // page into a scroll; the count above it stays honest about the full total.
  live.sort((a, b) => b.sortAt - a.sortAt);
  const shown = live.slice(0, 30);

  const fixedTx = EVIDENCE.filter((r) => r.txHash !== null).length;
  const liveTx = live.filter((r) => r.txHash !== null).length;
  const now = Date.now();

  const fixed: LedgerLine[] = EVIDENCE.map((row, i) => ({
    key: `evidence-${i}`,
    // The fixed trail is rendered in the order it is authored — the order the
    // transactions were mined — so it never reaches a comparator.
    sortAt: 0,
    when: row.stage,
    event: row.event,
    subject: row.subject,
    txHash: row.txHash,
    note: row.note ?? null,
    result: row.result,
    tone: row.tone,
    href: null,
  }));

  return (
    <>
      <div className="subpage-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> PUBLIC EVIDENCE
          </div>
          <h1>Audit ledger</h1>
          <p>
            Every claim this project makes, as a transaction you can open. The trail below was mined and
            checked before the demo; the live stream underneath is whatever this deployment has done
            since.
          </p>
        </div>
        <div className="subpage-context">
          <span className="signal-ring small" /> SOMNIA SHANNON <span className="mono">/ CHAIN 50312</span>
        </div>
      </div>

      <div className="ledger-overview">
        <div className="ledger-main-stat">
          <span className="metric-label">Transactions you can open</span>
          <strong>{fixedTx + liveTx}</strong>
          <span className="metric-delta neutral">
            {fixedTx} from the verified trail · {liveTx} from this deployment
            {/* Said on the figure itself, not in a banner elsewhere. A filtered
                count under an unqualified heading is the same number claiming
                to be a different thing. */}
            {focused !== null && ` · live rows narrowed to ${focused.name}`}
          </span>
        </div>

        {agentFilter !== undefined && focused === null && (
          <div className="callout callout-neutral">
            No agent has the slug <span className="mono">{agentFilter}</span>, so the live ledger
            below is empty. The verified trail is unaffected — it belongs to the project, not to any
            one agent.
          </div>
        )}
        <div className="ledger-trust">
          <ShieldCheck size={19} strokeWidth={1.8} />
          <div>
            <strong>
              Operator {OPERATOR_ID} · venue {shortHex(VENUE_ID)}
            </strong>
            <span>Registered by this project, so no third party can close the venue mid-demo.</span>
          </div>
        </div>
        <a className="secondary-button" href={addressUrl(KEEPER_ADDRESS)} target="_blank" rel="noreferrer">
          <ExternalLink size={15} strokeWidth={1.8} /> Deployer on the explorer
        </a>
      </div>

      <div className="page-card ledger-card">
        <div className="card-header-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> MINED AND CHECKED BEFORE THE DEMO
            </div>
            <h2>The verified trail</h2>
          </div>
        </div>
        <div className="ledger-table">
          <div className="ledger-row ledger-head">
            <span>Stage</span>
            <span>Call</span>
            <span>Subject</span>
            <span>Transaction</span>
            <span>Result</span>
          </div>
          <LedgerRows lines={fixed} />
        </div>
      </div>

      <div className="page-card mt-4">
        <div className="card-header-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> NAV INTEGRITY
            </div>
            <h2>A wallet top-up cannot move NAV</h2>
          </div>
          <a className="view-link" href={addressUrl(TOPUP_VAULT)} target="_blank" rel="noreferrer">
            This vault <ArrowUpRight size={14} strokeWidth={1.8} />
          </a>
        </div>
        <p className="section-description">
          Shannon&apos;s collateral has a permissionless faucet(uint256) with no cooldown and a 10,000
          per-call cap, so a stranger can push tokens into any address for the price of gas. 10,000 tUSDC
          were sent into the vault below, and then all three values were read back.
        </p>
        {TOPUP_READING.map((row) => (
          <div className="setting-field" key={row.call}>
            <span>{row.call}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
        <p className="section-description">
          nav() counts protocolCash — collateral measured inside an allowlisted DreamDEX call. The
          10,000 that arrived by faucet is visible to anyone as unaccounted(), and it is not part of the
          number a meta-market settles on. This is why NAV is never a token balance.
        </p>
      </div>

      <div className="page-card ledger-card mt-4">
        <div className="card-header-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> THIS DEPLOYMENT
            </div>
            <h2>Live session events</h2>
          </div>
          <LiveRefresh renderedAt={now} everyMs={15_000} />
        </div>

        {shown.length === 0 ? (
          <p className="empty-state">
            No session has run on this deployment yet. Open one from the agent board and its
            transactions land here.
          </p>
        ) : (
          <div className="ledger-table">
            <div className="ledger-row ledger-head">
              {/* Observation time, and it says so. See `stamp` above: this
                  column is the app server's clock at the moment it wrote the
                  row, not the block's. */}
              <span>Observed by this app (UTC)</span>
              <span>Call</span>
              <span>Subject</span>
              <span>Transaction</span>
              <span>Result</span>
            </div>
            <LedgerRows lines={shown} />
          </div>
        )}

        {/* The cap, said out loud. It was documented in a comment and nowhere a
            reader could see it, so a list of thirty under a count of thousands
            invited the reading that thirty was all there was. */}
        {live.length > shown.length && (
          <p className="section-description">
            Newest {shown.length} of {live.length.toLocaleString()} rows
            {focused !== null && ` for ${focused.name}`}. The list is capped so a long-running
            deployment does not turn this page into a scroll; the count above it is the full total,
            and every row it omits is still on chain.
          </p>
        )}

        <p className="section-description">
          The left column is this app&apos;s own clock at the moment it recorded the event, to the
          minute. It is not the block timestamp and the two will not agree exactly — the journal
          stores no block time, so rather than dress the app&apos;s clock up as the chain&apos;s,
          it is labelled for what it is. The mined time is in the transaction each event name links
          to. Rows written &ldquo;after&rdquo; a boundary record no time of their own at all.
        </p>
      </div>

      <div className="page-card mechanics-card mt-4">
        <div className="eyebrow">
          <span className="eyebrow-line" /> WHAT TESTING CONTRADICTED
        </div>
        <h2>Where the documentation and the chain disagree</h2>
        {CONTRADICTIONS.map((c, i) => (
          <div className="mechanic-step" key={c.claim}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <strong>{c.claim}</strong>
              <p>{c.measured}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="subpage-callout">
        <div className="callout-icon">
          <Network size={20} strokeWidth={1.8} />
        </div>
        <div>
          <strong>The loss in the trail is the product working</strong>
          <p>
            The session on vault {shortHex(SESSION_VAULT)} bought YES, NO won, and the contracts expired
            worthless — a −7.40 tUSDC session. A market on &ldquo;will this agent profit&rdquo; only
            means something if the answer can be no.
          </p>
        </div>
        <Link className="primary-button" href="/settlement">
          How settlement works <ArrowUpRight size={15} strokeWidth={1.8} />
        </Link>
      </div>
    </>
  );
}
