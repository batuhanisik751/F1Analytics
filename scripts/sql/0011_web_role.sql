-- scripts/sql/0011_web_role.sql — OPS_SPEC §4.2: the web app's read-only role `f1_web`.
--
--   docker exec -i f1-postgres psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v web_password="$F1_WEB_PASSWORD" -f - < scripts/sql/0011_web_role.sql
--
-- Vercel's DATABASE_URL is this role, never the owner. The only writes the app performs go
-- through lib/ask/log.ts over ASK_LOG_DATABASE_URL (role f1_ask_log, 0005_roles.sql);
-- everything else in web/ is a SELECT, so this role holds SELECT and nothing else.
--
-- Run AFTER the drizzle migrations (it grants on the tables that exist) and re-run after
-- every later migration; scripts/neon_migrate.sh does both. Idempotent: CREATE-or-ALTER
-- chosen at runtime, every GRANT re-asserted, the password rotated on each run.
--
-- SECURITY NOTE (same as 0005_roles.sql §1.0): the GRANT is the control.
-- default_transaction_read_only / statement_timeout are USERSET and defence in depth only.

\set ON_ERROR_STOP on

\if :{?web_password}
\else
\set web_password ''
\endif

BEGIN;

SET LOCAL app.web_pw = :'web_password';

DO $guard$
BEGIN
  IF length(current_setting('app.web_pw')) < 8 THEN
    RAISE EXCEPTION
      'pass -v web_password=<secret> (>= 8 chars). See docs/RUNBOOK.md section 9.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The role. NOINHERIT so a future group grant never reaches it; CONNECTION LIMIT 20
--    sized for the pooled endpoint (each serverless instance holds a small pool).
-- ---------------------------------------------------------------------------
DO $web_role$
DECLARE
  flags text := 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS '
                'CONNECTION LIMIT 20';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1_web') THEN
    -- A managed host may let this role be CREATED but not ALTERED on a later run (Neon:
    -- 'permission denied to alter role'). Attempt it; on refusal say so and continue to the
    -- grants below, which are the part a re-run exists to re-assert.
    BEGIN
      EXECUTE format('ALTER ROLE f1_web WITH LOGIN PASSWORD %L %s',
                   current_setting('app.web_pw'), flags);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'f1_web: exists and cannot be altered here (password unchanged)';
    END;
  ELSE
    EXECUTE format('CREATE ROLE f1_web LOGIN PASSWORD %L %s',
                   current_setting('app.web_pw'), flags);
  END IF;
END
$web_role$;

SELECT format('GRANT CONNECT ON DATABASE %I TO f1_web', current_database()) \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM f1_web', current_database()) \gexec

-- ---------------------------------------------------------------------------
-- 2. What it can read: every table in public, now and in the future. The default
--    privilege is recorded for the role applying this file (the owner that runs
--    migrations), so a table created by a later drizzle migration is readable at once.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO f1_web;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO f1_web;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO f1_web;

-- The ask log holds visitor-submitted question text and IP hashes. Nothing in web/ reads
-- it over DATABASE_URL (lib/ask/log.ts uses ASK_LOG_DATABASE_URL), so the blanket SELECT
-- above is withdrawn from these two tables. A future page that needs them must say so here.
REVOKE ALL ON ask_query_log    FROM f1_web;
REVOKE ALL ON ask_answer_cache FROM f1_web;

-- USAGE on `ask` so `npm run db:smoke` can count the generated views over this role; the
-- footer reads nothing there and no SELECT on the views is granted.
GRANT USAGE ON SCHEMA ask TO f1_web;

-- `db:smoke` also counts drizzle.__drizzle_migrations; read-only, guarded because the
-- schema exists only once db:migrate has run.
SELECT 'GRANT USAGE ON SCHEMA drizzle TO f1_web' WHERE EXISTS
  (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')
\gexec
SELECT 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO f1_web' WHERE EXISTS
  (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')
\gexec

-- ---------------------------------------------------------------------------
-- 3. Defence in depth (not controls). Role-level SET survives transaction pooling
--    because it is applied when the server connection starts.
-- ---------------------------------------------------------------------------
ALTER ROLE f1_web SET default_transaction_read_only = on;
ALTER ROLE f1_web SET search_path = 'public';
ALTER ROLE f1_web SET statement_timeout = '10s';
ALTER ROLE f1_web SET lock_timeout = '2s';
ALTER ROLE f1_web SET idle_in_transaction_session_timeout = '15s';

COMMIT;

\echo '0011_web_role.sql applied. Now run: scripts/db_ask_verify.sh <owner DSN>'
