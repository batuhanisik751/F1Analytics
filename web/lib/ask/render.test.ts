// MODE3_SPEC §3.4 — one test per row of the decision table, plus the cases that motivated it.
// No key, no network, no database: the classifier is pure over an executed result.
import assert from "node:assert/strict";
import test from "node:test";
import type { RenderHint } from "@/lib/ask/anthropic";
import type { AskExecution } from "@/lib/ask/execute";
import { classifyAskRender } from "@/lib/ask/render";

function exec(fields: string[], rows: unknown[][]): AskExecution {
  return {
    fields,
    rows,
    truncated: false,
    plan: { maxPlanCost: 1, maxPlanRows: 1, maxWidth: 1, relations: [] },
    durationMs: 1,
  } as unknown as AskExecution;
}

function hint(p: Partial<RenderHint> & Pick<RenderHint, "kind">): RenderHint {
  return {
    label_col: null,
    value_cols: [],
    series_col: null,
    unit: "none",
    sort: "as_written",
    ...p,
  };
}

const drivers = (n: number): unknown[][] =>
  Array.from({ length: n }, (_, i) => [`DR${i}`, 90 + i * 0.1]);

test("row 1: zero rows is never a chart", () => {
  const d = classifyAskRender(exec(["driver_id", "pace_s"], []), hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }));
  assert.equal(d.kind, "table");
  assert.equal(d.downgradedFrom, "bar");
});

test("row 2: 1 row x 1 numeric column is a single figure even when the hint said table", () => {
  const d = classifyAskRender(exec(["driver_id", "wins"], [["VER", 9]]), hint({ kind: "table" }));
  assert.equal(d.kind, "single");
  assert.deepEqual(d.valueCols, ["wins"]);
  assert.equal(d.labelCol, "driver_id");
});

test("row 3: a hint naming a column that is not in the result degrades to a table", () => {
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], drivers(10)),
    hint({ kind: "bar", label_col: "driver_name", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "table");
  assert.equal(d.downgradedFrom, "bar");
});

test("row 3: a non-numeric value column degrades to a table", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`DR${i}`, "fast"]);
  const d = classifyAskRender(
    exec(["driver_id", "verdict"], rows),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["verdict"] }),
  );
  assert.equal(d.kind, "table");
});

test("an all-null numeric column is not chartable", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`DR${i}`, null]);
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], rows),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "table");
});

test("row 4: three rows or fewer is a table", () => {
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], drivers(3)),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "table");
});

test("row 5: bar with a categorical label and 4-40 rows is honoured", () => {
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], drivers(20)),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"], sort: "value_asc" }),
  );
  assert.equal(d.kind, "bar");
  assert.equal(d.downgradedFrom, null);
  assert.equal(d.sort, "value_asc");
});

test("row 5: bar over 40 rows degrades", () => {
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], drivers(41)),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "table");
});

test("row 5: a bar whose label column is numeric is not a category", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [i, 90 + i]);
  const d = classifyAskRender(
    exec(["pace_s", "other_s"], rows),
    hint({ kind: "bar", label_col: "pace_s", value_cols: ["other_s"] }),
  );
  assert.equal(d.kind, "table");
});

test("row 6: line over lap_number with >= 5 rows is honoured", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [i + 1, 90 + i * 0.05]);
  const d = classifyAskRender(
    exec(["lap_number", "lap_time_s"], rows),
    hint({ kind: "line", label_col: "lap_number", value_cols: ["lap_time_s"] }),
  );
  assert.equal(d.kind, "line");
});

test("row 6: line with fewer than 5 rows degrades", () => {
  const rows = Array.from({ length: 4 }, (_, i) => [i + 1, 90 + i]);
  const d = classifyAskRender(
    exec(["lap_number", "lap_time_s"], rows),
    hint({ kind: "line", label_col: "lap_number", value_cols: ["lap_time_s"] }),
  );
  assert.equal(d.kind, "table");
});

test("row 7: scatter needs EXACTLY two numeric columns in the RESULT, not in the hint", () => {
  const two = Array.from({ length: 12 }, (_, i) => [`DR${i}`, i, i * 2]);
  const three = Array.from({ length: 12 }, (_, i) => [`DR${i}`, i, i * 2, i * 3]);
  const h = hint({ kind: "scatter", label_col: "x", value_cols: ["y"] });
  assert.equal(classifyAskRender(exec(["driver_id", "x", "y"], two), h).kind, "scatter");
  // A third measurement in the result would be hidden behind a picture of the other two.
  assert.equal(classifyAskRender(exec(["driver_id", "x", "y", "z"], three), h).kind, "table");
});

test("row 8: over 200 rows is a table only", () => {
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], drivers(201)),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "table");
  assert.equal(d.downgradedFrom, "bar");
});

test("a numeric-string column (pg numeric over the wire) is still chartable", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`DR${i}`, String(90 + i)]);
  const d = classifyAskRender(
    exec(["driver_id", "pace_s"], rows),
    hint({ kind: "bar", label_col: "driver_id", value_cols: ["pace_s"] }),
  );
  assert.equal(d.kind, "bar");
});

test("no hint at all is a table with nothing discarded", () => {
  const d = classifyAskRender(exec(["driver_id", "pace_s"], drivers(10)), null);
  assert.equal(d.kind, "table");
  assert.equal(d.downgradedFrom, null);
});
