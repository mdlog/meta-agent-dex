import Link from "next/link";
import type { ReactNode } from "react";
import type { Outcome } from "@/lib/domain/types";
import { ArrowLeft, ArrowUpRight, CaretDown, CaretUp, ICON_WEIGHT } from "./icons";

/** Back navigation. The arrow slides on hover so the affordance is felt. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
    >
      <ArrowLeft
        size={14}
        weight={ICON_WEIGHT}
        className="transition-transform duration-150 group-hover:-translate-x-0.5"
        aria-hidden
      />
      {children}
    </Link>
  );
}

/**
 * A link that leaves the app. The icon is the convention that says so, and
 * carries an accessible label so it is announced rather than skipped.
 */
export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`group inline-flex items-center gap-1 transition-colors ${className}`}
    >
      {children}
      <ArrowUpRight
        size={12}
        weight={ICON_WEIGHT}
        className="shrink-0 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px"
        aria-label="opens in a new tab"
      />
    </a>
  );
}

/**
 * Up or Down, as a tag.
 *
 * Direction is never carried by colour alone: the caret is a second, redundant
 * channel, which is what PRD 10.3 asks for and what makes the tag legible to a
 * colour-blind reader.
 */
export function OutcomeTag({
  outcome,
  size = "sm",
  className = "",
}: {
  outcome: Outcome;
  size?: "sm" | "md";
  className?: string;
}) {
  const up = outcome === "up";
  const Caret = up ? CaretUp : CaretDown;
  const px = size === "md" ? 14 : 12;

  return (
    <span
      className={`inline-flex items-center gap-0.5 font-medium ${up ? "text-up" : "text-down"} ${className}`}
    >
      <Caret size={px} weight="fill" aria-hidden />
      {up ? "Up" : "Down"}
    </span>
  );
}

/** Composed empty state: what is missing, why, and what to do about it. */
export function EmptyState({
  title,
  children,
  action,
  tone = "neutral",
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={`card flex flex-col items-center px-6 py-12 text-center ${
        tone === "danger" ? "border-danger/40" : ""
      }`}
      role={tone === "danger" ? "alert" : undefined}
    >
      <div
        aria-hidden
        className={`h-1.5 w-20 rounded-full ${tone === "danger" ? "bg-danger/40" : "bg-card-3"}`}
      />
      <p className="mt-5 text-base font-semibold">{title}</p>
      {children && <p className="mt-2 max-w-[46ch] text-sm text-fg-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
