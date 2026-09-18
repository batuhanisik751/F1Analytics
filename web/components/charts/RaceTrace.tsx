"use client";
// SPEC §4.3 item 6 — race trace: gap to the leader per lap, one line per driver in finish
// order, y inverted so the leader runs along the top at 0. Non-green lap runs are shaded
// and labelled from lap_status.worst_status.
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import EChart from "@/components/charts/EChart";
import { lineStyleFor, teamColour, type ColourMap, type LineStyle } from "@/lib/colours";
import { PALETTE } from "@/lib/theme";

export type TraceDriver = {
  code: string;
  fullName: string;
  teamId: string;
  teamName: string;
  teamColour: string;
  lineStyle: LineStyle;
  finishPosition: number | null;
  /** index = lapNumber - 1 */
  gaps: (number | null)[];
  positions: (number | null)[];
};
export type TraceLapStatus = { lapNumber: number; isGreen: boolean; worstStatus: string };
/**
 * MODE1_SPEC §7.3 — structural subset of `RaceMoment`. Declared here because nothing
 * under components/charts may import lib/queries; `RaceMoment[]` satisfies it.
 */
export type TraceMoment = {
  lapNumber: number;
  momentType: string;
  driver: { code: string };
  detail: string;
};

/** Marker shape per moment type; unknown types fall back to a circle. */
export const MOMENT_SYMBOL: Record<string, string> = {
  pace_collapse: "triangle",
  undercut_executed: "arrow",
  tyre_cliff: "diamond",
  damage_or_puncture: "pin",
  safety_car_luck: "rect",
};

export type RaceTraceProps = {
  totalLaps: number;
  series: TraceDriver[];
  lapStatus: TraceLapStatus[];
  colours?: ColourMap;
  /** §7.3 — additive, default []; markers on the relevant driver's line. */
  moments?: TraceMoment[];
};

// Severity order from SPEC §1.5: '5' > '4' > '6' > '7' > '2' > '1'.
const SEVERITY: Record<string, number> = { "5": 0, "4": 1, "6": 2, "7": 3, "2": 4, "1": 5 };
const STATUS_LABEL: Record<string, string> = {
  "5": "Red",
  "4": "SC",
  "6": "VSC",
  "7": "VSC",
  "2": "Yellow",
};

type Band = { start: number; end: number; worst: string };

/** Contiguous runs of non-green laps, each labelled with its most severe status. */
export function statusBands(lapStatus: TraceLapStatus[]): Band[] {
  const sorted = [...lapStatus].sort((a, b) => a.lapNumber - b.lapNumber);
  const bands: Band[] = [];
  let current: Band | null = null;
  for (const l of sorted) {
    if (l.isGreen) {
      current = null;
      continue;
    }
    if (current && l.lapNumber === current.end + 1) {
      current.end = l.lapNumber;
      if ((SEVERITY[l.worstStatus] ?? 99) < (SEVERITY[current.worst] ?? 99)) {
        current.worst = l.worstStatus;
      }
    } else {
      current = { start: l.lapNumber, end: l.lapNumber, worst: l.worstStatus };
      bands.push(current);
    }
  }
  return bands;
}

/**
 * Default visible y range. A car that sat in the pits through a red flag can carry a gap of
 * thousands of seconds, which would flatten every other line; the y slider starts at the
 * 98th percentile of all gaps (× 1.15) and the user can drag it out to see the spike.
 */
export function defaultYCap(series: TraceDriver[]): number {
  const gaps: number[] = [];
  for (const s of series) for (const g of s.gaps) if (g !== null && Number.isFinite(g)) gaps.push(g);
  if (gaps.length === 0) return 1;
  gaps.sort((a, b) => a - b);
  const max = gaps[gaps.length - 1];
  const p98 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.98))];
  const cap = Math.ceil(p98 * 1.15);
  return max > cap * 1.5 ? Math.max(cap, 1) : Math.max(Math.ceil(max), 1);
}

export default function RaceTrace({
  totalLaps,
  series,
  lapStatus,
  colours,
  moments = [],
}: RaceTraceProps): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const codes = series.map((s) => s.code);
    const bands = statusBands(lapStatus);
    const yCap = defaultYCap(series);

    const driverSeries: NonNullable<EChartsOption["series"]> = series.map((s) => {
      const colour = s.teamColour || teamColour(colours, s.teamId);
      const data: [number, number | null][] = [];
      for (let lap = 1; lap <= totalLaps; lap++) data.push([lap, s.gaps[lap - 1] ?? null]);
      return {
        name: s.code,
        type: "line",
        data,
        connectNulls: false,
        showSymbol: false,
        lineStyle: { ...lineStyleFor(s.lineStyle), color: colour },
        itemStyle: { color: colour },
        emphasis: { focus: "series" },
        animation: false,
      };
    });

    // §7.3 race moments: one scatter point per moment on that driver's own line, in the
    // driver's colour and shaped by moment type. The detail string is the item tooltip;
    // the readable list lives in RaceMomentsSection beside the chart.
    const byCode = new Map(series.map((s) => [s.code, s]));
    const momentPoints = moments
      .map((m) => {
        const s = byCode.get(m.driver.code);
        const gap = s ? (s.gaps[m.lapNumber - 1] ?? null) : null;
        if (!s || gap === null) return null;
        return {
          value: [m.lapNumber, gap] as [number, number],
          symbol: MOMENT_SYMBOL[m.momentType] ?? "circle",
          itemStyle: {
            color: s.teamColour || teamColour(colours, s.teamId),
            borderColor: PALETTE.fg,
            borderWidth: 1,
          },
          moment: m,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const momentSeries: NonNullable<EChartsOption["series"]> =
      momentPoints.length === 0
        ? []
        : [
            {
              name: "Moments",
              type: "scatter",
              symbolSize: 11,
              z: 5,
              data: momentPoints,
              tooltip: {
                trigger: "item",
                formatter: (p) => {
                  const params = Array.isArray(p) ? p[0] : p;
                  const d = params.data as (typeof momentPoints)[number];
                  const m = d?.moment;
                  if (!m) return "";
                  return `<b>Lap ${m.lapNumber}</b> &middot; ${m.driver.code}<br/>${m.detail}`;
                },
              },
            },
          ];

    // The flag bands live on a data-less series that is not in the legend, so hiding a
    // driver never hides the SC/VSC/red shading.
    const statusSeries: NonNullable<EChartsOption["series"]> = [
      {
        name: "Track status",
        type: "line",
        data: [],
        silent: true,
        tooltip: { show: false },
        markArea: {
          silent: true,
          itemStyle: { color: PALETTE.grid, opacity: 0.35 },
          label: {
            show: true,
            position: "insideTop",
            color: PALETTE.fg,
            fontSize: 11,
            fontWeight: 600,
          },
          data: bands.map((b) => [
            { name: STATUS_LABEL[b.worst] ?? `Status ${b.worst}`, xAxis: b.start - 0.5 },
            { xAxis: b.end + 0.5 },
          ]),
        },
      },
    ];

    return {
      animation: false,
      grid: { left: 60, right: 36, top: 48, bottom: 72 },
      legend: { type: "scroll", top: 0, data: codes, pageButtonPosition: "end" },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        // Keep the box inside the 520 px chart: a 22-car field is laid out in two columns of
        // 11 (~240 px tall) and ECharts clamps the position, so the "Lap N" header and P1..Pn
        // are never pushed above the container (they were, whenever the card sat near the top
        // of the viewport).
        confine: true,
        formatter: (p) => {
          const params = Array.isArray(p) ? p : [p];
          const lap = params.length ? (params[0].value as [number, number | null])[0] : null;
          const rows = params
            .map((item) => {
              const value = item.value as [number, number | null];
              const gap = value[1];
              const s = series[item.seriesIndex ?? -1];
              if (gap === null || gap === undefined || !s) return null;
              const pos = lap ? s.positions[lap - 1] : null;
              return { code: s.code, pos, gap, marker: String(item.marker ?? "") };
            })
            .filter((r): r is { code: string; pos: number | null; gap: number; marker: string } => r !== null)
            .sort((a, b) => a.gap - b.gap);
          const line = (r: (typeof rows)[number]) =>
            `<div style="white-space:nowrap;line-height:1.4">${r.marker}<span style="display:inline-block;width:2.2em">${r.pos !== null ? `P${r.pos}` : "—"}</span> <b>${r.code}</b> <span style="display:inline-block;min-width:5.6em;text-align:right;margin-left:8px;font-variant-numeric:tabular-nums">+${r.gap.toFixed(3)}s</span></div>`;
          const perColumn = rows.length > 12 ? Math.ceil(rows.length / 2) : rows.length;
          const columns: string[] = [];
          for (let i = 0; i < rows.length; i += perColumn) {
            columns.push(`<div>${rows.slice(i, i + perColumn).map(line).join("")}</div>`);
          }
          return `<div style="font-weight:600;margin-bottom:4px">Lap ${lap ?? "—"}</div><div style="display:flex;gap:16px">${columns.join("")}</div>`;
        },
      },
      xAxis: {
        type: "value",
        name: "Lap",
        nameLocation: "middle",
        nameGap: 24,
        min: 1,
        max: totalLaps,
        minInterval: 1,
      },
      yAxis: {
        type: "value",
        name: "Gap to leader (s)",
        nameLocation: "middle",
        nameGap: 44,
        inverse: true,
        min: 0,
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0, filterMode: "none", height: 18, bottom: 8 },
        {
          type: "slider",
          yAxisIndex: 0,
          filterMode: "none",
          width: 14,
          right: 6,
          startValue: 0,
          endValue: yCap,
          showDetail: false,
        },
      ],
      series: [...driverSeries, ...statusSeries, ...momentSeries],
    };
  }, [totalLaps, series, lapStatus, colours, moments]);

  return (
    <EChart
      option={option}
      height={520}
      ariaLabel={`Race trace: gap to the leader per lap for ${series.length} drivers over ${totalLaps} laps`}
    />
  );
}
