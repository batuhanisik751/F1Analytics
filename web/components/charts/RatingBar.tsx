"use client";
// MODE2_SPEC §8.3 / §8.4 — driver rating bars. One driver per row.
// Grammar (§8.4): solid = the part of the level supported by `sdWithin`; hatched = the
// part resting on `sdIsland`; a `floating` driver is hatched end to end and gets a
// hollow dot instead of a plain numeral. A visible rule carrying
// "Not comparable to the drivers above" is drawn at every component boundary (§8.4.3).
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart from "@/components/charts/EChart";
import { ppSecondsHint } from "@/components/ui/metricFormat";
import { PALETTE } from "@/lib/theme";

export type AnchorClass = "anchored" | "component-anchored" | "floating";
export type Basis = "measured" | "by-analogy";

/** Structural copy of the query row (charts never import lib/queries). */
export type RatingBarRow = {
  driverId: string;
  ratingPp: number;
  ratingLo: number;
  ratingHi: number;
  sdWithin: number;
  sdIsland: number;
  sdTotal: number;
  fracFloating: number;
  anchorClass: AnchorClass;
  basis: Basis;
  componentId: string;
  componentLabel: string;
  label?: string;
  colour?: string;
};

export type RatingBarProps = {
  rows: RatingBarRow[];
  ciLevel: number;
  highlightDriverId?: string;
  showSeparator?: boolean;
};

export const SEPARATOR_TEXT = "Not comparable to the drivers above";

type Elem = NonNullable<CustomSeriesRenderItemReturn>;
type Rect = { x: number; y: number; width: number; height: number };

/** 45° hatch fill for a rect, clipped analytically — "hatched means assumed" (§8.4.1). */
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

/** The two segments of a rating bar: solid (measured) then hatched (assumed). */
export function splitRating(row: RatingBarRow): { solid: number; assumed: number } {
  if (row.anchorClass === "floating") return { solid: 0, assumed: row.ratingPp };
  const measured = row.sdTotal > 0 ? 1 - Math.min(1, Math.max(0, row.fracFloating)) : 1;
  const solid = row.ratingPp * measured;
  return { solid, assumed: row.ratingPp - solid };
}

/** Row indices (excluding 0) at which the componentId changes — §8.4.3 boundaries. */
export function componentBoundaries(rows: RatingBarRow[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].componentId !== rows[i - 1].componentId) out.push(i);
  }
  return out;
}

/**
 * UX_SPEC §3.3 — `pp` survives only where an axis is labelled and defined. The tooltip is
 * fan-facing prose, so it says "% of a lap", the same unit the x-axis names, and a rating
 * never appears without its seconds equivalent at a stated reference lap.
 */
const fmtPpFan = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} % of a lap`;

/**
 * The value-axis extent, stated explicitly.
 *
 * Three of the four series here are `custom`, and a custom series' first data dimension
 * is the CATEGORY index, not a value — so left to itself ECharts sizes the value axis
 * from 0..rows.length-1 and clips every bar and whisker that reaches left of zero. A
 * rating is negative when the driver is fast, and its interval is the point of the chart
 * (FD2), so neither may ever be cropped: the extent is computed from the rows.
 */
export function valueExtent(rows: RatingBarRow[]): { min: number; max: number } {
  if (rows.length === 0) return { min: -1, max: 1 };
  const vs = rows.flatMap((r) => [r.ratingPp, r.ratingLo, r.ratingHi, 0]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.08, 0.02);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { min: round(lo - pad), max: round(hi + pad) };
}

export function buildRatingBarOption(props: RatingBarProps): EChartsOption {
  const { rows, ciLevel, highlightDriverId, showSeparator = true } = props;
  const pct = Math.round(ciLevel * 100);
  const bounds = showSeparator ? componentBoundaries(rows) : [];
  const colourOf = (r: RatingBarRow) => r.colour ?? PALETTE.accent;
  const opacityOf = (r: RatingBarRow) =>
    highlightDriverId && r.driverId !== highlightDriverId ? 0.45 : 1;

  const bandHeight = (api: CustomSeriesRenderItemAPI) => {
    const band = api.size?.([0, 1]);
    return Array.isArray(band) ? band[1] : typeof band === "number" ? band : 22;
  };

  const assumedItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const row = rows[params.dataIndex];
    if (!row) return null;
    const y = api.value(0) as number;
    const from = api.value(1) as number;
    const to = api.value(2) as number;
    if (Math.abs(to - from) < 1e-9) return null;
    const p0 = api.coord([from, y]);
    const p1 = api.coord([to, y]);
    const h = bandHeight(api) * 0.6;
    const rect: Rect = {
      x: Math.min(p0[0], p1[0]),
      y: p0[1] - h / 2,
      width: Math.abs(p1[0] - p0[0]),
      height: h,
    };
    const colour = colourOf(row);
    return {
      type: "group",
      children: [
        {
          type: "rect",
          silent: true,
          shape: rect,
          style: {
            fill: colour,
            opacity: 0.16 * opacityOf(row),
            stroke: colour,
            lineWidth: 1,
            lineDash: [4, 3],
          },
        },
        ...hatchLines(rect, colour),
      ],
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
    const mid = api.coord([api.value(3) as number, y]);
    const cap = bandHeight(api) * 0.22;
    const stroke = PALETTE.fg;
    const floating = row.anchorClass === "floating";
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
        {
          type: "circle",
          silent: true,
          shape: { cx: mid[0], cy: mid[1], r: 4 },
          style: floating
            ? { fill: PALETTE.bg, stroke, lineWidth: 1.6 }
            : { fill: stroke, stroke, lineWidth: 1 },
        },
      ],
    };
  };

  const separatorItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const cs = params.coordSys as unknown as Rect;
    const idx = api.value(0) as number;
    const p = api.coord([0, idx]);
    const band = api.size?.([0, 1]);
    const bandH = Array.isArray(band) ? band[1] : 22;
    const y = p[1] - bandH / 2;
    return {
      type: "group",
      children: [
        {
          type: "line",
          silent: true,
          shape: { x1: cs.x, y1: y, x2: cs.x + cs.width, y2: y },
          style: { stroke: PALETTE.fg, lineWidth: 1.5, opacity: 0.8 },
        },
        {
          type: "text",
          silent: true,
          style: {
            text: SEPARATOR_TEXT,
            x: cs.x + 6,
            y: y + 3,
            fill: PALETTE.muted,
            fontSize: 11,
            align: "left",
            verticalAlign: "top",
          },
        },
      ],
    };
  };

  return {
    animation: false,
    grid: { left: 148, right: 96, top: 18, bottom: 52 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const row = rows[params.dataIndex];
        if (!row) return "";
        const head = `<b>${row.label ?? row.driverId}</b> · ${row.componentLabel}`;
        const level =
          row.anchorClass === "floating"
            ? "level not measured (this driver is not connected to the rest of the field)"
            : `${fmtPpFan(row.ratingPp)} — ${ppSecondsHint(row.ratingPp)}`;
        return [
          head,
          `Rating ${level}`,
          `${pct}% of the time the true value lies between ${fmtPpFan(row.ratingLo)} and ${fmtPpFan(row.ratingHi)}`,
          `Spread race to race ${row.sdWithin.toFixed(3)} % of a lap (measured SD) · spread across the drivers he is linked to ${row.sdIsland.toFixed(3)} % of a lap (island SD)`,
          `${(row.fracFloating * 100).toFixed(0)}% of that spread cannot be pinned to any one driver`,
          `Worked out from: ${row.basis}`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      ...valueExtent(rows),
      name: "% of a lap vs the average driver",
      nameLocation: "middle",
      nameGap: 30,
      axisLabel: { formatter: (v: number) => `${v > 0 ? "+" : ""}${v}` },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.label ?? r.driverId),
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        formatter: (name: string, i: number) =>
          rows[i]?.anchorClass === "floating" ? `${name} ○` : name,
      },
    },
    series: [
      {
        id: "measured",
        name: "Measured",
        type: "bar",
        barCategoryGap: "40%",
        data: rows.map((r) => ({
          value: splitRating(r).solid,
          itemStyle: { color: colourOf(r), opacity: 0.92 * opacityOf(r) },
        })),
        z: 2,
      },
      {
        id: "assumed",
        name: "Assumed (pooling prior)",
        type: "custom",
        renderItem: assumedItem,
        data: rows.map((r, i) => [i, splitRating(r).solid, r.ratingPp]),
        z: 3,
      },
      {
        id: "ci",
        name: `${pct}% interval`,
        type: "custom",
        renderItem: ciItem,
        data: rows.map((r, i) => [i, r.ratingLo, r.ratingHi, r.ratingPp]),
        z: 5,
      },
      {
        id: "separator",
        name: "Component boundary",
        type: "custom",
        silent: true,
        renderItem: separatorItem,
        data: bounds.map((b) => [b]),
        z: 6,
      },
    ],
  };
}

export default function RatingBar(props: RatingBarProps): React.JSX.Element {
  const option = useMemo(() => buildRatingBarOption(props), [props]);
  const height = 34 * props.rows.length + 90;
  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Driver rating bars for ${props.rows.length} drivers, in percent of a lap versus the average driver, each with its ${Math.round(props.ciLevel * 100)} percent interval`}
    />
  );
}
