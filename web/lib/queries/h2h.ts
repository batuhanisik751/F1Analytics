// H2H_SPEC §5 — the head-to-head query layer. Four cached reads, every one of them a
// SELECT over stored rows; all counting happens in `lib/driver/h2h.ts` (pure).
//
// Codes only appear in URLs; `driver_id` is the only key used in SQL. No query here
// computes a difference of two stored estimates (`gap_pct`, `rating_pp`): the ledger SQL
// returns both drivers' values side by side and `tallyLedger` only orders them.
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { cached } from "@/lib/cache";
import { db } from "@/db/client";
import {
  drivers,
  mode2DriverContrast,
  mode2FitRun,
  paceRanking,
  qualiResults,
  results,
  sessions,
} from "@/db/schema";
import { orientContrast, type ContrastRow } from "@/lib/queries/mode2";
import { tallyLedger, type Ledger, type LedgerRow } from "@/lib/driver/h2h";

export type Opponent = { driverId: string; code: string; fullName: string; headshotUrl: string | null };

/** §1: `code` must be a `drivers.latest_code` with ≥1 `results` row in a `kind='R'` session of `year`. */
async function resolveOpponentRaw(year: number, code: string): Promise<Opponent | null> {
  const rows = await db
    .select({
      driverId: drivers.driverId,
      code: drivers.latestCode,
      fullName: drivers.fullName,
      headshotUrl: drivers.headshotUrl,
    })
    .from(drivers)
    .innerJoin(results, eq(results.driverId, drivers.driverId))
    .innerJoin(sessions, eq(sessions.sessionId, results.sessionId))
    .where(and(eq(drivers.latestCode, code.toUpperCase()), eq(sessions.year, year), eq(sessions.kind, "R")))
    .limit(1);
  return rows[0] ?? null;
}
export const resolveOpponent = cached("h2h.resolveOpponent", resolveOpponentRaw);

/** Every driver with a race result in `year`, by code — the picker's option list. */
async function getOpponentsRaw(year: number): Promise<{ code: string; fullName: string }[]> {
  return db
    .selectDistinct({ code: drivers.latestCode, fullName: drivers.fullName })
    .from(drivers)
    .innerJoin(results, eq(results.driverId, drivers.driverId))
    .innerJoin(sessions, eq(sessions.sessionId, results.sessionId))
    .where(and(eq(sessions.year, year), eq(sessions.kind, "R")))
    .orderBy(asc(drivers.latestCode));
}
export const getOpponents = cached("h2h.getOpponents", getOpponentsRaw);

const resultsA = alias(results, "ra");
const resultsB = alias(results, "rb");
const qSession = alias(sessions, "q");
const qualiA = alias(qualiResults, "qa");
const qualiB = alias(qualiResults, "qb");
const paceA = alias(paceRanking, "pa");
const paceB = alias(paceRanking, "pb");

/** `pace_ranking` keeps one assumption set per session; the newest one is the current one. */
const currentPaceSet = sql`(SELECT max(${paceRanking.assumptionSetId}) FROM ${paceRanking})`;

/**
 * §2 SQL intent, one query: `sessions(R, year) ⋈ results a ⋈ results b`, then the round's
 * `kind='Q'` session (never `SQ`; unique per round) LEFT JOINed to each driver's
 * `quali_results`, and each driver's `pace_ranking` row LEFT JOINed in the current
 * assumption set. Nulls are kept so every ledger row has its own denominator.
 * Exported un-executed so a test can pin the `kind='Q'` filter without a database.
 */
export function ledgerQuery(year: number, aId: string, bId: string) {
  return db
    .select({
      round: sessions.round,
      qA: qualiA.position,
      qB: qualiB.position,
      finA: resultsA.classifiedPosition,
      finB: resultsB.classifiedPosition,
      paceA: paceA.gapPct,
      paceB: paceB.gapPct,
      ptsA: resultsA.points,
      ptsB: resultsB.points,
    })
    .from(sessions)
    .innerJoin(resultsA, and(eq(resultsA.sessionId, sessions.sessionId), eq(resultsA.driverId, aId)))
    .innerJoin(resultsB, and(eq(resultsB.sessionId, sessions.sessionId), eq(resultsB.driverId, bId)))
    .leftJoin(
      qSession,
      and(eq(qSession.year, sessions.year), eq(qSession.round, sessions.round), eq(qSession.kind, "Q")),
    )
    .leftJoin(qualiA, and(eq(qualiA.sessionId, qSession.sessionId), eq(qualiA.driverId, aId)))
    .leftJoin(qualiB, and(eq(qualiB.sessionId, qSession.sessionId), eq(qualiB.driverId, bId)))
    .leftJoin(
      paceA,
      and(
        eq(paceA.sessionId, sessions.sessionId),
        eq(paceA.driverId, aId),
        eq(paceA.assumptionSetId, currentPaceSet),
      ),
    )
    .leftJoin(
      paceB,
      and(
        eq(paceB.sessionId, sessions.sessionId),
        eq(paceB.driverId, bId),
        eq(paceB.assumptionSetId, currentPaceSet),
      ),
    )
    .where(and(eq(sessions.year, year), eq(sessions.kind, "R")))
    .orderBy(asc(sessions.round));
}

async function getSeasonLedgerRaw(year: number, aId: string, bId: string): Promise<Ledger> {
  const rows: LedgerRow[] = await ledgerQuery(year, aId, bId);
  return tallyLedger(rows);
}
export const getSeasonLedger = cached("h2h.getSeasonLedger", getSeasonLedgerRaw);

/** The `is_current` fit, newest first — the same rule `mode2.ts` applies. */
async function currentFitId(): Promise<number | null> {
  const rows = await db
    .select({ fitId: mode2FitRun.fitId })
    .from(mode2FitRun)
    .where(eq(mode2FitRun.isCurrent, true))
    .orderBy(desc(mode2FitRun.fittedAt), desc(mode2FitRun.fitId))
    .limit(1);
  return rows[0]?.fitId ?? null;
}

/** §3: the stored pooled contrast for the unordered pair, oriented so `driverA === aId`. */
async function getPairContrastRaw(aId: string, bId: string): Promise<ContrastRow | null> {
  const fitId = await currentFitId();
  if (fitId === null) return null;
  const rows = await db
    .select({
      driverA: mode2DriverContrast.driverA,
      driverB: mode2DriverContrast.driverB,
      kind: mode2DriverContrast.kind,
      deltaPp: mode2DriverContrast.deltaPp,
      deltaSe: mode2DriverContrast.deltaSe,
      deltaLo: mode2DriverContrast.deltaLo,
      deltaHi: mode2DriverContrast.deltaHi,
      sameComponent: mode2DriverContrast.sameComponent,
      sharedCells: mode2DriverContrast.sharedCells,
      nSharedRaces: mode2DriverContrast.nSharedRaces,
    })
    .from(mode2DriverContrast)
    .where(
      and(
        eq(mode2DriverContrast.fitId, fitId),
        or(
          and(eq(mode2DriverContrast.driverA, aId), eq(mode2DriverContrast.driverB, bId)),
          and(eq(mode2DriverContrast.driverA, bId), eq(mode2DriverContrast.driverB, aId)),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? orientContrast(row, aId) : null;
}
export const getPairContrast = cached("h2h.getPairContrast", getPairContrastRaw);
