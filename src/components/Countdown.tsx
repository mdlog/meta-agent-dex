"use client";

import { useEffect, useState } from "react";

/**
 * Expiry countdown (FR-023). Stops at zero and switches to the settlement
 * wording rather than counting negative, and always renders a text value so it
 * stays readable with animation disabled (PRD §10.3).
 */
export function Countdown({ to, className = "" }: { to: number; className?: string }) {
  // The clock does not start until the component is on the client.
  //
  // Seeding this from `Date.now()` meant the server rendered one second and the
  // browser rendered another, and React reported a hydration mismatch on every
  // route that shows a countdown — a red "1 Issue" badge on the landing page in
  // `next dev`. There is no correct server value here: a countdown is a reading
  // of the *reader's* clock. So first paint is a placeholder, identical on both
  // sides, and the first real value lands on mount a frame later.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  if (now === null) {
    // An em dash rather than nothing: the line keeps its height, so the row does
    // not reflow under the reader when the first tick arrives. It carries no
    // information, so it is not announced.
    return (
      <span className={`num ${className}`} aria-hidden>
        —
      </span>
    );
  }

  // Callers pass milliseconds/1000 in places, so `to` can carry a fraction.
  // Flooring here keeps the seconds field an integer for every caller rather
  // than rendering "42.884000062".
  const left = Math.floor(to) - now;

  if (left <= 0) {
    return (
      <span className={`num ${className}`} aria-live="polite">
        awaiting settlement
      </span>
    );
  }

  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;

  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${String(s).padStart(2, "0")}s` : `${m}m ${String(s).padStart(2, "0")}s`;

  return (
    <span className={`num ${className}`} aria-live="off">
      {text}
    </span>
  );
}
