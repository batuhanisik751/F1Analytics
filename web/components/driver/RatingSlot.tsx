// MODE2_SPEC §8.5 slot 1 — driver rating. Captions C-RATING-1 / C-RATING-2 are verbatim.
import RatingBar from "@/components/charts/RatingBar";
import { prettyDriver } from "@/components/constructor/names";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Metric from "@/components/ui/Metric";
import TermTip from "@/components/ui/TermTip";
import { ppSecondsHint } from "@/components/ui/metricFormat";
import type { DriverRating, FitMeta } from "@/lib/queries/mode2";
import { FLOATING_CHIP_TEXT, GrammarChip, formatPpValue } from "./mode2Grammar";

/** The StatTile frame these tiles used to have, kept so the row looks unchanged (§0). */
const TILE = "border border-grid border-t-2 border-t-accent/70 bg-surface px-4 py-3";

export type RatingSlotProps = {
  rating: DriverRating | null;
  fit: FitMeta | null;
  driverLabel: string;
  teamColour?: string;
  /**
   * §8.5 slot 1 draws this driver AMONG his component peers, because a rating means
   * nothing except as a position inside the component that earned it (§1.4, FD3). Empty
   * or absent falls back to the single bar, and the chart never needs the §8.4 separator
   * either way: one component is on screen by construction.
   */
  peers?: DriverRating[];
};

export default function RatingSlot({
  rating,
  fit,
  driverLabel,
  teamColour,
  peers = [],
}: RatingSlotProps): React.JSX.Element {
  if (!fit) {
    return <EmptyState title="Driver rating" reason="partial: the driver-car model has not been fitted yet" />;
  }
  if (!rating) {
    return <EmptyState title="Driver rating" reason="partial: no usable race pace for this driver" />;
  }
  const floating = rating.anchorClass === "floating";
  // One component only, so componentId never changes down the list and the separator
  // has nothing to separate — hence showSeparator={false} below, not a suppression.
  const shown = peers.length > 0 ? peers : [rating];
  const rows = shown.map((r) => ({
    driverId: r.driverId,
    label: r.driverId === rating.driverId ? driverLabel : prettyDriver(r.driverId),
    colour: r.driverId === rating.driverId ? teamColour : undefined,
    ratingPp: r.ratingPp,
    ratingLo: r.ratingLo,
    ratingHi: r.ratingHi,
    sdWithin: r.sdWithin,
    sdIsland: r.sdIsland,
    sdTotal: r.sdTotal,
    fracFloating: r.fracFloating,
    anchorClass: r.anchorClass,
    basis: r.basis,
    componentId: r.componentId,
    componentLabel: r.componentLabel,
  }));
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={TILE}>
          <Metric
            label="Driver level vs the 2024-2026 average"
            term="pp"
            value={
              floating ? <GrammarChip hatched>{FLOATING_CHIP_TEXT}</GrammarChip> : formatPpValue(rating.ratingPp)
            }
            unit={floating ? undefined : "% of a lap"}
            hint={
              floating
                ? "No number is shown because nothing in the window separates this driver from his car."
                : ppSecondsHint(rating.ratingPp)
            }
          />
        </div>
        <div className={TILE}>
          <Metric
            label="5th-95th percentile range"
            term="percentile-range"
            value={`${formatPpValue(rating.ratingLo)} to ${formatPpValue(rating.ratingHi)}`}
            unit="% of a lap"
            hint={
              <>
                {/* §1.2: "Total SD 0.120 pp, of which 50.8 % rests on the pooling prior" was
                    two undefined terms and a second unit for one value. Both terms survive,
                    named in words with their definitions attached (§0: explain, never drop). */}
                The figure above is typically within {rating.sdTotal.toFixed(3)} % of a lap of the
                true value &mdash; its <TermTip term="total-sd">total SD</TermTip>, about{" "}
                {Math.abs((rating.sdTotal / 100) * 90).toFixed(2)} s on a 90-second lap.{" "}
                {(rating.fracFloating * 100).toFixed(1)} % of that uncertainty comes from the
                model&apos;s cautious starting guess for drivers with thin evidence (the{" "}
                <TermTip term="pooling-prior">pooling prior</TermTip>) rather than from laps.
              </>
            }
          />
        </div>
        <div className={TILE}>
          <Metric
            label={`Rank within ${rating.componentLabel}`}
            term="component-anchored"
            value={`${rating.rankInComponent} of ${rating.componentSize}`}
            hint={
              <>
                Ranked only against the {rating.componentSize} drivers a chain of team moves
                connects him to, and against nobody else &mdash; the model calls that{" "}
                <TermTip term="component-anchored">{rating.anchorClass}</TermTip>.
              </>
            }
          />
        </div>
      </div>
      <div className="mt-4">
        <RatingBar
          rows={rows}
          ciLevel={fit.ciLevel}
          highlightDriverId={rating.driverId}
          showSeparator={false}
        />
      </div>
      <Caption>
        This is how much faster or slower than the average 2024&ndash;2026 driver we estimate this
        driver to be, once the car has been accounted for, in percent of a lap &mdash; about 0.9
        seconds per 1 % at a 90-second circuit. It is fitted on fuel-corrected race pace from{" "}
        {fit.nSessions} races between 2024 and 2026 and on nothing else. It says nothing about any
        other era, any other rule set, or this driver before 2024, and it is not an all-time
        ranking. The bar shows the 5th&ndash;95th percentile range.
      </Caption>
      {floating ? (
        <Caption className="border-l-2 border-accent/60 pl-3">
          We cannot measure this driver&apos;s level. He has never changed team, and neither has his
          team-mate, so nothing in 2024&ndash;2026 separates how good he is from how good his car
          was. The number you see is what the model assumes when it has no evidence: that his
          team&apos;s two drivers are an ordinary pair. More races will not fix this. A transfer
          would.
        </Caption>
      ) : null}
    </>
  );
}
