// MODE3_SPEC §3.4 — chart or table, and which chart.
//
// WP-10 NOTE ON OWNERSHIP: §9.3 assigns this file to WP-5, which did not deliver it; the
// pipeline therefore shipped with `alwaysTable` as its fallback and every chart in
// `components/ask/` was unreachable. This is the integration package supplying the missing
// wiring point, not a second owner rewriting someone's module.
//
// THE RULE THIS FILE EXISTS TO HOLD: a wrong chart is a wrong answer with a picture attached,
// so the model's hint is an INPUT and never a verdict, every mismatch degrades silently to a
// table, and the decision is made from the rows that ACTUALLY CAME BACK — never from what the
// model predicted they would look like. `components/ask/format.ts:safeRender` re-applies the
// same conditions in the browser; where the two disagree the table wins, because the table is
// the one answer §3.4 guarantees is never wrong.
//
// Numeric-ness is decided from the CELLS rather than from the declared pg type. `execute.ts`
// returns `rowMode: 'array'` rows and column names only, so no type oid reaches here — and a
// column of numeric strings (pg `numeric` arrives as a string over the wire) is genuinely
// chartable, while a declared-numeric column that came back all-null is not. The cells are the
// stronger test.
import type { RenderHint } from "@/lib/ask/anthropic";
import type { AskExecution } from "@/lib/ask/execute";
import type { AskRenderDecision, RenderClassifier } from "@/lib/ask/pipeline";

/** §3.4's last row: "> 200 rows → table only". The UI prints "showing first 200 of N". */
export const CHART_ROW_CEILING = 200;
export const BAR_MIN_ROWS = 4;
export const BAR_MAX_ROWS = 40;
export const LINE_MIN_ROWS = 5;
export const SCATTER_MIN_ROWS = 10;
export const MIN_CHART_ROWS = 4; // "≤ 3 rows → table"

/**
 * A categorical label for a bar chart. §3.4 says "driver / team / circuit"; these are the
 * column names the `ask` views actually use for those three, plus the compound and event
 * labels that behave identically. Matched on the column NAME, because a bar chart of an
 * arbitrary text column is how a fan gets a picture of something that is not a category.
 */
const CATEGORICAL_LABELS = new Set([
  "driver_id",
  "driver",
  "driver_code",
  "latest_code",
  "full_name",
  "last_name",
  "team",
  "team_name",
  "constructor",
  "circuit",
  "circuit_key",
  "circuit_name",
  "event_name",
  "compound",
]);

/** §3.4's line rule: "x is `lap_number`, `round`, `year` or a date". */
const ORDINAL_X = new Set(["lap_number", "lap", "round", "year", "season", "stint_number"]);

function isDateLike(values: unknown[]): boolean {
  const seen = values.filter((v) => v !== null && v !== undefined);
  if (seen.length === 0) return false;
  return seen.every(
    (v) => v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)),
  );
}

function isNumericCell(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  if (typeof v === "string") return v.trim() !== "" && Number.isFinite(Number(v));
  return false;
}

/**
 * A column is numeric when every non-null cell is numeric AND at least one cell is non-null.
 * An all-null column is NOT numeric: charting it draws an empty axis and implies a measurement
 * that was never taken.
 */
export function numericColumns(fields: string[], rows: unknown[][]): boolean[] {
  return fields.map((_f, i) => {
    let any = false;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      if (!isNumericCell(v)) return false;
      any = true;
    }
    return any;
  });
}

/** The table answer, carrying forward WHY the hint was discarded so §3.4's log line is real. */
function toTable(hint: RenderHint | null, why: RenderHint["kind"] | null): AskRenderDecision {
  return {
    kind: "table",
    labelCol: null,
    valueCols: [],
    seriesCol: null,
    unit: hint?.unit ?? "none",
    sort: hint?.sort ?? "as_written",
    downgradedFrom: why,
  };
}

/**
 * §3.4's table, applied IN ORDER against the executed result. Every `return toTable(...)` below
 * is one row of it. The order matters: 0 rows and the single-figure case are decided before the
 * hint is consulted at all, because both are properties of the data rather than of the request.
 */
export const classifyAskRender: RenderClassifier = (
  execution: AskExecution,
  hint: RenderHint | null,
): AskRenderDecision => {
  const { fields, rows } = execution;
  const discarded = hint && hint.kind !== "table" ? hint.kind : null;

  // Row 1 — 0 rows. Never a chart, never a sentence about the world (§8.5's empty state).
  if (rows.length === 0) return toTable(hint, discarded);

  const numeric = numericColumns(fields, rows);
  const numericIdx = numeric.flatMap((n, i) => (n ? [i] : []));
  const isNumericName = (c: string): boolean => {
    const i = fields.indexOf(c);
    return i >= 0 && numeric[i] === true;
  };
  const present = (c: string | null): c is string => c !== null && fields.includes(c);

  // Row 2 — 1 row x 1 numeric column is a single figure whatever the hint said. A one-cell
  // answer rendered as a table is technically correct and reads as an evasion.
  if (rows.length === 1 && numericIdx.length === 1 && fields.length <= 2) {
    const valueCol = fields[numericIdx[0]];
    const labelCol = fields.find((f) => f !== valueCol) ?? null;
    return {
      kind: "single",
      labelCol,
      valueCols: [valueCol],
      seriesCol: null,
      unit: hint?.unit ?? "none",
      sort: hint?.sort ?? "as_written",
      downgradedFrom: hint && hint.kind !== "single" ? hint.kind : null,
    };
  }

  // No hint, or the model asked for a table: nothing left to decide.
  if (hint === null || hint.kind === "table") return toTable(hint, null);
  if (hint.kind === "single") return toTable(hint, "single"); // handled above; anything else is wrong

  // Row 3 — a hint naming a column that is not in the result, or a non-numeric value column.
  // This is the hallucinated-column case and it is the most common way a hint is wrong.
  if (!present(hint.label_col)) return toTable(hint, hint.kind);
  if (hint.value_cols.length === 0) return toTable(hint, hint.kind);
  if (!hint.value_cols.every((c) => present(c) && isNumericName(c))) return toTable(hint, hint.kind);
  if (hint.series_col !== null && !present(hint.series_col)) return toTable(hint, hint.kind);

  // Row 4 — too few rows to be a shape, or nothing numeric to plot.
  if (rows.length < MIN_CHART_ROWS || numericIdx.length === 0) return toTable(hint, hint.kind);

  // Row 8 — over the ceiling the rows are the answer and the chart is noise.
  if (rows.length > CHART_ROW_CEILING) return toTable(hint, hint.kind);

  const decided: AskRenderDecision = {
    kind: hint.kind,
    labelCol: hint.label_col,
    valueCols: hint.value_cols,
    seriesCol: hint.series_col,
    unit: hint.unit,
    sort: hint.sort,
    downgradedFrom: null,
  };

  // Rows 5-7 — the per-kind conditions. Each is the shape that kind of picture claims to be
  // showing; failing it means the picture would assert something the rows do not.
  if (hint.kind === "bar") {
    const categorical =
      CATEGORICAL_LABELS.has(hint.label_col) || !isNumericName(hint.label_col);
    const okCols = hint.value_cols.length >= 1 && hint.value_cols.length <= 2;
    const okRows = rows.length >= BAR_MIN_ROWS && rows.length <= BAR_MAX_ROWS;
    return categorical && okCols && okRows ? decided : toTable(hint, hint.kind);
  }

  if (hint.kind === "line") {
    const xi = fields.indexOf(hint.label_col);
    const column = rows.map((r) => r[xi]);
    const okX =
      ORDINAL_X.has(hint.label_col) || isNumericName(hint.label_col) || isDateLike(column);
    return okX && rows.length >= LINE_MIN_ROWS ? decided : toTable(hint, hint.kind);
  }

  if (hint.kind === "scatter") {
    // "exactly 2 numeric columns" is a property of the RESULT, not of the hint: a scatter over
    // a result carrying a third measurement hides it behind a picture of the other two.
    return numericIdx.length === 2 && rows.length >= SCATTER_MIN_ROWS
      ? decided
      : toTable(hint, hint.kind);
  }

  // Row 9 — anything else.
  return toTable(hint, hint.kind);
};

export default classifyAskRender;
