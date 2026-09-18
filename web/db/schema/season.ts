// SPEC §1.8: season aggregates (f1lab.season.recompute rewrites all rows for a year).
import {
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { assumptionSets, drivers, events, teams } from "./reference";

export const driverStandings = pgTable(
  "driver_standings",
  {
    year: integer("year").notNull(),
    afterRound: integer("after_round").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    teamColour: text("team_colour").notNull(),
    position: integer("position").notNull(),
    points: doublePrecision("points").notNull(),
    sprintPoints: doublePrecision("sprint_points").notNull(),
    wins: integer("wins").notNull(),
    podiums: integer("podiums").notNull(),
    races: integer("races").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.afterRound, t.driverId] }),
    foreignKey({
      columns: [t.year, t.afterRound],
      foreignColumns: [events.year, events.round],
      name: "driver_standings_year_after_round_events_fk",
    }),
  ],
);

export const constructorStandings = pgTable(
  "constructor_standings",
  {
    year: integer("year").notNull(),
    afterRound: integer("after_round").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.teamId),
    teamName: text("team_name").notNull(),
    teamColour: text("team_colour").notNull(),
    position: integer("position").notNull(),
    points: doublePrecision("points").notNull(),
    wins: integer("wins").notNull(),
    podiums: integer("podiums").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.year, t.afterRound, t.teamId] }),
    foreignKey({
      columns: [t.year, t.afterRound],
      foreignColumns: [events.year, events.round],
      name: "constructor_standings_year_after_round_events_fk",
    }),
  ],
);

// Driver page tiles. One row per (year, driver) with at least one race entry.
export const driverSeasonSummary = pgTable(
  "driver_season_summary",
  {
    year: integer("year").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    assumptionSetId: integer("assumption_set_id").references(
      () => assumptionSets.assumptionSetId,
    ),
    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    teamColour: text("team_colour").notNull(),
    races: integer("races").notNull(),
    points: doublePrecision("points").notNull(),
    wins: integer("wins").notNull(),
    podiums: integer("podiums").notNull(),
    dnfs: integer("dnfs").notNull(),
    championshipPosition: integer("championship_position"),
    bestFinish: integer("best_finish"),
    avgFinish: doublePrecision("avg_finish"),
    avgGrid: doublePrecision("avg_grid"),
    meanPaceRank: doublePrecision("mean_pace_rank"),
    racesRanked: integer("races_ranked").notNull(),
  },
  (t) => [primaryKey({ columns: [t.year, t.driverId] })],
);

// Driver page H2H cards: one row per (driver, teammate) in a season, BOTH directions stored.
export const teammateH2h = pgTable(
  "teammate_h2h",
  {
    year: integer("year").notNull(),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.driverId),
    teammateDriverId: text("teammate_driver_id")
      .notNull()
      .references(() => drivers.driverId),
    assumptionSetId: integer("assumption_set_id").references(
      () => assumptionSets.assumptionSetId,
    ),
    teamId: text("team_id").notNull(),
    racesPaired: integer("races_paired").notNull(),
    paceWins: integer("pace_wins").notNull(),
    paceLosses: integer("pace_losses").notNull(),
    meanSignedGapPct: doublePrecision("mean_signed_gap_pct"),
    medianSignedGapPct: doublePrecision("median_signed_gap_pct"),
    finishWins: integer("finish_wins").notNull(),
    finishLosses: integer("finish_losses").notNull(),
    gridWins: integer("grid_wins").notNull(),
    gridLosses: integer("grid_losses").notNull(),
    pointsFor: doublePrecision("points_for").notNull(),
    pointsAgainst: doublePrecision("points_against").notNull(),
  },
  (t) => [primaryKey({ columns: [t.year, t.driverId, t.teammateDriverId] })],
);
