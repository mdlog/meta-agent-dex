import { getAdapter } from "@/lib/dreamdex";
import { json, fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Same reasoning as the list route: `force-dynamic` binds Next, not the browser. */
const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const adapter = getAdapter();

  const market = await adapter.getMarket(id);
  if (!market) return fail("That Event Contract is not on the module.", { status: 404, code: "market_unknown" });

  // The book is a separate, slower chain read — a failed book must not blank
  // the whole page, so it degrades to null and the UI shows "no quote".
  const [book, onchain] = await Promise.all([
    adapter.getOrderBook(id, 8).catch(() => null),
    adapter.getOnchainState(id).catch(() => null),
  ]);

  return json({ market, book, onchain, capturedAt: Date.now() }, { headers: NO_STORE });
}
