import { getAdapter } from "@/lib/dreamdex";
import { json, fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * `force-dynamic` only tells Next not to cache this. It says nothing to the
 * browser, and a 200 with no cache directive is heuristically cacheable — which
 * on a venue whose shortest window is 60 seconds means a poll that returns the
 * same contracts it returned a minute ago, from disk, without a chain read.
 */
const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = url.searchParams.get("asset") ?? undefined;
  // The binary module serves Somnia's price series and this project's BOTNAV
  // session contracts from one listing. The default stays the whole module —
  // an API that quietly hid half of it would misreport the chain — and every
  // row now carries `venue`, so a mixed page says which is which. The product's
  // trading board asks for `?venue=somnia`.
  const venueParam = url.searchParams.get("venue");
  if (venueParam && venueParam !== "all" && venueParam !== "somnia" && venueParam !== "meta") {
    return fail("Unknown venue.", {
      status: 400,
      code: "bad_venue",
      nextStep: 'venue must be "somnia", "meta" or "all".',
    });
  }
  const venue = venueParam === "somnia" || venueParam === "meta" ? venueParam : undefined;
  const intervalSec = url.searchParams.get("intervalSec");
  const withinSec = url.searchParams.get("withinSec");
  const limit = url.searchParams.get("limit");

  try {
    const markets = await getAdapter().listMarkets({
      venue,
      asset: asset && asset !== "all" ? asset : undefined,
      intervalSec: intervalSec ? Number(intervalSec) : undefined,
      withinSec: withinSec ? Number(withinSec) : undefined,
      limit: limit ? Math.min(60, Number(limit)) : 24,
    });
    // `capturedAt` is what makes a repeated read falsifiable: a client polling
    // this route can tell a fresh answer from a replayed one without trusting
    // any header.
    return json({ markets, count: markets.length, capturedAt: Date.now() }, { headers: NO_STORE });
  } catch (e) {
    return fail("Could not load Event Contracts.", {
      status: 502,
      code: "markets_unavailable",
      nextStep: (e as Error).message.slice(0, 160),
    });
  }
}
