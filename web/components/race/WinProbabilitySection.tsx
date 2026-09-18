// MODE1_SPEC §7.4 / FD3 — the river, the swing list and the reliability curves, in that
// order and in one section: a trust check one click away is not a trust check. Captions
// are verbatim from §7.5 and the numbers in them come from the query, never from source.
import WinProbRiver from "@/components/charts/WinProbRiver";
import ReliabilityChart from "@/components/charts/ReliabilityChart";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import type { WinProbability, WinProbSwing, WinProbTrust } from "@/lib/queries/race";

export type WinProbabilitySectionProps = {
  winProb: WinProbability | null;
  swings: WinProbSwing[];
  trust: WinProbTrust | null;
  /** True when the stored artifact's scikit-learn version differs from the runtime's. */
  sklearnMismatch?: boolean;
  reason?: string | null;
};

export const WINPROB_EMPTY_REASON =
  "win probability has not been recomputed since this race was added";
export const WINPROB_NO_SKILL_REASON =
  "the win-probability model did not beat a simple position lookup on this data, so we are not showing it";
export const WINPROB_SKLEARN_REASON =
  "the stored model was built with a different scikit-learn version";
export const SWINGS_EMPTY_REASON =
  "no lap in this race moved enough win probability to flag";

export const SWINGS_CAPTION =
  "These are the laps where the most win probability changed hands, biggest first. The label describes what the lap was, not what caused the change: a caption of “safety car” means the lap was not green — it does not mean the safety car caused the swing. About three quarters of flagged laps are green-flag pit cycles and undercuts.";

/**
 * UX_SPEC §0/§2.2 — NEW copy, not a trimmed version of anything. The long captions below move
 * behind a control; these short lines keep the limit on interpretation in the open, where a
 * reader who never opens the method note still meets it.
 */
export const WINPROB_LEAD =
  "The model was never shown this race. It is better than guessing from grid position alone, but only modestly so, and on any single race its curve can be well off — read it as a mood, not a forecast.";

export const RELIABILITY_LEAD =
  "Measured on this data the model is slightly over-confident in the middle of the range and slightly under-confident at the top. The error bars drawn here are too narrow.";

export const RELIABILITY_CAPTION =
  "Does a 30% really happen 30% of the time? Each dot is a group of laps where the model said roughly the same thing; the dot’s height is how often those laps actually ended in a win. On the line means honest, above means the model was under-confident, below means over-confident. Left: races the model had not seen. Right: circuits the model had never visited — the harder question, and the right one for a brand-new venue. Measured on this data the model is slightly over-confident in the middle (it says 37%, it happens 31%) and slightly under-confident at the top (it says 87%, it happens 92%). The error bars are drawn from the number of laps in each group, which overstates the evidence, because laps within one race are not independent — read them as too narrow.";

const CAUSE_LABEL: Record<WinProbSwing["cause"], string> = {
  safety_car: "safety car",
  vsc: "virtual safety car",
  red_flag: "red flag",
  pit_cycle: "pit cycle",
  retirement: "retirement",
  on_track: "on track",
};

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
function brier(v: number): string {
  return v.toFixed(5);
}
function fold(v: number | null): string {
  return v === null ? "—" : v.toFixed(4);
}

/** §7.5 verbatim, with the five braced tokens substituted from the query result. */
export function riverCaption(
  nTrainRaces: number,
  brierOof: number,
  brierBaselinePos: number,
  brierFoldMin: number | null,
  brierFoldMax: number | null,
): string {
  return (
    `Each band is one driver’s chance of winning, recalculated after every lap by a model ` +
    `trained on ${nTrainRaces} past races. The bands always add to 100%, and a driver ` +
    `disappears from the stack when they retire. The model was never shown the race you are ` +
    `looking at: every number here comes from a version of the model trained on the other ` +
    `races. It scores a Brier of ${brier(brierOof)} against ${brier(brierBaselinePos)} for a simple ` +
    `“what usually happens from this position” lookup — a real edge, but a modest one. Per ` +
    `race it varies a lot: across the ten held-out groups the Brier ranged from ` +
    `${fold(brierFoldMin)} to ${fold(brierFoldMax)}, so any single race’s curve can be well off.`
  );
}

export function degradedNotice(n: number): string {
  return (
    `On ${n} lap(s) the model produced no usable spread and the chart falls back to an even ` +
    `split across the running cars. Those laps are not a prediction.`
  );
}

export default function WinProbabilitySection({
  winProb,
  swings,
  trust,
  sklearnMismatch = false,
  reason,
}: WinProbabilitySectionProps): React.JSX.Element {
  if (sklearnMismatch) {
    return <EmptyState title="Win probability unavailable" reason={WINPROB_SKLEARN_REASON} />;
  }
  if (trust && !trust.skillOk) {
    return <EmptyState title="Win probability withheld" reason={WINPROB_NO_SKILL_REASON} />;
  }
  if (!winProb || winProb.series.length === 0 || !trust) {
    return (
      <EmptyState
        title="No win probability for this race"
        reason={reason ?? WINPROB_EMPTY_REASON}
      />
    );
  }
  const loro = trust.scopes.find((s) => s.scope === "loro") ?? trust.scopes[0];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-grid bg-surface p-3">
        <WinProbRiver
          laps={winProb.laps}
          series={winProb.series.map((s) => ({ code: s.code, colour: s.teamColour, p: s.p }))}
          degradedLaps={winProb.degradedLaps}
          swings={swings}
        />
        {/* §0 — the caption is not shortened. A NEW line carries the limit on interpretation in
            the open (§2.2), and the full method text moves behind a control below it. */}
        {loro ? (
          <>
            <p className="mt-2 text-xs leading-relaxed text-muted">{WINPROB_LEAD}</p>
            <Disclosure
              variant="inline"
              storageKey="race:winprob:method"
              summary={`How this model was trained and how well it scores — ${trust.nTrainRaces} past races, never this one`}
            >
              {riverCaption(
                trust.nTrainRaces,
                loro.brier,
                loro.brierBaselinePos,
                loro.brierFoldMin,
                loro.brierFoldMax,
              )}
            </Disclosure>
          </>
        ) : null}
        {winProb.degradedLaps.length > 0 ? (
          <Caption>{degradedNotice(winProb.degradedLaps.length)}</Caption>
        ) : null}
        <p className="mt-2 font-mono text-[11px] text-muted">model {winProb.modelVersion}</p>
      </div>

      <div className="rounded-lg border border-grid bg-surface p-3">
        <h3 className="mb-2 text-sm font-semibold text-fg">Biggest swings</h3>
        {swings.length === 0 ? (
          <EmptyState title="No flagged laps" reason={SWINGS_EMPTY_REASON} />
        ) : (
          <ol className="space-y-1.5 text-sm">
            {swings.map((w) => (
              <li key={w.lapNumber} className="flex flex-wrap items-center gap-2">
                <span className="tnum font-mono text-muted">Lap {w.lapNumber}</span>
                <span className="text-muted">{CAUSE_LABEL[w.cause]}</span>
                <span aria-hidden className="text-muted">
                  &mdash;
                </span>
                <DriverChip
                  code={w.mover.code}
                  teamColour={w.mover.teamColour}
                  lineStyle={w.mover.lineStyle}
                  size="sm"
                />
                <span className="tnum">
                  {pct(w.pBefore)} &rarr; {pct(w.pAfter)}
                </span>
              </li>
            ))}
          </ol>
        )}
        <Caption>{SWINGS_CAPTION}</Caption>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-fg">
          Is it calibrated? <span className="font-normal text-muted">— does a 30 % chance happen 3 times in 10?</span>
        </h3>
        <ReliabilityChart scopes={trust.scopes} />
        <p className="mt-2 text-xs leading-relaxed text-muted">{RELIABILITY_LEAD}</p>
        <Disclosure
          variant="inline"
          storageKey="race:winprob:reliability"
          summary="How to read this chart, and what it measured — dot by dot, plus why the error bars are too narrow"
        >
          {RELIABILITY_CAPTION}
        </Disclosure>
      </div>
    </div>
  );
}
