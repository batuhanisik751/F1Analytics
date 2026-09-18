"use client";
// TELEMETRY_SPEC v1.7 §5.3 — V3, the channel stack. Four rows on ONE shared x-axis,
// immediately below V2 and on the same x range, so the eye reads straight down from
// "he gained here" to "because he braked later".
//
// Two rules here are not cosmetic:
//
//   * §5.0 — DRIVER A SOLID, DRIVER B DASHED, ALWAYS. Drivers take their team colour from
//     the database, so the DEFAULT pair (teammates, §5.5) collides on colour. The dash is
//     what keeps a teammate comparison legible without inventing a colour the team does
//     not have. It is applied by POSITION in `laps`, not taken from the caller.
//   * §5.3 / §6.5 — when the session's `drs` channel is flat, the DRS row is REPLACED by
//     the C-TEL-7 sentence rather than drawn empty. Measured: `drs` was 0 for every sample
//     of every lap in 2026 R13 Q. An empty DRS row would be read as "nobody opened it".
//     Absent data and a measured zero must not look the same.
//
// `throttle_pct` is plotted AS DELIVERED, up to 104, with the axis at 105 and a dotted
// rule at 100 (§6.5). Clamping would hide a real property of the feed.
//
// Imports `EChart` and nothing else from the charting stack (SPEC §3.4 / §5.0).
import { useMemo } from "react";
import EChart, { type EChartsOption } from "./EChart";
import { PALETTE } from "@/lib/theme";
import { C_TEL_7 } from "@/lib/telemetry/captions";

/** One lap's channels. Structurally satisfied by `StoredLapTelemetry` plus the colour. */
export type ChannelStackLap = {
  code: string;
  /** Team colour from the database (§5.0). Two teammates legitimately share one. */
  colour: string;
  /** T5 — chord metres, `[0] = 0`. */
  distanceM: readonly number[];
  speedKph: readonly number[];
  /** As delivered: reaches 104 on ~1.1% of samples and is NOT clamped (§6.5). */
  throttlePct: readonly number[];
  brake: readonly boolean[];
  /** 0 means "no reading", not neutral (§4.1). */
  gear: readonly number[];
  /** Raw DRS codes; only 10/12/14 are open. Measured flat on every lap of 2026 R13 Q. */
  drs: readonly number[];
};

export type ChannelStackCorner = {
  cornerNumber: number;
  cornerLetter: string;
  distanceM: number;
};

/**
 * `lib/telemetry/captions.ts` owns the prose (§6.3) and its drift test is what makes
 * "verbatim" mechanical; this component decides only what to SHOW. The override exists so
 * a second surface can reword nothing — it defaults to C-TEL-7.
 */
export type ChannelStackCaptions = {
  /** C-TEL-7 — shown in place of the DRS row when the channel is flat. */
  noDrsSignal?: string;
};

/** The raw codes FastF1 reports for an OPEN rear wing. Anything else is closed. */
export const DRS_OPEN_CODES: readonly number[] = [10, 12, 14];

/** §5.0 — A solid, B dashed, always. Position in `laps` decides it, never the caller. */
export function seriesDash(index: number): "solid" | "dashed" {
  return index === 0 ? "solid" : "dashed";
}

/**
 * §5.3 / §6.5 — "flat" means the channel never changes across any stored lap. A flat
 * channel is ABSENT, not zero, and its row is replaced by a sentence.
 */
export function drsIsFlat(laps: readonly ChannelStackLap[]): boolean {
  const seen = new Set<number>();
  for (const lap of laps) for (const v of lap.drs) seen.add(v);
  return seen.size <= 1;
}

/**
 * The `[from, to]` chord intervals over which `flag` is true, in metres. Used for the brake
 * band under the throttle row and for the DRS band, both of which are STATES along the road
 * rather than values at a point.
 */
export function runIntervals(
  distanceM: readonly number[],
  flag: (i: number) => boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < distanceM.length; i++) {
    if (flag(i)) {
      if (start === null) start = distanceM[i];
    } else if (start !== null) {
      out.push([start, distanceM[i]]);
      start = null;
    }
  }
  if (start !== null) out.push([start, distanceM[distanceM.length - 1]]);
  return out;
}

/** §5.3's four grids, and the three that remain when the DRS row is replaced by C-TEL-7. */
const GRID_FRAME = { left: 56, right: 16 } as const;
const GRIDS_4 = [
  { top: "2%", height: "30%" },
  { top: "36%", height: "22%" },
  { top: "60%", height: "18%" },
  { top: "80%", height: "14%" },
];
const GRIDS_3 = [
  { top: "2%", height: "34%" },
  { top: "42%", height: "26%" },
  { top: "74%", height: "22%" },
];

/** A band's y extent inside its row, split so two drivers' bands never overlap. */
function bandRange(index: number, n: number, top: number): [number, number] {
  const h = top / Math.max(n, 1);
  return [index * h, (index + 1) * h];
}

export type ChannelStackOptionInput = {
  laps: readonly ChannelStackLap[];
  /** Shared with V2 so the eye reads straight down; defaults to the shortest lap. */
  sEndM: number;
  corners: readonly ChannelStackCorner[];
  /** False when the channel is flat: the row is not drawn at all (§6.5). */
  showDrsRow: boolean;
};

export function buildChannelStackOption(input: ChannelStackOptionInput): EChartsOption {
  const { laps, sEndM, corners, showDrsRow } = input;
  const grids = (showDrsRow ? GRIDS_4 : GRIDS_3).map((g) => ({ ...g, ...GRID_FRAME }));
  const nGrids = grids.length;

  const cornerLines = corners
    .filter((c) => c.distanceM >= 0 && c.distanceM <= sEndM)
    .map((c) => ({
      xAxis: c.distanceM,
      label: {
        show: true,
        formatter: `T${c.cornerNumber}${c.cornerLetter}`,
        position: "insideEndTop" as const,
        color: PALETTE.muted,
        fontSize: 10,
      },
      lineStyle: { color: PALETTE.grid, width: 1, type: "dotted" as const },
    }));

  const pairs = (lap: ChannelStackLap, ch: readonly number[]) =>
    lap.distanceM.map((d, i) => [d, ch[i]] as [number, number]);

  const series: Record<string, unknown>[] = [];

  // Row 1 — Speed. A solid, B dashed, team colours (§5.3).
  laps.forEach((lap, i) => {
    series.push({
      type: "line",
      name: `${lap.code} speed`,
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: pairs(lap, lap.speedKph),
      showSymbol: false,
      smooth: false,
      lineStyle: { color: lap.colour, width: 1.6, type: seriesDash(i) },
      itemStyle: { color: lap.colour },
      markLine:
        i === 0
          ? { silent: true, symbol: "none", data: cornerLines }
          : undefined,
    });
  });

  // Row 2 — Throttle, 0..105 as delivered, dotted rule at 100, brake bands along the
  // bottom 20% of the row (§5.3). The brake band is a STATE along the road, so it is a
  // markArea and not a second line that would imply a magnitude it does not have.
  laps.forEach((lap, i) => {
    const [y0, y1] = bandRange(i, laps.length, 21);
    series.push({
      type: "line",
      name: `${lap.code} throttle`,
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: pairs(lap, lap.throttlePct),
      showSymbol: false,
      smooth: false,
      lineStyle: { color: lap.colour, width: 1.4, type: seriesDash(i) },
      itemStyle: { color: lap.colour },
      markLine:
        i === 0
          ? {
              silent: true,
              symbol: "none",
              data: [
                {
                  yAxis: 100,
                  lineStyle: { color: PALETTE.muted, width: 1, type: "dotted" as const },
                },
              ],
            }
          : undefined,
      markArea: {
        silent: true,
        itemStyle: { color: lap.colour, opacity: 0.35 },
        data: runIntervals(lap.distanceM, (k) => lap.brake[k] === true).map(([a, b]) => [
          { xAxis: a, yAxis: y0 },
          { xAxis: b, yAxis: y1 },
        ]),
      },
    });
  });

  // Row 3 — Gear. `step: 'end'` because a gear is held until it is changed; interpolating
  // between 4th and 5th would draw a gear the car was never in.
  laps.forEach((lap, i) => {
    series.push({
      type: "line",
      name: `${lap.code} gear`,
      xAxisIndex: 2,
      yAxisIndex: 2,
      step: "end",
      data: pairs(lap, lap.gear),
      showSymbol: false,
      lineStyle: { color: lap.colour, width: 1.4, type: seriesDash(i) },
      itemStyle: { color: lap.colour },
    });
  });

  // Row 4 — DRS, a two-state band per driver. Only reached when the channel is NOT flat:
  // §6.5 replaces the whole row with C-TEL-7 otherwise, because an empty row reads as
  // "nobody opened it" and that is a different claim from "this was not recorded".
  if (showDrsRow) {
    laps.forEach((lap, i) => {
      const [y0, y1] = bandRange(i, laps.length, 1);
      series.push({
        type: "line",
        name: `${lap.code} DRS`,
        xAxisIndex: 3,
        yAxisIndex: 3,
        data: [],
        showSymbol: false,
        silent: true,
        markArea: {
          silent: true,
          itemStyle: { color: lap.colour, opacity: 0.45 },
          data: runIntervals(lap.distanceM, (k) =>
            DRS_OPEN_CODES.includes(lap.drs[k]),
          ).map(([a, b]) => [
            { xAxis: a, yAxis: y0 },
            { xAxis: b, yAxis: y1 },
          ]),
        },
      });
    });
  }

  const last = nGrids - 1;
  return {
    animation: false,
    // One shared x cursor down every row: this is the mechanism that makes the stack a
    // stack rather than four charts stacked (§5.3).
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: PALETTE.raised } },
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    grid: grids,
    xAxis: grids.map((_, i) => ({
      gridIndex: i,
      type: "value" as const,
      min: 0,
      max: sEndM,
      axisLabel: { show: i === last },
      axisLine: { show: i === last },
      axisTick: { show: i === last },
      splitLine: { show: false },
      name: i === last ? "distance (m)" : undefined,
      nameLocation: "middle" as const,
      nameGap: 26,
    })),
    yAxis: [
      { gridIndex: 0, type: "value" as const, name: "km/h", nameTextStyle: { fontSize: 10 } },
      // 105, not 100: throttle reaches 104 and is stored as delivered (§6.5).
      { gridIndex: 1, type: "value" as const, min: 0, max: 105, name: "throttle %", nameTextStyle: { fontSize: 10 } },
      { gridIndex: 2, type: "value" as const, min: 1, max: 8, interval: 1, name: "gear", nameTextStyle: { fontSize: 10 } },
      ...(showDrsRow
        ? [{ gridIndex: 3, type: "value" as const, min: 0, max: 1, show: false }]
        : []),
    ],
    series,
  } as EChartsOption;
}

export type ChannelStackProps = {
  /** One lap on a race page, two on Q/SQ (§5.3). Position 0 is A and is drawn solid. */
  laps: readonly ChannelStackLap[];
  /** Share V2's x range so the eye reads straight down. Defaults to the shortest lap. */
  sEndM?: number;
  corners?: readonly ChannelStackCorner[];
  /** Optional overrides; the DRS replacement sentence defaults to C-TEL-7. */
  captions?: ChannelStackCaptions;
  height?: number | string;
  className?: string;
};

export default function ChannelStack({
  laps,
  sEndM,
  corners = [],
  captions,
  height = 520,
  className,
}: ChannelStackProps): React.JSX.Element {
  const showDrsRow = useMemo(() => !drsIsFlat(laps), [laps]);
  const end = useMemo(
    () =>
      sEndM ??
      Math.min(...laps.map((l) => l.distanceM[l.distanceM.length - 1] ?? 0)),
    [sEndM, laps],
  );
  const option = useMemo(
    () => buildChannelStackOption({ laps, sEndM: end, corners, showDrsRow }),
    [laps, end, corners, showDrsRow],
  );

  return (
    <div className={className} data-drs-row={showDrsRow ? "drawn" : "replaced"}>
      <EChart
        option={option}
        height={height}
        ariaLabel={`Channel stack for ${laps.map((l) => l.code).join(" and ")}: speed, throttle and brake, gear${
          showDrsRow ? " and DRS" : ""
        }`}
        notMerge
      />
      {!showDrsRow && (
        <p
          style={{
            color: PALETTE.muted,
            fontSize: 12,
            lineHeight: 1.5,
            margin: "8px 0 0",
            maxWidth: "72ch",
          }}
        >
          {captions?.noDrsSignal ?? C_TEL_7}
        </p>
      )}
    </div>
  );
}
