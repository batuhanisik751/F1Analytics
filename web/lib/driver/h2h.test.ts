// H2H_SPEC §7 — unit tests for the pure half of the head-to-head section. No database:
// `tallyLedger`, `modelCall`, `ledgerCall` and `orientContrast` are reducers over rows the
// query layer returns; the ledger SQL is pinned by its text, not executed. The DB-backed
// half is verified by the probe recorded in the WP-QUERY report.
import test from "node:test";
import assert from "node:assert/strict";

import { ledgerCall, modelCall, tallyLedger, type Ledger, type LedgerRow } from "@/lib/driver/h2h";
import { orientContrast, type ContrastRow } from "@/lib/queries/mode2";
import { ledgerQuery } from "@/lib/queries/h2h";

// (round | qA,qB | finA,finB | paceA,paceB | ptsA,ptsB)
type Tuple = [number, number | null, number | null, string, string, number | null, number | null, number, number];
const row = ([round, qA, qB, finA, finB, paceA, paceB, ptsA, ptsB]: Tuple): LedgerRow => ({
  round, qA, qB, finA, finB, paceA, paceB, ptsA, ptsB,
});

const FIXTURE: Tuple[] = [
  [1, 1, 2, "1", "2", 0.0, 0.3, 25, 18],
  [2, 3, 1, "2", "1", 0.5, 0.1, 18, 25],
  [3, null, 4, "5", "R", 0.2, null, 10, 0],
  [4, 2, 5, "W", "3", 0.4, 0.2, 0, 15],
  [5, 6, 7, "4", "6", 0.3, 0.3, 12, 8],
  [6, 8, 9, "D", "D", null, null, 0, 0],
];

test("tallyLedger: the §7 six-row fixture", () => {
  assert.deepEqual(tallyLedger(FIXTURE.map(row)), {
    shared: 6,
    quali: { counted: 5, aWins: 4 },
    finish: { counted: 3, aWins: 2, unclassifiedAny: 3 },
    pace: { counted: 3, aWins: 1 },
    points: { a: 65, b: 66 },
  } satisfies Ledger);
});

test("tallyLedger: empty season", () => {
  const empty = tallyLedger([]);
  assert.equal(empty.shared, 0);
  assert.deepEqual(ledgerCall(empty), { kind: "level" });
});

// Hand-built from the stored 2026 rows (qualifying position, classified position, gap_pct, points).
const NOR_VER: Tuple[] = [
  [1, 6, null, "5", "6", 0.644, 0.503, 10, 8],
  [2, 6, 8, "W", "R", null, 1.524, 0, 0],
  [3, 5, 11, "5", "8", 0.567, 1.225, 10, 4],
  [4, 4, 2, "2", "5", 0.011, 1.002, 18, 10],
  [5, 3, 6, "R", "3", 1.458, 0.759, 0, 15],
  [6, 8, 2, "R", "R", 2.217, null, 0, 0],
  [7, 4, 5, "3", "4", 0.597, 0.707, 15, 12],
  [8, 6, 5, "7", "2", 0.661, 0.067, 6, 18],
  [9, 6, 7, "4", "20", 0.533, 0.255, 12, 0],
  [10, 3, 2, "7", "3", 0.098, 0.283, 6, 15],
  [11, 1, 6, "1", "2", 0, 0.243, 25, 18],
  [12, 1, 7, "1", "R", 0.125, null, 25, 0],
  [13, 9, 6, "4", "3", 0.783, 0.495, 12, 15],
  [14, 1, 3, "3", "2", 0, 0.188, 15, 18],
];
const NOR_PIA: Tuple[] = [
  [1, 6, 5, "5", "W", 0.644, null, 10, 0],
  [2, 6, 5, "W", "W", null, null, 0, 0],
  [3, 5, 3, "5", "2", 0.567, 0.468, 10, 18],
  [4, 4, 7, "2", "3", 0.011, 0.658, 18, 15],
  [5, 3, 4, "R", "11", 1.458, 2.04, 0, 0],
  [6, 8, 7, "R", "4", 2.217, 2.107, 0, 12],
  [7, 4, 7, "3", "5", 0.597, 1.362, 15, 10],
  [8, 6, 7, "7", "4", 0.661, 0.417, 6, 12],
  [9, 6, 8, "4", "11", 0.533, 0.962, 12, 0],
  [10, 3, 7, "7", "5", 0.098, 0.69, 6, 10],
  [11, 1, 5, "1", "R", 0, 0.265, 25, 0],
  [12, 1, 4, "1", "6", 0.125, 0.192, 25, 8],
  [13, 9, 3, "4", "5", 0.783, 1.033, 12, 10],
  [14, 1, 7, "3", "8", 0, 1.221, 15, 4],
];

test("tallyLedger: Norris v Verstappen 2026 — 14 | 8/13 | 6/10, 4 | 6/11 | 154–133", () => {
  const l = tallyLedger(NOR_VER.map(row));
  assert.equal(l.shared, 14);
  assert.deepEqual(l.quali, { counted: 13, aWins: 8 });
  assert.deepEqual(l.finish, { counted: 10, aWins: 6, unclassifiedAny: 4 });
  assert.deepEqual(l.pace, { counted: 11, aWins: 6 });
  assert.deepEqual(l.points, { a: 154, b: 133 });
  assert.deepEqual(ledgerCall(l), { kind: "leader", leaderIsA: true });
});

test("tallyLedger: Norris v Piastri 2026 — 14 | 9/14 | 6/9, 5 | 9/12 | 154–99", () => {
  const l = tallyLedger(NOR_PIA.map(row));
  assert.equal(l.shared, 14);
  assert.deepEqual(l.quali, { counted: 14, aWins: 9 });
  assert.deepEqual(l.finish, { counted: 9, aWins: 6, unclassifiedAny: 5 });
  assert.deepEqual(l.pace, { counted: 12, aWins: 9 });
  assert.deepEqual(l.points, { a: 154, b: 99 });
});

test("ledgerCall: tie on pace is level, B majority names B", () => {
  const base = tallyLedger([]);
  assert.deepEqual(ledgerCall({ ...base, pace: { counted: 4, aWins: 2 } }), { kind: "level" });
  assert.deepEqual(ledgerCall({ ...base, pace: { counted: 5, aWins: 2 } }), { kind: "leader", leaderIsA: false });
});

const stored = {
  driverA: "max_verstappen",
  driverB: "norris",
  kind: "cross",
  deltaPp: -0.538,
  deltaSe: 0.22,
  deltaLo: -0.9,
  deltaHi: -0.176,
  sameComponent: false,
  sharedCells: [] as string[],
  nSharedRaces: 0,
};

test("orientContrast: the orientation pin (stored VER/NOR → A=norris)", () => {
  const o = orientContrast(stored, "norris");
  assert.equal(o.driverA, "norris");
  assert.equal(o.driverB, "max_verstappen");
  assert.equal(o.deltaPp, 0.538);
  assert.equal(o.deltaLo, 0.176);
  assert.equal(o.deltaHi, 0.9);
  assert.equal(o.deltaSe, stored.deltaSe);
  assert.deepEqual(orientContrast(stored, "max_verstappen"), { ...stored, kind: "cross" });
});

test("modelCall: three no-call reasons and the leader case", () => {
  assert.deepEqual(modelCall(null), { kind: "nocall", reason: "no-row" });
  const oriented = orientContrast(stored, "norris");
  assert.deepEqual(modelCall(oriented), { kind: "nocall", reason: "assumed" });
  const same: ContrastRow = { ...oriented, sameComponent: true };
  assert.deepEqual(modelCall({ ...same, deltaPp: 0.05, deltaLo: -0.1, deltaHi: 0.2 }), { kind: "nocall", reason: "zero" });
  assert.deepEqual(modelCall({ ...same, deltaPp: -0.173, deltaLo: -0.256, deltaHi: -0.09 }), { kind: "leader", leaderIsA: true });
  assert.deepEqual(modelCall({ ...same, deltaPp: 0.173, deltaLo: 0.09, deltaHi: 0.256 }), { kind: "leader", leaderIsA: false });
});

// Never-subtract: no field on `Ledger` or `ContrastRow` may carry a gap, difference or
// rating derived by arithmetic. Checked at the type level (a forbidden key makes the
// assignment below fail to compile) and at runtime over the produced keys.
type ForbiddenKey = `${string}${"gap" | "Gap" | "diff" | "Diff" | "signed" | "Signed" | "rating" | "Rating"}${string}`;
type Forbidden<T> = Extract<keyof T, ForbiddenKey>;
type Clean<T> = [Forbidden<T>] extends [never] ? true : false;
const ledgerClean: Clean<Ledger> & Clean<Ledger["quali"]> & Clean<Ledger["finish"]> & Clean<Ledger["pace"]> & Clean<Ledger["points"]> = true;
const contrastClean: Clean<ContrastRow> = true;

test("types: Ledger and ContrastRow carry no derived-gap field", () => {
  assert.equal(ledgerClean && contrastClean, true);
  const l = tallyLedger(FIXTURE.map(row));
  const keys = [...Object.keys(l), ...Object.values(l).flatMap((v) => (typeof v === "object" ? Object.keys(v) : []))];
  const bad = keys.filter((k) => /gap|diff|signed|rating/i.test(k));
  assert.deepEqual(bad, []);
  assert.deepEqual(Object.keys(orientContrast(stored, "norris")).filter((k) => /gap|diff|signed|rating/i.test(k)), []);
});

test("ledger SQL: joins the round's Q session only, never SQ, in the current pace set", () => {
  const { sql, params } = ledgerQuery(2026, "norris", "max_verstappen").toSQL();
  assert.ok(params.includes("Q"));
  assert.ok(!params.includes("SQ"));
  assert.equal(params.filter((p) => p === "R").length, 1);
  assert.match(sql, /left join .*"q"/i);
  assert.match(sql, /max\("pace_ranking"\."assumption_set_id"\)/i);
  assert.equal((sql.match(/left join/gi) ?? []).length, 5);
});
