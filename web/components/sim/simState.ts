// SIM_SPEC §6.2–6.4, §9 D10 — the strategy editor's state: a pure reducer over
// { driverId, mode, stints }, the §6.4 validation table, the four presets and the
// URL-hash codec (`#sim=PIA;M16,H46,H70;a`). No React, no DOM: unit-tested with
// `npx tsx --test components/sim/simState.test.ts`.
import { LENIENT_LIMITS, sameStrategy, validateStints, type SimPlanError } from "@/lib/sim/plan";
import type { SimCompound, SimDriver, SimMode, SimModel, SimStint } from "@/lib/sim/types";

export type { SimMode };

export type SimEditorState = {
  driverId: string;
  mode: SimMode;
  stints: SimStint[];
};

export type SimPreset = "earlier" | "later" | "fewer" | "swap";

export type SimAction =
  | { type: "selectDriver"; driver: SimDriver }
  | { type: "setMode"; mode: SimMode }
  | { type: "setCompound"; index: number; compound: string }
  | { type: "setPitLap"; index: number; lap: number }
  | { type: "addStop" }
  | { type: "removeStint"; index: number }
  | { type: "reset"; driver: SimDriver }
  | { type: "preset"; preset: SimPreset; driver: SimDriver }
  | { type: "hydrate"; state: SimEditorState };

/** What the reducer and the validator need from the payload (§4.1 `SimModel` subset). */
export type SimEditorContext = {
  compounds: SimCompound[];
  horizon: number;
  minStintLaps: number;
  maxStops: number;
  extrapolationLaps: number;
};

export function contextFor(model: SimModel, driver: SimDriver): SimEditorContext {
  return {
    compounds: model.compounds,
    horizon: driver.lapsCompleted,
    minStintLaps: model.constants.minStintLaps,
    maxStops: model.constants.maxStops,
    extrapolationLaps: model.constants.extrapolationLaps,
  };
}

/** Start lap of every stint under the §0.3 convention (stint k starts at endLap_{k-1} + 1). */
export function startLaps(stints: SimStint[]): number[] {
  const out: number[] = [];
  let start = 1;
  for (const s of stints) {
    out.push(start);
    start = (Number.isFinite(s.endLap) ? s.endLap : start) + 1;
  }
  return out;
}

/** §6.2 default: the first simulable driver in `drivers` order (already finishing order). */
export function defaultDriver(model: SimModel): SimDriver | null {
  return model.drivers.find((d) => d.simulable) ?? null;
}

export function initialState(model: SimModel, driver: SimDriver): SimEditorState {
  return { driverId: driver.driverId, mode: "asHappened", stints: driver.actual.map((s) => ({ ...s })) };
}

// ---------------------------------------------------------------------------
// Validation (§6.4 table)

export type StintIssue = { level: "error" | "warn" | "note"; message: string };

export type SimValidation = {
  /** One entry per stint; empty array = clean row. */
  rows: StintIssue[][];
  /** Whole-strategy notes ("one compound only …"). */
  notes: string[];
  /** True when nothing blocks the run: no row error and no plan error under the effective limits. */
  valid: boolean;
  /** The first structural violation as the engine reports it, or null. */
  planError: SimPlanError | null;
  /** The message to show when `valid` is false (plan error first, then the first row error). */
  blockingMessage: string | null;
  /** True while `stints` is exactly the driver's actual strategy — never blocked (see `validate`). */
  pristine: boolean;
  /** Tooltip for a disabled "+ add stop" button, `null` when enabled. */
  addStopDisabled: string | null;
};

const minStintMessage = (m: number): string => `a stint needs at least ${m} laps — an in-lap needs an out-lap`;

/** Muted note under a pristine stint the editor limits would have refused (§6.4, FINDING E). */
export const shortStintNote = (len: number): string =>
  `${len}-lap stint — that is how it was raced (a red flag or an immediate second stop), kept as it happened`;

/** Muted whole-strategy note when the driver really made more stops than the editor allows. */
export const manyStopsNote = (stops: number, maxStops: number): string =>
  `${stops} stops — more than the ${maxStops} this editor allows, but that is how it was raced; the real strategy still simulates`;

/** Rule 1 bounds for the pit lap of stint `i` (editable stints only). */
export function pitLapBounds(
  stints: SimStint[],
  i: number,
  ctx: Pick<SimEditorContext, "horizon" | "minStintLaps">,
): { lo: number; hi: number } {
  const starts = startLaps(stints);
  const lo = starts[i] + ctx.minStintLaps - 1;
  const nextEnd = i + 1 < stints.length ? stints[i + 1].endLap : ctx.horizon;
  const hi = (Number.isFinite(nextEnd) ? nextEnd : ctx.horizon) - ctx.minStintLaps;
  return { lo, hi };
}

/**
 * §6.4 validation.
 *
 * A **pristine** strategy — one that is exactly `driver.actual`, straight from the data — is
 * never blocked and never shows a red error. A red flag or a lap-1 puncture makes a 1-lap stint
 * and a chaotic race makes more than `maxStops` stops; both are facts about the race, not fan
 * input, so they replay as-is and only earn a muted note. `constants.minStintLaps` /
 * `constants.maxStops` exist to keep an EDIT inside the range the model was fitted on, so they
 * gate edited strategies only. The engine draws the same line (`lib/sim/plan.ts LENIENT_LIMITS`
 * and the `sameStrategy(edited, actual)` branch in `simulate`), so a state this function calls
 * valid is exactly a state the engine will run.
 */
export function validate(stints: SimStint[], driver: SimDriver, ctx: SimEditorContext): SimValidation {
  const starts = startLaps(stints);
  const rows: StintIssue[][] = stints.map(() => []);
  const byCompound = new Map(ctx.compounds.map((c) => [c.compound, c]));
  const H = ctx.horizon;
  const pristine = sameStrategy(stints, driver.actual);
  const limits = pristine ? LENIENT_LIMITS : { minStintLaps: ctx.minStintLaps, maxStops: ctx.maxStops };

  stints.forEach((s, i) => {
    const issues = rows[i];
    const last = i === stints.length - 1;
    const end = last ? H : s.endLap;
    // Rule 1 — pit lap window (editable stints only).
    if (!last && !pristine) {
      const { lo, hi } = pitLapBounds(stints, i, ctx);
      if (!Number.isFinite(s.endLap) || !Number.isInteger(s.endLap) || s.endLap < lo || s.endLap > hi) {
        issues.push({ level: "error", message: `pit lap must be between ${lo} and ${hi}` });
      }
    }
    // Rule 2 — every stint at least minStintLaps laps (the first may be 1 lap only if H == 1).
    const len = end - starts[i] + 1;
    const short = !(H === 1 && i === 0) && (!Number.isFinite(len) || len < ctx.minStintLaps);
    if (short && !pristine) {
      if (!issues.some((x) => x.level === "error")) issues.push({ level: "error", message: minStintMessage(ctx.minStintLaps) });
    } else if (short && Number.isFinite(len)) {
      // Pristine: the real race made this stint short (red flag, lap-1 puncture). Muted note only.
      issues.push({ level: "note", message: shortStintNote(len) });
    }
    // Compound must be parameterised at all (a hash or a stale payload could name another).
    const comp = byCompound.get(s.compound);
    if (!comp) {
      issues.push({ level: "error", message: `${s.compound} is not a parameterised compound in this race` });
      return;
    }
    // Rule 4 — driver never ran it (amber).
    if (!(s.compound in driver.dc)) {
      issues.push({
        level: "warn",
        message: `${driver.code} never ran the ${s.compound} in this race — pace uses the field's offset, not ${driver.code}'s`,
      });
    }
    // Rule 5 — extrapolated wear line (amber).
    if (Number.isFinite(len) && len > comp.ageMax + ctx.extrapolationLaps) {
      issues.push({
        level: "warn",
        message: `longer than any real stint on this tyre (${comp.ageMax} laps) — the wear line is extrapolated`,
      });
    }
  });

  const notes: string[] = [];
  if (stints.length > 0 && new Set(stints.map((s) => s.compound)).size === 1) {
    notes.push("one compound only — the two-compound rule is not enforced here");
  }

  const stops = stints.length - 1;
  if (pristine && stops > ctx.maxStops) notes.push(manyStopsNote(stops, ctx.maxStops));

  // The limits stay as guards on the ADD action even when the state is pristine: a 5-stop real
  // strategy may replay, but the fan may not add a sixth.
  let addStopDisabled: string | null = null;
  if (stops >= ctx.maxStops) {
    addStopDisabled = `${ctx.maxStops} stops is the most this editor allows`;
  } else if (longestStint(stints, H).len < 2 * ctx.minStintLaps) {
    addStopDisabled = `no stint is long enough to split into two of ${ctx.minStintLaps} laps`;
  }

  const planError = validateStints(stints, H, ctx.compounds.map((c) => c.compound), limits);
  const rowError = rows.flat().find((x) => x.level === "error") ?? null;
  const valid = planError === null && rowError === null;
  const blockingMessage = planError?.message ?? rowError?.message ?? null;
  return { rows, notes, valid, planError, blockingMessage, pristine, addStopDisabled };
}

function longestStint(stints: SimStint[], H: number): { index: number; len: number } {
  const starts = startLaps(stints);
  let best = { index: -1, len: 0 };
  stints.forEach((s, i) => {
    const end = i === stints.length - 1 ? H : s.endLap;
    const len = end - starts[i] + 1;
    if (Number.isFinite(len) && len > best.len) best = { index: i, len };
  });
  return best;
}

// ---------------------------------------------------------------------------
// Transitions (§6.4 controls and presets)

function withLastAtHorizon(stints: SimStint[], H: number): SimStint[] {
  if (stints.length === 0) return stints;
  const out = stints.map((s) => ({ ...s }));
  out[out.length - 1].endLap = H;
  return out;
}

/** "+ add stop": split the longest stint at its midpoint; the new stint inherits the compound. */
export function addStop(stints: SimStint[], ctx: SimEditorContext): SimStint[] {
  if (stints.length - 1 >= ctx.maxStops) return stints;
  const H = ctx.horizon;
  const { index, len } = longestStint(stints, H);
  if (index < 0 || len < 2 * ctx.minStintLaps) return stints;
  const starts = startLaps(stints);
  const firstEnd = starts[index] + Math.floor(len / 2) - 1;
  const out = stints.map((s) => ({ ...s }));
  out.splice(index, 0, { compound: stints[index].compound, endLap: firstEnd });
  return withLastAtHorizon(out, H);
}

/** "×": merge stint `i` into the previous one (the first row merges into the next). */
export function removeStint(stints: SimStint[], i: number, ctx: SimEditorContext): SimStint[] {
  if (stints.length <= 1 || i < 0 || i >= stints.length) return stints;
  const out = stints.map((s) => ({ ...s }));
  if (i === 0) {
    out.splice(0, 1); // the next stint now starts on lap 1 and keeps its compound and pit lap
  } else {
    out[i - 1].endLap = out[i].endLap;
    out.splice(i, 1);
  }
  return withLastAtHorizon(out, ctx.horizon);
}

/** Shift every pit lap by `delta` laps, clamped so every stint keeps `minStintLaps` laps. */
export function shiftPitLaps(stints: SimStint[], delta: number, ctx: SimEditorContext): SimStint[] {
  const H = ctx.horizon;
  const m = ctx.minStintLaps;
  const out = withLastAtHorizon(stints, H);
  const n = out.length;
  if (n <= 1) return out;
  if (delta < 0) {
    // Forwards: the lower bound depends on the (already shifted) previous stint.
    let start = 1;
    for (let i = 0; i < n - 1; i++) {
      const lo = start + m - 1;
      out[i].endLap = Math.max(lo, out[i].endLap + delta);
      start = out[i].endLap + 1;
    }
  } else {
    // Backwards: the upper bound depends on the (already shifted) next stint.
    for (let i = n - 2; i >= 0; i--) {
      const nextEnd = i + 1 < n - 1 ? out[i + 1].endLap : H;
      const hi = nextEnd - m;
      out[i].endLap = Math.min(hi, out[i].endLap + delta);
    }
  }
  return out;
}

/** "One stop fewer": drop the last stop, extend the previous stint to the horizon. */
export function oneStopFewer(stints: SimStint[], ctx: SimEditorContext): SimStint[] {
  if (stints.length <= 1) return withLastAtHorizon(stints, ctx.horizon);
  return withLastAtHorizon(stints.slice(0, -1), ctx.horizon);
}

/** "Swap compounds": each stint takes the next parameterised compound in `compounds` order (cyclic). */
export function swapCompounds(stints: SimStint[], ctx: SimEditorContext): SimStint[] {
  const order = ctx.compounds.map((c) => c.compound);
  if (order.length === 0) return stints;
  return stints.map((s) => {
    const k = order.indexOf(s.compound);
    const next = k < 0 ? order[0] : order[(k + 1) % order.length];
    return { ...s, endLap: s.endLap, compound: next };
  });
}

export function applyPreset(stints: SimStint[], preset: SimPreset, ctx: SimEditorContext): SimStint[] {
  switch (preset) {
    case "earlier":
      return shiftPitLaps(stints, -3, ctx);
    case "later":
      return shiftPitLaps(stints, 3, ctx);
    case "fewer":
      return oneStopFewer(stints, ctx);
    case "swap":
      return swapCompounds(stints, ctx);
  }
}

export function reduce(state: SimEditorState, action: SimAction, ctx: SimEditorContext): SimEditorState {
  switch (action.type) {
    case "selectDriver":
      return { ...state, driverId: action.driver.driverId, stints: action.driver.actual.map((s) => ({ ...s })) };
    case "setMode":
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case "setCompound": {
      if (action.index < 0 || action.index >= state.stints.length) return state;
      const stints = state.stints.map((s, i) => (i === action.index ? { ...s, compound: action.compound } : s));
      return { ...state, stints };
    }
    case "setPitLap": {
      if (action.index < 0 || action.index >= state.stints.length - 1) return state; // the last stint's end is H
      const stints = state.stints.map((s, i) => (i === action.index ? { ...s, endLap: action.lap } : s));
      return { ...state, stints };
    }
    case "addStop":
      return { ...state, stints: addStop(state.stints, ctx) };
    case "removeStint":
      return { ...state, stints: removeStint(state.stints, action.index, ctx) };
    case "reset":
      return { ...state, stints: action.driver.actual.map((s) => ({ ...s })) };
    case "preset":
      return { ...state, stints: applyPreset(state.stints, action.preset, ctx) };
    case "hydrate":
      return { ...action.state };
  }
}

// ---------------------------------------------------------------------------
// URL hash codec (§9 D10): `#sim=PIA;M16,H46,H70;a`

export function encodeHash(code: string, stints: SimStint[], mode: SimMode): string {
  const body = stints.map((s) => `${s.compound.charAt(0).toUpperCase()}${s.endLap}`).join(",");
  return `sim=${code};${body};${mode === "random" ? "r" : "a"}`;
}

/** Parse `#sim=…` (with or without the `#`); `null` when absent or malformed. Does not validate against a model. */
export function parseHash(
  hash: string,
): { code: string; stints: { initial: string; endLap: number }[]; mode: SimMode } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const m = /^sim=([A-Za-z0-9]{1,4});([^;]*);([ar])$/i.exec(raw);
  if (!m) return null;
  const parts = m[2].split(",");
  const stints: { initial: string; endLap: number }[] = [];
  for (const p of parts) {
    const s = /^([A-Za-z])(\d{1,3})$/.exec(p);
    if (!s) return null;
    stints.push({ initial: s[1].toUpperCase(), endLap: Number(s[2]) });
  }
  if (stints.length === 0) return null;
  return { code: m[1].toUpperCase(), stints, mode: m[3].toLowerCase() === "r" ? "random" : "asHappened" };
}

/**
 * Resolve a hash against the payload: the driver must be simulable, every compound initial must
 * name a parameterised compound, the last endLap must equal the horizon and the §6.4 rules must
 * pass; random mode needs a hazard row. Anything else → `null` (caller falls back to defaults).
 */
export function decodeHash(hash: string, model: SimModel): SimEditorState | null {
  const parsed = parseHash(hash);
  if (!parsed) return null;
  const driver = model.drivers.find((d) => d.code.toUpperCase() === parsed.code);
  if (!driver || !driver.simulable) return null;
  const byInitial = new Map(model.compounds.map((c) => [c.compound.charAt(0).toUpperCase(), c.compound]));
  const stints: SimStint[] = [];
  for (const s of parsed.stints) {
    const compound = byInitial.get(s.initial);
    if (!compound) return null;
    stints.push({ compound, endLap: s.endLap });
  }
  const ctx = contextFor(model, driver);
  if (stints[stints.length - 1].endLap !== ctx.horizon) return null;
  // A hash may carry the driver's own real strategy back, stops and all (FINDING E).
  if (stints.length - 1 > ctx.maxStops && !sameStrategy(stints, driver.actual)) return null;
  for (let i = 1; i < stints.length; i++) if (stints[i].endLap <= stints[i - 1].endLap) return null;
  if (!validate(stints, driver, ctx).valid) return null;
  const mode: SimMode = parsed.mode === "random" && model.hazard === null ? "asHappened" : parsed.mode;
  return { driverId: driver.driverId, mode, stints };
}

/** `Actual: M 1–16 · H 17–46 · H 47–70` pieces (chips rendered by the editor). */
export function stintRanges(stints: SimStint[], horizon: number): { compound: string; from: number; to: number }[] {
  const starts = startLaps(stints);
  return stints.map((s, i) => ({
    compound: s.compound,
    from: starts[i],
    to: i === stints.length - 1 ? horizon : s.endLap,
  }));
}
