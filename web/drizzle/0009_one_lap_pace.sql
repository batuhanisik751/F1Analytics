CREATE TABLE "mode2_quali_row_audit" (
	"fit_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"driver_id" text NOT NULL,
	"team_id" text NOT NULL,
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"kind" text NOT NULL,
	"included" boolean NOT NULL,
	"exclude_reason" text,
	"y_pp" double precision,
	"best_s" double precision,
	CONSTRAINT "mode2_quali_row_audit_fit_id_session_id_driver_id_pk" PRIMARY KEY("fit_id","session_id","driver_id"),
	CONSTRAINT "mode2_quali_row_audit_reason_check" CHECK ("mode2_quali_row_audit"."included" OR "mode2_quali_row_audit"."exclude_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "mode2_driver_skill" DROP CONSTRAINT "mode2_driver_skill_skill_check";--> statement-breakpoint
ALTER TABLE "mode2_fit_run" ADD COLUMN "corr_one_lap_grid" double precision;--> statement-breakpoint
ALTER TABLE "mode2_fit_run" ADD COLUMN "corr_one_lap_grid_ex_islands" double precision;--> statement-breakpoint
ALTER TABLE "mode2_fit_run" ADD COLUMN "corr_one_lap_race" double precision;--> statement-breakpoint
ALTER TABLE "mode2_quali_row_audit" ADD CONSTRAINT "mode2_quali_row_audit_fit_id_mode2_fit_run_fit_id_fk" FOREIGN KEY ("fit_id") REFERENCES "public"."mode2_fit_run"("fit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_quali_row_audit" ADD CONSTRAINT "mode2_quali_row_audit_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mode2_quali_row_audit" ADD CONSTRAINT "mode2_quali_row_audit_driver_id_drivers_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mode2_quali_row_audit_driver_idx" ON "mode2_quali_row_audit" USING btree ("fit_id","driver_id","year","round");--> statement-breakpoint
ALTER TABLE "mode2_driver_skill" ADD CONSTRAINT "mode2_driver_skill_skill_check" CHECK ("mode2_driver_skill"."skill" IN ('race_pace','one_lap_pace','grid_pace','tyre_management','wet','sprint_one_lap','trail_braking'));