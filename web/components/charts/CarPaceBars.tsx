"use client";
// MODE2_SPEC §8.3 / §5.2 — car pace rating per season with the driver effects stripped
// out. One bar per car, always with its interval (FD2). A `by-analogy` row — a car whose
// pace level rests on the pooling prior because its component floats (§1.4) — is hatched
// and outlined, never drawn as a solid measured bar (§8.4.1).
import { useMemo } from "react";
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import EChart from "@/components/charts/EChart";
import { ppSecondsHint } from "@/components/ui/metricFormat";
import { teamColour, type ColourMap } from "@/lib/colours";
import { PALETTE } from "@/lib/theme";

export type Basis = "measured" | "by-analogy";

/** Structural copy — charts never import lib/queries. */
export type CarPaceRow = {
  teamId: string;
  year: number;
  gammaPp: number;
  gammaLo: number;
  gammaHi: number;
  slopePp: number;
  slopeLo: number;
  slopeHi: number;
  startPp: number;
  endPp: number;
  slopeSignificant: boolean;
  rankInSeason: number;
  basis: Basis;
  nRaces: number;
  teamName?: string;
  colour?: string;
};

export type CarPaceBarsProps = {
  rows: CarPaceRow[];
  year?: number;
  ciLevel: number;
  colours?: ColourMap;
};

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

/** §3.3 — `pp` survives only on a labelled axis; prose says "% of a lap". */
const fmtPpFan = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} % of a lap`;
/** "3rd quickest car" reads; "rank in season 3" does not. */
function ordinalSuffix(n: number): string {
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

export function buildCarPaceBarsOption(props: CarPaceBarsProps): EChartsOption {
  const { rows, ciLevel, colours } = props;
  const pct = Math.round(ciLevel * 100);
  const colourOf = (r: CarPaceRow) => r.colour ?? teamColour(colours, r.teamId);
  const labelOf = (r: CarPaceRow) => r.teamName ?? r.teamId;
  const span = Math.max(0.2, ...rows.map((r) => Math.max(Math.abs(r.gammaLo), Math.abs(r.gammaHi))));

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
    const assumed = row.basis === "by-analogy";
    const base: Elem = {
      type: "rect",
      silent: true,
      shape: rect,
      style: assumed
        ? { fill: colour, opacity: 0.16, stroke: colour, lineWidth: 1.2, lineDash: [4, 3] }
        : { fill: colour, opacity: 0.9, stroke: PALETTE.bg, lineWidth: 1 },
    };
    return {
      type: "group",
      children: assumed ? [base, ...hatchLines(rect, colour)] : [base],
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
    grid: { left: 150, right: 60, top: 18, bottom: 52 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const row = rows[params.dataIndex];
        if (!row) return "";
        // UX_SPEC §3.3 — the tooltip is fan-facing prose, so it uses the unit the axis
        // names ("% of a lap") and never the abbreviation, and the gap carries its seconds
        // equivalent at a stated reference lap.
        return [
          `<b>${labelOf(row)}</b> · ${row.year}`,
          `Car pace ${fmtPpFan(row.gammaPp)} — ${ppSecondsHint(row.gammaPp)}`,
          `${pct}% of the time the true value lies between ${fmtPpFan(row.gammaLo)} and ${fmtPpFan(row.gammaHi)}`,
          `${row.rankInSeason}${ordinalSuffix(row.rankInSeason)} quickest car this season · measured over ${row.nRaces} races`,
          row.basis === "by-analogy"
            ? "Basis: by-analogy — this car's level is assumed from similar cars, not measured (pooling prior)"
            : "Basis: measured from this car's own races",
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      name: "Car pace, % of a lap vs the field average",
      nameLocation: "middle",
      nameGap: 30,
      min: -span * 1.15,
      max: span * 1.15,
      axisLabel: { formatter: (v: number) => `${v > 0 ? "+" : ""}${v}` },
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
        id: "car",
        name: "Car pace",
        type: "custom",
        renderItem: barItem,
        data: rows.map((r, i) => [i, r.gammaPp]),
        z: 2,
      },
      {
        id: "ci",
        name: `${pct}% interval`,
        type: "custom",
        renderItem: ciItem,
        data: rows.map((r, i) => [i, r.gammaLo, r.gammaHi]),
        z: 4,
      },
    ],
  };
}

export default function CarPaceBars(props: CarPaceBarsProps): React.JSX.Element {
  return (
    <EChart
      option={useMemo(() => buildCarPaceBarsOption(props), [props])}
      height={34 * props.rows.length + 90}
      ariaLabel={`Car pace rating for ${props.rows.length} cars${props.year ? ` in ${props.year}` : ""}, driver effects removed, each with its ${Math.round(props.ciLevel * 100)} percent interval`}
    />
  );
}
