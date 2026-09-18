// MODE1_SPEC §2.5 / §7.4 season slot — EXACT ARITHMETIC. Nothing on this component comes
// from the Monte Carlo above it: a clinch is a fact, an elimination is a fact, and the
// separate heading, separate caption and "arithmetic, not simulation" label are the point
// of the separation (FD4). Sits below TitleOddsSection and brings its own <Section>.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import Disclosure from "@/components/ui/Disclosure";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import Metric from "@/components/ui/Metric";
import Section from "@/components/ui/Section";
import type { TitleClinch, TitleClinchRow } from "@/lib/queries/season";
import { titleOddsEmptyReason } from "@/components/season/TitleOddsSection";

export type MagicNumbersSectionProps = {
  clinch: TitleClinch | null;
  /** rounds of this season already run; picks the empty-state reason */
  completedRounds: number;
  year: number;
};

/** §7.5, verbatim. `{flBonusClause}` is the only conditional token. */
export function magicNumbersCaption(c: TitleClinch): string {
  const maxAvailable = c.rows[0]?.maxAvailable ?? 0;
  const flBonusClause = c.hasFastestLapBonus
    ? " (including one point per race for the fastest lap)"
    : "";
  return (
    `These are arithmetic, not simulation. With ${c.racesLeft} races and ${c.sprintsLeft} sprints ` +
    `to go, ${maxAvailable} points are still on the table${flBonusClause}. A driver more than ` +
    "that behind the leader cannot catch them, whatever happens. A driver exactly that far " +
    "behind is still alive: they would draw level and win on countback. These are facts, not " +
    "forecasts — nothing on this line comes from the simulation above."
  );
}

/** UX_SPEC §3.1 — the StatTile box, now wrapping a <Metric> so every number carries a unit
 *  a fan understands as well as a label. Same border and padding as before. */
function Tile({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border border-grid border-t-2 border-t-accent/70 bg-surface px-4 py-3">
      {children}
    </div>
  );
}

/** "3 races" / "1 race" — §3.3: no "race(s)" reaches the screen. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The leader's clinch arithmetic: the margin form always, the outcome form only when
 *  §2.5 could derive one (never on a sprint round). */
function ClinchHeadline({ c }: { c: TitleClinch }): React.JSX.Element {
  const maxAvailable = c.rows[0]?.maxAvailable ?? 0;
  const leaderPoints = c.rows[0]?.pointsNow ?? 0;
  const rivalPoints = c.rows[1]?.pointsNow ?? 0;
  const margin = leaderPoints - rivalPoints;
  const swing = c.swingNeeded;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile>
        <Metric
          label="Points still available"
          value={maxAvailable}
          unit="points a driver could still win"
          hint={`${plural(c.racesLeft, "race")} worth up to ${c.racePointsMax} points each and ${plural(c.sprintsLeft, "sprint")} worth up to ${c.sprintPointsMax}.`}
        />
      </Tile>
      <Tile>
        <Metric
          label="Leader's margin"
          value={margin}
          unit="points clear of the next driver"
          hint={
            <>
              <DriverChip
                code={c.leader.code}
                teamColour={c.leader.teamColour}
                lineStyle={c.leader.lineStyle}
                size="sm"
              />{" "}
              over the next driver
            </>
          }
        />
      </Tile>
      <Tile>
        <Metric
          label="To clinch next round"
          value={swing === null ? "—" : swing <= 0 ? "already clear" : `+${swing}`}
          unit={
            swing === null || swing <= 0 ? undefined : "more points than the next driver, next round"
          }
          hint={
            c.clinchMarginNeeded === null
              ? "no round left to clinch at"
              : `needs to be more than ${c.clinchMarginNeeded - 1} clear after the next round`
          }
        />
      </Tile>
      <Tile>
        <Metric
          label="Earliest possible clinch"
          value={c.earliestClinchRound === null ? "—" : `R${c.earliestClinchRound}`}
          unit={
            c.earliestClinchRound === null
              ? undefined
              : `round ${c.earliestClinchRound} — the soonest the title can be settled`
          }
          hint={
            c.clinchPosition !== null
              ? `clinches next round by finishing P${c.clinchPosition} or better`
              : c.nextRoundHasSprint
                ? "next round has a sprint, so there is no single finishing position that clinches"
                : "no finishing position clinches at the next round"
          }
        />
      </Tile>
    </div>
  );
}

const COLUMNS: DataTableColumn<TitleClinchRow>[] = [
  {
    key: "driver",
    header: "Driver",
    render: (r) => (
      <DriverChip
        code={r.code}
        teamColour={r.teamColour}
        fullName={r.fullName}
        lineStyle={r.lineStyle}
      />
    ),
  },
  { key: "points", header: "Points", align: "right", className: "tnum", render: (r) => r.pointsNow },
  {
    key: "available",
    header: "Still available",
    align: "right",
    className: "tnum",
    render: (r) => r.maxAvailable,
  },
  {
    key: "ceiling",
    header: "Max possible",
    align: "right",
    className: "tnum",
    render: (r) => r.maxPossibleTotal,
  },
  {
    key: "status",
    header: "Status",
    render: (r) =>
      r.hasClinched ? (
        <span className="font-medium text-fg">Champion</span>
      ) : r.isEliminated ? (
        <span className="text-muted">
          Eliminated{r.eliminatedAtRound !== null ? ` after R${r.eliminatedAtRound}` : ""}
        </span>
      ) : (
        <span className="text-fg">Alive</span>
      ),
  },
];

export default function MagicNumbersSection({
  clinch,
  completedRounds,
  year,
}: MagicNumbersSectionProps): React.JSX.Element {
  if (clinch === null || clinch.rows.length === 0) {
    return (
      <Section title="Magic numbers" caption="Exact arithmetic, not simulation.">
        <EmptyState title="No clinch arithmetic" reason={titleOddsEmptyReason(completedRounds)} />
      </Section>
    );
  }

  const decided = clinch.champion !== null || clinch.racesLeft + clinch.sprintsLeft === 0;
  const alive = clinch.rows.filter((r) => !r.isEliminated).length;
  const eliminated = clinch.rows.length - alive;
  const maxStillAvailable = clinch.rows[0]?.maxAvailable ?? 0;

  return (
    <Section
      title="Magic numbers"
      caption={`Exact arithmetic over the points still on the table, after round ${clinch.afterRound} of ${year}. Not a forecast.`}
      collapsible
      storageKey="season:magic-numbers"
      summary={
        decided
          ? `The ${year} title is already decided — the arithmetic that settled it.`
          : `${maxStillAvailable} points still on the table; ${plural(alive, "driver")} can still win the title.`
      }
    >
      {decided ? (
        <div className="rounded-lg border border-grid bg-surface px-4 py-3 text-sm text-fg">
          {clinch.champion !== null ? (
            <>
              The {year} title is decided:{" "}
              <DriverChip
                code={clinch.champion.code}
                teamColour={clinch.champion.teamColour}
                fullName={clinch.champion.fullName}
                lineStyle={clinch.champion.lineStyle}
              />{" "}
              is champion
              {clinch.clinchedAtRound !== null ? `, clinched after R${clinch.clinchedAtRound}` : ""}.
              Nothing is left to win.
            </>
          ) : (
            <>The {year} season is over: no points remain, so the standings are final.</>
          )}
        </div>
      ) : (
        <ClinchHeadline c={clinch} />
      )}

      {/* §2.2 — the per-driver arithmetic is the evidence behind the tiles above, so it
          starts closed, with the count a reader needs in order to decide to open it. */}
      <Disclosure
        summary={`Every driver's arithmetic — ${plural(alive, "driver")} still mathematically alive, ${eliminated} already out`}
        hint={`${clinch.rows.length} rows`}
        storageKey="season:magic-numbers-table"
      >
        <DataTable
          columns={COLUMNS}
          rows={clinch.rows}
          rowKey={(r) => r.driverId}
          rowClassName={(r) => (r.isEliminated ? "opacity-60" : undefined)}
          dense
          caption={`${plural(alive, "driver")} still mathematically alive, ${eliminated} eliminated. "Still available" is the most points that driver could add; "max possible" is that added to what they have now.`}
        />
      </Disclosure>

      {/* §0 — the caption is NOT shortened. The summary line below is new text written to
          stand in for it while closed; the full wording is inside, unchanged. */}
      <Disclosure
        variant="inline"
        summary={`Arithmetic, not a forecast: ${maxStillAvailable} points are still on the table, and that is what rules a driver out. How it is worked out.`}
        storageKey="season:magic-numbers-method"
      >
        {magicNumbersCaption(clinch)}
      </Disclosure>
    </Section>
  );
}
