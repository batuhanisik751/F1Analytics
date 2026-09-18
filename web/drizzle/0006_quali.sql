CREATE TABLE "quali_results" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"position" integer NOT NULL,
	"q1_s" double precision,
	"q2_s" double precision,
	"q3_s" double precision,
	"best_s" double precision,
	"best_segment" integer,
	"best_lap_number" integer,
	"segments_entered" integer NOT NULL,
	"knocked_out_in" integer,
	"set_a_time" boolean NOT NULL,
	"gap_to_pole_s" double precision,
	"gap_to_pole_pct" double precision,
	"gap_to_pole_common_s" double precision,
	"gap_to_pole_common_pct" double precision,
	"gap_to_pole_segment" integer,
	"n_repr_laps" integer NOT NULL,
	"push_laps" integer NOT NULL,
	"times_source" text NOT NULL,
	CONSTRAINT "quali_results_session_id_driver_id_pk" PRIMARY KEY("session_id","driver_id"),
	CONSTRAINT "quali_results_best_segment_check" CHECK (best_segment IS NULL OR best_segment BETWEEN 1 AND 3),
	CONSTRAINT "quali_results_pole_segment_check" CHECK (gap_to_pole_segment IS NULL OR gap_to_pole_segment BETWEEN 1 AND 3),
	CONSTRAINT "quali_results_entered_check" CHECK (segments_entered BETWEEN 1 AND 3),
	CONSTRAINT "quali_results_time_check" CHECK (set_a_time = (best_s IS NOT NULL)),
	CONSTRAINT "quali_results_times_source_check" CHECK (times_source IN ('api','derived'))
);
--> statement-breakpoint
CREATE TABLE "quali_segment_times" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"segment" integer NOT NULL,
	"laps_run" integer NOT NULL,
	"repr_laps" integer NOT NULL,
	"push_laps" integer NOT NULL,
	"best_s" double precision,
	"best_lap_number" integer,
	"gap_to_best_s" double precision,
	"gap_to_best_pct" double precision,
	"spread_s" double precision,
	"sd_s" double precision,
	"compound" text,
	"tyre_life" integer,
	"wet_compound" boolean NOT NULL,
	CONSTRAINT "quali_segment_times_session_id_driver_id_segment_pk" PRIMARY KEY("session_id","driver_id","segment"),
	CONSTRAINT "quali_segment_times_segment_check" CHECK (segment BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "quali_teammate_h2h" (
	"session_id" integer NOT NULL,
	"team_id" text NOT NULL,
	"driver_a" text NOT NULL,
	"driver_b" text NOT NULL,
	"segment" integer,
	"a_best_s" double precision,
	"b_best_s" double precision,
	"delta_s" double precision,
	"delta_pct" double precision,
	"comparable" boolean NOT NULL,
	"classified_ahead" text NOT NULL,
	"divergent" boolean NOT NULL,
	"session_sd_s" double precision,
	"below_noise" boolean NOT NULL,
	CONSTRAINT "quali_teammate_h2h_session_id_team_id_driver_a_driver_b_pk" PRIMARY KEY("session_id","team_id","driver_a","driver_b"),
	CONSTRAINT "quali_teammate_h2h_segment_check" CHECK (segment IS NULL OR segment BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "season_quali_h2h" (
	"year" integer NOT NULL,
	"kind" text NOT NULL,
	"team_id" text NOT NULL,
	"driver_a" text NOT NULL,
	"driver_b" text NOT NULL,
	"sessions_counted" integer NOT NULL,
	"a_wins" integer NOT NULL,
	"b_wins" integer NOT NULL,
	"deltas_counted" integer NOT NULL,
	"median_delta_s" double precision,
	"median_delta_pct" double precision,
	"mad_delta_pct" double precision,
	"sessions_caveated" integer NOT NULL,
	CONSTRAINT "season_quali_h2h_year_kind_team_id_driver_a_driver_b_pk" PRIMARY KEY("year","kind","team_id","driver_a","driver_b"),
	CONSTRAINT "season_quali_h2h_kind_check" CHECK (kind IN ('Q','SQ')),
	CONSTRAINT "season_quali_h2h_wins_check" CHECK (a_wins + b_wins = sessions_counted)
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_kind_check";--> statement-breakpoint
ALTER TABLE "laps" ADD COLUMN "quali_segment" integer;--> statement-breakpoint
ALTER TABLE "laps" ADD COLUMN "segment_source" text;--> statement-breakpoint
ALTER TABLE "laps" ADD COLUMN "is_push_lap" boolean;--> statement-breakpoint
ALTER TABLE "laps" ADD COLUMN "excl_disallowed" boolean;--> statement-breakpoint
ALTER TABLE "laps" ADD COLUMN "deleted_inferred" boolean;--> statement-breakpoint
ALTER TABLE "quali_results" ADD CONSTRAINT "quali_results_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_results" ADD CONSTRAINT "quali_results_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_results" ADD CONSTRAINT "quali_results_session_entry_fk" FOREIGN KEY ("session_id","driver_id") REFERENCES "public"."session_entries"("session_id","driver_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_segment_times" ADD CONSTRAINT "quali_segment_times_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_segment_times" ADD CONSTRAINT "quali_segment_times_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_teammate_h2h" ADD CONSTRAINT "quali_teammate_h2h_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_teammate_h2h" ADD CONSTRAINT "quali_teammate_h2h_driver_a_drivers_driver_id_fk" FOREIGN KEY ("driver_a") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_teammate_h2h" ADD CONSTRAINT "quali_teammate_h2h_driver_b_drivers_driver_id_fk" FOREIGN KEY ("driver_b") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quali_teammate_h2h" ADD CONSTRAINT "quali_teammate_h2h_classified_ahead_drivers_driver_id_fk" FOREIGN KEY ("classified_ahead") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_quali_h2h" ADD CONSTRAINT "season_quali_h2h_driver_a_drivers_driver_id_fk" FOREIGN KEY ("driver_a") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_quali_h2h" ADD CONSTRAINT "season_quali_h2h_driver_b_drivers_driver_id_fk" FOREIGN KEY ("driver_b") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quali_results_driver_idx" ON "quali_results" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "laps_quali_segment_idx" ON "laps" USING btree ("session_id","quali_segment") WHERE quali_segment IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_check" CHECK (kind IN ('R','S','Q','SQ'));--> statement-breakpoint
ALTER TABLE "laps" ADD CONSTRAINT "laps_quali_segment_check" CHECK (quali_segment IS NULL OR quali_segment BETWEEN 1 AND 3);--> statement-breakpoint
ALTER TABLE "laps" ADD CONSTRAINT "laps_segment_source_check" CHECK (segment_source IS NULL OR segment_source IN ('window','anchor_repair'));