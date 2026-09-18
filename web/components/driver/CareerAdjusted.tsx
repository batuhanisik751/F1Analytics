// MODE2_SPEC §8.5 slot 4 — car-adjusted career. Captions C-CAREER-1 / C-CAREER-2 verbatim.
// Every bar carries its interval (FD2). A `by-analogy` season is hatched and shows the
// range only: its point estimate is not rendered as a plain number (§8.4).
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import type { CareerSeasonRow } from "@/lib/queries/mode2";
import { ASSUMED_CHIP_TEXT, GrammarChip, HATCH_BACKGROUND } from "./mode2Grammar";

function Bar({
  value,
  lo,
  hi,
  max,
  assumed,
  tone,
}: {
  value: number;
  lo: number;
  hi: number;
  max: number;
  assumed: boolean;
  tone: string;
}): React.JSX.Element {
  const pct = (v: number): number => Math.max(0, Math.min(100, (v / max) * 100));
  return (
    <div className="relative h-5 w-full rounded bg-bg/60" aria-hidden="true">
      <div
        className="absolute inset-y-0 rounded"
        style={{
          width: `${pct(value)}%`,
          backgroundColor: assumed ? "transparent" : tone,
          backgroundImage: assumed ? HATCH_BACKGROUND : undefined,
          border: assumed ? "1px dashed rgba(232,163,61,0.8)" : undefined,
          opacity: assumed ? 1 : 0.9,
        }}
      />
      <div
        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-fg/70"
        style={{ left: `${pct(lo)}%`, width: `${Math.max(pct(hi) - pct(lo), 0.5)}%` }}
      />
    </div>
  );
}

/** Signed points, one decimal, with the project's minus sign. */
const pts = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

/**
 * A seat that covered less than half its season is not a season. The replay runs the
 * whole calendar for everybody (that is what "replayed in this car" means), so for a
 * two-race stand-in it produces a championship he never contested — printed, as it was,
 * beside the handful of points he really scored. §4.2 wants the fan to read the gap
 * between those two numbers as the simulator's error; here it would be a category
 * mismatch instead, so the comparison is withheld and the fact is kept.
 */
const MIN_SEASON_SHARE = 0.5;

export type CareerAdjustedProps = { rows: CareerSeasonRow[] };

export default function CareerAdjusted({ rows }: CareerAdjustedProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Car-adjusted career"
        reason="partial: no calibrated season for this driver"
      />
    );
  }
  // A part-season entry draws no bars, so its full-calendar replay must not set the
  // scale the real seasons are drawn against.
  const drawn = rows.filter((r) => r.starts >= r.roundsInSeason * MIN_SEASON_SHARE);
  const max = Math.max(
    ...(drawn.length ? drawn : rows).flatMap((r) => [r.replayHi, r.avgDriverP90, r.actualPoints]),
    1,
  );
  const mae = Math.max(...rows.map((r) => r.calibrationMae));
  return (
    <>
      <div className="space-y-4">
        {rows.map((r) => {
          const assumed = r.basis === "by-analogy";
          const partial = r.starts < r.roundsInSeason * MIN_SEASON_SHARE;
          const shared = r.teams.includes(",");
          const seat = `${r.starts} of ${r.roundsInSeason} rounds`;
          const straddles = r.contributionLo < 0 && r.contributionHi > 0;
          return (
            <div
              key={r.year}
              data-year={r.year}
              data-basis={r.basis}
              className="rounded-lg border border-grid bg-surface px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-fg">
                  {r.year} <span className="text-muted">{r.teams}</span>
                  {r.starts < r.roundsInSeason ? (
                    <span className="ml-2 text-xs font-normal text-muted">· {seat}</span>
                  ) : null}
                </span>
                {partial ? (
                  <GrammarChip>part season, not replayed</GrammarChip>
                ) : assumed ? (
                  <GrammarChip hatched>{ASSUMED_CHIP_TEXT}</GrammarChip>
                ) : (
                  /* FD2: the headline of this card is a difference of two simulator
                     outputs, so it is rendered as its band with the point muted under
                     it -- and when the band straddles zero the card says so in words
                     rather than leaving a sign the model cannot support. */
                  <span className="tnum text-sm text-fg">
                    {pts(r.contributionLo)} to {pts(r.contributionHi)} points of driver contribution
                    <span className="ml-2 text-xs text-muted">
                      {straddles ? "— we cannot tell whether he added or cost points" : `middle ${pts(r.contribution)}`}
                    </span>
                  </span>
                )}
              </div>
              {partial ? (
                <div className="mt-3 grid gap-2 text-xs text-muted">
                  <p className="leading-relaxed">
                    {`This seat covered ${seat}${shared ? ` across ${r.teams.split(", ").length} cars` : ""}. `}
                    A car-adjusted season replays the whole calendar, so there is no
                    full-season total here that belongs beside what he actually scored.
                  </p>
                  <div className="tnum pt-1 text-muted">
                    Actually scored: {r.actualPoints.toFixed(0)} points.
                  </div>
                </div>
              ) : (
              <div className="mt-3 grid gap-2 text-xs text-muted">
                <div>
                  <div className="mb-1 flex justify-between">
                    <span>This driver, replayed in this car</span>
                    <span className="tnum">
                      {assumed
                        ? `somewhere between ${r.replayLo.toFixed(0)} and ${r.replayHi.toFixed(0)} points`
                        : `${r.replayPoints.toFixed(0)} pts (${r.replayLo.toFixed(0)}–${r.replayHi.toFixed(0)})`}
                    </span>
                  </div>
                  <Bar value={r.replayPoints} lo={r.replayLo} hi={r.replayHi} max={max} assumed={assumed} tone="#E10600" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between">
                    <span>An average 2024–2026 driver in the same car</span>
                    {/* §8.4 rule 5: on a by-analogy card no point estimate is
                        rendered at all. This total is driven entirely by the island
                        car's level, which is the one quantity the island contains no
                        information about, so it is the LAST number that may stay
                        crisp here. */}
                    <span className="tnum">
                      {assumed
                        ? `somewhere between ${r.avgDriverP10.toFixed(0)} and ${r.avgDriverP90.toFixed(0)} points`
                        : `${r.avgDriverPoints.toFixed(0)} pts (${r.avgDriverP10.toFixed(0)}–${r.avgDriverP90.toFixed(0)})`}
                    </span>
                  </div>
                  <Bar value={r.avgDriverPoints} lo={r.avgDriverP10} hi={r.avgDriverP90} max={max} assumed={assumed} tone="#3c7fd6" />
                </div>
                <div className="tnum pt-1 text-muted">
                  Actually scored: {r.actualPoints.toFixed(0)} points.
                </div>
              </div>
              )}
            </div>
          );
        })}
      </div>
      <Caption>
        &ldquo;Average driver&rdquo; means a driver at exactly the middle of this era&apos;s field,
        put in the same car, with every other seat on the grid left alone. Both bars come from the
        same simulator, so the difference between them is the driver and nothing else. The real
        points total is shown beside them as a separate fact, because it is one.
      </Caption>
      <Caption>
        Our simulator, replaying the real season with the real drivers in the real cars, still
        misses real points totals by about {mae.toFixed(1)} points. Every band on this chart is at
        least that wide, and almost all of its width comes from uncertainty about the driver and
        car ratings rather than from the race-by-race dice.
      </Caption>
    </>
  );
}
