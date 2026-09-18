// MODE1_SPEC §3.3 / §7.4 — the overtaking difficulty index for this circuit, read on a
// fixed 0–100 strip beside every other circuit. Computed in Python; read here.
import OdiStrip from "@/components/charts/OdiStrip";
import CircuitMatchNote from "@/components/preview/CircuitMatchNote";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import StatTile from "@/components/ui/StatTile";
import { PREVIEW_NO_CIRCUIT_REASON } from "@/components/preview/PreviewHazardSection";
import type { OdiTick, PreviewRound } from "@/lib/queries/preview";

export type PreviewOvertakingSectionProps = {
  preview: PreviewRound | null;
  ticks: OdiTick[];
};

export const PREVIEW_OVERTAKING_TITLE = "Overtaking difficulty";
export const PREVIEW_OVERTAKING_HEADER_CAPTION =
  "How often nose-to-tail cars actually swap places here, on a fixed scale.";

/** §7.6 — the exact reason string. */
export const PREVIEW_ODI_MIN_RACES_REASON = "needs at least two races at this circuit";

/** UX_SPEC §0/§2.2 — NEW copy, kept in the open above the full caption below. */
export const PREVIEW_OVERTAKING_LEAD =
  "0 is easy to pass, 100 is nearly impossible. With only two or three races at most circuits these are estimates with a band around them, not settled facts.";

/** §7.5 verbatim. */
export const PREVIEW_OVERTAKING_CAPTION =
  "0 to 100, where higher means harder to pass. It counts how often two cars running nose-to-tail actually swap places on a green lap, ignoring pit stops and retirements, then adjusts for how spread out the field was. The scale is fixed rather than relative to the other circuits, so adding a new track does not move anyone else's number: 0 means about 5 successful passes per 100 chances, 100 means about half a pass per 100. Monaco measures around 75 and Monza around 15 — twelve times harder, which matches what the racing looks like. With two or three races per circuit these are estimates, so they are shrunk toward the average and carry a band.";

export default function PreviewOvertakingSection({
  preview,
  ticks,
}: PreviewOvertakingSectionProps): React.JSX.Element {
  if (!preview || preview.circuitKey === null) {
    return <EmptyState title="No circuit history" reason={PREVIEW_NO_CIRCUIT_REASON} />;
  }
  if (preview.circuitRaces < 2 || preview.odi === null) {
    return (
      <EmptyState title="No overtaking index for this circuit" reason={PREVIEW_ODI_MIN_RACES_REASON} />
    );
  }
  const band =
    preview.odiLo === null || preview.odiHi === null
      ? undefined
      : `band ${preview.odiLo.toFixed(0)}–${preview.odiHi.toFixed(0)}`;
  return (
    <>
      <CircuitMatchNote
        circuitMatch={preview.circuitMatch}
        circuitShortName={preview.circuitShortName}
        circuitRaces={preview.circuitRaces}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Overtaking difficulty index"
          value={preview.odi.toFixed(0)}
          hint={band}
        />
      </div>
      <div className="mt-3 rounded-lg border border-grid bg-surface p-3">
        <OdiStrip ticks={ticks} highlightCircuitKey={preview.circuitKey} />
      </div>
      {/* §0 — the caption is kept whole and moved behind a control; the lead line is new. */}
      <p className="mt-2 text-xs leading-relaxed text-muted">{PREVIEW_OVERTAKING_LEAD}</p>
      <Disclosure
        variant="inline"
        storageKey="preview:overtaking:caption"
        summary="How this 0-100 score is worked out, and what Monaco and Monza measure on it"
      >
        {PREVIEW_OVERTAKING_CAPTION}
      </Disclosure>
    </>
  );
}
