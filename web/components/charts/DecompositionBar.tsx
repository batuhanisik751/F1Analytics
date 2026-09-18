"use client";
// MODE2_SPEC §8.3 / §8.4.4 — the driver/car decomposition, one horizontal bar per driver:
// the car segment, then the driver segment. The boundary between them is NEVER crisp.
// It is drawn as a gradient of width 2·sqrt(carSe² + driverSe²) with a whisker across it,
// because that width is exactly what the data do not resolve. A `by-analogy` row is
// hatched end to end (§8.4.1), and a visible rule carrying
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

export type Basis = "measured" | "by-analogy";

/** Structural copy — charts never import lib/queries. */
export type DecompositionRow = {
  driverId: string;
  carPp: number;
  driverPp: number;
  carSe: number;
  driverSe: number;
  basis: Basis;
  componentId: string;
  label?: string;
  componentLabel?: string;
  carColour?: string;
  driverColour?: string;
};

export type DecompositionBarProps = { rows: DecompositionRow[] };

export const SEPARATOR_TEXT = "Not comparable to the drivers above";
export const CAR_COLOUR = "#3c7fd6";
export const DRIVER_COLOUR = PALETTE.accent;
/** Slices used to fake the boundary gradient — deterministic, and SVG-safe. */
export const GRADIENT_SLICES = 14;

type Elem = NonNullable<CustomSeriesRenderItemReturn>;
type Rect = { x: number; y: number; width: number; height: number };

/** §8.3: the boundary is fuzzy over 2·sqrt(carSe² + driverSe²) pp. */
export function boundaryWidth(row: DecompositionRow): number {
  return 2 * Math.sqrt(row.carSe * row.carSe + row.driverSe * row.driverSe);
}

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

/** Row indices (excluding 0) at which the componentId changes — §8.4.3. */
export function componentBoundaries(rows: DecompositionRow[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].componentId !== rows[i - 1].componentId) out.push(i);
  }
  return out;
}

/** §3.3 — `pp` survives only on a labelled axis; prose says "% of a lap". */
const fmtPpFan = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} % of a lap`;

export function buildDecompositionBarOption(props: DecompositionBarProps): EChartsOption {
  const { rows } = props;
  const bounds = componentBoundaries(rows);
  const totals = rows.map((r) => r.carPp + r.driverPp);
  // Rounded out to a tenth of a pp: an axis bound taken straight from the data prints
  // as "-2.8693779770351435" under the formatter below, which reads as false precision
  // on a chart whose whole subject is how imprecise the split is.
  const rawSpan = Math.max(0.2, ...totals.map(Math.abs)) * 1.2;
  const span = Math.ceil(rawSpan * 10) / 10;

  const segment = (rect: Rect, colour: string, row: DecompositionRow): Elem[] => {
    if (rect.width < 0.5) return [];
    const assumed = row.basis === "by-analogy";
    const base: Elem = {
      type: "rect",
      silent: true,
      shape: rect,
      style: assumed
        ? { fill: colour, opacity: 0.16, stroke: colour, lineWidth: 1, lineDash: [4, 3] }
        : { fill: colour, opacity: 0.9, stroke: PALETTE.bg, lineWidth: 1 },
    };
    return assumed ? [base, ...hatchLines(rect, colour)] : [base];
  };

  const renderItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const row = rows[params.dataIndex];
    if (!row) return null;
    const y = api.value(0) as number;
    const band = api.size?.([0, 1]);
    const bandH = Array.isArray(band) ? band[1] : 24;
    const h = bandH * 0.58;
    const zero = api.coord([0, y]);
    const mid = api.coord([row.carPp, y]);
    const end = api.coord([row.carPp + row.driverPp, y]);
    const top = zero[1] - h / 2;
    const hw = Math.abs(api.coord([boundaryWidth(row) / 2, y])[0] - zero[0]);
    const carColour = row.carColour ?? CAR_COLOUR;
    const driverColour = row.driverColour ?? DRIVER_COLOUR;

    const children: Elem[] = [];
    // Car segment, stopping short of the fuzzy boundary.
    const carLo = Math.min(zero[0], mid[0]);
    const carHi = Math.max(zero[0], mid[0]);
    children.push(
      ...segment(
        { x: carLo, y: top, width: Math.max(0, carHi - carLo - hw), height: h },
        carColour,
        row,
      ),
    );
    // Driver segment, starting past the fuzzy boundary.
    const drvLo = Math.min(mid[0], end[0]);
    const drvHi = Math.max(mid[0], end[0]);
    const drvStart = drvLo + hw;
    children.push(
      ...segment(
        { x: drvStart, y: top, width: Math.max(0, drvHi - drvStart), height: h },
        driverColour,
        row,
      ),
    );
    // The boundary itself: a gradient, never a crisp edge (§8.4.4).
    const gw = Math.max(hw * 2, 6);
    const slice = gw / GRADIENT_SLICES;
    for (let s = 0; s < GRADIENT_SLICES; s += 1) {
      const t = (s + 0.5) / GRADIENT_SLICES;
      children.push({
        type: "rect",
        silent: true,
        shape: { x: mid[0] - gw / 2 + s * slice, y: top, width: slice + 0.6, height: h },
        style: {
          fill: t < 0.5 ? carColour : driverColour,
          opacity: (row.basis === "by-analogy" ? 0.35 : 0.85) * (1 - Math.abs(t - 0.5) * 1.6),
        },
      });
    }
    // Whisker across the fuzzy boundary.
    const cy = top + h / 2;
    const cap = h * 0.42;
    children.push(
      {
        type: "line",
        silent: true,
        shape: { x1: mid[0] - gw / 2, y1: cy, x2: mid[0] + gw / 2, y2: cy },
        style: { stroke: PALETTE.fg, lineWidth: 1.4 },
      },
      {
        type: "line",
        silent: true,
        shape: { x1: mid[0] - gw / 2, y1: cy - cap, x2: mid[0] - gw / 2, y2: cy + cap },
        style: { stroke: PALETTE.fg, lineWidth: 1.4 },
      },
      {
        type: "line",
        silent: true,
        shape: { x1: mid[0] + gw / 2, y1: cy - cap, x2: mid[0] + gw / 2, y2: cy + cap },
        style: { stroke: PALETTE.fg, lineWidth: 1.4 },
      },
    );
    return { type: "group", children };
  };

  const separatorItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const cs = params.coordSys as unknown as Rect;
    const idx = api.value(0) as number;
    const p = api.coord([0, idx]);
    const band = api.size?.([0, 1]);
    const bandH = Array.isArray(band) ? band[1] : 24;
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
    // The chart carries its own key. A crop of the plot alone would otherwise show two
    // coloured halves with no way to tell which is the car, and a hatched bar with no
    // way to tell that hatching means assumed — the caption that says so lives outside
    // the image. §8.4 asks the grammar to survive being screenshotted without context.
    title: {
      subtext: [
        "Each bar: the car's part of the lap, then the driver's part, meeting at a blur",
        "as wide as the split is uncertain. Hatched = assumed, not measured.",
      ].join(" "),
      subtextStyle: { color: PALETTE.muted, fontSize: 11, lineHeight: 15 },
      left: 8,
      top: 2,
    },
    grid: { left: 148, right: 40, top: 54, bottom: 52 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const row = rows[params.dataIndex];
        if (!row) return "";
        // UX_SPEC §3.3 — prose says "% of a lap"; "SE" is named before it is abbreviated;
        // the fuzziness of the split is stated in the same unit as the split itself.
        return [
          `<b>${row.label ?? row.driverId}</b>${row.componentLabel ? ` · ${row.componentLabel}` : ""}`,
          `Car ${fmtPpFan(row.carPp)} — ${ppSecondsHint(row.carPp)} — give or take ${row.carSe.toFixed(3)} (standard error, SE)`,
          `Driver ${fmtPpFan(row.driverPp)} — ${ppSecondsHint(row.driverPp)} — give or take ${row.driverSe.toFixed(3)} (standard error, SE)`,
          `The line between car and driver is fuzzy over ${boundaryWidth(row).toFixed(3)} % of a lap — inside that width the split cannot be called`,
          row.basis === "by-analogy"
            ? "Basis: by-analogy — the split is assumed from similar cases, not measured (pooling prior)"
            : "Basis: measured from this driver's own races",
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      name: "% of a lap vs the field average (car + driver)",
      nameLocation: "middle",
      nameGap: 30,
      min: -span,
      max: span,
      axisLabel: {
        formatter: (v: number) => {
          const n = Math.round(v * 100) / 100;
          return `${n > 0 ? "+" : ""}${n}`;
        },
      },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.label ?? r.driverId),
      axisTick: { show: false },
      splitLine: { show: false },
    },
    series: [
      {
        id: "decomposition",
        name: "Car and driver",
        type: "custom",
        renderItem,
        data: rows.map((r, i) => [i, r.carPp, r.carPp + r.driverPp]),
        z: 2,
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

export default function DecompositionBar(props: DecompositionBarProps): React.JSX.Element {
  return (
    <EChart
      option={useMemo(() => buildDecompositionBarOption(props), [props])}
      height={36 * props.rows.length + 90}
      ariaLabel={`Car versus driver decomposition for ${props.rows.length} drivers; the boundary between the car and driver share is drawn as a gradient whose width is what the data cannot resolve`}
    />
  );
}
