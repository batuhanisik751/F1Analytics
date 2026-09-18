"use client";
// MODE1_SPEC §3.5 / §7.3 — predicted finishing order for a scheduled round.
// The INTERVAL is the bar (pos_p10 … pos_p90) and the point estimate is a tick inside
// it, never the other way round (FD4). Y axis inverted so P1 is at the top.
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart, { clipRectByRect } from "@/components/charts/EChart";
import { PALETTE } from "@/lib/theme";

// Structural copy of the query row type (charts never import lib/queries).
export type PreviewOrderBarRow = {
  code: string;
  teamColour: string;
  expectedPosition: number;
  posP10: number;
  posP90: number;
  pWin: number;
  pPodium: number;
  pPoints: number;
};

export type PreviewOrderBarsProps = {
  rows: PreviewOrderBarRow[];
  className?: string;
};

type Rect = { x: number; y: number; width: number; height: number };

function pct(v: number): string {
  return `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
}

export default function PreviewOrderBars({
  rows,
  className,
}: PreviewOrderBarsProps): React.JSX.Element {
  const height = 24 * rows.length + 88;

  const option = useMemo<EChartsOption>(() => {
    const codes = rows.map((r) => r.code);
    const maxPos = rows.reduce((m, r) => Math.max(m, r.posP90, r.expectedPosition), 1);

    const renderItem = (
      params: CustomSeriesRenderItemParams,
      api: CustomSeriesRenderItemAPI,
    ): CustomSeriesRenderItemReturn => {
      const row = rows[params.dataIndex];
      if (!row) return null;
      const y = api.value(0) as number;
      const lo = api.coord([api.value(1) as number, y]);
      const hi = api.coord([api.value(2) as number, y]);
      const mid = api.coord([api.value(3) as number, y]);
      const band = api.size?.([0, 1]);
      const bandH = Array.isArray(band) ? band[1] : typeof band === "number" ? band : 20;
      const h = Math.max(6, bandH * 0.6);
      const clip = params.coordSys as unknown as Rect;
      const barRect = clipRectByRect(
        { x: lo[0], y: lo[1] - h / 2, width: Math.max(1, hi[0] - lo[0]), height: h },
        clip,
      );
      if (!barRect) return null;
      const children: NonNullable<CustomSeriesRenderItemReturn>[] = [
        {
          type: "rect",
          shape: barRect,
          style: { fill: row.teamColour, opacity: 0.32 },
        },
      ];
      const tickRect = clipRectByRect(
        { x: mid[0] - 1.5, y: lo[1] - h / 2, width: 3, height: h },
        clip,
      );
      if (tickRect) {
        children.push({ type: "rect", shape: tickRect, style: { fill: row.teamColour } });
      }
      return { type: "group", children };
    };

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 34, bottom: 44 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const params = Array.isArray(p) ? p[0] : p;
          const row = rows[params.dataIndex];
          if (!row) return "";
          return [
            `${row.code} · expected P${row.expectedPosition.toFixed(1)}`,
            `80% range: P${row.posP10}–P${row.posP90}`,
            `win ${pct(row.pWin)} · podium ${pct(row.pPodium)} · points ${pct(row.pPoints)}`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "value",
        name: "Finishing position",
        nameLocation: "middle",
        nameGap: 26,
        min: 1,
        max: maxPos,
        minInterval: 1,
        splitLine: { show: true },
      },
      yAxis: {
        type: "category",
        data: codes,
        inverse: true,
        axisTick: { show: false },
        axisLabel: {
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          fontSize: 11,
          color: PALETTE.fg,
        },
        splitLine: { show: false },
      },
      series: [
        {
          name: "Predicted finish",
          type: "custom",
          renderItem,
          encode: { x: [1, 2, 3], y: 0 },
          data: rows.map((r, i) => [i, r.posP10, r.posP90, r.expectedPosition]),
        },
      ],
    };
  }, [rows]);

  return (
    <EChart
      option={option}
      height={height}
      className={className}
      ariaLabel={`Predicted finishing order: ${rows.length} drivers, each bar the 80% range of finishing positions with the expected position as a tick inside it`}
    />
  );
}
