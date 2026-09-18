"use client";
// TELEMETRY_SPEC v1.7 §5.1 — V1, the track map: one lap's road, painted by one channel.
// The one picture this app has never had: where the car is slow and where it is fast, as
// GEOGRAPHY rather than as a number.
//
// Imports `EChart` and nothing else from the charting stack (SPEC §3.4 / §5.0).
//
// T11: the three semantic timing-tower tokens encode MEANING (fastest lap / personal
// best / off the pace) and appear nowhere in this feature — painting a speed ramp with
// them would tell a fan that purple means *fastest* when here it would mean *340 km/h*.
// The ramp below is the new `--ramp-*` group and carries MAGNITUDE only.
import { useMemo, useState } from "react";
import EChart, { type EChartsOption } from "./EChart";
import { PALETTE } from "@/lib/theme";
import { POSITION_UNITS_PER_M } from "@/lib/telemetry/align";

/** §5.0 — `--ramp-0..4`. Dark = low, bright = high. Magnitude, not meaning. */
export const RAMP = ["#0A2540", "#17527D", "#2E8FB8", "#6FD3E8", "#DFF6FF"] as const;

export type TrackChannel = "speed" | "gear" | "throttle" | "brake";

export const TRACK_CHANNELS: ReadonlyArray<{ key: TrackChannel; label: string }> = [
  { key: "speed", label: "Speed" },
  { key: "gear", label: "Gear" },
  { key: "throttle", label: "Throttle" },
  { key: "brake", label: "Brake" },
];

export type TrackMapLap = {
  code: string;
  /** Raw, unrotated FastF1 position units — tenths of a metre (§0.3). */
  x: readonly number[];
  y: readonly number[];
  /** T5 — chord distance in metres. Carried for the hover readout and the V2/V3 link. */
  distanceM: readonly number[];
  speedKph: readonly number[];
  gear: readonly number[];
  throttlePct: readonly number[];
  brake: readonly boolean[];
};

export type TrackMapCorner = {
  cornerNumber: number;
  cornerLetter: string;
  x: number;
  y: number;
  distanceM: number;
};

/** §5.1 — `x' = x cosθ − y sinθ`, `y' = x sinθ + y cosθ`. Measured θ = 95.0° for 2026 R13. */
export function rotatePoint(x: number, y: number, rotationDeg: number): [number, number] {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

export type TrackMapBox = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** width / height of the PADDED box — the container takes this shape, not the reverse. */
  aspect: number;
};

export type TrackMapGeometry = {
  /** `[x', y', channel, distance_m, index]`, in metres. */
  pts: number[][];
  /** `[x', y', label]` for the corner numbers. */
  cornerPts: Array<[number, number, string]>;
  box: TrackMapBox;
  channelMin: number;
  channelMax: number;
};

function channelValues(lap: TrackMapLap, channel: TrackChannel): readonly number[] {
  switch (channel) {
    case "gear":
      return lap.gear;
    case "throttle":
      return lap.throttlePct;
    case "brake":
      return lap.brake.map((b) => (b ? 1 : 0));
    case "speed":
    default:
      return lap.speedKph;
  }
}

/** §5.1 — 4% of the LONGER side, added to both axes, so the pad never distorts the shape. */
export const TRACK_MAP_PAD_FRACTION = 0.04;

/**
 * Rotate, convert to metres, and compute the padded bounding box.
 *
 * The aspect ratio is the mechanism, not an assertion (§5.1): ECharts will happily
 * stretch a circuit to fill a rectangle, so instead the CONTAINER is given the box's own
 * ratio and both axes are pinned to the box explicitly. One metre is then one metre on
 * both axes at every viewport width, with no resize maths.
 */
export function trackMapGeometry(
  lap: TrackMapLap,
  corners: readonly TrackMapCorner[],
  rotationDeg: number,
  channel: TrackChannel,
): TrackMapGeometry {
  const ch = channelValues(lap, channel);
  const n = Math.min(lap.x.length, lap.y.length, ch.length, lap.distanceM.length);
  const pts: number[][] = new Array(n);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const [rx, ry] = rotatePoint(
      lap.x[i] / POSITION_UNITS_PER_M,
      lap.y[i] / POSITION_UNITS_PER_M,
      rotationDeg,
    );
    const v = ch[i];
    pts[i] = [rx, ry, v, lap.distanceM[i], i];
    if (rx < xMin) xMin = rx;
    if (rx > xMax) xMax = rx;
    if (ry < yMin) yMin = ry;
    if (ry > yMax) yMax = ry;
    if (v < cMin) cMin = v;
    if (v > cMax) cMax = v;
  }
  const pad = TRACK_MAP_PAD_FRACTION * Math.max(xMax - xMin, yMax - yMin);
  const box: TrackMapBox = {
    xMin: xMin - pad,
    xMax: xMax + pad,
    yMin: yMin - pad,
    yMax: yMax + pad,
    aspect: (xMax - xMin + 2 * pad) / (yMax - yMin + 2 * pad),
  };
  const cornerPts = corners.map((c) => {
    const [rx, ry] = rotatePoint(
      c.x / POSITION_UNITS_PER_M,
      c.y / POSITION_UNITS_PER_M,
      rotationDeg,
    );
    return [rx, ry, `${c.cornerNumber}${c.cornerLetter}`] as [number, number, string];
  });
  return { pts, cornerPts, box, channelMin: cMin, channelMax: cMax };
}

function lerpHex(a: string, b: string, f: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * f));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** `steps` colours sampled along `--ramp-0..4`. Used for the 8 gear pieces. */
export function rampSteps(steps: number): string[] {
  if (steps <= 1) return [RAMP[RAMP.length - 1]];
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / (steps - 1)) * (RAMP.length - 1);
    const lo = Math.min(Math.floor(t), RAMP.length - 2);
    return lerpHex(RAMP[lo], RAMP[lo + 1], t - lo);
  });
}

const CHANNEL_UNIT: Record<TrackChannel, string> = {
  speed: " km/h",
  gear: "",
  throttle: "%",
  brake: "",
};

function visualMapFor(
  channel: TrackChannel,
  min: number,
  max: number,
): Record<string, unknown> {
  const common = {
    dimension: 2,
    seriesIndex: 1,
    calculable: false,
    orient: "horizontal" as const,
    bottom: 4,
    left: "center" as const,
    itemWidth: 10,
    itemHeight: 120,
    textStyle: { color: PALETTE.muted },
  };
  if (channel === "brake") {
    // A brake trace is a BINARY. A continuous ramp would imply a magnitude that does
    // not exist in the channel (§5.1).
    return {
      ...common,
      type: "piecewise",
      pieces: [
        { value: 0, label: "off", color: PALETTE.grid },
        { value: 1, label: "braking", color: RAMP[4] },
      ],
    };
  }
  if (channel === "gear") {
    const colours = rampSteps(8);
    return {
      ...common,
      type: "piecewise",
      pieces: colours.map((color, i) => ({ value: i + 1, label: `${i + 1}`, color })),
      // gear 0 means "no reading" (§2.1) and is deliberately left unpainted.
      outOfRange: { color: PALETTE.grid },
    };
  }
  return {
    ...common,
    type: "continuous",
    min,
    max,
    inRange: { color: [...RAMP] },
  };
}

export type TrackMapOptionInput = {
  geometry: TrackMapGeometry;
  channel: TrackChannel;
  /** Chord distance of the point V2/V3 is hovering, if any. Moves the highlight dot. */
  highlightDistanceM?: number | null;
};

/**
 * The whole option, built as a pure function so a node script can measure it (§7.1:
 * metres-per-pixel equal on both axes to < 1% at 400 px and 1400 px) without a browser.
 */
export function buildTrackMapOption(input: TrackMapOptionInput): EChartsOption {
  const { geometry, channel } = input;
  const { box, pts, cornerPts } = geometry;
  const unit = CHANNEL_UNIT[channel];

  let highlight: number[][] = [];
  if (input.highlightDistanceM != null && pts.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i][3] - input.highlightDistanceM);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    highlight = [pts[best]];
  }

  return {
    animation: false,
    // The box is pinned on BOTH axes and the grid has no padding at all: the only way
    // metres-per-pixel can stay equal on both axes at every width (§5.1).
    grid: { left: 0, right: 0, top: 0, bottom: 0, containLabel: false },
    xAxis: { show: false, type: "value", min: box.xMin, max: box.xMax },
    yAxis: { show: false, type: "value", min: box.yMin, max: box.yMax },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const v = (p as { value?: number[] }).value;
        if (!v) return "";
        return `${Math.round(v[3])} m · ${v[2]}${unit}`;
      },
    },
    visualMap: visualMapFor(channel, geometry.channelMin, geometry.channelMax),
    series: [
      {
        // 1. the outline — guarantees continuity where the painted points thin out.
        type: "line",
        data: pts,
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { color: PALETTE.grid, width: 7, cap: "round", join: "round" },
      },
      {
        // 2. the painted ribbon. dim 0 = x', 1 = y', 2 = channel, 3 = distance_m.
        type: "scatter",
        data: pts,
        symbolSize: 6,
        z: 2,
        encode: { x: 0, y: 1, tooltip: [3] },
      },
      {
        // 3. corner numbers.
        type: "scatter",
        data: cornerPts,
        symbolSize: 1,
        z: 3,
        silent: true,
        label: {
          show: true,
          formatter: "{@[2]}",
          color: PALETTE.muted,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        },
      },
      {
        // 4. the highlight dot V2/V3 drive. Empty unless something is hovered there.
        type: "scatter",
        data: highlight,
        symbolSize: 12,
        z: 4,
        silent: true,
        itemStyle: { color: "transparent", borderColor: PALETTE.fg, borderWidth: 2 },
      },
    ],
  } as EChartsOption;
}

export type TrackMapProps = {
  lap: TrackMapLap;
  corners: readonly TrackMapCorner[];
  /** `circuit_layout.rotation_deg`. Measured 95.0 for 2026 R13; a map without it is a
   *  quarter-turn wrong and a fan does not recognise the circuit (§5.1). */
  rotationDeg: number;
  /** Controlled when `onChannelChange` is supplied; otherwise the component owns it. */
  channel?: TrackChannel;
  onChannelChange?: (channel: TrackChannel) => void;
  /** Chord distance V2/V3 is hovering. Moves the highlight dot and the readout. */
  highlightDistanceM?: number | null;
  /** Publishes the hovered chord distance so V2/V3 can move their axisPointer (§5.1). */
  onHoverDistance?: (distanceM: number | null) => void;
  className?: string;
};

function ordinal(g: number): string {
  if (g <= 0) return "no gear reading";
  const suffix = g === 1 ? "st" : g === 2 ? "nd" : g === 3 ? "rd" : "th";
  return `${g}${suffix}`;
}

export default function TrackMap({
  lap,
  corners,
  rotationDeg,
  channel,
  onChannelChange,
  highlightDistanceM = null,
  onHoverDistance,
  className,
}: TrackMapProps): React.JSX.Element {
  const [ownChannel, setOwnChannel] = useState<TrackChannel>("speed");
  const active = channel ?? ownChannel;
  const setActive = onChannelChange ?? setOwnChannel;
  const [hovered, setHovered] = useState<number | null>(null);

  const geometry = useMemo(
    () => trackMapGeometry(lap, corners, rotationDeg, active),
    [lap, corners, rotationDeg, active],
  );

  const readoutAt = hovered ?? highlightDistanceM;
  const option = useMemo(() => {
    const base = buildTrackMapOption({
      geometry,
      channel: active,
      highlightDistanceM: readoutAt,
    }) as EChartsOption & { tooltip?: Record<string, unknown> };
    // The tooltip formatter is the one hover callback reachable without widening
    // `EChart`'s props (§5.0 allows exactly one edit to that file, for VisualMap).
    // Publishing is deferred to a microtask so it never runs inside a render pass.
    base.tooltip = {
      ...(base.tooltip ?? {}),
      formatter: (p: unknown) => {
        const v = (p as { value?: number[] }).value;
        if (!v) return "";
        const d = v[3];
        queueMicrotask(() => {
          setHovered(d);
          onHoverDistance?.(d);
        });
        return `${Math.round(d)} m · ${v[2]}${CHANNEL_UNIT[active]}`;
      },
    };
    return base as EChartsOption;
  }, [geometry, active, readoutAt, onHoverDistance]);

  // The readout under the map: `T7 · 184 km/h · 3rd · brake` (§5.1).
  const readout = useMemo(() => {
    if (readoutAt == null || geometry.pts.length === 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < geometry.pts.length; i++) {
      const d = Math.abs(geometry.pts[i][3] - readoutAt);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let nearestCorner: string | null = null;
    let cornerD = Infinity;
    for (const c of corners) {
      const d = Math.abs(c.distanceM - readoutAt);
      if (d < cornerD) {
        cornerD = d;
        nearestCorner = `T${c.cornerNumber}${c.cornerLetter}`;
      }
    }
    const parts = [
      cornerD <= 120 && nearestCorner ? nearestCorner : `${Math.round(readoutAt)} m`,
      `${lap.speedKph[best]} km/h`,
      ordinal(lap.gear[best]),
    ];
    if (lap.brake[best]) parts.push("brake");
    else if (lap.throttlePct[best] >= 99) parts.push("full throttle");
    return parts.join(" · ");
  }, [readoutAt, geometry, corners, lap]);

  return (
    <div className={className}>
      <div role="group" aria-label="track map channel" style={{ display: "flex", gap: 8 }}>
        {TRACK_CHANNELS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            aria-pressed={c.key === active}
            style={{
              background: c.key === active ? PALETTE.raised : "transparent",
              color: c.key === active ? PALETTE.fg : PALETTE.muted,
              border: `1px solid ${PALETTE.grid}`,
              borderRadius: 4,
              padding: "2px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/*
        §5.1: the CONTAINER becomes the shape of the circuit, rather than the circuit
        becoming the shape of the container. `max-width` (not `max-height`) enforces the
        70vh bound, because a `max-height` on an `aspect-ratio` box is resolved by
        distorting it — which is the exact failure this rule exists to prevent.
      */}
      <div
        style={{
          width: "100%",
          aspectRatio: `${geometry.box.aspect}`,
          maxWidth: `calc(70vh * ${geometry.box.aspect})`,
          margin: "0 auto",
        }}
      >
        <EChart
          option={option}
          height="100%"
          ariaLabel={`Track map of ${lap.code}'s lap, painted by ${active}`}
          notMerge
        />
      </div>
      <p
        style={{ color: PALETTE.muted, fontFamily: "var(--font-mono)", fontSize: 12 }}
        aria-live="polite"
      >
        {readout ?? "hover the map to read the car's state at a point on the road"}
      </p>
    </div>
  );
}
