"use client";
// MODE1_SPEC §3.3.3 / §7.3 — the overtaking difficulty index on its FIXED 0–100 axis.
// Every circuit with an index is a small tick; this circuit's tick is enlarged and
// labelled, the two extremes of the measured set are named beside their ticks, and both
// ends of the axis carry the anchor meaning in words. The anchors are absolute, so the
// tick positions do not move between recomputes.
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { PALETTE } from "@/lib/theme";

// Structural copy of the query row type (charts never import lib/queries).
export type OdiStripTick = { circuitKey: number; shortName: string; odi: number };

export type OdiStripProps = {
  ticks: OdiStripTick[];
  highlightCircuitKey: number | null;
  className?: string;
};

export const ODI_EASY_ANCHOR = "0 = about 5 passes per 100 chances";
export const ODI_HARD_ANCHOR = "100 = about half a pass per 100";

export default function OdiStrip({
  ticks,
  highlightCircuitKey,
  className,
}: OdiStripProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const highlighted = ticks.filter((t) => t.circuitKey === highlightCircuitKey);
    const rest = ticks.filter((t) => t.circuitKey !== highlightCircuitKey);
    // Name the extremes of the measured set — data-driven, never hard-coded values.
    const sorted = [...rest].sort((a, b) => a.odi - b.odi);
    const extremes = new Set<number>();
    if (sorted.length > 0) extremes.add(sorted[0].circuitKey);
    if (sorted.length > 1) extremes.add(sorted[sorted.length - 1].circuitKey);

    return {
      animation: false,
      grid: { left: 16, right: 16, top: 56, bottom: 44 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const params = Array.isArray(p) ? p[0] : p;
          const v = params.value as [number, number, string];
          return `${v[2]} · ODI ${v[0].toFixed(1)}`;
        },
      },
      xAxis: {
        type: "value",
        name: "harder to pass →",
        nameLocation: "middle",
        nameGap: 26,
        min: 0,
        max: 100,
        interval: 25,
        splitLine: { show: true },
      },
      yAxis: { type: "value", min: 0, max: 1, show: false },
      series: [
        {
          name: "Circuits",
          type: "scatter",
          symbol: "rect",
          symbolSize: [3, 22],
          itemStyle: { color: PALETTE.muted, opacity: 0.85 },
          data: rest.map((t) => ({
            value: [t.odi, 0.5, t.shortName],
            label: {
              show: extremes.has(t.circuitKey),
              formatter: `${t.shortName} ${t.odi.toFixed(0)}`,
              position: "bottom",
              color: PALETTE.muted,
              fontSize: 10,
            },
          })),
        },
        {
          name: "This circuit",
          type: "scatter",
          symbol: "rect",
          symbolSize: [5, 40],
          itemStyle: { color: PALETTE.accent },
          label: {
            show: true,
            position: "top",
            distance: 8,
            color: PALETTE.fg,
            fontSize: 12,
            fontWeight: "bold",
            formatter: (p) => {
              const v = p.value as [number, number, string];
              return `${v[2]} ${v[0].toFixed(0)}`;
            },
          },
          data: highlighted.map((t) => ({ value: [t.odi, 0.5, t.shortName] })),
        },
      ],
    };
  }, [ticks, highlightCircuitKey]);

  return (
    <div className={className}>
      <EChart
        option={option}
        height={170}
        ariaLabel={`Overtaking difficulty index on a fixed 0 to 100 scale: ${ticks.length} circuits, higher means harder to pass`}
      />
      <div className="mt-1 flex justify-between gap-4 text-[11px] text-muted">
        <span>{ODI_EASY_ANCHOR}</span>
        <span className="text-right">{ODI_HARD_ANCHOR}</span>
      </div>
    </div>
  );
}
