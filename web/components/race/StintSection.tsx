// SPEC §4.3 item 4 — StintGantt in a chart card with the notebook's caption.
import StintGantt from "@/components/charts/StintGantt";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import type { StintRow } from "@/lib/queries/race";
import type { ColourMap, DriverRef } from "@/lib/queries/shared";

export type StintSectionProps = {
  order: DriverRef[];
  stints: StintRow[];
  totalLaps: number | null;
  colours: ColourMap;
  reason?: string | null;
};

export const STINT_CAPTION = "Ordered by finishing position, so strategy and result read together.";

export default function StintSection({
  order,
  stints,
  totalLaps,
  colours,
  reason,
}: StintSectionProps): React.JSX.Element {
  if (stints.length === 0 || order.length === 0) {
    return <EmptyState title="No stint table for this race" reason={reason} />;
  }
  const maxEnd = stints.reduce((m, s) => (s.endLap > m ? s.endLap : m), 0);
  const laps = Math.max(totalLaps ?? 0, maxEnd);
  return (
    <div className="rounded-lg border border-grid bg-surface p-3">
      <StintGantt order={order} stints={stints} totalLaps={laps} colours={colours} />
      <Caption>{STINT_CAPTION}</Caption>
    </div>
  );
}
