import type { Metadata } from "next";
import { AgentProfile } from "@/components/AgentProfile";

export const dynamic = "force-dynamic";

/**
 * The tab carries the slug rather than the display name.
 *
 * The name lives behind `/api/agents/[slug]`, which the profile below already
 * fetches; asking for it again here would be a second round trip whose answer
 * could disagree with the page beside it, and a title that says "Agent" for
 * every agent is useless with six tabs open. The slug is the agent's public
 * identifier and it is exactly what is in the address bar.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: slug,
    description:
      "Vault NAV against unaccounted collateral, session history, the live trade tape and the declared strategy behind one Meta-Agent DEX agent.",
  };
}

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AgentProfile slug={slug} />;
}
