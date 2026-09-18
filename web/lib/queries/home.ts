// SPEC §3.3 — home query (WP3): getHome.
// Latest season with data → its race list, the latest completed race (with podium and the
// fastest-pace runner-up), and the standings snapshot. Null when no season has data.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  drivers,
  paceRanking,
  results,
  sessionEntries,
  sessionTeams,
  sessions,
} from "@/db/schema";
import type { DriverRef } from "@/lib/queries/shared";
import { latestSeasonWithData, seasonsWithData } from "@/lib/queries/shared";
import {
  driverRefOrNull,
  getRaceList,
  getStandings,
  type ConstructorRow,
  type RaceListRow,
  type StandingRow,
} from "@/lib/queries/season";

export type HomeData = {
  year: number;
  seasons: number[];
  latest:
    | (RaceListRow & { podium: DriverRef[]; runnerUpPace: { code: string; gapS: number } | null })
    | null;
  completed: RaceListRow[]; // ingestStatus in ('ok','partial'), newest first
  afterRound: number | null;
  drivers: StandingRow[]; // top 8
  constructors: ConstructorRow[];
};

const TOP_DRIVERS = 8;

/** Positions 1–3 of the race session's results, in order, as DriverRefs of that session. */
async function getPodium(sessionId: number): Promise<DriverRef[]> {
  const rows = await db
    .select({
      driverId: results.driverId,
      code: sessionEntries.code,
      fullName: drivers.fullName,
      lineStyle: sessionEntries.lineStyle,
      teamId: sessionTeams.teamId,
      teamName: sessionTeams.teamName,
      teamColour: sessionTeams.colour,
    })
    .from(results)
    .innerJoin(
      sessionEntries,
      and(eq(sessionEntries.sessionId, results.sessionId), eq(sessionEntries.driverId, results.driverId)),
    )
    .innerJoin(
      sessionTeams,
      and(eq(sessionTeams.sessionId, results.sessionId), eq(sessionTeams.teamId, sessionEntries.teamId)),
    )
    .innerJoin(drivers, eq(drivers.driverId, results.driverId))
    .where(and(eq(results.sessionId, sessionId), inArray(results.position, [1, 2, 3])))
    .orderBy(asc(results.position));
  return rows.map(driverRefOrNull).filter((r): r is DriverRef => r !== null);
}

/** pace_ranking rank 2 of the race session: `{ code, gapS }` (gap to rank 1), or null. */
async function getRunnerUpPace(sessionId: number): Promise<{ code: string; gapS: number } | null> {
  const rows = await db
    .select({ code: sessionEntries.code, gapS: paceRanking.gapS })
    .from(paceRanking)
    .innerJoin(
      sessionEntries,
      and(
        eq(sessionEntries.sessionId, paceRanking.sessionId),
        eq(sessionEntries.driverId, paceRanking.driverId),
      ),
    )
    .where(and(eq(paceRanking.sessionId, sessionId), eq(paceRanking.rank, 2)))
    .limit(1);
  return rows[0] ?? null;
}

async function raceSessionId(year: number, round: number): Promise<number | null> {
  const rows = await db
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(and(eq(sessions.year, year), eq(sessions.round, round), eq(sessions.kind, "R")))
    .limit(1);
  return rows[0]?.sessionId ?? null;
}

export async function getHome(): Promise<HomeData | null> {
  const [year, seasons] = await Promise.all([latestSeasonWithData(), seasonsWithData()]);
  if (year === null) return null;

  const [races, standings] = await Promise.all([getRaceList(year), getStandings(year)]);

  const completed = races
    .filter((r) => r.ingestStatus === "ok" || r.ingestStatus === "partial")
    .sort((a, b) => b.round - a.round);

  let latest: HomeData["latest"] = null;
  const newest = completed[0];
  if (newest) {
    const sessionId = await raceSessionId(newest.year, newest.round);
    const [podium, runnerUpPace] =
      sessionId === null
        ? [[], null]
        : await Promise.all([getPodium(sessionId), getRunnerUpPace(sessionId)]);
    latest = { ...newest, podium, runnerUpPace };
  }

  return {
    year,
    seasons,
    latest,
    completed,
    afterRound: standings?.afterRound ?? null,
    drivers: (standings?.drivers ?? []).slice(0, TOP_DRIVERS),
    constructors: standings?.constructors ?? [],
  };
}
