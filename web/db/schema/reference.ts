// SPEC §1.1–1.2: provenance root and reference tables.
// Column names are written out explicitly (no `casing` option): the DDL in
// docs/SPEC.md §1 is the contract and Python verifies names against
// information_schema before every ingest.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
} from "drizzle-orm/pg-core";

// §1.1 — one row per distinct set of modelling constants an ingest ran under.
export const assumptionSets = pgTable("assumption_sets", {
  assumptionSetId: serial("assumption_set_id").primaryKey(),
  // sha256 hex of json.dumps(params, sort_keys=True, separators=(',', ':'))
  hash: text("hash").notNull().unique(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// §1.2
export const seasons = pgTable("seasons", {
  year: integer("year").primaryKey(),
  scheduledRounds: integer("scheduled_rounds").notNull(),
  ingestedRounds: integer("ingested_rounds").notNull().default(0),
  standingsAfterRound: integer("standings_after_round"),
  assumptionSetId: integer("assumption_set_id").references(
    () => assumptionSets.assumptionSetId,
  ),
  mixedAssumptionSets: boolean("mixed_assumption_sets").notNull().default(false),
  hasSprintResults: boolean("has_sprint_results").notNull().default(false),
  recomputedAt: timestamp("recomputed_at", { withTimezone: true, mode: "string" }),
});

export const circuits = pgTable("circuits", {
  circuitKey: integer("circuit_key").primaryKey(),
  shortName: text("short_name").notNull(),
  location: text("location").notNull(),
  country: text("country").notNull(),
  // RESERVED, always NULL in v1 (decisions log D2)
  lapKm: doublePrecision("lap_km"),
});

export const events = pgTable(
  "events",
  {
    year: integer("year")
      .notNull()
      .references(() => seasons.year),
    round: integer("round").notNull(),
    eventName: text("event_name").notNull(),
    officialName: text("official_name").notNull(),
    location: text("location").notNull(),
    country: text("country").notNull(),
    eventFormat: text("event_format").notNull(),
    eventDate: date("event_date", { mode: "string" }).notNull(),
    circuitKey: integer("circuit_key").references(() => circuits.circuitKey),
  },
  (t) => [primaryKey({ columns: [t.year, t.round] })],
);

export const teams = pgTable("teams", {
  teamId: text("team_id").primaryKey(),
  latestName: text("latest_name").notNull(),
});

export const drivers = pgTable(
  "drivers",
  {
    driverId: text("driver_id").primaryKey(),
    latestCode: text("latest_code").notNull(),
    latestNumber: text("latest_number").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    fullName: text("full_name").notNull(),
    countryCode: text("country_code"),
    headshotUrl: text("headshot_url"),
  },
  (t) => [index("drivers_latest_code_idx").on(t.latestCode)],
);

// One row per timed session we know about, created from the SCHEDULE.
export const sessions = pgTable(
  "sessions",
  {
    sessionId: serial("session_id").primaryKey(),
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    // QUALI_SPEC v1.6 §1.1 (D2): widened from {R,S}. Stays `text`, not an enum.
    kind: text("kind").notNull(), // 'R' | 'S' | 'Q' | 'SQ'
    name: text("name").notNull(), // 'Race' | 'Sprint' | 'Qualifying' | 'Sprint Qualifying'
    startUtc: timestamp("start_utc", { withTimezone: true, mode: "string" }),
    totalLaps: integer("total_laps"),
    winnerDriverId: text("winner_driver_id").references(() => drivers.driverId),
    fastestPaceDriverId: text("fastest_pace_driver_id").references(
      () => drivers.driverId,
    ),
  },
  (t) => [
    check("sessions_kind_check", sql`kind IN ('R','S','Q','SQ')`),
    unique("sessions_year_round_kind_unique").on(t.year, t.round, t.kind),
    foreignKey({
      columns: [t.year, t.round],
      foreignColumns: [events.year, events.round],
      name: "sessions_year_round_events_fk",
    }),
    index("sessions_year_round_idx").on(t.year, t.round),
  ],
);
