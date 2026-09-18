// SPEC §4.3 item 10 — every key of the session's assumption set, rendered from the DB row
// (assumption_sets.params via session_ingests), never from web constants. The explanation
// text is lifted from f1lab/config.py's comments and the pace.py call sites.
import EmptyState from "@/components/ui/EmptyState";
import type { AssumptionsView } from "@/lib/queries/race";

export type AssumptionsPanelProps = { view: AssumptionsView | null; reason?: string | null };

type Explainer = { label: string; unit?: string; text: string };

// Order matters: this is the order the panel lists the keys in. Keys present in params but
// missing here are appended raw, so a future constant is never silently hidden.
const EXPLAIN: Record<string, Explainer> = {
  FUEL_START_KG: {
    label: "Fuel at start",
    unit: "kg",
    text: "Regulation maximum fuel load at the start of a race. Teams routinely underfill, so this is an upper bound and the correction it produces is slightly generous.",
  },
  FUEL_EFFECT_S_PER_KG: {
    label: "Fuel effect",
    unit: "s/kg/lap",
    text: "Seconds of lap time cost per kilogram of fuel carried, at a reference circuit. Commonly quoted in the paddock as 0.03; the plausible range is roughly 0.025–0.035 depending on how power-limited the circuit is. Every lap is corrected to an empty tank with this constant.",
  },
  REFERENCE_LAP_KM: {
    label: "Reference lap",
    unit: "km",
    text: "The lap length the fuel constant is calibrated against. Fuel burn per lap scales with distance, so a longer lap burns proportionally more.",
  },
  apply_lap_km_scaling: {
    label: "Lap-km scaling",
    text: "Whether the per-lap fuel correction was scaled by this circuit's lap length relative to the reference lap.",
  },
  OUTLIER_THRESHOLD: {
    label: "Outlier threshold",
    unit: "× driver median",
    text: "A lap slower than this multiple of the driver's own median clean lap is treated as compromised (traffic, lift-and-coast, a moment off track) rather than representative pace. 107% deliberately echoes the qualifying rule.",
  },
  GREEN_FLAG: {
    label: "Green-flag code",
    text: "A lap is only counted as clean when every character of its FastF1 track-status string is this code (all green through every marshalling sector).",
  },
  MIN_STINT_LAPS_FOR_DEG: {
    label: "Min stint laps for degradation",
    unit: "laps",
    text: "Minimum usable laps a stint must contain before a degradation slope is fitted to it. Below this the fit is dominated by the out-lap warm-up and tells you nothing.",
  },
  pace_min_laps: {
    label: "Min clean laps for ranking",
    unit: "laps",
    text: "A driver needs at least this many representative laps to appear in the pace ranking; a median over fewer laps is not a pace.",
  },
  fuel_sensitivity_values: {
    label: "Sensitivity values",
    unit: "s/kg/lap",
    text: "The alternative fuel constants the ranking is recomputed under. If the order holds across them, the result is a fact about the race; if it shuffles, it was an artefact of the constant.",
  },
  deg_min_tyre_life: {
    label: "Deg. min tyre life",
    unit: "laps",
    text: "Laps with tyre life below this are dropped from every degradation fit: the first flying lap of a stint is a warm-up lap and consistently reads slow for reasons that are not degradation.",
  },
  compound_fit_min_laps: {
    label: "Compound fit min laps",
    unit: "laps",
    text: "Minimum representative laps a compound needs across the field before a pooled field-wide slope is fitted and drawn.",
  },
  box_whisker: {
    label: "Box whisker",
    unit: "× IQR",
    text: "Whisker length of the pace box plot in multiples of the interquartile range (matplotlib boxplot_stats whis). Fliers beyond it are not drawn.",
  },
};

const UTC_STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function fmtStamp(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : UTC_STAMP.format(d);
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map(fmtValue).join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export default function AssumptionsPanel({ view, reason }: AssumptionsPanelProps): React.JSX.Element {
  if (!view) {
    return <EmptyState title="No ingest record for this race" reason={reason} />;
  }
  const keys = [
    ...Object.keys(EXPLAIN).filter((k) => k in view.params),
    ...Object.keys(view.params).filter((k) => !(k in EXPLAIN)).sort(),
  ];
  const notOk = Object.entries(view.analyticsStatus).filter(([, v]) => v !== "ok");

  return (
    <div className="rounded-lg border border-grid bg-surface/40 p-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(12rem,auto)_1fr]">
        {keys.map((k) => {
          const ex = EXPLAIN[k];
          let value = fmtValue(view.params[k]);
          if (k === "apply_lap_km_scaling") {
            value =
              view.lapKmUsed === null
                ? "not applied — reference constant used unscaled"
                : `applied — ${view.lapKmUsed} km lap, fuel correction × ${view.fuelScale}`;
          }
          return (
            <div key={k} className="contents">
              <dt className="min-w-0 text-sm break-words text-muted">
                {ex?.label ?? k}
                <span className="ml-2 font-mono text-[11px] text-muted/70">{k}</span>
              </dt>
              <dd className="min-w-0 text-sm break-words">
                <span className="tnum font-medium text-fg">{value}</span>
                {ex?.unit && k !== "apply_lap_km_scaling" ? (
                  <span className="ml-1 text-muted">{ex.unit}</span>
                ) : null}
                {ex ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{ex.text}</p> : null}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-4 border-t border-grid pt-3 text-xs text-muted">
        Computed by f1lab {view.f1labVersion} / FastF1 {view.fastf1Version} on {fmtStamp(view.ingestedAt)};{" "}
        <span className="tnum">{view.rawLaps}</span> raw → <span className="tnum">{view.cleanLaps}</span>{" "}
        representative laps; assumption set #{view.assumptionSetId}.
      </p>
      {notOk.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs" aria-label="Analytics not computed">
          {notOk.map(([k, v]) => (
            <li key={k} className="font-mono text-accent">
              {k}: {v}
            </li>
          ))}
        </ul>
      ) : null}
      {view.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs" aria-label="Ingest warnings">
          {view.warnings.map((w) => (
            <li key={w} className="font-mono text-accent">
              ⚠ {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
