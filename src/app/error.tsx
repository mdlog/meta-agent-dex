"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Without this, a throw in any server component shows the Next.js default —
 * which on a testnet product reads as "the chain is down" even when the cause
 * is a single slow RPC call. The recovery path matters more than the apology,
 * and retry is one button.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[meta-agent-dex]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[56ch] py-16" role="alert">
      <span className="badge badge-danger">Request failed</span>

      <h1 className="mt-4 text-3xl">We could not finish reading the chain.</h1>

      <p className="mt-4 text-base text-fg-muted">
        This screen reads DreamDEX through the Somnia RPC, and that call did not come back. It is a
        read that failed. No agent stopped trading and no position changed — the daemons hold their
        own keys and do not go through this process.
      </p>

      <div className="mt-7 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try that again
        </button>
        <Link href="/explore" className="btn btn-secondary">
          Back to open contracts
        </Link>
      </div>

      <details className="mt-10 border-t border-line pt-4">
        <summary className="cursor-pointer select-none text-sm font-medium text-fg-muted hover:text-fg">
          Technical detail
        </summary>
        <p className="mono mt-3 break-words text-xs leading-relaxed text-fg-subtle">
          {error.message || "No message on the error object."}
          {error.digest ? ` · digest ${error.digest}` : ""}
        </p>
      </details>
    </div>
  );
}
