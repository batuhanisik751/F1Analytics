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

# db-ask-verify is the deploy gate of MODE3_SPEC §9 WP-2; the 34 assertions live in
# scripts/db_ask_verify.sh (OPS_SPEC §4.2 / F11) so the same gate runs against any DSN
# without make. ASK_PASSWORD is needed for the protocol-rail check even locally.
db-ask-verify:
	@ASK_PASSWORD=$(ASK_PASSWORD) scripts/db_ask_verify.sh postgres://f1:f1@localhost:5432/f1

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
