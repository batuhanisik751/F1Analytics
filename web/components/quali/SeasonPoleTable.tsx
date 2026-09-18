// QUALI_SPEC §6.5 — the season page's pole column (driver code + time).
//
// §6.5 asks for the column inside the existing weekend list; `components/season/RaceList`
// belongs to another package, so the column ships as its own table on the same page
// rather than as an edit to a file this package does not own. Same data, same em dash
// where a round has no Q session (§6.6).
import Link from "next/link";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import { fmtLapTime } from "@/lib/format";
import type { SeasonPoleRow } from "@/lib/queries/quali";

const DASH = "—";

export default function SeasonPoleTable({
  rows,
  year,
}: {
  rows: SeasonPoleRow[];
  year: number;
}): React.JSX.Element {
  const columns: DataTableColumn<SeasonPoleRow>[] = [
    { key: "round", header: "Rd", align: "right", className: "w-10 text-muted", render: (r) => r.round },
    {
      key: "event",
      header: "Grand Prix",
      render: (r) => (
        <Link href={`/race/${year}/${r.round}#qualifying`} className="hover:text-accent">
          {r.eventName}
        </Link>
      ),
    },
    {
      key: "kind",
      header: "Session",
      className: "text-muted",
      render: (r) => (r.kind === "SQ" ? "Sprint qualifying" : "Qualifying"),
    },
    {
      key: "pole",
      header: "Pole",
      render: (r) =>
        r.code === null || r.colour === null ? (
          <span className="text-muted">{DASH}</span>
        ) : (
          <DriverChip code={r.code} teamColour={r.colour} href={`/driver/${r.code}`} size="sm" />
        ),
    },
    {
      key: "time",
      header: "Time",
      align: "right",
      render: (r) =>
        r.bestS === null ? <span className="text-muted">{DASH}</span> : fmtLapTime(r.bestS),
    },
  ];
  return (
    <DataTable
      caption={`Pole position in every ${year} round that has qualifying in the database: who took it and the lap they took it with. A dash means that round has no qualifying session ingested.`}
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.round}-${r.kind}`}
      rowAccent={(r) => r.colour ?? undefined}
      dense
      emptyTitle="No qualifying sessions ingested for this season"
      emptyReason="no sessions rows with kind Q or SQ for this year"
    />
  );
}
