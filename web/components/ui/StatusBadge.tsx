// Ingest status pill: 'ok' | 'partial' | 'failed' | 'pending' (anything else renders muted).
export type StatusBadgeProps = {
  status: "pending" | "ok" | "partial" | "failed" | string;
  /** Override the visible text; defaults to a human label for the status. */
  label?: string;
  title?: string;
  className?: string;
};

const STYLES: Record<string, { cls: string; label: string }> = {
  ok: { cls: "border-emerald-500/60 text-emerald-300", label: "ok" },
  partial: { cls: "border-accent/70 text-accent", label: "partial data" },
  failed: { cls: "border-red-500/70 text-red-300", label: "data unavailable" },
  pending: { cls: "border-grid text-muted", label: "not yet ingested" },
  // MODE3_SPEC §8.6 — the one badge that is not about ingest state. It marks text a model
  // wrote, and it is ACCENT rather than muted on purpose: "generated" is the thing a reader
  // most needs to notice, and the default muted style would have whispered it.
  generated: { cls: "border-accent/70 text-accent", label: "generated" },
};

/** Statuses whose `title` is not an ingest state, so the default tooltip would be a lie. */
const TITLES: Record<string, string> = {
  generated: "written by a language model from stored numbers, not computed at ingest",
};

export default function StatusBadge({
  status,
  label,
  title,
  className,
}: StatusBadgeProps): React.JSX.Element {
  const s = STYLES[status] ?? { cls: "border-grid text-muted", label: status };
  return (
    <span
      title={title ?? TITLES[status] ?? `ingest status: ${status}`}
      className={`inline-flex items-center border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${s.cls} ${className ?? ""}`}
    >
      {label ?? s.label}
    </span>
  );
}
