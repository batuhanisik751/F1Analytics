# F1 Analytics — runbook

How to bring the site up from nothing, keep it current, and change things safely.
The contract behind every table, query and page is `docs/SPEC.md`; this file is the
operational side only. Every command below runs from the project root
(`/Users/batuhanisik/Desktop/Projects/F1Analytics`) unless it says otherwise, and every
`make` target has its plain-command equivalent shown next to it.

## 0. Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Docker (compose v2) | any recent | runs Postgres 16 as container `f1-postgres` |
| Node / npm | 22.19 / 10.9 | npm only — `web/package-lock.json` is authoritative |
| Python | 3.13 in `.venv/` | always `.venv/bin/python`, never the system python |
| psql | **not installed on the host** | run SQL with `docker exec f1-postgres psql -U f1 -d f1 -c "<sql>"` or `make psql SQL="<sql>"` |
| Free disk | **≥ 15 GB before the v1.7 telemetry warm** | telemetry adds **~11 GB to `cache/`**, 25–150× the database growth. `scripts/warm_telemetry.py` refuses to start below 15 GB — see §3.13 |

The one connection string, on both sides, is `postgres://f1:f1@localhost:5432/f1`; override it
with `DATABASE_URL` (Python and web read the same variable and both default to that string).

## 1. First run (empty machine → working site)

```bash
# 1. database
docker compose up -d                                  # make db
#    (wait for `docker exec f1-postgres pg_isready -U f1 -d f1`)

# 2. web dependencies + schema (Drizzle Kit owns the DDL; Python never issues CREATE)
cd web && npm ci && npm run db:migrate && cd ..       # make setup && make migrate
#    -> drizzle/0000_init.sql applied; drizzle.__drizzle_migrations has 1 row; 29 tables

# 3. python dependencies + schema check
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m f1lab.ingest --check-schema       # make check-schema  (exit 0 = live schema == f1lab.frames.EXPECTED_COLUMNS)

# 4. ingest, most recent season first (each run is resumable; see §2 for timings)
.venv/bin/python -m f1lab.ingest --season 2025        # make ingest SEASON=2025
.venv/bin/python -m f1lab.ingest --season 2026        # make ingest SEASON=2026
.venv/bin/python -m f1lab.ingest --season 2024        # make ingest SEASON=2024   (optional third season)

# 5. site
cd web && npm run dev                                 # make web   -> http://localhost:3000
```

Sanity checks along the way:

```bash
cd web && npm run db:smoke        # SELECT 1 + row counts of sessions / laps / pace_ranking
make psql SQL="select year, scheduled_rounds, ingested_rounds, standings_after_round from seasons order by year"
make psql SQL="select s.year, count(*) filter (where si.status='ok') ok, count(*) filter (where si.status='partial') partial, count(*) filter (where si.status='failed') failed, count(*) filter (where si.session_id is null) pending from sessions s left join session_ingests si using(session_id) group by 1 order by 1"
```

Expected at the time of writing (2026-09-11): 2024 30 ok, 2025 30 ok, 2026 18 ok + 11 pending
(rounds 14–23 have not happened yet); `seasons` shows 24/24/24, 24/24/24 and 23/13/13.

Production build instead of the dev server: `cd web && npm run build && npm run start`
(`make build` runs typecheck + lint + build first).

## 2. What an ingest run does, and how long it takes

`python -m f1lab.ingest --season YEAR`:

1. `assert_schema` — refuses to run unless the live schema equals `frames.EXPECTED_COLUMNS`
   and `drizzle.__drizzle_migrations` exists (exit 2).
2. Records the current modelling assumptions (`assumption_sets`, see §4) and opens an
   `ingest_runs` row.
3. Pulls the season schedule from FastF1 and upserts `seasons`, `events` and one `sessions`
   row per round for kind `R` **and kind `Q`**, plus one each for `S` and `SQ` on sprint
   weekends. Rounds in the future get a row and nothing else — the site shows them as *not yet
   ingested*.
4. Selects every session whose `start_utc + 6 h < now` and whose `session_ingests.status` is
   not already `ok`, in round order, by kind rank `{R: 0, S: 1, Q: 2, SQ: 3}` — races first,
   so an existing round's log diff stays additive. `Q` and `SQ` load with `messages=True`
   (they need race-control messages for segment boundaries and deletions); **`R` and `S` stay
   at `messages=False`**, pinned by a test. For each: load from `cache/` (or
   download, with 10/30/90 s backoff), compute every analytic in memory, then in ONE
   transaction delete the session's child rows, COPY the new ones and write the
   `session_ingests` row (`ok`, or `partial` when an analytic failed — the reason lands in
   `analytics_status` and the race page shows it). A crash leaves the previous data intact.
5. `season.recompute(year)` rewrites standings, driver summaries and teammate H2H for the year.

Exit codes: `0` every attempted session ok, `1` some session failed (logged, retried next
run), `2` aborted (FastF1 rate limit or schema mismatch — rerun later, it resumes).

Observed wall times (M-series Mac, FastF1 3.8.3, `cache/` warm):

| Command | Sessions | Wall time |
|---|---|---|
| `--season 2025` (races cached, 6 sprints downloaded) | 30 | 2 min 08 s |
| `--season 2026` (races cached, 5 sprints downloaded) | 18 | 1 min 21 s |
| `--season 2024` (races cached, 6 sprints downloaded) | 29 | 2 min 01 s |
| `--season 2025 --force` (everything cached) | 30 | 1 min 20 s |
| `--season 2026 --dry-run` | 18 | ~55 s |
| `--recompute-season`, `--check-schema` | – | ~2 s |

**v1.6 qualifying (`--only-quali` / `--no-quali`).** The backfill that first populated the
89 qualifying sessions:

| Command | Sessions | Wall time |
|---|---|---|
| `--season 2024 --only-quali --sleep 0` | 30 | 3 min 39 s |
| `--season 2025 --only-quali --sleep 0` | 30 | 2 min 29 s |
| `--season 2026 --only-quali --sleep 0` | 19 | 1 min 40 s |

Per session, load + compute + write is **0.5–1.3 s**; almost all the wall time above is the
per-run season / sim / companion recompute that follows. The backfill needed **no network**
and made **zero** FastF1 API calls against the warmed cache. `--only-quali` skips the Mode 2
refit (`mode2: skipped=True`) — **do not add `--force` to a qualifying run** unless you mean
to refit Mode 2, which v1.6 deliberately does not do. Re-running `--only-quali` after a
successful backfill reports `0 sessions to ingest`: a session already `ok` is skipped, and
only `failed` / `partial` rows are retried. To genuinely re-ingest one session, name it:
`--season 2024 --round 21 --only-quali`.

A cached race is 3–4 s end to end; an uncached race adds about a minute of download the
first time. The default `--sleep 2` between loads is deliberate — the live-timing API is
unofficial and rate limited. To pre-download everything: `.venv/bin/python scripts/warm_cache.py --sprints 2025 2026`.

## 3. Day-to-day operations

**After a race weekend** — the same command picks up only the new round(s):

```bash
.venv/bin/python -m f1lab.ingest --season 2026          # make ingest SEASON=2026
```
The race appears on `/`, `/season/2026` and `/race/2026/<round>` on the next request; the
dev server needs no restart (every page is `force-dynamic`). If FastF1 has no timing data yet
the session is recorded as `failed` with `no timing data available …` (the race page shows
*data unavailable* with that text) and retried automatically on the next run.

**Re-ingest one round** (both its race and its sprint, regardless of current status):

```bash
.venv/bin/python -m f1lab.ingest --season 2025 --round 13     # make ingest SEASON=2025 ARGS="--round 13"
```

**Re-ingest a whole season** (`--force` = every completed session, ignoring status):

```bash
.venv/bin/python -m f1lab.ingest --season 2025 --force        # make ingest SEASON=2025 ARGS="--force"
```
Ingest is idempotent: `sessions.session_id` is stable, child rows are replaced inside one
transaction, and a forced re-run reproduces every row bit-for-bit (only `ingest_runs` grows).

**Recompute season aggregates only** (no FastF1, ~2 s) — after hand edits or when standings look stale:

```bash
.venv/bin/python -m f1lab.ingest --season 2025 --recompute-season    # make recompute SEASON=2025
```

**Recompute the simulator's safety-car priors only** (v1.1; no FastF1, ~2 s) — pools every
ingested race into `sim_circuit_hazard`. Every season/round run already does this at its end,
so it is only needed after deleting or hand-editing rows:

```bash
.venv/bin/python -m f1lab.ingest --recompute-hazards          # make recompute-hazards
```

**Other flags:** `--no-sprints` (skip kind `S`), `--dry-run` (load + compute, print per-table
row counts, write nothing — needs no database), `--fail-fast` (stop at the first failed
session), `--dsn URL`, `--cache PATH`, `--sleep SECONDS`.

**Tests:**

```bash
make test-fast     # .venv/bin/python -m pytest tests -m "not db" -q   (cached sessions only)
make test          # .venv/bin/python -m pytest tests -q               (needs the migrated DB; re-ingests 2024 R13 a few times)
make test-web      # cd web && npm test && npx tsx --test components/sim/simState.test.ts   (v1.1 engine parity + editor reducer)
```

### 3.7 v1.1 simulator: recompute procedure (SIM_SPEC §3.7)

The strategy simulator on `/race/[year]/[round]` reads four `sim_*` tables written by
`f1lab.sim` inside the normal ingest (guard key `sim` in `analytics_status`). To (re)build them:

1. `cd web && npm run db:migrate` (migration `0001_sim`) → `python -m f1lab.ingest --check-schema` exits 0.
2. `--season 2025 --force`, `--season 2026 --force`, `--season 2024 --force` (≈ 1 min each from
   cache). None of the per-session `sim_*` rows depends on another session, so the order does not
   change a row; each run ends with `season.recompute` and `sim.recompute_hazards`.
3. `--round N` runs refresh `sim_circuit_hazard` automatically; `--recompute-hazards` refreshes
   it without loads.
4. Races with no model are expected: rain races (`sim: error: SimNotEstimable: rain race …`)
   and races with fewer than two slick compounds on 30+ clean laps. `status='partial'` with only
   the `sim` key non-ok is the documented outcome, not a failure — the race page shows the
   reason in the simulator's empty state and every other section is unaffected.
5. Races ingested before v1.1 have no `sim` key at all; the section says *re-ingest with --force*.

### 3.8 v1.1 simulator: the review fixes an operator has to know about (SIM_SPEC §10.5)

1. **SC/VSC pit-factor band.** A per-race factor is measured from as few as three stops and can
   come out implausible. `f1lab/config.py` holds `SIM_PIT_FACTOR_MIN = 0.3` /
   `SIM_PIT_FACTOR_MAX = 1.3`; a race factor outside the band is **dropped** (stored as NULL,
   so the race → circuit → pooled → prior chain supplies the value) and a line is written to
   `session_ingests.warnings`, e.g. *sim: SC pit factor -0.45 from 13 stops out of range
   [0.3, 1.3], using pooled*. This is expected on a handful of races, not a failure. To audit
   after an ingest:

   ```sql
   select session_id, sc_pit_factor_race, vsc_pit_factor_race from sim_race_params
    where (sc_pit_factor_race  is not null and sc_pit_factor_race  not between 0.3 and 1.3)
       or (vsc_pit_factor_race is not null and vsc_pit_factor_race not between 0.3 and 1.3);
   -- expect 0 rows; the dropped ones are listed in session_ingests.warnings
   ```

   Widening the band re-admits those races' own factors; it is a constant, so it creates a new
   assumption set and every season must be `--force` re-ingested (§4).

2. **δ_L is centred on its green-lap level.** `sim.lap_deltas` subtracts a 5 % trimmed mean of
   δ over green laps with a known δ (`SIM_DELTA_CENTRE_TRIM`, `SIM_DELTA_CENTRE_MIN_LAPS`)
   before storing `field_delta_s`. Without it the trust badge carried a systematic
   *model optimistic* bias of ≈ +0.06 s per modelled lap. The offset is **folded into the
   stored array** — there is no column for it and it cannot be recovered from the database;
   the only way to see it is to re-run `lap_deltas` without `lap_status`. Changing either
   constant changes every stored δ and every `misfit_rep_s`, so it needs a full three-season
   `--force` re-ingest, not a `--recompute-season`.

3. **Assumption set.** The fixes moved all three seasons from set **116 to 198**. Anything that
   hard-codes 116 (fixtures, dashboards, notes) is stale; `seasons.assumption_set_id` is the
   truth and `mixed_assumption_sets` must be `false` for 2024, 2025 and 2026 after a full
   re-ingest.

4. **Health check after any simulator re-ingest** (all four should hold):

   ```sql
   select count(*) from sim_race_params;                      -- 57 of 61 races
   select count(*) from sim_circuit_hazard;                   -- 24 circuits
   select analytics_status->>'sim', count(*) from session_ingests group by 1;
   -- only 'ok' (57), NULL (17 sprints) and the 4 rain SimNotEstimable reasons;
   -- a KeyError/IndexError/ValueError entry is a bug, not a data limitation
   select year, mixed_assumption_sets, assumption_set_id from seasons order by year;
   ```

5. **Web tests.** `cd web && npm test` runs only `lib/sim/*.test.ts` (22 tests). The editor's
   own suite — the only coverage of the pristine-strategy rule — must be run explicitly:
   `npx tsx --test components/sim/simState.test.ts` (31 tests). Run both before shipping a
   change to `components/sim/`.

6. **Real strategies outside the editor limits are normal.** 105 of 963 simulable driver-races
   have a 1-lap stint (red flag, lap-1 puncture) or more than 4 stops. The editor seeds and
   simulates them as they were raced and shows a muted note; only a user *edit* is held to
   `minStintLaps` / `maxStops`. A red engine error on a pristine strategy is a regression —
   `web/lib/sim/engine.ts` and `web/components/sim/simState.ts` must keep drawing that line at
   the same place (`sameStrategy(edited, actual)`).

### 3.9 v1.2 race companion: `--recompute-companion` (MODE1_SPEC §6.7)

v1.2 added four features — win probability, title odds + magic numbers, the weekend
preview, and race moments + optimal stint length — spread over **fourteen** new tables.
They are written in three different places, and knowing which is which is the whole of
operating them:

| tables | written by | command |
|---|---|---|
| `race_moment`, `optimal_stint` | `build_race_frames`, inside a normal ingest | `--season Y [--round N]` |
| `title_odds`, `title_clinch` | `season.recompute`, at the end of every season run | `--season Y --recompute-season` |
| `wp_*` (6), `circuit_odi`, `preview_*` (3) | the run-end companion step | `--recompute-companion [STEPS]` |

```bash
.venv/bin/python -m f1lab.ingest --recompute-companion            # all three steps   (make recompute-companion)
.venv/bin/python -m f1lab.ingest --recompute-companion winprob    # just the model    (make recompute-companion STEPS=winprob)
.venv/bin/python -m f1lab.ingest --recompute-companion odi,preview
```

No FastF1 loads, no `--season` needed. Every `--season Y` run already calls it at the end,
so it is only needed on its own after deleting rows, after changing a constant, or to settle
the store after an ingest (below).

**ORDER MATTERS — run it after the last ingest.** `session_id` cascades, so ingesting a
session deletes that session's `wp_lap_probability` rows and clears its
`analytics_status.win_probability` key. The race page then correctly shows *win probability
has not been recomputed since this race was added*, and the next `--recompute-companion`
does a full cold refit instead of the 1-second short-circuit. The rule is simply: **ingest
everything, then recompute the companion once.**

**Measured wall clock on this machine's data volume** (62 race sessions, 69,468 lap rows),
timed serially with nothing else touching the database:

| step | cold | warm (nothing changed) |
|---|---|---|
| `--recompute-companion winprob` | ~75 s | ~1 s (short-circuit) |
| `--recompute-companion odi` | ~1 s | ~1 s |
| `--recompute-companion preview` | ~2 s | ~2 s |
| `--recompute-companion` (all three) | ~77 s | ~4 s |
| `--season Y --recompute-season` (title odds) | ~90 s per season | — |
| one-season `--force` re-ingest, end to end incl. the above | ~3 min 20 s | — |
| three-season `--force` re-ingest + all of the above | ~12 min | — |

`odi` and `preview` are DELETE-then-INSERT every time and have no short-circuit; only
`winprob` has one.

**These numbers assume you are the only writer.** Measured during v1.2's parallel build,
with three other processes ingesting and running test suites against the same Postgres,
the same steps took `winprob` ~200 s, `odi` ~10 s, `preview` ~35 s — roughly 3× — and a
full `pytest` run went from minutes to over 40. If a recompute is inexplicably slow, check
`select pid, state, wait_event_type, left(query,60) from pg_stat_activity where datname =
'f1'` for another session sitting `idle in transaction` before you suspect the model.

Most of `winprob`'s cold time is the **isotonic** variants (~80% of the ~251 estimator
fits). They exist only to keep §1.7's negative result — isotonic calibration is *worse*
here, so `WP_CALIBRATION` is `"none"` — re-checkable on demand. They are not on any read
path.

### 3.10 v1.2: the model artifact, and how to retrain it

The win-probability model is the only thing in this project that is *fitted and stored as
bytes*. It lives in two tables:

- **`wp_run`** — one row per `(assumption_set_id, model_version)`, carrying the Brier scores,
  the baselines, `skill_ok`, the scikit-learn version and a partial unique index that keeps
  exactly one row flagged `is_current` per assumption set. Every web query resolves this row
  first; if it is missing, every win-probability panel renders its empty state.
- **`wp_model_artifact`** — eleven `bytea` blobs per run: ten fold models (`fold_index` 0–9)
  and the full-data model (`fold_index = -1`). Roughly 64 KB each.

`model_version` is `wp-<assumption_set_id>-<blake2s of the sorted race-key list>`, so it
changes when a race is added or removed but **not** when a race's rows are merely re-ingested.

**Retrain** — there is one command, and it decides for itself:

```bash
.venv/bin/python -m f1lab.ingest --recompute-companion winprob
```

It refits when the race-key set changed, when `wp_lap_probability` is incomplete (the usual
case, after an ingest cascaded rows away), or when there is no current run. Otherwise it
short-circuits in about a second. There is no `--force` for it and none is needed; deleting
the `wp_run` row forces a cold refit.

**What a retrain does**, in order (MODE1_SPEC §6.3): builds the feature frame from the whitelist
in `config.WP_ALLOWED_RESULT_COLUMNS`; assigns each race to one of ten folds by
`(year*100 + round) % 10`; fits ten fold models and predicts each race **out of fold**;
normalises within a lap so every lap's probabilities sum to 1; scores `loro`, `loco`, the
2024+2025 → 2026 forward split and the leaked in-sample variant into `wp_metrics`; fits the
full-data model; upserts `wp_run`; writes 68,363 `wp_lap_probability` rows, the swings, the
metrics and the reliability bins.

**The two guard rails**, both enforced in code and worth knowing before you distrust a number:

1. A DB `CHECK` forbids anything but `pred_kind = 'oof'` in `wp_lap_probability` (FD2). The
   full-data model physically cannot reach the chart table.
2. `skill_ok` is false when the model fails to beat a positional lookup baseline. The section
   then refuses to render the river at all, rather than showing a chart nobody should trust.

**Health check after a retrain:**

```sql
select model_version, n_train_races, brier_oof, brier_baseline_pos, skill_ok, sklearn_version
  from wp_run where is_current;                                  -- exactly one row
select count(*), count(distinct session_id) from wp_lap_probability;  -- 68363 over 61 sessions
select max(abs(s - 1)) from (select sum(p_win) s from wp_lap_probability
  group by session_id, lap_number) x;                            -- < 1e-9
select count(*) from session_ingests
  where analytics_status->>'win_probability' = 'ok';              -- 61
```

If `sklearn_version` in `wp_run` no longer matches the installed scikit-learn, the artifacts
are not trusted and the section says so; `pip install -r requirements.txt` (which pins
`scikit-learn==1.7.2`, `joblib==1.5.2`) and retrain.

### 3.11 v1.3 driver-vs-car decomposition: `--recompute-companion mode2` (MODE2_SPEC §7.4)

v1.3 fits one model of the whole 2024–2026 window — driver effects, car effects, in-season
development — and writes **twelve** `mode2_*` tables from it. Unlike everything above, it
is **not per-session**: there is one fit, stamped with one `fit_id`, and every row in every
table belongs to it.

```bash
make recompute-mode2                 # the normal form; skips if the window is unchanged
make recompute-mode2 FORCE=1         # refit regardless
.venv/bin/python -m f1lab.ingest --recompute-companion mode2 [--force]
```

No FastF1 loads, no `--season` needed. `mode2` is the **last** of the four companion steps,
so `make recompute-companion` (`STEPS=all`) already runs it; the target above is the
one-step form.

**It is content-addressed, and that is the thing to understand.** `model_version` is a hash
of the design the fit was built from. If that hash already exists and all twelve tables are
populated, the step returns `{'skipped': True}` in ~0.02 s and writes nothing — including no
`analytics_status` update. `--force` is the only way past it, and it is what you want after
editing a `MODE2_*` constant (which also moves the assumption set) or after deleting rows.

**ORDER MATTERS — run it after the last ingest, and after the rest of the companion.**
`mode2` reads `sim_driver_params` and `pace_ranking`, which an ingest rewrites. The rule is
the same as §3.9's: **ingest everything, then recompute the companion once.**

**Measured wall clock** on this machine's data volume (983 simulable race rows → 930
modelled), one writer, nothing else touching the database:

| step | cold | warm |
|---|---|---|
| `recompute_rating` (REML fit + 400-replicate bootstrap + 3 cumulative history refits) | ~15 s | — |
| `recompute_skills` (grid pace, tyre refusal, wet refusal) | ~14 s | — |
| `recompute_constructor` (car ratings + retirement hazard) | <1 s | — |
| `recompute_points` (calibration + 68 career seasons + 868 counterfactuals) | ~122 s | — |
| **`--recompute-companion mode2`, all four** | **~2 min 41 s** | **~0.02 s (short-circuit)** |

MODE2_SPEC §7.7 budgets ~15 min for the same work; the REML runs through the exact reduced
91×91 system rather than a 930×930 V, so the fit itself is 0.29 s. Nearly all the time is
the counterfactual grid.

**Three traps.**

1. **`tests/test_mode2_model.py` deletes the current fit, and everything cascades from
   it.** Its bit-identity test does two forced refits, each of which deletes the
   `mode2_fit_run` row at the same `(assumption_set_id, model_version)`; the FK cascade
   takes the skills, constructor and points tables with it. A module teardown in that file
   now runs `decomp.recompute_all(force=True)` and puts them back (~3 min), so a
   whole-suite run leaves the database usable — but **if you interrupt that file, run
   `make recompute-mode2 FORCE=1` before serving the site**, or the constructor pages and
   the skill panel will render their empty states.
2. **v1.3 moved the assumption set, and the seasons were not re-ingested.** The twenty-one
   `MODE2_*` constants join the hash (§7.3), so the current set is **532** while every
   season was ingested under **254** — and three 2024 sessions (R5 sprint, R5 race, R13)
   sit at 532 because `tests/test_ingest_cli.py` ingests into the live database. The
   visible consequences are the *assumption sets differ between races* badge on
   `/season/2024` and a failing `tests/test_full_seasons.py::test_seasons_row[2024]`.
   Mode 2 itself is unaffected — `decomp.load_rows` does not filter `sim_driver_params` by
   assumption set, because that table is keyed `(session_id, driver_id)` and cannot hold
   two competing versions of a row. To align them, follow §4: `make ingest-all ARGS="--force"`
   (~12 min), then `make recompute-companion`, then `make recompute-mode2 FORCE=1`.
3. **`mode2_fit_run`'s unique index on `is_current` is partial, by `assumption_set_id`.**
   More than one row can legitimately carry `is_current` when several assumption sets have
   been fitted. The web resolves the newest (`fitted_at desc, fit_id desc`); `MODE2_KEEP_FITS`
   prunes to three.

**Checking a run landed:**

```bash
docker exec f1-postgres psql -U f1 -d f1 -c \
  "select n_components, n_rows, n_drivers, round(sd_ratio::numeric,2) \
   from mode2_fit_run where is_current"          -- 4 | 930 | 28 | 3.31

docker exec f1-postgres psql -U f1 -d f1 -c \
  "select key, value, count(*) from session_ingests, \
   jsonb_each_text(analytics_status) e(key,value) \
   where key like 'mode2%' group by 1,2"         -- four keys, all 'ok', 62 sessions each

docker exec f1-postgres psql -U f1 -d f1 -c \
  "select anchor_class, basis, count(*) from mode2_driver_rating group by 1,2"
  -- anchored/measured 12 | component-anchored/measured 12 | floating/by-analogy 4
```

The last one is the check worth keeping: the four floating drivers (Norris, Piastri,
Alonso, Stroll) must carry `basis = 'by-analogy'`, because that flag is what every surface
keys its "assumed, not measured" grammar off. If it is ever `measured` for those four, the
site is claiming to know something it cannot.

### 3.12 v1.6 qualifying: the backfill, its verification, and its rollback (QUALI_SPEC §7, §3.8)

**The backfill**, once, in this order (races must already be ingested — kind rank puts them
first for a reason, and a sprint-qualifying session borrows driver identity from its
weekend's siblings):

```bash
.venv/bin/python -m f1lab.ingest --season 2024 --only-quali --sleep 0
.venv/bin/python -m f1lab.ingest --season 2025 --only-quali --sleep 0
.venv/bin/python -m f1lab.ingest --season 2026 --only-quali --sleep 0
.venv/bin/python -m f1lab.ingest --season 2024 --recompute-season   # season_quali_h2h
.venv/bin/python -m f1lab.ingest --season 2025 --recompute-season
.venv/bin/python -m f1lab.ingest --season 2026 --recompute-season
```

**Verification — the six queries worth keeping.** All are `docker exec f1-postgres psql -U f1
-d f1 -c "..."` (there is no host `psql` on this machine):

```sql
-- 1. the session census
SELECT kind, count(*) FROM sessions GROUP BY 1 ORDER BY 1;            -- Q 71 | R 71 | S 18 | SQ 18

-- 2. outcomes, and the two exceptions are named below
SELECT si.status, count(*) FROM session_ingests si JOIN sessions s USING (session_id)
 WHERE s.kind IN ('Q','SQ') GROUP BY 1;                               -- ok 77 | partial 1 | failed 1

-- 3. a pole-sitter with no time is impossible
SELECT count(*) FROM quali_results q JOIN sessions s USING (session_id)
 WHERE q.position = 1 AND q.best_s IS NULL;                           -- 0

-- 4. the season aggregate's CHECK, restated as a query
SELECT count(*) FROM season_quali_h2h WHERE a_wins + b_wins <> sessions_counted
    OR deltas_counted > sessions_counted OR sessions_caveated > sessions_counted;   -- 0

-- 5. D4's pin: the race side did not move
SELECT count(*) FROM laps l JOIN sessions s USING (session_id)
 WHERE s.kind IN ('R','S') AND (l.deleted OR l.is_push_lap IS NOT NULL);            -- 0

-- 6. the unverified driver-segments, and there should be exactly three
SELECT count(*) FROM quali_segment_times WHERE NOT verified;                        -- 3
```

**The two sessions that are not `ok`, and why each is correct:**

- **2025 R07 Q (Imola) — `partial`.** D8's runtime anchor gate fired for real: BEA's segment-1
  official time is 0.841 s away from any lap in the window and one bounded repair did not fix
  it. `laps` and the 20 official `quali_results` rows are written; `quali_segment_times` and
  `quali_teammate_h2h` are **empty** and `analytics_status` says so. The race page renders the
  table and the gap bars and omits the strip and the teammate table. Do not "fix" this by
  re-ingesting — it will reproduce.
- **2025 R06 Q (Miami) — `failed`, permanently.** Loaded from the warm cache with
  `messages=True`, FastF1 returns 20 results rows with `Position` populated and Q1/Q2/Q3
  **all NaT**, plus 314 laps. There is nothing to reconstruct the official classification
  from, so `_check_loaded` refuses the husk rather than storing invented times. The session is
  invisible to the whole web surface; the season page's pole cell for that round is an em
  dash, not a missing round. If a future FastF1 release publishes those times, re-running
  `--season 2025 --only-quali` will pick it up on its own (failed rows are retried).

**Rollback.** Migration 0006 is purely additive and 0007 adds one defaulted column, so the
data can be removed without touching the schema:

```sql
BEGIN;
DELETE FROM season_quali_h2h;
DELETE FROM sessions WHERE kind IN ('Q','SQ');   -- ON DELETE CASCADE clears laps and all quali_* rows
COMMIT;
```

Then `--recompute-season` each year. `laps` returns to 69,548 rows. Reverting the *schema* as
well means dropping the four tables and the five `laps` columns and re-narrowing
`sessions_kind_check`; there is no drizzle-kit "down" migration and there does not need to be,
because nothing outside the qualifying path reads any of it.

### 3.13 v1.7 telemetry: the cache warm (TELEMETRY_SPEC §3.2, §3.3)

**Read this paragraph before you start the warm, not after it.** Telemetry is the only part
of this project whose cost lives outside the database. Two extra cache artifacts per session
(`car_data.ff1pkl`, `position_data.ff1pkl`) at a measured **40–125 MB each session** come to
**~11 GB across the full set** — against ~62 MB of database growth, i.e. 25–150× larger, and
`cache/` is 1.1 GB today. The `cache/` directory is **never pruned**: keeping it is what makes
a later change to the stored-lap rule a local re-run instead of a second 11 GB download.

**The precondition is 15 GB free**, and `warm_telemetry.py` enforces it by refusing to start
and printing the shortfall. This is not caution for its own sake. A warm that runs out of disk
halfway leaves **truncated `.ff1pkl` files that FastF1 reads back as corrupt** on sessions
that look already-downloaded, and the symptom (unexplained parse errors) points nowhere near
the cause. Check first:

```bash
df -h /Users/batuhanisik/Desktop/Projects/F1Analytics   # want ≥ 15 GB Avail
du -sh cache                                            # 1.1 GB before the warm
```

**If you have less than 15 GB, do not warm the races.** `--kinds Q SQ` alone is ~78 sessions
and ~5 GB, and it ships the headline feature — the delta trace — whole, because the
cross-driver delta does not exist on race sessions in the first place (T10).

#### The warm

```bash
# the headline half first: qualifying and sprint qualifying, ~5 GB
.venv/bin/python scripts/warm_telemetry.py --kinds Q SQ

# then the races, ~6 GB, in as many sittings as the rate limiter allows
.venv/bin/python scripts/warm_telemetry.py --kinds R
```

Session order inside a run is fixed: **Q, then SQ, then R, newest season and round first**.
That is not cosmetic. If the run is interrupted — and at 300 calls/hour against 140 sessions
it will be — the half that is done is the half where a one-lap trace means most, and the app
ships with qualifying telemetry complete and races on their empty state. That is a coherent
product; a random 60% of both is not.

Every line of the exit report is a number you can act on:

```
== 78 sessions in scope (Q, SQ); 0 calls in the trailing hour; 265.9 GB free
  skip 2026 R14 Q Qualifying  (cached)
  ok   2026 R10 Q Qualifying  laps=269 +47 MB 6.3s
warmed=2 skipped=4 failed=0 calls=8
-- 13s wall, 265.7 GB free, cache 1.2 GB
```

#### Why it stops instead of sleeping

The FastF1 API ceiling is **500 requests/hour** and this project has hit it. A session load
costs **2 measured** requests; the warmer charges a conservative **4** and paces itself at
**300/hour** (`--calls-per-hour`). Charges are appended to `cache/.telemetry_calls.jsonl`
*before* the fetch, so a killed process still counts what it spent.

When the hour is spent, the warmer **prints the UTC time at which it may proceed and exits 0**.
It never sleeps:

```
-- 296 calls in the trailing hour, budget 300/h. Stopping, not sleeping.
   May proceed at 2026-09-17T01:12:04Z (UTC):
  .venv/bin/python scripts/warm_telemetry.py --kinds Q SQ --calls-per-hour 300
```

Re-run the printed command at that time. If the log already shows **more than 450** calls in
the trailing hour it refuses to start at all, on the same terms. `scripts/warm_resume.sh` is
**not** used here and must not be pointed at this script: its loop greps for a rate-limit
error, sleeps an hour and retries, and an hour of silence is both a worse failure mode than an
early exit and the way an unattended agent gets killed.

#### Budgeted sittings, and resuming

`--budget N` stops cleanly after N charged calls and prints the exact resume command. The
intended operation is **three sittings**, not one three-hour run:

```bash
.venv/bin/python scripts/warm_telemetry.py --kinds Q SQ R --budget 260
```

**A re-run costs the price of what is missing, never of what is already done.** Idempotency is
checked against the filesystem — the only source of truth that survives a killed process. A
session whose two artifacts exist, are non-zero and **unpickle** is charged **0** and skipped
in milliseconds. A *truncated* artifact is reported, deleted and refetched:

```
  BAD  2025 R04 Q Qualifying: car_data.ff1pkl: UnpicklingError: pickle data was truncated
       — deleted, refetching
```

The warmer never raises. A failed session is logged, the loop continues, and the failures are
recorded in `cache/.telemetry_failed.json`; `--resume` re-attempts **only** those.
`--dry-run` reports exactly what would be fetched and charges nothing. `--seasons`,
`--kinds` and `--rounds` narrow the scope; `--rounds` is narrow enough to re-run one
weekend exactly.

#### Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `REFUSED: … short by N GB` | free space below the 15 GB precondition | free space, or `--kinds Q SQ` (~5 GB) |
| `REFUSED: N calls charged in the trailing hour` | a previous run spent the hour | re-run at the printed UTC time |
| `FAIL … DataNotLoadedError` | the session has no timing data at the API (a round that has not been run) | nothing to do; the scope query already excludes sessions with no `laps` rows |
| unexplained parse errors on a "downloaded" session | truncated artifact from a disk-full run | re-run the warmer: it unpickles, deletes and refetches |

The warm is a **prerequisite** of the write pass, not part of it. `python -m f1lab.telemetry`
reads the two pickles and **never touches the network** when the cache is warm, and `--force`
re-derives from the cache at **zero API calls**. Re-downloading is a separate, loud, manual act
(clear the session's cache entry), because at 40–125 MB a session it is the one mistake that
costs hours.

### 3.14 v1.7 telemetry: the derive pass, and recovering a `dropped` session

The warm downloads; **the derive pass writes the rows** (TELEMETRY_SPEC §3.4). It is a second
pass on purpose (T7) and it reads the cache only:

```bash
make telemetry                              # every warmed session, --require-cache, 0 API calls
make telemetry-session SESSION_ID=16041     # one session
make verify-telemetry                       # the acceptance numbers, from the database
```

`--require-cache` is not optional caution, it is the structural guarantee: a derive run with
that flag **cannot** spend API budget, because a session whose artifacts are not on disk is
skipped rather than fetched.

#### `analytics_status['telemetry'].state = "dropped"` — what it means and how to fix it

`ingest --force` rebuilds a session's `laps`, and `lap_telemetry` cascades from `laps`, so a
forced re-ingest **deletes that session's telemetry**. `f1lab/ingest.py` re-derives it in the
same transaction when the cache is warm; when it is not, it records:

```json
{"state": "dropped",
 "reason": "FastF1 telemetry artifacts are not cached; re-run `python -m f1lab.telemetry --session 16041`"}
```

**`session_ingests.status` stays `'ok'`** — that is T8, and it is the whole point: a telemetry
outcome never demotes a session whose lap timing is correct, because `ask.session_health` and
`ask.data_coverage` report on lap-time quality and would be corrupted by a telemetry-shaped
failure. The telemetry tab falls to its one-sentence empty state (§5.6) and nothing else on the
site changes. The fix is the command in the reason string, or:

```bash
make telemetry-session SESSION_ID=<the id in the reason>
```

If that prints `skipped: artifacts not cached`, the cache entry is genuinely gone — warm that
one session first (`scripts/warm_telemetry.py --rounds <n> --kinds <kind>`), then derive.

#### Two operational hazards, both measured during the v1.7 build

**Never run two ingests concurrently.** The post-ingest companion recompute has no concurrency
guard. Two overlapping `--force` runs on the same season produced
`psycopg.errors.UniqueViolation: duplicate key ... circuit_odi_circuit_key_pk` in the second
run's companion step. Nothing was corrupted — the per-session write had already committed and
the failing COPY rolled back — but `ingest_runs` recorded `failed` for a run whose sessions
were fine, which is an unobvious state to debug. One ingest at a time.

**`ingest --force` can stale the committed ask artifacts.** `teams.latest_name` means
*last written*, not *chronologically latest*, so re-ingesting an older session can flip a team's
display name (measured: `rb` went `RB` → `Racing Bulls` when 2026 R13 Q was force-ingested after
a 2024 session had written it last). `web/lib/ask/schema-doc.txt` carries that name, so
`tests/test_ask_schema_sync.py` then fails on one line. After any `--force`:

```bash
.venv/bin/python scripts/gen_ask_schema.py --check   # tells you if anything moved
.venv/bin/python scripts/gen_ask_schema.py           # regenerate the three artifacts
# then re-pin PROMPT_PREFIX_SHA256 in web/lib/ask/prompt.ts (schema-doc.txt feeds the prefix)
docker exec -i f1-postgres psql -U f1 -d f1 -v ON_ERROR_STOP=1 -f - < scripts/sql/ask_views_telemetry.sql
```

The last line empties `ask_answer_cache`, whose keys are `sha256(question_norm + prefix)` and
are therefore all invalid once the prefix moves. This is not telemetry-specific; it is true of
any `--force` in this or a later release.

## 4. Changing a modelling assumption — and what happens next

Every constant lives in `f1lab/config.py` (`FUEL_START_KG`, `FUEL_EFFECT_S_PER_KG`,
`REFERENCE_LAP_KM`, `OUTLIER_THRESHOLD`, `GREEN_FLAG`, `MIN_STINT_LAPS_FOR_DEG`, and since
v1.1 the simulator's `SIM_*` constants — so deploying v1.1 itself created a new set, which is
why every season had to be `--force` re-ingested once); the
call-site parameters (`pace_min_laps`, `fuel_sensitivity_values`, `box_whisker`, …) live in
`f1lab/assumptions.py::CALL_SITE_PARAMS`. Together they form one *assumption set*, hashed
(sha256 of the canonical JSON) into `assumption_sets`.

1. Edit the constant.
2. Run any ingest. The first thing the run does is `assumptions.get_or_create`: a new hash
   → a **new** `assumption_sets` row. Nothing is overwritten silently.
3. Only the sessions that run is asked to (re)ingest are computed under the new set. Every
   analytics row (`pace_ranking`, `degradation_fits`, …) carries its `assumption_set_id`, and
   the race page's *Modelling assumptions* block renders the set the numbers were computed
   under — from the database row, never from web constants.
4. While a season holds races from two sets, `season.recompute` sets
   `seasons.mixed_assumption_sets = true`: `/season/<year>` and `/driver/<code>` show the
   badge *assumption sets differ between races*, and `driver_season_summary` /
   `teammate_h2h` get a NULL `assumption_set_id`.
5. To make the whole site consistent again, force-re-ingest each season:
   `--season 2024 --force`, `--season 2025 --force`, `--season 2026 --force` (about 1½ min
   each from cache). The badge clears on the recompute at the end of each run.

Things to expect: `tests/test_milestone1_numbers.py` and `tests/test_ingest_hungary.py`
assert the notebook's numbers for Hungary 2024 (NOR 81.5796 s, PIA 81.6349 s, …) under the
shipped constants, so they will fail by design after a change — that is the point of the
oracle, not a bug to patch. `notebooks/01_one_race.ipynb` imports the same constants and will
show the new numbers when re-run. Old assumption sets are never deleted (they are the
provenance of `ingest_runs`), but v1 keeps only one set's analytics per session.

## 5. Changing the schema (rare; the schema is frozen after v1)

1. Edit `web/db/schema/*.ts` (explicit snake_case column names).
2. `cd web && npm run db:generate` → a new `web/drizzle/000N_*.sql`; `npm run db:migrate`.
3. Update `f1lab/frames.py::EXPECTED_COLUMNS` (and `RENAMES` if a column is written) so
   `python -m f1lab.ingest --check-schema` passes again; `tests/test_schema_contract.py` enforces it.
4. Re-ingest whatever the new column needs.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Every `make` target prints "You have not agreed to the Xcode license agreements" and does nothing** | `/usr/bin/make` on macOS is an Xcode shim. Run `sudo xcodebuild -license` once and accept, or install GNU make (`brew install make`, then `gmake`). Until then **no Makefile target in this project runs**, including `make db-ask-check`, `make build` and `make test` — invoke the target's body directly. Every target in this Makefile is a one- or two-line wrapper, so the bodies are readable and runnable as written. Measured on this machine during the v1.6 integration pass: `make help` exits 69 before any recipe line executes. |
| `python -m f1lab.ingest` exits 2 with a table name and missing/extra columns | Migration not applied or schema drift: `cd web && npm run db:migrate`, then `--check-schema`. |
| Race page says *not yet ingested* for a race that happened | Run `--season YEAR`; the session is selected once `start_utc + 6 h` has passed. |
| Race page says *data unavailable* | `session_ingests.status = 'failed'`; the header shows the exception text. Re-run `--season YEAR` (retried automatically) or `--round N`. |
| A section shows an empty state with a reason | `analytics_status` for that analytic is `empty` or `error: …` (e.g. no driver reached 8 clean laps). The raw laps are still stored; nothing to fix unless the reason is a bug. |
| Home page shows the ingest-command card | No season has `ingested_rounds > 0`; ingest something. |
| Standings differ from the official table | Post-race penalties/DSQs applied after the API snapshot; re-ingest the round (`--round N`), never patch by hand. |
| `RateLimitExceededError`, exit 2 | Wait, then rerun the same command; it resumes where it stopped. |
| `npm run dev` — port 3000 busy | `lsof -ti :3000 \| xargs kill`, or `npm run dev -- --port 3001`. |
| `tsc` complains about `./.next-xyz/types/routes.d.ts`, or `tsconfig.json` `include` lists `.next-*/types/**` globs | Someone ran Next with a custom `distDir` (Next appends `<distDir>/types/**` and `<distDir>/dev/types/**` to `tsconfig.json` and repoints `next-env.d.ts`, and never removes them). The project no longer sets `distDir`; delete every `.next-*` glob from `tsconfig.json` `include` (keep the two `.next/` ones), run `npm run typecheck` to regenerate `next-env.d.ts`, and `rm -rf web/.next-*`. |
| Ingest stopped with Ctrl-C | Every session finished before the interrupt is committed; the run row is `aborted` with `interrupted (KeyboardInterrupt)`. Rerun the same command; it resumes with the sessions that are not `ok`. A hard kill (`kill -9`, power loss) also keeps the committed sessions but leaves the run row `running`; harmless provenance. |
| Tests re-ingest Hungary and change `ingest_runs` | Expected; `ingest_runs` is provenance only. |
| Simulator section says *No strategy model for this race* | `analytics_status->>'sim'` is not `ok`. `error: SimNotEstimable: rain race …` / *fewer than two slick compounds* are data facts; a missing key means the race predates v1.1 → `--round N`. Anything else (`KeyError`, `ValueError`, …) is a bug in `f1lab/sim.py`. |
| `/season/<year>` shows *assumption sets differ between races* after upgrading to v1.1 | Only part of the season has been re-ingested under the new `SIM_*` constants; `--season YEAR --force` clears it. |
| Want to start over | `docker compose down -v` (drops the volume), then §1 from step 2. |

## 7. Where things live

```
docker-compose.yml     Postgres 16, volume pgdata
f1lab/                 ingest + every computation (config, clean, pace, derive, colours, frames, db, season, ingest, sim)
tests/                 pytest; `db` marker for tests needing Postgres
scripts/warm_cache.py  pre-download FastF1 sessions into cache/ (telemetry=False, always)
scripts/warm_telemetry.py  the v1.7 telemetry warm: ~11 GB, paced, refuse-and-print (§3.13)
f1lab/telemetry.py     the v1.7 derive pass: chord distance (T5), the summary, the corner card (§3.14)
web/lib/telemetry/align.ts     the one place two laps are aligned; rejects any non-chord axis
web/app/race/[year]/[round]/telemetry/  the telemetry tab; absent by design where the pass never ran
cache/                 FastF1 cache (never disable it; do not commit; never pruned)
cache/.telemetry_calls.jsonl   one line per charged API call; the trailing-hour rate limiter reads it
cache/.telemetry_failed.json   the sessions `warm_telemetry.py --resume` will re-attempt
web/                   Next.js 16 app; db/schema + drizzle/ own the DDL; lib/queries read; components render
docs/SPEC.md           the v1 contract (§8 lists what was built differently)
docs/SIM_SPEC.md       the v1.1 simulator contract (§10 as built); engine in web/lib/sim, UI in web/components/sim
docs/MODE1_SPEC.md     the v1.2 race-companion contract (§11 as built); f1lab/{winprob,title,preview,moments,companion}.py
docs/MODE3_SPEC.md     the v1.4 ask box + race reports contract; see §8 below for provisioning
docs/TELEMETRY_SPEC.md the v1.7 telemetry contract (§10 as built); the twelve fixed decisions T1-T12
scripts/sql/           0005_ask_views.sql (GENERATED — never edit), 0005_roles.sql (by hand, as f1)
web/lib/ask/           the ask pipeline: three pools, the validator, the execution envelope
Makefile               the targets used above
```

---

## 8. The ask box: roles, provisioning and the deploy gate (v1.4, MODE3_SPEC §1, §6.4)

v1.4 adds the first request-time model call and the first generated SQL in this project. The
security model is **by GRANT, not by good behaviour**: the design assumes the model's output is
fully attacker-controlled, and four rails that look like controls were empirically broken during
design and are *not* relied on — `BEGIN READ WRITE` escapes `default_transaction_read_only`;
`set_config('statement_timeout','0',false)` persists on a pooled connection; node-postgres runs
**both** statements of `select 1; select 2` under every query spelling except a named prepared
statement; and `EXPLAIN select 1; select 2` plans the first and **executes** the second.

Three roles, three connection strings, three pools, one consumer each:

| Role | Env var | Pool | May do |
|---|---|---|---|
| `f1` | `DATABASE_URL` | `db/client.ts` | everything — every page, every `lib/queries/*`, ingest. Never runs generated SQL. |
| `f1_ask` | `ASK_DATABASE_URL` | `lib/ask/askPool.ts` | `SELECT` on the 57 views of schema `ask`. **No grant at all in schema `public`.** |
| `f1_ask_log` | `ASK_LOG_DATABASE_URL` | `lib/ask/logPool.ts` | `INSERT` on `ask_query_log`, `SELECT` on four of its columns, read/write `ask_answer_cache`. Cannot read a question back. |

### 8.1 First run, in this order

```bash
make migrate                 # 0001..0005 — creates race_report, ask_query_log, ask_answer_cache
make db-ask-views            # CREATE SCHEMA ask; 57 generated views; the enumerated GRANT
make db-ask-roles ASK_PASSWORD="$(openssl rand -hex 24)" \
                  ASK_LOG_PASSWORD="$(openssl rand -hex 24)"
make db-ask-verify           # 32 assertions. A NON-ZERO EXIT BLOCKS DEPLOY.
```

`db-ask-views` must run **before** `db-ask-roles`, because `0005_roles.sql` grants `SELECT ON
ALL TABLES IN SCHEMA ask` and the schema has to exist. On a fresh machine the generated file's
own enumerated `GRANT` is skipped with a `NOTICE` (the role does not exist yet), so
`db-ask-roles` re-applies `0005_ask_views.sql` for you as its last step. Both files are
idempotent; re-running `db-ask-roles` rotates both passwords and re-asserts every setting.

Then put the two DSNs in `web/.env.local` (gitignored — see `web/.env.example`):

```
ASK_DATABASE_URL=postgres://f1_ask:<ask_password>@localhost:5432/f1
ASK_LOG_DATABASE_URL=postgres://f1_ask_log:<ask_log_password>@localhost:5432/f1
ANTHROPIC_API_KEY=...
ASK_IP_SALT=<any long random string>
```

> **The Makefile's `ASK_PASSWORD` / `ASK_LOG_PASSWORD` defaults are for the local Docker
> database only**, matching the existing `postgres://f1:f1@localhost` convention. Any
> deployment that is not this laptop must pass both explicitly. The GRANT is the boundary, but
> a shared password is still a shared password.

### 8.2 `make db-ask-verify` — what it asserts, and why a failure blocks deploy

It runs every line of MODE3_SPEC §9 WP-2 against the live database as the role each line is
about, leaves no rows behind (both write probes roll back), and exits non-zero on the first
failure count above zero. As `f1_ask`: `ask.laps` readable; `public.laps`, `ingest_runs`,
`ask_query_log`, `race_report` all **permission denied for schema public**; `current_user,
usesuper` = `f1_ask,false`; `has_schema_privilege(…,'public','USAGE')` false; zero table grants
in `public`; `CREATE TABLE` denied **even inside `BEGIN READ WRITE`** (which is the point — the
read-only GUC is not the control); `CREATE SCHEMA` denied; `pg_read_file('/etc/passwd')` denied;
`pg_sleep(10)` cancelled in ~4 s; `CONNECT` to database `postgres` refused by ACL. As
`f1_ask_log`: the INSERT succeeds, `SELECT question` is denied by the column grant, `SELECT *`
is denied, `DELETE` is denied, every F1 table is denied, schema `ask` is denied. Cluster-wide:
role `f1` unchanged, `judge_sec_probe` dropped, exactly three login roles, 57 objects in `ask`
all granted, and PUBLIC holding nothing on database `f1`, database `postgres` or schema
`public`. Finally it re-measures the node-postgres protocol rail against the real driver:
five loose query spellings each run **both** statements of `select 1; select 2`, and only
`{name, text, values: []}` raises `cannot insert multiple commands into a prepared statement`.

A failure means the boundary is not where the code assumes it is. Do not deploy past it.

### 8.3 Regenerating the `ask` surface

`scripts/sql/0005_ask_views.sql`, `web/lib/ask/schema-doc.txt` and
`web/lib/ask/ask-objects.json` are **generated** from `scripts/ask_manifest.yml` plus the live
catalogue — never hand-edited.

```bash
make db-ask-gen     # regenerate all three
make db-ask-check   # exits 1 if the committed artifacts differ from a fresh generation (CI)
make db-ask-views   # apply the regenerated SQL, including the enumerated GRANT
```

The prompt document's COVERAGE block is derived from live data and therefore **moves with every
ingest**. Regenerate after the database settles and before a deploy, or `db-ask-check` and
`tests/test_ask_schema_sync.py` fail on a coverage-only diff. `CREATE OR REPLACE VIEW` cannot
reorder or drop an existing view's columns: if a regeneration changes a view's *shape*, run
`DROP SCHEMA ask CASCADE` first and then `make db-ask-views` twice.

### 8.4 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Route refuses with `ASK_DATABASE_URL does not point at a correctly provisioned f1_ask` | half-finished deployment, usually the DSN left pointing at `f1` | fix `web/.env.local`, then `make db-ask-verify` |
| `permission denied for schema ask` as `f1_ask` | `db-ask-roles` ran before `db-ask-views` | `make db-ask-views && make db-ask-roles …` |
| `schema \`ask\` has no views` at startup | schema never created | `make db-ask-views` |
| `cannot insert multiple commands into a prepared statement` in the log | the protocol rail did its job on a multi-statement answer | nothing to fix; the validator should have caught it first — check `validator_verdict` |
| `INSERT … RETURNING ask_id` fails as `f1_ask_log` | `ask_id` is not in the column-level `SELECT` grant | insert without `RETURNING` |
| ask box quiet, no error | `ANTHROPIC_API_KEY` absent | the feature turns itself off by design; ingest and every precomputed page are unaffected |

### 8.5 Race reports at ingest (v1.4, MODE3_SPEC §4)

Reports are **not** a web feature. They are written in Python at ingest by `f1lab/report.py`,
stored in `race_report`, and read by `/race/[year]/[round]` with a plain Drizzle query like any
other precomputed row. Nothing on that page calls a model at request time.

`report` is the **last** companion step, after `mode2`. It reads `wp_swing`, so any earlier
position would have it narrate the previous model generation's swings.

```bash
make ingest SEASON=2025                    # reports generated as part of the normal run
.venv/bin/python -m f1lab.ingest --recompute-companion report   # reports only, no FastF1
```

**An ingest with no `ANTHROPIC_API_KEY` still exits 0.** The step logs `report: skipped (no key)`,
writes nothing, and every other mode is unaffected. That is the designed behaviour (§4.6), not a
degradation to fix — verified: 62 races, 0 rows written, exit 0.

**Reports are idempotent on `grounding_sha256` (§4.5).** `ingest --force` recomputes the numbers;
if the numbers did not move, the hash did not move and **zero** reports regenerate, so a forced
ingest never becomes a forced spend. The separate flag for a prompt or model change is:

```bash
.venv/bin/python -m f1lab.ingest --recompute-companion report --regen-reports
```

which bypasses the hash and makes **one API call per race** (62 races ≈ $3.80 at the measured
bundle size). Run it on ONE session by hand and read the result before backfilling.

> **Changed `ASK_INSTRUCTIONS`, `schema-doc.txt`, `ASK_MODEL` or `ASK_EFFORT`?**
> Re-run `make ask-eval` before shipping. If you regenerated the schema document, also run
> `make db-ask-check`, paste the new hash into `PROMPT_PREFIX_SHA256` (§8.3) and re-run
> `make check-invariants` — the build fails until the committed hash matches.

### 8.6 The two checks that guard the architecture

| Command | What it holds |
|---|---|
| `make check-invariants` | §0.2's boundary sentence as a build step: 7 rules — the model secret named only in the three permitted files (and no live-key-shaped string anywhere), `askPool`/`execute`/`logPool` not imported outside `lib/ask/`, no second `POST` route under `app/`, `db/client.ts` (the superuser pool) never imported inside `lib/ask/`, `echarts` value-imported only by `EChart.tsx`, and the committed `PROMPT_PREFIX_SHA256` still matching the assembled prefix. |
| `make verify-ask-rails` | The four rails §0 says are **not** boundaries, re-measured against the live database as `f1_ask`: `BEGIN READ WRITE` escapes read-only mode (and the GRANT still refuses the write), `set_config` can zero `statement_timeout` (and gate 5b plus the out-of-band cancel stand in for it), the unnamed node-postgres query forms run *both* statements of a multi-statement string (and `execute.ts` only ever uses a named prepare), and a `DELETE`-CTE parses as one `SelectStmt` (and dies at gate 3). |

Run both in CI next to `make lint`. A failure in either is an architectural regression, not a
style problem: fix the code, never the checker.
