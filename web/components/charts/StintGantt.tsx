"use client";
// SPEC §4.3 item 4 — tyre strategy gantt: ECharts `custom` series, one row per driver in
// finishing order (winner on top), one bar per stint coloured by compound. Retired drivers
// keep their rows; a driver's first stored stint need not start at lap 1.
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart, { clipRectByRect } from "@/components/charts/EChart";
import { compoundColour, type ColourMap } from "@/lib/colours";
import { PALETTE } from "@/lib/theme";

// Structural copies of the query row types (charts never import lib/queries).
export type GanttDriver = { code: string; fullName: string; teamColour: string };
export type GanttStint = {
  code: string;
  stint: number;
  compound: string;
  compoundColour: string;
  startLap: number;
  endLap: number;
  laps: number;
};

export type StintGanttProps = {
  order: GanttDriver[];
  stints: GanttStint[];
  totalLaps: number;
  colours?: ColourMap;
};

const COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[-\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

type Rect = { x: number; y: number; width: number; height: number };

export default function StintGantt({
  order,
  stints,
  totalLaps,
  colours,
}: StintGanttProps): React.JSX.Element {
  const height = 26 * order.length + 80;

  const option = useMemo<EChartsOption>(() => {
    const codes = order.map((d) => d.code);
    const rowIndex = new Map(codes.map((c, i) => [c, i]));

    // One custom series per compound so the legend is native (toggle a compound on/off).
    const compounds = Array.from(new Set(stints.map((s) => s.compound))).sort((a, b) => {
      const ia = COMPOUND_ORDER.indexOf(a);
      const ib = COMPOUND_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    const colourFor = (s: GanttStint) => s.compoundColour || compoundColour(colours, s.compound);
    const seriesRows: GanttStint[][] = compounds.map((c) =>
      stints.filter((s) => s.compound === c && rowIndex.has(s.code)),
    );

    const renderItem = (
      params: CustomSeriesRenderItemParams,
      api: CustomSeriesRenderItemAPI,
    ): CustomSeriesRenderItemReturn => {
      const row = seriesRows[params.seriesIndex ?? 0]?.[params.dataIndex];
      if (!row) return null;
      const y = api.value(0) as number;
      const start = api.value(1) as number;
      const end = api.value(2) as number;
      const p0 = api.coord([start, y]);
      const p1 = api.coord([end, y]);
      const band = api.size?.([0, 1]);
      const bandH = Array.isArray(band) ? band[1] : typeof band === "number" ? band : 20;
      const h = bandH * 0.62;
      const raw: Rect = { x: p0[0], y: p0[1] - h / 2, width: p1[0] - p0[0], height: h };
      const rect = clipRectByRect(raw, params.coordSys as unknown as Rect);
      if (!rect) return null;
      const fill = colourFor(row);
      const children: NonNullable<CustomSeriesRenderItemReturn>[] = [
        {
          type: "rect",
          shape: rect,
          style: { fill, stroke: PALETTE.bg, lineWidth: 1 },
        },
      ];
      // UX_SPEC §4.3 — compound is encoded in the bar's colour, so the bar also carries the
      // compound's initial (S/M/H/I/W). A reader who cannot separate the reds still reads the
      // strategy off the chart, and the label already had room for one more character.
      if (row.laps >= 6 && rect.width >= 16) {
        children.push({
          type: "text",
          silent: true,
          style: {
            text: `${row.compound.charAt(0).toUpperCase()} ${row.laps}`,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            align: "center",
            verticalAlign: "middle",
            fill: PALETTE.bg,
            fontWeight: "bold",
            fontSize: 10,
          },
        });
      }
      return { type: "group", children };
    };

    return {
      animation: false,
      grid: { left: 56, right: 16, top: 36, bottom: 40 },
      legend: {
        top: 0,
        // The legend names the compound and its initial, which is what the bars are marked with.
        data: compounds.map((c) => ({
          name: `${titleCase(c)} (${c.charAt(0).toUpperCase()})`,
          itemStyle: { color: colourFor({ compound: c, compoundColour: "" } as GanttStint) },
        })),
      },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const params = Array.isArray(p) ? p[0] : p;
          const row = seriesRows[params.seriesIndex ?? 0]?.[params.dataIndex];
          if (!row) return "";
          return `${row.code} · ${row.compound} · laps ${row.startLap}–${row.endLap} (${row.laps})`;
        },
      },
      xAxis: {
        type: "value",
        name: "Lap",
        nameLocation: "middle",
        nameGap: 24,
        min: 0,
        max: totalLaps,
        minInterval: 1,
        splitLine: { show: true },
      },
      yAxis: {
        type: "category",
        data: codes,
        inverse: true,
        axisTick: { show: false },
        axisLabel: { fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11 },
        splitLine: { show: false },
      },
      series: compounds.map((c, i) => ({
        name: `${titleCase(c)} (${c.charAt(0).toUpperCase()})`,
        type: "custom",
        renderItem,
        encode: { x: [1, 2], y: 0 },
        itemStyle: { color: colourFor({ compound: c, compoundColour: "" } as GanttStint) },
        data: seriesRows[i].map((s) => [
          rowIndex.get(s.code) as number,
          s.startLap - 1,
          s.endLap,
          s.laps,
          s.compound,
          colourFor(s),
        ]),
      })),
    };
  }, [order, stints, totalLaps, colours]);

  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Tyre strategy gantt: ${order.length} drivers in finishing order, one bar per stint, coloured by tyre compound and marked with the compound's initial and the number of laps run on it`}
    />
  );
}
