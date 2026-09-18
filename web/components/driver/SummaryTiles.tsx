// SPEC §4.4 (2): points, championship position, wins, podiums, DNFs, avg finish, avg grid,
// mean pace rank ("over N ranked races") from driver_season_summary.
import EmptyState from "@/components/ui/EmptyState";
import StatTile from "@/components/ui/StatTile";
import type { DriverSummary } from "@/lib/queries/driver";

export type SummaryTilesProps = {
  summary: DriverSummary | null;
  year: number;
};

const DASH = "—";

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

function fmtAvg(v: number | null): string {
  return v === null || !Number.isFinite(v) ? DASH : v.toFixed(1);
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export default function SummaryTiles({ summary, year }: SummaryTilesProps): React.JSX.Element {
  if (!summary) {
    return (
      <EmptyState
        title={`No season summary for ${year}`}
        reason="driver_season_summary has no row; run the season recompute after ingest"
      />
    );
  }
  const ranked = summary.racesRanked;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        label="Points"
        value={fmtPoints(summary.points)}
        hint={`${summary.races} race ${summary.races === 1 ? "entry" : "entries"}`}
      />
      <StatTile
        label="Championship"
        value={summary.championshipPosition === null ? DASH : ordinal(summary.championshipPosition)}
        hint="after the latest ingested round"
      />
      <StatTile label="Wins" value={summary.wins} />
      <StatTile label="Podiums" value={summary.podiums} />
      <StatTile label="DNFs" value={summary.dnfs} hint="unclassified race entries" />
      <StatTile
        label="Avg finish"
        value={fmtAvg(summary.avgFinish)}
        hint={summary.bestFinish === null ? "no classified finish" : `best P${summary.bestFinish}`}
      />
      <StatTile label="Avg grid" value={fmtAvg(summary.avgGrid)} hint="pit-lane starts excluded" />
      <StatTile
        label="Mean pace rank"
        value={fmtAvg(summary.meanPaceRank)}
        hint={`over ${ranked} ranked ${ranked === 1 ? "race" : "races"}`}
      />
    </div>
  );
}
