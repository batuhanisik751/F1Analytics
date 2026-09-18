// QUALI_SPEC v1.6 §3.3–§3.6: the four qualifying tables.
// Qualifying laps themselves live in `laps` (D1, §3.1); these hold the official
// classification, the per-segment long form, and the teammate head-to-heads.
// Every table is delete-and-rebuild per session, except `season_quali_h2h`,
// which is season-scoped and rebuilt by season.py.
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
  text,
} from "drizzle-orm/pg-core";
import { drivers, sessions } from "./reference";
import { sessionEntries } from "./session";

// §3.3 — the wide row the pages want. `results` stays "the classification of a
// race or sprint"; a Q/SQ session supplies only Position, so it writes here.
export const qualiResults = pgTable(
  "quali_results",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id").notNull(),
    position: integer("position").notNull(),
    q1S: doublePrecision("q1_s"),
    q2S: doublePrecision("q2_s"),
    q3S: doublePrecision("q3_s"),
    bestS: doublePrecision("best_s"),
    bestSegment: integer("best_segment"),
    bestLapNumber: integer("best_lap_number"),
    segmentsEntered: integer("segments_entered").notNull(),
    knockedOutIn: integer("knocked_out_in"),
    setATime: boolean("set_a_time").notNull(),
    // §4.1 (D6): two gaps, because one of them is a lie half the time.
    gapToPoleS: doublePrecision("gap_to_pole_s"),
    gapToPolePct: doublePrecision("gap_to_pole_pct"),
    gapToPoleCommonS: doublePrecision("gap_to_pole_common_s"),
    gapToPoleCommonPct: doublePrecision("gap_to_pole_common_pct"),
    gapToPoleSegment: integer("gap_to_pole_segment"),
    nReprLaps: integer("n_repr_laps").notNull(),
    pushLaps: integer("push_laps").notNull(),
    timesSource: text("times_source").notNull(), // 'api' (Q) | 'derived' (SQ)
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "quali_results_session_entry_fk",
    }).onDelete("cascade"),
    check(
      "quali_results_best_segment_check",
      sql`best_segment IS NULL OR best_segment BETWEEN 1 AND 3`,
    ),
    check(
      "quali_results_pole_segment_check",
      sql`gap_to_pole_segment IS NULL OR gap_to_pole_segment BETWEEN 1 AND 3`,
    ),
    check(
      "quali_results_entered_check",
      sql`segments_entered BETWEEN 1 AND 3`,
    ),
    check(
      "quali_results_time_check",
      sql`set_a_time = (best_s IS NOT NULL)`,
    ),
    check(
      "quali_results_times_source_check",
      sql`times_source IN ('api','derived')`,
    ),
    index("quali_results_driver_idx").on(t.driverId),
  ],
);

// §3.4 — the long form; the only place a per-segment gap or a repeatability
// estimate can live. spread_s / sd_s are NULL when the driver ran <2 push laps
// in the segment (16.4% of driver-segments); the UI renders that hollow.
export const qualiSegmentTimes = pgTable(
  "quali_segment_times",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    segment: integer("segment").notNull(),
    lapsRun: integer("laps_run").notNull(),
    reprLaps: integer("repr_laps").notNull(),
    pushLaps: integer("push_laps").notNull(),
    bestS: doublePrecision("best_s"),
    bestLapNumber: integer("best_lap_number"),
    gapToBestS: doublePrecision("gap_to_best_s"),
    gapToBestPct: doublePrecision("gap_to_best_pct"),
    spreadS: doublePrecision("spread_s"),
    sdS: doublePrecision("sd_s"),
    compound: text("compound"),
    tyreLife: integer("tyre_life"),
    wetCompound: boolean("wet_compound").notNull(),
    // QUALI_SPEC v1.6 §10: false when the driver-segment's anchor could not be verified
    // because the OFFICIAL Qk is a byte-identical copy of another segment's value, so no
    // lap can confirm it. `best_s` is then the lap found in that window and it may disagree
    // with `quali_results.q{k}_s` (measured: 2024 R21 Sao Paulo, ALO -3.963 s). Every
    // surface must suppress or mark an unverified row rather than print it as measured.
    verified: boolean("verified").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.segment] }),
    check(
      "quali_segment_times_segment_check",
      sql`segment BETWEEN 1 AND 3`,
    ),
  ],
);

// §3.5 — per session, per team pair. driver_a is the QUICKER of the two;
// classified_ahead is who was classified ahead, which legitimately disagrees
// (`divergent`). `below_noise` forbids the UI from printing a number (§0.4 n2).
export const qualiTeammateH2h = pgTable(
  "quali_teammate_h2h",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    driverA: text("driver_a")
      .notNull()
      .references(() => drivers.driverId),
    driverB: text("driver_b")
      .notNull()
      .references(() => drivers.driverId),
    segment: integer("segment"),
    aBestS: doublePrecision("a_best_s"),
    bBestS: doublePrecision("b_best_s"),
    deltaS: doublePrecision("delta_s"),
    deltaPct: doublePrecision("delta_pct"),
    comparable: boolean("comparable").notNull(),
    classifiedAhead: text("classified_ahead")
      .notNull()
      .references(() => drivers.driverId),
    divergent: boolean("divergent").notNull(),
    sessionSdS: doublePrecision("session_sd_s"),
    belowNoise: boolean("below_noise").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.sessionId, t.teamId, t.driverA, t.driverB],
    }),
    check(
      "quali_teammate_h2h_segment_check",
      sql`segment IS NULL OR segment BETWEEN 1 AND 3`,
    ),
  ],
);

// §3.6 — season-scoped, rebuilt by season.py (NOT a SESSION_CHILD_TABLE).
// `kind` is in the PK from the start: a sprint-qualifying gap and a qualifying
// gap are NEVER pooled (§5.2). Median-and-MAD, not mean-and-SD.
export const seasonQualiH2h = pgTable(
  "season_quali_h2h",
  {
    year: integer("year").notNull(),
    kind: text("kind").notNull(), // 'Q' | 'SQ'
    teamId: text("team_id").notNull(),
    driverA: text("driver_a")
      .notNull()
      .references(() => drivers.driverId),
    driverB: text("driver_b")
      .notNull()
      .references(() => drivers.driverId),
    sessionsCounted: integer("sessions_counted").notNull(),
    aWins: integer("a_wins").notNull(),
    bWins: integer("b_wins").notNull(),
    deltasCounted: integer("deltas_counted").notNull(),
    medianDeltaS: doublePrecision("median_delta_s"),
    medianDeltaPct: doublePrecision("median_delta_pct"),
    madDeltaPct: doublePrecision("mad_delta_pct"),
    sessionsCaveated: integer("sessions_caveated").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.year, t.kind, t.teamId, t.driverA, t.driverB],
    }),
    check("season_quali_h2h_kind_check", sql`kind IN ('Q','SQ')`),
    check(
      "season_quali_h2h_wins_check",
      sql`a_wins + b_wins = sessions_counted`,
    ),
  ],
);
