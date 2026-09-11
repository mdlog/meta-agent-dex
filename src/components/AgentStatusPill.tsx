import type { AgentSessionStatus } from "@/lib/domain/types";

/**
 * Session state, as the Signal Room pill.
 *
 * Colour is never the whole message: every one of these carries its own word,
 * so a reader who cannot separate lime from amber still gets the state. Three
 * of the six are the market vocabulary from `/explore` — Trading, Settling,
 * Resolved — because a session and the Event Contract written against it sit at
 * the same point of the same lifecycle.
 *
 * `finalized` is the state DreamDEX has no word for: the oracle is frozen, so
 * the answer exists and can never be restated, but the committee has not paid
 * the meta-market out yet. "Answered" is that, precisely — it shares cyan with
 * Resolved because both mean "the number is fixed", and the label carries the
 * difference.
 *
 * `void` is a real state and not an error. It gets the hollow ring rather than
 * the danger red the old pill wore: both sides were refunded, which is neither
 * a win nor a failure, and nothing rendering it may use `role="alert"`.
 */
const STYLES: Record<AgentSessionStatus, { label: string; modifier: string; live?: boolean }> = {
  pending: { label: "Opens soon", modifier: "" },
  open: { label: "Trading", modifier: "is-live", live: true },
  closing: { label: "Settling", modifier: "is-settling" },
  finalized: { label: "Answered", modifier: "is-settled" },
  settled: { label: "Resolved", modifier: "is-settled" },
  void: { label: "Voided", modifier: "is-void" },
};

/**
 * `rounded-full` is not decoration. The ported `.status-pill .status-dot` rule
 * sets the dot's size and fill but no radius — the base `.status-dot` shape
 * lives in the shell's own stylesheet, which only styles the topbar's copy —
 * so an unmodified dot renders as a 5px square. The utility supplies the one
 * missing property from this layer rather than editing another layer's file.
 */
export function AgentStatusPill({
  status,
  className = "",
}: {
  status: AgentSessionStatus;
  className?: string;
}) {
  const s = STYLES[status];
  return (
    <span className={`status-pill ${s.modifier} ${className}`}>
      <span className={`status-dot rounded-full ${s.live ? "live-dot" : ""}`} aria-hidden />
      {s.label}
    </span>
  );
}

/**
 * The same six states in the Signal Room's own language.
 *
 * It reads the labels out of {@link STYLES} rather than restating them, because
 * two pills that disagree about what `finalized` is called is exactly the drift
 * this file exists to prevent — the visual vocabulary differs between the badge
 * system and the ported design, the *words* must not.
 *
 * `void` gets a real state of its own (a hollow ring, muted) instead of the
 * error treatment. A committee that could not agree refunded both sides; that
 * is an outcome, and 7 of the first 10 contract-sourced markets on Shannon
 * reached it. A UI that renders it as a fault would be lying about the venue.
 */
const SIGNAL_TONE: Record<AgentSessionStatus, string> = {
  pending: "",
  open: "is-live",
  closing: "is-settling",
  finalized: "is-settled",
  settled: "is-settled",
  void: "is-void",
};

/** The one place a session state is put into words. Exported so a panel that
 *  cannot host a pill still says what the pill would have said. */
export function sessionLabel(status: AgentSessionStatus): string {
  return STYLES[status].label;
}

export function SessionSignalPill({ status }: { status: AgentSessionStatus | null }) {
  // No live session is not a session state, so it has no entry above. It is
  // still worth saying out loud: an agent between sessions is idle, not broken.
  if (status === null) return <span className="status-pill">Idle</span>;
  return (
    <span className={`status-pill ${SIGNAL_TONE[status]}`}>
      {/* Same reason as above: nothing in either stylesheet rounds a bare
          `.status-dot`, so without this it is a square. */}
      <span className="status-dot rounded-full" aria-hidden />
      {STYLES[status].label}
    </span>
  );
}

/**
 * The session lifecycle, drawn.
 *
 * Five stops, in the order the chain enforces them: the vault session opens,
 * the meta-market mints and the agent trades, positions are redeemed, the
 * oracle freezes its answer, DreamDEX pays. A void session replaces the last
 * stop rather than stopping short of it — the committee did answer, it answered
 * "no agreement", and both sides were refunded.
 */
const FLOW: { status: AgentSessionStatus; label: string }[] = [
  { status: "pending", label: "Opened" },
  { status: "open", label: "Trading" },
  { status: "closing", label: "Redeeming" },
  { status: "finalized", label: "Answered" },
  { status: "settled", label: "Settled" },
];

export function AgentSessionSteps({
  status,
  className = "",
}: {
  status: AgentSessionStatus;
  className?: string;
}) {
  const voided = status === "void";
  // A voided session got as far as redeeming — the oracle simply produced no
  // usable answer — so the first three stops are genuinely behind it.
  const currentIndex = voided ? FLOW.length - 1 : FLOW.findIndex((s) => s.status === status);
  const steps = voided ? [...FLOW.slice(0, FLOW.length - 1), { status, label: "Voided" }] : FLOW;

  return (
    <ol className={`stepper ${className}`} aria-label="Session lifecycle">
      {steps.map((step, i) => (
        <li
          key={step.label}
          className="step"
          data-done={i < currentIndex ? "true" : undefined}
          data-current={i === currentIndex ? "true" : undefined}
          aria-current={i === currentIndex ? "step" : undefined}
        >
          <span className="step__dot" aria-hidden />
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * Whether the runner is alive.
 *
 * The heartbeat is the agent's own claim that its loop is turning; a session
 * can be open on chain while nothing is running behind it, and that gap is
 * worth showing rather than smoothing over. Rendered only after a fetch
 * resolves, so reading the clock here cannot desynchronise a server render.
 */
const HEARTBEAT_FRESH_MS = 120_000;

export function AgentHeartbeatPill({ lastHeartbeat }: { lastHeartbeat: number | null }) {
  if (lastHeartbeat === null) {
    return (
      <span className="status-pill" title="This agent's runner has never checked in.">
        <span className="status-dot rounded-full" aria-hidden />
        No heartbeat
      </span>
    );
  }

  const age = Date.now() - lastHeartbeat;
  if (age <= HEARTBEAT_FRESH_MS) {
    return (
      <span className="status-pill is-live">
        <span className="status-dot live-dot rounded-full" aria-hidden />
        Runner online
      </span>
    );
  }

  const minutes = Math.floor(age / 60_000);
  return (
    <span className="status-pill is-settling">
      <span className="status-dot rounded-full" aria-hidden />
      Runner quiet {minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`}
    </span>
  );
}

/**
 * A stable categorical accent per agent.
 *
 * The design tints avatars and market icons across four hues. They identify —
 * they never encode performance, which is why up/down never appear here — so
 * the only requirement is that one agent keeps one colour across the board, its
 * profile and its session cards. Derived from the slug rather than from the row
 * index, which changes every time the ranking does.
 */
const ACCENTS = ["lime", "cyan", "violet", "amber"] as const;

export type AgentAccent = (typeof ACCENTS)[number];

export function agentAccent(seed: string): AgentAccent {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length];
}
