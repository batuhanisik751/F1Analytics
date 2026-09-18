// QUALI_SPEC §6.2 (e) / §4.7 — qualified versus started. Rendered ONLY when at least one
// row moved (§6.6): 20.5% of driver-rounds move, but 5 of 8 measured sessions had two or
// fewer, and a table of twenty zeroes is noise.
//
// §0.4 note 6: this is NEVER called a penalty. The words are "qualified Pn, started Pm".
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import type { QualiToGridRow } from "@/lib/queries/quali";

/** §6.6: not rendered when every driver started where they qualified, or the race is not ingested. */
export function shouldRenderToGrid(rows: QualiToGridRow[]): boolean {
  return rows.some((r) => r.placesMoved !== 0);
}

export default function QualiToGridTable({ rows }: { rows: QualiToGridRow[] }): React.JSX.Element | null {
  if (!shouldRenderToGrid(rows)) return null;
  const moved = rows.filter((r) => r.placesMoved !== 0);

  const columns: DataTableColumn<QualiToGridRow>[] = [
    {
      key: "driver",
      header: "Driver",
      render: (r) => <DriverChip code={r.code} teamColour={r.colour} href={`/driver/${r.code}`} />,
    },
    { key: "q", header: "Qualified", align: "right", render: (r) => `P${r.qualiPosition}` },
    { key: "g", header: "Started", align: "right", render: (r) => `P${r.gridPosition}` },
    {
      key: "moved",
      header: "Difference",
      align: "right",
      render: (r) => (
        <span className="text-muted">
          {r.placesMoved > 0
            ? `${r.placesMoved} place${r.placesMoved === 1 ? "" : "s"} further back`
            : `${-r.placesMoved} place${r.placesMoved === -1 ? "" : "s"} further forward`}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      caption="Where each of these drivers qualified and where they actually started. Only drivers whose grid slot differs from their qualifying position are listed."
      columns={columns}
      rows={moved}
      rowKey={(r) => r.driverId}
      rowAccent={(r) => r.colour}
      dense
      emptyTitle="No difference between qualifying and the grid"
      emptyReason="every driver started where they qualified"
    />
  );
}
