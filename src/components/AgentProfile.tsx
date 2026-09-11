"use client";

/**
 * One agent, in full.
 *
 * The page is built around a single claim, so that claim gets the top of it:
 * `nav()` is the vault's `protocolCash` and moves only when an allowlisted
 * DreamDEX call settles collateral, while `unaccounted()` is every token the
 * vault holds that no such call delivered. The Shannon collateral has a
 * permissionless faucet, so anyone can send this vault 10,000 tUSDC — and the
 * pair of readouts below is what makes that gesture worth nothing.
 *
 * Everything else on the page is evidence for the same thing: the curve is
 * sampled NAV with the block it was read at, the sessions carry their oracle's
 * frozen answer, and the tape carries the transaction of every order the
 * operator key signed.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Bot, FileCode2 } from "lucide-react";
import type { AgentSession, AgentStanding } from "@/lib/domain/types";
import { addressUrl } from "@/lib/wallet/chain";
import { ExternalLink } from "./Primitives";
import { AgentHeartbeatPill, AgentStatusPill, agentAccent } from "./AgentStatusPill";
import { AgentNavChart } from "./AgentNavChart";
import { Segmented } from "./Segmented";
import { AgentSessionCard } from "./AgentSessionCard";
import { AgentTradeTape } from "./AgentTradeTape";
import { loadAgent, type AgentDetail } from "./agentApi";
import {
  ageLabel,
  blockLabel,
  clockTime,
  moneyTone,
  navDelta,
  shortHex,
  signedUsdc,
  sumRaw,
  usdc,
} from "./agentFormat";

/** Same cadence as the board: nothing here moves faster than a settlement. */
const POLL_MS = 10_000;

/** The most recent 25. The full tape belongs on the explorer, not on a page. */
const TAPE_LIMIT = 25;

/** How many closed sessions to draw as cards before the page becomes a scroll. */
const HISTORY_LIMIT = 6;

function isLive(s: AgentSession): boolean {
  return s.status === "pending" || s.status === "open" || s.status === "closing";
}

/**
 * The agent's record, when the detail route did not compute one.
 *
 * `agentStandings` is authoritative — it is what the board ranks on — and this
 * is only the fallback that keeps a profile from rendering a blank record for
 * an agent that plainly has one. It applies the same two rules: a finished
 * session is `finalized` or `settled` and never voided, and a win is the
 * oracle's own answer of 1 — `BotNavOracle.OUTCOME_YES` — never a recomputation
 * from the NAV pair. It said 2 until the encoding was checked against the
 * deployed contract, which counted every loss as a win.
 */
function deriveStanding(detail: AgentDetail): AgentStanding {
  const finished = detail.sessions.filter((s) => !s.voided && (s.status === "finalized" || s.status === "settled"));
  const won = finished.filter((s) => s.outcomeValue === 1).length;
  return {
    agent: detail.agent,
    sessionsRun: finished.length,
    sessionsWon: won,
    winRate: finished.length > 0 ? won / finished.length : null,
    netPnl: sumRaw(finished.map((s) => navDelta(s.navT0, s.navT1))),
    // The last SAMPLE, with the two facts that make it readable, and no live
    // read folded in: `detail.chain` is a reading of the vault as it stands and
    // belongs to a different field. Mixing them here is how a figure with no
    // age ends up under a heading that implies one.
    lastNav: detail.nav[detail.nav.length - 1]?.nav ?? null,
    lastNavAt: detail.nav[detail.nav.length - 1]?.at ?? null,
    lastNavBlock: detail.nav[detail.nav.length - 1]?.blockNumber ?? null,
    liveSession: detail.sessions.find(isLive) ?? null,
  };
}

export function AgentProfile({ slug }: { slug: string }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [sessionTab, setSessionTab] = useState<"live" | "closed" | "trades" | null>(null);
  /** Which session's tape to load. Null lets the route choose the live one. */
  const [tapeFor, setTapeFor] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await loadAgent(slug, tapeFor, signal);
        if (signal.aborted) return;
        setDetail(next);
        setFailed(null);
      } catch (e) {
        if (signal.aborted) return;
        setFailed((e as Error).message);
      }
    },
    [slug, tapeFor],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const t = setInterval(() => void load(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [load, attempt]);

  if (detail === null && failed === null) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading agent">
        <div className="skeleton h-10 w-72" />
        <div className="skeleton h-4 w-96" />
        <div className="skeleton h-[150px]" />
        <div className="skeleton h-[300px]" />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="page-card" role="alert">
        <div className="eyebrow">
          <span className="eyebrow-line" aria-hidden /> AGENT UNAVAILABLE
        </div>
        <h1 className="mt-3 font-display text-[26px] tracking-[-0.05em]">
          This agent could not be loaded
        </h1>
        <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-fg-muted">{failed}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="secondary-button">
            Try again
          </button>
          <Link href="/agents" className="text-button">
            <ArrowLeft size={14} strokeWidth={1.8} aria-hidden /> Back to the leaderboard
          </Link>
        </div>
      </div>
    );
  }

  const { agent, sessions, trades, nav, chain, rank } = detail;
  const standing = detail.standing ?? deriveStanding(detail);
  const live = sessions.find(isLive) ?? null;
  const closed = sessions.filter((s) => !isLive(s));
  /**
   * Which session view is showing.
   *
   * The reader's choice wins once they make one; until then it follows the
   * data, so an idle agent opens on its history rather than on a panel that
   * only says it is idle. Derived rather than stored, because this component
   * re-fetches on a timer and storing it would let a poll move the view out
   * from under someone reading it.
   */
  const tab: "live" | "closed" | "trades" = sessionTab ?? (live ? "live" : "closed");

  // The detail route reads the vault only for the session it names, so the
  // pairing is checked rather than assumed: a reading attached to a session
  // this render is not showing would be the right number under the wrong
  // heading, which is the whole family of bug this page is careful about.
  const liveVault = live !== null && detail.liveSessionId === live.id ? detail.vault : null;

  const latestPoint = nav.length > 0 ? nav[nav.length - 1] : null;

  // A live read of the vault, or nothing. The stored sample is deliberately NOT
  // in this chain.
  //
  // It used to be: `liveVault?.cash ?? chain?.nav ?? latestPoint?.nav ??
  // standing.currentNav`. Four sources, one 40px readout, one label — so when
  // the vault did not answer, a row that could be hours old took the headline
  // under "Cash · nav()" and only a 9px sub-line admitted it was a sample. The
  // fallback still happens, because throwing away the only figure this app has
  // would help nobody; what changed is that it now changes the LABEL with it.
  const liveCash = liveVault?.cash ?? chain?.nav ?? null;
  const measuredNow = liveCash !== null;
  const headlineNav = liveCash ?? latestPoint?.nav ?? standing.lastNav;
  const unaccounted = liveVault?.unaccounted ?? chain?.unaccounted ?? latestPoint?.unaccounted ?? null;
  const navBlock = blockLabel(latestPoint?.blockNumber);
  const liveBlock = blockLabel(liveVault?.blockNumber);
  // Read once per render so the headline's age and the custody panel's agree. Safe
  // against hydration: this component renders a skeleton until its fetch
  // resolves, so no server-rendered markup carries a clock.
  const now = Date.now();
  const pnlTone = moneyTone(standing.netPnl);
  const accent = agentAccent(agent.slug);

  const params = Object.entries(agent.strategyParams);
  const tape = [...trades].sort((a, b) => b.at - a.at).slice(0, TAPE_LIMIT);
  // The detail route serves one session's trades, not the agent's whole
  // history. Naming that session is the difference between a partial tape and
  // a tape that looks complete and is not.
  const tapeSession = sessions.find((s) => s.id === detail.tradesSessionId) ?? null;
  const minted = sessions.filter((s) => s.metaMarketId !== null).length;

  return (
    <>
      <Link href="/agents" className="text-button mt-6">
        <ArrowLeft size={14} strokeWidth={1.8} aria-hidden /> Leaderboard
      </Link>

      <header className="subpage-heading">
        <div className="min-w-0">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> AGENT DOSSIER
            <span className="mono ml-3 text-fg-subtle">
              {standing.sessionsRun > 0 && rank !== null ? `RANK ${rank}` : "NO FINISHED SESSION"}
            </span>
          </div>
          <h1 className="flex items-center gap-4">
            <span className={`agent-avatar ${accent} h-11 w-11 shrink-0 rounded-[10px]`} aria-hidden>
              <Bot size={22} strokeWidth={1.8} />
            </span>
            {agent.name}
          </h1>
          {agent.blurb && <p>{agent.blurb}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-3">
          <AgentHeartbeatPill lastHeartbeat={agent.lastHeartbeat} />
          {live?.metaMarketId && (
            <Link href={`/market/${live.metaMarketId}`} className="primary-button">
              This session&rsquo;s contract <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
            </Link>
          )}
        </div>
      </header>

      <div className="-mt-4 mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-fg-subtle">
        <span className="strategy-chip">{agent.strategy}</span>
        <ExternalLink href={addressUrl(agent.vaultAddress)} className="hover:text-fg-muted">
          vault {shortHex(agent.vaultAddress)}
        </ExternalLink>
        {agent.repoUrl && (
          <ExternalLink href={agent.repoUrl} className="text-accent-fg hover:text-accent">
            strategy source
          </ExternalLink>
        )}
      </div>

      {/* The product's central claim, as two readouts. Side by side because the
          comparison is the argument: one of these numbers is the settlement
          figure and the other is anybody's faucet call. */}
      <section className="page-card" aria-label="NAV against unaccounted collateral">
        <div className="eyebrow">
          <span className="eyebrow-line" aria-hidden /> THE NUMBER THAT SETTLES
        </div>

        <div className="mt-5 grid gap-8 border-t border-line pt-6 sm:grid-cols-2 sm:gap-0">
          <div className="sm:border-r sm:border-line sm:pr-9">
            {/* The label moves with the figure. Three different things have been
                shown in this slot — cash read now, NAV read now, and a stored
                sample — and only the first two were ever measured "now". */}
            <span className="metric-label">
              {measuredNow
                ? live
                  ? "Cash · nav()"
                  : "NAV · nav()"
                : headlineNav === null
                  ? // Nothing read and nothing stored. "Last sampled" would
                    // name a sample that does not exist.
                    "nav() · not read"
                  : "Last sampled nav()"}
            </span>
            <p
              className={`num mt-3 font-display text-[40px] leading-none tracking-[-0.05em] ${
                measuredNow ? "" : "text-fg-muted"
              }`}
            >
              {usdc(headlineNav)}
              <span className="ml-2 font-mono text-xs tracking-normal text-fg-subtle">tUSDC</span>
            </p>
            <p className="mt-3 max-w-[44ch] text-xs leading-relaxed text-fg-muted">
              {!measuredNow
                ? "The vault did not answer this request, so this is the most recent stored sample rather than a reading of the vault as it stands. Samples are written when an agent registers and when a session closes — not while one runs."
                : live
                  ? "Cash alone while a session runs: outcome tokens are counted only when redeemAll() converts them at close."
                  : "Collateral an allowlisted DreamDEX call delivered. Every meta-market on this agent settles against it."}
            </p>
            {/* At 11px, not 9px. This line is what tells a reader whether the
                number above it was measured a moment ago or an hour ago, which
                makes it part of the figure rather than a footnote to it. */}
            <p className="mt-2 font-mono text-xs text-fg-subtle">
              {liveVault
                ? `read from the vault on this request · touched() holds ${liveVault.touchedCount} ${
                    liveVault.touchedCount === 1 ? "market" : "markets"
                  }${liveBlock ? ` · block ${liveBlock}` : ""}`
                : measuredNow
                  ? "read from the vault on this request"
                  : latestPoint
                    ? `sampled ${clockTime(latestPoint.at)} · ${ageLabel(latestPoint.at, now)}${
                        navBlock ? ` · block ${navBlock}` : ""
                      }`
                    : "not sampled yet"}
            </p>
            {/* The one case where a stale figure is actively misleading rather
                than merely old: the agent is trading right now, so whatever the
                sample says predates every order it has placed since. */}
            {!measuredNow && live !== null && latestPoint !== null && (
              <p className="mt-2 max-w-[44ch] text-xs leading-relaxed text-warn">
                A session is open, so this sample is older than the trading it is being read against.
              </p>
            )}
          </div>

          <div className="sm:pl-9">
            <span className="metric-label">Unaccounted · unaccounted()</span>
            <p className="num mt-3 font-display text-[40px] leading-none tracking-[-0.05em] text-fg-subtle">
              {usdc(unaccounted)}
              <span className="ml-2 font-mono text-xs tracking-normal">tUSDC</span>
            </p>
            <p className="mt-3 max-w-[44ch] text-xs leading-relaxed text-fg-muted">
              Tokens sitting in the vault that no DreamDEX call delivered. Visible to anyone,
              counted by nothing — it can never reach NAV.
            </p>
          </div>
        </div>
      </section>

      <div className="stat-grid four mt-4">
        <div className="stat-card">
          <span className="metric-label">Win rate</span>
          <strong className="num">
            {standing.winRate === null ? "—" : `${Math.round(standing.winRate * 100)}%`}
          </strong>
          <span className="metric-delta neutral">
            {standing.sessionsRun === 0
              ? "no finished session yet"
              : `${standing.sessionsWon} of ${standing.sessionsRun} sessions`}
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Net P&amp;L</span>
          <strong className="num">
            {standing.sessionsRun === 0 ? "—" : signedUsdc(standing.netPnl)}
          </strong>
          <span
            className={`metric-delta ${
              standing.sessionsRun === 0
                ? "neutral"
                : pnlTone === "good"
                  ? "positive"
                  : pnlTone === "danger"
                    ? "negative"
                    : "neutral"
            }`}
          >
            NAV change across finished sessions
          </span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Sessions recorded</span>
          <strong className="num">{sessions.length}</strong>
          <span className="metric-delta neutral">{minted} minted a meta-market</span>
        </div>
        <div className="stat-card">
          <span className="metric-label">Session state</span>
          <strong className="font-display text-[19px]">
            {live ? "Live" : sessions.length === 0 ? "None yet" : "Idle"}
          </strong>
          <span className="metric-delta neutral">
            {live ? <AgentStatusPill status={live.status} /> : "no session open on chain"}
          </span>
        </div>
      </div>

      {/* Declaration and custody are what the agent IS; every band below is
          what it DID. They used to sit in a 0.75fr aside beside a session
          history four sections long, so the right four-tenths of the page ran
          empty from the NAV curve down. Paired here they fill one row between
          the figures and the evidence, and everything after gets the full
          measure it was being denied. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="page-card">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> DECLARED STRATEGY
          </div>
          <h2 className="mt-3 font-display text-[19px] tracking-[-0.04em]">
            Hashed before anyone bet
          </h2>
          <p className="mt-3 text-xs leading-relaxed text-fg-muted">
            Hashed at registration and written into the meta-market&apos;s on-chain context, so it
            cannot be edited after anyone takes a position.
          </p>

          <dl className="mt-4">
            <div className="setting-field">
              <dt>Style</dt>
              <dd>
                <strong>{agent.strategy}</strong>
              </dd>
            </div>
            {params.map(([k, v]) => (
              <div key={k} className="setting-field">
                <dt className="truncate">{k}</dt>
                <dd>
                  <strong className="num">{String(v)}</strong>
                </dd>
              </div>
            ))}
            {params.length === 0 && (
              <p className="mt-3 text-xs text-fg-subtle">No parameters declared.</p>
            )}
          </dl>

          <div className="mt-5 border-t border-line pt-4">
            <span className="metric-label">Config hash</span>
            <p className="mt-2 break-all font-mono text-xs leading-relaxed text-fg-subtle">
              {agent.configHash}
            </p>
          </div>

          {agent.repoUrl && (
            <ExternalLink href={agent.repoUrl} className="secondary-button mt-5">
              <FileCode2 size={15} strokeWidth={1.8} aria-hidden /> Read the strategy source
            </ExternalLink>
          )}
        </section>
        <section className="page-card">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> CUSTODY
          </div>
          <h2 className="mt-3 font-display text-[19px] tracking-[-0.04em]">The vault holds it</h2>
          <p className="mt-3 text-xs leading-relaxed text-fg-muted">
            The operator key may only call <span className="mono">trade()</span> — never deposit or
            withdraw. The owner moves funds only between sessions.
          </p>

          <dl className="mt-4">
            {/* The three keys, in the order power decreases: the owner may move
                capital, the operator may only trade, and the vault is what
                neither of them can withdraw from mid-session. Read together
                they are the separation the paragraph above claims. */}
            <div className="setting-field">
              <dt>Owner</dt>
              <dd>
                <ExternalLink href={addressUrl(agent.ownerAddress)} className="mono hover:text-fg">
                  {shortHex(agent.ownerAddress)}
                </ExternalLink>
              </dd>
            </div>
            <div className="setting-field">
              <dt>Operator</dt>
              <dd>
                <ExternalLink href={addressUrl(agent.operatorAddress)} className="mono hover:text-fg">
                  {shortHex(agent.operatorAddress)}
                </ExternalLink>
              </dd>
            </div>
            <div className="setting-field">
              <dt>Registered</dt>
              <dd>
                <strong className="num">{clockTime(agent.createdAt)}</strong>
              </dd>
            </div>
            {latestPoint && (
              <div className="setting-field">
                {/* "sampled", not "read": the vault is read on every request
                    this page makes, but a ROW is only written at registration
                    and at session close, and this is the row's timestamp. */}
                <dt>NAV last sampled</dt>
                <dd>
                  <strong className="num">{clockTime(latestPoint.at)}</strong>
                  <span className="ml-2 font-mono text-xs text-fg-subtle">
                    {ageLabel(latestPoint.at, now)}
                  </span>
                </dd>
              </div>
            )}
            {chain !== null && (
              <div className="setting-field">
                <dt>Contracts touched</dt>
                <dd>
                  <strong className="num">{chain.touched.length}</strong>
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      <div className="mt-9 space-y-9">
        <AgentNavChart points={nav} baseline={live?.navT0 ?? closed[0]?.navT0 ?? null} />

        {/* One section, three views of the same subject.
            These were three stacked headings — "Live session", "N closed
            sessions" and "Trades · session N". The first two rendered the
            identical AgentSessionCard, and the third is the tape belonging to
            whichever session is in focus. Read down the page that is three
            subjects; it is one, with a cursor on it. Tabs put them in one place
            and keep the counts in the labels, so what is behind a tab is
            legible without opening it. */}
        <section>
          <div className="section-heading">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" aria-hidden /> SESSIONS
              </div>
              <h2>
                {tab === "live"
                  ? live
                    ? "Live session"
                    : "No session open"
                  : tab === "closed"
                    ? `${closed.length} closed session${closed.length === 1 ? "" : "s"}`
                    : tapeSession === null
                      ? "Trades"
                      : `Trades · session ${tapeSession.sessionNumber}`}
              </h2>
              <p className="section-description">
                {tab === "trades" ? (
                  <>
                    Real orders on DreamDEX BTC and ETH Event Contracts, signed by the operator key
                    and paid out of the vault.
                    {tapeSession !== null && " This is one session's tape, not the agent's whole history."}
                    {trades.length > TAPE_LIMIT && ` Showing the ${TAPE_LIMIT} most recent.`}
                    {/* Only while looking at a past session. The way back has to
                        be here rather than in the tab strip: the tab says which
                        VIEW is open, and this says which SESSION it is of. */}
                    {tapeFor !== null && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            setTapeFor(null);
                            setSessionTab("trades");
                          }}
                        >
                          Back to the current session
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  "Settled by this vault's own oracle, frozen when the window closes."
                )}
              </p>
            </div>
            <Segmented
              mode="tabs"
              label="Which view of this agent's sessions to show"
              value={tab}
              onChange={setSessionTab}
              options={[
                { value: "live", label: live ? "Live · 1" : "Live" },
                { value: "closed", label: `Closed · ${closed.length}` },
                { value: "trades", label: `Trades · ${trades.length}` },
              ]}
            />
          </div>

          {tab === "trades" ? (
            <AgentTradeTape trades={tape} outcomes={detail.outcomes} />
          ) : tab === "live" ? (
            live ? (
              <AgentSessionCard session={live} vault={liveVault} />
            ) : (
              <div className="page-card">
                <h3 className="font-display text-[19px] tracking-[-0.04em]">No session open</h3>
                <p className="mt-3 max-w-[58ch] text-[12px] leading-relaxed text-fg-muted">
                  This agent is idle. A session opens on chain first, the oracle snapshots NAV, and
                  only then is a meta-market minted — so nobody bets against a baseline that has
                  already moved.
                </p>
                {/* Named, because the sentence above used to leave it out and the
                    answer is different for the two kinds of agent here. Waiting
                    for someone else to act is the failure this page was causing:
                    an agent registered from outside sat idle for ever while its
                    owner assumed the arena would open it. */}
                <p className="mt-2 max-w-[58ch] text-[12px] leading-relaxed text-fg-subtle">
                  <code>openSession</code> is <span className="mono">onlyOwner</span>. For the demo
                  fleet the keeper holds those keys and rolls a new session within 30s of the last
                  one settling. For a vault you own, it is yours to call — then register it with{" "}
                  <span className="mono">POST /api/agents/{detail.agent.slug}/session</span>.
                </p>
              </div>
            )
          ) : closed.length === 0 ? (
            <div className="page-card">
              <h3 className="font-display text-[19px] tracking-[-0.04em]">Nothing finished yet</h3>
              <p className="mt-3 max-w-[58ch] text-[12px] leading-relaxed text-fg-muted">
                A session lands here once its oracle is frozen. Until then this agent has no
                record, and the board ranks it below every agent that has one.
              </p>
            </div>
          ) : (
            <>
              <ul className="space-y-3">
                {closed.slice(0, HISTORY_LIMIT).map((s) => (
                  <li key={s.id}>
                    <AgentSessionCard
                      session={s}
                      onViewTrades={() => {
                        setTapeFor(s.id);
                        setSessionTab("trades");
                      }}
                    />
                  </li>
                ))}
              </ul>
              {closed.length > HISTORY_LIMIT && (
                <p className="mt-3 font-mono text-xs text-fg-subtle">
                  Showing the {HISTORY_LIMIT} most recent of {closed.length} closed sessions.
                </p>
              )}
            </>
          )}
        </section>
      </div>

        {failed && (
          <p className="callout callout-warn text-fg-muted" role="status">
            The last refresh failed, so this page is showing the previous answer. {failed}
          </p>
        )}
    </>
  );
}
