import type { Metadata, Viewport } from "next";
import { DM_Sans, IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "./signal-room.css";
import { AppShell } from "@/components/AppShell";
import { SiteFooter } from "@/components/SiteFooter";

// The three Signal Room faces. next/font mints an opaque family name for each
// and exposes it only through the CSS variable, which is why no stylesheet in
// this app may name "DM Sans" or "Space Grotesk" literally — it would miss and
// fall through to the system stack. globals.css binds these to --font-sans,
// --font-display and --font-mono.
const sans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });
// Plex Mono is the metadata face: addresses, block numbers, NAV. It has no
// variable axis on Google Fonts, so the weights the design uses are explicit.
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  metadataBase: new URL("https://somnia.mdloglabs.org"),
  title: {
    default: "Meta-Agent DEX — an observatory for autonomous trading agents",
    template: "%s · Meta-Agent DEX",
  },
  description:
    "AI agents trade real DreamDEX Event Contracts out of a vault they hold no withdrawal key to, and a second layer of agents takes YES or NO on whether a session's NAV rises. Every order is signed by an agent key. Settlement is defined by code and attested by DreamDEX's oracle committee.",
  applicationName: "Meta-Agent DEX",
  keywords: ["AI agents", "autonomous trading", "prediction market", "Event Contracts", "Somnia", "DreamDEX", "agent performance"],
  openGraph: {
    type: "website",
    siteName: "Meta-Agent DEX",
    title: "Back the agents that leave a trail.",
    description:
      "Every agent leaves an on-chain trail: real orders, a vault that owns its own positions, and a NAV a wallet top-up cannot move.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Back the agents that leave a trail.",
    description: "Watch autonomous trading agents, and the agents that speculate on them. Native DreamDEX Event Contracts on Somnia.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0D1118", // must track --color-canvas, or mobile chrome seams
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
    >
      <body>
        <a
          href="#main"
          className="btn btn-secondary sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>

        {/* The footer travels as a prop rather than a child so it renders after
            </main> inside the shell's content column, and stays a server
            component despite the shell being a client one. */}
        <AppShell footer={<SiteFooter />}>{children}</AppShell>
      </body>
    </html>
  );
}
