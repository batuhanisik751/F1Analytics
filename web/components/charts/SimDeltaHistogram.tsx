"use client";
// SIM_SPEC §6.7 — the 30-bin histogram of the finishing-time difference (edited − actual) with
// a "same time" line at zero and a marker at the median. `buildSimDeltaHistogramOption` is pure
// so it renders headless; structural props only.
import { useMemo } from "react";
import EChart, { type EChartsOption } from "@/components/charts/EChart";
import { PALETTE } from "@/lib/theme";

export type SimHistogramBin = { binStartS: number; binEndS: number; count: number };

export type SimDeltaHistogramProps = {
  histogram: SimHistogramBin[];
  deltaMedianS: number;
  deltaP10S: number;
  deltaP90S: number;
  n: number;
  teamColour: string;
  height?: number;
};

/** Index of the bin containing `x` (last bin closed on the right); -1 when outside every bin. */
export function binIndexOf(bins: SimHistogramBin[], x: number): number {
  for (let i = 0; i < bins.length; i++) {
    const last = i === bins.length - 1;
    if (x >= bins[i].binStartS && (x < bins[i].binEndS || (last && x <= bins[i].binEndS))) return i;
  }
  return -1;
}

/** Fractional category position of `x` (bin index + share of the bin), clamped to the axis. */
function catPos(bins: SimHistogramBin[], x: number): number {
  if (bins.length === 0) return 0;
  const i = binIndexOf(bins, x);
  if (i < 0) return x < bins[0].binStartS ? -0.5 : bins.length - 0.5;
  const w = bins[i].binEndS - bins[i].binStartS;
  return i - 0.5 + (w > 0 ? (x - bins[i].binStartS) / w : 0.5);
}

export function buildSimDeltaHistogramOption(p: Omit<SimDeltaHistogramProps, "height">): EChartsOption {
  const bins = p.histogram;
  const cats = bins.map((b) => b.binStartS.toFixed(1));
  const mark = (x: number, text: string, colour: string, position: "start" | "end" | "insideEndTop") => ({
    xAxis: catPos(bins, x),
    label: { show: true, formatter: text, position, color: colour, fontSize: 10 },
    lineStyle: { color: colour },
  });
  return {
    animation: false,
    grid: { left: 48, right: 24, top: 24, bottom: 44 },
    legend: { show: false },
    tooltip: {
      trigger: "axis", confine: true,
      formatter: (params) => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex: number };
        const b = bins[first.dataIndex];
        return b ? `${b.binStartS.toFixed(1)} … ${b.binEndS.toFixed(1)} s · ${b.count} of ${p.n} races` : "";
      },
    },
    xAxis: {
      type: "category", data: cats, name: "edited − actual (s), left of zero = edited faster",
      nameLocation: "middle", nameGap: 28, axisLabel: { interval: 4 }, axisTick: { alignWithLabel: true },
    },
    yAxis: { type: "value", name: "races", nameLocation: "end", nameGap: 8, minInterval: 1 },
    series: [
      {
        name: "delta", type: "bar", data: bins.map((b) => b.count), barCategoryGap: "10%",
        itemStyle: { color: p.teamColour, opacity: 0.85 },
        markLine: {
          silent: true, symbol: "none", lineStyle: { type: "dashed", width: 1 },
          data: [
            mark(0, "same time", PALETTE.fg, "end"),
            mark(p.deltaMedianS, `median ${p.deltaMedianS.toFixed(1)} s`, p.teamColour, "insideEndTop"),
            mark(p.deltaP10S, "p10", PALETTE.muted, "start"),
            mark(p.deltaP90S, "p90", PALETTE.muted, "start"),
          ],
        },
      },
    ],
  };
}

export default function SimDeltaHistogram(props: SimDeltaHistogramProps): React.JSX.Element {
  const { histogram, deltaMedianS, deltaP10S, deltaP90S, n, teamColour, height = 180 } = props;
  const option = useMemo(
    () => buildSimDeltaHistogramOption({ histogram, deltaMedianS, deltaP10S, deltaP90S, n, teamColour }),
    [histogram, deltaMedianS, deltaP10S, deltaP90S, n, teamColour],
  );
  const ariaLabel = `Distribution of the finishing-time difference over ${n} simulated races`;
  return <EChart option={option} ariaLabel={ariaLabel} height={height} />;
}
