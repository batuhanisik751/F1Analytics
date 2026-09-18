"use client";
// TELEMETRY_SPEC v1.7 §5.2 — V2, the two-driver delta trace. The flagship, and §8's R6:
// the product risk here is larger than any technical one. The chart is beautiful, it is
// about two named people, and it invites exactly the conclusion it cannot support.
//
// Four guards are built into this component rather than written under it (§6.4):
//
//   1. T10 — on any session that is not Q/SQ this component returns the C-TEL-5 notice and
//      NO CHART. An absent feature with a stated reason, not a disabled button.
//   2. The chart computes its own closure error and REFUSES to render above 400 ms
//      (§5.2.2). Not a warning badge on a drawn chart — the chart is not drawn.
//   3. The y-axis is zero-centred and symmetric, always, so the chart cannot exaggerate
//      itself: a 0.05 s gap on a free-scaled axis looks like a chasm.
//   4. A is solid and B is dashed, always (§5.0), so a teammate pair — the default pair,
//      whose two team colours are identical — is still legible.
//
// Alignment is NOT re-implemented here. Every number on this chart comes from
// `lib/telemetry/align.ts`, whose `chordLap` re-derives the chord from the row's own
// (x, y) and throws on anything that is not chord distance (T5).
//
// Imports `EChart` and nothing else from the charting stack (SPEC §3.4 / §5.0).
import { useMemo } from "react";
import EChart, { type EChartsOption } from "./EChart";
import { PALETTE } from "@/lib/theme";
import {
  alignLaps,
  chordLap,
  closureCheck,
  gapIntervals,
  symmetricBoundS,
  CLOSURE_REFUSE_MS,
  type AlignedDelta,
  type ChordLap,
  type ClosureCheck,
} from "@/lib/telemetry/align";
import { C_TEL_1, C_TEL_5, cTel2 } from "@/lib/telemetry/captions";

/**
 * One lap, as this component needs it. Structurally satisfied by
 * `StoredLapTelemetry` from `lib/queries/telemetry.ts` plus the driver's colour —
 * declared here rather than imported so a client component never reaches a query module.
 */
export type DeltaTraceLap = {
  code: string;
  /** The driver's team colour from the database (§5.0 — never a fixed palette). */
  colour: string;
  /** Raw, unrotated FastF1 position units (§0.3). `chordLap` re-derives the chord from these. */
  x: readonly number[];
  y: readonly number[];
  /** T5 — `lap_telemetry.distance_m`, chord metres, `[0] = 0`. */
  distanceM: readonly number[];
  /** Seconds from the lap's first sample, `[0] = 0`. */
  timeS: readonly number[];
  /**
   * `laps.lap_time_s`. The OFFICIAL gap is A − B and is what the chart labels (§5.2.3).
   * NULL is a real state in `laps` — and with no official gap there is nothing for the
   * closure check to close against, so the trace is not drawn.
   */
  lapTimeS: number | null;
  /** `laps.sector1_s` and `sector1_s + sector2_s`, cumulative from the lap start. */
  s1TimeS?: number | null;
  s2TimeS?: number | null;
  /** `lap_telemetry_summary` — the sector-boundary CHORD distances (§4.1 stores them for this). */
  summary?: {
    s1DistanceM: number | null;
    s2DistanceM: number | null;
  } | null;
};

export type DeltaTraceCorner = {
  cornerNumber: number;
  cornerLetter: string;
  /** Chord metres on the reference lap (`circuit_corners.distance_m`). */
  distanceM: number;
};

/** The chart's own measurements, handed to the caption layer for §6.3's `{…}` slots. */
export type DeltaTraceFacts = {
  codeA: string;
  codeB: string;
  /** `|delta(s_end) − (lap_time_A − lap_time_B)|`, milliseconds, rounded. C-TEL-2's `{closure_ms}`. */
  closureMs: number;
  /**
   * The WORST sector-boundary residual in milliseconds, rounded — C-TEL-2's `{sector_ms}`.
   * `null` when the sector inputs are absent: never fabricated, and the caption layer is
   * expected to drop that clause rather than print a zero it did not measure (§0.3).
   */
  sectorMs: number | null;
  /** C-TEL-2's `{n_gaps}` — stretches of ≥ 50 m with no measurement in them. */
  nGaps: number;
  /** `lap_time_A − lap_time_B` from `laps`, seconds. Signed: negative means A was quicker. */
  officialGapS: number;
  /** §5.2.2's relative rule: the caption LEADS with the half-gap sentence when true. */
  errorExceedsHalfGap: boolean;
  /** Metres of the longer lap left off the common axis. Reported, never hidden. */
  trimmedM: number;
};

/**
 * Every shipped string on this chart lives in `lib/telemetry/captions.ts` (§6.3), where
 * "verbatim" is mechanically enforced by a drift test. This component holds no prose of
 * its own beyond the §5.2.2 refusal line, which §6.3 does not number — and even that is
 * overridable, so there is exactly one place to change what this chart says.
 */
export type DeltaTraceCaptions = {
  /** C-TEL-1 — unconditional, ABOVE the chart, never in a footer. */
  intro?: string;
  /** C-TEL-2 — computed per pair from the facts the chart measured about itself. */
  closure?: (facts: DeltaTraceFacts) => string;
  /** §5.2.2, > 400 ms: the one line shown INSTEAD of the chart. */
  cannotAlign?: string;
  /** C-TEL-5 — on a session that is not Q/SQ, where the chart would otherwise be (T10). */
  notOnRace?: string;
};

/** What the component decided to do, before any of it is drawn. */
export type DeltaTraceModel =
  /** T10 — not Q/SQ. There is no chart and no second-driver control anywhere. */
  | { kind: "absent"; sessionKind: string }
  /**
   * The pair could not be put on a common axis at all: `chordLap` rejected an array that
   * is not the chord length of its own (x, y) (T5), the rows are ragged, or a lap has no
   * official time to close against. Reported, never drawn around.
   */
  | { kind: "unaligned"; reason: string }
  /** §5.2.2 — closure error > 400 ms. The trace is not drawn at all. */
  | { kind: "refused"; facts: DeltaTraceFacts; closure: ClosureCheck }
  | {
      kind: "chart";
      facts: DeltaTraceFacts;
      closure: ClosureCheck;
      aligned: AlignedDelta;
      lapA: ChordLap;
      lapB: ChordLap;
      gaps: Array<[number, number]>;
      /** The symmetric y bound: the axis is [−boundS, +boundS], always. */
      boundS: number;
    };

/** T10 — the cross-driver delta exists on qualifying sessions and nowhere else. */
export function allowsCrossDriver(sessionKind: string): boolean {
  return sessionKind === "Q" || sessionKind === "SQ";
}

/**
 * The whole decision, as a pure function, so both guards can be tested without a DOM:
 * T10 first (there is nothing to compute on a race lap), then the closure check, and only
 * then a chart. Nothing here is rendered — this returns what MAY be rendered.
 */
export function deltaTraceModel(
  sessionKind: string,
  a: DeltaTraceLap,
  b: DeltaTraceLap,
): DeltaTraceModel {
  if (!allowsCrossDriver(sessionKind)) return { kind: "absent", sessionKind };

  if (a.lapTimeS == null || b.lapTimeS == null) {
    const who = a.lapTimeS == null ? a.code : b.code;
    return { kind: "unaligned", reason: `${who} has no official lap time to close against` };
  }

  let lapA: ChordLap;
  let lapB: ChordLap;
  let aligned: AlignedDelta;
  let closure: ClosureCheck;
  try {
    // T5 is enforced here, not documented: `chordLap` re-derives the chord from (x, y) and
    // throws `NotChordDistanceError` on an integrated or normalised axis.
    lapA = chordLap(a);
    lapB = chordLap(b);
    aligned = alignLaps(lapA, lapB);
    closure = closureCheck(aligned, lapA, lapB, {
      lapTimeAS: a.lapTimeS,
      lapTimeBS: b.lapTimeS,
      s1DistanceAM: a.summary?.s1DistanceM ?? null,
      s1DistanceBM: b.summary?.s1DistanceM ?? null,
      s2DistanceAM: a.summary?.s2DistanceM ?? null,
      s2DistanceBM: b.summary?.s2DistanceM ?? null,
      s1TimeAS: a.s1TimeS,
      s1TimeBS: b.s1TimeS,
      s2TimeAS: a.s2TimeS,
      s2TimeBS: b.s2TimeS,
    });
  } catch (e) {
    return { kind: "unaligned", reason: e instanceof Error ? e.message : String(e) };
  }

  const gaps = gapIntervals([lapA, lapB]).filter(([from]) => from <= aligned.sEndM);
  const worstSector = closure.sectors.reduce<number | null>(
    (worst, s) => Math.max(worst ?? 0, Math.abs(s.residualS) * 1000),
    closure.sectors.length > 0 ? 0 : null,
  );

  const facts: DeltaTraceFacts = {
    codeA: lapA.code,
    codeB: lapB.code,
    closureMs: Math.round(closure.closureErrorS * 1000),
    sectorMs: worstSector === null ? null : Math.round(worstSector),
    nGaps: gaps.length,
    officialGapS: closure.officialGapS,
    errorExceedsHalfGap: closure.errorExceedsHalfGap,
    trimmedM: aligned.trimmedM,
  };

  // §5.2.2: above 400 ms the trace is not drawn. The map and the stack still are — this
  // component simply has nothing to contribute about where the time went.
  if (!closure.render) return { kind: "refused", facts, closure };

  return {
    kind: "chart",
    facts,
    closure,
    aligned,
    lapA,
    lapB,
    gaps,
    boundS: symmetricBoundS(aligned.deltaS),
  };
}

/**
 * §5.2.3 — the y-axis is annotated with DRIVER CODES at both ends, never with the word
 * "delta", so nobody has to remember a sign convention.
 *
 * ECharts rotates a `nameLocation: 'middle'` y-axis name so the string reads bottom-to-top:
 * the first token sits at the BOTTOM of the axis, the last at the TOP. Under §0.3's sign,
 * `delta > 0` (the top) means A took MORE time to reach `s` — so the TOP is where B is
 * ahead and the BOTTOM is where A is ahead. This is also what §5.2.3's fill rule says in
 * colour: B's team colour above zero, A's below.
 *
 * DEVIATION, reported rather than copied: §5.2.3's literal string is
 * `<- ${codeB} ahead        ${codeA} ahead ->`, which puts A at the top and therefore
 * contradicts both §0.3's sign convention and §5.2.3's own fill rule. The format is kept
 * and the two codes are ordered so the axis is true.
 */
export function deltaAxisName(codeA: string, codeB: string): string {
  return `<- ${codeA} ahead        ${codeB} ahead ->`;
}

/** The right-hand edge label: the OFFICIAL gap from `laps`, not the trace's own endpoint. */
export function officialGapLabel(facts: DeltaTraceFacts): string {
  const g = facts.officialGapS;
  const quicker = g < 0 ? facts.codeA : facts.codeB;
  return `${quicker} quicker by ${Math.abs(g).toFixed(3)}s`;
}

export type DeltaOptionInput = {
  model: Extract<DeltaTraceModel, { kind: "chart" }>;
  colourA: string;
  colourB: string;
  corners: readonly DeltaTraceCorner[];
};

/**
 * §5.2.3's option, built as a pure function so the encoding rules can be asserted without
 * a browser: the symmetric y-axis, the split-at-zero fill, the corner rules, the shaded
 * sample gaps and the official-gap label.
 */
export function buildDeltaOption(input: DeltaOptionInput): EChartsOption {
  const { model, colourA, colourB, corners } = input;
  const { aligned, boundS, facts, gaps } = model;
  const { s, deltaS, sEndM } = aligned;

  // §5.2.3 — "the same trace, clipped": one series carries the area above zero in B's
  // colour, the other the area below zero in A's, so colour reads as WHO IS AHEAD without
  // reading the axis. The fg line of the two together is the whole trace.
  const deltaPos: Array<[number, number]> = s.map((v, i) => [v, Math.max(deltaS[i], 0)]);
  const deltaNeg: Array<[number, number]> = s.map((v, i) => [v, Math.min(deltaS[i], 0)]);

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

  return {
    animation: false,
    grid: { left: 64, right: 24, top: 16, bottom: 64 },
    tooltip: { trigger: "axis", axisPointer: { type: "line" } },
    xAxis: {
      type: "value",
      min: 0,
      max: sEndM,
      name: "distance (m)",
      nameLocation: "middle",
      nameGap: 28,
      axisPointer: {
        show: true,
        snap: false,
        label: { formatter: (p: { value: number | string }) => `${Number(p.value) | 0} m` },
      },
    },
    yAxis: {
      type: "value",
      // ZERO-CENTRED AND SYMMETRIC, ALWAYS (§5.2.3). A free-scaled y-axis on a delta chart
      // makes a 0.05 s gap look like a chasm; this is the encoding rule that stops the
      // chart exaggerating itself, and it is the reason R6 is survivable.
      min: -boundS,
      max: boundS,
      name: deltaAxisName(facts.codeA, facts.codeB),
      nameLocation: "middle",
      nameGap: 46,
      nameTextStyle: { color: PALETTE.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: PALETTE.grid, opacity: 0.4 } },
      axisLabel: {
        formatter: (v: number) => (v > 0 ? "+" : "") + v.toFixed(2) + "s",
      },
    },
    series: [
      {
        type: "line",
        name: facts.codeA,
        data: deltaPos,
        showSymbol: false,
        smooth: false,
        z: 3,
        // §5.2.3: BOTH halves carry the same fg line, because there is only one line on
        // this chart — the delta. §5.0's solid/dashed rule is about two per-driver series
        // and is applied in `ChannelStack`, where two teammates' identical team colour
        // would otherwise be illegible. Here the two drivers are told apart by POSITION
        // (above zero / below zero) and by the codes on the axis.
        lineStyle: { width: 2, color: PALETTE.fg, type: "solid" },
        areaStyle: { origin: 0, opacity: 0.22, color: colourB },
        markLine: {
          silent: true,
          symbol: "none",
          data: [
            // The zero line is the ONLY solid horizontal rule on this chart, because it is
            // the only one that means anything: level at this point on the road.
            { yAxis: 0, lineStyle: { color: PALETTE.muted, width: 1, type: "solid" as const } },
            ...cornerLines,
            {
              // §5.2.3 — the right-hand edge carries the OFFICIAL gap from `laps`, not the
              // trace's own endpoint. When they disagree the official number is the one
              // shown, and the difference IS the closure error the caption prints.
              xAxis: sEndM,
              lineStyle: { color: PALETTE.grid, width: 1, type: "solid" as const },
              label: {
                show: true,
                formatter: officialGapLabel(facts),
                position: "insideEndTop" as const,
                color: PALETTE.fg,
                fontSize: 11,
              },
            },
          ],
        },
        markArea: {
          silent: true,
          itemStyle: { color: "rgba(139,139,151,0.10)" },
          // Interpolated — no measurement here. Without this the single largest artifact in
          // the data is invisible: the worst apparent swing sits where samples are thinnest.
          data: gaps.map(([from, to]) => [{ xAxis: from }, { xAxis: Math.min(to, sEndM) }]),
        },
      },
      {
        type: "line",
        name: facts.codeB,
        data: deltaNeg,
        showSymbol: false,
        smooth: false,
        z: 3,
        lineStyle: { width: 2, color: PALETTE.fg, type: "solid" },
        areaStyle: { origin: 0, opacity: 0.22, color: colourA },
      },
    ],
    // filterMode 'none': filtering would re-baseline the trace to the zoom window, which is
    // a silent lie — the cumulative delta at 3 km is not zero just because you zoomed there.
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, filterMode: "none", bottom: 8, height: 18 },
    ],
  } as EChartsOption;
}

export type DeltaTraceProps = {
  /** T10 — `"Q"` / `"SQ"` draw a chart; every other kind returns C-TEL-5 and nothing else. */
  sessionKind: string;
  lapA: DeltaTraceLap;
  lapB: DeltaTraceLap;
  corners?: readonly DeltaTraceCorner[];
  /**
   * Overrides for the four strings. Defaults come from `lib/telemetry/captions.ts` so the
   * drift test there is the single source of truth (§6.3).
   */
  captions?: DeltaTraceCaptions;
  /**
   * C-TEL-1 above and C-TEL-2 below, drawn BY THIS COMPONENT. Default false, because the
   * telemetry page already prints both around the mount point and a doubled caveat reads
   * as boilerplate — which is exactly how a caveat stops being read (R6). A surface that
   * mounts this chart on its own must turn them on.
   */
  showCaptions?: boolean;
  height?: number | string;
  className?: string;
};

const NOTE_STYLE: React.CSSProperties = {
  color: PALETTE.muted,
  fontSize: 12,
  lineHeight: 1.5,
  margin: "8px 0 0",
  maxWidth: "72ch",
};

/** §5.2.2's refusal line. Not one of §6.3's eight numbered captions; overridable. */
export const DELTA_REFUSAL =
  "These two laps cannot be aligned closely enough to say where the time went.";

function closureCaption(facts: DeltaTraceFacts): string {
  return cTel2({
    closureErrorS: facts.closureMs / 1000,
    worstSectorResidualS: facts.sectorMs === null ? null : facts.sectorMs / 1000,
    nGaps: facts.nGaps,
    errorExceedsHalfGap: facts.errorExceedsHalfGap,
  });
}

export default function DeltaTrace({
  sessionKind,
  lapA,
  lapB,
  corners = [],
  captions,
  showCaptions = false,
  height = 420,
  className,
}: DeltaTraceProps): React.JSX.Element {
  const model = useMemo(
    () => deltaTraceModel(sessionKind, lapA, lapB),
    [sessionKind, lapA, lapB],
  );

  // T10. Not a disabled chart, not an empty axis frame: there is no chart element here at
  // all, and the reason is stated. A race lap cannot support a cross-driver comparison and
  // a caption is a weaker guard than absence (§6.4).
  if (model.kind === "absent") {
    return (
      <div className={className} data-delta-state="absent">
        <p style={NOTE_STYLE}>{captions?.notOnRace ?? C_TEL_5}</p>
      </div>
    );
  }

  if (model.kind === "unaligned") {
    return (
      <div className={className} data-delta-state="unaligned">
        <p style={NOTE_STYLE}>{captions?.cannotAlign ?? DELTA_REFUSAL}</p>
        <p style={{ ...NOTE_STYLE, fontFamily: "var(--font-mono)" }}>{model.reason}</p>
      </div>
    );
  }

  // §5.2.2, > 400 ms. A refusal, not a warning: the map and the stack still render, and
  // this component says only that it cannot tell you where the time went.
  if (model.kind === "refused") {
    return (
      <div className={className} data-delta-state="refused">
        <p style={NOTE_STYLE}>{captions?.cannotAlign ?? DELTA_REFUSAL}</p>
        <p style={{ ...NOTE_STYLE, fontFamily: "var(--font-mono)" }}>
          {`closure error ${model.facts.closureMs} ms against a ${Math.abs(
            model.facts.officialGapS,
          ).toFixed(3)}s gap — past the ${CLOSURE_REFUSE_MS} ms limit this chart refuses at`}
        </p>
      </div>
    );
  }

  return (
    <DeltaTraceChart
      model={model}
      lapA={lapA}
      lapB={lapB}
      corners={corners}
      captions={captions}
      showCaptions={showCaptions}
      height={height}
      className={className}
    />
  );
}

function DeltaTraceChart({
  model,
  lapA,
  lapB,
  corners,
  captions,
  showCaptions,
  height,
  className,
}: {
  model: Extract<DeltaTraceModel, { kind: "chart" }>;
  lapA: DeltaTraceLap;
  lapB: DeltaTraceLap;
  corners: readonly DeltaTraceCorner[];
  captions?: DeltaTraceCaptions;
  showCaptions: boolean;
  height: number | string;
  className?: string;
}): React.JSX.Element {
  const option = useMemo(
    () => buildDeltaOption({ model, colourA: lapA.colour, colourB: lapB.colour, corners }),
    [model, lapA.colour, lapB.colour, corners],
  );
  const { facts } = model;

  return (
    <div className={className} data-delta-state="chart">
      {showCaptions ? (
        <p style={{ ...NOTE_STYLE, margin: "0 0 10px", color: PALETTE.fg }}>
          {captions?.intro ?? C_TEL_1}
        </p>
      ) : null}
      <EChart
        option={option}
        height={height}
        ariaLabel={`Delta trace: ${facts.codeA} against ${facts.codeB}, positive means ${facts.codeA} is behind`}
        notMerge
      />
      {showCaptions ? (
        <p style={NOTE_STYLE}>{(captions?.closure ?? closureCaption)(facts)}</p>
      ) : null}
    </div>
  );
}
