// ACCURACY_SPEC §5 — the pure scorers behind /accuracy, run against the two spec fixtures.
// No database: the query layer only fetches rows, so every convention (inclusive containment,
// the Winkler penalty, the clipped naive band, the quarter map, the final-round exclusion) is
// pinned here to the values the spec states.
import test from "node:test";
import assert from "node:assert/strict";

import {
  naiveBand,
  quarterOf,
  scoreIntervals,
  scorePointsBand,
  winkler,
  type IntervalRow,
  type PointsBandRow,
} from "@/lib/queries/accuracyScore";

const near = (actual: number | null, expected: number, places = 2) => {
  assert.notEqual(actual, null);
  assert.equal(Number((actual as number).toFixed(places)), expected);
};

// Fixture A: (p10, p90, actual, expected, grid), grid size 20.
const A: [number, number, number | null, number, number | null][] = [
  [5, 12, 8, 8, 6],
  [5, 12, 14, 10, 10],
  [1, 10, 1, 4, 1],
  [10, 19, 3, 15, 18],
  [3, 15, null, 9, 4],
  [2, 16, 9, 9, null],
];
const rowsA: IntervalRow[] = A.map(([p10, p90, actual, expected, grid]) => ({
  year: 2024, p10, p90, actual, expected, grid, gridSize: 20,
}));

test("winkler at alpha 0.2 charges 10 per place of miss", () => {
  assert.equal(winkler(5, 12, 8, 0.2), 7);
  assert.equal(winkler(5, 12, 14, 0.2), 27);
  assert.equal(winkler(10, 19, 3, 0.2), 79);
});

test("naiveBand clips to the grid and never starts below 1", () => {
  assert.deepEqual(naiveBand(0, 7, 20), [1, 7]);
  assert.deepEqual(naiveBand(19, 7, 20), [12, 20]);
  assert.deepEqual(naiveBand(6, 7, 20), [1, 13]);
  assert.deepEqual(naiveBand(10, 7, 20), [3, 17]);
});

test("fixture A: interval sharpness with the naive k = 7 comparator", () => {
  const s = scoreIntervals(rowsA, { alpha: 0.2, ks: [7] });
  assert.equal(s.total, 6);
  assert.equal(s.scored, 5);
  assert.equal(s.unscored, 1);
  assert.equal(s.noGrid, 1);
  near(s.coveragePct, 60.0, 1);
  near(s.dnfAsMissPct, 50.0, 1);
  near(s.meanWidth, 9.2, 1);
  assert.equal(s.minWidth, 7);
  assert.equal(s.maxWidth, 14);
  near(s.winkler, 27.2, 1);
  near(s.meanAbsError, 3.8, 1);
  near(s.shareOfGrid, 0.51);
  assert.equal(s.gridLo, 20);
  assert.equal(s.gridHi, 20);
  assert.equal(s.naive.length, 1);
  const n = s.naive[0];
  assert.equal(n.k, 7);
  near(n.meanWidth, 10.5, 1);
  near(n.coveragePct, 75.0, 1);
  near(n.winkler, 30.5, 1);
  near(n.meanAbsError, 5.25);
  // One season, so the per-season entry repeats the whole.
  assert.equal(s.bySeason.length, 1);
  assert.equal(s.bySeason[0].year, 2024);
  assert.equal(s.bySeason[0].gridSize, 20);
  assert.equal(s.bySeason[0].scored, 5);
  near(s.bySeason[0].winkler, 27.2, 1);
});

// Fixture B: one season, finalRound 8; (driver, afterRound, expected, p10, p90, shrunk).
const FINAL: Record<string, number | null> = { A: 100, B: 60, C: 20, D: null };
const B: [string, number, number, number, number, boolean][] = [
  ["A", 1, 80, 50, 110, false], ["A", 3, 90, 70, 100, false], ["A", 5, 95, 85, 105, false],
  ["A", 7, 98, 95, 101, false], ["A", 8, 100, 100, 100, false],
  ["B", 1, 90, 60, 120, true], ["B", 3, 70, 55, 85, false], ["B", 5, 75, 65, 85, false],
  ["B", 7, 62, 58, 66, false], ["B", 8, 60, 60, 60, false],
  ["C", 5, 30, 25, 40, false], ["C", 7, 21, 18, 24, false], ["C", 8, 20, 20, 20, false],
  ["D", 1, 40, 20, 60, false],
];
const rowsB: PointsBandRow[] = B.map(([driverId, afterRound, expectedPoints, p10, p90, isShrunk]) => ({
  year: 2024, driverId, afterRound, finalRound: 8, expectedPoints, p10, p90, isShrunk,
  finalPoints: FINAL[driverId],
}));

test("fixture B: points band by quarter, final-round row excluded", () => {
  const seasons = scorePointsBand(rowsB);
  assert.equal(seasons.length, 1);
  const s = seasons[0];
  assert.equal(s.year, 2024);
  assert.equal(s.finalRound, 8);
  assert.equal(s.drivers, 3);
  assert.equal(s.rows, 10);
  assert.equal(s.shrunkRows, 1);
  assert.equal(s.droppedRows, 1);
  assert.equal(s.nominalPct, 80);
  assert.equal(s.quarters.length, 4);
  const expected = [
    [1, 1, 2, 2, 100.0, 25.0, 60.0],
    [2, 3, 4, 2, 100.0, 10.0, 30.0],
    [3, 5, 6, 3, 33.3, 10.0, 18.33],
    [4, 7, 7, 3, 100.0, 1.67, 6.67],
  ];
  for (const [q, lo, hi, n, cov, mae, width] of expected) {
    const b = s.quarters[q - 1];
    assert.equal(b.q, q);
    assert.equal(b.roundLo, lo);
    assert.equal(b.roundHi, hi);
    assert.equal(b.n, n);
    near(b.coveragePct, cov, 1);
    near(b.meanAbsError, mae);
    near(b.meanWidth, width);
  }
  // Per-round rows: only rounds with a scored projection, never the final round.
  assert.deepEqual(s.rounds.map((r) => r.afterRound), [1, 3, 5, 7]);
  assert.equal(s.rounds[2].n, 3);
  near(s.rounds[2].coveragePct, 33.3, 1);
});

test("quarter map for 24- and 23-round seasons, and no season without rows", () => {
  const bounds = (R: number) =>
    [1, 2, 3, 4].map((q) => {
      const rs = Array.from({ length: R - 1 }, (_, i) => i + 1).filter((r) => quarterOf(r, R) === q);
      return [rs[0], rs[rs.length - 1]];
    });
  assert.deepEqual(bounds(24), [[1, 6], [7, 12], [13, 18], [19, 23]]);
  assert.deepEqual(bounds(23), [[1, 6], [7, 12], [13, 18], [19, 22]]);
  assert.equal(quarterOf(24, 24), 4);
  // The query fetches only seasons whose last standings round equals the last scheduled
  // round; a season that has not finished sends no rows, so it has no entry.
  assert.deepEqual(scorePointsBand([]), []);
});
