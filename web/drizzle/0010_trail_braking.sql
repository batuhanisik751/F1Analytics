ALTER TABLE "lap_corner_speeds" ADD COLUMN "brake_release_m" real;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD COLUMN "brake_release_to_apex_m" real;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD COLUMN "brake_on_distance_m" real;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD COLUMN "trail_duty" real;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD COLUMN "trail_status" text DEFAULT 'too_few_samples' NOT NULL;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ALTER COLUMN "trail_status" SET DEFAULT 'measured';--> statement-breakpoint
ALTER TABLE "lap_telemetry" ADD COLUMN "derive_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD CONSTRAINT "lap_corner_speeds_trail_status_check" CHECK (trail_status IN ('measured','taken_flat','shared_zone_non_terminal',
                   'too_few_samples','release_step_too_wide','implied_decel_impossible'));--> statement-breakpoint
ALTER TABLE "lap_corner_speeds" ADD CONSTRAINT "lap_corner_speeds_trail_check" CHECK ((trail_status <> 'measured'
     AND brake_release_m IS NULL AND brake_release_to_apex_m IS NULL
     AND brake_on_distance_m IS NULL)
  OR (trail_status = 'measured'
     AND brake_release_m IS NOT NULL AND brake_release_to_apex_m IS NOT NULL
     AND brake_on_distance_m IS NOT NULL AND brake_point_m IS NOT NULL));
