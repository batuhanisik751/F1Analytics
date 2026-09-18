"use client";
// MODE1_SPEC §7.3 — title probability per driver after every round, with the §2.4.1
// bootstrap band. Plain structural props; the only echarts import is the frozen wrapper.
//
// THE BAND TRAP (§7.3): the band is two stacked series per driver — a transparent base at
// pLo and a shaded second series carrying pHi MINUS pLo. Stacking pHi itself would draw a
// ribbon up to pLo + pHi and overstate the interval on the one chart whose job is honesty.
import { useMemo } from "react";
import EChart, { type EChartsOption } from "@/components/charts/EChart";
import { TEAM_FALLBACK } from "@/lib/theme";

export type TitleOddsLineSeries = {
  driverId: string;
  code: string;
  colour: string;
  /** all three indexed by `rounds` */
  p: number[];
  pLo: number[];
  pHi: number[];
};

export type TitleOddsLinesProps = {
  rounds: number[];
  series: TitleOddsLineSeries[];
  /** the drivers beyond the chart cap, summed, drawn as one grey line */
  othersCombined: number[] | null;
  /** colour for the "everyone else" line; defaults to the repo's neutral team fallback */
  othersColour?: string;
  height?: number;
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function TitleOddsLines({
  rounds,
  series,
  othersCombined,
  othersColour = TEAM_FALLBACK,
  height = 420,
}: TitleOddsLinesProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const out: NonNullable<EChartsOption["series"]> = [];
    for (const s of series) {
      out.push({
        type: "line",
        name: `${s.code} band lo`,
        stack: `band-${s.driverId}`,
        data: s.pLo,
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
      });
      out.push({
        type: "line",
        name: `${s.code} band hi`,
        stack: `band-${s.driverId}`,
        // pHi − pLo: the WIDTH of the interval, never pHi itself.
        data: s.pHi.map((h, i) => Math.max(0, h - (s.pLo[i] ?? 0))),
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { color: s.colour, opacity: 0.12 },
        silent: true,
        tooltip: { show: false },
      });
    }
    for (const s of series) {
      out.push({
        type: "line",
        name: s.code,
        data: s.p,
        lineStyle: { width: 2, color: s.colour },
        itemStyle: { color: s.colour },
        symbol: "none",
        z: 5,
      });
    }
    if (othersCombined) {
      out.push({
        type: "line",
        name: "Everyone else",
        data: othersCombined,
        lineStyle: { width: 1.5, color: othersColour, type: "dashed" },
        itemStyle: { color: othersColour },
        symbol: "none",
        z: 4,
      });
    }
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 32, bottom: 44 },
      legend: {
        top: 0,
        data: [...series.map((s) => s.code), ...(othersCombined ? ["Everyone else"] : [])],
      },
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (typeof v === "number" ? pct(v) : String(v)),
      },
      xAxis: {
        type: "category",
        name: "After round",
        nameLocation: "middle",
        nameGap: 26,
        data: rounds.map((r) => `R${r}`),
      },
      yAxis: {
        type: "value",
        name: "Title probability",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        max: 1,
        axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
      },
      series: out,
    };
  }, [rounds, series, othersCombined, othersColour]);

  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Title probability after each round for ${series.length} drivers, with a bootstrap uncertainty band`}
    />
  );
}
