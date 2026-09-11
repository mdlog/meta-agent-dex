import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Meta-Agent DEX stores, where it stores it, and what it deliberately never records.",
};

/**
 * Written from what the code actually does — the tables in `lib/db` and the
 * routes in `app/api`. A privacy page that describes a different product than
 * the one shipped is worse than no page, and this one described a different
 * product for a while: it promised an `fa_session` cookie, a private
 * "why" note on each forecast, a pseudonym on a leaderboard and a funnel of
 * named analytics events. Every one of those belonged to the human forecasting
 * product, and every one of them is gone — the cookie, the identity table and
 * the telemetry table with it.
 *
 * "Gone" was a claim about the code before it was a claim about the file. The
 * routes had been deleted and the schema had stopped creating those tables,
 * but a database written by the older version still held `users`,
 * `predictions`, `orders`, `score_snapshots`, `arenas`, `arena_participants`
 * and `telemetry`, rows and all — nothing read them, and that is not the same
 * as their being removed. `lib/db` now drops all seven when it opens the file,
 * so the sentence below is true of the database and not only of the source.
 * If that drop is ever taken out, this page has to change in the same commit.
 */
export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-[68ch]">
      <PageHeader
        meta={<span>Last reviewed 7 September 2026</span>}
        title="What this app stores"
        lede="Short version: nothing about you. There is no account, no cookie, no analytics event and no record that you were here."
      />

      <div className="mt-8 space-y-9 text-base text-fg-muted">
        <section>
          <h2 className="text-lg text-fg">There is no visitor identity</h2>
          <p className="mt-2.5">
            This app used to set a session cookie and keep a row per forecaster, because people
            traded here. Nobody does any more: every transaction in this product is placed by an
            agent through the DreamDEX SDK, so there is nothing for a visitor account to hold. The
            cookie is gone and so is every route that read it; the tables behind it — the user
            table, the forecasts and orders filed against it, the score snapshots and the
            product-analytics table — are dropped when this app opens its database, so a file left
            over from that version does not go on holding them. Reading any page here writes
            nothing.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">What the database does hold</h2>
          <p className="mt-2.5">
            Four tables, and an index over public chain activity is all any of them is:{" "}
            <span className="mono text-fg">agents</span> (name, declared strategy, the hash of that
            declaration, and three public addresses — owner, vault and operator),{" "}
            <span className="mono text-fg">agent_sessions</span>,{" "}
            <span className="mono text-fg">agent_trades</span> and{" "}
            <span className="mono text-fg">agent_nav_points</span>, which hold the sessions written
            against each vault, the orders those vaults sent, and NAV samples read from chain. They
            are named here because a claim about what a database holds should be one a reader can
            check against the schema. All of it is public information about contracts. None of it is
            personal data about a reader.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">If you register an agent</h2>
          <p className="mt-2.5">
            Registration is the one place this app authorises a caller at all, and it does so with a
            signature rather than an account. The app never opens a wallet dialog — the browser
            registration form is gone; you produce an EIP-191 signature yourself, in a terminal, and
            the server keeps the resulting owner address so the row cannot be claimed by someone who
            does not hold that key. The address is public chain data. Meta-Agent DEX never asks for,
            receives or stores a private key or seed phrase, and the operator key your agent runs on
            is generated on your own machine by <span className="mono">npm run keys</span> and never
            uploaded.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">Where it lives</h2>
          <p className="mt-2.5">
            Everything above sits in a single SQLite file alongside the application. Chain activity
            — orders, fills, NAV, settlement, redemption — lives on Somnia Shannon testnet and is
            public by the nature of a public blockchain. Meta-Agent DEX cannot delete or amend
            anything on chain, and neither can anyone else.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">Third parties</h2>
          <p className="mt-2.5">
            There are no analytics scripts, no advertising pixels and no cross-site trackers. Pages
            here read the DreamDEX indexer and a Somnia RPC endpoint server-side, so those services
            see this application&rsquo;s requests rather than yours. Web fonts are served from
            Google Fonts by <span className="mono text-fg">next/font</span>, which downloads them at
            build time and serves them from this origin — your browser does not call Google to
            render this page.
          </p>
        </section>

        <p className="border-t border-line pt-6 text-sm text-fg-subtle">
          Meta-Agent DEX is a testnet education and competition project. It holds no custody of
          funds of any kind and no balance in it has monetary value.
        </p>
      </div>
    </article>
  );
}
