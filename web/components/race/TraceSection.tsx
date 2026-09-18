// SPEC §4.3 item 6 — RaceTrace in a chart card with the gap-definition caption.
import RaceTrace from "@/components/charts/RaceTrace";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import type { LapStatusRow, RaceMoment, TraceSeries } from "@/lib/queries/race";
import type { ColourMap } from "@/lib/queries/shared";

export type TraceSectionProps = {
  totalLaps: number;
  series: TraceSeries[];
  lapStatus: LapStatusRow[];
  colours: ColourMap;
  /** MODE1_SPEC §7.3 — markers on the trace; default [] keeps the v1 call site valid. */
  moments?: RaceMoment[];
  reason?: string | null;
};

export const TRACE_CAPTION =
  "Gap = time the car completed lap N minus time the leader completed lap N. Lapped cars keep growing; red flags shift everyone equally.";

export default function TraceSection({
  totalLaps,
  series,
  lapStatus,
  colours,
  moments = [],
  reason,
}: TraceSectionProps): React.JSX.Element {
  if (series.length === 0 || totalLaps === 0) {
    return <EmptyState title="No lap data for this race" reason={reason} />;
  }
  return (
    <div className="rounded-lg border border-grid bg-surface p-3">
      <RaceTrace
        totalLaps={totalLaps}
        series={series}
        lapStatus={lapStatus}
        colours={colours}
        moments={moments}
      />
      <Caption>{TRACE_CAPTION}</Caption>
    </div>
  );
}
