// SPEC §1.3: per-session identity, colours and results.
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { drivers, sessions, teams } from "./reference";

// Team name and colour AS THEY WERE in this session.
export const sessionTeams = pgTable(
  "session_teams",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    teamName: text("team_name").notNull(),
    colour: text("colour").notNull(), // '#rrggbb' lowercase
    colourSource: text("colour_source").notNull(), // 'fastf1' | 'results' | 'fallback'
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.teamId] }),
    unique("session_teams_session_id_team_name_unique").on(t.sessionId, t.teamName),
    check(
      "session_teams_colour_source_check",
      sql`colour_source IN ('fastf1','results','fallback')`,
    ),
  ],
);

// One row per driver in session.results.
export const sessionEntries = pgTable(
  "session_entries",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id").notNull(),
    code: text("code").notNull(), // results.Abbreviation
    driverNumber: text("driver_number").notNull(),
    lineStyle: text("line_style").notNull(), // 'solid' | 'dashed' | 'dotted'
    lineStyleSource: text("line_style_source").notNull(), // 'fastf1' | 'fallback'
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId] }),
    unique("session_entries_session_id_code_unique").on(t.sessionId, t.code),
    unique("session_entries_session_id_driver_number_unique").on(
      t.sessionId,
      t.driverNumber,
    ),
    foreignKey({
      columns: [t.sessionId, t.teamId],
      foreignColumns: [sessionTeams.sessionId, sessionTeams.teamId],
      name: "session_entries_session_team_fk",
    }),
    check(
      "session_entries_line_style_check",
      sql`line_style IN ('solid','dashed','dotted')`,
    ),
    check(
      "session_entries_line_style_source_check",
      sql`line_style_source IN ('fastf1','fallback')`,
    ),
  ],
);

// Compound colour mapping for this session. Race sessions only.
export const compoundColours = pgTable(
  "compound_colours",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    compound: text("compound").notNull(),
    colour: text("colour").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.compound] })],
);

// session.results, race AND sprint sessions.
export const results = pgTable(
  "results",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    driverId: text("driver_id").notNull(),
    position: integer("position"),
    classifiedPosition: text("classified_position").notNull(),
    gridPosition: integer("grid_position"),
    points: doublePrecision("points").notNull().default(0),
    status: text("status").notNull(),
    lapsCompleted: integer("laps_completed"),
    resultTimeS: doublePrecision("result_time_s"), // semantics in SPEC §0.3
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.driverId] }),
    foreignKey({
      columns: [t.sessionId, t.driverId],
      foreignColumns: [sessionEntries.sessionId, sessionEntries.driverId],
      name: "results_session_entry_fk",
    }),
    index("results_session_position_idx").on(t.sessionId, t.position),
    index("results_driver_idx").on(t.driverId, t.sessionId),
  ],
);
