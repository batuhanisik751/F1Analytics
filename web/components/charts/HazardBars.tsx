"use client";
// MODE2_SPEC §8.3 / §5.3 — "Retirements", never "Reliability". A per-lap hazard per
// 1,000 racing laps, with its Jeffreys interval always drawn (FD2). `mode="carOnly"`
// shows the car component with the driver component held at its mean, which is the
// only honest number for a constructor page: a raw hazard charges a driver's crashes
// to the car. A car-season under MODE2_MIN_HAZARD_LAPS carries `sufficient === false`
// and is hatched and faded — it is not a measurement (§8.4.1).
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart from "@/components/charts/EChart";
import { teamColour, type ColourMap } from "@/lib/colours";
import { PALETTE } from "@/lib/theme";

/** Structural copy — charts never import lib/queries. */
export type HazardBarRow = {
  teamId: string;
  year: number;
  retirements: number;
  racingLaps: number;
  hazardPer1000: number;
  hazardLo: number;
  hazardHi: number;
  hazardCarOnly: number;
  hazardCarLo: number;
  hazardCarHi: number;
  rankInSeason: number;
  sufficient: boolean;
  teamName?: string;
  colour?: string;
};

export type HazardBarsProps = {
  rows: HazardBarRow[];
  year: number;
  mode: "raw" | "carOnly";
  colours?: ColourMap;
};

type Elem = NonNullable<CustomSeriesRenderItemReturn>;
type Rect = { x: number; y: number; width: number; height: number };

/** Which stored triplet `mode` selects. */
export function hazardTriplet(
  row: HazardBarRow,
  mode: "raw" | "carOnly",
): { value: number; lo: number; hi: number } {
  return mode === "carOnly"
    ? { value: row.hazardCarOnly, lo: row.hazardCarLo, hi: row.hazardCarHi }
    : { value: row.hazardPer1000, lo: row.hazardLo, hi: row.hazardHi };
}

/** 45° hatch fill for a rect, clipped analytically (§8.4.1). */
export function hatchLines(rect: Rect, colour: string, spacing = 7): Elem[] {
  const out: Elem[] = [];
  const x0 = rect.x;
  const x1 = rect.x + rect.width;
  const y0 = rect.y;
  const y1 = rect.y + rect.height;
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return out;
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  for (let c = x0 + y0; c <= x1 + y1; c += spacing) {
    const xa = clamp(c - y0, x0, x1);
    const xb = clamp(c - y1, x0, x1);
    const ya = clamp(c - xa, y0, y1);
    const yb = clamp(c - xb, y0, y1);
    if (Math.abs(xa - xb) < 0.5 && Math.abs(ya - yb) < 0.5) continue;
    out.push({
      type: "line",
      silent: true,
      shape: { x1: xa, y1: ya, x2: xb, y2: yb },
      style: { stroke: colour, lineWidth: 1.2, opacity: 0.85 },
    });
  }
  return out;
}

export function buildHazardBarsOption(props: HazardBarsProps): EChartsOption {
  const { rows, year, mode, colours } = props;
  const labelOf = (r: HazardBarRow) => r.teamName ?? r.teamId;
  const colourOf = (r: HazardBarRow) => r.colour ?? teamColour(colours, r.teamId);
  const maxHi = Math.max(1, ...rows.map((r) => hazardTriplet(r, mode).hi));

  const bandHeight = (api: CustomSeriesRenderItemAPI) => {
    const band = api.size?.([0, 1]);
    return Array.isArray(band) ? band[1] : typeof band === "number" ? band : 24;
  };

  const barItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const row = rows[params.dataIndex];
    if (!row) return null;
    const y = api.value(0) as number;
    const zero = api.coord([0, y]);
    const tip = api.coord([api.value(1) as number, y]);
    const h = bandHeight(api) * 0.56;
    const rect: Rect = {
      x: Math.min(zero[0], tip[0]),
      y: zero[1] - h / 2,
      width: Math.abs(tip[0] - zero[0]),
      height: h,
    };
    const colour = colourOf(row);
    const base: Elem = {
      type: "rect",
      silent: true,
      shape: rect,
      style: row.sufficient
        ? { fill: colour, opacity: 0.9, stroke: PALETTE.bg, lineWidth: 1 }
        : { fill: colour, opacity: 0.14, stroke: colour, lineWidth: 1.2, lineDash: [4, 3] },
    };
    return {
      type: "group",
      children: row.sufficient ? [base] : [base, ...hatchLines(rect, colour)],
    };
  };

  const ciItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const row = rows[params.dataIndex];
    if (!row) return null;
    const y = api.value(0) as number;
    const lo = api.coord([api.value(1) as number, y]);
    const hi = api.coord([api.value(2) as number, y]);
    const cap = bandHeight(api) * 0.2;
    const stroke = PALETTE.fg;
    return {
      type: "group",
      children: [
        {
          type: "line",
          silent: true,
          shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] },
          style: { stroke, lineWidth: 1.4, opacity: 0.9 },
        },
        {
          type: "line",
          silent: true,
          shape: { x1: lo[0], y1: lo[1] - cap, x2: lo[0], y2: lo[1] + cap },
          style: { stroke, lineWidth: 1.4 },
        },
        {
          type: "line",
          silent: true,
          shape: { x1: hi[0], y1: hi[1] - cap, x2: hi[0], y2: hi[1] + cap },
          style: { stroke, lineWidth: 1.4 },
        },
      ],
    };
  };

  return {
    animation: false,
    // TitleComponent is registered in the frozen EChart wrapper; `graphic` is not.
    title: {
      text: "",
      subtext: `${year} only — retirement hazard is ranked within a season, never across one`,
      left: 150,
      top: 0,
    },
    grid: { left: 150, right: 60, top: 34, bottom: 52 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const row = rows[params.dataIndex];
        if (!row) return "";
        const t = hazardTriplet(row, mode);
        return [
          `<b>${labelOf(row)}</b> · ${row.year}`,
          mode === "carOnly"
            ? `Car component ${t.value.toFixed(2)} per 1,000 laps`
            : `Retirement hazard ${t.value.toFixed(2)} per 1,000 laps`,
          `5th–95th percentile ${t.lo.toFixed(2)} to ${t.hi.toFixed(2)}`,
          `${row.retirements} retirements in ${row.racingLaps.toLocaleString()} racing laps`,
          `Rank in ${row.year}: ${row.rankInSeason}`,
          row.sufficient ? "" : "Fewer than 200 racing laps — not a measurement",
        ]
          .filter(Boolean)
          .join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: maxHi * 1.12,
      name:
        mode === "carOnly"
          ? "Retirements per 1,000 racing laps, car component"
          : "Retirements per 1,000 racing laps",
      nameLocation: "middle",
      nameGap: 30,
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map(labelOf),
      axisTick: { show: false },
      splitLine: { show: false },
    },
    series: [
      {
        id: "hazard",
        name: mode === "carOnly" ? "Car component" : "Retirement hazard",
        type: "custom",
        renderItem: barItem,
        data: rows.map((r, i) => [i, hazardTriplet(r, mode).value]),
        z: 2,
      },
      {
        id: "ci",
        name: "5th–95th percentile",
        type: "custom",
        renderItem: ciItem,
        data: rows.map((r, i) => {
          const t = hazardTriplet(r, mode);
          return [i, t.lo, t.hi];
        }),
        z: 4,
      },
    ],
  };
}

export default function HazardBars(props: HazardBarsProps): React.JSX.Element {
  return (
    <EChart
      option={useMemo(() => buildHazardBarsOption(props), [props])}
      height={34 * props.rows.length + 96}
      ariaLabel={`Retirements per 1,000 racing laps for ${props.rows.length} cars in ${props.year}${props.mode === "carOnly" ? ", car component only" : ""}, each with its 5th to 95th percentile interval`}
    />
  );
}
