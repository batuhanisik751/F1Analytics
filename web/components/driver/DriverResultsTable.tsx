// SPEC §4.4 (4): Rd, Grand Prix (link), Team (chip; highlights mid-season swaps), Grid, Finish,
// Status, Points (+sprint), Pace rank, Median pace, Gap to P1 (s / %), Teammate,
// Gap vs teammate (%), Laps compared.
import Link from "next/link";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import StatusBadge from "@/components/ui/StatusBadge";
import TeamDot from "@/components/ui/TeamDot";
import { fmtDate, fmtGap, fmtLapTime, fmtPct } from "@/lib/format";
import type { DriverRaceRow } from "@/lib/queries/driver";

export type DriverResultsTableProps = {
  races: DriverRaceRow[];
  year: number;
  /** Team of the latest race; rows on a different team are highlighted as a mid-season swap. */
  latestTeamId: string | null;
};

const DASH = "—";

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

function finishLabel(r: DriverRaceRow): string {
  if (r.position !== null) return `P${r.position}`;
  if (r.classifiedPosition) return r.classifiedPosition;
  return DASH;
}

export default function DriverResultsTable({
  races,
  year,
  latestTeamId,
}: DriverResultsTableProps): React.JSX.Element {
  const swaps = new Set(races.filter((r) => latestTeamId && r.team.teamId !== latestTeamId).map((r) => r.round));

  const columns: DataTableColumn<DriverRaceRow>[] = [
    { key: "round", header: "Rd", align: "right", className: "tnum", render: (r) => r.round },
    {
      key: "gp",
      header: "Grand Prix",
      render: (r) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link
            href={`/race/${year}/${r.round}`}
            className="text-fg hover:text-accent hover:underline"
            title={`${r.eventName} · ${fmtDate(r.eventDate)}`}
          >
            {r.shortName}
          </Link>
          {r.ingestStatus !== "ok" ? <StatusBadge status={r.ingestStatus} /> : null}
        </span>
      ),
    },
    {
      key: "team",
      header: "Team",
      render: (r) => (
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap ${
            swaps.has(r.round) ? "rounded border border-accent/70 px-1.5 py-0.5 text-accent" : ""
          }`}
          title={swaps.has(r.round) ? "Different team from the latest race (mid-season swap)" : r.team.teamName}
        >
          <TeamDot colour={r.team.teamColour} />
          {r.team.teamName}
        </span>
      ),
    },
    {
      key: "grid",
      header: "Grid",
      align: "right",
      className: "tnum",
      render: (r) => (r.gridPosition === null ? DASH : r.gridPosition === 0 ? "PL" : r.gridPosition),
    },
    { key: "finish", header: "Finish", align: "right", className: "tnum", render: finishLabel },
    { key: "status", header: "Status", render: (r) => r.status || DASH },
    {
      key: "points",
      header: "Points",
      align: "right",
      className: "tnum",
      render: (r) => (
        <>
          {fmtPoints(r.points)}
          {r.sprintPoints !== null ? (
            // §3.1: no hover-only affordance. The label is in the DOM for a screen reader
            // and the section caption explains the bracket for everyone else.
            <span className="text-muted">
              {" "}
              (+{fmtPoints(r.sprintPoints)}
              <span className="sr-only"> sprint points</span>)
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "paceRank",
      header: "Pace rank",
      align: "right",
      className: "tnum",
      render: (r) =>
        r.paceRank === null ? (
          DASH
        ) : (
          <>
            {r.paceRank}
            {r.sensRankLo !== null && r.sensRankHi !== null && r.sensRankLo !== r.sensRankHi ? (
              <span className="text-muted">
                {" "}
                ±{r.sensRankHi - r.sensRankLo}
                <span className="sr-only">
                  {` — the rank moves between ${r.sensRankLo} and ${r.sensRankHi} across the plausible fuel-effect range`}
                </span>
              </span>
            ) : null}
          </>
        ),
    },
    {
      key: "median",
      header: "Median pace",
      align: "right",
      className: "tnum font-mono",
      render: (r) => fmtLapTime(r.medianPaceS),
    },
    {
      key: "gapP1",
      header: "Gap to P1",
      align: "right",
      className: "tnum",
      render: (r) =>
        r.gapToP1S === null || r.paceRank === 1 ? (
          // rank 1 is the reference: a bare dash, exactly as the race page's pace table shows it
          DASH
        ) : (
          <>
            {fmtGap(r.gapToP1S)}
            <span className="text-muted"> / {fmtPct(r.gapToP1Pct)}</span>
          </>
        ),
    },
    {
      key: "teammate",
      header: "Teammate",
      render: (r) =>
        r.teammate ? (
          <DriverChip
            code={r.teammate.code}
            teamColour={r.teammate.teamColour}
            lineStyle={r.teammate.lineStyle}
            href={`/driver/${r.teammate.code}?season=${year}`}
            title={r.teammate.fullName}
            size="sm"
          />
        ) : (
          DASH
        ),
    },
    {
      key: "gapTm",
      header: "Gap vs teammate",
      align: "right",
      className: "tnum",
      render: (r) =>
        r.signedGapPct === null ? (
          DASH
        ) : (
          <span
            className={r.signedGapPct > 0 ? "text-emerald-300" : r.signedGapPct < 0 ? "text-red-300" : ""}
          >
            {fmtPct(r.signedGapPct, { signed: true })}
            {r.signedGapS === null ? null : (
              <span className="sr-only">{` — ${fmtGap(r.signedGapS)}, positive means this driver faster`}</span>
            )}
          </span>
        ),
    },
    {
      key: "lapsCompared",
      header: "Laps compared",
      align: "right",
      className: "tnum",
      render: (r) => r.lapsCompared ?? DASH,
    },
  ];

  // §4.5 — the table says what it contains and what its units are, in a real <caption>.
  return (
    <DataTable
      columns={columns}
      rows={races}
      rowKey={(r) => r.round}
      dense
      emptyTitle={`No race entries in ${year}`}
      emptyReason="no session_entries rows for this driver in this season"
      rowClassName={(r) => (r.position === 1 ? "bg-accent/5" : undefined)}
      caption="One row per round. Points are race points with sprint points in brackets. Pace rank is the fuel-corrected median-pace position, 1 = fastest; a ± beside it is how far that rank moves across the plausible fuel-effect range. Gap vs teammate is in percent of a lap, positive = this driver faster."
    />
  );
}
