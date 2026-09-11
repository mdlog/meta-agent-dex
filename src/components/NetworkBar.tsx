"use client";

/**
 * Chain and data-source status.
 *
 * It answers three questions a judge or a user will ask within seconds: which
 * chain is this, is the data real, and is my wallet on the right network
 * (FR-002, AC-016). The hook owns the polling; AppShell renders the result in
 * the topbar, and the banner below is the unmissable case.
 */

import { useEffect, useState } from "react";

export type Health = {
  mode: "live" | "sim";
  ok: boolean;
  chainId: number;
  indexerBlock: number | null;
  message: string | null;
  chainName: string;
};

/**
 * Poll fast while something is wrong, and back off once nothing is.
 *
 * The number that matters is the recovery one: the indexer could be back for
 * most of a minute while the page still said SIMULATED, which on camera reads
 * as a product that cannot tell.
 */
const POLL_WRONG_MS = 5_000;
const POLL_NOMINAL_MS = 15_000;

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  /**
   * Three states, not two. `health === null` used to mean both "not asked yet"
   * and "the health route did not answer", and both fell through to nominal —
   * so an app that could not reach its own status endpoint showed a green dot.
   * It has to be able to say it does not know.
   */
  const [probe, setProbe] = useState<"loading" | "ok" | "unreachable">("loading");
  /**
   * When this browser last got an answer, measured here rather than read from
   * the payload's `checkedAt`. That field is server time, and the shell renders
   * the gap as "checked N seconds ago" — a clock skew of minutes between the
   * two machines would turn that number into a confident lie.
   */
  const [receivedAt, setReceivedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      let next = POLL_NOMINAL_MS;
      try {
        const r = await fetch("/api/health");
        if (!r.ok) throw new Error(String(r.status));
        const h: Health = await r.json();
        if (!alive) return;
        setHealth(h);
        setProbe("ok");
        setReceivedAt(Date.now());
        if (!h.ok || h.mode === "sim") next = POLL_WRONG_MS;
      } catch {
        if (!alive) return;
        setHealth(null);
        setProbe("unreachable");
        next = POLL_WRONG_MS;
      }
      timer = setTimeout(() => void load(), next);
    };

    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const unreachable = probe === "unreachable";
  /**
   * Simulated and degraded are not the same failure and must not share copy.
   * `simulated` means the contracts on screen were generated locally; the
   * indexer's health probe failing while market reads still succeed means real
   * data whose lag cannot be confirmed.
   */
  const simulated = health?.mode === "sim";
  const indexerFailing = health ? !health.ok && !simulated : false;
  const nominal = probe === "ok" && !simulated && !indexerFailing;
  const wrong = unreachable || simulated || indexerFailing;

  const statusText =
    probe === "loading"
      ? "Checking data source…"
      : unreachable
        ? "Status unknown: the health check did not answer"
        : simulated
          ? "SIMULATED DATA — not Somnia testnet"
          : indexerFailing
            ? "Indexer health check failing: lag unconfirmed"
            : "LIVE DreamDEX data";

  const detail =
    wrong && !simulated
      ? (health?.message ??
        "Meta-Agent DEX could not reach its own /api/health route, so it cannot vouch for the data on screen. Everything below may be stale.")
      : null;

  return { health, probe, receivedAt, unreachable, simulated, indexerFailing, nominal, wrong, statusText, detail };
}

export type HealthStatus = ReturnType<typeof useHealth>;

/**
 * Unmissable by construction: solid alert, full bleed, above everything else
 * in the sticky shell, and it says what is on screen instead of naming an
 * internal mode.
 */
export function SimulatedBanner({ message }: { message: string | null }) {
  return (
    <div className="bg-danger text-canvas" role="alert">
      <div className="mx-auto flex max-w-[var(--measure)] flex-wrap items-baseline gap-x-2.5 gap-y-1 px-[var(--gutter)] py-2 text-xs">
        <span className="shrink-0 font-bold uppercase tracking-wide">Simulated data</span>
        <span className="min-w-0 font-medium">
          {message ??
            "Every contract being served right now is generated locally. None of them exists on Somnia testnet, and none can take an order."}
        </span>
      </div>
    </div>
  );
}
