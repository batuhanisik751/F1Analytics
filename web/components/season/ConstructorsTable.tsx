// SPEC §4.2 (3) / §4.1 (3) — constructors standings: Pos, Team (TeamDot), Points, Wins, Podiums.
// `variant="snapshot"` drops Podiums for the home page's side-by-side card. Server-safe.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import TeamDot from "@/components/ui/TeamDot";
import type { ConstructorRow } from "@/lib/queries/season";

export type ConstructorsTableProps = {
  rows: ConstructorRow[];
  variant?: "full" | "snapshot";
  emptyReason?: string | null;
  emptyTitle?: string;
  /** UX_SPEC §4.5 — every table names itself. Defaults to a description of this variant. */
  caption?: React.ReactNode;
  className?: string;
};

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

export default function ConstructorsTable({
  rows,
  variant = "full",
  emptyReason,
  emptyTitle,
  caption,
  className,
}: ConstructorsTableProps): React.JSX.Element {
  const columns: DataTableColumn<ConstructorRow>[] = [
    { key: "pos", header: "Pos", align: "right", className: "tnum w-12", render: (r) => r.position },
    {
      key: "team",
      header: "Team",
      render: (r) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <TeamDot colour={r.teamColour} />
          <span className="font-medium">{r.teamName}</span>
        </span>
      ),
    },
    {
      key: "points",
      header: "Points",
      align: "right",
      className: "tnum font-semibold",
      render: (r) => fmtPoints(r.points),
    },
    { key: "wins", header: "Wins", align: "right", className: "tnum", render: (r) => r.wins },
  ];
  if (variant === "full") {
    columns.push({
      key: "podiums",
      header: "Podiums",
      align: "right",
      className: "tnum",
      render: (r) => r.podiums,
    });
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.teamId}
      rowAccent={(r) => r.teamColour}
      dense={variant === "snapshot"}
      caption={
        caption ??
        "Constructors' championship — each team's two cars added together."
      }
      emptyReason={emptyReason}
      emptyTitle={emptyTitle}
      className={className}
    />
  );
}
