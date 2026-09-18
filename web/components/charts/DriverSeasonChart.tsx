"use client";
// SPEC §4.4 (3): ONE ECharts instance, two grids sharing the round axis (axisPointer.link).
// Top: pace rank per round (inverse y from 1), line + symbols in the team colour, hollow
// symbol where the rank moves across the fuel-sensitivity range, null where unranked.
// Bottom: signed teammate gap % bars — positive (this driver faster) in the team colour,
// negative in muted, zero markLine in fg, null where no comparable pair.
// Pure presentational: no db/ or lib/queries imports; echarts only via the wrapper.
import { useMemo } from "react";
import EChart, { type EChartsOption } from "@/components/charts/EChart";
import { fmtGap, fmtPct } from "@/lib/format";
import { PALETTE } from "@/lib/theme";

/** Structural copy of lib/queries/driver's DriverRaceRow fields the chart reads (plain JSON). */
export type DriverSeasonChartRace = {
  round: number;
  eventName: string;
  shortName: string;
  position: number | null;
  classifiedPosition: string;
  paceRank: number | null;
  gapToP1S: number | null;
  gapToP1Pct: number | null;
  sensRankLo: number | null;
  sensRankHi: number | null;
  teammate: { code: string } | null;
  signedGapPct: number | null;
  signedGapS: number | null;
};

export type DriverSeasonChartProps = {
  races: DriverSeasonChartRace[];
  teamColour: string;
  /** This driver's code, for the tooltip. */
  code?: string;
};

type TooltipParam = { dataIndex: number };

/**
 * Pixel layout of the two stacked grids. The chart is `height` tall; the top grid holds the pace
 * rank, the bottom grid the teammate gap, and `bottomMargin` reserves room under the bottom axis
 * for the rotated round labels (the longest, "Emilia Romagna" at 11 px, needs ~60 px at 45°).
 * The y-axis names sit vertically `yNameGap` px left of each axis line, inside `left`.
 */
export const CHART_LAYOUT = {
  height: 480,
  left: 80,
  yNameGap: 56,
  topGridTop: 28,
  topGridHeight: "38%",
  bottomGridTop: "58%",
  bottomMargin: 92,
} as const;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function DriverSeasonChart({
  races,
  teamColour,
  code,
}: DriverSeasonChartProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const categories = races.map((r) => r.shortName);
    const maxRank = Math.max(1, ...races.map((r) => r.paceRank ?? 0));

    const rankData = races.map((r) => {
      if (r.paceRank === null) return null;
      const moves =
        r.sensRankLo !== null && r.sensRankHi !== null && r.sensRankLo !== r.sensRankHi;
      return {
        value: r.paceRank,
        symbol: "circle",
        symbolSize: moves ? 11 : 9,
        itemStyle: moves
          ? { color: PALETTE.bg, borderColor: teamColour, borderWidth: 2 }
          : { color: teamColour, borderColor: teamColour, borderWidth: 2 },
      };
    });

    const gapData = races.map((r) => {
      if (r.signedGapPct === null) return null;
      return {
        value: r.signedGapPct,
        itemStyle: { color: r.signedGapPct >= 0 ? teamColour : PALETTE.muted },
      };
    });

    const tooltipFormatter = (params: TooltipParam | TooltipParam[]): string => {
      const first = Array.isArray(params) ? params[0] : params;
      const r = first ? races[first.dataIndex] : undefined;
      if (!r) return "";
      const finish =
        r.position !== null ? `P${r.position}` : r.classifiedPosition || "—";
      const lines: string[] = [
        `<b>${esc(r.eventName)}</b> · Rd ${r.round}`,
        `Finish: ${esc(finish)}`,
      ];
      if (r.paceRank === null) {
        lines.push("Pace rank: not ranked (fewer than 8 clean laps)");
      } else {
        const range =
          r.sensRankLo !== null && r.sensRankHi !== null && r.sensRankLo !== r.sensRankHi
            ? ` (${r.sensRankLo}–${r.sensRankHi} across fuel range)`
            : "";
        lines.push(`Pace rank: ${r.paceRank}${range}`);
        lines.push(
          `Gap to P1: ${r.paceRank === 1 ? "—" : `${fmtGap(r.gapToP1S)} / ${fmtPct(r.gapToP1Pct)}`}`,
        );
      }
      if (r.teammate && r.signedGapPct !== null) {
        lines.push(
          `vs ${esc(r.teammate.code)}: ${fmtGap(r.signedGapS)} / ${fmtPct(r.signedGapPct, { signed: true })}` +
            ` (${r.signedGapPct >= 0 ? `${esc(code ?? "driver")} faster` : `${esc(r.teammate.code)} faster`})`,
        );
      } else {
        lines.push("vs teammate: no comparable pair");
      }
      return lines.join("<br/>");
    };

    return {
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: tooltipFormatter,
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      // Layout (see CHART_LAYOUT): the y-axis names run vertically beside each grid, and the
      // bottom grid is anchored by `bottom` so the 45-degree round labels (up to "Emilia
      // Romagna") have room below the axis instead of being cut by the canvas edge.
      grid: [
        { left: CHART_LAYOUT.left, right: 24, top: CHART_LAYOUT.topGridTop, height: CHART_LAYOUT.topGridHeight },
        { left: CHART_LAYOUT.left, right: 24, top: CHART_LAYOUT.bottomGridTop, bottom: CHART_LAYOUT.bottomMargin },
      ],
      xAxis: [
        {
          type: "category",
          gridIndex: 0,
          data: categories,
          boundaryGap: true,
          axisLabel: { show: false },
          axisTick: { show: false },
        },
        {
          type: "category",
          gridIndex: 1,
          data: categories,
          boundaryGap: true,
          axisLabel: { interval: 0, rotate: races.length > 12 ? 45 : 0, fontSize: 11 },
        },
      ],
      yAxis: [
        {
          type: "value",
          gridIndex: 0,
          name: "Pace rank",
          nameLocation: "middle",
          nameGap: CHART_LAYOUT.yNameGap,
          inverse: true,
          min: 1,
          max: Math.max(maxRank, 2),
          minInterval: 1,
          axisLabel: { formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") },
        },
        {
          type: "value",
          gridIndex: 1,
          name: "Gap vs teammate (%)",
          nameLocation: "middle",
          nameGap: CHART_LAYOUT.yNameGap,
          axisLabel: { formatter: (v: number) => `${v > 0 ? "+" : ""}${v}` },
        },
      ],
      series: [
        {
          name: "Pace rank",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: rankData,
          connectNulls: false,
          lineStyle: { color: teamColour, width: 1.8 },
          itemStyle: { color: teamColour },
          emphasis: { scale: 1.3 },
        },
        {
          name: "Gap vs teammate",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: gapData,
          barMaxWidth: 28,
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: PALETTE.fg, width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    };
  }, [races, teamColour, code]);

  return (
    <EChart
      option={option}
      height={CHART_LAYOUT.height}
      ariaLabel={`Pace rank per round and signed pace gap to teammate${code ? ` for ${code}` : ""}`}
    />
  );
}
