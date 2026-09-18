// SPEC §1.6: analytics tables (race sessions only; one per f1lab function).
import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { assumptionSets, sessions } from "./reference";
import { sessionEntries } from "./session";

// clean.exclusion_report(session), row-for-row incl. the final SURVIVING row.
export const lapExclusionReport = pgTable(
  "lap_exclusion_report",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    ruleOrder: integer("rule_order").notNull(),
    rule: text("rule").notNull(),
    lapsHit: integer("laps_hit").notNull(),
    pctOfAll: doublePrecision("pct_of_all").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.rule] })],
);

// pace.pace_ranking + pace.pace_distribution + sensitivity rank range.
export const paceRanking = pgTable(
  "pace_ranking",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    rank: integer("rank").notNull(),
    teamId: text("team_id").notNull(),
    cleanLaps: integer("clean_laps").notNull(),
    medianPaceS: doublePrecision("median_pace_s").notNull(),
    bestPaceS: doublePrecision("best_pace_s").notNull(),
    iqrS: doublePrecision("iqr_s").notNull(),
    gapS: doublePrecision("gap_s").notNull(),
    gapPct: doublePrecision("gap_pct").notNull(),
    boxWhiskerLoS: doublePrecision("box_whisker_lo_s").notNull(),
    boxQ1S: doublePrecision("box_q1_s").notNull(),
    boxQ3S: doublePrecision("box_q3_s").notNull(),
    boxWhiskerHiS: doublePrecision("box_whisker_hi_s").notNull(),
    boxMeanS: doublePrecision("box_mean_s").notNull(),
    sensRankLo: integer("sens_rank_lo"),
    sensRankHi: integer("sens_rank_hi"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId] }),
    unique("pace_ranking_session_id_rank_unique").on(t.sessionId, t.rank),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "pace_ranking_session_entry_fk",
    }),
    index("pace_ranking_driver_idx").on(t.driverId, t.sessionId),
  ],
);

// pace.degradation(laps_fc): one row per driver-stint.
export const degradationFits = pgTable(
  "degradation_fits",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    stint: integer("stint").notNull(),
    teamId: text("team_id").notNull(),
    compound: text("compound").notNull(),
    laps: integer("laps").notNull(),
    degSPerLap: doublePrecision("deg_s_per_lap").notNull(),
    degStdErr: doublePrecision("deg_std_err").notNull(),
    r2: doublePrecision("r2").notNull(),
    freshPaceS: doublePrecision("fresh_pace_s").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.stint] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "degradation_fits_session_entry_fk",
    }),
    index("degradation_fits_compound_idx").on(t.compound, t.sessionId),
  ],
);

// pace.compound_degradation(laps_fc, deg): pooled np.polyfit line per compound.
export const compoundDegradation = pgTable(
  "compound_degradation",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    compound: text("compound").notNull(),
    laps: integer("laps").notNull(),
    slopeSPerLap: doublePrecision("slope_s_per_lap").notNull(),
    interceptS: doublePrecision("intercept_s").notNull(),
    xMin: integer("x_min").notNull(),
    xMax: integer("x_max").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.compound] })],
);

// pace.teammate_deltas(ranking)
export const teammateDeltas = pgTable(
  "teammate_deltas",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    teamId: text("team_id").notNull(),
    fasterDriverId: text("faster_driver_id").notNull(),
    slowerDriverId: text("slower_driver_id").notNull(),
    gapS: doublePrecision("gap_s").notNull(),
    gapPct: doublePrecision("gap_pct").notNull(),
    lapsCompared: integer("laps_compared").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.teamId] }),
    index("teammate_deltas_faster_idx").on(t.fasterDriverId, t.sessionId),
    index("teammate_deltas_slower_idx").on(t.slowerDriverId, t.sessionId),
  ],
);

// pace.fuel_sensitivity(...) melted from wide (rank@v, gap@v) to long.
export const fuelSensitivity = pgTable(
  "fuel_sensitivity",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    fuelEffectSPerKg: doublePrecision("fuel_effect_s_per_kg").notNull(),
    rank: integer("rank").notNull(),
    gapS: doublePrecision("gap_s").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.fuelEffectSPerKg] }),
  ],
);
