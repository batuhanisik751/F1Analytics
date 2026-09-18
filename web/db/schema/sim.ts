// SIM_SPEC §2.1: Monte Carlo strategy-simulator tables (v1.1). Four per-session tables
// (cascade on session_id) plus the circuit-level hazard table (no cascade).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { assumptionSets, circuits, sessions } from "./reference";
import { sessionEntries } from "./session";

// One row per race with a model (f1lab.sim.fit_race → SimFit.race_params).
export const simRaceParams = pgTable(
  "sim_race_params",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    totalLaps: integer("total_laps").notNull(),
    refCompound: text("ref_compound").notNull(),
    lapsFit: integer("laps_fit").notNull(),
    driversFit: integer("drivers_fit").notNull(),
    r2: doublePrecision("r2").notNull(),
    residSdS: doublePrecision("resid_sd_s").notNull(),
    residMadS: doublePrecision("resid_mad_s").notNull(),
    designCond: doublePrecision("design_cond").notNull(),
    evoSPerLap: doublePrecision("evo_s_per_lap").notNull(),
    evoSe: doublePrecision("evo_se").notNull(),
    paramNames: text("param_names").array().notNull(),
    paramMean: doublePrecision("param_mean").array().notNull(),
    paramChol: doublePrecision("param_chol").array().notNull(),
    fieldDeltaS: doublePrecision("field_delta_s").array().notNull(),
    fieldDeltaCars: integer("field_delta_cars").array().notNull(),
    startPenaltyS: doublePrecision("start_penalty_s").notNull(),
    pitLossS: doublePrecision("pit_loss_s"),
    pitLossMadS: doublePrecision("pit_loss_mad_s"),
    pitLossN: integer("pit_loss_n").notNull(),
    pitLossSamplesS: doublePrecision("pit_loss_samples_s").array().notNull(),
    scPitSamplesS: doublePrecision("sc_pit_samples_s").array().notNull(),
    vscPitSamplesS: doublePrecision("vsc_pit_samples_s").array().notNull(),
    scPitFactorRace: doublePrecision("sc_pit_factor_race"),
    vscPitFactorRace: doublePrecision("vsc_pit_factor_race"),
    stintCoverage80: doublePrecision("stint_coverage_80"),
    nScLaps: integer("n_sc_laps").notNull(),
    nVscLaps: integer("n_vsc_laps").notNull(),
    nRedLaps: integer("n_red_laps").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId] })],
);

// One row per parameterised compound (§1.2, §1.4, §1.5).
export const simCompoundParams = pgTable(
  "sim_compound_params",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    compound: text("compound").notNull(),
    laps: integer("laps").notNull(),
    ageMax: integer("age_max").notNull(),
    offsetS: doublePrecision("offset_s").notNull(),
    offsetSe: doublePrecision("offset_se").notNull(),
    degRawSPerLap: doublePrecision("deg_raw_s_per_lap").notNull(),
    degSPerLap: doublePrecision("deg_s_per_lap").notNull(),
    degSe: doublePrecision("deg_se").notNull(),
    degNegative: boolean("deg_negative").notNull(),
    stintTauLevelS: doublePrecision("stint_tau_level_s").notNull(),
    stintTauSlope: doublePrecision("stint_tau_slope").notNull(),
    stintTauSource: text("stint_tau_source").notNull(),
    stintsUsed: integer("stints_used").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.compound] }),
    check("sim_compound_params_tau_source", sql`stint_tau_source IN ('race','prior')`),
  ],
);

// One row per driver with a dummy in the fit; calibration columns are NULL when simulable = false.
export const simDriverParams = pgTable(
  "sim_driver_params",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    lapsFit: integer("laps_fit").notNull(),
    baseS: doublePrecision("base_s").notNull(),
    baseSe: doublePrecision("base_se").notNull(),
    noiseSdS: doublePrecision("noise_sd_s").notNull(),
    lapsCompleted: integer("laps_completed").notNull(),
    lapsTimed: integer("laps_timed").notNull(),
    lapsModelled: integer("laps_modelled").notNull(),
    unmodelledLaps: integer("unmodelled_laps").notNull(),
    stops: integer("stops").notNull(),
    simulable: boolean("simulable").notNull(),
    notSimulableReason: text("not_simulable_reason"),
    realTotalS: doublePrecision("real_total_s"),
    realTotalFcS: doublePrecision("real_total_fc_s"),
    realFuelS: doublePrecision("real_fuel_s"),
    simTotalFcS: doublePrecision("sim_total_fc_s"),
    misfitRepS: doublePrecision("misfit_rep_s"),
    misfitPitS: doublePrecision("misfit_pit_s"),
    misfitLap1S: doublePrecision("misfit_lap1_s"),
    unmodelledS: doublePrecision("unmodelled_s"),
    badge: text("badge"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "sim_driver_params_session_entry_fk",
    }),
    check("sim_driver_params_badge", sql`badge IN ('calibrated','rough','poor')`),
  ],
);

// Shrunk driver × compound deviation; a row exists only where the driver has >= 1 fit row on the compound.
export const simDriverCompound = pgTable(
  "sim_driver_compound",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    driverId: text("driver_id").notNull(),
    compound: text("compound").notNull(),
    laps: integer("laps").notNull(),
    dcOffsetS: doublePrecision("dc_offset_s").notNull(),
    dcSe: doublePrecision("dc_se").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.compound] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "sim_driver_compound_session_entry_fk",
    }),
  ],
);

// Circuit hazard + pooled fallbacks (§1.9). Not a session child: no cascade.
export const simCircuitHazard = pgTable(
  "sim_circuit_hazard",
  {
    circuitKey: integer("circuit_key")
      .notNull()
      .references(() => circuits.circuitKey),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    recomputedAt: timestamp("recomputed_at", { withTimezone: true, mode: "string" }).notNull(),
    races: integer("races").notNull(),
    laps: integer("laps").notNull(),
    scEpisodes: integer("sc_episodes").notNull(),
    vscEpisodes: integer("vsc_episodes").notNull(),
    scHazard: doublePrecision("sc_hazard").notNull(),
    vscHazard: doublePrecision("vsc_hazard").notNull(),
    pitLossCircuitS: doublePrecision("pit_loss_circuit_s"),
    pooledRaces: integer("pooled_races").notNull(),
    scHazardPooled: doublePrecision("sc_hazard_pooled").notNull(),
    vscHazardPooled: doublePrecision("vsc_hazard_pooled").notNull(),
    scStartP: doublePrecision("sc_start_p").notNull(),
    vscStartP: doublePrecision("vsc_start_p").notNull(),
    scDurMean: doublePrecision("sc_dur_mean").notNull(),
    vscDurMean: doublePrecision("vsc_dur_mean").notNull(),
    pitLossPooledS: doublePrecision("pit_loss_pooled_s").notNull(),
    pitLossPooledMadS: doublePrecision("pit_loss_pooled_mad_s").notNull(),
    scPitFactorPooled: doublePrecision("sc_pit_factor_pooled").notNull(),
    vscPitFactorPooled: doublePrecision("vsc_pit_factor_pooled").notNull(),
  },
  (t) => [primaryKey({ columns: [t.circuitKey] })],
);
