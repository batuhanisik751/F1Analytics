"use client";
// MODE2_SPEC §8.3 / §3.5 — the rating over time: a cumulative-through-year level, drawn
// as a step line with its interval band. The band is NOT optional (FD2): a rating point
// is never rendered without the polygon that carries its uncertainty. A markLine with
// the label "team change" is drawn at every year the driver switched team (§3.5) —
// those are the years that actually moved the level.
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

/** Structural copy of the query row (charts never import lib/queries). */
export type RatingHistoryPointRow = {
  throughYear: number;
  ratingPp: number;
  ratingLo: number;
  ratingHi: number;
  nRacesCumulative: number;
  switchedThisYear: boolean;
};

export type RatingHistoryProps = {
  points: RatingHistoryPointRow[];
  ciLevel: number;
  colour?: string;
};

/** §3.3 — `pp` survives only on a labelled axis; prose says "% of a lap". */
const fmtPpFan = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} % of a lap`;

/**
 * The value-axis extent, stated explicitly.
 *
 * The band is a `custom` series drawn from a single dummy datum, so it reports nothing to
 * the axis: left to itself ECharts sizes the axis from the LEVEL line alone, and the band
 * — which is the whole point of the chart (FD2), and is several times taller than the
 * levels it surrounds — is drawn far outside the plot and floods it. The interval decides
 * the extent; the levels sit inside it by construction.
 */
export function valueExtent(points: RatingHistoryPointRow[]): { min: number; max: number } {
  if (points.length === 0) return { min: -1, max: 1 };
  const vs = points.flatMap((p) => [p.ratingPp, p.ratingLo, p.ratingHi]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.08, 0.02);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { min: round(lo - pad), max: round(hi + pad) };
}

/** Stepped (step:'end') band outline: hi forward along the top, lo back along the bottom. */
export function bandPolygonPoints(
  pts: RatingHistoryPointRow[],
  coord: (x: number, y: number) => number[],
): number[][] {
  const top: number[][] = [];
  const bottom: number[][] = [];
  pts.forEach((p, i) => {
    top.push(coord(i, p.ratingHi));
    bottom.push(coord(i, p.ratingLo));
    const next = pts[i + 1];
    if (next) {
      top.push(coord(i + 1, p.ratingHi));
      bottom.push(coord(i + 1, p.ratingLo));
    }
  });
  return [...top, ...bottom.reverse()];
}

export function buildRatingHistoryOption(props: RatingHistoryProps): EChartsOption {
  const { points, ciLevel, colour = PALETTE.accent } = props;
  const pct = Math.round(ciLevel * 100);
  const switched = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.switchedThisYear);

  const bandItem = (
    _params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    if (points.length === 0) return null;
    const poly = bandPolygonPoints(points, (x, y) => api.coord([x, y]));
    if (poly.length < 3) return null;
    return {
      type: "polygon",
      silent: true,
      shape: { points: poly },
      style: { fill: colour, opacity: 0.18 },
    };
  };

  return {
    animation: false,
    grid: { left: 64, right: 24, top: 28, bottom: 52 },
    tooltip: {
      trigger: "axis",
      formatter: (p) => {
        const arr = Array.isArray(p) ? p : [p];
        const i = arr[0]?.dataIndex ?? 0;
        const row = points[i];
        if (!row) return "";
        return [
          `<b>Through ${row.throughYear}</b>`,
          `Rating ${fmtPpFan(row.ratingPp)} — ${ppSecondsHint(row.ratingPp)}`,
          `${pct}% of the time the true value lies between ${fmtPpFan(row.ratingLo)} and ${fmtPpFan(row.ratingHi)}`,
          `Measured over ${row.nRacesCumulative} races up to this point`,
          row.switchedThisYear ? "Team change this year" : "",
        ]
          .filter(Boolean)
          .join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: points.map((p) => String(p.throughYear)),
      name: "Through season",
      nameLocation: "middle",
      nameGap: 30,
    },
    yAxis: {
      type: "value",
      ...valueExtent(points),
      name: "% of a lap vs the average driver",
      nameLocation: "middle",
      nameGap: 46,
      inverse: true,
      axisLabel: { formatter: (v: number) => `${v > 0 ? "+" : ""}${v}` },
    },
    series: [
      {
        id: "band",
        name: `${pct}% interval`,
        type: "custom",
        renderItem: bandItem,
        data: points.length > 0 ? [[0]] : [],
        z: 1,
      },
      {
        id: "level",
        name: "Rating",
        type: "line",
        step: "end",
        symbol: "circle",
        symbolSize: 7,
        showSymbol: true,
        lineStyle: { color: colour, width: 2 },
        itemStyle: { color: colour },
        data: points.map((p) => p.ratingPp),
        z: 3,
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: PALETTE.fg, type: "dashed", width: 1.2, opacity: 0.8 },
          label: {
            formatter: "team change",
            color: PALETTE.muted,
            fontSize: 11,
            position: "insideEndTop",
          },
          data: switched.map(({ i }) => ({ xAxis: i })),
        },
      },
    ],
  };
}

export default function RatingHistory(props: RatingHistoryProps): React.JSX.Element {
  return (
    <EChart
      option={useMemo(() => buildRatingHistoryOption(props), [props])}
      height={340}
      ariaLabel={`Driver rating through each season, in percent of a lap versus the average driver, with the ${Math.round(props.ciLevel * 100)} percent interval shaded and team changes marked`}
    />
  );
}
