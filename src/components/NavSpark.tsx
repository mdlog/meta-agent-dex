/**
 * The NAV curve at two sizes, drawn from real samples only.
 *
 * The Signal Room design hard-coded one decorative squiggle and reused it for
 * every agent, which on a performance board is not decoration — it is a claim
 * about a shape nobody measured. These draw `agent_nav_points`, each one a read
 * of `BotVault.nav()` at a block, and draw nothing at all when there are fewer
 * than two of them. A flat line would read as "NAV did not move", which is a
 * different fact from "the vault has not been sampled yet".
 *
 * Colour follows the product's one direction convention, the same rule
 * {@link AgentNavChart} applies: green above the reference, red below, and
 * MUTED when the two are equal — a change of nothing is not a direction. The
 * design's per-agent lime/cyan/violet/amber ramp is identity, and it stays on
 * the avatars and market icons where it cannot be mistaken for a direction.
 *
 * The two exports scale differently on purpose. {@link NavField} fills a panel
 * about ONE session and is scaled to that session's own baseline, which is what
 * its meta-market settles on. {@link NavSpark} sits in a leaderboard column and
 * is therefore read across rows, so it is drawn to a scale shared by the whole
 * board — see the note above it for what that replaced.
 */

import { unitsFloat } from "./agentFormat";

export interface NavPoint {
  at: number;
  /** Raw 6-decimal collateral units, as they came off chain. */
  nav: string;
}

interface Geometry {
  line: string;
  area: string;
  /** Y of the settlement baseline in viewBox units, when one was given and it is in frame. */
  baselineY: number | null;
  /**
   * Which side of the reference the series ends on — three answers, not two.
   *
   * This was a `rose: boolean` computed with `>=`, which painted a series that
   * ended exactly on its reference in the green that means "up" everywhere else
   * in the product: a gain claimed about a line that did not move.
   */
  direction: "up" | "down" | "level";
}

/**
 * Project samples onto a viewBox.
 *
 * The vertical range includes the baseline when there is one, because the whole
 * point of the picture is which side of that line the curve ends on — a scale
 * fitted to the curve alone could push the baseline off the panel and lose the
 * only comparison that settles the market.
 */
function geometry(
  points: readonly NavPoint[],
  baseline: string | null,
  w: number,
  h: number,
  pad: number,
): Geometry | null {
  const values = points
    .map((p) => unitsFloat(p.nav))
    .filter((v): v is number => v !== null);
  if (values.length < 2) return null;

  const base = unitsFloat(baseline);
  const all = base === null ? values : [...values, base];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  // A vault that has not moved between reads would divide by zero. Opening a
  // band around the value keeps the curve on the centre line instead.
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }

  const last = values[values.length - 1];
  const reference = base ?? values[0];

  const inner = h - pad * 2;
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * inner;
  const x = (i: number) => (i / (values.length - 1)) * w;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;

  return {
    line,
    area,
    baselineY: base === null ? null : y(base),
    // Measured against the baseline when the session has one, because that is
    // the number the meta-market pays on; against the first read otherwise.
    direction: last > reference ? "up" : last < reference ? "down" : "level",
  };
}

/** A usable series, in tUSDC, in the order it was sampled. */
function readings(points: readonly NavPoint[]): number[] {
  return points.map((p) => unitsFloat(p.nav)).filter((v): v is number => v !== null);
}

/**
 * The half-height every spark on the board is drawn to, in tUSDC.
 *
 * The largest movement any row shows, so the biggest mover fills its box and
 * everything else is measured against it. Computed from ALL rows rather than
 * the visible ones on purpose: a scale that changed under a search box would
 * make the same agent's picture mean two different things on two keystrokes.
 */
export function navSparkDomain(series: readonly (readonly NavPoint[])[]): number {
  let max = 0;
  for (const points of series) {
    const values = readings(points);
    if (values.length < 2) continue;
    const first = values[0];
    for (const v of values) max = Math.max(max, Math.abs(v - first));
  }
  return max;
}

/** How many `nav()` samples a row actually has. The cell prints it. */
export function navSampleCount(points: readonly NavPoint[]): number {
  return readings(points).length;
}

/**
 * A leaderboard-cell chart, at the design's exact 118×40 slot.
 *
 * Renders an empty box rather than nothing when there is no series: the cell
 * keeps its rhythm across rows, and an empty box says less than a drawn line
 * that was never measured.
 *
 * WHY THIS IS NOT A SPARKLINE ANY MORE. It was, and it min-max normalised each
 * agent's series on its own, which made every curve fill the same 40px box
 * whatever it measured: an agent whose record is 0.00 and an agent whose record
 * is −49.91 produced byte-identical paths (M0.00 4.00 L59.00 4.00 L118.00
 * 36.00) and always shared both endpoints. In a column headed "Net NAV change",
 * read down the page, that is a picture asserting two things it cannot support
 * — a magnitude and a comparison between rows — while carrying neither.
 *
 * So the geometry changed on both axes. Vertically every row is plotted as its
 * CHANGE FROM THE FIRST SAMPLE IT WAS GIVEN against a zero line at mid-height,
 * on a scale shared by the whole board ({@link navSparkDomain}) — so a flat
 * record sits on the line, a −49.91 record hangs well below it, and one pixel
 * means the same number of tUSDC in every row. Callers window the series
 * (`slice(-SPARK_POINTS)`), which is why the caption below the board says "the
 * first sample shown" rather than "the agent's first read". Horizontally the
 * samples are evenly spaced, which is the honest treatment of a series whose x
 * is "the order the keeper wrote them" and not a clock.
 *
 * AND TWO POINTS ARE NOT A CURVE. Most agents have exactly two `nav()` samples,
 * because rows are written at registration and at session close and nowhere
 * else. Drawing a solid stroke between them claims a path through time that
 * nothing measured, so two samples are drawn as two dots with a dashed
 * connector — an interpolation, and it looks like one. The cell prints the
 * sample count beside it, so the reader is told and not left to infer it from
 * a stroke pattern.
 */
export function NavSpark({
  points,
  domain,
  className = "",
}: {
  points: readonly NavPoint[];
  /**
   * Half-height in tUSDC, shared across the board — from
   * {@link navSparkDomain}. Required, and deliberately not defaulted: a default
   * would be a private scale, which is the bug this parameter exists to end.
   */
  domain: number;
  className?: string;
}) {
  const w = 118;
  const h = 40;
  const pad = 4;
  const mid = h / 2;

  const values = readings(points);
  if (values.length < 2)
    return <svg aria-hidden="true" className={`h-10 w-[118px] ${className}`} viewBox="0 0 118 40" />;

  // Every row starts at its own first read, so the picture is the movement and
  // not the level: a 200 tUSDC vault and a 10 tUSDC vault are comparable in
  // what they DID, and not at all in what they hold.
  const first = values[0];
  const deltas = values.map((v) => v - first);
  const last = deltas[deltas.length - 1];

  // A board on which nothing has moved has no scale to share. One tUSDC keeps
  // every row flat on the line, which is exactly what happened.
  const half = domain > 1e-9 ? domain : 1;
  const y = (d: number) => mid - Math.max(-1, Math.min(1, d / half)) * (mid - pad);
  const x = (i: number) => (i / (values.length - 1)) * w;

  // Three directions, not two: a zero change is neither up nor down, and
  // painting it green or red is a claim about a line that did not move.
  const stroke =
    last > 0 ? "var(--color-up)" : last < 0 ? "var(--color-down)" : "var(--color-fg-muted)";

  const path = deltas.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(d).toFixed(2)}`).join(" ");
  const interpolated = values.length === 2;

  return (
    <svg aria-hidden="true" className={`h-10 w-[118px] ${className}`} viewBox="0 0 118 40" fill="none">
      {/* Zero change. The one line every row shares, and the reason a flat
          record and a losing one no longer look alike. */}
      <line
        x1="0"
        x2={w}
        y1={mid}
        y2={mid}
        stroke="var(--color-line)"
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <path
        d={path}
        stroke={stroke}
        strokeWidth={interpolated ? 1.4 : 2.2}
        strokeDasharray={interpolated ? "3 3" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {interpolated &&
        deltas.map((d, i) => (
          <circle key={i} cx={x(i)} cy={y(d)} r="2.4" fill={stroke} />
        ))}
    </svg>
  );
}

/**
 * The same series filling a panel, with the session's opening NAV as a dashed
 * rule. It replaces one of the four illustrations the design referenced and
 * this repo does not have — and it is a better panel than the missing PNG was
 * going to be, because it is the market's own settlement condition drawn to
 * scale: above the dashes YES pays, below them NO does.
 *
 * `preserveAspectRatio="none"` lets the curve fill an arbitrary panel;
 * `vector-effect` keeps the stroke from stretching with it.
 */
export function NavField({
  points,
  baseline = null,
  label,
  neutral = false,
}: {
  points: readonly NavPoint[];
  baseline?: string | null;
  label: string;
  /**
   * Draw in the neutral tone instead of up-green / down-red.
   *
   * For a session that is still open, where the samples are `nav()` and
   * `nav()` is cash: an agent holding outcome tokens plots below its own
   * settlement baseline while doing exactly what it was funded to do, and a
   * red curve there is the same false loss as a red "Change −90.00". Green and
   * red are earned once `redeemAll()` has converted the positions back.
   */
  neutral?: boolean;
}) {
  const g = geometry(points, baseline, 300, 200, 26);
  if (g === null) return null;

  const stroke =
    neutral || g.direction === "level"
      ? "var(--color-fg-muted)"
      : g.direction === "up"
        ? "var(--color-up)"
        : "var(--color-down)";
  return (
    <svg viewBox="0 0 300 200" preserveAspectRatio="none" fill="none" role="img" aria-label={label}>
      <path d={g.area} fill={stroke} fillOpacity="0.1" />
      {g.baselineY !== null && (
        <line
          x1="0"
          x2="300"
          y1={g.baselineY}
          y2={g.baselineY}
          stroke="var(--color-fg-subtle)"
          strokeWidth="1"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path d={g.line} stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
