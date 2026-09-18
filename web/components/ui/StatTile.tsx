// A labelled number for summary rows (driver page tiles, race header chips).
export type StatTileProps = {
  label: string;
  value: React.ReactNode;
  /** Small muted line under the value, e.g. "over 13 ranked races". */
  hint?: React.ReactNode;
  className?: string;
};

export default function StatTile({
  label,
  value,
  hint,
  className,
}: StatTileProps): React.JSX.Element {
  return (
    <div className={`border border-grid border-t-2 border-t-accent/70 bg-surface px-4 py-3 ${className ?? ""}`}>
      <div className="tower-label text-[11px] text-muted">{label}</div>
      <div className="tnum mt-1 text-[1.75rem] font-bold leading-none tracking-tight text-fg">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
