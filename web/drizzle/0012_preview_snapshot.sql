CREATE TABLE "preview_snapshot_order" (
	"year" integer NOT NULL,
	"round" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
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
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_snapshot_order_year_round_computed_at_driver_id_pk" PRIMARY KEY("year","round","computed_at","driver_id")
);
--> statement-breakpoint
CREATE TABLE "preview_snapshot_round" (
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
	"computed_at" timestamp with time zone NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_snapshot_round_year_round_computed_at_pk" PRIMARY KEY("year","round","computed_at")
);
--> statement-breakpoint
ALTER TABLE "preview_snapshot_order" ADD CONSTRAINT "preview_snapshot_order_round_fk" FOREIGN KEY ("year","round","computed_at") REFERENCES "public"."preview_snapshot_round"("year","round","computed_at") ON DELETE cascade ON UPDATE no action;