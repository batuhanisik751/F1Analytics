"use client";
// SPEC §4.3 item 7 — teammate head-to-head: one horizontal bar per team, gap in % of lap
// time, largest gap on top (as plots.plot_teammate_deltas), labelled "NOR by 0.06s".
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { teamColour, type ColourMap } from "@/lib/colours";
import { PALETTE } from "@/lib/theme";

export type TeammateBarRow = {
  team: { teamId: string; teamName: string; teamColour: string };
  faster: { code: string; fullName: string };
  slower: { code: string; fullName: string };
  gapS: number;
  gapPct: number;
  lapsCompared: number;
};

export type TeammateBarsProps = { rows: TeammateBarRow[]; colours?: ColourMap };

export default function TeammateBars({ rows, colours }: TeammateBarsProps): React.JSX.Element {
  const height = 30 * rows.length + 80;

  const option = useMemo<EChartsOption>(() => {
    // Largest gap first + inverse y axis => largest gap on top.
    const sorted = [...rows].sort((a, b) => b.gapPct - a.gapPct);
    const largest = sorted.reduce((m, r) => (r.gapPct > m ? r.gapPct : m), 0);
    const colourOf = (r: TeammateBarRow) =>
      r.team.teamColour || teamColour(colours, r.team.teamId);

    return {
      animation: false,
      grid: { left: 130, right: 110, top: 16, bottom: 44 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const params = Array.isArray(p) ? p[0] : p;
          const r = sorted[params.dataIndex];
          if (!r) return "";
          return [
            `<b>${r.team.teamName}</b>`,
            `${r.faster.code} faster than ${r.slower.code}`,
            `Gap ${r.gapS.toFixed(3)}s · ${r.gapPct.toFixed(3)}%`,
            `Laps compared ${r.lapsCompared}`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "value",
        name: "Teammate pace gap (% of lap time)",
        nameLocation: "middle",
        nameGap: 26,
        min: 0,
        max: largest > 0 ? +(largest * 1.45).toPrecision(3) : undefined,
        axisLabel: { formatter: (v: number) => `${v}%` },
      },
      yAxis: {
        type: "category",
        data: sorted.map((r) => r.team.teamName),
        inverse: true,
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          name: "Teammate gap",
          type: "bar",
          barCategoryGap: "40%",
          data: sorted.map((r) => ({
            value: r.gapPct,
            itemStyle: { color: colourOf(r), opacity: 0.9 },
          })),
          label: {
            show: true,
            position: "right",
            color: PALETTE.fg,
            fontSize: 12,
            formatter: (params) => {
              const r = sorted[params.dataIndex];
              return r ? `${r.faster.code} by ${r.gapS.toFixed(2)}s` : "";
            },
          },
        },
      ],
    };
  }, [rows, colours]);

  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Teammate head-to-head bars: intra-team race pace gap in percent for ${rows.length} teams`}
    />
  );
}
