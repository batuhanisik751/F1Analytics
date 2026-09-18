// SPEC §3.3 — race page queries (WP4). All functions are async, take primitives and
// return plain JSON-serialisable objects. Lap times and gaps are seconds; dates are ISO
// strings. Nothing here computes analytics: every number is selected from a table that
// f1lab wrote at ingest time; the only reshaping is getRaceTrace's pivot and sorting.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import {
  assumptionSets,
  circuits,
  compoundColours,
  compoundDegradation,
  degradationFits,
  drivers,
  events,
  fuelSensitivity,
  lapExclusionReport,
  lapStatus,
  laps,
  optimalStint,
  paceRanking,
  raceMoment,
  results,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
  stints,
  teammateDeltas,
  wpLapProbability,
  wpMetrics,
  wpReliabilityBin,
  wpRun,
  wpSwing,
} from "@/db/schema";
import { COMPOUND_FALLBACK } from "@/lib/theme";
import type {
  ColourMap,
  DriverRef,
  IngestStatus,
  LineStyle,
  RaceNavLink,
  TeamRef,
} from "@/lib/queries/shared";

// ---------------------------------------------------------------------------
// Exported row types (SPEC §3.3, verbatim)
// ---------------------------------------------------------------------------

export type RaceHeader = {
  sessionId: number;
  year: number;
  round: number;
  eventName: string;
  officialName: string;
  location: string;
  country: string;
  circuitShortName: string | null;
  eventDate: string;
  totalLaps: number | null;
  ingestStatus: IngestStatus;
  ingestError: string | null;
  warnings: string[];
  podium: (DriverRef & { position: number })[];
  winnerTimeS: number | null;
  lapsUsed: { representative: number; raw: number } | null;
  prev: RaceNavLink | null;
  next: RaceNavLink | null;
};

export type PaceRow = DriverRef & {
  rank: number;
  cleanLaps: number;
  medianPaceS: number;
  bestPaceS: number;
  iqrS: number;
  gapS: number;
  gapPct: number;
  /** whiskerLo, q1, median, q3, whiskerHi */
  box: [number, number, number, number, number];
  sensRankLo: number | null;
  sensRankHi: number | null;
  finishPosition: number | null;
};

export type StintRow = {
  driverId: string;
  code: string;
  stint: number;
  compound: string;
  compoundColour: string;
  startLap: number;
  endLap: number;
  laps: number;
};

export type DegPoint = { code: string; compound: string; tyreLife: number; lapTimeFcS: number };

export type CompoundFit = {
  compound: string;
  compoundColour: string;
  laps: number;
  slopeSPerLap: number;
  interceptS: number;
  xMin: number;
  xMax: number;
};

export type DegFitRow = DriverRef & {
  stint: number;
  compound: string;
  compoundColour: string;
  laps: number;
  degSPerLap: number;
  degStdErr: number;
  r2: number;
  freshPaceS: number;
};

export type TraceSeries = DriverRef & {
  finishPosition: number | null;
  /** index = lapNumber - 1, length totalLaps */
  gaps: (number | null)[];
  positions: (number | null)[];
};

export type LapStatusRow = { lapNumber: number; isGreen: boolean; worstStatus: string };

export type TeammateRow = {
  team: TeamRef;
  faster: DriverRef;
  slower: DriverRef;
  gapS: number;
  gapPct: number;
  lapsCompared: number;
};

export type SensitivityRow = {
  driverId: string;
  code: string;
  team: TeamRef;
  /** asc by fuelEffect */
  cells: { fuelEffect: number; rank: number; gapS: number }[];
  moves: boolean;
};

export type ExclusionRow = {
  order: number;
  rule: string;
  lapsHit: number;
  pctOfAll: number;
  isSurviving: boolean;
};

export type RaceResultRow = DriverRef & {
  position: number | null;
  classifiedPosition: string;
  gridPosition: number | null;
  points: number;
  status: string;
  lapsCompleted: number | null;
  resultTimeS: number | null;
};

export type AssumptionsView = {
  params: Record<string, unknown>;
  assumptionSetId: number;
  f1labVersion: string;
  fastf1Version: string;
  ingestedAt: string;
  rawLaps: number;
  cleanLaps: number;
  lapKmUsed: number | null;
  fuelScale: number;
  analyticsStatus: Record<string, string>;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function asLineStyle(s: string): LineStyle {
  return s === "dashed" || s === "dotted" ? s : "solid";
}

function asStatus(s: string | null | undefined): IngestStatus {
  return s === "ok" || s === "partial" || s === "failed" ? s : "pending";
}

function fallbackCompoundColour(compound: string): string {
  return COMPOUND_FALLBACK[compound] ?? COMPOUND_FALLBACK.UNKNOWN;
}

type EntryRow = {
  driverId: string;
  code: string;
  fullName: string;
  lineStyle: string;
  teamId: string;
  teamName: string;
  teamColour: string;
};

function toDriverRef(r: EntryRow): DriverRef {
  return {
    driverId: r.driverId,
    code: r.code,
    fullName: r.fullName,
    lineStyle: asLineStyle(r.lineStyle),
    teamId: r.teamId,
    teamName: r.teamName,
    teamColour: r.teamColour,
  };
}

const entryColumns = {
  driverId: sessionEntries.driverId,
  code: sessionEntries.code,
  fullName: drivers.fullName,
  lineStyle: sessionEntries.lineStyle,
  teamId: sessionTeams.teamId,
  teamName: sessionTeams.teamName,
  teamColour: sessionTeams.colour,
};

/** Every session_entries row of the session as a DriverRef, keyed by driver_id. */
async function loadEntries(sessionId: number): Promise<Map<string, DriverRef>> {
  const rows = await db
    .select(entryColumns)
    .from(sessionEntries)
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .where(eq(sessionEntries.sessionId, sessionId));
  return new Map(rows.map((r) => [r.driverId, toDriverRef(r)]));
}

/**
 * Drivers in finishing order: results.position asc NULLS LAST, laps_completed desc
 * (retired cars after the classified ones, longest-running first), then code.
 * Entries without a results row (never observed) go last.
 */
async function loadDriverOrder(
  sessionId: number,
): Promise<(DriverRef & { finishPosition: number | null })[]> {
  const rows = await db
    .select({
      ...entryColumns,
      position: results.position,
      lapsCompleted: results.lapsCompleted,
    })
    .from(sessionEntries)
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .leftJoin(
      results,
      and(
        eq(results.sessionId, sessionEntries.sessionId),
        eq(results.driverId, sessionEntries.driverId),
      ),
    )
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(
      sql`${results.position} asc nulls last`,
      sql`${results.lapsCompleted} desc nulls last`,
      asc(sessionEntries.code),
    );
  return rows.map((r) => ({ ...toDriverRef(r), finishPosition: r.position ?? null }));
}

/** compound -> colour for the session, from compound_colours. */
async function loadCompoundColours(sessionId: number): Promise<Map<string, string>> {
  const rows = await db
    .select({ compound: compoundColours.compound, colour: compoundColours.colour })
    .from(compoundColours)
    .where(eq(compoundColours.sessionId, sessionId));
  return new Map(rows.map((r) => [r.compound, r.colour]));
}

/** Nearest ingested (ok/partial) race in the same season, below or above `round`. */
async function neighbourRace(
  year: number,
  round: number,
  direction: "prev" | "next",
): Promise<RaceNavLink | null> {
  const rows = await db
    .select({ year: sessions.year, round: sessions.round, eventName: events.eventName })
    .from(sessions)
    .innerJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .where(
      and(
        eq(sessions.year, year),
        eq(sessions.kind, "R"),
        inArray(sessionIngests.status, ["ok", "partial"]),
        direction === "prev"
          ? sql`${sessions.round} < ${round}`
          : sql`${sessions.round} > ${round}`,
      ),
    )
    .orderBy(direction === "prev" ? desc(sessions.round) : asc(sessions.round))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Exported queries
// ---------------------------------------------------------------------------

/** Null when there is no `sessions` row (kind 'R') for (year, round). */
export async function getRaceHeader(year: number, round: number): Promise<RaceHeader | null> {
  const rows = await db
    .select({
      sessionId: sessions.sessionId,
      year: sessions.year,
      round: sessions.round,
      totalLaps: sessions.totalLaps,
      eventName: events.eventName,
      officialName: events.officialName,
      location: events.location,
      country: events.country,
      eventDate: events.eventDate,
      circuitShortName: circuits.shortName,
      ingestStatus: sessionIngests.status,
      ingestError: sessionIngests.error,
      warnings: sessionIngests.warnings,
      rawLaps: sessionIngests.rawLaps,
      cleanLaps: sessionIngests.cleanLaps,
    })
    .from(sessions)
    .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
    .leftJoin(circuits, eq(circuits.circuitKey, events.circuitKey))
    .leftJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .where(and(eq(sessions.year, year), eq(sessions.round, round), eq(sessions.kind, "R")))
    .limit(1);
  const s = rows[0];
  if (!s) return null;

  const status = asStatus(s.ingestStatus);
  const [podiumRows, prev, next] = await Promise.all([
    db
      .select({ ...entryColumns, position: results.position, resultTimeS: results.resultTimeS })
      .from(results)
      .innerJoin(
        sessionEntries,
        and(
          eq(sessionEntries.sessionId, results.sessionId),
          eq(sessionEntries.driverId, results.driverId),
        ),
      )
      .innerJoin(
        sessionTeams,
        and(
          eq(sessionTeams.sessionId, sessionEntries.sessionId),
          eq(sessionTeams.teamId, sessionEntries.teamId),
        ),
      )
      .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
      .where(and(eq(results.sessionId, s.sessionId), inArray(results.position, [1, 2, 3])))
      .orderBy(asc(results.position)),
    neighbourRace(year, round, "prev"),
    neighbourRace(year, round, "next"),
  ]);

  const podium = podiumRows
    .filter((r) => r.position !== null)
    .map((r) => ({ ...toDriverRef(r), position: r.position as number }));
  const winner = podiumRows.find((r) => r.position === 1);

  return {
    sessionId: s.sessionId,
    year: s.year,
    round: s.round,
    eventName: s.eventName,
    officialName: s.officialName,
    location: s.location,
    country: s.country,
    circuitShortName: s.circuitShortName ?? null,
    eventDate: s.eventDate,
    totalLaps: s.totalLaps ?? null,
    ingestStatus: status,
    ingestError: s.ingestError ?? null,
    warnings: s.warnings ?? [],
    podium,
    winnerTimeS: winner?.resultTimeS ?? null,
    lapsUsed:
      status === "ok" || status === "partial"
        ? { representative: s.cleanLaps ?? 0, raw: s.rawLaps ?? 0 }
        : null,
    prev,
    next,
  };
}

/** Team and compound hex maps for the session (session_teams / compound_colours). */
export async function getRaceColours(sessionId: number): Promise<ColourMap> {
  const [teamRows, compoundMap] = await Promise.all([
    db
      .select({ teamId: sessionTeams.teamId, colour: sessionTeams.colour })
      .from(sessionTeams)
      .where(eq(sessionTeams.sessionId, sessionId)),
    loadCompoundColours(sessionId),
  ]);
  return {
    teams: Object.fromEntries(teamRows.map((r) => [r.teamId, r.colour])),
    compounds: Object.fromEntries(compoundMap),
  };
}

/** pace_ranking rows ORDER BY rank, joined to identity, colours and finishing position. */
export async function getPaceRanking(sessionId: number): Promise<PaceRow[]> {
  const rows = await db
    .select({
      ...entryColumns,
      rank: paceRanking.rank,
      cleanLaps: paceRanking.cleanLaps,
      medianPaceS: paceRanking.medianPaceS,
      bestPaceS: paceRanking.bestPaceS,
      iqrS: paceRanking.iqrS,
      gapS: paceRanking.gapS,
      gapPct: paceRanking.gapPct,
      whiskerLo: paceRanking.boxWhiskerLoS,
      q1: paceRanking.boxQ1S,
      q3: paceRanking.boxQ3S,
      whiskerHi: paceRanking.boxWhiskerHiS,
      sensRankLo: paceRanking.sensRankLo,
      sensRankHi: paceRanking.sensRankHi,
      finishPosition: results.position,
    })
    .from(paceRanking)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, paceRanking.sessionId),
        eq(sessionEntries.driverId, paceRanking.driverId),
      ),
    )
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .leftJoin(
      results,
      and(eq(results.sessionId, paceRanking.sessionId), eq(results.driverId, paceRanking.driverId)),
    )
    .where(eq(paceRanking.sessionId, sessionId))
    .orderBy(asc(paceRanking.rank));

  return rows.map((r) => ({
    ...toDriverRef(r),
    rank: r.rank,
    cleanLaps: r.cleanLaps,
    medianPaceS: r.medianPaceS,
    bestPaceS: r.bestPaceS,
    iqrS: r.iqrS,
    gapS: r.gapS,
    gapPct: r.gapPct,
    box: [r.whiskerLo, r.q1, r.medianPaceS, r.q3, r.whiskerHi],
    sensRankLo: r.sensRankLo ?? null,
    sensRankHi: r.sensRankHi ?? null,
    finishPosition: r.finishPosition ?? null,
  }));
}

/**
 * order = drivers by results.position asc NULLS LAST, laps_completed desc (retired drivers
 * keep their rows); stints ordered by that driver order, then start_lap. A driver's first
 * stored stint need not start at lap 1 (SPEC §0.3).
 */
export async function getStints(
  sessionId: number,
): Promise<{ order: DriverRef[]; stints: StintRow[] }> {
  const [order, stintRows, compoundMap] = await Promise.all([
    loadDriverOrder(sessionId),
    db
      .select({
        driverId: stints.driverId,
        code: sessionEntries.code,
        stint: stints.stint,
        compound: stints.compound,
        startLap: stints.startLap,
        endLap: stints.endLap,
        laps: stints.laps,
      })
      .from(stints)
      .innerJoin(
        sessionEntries,
        and(
          eq(sessionEntries.sessionId, stints.sessionId),
          eq(sessionEntries.driverId, stints.driverId),
        ),
      )
      .where(eq(stints.sessionId, sessionId)),
    loadCompoundColours(sessionId),
  ]);
  const orderIndex = new Map(order.map((d, i) => [d.driverId, i]));
  const sorted = stintRows
    .map((r) => ({
      driverId: r.driverId,
      code: r.code,
      stint: r.stint,
      compound: r.compound,
      compoundColour: compoundMap.get(r.compound) ?? fallbackCompoundColour(r.compound),
      startLap: r.startLap,
      endLap: r.endLap,
      laps: r.laps,
    }))
    .sort(
      (a, b) =>
        (orderIndex.get(a.driverId) ?? 1e9) - (orderIndex.get(b.driverId) ?? 1e9) ||
        a.startLap - b.startLap ||
        a.stint - b.stint,
    );
  return {
    order: order.map((d) => ({
      driverId: d.driverId,
      code: d.code,
      fullName: d.fullName,
      lineStyle: d.lineStyle,
      teamId: d.teamId,
      teamName: d.teamName,
      teamColour: d.teamColour,
    })),
    stints: sorted,
  };
}

/**
 * fits = compound_degradation (most laps first, as pace.compound_degradation iterates);
 * points = representative laps with tyre_life >= 2 on a compound that has a fit;
 * perStint = degradation_fits by driver code, stint.
 */
export async function getDegradation(
  sessionId: number,
): Promise<{ points: DegPoint[]; fits: CompoundFit[]; perStint: DegFitRow[] }> {
  const [fitRows, perStintRows, compoundMap] = await Promise.all([
    db
      .select({
        compound: compoundDegradation.compound,
        laps: compoundDegradation.laps,
        slopeSPerLap: compoundDegradation.slopeSPerLap,
        interceptS: compoundDegradation.interceptS,
        xMin: compoundDegradation.xMin,
        xMax: compoundDegradation.xMax,
      })
      .from(compoundDegradation)
      .where(eq(compoundDegradation.sessionId, sessionId))
      .orderBy(desc(compoundDegradation.laps), asc(compoundDegradation.compound)),
    db
      .select({
        ...entryColumns,
        stint: degradationFits.stint,
        compound: degradationFits.compound,
        laps: degradationFits.laps,
        degSPerLap: degradationFits.degSPerLap,
        degStdErr: degradationFits.degStdErr,
        r2: degradationFits.r2,
        freshPaceS: degradationFits.freshPaceS,
      })
      .from(degradationFits)
      .innerJoin(
        sessionEntries,
        and(
          eq(sessionEntries.sessionId, degradationFits.sessionId),
          eq(sessionEntries.driverId, degradationFits.driverId),
        ),
      )
      .innerJoin(
        sessionTeams,
        and(
          eq(sessionTeams.sessionId, sessionEntries.sessionId),
          eq(sessionTeams.teamId, sessionEntries.teamId),
        ),
      )
      .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
      .where(eq(degradationFits.sessionId, sessionId))
      .orderBy(asc(sessionEntries.code), asc(degradationFits.stint)),
    loadCompoundColours(sessionId),
  ]);

  const colourOf = (c: string) => compoundMap.get(c) ?? fallbackCompoundColour(c);
  const fits: CompoundFit[] = fitRows.map((r) => ({
    compound: r.compound,
    compoundColour: colourOf(r.compound),
    laps: r.laps,
    slopeSPerLap: r.slopeSPerLap,
    interceptS: r.interceptS,
    xMin: r.xMin,
    xMax: r.xMax,
  }));

  let points: DegPoint[] = [];
  if (fits.length > 0) {
    const pointRows = await db
      .select({
        code: sessionEntries.code,
        compound: laps.compound,
        tyreLife: laps.tyreLife,
        lapTimeFcS: laps.lapTimeFcS,
      })
      .from(laps)
      .innerJoin(
        sessionEntries,
        and(eq(sessionEntries.sessionId, laps.sessionId), eq(sessionEntries.driverId, laps.driverId)),
      )
      .where(
        and(
          eq(laps.sessionId, sessionId),
          eq(laps.isRepresentative, true),
          sql`${laps.tyreLife} >= 2`,
          inArray(
            laps.compound,
            fits.map((f) => f.compound),
          ),
        ),
      )
      .orderBy(asc(laps.compound), asc(laps.tyreLife));
    points = pointRows
      .filter((r) => r.compound !== null && r.tyreLife !== null && r.lapTimeFcS !== null)
      .map((r) => ({
        code: r.code,
        compound: r.compound as string,
        tyreLife: r.tyreLife as number,
        lapTimeFcS: r.lapTimeFcS as number,
      }));
  }

  const perStint: DegFitRow[] = perStintRows.map((r) => ({
    ...toDriverRef(r),
    stint: r.stint,
    compound: r.compound,
    compoundColour: colourOf(r.compound),
    laps: r.laps,
    degSPerLap: r.degSPerLap,
    degStdErr: r.degStdErr,
    r2: r.r2,
    freshPaceS: r.freshPaceS,
  }));

  return { points, fits, perStint };
}

/**
 * Pivot of laps(driver_id, lap_number, gap_to_leader_s, position) into per-driver arrays,
 * series ordered like getStints().order. totalLaps = sessions.total_laps (or the highest lap
 * number stored, whichever is larger, so no lap falls off the end of an array).
 */
export async function getRaceTrace(
  sessionId: number,
): Promise<{ totalLaps: number; series: TraceSeries[]; lapStatus: LapStatusRow[] }> {
  const [sessionRows, order, lapRows, statusRows] = await Promise.all([
    db
      .select({ totalLaps: sessions.totalLaps })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
    loadDriverOrder(sessionId),
    db
      .select({
        driverId: laps.driverId,
        lapNumber: laps.lapNumber,
        gap: laps.gapToLeaderS,
        position: laps.position,
      })
      .from(laps)
      .where(eq(laps.sessionId, sessionId))
      .orderBy(asc(laps.driverId), asc(laps.lapNumber)),
    db
      .select({
        lapNumber: lapStatus.lapNumber,
        isGreen: lapStatus.isGreen,
        worstStatus: lapStatus.worstStatus,
      })
      .from(lapStatus)
      .where(eq(lapStatus.sessionId, sessionId))
      .orderBy(asc(lapStatus.lapNumber)),
  ]);

  if (lapRows.length === 0) {
    return { totalLaps: sessionRows[0]?.totalLaps ?? 0, series: [], lapStatus: statusRows };
  }
  const maxLap = lapRows.reduce((m, r) => (r.lapNumber > m ? r.lapNumber : m), 0);
  const totalLaps = Math.max(sessionRows[0]?.totalLaps ?? 0, maxLap);

  const byDriver = new Map<string, { gaps: (number | null)[]; positions: (number | null)[] }>();
  for (const r of lapRows) {
    let entry = byDriver.get(r.driverId);
    if (!entry) {
      entry = {
        gaps: new Array<number | null>(totalLaps).fill(null),
        positions: new Array<number | null>(totalLaps).fill(null),
      };
      byDriver.set(r.driverId, entry);
    }
    const i = r.lapNumber - 1;
    if (i < 0 || i >= totalLaps) continue;
    entry.gaps[i] = r.gap ?? null;
    entry.positions[i] = r.position ?? null;
  }

  const series: TraceSeries[] = order
    .filter((d) => byDriver.has(d.driverId))
    .map((d) => {
      const e = byDriver.get(d.driverId) as { gaps: (number | null)[]; positions: (number | null)[] };
      return {
        driverId: d.driverId,
        code: d.code,
        fullName: d.fullName,
        lineStyle: d.lineStyle,
        teamId: d.teamId,
        teamName: d.teamName,
        teamColour: d.teamColour,
        finishPosition: d.finishPosition,
        gaps: e.gaps,
        positions: e.positions,
      };
    });

  return { totalLaps, series, lapStatus: statusRows };
}

/**
 * rows ORDER BY gap_pct DESC; unpaired = session_teams without a teammate_deltas row, with the
 * reason derived from how many of the team's drivers appear in pace_ranking.
 */
export async function getTeammateDeltas(
  sessionId: number,
): Promise<{ rows: TeammateRow[]; unpaired: { team: TeamRef; reason: string }[] }> {
  const fasterEntry = alias(sessionEntries, "faster_entry");
  const fasterDriver = alias(drivers, "faster_driver");
  const slowerEntry = alias(sessionEntries, "slower_entry");
  const slowerDriver = alias(drivers, "slower_driver");

  const [deltaRows, teamRows, rankedRows] = await Promise.all([
    db
      .select({
        teamId: sessionTeams.teamId,
        teamName: sessionTeams.teamName,
        teamColour: sessionTeams.colour,
        gapS: teammateDeltas.gapS,
        gapPct: teammateDeltas.gapPct,
        lapsCompared: teammateDeltas.lapsCompared,
        fasterId: fasterEntry.driverId,
        fasterCode: fasterEntry.code,
        fasterName: fasterDriver.fullName,
        fasterStyle: fasterEntry.lineStyle,
        slowerId: slowerEntry.driverId,
        slowerCode: slowerEntry.code,
        slowerName: slowerDriver.fullName,
        slowerStyle: slowerEntry.lineStyle,
      })
      .from(teammateDeltas)
      .innerJoin(
        sessionTeams,
        and(
          eq(sessionTeams.sessionId, teammateDeltas.sessionId),
          eq(sessionTeams.teamId, teammateDeltas.teamId),
        ),
      )
      .innerJoin(
        fasterEntry,
        and(
          eq(fasterEntry.sessionId, teammateDeltas.sessionId),
          eq(fasterEntry.driverId, teammateDeltas.fasterDriverId),
        ),
      )
      .innerJoin(fasterDriver, eq(fasterDriver.driverId, fasterEntry.driverId))
      .innerJoin(
        slowerEntry,
        and(
          eq(slowerEntry.sessionId, teammateDeltas.sessionId),
          eq(slowerEntry.driverId, teammateDeltas.slowerDriverId),
        ),
      )
      .innerJoin(slowerDriver, eq(slowerDriver.driverId, slowerEntry.driverId))
      .where(eq(teammateDeltas.sessionId, sessionId))
      .orderBy(desc(teammateDeltas.gapPct)),
    db
      .select({
        teamId: sessionTeams.teamId,
        teamName: sessionTeams.teamName,
        teamColour: sessionTeams.colour,
      })
      .from(sessionTeams)
      .where(eq(sessionTeams.sessionId, sessionId))
      .orderBy(asc(sessionTeams.teamName)),
    db
      .select({ teamId: paceRanking.teamId, n: sql<number>`count(*)::int` })
      .from(paceRanking)
      .where(eq(paceRanking.sessionId, sessionId))
      .groupBy(paceRanking.teamId),
  ]);

  const rows: TeammateRow[] = deltaRows.map((r) => {
    const team: TeamRef = { teamId: r.teamId, teamName: r.teamName, teamColour: r.teamColour };
    return {
      team,
      faster: {
        ...team,
        driverId: r.fasterId,
        code: r.fasterCode,
        fullName: r.fasterName,
        lineStyle: asLineStyle(r.fasterStyle),
      },
      slower: {
        ...team,
        driverId: r.slowerId,
        code: r.slowerCode,
        fullName: r.slowerName,
        lineStyle: asLineStyle(r.slowerStyle),
      },
      gapS: r.gapS,
      gapPct: r.gapPct,
      lapsCompared: r.lapsCompared,
    };
  });

  const paired = new Set(deltaRows.map((r) => r.teamId));
  const rankedCount = new Map(rankedRows.map((r) => [r.teamId, Number(r.n)]));
  const unpaired = teamRows
    .filter((t) => !paired.has(t.teamId))
    .map((t) => {
      const n = rankedCount.get(t.teamId) ?? 0;
      return {
        team: { teamId: t.teamId, teamName: t.teamName, teamColour: t.teamColour },
        reason:
          n < 2 ? `only ${n} of 2 drivers ranked` : `${n} drivers ranked, no pair computed`,
      };
    });

  return { rows, unpaired };
}

/**
 * values = distinct fuel constants asc; baseValue = params.FUEL_EFFECT_S_PER_KG of the
 * session's assumption set; rows ORDER BY rank at baseValue; movers = rows whose rank changes.
 */
export async function getFuelSensitivity(
  sessionId: number,
): Promise<{ values: number[]; baseValue: number; rows: SensitivityRow[]; movers: number }> {
  const [cellRows, entries, paramRows] = await Promise.all([
    db
      .select({
        driverId: fuelSensitivity.driverId,
        fuelEffect: fuelSensitivity.fuelEffectSPerKg,
        rank: fuelSensitivity.rank,
        gapS: fuelSensitivity.gapS,
      })
      .from(fuelSensitivity)
      .where(eq(fuelSensitivity.sessionId, sessionId))
      .orderBy(asc(fuelSensitivity.driverId), asc(fuelSensitivity.fuelEffectSPerKg)),
    loadEntries(sessionId),
    db
      .select({ params: assumptionSets.params })
      .from(sessionIngests)
      .innerJoin(
        assumptionSets,
        eq(assumptionSets.assumptionSetId, sessionIngests.assumptionSetId),
      )
      .where(eq(sessionIngests.sessionId, sessionId))
      .limit(1),
  ]);

  const values = Array.from(new Set(cellRows.map((r) => r.fuelEffect))).sort((a, b) => a - b);
  const paramBase = paramRows[0]?.params?.FUEL_EFFECT_S_PER_KG;
  const baseValue =
    typeof paramBase === "number"
      ? paramBase
      : (values[Math.floor((values.length - 1) / 2)] ?? 0.03);

  const byDriver = new Map<string, SensitivityRow>();
  for (const r of cellRows) {
    const ref = entries.get(r.driverId);
    if (!ref) continue;
    let row = byDriver.get(r.driverId);
    if (!row) {
      row = {
        driverId: ref.driverId,
        code: ref.code,
        team: { teamId: ref.teamId, teamName: ref.teamName, teamColour: ref.teamColour },
        cells: [],
        moves: false,
      };
      byDriver.set(r.driverId, row);
    }
    row.cells.push({ fuelEffect: r.fuelEffect, rank: r.rank, gapS: r.gapS });
  }

  const rankAtBase = (row: SensitivityRow): number =>
    row.cells.find((c) => c.fuelEffect === baseValue)?.rank ?? Number.MAX_SAFE_INTEGER;
  const rows = Array.from(byDriver.values())
    .map((row) => ({
      ...row,
      cells: row.cells.sort((a, b) => a.fuelEffect - b.fuelEffect),
      moves:
        new Set(row.cells.map((c) => c.rank)).size > 1 || row.cells.length < values.length,
    }))
    .sort((a, b) => rankAtBase(a) - rankAtBase(b) || a.code.localeCompare(b.code));

  return { values, baseValue, rows, movers: rows.filter((r) => r.moves).length };
}

/** lap_exclusion_report ORDER BY rule_order; rawLaps from session_ingests. */
export async function getExclusionReport(
  sessionId: number,
): Promise<{ rawLaps: number; rows: ExclusionRow[] }> {
  const [reportRows, ingestRows] = await Promise.all([
    db
      .select({
        order: lapExclusionReport.ruleOrder,
        rule: lapExclusionReport.rule,
        lapsHit: lapExclusionReport.lapsHit,
        pctOfAll: lapExclusionReport.pctOfAll,
      })
      .from(lapExclusionReport)
      .where(eq(lapExclusionReport.sessionId, sessionId))
      .orderBy(asc(lapExclusionReport.ruleOrder)),
    db
      .select({ rawLaps: sessionIngests.rawLaps })
      .from(sessionIngests)
      .where(eq(sessionIngests.sessionId, sessionId))
      .limit(1),
  ]);
  return {
    rawLaps: ingestRows[0]?.rawLaps ?? 0,
    rows: reportRows.map((r) => ({
      order: r.order,
      rule: r.rule,
      lapsHit: r.lapsHit,
      pctOfAll: r.pctOfAll,
      isSurviving: r.rule.toUpperCase().startsWith("SURVIVING"),
    })),
  };
}

/** results ORDER BY position NULLS LAST, laps_completed DESC. */
export async function getRaceResults(sessionId: number): Promise<RaceResultRow[]> {
  const rows = await db
    .select({
      ...entryColumns,
      position: results.position,
      classifiedPosition: results.classifiedPosition,
      gridPosition: results.gridPosition,
      points: results.points,
      status: results.status,
      lapsCompleted: results.lapsCompleted,
      resultTimeS: results.resultTimeS,
    })
    .from(results)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, results.sessionId),
        eq(sessionEntries.driverId, results.driverId),
      ),
    )
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .where(eq(results.sessionId, sessionId))
    .orderBy(
      sql`${results.position} asc nulls last`,
      sql`${results.lapsCompleted} desc nulls last`,
      asc(sessionEntries.code),
    );
  return rows.map((r) => ({
    ...toDriverRef(r),
    position: r.position ?? null,
    classifiedPosition: r.classifiedPosition,
    gridPosition: r.gridPosition ?? null,
    points: r.points,
    status: r.status,
    lapsCompleted: r.lapsCompleted ?? null,
    resultTimeS: r.resultTimeS ?? null,
  }));
}

/** session_ingests + assumption_sets for the session; null when never ingested. */
export async function getAssumptions(sessionId: number): Promise<AssumptionsView | null> {
  const rows = await db
    .select({
      params: assumptionSets.params,
      assumptionSetId: assumptionSets.assumptionSetId,
      f1labVersion: sessionIngests.f1labVersion,
      fastf1Version: sessionIngests.fastf1Version,
      ingestedAt: sessionIngests.ingestedAt,
      rawLaps: sessionIngests.rawLaps,
      cleanLaps: sessionIngests.cleanLaps,
      lapKmUsed: sessionIngests.lapKmUsed,
      fuelScale: sessionIngests.fuelScale,
      analyticsStatus: sessionIngests.analyticsStatus,
      warnings: sessionIngests.warnings,
    })
    .from(sessionIngests)
    .innerJoin(assumptionSets, eq(assumptionSets.assumptionSetId, sessionIngests.assumptionSetId))
    .where(eq(sessionIngests.sessionId, sessionId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    params: r.params ?? {},
    assumptionSetId: r.assumptionSetId,
    f1labVersion: r.f1labVersion,
    fastf1Version: r.fastf1Version,
    ingestedAt: r.ingestedAt,
    rawLaps: r.rawLaps,
    cleanLaps: r.cleanLaps,
    lapKmUsed: r.lapKmUsed ?? null,
    fuelScale: r.fuelScale,
    analyticsStatus: flattenAnalyticsStatus(r.analyticsStatus),
    warnings: r.warnings ?? [],
  };
}

/**
 * `analytics_status` is a free-form jsonb and its values have not all been strings since
 * v1.7: TELEMETRY_SPEC §3.6 / D8 stores an OBJECT under the `telemetry` key
 * (`{state, reason, drivers, …}`) rather than adding a `telemetry_status` column, which is
 * what kept migration 0008 purely additive.
 *
 * `AssumptionsView.analyticsStatus` is typed `Record<string, string>` and
 * `AssumptionsPanel` renders every non-"ok" entry as `{k}: {v}` — a React child. An object
 * there throws "Objects are not valid as a React child" and takes the WHOLE v1.6 race page
 * to its error boundary, for every session the telemetry pass has touched. Measured on
 * /race/2026/13 before this function existed.
 *
 * So the contract is restored at the query boundary, where the type claim is made: an
 * object collapses to its `state`, with the reason appended when there is one. Pinned by
 * tests/test_telemetry_optional.py::test_every_analytics_status_value_is_a_string.
 */
function flattenAnalyticsStatus(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const state = typeof o.state === "string" ? o.state : JSON.stringify(v);
      const reason = typeof o.reason === "string" && o.reason.length > 0 ? ` — ${o.reason}` : "";
      out[k] = `${state}${reason}`;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MODE1_SPEC §7.2 — v1.2 companion queries (win probability, moments, stint).
// Every one returns null / [] on missing input and never throws.
// ---------------------------------------------------------------------------

export type WinProbSeries = DriverRef & {
  /** p[i] aligns with WinProbability.laps[i]; null before the driver's first lap
      and after their last (a retired car leaves the stack). */
  p: (number | null)[];
};
export type WinProbability = {
  laps: number[];
  series: WinProbSeries[]; // ordered by final finishing position
  degradedLaps: number[]; // laps that fell back to a uniform stack
  modelVersion: string;
};

export type WinProbSwing = {
  lapNumber: number;
  swingMass: number;
  cause: "safety_car" | "vsc" | "red_flag" | "pit_cycle" | "retirement" | "on_track";
  mover: DriverRef;
  pBefore: number;
  pAfter: number;
  rankInRace: number;
};

export type ReliabilityBin = {
  binLo: number;
  binHi: number;
  nRows: number;
  meanPredicted: number;
  observedRate: number;
  observedLo: number;
  observedHi: number;
};
export type WinProbTrustScope = {
  scope: "loro" | "loco";
  label: string; // "races it has not seen" | "tracks it has never visited"
  brier: number;
  logLoss: number;
  brierBaselinePos: number;
  brierBaselineLead: number;
  brierFoldMin: number | null;
  brierFoldMax: number | null;
  bins: ReliabilityBin[];
};
export type WinProbTrust = {
  scopes: WinProbTrustScope[];
  skillOk: boolean;
  nTrainRaces: number;
  calibration: string;
};

export type RaceMoment = {
  lapNumber: number;
  momentType:
    | "pace_collapse"
    | "undercut_executed"
    | "tyre_cliff"
    | "damage_or_puncture"
    | "safety_car_luck";
  driver: DriverRef;
  otherDriver: DriverRef | null;
  magnitude: number;
  magnitudeUnit: "s" | "places";
  confidence: "high" | "likely";
  detail: string;
};
export type RaceMoments = { shown: RaceMoment[]; hiddenCount: number };

export type OptimalStintRow = {
  compound: string;
  slopeSPerLap: number;
  pitLossS: number;
  pitLossSource: "circuit" | "pooled";
  optimalLaps: number;
  optimalLapsLo: number;
  optimalLapsHi: number;
  actualMedianLaps: number | null;
  slopeSource: "session" | "pooled";
  nFits: number;
};

/** MOMENTS_MAX_PER_RACE (§4.2): the display cap; every detected row is still stored. */
const MOMENTS_MAX_PER_RACE = 8;

type WpRunRow = {
  assumptionSetId: number;
  modelVersion: string;
  calibration: string;
  nTrainRaces: number;
  skillOk: boolean;
};

/** The single `wp_run` row flagged `is_current` (partial unique index, §5.1). */
async function currentWpRun(): Promise<WpRunRow | null> {
  const rows = await db
    .select({
      assumptionSetId: wpRun.assumptionSetId,
      modelVersion: wpRun.modelVersion,
      calibration: wpRun.calibration,
      nTrainRaces: wpRun.nTrainRaces,
      skillOk: wpRun.skillOk,
    })
    .from(wpRun)
    .where(eq(wpRun.isCurrent, true))
    .orderBy(desc(wpRun.trainedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stacked per-lap win probability for one race. Null when no current model run exists
 * or the session has no stored (out-of-fold) probabilities. Series are ordered by final
 * finishing position, winner first (§7.3 stack order).
 */
export async function getWinProbability(sessionId: number): Promise<WinProbability | null> {
  const run = await currentWpRun();
  if (!run) return null;
  const rows = await db
    .select({
      driverId: wpLapProbability.driverId,
      lapNumber: wpLapProbability.lapNumber,
      pWin: wpLapProbability.pWin,
      degraded: wpLapProbability.degraded,
    })
    .from(wpLapProbability)
    .where(
      and(
        eq(wpLapProbability.sessionId, sessionId),
        eq(wpLapProbability.assumptionSetId, run.assumptionSetId),
      ),
    )
    .orderBy(asc(wpLapProbability.lapNumber));
  if (rows.length === 0) return null;

  const lapSet = new Set<number>();
  const degraded = new Set<number>();
  const byDriver = new Map<string, Map<number, number>>();
  for (const r of rows) {
    lapSet.add(r.lapNumber);
    if (r.degraded) degraded.add(r.lapNumber);
    let m = byDriver.get(r.driverId);
    if (!m) {
      m = new Map<number, number>();
      byDriver.set(r.driverId, m);
    }
    m.set(r.lapNumber, r.pWin);
  }
  const laps = [...lapSet].sort((a, b) => a - b);
  const order = await loadDriverOrder(sessionId);
  const series: WinProbSeries[] = [];
  for (const d of order) {
    const m = byDriver.get(d.driverId);
    if (!m) continue;
    series.push({
      driverId: d.driverId,
      code: d.code,
      fullName: d.fullName,
      lineStyle: d.lineStyle,
      teamId: d.teamId,
      teamName: d.teamName,
      teamColour: d.teamColour,
      p: laps.map((l) => m.get(l) ?? null),
    });
  }
  if (series.length === 0) return null;
  return {
    laps,
    series,
    degradedLaps: [...degraded].sort((a, b) => a - b),
    modelVersion: run.modelVersion,
  };
}

const SWING_CAUSES = new Set([
  "safety_car",
  "vsc",
  "red_flag",
  "pit_cycle",
  "retirement",
  "on_track",
]);

function asSwingCause(s: string): WinProbSwing["cause"] {
  return (SWING_CAUSES.has(s) ? s : "on_track") as WinProbSwing["cause"];
}

/** The flagged laps of one race, biggest swing first (`rank_in_race` asc). */
export async function getWinProbSwings(sessionId: number): Promise<WinProbSwing[]> {
  const run = await currentWpRun();
  if (!run) return [];
  const rows = await db
    .select({
      lapNumber: wpSwing.lapNumber,
      swingMass: wpSwing.swingMass,
      cause: wpSwing.cause,
      moverDriverId: wpSwing.moverDriverId,
      moverPBefore: wpSwing.moverPBefore,
      moverPAfter: wpSwing.moverPAfter,
      rankInRace: wpSwing.rankInRace,
    })
    .from(wpSwing)
    .where(
      and(eq(wpSwing.sessionId, sessionId), eq(wpSwing.assumptionSetId, run.assumptionSetId)),
    )
    .orderBy(asc(wpSwing.rankInRace));
  if (rows.length === 0) return [];
  const entries = await loadEntries(sessionId);
  const out: WinProbSwing[] = [];
  for (const r of rows) {
    const mover = entries.get(r.moverDriverId);
    if (!mover) continue;
    out.push({
      lapNumber: r.lapNumber,
      swingMass: r.swingMass,
      cause: asSwingCause(r.cause),
      mover,
      pBefore: r.moverPBefore,
      pAfter: r.moverPAfter,
      rankInRace: r.rankInRace,
    });
  }
  return out;
}

/** §1.8.1 — the two evaluation scopes and the caption label each carries. */
const TRUST_SCOPES: { scope: "loro" | "loco"; label: string }[] = [
  { scope: "loro", label: "races it has not seen" },
  { scope: "loco", label: "tracks it has never visited" },
];

/**
 * `wp_run.calibration` is the config value `WP_CALIBRATION` ("none" | "isotonic"), but
 * `wp_metrics.variant` / `wp_reliability_bin.variant` are CHECKed to ("plain" | "isotonic")
 * — "none" and "plain" are the same thing under two names (MODE1_SPEC §1.7, §5.1). Filtering
 * the metrics by the raw calibration string therefore matches nothing and the whole section
 * silently empties. `f1lab/preview.py` makes the same mapping when it reads `loco_brier`.
 * (WP8 integration fix; MODE1_SPEC §11.)
 */
function variantFor(calibration: string): string {
  return calibration === "isotonic" ? "isotonic" : "plain";
}

/**
 * Calibration artifact for the current run: scalar metrics plus the reliability bins,
 * one entry per scope. Null when no run exists or neither scope has metrics.
 * `variant` is the run's own calibration setting (§1.7).
 */
export async function getWinProbTrust(): Promise<WinProbTrust | null> {
  const run = await currentWpRun();
  if (!run) return null;
  const variant = variantFor(run.calibration);
  const metricRows = await db
    .select({
      scope: wpMetrics.scope,
      brier: wpMetrics.brier,
      logLoss: wpMetrics.logLoss,
      brierBaselinePos: wpMetrics.brierBaselinePos,
      brierBaselineLead: wpMetrics.brierBaselineLead,
      brierFoldMin: wpMetrics.brierFoldMin,
      brierFoldMax: wpMetrics.brierFoldMax,
    })
    .from(wpMetrics)
    .where(
      and(
        eq(wpMetrics.assumptionSetId, run.assumptionSetId),
        eq(wpMetrics.variant, variant),
      ),
    );
  if (metricRows.length === 0) return null;
  const binRows = await db
    .select({
      scope: wpReliabilityBin.scope,
      binIndex: wpReliabilityBin.binIndex,
      binLo: wpReliabilityBin.binLo,
      binHi: wpReliabilityBin.binHi,
      nRows: wpReliabilityBin.nRows,
      meanPredicted: wpReliabilityBin.meanPredicted,
      observedRate: wpReliabilityBin.observedRate,
      observedLo: wpReliabilityBin.observedLo,
      observedHi: wpReliabilityBin.observedHi,
    })
    .from(wpReliabilityBin)
    .where(
      and(
        eq(wpReliabilityBin.assumptionSetId, run.assumptionSetId),
        eq(wpReliabilityBin.variant, variant),
      ),
    )
    .orderBy(asc(wpReliabilityBin.binIndex));

  const scopes: WinProbTrustScope[] = [];
  for (const s of TRUST_SCOPES) {
    const m = metricRows.find((r) => r.scope === s.scope);
    if (!m) continue;
    scopes.push({
      scope: s.scope,
      label: s.label,
      brier: m.brier,
      logLoss: m.logLoss,
      brierBaselinePos: m.brierBaselinePos,
      brierBaselineLead: m.brierBaselineLead,
      brierFoldMin: m.brierFoldMin ?? null,
      brierFoldMax: m.brierFoldMax ?? null,
      bins: binRows
        .filter((b) => b.scope === s.scope)
        .map((b) => ({
          binLo: b.binLo,
          binHi: b.binHi,
          nRows: b.nRows,
          meanPredicted: b.meanPredicted,
          observedRate: b.observedRate,
          observedLo: b.observedLo,
          observedHi: b.observedHi,
        })),
    });
  }
  if (scopes.length === 0) return null;
  return {
    scopes,
    skillOk: run.skillOk,
    nTrainRaces: run.nTrainRaces,
    calibration: run.calibration,
  };
}

/**
 * Detected moments for one race. Every stored row counts toward `hiddenCount`; the
 * `shown` list is the MOMENTS_MAX_PER_RACE most severe (§4.2), returned in lap order so
 * it reads alongside the trace. Empty when nothing crossed the thresholds.
 */
export async function getRaceMoments(sessionId: number): Promise<RaceMoments> {
  const rows = await db
    .select({
      lapNumber: raceMoment.lapNumber,
      momentType: raceMoment.momentType,
      driverId: raceMoment.driverId,
      otherDriverId: raceMoment.otherDriverId,
      magnitude: raceMoment.magnitude,
      magnitudeUnit: raceMoment.magnitudeUnit,
      severity: raceMoment.severity,
      confidence: raceMoment.confidence,
      detail: raceMoment.detail,
    })
    .from(raceMoment)
    .where(eq(raceMoment.sessionId, sessionId))
    .orderBy(desc(raceMoment.severity), asc(raceMoment.lapNumber));
  if (rows.length === 0) return { shown: [], hiddenCount: 0 };
  const entries = await loadEntries(sessionId);
  const shown: RaceMoment[] = [];
  for (const r of rows.slice(0, MOMENTS_MAX_PER_RACE)) {
    const driver = entries.get(r.driverId);
    if (!driver) continue;
    shown.push({
      lapNumber: r.lapNumber,
      momentType: r.momentType as RaceMoment["momentType"],
      driver,
      otherDriver: r.otherDriverId ? (entries.get(r.otherDriverId) ?? null) : null,
      magnitude: r.magnitude,
      magnitudeUnit: r.magnitudeUnit === "places" ? "places" : "s",
      confidence: r.confidence === "high" ? "high" : "likely",
      detail: r.detail,
    });
  }
  shown.sort((a, b) => a.lapNumber - b.lapNumber);
  return { shown, hiddenCount: Math.max(0, rows.length - shown.length) };
}

/** One row per dry compound with a usable slope (§4.4). Empty when nothing qualified. */
export async function getOptimalStint(sessionId: number): Promise<OptimalStintRow[]> {
  const rows = await db
    .select({
      compound: optimalStint.compound,
      slopeSPerLap: optimalStint.slopeSPerLap,
      pitLossS: optimalStint.pitLossS,
      pitLossSource: optimalStint.pitLossSource,
      optimalLaps: optimalStint.optimalLaps,
      optimalLapsLo: optimalStint.optimalLapsLo,
      optimalLapsHi: optimalStint.optimalLapsHi,
      actualMedianLaps: optimalStint.actualMedianLaps,
      slopeSource: optimalStint.slopeSource,
      nFits: optimalStint.nFits,
    })
    .from(optimalStint)
    .where(eq(optimalStint.sessionId, sessionId))
    .orderBy(asc(optimalStint.optimalLaps));
  return rows.map((r) => ({
    ...r,
    pitLossSource: r.pitLossSource === "pooled" ? "pooled" : "circuit",
    slopeSource: r.slopeSource === "pooled" ? "pooled" : "session",
    actualMedianLaps: r.actualMedianLaps ?? null,
  }));
}

/**
 * TELEMETRY_SPEC §5.6 row 1 — "absent (never attempted): the tab is **not rendered at
 * all**". For a route of its own that means `notFound()`, which the telemetry page does.
 * The race page's section nav must therefore agree, or it advertises a 404: today 158 of
 * the 160 lap-bearing sessions have never had the pass, so an unconditional tab link
 * would be dead nearly everywhere.
 *
 * The predicate is the presence of the `telemetry` key, not a row count: §5.6 gives
 * `"none"` / `"failed"` / `"dropped"` a rendered tab (one sentence, no chart frame), and
 * all three carry zero rows. Any session of the round counts, because the tab resolves
 * Q, then SQ, then R (T10 puts the flagship where it can exist).
 */
export async function roundHasTelemetryTab(year: number, round: number): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1
      FROM sessions s
      JOIN session_ingests si ON si.session_id = s.session_id
     WHERE s.year = ${year} AND s.round = ${round}
       AND si.analytics_status ? 'telemetry'
     LIMIT 1`);
  return rows.rows.length > 0;
}
