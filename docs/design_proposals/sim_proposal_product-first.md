# F1 Analytics v1.1 — Interactive Monte Carlo Strategy Simulator (product-first proposal)

Angle: designed from the fan's experience inward. Sections F (UI) and D (contract) drive the minimal model in A; every number on screen must be explainable in one sentence.

Outline:
- A. The race model
- B. Schema
- C. Python
- D. Query + client contract
- E. Browser algorithm
- F. UI spec
- G. Work breakdown
- H. Risks


---

## A. The race model

Design principle: the model is the *smallest* one whose every term maps to a sentence a fan can read on screen. Anything that cannot be said in one sentence is left out and named in the caption instead.

### A.1 What is simulated

Everything is simulated in **fuel-corrected time** (`laps.lap_time_fc_s`, the same quantity the pace and degradation sections already use). The fuel term `fuel_penalty_s(L)` depends only on the lap number and the circuit, so it is identical lap-for-lap in the edited and the actual strategy of the same driver and cancels exactly in the delta. The calibration line (A.9) adds it back once so the fan sees a real race duration.

Lap time of driver `d` on lap `L`, on compound `c`, with tyre age `a` (1 = the out-lap, `tyre_life` semantics):

```
t_fc(d, L, c, a) = base[d,c]                       -- "how fast this driver is on this tyre when it is fresh"
                 + deg[c] * (a - 1)                -- "how much slower per lap of tyre age"
                 + warmup * 1[a <= 2]               -- "the first lap on a new tyre is a little slower"
                 + evo * (L - 1)                    -- "the track speeds up as it rubbers in"
                 + lap1 * 1[L == 1]                 -- standing start (calibration only; cancels in the delta)
                 + sc_extra(L)                      -- 0 on green laps; (ratio_sc - 1) * base on SC laps, (ratio_vsc - 1) * base on VSC laps
                 + pit(L)                           -- pit loss when L is an in-lap (A.6)
                 + eps[d]                           -- lap-to-lap noise, N(0, sd[d])
```

Total time of a strategy = `sum_L t_fc` over laps 1..`total_laps`. The **delta** shown to the fan is `edited - actual` (negative = edited strategy faster). `evo`, `lap1`, `warmup` on the actual first stint, and the SC lap-time extra on shared SC laps all cancel in the delta; they are kept because (i) the calibration line needs the absolute time and (ii) `evo` de-confounds the degradation estimate (the v1 caption already explains why pooled soft slopes come out negative without it).

### A.2 Estimator (one OLS per race, on `laps` rows `WHERE is_representative AND compound IS NOT NULL AND tyre_life IS NOT NULL`)

```
lap_time_fc_s ~ C(driver):C(compound)             -> base[d,c]         (cell intercepts)
              + C(compound):age                   -> deg[c], se_deg[c]  (pooled per compound, driver-adjusted, evolution-adjusted)
              + 1[tyre_life <= 2]                 -> warmup
              + lap_number                        -> evo
```
with `age = tyre_life - 1`. Verified on 2024 R13 (Hungary, 1,233 representative laps): residual sd 0.73 s, R² 0.64, `deg[HARD] = 0.078 ± 0.003`, `deg[MEDIUM] = 0.062 ± 0.006`, `deg[SOFT] = -0.067 ± 0.055` (11 laps), `evo = +0.002 s/lap`, `warmup = +0.07 s`. Per-driver residual sd ranges 0.42 (HAM) to 0.99 (BOT). The model is estimated with `statsmodels` (already a dependency; `pace.py` uses it).

Rows excluded on purpose: in/out-laps, non-green laps, deleted/inaccurate laps, outliers (> 107 % of the driver's median). This makes it a **clean-air model** by construction — the caption says so.

### A.3 `base[d,c]` and the fallback when the driver never ran `c`

A cell is **fitted** when the driver has `>= SIM_MIN_CELL_LAPS = 6` representative laps on `c` (the OLS cell intercept and its standard error are stored). Otherwise the cell is **inferred**:

```
base[d,c] = base[d,c_ref] + (offset[c] - offset[c_ref])
```
where `c_ref` is the driver's fitted compound with the most laps and `offset[c]` comes from a second, additive fit `lap_time_fc_s ~ C(driver) + C(compound) + C(compound):age + warm + lap_number` on the same rows (Hungary 2024: MEDIUM +0.11 s, SOFT +0.60 s vs HARD). Its standard error is `sqrt(se[d,c_ref]^2 + se_offset[c]^2)`. Every cell carries `source: 'fitted' | 'inferred'`, the UI shows "pace on this tyre inferred from the rest of the field" on the stint. A compound is **parameterised for the race** when at least `SIM_MIN_COMPOUND_LAPS = 10` representative laps exist field-wide (same threshold as `compound_degradation`); only parameterised compounds appear in the compound picker. A driver without a fitted cell on *any* compound (fewer than 6 clean laps anywhere, i.e. a lap-1 retirement) has no model: the driver is listed but disabled in the picker with "not enough clean laps to model".

### A.4 Degradation per compound

Pooled per compound from the joint fit (driver- and evolution-adjusted), **not** per driver-stint: the v1 degradation caption already documents that per-stint slopes on six laps are not findings, and a fan editing a strategy needs one number per tyre. Handling:
- `deg[c] < 0` → stored as-is in `deg_raw_s_per_lap`, simulated as `deg_used = 0`, `deg_clamped = true`; the stint editor shows "no measurable degradation on this tyre in this race" next to that compound.
- `max_age_observed[c]` (max `tyre_life` among the fit rows) is stored; a stint whose planned length exceeds it by more than `SIM_EXTRAPOLATION_LAPS = 5` is flagged "longer than any real stint on this tyre — the line is extrapolated". Linear extrapolation is used (no cliff model); the flag is the honesty mechanism.

### A.5 Noise

`eps[d] ~ Normal(0, sd[d])`, `sd[d]` = standard deviation of that driver's OLS residuals, floored at `SIM_MIN_NOISE_SD = 0.25 s` and replaced by the field-wide residual sd when the driver has fewer than 12 residuals. Normal rather than a fat tail because the fit rows are clean-air laps by construction (the 107 % outlier rule removed the tail). With common random numbers the per-lap noise cancels in the delta (both strategies get the same `z_L`); it exists for the calibration band and to keep the per-lap chart honest about how noisy a single lap is.

### A.6 Pit loss for this race

Per stop `k` of the field (`pit_stops` rows with `lap_out IS NOT NULL`):
```
loss_k = (lap_time_s[lap_in] + lap_time_s[lap_out]) - 2 * median_green_lap[driver]
```
where `median_green_lap[driver]` is the driver's median `lap_time_s` over representative laps (raw, not fuel-corrected — both laps of one stop are adjacent so fuel cancels). A stop is **usable** when `lap_status.worst_status` on both `lap_in` and `lap_out` is `'1'` or `'2'` (green or local yellow) and neither lap is lap 1. Stored: `pit_loss_median_s`, `pit_loss_p25_s`, `pit_loss_p75_s`, `pit_loss_n`, and the usable loss values themselves (`pit_loss_samples_s double precision[]`, ≤ 60 numbers) so the browser resamples the race's own stops. Hungary 2024: 40 usable stops, median 20.5 s, p25 19.6, p75 21.6, min 16.3, max 24.1 — consistent with the "≈ 22 s (20–25)" number the earlier analysis found across races. Fewer than `SIM_MIN_PIT_SAMPLES = 6` usable stops → pit loss falls back to the circuit's pooled median across seasons (same formula over every ingested race at `events.circuit_key`), flagged `pit_loss_source = 'circuit'`; fewer than 6 there too → the simulator is unavailable for the race (`analytics_status.sim_race_params = 'empty: <n> usable pit stops'`).

Under SC/VSC the stop costs `loss_k * SIM_PIT_LOSS_FACTOR_SC = 0.5` / `SIM_PIT_LOSS_FACTOR_VSC = 0.7`. Rationale, and the sentence the caption uses: the pit lane is only cheaper by the amount the track has slowed; the "free stop" fans see on TV is mostly the field bunching up, which is a position effect this simulator does not model.

### A.7 Safety cars — two modes, one engine

- **"Race as it happened"** (default): the per-lap flag from `lap_status.worst_status` is replayed (`'4'` → SC, `'6'|'7'` → VSC, `'5'` → red, else green). Deterministic and explainable ("lap 31–35 were under the safety car — that's why pitting on 31 is cheap").
- **"Random safety cars"**: per lap, `P(SC starts) = p_sc`, `P(VSC starts) = p_vsc`, from this circuit's history across every ingested race (`events.circuit_key`, 2–3 races per circuit today), with a Beta prior so a circuit that has never had one still can: `p_sc = (n_sc_starts + 1) / (n_green_laps + 1/prior_sc)`, `prior_sc = 36 episodes / 3,686 laps ≈ 0.0098 per lap` (pooled across all 78 races: 36 SC episodes, 39 VSC episodes). Duration: geometric with mean `SIM_SC_MEAN_LAPS = 5.4` (observed mean 5.44, median 5, max 10) and `SIM_VSC_MEAN_LAPS = 3.6` (3.62). Red flags are never drawn (a red flag rewrites the race; the caption says so). Lap-time effect: `ratio_sc = 1.38` and `ratio_vsc = 1.05` (field medians of lap time / driver green median over 2,250 SC laps and 2,160 VSC laps; per-race values are overridden with the race's own median ratio when ≥ 10 such laps exist). Tyre age still advances under SC (conservative; noted).

### A.8 Sampled per draw vs fixed

| Sampled per draw (shared between edited and actual) | Fixed |
|---|---|
| `deg[c] ~ N(deg_used, se_deg)` clamped ≥ 0 | `evo`, `warmup`, `lap1` |
| `base[d,c] ~ N(base, se_base)` for every cell the driver uses | `ratio_sc`, `ratio_vsc`, pit-loss SC/VSC factors |
| `loss_k` = one resample from `pit_loss_samples_s` per stop index `k` (stop 1 of both strategies shares a draw; an extra stop gets a fresh one) | the replayed flag schedule (mode 1) |
| SC/VSC schedule (mode 2 only) | `sd[d]` |
| `z_L ~ N(0,1)` per lap, times `sd[d]` | |

So the spread of the delta comes from exactly three things the UI can name: how sure the degradation slope is, how variable the race's pit stops were, and (mode 2) when a safety car might come.

### A.9 Calibration (decision 6, defined precisely)

`real_total_fc = SUM(lap_time_fc_s)` over the driver's laps 1..`laps_completed` with a non-null lap time; `real_laps_timed` = count of such laps, `real_laps_clean` = count with `is_representative`. The simulator replays the **actual** strategy (stints from `stints`, pit laps from `pit_stops`, flags from mode 1) with parameter and pit-loss draws only (`z_L` = 0 for the calibration point so the number is the model's expected replay) and reports `sim_total_fc_median`. The line reads: "Replaying LEC's real strategy, the model gives 1:37:12 (fuel-corrected). His real fuel-corrected total was 1:37:41 — the model is 29 s optimistic (0.5 %), 14 of his 70 laps were in traffic or under yellow and are not modelled." When the real driver did not finish, the calibration compares only laps 1..`laps_completed` and says so. Python also stores this number per driver at ingest (`calib_sim_total_fc_s`, deterministic replay with parameter means) so the server-rendered page can show the line before the first client run.

---

## B. Schema

Three new tables, one Drizzle file `web/db/schema/simulation.ts` (exported from `index.ts`), migration `web/drizzle/0001_simulation.sql` generated by `drizzle-kit generate` (journal entry appended to `drizzle/meta/_journal.json`). All follow §0.3: snake_case, seconds as `double precision`, `session_id` FK `ON DELETE CASCADE`, `assumption_set_id` FK, status-like text with a CHECK. Written by `f1lab.simulation` (C) through the existing `cast_frame`/COPY path; deleted with the session's other children on `--force`.

### B.1 `sim_race_params` — one row per race session (the race-wide numbers)

```sql
CREATE TABLE sim_race_params (
  session_id              integer NOT NULL PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id       integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  fit_laps                integer NOT NULL,          -- representative laps in the OLS
  fit_drivers             integer NOT NULL,
  resid_sd_s              double precision NOT NULL, -- field-wide residual sd (fallback noise)
  r2                      double precision NOT NULL,
  evo_s_per_lap           double precision NOT NULL, -- track evolution
  warmup_s                double precision NOT NULL, -- tyre_life <= 2 penalty
  lap1_penalty_s          double precision NOT NULL, -- field median (lap1 - lap2), calibration only
  pit_loss_median_s       double precision NOT NULL,
  pit_loss_p25_s          double precision NOT NULL,
  pit_loss_p75_s          double precision NOT NULL,
  pit_loss_n              integer NOT NULL,          -- usable stops behind the samples
  pit_loss_samples_s      double precision[] NOT NULL, -- the usable losses (browser resamples these)
  pit_loss_source         text NOT NULL CHECK (pit_loss_source IN ('race','circuit')),
  sc_lap_ratio            double precision NOT NULL, -- lap time under SC / green, this race if >= 10 SC laps else pooled
  vsc_lap_ratio           double precision NOT NULL,
  sc_ratio_source         text NOT NULL CHECK (sc_ratio_source IN ('race','pooled')),
  p_sc_per_lap            double precision NOT NULL, -- circuit hazard with prior (A.7)
  p_vsc_per_lap           double precision NOT NULL,
  sc_mean_laps            double precision NOT NULL,
  vsc_mean_laps           double precision NOT NULL,
  hazard_races            integer NOT NULL,          -- ingested races at this circuit_key behind the hazard
  hazard_sc_episodes      integer NOT NULL,
  hazard_vsc_episodes     integer NOT NULL,
  hazard_green_laps       integer NOT NULL
);
```
Populated by `simulation.race_params(fit, pits, lap_status, circuit_history)`; the circuit history is a `SELECT` over already-ingested races at the same `events.circuit_key` (read inside the ingest transaction, so a race's hazard reflects the races ingested *before* it — `--force` re-ingest of a season converges it; documented in C.5).

### B.2 `sim_compound_params` — one row per (race, compound) that is parameterised

```sql
CREATE TABLE sim_compound_params (
  session_id          integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  compound            text NOT NULL,
  laps                integer NOT NULL,              -- fit rows on this compound (>= SIM_MIN_COMPOUND_LAPS)
  deg_raw_s_per_lap   double precision NOT NULL,     -- OLS slope, may be negative
  deg_s_per_lap       double precision NOT NULL,     -- max(deg_raw, 0): the value simulated
  deg_se_s_per_lap    double precision NOT NULL,     -- standard error (sampled per draw)
  deg_clamped         boolean NOT NULL,
  offset_s            double precision NOT NULL,     -- additive-model compound offset vs the reference compound (0 for the reference)
  offset_se_s         double precision NOT NULL,
  max_age_observed    integer NOT NULL,              -- max tyre_life in the fit rows
  PRIMARY KEY (session_id, compound)
);
```

### B.3 `sim_driver_params` — one row per (race, driver, compound) cell, plus the driver-level numbers on every row of the driver

```sql
CREATE TABLE sim_driver_params (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id             text NOT NULL,
  compound              text NOT NULL,
  base_s                double precision NOT NULL,   -- fresh-tyre fuel-corrected pace on this compound
  base_se_s             double precision NOT NULL,
  cell_laps             integer NOT NULL,            -- 0 when inferred
  source                text NOT NULL CHECK (source IN ('fitted','inferred')),
  ref_compound          text,                        -- the fitted compound an inferred cell was built from
  -- driver-level (repeated on each of the driver's rows; keeps the table flat and the query a single select)
  noise_sd_s            double precision NOT NULL,   -- residual sd (floored / fallback per A.5)
  noise_source          text NOT NULL CHECK (noise_source IN ('driver','field')),
  resid_n               integer NOT NULL,
  laps_completed        integer NOT NULL,            -- results.laps_completed
  real_total_fc_s       double precision,            -- SUM(lap_time_fc_s) over timed laps 1..laps_completed
  real_laps_timed       integer NOT NULL,
  real_laps_clean       integer NOT NULL,            -- is_representative among them
  calib_sim_total_fc_s  double precision,            -- deterministic replay of the actual strategy (A.9); NULL when the strategy has a NULL-compound stint
  PRIMARY KEY (session_id, driver_id, compound),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);
CREATE INDEX sim_driver_params_driver_idx ON sim_driver_params (driver_id, session_id);
```
One row exists for every parameterised compound × every modellable driver (so 20 drivers × 3 compounds = 60 rows on a dry race). Drivers with no fitted cell at all have **no rows** and are the ones the picker disables.

The **actual strategy** is not duplicated: the client contract (D) builds it from `stints` (compound, start/end lap) and `pit_stops` (`lap_in`), both already stored and already queried by the page.

### B.4 `frames.py` additions

```python
TABLE_COLUMNS["sim_race_params"]     = [("session_id","int"), ("assumption_set_id","int"), ("fit_laps","int"), ("fit_drivers","int"), ("resid_sd_s","float"), ("r2","float"), ("evo_s_per_lap","float"), ("warmup_s","float"), ("lap1_penalty_s","float"), ("pit_loss_median_s","float"), ("pit_loss_p25_s","float"), ("pit_loss_p75_s","float"), ("pit_loss_n","int"), ("pit_loss_samples_s","float[]"), ("pit_loss_source","text"), ("sc_lap_ratio","float"), ("vsc_lap_ratio","float"), ("sc_ratio_source","text"), ("p_sc_per_lap","float"), ("p_vsc_per_lap","float"), ("sc_mean_laps","float"), ("vsc_mean_laps","float"), ("hazard_races","int"), ("hazard_sc_episodes","int"), ("hazard_vsc_episodes","int"), ("hazard_green_laps","int")]
TABLE_COLUMNS["sim_compound_params"] = [... as B.2, DDL order]
TABLE_COLUMNS["sim_driver_params"]   = [... as B.3, DDL order]
RACE_TABLE_ORDER += ["sim_race_params", "sim_compound_params", "sim_driver_params"]   # appended after track_status_events
ANALYTICS        += ["sim_race_params", "sim_compound_params", "sim_driver_params"]
```
`float[]` is a new column kind for `cast_frame` (list of floats → Postgres array; `text[]` already exists for `warnings`, so the COPY/insert path already handles arrays). `db.assert_schema` compares the three new tables like the other 29, so `--check-schema` fails loudly until `0001` is applied.

---

## C. Python

### C.1 New module `f1lab/simulation.py` (pure functions, no db access; the notebook-style contract of `pace.py`)

```python
@dataclass(frozen=True)
class CircuitHistory:                       # read by ingest.py before build_race_frames; empty when nothing is ingested yet
    races: int
    sc_episodes: int
    vsc_episodes: int
    green_laps: int
    pit_loss_samples_s: list[float]         # usable losses over every ingested race at this circuit_key

@dataclass
class RaceFit:                              # the OLS of A.2 plus the additive fallback fit
    cells: pd.DataFrame                     # driver, compound, base_s, base_se_s, cell_laps
    compounds: pd.DataFrame                 # compound, laps, deg_raw, deg_se, offset_s, offset_se_s, max_age_observed
    evo_s_per_lap: float; warmup_s: float; resid_sd_s: float; r2: float
    resid_by_driver: dict[str, tuple[float, int]]   # driver -> (sd, n)
    fit_laps: int; fit_drivers: int

def fit_race_model(laps_fc: pd.DataFrame, *, min_cell_laps: int = config.SIM_MIN_CELL_LAPS,
                   min_compound_laps: int = config.SIM_MIN_COMPOUND_LAPS) -> RaceFit
    # input: the fuel-corrected representative laps already built in build_race_frames (laps_fc);
    # raises ValueError('fewer than SIM_MIN_FIT_LAPS representative laps') so _guard records 'error: ValueError: ...'

def pit_losses(raw_laps: pd.DataFrame, pits: pd.DataFrame, lap_status: pd.DataFrame) -> pd.Series
    # A.6: one usable loss per stop, index = (Driver, stop_number); raw (not fuel-corrected) lap times

def race_params(fit: RaceFit, losses: pd.Series, lap_status: pd.DataFrame, raw_laps: pd.DataFrame,
                history: CircuitHistory) -> pd.DataFrame          # 1 row, EXPECTED_COLUMNS['sim_race_params'] minus ids
def compound_params(fit: RaceFit) -> pd.DataFrame                  # sim_compound_params rows
def driver_params(fit: RaceFit, raw_laps: pd.DataFrame, results: pd.DataFrame,
                  stints: pd.DataFrame, pits: pd.DataFrame, race: pd.DataFrame,
                  compounds: pd.DataFrame) -> pd.DataFrame         # sim_driver_params rows incl. the calibration replay

def replay_actual(strategy: list[Stint], race: dict, compounds: dict, cells: dict, flags: list[str],
                  total_laps: int) -> float
    # the deterministic replay of A.9 — the SAME arithmetic as the browser engine with all draws at their mean;
    # tests/test_simulation.py asserts it against a hand-computed 3-stint example so the TS engine has a golden number
```

### C.2 Hook into `build_race_frames` (the one place the file is edited)

`build_race_frames(session, ids, assumption_set_id, *, circuit_history: CircuitHistory | None = None)` — a keyword with a default so every existing call (tests, `dry_run`) keeps working. After the existing `pits`/`lstatus` guards:

```python
sim_fit = _guard(status, "sim_race_params", lambda: simulation.fit_race_model(laps_fc))   # returns RaceFit; _guard accepts any truthy object
if sim_fit is not None and pits is not None and lstatus is not None:
    losses = simulation.pit_losses(raw, pits, lstatus)
    race_df = _guard(status, "sim_race_params", lambda: simulation.race_params(sim_fit, losses, lstatus, raw, circuit_history or simulation.EMPTY_HISTORY))
    comp_df = _guard(status, "sim_compound_params", lambda: simulation.compound_params(sim_fit))
    drv_df  = _guard(status, "sim_driver_params", lambda: simulation.driver_params(sim_fit, raw, session.results, stints, pits, race_df, comp_df))
else: mark the three keys 'empty: no model fit' / 'empty: pit_stops or lap_status missing'
```
`_guard` needs one small change: `if df is None or len(df) == 0` → also treat a non-frame object as ok (RaceFit has `__len__` = `fit_laps`). Status keys: `sim_race_params`, `sim_compound_params`, `sim_driver_params` (each `'ok' | 'empty[: reason]' | 'error: ...'`); `race.ts` reads them with `reasonFor(status, "sim_race_params", "sim_driver_params", "sim_compound_params")`. Rain races typically produce `error: ValueError: fewer than 200 representative laps` or a fit with only INTERMEDIATE parameterised — both render as an honest EmptyState / single-compound picker.

`ingest.py` (`run_season` and `dry_run`): before `build_race_frames` for a race, `history = simulation_history(conn, circuit_key)` — one SELECT over `lap_status`/`pit_stops`/`laps` joined to `events` for ingested races at the same `circuit_key` **excluding the session being written** (so a `--force` re-ingest never counts itself). This is a small function in `ingest.py` (it is the only module that owns a connection at frame-build time); `dry_run` passes `None`.

### C.3 New `config.py` constants (all UPPER_CASE, so `assumptions.snapshot()` changes → a new `assumption_sets` row; see C.5)

```python
# --- Strategy simulator (v1.1) ---
SIM_MIN_FIT_LAPS = 200          # representative laps needed before a race model is fitted at all
SIM_MIN_CELL_LAPS = 6           # driver x compound cell fitted directly; below this it is inferred from the field offset
SIM_MIN_COMPOUND_LAPS = 10      # a compound is parameterised (pickable) with at least this many representative laps field-wide
SIM_MIN_NOISE_SD = 0.25         # floor on a driver's lap-to-lap noise sd (s)
SIM_MIN_NOISE_LAPS = 12         # below this many residuals the field sd is used
SIM_MIN_PIT_SAMPLES = 6         # usable green-flag stops needed for a race-specific pit loss; else circuit pooled; else no simulator
SIM_EXTRAPOLATION_LAPS = 5      # stint longer than max observed age + this -> "extrapolated" flag (UI only, stored as max_age_observed)
SIM_PIT_LOSS_FACTOR_SC = 0.5    # pit loss multiplier when the in-lap is under SC
SIM_PIT_LOSS_FACTOR_VSC = 0.7
SIM_SC_LAP_RATIO_POOLED = 1.38  # lap time under SC / driver green median, pooled 2024-2026 (2,250 laps)
SIM_VSC_LAP_RATIO_POOLED = 1.05
SIM_MIN_SC_LAPS_FOR_RATIO = 10  # race-specific ratio only with this many SC (or VSC) laps
SIM_SC_PRIOR_PER_LAP = 0.0098   # 36 SC episodes / 3,686 race laps, pooled; Beta-style prior weight of one episode
SIM_VSC_PRIOR_PER_LAP = 0.0106  # 39 / 3,686
SIM_SC_MEAN_LAPS = 5.4          # geometric duration means (observed 5.44 / 3.62)
SIM_VSC_MEAN_LAPS = 3.6
```
The engine also needs `N` and the PRNG seed; those are web constants (E), not modelling assumptions.

### C.4 Tests (`tests/test_simulation.py`, no db except where marked)

1. `fit_race_model(hungary_2024)`: 3 compounds parameterised, `deg[HARD]` within 0.07–0.09, `deg[SOFT]` clamped, `resid_sd` 0.6–0.85, every driver with ≥ 6 laps on MEDIUM has a fitted MEDIUM cell, inferred HARD cell for a driver who never ran it equals `base[ref] + offset` (arithmetic check).
2. `pit_losses(hungary_2024)`: 40 usable stops, median 20–21 s, none from lap 1, stops on non-green laps excluded (synthetic frame with one SC in-lap).
3. `race_params` with `EMPTY_HISTORY`: `p_sc_per_lap == SIM_SC_PRIOR_PER_LAP`, `pit_loss_source == 'race'`; with a history of 3 races: the Beta formula by hand.
4. `replay_actual` golden test: a hand-built 3-stint strategy over 10 laps with known params → exact float; the same numbers are copied into `web/lib/sim/__tests__/engine.test.ts` (D/E) so both engines agree to 1e-9.
5. `driver_params(hungary_2024)`: `real_total_fc_s` equals `SUM(lap_time_fc_s)` computed independently with pandas; `calib_sim_total_fc_s` within 2 % of it for the winner (this is the model-adequacy gate, not a unit test — it is asserted loosely and printed).
6. `miami_2025` (NULL compounds): a driver whose actual strategy has a NULL-compound stint gets `calib_sim_total_fc_s = NULL` and no exception.
7. `r1_2026` (VSC laps): `sc_ratio_source == 'pooled'` when < 10 VSC laps; `test_guards.py` gains a monkeypatched `fit_race_model` raising `ValueError` → `analytics_status.sim_race_params` starts with `error:` and the session is `partial`.
8. `test_schema_contract.py` already compares `EXPECTED_COLUMNS` to `information_schema`; it covers the three new tables without changes.

### C.5 Recompute path

No new flag. The three tables are per-session children written in the same transaction as everything else, so `python -m f1lab.ingest --season YYYY --force` (about a minute for all three seasons from the cache) is the recompute path, and the changed `config.py` snapshot yields a new `assumption_sets` row; until every season is forced, the season page shows the existing `mixed_assumption_sets` badge — exactly the RUNBOOK's documented "constant changed" procedure. Ordering note for the circuit hazard: force-ingesting in season order (2024 → 2025 → 2026) makes each race's hazard include the earlier seasons at the same circuit; the second pass of the same command converges it fully. `docs/RUNBOOK.md` gets a paragraph saying so. `make ingest-all` already runs the three seasons in order.

---

## D. Query + client contract

One new export in `web/lib/queries/race.ts`, one payload, added to the page's existing `Promise.all`. The types live in `web/lib/sim/types.ts` (a plain `.ts` with no imports, so `components/charts` and the engine can import them without touching `lib/queries` — same rule as the chart files' structural types) and `race.ts` re-exports them.

```ts
// web/lib/sim/types.ts
export type SimFlag = "G" | "Y" | "SC" | "VSC" | "RED";              // per-lap replay of lap_status.worst_status

export type SimStint = { compound: string; startLap: number; endLap: number };   // pit happens at the END of endLap (the in-lap); next stint starts on lap endLap + 1
export type SimStrategy = { stints: SimStint[] };                                 // pit laps are implied: stint i ends on lap p_i -> pit lap p_i

export type SimCompoundParams = {
  compound: string;
  colour: string;                 // compound_colours, resolved like every other section
  laps: number;
  degSPerLap: number;             // clamped >= 0, the simulated value
  degRawSPerLap: number;
  degSeSPerLap: number;
  degClamped: boolean;
  maxAgeObserved: number;
};

export type SimCell = {
  compound: string;
  baseS: number;
  baseSeS: number;
  cellLaps: number;
  source: "fitted" | "inferred";
  refCompound: string | null;
};

export type SimDriver = DriverRef & {                                  // driverId, code, fullName, team*, lineStyle
  position: number | null;        // results.position (ordering + "P4" chip)
  status: string;                 // results.status
  lapsCompleted: number;
  cells: SimCell[];               // one per parameterised compound, always complete for a modellable driver
  noiseSdS: number;
  noiseSource: "driver" | "field";
  actual: SimStrategy | null;     // null when a stint has a NULL compound (Miami 2025) or the stints table is empty for the driver
  actualPitLaps: number[];        // pit_stops.lap_in in order (cross-checked against stints; mismatch -> actual = null, reason recorded)
  actualUnavailableReason: string | null;
  calibration: {
    realTotalFcS: number | null;  // SUM(lap_time_fc_s) over timed laps 1..lapsCompleted
    realLapsTimed: number;
    realLapsClean: number;
    simTotalFcS: number | null;   // Python's deterministic replay (calib_sim_total_fc_s)
  };
};

export type SimRaceParams = {
  totalLaps: number;
  evoSPerLap: number;
  warmupS: number;
  lap1PenaltyS: number;
  residSdS: number;
  r2: number;
  fitLaps: number;
  fitDrivers: number;
  pitLoss: { medianS: number; p25S: number; p75S: number; n: number; samplesS: number[]; source: "race" | "circuit" };
  sc: {
    lapRatio: number; vscLapRatio: number; ratioSource: "race" | "pooled";
    pPerLap: number; vscPPerLap: number; meanLaps: number; vscMeanLaps: number;
    hazardRaces: number; hazardScEpisodes: number; hazardVscEpisodes: number; hazardGreenLaps: number;
    pitLossFactorSc: number; pitLossFactorVsc: number;                  // from assumption_sets.params (config constants), so the browser never hard-codes them
  };
  flags: SimFlag[];               // index 0 = lap 1, length totalLaps (padded "G" when lap_status is short)
  extrapolationLaps: number;      // SIM_EXTRAPOLATION_LAPS from assumption_sets.params
};

export type SimModelPayload = {
  race: SimRaceParams;
  compounds: SimCompoundParams[];  // parameterised only, SOFT..WET order like the gantt legend
  drivers: SimDriver[];            // finishing order (loadDriverOrder), modellable drivers only
  unmodelled: (DriverRef & { reason: string })[];   // listed but disabled in the picker
  assumptionSetId: number;
};
```

```ts
// web/lib/queries/race.ts
export async function getSimModel(sessionId: number): Promise<SimModelPayload | null>;
// null when sim_race_params has no row for the session (the page then renders EmptyState with reasonFor(status, "sim_race_params", "sim_driver_params", "sim_compound_params")).
```
Implementation: four selects in one `Promise.all` — `sim_race_params` (1 row), `sim_compound_params` ⋈ `compound_colours`, `sim_driver_params` ⋈ `session_entries` ⋈ `session_teams` ⋈ `results` (reuses `loadDriverOrder`), `stints` + `pit_stops` for the actual strategies, `lap_status` for the flags, and `assumption_sets.params` for the three constants. Nothing is computed: the only reshaping is grouping rows by driver, mapping `worst_status` → `SimFlag` (`'4'`→SC, `'6'|'7'`→VSC, `'5'`→RED, `'2'`→Y, else G) and cross-checking `stints` against `pit_stops`. `SimStrategy` from `stints`: consecutive stints must tile `[firstStart .. lapsCompleted]`; if the first stored stint starts after lap 1 (§0.3), the gap is filled by extending the first stint backwards and `actualUnavailableReason` stays null but a note "first stint starts at lap N in the data" is attached — the simulator needs a compound for every lap.

**Byte estimate (22 cars, 3 compounds, 70 laps), JSON as RSC props:** race params ≈ 1.2 KB incl. 60 pit samples (≈ 0.5 KB) and 70 flags (≈ 0.4 KB); compounds 3 × 180 B ≈ 0.6 KB; drivers 22 × (DriverRef ≈ 220 B + 3 cells × 130 B + strategy 3 stints × 60 B + calibration 120 B) ≈ 22 × 0.9 KB ≈ 20 KB. **≈ 22–25 KB total**, or 4 % of the existing 500–700 KB race page. Doubles are rounded to 4 dp (seconds) / 6 dp (probabilities) in the query, which is well below the model's precision.

---

## E. Browser algorithm (`web/lib/sim/engine.ts`, pure TypeScript, no React, no DOM; `web/lib/sim/prng.ts`)

### E.1 PRNG
`mulberry32(seed)` (32-bit, ~10 lines, deterministic across browsers) with Box–Muller for normals. Seed = `SIM_SEED = 20240101` fixed: the same edit always produces the same numbers on screen (a fan sharing a screenshot with a friend sees the same result), and the golden test in C.4/E.6 is reproducible. A "re-roll" is deliberately *not* offered.

### E.2 Inputs
`payload: SimModelPayload`, `driver: SimDriver`, `edited: SimStrategy`, `mode: "replay" | "random"`, `N`.

### E.3 One draw (pseudocode)

```
prep(strategy):                                   // once per run, not per draw
  for lap 1..totalLaps: compound[lap], age[lap] (1 on the first lap of a stint), isInLap[lap] (lap == stint.endLap for every stint but the last)
  stops = number of in-laps

draw(n):
  // --- shared random numbers: drawn ONCE, used by both strategies -------------------------
  degDraw[c]   = max(0, deg[c] + degSe[c] * gauss())            for every parameterised compound
  baseDraw[c]  = base[d,c] + baseSe[d,c] * gauss()               for every cell of this driver
  pitDraw[k]   = pitSamples[floor(u * pitSamples.length)]        k = 0..maxStops-1 (max over both strategies)
  z[lap]       = gauss() * noiseSd                               lap 1..totalLaps
  flags        = payload.race.flags                               (mode "replay")
               | drawSchedule()                                   (mode "random": per lap, if state == G: u < pSc -> SC for 1 + geometric(1/meanLaps) laps, else u < pVsc -> VSC ...; red never)

  // --- one strategy ------------------------------------------------------------------------
  total(strategy):
    t = 0; k = 0
    for lap in 1..totalLaps:
      c = compound[lap]; a = age[lap]
      lapTime = baseDraw[c] + degDraw[c] * (a - 1) + (a <= 2 ? warmup : 0) + evo * (lap - 1) + (lap == 1 ? lap1 : 0)
      if flags[lap] == SC:  lapTime += (scRatio - 1) * baseDraw[c]
      if flags[lap] == VSC: lapTime += (vscRatio - 1) * baseDraw[c]
      if isInLap[lap]:      lapTime += pitDraw[k++] * (flags[lap] == SC ? fSc : flags[lap] == VSC ? fVsc : 1)
      lapTime += z[lap]
      t += lapTime; cum[lap] = t
    return t, cum

  (tE, cumE) = total(edited); (tA, cumA) = total(actual)
  delta[n] = tE - tA
  gap[lap][n] = cumE[lap] - cumA[lap]                              // "how far behind/ahead the edited car is at the end of each lap"
```
`z[lap]` cancels exactly in `delta` and `gap`; it is kept so that the *calibration band* (E.5) and any future "absolute time" view use the same loop. Fuel: never added (decision 3); the calibration line adds `SUM(fuel_penalty_s)` back only in its display of the real race duration, which is the same number for every strategy.

### E.4 N and outputs
`N = 4000`. Verified in Node (`output/sim_engine_bench.mjs`, 70 laps, 3-stint vs 3-stint, mulberry32 + Box–Muller, including sorting 70 per-lap arrays of 4000): **42 ms**. Well under a second even on a 5× slower phone; no worker (decision 2). Outputs, all from sorted `Float64Array`s:
- `deltaMedianS`, `deltaP10S`, `deltaP90S` (edited − actual; negative = faster);
- `pBetter = count(delta < 0) / N`;
- `perLap[lap] = { median, p10, p90 }` of `gap[lap]`, for the lap-by-lap chart;
- `stops`, `scLapsUsed` (how many laps of the schedule were SC/VSC — shown as a note in random mode: "on average 3.1 laps under SC per simulated race").
Sorting is `Float64Array.prototype.sort` (numeric, in place). Memory: 71 × 4000 doubles ≈ 2.3 MB, allocated once per run.

### E.5 Calibration computation (decision 6)
Two numbers, shown on one line:
1. `simTotalFcS` — Python's deterministic replay (payload) is the server-rendered value; on the client the engine recomputes it as `total(actual)` with every draw at its mean (`gauss() → 0`, `pitDraw → pitLoss.medianS`) and the two must agree to 1e-6 (a `console.assert` in dev; a mismatch means the two engines diverged — E.6).
2. `realTotalFcS` from the payload. Discrepancy `= sim − real` in seconds and in percent of `real`; the sentence also reports `realLapsClean / realLapsTimed`.
The N-draw replay of the actual strategy additionally gives a p10–p90 band of the replay total, which is *not* shown as a primary number (a fan does not need it) but drives the trust badge: `|discrepancy| <= 1 %` → "good fit", `<= 3 %` → "rough fit", else "poor fit — treat the result as indicative only".

### E.6 Two engines, one arithmetic
`f1lab.simulation.replay_actual` and `engine.total()` implement the same formula. A golden fixture (`web/lib/sim/__tests__/golden.json`, produced by `tests/test_simulation.py::test_replay_golden` and committed) pins a 10-lap, 3-stint, hand-checkable case with SC on laps 4–5 and one stop under SC; `engine.test.ts` (vitest, added as a dev dependency — the web package currently has no test runner) asserts equality to 1e-9. Complexity: O(N × totalLaps) time, O(N × totalLaps) memory; the run is synchronous inside a `useMemo` keyed on `(driverId, edited, mode)` with a 150 ms debounce on edits so typing a pit lap does not run 4000 draws per keystroke.

---

## F. UI spec — `components/race/StrategySimSection.tsx` ('use client') in the `#simulator` slot

**Slot:** after "Tyre degradation", before "Race trace" (the default) — kept, because the fan has just read the two inputs the simulator uses (the stint gantt and the degradation slopes) and the race trace afterwards is the reality check the caption points to ("in the real race he was stuck behind Alonso — look at the trace"). Section title: **"What if they had pitted on lap 22?"**; page caption: *"Edit one driver's strategy and simulate it against what they really did — clean-air time only."* Added to the `SECTIONS` nav array as `{ id: "simulator", title: "Strategy simulator" }`.

Visual language: the same `rounded-lg border border-grid bg-surface p-3` cards, `StatTile` for numbers, `CompoundChip`/`DriverChip` for identity, `EChart` with the `f1dark` theme, `Caption` under every card, `EmptyState` for every failure. No new colours: the edited strategy is drawn in the driver's team colour, the actual strategy in `PALETTE.muted`, SC/VSC bands as in `RaceTrace`.

### F.1 Layout (single column on mobile, two columns ≥ `lg`)

```
┌ Driver ─────────────────────────────┐ ┌ Result ─────────────────────────────────────────┐
│ [P1 NOR ▾]  Lando Norris · McLaren  │ │ [Edited strategy is 1.2 s FASTER]  [P(faster) 93 %] │
│ Mode: (•) Race as it happened       │ │ [Median gain −1.15 s]  [Likely range −1.3 … −1.0 s] │
│       ( ) Random safety cars        │ │ hint lines under each tile (one sentence each)  │
├ Strategy ───────────────────────────┤ ├ Lap by lap ─────────────────────────────────────┤
│ Stint 1  [MEDIUM ▾]  laps 1–[18]    │ │ line chart: gap of the edited car to the actual │
│ Stint 2  [HARD   ▾]  laps 19–[47]   │ │ car at the end of every lap, p10–p90 band,      │
│ Stint 3  [MEDIUM ▾]  laps 48–70     │ │ pit laps marked, SC/VSC bands                   │
│ [+ add stop] [Reset to actual] [Presets ▾]                                              │
│ Actual: M 1–18 · H 19–47 · M 48–70  │ │ Calibration: one line + trust badge             │
└─────────────────────────────────────┘ └─────────────────────────────────────────────────┘
Caption (verbatim, F.8)
```

### F.2 Driver selector
A native `<select>` (styled like `SeasonSwitcher`) listing every driver in finishing order, label `P{position} {code} — {fullName}`; drivers in `payload.unmodelled` appear disabled with `— not enough clean laps`. **Default = the race winner** (first modellable driver in finishing order): the fan lands on a strategy everyone remembers. Changing driver resets the editor to that driver's actual strategy. A `DriverChip` with team colour sits next to the select.

### F.3 Mode
Two radio buttons. *Race as it happened* (default, `replay`): hint "Safety cars on the laps they really came out." *Random safety cars* (`random`): hint "Safety cars drawn from this circuit's history: {hazardScEpisodes} in {hazardRaces} races here." Switching mode reruns immediately.

### F.4 Stint editor (the heart of the section)
Rows, one per stint; each row: stint number, a `<select>` of **parameterised compounds only** (rendered with `CompoundChip` colour; `degClamped` compounds carry the suffix "· no measured wear"), the fixed start lap (derived), and an editable **last lap** number input (the pit lap) — except the final stint, whose last lap is `totalLaps` and read-only. Editing is by pit lap, not stint length, because that is how fans talk ("pit on lap 22").

Validation (inline, red text under the row, run disabled while any error exists):
- pit lap `p_i` must satisfy `start_i <= p_i < start_{i+1}` — i.e. strictly increasing, ≥ 1, ≤ totalLaps − 1; message "pit lap must be between {start_i} and {p_{i+1} − 1}";
- every stint at least `SIM_MIN_STINT_LAPS = 2` laps (an in-lap needs an out-lap): "a stint needs at least 2 laps";
- at most **4 stops** (5 stints): the "+ add stop" button disables with the tooltip "4 stops is the most this editor allows";
- a compound that is not `fitted` for this driver: amber (not red) note under the row, "LEC never ran the soft in this race — pace inferred from the rest of the field"; not blocking;
- a stint longer than `maxAgeObserved + extrapolationLaps` for its compound: amber note "longer than any real stint on this tyre ({maxAgeObserved} laps) — the wear line is extrapolated"; not blocking;
- no regulatory checks (two compounds rule, mandatory stop): deliberately not enforced; the caption says so, and a 0-stop strategy is allowed because "what if he had not pitted at all" is a fair question.

Controls:
- **+ add stop** splits the longest stint at its midpoint, new stint inherits the compound (fan then edits);
- **× remove** on each row (hidden when only one stint): merges into the previous stint (or the next, for the first row);
- **Reset to actual** restores `driver.actual`;
- **Presets ▾**: *Pit 3 laps earlier / later* (shifts every pit lap ±3 within validity), *One stop fewer* (removes the last stop, extends the previous stint), *Swap compounds* (rotates the compound of each stint to the next parameterised one); each preset is one click and immediately runs — they exist so the first interaction never needs typing;
- Below the rows, the **actual strategy** in words (`M 1–18 · H 19–47 · M 48–70`, chips coloured) so the fan always sees the reference.

Edits apply on `change`/blur with a 150 ms debounce; a run takes ≈ 40 ms, so there is no spinner — the result cards fade (`opacity-60`) while stale and the "Run" button is not needed. There *is* a small "Simulating 4,000 races…" text under the cards for the first render only (client hydration: the section server-renders the driver's calibration line and empty tiles, then the first run fills them).

### F.5 Result cards (four `StatTile`s, each with a one-sentence hint)
1. **Verdict** — value `"1.2 s faster"` / `"0.8 s slower"` / `"about the same"` (|median| < 0.2 s) in the team colour / muted; hint "Median of 4,000 simulated races, edited minus actual, clean-air time."
2. **P(faster)** — `93 %`; hint "Share of simulated races where the edited strategy finishes in less time."
3. **Median gain** — `fmtGap(median, 2)` with the sign convention **negative = faster** shown as `−1.15 s`; hint "Half the simulated races are better than this, half worse."
4. **Likely range** — `p10 … p90` (`−1.32 … −0.98 s`); hint "8 in 10 simulated races land in this range; the spread comes from how sure the wear slope is, how variable the pit stops were{, and when a safety car comes}."
In random mode a fifth muted line: "Simulated safety-car laps per race: 3.1 on average."

### F.6 Lap-by-lap chart (`components/charts/SimGapChart.tsx`, `EChart`, height 360)
- x: lap 1..totalLaps (`category`, same axis config as `RaceTrace`); y: **"Edited car vs actual car (s)"**, positive = edited car behind, y **inverted** so ahead is up, mirroring the race trace's "leader on top" convention;
- series: median line in team colour (width 2), p10–p90 band as two stacked transparent `line` series with `areaStyle` (the ECharts confidence-band idiom), zero line as `markLine`;
- `markPoint` triangles on the edited pit laps (team colour) and the actual pit laps (muted), labelled "pit"; SC/VSC/red bands via the same `statusBands()` helper exported from `RaceTrace.tsx` (mode replay) or the *median* schedule is not drawn (mode random: bands would mislead; a legend note says "safety cars vary per simulated race");
- tooltip per lap: `Lap 22 · edited car +19.8 s behind (p10 +19.5, p90 +20.1) · pit stop (edited)`;
- `EChartsOption` shape: `{ grid: { left: 60, right: 36, top: 40, bottom: 48 }, xAxis: { type: "category", data: laps }, yAxis: { type: "value", inverse: true, name: "…" }, series: [bandLo(stack:"b", lineStyle:{opacity:0}), bandHi(stack:"b", areaStyle:{color: team, opacity: 0.18}, lineStyle:{opacity:0}), median(line, team), status(markArea)] }`.

### F.7 Calibration line (always visible, server-rendered, above the caption)
Format: **"Trust check:** replaying NOR's real strategy, the model gives **1:32:04** fuel-corrected; his real fuel-corrected total was **1:32:27** — the model is **23 s (0.4 %) optimistic**. 56 of his 70 laps were clean-air laps the model was fitted on." followed by the badge `good fit` / `rough fit` / `poor fit` (thresholds E.5, colours: accent / amber / red text). When `realTotalFcS` is null: "Trust check unavailable — no timed laps for this driver." When `actual` is null: the editor still works from a default 1-stop preset built from the field's most common strategy, the verdict tiles are replaced by "no reference strategy for this driver ({actualUnavailableReason})", and only the absolute per-lap chart is shown.

### F.8 Caption (verbatim; `SIM_CAPTION` export, rendered under the whole section)
> This simulator answers one question only: how much clean-air time a different strategy would have gained or lost for this driver. It does not model traffic, blue flags, overtaking or track position, so it never says whether they would have finished ahead of anyone — a stop that looks 1 s better here can still lose a place on the road. Lap times come from a model fitted to this race's clean laps (driver × tyre base pace, one wear slope per compound, track evolution); pit loss is resampled from this race's own green-flag stops; safety cars either replay the real ones or are drawn from this circuit's history. Fuel load is left out because it is the same on every lap for every strategy of the same driver. A stop under a safety car costs about half here, not nothing — the "free stop" you see on TV is mostly the field bunching up, which is a position effect. Tyre wear is a straight line and keeps going past the longest real stint; the rules about mandatory compounds are not enforced. The trust check above shows how far the model is from the real race for this driver; treat anything smaller than that gap as noise.

### F.9 Empty and degraded states
- No `sim_race_params` row → `EmptyState title="No strategy model for this race" reason={reasonFor(status, "sim_race_params", "sim_driver_params", "sim_compound_params")}` (wet races, red-flag-shortened races, too few clean laps).
- One parameterised compound only (e.g. INTERMEDIATE) → editor works, compound select has one option, and an amber note "only the {compound} has enough clean laps in this race".
- `pitLoss.source === 'circuit'` → note under the editor "pit loss borrowed from other races at this circuit (fewer than 6 usable stops here)".
- Accessibility: every control labelled, results in an `aria-live="polite"` region, chart container `role="img"` with an `aria-label` summarising the verdict sentence.

---

## G. Work breakdown (strict file ownership; each named file has exactly one owner)

| Package | Owner of | Creates | Verification |
|---|---|---|---|
| **WP-S0 Schema** (first, ~2 h) | `web/db/schema/index.ts` (one added `export * from "./simulation"`), `f1lab/frames.py` (B.4 additions + `float[]` kind + `_guard` object support + the `circuit_history` keyword and the C.2 hook block, written as a call into the not-yet-existing `simulation` module behind the guard) | `web/db/schema/simulation.ts`, `web/drizzle/0001_simulation.sql` + journal/snapshot via `npm run db:generate` | `make migrate`; `python -m f1lab.ingest --check-schema` exits 0; `pytest tests/test_schema_contract.py` |
| **WP-S1 Python model** (after S0's `frames.py` lands; ~1 day) | `f1lab/config.py` (C.3 constants), `f1lab/ingest.py` (`simulation_history(conn, circuit_key)` + passing it), `docs/RUNBOOK.md` (recompute paragraph) | `f1lab/simulation.py`, `tests/test_simulation.py`, `web/lib/sim/__tests__/golden.json` (generated) | `pytest tests/test_simulation.py tests/test_guards.py`; `python -m f1lab.ingest --season 2024 --round 13 --force` then `SELECT count(*) FROM sim_driver_params` = 60; then `make ingest-all` with `--force` (≈ 1 min) and `SELECT session_id FROM sessions WHERE kind='R' EXCEPT SELECT session_id FROM sim_race_params` lists only the rain/red-flag races with an `empty`/`error` status |
| **WP-S2 Web engine + query** (parallel with S1 from S0's schema; ~1 day) | `web/lib/queries/race.ts` (`getSimModel` + re-exports), `web/package.json` (vitest dev dep + `"test": "vitest run"`) | `web/lib/sim/types.ts`, `web/lib/sim/prng.ts`, `web/lib/sim/engine.ts`, `web/lib/sim/__tests__/engine.test.ts`, `web/lib/sim/fixtures/hungary2024.json` (a hand-written payload matching D, used until the real data lands) | `npm run typecheck`, `npm run lint`, `npm test` (golden equality to 1e-9 once S1 commits `golden.json`; before that, the engine's own hand-computed 10-lap case); `node` bench ≤ 100 ms at N=4000 |
| **WP-S3 UI** (parallel with S2 after `types.ts` exists — the types file is committed first, on day 1; ~1.5 days) | `web/app/race/[year]/[round]/page.tsx` (one `getSimModel(id)` in the `Promise.all`, one `<Section id="simulator">`, one `SECTIONS` entry) | `web/components/race/StrategySimSection.tsx`, `web/components/race/StintEditor.tsx`, `web/components/race/SimResultTiles.tsx`, `web/components/charts/SimGapChart.tsx` | `npm run typecheck`/`lint`/`build`; browser: `/race/2024/13` winner default, 4 tiles filled within one frame, edit pit lap 18 → 22 changes the verdict, invalid lap shows the red message and stale tiles, `/race/2025/6` (Miami, NULL compounds) shows the no-reference state for the affected driver, a wet race shows the EmptyState; console clean |
| **WP-S4 Integration** (sequential last; ~half day) | `docs/SPEC.md` (§9 "v1.1 strategy simulator" appendix + §8 rows) | — | full `pytest` (all previous 135 + new), `make ingest-all` forced twice in season order (hazard convergence), crawl of all 71 race routes for `Application error`/`NaN`, calibration table: for every race, the winner's discrepancy printed; median |discrepancy| across races is the headline number of the release note |

**What the web package builds before the Python data lands:** everything. `types.ts` is a contract, `engine.ts` runs on `fixtures/hungary2024.json` (numbers taken from A.2's verified fit: bases, `deg 0.078/0.062/0`, pit samples = the 40 losses of A.6, flags all green), `StrategySimSection` renders from the same fixture through a temporary story route or the vitest DOM. `getSimModel` returns `null` for every session until `0001` is applied and rows exist, which is exactly the EmptyState path — so `page.tsx` can merge on day 1 without breaking any race page.

**Sequencing:** S0 (day 0, half day) → S1 ‖ S2 (S2 needs only the Drizzle schema for `getSimModel`; S1 needs `frames.py`) → S3 starts on day 0 too from `types.ts` and the fixture, blocked only on S2's `engine.ts` for live numbers (import path agreed up front) → S4.

**Cross-package contracts frozen at S0:** the DDL of B (both `frames.EXPECTED_COLUMNS` and `simulation.ts` are transcribed from it), `types.ts` of D, the golden fixture format of E.6 (`{ params, strategy, flags, totalFcS }`), the three `analytics_status` keys of C.2.

---

## H. Risks (top 5)

1. **Model misspecification — linear wear, no cliff, no traffic; the model flatters everyone.** Hungary's replay is a clean-air lower bound: real laps in traffic are slower, so `sim − real` will be negative for most drivers and larger for midfield cars. Contained by: the calibration line *per driver* with the "clean laps / timed laps" count (the fan sees *why* the gap exists), the trust badge thresholds (1 % / 3 %), the caption's "treat anything smaller than that gap as noise", and the extrapolation flag on stints longer than any observed. Residual risk accepted: the tool is honest about being a clean-air comparison; S4's release note publishes the median discrepancy across all races so nobody has to take the caveat on faith.
2. **Wrong-sign or absurd degradation on thin compounds (SOFT with 11 laps at Hungary: −0.07 ± 0.06).** Clamping to 0 and flagging `degClamped` keeps the simulator usable but makes a soft stint look free. Mitigation: the compound picker shows "no measured wear" next to the compound, the inferred/thin-cell amber notes stack on the stint row, and `SIM_MIN_COMPOUND_LAPS = 10` keeps truly unparameterised compounds out of the picker. If S4's calibration table shows soft-heavy edits are systematically over-optimistic, raise the threshold to 20 (one constant, one `--force`).
3. **Misreading "P(faster) 93 %" as "would have finished ahead".** This is the product's biggest honesty risk, not a statistical one. Mitigation: the section title and every tile hint say "time"/"clean-air"; the caption's first two sentences say what it is not; the y-axis of the chart is "edited car vs actual car (s)", never "position"; the calibration line sits *between* the results and the caption so the caveat is read on the way down. No position, no P(overtake), no "would have won" wording anywhere in the copy.
4. **Two engines drift (Python replay vs TypeScript engine).** A one-lap bookkeeping mismatch (does the pit loss land on the in-lap? does age reset to 1 on the out-lap?) silently shifts every result. Mitigation: E.6's committed golden fixture asserted to 1e-9 in both test suites, the dev-mode `console.assert` comparing the server-rendered `calib_sim_total_fc_s` with the client's mean replay, and the stint convention written once in D (`pit at the END of endLap; age 1 on endLap + 1`).
5. **Data-shape edge cases break the editor (NULL compounds at Miami 2025, first stint starting after lap 1, `NONE` compound label, DNFs, red-flag-shortened races, hazard history that includes the race itself on `--force`).** Mitigation: `actual = null` with a reason instead of a guessed strategy; backward extension of the first stint documented in D; `NONE`/`UNKNOWN` never parameterised (they fail `SIM_MIN_COMPOUND_LAPS` or are excluded explicitly in `fit_race_model`); DNF calibration on laps 1..`lapsCompleted`; the history SELECT excludes the session being written; every path has a test in C.4 on the three fixture sessions the suite already loads.

Secondary, noted: the ~25 KB payload on a 500–700 KB page is immaterial; N=4000 at 42 ms means no worker and no perceptible lag; `mulberry32` is not cryptographic and does not need to be; adding vitest is the only new web dependency.
