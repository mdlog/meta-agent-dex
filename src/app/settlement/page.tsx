import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Clock3, Gauge, ScrollText, ShieldCheck } from "lucide-react";
import { listAgents } from "@/lib/services/agents";
import { listOpenSessions, listSessions } from "@/lib/services/agentSessions";
import { SETTLE_WINDOW_SEC } from "@/lib/agents/orchestrator";
import { navDelta, signedUsdc, usdc, utcClock } from "@/components/agentFormat";
import { Countdown } from "@/components/Countdown";
import { LiveRefresh } from "@/components/LiveRefresh";
import type { Agent, AgentSession, AgentSessionStatus } from "@/lib/domain/types";

/**
 * The settlement engine, stated as what actually happens.
 *
 * The design this page is ported from claimed an "AgentPerformanceOracle" that
 * was "operational", a "median resolution 4.2s", and a permissionless
 * settlement call. Two of those are false here and the third is only half true,
 * so none of them survived:
 *
 *  - The contract is `BotNavOracle`, one per session, and it does not resolve
 *    anything. It publishes a number. A DreamDEX validator subcommittee reads
 *    that number at the market's `resolutionTime` and votes on what it saw.
 *  - Nothing resolves in 4.2 seconds. Resolution happens at `resolutionTime`,
 *    which this system sets to close + 180s, and the committee answers when it
 *    answers.
 *  - `redeemAll()`, `closeSession()` and `finalize()` genuinely are
 *    permissionless — anyone may call them — so that claim is made here, once,
 *    where it is true, rather than stretched over the whole pipeline.
 *
 * Every count and every clock below is read from the session journal. There is
 * no seeded row on this page; an empty queue renders as an empty queue.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Settlement engine",
  description:
    "How an agent session becomes a settled Event Contract: a NAV snapshot taken on chain before the market exists, a permissionless freeze after it closes, and a DreamDEX oracle committee that reads the frozen number at resolutionTime.",
};

/** The statuses a keeper still owes work on — the same set `listOpenSessions` selects. */
const LIVE: readonly AgentSessionStatus[] = ["pending", "open", "closing"];

/**
 * Session state in the Signal Room's pill vocabulary.
 *
 * The words are `AgentStatusPill`'s, unchanged, because a reader meets them
 * first on the agent board and a second name for one state is a second state as
 * far as they can tell. Only the colour language differs: this page is ported
 * design, so it wears `.status-pill` rather than `.badge`.
 */
const PILL: Record<AgentSessionStatus, { label: string; tone: string }> = {
  pending: { label: "Opens soon", tone: "" },
  open: { label: "Trading", tone: "is-live" },
  closing: { label: "Settling", tone: "is-settling" },
  finalized: { label: "Answered", tone: "is-settling" },
  settled: { label: "Resolved", tone: "is-settled" },
  void: { label: "Voided", tone: "is-void" },
};

/**
 * A stable per-agent accent, so the same agent keeps the same swatch between
 * renders. Lime is deliberately not in the set: on this page lime means
 * verified or live, and an agent that happened to hash to it would read as a
 * status rather than an identity.
 */
const IDENTITY = ["cyan", "violet", "amber"] as const;

function identityTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return IDENTITY[h % IDENTITY.length];
}

/** How far through its own trading window a session is, 0–100. */
function windowProgress(session: AgentSession, now: number): number {
  const span = session.closesAt - session.opensAt;
  if (span <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round(((now - session.opensAt) / span) * 100)));
}

/** Money delta as a tone class. Zero is neither — it is a flat session. */
function deltaTone(raw: string | null): string {
  if (raw === null) return "muted-cell";
  const n = BigInt(raw);
  return n > 0n ? "positive" : n < 0n ? "negative" : "muted-cell";
}

export default function SettlementPage() {
  // Read through the service layer rather than over HTTP to `/api/agents/
  // sessions`. It is the same journal the route serves, and a server component
  // fetching its own API would need an absolute origin and would spend a round
  // trip to get an answer it is already holding the database handle for.
  const agents = listAgents();
  const byId = new Map<string, Agent>(agents.map((a) => [a.id, a]));

  const open = listOpenSessions();
  const finished = agents
    .flatMap((a) => listSessions(a.id))
    .filter((s) => !LIVE.includes(s.status))
    .sort((a, b) => b.closesAt - a.closesAt);

  const now = Date.now();
  const minted = open.filter((s) => s.metaMarketId !== null).length;
  const overdue = open.filter((s) => now >= s.closesAt).length;
  const answered = finished.filter((s) => s.status === "finalized").length;
  const settled = finished.filter((s) => s.status === "settled").length;
  const voided = finished.filter((s) => s.status === "void").length;

  const recent = finished.slice(0, 10);

  // The banner's right-hand pill says the loudest true thing about the queue,
  // in priority order: work owed, then work in progress, then nothing running.
  const banner =
    overdue > 0
      ? { tone: "is-settling", text: `${overdue} past close, awaiting a keeper pass` }
      : open.length > 0
        ? { tone: "is-live", text: `${open.length} session${open.length === 1 ? "" : "s"} in the window` }
        : { tone: "is-void", text: "No session open" };

  return (
    <>
      <div className="subpage-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> PROTOCOL MONITOR
          </div>
          <h1>Settlement engine</h1>
          <p>
            What has to happen, and who has to act, between a session closing and a meta-market paying
            out. Every clock on this page is the one the chain is keeping.
          </p>
        </div>
        <div className="subpage-context">
          <span className="signal-ring small" /> SOMNIA SHANNON <span className="mono">/ CHAIN 50312</span>
        </div>
      </div>

      <div className="settlement-status-banner">
        <div className="status-banner-icon">
          <ShieldCheck size={22} strokeWidth={1.8} />
        </div>
        <div>
          <strong>Settlement is defined by code and attested by DreamDEX&apos;s oracle committee</strong>
          <span>
            BotNavOracle publishes one number per session. NAV is a figure anyone can re-derive from two
            published block numbers — we do not resolve our own markets, and we could not.
          </span>
        </div>
        <span className={`status-pill ${banner.tone}`}>
          <span className="status-dot" /> {banner.text}
        </span>
      </div>

      <div className="stat-grid four">
        <div className="stat-card">
          <span className="metric-label">Sessions open</span>
          <strong>{open.length}</strong>
          <span className="metric-delta neutral">
            {open.length === 0
              ? "Nothing is taking positions"
              : `${minted} with a live meta-market · ${open.length - minted} awaiting mint`}
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Awaiting the committee</span>
          <strong>{answered}</strong>
          <span className="metric-delta neutral">Oracle frozen · the answer cannot be restated</span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Resolved / void</span>
          <strong>
            {settled} / {voided}
          </strong>
          <span className="metric-delta neutral">A void refunds both sides. It is not a loss</span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Settle window</span>
          <strong>{SETTLE_WINDOW_SEC}s</strong>
          <span className="metric-delta neutral">Market close → resolutionTime</span>
        </div>
      </div>

      <div className="protocol-grid">
        <div className="page-card">
          <div className="card-header-row">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" /> RESOLUTION QUEUE
              </div>
              <h2>Sessions awaiting settlement</h2>
            </div>
            <LiveRefresh renderedAt={now} everyMs={15_000} />
          </div>

          {open.length === 0 ? (
            <p className="empty-state">
              No session is open. The queue fills the moment a keeper pass opens one.
            </p>
          ) : (
            <div className="queue-list">
              {open.map((session) => {
                const agent = byId.get(session.agentId);
                const past = now >= session.closesAt;
                return (
                  <div className="queue-item" key={session.id}>
                    <div className="queue-icon">
                      <Gauge size={17} strokeWidth={1.8} />
                    </div>
                    <div className="queue-copy">
                      <strong>
                        {agent ? (
                          <Link className="link" href={`/agents/${agent.slug}`}>
                            {agent.name}
                          </Link>
                        ) : (
                          // A session whose agent is missing is a broken foreign
                          // key. Hiding the row would hide the breakage with it.
                          "Unknown agent"
                        )}
                      </strong>
                      <span>
                        Session {session.sessionNumber} · {PILL[session.status].label}
                        {session.metaMarketId ? (
                          <>
                            {" · "}
                            <Link className="link" href={`/market/${session.metaMarketId}`}>
                              open the meta-market
                            </Link>
                          </>
                        ) : (
                          " · no meta-market minted, so there is nothing to bet on"
                        )}
                      </span>
                      <div className="queue-progress">
                        <span style={{ width: `${windowProgress(session, now)}%` }} />
                      </div>
                      <small>
                        {past
                          ? "Past close · redeemAll(), closeSession() and finalize() are owed, and anyone may call them"
                          : `Closes ${utcClock(session.closesAt)} · committee reads ${utcClock(
                              session.closesAt + SETTLE_WINDOW_SEC * 1000,
                            )}`}
                      </small>
                    </div>
                    <div className="queue-time">
                      <Clock3 size={13} strokeWidth={1.8} />
                      <Countdown to={session.closesAt / 1000} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="page-card mechanics-card">
          <div className="eyebrow">
            <span className="eyebrow-line" /> WHAT THE CHAIN ENFORCES
          </div>
          <h2>How a market resolves</h2>

          <div className="mechanic-step">
            <span>01</span>
            <div>
              <strong>Snapshot</strong>
              <p>
                openSession() writes navT0 on chain and deploys that session&apos;s BotNavOracle. The
                baseline exists before the market does, so nobody can take a position against a number
                that has already moved.
              </p>
            </div>
          </div>
          <div className="mechanic-step">
            <span>02</span>
            <div>
              <strong>Trade</strong>
              <p>
                The agent trades live DreamDEX Event Contracts through a BotVault that owns every
                position. nav() counts protocolCash only — collateral an allowlisted DreamDEX call
                delivered. A 10,000 tUSDC faucet top-up moves the balance and moves NAV by zero.
              </p>
            </div>
          </div>
          <div className="mechanic-step">
            <span>03</span>
            <div>
              <strong>Freeze</strong>
              <p>
                After close, redeemAll(), closeSession() and finalize() run in that order. All three are
                permissionless — anyone may call them, the keeper is just usually first. finalize()
                writes outcomeValue once and it can never be restated.
              </p>
            </div>
          </div>
          <div className="mechanic-step">
            <span>04</span>
            <div>
              <strong>Attest</strong>
              <p>
                At resolutionTime, {SETTLE_WINDOW_SEC}s after close, a DreamDEX validator subcommittee
                reads BotNavOracle.outcomeValue() and pays the matching outcome index. 1 = YES, NAV
                rose, and pays index 0, the Up leg; 2 = NO pays index 1. Zero sits outside every
                registered interval, so &ldquo;not answered&rdquo; voids instead of paying.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="page-card mt-4">
        <div className="card-header-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> WHAT ALREADY RESOLVED
            </div>
            <h2>Settled and voided sessions</h2>
          </div>
          <Link className="view-link" href="/agents">
            Agent board <ArrowUpRight size={14} strokeWidth={1.8} />
          </Link>
        </div>

        {recent.length === 0 ? (
          <p className="empty-state">
            Nothing has finished yet. A session lands here once its oracle is frozen.
          </p>
        ) : (
          <div className="agent-table-wrap">
            <table className="agent-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Session</th>
                  <th>NAV change</th>
                  <th>Oracle answer</th>
                  <th>DreamDEX paid</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((session) => {
                  const agent = byId.get(session.agentId);
                  const delta = navDelta(session.navT0, session.navT1);
                  return (
                    <tr key={session.id}>
                      <td>
                        <div className="agent-cell">
                          <div className={`agent-avatar ${agent ? identityTone(agent.id) : "cyan"}`}>
                            <Gauge size={16} strokeWidth={1.8} />
                          </div>
                          <div>
                            <strong>{agent?.name ?? "Unknown agent"}</strong>
                            <span className="address mono">
                              {session.navT0 === null ? "no baseline" : `navT0 ${usdc(session.navT0)}`}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="mono muted-cell">#{session.sessionNumber}</td>
                      <td>
                        <strong className={deltaTone(delta)}>{signedUsdc(delta)}</strong>
                      </td>
                      <td>
                        {session.outcomeValue === 1 ? (
                          <span className="outcome up">YES · NAV rose</span>
                        ) : session.outcomeValue === 2 ? (
                          <span className="outcome down">NO · did not rise</span>
                        ) : (
                          <span className="outcome void">no answer</span>
                        )}
                      </td>
                      <td>
                        {session.voided ? (
                          <span className="outcome void">refunded both sides</span>
                        ) : session.resolvedOutcome === 0 ? (
                          <span className="outcome up">index 0 · Up</span>
                        ) : session.resolvedOutcome === 1 ? (
                          <span className="outcome down">index 1 · Down</span>
                        ) : (
                          <span className="muted-cell">not read yet</span>
                        )}
                      </td>
                      <td>
                        <span className={`status-pill ${PILL[session.status].tone}`}>
                          <span className="status-dot" /> {PILL[session.status].label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="insight-card mt-4">
        <div className="card-topline">
          <div className="eyebrow">
            <span className="eyebrow-line" /> MEASURED, NOT ASSUMED
          </div>
          <ShieldCheck className="accent-icon" size={20} strokeWidth={1.8} />
        </div>
        <h2>Why a market voids, and what we did about it</h2>
        <p>
          A subcommittee that cannot agree refuses to answer and both sides are refunded. That is the
          honest failure mode of an attested settlement, and it is priced into how these markets are
          registered rather than hidden behind a success rate.
        </p>
        <div className="insight-points">
          <div>
            <span className="point-index">01</span>
            <strong>Contract sources are free, and unserviced</strong>
            <span>
              The OracleHub prices a contract source at 0.00 STT, so nothing funds a validator to read
              one. 7 of 10 live contract-sourced samples voided.
            </span>
          </div>
          <div>
            <span className="point-index">02</span>
            <strong>So every market pays for six JSON sources too</strong>
            <span>
              Each meta-market registers six JSON sources beside the free contract source — the paid
              tier that voided 122 times in 20,617 samples, 0.59%.
            </span>
          </div>
          <div>
            <span className="point-index">03</span>
            <strong>And the read sits after expiry, never on it</strong>
            <span>
              resolutionTime is close + {SETTLE_WINDOW_SEC}s. Every voided third-party sample we decoded
              had put the committee&apos;s read exactly on expiry, with no room for the three
              transactions that have to land first.
            </span>
          </div>
        </div>
      </div>

      <div className="subpage-callout">
        <div className="callout-icon">
          <ScrollText size={20} strokeWidth={1.8} />
        </div>
        <div>
          <strong>Every number on this page has a transaction behind it</strong>
          <p>
            The audit ledger carries the trail — operator and venue registration, the first settled
            meta-market, the vault&apos;s real order, and the top-up that moved NAV by zero.
          </p>
        </div>
        <Link className="primary-button" href="/audit">
          Open the audit ledger <ArrowUpRight size={15} strokeWidth={1.8} />
        </Link>
      </div>
    </>
  );
}
