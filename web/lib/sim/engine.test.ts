// SIM_SPEC §5.3 identities, §5.4 outputs, §5.5 replay parity and the §5.6 budget. Run with
// `npm test` (tsx --test). No DB, no React: everything runs on the fixture and synthetic models.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { drawTimeline, replay, simulate, SimPlanError } from "./engine";
import { expand, LENIENT_LIMITS, planSlots, validateStints } from "./plan";
import { mulberry32, Rng, scSeed } from "./prng";
import type { SimDriver, SimModel, SimPayload, SimStint } from "./types";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(HERE, "__fixtures__", "hungary2024.json");
const GOLDEN = path.resolve(HERE, "..", "..", "..", "tests", "fixtures", "sim_golden.json");

function loadFixture(): SimModel {
  const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as SimPayload;
  assert.equal(payload.status, "ok");
  if (payload.status !== "ok") throw new Error("unreachable");
  return payload.model;
}

/** Deep clone so a test can mutate its own copy. */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function firstSimulable(model: SimModel): SimDriver {
  const d = model.drivers.find((x) => x.simulable);
  assert.ok(d, "fixture has a simulable driver");
  return d;
}

/** Shift every pit lap by `by` laps (same compounds). */
function shiftPits(stints: SimStint[], by: number): SimStint[] {
  return stints.map((s, i) => (i < stints.length - 1 ? { ...s, endLap: s.endLap + by } : { ...s }));
}

/** Zero every source of randomness except the pit sample (§5.3 closed-form identity). */
function deterministicModel(model: SimModel): SimModel {
  const m = clone(model);
  m.race.paramChol = m.race.paramChol.map(() => 0);
  m.compounds.forEach((c) => {
    c.stintTauLevelS = 0;
    c.stintTauSlope = 0;
  });
  m.race.pitLoss = { ...m.race.pitLoss, source: "race", samplesS: [m.race.pitLoss.medianS], n: 1 };
  m.drivers.forEach((d) => {
    d.noiseSdS = 0;
    for (const k of Object.keys(d.dc)) d.dc[k].dcSe = 0;
  });
  return m;
}

describe("prng", () => {
  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });

  it("normal() has mean ≈ 0 and sd ≈ 1; t(4) is heavier-tailed; geometric ≥ 1", () => {
    const r = new Rng(7);
    const n = 20000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const z = r.normal();
      s += z;
      s2 += z * z;
    }
    const mean = s / n;
    const sd = Math.sqrt(s2 / n - mean * mean);
    assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
    assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
    let big = 0;
    for (let i = 0; i < n; i++) if (Math.abs(r.t(4)) > 3) big++;
    assert.ok(big / n > 0.01 && big / n < 0.06, `t4 tail share ${big / n}`);
    for (let i = 0; i < 1000; i++) {
      const g = r.geometric(1 / 5.44);
      assert.ok(Number.isInteger(g) && g >= 1);
    }
    assert.equal(r.geometric(1), 1);
  });

  it("the sc stream seed differs from the main seed", () => {
    assert.notEqual(scSeed(20240101), 20240101);
    assert.equal(scSeed(scSeed(20240101)), 20240101);
  });
});

describe("plan", () => {
  const compounds = ["HARD", "MEDIUM", "SOFT"];
  const limits = { minStintLaps: 2, maxStops: 4 };

  it("expands the §0.3 stint convention", () => {
    const p = expand([{ compound: "MEDIUM", endLap: 3 }, { compound: "HARD", endLap: 7 }], 7, 1, compounds, limits);
    assert.deepEqual(p.comp, ["MEDIUM", "MEDIUM", "MEDIUM", "HARD", "HARD", "HARD", "HARD"]);
    assert.deepEqual(Array.from(p.age), [1, 2, 3, 1, 2, 3, 4]);
    assert.deepEqual(Array.from(p.pitAt), [0, 0, 1, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(p.stintIdx), [0, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(p.stops, [3]);
    const used = expand([{ compound: "MEDIUM", endLap: 2 }, { compound: "HARD", endLap: 4 }], 4, 3, compounds, limits);
    assert.deepEqual(Array.from(used.age), [3, 4, 1, 2]);
  });

  it("rejects the §5.1 violations", () => {
    const err = (s: SimStint[], H = 10) => validateStints(s, H, compounds, limits)?.code ?? null;
    assert.equal(err([]), "empty");
    assert.equal(err([{ compound: "HARD", endLap: 10 }]), null);
    assert.equal(err([{ compound: "HARD", endLap: 9 }]), "wrongHorizon");
    assert.equal(err([{ compound: "HARD", endLap: 5 }, { compound: "HARD", endLap: 5 }]), "notIncreasing");
    assert.equal(err([{ compound: "HARD", endLap: 5 }, { compound: "HARD", endLap: 4 }]), "notIncreasing");
    assert.equal(err([{ compound: "HARD", endLap: 1 }, { compound: "HARD", endLap: 10 }]), "stintTooShort");
    assert.equal(err([{ compound: "HARD", endLap: 9 }, { compound: "HARD", endLap: 10 }]), "stintTooShort");
    assert.equal(err([{ compound: "HARD", endLap: 1 }], 1), null);
    assert.equal(err([{ compound: "WET", endLap: 10 }]), "unknownCompound");
    const six = [2, 4, 6, 8, 10, 12].map((endLap) => ({ compound: "HARD", endLap }));
    assert.equal(err(six, 12), "tooManyStops");
    assert.equal(err(six.slice(1).map((s) => s), 12), null);
    assert.throws(() => expand([], 5, 1, compounds, limits), SimPlanError);
  });

  it("LENIENT_LIMITS accept a real strategy: any number of stops, a 1-lap stint", () => {
    const err = (s: SimStint[], H: number) => validateStints(s, H, compounds, LENIENT_LIMITS)?.code ?? null;
    const seven = [1, 4, 6, 8, 10, 12, 14].map((endLap) => ({ compound: "HARD", endLap }));
    assert.equal(err(seven, 14), null, "6 stops and a 1-lap opening stint are data, not an edit");
    const p = expand(seven, 14, 1, compounds, LENIENT_LIMITS);
    assert.equal(p.stops.length, 6);
    assert.deepEqual(p.stops, [1, 4, 6, 8, 10, 12]);
    assert.deepEqual(Array.from(p.age.slice(0, 4)), [1, 1, 2, 3]);
    // The editor limits still reject exactly the same strategy.
    assert.equal(err([{ compound: "HARD", endLap: 5 }], 4), "wrongHorizon");
    assert.equal(validateStints(seven, 14, compounds, limits)?.code, "tooManyStops");
  });

  it("planSlots covers both plans and does not move with the edit", () => {
    const st = (n: number) => new Array(n).fill(0).map((_, i) => ({ compound: "HARD", endLap: i + 1 }));
    // 7 stints = 6 stops: the slot count follows the actual strategy, above the editor cap.
    assert.equal(planSlots(st(7), st(2), 4), 6);
    assert.equal(planSlots(st(7), st(5), 4), 6, "any legal edit leaves the count where the actual put it");
    // A normal actual strategy: the constants are the bound, whatever the (capped) edit does.
    assert.equal(planSlots(st(3), st(1), 4), 4);
    assert.equal(planSlots(st(3), st(5), 4), 4);
    assert.equal(planSlots(st(1), st(1), 4), 4);
  });
});

describe("simulate — §5.3 identities", () => {
  const model = loadFixture();
  const driver = firstSimulable(model);

  it("edited ≡ actual ⇒ delta is exactly 0 in every draw (both modes)", () => {
    for (const mode of ["asHappened", "random"] as const) {
      const r = simulate({ model, driver, edited: driver.actual.map((s) => ({ ...s })), mode });
      assert.equal(r.n, model.constants.draws);
      assert.equal(r.deltaMedianS, 0);
      assert.equal(r.deltaP10S, 0);
      assert.equal(r.deltaP90S, 0);
      assert.equal(r.deltaMeanS, 0);
      assert.equal(r.pBetter, 0);
      for (const l of r.perLap) {
        assert.equal(l.medianS, 0);
        assert.equal(l.p10S, 0);
        assert.equal(l.p90S, 0);
      }
      assert.equal(r.histogram.length, 30);
      assert.equal(r.histogram.reduce((a, b) => a + b.count, 0), r.n);
      assert.deepEqual(r.editedStops.map((s) => s.lap), driver.actualPitLaps);
      assert.equal(r.scLapsMean === null, mode === "asHappened");
    }
  });

  it("common random numbers: the same seed reproduces the result exactly", () => {
    const edited = shiftPits(driver.actual, 3);
    const a = simulate({ model, driver, edited, mode: "asHappened", draws: 500 });
    const b = simulate({ model, driver, edited, mode: "asHappened", draws: 500 });
    assert.deepEqual(a, b);
    const c = simulate({ model, driver, edited, mode: "asHappened", draws: 500, seed: 99 });
    assert.notEqual(a.deltaMedianS, c.deltaMedianS);
    assert.equal(a.seed, model.constants.seed);
    assert.equal(c.seed, 99);
    const ra = simulate({ model, driver, edited, mode: "random", draws: 500 });
    const rb = simulate({ model, driver, edited, mode: "random", draws: 500 });
    assert.deepEqual(ra, rb);
    assert.ok(ra.scLapsMean !== null && ra.scLapsMean >= 0);
  });

  it("quantiles are monotone and the histogram spans [p1, p99]", () => {
    const r = simulate({ model, driver, edited: shiftPits(driver.actual, 3), mode: "asHappened" });
    assert.ok(r.deltaP10S <= r.deltaMedianS && r.deltaMedianS <= r.deltaP90S);
    for (const l of r.perLap) assert.ok(l.p10S <= l.medianS && l.medianS <= l.p90S, `lap ${l.lap}`);
    assert.ok(r.pBetter >= 0 && r.pBetter <= 1);
    assert.equal(r.histogram.length, 30);
    for (let i = 1; i < 30; i++) {
      assert.ok(Math.abs(r.histogram[i].binStartS - r.histogram[i - 1].binEndS) < 1e-9);
      assert.ok(r.histogram[i].binEndS > r.histogram[i].binStartS);
    }
    assert.ok(r.histogram[0].binStartS <= r.deltaP10S && r.histogram[29].binEndS >= r.deltaP90S);
    assert.equal(r.histogram.reduce((a, b) => a + b.count, 0), r.n);
    assert.equal(r.perLap.length, r.horizonLaps);
    assert.equal(r.perLap[r.horizonLaps - 1].medianS, r.deltaMedianS);
  });

  it("moving one pit lap on the same compounds changes perLap only from the earlier pit lap on", () => {
    const edited = driver.actual.map((s, i) => (i === 0 ? { ...s, endLap: s.endLap + 4 } : { ...s }));
    const r = simulate({ model, driver, edited, mode: "asHappened", draws: 300 });
    const first = driver.actual[0].endLap;
    for (const l of r.perLap) {
      if (l.lap < first) {
        assert.equal(l.medianS, 0, `lap ${l.lap}`);
        assert.equal(l.p10S, 0);
        assert.equal(l.p90S, 0);
      }
    }
    assert.notEqual(r.perLap[first - 1].medianS, 0);
    assert.deepEqual(r.editedStops.map((s) => s.lap), edited.slice(0, -1).map((s) => s.endLap));
    assert.deepEqual(r.actualStops.map((s) => s.lap), driver.actualPitLaps);
    assert.ok(r.editedStops.every((s) => s.status === model.race.lapStatus[s.lap - 1]));
  });

  it("with tau = 0, chol = 0, dcSe = 0 and one pit sample the delta equals the closed form to 1e-9", () => {
    const m = deterministicModel(model);
    const d = firstSimulable(m);
    const edited: SimStint[] = [
      { compound: m.compounds[1].compound, endLap: 20 },
      { compound: m.compounds[0].compound, endLap: 44 },
      { compound: m.compounds[2].compound, endLap: d.lapsCompleted },
    ];
    const r = simulate({ model: m, driver: d, edited, mode: "asHappened", draws: 50 });
    const closed = replay(m, d, edited).totalFcS - replay(m, d, d.actual).totalFcS;
    assert.ok(Math.abs(r.deltaMedianS - closed) < 1e-9, `${r.deltaMedianS} vs ${closed}`);
    assert.ok(Math.abs(r.deltaP10S - closed) < 1e-9);
    assert.ok(Math.abs(r.deltaP90S - closed) < 1e-9);
    assert.ok(Math.abs(r.deltaMeanS - closed) < 1e-9);
    const eL = replay(m, d, edited).perLapS;
    const aL = replay(m, d, d.actual).perLapS;
    let cum = 0;
    for (let L = 0; L < d.lapsCompleted; L++) {
      cum += eL[L] - aL[L];
      assert.ok(Math.abs(r.perLap[L].medianS - cum) < 1e-9, `lap ${L + 1}`);
    }
  });

  it("horizon rule: both strategies run to the driver's lapsCompleted, never to the flag", () => {
    const d = clone(driver);
    d.lapsCompleted = 42;
    d.actual = [{ compound: d.actual[0].compound, endLap: 16 }, { compound: d.actual[1].compound, endLap: 42 }];
    d.actualPitLaps = [16];
    const r = simulate({ model, driver: d, edited: shiftPits(d.actual, 2), mode: "asHappened", draws: 200 });
    assert.equal(r.horizonLaps, 42);
    assert.equal(r.perLap.length, 42);
    assert.throws(
      () => simulate({ model, driver: d, edited: shiftPits(driver.actual, 0), mode: "asHappened", draws: 10 }),
      (e: unknown) => e instanceof SimPlanError && e.code === "wrongHorizon",
    );
    assert.throws(
      () => simulate({ model, driver: { ...d, actual: [], simulable: false }, edited: d.actual, mode: "asHappened" }),
      SimPlanError,
    );
    const noHazard = { ...model, hazard: null };
    assert.throws(() => simulate({ model: noHazard, driver: d, edited: d.actual, mode: "random" }), SimPlanError);
  });

  it("a used starting set keeps its age only when the edited first compound matches", () => {
    const m = deterministicModel(model);
    const d = clone(firstSimulable(m));
    d.actualStartAge = 4;
    const sameFirst = replay(m, d, d.actual);
    const swapped: SimStint[] = [{ compound: d.actual[1].compound, endLap: d.actual[0].endLap }, ...d.actual.slice(1)];
    const other = replay(m, d, swapped);
    // both replay from lap 1 with a different first compound; the first lap's age is 4 vs 1
    const c0 = m.compounds.find((c) => c.compound === d.actual[0].compound)!;
    const c1 = m.compounds.find((c) => c.compound === d.actual[1].compound)!;
    const dc0 = d.dc[c0.compound]?.dcOffsetS ?? 0;
    const dc1 = d.dc[c1.compound]?.dcOffsetS ?? 0;
    const expected = (c0.offsetS + dc0 + c0.degSPerLap * 3) - (c1.offsetS + dc1 + c1.degSPerLap * 0);
    assert.ok(Math.abs(sameFirst.perLapS[0] - other.perLapS[0] - expected) < 1e-9);
  });

  /** Every number a SimResult carries, for the "no NaN anywhere" assertion. */
  function everyNumber(r: ReturnType<typeof simulate>): number[] {
    const out = [r.n, r.horizonLaps, r.seed, r.deltaMedianS, r.deltaP10S, r.deltaP90S, r.deltaMeanS, r.pBetter];
    for (const h of r.histogram) out.push(h.binStartS, h.binEndS, h.count);
    for (const l of r.perLap) out.push(l.lap, l.medianS, l.p10S, l.p90S);
    for (const s of [...r.editedStops, ...r.actualStops]) out.push(s.lap);
    if (r.scLapsMean !== null) out.push(r.scLapsMean);
    return out;
  }

  /** A driver whose real strategy is `ends` (last must be the horizon) — data, not an edit. */
  function driverWithActual(ends: number[]): SimDriver {
    const d = clone(driver);
    const names = model.compounds.map((c) => c.compound);
    d.actual = ends.map((endLap, i) => ({ compound: names[i % names.length], endLap }));
    d.actualPitLaps = ends.slice(0, -1);
    return d;
  }

  it("a real strategy the editor would refuse still replays: 6 stops, a 1-lap stint, no NaN", () => {
    const H = driver.lapsCompleted;
    assert.ok(model.constants.maxStops < 6 && model.constants.minStintLaps > 1, "the editor limits bite");
    const cases: Record<string, SimDriver> = {
      "6 stops": driverWithActual([8, 16, 24, 32, 40, 48, H]),
      "1-lap opening stint (lap-1 puncture)": driverWithActual([1, 30, H]),
      "1-lap stint mid-race (red-flag change)": driverWithActual([20, 21, H]),
      "both at once": driverWithActual([1, 2, 12, 22, 32, 42, H]),
    };
    for (const [label, d] of Object.entries(cases)) {
      for (const mode of ["asHappened", "random"] as const) {
        const edited = d.actual.map((s) => ({ ...s }));
        const r = simulate({ model, driver: d, edited, mode, draws: 200 });
        for (const x of everyNumber(r)) assert.ok(Number.isFinite(x), `${label} / ${mode}: non-finite ${x}`);
        // edited ≡ actual ⇒ every draw is exactly 0: the whole histogram sits in one bin.
        assert.equal(r.deltaMedianS, 0, label);
        assert.equal(r.deltaP10S, 0, label);
        assert.equal(r.deltaP90S, 0, label);
        assert.equal(r.deltaMeanS, 0, label);
        assert.equal(r.pBetter, 0, label);
        assert.equal(Math.max(...r.histogram.map((h) => h.count)), r.n, `${label}: a draw moved off 0`);
        for (const l of r.perLap) {
          assert.equal(l.medianS, 0, `${label} lap ${l.lap}`);
          assert.equal(l.p10S, 0);
          assert.equal(l.p90S, 0);
        }
        assert.deepEqual(r.actualStops.map((s) => s.lap), d.actualPitLaps, label);
        assert.deepEqual(r.editedStops.map((s) => s.lap), d.actualPitLaps, label);
      }
    }
  });

  it("the editor limits still apply to a genuine edit of such a driver", () => {
    const H = driver.lapsCompleted;
    const d = driverWithActual([8, 16, 24, 32, 40, 48, H]);
    const names = model.compounds.map((c) => c.compound);
    const sixStopEdit = [8, 16, 24, 32, 40, 49, H].map((endLap, i) => ({ compound: names[i % names.length], endLap }));
    assert.throws(
      () => simulate({ model, driver: d, edited: sixStopEdit, mode: "asHappened", draws: 10 }),
      (e: unknown) => e instanceof SimPlanError && e.code === "tooManyStops",
    );
    const oneLapEdit = [{ compound: names[0], endLap: 1 }, { compound: names[1], endLap: H }];
    assert.throws(
      () => simulate({ model, driver: d, edited: oneLapEdit, mode: "asHappened", draws: 10 }),
      (e: unknown) => e instanceof SimPlanError && e.code === "stintTooShort",
    );
  });

  it("CRN survives the grown slot count: same seed, and the closed form over a 6-stop actual", () => {
    const H = driver.lapsCompleted;
    const d = driverWithActual([8, 16, 24, 32, 40, 48, H]);
    const names = model.compounds.map((c) => c.compound);
    const edited = [{ compound: names[0], endLap: 30 }, { compound: names[1], endLap: H }];
    const a = simulate({ model, driver: d, edited, mode: "asHappened", draws: 300 });
    const b = simulate({ model, driver: d, edited, mode: "asHappened", draws: 300 });
    assert.deepEqual(a, b);
    for (const x of everyNumber(a)) assert.ok(Number.isFinite(x), `non-finite ${x}`);
    // Two different edits of the same driver keep the per-draw consumption order, so a stop-lap
    // shift changes nothing before the earlier of the two pit laps.
    const later = [{ compound: names[0], endLap: 34 }, { compound: names[1], endLap: H }];
    const c = simulate({ model, driver: d, edited: later, mode: "asHappened", draws: 300 });
    for (let L = 0; L < 7; L++) assert.equal(a.perLap[L].medianS, c.perLap[L].medianS, `lap ${L + 1}`);
    // Closed form to 1e-9 with every other source of randomness switched off.
    const m = deterministicModel(model);
    const dm = driverWithActual([8, 16, 24, 32, 40, 48, H]);
    dm.dc = clone(firstSimulable(m).dc); // dcSe = 0 comes from the deterministic model's driver
    dm.noiseSdS = 0;
    const r = simulate({ model: m, driver: dm, edited, mode: "asHappened", draws: 50 });
    const closed = replay(m, dm, edited).totalFcS - replay(m, dm, dm.actual).totalFcS;
    assert.ok(Math.abs(r.deltaMedianS - closed) < 1e-9, `${r.deltaMedianS} vs ${closed}`);
    assert.ok(Math.abs(r.deltaMeanS - closed) < 1e-9);
  });

  it("random mode: the drawn timeline only contains G/S/V and starts under SC when scStartP = 1", () => {
    const out = new Uint8Array(20);
    const hazard = { ...model.hazard!, scStartP: 1, scDurMean: 3 };
    drawTimeline(new Rng(1), hazard, 20, out);
    assert.equal(out[0], 1);
    for (const s of out) assert.ok(s === 0 || s === 1 || s === 2);
    const never = new Uint8Array(20);
    drawTimeline(new Rng(1), { ...hazard, scStartP: 0, vscStartP: 0, scHazard: 0, vscHazard: 0 }, 20, never);
    assert.ok(never.every((s) => s === 0));
  });
});

describe("simulate — §5.6 budget", () => {
  it("N = 4000 over 70 laps runs in < 300 ms", () => {
    const model = loadFixture();
    const driver = firstSimulable(model);
    assert.equal(driver.lapsCompleted, 70);
    const edited = shiftPits(driver.actual, 3);
    simulate({ model, driver, edited, mode: "asHappened" }); // warm-up (JIT)
    const t0 = performance.now();
    const r = simulate({ model, driver, edited, mode: "asHappened" });
    const ms = performance.now() - t0;
    assert.equal(r.n, 4000);
    assert.ok(ms < 300, `simulate took ${ms.toFixed(1)} ms`);
    const t1 = performance.now();
    simulate({ model, driver, edited, mode: "random" });
    assert.ok(performance.now() - t1 < 300);
  });
});

describe("replay — §5.5", () => {
  it("matches calibration.simTotalFcS for every simulable driver of the fixture to 1e-6", () => {
    const model = loadFixture();
    for (const d of model.drivers) {
      if (!d.simulable || !d.calibration) continue;
      const r = replay(model, d, d.actual);
      assert.equal(r.perLapS.length, d.lapsCompleted);
      assert.ok(
        Math.abs(r.totalFcS - d.calibration.simTotalFcS) < 1e-6,
        `${d.code}: replay ${r.totalFcS} vs stored ${d.calibration.simTotalFcS}`,
      );
    }
  });

  it("useDeltas: false removes exactly Σ fieldDeltaS over the horizon", () => {
    const model = loadFixture();
    const d = firstSimulable(model);
    const withD = replay(model, d, d.actual).totalFcS;
    const without = replay(model, d, d.actual, { useDeltas: false }).totalFcS;
    const sum = model.race.fieldDeltaS.slice(0, d.lapsCompleted).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(withD - without - sum) < 1e-9);
  });

  it("golden fixture (tests/fixtures/sim_golden.json): replay reproduces Python to 1e-9", (t) => {
    if (!existsSync(GOLDEN)) {
      t.skip(`golden fixture not found at ${GOLDEN} — WP-S1 (tests/test_sim.py::test_write_golden) has not written it yet`);
      return;
    }
    type Golden = {
      model: SimModel;
      actual?: SimStint[];
      edited?: SimStint[];
      replay: Record<string, { total: number; per_lap: number[] }> | { actual: { total: number; per_lap: number[] }; edited: { total: number; per_lap: number[] } };
      delta: number;
    };
    const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
    const model = g.model;
    const d = model.drivers[0];
    const actual = g.actual ?? d.actual;
    const edited = g.edited;
    assert.ok(edited, "golden fixture carries the edited strategy");
    const rep = g.replay as { actual: { total: number; per_lap: number[] }; edited: { total: number; per_lap: number[] } };
    const ra = replay(model, d, actual);
    const re = replay(model, d, edited!);
    assert.ok(Math.abs(ra.totalFcS - rep.actual.total) < 1e-9, `actual total ${ra.totalFcS} vs ${rep.actual.total}`);
    assert.ok(Math.abs(re.totalFcS - rep.edited.total) < 1e-9, `edited total ${re.totalFcS} vs ${rep.edited.total}`);
    rep.actual.per_lap.forEach((v, i) => assert.ok(Math.abs(ra.perLapS[i] - v) < 1e-9, `actual lap ${i + 1}`));
    rep.edited.per_lap.forEach((v, i) => assert.ok(Math.abs(re.perLapS[i] - v) < 1e-9, `edited lap ${i + 1}`));
    assert.ok(Math.abs(re.totalFcS - ra.totalFcS - g.delta) < 1e-9);
  });
});
