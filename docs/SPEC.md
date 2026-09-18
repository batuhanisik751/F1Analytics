# F1 Analytics — v1 Specification

Status: FINAL. This document is the contract between independent implementation packages.
Implementers will not see the proposals or discussion that produced it; everything they
need is here. Where the text says MUST, deviation breaks another package.

Project root: `/Users/batuhanisik/Desktop/Projects/F1Analytics` (referred to as `<root>` below).

---

## 0. Scope, fixed decisions, conventions

### 0.1 What v1 is

A read-only F1 statistics website over precomputed Postgres tables. Python (`f1lab`) ingests
FastF1 data and computes every analytic at ingest time; Next.js renders four pages by
selecting rows. Nothing is computed on request beyond formatting and sorting.

> **v1.1 → `SIM_SPEC.md`.** The interactive Monte Carlo strategy simulator (section `simulator`
> on `/race/[year]/[round]`, four `sim_*` tables, `f1lab/sim.py`, `web/lib/sim/`) is specified in
> `docs/SIM_SPEC.md`; it relaxes "nothing computed on request" for the simulation itself only
> (SIM_SPEC §0.2 (5)). Everything else in this document still governs.

### 0.2 Fixed decisions (do not relitigate)

1. Monorepo: `<root>/f1lab` (Python, exists), `<root>/web` (Next.js, **already scaffolded** — see 0.4),
   `<root>/docker-compose.yml` (exists), `<root>/docs/SPEC.md` (this file).
2. Storage: Postgres 16 in Docker. Connection string `postgres://f1:f1@localhost:5432/f1`.
   Environment variable name on BOTH sides: `DATABASE_URL` (Python and web use the same name; both
   default to the string above when it is unset).
3. Python owns ingest and ALL computation; Next.js is read-only.
4. `f1lab.clean` and `f1lab.pace` are REUSED, not reimplemented. The schema stores exactly what they return.
5. Web stack: Next.js 16.3.5 (App Router, React 19.2.8, TypeScript 5.9, Tailwind CSS 4.3), Drizzle ORM
   0.45.2 with node-postgres (`pg` 8.23.0) for reads, Drizzle Kit 0.31.10 owns the DDL via migrations.
   Charts: Apache ECharts **5.6.0** (the plain `echarts` package) behind one client wrapper component.
6. Seasons: 2025 (24 rounds, complete) and 2026 (23 rounds scheduled; 13 complete as of 2026-09-11).
   Ingest is idempotent per session and resumable per season.
7. Pages: `/`, `/season/[year]`, `/race/[year]/[round]`, `/driver/[code]` — no others.
8. Dark theme everywhere: bg `#12100E`, fg `#EDE6DC`, grid `#3A342D`, accent `#E8A33D`. Team and
   compound colours come from FastF1's plotting module at ingest time and are stored in the DB. The
   web app never imports FastF1 and never hard-codes a team colour.
9. Later features (live win probability, Monte Carlo strategy, Bayesian driver-vs-car, SC probability)
   are designed for, not built. See §1.13.

### 0.3 Conventions

- SQL: snake_case, plural table names. All durations in **seconds as `double precision`** (FastF1
  timedeltas via `.dt.total_seconds()`). Lap counts, positions, rounds: `integer`. Colours: `text`,
  lowercase `#rrggbb`. Status-like columns are `text` with a CHECK, never Postgres enums.
- FastF1 float columns that are conceptually integers (`LapNumber`, `Stint`, `TyreLife`, `Position`,
  `results.Position`, `GridPosition`, `Laps`) are cast to `int` at write time; NaN becomes NULL.
- FastF1's literal string `'nan'` in `Compound` (354 laps at Miami 2025) and NaN `Stint`/`TyreLife`
  are written as NULL. `clean.stint_table` already drops laps with NaN `Stint`, so a driver's first
  stored stint may start after lap 1; the gantt MUST tolerate that.
- `results.Time` semantics (verified): P1 = total race time; classified cars on the lead lap = gap
  to winner; **lapped cars = NOT a gap to the winner** (e.g. 2026 R1 P7 BEA, 57/58 laps, `+4.593 s`);
  DNF/DNS = NaT. Stored as-is in `results.result_time_s`; the UI shows it only for P1 (absolute time)
  and for rows whose `status == 'Finished'` (as `+gap`). Never summed, never shown for `Lapped` rows.
- `fuel_sensitivity()` column names are `rank@0.025`, `rank@0.03`, `rank@0.035` (Python float repr —
  NOT `0.030`). The melt MUST parse the suffix with `float()`.
- Sign convention for teammate comparisons on the driver page: **positive = this driver faster**.

### 0.4 What already exists in `web/` (do not re-scaffold)

`<root>/web` was created with `create-next-app` (Next 16.3.5, React 19.2.8, Tailwind 4, ESLint 9,
TypeScript 5.9, **npm** with `package-lock.json`, **no `src/` directory**, `@/*` → `./*`). It contains
`app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `eslint.config.mjs`, `next.config.ts`,
`postcss.config.mjs`, `tsconfig.json`, `AGENTS.md`/`CLAUDE.md` (Next-generated; leave as is).
Package WP0 EDITS this scaffold; nobody runs `create-next-app` again, nobody introduces pnpm/yarn.

Next 16 facts that matter (verified in `web/node_modules/next/dist/docs`):
- `params` and `searchParams` are Promises: `const { year } = await params`. Global helper types
  `PageProps<'/race/[year]/[round]'>` and `LayoutProps<'/'>` exist without import.
- `cacheComponents` is opt-in and stays OFF; every page exports `const dynamic = 'force-dynamic'`.
- `next/dynamic(..., { ssr: false })` is NOT allowed in Server Components. Charts are `'use client'`
  components imported normally; the `'use client'` boundary is sufficient.
- `@types/react` 19.3 has no global `JSX` namespace: type components as `React.JSX.Element`.

### 0.5 Verified data facts (FastF1 3.8.3, cached 2024 R13, 2025 R1–R24, 2026 R1–R13)

| Fact | Consequence |
|---|---|
| `session.laps` columns: Time, Driver, DriverNumber, LapTime, LapNumber, Stint, PitOutTime, PitInTime, Sector1/2/3Time, Sector1/2/3SessionTime, SpeedI1/I2/FL/ST, IsPersonalBest, Compound, TyreLife, FreshTyre, Team, LapStartTime, LapStartDate, TrackStatus, Position, Deleted, DeletedReason, FastF1Generated, IsAccurate | `laps` table §1.7 |
| `session.results` columns: DriverNumber, BroadcastName, Abbreviation, DriverId, TeamName, TeamColor, TeamId, FirstName, LastName, FullName, HeadshotUrl, CountryCode, Position, ClassifiedPosition, GridPosition, Q1, Q2, Q3, Time, Status, Points, Laps | `drivers`, `teams`, `session_entries`, `results` |
| `DriverId` (e.g. `piastri`) and `TeamId` (e.g. `mclaren`, `rb`, `audi`, `cadillac`) are non-null in every race; 2026 has 11 teams / 22 drivers | stable identities across seasons |
| `laps.Team == results.TeamName` and `laps.Driver ⊆ results.Abbreviation` in every race | join analytic frames back to ids via the session's own results |
| For every lap N, `min(laps.Time)` over drivers on lap N is the `Position == 1` car (0 mismatches in 38 races); `laps.Time` is never NaN; `laps.Position` is NaN on 1–6 rows per race | gap derivation §1.14; interval via sorted-time diff, not Position |
| `results.Time` P1 absolute, lapped rows not a gap | §0.3 |
| `session.session_info['Meeting']['Circuit']` = `{'Key': 4, 'ShortName': 'Hungaroring'}` | `circuits.circuit_key`; 2026 has Barcelona (R7) and Madrid "Spanish GP" (R14) |
| `fastf1.get_event_schedule(2026, include_testing=False)` has 23 rounds; `EventFormat` ∈ {`conventional`, `sprint_qualifying`}; `Session5DateUtc` is the race start; in sprint formats the session named `Sprint` is `Session3` | `sessions` rows from the schedule; sprint = the SessionN whose name is `'Sprint'` |
| `fastf1.plotting.get_team_color('McLaren', session=s)` → `#ff8000`; `results.TeamColor` is `FF8000` (no `#`) | colour fallback chain §2.6 |
| `fastf1.plotting.get_driver_style(code, style=['linestyle'], session=s)['linestyle']` → `solid` for one teammate, `dashed` for the other | `session_entries.line_style` |
| `fastf1.plotting.get_compound_mapping(session=s)` → 7 keys incl. `UNKNOWN`, `TEST-UNKNOWN` | `compound_colours` |
| `matplotlib.cbook.boxplot_stats(values, whis=1.5)[0]` keys: `mean, iqr, cilo, cihi, whishi, whislo, fliers, q1, med, q3` | box columns on `pace_ranking` |
| `pace_ranking()` raises `IndexError` when no driver has ≥ 8 clean laps; `degradation()`/`teammate_deltas()` return empty frames | per-analytic try/except, `analytics_status` |
| Track status codes seen: `1 2 4 5 6 7`; red flags (`5`) in 2026 R6, R12, R13 | `lap_status.worst_status` severity order |
| Out-laps (`PitOutTime`) outnumber in-laps in many races (pit-lane starts, restarts) | `pit_stops` pairs an in-lap with the NEXT lap's out-lap only |
| 2025 R9 results have 19 rows (one Aston Martin driver) | `teammate_deltas` skips such teams; `unpaired` list on the race page |

---

## 1. Postgres schema (section A)

Drizzle Kit owns the DDL: `web/db/schema/*.ts` → `npm run db:generate` → `web/drizzle/0000_init.sql`
→ `npm run db:migrate`. The SQL below is what the generated migration MUST produce (constraint names
may differ; column names, types, nullability, PKs, FKs, uniques, checks and index columns may not).
Python never issues DDL; it verifies the live `information_schema` against `frames.EXPECTED_COLUMNS`
(§2.4) before writing and refuses to run otherwise.

Table order below is the FK order. Every per-session child table has
`session_id ... ON DELETE CASCADE`; ingest deletes children explicitly anyway (§2.5).

### 1.1 Provenance root: `assumption_sets`

```sql
CREATE TABLE assumption_sets (
  assumption_set_id  serial PRIMARY KEY,
  hash               text NOT NULL UNIQUE,          -- sha256 hex of json.dumps(params, sort_keys=True, separators=(',', ':'))
  params             jsonb NOT NULL,                -- see §2.3 for the exact keys
  created_at         timestamptz NOT NULL DEFAULT now()
);
```
Populated by `f1lab.assumptions.get_or_create(conn)` at the start of every ingest run. A changed
constant produces a new row; analytics rows reference the set they were computed under. v1 does NOT
keep two sets' analytics side by side (re-ingest replaces), but `seasons.mixed_assumption_sets` flags
a season whose ingested races were computed under different sets.

### 1.2 Reference tables

```sql
CREATE TABLE seasons (
  year                   integer PRIMARY KEY,
  scheduled_rounds       integer NOT NULL,                       -- len(get_event_schedule(year, include_testing=False))
  ingested_rounds        integer NOT NULL DEFAULT 0,             -- race sessions with session_ingests.status IN ('ok','partial')
  standings_after_round  integer,                                -- max ingested round; NULL until season.recompute ran
  assumption_set_id      integer REFERENCES assumption_sets(assumption_set_id),  -- the single set shared by all ingested races, else NULL
  mixed_assumption_sets  boolean NOT NULL DEFAULT false,
  has_sprint_results     boolean NOT NULL DEFAULT false,         -- any kind='S' session with status ok
  recomputed_at          timestamptz
);

CREATE TABLE circuits (
  circuit_key  integer PRIMARY KEY,        -- session.session_info['Meeting']['Circuit']['Key']
  short_name   text NOT NULL,              -- ...['Circuit']['ShortName']  'Hungaroring'
  location     text NOT NULL,              -- session.event['Location'] as last seen
  country      text NOT NULL,
  lap_km       double precision            -- RESERVED, always NULL in v1 (see decisions log D2)
);

CREATE TABLE events (
  year           integer NOT NULL REFERENCES seasons(year),
  round          integer NOT NULL,
  event_name     text NOT NULL,            -- schedule EventName        'Hungarian Grand Prix'
  official_name  text NOT NULL,            -- schedule OfficialEventName
  location       text NOT NULL,            -- schedule Location         'Budapest'
  country        text NOT NULL,            -- schedule Country
  event_format   text NOT NULL,            -- 'conventional' | 'sprint_qualifying' | ...
  event_date     date NOT NULL,            -- schedule EventDate (the Sunday)
  circuit_key    integer REFERENCES circuits(circuit_key),   -- NULL until the race session was loaded once
  PRIMARY KEY (year, round)
);

CREATE TABLE teams (
  team_id      text PRIMARY KEY,           -- results.TeamId  'mclaren'
  latest_name  text NOT NULL               -- results.TeamName most recently seen
);

CREATE TABLE drivers (
  driver_id      text PRIMARY KEY,         -- results.DriverId  'piastri'
  latest_code    text NOT NULL,            -- results.Abbreviation most recently seen  'PIA'
  latest_number  text NOT NULL,            -- results.DriverNumber (FastF1 keeps it as a string)
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  full_name      text NOT NULL,
  country_code   text,
  headshot_url   text
);
CREATE INDEX drivers_latest_code_idx ON drivers (latest_code);

-- One row per timed session we know about, created from the SCHEDULE (so failed/pending rounds have a row).
-- kind='R' and kind='Q' for every round; kind='S' and kind='SQ' only for rounds whose
-- event_format is 'sprint_qualifying'. ('Q' and 'SQ' are v1.6; see QUALI_SPEC D2/D3.)
CREATE TABLE sessions (
  session_id              serial PRIMARY KEY,
  year                    integer NOT NULL,
  round                   integer NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('R','S','Q','SQ')),   -- v1.6: was ('R','S')
  name                    text NOT NULL,          -- 'Race' | 'Sprint' | 'Qualifying' | 'Sprint Qualifying'
  start_utc               timestamptz,            -- schedule SessionNDateUtc for that session
  total_laps              integer,                -- session.total_laps; NULL until loaded; always NULL for Q/SQ
  winner_driver_id        text REFERENCES drivers(driver_id),   -- results position 1; NULL until ingested; ALWAYS NULL for Q/SQ
  fastest_pace_driver_id  text REFERENCES drivers(driver_id),   -- pace_ranking rank 1 for R; for Q/SQ it is the
                                                                -- classified P1 (pole), definitionally (QUALI_SPEC §4.5/D23)
  UNIQUE (year, round, kind),
  FOREIGN KEY (year, round) REFERENCES events(year, round)
);
CREATE INDEX sessions_year_round_idx ON sessions (year, round);
```

### 1.3 Per-session identity and colours

**v1.6 — Q/SQ session identity.** A qualifying session writes `session_teams` and
`session_entries` exactly as a race does, and then diverges: **no `results` row is ever
written for `kind IN ('Q','SQ')`** — the official classification lives in `quali_results`
(§1.6) — `winner_driver_id` and `total_laps` stay NULL, and `fastest_pace_driver_id` is set
to the **classified P1**, i.e. the pole sitter. That last one is a *definitional* choice, not
a measurement: on a drying track the fastest lap of the session and the pole lap are not the
same lap, and caption `C-QUALI-9` says so on the four sessions where they differ
(`QUALI_SPEC §4.5`, D23). `ingest.drop_non_entries` removes results rows that carry no
`DriverId`, no `TeamId`, no `Position` and no time before the frames are built, so
`session_entries` is shorter than FastF1's results frame on five measured sessions; a driver
who set a flying lap is never dropped.

```sql
-- Team name and colour AS THEY WERE in this session (RB -> Racing Bulls, Kick Sauber -> Audi).
-- team_name is the join key back to pace.py's 'Team' column for this session.
CREATE TABLE session_teams (
  session_id     integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  team_id        text NOT NULL REFERENCES teams(team_id),
  team_name      text NOT NULL,            -- results.TeamName
  colour         text NOT NULL,            -- '#rrggbb' lowercase
  colour_source  text NOT NULL CHECK (colour_source IN ('fastf1','results','fallback')),
  PRIMARY KEY (session_id, team_id),
  UNIQUE (session_id, team_name)
);

-- One row per driver in session.results. code is the join key back to laps.Driver / pace.py 'Driver'.
CREATE TABLE session_entries (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id          text NOT NULL REFERENCES drivers(driver_id),
  team_id            text NOT NULL,
  code               text NOT NULL,        -- results.Abbreviation
  driver_number      text NOT NULL,        -- results.DriverNumber
  line_style         text NOT NULL CHECK (line_style IN ('solid','dashed','dotted')),
  line_style_source  text NOT NULL CHECK (line_style_source IN ('fastf1','fallback')),
  PRIMARY KEY (session_id, driver_id),
  UNIQUE (session_id, code),
  UNIQUE (session_id, driver_number),
  FOREIGN KEY (session_id, team_id) REFERENCES session_teams(session_id, team_id)
);

-- fastf1.plotting.get_compound_mapping(session=s), all keys, merged over the COMPOUND_FALLBACK map
-- so every compound present in laps has a row. Race sessions only.
CREATE TABLE compound_colours (
  session_id  integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  compound    text NOT NULL,
  colour      text NOT NULL,
  PRIMARY KEY (session_id, compound)
);

-- session.results, race AND sprint sessions.
CREATE TABLE results (
  session_id           integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id            text NOT NULL,
  position             integer,            -- results.Position (NULL if NaN)
  classified_position  text NOT NULL,      -- '1'..'22' | 'R' | 'D' | 'W' | 'N' | 'E'
  grid_position        integer,            -- results.GridPosition (0 = pit-lane start)
  points               double precision NOT NULL DEFAULT 0,
  status               text NOT NULL,      -- 'Finished' | 'Lapped' | 'Retired' | 'Did not start' | ...
  laps_completed       integer,            -- results.Laps
  result_time_s        double precision,   -- results.Time, semantics in §0.3
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
CREATE INDEX results_session_position_idx ON results (session_id, position);
CREATE INDEX results_driver_idx ON results (driver_id, session_id);
```

### 1.4 Laps — every raw lap, annotated (**race, sprint, qualifying and sprint qualifying** as of v1.6)

**`laps` is no longer race-only.** v1.6 put qualifying and sprint-qualifying laps in this
same table (`QUALI_SPEC` D1: 34 of the 41 columns are identical and several are *more*
meaningful in qualifying) and added **five columns, 41 → 46**, all nullable and all NULL on
every race and sprint lap:

| column | meaning |
|---|---|
| `quali_segment` | 1/2/3 — the Q1/Q2/Q3 (or SQ1/SQ2/SQ3) window this lap was set in; NULL outside all three |
| `segment_source` | `'window'` \| `'anchor_repair'` — how the segment was assigned |
| `is_push_lap` | within 103% of the driver's own best in that segment |
| `excl_disallowed` | a diagnostic, never a filter (`QUALI_SPEC §2.4`) |
| `deleted_inferred` | the deletion was inferred from race control, not flagged by FastF1 |

**THE RULE, and it is the one thing about this release most likely to be got wrong:** *every
query against `laps` that is not already scoped to a single `session_id` must constrain
`sessions.kind`.* It is restated in `web/db/schema/laps.ts`'s header comment and enforced by
`tests/test_quali_integration.py::test_every_laps_reader_is_kind_scoped_or_session_scoped`,
which walks `f1lab/`, `scripts/`, `web/lib/queries/` and `web/db/` and fails on the next
unscoped reader. Ten readers exist today and all ten are safe (`QUALI_SPEC §3.1`, plus
`f1lab/winprob.py:634`, which that audit table missed).

Two further asymmetries, both deliberate:

- **`quali_segment IS NOT NULL` is a ONE-SIDED test.** Every lap with a segment is a
  qualifying lap, but 2,847 of 23,415 qualifying laps have none — they fall outside all three
  `Started→Finished` windows. The column that is non-NULL on exactly the qualifying laps is
  `is_push_lap`.
- **`deleted` is correct for Q/SQ and inert for R/S.** It is `false` on all 69,548 race and
  sprint laps and always has been, because `clean.load_race` passes `messages=False`, so
  FastF1 never populates `Deleted` and the `excl_deleted` rule has never excluded a single
  lap. That is a real defect; flipping it for races would change `pace_ranking`,
  `degradation_fits`, `teammate_deltas`, every season aggregate and every Mode 2 fit, so it is
  scoped to v1.7 (`QUALI_SPEC §5.6`) and the current behaviour is **pinned by a test** so the
  gap stays visible instead of quietly closing. Nothing — human or model — may read the race
  zero as a fact about racing.

```sql
CREATE TABLE laps (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id          text NOT NULL,
  lap_number         integer NOT NULL,
  -- raw FastF1 (NULL where FastF1 has NaN/NaT/'nan')
  stint              integer,
  compound           text,                 -- 'SOFT'|'MEDIUM'|'HARD'|'INTERMEDIATE'|'WET'|'UNKNOWN'|'TEST-UNKNOWN'; never the string 'nan'
  tyre_life          integer,
  fresh_tyre         boolean,
  position           integer,              -- laps.Position at lap end
  track_status       text,                 -- verbatim, e.g. '1', '12', '41'
  lap_time_s         double precision,     -- LapTime
  session_time_s     double precision,     -- laps.Time = session time at lap END (gap-trace source)
  lap_start_time_s   double precision,     -- LapStartTime
  sector1_s          double precision,
  sector2_s          double precision,
  sector3_s          double precision,
  speed_i1           real,
  speed_i2           real,
  speed_fl           real,
  speed_st           real,
  pit_in_time_s      double precision,     -- PitInTime (session time); NOT NULL <=> in-lap
  pit_out_time_s     double precision,     -- PitOutTime (session time); NOT NULL <=> out-lap
  is_accurate        boolean NOT NULL,     -- IsAccurate.fillna(False)
  deleted            boolean NOT NULL,     -- Deleted.fillna(False)
  deleted_reason     text,
  fastf1_generated   boolean NOT NULL,     -- FastF1Generated.fillna(False)
  is_personal_best   boolean NOT NULL,     -- IsPersonalBest.fillna(False)
  -- clean.annotate_laps outputs (§2.2)
  excl_no_time       boolean NOT NULL,
  excl_in_lap        boolean NOT NULL,
  excl_out_lap       boolean NOT NULL,
  excl_not_green     boolean NOT NULL,
  excl_inaccurate    boolean NOT NULL,
  excl_deleted       boolean NOT NULL,
  passes_rules       boolean NOT NULL,     -- == clean.py's 'is_clean' column (all rules pass; BEFORE the outlier step)
  is_outlier         boolean NOT NULL,     -- passes_rules AND lap_time_s > OUTLIER_THRESHOLD * driver median of rules-passing laps
  is_representative  boolean NOT NULL,     -- passes_rules AND NOT is_outlier == membership of clean.clean_laps(session)
  -- pace.fuel_correct outputs, computed for EVERY lap with a lap time (analytics only consume is_representative rows)
  fuel_kg            double precision,
  fuel_penalty_s     double precision,
  lap_time_fc_s      double precision,     -- LapTimeFuelCorrected
  -- f1lab.derive.gap_to_leader outputs (§1.14)
  gap_to_leader_s    double precision,
  interval_s         double precision,     -- gap to the car immediately ahead on this lap by session time; NULL for the leader
  leader_driver_id   text,                 -- driver with min session_time_s on this lap number
  PRIMARY KEY (session_id, driver_id, lap_number),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
CREATE INDEX laps_session_lap_idx ON laps (session_id, lap_number);
CREATE INDEX laps_session_repr_idx ON laps (session_id, compound, tyre_life) WHERE is_representative;
CREATE INDEX laps_driver_idx ON laps (driver_id, session_id);
```
Volume: ~1,150 laps × 47 races ≈ 55k rows.

### 1.5 Derived per-lap facts (race sessions only; `f1lab.derive`)

```sql
-- Field-wide flag state per lap number, for the race-trace SC/VSC/red bands and the SC-probability model.
CREATE TABLE lap_status (
  session_id        integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  lap_number        integer NOT NULL,
  is_green          boolean NOT NULL,      -- every lap row on this lap number satisfies clean._is_green
  worst_status      text NOT NULL,         -- most severe single code seen among rows on this lap: '5' > '4' > '6' > '7' > '2' > '1'; '0' when every row has NULL status
  drivers_affected  integer NOT NULL,      -- rows on this lap number that are NOT all-green
  drivers_on_lap    integer NOT NULL,
  PRIMARY KEY (session_id, lap_number)
);

-- Pit stops paired from PitInTime / PitOutTime. Raw material for pit-loss per circuit (Monte Carlo).
CREATE TABLE pit_stops (
  session_id      integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id       text NOT NULL,
  stop_number     integer NOT NULL,        -- 1-based per driver in lap order
  lap_in          integer NOT NULL,        -- lap with PitInTime
  lap_out         integer,                 -- lap_in + 1 if that lap has PitOutTime, else NULL (retired in pits / red flag)
  pit_in_time_s   double precision NOT NULL,
  pit_out_time_s  double precision,
  pit_lane_s      double precision,        -- pit_out_time_s - pit_in_time_s, NULL if lap_out NULL
  compound_in     text,                    -- compound on lap_in
  compound_out    text,                    -- compound on lap_out
  PRIMARY KEY (session_id, driver_id, stop_number),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- clean.stint_table(session): grouped by (Driver, Stint, Compound) — compound stays in the PK to match the function.
CREATE TABLE stints (
  session_id  integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id   text NOT NULL,
  stint       integer NOT NULL,
  compound    text NOT NULL,
  start_lap   integer NOT NULL,
  end_lap     integer NOT NULL,
  laps        integer NOT NULL,
  PRIMARY KEY (session_id, driver_id, stint, compound),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
```

### 1.6 Analytics tables (race sessions only; one per f1lab function; all carry `assumption_set_id`)

**v1.6 added three per-session qualifying tables that are NOT in this family.** They are
keyed by `session_id` like the rest, but they carry **no `assumption_set_id`**, because the
official Q1/Q2/Q3 times are not derived from the assumption set — they arrive with the
session results and are stored verbatim. A query that filters them by `assumption_set_id`
gets a syntax error, and a join that adds the predicate gets nothing.

| table | grain | what it holds |
|---|---|---|
| `quali_results` | session × driver | the official classification: `q1_s/q2_s/q3_s`, `best_s`, `position`, `segments_entered`, `knocked_out_in`, and **two** gaps to pole — `gap_to_pole_s` is the broadcast number across segments, `gap_to_pole_common_s` compares within one segment, and they disagree for 978 of the 1,574 rows that have both (`QUALI_SPEC` D6) |
| `quali_segment_times` | session × driver × segment | per-segment best, gap to the segment best, spread, sd, compound, and `verified` — false on the three driver-segments whose official time is a duplicate of another segment's, so nothing can confirm the lap |
| `quali_teammate_h2h` | session × team pair | the gap in the deepest segment both drivers set a time in, with `session_sd_s` — that session's own repeatability — stored beside it, and `below_noise` precomputed. **371 of 779 rows are `below_noise` and must render as "no measurable difference", never as a number** |

`lap_exclusion_report` is written for Q/SQ too, with the qualifying rule set
(`QUALI_SPEC §2.3`): no fuel correction, no 107% outlier rule, and the green-flag rule
*reported* rather than applied, because four official Monaco Q1 bests sit on TrackStatus
`'12'`. `pace_ranking`, `degradation_fits`, `teammate_deltas`, `fuel_sensitivity` and every
other table in this section remain **race-only** and were verified byte-identical across the
v1.6 backfill.

```sql
-- clean.exclusion_report(session), row-for-row incl. the final 'SURVIVING (clean + non-outlier)' row.
CREATE TABLE lap_exclusion_report (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  rule_order         integer NOT NULL,     -- DataFrame index (0-based); SURVIVING is last
  rule               text NOT NULL,        -- exact string from the function
  laps_hit           integer NOT NULL,
  pct_of_all         double precision NOT NULL,
  PRIMARY KEY (session_id, rule)
);

-- pace.pace_ranking(fuel_correct(clean_laps(session), total_laps, lap_km=None), min_laps=8)
-- + pace.pace_distribution (box columns) + min/max rank across fuel_sensitivity values.
CREATE TABLE pace_ranking (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id          text NOT NULL,
  rank               integer NOT NULL,     -- Rank
  team_id            text NOT NULL,        -- Team (name) -> session_teams.team_id
  clean_laps         integer NOT NULL,     -- CleanLaps
  median_pace_s      double precision NOT NULL,   -- MedianPace
  best_pace_s        double precision NOT NULL,   -- BestPace
  iqr_s              double precision NOT NULL,   -- IQR
  gap_s              double precision NOT NULL,   -- GapS
  gap_pct            double precision NOT NULL,   -- GapPct
  box_whisker_lo_s   double precision NOT NULL,   -- boxplot_stats whislo (whis=1.5, fliers not stored)
  box_q1_s           double precision NOT NULL,   -- q1
  box_q3_s           double precision NOT NULL,   -- q3
  box_whisker_hi_s   double precision NOT NULL,   -- whishi
  box_mean_s         double precision NOT NULL,   -- mean
  sens_rank_lo       integer,              -- min rank across fuel_sensitivity values (NULL if the driver is absent from any column)
  sens_rank_hi       integer,              -- max rank across fuel_sensitivity values
  PRIMARY KEY (session_id, driver_id),
  UNIQUE (session_id, rank),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
CREATE INDEX pace_ranking_driver_idx ON pace_ranking (driver_id, session_id);

-- pace.degradation(laps_fc): one row per driver-stint with >= MIN_STINT_LAPS_FOR_DEG usable laps.
CREATE TABLE degradation_fits (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id          text NOT NULL,
  stint              integer NOT NULL,
  team_id            text NOT NULL,
  compound           text NOT NULL,
  laps               integer NOT NULL,     -- Laps
  deg_s_per_lap      double precision NOT NULL,   -- DegSPerLap
  deg_std_err        double precision NOT NULL,   -- DegStdErr
  r2                 double precision NOT NULL,   -- R2
  fresh_pace_s       double precision NOT NULL,   -- FreshPaceS
  PRIMARY KEY (session_id, driver_id, stint),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
CREATE INDEX degradation_fits_compound_idx ON degradation_fits (compound, session_id);

-- pace.compound_degradation(laps_fc, deg): the pooled np.polyfit line plots.plot_degradation draws.
CREATE TABLE compound_degradation (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  compound           text NOT NULL,
  laps               integer NOT NULL,     -- representative laps with tyre_life >= 2 (row only stored if >= 10)
  slope_s_per_lap    double precision NOT NULL,
  intercept_s        double precision NOT NULL,
  x_min              integer NOT NULL,     -- min tyre_life in the fit
  x_max              integer NOT NULL,     -- max tyre_life in the fit
  PRIMARY KEY (session_id, compound)
);

-- pace.teammate_deltas(ranking)
CREATE TABLE teammate_deltas (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  team_id            text NOT NULL,
  faster_driver_id   text NOT NULL,
  slower_driver_id   text NOT NULL,
  gap_s              double precision NOT NULL,
  gap_pct            double precision NOT NULL,   -- 100 * gap_s / faster median
  laps_compared      integer NOT NULL,
  PRIMARY KEY (session_id, team_id)
);
CREATE INDEX teammate_deltas_faster_idx ON teammate_deltas (faster_driver_id, session_id);
CREATE INDEX teammate_deltas_slower_idx ON teammate_deltas (slower_driver_id, session_id);

-- pace.fuel_sensitivity(clean_laps(session), total_laps), melted from wide (rank@v, gap@v) to long.
CREATE TABLE fuel_sensitivity (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id             text NOT NULL,
  fuel_effect_s_per_kg  double precision NOT NULL,  -- 0.025 | 0.03 | 0.035 (parsed with float())
  rank                  integer NOT NULL,
  gap_s                 double precision NOT NULL,
  PRIMARY KEY (session_id, driver_id, fuel_effect_s_per_kg)
);
```

### 1.7 Raw signals for later features (race sessions only; no v1 page reads them)

```sql
CREATE TABLE weather_samples (
  session_id      integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  sample_idx      integer NOT NULL,        -- DataFrame index
  session_time_s  double precision NOT NULL,
  air_temp        real,
  humidity        real,
  pressure        real,
  rainfall        boolean,
  track_temp      real,
  wind_direction  integer,
  wind_speed      real,
  PRIMARY KEY (session_id, sample_idx)
);

CREATE TABLE track_status_events (
  session_id      integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_idx       integer NOT NULL,        -- DataFrame index
  session_time_s  double precision NOT NULL,
  status          text NOT NULL,           -- '1' AllClear, '2' Yellow, '4' SC, '5' Red, '6' VSC, '7' VSC ending
  message         text,
  PRIMARY KEY (session_id, event_idx)
);
```

### 1.8 Season aggregates (`f1lab.season.recompute(conn, year)` rewrites all rows for the year)

**v1.6 added `season_quali_h2h`** to this family: one row per `(year, kind, team_id,
driver_a, driver_b)`, with `a_wins`/`b_wins` over the sessions both drivers qualified in and
the median gap in seconds and percent. Three things about it are not negotiable and are
enforced by the schema or by §4.3:

- **`kind` is in the primary key and Q and SQ are never pooled.** They are different tyre
  rules on a different track state, and the data shows it: 2025 Q has NOR 12–11 over PIA at
  −0.036%, while 2025 SQ has NOR 2–4 at +0.175% — opposite signs, same pair, same season.
- **`a_wins + b_wins = sessions_counted` is a CHECK**, so a partial rebuild that writes wins
  before the count violates it. `recompute` deletes the whole year (both kinds) and rewrites
  whole rows.
- **Rank on `median_delta_pct`, never `median_delta_s`.** A tenth is 0.142% of a lap at
  Monaco and 0.105% at Shanghai — a 1.36× spread inside one dataset — so a median of seconds
  taken across a season's circuits is not a rankable quantity (`QUALI_SPEC` D9). The seconds
  column is stored because it is what a fan says out loud; it is rendered beside the percent,
  never as the sort key.

Below `season.QUALI_MIN_SESSIONS = 5` the season delta renders greyed and never as a rank,
and `mad_delta_pct` is suppressed entirely below three deltas (a MAD over one point is 0 by
definition — "zero uncertainty" shaped like data).

```sql
-- Snapshot after each ingested round. points = race + sprint points of sessions with round <= after_round;
-- wins/podiums = race sessions only. position order: points desc, then countback (count of race P1s,
-- then P2s, ... P20s, classified rows only), then driver_id asc.
CREATE TABLE driver_standings (
  year          integer NOT NULL,
  after_round   integer NOT NULL,
  driver_id     text NOT NULL REFERENCES drivers(driver_id),
  team_id       text NOT NULL,             -- team of the driver's latest race session <= after_round
  team_name     text NOT NULL,             -- denormalised from that session's session_teams
  team_colour   text NOT NULL,
  position      integer NOT NULL,
  points        double precision NOT NULL,
  sprint_points double precision NOT NULL, -- included in points; shown separately
  wins          integer NOT NULL,
  podiums       integer NOT NULL,
  races         integer NOT NULL,          -- race sessions entered
  PRIMARY KEY (year, after_round, driver_id),
  FOREIGN KEY (year, after_round) REFERENCES events(year, round)
);

CREATE TABLE constructor_standings (
  year         integer NOT NULL,
  after_round  integer NOT NULL,
  team_id      text NOT NULL REFERENCES teams(team_id),
  team_name    text NOT NULL,
  team_colour  text NOT NULL,
  position     integer NOT NULL,
  points       double precision NOT NULL,
  wins         integer NOT NULL,
  podiums      integer NOT NULL,
  PRIMARY KEY (year, after_round, team_id),
  FOREIGN KEY (year, after_round) REFERENCES events(year, round)
);

-- Driver page tiles. One row per (year, driver) with at least one race entry.
CREATE TABLE driver_season_summary (
  year                   integer NOT NULL,
  driver_id              text NOT NULL REFERENCES drivers(driver_id),
  assumption_set_id      integer REFERENCES assumption_sets(assumption_set_id),  -- NULL when seasons.mixed_assumption_sets
  team_id                text NOT NULL,    -- team of the latest race session
  team_name              text NOT NULL,
  team_colour            text NOT NULL,
  races                  integer NOT NULL,
  points                 double precision NOT NULL,   -- race + sprint
  wins                   integer NOT NULL,
  podiums                integer NOT NULL,
  dnfs                   integer NOT NULL,            -- race entries whose classified_position is not numeric
  championship_position  integer,                     -- from driver_standings at standings_after_round
  best_finish            integer,
  avg_finish             double precision,            -- over classified race results
  avg_grid               double precision,            -- over grid_position > 0
  mean_pace_rank         double precision,            -- over pace_ranking rows
  races_ranked           integer NOT NULL,
  PRIMARY KEY (year, driver_id)
);

-- Driver page H2H cards: one row per (driver, teammate) in a season, BOTH directions stored.
CREATE TABLE teammate_h2h (
  year                   integer NOT NULL,
  driver_id              text NOT NULL REFERENCES drivers(driver_id),
  teammate_driver_id     text NOT NULL REFERENCES drivers(driver_id),
  assumption_set_id      integer REFERENCES assumption_sets(assumption_set_id),
  team_id                text NOT NULL,
  races_paired           integer NOT NULL, -- race sessions where both were entered for this team
  pace_wins              integer NOT NULL, -- teammate_deltas rows where driver is faster
  pace_losses            integer NOT NULL,
  mean_signed_gap_pct    double precision, -- mean over teammate_deltas rows, positive = driver faster
  median_signed_gap_pct  double precision,
  finish_wins            integer NOT NULL, -- both classified, lower results.position
  finish_losses          integer NOT NULL,
  grid_wins              integer NOT NULL, -- both grid_position > 0, lower grid
  grid_losses            integer NOT NULL,
  points_for             double precision NOT NULL,   -- race points in paired sessions
  points_against         double precision NOT NULL,
  PRIMARY KEY (year, driver_id, teammate_driver_id)
);
```

### 1.9 Ingest provenance

```sql
CREATE TABLE ingest_runs (
  run_id              serial PRIMARY KEY,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  status              text NOT NULL CHECK (status IN ('running','ok','partial','failed','aborted')),
  cli_args            jsonb NOT NULL,      -- {"season":2025,"round":null,"force":false,"sprints":true,...}
  f1lab_version       text NOT NULL,       -- f1lab.__version__
  fastf1_version      text NOT NULL,
  python_version      text NOT NULL,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  hostname            text,
  sessions_attempted  integer NOT NULL DEFAULT 0,
  sessions_ok         integer NOT NULL DEFAULT 0,
  sessions_failed     integer NOT NULL DEFAULT 0,
  error               text                 -- set when status='aborted' (e.g. rate limit)
);

-- One row per session, REPLACED on re-ingest. Source of the race page's "Modelling assumptions" block.
CREATE TABLE session_ingests (
  session_id         integer PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id             integer NOT NULL REFERENCES ingest_runs(run_id),
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL CHECK (status IN ('ok','partial','failed')),
  analytics_status   jsonb NOT NULL,       -- {"pace_ranking":"ok","fuel_sensitivity":"empty","degradation_fits":"error: IndexError: ...", ...}
  warnings           text[] NOT NULL DEFAULT '{}',   -- e.g. 'SURVIVING laps 41% of raw (< 50%)'
  error              text,                 -- traceback tail when status='failed'
  raw_laps           integer NOT NULL DEFAULT 0,
  clean_laps         integer NOT NULL DEFAULT 0,     -- is_representative count
  total_laps         integer,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  lap_km_used        double precision,     -- always NULL in v1
  fuel_scale         double precision NOT NULL DEFAULT 1.0,
  f1lab_version      text NOT NULL,
  fastf1_version     text NOT NULL
);
```

### 1.10 Population map (which f1lab code writes which table)

| Table | Session kinds | Source |
|---|---|---|
| assumption_sets | — | `assumptions.get_or_create(conn)` at run start |
| seasons, events | — | `fastf1.get_event_schedule(year, include_testing=False)` at `--season` start; `seasons` aggregate columns by `season.recompute` |
| circuits | R, S | `session.session_info['Meeting']['Circuit']` + `session.event` (upsert) |
| sessions | — | schedule (row per round; sprint row when `EventFormat == 'sprint_qualifying'`); `total_laps`, `winner_driver_id`, `fastest_pace_driver_id` set on ingest |
| teams, drivers | R, S | `session.results` (upsert; `latest_*` overwritten) |
| session_teams, session_entries | R, S | `session.results` + `colours.py` |
| compound_colours | R | `colours.compound_colours(session, compounds_seen)` |
| results | R, S | `session.results` |
| laps | R | `clean.annotate_laps(session)` → `pace.fuel_correct(annotated, total_laps, lap_km=None)` → `derive.gap_to_leader` |
| lap_status | R | `derive.lap_status(annotated)` |
| pit_stops | R | `derive.pit_stops(session.laps)` |
| stints | R | `clean.stint_table(session)` |
| lap_exclusion_report | R | `clean.exclusion_report(session)` |
| pace_ranking | R | `pace.pace_ranking(laps_fc)` + `pace.pace_distribution(laps_fc, ranking)` + sens min/max |
| degradation_fits | R | `pace.degradation(laps_fc)` |
| compound_degradation | R | `pace.compound_degradation(laps_fc, deg)` |
| teammate_deltas | R | `pace.teammate_deltas(ranking)` |
| fuel_sensitivity | R | `pace.fuel_sensitivity(clean.clean_laps(session), total_laps)` melted |
| weather_samples | R | `session.weather_data` |
| track_status_events | R | `session.track_status` |
| driver_standings, constructor_standings, driver_season_summary, teammate_h2h | — | `season.recompute(conn, year)` reading Postgres only |
| ingest_runs, session_ingests | — | `ingest.py` |

where `laps_fc = pace.fuel_correct(clean.clean_laps(session), session.total_laps, lap_km=None)` — exactly
the notebook's pipeline, so every stored number equals the notebook's and `fuel_sensitivity`'s
`rank@0.03` column reproduces `pace_ranking.rank`.

### 1.11 Joining f1lab string keys back to ids

`pace.py` frames carry `Driver` (3-letter code) and `Team` (team name). For the session being
ingested: `code -> session_entries.driver_id` and `team_name -> session_teams.team_id`, both built
from the same `session.results`. `frames.py` raises `KeyError` if a code or team name in an analytic
frame is missing from results (never observed; would indicate a FastF1 inconsistency worth stopping on).

### 1.12 Colours and line styles

- Team: `fastf1.plotting.get_team_color(team_name, session=session)` → `('#rrggbb', 'fastf1')`; on
  exception `('#' + results.TeamColor.lower(), 'results')` if present and 6 hex chars; else
  `('#e8a33d', 'fallback')`.
- Compound: `fastf1.plotting.get_compound_mapping(session=session)` merged OVER
  `COMPOUND_FALLBACK = {SOFT '#e8474b', MEDIUM '#e8c547', HARD '#ede6dc', INTERMEDIATE '#4baa5e', WET '#3c7fd6', UNKNOWN '#7a736b', TEST-UNKNOWN '#434649'}`
  (FastF1 wins where present), restricted to keys in the union of the mapping and compounds seen in laps.
- Line style: `fastf1.plotting.get_driver_style(code, style=['linestyle'], session=session)['linestyle']`
  → `'solid'|'dashed'` with source `'fastf1'`; on exception, rank teammates by `int(driver_number)`
  ascending: first `'solid'`, second `'dashed'`, third+ `'dotted'`, source `'fallback'`.
All hex values lowercased.

### 1.13 Later-feature readiness (nothing to build now)

| Feature | Reads |
|---|---|
| Live win probability | `laps` (position, gap_to_leader_s, interval_s, tyre_life, compound, track_status per lap), `lap_status`, `results` |
| Monte Carlo strategy | `degradation_fits` + `compound_degradation` per circuit (`events.circuit_key`), `pit_stops.pit_lane_s` per circuit, `lap_status`, `stints` |
| Hierarchical driver-vs-car | `pace_ranking` (driver_id, team_id, session → year/round/circuit, median_pace_s), `teammate_deltas`, lap-level `laps` (lap_time_fc_s, tyre_life, fuel_kg), `assumption_set_id` to pin the correction |
| SC probability per circuit | `track_status_events`, `lap_status`, `weather_samples`, `events.circuit_key` |

### 1.14 Gap-to-leader derivation (`f1lab/derive.py::gap_to_leader`)

FastF1 `laps.Time` is the session time when the car completed `LapNumber`.

```python
def gap_to_leader(laps: pd.DataFrame) -> pd.DataFrame:
    """Columns: Driver, LapNumber, SessionTimeS, GapToLeaderS, IntervalS, LeaderDriver.
    Pure pandas; rows with NaT Time get NULL in all derived columns."""
    t = laps[["Driver", "LapNumber", "Time"]].copy()
    t["SessionTimeS"] = t["Time"].dt.total_seconds()
    valid = t["SessionTimeS"].notna()
    v = t[valid].sort_values(["LapNumber", "SessionTimeS"])
    leader_t = v.groupby("LapNumber")["SessionTimeS"].transform("min")
    v["GapToLeaderS"] = v["SessionTimeS"] - leader_t
    v["IntervalS"] = v.groupby("LapNumber")["SessionTimeS"].diff()          # NaN for the leader
    v["LeaderDriver"] = v.groupby("LapNumber")["Driver"].transform("first")  # first == min time after the sort
    return t.merge(v[["Driver", "LapNumber", "GapToLeaderS", "IntervalS", "LeaderDriver"]],
                   on=["Driver", "LapNumber"], how="left").drop(columns=["Time"])
```
Verified: min-time car equals `Position == 1` on every lap of 38 races, and the final-lap gaps
reproduce the official classification gaps (2024 Hungary: +2.141 / +14.880 / +19.686). Lapped cars
accumulate more than a lap of gap (correct for a race trace); red flags plateau everyone equally;
`interval_s` uses the sorted-time diff so NaN `Position` rows are handled. Test: rank of
`SessionTimeS` within each lap equals `Position` wherever `Position` is not NaN.

---

## 2. Python ingest design (section B)

### 2.1 Module layout

```
f1lab/
  __init__.py      add:  __version__ = "0.2.0"   (keep existing imports; do NOT import db/ingest here — psycopg is optional for the notebook)
  config.py        UNCHANGED
  clean.py         + annotate_laps(session);  clean_laps() becomes a filter over it (byte-equal output, §2.2)
  pace.py          + pace_distribution(laps, ranking, whis=1.5);  + compound_degradation(laps, deg, min_laps=10, min_tyre_life=2)
  plots.py         UNCHANGED
  assumptions.py   NEW  snapshot() -> dict; hash_of(params) -> str; get_or_create(conn) -> int
  derive.py        NEW  pure pandas, no I/O: gap_to_leader(laps), lap_status(laps), pit_stops(laps)
  colours.py       NEW  team_colour(team_name, session, team_color_hex) -> (hex, source); compound_colours(session, seen) -> dict; line_style(code, session, number_rank) -> (style, source)
  frames.py        NEW  RENAMES, EXPECTED_COLUMNS, build_race_frames(session, ids, assumption_set_id) -> Frames, build_sprint_frames(...)
  db.py            NEW  psycopg 3: connect(), assert_schema(conn), copy_rows(), upsert_rows(), delete_session_children()
  season.py        NEW  recompute(conn, year) -> None
  ingest.py        NEW  CLI (python -m f1lab.ingest) + orchestration
tests/
  conftest.py                 session fixtures from cache: hungary_2024 (2024, 13), miami_2025 (2025, 6), r1_2026 (2026, 1); `db` marker skips unless DATABASE_URL reachable
  legacy_clean.py             VERBATIM copy of the pre-refactor clean_laps() and exclusion_report() (test oracle)
  test_clean_refactor.py      assert_frame_equal(clean_laps(s), legacy.clean_laps(s)) for drop_outliers True/False on all fixtures; annotate_laps membership tests
  test_pace_helpers.py        pace_distribution == boxplot_stats; compound_degradation == inline np.polyfit as plots.py does it
  test_derive.py              gap rank == Position; leader == Position 1; pit_stops count == paired in/out laps; lap_status severity
  test_frames.py              every frame's columns == EXPECTED_COLUMNS[table]; no 'nan' strings; dtypes castable
  test_schema_contract.py     [db] EXPECTED_COLUMNS == live information_schema (tables + columns)
  test_ingest_hungary.py      [db] ingest 2024 R13 twice: identical row counts per table, same session_id, one extra ingest_runs row
requirements.txt  add:  psycopg[binary]==3.3.5   pytest==9.1.1
```

**DB library: psycopg 3.** Drizzle Kit already owns the DDL, so an ORM would be a second, drifting
definition of every table; psycopg 3 gives `cursor.copy()` for COPY-based bulk loads and typed
parameter binding, and needs nothing else.

### 2.2 Changes to existing modules (behaviour-preserving; regression-tested)

`f1lab/clean.py`:
```python
def annotate_laps(session) -> pd.DataFrame:
    """ALL laps of the session with, appended in this order: LapTimeSeconds, excl_no_time, excl_in_lap,
    excl_out_lap, excl_not_green, excl_inaccurate, excl_deleted, is_clean, is_outlier, is_representative.

    is_clean      = no excl_* flag set (the pre-outlier meaning it has always had)
    is_outlier    = is_clean & (LapTimeSeconds > OUTLIER_THRESHOLD * median LapTimeSeconds of the driver's is_clean laps)
    is_representative = is_clean & ~is_outlier
    The flag logic is moved here from clean_laps() unchanged."""

def clean_laps(session, drop_outliers: bool = True) -> pd.DataFrame:
    a = annotate_laps(session)
    keep = a["is_representative"] if drop_outliers else a["is_clean"]
    return a.loc[keep].drop(columns=["is_outlier", "is_representative"]).reset_index(drop=True)
```
`clean_laps` MUST return the same columns, order, dtypes, values and index as before
(`tests/test_clean_refactor.py` enforces it with `pd.testing.assert_frame_equal` against
`tests/legacy_clean.py`, for both `drop_outliers` values, on all three fixtures). `exclusion_report`
is unchanged. The notebook is unaffected.

`f1lab/pace.py`:
```python
def pace_distribution(laps: pd.DataFrame, ranking: pd.DataFrame, whis: float = 1.5) -> pd.DataFrame:
    """One row per Driver in ranking['Driver'] (same order). Columns: Driver, N, WhiskerLo, Q1, Median, Q3,
    WhiskerHi, Mean — from matplotlib.cbook.boxplot_stats(values, whis=whis)[0] over that driver's
    non-null LapTimeFuelCorrected. Median equals ranking.MedianPace (tested)."""

def compound_degradation(laps: pd.DataFrame, deg: pd.DataFrame,
                         min_laps: int = 10, min_tyre_life: int = 2) -> pd.DataFrame:
    """Columns: Compound, Laps, SlopeSPerLap, InterceptS, XMin, XMax. Iterates compounds in
    deg['Compound'].value_counts().index order (exactly what plots.plot_degradation does); for each,
    sub = laps[(Compound == c) & (TyreLife >= min_tyre_life)]; skip if len(sub) < min_laps;
    b, a = np.polyfit(sub.TyreLife.astype(float), sub.LapTimeFuelCorrected.astype(float), 1).
    Returns an empty DataFrame (no columns) if deg is empty."""
```

### 2.3 `f1lab/assumptions.py`

```python
def snapshot() -> dict:
    """Every UPPER_CASE name in f1lab.config plus call-site parameters:
    {"FUEL_START_KG":100.0,"FUEL_EFFECT_S_PER_KG":0.03,"REFERENCE_LAP_KM":4.3,"OUTLIER_THRESHOLD":1.07,
     "GREEN_FLAG":"1","MIN_STINT_LAPS_FOR_DEG":5,
     "apply_lap_km_scaling":false,"pace_min_laps":8,"fuel_sensitivity_values":[0.025,0.03,0.035],
     "deg_min_tyre_life":2,"compound_fit_min_laps":10,"box_whisker":1.5}"""
def hash_of(params: dict) -> str:   # sha256 hexdigest of json.dumps(params, sort_keys=True, separators=(",", ":"))
def get_or_create(conn) -> int:     # INSERT ... ON CONFLICT (hash) DO NOTHING; SELECT assumption_set_id
```
Code versions (`f1lab_version`, `fastf1_version`) are NOT part of the hash; they live on the run rows.

### 2.4 `f1lab/frames.py` and `f1lab/db.py`

**v1.6 — the third frame builder.** Beside `build_race_frames` and `build_sprint_frames`
there is now:

```python
frames.build_quali_frames(session, ids, assumption_set_id, kind=None, cleaned=None) -> Frames
frames.QUALI_TABLE_ORDER = ["session_teams", "session_entries", "laps",
                            "lap_exclusion_report", "quali_results",
                            "quali_segment_times", "quali_teammate_h2h"]
```

`results` is deliberately **popped** — a Q/SQ session writes no `results` row — and
`session_entries` precedes `quali_results` because `quali_results` carries a composite FK to
it. `quali_results` is *not* wrapped in `_guard`: if it raises, the session fails, because the
official times are the session's reason to exist. `lap_exclusion_report`,
`quali_segment_times` and `quali_teammate_h2h` are guarded, so their failure is recorded in
`analytics_status` instead. `db.SESSION_CHILD_TABLES` gained the three per-session qualifying
tables immediately before `laps`; `season_quali_h2h` is season-scoped and is deliberately
absent from it. `build_race_frames` emits `None` for all five new `laps` columns, which is
what keeps `cast_frame`'s column-set check green.

**D8 is a runtime gate, not only a test.** `clean.clean_quali` returns diagnostics whose
`ok` is false when the strict per-driver-per-segment anchor still fails after one bounded
repair. `build_quali_frames` then still writes `laps` and `quali_results` and leaves both
per-segment tables **empty**, and the ingest writes `session_ingests.status = 'partial'`.
This fired exactly once in 79 sessions (2025 R07 Q Imola, BEA seg1 Δ−0.841 s), which is what
a gate looks like when it is real.


```python
# frames.py
RENAMES: dict[str, dict[str, str]]        # per table: DataFrame column -> DB column (the single greppable name map)
EXPECTED_COLUMNS: dict[str, list[str]]     # per table: DB column list exactly as §1 (every table Python writes)

@dataclass
class Frames:
    tables: dict[str, pd.DataFrame]        # key = table name, columns already renamed to DB names, ids resolved
    analytics_status: dict[str, str]       # per analytic: 'ok' | 'empty' | 'error: <ExcType>: <msg>'
    warnings: list[str]
    raw_laps: int
    clean_laps: int
    compounds_seen: list[str]

@dataclass
class SessionIds:                           # built from session.results before any analytics
    session_id: int
    code_to_driver_id: dict[str, str]
    team_name_to_team_id: dict[str, str]

def build_sprint_frames(session, ids: SessionIds) -> Frames        # session_teams, session_entries, results only
def build_race_frames(session, ids: SessionIds, assumption_set_id: int) -> Frames
```
`build_race_frames` order: `annotate_laps` → `fuel_correct(annotated, total_laps, lap_km=None)` →
`derive.gap_to_leader` → laps frame; `clean_laps` → `fuel_correct` → `pace_ranking` →
`pace_distribution`, `degradation`, `compound_degradation`, `teammate_deltas`; `fuel_sensitivity(clean_laps(session), total_laps)`;
`exclusion_report`; `stint_table`; `derive.lap_status`; `derive.pit_stops`; weather; track status.
Each analytic is wrapped individually: `IndexError`/`KeyError`/`ValueError` or an empty frame sets
`analytics_status[name]` and yields an EMPTY frame for that table (never a failed session). If
`pace_ranking` fails, `pace_distribution`, `teammate_deltas`, `fuel_sensitivity` and `sens_rank_*` are
`'empty'` too. Warnings: `SURVIVING < 50% of raw laps`; `compound 'nan' normalised on N laps`.
Casting rules from §0.3 are applied here (`'nan'` → None, NaN → None, float ints → int, timedeltas → seconds).
Test: the fuel columns on representative rows of the laps frame equal `laps_fc`'s (same formula, same inputs).

```python
# db.py
DEFAULT_DSN = "postgres://f1:f1@localhost:5432/f1"
def connect(dsn: str | None = None) -> psycopg.Connection      # dsn or env DATABASE_URL or DEFAULT_DSN; autocommit=False
def assert_schema(conn) -> None
    """Fail fast unless drizzle.__drizzle_migrations exists and, for every table in frames.EXPECTED_COLUMNS,
    the live information_schema.columns set equals it. Error text names the table and the missing/extra
    columns and ends with: run `npm run db:migrate` in web/."""
def copy_rows(cur, table: str, columns: list[str], rows: Iterable[tuple]) -> int      # COPY table (cols) FROM STDIN
def upsert_rows(cur, table: str, columns: list[str], key_columns: list[str], rows, update_columns: list[str]) -> int
def delete_session_children(cur, session_id: int) -> None
    """DELETE in this order: fuel_sensitivity, teammate_deltas, compound_degradation, degradation_fits, pace_ranking,
    lap_exclusion_report, stints, pit_stops, lap_status, laps, track_status_events, weather_samples, results,
    compound_colours, session_entries, session_teams, session_ingests — all WHERE session_id = %s."""
```

### 2.5 `f1lab/ingest.py` — CLI and per-session algorithm

**v1.6 additions.** Two new kinds of schedule row (`Q` for every round, `SQ` for
sprint-qualifying rounds), a kind rank `{R: 0, S: 1, Q: 2, SQ: 3}` that keeps races first so
an existing round's log diff stays additive, and two selection flags, `--only-quali` and
`--no-quali`. **`messages=True` is passed for `Q`/`SQ` only**; `R` and `S` stay pinned at
`messages=False` and `tests/test_guards.py` asserts it, so the race-side change §1.4
describes cannot happen silently. Identity for a sprint-qualifying session is resolved from
the weekend's sibling sessions, because FastF1 hands SQ blank `DriverId`/`TeamId` (and
sometimes the literal string `'nan'`); `ingest.session_ids_for` does that, and a NULL
`driver_id` or `team_id` is never written. The cleaning runs **once**, inside `_check_loaded`,
and the resulting tuple is handed to `build_quali_frames(cleaned=...)`, so a session is never
cleaned twice.


```
python -m f1lab.ingest --season 2025                     # every session whose start_utc + 6h < now(UTC) and whose session_ingests.status is not 'ok'
python -m f1lab.ingest --season 2025 --round 13          # one round (race + sprint if any), re-ingests regardless of status
python -m f1lab.ingest --season 2025 --force             # re-ingest every completed session
python -m f1lab.ingest --season 2025 --no-sprints        # skip kind='S' sessions
python -m f1lab.ingest --season 2024 --round 13          # (dev) the cached Hungary race — Milestone 1 of WP1
python -m f1lab.ingest --season 2026 --dry-run           # load + compute, print per-table row counts, write nothing
python -m f1lab.ingest --season 2025 --recompute-season  # only season.recompute(2025) from stored rows
python -m f1lab.ingest --check-schema                    # exit 0 if assert_schema passes, else 1 with the message
python -m f1lab.ingest --season 2025 --fail-fast         # stop at the first failed session (default: log and continue)
Options: --dsn URL (default env DATABASE_URL), --cache PATH (default f1lab.clean.DEFAULT_CACHE), --sleep SECONDS between FastF1 loads (default 2)
Exit codes: 0 all attempted sessions ok; 1 some failed; 2 aborted (rate limit / schema); logging to stderr, one line per session with counts and elapsed time.
```

Per `--season` run:
```
assert_schema(conn)
assumption_set_id = assumptions.get_or_create(conn)
run_id = INSERT ingest_runs(status='running', ...)                       -- COMMITTED immediately in its own transaction
schedule = fastf1.get_event_schedule(year, include_testing=False)
upsert seasons(year, scheduled_rounds); upsert events(...) for every round (never touching circuit_key);
upsert sessions rows for every round: kind='R' (name 'Race', start_utc = Session5DateUtc) and, when
  EventFormat == 'sprint_qualifying', kind='S' (name 'Sprint', start_utc = SessionNDateUtc of the SessionN named 'Sprint')
  ON CONFLICT (year, round, kind) DO UPDATE SET name, start_utc                 -- COMMITTED
for each session in rounds_to_do (ordered by round, R before S):
    try:
        s = clean.load_race(year, round, kind)            # kind 'R' | 'S'; up to 3 attempts with 10/30/90 s backoff on network errors
        ids = build SessionIds from s.results (upserting teams, drivers, circuits and events.circuit_key in a short committed transaction)
        frames = build_race_frames(s, ids, assumption_set_id) if kind == 'R' else build_sprint_frames(s, ids)
    except fastf1.req.RateLimitExceededError:
        UPDATE ingest_runs SET status='aborted', error=...; exit 2
    except Exception as e:
        UPSERT session_ingests(session_id, run_id, status='failed', error=traceback tail, analytics_status='{}', assumption_set_id) in its own transaction; log; continue (or raise if --fail-fast)
    with conn.transaction():
        delete_session_children(session_id)
        COPY every frame in frames.tables (session_teams, session_entries first; then results; then laps ... in FK order)
        UPDATE sessions SET total_laps, winner_driver_id, fastest_pace_driver_id
        INSERT session_ingests(status = 'ok' if all analytics ok else 'partial', analytics_status, warnings, counts, versions, assumption_set_id, fuel_scale=1.0, lap_km_used=NULL)
    sleep(--sleep)
season.recompute(conn, year)                               -- one transaction, after the loop (also after --round runs)
UPDATE ingest_runs SET status ('ok' | 'partial' if any partial | 'failed' if any failed), finished_at, counts
```

Idempotency: the `sessions` row is upserted so `session_id` is stable across re-ingests; every child
row is deleted and re-inserted inside one transaction, because every analytic row depends on the whole
lap set (a driver who drops below 8 clean laps after a rule change must disappear). Dimension tables
(`teams`, `drivers`, `circuits`, `assumption_sets`) use `ON CONFLICT DO UPDATE`. `events` and `sessions`
rows are never deleted by ingest. A crash mid-transaction leaves the previous good data intact.

"Completed" = `sessions.start_utc + 6 h < now(UTC)`. A session FastF1 refuses because data is not yet
available is recorded as `failed` with the exception text and retried on the next run.

### 2.6 `f1lab/season.py::recompute(conn, year)`

**v1.6:** `compute` returns a fifth frame, `season_quali_h2h`, and `recompute` deletes and
rewrites it inside the same transaction as the standings — first in the delete list, last in
the write list, so it is never orphaned. The delete is `WHERE year = %s` with **no** kind
predicate: a rebuild always replaces both Q and SQ for that year, which is what the
`a_wins + b_wins = sessions_counted` CHECK requires. Wins come from `quali_results.position`
and deltas from `quali_teammate_h2h` filtered to `comparable`, which is why a session the D8
gate turned `partial` still contributes its wins and zero deltas — `sessions_counted` and
`deltas_counted` differ on 63 of 789 pair-sessions and a consumer that assumes they are equal
is wrong. `sessions_caveated` is derived from `session_ingests.warnings[]`, not from a column.


Reads `sessions`, `session_ingests`, `session_entries`, `session_teams`, `results`, `pace_ranking`,
`teammate_deltas` for the year from Postgres (never FastF1), then in one transaction deletes and
rewrites `driver_standings`, `constructor_standings`, `driver_season_summary`, `teammate_h2h` for the
year and updates `seasons` (`ingested_rounds`, `standings_after_round`, `assumption_set_id`,
`mixed_assumption_sets`, `has_sprint_results`, `recomputed_at`). Definitions are in §1.8. Standings
are written for EVERY `after_round` in 1..standings_after_round (only rounds whose race session is
ok/partial count; a failed round contributes nothing and the snapshot for that round still exists).
`mixed_assumption_sets = (count distinct assumption_set_id over ok/partial race session_ingests) > 1`;
when true, `driver_season_summary.assumption_set_id` and `teammate_h2h.assumption_set_id` are NULL.

---

## 3. Web architecture (section C)

### 3.1 Directory layout (`<root>/web`, no `src/`)

```
web/
  package.json                FINAL after WP0 (§5.1 lists every dependency)
  package-lock.json           committed
  next.config.ts              { serverExternalPackages: ['pg'] }
  tsconfig.json               unchanged from scaffold
  eslint.config.mjs           unchanged
  postcss.config.mjs          unchanged
  drizzle.config.ts           defineConfig({ dialect: 'postgresql', schema: './db/schema/index.ts', out: './drizzle', dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://f1:f1@localhost:5432/f1' } })
  .env.example                DATABASE_URL=postgres://f1:f1@localhost:5432/f1   (WP0 adds `!.env.example` to web/.gitignore)
  drizzle/                    0000_init.sql + meta/  (generated with `drizzle-kit generate --name init`; committed)
  scripts/db-smoke.ts         opens the pool, SELECT 1, prints row counts of sessions/laps/pace_ranking (run with tsx)
  db/
    client.ts                 pg Pool singleton cached on globalThis + drizzle(pool, { schema })
    schema/
      index.ts                export * from './reference'; './session'; './laps'; './analytics'; './raw'; './season'; './provenance'
      reference.ts            assumptionSets, seasons, circuits, events, teams, drivers, sessions
      session.ts              sessionTeams, sessionEntries, compoundColours, results
      laps.ts                 laps, lapStatus, pitStops, stints
      analytics.ts            lapExclusionReport, paceRanking, degradationFits, compoundDegradation, teammateDeltas, fuelSensitivity
      raw.ts                  weatherSamples, trackStatusEvents
      season.ts               driverStandings, constructorStandings, driverSeasonSummary, teammateH2h
      provenance.ts           ingestRuns, sessionIngests
  lib/
    theme.ts                  PALETTE, f1darkTheme (ECharts theme object), COMPOUND_FALLBACK, TEAM_FALLBACK
    format.ts                 fmtLapTime, fmtRaceTime, fmtGap, fmtPct, fmtDate, fmtSigned, gpShortName
    colours.ts                ColourMap type, teamColour(map, id), compoundColour(map, c), lineStyleFor(style)
    queries/
      shared.ts               shared row types + seasonsWithData, latestSeasonWithData, getLatestRace, sessionIdFor
      home.ts                 getHome
      season.ts               getRaceList, getStandings, getSeason
      race.ts                 getRaceHeader ... getAssumptions
      driver.ts               resolveDriver, getDriverSeason
  components/
    charts/
      EChart.tsx              the ONE wrapper ('use client')
      PaceBoxPlot.tsx  StintGantt.tsx  DegradationScatter.tsx  RaceTrace.tsx  TeammateBars.tsx   (race page package)
      DriverSeasonChart.tsx   (driver page package)
    ui/                       Nav.tsx PageHeader.tsx Section.tsx DataTable.tsx StatTile.tsx TeamDot.tsx DriverChip.tsx CompoundChip.tsx StatusBadge.tsx EmptyState.tsx Caption.tsx SeasonSwitcher.tsx
    home/                     LatestRaceHero.tsx StandingsSnapshot.tsx
    season/                   RaceList.tsx StandingsTable.tsx ConstructorsTable.tsx
    race/                     RaceHeader.tsx ResultsTable.tsx PaceSection.tsx StintSection.tsx DegradationSection.tsx TraceSection.tsx TeammateSection.tsx SensitivityTable.tsx ExclusionTable.tsx AssumptionsPanel.tsx
    driver/                   DriverHeader.tsx SummaryTiles.tsx DriverResultsTable.tsx H2HCard.tsx
  app/
    layout.tsx  globals.css  not-found.tsx  error.tsx  favicon.ico
    page.tsx                                  /
    season/[year]/page.tsx                    /season/[year]
    race/[year]/[round]/page.tsx              /race/[year]/[round]
    driver/[code]/page.tsx                    /driver/[code]?season=YYYY
```

Rendering rules:
- Every `page.tsx` is an async Server Component with `export const dynamic = 'force-dynamic'` and a
  `generateMetadata` (`'Hungarian Grand Prix 2025 · F1 Analytics'`). Pages call query functions
  (server) and pass **plain JSON-serialisable props** (numbers, strings, null, arrays, plain objects)
  to components. No API routes. No client-side fetching.
- Only `components/charts/*` are `'use client'`. Nothing under `components/charts` imports from `db/`
  or `lib/queries`. Nothing outside `components/charts/EChart.tsx` imports `echarts`.
- `components/ui/DataTable.tsx` is a server-safe presentational table (no sorting state in v1).
- Colours are never computed in the web app: every query returns hex strings from `session_teams` /
  `compound_colours` / denormalised standings columns; charts read them from props.

### 3.2 Drizzle schema conventions

- Explicit column names in every builder (`text('team_id')`), NOT the `casing` option — the DDL in §1
  is the contract and Python checks column names, so transcription fidelity beats brevity.
- `doublePrecision()` for seconds and percentages, `real()` for speeds/weather, `integer()` everywhere
  else (no smallint), `text()` for ids, `date('event_date', { mode: 'string' })`,
  `timestamp('x', { withTimezone: true, mode: 'string' })`, `jsonb('params').$type<Record<string, unknown>>()`,
  `text('warnings').array().notNull().default(sql\`'{}'\`)`.
- Composite keys/constraints via the array form: `(t) => [primaryKey({ columns: [...] }), unique().on(...), foreignKey({ columns: [...], foreignColumns: [...] }).onDelete('cascade'), index('name').on(...), check('name', sql\`...\`)]`.
  The partial index on `laps` is `index('laps_session_repr_idx').on(t.sessionId, t.compound, t.tyreLife).where(sql\`is_representative\`)`.
- `db/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
const g = globalThis as unknown as { __f1Pool?: Pool };
export const pool = g.__f1Pool ?? (g.__f1Pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://f1:f1@localhost:5432/f1', max: 5 }));
export const db = drizzle(pool, { schema });
export type Db = typeof db;
```
- Migration: `npm run db:generate` = `drizzle-kit generate --name init` (first time), `npm run db:migrate` =
  `drizzle-kit migrate` (creates `drizzle.__drizzle_migrations`, which Python checks).

### 3.3 Query layer — exact exports

All functions are `async`, take primitives, return plain objects, and live in `web/lib/queries/`.
Lap times and gaps are numbers in seconds; dates are ISO strings.

```ts
// lib/queries/shared.ts   (WP0)
export type IngestStatus = 'pending' | 'ok' | 'partial' | 'failed';
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type TeamRef = { teamId: string; teamName: string; teamColour: string };
export type DriverRef = TeamRef & { driverId: string; code: string; fullName: string; lineStyle: LineStyle };
export type ColourMap = { teams: Record<string, string>; compounds: Record<string, string> };   // keyed by teamId / compound
export type RaceNavLink = { year: number; round: number; eventName: string };
export async function seasonsWithData(): Promise<number[]>;                 // seasons.ingested_rounds > 0, desc
export async function latestSeasonWithData(): Promise<number | null>;
export async function getLatestRace(year?: number): Promise<RaceNavLink | null>;   // highest round with race session_ingests.status in ('ok','partial')
export async function sessionIdFor(year: number, round: number, kind?: 'R' | 'S'): Promise<number | null>;  // default 'R'

// lib/queries/season.ts   (WP3)
export type RaceListRow = {
  year: number; round: number; eventName: string; location: string; country: string; circuitShortName: string | null;
  eventDate: string; eventFormat: string; hasSprint: boolean; totalLaps: number | null;
  ingestStatus: IngestStatus; winner: DriverRef | null; fastestPace: DriverRef | null;
};
export type StandingRow = { position: number; driverId: string; code: string; fullName: string; teamId: string; teamName: string; teamColour: string; points: number; sprintPoints: number; wins: number; podiums: number; races: number };
export type ConstructorRow = { position: number; teamId: string; teamName: string; teamColour: string; points: number; wins: number; podiums: number };
export type SeasonData = {
  year: number; scheduledRounds: number; ingestedRounds: number; afterRound: number | null;
  hasSprintResults: boolean; mixedAssumptionSets: boolean;
  drivers: StandingRow[]; constructors: ConstructorRow[]; races: RaceListRow[];   // races: all scheduled rounds asc
};
export async function getRaceList(year: number): Promise<RaceListRow[]>;
export async function getStandings(year: number): Promise<{ afterRound: number; drivers: StandingRow[]; constructors: ConstructorRow[] } | null>;
export async function getSeason(year: number): Promise<SeasonData | null>;    // null if seasons row missing

// lib/queries/home.ts   (WP3)
export type HomeData = {
  year: number; seasons: number[];
  latest: (RaceListRow & { podium: DriverRef[]; runnerUpPace: { code: string; gapS: number } | null }) | null;
  completed: RaceListRow[];              // ingestStatus in ('ok','partial'), newest first
  afterRound: number | null; drivers: StandingRow[] /* top 8 */; constructors: ConstructorRow[];
};
export async function getHome(): Promise<HomeData | null>;                  // null when no season has data

// lib/queries/race.ts   (WP4)
export type RaceHeader = {
  sessionId: number; year: number; round: number; eventName: string; officialName: string; location: string; country: string;
  circuitShortName: string | null; eventDate: string; totalLaps: number | null; ingestStatus: IngestStatus; ingestError: string | null;
  warnings: string[]; podium: (DriverRef & { position: number })[]; winnerTimeS: number | null;
  lapsUsed: { representative: number; raw: number } | null; prev: RaceNavLink | null; next: RaceNavLink | null;
};
export type PaceRow = DriverRef & {
  rank: number; cleanLaps: number; medianPaceS: number; bestPaceS: number; iqrS: number; gapS: number; gapPct: number;
  box: [number, number, number, number, number];   // whiskerLo, q1, median, q3, whiskerHi
  sensRankLo: number | null; sensRankHi: number | null; finishPosition: number | null;
};
export type StintRow = { driverId: string; code: string; stint: number; compound: string; compoundColour: string; startLap: number; endLap: number; laps: number };
export type DegPoint = { code: string; compound: string; tyreLife: number; lapTimeFcS: number };
export type CompoundFit = { compound: string; compoundColour: string; laps: number; slopeSPerLap: number; interceptS: number; xMin: number; xMax: number };
export type DegFitRow = DriverRef & { stint: number; compound: string; compoundColour: string; laps: number; degSPerLap: number; degStdErr: number; r2: number; freshPaceS: number };
export type TraceSeries = DriverRef & { finishPosition: number | null; gaps: (number | null)[] /* index = lapNumber - 1, length totalLaps */; positions: (number | null)[] };
export type LapStatusRow = { lapNumber: number; isGreen: boolean; worstStatus: string };
export type TeammateRow = { team: TeamRef; faster: DriverRef; slower: DriverRef; gapS: number; gapPct: number; lapsCompared: number };
export type SensitivityRow = { driverId: string; code: string; team: TeamRef; cells: { fuelEffect: number; rank: number; gapS: number }[] /* asc by fuelEffect */; moves: boolean };
export type ExclusionRow = { order: number; rule: string; lapsHit: number; pctOfAll: number; isSurviving: boolean };
export type RaceResultRow = DriverRef & { position: number | null; classifiedPosition: string; gridPosition: number | null; points: number; status: string; lapsCompleted: number | null; resultTimeS: number | null };
export type AssumptionsView = {
  params: Record<string, unknown>; assumptionSetId: number; f1labVersion: string; fastf1Version: string; ingestedAt: string;
  rawLaps: number; cleanLaps: number; lapKmUsed: number | null; fuelScale: number; analyticsStatus: Record<string, string>; warnings: string[];
};
export async function getRaceHeader(year: number, round: number): Promise<RaceHeader | null>;   // null if no sessions row
export async function getRaceColours(sessionId: number): Promise<ColourMap>;
export async function getPaceRanking(sessionId: number): Promise<PaceRow[]>;                     // ORDER BY rank
export async function getStints(sessionId: number): Promise<{ order: DriverRef[]; stints: StintRow[] }>;   // order = results.position asc NULLS LAST, laps_completed desc; stints ORDER BY driver order, start_lap
export async function getDegradation(sessionId: number): Promise<{ points: DegPoint[]; fits: CompoundFit[]; perStint: DegFitRow[] }>;   // points: is_representative AND tyre_life >= 2 AND compound IN fits
export async function getRaceTrace(sessionId: number): Promise<{ totalLaps: number; series: TraceSeries[]; lapStatus: LapStatusRow[] }>;   // series ordered like getStints.order
export async function getTeammateDeltas(sessionId: number): Promise<{ rows: TeammateRow[]; unpaired: { team: TeamRef; reason: string }[] }>;   // rows ORDER BY gap_pct DESC
export async function getFuelSensitivity(sessionId: number): Promise<{ values: number[]; baseValue: number; rows: SensitivityRow[]; movers: number }>;   // baseValue = params.FUEL_EFFECT_S_PER_KG; rows ORDER BY rank at baseValue
export async function getExclusionReport(sessionId: number): Promise<{ rawLaps: number; rows: ExclusionRow[] }>;   // ORDER BY rule_order
export async function getRaceResults(sessionId: number): Promise<RaceResultRow[]>;                // ORDER BY position NULLS LAST, laps_completed DESC
export async function getAssumptions(sessionId: number): Promise<AssumptionsView | null>;

// lib/queries/driver.ts   (WP5)
export type DriverProfile = { driverId: string; code: string; fullName: string; number: string; countryCode: string | null; headshotUrl: string | null; seasons: number[] /* years with race entries, desc */ };
export type DriverRaceRow = {
  round: number; eventName: string; shortName: string; eventDate: string; ingestStatus: IngestStatus; team: TeamRef;
  gridPosition: number | null; position: number | null; classifiedPosition: string; status: string; points: number; sprintPoints: number | null;
  paceRank: number | null; medianPaceS: number | null; gapToP1S: number | null; gapToP1Pct: number | null; sensRankLo: number | null; sensRankHi: number | null;
  teammate: DriverRef | null; signedGapPct: number | null /* + = this driver faster */; signedGapS: number | null; lapsCompared: number | null;
};
export type DriverSummary = { team: TeamRef; races: number; points: number; wins: number; podiums: number; dnfs: number; championshipPosition: number | null; bestFinish: number | null; avgFinish: number | null; avgGrid: number | null; meanPaceRank: number | null; racesRanked: number };
export type H2HRow = { teammate: DriverRef; racesPaired: number; paceWins: number; paceLosses: number; meanSignedGapPct: number | null; medianSignedGapPct: number | null; finishWins: number; finishLosses: number; gridWins: number; gridLosses: number; pointsFor: number; pointsAgainst: number };
export type DriverSeason = { profile: DriverProfile; year: number; mixedAssumptionSets: boolean; summary: DriverSummary | null; races: DriverRaceRow[]; h2h: H2HRow[] };
export async function resolveDriver(code: string, year: number | null): Promise<{ driverId: string; year: number } | null>;
   // code upper-cased; driverId via session_entries.code within `year` (default latestSeasonWithData), else drivers.latest_code; year = requested, else the driver's latest season
export async function getDriverSeason(driverId: string, year: number): Promise<DriverSeason | null>;
```

Only `getRaceHeader` takes `(year, round)`; the race page then fans out the other queries with
`Promise.all` on `header.sessionId`. `getRaceTrace` is the only query that reshapes rows (pivot of
`(driver_id, lap_number, gap_to_leader_s, position)` into per-driver arrays) — pure formatting.
`unpaired` is derived from `session_teams` minus `teammate_deltas` with reason `'only N of 2 drivers ranked'`
computed from the count of `pace_ranking` rows per team (trivial).

### 3.4 ECharts wrapper (`components/charts/EChart.tsx`)

```ts
'use client';
import type { EChartsOption } from 'echarts';            // type-only import; no runtime cost
export type EChartProps = {
  option: EChartsOption;        // fully built by the caller; wrapper only applies the theme
  height?: number | string;     // default 420
  className?: string;
  ariaLabel: string;            // required; set as aria-label + role="img" on the container
  notMerge?: boolean;           // default true
};
export default function EChart(props: EChartProps): React.JSX.Element;
```
Implementation: `import * as echarts from 'echarts/core'`; `import { BarChart, BoxplotChart, ScatterChart, LineChart, CustomChart } from 'echarts/charts'`;
`import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkAreaComponent, MarkLineComponent, TitleComponent, AxisPointerComponent } from 'echarts/components'`;
`import { CanvasRenderer } from 'echarts/renderers'`; `echarts.use([...])` and `echarts.registerTheme('f1dark', f1darkTheme)` once at module scope.
`useEffect`: `echarts.init(ref.current, 'f1dark', { renderer: 'canvas' })`, `setOption(option, { notMerge })`, a `ResizeObserver` calling `resize()`, `dispose()` on unmount; a second effect re-runs `setOption` when `option` changes. The container `<div style={{ height }}>` renders on the server (stable layout); the canvas is drawn only on the client, so there is no hydration mismatch and no `next/dynamic` anywhere.

`lib/theme.ts`:
```ts
export const PALETTE = { bg: '#12100E', fg: '#EDE6DC', grid: '#3A342D', accent: '#E8A33D', surface: '#1C1916', muted: '#9A9187' } as const;
export const COMPOUND_FALLBACK: Record<string, string> = { SOFT: '#e8474b', MEDIUM: '#e8c547', HARD: '#ede6dc', INTERMEDIATE: '#4baa5e', WET: '#3c7fd6', UNKNOWN: '#7a736b', 'TEST-UNKNOWN': '#434649' };
export const TEAM_FALLBACK = PALETTE.accent;
export const f1darkTheme = { backgroundColor: 'transparent', textStyle: { color: PALETTE.fg }, /* axis line/tick/splitLine in grid, axis labels fg 12px, legend fg, tooltip bg surface border grid text fg */ color: [PALETTE.accent, '#4baa5e', '#3c7fd6', '#e8474b', '#7a736b'] };
```
Tailwind tokens in `app/globals.css`:
```css
@import "tailwindcss";
@theme { --color-bg: #12100E; --color-fg: #EDE6DC; --color-grid: #3A342D; --color-accent: #E8A33D; --color-surface: #1C1916; --color-muted: #9A9187; --font-sans: var(--font-geist-sans); --font-mono: var(--font-geist-mono); }
html { color-scheme: dark; } body { @apply bg-bg text-fg; }
```
The site is dark-only (no toggle). Team/compound hex values are applied with inline `style`
(Tailwind cannot generate runtime colours). `TeamDot`, `DriverChip`, `CompoundChip` take the hex as a prop.

### 3.5 Colour flow

Ingest writes `session_teams.colour`, `compound_colours.colour`, `session_entries.line_style`, and
`season.py` denormalises `team_colour` into standings/summary rows. Every query row that names a
driver or team carries `teamColour` (and `lineStyle`) inline; `getRaceColours` returns the two maps
for charts keyed by id/compound. Charts use `colours.teams[teamId] ?? TEAM_FALLBACK` and
`colours.compounds[compound] ?? COMPOUND_FALLBACK[compound] ?? COMPOUND_FALLBACK.UNKNOWN`.
`lineStyleFor('dashed')` → `{ type: 'dashed', width: 1.6 }` etc.

---

## 4. Page-by-page spec (section D)

Conventions on every page: lap times `m:ss.mmm` (`fmtLapTime(81.579)` → `1:21.579`), race times
`h:mm:ss.mmm`, gaps `+0.314s`, percentages 3 dp below 1 %, else 2 dp. Every section is a
`<Section title caption>`; a section whose data is empty renders `<EmptyState reason>` (reason from
`analyticsStatus` when available) — pages never throw on empty analytics. `notFound()` only when the
`sessions`/`seasons`/`drivers` row is missing. Every chart card carries a one-line `<Caption>` with
the notebook's caveat.

### 4.1 `/` (home) — `getHome()`

1. Empty state when `null`: card with `python -m f1lab.ingest --season 2026` and a README link.
2. **Latest race hero** — event name, date, location; podium chips; "Fastest race pace: NOR (McLaren) — PIA +0.055s"
   from `latest.fastestPace` / `runnerUpPace` (this is the site's own number, shown first); link to `/race/{year}/{round}`.
3. **Standings snapshot** — two side-by-side tables (drivers top 8, all constructors) after `afterRound`,
   columns pos / chip / team / points / wins; link "Full standings" → `/season/{year}`.
4. **Completed races** (`RaceList`, newest first) — Rd, Date, Grand Prix (link), Circuit, Winner chip,
   Fastest-pace chip, a "pace ≠ winner" marker when they differ, `StatusBadge` when `ingestStatus != 'ok'`.
5. `SeasonSwitcher` from `seasons`.

### 4.2 `/season/[year]` — `getSeason(year)` (404 when null)

1. Header: "{year} season", "{ingestedRounds} of {scheduledRounds} rounds ingested · standings after round {afterRound}", `SeasonSwitcher`.
   Warning badge "assumption sets differ between races" when `mixedAssumptionSets`.
2. **Drivers standings** — Pos, DriverChip (link `/driver/{code}?season={year}`), Team, Points, (Sprint pts), Wins, Podiums, Races.
3. **Constructors standings** — Pos, Team (TeamDot), Points, Wins, Podiums.
4. **Race list** — all rounds asc; pending rounds muted without a link; failed rounds show "data unavailable"; sprint icon when `hasSprint`.
5. Footnote: "Points sum race and sprint results as published by the timing API; penalties applied
   later by the FIA may not be reflected." If `!hasSprintResults`: "Sprint points not yet ingested."

### 4.3 `/race/[year]/[round]` — `getRaceHeader` then `Promise.all` of the rest

Section order: result → pace → strategy → why → trust.

1. **RaceHeader** — event name; official name (muted); date; "{location}, {country} · {circuitShortName} · {totalLaps} laps";
   podium chips with team dots; winner time (`fmtRaceTime(winnerTimeS)`); data-quality chip
   "{representative} of {raw} laps used ({pct}%)"; `StatusBadge` + warnings; prev/next race links.
   If `ingestStatus == 'failed'`: show `ingestError` and render nothing else. If `'pending'`: "not yet ingested".
2. **ResultsTable** (collapsed `<details>`) — `getRaceResults`: Pos, Driver, Team, Grid, Status, Laps, Points, Time/Gap
   (`fmtRaceTime` for P1; `+gap` only when `status == 'Finished'`; blank otherwise, per §0.3).
3. **Fuel-corrected race pace** — `getPaceRanking`, `getRaceColours`. `PaceBoxPlot` props `{ rows: PaceRow[] }`:
   ECharts `boxplot` series; xAxis `category` of codes in rank order, `axisLabel.formatter` = `CODE\n—` for rank 1 else `CODE\n+{gapS 2dp}`;
   yAxis value "Fuel-corrected lap time (s)", `scale: true`; datum `row.box`; `itemStyle.color` = teamColour, `borderColor` = grid,
   `medianLine` colour bg (use `itemStyle.borderColor` for whiskers and set per-datum `itemStyle`); teammate with `lineStyle 'dashed'` gets `itemStyle.borderType 'dashed'`.
   Tooltip: code, team, median, best, IQR, clean laps, sensitivity range. Table below: Rank, Driver, Team, Clean laps, Median,
   Best, IQR, Gap (s), Gap (%), Stable (tick when `sensRankLo == sensRankHi`, else "±N"); winner row gets an accent border.
   Caption: "Race pace, fuel-corrected to an empty tank — green-flag laps only; in/out laps and outliers removed. Median, not mean: residual noise is one-sided."
4. **Tyre strategy** — `getStints`. `StintGantt` props `{ order: DriverRef[]; stints: StintRow[]; totalLaps: number }`:
   ECharts `custom` series; yAxis `category` of codes in `order` with `inverse: true` (winner on top); xAxis value 0..totalLaps "Lap";
   data rows `[driverIndex, startLap - 1, endLap, laps, compound, compoundColour]`, `encode: { x: [1, 2], y: 0 }`;
   `renderItem` draws a rect from `api.coord([start, y])` to `api.coord([end, y])`, height `api.size([0, 1])[1] * 0.62`,
   clipped with `echarts.graphic.clipRectByRect(rect, params.coordSys)`, fill compoundColour, stroke bg 1px; label (laps count, bold, bg colour)
   when `laps >= 6`. Legend built from compounds seen (title-cased) using compound colours. Tooltip `VER · HARD · laps 7–29 (23)`.
   Retired drivers keep their rows; stints need not start at lap 1. Height = `26 * order.length + 80` px.
   Caption: "Ordered by finishing position, so strategy and result read together."
5. **Tyre degradation** — `getDegradation`. `DegradationScatter` props `{ points, fits }`:
   one `scatter` series per compound in `fits` (x tyreLife, y lapTimeFcS, symbolSize 4, opacity 0.32, compoundColour) plus one `line` series
   per fit with two points `[xMin, interceptS + slope*xMin]`, `[xMax, interceptS + slope*xMax]`, width 2.2, `showSymbol false`,
   legend name `` `${Compound}  ${slope:+.3f} s/lap` ``; xAxis "Tyre age (laps)", yAxis "Fuel-corrected lap time (s)" `scale: true`.
   `DegradationTable` (collapsed): Driver, Stint, Compound chip, Laps, Slope ± std err, R², Fresh pace; rows with `degStdErr >= |degSPerLap|` muted and tagged "not a finding".
   Caption: notebook §7 text — pooled slopes are confounded by track evolution; a negative soft slope means the track was rubbering in.
6. **Race trace** — `getRaceTrace`. `RaceTrace` props `{ totalLaps, series, lapStatus }`:
   one `line` series per driver in finish order; data `[lap, gap]` for lap 1..totalLaps; `connectNulls: false`; colour teamColour;
   `lineStyle.type` = lineStyle; width 1.6; `showSymbol: false`; `emphasis.focus: 'series'`; yAxis "Gap to leader (s)" `inverse: true`
   (leader along the top at 0); xAxis "Lap"; `dataZoom` slider on x; `markArea` on the first series for contiguous runs of `!isGreen` laps,
   fill grid at 35 % opacity, label the worst status (`SC` for '4', `VSC` for '6'/'7', `Red` for '5', `Yellow` for '2'); legend scrollable;
   tooltip `axis` trigger sorted by gap ascending showing code, position, gap.
   Caption: "Gap = time the car completed lap N minus time the leader completed lap N. Lapped cars keep growing; red flags shift everyone equally."
7. **Teammate head-to-head** — `getTeammateDeltas`. `TeammateBars` props `{ rows }`:
   horizontal `bar`; yAxis `category` of team names sorted by gapPct ascending with `inverse: true` (largest gap on top, as `plots.py`);
   xAxis "Teammate pace gap (% of lap time)", max = 1.45 × largest; bar colour teamColour; label right of bar `` `${faster.code} by ${gapS 2dp}s` ``;
   tooltip adds laps compared. `unpaired` teams listed under the chart ("no comparable pair: Aston Martin — only 1 of 2 drivers ranked").
   Caption: "Same car, so the gap is the cleanest available driver signal — but a single race is a noisy, confounded observation."
8. **Fuel-constant sensitivity** — `getFuelSensitivity`. `SensitivityTable`: Driver, then `rank @ v` / `gap @ v` per value asc; rows ordered
   by rank at `baseValue`; rows with `moves` get an accent left border; heading "{movers} of {rows} placings move across the plausible range".
   Caption: notebook §5 text ("Where the ordering holds, the result is a fact about the race; where it shuffles, it was an artefact of a number we guessed.").
9. **What was thrown away** — `getExclusionReport`. `ExclusionTable`: Rule / Laps / % of all in stored order; SURVIVING row bold with accent;
   note "Rules overlap, so percentages do not sum to 100."
10. **Modelling assumptions** — `getAssumptions`. `AssumptionsPanel`: definition list of every `params` key with the explanation text
    (lifted from `config.py` comments, kept in `AssumptionsPanel.tsx`): fuel at start (kg), fuel effect (s/kg/lap), reference lap (km),
    lap-km scaling ("not applied — reference constant used unscaled" when `lapKmUsed == null`), outlier threshold, green-flag code, min stint laps
    for degradation, min clean laps for ranking, sensitivity values, deg min tyre life, compound fit min laps, box whisker; then
    "Computed by f1lab {f1labVersion} / FastF1 {fastf1Version} on {ingestedAt}; {rawLaps} raw → {cleanLaps} representative laps; assumption set #{id}".
    Any `analyticsStatus` entry not `'ok'` is listed with its reason. Rendered from the DB row, never from web constants.

### 4.4 `/driver/[code]?season=YYYY` — `resolveDriver(code, season)` → `getDriverSeason`

`const { code } = await params; const { season } = await searchParams;` lower-case codes redirect to upper-case.
404 when `resolveDriver` returns null.

1. **DriverHeader** — full name, number, country, headshot (`<img>` with fallback initials), team chip (team of the latest race), `SeasonSwitcher` over `profile.seasons`. Warning badge when `mixedAssumptionSets`.
2. **SummaryTiles** — points, championship position, wins, podiums, DNFs, avg finish, avg grid, mean pace rank ("over {racesRanked} ranked races").
3. **DriverSeasonChart** props `{ races: DriverRaceRow[]; teamColour: string }`: one ECharts instance, two grids sharing the x axis (rounds, labelled with `shortName`), `axisPointer.link`:
   top grid — pace rank per round, yAxis `inverse: true` min 1, `line` + symbols in teamColour, symbol hollow when `sensRankLo != sensRankHi`, null where no rank;
   bottom grid — `signedGapPct` bars, positive (driver faster) in teamColour, negative in muted, zero `markLine` in fg, null where no pair.
   Tooltip: event, finish, pace rank, gap to P1 (s, %), teammate code and signed gap (s, %).
4. **DriverResultsTable** — Rd, Grand Prix (link), Team (chip; highlights mid-season swaps), Grid, Finish, Status, Points (+sprint), Pace rank, Median pace, Gap to P1 (s / %), Teammate, Gap vs teammate (%), Laps compared.
5. **H2HCard** per `h2h` row — races paired, pace wins/losses ("9 of 13 races faster"), mean and median signed gap %, finish H2H, grid H2H, points for/against.
   Caption: "Single-season, single-car comparison; confounded by strategy, traffic and damage. The pooled hierarchical model is the real answer."

---

## 5. Work breakdown (section E)

Ownership is STRICT: a package creates/edits only the paths listed for it. If a package needs
something outside its paths, it writes a private helper inside its own directory and reports the gap
in its final summary; it never edits another package's files. The schema is FROZEN after WP0: a
package that believes it needs a schema change stops and reports instead of editing `web/db/schema`
or `web/drizzle`.

### 5.1 WP0 — Web foundation (SEQUENTIAL FIRST; schema + migration in the first hours)

Owns: `web/package.json`, `web/package-lock.json`, `web/next.config.ts`, `web/drizzle.config.ts`,
`web/.env.example`, `web/.gitignore` (add `!.env.example`), `web/drizzle/**`, `web/db/**`,
`web/scripts/**`, `web/lib/theme.ts`, `web/lib/format.ts`, `web/lib/colours.ts`,
`web/lib/queries/shared.ts`, `web/components/charts/EChart.tsx`, `web/components/ui/**`,
`web/app/layout.tsx`, `web/app/globals.css`, `web/app/not-found.tsx`, `web/app/error.tsx`,
placeholder `web/app/page.tsx`, `web/app/season/[year]/page.tsx`, `web/app/race/[year]/[round]/page.tsx`,
`web/app/driver/[code]/page.tsx` (each renders the shell + "coming soon"; later packages overwrite their own),
`web/README.md`, root `.gitignore` (add `web/node_modules/`, `web/.next/`, `.env`, `.env.local`), `web/public/*` (remove the Next demo SVGs).

Order of work: (1) install deps + `db/schema/*.ts` + `db/client.ts` + `drizzle.config.ts` → `npm run db:generate`
→ `npm run db:migrate` → commit `drizzle/`; (2) theme/format/colours/shared queries; (3) EChart wrapper with a
smoke chart on the placeholder home page; (4) ui kit, layout with `Nav` (Home · Seasons · Latest race via `getLatestRace`), pages.

**`package.json` is FINAL at the end of WP0. No later package adds, removes or bumps a dependency.**
Exact dependency set (pinned):

| Package | Version | Why |
|---|---|---|
| next | 16.3.5 (existing) | framework |
| react, react-dom | 19.2.8 (existing) | |
| drizzle-orm | 0.45.2 | typed reads over pg |
| pg | 8.23.0 | node-postgres driver (peer of drizzle-orm) |
| echarts | 5.6.0 | charts (`echarts/core` tree-shaken import) |
| dev: drizzle-kit | 0.31.10 | migrations own the DDL |
| dev: @types/pg | 8.23.1 | |
| dev: tsx | 4.23.13 | runs `scripts/db-smoke.ts` |
| dev: typescript ^5, @types/node ^20, @types/react ^19, @types/react-dom ^19, tailwindcss ^4, @tailwindcss/postcss ^4, eslint ^9, eslint-config-next 16.3.5 | existing | |

Scripts: `dev`, `build`, `start`, `lint` (existing) + `typecheck: tsc --noEmit`, `db:generate: drizzle-kit generate`,
`db:migrate: drizzle-kit migrate`, `db:check: drizzle-kit check`, `db:studio: drizzle-kit studio`, `db:smoke: tsx scripts/db-smoke.ts`.

Verification: `docker compose up -d` at root; `cd web && npm ci && npm run typecheck && npm run lint && npm run db:migrate && npm run db:smoke && npm run build`;
`psql postgres://f1:f1@localhost:5432/f1 -c '\d laps'` matches §1.4; `npm run db:generate` produces no new migration (schema and SQL agree);
`npm run dev` shows the dark shell with nav on all four routes and a rendered smoke chart.

### 5.2 WP1 — f1lab foundation + ingest (SEQUENTIAL; starts alongside WP0, Milestone 1 needs WP0's migration)

Owns: `f1lab/**` (except `config.py`, `plots.py` — unchanged), `tests/**`, `requirements.txt`,
`scripts/warm_cache.py` (may extend to sprint sessions), root `README.md` "Ingest" section.

Order: (1) `annotate_laps` refactor + `tests/legacy_clean.py` + `test_clean_refactor.py` (no DB needed);
(2) `pace_distribution`, `compound_degradation` + tests; (3) `derive.py`, `colours.py`, `assumptions.py`, `frames.py` + tests
(all against cached sessions, no DB); (4) `db.py`, `season.py`, `ingest.py`; (5) **Milestone 1**:
`python -m f1lab.ingest --season 2024 --round 13` populates every table (season aggregates for 2024 included) and
`test_ingest_hungary.py` passes (second run: identical counts, same `session_id`). Milestone 1 is the GATE for Phase 2.

Verification: `.venv/bin/pip install -r requirements.txt`; `.venv/bin/python -m pytest tests -m "not db"`;
`python -m f1lab.ingest --check-schema`; `python -m f1lab.ingest --season 2024 --round 13`; `pytest tests -m db`;
`psql ... -c "select count(*) from laps; select rank, driver_id, median_pace_s from pace_ranking order by rank limit 3"` shows NOR 81.5796, PIA 81.6349, HAM 81.8938 (matches the notebook).

### 5.3 Phase 2 — PARALLEL (start when WP0 is complete AND WP1 Milestone 1 is met)

| Package | Owns (create/edit ONLY these) | Depends on |
|---|---|---|
| **WP2 Full ingest** | `f1lab/**`, `tests/**`, `scripts/warm_cache.py` (continues WP1's files; WP1 is finished) | WP1 |
| **WP3 Home + Season pages** | `web/lib/queries/home.ts`, `web/lib/queries/season.ts`, `web/app/page.tsx`, `web/app/season/[year]/page.tsx`, `web/components/home/**`, `web/components/season/**` | WP0, data from WP1 M1 |
| **WP4 Race page** | `web/lib/queries/race.ts`, `web/app/race/[year]/[round]/page.tsx`, `web/components/race/**`, `web/components/charts/{PaceBoxPlot,StintGantt,DegradationScatter,RaceTrace,TeammateBars}.tsx` | WP0, WP1 M1 |
| **WP5 Driver page** | `web/lib/queries/driver.ts`, `web/app/driver/[code]/page.tsx`, `web/components/driver/**`, `web/components/charts/DriverSeasonChart.tsx` | WP0, WP1 M1 |

WP2 tasks: `--season 2025` then `--season 2026` end to end (all from cache; sprint sessions download ~12 small
sessions); handle every edge case found (Miami 2025 `'nan'` compounds, red-flag races, 19-row results, DNS drivers);
re-run both seasons and prove idempotency (`select count(*)` per table identical; no duplicate `ingest_runs` sessions);
`--dry-run`, `--recompute-season`, `--fail-fast`, rate-limit abort. Verification: both seasons `status='ok'` in
`session_ingests` (or `partial` with a documented reason), `seasons.ingested_rounds = 24` and `13`, `driver_standings`
after 2025 round 24 lists the champion first, standings include sprint points.

Web packages develop against the 2024 R13 rows first and 2025/2026 rows as WP2 lands them. Each web package's
verification: `npm run typecheck && npm run lint && npm run build`, then `npm run dev` and load
`/`, `/season/2024`, `/race/2024/13`, `/driver/NOR?season=2024` (their own routes) — no console errors, every section
renders, empty sections show `EmptyState`. WP4 builds `StintGantt` first (the least standard chart).

### 5.4 WP6 — Integration and docs (SEQUENTIAL, after Phase 2)

Owns: everything (single agent; ownership relaxes). Runs both seasons fresh, clicks through every race page of
2025 (24) and 2026, every driver page, fixes cross-package issues, writes `docs/RUNBOOK.md`
(`docker compose up -d` → `cd web && npm ci && npm run db:migrate` → `python -m f1lab.ingest --season 2025` →
`--season 2026` → `npm run dev`), a root `Makefile` (`make db`, `make migrate`, `make ingest SEASON=2025`, `make web`),
rewrites `README.md` for the app, and appends an "As built" delta list to this file.

### 5.5 Shared contracts each parallel package relies on

- §1 DDL ↔ `web/db/schema/*.ts` (WP0) ↔ `f1lab/frames.EXPECTED_COLUMNS` (WP1).
- `web/lib/queries/shared.ts` types and helpers (WP0) — frozen.
- `components/charts/EChart.tsx` props (§3.4), `lib/theme.ts`, `lib/format.ts`, `lib/colours.ts`, `components/ui/*` (WP0) — frozen.
- Row semantics in §0.3 and §1 comments (e.g. `result_time_s`, sign conventions).

---

## 6. Risks and mitigations (section F)

**Top 5**

1. **Schema drift between Drizzle (DDL owner) and psycopg (writer).** A renamed column breaks ingest with an opaque
   error, or an added NOT NULL column blocks COPY. *Mitigation:* `db.assert_schema` compares `EXPECTED_COLUMNS` with the
   live `information_schema` before any write and names the exact table/column; `test_schema_contract.py` runs the same
   check in CI; the schema is frozen after WP0 with a documented change procedure (edit `db/schema` → `db:generate` →
   `db:migrate` → update `EXPECTED_COLUMNS` → both sides sign off).
2. **FastF1 irregularities across ~47 sessions** (`'nan'` compounds, NaN `Position`, red flags, 19-row results, DNS drivers,
   a 2026 session with malformed data, `pace_ranking` `IndexError` on a rain-shortened race, rate limiting on the
   uncached sprint loads). *Mitigation:* per-analytic try/except → `analytics_status` + `status='partial'` with raw laps
   always written; per-session transaction with retries/backoff; `RateLimitExceededError` aborts cleanly (exit 2) and the
   next run resumes; every page section renders `EmptyState` from `analyticsStatus` instead of crashing; the three
   fixtures (Hungary 2024, Miami 2025, 2026 R1) cover the known cases.
3. **The `annotate_laps` refactor silently changes `clean_laps` output** and shifts every notebook number.
   *Mitigation:* `tests/legacy_clean.py` is a verbatim copy of the pre-refactor functions and
   `test_clean_refactor.py` asserts `assert_frame_equal` for both `drop_outliers` values on three cached races
   before any ingest code exists; `clean_laps(session, drop_outliers=False)` vs `clean_laps(session)` membership is the
   oracle for `is_outlier`.
4. **2026 modelling assumptions are wrong for the new regulations** (100 kg start fuel is a 2025-era number; 2026 cars
   carry less, so the correction is over-generous). *Mitigation:* assumptions are stored per session and rendered on
   every race page, so nothing is silently wrong; `assumption_sets` makes a later `SEASON_OVERRIDES` change a new,
   visible set rather than an overwrite; explicitly out of v1 scope.
5. **ECharts in the App Router** — importing `echarts` in a Server Component, `next/dynamic({ ssr: false })` from a page,
   `JSX.Element` typing, or the `custom`-series gantt misrendering on resize. *Mitigation:* one `'use client'` wrapper
   is the only importer (tree-shaken `echarts/core`), pages import chart components directly, `React.JSX.Element` typing,
   `ResizeObserver` + `notMerge`, `clipRectByRect` in `renderItem`; WP0 ships the wrapper with a smoke chart and WP4 builds
   the gantt first.

**Also watch:** standings vs the official table (post-race penalties, disqualifications applied after the API
snapshot) — footnoted on the season page and fixed by re-ingest, never by code; `results.Time` for lapped cars must
never be shown as a gap; lap-1 `Time` includes the formation offset (cancels in the gap); `fuel_sensitivity` ignores
`lap_km` scaling while `fuel_correct` supports it — harmless because v1 passes `lap_km=None`, recorded as
`apply_lap_km_scaling: false`; Next 16 API drift (`await params`/`searchParams`, `proxy.ts` not `middleware.ts`) — pin
versions and use the global `PageProps` helper; `mixed_assumption_sets` after a config change with partial re-ingest —
badge on `/season` and `/driver`, resolved by `--force` re-ingest of the season.

---

## 7. Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | Base design = the data-first proposal (per-session identity, all laps stored with flags, one table per f1lab function, `session_ingests` provenance); page-shaping grafts (sens range, lap status, sprint results, fastest-pace denormalisation, unpaired teams) and future-first grafts (`assumption_sets`, `pit_stops`, `leader_driver_id`, `--dry-run`/`--recompute-season`/`--check-schema`) added on top. | Two of three judges favoured it; the third's objections (layout, pnpm, JSX typing) are fixed here. |
| D2 | `fuel_correct(lap_km=None)` in v1; `circuits.lap_km` reserved and NULL; no hand-seeded circuit file; `session_ingests.fuel_scale = 1.0`. | With scaling, 7 of 20 stored ranks disagreed with the sensitivity table's `rank@0.03` column on Hungary 2024; unscaled, 0. The notebook is the reference. |
| D3 | `assumption_sets` as a NOT NULL column on analytics tables, not part of the PK; re-ingest replaces; `seasons.mixed_assumption_sets` flags mixing. | Versioning without the FK/coexistence contradictions of the future-first proposal. |
| D4 | Sprint results ingested by default (results only, `--no-sprints` to skip); standings recompute once after the loop. | Two judges wanted official-matching standings; the cost is ~12 small uncached loads per season; the opt-out covers the third judge's concern; recomputing after the loop fixes the stale-standings bug. |
| D5 | No hand-written `dev-fixture.sql`; the cached 2024 Hungary race (WP1 Milestone 1) is the fixture. | Keeps WP0 small; WP1 runs concurrently with WP0 so the gate arrives early; page packages need season aggregates too, which a fake fixture would have to fabricate. |
| D6 | No separate charts package and no stub-contract gate; each page package owns its chart components. | Chart props are then package-internal; the only cross-package contracts are the schema, `shared.ts`, and the wrapper (all WP0). |
| D7 | Explicit Drizzle column names instead of `casing: 'snake_case'`. | The DDL is the contract and Python checks names; transcription fidelity beats brevity. |
| D8 | `stints` PK includes `compound`. | Matches `stint_table`'s `(Driver, Stint, Compound)` groupby; 0 collisions observed, but the function defines the key. |
| D9 | `line_style` from `fastf1.plotting.get_driver_style` (with a driver-number fallback) instead of a driver-number slot. | FastF1's own teammate convention; verified solid/dashed in 2024 and 2026. |
| D10 | Box-plot five numbers merged into `pace_ranking` columns instead of a separate `pace_distribution` table. | Same row set, one query, one fewer table; `pace.pace_distribution` still exists as the function. |
| D11 | `plots.py` unchanged; `compound_degradation` iterates compounds from the deg table exactly as `plot_degradation` does and is tested against an inline `np.polyfit`. | Zero risk to the notebook's figures; avoids a fourth edited module. |
| D12 | `circuits` keyed by FastF1 circuit key; `events` keep `location`/`country` from the schedule; `events.circuit_key` filled after the first load. | 2026 has Barcelona and Madrid; schedule `Location` is unreliable (2026 Bahrain shows "Kuala Lumpur"). |
| D13 | Web built on the existing scaffold: `web/app`, `web/db`, `web/lib`, `web/components`, npm, no `src/`. | `web/` already exists with `package-lock.json`, `@/*` → `./*`, ESLint. |
| D14 | ECharts pinned to 5.6.0 although 6.x exists. | All proposals and implementers' knowledge target the 5.x API; nothing in v1 needs 6; upgrading is a one-line bump later. |
| D15 | Teammate sign convention: positive = this driver faster. | Reads as "advantage" on the driver page; `teammate_deltas` (faster/slower) is unsigned so no conflict. |
| D16 | `sessions` rows are created from the schedule with nullable `total_laps`; failed loads are recorded in `session_ingests` against that row. | Fixes the NOT NULL bug in the failure path and gives pending/failed rounds a visible state on race lists. |
| D17 | No test parses `0000_init.sql`; the contract test uses `information_schema`. | Would break as soon as a `0001` migration exists. |
| D18 | `results.result_time_s` stored verbatim with the semantics in §0.3; displayed as a gap only for `status == 'Finished'`. | Lapped rows are not gaps to the winner (verified). |
| D19 | One env var name, `DATABASE_URL`, on both sides. | One fewer thing to get wrong in the runbook. |
| D20 | `force-dynamic` on all pages; `cacheComponents` off. | Data changes only at ingest; local reads are single-digit ms; nothing here blocks enabling caching later. |
| D21 | Standings tie-break by full countback (P1 count, P2 count, ...) rather than wins/podiums only. | Cheap in pandas and matches the sporting regulations. |
| D22 | `passes_rules` / `is_outlier` / `is_representative` column names in `laps`. | Avoids re-using `is_clean` with a different meaning than `clean.py`. |

---

## 8. As built (integration record, 2026-09-11)

What the delivered system does differently from §1–§5, collected from every package's report
and from the integration pass. Everything not listed here was built as specified and verified
(29/29 tables identical to §1 including constraints and the partial index; every §3.3 export
present with the spec's names and types; all four routes; 2024 R1–R24, 2025 R1–R24 and
2026 R1–R13 ingested with every session `ok`).

### 8.1 Schema and data (§1)

| Ref | As built | Why |
|---|---|---|
| §1 DDL | No deviation. `web/drizzle/0000_init.sql` == §1 (types, nullability, PKs, FKs with `ON DELETE CASCADE`, checks, index columns incl. `laps_session_repr_idx WHERE is_representative`); `f1lab.frames.EXPECTED_COLUMNS` == live `information_schema`. | — |
| §1.4 `laps.compound` comment | FastF1 also reports the compound label `NONE` (2025 R13 Belgium: 57 laps, 2026 R11 Hungary: 25 laps). It is stored verbatim in `laps`/`stints`/`pit_stops` and gets a `compound_colours` row with the UNKNOWN fallback colour, so those two sessions have 8 compound rows. Only the literal `'nan'` is normalised to NULL (§0.3). | It is what `clean.stint_table` returns; mapping it would change a reused function's output. Web code treats compound as an open vocabulary. |
| §1.2 `sessions.session_id` | Stable but not contiguous (e.g. 2026 R14 is 439): the schedule upsert's `ON CONFLICT DO UPDATE` consumes a serial value per attempted row on every run. | Cosmetic; never order by `session_id`, use `(year, round, kind)`. |
| §1.9 `ingest_runs` | Holds every run ever made, including the WP1/WP1b/WP2 development runs and the two runs each full `pytest` adds (`test_ingest_hungary`, `test_ingest_cli`). | Provenance only; not truncated. |
| §1.8 standings | Snapshots exist for every `after_round` 1..`standings_after_round` in all three seasons (as specified); while only 2024 R13 was ingested the 1..12 snapshots were empty. | Matches §2.6. |
| §0.2 (6) seasons | Three seasons ship (2024 added), 89 `sessions` rows, 68,442 laps, 1,176 `pace_ranking` rows. 2026 R14–R23 exist as pending rows only. | Cached 2024 data was available. |
| §1.14 `gap_to_leader` | Deviates from the listed code in two places: (1) rows FastF1 fabricates for a lap the car never completed (`FastF1Generated` with NaT `LapTime`: 79 rows in 42 races) get NULL `gap_to_leader_s` / `interval_s` / `leader_driver_id` like NaT-`Time` rows, while `session_time_s` still stores the raw value; (2) the sort is stable (`mergesort`) with `Position` as the secondary key, so an exact time tie resolves to the classified leader. | Those rows carry a synthetic `Time` (the leader's own time on the lap-1 row of a car that crashed at the start; `LapStartTime + 150 s` on a retirement row), which tied 0-lap cars with the leader at gap 0 in 25 races and, on 2024 R24 lap 1, named Perez `leader_driver_id` and gave Norris (P1) `interval_s = 0` — against §1.4 "NULL for the leader" and §0.5 "min-time car equals Position 1" (§8.6 F2). |
| §1.2 `drivers.headshot_url` | Holds an absolute `http(s)://` URL or NULL, never another string (`ingest.headshot_url()` filters the value); the upsert uses `COALESCE(EXCLUDED.headshot_url, drivers.headshot_url)` so a session that lacks the URL for a driver does not erase one learned from another session. `frames._is_null` is deliberately unchanged: the string `'None'` is also FastF1's raw compound label behind the `NONE` rows above, so it cannot be a global NULL literal. | FastF1 returns the four-character string `'None'` as `HeadshotUrl` for some driver/session pairs (Colapinto 2025, Tsunoda 2026 R13); it was stored verbatim and rendered as `<img src="None">` (§8.6 F3). |

### 8.2 Python ingest (§2)

| Ref | As built | Why |
|---|---|---|
| §2.5 logging | The `fastf1` logger is set to ERROR inside `ingest.py`, so stderr is one line per session. | FastF1's DEBUG output and internal timedelta tracebacks leaked into the per-session log. |
| §2.5 "data not yet available" | A session FastF1 cannot serve does not raise on load (FastF1 swallows endpoint failures); `load_with_retry` now probes `results`/`laps` and raises `f1lab.ingest.DataNotAvailable` (non-retryable), recorded as `status='failed'` with `no timing data available for YEAR Rnn K (...)` and retried on the next run. | Without it the failure surfaced as an opaque `DataNotLoadedError` after the retries. |
| §2.5 "season.recompute after the loop" | Also runs when the loop ended by `--fail-fast` or a rate-limit abort. | Otherwise `seasons.ingested_rounds` stayed stale after a stopped run. |
| §2.1 test inventory | Additional test files: `tests/test_milestone1_numbers.py` (db; the Milestone-1 gate numbers, skips unless 2024 R13 is ingested), `tests/test_ingest_cli.py` (db; every CLI mode incl. simulated fail-fast and rate-limit abort, plus — since the review fixes — a 2024 R5 sprint weekend whose sprint fails after the race was written, and a Ctrl-C), `tests/test_full_seasons.py` (db; season invariants, skip per season unless fully ingested), `tests/test_guards.py` (no db; `IndexError` → `partial`, `DataNotAvailable`). `test_derive.py` also covers the fabricated-row and exact-tie cases of `gap_to_leader` (synthetic frames, and cached 2024 R24 / 2025 R1). `test_ingest_hungary.py` / `test_milestone1_numbers.py` are state-aware (one round vs full 2024); their notebook-number assertions are unchanged. Full suite: 135 passed (128 before the review fixes). | Coverage of the paths §6 lists as risks. |
| §2.5 `--fail-fast` exercise | Was run for real against 2026 R14 and wrote a `failed` row; that single row was deleted afterwards so Madrid shows as *not yet ingested* rather than *data unavailable* before the race happens. | Cosmetic for the season page. |
| §0.5 rain-shortened `IndexError` | Never occurred in 78 sessions; the guard is covered by `tests/test_guards.py` (monkeypatched), not by real data. | — |
| §5.4 "runs both seasons fresh" | WP6 did not force-re-ingest the seasons: WP2 proved idempotency by hashing every row of all 24 year-scoped tables before/after `--season 2025 --force` (identical), and nothing in `f1lab/` changed afterwards. WP6 ran `make ingest SEASON=2026` (selects nothing new, recomputes the season) to verify the Makefile path. The review fix round then re-ingested all three seasons with `--force` (§8.6). | Saves ~5 min of identical output. |
| §2.5 per-session transactions | Every write block in `ingest.py` goes through `_committed(conn)`: if the `autocommit=False` connection is not IDLE (a preceding plain SELECT opens an implicit transaction inside which `conn.transaction()` is only a SAVEPOINT), the open read-only transaction is rolled back first, so each block is a real `BEGIN … COMMIT`. The failed-session row, the dimension upsert, the session write and the `ingest_runs` updates are therefore durable one by one; `season.recompute` wraps its reads and writes in one block. `KeyboardInterrupt` in the session loop is recorded as `ingest_runs.status='aborted'`, `error='interrupted (KeyboardInterrupt)'`, exit 2. | As first built, `sessions_to_do()`'s SELECT left the connection INTRANS, every later "transaction" was a savepoint, nothing was committed before the end of the run, and `record_failure()`'s `rollback()` discarded every session ingested earlier in the run (a failed sprint threw away the race of the same weekend; Ctrl-C lost the whole run and left the run row `running`) — §8.6 F1. |

### 8.3 Web foundation (§3)

| Ref | As built | Why |
|---|---|---|
| §5.1 scripts | `typecheck` is `next typegen && tsc --noEmit --incremental false` (spec: `tsc --noEmit`). | `PageProps`/`LayoutProps` only exist after typegen, and Next rewrites `next-env.d.ts` for the last `distDir` used. |
| §3.1 `next.config.ts` | `{ turbopack: { root: __dirname }, serverExternalPackages: ['pg'] }`. The Phase-2 `distDir: process.env.NEXT_DIST_DIR ?? '.next'` override was removed by the review fix (§8.6 F6): build output is always `.next`. | A stray `package-lock.json` in the home directory otherwise becomes the Turbopack root. Custom dist dirs made Next append globs to `tsconfig.json` on every run (§8.6 F5/F6). |
| §3.1 `eslint.config.mjs` "unchanged" | Back to the scaffold (the `.next-*/**` ignore the page packages needed went with the `distDir` override). | — |
| §3.1 `tsconfig.json` "unchanged from scaffold" | Content equals the scaffold except that Next itself appends `.next/types/**/*.ts` and `.next/dev/types/**/*.ts` to `include` on every dev/build/typegen. Next does the same for every custom `distDir` and never removes a glob, which is why `distDir` is no longer configurable here (§8.6 F5/F6); the stale `.next-*` globs left by the review round were removed. | Next 16 behaviour, not an edit. |
| §3.4 `EChart.tsx` | Also exports `clipRectByRect` (= `echarts.graphic.clipRectByRect`) and `export type { EChartsOption }`. | §4.3 wants `clipRectByRect` in the gantt `renderItem` while §3.1 forbids importing `echarts` outside the wrapper. |
| §3.1 "nothing outside EChart.tsx imports echarts" | Chart files use `import type { ... } from 'echarts'` for `EChartsOption` and the `CustomSeriesRenderItem*` types only (erased at compile time); the only runtime importer is `EChart.tsx`. | Typing the `custom` series. |
| §3.1 file list | Extra file `components/race/DegradationTable.tsx` (named in §4.3, absent from the §3.1 tree). | — |
| §3.3 `season.ts` | Extra named helpers `toIngestStatus`, `driverRefOrNull`. `StandingRow.code` comes from `drivers.latest_code` rather than the driver's code within that season. | Codes are stable in practice; `resolveDriver` falls back to `latest_code` so the links resolve either way. |
| §3.3 `race.ts` | `AssumptionsView.ingestedAt` is the raw pg `timestamptz` text (`2026-09-11 22:49:32.506093+00`, space not `T`); `AssumptionsPanel` normalises it. `RaceHeader.prev/next` = nearest round in the same season whose race `session_ingests.status` is ok/partial (the spec did not define them). `getTeammateDeltas.unpaired.reason` is the spec string for `N < 2`; the never-observed `N >= 2` case says `N drivers ranked, no pair computed`. | — |
| §3.3 `driver.ts` | `resolveDriver` returns null (→ 404) when the code exists in `drivers` but has no race entries anywhere and no season was requested (unreachable with ingested data). H2H rows whose teammate has no `session_entries` row that year are skipped (cannot occur). | Undefined states. |
| §3.1 `components/charts` imports | Charts declare structural prop types (`DriverSeasonChartRace`, gantt/trace row shapes) instead of importing from `lib/queries`; pages pass the query rows unchanged. | Honours "nothing under `components/charts` imports `lib/queries`". |
| §3.1 `favicon.ico` | Still the create-next-app default icon. | Not in any package's scope. |

### 8.4 Pages (§4)

| Ref | As built | Why |
|---|---|---|
| §4.1 (1) empty-state "README link" | Names `README.md` / `docs/RUNBOOK.md` in `<code>` text rather than an anchor. | No route serves the README; an anchor would 404. |
| §4.1 hero vs nav | The hero uses `latestSeasonWithData()` (`seasons.ingested_rounds`, updated by `season.recompute`) while the nav's `getLatestRace()` reads `session_ingests`; mid-run they can differ by one round until the recompute at the end of the run. | Both are per spec. |
| §4.3 (3) `PaceBoxPlot` | The bg-coloured median line is a second, silent `custom` series reproducing ECharts' boxplot width rule. | ECharts 5 boxplot has no separate median colour. |
| §4.3 (4) `StintGantt` | One `custom` series per compound (same data-row format and `renderItem`) so the legend is native and toggles compounds; the laps label is skipped when the clipped bar is narrower than 16 px even if `laps >= 6`. | Legibility. |
| §4.3 (6) `RaceTrace` | The SC/VSC/Red/Yellow `markArea` lives on a dedicated data-less "Track status" series (excluded from the legend) rather than on the first driver series; an inside x zoom and a y-axis slider (default range 0..98th-percentile gap × 1.15) were added beyond the x slider. | Hiding the winner via the legend must not remove the bands; a car parked through a red flag carries a 2,000+ s gap (2026 R6) that otherwise flattens every other line. |
| §4.3 (7) `TeammateBars` | Categories sorted by `gapPct` **descending** with `inverse: true`. | The spec's "ascending + inverse" puts the largest gap at the bottom in ECharts (category index 0 is at the bottom); the stated intent — largest on top, as `plots.py` — is what is drawn. |
| §4.4 (4) `DriverResultsTable` | The *Gap to P1* cell of a rank-1 row is a bare dash (WP6), matching the race page's pace table, instead of `— / 0.000%`. | Consistency. |
| §4.4 (1) headshot | Plain `<img>` with a targeted `eslint-disable` for `@next/next/no-img-element`; a broken/absent image paints nothing over the initials fallback. | Per §4.4 wording. |
| §4.3 payload | A race page is ~500–700 KB of HTML because the trace and degradation points are serialised as RSC props. Rounding the doubles was evaluated and rejected: long doubles are 26 KB of a 515 KB page; the rest is the element tree. | Acceptable for v1 on localhost. |
| §4.3 (6) `RaceTrace` tooltip | `tooltip.confine: true`; a field of more than 12 cars is laid out in two columns (P1..P11 / P12..P22), each row `marker Pn CODE +gap`. | With 20–22 one-per-line rows the box was 460+ px tall and ECharts placed it above the 520 px chart, hiding the "Lap N" header and P1–P9 whenever the card sat near the top of the viewport (§8.6 F4). |
| §4.4 (3) `DriverSeasonChart` layout | Height 480; grids `left 80`; y-axis names `nameLocation 'middle'`, `nameGap 56`; bottom grid anchored with `bottom: 92` so the 45° round labels fit; the redundant x-axis name "Round" is dropped. Values live in the exported `CHART_LAYOUT`. | The two y-axis names collided below the top grid and "Gap vs teammate (%)" was cut at the canvas edge; "Emilia Romagna"/"Saudi Arabian" were cut by the canvas bottom (§8.6 F5, verified with ECharts' SVG renderer: 0 of 24 rotated labels clipped, no overlaps). |
| §4.4 (1) headshot | `DriverHeader` renders the `<img>` only for an absolute `http(s)://` URL. | Belt and braces for §8.6 F3: a non-URL string in `drivers.headshot_url` produced `<img src="None">` and a request to `/driver/None`. |
| §4.2 (1) empty standings | `SeasonData` gains `recomputedAt: string \| null` (`seasons.recomputed_at`). With `afterRound` NULL the page says *no round of this season has been ingested yet* / *no standings until a round is ingested* when a recompute has run, and keeps *season aggregates not yet computed (season.recompute has not run)* / *standings not yet computed* only when `recomputed_at` is NULL. | `standings_after_round` is NULL after a recompute that found no ok/partial race (e.g. `--season 2026` before the first race), so the old text was false (§8.6 F7). |

### 8.5 Process and tooling (§5)

- WP1 ran as two packages (WP1a foundation + ingest, WP1b Milestone-1 gate); the gate found no
  schema mismatch and reconciled nothing.
- Browser verification (canvas painted, console clean) was done only at integration; the page
  packages verified their charts via ECharts' Node SVG renderer (WP4) or server HTML (WP3/WP5).
- `Makefile` targets go beyond the four in §5.4: `db`, `db-down`, `db-logs`, `psql SQL=`,
  `setup`, `migrate`, `check-schema`, `ingest SEASON= [ARGS=]`, `ingest-all`, `recompute SEASON=`,
  `web`, `typecheck`, `lint`, `build`, `start`, `test`, `test-fast`, `clean`.
- `docs/RUNBOOK.md` covers first run, per-weekend runs, `--round`/`--force`/`--recompute-season`,
  what happens when an assumption constant changes (new `assumption_sets` row, `mixed_assumption_sets`
  badge, `--force` to converge), the schema-change procedure and troubleshooting.
- Integration pass (2026-09-11): typecheck 0 / lint 0 / build 0 from a clean `.next`; 99 routes
  crawled (`/`, three season pages, all 71 race rounds incl. 10 pending, 28 driver pages, 3
  lower-case redirects, 8 404s) with no `Application error` / `Internal Server Error` / `Unhandled` /
  `TypeError`, no `NaN` / `undefined` / `Invalid Date` / `null` in visible text, no fallback
  accent colour standing in for a team colour; `/`, `/race/2025/1`, `/race/2026/6` (red flag) and
  `/driver/NOR?season=2025` opened in a browser with an empty console and every `role="img"`
  container holding a painted canvas.

### 8.6 Review fixes (2026-09-11, after the integration pass)

Seven confirmed review findings, most severe first, each fixed at the root and re-verified
with the finding's own reproduction. Rows above that they changed point here.

| # | Finding | Fix | Verified |
|---|---|---|---|
| F1 | **high** — per-session writes were savepoints inside one never-committed run transaction; a failed session (or Ctrl-C) rolled back every session ingested earlier in the run and left `ingest_runs` `running`. | `f1lab/ingest.py`: `_committed(conn)` enters every write block from IDLE (rolls back an implicit read transaction first) so each block is a real commit; `sessions_to_do` reads inside such a block; `record_failure` no longer starts with a blanket `rollback()`; `KeyboardInterrupt` → run `aborted` + exit 2; `season.recompute` is one block. | `tests/test_ingest_cli.py::test_failed_sprint_keeps_the_race_written_earlier_in_the_run` (2024 R5: sprint load fails after the race; race stays `ok` with 1,032 laps, run `partial 2/1/1`) and `::test_interrupt_keeps_committed_sessions_and_marks_the_run_aborted` (run `aborted`, `finished_at` set, race kept). |
| F2 | **medium** — `gap_to_leader` treated FastF1-fabricated rows as lap completions: 0-lap cars at gap 0 in 25 races; 2024 R24 lap 1 leader = Perez, Norris `interval_s = 0`. | `f1lab/derive.py`: fabricated rows (`FastF1Generated` & NaT `LapTime`) get NULL derived columns; stable sort with `Position` tie-break (§8.1 row §1.14). All three seasons re-ingested with `--force`. | `tests/test_derive.py` (synthetic 2024-R24-shaped frame, exact-tie frame, cached 2024 R24 and 2025 R1); DB: 0 `fastf1_generated` rows with a gap, 2024 R24 lap 1 `leader_driver_id = norris`, no row with `position = 1` and a non-NULL `interval_s`. |
| F3 | **medium** — `drivers.headshot_url` held the string `'None'` (Colapinto); `<img src="None">`. | `ingest.headshot_url()` stores only `http(s)://` URLs and the drivers upsert keeps an existing URL when a session has none (`db.upsert_rows(..., keep_existing_if_null=[...])`); `DriverHeader` renders the `<img>` only for an absolute URL. The reviewer's `_is_null('None')` variant was tried and reverted: it also NULLed the 82 `NONE`-compound laps of 2025 R13 / 2026 R11 that §8.1 keeps (caught by `tests/test_full_seasons.py`). | `tests/test_guards.py::test_headshot_url_filter`; DB after re-ingest: every `drivers.headshot_url` is NULL or matches `^https?://`; Colapinto has the 2026 media URL; `/driver/COL` served from the production build has no `src="None"`. |
| F4 | **medium** — race-trace axis tooltip (20–22 rows) overflowed the chart; header and P1–P9 hidden. | `RaceTrace.tsx`: `confine: true` + two-column layout above 12 rows. | Code review of the ECharts placement path (`refixTooltipPosition` never clamps; `confine` does); a 22-row box is ~250 px inside the 520 px chart. No browser in this package. |
| F5 | **low** — driver chart y-axis names collided/clipped; "Round" over the rotated labels; long round labels cut. | `DriverSeasonChart.tsx` `CHART_LAYOUT` (see §8.4 row). | ECharts SVG SSR at 800 and 1400 px: 0/24 labels clipped, names at x 12–24 with no overlap, lowest label 465 px in a 480 px canvas (old layout: 11/24 clipped). |
| F6 | **low** ×2 — `NEXT_DIST_DIR`→`distDir` made every custom build append `.next-*/types/**` globs to `tsconfig.json` and repoint `next-env.d.ts`; 30 stale globs had accumulated. | `distDir` override removed from `next.config.ts`; `eslint.config.mjs`, `tsconfig.json`, `next-env.d.ts` restored to the scaffold state (+ the two `.next/` globs Next adds itself); `web/README.md` and `docs/RUNBOOK.md` updated. | `npm run typecheck` leaves `tsconfig.json` byte-identical; `next-env.d.ts` points at `.next`. |
| F7 | **low** — `/season/[year]` claimed "season.recompute has not run" after a recompute with zero ingested rounds. | `SeasonData.recomputedAt`; wording keyed on it (§8.4 row). | Scratch DB: `--season 2026 --round 30` then `/season/2026` shows "no round of this season has been ingested yet" ×4 and the new subtitle; a never-recomputed `seasons` row still shows the old text. |

Re-ingest after F2/F3: `--season 2024 --force`, `--season 2025 --force`, `--season 2026 --force`
(all from the cache; 30 + 30 + 18 = 78 sessions, every one `ok`, runs 76–78); row counts of all
28 tables other than `ingest_runs` identical before/after, only the derived gap columns of the
79 fabricated rows and `drivers.headshot_url` changed.

### 8.7 v1.6 qualifying (2026-09-15) — what the census reads now

The full record is `docs/QUALI_SPEC.md §10`; this is the part of it that updates §8's own
numbers. Read out of the live database after the backfill, not copied from a plan.

| Quantity | §8 (v1.5) | v1.6 |
|---|---|---|
| tables (`public`, base) | 63 | **67** |
| sessions | 89 — R 71, S 18 | **178** — R 71, S 18, **Q 71, SQ 18** |
| `laps` rows | 69,548 | **92,963** |
| `laps` columns | 41 | **46** |
| database size | 121 MB | **126 MB** |
| `ask` views | 57 | **61** |

The four new tables hold 1,588 `quali_results`, 3,503 `quali_segment_times`, 779
`quali_teammate_h2h` and 80 `season_quali_h2h` rows. Of the 79 completed qualifying sessions
**77 are `ok`, 1 is `partial`** (2025 R07 Q Imola — the per-driver-per-segment anchor gate firing
for real, per-segment tables suppressed, official times still published) **and 1 is `failed`**
(2025 R06 Q Miami — FastF1 returns no Q1/Q2/Q3 at all, so the ingest refuses the husk rather than
storing invented times).

**The race side did not move, and that is measured rather than asserted.** A content digest —
row count plus `md5(string_agg(row::text))` — of `pace_ranking`, `degradation_fits`,
`teammate_deltas`, `fuel_sensitivity`, `results`, `race_report`, all twelve `mode2_*` tables and
the 69,548 race/sprint `laps` rows is **identical before and after the release**, and is pinned
in `tests/test_quali_integration.py` so a future change has to notice. `laps.deleted` is still
false on every race and sprint lap (§1.4); it is true on 341 qualifying laps, which is
`excl_deleted` doing its job for the first time in the life of the project.

Two schema migrations: `0006_quali` (purely additive — four tables, five `laps` columns, the
widened `sessions_kind_check`) and `0007_quali_verified` (one defaulted boolean on
`quali_segment_times`, added by the integration pass so a driver-segment whose official time
cannot be confirmed carries its own flag instead of only a warning string — `QUALI_SPEC §10.4 A`).

### v1.7 — the telemetry layer (2026-09-16, `docs/TELEMETRY_SPEC.md` §10)

The first use of FastF1's 10 Hz car and position channels. **Additive and optional by
construction**: migration `0008_telemetry` creates five tables and alters nothing, no v1.6
query or migration names any of them, and a database on which the telemetry pass has never
run renders every existing page identically. That is asserted, not assumed —
`tests/test_telemetry_optional.py` runs fifty v1.6 page queries against the live database with
and without every telemetry row and compares SHA-256 digests, with a negative control proving
the digest set is not blind.

The v1 contract is untouched in substance: `EXPECTED_COLUMNS` grew by five entries and
`db.SESSION_CHILD_TABLES` by three, both additive; `frames.RACE_TABLE_ORDER` /
`QUALI_TABLE_ORDER` / `SPRINT_TABLE_ORDER` are **deliberately** unchanged, which is what gives
kind `S` its no-telemetry guarantee for free. `clean.load_race` and `load_quali` still pass
`telemetry=False`, pinned by a runtime assertion: telemetry is a separate pass
(`python -m f1lab.telemetry`), never part of an ingest.

Two things the v1 spec did not anticipate and that a later release must not undo. **A
telemetry failure never demotes a healthy session** — it writes
`session_ingests.analytics_status['telemetry']` and leaves `status` alone — because
`ask.session_health` and `ask.data_coverage` report on lap-time quality and would be corrupted
by a telemetry-shaped failure. And **`analytics_status` values are no longer all strings**: the
telemetry key holds an object, so `lib/queries/race.ts` flattens it at the query boundary
where the `Record<string, string>` claim is made. Without that, the v1.6 race page itself
throws — which is the one v1.7 regression that reached an existing page, and it is recorded in
TELEMETRY_SPEC §10.3 as D24.
