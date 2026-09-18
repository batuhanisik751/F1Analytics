// MODE3_SPEC §3.4 — the chart adapter and the degrade-to-table rule, with no browser.
import test from "node:test";
import assert from "node:assert/strict";

import { safeRender, uniqueHeaders, numericColumns, formatValue } from "@/components/ask/format";
import { toEChartOption } from "@/components/ask/toEChartOption";
import type { AskRenderDecision } from "@/components/ask/types";

function dec(over: Partial<AskRenderDecision>): AskRenderDecision {
  return {
    kind: "table",
    labelCol: null,
    valueCols: [],
    seriesCol: null,
    unit: "none",
    sort: "as_written",
    downgradedFrom: null,
    ...over,
  };
}

const FIELDS = ["driver_id", "avg_s"];
const ROWS: unknown[][] = Array.from({ length: 12 }, (_, i) => [`DRV${i}`, 90 + i * 0.1]);

test("bar with a label column that is not in the fields degrades to a table", () => {
  const d = dec({ kind: "bar", labelCol: "code", valueCols: ["avg_s"] });
  const safe = safeRender(d, FIELDS, ROWS);
  assert.equal(safe.kind, "table");
  assert.equal(safe.downgradedFrom, "bar");
});

test("bar with a non-numeric value column degrades to a table", () => {
  const d = dec({ kind: "bar", labelCol: "driver_id", valueCols: ["driver_id"] });
  assert.equal(safeRender(d, FIELDS, ROWS).kind, "table");
});

test("three rows or fewer never chart", () => {
  const d = dec({ kind: "bar", labelCol: "driver_id", valueCols: ["avg_s"] });
  assert.equal(safeRender(d, FIELDS, ROWS.slice(0, 3)).kind, "table");
});

test("a valid bar survives and sorts ascending with the fastest at the top", () => {
  const d = dec({ kind: "bar", labelCol: "driver_id", valueCols: ["avg_s"], sort: "value_asc" });
  const safe = safeRender(d, FIELDS, ROWS);
  assert.equal(safe.kind, "bar");
  const opt = toEChartOption(FIELDS, ROWS, safe) as Record<string, Record<string, unknown[]>>;
  const series = opt.series as unknown as { type: string }[];
  assert.equal(series[0].type, "bar");
  // yAxis categories run bottom-up in ECharts, so the first row is the LAST category.
  const cats = opt.yAxis.data as unknown[];
  assert.equal(cats[cats.length - 1], "DRV0");
});

test("single figure needs exactly one row and one numeric value column", () => {
  const d = dec({ kind: "single", labelCol: "driver_id", valueCols: ["avg_s"] });
  assert.equal(safeRender(d, FIELDS, [["VER", 91.2]]).kind, "single");
  assert.equal(safeRender(d, FIELDS, ROWS).kind, "table");
});

test("scatter needs two numeric columns and ten rows", () => {
  const f = ["lap_number", "lap_time_s"];
  const rows: unknown[][] = Array.from({ length: 11 }, (_, i) => [i + 1, 90 + i]);
  const d = dec({ kind: "scatter", labelCol: "lap_number", valueCols: ["lap_time_s"] });
  assert.equal(safeRender(d, f, rows).kind, "scatter");
  assert.equal(safeRender(d, f, rows.slice(0, 9)).kind, "table");
});

test("duplicate column names are labelled positionally", () => {
  assert.deepEqual(uniqueHeaders(["code", "code", "a"]), ["code", "code (2)", "a"]);
});

test("a column with any non-numeric cell is not numeric", () => {
  assert.deepEqual(numericColumns(["a", "b"], [[1, "x"], [2, "3"]]), [true, false]);
});

test("units suffix the value, never the header", () => {
  assert.equal(formatValue(91.234, "s"), "91.234 s");
  assert.equal(formatValue("12", "count"), "12");
});
