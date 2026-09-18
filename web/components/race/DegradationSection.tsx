// SPEC §4.3 item 5 — DegradationScatter + collapsed per-stint table + notebook §7 caption.
import DegradationScatter from "@/components/charts/DegradationScatter";
import DegradationTable from "@/components/race/DegradationTable";
import CompoundChip from "@/components/ui/CompoundChip";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import type {
  CompoundFit,
  DegFitRow,
  DegPoint,
  OptimalStintRow,
} from "@/lib/queries/race";
import type { ColourMap } from "@/lib/queries/shared";

export type DegradationSectionProps = {
  points: DegPoint[];
  fits: CompoundFit[];
  perStint: DegFitRow[];
  colours: ColourMap;
  year: number;
  /** MODE1_SPEC §4.4 / §7.3 — the optimal-stint readout; default [] keeps v1 callers valid. */
  optimalStint?: OptimalStintRow[];
  /** §7.6 — which of the three optimal-stint empty reasons applies. */
  optimalStintReason?: string | null;
  reason?: string | null;
};

/**
 * UX_SPEC §0/§2.2 — NEW copy. A line that stays in the open so a reader who never opens the
 * method note is still warned not to read these slopes as pure tyre wear.
 */
export const DEGRADATION_LEAD =
  "These lines are not pure tyre wear: the track itself gets faster through a race, and each compound runs at a different point in that. A soft line that slopes downwards usually means the track was improving, not that the tyre got quicker.";

export const DEGRADATION_CAPTION =
  "Pooled slopes are confounded by track evolution: softs run short and early while the track is still rubbering in, so a negative soft slope means the track was getting faster, not the tyre; hards run long and late on a track at its best, so their slope is closest to true degradation. Per-stint standard errors are the guard rail — a confident-looking slope fitted to six noisy laps is not a finding.";

/** Compound colours come from the rows this section already has, never from a literal. */
function compoundColourMap(fits: CompoundFit[], perStint: DegFitRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of fits) map[f.compound] = f.compoundColour;
  for (const r of perStint) if (!map[r.compound]) map[r.compound] = r.compoundColour;
  return map;
}

// §7.6 — the three optimal-stint empty reasons, verbatim. The caller picks which applies.
export const OPTIMAL_STINT_NO_FITS_REASON = "no dry-tyre degradation fits in this race";
export const OPTIMAL_STINT_FLAT_SLOPE_REASON =
  "degradation too small to estimate a break-even";
export const OPTIMAL_STINT_NO_PIT_LOSS_REASON = "no pit-loss estimate for this circuit";

/** §3.3 — the stored `pit_loss_source` / `slope_source` values, in English. */
export const PIT_LOSS_SOURCE_WORDS: Record<OptimalStintRow["pitLossSource"], string> = {
  circuit: "typical for this circuit",
  pooled: "averaged over every ingested race",
};

export const SLOPE_SOURCE_WORDS: Record<string, string> = {
  session: "measured in this race",
  pooled: "borrowed from other races",
};

function lapsText(r: OptimalStintRow): string {
  return `${r.optimalLaps.toFixed(1)} laps (${Math.round(r.optimalLapsLo)}\u2013${Math.round(r.optimalLapsHi)})`;
}

/**
 * A stint this short is a splash or a damage-limitation stop, not a degradation-limited
 * one, so quoting it as "the race said N" misattributes the gap the caption explains.
 */
export const OPTIMAL_STINT_CAPTION_MIN_ACTUAL_LAPS = 10;

/**
 * Which compound row supplies the §7.5 caption's tokens.
 *
 * Not the row with the most fits: a pooled slope carries hundreds of database-wide fits
 * while a session-restricted slope carries tens, so fit count reliably selects the row
 * whose wear rate was *not* measured in this race. The caption's whole argument is about
 * the stints this race actually ran, so the row is picked on evidence about this race:
 * a real stint first, then a slope fitted on this session, then the compound the race
 * spent the most laps on.
 */
export function optimalStintCaptionRow(rows: OptimalStintRow[]): OptimalStintRow | undefined {
  const substantial = rows.filter(
    (r) => (r.actualMedianLaps ?? 0) > OPTIMAL_STINT_CAPTION_MIN_ACTUAL_LAPS,
  );
  const pool = substantial.length > 0 ? substantial : rows;
  return [...pool].sort(
    (a, b) =>
      (a.slopeSource === "session" ? 0 : 1) - (b.slopeSource === "session" ? 0 : 1) ||
      (b.actualMedianLaps ?? 0) - (a.actualMedianLaps ?? 0) ||
      b.nFits - a.nFits,
  )[0];
}

/** §7.5 verbatim; the tokens come from the best-evidenced compound row. */
export function optimalStintCaption(rows: OptimalStintRow[]): string {
  const best = optimalStintCaptionRow(rows);
  const pitLossS = best ? best.pitLossS.toFixed(1) : "\u2014";
  const optimalLaps = best ? best.optimalLaps.toFixed(1) : "\u2014";
  const actual =
    best && best.actualMedianLaps !== null ? `${Math.round(best.actualMedianLaps)}` : "\u2014";
  return (
    `Pure lap-time break-even: the stint length at which one more lap on worn tyres costs ` +
    `more than the ${pitLossS} seconds a pit stop costs. It is not a strategy. It assumes ` +
    `degradation is a straight line (it is not \u2014 that is what the tyre-cliff detector is ` +
    `for), a free choice of compound, no two-compound rule, no traffic, no safety car, and ` +
    `the circuit\u2019s average pit loss. It also runs long for a reason worth knowing: the wear ` +
    `rate is fitted on the stints teams actually ran, and those stints end *before* the ` +
    `tyre falls off, so the wear looks gentler than it is. That is why the clock says ` +
    `${optimalLaps} laps and the race said ${actual}.`
  );
}

function optimalStintColumns(
  compoundColours: Record<string, string>,
): DataTableColumn<OptimalStintRow>[] {
  return [
    {
      key: "compound",
      header: "Compound",
      render: (r) =>
        compoundColours[r.compound] ? (
          <CompoundChip compound={r.compound} colour={compoundColours[r.compound]} />
        ) : (
          <span className="font-medium">{r.compound}</span>
        ),
    },
    {
      key: "optimal",
      header: "Break-even stint",
      align: "right",
      className: "tnum",
      render: (r) => lapsText(r),
    },
    {
      key: "actual",
      header: "Actually run",
      align: "right",
      className: "tnum text-muted",
      render: (r) =>
        r.actualMedianLaps === null
          ? "\u2014"
          : `median ${Math.round(r.actualMedianLaps)} laps`,
    },
    {
      key: "slope",
      header: "Wear (s/lap)",
      align: "right",
      className: "tnum",
      render: (r) => r.slopeSPerLap.toFixed(4),
    },
    {
      // §3.3 — `circuit` / `pooled` are database values, not words. They are said in English
      // here, with the original token kept for screen readers and search.
      key: "pitloss",
      header: "Time lost in a pit stop",
      align: "right",
      className: "tnum",
      render: (r) => (
        <>
          {r.pitLossS.toFixed(1)} s{" "}
          <span className="text-muted">
            ({PIT_LOSS_SOURCE_WORDS[r.pitLossSource]}
            <span className="sr-only"> — stored as {r.pitLossSource}</span>)
          </span>
        </>
      ),
    },
    {
      key: "fits",
      header: "Stints behind the wear rate",
      align: "right",
      className: "tnum text-muted",
      render: (r) => (
        <>
          {r.nFits}{" "}
          <span>
            ({SLOPE_SOURCE_WORDS[r.slopeSource] ?? r.slopeSource}
            <span className="sr-only"> — stored as {r.slopeSource}</span>)
          </span>
        </>
      ),
    },
  ];
}

export default function DegradationSection({
  points,
  fits,
  perStint,
  colours,
  year,
  optimalStint = [],
  optimalStintReason,
  reason,
}: DegradationSectionProps): React.JSX.Element {
  if (fits.length === 0 && perStint.length === 0 && optimalStint.length === 0) {
    return <EmptyState title="No degradation fits for this race" reason={reason} />;
  }
  return (
    <>
      {fits.length > 0 ? (
        <div className="rounded-lg border border-grid bg-surface p-3">
          <DegradationScatter points={points} fits={fits} colours={colours} />
          {/* §0 — the caveat is not shortened. The part a reader would otherwise act wrongly on
              stays in the open; the full text moves behind a control below it. */}
          <p className="mt-2 text-xs leading-relaxed text-muted">{DEGRADATION_LEAD}</p>
          <Disclosure
            variant="inline"
            storageKey="race:degradation:caption"
            summary="Why a soft-tyre line can slope the wrong way, and when a slope is not a finding"
          >
            {DEGRADATION_CAPTION}
          </Disclosure>
        </div>
      ) : (
        <EmptyState
          title="No pooled compound fit for this race"
          reason={reason ?? "no compound had enough representative laps for a field-wide fit"}
        />
      )}
      {perStint.length > 0 ? <DegradationTable rows={perStint} year={year} /> : null}
      <div className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-fg">Optimal stint length</h3>
        {optimalStint.length === 0 ? (
          <EmptyState
            title="No break-even estimate"
            reason={optimalStintReason ?? OPTIMAL_STINT_NO_FITS_REASON}
          />
        ) : (
          <>
            <DataTable
              columns={optimalStintColumns(compoundColourMap(fits, perStint))}
              rows={optimalStint}
              rowKey={(r) => r.compound}
              dense
              caption="The stint length at which one more lap on worn tyres costs more than a pit stop, per compound. A pure lap-time calculation, not a strategy."
            />
            <Caption>{optimalStintCaption(optimalStint)}</Caption>
          </>
        )}
      </div>
    </>
  );
}
