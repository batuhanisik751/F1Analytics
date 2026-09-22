// SPEC §3.3 — shared row types and helpers used by every page package. FROZEN after WP0.
// All functions are async, take primitives and return plain JSON-serialisable objects.
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { events, seasons, sessionIngests, sessions } from "@/db/schema";
import type { ColourMap, LineStyle } from "@/lib/colours";
import { cached } from "@/lib/cache";

export type IngestStatus = "pending" | "ok" | "partial" | "failed";
export type { LineStyle, ColourMap };
export type TeamRef = { teamId: string; teamName: string; teamColour: string };
export type DriverRef = TeamRef & {
  driverId: string;
  code: string;
  fullName: string;
  lineStyle: LineStyle;
};
export type RaceNavLink = { year: number; round: number; eventName: string };

/** Years with `seasons.ingested_rounds > 0`, newest first. */
async function seasonsWithDataRaw(): Promise<number[]> {
  const rows = await db
    .select({ year: seasons.year })
    .from(seasons)
    .where(gt(seasons.ingestedRounds, 0))
    .orderBy(desc(seasons.year));
  return rows.map((r) => r.year);
}
export const seasonsWithData = cached("shared.seasonsWithData", seasonsWithDataRaw);

async function latestSeasonWithDataRaw(): Promise<number | null> {
  const years = await seasonsWithData();
  return years[0] ?? null;
}
export const latestSeasonWithData = cached("shared.latestSeasonWithData", latestSeasonWithDataRaw);

/**
 * The highest round whose RACE session has `session_ingests.status in ('ok','partial')`.
 * With `year` omitted, the latest such round across all seasons (year desc, round desc).
 */
async function getLatestRaceRaw(year?: number): Promise<RaceNavLink | null> {
  const conditions = [
    eq(sessions.kind, "R"),
    inArray(sessionIngests.status, ["ok", "partial"]),
  ];
  if (year !== undefined) conditions.push(eq(sessions.year, year));
  const rows = await db
    .select({
      year: sessions.year,
      round: sessions.round,
      eventName: events.eventName,
    })
    .from(sessions)
    .innerJoin(sessionIngests, eq(sessionIngests.sessionId, sessions.sessionId))
    .innerJoin(
      events,
      and(eq(events.year, sessions.year), eq(events.round, sessions.round)),
    )
    .where(and(...conditions))
    .orderBy(desc(sessions.year), desc(sessions.round))
    .limit(1);
  return rows[0] ?? null;
}
export const getLatestRace = cached("shared.getLatestRace", getLatestRaceRaw);

/** `sessions.session_id` for (year, round, kind); kind defaults to 'R'. Null when no sessions row exists. */
async function sessionIdForRaw(
  year: number,
  round: number,
  kind: "R" | "S" = "R",
): Promise<number | null> {
  const rows = await db
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(
      and(eq(sessions.year, year), eq(sessions.round, round), eq(sessions.kind, kind)),
    )
    .limit(1);
  return rows[0]?.sessionId ?? null;
}
export const sessionIdFor = cached("shared.sessionIdFor", sessionIdForRaw);
