# F1 Analytics

[![CI](https://github.com/batuhanisik751/F1Analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/batuhanisik751/F1Analytics/actions/workflows/ci.yml)

**Live site: https://f1-analytics-lac.vercel.app** · **Status: complete** (22 September 2026 — see [Status](#status)).

A read-only Formula 1 statistics site over precomputed Postgres tables. Python (`f1lab`)
pulls timing data through [FastF1](https://github.com/theOehrly/Fast-F1), cleans it, and
computes every analytic at ingest time; a Next.js app renders the pages by selecting rows,
with every read cached at the query layer and purged when new data lands. Nothing is
computed on request beyond counting, formatting and sorting, and every number on the site is
shown next to the assumptions it depends on — including, on its own page, how often the
site's forecasts have been wrong.

Three seasons (2024–2026), 178 sessions, 92,963 laps, 76 tables, 13 migrations, 17 specs.
The numbers a sceptic will look for first: the win-probability model removes 15.8 % of the
grid-position baseline's error out of sample (33.4 % in sample, shown for contrast); its
finishing-position ranges contained the finish 94.7 % of the time by being 15 places wide on a
20-car grid, and a grid slot ±7 places with no model scores better; the end-of-season points
range held 14 % of first-quarter projections in 2024 against 80 % promised. All three are on
[`/accuracy`](https://f1-analytics-lac.vercel.app/accuracy), in the site's own words.

It grew out of a single-race notebook (`notebooks/01_one_race.ipynb`, still runnable) whose
pipeline is now run for every race of 2024, 2025 and 2026 and stored with full provenance.

```
FastF1 (cache/)  ──►  f1lab.ingest  ──►  Postgres 16 (Docker)  ──►  Next.js 16 (web/)
                      clean · pace · derive · season             /  /season  /race  /driver
```

**Quick start:** `docs/RUNBOOK.md` has the full procedure; the short form is

```bash
make db && make setup && make migrate           # Postgres, npm ci, Drizzle migration
make ingest SEASON=2025                         # then SEASON=2026, SEASON=2024
make web                                        # http://localhost:3000
```

Without `make`: `docker compose up -d`, `npm --prefix web ci && npm --prefix web run db:migrate`,
`.venv/bin/python -m f1lab.ingest --season 2025`, `npm --prefix web run dev`. The ingest needs the
FastF1 cache (`cache/`, ~10 GB for three seasons); it sleeps between loads and stops cleanly on a
rate limit.

## The pages

| Route | What it shows |
|---|---|
| `/` | **This week** first: the next race with its date, the title fight (the leader's simulated odds *with their band*, championship points and the simulated expected points kept on separate lines, how many drivers can still win on the arithmetic, the earliest clinch round) and the pre-qualifying favourites labelled as the weaker guide they are. Then the latest ingested race (podium, the site's own *fastest race pace* driver and the runner-up gap), a standings snapshot, and the season's completed races newest first with winner, fastest-pace driver and a *pace ≠ winner* marker. If the latest race has run and the nightly load has not, the strip and the footer say so in one sentence rather than presenting the previous round as current. |
| `/season/[year]` | Drivers and constructors standings after the last ingested round (sprint points shown separately); simulated title odds per driver after every round, with a bootstrap band; the exact magic numbers — points still available, the leader's margin, who is mathematically eliminated — in their own section, because arithmetic and a forecast must not read as one thing; and the full race list — pending rounds muted, failed ingests marked *data unavailable*, sprint weekends flagged. |
| `/race/[year]/[round]` | Result → pace → strategy → why → trust: classification; fuel-corrected race-pace box plot and table with a *stable* mark from the sensitivity analysis; tyre-strategy gantt in finishing order; degradation scatter with pooled per-compound slopes and per-stint fits (weak ones tagged *not a finding*); the strategy simulator (v1.1, below); race trace (gap to leader per lap with SC/VSC/red bands); teammate head-to-head bars; the fuel-constant sensitivity table; what the lap cleaning threw away; and the exact modelling assumptions the numbers were computed under. A per-lap win-probability river with its reliability curve and Brier baseline underneath, rule-detected race moments marked on the trace, and an optimal-stint break-even in the degradation section (v1.2). **A round that has not been raced shows a weekend preview on the same URL** — safety-car probability, expected pit loss, overtaking difficulty and a predicted finishing order — so a link shared before the race keeps working after it. |
| `/driver/[code]?season=YYYY` | Season summary tiles, pace rank and signed teammate gap by round, race-by-race table (mid-season team swaps highlighted), and one head-to-head card per teammate. **Compare with** any other driver (`&vs=CODE`): the raw same-race ledger — qualified ahead, finished ahead, faster fuel-corrected pace, points — each over the races where both have that number, with "same car not implied" inside every sentence, beside the model's car-removed contrast with its range; the two are allowed to disagree, and when the model cannot call it (no shared car, a range that includes zero) the page says so. Plus the v1.3 driver-vs-car slots: a driver rating with the car removed and its 5th–95th range, that rating re-fitted season by season, the four-skill panel in which two skills are measured and two are refused, the car-adjusted career, and the career-long team-mate table. |
| `/constructor`, `/constructor/[slug]` | Car pace per season with driver effects removed by the model rather than by averaging, in-season development as a single start-to-finish segment, and retirements per 1,000 racing laps split into a car part and a driver part — never called reliability, because the data record that a car stopped and never why. |
| `/season/[year]/was-it-the-car` | The season's drivers split into the part of a lap attributable to the car and the part to the driver, with the boundary drawn as a blur as wide as the split is uncertain; the car:driver spread as an SD ratio with its own interval; and a counterfactual control that starts empty. |
| `/race/[year]/[round]/telemetry` | **v1.7.** One lap per driver of 10 Hz car and position data: the circuit painted by speed, gear, throttle or brake; a two-driver delta trace showing where on the road one lap was quicker; speed, throttle-with-braking, gear and DRS on the same metres of road; and a corner-by-corner table of apex speed, minimum gear and braking point. The delta trace is aligned on chord distance along the (X, Y) trace and **prints its own closure error in milliseconds**, refusing to draw at all above 400 ms. It **exists only on qualifying and sprint-qualifying sessions** — a race lap gets the map, the stack and the corner card, and no cross-driver comparison, because traffic, fuel and tyre age are not controlled for. The tab is **absent, not empty**, on a session the telemetry pass has never run. |
| `/accuracy` | **How right were we.** Every forecast the site makes, scored on races the model had never seen: the win-probability skill against a grid-position baseline (in-sample beside out-of-sample, so the flattery is visible), its calibration curve, the finishing-position ranges' coverage *beside their width* and against a no-model "grid slot ± 7" comparator, the end-of-season points ranges scored by quarter of the season for every finished season, and a ledger of the previews as they stood before each race, copied the night they were computed and scored once the race is in. It is unflattering on purpose. |
| `/ask` | **The one generated page — switched off on the public site.** With a model key configured, you type a question in English and a hosted language model writes **one read-only SQL SELECT** against a curated schema of 64 views, the server validates it with the real PostgreSQL parser and runs it as an unprivileged role under hard limits, and the rows are rendered as a table, a chart or a single figure. **The SQL is always shown**, next to a plain-English method line derived from the query's own syntax tree — *1 view · no clean-lap filter · 20 rows* — so a reader who does not read SQL still sees what was and was not filtered. The model never states a number: every figure is a cell that came out of Postgres, and there is no second call that summarises the rows. A generated answer never looks like a precomputed one (dashed accent border, a persistent *generated* badge, and a link to the proper page when there is one). |

Every section renders an empty state with the stored reason when an analytic could not be
computed; pages 404 only when the season, race or driver itself does not exist.

**Race reports.** Each race page carries an optional four-paragraph written summary — result,
pace, strategy, the biggest swing — generated **once at ingest** by Python from that race's own
stored numbers, not at request time. Before a report is saved, a deterministic check confirms
that every number in it appears in that race's grounding bundle *and* is attached to the right
driver; a report that fails is refused rather than published. It is marked *generated*, it says
so again in a footer, and it is explicitly subordinate to the sections below it: where the two
disagree, believe the sections. A race with no report renders nothing at all, not an error.

**Where the architecture moves.** Every page on this site is a Server Component reading
precomputed rows, with no API route, no runtime inference and no secret — with exactly one
exception, `app/api/ask/route.ts`, which is the only file that may hold a model key or call a
model at request time. Generated SQL never reaches the database over a connection that can write
anything: it runs as a separate Postgres role holding **no grant at all** in the schema where the
real data lives. Both of those sentences are enforced by `make check-invariants` and
`make db-ask-verify`, which fail the build rather than relying on anyone remembering them.

## The data pipeline

1. **Schedule** — `seasons`, `events` and one `sessions` row per round for the race and for
   qualifying (plus a sprint and a sprint-qualifying row on sprint weekends) come from
   `fastf1.get_event_schedule`, so future rounds exist as *pending* before they happen.
2. **Per session** — `f1lab.ingest` loads the session from `cache/`, builds every frame in
   memory and writes them in one transaction: identity and colours as they were in that
   session (`session_teams`, `session_entries`, `compound_colours` — the web app never
   hard-codes a team colour), `results`, every raw lap with the cleaning verdict and the fuel
   correction (`laps`), the per-lap flag state and pit stops (`lap_status`, `pit_stops`,
   `stints`), and one table per analytic (`pace_ranking`, `degradation_fits`,
   `compound_degradation`, `teammate_deltas`, `fuel_sensitivity`, `lap_exclusion_report`).
   Weather and track-status streams are stored for later features. A **qualifying** session
   takes the same path with a different cleaning rule set and writes `quali_results` (the
   official Q1/Q2/Q3 and two different gaps to pole), `quali_segment_times` and
   `quali_teammate_h2h` instead of `results` and the race analytics.
3. **Per season** — `season.recompute` derives `driver_standings` / `constructor_standings`
   (a snapshot after every round, race + sprint points, full countback tie-break),
   `driver_season_summary`, `teammate_h2h` and `season_quali_h2h` from the stored rows alone.
4. **Provenance** — `ingest_runs` and `session_ingests` record status (`ok` / `partial` /
   `failed`), a per-analytic status, warnings, lap counts, code versions and the
   `assumption_sets` row (sha256 of every constant in `f1lab/config.py` plus the call-site
   parameters). Changing a constant makes a new, visible set; the season page flags a mix.

Ingest is idempotent per session and resumable per season: `--season YEAR` selects only
completed sessions that are not yet `ok`, and `--force` reproduces every row bit-for-bit.
Drizzle Kit (`web/db/schema`, `web/drizzle`) owns the DDL; Python verifies the live schema
against `f1lab/frames.py::EXPECTED_COLUMNS` before writing and refuses to run otherwise.
The full contract — every table, query signature and page — is `docs/SPEC.md`; `§8` there
lists what was built differently from the plan.

Data facts the pipeline copes with: Miami 2025's 354 laps whose compound FastF1 reports as
the string `'nan'` (stored NULL, warning shown on the race page); the compound label `NONE`
at Belgium 2025 and Hungary 2026 (kept, with a colour); Spain 2025's 19-car result (the
unpaired team is listed under the teammate chart); red-flag races in 2026 (rounds 6, 12, 13);
pit stops without an out-lap; DNS drivers; lapped cars whose API "time" is not a gap to the
winner (never shown as one).

## What CI runs, and what it cannot

Every push runs the web suite (unit, accessibility against a started server, typecheck, build,
invariants) and the Python suite against a **restored copy of the real database** — a scrubbed
`pg_dump` published as a GitHub Release asset and loaded fresh into a Postgres service container
on every run, then migrated, so a pull request's migration is exercised on real data.

The run ends with one line in the job summary, and it is the honest part:

```
ran 703 of 983 (71.5%) — not run: 83 fixture-cache, 197 direct-cache
```

A push that touches only docs or web copy runs a *light* run (the 16-minute model tier is
skipped and the summary says so, with a link to the last full run); the full run is forced by
any change to the model, schema, scripts, tests or the query layer, and by a nightly schedule
on `main`.

The 280 not run need the 10 GB FastF1 cache on local disk — they re-ingest real sessions and
take 25–40 minutes a file — and cannot run on a hosted runner. They are marked `cache` and run
on the laptop with `.venv/bin/python -m pytest tests`. CI **fails** if the ran count drops below
the committed floor in `tests/ci_census.json`, and a lost database is an exit code, never a skip:
a green run over nine files would be a lie by omission, and this project does not do that.

Nothing in CI needs a secret. The ask box is exercised in its key-absent state, which is also
how production ships.

## Running in production

The public site is a Vercel deployment of `web/` reading a Neon Postgres through a role that
holds `SELECT` and nothing else. Nothing computes on the server beyond counting rows: every
query-layer read is cached under one tag, and the laptop's nightly job (`scripts/update_season.py`,
a launchd agent at 03:20) ingests any new session, warms and derives telemetry, checks the
telemetry corpus against a signed baseline, pushes the changed rows to Neon as a role that can
write data but never DDL, calls a bearer-guarded route that expires the cache, copies the
weekend preview into an append-only history so it can be scored after the race, and republishes
the CI fixture. A step that fails is a failed night in the log and the exit code, never silent;
a push that finds the schemas differ refuses rather than guesses. The migration ledger, the role
grants and the push are proven before a race weekend by a dry run that names every row it would
write. Credentials live in mode-600 files outside the repository and are read with Python, never
sourced into a shell.

## The analytics and their caveats

The numbers are the notebook's, reproduced exactly (`pace_ranking.rank` equals the
notebook's ranking and the `rank@0.03` column of the sensitivity table).

1. **Lap cleaning** (`f1lab/clean.py`) drops laps with no time, in/out laps, laps not run
   entirely under green flag, laps FastF1 marks inaccurate or the stewards deleted, then
   per-driver outliers above 107 % of the driver's own median. Roughly 10–40 % of a race's
   laps do not survive; every race page reports exactly what each rule removed.
2. **Fuel correction** (`f1lab/pace.py`) removes the ~3 s/lap effect of a full tank so laps
   are comparable across the race, using 100 kg at the start and 0.030 s/kg/lap. *Both are
   assumptions, not measurements.* The 100 kg is a regulation maximum (teams underfill, so
   the correction is slightly generous) and is a 2025-era figure that the 2026 regulations
   make more generous still; no lap-length scaling is applied in v1.
3. **Race pace** = median fuel-corrected clean lap per driver (median, not mean — residual
   noise is one-sided). The ranking is re-run at 0.025 / 0.030 / 0.035 s/kg; where a
   driver's rank holds across that range the placing is a fact about the race, where it
   shuffles it was an artefact of a number we guessed, and the table says which.
4. **Tyre degradation** — a per-stint linear fit with a standard error, and a pooled slope per
   compound. Pooled slopes are confounded with track evolution: a compound run only in short
   early stints can show *negative* degradation because the track rubbering in is the larger
   effect. Per-stint standard errors are the guard rail; fits smaller than their error are
   tagged *not a finding*.
5. **Teammate gaps** — the cleanest driver signal available (same car), but a single race is
   a noisy, confounded observation (strategy, traffic, damage). Season head-to-heads pool
   them naively; the hierarchical driver-vs-car model (item 10) is the answer that removes the
   car, and the two are shown side by side rather than reconciled.
6. **Race trace** — gap = time the car completed lap N minus time the leader completed lap N.
   Lapped cars keep growing; red flags shift everyone equally; the y-axis is capped to keep a
   car parked through a red flag from flattening the chart.
7. **Standings** are what the timing API published; penalties and disqualifications applied
   later by the FIA may not be reflected. Fixed by re-ingesting the round, never by code.

8. **Strategy simulator** (v1.1, `f1lab/sim.py` + `web/lib/sim/`, contract `docs/SIM_SPEC.md`) —
   *What if they had pitted on lap 22?* Pick a driver, edit compounds and pit laps, and a
   4000-draw Monte Carlo runs in the browser against the driver's real strategy under the same
   per-race lap-time model (driver and tyre base pace, one linear wear slope per compound, track
   evolution) with common random numbers, so the page reports P(edited beats actual), the median
   gain or loss and a lap-by-lap gap. Every parameter is fitted in Python at ingest; the browser
   only evaluates it. It is a clean-air answer: traffic, blue flags and overtaking are not modelled,
   wear is extrapolated linearly, and a stop under a safety car is cheaper but never free. A trust
   check replays the real strategy against the real fuel-corrected total so you can see how well
   the model fits before believing an edit. Rain races and races with fewer than two slick
   compounds on enough clean laps have no model and say so.

9. **Race companion** (v1.2, `f1lab/{winprob,title,preview,moments}.py`, contract
   `docs/MODE1_SPEC.md`) — four features that answer *who is winning this*, *who can still
   win the title*, *what is this weekend likely to look like* and *what actually happened in
   this race*. A gradient-boosted classifier gives every car a win probability on every lap,
   drawn as a stacked river under the result with the biggest swings marked; a Monte Carlo
   over the remaining calendar gives title odds with a bootstrap band, sitting above — and
   deliberately apart from — the *exact* clinch-and-elimination arithmetic; a scheduled round
   that has not been raced renders a weekend preview on its own race URL (safety-car
   probability, expected pit loss, an overtaking difficulty index on a fixed 0–100 scale, and
   a predicted finishing order with intervals); and five rules over the stored lap times mark
   race moments on the trace, with an optimal-stint break-even added to the degradation
   section. Three disciplines make it honest: every per-lap probability on a race that has
   run is **out of fold** (the full-data model is barred from the chart table by a database
   `CHECK`), a reliability curve and a named baseline are rendered **directly under** the
   chart rather than hidden in a panel, and the simulated title odds never share a heading
   with the exact arithmetic. Everything is computed in Python at ingest or recompute time
   and merely read by the browser.

10. **Driver vs car** (v1.3, `f1lab/{decomp,decomp_points}.py`, contract `docs/MODE2_SPEC.md`) — one crossed random-effects model over every 2024–2026 race
   splits fuel-corrected pace into a driver effect, a car effect and an in-season
   development slope, fitted by REML with a bootstrap for the intervals. It is built around
   an admission rather than a result: separating a driver from his car requires drivers who
   changed team, and the 2024–2026 mobility graph is **not connected**. It has four
   components, and two of them — McLaren and Aston Martin — are islands of two drivers who
   never moved and whose team-mates never moved either. For those four drivers the model can
   state the gap between them precisely and **cannot** say whether the car was a rocket or
   the drivers are great; adding a constant to both drivers and subtracting it from the car
   leaves every observed lap unchanged. Those rows are stored as `basis = 'by-analogy'` and
   every surface renders them in a different visual grammar — hatched, with the headline
   number replaced by a "level not measured" chip and the point estimate of a counterfactual
   withheld entirely. Two of the four latent skills were fitted and then **refused**: tyre
   management came out with a driver signal smaller than its own error bars, and there are
   zero usable wet-pace observations in three seasons. Both refusals ship as content, in
   place of the radar chart that would have implied four comparable numbers. The car:driver
   spread is reported only ever as a standard-deviation ratio (about 3.3×, 5th–95th 2.4–5.0),
   never squared into a variance ratio.

11. **Qualifying** (v1.6, `f1lab/clean.py::clean_quali` + `frames.build_quali_frames`, contract
   `docs/QUALI_SPEC.md`) — the site's first non-race sessions: 71 qualifying and 18
   sprint-qualifying, laps and all, with sprint qualifying treated as first-class rather than
   results-only. The official Q1/Q2/Q3 times are stored verbatim *and* independently
   reproduced from the cleaned laps, so a time can be pointed at the lap it was set on, its
   compound and its tyre age. Three things are said out loud rather than smoothed over. **Gap
   to pole is stored twice**, because the broadcast number compares a Q1 time against a Q3
   time and disagrees with the same-segment number for 978 of 1,574 drivers — by 7.5 s at wet
   São Paulo. **A single session's teammate gap is usually not a measurement**: a driver's own
   push laps inside one segment vary by two to five tenths, so 371 of 779 teammate gaps are
   inside that session's own repeatability and render as *no measurable difference* rather
   than a number. And **Q1, Q2 and Q3 are three sessions on a changing track** — 2024 China's
   sprint qualifying ran SQ1/SQ2 dry and SQ3 wet, 23% slower, so cross-segment comparisons
   there are withheld entirely. Qualifying is deliberately **not** an input to the weekend
   preview forecast: a future race has no qualifying time any more than it has a grid.

12. **Telemetry** (v1.7, `f1lab/telemetry.py` + `web/lib/telemetry/`, contract
   `docs/TELEMETRY_SPEC.md`) — the first use of FastF1's 10 Hz car and position channels.
   One lap per driver per session — the fastest valid one — stored as arrays rather than
   2.2M narrow rows, and turned into four pictures: a track map painted by a channel, a
   two-driver delta trace, a channel stack, and a corner-by-corner report card. The layer is
   **additive and optional**: migration 0008 alters nothing, and a database on which the
   telemetry pass has never run renders every existing page byte-identically, which is
   asserted rather than assumed (`tests/test_telemetry_optional.py`). Three things are worth
   saying plainly. **The delta trace is aligned on the cumulative chord length of the (X, Y)
   trace, never on FastF1's own `Distance` column** — `Distance` is speed integrated over
   time and spans 5,872.6 m to 5,757.9 m across the fastest laps of a single session at a
   single circuit, a 2.0% spread that draws a delta wrong by ~1.39 s where the real gaps are
   60–180 ms; the near-miss of normalising to `RelativeDistance` closes perfectly at the flag
   and is wrong by ±450–570 ms in the middle, where a fan reads it as meaning. Chord distance
   spans 12.7 m on the same laps and matches the drivers' own sector times to 8–98 ms, and
   that residual is **printed on the chart**, not claimed away. **The chart refuses to draw
   itself** when it cannot close to better than 400 ms. And **there is no cross-driver delta
   on race laps at all** — an absent control rather than a captioned one, because race laps
   are run in traffic, on falling fuel and on tyres of different ages, so a side-by-side trace
   would look like a measurement and would not be one. What this data cannot support, ever:
   which driver is faster, which car is faster, how a stint degraded, or how much of a
   straight-line advantage was a tow.

13. **Accuracy** (v1.12–v1.13, `web/lib/queries/accuracy*.ts`, contracts `docs/ACCURACY_SPEC.md`
   and `docs/LEDGER_SPEC.md`) — the site's own record, scored read-only over stored forecasts
   and outcomes. The win-probability skill is quoted out of sample beside in sample; the
   finishing-position ranges' 94.7 % coverage is shown beside their mean width (15.1 places on
   grids of 20–22) and against a no-model comparator, scored with an interval score that
   charges width and misses together — the comparator wins, and the page says so; the
   end-of-season points ranges are scored by quarter for every finished season (2024: the 80 %
   range held 14.4 % of first-quarter projections; the case for a tighter early-season prior
   and a DNF variance term, which is separate work); and every pre-race preview is copied the
   night it is computed and scored once its race is in, so "what did you say last week" has an
   answer that was written before the race. The rule for the 100 predictions with no classified
   finish is stated above every coverage figure; the copy says n = 2 seasons, not thousands of
   trials, and grades no driver.

14. **Head-to-head** (v1.14, `web/lib/queries/h2h.ts`, contract `docs/H2H_SPEC.md`) — any two
   drivers, from the driver page: the raw same-race ledger (car and driver together, each line
   over its own denominator, qualifying position rather than grid because penalties are not
   pace) beside the stored car-removed contrast oriented to the page's driver with its 5th–95th
   range, labelled as pooled across every season the model has seen. A rule in the build forbids
   subtracting two pace gaps or two ratings anywhere in this code; when the model cannot call the
   pair — no shared car, a range that includes zero, no stored row — a computed sentence says so
   instead of a number.

Telemetry-grade lap data only exists from 2018, so anything built on tyre or sector data has
a hard floor there. The driver-vs-car model is narrower still: it is fitted on 2024, 2025 and
2026 race sessions only, so a rating is a position among those twenty-eight drivers under
those regulations — not a cross-era claim, and not an all-time ranking.

## Layout

```
f1lab/         config (every assumption) · clean · pace · derive · colours · assumptions · frames · db · season · ingest
               sim (v1.1) · winprob · title · preview · moments · companion (v1.2)
               decomp · decomp_points (v1.3 driver-vs-car) · telemetry (v1.7, the 10 Hz second pass)
tests/         pytest (`-m "not db"` runs from cache alone)
notebooks/     01_one_race.ipynb — the original single-race analysis, unchanged
scripts/       warm_cache.py — pre-download sessions · warm_telemetry.py — the v1.7 telemetry warm (~11 GB)
web/           Next.js 16 + Drizzle; see web/README.md for scripts and conventions
scripts/       update_season.py (the nightly job) · push_remote.py (laptop → Neon, refuses localhost and
               schema drift) · publish_fixture.sh · neon_migrate.sh · neon_apply_0012.py · db_ask_verify.sh
               gen_ask_schema.py · ci_coverage.py · com.f1analytics.update.plist (launchd)
docs/          SPEC.md (v1 contract, §8 as built) · SIM_SPEC.md (v1.1) · MODE1_SPEC.md (v1.2, §11 as built)
               MODE2_SPEC.md (v1.3, §12 as built) · MODE3_SPEC.md (v1.4 ask box, §12 as built)
               QUALI_SPEC.md (v1.6) · TELEMETRY_SPEC.md (v1.7) · GAPFILL_SPEC.md (v1.8) · UX_SPEC.md (v1.9)
               OPS_SPEC.md (v1.10 going public; §10 as built) · REVALIDATE_SPEC.md (v1.11 cache)
               ACCURACY_SPEC.md · LEDGER_SPEC.md · H2H_SPEC.md (v1.12–v1.14) · REPLICATION_SPEC.md (designed, refused)
               IDEAS_2026-09.md (the research behind the last five releases, with what was rejected and why)
               RUNBOOK.md (operations; §3 has every procedure, §9 the morning-after checks)
Makefile       db · setup · migrate · ingest SEASON= · recompute · recompute-hazards · recompute-companion
               recompute-mode2 · ingest-quali · backfill-quali · verify-quali · web · build · test
               warm-telemetry · telemetry · telemetry-session SESSION_ID= · verify-telemetry (v1.7)
cache/ output/ FastF1 cache and notebook PNG exports (not committed)
```

The layering matters: **nothing downstream touches a raw lap time.** If a new analysis
needs one, `clean.py` is missing a rule.

## Data and licensing

Data comes from the F1 live timing API via [FastF1](https://github.com/theOehrly/Fast-F1),
which is an unofficial endpoint. Cache aggressively and do not hammer it (the ingest sleeps
between loads and stops cleanly on a rate limit).

Formula 1 owns this data and its marks. Keep anything built on it non-commercial, and do
not use F1 or team logos. The tables published as the CI fixture (a GitHub Release asset) and
the numbers on the site are derived from that data for the same non-commercial, personal use.

The code in this repository is released under the [MIT License](LICENSE). That licence covers
the code only: the timing data, the tables derived from it and the numbers on the site remain
Formula 1's, obtained through an unofficial package, for personal, non-commercial use.

## Status

Complete as of 22 September 2026: the three things the project set out to be — a race
explorer, a race-day companion and a driver-vs-car model — are built, revised and scored on
their own accuracy page; the site is public, cached, deployed on push and updated nightly by
a job that checks its own work. Everything it claims is next to the assumption it depends on,
and what it cannot measure is said in the same place.

What it does not do, on purpose: rate drivers across eras; treat a pre-race preview as more
than a weaker guide than the grid; call the McLaren and Aston Martin drivers' level, which the
2024–2026 mobility graph cannot identify; summarise anything with a model at request time.

What would change a claim rather than add a page, if the work continues: a tighter
early-season prior and a DNF variance term in the title model (the 14 % finding above); storing
two or three laps per driver-session so that per-driver technique skills can be tested for
repeatability (`docs/REPLICATION_SPEC.md`, refused at one lap); and, less than either, a form
guide over the last five rounds. The first race night to run entirely unattended is the one
after this note.
