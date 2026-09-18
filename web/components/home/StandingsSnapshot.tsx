// SPEC §4.1 (3) — standings snapshot: drivers (top 8) and constructors side by side after
// `afterRound`, with a "Full standings" link to the season page. Server-safe.
import Link from "next/link";
import ConstructorsTable from "@/components/season/ConstructorsTable";
import StandingsTable from "@/components/season/StandingsTable";
import type { ConstructorRow, StandingRow } from "@/lib/queries/season";

export type StandingsSnapshotProps = {
  year: number;
  afterRound: number | null;
  drivers: StandingRow[];
  constructors: ConstructorRow[];
};

export default function StandingsSnapshot({
  year,
  afterRound,
  drivers,
  constructors,
}: StandingsSnapshotProps): React.JSX.Element {
  const emptyReason =
    afterRound === null
      ? "Standings have not been worked out for this season yet — season aggregates not yet computed for this season."
      : "No standings rows are stored for this round.";
  // UX_SPEC §2.3 / §3.3 — say which round the table is a snapshot of, on the table itself.
  const after = afterRound === null ? "" : ` after round ${afterRound}`;
  const shown = Math.min(8, Math.max(drivers.length, 1));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-medium text-muted">
          Drivers{" "}
          <span className="text-muted/70">
            · leading {shown} of {drivers.length}
          </span>
        </h3>
        <StandingsTable
          rows={drivers}
          year={year}
          variant="snapshot"
          caption={`Drivers' championship${after} — the leading ${shown} by points. Open the full standings for every driver.`}
          emptyTitle="No drivers standings"
          emptyReason={emptyReason}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-muted">Constructors</h3>
        <ConstructorsTable
          rows={constructors}
          variant="snapshot"
          caption={`Constructors' championship${after} — each team's two cars added together.`}
          emptyTitle="No constructors standings"
          emptyReason={emptyReason}
        />
      </div>
      <p className="text-sm lg:col-span-2">
        <Link href={`/season/${year}`} className="font-medium text-accent hover:underline">
          Full standings →
        </Link>
      </p>
    </div>
  );
}
