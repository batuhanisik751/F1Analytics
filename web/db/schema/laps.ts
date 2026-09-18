// SPEC §1.4–1.5: every raw lap (annotated) and derived per-lap facts.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";
import { sessions } from "./reference";
import { sessionEntries } from "./session";

// §1.4 + QUALI_SPEC v1.6 §3.1 (D1) — race, sprint AND qualifying laps live here.
// RULE: every query against `laps` that is not already scoped to a single
// `session_id` MUST constrain `sessions.kind`. The five quali_* columns below are
// NULL on every R/S lap; `quali_segment IS NOT NULL` identifies a qualifying lap
// without a join.
export const laps = pgTable(
  "laps",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id").notNull(),
    lapNumber: integer("lap_number").notNull(),
    // raw FastF1 (NULL where FastF1 has NaN/NaT/'nan')
    stint: integer("stint"),
    compound: text("compound"),
    tyreLife: integer("tyre_life"),
    freshTyre: boolean("fresh_tyre"),
    position: integer("position"),
    trackStatus: text("track_status"),
    lapTimeS: doublePrecision("lap_time_s"),
    sessionTimeS: doublePrecision("session_time_s"),
    lapStartTimeS: doublePrecision("lap_start_time_s"),
    sector1S: doublePrecision("sector1_s"),
    sector2S: doublePrecision("sector2_s"),
    sector3S: doublePrecision("sector3_s"),
    speedI1: real("speed_i1"),
    speedI2: real("speed_i2"),
    speedFl: real("speed_fl"),
    speedSt: real("speed_st"),
    pitInTimeS: doublePrecision("pit_in_time_s"),
    pitOutTimeS: doublePrecision("pit_out_time_s"),
    isAccurate: boolean("is_accurate").notNull(),
    deleted: boolean("deleted").notNull(),
    deletedReason: text("deleted_reason"),
    fastf1Generated: boolean("fastf1_generated").notNull(),
    isPersonalBest: boolean("is_personal_best").notNull(),
    // clean.annotate_laps outputs
    exclNoTime: boolean("excl_no_time").notNull(),
    exclInLap: boolean("excl_in_lap").notNull(),
    exclOutLap: boolean("excl_out_lap").notNull(),
    exclNotGreen: boolean("excl_not_green").notNull(),
    exclInaccurate: boolean("excl_inaccurate").notNull(),
    exclDeleted: boolean("excl_deleted").notNull(),
    passesRules: boolean("passes_rules").notNull(),
    isOutlier: boolean("is_outlier").notNull(),
    isRepresentative: boolean("is_representative").notNull(),
    // pace.fuel_correct outputs
    fuelKg: doublePrecision("fuel_kg"),
    fuelPenaltyS: doublePrecision("fuel_penalty_s"),
    lapTimeFcS: doublePrecision("lap_time_fc_s"),
    // f1lab.derive.gap_to_leader outputs
    gapToLeaderS: doublePrecision("gap_to_leader_s"),
    intervalS: doublePrecision("interval_s"),
    leaderDriverId: text("leader_driver_id"),
    // QUALI_SPEC §3.2 — five qualifying-only columns, all nullable (NULL for R/S).
    qualiSegment: integer("quali_segment"),
    segmentSource: text("segment_source"),
    isPushLap: boolean("is_push_lap"),
    exclDisallowed: boolean("excl_disallowed"),
    deletedInferred: boolean("deleted_inferred"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.lapNumber] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "laps_session_entry_fk",
    }),
    index("laps_session_lap_idx").on(t.sessionId, t.lapNumber),
    index("laps_session_repr_idx")
      .on(t.sessionId, t.compound, t.tyreLife)
      .where(sql`is_representative`),
    index("laps_driver_idx").on(t.driverId, t.sessionId),
    check(
      "laps_quali_segment_check",
      sql`quali_segment IS NULL OR quali_segment BETWEEN 1 AND 3`,
    ),
    check(
      "laps_segment_source_check",
      sql`segment_source IS NULL OR segment_source IN ('window','anchor_repair')`,
    ),
    index("laps_quali_segment_idx")
      .on(t.sessionId, t.qualiSegment)
      .where(sql`quali_segment IS NOT NULL`),
  ],
);

// §1.5 — field-wide flag state per lap number.
export const lapStatus = pgTable(
  "lap_status",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    lapNumber: integer("lap_number").notNull(),
    isGreen: boolean("is_green").notNull(),
    worstStatus: text("worst_status").notNull(),
    driversAffected: integer("drivers_affected").notNull(),
    driversOnLap: integer("drivers_on_lap").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.lapNumber] })],
);

// Pit stops paired from PitInTime / PitOutTime.
export const pitStops = pgTable(
  "pit_stops",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id").notNull(),
    stopNumber: integer("stop_number").notNull(),
    lapIn: integer("lap_in").notNull(),
    lapOut: integer("lap_out"),
    pitInTimeS: doublePrecision("pit_in_time_s").notNull(),
    pitOutTimeS: doublePrecision("pit_out_time_s"),
    pitLaneS: doublePrecision("pit_lane_s"),
    compoundIn: text("compound_in"),
    compoundOut: text("compound_out"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.stopNumber] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "pit_stops_session_entry_fk",
    }),
  ],
);

// clean.stint_table(session): grouped by (Driver, Stint, Compound).
export const stints = pgTable(
  "stints",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id").notNull(),
    stint: integer("stint").notNull(),
    compound: text("compound").notNull(),
    startLap: integer("start_lap").notNull(),
    endLap: integer("end_lap").notNull(),
    laps: integer("laps").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.stint, t.compound] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "stints_session_entry_fk",
    }),
  ],
);
