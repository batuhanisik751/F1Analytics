// SPEC §1.7: raw signals for later features (race sessions only; no v1 page reads them).
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";
import { sessions } from "./reference";

export const weatherSamples = pgTable(
  "weather_samples",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    sampleIdx: integer("sample_idx").notNull(),
    sessionTimeS: doublePrecision("session_time_s").notNull(),
    airTemp: real("air_temp"),
    humidity: real("humidity"),
    pressure: real("pressure"),
    rainfall: boolean("rainfall"),
    trackTemp: real("track_temp"),
    windDirection: integer("wind_direction"),
    windSpeed: real("wind_speed"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.sampleIdx] })],
);

export const trackStatusEvents = pgTable(
  "track_status_events",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    eventIdx: integer("event_idx").notNull(),
    sessionTimeS: doublePrecision("session_time_s").notNull(),
    status: text("status").notNull(),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.eventIdx] })],
);
