// Server-safe presentational table (no sorting state in v1). Callers pass rows already
// ordered by the query and a column list with render functions.
import EmptyState from "./EmptyState";

export type DataTableColumn<T> = {
  /** Stable key for React and the header cell. */
  key: string;
  header: React.ReactNode;
  render: (row: T, index: number) => React.ReactNode;
  align?: "left" | "right" | "center";
  /** Extra classes on every cell of this column (e.g. `tnum`, `w-24`). */
  className?: string;
  /** Extra classes on the header cell only. */
  headerClassName?: string;
};

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Extra classes per row (e.g. an accent border for the winner, `opacity-60` for muted rows). */
  rowClassName?: (row: T, index: number) => string | undefined;
  /**
   * Team colour for this row, painted as the left edge — the timing tower's one
   * structural signal. Returns a `#rrggbb` from the database (session_teams /
   * denormalised standings columns), never a hard-coded colour. Omit for tables whose
   * rows are not per-driver or per-team.
   */
  rowAccent?: (row: T, index: number) => string | undefined;
  /** Shown instead of the table when `rows` is empty. */
  emptyReason?: string | null;
  emptyTitle?: string;
  /** Tighter padding for long tables. */
  dense?: boolean;
  /** Visible caption (also read by screen readers). */
  caption?: React.ReactNode;
  className?: string;
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  rowAccent,
  emptyReason,
  emptyTitle,
  dense = false,
  caption,
  className,
}: DataTableProps<T>): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState reason={emptyReason} title={emptyTitle} />;
  }
  const pad = dense ? "px-2.5 py-1" : "px-3 py-2";
  return (
    <div className={`overflow-x-auto border border-grid bg-surface/30 ${className ?? ""}`}>
      <table className="tnum w-full min-w-max border-collapse text-sm">
        {caption ? <caption className="p-2 text-left text-xs text-muted">{caption}</caption> : null}
        {/* Header row of a timing tower: raised, caps, tracked out, and underlined in
            red so the eye locks to the top of the stack. */}
        <thead className="tower-label border-b-2 border-accent/60 bg-raised text-[11px] text-muted">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${pad} ${ALIGN[c.align ?? "left"]} ${c.className ?? ""} ${c.headerClassName ?? ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const team = rowAccent?.(row, i);
            return (
              <tr
                key={rowKey(row, i)}
                // `team-edge` reads --team, so the colour arrives as a CSS variable and
                // no per-row class has to be generated for 20 different team colours.
                className={`border-t border-grid/60 transition-colors hover:bg-raised/80 ${team ? "team-edge" : ""} ${rowClassName?.(row, i) ?? ""}`}
                style={team ? ({ "--team": team } as React.CSSProperties) : undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${pad} align-middle ${ALIGN[c.align ?? "left"]} ${c.className ?? ""}`}
                  >
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
