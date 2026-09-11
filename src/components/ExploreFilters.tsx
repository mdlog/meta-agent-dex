"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SegmentedField } from "./Segmented";

/** Filters update the URL, so a filtered board is a shareable link (FR-012). */
export function ExploreFilters({
  assets,
  cadences,
  current,
}: {
  assets: string[];
  cadences: { label: string; value: string }[];
  current: { asset?: string; intervalSec?: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `/explore?${qs}` : "/explore", { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <SegmentedField
        caption="Asset"
        label="Filter by asset"
        value={current.asset ?? ""}
        onChange={(v) => set("asset", v)}
        options={[{ label: "All", value: "" }, ...assets.map((a) => ({ label: a, value: a }))]}
      />
      <SegmentedField
        caption="Window"
        label="Filter by window"
        value={current.intervalSec ?? ""}
        onChange={(v) => set("intervalSec", v)}
        options={cadences}
      />
    </div>
  );
}
