CREATE TABLE "data_release" (
	"release_id" serial PRIMARY KEY NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sessions_pushed" integer DEFAULT 0 NOT NULL,
	"rows_pushed" bigint DEFAULT 0 NOT NULL,
	"census_sha256" text NOT NULL
);
