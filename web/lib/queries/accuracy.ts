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
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { previewBacktest, wpMetrics, wpReliabilityBin, wpRun } from "@/db/schema/companion";

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
export async function getSkill(): Promise<SkillRow[]> {
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

/** The calibration curve for one scope: what we said, against what happened. */
export async function getReliability(scope: Scope = "loco"): Promise<ReliabilityRow[]> {
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
export async function getIntervalCoverage(): Promise<IntervalCoverage | null> {
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

/** Per-season coverage, so a reader can see whether the miss is one bad year or the method. */
export async function getCoverageBySeason(): Promise<
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
