// MODE1_SPEC §3.4 / §7.4 — weekend preview: P(safety car), P(VSC) and expected pit
// loss, straight out of preview_round. Renders inside <Section> on the race route when
// the round has no results (§3.1). Nothing is computed here.
import CircuitMatchNote from "@/components/preview/CircuitMatchNote";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import StatTile from "@/components/ui/StatTile";
import type { PreviewRound } from "@/lib/queries/preview";

export type PreviewHazardSectionProps = {
  preview: PreviewRound | null;
};

export const PREVIEW_HAZARD_TITLE = "Safety car and pit loss";
export const PREVIEW_HAZARD_HEADER_CAPTION =
  "What this circuit's history says about an interrupted race and the cost of a stop.";

/** §7.6 — the exact reason strings. */
export const PREVIEW_NO_CIRCUIT_REASON =
  "first running at this venue — there is no circuit history to draw on";
export const PREVIEW_NOT_COMPUTED_REASON =
  "the weekend preview has not been recomputed for this round";

/** §7.5 verbatim. `aliasClause` is "" unless `circuitMatch === 'alias'`. */
export function hazardCaption(preview: PreviewRound): string {
  const aliasClause =
    preview.circuitMatch === "alias" && preview.circuitShortName
      ? `, using history recorded under ${preview.circuitShortName}`
      : "";
  return `Based on ${preview.circuitRaces} previous race(s) at this circuit${aliasClause}. With that little history the safety-car number is a weak signal — across all circuits it only spans about one race in five to one in two, around an average of roughly one in three. Pit loss is on firmer ground, because it is measured from every stop rather than once per race.`;
}

function pct0(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function secs(v: number | null, dp = 1): string {
  return v === null ? "—" : `${v.toFixed(dp)} s`;
}

export default function PreviewHazardSection({
  preview,
}: PreviewHazardSectionProps): React.JSX.Element {
  if (!preview) {
    return <EmptyState title="No preview for this round" reason={PREVIEW_NOT_COMPUTED_REASON} />;
  }
  if (preview.circuitKey === null || preview.circuitRaces < 1) {
    return (
      <EmptyState title="No circuit history" reason={PREVIEW_NO_CIRCUIT_REASON}>
        The predicted finishing order below needs no circuit data and still applies.
      </EmptyState>
    );
  }
  return (
    <>
      <CircuitMatchNote
        circuitMatch={preview.circuitMatch}
        circuitShortName={preview.circuitShortName}
        circuitRaces={preview.circuitRaces}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Chance of a safety car"
          value={pct0(preview.pSafetyCar)}
          hint={`over ${preview.circuitRaces} previous race(s) here, shrunk toward the all-circuit average`}
        />
        <StatTile label="Chance of a virtual safety car" value={pct0(preview.pVsc)} />
        <StatTile
          label="Expected pit loss"
          value={secs(preview.expectedPitLossS)}
          hint={
            preview.pitLossBandS === null
              ? undefined
              : `typical spread ±${preview.pitLossBandS.toFixed(1)} s`
          }
        />
      </div>
      <Caption>{hazardCaption(preview)}</Caption>
    </>
  );
}
