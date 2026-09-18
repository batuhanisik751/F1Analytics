"use client";
// MODE1_SPEC §7.3 / FD3 — the reliability curve, rendered directly beneath the river and
// never behind a click. One small chart per evaluation scope, side by side: a dashed
// identity diagonal, one dot per predicted-probability bin at (meanPredicted,
// observedRate) sized by log(nRows), and a Wilson interval drawn as an error bar.
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { PALETTE } from "@/lib/theme";

export type ReliabilityChartBin = {
  binLo: number;
  binHi: number;
  nRows: number;
  meanPredicted: number;
  observedRate: number;
  observedLo: number;
  observedHi: number;
};
export type ReliabilityChartScope = {
  scope: string;
  label: string;
  brier: number;
  bins: ReliabilityChartBin[];
};
export type ReliabilityChartProps = {
  scopes: ReliabilityChartScope[];
  height?: number;
};

/** Dot area tracks evidence, not row count: n spans 635 to 54,524 in this data. */
export function dotSize(nRows: number): number {
  const n = Math.max(1, nRows);
  return Math.min(26, Math.max(6, 4 + 2.2 * Math.log(n)));
}

function panelOption(s: ReliabilityChartScope): EChartsOption {
  const dots = s.bins.map((b) => [b.meanPredicted, b.observedRate, b.nRows]);
  const bars = s.bins.map((b) => [b.meanPredicted, b.observedLo, b.observedHi]);
  return {
    animation: false,
    title: {
      text: s.label,
      left: "center",
      top: 0,
      textStyle: { fontSize: 12, fontWeight: "normal", color: PALETTE.muted },
    },
    grid: { left: 52, right: 16, top: 30, bottom: 40 },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const v = params.value as number[];
        const bin = s.bins[params.dataIndex ?? 0];
        if (!bin) return "";
        return [
          `predicted ${(bin.binLo * 100).toFixed(1)}–${(bin.binHi * 100).toFixed(1)}%`,
          `mean predicted ${(v[0] * 100).toFixed(1)}%`,
          `actually won ${(bin.observedRate * 100).toFixed(1)}% (${(bin.observedLo * 100).toFixed(1)}–${(bin.observedHi * 100).toFixed(1)}%)`,
          `${bin.nRows.toLocaleString("en-GB")} laps`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      name: "Predicted",
      nameLocation: "middle",
      nameGap: 24,
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
    },
    yAxis: {
      type: "value",
      name: "Observed",
      nameLocation: "middle",
      nameGap: 38,
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
    },
    series: [
      {
        name: "Perfect calibration",
        type: "line",
        silent: true,
        symbol: "none",
        data: [
          [0, 0],
          [1, 1],
        ],
        lineStyle: { type: "dashed", color: PALETTE.muted, width: 1 },
      },
      {
        name: "Wilson 95%",
        type: "custom",
        silent: true,
        encode: { x: 0, y: [1, 2] },
        data: bars,
        renderItem: (params, api) => {
          const x = api.value(0) as number;
          const lo = api.coord([x, api.value(1) as number]);
          const hi = api.coord([x, api.value(2) as number]);
          const style = { stroke: PALETTE.accent, lineWidth: 1, opacity: 0.8 };
          const cap = 4;
          return {
            type: "group",
            children: [
              { type: "line", shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style },
              {
                type: "line",
                shape: { x1: lo[0] - cap, y1: lo[1], x2: lo[0] + cap, y2: lo[1] },
                style,
              },
              {
                type: "line",
                shape: { x1: hi[0] - cap, y1: hi[1], x2: hi[0] + cap, y2: hi[1] },
                style,
              },
            ],
          };
        },
      },
      {
        name: "Bins",
        type: "scatter",
        data: dots,
        symbolSize: (v: number[]) => dotSize(v[2]),
        itemStyle: { color: PALETTE.accent, opacity: 0.9 },
      },
    ],
  };
}

export default function ReliabilityChart({
  scopes,
  height = 280,
}: ReliabilityChartProps): React.JSX.Element {
  const options = useMemo(() => scopes.map((s) => panelOption(s)), [scopes]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {scopes.map((s, i) => (
        <div key={s.scope} className="rounded-lg border border-grid bg-surface p-2">
          <EChart
            option={options[i]}
            height={height}
            ariaLabel={`Reliability curve, ${s.label}: predicted against observed win rate over ${s.bins.length} bins`}
          />
        </div>
      ))}
    </div>
  );
}
