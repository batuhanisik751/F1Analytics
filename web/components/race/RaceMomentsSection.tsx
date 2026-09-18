// MODE1_SPEC §7.4 — the detected moments, listed beside the trace that carries their
// markers. Caption verbatim from §7.5; the hidden clause reports the display cap (§4.2).
import Caption from "@/components/ui/Caption";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import StatusBadge from "@/components/ui/StatusBadge";
import type { RaceMoment, RaceMoments } from "@/lib/queries/race";

export type RaceMomentsSectionProps = {
  moments: RaceMoments;
  reason?: string | null;
};

export const MOMENTS_EMPTY_REASON =
  "no moments crossed the detection thresholds in this race";

export const MOMENTS_CAPTION =
  "Rules run over the stored lap times, not a highlights reel: a pace collapse, an undercut that worked, a tyre going off a cliff, a lap slow enough to look like damage, a well-timed stop under a safety car. A rule that fires is a fact about the lap times; whether it was strategy, damage or luck is not something these numbers can tell you.";

export const MOMENT_LABEL: Record<RaceMoment["momentType"], string> = {
  pace_collapse: "Pace collapse",
  undercut_executed: "Undercut executed",
  tyre_cliff: "Tyre cliff",
  damage_or_puncture: "Damage or puncture",
  safety_car_luck: "Safety-car luck",
};

export function hiddenClause(hiddenCount: number): string {
  return hiddenCount > 0
    ? `${hiddenCount} further moments were detected and are not shown.`
    : "";
}

function magnitudeText(m: RaceMoment): string {
  return m.magnitudeUnit === "places"
    ? `${Math.round(m.magnitude)} places`
    : `${m.magnitude.toFixed(2)} s`;
}

const COLUMNS: DataTableColumn<RaceMoment>[] = [
  {
    key: "lap",
    header: "Lap",
    align: "right",
    className: "tnum font-mono",
    render: (m) => m.lapNumber,
  },
  { key: "type", header: "Moment", render: (m) => MOMENT_LABEL[m.momentType] },
  {
    key: "driver",
    header: "Driver",
    render: (m) => (
      <DriverChip
        code={m.driver.code}
        teamColour={m.driver.teamColour}
        lineStyle={m.driver.lineStyle}
        fullName={m.driver.fullName}
        size="sm"
      />
    ),
  },
  {
    key: "other",
    header: "Against",
    render: (m) =>
      m.otherDriver ? (
        <DriverChip
          code={m.otherDriver.code}
          teamColour={m.otherDriver.teamColour}
          lineStyle={m.otherDriver.lineStyle}
          size="sm"
        />
      ) : (
        <span className="text-muted">&mdash;</span>
      ),
  },
  {
    key: "magnitude",
    header: "Size",
    align: "right",
    className: "tnum",
    render: (m) => magnitudeText(m),
  },
  {
    key: "confidence",
    header: "Confidence",
    render: (m) => <StatusBadge status={m.confidence} label={m.confidence} />,
  },
  { key: "detail", header: "Detail", className: "text-muted", render: (m) => m.detail },
];

export default function RaceMomentsSection({
  moments,
  reason,
}: RaceMomentsSectionProps): React.JSX.Element {
  if (moments.shown.length === 0) {
    return (
      <EmptyState
        title="No moments detected in this race"
        reason={reason ?? MOMENTS_EMPTY_REASON}
      />
    );
  }
  const hidden = hiddenClause(moments.hiddenCount);
  return (
    <div>
      <DataTable
        columns={COLUMNS}
        rows={moments.shown}
        rowKey={(m) => `${m.lapNumber}-${m.momentType}-${m.driver.driverId}`}
        dense
      />
      <Caption>{hidden ? `${MOMENTS_CAPTION} ${hidden}` : MOMENTS_CAPTION}</Caption>
    </div>
  );
}
