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
import { getPreviewOrder, getPreviewRound } from "@/lib/queries/preview";
import {
  getEventLoadRows,
  staleRoundFrom,
  todayUtc,
  type EventLoadRow,
  type StaleRound,
} from "@/lib/queries/release";
import type { DriverRef } from "@/lib/queries/shared";
import { latestSeasonWithData, seasonsWithData } from "@/lib/queries/shared";
import {
  driverRefOrNull,
  getRaceList,
  getStandings,
  getTitleClinch,
  getTitleOdds,
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
  thisWeek: ThisWeek;
};

// IDEAS_2026-09 §1 #1 — the "this week" strip: next event, title picture, pre-qualifying
// favourites, all from rows the nightly job already writes. Nothing here is computed.
export type NextEvent = Pick<EventLoadRow, "year" | "round" | "eventName" | "eventDate">;

export type TitlePicture = {
  afterRound: number;
  leader: string; // full name
  p: number;
  pLo: number;
  pHi: number;
  draws: number;
  /** championship points (title_clinch.points_now), never the simulated expectation */
  leaderPoints: number;
  second: { name: string; margin: number } | null;
  alive: number;
  total: number;
  clinchRound: number | null;
  clinchEvent: string | null;
};

export type Favoured = {
  names: string[]; // best expected position first, at most three
  spearman: number | null;
  gridSpearman: number | null;
};

export type ThisWeek = {
  today: string;
  /** §1 #6 — the round that raced and is not loaded, or null on a normal night */
  stale: StaleRound | null;
  next: NextEvent | null;
  title: TitlePicture | null;
  favoured: Favoured | null;
};

/** Pure: the earliest event on or after `today` whose race session is not loaded. */
export function nextEventFrom(rows: EventLoadRow[], today: string): NextEvent | null {
  let best: EventLoadRow | null = null;
  for (const r of rows) {
    if (r.eventDate < today || r.loaded) continue;
    if (best === null || r.eventDate < best.eventDate) best = r;
  }
  if (best === null) return null;
  const { year, round, eventName, eventDate } = best;
  return { year, round, eventName, eventDate };
}

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

/**
 * §1 #1 / #6 — one pass over `events`, then the title tables and the next round's preview,
 * all already computed nightly. `today` is injectable so the guard can be tested against a
 * date past the next race without touching data.
 */
export async function getThisWeek(year: number, today: string = todayUtc()): Promise<ThisWeek> {
  const rows = await getEventLoadRows();
  const stale = staleRoundFrom(rows, today);
  const next = nextEventFrom(rows, today);
  const eventNameOf = new Map(rows.map((r) => [`${r.year}:${r.round}`, r.eventName] as const));

  const [odds, clinch, preview, order] = await Promise.all([
    getTitleOdds(year),
    getTitleClinch(year),
    next ? getPreviewRound(next.year, next.round) : Promise.resolve(null),
    next ? getPreviewOrder(next.year, next.round) : Promise.resolve([]),
  ]);

  let title: TitlePicture | null = null;
  const lead = odds?.series[0];
  const last = odds ? odds.rounds.length - 1 : -1;
  if (odds && lead && last >= 0 && clinch && clinch.rows.length > 0) {
    const afterRound = odds.rounds[last];
    const leaderRow = clinch.rows.find((r) => r.driverId === clinch.leader.driverId) ?? clinch.rows[0];
    const runnerUp = clinch.rows.find((r) => r.driverId !== leaderRow.driverId) ?? null;
    title = {
      afterRound,
      leader: lead.fullName,
      p: lead.p[last],
      pLo: lead.pLo[last],
      pHi: lead.pHi[last],
      draws: odds.draws,
      leaderPoints: leaderRow.pointsNow,
      second: runnerUp
        ? { name: runnerUp.fullName, margin: leaderRow.pointsNow - runnerUp.pointsNow }
        : null,
      alive: clinch.rows.filter((r) => !r.isEliminated).length,
      total: clinch.rows.length,
      clinchRound: clinch.earliestClinchRound,
      clinchEvent:
        clinch.earliestClinchRound === null
          ? null
          : (eventNameOf.get(`${year}:${clinch.earliestClinchRound}`) ?? null),
    };
  }

  const favoured: Favoured | null =
    order.length === 0
      ? null
      : {
          names: order.slice(0, 3).map((r) => r.fullName),
          spearman: preview?.backtestSpearman ?? null,
          gridSpearman: preview?.backtestGridSpearman ?? null,
        };

  return { today, stale, next, title, favoured };
}

export async function getHome(): Promise<HomeData | null> {
  const [year, seasons] = await Promise.all([latestSeasonWithData(), seasonsWithData()]);
  if (year === null) return null;

  const [races, standings, thisWeek] = await Promise.all([
    getRaceList(year),
    getStandings(year),
    getThisWeek(year),
  ]);

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
    thisWeek,
  };
}
