// SIM_SPEC §5.3–§5.5 — the browser Monte Carlo engine. Pure TypeScript: no React, no DOM, no
// imports from lib/queries (types come from ./types). One draw = one joint parameter draw shared
// by the edited and the actual strategy (common random numbers); delta = edited − actual.
import { Rng, scSeed } from "./prng";
import {
  editedStartAge,
  expand,
  LENIENT_LIMITS,
  planSlots,
  type PlanLimits,
  sameStrategy,
  SimPlanError,
} from "./plan";
import type {
  LapStatusCode,
  Plan,
  ReplayResult,
  SimDriver,
  SimHazard,
  SimInput,
  SimModel,
  SimResult,
  SimStint,
} from "./types";

export { SimPlanError } from "./plan";
export type { SimInput, SimMode, SimResult, ReplayResult } from "./types";

/** Status codes as small integers for the hot loop. */
const ST_G = 0;
const ST_S = 1;
const ST_V = 2;
const ST_R = 3;
const STATUS_CODE: LapStatusCode[] = ["G", "S", "V", "R"];

function statusToInt(s: LapStatusCode): number {
  return s === "S" ? ST_S : s === "V" ? ST_V : s === "R" ? ST_R : ST_G;
}

/** The actual strategy is replayed as stored: no editor limits (a 1-lap opening stint is data). */
const LENIENT: PlanLimits = LENIENT_LIMITS;

const MAD_TO_SD = 1.4826;

/** Per-compound point-estimate parameters resolved from the joint fit (index = model.compounds order). */
type CompoundTable = {
  names: string[];
  index: Map<string, number>;
  offIdx: Int32Array; // index into paramNames of "off:c", −1 for the reference compound / absent
  degIdx: Int32Array; // index into paramNames of "deg:c", −1 when absent
  offMean: Float64Array; // fallback point estimates (from sim_compound_params)
  degMean: Float64Array;
  tauLevel: Float64Array;
  tauSlope: Float64Array;
};

function compoundTable(model: SimModel): CompoundTable {
  const names = model.compounds.map((c) => c.compound);
  const n = names.length;
  const index = new Map<string, number>();
  const offIdx = new Int32Array(n);
  const degIdx = new Int32Array(n);
  const offMean = new Float64Array(n);
  const degMean = new Float64Array(n);
  const tauLevel = new Float64Array(n);
  const tauSlope = new Float64Array(n);
  const pn = model.race.paramNames;
  for (let i = 0; i < n; i++) {
    const c = model.compounds[i];
    index.set(c.compound, i);
    offIdx[i] = c.compound === model.race.refCompound ? -1 : pn.indexOf(`off:${c.compound}`);
    degIdx[i] = pn.indexOf(`deg:${c.compound}`);
    offMean[i] = c.compound === model.race.refCompound ? 0 : c.offsetS;
    degMean[i] = c.degSPerLap;
    tauLevel[i] = c.stintTauLevelS;
    tauSlope[i] = c.stintTauSlope;
  }
  return { names, index, offIdx, degIdx, offMean, degMean, tauLevel, tauSlope };
}

/** Compound index per lap for a plan (int8 is plenty: ≤ 5 compounds). */
function compIndex(plan: Plan, ct: CompoundTable): Int8Array {
  const out = new Int8Array(plan.comp.length);
  for (let i = 0; i < plan.comp.length; i++) {
    const ci = ct.index.get(plan.comp[i]);
    if (ci === undefined) throw new SimPlanError("unknownCompound", `${plan.comp[i]} is not a parameterised compound in this race`);
    out[i] = ci;
  }
  return out;
}

/** dc mean and se per compound for a driver (§1.3 browser rule for absent cells). */
function driverDc(driver: SimDriver, ct: CompoundTable, kDc: number): { mean: Float64Array; se: Float64Array } {
  const n = ct.names.length;
  const mean = new Float64Array(n);
  const se = new Float64Array(n);
  const fallbackSe = driver.noiseSdS / Math.sqrt(kDc);
  for (let i = 0; i < n; i++) {
    const cell = driver.dc[ct.names[i]];
    if (cell) {
      mean[i] = cell.dcOffsetS;
      se[i] = cell.dcSe;
    } else {
      mean[i] = 0;
      se[i] = fallbackSe;
    }
  }
  return { mean, se };
}

function factorFor(status: number, sc: number, vsc: number): number {
  return status === ST_S || status === ST_R ? sc : status === ST_V ? vsc : 1;
}

/**
 * §5.3 drawTimeline: fills `out[0..H-1]` with status ints from the circuit hazard. Lap 1 may start
 * an SC (prob scStartP) or else a VSC (prob vscStartP) episode; later free laps start an SC with
 * prob scHazard, else a VSC with prob vscHazard. Episode lengths are Geometric(1/durMean) on
 * {1, 2, …}; episodes never overlap. One uniform per free lap plus one per episode start.
 */
export function drawTimeline(rng: Rng, hazard: SimHazard, H: number, out: Uint8Array): void {
  let remaining = 0;
  let active = ST_G;
  for (let L = 0; L < H; L++) {
    if (remaining > 0) {
      out[L] = active;
      remaining--;
      continue;
    }
    const pSc = L === 0 ? hazard.scStartP : hazard.scHazard;
    const pVsc = L === 0 ? hazard.vscStartP : hazard.vscHazard;
    const u = rng.uniform();
    if (u < pSc) {
      active = ST_S;
      remaining = rng.geometric(1 / Math.max(1, hazard.scDurMean));
    } else if (pSc < 1 && (u - pSc) / (1 - pSc) < pVsc) {
      active = ST_V;
      remaining = rng.geometric(1 / Math.max(1, hazard.vscDurMean));
    } else {
      out[L] = ST_G;
      continue;
    }
    out[L] = active;
    remaining--;
  }
}

/** Lower nearest-rank quantile on a sorted array: sorted[floor(p·(N−1))]. */
function quantileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  let i = Math.floor(p * (n - 1));
  if (i < 0) i = 0;
  if (i > n - 1) i = n - 1;
  return sorted[i];
}

/** §5.4 `simulate`: N paired draws of the edited vs the actual strategy of one driver. */
export function simulate(input: SimInput): SimResult {
  const { model, driver, edited, mode } = input;
  const seed = input.seed ?? model.constants.seed;
  const N = Math.max(1, Math.floor(input.draws ?? model.constants.draws));
  const H = driver.lapsCompleted;
  const cst = model.constants;
  const strict: PlanLimits = { minStintLaps: cst.minStintLaps, maxStops: cst.maxStops };
  const ct = compoundTable(model);
  const actual = driver.actual;
  if (actual.length === 0) {
    throw new SimPlanError("empty", driver.notSimulableReason ?? "this driver cannot be simulated");
  }
  if (mode === "random" && model.hazard === null) {
    throw new SimPlanError("empty", "random safety cars need a circuit hazard row");
  }

  // §5.1: the ACTUAL strategy is data and is expanded with no editor limits. The
  // `minStintLaps`/`maxStops` limits apply ONLY to an edited strategy — except when the "edit" is
  // the actual strategy itself (the pristine state of the editor, and the parity check run by
  // scripts), which must replay for every driver, including the 105 of 963 simulable driver-races
  // (21 of 57 modelled races) whose real strategy has a stint under `minStintLaps` (104, from a
  // red-flag tyre change or a lap-1 puncture) or more than `maxStops` stops (18).
  const editedIsActual = sameStrategy(edited, actual);
  const planA = expand(actual, H, driver.actualStartAge, ct.names, LENIENT);
  const planE = expand(
    edited,
    H,
    editedStartAge(edited, actual, driver.actualStartAge),
    ct.names,
    editedIsActual ? LENIENT : strict,
  );
  const ciA = compIndex(planA, ct);
  const ciE = compIndex(planE, ct);

  // Pairing rule: edited stint k shares actual stint k's random effects when the compound matches.
  const nStE = edited.length;
  const pairWithA = new Uint8Array(nStE);
  for (let k = 0; k < nStE; k++) {
    pairWithA[k] = k < actual.length && edited[k].compound === actual[k].compound ? 1 : 0;
  }

  // Stop index per lap (−1 when no stop) for both plans.
  const stopIdxA = new Int32Array(H).fill(-1);
  const stopIdxE = new Int32Array(H).fill(-1);
  planA.stops.forEach((lap, k) => { stopIdxA[lap - 1] = k; });
  planE.stops.forEach((lap, k) => { stopIdxE[lap - 1] = k; });

  const K = model.race.paramNames.length;
  const theta0 = model.race.paramMean;
  const chol = model.race.paramChol;
  const nC = ct.names.length;
  // §5.2/§5.3: MAXP/MAXS are a shared upper bound over BOTH plans, not `cst.maxStops` alone —
  // sizing them from the constants alone left a driver whose real strategy has more stops than
  // the editor allows indexing past the end of the slot buffers, which read as NaN. The count is
  // a function of the actual strategy and the constants (an edited plan is capped at
  // `cst.maxStops` unless it is the actual strategy), so the per-draw consumption order stays
  // fixed and independent of the edit, and two edits under one seed remain comparable.
  const MAXP = planSlots(actual, edited, cst.maxStops);
  const MAXS = MAXP + 1;
  const kDc = cst.kDc;
  const degFloor = cst.degFloor;
  const dc = driverDc(driver, ct, kDc);
  const pit = model.race.pitLoss;
  const useSamples = pit.source === "race" && pit.samplesS.length > 0;
  const samples = pit.samplesS;
  const nSamples = samples.length;
  const scF = model.race.scPitFactor;
  const vscF = model.race.vscPitFactor;
  const noiseTDf = cst.noiseTDf;

  const asHappened = new Uint8Array(H);
  for (let L = 0; L < H; L++) asHappened[L] = statusToInt(model.race.lapStatus[L] ?? "G");

  const main = new Rng(seed);
  const scRng = new Rng(scSeed(seed));

  // Scratch buffers.
  const z = new Float64Array(K);
  const theta = new Float64Array(K);
  const off = new Float64Array(nC); // off[c] + dc[c] combined
  const deg = new Float64Array(nC);
  const uLevA = new Float64Array(MAXS);
  const uSlpA = new Float64Array(MAXS);
  const uLevE = new Float64Array(MAXS);
  const uSlpE = new Float64Array(MAXS);
  const uPit = new Float64Array(MAXP);
  const tPit = new Float64Array(MAXP);
  const pitLoss = new Float64Array(MAXP);
  const status = new Uint8Array(H);

  const delta = new Float64Array(N);
  const perLap = new Float64Array(N * H);
  let scLapsTotal = 0;

  for (let n = 0; n < N; n++) {
    // 1. joint parameter draw
    for (let i = 0; i < K; i++) z[i] = main.normal();
    for (let i = 0; i < K; i++) {
      let s = theta0[i];
      const row = i * K;
      for (let j = 0; j <= i; j++) s += chol[row + j] * z[j];
      theta[i] = s;
    }
    // 2. driver × compound deviation (every parameterised compound, fixed order)
    for (let c = 0; c < nC; c++) {
      const oi = ct.offIdx[c];
      const di = ct.degIdx[c];
      const o = oi >= 0 ? theta[oi] : ct.offMean[c];
      const d = di >= 0 ? theta[di] : ct.degMean[c];
      off[c] = o + dc.mean[c] + dc.se[c] * main.normal();
      deg[c] = d > degFloor ? d : degFloor;
    }
    // 3. stint random effects (unit normals; scaled by tau at use)
    for (let k = 0; k < MAXS; k++) {
      uLevA[k] = main.normal();
      uSlpA[k] = main.normal();
      uLevE[k] = main.normal();
      uSlpE[k] = main.normal();
    }
    // 4. pit draws
    for (let k = 0; k < MAXP; k++) {
      uPit[k] = main.uniform();
      tPit[k] = main.t(noiseTDf);
      pitLoss[k] = useSamples
        ? samples[Math.min(nSamples - 1, Math.floor(uPit[k] * nSamples))]
        : pit.medianS + pit.madS * MAD_TO_SD * tPit[k];
    }
    // 5. neutralisation timeline
    if (mode === "random") {
      drawTimeline(scRng, model.hazard as SimHazard, H, status);
      for (let L = 0; L < H; L++) if (status[L] !== ST_G) scLapsTotal++;
    } else {
      status.set(asHappened);
    }
    // 6. lap loop
    let cum = 0;
    const base = n * H;
    for (let L = 0; L < H; L++) {
      const cA = ciA[L];
      const kA = planA.stintIdx[L];
      const tauLA = ct.tauLevel[cA];
      const tauSA = ct.tauSlope[cA];
      let tA = off[cA] + (deg[cA] + tauSA * uSlpA[kA]) * (planA.age[L] - 1) + tauLA * uLevA[kA];

      const cE = ciE[L];
      const kE = planE.stintIdx[L];
      const paired = pairWithA[kE] === 1;
      const uL = paired ? uLevA[kE] : uLevE[kE];
      const uS = paired ? uSlpA[kE] : uSlpE[kE];
      let tE = off[cE] + (deg[cE] + ct.tauSlope[cE] * uS) * (planE.age[L] - 1) + ct.tauLevel[cE] * uL;

      const sA = stopIdxA[L];
      if (sA >= 0) tA += pitLoss[Math.min(sA, MAXP - 1)] * factorFor(status[L], scF, vscF);
      const sE = stopIdxE[L];
      if (sE >= 0) tE += pitLoss[Math.min(sE, MAXP - 1)] * factorFor(status[L], scF, vscF);

      cum += tE - tA;
      perLap[base + L] = cum;
    }
    delta[n] = cum;
  }

  // Outputs (§5.4).
  const sorted = Float64Array.from(delta).sort();
  let sum = 0;
  let better = 0;
  for (let n = 0; n < N; n++) {
    sum += delta[n];
    if (delta[n] < 0) better++;
  }
  const p1 = quantileSorted(sorted, 0.01);
  const p99 = quantileSorted(sorted, 0.99);
  const histogram = buildHistogram(delta, p1, p99, 30);

  const col = new Float64Array(N);
  const perLapOut: SimResult["perLap"] = new Array(H);
  for (let L = 0; L < H; L++) {
    for (let n = 0; n < N; n++) col[n] = perLap[n * H + L];
    col.sort();
    perLapOut[L] = {
      lap: L + 1,
      medianS: quantileSorted(col, 0.5),
      p10S: quantileSorted(col, 0.1),
      p90S: quantileSorted(col, 0.9),
    };
  }

  const stopStatus = (lap: number): LapStatusCode =>
    mode === "random" ? "G" : STATUS_CODE[asHappened[lap - 1]];

  return {
    n: N,
    horizonLaps: H,
    mode,
    seed,
    deltaMedianS: quantileSorted(sorted, 0.5),
    deltaP10S: quantileSorted(sorted, 0.1),
    deltaP90S: quantileSorted(sorted, 0.9),
    deltaMeanS: sum / N,
    pBetter: better / N,
    histogram,
    perLap: perLapOut,
    editedStops: planE.stops.map((lap) => ({ lap, status: stopStatus(lap) })),
    actualStops: planA.stops.map((lap) => ({ lap, status: stopStatus(lap) })),
    scLapsMean: mode === "random" ? scLapsTotal / N : null,
  };
}

/**
 * 30 equal bins over [p1, p99]; draws outside the range are counted in the edge bins so the
 * counts sum to N. A degenerate range (p1 == p99, e.g. edited ≡ actual) becomes ±0.5 s.
 */
function buildHistogram(delta: Float64Array, p1: number, p99: number, bins: number): SimResult["histogram"] {
  let lo = p1;
  let hi = p99;
  if (!(hi > lo)) {
    lo = p1 - 0.5;
    hi = p1 + 0.5;
  }
  const width = (hi - lo) / bins;
  const counts = new Int32Array(bins);
  for (let n = 0; n < delta.length; n++) {
    let b = Math.floor((delta[n] - lo) / width);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  const out: SimResult["histogram"] = new Array(bins);
  for (let b = 0; b < bins; b++) {
    out[b] = { binStartS: lo + b * width, binEndS: lo + (b + 1) * width, count: counts[b] };
  }
  return out;
}

/**
 * §5.5 `replay`: the deterministic fuel-corrected total of a strategy over 1..H — θ at the point
 * estimate (deg floored), dc means, random effects 0, pit loss medianS × factor(as-happened
 * status of the in-lap), plus base_d, evo·(L−1), fieldDeltaS[L−1] (unless useDeltas is false)
 * and startPenaltyS on lap 1. The exact arithmetic of Python `sim.replay` (§3.1).
 */
export function replay(
  model: SimModel,
  driver: SimDriver,
  stints: SimStint[],
  opts?: { useDeltas?: boolean },
): ReplayResult {
  const useDeltas = opts?.useDeltas ?? true;
  const H = driver.lapsCompleted;
  const ct = compoundTable(model);
  const startAge = editedStartAge(stints, driver.actual, driver.actualStartAge);
  const plan = expand(stints, H, startAge, ct.names, LENIENT);
  const ci = compIndex(plan, ct);
  const race = model.race;
  const pn = race.paramNames;
  const evoIdx = pn.indexOf("evo");
  const evo = evoIdx >= 0 ? race.paramMean[evoIdx] : race.evoSPerLap;
  const degFloor = model.constants.degFloor;

  const off = new Float64Array(ct.names.length);
  const deg = new Float64Array(ct.names.length);
  for (let c = 0; c < ct.names.length; c++) {
    const oi = ct.offIdx[c];
    const di = ct.degIdx[c];
    const o = oi >= 0 ? race.paramMean[oi] : ct.offMean[c];
    const d = di >= 0 ? race.paramMean[di] : ct.degMean[c];
    off[c] = o + (driver.dc[ct.names[c]]?.dcOffsetS ?? 0);
    deg[c] = d > degFloor ? d : degFloor;
  }
  const scF = race.scPitFactor;
  const vscF = race.vscPitFactor;
  const perLapS: number[] = new Array(H);
  let total = 0;
  for (let L = 0; L < H; L++) {
    const c = ci[L];
    let t = driver.baseS + off[c] + deg[c] * (plan.age[L] - 1) + evo * L;
    if (useDeltas) t += race.fieldDeltaS[L] ?? 0;
    if (L === 0) t += race.startPenaltyS;
    if (plan.pitAt[L]) {
      t += race.pitLoss.medianS * factorFor(statusToInt(race.lapStatus[L] ?? "G"), scF, vscF);
    }
    perLapS[L] = t;
    total += t;
  }
  return { totalFcS: total, perLapS };
}

/** Convenience for tests and the UI: the as-happened status code of a lap (1-based). */
export function lapStatusAt(model: SimModel, lap: number): LapStatusCode {
  return model.race.lapStatus[lap - 1] ?? "G";
}
