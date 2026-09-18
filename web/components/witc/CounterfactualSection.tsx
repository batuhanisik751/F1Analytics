// MODE2_SPEC §8.6 slot 5 — the counterfactual block: the control, then the card. The
// section is the LAST thing on the page: the grid-wide answer and its caveats are read
// before the toy (§8.6, "order is deliberate").
import CounterfactualCard from "@/components/witc/CounterfactualCard";
import CounterfactualControl, {
  type CounterfactualOption,
} from "@/components/witc/CounterfactualControl";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";
import type { CounterfactualRow } from "@/lib/queries/mode2";

export type CounterfactualSectionProps = {
  year: number;
  drivers: CounterfactualOption[];
  teams: CounterfactualOption[];
  selectedDriver: string | null;
  selectedTeam: string | null;
  driverName: string;
  teamName: string;
  incumbentName: string;
  row: CounterfactualRow | null;
  /** True when the grid was truncated at MODE2_CF_MAX_SCENARIOS (§8.8). */
  truncated?: boolean;
  emptyReason?: string;
};

export default function CounterfactualSection({
  year,
  drivers,
  teams,
  selectedDriver,
  selectedTeam,
  driverName,
  teamName,
  incumbentName,
  row,
  truncated = false,
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: CounterfactualSectionProps): React.JSX.Element {
  const chosen = selectedDriver !== null && selectedTeam !== null;

  return (
    <Section
      title="What if he had driven that car?"
      caption="A model implication, not a prediction. Pick a driver and a car from this season."
      collapsible
      storageKey="witc:counterfactual"
      summary={`Put any ${year} driver in any ${year} car and see the range of points the model implies — a model implication, not a prediction.`}
    >
      <CounterfactualControl
        year={year}
        drivers={drivers}
        teams={teams}
        selectedDriver={selectedDriver}
        selectedTeam={selectedTeam}
      />

      <div className="mt-4">
        {drivers.length === 0 || teams.length === 0 ? (
          <EmptyState reason={emptyReason} />
        ) : !chosen ? (
          <EmptyState
            title="Nothing selected"
            reason={null}
          >
            Pick a driver and a car above. We do not choose one for you: the pairing you
            see first is the one you are most likely to quote.
          </EmptyState>
        ) : row === null ? (
          <EmptyState title="That pairing is not precomputed" reason="partial: no counterfactual row for this pairing">
            Some combinations are not precomputed yet.
          </EmptyState>
        ) : (
          <CounterfactualCard
            row={row}
            driverName={driverName}
            teamName={teamName}
            incumbentName={incumbentName}
          />
        )}
      </div>

      {truncated ? <Caption>Some combinations are not precomputed yet.</Caption> : null}
    </Section>
  );
}
