// MODE2_SPEC §8.5 slot 5 — career team-mate gaps. Captions C-CONTRAST-1 / C-CONTRAST-2 verbatim.
// Rows arrive from getTeammateContrasts already oriented so driverA is this driver; do
// not flip the sign again here. Every gap carries its 5th-95th range (FD2).
import Caption from "@/components/ui/Caption";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import EmptyState from "@/components/ui/EmptyState";
import type { ContrastRow } from "@/lib/queries/mode2";
import { GrammarChip } from "./mode2Grammar";

function signed(v: number, digits = 3): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
}

const columns: DataTableColumn<ContrastRow>[] = [
  {
    key: "teammate",
    header: "Team-mate",
    render: (r) => (
      <span className="font-medium text-fg">
        {r.driverB}
        {r.sameComponent ? null : (
          <GrammarChip hatched className="ml-2">
            assumed gap
          </GrammarChip>
        )}
      </span>
    ),
  },
  {
    key: "delta",
    // §3.3 one value, one unit: this column printed "pp" in its header and "%" in its
    // cells for the same number. "% of a lap" is the page-wide wording.
    header: "Gap (% of a lap)",
    align: "right",
    className: "tnum",
    render: (r) => (
      <span className={r.deltaPp < 0 ? "text-fg" : "text-muted"}>{signed(r.deltaPp)} %</span>
    ),
  },
  {
    key: "interval",
    header: "5th–95th percentile",
    align: "right",
    className: "tnum",
    render: (r) => `${signed(r.deltaLo)} to ${signed(r.deltaHi)} %`,
  },
  {
    key: "se",
    // §3.3: "SE" is named in words before it is abbreviated.
    header: "Standard error (SE)",
    align: "right",
    className: "tnum",
    render: (r) => r.deltaSe.toFixed(3),
  },
  {
    key: "races",
    header: "Shared races",
    align: "right",
    className: "tnum",
    render: (r) => r.nSharedRaces,
  },
];

export type CareerH2HTableProps = { rows: ContrastRow[] };

export default function CareerH2HTable({ rows }: CareerH2HTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title="Team-mates, career" reason="partial: no shared races" />;
  }
  const headline = rows.reduce((a, b) => (b.nSharedRaces > a.nSharedRaces ? b : a), rows[0]);
  const assumedRows = rows.filter((r) => !r.sameComponent);
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.driverA}-${r.driverB}`}
        rowClassName={(r) => (r.sameComponent ? undefined : "opacity-80")}
        caption="Negative gap = this driver faster than the team-mate, in percent of a lap. Standard error is how far this gap would typically move if the same races were run again."
      />
      {assumedRows.length > 0 ? (
        <div
          data-assumed-contrast="true"
          style={{ backgroundImage: "repeating-linear-gradient(45deg, rgba(154,145,135,0.16) 0 2px, transparent 2px 6px)" }}
          className="mt-3 rounded-lg border border-dashed border-grid px-4 py-3"
        >
          <p className="text-xs leading-relaxed text-fg">
            These two drivers have never shared a car, and no chain of team moves connects them.
            This gap is what the model assumes, not what it measured.
          </p>
          <p className="mt-1 text-xs text-muted">
            Applies to: {assumedRows.map((r) => r.driverB).join(", ")}.
          </p>
        </div>
      ) : null}
      <Caption>
        This is the most trustworthy number on the page. Two drivers in the same car, over{" "}
        {headline.nSharedRaces} races, is the one comparison the data make directly &mdash; no
        assumption about how good the car was is needed for it, and it barely moves when we change
        the model.
      </Caption>
    </>
  );
}
