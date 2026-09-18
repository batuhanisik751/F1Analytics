// SPEC §4.3 item 3 — PaceBoxPlot + ranking table. Winner (race P1) row gets an accent border.
import PaceBoxPlot from "@/components/charts/PaceBoxPlot";
import Caption from "@/components/ui/Caption";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import TeamDot from "@/components/ui/TeamDot";
import { fmtGap, fmtLapTime, fmtPct } from "@/lib/format";
import type { PaceRow } from "@/lib/queries/race";
import type { ColourMap } from "@/lib/queries/shared";

export type PaceSectionProps = {
  rows: PaceRow[];
  colours: ColourMap;
  year: number;
  reason?: string | null;
};

export const PACE_CAPTION =
  "Race pace, fuel-corrected to an empty tank — green-flag laps only; in/out laps and outliers removed. Median, not mean: residual noise is one-sided.";

/**
 * UX_SPEC §3.3 — a column header carries its unit in fan-readable words on a second line, so no
 * number in the table is bare and no abbreviation appears without being named.
 */
function SubHeader({ label, unit }: { label: string; unit: string }): React.JSX.Element {
  return (
    <span className="inline-block leading-tight">
      {label}
      <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
        {unit}
      </span>
    </span>
  );
}

function stable(r: PaceRow): React.ReactNode {
  if (r.sensRankLo === null || r.sensRankHi === null) return "—";
  if (r.sensRankLo === r.sensRankHi) {
    // §3.1/§4.3 — the meaning was hover-only, which a phone and a keyboard never reach. The
    // `title` stays for a mouse; the same words are now in the accessibility tree too.
    return (
      <span className="text-emerald-300" title="Same rank at every fuel constant tested">
        ✓<span className="sr-only"> same rank at every fuel constant tested</span>
      </span>
    );
  }
  return (
    <span
      className="text-accent"
      title={`Rank moves between P${r.sensRankLo} and P${r.sensRankHi} across the fuel constants tested`}
    >
      ±{r.sensRankHi - r.sensRankLo}
      <span className="sr-only">
        {" "}
        places — rank moves between P{r.sensRankLo} and P{r.sensRankHi} across the fuel constants
        tested
      </span>
    </span>
  );
}

export default function PaceSection({
  rows,
  colours,
  year,
  reason,
}: PaceSectionProps): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title="No pace ranking for this race" reason={reason} />;
  }

  const columns: DataTableColumn<PaceRow>[] = [
    { key: "rank", header: "Rank", align: "right", className: "tnum w-12", render: (r) => r.rank },
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
      key: "clean",
      header: <SubHeader label="Clean laps" unit="laps that counted" />,
      align: "right",
      className: "tnum",
      render: (r) => r.cleanLaps,
    },
    {
      key: "median",
      header: <SubHeader label="Median lap" unit="fuel-corrected, m:ss.sss" />,
      align: "right",
      className: "tnum",
      render: (r) => fmtLapTime(r.medianPaceS),
    },
    {
      key: "best",
      header: <SubHeader label="Best lap" unit="fuel-corrected, m:ss.sss" />,
      align: "right",
      className: "tnum",
      render: (r) => fmtLapTime(r.bestPaceS),
    },
    {
      key: "iqr",
      // §3.3 — "IQR" is a statistics abbreviation, so it is named in words first and kept in
      // brackets rather than removed.
      header: <SubHeader label="Spread" unit="middle half of their laps (IQR), s" />,
      align: "right",
      className: "tnum",
      render: (r) => `${r.iqrS.toFixed(3)}s`,
    },
    {
      key: "gap",
      header: <SubHeader label="Gap" unit="seconds behind the quickest" />,
      align: "right",
      className: "tnum",
      render: (r) => (r.rank === 1 ? "—" : fmtGap(r.gapS)),
    },
    {
      key: "gapPct",
      header: <SubHeader label="Gap" unit="% of a lap behind the quickest" />,
      align: "right",
      className: "tnum",
      render: (r) => (r.rank === 1 ? "—" : fmtPct(r.gapPct)),
    },
    {
      key: "stable",
      header: <SubHeader label="Stable" unit="under a different fuel assumption" />,
      align: "center",
      className: "tnum",
      render: (r) => stable(r),
    },
  ];

  return (
    <>
      <div className="rounded-lg border border-grid bg-surface p-3">
        <PaceBoxPlot rows={rows} colours={colours} />
        <Caption>{PACE_CAPTION}</Caption>
      </div>
      <DataTable
        className="mt-4"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.driverId}
        rowAccent={(r) => r.teamColour}
        dense
        rowClassName={(r) =>
          r.finishPosition === 1 ? "border-l-2 border-l-accent bg-accent/5" : undefined
        }
        caption="Stable: ✓ when the driver holds the same rank at every fuel constant tested; ±N is the size of the rank range. Accent border marks the race winner."
      />
    </>
  );
}
