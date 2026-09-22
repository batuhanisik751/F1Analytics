// web/lib/queries/accuracy.ts — the app's own track record. Reads only; computes nothing
// beyond the arithmetic needed to state a rate.
//
// Every other page here answers "what happened". This one answers "how right were we", which
// is the question a statistics project owes its reader and the one nobody asks of itself. The
// numbers are already in the database: the win-probability model records its out-of-fold
// Brier against two baselines, its reliability bins, and the race previews record a predicted
// finishing position with a p10-p90 interval beside what actually happened.
//
// ALL THREE TABLES ARE KEYED BY assumption_set_id AND HOLD HISTORY. wp_metrics currently has
// three sets (254, 532, 844) and a naive SELECT returns each row three times, which is exactly
// the bug that would make a page say "33% better than baseline" three times and mean nothing.
// Every query below resolves the current run first, the same way mode2.ts resolves the current
// fit, and filters on it.
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { previewBacktest, titleOdds, wpMetrics, wpReliabilityBin, wpRun } from "@/db/schema/companion";
import { events, sessions } from "@/db/schema/reference";
import { driverStandings } from "@/db/schema/season";
import { results } from "@/db/schema/session";
import { cached } from "@/lib/cache";
import {
  scoreIntervals,
  scorePointsBand,
  type IntervalSharpness,
  type PointsBandSeason,
} from "@/lib/queries/accuracyScore";

/** The scoring scope. `loco` = leave-one-circuit-out, the honest one. */
export type Scope = "in_sample" | "loco" | "forward";

export type SkillRow = {
  scope: string;
  variant: string;
  nRaces: number;
  nRows: number;
  brier: number;
  baselinePosition: number | null;
  baselineLeader: number | null;
  /** Percent better than the positional baseline. Negative means worse than it. */
  skillVsPosition: number | null;
  foldMin: number | null;
  foldMax: number | null;
};

export type ReliabilityRow = {
  binLo: number;
  binHi: number;
  nRows: number;
  nWins: number;
  meanPredicted: number;
  observedRate: number;
  observedLo: number | null;
  observedHi: number | null;
};

export type IntervalCoverage = {
  predictions: number;
  insideInterval: number;
  /** Observed coverage of the p10-p90 band, as a percentage. */
  coveragePct: number;
  /** What a p10-p90 band claims to cover. The comparison is the whole point. */
  nominalPct: number;
  meanAbsError: number;
  medianAbsError: number;
};

/**
 * The current win-probability run. `is_current` is per assumption set, so several rows can
 * carry it once more than one set has been trained; the newest wins.
 */
async function currentRun(): Promise<{ assumptionSetId: number } | null> {
  const rows = await db
    .select({ assumptionSetId: wpRun.assumptionSetId })
    .from(wpRun)
    .where(eq(wpRun.isCurrent, true))
    .orderBy(desc(wpRun.trainedAt), desc(wpRun.wpRunId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Win-probability skill, one row per (scope, variant), current assumption set only.
 *
 * The gap between `in_sample` and `loco` is the finding: a model always looks better on
 * data it has already seen, and reporting only the first number is how a project flatters
 * itself. Both ship, and the page leads with the smaller one.
 */
async function getSkillRaw(): Promise<SkillRow[]> {
  const run = await currentRun();
  if (!run) return [];
  const rows = await db
    .select({
      scope: wpMetrics.scope,
      variant: wpMetrics.variant,
      nRaces: wpMetrics.nRaces,
      nRows: wpMetrics.nRows,
      brier: wpMetrics.brier,
      baselinePosition: wpMetrics.brierBaselinePos,
      baselineLeader: wpMetrics.brierBaselineLead,
      foldMin: wpMetrics.brierFoldMin,
      foldMax: wpMetrics.brierFoldMax,
    })
    .from(wpMetrics)
    .where(eq(wpMetrics.assumptionSetId, run.assumptionSetId))
    .orderBy(asc(wpMetrics.scope), asc(wpMetrics.variant));

  // De-duplicate defensively: the table has no unique key on (scope, variant) and has
  // carried repeats before. Keeping the first is safe because they are identical rows.
  const seen = new Set<string>();
  const out: SkillRow[] = [];
  for (const r of rows) {
    const key = `${r.scope}/${r.variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = r.baselinePosition;
    out.push({
      ...r,
      skillVsPosition: base && base > 0 ? (1 - r.brier / base) * 100 : null,
    });
  }
  return out;
}
export const getSkill = cached("accuracy.getSkill", getSkillRaw);

/** The calibration curve for one scope: what we said, against what happened. */
async function getReliabilityRaw(scope: Scope = "loco"): Promise<ReliabilityRow[]> {
  const run = await currentRun();
  if (!run) return [];
  const rows = await db
    .select({
      binLo: wpReliabilityBin.binLo,
      binHi: wpReliabilityBin.binHi,
      nRows: wpReliabilityBin.nRows,
      nWins: wpReliabilityBin.nWins,
      meanPredicted: wpReliabilityBin.meanPredicted,
      observedRate: wpReliabilityBin.observedRate,
      observedLo: wpReliabilityBin.observedLo,
      observedHi: wpReliabilityBin.observedHi,
    })
    .from(wpReliabilityBin)
    .where(and(eq(wpReliabilityBin.assumptionSetId, run.assumptionSetId),
               eq(wpReliabilityBin.scope, scope)))
    .orderBy(asc(wpReliabilityBin.binIndex));
  return rows.filter((r) => r.nRows > 0);
}
export const getReliability = cached("accuracy.getReliability", getReliabilityRaw);

/**
 * Race-preview accuracy: did the p10-p90 band actually contain the finish?
 *
 * A p10-p90 band claims 80 % coverage BY CONSTRUCTION, so this is the rare prediction check
 * with a target rather than a vibe. Measured coverage above 80 % means the intervals are too
 * wide and the model is under-confident; below means over-confident, which is the usual and
 * more dangerous direction. The page prints both numbers side by side and lets the reader
 * see which way it missed.
 *
 * `pred_kind = 'oof'` only: in-sample predictions would score the model on races it trained
 * on, which is the flattering number this page exists to avoid.
 */
async function getIntervalCoverageRaw(): Promise<IntervalCoverage | null> {
  const rows = await db
    .select({
      predictions: sql<number>`count(*)::int`,
      inside: sql<number>`count(*) filter (where ${previewBacktest.insideInterval})::int`,
      meanAbs: sql<number>`avg(abs(${previewBacktest.expectedPosition} - ${previewBacktest.actualPosition}))::float8`,
      medianAbs: sql<number>`percentile_cont(0.5) within group (order by abs(${previewBacktest.expectedPosition} - ${previewBacktest.actualPosition}))::float8`,
    })
    .from(previewBacktest)
    .where(and(eq(previewBacktest.predKind, "oof"),
               isNotNull(previewBacktest.actualPosition)));
  const r = rows[0];
  if (!r || !r.predictions) return null;
  return {
    predictions: r.predictions,
    insideInterval: r.inside,
    coveragePct: (r.inside / r.predictions) * 100,
    nominalPct: 80,
    meanAbsError: r.meanAbs,
    medianAbsError: r.medianAbs,
  };
}
export const getIntervalCoverage = cached("accuracy.getIntervalCoverage", getIntervalCoverageRaw);

/** Per-season coverage, so a reader can see whether the miss is one bad year or the method. */
async function getCoverageBySeasonRaw(): Promise<
  { year: number; predictions: number; coveragePct: number; meanAbsError: number }[]
> {
  return db
    .select({
      year: previewBacktest.year,
      predictions: sql<number>`count(*)::int`,
      coveragePct: sql<number>`(count(*) filter (where ${previewBacktest.insideInterval})::float8 / count(*)) * 100`,
      meanAbsError: sql<number>`avg(abs(${previewBacktest.expectedPosition} - ${previewBacktest.actualPosition}))::float8`,
    })
    .from(previewBacktest)
    .where(and(eq(previewBacktest.predKind, "oof"),
               isNotNull(previewBacktest.actualPosition)))
    .groupBy(previewBacktest.year)
    .orderBy(asc(previewBacktest.year));
}
export const getCoverageBySeason = cached("accuracy.getCoverageBySeason", getCoverageBySeasonRaw);

/**
 * Interval sharpness (ACCURACY_SPEC §3): every out-of-fold preview row, INCLUDING the ones
 * with no classified finish, joined to the driver's grid slot so the p10-p90 band can be
 * scored against a band that needs no model at all (grid ± k). The SQL only fetches; the
 * conventions belong to `scoreIntervals`. Grid size per season is the largest grid position
 * seen in that season's races, so a 22-car grid is compared as one.
 */
async function getIntervalSharpnessRaw(): Promise<IntervalSharpness | null> {
  const gridSizes = db
    .select({
      year: sessions.year,
      gridSize: sql<number | null>`max(${results.gridPosition})::int`.as("grid_size"),
    })
    .from(results)
    .innerJoin(sessions, eq(sessions.sessionId, results.sessionId))
    .where(eq(sessions.kind, "R"))
    .groupBy(sessions.year)
    .as("grid_sizes");
  const rows = await db
    .select({
      year: previewBacktest.year,
      p10: previewBacktest.posP10,
      p90: previewBacktest.posP90,
      actual: previewBacktest.actualPosition,
      expected: previewBacktest.expectedPosition,
      grid: results.gridPosition,
      gridSize: gridSizes.gridSize,
    })
    .from(previewBacktest)
    .leftJoin(sessions, and(eq(sessions.year, previewBacktest.year),
                            eq(sessions.round, previewBacktest.round),
                            eq(sessions.kind, "R")))
    .leftJoin(results, and(eq(results.sessionId, sessions.sessionId),
                           eq(results.driverId, previewBacktest.driverId)))
    .leftJoin(gridSizes, eq(gridSizes.year, previewBacktest.year))
    .where(eq(previewBacktest.predKind, "oof"))
    .orderBy(asc(previewBacktest.year), asc(previewBacktest.round), asc(previewBacktest.driverId));
  if (rows.length === 0) return null;
  return scoreIntervals(rows, { alpha: 0.2, ks: [7, 5] });
}
export const getIntervalSharpness = cached("accuracy.getIntervalSharpness", getIntervalSharpnessRaw);

/**
 * Points-band scoring (ACCURACY_SPEC §3): every title_odds projection of a FINISHED season,
 * joined to the driver's final standings total. A season is finished when the last standings
 * round equals the last scheduled round, so no year is named here and a season joins itself
 * in when it ends. The final-round row is left out at the source; `scorePointsBand` does the
 * rest and repeats that exclusion so the rule is testable without a database.
 */
async function getPointsBandRaw(): Promise<PointsBandSeason[]> {
  const fin = db.$with("fin").as(
    db.select({ year: driverStandings.year, fin: sql<number>`max(${driverStandings.afterRound})`.as("fin") })
      .from(driverStandings)
      .groupBy(driverStandings.year),
  );
  const sched = db.$with("sched").as(
    db.select({ year: events.year, sched: sql<number>`max(${events.round})`.as("sched") })
      .from(events)
      .groupBy(events.year),
  );
  const rows = await db
    .with(fin, sched)
    .select({
      year: titleOdds.year,
      driverId: titleOdds.driverId,
      afterRound: titleOdds.afterRound,
      finalRound: fin.fin,
      expectedPoints: titleOdds.expectedPoints,
      p10: titleOdds.pointsP10,
      p90: titleOdds.pointsP90,
      isShrunk: titleOdds.isShrunkToPrior,
      finalPoints: driverStandings.points,
    })
    .from(titleOdds)
    .innerJoin(fin, eq(fin.year, titleOdds.year))
    .innerJoin(sched, and(eq(sched.year, titleOdds.year), eq(sched.sched, fin.fin)))
    .leftJoin(driverStandings, and(eq(driverStandings.year, titleOdds.year),
                                   eq(driverStandings.afterRound, fin.fin),
                                   eq(driverStandings.driverId, titleOdds.driverId)))
    .where(lt(titleOdds.afterRound, fin.fin))
    .orderBy(asc(titleOdds.year), asc(titleOdds.afterRound), asc(titleOdds.driverId));
  return scorePointsBand(rows);
}
export const getPointsBand = cached("accuracy.getPointsBand", getPointsBandRaw);
