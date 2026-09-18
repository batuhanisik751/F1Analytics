// MODE3_SPEC §1.4, §3.4, §8.7 — presentation helpers for generated results.
//
// Every one of these returns a STRING that a React text node renders. Nothing here builds markup,
// so a cell containing `<script>alert(1)</script>` or `Ignore previous instructions` reaches the
// DOM as literal text by construction, not by escaping.
import type { AskRenderDecision, AskUnit } from "./types";

const UNIT_SUFFIX: Record<AskUnit, string> = {
  s: " s",
  s_per_lap: " s/lap",
  pct: "%",
  count: "",
  position: "",
  points: " pts",
  none: "",
};

/** §1.4: the wrap keeps duplicate output names, so the UI labels them positionally. */
export function uniqueHeaders(fields: string[]): string[] {
  const seen = new Map<string, number>();
  return fields.map((f) => {
    const n = (seen.get(f) ?? 0) + 1;
    seen.set(f, n);
    return n === 1 ? f : `${f} (${n})`;
  });
}

export function isNumericCell(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
  return false;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A column is numeric only when every non-null cell in it is (§3.4's pg-type test, client-side). */
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

/** Cells are shown, never interpreted: objects are JSON, everything else is String(). */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString("en-GB");
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : 4;
  return n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatValue(v: unknown, unit: AskUnit): string {
  const n = toNumber(v);
  if (n === null) return formatCell(v);
  return `${formatNumber(n)}${UNIT_SUFFIX[unit]}`;
}

export function unitSuffix(unit: AskUnit): string {
  return UNIT_SUFFIX[unit];
}

/**
 * §3.4's last line — "anything else: table" — applied again in the browser. `render.ts` decides
 * server-side from the executed rows; this re-checks the decision against the fields that actually
 * arrived, so a hint naming a column that is not there degrades to a table instead of throwing.
 */
export function safeRender(
  decision: AskRenderDecision,
  fields: string[],
  rows: unknown[][],
): AskRenderDecision {
  const table = (): AskRenderDecision => ({
    ...decision,
    kind: "table",
    downgradedFrom: decision.downgradedFrom ?? (decision.kind === "table" ? null : decision.kind),
  });
  if (decision.kind === "table") return decision;
  if (rows.length === 0) return table();

  const numeric = numericColumns(fields, rows);
  const numericByName = new Map(fields.map((f, i) => [f, numeric[i] === true]));
  const has = (c: string | null): boolean => c !== null && fields.includes(c);
  const valuesOk =
    decision.valueCols.length > 0 && decision.valueCols.every((c) => has(c) && numericByName.get(c));

  if (decision.kind === "single") {
    return rows.length === 1 && valuesOk && decision.valueCols.length === 1 ? decision : table();
  }
  if (!has(decision.labelCol) || !valuesOk) return table();
  if (decision.seriesCol !== null && !has(decision.seriesCol)) return table();
  if (rows.length <= 3 || rows.length > 200) return table();
  if (decision.kind === "bar") return rows.length >= 4 && rows.length <= 40 ? decision : table();
  if (decision.kind === "line") return rows.length >= 5 ? decision : table();
  if (decision.kind === "scatter") {
    const numericCount = numeric.filter(Boolean).length;
    return rows.length >= 10 && numericCount === 2 ? decision : table();
  }
  return table();
}
