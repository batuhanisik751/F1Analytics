-- 0009_one_lap_pace.sql -- F1 Analytics v1.8, Gap A schema (GAPFILL_SPEC §2.2).
--
-- Hand-written from §2.2 and hand-diffed against the Drizzle-generated
-- web/drizzle/0009_one_lap_pace.sql per MODE2_SPEC §6.4's three transcription traps.
-- Drizzle owns DDL: the file actually executed against the database is the one under
-- web/drizzle/. This file is the specification-side transcription and the rollback of
-- record. The two differ only in constraint-naming style, itemised at the foot.
--
-- All additive. All reversible. No stored row is touched (D7): mode2_row_audit stays
-- at 983 rows and no mode2_driver_skill row changes value.

BEGIN;

-- 1. The skill vocabulary. This CHECK is why a migration is mandatory at all.
--    Every key listed here IS written by this release (DL-11). No key is added
--    speculatively: one_lap_pace is measured (D1); sprint_one_lap (D3) and
--    trail_braking (D6) are written as real measured = false rows for all 28 drivers,
--    exactly as tyre_management and wet already are.
--    The rows are written by the fit (f1lab/decomp.py, WP-A1), not by this DDL --
--    every row carries a fit_id, so there is nothing to seed at migration time.
--    Net effect once WP-A1 lands: mode2_driver_skill 112 -> 196 (7 keys x 28 drivers).
ALTER TABLE mode2_driver_skill DROP CONSTRAINT mode2_driver_skill_skill_check;
ALTER TABLE mode2_driver_skill ADD CONSTRAINT mode2_driver_skill_skill_check
  CHECK (skill IN ('race_pace','one_lap_pace','grid_pace',
                   'tyre_management','wet','sprint_one_lap','trail_braking'));

-- 2. The pre-registered decision numbers, stored rather than remembered (§2.1).
--    QUALI_SPEC §5.1.1 pre-registered grid_pace retirement at r >= 0.95; measured
--    0.8393 all-28 / 0.8670 ex-island (DL-5). Threshold not met, grid_pace is kept
--    unchanged (D2). Storing both makes the decision auditable from the database in
--    every later release; gate G3 (§6.3) fails the build if either reaches 0.95.
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_grid            double precision;
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_grid_ex_islands double precision;
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_race            double precision;

-- 3. The qualifying row audit. A NEW table, deliberately not mode2_row_audit: that
--    table's laps_fit and badge are race-pace vocabulary and NOT NULL, its y_pp is a
--    fuel-corrected race response, and tests/test_quali_integration.py pins it at 983
--    rows as proof that v1.6 moved no race analytics. D7 keeps that constant at 983.
CREATE TABLE mode2_quali_row_audit (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  session_id        integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text    NOT NULL,
  year              integer NOT NULL,
  round             integer NOT NULL,
  kind              text    NOT NULL,
  included          boolean NOT NULL,
  exclude_reason    text,
  y_pp              double precision,
  best_s            double precision,
  PRIMARY KEY (fit_id, session_id, driver_id),
  CONSTRAINT mode2_quali_row_audit_reason_check CHECK (included OR exclude_reason IS NOT NULL)
);
CREATE INDEX mode2_quali_row_audit_driver_idx
  ON mode2_quali_row_audit (fit_id, driver_id, year, round);

COMMIT;

-- ---------------------------------------------------------------------------------
-- HAND-DIFF vs web/drizzle/0009_one_lap_pace.sql (§6.3 WP-A0 row).
-- Semantically identical. Four naming-style differences, all pre-existing project
-- convention, all verified against the already-shipped mode2_row_audit:
--   a. PRIMARY KEY is named mode2_quali_row_audit_fit_id_session_id_driver_id_pk by
--      Drizzle, where inline SQL would get mode2_quali_row_audit_pkey. Matches
--      mode2_row_audit_fit_id_session_id_driver_id_pk.
--   b. The three FKs are emitted as separate ALTER TABLE ADD CONSTRAINT statements
--      with Drizzle's <table>_<col>_<reftable>_<refcol>_fk names, not inline.
--   c. driver_id's FK is spelled ON DELETE no action (the SQL default).
--   d. Drizzle emits the skill CHECK drop first and the replacement last; this file
--      keeps them adjacent. Both run inside one transaction with no intervening
--      INSERT, so no row can be written while the CHECK is absent.
-- MODE2_SPEC §6.4 traps re-checked: (1) no partial index is involved, and
-- mode2_fit_run_current_idx is untouched; (2) every new column is double precision,
-- never numeric or real; (3) both new CHECKs are explicitly named, so a later
-- drizzle-kit generate cannot invent a name and emit a spurious drop/add pair.
--
-- ROLLBACK (§2.2). Runnable copy: output/0009_one_lap_pace_rollback.sql
--
--   BEGIN;
--   DELETE FROM mode2_driver_skill
--    WHERE skill IN ('one_lap_pace','sprint_one_lap','trail_braking');
--   DROP TABLE IF EXISTS mode2_quali_row_audit;
--   ALTER TABLE mode2_fit_run DROP COLUMN IF EXISTS corr_one_lap_grid;
--   ALTER TABLE mode2_fit_run DROP COLUMN IF EXISTS corr_one_lap_grid_ex_islands;
--   ALTER TABLE mode2_fit_run DROP COLUMN IF EXISTS corr_one_lap_race;
--   ALTER TABLE mode2_driver_skill DROP CONSTRAINT mode2_driver_skill_skill_check;
--   ALTER TABLE mode2_driver_skill ADD CONSTRAINT mode2_driver_skill_skill_check
--     CHECK (skill IN ('race_pace','grid_pace','tyre_management','wet'));
--   COMMIT;
--
-- The DELETE must precede the CHECK restore or the four-value CHECK cannot validate.
-- No other table is touched. mode2_row_audit is not named anywhere in either script.
