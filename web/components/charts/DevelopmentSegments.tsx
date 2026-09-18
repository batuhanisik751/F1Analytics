"use client";
// MODE2_SPEC §8.3 / §5.2 — the in-season development segment: one two-point segment per
// car, start of season to end, with the slope's interval shaded as a wedge behind it.
// §8.3 is explicit: a car whose `slopeSignificant` is false is drawn at opacity 0.35 in
// the neutral grey — the season did not measurably move that car, and the chart must not
// let a reader read a trend out of noise.
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
export type DevelopmentRow = {
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

export type DevelopmentSegmentsProps = {
  rows: DevelopmentRow[];
  year: number;
  colours?: ColourMap;
};

/** §8.3: not significant ⇒ neutral grey at 0.35. */
export const INSIGNIFICANT_OPACITY = 0.35;

type Elem = NonNullable<CustomSeriesRenderItemReturn>;

/** End-of-season interval implied by the slope interval, anchored at `startPp`. */
export function endBounds(row: DevelopmentRow): { lo: number; hi: number } {
  return {
    lo: row.endPp - (row.slopePp - row.slopeLo),
    hi: row.endPp + (row.slopeHi - row.slopePp),
  };
}

/** §3.3 — `pp` survives only on a labelled axis; prose says "% of a lap". */
const fmtPpFan = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} % of a lap`;

export function buildDevelopmentSegmentsOption(
  props: DevelopmentSegmentsProps,
): EChartsOption {
  const { rows, year, colours } = props;
  const labelOf = (r: DevelopmentRow) => r.teamName ?? r.teamId;
  const colourOf = (r: DevelopmentRow) =>
    r.slopeSignificant ? (r.colour ?? teamColour(colours, r.teamId)) : PALETTE.muted;
  const opacityOf = (r: DevelopmentRow) => (r.slopeSignificant ? 1 : INSIGNIFICANT_OPACITY);
  const all = rows.flatMap((r) => {
    const b = endBounds(r);
    return [r.startPp, r.endPp, b.lo, b.hi];
  });
  const lo = Math.min(-0.2, ...all);
  const hi = Math.max(0.2, ...all);
  const pad = (hi - lo) * 0.12 || 0.1;

  const renderItem = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const row = rows[params.dataIndex];
    if (!row) return null;
    const b = endBounds(row);
    const p0 = api.coord([0, row.startPp]);
    const p1 = api.coord([1, row.endPp]);
    const pLo = api.coord([1, b.lo]);
    const pHi = api.coord([1, b.hi]);
    const colour = colourOf(row);
    const op = opacityOf(row);
    const children: Elem[] = [
      // The slope's interval, shaded as a wedge anchored at the season start.
      {
        type: "polygon",
        silent: true,
        shape: {
          points: [
            [p0[0], p0[1]],
            [pHi[0], pHi[1]],
            [pLo[0], pLo[1]],
          ],
        },
        style: { fill: colour, opacity: 0.18 * op },
      },
      {
        type: "line",
        silent: true,
        shape: { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] },
        style: { stroke: colour, lineWidth: row.slopeSignificant ? 2.4 : 1.6, opacity: op },
      },
      {
        type: "circle",
        silent: true,
        shape: { cx: p0[0], cy: p0[1], r: 4 },
        style: { fill: colour, opacity: op },
      },
      {
        type: "circle",
        silent: true,
        shape: { cx: p1[0], cy: p1[1], r: 4 },
        style: row.slopeSignificant
          ? { fill: colour, opacity: op }
          : { fill: PALETTE.bg, stroke: colour, lineWidth: 1.6, opacity: op },
      },
      {
        type: "text",
        silent: true,
        style: {
          text: labelOf(row),
          x: p1[0] + 8,
          y: p1[1],
          fill: colour,
          opacity: op,
          fontSize: 11,
          align: "left",
          verticalAlign: "middle",
        },
      },
    ];
    return { type: "group", children };
  };

  return {
    animation: false,
    grid: { left: 64, right: 132, top: 24, bottom: 52 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const params = Array.isArray(p) ? p[0] : p;
        const row = rows[params.dataIndex];
        if (!row) return "";
        return [
          `<b>${labelOf(row)}</b> · ${row.year}`,
          `Started the season at ${fmtPpFan(row.startPp)}, ended it at ${fmtPpFan(row.endPp)}`,
          `That is a change of ${fmtPpFan(row.slopePp)} across the season — ${ppSecondsHint(row.slopePp)}`,
          `The change could plausibly be anywhere from ${fmtPpFan(row.slopeLo)} to ${fmtPpFan(row.slopeHi)}`,
          row.slopeSignificant
            ? "The season moved this car measurably"
            : "Not distinguishable from no development",
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 1,
      name: `Season progress, ${year}`,
      nameLocation: "middle",
      nameGap: 30,
      axisLabel: {
        formatter: (v: number) => (v === 0 ? "Round 1" : v === 1 ? "Final round" : ""),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      inverse: true,
      min: lo - pad,
      max: hi + pad,
      name: "Car pace, % of a lap vs the field average",
      nameLocation: "middle",
      nameGap: 46,
      axisLabel: { formatter: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}` },
    },
    series: [
      {
        id: "development",
        name: "In-season development",
        type: "custom",
        renderItem,
        data: rows.map((r, i) => [i, r.startPp, r.endPp]),
        z: 2,
      },
    ],
  };
}

export default function DevelopmentSegments(
  props: DevelopmentSegmentsProps,
): React.JSX.Element {
  return (
    <EChart
      option={useMemo(() => buildDevelopmentSegmentsOption(props), [props])}
      height={420}
      ariaLabel={`In-season development for ${props.rows.length} cars in ${props.year}: start-of-season to end-of-season car pace, with cars whose development is not distinguishable from noise drawn faded in grey`}
    />
  );
}
