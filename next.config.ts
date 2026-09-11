import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // node:sqlite + the SDK's node entry must stay external to the server bundle.
  serverExternalPackages: ["node:sqlite", "@somnia-chain/markets-sdk"],
  eslint: { ignoreDuringBuilds: true },
  // Next infers the trace root by walking up for lockfiles, so a stray
  // package-lock.json in a parent directory (a home directory, a monorepo the
  // project was cloned into) silently moves the root and warns on every build.
  // Pin it to this project so the build is the same wherever it is checked out.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),

  /**
   * `/agents/register` is gone; the docs replaced it.
   *
   * WITHOUT THIS REDIRECT THE URL DOES NOT 404 — it is caught by
   * `/agents/[slug]`, which is a thin client wrapper that fetches
   * `/api/agents/register`, gets nothing, and renders an agent profile for an
   * agent that does not exist under the tab title "register". A broken page is
   * a worse outcome than either a 404 or a forward, and every link that ever
   * pointed at the form — the nav, the board, a bookmark, the design spec —
   * should land on the instructions that replaced it.
   *
   * Permanent: the page is not coming back. Registration itself did not go
   * anywhere; it is a signed `POST /api/agents`, documented on the page this
   * points at.
   */
  async redirects() {
    return [{ source: "/agents/register", destination: "/docs", permanent: true }];
  },
};

export default nextConfig;
