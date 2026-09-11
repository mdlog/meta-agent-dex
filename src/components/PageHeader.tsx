import type { ReactNode } from "react";

/**
 * The page header every route opens with: title, one-paragraph description,
 * an optional source line (where this screen's numbers come from), and an
 * optional readout of the page's own live figure.
 */
export function PageHeader({
  title,
  lede,
  meta,
  readout,
  actions,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  /** Provenance: where the numbers on this screen come from. */
  meta?: ReactNode;
  /** The page's own live reading, set beside the title. */
  readout?: { label: ReactNode; value: ReactNode; note?: ReactNode };
  /** Buttons that act on the whole page. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl">{title}</h1>
          {lede && <p className="mt-2.5 max-w-[64ch] text-base text-fg-muted">{lede}</p>}
          {meta && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">{meta}</div>
          )}
        </div>

        {(readout || actions) && (
          <div className="flex shrink-0 items-start gap-3">
            {readout && (
              <div className="card min-w-[168px] px-4 py-3">
                <p className="label">{readout.label}</p>
                <p className="stat-value mt-1">{readout.value}</p>
                {readout.note && <div className="help mt-1">{readout.note}</div>}
              </div>
            )}
            {actions}
          </div>
        )}
      </div>

      {children && <div className="mt-6">{children}</div>}

      <div className="mt-6 border-t border-line" aria-hidden />
    </header>
  );
}
