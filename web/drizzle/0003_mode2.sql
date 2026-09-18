CREATE TABLE "mode2_car_hazard" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"team_id" text NOT NULL,
	"year" integer NOT NULL,
	"retirements" integer NOT NULL,
	"racing_laps" integer NOT NULL,
	"hazard_per_1000" double precision NOT NULL,
	"hazard_lo" double precision NOT NULL,
	"hazard_hi" double precision NOT NULL,
	"hazard_car_only" double precision NOT NULL,
	"hazard_car_lo" double precision NOT NULL,
	"hazard_car_hi" double precision NOT NULL,
	"rank_in_season" integer NOT NULL,
	"sufficient" boolean NOT NULL,
	CONSTRAINT "mode2_car_hazard_fit_id_team_id_year_pk" PRIMARY KEY("fit_id","team_id","year")
);
--> statement-breakpoint
CREATE TABLE "mode2_car_rating" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"team_id" text NOT NULL,
	"year" integer NOT NULL,
	"gamma_pp" double precision NOT NULL,
	"gamma_lo" double precision NOT NULL,
	"gamma_hi" double precision NOT NULL,
	"slope_pp" double precision NOT NULL,
	"slope_lo" double precision NOT NULL,
	"slope_hi" double precision NOT NULL,
	"start_pp" double precision NOT NULL,
	"end_pp" double precision NOT NULL,
	"slope_significant" boolean NOT NULL,
	"rank_in_season" integer NOT NULL,
	"component_id" text NOT NULL,
	"basis" text NOT NULL,
	"n_races" integer NOT NULL,
	CONSTRAINT "mode2_car_rating_fit_id_team_id_year_pk" PRIMARY KEY("fit_id","team_id","year")
);
--> statement-breakpoint
CREATE TABLE "mode2_career_season" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"year" integer NOT NULL,
	"team_id" text NOT NULL,
	"actual_points" double precision NOT NULL,
	"replay_points" double precision NOT NULL,
	"replay_lo" double precision NOT NULL,
	"replay_hi" double precision NOT NULL,
	"avg_driver_points" double precision NOT NULL,
	"avg_driver_p10" double precision NOT NULL,
	"avg_driver_p90" double precision NOT NULL,
	"contribution" double precision NOT NULL,
	"contribution_lo" double precision NOT NULL,
	"contribution_hi" double precision NOT NULL,
	"mc_stderr" double precision NOT NULL,
	"param_stderr" double precision NOT NULL,
	"calibration_mae" double precision NOT NULL,
	"basis" text NOT NULL,
	"anchor_class" text NOT NULL,
	"rounds_in_season" integer NOT NULL,
	CONSTRAINT "mode2_career_season_fit_id_driver_id_year_pk" PRIMARY KEY("fit_id","driver_id","year"),
	CONSTRAINT "mode2_career_season_basis_check" CHECK ("mode2_career_season"."basis" IN ('measured','by-analogy'))
);
--> statement-breakpoint
CREATE TABLE "mode2_component" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"component_id" text NOT NULL,
	"label" text NOT NULL,
	"n_drivers" integer NOT NULL,
	"n_cells" integer NOT NULL,
	"is_floating" boolean NOT NULL,
	"driver_ids" text[] NOT NULL,
	"cell_ids" text[] NOT NULL,
	CONSTRAINT "mode2_component_fit_id_component_id_pk" PRIMARY KEY("fit_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "mode2_counterfactual" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"year" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"replaced_driver_id" text NOT NULL,
	"observed" boolean NOT NULL,
	"points_p10" double precision NOT NULL,
	"points_p50" double precision NOT NULL,
	"points_p90" double precision NOT NULL,
	"incumbent_actual" double precision NOT NULL,
	"delta_p10" double precision NOT NULL,
	"delta_p50" double precision NOT NULL,
	"delta_p90" double precision NOT NULL,
	"basis" text NOT NULL,
	"cross_component" boolean NOT NULL,
	"interaction_pp" double precision NOT NULL,
	"calibration_mae" double precision NOT NULL,
	CONSTRAINT "mode2_counterfactual_fit_id_year_team_id_driver_id_pk" PRIMARY KEY("fit_id","year","team_id","driver_id"),
	CONSTRAINT "mode2_counterfactual_interval_check" CHECK ("mode2_counterfactual"."points_p10" IS NOT NULL AND "mode2_counterfactual"."points_p90" IS NOT NULL AND "mode2_counterfactual"."points_p10" <= "mode2_counterfactual"."points_p90"),
	CONSTRAINT "mode2_counterfactual_basis_check" CHECK ("mode2_counterfactual"."basis" IN ('measured','by-analogy'))
);
--> statement-breakpoint
CREATE TABLE "mode2_driver_contrast" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_a" text NOT NULL,
	"driver_b" text NOT NULL,
	"kind" text NOT NULL,
	"delta_pp" double precision NOT NULL,
	"delta_se" double precision NOT NULL,
	"delta_lo" double precision NOT NULL,
	"delta_hi" double precision NOT NULL,
	"same_component" boolean NOT NULL,
	"shared_cells" text[] NOT NULL,
	"n_shared_races" integer NOT NULL,
	"n_races_a" integer NOT NULL,
	"n_races_b" integer NOT NULL,
	CONSTRAINT "mode2_driver_contrast_fit_id_driver_a_driver_b_pk" PRIMARY KEY("fit_id","driver_a","driver_b"),
	CONSTRAINT "mode2_driver_contrast_kind_check" CHECK ("mode2_driver_contrast"."kind" IN ('teammate','cross'))
);
--> statement-breakpoint
CREATE TABLE "mode2_driver_rating" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"rating_pp" double precision NOT NULL,
	"rating_lo" double precision NOT NULL,
	"rating_hi" double precision NOT NULL,
	"sd_within" double precision NOT NULL,
	"sd_island" double precision NOT NULL,
	"sd_total" double precision NOT NULL,
	"frac_floating" double precision NOT NULL,
	"evidence_share" double precision NOT NULL,
	"anchor_class" text NOT NULL,
	"basis" text NOT NULL,
	"component_id" text NOT NULL,
	"rank_in_component" integer NOT NULL,
	"n_races" integer NOT NULL,
	"n_cells" integer NOT NULL,
	"n_races_excluded" integer NOT NULL,
	CONSTRAINT "mode2_driver_rating_fit_id_driver_id_pk" PRIMARY KEY("fit_id","driver_id"),
	CONSTRAINT "mode2_driver_rating_anchor_check" CHECK ("mode2_driver_rating"."anchor_class" IN ('anchored','component-anchored','floating')),
	CONSTRAINT "mode2_driver_rating_basis_check" CHECK ("mode2_driver_rating"."basis" IN ('measured','by-analogy'))
);
--> statement-breakpoint
CREATE TABLE "mode2_driver_rating_history" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"through_year" integer NOT NULL,
	"rating_pp" double precision NOT NULL,
	"rating_lo" double precision NOT NULL,
	"rating_hi" double precision NOT NULL,
	"sd_total" double precision NOT NULL,
	"anchor_class" text NOT NULL,
	"n_races_cumulative" integer NOT NULL,
	"switched_this_year" boolean NOT NULL,
	CONSTRAINT "mode2_driver_rating_history_fit_id_driver_id_through_year_pk" PRIMARY KEY("fit_id","driver_id","through_year")
);
--> statement-breakpoint
CREATE TABLE "mode2_driver_skill" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"skill" text NOT NULL,
	"measured" boolean NOT NULL,
	"value" double precision,
	"value_lo" double precision,
	"value_hi" double precision,
	"unit" text NOT NULL,
	"evidence_share" double precision,
	"anchor_class" text NOT NULL,
	"pct_field_below" double precision,
	"not_measured_reason" text,
	"n_obs" integer NOT NULL,
	CONSTRAINT "mode2_driver_skill_fit_id_driver_id_skill_pk" PRIMARY KEY("fit_id","driver_id","skill"),
	CONSTRAINT "mode2_driver_skill_measured_check" CHECK (("mode2_driver_skill"."measured" AND "mode2_driver_skill"."value" IS NOT NULL AND "mode2_driver_skill"."value_lo" IS NOT NULL AND "mode2_driver_skill"."value_hi" IS NOT NULL
      AND "mode2_driver_skill"."not_measured_reason" IS NULL)
 OR (NOT "mode2_driver_skill"."measured" AND "mode2_driver_skill"."value" IS NULL AND "mode2_driver_skill"."not_measured_reason" IS NOT NULL)),
	CONSTRAINT "mode2_driver_skill_skill_check" CHECK ("mode2_driver_skill"."skill" IN ('race_pace','grid_pace','tyre_management','wet'))
);
--> statement-breakpoint
CREATE TABLE "mode2_fit_run" (
	"fit_id" serial PRIMARY KEY NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"model_version" text NOT NULL,
	"spec" text NOT NULL,
	"n_rows" integer NOT NULL,
	"n_rows_excluded" integer NOT NULL,
	"n_drivers" integer NOT NULL,
	"n_cells" integer NOT NULL,
	"n_sessions" integer NOT NULL,
	"n_components" integer NOT NULL,
	"tau_driver" double precision NOT NULL,
	"tau_car" double precision NOT NULL,
	"tau_slope" double precision NOT NULL,
	"sigma_resid" double precision NOT NULL,
	"tau_driver_lo" double precision NOT NULL,
	"tau_driver_hi" double precision NOT NULL,
	"tau_car_lo" double precision NOT NULL,
	"tau_car_hi" double precision NOT NULL,
	"sd_ratio" double precision NOT NULL,
	"sd_ratio_lo" double precision NOT NULL,
	"sd_ratio_hi" double precision NOT NULL,
	"tau_interaction" double precision NOT NULL,
	"sigma_spec" double precision NOT NULL,
	"ci_level" double precision NOT NULL,
	"bootstrap_reps" integer NOT NULL,
	"converged" boolean NOT NULL,
	"shrinkage_ok" boolean NOT NULL,
	"interval_dir_ok" boolean NOT NULL,
	"fit_seconds" double precision NOT NULL,
	"bootstrap_seconds" double precision NOT NULL,
	"is_current" boolean NOT NULL,
	"fitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mode2_points_calib" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"year" integer NOT NULL,
	"slope_theta_per_pp" double precision NOT NULL,
	"intercept" double precision NOT NULL,
	"r2" double precision NOT NULL,
	"resid_sd" double precision NOT NULL,
	"temperature" double precision NOT NULL,
	"sd_ratio_sim_actual" double precision NOT NULL,
	"replay_mae_points" double precision NOT NULL,
	"replay_corr" double precision NOT NULL,
	"n_entries" integer NOT NULL,
	CONSTRAINT "mode2_points_calib_fit_id_year_pk" PRIMARY KEY("fit_id","year")
);
--> statement-breakpoint
CREATE TABLE "mode2_row_audit" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"included" boolean NOT NULL,
	"exclude_reason" text,
	"y_pp" double precision,
	"se_pp" double precision,
	"laps_fit" integer NOT NULL,
	"badge" text NOT NULL,
	CONSTRAINT "mode2_row_audit_fit_id_session_id_driver_id_pk" PRIMARY KEY("fit_id","session_id","driver_id"),
	CONSTRAINT "mode2_row_audit_reason_check" CHECK ("mode2_row_audit"."included" OR "mode2_row_audit"."exclude_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "mode2_car_hazard" ADD CONSTRAINT "mode2_car_hazard_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_car_hazard" ADD CONSTRAINT "mode2_car_hazard_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_car_rating" ADD CONSTRAINT "mode2_car_rating_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_car_rating" ADD CONSTRAINT "mode2_car_rating_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD CONSTRAINT "mode2_career_season_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD CONSTRAINT "mode2_career_season_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD CONSTRAINT "mode2_career_season_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_component" ADD CONSTRAINT "mode2_component_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_counterfactual" ADD CONSTRAINT "mode2_counterfactual_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_counterfactual" ADD CONSTRAINT "mode2_counterfactual_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_counterfactual" ADD CONSTRAINT "mode2_counterfactual_team_id_teams_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_counterfactual" ADD CONSTRAINT "mode2_counterfactual_replaced_driver_id_drivers_driver_id_fk" FOREIGN KEY ("replaced_driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_contrast" ADD CONSTRAINT "mode2_driver_contrast_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_contrast" ADD CONSTRAINT "mode2_driver_contrast_driver_a_drivers_driver_id_fk" FOREIGN KEY ("driver_a") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_contrast" ADD CONSTRAINT "mode2_driver_contrast_driver_b_drivers_driver_id_fk" FOREIGN KEY ("driver_b") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_rating" ADD CONSTRAINT "mode2_driver_rating_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_rating" ADD CONSTRAINT "mode2_driver_rating_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_rating_history" ADD CONSTRAINT "mode2_driver_rating_history_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_rating_history" ADD CONSTRAINT "mode2_driver_rating_history_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_skill" ADD CONSTRAINT "mode2_driver_skill_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_driver_skill" ADD CONSTRAINT "mode2_driver_skill_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_fit_run" ADD CONSTRAINT "mode2_fit_run_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_points_calib" ADD CONSTRAINT "mode2_points_calib_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_row_audit" ADD CONSTRAINT "mode2_row_audit_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_row_audit" ADD CONSTRAINT "mode2_row_audit_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_row_audit" ADD CONSTRAINT "mode2_row_audit_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mode2_fit_run_current_idx" ON "mode2_fit_run" USING btree ("assumption_set_id") WHERE "mode2_fit_run"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "mode2_fit_run_version_idx" ON "mode2_fit_run" USING btree ("assumption_set_id","model_version");--> statement-breakpoint
CREATE INDEX "mode2_row_audit_driver_idx" ON "mode2_row_audit" USING btree ("fit_id","driver_id","year","round");