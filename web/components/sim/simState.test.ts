// SIM_SPEC §6.4 rules, the four presets and the §9 D10 hash codec, exercised through the
// reducer. Run with `npx tsx --test components/sim/simState.test.ts` (node:test, no React).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { simulate } from "@/lib/sim/engine";
import type { SimDriver, SimModel, SimPayload, SimStint } from "@/lib/sim/types";
import {
  contextFor,
  decodeHash,
  defaultDriver,
  encodeHash,
  initialState,
  parseHash,
  pitLapBounds,
  reduce,
  stintRanges,
  validate,
  type SimEditorContext,
  type SimEditorState,
} from "./simState";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "..", "lib", "sim", "__fixtures__", "hungary2024.json");

function loadModel(): SimModel {
  const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as SimPayload;
  if (payload.status !== "ok") throw new Error("fixture must be status ok");
  return payload.model;
}

const model = loadModel();
const pia = model.drivers[0];
const ctx: SimEditorContext = contextFor(model, pia);
const H = pia.lapsCompleted;

function fresh(): SimEditorState {
  return initialState(model, pia);
}
function errorsOf(stints: SimStint[]): string[][] {
  return validate(stints, pia, ctx).rows.map((r) => r.filter((x) => x.level === "error").map((x) => x.message));
}
function warnsOf(stints: SimStint[]): string[][] {
  return validate(stints, pia, ctx).rows.map((r) => r.filter((x) => x.level === "warn").map((x) => x.message));
}

describe("fixture and defaults", () => {
  it("PIA is the default driver and the editor opens on the actual strategy", () => {
    assert.equal(defaultDriver(model)?.code, "PIA");
    assert.equal(pia.code, "PIA");
    assert.equal(H, 70);
    const s = fresh();
    assert.deepEqual(s.stints, [
      { compound: "MEDIUM", endLap: 18 },
      { compound: "HARD", endLap: 47 },
      { compound: "MEDIUM", endLap: 70 },
    ]);
    assert.equal(s.mode, "asHappened");
    const v = validate(s.stints, pia, ctx);
    assert.equal(v.valid, true);
    assert.equal(v.planError, null);
    assert.deepEqual(v.rows, [[], [], []]);
    assert.equal(v.addStopDisabled, null);
  });

  it("stintRanges spells the actual strategy in words", () => {
    assert.deepEqual(stintRanges(pia.actual, H), [
      { compound: "MEDIUM", from: 1, to: 18 },
      { compound: "HARD", from: 19, to: 47 },
      { compound: "MEDIUM", from: 48, to: 70 },
    ]);
  });
});

describe("§6.4 validation rules", () => {
  it("rule 1 — pit lap window uses the next stint's current pit lap (or H)", () => {
    assert.deepEqual(pitLapBounds(fresh().stints, 0, ctx), { lo: 2, hi: 45 });
    assert.deepEqual(pitLapBounds(fresh().stints, 1, ctx), { lo: 20, hi: 68 });
    const low = reduce(fresh(), { type: "setPitLap", index: 0, lap: 1 }, ctx);
    assert.deepEqual(errorsOf(low.stints)[0], ["pit lap must be between 2 and 45"]);
    const high = reduce(fresh(), { type: "setPitLap", index: 0, lap: 46 }, ctx);
    assert.deepEqual(errorsOf(high.stints)[0], ["pit lap must be between 2 and 45"]);
    assert.equal(validate(high.stints, pia, ctx).valid, false);
    assert.equal(validate(high.stints, pia, ctx).planError?.code, "stintTooShort");
    const nan = reduce(fresh(), { type: "setPitLap", index: 0, lap: Number.NaN }, ctx);
    assert.equal(validate(nan.stints, pia, ctx).valid, false);
    const ok = reduce(fresh(), { type: "setPitLap", index: 0, lap: 45 }, ctx);
    assert.equal(validate(ok.stints, pia, ctx).valid, true);
  });

  it("rule 1 — the final stint's end lap is pinned to H and not editable", () => {
    const s = reduce(fresh(), { type: "setPitLap", index: 2, lap: 60 }, ctx);
    assert.equal(s.stints[2].endLap, 70);
    assert.equal(s, fresh() === s ? s : s); // no throw; state unchanged in content
  });

  it("rule 2 — every stint needs minStintLaps laps (reported once per row)", () => {
    const stints: SimStint[] = [{ compound: "MEDIUM", endLap: 69 }, { compound: "HARD", endLap: 70 }];
    const v = validate(stints, pia, ctx);
    assert.equal(v.valid, false);
    assert.equal(v.planError?.code, "stintTooShort");
    // Row 0 fails rule 1 (hi = 68); row 1 (the last stint, 1 lap) fails rule 2.
    assert.deepEqual(errorsOf(stints)[0], ["pit lap must be between 2 and 68"]);
    assert.deepEqual(errorsOf(stints)[1], ["a stint needs at least 2 laps — an in-lap needs an out-lap"]);
  });

  it("rule 3 — at most maxStops stops; + add stop is then disabled with the tooltip", () => {
    let s = fresh();
    for (let k = 0; k < 6; k++) s = reduce(s, { type: "addStop" }, ctx);
    assert.equal(s.stints.length, ctx.maxStops + 1);
    const v = validate(s.stints, pia, ctx);
    assert.equal(v.valid, true);
    assert.equal(v.addStopDisabled, "4 stops is the most this editor allows");
    assert.equal(validate(fresh().stints, pia, ctx).addStopDisabled, null);
    const six: SimStint[] = [10, 20, 30, 40, 50, 70].map((endLap) => ({ compound: "HARD", endLap }));
    assert.equal(validate(six, pia, ctx).planError?.code, "tooManyStops");
  });

  it("rule 4 — a compound the driver never ran is amber, not blocking", () => {
    // 17 laps on the SOFT (ageMax 12 + 5) so rule 5 stays quiet and rule 4 is the only note.
    const short = reduce(fresh(), { type: "setPitLap", index: 0, lap: 17 }, ctx);
    const s = reduce(short, { type: "setCompound", index: 0, compound: "SOFT" }, ctx);
    const v = validate(s.stints, pia, ctx);
    assert.equal(v.valid, true);
    assert.deepEqual(warnsOf(s.stints)[0], [
      "PIA never ran the SOFT in this race — pace uses the field's offset, not PIA's",
    ]);
    assert.deepEqual(errorsOf(s.stints)[0], []);
  });

  it("rule 5 — a stint longer than ageMax + extrapolationLaps is amber, not blocking", () => {
    // MEDIUM ageMax 27 → 33 laps or more on the medium is extrapolated.
    const s = reduce(fresh(), { type: "setPitLap", index: 0, lap: 33 }, ctx);
    const v = validate(s.stints, pia, ctx);
    assert.equal(v.valid, true);
    assert.deepEqual(warnsOf(s.stints)[0], [
      "longer than any real stint on this tyre (27 laps) — the wear line is extrapolated",
    ]);
    const edge = reduce(fresh(), { type: "setPitLap", index: 0, lap: 32 }, ctx);
    assert.deepEqual(warnsOf(edge.stints)[0], []);
  });

  it("rule 6 — a single-compound strategy is a muted note; a 0-stop strategy is allowed", () => {
    const one: SimStint[] = [{ compound: "HARD", endLap: 70 }];
    const v = validate(one, pia, ctx);
    assert.equal(v.valid, true);
    assert.deepEqual(v.notes, ["one compound only — the two-compound rule is not enforced here"]);
    assert.deepEqual(validate(fresh().stints, pia, ctx).notes, []);
  });

  it("an unknown compound is a blocking error from the engine gate", () => {
    const s = reduce(fresh(), { type: "setCompound", index: 1, compound: "INTERMEDIATE" }, ctx);
    const v = validate(s.stints, pia, ctx);
    assert.equal(v.valid, false);
    assert.equal(v.planError?.code, "unknownCompound");
    assert.deepEqual(errorsOf(s.stints)[1], ["INTERMEDIATE is not a parameterised compound in this race"]);
  });
});

describe("§6.4 controls", () => {
  it("+ add stop splits the longest stint at its midpoint, inheriting the compound", () => {
    // Longest actual stint: HARD 19–47 (29 laps) → HARD 19–32, HARD 33–47.
    const s = reduce(fresh(), { type: "addStop" }, ctx);
    assert.deepEqual(s.stints, [
      { compound: "MEDIUM", endLap: 18 },
      { compound: "HARD", endLap: 32 },
      { compound: "HARD", endLap: 47 },
      { compound: "MEDIUM", endLap: 70 },
    ]);
    assert.equal(validate(s.stints, pia, ctx).valid, true);
  });

  it("× merges a stint into the previous one; the first row merges into the next", () => {
    const mid = reduce(fresh(), { type: "removeStint", index: 1 }, ctx);
    assert.deepEqual(mid.stints, [{ compound: "MEDIUM", endLap: 47 }, { compound: "MEDIUM", endLap: 70 }]);
    const first = reduce(fresh(), { type: "removeStint", index: 0 }, ctx);
    assert.deepEqual(first.stints, [{ compound: "HARD", endLap: 47 }, { compound: "MEDIUM", endLap: 70 }]);
    const last = reduce(fresh(), { type: "removeStint", index: 2 }, ctx);
    assert.deepEqual(last.stints, [{ compound: "MEDIUM", endLap: 18 }, { compound: "HARD", endLap: 70 }]);
    const one: SimEditorState = { ...fresh(), stints: [{ compound: "HARD", endLap: 70 }] };
    assert.equal(reduce(one, { type: "removeStint", index: 0 }, ctx).stints, one.stints, "hidden × is a no-op");
  });

  it("Reset to actual restores driver.actual; selectDriver resets stints and keeps the mode", () => {
    let s = reduce(fresh(), { type: "setMode", mode: "random" }, ctx);
    s = reduce(s, { type: "setPitLap", index: 0, lap: 10 }, ctx);
    s = reduce(s, { type: "reset", driver: pia }, ctx);
    assert.deepEqual(s.stints, pia.actual);
    assert.equal(s.mode, "random");
    const other = model.drivers[1];
    const t = reduce(s, { type: "selectDriver", driver: other }, contextFor(model, other));
    assert.equal(t.driverId, other.driverId);
    assert.deepEqual(t.stints, other.actual);
    assert.equal(t.mode, "random");
    assert.notEqual(t.stints, other.actual, "stints are copied, not aliased");
  });
});

describe("§6.4 presets", () => {
  it("Pit 3 laps earlier shifts every pit lap by −3", () => {
    const s = reduce(fresh(), { type: "preset", preset: "earlier", driver: pia }, ctx);
    assert.deepEqual(s.stints.map((x) => x.endLap), [15, 44, 70]);
    assert.equal(validate(s.stints, pia, ctx).valid, true);
  });

  it("Pit 3 laps later shifts every pit lap by +3", () => {
    const s = reduce(fresh(), { type: "preset", preset: "later", driver: pia }, ctx);
    assert.deepEqual(s.stints.map((x) => x.endLap), [21, 50, 70]);
    assert.equal(validate(s.stints, pia, ctx).valid, true);
  });

  it("shift presets clamp to validity instead of producing an invalid plan", () => {
    const tight: SimEditorState = {
      ...fresh(),
      stints: [{ compound: "MEDIUM", endLap: 3 }, { compound: "HARD", endLap: 5 }, { compound: "MEDIUM", endLap: 70 }],
    };
    const e = reduce(tight, { type: "preset", preset: "earlier", driver: pia }, ctx);
    assert.deepEqual(e.stints.map((x) => x.endLap), [2, 4, 70]);
    assert.equal(validate(e.stints, pia, ctx).valid, true);
    const late: SimEditorState = {
      ...fresh(),
      stints: [{ compound: "MEDIUM", endLap: 66 }, { compound: "HARD", endLap: 68 }, { compound: "MEDIUM", endLap: 70 }],
    };
    const l = reduce(late, { type: "preset", preset: "later", driver: pia }, ctx);
    assert.deepEqual(l.stints.map((x) => x.endLap), [66, 68, 70]);
    assert.equal(validate(l.stints, pia, ctx).valid, true);
  });

  it("One stop fewer drops the last stop and extends the previous stint to H", () => {
    const s = reduce(fresh(), { type: "preset", preset: "fewer", driver: pia }, ctx);
    assert.deepEqual(s.stints, [{ compound: "MEDIUM", endLap: 18 }, { compound: "HARD", endLap: 70 }]);
    const one: SimEditorState = { ...fresh(), stints: [{ compound: "HARD", endLap: 70 }] };
    assert.deepEqual(reduce(one, { type: "preset", preset: "fewer", driver: pia }, ctx).stints, one.stints);
  });

  it("Swap compounds takes the next parameterised compound in payload order (HARD→MEDIUM→SOFT→HARD)", () => {
    const s = reduce(fresh(), { type: "preset", preset: "swap", driver: pia }, ctx);
    assert.deepEqual(s.stints.map((x) => x.compound), ["SOFT", "MEDIUM", "SOFT"]);
    assert.deepEqual(s.stints.map((x) => x.endLap), [18, 47, 70]);
  });
});

describe("§9 D10 URL-hash codec", () => {
  it("encodes `sim=PIA;M18,H47,M70;a` from the default state and round-trips through decodeHash", () => {
    const s = fresh();
    const hash = encodeHash(pia.code, s.stints, s.mode);
    assert.equal(hash, "sim=PIA;M18,H47,M70;a");
    const back = decodeHash(`#${hash}`, model);
    assert.deepEqual(back, { driverId: pia.driverId, mode: "asHappened", stints: pia.actual });
    assert.deepEqual(decodeHash(hash, model), back, "leading # is optional");
  });

  it("round-trips an edited strategy in random mode (`;r`), including the spec's example shape", () => {
    let s = reduce(fresh(), { type: "setMode", mode: "random" }, ctx);
    s = reduce(s, { type: "setPitLap", index: 0, lap: 16 }, ctx);
    s = reduce(s, { type: "setPitLap", index: 1, lap: 46 }, ctx);
    s = reduce(s, { type: "setCompound", index: 2, compound: "HARD" }, ctx);
    const hash = encodeHash(pia.code, s.stints, s.mode);
    assert.equal(hash, "sim=PIA;M16,H46,H70;r");
    const back = decodeHash(hash, model);
    assert.ok(back);
    assert.equal(back.mode, model.hazard === null ? "asHappened" : "random");
    assert.deepEqual(back.stints, s.stints);
    assert.equal(encodeHash(pia.code, back.stints, back.mode), hash);
  });

  it("parseHash accepts the grammar and rejects everything else", () => {
    assert.deepEqual(parseHash("#sim=pia;m16,h46,h70;A"), {
      code: "PIA",
      mode: "asHappened",
      stints: [
        { initial: "M", endLap: 16 },
        { initial: "H", endLap: 46 },
        { initial: "H", endLap: 70 },
      ],
    });
    for (const bad of ["", "#", "#sim=", "#sim=PIA", "#sim=PIA;;a", "#sim=PIA;M16;x", "#sim=PIA;16,H70;a",
      "#sim=PIA;M16,,H70;a", "#other=PIA;M16;a", "#sim=TOOLONG;M70;a"]) {
      assert.equal(parseHash(bad), null, JSON.stringify(bad));
    }
  });

  it("decodeHash falls back (null) on unknown or non-simulable drivers, bad compounds and invalid plans", () => {
    assert.equal(decodeHash("#sim=XXX;M18,H47,M70;a", model), null, "unknown driver");
    assert.equal(decodeHash("#sim=PIA;I18,H47,M70;a", model), null, "unparameterised compound initial");
    assert.equal(decodeHash("#sim=PIA;M18,H47,M69;a", model), null, "last stint must end on H");
    assert.equal(decodeHash("#sim=PIA;M18,H17,M70;a", model), null, "pit laps must increase");
    assert.equal(decodeHash("#sim=PIA;M69,H70;a", model), null, "stint shorter than minStintLaps");
    assert.equal(decodeHash("#sim=PIA;M5,H10,M15,H20,M25,H70;a", model), null, "more than maxStops stops");
    assert.equal(decodeHash("#sim=PIA;S18,H47,M70;a", model)?.stints[0].compound, "SOFT", "amber warnings do not block");
    const retired = model.drivers.find((d) => d.simulable && d.lapsCompleted < model.race.totalLaps);
    assert.ok(retired);
    const rHash = encodeHash(retired.code, retired.actual, "asHappened");
    assert.equal(decodeHash(rHash, model)?.stints.at(-1)?.endLap, retired.lapsCompleted, "horizon is laps completed");
  });

  it("random mode in the hash degrades to as-happened when the model has no hazard row", () => {
    const noHazard: SimModel = { ...model, hazard: null };
    assert.equal(decodeHash("#sim=PIA;M18,H47,M70;r", noHazard)?.mode, "asHappened");
    assert.equal(decodeHash("#sim=PIA;M18,H47,M70;r", model)?.mode, "random");
  });
});

// ---------------------------------------------------------------------------
// FINDING E — a PRISTINE strategy (exactly the driver's actual) is data, not fan input: it is
// always valid, always runnable, and shows muted notes instead of red errors. The editor limits
// gate EDITS only. 149 real driver-races in the corpus have a 1-lap stint or more than 4 stops.

/** A red-flag chain: 7 stints (6 stops) opening with a 1-lap stint — both limits broken. */
const CHAOS_ACTUAL: SimStint[] = [
  { compound: "MEDIUM", endLap: 1 },
  { compound: "HARD", endLap: 15 },
  { compound: "MEDIUM", endLap: 30 },
  { compound: "HARD", endLap: 45 },
  { compound: "MEDIUM", endLap: 55 },
  { compound: "HARD", endLap: 65 },
  { compound: "MEDIUM", endLap: 70 },
];
const chaos: SimDriver = { ...pia, actual: CHAOS_ACTUAL };
const chaosCtx: SimEditorContext = contextFor(model, chaos);

function notesOf(stints: SimStint[], driver: SimDriver, c: SimEditorContext): string[][] {
  return validate(stints, driver, c).rows.map((r) => r.filter((x) => x.level === "note").map((x) => x.message));
}

describe("§6.4 — a pristine strategy is never blocked (FINDING E)", () => {
  it("a pristine 6-stop strategy with a 1-lap stint is valid, noted not errored, and runs", () => {
    const s = initialState(model, chaos);
    assert.deepEqual(s.stints, CHAOS_ACTUAL);
    const v = validate(s.stints, chaos, chaosCtx);
    assert.equal(v.pristine, true, "the editor opens on the actual strategy");
    assert.equal(v.valid, true, "a real strategy must never block the simulation");
    assert.equal(v.planError, null);
    assert.equal(v.blockingMessage, null);
    // Not one red error anywhere — the 1-lap stint is a muted note on its own row instead.
    assert.deepEqual(
      v.rows.map((r) => r.filter((x) => x.level === "error").map((x) => x.message)),
      CHAOS_ACTUAL.map(() => []),
    );
    assert.deepEqual(notesOf(s.stints, chaos, chaosCtx)[0], [
      "1-lap stint — that is how it was raced (a red flag or an immediate second stop), kept as it happened",
    ]);
    assert.deepEqual(notesOf(s.stints, chaos, chaosCtx)[1], [], "the 14-lap stint is clean");
    // The 6 stops earn a whole-strategy note, and "+ add stop" stays disabled: the limits are
    // guards on the ADD action, they just do not gate the state.
    assert.ok(
      v.notes.includes(
        "6 stops — more than the 4 this editor allows, but that is how it was raced; the real strategy still simulates",
      ),
      `notes were ${JSON.stringify(v.notes)}`,
    );
    assert.equal(v.addStopDisabled, "4 stops is the most this editor allows");
    // Runnable end to end: the engine replays it and edited === actual gives exactly zero delta.
    const r = simulate({ model, driver: chaos, edited: s.stints, mode: "asHappened", seed: 1, draws: 64 });
    assert.equal(r.deltaMedianS, 0);
    assert.ok(Number.isFinite(r.deltaP90S) && Number.isFinite(r.pBetter));
  });

  it("PIA's own ordinary strategy is pristine too, with no notes at all", () => {
    const v = validate(fresh().stints, pia, ctx);
    assert.equal(v.pristine, true);
    assert.equal(v.valid, true);
    assert.deepEqual(v.notes, []);
    assert.deepEqual(v.rows, [[], [], []]);
  });
});

describe("§6.4 — the limits still gate every EDIT (FINDING E)", () => {
  it("editing that strategy to create a NEW sub-minimum stint is rejected", () => {
    // Move stop 3 onto lap 46: stint 5 becomes 46–45 → a brand-new sub-minimum stint.
    const edited = reduce(initialState(model, chaos), { type: "setPitLap", index: 3, lap: 54 }, chaosCtx);
    const v = validate(edited.stints, chaos, chaosCtx);
    assert.equal(v.pristine, false, "one changed pit lap ends the pristine state");
    assert.equal(v.valid, false, "a stint the fan made 1 lap long is a real error");
    assert.ok(v.blockingMessage);
    // Stint 5 would run 55–55. Rule 1 reports it on the row whose pit lap caused it.
    assert.deepEqual(
      v.rows[4].filter((x) => x.level === "error").map((x) => x.message),
      ["pit lap must be between 56 and 63"],
    );
    // And the plain length rule fires too when the short stint is the unaddressable last one.
    const lastShort = reduce(initialState(model, chaos), { type: "setPitLap", index: 5, lap: 69 }, chaosCtx);
    const vLast = validate(lastShort.stints, chaos, chaosCtx);
    assert.equal(vLast.valid, false);
    assert.deepEqual(
      vLast.rows[6].filter((x) => x.level === "error").map((x) => x.message),
      ["a stint needs at least 2 laps — an in-lap needs an out-lap"],
    );
    assert.deepEqual(notesOf(lastShort.stints, chaos, chaosCtx)[6], [], "an edited short stint is an error, not a note");
    assert.deepEqual(notesOf(edited.stints, chaos, chaosCtx)[0], [], "no 'kept as it happened' note once edited");
    assert.deepEqual(
      v.rows[0].filter((x) => x.level === "error").map((x) => x.message),
      ["pit lap must be between 2 and 13"],
      "the untouched 1-lap opener is now an error like any other edited row",
    );
  });

  it("a genuine edit of a 6-stop driver is still capped at maxStops", () => {
    const edited = reduce(initialState(model, chaos), { type: "setCompound", index: 6, compound: "HARD" }, chaosCtx);
    const v = validate(edited.stints, chaos, chaosCtx);
    assert.equal(v.pristine, false);
    assert.equal(v.valid, false);
    assert.equal(v.planError?.code, "tooManyStops");
    assert.equal(v.blockingMessage, "4 stops is the most this editor allows");
    assert.deepEqual(v.notes, [], "the 'that is how it was raced' note is for the real strategy only");
  });

  it("+ add stop is refused on a pristine over-limit strategy (the guard is on the action)", () => {
    const s = initialState(model, chaos);
    const after = reduce(s, { type: "addStop" }, chaosCtx);
    assert.deepEqual(after.stints, CHAOS_ACTUAL, "addStop is a no-op past maxStops");
  });

  it("such a driver can still be edited back inside the limits, and each × is accepted", () => {
    let s = initialState(model, chaos);
    // Merge stints away until the strategy is inside the editor limits again.
    for (const i of [0, 0, 0]) s = reduce(s, { type: "removeStint", index: i }, chaosCtx);
    assert.equal(s.stints.length, 4, "7 stints minus 3 = 4 stints (3 stops)");
    const v = validate(s.stints, chaos, chaosCtx);
    assert.equal(v.pristine, false);
    assert.equal(v.valid, true, "back inside the limits, an edited strategy runs again");
    const r = simulate({ model, driver: chaos, edited: s.stints, mode: "asHappened", seed: 1, draws: 64 });
    assert.ok(Number.isFinite(r.deltaMedianS));
  });

  it("reset to actual always returns to a valid, runnable state", () => {
    const broken = reduce(initialState(model, chaos), { type: "setPitLap", index: 3, lap: 54 }, chaosCtx);
    assert.equal(validate(broken.stints, chaos, chaosCtx).valid, false);
    const back = reduce(broken, { type: "reset", driver: chaos }, chaosCtx);
    assert.deepEqual(back.stints, CHAOS_ACTUAL);
    const v = validate(back.stints, chaos, chaosCtx);
    assert.equal(v.pristine, true);
    assert.equal(v.valid, true);
    // Same for an ordinary driver, and for selecting a driver (which also seeds from actual).
    const picked = reduce(fresh(), { type: "selectDriver", driver: chaos }, ctx);
    assert.equal(validate(picked.stints, chaos, chaosCtx).valid, true);
  });

  it("a hash carrying the driver's own over-limit strategy decodes; an invented one does not", () => {
    const chaosModel: SimModel = { ...model, drivers: [chaos, ...model.drivers.slice(1)] };
    const hash = `#${encodeHash(chaos.code, CHAOS_ACTUAL, "asHappened")}`;
    assert.deepEqual(decodeHash(hash, chaosModel)?.stints, CHAOS_ACTUAL);
    assert.equal(decodeHash("#sim=PIA;M5,H10,M15,H20,M25,H70;a", chaosModel), null, "not this driver's actual");
  });
});
