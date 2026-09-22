// MODE1_SPEC §5: the fourteen v1.2 race-companion tables.
//
// Two are per-session children (race_moment, optimal_stint) and cascade on session_id;
// wp_lap_probability and wp_swing also carry the cascade so deleting a session cannot
// leave orphan probability rows. The remaining ten are cross-race artifacts keyed by
// (year, round) or circuit_key and deliberately do NOT pretend to cascade with one
// session (§5.6).
//
// Three transcription traps (§5.7) are handled explicitly below:
//   1. wp_run_one_current is a PARTIAL unique index (WHERE is_current).
//   2. events has a composite PK (year, round): preview_* use foreignKey({...}), never
//      the column-level .references() shorthand, which emits nothing for a composite.
//   3. ON DELETE CASCADE is written out on every session_id reference.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { assumptionSets, circuits, events, sessions } from "./reference";

// No bytea helper exists in the repo yet; the joblib blob in wp_model_artifact is the
// first one. drizzle-orm 0.45 has no built-in bytea, so declare it once here.
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

// --- §5.1 Win probability ---------------------------------------------------

// One row per companion recompute. The audit trail for "when did the numbers move".
export const wpRun = pgTable(
  "wp_run",
  {
    wpRunId: serial("wp_run_id").primaryKey(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    modelVersion: text("model_version").notNull(),
    sklearnVersion: text("sklearn_version").notNull(),
    nTrainRaces: integer("n_train_races").notNull(),
    nRows: integer("n_rows").notNull(),
    nFolds: integer("n_folds").notNull(),
    calibration: text("calibration").notNull(),
    tuningScope: text("tuning_scope").notNull().default("oof"),
    brierOof: doublePrecision("brier_oof").notNull(),
    brierBaselinePos: doublePrecision("brier_baseline_pos").notNull(),
    brierBaselineLead: doublePrecision("brier_baseline_lead").notNull(),
    skillOk: boolean("skill_ok").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    trainedAt: timestamp("trained_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("wp_run_model_version_uq").on(t.assumptionSetId, t.modelVersion),
    uniqueIndex("wp_run_one_current").on(t.assumptionSetId).where(sql`is_current`),
  ],
);

// The fitted estimators. fold_index = -1 is the full-data model.
export const wpModelArtifact = pgTable(
  "wp_model_artifact",
  {
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    foldIndex: integer("fold_index").notNull(),
    modelVersion: text("model_version").notNull(),
    sklearnVersion: text("sklearn_version").notNull(),
    featureNames: jsonb("feature_names").$type<string[]>().notNull(),
    nTrainRaces: integer("n_train_races").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    artifact: bytea("artifact").notNull(),
    trainedAt: timestamp("trained_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.assumptionSetId, t.foldIndex] })],
);

// The river chart's table. OOF only, enforced by CHECK, not by a query filter (FD2).
export const wpLapProbability = pgTable(
  "wp_lap_probability",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    lapNumber: integer("lap_number").notNull(),
    predKind: text("pred_kind").notNull().default("oof"),
    foldIndex: integer("fold_index").notNull(),
    pWinRaw: doublePrecision("p_win_raw").notNull(),
    pWin: doublePrecision("p_win").notNull(),
    degraded: boolean("degraded").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.lapNumber] }),
    check("wp_lap_probability_oof_only", sql`${t.predKind} = 'oof'`),
    check("wp_lap_probability_range", sql`${t.pWin} >= 0 AND ${t.pWin} <= 1`),
    index("wp_lap_probability_lap_idx").on(t.sessionId, t.lapNumber),
  ],
);

export const wpSwing = pgTable(
  "wp_swing",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    lapNumber: integer("lap_number").notNull(),
    swingMass: doublePrecision("swing_mass").notNull(),
    cause: text("cause").notNull(),
    moverDriverId: text("mover_driver_id").notNull(),
    moverPBefore: doublePrecision("mover_p_before").notNull(),
    moverPAfter: doublePrecision("mover_p_after").notNull(),
    rankInRace: integer("rank_in_race").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.lapNumber] }),
    check(
      "wp_swing_cause",
      sql`${t.cause} IN ('safety_car','vsc','red_flag','pit_cycle','retirement','on_track')`,
    ),
  ],
);

// Scalar metrics. One row per (run, scope, variant).
export const wpMetrics = pgTable(
  "wp_metrics",
  {
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    scope: text("scope").notNull(),
    variant: text("variant").notNull(),
    nRows: integer("n_rows").notNull(),
    nRaces: integer("n_races").notNull(),
    brier: doublePrecision("brier").notNull(),
    logLoss: doublePrecision("log_loss").notNull(),
    brierBaselinePos: doublePrecision("brier_baseline_pos").notNull(),
    brierBaselineLead: doublePrecision("brier_baseline_lead").notNull(),
    brierFoldMin: doublePrecision("brier_fold_min"),
    brierFoldMedian: doublePrecision("brier_fold_median"),
    brierFoldMax: doublePrecision("brier_fold_max"),
    note: text("note"),
  },
  (t) => [
    primaryKey({ columns: [t.assumptionSetId, t.scope, t.variant] }),
    check("wp_metrics_scope", sql`${t.scope} <> ''`),
    check("wp_metrics_variant", sql`${t.variant} IN ('plain','isotonic')`),
  ],
);

export const wpReliabilityBin = pgTable(
  "wp_reliability_bin",
  {
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    scope: text("scope").notNull(),
    variant: text("variant").notNull(),
    binIndex: integer("bin_index").notNull(),
    binLo: doublePrecision("bin_lo").notNull(),
    binHi: doublePrecision("bin_hi").notNull(),
    nRows: integer("n_rows").notNull(),
    nWins: integer("n_wins").notNull(),
    meanPredicted: doublePrecision("mean_predicted").notNull(),
    observedRate: doublePrecision("observed_rate").notNull(),
    observedLo: doublePrecision("observed_lo").notNull(),
    observedHi: doublePrecision("observed_hi").notNull(),
  },
  (t) => [primaryKey({ columns: [t.assumptionSetId, t.scope, t.variant, t.binIndex] })],
);

// --- §5.2 Title odds and magic numbers --------------------------------------

export const titleOdds = pgTable(
  "title_odds",
  {
    year: integer("year").notNull(),
    afterRound: integer("after_round").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    pTitle: doublePrecision("p_title").notNull(),
    pTitleLo: doublePrecision("p_title_lo").notNull(),
    pTitleHi: doublePrecision("p_title_hi").notNull(),
    mcStderr: doublePrecision("mc_stderr").notNull(),
    pTop3: doublePrecision("p_top3").notNull(),
    expectedPoints: doublePrecision("expected_points").notNull(),
    pointsP10: doublePrecision("points_p10").notNull(),
    pointsP90: doublePrecision("points_p90").notNull(),
    theta: doublePrecision("theta").notNull(),
    dnfRate: doublePrecision("dnf_rate").notNull(),
    isShrunkToPrior: boolean("is_shrunk_to_prior").notNull().default(false),
    draws: integer("draws").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.afterRound, t.driverId] }),
    check("title_odds_p_range", sql`${t.pTitle} >= 0 AND ${t.pTitle} <= 1`),
  ],
);

// Exact arithmetic (FD4). No simulated quantity may be written here.
export const titleClinch = pgTable(
  "title_clinch",
  {
    year: integer("year").notNull(),
    afterRound: integer("after_round").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    pointsNow: integer("points_now").notNull(),
    maxAvailable: integer("max_available").notNull(),
    maxPossibleTotal: integer("max_possible_total").notNull(),
    leaderPoints: integer("leader_points").notNull(),
    isEliminated: boolean("is_eliminated").notNull(),
    eliminatedAtRound: integer("eliminated_at_round"),
    hasClinched: boolean("has_clinched").notNull().default(false),
    clinchMarginNeeded: integer("clinch_margin_needed"),
    swingNeeded: integer("swing_needed"),
    clinchPosition: integer("clinch_position"),
    earliestClinchRound: integer("earliest_clinch_round"),
    nextRoundHasSprint: boolean("next_round_has_sprint").notNull().default(false),
    racePointsMax: integer("race_points_max").notNull(),
    sprintPointsMax: integer("sprint_points_max").notNull(),
    hasFastestLapBonus: boolean("has_fastest_lap_bonus").notNull(),
  },
  (t) => [primaryKey({ columns: [t.year, t.afterRound, t.driverId] })],
);

// --- §5.3 Weekend preview ---------------------------------------------------

export const circuitOdi = pgTable(
  "circuit_odi",
  {
    circuitKey: integer("circuit_key")
      .notNull()
      .references(() => circuits.circuitKey),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    races: integer("races").notNull(),
    passes: integer("passes").notNull(),
    opportunities: integer("opportunities").notNull(),
    rawPassRate: doublePrecision("raw_pass_rate").notNull(),
    residMean: doublePrecision("resid_mean").notNull(),
    residShrunk: doublePrecision("resid_shrunk").notNull(),
    adjPassRate: doublePrecision("adj_pass_rate").notNull(),
    odi: doublePrecision("odi").notNull(),
    odiLo: doublePrecision("odi_lo").notNull(),
    odiHi: doublePrecision("odi_hi").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.circuitKey] }),
    check("circuit_odi_range", sql`${t.odi} >= 0 AND ${t.odi} <= 100`),
  ],
);

export const previewRound = pgTable(
  "preview_round",
  {
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    circuitKey: integer("circuit_key").references(() => circuits.circuitKey),
    circuitMatch: text("circuit_match").notNull(),
    circuitRaces: integer("circuit_races").notNull().default(0),
    expectedTotalLaps: integer("expected_total_laps"),
    pSafetyCar: doublePrecision("p_safety_car"),
    scHazardShrunk: doublePrecision("sc_hazard_shrunk"),
    pVsc: doublePrecision("p_vsc"),
    expectedPitLossS: doublePrecision("expected_pit_loss_s"),
    pitLossBandS: doublePrecision("pit_loss_band_s"),
    odi: doublePrecision("odi"),
    odiLo: doublePrecision("odi_lo"),
    odiHi: doublePrecision("odi_hi"),
    backtestSpearman: doublePrecision("backtest_spearman"),
    backtestGridSpearman: doublePrecision("backtest_grid_spearman"),
    backtestCoverage: doublePrecision("backtest_coverage"),
    backtestRaces: integer("backtest_races"),
    locoBrier: doublePrecision("loco_brier"),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.round] }),
    check("preview_round_match", sql`${t.circuitMatch} IN ('native','location','alias','none')`),
    foreignKey({
      columns: [t.year, t.round],
      foreignColumns: [events.year, events.round],
      name: "preview_round_events_fk",
    }).onDelete("cascade"),
  ],
);

export const previewFinishOrder = pgTable(
  "preview_finish_order",
  {
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    expectedPosition: doublePrecision("expected_position").notNull(),
    posP10: integer("pos_p10").notNull(),
    posP90: integer("pos_p90").notNull(),
    pWin: doublePrecision("p_win").notNull(),
    pPodium: doublePrecision("p_podium").notNull(),
    pPoints: doublePrecision("p_points").notNull(),
    theta: doublePrecision("theta").notNull(),
    dnfRate: doublePrecision("dnf_rate").notNull(),
    draws: integer("draws").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.round, t.driverId] }),
    foreignKey({
      columns: [t.year, t.round],
      foreignColumns: [events.year, events.round],
      name: "preview_finish_order_events_fk",
    }).onDelete("cascade"),
  ],
);

// What the preview WOULD have said for an already-raced round, using only prior rounds.
export const previewBacktest = pgTable(
  "preview_backtest",
  {
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    predKind: text("pred_kind").notNull().default("oof"),
    expectedPosition: doublePrecision("expected_position").notNull(),
    posP10: integer("pos_p10").notNull(),
    posP90: integer("pos_p90").notNull(),
    actualPosition: integer("actual_position"),
    insideInterval: boolean("inside_interval").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.round, t.driverId] }),
    check("preview_backtest_oof_only", sql`${t.predKind} = 'oof'`),
    foreignKey({
      columns: [t.year, t.round],
      foreignColumns: [events.year, events.round],
      name: "preview_backtest_events_fk",
    }).onDelete("cascade"),
  ],
);

// LEDGER_SPEC §1: the preview ledger. Each nightly recompute of preview_round /
// preview_finish_order is copied here keyed by the preview's own computed_at, so history
// survives the DELETE in recompute_preview. Builders are re-declared, not spread: a spread
// would carry .defaultNow() onto computedAt (which must always be the copied value) and the
// .references() shorthand onto assumptionSetId (the id is a copied fact, not a constraint).
// No FK to events either: a renumber must not cascade-delete history.
export const previewSnapshotRound = pgTable(
  "preview_snapshot_round",
  {
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    assumptionSetId: integer("assumption_set_id").notNull(),
    circuitKey: integer("circuit_key"),
    circuitMatch: text("circuit_match").notNull(),
    circuitRaces: integer("circuit_races").notNull().default(0),
    expectedTotalLaps: integer("expected_total_laps"),
    pSafetyCar: doublePrecision("p_safety_car"),
    scHazardShrunk: doublePrecision("sc_hazard_shrunk"),
    pVsc: doublePrecision("p_vsc"),
    expectedPitLossS: doublePrecision("expected_pit_loss_s"),
    pitLossBandS: doublePrecision("pit_loss_band_s"),
    odi: doublePrecision("odi"),
    odiLo: doublePrecision("odi_lo"),
    odiHi: doublePrecision("odi_hi"),
    backtestSpearman: doublePrecision("backtest_spearman"),
    backtestGridSpearman: doublePrecision("backtest_grid_spearman"),
    backtestCoverage: doublePrecision("backtest_coverage"),
    backtestRaces: integer("backtest_races"),
    locoBrier: doublePrecision("loco_brier"),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }).notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.year, t.round, t.computedAt] })],
);

export const previewSnapshotOrder = pgTable(
  "preview_snapshot_order",
  {
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }).notNull(),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverId: text("driver_id").notNull(),
    expectedPosition: doublePrecision("expected_position").notNull(),
    posP10: integer("pos_p10").notNull(),
    posP90: integer("pos_p90").notNull(),
    pWin: doublePrecision("p_win").notNull(),
    pPodium: doublePrecision("p_podium").notNull(),
    pPoints: doublePrecision("p_points").notNull(),
    theta: doublePrecision("theta").notNull(),
    dnfRate: doublePrecision("dnf_rate").notNull(),
    draws: integer("draws").notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.round, t.computedAt, t.driverId] }),
    foreignKey({
      columns: [t.year, t.round, t.computedAt],
      foreignColumns: [previewSnapshotRound.year, previewSnapshotRound.round, previewSnapshotRound.computedAt],
      name: "preview_snapshot_order_round_fk",
    }).onDelete("cascade"),
  ],
);

// --- §5.4 Race moments and optimal stint (the two per-session tables) -------

export const raceMoment = pgTable(
  "race_moment",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    momentIdx: integer("moment_idx").notNull(),
    momentType: text("moment_type").notNull(),
    lapNumber: integer("lap_number").notNull(),
    driverId: text("driver_id").notNull(),
    otherDriverId: text("other_driver_id"),
    magnitude: doublePrecision("magnitude").notNull(),
    magnitudeUnit: text("magnitude_unit").notNull(),
    severity: doublePrecision("severity").notNull(),
    confidence: text("confidence").notNull(),
    detail: text("detail").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.momentIdx] }),
    check(
      "race_moment_type",
      sql`${t.momentType} IN ('pace_collapse','undercut_executed','tyre_cliff','damage_or_puncture','safety_car_luck')`,
    ),
    check("race_moment_conf", sql`${t.confidence} IN ('high','likely')`),
    check("race_moment_unit", sql`${t.magnitudeUnit} IN ('s','places')`),
    index("race_moment_lap_idx").on(t.sessionId, t.lapNumber),
  ],
);

export const optimalStint = pgTable(
  "optimal_stint",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    compound: text("compound").notNull(),
    nFits: integer("n_fits").notNull(),
    slopeSPerLap: doublePrecision("slope_s_per_lap").notNull(),
    slopeQ1: doublePrecision("slope_q1").notNull(),
    slopeQ3: doublePrecision("slope_q3").notNull(),
    pitLossS: doublePrecision("pit_loss_s").notNull(),
    pitLossSource: text("pit_loss_source").notNull(),
    optimalLaps: doublePrecision("optimal_laps").notNull(),
    optimalLapsLo: doublePrecision("optimal_laps_lo").notNull(),
    optimalLapsHi: doublePrecision("optimal_laps_hi").notNull(),
    actualMedianLaps: doublePrecision("actual_median_laps"),
    slopeSource: text("slope_source").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.compound] }),
    check("optimal_stint_pit_src", sql`${t.pitLossSource} IN ('circuit','pooled')`),
    check("optimal_stint_slope_src", sql`${t.slopeSource} IN ('session','pooled')`),
  ],
);
