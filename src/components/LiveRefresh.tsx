"use client";

/**
 * Keeps a server-rendered page true.
 *
 * Every screen in this app is a single `force-dynamic` server render. That is
 * the right shape for a chain read and the wrong shape for a venue whose most
 * common cadences are 1m and 5m: a reader who spends a minute on a contract is
 * looking at a window that has already locked, a book that has already moved,
 * and a "Review and sign" button that will be refused by the pool.
 *
 * `router.refresh()` re-runs the server component and reconciles the new tree
 * into the live one, so the ticket's mode, stake, slider position, focus and
 * in-flight phase all survive the update — a `location.reload()` would throw
 * every one of them away mid-forecast.
 *
 * The readout is not decoration. `renderedAt` is stamped by the server render
 * that produced what is on screen, so the age below measures when this data was
 * made. If the route ever started answering from a cache the number would climb
 * instead of resetting, and the page would say so out loud.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MarketStatus } from "@/lib/domain/types";

/** The end of the road. A resolved or voided contract cannot change again. */
const TERMINAL: MarketStatus[] = ["resolved", "voided"];

/**
 * Past expiry the book is frozen and the only outstanding change is the
 * oracle's answer, so the cadence drops rather than holding a 5s poll open for
 * however long settlement decides to take.
 */
const SETTLING_MS = 15_000;

/** The lock happens in a block, and the indexer has to have seen that block. */
const LOCK_GRACE_MS = 1_500;

export function LiveRefresh({
  renderedAt,
  everyMs = 5_000,
  lockAt = null,
  status = null,
  className = "",
}: {
  /** `Date.now()` from the server render that produced the page on screen. */
  renderedAt: number;
  /**
   * Cadence while the contract is still live. 5s because the live adapter holds
   * markets for 4s and books for 2s: anything faster is answered out of that
   * cache and spends a round trip on a value that cannot have moved yet.
   */
  everyMs?: number;
  /** Unix seconds. One extra read fires the moment this passes. */
  lockAt?: number | null;
  /** Omit on a page that is not about a single contract; it then never stops. */
  status?: MarketStatus | null;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);
  const [motion, setMotion] = useState(true);
  const [now, setNow] = useState<number | null>(null);

  const terminal = status !== null && TERMINAL.includes(status);
  const polling = !terminal && !paused;

  const busy = useRef(false);
  useEffect(() => {
    busy.current = pending;
  }, [pending]);

  const refresh = useCallback(() => {
    // A read slower than the cadence must not stack behind itself.
    if (busy.current) return;
    startTransition(() => router.refresh());
  }, [router]);

  // -- the reader's own preference ------------------------------------------
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setMotion(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // -- the age readout -------------------------------------------------------
  const origin = useRef<{ client: number; server: number } | null>(null);

  useEffect(() => {
    // The server's clock and the reader's clock are not the same clock, and a
    // laptop two minutes fast would otherwise read "re-read 120s ago" on a page
    // that is refreshing perfectly. The first payload pins the offset once;
    // every age below is measured against it, so this reports the gap between
    // server renders rather than anyone's wall clock.
    origin.current ??= { client: Date.now(), server: renderedAt };
    setNow(Date.now());

    // A per-second label is auto-updating text. Someone who asked for less
    // motion gets the cadence stated once instead, and the line then only
    // changes when a refresh actually lands.
    if (!motion || terminal) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
    // `renderedAt` is deliberately absent: the offset belongs to the first
    // payload, and re-pinning it on every refresh would hold the age at zero
    // forever — precisely the lie this readout exists to catch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion, terminal]);

  const age =
    now === null || origin.current === null
      ? null
      : Math.max(0, now - origin.current.client - (renderedAt - origin.current.server));

  // -- the poll --------------------------------------------------------------
  useEffect(() => {
    if (!polling) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const cadence = () =>
      lockAt !== null && Date.now() >= lockAt * 1_000 ? SETTLING_MS : everyMs;

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      stop();
      timer = setTimeout(tick, cadence());
    };
    const tick = () => {
      refresh();
      arm();
    };

    const onVisibility = () => {
      // A background tab reads nothing, so it must spend nothing: the whole
      // point of a 5s poll against a testnet RPC is that somebody is watching.
      if (document.hidden) {
        stop();
        return;
      }
      // Whatever is on screen was true when the tab went away. A returning
      // reader deserves a fresh read now, not at the end of the next tick.
      tick();
    };

    if (!document.hidden) arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [polling, lockAt, everyMs, refresh]);

  // -- the lock boundary -----------------------------------------------------
  useEffect(() => {
    if (!polling || lockAt === null) return;

    // The interval would find the lock within 5s anyway, but "within 5s" is the
    // whole of a 1m contract's final act — the beat where Trading becomes
    // Locked is the one a judge is watching for, so it gets its own timer.
    const delay = lockAt * 1_000 - Date.now() + LOCK_GRACE_MS;
    if (delay <= 0 || delay > 2 ** 31 - 1) return;

    const t = setTimeout(() => {
      if (!document.hidden) refresh();
    }, delay);
    return () => clearTimeout(t);
  }, [polling, lockAt, refresh]);

  // -- readout ---------------------------------------------------------------
  const dot = `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${polling ? "bg-good" : "bg-fg-subtle"} ${
    polling && motion ? "live-dot" : ""
  }`;

  const label =
    age === null
      ? "live · —" // Stable on both sides of hydration; the clock starts on mount.
      : terminal
        ? "settled · polling stopped"
        : paused
          ? `paused · re-read ${ageText(age)}`
          : motion
            ? `live · re-read ${ageText(age)}`
            : `live · re-reading every ${Math.round(everyMs / 1_000)}s`;

  const line = (
    <>
      <span className={dot} aria-hidden />
      {label}
    </>
  );

  const shared = `num inline-flex items-center gap-1.5 text-xs text-fg-subtle ${className}`;

  // Auto-updating content needs a way to stop it (PRD §10.3). It is also the
  // affordance that makes the refresh discoverable at all: a judge who wants to
  // read the book without it moving under them has one click to freeze it.
  return terminal ? (
    <span className={shared} aria-live="off">
      {line}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setPaused((p) => !p)}
      aria-label={paused ? "Resume automatic refresh" : "Pause automatic refresh"}
      className={`btn ${shared} hover:text-fg`}
    >
      {line}
    </button>
  );
}

/** Seconds until the number stops being useful, then minutes. */
function ageText(age: number): string {
  return age < 90_000 ? `${Math.round(age / 1_000)}s ago` : `${Math.round(age / 60_000)}m ago`;
}
