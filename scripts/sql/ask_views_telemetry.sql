-- scripts/sql/ask_views_telemetry.sql — the v1.7 telemetry step of the ask deploy chain.
-- TELEMETRY_SPEC §2.6 (T6), MODE3_SPEC §1.2. Idempotent; safe to re-run.
--
-- The three new ask views are NOT created here. They are table-backed, so they are emitted by
-- scripts/gen_ask_schema.py into scripts/sql/0005_ask_views.sql along with the enumerated
-- GRANT, and `make db-ask-views` applies that file. Creating them a second time here would
-- give the contract two sources and is exactly what §1.2 forbids. This file does the two
-- things the generator cannot: it ASSERTS the telemetry half of the boundary landed, and it
-- invalidates the answer cache the generated document has just aged out.
--
-- Run AFTER migration 0008 and AFTER `make db-ask-views`:
--   docker exec -i f1-postgres psql -U f1 -d f1 -v ON_ERROR_STOP=1 -f - < scripts/sql/ask_views_telemetry.sql

BEGIN;

-- 1. The three scalar views exist and are granted to f1_ask.
DO $tel$
DECLARE
  n_views int;
  n_grants int;
  wanted text[] := ARRAY['lap_telemetry_summary', 'lap_corner_speeds', 'circuit_corners'];
BEGIN
  SELECT count(*) INTO n_views
    FROM pg_views WHERE schemaname = 'ask' AND viewname = ANY(wanted);
  IF n_views <> 3 THEN
    RAISE EXCEPTION 'expected 3 telemetry views in schema ask, found % - run `make db-ask-views` first', n_views;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1_ask') THEN
    SELECT count(*) INTO n_grants
      FROM information_schema.table_privileges
     WHERE grantee = 'f1_ask' AND table_schema = 'ask'
       AND table_name = ANY(wanted) AND privilege_type = 'SELECT';
    IF n_grants <> 3 THEN
      RAISE EXCEPTION 'f1_ask holds SELECT on only % of the 3 telemetry views - re-run scripts/sql/0005_ask_views.sql', n_grants;
    END IF;
  ELSE
    RAISE NOTICE 'role f1_ask does not exist yet - run scripts/sql/0005_roles.sql, then re-run 0005_ask_views.sql and this file';
  END IF;
END
$tel$;

-- 2. The GRANT-level exclusions (T6): the array table and the rendering geometry must have no
--    view at all, so a compromised model gets `permission denied` rather than a prompt rule.
DO $tel_excl$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(viewname, ', ') INTO leaked
    FROM pg_views
   WHERE schemaname = 'ask' AND viewname IN ('lap_telemetry', 'circuit_layout');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'ask.% must not exist: lap_telemetry and circuit_layout are excluded at the GRANT level (T6)', leaked;
  END IF;
END
$tel_excl$;

-- 3. Invalidate the answer cache (QUALI_SPEC §5.3.3 precedent, TELEMETRY_SPEC §2.6).
--    The generated schema document is part of the cached prompt prefix and it has just gained
--    three signature lines and two convention lines; every cached answer predates them and was
--    produced by a model that had been told these tables do not exist. The rows are keyed on
--    prefix_sha256, so a blanket DELETE is the honest move - a stale hit is a wrong answer
--    served for free.
DELETE FROM public.ask_answer_cache;

COMMIT;
