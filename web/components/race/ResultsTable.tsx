// SPEC §4.3 item 2 — full classification in a collapsed <details>. Time/Gap follows §0.3:
// P1 shows the absolute race time, `status == 'Finished'` rows show +gap, everything else
// (lapped, retired, DNS) is blank because results.Time is not a gap to the winner there.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import TeamDot from "@/components/ui/TeamDot";
import { fmtGap, fmtRaceTime } from "@/lib/format";
import type { RaceResultRow } from "@/lib/queries/race";

export type ResultsTableProps = { rows: RaceResultRow[]; year: number; reason?: string | null };

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

function timeOrGap(r: RaceResultRow): string {
  if (r.resultTimeS === null) return "";
  if (r.position === 1) return fmtRaceTime(r.resultTimeS);
  if (r.status === "Finished") return fmtGap(r.resultTimeS);
  return "";
}

export default function ResultsTable({ rows, year, reason }: ResultsTableProps): React.JSX.Element {
  const columns: DataTableColumn<RaceResultRow>[] = [
    {
      key: "pos",
      header: "Pos",
      align: "right",
      className: "tnum w-12",
      render: (r) => r.position ?? r.classifiedPosition,
    },
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip
          code={r.code}
          fullName={r.fullName}
          teamColour={r.teamColour}
          lineStyle={r.lineStyle}
          href={`/driver/${r.code}?season=${year}`}
        />
      ),
    },
    {
      key: "team",
      header: "Team",
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <TeamDot colour={r.teamColour} />
          {r.teamName}
        </span>
      ),
    },
    {
      key: "grid",
      header: "Grid",
      align: "right",
      className: "tnum",
      render: (r) => (r.gridPosition === null ? "—" : r.gridPosition === 0 ? "PL" : r.gridPosition),
    },
    { key: "status", header: "Status", render: (r) => r.status },
    {
      key: "laps",
      header: "Laps",
      align: "right",
      className: "tnum",
      render: (r) => r.lapsCompleted ?? "—",
    },
    {
      key: "points",
      header: "Points",
      align: "right",
      className: "tnum",
      render: (r) => fmtPoints(r.points),
    },
    {
      key: "time",
      header: "Time / Gap",
      align: "right",
      className: "tnum",
      render: (r) => timeOrGap(r),
    },
  ];

  if (rows.length === 0) {
    return <DataTable columns={columns} rows={rows} rowKey={(r) => r.driverId} emptyReason={reason} />;
  }

  return (
    <details className="group rounded-lg border border-grid bg-surface/40">
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center px-4 py-2 text-sm text-fg hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <span className="group-open:hidden">Show full classification ({rows.length} drivers)</span>
        <span className="hidden group-open:inline">Hide full classification</span>
      </summary>
      <div className="border-t border-grid p-2">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.driverId}
          rowAccent={(r) => r.teamColour}
          dense
          rowClassName={(r) => (r.position === null ? "opacity-70" : undefined)}
        />
        <p className="mt-2 px-1 text-xs text-muted">
          Gaps are shown only for cars classified as Finished on the lead lap; the timing
          API&apos;s time for lapped cars is not a gap to the winner, so it is left blank.
        </p>
      </div>
    </details>
  );
}
