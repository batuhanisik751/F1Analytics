CREATE TABLE "circuit_odi" (
	"circuit_key" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"races" integer NOT NULL,
	"passes" integer NOT NULL,
	"opportunities" integer NOT NULL,
	"raw_pass_rate" double precision NOT NULL,
	"resid_mean" double precision NOT NULL,
	"resid_shrunk" double precision NOT NULL,
	"adj_pass_rate" double precision NOT NULL,
	"odi" double precision NOT NULL,
	"odi_lo" double precision NOT NULL,
	"odi_hi" double precision NOT NULL,
	CONSTRAINT "circuit_odi_circuit_key_pk" PRIMARY KEY("circuit_key"),
	CONSTRAINT "circuit_odi_range" CHECK ("circuit_odi"."odi" >= 0 AND "circuit_odi"."odi" <= 100)
);
--> statement-breakpoint
CREATE TABLE "optimal_stint" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"compound" text NOT NULL,
	"n_fits" integer NOT NULL,
	"slope_s_per_lap" double precision NOT NULL,
	"slope_q1" double precision NOT NULL,
	"slope_q3" double precision NOT NULL,
	"pit_loss_s" double precision NOT NULL,
	"pit_loss_source" text NOT NULL,
	"optimal_laps" double precision NOT NULL,
	"optimal_laps_lo" double precision NOT NULL,
	"optimal_laps_hi" double precision NOT NULL,
	"actual_median_laps" double precision,
	"slope_source" text NOT NULL,
	CONSTRAINT "optimal_stint_session_id_compound_pk" PRIMARY KEY("session_id","compound"),
	CONSTRAINT "optimal_stint_pit_src" CHECK ("optimal_stint"."pit_loss_source" IN ('circuit','pooled')),
	CONSTRAINT "optimal_stint_slope_src" CHECK ("optimal_stint"."slope_source" IN ('session','pooled'))
);
--> statement-breakpoint
CREATE TABLE "preview_backtest" (
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"pred_kind" text DEFAULT 'oof' NOT NULL,
	"expected_position" double precision NOT NULL,
	"pos_p10" integer NOT NULL,
	"pos_p90" integer NOT NULL,
	"actual_position" integer,
	"inside_interval" boolean NOT NULL,
	CONSTRAINT "preview_backtest_year_round_driver_id_pk" PRIMARY KEY("year","round","driver_id"),
	CONSTRAINT "preview_backtest_oof_only" CHECK ("preview_backtest"."pred_kind" = 'oof')
);
--> statement-breakpoint
CREATE TABLE "preview_finish_order" (
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"expected_position" double precision NOT NULL,
	"pos_p10" integer NOT NULL,
	"pos_p90" integer NOT NULL,
	"p_win" double precision NOT NULL,
	"p_podium" double precision NOT NULL,
	"p_points" double precision NOT NULL,
	"theta" double precision NOT NULL,
	"dnf_rate" double precision NOT NULL,
	"draws" integer NOT NULL,
	CONSTRAINT "preview_finish_order_year_round_driver_id_pk" PRIMARY KEY("year","round","driver_id")
);
--> statement-breakpoint
CREATE TABLE "preview_round" (
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"circuit_key" integer,
	"circuit_match" text NOT NULL,
	"circuit_races" integer DEFAULT 0 NOT NULL,
	"expected_total_laps" integer,
	"p_safety_car" double precision,
	"sc_hazard_shrunk" double precision,
	"p_vsc" double precision,
	"expected_pit_loss_s" double precision,
	"pit_loss_band_s" double precision,
	"odi" double precision,
	"odi_lo" double precision,
	"odi_hi" double precision,
	"backtest_spearman" double precision,
	"backtest_grid_spearman" double precision,
	"backtest_coverage" double precision,
	"backtest_races" integer,
	"loco_brier" double precision,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_round_year_round_pk" PRIMARY KEY("year","round"),
	CONSTRAINT "preview_round_match" CHECK ("preview_round"."circuit_match" IN ('native','location','alias','none'))
);
--> statement-breakpoint
CREATE TABLE "race_moment" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"moment_idx" integer NOT NULL,
	"moment_type" text NOT NULL,
	"lap_number" integer NOT NULL,
	"driver_id" text NOT NULL,
	"other_driver_id" text,
	"magnitude" double precision NOT NULL,
	"magnitude_unit" text NOT NULL,
	"severity" double precision NOT NULL,
	"confidence" text NOT NULL,
	"detail" text NOT NULL,
	CONSTRAINT "race_moment_session_id_moment_idx_pk" PRIMARY KEY("session_id","moment_idx"),
	CONSTRAINT "race_moment_type" CHECK ("race_moment"."moment_type" IN ('pace_collapse','undercut_executed','tyre_cliff','damage_or_puncture','safety_car_luck')),
	CONSTRAINT "race_moment_conf" CHECK ("race_moment"."confidence" IN ('high','likely')),
	CONSTRAINT "race_moment_unit" CHECK ("race_moment"."magnitude_unit" IN ('s','places'))
);
--> statement-breakpoint
CREATE TABLE "title_clinch" (
	"year" integer NOT NULL,
	"after_round" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"points_now" integer NOT NULL,
	"max_available" integer NOT NULL,
	"max_possible_total" integer NOT NULL,
	"leader_points" integer NOT NULL,
	"is_eliminated" boolean NOT NULL,
	"eliminated_at_round" integer,
	"has_clinched" boolean DEFAULT false NOT NULL,
	"clinch_margin_needed" integer,
	"swing_needed" integer,
	"clinch_position" integer,
	"earliest_clinch_round" integer,
	"next_round_has_sprint" boolean DEFAULT false NOT NULL,
	"race_points_max" integer NOT NULL,
	"sprint_points_max" integer NOT NULL,
	"has_fastest_lap_bonus" boolean NOT NULL,
	CONSTRAINT "title_clinch_year_after_round_driver_id_pk" PRIMARY KEY("year","after_round","driver_id")
);
--> statement-breakpoint
CREATE TABLE "title_odds" (
	"year" integer NOT NULL,
	"after_round" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"p_title" double precision NOT NULL,
	"p_title_lo" double precision NOT NULL,
	"p_title_hi" double precision NOT NULL,
	"mc_stderr" double precision NOT NULL,
	"p_top3" double precision NOT NULL,
	"expected_points" double precision NOT NULL,
	"points_p10" double precision NOT NULL,
	"points_p90" double precision NOT NULL,
	"theta" double precision NOT NULL,
	"dnf_rate" double precision NOT NULL,
	"is_shrunk_to_prior" boolean DEFAULT false NOT NULL,
	"draws" integer NOT NULL,
	CONSTRAINT "title_odds_year_after_round_driver_id_pk" PRIMARY KEY("year","after_round","driver_id"),
	CONSTRAINT "title_odds_p_range" CHECK ("title_odds"."p_title" >= 0 AND "title_odds"."p_title" <= 1)
);
--> statement-breakpoint
CREATE TABLE "wp_lap_probability" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"lap_number" integer NOT NULL,
	"pred_kind" text DEFAULT 'oof' NOT NULL,
	"fold_index" integer NOT NULL,
	"p_win_raw" double precision NOT NULL,
	"p_win" double precision NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "wp_lap_probability_session_id_driver_id_lap_number_pk" PRIMARY KEY("session_id","driver_id","lap_number"),
	CONSTRAINT "wp_lap_probability_oof_only" CHECK ("wp_lap_probability"."pred_kind" = 'oof'),
	CONSTRAINT "wp_lap_probability_range" CHECK ("wp_lap_probability"."p_win" >= 0 AND "wp_lap_probability"."p_win" <= 1)
);
--> statement-breakpoint
CREATE TABLE "wp_metrics" (
	"assumption_set_id" integer NOT NULL,
	"scope" text NOT NULL,
	"variant" text NOT NULL,
	"n_rows" integer NOT NULL,
	"n_races" integer NOT NULL,
	"brier" double precision NOT NULL,
	"log_loss" double precision NOT NULL,
	"brier_baseline_pos" double precision NOT NULL,
	"brier_baseline_lead" double precision NOT NULL,
	"brier_fold_min" double precision,
	"brier_fold_median" double precision,
	"brier_fold_max" double precision,
	"note" text,
	CONSTRAINT "wp_metrics_assumption_set_id_scope_variant_pk" PRIMARY KEY("assumption_set_id","scope","variant"),
	CONSTRAINT "wp_metrics_scope" CHECK ("wp_metrics"."scope" <> ''),
	CONSTRAINT "wp_metrics_variant" CHECK ("wp_metrics"."variant" IN ('plain','isotonic'))
);
--> statement-breakpoint
CREATE TABLE "wp_model_artifact" (
	"assumption_set_id" integer NOT NULL,
	"fold_index" integer NOT NULL,
	"model_version" text NOT NULL,
	"sklearn_version" text NOT NULL,
	"feature_names" jsonb NOT NULL,
	"n_train_races" integer NOT NULL,
	"artifact_sha256" text NOT NULL,
	"artifact" "bytea" NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wp_model_artifact_assumption_set_id_fold_index_pk" PRIMARY KEY("assumption_set_id","fold_index")
);
--> statement-breakpoint
CREATE TABLE "wp_reliability_bin" (
	"assumption_set_id" integer NOT NULL,
	"scope" text NOT NULL,
	"variant" text NOT NULL,
	"bin_index" integer NOT NULL,
	"bin_lo" double precision NOT NULL,
	"bin_hi" double precision NOT NULL,
	"n_rows" integer NOT NULL,
	"n_wins" integer NOT NULL,
	"mean_predicted" double precision NOT NULL,
	"observed_rate" double precision NOT NULL,
	"observed_lo" double precision NOT NULL,
	"observed_hi" double precision NOT NULL,
	CONSTRAINT "wp_reliability_bin_assumption_set_id_scope_variant_bin_index_pk" PRIMARY KEY("assumption_set_id","scope","variant","bin_index")
);
--> statement-breakpoint
CREATE TABLE "wp_run" (
	"wp_run_id" serial PRIMARY KEY NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"model_version" text NOT NULL,
	"sklearn_version" text NOT NULL,
	"n_train_races" integer NOT NULL,
	"n_rows" integer NOT NULL,
	"n_folds" integer NOT NULL,
	"calibration" text NOT NULL,
	"tuning_scope" text DEFAULT 'oof' NOT NULL,
	"brier_oof" double precision NOT NULL,
	"brier_baseline_pos" double precision NOT NULL,
	"brier_baseline_lead" double precision NOT NULL,
	"skill_ok" boolean NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wp_run_model_version_uq" UNIQUE("assumption_set_id","model_version")
);
--> statement-breakpoint
CREATE TABLE "wp_swing" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"lap_number" integer NOT NULL,
	"swing_mass" double precision NOT NULL,
	"cause" text NOT NULL,
	"mover_driver_id" text NOT NULL,
	"mover_p_before" double precision NOT NULL,
	"mover_p_after" double precision NOT NULL,
	"rank_in_race" integer NOT NULL,
	CONSTRAINT "wp_swing_session_id_lap_number_pk" PRIMARY KEY("session_id","lap_number"),
	CONSTRAINT "wp_swing_cause" CHECK ("wp_swing"."cause" IN ('safety_car','vsc','red_flag','pit_cycle','retirement','on_track'))
);
--> statement-breakpoint
ALTER TABLE "circuit_odi" ADD CONSTRAINT "circuit_odi_circuit_key_circuits_circuit_key_fk" FOREIGN KEY ("circuit_key") REFERENCES "public"."circuits"("circuit_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_odi" ADD CONSTRAINT "circuit_odi_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimal_stint" ADD CONSTRAINT "optimal_stint_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimal_stint" ADD CONSTRAINT "optimal_stint_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_backtest" ADD CONSTRAINT "preview_backtest_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_backtest" ADD CONSTRAINT "preview_backtest_events_fk" FOREIGN KEY ("year","round") REFERENCES "public"."events"("year","round") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_finish_order" ADD CONSTRAINT "preview_finish_order_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_finish_order" ADD CONSTRAINT "preview_finish_order_events_fk" FOREIGN KEY ("year","round") REFERENCES "public"."events"("year","round") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_round" ADD CONSTRAINT "preview_round_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_round" ADD CONSTRAINT "preview_round_circuit_key_circuits_circuit_key_fk" FOREIGN KEY ("circuit_key") REFERENCES "public"."circuits"("circuit_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_round" ADD CONSTRAINT "preview_round_events_fk" FOREIGN KEY ("year","round") REFERENCES "public"."events"("year","round") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_moment" ADD CONSTRAINT "race_moment_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_moment" ADD CONSTRAINT "race_moment_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_clinch" ADD CONSTRAINT "title_clinch_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_odds" ADD CONSTRAINT "title_odds_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_lap_probability" ADD CONSTRAINT "wp_lap_probability_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_lap_probability" ADD CONSTRAINT "wp_lap_probability_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_metrics" ADD CONSTRAINT "wp_metrics_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_model_artifact" ADD CONSTRAINT "wp_model_artifact_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_reliability_bin" ADD CONSTRAINT "wp_reliability_bin_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_run" ADD CONSTRAINT "wp_run_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_swing" ADD CONSTRAINT "wp_swing_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_swing" ADD CONSTRAINT "wp_swing_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "race_moment_lap_idx" ON "race_moment" USING btree ("session_id","lap_number");--> statement-breakpoint
CREATE INDEX "wp_lap_probability_lap_idx" ON "wp_lap_probability" USING btree ("session_id","lap_number");--> statement-breakpoint
CREATE UNIQUE INDEX "wp_run_one_current" ON "wp_run" USING btree ("assumption_set_id") WHERE is_current;