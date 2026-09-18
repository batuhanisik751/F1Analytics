// SPEC §4.3 item 9 — clean.exclusion_report rows in stored order; SURVIVING row in accent.
import Caption from "@/components/ui/Caption";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import EmptyState from "@/components/ui/EmptyState";
import type { ExclusionRow } from "@/lib/queries/race";

export type ExclusionTableProps = { rawLaps: number; rows: ExclusionRow[]; reason?: string | null };

export default function ExclusionTable({ rawLaps, rows, reason }: ExclusionTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title="No exclusion report for this race" reason={reason} />;
  }
  const columns: DataTableColumn<ExclusionRow>[] = [
    { key: "rule", header: "Rule", render: (r) => r.rule },
    {
      key: "laps",
      header: (
        <span className="inline-block leading-tight">
          Laps removed
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            by this rule on its own
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => r.lapsHit.toLocaleString("en-GB"),
    },
    {
      key: "pct",
      header: (
        <span className="inline-block leading-tight">
          Share
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            % of every lap in the timing data
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => `${r.pctOfAll.toFixed(1)}%`,
    },
  ];
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.rule}
        dense
        className="max-w-xl"
        rowClassName={(r) => (r.isSurviving ? "font-semibold text-accent border-t-2 border-t-accent/60" : undefined)}
        caption={`${rawLaps.toLocaleString("en-GB")} raw laps in the timing data. Each rule counts the laps it would remove on its own; SURVIVING is what remains after every rule and the per-driver outlier filter.`}
      />
      <Caption>Rules overlap, so percentages do not sum to 100.</Caption>
    </>
  );
}
