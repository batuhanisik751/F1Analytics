// TELEMETRY_SPEC v1.7 §2.1: the five telemetry tables.
// Additive and optional (§2.7): migration 0008 creates these and alters nothing.
// A database with zero telemetry rows is a legal database and the v1.6 app.
// T4 — arrays, one row per lap. T5 — `distance_m` is the cumulative CHORD length
// of (X, Y); FastF1's integrated `Distance` is never stored and never used.
// T6 — the ask box sees the derived scalars only; the array tables are excluded
// at the GRANT level, because the planner misprices `unnest()` by 63x (§2.2).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { circuits, sessions } from "./reference";
import { laps } from "./laps";

// §2.1 (1) — circuit geometry from session.get_circuit_info(), per circuit-YEAR:
// a layout can change between seasons and events are keyed by year.
export const circuitLayout = pgTable(
  "circuit_layout",
  {
    circuitKey: integer("circuit_key")
      .notNull()
      .references(() => circuits.circuitKey),
    year: integer("year").notNull(),
    // measured 95.0 for 2026 R13; applied in the BROWSER, never at write time (§0.3).
    rotationDeg: real("rotation_deg").notNull(),
    nCorners: integer("n_corners").notNull(),
    trackLengthM: real("track_length_m").notNull(), // chord length of the reference lap
    refSessionId: integer("ref_session_id")
      .notNull()
      .references(() => sessions.sessionId),
  },
  (t) => [primaryKey({ columns: [t.circuitKey, t.year] })],
);

export const circuitCorners = pgTable(
  "circuit_corners",
  {
    circuitKey: integer("circuit_key").notNull(),
    year: integer("year").notNull(),
    cornerNumber: integer("corner_number").notNull(),
    // '' | 'A' | 'B'. NOT NULL with a '' default because it is in the primary key.
    cornerLetter: text("corner_letter").notNull().default(""),
    x: real("x").notNull(), // FastF1 position units, raw and unrotated
    y: real("y").notNull(),
    angleDeg: real("angle_deg"),
    // CHORD distance along the reference lap, NOT FastF1's corner `Distance` (§2.1).
    distanceM: real("distance_m").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.circuitKey, t.year, t.cornerNumber, t.cornerLetter],
    }),
    foreignKey({
      columns: [t.circuitKey, t.year],
      foreignColumns: [circuitLayout.circuitKey, circuitLayout.year],
      name: "circuit_corners_layout_fk",
    }).onDelete("cascade"),
  ],
);

// §2.1 (2) — the channel arrays. One row per stored lap (T2: the driver's fastest
// valid lap). Never read column-wise, never partially: every read is a whole lap.
export const lapTelemetry = pgTable(
  "lap_telemetry",
  {
    sessionId: integer("session_id").notNull(),
    driverId: text("driver_id").notNull(),
    lapNumber: integer("lap_number").notNull(),
    selection: text("selection").notNull().default("fastest"),
    nSamples: integer("n_samples").notNull(),
    nCarSamples: integer("n_car_samples").notNull(),
    nPosSamples: integer("n_pos_samples").notNull(),
    // measured worst case 73.7-85.7 m; §5.2 shades the interval it falls in.
    maxSampleGapM: real("max_sample_gap_m").notNull(),
    trackLengthM: real("track_length_m").notNull(), // = distance_m[n_samples]
    sourceHash: text("source_hash").notNull(), // §3.5 idempotency key
    // T5: CHORD distance, monotone non-decreasing, [1] = 0.
    distanceM: real("distance_m").array().notNull(),
    timeS: real("time_s").array().notNull(), // seconds from the lap's first sample, [1] = 0
    x: real("x").array().notNull(),
    y: real("y").array().notNull(),
    speedKph: smallint("speed_kph").array().notNull(),
    // 0..104 as delivered; NOT clamped — the overshoot is real (§6.5).
    throttlePct: smallint("throttle_pct").array().notNull(),
    brake: boolean("brake").array().notNull(),
    gear: smallint("gear").array().notNull(), // 1..8; 0 appears and means "no reading"
    drs: smallint("drs").array().notNull(), // raw DRS code, NOT a boolean (§6.5)
    // GAPFILL §4.3 / R1 — the recipe version, beside `source_hash`'s raw-input hash.
    // `source_hash` covers the FastF1 channels only, so every one of the 1,518 laps
    // hashes identically across a derived-metric change and a default warm run would
    // skip all of them while exiting 0. The skip condition is therefore
    // `source_hash matches AND derive_version = TRAIL_DERIVE_VERSION`.
    // Legacy rows default to 1; migration 0010 ships TRAIL_DERIVE_VERSION = 2, so
    // every stored lap is stale on day one and the backfill cannot silently no-op.
    deriveVersion: smallint("derive_version").notNull().default(1),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.lapNumber] }),
    foreignKey({
      columns: [t.sessionId, t.driverId, t.lapNumber],
      foreignColumns: [laps.sessionId, laps.driverId, laps.lapNumber],
      name: "lap_telemetry_lap_fk",
    }).onDelete("cascade"),
    check("lap_telemetry_selection_check", sql`selection IN ('fastest')`),
    check("lap_telemetry_samples_check", sql`n_samples BETWEEN 50 AND 5000`),
    // The constraint the row-per-sample layout cannot express at all: it makes a
    // ragged lap unrepresentable. Per-row only — it cannot see a cross-lap
    // mismatch, and does not need to, because §5.2 never compares by index.
    check(
      "lap_telemetry_lengths_check",
      sql`array_length(distance_m,1) = n_samples AND array_length(time_s,1) = n_samples AND
    array_length(x,1) = n_samples AND array_length(y,1) = n_samples AND
    array_length(speed_kph,1) = n_samples AND array_length(brake,1) = n_samples AND
    array_length(throttle_pct,1) = n_samples AND array_length(gear,1) = n_samples AND
    array_length(drs,1) = n_samples`,
    ),
    index("lap_telemetry_session_idx").on(t.sessionId),
  ],
);

// §2.1 (3) — derived scalars, computed once at ingest (§4). The ONLY telemetry the
// ask box sees (T6). Percentages are of lap DISTANCE, never of samples (§0.3).
export const lapTelemetrySummary = pgTable(
  "lap_telemetry_summary",
  {
    sessionId: integer("session_id").notNull(),
    driverId: text("driver_id").notNull(),
    lapNumber: integer("lap_number").notNull(),
    topSpeedKph: smallint("top_speed_kph").notNull(),
    minSpeedKph: smallint("min_speed_kph").notNull(),
    fullThrottlePct: real("full_throttle_pct").notNull(),
    brakePct: real("brake_pct").notNull(),
    liftPct: real("lift_pct").notNull(), // measured, NOT 100 - the other two (§4.1)
    overlapPct: real("overlap_pct").notNull(), // full throttle AND brake at once
    nBrakeZones: integer("n_brake_zones").notNull(),
    nGearChanges: integer("n_gear_changes").notNull(),
    // NULL when the DRS channel was flat (§6.5). Absent is not zero. Never 0.
    drsDistanceM: real("drs_distance_m"),
    trackLengthM: real("track_length_m").notNull(),
    s1DistanceM: real("s1_distance_m"), // chord distance at the driver's own S1 time
    s2DistanceM: real("s2_distance_m"),
    nSamples: integer("n_samples").notNull(),
    maxSampleGapM: real("max_sample_gap_m").notNull(),
    nGapsOver50M: integer("n_gaps_over_50m").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId, t.lapNumber] }),
    foreignKey({
      columns: [t.sessionId, t.driverId, t.lapNumber],
      foreignColumns: [
        lapTelemetry.sessionId,
        lapTelemetry.driverId,
        lapTelemetry.lapNumber,
      ],
      name: "lap_telemetry_summary_lap_fk",
    }).onDelete("cascade"),
  ],
);

// §2.1 (4) — the corner report card, one row per corner of the stored lap (§4.2).
export const lapCornerSpeeds = pgTable(
  "lap_corner_speeds",
  {
    sessionId: integer("session_id").notNull(),
    driverId: text("driver_id").notNull(),
    lapNumber: integer("lap_number").notNull(),
    cornerNumber: integer("corner_number").notNull(),
    cornerLetter: text("corner_letter").notNull().default(""),
    apexSpeedKph: smallint("apex_speed_kph").notNull(),
    apexDistanceM: real("apex_distance_m").notNull(),
    entrySpeedKph: smallint("entry_speed_kph").notNull(),
    exitSpeedKph: smallint("exit_speed_kph").notNull(),
    brakeZoneIdx: integer("brake_zone_idx"), // which brake application serves it (§4.2)
    brakePointM: real("brake_point_m"), // NULL when the corner is taken flat
    brakeDistanceM: real("brake_distance_m"),
    throttlePointM: real("throttle_point_m"),
    timeInCornerS: real("time_in_corner_s").notNull(),
    // ---- GAPFILL §4.1, migration 0010: the five trail-braking columns, in DDL order.
    // `ALTER TABLE ... ADD COLUMN` appends; the physical ordinal positions are 15..19,
    // not "after brake_distance_m" (§4.1's phrase is the order of the five statements
    // relative to each other, which Postgres cannot honour mid-table without a rewrite).
    // Where the brake came OFF — the trailing edge of the boolean channel, taken at the
    // midpoint of the bracketing sample step. A reading, not a model (§0.3).
    brakeReleaseM: real("brake_release_m"),
    // apex_distance_m - brake_release_m. Negative = still braking past the apex.
    brakeReleaseToApexM: real("brake_release_to_apex_m"),
    // brake_release_m - brake_point_m: how long the pedal was down.
    brakeOnDistanceM: real("brake_on_distance_m"),
    // Unrendered diagnostic (D5). Exempt from the release CHECK: computable at a
    // non-terminal shared corner and stored there. Never exposed by the ask view (§4.4).
    trailDuty: real("trail_duty"),
    // Stored, not inferred (§4.1): a blank cell must say WHICH of six things happened,
    // and the component takes the reason as a prop from the database rather than
    // guessing from a NULL. Default 'measured' is the steady-state value for derived
    // rows; see migration 0010 for why the legacy 24,963 rows land on 'too_few_samples'.
    trailStatus: text("trail_status").notNull().default("measured"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.sessionId,
        t.driverId,
        t.lapNumber,
        t.cornerNumber,
        t.cornerLetter,
      ],
    }),
    foreignKey({
      columns: [t.sessionId, t.driverId, t.lapNumber],
      foreignColumns: [
        lapTelemetry.sessionId,
        lapTelemetry.driverId,
        lapTelemetry.lapNumber,
      ],
      name: "lap_corner_speeds_lap_fk",
    }).onDelete("cascade"),
    index("lap_corner_speeds_corner_idx").on(t.sessionId, t.cornerNumber),
    // GAPFILL §4.1 — the six reasons, closed. 'measured' plus five refusals.
    check(
      "lap_corner_speeds_trail_status_check",
      sql`trail_status IN ('measured','taken_flat','shared_zone_non_terminal',
                   'too_few_samples','release_step_too_wide','implied_decel_impossible')`,
    ),
    // GAPFILL §4.1 — the three release numbers are NULL together, always: ONE check,
    // not three chances to disagree. `trail_duty` is deliberately absent from it.
    // Enforcement lives here, in the database, not in a caption (§4.1, R4).
    check(
      "lap_corner_speeds_trail_check",
      sql`(trail_status <> 'measured'
     AND brake_release_m IS NULL AND brake_release_to_apex_m IS NULL
     AND brake_on_distance_m IS NULL)
  OR (trail_status = 'measured'
     AND brake_release_m IS NOT NULL AND brake_release_to_apex_m IS NOT NULL
     AND brake_on_distance_m IS NOT NULL AND brake_point_m IS NOT NULL)`,
    ),
  ],
);
