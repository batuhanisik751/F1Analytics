// MODE2_SPEC §4.4 / §8.4 rules 5 and 6 — the counterfactual result card.
//
// Binding rules implemented here, not decorated here:
//   - "This pairing never happened" (C-CF-1) is rendered ABOVE the result, always.
//   - The headline is the RANGE. The point estimate appears in smaller muted type below.
//   - For `basis === 'by-analogy'` the point estimate is not rendered AT ALL — the card
//     shows the range and a sentence, so a cropped screenshot has no number to misquote.
//   - A `crossComponent` row additionally names the crossing in words (C-CF-2).
import Caption from "@/components/ui/Caption";
import type { CounterfactualRow } from "@/lib/queries/mode2";

export type CounterfactualCardProps = {
  row: CounterfactualRow;
  driverName: string;
  teamName: string;
  incumbentName: string;
  /** True only when a widening beyond the measured interaction term is in force (C-CF-3). */
  handSetWidening?: boolean;
};

const pts = (v: number): string => `${Math.round(v)}`;
const signed = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v))}`;

export default function CounterfactualCard({
  row,
  driverName,
  teamName,
  incumbentName,
  handSetWidening = false,
}: CounterfactualCardProps): React.JSX.Element {
  const assumed = row.basis === "by-analogy";

  return (
    <div className="rounded-lg border border-grid bg-surface p-4">
      {/* Rule 6: the disclaimer is above the result, never below. */}
      <Caption className="mt-0">
        <strong className="text-fg">This pairing never happened.</strong> We are adding up
        a driver&apos;s measured speed and a car&apos;s measured speed, two things that
        were never observed together, and assuming they simply add. They might not: teams
        build cars around their drivers, drivers take time to adapt, and a driver&apos;s
        advantage may shrink in a slower car. We widened the range to allow for that,
        using the size of the driver-car fit we could measure elsewhere on the grid. Read
        this as what our model implies, not as what would have happened.
      </Caption>
      {row.crossComponent ? (
        <Caption>
          This swap crosses two groups of drivers that our data cannot compare —{" "}
          {driverName} and {teamName} are connected by no chain of team moves. The range
          below is almost entirely an assumption.
        </Caption>
      ) : null}
      {handSetWidening ? (
        <Caption>
          The range on a counterfactual is wider than the range on a real season partly
          because we widened it on purpose. Treat anything inside it as &ldquo;we cannot
          tell&rdquo;.
        </Caption>
      ) : null}

      <div className="mt-4 border-t border-grid pt-4">
        <p className="text-sm text-muted">
          {driverName} in the {row.year} {teamName}, in place of {incumbentName}
        </p>
        <p className="tnum mt-1 text-2xl font-semibold leading-tight text-fg">
          Somewhere between {pts(row.pointsP10)} and {pts(row.pointsP90)} points
        </p>
        {assumed ? (
          <p className="mt-2 text-sm text-muted">
            We are not putting a single number on this one. One of the two sides of this
            pairing sits in a group whose level our data cannot measure, so a midpoint
            here would be an assumption wearing the clothes of a result. The range above is
            what the model implies; its middle is not a finding.
          </p>
        ) : (
          <p className="tnum mt-1 text-sm text-muted">
            middle of the range {pts(row.pointsP50)} points · {incumbentName} actually
            scored {pts(row.incumbentActual)} · difference {signed(row.deltaP10)} to{" "}
            {signed(row.deltaP90)} points
          </p>
        )}
        {/* UX_SPEC §3.3 — the original diagnostic line is kept verbatim and a plain-language
            gloss is appended after it; nothing here was replaced or shortened (§0). */}
        <p className="mt-2 text-xs leading-snug text-muted">
          5th–95th percentile of {row.year} re-runs of the season. Replay error on real
          seasons: ±{row.calibrationMae.toFixed(1)} points.{" "}
          <span className="block mt-1">
            In plain terms: the range above is the middle 90 % of our re-runs — one re-run
            in twenty finished below it, one in twenty above it. And when we replay seasons
            that really happened, this method lands about{" "}
            {row.calibrationMae.toFixed(1)} points away from the score that was actually
            scored, so treat differences smaller than that as no difference at all.
          </span>
        </p>
      </div>
    </div>
  );
}
