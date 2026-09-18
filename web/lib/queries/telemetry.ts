// TELEMETRY_SPEC v1.7 §5.5 — the one telemetry query module. Drizzle in the existing
// style: every function is async, takes primitives from the route and returns plain
// JSON-serialisable objects. Nothing here computes analytics; every number except the
// alignment (which is `lib/telemetry/align.ts`, and is a comparison, not a stored fact)
// is selected from a table `f1lab.telemetry` wrote.
//
// EVERY SIGNATURE TAKES EXACTLY ONE `sessionId`. Cross-session comparison therefore has
// no callable shape — §6.4's honesty enforced by the type system rather than by a
// footer. Do not add a second session parameter to any function in this file.
//
// T5: `distanceM` is CHORD distance. There is no integrated-distance column to select.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  circuitCorners,
  circuitLayout,
  drivers,
  events,
  lapCornerSpeeds,
  laps,
  lapTelemetry,
  lapTelemetrySummary,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
} from "@/db/schema";
import type { LineStyle } from "@/lib/queries/shared";
import { TEAM_FALLBACK } from "@/lib/theme";
import { TRAIL_STATUSES, type TrailStatus } from "@/lib/telemetry/captions";

/** §5.6 — the five states of `analytics_status['telemetry']['state']`, plus "absent". */
export type TelemetryState = "absent" | "ok" | "partial" | "none" | "failed" | "dropped";

export type SessionKind = "R" | "S" | "Q" | "SQ";

/** One driver pill (§5.5). The four fields that decide whether a comparison is fair. */
export type TelemetryLapPill = {
  driverId: string;
  code: string;
  fullName: string;
  teamId: string;
  teamName: string;
  colour: string;
  lineStyle: LineStyle;
  /** False for a driver with no stored lap: listed greyed with `reason`, never omitted. */
  hasTelemetry: boolean;
  /** Why there is no trace, when there is none (§3.6). Null when there is one. */
  reason: string | null;
  lapNumber: number | null;
  lapTimeS: number | null;
  compound: string | null;
  tyreLife: number | null;
  topSpeedKph: number | null;
  nSamples: number | null;
};

export type TelemetryPicker = {
  sessionId: number;
  year: number;
  round: number;
  eventName: string;
  kind: SessionKind;
  state: TelemetryState;
  /** T10: the second pill, and the delta trace, exist only on Q/SQ. */
  allowsCrossDriver: boolean;
  nWithTelemetry: number;
  nEntered: number;
  pills: TelemetryLapPill[];
};

function asState(v: unknown): TelemetryState {
  if (v && typeof v === "object" && "state" in v) {
    const s = (v as { state?: unknown }).state;
    if (s === "ok" || s === "partial" || s === "none" || s === "failed" || s === "dropped") {
      return s;
    }
  }
  // §3.6 writes an object; a bare string is tolerated rather than crashing the tab.
  if (v === "ok" || v === "partial" || v === "none" || v === "failed" || v === "dropped") {
    return v;
  }
  return "absent";
}

function asKind(v: string): SessionKind {
  return v === "Q" || v === "SQ" || v === "S" ? v : "R";
}

/**
 * The picker (§5.5): every driver who started the session, with their stored lap if
 * there is one and the reason if there is not. Two pills on Q/SQ, one on R — the
 * caller decides, from `allowsCrossDriver`.
 */
export async function listTelemetryLaps(sessionId: number): Promise<TelemetryPicker | null> {
  const head = await db
    .select({
      sessionId: sessions.sessionId,
      year: sessions.year,
      round: sessions.round,
      kind: sessions.kind,
      eventName: events.eventName,
      analyticsStatus: sessionIngests.analyticsStatus,
    })
    .from(sessions)
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .leftJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  if (head.length === 0) return null;
  const h = head[0];
  const kind = asKind(h.kind);

  const rows = await db
    .select({
      driverId: sessionEntries.driverId,
      code: sessionEntries.code,
      fullName: drivers.fullName,
      teamId: sessionEntries.teamId,
      teamName: sessionTeams.teamName,
      colour: sessionTeams.colour,
      lineStyle: sessionEntries.lineStyle,
      lapNumber: lapTelemetrySummary.lapNumber,
      nSamples: lapTelemetrySummary.nSamples,
      topSpeedKph: lapTelemetrySummary.topSpeedKph,
      lapTimeS: laps.lapTimeS,
      compound: laps.compound,
      tyreLife: laps.tyreLife,
    })
    .from(sessionEntries)
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .leftJoin(
      lapTelemetrySummary,
      and(
        eq(lapTelemetrySummary.sessionId, sessionEntries.sessionId),
        eq(lapTelemetrySummary.driverId, sessionEntries.driverId),
      ),
    )
    .leftJoin(
      laps,
      and(
        eq(laps.sessionId, lapTelemetrySummary.sessionId),
        eq(laps.driverId, lapTelemetrySummary.driverId),
        eq(laps.lapNumber, lapTelemetrySummary.lapNumber),
      ),
    )
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.code));

  const state = asState(
    (h.analyticsStatus as Record<string, unknown> | null)?.["telemetry"],
  );
  const noLapReason =
    state === "absent"
      ? "the telemetry pass has not been run for this session"
      : state === "failed"
        ? "the telemetry fetch failed for this session"
        : state === "dropped"
          ? "telemetry was dropped by a re-ingest and the cache was gone"
          : "no lap of this driver's met the stored-lap rule";

  const pills: TelemetryLapPill[] = rows.map((r) => ({
    driverId: r.driverId,
    code: r.code,
    fullName: r.fullName,
    teamId: r.teamId,
    teamName: r.teamName ?? r.teamId,
    colour: r.colour ?? TEAM_FALLBACK,
    lineStyle: (r.lineStyle as LineStyle) ?? "solid",
    hasTelemetry: r.lapNumber !== null,
    reason: r.lapNumber !== null ? null : noLapReason,
    lapNumber: r.lapNumber,
    lapTimeS: r.lapTimeS,
    compound: r.compound,
    tyreLife: r.tyreLife,
    topSpeedKph: r.topSpeedKph,
    nSamples: r.nSamples,
  }));

  return {
    sessionId: h.sessionId,
    year: h.year,
    round: h.round,
    eventName: h.eventName,
    kind,
    state,
    // T10: a race lap cannot support a cross-driver comparison, so the control is
    // ABSENT on R/S rather than disabled.
    allowsCrossDriver: kind === "Q" || kind === "SQ",
    nWithTelemetry: pills.filter((p) => p.hasTelemetry).length,
    nEntered: pills.length,
    pills,
  };
}

/** One stored lap: the arrays, the derived scalars, and the circuit it was set on. */
export type StoredLapTelemetry = {
  sessionId: number;
  driverId: string;
  code: string;
  colour: string;
  lineStyle: LineStyle;
  lapNumber: number;
  lapTimeS: number | null;
  /** `laps.sector1_s` and `sector1_s + sector2_s`, cumulative from the lap start. */
  s1TimeS: number | null;
  s2TimeS: number | null;
  compound: string | null;
  tyreLife: number | null;
  nSamples: number;
  maxSampleGapM: number;
  trackLengthM: number;
  /** T5 — CHORD distance in metres, `[0] = 0`. Never FastF1's integrated Distance. */
  distanceM: number[];
  timeS: number[];
  /** Raw, unrotated FastF1 position units; rotated in the browser (§0.3). */
  x: number[];
  y: number[];
  speedKph: number[];
  throttlePct: number[];
  brake: boolean[];
  gear: number[];
  /** Raw DRS codes. Measured flat (all 0) on every lap of 2026 R13 Q — see §6.5. */
  drs: number[];
  summary: {
    topSpeedKph: number;
    minSpeedKph: number;
    fullThrottlePct: number;
    brakePct: number;
    liftPct: number;
    overlapPct: number;
    nBrakeZones: number;
    nGearChanges: number;
    /** NULL when the DRS channel was flat. Absent is not zero (§6.5). */
    drsDistanceM: number | null;
    s1DistanceM: number | null;
    s2DistanceM: number | null;
    nGapsOver50M: number;
  } | null;
  circuit: {
    circuitKey: number;
    year: number;
    /** Applied in the browser: x' = x cos0 - y sin0. Measured 95.0 for 2026 R13. */
    rotationDeg: number;
    nCorners: number;
    trackLengthM: number;
    corners: Array<{
      cornerNumber: number;
      cornerLetter: string;
      x: number;
      y: number;
      angleDeg: number | null;
      distanceM: number;
    }>;
  } | null;
};

/** §5.5 — one lap, one primary-key lookup. Whole-lap read; arrays are never sliced in SQL. */
export async function getLapTelemetry(
  sessionId: number,
  driverId: string,
): Promise<StoredLapTelemetry | null> {
  const rows = await db
    .select({
      t: lapTelemetry,
      s: lapTelemetrySummary,
      code: sessionEntries.code,
      lineStyle: sessionEntries.lineStyle,
      colour: sessionTeams.colour,
      lapTimeS: laps.lapTimeS,
      sector1S: laps.sector1S,
      sector2S: laps.sector2S,
      compound: laps.compound,
      tyreLife: laps.tyreLife,
      year: sessions.year,
      circuitKey: events.circuitKey,
    })
    .from(lapTelemetry)
    .innerJoin(sessions, eq(sessions.sessionId, lapTelemetry.sessionId))
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .leftJoin(
      lapTelemetrySummary,
      and(
        eq(lapTelemetrySummary.sessionId, lapTelemetry.sessionId),
        eq(lapTelemetrySummary.driverId, lapTelemetry.driverId),
        eq(lapTelemetrySummary.lapNumber, lapTelemetry.lapNumber),
      ),
    )
    .leftJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, lapTelemetry.sessionId),
        eq(sessionEntries.driverId, lapTelemetry.driverId),
      ),
    )
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .leftJoin(
      laps,
      and(
        eq(laps.sessionId, lapTelemetry.sessionId),
        eq(laps.driverId, lapTelemetry.driverId),
        eq(laps.lapNumber, lapTelemetry.lapNumber),
      ),
    )
    .where(and(eq(lapTelemetry.sessionId, sessionId), eq(lapTelemetry.driverId, driverId)))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];

  let circuit: StoredLapTelemetry["circuit"] = null;
  if (r.circuitKey !== null) {
    const layout = await db
      .select()
      .from(circuitLayout)
      .where(and(eq(circuitLayout.circuitKey, r.circuitKey), eq(circuitLayout.year, r.year)))
      .limit(1);
    if (layout.length > 0) {
      const corners = await db
        .select()
        .from(circuitCorners)
        .where(and(eq(circuitCorners.circuitKey, r.circuitKey), eq(circuitCorners.year, r.year)))
        .orderBy(asc(circuitCorners.distanceM));
      circuit = {
        circuitKey: layout[0].circuitKey,
        year: layout[0].year,
        rotationDeg: layout[0].rotationDeg,
        nCorners: layout[0].nCorners,
        trackLengthM: layout[0].trackLengthM,
        corners: corners.map((c) => ({
          cornerNumber: c.cornerNumber,
          cornerLetter: c.cornerLetter,
          x: c.x,
          y: c.y,
          angleDeg: c.angleDeg,
          distanceM: c.distanceM,
        })),
      };
    }
  }

  const s2TimeS =
    r.sector1S !== null && r.sector2S !== null ? r.sector1S + r.sector2S : null;

  return {
    sessionId: r.t.sessionId,
    driverId: r.t.driverId,
    code: r.code ?? r.t.driverId,
    colour: r.colour ?? TEAM_FALLBACK,
    lineStyle: (r.lineStyle as LineStyle) ?? "solid",
    lapNumber: r.t.lapNumber,
    lapTimeS: r.lapTimeS,
    s1TimeS: r.sector1S,
    s2TimeS,
    compound: r.compound,
    tyreLife: r.tyreLife,
    nSamples: r.t.nSamples,
    maxSampleGapM: r.t.maxSampleGapM,
    trackLengthM: r.t.trackLengthM,
    distanceM: r.t.distanceM,
    timeS: r.t.timeS,
    x: r.t.x,
    y: r.t.y,
    speedKph: r.t.speedKph,
    throttlePct: r.t.throttlePct,
    brake: r.t.brake,
    gear: r.t.gear,
    drs: r.t.drs,
    summary: r.s
      ? {
          topSpeedKph: r.s.topSpeedKph,
          minSpeedKph: r.s.minSpeedKph,
          fullThrottlePct: r.s.fullThrottlePct,
          brakePct: r.s.brakePct,
          liftPct: r.s.liftPct,
          overlapPct: r.s.overlapPct,
          nBrakeZones: r.s.nBrakeZones,
          nGearChanges: r.s.nGearChanges,
          drsDistanceM: r.s.drsDistanceM,
          s1DistanceM: r.s.s1DistanceM,
          s2DistanceM: r.s.s2DistanceM,
          nGapsOver50M: r.s.nGapsOver50M,
        }
      : null,
    circuit,
  };
}

export type CornerSpeedRow = {
  driverId: string;
  lapNumber: number;
  cornerNumber: number;
  cornerLetter: string;
  apexSpeedKph: number;
  apexDistanceM: number;
  entrySpeedKph: number;
  exitSpeedKph: number;
  brakeZoneIdx: number | null;
  brakePointM: number | null;
  brakeDistanceM: number | null;
  throttlePointM: number | null;
  timeInCornerS: number;
  // ---- GAPFILL §4.1 / §5.2 — the brake-shape readings.
  /** Where the brake came off, in lap distance. NULL on every non-`measured` row. */
  brakeReleaseM: number | null;
  /** apex - release. NEGATIVE means the brake was still on at the apex (C-BRK-1). */
  brakeReleaseToApexM: number | null;
  /** release - onset: how long the pedal was down. */
  brakeOnDistanceM: number | null;
  /**
   * One of the six words of migration 0010's CHECK. §4.1: the blank cell must say WHICH
   * of six things happened, so the reason travels as a value and the component never
   * infers it from a NULL.
   */
  trailStatus: TrailStatus;
};

/**
 * §5.5 — the corner report card for one or two drivers OF THE SAME SESSION (§6.4).
 *
 * The column list is EXPLICIT, not `select()`. GAPFILL §4.4.3 says `trail_duty` is not
 * exposed to the ask box and appears on no page; naming the columns is what makes that
 * structural here, the same way excluding it from `ask.lap_corner_speeds` makes it
 * structural for the model. A `select()` would pull it into the page's props and leave
 * the restriction resting on nobody rendering it.
 */
export async function getCornerSpeeds(
  sessionId: number,
  driverIds: string[],
): Promise<CornerSpeedRow[]> {
  if (driverIds.length === 0) return [];
  const rows = await db
    .select({
      driverId: lapCornerSpeeds.driverId,
      lapNumber: lapCornerSpeeds.lapNumber,
      cornerNumber: lapCornerSpeeds.cornerNumber,
      cornerLetter: lapCornerSpeeds.cornerLetter,
      apexSpeedKph: lapCornerSpeeds.apexSpeedKph,
      apexDistanceM: lapCornerSpeeds.apexDistanceM,
      entrySpeedKph: lapCornerSpeeds.entrySpeedKph,
      exitSpeedKph: lapCornerSpeeds.exitSpeedKph,
      brakeZoneIdx: lapCornerSpeeds.brakeZoneIdx,
      brakePointM: lapCornerSpeeds.brakePointM,
      brakeDistanceM: lapCornerSpeeds.brakeDistanceM,
      throttlePointM: lapCornerSpeeds.throttlePointM,
      timeInCornerS: lapCornerSpeeds.timeInCornerS,
      brakeReleaseM: lapCornerSpeeds.brakeReleaseM,
      brakeReleaseToApexM: lapCornerSpeeds.brakeReleaseToApexM,
      brakeOnDistanceM: lapCornerSpeeds.brakeOnDistanceM,
      trailStatus: lapCornerSpeeds.trailStatus,
      // trail_duty is deliberately absent — §4.4.3 / D5, an unrendered diagnostic.
    })
    .from(lapCornerSpeeds)
    .where(
      and(
        eq(lapCornerSpeeds.sessionId, sessionId),
        inArray(lapCornerSpeeds.driverId, driverIds),
      ),
    )
    .orderBy(asc(lapCornerSpeeds.cornerNumber), asc(lapCornerSpeeds.cornerLetter));
  return rows.map((c) => ({
    driverId: c.driverId,
    lapNumber: c.lapNumber,
    cornerNumber: c.cornerNumber,
    cornerLetter: c.cornerLetter,
    apexSpeedKph: c.apexSpeedKph,
    apexDistanceM: c.apexDistanceM,
    entrySpeedKph: c.entrySpeedKph,
    exitSpeedKph: c.exitSpeedKph,
    brakeZoneIdx: c.brakeZoneIdx,
    brakePointM: c.brakePointM,
    brakeDistanceM: c.brakeDistanceM,
    throttlePointM: c.throttlePointM,
    timeInCornerS: c.timeInCornerS,
    brakeReleaseM: c.brakeReleaseM,
    brakeReleaseToApexM: c.brakeReleaseToApexM,
    brakeOnDistanceM: c.brakeOnDistanceM,
    // The CHECK on lap_corner_speeds closes this to six words, so a value outside the
    // union means the database was changed without the card being told. Narrowed once,
    // here, rather than cast at every call site.
    trailStatus: asTrailStatus(c.trailStatus),
  }));
}

/**
 * Migration 0010's CHECK guarantees this, but a CHECK lives in the database and this is
 * the boundary where a row becomes a typed object. An unknown word is reported as
 * `too_few_samples` — a named refusal the card can render — rather than thrown, because
 * one unexpected status should not blank a whole circuit's corner card; the console
 * line is what makes it visible.
 */
function asTrailStatus(v: string): TrailStatus {
  if ((TRAIL_STATUSES as readonly string[]).includes(v)) return v as TrailStatus;
  console.warn(`getCornerSpeeds: unknown trail_status ${JSON.stringify(v)}`);
  return "too_few_samples";
}
