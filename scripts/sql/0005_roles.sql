-- scripts/sql/0005_roles.sql — MODE3_SPEC §1.1, run ONCE by the operator as `f1`.
--
--   make db-ask-roles ASK_PASSWORD=... ASK_LOG_PASSWORD=...
--
-- drizzle-kit neither generates nor tracks CREATE ROLE, and pretending otherwise is how a
-- migration silently diverges from the database. This file is therefore hand-written, applied
-- by the operator, and verified by `make db-ask-verify` (a non-zero exit blocks deploy).
--
-- Run it AFTER `make db-ask-views` on a fresh machine (§6.4): step 2 below grants SELECT on
-- every table in schema `ask`, and that schema must already hold the generated views.
--
-- Idempotent: every statement is either IF EXISTS / IF NOT EXISTS guarded or a CREATE-or-ALTER
-- pair chosen by a \gexec. Re-running it rotates both passwords and re-asserts every setting.
--
-- SECURITY NOTE — what is and is not a control (§1.0):
--   the GRANT is the boundary. `default_transaction_read_only`, `statement_timeout` and
--   `search_path` below are USERSET GUCs that the session itself can change
--   (`BEGIN READ WRITE` escapes the first; `set_config('statement_timeout','0',false)` the
--   second) and are defence in depth ONLY. f1_ask holds no grant at all in schema public,
--   which is the property the whole feature rests on.

\set ON_ERROR_STOP on

-- Both passwords are psql variables, interpolated client-side. They are never defaulted:
-- a missing one raises below and the file applies nothing (\quit would exit 0 and look like
-- a success, which is exactly the provisioning mistake §1.1's startup assertion exists for).
\if :{?ask_password}
\else
\set ask_password ''
\endif
\if :{?ask_log_password}
\else
\set ask_log_password ''
\endif

BEGIN;

-- Carried as transaction-local GUCs so the CREATE/ALTER below can be chosen at runtime by a
-- DO block (psql does not interpolate :'var' inside a dollar-quoted body). SET LOCAL means
-- both values disappear at COMMIT.
SET LOCAL ask.pw     = :'ask_password';
SET LOCAL ask.log_pw = :'ask_log_password';

DO $guard$
BEGIN
  IF length(current_setting('ask.pw')) < 8 OR length(current_setting('ask.log_pw')) < 8 THEN
    RAISE EXCEPTION
      'pass -v ask_password=<secret> -v ask_log_password=<secret> (>= 8 chars). See docs/RUNBOOK.md section 8.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 0. Close the PUBLIC defaults. These are FROM PUBLIC, not FROM the role:
--    measured live, PUBLIC holds CONNECT+TEMPORARY on database f1 ({=Tc/f1,…})
--    and USAGE on schema public ({…,=U/pg_database_owner}); a role-scoped
--    REVOKE cannot touch either.
-- ---------------------------------------------------------------------------
-- The two database-level REVOKEs are guarded (OPS_SPEC §4.2, §8 risk 3): on a managed
-- host the `postgres` database is not visible and the bare statement would abort the whole
-- file under ON_ERROR_STOP, leaving every PUBLIC grant below in place. When the database is
-- absent the guard raises a NOTICE so the skip is on the record, never silent.
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = 'f1')
  THEN 'REVOKE ALL ON DATABASE f1 FROM PUBLIC'
  ELSE $n$DO $b$ BEGIN RAISE NOTICE '0005_roles: database "f1" not visible here; its PUBLIC REVOKE was skipped'; END $b$$n$
END
\gexec
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = 'postgres')
  THEN 'REVOKE ALL ON DATABASE postgres FROM PUBLIC'   -- closes cross-database CONNECT
  ELSE $n$DO $b$ BEGIN RAISE NOTICE '0005_roles: database "postgres" not visible here; its PUBLIC REVOKE was skipped'; END $b$$n$
END
\gexec
REVOKE ALL ON SCHEMA public      FROM PUBLIC;   -- removes =U/pg_database_owner
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
-- f1 owns the database and schema and keeps everything via pg_database_owner.

-- ---------------------------------------------------------------------------
-- 0b. Drop the design-phase leftovers (§0.4): the judge_sec_probe role and the
--     two throwaway views it was granted. Views hold no data.
-- ---------------------------------------------------------------------------
DROP SCHEMA IF EXISTS judge_ask_probe CASCADE;
SELECT 'DROP OWNED BY judge_sec_probe' WHERE EXISTS
  (SELECT 1 FROM pg_roles WHERE rolname = 'judge_sec_probe')
\gexec
SELECT 'DROP ROLE judge_sec_probe' WHERE EXISTS
  (SELECT 1 FROM pg_roles WHERE rolname = 'judge_sec_probe')
\gexec

-- ---------------------------------------------------------------------------
-- 1. The read-only query role. NOINHERIT so it can never pick up a future grant
--    made to a group; CONNECTION LIMIT 4 against askPool.max = 2.
-- ---------------------------------------------------------------------------
DO $ask_role$
DECLARE
  flags text := 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS '
                'CONNECTION LIMIT 4';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1_ask') THEN
    EXECUTE format('ALTER ROLE f1_ask WITH LOGIN PASSWORD %L %s',
                   current_setting('ask.pw'), flags);
  ELSE
    EXECUTE format('CREATE ROLE f1_ask LOGIN PASSWORD %L %s',
                   current_setting('ask.pw'), flags);
  END IF;
END
$ask_role$;

GRANT CONNECT ON DATABASE f1 TO f1_ask;

-- 2. It can see EXACTLY ONE schema, and that schema contains only views (§1.2).
--    It is never granted USAGE on public, so no base table is reachable by name.
GRANT USAGE ON SCHEMA ask TO f1_ask;
GRANT SELECT ON ALL TABLES IN SCHEMA ask TO f1_ask;   -- re-run by the generator; ask holds
                                                      -- only generated views, nothing else
-- No ALTER DEFAULT PRIVILEGES anywhere: a view added to `ask` by hand is not queryable
-- until scripts/gen_ask_schema.py regenerates and its enumerated GRANT is re-run.

-- 3. Defence in depth only — none of these is counted as a control (§1.0, §1.7).
ALTER ROLE f1_ask SET default_transaction_read_only = on;
ALTER ROLE f1_ask SET search_path = 'ask';        -- NOT public; pg_catalog is implicit and
                                                  -- cannot be removed, hence gate 4 in §1.3
ALTER ROLE f1_ask SET statement_timeout = '4s';
ALTER ROLE f1_ask SET lock_timeout = '1s';
ALTER ROLE f1_ask SET idle_in_transaction_session_timeout = '8s';
ALTER ROLE f1_ask SET work_mem = '16MB';
ALTER ROLE f1_ask SET temp_file_limit = 0;
ALTER ROLE f1_ask SET jit = off;
REVOKE TEMPORARY ON DATABASE f1 FROM f1_ask;      -- redundant after step 0; harmless

-- ---------------------------------------------------------------------------
-- 4. The log-writer role. The web app must not write attacker-supplied question text
--    over the SUPERUSER pool, which is what every proposal originally did.
-- ---------------------------------------------------------------------------
DO $log_role$
DECLARE
  flags text := 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS '
                'CONNECTION LIMIT 4';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1_ask_log') THEN
    EXECUTE format('ALTER ROLE f1_ask_log WITH LOGIN PASSWORD %L %s',
                   current_setting('ask.log_pw'), flags);
  ELSE
    EXECUTE format('CREATE ROLE f1_ask_log LOGIN PASSWORD %L %s',
                   current_setting('ask.log_pw'), flags);
  END IF;
END
$log_role$;

GRANT CONNECT ON DATABASE f1 TO f1_ask_log;
GRANT USAGE  ON SCHEMA public TO f1_ask_log;      -- needs the base tables by name
GRANT INSERT ON ask_query_log TO f1_ask_log;
GRANT SELECT (asked_at, session_cookie, ip_hash, estimated_cost_usd) ON ask_query_log TO f1_ask_log;
-- DELETE added by WP-10: §3.7's cache path DISCARDS an entry whose stored query no longer
-- validates (a regenerated schema, a tightened gate) and falls through to a fresh answer. With
-- no DELETE the stale entry is re-read and re-rejected on every repeat of that question. A
-- cache row is the one kind of row that must be evictable; this grants nothing else.
GRANT SELECT, INSERT, UPDATE, DELETE ON ask_answer_cache TO f1_ask_log;
GRANT USAGE, SELECT ON SEQUENCE ask_query_log_ask_id_seq TO f1_ask_log;
-- Column-level SELECT is what the three pre-call limit checks of §5.3 need and nothing more:
-- f1_ask_log cannot read back the question text, the generated SQL, or any F1 table.

-- The log role gets the same convenience timeouts. It never runs generated SQL.
ALTER ROLE f1_ask_log SET statement_timeout = '4s';
ALTER ROLE f1_ask_log SET lock_timeout = '1s';
ALTER ROLE f1_ask_log SET idle_in_transaction_session_timeout = '8s';
ALTER ROLE f1_ask_log SET search_path = 'public';
ALTER ROLE f1_ask_log SET jit = off;
REVOKE TEMPORARY ON DATABASE f1 FROM f1_ask_log;

COMMIT;

\echo '0005_roles.sql applied. Now run: make db-ask-verify'
