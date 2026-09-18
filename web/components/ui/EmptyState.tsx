// Rendered in place of a section's content when its data is empty. Pages never throw
// on empty analytics; `reason` typically comes from session_ingests.analytics_status.
export type EmptyStateProps = {
  reason?: string | null;
  title?: string;
  children?: React.ReactNode;
  className?: string;
};

export default function EmptyState({
  reason,
  title = "No data for this section",
  children,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border border-dashed border-grid bg-surface/50 px-4 py-6 text-center ${className ?? ""}`}
    >
      <p className="text-sm font-medium text-fg">{title}</p>
      {reason ? <p className="mt-1 font-mono text-xs text-muted">{reason}</p> : null}
      {children ? <div className="mt-3 text-sm text-muted">{children}</div> : null}
    </div>
  );
}
