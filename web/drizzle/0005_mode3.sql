CREATE TABLE "ask_answer_cache" (
	"question_key" text PRIMARY KEY NOT NULL,
	"question_norm" text NOT NULL,
	"prefix_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_query_log" (
	"ask_id" bigserial PRIMARY KEY NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_cookie" text NOT NULL,
	"ip_hash" text NOT NULL,
	"question" text NOT NULL,
	"question_norm" text NOT NULL,
	"intent" text,
	"sql_generated" text,
	"sql_executed" text,
	"validator_verdict" text NOT NULL,
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"row_count" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"render_kind" text,
	"max_plan_cost" double precision,
	"touched_views" text[] DEFAULT '{}' NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_creation_input_tokens" integer,
	"estimated_cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "race_report" (
	"session_id" integer NOT NULL,
	"assumption_set_id" integer NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"grounding_completeness" text NOT NULL,
	"grounding_sha256" text NOT NULL,
	"result" text,
	"pace" text,
	"strategy" text,
	"swing" text,
	"caveats" text,
	"known_gaps" text[] DEFAULT '{}' NOT NULL,
	"cites" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_reason" text,
	"word_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" real DEFAULT 0 NOT NULL,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_report_session_id_assumption_set_id_pk" PRIMARY KEY("session_id","assumption_set_id"),
	CONSTRAINT "race_report_status_check" CHECK ("race_report"."status" = ANY (ARRAY['ok','refused','skipped'])),
	CONSTRAINT "race_report_completeness_check" CHECK ("race_report"."grounding_completeness" = ANY (ARRAY['ok','partial','insufficient'])),
	CONSTRAINT "race_report_body_check" CHECK (("race_report"."status" = 'ok') = ("race_report"."result" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "race_report" ADD CONSTRAINT "race_report_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_report" ADD CONSTRAINT "race_report_assumption_set_id_assumption_sets_assumption_set_id_fk" FOREIGN KEY ("assumption_set_id") REFERENCES "public"."assumption_sets"("assumption_set_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_query_log_asked_at_idx" ON "ask_query_log" USING btree ("asked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ask_query_log_cookie_idx" ON "ask_query_log" USING btree ("session_cookie","asked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ask_query_log_ip_idx" ON "ask_query_log" USING btree ("ip_hash","asked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ask_query_log_outcome_idx" ON "ask_query_log" USING btree ("outcome","asked_at" DESC NULLS LAST);