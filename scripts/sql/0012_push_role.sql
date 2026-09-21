-- scripts/sql/0012_push_role.sql — OPS_SPEC §3.4 / §4.2: the nightly push credential `f1_push`.
--
--   docker exec -i f1-postgres psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v push_password="$F1_PUSH_PASSWORD" -f - < scripts/sql/0012_push_role.sql
--
-- scripts/push_remote.py connects as this role (REMOTE_DATABASE_URL in
-- ~/.config/f1analytics/remote.env, mode 600). It moves session data with DELETE + COPY
-- FROM STDIN inside one transaction and records the push in data_release. That is the
-- whole job, so that is the whole grant:
--   SELECT / INSERT / DELETE on every F1 table in public   (COPY FROM needs INSERT)
--   SELECT / INSERT        on data_release                 (append-only; rows never change)
--   USAGE on data_release_release_id_seq                   (the one nextval it calls)
--   SELECT on drizzle.__drizzle_migrations                 (the "schema behind" check, exit 2)
-- and NO grant of any kind on ask_query_log / ask_answer_cache or their sequence: a
-- compromised laptop can corrupt F1 data (repairable from the nightly snapshot) but cannot
-- read a single visitor question, mint a role, or change a grant. The owner URL is never
-- stored anywhere; it is typed interactively for migrations and these role files only.
--
-- Run AFTER the drizzle migrations and re-run after each later one (scripts/neon_migrate.sh).
-- No ALTER DEFAULT PRIVILEGES: a table added later is unclassified in push_remote.py and
-- refused until this file names it, which is the intended failure.

\set ON_ERROR_STOP on

\if :{?push_password}
\else
\set push_password ''
\endif

BEGIN;

SET LOCAL app.push_pw = :'push_password';

DO $guard$
BEGIN
  IF length(current_setting('app.push_pw')) < 8 THEN
    RAISE EXCEPTION
      'pass -v push_password=<secret> (>= 8 chars). See docs/RUNBOOK.md section 9.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The role. CONNECTION LIMIT 2: one push connection plus one for --verify-only.
-- ---------------------------------------------------------------------------
DO $push_role$
DECLARE
  flags text := 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS '
                'CONNECTION LIMIT 2';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1_push') THEN
    EXECUTE format('ALTER ROLE f1_push WITH LOGIN PASSWORD %L %s',
                   current_setting('app.push_pw'), flags);
  ELSE
    EXECUTE format('CREATE ROLE f1_push LOGIN PASSWORD %L %s',
                   current_setting('app.push_pw'), flags);
  END IF;
END
$push_role$;

GRANT CONNECT ON DATABASE f1 TO f1_push;
REVOKE TEMPORARY ON DATABASE f1 FROM f1_push;
GRANT USAGE ON SCHEMA public TO f1_push;

-- ---------------------------------------------------------------------------
-- 2. The tables. Enumerated from the catalogue at apply time so the exclusion list is
--    the only thing to maintain; the two ask tables are also REVOKEd explicitly so a
--    grant from an older version of this file cannot survive a re-run.
-- ---------------------------------------------------------------------------
SELECT format('GRANT SELECT, INSERT, DELETE ON public.%I TO f1_push', tablename)
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename NOT IN ('ask_query_log', 'ask_answer_cache', 'data_release')
 ORDER BY tablename
\gexec

GRANT SELECT, INSERT ON data_release TO f1_push;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON data_release FROM f1_push;
GRANT USAGE ON SEQUENCE data_release_release_id_seq TO f1_push;

REVOKE ALL ON ask_query_log    FROM f1_push;
REVOKE ALL ON ask_answer_cache FROM f1_push;
REVOKE ALL ON SEQUENCE ask_query_log_ask_id_seq FROM f1_push;
-- No UPDATE anywhere: the push replaces whole sessions (DELETE + COPY) and never edits a row.
-- No TRUNCATE anywhere: a partial truncate is exactly the failure the single transaction
-- and the per-session DELETE are designed to make impossible.

-- The "schema behind" guard reads the migration ledger before writing a row.
SELECT 'GRANT USAGE ON SCHEMA drizzle TO f1_push' WHERE EXISTS
  (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')
\gexec
SELECT 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO f1_push' WHERE EXISTS
  (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')
\gexec

-- ---------------------------------------------------------------------------
-- 3. Session defaults. lock_timeout=30s: a reader holding a conflicting lock for longer
--    than that means something is wrong; the push retries rather than queues behind it.
--    No statement_timeout: a full COPY of laps legitimately runs for minutes.
-- ---------------------------------------------------------------------------
ALTER ROLE f1_push SET lock_timeout = '30s';
ALTER ROLE f1_push SET search_path = 'public';
ALTER ROLE f1_push SET idle_in_transaction_session_timeout = '10min';

COMMIT;

\echo '0012_push_role.sql applied. Now run: scripts/db_ask_verify.sh <owner DSN>'
