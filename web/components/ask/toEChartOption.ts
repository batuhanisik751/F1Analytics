// MODE3_SPEC §3.4 — pure (rows, fields, render) -> EChartsOption adapter. Unit-tested without a
// browser; imports no echarts (§9 WP-7 keeps `components/charts/EChart.tsx` the only importer).
//
// OWNERSHIP NOTE: §8.1 places this file at `lib/ask/toEChartOption.ts`. WP-6's brief scopes this
// package to `components/ask/**`, so it lives here; it is pure and moves with one import change.
import { PALETTE } from "@/lib/theme";
import { formatNumber, toNumber, unitSuffix } from "./format";
import type { AskRenderDecision } from "./types";

export type AskEChartOption = Record<string, unknown>;

const SERIES_COLORS = [PALETTE.accent, "#4baa5e", "#3c7fd6", "#e8474b"];
const GRID = { left: 8, right: 24, top: 24, bottom: 8, containLabel: true } as const;

function colIndex(fields: string[], name: string | null): number {
  return name === null ? -1 : fields.indexOf(name);
}

function labelText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : String(v);
}

function sortRows(
  rows: unknown[][],
  valueIdx: number,
  sort: AskRenderDecision["sort"],
): unknown[][] {
  if (sort === "as_written" || valueIdx < 0) return rows;
  const dir = sort === "value_asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = toNumber(a[valueIdx]);
    const y = toNumber(b[valueIdx]);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });
}

function axisValue(unit: AskRenderDecision["unit"], name: string): AskEChartOption {
  return {
    type: "value",
    name,
    nameLocation: "middle",
    nameGap: 28,
    axisLabel: { formatter: (v: number) => `${formatNumber(v)}${unitSuffix(unit)}` },
  };
}

/**
 * Returns null when the decision cannot be drawn — the caller renders a table, which §3.4
 * guarantees is never wrong. Never throws: a chart is a nice-to-have over rows that already exist.
 */
export function toEChartOption(
  fields: string[],
  rows: unknown[][],
  render: AskRenderDecision,
): AskEChartOption | null {
  if (rows.length === 0 || render.kind === "table" || render.kind === "single") return null;
  const labelIdx = colIndex(fields, render.labelCol);
  const valueIdxs = render.valueCols.map((c) => colIndex(fields, c));
  if (labelIdx < 0 || valueIdxs.length === 0 || valueIdxs.some((i) => i < 0)) return null;

  const tooltip = { trigger: render.kind === "scatter" ? "item" : "axis" };
  const legend =
    valueIdxs.length > 1 ? { data: render.valueCols, top: 0, type: "scroll" as const } : undefined;

  if (render.kind === "bar") {
    const ordered = sortRows(rows, valueIdxs[0], render.sort);
    // Horizontal bars, first row at the top: yAxis categories run bottom-up in ECharts.
    const categories = ordered.map((r) => labelText(r[labelIdx])).reverse();
    return {
      grid: { ...GRID, left: 8 },
      tooltip,
      legend,
      xAxis: axisValue(render.unit, render.valueCols[0]),
      yAxis: { type: "category", data: categories },
      series: valueIdxs.map((vi, k) => ({
        name: render.valueCols[k],
        type: "bar",
        color: SERIES_COLORS[k % SERIES_COLORS.length],
        data: ordered.map((r) => toNumber(r[vi])).reverse(),
      })),
    };
  }

  if (render.kind === "line") {
    const ordered = [...rows].sort((a, b) => {
      const x = toNumber(a[labelIdx]);
      const y = toNumber(b[labelIdx]);
      return x === null || y === null ? 0 : x - y;
    });
    const categories = ordered.map((r) => labelText(r[labelIdx]));
    return {
      grid: GRID,
      tooltip,
      legend,
      xAxis: { type: "category", data: categories, name: render.labelCol ?? "", nameGap: 24 },
      yAxis: axisValue(render.unit, render.valueCols[0]),
      series: valueIdxs.map((vi, k) => ({
        name: render.valueCols[k],
        type: "line",
        showSymbol: ordered.length <= 40,
        color: SERIES_COLORS[k % SERIES_COLORS.length],
        data: ordered.map((r) => toNumber(r[vi])),
      })),
    };
  }

  // scatter
  const vi = valueIdxs[0];
  return {
    grid: GRID,
    tooltip,
    xAxis: axisValue("none", render.labelCol ?? ""),
    yAxis: axisValue(render.unit, render.valueCols[0]),
    series: [
      {
        type: "scatter",
        color: PALETTE.accent,
        symbolSize: 8,
        data: rows.map((r) => [toNumber(r[labelIdx]), toNumber(r[vi])]),
      },
    ],
  };
}
