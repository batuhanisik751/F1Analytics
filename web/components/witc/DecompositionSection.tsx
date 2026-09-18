// MODE2_SPEC §8.6 slot 2 + slot 4 — the decomposition chart, the island treatment for
// every floating team in that season, and caption C-WITC-2 (VERBATIM).
//
// §1.4 governs this block: for a floating component (K3 Aston Martin, K4 McLaren) the
// page must SAY IN WORDS that the model cannot separate car from driver, and must not
// present a confident split for them. The by-analogy rows stay on the chart — hatched,
// with their fuzzy boundary — and the words sit directly above the chart so that a
// screenshot of either one is still honest.
//
// UX_SPEC §1.1 / §2.2 — the explanation used to be printed VERBATIM once per affected team
// and then restated a third time as C-WITC-2 under the chart. It is now: one shared explainer
// (IslandExplainer, open, above the chart, carrying C-WITC-2 verbatim including the four
// floating drivers and the "we borrow the level from the rest of the grid" admission), plus a
// one-liner per team that states that team's refusal and opens onto its full, unshortened text.
// §0: nothing here was shortened or deleted, only de-duplicated in presentation.
import CannotSeparate from "@/components/constructor/CannotSeparate";
import DecompositionBar, { type DecompositionRow } from "@/components/charts/DecompositionBar";
import EmptyState from "@/components/ui/EmptyState";
import IslandExplainer from "@/components/witc/IslandExplainer";
import Section from "@/components/ui/Section";

export type IslandTeam = {
  teamId: string;
  teamName: string;
  drivers: string[];
  /** Rendered as "What is measured", e.g. the within-island team-mate gap. */
  measuredInstead?: React.ReactNode;
};

export type DecompositionSectionProps = {
  year: number;
  rows: DecompositionRow[];
  /** Floating teams present in this season, derived from `basis === 'by-analogy'`. */
  islands: IslandTeam[];
  emptyReason?: string;
};

export default function DecompositionSection({
  year,
  rows,
  islands,
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: DecompositionSectionProps): React.JSX.Element {
  return (
    <Section
      title={`Car and driver, ${year}`}
      caption="Each bar splits a driver's pace into the part the model attributes to the car and the part it attributes to the driver. The boundary is drawn as a blur because that is how well it is known."
    >
      {/* Open, always: §2.2 puts "anything stating a limit on interpretation a reader would
          otherwise act wrongly on" in the OPEN column, and §0 forbids default-closing a refusal.
          Rendered even with no floating team this season — C-WITC-2 is a statement about the
          whole 2024–2026 fit, not about one season's line-up. */}
      <IslandExplainer teams={islands} className="mb-4" />

      {islands.length > 0 ? (
        <div className="mb-4">
          {islands.map((t) => (
            <CannotSeparate
              key={t.teamId}
              variant="summary"
              teamName={t.teamName}
              drivers={t.drivers}
              measuredInstead={t.measuredInstead}
            />
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? <EmptyState reason={emptyReason} /> : <DecompositionBar rows={rows} />}
    </Section>
  );
}
