"use client";
// MODE3_SPEC §3.4 — the ask box's chart. Composes `EChart.tsx`; never imports `echarts` itself.
//
// "A chart alone is a claim; a chart over its own rows is evidence" — so this component never
// renders a chart on its own: `AskResult` always pairs it with the rows in a <details>.
import EChart, { type EChartsOption } from "@/components/charts/EChart";
import { toEChartOption } from "@/components/ask/toEChartOption";
import type { AskRenderDecision } from "@/components/ask/types";

export type AskChartProps = {
  fields: string[];
  rows: unknown[][];
  render: AskRenderDecision;
  /** Used as the chart's accessible name; the model's headline, rendered as a plain string. */
  ariaLabel: string;
  height?: number;
};

export default function AskChart({
  fields,
  rows,
  render,
  ariaLabel,
  height,
}: AskChartProps): React.JSX.Element | null {
  const option = toEChartOption(fields, rows, render);
  if (option === null) return null;
  const tall = render.kind === "bar" ? Math.min(560, 120 + rows.length * 22) : 380;
  return (
    <EChart
      option={option as EChartsOption}
      height={height ?? tall}
      ariaLabel={ariaLabel}
      className="rounded-lg border border-accent/40 bg-surface/40 p-2"
    />
  );
}
