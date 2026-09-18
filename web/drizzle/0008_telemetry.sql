CREATE TABLE "circuit_corners" (
	"circuit_key" integer NOT NULL,
	"year" integer NOT NULL,
	"corner_number" integer NOT NULL,
	"corner_letter" text DEFAULT '' NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"angle_deg" real,
	"distance_m" real NOT NULL,
	CONSTRAINT "circuit_corners_circuit_key_year_corner_number_corner_letter_pk" PRIMARY KEY("circuit_key","year","corner_number","corner_letter")
);
--> statement-breakpoint
CREATE TABLE "circuit_layout" (
	"circuit_key" integer NOT NULL,
	"year" integer NOT NULL,
	"rotation_deg" real NOT NULL,
	"n_corners" integer NOT NULL,
	"track_length_m" real NOT NULL,
	"ref_session_id" integer NOT NULL,
	CONSTRAINT "circuit_layout_circuit_key_year_pk" PRIMARY KEY("circuit_key","year")
);
--> statement-breakpoint
CREATE TABLE "lap_corner_speeds" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"lap_number" integer NOT NULL,
	"corner_number" integer NOT NULL,
	"corner_letter" text DEFAULT '' NOT NULL,
	"apex_speed_kph" smallint NOT NULL,
	"apex_distance_m" real NOT NULL,
	"entry_speed_kph" smallint NOT NULL,
	"exit_speed_kph" smallint NOT NULL,
	"brake_zone_idx" integer,
	"brake_point_m" real,
	"brake_distance_m" real,
	"throttle_point_m" real,
	"time_in_corner_s" real NOT NULL,
	CONSTRAINT "lap_corner_speeds_session_id_driver_id_lap_number_corner_number_corner_letter_pk" PRIMARY KEY("session_id","driver_id","lap_number","corner_number","corner_letter")
);
--> statement-breakpoint
CREATE TABLE "lap_telemetry" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"lap_number" integer NOT NULL,
	"selection" text DEFAULT 'fastest' NOT NULL,
	"n_samples" integer NOT NULL,
	"n_car_samples" integer NOT NULL,
	"n_pos_samples" integer NOT NULL,
	"max_sample_gap_m" real NOT NULL,
	"track_length_m" real NOT NULL,
	"source_hash" text NOT NULL,
	"distance_m" real[] NOT NULL,
	"time_s" real[] NOT NULL,
	"x" real[] NOT NULL,
	"y" real[] NOT NULL,
	"speed_kph" smallint[] NOT NULL,
	"throttle_pct" smallint[] NOT NULL,
	"brake" boolean[] NOT NULL,
	"gear" smallint[] NOT NULL,
	"drs" smallint[] NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lap_telemetry_session_id_driver_id_lap_number_pk" PRIMARY KEY("session_id","driver_id","lap_number"),
	CONSTRAINT "lap_telemetry_selection_check" CHECK (selection IN ('fastest')),
	CONSTRAINT "lap_telemetry_samples_check" CHECK (n_samples BETWEEN 50 AND 5000),
	CONSTRAINT "lap_telemetry_lengths_check" CHECK (array_length(distance_m,1) = n_samples AND array_length(time_s,1) = n_samples AND
    array_length(x,1) = n_samples AND array_length(y,1) = n_samples AND
    array_length(speed_kph,1) = n_samples AND array_length(brake,1) = n_samples AND
    array_length(throttle_pct,1) = n_samples AND array_length(gear,1) = n_samples AND
    array_length(drs,1) = n_samples)
);
--> statement-breakpoint
CREATE TABLE "lap_telemetry_summary" (
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"lap_number" integer NOT NULL,
	"top_speed_kph" smallint NOT NULL,
	"min_speed_kph" smallint NOT NULL,
	"full_throttle_pct" real NOT NULL,
	"brake_pct" real NOT NULL,
	"lift_pct" real NOT NULL,
	"overlap_pct" real NOT NULL,
	"n_brake_zones" integer NOT NULL,
	"n_gear_changes" integer NOT NULL,
	"drs_distance_m" real,
	"track_length_m" real NOT NULL,
	"s1_distance_m" real,
	"s2_distance_m" real,
	"n_samples" integer NOT NULL,
	"max_sample_gap_m" real NOT NULL,
	"n_gaps_over_50m" integer NOT NULL,
	CONSTRAINT "lap_telemetry_summary_session_id_driver_id_lap_number_pk" PRIMARY KEY("session_id","driver_id","lap_number")
);
--> statement-breakpoint
ALTER TABLE "circuit_corners" ADD CONSTRAINT "circuit_corners_layout_fk" FOREIGN KEY ("circuit_key","year") REFERENCES "public"."circuit_layout"("circuit_key","year") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_layout" ADD CONSTRAINT "circuit_layout_circuit_key_circuits_circuit_key_fk" FOREIGN KEY ("circuit_key") REFERENCES "public"."circuits"("circuit_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuit_layout" ADD CONSTRAINT "circuit_layout_ref_session_id_sessions_session_id_fk" FOREIGN KEY ("ref_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD CONSTRAINT "lap_corner_speeds_lap_fk" FOREIGN KEY ("session_id","driver_id","lap_number") REFERENCES "public"."lap_telemetry"("session_id","driver_id","lap_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_telemetry" ADD CONSTRAINT "lap_telemetry_lap_fk" FOREIGN KEY ("session_id","driver_id","lap_number") REFERENCES "public"."laps"("session_id","driver_id","lap_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lap_telemetry_summary" ADD CONSTRAINT "lap_telemetry_summary_lap_fk" FOREIGN KEY ("session_id","driver_id","lap_number") REFERENCES "public"."lap_telemetry"("session_id","driver_id","lap_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lap_corner_speeds_corner_idx" ON "lap_corner_speeds" USING btree ("session_id","corner_number");--> statement-breakpoint
CREATE INDEX "lap_telemetry_session_idx" ON "lap_telemetry" USING btree ("session_id");