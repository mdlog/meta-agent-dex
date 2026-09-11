import Link from "next/link";
import type { ArenaMarket } from "@/lib/domain/types";
import { ProbabilityRail } from "./ProbabilityRail";
import { basisNote, downText, upText } from "./priceFormat";
import { StatusPill, SimulatedPill } from "./StatusPill";
import { Countdown } from "./Countdown";
import { OutcomeTag } from "./Primitives";
import { Clock, ICON_WEIGHT } from "./icons";

/**
 * One Event Contract, as a card.
 *
 * Header names the contract, the question says what it settles on, the rail
 * shows what the book has said, and the two readouts beneath it are the same
 * reading from both sides. The footer pins to the floor so a grid of cards
 * lines up whatever the question's length.
 *
 * THE TWO READOUTS ARE NOT ALWAYS A SPLIT. They read "62% / 38%" only when both
 * sides of the book rest; on a one-sided book they read "≥ 14%" and "≤ 86%",
 * because that is the whole of what one resting order says. The card used to
 * print the confident split either way — measured on the live board, 6 of 8
 * cards were doing it — which is a probability the market never quoted, sitting
 * in the same type as the ones it did. `priceBasis` carries the difference all
 * the way from the adapter so this card never has to guess it.
 */
export function MarketCard({ market, href }: { market: ArenaMarket; href?: string }) {
  const p = market.upProbability;
  const basis = market.priceBasis;

  return (
    <Link href={href ?? `/market/${market.id}`} className="card card-hover group flex h-full flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {market.asset}
            {market.interval && <span className="ml-1.5 font-normal text-fg-muted">{market.interval}</span>}
          </p>
          <p className="mono mt-0.5 truncate text-xs text-fg-subtle">{market.symbol}</p>
        </div>
        {/* Provenance sits immediately left of status, because "Trading" is
            the claim it qualifies. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {market.simulated && <SimulatedPill />}
          <StatusPill status={market.status} />
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[39px] text-sm leading-snug text-fg-muted">{market.question}</p>

      <div className="mt-4">
        <ProbabilityRail
          probability={p}
          basis={basis}
          bestBid={market.bestBid}
          bestAsk={market.bestAsk}
          height={8}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5">
          <OutcomeTag outcome="up" />
          <span className="num font-semibold">{upText(p, basis)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="num font-semibold">{downText(p, basis)}</span>
          <OutcomeTag outcome="down" />
        </span>
      </div>

      {/* mt-auto pins the footer to the card floor regardless of what is above. */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-line-soft pt-3 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <Clock size={13} weight={ICON_WEIGHT} aria-hidden />
          <Countdown to={market.expiry} className="text-fg-muted" />
        </span>
        {/* The spread is only a spread when there are two sides to subtract.
            Everywhere else this names the basis instead — "bid only · a floor"
            over a card whose figures carry a ≥ sign, so the two agree. */}
        <span className={`num truncate ${market.simulated ? "text-danger" : ""}`}>
          {market.simulated
            ? "generated locally"
            : market.spread !== null
              ? `spread ${market.spread.toFixed(3)}`
              : basisNote(basis)}
        </span>
      </div>
    </Link>
  );
}
