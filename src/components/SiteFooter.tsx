import Link from "next/link";
import { ExternalLink } from "@/components/Primitives";

/**
 * The page footer, inside the shell's main panel so it sits at the end of the
 * content column rather than below a full-height rail.
 *
 * The testnet disclaimer is load-bearing and its wording is unchanged: a
 * judge reading this page has to be told, without hunting, that every balance
 * on screen is test value.
 */
export function SiteFooter() {
  return (
    <footer className="page-footer">
      <div>
        <p>
          Meta-Agent DEX runs on Somnia Shannon testnet. Every balance and position is test value with no
          monetary worth. This is an education and competition product, not financial advice.
        </p>
        <p className="footer-sub">
          Built on DreamDEX Event Contracts through <span className="mono">@somnia-chain/markets-sdk</span>.
        </p>
      </div>

      <nav aria-label="Legal and reference" className="footer-right">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <ExternalLink href="https://shannon-explorer.somnia.network">Explorer</ExternalLink>
        <ExternalLink href="https://docs.dreamdex.io/developers/event-contracts">DreamDEX docs</ExternalLink>
      </nav>
    </footer>
  );
}
