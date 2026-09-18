CREATE TABLE "assumption_sets" (
	"assumption_set_id" serial PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assumption_sets_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "circuits" (
	"circuit_key" integer PRIMARY KEY NOT NULL,
	"short_name" text NOT NULL,
	"location" text NOT NULL,
	"country" text NOT NULL,
	"lap_km" double precision
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"driver_id" text PRIMARY KEY NOT NULL,
	"latest_code" text NOT NULL,
	"latest_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"full_name" text NOT NULL,
	"country_code" text,
	"headshot_url" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"event_name" text NOT NULL,
	"official_name" text NOT NULL,
	"location" text NOT NULL,
	"country" text NOT NULL,
	"event_format" text NOT NULL,
	"event_date" date NOT NULL,
	"circuit_key" integer,
	CONSTRAINT "events_year_round_pk" PRIMARY KEY("year","round")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"year" integer PRIMARY KEY NOT NULL,
	"scheduled_rounds" integer NOT NULL,
	"ingested_rounds" integer DEFAULT 0 NOT NULL,
	"standings_after_round" integer,
	"assumption_set_id" integer,
	"mixed_assumption_sets" boolean DEFAULT false NOT NULL,
	"has_sprint_results" boolean DEFAULT false NOT NULL,
	"recomputed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" serial PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"start_utc" timestamp with time zone,
	"total_laps" integer,
	"winner_driver_id" text,
	"fastest_pace_driver_id" text,
	CONSTRAINT "sessions_year_round_kind_unique" UNIQUE("year","round","kind"),
	CONSTRAINT "sessions_kind_check" CHECK (kind IN ('R','S'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"team_id" text PRIMARY KEY NOT NULL,
	"latest_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compound_colours" (
	"session_id" integer NOT NULL,
	"compound" text NOT NULL,
	"colour" text NOT NULL,
	CONSTRAINT "compound_colours_session_id_compound_pk" PRIMARY KEY("session_id","compound")
);
--> statement-breakpoint
CREATE TABLE "results" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"position" integer,
	"classified_position" text NOT NULL,
	"grid_position" integer,
	"points" double precision DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"laps_completed" integer,
	"result_time_s" double precision,
	CONSTRAINT "results_session_id_driver_id_pk" PRIMARY KEY("session_id","driver_id")
);
--> statement-breakpoint
CREATE TABLE "session_entries" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"code" text NOT NULL,
	"driver_number" text NOT NULL,
	"line_style" text NOT NULL,
	"line_style_source" text NOT NULL,
	CONSTRAINT "session_entries_session_id_driver_id_pk" PRIMARY KEY("session_id","driver_id"),
	CONSTRAINT "session_entries_session_id_code_unique" UNIQUE("session_id","code"),
	CONSTRAINT "session_entries_session_id_driver_number_unique" UNIQUE("session_id","driver_number"),
	CONSTRAINT "session_entries_line_style_check" CHECK (line_style IN ('solid','dashed','dotted')),
	CONSTRAINT "session_entries_line_style_source_check" CHECK (line_style_source IN ('fastf1','fallback'))
);
--> statement-breakpoint
CREATE TABLE "session_teams" (
	"session_id" integer NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"colour" text NOT NULL,
	"colour_source" text NOT NULL,
	CONSTRAINT "session_teams_session_id_team_id_pk" PRIMARY KEY("session_id","team_id"),
	CONSTRAINT "session_teams_session_id_team_name_unique" UNIQUE("session_id","team_name"),
	CONSTRAINT "session_teams_colour_source_check" CHECK (colour_source IN ('fastf1','results','fallback'))
);
--> statement-breakpoint
CREATE TABLE "lap_status" (
	"session_id" integer NOT NULL,
	"lap_number" integer NOT NULL,
	"is_green" boolean NOT NULL,
	"worst_status" text NOT NULL,
	"drivers_affected" integer NOT NULL,
	"drivers_on_lap" integer NOT NULL,
	CONSTRAINT "lap_status_session_id_lap_number_pk" PRIMARY KEY("session_id","lap_number")
);
--> statement-breakpoint
CREATE TABLE "laps" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"lap_number" integer NOT NULL,
	"stint" integer,
	"compound" text,
	"tyre_life" integer,
	"fresh_tyre" boolean,
	"position" integer,
	"track_status" text,
	"lap_time_s" double precision,
	"session_time_s" double precision,
	"lap_start_time_s" double precision,
	"sector1_s" double precision,
	"sector2_s" double precision,
	"sector3_s" double precision,
	"speed_i1" real,
	"speed_i2" real,
	"speed_fl" real,
	"speed_st" real,
	"pit_in_time_s" double precision,
	"pit_out_time_s" double precision,
	"is_accurate" boolean NOT NULL,
	"deleted" boolean NOT NULL,
	"deleted_reason" text,
	"fastf1_generated" boolean NOT NULL,
	"is_personal_best" boolean NOT NULL,
	"excl_no_time" boolean NOT NULL,
	"excl_in_lap" boolean NOT NULL,
	"excl_out_lap" boolean NOT NULL,
	"excl_not_green" boolean NOT NULL,
	"excl_inaccurate" boolean NOT NULL,
	"excl_deleted" boolean NOT NULL,
	"passes_rules" boolean NOT NULL,
	"is_outlier" boolean NOT NULL,
	"is_representative" boolean NOT NULL,
	"fuel_kg" double precision,
	"fuel_penalty_s" double precision,
	"lap_time_fc_s" double precision,
	"gap_to_leader_s" double precision,
	"interval_s" double precision,
	"leader_driver_id" text,
	CONSTRAINT "laps_session_id_driver_id_lap_number_pk" PRIMARY KEY("session_id","driver_id","lap_number")
);
--> statement-breakpoint
CREATE TABLE "pit_stops" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"stop_number" integer NOT NULL,
	"lap_in" integer NOT NULL,
	"lap_out" integer,
	"pit_in_time_s" double precision NOT NULL,
	"pit_out_time_s" double precision,
	"pit_lane_s" double precision,
	"compound_in" text,
	"compound_out" text,
	CONSTRAINT "pit_stops_session_id_driver_id_stop_number_pk" PRIMARY KEY("session_id","driver_id","stop_number")
);
--> statement-breakpoint
CREATE TABLE "stints" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"stint" integer NOT NULL,
	"compound" text NOT NULL,
	"start_lap" integer NOT NULL,
	"end_lap" integer NOT NULL,
	"laps" integer NOT NULL,
	CONSTRAINT "stints_session_id_driver_id_stint_compound_pk" PRIMARY KEY("session_id","driver_id","stint","compound")
);
--> statement-breakpoint
CREATE TABLE "compound_degradation" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"compound" text NOT NULL,
	"laps" integer NOT NULL,
	"slope_s_per_lap" double precision NOT NULL,
	"intercept_s" double precision NOT NULL,
	"x_min" integer NOT NULL,
	"x_max" integer NOT NULL,
	CONSTRAINT "compound_degradation_session_id_compound_pk" PRIMARY KEY("session_id","compound")
);
--> statement-breakpoint
CREATE TABLE "degradation_fits" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"stint" integer NOT NULL,
	"team_id" text NOT NULL,
	"compound" text NOT NULL,
	"laps" integer NOT NULL,
	"deg_s_per_lap" double precision NOT NULL,
	"deg_std_err" double precision NOT NULL,
	"r2" double precision NOT NULL,
	"fresh_pace_s" double precision NOT NULL,
	CONSTRAINT "degradation_fits_session_id_driver_id_stint_pk" PRIMARY KEY("session_id","driver_id","stint")
);
--> statement-breakpoint
CREATE TABLE "fuel_sensitivity" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"fuel_effect_s_per_kg" double precision NOT NULL,
	"rank" integer NOT NULL,
	"gap_s" double precision NOT NULL,
	CONSTRAINT "fuel_sensitivity_session_id_driver_id_fuel_effect_s_per_kg_pk" PRIMARY KEY("session_id","driver_id","fuel_effect_s_per_kg")
);
--> statement-breakpoint
CREATE TABLE "lap_exclusion_report" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"rule_order" integer NOT NULL,
	"rule" text NOT NULL,
	"laps_hit" integer NOT NULL,
	"pct_of_all" double precision NOT NULL,
	CONSTRAINT "lap_exclusion_report_session_id_rule_pk" PRIMARY KEY("session_id","rule")
);
--> statement-breakpoint
CREATE TABLE "pace_ranking" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"rank" integer NOT NULL,
	"team_id" text NOT NULL,
	"clean_laps" integer NOT NULL,
	"median_pace_s" double precision NOT NULL,
	"best_pace_s" double precision NOT NULL,
	"iqr_s" double precision NOT NULL,
	"gap_s" double precision NOT NULL,
	"gap_pct" double precision NOT NULL,
	"box_whisker_lo_s" double precision NOT NULL,
	"box_q1_s" double precision NOT NULL,
	"box_q3_s" double precision NOT NULL,
	"box_whisker_hi_s" double precision NOT NULL,
	"box_mean_s" double precision NOT NULL,
	"sens_rank_lo" integer,
	"sens_rank_hi" integer,
	CONSTRAINT "pace_ranking_session_id_driver_id_pk" PRIMARY KEY("session_id","driver_id"),
	CONSTRAINT "pace_ranking_session_id_rank_unique" UNIQUE("session_id","rank")
);
--> statement-breakpoint
CREATE TABLE "teammate_deltas" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"team_id" text NOT NULL,
	"faster_driver_id" text NOT NULL,
	"slower_driver_id" text NOT NULL,
	"gap_s" double precision NOT NULL,
	"gap_pct" double precision NOT NULL,
	"laps_compared" integer NOT NULL,
	CONSTRAINT "teammate_deltas_session_id_team_id_pk" PRIMARY KEY("session_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "track_status_events" (
	"session_id" integer NOT NULL,
	"event_idx" integer NOT NULL,
	"session_time_s" double precision NOT NULL,
	"status" text NOT NULL,
	"message" text,
	CONSTRAINT "track_status_events_session_id_event_idx_pk" PRIMARY KEY("session_id","event_idx")
);
--> statement-breakpoint
CREATE TABLE "weather_samples" (
	"session_id" integer NOT NULL,
	"sample_idx" integer NOT NULL,
	"session_time_s" double precision NOT NULL,
	"air_temp" real,
	"humidity" real,
	"pressure" real,
	"rainfall" boolean,
	"track_temp" real,
	"wind_direction" integer,
	"wind_speed" real,
	CONSTRAINT "weather_samples_session_id_sample_idx_pk" PRIMARY KEY("session_id","sample_idx")
);
--> statement-breakpoint
CREATE TABLE "constructor_standings" (
	"year" integer NOT NULL,
	"after_round" integer NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_colour" text NOT NULL,
	"position" integer NOT NULL,
	"points" double precision NOT NULL,
	"wins" integer NOT NULL,
	"podiums" integer NOT NULL,
	CONSTRAINT "constructor_standings_year_after_round_team_id_pk" PRIMARY KEY("year","after_round","team_id")
);
--> statement-breakpoint
CREATE TABLE "driver_season_summary" (
	"year" integer NOT NULL,
	"driver_id" text NOT NULL,
	"assumption_set_id" integer,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_colour" text NOT NULL,
	"races" integer NOT NULL,
	"points" double precision NOT NULL,
	"wins" integer NOT NULL,
	"podiums" integer NOT NULL,
	"dnfs" integer NOT NULL,
	"championship_position" integer,
	"best_finish" integer,
	"avg_finish" double precision,
	"avg_grid" double precision,
	"mean_pace_rank" double precision,
	"races_ranked" integer NOT NULL,
	CONSTRAINT "driver_season_summary_year_driver_id_pk" PRIMARY KEY("year","driver_id")
);
--> statement-breakpoint
CREATE TABLE "driver_standings" (
	"year" integer NOT NULL,
	"after_round" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_colour" text NOT NULL,
	"position" integer NOT NULL,
	"points" double precision NOT NULL,
	"sprint_points" double precision NOT NULL,
	"wins" integer NOT NULL,
	"podiums" integer NOT NULL,
	"races" integer NOT NULL,
	CONSTRAINT "driver_standings_year_after_round_driver_id_pk" PRIMARY KEY("year","after_round","driver_id")
);
--> statement-breakpoint
CREATE TABLE "teammate_h2h" (
	"year" integer NOT NULL,
	"driver_id" text NOT NULL,
	"teammate_driver_id" text NOT NULL,
	"assumption_set_id" integer,
	"team_id" text NOT NULL,
	"races_paired" integer NOT NULL,
	"pace_wins" integer NOT NULL,
	"pace_losses" integer NOT NULL,
	"mean_signed_gap_pct" double precision,
	"median_signed_gap_pct" double precision,
	"finish_wins" integer NOT NULL,
	"finish_losses" integer NOT NULL,
	"grid_wins" integer NOT NULL,
	"grid_losses" integer NOT NULL,
	"points_for" double precision NOT NULL,
	"points_against" double precision NOT NULL,
	CONSTRAINT "teammate_h2h_year_driver_id_teammate_driver_id_pk" PRIMARY KEY("year","driver_id","teammate_driver_id")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"run_id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"cli_args" jsonb NOT NULL,
	"f1lab_version" text NOT NULL,
	"fastf1_version" text NOT NULL,
	"python_version" text NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"hostname" text,
	"sessions_attempted" integer DEFAULT 0 NOT NULL,
	"sessions_ok" integer DEFAULT 0 NOT NULL,
	"sessions_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "ingest_runs_status_check" CHECK (status IN ('running','ok','partial','failed','aborted'))
);
--> statement-breakpoint
CREATE TABLE "session_ingests" (
	"session_id" integer PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"analytics_status" jsonb NOT NULL,
	"warnings" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"raw_laps" integer DEFAULT 0 NOT NULL,
	"clean_laps" integer DEFAULT 0 NOT NULL,
	"total_laps" integer,
	"assumption_set_id" integer NOT NULL,
	"lap_km_used" double precision,
	"fuel_scale" double precision DEFAULT 1 NOT NULL,
	"f1lab_version" text NOT NULL,
	"fastf1_version" text NOT NULL,
	CONSTRAINT "session_ingests_status_check" CHECK (status IN ('ok','partial','failed'))
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_year_seasons_year_fk" FOREIGN KEY ("year") REFERENCES "public"."seasons"("year") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_circuit_key_circuits_circuit_key_fk" FOREIGN KEY ("circuit_key") REFERENCES "public"."circuits"("circuit_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_winner_driver_id_drivers_driver_id_fk" FOREIGN KEY ("winner_driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_fastest_pace_driver_id_drivers_driver_id_fk" FOREIGN KEY ("fastest_pace_driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_year_round_events_fk" FOREIGN KEY ("year","round") REFERENCES "public"."events"("year","round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compound_colours" ADD CONSTRAINT "compound_colours_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_session_team_fk" FOREIGN KEY ("session_id","team_id") REFERENCES "public"."session_teams"("session_id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_teams" ADD CONSTRAINT "session_teams_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_teams" ADD CONSTRAINT "session_teams_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_status" ADD CONSTRAINT "lap_status_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laps" ADD CONSTRAINT "laps_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laps" ADD CONSTRAINT "laps_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_stops" ADD CONSTRAINT "pit_stops_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_stops" ADD CONSTRAINT "pit_stops_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stints" ADD CONSTRAINT "stints_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stints" ADD CONSTRAINT "stints_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compound_degradation" ADD CONSTRAINT "compound_degradation_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compound_degradation" ADD CONSTRAINT "compound_degradation_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "degradation_fits" ADD CONSTRAINT "degradation_fits_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "degradation_fits" ADD CONSTRAINT "degradation_fits_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "degradation_fits" ADD CONSTRAINT "degradation_fits_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_sensitivity" ADD CONSTRAINT "fuel_sensitivity_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_sensitivity" ADD CONSTRAINT "fuel_sensitivity_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_exclusion_report" ADD CONSTRAINT "lap_exclusion_report_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_exclusion_report" ADD CONSTRAINT "lap_exclusion_report_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pace_ranking" ADD CONSTRAINT "pace_ranking_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pace_ranking" ADD CONSTRAINT "pace_ranking_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pace_ranking" ADD CONSTRAINT "pace_ranking_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_deltas" ADD CONSTRAINT "teammate_deltas_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_deltas" ADD CONSTRAINT "teammate_deltas_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_status_events" ADD CONSTRAINT "track_status_events_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_samples" ADD CONSTRAINT "weather_samples_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "constructor_standings" ADD CONSTRAINT "constructor_standings_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "constructor_standings" ADD CONSTRAINT "constructor_standings_year_after_round_events_fk" FOREIGN KEY ("year","after_round") REFERENCES "public"."events"("year","round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_season_summary" ADD CONSTRAINT "driver_season_summary_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_season_summary" ADD CONSTRAINT "driver_season_summary_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_standings" ADD CONSTRAINT "driver_standings_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_standings" ADD CONSTRAINT "driver_standings_year_after_round_events_fk" FOREIGN KEY ("year","after_round") REFERENCES "public"."events"("year","round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_h2h" ADD CONSTRAINT "teammate_h2h_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_h2h" ADD CONSTRAINT "teammate_h2h_teammate_driver_id_drivers_driver_id_fk" FOREIGN KEY ("teammate_driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_h2h" ADD CONSTRAINT "teammate_h2h_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ingests" ADD CONSTRAINT "session_ingests_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ingests" ADD CONSTRAINT "session_ingests_run_id_ingest_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingest_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ingests" ADD CONSTRAINT "session_ingests_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drivers_latest_code_idx" ON "drivers" USING btree ("latest_code");--> statement-breakpoint
CREATE INDEX "sessions_year_round_idx" ON "sessions" USING btree ("year","round");--> statement-breakpoint
CREATE INDEX "results_session_position_idx" ON "results" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "results_driver_idx" ON "results" USING btree ("driver_id","session_id");--> statement-breakpoint
CREATE INDEX "laps_session_lap_idx" ON "laps" USING btree ("session_id","lap_number");--> statement-breakpoint
CREATE INDEX "laps_session_repr_idx" ON "laps" USING btree ("session_id","compound","tyre_life") WHERE is_representative;--> statement-breakpoint
CREATE INDEX "laps_driver_idx" ON "laps" USING btree ("driver_id","session_id");--> statement-breakpoint
CREATE INDEX "degradation_fits_compound_idx" ON "degradation_fits" USING btree ("compound","session_id");--> statement-breakpoint
CREATE INDEX "pace_ranking_driver_idx" ON "pace_ranking" USING btree ("driver_id","session_id");--> statement-breakpoint
CREATE INDEX "teammate_deltas_faster_idx" ON "teammate_deltas" USING btree ("faster_driver_id","session_id");--> statement-breakpoint
CREATE INDEX "teammate_deltas_slower_idx" ON "teammate_deltas" USING btree ("slower_driver_id","session_id");