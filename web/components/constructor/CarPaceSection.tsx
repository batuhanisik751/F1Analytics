// MODE2_SPEC §5.1 slot 2 / §5.2 — car pace rating: a StatTile row for the highlighted
// season, then the bars across every season the team raced. Caption C-CAR-1 is VERBATIM.
import CannotSeparate from "@/components/constructor/CannotSeparate";
import CarPaceBars, { type CarPaceRow } from "@/components/charts/CarPaceBars";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Metric, { ppSecondsHint } from "@/components/ui/Metric";
import Section from "@/components/ui/Section";

export type CarPaceSectionProps = {
  teamName: string;
  rows: CarPaceRow[];
  /** Season whose tiles are shown; null falls back to the newest row. */
  season: number | null;
  ciLevel: number;
  /** Drivers of the floating component, for the island note. */
  islandDrivers?: string[];
  /**
   * The StatTile row and the island note describe ONE car. On the index every row is a
   * different constructor, so there is no such car: the "focus" row would be whichever
   * car happens to be P1, and its interval and its island note would be printed with no
   * team named anywhere near them. §8.5 gives the index bars and a caption, nothing
   * else — so the index passes `showFocus={false}` and the per-team page leaves it true.
   */
  showFocus?: boolean;
  emptyReason?: string;
};

const pp = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)} %`;
/** §3.3 one value, one unit: the bare number, for a <Metric> whose `unit` already says "% of a lap". */
const ppNum = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;

/** UX_SPEC §3.3 — "P3" is timing-screen shorthand; a reader wants "3rd quickest car". */
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
const ordinal = (n: number): string =>
  ORDINALS[n] ?? `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/** The tile shell StatTile draws, wrapped around a <Metric> so §3.1's four parts survive. */
const TILE = "border border-grid border-t-2 border-t-accent/70 bg-surface px-4 py-3";

export default function CarPaceSection({
  teamName,
  rows,
  season,
  ciLevel,
  islandDrivers = [],
  showFocus = true,
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: CarPaceSectionProps): React.JSX.Element {
  const level = Math.round(ciLevel * 100);
  const focus = showFocus
    ? (rows.find((r) => r.year === season) ?? rows[rows.length - 1] ?? null)
    : null;
  const assumed = focus?.basis === "by-analogy";

  return (
    <Section
      title="Car pace"
      caption="The car's pace with driver effects removed by the model, in percent of the race centre lap. Negative is faster."
      collapsible
      storageKey="constructor:car-pace"
      summary={
        focus
          ? `${teamName} in ${focus.year}: ${assumed ? "level not measured" : `${pp(focus.gammaPp)} of a lap, ${ordinal(focus.rankInSeason)} quickest`}, over ${focus.nRaces} races.`
          : `Car pace across ${rows.length} car-season${rows.length === 1 ? "" : "s"}, each against its own season's field.`
      }
    >
      {rows.length === 0 ? (
        <EmptyState reason={emptyReason} />
      ) : (
        <>
          {focus && assumed ? (
            <CannotSeparate
              teamName={teamName}
              drivers={islandDrivers}
              measuredInstead={`the gap between ${teamName}'s own two drivers, and nothing about how the car compares with the rest of the grid.`}
              className="mb-4"
            />
          ) : null}
          {focus ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric
              className={TILE}
              label={`${focus.year} car rating`}
              term="pp"
              value={
                assumed ? (
                  <span className="rounded-full border border-dashed border-accent/70 px-2 py-0.5 text-sm font-medium text-accent">
                    level not measured
                  </span>
                ) : (
                  ppNum(focus.gammaPp)
                )
              }
              unit={assumed ? undefined : "% of a lap · negative is faster"}
              interval={`${pp(focus.gammaLo)} to ${pp(focus.gammaHi)}`}
              intervalLabel={`${level} % range (5th\u201395th percentile)`}
              hint={
                assumed
                  ? "No level is shown because none was measured; see the note above."
                  : `${ppSecondsHint(focus.gammaPp)}, measured against the rest of the ${focus.year} field.`
              }
            />
            <Metric
              className={TILE}
              label={`Where it ranked in ${focus.year}`}
              value={assumed ? "\u2014" : ordinal(focus.rankInSeason)}
              unit={assumed ? undefined : `quickest car of ${focus.year}`}
              hint={`Within that season's field only \u2014 never against another season. A ${focus.year} car and a 2024 car are ranked on different grids.`}
            />
            <Metric
              className={TILE}
              label="Races behind it"
              value={focus.nRaces}
              unit="race sessions"
              hint={`The ${focus.year} races this rating was fitted on. Fewer races means a wider range above.`}
            />
          </div>
          ) : null}
          <div className="mt-4">
            <CarPaceBars rows={rows} ciLevel={ciLevel} />
          </div>
        </>
      )}
      <Caption>
        Car ratings are measured against the rest of that season&apos;s field, not against
        other seasons. A car at −1.8 % in 2026 was further clear of its own rivals than a
        car at −0.8 % in 2024; it does not mean it was a second a lap quicker in absolute
        terms. Driver effects have been removed by the model, not by averaging, so a
        mid-season driver change cannot show up here as car performance.
      </Caption>
    </Section>
  );
}
