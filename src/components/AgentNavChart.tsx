import { blockLabel, navDelta, unitsFloat, usdc } from "./agentFormat";

/**
 * The NAV curve — the agent screens' one instrument.
 *
 * Every point is a read of `BotVault.nav()` at a block, so the line is a
 * measurement, not a model: it only moves when a DreamDEX call delivered or
 * removed collateral. The dashed baseline is the session's opening NAV, which
 * is the number the meta-market settles against — above it the session's Up leg
 * pays, below it the Down leg does — so the whole chart reduces to "which side
 * of the dashed line does the curve end on".
 *
 * WHAT IT IS NOT is a live reading. These points come out of `agent_nav_points`,
 * whose rows are written at exactly two moments — agent registration and
 * session close — so the newest one can be arbitrarily old, and on a running
 * session usually is. Every label here therefore says "sample" and carries the
 * clock time it was taken at; the one figure on the agent page that is read
 * from the vault on the request is the 40px readout above this chart, and the
 * two are allowed to differ precisely because each says which it is.
 *
 * The curve takes the market colours for that reason and no other: green above
 * the baseline is the same Up it means everywhere else in the product. Signal
 * Lime is never used here, because it means "verified by the chain" and would
 * read as a third direction.
 *
 * ONE FORMATTER FOR EVERY VISIBLE FIGURE, and it is {@link usdc}. The floats in
 * here exist to place pixels; they are never printed. The footer used to mix
 * the two — `usdc(baseline)` beside `last.value.toFixed(2)` — and `usdc`
 * TRUNCATES a raw 6-decimal integer while `toFixed` ROUNDS a double built from
 * the same one, so a vault sitting at 100.015000 rendered as
 * "baseline 100.01 · latest 100.02": two figures, one measurement, on one line,
 * disagreeing by a cent that does not exist. Anything a reader sees below is
 * formatted from the raw string the chain returned.
 */

interface Point {
  at: number;
  nav: string;
  /**
   * The block the read was taken at, when the sampler recorded one. Printed
   * because it is what makes the curve checkable: two block numbers and a
   * public `nav()` are enough for anyone to re-derive the settlement figure
   * without trusting this page.
   */
  blockNumber?: string | null;
}

/** A short clock label. Only rendered after the caller's fetch resolves. */
function tick(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function AgentNavChart({
  points,
  baseline = null,
  baselineLabel = "session open",
  caption,
  className = "",
}: {
  points: Point[];
  /** Raw 6dp NAV the session opened at, when there is a session. */
  baseline?: string | null;
  baselineLabel?: string;
  caption?: string;
  className?: string;
}) {
  // `raw` rides along with `value` so the two never have to be reconciled:
  // `value` places a pixel, `raw` is what gets printed. Deriving a displayed
  // string from `value` is what produced the baseline/latest contradiction the
  // header describes.
  const series = points
    .map((p) => ({ at: p.at, value: unitsFloat(p.nav), raw: p.nav, block: p.blockNumber ?? null }))
    .filter(
      (p): p is { at: number; value: number; raw: string; block: string | null } => p.value !== null,
    )
    .sort((a, b) => a.at - b.at);

  if (series.length === 0) {
    return (
      <figure className={`page-card m-0 ${className}`}>
        <div className="eyebrow">
          <span className="eyebrow-line" aria-hidden /> NET ASSET VALUE
        </div>
        <figcaption className="mt-3 font-display text-[19px] tracking-[-0.04em]">
          Nothing sampled yet
        </figcaption>
        <p className="mt-3 max-w-[52ch] text-[12px] leading-relaxed text-fg-muted">
          The curve draws itself as the keeper samples the vault — one point per block it checks,
          and the first one lands when a session opens.
        </p>
      </figure>
    );
  }

  const base = unitsFloat(baseline);
  const last = series[series.length - 1];
  const first = series[0];

  // Compared against the baseline when there is one, because that is what the
  // contract pays on. Without a session, the first read is the only honest
  // reference the series has. Kept as the RAW string, not the float: the
  // direction, the caption and the footer all come off this, so there is one
  // reference and one arithmetic rather than a double's answer beside a
  // BigInt's. `base` is null exactly when `baseline` could not be parsed, and
  // the reference falls back to the first read with it.
  const referenceRaw = base !== null && baseline !== null ? baseline : first.raw;

  // Exact, because both ends are stored 6-decimal integers. Every figure in
  // this component's copy is formatted from this rather than from the doubles
  // above; `navDelta` returns null only for an unparseable pair, which the
  // filter and the fallback above have already ruled out.
  const deltaRaw = navDelta(referenceRaw, last.raw);

  // Three directions, not two. A `last.value >= reference` test painted a curve that
  // has not moved at all in the green that means "Up" everywhere else in this
  // product — a claim of a gain, made on a flat line. A zero change is neither
  // side, so it takes the muted stroke.
  //
  // Note what the neutral case does NOT say: the oracle settles on a strict
  // `navT1 > navT0`, so a session that closes exactly level pays the Down leg.
  // That is a fact about settlement, and the caption below states it in words
  // rather than smuggling it in as a colour.
  const deltaSign = deltaRaw === null ? null : BigInt(deltaRaw);
  const direction =
    deltaSign === null ? "level" : deltaSign > 0n ? "up" : deltaSign < 0n ? "down" : "level";
  const stroke =
    direction === "up"
      ? "var(--color-up)"
      : direction === "down"
        ? "var(--color-down)"
        : "var(--color-fg-muted)";

  const w = 720;
  const h = 200;
  const padL = 60;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const values = base === null ? series.map((s) => s.value) : [...series.map((s) => s.value), base];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A vault that has not traded yet is a flat line, and a flat line divided by
  // a zero span is every point at NaN. Give it a band to sit in the middle of.
  const spanV = hi - lo;
  const padV = spanV === 0 ? Math.max(Math.abs(hi) * 0.01, 0.5) : spanV * 0.12;
  lo -= padV;
  hi += padV;

  const t0 = first.at;
  const spanT = last.at - t0;
  const x = (p: { at: number }, i: number) =>
    spanT > 0
      ? padL + ((p.at - t0) / spanT) * innerW
      : padL + (series.length > 1 ? i / (series.length - 1) : 1) * innerW;
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * innerH;

  const line = series.map((p, i) => `${x(p, i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${padL},${(padT + innerH).toFixed(1)} ${line} ${x(last, series.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)}`;

  const fromBlock = blockLabel(first.block);
  const toBlock = blockLabel(last.block);

  return (
    <figure className={`page-card m-0 ${className}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> NET ASSET VALUE
          </div>
          <figcaption className="mt-3 font-display text-[19px] tracking-[-0.04em]">
            {series.length} read{series.length === 1 ? "" : "s"} of{" "}
            <span className="mono text-fg-muted">nav()</span>
          </figcaption>
        </div>
        {/* The last POINT ON THIS CURVE, and it says so. Every one of these is
            a stored sample, written when an agent registers and when a session
            closes — so the newest can be hours old, and a bare figure here read
            as the vault's current state. The live reading, when the page has
            one, is the 40px number at the top of the profile. */}
        <div className="text-right">
          <p
            className={`num font-mono text-[15px] font-semibold ${
              direction === "up" ? "positive" : direction === "down" ? "negative" : "text-fg-muted"
            }`}
          >
            {usdc(last.raw)} tUSDC
          </p>
          <p className="num mt-1 font-mono text-[9px] text-fg-subtle">last sample · {tick(last.at)}</p>
        </div>
      </div>

      <svg
        className="mt-5 w-full"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={
          `Vault NAV over ${series.length} reads, from ${usdc(first.raw)} to ${usdc(last.raw)} tUSDC` +
          (base === null ? "." : `, against a session baseline of ${usdc(baseline)}.`)
        }
      >
        {[0, 0.5, 1].map((t) => (
          <line
            key={t}
            x1={padL}
            x2={w - padR}
            y1={padT + t * innerH}
            y2={padT + t * innerH}
            stroke="var(--color-line-soft)"
            strokeWidth="1"
          />
        ))}

        <polygon points={area} fill={stroke} fillOpacity="0.1" />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {base !== null && (
          <>
            <line
              x1={padL}
              x2={w - padR}
              y1={y(base)}
              y2={y(base)}
              stroke="var(--color-fg-muted)"
              strokeWidth="1"
              strokeDasharray="4 3"
              opacity="0.75"
            />
            <text
              x={w - padR}
              y={y(base) - 5}
              textAnchor="end"
              fill="var(--color-fg-subtle)"
              fontSize="10"
              fontFamily="var(--font-sans)"
            >
              {baselineLabel} {usdc(baseline)}
            </text>
          </>
        )}

        <circle cx={x(last, series.length - 1)} cy={y(last.value)} r="3.5" fill={stroke} />

        {[hi, lo].map((v, i) => (
          <text
            key={v}
            x={padL - 8}
            y={i === 0 ? padT + 4 : padT + innerH + 4}
            textAnchor="end"
            fill="var(--color-fg-subtle)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {v.toFixed(2)}
          </text>
        ))}

        <text x={padL} y={h - 8} fill="var(--color-fg-subtle)" fontSize="10" fontFamily="var(--font-sans)">
          {tick(first.at)}
        </text>
        <text x={w - padR} y={h - 8} textAnchor="end" fill="var(--color-fg-subtle)" fontSize="10" fontFamily="var(--font-sans)">
          {tick(last.at)}
        </text>
      </svg>

      {/* "at the last sample", never "right now".

          This said "Above it by 4.20 tUSDC right now", and the curve it
          describes is made of stored samples written at registration and at
          session close — so on a live session the sentence was reporting a
          position the agent had held some time ago as its position at this
          moment. The distance is real; the tense was not. */}
      <p className="mt-4 text-[11px] leading-relaxed text-fg-muted">
        {caption ??
          (base === null
            ? "Each point is one read of the vault's own nav(). The line moves only when a DreamDEX call settles collateral into or out of the vault."
            : direction === "level"
              ? `The last sample sits exactly on the opening NAV. The oracle settles on a strict navT1 > navT0, so closing level pays Down.`
              : `The dashed line is the NAV this session opened at. The last sample is ${
                  deltaRaw === null ? "—" : usdc(deltaRaw.replace(/^-/, ""))
                } tUSDC ${
                  direction === "up" ? "above" : "below"
                } it — the meta-market pays the ${
                  direction === "up" ? "Up" : "Down"
                } side if the session closes there.`)}
      </p>

      {/* THE LINE THAT PRINTED "baseline 100.01 · latest 100.02" FOR ONE
          NUMBER. `usdc` TRUNCATES the raw 6-decimal integer and the old
          `toFixed(2)` ROUNDED a double built from it, so 100.015000 came out
          as two figures a cent apart on the same line. Both come off `usdc`
          now — and where the two reads are the same stored integer, the line
          says so outright rather than printing one number twice and leaving a
          reader to wonder what they missed. The distance between them is in
          the sentence above and is not repeated here. */}
      <p className="num mt-2 font-mono text-[10px] text-fg-subtle">
        {base !== null && deltaRaw === "0" ? (
          <>baseline and last sample are the same read · {usdc(baseline)} tUSDC</>
        ) : (
          <>
            {base !== null && <>baseline {usdc(baseline)} · </>}
            last sample {usdc(last.raw)} tUSDC
          </>
        )}{" "}
        at {tick(last.at)}
        {fromBlock && toBlock && (
          <>
            {" · "}
            block {fromBlock} → {toBlock}
          </>
        )}
      </p>
    </figure>
  );
}
