# F1 Analytics — developer entry points. See docs/RUNBOOK.md for the full procedure.
#
#   make db                      start Postgres 16 (docker compose) and wait until it is healthy
#   make migrate                 apply the Drizzle migrations (creates drizzle.__drizzle_migrations)
#   make ingest SEASON=2025      ingest every completed, not-yet-ok session of a season
#   make ingest SEASON=2025 ARGS="--round 13"      one round (race + sprint), regardless of status
#   make ingest SEASON=2025 ARGS="--force"         re-ingest every completed session
#   make recompute SEASON=2025   season aggregates only (standings, summaries, H2H)
#   make recompute-hazards       v1.1: rebuild sim_circuit_hazard from every ingested race (no FastF1, ~2 s)
#   make recompute-companion     v1.2: win probability + OTDI + weekend preview (no FastF1, ~4 min)
#   make recompute-companion STEPS=winprob        one step only (winprob | odi | preview | mode2 | all)
#   make recompute-mode2         v1.3: driver-vs-car decomposition, all 12 mode2_* tables (~2.5 min)
#   make recompute-mode2 FORCE=1                  refit even when the window is unchanged
#   make web                     Next.js dev server on http://localhost:3000
#   make build                   typecheck + lint + production build of web/
#   make test                    full pytest suite (needs the database)
#   make test-fast               pytest without the db-marked tests
#   make test-web                v1.1: web engine golden test + simState reducer tests (node:test)
#
#   v1.4 ask box (MODE3_SPEC §6.4) — run in this order on a fresh machine, after `make migrate`:
#   make db-ask-gen              regenerate the three ask artifacts from the manifest + live db
#   make db-ask-check            fail if the committed ask artifacts differ from a regeneration
#   make db-ask-views            apply 0005_ask_views.sql + ask_views_telemetry.sql (schema ask, 64 views)
#   make db-ask-roles            apply scripts/sql/0005_roles.sql  ASK_PASSWORD=.. ASK_LOG_PASSWORD=..
#   make db-ask-verify           the §9 WP-2 security assertion list; non-zero exit BLOCKS DEPLOY
#   make check-invariants        the §0.2 architectural boundary as a build step (7 rules)
#   make verify-ask-ui           render every §8.5 ask-UI state to output/ask_ui/ and assert it
#   make verify-ask-rails        re-measure the four §0 broken rails against the live database
#   make ask-eval                the §3.8 acceptance gate; NEEDS ANTHROPIC_API_KEY, costs money
#
#   v1.7 telemetry (TELEMETRY_SPEC §3.3, §3.4) — READ RUNBOOK §3.13 FIRST: the warm adds
#   ~11 GB to cache/ and refuses to start below 15 GB free.
#   make warm-telemetry             download the Q+SQ ladder (~5 GB, paced, interruptible)
#   make warm-telemetry KINDS="Q SQ R"   add the races (~6 GB more, several sittings)
#   make telemetry                  derive every warmed session from cache; ZERO API calls
#   make telemetry-session SESSION_ID=16041   one session; the 'dropped' recovery command
#   make verify-telemetry           the §7.1 acceptance numbers, reported from the database
#
#   v1.6 qualifying (QUALI_SPEC §7) — after the races of a season are ingested:
#   make ingest-quali SEASON=2024   ingest that season's Q and SQ sessions only (no Mode 2 refit)
#   make backfill-quali             all three seasons' qualifying + the season aggregate, in order
#   make verify-quali               the six §3.12 verification queries (census, outcomes, D4's pin)
#   NOTE: never add ARGS="--force" to a qualifying run unless you mean to refit Mode 2 as well;
#   v1.6 deliberately leaves every mode2_* row untouched (QUALI_SPEC D7).
#
# Uses the project virtualenv at .venv (never the system python) and npm only.

PY      := .venv/bin/python
PIP     := .venv/bin/pip
SEASON  ?= 2025
ARGS    ?=
STEPS   ?= all
DSN     := postgres://f1:f1@localhost:5432/f1

.PHONY: help db db-down db-logs psql setup migrate check-schema ingest ingest-all recompute \
        recompute-hazards recompute-companion recompute-mode2 web build start test test-fast test-web lint \
        typecheck clean db-ask-gen db-ask-check db-ask-views db-ask-roles db-ask-verify \
        ask-eval check-invariants verify-ask-ui verify-ask-rails \
        ingest-quali backfill-quali verify-quali \
        warm-telemetry telemetry telemetry-session verify-telemetry

# --- v1.4 ask box: credentials for the two unprivileged roles ----------------
# These defaults are for the LOCAL docker database only, matching the existing local
# convention (the f1/f1 DSN above). MODE3_SPEC §1.1: the GRANT is the security boundary,
# not the password — but any non-local deployment MUST override both, e.g.
#      make db-ask-roles ASK_PASSWORD="$$(openssl rand -hex 24)" ASK_LOG_PASSWORD="$$(openssl rand -hex 24)"
# and put the resulting DSNs in web/.env.local (gitignored). See docs/RUNBOOK.md §8.
ASK_PASSWORD     ?= f1_ask_local_dev
ASK_LOG_PASSWORD ?= f1_ask_log_local_dev

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

# --- database ---------------------------------------------------------------

db:
	docker compose up -d
	@printf 'waiting for postgres'
	@until docker exec f1-postgres pg_isready -U f1 -d f1 >/dev/null 2>&1; do printf '.'; sleep 1; done
	@echo ' ready at $(DSN)'

db-down:
	docker compose down

db-logs:
	docker compose logs -f postgres

# there is no psql on the host; run SQL inside the container:  make psql SQL="select count(*) from laps"
psql:
	docker exec f1-postgres psql -U f1 -d f1 -c "$(SQL)"

# --- one-time setup ---------------------------------------------------------

setup:
	$(PIP) install -r requirements.txt
	cd web && npm ci

migrate:
	cd web && npm run db:migrate
	cd web && npm run db:smoke

check-schema:
	$(PY) -m f1lab.ingest --check-schema

# --- ingest -----------------------------------------------------------------

ingest:
	$(PY) -m f1lab.ingest --season $(SEASON) $(ARGS)

# --- v1.6 qualifying --------------------------------------------------------
# `--only-quali` selects kind Q and SQ and nothing else, so a run can never disturb a race.
ingest-quali:
	$(PY) -m f1lab.ingest --season $(SEASON) --only-quali --sleep 0 $(ARGS)

# The whole backfill, in the order QUALI_SPEC D5 requires (races first is already true;
# this adds qualifying, then rebuilds season_quali_h2h for each year).
backfill-quali:
	$(PY) -m f1lab.ingest --season 2024 --only-quali --sleep 0
	$(PY) -m f1lab.ingest --season 2025 --only-quali --sleep 0
	$(PY) -m f1lab.ingest --season 2026 --only-quali --sleep 0
	$(PY) -m f1lab.ingest --season 2024 --recompute-season
	$(PY) -m f1lab.ingest --season 2025 --recompute-season
	$(PY) -m f1lab.ingest --season 2026 --recompute-season

# RUNBOOK §3.12's six queries. Read the numbers; this target reports, it does not assert
# (tests/test_quali_integration.py is what fails a build).
verify-quali:
	@echo '--- sessions by kind (expect Q 71 | R 71 | S 18 | SQ 18)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT kind, count(*) FROM sessions GROUP BY 1 ORDER BY 1"
	@echo '--- Q/SQ ingest outcomes (expect ok 77 | partial 1 | failed 1)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT si.status, count(*) FROM session_ingests si JOIN sessions s USING (session_id) WHERE s.kind IN ('Q','SQ') GROUP BY 1 ORDER BY 1"
	@echo '--- a pole-sitter with no time (expect 0) / season CHECKs (expect 0) / unverified segments (expect 3)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT (SELECT count(*) FROM quali_results WHERE position = 1 AND best_s IS NULL) AS poles_without_a_time, (SELECT count(*) FROM season_quali_h2h WHERE a_wins + b_wins <> sessions_counted OR deltas_counted > sessions_counted OR sessions_caveated > sessions_counted) AS season_h2h_violations, (SELECT count(*) FROM quali_segment_times WHERE NOT verified) AS unverified_driver_segments"
	@echo '--- D4 pin: race/sprint laps touched by v1.6 (expect 0)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) WHERE s.kind IN ('R','S') AND (l.deleted OR l.is_push_lap IS NOT NULL)"

# the three seasons the site ships with, most recent first
ingest-all:
	$(PY) -m f1lab.ingest --season 2025 $(ARGS)
	$(PY) -m f1lab.ingest --season 2026 $(ARGS)
	$(PY) -m f1lab.ingest --season 2024 $(ARGS)

recompute:
	$(PY) -m f1lab.ingest --season $(SEASON) --recompute-season

# v1.1 simulator: circuit safety-car priors pooled over every ingested race (SIM_SPEC §3.7)
recompute-hazards:
	$(PY) -m f1lab.ingest --recompute-hazards

# v1.2 race companion: win probability (§1), overtaking difficulty (§3.3) and the weekend
# preview (§3.5). No FastF1 loads. Run it AFTER the last ingest — an ingest cascades that
# session's wp_lap_probability away and the next run then does a full ~3 min refit.
# Title odds and magic numbers are NOT here: they are written by season.recompute
# (`make recompute SEASON=YYYY`), which every `make ingest` run already calls.
recompute-companion:
	$(PY) -m f1lab.ingest --recompute-companion $(STEPS)

# v1.3 driver-vs-car decomposition (MODE2_SPEC §7.4). One REML fit of the whole 2024-26
# window, its bootstrap, the two measured skills, the car ratings and the points replay:
# all twelve mode2_* tables, ~2.5 min, no FastF1. It is the LAST companion step, so
# `make recompute-companion` (STEPS=all) already runs it — this target is the one-step
# form. The step is content-addressed: an unchanged window returns {'skipped': True}
# without refitting, and FORCE=1 refits anyway (the only way to rebuild after editing a
# MODE2_* constant, since that also moves the assumption set).
recompute-mode2:
	$(PY) -m f1lab.ingest --recompute-companion mode2 $(if $(FORCE),--force,)

# --- web --------------------------------------------------------------------

web:
	cd web && npm run dev

typecheck:
	cd web && npm run typecheck

lint:
	cd web && npm run lint

build:
	cd web && npm run typecheck && npm run lint && npm run build

start:
	cd web && npm run start

# --- tests ------------------------------------------------------------------

test:
	$(PY) -m pytest tests -q

test-fast:
	$(PY) -m pytest tests -m "not db" -q

# v1.1: engine parity against tests/fixtures/sim_golden.json + the editor reducer / hash codec.
# The `npm test` glob now also covers lib/ask/, app/api/ask/ and components/ask/ (v1.4).
test-web:
	cd web && npm test && npx tsx --test components/sim/simState.test.ts

# MODE3_SPEC §9.3 WP-7 — the §0.2 boundary as a build step. Fails if a model secret, the
# f1_ask pool, the log pool, a second POST route, the superuser pool inside lib/ask/, a stray
# echarts import or a stale PROMPT_PREFIX_SHA256 appears. Run it in CI next to lint.
check-invariants:
	cd web && npm run check:invariants

# Renders every ask-UI state of §8.5 to output/ask_ui/*.html with inline assertions. No
# server, no key, no database.
verify-ask-ui:
	cd web && npm run verify:ask-ui

# MODE3_SPEC §0 / §1.5 — the four rails that were empirically BROKEN during design, re-measured
# against the live container as f1_ask: BEGIN READ WRITE escapes read-only mode (and the GRANT
# still holds), set_config can zero statement_timeout (and the validator + out-of-band cancel
# stand in for it), the unnamed node-postgres query forms run both statements of a
# multi-statement string (and execute.ts only ever uses a NAMED prepare), and a DELETE-CTE
# parses as one SelectStmt (and dies at gate 3). Writes nothing. Needs ASK_DATABASE_URL.
verify-ask-rails:
	cd web && set -a && . ./.env.local && set +a && \
	  npx tsx --tsconfig tsconfig.json scripts/verify-ask-rails.mts

# MODE3_SPEC §3.8 — the twelve acceptance questions, through the REAL request path (the real
# validator, the real f1_ask role, the real database). NEEDS ANTHROPIC_API_KEY in the
# environment; exits 3 with an explanation when there is none. Costs real money.
#
#   make ask-eval                       the twelve standing questions (the ship gate)
#   make ask-eval ASK_EVAL_ARGS="--tier all"     + the six extended refusal questions
#   make ask-eval ASK_EVAL_ARGS="--matrix"       §9.4 item 4's 48-call sweep, ~$2.50
#   make ask-eval ASK_EVAL_ARGS="--check-only"   validate the catalogue only; no key needed
#
# CHANGED THE PROMPT? ASK_INSTRUCTIONS, schema-doc.txt or the model constant — re-run this
# before shipping. Results land in output/ask_eval/latest.json.
ask-eval:
	$(PY) tests/ask/run_acceptance.py $(ASK_EVAL_ARGS)

clean:
	rm -rf web/.next web/.next-* .pytest_cache
	find . -name __pycache__ -type d -prune -not -path './.venv/*' -not -path './web/node_modules/*' -exec rm -rf {} +

# --- v1.4 ask box (MODE3_SPEC §6.4) -----------------------------------------
# Order on a fresh machine: migrate -> db-ask-views -> db-ask-roles -> db-ask-verify.
# db-ask-views must run BEFORE db-ask-roles (its GRANT SELECT ON ALL TABLES IN SCHEMA ask
# needs the views to exist), and must be re-run AFTER db-ask-roles the first time so the
# generator's enumerated GRANT lands (it skips with a NOTICE while f1_ask does not exist).

db-ask-gen:
	$(PY) scripts/gen_ask_schema.py

db-ask-check:
	$(PY) scripts/gen_ask_schema.py --check

db-ask-views:
	docker exec -i f1-postgres psql -U f1 -d f1 -v ON_ERROR_STOP=1 -f - < scripts/sql/0005_ask_views.sql
	@echo 'TELEMETRY_SPEC 2.6 - asserting the v1.7 boundary and invalidating ask_answer_cache'
	docker exec -i f1-postgres psql -U f1 -d f1 -v ON_ERROR_STOP=1 -f - < scripts/sql/ask_views_telemetry.sql

db-ask-roles:
	docker exec -i f1-postgres psql -U f1 -d f1 -v ON_ERROR_STOP=1 \
	  -v ask_password=$(ASK_PASSWORD) -v ask_log_password=$(ASK_LOG_PASSWORD) \
	  -f - < scripts/sql/0005_roles.sql
	@echo 're-applying the generated enumerated GRANT now that f1_ask exists'
	@docker exec -i f1-postgres psql -U f1 -d f1 -q -v ON_ERROR_STOP=1 -f - < scripts/sql/0005_ask_views.sql > /dev/null

# db-ask-verify is the deploy gate of MODE3_SPEC §9 WP-2. Every line runs against the live
# database as the unprivileged role it is about; a non-zero exit BLOCKS DEPLOY. It leaves no
# rows behind (the two write probes run inside a transaction that is rolled back).
define ASK_RAIL_JS
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.ASK_DATABASE_URL });
await c.connect();
let bad = 0;
const multi = "select 1; select 2";
const loose = [
  ["bare string", multi],
  ["{text}", { text: multi }],
  ["{text,values:[]}", { text: multi, values: [] }],
  ["{text,rowMode}", { text: multi, rowMode: "array" }],
  ["{text,values:[],name:undefined}", { text: multi, values: [], name: undefined }],
];
for (const [label, q] of loose) {
  const r = await c.query(q).catch((e) => e);
  const ran = Array.isArray(r) ? r.length : r instanceof Error ? 0 : 1;
  if (ran === 2) { console.log("  ok    " + label + " runs BOTH statements - the rail is needed"); }
  else { bad++; console.log("  FAIL  " + label + " did not run both (" + ran + ")"); }
}
const named = await c.query({ name: "rail_x", text: multi, values: [] }).catch((e) => e);
if (named instanceof Error && /cannot insert multiple commands/.test(named.message)) {
  console.log("  ok    {name,text,values:[]} raises: " + named.message);
} else { bad++; console.log("  FAIL  named prepared statement did not reject a multi-statement"); }
const a = await c.query({ name: "rail_e_1", text: "EXPLAIN (FORMAT JSON, COSTS ON) select 1", values: [], rowMode: "array" }).catch((e) => e);
const b = await c.query({ name: "rail_x_1", text: "select 1", values: [], rowMode: "array" }).catch((e) => e);
if (!(a instanceof Error) && !(b instanceof Error)) { console.log("  ok    two differently-named prepares of different text both succeed"); }
else { bad++; console.log("  FAIL  ask_e_/ask_x_ pair: " + (a.message || b.message)); }
await c.end();
process.exit(bad === 0 ? 0 : 1);
endef
export ASK_RAIL_JS

define ASK_VERIFY_SH
set -u
PSQL="docker exec f1-postgres psql -X -q -tA -d f1"
ASK_DSN="postgres://f1_ask:$(ASK_PASSWORD)@localhost:5432/f1"
fail=0
pass=0
chk() {
  label="$$1"; want="$$2"; shift 2
  out="$$("$$@" 2>&1)" || true
  if printf '%s' "$$out" | grep -qF -- "$$want"; then
    pass=$$((pass+1)); printf '  ok    %s\n' "$$label"
  else
    fail=$$((fail+1))
    printf '  FAIL  %s\n          expected substring: %s\n          got: %s\n' \
      "$$label" "$$want" "$$(printf '%s' "$$out" | head -3 | tr '\n' ' ')"
  fi
}
echo 'as f1_ask - the role that runs generated SQL'
chk 'ask.laps is readable'                  '1'   $$PSQL -U f1_ask -c 'SELECT 1 FROM ask.laps LIMIT 1'
chk 'public.laps is denied'                 'permission denied for schema public' \
                                                  $$PSQL -U f1_ask -c 'SELECT 1 FROM public.laps'
chk 'current_user is f1_ask, not super'     'f1_ask|f' \
    $$PSQL -U f1_ask -c 'SELECT current_user, usesuper FROM pg_user WHERE usename = current_user'
chk 'no USAGE on schema public'             'f'   $$PSQL -U f1_ask \
    -c "SELECT has_schema_privilege(current_user,'public','USAGE')"
chk 'no table grant in public at all'       '0'   $$PSQL -U f1_ask \
    -c "SELECT count(*) FROM information_schema.table_privileges WHERE grantee = current_user AND table_schema = 'public'"
chk 'ingest_runs denied'                    'permission denied for schema public' \
                                                  $$PSQL -U f1_ask -c 'SELECT * FROM public.ingest_runs'
chk 'ask_query_log denied'                  'permission denied for schema public' \
                                                  $$PSQL -U f1_ask -c 'SELECT * FROM public.ask_query_log'
chk 'race_report denied'                    'permission denied for schema public' \
                                                  $$PSQL -U f1_ask -c 'SELECT * FROM public.race_report'
chk 'INSERT into ask_query_log denied'      'permission denied for schema public' \
    $$PSQL -U f1_ask -c "INSERT INTO public.ask_query_log (session_cookie,ip_hash,question,question_norm,validator_verdict,outcome) VALUES ('v','v','v','v','v','v')"
chk 'CREATE TABLE denied even in a READ WRITE txn' 'permission denied for schema public' \
    $$PSQL -U f1_ask -c 'BEGIN READ WRITE; CREATE TABLE public.t_probe(i int); COMMIT'
chk 'CREATE TABLE in ask denied'            'permission denied for schema ask' \
    $$PSQL -U f1_ask -c 'SET default_transaction_read_only=off' -c 'CREATE TABLE ask.t_probe(i int)'
chk 'CREATE SCHEMA denied'                  'permission denied for database f1' \
    $$PSQL -U f1_ask -c 'SET default_transaction_read_only=off' -c 'CREATE SCHEMA evil'
chk 'pg_read_file denied'                   'permission denied for function pg_read_file' \
                                                  $$PSQL -U f1_ask -c "SELECT pg_read_file('/etc/passwd')"
chk 'cannot connect to database postgres'   'permission denied for database "postgres"' \
    docker exec f1-postgres psql -X -q -tA -U f1_ask -d postgres -c 'SELECT 1'
# The security property is that the SERVER cancels the statement, which the error text
# proves. The old assertion also required the whole `docker exec` + psql round trip to
# finish in 6s wall clock, which made it flaky under load (observed 2026-09-15: the rail
# fired correctly and the round trip took 37s because the machine was busy, so a passing
# rail was reported as DEPLOY BLOCKED). Wall clock is now measured SERVER-SIDE over the
# statement itself, so process startup cannot fail a working rail.
sleepout="$$($$PSQL -U f1_ask -c '\timing on' -c 'SELECT pg_sleep(10)' 2>&1 || true)"
elapsed_ms="$$(printf '%s' "$$sleepout" | sed -n 's/^Time: \([0-9]*\)\..*/\1/p' | tail -1)"
if printf '%s' "$$sleepout" | grep -qF 'canceling statement due to statement timeout' \
   && [ -n "$$elapsed_ms" ] && [ "$$elapsed_ms" -le 6000 ]; then
  pass=$$((pass+1)); printf '  ok    pg_sleep(10) cancelled server-side after %sms\n' "$$elapsed_ms"
else
  fail=$$((fail+1)); printf '  FAIL  pg_sleep(10) not cancelled server-side inside 6000ms (%sms): %s\n' "$$elapsed_ms" "$$sleepout"
fi

echo 'as f1_ask_log - the role that writes the query log'
chk 'current_user is f1_ask_log, not super' 'f1_ask_log|f' \
    $$PSQL -U f1_ask_log -c 'SELECT current_user, usesuper FROM pg_user WHERE usename = current_user'
chk 'INSERT into ask_query_log succeeds'    'insert_ok' $$PSQL -U f1_ask_log -v ON_ERROR_STOP=1 \
    -c "BEGIN; INSERT INTO ask_query_log (session_cookie,ip_hash,question,question_norm,validator_verdict,outcome) VALUES ('verify','verify','probe','probe','ok','verify_probe'); SELECT 'insert_ok'; ROLLBACK"
chk 'SELECT question denied (column grant)' 'permission denied for table ask_query_log' \
                                                  $$PSQL -U f1_ask_log -c 'SELECT question FROM ask_query_log LIMIT 1'
chk 'SELECT * on ask_query_log denied'      'permission denied for table ask_query_log' \
                                                  $$PSQL -U f1_ask_log -c 'SELECT * FROM ask_query_log LIMIT 1'
chk 'the four granted columns are readable' '0' $$PSQL -U f1_ask_log \
    -c "SELECT count(*) FROM ask_query_log WHERE session_cookie = 'no_such_cookie' AND asked_at > now() AND ip_hash = '' AND estimated_cost_usd IS NULL"
chk 'DELETE from ask_query_log denied'      'permission denied for table ask_query_log' \
                                                  $$PSQL -U f1_ask_log -c "DELETE FROM ask_query_log WHERE outcome = 'verify_probe'"
chk 'ask_answer_cache is read/write'        'cache_rw_ok' $$PSQL -U f1_ask_log -v ON_ERROR_STOP=1 \
    -c "BEGIN; INSERT INTO ask_answer_cache (question_key,question_norm,prefix_sha256,payload) VALUES ('vp','vp','vp','{}'::jsonb); UPDATE ask_answer_cache SET hit_count = hit_count + 1 WHERE question_key = 'vp'; SELECT 'cache_rw_ok' FROM ask_answer_cache WHERE question_key = 'vp'; ROLLBACK"
chk 'F1 tables denied'                      'permission denied for table laps' \
                                                  $$PSQL -U f1_ask_log -c 'SELECT count(*) FROM laps'
chk 'schema ask denied'                     'permission denied for schema ask' \
                                                  $$PSQL -U f1_ask_log -c 'SELECT 1 FROM ask.laps LIMIT 1'
chk 'cannot connect to database postgres'   'permission denied for database "postgres"' \
    docker exec f1-postgres psql -X -q -tA -U f1_ask_log -d postgres -c 'SELECT 1'

echo 'the rest of the cluster'
chk 'role f1 is unchanged'                  't|t|t|t|t|-1|t' $$PSQL -U f1 \
    -c "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolcanlogin FROM pg_roles WHERE rolname = 'f1'"
chk 'judge_sec_probe is dropped'            '0'   $$PSQL -U f1 \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = 'judge_sec_probe'"
chk 'exactly three login roles'             'f1|f1_ask|f1_ask_log' $$PSQL -U f1 \
    -c "SELECT string_agg(rolname,'|' ORDER BY rolname) FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg\_%'"
chk 'schema ask holds 64 views and nothing else' '64|64' $$PSQL -U f1 \
    -c "SELECT (SELECT count(*) FROM pg_views WHERE schemaname='ask') || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ask')"
chk 'f1_ask is granted all 64 ask objects'  '64'  $$PSQL -U f1 \
    -c "SELECT count(*) FROM information_schema.table_privileges WHERE grantee='f1_ask' AND table_schema='ask' AND privilege_type='SELECT'"
chk 'PUBLIC holds nothing anywhere that matters' '0|0|0' $$PSQL -U f1 -c \
    "SELECT (SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname='f1' AND a.grantee=0) || '|' || (SELECT count(*) FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee=0) || '|' || (SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname='postgres' AND a.grantee=0)"

echo 'the node-postgres protocol rail (MODE3_SPEC section 1.5), against the real pg'
if (cd web && ASK_DATABASE_URL="$$ASK_DSN" node --input-type=module -e "$$ASK_RAIL_JS"); then
  pass=$$((pass+1))
else
  fail=$$((fail+1)); echo '  FAIL  protocol rail'
fi

printf '\n%s passed, %s failed\n' "$$pass" "$$fail"
[ "$$fail" -eq 0 ] || { echo 'DEPLOY BLOCKED - MODE3_SPEC section 9 WP-2 assertions failed'; exit 1; }
endef
export ASK_VERIFY_SH

db-ask-verify:
	@printf '%s\n' "$$ASK_VERIFY_SH" | bash

# ---------------------------------------------------------------------------
# v1.7 telemetry (TELEMETRY_SPEC §3.3, §3.4, §7.1). Two passes, in this order.
#
# READ RUNBOOK §3.13 BEFORE `warm-telemetry`: the warm adds ~11 GB to cache/ (25-150x the
# database growth) and warm_telemetry.py refuses to start below 15 GB free. `--kinds Q SQ`
# alone is ~5 GB and ships the delta trace whole, because T10 gives race sessions no
# cross-driver delta in the first place.
#
# KINDS defaults to the qualifying ladder for exactly that reason. `make warm-telemetry
# KINDS="Q SQ R"` adds the races. TELEMETRY_ARGS passes --budget / --resume / --session.
# ---------------------------------------------------------------------------
KINDS          ?= Q SQ
TELEMETRY_ARGS ?=

warm-telemetry:
	@df -h . | tail -1 | awk '{printf "free on this volume: %s (want >= 15G before a full warm)\n", $$4}'
	$(PY) scripts/warm_telemetry.py --kinds $(KINDS) $(TELEMETRY_ARGS)

# The derive pass. Zero API calls: --require-cache makes that structural, so a derive run
# cannot spend API budget by accident (D12). Safe to re-run; it is the recovery step for
# analytics_status['telemetry'].state = 'dropped'. Narrow with
# TELEMETRY_ARGS="--year 2026 --kind Q"  (f1lab.telemetry spells it --kind, singular).
telemetry:
	$(PY) -m f1lab.telemetry --require-cache $(TELEMETRY_ARGS)

# One session, by session_id. The command every 'dropped' reason string names verbatim.
telemetry-session:
	@test -n "$(SESSION_ID)" || { echo 'usage: make telemetry-session SESSION_ID=16041'; exit 2; }
	$(PY) -m f1lab.telemetry --session $(SESSION_ID) --require-cache $(TELEMETRY_ARGS)

# §7.1's WP-4 row, reported not asserted: the release's own acceptance numbers on the
# reference session. Reads the database only.
verify-telemetry:
	@echo '--- stored laps / summaries / corner speeds, by session (expect one lap per driver)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT s.year, s.round, s.kind, count(DISTINCT lt.driver_id) AS drivers, count(*) AS laps FROM lap_telemetry lt JOIN sessions s USING (session_id) GROUP BY 1,2,3 ORDER BY 1,2,3"
	@echo '--- T5: chord lap-length spread across ALL stored laps of a session.'
	@echo '    NOT the section 7.1 gate, which is the TOP 6 and <= 20 m (measured 8.74 m on'
	@echo '    2026 R13 Q). Over every driver the spread is legitimately larger - slower laps'
	@echo '    take a different line. Read it as a smell test against FastF1 Distance, whose'
	@echo '    spread on the same laps is 111 m.'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT s.year||' R'||s.round||' '||s.kind AS session, round((max(lts.track_length_m) - min(lts.track_length_m))::numeric, 2) AS spread_m FROM lap_telemetry_summary lts JOIN sessions s USING (session_id) GROUP BY 1 ORDER BY 2 DESC"
	@echo '--- D16: drs_distance_m is NULL, never 0, when the channel is flat (expect 0 zeros)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT count(*) FILTER (WHERE drs_distance_m = 0) AS measured_zeros, count(*) FILTER (WHERE drs_distance_m IS NULL) AS no_signal, count(*) AS rows FROM lap_telemetry_summary"
	@echo '--- T8: no session was demoted by a telemetry outcome (expect no non-ok rows here)'
	@docker exec f1-postgres psql -U f1 -d f1 -c "SELECT si.status, si.analytics_status->'telemetry'->>'state' AS telemetry_state, count(*) FROM session_ingests si WHERE si.analytics_status ? 'telemetry' GROUP BY 1,2 ORDER BY 1,2"
