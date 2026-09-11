import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { getAdapter, type AdapterHealth } from "@/lib/dreamdex";
import { listOpenSessions, listSessions, navSeries } from "@/lib/services/agentSessions";
import { isFinished, standings } from "@/lib/services/agentStandings";
import { liveVaultByAgent } from "@/lib/agents/vaultState";
import type { AgentSession, AgentSessionStatus } from "@/lib/domain/types";
import { isTakingPositions, sumRaw, usdc } from "@/components/agentFormat";
import { agentAccent } from "@/components/AgentStatusPill";
import { OverviewBoard, type BoardRow } from "@/components/OverviewBoard";

/**
 * The Overview — the first screen, and the one that has to survive a judge who
 * checks.
 *
 * Everything on it is measured. The counts come from the session journal, the
 * prices from each meta-market's own book, the curves from `agent_nav_points`,
 * and the status line from the adapter that actually answered. Where a number
 * does not exist yet it prints as a dash and says why; there is no seeded row
 * anywhere on this page, because this repo has already been burned once by
 * demo data that outranked real traders (docs/HACKATHON_READINESS.md).
 *
 * Three claims in the source design were false of this implementation and are
 * rewritten rather than carried over: outcomes are *not* "resolved by code, not
 * an oracle committee" (DreamDEX's committee reads our contract), the arbiter
 * is not an "AgentPerformanceOracle" (it is `BotNavOracle` plus a validator
 * subcommittee), and nothing settles "atomically" (resolution happens at the
 * market's resolutionTime). The honest version is the better story and it is
 * what the settlement panel below says.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Mirrors `listOpenSessions` — the states a keeper still owes work on. */
const LIVE: ReadonlySet<AgentSessionStatus> = new Set(["pending", "open", "closing"]);

/** Finished sessions shown when nothing is open. Enough to prove the machine
 *  has run, few enough that the panel stays a panel. */
const RECENT = 4;

/** The tail of the NAV series each drawing needs. The full curve lives on the
 *  agent page; a 118px cell cannot resolve more points than this anyway. */
const SPARK_POINTS = 24;

/** Fixed locale: a server render and a browser render that format this
 *  differently are a hydration mismatch, and a block height is not prose. */
function blockLabel(n: number): string {
  return n.toLocaleString("en-US");
}
/**
 * What the app can honestly say about its own data source right now.
 *
 * The design's hero said "Operational" over an invented block height. This says
 * only what `/api/health` measured — and note what it does not claim: nothing
 * here compares the indexer against the chain head, so the word is "reading",
 * never "synced".
 */
function sourceStatus(health: AdapterHealth | null): {
  word: string;
  foot: string;
  tone: "accent" | "warn" | "danger";
} {
  if (health === null) {
    return {
      word: "Unknown",
      foot: "The data-source check did not answer",
      tone: "warn",
    };
  }
  if (health.mode === "sim") {
    return {
      word: "Simulated",
      foot: "Not Somnia — these contracts were generated locally",
      tone: "danger",
    };
  }
  if (!health.ok) {
    return {
      word: "Degraded",
      foot: "Somnia Shannon · indexer health check failing",
      tone: "warn",
    };
  }
  return {
    word: "Reading Somnia",
    foot:
      health.indexerBlock === null
        ? "Somnia Shannon · indexer did not report a block"
        : `Somnia Shannon · indexer block ${blockLabel(health.indexerBlock)}`,
    tone: "accent",
  };
}

export default async function Overview() {
  const renderedAt = Date.now();

  // Ranked, and the ranking is a claim: `standings()` puts every agent with a
  // finished session ahead of every agent without one, before any metric is
  // compared. The board below relies on that ordering for its rank column.
  const board = standings();
  const open = listOpenSessions();

  // One pass over the journal, reused three times: the settled/void counts, the
  // fallback list when nothing is open, and nothing else. Per-agent because
  // that is the only listing the journal exposes, and the field is tens of rows.
  const allSessions = board.flatMap((s) => listSessions(s.agent.id));

  // NAV samples for every agent on the board. Each point is a read of
  // `BotVault.nav()` at a block, so these curves are measurements — the reason
  // the design's one hard-coded squiggle could not be kept.
  const navByAgent = new Map(board.map((s) => [s.agent.id, navSeries(s.agent.id)]));

  const adapter = getAdapter();

  // A chain read that fails must degrade to "we do not know", never to a
  // confident page. Both of these are caught for that reason.
  const health = await adapter.health().catch(() => null);

  // Only sessions whose meta-market has actually minted count as markets. A
  // `pending` session is a window with no contract behind it yet.
  //
  // No `.slice(FEATURED)` here any more. This used to feed a featured panel as
  // well as the readout below, and when the panel went the cap stayed — so the
  // number under "Meta-markets live" was the smaller of the truth and 5, and
  // read 5 beside "Sessions open 11" with eleven contracts on chain. A count
  // taken off a list trimmed for display is not a count.
  const minted = open.filter(
    (s): s is AgentSession & { metaMarketId: string } => s.metaMarketId !== null,
  );

  // All three at once. The vault reads are deadlined and failure-tolerant
  // inside `vaultState`, so the slowest thing on this page is still whichever
  // of them the venue and the node take — not their sum.
  //
  // The third leg is the fix for the contradiction this page used to print. The
  // leaderboard's NAV column and the vault sum beside "Meta-markets live" both
  // came out of `agent_nav_points`, whose rows are written twice per session,
  // while the market panel 400px above read the same `nav()` off chain — 206.12
  // against 10.00 for one agent on one paint. Now the board reads the vault
  // too. It costs one batch of reads for the whole field (tens of agents,
  // concurrent, one 2.5s deadline), and the per-vault cache means an agent that
  // also appears in `minted` above is read once, not twice.
  const agentVaults = await liveVaultByAgent(
    board.map((s) => ({ agentId: s.agent.id, vaultAddress: s.agent.vaultAddress })),
  );
  const boardRows: BoardRow[] = board.map((s, i) => {
    const reading = agentVaults.get(s.agent.id) ?? null;
    return {
      id: s.agent.id,
      slug: s.agent.slug,
      name: s.agent.name,
      strategy: s.agent.strategy,
      vaultAddress: s.agent.vaultAddress,
      // Position in a list that already sorts the unproven to the bottom, so an
      // index is a placing for the agents that earned one and nothing for the
      // rest. A number here on an agent with no finished session would be a rank
      // it has not run for.
      rank: s.sessionsRun > 0 ? i + 1 : null,
      netPnl: s.netPnl,
      winRate: s.winRate,
      sessionsRun: s.sessionsRun,
      // The live read and the stored sample stay separate rather than being
      // coalesced with a `??`. One field would let the cell print either under
      // one label, which is the bug itself: the board has to be able to say
      // WHICH of the two it is showing, and how old.
      liveNav: reading?.cash ?? null,
      liveNavBlock: reading?.blockNumber ?? null,
      liveSessionOpen: reading?.sessionOpen ?? false,
      sampledNav: s.lastNav,
      sampledAt: s.lastNavAt,
      status: s.liveSession?.status ?? null,
      nav: (navByAgent.get(s.agent.id) ?? []).slice(-SPARK_POINTS).map((p) => ({ at: p.at, nav: p.nav })),
      tone: agentAccent(s.agent.slug),
    };
  });

  const recent = allSessions
    .filter((s) => !LIVE.has(s.status))
    .sort((a, b) => b.closesAt - a.closesAt)
    .slice(0, RECENT);

  const proven = board.filter((s) => s.sessionsRun > 0).length;

  // One rule for "finished", imported rather than restated, because the
  // leaderboard column directly below this strip is the same count summed per
  // agent. The tile counted `status === "settled"` on its own until a reader
  // checked: it printed 5 above a column that added up to 8, and both numbers
  // were right about different questions.
  const finished = allSessions.filter(isFinished);

  // The split inside that total. "The oracle froze an answer" and "DreamDEX
  // paid the meta-market out on it" are different facts and the second lags the
  // first by a committee vote, so a session sitting between them is shown
  // rather than rounded into whichever number happens to include it.
  const paid = finished.filter((s) => s.status === "settled").length;
  const awaitingCommittee = finished.length - paid;
  const voided = allSessions.filter((s) => s.voided || s.status === "void").length;

  const finishedFoot = [
    `${paid} paid out by the committee`,
    awaitingCommittee > 0 ? `${awaitingCommittee} awaiting its vote` : null,
    voided === 0 ? "none voided" : `${voided} voided`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  // Read off the clock, not off the status column: `open` only means no keeper
  // has closed the session yet, and the market cards below switch to "awaiting
  // settlement" the moment `closesAt` passes. The two are on one screen and
  // must not contradict each other.
  const taking = open.filter((s) => isTakingPositions(s, renderedAt)).length;
  const pastExpiry = open.length - taking;

  const openFoot =
    open.length === 0
      ? "none open right now"
      : pastExpiry === 0
        ? "taking positions now"
        : taking === 0
          ? `past the close · ${pastExpiry === 1 ? "awaiting settlement" : "all awaiting settlement"}`
          : `${taking} taking positions · ${pastExpiry} awaiting settlement`;

  // Summed from the live reads, and only from the ones that answered.
  //
  // This was `sumRaw(board.map((s) => s.currentNav))` — the same stale samples
  // the NAV column was printing, added together, which made one wrong figure
  // into a total that looked like a protocol-wide measurement. A sum over reads
  // taken at different, unstated moments is not a quantity anyone can check.
  //
  // A partial answer stays partial: the count says how many vaults are in the
  // total, so a reader can tell "30 tUSDC across three vaults" from "30 tUSDC
  // across the one vault that replied". Nothing answering at all is a dash.
  const liveCash = board.map((s) => agentVaults.get(s.agent.id)?.cash ?? null);
  const vaultsRead = liveCash.filter((c) => c !== null).length;
  const capital = vaultsRead > 0 ? sumRaw(liveCash) : null;
  const capitalFoot =
    capital === null
      ? "no vault answered this read"
      : `${usdc(capital, 0)} tUSDC in ${vaultsRead} of ${board.length} vaults, read now`;

  const source = sourceStatus(health);

  // `.signal-ring` is lime by definition — brand and verified. When the source
  // is anything but nominal the ring has to say so, and the tokens are the only
  // place these colours are allowed to come from.
  const ring =
    source.tone === "accent"
      ? undefined
      : {
          background: `var(--color-${source.tone})`,
          boxShadow: `0 0 0 5px color-mix(in srgb, var(--color-${source.tone}) 14%, transparent)`,
        };

  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> AGENT PERFORMANCE, MEASURED ON CHAIN
          </div>
          <h1>
            Back the agents
            <br />
            <em>that leave a trail.</em>
          </h1>
          <p>
            AI agents trade real DreamDEX Event Contracts out of a vault they hold no withdrawal key
            to. A second layer of agents prices the question above it: does that agent&apos;s session
            NAV rise? Every order on both layers is signed by a key a program holds. Nothing on this
            site asks you for one.
          </p>
          <div className="hero-actions">
            <Link className="primary-button" href="/agents">
              See live meta-markets <ArrowUpRight size={16} strokeWidth={1.8} aria-hidden />
            </Link>
            <Link className="text-button" href="/audit">
              Every transaction, with its hash <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
        </div>

        <div className="hero-meta">
          <div className="hero-meta-label">DATA SOURCE</div>
          <div className="hero-meta-value">
            <span className="signal-ring" style={ring} aria-hidden />
            {source.word}
          </div>
          <div className="hero-meta-foot">{source.foot}</div>
        </div>
      </section>

      {/* ── Counts ────────────────────────────────────────────────────────── */}
      {/* The design carried four fabricated 24h deltas ("+8.4% / 24h"). Nothing
          here tracks a 24h window, so every line below is a count of rows that
          exist, in the neutral tone, rather than a direction nobody measured. */}
      <section className="metric-strip" aria-label="Protocol counts">
        <div className="metric-item">
          <span className="metric-label">Agents registered</span>
          <strong>{board.length}</strong>
          <span className="metric-delta neutral">
            {proven} with a finished session
          </span>
        </div>
        <div className="metric-item">
          <span className="metric-label">Sessions open</span>
          <strong>{open.length}</strong>
          <span className="metric-delta neutral">
            {/* The pulse means something is live. It goes out when every open
                session is past its close, because the dot is the one part of
                this tile a reader takes in without reading it. */}
            {taking > 0 && <span className="tiny-signal" aria-hidden />}
            {openFoot}
          </span>
        </div>
        <div className="metric-item">
          <span className="metric-label">Meta-markets live</span>
          <strong>{minted.length}</strong>
          <span className="metric-delta neutral">{capitalFoot}</span>
        </div>
        <div className="metric-item">
          <span className="metric-label">Sessions finished</span>
          <strong>{finished.length}</strong>
          <span className="metric-delta neutral">{finishedFoot}</span>
        </div>
      </section>

      {/* ── Agent leaderboard ─────────────────────────────────────────────── */}
      <section className="section-block leaderboard-section">
        <div className="section-heading leaderboard-heading">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" aria-hidden /> SIGNAL INDEX
            </div>
            <h2>Agent leaderboard</h2>
            <p className="section-description">
              Ranked on sessions the oracle has answered. Voided sessions count as neither a win nor
              a loss.
            </p>
          </div>
          <Link className="view-link" href="/agents">
            Full board <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
          </Link>
        </div>

        {boardRows.length > 0 ? (
          <OverviewBoard rows={boardRows} renderedAt={renderedAt} />
        ) : (
          // The honest first-run state. A board with nothing on it is the truth
          // about a testnet product on its first day; a seeded one is not.
          <div className="market-feature" style={{ gridTemplateColumns: "34% 66%" }}>
            <div className="market-image">
              <div className="image-tag">
                <span className="tiny-signal" aria-hidden /> AWAITING THE FIRST AGENT
              </div>
            </div>
            <div className="market-feature-body">
              <div className="market-overline">
                <span>No agents yet</span>
                <span className="mono">0 REGISTERED</span>
              </div>
              <h3>The board is empty because nothing has traded.</h3>
              <p className="max-w-[52ch] text-xs leading-relaxed text-fg-muted">
                An agent needs a deployed BotVault, a funded balance and an operator key that may
                only call <span className="mono">trade()</span>. Register one and its first session
                mints a contract a speculator agent can take the other side of.
              </p>
              <div className="market-footer">
                <span>
                  <span className="muted-label">Requires</span> one signature to prove the vault is yours
                </span>
                <Link className="secondary-button" href="/docs">
                  Set up the first agent <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Why this matters ──────────────────────────────────────────────── */}
      <section className="lower-grid" aria-label="Why this matters">
        <div className="insight-card">
          <div className="card-topline">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" aria-hidden /> WHY THIS MATTERS
              </div>
              <h2>Performance as an asset class.</h2>
            </div>
            <Sparkles size={19} strokeWidth={1.8} className="accent-icon" aria-hidden />
          </div>
          <p>
            An agent&apos;s claim about itself is marketing. What is tradeable is a record a stranger
            can re-derive: a strategy hashed before the session opened, a vault whose keys the runner
            does not hold, and one NAV number pinned by two published block numbers. The agents that
            trade it are in <span className="mono">bots/</span> and can be read before they are run.
          </p>
          <div className="insight-points">
            <div>
              <span className="point-index">01</span>
              <strong>Declared, then hashed</strong>
              <span>
                Strategy and parameters are fixed at registration and their keccak goes into the
                meta-market&apos;s on-chain context at mint.
              </span>
            </div>
            <div>
              <span className="point-index">02</span>
              <strong>A native Event Contract</strong>
              <span>
                YES/NO on DreamDEX&apos;s own venue — the same book, ticket and contract page as
                every other market on it.
              </span>
            </div>
            <div>
              <span className="point-index">03</span>
              <strong>A top-up cannot move it</strong>
              <span>
                10,000 tUSDC pushed into a vault moved its balance and moved nav() by zero. The gap
                shows as unaccounted, to anyone.
              </span>
            </div>
          </div>
          <Link href="/settlement" className="text-button">
            How settlement works <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
          </Link>
        </div>

        {/* The design put "Code is the arbiter." over an "AgentPerformanceOracle"
            that does not exist, and claimed atomic settlement with a 4.2s median.
            None of that is true here. What is true is stronger, because it is
            checkable: our contract publishes a number that can never be
            restated, and DreamDEX's committee reads it. */}
        <div className="settlement-card">
          <div className="settlement-overlay">
            <div className="eyebrow">
              <span className="eyebrow-line" aria-hidden /> SETTLEMENT ENGINE
            </div>
            <h3>One number, two block numbers.</h3>
            <div className="settlement-status">
              <span className="signal-ring small" aria-hidden />
              <div>
                <strong>BotNavOracle · one per session</strong>
                <span>
                  Settlement is defined by code and attested by DreamDEX&apos;s oracle committee.
                </span>
              </div>
            </div>
            <div className="settlement-status">
              <span className="tiny-signal" aria-hidden />
              <div>
                <strong>closeSession() · redeemAll() · finalize()</strong>
                <span>Permissionless — anyone can push a session to its frozen answer.</span>
              </div>
            </div>
            <Link className="secondary-button" href="/settlement">
              Inspect the settlement engine <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
