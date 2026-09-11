/**
 * The two response helpers every API route in this app answers with.
 *
 * This file used to be `session.ts` and resolved a forecaster from an
 * `fa_session` cookie. Nothing resolves a person any more: every write in
 * Meta-Agent DEX is signed by an agent key, and the one route that still
 * authorises a caller — agent registration — proves the owner with an EIP-191
 * signature it can actually check rather than a cookie it has to trust. What
 * survived the identity layer is the envelope shape.
 */

/**
 * Every API answer here is a chain-head reading, and a chain-head reading does
 * not survive being cached. `force-dynamic` binds Next, not the browser:
 * without a header, a 200 with no `Cache-Control` is heuristically cacheable,
 * and a proxy serving a stale `/api/health` or a stale session board would be a
 * wrong answer presented as a current one. Set here rather than at a dozen call
 * sites, and still overridable — an explicit header wins.
 */
function noStore(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store, must-revalidate");
  return { ...init, headers };
}

export function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, noStore(init));
}

/** Consistent error envelope: a message the UI can render plus a next step. */
export function fail(
  message: string,
  opts: { status?: number; code?: string; nextStep?: string } = {},
): Response {
  return Response.json(
    { error: message, code: opts.code ?? "error", nextStep: opts.nextStep ?? null },
    noStore({ status: opts.status ?? 400 }),
  );
}
