// SPEC §4.3 item 5 — per-stint degradation fits (collapsed). Rows whose standard error is
// at least as large as the slope are muted and tagged "not a finding" (notebook §7).
import CompoundChip from "@/components/ui/CompoundChip";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import { fmtLapTime, fmtSigned } from "@/lib/format";
import type { DegFitRow } from "@/lib/queries/race";

export type DegradationTableProps = { rows: DegFitRow[]; year: number };

export function isNotAFinding(r: DegFitRow): boolean {
  return r.degStdErr >= Math.abs(r.degSPerLap);
}

export default function DegradationTable({ rows, year }: DegradationTableProps): React.JSX.Element {
  const columns: DataTableColumn<DegFitRow>[] = [
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip
          code={r.code}
          teamColour={r.teamColour}
          lineStyle={r.lineStyle}
          fullName={r.fullName}
          href={`/driver/${r.code}?season=${year}`}
          size="sm"
        />
      ),
    },
    { key: "stint", header: "Stint", align: "right", className: "tnum", render: (r) => r.stint },
    {
      key: "compound",
      header: "Compound",
      render: (r) => <CompoundChip compound={r.compound} colour={r.compoundColour} />,
    },
    { key: "laps", header: "Laps", align: "right", className: "tnum", render: (r) => r.laps },
    {
      key: "slope",
      // §3.3 — "std err" is named in words before it is abbreviated, and the unit is spelled out.
      header: (
        <span className="inline-block leading-tight">
          Wear rate
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            seconds lost per lap of tyre age, ± its standard error
          </span>
        </span>
      ),
      align: "right",
      className: "tnum whitespace-nowrap",
      render: (r) => (
        <>
          {fmtSigned(r.degSPerLap, 3)} ± {r.degStdErr.toFixed(3)}
          {isNotAFinding(r) ? (
            <span className="ml-2 rounded border border-grid px-1 text-[10px] uppercase tracking-wide text-muted">
              not a finding
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "r2",
      header: (
        <span className="inline-block leading-tight">
          Fit quality
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            0 to 1; how much of the lap-time change the line explains (R²)
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => r.r2.toFixed(2),
    },
    {
      key: "fresh",
      header: (
        <span className="inline-block leading-tight">
          Fresh pace
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            the fit projected back to a brand-new tyre
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => fmtLapTime(r.freshPaceS),
    },
  ];

  const weak = rows.filter(isNotAFinding).length;

  return (
    <details className="group mt-4 rounded-lg border border-grid bg-surface/40">
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center px-4 py-2 text-sm text-fg hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <span className="group-open:hidden">
          Show per-stint fits ({rows.length} stints, {weak} not a finding)
        </span>
        <span className="hidden group-open:inline">Hide per-stint fits</span>
      </summary>
      <div className="border-t border-grid p-2">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.driverId}-${r.stint}`}
          dense
          rowClassName={(r) => (isNotAFinding(r) ? "opacity-55" : undefined)}
          caption="Slope = seconds lost per lap of tyre age with fuel removed, fitted per driver-stint on laps with tyre life ≥ 2. Fresh pace = the fit projected to a new tyre. A slope smaller than its standard error is not a finding."
        />
      </div>
    </details>
  );
}
