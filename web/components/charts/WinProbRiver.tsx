"use client";
// MODE1_SPEC §7.3 — win probability "river": one stacked band per driver, stack order is
// the final finishing order (winner first). Plain structural props only; this file never
// imports lib/queries or echarts directly.
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { PALETTE } from "@/lib/theme";

export type WinProbRiverSeries = {
  code: string;
  colour: string;
  /** p[i] aligns with laps[i]; null before the first and after the last lap driven. */
  p: (number | null)[];
};
/** Structural subset of `WinProbSwing` — enough to draw the tick, nothing more. */
export type WinProbRiverSwing = { lapNumber: number; cause: string };

export type WinProbRiverProps = {
  laps: number[];
  series: WinProbRiverSeries[];
  degradedLaps: number[];
  swings: WinProbRiverSwing[];
  height?: number;
};

/** Contiguous runs, so N degraded laps draw N/ish bands rather than N slivers. */
export function lapRuns(laps: number[]): [number, number][] {
  const sorted = [...new Set(laps)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const l of sorted) {
    const last = runs[runs.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else runs.push([l, l]);
  }
  return runs;
}

export default function WinProbRiver({
  laps,
  series,
  degradedLaps,
  swings,
  height = 420,
}: WinProbRiverProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    // A category axis labels every band by default; on a 70-lap race that is unreadable.
    const labelInterval = Math.max(0, Math.ceil(laps.length / 12) - 1);
    const lapIndex = new Map(laps.map((l, i) => [l, i]));
    const driverSeries: NonNullable<EChartsOption["series"]> = series.map((s) => ({
      name: s.code,
      type: "line",
      stack: "p",
      areaStyle: { opacity: 0.85, color: s.colour },
      lineStyle: { width: 0 },
      symbol: "none",
      showSymbol: false,
      itemStyle: { color: s.colour },
      emphasis: { focus: "series" },
      animation: false,
      // Plain value arrays against the category axis above — §7.3's `data: s.p`. Do NOT
      // go back to `[lap, p]` tuples on a `type: 'value'` axis: ECharts does not stack
      // tuple data there, so every series paints independently and the last one in the
      // stack covers the chart. Measured on 2024 R13: Gasly's Alpine pink filled laps
      // 20-70 full height and hid all twenty drivers, while the tooltip read correctly.
      //
      // A retired driver's `p` is null; 0 is the honest substitute (a retired car's
      // chance of winning is zero) and it keeps every lap summing to exactly 1.0, which
      // is what the §7.5 caption promises. A null would instead leave a hole in the
      // stack. The band still "disappears" at retirement — with zero height.
      data: laps.map((_l, i) => s.p[i] ?? 0),
    }));

    // Marks live on their own data-less, unstacked series so they never enter the stack.
    const markSeries: NonNullable<EChartsOption["series"]> = [
      {
        name: "Flagged laps",
        type: "line",
        data: [],
        silent: true,
        tooltip: { show: false },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: PALETTE.fg, opacity: 0.55, type: "dashed" },
          label: { show: false },
          // On a category axis a markLine's `xAxis` is the category INDEX, not the lap.
          data: swings
            .filter((w) => lapIndex.has(w.lapNumber))
            .map((w) => ({ xAxis: lapIndex.get(w.lapNumber) as number })),
        },
        markArea: {
          silent: true,
          itemStyle: { color: PALETTE.grid, opacity: 0.45 },
          label: { show: false },
          data: lapRuns(degradedLaps)
            .filter(([a, b]) => lapIndex.has(a) && lapIndex.has(b))
            .map(([a, b]) => [
              { xAxis: (lapIndex.get(a) as number) - 0.5 },
              { xAxis: (lapIndex.get(b) as number) + 0.5 },
            ]),
        },
      },
    ];

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 44, bottom: 56 },
      legend: { type: "scroll", top: 0, data: series.map((s) => s.code) },
      tooltip: {
        trigger: "axis",
        confine: true,
        valueFormatter: (v) =>
          typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—",
      },
      xAxis: {
        type: "category",
        name: "Lap",
        nameLocation: "middle",
        nameGap: 24,
        boundaryGap: false,
        data: laps.map((l) => String(l)),
        axisLabel: { interval: labelInterval },
      },
      yAxis: {
        type: "value",
        name: "P(win)",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        max: 1,
        axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
      },
      series: [...driverSeries, ...markSeries],
    };
  }, [laps, series, degradedLaps, swings]);

  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Win probability per lap for ${series.length} drivers over ${laps.length} laps`}
    />
  );
}
