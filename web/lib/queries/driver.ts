// SPEC §3.3 — driver page queries (WP5). All functions are async, take primitives and
// return plain JSON-serialisable objects. Sign convention (§0.3 / D15): on
// `signedGapPct` / `signedGapS`, POSITIVE means THIS driver was faster than the teammate.
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  drivers,
  driverSeasonSummary,
  events,
  paceRanking,
  results,
  seasons,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
  teammateDeltas,
  teammateH2h,
} from "@/db/schema";
import { gpShortName } from "@/lib/format";
import {
  latestSeasonWithData,
  type DriverRef,
  type IngestStatus,
  type LineStyle,
  type TeamRef,
} from "@/lib/queries/shared";
import { cached } from "@/lib/cache";

export type DriverProfile = {
  driverId: string;
  code: string;
  fullName: string;
  number: string;
  countryCode: string | null;
  headshotUrl: string | null;
  /** Years with race entries, desc. */
  seasons: number[];
};

export type DriverRaceRow = {
  round: number;
  eventName: string;
  shortName: string;
  eventDate: string;
  ingestStatus: IngestStatus;
  team: TeamRef;
  gridPosition: number | null;
  position: number | null;
  classifiedPosition: string;
  status: string;
  points: number;
  sprintPoints: number | null;
  paceRank: number | null;
  medianPaceS: number | null;
  gapToP1S: number | null;
  gapToP1Pct: number | null;
  sensRankLo: number | null;
  sensRankHi: number | null;
  teammate: DriverRef | null;
  /** + = this driver faster than the teammate. */
  signedGapPct: number | null;
  signedGapS: number | null;
  lapsCompared: number | null;
};

export type DriverSummary = {
  team: TeamRef;
  races: number;
  points: number;
  wins: number;
  podiums: number;
  dnfs: number;
  championshipPosition: number | null;
  bestFinish: number | null;
  avgFinish: number | null;
  avgGrid: number | null;
  meanPaceRank: number | null;
  racesRanked: number;
};

export type H2HRow = {
  teammate: DriverRef;
  racesPaired: number;
  paceWins: number;
  paceLosses: number;
  meanSignedGapPct: number | null;
  medianSignedGapPct: number | null;
  finishWins: number;
  finishLosses: number;
  gridWins: number;
  gridLosses: number;
  pointsFor: number;
  pointsAgainst: number;
};

export type DriverSeason = {
  profile: DriverProfile;
  year: number;
  mixedAssumptionSets: boolean;
  summary: DriverSummary | null;
  races: DriverRaceRow[];
  h2h: H2HRow[];
};

function asLineStyle(s: string): LineStyle {
  return s === "dashed" || s === "dotted" ? s : "solid";
}

function asIngestStatus(s: string | null): IngestStatus {
  return s === "ok" || s === "partial" || s === "failed" ? s : "pending";
}

/** Years in which the driver has at least one race-session entry, newest first. */
async function seasonsWithRaceEntries(driverId: string): Promise<number[]> {
  const rows = await db
    .selectDistinct({ year: sessions.year })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
    .where(and(eq(sessionEntries.driverId, driverId), eq(sessions.kind, "R")))
    .orderBy(desc(sessions.year));
  return rows.map((r) => r.year);
}

/**
 * `code` is upper-cased. The driver is looked up via `session_entries.code` within `year`
 * (defaulting to the latest season with data), falling back to `drivers.latest_code`.
 * The returned year is the requested one, else the driver's latest season with race entries.
 */
async function resolveDriverRaw(
  code: string,
  year: number | null,
): Promise<{ driverId: string; year: number } | null> {
  const upper = code.toUpperCase();
  const lookupYear = year ?? (await latestSeasonWithData());

  let driverId: string | null = null;
  if (lookupYear !== null) {
    const rows = await db
      .select({ driverId: sessionEntries.driverId })
      .from(sessionEntries)
      .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
      .where(and(eq(sessionEntries.code, upper), eq(sessions.year, lookupYear)))
      .orderBy(desc(sessions.round))
      .limit(1);
    driverId = rows[0]?.driverId ?? null;
  }
  if (driverId === null) {
    const rows = await db
      .select({ driverId: drivers.driverId })
      .from(drivers)
      .where(eq(drivers.latestCode, upper))
      .orderBy(asc(drivers.driverId))
      .limit(1);
    driverId = rows[0]?.driverId ?? null;
  }
  if (driverId === null) return null;

  if (year !== null) return { driverId, year };
  const years = await seasonsWithRaceEntries(driverId);
  const latest = years[0];
  if (latest === undefined) return null;
  return { driverId, year: latest };
}
export const resolveDriver = cached("driver.resolveDriver", resolveDriverRaw);

/** Null only when the `drivers` row is missing; an empty season renders with empty sections. */
async function getDriverSeasonRaw(
  driverId: string,
  year: number,
): Promise<DriverSeason | null> {
  const driverRows = await db
    .select()
    .from(drivers)
    .where(eq(drivers.driverId, driverId))
    .limit(1);
  const d = driverRows[0];
  if (!d) return null;

  const [years, seasonRows, summaryRows, raceRows, sprintRows, h2hRows] = await Promise.all([
    seasonsWithRaceEntries(driverId),
    db
      .select({ mixed: seasons.mixedAssumptionSets })
      .from(seasons)
      .where(eq(seasons.year, year))
      .limit(1),
    db
      .select()
      .from(driverSeasonSummary)
      .where(and(eq(driverSeasonSummary.year, year), eq(driverSeasonSummary.driverId, driverId)))
      .limit(1),
    // One row per race session the driver was entered in this year.
    db
      .select({
        sessionId: sessions.sessionId,
        round: sessions.round,
        eventName: events.eventName,
        eventDate: events.eventDate,
        ingestStatus: sessionIngests.status,
        teamId: sessionTeams.teamId,
        teamName: sessionTeams.teamName,
        teamColour: sessionTeams.colour,
        gridPosition: results.gridPosition,
        position: results.position,
        classifiedPosition: results.classifiedPosition,
        status: results.status,
        points: results.points,
        paceRank: paceRanking.rank,
        medianPaceS: paceRanking.medianPaceS,
        gapToP1S: paceRanking.gapS,
        gapToP1Pct: paceRanking.gapPct,
        sensRankLo: paceRanking.sensRankLo,
        sensRankHi: paceRanking.sensRankHi,
      })
      .from(sessions)
      .innerJoin(
        sessionEntries,
        and(
          eq(sessionEntries.sessionId, sessions.sessionId),
          eq(sessionEntries.driverId, driverId),
        ),
      )
      .innerJoin(
        events,
        and(eq(events.year, sessions.year), eq(events.round, sessions.round)),
      )
      .innerJoin(
        sessionTeams,
        and(
          eq(sessionTeams.sessionId, sessions.sessionId),
          eq(sessionTeams.teamId, sessionEntries.teamId),
        ),
      )
      .leftJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
      .leftJoin(
        results,
        and(eq(results.sessionId, sessions.sessionId), eq(results.driverId, driverId)),
      )
      .leftJoin(
        paceRanking,
        and(eq(paceRanking.sessionId, sessions.sessionId), eq(paceRanking.driverId, driverId)),
      )
      .where(and(eq(sessions.year, year), eq(sessions.kind, "R")))
      .orderBy(asc(sessions.round)),
    // Sprint points per round (kind='S' results for this driver).
    db
      .select({ round: sessions.round, points: results.points })
      .from(sessions)
      .innerJoin(
        results,
        and(eq(results.sessionId, sessions.sessionId), eq(results.driverId, driverId)),
      )
      .where(and(eq(sessions.year, year), eq(sessions.kind, "S"))),
    db
      .select()
      .from(teammateH2h)
      .where(and(eq(teammateH2h.year, year), eq(teammateH2h.driverId, driverId)))
      .orderBy(desc(teammateH2h.racesPaired), asc(teammateH2h.teammateDriverId)),
  ]);

  const sessionIds = raceRows.map((r) => r.sessionId);

  // Teammate deltas for those sessions where this driver is one side of the pair.
  const deltaRows =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(teammateDeltas)
          .where(
            and(
              inArray(teammateDeltas.sessionId, sessionIds),
              or(
                eq(teammateDeltas.fasterDriverId, driverId),
                eq(teammateDeltas.slowerDriverId, driverId),
              ),
            ),
          );
  const deltaBySession = new Map(deltaRows.map((r) => [r.sessionId, r]));

  // DriverRefs for every teammate appearing in a delta or an H2H row, resolved from the
  // session entries of the same year (code, line style and team colour as they were then).
  const teammateIds = new Set<string>();
  for (const r of deltaRows) {
    teammateIds.add(r.fasterDriverId === driverId ? r.slowerDriverId : r.fasterDriverId);
  }
  for (const r of h2hRows) teammateIds.add(r.teammateDriverId);

  const teammateEntries =
    teammateIds.size === 0
      ? []
      : await db
          .select({
            sessionId: sessions.sessionId,
            round: sessions.round,
            driverId: sessionEntries.driverId,
            code: sessionEntries.code,
            lineStyle: sessionEntries.lineStyle,
            fullName: drivers.fullName,
            teamId: sessionTeams.teamId,
            teamName: sessionTeams.teamName,
            teamColour: sessionTeams.colour,
          })
          .from(sessionEntries)
          .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
          .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
          .innerJoin(
            sessionTeams,
            and(
              eq(sessionTeams.sessionId, sessionEntries.sessionId),
              eq(sessionTeams.teamId, sessionEntries.teamId),
            ),
          )
          .where(
            and(
              inArray(sessionEntries.driverId, [...teammateIds]),
              eq(sessions.year, year),
              eq(sessions.kind, "R"),
            ),
          )
          .orderBy(asc(sessions.round));

  const toRef = (e: (typeof teammateEntries)[number]): DriverRef => ({
    driverId: e.driverId,
    code: e.code,
    fullName: e.fullName,
    lineStyle: asLineStyle(e.lineStyle),
    teamId: e.teamId,
    teamName: e.teamName,
    teamColour: e.teamColour,
  });
  // (sessionId, driverId) -> ref for the race rows; per driver, the latest entry for a team
  // (and the latest overall) for the H2H cards.
  const refBySessionDriver = new Map<string, DriverRef>();
  const latestRefByDriverTeam = new Map<string, DriverRef>();
  const latestRefByDriver = new Map<string, DriverRef>();
  for (const e of teammateEntries) {
    const ref = toRef(e);
    refBySessionDriver.set(`${e.sessionId}|${e.driverId}`, ref);
    latestRefByDriverTeam.set(`${e.driverId}|${e.teamId}`, ref);
    latestRefByDriver.set(e.driverId, ref);
  }

  const sprintByRound = new Map(sprintRows.map((r) => [r.round, r.points]));

  const races: DriverRaceRow[] = raceRows.map((r) => {
    const delta = deltaBySession.get(r.sessionId) ?? null;
    let teammate: DriverRef | null = null;
    let signedGapPct: number | null = null;
    let signedGapS: number | null = null;
    let lapsCompared: number | null = null;
    if (delta) {
      const isFaster = delta.fasterDriverId === driverId;
      const mateId = isFaster ? delta.slowerDriverId : delta.fasterDriverId;
      teammate =
        refBySessionDriver.get(`${r.sessionId}|${mateId}`) ??
        latestRefByDriver.get(mateId) ??
        null;
      signedGapPct = isFaster ? delta.gapPct : -delta.gapPct;
      signedGapS = isFaster ? delta.gapS : -delta.gapS;
      lapsCompared = delta.lapsCompared;
    }
    return {
      round: r.round,
      eventName: r.eventName,
      shortName: gpShortName(r.eventName),
      eventDate: r.eventDate,
      ingestStatus: asIngestStatus(r.ingestStatus),
      team: { teamId: r.teamId, teamName: r.teamName, teamColour: r.teamColour },
      gridPosition: r.gridPosition,
      position: r.position,
      classifiedPosition: r.classifiedPosition ?? "",
      status: r.status ?? "",
      points: r.points ?? 0,
      sprintPoints: sprintByRound.get(r.round) ?? null,
      paceRank: r.paceRank,
      medianPaceS: r.medianPaceS,
      gapToP1S: r.gapToP1S,
      gapToP1Pct: r.gapToP1Pct,
      sensRankLo: r.sensRankLo,
      sensRankHi: r.sensRankHi,
      teammate,
      signedGapPct,
      signedGapS,
      lapsCompared,
    };
  });

  const s = summaryRows[0];
  const summary: DriverSummary | null = s
    ? {
        team: { teamId: s.teamId, teamName: s.teamName, teamColour: s.teamColour },
        races: s.races,
        points: s.points,
        wins: s.wins,
        podiums: s.podiums,
        dnfs: s.dnfs,
        championshipPosition: s.championshipPosition,
        bestFinish: s.bestFinish,
        avgFinish: s.avgFinish,
        avgGrid: s.avgGrid,
        meanPaceRank: s.meanPaceRank,
        racesRanked: s.racesRanked,
      }
    : null;

  const h2h: H2HRow[] = [];
  for (const r of h2hRows) {
    const ref =
      latestRefByDriverTeam.get(`${r.teammateDriverId}|${r.teamId}`) ??
      latestRefByDriver.get(r.teammateDriverId);
    if (!ref) continue; // no entry for the teammate this year: nothing to name the card with
    h2h.push({
      teammate: ref,
      racesPaired: r.racesPaired,
      paceWins: r.paceWins,
      paceLosses: r.paceLosses,
      meanSignedGapPct: r.meanSignedGapPct,
      medianSignedGapPct: r.medianSignedGapPct,
      finishWins: r.finishWins,
      finishLosses: r.finishLosses,
      gridWins: r.gridWins,
      gridLosses: r.gridLosses,
      pointsFor: r.pointsFor,
      pointsAgainst: r.pointsAgainst,
    });
  }

  // The code shown for this season: the driver's entry code in this year, else latest_code.
  const codeRows = await db
    .select({ code: sessionEntries.code })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
    .where(and(eq(sessionEntries.driverId, driverId), eq(sessions.year, year)))
    .orderBy(desc(sessions.round))
    .limit(1);

  return {
    profile: {
      driverId: d.driverId,
      code: codeRows[0]?.code ?? d.latestCode,
      fullName: d.fullName,
      number: d.latestNumber,
      countryCode: d.countryCode,
      headshotUrl: d.headshotUrl,
      seasons: years,
    },
    year,
    mixedAssumptionSets: seasonRows[0]?.mixed ?? false,
    summary,
    races,
    h2h,
  };
}
export const getDriverSeason = cached("driver.getDriverSeason", getDriverSeasonRaw);
