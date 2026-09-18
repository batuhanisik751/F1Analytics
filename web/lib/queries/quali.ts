// QUALI_SPEC v1.6 §6.1 — the one qualifying query module. Drizzle in the existing style:
// every function is async, takes primitives from the route and returns plain
// JSON-serialisable objects. Nothing here computes analytics — every number is selected
// from a table f1lab wrote at ingest — with exactly one exception, the Wilson interval
// (§6.5), which the spec requires be computed here and NEVER stored.
//
// D9: ranking and every cross-circuit aggregate is on percent; seconds only within a
// session. D6: both gaps to pole are carried, and the caller decides which is solid and
// which is ghosted (§6.2 b).
//
// D1 caveat that outlives this file: `laps` is no longer race-only. Nothing in this
// module reads `laps`; anything that does must filter by sessions.kind.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  drivers,
  events,
  qualiResults,
  qualiSegmentTimes,
  qualiTeammateH2h,
  results,
  seasonQualiH2h,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
} from "@/db/schema";
import type { LineStyle } from "@/lib/queries/shared";
import { TEAM_FALLBACK } from "@/lib/theme";

export type QualiSegment = 1 | 2 | 3;
export type QualiKind = "Q" | "SQ";

/** Narrows a stored 1..3 (a CHECK-constrained integer column) to the union type. */
function seg(v: number | null): QualiSegment | null {
  return v === 1 || v === 2 || v === 3 ? v : null;
}

export type QualiRow = {
  driverId: string;
  code: string;
  teamId: string;
  teamName: string;
  colour: string;
  lineStyle: LineStyle;
  position: number;
  q1S: number | null;
  q2S: number | null;
  q3S: number | null;
  bestS: number | null;
  bestSegment: QualiSegment | null;
  segmentsEntered: QualiSegment;
  knockedOutIn: QualiSegment | null;
  setATime: boolean;
  gapToPoleS: number | null;
  gapToPolePct: number | null;
  gapToPoleCommonS: number | null;
  gapToPoleCommonPct: number | null;
  gapToPoleSegment: QualiSegment | null;
  nReprLaps: number;
  pushLaps: number;
};

export type QualiSession = {
  sessionId: number;
  kind: QualiKind;
  name: string;
  startUtc: string | null;
  poleDriverId: string | null;
  poleBestS: number | null;
  segments: QualiSegment[];
  timesSource: "api" | "derived";
  crossSegmentOk: boolean;
  segmentRepairs: number;
  fastestLapDriverId: string | null;
  rows: QualiRow[];
  /**
   * NOT in §6.1's type, and required by §6.6 row 3: a `partial` session has laps and
   * `quali_results` but empty per-segment tables (D8's runtime gate fired). The race page
   * omits the strip and the teammate table on it and shows the one-line note.
   */
  perSegmentAvailable: boolean;
  /**
   * NOT in §6.1's type. The driver-segments where the official time and the lap the
   * driver actually set disagree (`quali_waived_segments` in warnings[]). Without this
   * the result table and the segment strip print two different numbers for the same
   * driver-segment with nothing saying so — measured on 2024 R21 Sao Paulo.
   */
  waivedSegments: { code: string; segment: QualiSegment }[];
};

export type QualiSegmentRow = {
  driverId: string;
  code: string;
  colour: string;
  segment: QualiSegment;
  lapsRun: number;
  reprLaps: number;
  pushLaps: number;
  bestS: number | null;
  gapToBestS: number | null;
  gapToBestPct: number | null;
  spreadS: number | null;
  sdS: number | null;
  compound: string | null;
  tyreLife: number | null;
  wetCompound: boolean;
  /**
   * v1.6 as-built: false when no lap can verify this driver-segment, because the official
   * Qk is a byte-identical copy of another segment's value. `bestS` is then the lap found
   * in that window and it may disagree with the official time in `QualiResultRow` -- at
   * 2024 R21 Sao Paulo by 3.963 s for ALO. An unverified row must never be printed as a
   * measured segment time; the strip renders it struck through with C-QUALI-10 beside it.
   */
  verified: boolean;
};

export type QualiH2HRow = {
  teamId: string;
  teamName: string;
  colour: string;
  driverA: string;
  codeA: string;
  driverB: string;
  codeB: string;
  segment: QualiSegment | null;
  aBestS: number | null;
  bBestS: number | null;
  deltaS: number | null;
  deltaPct: number | null;
  comparable: boolean;
  classifiedAhead: string;
  divergent: boolean;
  belowNoise: boolean;
  sessionSdS: number | null;
};

export type SeasonQualiH2HRow = {
  teamId: string;
  teamName: string;
  colour: string;
  driverA: string;
  codeA: string;
  driverB: string;
  codeB: string;
  kind: QualiKind;
  sessionsCounted: number;
  aWins: number;
  bWins: number;
  deltasCounted: number;
  sessionsCaveated: number;
  medianDeltaS: number | null;
  medianDeltaPct: number | null;
  madDeltaPct: number | null;
  wilsonLow: number;
  wilsonHigh: number;
};

export type QualiToGridRow = {
  driverId: string;
  code: string;
  colour: string;
  qualiPosition: number;
  gridPosition: number;
  placesMoved: number;
};

export type DriverQualiSeason = {
  year: number;
  kind: QualiKind;
  sessions: number;
  poles: number;
  finalSegmentAppearances: number;
  medianGapToPoleCommonPct: number | null;
  bestGapToPoleCommonPct: number | null;
};

export type CircuitQualiHistoryRow = {
  driverId: string;
  code: string;
  colour: string;
  sessions: number;
  medianGapToPoleCommonPct: number | null;
};

// ---------------------------------------------------------------------------
// session_ingests.warnings[] — the only place §4.6's gate and §2.2's repair count live
// ---------------------------------------------------------------------------

/** `quali_cross_segment_ok=<bool>` (§4.6). Absent warnings mean "not known to be bad". */
export function crossSegmentOkFrom(warnings: string[] | null | undefined): boolean {
  const w = warnings?.find((s) => s.startsWith("quali_cross_segment_ok="));
  return w === undefined ? true : !/=false$/i.test(w);
}

/**
 * `quali_waived_segments=<ABBR>:<k>,...` (WP2/WP3's cross-package gap). Names the
 * driver-segments where `quali_results.q<k>_s` (the official time) and
 * `quali_segment_times.best_s` (the lap actually set) DISAGREE. Measured on 2024 R21
 * Sao Paulo: ALO Q2 -3.963 s, ALB Q2 +1.232 s, PIA Q2 +0.493 s. §3.3/§3.4 define no
 * column for it, so `session_ingests.warnings[]` is the only marker in v1.6 and this
 * parser is the only way a surface can avoid printing both numbers unannotated.
 */
export function waivedSegmentsFrom(
  warnings: string[] | null | undefined,
): { code: string; segment: QualiSegment }[] {
  const w = warnings?.find((s) => s.startsWith("quali_waived_segments="));
  if (!w) return [];
  const out: { code: string; segment: QualiSegment }[] = [];
  for (const part of w.slice("quali_waived_segments=".length).split(",")) {
    const [code, k] = part.split(":");
    const s = seg(Number(k));
    if (code && s !== null) out.push({ code: code.trim(), segment: s });
  }
  return out;
}

/** `quali_segment_repairs=<n>` (§2.2 stage 3). > 0 renders the provenance note (§6.2). */
export function segmentRepairsFrom(warnings: string[] | null | undefined): number {
  const w = warnings?.find((s) => s.startsWith("quali_segment_repairs="));
  const n = w ? Number(w.slice("quali_segment_repairs=".length)) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// §6.1 getQualiForRound
// ---------------------------------------------------------------------------

/** Both qualifying sessions of a round, Q first. Empty array when neither is ingested. */
export async function getQualiForRound(year: number, round: number): Promise<QualiSession[]> {
  const heads = await db
    .select({
      sessionId: sessions.sessionId,
      kind: sessions.kind,
      name: sessions.name,
      startUtc: sessions.startUtc,
      status: sessionIngests.status,
      warnings: sessionIngests.warnings,
      analyticsStatus: sessionIngests.analyticsStatus,
    })
    .from(sessions)
    .innerJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .where(
      and(
        eq(sessions.year, year),
        eq(sessions.round, round),
        inArray(sessions.kind, ["Q", "SQ"]),
        inArray(sessionIngests.status, ["ok", "partial"]),
      ),
    );
  if (heads.length === 0) return [];
  // Q first (§6.2). `sessions.kind` is text, so the order is stated, not alphabetical.
  heads.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "Q" ? -1 : 1));

  const ids = heads.map((h) => h.sessionId);
  const [rows, segBests] = await Promise.all([qualiRowsFor(ids), segmentBestsFor(ids)]);

  return heads.map((h) => {
    const mine = rows.filter((r) => r.sessionId === h.sessionId);
    const pole = mine.find((r) => r.row.position === 1) ?? null;
    const entered = mine.reduce((m, r) => Math.max(m, r.row.segmentsEntered), 0);
    const segments: QualiSegment[] = ([1, 2, 3] as const).filter((s) => s <= entered);
    const perSeg = segBests.filter((s) => s.sessionId === h.sessionId);
    const crossSegmentOk = crossSegmentOkFrom(h.warnings);
    // §4.5/C-QUALI-9: `sessions.fastest_pace_driver_id` is DEFINED as the classified P1,
    // so it can never disagree with pole and cannot answer "was the quickest lap pole's?".
    // The quickest comparable lap is the minimum stored per-segment best, and it only
    // means anything when the segments are comparable at all (§4.6).
    let fastestLapDriverId: string | null = null;
    if (crossSegmentOk && perSeg.length > 0) {
      const best = perSeg.reduce((a, b) => (b.bestS! < a.bestS! ? b : a));
      fastestLapDriverId = best.driverId;
    }
    return {
      sessionId: h.sessionId,
      kind: h.kind as QualiKind,
      name: h.name,
      startUtc: h.startUtc,
      poleDriverId: pole?.row.driverId ?? null,
      poleBestS: pole?.row.bestS ?? null,
      segments,
      timesSource: (mine[0]?.timesSource ?? "api") as "api" | "derived",
      crossSegmentOk,
      segmentRepairs: segmentRepairsFrom(h.warnings),
      fastestLapDriverId,
      rows: mine.map((r) => r.row),
      perSegmentAvailable: h.analyticsStatus?.["quali_segment_times"] === "ok" && perSeg.length > 0,
      waivedSegments: waivedSegmentsFrom(h.warnings),
    };
  });
}

/** §3.3 joined to the session's own entry/team rows, position order, for several sessions. */
async function qualiRowsFor(
  ids: number[],
): Promise<{ sessionId: number; timesSource: string; row: QualiRow }[]> {
  const raw = await db
    .select({
      sessionId: qualiResults.sessionId,
      driverId: qualiResults.driverId,
      teamId: qualiResults.teamId,
      code: sessionEntries.code,
      lineStyle: sessionEntries.lineStyle,
      teamName: sessionTeams.teamName,
      colour: sessionTeams.colour,
      position: qualiResults.position,
      q1S: qualiResults.q1S,
      q2S: qualiResults.q2S,
      q3S: qualiResults.q3S,
      bestS: qualiResults.bestS,
      bestSegment: qualiResults.bestSegment,
      segmentsEntered: qualiResults.segmentsEntered,
      knockedOutIn: qualiResults.knockedOutIn,
      setATime: qualiResults.setATime,
      gapToPoleS: qualiResults.gapToPoleS,
      gapToPolePct: qualiResults.gapToPolePct,
      gapToPoleCommonS: qualiResults.gapToPoleCommonS,
      gapToPoleCommonPct: qualiResults.gapToPoleCommonPct,
      gapToPoleSegment: qualiResults.gapToPoleSegment,
      nReprLaps: qualiResults.nReprLaps,
      pushLaps: qualiResults.pushLaps,
      timesSource: qualiResults.timesSource,
    })
    .from(qualiResults)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, qualiResults.sessionId),
        eq(sessionEntries.driverId, qualiResults.driverId),
      ),
    )
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, qualiResults.sessionId),
        eq(sessionTeams.teamId, qualiResults.teamId),
      ),
    )
    .where(inArray(qualiResults.sessionId, ids))
    .orderBy(asc(qualiResults.sessionId), asc(qualiResults.position));

  return raw.map((r) => ({
    sessionId: r.sessionId,
    timesSource: r.timesSource,
    row: {
      driverId: r.driverId,
      code: r.code,
      teamId: r.teamId,
      teamName: r.teamName ?? r.teamId,
      colour: r.colour ?? TEAM_FALLBACK,
      lineStyle: r.lineStyle as LineStyle,
      position: r.position,
      q1S: r.q1S,
      q2S: r.q2S,
      q3S: r.q3S,
      bestS: r.bestS,
      bestSegment: seg(r.bestSegment),
      segmentsEntered: (seg(r.segmentsEntered) ?? 1) as QualiSegment,
      knockedOutIn: seg(r.knockedOutIn),
      setATime: r.setATime,
      gapToPoleS: r.gapToPoleS,
      gapToPolePct: r.gapToPolePct,
      gapToPoleCommonS: r.gapToPoleCommonS,
      gapToPoleCommonPct: r.gapToPoleCommonPct,
      gapToPoleSegment: seg(r.gapToPoleSegment),
      nReprLaps: r.nReprLaps,
      pushLaps: r.pushLaps,
    },
  }));
}

/** Every non-null per-segment best, for the quickest-comparable-lap question (§4.5). */
async function segmentBestsFor(
  ids: number[],
): Promise<{ sessionId: number; driverId: string; bestS: number }[]> {
  const rows = await db
    .select({
      sessionId: qualiSegmentTimes.sessionId,
      driverId: qualiSegmentTimes.driverId,
      bestS: qualiSegmentTimes.bestS,
    })
    .from(qualiSegmentTimes)
    .where(
      and(inArray(qualiSegmentTimes.sessionId, ids), sql`${qualiSegmentTimes.bestS} IS NOT NULL`),
    );
  return rows.map((r) => ({ sessionId: r.sessionId, driverId: r.driverId, bestS: r.bestS! }));
}

// ---------------------------------------------------------------------------
// §6.1 per-session long forms
// ---------------------------------------------------------------------------

/** §3.4 for one session, driver then segment. Empty on a `partial` session (D8 gate). */
export async function getQualiSegments(sessionId: number): Promise<QualiSegmentRow[]> {
  const rows = await db
    .select({
      driverId: qualiSegmentTimes.driverId,
      code: sessionEntries.code,
      colour: sessionTeams.colour,
      segment: qualiSegmentTimes.segment,
      lapsRun: qualiSegmentTimes.lapsRun,
      reprLaps: qualiSegmentTimes.reprLaps,
      pushLaps: qualiSegmentTimes.pushLaps,
      bestS: qualiSegmentTimes.bestS,
      gapToBestS: qualiSegmentTimes.gapToBestS,
      gapToBestPct: qualiSegmentTimes.gapToBestPct,
      spreadS: qualiSegmentTimes.spreadS,
      sdS: qualiSegmentTimes.sdS,
      compound: qualiSegmentTimes.compound,
      tyreLife: qualiSegmentTimes.tyreLife,
      wetCompound: qualiSegmentTimes.wetCompound,
      verified: qualiSegmentTimes.verified,
      position: qualiResults.position,
    })
    .from(qualiSegmentTimes)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, qualiSegmentTimes.sessionId),
        eq(sessionEntries.driverId, qualiSegmentTimes.driverId),
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
      qualiResults,
      and(
        eq(qualiResults.sessionId, qualiSegmentTimes.sessionId),
        eq(qualiResults.driverId, qualiSegmentTimes.driverId),
      ),
    )
    .where(eq(qualiSegmentTimes.sessionId, sessionId))
    .orderBy(asc(qualiResults.position), asc(qualiSegmentTimes.segment));

  return rows.map((r) => ({
    driverId: r.driverId,
    code: r.code,
    colour: r.colour ?? TEAM_FALLBACK,
    segment: (seg(r.segment) ?? 1) as QualiSegment,
    lapsRun: r.lapsRun,
    reprLaps: r.reprLaps,
    pushLaps: r.pushLaps,
    bestS: r.bestS,
    gapToBestS: r.gapToBestS,
    gapToBestPct: r.gapToBestPct,
    spreadS: r.spreadS,
    sdS: r.sdS,
    compound: r.compound,
    tyreLife: r.tyreLife,
    wetCompound: r.wetCompound,
    verified: r.verified,
  }));
}

/** §3.5 for one session. `driver_a` is stored as the QUICKER driver; order is not changed here. */
export async function getQualiTeammates(sessionId: number): Promise<QualiH2HRow[]> {
  const entryA = sessionEntries;
  const rows = await db
    .select({
      teamId: qualiTeammateH2h.teamId,
      teamName: sessionTeams.teamName,
      colour: sessionTeams.colour,
      driverA: qualiTeammateH2h.driverA,
      codeA: entryA.code,
      driverB: qualiTeammateH2h.driverB,
      segment: qualiTeammateH2h.segment,
      aBestS: qualiTeammateH2h.aBestS,
      bBestS: qualiTeammateH2h.bBestS,
      deltaS: qualiTeammateH2h.deltaS,
      deltaPct: qualiTeammateH2h.deltaPct,
      comparable: qualiTeammateH2h.comparable,
      classifiedAhead: qualiTeammateH2h.classifiedAhead,
      divergent: qualiTeammateH2h.divergent,
      belowNoise: qualiTeammateH2h.belowNoise,
      sessionSdS: qualiTeammateH2h.sessionSdS,
    })
    .from(qualiTeammateH2h)
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, qualiTeammateH2h.sessionId),
        eq(sessionTeams.teamId, qualiTeammateH2h.teamId),
      ),
    )
    .leftJoin(
      entryA,
      and(eq(entryA.sessionId, qualiTeammateH2h.sessionId), eq(entryA.driverId, qualiTeammateH2h.driverA)),
    )
    .where(eq(qualiTeammateH2h.sessionId, sessionId))
    .orderBy(asc(sessionTeams.teamName));

  // Driver B's code needs a second entry row per pair; one extra round trip beats a
  // second alias of `session_entries` in a join that already has three left joins.
  const codes = await codeMap(sessionId);
  return rows.map((r) => ({
    teamId: r.teamId,
    teamName: r.teamName ?? r.teamId,
    colour: r.colour ?? TEAM_FALLBACK,
    driverA: r.driverA,
    codeA: r.codeA ?? codes.get(r.driverA) ?? r.driverA,
    driverB: r.driverB,
    codeB: codes.get(r.driverB) ?? r.driverB,
    segment: seg(r.segment),
    aBestS: r.aBestS,
    bBestS: r.bBestS,
    deltaS: r.deltaS,
    deltaPct: r.deltaPct,
    comparable: r.comparable,
    classifiedAhead: r.classifiedAhead,
    divergent: r.divergent,
    belowNoise: r.belowNoise,
    sessionSdS: r.sessionSdS,
  }));
}

async function codeMap(sessionId: number): Promise<Map<string, string>> {
  const rows = await db
    .select({ driverId: sessionEntries.driverId, code: sessionEntries.code })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId));
  return new Map(rows.map((r) => [r.driverId, r.code]));
}

// ---------------------------------------------------------------------------
// §4.7 qualified versus started — derived, never stored, never called a penalty
// ---------------------------------------------------------------------------

export async function getQualiToGrid(year: number, round: number): Promise<QualiToGridRow[]> {
  const qs = sql`(SELECT session_id FROM sessions WHERE year = ${year} AND round = ${round} AND kind = 'Q')`;
  const rs = sql`(SELECT session_id FROM sessions WHERE year = ${year} AND round = ${round} AND kind = 'R')`;
  const rows = await db
    .select({
      driverId: qualiResults.driverId,
      code: sessionEntries.code,
      colour: sessionTeams.colour,
      qualiPosition: qualiResults.position,
      gridPosition: results.gridPosition,
    })
    .from(qualiResults)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, qualiResults.sessionId),
        eq(sessionEntries.driverId, qualiResults.driverId),
      ),
    )
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(
      results,
      and(eq(results.sessionId, sql`${rs}`), eq(results.driverId, qualiResults.driverId)),
    )
    .where(and(eq(qualiResults.sessionId, sql`${qs}`), sql`${results.gridPosition} IS NOT NULL`))
    .orderBy(asc(qualiResults.position));

  return rows.map((r) => ({
    driverId: r.driverId,
    code: r.code,
    colour: r.colour ?? TEAM_FALLBACK,
    qualiPosition: r.qualiPosition,
    gridPosition: r.gridPosition!,
    placesMoved: r.gridPosition! - r.qualiPosition,
  }));
}

// ---------------------------------------------------------------------------
// §6.5 season head-to-head. The Wilson interval is computed HERE and never stored.
// ---------------------------------------------------------------------------

export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = wins / n,
    d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n),
    m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(c - m) / d, (c + m) / d];
}

/** §6.5's greyed threshold: under five sessions the record is not shown as a record. */
export const SEASON_H2H_MIN_SESSIONS = 5;

export async function getSeasonQualiH2H(year: number): Promise<SeasonQualiH2HRow[]> {
  const rows = await db
    .select({
      teamId: seasonQualiH2h.teamId,
      driverA: seasonQualiH2h.driverA,
      driverB: seasonQualiH2h.driverB,
      kind: seasonQualiH2h.kind,
      sessionsCounted: seasonQualiH2h.sessionsCounted,
      aWins: seasonQualiH2h.aWins,
      bWins: seasonQualiH2h.bWins,
      deltasCounted: seasonQualiH2h.deltasCounted,
      sessionsCaveated: seasonQualiH2h.sessionsCaveated,
      medianDeltaS: seasonQualiH2h.medianDeltaS,
      medianDeltaPct: seasonQualiH2h.medianDeltaPct,
      madDeltaPct: seasonQualiH2h.madDeltaPct,
    })
    .from(seasonQualiH2h)
    .where(eq(seasonQualiH2h.year, year));
  if (rows.length === 0) return [];

  // Team name/colour and driver codes come from the season's own sessions, because
  // `season_quali_h2h` stores neither (§3.6) and a team can be renamed mid-era.
  const [teamsById, codes] = await Promise.all([seasonTeams(year), seasonCodes(year)]);
  const out = rows.map((r) => {
    const [lo, hi] = wilson(r.aWins, r.sessionsCounted);
    const t = teamsById.get(r.teamId);
    return {
      teamId: r.teamId,
      teamName: t?.name ?? r.teamId,
      colour: t?.colour ?? TEAM_FALLBACK,
      driverA: r.driverA,
      codeA: codes.get(r.driverA) ?? r.driverA,
      driverB: r.driverB,
      codeB: codes.get(r.driverB) ?? r.driverB,
      kind: r.kind as QualiKind,
      sessionsCounted: r.sessionsCounted,
      aWins: r.aWins,
      bWins: r.bWins,
      deltasCounted: r.deltasCounted,
      sessionsCaveated: r.sessionsCaveated,
      medianDeltaS: r.medianDeltaS,
      medianDeltaPct: r.medianDeltaPct,
      madDeltaPct: r.madDeltaPct,
      wilsonLow: lo,
      wilsonHigh: hi,
    };
  });
  // Q before SQ, then team name: never ranked by win count (§6.5).
  out.sort((a, b) =>
    a.kind === b.kind ? a.teamName.localeCompare(b.teamName) : a.kind === "Q" ? -1 : 1,
  );
  return out;
}

/** Latest-round team name and colour per team across a season's qualifying sessions. */
async function seasonTeams(year: number): Promise<Map<string, { name: string; colour: string }>> {
  const rows = await db
    .select({
      round: sessions.round,
      teamId: sessionTeams.teamId,
      teamName: sessionTeams.teamName,
      colour: sessionTeams.colour,
    })
    .from(sessionTeams)
    .innerJoin(sessions, eq(sessions.sessionId, sessionTeams.sessionId))
    .where(and(eq(sessions.year, year), inArray(sessions.kind, ["Q", "SQ"])))
    .orderBy(asc(sessions.round));
  const m = new Map<string, { name: string; colour: string }>();
  for (const r of rows) m.set(r.teamId, { name: r.teamName, colour: r.colour });
  return m;
}

/** Latest code per driver across a season's qualifying sessions. */
async function seasonCodes(year: number): Promise<Map<string, string>> {
  const rows = await db
    .select({
      round: sessions.round,
      driverId: sessionEntries.driverId,
      code: sessionEntries.code,
    })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
    .where(and(eq(sessions.year, year), inArray(sessions.kind, ["Q", "SQ"])))
    .orderBy(asc(sessions.round));
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.driverId, r.code);
  return m;
}

// ---------------------------------------------------------------------------
// §6.5 driver page — one row per season and kind. No pooled career figure (§4.3).
// ---------------------------------------------------------------------------

export async function getDriverQualiSeasons(driverId: string): Promise<DriverQualiSeason[]> {
  // D9: the aggregate is on PERCENT, and only on the same-segment gap — the TV gap
  // charges a Q1 driver for a greener track (§4.1), so it is never averaged.
  const rows = await db
    .select({
      year: sessions.year,
      kind: sessions.kind,
      sessions: sql<number>`count(*)::int`,
      poles: sql<number>`count(*) FILTER (WHERE ${qualiResults.position} = 1)::int`,
      finalSegmentAppearances: sql<number>`count(*) FILTER (WHERE ${qualiResults.knockedOutIn} IS NULL)::int`,
      medianGapToPoleCommonPct: sql<
        number | null
      >`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${qualiResults.gapToPoleCommonPct})`,
      bestGapToPoleCommonPct: sql<number | null>`min(${qualiResults.gapToPoleCommonPct})`,
    })
    .from(qualiResults)
    .innerJoin(sessions, eq(sessions.sessionId, qualiResults.sessionId))
    .where(eq(qualiResults.driverId, driverId))
    .groupBy(sessions.year, sessions.kind)
    .orderBy(asc(sessions.year), asc(sessions.kind));

  return rows.map((r) => ({
    year: r.year,
    kind: r.kind as QualiKind,
    sessions: Number(r.sessions),
    poles: Number(r.poles),
    finalSegmentAppearances: Number(r.finalSegmentAppearances),
    medianGapToPoleCommonPct: r.medianGapToPoleCommonPct,
    bestGapToPoleCommonPct: r.bestGapToPoleCommonPct,
  }));
}

// ---------------------------------------------------------------------------
// §6.4 weekend preview panel — history only, never an input to the forecast (§5.5).
// ---------------------------------------------------------------------------

/** §6.4's greyed threshold: fewer than three previous sessions is shown greyed, with the count. */
export const CIRCUIT_HISTORY_MIN_SESSIONS = 3;

/**
 * SPEC §6.1 writes `circuitId: string`; this database has no such column — a circuit is
 * `events.circuit_key`, an integer (db/schema/reference.ts). The key is taken, and the
 * discrepancy is reported rather than papered over with a lookup by name.
 */
export async function getCircuitQualiHistory(
  circuitKey: number,
  driverIds: string[],
  /** The round being previewed, so its own session can never count as "previous". */
  exclude?: { year: number; round: number },
): Promise<CircuitQualiHistoryRow[]> {
  if (driverIds.length === 0) return [];
  const rows = await db
    .select({
      driverId: qualiResults.driverId,
      sessions: sql<number>`count(*)::int`,
      medianGapToPoleCommonPct: sql<
        number | null
      >`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${qualiResults.gapToPoleCommonPct})`,
    })
    .from(qualiResults)
    .innerJoin(sessions, eq(sessions.sessionId, qualiResults.sessionId))
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .where(
      and(
        eq(sessions.kind, "Q"),
        eq(events.circuitKey, circuitKey),
        inArray(qualiResults.driverId, driverIds),
        ...(exclude
          ? [sql`NOT (${sessions.year} = ${exclude.year} AND ${sessions.round} = ${exclude.round})`]
          : []),
      ),
    )
    .groupBy(qualiResults.driverId);

  const meta = await driverMeta(driverIds);
  return rows
    .map((r) => ({
      driverId: r.driverId,
      code: meta.get(r.driverId)?.code ?? r.driverId,
      colour: meta.get(r.driverId)?.colour ?? TEAM_FALLBACK,
      sessions: Number(r.sessions),
      medianGapToPoleCommonPct: r.medianGapToPoleCommonPct,
    }))
    .sort(
      (a, b) =>
        (a.medianGapToPoleCommonPct ?? Infinity) - (b.medianGapToPoleCommonPct ?? Infinity),
    );
}

/** Latest code and most recent qualifying team colour for a set of drivers. */
async function driverMeta(
  driverIds: string[],
): Promise<Map<string, { code: string; colour: string }>> {
  const rows = await db
    .select({
      driverId: drivers.driverId,
      code: drivers.latestCode,
    })
    .from(drivers)
    .where(inArray(drivers.driverId, driverIds));
  const colours = await db
    .select({
      year: sessions.year,
      round: sessions.round,
      driverId: sessionEntries.driverId,
      colour: sessionTeams.colour,
    })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .where(and(inArray(sessionEntries.driverId, driverIds), inArray(sessions.kind, ["Q", "SQ"])))
    .orderBy(asc(sessions.year), asc(sessions.round));
  const colourOf = new Map<string, string>();
  for (const c of colours) colourOf.set(c.driverId, c.colour);
  return new Map(
    rows.map((r) => [
      r.driverId,
      { code: r.code, colour: colourOf.get(r.driverId) ?? TEAM_FALLBACK },
    ]),
  );
}

// ---------------------------------------------------------------------------
// §6.5 season page — the pole column.
// ---------------------------------------------------------------------------

export type SeasonPoleRow = {
  round: number;
  eventName: string;
  kind: QualiKind;
  code: string | null;
  driverId: string | null;
  colour: string | null;
  bestS: number | null;
};

/**
 * One row per qualifying session of a season, round order, Q before SQ. §6.6 requires an
 * em dash where a round has no Q session, so rounds WITHOUT a qualifying session are
 * returned too, with every pole field null.
 */
export async function getSeasonPoles(year: number): Promise<SeasonPoleRow[]> {
  const rows = await db
    .select({
      round: sessions.round,
      eventName: events.eventName,
      kind: sessions.kind,
      driverId: qualiResults.driverId,
      code: sessionEntries.code,
      colour: sessionTeams.colour,
      bestS: qualiResults.bestS,
    })
    .from(sessions)
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .leftJoin(
      qualiResults,
      and(eq(qualiResults.sessionId, sessions.sessionId), eq(qualiResults.position, 1)),
    )
    .leftJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, sessions.sessionId),
        eq(sessionEntries.driverId, qualiResults.driverId),
      ),
    )
    .leftJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessions.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .where(and(eq(sessions.year, year), inArray(sessions.kind, ["Q", "SQ"])))
    .orderBy(asc(sessions.round), asc(sessions.kind));

  return rows.map((r) => ({
    round: r.round,
    eventName: r.eventName,
    kind: r.kind as QualiKind,
    driverId: r.driverId,
    code: r.code,
    colour: r.colour,
    bestS: r.bestS,
  }));
}
