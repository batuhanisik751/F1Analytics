"use client";
// SPEC §4.3 item 5 — fuel-corrected lap time against tyre age, one scatter series per
// compound plus the pooled fitted line stored in compound_degradation (two end points).
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { compoundColour, type ColourMap } from "@/lib/colours";
import { fmtLapTime } from "@/lib/format";

export type DegScatterPoint = { code: string; compound: string; tyreLife: number; lapTimeFcS: number };
export type DegScatterFit = {
  compound: string;
  compoundColour: string;
  laps: number;
  slopeSPerLap: number;
  interceptS: number;
  xMin: number;
  xMax: number;
};

export type DegradationScatterProps = {
  points: DegScatterPoint[];
  fits: DegScatterFit[];
  colours?: ColourMap;
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[-\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function signed3(v: number): string {
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(3)}`;
}

export default function DegradationScatter({
  points,
  fits,
  colours,
}: DegradationScatterProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const byCompound = new Map<string, DegScatterPoint[]>();
    for (const p of points) {
      const arr = byCompound.get(p.compound);
      if (arr) arr.push(p);
      else byCompound.set(p.compound, [p]);
    }
    // Scatter and line for a compound share a name, so the legend has one entry per compound.
    const legendName = (f: DegScatterFit) =>
      `${titleCase(f.compound)}  ${signed3(f.slopeSPerLap)} s per lap of tyre age`;
    const colourOf = (f: DegScatterFit) => f.compoundColour || compoundColour(colours, f.compound);
    // UX_SPEC §4.3 — compound is carried by MARKER SHAPE as well as by colour, and the same
    // shape is drawn in the legend, so the chart reads the same without hue. Dashes do the
    // same job for the fitted lines.
    const SHAPES = ["circle", "triangle", "rect", "diamond", "pin"] as const;
    const DASHES: (number | number[])[] = [0, [7, 4], [2, 3], [10, 3, 2, 3], [4, 4]];
    const shapeOf = (i: number): string => SHAPES[i % SHAPES.length];
    const dashOf = (i: number): number | number[] => DASHES[i % DASHES.length];

    const series: NonNullable<EChartsOption["series"]> = [];
    for (const [i, f] of fits.entries()) {
      const name = legendName(f);
      const colour = colourOf(f);
      const pts = byCompound.get(f.compound) ?? [];
      series.push({
        name,
        type: "scatter",
        symbol: shapeOf(i),
        symbolSize: 5,
        itemStyle: { color: colour, opacity: 0.32 },
        emphasis: { itemStyle: { opacity: 1 } },
        data: pts.map((p) => ({ value: [p.tyreLife, p.lapTimeFcS], code: p.code })),
        tooltip: {
          formatter: (p) => {
            const params = Array.isArray(p) ? p[0] : p;
            const d = params.data as { value: [number, number]; code: string };
            return `<b>${d.code}</b> · ${titleCase(f.compound)}<br/>Tyre age ${d.value[0]} laps<br/>${fmtLapTime(d.value[1])}`;
          },
        },
      });
      series.push({
        name,
        type: "line",
        showSymbol: false,
        silent: true,
        lineStyle: { width: 2.2, color: colour, type: dashOf(i) },
        itemStyle: { color: colour },
        data: [
          [f.xMin, f.interceptS + f.slopeSPerLap * f.xMin],
          [f.xMax, f.interceptS + f.slopeSPerLap * f.xMax],
        ],
        tooltip: { show: false },
      });
    }

    return {
      animation: false,
      grid: { left: 64, right: 16, top: 40, bottom: 44 },
      legend: {
        top: 0,
        data: fits.map((f, i) => ({ name: legendName(f), icon: shapeOf(i) })),
        itemStyle: { opacity: 1 },
      },
      tooltip: { trigger: "item" },
      xAxis: {
        type: "value",
        name: "Tyre age (laps)",
        nameLocation: "middle",
        nameGap: 26,
        min: 0,
        minInterval: 1,
      },
      yAxis: {
        type: "value",
        // §3.3 — the term stays (the glossary defines it) but the axis says what it means.
        name: "Fuel-corrected lap time, s (fuel weight removed)",
        nameLocation: "middle",
        nameGap: 48,
        scale: true,
        axisLabel: { formatter: (v: number) => v.toFixed(1) },
      },
      series,
    };
  }, [points, fits, colours]);

  return (
    <EChart
      option={option}
      height={420}
      ariaLabel={`Tyre degradation scatter: lap time with the fuel effect removed against tyre age, for ${fits.length} compounds, each with its own marker shape, line dash and fitted trend line`}
    />
  );
}
