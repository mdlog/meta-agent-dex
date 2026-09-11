"use client";

/**
 * The Signal Room shell: a persistent rail, a status topbar, and the page
 * frame every route renders inside.
 *
 * Three things in the source design were fiction and are not reproduced here.
 * The rail note claimed outcomes are "resolved by code, not an oracle
 * committee" — the opposite is true, and the honest version is the better
 * story. The topbar had a notification bell with no notification system behind
 * it. The rail had a named person and an invented address. What replaces them
 * is measured: the indexer block the app actually read and the chain it is
 * actually on.
 *
 * WHY THERE IS NO "CONNECT WALLET" HERE ANY MORE. There was, until every
 * transaction in this product became an agent's. A visitor cannot place an
 * order, take a side or redeem a position, so a connect button in the topbar
 * would open a wallet dialog that leads nowhere — the worst kind of dead
 * control, because it works. What stands in its place is the two things a
 * visitor can actually do: read the ledger of what the agents have already
 * signed, and run one of their own. The one screen that needed a signature asked
 * for it in context on its own page; that page is gone, and `/docs` replaced it —
 * instructions for producing the same signature in a terminal, for a claim the
 * server can check.
 *
 * Chrome styling lives in globals.css with the rest of the ported design;
 * signal-room.css adds only the states this shell needs and the mock did not.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { ArrowUpRight, BookOpen, ChartColumn, KeyRound, LayoutDashboard, Menu, Network, ShieldCheck, Terminal, Trophy, X, Zap, type LucideIcon } from "lucide-react";
import { SOMNIA_SHANNON } from "@/lib/wallet/chain";
import { SimulatedBanner, useHealth, type HealthStatus } from "./NetworkBar";

type NavLink = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; items: readonly NavLink[] };

/**
 * The design's labels, pointed at routes this app actually serves. Its
 * "Leaderboard" is the agent board at /agents.
 *
 * There was an Account group here — Portfolio and Profile, a person's own
 * forecasts and their calibration record. Both were surfaces of a product
 * where humans forecast prices, and neither has anything to show once nobody
 * can take a position. A nav entry to an empty page is a promise the app
 * cannot keep, so the group is gone rather than emptied.
 */
const NAV: readonly NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/agents", label: "Leaderboard", icon: Trophy },
      { href: "/explore", label: "Meta-markets", icon: ChartColumn },
      { href: "/docs", label: "Docs", icon: BookOpen },
    ],
  },
  {
    label: "Protocol",
    items: [
      { href: "/settlement", label: "Settlement engine", icon: Network },
      { href: "/audit", label: "Audit ledger", icon: ShieldCheck },
    ],
  },
];

const ALL_LINKS: readonly NavLink[] = NAV.flatMap((g) => g.items);

/**
 * The longest matching href wins, so a nested route does not light up
 * /agents as well. Exact match only for "/", which prefixes everything.
 */
function activeHref(path: string): string | null {
  let best: string | null = null;
  for (const { href } of ALL_LINKS) {
    const hit = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
    if (hit && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/** Section and page name for the topbar crumb, for mapped and unmapped routes alike. */
function crumb(path: string): { section: string; page: string } {
  const href = activeHref(path);
  if (href) {
    const group = NAV.find((g) => g.items.some((i) => i.href === href));
    const item = ALL_LINKS.find((i) => i.href === href);
    if (group && item) return { section: group.label, page: item.label };
  }
  // Routes with no rail entry — a market, an agent dossier, the legal pages.
  const seg = path.split("/").filter(Boolean)[0];
  if (!seg) return { section: "Workspace", page: "Overview" };
  return { section: "Workspace", page: seg.charAt(0).toUpperCase() + seg.slice(1) };
}

/**
 * The brand mark, drawn rather than fetched: the design references a PNG that
 * is not in this repo. Two offset bars read as an M, and the cyan node cuts
 * through the centre — the meta-layer signal from the design notes.
 */
function SignalMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" fill="none" aria-hidden focusable="false">
      <path d="M4.5 25V5l8 10.5" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
      <path d="M23.5 3v20l-8-10.5" stroke="var(--color-fg-muted)" strokeWidth="3" strokeLinecap="square" />
      <circle cx="14" cy="14" r="3.4" stroke="var(--color-cyan)" strokeWidth="1.4" />
      <circle cx="14" cy="14" r="1.1" fill="var(--color-cyan)" />
    </svg>
  );
}

/**
 * What the app knows about its own data source, stated no more strongly than
 * that. It reports the block the indexer had reached and how long ago the
 * answer arrived; it never says "synced", because nothing here measures the
 * indexer against the chain head.
 */
function IndexerChip({ status }: { status: HealthStatus }) {
  const { health, probe, receivedAt, simulated, unreachable, indexerFailing, statusText } = status;
  const [now, setNow] = useState<number | null>(null);

  // Ticks locally so the age keeps counting between the 15s health polls.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const ageSec = receivedAt !== null && now !== null ? Math.max(0, Math.round((now - receivedAt) / 1000)) : null;
  // The nominal poll is 15s. Past 45s the page is no longer being told
  // anything, which is itself worth saying.
  const stale = ageSec !== null && ageSec > 45;
  const degraded = simulated || unreachable || indexerFailing;

  const block = health?.indexerBlock ?? null;
  const label = simulated
    ? "Simulated data — not Somnia"
    : unreachable
      ? "Health check did not answer"
      : indexerFailing
        ? "Indexer check failing"
        : probe === "loading"
          ? "Reading indexer…"
          : block !== null
            ? `Indexer block ${block.toLocaleString()}`
            : "Indexer block unknown";

  const tone = degraded ? "is-degraded" : stale ? "is-stale" : "";
  const dot = degraded ? "is-degraded" : stale ? "is-stale" : probe === "loading" ? "is-unknown" : "";

  return (
    <span
      className={`live-ticker ${tone}`}
      title={`${statusText} · ${health?.chainName ?? SOMNIA_SHANNON.name} · chain ${SOMNIA_SHANNON.id}`}
    >
      <span className={`status-dot ${dot}`} aria-hidden />
      <span>{label}</span>
      {ageSec !== null && (
        <span className="ticker-age">
          {stale ? "no answer for " : "checked "}
          {ageSec < 90 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`} ago
        </span>
      )}
    </span>
  );
}

/**
 * The rail's signing slot, where the connected address used to sit.
 *
 * It answers the question the missing address raises — if I am not signing,
 * who is — and it answers it with a link out to the ledger of what those keys
 * have already done, rather than with a claim.
 */
function SigningRow() {
  return (
    <Link className="profile-row" href="/audit" title="Every agent transaction, with its hash">
      <span className="avatar" aria-hidden>
        <KeyRound size={15} strokeWidth={1.9} />
      </span>
      <span className="profile-copy">
        <strong>Signed by agents</strong>
        <span>Read the ledger</span>
      </span>
      <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden />
    </Link>
  );
}

export function AppShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const path = usePathname();
  const status = useHealth();
  const [open, setOpen] = useState(false);

  const active = activeHref(path);
  const { section, page } = crumb(path);

  // Arriving somewhere is the end of navigating; the drawer has done its job.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // The scrim covers the page but not its scrolling. The attribute lets the
    // stylesheet lock the body only at the width where the drawer exists.
    document.body.dataset.drawer = "open";
    return () => {
      document.removeEventListener("keydown", onKey);
      delete document.body.dataset.drawer;
    };
  }, [open]);

  return (
    <div className="app-shell">
      {open && <div className="mobile-scrim" onClick={() => setOpen(false)} aria-hidden />}

      <aside id="app-rail" className={`sidebar ${open ? "mobile-open" : ""}`} aria-label="Primary">
        <div className="sidebar-top">
          <Link href="/" className="brand-lockup" aria-label="Meta-Agent DEX, home">
            <SignalMark />
            <div>
              <div className="brand-name">
                META<span>/</span>AGENT
              </div>
              <div className="brand-subtitle">DEX / SOMNIA</div>
            </div>
          </Link>

          <button type="button" className="mobile-close" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X size={18} strokeWidth={1.8} />
          </button>

          {/* A statement of where the app is reading, not a prompt. Nothing in
              the shell asks the visitor to be on a network any more, so there
              is no wrong network for it to offer to fix. */}
          <div className="network-chip">
            <span className="network-dot" aria-hidden />
            <span>Somnia Shannon</span>
            <span className="chip-id">{SOMNIA_SHANNON.id}</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Sections">
          {NAV.map((group, gi) => (
            <div key={group.label}>
              <div className={`nav-section-label ${gi > 0 ? "nav-section-space" : ""}`}>{group.label}</div>
              {group.items.map(({ href, label, icon: Icon }) => {
                const on = href === active;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`nav-item ${on ? "is-active" : ""}`}
                    aria-current={on ? "page" : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} aria-hidden />
                    <span>{label}</span>
                    {on && <span className="nav-active-bar" aria-hidden />}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="rail-note">
            <div className="note-kicker">
              <Zap size={12} strokeWidth={2} aria-hidden /> SETTLEMENT
            </div>
            <p>
              Settlement is defined by code and attested by DreamDEX&rsquo;s oracle committee. NAV is one number
              anyone can re-derive from two published block numbers.
            </p>
            <Link href="/settlement" className="text-button">
              How settlement works <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
          <SigningRow />
        </div>
      </aside>

      <div className="main-panel">
        {status.simulated && <SimulatedBanner message={status.health?.message ?? null} />}

        <header className="topbar">
          <button
            type="button"
            className="mobile-menu"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-controls="app-rail"
            aria-label="Open navigation"
          >
            <Menu size={20} strokeWidth={1.8} />
          </button>

          <div className="breadcrumb">
            <span>{section}</span>
            <span aria-hidden>/</span>
            <strong>{page}</strong>
          </div>

          <div className="topbar-actions">
            <IndexerChip status={status} />
            {/* The two live affordances a visitor actually has, in the slot the
                connect button used to hold: the record of what has been signed,
                and the console that puts a key of their own on the venue. */}
            <Link className="connect-button is-ghost" href="/audit">
              <ShieldCheck size={14} strokeWidth={2} aria-hidden />
              Agent transactions
            </Link>
            <Link className="connect-button" href="/docs">
              <Terminal size={15} strokeWidth={2} aria-hidden />
              {/* Points at the docs now. There is no registration form to send
                  anyone to: trading needs a vault and an operator key, not an
                  account here, so the honest destination is instructions. */}
              Docs
            </Link>
          </div>
        </header>

        {/* The simulated case already has its own banner; this line carries the
            other health failures. */}
        {status.detail && (
          <p className="shell-alert" role="alert">
            {status.detail}
          </p>
        )}

        <main id="main" className="page-content">
          {children}
        </main>

        {footer}
      </div>

      {/* One toast region for the whole app, so a page that reports the result
          of an action does not fail silently. */}
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  );
}
