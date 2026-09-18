"use client";
// SPEC §4.3 item 3 — fuel-corrected race pace: one box per driver in rank order, filled with
// the team colour; the 'dashed' teammate gets a dashed border. The five numbers come from
// pace_ranking (matplotlib boxplot_stats, whis=1.5) — nothing is recomputed here.
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart from "@/components/charts/EChart";
import { teamColour, type ColourMap, type LineStyle } from "@/lib/colours";
import { fmtLapTime } from "@/lib/format";
import { PALETTE } from "@/lib/theme";

export type PaceBoxRow = {
  code: string;
  fullName: string;
  teamId: string;
  teamName: string;
  teamColour: string;
  lineStyle: LineStyle;
  rank: number;
  cleanLaps: number;
  medianPaceS: number;
  bestPaceS: number;
  iqrS: number;
  gapS: number;
  /** whiskerLo, q1, median, q3, whiskerHi */
  box: [number, number, number, number, number];
  sensRankLo: number | null;
  sensRankHi: number | null;
};

export type PaceBoxPlotProps = { rows: PaceBoxRow[]; colours?: ColourMap };

export default function PaceBoxPlot({ rows, colours }: PaceBoxPlotProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const codes = rows.map((r) => r.code);
    const colourOf = (r: PaceBoxRow) => r.teamColour || teamColour(colours, r.teamId);

    // ECharts' boxplot draws the median with the border colour; the notebook draws it in the
    // background colour so it reads against the team fill. Overlay it with a custom series
    // using the same width rule as boxplotLayout (bandWidth * 0.8 - 2, clamped to [7, 50]).
    const medianItem = (
      params: CustomSeriesRenderItemParams,
      api: CustomSeriesRenderItemAPI,
    ): CustomSeriesRenderItemReturn => {
      const i = api.value(0) as number;
      const median = api.value(1) as number;
      const c = api.coord([i, median]);
      const band = api.size?.([1, 0]);
      const bandW = Array.isArray(band) ? band[0] : typeof band === "number" ? band : 30;
      const w = Math.min(Math.max(bandW * 0.8 - 2, 7), 50);
      return {
        type: "line",
        silent: true,
        z2: 10,
        shape: { x1: c[0] - w / 2, y1: c[1], x2: c[0] + w / 2, y2: c[1] },
        style: { stroke: PALETTE.bg, lineWidth: 1.6 },
      };
    };

    return {
      animation: false,
      grid: { left: 64, right: 16, top: 24, bottom: 56 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const params = Array.isArray(p) ? p[0] : p;
          const r = rows[params.dataIndex];
          if (!r) return "";
          const sens =
            r.sensRankLo !== null && r.sensRankHi !== null
              ? r.sensRankLo === r.sensRankHi
                ? `P${r.sensRankLo} (stable)`
                : `P${r.sensRankLo}–P${r.sensRankHi}`
              : "—";
          return [
            `<b>${r.code}</b> · ${r.teamName}`,
            `Median ${fmtLapTime(r.medianPaceS)}`,
            `Best ${fmtLapTime(r.bestPaceS)}`,
            `IQR ${r.iqrS.toFixed(3)}s`,
            `Clean laps ${r.cleanLaps}`,
            `Rank across fuel constants: ${sens}`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: codes,
        axisTick: { show: false },
        axisLabel: {
          interval: 0,
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          fontSize: 11,
          lineHeight: 15,
          formatter: (code: string, index: number) => {
            const r = rows[index];
            if (!r) return code;
            return r.rank === 1 ? `${code}\n—` : `${code}\n+${r.gapS.toFixed(2)}`;
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        name: "Fuel-corrected lap time (s)",
        nameLocation: "middle",
        nameGap: 48,
        scale: true,
        axisLabel: { formatter: (v: number) => v.toFixed(1) },
      },
      series: [
        {
          name: "Race pace",
          type: "boxplot",
          data: rows.map((r) => ({
            value: r.box,
            itemStyle: {
              color: colourOf(r),
              borderColor: PALETTE.grid,
              borderWidth: 1,
              borderType: r.lineStyle === "dashed" ? "dashed" : "solid",
            },
          })),
        },
        {
          name: "Median",
          type: "custom",
          renderItem: medianItem,
          encode: { x: 0, y: 1 },
          data: rows.map((r, i) => [i, r.medianPaceS]),
          tooltip: { show: false },
        },
      ],
    };
  }, [rows, colours]);

  return (
    <EChart
      option={option}
      height={420}
      ariaLabel={`Fuel-corrected race pace box plot: ${rows.length} drivers in rank order, boxes in team colours`}
    />
  );
}
