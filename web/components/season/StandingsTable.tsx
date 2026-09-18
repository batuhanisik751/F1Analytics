// SPEC §4.2 (2) / §4.1 (3) — drivers standings. `variant="full"` renders the season page
// columns (Pos, Driver, Team, Points, Sprint pts, Wins, Podiums, Races); `variant="snapshot"`
// the home page's short form (Pos, Driver, Team, Points, Wins). Server-safe.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import type { StandingRow } from "@/lib/queries/season";

export type StandingsTableProps = {
  rows: StandingRow[];
  /** Season the driver links point at (`/driver/{code}?season={year}`). */
  year: number;
  variant?: "full" | "snapshot";
  /** Show the sprint-points column (full variant only); off when no sprint results were ingested. */
  showSprintPoints?: boolean;
  emptyReason?: string | null;
  emptyTitle?: string;
  /** UX_SPEC §4.5 — every table names itself. Defaults to a description of this variant. */
  caption?: React.ReactNode;
  className?: string;
};

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

export default function StandingsTable({
  rows,
  year,
  variant = "full",
  showSprintPoints = false,
  emptyReason,
  emptyTitle,
  caption,
  className,
}: StandingsTableProps): React.JSX.Element {
  const columns: DataTableColumn<StandingRow>[] = [
    { key: "pos", header: "Pos", align: "right", className: "tnum w-12", render: (r) => r.position },
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip
          code={r.code}
          teamColour={r.teamColour}
          fullName={variant === "full" ? r.fullName : undefined}
          title={r.fullName}
          href={`/driver/${r.code}?season=${year}`}
        />
      ),
    },
    { key: "team", header: "Team", render: (r) => r.teamName },
    {
      key: "points",
      header: "Points",
      align: "right",
      className: "tnum font-semibold",
      render: (r) => fmtPoints(r.points),
    },
  ];
  if (variant === "full" && showSprintPoints) {
    columns.push({
      key: "sprint",
      header: "Sprint pts",
      align: "right",
      className: "tnum text-muted",
      render: (r) => fmtPoints(r.sprintPoints),
    });
  }
  columns.push({ key: "wins", header: "Wins", align: "right", className: "tnum", render: (r) => r.wins });
  if (variant === "full") {
    columns.push(
      { key: "podiums", header: "Podiums", align: "right", className: "tnum", render: (r) => r.podiums },
      { key: "races", header: "Races", align: "right", className: "tnum", render: (r) => r.races },
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.driverId}
      rowAccent={(r) => r.teamColour}
      dense={variant === "snapshot"}
      caption={
        caption ??
        (variant === "snapshot"
          ? "Drivers' championship — the leading drivers by points."
          : "Drivers' championship. Points are the official total; wins and podiums count race finishes.")
      }
      emptyReason={emptyReason}
      emptyTitle={emptyTitle}
      className={className}
    />
  );
}
