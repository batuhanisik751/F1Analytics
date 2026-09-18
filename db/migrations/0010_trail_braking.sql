-- 0010_trail_braking.sql — GAPFILL_SPEC §4.1 (five columns) + §4.3 (derive_version).
-- WP-B0. Additive, reversible, and it touches no existing value: the 24,963 rows of
-- lap_corner_speeds and the 1,518 rows of lap_telemetry keep every pre-existing column
-- byte-identical (D7; WP-B4 proves it independently with a CSV snapshot diff).
--
-- Hand-written canonical copy. `web/drizzle/0010_trail_braking.sql` is the executable
-- transcription; `web/drizzle/meta/0010_snapshot.json` chains onto 0009's snapshot.
-- Drizzle owns DDL — Python never issues any and verifies via frames.EXPECTED_COLUMNS.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The five columns (§4.1), in DDL order.
--
-- NOTE on placement. §4.1 says "in DDL order after `brake_distance_m`". Postgres
-- appends: ALTER TABLE ... ADD COLUMN cannot insert a column mid-table without a
-- full rewrite, and a rewrite is exactly what D7 forbids us to risk. The five land
-- at ordinal positions 15..19 in the order below. "DDL order" is honoured as the
-- order of these five statements relative to each other, which is what a reader
-- of `\d lap_corner_speeds` actually sees.
-- ---------------------------------------------------------------------------
ALTER TABLE lap_corner_speeds ADD COLUMN brake_release_m         real;
ALTER TABLE lap_corner_speeds ADD COLUMN brake_release_to_apex_m real;
ALTER TABLE lap_corner_speeds ADD COLUMN brake_on_distance_m     real;
ALTER TABLE lap_corner_speeds ADD COLUMN trail_duty              real;   -- diagnostic, never rendered

-- DEVIATION FROM §4.1, deliberate and load-bearing. The spec writes this column as
--   ... trail_status text NOT NULL DEFAULT 'measured';
-- On a populated table that default stamps 'measured' onto all 24,963 legacy rows
-- while their three release metres are NULL, and the pairing CHECK below then
-- refuses to be created at all:
--   ERROR: check constraint "lap_corner_speeds_trail_check" of relation
--          "lap_corner_speeds" is violated by some row
-- (measured here, against the live table, before this migration was written).
-- The legacy rows carry no derivation yet, so the only honest legal status for them
-- is a non-'measured' one; 'too_few_samples' is the single member of the six that
-- reports absence rather than asserting a physical claim about the corner. The
-- steady-state default §4.1 pins is restored on the very next statement, so the
-- end state — and therefore the drizzle snapshot — is `text DEFAULT 'measured'
-- NOT NULL`, exactly as specified. Every one of these rows is replaced wholesale by
-- WP-B1's `warm_telemetry.py --force` backfill (§4.3); none survives to be rendered.
ALTER TABLE lap_corner_speeds ADD COLUMN trail_status text NOT NULL DEFAULT 'too_few_samples';
ALTER TABLE lap_corner_speeds ALTER COLUMN trail_status SET DEFAULT 'measured';

-- ---------------------------------------------------------------------------
-- 2. §4.3 / R1 — the recipe version, so the backfill cannot silently no-op.
-- `lap_telemetry.source_hash` is a SHA-256 over the RAW FastF1 inputs, not the
-- derivation. Without this column all 1,518 laps hash identically after 0010, a
-- default warm run skips every session, the five new columns stay NULL forever and
-- the build exits 0. The skip condition becomes
--   source_hash matches AND derive_version = TRAIL_DERIVE_VERSION
-- with TRAIL_DERIVE_VERSION = 2 (§4.2), so all 1,518 legacy rows (defaulted to 1)
-- are stale the moment this migration commits.
-- ---------------------------------------------------------------------------
ALTER TABLE lap_telemetry ADD COLUMN derive_version smallint NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 3. The two CHECKs (§4.1). Both VALID at commit — no NOT VALID escape hatch, so
-- the pairing is enforced by the database from this instant, including against the
-- legacy rows. Enforcement at the schema layer, not in a caption (R4).
-- ---------------------------------------------------------------------------
ALTER TABLE lap_corner_speeds ADD CONSTRAINT lap_corner_speeds_trail_status_check CHECK (
  trail_status IN ('measured','taken_flat','shared_zone_non_terminal',
                   'too_few_samples','release_step_too_wide','implied_decel_impossible'));

-- The three release numbers are NULL together, always: one CHECK, not three chances
-- to disagree. `trail_duty` is deliberately NOT in it — it is computable at a
-- non-terminal shared corner and stored there as an unrendered diagnostic (§4.1).
ALTER TABLE lap_corner_speeds ADD CONSTRAINT lap_corner_speeds_trail_check CHECK (
  (trail_status <> 'measured'
     AND brake_release_m IS NULL AND brake_release_to_apex_m IS NULL
     AND brake_on_distance_m IS NULL)
  OR (trail_status = 'measured'
     AND brake_release_m IS NOT NULL AND brake_release_to_apex_m IS NOT NULL
     AND brake_on_distance_m IS NOT NULL AND brake_point_m IS NOT NULL));

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (no other table is touched, no pre-existing column is read or written):
--   ALTER TABLE lap_corner_speeds DROP CONSTRAINT lap_corner_speeds_trail_check;
--   ALTER TABLE lap_corner_speeds DROP CONSTRAINT lap_corner_speeds_trail_status_check;
--   ALTER TABLE lap_telemetry     DROP COLUMN derive_version;
--   ALTER TABLE lap_corner_speeds DROP COLUMN trail_status, DROP COLUMN trail_duty,
--     DROP COLUMN brake_on_distance_m, DROP COLUMN brake_release_to_apex_m,
--     DROP COLUMN brake_release_m;
-- ---------------------------------------------------------------------------
