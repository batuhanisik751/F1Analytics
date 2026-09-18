// MODE2_SPEC §5.1 slot 4 / §5.3 — "Retirements", never "Reliability". Caption
// C-HAZARD-1 is VERBATIM. Car-seasons under MODE2_MIN_HAZARD_LAPS (200 racing laps) are
// not charted as if they were measured: they get the §8.8 EmptyState line by name.
import HazardBars, { type HazardBarRow } from "@/components/charts/HazardBars";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";

export type HazardSectionProps = {
  rows: HazardBarRow[];
  year: number;
  /** "carOnly" is the default view (§5.3); the raw rate charges a driver's crashes to the car. */
  mode?: "raw" | "carOnly";
  emptyReason?: string;
};

export default function HazardSection({
  rows,
  year,
  mode = "carOnly",
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: HazardSectionProps): React.JSX.Element {
  const usable = rows.filter((r) => r.sufficient);
  const thin = rows.filter((r) => !r.sufficient);

  return (
    <Section
      title="Retirements"
      caption={
        <>
          Retirements per 1,000 racing laps, car component only, with a 5th–95th
          percentile Jeffreys interval. Comparable within a season, never across one.{" "}
          <span className="block mt-1">
            In plain terms: how often this car stopped, per 1,000 laps of racing, counting
            only the part of the stopping we can attribute to the car. The band beside each
            bar is the range we think the true rate sits in — it is deliberately
            cautious for a car with very few retirements, where one failure would otherwise
            look like a pattern.
          </span>
        </>
      }
      collapsible
      storageKey="constructor:retirements"
      summary={`Retirements per 1,000 racing laps for ${usable.length} car-season${usable.length === 1 ? "" : "s"}${thin.length > 0 ? `, with ${thin.length} too short to measure` : ""}. Not a reliability rating: we never see why a car stopped.`}
    >
      {usable.length === 0 ? (
        <EmptyState
          reason={
            rows.length === 0 ? emptyReason : "partial: fewer than 200 racing laps"
          }
        />
      ) : (
        <HazardBars rows={usable} year={year} mode={mode} />
      )}
      {usable.length > 0 && thin.length > 0 ? (
        <div className="mt-3">
          <EmptyState
            title={`${thin.length} car-season${thin.length === 1 ? "" : "s"} not shown`}
            reason="partial: fewer than 200 racing laps"
          >
            {thin.map((r) => `${r.teamName ?? r.teamId} ${r.year}`).join(" · ")}
          </EmptyState>
        </div>
      ) : null}
      <Caption>
        This is not a reliability rating. Our data record that a car stopped; they never
        record why, so a broken gearbox and a first-lap collision look identical here. We
        split the rate into a car part and a driver part, and the car part is the one
        shown by default — but a driver who crashes a lot will still leave a mark on his
        team&apos;s number. Rates are per 1,000 racing laps and are only comparable within
        a season: 2026 is a regulation-reset year and the whole grid retires more often.
      </Caption>
    </Section>
  );
}
