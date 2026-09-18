// TELEMETRY_SPEC v1.7 §5.2.1 / §5.2.2 — the alignment rule and the closure check.
// Pure functions, no React, no DB, no `echarts`. Safe to import from a server
// component, a 'use client' chart, or a plain node script.
//
// T5, and the whole reason this file exists: the x-axis is CHORD DISTANCE along the
// lap. FastF1's integrated `Distance` is speed integrated over time and accumulates
// that error — measured spread across the fastest laps of ONE session at ONE circuit
// is 114.7 m (2.0%) against 12.7 m (0.22%) for chord, and a delta drawn on it is
// wrong by 1378-1398 ms against true gaps of 60-180 ms (§1.4).
//
// Normalising to a common 0..1 is the near-miss and is FORBIDDEN by §5.2.1: it closes
// the endpoint EXACTLY — self-certifying, so the closure check below becomes a
// tautology — while displacing the error into the interior, measured at +481, -496,
// +446, -570, +453, -573 ms at the sector boundaries.
//
// There is deliberately no code path in this module that can accept an integrated
// distance: `ChordDistanceM` is a branded type and the only two constructors are
// `chordDistanceFromXY` (which computes it) and `chordLap` (which RE-DERIVES it from
// the lap's own x/y and rejects the array if it disagrees). Passing
// `telemetry.Distance` to either is a compile error and, if cast past the compiler,
// a runtime rejection.

/** Cumulative chord length of (x, y) in metres from the lap's first sample, `[0] = 0`. */
export type ChordDistanceM = readonly number[] & {
  readonly __brand: "chord-distance-m";
};

/** FastF1 position units are tenths of a metre; chord length divides by this. */
export const POSITION_UNITS_PER_M = 10;

/**
 * Max absolute disagreement, in metres, tolerated between a stored `distance_m` and
 * the chord length re-derived here from the same row's x/y. Generous enough for
 * float32 storage of a ~5.8 km lap (~0.5 mm/sample of rounding, ~0.3 m accumulated)
 * and far tighter than the 114.7 m an integrated `Distance` would miss by.
 */
export const CHORD_TOLERANCE_M = 2.0;

export class NotChordDistanceError extends Error {
  constructor(detail: string) {
    super(
      `TELEMETRY_SPEC T5: this array is not the chord length of the lap's own (x, y) — ${detail}. ` +
        `FastF1's integrated Distance is never stored and never used for alignment (§1.4).`,
    );
    this.name = "NotChordDistanceError";
  }
}

/** The raw shape of one `lap_telemetry` row this module needs. Arrays are parallel. */
export type LapSamples = {
  /** Driver code, for the axis annotation and error messages. Never "A"/"B". */
  code: string;
  /** Raw, unrotated FastF1 position units (§0.3). */
  x: readonly number[];
  y: readonly number[];
  /** Seconds from the lap's first sample, `[0] = 0`. Never SessionTime, never Date. */
  timeS: readonly number[];
  /** `lap_telemetry.distance_m` — chord, and re-verified as such by `chordLap`. */
  distanceM: readonly number[];
};

/** A lap whose x-axis has been proven to be chord distance. */
export type ChordLap = {
  code: string;
  distance: ChordDistanceM;
  timeS: readonly number[];
  nSamples: number;
  /** `distance[n - 1]`: this lap's own chord length in metres. */
  lengthM: number;
};

/**
 * Cumulative chord length of (x, y), in metres. This is the definition of T5 and the
 * only place it is written down in TypeScript.
 */
export function chordDistanceFromXY(
  x: readonly number[],
  y: readonly number[],
): ChordDistanceM {
  if (x.length !== y.length) {
    throw new NotChordDistanceError(`x has ${x.length} samples, y has ${y.length}`);
  }
  const out = new Array<number>(x.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < x.length; i++) {
    const dx = x[i] - x[i - 1];
    const dy = y[i] - y[i - 1];
    acc += Math.hypot(dx, dy) / POSITION_UNITS_PER_M;
    out[i] = acc;
  }
  return out as unknown as ChordDistanceM;
}

/**
 * Accept a stored lap only if its `distance_m` really is the chord length of its own
 * (x, y). This is the enforcement half of T5: an integrated `Distance` on a 5.8 km lap
 * disagrees by tens of metres and is rejected here rather than drawn.
 */
export function chordLap(lap: LapSamples): ChordLap {
  const n = lap.distanceM.length;
  if (n < 2) throw new NotChordDistanceError(`${lap.code}: ${n} samples`);
  if (lap.x.length !== n || lap.y.length !== n || lap.timeS.length !== n) {
    throw new NotChordDistanceError(
      `${lap.code}: ragged row — distance ${n}, x ${lap.x.length}, y ${lap.y.length}, time ${lap.timeS.length}`,
    );
  }
  if (lap.distanceM[0] !== 0) {
    throw new NotChordDistanceError(`${lap.code}: distance[0] = ${lap.distanceM[0]}, not 0`);
  }
  const derived = chordDistanceFromXY(lap.x, lap.y);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && lap.distanceM[i] < lap.distanceM[i - 1]) {
      throw new NotChordDistanceError(
        `${lap.code}: distance decreases at sample ${i} (${lap.distanceM[i - 1]} -> ${lap.distanceM[i]})`,
      );
    }
    if (i > 0 && lap.timeS[i] < lap.timeS[i - 1]) {
      throw new NotChordDistanceError(`${lap.code}: time_s decreases at sample ${i}`);
    }
    worst = Math.max(worst, Math.abs(lap.distanceM[i] - derived[i]));
  }
  if (worst > CHORD_TOLERANCE_M) {
    throw new NotChordDistanceError(
      `${lap.code}: stored distance_m differs from the chord length of its own x/y by ` +
        `${worst.toFixed(1)} m (tolerance ${CHORD_TOLERANCE_M} m)`,
    );
  }
  return {
    code: lap.code,
    distance: lap.distanceM as unknown as ChordDistanceM,
    timeS: lap.timeS,
    nSamples: n,
    lengthM: lap.distanceM[n - 1],
  };
}

/**
 * Time, in seconds from the lap's first sample, at chord distance `s`. Linear
 * interpolation between the two bracketing NATIVE samples (T1: there is no resampled
 * grid in the database, only here, only for the comparison). Clamped at both ends.
 */
export function timeAtDistance(lap: ChordLap, s: number): number {
  const d = lap.distance;
  const n = lap.nSamples;
  if (s <= d[0]) return lap.timeS[0];
  if (s >= d[n - 1]) return lap.timeS[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = d[hi] - d[lo];
  if (span <= 0) return lap.timeS[lo];
  const f = (s - d[lo]) / span;
  return lap.timeS[lo] + f * (lap.timeS[hi] - lap.timeS[lo]);
}

/** §5.2.1 step 2 — the common axis, and what it cost to build. */
export type AlignedDelta = {
  codeA: string;
  codeB: string;
  /** The 1 m grid, `0 .. sEnd` inclusive. */
  s: number[];
  /** `delta[i] > 0` means A took MORE time to reach `s[i]`, i.e. A is BEHIND (§0.3). */
  deltaS: number[];
  /** `min(lengthA, lengthB)`. */
  sEndM: number;
  /** Metres of the LONGER lap left off the axis. Reported, never hidden. */
  trimmedM: number;
  lengthAM: number;
  lengthBM: number;
  gridStepM: number;
};

/**
 * §5.2.1: the common axis is `s in [0, min(L_A, L_B)]` on a 1 m grid. NO normalisation,
 * no stretching to a common 0..1, and no silent truncation of the longer array by index.
 * Chord lengths agree to ~10 m, so `trimmedM` is metres — not the 111 m that
 * normalisation exists to paper over.
 */
export function alignLaps(a: ChordLap, b: ChordLap, gridStepM = 1): AlignedDelta {
  if (!(gridStepM > 0)) throw new Error(`alignLaps: gridStepM must be > 0, got ${gridStepM}`);
  const sEndM = Math.min(a.lengthM, b.lengthM);
  const s: number[] = [];
  for (let v = 0; v < sEndM; v += gridStepM) s.push(v);
  s.push(sEndM); // the flag itself is always on the axis: the closure check needs it
  const deltaS = s.map((v) => timeAtDistance(a, v) - timeAtDistance(b, v));
  return {
    codeA: a.code,
    codeB: b.code,
    s,
    deltaS,
    sEndM,
    trimmedM: Math.max(a.lengthM, b.lengthM) - sEndM,
    lengthAM: a.lengthM,
    lengthBM: b.lengthM,
    gridStepM,
  };
}

/** §5.2.2 gates, in milliseconds of closure error. */
export const CLOSURE_CLEAN_MS = 150;
export const CLOSURE_REFUSE_MS = 400;
/** §5.2 markArea: sample gaps at or above this are shaded "interpolated — no measurement here". */
export const GAP_SHADE_THRESHOLD_M = 50;

export type ClosureGate = "clean" | "caption" | "refuse";

export type SectorResidual = {
  sector: 1 | 2;
  /** The chord distance the check was evaluated at: the mean of the two laps' own. */
  sM: number;
  /** The trace's own delta there. */
  traceDeltaS: number;
  /** `s1_s(A) - s1_s(B)` from `laps` — the drivers' own sector times. */
  officialDeltaS: number;
  /** `traceDeltaS - officialDeltaS`. Measured 8, 37, 72, 81, 98, 8 ms under chord. */
  residualS: number;
};

export type ClosureInput = {
  /** `laps.lap_time_s` for A and B. The OFFICIAL gap is A - B and is what the chart labels. */
  lapTimeAS: number;
  lapTimeBS: number;
  /** `lap_telemetry_summary.s1_distance_m` / `s2_distance_m`, per driver. */
  s1DistanceAM?: number | null;
  s1DistanceBM?: number | null;
  s2DistanceAM?: number | null;
  s2DistanceBM?: number | null;
  /** `laps.s1_s` / `s2_s`, per driver, cumulative from the lap start. */
  s1TimeAS?: number | null;
  s1TimeBS?: number | null;
  s2TimeAS?: number | null;
  s2TimeBS?: number | null;
};

export type ClosureCheck = {
  /** The delta the trace itself reaches at the flag. */
  traceEndDeltaS: number;
  /** `lapTimeAS - lapTimeBS`. This is the number the chart prints, always (§5.2.3). */
  officialGapS: number;
  /** `|traceEndDeltaS - officialGapS|`. Measured 4-109 ms under chord, 1378-1398 ms on raw Distance. */
  closureErrorS: number;
  gate: ClosureGate;
  /** True when the gate is anything but "refuse". */
  render: boolean;
  /**
   * §5.2.2's relative rule: a 399 ms error drawn onto a 180 ms gap must not read as
   * clean merely because it cleared an absolute threshold. When true, the caption
   * LEADS with "read the shape of the line, not its size".
   */
  errorExceedsHalfGap: boolean;
  /** Empty when the sector inputs are absent; never fabricated. */
  sectors: SectorResidual[];
};

function gateFor(errS: number): ClosureGate {
  const ms = errS * 1000;
  if (ms <= CLOSURE_CLEAN_MS) return "clean";
  if (ms <= CLOSURE_REFUSE_MS) return "caption";
  return "refuse";
}

function sectorResidual(
  aligned: AlignedDelta,
  a: ChordLap,
  b: ChordLap,
  sector: 1 | 2,
  dA: number | null | undefined,
  dB: number | null | undefined,
  tA: number | null | undefined,
  tB: number | null | undefined,
): SectorResidual | null {
  if (dA == null || dB == null || tA == null || tB == null) return null;
  // The two laps cross the same painted line at slightly different chord distances
  // (they agree to ~10 m over a lap). Evaluating at the mean is symmetric in A and B;
  // evaluating at either driver's own would make one side of the subtraction exact
  // by construction and the check one-sided.
  const sM = Math.min((dA + dB) / 2, aligned.sEndM);
  const traceDeltaS = timeAtDistance(a, sM) - timeAtDistance(b, sM);
  const officialDeltaS = tA - tB;
  return { sector, sM, traceDeltaS, officialDeltaS, residualS: traceDeltaS - officialDeltaS };
}

/**
 * §5.2.2 — the chart validates itself before it renders. Under chord alignment this is
 * a real assertion; under any per-lap-length normalisation the endpoint version closes
 * EXACTLY by construction and asserts nothing, which is why §5.2.1 forbids it.
 */
export function closureCheck(
  aligned: AlignedDelta,
  a: ChordLap,
  b: ChordLap,
  input: ClosureInput,
): ClosureCheck {
  const traceEndDeltaS = aligned.deltaS[aligned.deltaS.length - 1];
  const officialGapS = input.lapTimeAS - input.lapTimeBS;
  const closureErrorS = Math.abs(traceEndDeltaS - officialGapS);
  const sectors = [
    sectorResidual(aligned, a, b, 1, input.s1DistanceAM, input.s1DistanceBM, input.s1TimeAS, input.s1TimeBS),
    sectorResidual(aligned, a, b, 2, input.s2DistanceAM, input.s2DistanceBM, input.s2TimeAS, input.s2TimeBS),
  ].filter((r): r is SectorResidual => r !== null);
  const gate = gateFor(closureErrorS);
  return {
    traceEndDeltaS,
    officialGapS,
    closureErrorS,
    gate,
    render: gate !== "refuse",
    errorExceedsHalfGap: closureErrorS > Math.abs(officialGapS) / 2,
    sectors,
  };
}

/**
 * §5.2 markArea — the `[from, to]` chord intervals of either lap where consecutive
 * NATIVE samples are `>= thresholdM` apart, merged. Measured ~15 gaps > 25 m per lap,
 * worst 73.7-85.7 m. Without this the single largest artifact in the data is invisible.
 */
export function gapIntervals(
  laps: readonly ChordLap[],
  thresholdM: number = GAP_SHADE_THRESHOLD_M,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (const lap of laps) {
    for (let i = 1; i < lap.nSamples; i++) {
      const from = lap.distance[i - 1];
      const to = lap.distance[i];
      if (to - from >= thresholdM) raw.push([from, to]);
    }
  }
  raw.sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/** §5.2.3 — the y-axis is zero-centred and symmetric, `m = max|delta|` rounded up. */
export function symmetricBoundS(deltaS: readonly number[], stepS = 0.05): number {
  let m = 0;
  for (const v of deltaS) m = Math.max(m, Math.abs(v));
  return Math.max(stepS, Math.ceil(m / stepS) * stepS);
}
