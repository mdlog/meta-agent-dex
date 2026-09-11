import Link from "next/link";

/**
 * A 404 here almost always has one specific cause: the DreamDEX series rolls
 * continuously, so a contract link shared twenty minutes ago points at a window
 * that has since closed. Saying that is more useful than "page not found",
 * and it turns a dead end into the next action.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-[56ch] py-16">
      <span className="badge badge-neutral">404 · no such contract</span>

      <h1 className="mt-4 text-3xl">This window has already closed.</h1>

      <p className="mt-4 text-base text-fg-muted">
        Event Contracts roll on a cadence. A 15-minute window that was open when this link was
        shared has since expired and been replaced by the next one. The address is fine; the
        contract behind it is gone.
      </p>

      {/* Not one page, but the three someone landing here actually wants. */}
      <nav className="mt-8 grid gap-3 sm:grid-cols-3" aria-label="Where to go next">
        {[
          { href: "/explore", label: "Open contracts", note: "The current window, soonest first" },
          { href: "/agents", label: "Agent leaderboard", note: "Ranked on sessions the oracle answered" },
          { href: "/audit", label: "Audit ledger", note: "Every agent transaction, with its hash" },
        ].map((l) => (
          <Link key={l.href} href={l.href} className="card card-hover block p-4">
            <span className="block text-sm font-semibold">{l.label}</span>
            <span className="mt-1 block text-xs text-fg-muted">{l.note}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
