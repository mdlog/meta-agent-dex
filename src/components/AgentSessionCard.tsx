import Link from "next/link";
import { ArrowUpRight, Clock3 } from "lucide-react";
import type { AgentSession, SessionVaultState } from "@/lib/domain/types";
import { txUrl, addressUrl } from "@/lib/wallet/chain";
import { Countdown } from "./Countdown";
import { ExternalLink, OutcomeTag } from "./Primitives";
import { AgentSessionSteps, AgentStatusPill } from "./AgentStatusPill";
import { clockTime, moneyTone, navDelta, shortHex, signedUsdc, usdc } from "./agentFormat";

/**
 * One session, as a card.
 *
 * A session is the window a second-layer Event Contract is written against, so
 * this card has to answer three questions at a glance: where in the lifecycle
 * it is, what the vault's NAV did across it, and where a reader can go to check
 * or trade it. Everything on it is either a stored measurement or a link to the
 * chain — there is no derived number here at all.
 *
 * The heading is the question the meta-market actually asks, written from the
 * session's own opening NAV. That number is the settlement threshold, so
 * printing it in the title is the shortest way to say what a buyer is buying.
 *
 * WHY AN OPEN SESSION AND A CLOSED ONE DO NOT SHOW THE SAME COLUMNS. `nav()` is
 * `protocolCash`, and mid-session that is cash ALONE: an agent that has spent
 * 90 tUSDC on outcome tokens reads 90 lower while holding every one of those
 * positions, and nothing converts back until `redeemAll()` runs at close. So an
 * open session gets a CASH readout with the vault's redeem list beside it, and
 * no change column at all — a red "−90.00" against a session doing exactly what
 * it was funded to do is a loss the reader would believe and the vault has not
 * taken. Once `navT1` exists the figure IS the settled NAV, the delta is real,
 * and both are labelled as such.
 */
export function AgentSessionCard({
  session,
  vault = null,
  onViewTrades,
  className = "",
}: {
  session: AgentSession;
  /**
   * Show this session's tape. Omitted on the live card, whose tape is already
   * the one the page loads by default — an action that changes nothing reads as
   * a broken one.
   */
  onViewTrades?: () => void;
  /**
   * Live vault state, for a session that is still open. Null when the read
   * failed or there is nothing to read — the cell prints a dash rather than
   * falling back to a stale sample under a "now" label.
   */
  vault?: SessionVaultState | null;
  className?: string;
}) {
  const live = session.status === "pending" || session.status === "open" || session.status === "closing";
  // Settled first: a row that has `navT1` is finished, whatever its status
  // column happens to say while a keeper works through the closing steps.
  const settled = session.navT1 !== null;
  // A session that is neither live nor settled — voided, or closed before the
  // keeper wrote a closing figure — keeps the close/change pair, both dashed.
  // There is no live vault to read for it, and no cash figure to offer.
  const running = live && !settled;
  const delta = navDelta(session.navT0, session.navT1);
  // THREE ANSWERS, NOT TWO. This was `BigInt(delta) > 0n` folded into a
  // boolean, so every non-positive change took the `negative` class and a
  // session that closed exactly level rendered "Change 0.00" in red — a loss
  // asserted about a vault that lost nothing. A zero change is neither
  // direction and takes the muted tone.
  //
  // What the muted tone does NOT say: `BotNavOracle.finalize()` settles on a
  // strict `navT1 > navT0`, so a level session still pays the Down leg. That is
  // a fact about settlement, and the Oracle answer cell below states it in
  // words rather than smuggling it in as a colour here.
  const direction: "up" | "down" | "level" | null =
    delta === null ? null : BigInt(delta) > 0n ? "up" : BigInt(delta) < 0n ? "down" : "level";
  // Only when there is a positive gap to point at. `moneyTone` is the parser as
  // well as the sign test, so a malformed field reads as "nothing to show".
  const unaccounted = vault !== null && moneyTone(vault.unaccounted) === "good" ? vault.unaccounted : null;

  return (
    <article className={`page-card ${className}`}>
      <div className="card-header-row">
        <div className="min-w-0">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> SESSION {session.sessionNumber}
          </div>
          <h3 className="mt-3 font-display text-[19px] leading-tight tracking-[-0.04em]">
            {session.navT0 === null
              ? `Session ${session.sessionNumber}`
              : `Will NAV close above ${usdc(session.navT0)} tUSDC?`}
          </h3>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <AgentStatusPill status={session.status} />
          <span className="flex items-center gap-1.5 font-mono text-xs text-fg-subtle">
            <Clock3 size={12} strokeWidth={1.8} aria-hidden />
            {live ? (
              <>
                closes in <Countdown to={session.closesAt / 1000} />
              </>
            ) : (
              <>closed {clockTime(session.closesAt)}</>
            )}
          </span>
        </div>
      </div>

      <AgentSessionSteps status={session.status} />

      <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
        <div>
          <dt className="metric-label">NAV at open</dt>
          <dd className="num mt-2 font-mono text-[15px]">{usdc(session.navT0)}</dd>
        </div>

        {running ? (
          <>
            <div>
              {/* Neutral by design. This number sits below the opening figure
                  for as long as the agent is holding anything, and tinting it
                  red would call that a loss. */}
              <dt className="metric-label">Cash now · nav()</dt>
              <dd className="num mt-2 font-mono text-[15px]">{usdc(vault?.cash ?? null)}</dd>
            </div>
            <div>
              {/* NOT "markets traded this session". `touchedCount()` is the
                  length of the vault's redeem list, and `openSession()`
                  COMPACTS that list instead of clearing it
                  (contracts/BotVault.sol:150-168): a market still holding a
                  position from an earlier session is kept so `redeemAll()` can
                  reach it. Clearing it once stranded 17.22 tUSDC in a resolved
                  market the vault could no longer redeem, so the carryover is
                  the fix and not a defect — but it means this count can include
                  markets this session never touched, and the label has to say
                  which number it is. */}
              <dt className="metric-label">Touched list · touchedCount()</dt>
              <dd className="num mt-2 font-mono text-[15px]">
                {vault === null ? "—" : vault.touchedCount}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt className="metric-label">NAV at close</dt>
              <dd className="num mt-2 font-mono text-[15px]">{usdc(session.navT1)}</dd>
            </div>
            <div>
              <dt className="metric-label">Change</dt>
              <dd
                className={`num mt-2 font-mono text-[15px] ${
                  direction === "up"
                    ? "positive"
                    : direction === "down"
                      ? "negative"
                      : "text-fg-subtle"
                }`}
              >
                {signedUsdc(delta)}
              </dd>
            </div>
          </>
        )}

        <div>
          <dt className="metric-label">Oracle answer</dt>
          {/* 1 = YES = NAV rose, and it is 1 because `BotNavOracle.finalize()`
              sets `finalValue = navT1 > navT0 ? OUTCOME_YES : OUTCOME_NO` with
              `OUTCOME_YES = 1`. This card read the pair the other way round and
              printed every real loss as a green "NAV rose" — the same inversion
              `agentStandings` and `deriveStanding` both record having fixed,
              missed here. Read the contract, not a comment, if they ever
              disagree again. */}
          <dd className="mt-2 text-[12px] font-medium">
            {session.outcomeValue === 1 ? (
              <span className="positive">NAV rose</span>
            ) : session.outcomeValue === 2 ? (
              <span className="negative">NAV did not rise</span>
            ) : (
              <span className="text-fg-subtle">not answered yet</span>
            )}
          </dd>
        </div>
      </dl>

      {running && (
        <p className="mt-4 text-xs leading-relaxed text-fg-muted">
          {vault === null
            ? "No live cash figure for this session right now: the vault did not answer, or it has already moved past this session on chain. The opening NAV above is the level it settles against."
            : "touchedCount() is the vault's redeem list, not a tally for this session — it can include carryover from an earlier one."}
        </p>
      )}

      {/* The product's central claim, shown only when there is something to
          claim it about. The collateral's faucet is permissionless, so anyone
          can push tokens into this vault; none of them are in the figure above. */}
      {unaccounted !== null && (
        <p className="callout callout-neutral mt-4 text-fg-muted">
          <span className="mono">unaccounted()</span> reads {usdc(unaccounted)} tUSDC — arrived
          outside a DreamDEX call, so it cannot move what this session settles on.
        </p>
      )}

      {/* The two readings a settled session leaves behind: what the agent's own
          oracle answered, and which leg DreamDEX actually paid. They are shown
          side by side rather than folded together, because the outcome legs are
          registered against the oracle's numeric answer at mint time and the
          pairing is a property of that registration — the record, not a rule
          this screen is entitled to restate. */}
      {session.resolvedOutcome !== null && (
        <p className="callout callout-neutral mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
          <span>DreamDEX paid the</span>
          <OutcomeTag outcome={session.resolvedOutcome === 0 ? "up" : "down"} />
          <span>leg on this session.</span>
        </p>
      )}

      {session.voided && (
        <p className="callout callout-warn mt-5 text-fg-muted">
          The validator subcommittee could not agree on an answer, so both sides were refunded. A
          voided session is neither a win nor a loss and is excluded from this agent&apos;s record
          entirely.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 font-mono text-xs text-fg-subtle">
        {session.metaMarketId ? (
          // Meta-markets are native DreamDEX Event Contracts, so the contract
          // page already reads, quotes and trades them with no changes.
          <Link href={`/market/${session.metaMarketId}`} className="view-link">
            Open the meta-market <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </Link>
        ) : (
          <span>Meta-market not minted yet</span>
        )}

        {onViewTrades && (
          <button type="button" className="view-link" onClick={onViewTrades}>
            Trades from this session <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </button>
        )}

        <ExternalLink href={addressUrl(session.oracleAddress)} className="hover:text-fg-muted">
          oracle {shortHex(session.oracleAddress)}
        </ExternalLink>

        {session.openTx && (
          <ExternalLink href={txUrl(session.openTx)} className="hover:text-fg-muted">
            open {shortHex(session.openTx)}
          </ExternalLink>
        )}
        {session.mintTx && (
          <ExternalLink href={txUrl(session.mintTx)} className="hover:text-fg-muted">
            mint {shortHex(session.mintTx)}
          </ExternalLink>
        )}
        {session.finalizeTx && (
          <ExternalLink href={txUrl(session.finalizeTx)} className="hover:text-fg-muted">
            finalize {shortHex(session.finalizeTx)}
          </ExternalLink>
        )}

        <span className="num ml-auto">
          {clockTime(session.opensAt)} → {clockTime(session.closesAt)}
        </span>
      </div>
    </article>
  );
}
