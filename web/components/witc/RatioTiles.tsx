// MODE2_SPEC §8.6 slot 3 — the stat-tile row: the car:driver spread as an SD RATIO
// (never a variance ratio, §8.4.7), the race-to-race noise, and the number of groups the
// model cannot compare across. Captions C-WITC-3 and C-WITC-4 are VERBATIM.
//
// UX_SPEC §3.1 — the three tiles render through <Metric>, so each one carries a unit a fan
// understands, a definition reachable by hover AND keyboard AND tap, and its interval with a
// label ("90 % range"), instead of a bare numeral over a caps micro-label. §3.3 — "% of a lap"
// is the unit, and every share of a lap states its seconds equivalent at the 90-second
// reference lap. §2.2 keeps this section OPEN: it is the answer the page is named after.
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Metric from "@/components/ui/Metric";
import Section from "@/components/ui/Section";
import type { FitMeta } from "@/lib/queries/mode2";

export type RatioTilesProps = {
  fit: FitMeta | null;
  /** Seconds per pp on the reference lap: 1 pp ≈ 0.90 s on a 90-second lap (§0.4). */
  secondsPerPp?: number;
};

/** The tile shell: the same border and background StatTile draws, around a <Metric>. */
const TILE = "border border-grid border-t-2 border-t-accent/70 bg-surface px-4 py-3";

export default function RatioTiles({
  fit,
  secondsPerPp = 0.9,
}: RatioTilesProps): React.JSX.Element {
  if (!fit) {
    return (
      <Section title="How much of it is the car?">
        <EmptyState reason="partial: the driver-car model has not been fitted yet" />
      </Section>
    );
  }

  const secNum = (pp: number): string => (pp * secondsPerPp).toFixed(2);
  const sec = (pp: number): string => `${secNum(pp)} s`;
  const sdRatio = fit.sdRatio.toFixed(1);
  const sdRatioLo = fit.sdRatioLo.toFixed(1);
  const sdRatioHi = fit.sdRatioHi.toFixed(1);

  return (
    <Section
      title="How much of it is the car?"
      caption="Spreads, not single cars: how far apart the cars are compared with how far apart the drivers are."
      collapsible
      storageKey="witc:spread"
      summary={`The cars are about ${sdRatio}× as spread out as the drivers (${sdRatioLo}× to ${sdRatioHi}×).`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric
          className={TILE}
          label="Car spread vs driver spread"
          term="percentile-range"
          value={`${sdRatio}×`}
          unit="times as wide"
          interval={`${sdRatioLo}× to ${sdRatioHi}×`}
          intervalLabel="90 % range (5th–95th percentile)"
          hint="Spreads, compared as standard deviations: how far apart the cars are, divided by how far apart the drivers are. Above 1× means the car matters more than the driver."
        />
        <Metric
          className={TILE}
          label="Race-to-race noise"
          term="pp"
          value={fit.sigmaResid.toFixed(3)}
          unit="% of a lap"
          hint={`≈ ${sec(fit.sigmaResid)} on a 90-second lap, after car, driver and development — how much the same driver in the same car swings from one race to the next.`}
        />
        <Metric
          className={TILE}
          label="Groups we cannot compare across"
          term="island-driver"
          value={fit.nComponents}
          unit="separate groups of drivers"
          hint={`${fit.nDrivers} drivers, ${fit.nRows} race-driver rows in the fit. Drivers inside one group can be ranked against each other; a driver in one group cannot be ranked against a driver in another.`}
        />
      </div>
      <Caption>
        Across 2024–2026, the spread between the fastest and slowest cars is about{" "}
        {sdRatio}× the spread between the fastest and slowest drivers — roughly{" "}
        {secNum(fit.tauCar)} versus {secNum(fit.tauDriver)} seconds a lap at a 90-second
        circuit. That comparison is itself uncertain: it could be as little as {sdRatioLo}×
        or as much as {sdRatioHi}×.
      </Caption>
      <Caption>
        A single race tells you much less than it looks like. After the car, the driver and
        in-season development are all accounted for, the same driver in the same car still
        varies by about {fit.sigmaResid.toFixed(3)} % of a lap from race to race — more
        than the entire spread between the best and worst drivers on the grid.
      </Caption>
    </Section>
  );
}
