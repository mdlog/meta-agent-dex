import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "Terms",
  description: "Meta-Agent DEX is a testnet education and competition product. What that means for you.",
};

/**
 * Half of this page used to govern a relationship that no longer exists — a
 * reader who signed orders, a leaderboard their score could be removed from,
 * and an anti-farming rule about forecast samples. Nobody trades here from a
 * browser now, so those clauses were removed rather than reworded: a term that
 * binds nobody is not a cautious term, it is a false description of the
 * product. What replaces them is the relationship that does exist — you run
 * the agent, you hold its keys, and its orders are yours.
 */
export default function TermsPage() {
  return (
    <article className="mx-auto max-w-[68ch]">
      <PageHeader
        meta={<span>Last reviewed 7 September 2026</span>}
        title="Terms of use"
        lede="This is a testnet education and competition product. Nothing in it has monetary value and nothing in it is financial advice."
      />

      <div className="mt-8 space-y-9 text-base text-fg-muted">
        <section>
          <h2 className="text-lg text-fg">No real value</h2>
          <p className="mt-2.5">
            Meta-Agent DEX operates exclusively on Somnia Shannon testnet. Test USDC is obtained
            from a public faucet, has no purchase price and no redemption value, and cannot be
            exchanged for anything. A profit or loss shown anywhere in this product is a
            measurement, not money.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">Not financial advice</h2>
          <p className="mt-2.5">
            Every reading in this product — an implied probability, an agent&rsquo;s record, a NAV
            curve — describes order books and transactions that already happened. None of it is a
            recommendation to take any position, here or anywhere else, and a strategy that scored
            well over a handful of testnet sessions has demonstrated nothing about any other market.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">This site places no orders</h2>
          <p className="mt-2.5">
            There is no trading path in this application. Every order, redemption and settlement
            call in Meta-Agent DEX is made by an agent process holding its own private key, run by
            whoever registered it, against the published DreamDEX SDK. Nothing you click here signs
            anything, and this application takes no custody and holds no key on your behalf.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">If you run an agent, it is yours</h2>
          <p className="mt-2.5">
            The daemons in <span className="mono">bots/</span> run on your machine, under your
            configuration, signing with keys you generated. You are responsible for what they do and
            for the security of those keys. The vault design limits the damage a leaked operator key
            can cause — that key may only call <span className="mono">trade()</span>, never{" "}
            <span className="mono">deposit</span> or <span className="mono">withdraw</span> — but an
            agent that trades badly loses testnet collateral, and that is the point of the exercise
            rather than a defect in it.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">The contracts are not ours</h2>
          <p className="mt-2.5">
            Markets, order books, order placement and resolution come from DreamDEX Event Contracts
            through the published SDK, and resolution is voted by DreamDEX&rsquo;s oracle committee
            reading our published number. Those contracts and that committee are operated
            independently. When a contract settles against an agent, voids, or fails to fill, that
            outcome is determined on chain and Meta-Agent DEX can neither reverse nor compensate it.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-fg">Availability</h2>
          <p className="mt-2.5">
            This is a testnet project. The chain, the indexer and this application may each be
            unavailable without notice, and data may be reset. Nothing here is offered with a
            warranty or a service commitment.
          </p>
        </section>

        <p className="border-t border-line pt-6 text-sm text-fg-subtle">
          What the product stores is described in the{" "}
          <Link href="/privacy" className="link">
            privacy notice
          </Link>
          .
        </p>
      </div>
    </article>
  );
}
