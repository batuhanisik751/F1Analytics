// MODE2_SPEC §5.1 slot 3 / §5.2 — in-season development. Caption C-DEV-1 is VERBATIM
// with its two counts substituted; the multiplicity sentence leads and may not be cut.
import DevelopmentSegments, { type DevelopmentRow } from "@/components/charts/DevelopmentSegments";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";

export type DevelopmentSectionProps = {
  /** Car-seasons drawn on the chart (one season for the index, the team's seasons otherwise). */
  rows: DevelopmentRow[];
  year: number;
  /** Counts for the caption: over ALL car-seasons in the fit, not just the rows drawn. */
  nSignificant: number;
  nCarSeasons: number;
  emptyReason?: string;
};

export default function DevelopmentSection({
  rows,
  year,
  nSignificant,
  nCarSeasons,
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: DevelopmentSectionProps): React.JSX.Element {
  return (
    <Section
      title="In-season development"
      caption="Where each car started the season and where it ended, relative to its own season's field. Greyed-out cars did not move more than the noise."
      collapsible
      storageKey="constructor:development"
      summary={`${nSignificant} of ${nCarSeasons} cars in our data measurably improved or fell back during a season; the rest moved less than the race-to-race noise.`}
    >
      {rows.length === 0 ? (
        <EmptyState reason={emptyReason} />
      ) : (
        <DevelopmentSegments rows={rows} year={year} />
      )}
      <Caption>
        Only {nSignificant} of the {nCarSeasons} car-seasons in our data developed at a
        rate we can distinguish from flat — and testing {nCarSeasons} cars at this
        threshold produces about 1.6 apparent movers by chance alone. Everything greyed
        out moved less than the noise. The line is drawn as one straight segment from the
        start of the season to the end, because twenty-four races cannot support a curve.
      </Caption>
    </Section>
  );
}
