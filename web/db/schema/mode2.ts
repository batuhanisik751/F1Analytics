// MODE2_SPEC §6.2: the twelve v1.3 driver-vs-car decomposition tables.
//
// Rules this file obeys (§6.1):
//   - explicit snake_case for every column, index and constraint name;
//   - assumption_set_id on every table, and a fit_id FK back to mode2_fit_run;
//   - every _lo/_hi/p10/p90 column is NOT NULL (FD2) and mode2_counterfactual
//     additionally carries a CHECK, so a point estimate cannot exist without its band;
//   - NO grid-wide rank column exists anywhere. The mobility graph has four
//     disconnected components (§1.4), so a grid-wide rank is not a number that can be
//     computed honestly. Only rank_in_component / rank_in_season are representable.
//   - none of these are per-session children, so none is in RACE_TABLE_ORDER and none
//     cascades on a session -- except mode2_row_audit, which is keyed by session_id.
//
// The three transcription traps of §6.4 are handled explicitly:
//   1. mode2_fit_run_current_idx is a PARTIAL unique index (WHERE is_current). Losing
//      the .where() makes the second fit uninsertable; losing the whole index lets two
//      is_current rows coexist and every §8 query silently doubles.
//   2. doublePrecision(), never real() or numeric -- psycopg 3 hands numeric back as
//      Decimal and cast_frame's _to_float does not expect it. text("x").array() for
//      text[], never jsonb.
//   3. Every CHECK is named exactly as in §6.2; an unnamed one gets an invented name
//      that changes between generations and produces a spurious drop/add pair.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { assumptionSets, drivers, sessions, teams } from "./reference";

// --- §6.2 The fit itself ----------------------------------------------------

// One row per fit. Everything else in this schema hangs off it.
export const mode2FitRun = pgTable(
  "mode2_fit_run",
  {
    fitId: serial("fit_id").primaryKey(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    modelVersion: text("model_version").notNull(),
    spec: text("spec").notNull(),
    nRows: integer("n_rows").notNull(),
    nRowsExcluded: integer("n_rows_excluded").notNull(),
    nDrivers: integer("n_drivers").notNull(),
    nCells: integer("n_cells").notNull(),
    nSessions: integer("n_sessions").notNull(),
    nComponents: integer("n_components").notNull(),
    tauDriver: doublePrecision("tau_driver").notNull(),
    tauCar: doublePrecision("tau_car").notNull(),
    tauSlope: doublePrecision("tau_slope").notNull(),
    sigmaResid: doublePrecision("sigma_resid").notNull(),
    tauDriverLo: doublePrecision("tau_driver_lo").notNull(),
    tauDriverHi: doublePrecision("tau_driver_hi").notNull(),
    tauCarLo: doublePrecision("tau_car_lo").notNull(),
    tauCarHi: doublePrecision("tau_car_hi").notNull(),
    sdRatio: doublePrecision("sd_ratio").notNull(),
    sdRatioLo: doublePrecision("sd_ratio_lo").notNull(),
    sdRatioHi: doublePrecision("sd_ratio_hi").notNull(),
    tauInteraction: doublePrecision("tau_interaction").notNull(),
    sigmaSpec: doublePrecision("sigma_spec").notNull(),
    ciLevel: doublePrecision("ci_level").notNull(),
    bootstrapReps: integer("bootstrap_reps").notNull(),
    converged: boolean("converged").notNull(),
    shrinkageOk: boolean("shrinkage_ok").notNull(),
    intervalDirOk: boolean("interval_dir_ok").notNull(),
    fitSeconds: doublePrecision("fit_seconds").notNull(),
    bootstrapSeconds: doublePrecision("bootstrap_seconds").notNull(),
    isCurrent: boolean("is_current").notNull(),
    fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull(),
    // GAPFILL_SPEC §2.2 (v1.8): the pre-registered retirement decision numbers, stored
    // rather than remembered. QUALI_SPEC §5.1.1 pre-registered grid_pace retirement at
    // r >= 0.95; measured 0.8393 (all 28) / 0.8670 (ex-island 24), so grid_pace is kept
    // (D2). Nullable because every fit written before v1.8 has no value for them, and
    // because a fit that does not fit one_lap_pace legitimately leaves them NULL.
    // Gate G3 (§6.3) fails the build if either grid correlation reaches 0.95.
    corrOneLapGrid: doublePrecision("corr_one_lap_grid"),
    corrOneLapGridExIslands: doublePrecision("corr_one_lap_grid_ex_islands"),
    corrOneLapRace: doublePrecision("corr_one_lap_race"),
  },
  (t) => [
    // TRAP 1 (§6.4): PARTIAL unique index. The .where() is load-bearing.
    uniqueIndex("mode2_fit_run_current_idx").on(t.assumptionSetId).where(sql`${t.isCurrent}`),
    uniqueIndex("mode2_fit_run_version_idx").on(t.assumptionSetId, t.modelVersion),
  ],
);

// The identifiability components of §1.4. Content, not diagnostics: K3 (Aston) and K4
// (McLaren) are floating islands, and the UI says so on the page.
export const mode2Component = pgTable(
  "mode2_component",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    componentId: text("component_id").notNull(),
    label: text("label").notNull(),
    nDrivers: integer("n_drivers").notNull(),
    nCells: integer("n_cells").notNull(),
    isFloating: boolean("is_floating").notNull(),
    driverIds: text("driver_ids").array().notNull(),
    cellIds: text("cell_ids").array().notNull(),
  },
  (t) => [primaryKey({ columns: [t.fitId, t.componentId] })],
);

// --- §6.2 Driver rating -----------------------------------------------------

// The headline rating, one row per driver per fit. Career-wide; NOT per season
// (§1.5 -- a per-season refit is ~100% prior at the level and is forbidden).
export const mode2DriverRating = pgTable(
  "mode2_driver_rating",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    ratingPp: doublePrecision("rating_pp").notNull(),
    ratingLo: doublePrecision("rating_lo").notNull(),
    ratingHi: doublePrecision("rating_hi").notNull(),
    sdWithin: doublePrecision("sd_within").notNull(),
    sdIsland: doublePrecision("sd_island").notNull(),
    sdTotal: doublePrecision("sd_total").notNull(),
    fracFloating: doublePrecision("frac_floating").notNull(),
    evidenceShare: doublePrecision("evidence_share").notNull(),
    anchorClass: text("anchor_class").notNull(),
    basis: text("basis").notNull(),
    componentId: text("component_id").notNull(),
    rankInComponent: integer("rank_in_component").notNull(),
    nRaces: integer("n_races").notNull(),
    nCells: integer("n_cells").notNull(),
    nRacesExcluded: integer("n_races_excluded").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.driverId] }),
    check(
      "mode2_driver_rating_anchor_check",
      sql`${t.anchorClass} IN ('anchored','component-anchored','floating')`,
    ),
    check("mode2_driver_rating_basis_check", sql`${t.basis} IN ('measured','by-analogy')`),
  ],
);

// Rating over time: one row per driver per season, each a LEAVE-FUTURE-OUT CUMULATIVE
// refit on all data up to the end of that season (§3.5). This is NOT a per-season refit.
// The band NARROWS at a team switch, because a transfer is the only event that adds
// identifying information. Any label claiming it widens there is wrong.
export const mode2DriverRatingHistory = pgTable(
  "mode2_driver_rating_history",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    throughYear: integer("through_year").notNull(),
    ratingPp: doublePrecision("rating_pp").notNull(),
    ratingLo: doublePrecision("rating_lo").notNull(),
    ratingHi: doublePrecision("rating_hi").notNull(),
    sdTotal: doublePrecision("sd_total").notNull(),
    anchorClass: text("anchor_class").notNull(),
    nRacesCumulative: integer("n_races_cumulative").notNull(),
    switchedThisYear: boolean("switched_this_year").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fitId, t.driverId, t.throughYear] })],
);

// One row per driver per skill, INCLUDING the two skills we measured and refused
// (tyre_management §3.3, wet §3.4), with a null value and a stored reason. The refusals
// are product (§3.6) -- they are rows, not absences, and they drive the
// "What we could not measure" panel that replaces the radar.
export const mode2DriverSkill = pgTable(
  "mode2_driver_skill",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    skill: text("skill").notNull(),
    measured: boolean("measured").notNull(),
    value: doublePrecision("value"),
    valueLo: doublePrecision("value_lo"),
    valueHi: doublePrecision("value_hi"),
    unit: text("unit").notNull(),
    evidenceShare: doublePrecision("evidence_share"),
    anchorClass: text("anchor_class").notNull(),
    pctFieldBelow: doublePrecision("pct_field_below"),
    notMeasuredReason: text("not_measured_reason"),
    nObs: integer("n_obs").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.driverId, t.skill] }),
    check(
      "mode2_driver_skill_measured_check",
      sql`(${t.measured} AND ${t.value} IS NOT NULL AND ${t.valueLo} IS NOT NULL AND ${t.valueHi} IS NOT NULL
      AND ${t.notMeasuredReason} IS NULL)
 OR (NOT ${t.measured} AND ${t.value} IS NULL AND ${t.notMeasuredReason} IS NOT NULL)`,
    ),
    // GAPFILL_SPEC §2.2 (v1.8): seven keys, not four. DL-11 is binding -- every key
    // listed here IS written by this release, as a real row for all 28 drivers:
    // one_lap_pace measured (D1), sprint_one_lap and trail_braking as measured = false
    // refusals (D3, D6) exactly as tyre_management and wet already are. A CHECK key
    // that is never written is a task disguised as a decision and is forbidden here.
    // The rows themselves are written by the fit (f1lab/decomp.py, WP-A1), never by
    // DDL: every row needs a fit_id, so there is no row to seed at migration time.
    check(
      "mode2_driver_skill_skill_check",
      sql`${t.skill} IN ('race_pace','one_lap_pace','grid_pace','tyre_management','wet','sprint_one_lap','trail_braking')`,
    ),
  ],
);

// Contrasts as first-class objects (§2.5). Exists so the web NEVER differences two
// marginal intervals: the effects are strongly negatively correlated and the naive
// combination is roughly twice too wide.
export const mode2DriverContrast = pgTable(
  "mode2_driver_contrast",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverA: text("driver_a")
      .notNull()
      .references(() => drivers.driverId),
    driverB: text("driver_b")
      .notNull()
      .references(() => drivers.driverId),
    kind: text("kind").notNull(),
    deltaPp: doublePrecision("delta_pp").notNull(),
    deltaSe: doublePrecision("delta_se").notNull(),
    deltaLo: doublePrecision("delta_lo").notNull(),
    deltaHi: doublePrecision("delta_hi").notNull(),
    sameComponent: boolean("same_component").notNull(),
    sharedCells: text("shared_cells").array().notNull(),
    nSharedRaces: integer("n_shared_races").notNull(),
    nRacesA: integer("n_races_a").notNull(),
    nRacesB: integer("n_races_b").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.driverA, t.driverB] }),
    check("mode2_driver_contrast_kind_check", sql`${t.kind} IN ('teammate','cross')`),
  ],
);

// --- §6.2 Constructor surface -----------------------------------------------

// Car rating + in-season development, per team-season (§5.2).
export const mode2CarRating = pgTable(
  "mode2_car_rating",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    year: integer("year").notNull(),
    gammaPp: doublePrecision("gamma_pp").notNull(),
    gammaLo: doublePrecision("gamma_lo").notNull(),
    gammaHi: doublePrecision("gamma_hi").notNull(),
    slopePp: doublePrecision("slope_pp").notNull(),
    slopeLo: doublePrecision("slope_lo").notNull(),
    slopeHi: doublePrecision("slope_hi").notNull(),
    startPp: doublePrecision("start_pp").notNull(),
    endPp: doublePrecision("end_pp").notNull(),
    slopeSignificant: boolean("slope_significant").notNull(),
    rankInSeason: integer("rank_in_season").notNull(),
    componentId: text("component_id").notNull(),
    basis: text("basis").notNull(),
    nRaces: integer("n_races").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fitId, t.teamId, t.year] })],
);

// Retirement hazard, split into car and driver components (§5.3). Never "reliability":
// a retirement is an observed outcome, not a measured property of the machine.
export const mode2CarHazard = pgTable(
  "mode2_car_hazard",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    year: integer("year").notNull(),
    retirements: integer("retirements").notNull(),
    racingLaps: integer("racing_laps").notNull(),
    hazardPer1000: doublePrecision("hazard_per_1000").notNull(),
    hazardLo: doublePrecision("hazard_lo").notNull(),
    hazardHi: doublePrecision("hazard_hi").notNull(),
    hazardCarOnly: doublePrecision("hazard_car_only").notNull(),
    hazardCarLo: doublePrecision("hazard_car_lo").notNull(),
    hazardCarHi: doublePrecision("hazard_car_hi").notNull(),
    rankInSeason: integer("rank_in_season").notNull(),
    sufficient: boolean("sufficient").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fitId, t.teamId, t.year] })],
);

// --- §6.2 Points bridge, career, counterfactuals ----------------------------

// The pace->points bridge and the Mode-2-only temperature (§4.1). One row per season.
// config.TITLE_PL_TEMPERATURE is NOT touched; this table exists so it never has to be.
export const mode2PointsCalib = pgTable(
  "mode2_points_calib",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    year: integer("year").notNull(),
    slopeThetaPerPp: doublePrecision("slope_theta_per_pp").notNull(),
    intercept: doublePrecision("intercept").notNull(),
    r2: doublePrecision("r2").notNull(),
    residSd: doublePrecision("resid_sd").notNull(),
    temperature: doublePrecision("temperature").notNull(),
    sdRatioSimActual: doublePrecision("sd_ratio_sim_actual").notNull(),
    replayMaePoints: doublePrecision("replay_mae_points").notNull(),
    replayCorr: doublePrecision("replay_corr").notNull(),
    nEntries: integer("n_entries").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fitId, t.year] })],
);

// Car-adjusted career, one row per driver-season (§4.3). actual_points is a fact;
// everything beside it is an estimate and is rendered as one.
export const mode2CareerSeason = pgTable(
  "mode2_career_season",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    year: integer("year").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    actualPoints: doublePrecision("actual_points").notNull(),
    replayPoints: doublePrecision("replay_points").notNull(),
    replayLo: doublePrecision("replay_lo").notNull(),
    replayHi: doublePrecision("replay_hi").notNull(),
    avgDriverPoints: doublePrecision("avg_driver_points").notNull(),
    avgDriverP10: doublePrecision("avg_driver_p10").notNull(),
    avgDriverP90: doublePrecision("avg_driver_p90").notNull(),
    contribution: doublePrecision("contribution").notNull(),
    contributionLo: doublePrecision("contribution_lo").notNull(),
    contributionHi: doublePrecision("contribution_hi").notNull(),
    mcStderr: doublePrecision("mc_stderr").notNull(),
    paramStderr: doublePrecision("param_stderr").notNull(),
    calibrationMae: doublePrecision("calibration_mae").notNull(),
    basis: text("basis").notNull(),
    anchorClass: text("anchor_class").notNull(),
    roundsInSeason: integer("rounds_in_season").notNull(),
    // How much of that calendar this seat actually covered, and in which cars. A
    // part-season entry replayed over the whole calendar is a championship the driver
    // never contested; `starts` is what lets the surface say so, and `teams` is what
    // lets it stop printing one team name for a seat that spanned two.
    starts: integer("starts").notNull(),
    teams: text("teams").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.driverId, t.year] }),
    check("mode2_career_season_basis_check", sql`${t.basis} IN ('measured','by-analogy')`),
    check("mode2_career_season_starts_check", sql`${t.starts} > 0`),
  ],
);

// Counterfactuals (§4.4). A row CANNOT EXIST without its interval -- this CHECK is the
// structural form of FD2 and is the reason no code path can emit a bare point estimate.
export const mode2Counterfactual = pgTable(
  "mode2_counterfactual",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    year: integer("year").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    replacedDriverId: text("replaced_driver_id")
      .notNull()
      .references(() => drivers.driverId),
    observed: boolean("observed").notNull(),
    pointsP10: doublePrecision("points_p10").notNull(),
    pointsP50: doublePrecision("points_p50").notNull(),
    pointsP90: doublePrecision("points_p90").notNull(),
    incumbentActual: doublePrecision("incumbent_actual").notNull(),
    deltaP10: doublePrecision("delta_p10").notNull(),
    deltaP50: doublePrecision("delta_p50").notNull(),
    deltaP90: doublePrecision("delta_p90").notNull(),
    basis: text("basis").notNull(),
    crossComponent: boolean("cross_component").notNull(),
    interactionPp: doublePrecision("interaction_pp").notNull(),
    calibrationMae: doublePrecision("calibration_mae").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.year, t.teamId, t.driverId] }),
    check(
      "mode2_counterfactual_interval_check",
      sql`${t.pointsP10} IS NOT NULL AND ${t.pointsP90} IS NOT NULL AND ${t.pointsP10} <= ${t.pointsP90}`,
    ),
    check("mode2_counterfactual_basis_check", sql`${t.basis} IN ('measured','by-analogy')`),
  ],
);

// Why a pace estimate was or was not used (§1.3). Lets /driver say "3 of Sainz's 24
// rounds were not usable" instead of silently dropping them.
export const mode2RowAudit = pgTable(
  "mode2_row_audit",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id").notNull(),
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    included: boolean("included").notNull(),
    excludeReason: text("exclude_reason"),
    yPp: doublePrecision("y_pp"),
    sePp: doublePrecision("se_pp"),
    lapsFit: integer("laps_fit").notNull(),
    badge: text("badge").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.sessionId, t.driverId] }),
    check("mode2_row_audit_reason_check", sql`${t.included} OR ${t.excludeReason} IS NOT NULL`),
    index("mode2_row_audit_driver_idx").on(t.fitId, t.driverId, t.year, t.round),
  ],
);

// --- GAPFILL_SPEC §2.2 (v1.8) The qualifying row audit --------------------------------

// Why a qualifying lap was or was not used by the one_lap_pace fit (§1.3, D1).
//
// Deliberately NOT rows in mode2_row_audit, for three reasons (§2.2):
//   1. mode2_row_audit.laps_fit and .badge are race-pace vocabulary and NOT NULL; a
//      qualifying best lap has neither.
//   2. mode2_row_audit.y_pp is a fuel-corrected race response. Mixing two responses in
//      one column is exactly the drift this spec exists to prevent.
//   3. tests/test_quali_integration.py pins mode2_row_audit = 983 as its proof that
//      v1.6 moved no race analytics. D7 requires that constant to still read 983 after
//      v1.8, and with a separate table it does.
//
// best_s is the raw segment-1 best lap in seconds; y_pp is its session-mean-centred
// percent (the fitted response). Both are nullable because an excluded row -- no time
// set, wet, sprint qualifying (D3) -- has a reason and no response.
export const mode2QualiRowAudit = pgTable(
  "mode2_quali_row_audit",
  {
    fitId: integer("fit_id")
      .notNull()
      .references(() => mode2FitRun.fitId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id").notNull(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id").notNull(),
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    kind: text("kind").notNull(),
    included: boolean("included").notNull(),
    excludeReason: text("exclude_reason"),
    yPp: doublePrecision("y_pp"),
    bestS: doublePrecision("best_s"),
  },
  (t) => [
    primaryKey({ columns: [t.fitId, t.sessionId, t.driverId] }),
    // TRAP 3 (MODE2_SPEC §6.4): named exactly as in §2.2, so a later
    // `drizzle-kit generate` cannot invent a name and emit a spurious drop/add pair.
    check(
      "mode2_quali_row_audit_reason_check",
      sql`${t.included} OR ${t.excludeReason} IS NOT NULL`,
    ),
    index("mode2_quali_row_audit_driver_idx").on(t.fitId, t.driverId, t.year, t.round),
  ],
);
