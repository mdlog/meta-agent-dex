import Link from "next/link";
import { ArrowUpRight, Bot, KeyRound, ShieldCheck, Terminal } from "lucide-react";
import { getSessionByMarketId } from "@/lib/services/agentSessions";
import { getAgentById } from "@/lib/services/agents";
import { liveVaultForSession } from "@/lib/agents/vaultState";
import { addressUrl } from "@/lib/wallet/chain";
import { shortHex, usdc } from "@/components/agentFormat";
import { SessionSignalPill } from "@/components/AgentStatusPill";
import { ExternalLink } from "@/components/Primitives";
import type { ArenaMarket } from "@/lib/domain/types";

/**
 * What stands where the trade ticket stood.
 *
 * Every order that reaches this book is signed by an agent key through the
 * DreamDEX SDK — a vault's operator key on the layer below, a speculator's own
 * EOA on this one. There is no browser signing path left in this application,
 * so a ticket here would be a control with nothing behind it.
 *
 * The panel answers the two questions the missing ticket leaves. Who is on this
 * book, which for a meta-market is a specific agent with a specific vault and a
 * baseline NAV already frozen on chain; and how a reader gets on it themselves,
 * which is a daemon they run against the same SDK, not a button on this page.
 *
 * Nothing here is asserted that the row does not carry. A session whose vault
 * read failed prints a dash and says the read failed, because "0 tUSDC" and "we
 * could not reach the vault" are different facts and only one of them is true.
 */
export async function MarketObserverPanel({ market }: { market: ArenaMarket }) {
  // A meta-market's id is written into the session journal at mint. Anything
  // else on this venue — the BTC/ETH series the trading agents work — is a
  // contract we index but did not create, and it gets the second panel.
  const session = market.simulated ? null : getSessionByMarketId(market.id);
  const agent = session ? getAgentById(session.agentId) : null;

  // Only while the vault still says it is on this session. `liveVaultForSession`
  // refuses a reading whose counter has moved on, so a null here means "no
  // current reading", never "zero".
  const vault =
    session && agent
      ? await liveVaultForSession({
          sessionId: session.id,
          sessionNumber: session.sessionNumber,
          vaultAddress: agent.vaultAddress,
        }).catch(() => null)
      : null;

  return (
    <div className="space-y-4">
      {session && agent ? (
        <section className="card p-5" aria-label="The agent this contract prices">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="label">This contract prices</p>
              <Link href={`/agents/${agent.slug}`} className="mt-1.5 flex items-center gap-2 text-lg font-semibold hover:text-accent">
                <Bot size={18} strokeWidth={1.8} aria-hidden />
                <span className="truncate">{agent.name}</span>
              </Link>
              <p className="mono mt-1 text-xs text-fg-subtle">
                SESSION {String(session.sessionNumber).padStart(2, "0")} · {agent.strategy}
              </p>
            </div>
            <SessionSignalPill status={session.status} />
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line-soft pt-4 text-sm">
            <div>
              <dt className="label">NAV at open</dt>
              {/* The number the oracle froze before this market could take an
                  order. It is half of the comparison the contract settles on. */}
              <dd className="num mt-1 font-semibold">
                {session.navT0 === null ? "—" : `${usdc(session.navT0)} tUSDC`}
              </dd>
            </div>
            <div>
              <dt className="label">{session.navT1 === null ? "Vault cash now" : "NAV at close"}</dt>
              <dd className="num mt-1 font-semibold">
                {session.navT1 !== null
                  ? `${usdc(session.navT1)} tUSDC`
                  : vault
                    ? `${usdc(vault.cash)} tUSDC`
                    : "—"}
              </dd>
            </div>
          </dl>

          <p className="help mt-3 leading-relaxed">
            {session.navT1 !== null ? (
              <>
                Both readings are <span className="mono">BotVault.nav()</span> at a published block.{" "}
                {/* One string per branch, punctuation included: splitting a
                    sentence across JSX children inserts a space before the
                    comma or semicolon that ends the fragment. */}
                {session.outcomeValue === 1
                  ? "The oracle answered YES, and DreamDEX's committee read that number to settle this market."
                  : session.outcomeValue === 2
                    ? "The oracle answered NO, and DreamDEX's committee read that number to settle this market."
                    : "The oracle has not answered yet."}
              </>
            ) : vault ? (
              <>
                {/* "on the redeem list", not "open positions" and not "traded
                    this session". `touched` is what `redeemAll()` will walk:
                    entries are added on the first trade and dropped only at the
                    NEXT `openSession()`, and only if the vault holds nothing in
                    them by then — so the list carries both markets already
                    redeemed this session and markets left over from earlier
                    ones. */}
                {vault.touchedCount === 0
                  ? "Cash, not NAV: the vault's redeem list is empty, and outcome tokens only convert back when "
                  : `Cash, not NAV: touched() holds ${vault.touchedCount} market${vault.touchedCount === 1 ? "" : "s"} for redemption — carryover from an earlier session included — and outcome tokens only convert back when `}
                <span className="mono">redeemAll()</span> runs at close.{" "}
                <span className="mono">unaccounted()</span> holds {usdc(vault.unaccounted)} tUSDC that no DreamDEX call
                delivered, excluded from NAV by construction.
              </>
            ) : (
              <>The vault read did not answer, so there is no current cash reading — not a reading of zero.</>
            )}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-fg-subtle">
            <ExternalLink href={addressUrl(agent.vaultAddress)} className="hover:text-fg-muted">
              vault {shortHex(agent.vaultAddress)}
            </ExternalLink>
            <ExternalLink href={addressUrl(session.oracleAddress)} className="hover:text-fg-muted">
              oracle {shortHex(session.oracleAddress)}
            </ExternalLink>
          </div>

          <Link href={`/agents/${agent.slug}`} className="text-button mt-4">
            Open the agent dossier <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </Link>
        </section>
      ) : (
        <section className="card p-5" aria-label="Who trades this contract">
          <p className="label">Who is on this book</p>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {market.simulated
              ? "Nobody. This contract was generated locally while the DreamDEX indexer was unreachable — it exists nowhere on Somnia, and no agent can place an order against it."
              : "This is a DreamDEX venue contract, not one this project minted. Meta-Agent DEX's trading agents take positions in this series out of their vaults; what this app mints is the layer above — a contract on whether one of those vaults ends its session higher."}
          </p>
          <Link href="/agents" className="text-button mt-4">
            The agents that trade here <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </Link>
        </section>
      )}

      {/* The honest replacement for the ticket. It says what signs, names the
          file that does it, and points at the ledger where those signatures
          already are — three things a reader can check without an account. */}
      <section className="card p-5" aria-label="How orders reach this book">
        <p className="label flex items-center gap-1.5">
          <KeyRound size={13} strokeWidth={1.8} aria-hidden /> How orders reach this book
        </p>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Every one of them is signed by an agent, through{" "}
          <span className="mono text-fg">@somnia-chain/markets-sdk</span>. This page cannot place an
          order and holds no key: there is no browser signing path in this product.
        </p>

        <ol className="mt-4 space-y-3 text-sm">
          <li>
            <p className="mono text-xs text-fg-subtle">LAYER 1 · bots/runner.ts</p>
            <p className="mt-1 text-fg-muted">
              Signs with a vault&rsquo;s operator key, which on chain may call{" "}
              <span className="mono">BotVault.trade()</span> and nothing else — not{" "}
              <span className="mono">deposit</span>, not <span className="mono">withdraw</span>.
            </p>
          </li>
          <li>
            <p className="mono text-xs text-fg-subtle">LAYER 2 · bots/speculator.ts</p>
            <p className="mt-1 text-fg-muted">
              Signs with its own funded EOA and takes YES or NO on markets like this one, from a
              thesis about the agent&rsquo;s record and the vault&rsquo;s cash.
            </p>
          </li>
        </ol>

        <div className="mt-4 border-t border-line-soft pt-4">
          <p className="text-sm font-medium text-fg">Run one against this venue</p>
          <pre className="mono mt-2 overflow-x-auto rounded-md bg-card-2 px-3 py-2 text-xs text-fg-muted">
            npm run speculator
          </pre>
          <p className="help mt-2 flex items-start gap-1.5">
            <Terminal size={12} strokeWidth={1.8} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Both daemons and every environment variable they take are documented in{" "}
              <span className="mono text-fg">bots/README.md</span> in this repository.
            </span>
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-line-soft pt-4">
          <Link href="/audit" className="text-button">
            <ShieldCheck size={13} strokeWidth={1.8} aria-hidden /> Every agent transaction
          </Link>
          <Link href="/settlement" className="text-button">
            How settlement works <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </Link>
        </div>
      </section>
    </div>
  );
}
