CREATE TABLE "sim_circuit_hazard" (
	"circuit_key" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"recomputed_at" timestamp with time zone NOT NULL,
	"races" integer NOT NULL,
	"laps" integer NOT NULL,
	"sc_episodes" integer NOT NULL,
	"vsc_episodes" integer NOT NULL,
	"sc_hazard" double precision NOT NULL,
	"vsc_hazard" double precision NOT NULL,
	"pit_loss_circuit_s" double precision,
	"pooled_races" integer NOT NULL,
	"sc_hazard_pooled" double precision NOT NULL,
	"vsc_hazard_pooled" double precision NOT NULL,
	"sc_start_p" double precision NOT NULL,
	"vsc_start_p" double precision NOT NULL,
	"sc_dur_mean" double precision NOT NULL,
	"vsc_dur_mean" double precision NOT NULL,
	"pit_loss_pooled_s" double precision NOT NULL,
	"pit_loss_pooled_mad_s" double precision NOT NULL,
	"sc_pit_factor_pooled" double precision NOT NULL,
	"vsc_pit_factor_pooled" double precision NOT NULL,
	CONSTRAINT "sim_circuit_hazard_circuit_key_pk" PRIMARY KEY("circuit_key")
);
--> statement-breakpoint
CREATE TABLE "sim_compound_params" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"compound" text NOT NULL,
	"laps" integer NOT NULL,
	"age_max" integer NOT NULL,
	"offset_s" double precision NOT NULL,
	"offset_se" double precision NOT NULL,
	"deg_raw_s_per_lap" double precision NOT NULL,
	"deg_s_per_lap" double precision NOT NULL,
	"deg_se" double precision NOT NULL,
	"deg_negative" boolean NOT NULL,
	"stint_tau_level_s" double precision NOT NULL,
	"stint_tau_slope" double precision NOT NULL,
	"stint_tau_source" text NOT NULL,
	"stints_used" integer NOT NULL,
	CONSTRAINT "sim_compound_params_session_id_compound_pk" PRIMARY KEY("session_id","compound"),
	CONSTRAINT "sim_compound_params_tau_source" CHECK (stint_tau_source IN ('race','prior'))
);
--> statement-breakpoint
CREATE TABLE "sim_driver_compound" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"compound" text NOT NULL,
	"laps" integer NOT NULL,
	"dc_offset_s" double precision NOT NULL,
	"dc_se" double precision NOT NULL,
	CONSTRAINT "sim_driver_compound_session_id_driver_id_compound_pk" PRIMARY KEY("session_id","driver_id","compound")
);
--> statement-breakpoint
CREATE TABLE "sim_driver_params" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"laps_fit" integer NOT NULL,
	"base_s" double precision NOT NULL,
	"base_se" double precision NOT NULL,
	"noise_sd_s" double precision NOT NULL,
	"laps_completed" integer NOT NULL,
	"laps_timed" integer NOT NULL,
	"laps_modelled" integer NOT NULL,
	"unmodelled_laps" integer NOT NULL,
	"stops" integer NOT NULL,
	"simulable" boolean NOT NULL,
	"not_simulable_reason" text,
	"real_total_s" double precision,
	"real_total_fc_s" double precision,
	"real_fuel_s" double precision,
	"sim_total_fc_s" double precision,
	"misfit_rep_s" double precision,
	"misfit_pit_s" double precision,
	"misfit_lap1_s" double precision,
	"unmodelled_s" double precision,
	"badge" text,
	CONSTRAINT "sim_driver_params_session_id_driver_id_pk" PRIMARY KEY("session_id","driver_id"),
	CONSTRAINT "sim_driver_params_badge" CHECK (badge IN ('calibrated','rough','poor'))
);
--> statement-breakpoint
CREATE TABLE "sim_race_params" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"total_laps" integer NOT NULL,
	"ref_compound" text NOT NULL,
	"laps_fit" integer NOT NULL,
	"drivers_fit" integer NOT NULL,
	"r2" double precision NOT NULL,
	"resid_sd_s" double precision NOT NULL,
	"resid_mad_s" double precision NOT NULL,
	"design_cond" double precision NOT NULL,
	"evo_s_per_lap" double precision NOT NULL,
	"evo_se" double precision NOT NULL,
	"param_names" text[] NOT NULL,
	"param_mean" double precision[] NOT NULL,
	"param_chol" double precision[] NOT NULL,
	"field_delta_s" double precision[] NOT NULL,
	"field_delta_cars" integer[] NOT NULL,
	"start_penalty_s" double precision NOT NULL,
	"pit_loss_s" double precision,
	"pit_loss_mad_s" double precision,
	"pit_loss_n" integer NOT NULL,
	"pit_loss_samples_s" double precision[] NOT NULL,
	"sc_pit_samples_s" double precision[] NOT NULL,
	"vsc_pit_samples_s" double precision[] NOT NULL,
	"sc_pit_factor_race" double precision,
	"vsc_pit_factor_race" double precision,
	"stint_coverage_80" double precision,
	"n_sc_laps" integer NOT NULL,
	"n_vsc_laps" integer NOT NULL,
	"n_red_laps" integer NOT NULL,
	CONSTRAINT "sim_race_params_session_id_pk" PRIMARY KEY("session_id")
);
--> statement-breakpoint
ALTER TABLE "sim_circuit_hazard" ADD CONSTRAINT "sim_circuit_hazard_circuit_key_circuits_circuit_key_fk" FOREIGN KEY ("circuit_key") REFERENCES "public"."circuits"("circuit_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_circuit_hazard" ADD CONSTRAINT "sim_circuit_hazard_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_compound_params" ADD CONSTRAINT "sim_compound_params_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_compound_params" ADD CONSTRAINT "sim_compound_params_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_compound" ADD CONSTRAINT "sim_driver_compound_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_compound" ADD CONSTRAINT "sim_driver_compound_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_compound" ADD CONSTRAINT "sim_driver_compound_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_params" ADD CONSTRAINT "sim_driver_params_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_params" ADD CONSTRAINT "sim_driver_params_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_driver_params" ADD CONSTRAINT "sim_driver_params_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_race_params" ADD CONSTRAINT "sim_race_params_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_race_params" ADD CONSTRAINT "sim_race_params_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;