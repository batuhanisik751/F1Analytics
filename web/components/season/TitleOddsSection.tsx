// MODE1_SPEC §7.4 season slot — SIMULATED title probability (§2.4). This half of the page
// is a forecast: every number on it comes from the Monte Carlo and carries a band. The
// exact arithmetic lives in MagicNumbersSection below, under its own heading (FD4).
//
// This component brings its own <Section> heading, so the page drops it in unwrapped.
import TitleOddsLines, {
  type TitleOddsLineSeries,
} from "@/components/charts/TitleOddsLines";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";
import { correlationGloss } from "@/components/ui/metricFormat";
import type { TitleOdds } from "@/lib/queries/season";

export type TitleOddsSectionProps = {
  odds: TitleOdds | null;
  /** rounds of this season already run; picks the §7.6 empty-state reason */
  completedRounds: number;
  /** rounds still to come; 0 makes the chart a retrospective rather than a forecast */
  remainingRounds: number;
};

/** §7.6: which of the two reasons applies when there are no odds rows. */
export function titleOddsEmptyReason(completedRounds: number): string {
  return completedRounds === 0
    ? "no rounds have been run in this season yet"
    : "not enough completed races to fit a driver-strength model";
}

export default function TitleOddsSection({
  odds,
  completedRounds,
  remainingRounds,
}: TitleOddsSectionProps): React.JSX.Element {
  if (odds === null || odds.series.length === 0 || odds.rounds.length === 0) {
    return (
      <Section title="Title odds">
        <EmptyState title="No title odds" reason={titleOddsEmptyReason(completedRounds)} />
      </Section>
    );
  }

  const chartSeries: TitleOddsLineSeries[] = odds.series.map((s) => ({
    driverId: s.driverId,
    code: s.code,
    colour: s.teamColour,
    p: s.p,
    pLo: s.pLo,
    pHi: s.pHi,
  }));
  const draws = odds.draws.toLocaleString("en-US");
  const decided = remainingRounds === 0;

  return (
    <Section
      title="Title odds"
      caption={
        decided
          ? "This season is complete: the chart is a retrospective of how the title race moved, not a forecast."
          : "Simulated — a forecast, with a band. The exact arithmetic is below."
      }
      collapsible
      storageKey="season:title-odds"
      summary={
        decided
          ? `How the title race moved, round by round, across ${odds.rounds.length} rounds. A retrospective, not a forecast.`
          : `Each driver's chance of winning the title, from ${draws} simulated seasons. A forecast, with a range.`
      }
    >
      <div className="rounded-lg border border-grid bg-surface p-3">
        <TitleOddsLines
          rounds={odds.rounds}
          series={chartSeries}
          othersCombined={odds.othersCombined}
        />
        {/* §2.2 — a limit a reader would otherwise act wrongly on stays in the open. Only the
            method behind it is collapsed, and it is collapsed WHOLE, not shortened (§0). */}
        <p className="mt-2 text-xs leading-relaxed text-fg">
          Read the band, not the line: it shows how unsure the model is, not how close the drivers
          are. And this model is beaten at picking a finishing order by simply ranking drivers by
          where they start ({`0.76 against 0.65 on a 0–1 scale — ${correlationGloss(0.76)}`}). A
          future race has no starting grid yet, which is the only reason we do not use that here.
        </p>
        <Disclosure
          variant="inline"
          summary={`How these odds are made: ${draws} simulated seasons after every round, and what the band really measures.`}
          storageKey="season:title-odds-method"
        >
        <Caption>
          {`After every round we simulate the rest of the season ${draws} times: a finishing order drawn from each driver's current form, a retirement risk, and that season's points for every remaining race and sprint. The shaded band is `}
          <strong>not</strong>
          {` simulation noise — with ${draws} draws that would be under a percentage point. It is the uncertainty in the driver-strength model itself, measured by refitting it ${odds.bootstrapRefits} times on resampled history. Worth knowing: simply ordering drivers by where they start beats this form model at predicting a finish (rank correlation 0.76 against 0.65). We cannot use that here, because a future race has no starting grid yet.`}
        </Caption>
        </Disclosure>
      </div>
    </Section>
  );
}
