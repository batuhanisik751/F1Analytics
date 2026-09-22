// LEDGER_SPEC §5 — the pure helpers behind the preview ledger, pinned without a database.
import test from "node:test";
import assert from "node:assert/strict";

import {
  coverage,
  parseClassified,
  rankAgreement,
  scoredSnapshot,
  spearman,
  topThree,
  type LedgerDriver,
} from "@/lib/accuracy/ledger";

const near = (actual: number | null, expected: number, places = 6) => {
  assert.notEqual(actual, null);
  assert.equal(Number((actual as number).toFixed(places)), expected);
};

const drv = (
  driverId: string,
  expectedPosition: number,
  posP10: number,
  posP90: number,
  actual: number | null,
): LedgerDriver => ({ driverId, code: driverId.toUpperCase(), expectedPosition, posP10, posP90, actual });

// --- spearman -----------------------------------------------------------------------

test("spearman: identical order = 1, reversed = -1", () => {
  near(spearman([[1, 1], [2, 2], [3, 3], [4, 4]]), 1);
  near(spearman([[1, 4], [2, 3], [3, 2], [4, 1]]), -1);
});

test("spearman: ties take average ranks", () => {
  // x has a tie at the top (ranks 1.5, 1.5, 3, 4); y is 1..4 → Pearson on ranks = 0.9487
  near(spearman([[1, 1], [1, 2], [3, 3], [4, 4]]), 0.948683);
  // a one-sided constant has no rank variance: null, not NaN
  assert.equal(spearman([[1, 1], [1, 2], [1, 3]]), null);
});

test("spearman: n < 2 is null", () => {
  assert.equal(spearman([]), null);
  assert.equal(spearman([[1, 1]]), null);
});

// --- coverage over classified only ---------------------------------------------------

test("coverage counts classified drivers only and says how many were not", () => {
  const rows = [
    drv("a", 1, 1, 3, 1), // held
    drv("b", 2, 1, 4, 5), // missed
    drv("c", 3, 2, 6, 6), // held (inclusive upper edge)
    drv("d", 4, 3, 8, null), // retired: not scored
  ];
  const c = coverage(rows);
  assert.deepEqual(c, { share: 2 / 3, held: 2, classified: 3, notClassified: 1 });
  assert.deepEqual(coverage([drv("a", 1, 1, 3, null)]), { share: null, held: 0, classified: 0, notClassified: 1 });
});

test("rankAgreement pairs expected position with the classified finish", () => {
  const rows = [drv("a", 1.2, 1, 3, 2), drv("b", 2.4, 1, 4, 1), drv("c", 3.1, 2, 6, 3), drv("d", 4, 3, 8, null)];
  near(rankAgreement(rows), 0.5);
});

// --- topThree ------------------------------------------------------------------------

test("topThree orders by expected position, ties by driver id; actual by classified 1-3", () => {
  const rows = [drv("ver", 2.0, 1, 3, 3), drv("nor", 1.5, 1, 3, null), drv("ant", 2.0, 1, 4, 1), drv("lec", 5, 3, 9, 2)];
  assert.deepEqual(topThree(rows).map((r) => r.driverId), ["nor", "ant", "ver"]);
  assert.deepEqual(topThree(rows, "actual").map((r) => r.driverId), ["ant", "lec", "ver"]);
  assert.deepEqual(topThree([drv("a", 1, 1, 2, 7)], "actual"), []);
});

// --- the strictly-before rule ----------------------------------------------------------

test("scoredSnapshot picks the greatest computed_at strictly before start_utc", () => {
  const start = "2026-09-26 11:00:00+00";
  const snaps = [
    { computedAt: "2026-09-18 18:06:22.154678+00" },
    { computedAt: "2026-09-26 07:20:00+00" },
    { computedAt: "2026-09-26 11:00:00+00" }, // at start exactly: never scored
    { computedAt: "2026-09-27 03:20:00+00" }, // after the race: kept, never scored
  ];
  assert.equal(scoredSnapshot(snaps, start)?.computedAt, "2026-09-26 07:20:00+00");
  assert.equal(scoredSnapshot(snaps.slice(2), start), null);
  assert.equal(scoredSnapshot(snaps, null), null);
  assert.equal(scoredSnapshot([], start), null);
});

test("parseClassified: digits only", () => {
  assert.equal(parseClassified("12"), 12);
  assert.equal(parseClassified("R"), null);
  assert.equal(parseClassified("D"), null);
  assert.equal(parseClassified(null), null);
});
