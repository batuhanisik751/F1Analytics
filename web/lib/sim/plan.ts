// SIM_SPEC §5.1 — strategy expansion and validation. Pure TypeScript; no imports from lib/queries.
import type { Plan, SimModel, SimStint } from "./types";

/** Thrown by `expand` when a strategy violates the §5.1 / §6.4 blocking rules. */
export class SimPlanError extends Error {
  readonly code: SimPlanErrorCode;
  constructor(code: SimPlanErrorCode, message: string) {
    super(message);
    this.name = "SimPlanError";
    this.code = code;
  }
}

export type SimPlanErrorCode =
  | "empty"
  | "tooManyStops"
  | "notIncreasing"
  | "wrongHorizon"
  | "stintTooShort"
  | "unknownCompound";

export type PlanLimits = { minStintLaps: number; maxStops: number };

/**
 * Limits for expanding a strategy that is DATA, not user input: the driver's actual strategy as
 * it was raced. A red-flag tyre change or a lap-1 puncture makes a 1-lap stint, and a chaotic
 * race makes more than `constants.maxStops` stops; both are facts and must replay, so the actual
 * strategy is expanded with no editor limits (any number of stops, any stint of >= 1 lap).
 * The `constants.minStintLaps` / `constants.maxStops` limits exist only to keep the EDITOR
 * inside the range the model was fitted on, and apply only to an edited strategy (§5.1, §6.4).
 */
export const LENIENT_LIMITS: PlanLimits = {
  minStintLaps: 1,
  maxStops: Number.POSITIVE_INFINITY,
};

/**
 * Validate a strategy against the §5.1 rules; returns the first violation or null.
 * Rules: 1..maxStops+1 stints, endLaps strictly increasing, last endLap == H,
 * every stint >= minStintLaps laps (the first may be 1 lap only if H == 1),
 * every compound present in `compounds`.
 */
export function validateStints(
  stints: SimStint[],
  H: number,
  compounds: readonly string[],
  limits: PlanLimits,
): SimPlanError | null {
  if (stints.length < 1) return new SimPlanError("empty", "a strategy needs at least one stint");
  if (stints.length > limits.maxStops + 1) {
    return new SimPlanError(
      "tooManyStops",
      `${limits.maxStops} stops is the most this editor allows`,
    );
  }
  let start = 1;
  for (let k = 0; k < stints.length; k++) {
    const s = stints[k];
    if (!Number.isInteger(s.endLap)) {
      return new SimPlanError("notIncreasing", `stint ${k + 1}: endLap must be an integer`);
    }
    if (s.endLap < start) {
      return new SimPlanError(
        "notIncreasing",
        `stint ${k + 1}: endLap ${s.endLap} is not after the previous stint`,
      );
    }
    const len = s.endLap - start + 1;
    const minLen = k === 0 && H === 1 ? 1 : limits.minStintLaps;
    if (len < minLen) {
      return new SimPlanError(
        "stintTooShort",
        `a stint needs at least ${limits.minStintLaps} laps — an in-lap needs an out-lap`,
      );
    }
    if (!compounds.includes(s.compound)) {
      return new SimPlanError(
        "unknownCompound",
        `${s.compound} is not a parameterised compound in this race`,
      );
    }
    start = s.endLap + 1;
  }
  const last = stints[stints.length - 1].endLap;
  if (last !== H) {
    return new SimPlanError("wrongHorizon", `the last stint must end on lap ${H}, not ${last}`);
  }
  return null;
}

/**
 * §5.1 `expand(stints, H, startAge)`: per-lap compound, tyre age, in-lap flag and stint index
 * over laps 1..H (index L-1). Throws SimPlanError on an invalid strategy.
 */
export function expand(
  stints: SimStint[],
  H: number,
  startAge: number,
  compounds: readonly string[],
  limits: PlanLimits,
): Plan {
  const err = validateStints(stints, H, compounds, limits);
  if (err) throw err;
  const comp: string[] = new Array<string>(H);
  const age = new Int32Array(H);
  const pitAt = new Uint8Array(H);
  const stintIdx = new Int32Array(H);
  const stops: number[] = [];
  let start = 1;
  const last = stints.length - 1;
  for (let k = 0; k <= last; k++) {
    const s = stints[k];
    const firstAge = k === 0 ? startAge : 1;
    for (let L = start; L <= s.endLap; L++) {
      comp[L - 1] = s.compound;
      age[L - 1] = firstAge + (L - start);
      stintIdx[L - 1] = k;
    }
    if (k < last) {
      pitAt[s.endLap - 1] = 1;
      stops.push(s.endLap);
    }
    start = s.endLap + 1;
  }
  return { comp, age, pitAt, stintIdx, stops };
}

/**
 * §5.1: the edited plan's first stint keeps the actual start age when it uses the same compound
 * as the actual first stint (a used set stays used); otherwise it starts at age 1.
 */
export function editedStartAge(edited: SimStint[], actual: SimStint[], actualStartAge: number): number {
  if (edited.length > 0 && actual.length > 0 && edited[0].compound === actual[0].compound) {
    return actualStartAge;
  }
  return 1;
}

/** Parameterised compound names of a model in payload order (ref first, then by laps desc). */
export function compoundNames(model: SimModel): string[] {
  return model.compounds.map((c) => c.compound);
}

/**
 * §5.2/§5.3 slot count: the shared upper bound on stops used to size the pre-drawn random slots.
 * It must cover BOTH plans, so a real strategy with more than `maxStops` stops still has a slot
 * per stint; it is deliberately NOT `maxStops` alone (that under-sizes the buffers and produced
 * NaN) and NOT the edited stop count alone (the consumption order per draw must not depend on
 * the edit, or two edits under one seed would stop being comparable). Since an edited strategy
 * is capped at `maxStops` unless it is the actual strategy itself, this value is a function of
 * the driver's actual strategy and the constants only — stable across every edit of one driver.
 */
export function planSlots(actual: SimStint[], edited: SimStint[], maxStops: number): number {
  const actualStops = Math.max(0, actual.length - 1);
  const editedStops = Math.max(0, edited.length - 1);
  return Math.max(maxStops, actualStops, editedStops);
}

/** Two strategies are identical when every stint matches in compound and endLap. */
export function sameStrategy(a: SimStint[], b: SimStint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].compound !== b[i].compound || a[i].endLap !== b[i].endLap) return false;
  }
  return true;
}
