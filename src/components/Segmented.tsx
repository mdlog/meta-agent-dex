"use client";

/**
 * A segmented control: one choice from a short, fixed set.
 *
 * `mode="pressed"` is a group of toggle buttons (filters, sort). `mode="tabs"`
 * is a tablist, for when the choice swaps the content beneath it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  mode = "pressed",
  grow = false,
  className = "",
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  mode?: "pressed" | "tabs";
  grow?: boolean;
  className?: string;
}) {
  return (
    <div
      role={mode === "tabs" ? "tablist" : "group"}
      aria-label={label}
      className={`segmented ${grow ? "segmented-grow" : ""} ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={mode === "tabs" ? "tab" : undefined}
            aria-selected={mode === "tabs" ? active : undefined}
            aria-pressed={mode === "pressed" ? active : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled segmented control, for filter rows. */
export function SegmentedField<T extends string>(
  props: Parameters<typeof Segmented<T>>[0] & { caption: string },
) {
  const { caption, ...rest } = props;
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs font-medium text-fg-muted">{caption}</span>
      <Segmented {...rest} />
    </div>
  );
}
