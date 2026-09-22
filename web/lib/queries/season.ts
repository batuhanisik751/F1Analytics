// SPEC §3.3 — season queries (WP3): getRaceList, getStandings, getSeason.
// Read-only selects over the frozen schema; every row is a plain JSON-serialisable object.
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cached } from "@/lib/cache";
import { db } from "@/db/client";
import {
  assumptionSets,
  circuits,
  constructorStandings,
  driverStandings,
  drivers,
  events,
  seasons,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
  titleClinch,
  titleOdds,
} from "@/db/schema";
import type { DriverRef, IngestStatus, LineStyle } from "@/lib/queries/shared";

export type RaceListRow = {
  year: number;
  round: number;
  eventName: string;
  location: string;
  country: string;
  circuitShortName: string | null;
  eventDate: string;
  eventFormat: string;
  hasSprint: boolean;
  totalLaps: number | null;
  ingestStatus: IngestStatus;
  winner: DriverRef | null;
  fastestPace: DriverRef | null;
};

export type StandingRow = {
  position: number;
  driverId: string;
  code: string;
  fullName: string;
  teamId: string;
  teamName: string;
  teamColour: string;
  points: number;
  sprintPoints: number;
  wins: number;
  podiums: number;
  races: number;
};

export type ConstructorRow = {
  position: number;
  teamId: string;
  teamName: string;
  teamColour: string;
  points: number;
  wins: number;
  podiums: number;
};

export type SeasonData = {
  year: number;
  scheduledRounds: number;
  ingestedRounds: number;
  afterRound: number | null;
  /** `seasons.recomputed_at`: null until season.recompute ran for this year (a recompute with
   *  zero ingested rounds sets it while leaving afterRound null). */
  recomputedAt: string | null;
  hasSprintResults: boolean;
  mixedAssumptionSets: boolean;
  drivers: StandingRow[];
  constructors: ConstructorRow[];
  races: RaceListRow[]; // all scheduled rounds asc
};

/** `session_ingests.status` is 'ok' | 'partial' | 'failed'; a missing row means the round is pending. */
export function toIngestStatus(status: string | null | undefined): IngestStatus {
  return status === "ok" || status === "partial" || status === "failed" ? status : "pending";
}

function toLineStyle(style: string | null | undefined): LineStyle {
  return style === "dashed" || style === "dotted" ? style : "solid";
}

/** Nullable pieces from a chain of LEFT JOINs → a DriverRef, or null when the driver is absent. */
export function driverRefOrNull(p: {
  driverId: string | null;
  code: string | null;
  fullName: string | null;
  lineStyle: string | null;
  teamId: string | null;
  teamName: string | null;
  teamColour: string | null;
}): DriverRef | null {
  if (
    p.driverId === null ||
    p.code === null ||
    p.fullName === null ||
    p.teamId === null ||
    p.teamName === null ||
    p.teamColour === null
  ) {
    return null;
  }
  return {
    driverId: p.driverId,
    code: p.code,
    fullName: p.fullName,
    lineStyle: toLineStyle(p.lineStyle),
    teamId: p.teamId,
    teamName: p.teamName,
    teamColour: p.teamColour,
  };
}

/**
 * Every scheduled round of `year`, ascending, with the race session's ingest state and the
 * winner / fastest-pace drivers as they were identified in that session (session_entries +
 * session_teams give the code, team name and colour of the day; drivers gives the full name).
 */
async function getRaceListRaw(year: number): Promise<RaceListRow[]> {
  const sprint = alias(sessions, "sprint");
  const wEntry = alias(sessionEntries, "w_entry");
  const wTeam = alias(sessionTeams, "w_team");
  const wDriver = alias(drivers, "w_driver");
  const pEntry = alias(sessionEntries, "p_entry");
  const pTeam = alias(sessionTeams, "p_team");
  const pDriver = alias(drivers, "p_driver");

  const rows = await db
    .select({
      year: events.year,
      round: events.round,
      eventName: events.eventName,
      location: events.location,
      country: events.country,
      circuitShortName: circuits.shortName,
      eventDate: events.eventDate,
      eventFormat: events.eventFormat,
      sprintSessionId: sprint.sessionId,
      totalLaps: sessions.totalLaps,
      ingestStatus: sessionIngests.status,
      winner: {
        driverId: sessions.winnerDriverId,
        code: wEntry.code,
        fullName: wDriver.fullName,
        lineStyle: wEntry.lineStyle,
        teamId: wTeam.teamId,
        teamName: wTeam.teamName,
        teamColour: wTeam.colour,
      },
      fastestPace: {
        driverId: sessions.fastestPaceDriverId,
        code: pEntry.code,
        fullName: pDriver.fullName,
        lineStyle: pEntry.lineStyle,
        teamId: pTeam.teamId,
        teamName: pTeam.teamName,
        teamColour: pTeam.colour,
      },
    })
    .from(events)
    .leftJoin(
      sessions,
      and(eq(sessions.year, events.year), eq(sessions.round, events.round), eq(sessions.kind, "R")),
    )
    .leftJoin(
      sprint,
      and(eq(sprint.year, events.year), eq(sprint.round, events.round), eq(sprint.kind, "S")),
    )
    .leftJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .leftJoin(circuits, eq(circuits.circuitKey, events.circuitKey))
    .leftJoin(
      wEntry,
      and(eq(wEntry.sessionId, sessions.sessionId), eq(wEntry.driverId, sessions.winnerDriverId)),
    )
    .leftJoin(wTeam, and(eq(wTeam.sessionId, sessions.sessionId), eq(wTeam.teamId, wEntry.teamId)))
    .leftJoin(wDriver, eq(wDriver.driverId, sessions.winnerDriverId))
    .leftJoin(
      pEntry,
      and(
        eq(pEntry.sessionId, sessions.sessionId),
        eq(pEntry.driverId, sessions.fastestPaceDriverId),
      ),
    )
    .leftJoin(pTeam, and(eq(pTeam.sessionId, sessions.sessionId), eq(pTeam.teamId, pEntry.teamId)))
    .leftJoin(pDriver, eq(pDriver.driverId, sessions.fastestPaceDriverId))
    .where(eq(events.year, year))
    .orderBy(asc(events.round));

  return rows.map((r) => ({
    year: r.year,
    round: r.round,
    eventName: r.eventName,
    location: r.location,
    country: r.country,
    circuitShortName: r.circuitShortName ?? null,
    eventDate: r.eventDate,
    eventFormat: r.eventFormat,
    hasSprint: r.sprintSessionId !== null,
    totalLaps: r.totalLaps ?? null,
    ingestStatus: toIngestStatus(r.ingestStatus),
    winner: driverRefOrNull(r.winner),
    fastestPace: driverRefOrNull(r.fastestPace),
  }));
}
export const getRaceList = cached("season.getRaceList", getRaceListRaw);

/**
 * Standings snapshot at `seasons.standings_after_round`; null until `season.recompute` has run
 * for the year (no seasons row, or `standings_after_round` still NULL).
 */
async function getStandingsRaw(
  year: number,
): Promise<{ afterRound: number; drivers: StandingRow[]; constructors: ConstructorRow[] } | null> {
  const season = await db
    .select({ afterRound: seasons.standingsAfterRound })
    .from(seasons)
    .where(eq(seasons.year, year))
    .limit(1);
  const afterRound = season[0]?.afterRound ?? null;
  if (afterRound === null) return null;

  const [driverRows, constructorRows] = await Promise.all([
    db
      .select({
        position: driverStandings.position,
        driverId: driverStandings.driverId,
        code: drivers.latestCode,
        fullName: drivers.fullName,
        teamId: driverStandings.teamId,
        teamName: driverStandings.teamName,
        teamColour: driverStandings.teamColour,
        points: driverStandings.points,
        sprintPoints: driverStandings.sprintPoints,
        wins: driverStandings.wins,
        podiums: driverStandings.podiums,
        races: driverStandings.races,
      })
      .from(driverStandings)
      .innerJoin(drivers, eq(drivers.driverId, driverStandings.driverId))
      .where(and(eq(driverStandings.year, year), eq(driverStandings.afterRound, afterRound)))
      .orderBy(asc(driverStandings.position)),
    db
      .select({
        position: constructorStandings.position,
        teamId: constructorStandings.teamId,
        teamName: constructorStandings.teamName,
        teamColour: constructorStandings.teamColour,
        points: constructorStandings.points,
        wins: constructorStandings.wins,
        podiums: constructorStandings.podiums,
      })
      .from(constructorStandings)
      .where(
        and(eq(constructorStandings.year, year), eq(constructorStandings.afterRound, afterRound)),
      )
      .orderBy(asc(constructorStandings.position)),
  ]);

  return { afterRound, drivers: driverRows, constructors: constructorRows };
}
export const getStandings = cached("season.getStandings", getStandingsRaw);

/** Everything the season page needs; null when the `seasons` row is missing (→ 404). */
async function getSeasonRaw(year: number): Promise<SeasonData | null> {
  const rows = await db
    .select({
      year: seasons.year,
      scheduledRounds: seasons.scheduledRounds,
      ingestedRounds: seasons.ingestedRounds,
      afterRound: seasons.standingsAfterRound,
      recomputedAt: seasons.recomputedAt,
      hasSprintResults: seasons.hasSprintResults,
      mixedAssumptionSets: seasons.mixedAssumptionSets,
    })
    .from(seasons)
    .where(eq(seasons.year, year))
    .limit(1);
  const season = rows[0];
  if (!season) return null;

  const [races, standings] = await Promise.all([getRaceList(year), getStandings(year)]);

  return {
    year: season.year,
    scheduledRounds: season.scheduledRounds,
    ingestedRounds: season.ingestedRounds,
    afterRound: season.afterRound ?? null,
    recomputedAt: season.recomputedAt ?? null,
    hasSprintResults: season.hasSprintResults,
    mixedAssumptionSets: season.mixedAssumptionSets,
    drivers: standings?.drivers ?? [],
    constructors: standings?.constructors ?? [],
    races,
  };
}
export const getSeason = cached("season.getSeason", getSeasonRaw);

// ---------------------------------------------------------------------------
// MODE1_SPEC §2 / §7.2 — title odds (simulated) and magic numbers (exact arithmetic).
// Two different kinds of claim, two tables, two queries, two components (FD4).
// ---------------------------------------------------------------------------

/** §7.2: the odds chart draws at most this many drivers; the rest are one grey band. */
export const TITLE_CHART_MAX = 8;

export type TitleOddsSeries = DriverRef & {
  /** indexed by TitleOdds.rounds */
  p: number[];
  pLo: number[];
  pHi: number[];
};

export type TitleOdds = {
  rounds: number[];
  /** ordered by final p, capped at TITLE_CHART_MAX */
  series: TitleOddsSeries[];
  /** the rest, summed per round, drawn as one grey band; null when nobody was dropped */
  othersCombined: number[] | null;
  draws: number;
  bootstrapRefits: number;
};

export type TitleClinchRow = DriverRef & {
  pointsNow: number;
  maxAvailable: number;
  maxPossibleTotal: number;
  isEliminated: boolean;
  eliminatedAtRound: number | null;
  hasClinched: boolean;
};

export type TitleClinch = {
  afterRound: number;
  leader: DriverRef;
  rows: TitleClinchRow[];
  clinchMarginNeeded: number | null;
  swingNeeded: number | null;
  clinchPosition: number | null;
  earliestClinchRound: number | null;
  nextRoundHasSprint: boolean;
  racePointsMax: number;
  sprintPointsMax: number;
  hasFastestLapBonus: boolean;
  /** §7.5 caption tokens; derived from `sessions` with round > afterRound (§2.5). */
  racesLeft: number;
  sprintsLeft: number;
  /** the champion, once someone has clinched, and the first round at which it was true */
  champion: DriverRef | null;
  clinchedAtRound: number | null;
};

/**
 * A `DriverRef` for every driver who appears anywhere in `year`'s standings, using the
 * most recent round's team identity (colours come from the row, never a constant) and the
 * most recent session entry's line style. Returns an empty map when the season has no
 * standings yet.
 */
async function seasonDriverRefs(year: number): Promise<Map<string, DriverRef>> {
  const [standingRows, entryRows] = await Promise.all([
    db
      .select({
        afterRound: driverStandings.afterRound,
        driverId: driverStandings.driverId,
        code: drivers.latestCode,
        fullName: drivers.fullName,
        teamId: driverStandings.teamId,
        teamName: driverStandings.teamName,
        teamColour: driverStandings.teamColour,
      })
      .from(driverStandings)
      .innerJoin(drivers, eq(drivers.driverId, driverStandings.driverId))
      .where(eq(driverStandings.year, year))
      .orderBy(asc(driverStandings.afterRound)),
    db
      .select({
        driverId: sessionEntries.driverId,
        code: sessionEntries.code,
        lineStyle: sessionEntries.lineStyle,
      })
      .from(sessionEntries)
      .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
      .where(eq(sessions.year, year))
      .orderBy(asc(sessionEntries.sessionId)),
  ]);

  // Both lists are ascending, so a plain overwrite leaves the latest value per driver.
  const entry = new Map<string, { code: string; lineStyle: LineStyle }>();
  for (const e of entryRows) {
    entry.set(e.driverId, { code: e.code, lineStyle: toLineStyle(e.lineStyle) });
  }
  const refs = new Map<string, DriverRef>();
  for (const r of standingRows) {
    const e = entry.get(r.driverId);
    refs.set(r.driverId, {
      driverId: r.driverId,
      code: e?.code ?? r.code,
      fullName: r.fullName,
      lineStyle: e?.lineStyle ?? "solid",
      teamId: r.teamId,
      teamName: r.teamName,
      teamColour: r.teamColour,
    });
  }
  return refs;
}

/**
 * §2.4 — the Monte Carlo. One point estimate and a bootstrap band per driver per round.
 * Null when `title_odds` holds nothing for the year (no completed rounds, or θ was not
 * identifiable); the section picks the §7.6 reason from the season's round count.
 * `bootstrapRefits` is TITLE_THETA_BOOTSTRAP read off the run's own assumption snapshot.
 */
async function getTitleOddsRaw(year: number): Promise<TitleOdds | null> {
  const rows = await db
    .select({
      afterRound: titleOdds.afterRound,
      driverId: titleOdds.driverId,
      p: titleOdds.pTitle,
      pLo: titleOdds.pTitleLo,
      pHi: titleOdds.pTitleHi,
      draws: titleOdds.draws,
      params: assumptionSets.params,
    })
    .from(titleOdds)
    .innerJoin(assumptionSets, eq(assumptionSets.assumptionSetId, titleOdds.assumptionSetId))
    .where(eq(titleOdds.year, year))
    .orderBy(asc(titleOdds.afterRound));
  if (rows.length === 0) return null;

  const rounds = [...new Set(rows.map((r) => r.afterRound))].sort((a, b) => a - b);
  const indexOf = new Map(rounds.map((r, i) => [r, i] as const));
  const refs = await seasonDriverRefs(year);

  const byDriver = new Map<string, { p: number[]; pLo: number[]; pHi: number[] }>();
  for (const r of rows) {
    let s = byDriver.get(r.driverId);
    if (!s) {
      s = {
        p: new Array<number>(rounds.length).fill(0),
        pLo: new Array<number>(rounds.length).fill(0),
        pHi: new Array<number>(rounds.length).fill(0),
      };
      byDriver.set(r.driverId, s);
    }
    const i = indexOf.get(r.afterRound);
    if (i === undefined) continue;
    s.p[i] = r.p;
    s.pLo[i] = r.pLo;
    s.pHi[i] = r.pHi;
  }

  const all: TitleOddsSeries[] = [];
  for (const [driverId, s] of byDriver) {
    const ref = refs.get(driverId);
    if (!ref) continue; // a driver with odds but no standings row cannot be drawn
    all.push({ ...ref, ...s });
  }
  const last = rounds.length - 1;
  // Final-round p is the right primary key, but on a DECIDED season it is 1.0 for the
  // champion and exactly 0.0 for all 23 others, so the tiebreak chose the whole chart.
  // Alphabetical then drew Albon, Alonso, Bearman, Bottas, Colapinto, Doohan and Gasly —
  // seven flat zeros — while Leclerc (peaked 0.35) and Perez (0.27), the drivers who
  // actually contested the title, vanished into "Everyone else". Breaking the tie on the
  // driver's PEAK odds across the season picks whoever was ever in contention, and on a
  // live season, where final-round p already separates everyone, it changes nothing.
  const peak = new Map(all.map((s) => [s.driverId, Math.max(...s.p)]));
  all.sort(
    (a, b) =>
      b.p[last] - a.p[last] ||
      (peak.get(b.driverId) as number) - (peak.get(a.driverId) as number) ||
      a.code.localeCompare(b.code),
  );

  const series = all.slice(0, TITLE_CHART_MAX);
  const rest = all.slice(TITLE_CHART_MAX);
  const othersCombined =
    rest.length === 0
      ? null
      : rounds.map((_, i) => rest.reduce((acc, s) => acc + s.p[i], 0));

  const draws = rows.reduce((acc, r) => Math.max(acc, r.draws), 0);
  const refits = Number(rows[0]?.params?.TITLE_THETA_BOOTSTRAP ?? 0);

  return {
    rounds,
    series,
    othersCombined,
    draws,
    bootstrapRefits: Number.isFinite(refits) ? refits : 0,
  };
}
export const getTitleOdds = cached("season.getTitleOdds", getTitleOddsRaw);

/**
 * §2.5 — exact arithmetic at the latest `after_round` stored for the year. Nothing here
 * comes from the Monte Carlo. The scalar clinch fields live on the leader's row; rows are
 * returned ordered by points descending (the standings order the arithmetic is read in).
 * `racesLeft` / `sprintsLeft` are counted from `sessions` with `round > after_round`.
 */
async function getTitleClinchRaw(year: number): Promise<TitleClinch | null> {
  const latest = await db
    .select({ afterRound: titleClinch.afterRound })
    .from(titleClinch)
    .where(eq(titleClinch.year, year))
    .orderBy(desc(titleClinch.afterRound))
    .limit(1);
  const afterRound = latest[0]?.afterRound;
  if (afterRound === undefined) return null;

  const rows = await db
    .select({
      driverId: titleClinch.driverId,
      pointsNow: titleClinch.pointsNow,
      maxAvailable: titleClinch.maxAvailable,
      maxPossibleTotal: titleClinch.maxPossibleTotal,
      leaderPoints: titleClinch.leaderPoints,
      isEliminated: titleClinch.isEliminated,
      eliminatedAtRound: titleClinch.eliminatedAtRound,
      hasClinched: titleClinch.hasClinched,
      clinchMarginNeeded: titleClinch.clinchMarginNeeded,
      swingNeeded: titleClinch.swingNeeded,
      clinchPosition: titleClinch.clinchPosition,
      earliestClinchRound: titleClinch.earliestClinchRound,
      nextRoundHasSprint: titleClinch.nextRoundHasSprint,
      racePointsMax: titleClinch.racePointsMax,
      sprintPointsMax: titleClinch.sprintPointsMax,
      hasFastestLapBonus: titleClinch.hasFastestLapBonus,
    })
    .from(titleClinch)
    .where(and(eq(titleClinch.year, year), eq(titleClinch.afterRound, afterRound)))
    .orderBy(desc(titleClinch.pointsNow));
  if (rows.length === 0) return null;

  const refs = await seasonDriverRefs(year);
  const out: TitleClinchRow[] = [];
  for (const r of rows) {
    const ref = refs.get(r.driverId);
    if (!ref) continue;
    out.push({
      ...ref,
      pointsNow: r.pointsNow,
      maxAvailable: r.maxAvailable,
      maxPossibleTotal: r.maxPossibleTotal,
      isEliminated: r.isEliminated,
      eliminatedAtRound: r.eliminatedAtRound ?? null,
      hasClinched: r.hasClinched,
    });
  }
  if (out.length === 0) return null;

  // The leader is the driver on `leader_points`; the rows are already points-descending.
  const head = rows[0];
  const leaderRow = rows.find((r) => r.pointsNow === r.leaderPoints) ?? head;
  const leader = refs.get(leaderRow.driverId);
  if (!leader) return null;

  const clinchedRows = await db
    .select({ afterRound: titleClinch.afterRound, driverId: titleClinch.driverId })
    .from(titleClinch)
    .where(and(eq(titleClinch.year, year), eq(titleClinch.hasClinched, true)))
    .orderBy(asc(titleClinch.afterRound))
    .limit(1);
  const clinched = clinchedRows[0];
  const champion = clinched ? (refs.get(clinched.driverId) ?? null) : null;

  const remaining = await db
    .select({ kind: sessions.kind })
    .from(sessions)
    .where(and(eq(sessions.year, year), gt(sessions.round, afterRound)));

  return {
    afterRound,
    leader,
    rows: out,
    clinchMarginNeeded: leaderRow.clinchMarginNeeded ?? null,
    swingNeeded: leaderRow.swingNeeded ?? null,
    clinchPosition: leaderRow.clinchPosition ?? null,
    earliestClinchRound: leaderRow.earliestClinchRound ?? null,
    nextRoundHasSprint: leaderRow.nextRoundHasSprint,
    racePointsMax: leaderRow.racePointsMax,
    sprintPointsMax: leaderRow.sprintPointsMax,
    hasFastestLapBonus: leaderRow.hasFastestLapBonus,
    racesLeft: remaining.filter((s) => s.kind === "R").length,
    sprintsLeft: remaining.filter((s) => s.kind === "S").length,
    champion,
    clinchedAtRound: champion ? (clinched?.afterRound ?? null) : null,
  };
}
export const getTitleClinch = cached("season.getTitleClinch", getTitleClinchRaw);
