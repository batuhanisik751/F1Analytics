-- v1.3 fix: `starts` and `teams` on mode2_career_season (MODE2_SPEC §12.6).
-- Additive only; it touches no table that is not prefixed `mode2_` (§6.7).
--
-- The two new columns are NOT NULL and cannot be back-filled: how much of a calendar a
-- seat covered, and which cars it covered it in, are facts of the FIT, not of the stored
-- row. mode2_career_season is a derived artifact with no children, and
-- `ingest --recompute-companion mode2 --force` rebuilds it in full, so the honest
-- migration empties it rather than inventing a default that would read as a real season
-- length. Run the recompute immediately after this migration; until then the
-- car-adjusted career section renders its §8.8 EmptyState.
DELETE FROM "mode2_career_season";--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD COLUMN "starts" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD COLUMN "teams" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mode2_career_season" ADD CONSTRAINT "mode2_career_season_starts_check" CHECK ("mode2_career_season"."starts" > 0);
