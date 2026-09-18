"use client";
// SIM_SPEC §6.6 — lap-by-lap median gap of the edited car to the actual car with the p10–p90
// band, stop markers for both strategies and (as-happened mode) the SC/VSC/red bands. The
// option is built by the pure `buildSimGapOption` so it can be rendered headless (SSR/SVG)
// and unit-tested; structural props only, nothing from lib/queries or the engine.
import { useMemo } from "react";
import EChart, { type EChartsOption } from "@/components/charts/EChart";
import { statusBands, type TraceLapStatus } from "@/components/charts/RaceTrace";
import { PALETTE } from "@/lib/theme";

export type SimLapStatusCode = "G" | "S" | "V" | "R";
export type SimStopMarker = { lap: number; status: SimLapStatusCode };
export type SimPerLap = { lap: number; medianS: number; p10S: number; p90S: number };

export type SimGapChartProps = {
  perLap: SimPerLap[];
  editedStops: SimStopMarker[];
  actualStops: SimStopMarker[];
  /** As-happened mode: the race's lap statuses; random mode passes null (bands omitted). */
  lapStatus: TraceLapStatus[] | null;
  teamColour: string;
  code: string;
  mode: "asHappened" | "random";
  ariaLabel: string;
  height?: number;
};

const STATUS_WORD: Record<SimLapStatusCode, string> = { G: "", S: "under SC", V: "under VSC", R: "under red flag" };
const STATUS_LABEL: Record<string, string> = { "5": "Red", "4": "SC", "6": "VSC", "7": "VSC", "2": "Yellow" };

/** `-19.8` → "19.8 s ahead"; `19.8` → "19.8 s behind"; `0` → "level". */
export function gapWord(deltaS: number): string {
  const abs = Math.abs(deltaS);
  if (abs < 0.05) return "level";
  return `${abs.toFixed(1)} s ${deltaS < 0 ? "ahead" : "behind"}`;
}

/** Tooltip line per lap (§6.6): `Lap 22 · edited car 19.8 s behind (p10 19.5, p90 20.1) · pit stop (edited, under SC)`. */
export function lapTooltip(row: SimPerLap, edited: SimStopMarker[], actual: SimStopMarker[]): string {
  const parts = [`Lap ${row.lap}`, `edited car ${gapWord(row.medianS)} (p10 ${row.p10S.toFixed(1)}, p90 ${row.p90S.toFixed(1)})`];
  const e = edited.find((s) => s.lap === row.lap);
  const a = actual.find((s) => s.lap === row.lap);
  const stop = (who: string, m: SimStopMarker): string =>
    `pit stop (${who}${STATUS_WORD[m.status] ? `, ${STATUS_WORD[m.status]}` : ""})`;
  if (e) parts.push(stop("edited", e));
  if (a) parts.push(stop("actual", a));
  return parts.join(" · ");
}

/** Lap-status codes → the `TraceLapStatus` shape `statusBands()` expects (SimSection helper). */
export function toTraceLapStatus(codes: SimLapStatusCode[], horizon: number): TraceLapStatus[] {
  const worst: Record<SimLapStatusCode, string> = { G: "1", S: "4", V: "6", R: "5" };
  return codes.slice(0, horizon).map((c, i) => ({ lapNumber: i + 1, isGreen: c === "G", worstStatus: worst[c] }));
}

/** Pure option builder (no React). y is inverted: ahead (negative delta) is up, as the race trace. */
export function buildSimGapOption(p: Omit<SimGapChartProps, "ariaLabel" | "height">): EChartsOption {
  const rows = [...p.perLap].sort((a, b) => a.lap - b.lap);
  const laps = rows.map((r) => String(r.lap));
  const byLap = new Map(rows.map((r) => [r.lap, r]));
  const stopSeries = (name: string, stops: SimStopMarker[], colour: string, label: string) => ({
    name,
    type: "scatter" as const,
    symbol: "triangle",
    symbolSize: 12,
    itemStyle: { color: colour },
    label: { show: true, position: "top" as const, formatter: label, color: colour, fontSize: 10 },
    tooltip: { show: false },
    data: stops.filter((s) => byLap.has(s.lap)).map((s) => [String(s.lap), byLap.get(s.lap)!.medianS]),
    z: 5,
  });
  const series: NonNullable<EChartsOption["series"]> = [
    { name: "bandLo", type: "line", stack: "b", data: rows.map((r) => r.p10S), lineStyle: { opacity: 0 }, symbol: "none", tooltip: { show: false }, silent: true },
    { name: "bandHi", type: "line", stack: "b", data: rows.map((r) => r.p90S - r.p10S), lineStyle: { opacity: 0 }, symbol: "none", areaStyle: { color: p.teamColour, opacity: 0.18 }, tooltip: { show: false }, silent: true },
    {
      name: "median", type: "line", data: rows.map((r) => r.medianS), symbol: "none",
      lineStyle: { width: 2, color: p.teamColour }, itemStyle: { color: p.teamColour },
      markLine: { silent: true, symbol: "none", lineStyle: { color: PALETTE.muted, type: "dashed" }, label: { show: false }, data: [{ yAxis: 0 }] },
    },
    stopSeries("Edited stops", p.editedStops, p.teamColour, "pit"),
    stopSeries("Actual stops", p.actualStops, PALETTE.muted, "pit (actual)"),
  ];
  if (p.mode === "asHappened" && p.lapStatus) {
    series.push({
      name: "Track status", type: "line", data: [], silent: true, tooltip: { show: false },
      markArea: {
        silent: true, itemStyle: { color: PALETTE.grid, opacity: 0.35 },
        label: { show: true, position: "insideTop", color: PALETTE.fg, fontSize: 11, fontWeight: 600 },
        data: statusBands(p.lapStatus).map((b) => [{ name: STATUS_LABEL[b.worst] ?? `Status ${b.worst}`, xAxis: b.start - 1.5 }, { xAxis: b.end - 0.5 }]),
      },
    });
  }
  return {
    animation: false,
    grid: { left: 64, right: 36, top: 40, bottom: 48 },
    tooltip: {
      trigger: "axis", confine: true,
      formatter: (params) => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex: number };
        const row = rows[first.dataIndex];
        return row ? lapTooltip(row, p.editedStops, p.actualStops) : "";
      },
    },
    legend: { show: false },
    ...(p.mode === "random"
      ? { title: { text: "safety cars vary per simulated race", right: 36, top: 8, textStyle: { color: PALETTE.muted, fontSize: 11, fontWeight: "normal" } } }
      : {}),
    xAxis: { type: "category", data: laps, name: "Lap", nameLocation: "middle", nameGap: 28, boundaryGap: false },
    yAxis: { type: "value", inverse: true, name: "Edited car vs actual car (s) — above the line = ahead", nameLocation: "middle", nameGap: 48 },
    series,
  };
}

export default function SimGapChart(props: SimGapChartProps): React.JSX.Element {
  const { perLap, editedStops, actualStops, lapStatus, teamColour, code, mode, ariaLabel, height = 360 } = props;
  const option = useMemo(
    () => buildSimGapOption({ perLap, editedStops, actualStops, lapStatus, teamColour, code, mode }),
    [perLap, editedStops, actualStops, lapStatus, teamColour, code, mode],
  );
  return <EChart option={option} ariaLabel={ariaLabel} height={height} />;
}
