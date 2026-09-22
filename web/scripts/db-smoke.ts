// Smoke test for the database connection. Run with `npm run db:smoke` (tsx).
// Opens the pool, runs SELECT 1, prints row counts of a few tables, then — REVALIDATE_SPEC §5 —
// calls every wrapped lib/queries read a page reaches, with arguments from the fixture
// (2026 R14, driver ANT, the first constructor, the latest session with telemetry), and asserts
// each result survives the JSON round trip unstable_cache performs and stays under 1 MiB.
// Exits 0 clean, 1 on any failure. Under tsx NODE_ENV is not production, so `cached()` is a
// pass-through and every call here runs the real query body.
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client";
import * as accuracy from "@/lib/queries/accuracy";
import * as driver from "@/lib/queries/driver";
import * as mode2 from "@/lib/queries/mode2";
import * as preview from "@/lib/queries/preview";
import * as quali from "@/lib/queries/quali";
import * as race from "@/lib/queries/race";
import * as release from "@/lib/queries/release";
import * as report from "@/lib/queries/report";
import * as season from "@/lib/queries/season";
import * as shared from "@/lib/queries/shared";
import * as sim from "@/lib/queries/sim";
import * as telemetry from "@/lib/queries/telemetry";

const YEAR = 2026;
const ROUND = 14;
const DRIVER_CODE = "ANT";
const MAX_ENTRY_BYTES = 1_048_576;

type Entry = [name: string, fn: unknown, args: unknown[]];

async function fixtureIds() {
  const r = await db.execute(
    sql`select session_id from sessions where year = ${YEAR} and round = ${ROUND} and kind = 'R' limit 1`,
  );
  const q = await db.execute(
    sql`select session_id from sessions where year = ${YEAR} and round = ${ROUND} and kind = 'Q' limit 1`,
  );
  const tel = await db.execute(
    sql`select t.session_id, min(t.driver_id) as driver_id from lap_telemetry t
        join sessions s using (session_id) group by t.session_id order by max(s.start_utc) desc limit 1`,
  );
  const team = await db.execute(sql`select team_id from mode2_car_rating order by team_id limit 1`);
  const circuit = await db.execute(sql`select circuit_key from events where year = ${YEAR} and round = ${ROUND}`);
  const resolved = await driver.resolveDriver(DRIVER_CODE, YEAR);
  return {
    raceId: Number(r.rows[0]?.session_id),
    qualiId: Number(q.rows[0]?.session_id),
    telId: Number(tel.rows[0]?.session_id),
    telDriver: String(tel.rows[0]?.driver_id ?? ""),
    teamId: String(team.rows[0]?.team_id ?? ""),
    circuitKey: Number(circuit.rows[0]?.circuit_key),
    driverId: resolved?.driverId ?? "antonelli",
  };
}

/** Every wrapped read a page (or the layout) imports, keyed as check-invariants rule 10 keys them. */
function entriesFor(ids: Awaited<ReturnType<typeof fixtureIds>>): Entry[] {
  const { raceId, qualiId, telId, telDriver, teamId, circuitKey, driverId } = ids;
  return [
    ["accuracy.getSkill", accuracy.getSkill, []],
    ["accuracy.getReliability", accuracy.getReliability, []],
    ["accuracy.getIntervalCoverage", accuracy.getIntervalCoverage, []],
    ["accuracy.getCoverageBySeason", accuracy.getCoverageBySeason, []],
    ["driver.resolveDriver", driver.resolveDriver, [DRIVER_CODE, YEAR]],
    ["driver.getDriverSeason", driver.getDriverSeason, [driverId, YEAR]],
    ["mode2.getFitMeta", mode2.getFitMeta, []],
    ["mode2.getDriverRating", mode2.getDriverRating, [driverId]],
    ["mode2.getComponentPeers", mode2.getComponentPeers, [driverId]],
    ["mode2.getRatingHistory", mode2.getRatingHistory, [driverId]],
    ["mode2.getDriverSkills", mode2.getDriverSkills, [driverId]],
    ["mode2.getTeammateContrasts", mode2.getTeammateContrasts, [driverId]],
    ["mode2.getCareerAdjusted", mode2.getCareerAdjusted, [driverId]],
    ["mode2.resolveConstructor", mode2.resolveConstructor, [teamId, YEAR]],
    ["mode2.getConstructorIndex", mode2.getConstructorIndex, [YEAR]],
    ["mode2.getCarRatings", mode2.getCarRatings, [teamId]],
    ["mode2.getDevelopment", mode2.getDevelopment, [YEAR]],
    ["mode2.getAllCarRatings", mode2.getAllCarRatings, []],
    ["mode2.getHazards", mode2.getHazards, [teamId]],
    ["mode2.getSeasonDecomposition", mode2.getSeasonDecomposition, [YEAR]],
    ["mode2.getCounterfactuals", mode2.getCounterfactuals, [YEAR, driverId]],
    ["preview.getPreviewRound", preview.getPreviewRound, [YEAR, ROUND]],
    ["preview.getPreviewOrder", preview.getPreviewOrder, [YEAR, ROUND]],
    ["preview.getOdiStrip", preview.getOdiStrip, []],
    ["quali.getQualiForRound", quali.getQualiForRound, [YEAR, ROUND]],
    ["quali.getQualiSegments", quali.getQualiSegments, [qualiId]],
    ["quali.getQualiTeammates", quali.getQualiTeammates, [qualiId]],
    ["quali.getQualiToGrid", quali.getQualiToGrid, [YEAR, ROUND]],
    ["quali.getSeasonQualiH2H", quali.getSeasonQualiH2H, [YEAR]],
    ["quali.getDriverQualiSeasons", quali.getDriverQualiSeasons, [driverId]],
    ["quali.getCircuitQualiHistory", quali.getCircuitQualiHistory, [circuitKey, [driverId], { year: YEAR, round: ROUND }]],
    ["quali.getSeasonPoles", quali.getSeasonPoles, [YEAR]],
    ["race.getRaceHeader", race.getRaceHeader, [YEAR, ROUND]],
    ["race.getRaceColours", race.getRaceColours, [raceId]],
    ["race.getPaceRanking", race.getPaceRanking, [raceId]],
    ["race.getStints", race.getStints, [raceId]],
    ["race.getDegradation", race.getDegradation, [raceId]],
    ["race.getRaceTrace", race.getRaceTrace, [raceId]],
    ["race.getTeammateDeltas", race.getTeammateDeltas, [raceId]],
    ["race.getFuelSensitivity", race.getFuelSensitivity, [raceId]],
    ["race.getExclusionReport", race.getExclusionReport, [raceId]],
    ["race.getRaceResults", race.getRaceResults, [raceId]],
    ["race.getAssumptions", race.getAssumptions, [raceId]],
    ["race.getWinProbability", race.getWinProbability, [raceId]],
    ["race.getWinProbSwings", race.getWinProbSwings, [raceId]],
    ["race.getWinProbTrust", race.getWinProbTrust, []],
    ["race.getRaceMoments", race.getRaceMoments, [raceId]],
    ["race.getOptimalStint", race.getOptimalStint, [raceId]],
    ["race.roundHasTelemetryTab", race.roundHasTelemetryTab, [YEAR, ROUND]],
    ["release.getLatestRelease", release.getLatestRelease, []],
    ["report.getRaceReport", report.getRaceReport, [raceId]],
    ["season.getSeason", season.getSeason, [YEAR]],
    ["season.getTitleOdds", season.getTitleOdds, [YEAR]],
    ["season.getTitleClinch", season.getTitleClinch, [YEAR]],
    ["shared.seasonsWithData", shared.seasonsWithData, []],
    ["sim.getSimModel", sim.getSimModel, [raceId]],
    ["telemetry.listTelemetryLaps", telemetry.listTelemetryLaps, [telId]],
    ["telemetry.getLapTelemetry", telemetry.getLapTelemetry, [telId, telDriver]],
    ["telemetry.getCornerSpeeds", telemetry.getCornerSpeeds, [telId, [telDriver]]],
  ];
}

async function main(): Promise<void> {
  const one = await db.execute(sql`select 1 as ok`);
  console.log("select 1 ->", one.rows[0]);

  for (const table of ["sessions", "laps", "pace_ranking"]) {
    const res = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`);
    console.log(`${table.padEnd(14)} ${String(res.rows[0]?.n ?? 0)} rows`);
  }

  const mig = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  console.log(`migrations     ${String(mig.rows[0]?.n ?? 0)} applied`);

  const ids = await fixtureIds();
  console.log("fixture ids ->", ids);
  const entries = entriesFor(ids);
  const missing: string[] = [];
  const failed: string[] = [];
  for (const [name, fn, args] of entries) {
    if (typeof fn !== "function") {
      missing.push(name);
      continue;
    }
    try {
      const v: unknown = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      const json = JSON.stringify(v);
      assert.deepStrictEqual(JSON.parse(json), v, `${name}: not JSON-stable`);
      assert.ok(json.length < MAX_ENTRY_BYTES, `${name}: ${json.length} bytes ≥ 1 MiB`);
      console.log(`ok   ${name.padEnd(34)} ${String(json.length).padStart(8)} bytes`);
    } catch (err) {
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`FAIL ${name}`);
    }
  }
  console.log(`json round-trip: ${entries.length - missing.length - failed.length}/${entries.length} ok`);
  if (missing.length) console.log(`missing (not exported yet): ${missing.join(", ")}`);
  if (failed.length) throw new Error(`db:smoke query pass failed:\n  ${failed.join("\n  ")}`);
}

main()
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    console.error("db:smoke failed:", err);
    await pool.end();
    process.exit(1);
  });
