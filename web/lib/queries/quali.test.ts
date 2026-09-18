// QUALI_SPEC §6 — unit tests for the pure half of the qualifying web surface. No
// database: every function under test is a reducer over rows the query layer returns,
// or a verbatim caption. The DB-backed half is verified by output/wp7/query-smoke.ts
// and the empty-state half by output/wp7/ssr-render.tsx.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CIRCUIT_HISTORY_MIN_SESSIONS,
  SEASON_H2H_MIN_SESSIONS,
  crossSegmentOkFrom,
  segmentRepairsFrom,
  waivedSegmentsFrom,
  wilson,
  type QualiRow,
  type QualiSegmentRow,
  type QualiToGridRow,
} from "@/lib/queries/quali";
import { bandBreaks } from "@/components/quali/QualiResultTable";
import { axisMax } from "@/components/quali/GapToPoleBars";
import { groupByDriver } from "@/components/quali/QualiSegmentStrip";
import { shouldRenderToGrid } from "@/components/quali/QualiToGridTable";
import {
  C_QUALI_1,
  C_QUALI_2,
  C_QUALI_4,
  C_QUALI_5,
  C_QUALI_7,
  C_QUALI_9,
  PARTIAL_SESSION_NOTE,
  segmentRepairNote,
} from "@/components/quali/captions";

function row(p: Partial<QualiRow> & { position: number }): QualiRow {
  return {
    driverId: `d${p.position}`,
    code: `D${p.position}`,
    teamId: "t",
    teamName: "T",
    colour: "#ff8000",
    lineStyle: "solid",
    q1S: null,
    q2S: null,
    q3S: null,
    bestS: null,
    bestSegment: null,
    segmentsEntered: 1,
    knockedOutIn: null,
    setATime: true,
    gapToPoleS: null,
    gapToPolePct: null,
    gapToPoleCommonS: null,
    gapToPoleCommonPct: null,
    gapToPoleSegment: null,
    nReprLaps: 0,
    pushLaps: 0,
    ...p,
  };
}

// --- §4.6 / §2.2: the two facts that live only in session_ingests.warnings[] ---------

test("cross_segment_ok is read from warnings, and absence is not a failure", () => {
  assert.equal(crossSegmentOkFrom(undefined), true);
  assert.equal(crossSegmentOkFrom([]), true);
  assert.equal(crossSegmentOkFrom(["quali_cross_segment_ok=True"]), true);
  // 2024 R05 China SQ (dry SQ1/SQ2, wet SQ3) and 2024 R21 Sao Paulo.
  assert.equal(crossSegmentOkFrom(["quali_cross_segment_ok=False"]), false);
  assert.equal(crossSegmentOkFrom(["x=1", "quali_cross_segment_ok=false"]), false);
});

test("segment repairs are read from warnings; Sao Paulo is three", () => {
  assert.equal(segmentRepairsFrom(undefined), 0);
  assert.equal(segmentRepairsFrom(["quali_segment_repairs=0"]), 0);
  assert.equal(
    segmentRepairsFrom(["quali_cross_segment_ok=False", "quali_segment_repairs=3"]),
    3,
  );
  assert.equal(segmentRepairsFrom(["quali_segment_repairs=nonsense"]), 0);
});

// --- §6.2 (a): elimination bands are DERIVED, never a hard-coded 15 or 10 -----------

test("band breaks come from knockedOutIn, not from a fixed 15/10 split", () => {
  // A 20-car session that lost two cars in Q1: the Q1 band ends at P14, not P15.
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => row({ position: i + 1, knockedOutIn: null })),
    ...Array.from({ length: 6 }, (_, i) => row({ position: i + 9, knockedOutIn: 2 })),
    ...Array.from({ length: 6 }, (_, i) => row({ position: i + 15, knockedOutIn: 1 })),
  ];
  const breaks = bandBreaks(rows);
  assert.deepEqual([...breaks.keys()], [7, 13]);
  assert.equal(breaks.get(7), "eliminated in Q2");
  assert.equal(breaks.get(13), "eliminated in Q1");
  // The Q2 band ends at P14 in this session, not at P15.
  assert.equal(rows[13].position, 14);
});

test("a session with one segment has no bands and does not throw", () => {
  assert.equal(bandBreaks([]).size, 0);
  assert.equal(bandBreaks([row({ position: 1 })]).size, 0);
});

// --- §6.2 (b): the axis is data-driven, because the measured span is 2.00%..4.20% ---

test("axisMax scales to the data and never returns zero", () => {
  assert.equal(axisMax([]), 1);
  assert.equal(axisMax([0, 0]), 1);
  assert.ok(axisMax([1, 2, 3]) > 3);
  assert.ok(axisMax([1, 2, 3]) < 3.5);
});

// --- §6.2 (c) ----------------------------------------------------------------------

test("the segment strip groups by driver in the query's order", () => {
  const seg = (driverId: string, segment: 1 | 2 | 3, pushLaps: number): QualiSegmentRow => ({
    driverId,
    code: driverId.toUpperCase(),
    colour: "#fff",
    segment,
    lapsRun: 3,
    reprLaps: 2,
    pushLaps,
    bestS: 80,
    gapToBestS: 0,
    gapToBestPct: 0,
    spreadS: pushLaps < 2 ? null : 0.2,
    sdS: pushLaps < 2 ? null : 0.1,
    compound: "SOFT",
    tyreLife: 1,
    wetCompound: false,
    verified: true,
  });
  const out = groupByDriver([seg("a", 1, 2), seg("a", 2, 1), seg("b", 1, 3)]);
  assert.deepEqual(out.map((d) => d.driverId), ["a", "b"]);
  assert.equal(out[0].points.length, 2);
  // A segment with fewer than two push laps carries no spread to draw a solid dot on.
  assert.equal(out[0].points[1].spreadS, null);
});

// --- §6.2 (e) / §6.6: twenty zeroes is noise ---------------------------------------

test("the qualified-versus-started table renders only when something moved", () => {
  const g = (placesMoved: number): QualiToGridRow => ({
    driverId: "d",
    code: "D",
    colour: "#fff",
    qualiPosition: 1,
    gridPosition: 1 + placesMoved,
    placesMoved,
  });
  assert.equal(shouldRenderToGrid([]), false);
  assert.equal(shouldRenderToGrid([g(0), g(0)]), false);
  assert.equal(shouldRenderToGrid([g(0), g(3)]), true);
});

// --- §6.5: the Wilson interval, computed in the query layer and NEVER stored ---------

test("wilson matches the spec's implementation and brackets the point estimate", () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo, hi] = wilson(13, 22); // §6.5's worked example, NOR 13 - 9 PIA
  assert.ok(lo < 13 / 22 && 13 / 22 < hi);
  assert.ok(Math.abs(lo - 0.38734) < 0.0005, `lo=${lo}`);
  assert.ok(Math.abs(hi - 0.76744) < 0.0005, `hi=${hi}`);
  // C-QUALI-5's claim: a 12-10 season is consistent with either driver being quicker.
  const [lo2, hi2] = wilson(12, 22);
  assert.ok(lo2 < 0.5 && hi2 > 0.5);
  // A whitewash still has width; the band is never a point.
  // A whitewash still has width; the band is never a point. (Floating point puts the
  // upper end a hair over 1, which is why the card clamps it before painting.)
  const [lo3, hi3] = wilson(5, 5);
  assert.ok(lo3 > 0.5 && hi3 - lo3 > 0.4);
});

test("the greyed thresholds are the spec's, not invented", () => {
  assert.equal(SEASON_H2H_MIN_SESSIONS, 5); // §6.5
  assert.equal(CIRCUIT_HISTORY_MIN_SESSIONS, 3); // §6.4
});

// --- §6.3: the captions ship verbatim ----------------------------------------------

test("each caption says what the number is NOT", () => {
  assert.ok(C_QUALI_1.startsWith("These are the official FIA times from the session, not a model."));
  assert.ok(C_QUALI_1.endsWith("which is not the same as not reaching it."));
  assert.ok(C_QUALI_2.includes("0.142% of a lap at Monaco and 0.105% at Shanghai"));
  assert.ok(C_QUALI_2.includes("Those two are not the same thing."));
  assert.ok(C_QUALI_4.includes("301 driver-segments"));
  assert.ok(C_QUALI_4.includes("twenty-six times smaller"));
  assert.ok(C_QUALI_5.includes("12–10 qualifying head-to-head"));
  assert.ok(C_QUALI_5.endsWith("Treat the band, not the score."));
  assert.ok(C_QUALI_7.endsWith("the session-wide gap to pole is not shown."));
  assert.ok(C_QUALI_9.startsWith("The quickest comparable lap of this session was not the pole lap."));
  // No caption may be silently shortened: §6.3 is prose, and a truncated caveat is a lie.
  for (const [name, text] of [
    ["C-QUALI-1", C_QUALI_1],
    ["C-QUALI-2", C_QUALI_2],
    ["C-QUALI-4", C_QUALI_4],
    ["C-QUALI-5", C_QUALI_5],
  ] as const) {
    assert.ok(text.length > 280, `${name} is suspiciously short (${text.length} chars)`);
  }
});

test("the provenance note reads as English for the one measured case (Sao Paulo, 3)", () => {
  assert.equal(
    segmentRepairNote(3),
    "Three lap times in this session were matched to their segment using the official times, " +
      "because the timing feed's segment boundaries did not account for a red flag.",
  );
  assert.ok(segmentRepairNote(1).startsWith("One lap time in this session was matched"));
  assert.ok(segmentRepairNote(7).startsWith("7 lap times in this session were matched"));
});

test("the partial-session note is the spec's sentence", () => {
  assert.equal(
    PARTIAL_SESSION_NOTE,
    "Per-segment analysis is not available for this session because its lap times could not be " +
      "matched to the segments they were set in.",
  );
});

test("waivedSegmentsFrom parses the one warning that names a two-numbers disagreement", () => {
  // The exact string session_ingests.warnings[] carries for 2024 R21 Q Sao Paulo, where
  // quali_results.q2_s and quali_segment_times.best_s disagree by up to 3.963 s.
  assert.deepEqual(waivedSegmentsFrom(["quali_waived_segments=ALB:2,ALO:2,PIA:2"]), [
    { code: "ALB", segment: 2 },
    { code: "ALO", segment: 2 },
    { code: "PIA", segment: 2 },
  ]);
  assert.deepEqual(waivedSegmentsFrom(["quali_segment_repairs=3"]), []);
  assert.deepEqual(waivedSegmentsFrom(null), []);
  assert.deepEqual(waivedSegmentsFrom([]), []);
  // A segment outside 1..3 cannot be rendered and is dropped rather than trusted.
  assert.deepEqual(waivedSegmentsFrom(["quali_waived_segments=XXX:9,ALO:3"]), [
    { code: "ALO", segment: 3 },
  ]);
});
