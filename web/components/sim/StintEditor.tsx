"use client";
// SIM_SPEC §6.4 — the stint editor: one row per stint (compound select limited to parameterised
// compounds, derived start lap, editable pit lap), inline validation, the actual strategy in
// words, "+ add stop" / "×" / "Reset to actual" / "Presets". Pure presentation: every change goes
// back through the handlers, state lives in SimSection's reducer (simState.ts).
import CompoundChip from "@/components/ui/CompoundChip";
import { compoundColour, type ColourMap } from "@/lib/colours";
import type { SimCompound, SimStint } from "@/lib/sim/types";
import { pitLapBounds, startLaps, stintRanges, type SimPreset, type SimValidation, type StintIssue } from "./simState";

export type StintEditorProps = {
  stints: SimStint[];
  /** Parameterised compounds only (payload order); carries `ageMax` and `degNegative`. */
  compounds: SimCompound[];
  colours: ColourMap;
  /** H — the last stint ends here (read-only). */
  horizon: number;
  /** race.totalLaps; `horizon < totalLaps` adds "· retired after lap H" to the actual line. */
  totalLaps: number;
  limits: { minStintLaps: number; maxStops: number; extrapolationLaps: number };
  /** The driver's real strategy, shown in words under the rows. */
  actual: SimStint[];
  driverCode: string;
  /** From `validate()` — per-row errors/warnings, notes and the add-stop tooltip. */
  validation: SimValidation;
  onSetCompound: (index: number, compound: string) => void;
  onSetPitLap: (index: number, lap: number) => void;
  onAddStop: () => void;
  onRemoveStint: (index: number) => void;
  onReset: () => void;
  onPreset: (preset: SimPreset) => void;
  /** `true` while the strategy equals `actual` (Reset disabled). */
  pristine?: boolean;
  className?: string;
};

export const PRESETS: { id: SimPreset; label: string }[] = [
  { id: "earlier", label: "Pit 3 laps earlier" },
  { id: "later", label: "Pit 3 laps later" },
  { id: "fewer", label: "One stop fewer" },
  { id: "swap", label: "Swap compounds" },
];

const FIELD =
  "rounded border border-grid bg-bg px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50";
const BUTTON =
  "rounded border border-grid px-2.5 py-1 text-xs text-fg hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-grid disabled:hover:text-fg";

/** §6.4: errors are red and block, warnings amber, notes muted and purely informational. */
const ISSUE_CLASS: Record<StintIssue["level"], string> = {
  error: "text-red-300",
  warn: "text-amber-300",
  note: "text-muted",
};

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[-\s])(\w)/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export default function StintEditor(props: StintEditorProps): React.JSX.Element {
  const { stints, compounds, colours, horizon, totalLaps, limits, actual, driverCode, validation } = props;
  const starts = startLaps(stints);
  const colourOf = (name: string): string =>
    colours.compounds[name] ?? compounds.find((c) => c.compound === name)?.compoundColour ?? compoundColour(colours, name);
  const known = new Set(compounds.map((c) => c.compound));

  return (
    <div className={`flex flex-col gap-3 ${props.className ?? ""}`}>
      <ol className="flex flex-col gap-2" aria-label="Stints">
        {stints.map((s, i) => {
          const last = i === stints.length - 1;
          const issues = validation.rows[i] ?? [];
          const hasError = issues.some((x) => x.level === "error");
          const { lo, hi } = last ? { lo: horizon, hi: horizon } : pitLapBounds(stints, i, { horizon, minStintLaps: limits.minStintLaps });
          const selectId = `sim-stint-${i}-compound`;
          const lapId = `sim-stint-${i}-pit`;
          const options = known.has(s.compound) ? compounds : [...compounds, { compound: s.compound } as SimCompound];
          return (
            <li key={i} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-14 shrink-0 text-muted">Stint {i + 1}</span>
                <label htmlFor={selectId} className="sr-only">Stint {i + 1} compound</label>
                <select
                  id={selectId}
                  className={FIELD}
                  value={s.compound}
                  style={{ color: colourOf(s.compound) }}
                  onChange={(e) => props.onSetCompound(i, e.target.value)}
                >
                  {options.map((c) => (
                    <option key={c.compound} value={c.compound} style={{ color: colourOf(c.compound) }}>
                      {titleCase(c.compound)}
                      {c.degNegative ? " · no measurable degradation on this tyre in this race" : ""}
                    </option>
                  ))}
                </select>
                <CompoundChip compound={s.compound} colour={colourOf(s.compound)} short />
                <span className="text-muted">laps</span>
                <span className="tnum" aria-label={`Stint ${i + 1} start lap`}>{starts[i]}</span>
                <span className="text-muted">–</span>
                <label htmlFor={lapId} className="sr-only">
                  {last ? `Stint ${i + 1} last lap (race end)` : `Stint ${i + 1} pit lap`}
                </label>
                {last ? (
                  <input id={lapId} type="number" className={`${FIELD} tnum w-16`} value={horizon} readOnly disabled />
                ) : (
                  <input
                    id={lapId}
                    type="number"
                    inputMode="numeric"
                    className={`${FIELD} tnum w-16 ${hasError ? "border-red-400" : ""}`}
                    value={Number.isFinite(s.endLap) ? s.endLap : ""}
                    min={lo <= hi ? lo : undefined}
                    max={lo <= hi ? hi : undefined}
                    step={1}
                    aria-invalid={hasError || undefined}
                    aria-describedby={issues.length ? `${lapId}-msg` : undefined}
                    onChange={(e) => props.onSetPitLap(i, e.target.value === "" ? Number.NaN : Number(e.target.value))}
                  />
                )}
                {!last && <span className="text-xs text-muted">(pit lap)</span>}
                {stints.length > 1 && (
                  <button
                    type="button"
                    className={`${BUTTON} ml-auto`}
                    aria-label={`Remove stint ${i + 1}`}
                    title={i === 0 ? "Merge into the next stint" : "Merge into the previous stint"}
                    onClick={() => props.onRemoveStint(i)}
                  >
                    ×
                  </button>
                )}
              </div>
              {issues.length > 0 && (
                <ul id={`${lapId}-msg`} className="ml-14 flex flex-col gap-0.5 text-xs">
                  {issues.map((x, k) => (
                    <li key={k} className={ISSUE_CLASS[x.level]}>
                      {x.message}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={validation.addStopDisabled !== null}
          title={validation.addStopDisabled ?? "Split the longest stint at its midpoint"}
          onClick={props.onAddStop}
        >
          + add stop
        </button>
        <button type="button" className={BUTTON} disabled={props.pristine === true} onClick={props.onReset}>
          Reset to actual
        </button>
        <label htmlFor="sim-presets" className="sr-only">Presets</label>
        <select
          id="sim-presets"
          className={`${FIELD} text-xs`}
          value=""
          onChange={(e) => {
            const id = e.target.value as SimPreset | "";
            if (id) props.onPreset(id);
          }}
        >
          <option value="">Presets ▾</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      {validation.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted">
          {validation.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
        <span>Actual:</span>
        {stintRanges(actual, horizon).map((r, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <span aria-hidden>·</span>}
            <CompoundChip compound={r.compound} colour={colourOf(r.compound)} short />
            <span className="tnum">
              {r.from}–{r.to}
            </span>
          </span>
        ))}
        {horizon < totalLaps && (
          <span>
            · retired after lap <span className="tnum">{horizon}</span>
          </span>
        )}
        <span className="sr-only">({driverCode})</span>
      </p>
    </div>
  );
}
