# F1 Analytics v1.11 — Operations spec (CI + deployment)

Status: FINAL design, synthesised from three proposals (correctness-first, cost-first,
operations-first) and three judge passes (security, CI-truth, solo-operability). Judges' winner
per area: CI = correctness-first (census + hard-exit + coverage number), deployment =
operations-first (diff push, gates in order, rollback). Every error a judge found is fixed
here; every graft that does not conflict is taken; each disagreement is decided once in §9.

Facts marked MEASURED were measured by a proposal author or a judge against this repo or the
live Docker database; EST = estimate to be replaced by the first CI run's numbers.

## Outline
- 0. Scope and fixed decisions
- 1. CI tiers and the visible-skip rule (C1, C3, C4, C5)
- 2. The fixture (C2)
- 3. Topology and the data path, with failure modes (D1)
- 4. Public exposure: ask box, roles, never-deploy list, public vs protected (D2–D5)
- 5. Cold starts and cost in dollars (D6, D7)
- 6. Exact artefacts: workflow YAML outline, Vercel env table, post-login runbook, update_season.py change
- 7. Work packages: single-owner file ownership, sequencing, verification
- 8. Risks (top 5)
- 9. Decisions log
- 10. As built (empty until the work packages land)

## 0. Scope and fixed decisions

### 0.1 Scope
v1.11 adds two things and changes nothing about how data is computed:
1. **CI on GitHub Actions** for the private repo `batuhanisik751/F1Analytics`: web (typecheck,
   lint, invariants, 260 unit tests, build), Python pure tests, Python DB tests against a
   restored fixture, and the 107 a11y tests against `next start` on that fixture.
2. **Production = Next.js on Vercel + Postgres on Neon**, fed from the laptop by a new
   `scripts/push_remote.py` that `update_season.py` calls as its last step.

Out of scope: any change to `f1lab` analytics, any DDL outside Drizzle, any second
environment (no staging), any CI deploy step (Vercel's Git integration deploys; no
`VERCEL_TOKEN` ever exists in GitHub).

### 0.2 Fixed decisions (each justified in the section named)
| # | Decision | Where |
|---|---|---|
| F1 | CI classifies cache-dependence **per test**, not per file. The brief's "10 cache-dependent db files" is wrong in both directions (test_derive, test_quali_clean, test_quali_frames are NOT db-marked; tests/test_moments.py:372 IS db+cache). The runbook corrects that sentence. | §1.1 |
| F2 | The fixture is the real database, cut with `--exclude-table-data` for {ingest_runs, ask_query_log, ask_answer_cache} and `session_ingests.error` nulled, published as a GitHub Release asset. `wp_model_artifact` is KEPT (tests/test_winprob.py:384,461 read it). | §2 |
| F3 | CI prints `ran N of 952 (P%) — not run: A fixture-cache, B direct-cache` and fails below a committed floor. A lost database is `pytest.exit(3)`, never a skip. | §1.2 |
| F4 | Data path: session-scoped diff (35 session-keyed tables / 38 not, MEASURED), DELETE+COPY in one transaction under ROW EXCLUSIVE, 3 retries, snapshots, `--full` and `--sessions` rollback. Never `pg_restore --clean` over the wire. | §3 |
| F5 | Neon roles: `f1_web` (SELECT-only, mandatory, app's DATABASE_URL), `f1_ask` (direct endpoint), `f1_ask_log` (pooled), **`f1_push`** (least-privilege nightly credential, new). The owner role is used only interactively. | §4.2 |
| F6 | The push credential lives in `~/.config/f1analytics/remote.env`, mode 600 asserted by the script; the tracked plist carries only `HOME`. | §3.4 |
| F7 | Ask box ships **OFF** in production (no key). Key is the last act, after `db_ask_verify.sh` 32/32 on Neon, `ASK_DAILY_BUDGET_USD=2.00` and the Anthropic console spend limit (budget x 31 = $62) exist. | §4.1 |
| F8 | **Public**, on the Vercel URL, with Vercel Authentication ON for every deploy until the release gates pass; no paid Password Protection. | §4.4 |
| F9 | `sslmode=verify-full` in every Vercel DSN; `sslmode=verify-full&sslrootcert=system` on the laptop-to-Neon write path. pg 8.23 warns on `require`. | §4.2 |
| F10 | Rule-1 scrub BEFORE the remote exists: `git rm --cached` the three tracked tool-config files listed in `output/rule1_scrub.txt` (gitignored; not named here because this spec is itself tracked), gitignore them, `git filter-repo` decided in §9. | §7 WP-1 |
| F11 | `make` is never invoked anywhere; `db_ask_verify.sh` is extracted from the Makefile. | §4.2 |
| F12 | Nothing in the repo, workflow, README, PR template or commit history names a tool or assistant. | all |

### 0.3 What the brief got wrong (corrected here, not silently)
- Cache-dependence is per test. MEASURED census (correctness-first, `pytest --collect-only`
  with a fixture-list plugin; confirmed by a judge): 952 items in 34 files = 462 nodb/nocache +
  404 db/nocache + 84 nodb/cache + 2 db/cache. The "9 pure files" are themselves cache-bound
  (test_frames 27/33 tests on the cache, test_sim, test_guards, test_clean_refactor,
  test_pace_helpers): `pytest -m "not db"` on a runner without `cache/` is RED, not green,
  because conftest's session fixtures fail rather than skip. Both other proposals' CI was red on
  day one for this reason.
- `ingest_runs` rows carry hostname and (per one judge) `/Users` cache paths; a second judge
  found 0 `/Users` matches in `ingest_runs` and 1 in `session_ingests.error`. Either way both
  are excluded from anything that leaves the laptop (§2, §3).
- Vercel Password Protection is $20/month per protected project on Pro (not $150; that is a
  legacy package). Git LFS free quota is 10 GiB storage + 10 GiB/month bandwidth (not 1 GB).
  Neither changes a decision. Vercel Hobby function timeout is 300 s with Fluid compute, not
  30 s; the argument against wire `pg_restore` rests on reader blocking, not on the timeout.

## 1. CI tiers and the visible-skip rule (C1, C3, C4, C5)

### 1.1 The census that decides the tiers (MEASURED, correctness-first; confirmed by a judge)
`pytest --collect-only` over `tests/` with a plugin that reads each item's fixture list:
952 items in 34 files.

| class | items | meaning |
|---|---|---|
| nodb / nocache | 462 | pure: no DB, no FastF1 session fixture |
| db / nocache | 404 | need a migrated, populated Postgres; no session fixture |
| nodb / cache | 84 | use `hungary_2024` / `miami_2025` / `r1_2026` / `any_session`, loaded by conftest from `<root>/cache` |
| db / cache | 2 | both (`test_moments.py:372`, `test_sim_db`) |

Cache use has two shapes and CI handles each mechanically:
- **(a) session fixtures** — detectable from `item.fixturenames`. With `F1_CI=1` conftest's four
  session fixtures `pytest.skip("FastF1 cache absent (F1_CI=1)")` instead of failing.
- **(b) direct calls** inside test bodies (`ingest.main`, `load_race`, `derive_session`,
  subprocess `-m f1lab.ingest`). MEASURED by restoring the fixture and stubbing the loaders to
  raise: 169 tests fail on the stub (test_quali_clean 128, test_quali_frames 30,
  test_quali_ingest 5, test_derive 2, test_guards 2, test_sim 1, test_telemetry 1) plus
  test_ingest_cli (9) and test_ingest_hungary (6) which reach FastF1 below the stub. These get
  `@pytest.mark.cache` (per test; whole-file for the two ingest files). CI runs with
  `-m "not cache"` on top of the tier marker and `-rs` so every skip prints its reason.

### 1.2 Tiers
| tier | job | trigger | needs | runs | wall (EST unless MEASURED) |
|---|---|---|---|---|---|
| T0 | `web` | every push + PR | nothing | `npm ci`, `check:invariants`, `typecheck`, `lint`, `npm run test` (260, MEASURED 1.4–3 s, 0 skips with no env), `npm run build` | ~3 min |
| T0 | `py-pure` | every push + PR | nothing | `F1_CI=1 pytest -m "not db and not cache" -rs` → 462 run, 84 skip with the fixed reason | ~2–3 min, pip-install bound |
| T1 | `py-db` | every push + PR | `postgres:16` service + fixture (§2) | restore → `npm run db:migrate` (ledger assertions §2.3) → roles SQL → `F1_CI=1 F1_REQUIRE_DB=1 pytest -m "db and not cache" -rs` as ONE invocation in file order (db tests mutate; never sharded) — excluding `test_mode2_model` | restore 3 s MEASURED; tests ~1 min MEASURED locally, EST 2–4 min on runner |
| T1 | `py-db-slow` | every push + PR | its own service + own restore | `pytest tests/test_mode2_model.py` (MEASURED 217 s locally, 160 s of it teardown refit) | EST 5–10 min; if the first runs measure > 12 min it moves to `main`-only, still counted in the summary |
| T1 | `a11y` | step at the end of `py-db` | same service DB + build artefact from `web` | `next start -p 3000`, wait for `/glossary`, `A11Y_REQUIRE=1 npm run test:a11y` (107) | EST 1–2 min |
| T2 | never | — | the 8.5 GB FastF1 cache | 86 fixture-cache + 185 direct-cache tests; `tests/ask/run_acceptance.py` (needs a model key) | laptop only: `.venv/bin/python -m pytest tests -q` |

The number printed on day one (MEASURED against the restored fixture, no key, no cache):
**`ran 681 of 952 collected (71.5%) — not run in CI: 86 fixture-cache, 185 direct-cache`**.
That is 388 of the 406 db-marked tests on the real corpus, which is where the KeyError
cascade lived.

### 1.3 The visible-skip rule (rule 3) — four mechanisms, none optional
1. **Every skip has a fixed reason and is printed** (`-rs`): `FastF1 cache absent (F1_CI=1)` or
   `cache marker: needs the FastF1 cache`. The db-skip reason never appears in CI because:
2. **`F1_REQUIRE_DB=1` turns conftest's db-gate into `pytest.exit(returncode=3)`** with the
   reason in the message. A CI that lost its database cannot be green.
3. **`scripts/ci_coverage.py`** sums the junit XML of `py-pure`, `py-db`, `py-db-slow` and
   `a11y`, writes the `ran N of 952` line to `$GITHUB_STEP_SUMMARY`, fails the job if `ran` is
   below the floor in `tests/ci_census.json` (initially 681; also records the fixture tag it
   was measured against and prints a WARNING line if the tag differs), and fails if the a11y
   XML has `skipped > 0`.
4. **`A11Y_REQUIRE=1`** makes `tests/a11y/dom.ts` `serverUp()` throw instead of `t.skip`.
Plus `timeout-minutes: 20` on every job: a cache-bound test that slips past the marker hits
FastF1's network path and goes RED, never slow-green. The README badge links to the workflow
whose step summary is the first thing a reader sees.

### 1.4 a11y in CI (C3): YES
Against `next start` on the `web` build artefact, not `next dev` (what ships; 3–5x faster).
The 11 routes it fetches (2026 R13, VER, mclaren, /glossary, /ask shell) are all in the
fixture. Leaving it out would have put a 107-test suite on a checklist the user must remember.

### 1.5 Runtime and parallelism (C4)
Four jobs in parallel; `py-db` is the critical path (pip ~40 s cached → restore 3 s → migrate
→ tests → a11y). Target **≤ 8 min wall, ≈ 18–25 billed minutes per push** (four jobs each pay
setup; the honest number, not "12"). GitHub Free private repo = 2,000 min/month → ~80–110
pushes/month inside the free tier; the realistic 30–50 pushes spend 30–60 %.
Savers: `actions/setup-node` npm cache, `actions/setup-python` pip cache, `actions/cache` for
the fixture keyed on its sha256, `concurrency: {group: ci-${{ github.ref }},
cancel-in-progress: true}`, a `requirements-ci.txt` without jupyter/matplotlib (optional, WP-2).
Vercel builds on its own minutes via Git integration; CI never runs `vercel build`.

### 1.6 Secrets (C5): zero
MEASURED: `npm run test` 260/260 with `ANTHROPIC_API_KEY`, `DATABASE_URL`, `ASK_DATABASE_URL`,
`ASK_LOG_DATABASE_URL` all unset; `lib/ask/anthropic.ts` is the only reader of the key and its
`no_key` branch is the tested path. Python: `test_report_grounding` 19/19 and
`test_report_idempotency` 14/14 pass key-less (two tests `delenv` the key to assert the §4.6
degrade). `next build` opens no DB. The only token is the automatic `GITHUB_TOKEN`
(`permissions: contents: read`) to download the private Release asset; the service DB is
`postgres://f1:f1@localhost:5432/f1`; the roles get `ci-only-pw`. No Neon or Vercel credential
ever enters Actions.

## 2. The fixture (C2)

### 2.1 Decision: (a) a scrubbed `pg_dump -Fc` of the real database as a GitHub Release asset,
pinned by tag + sha256 in git, cached in Actions. $0.

MEASURED (correctness-first, scratch container `f1-ci-probe`, never the real one): dump
31.3 MiB in 6 s; `postgres:16` ready in 2 s; `pg_restore --no-owner -j 1` **3 s, exit 0**, 102 MB
on disk (the live 176–215 MB is bloat); ledger 11 rows, public 73 relations, ask 65 views.
Four tables are 80 % of the bytes (lap_telemetry 78 MB, wp_lap_probability 43, laps 37,
lap_corner_speeds 14), all session-keyed. No FK cycles (checked in `pg_constraint`).

### 2.2 Options and what each loses
| option | $/month | what it loses | verdict |
|---|---|---|---|
| **(a) Release asset** (`gh release create fixture-YYYY-MM-DD` from the laptop; CI `gh release download` with `GITHUB_TOKEN`) | $0 (Release assets are not metered; 2 GB per-file cap) | "The fixture lives in git history": it is a side artefact refreshed by hand → needs the staleness guard (§2.3) and a pin so a forgotten refresh is a RED run, never a stale green. CI tests a snapshot, not the live corpus. | **CHOSEN** |
| (b) git LFS | $0 today (10 GiB storage + 10 GiB/month bandwidth free — corrected from the "1 GB" two proposals stated) | Every re-cut adds 31 MB to LFS storage for ever; `checkout lfs: true` downloads per run unless separately cached; exceeding the quota at a $0 budget BLOCKS LFS for the rest of the month → CI red until the 1st. Binary blobs in git. | Rejected |
| (c) trimmed fixture (one season, ~5–11 MB) | $0 | Exactly the bugs the DB tests exist for: `test_milestone1_numbers`, `test_full_seasons`, `test_season_quali`, `test_schema_contract`, `test_title`, `test_winprob` and the mode-2 fits assert corpus-level numbers; a trimmed corpus fails them or needs a second expectation set; FK-consistent subsetting of 73 tables is its own tool. Saves ~30 s/push. | Rejected |
| (d) schema-only, 25 files skip | $0, fastest | All 404 db/nocache tests — the ones that saw the KeyError cascade. Rule 3 becomes a permanent apology. | Rejected |
| (e) `actions/cache` keyed on the sha, layered on (a) | $0 (10 GB/repo) | Nothing; an accelerator with 7-day eviction, not a source of truth. | Added |

### 2.3 What is in the fixture and what is scrubbed (the same EXCLUDE set as the nightly push)
`scripts/publish_fixture.sh` (new, ~35 lines, no make, no host psql):
```
docker exec f1-postgres pg_dump -U f1 -d f1 -Fc --no-owner --no-privileges \
  --exclude-table-data=ingest_runs --exclude-table-data=ask_query_log \
  --exclude-table-data=ask_answer_cache > output/fixture.dump
```
- `ingest_runs` (586 rows: hostname, `/Users` cache paths, tracebacks), `ask_query_log`,
  `ask_answer_cache` (web-owned, MODE3 §6.2; may hold typed questions): DATA excluded, DDL kept.
- `session_ingests.error` (1 row holds a `/Users/` path, MEASURED): scrubbed by dumping the
  table's data from a temporary view with `error` set to NULL and the real table
  `--exclude-table-data`'d; ~6 lines in the script. Not "accepted as a known leak".
- **`wp_model_artifact` is KEPT** — ops-first stripped it and `tests/test_winprob.py:384,461`
  read it. Fixing this error is what makes the 681 number reachable.
- `--no-privileges` keeps the `f1_ask`/`f1_web` GRANTs out of the archive; CI re-creates the
  roles (`ci-only-pw`) and re-runs `scripts/sql/0005_roles.sql` + `0005_ask_views.sql` +
  `0011_web_role.sql` after the restore so `test_web_owned_tables` and `test_ask_schema_sync`
  exercise the REAL grant boundary.
- The EXCLUDE set is one Python constant in `scripts/push_remote.py` (`EXCLUDE_TABLES`), read by
  `publish_fixture.sh` via `python -c`, and asserted by `tests/test_push_remote.py`.
- `publish_fixture.sh` REFUSES on a dirty tree, writes `tests/ci_fixture.txt`
  (`tag=fixture-2026-09-20 sha256=…`) and the user commits it **together with**
  `db/trail_census_baseline.json` so fixture and baseline never come from different nights.

### 2.4 Migrations in CI: exercised on real data (replaces "must be a no-op")
After the restore, `py-db` runs `cd web && npm run db:migrate` against the service DB with two
assertions: (1) before: `fixture_ledger <= count(web/drizzle/*.sql)` else
`fixture is NEWER than the repo — wrong branch or wrong asset`; (2) after: `ledger ==
repo_migrations` else `db:migrate did not bring the fixture to head`. A migration added by the
PR is applied to 178 real sessions before it ever reaches Neon. A separate 5 s step
(`createdb f1_empty && npm run db:migrate`) proves migrations apply from zero, so the fixture can
never mask a broken 0011/0012.
Refresh policy: re-publish after every merged migration and after any ingest that changes a
number a test asserts on; `update_season.py` does NOT re-cut nightly (the fixture is a test
input, not a mirror). `tests/ci_census.json` records the tag it was measured against.

### 2.5 Isolation
DB tests mutate (`test_mode2_model` upserts a fit, `test_report_idempotency` writes reports):
fresh restore every run, the db tier is ONE pytest invocation in file order, never sharded
across jobs against a shared DB; `py-db-slow` gets its own service and its own restore.

## 3. Topology and the data path, with failure modes (D1)

### 3.1 Topology
```
laptop                                   GitHub (private)             Vercel (Hobby)              Neon (Free, same region)
FastF1 cache 8.5 GB   never leaves       repo + Actions CI (§1–2)     Root Directory = web/       Postgres 16, db f1, 0.25 CU
Docker Postgres f1    never leaves       Release `fixture-*` (§2)     next build reads NO db      roles: f1 (owner, interactive only)
.env.local            never leaves                                    5 env vars (§6.2)             f1_web  SELECT     <- DATABASE_URL (pooled)
launchd 03:20 update_season.py                                        reads at request time         f1_ask  ask views  <- ASK_DATABASE_URL (direct)
  ingest -> telemetry -> growth guard                                                               f1_ask_log INSERT  <- ASK_LOG_DATABASE_URL (pooled)
  -> step 4: push_remote.py  ---- one psycopg transaction, TLS verify-full ---------------------->  f1_push DML only   <- ~/.config/f1analytics/remote.env
```
Two pipelines that never touch: **code** goes GitHub → Vercel (Git integration, `main` only,
CI as a required check); **data** goes laptop → Neon. A deploy never moves data; a push never
redeploys. No process on any server knows about the laptop. Preview deployments get NO
database URL and no key (Ignored Build Step skips them; §6.1).

### 3.2 The mechanism: session-scoped diff in one transaction (ops-first, with grafts)
MEASURED: 35 public tables carry `session_id` (~172 MB, every table over 1.5 MB); 38 do not
(season/driver aggregates, ~10 MB). Unit of change = `(table, session_id)`.
`scripts/push_remote.py` (new, importable as step 4 of `update_season.py`, also a CLI):
1. **Migrate first, automatically.** Read `drizzle.__drizzle_migrations` on both sides. If
   remote lags local: `cd web && DATABASE_URL=$REMOTE_OWNER_URL npm run db:migrate` — but the
   owner URL is NOT in the nightly env (F5/F6), so the nightly run instead exits 2 with
   `SCHEMA BEHIND: run scripts/neon_migrate.sh` and the `PUSH FAILED` line; `neon_migrate.sh`
   (interactive, prompts for the owner URL, never stores it) runs `db:migrate` then re-applies
   `0005_ask_views.sql`/`0011_web_role.sql` GRANTs for any new table. If remote is AHEAD, refuse.
   (Decision §9-D4: auto-migrate from the nightly job would require the owner credential on
   the laptop unattended; the least-privilege `f1_push` wins. The stall is loud, not silent.)
2. **Diff cheaply.** Per session-keyed table: `SELECT session_id, count(*) GROUP BY 1` both
   sides, joined with the per-session **fingerprint** = `session_ingests.status` +
   `analytics_status` + `trail_census_by_session` sha (cost-first's stronger fingerprint, so a
   re-derived session with the same row count still propagates). Push set = sessions whose
   fingerprint differs or are absent remotely; delete set = present remotely, absent locally.
   Per non-session table: `count(*)` + `md5(string_agg(t::text ORDER BY pk))`; replace whole if
   different. Hard-coded `EXCLUDE_TABLES = {ingest_runs, ask_query_log, ask_answer_cache}`
   (+ sequence `ask_query_log_ask_id_seq` never touched); `session_ingests.error` written as
   NULL. A table in none of {session-keyed, whole, excluded} → refuse, exit 2 ("unclassified
   table X" — red, not a guess).
3. **Nothing to do → exit 0 in ~5 s.** Six nights a week this is the whole push.
4. **Apply, one remote transaction**: children-first `DELETE … WHERE session_id = ANY(%s)`, then
   parents-first `COPY (SELECT …) TO STDOUT` local piped into `COPY t FROM STDIN` remote
   (psycopg `copy()` both ends, streamed, no temp file); FK order from `pg_constraint` at run
   time. Then `INSERT INTO data_release (pushed_at, sessions_pushed, rows_pushed, census_sha256)`
   — no `source_host` column (graft: the hostname never leaves the laptop). `COMMIT`.
   Locks are ROW EXCLUSIVE: readers never block, see old rows until COMMIT and new after.
5. **Verify after COMMIT**: remote per-session counts + census for the pushed sessions equal
   local; `has_schema_privilege('f1_ask','public','USAGE') = false` AND
   `has_schema_privilege('f1_ask','ask','USAGE') = true`; `ask_query_log_ask_id_seq.last_value
   >= max(ask_id)`. Mismatch → `PUSH VERIFY FAILED`, exit 1; next night's diff repairs data
   drift because the diff is the mechanism, not the run's memory.
6. Retries: 3 attempts, 30 s / 2 min / 5 min backoff; then `PUSH FAILED: production is N
   session(s) behind`. Write `output/last_push.json` `{at, sessions, rows, ok, release_id}`.
A race weekend moves ~3–4 MB and commits in well under a minute on 0.25 CU. Initial load =
same code path with everything differing (~100 MB, one transaction, EST 5–10 min) — or the
§2 dump restored with `--no-privileges` (§6.3 step 5), which is what the runbook uses.

### 3.3 Rejected alternatives (one line each)
- `pg_dump | pg_restore --clean --single-transaction` over the wire (correctness-first): holds
  ACCESS EXCLUSIVE on every table for an UNMEASURED 20 s–minutes on 0.25 CU; with
  `lock_timeout=30s` a single slow reader aborts the night's push; rewrites ~100 MB of Neon
  history per push; and the gate "something changed" was always true because `_write_baseline`
  rewrites `written_at` nightly (verified update_season.py:108–119, 205–211) → a full push every
  night. Its `--verify` and sequence-exclusion insights are kept (step 5).
- Logical replication: publisher is a NAT'd laptop that sleeps; an open subscription keeps the
  Neon compute awake (0.25 CU x 744 h = 186 CU-h/month vs 100 free); replicates ingest_runs.
- Neon branch swap / `ALTER DATABASE RENAME`: proprietary or needs zero live connections.

### 3.4 Credential and failure modes
`REMOTE_DATABASE_URL` (role **f1_push**, direct endpoint,
`sslmode=verify-full&sslrootcert=system`) lives in `~/.config/f1analytics/remote.env`; the
script REFUSES unless the file is mode 600 and owned by the user; the tracked plist gains only
`HOME`. The value is never in git, the plist, shell history, or Vercel.

| failure | outcome | why production stays consistent |
|---|---|---|
| Push dies mid-COPY (sleep, Wi-Fi, Neon restart) | remote transaction rolled back on disconnect; `push: aborted after Ns, remote unchanged`; exit 1 | single transaction + MVCC |
| Neon unreachable | 3 retries then `PUSH FAILED: N sessions behind`; footer keeps the last `Data as of` | stateless diff re-pushes next night |
| Local ingest/derive newly failed, or growth guard tripped | step 4 skipped: `push: skipped because this run reported failures` | only a guard-signed corpus is published |
| Schema behind on Neon | exit 2 before writing a row, names `scripts/neon_migrate.sh` | loud stall, never wrong numbers |
| Laptop asleep at 03:20 | launchd runs at next wake; laptop OFF skips a day | optional `sudo pmset repeat wakeorpoweron MTWRFSU 03:15:00` |
| Two writers | impossible: push runs inside `output/update_season.lock`; manual CLI takes the same lock, exit 2 if held | one writer both ends |
| Render straddles COMMIT | one render may mix R17 race list with R16 standings, once per race | stated; existing rows never change (growth guard) |
| Push bug corrupts remote | step 5 reports; rollback below | — |

**Rollback**: nightly `output/snapshots/f1-YYYYMMDD.dump` (31 MB, last 7, written before step
1). `docker exec -i f1-postgres pg_restore --clean --if-exists` locally, then
`push_remote.py --full` (remote converges in one transaction, ~10 min). `push_remote.py
--sessions 2026:17` deletes one session from all 35 tables remotely before the morning.
Production has no state of its own except `ask_query_log`/`ask_answer_cache`, never touched.

**Freshness**: migration 0011 adds `data_release`; the root layout renders `Data as of
<pushed_at>` from one 1-row query; the fixture carries a row so the a11y baseline sees a fixed
string. The user never tails a log to know production moved.

## 4. Public exposure: ask box, roles, never-deploy list, public vs protected (D2–D5)

### 4.1 The ask box in public (D2): ships OFF; the key is the last act
What holds on Vercel, checked against the code:
- **Global daily budget** `ASK_DAILY_BUDGET_USD`: summed from `ask_query_log` on Neon through
  `f1_ask_log` before every call; `lib/ask/log.ts` fails CLOSED (503 `offline`) if the counter
  cannot be read. This is THE control.
- **Per-session 20 questions**: cookie + DB count. Holds.
- **Per-IP 6/min, burst 3**: an in-process token bucket; on Vercel each function instance has
  its own, so it is **per instance — pacing, not a control**. The runbook says so (graft).
- **Roles**: `f1_ask` SELECT on the `ask` views only, nothing in `public`; `f1_ask_log`
  INSERT-only. Unchanged by hosting.
Decisions:
1. Production launches with **no `ANTHROPIC_API_KEY`**. `lib/ask/anthropic.ts` → `no_key` →
   the MODE3 §8.5 failure UI (a11y-tested, no 500); everything else works. $0.00.
2. Before the key: `ASK_DAILY_BUDGET_USD=2.00` and a fresh `ASK_IP_SALT` are already set in
   Vercel (the $5 default is the laptop's number); `ASK_DATABASE_URL`/`ASK_LOG_DATABASE_URL` are
   set so `askPool.ts`'s identity assertion is proven on Neon with the key absent; the Anthropic
   console monthly spend limit is set to **$62 (= 2.00 x 31)** as the out-of-band tripwire
   that survives a bug in the log path.
3. Turning it on = one `vercel env add ANTHROPIC_API_KEY production < file`, only after
   `db_ask_verify.sh` passes 32/32 against Neon (§4.2).
**Worst-case cost if ON**: tripwire x 31 = **$62/month** at $2.00 ($155 at the $5 default), plus
at most one in-flight burst between the sum and the call (≈ 2 slots x ~$0.02). Expected hobby
traffic: 10 questions/day x ~$0.017 ≈ **$5/month**; 50/day ≈ $26.

### 4.2 The roles on Neon (D3), without make and without a host psql
Neon has no superuser; the console-created owner role is a `neon_superuser` member. Roles
created by SQL are NOT (the property wanted; the runbook says so nobody "fixes" it). The
container's `psql` speaks TLS and resolves the internet, so every Makefile recipe works with a
different connection string:
```
docker exec -i f1-postgres psql "$NEON_OWNER_URL" -v ON_ERROR_STOP=1 \
  -v ask_password="$ASK_PW" -v ask_log_password="$LOG_PW" -f - < scripts/sql/0005_roles.sql
```
Required changes (WP-4):
- **Database must be named `f1`** in the Neon console (`0005_roles.sql` names it literally).
- **Guard the two cluster-level REVOKEs** (`0005_roles.sql:59–60`): `REVOKE ALL ON DATABASE
  postgres FROM PUBLIC` aborts on Neon (no such database visible) and under `ON_ERROR_STOP`
  rolls back the whole file, leaving PUBLIC grants in place (Risk 4). Wrap both in the file's
  own `\gexec` idiom: `SELECT 'REVOKE …' WHERE EXISTS (SELECT 1 FROM pg_database WHERE
  datname='postgres') \gexec`. Same behaviour locally, no-op remotely.
- **`0011_web_role.sql` — `f1_web` (MANDATORY)**: LOGIN, NOINHERIT, USAGE on `public`, SELECT on
  all tables in `public` (+ `ALTER DEFAULT PRIVILEGES` for future tables), USAGE on `ask`
  (footer reads nothing there; included for `db:smoke`), `default_transaction_read_only=on`,
  `statement_timeout=10s`, CONNECTION LIMIT 20. Vercel's `DATABASE_URL` is `f1_web`, never the
  owner. The only writes in `web/` are `lib/ask/log.ts` over `ASK_LOG_DATABASE_URL` (MEASURED).
- **`0012_push_role.sql` — `f1_push` (NEW, least privilege for the nightly credential)**: LOGIN,
  NOINHERIT, no CREATEROLE, USAGE on `public`, SELECT/INSERT/DELETE on every F1 table in
  `public` EXCEPT `ask_query_log`/`ask_answer_cache` (no grant at all), INSERT on
  `data_release`, USAGE on `data_release_release_id_seq`, `lock_timeout=30s`, CONNECTION LIMIT
  2. A laptop compromise can corrupt data but cannot read the ask log, mint roles, or change
  grants. The owner URL is used only interactively (migrations, roles) and is never stored.
- **`scripts/db_ask_verify.sh`**: the 32-assertion `ASK_VERIFY_SH` block extracted from the
  Makefile, taking `OWNER_URL`/`ASK_URL`/`LOG_URL` env vars, plus two new assertions:
  `has_schema_privilege('f1_ask','public','USAGE') = false`,
  `has_schema_privilege('f1_web','public','USAGE') = true and INSERT denied`. The two
  Neon-specific expectations (`CONNECT` to `postgres`, `pg_read_file`) assert "denied for any
  reason". It is the GATE before `ASK_DATABASE_URL` is ever set in Vercel.
- **Endpoints**: `f1_ask` on the **DIRECT** endpoint (`lib/ask/execute.ts` forces the extended
  protocol with a named prepared statement and `askPool.ts` cancels by `pg_backend_pid()` from a
  second connection — session state PgBouncer cannot promise; `max: 2` vs CONNECTION LIMIT 4
  fits). `f1_web` and `f1_ask_log` on the **pooled** (`-pooler`) endpoint: role-level `ALTER
  ROLE … SET` GUCs apply at server-connection start and survive transaction pooling.
- **TLS**: `sslmode=verify-full` in every Vercel DSN (pg 8.23 treats `require` as a deprecated
  alias and prints a SECURITY WARNING on every cold start); the container's psql/pg_restore and
  `push_remote.py` use `sslmode=verify-full&sslrootcert=system`.
- Passwords: `openssl rand -base64 24` on the laptop, captured to shell variables, entered with
  `vercel env add NAME production < file` (never on a command line), never written to the repo.
- New tables created by a later migration lack `f1_web`/`f1_ask` grants until
  `0005_ask_views.sql`/`0011_web_role.sql` are re-run — `scripts/neon_migrate.sh` does both.

### 4.3 What must NEVER be deployed (D4), and what enforces it
| item | enforcement |
|---|---|
| `cache/` (8.5 GB), `output/`, `.venv/`, `db/*.dump`, `.pytest_cache` | root `.gitignore` (already); Vercel only sees git |
| `web/.env.local`, any `.env*` except `.env.example`; root `.env.remote` | `web/.gitignore` has `.env*` + `!.env.example`; root `.gitignore` gains `.env*` + `!**/.env.example`; NEW invariant in `scripts/check-invariants.mjs`: fail if `git ls-files` lists any `.env*` other than `.env.example` |
| `~/.config/f1analytics/remote.env` (the one credential that can write production) | outside the repo; mode 600 asserted by `push_remote.py`; the tracked plist carries only `HOME` |
| `f1lab/`, `tests/`, `scripts/`, `db/`, `docs/`, `notebooks/`, `Makefile`, `docker-compose.yml` | Vercel **Root Directory = `web`**; plus `web/.vercelignore` listing `tests/ scripts/ drizzle/` so they are not even uploaded |
| `web/drizzle/*.sql` executed by a deploy | Build Command is `next build` only; `db:migrate` runs only from the laptop via `neon_migrate.sh` |
| Secrets in the client bundle | no `NEXT_PUBLIC_*` exists; NEW invariant bans introducing one |
| Production env into previews | every var scoped **Production only**; Ignored Build Step `[ "$VERCEL_ENV" != "production" ] \|\| git diff --quiet HEAD^ HEAD -- .` (run in `web/`) skips previews and Python-only commits |
| the three tracked tool-config files listed in `output/rule1_scrub.txt` (one editor launch config, two agent-instruction files) | rule 1: `git rm --cached` + `.gitignore` in WP-1 BEFORE `gh repo create`; §9-D1 on history |
| `ingest_runs` data, `session_ingests.error`, `ask_query_log`, `ask_answer_cache` data | `EXCLUDE_TABLES` in `push_remote.py`, shared by `publish_fixture.sh`, asserted by `tests/test_push_remote.py` |
| `data_release.source_host` | column does not exist (dropped from ops-first's 0011) |
| `lib/ask/schema-doc.txt` must be INCLUDED | `outputFileTracingIncludes: {"/api/ask": ["./lib/ask/schema-doc.txt"]}` in `next.config.ts`; verified by one real question on the first authenticated deploy |

### 4.4 Public or protected (D5)? Recommendation: **public**, behind Vercel Authentication until the gates pass
| option | plan | who gets in | $/month | trade-off |
|---|---|---|---|---|
| **Public** (`*.vercel.app`, custom domain ~$12/yr optional) | Hobby | everyone | $0 | crawlers wake Neon and spend egress (§5); the ask box stays OFF or budget-capped. Nothing on the site is private: public timing data, read-only, no accounts, IPs salted+hashed |
| Vercel Authentication (Standard Protection, "All Deployments") | Hobby, free on every plan | the Vercel account owner only | $0 | one dashboard toggle, no code; cannot show a friend; blocks the a11y run against production |
| Vercel Password Protection | **Pro**: $20/month seat + $20/month per protected project | anyone with the password | **$40** | 40x the rest of the bill for a shared password (the "$150 add-on" is a legacy package) |
| App-level gate (`web/proxy.ts`, HMAC cookie, `SITE_PASSWORD`) | Hobby | anyone with the password | $0 | ~40 lines on every request; an unaudited auth layer on a project whose ask box was designed as if the model were an attacker; a passphrase in a group chat |

**Decision**: public. Vercel Authentication is ON for every deploy from the first `vercel link`
until (a) `db_ask_verify.sh` 32/32 on Neon, (b) the first push has verified, (c) the a11y suite
has passed against the authenticated deployment via a bypass token, (d) `Data as of` renders.
Then one toggle makes it public — no code, no env var to remember to remove (cost-first's
`vercel env rm SITE_PASSWORD` after 48 h is a remembered step; rejected). If the user later
decides "not public", the same toggle is the mechanism. The app-level gate is NOT built.
`web/app/robots.txt` disallows `/race/*/telemetry` and `/ask` from day one (egress, §5).

## 5. Cold starts and cost in dollars (D6, D7)

### 5.1 What the first visitor after idle experiences (D6)
Facts: Neon Free autosuspends after **5 minutes** with no connections (fixed on Free; wake
~0.5–1 s, occasionally a few seconds). Vercel function cold start for this app ~0.3–0.8 s (`pg`
externalised; `libpg-query` WASM loads only in the ask route). Every route is `force-dynamic`
(`app/layout.tsx:30`); there is **no `loading.tsx` anywhere under `web/app`** (verified);
nothing is cached. So the first request after ≥ 5 idle minutes blocks the whole render on
cold start + Neon wake + the page's queries on a cold buffer cache: **EST 1.5–3 s of blank tab
for `/`, 4–7 s for `/race/2026/13/telemetry`**; the next navigations 200–800 ms; a visitor
6 minutes later pays the Neon wake again. On a hobby site most first visits are cold visits,
and a blank tab is indistinguishable from a dead site.

Mitigations, cheapest first:
| # | mitigation | $/month | effect | decision |
|---|---|---|---|---|
| 1 | `app/loading.tsx` skeleton shell (title, nav, "loading the timing data…") | $0, ~20 lines | frame paints in ~200 ms; content streams when Neon wakes | **day one** (WP-5) |
| 2 | `Data as of <pushed_at>` footer (§3.4) | $0 | the wait reads as honest, not broken | day one |
| 3 | `export const revalidate = 600` on the data pages (`/api/ask` stays `no-store`), or Cache Components `cacheLife("hours")` | $0 | repeat views within 10 min never touch Neon; also the fix for the egress cliff | **after the first fortnight's Neon reading** shows > 20 CU-h or > 1 GB egress; it changes the sentence "every route is force-dynamic" to "recomputed within 10 min of a push", which is a deliberate contract change, not a default |
| 4 | keep-alive pinger every 4 min | "$0" | none: 0.25 CU x 744 h = 186 CU-h vs 100 free → Neon suspends the project ~day 16 | **rejected** |
| 5 | Vercel Cron keep-warm | — | Hobby crons run once per day | useless |
| 6 | Neon Launch, scale-to-zero off | 0.25 CU x 744 h x $0.106 ≈ **$19–20** | no Neon cold start | not for a hobby site |

### 5.2 Cost per month at hobby traffic (D7)
| component | plan | $/month | free boundary | first thing that crosses it |
|---|---|---|---|---|
| Vercel (web) | Hobby (non-commercial — this is) | **$0** | 100 GB fast data transfer, 1M function invocations, 4 h active CPU, 100 deploys/day | a crawler storm (~290k dynamic renders/month at ~50 ms CPU); project is *paused*, not billed |
| Neon (Postgres) | Free | **$0** | 0.5 GB storage, **100 CU-h/month**, **5 GB/month egress**, 10 branches, 6 h restore window | **egress**: the heaviest page pulls ~300 KB of rows (MEASURED: one session's `lap_telemetry` 259 KB + `lap_corner_speeds` 25 KB) → ~15,000 heavy views/month, or one crawler looping 71 telemetry pages hourly (71 x 0.3 MB x 720 ≈ 15 GB); **compute**: 100 CU-h = ~13 awake hours/day at 0.25 CU — fine for sporadic traffic, fatal for any keep-alive. Both fail SAFE: compute suspends until the next cycle. Storage: ~102 MB restored, +~4 MB per race → two more seasons; `VACUUM (ANALYZE)` after any `--full` push |
| GitHub (private repo + Actions) | Free | **$0** | 2,000 Actions min/month; Releases and the 10 GB cache unmetered | ~18–25 billed min/push (four jobs) → 80–110 pushes/month; overage $0.008/min |
| Anthropic (ask box) | pay-as-you-go | **$0 while OFF**; ~$5 expected when on | none — the tripwire IS the boundary | **$62/month** ceiling at `ASK_DAILY_BUDGET_USD=2.00` (console spend limit = same) |
| Domain (optional) | — | ~$1 (≈ $12/yr) | `*.vercel.app` is free | — |
| **Total** | | **$0/month at launch; ~$5 with the ask box on; hard ceiling $62 + domain** | | |

**The first thing that pushes it off the free tier**: Neon egress (a shared link that brings
~15k telemetry views, or a crawler), then Neon compute (any keep-alive). `robots.txt` on
`/race/*/telemetry` and `/ask` (day one) and the 10-minute page cache (§5.1 #3) each cut
egress by an order of magnitude at $0. If it does leave Free: Neon Launch has no minimum,
0.25 CU x ~200 awake h ≈ 50 CU-h x $0.106 ≈ $5.30 + storage $0.10 ≈ **$5.40/month**; Vercel
Pro ($20) is the next cliff and nothing in this design needs it.
Not costing money though easy to assume so: preview deployments (skipped anyway), the a11y CI
job (GitHub minutes only), the 31 MB fixture, Neon branches (none used), Vercel Authentication.

## 6. Exact artefacts

### 6.1 `.github/workflows/ci.yml` — outline (no make, no secrets, no tool names)
```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
env: { F1_CI: "1", PYTHONDONTWRITEBYTECODE: "1" }
jobs:
  web:                                   # T0 — no services
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22.19.0", cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
      - run: npm run check:invariants    # incl. the two new rules: tracked .env*, NEXT_PUBLIC_
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test                # 260 tests, no key, no DB (MEASURED 0 skips)
      - run: npm run build               # exit 0, zero warnings; no DATABASE_URL set
      - uses: actions/upload-artifact@v4
        with: { name: next-build, path: web/.next, retention-days: 1 }
  py-pure:                               # T0 — no services
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13.5", cache: pip }
      - run: pip install -r requirements-ci.txt          # requirements.txt minus jupyter/matplotlib
      - run: python -m pytest tests -m "not db and not cache" -q -rs --junitxml=out/junit-pure.xml
      - uses: actions/upload-artifact@v4
        with: { name: junit-pure, path: out/junit-pure.xml }
  py-db:                                 # T1 — service + fixture + migrate + a11y
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: [web]                         # only for the .next artefact; py-pure stays parallel
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: f1, POSTGRES_PASSWORD: f1, POSTGRES_DB: f1 }
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U f1 -d f1" --health-interval 5s --health-retries 20
    env:
      DATABASE_URL: postgres://f1:f1@localhost:5432/f1
      F1_REQUIRE_DB: "1"                 # db-skip → pytest.exit(3)
      A11Y_BASE_URL: http://localhost:3000
      A11Y_REQUIRE: "1"                  # serverUp() skip → failure
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13.5", cache: pip }
      - uses: actions/setup-node@v4
        with: { node-version: "22.19.0", cache: npm, cache-dependency-path: web/package-lock.json }
      - run: pip install -r requirements-ci.txt
      - run: pg_restore --version | grep -q ' 16\.' || sudo apt-get install -y postgresql-client-16
      - id: pin
        run: cat tests/ci_fixture.txt >> "$GITHUB_OUTPUT"          # tag=…  sha256=…
      - uses: actions/cache@v4
        with: { path: out/fixture.dump, key: fixture-${{ steps.pin.outputs.sha256 }} }
      - run: test -f out/fixture.dump || gh release download "${{ steps.pin.outputs.tag }}" -p fixture.dump -D out
        env: { GH_TOKEN: "${{ github.token }}" }                  # read-only, same repo
      - run: echo "${{ steps.pin.outputs.sha256 }}  out/fixture.dump" | sha256sum -c
      - run: pg_restore -d "$DATABASE_URL" --no-owner --no-privileges out/fixture.dump   # MEASURED 3 s
      - run: python scripts/ci_fixture.py assert-not-newer          # fixture ledger <= web/drizzle/*.sql
      - run: cd web && npm ci && npm run db:migrate                 # PR migrations hit 178 real sessions
      - run: python scripts/ci_fixture.py assert-at-head            # ledger == repo migrations
      - run: createdb -h localhost -U f1 f1_empty && cd web && DATABASE_URL=postgres://f1:f1@localhost:5432/f1_empty npm run db:migrate
      - run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ask_password=ci-only-pw -v ask_log_password=ci-only-pw -f scripts/sql/0005_roles.sql
      - run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/0005_ask_views.sql
      - run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v web_password=ci-only-pw -f scripts/sql/0011_web_role.sql
      - run: python -m pytest tests -m "db and not cache" -q -rs --durations=15 --ignore=tests/test_mode2_model.py --junitxml=out/junit-db.xml
      - uses: actions/download-artifact@v4
        with: { name: next-build, path: web/.next }
      - run: cd web && (npm run start -- -p 3000 &) && python ../scripts/ci_wait.py http://localhost:3000/glossary 60
      - run: cd web && npm run test:a11y -- --test-reporter=junit --test-reporter-destination=../out/junit-a11y.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: junit-db, path: out/junit-*.xml }
  py-db-slow:                            # T1 — tests/test_mode2_model.py alone (MEASURED 217 s locally)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services: { postgres: <same block as py-db> }
    env: { DATABASE_URL: postgres://f1:f1@localhost:5432/f1, F1_REQUIRE_DB: "1" }
    steps:                               # checkout, setup-python, pip, cache+download+sha, restore, roles — same as py-db, then:
      - run: python -m pytest tests/test_mode2_model.py -q -rs --junitxml=out/junit-db-slow.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: junit-db-slow, path: out/junit-db-slow.xml }
  coverage:                              # rule 3 — the number and the floor
    runs-on: ubuntu-latest
    needs: [py-pure, py-db, py-db-slow]
    if: always()
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { pattern: junit-*, path: out, merge-multiple: true }
      - run: python scripts/ci_coverage.py out/*.xml --census tests/ci_census.json >> "$GITHUB_STEP_SUMMARY"
        # prints "ran N of 952 collected (P%) — not run in CI: 86 fixture-cache, 185 direct-cache"
        # exit 1 if N < floor, if any XML is missing, if a db-skip reason appears, or if a11y skipped > 0
```
The shared restore steps of `py-db`/`py-db-slow` live in `.github/actions/restore-fixture/action.yml`
(composite) so they are written once. Branch protection on `main` requires `web`, `py-pure`,
`py-db`, `py-db-slow`, `coverage`. README gets one badge (the workflow) and one paragraph
"what CI runs and what it does not", nothing else.

### 6.2 Vercel environment variables (every row **Production only**; Preview gets nothing)
| name | value / source | role, endpoint | when set |
|---|---|---|---|
| `DATABASE_URL` | `postgres://f1_web:…@<ep>-pooler.<region>.aws.neon.tech/f1?sslmode=verify-full` | `f1_web` SELECT-only, **pooled** (`db/client.ts` `max: 5` is fine behind PgBouncer) | step 7 |
| `ASK_LOG_DATABASE_URL` | `postgres://f1_ask_log:…@<ep>-pooler…/f1?sslmode=verify-full` | `f1_ask_log` INSERT-only, pooled | step 7 |
| `ASK_DAILY_BUDGET_USD` | `2.00` | — ($62/month ceiling) | step 7, BEFORE any key |
| `ASK_IP_SALT` | `openssl rand -base64 32` (never the local value) | — | step 7 |
| `ASK_DATABASE_URL` | `postgres://f1_ask:…@<ep>.<region>.aws.neon.tech/f1?sslmode=verify-full` | `f1_ask`, **direct** (named prepared statements + pid cancel) | step 10, only after `db_ask_verify.sh` 32/32 on Neon |
| `ANTHROPIC_API_KEY` | unset at launch | — | step 11, the last act; never Preview |
Never in Vercel: the owner DSN, `REMOTE_DATABASE_URL` (`f1_push`), anything from `.env.local`.
Values are entered with `vercel env add NAME production < file` (never on a command line).
Project settings (once, not env): Root Directory `web`; Framework Next.js; Build `next build`;
Install `npm ci`; Node 22.x; Ignored Build Step
`[ "$VERCEL_ENV" != "production" ] || git diff --quiet HEAD^ HEAD -- .`; Deployment
Protection: **Vercel Authentication, All Deployments = ON** until step 9.

### 6.3 Runbook: what the user does by hand after `vercel login` (once; ~1 h, mostly waiting)
Steps 0–3 need no Vercel login and can happen first. Every command is copied from here.
0. **Scrub (rule 1), before any remote exists**: run the four commands in
   `output/rule1_scrub.txt` (gitignored; it names the three tracked tool-config files, which
   this tracked spec deliberately does not): `git rm --cached` them, extend the root
   `.gitignore` (them + `.env*` + `!**/.env.example`), apply §9-D1 (history rewrite); commit.
   Check: the two grep lines at the bottom of that file both return 0 (attribution strings in
   history MEASURED today: 0).
1. **GitHub**: `gh repo create F1Analytics --private --source . --push`. Then
   `scripts/publish_fixture.sh` (cuts, scrubs, hashes, `gh release create fixture-<date>`,
   writes `tests/ci_fixture.txt`); commit that file with `db/trail_census_baseline.json`; push.
   First run: the coverage step prints `ran 681 of 952`. Branch protection on `main`:
   require `web`, `py-pure`, `py-db`, `py-db-slow`, `coverage`.
2. **Neon**: project `f1analytics`, region = Vercel's default (`iad1` ↔ AWS `us-east-1`),
   Postgres 16, **database `f1`**, owner role `f1`. Keep the owner direct DSN in a shell
   variable `NEON_OWNER_URL` for this session only; never write it to a file.
3. **Schema + roles on Neon** (container psql; no host psql, no make):
   `cd web && DATABASE_URL="$NEON_OWNER_URL" npm run db:migrate` (0000–0012) and back; then
   `ASK_PW=$(openssl rand -base64 24)` etc. for ask/log/web/push; then
   `docker exec -i f1-postgres psql "$NEON_OWNER_URL" -v ON_ERROR_STOP=1 -v ask_password=… -v ask_log_password=… -f - < scripts/sql/0005_roles.sql`,
   same for `0005_ask_views.sql`, `0011_web_role.sql` (`-v web_password`), `0012_push_role.sql`
   (`-v push_password`). Roles created by SQL are NOT `neon_superuser` — correct, leave it.
4. **Gate**: `OWNER_URL=… ASK_URL=… LOG_URL=… WEB_URL=… scripts/db_ask_verify.sh` → 32/32
   (+ the two new assertions). Non-zero exit blocks everything below.
5. **Initial load**: `docker exec -i f1-postgres pg_restore --no-owner --no-privileges -d
   "$NEON_OWNER_URL" < output/fixture.dump` (the §2 scrubbed dump; EST 3–5 min), then write
   `REMOTE_DATABASE_URL=postgres://f1_push:…@<ep>.<region>.aws.neon.tech/f1?sslmode=verify-full&sslrootcert=system`
   to `~/.config/f1analytics/remote.env`, `chmod 600`; `.venv/bin/python scripts/push_remote.py
   --verify-only` must print `remote == local` and the privilege invariants OK.
6. **Arm the nightly push**: `launchctl unload` the installed plist, `cp
   scripts/com.f1analytics.update.plist ~/Library/LaunchAgents/`, `launchctl load`;
   `.venv/bin/python scripts/update_season.py --season 2026 --dry-run` prints `push: nothing to do`.
7. **Vercel**: `cd web && vercel link` (new project `f1analytics`), `vercel git connect`
   (production branch `main`), dashboard settings of §6.2, Vercel Authentication ON, the four
   `vercel env add … production < file` rows marked step 7. `vercel --prod`. Log in; check `/`,
   `/race/2026/13/telemetry`, `/ask` (honest "off" state), footer `Data as of`.
8. **Release checks against the authenticated deployment** (protection bypass token from the
   dashboard, `VERCEL_AUTOMATION_BYPASS_SECRET`): `A11Y_BASE_URL=https://<app>.vercel.app npm
   run test:a11y` 107/107; `DATABASE_URL=<f1_web url> npm run db:smoke`.
9. **Launch**: Vercel Authentication OFF. Optionally the domain. Nothing else changes.
10. **Later, deliberately — ask box, part 1**: `vercel env add ASK_DATABASE_URL production <
    file`; redeploy; `/ask` still says "off"; `askPool.ts`'s identity assertion is now proven
    on Neon.
11. **Ask box, part 2**: Anthropic console spend limit = $62; `vercel env add ANTHROPIC_API_KEY
    production < file`; redeploy; ask one question; `ask_query_log` on Neon has one row with a
    sane `estimated_cost_usd`. Remember: the per-IP bucket is per Vercel instance — pacing only;
    the dollar tripwire and the console limit are the controls.
**Every day after**: nothing. Morning check when wanted: `tail -3 output/update_season.log` →
`push: nothing to do` | `push: OK n sessions` | `PUSH FAILED: …` | `SCHEMA BEHIND: run
scripts/neon_migrate.sh`. After a race: `update_season.py` step 5 commits the baseline and
re-publishes the fixture itself on a successful push (§6.4), so the tree is clean by morning.
When a migration lands: `scripts/neon_migrate.sh` (prompts for the owner URL; runs
`db:migrate` then re-applies the three GRANT files) BEFORE merging the web code that needs it.
Stuck night: delete `output/update_season.lock`, run `update_season.py --push-only`.
Rollback: §3.4.

### 6.4 The `scripts/update_season.py` change (~35 lines; the push lives in `scripts/push_remote.py`)
```python
REMOTE_ENV = Path.home() / ".config" / "f1analytics" / "remote.env"
ap.add_argument("--no-push", action="store_true", help="ingest and verify only; do not touch production")
ap.add_argument("--push-only", action="store_true", help="skip ingest/derive; diff-and-push what is local now")
ap.add_argument("--dry-run", action="store_true", help="print the push plan; write nothing remotely")
# step 4, after "growth, not drift", still inside the lock, before the "done" line
if not a.no_push:
    if failures:
        log.warning("push: SKIPPED because this run reported failures -- production is unchanged")
    elif not (remote := _remote_dsn()):          # env, else REMOTE_ENV; refuses unless mode 600
        log.info("push: no REMOTE_DATABASE_URL in %s -- local only", REMOTE_ENV)
    else:
        from scripts.push_remote import push
        rc, summary = push(local_dsn=DSN, remote_dsn=remote, full=False, retries=3, dry_run=a.dry_run)
        log.info("push: %s", summary)   # "nothing to do" | "OK 2 sessions, 41,377 rows, 38s" | "FAILED: …" | "SCHEMA BEHIND: …"
        if rc != 0:
            failures.append(f"push: {summary}")
# step 5, only when rc == 0 and sessions were pushed: keep the repo consistent without a human
        elif summary.startswith("OK"):
            _run(["git", "commit", "-qm", f"Baseline after {summary_sessions}", "--", str(BASELINE)], "commit baseline")
            _run(["scripts/publish_fixture.sh", "--commit"], "re-publish CI fixture")   # writes tests/ci_fixture.txt, commits, pushes
```
`push_remote.py` (~250 lines, new): `EXCLUDE_TABLES`, `diff()`, `apply()` (one transaction),
`verify()`, `--full`, `--sessions YEAR:ROUND`, `--verify-only`, `--dry-run`, a snapshot to
`output/snapshots/` (last 7) before any run that will write. The tracked plist gains ONE
`EnvironmentVariables` key, `HOME=/Users/batuhanisik`, and nothing else; `docs/RUNBOOK.md`
"Unattended updates" gains the push paragraph and the corrected cache-dependence sentence.
`requirements-ci.txt` is `requirements.txt` minus jupyter/ipykernel/matplotlib.

## 7. Work packages: single-owner file ownership, sequencing, verification
No file appears in two packages. Commit messages describe the change; the author is
batuhanisik751; nothing names a tool.

| WP | owns (files) | delivers | verified by |
|---|---|---|---|
| **WP-1 Scrub + repo hygiene** | root `.gitignore`; removal of the three files in `output/rule1_scrub.txt` from the index; the §9-D1 history rewrite; `README.md` (badge + "what CI runs and does not") | rule 1 before the remote exists | the two grep checks in `output/rule1_scrub.txt` return 0 on `git ls-files` and on `git log --all --name-only`; `git log -p --all \| grep -ic 'co-authored\|generated with'` 0 |
| **WP-2 Markers + gate** | `tests/conftest.py` (`F1_CI` skip in the four session fixtures; `F1_REQUIRE_DB` → `pytest.exit(3)`), `pyproject.toml` (marker `cache`), `tests/ci_census.json`, the `@pytest.mark.cache` marks: whole-file `test_quali_clean`, `test_quali_frames`, `test_ingest_cli`, `test_ingest_hungary`; per-test `test_derive` x2, `test_guards` x2, `test_quali_ingest` x5, `test_sim` x1, `test_telemetry` x1, `test_moments` x1 (line 372), `test_sim_db::test_idempotent`; `requirements-ci.txt` | §1.1, §1.3 | `F1_CI=1 pytest tests -m "not db and not cache" -rs` locally prints exactly 462 passed / 84 skipped; `F1_CI=1 F1_REQUIRE_DB=1 pytest -m db` against a STOPPED Docker exits 3, not 0 |
| **WP-3 Fixture** | `scripts/publish_fixture.sh`, `tests/ci_fixture.txt` | §2.3 (scrub set read from `push_remote.EXCLUDE_TABLES`, `session_ingests.error` nulled, `wp_model_artifact` kept, dirty-tree refusal, `--commit` mode) | restore the asset into a fresh scratch container: `SELECT count(*) FROM ingest_runs` = 0, `SELECT count(*) FROM session_ingests WHERE error IS NOT NULL` = 0, `wp_model_artifact` rows > 0, ledger 11; `strings fixture.dump \| grep -c /Users` = 0 |
| **WP-4 CI** | `.github/workflows/ci.yml`, `.github/actions/restore-fixture/action.yml`, `scripts/ci_fixture.py`, `scripts/ci_wait.py`, `scripts/ci_coverage.py` | §6.1 | first run's summary prints `ran 681 of 952`; a deliberate PR that `--ignore`s one db file goes RED on the floor; a PR adding a no-op migration 0013 goes green with `assert-at-head` |
| **WP-5 Web hooks** | `web/tests/a11y/dom.ts` (`A11Y_REQUIRE`), `web/scripts/check-invariants.mjs` (tracked `.env*` rule, `NEXT_PUBLIC_` ban), `web/next.config.ts` (`outputFileTracingIncludes`), `web/package.json` (`test:a11y` reporter passthrough), `web/.vercelignore`, `web/app/loading.tsx`, `web/app/robots.ts`, `web/app/layout.tsx` (footer), `web/lib/queries/release.ts`, `web/.env.example` (endpoint comments), a11y captions baseline regen (once, for the footer string) | §1.3, §4.3, §5.1, §3.4 freshness | `A11Y_REQUIRE=1 npm run test:a11y` with no server FAILS; `touch web/.env.ci && git add -N` → `check:invariants` exit 1; `npm run build` zero warnings; `test:a11y` 107/107 locally |
| **WP-6 Schema + roles SQL** | `web/drizzle/0011_data_release.sql` + `web/db/schema/` entry (no `source_host`), `scripts/sql/0005_roles.sql` (the two `\gexec` guards only), `scripts/sql/0011_web_role.sql`, `scripts/sql/0012_push_role.sql`, `scripts/db_ask_verify.sh` (extracted; the Makefile target becomes a one-line call), `scripts/neon_migrate.sh` | §4.2 | every SQL file applies twice locally (idempotent); `db_ask_verify.sh` 34/34 against Docker; `has_table_privilege('f1_web','laps','INSERT')` false; `has_table_privilege('f1_push','ask_query_log','SELECT')` false; `has_schema_privilege('f1_ask','public','USAGE')` false |
| **WP-7 Push** | `scripts/push_remote.py`, `tests/test_push_remote.py` (pure: `EXCLUDE_TABLES`, the `error` scrub, FK order from a fake catalogue, classification refusal), `scripts/update_season.py` (steps 4–5 + three flags), `scripts/com.f1analytics.update.plist` (`HOME`), `docs/RUNBOOK.md` (§9 production, push paragraph, corrected cache sentence, the per-instance bucket sentence) | §3, §6.3, §6.4 | against a SECOND local Docker DB `f1_remote` before Neon exists: `--full` then `--verify-only` = equal; insert one fake session locally → push moves exactly that session; re-derive a session with the same row count → fingerprint changes → it is re-pushed; `kill -9` mid-COPY → `f1_remote` counts unchanged; `ask_query_log_ask_id_seq.last_value` untouched; `remote.env` at mode 644 → refusal |
| **WP-8 Provisioning** (the user, nothing in the repo) | — | §6.3 steps 1–11 | `db_ask_verify.sh` 34/34 on Neon; `push_remote.py --verify-only` `remote == local`; a11y 107/107 against production; the next real race (Azerbaijan, 26–28 Sept) appears on the site by the Monday log line `push: OK` with no human action |

### Sequencing (each step ends with something observable)
WP-1 → (WP-2 ‖ WP-5 ‖ WP-6) → WP-3 (needs 0011 so the fixture carries a `data_release` row)
→ WP-4 → `gh repo create` + fixture publish + branch protection → **first run prints
`ran 681 of 952`** → WP-7 (tested against `f1_remote`, no Neon needed) → WP-8 steps 2–6 →
**`push: nothing to do` from launchd** → WP-8 step 7 (Vercel, authenticated) → 8 → 9 (public)
→ one fortnight of Neon CU-h/egress readings → decide §5.1 #3 (`revalidate`) → 10 → 11.
Nothing in WP-1..7 needs Neon or Vercel; nothing in CI needs a secret.

### Definition of done
(1) CI green with the summary stating `ran 681 of 952` and the two not-run counts; (2)
`push_remote.py --verify-only` prints `remote == local` + privilege invariants OK against Neon;
(3) `db_ask_verify.sh` 34/34 on Neon; (4) production renders `/`, `/race/2026/13/telemetry`,
`/ask` (honest off state), footer = last push; (5) the next race appears with no human action;
(6) `git ls-files` and the GitHub repo name no tool.

## 8. Risks (top 5)
1. **Rule 1 and history.** Three tool-config files (`output/rule1_scrub.txt`) are tracked
   in all 8 commits (verified). Removing them going forward is one commit; removing them from
   history is a `git filter-repo` before the first push — cheap now (no remote, sole author),
   impossible to do quietly later. Decided in §9-D1. Product facts that name the model the ask
   box calls (`ASK_MODEL`, the README `/ask` row) are not attribution; the user decides.
2. **`test_mode2_model` on a 2-vCPU runner.** MEASURED 217 s locally (160 s teardown refit);
   EST 5–10 min in CI, its own parallel job so never on the critical path. If it measures
   > 12 min it moves to `main`-only, counted and printed by the coverage step — never dropped
   silently. Billed minutes are the real cost (~18–25/push).
3. **`0005_roles.sql` on Neon.** Two cluster-level REVOKEs fail without superuser; a swallowed
   error would leave PUBLIC grants in place. The `\gexec` guards raise NOTICE, never skip
   silently; `db_ask_verify.sh` is a hard gate before the initial load; `push_remote.py
   --verify` re-asserts the two `has_schema_privilege` invariants every night.
4. **Neon free-tier cliffs via crawlers.** Public + `force-dynamic` + 5 min autosuspend: a
   polite crawler can keep compute awake all day (100 CU-h) or loop the 71 telemetry pages
   (5 GB egress). Both fail safe (suspend, not bill). Order: `robots.txt` day one → measure a
   fortnight → `revalidate = 600` on the data pages. Never a keep-alive.
5. **Fixture staleness and the nightly commit.** A migration merged without re-publishing is
   caught by `assert-not-newer`/`assert-at-head`; a DATA change a test asserts on is not — CI
   goes red on a true-but-stale number, and `update_season.py` step 5 now commits + re-publishes
   automatically after a successful push, which means the nightly job runs `git commit` and
   `git push`. If that push fails (no network, protected branch), the log says so and the tree
   is dirty until morning; `publish_fixture.sh` refuses on a dirty tree so it cannot compound.
   The runbook says: re-publish only after a green local `pytest`, never to make CI green.

## 9. Decisions log (one line each)
- **D1 History rewrite**: YES — run the `git filter-repo --invert-paths` line from
  `output/rule1_scrub.txt` in WP-1 before `gh repo create`; 8 commits, sole
  author, no remote, 0 attribution strings today; the cost is one command now and unbounded later.
- **D2 CI classification**: per-test markers (correctness-first) over file-level `--ignore` lists
  (cost-first, ops-first) — both file-level designs were red on day one (the 9 "pure" files load
  the cache; test_moments:372 is db+cache).
- **D3 a11y in CI**: YES (correctness-first, cost-first) over ops-first's release checklist —
  107 tests on a checklist is a remembered step; ~2 billed minutes.
- **D4 Auto-migrate Neon from the nightly push vs least-privilege `f1_push`**: `f1_push` wins.
  DDL needs the owner; storing the owner URL unattended on the laptop widens the blast radius
  to roles and the ask log. The stall is loud (`SCHEMA BEHIND`, exit 2, `PUSH FAILED` line), and
  `neon_migrate.sh` is the one remembered step, tied to the moment a migration is written.
- **D5 Data path**: session-scoped diff (ops-first) over wire `pg_restore --clean`
  (correctness-first): ROW EXCLUSIVE vs ACCESS EXCLUSIVE, 3 MB vs 100 MB, and the always-true
  "changed" gate. Correctness-first's sequence exclusion and `--verify` are kept.
- **D6 Fingerprint**: cost-first's `status + analytics_status + census` over ops-first's row
  count, so same-count corrections propagate.
- **D7 `wp_model_artifact`**: kept in fixture and push (ops-first stripped it;
  test_winprob.py:384,461 read it). It is a model pickle, not PII.
- **D8 Credential location**: `~/.config/f1analytics/remote.env` mode 600 asserted (ops-first)
  over the plist's `EnvironmentVariables` (cost-first; readable via `launchctl print`).
- **D9 App's DATABASE_URL**: `f1_web` mandatory (correctness-first) — never the owner
  (cost-first), never optional (ops-first).
- **D10 `f1_ask` endpoint**: direct (correctness-first, ops-first) over pooled (cost-first).
- **D11 Public vs protected**: public, Vercel Authentication ON until gates pass (ops-first);
  no app-level `SITE_PASSWORD` gate (cost-first) because removing it is a remembered step.
- **D12 `revalidate`**: not on day one; decided after a fortnight's Neon reading (all three).
- **D13 `data_release.source_host`**: dropped.
- **D14 TLS**: `verify-full` everywhere; `sslrootcert=system` on the write path.
- **D15 Budget**: `ASK_DAILY_BUDGET_USD=2.00` ($62 ceiling) over cost-first's 1.00 — the
  expected spend is ~$5, and a $31 ceiling trips on one shared link; re-evaluate after a week.
- **D16 Billed minutes**: stated as 18–25/push (four jobs each pay setup), not "12".
- **D17 Nightly commit of baseline + fixture**: done by `update_season.py` step 5 on a
  successful push (solo-operability graft) — accepted that launchd now runs `git push`.

## 10. As built

### 10.1 Incident, 2026-09-21: owner credential exposed during first setup
While applying `neon_migrate.sh`, the Neon owner DSN was `source`d from a dotenv file. Its `&`
separators were parsed as shell job control, splitting the value and printing the password in
bash's job-completion output — into the session transcript. Consequence: the `neondb_owner`
password is treated as compromised and must be rotated **before** any migration runs against
it; the rotation is a secret-store write and is performed by the user (Neon console, which also
re-syncs the Vercel-managed env var) rather than by tooling. Rule recorded in `RUNBOOK.md`
(production section) and in §3.4's credential handling: credential files are read by Python or
`grep`, never sourced; values are single-quoted; DSNs are one argv element. No data was loaded
and no role existed at the time, so the blast radius is the empty owner database.

### 10.2 What the first deployment corrected in this document
- **§4.2 role SQL assumed the database is named `f1`.** Nine `ON DATABASE f1` statements; Neon's
  is `neondb`. All now use `current_database()` via `\gexec`. The one guarded revoke was guarded
  on the wrong condition (a database *named* `f1`), so on Neon it skipped; now unconditional.
- **`temp_file_limit` is superuser-only**; attempted and skipped with a NOTICE on a managed host.
- **The gate is 35 checks, not 34**, and on a managed host 3 skip on the record (the provider-owned
  `postgres` database). `ask.laps is readable` was data-dependent and could never pass before the
  first load; it now asserts the privilege, not a row.
- **F9 was half right.** `sslmode=verify-full&sslrootcert=system` is correct for libpq and
  **fatal for node-postgres**, which opens `sslrootcert` as a file. The rail caught it. §6.2's env
  table is therefore: node shape (`verify-full` only) for every Vercel value.
- **The `f1-postgres` container has no CA bundle**; `verify-full` needs `ca-certificates`
  installed (done by hand; durable compose fix is a follow-up).

### 10.3 First production deployment, 2026-09-21
- **Neon** via the Vercel marketplace, plan Free, `us-east-1`, database `neondb`; the terms
  acceptance is a browser step the CLI cannot perform (`integration_terms_acceptance_required`),
  and the marketplace attaches the **owner** DSN to Production — replaced by `f1_web` before the
  first deploy, and `DATABASE_URL_UNPOOLED` removed from Production.
- **Gate on Neon:** 32 passed, 0 failed, 3 skipped (provider-owned `postgres` database).
  **Load:** `push_remote.py --full` — 178 sessions, 274,435 rows, 14 s. **Verify:** remote == local.
- **Env (Production only):** `DATABASE_URL` (f1_web, pooled), `ASK_DATABASE_URL` (f1_ask, direct),
  `ASK_LOG_DATABASE_URL` (f1_ask_log, pooled), `ASK_IP_SALT`, `ASK_DAILY_BUDGET_USD=2.00`. No
  `ANTHROPIC_API_KEY` (F7). All in the node-postgres shape.
- **Vercel Authentication ON** (`ssoProtection: all`) before the first deploy (F8).
- **First deploy attempt failed on my invocation, not the config:** `vercel deploy --prod` run from
  inside `web/` uploads `web/` as the root, and Vercel then looks for `web/web`. The git
  integration builds from the repository root and is the correct path; the push-triggered build
  compiled in 46 s with zero errors. Rule: never run `vercel deploy` from inside the root directory.
- **URLs:** https://f1-analytics-lac.vercel.app and
  https://f1-analytics-batuhanisik751s-projects.vercel.app (both 302 → login while protected).
- **Public since 2026-09-21** (`ssoProtection` removed) once every route answered 200 with verified
  content from outside: `/`, `/accuracy`, `/season/2026`, `/race/2026/13/telemetry`, `/ask`, `robots.txt`.
  The ask box stays OFF by the user's decision; no `ANTHROPIC_API_KEY` exists in production.
- **`/ask` off state, found after going public:** with no key the page rendered the full form and
  only answered `no_key` after a submit, and the failure copy said "Couldn't reach Claude" — untrue,
  the model is deliberately absent. Now the page decides server-side via `askKeyPresent()`: a
  `role="status"` banner states the box is switched off and why, the form renders inert (every
  pinned string stays in the DOM; nothing can be sent), and `no_key` has its own truthful copy.
  This is definition-of-done item (4)'s "honest off state", made honest before the question, not after.
- **Nightly:** the launchd job reloaded with `HOME`; `~/.config/f1analytics/remote.env` holds the
  `f1_push` DSN (mode 600). First unattended push expected the night after Azerbaijan (26 Sept).

### 10.4 The load that went to the wrong database
The first `push_remote.py --full` targeted `f1_remote` — WP-7's local test database — because
`~/.config/f1analytics/remote.env` still held the test credential: the chain that was meant to
rewrite it exited at a failed gate before the write, and the rebuilt chain omitted the write.
The push reported 178 sessions OK and `--verify-only` reported remote == local, both true of the
wrong database, while Neon had 0 rows and the site showed its empty state. Fixes: the tool logs
its credential source and target host on every run; a local host is refused without
`--allow-local`; the schema check compares hash sequences (the local ledger skips serial id 10);
and the runbook says to trust a content check over the tool's summary. Also found: host-side
libpq rejects `sslrootcert=system` (an explicit bundle is required), and `kill -9` leaves the
lock behind.

### 10.2b CI, first runs
Run 1 (`faf9358`): `web` failed at `npm run lint` — a step never run locally — on the reduced-
motion hook setting state inside an effect; `py-pure` passed; `py-db` skipped, `py-db-slow`
cancelled, `coverage` failed for want of reports. Fixed with `useSyncExternalStore` (`2566031`).
Run 2 (`2566031`): `web` and `py-pure` green; `py-db` ran 369 tests on the restored fixture, 367 passed, 1 skipped, and failed one: gate G1's `max|diff| == 0.0 ± 1e-9` measures 3.1e-8 on the Linux x86 runner (BLAS/FMA rounding) against 0.0 on Apple Silicon — tolerance widened to 1e-6, which still gates a wrong construction (`e0cfcf5`). Runs 3 and 4 were cancelled by my own pushes (`concurrency: cancel-in-progress`), which is why they read as failures; the first uncancelled run, `35558802581` on `1c9f97a`, was **green on all five jobs** and printed exactly the predicted line: **`ran 681 of 961 (70.9%) — not run: 83 fixture-cache, 197 direct-cache`**. Run 6 (`2c1b296`) had `py-db` green and `py-db-slow` **cancelled by its own 20-minute timeout** at 20:18 (the green run's took 16:54): `MODE2_BOOTSTRAP_JOBS = 8` oversubscribes a 2-vCPU runner. Timeout raised to 40 and BLAS threads capped at one per worker; the worker count stays, since it is in the assumption snapshot. **Run 7 (`1f80970`): all five jobs green; `py-db-slow` took 9 min 59 s** — the thread cap roughly halved it — and the line reads `ran 682 of 962 (70.9%) — not run: 83 fixture-cache, 197 direct-cache` (681 + the ledger test). Wall 10 min 17 s. Definition-of-done items (1), (2), (3), (4) and (6) are met; (5) — the next race appearing with no human action — is due the night after Azerbaijan, 26 Sept.
(empty — filled in by each work package as it lands, with the measured numbers that replace
every EST above: CI wall and billed minutes, `py-db-slow` on the runner, the initial load
time to Neon, the first fortnight's CU-hours and egress, first-hit latency for `/` and the
telemetry page.)

### 10.5 The paths filter (as built, 2026-09-22)
§1.2's T1 row said `py-db-slow` moves to `main`-only if it measured > 12 min; it measured 17 (then
10 after the thread cap), and §0 of IDEAS_2026-09 measured the real cost: ~10 min wall / ~20–25
billed per push, 7 of the first 9 runs cancelled by the next push. Built as the less blunt version
of that fallback, in `.github/workflows/ci.yml`:
- A `classify` job runs first (~10 s, `git diff --name-only` base..head; no third-party action, no
  extra permission). A run is **full** when the event is `schedule` or `workflow_dispatch`, when the
  base is unknown (new branch, force push, first push) or the diff fails, or when any changed path
  matches `f1lab/`, `db/`, `scripts/`, `tests/`, `web/lib/queries/`, `web/app/api/`, `web/drizzle/`,
  `web/db/`, `requirements*.txt`, `pyproject.toml`, `.github/workflows/ci.yml` or
  `.github/actions/`. Every other change (docs, README, web copy, components, captions) is **light**.
- Light: `web` + `py-pure` + `py-db`; only `py-db-slow` is skipped by `if:`. Run 7 measured the
  jobs at web 1.9 / py-pure 1.1 / py-db 4.6 / py-db-slow 16.2 min, so the slow job is the whole
  cost and `py-db` (which carries the a11y sweep) is cheap to keep. EST ~7 min wall / ~8 billed
  (to be MEASURED on the first light run). Full: unchanged, all five jobs.
- Nightly `schedule` at 09:30 UTC on `main` (after the laptop's 03:20 EDT push) is always full, so
  a web-only change that breaks a model test is caught within a day. The concurrency group now
  includes the event name so the nightly and a push do not cancel each other.
- **Rule 3 stays true**: `coverage` runs `if: always()`. On a full run it prints the `ran N of T`
  line and fails below the floor as before. On a light run it prints
  `light run: the slow model tier skipped by the paths filter (no model, schema, script or test change) — ran N of T without it, floor not applied; last full run: <link>`
  — the link is found with `gh run list` + the runs API (a run is "full" when its `py-db-slow`
  job concluded `success`), degrading to `none found yet`, never failing. The count is printed,
  the floor is not applied (it cannot be met without the slow tier); a slow XML that appears
  anyway is a WARNING (filter and `if:` disagree). An empty `mode` (classify cancelled) is read
  as full and fails on the missing XML.
- The a11y sweep (107 checks) rides inside `py-db` and therefore runs on every push, light or
  full; that is why `py-db` was kept out of the gate.
