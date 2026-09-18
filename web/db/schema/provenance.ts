// SPEC §1.9: ingest provenance.
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { assumptionSets, sessions } from "./reference";

export const ingestRuns = pgTable(
  "ingest_runs",
  {
    runId: serial("run_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    status: text("status").notNull(), // 'running' | 'ok' | 'partial' | 'failed' | 'aborted'
    cliArgs: jsonb("cli_args").$type<Record<string, unknown>>().notNull(),
    f1labVersion: text("f1lab_version").notNull(),
    fastf1Version: text("fastf1_version").notNull(),
    pythonVersion: text("python_version").notNull(),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    hostname: text("hostname"),
    sessionsAttempted: integer("sessions_attempted").notNull().default(0),
    sessionsOk: integer("sessions_ok").notNull().default(0),
    sessionsFailed: integer("sessions_failed").notNull().default(0),
    error: text("error"),
  },
  () => [
    check(
      "ingest_runs_status_check",
      sql`status IN ('running','ok','partial','failed','aborted')`,
    ),
  ],
);

// One row per session, REPLACED on re-ingest.
export const sessionIngests = pgTable(
  "session_ingests",
  {
    sessionId: integer("session_id")
      .primaryKey()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    runId: integer("run_id")
      .notNull()
      .references(() => ingestRuns.runId),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    status: text("status").notNull(), // 'ok' | 'partial' | 'failed'
    analyticsStatus: jsonb("analytics_status")
      .$type<Record<string, string>>()
      .notNull(),
    warnings: text("warnings").array().notNull().default(sql`'{}'`),
    error: text("error"),
    rawLaps: integer("raw_laps").notNull().default(0),
    cleanLaps: integer("clean_laps").notNull().default(0),
    totalLaps: integer("total_laps"),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    lapKmUsed: doublePrecision("lap_km_used"),
    fuelScale: doublePrecision("fuel_scale").notNull().default(1.0),
    f1labVersion: text("f1lab_version").notNull(),
    fastf1Version: text("fastf1_version").notNull(),
  },
  () => [
    check("session_ingests_status_check", sql`status IN ('ok','partial','failed')`),
  ],
);
