# F1 Analytics v1.1 — Monte Carlo Strategy Simulator (data-first proposal)

Angle: design from the data contract outward. Python owns every estimate; Postgres owns the truth; the browser owns only the simulation loop. Nothing drifts between Python and TypeScript because both sides read the same column names from the same tables.

Outline
- A. The race model
- B. Schema (tables, DDL, populating functions, EXPECTED_COLUMNS)
- C. Python (module, hook, config, tests, recompute)
- D. Query + client contract (payload types, byte estimate)
- E. Browser algorithm (PRNG, CRN, draw loop, outputs, complexity)
- F. UI spec
- G. Work breakdown + file ownership
- H. Risks

## A. The race model

Everything below is estimated by Python at ingest from the `laps`, `lap_status`, `pit_stops` and (cross-season) `events`/`sessions` tables; the browser only evaluates the formula. All numbers in this section were re-checked against the live DB (2024 R13 Hungary session_id 16, 2025 R6 Miami 397, 2026 R1 421) with `output/_probe_model.py` and ad-hoc SQL.

### A.1 Lap-time equation (fuel-corrected seconds)

For driver `d`, compound `c`, tyre age `a` (= `tyre_life`, 1 on the out-lap), race lap `L`, under track state `s ∈ {green, vsc, sc}`:

```
T_fc(d, c, a, L, s) = base[d][c]                       -- driver×compound pace at age 0, lap 0
                    + deg[c] · (a − 1)                 -- linear degradation per lap of age (pooled per compound)
                    + evo · L                          -- track evolution (negative = track gets faster)
                    + ε_d                              -- lap noise, ε_d ~ Student-t(ν=5) · sd_d
                    if s == sc:  T = T_fc · sc_factor  (replaces the whole line; no noise)
                    if s == vsc: T = T_fc · vsc_factor
```

Why fuel-corrected: the fuel term `fuel_penalty_s(L)` (config `FUEL_EFFECT_S_PER_KG · fuel_kg(L)`) depends only on `L` and the race length, so for two strategies of the same driver it is added lap-for-lap to both totals and cancels exactly in the delta. The calibration line (A.9) re-adds it explicitly so the simulated ACTUAL strategy can be compared with the real elapsed time.

Simulated total time for a strategy = Σ_L T(…) + Σ_stops pit_loss(state at the stop). No traffic, no blue flags, no overtaking (fixed decision 7).

### A.2 Estimator: one joint OLS per race (`f1lab/strategy.py::fit_race_model`)

Rows: `laps` where `is_representative AND compound IN parameterised slicks AND tyre_life >= 2` (tyre_life 1 is always an out-lap and already `excl_out_lap`; the `>= 2` guard mirrors `compound_degradation(min_tyre_life=2)`). Wets/inters are excluded from the fit; a race whose representative laps are majority INTERMEDIATE/WET (rain race) gets no model (A.10).

Design matrix, fit with `statsmodels.OLS` (already a dependency; `pace.degradation` uses it):

```
y = lap_time_fc_s
X = [1{driver=d} for every driver d]                      (no global intercept; driver dummies absorb it)
  + [1{compound=c} for every compound c except the reference]  reference = the compound with the most rows
  + [1{compound=c}·(tyre_life−1) for every compound c]     → deg[c]
  + [lap_number]                                           → evo
```

Then `base[d][c] = β_d + β_c` (β_ref = 0). Verified on Hungary 2024: n=1233, R²=0.61, residual sd 0.756 s; deg HARD 0.084 s/lap (se 0.003), MEDIUM 0.070 (se 0.006), SOFT 0.002 (se 0.036, 34 laps — see A.4); evo −0.0043 s/lap (se 0.0013); MEDIUM offset +0.12 s, SOFT +0.70 s vs HARD at age 0. (The "R² 0.74" figure from the interrupted analysis was for a different race; 0.6–0.75 is the range to expect.)

Why joint rather than reusing `degradation_fits` / `compound_degradation`: 627 of 1,000-odd per-stint fits in `degradation_fits` have a NEGATIVE slope (evolution and fuel-correction leftovers dominate a short stint), and 29/163 `compound_degradation` rows are negative. The joint fit separates evolution from degradation and driver pace from compound offset, which is exactly the decomposition a strategy delta needs. The v1 tables are untouched.

### A.3 Driver × compound base pace and fallbacks

`base[d][c]` is defined for every driver in the fit and every parameterised compound (the dummies are additive, so the driver never needs to have run `c`). The stored row carries a `source` flag so the UI can say how much to trust it:

| `source` | meaning |
|---|---|
| `fit` | the driver has ≥ `SIM_MIN_LAPS_DRIVER_COMPOUND` (= 5) representative laps on `c` |
| `additive` | driver dummy + compound offset only (driver never ran `c`, or < 5 laps) |
| `none` | compound not parameterised for this race (< `SIM_MIN_LAPS_COMPOUND` = 30 pooled laps) → cannot be selected in the editor |

Drivers with fewer than `SIM_MIN_LAPS_DRIVER` (= 8, same as `pace_ranking(min_laps=8)`) representative laps in total get no rows → the driver selector greys them out with "not enough clean laps".

### A.4 Degradation per compound

Pooled per compound from the joint fit (one `deg[c]` per race per compound), NOT per driver-stint: per-driver-compound slopes have se 0.02–0.05 s/lap on 10-lap stints and would move the delta by ± 10 s over a stint. Handling of small samples: a compound with < 30 pooled laps at age ≥ 2 is not parameterised (`source = none`, SOFT at Hungary 2024: 34 laps, se 0.036 — it passes by 4 laps and the UI shows the se as "± 0.04 s/lap"). A negative `deg[c]` estimate is clamped to 0 and flagged `deg_clamped = true` (a tyre cannot get faster with age once evolution is separated; the flag appears in the caption). Store `deg_se[c]` — it is sampled (A.8).

### A.5 Track evolution

`evo` (s per race lap, typically −0.002 … −0.010) from the joint fit, applied identically to both strategies lap-for-lap, so it cancels in the delta EXCEPT through its interaction with when a stop happens (none, in this linear form) — kept in the model anyway because it is needed for the calibration total and it keeps the age slopes unbiased. Fixed, not sampled.

### A.6 Noise

Per-driver residual sd `sd_d` = std of the driver's OLS residuals (Hungary: median 0.74 s, range 0.42–1.06 across 20 drivers), floored at `SIM_NOISE_SD_FLOOR` = 0.3 s. Residuals are right-skewed (p99 = +2.8 s vs p1 = −1.3 s; 4.1 % beyond 2 sd): a Student-t with ν = 5 scaled to `sd_d` reproduces the tails better than a Gaussian without modelling traffic explicitly. The noise draw is per (draw, lap) and SHARED between the edited and actual strategies (common random numbers) so it cancels in the delta except where the strategies differ in compound/age, which is the point. Sampled per draw.

### A.7 Stint warm-up and pit loss

The out-lap (tyre_life 1) and the in-lap are never representative laps, so their cost is folded into ONE number per race, measured in fuel-corrected time from the driver's own pace:

```
pit_loss_i = (t_in + t_out + fuel_corr_in + fuel_corr_out) − 2 · median_fc(d)
  t_in/t_out  = laps.lap_time_s of lap_in / lap_out (from pit_stops)
  fuel_corr   = lap_time_fc_s − lap_time_s on those laps
  median_fc(d)= driver's median lap_time_fc_s over is_representative laps
```
over stops where `lap_out IS NOT NULL`, both lap times non-NULL, and `lap_status.is_green` on BOTH lap_in and lap_out (excludes SC/VSC/red-distorted stops). Race pit loss = median over those stops; store p25/p75 and n. Verified: Hungary 20.2 s (18.3–21.3, n=39), Miami 2025 18.8 s (n=9), 2026 R1 25.2 s (21.6–29.1, n=9). Fewer than `SIM_MIN_GREEN_STOPS` = 4 green stops → fall back to the circuit's median across other ingested seasons (same `circuit_key`), flagged `pit_loss_source = 'circuit'`; none anywhere → no model. Per stop, the browser samples `pit_loss ~ Normal(median, (p75−p25)/1.349)` — captures crew variance; the same draw is used at the same stop index in both strategies.

Warm-up beyond the out-lap: tyre_life 2 vs 3 medians differ by < 0.05 s at Hungary, so no separate warm-up term. The pit loss already contains the out-lap.

### A.8 Safety car / VSC

Hazard per green lap from this circuit's history across ALL ingested seasons (`events.circuit_key` → every race `session_id`), pooled with a global prior:

```
sc_hazard  = (n_sc_periods_circuit  + SIM_SC_PRIOR_PERIODS · p_global_sc)  / (n_green_laps_circuit + SIM_SC_PRIOR_PERIODS)
vsc_hazard = same with VSC periods
```
where a "period" is a maximal run of consecutive `lap_status.worst_status = '4'` (SC) or `'6'|'7'` (VSC) laps, `p_global_sc = periods / green laps over every ingested race` (36 SC periods over ~3,200 green laps ≈ 0.011 per lap globally; mean SC length 5.4 laps), and `SIM_SC_PRIOR_PERIODS` = 100 laps of prior weight, so a circuit with 3 races (~200 laps) is ~2/3 its own data. Red flags are ignored (10 laps in 89 races; the race model cannot represent a stopped race).

Durations: `sc_len ~ 1 + Geometric(1 / mean_sc_len_global)` with the global mean (5.4), because per-circuit period counts are single digits. VSC: global mean of VSC runs.

Lap-time effect: `sc_factor = median(lap_time_s on SC laps) / median(lap_time_s on green laps)` over all ingested races (global; typically 1.35–1.5), same for `vsc_factor` (≈ 1.15–1.25). Pit loss under SC/VSC: `pit_loss · SIM_SC_PIT_LOSS_FACTOR`, a config constant = 0.5 (stops under a neutralised race cost roughly half in race time; there are too few green-vs-SC stop pairs per circuit to estimate it). Because pit_loss enters identically on both sides only when the stop indices coincide, this is where "pit under the SC" edits get their gain.

SC draws are shared per draw between the two strategies (same lap sequence of states), so the delta measures only the strategy's response to the same race.

### A.9 Calibration (fixed decision 6)

Python stores, per driver with a model:
- `actual_total_fc_s` = Σ over the driver's laps 1..laps_completed of `lap_time_fc_s` where non-NULL (+ `lap_time_s` for laps whose fc is NULL — never happens for laps with a time) — the REAL fuel-corrected total.
- `actual_total_s` = Σ `lap_time_s` (real elapsed, all laps).
- `laps_completed`, `n_sc_laps_driver` (laps with worst_status 4/6/7 in the driver's range).
The browser simulates the actual strategy WITH the real SC sequence forced (`lap_status` is in the payload) and no noise sampling for the calibration run (noise mean 0; it reports the median of the N draws anyway) and shows `sim_actual_median_fc − actual_total_fc_s` in seconds and as % of the total. Discrepancy > `SIM_CALIBRATION_WARN_S` = 15 s or > 1 % turns the calibration badge amber. This is the honesty line: it is exactly the error of the clean-air model on what really happened (traffic and everything unmodelled lands here).

### A.10 When there is no model (`analytics_status.strategy_model`)

`'empty'` (→ `<EmptyState>`) when: fewer than `SIM_MIN_LAPS_FIT` = 200 fit rows; fewer than 2 parameterised compounds; more than 50 % of representative laps on INTERMEDIATE/WET; OLS rank-deficient; pit loss unavailable at race and circuit level. `'error: …'` on exceptions via the existing `_guard`.

### A.11 Sampled per draw vs fixed

| Sampled per draw (shared between strategies) | Fixed across draws |
|---|---|
| `deg[c] ~ N(deg, deg_se)` (one draw per compound per race draw, clamped ≥ 0) | `base[d][c]`, `evo` |
| `ε_{d,L}` per lap, Student-t(5)·sd_d | `sd_d`, `sc_factor`, `vsc_factor` |
| SC/VSC onset per lap and duration | hazards, mean lengths |
| `pit_loss` per stop index | `pit_loss` median/IQR |

Sampling `deg` matters: it is the one parameter whose uncertainty drives the delta of a one-stop vs two-stop question, and the paired design lets a fan see "P(better) = 0.62" rather than a false-precision point estimate.

## B. Schema

Six new tables. Four are per race session (written inside the existing per-session transaction, deleted by `delete_session_children`, all carrying `assumption_set_id`); two are cross-season aggregates rewritten after every ingest run (the `season.recompute` pattern) because their inputs span sessions and a per-session write would make ingest order-dependent. Nothing existing changes.

### B.1 DDL (`web/drizzle/0001_strategy_sim.sql`, generated by drizzle-kit from `web/db/schema/strategy.ts`)

```sql
-- One row per race with a fitted model (absent row == no model; analytics_status.strategy_model says why).
CREATE TABLE strategy_models (
  session_id          integer PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  n_fit_laps          integer NOT NULL,            -- rows in the OLS
  n_drivers           integer NOT NULL,
  reference_compound  text NOT NULL,               -- compound whose offset is 0
  evo_s_per_lap       double precision NOT NULL,   -- track evolution β
  evo_se              double precision NOT NULL,
  resid_sd_s          double precision NOT NULL,   -- pooled residual sd
  r2                  double precision NOT NULL,
  pit_loss_s          double precision,            -- race-level green-flag median (A.7); NULL when < SIM_MIN_GREEN_STOPS
  pit_loss_p25_s      double precision,
  pit_loss_p75_s      double precision,
  pit_loss_n          integer NOT NULL,            -- green stops used (0 when NULL above)
  sc_factor           double precision NOT NULL,   -- SC lap time / green lap time, THIS race's laps if >= 3 SC laps else global
  vsc_factor          double precision NOT NULL,
  factor_source       text NOT NULL CHECK (factor_source IN ('race','global'))
);

-- Compound offset + pooled degradation per parameterised compound (A.4).
CREATE TABLE strategy_compound_params (
  session_id          integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  compound            text NOT NULL,
  laps                integer NOT NULL,            -- fit rows on this compound
  offset_s            double precision NOT NULL,   -- β_c (0 for the reference compound)
  offset_se           double precision NOT NULL,
  deg_s_per_lap       double precision NOT NULL,   -- clamped >= 0
  deg_se              double precision NOT NULL,
  deg_clamped         boolean NOT NULL,            -- raw estimate was negative
  PRIMARY KEY (session_id, compound)
);

-- Per driver: pace intercept, noise, and the calibration truths (A.6, A.9).
CREATE TABLE strategy_driver_params (
  session_id          integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id           text NOT NULL,
  laps_fit            integer NOT NULL,            -- this driver's rows in the OLS (>= SIM_MIN_LAPS_DRIVER)
  base_s              double precision NOT NULL,   -- β_d: fc lap time at age 1, lap 0, reference compound
  noise_sd_s          double precision NOT NULL,   -- residual sd, floored at SIM_NOISE_SD_FLOOR
  laps_completed      integer NOT NULL,            -- results.laps_completed
  actual_total_s      double precision NOT NULL,   -- Σ lap_time_s over laps with a time
  actual_total_fc_s   double precision NOT NULL,   -- Σ lap_time_fc_s (same laps)
  actual_fuel_s       double precision NOT NULL,   -- Σ fuel_penalty_s (same laps) == actual_total_s − actual_total_fc_s
  laps_with_time      integer NOT NULL,            -- how many laps entered the three sums
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Driver × compound base pace with its provenance (A.3). One row per driver-with-params × parameterised compound.
CREATE TABLE strategy_driver_compound_params (
  session_id          integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id           text NOT NULL,
  compound            text NOT NULL,
  base_s              double precision NOT NULL,   -- β_d + β_c
  laps                integer NOT NULL,            -- driver's fit rows on this compound (0 allowed)
  source              text NOT NULL CHECK (source IN ('fit','additive')),
  PRIMARY KEY (session_id, driver_id, compound),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Cross-season per-circuit hazards and pit-loss fallback (A.7, A.8). Rewritten entirely by strategy.recompute_circuits(conn).
CREATE TABLE circuit_hazards (
  circuit_key         integer PRIMARY KEY REFERENCES circuits(circuit_key),
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  races               integer NOT NULL,            -- ingested races at this circuit (status ok/partial, total_laps not null)
  green_laps          integer NOT NULL,            -- lap_status rows with worst_status in ('1','2')
  sc_periods          integer NOT NULL,            -- maximal runs of worst_status '4'
  vsc_periods         integer NOT NULL,            -- maximal runs of worst_status in ('6','7')
  sc_hazard           double precision NOT NULL,   -- smoothed per-green-lap onset probability
  vsc_hazard          double precision NOT NULL,
  pit_loss_median_s   double precision,            -- median of the per-race strategy_models.pit_loss_s at this circuit; NULL if none
  pit_loss_races      integer NOT NULL,
  recomputed_at       timestamptz NOT NULL DEFAULT now()
);

-- Global pools used as priors and for durations/factors. Exactly one row.
CREATE TABLE strategy_globals (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  races               integer NOT NULL,
  green_laps          integer NOT NULL,
  sc_periods          integer NOT NULL,
  vsc_periods         integer NOT NULL,
  sc_hazard           double precision NOT NULL,   -- raw global rate (the prior mean)
  vsc_hazard          double precision NOT NULL,
  sc_mean_len_laps    double precision NOT NULL,   -- mean run length of SC periods
  vsc_mean_len_laps   double precision NOT NULL,
  sc_factor           double precision NOT NULL,   -- median SC lap / median green lap, all races
  vsc_factor          double precision NOT NULL,
  recomputed_at       timestamptz NOT NULL DEFAULT now()
);
```

No index beyond the PKs: every read is by `session_id` (PK prefix) or `circuit_key` (PK).

The driver's ACTUAL strategy is NOT a new table: it is `stints` (compound, start_lap, end_lap) + `pit_stops` (lap_in) which already exist; the query (D) assembles it. The SC sequence for calibration is `lap_status`. Reusing them guarantees the editor's "reset" equals the gantt.

### B.2 Populating functions (Python owns every value)

| table | populated by | when |
|---|---|---|
| `strategy_models`, `strategy_compound_params`, `strategy_driver_params`, `strategy_driver_compound_params` | `f1lab.strategy.fit_race_model(laps_fc_all, lap_status_df, pit_stops_df, results_df, total_laps) -> StrategyFit`, translated in `frames.build_race_frames` under `_guard(status, "strategy_model", …)` | inside the per-session write transaction, after `pit_stops` and `lap_status` (they are inputs) |
| `circuit_hazards`, `strategy_globals` | `f1lab.strategy.recompute_circuits(conn, assumption_set_id)` — pure SQL + pandas over `lap_status`, `laps`, `strategy_models`, `events` | after the session loop of every run, next to `season.recompute` (also on `--recompute-season`, and via a new `--recompute-circuits`) |

`sc_factor` / `vsc_factor` on `strategy_models` use the race's own SC laps when it has ≥ 3, else the global value — but the global row may not exist yet on a fresh DB during the first run. Rule: `fit_race_model` receives `globals: StrategyGlobals | None` read by ingest.py at run start (`strategy.load_globals(conn)`); with `None` it uses config `SIM_SC_FACTOR_DEFAULT` = 1.4 / `SIM_VSC_FACTOR_DEFAULT` = 1.2 and `factor_source = 'global'`. Idempotency across ordering is preserved because the run-end `recompute_circuits` + a `--force` re-ingest converge (documented in RUNBOOK, same story as `mixed_assumption_sets`).

### B.3 `frames.py` additions (the contract lines)

```python
TABLE_COLUMNS["strategy_models"] = [("session_id","int"),("assumption_set_id","int"),("n_fit_laps","int"),
    ("n_drivers","int"),("reference_compound","text"),("evo_s_per_lap","float"),("evo_se","float"),
    ("resid_sd_s","float"),("r2","float"),("pit_loss_s","float"),("pit_loss_p25_s","float"),
    ("pit_loss_p75_s","float"),("pit_loss_n","int"),("sc_factor","float"),("vsc_factor","float"),
    ("factor_source","text")]
TABLE_COLUMNS["strategy_compound_params"] = [("session_id","int"),("assumption_set_id","int"),("compound","text"),
    ("laps","int"),("offset_s","float"),("offset_se","float"),("deg_s_per_lap","float"),("deg_se","float"),
    ("deg_clamped","bool")]
TABLE_COLUMNS["strategy_driver_params"] = [("session_id","int"),("assumption_set_id","int"),("driver_id","text"),
    ("laps_fit","int"),("base_s","float"),("noise_sd_s","float"),("laps_completed","int"),
    ("actual_total_s","float"),("actual_total_fc_s","float"),("actual_fuel_s","float"),("laps_with_time","int")]
TABLE_COLUMNS["strategy_driver_compound_params"] = [("session_id","int"),("assumption_set_id","int"),
    ("driver_id","text"),("compound","text"),("base_s","float"),("laps","int"),("source","text")]
TABLE_COLUMNS["circuit_hazards"] = [("circuit_key","int"),("assumption_set_id","int"),("races","int"),
    ("green_laps","int"),("sc_periods","int"),("vsc_periods","int"),("sc_hazard","float"),("vsc_hazard","float"),
    ("pit_loss_median_s","float"),("pit_loss_races","int"),("recomputed_at","timestamptz")]
TABLE_COLUMNS["strategy_globals"] = [("singleton","bool"),("assumption_set_id","int"),("races","int"),
    ("green_laps","int"),("sc_periods","int"),("vsc_periods","int"),("sc_hazard","float"),("vsc_hazard","float"),
    ("sc_mean_len_laps","float"),("vsc_mean_len_laps","float"),("sc_factor","float"),("vsc_factor","float"),
    ("recomputed_at","timestamptz")]

RACE_TABLE_ORDER += ["strategy_models", "strategy_compound_params", "strategy_driver_params",
                     "strategy_driver_compound_params"]      # appended AFTER track_status_events (FK order: parents first)
ANALYTICS += ["strategy_model"]                               # ONE status key for the four per-session tables
RENAMES["strategy_models"] = {...}                            # StrategyFit DataFrames already use DB names; identity map, kept for greppability
```

`EXPECTED_COLUMNS` is derived from `TABLE_COLUMNS`, so `db.assert_schema` immediately demands the six tables — `python -m f1lab.ingest --check-schema` fails until migration 0001 is applied, which is the intended gate (same as v1 WP1 Milestone 1). `delete_session_children` iterates `reversed(RACE_TABLE_ORDER)`, so the four per-session tables are cleaned on re-ingest with no further change; `circuit_hazards`/`strategy_globals` are `DELETE`+`COPY` inside `recompute_circuits`' own `_committed` block.

### B.4 Migration mechanics

1. Web owner writes `web/db/schema/strategy.ts` (six `pgTable`s, explicit snake_case names per §3.2, `check()` for the two text enums and the singleton), adds `export * from "./strategy";` to `web/db/schema/index.ts`.
2. `cd web && npx drizzle-kit generate --name strategy_sim` → `drizzle/0001_strategy_sim.sql` + `meta/0001_snapshot.json` + journal entry. Review the SQL against B.1 by eye (drizzle emits `CREATE TABLE` + `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`; that is fine).
3. `npm run db:migrate` (creates the six tables; `drizzle.__drizzle_migrations` gains row 2).
4. `python -m f1lab.ingest --check-schema` → exit 0 once C's `TABLE_COLUMNS` matches; it is the drift detector between the two languages.

## C. Python

### C.1 New module `f1lab/strategy.py` (pure functions on DataFrames; no DB except the two `conn` functions)

```python
@dataclass(frozen=True)
class StrategyGlobals:                      # mirror of the strategy_globals row; None on a fresh DB
    sc_factor: float; vsc_factor: float; sc_mean_len_laps: float; vsc_mean_len_laps: float
    sc_hazard: float; vsc_hazard: float

@dataclass
class StrategyFit:
    models: pd.DataFrame                    # 1 row, columns == EXPECTED_COLUMNS['strategy_models'] minus session_id/assumption_set_id
    compound_params: pd.DataFrame           # DB column names, 'compound' upper-case
    driver_params: pd.DataFrame             # keyed by 'Driver' (FastF1 code) — frames.py resolves to driver_id
    driver_compound_params: pd.DataFrame    # keyed by 'Driver', 'compound'
    warnings: list[str]

def fit_race_model(laps_fc_all: pd.DataFrame, lap_status: pd.DataFrame, pit_stops: pd.DataFrame,
                   results: pd.DataFrame, total_laps: int,
                   globals_: StrategyGlobals | None) -> StrategyFit:
    """A.2–A.9. laps_fc_all = fuel_correct(annotate_laps(session)) (the `fc` that _laps_frame already returns);
    lap_status/pit_stops = derive.lap_status(annotated) / derive.pit_stops(raw) (FastF1 column names).
    Raises ValueError (→ '_guard' → 'error: …') on rank deficiency; returns an EMPTY StrategyFit
    (models has 0 rows) when the A.10 minimums fail — the guard records 'empty'."""

def _fit_rows(laps_fc_all) -> pd.DataFrame            # is_representative & slick & TyreLife >= 2
def _design(rows) -> tuple[np.ndarray, list[str]]     # driver dummies, compound offsets (ref = modal compound), age×compound, lap
def _pit_loss(laps_fc_all, pit_stops, lap_status) -> tuple[float|None, float|None, float|None, int]   # A.7
def _sc_factors(laps_fc_all, lap_status, globals_) -> tuple[float, float, str]                        # race if >= 3 SC laps else global/config
def _calibration_truths(laps_fc_all, results) -> pd.DataFrame                                          # per Driver: sums of A.9

def load_globals(conn) -> StrategyGlobals | None      # SELECT from strategy_globals
def recompute_circuits(conn, assumption_set_id: int) -> None
    """DELETE + COPY circuit_hazards and strategy_globals from lap_status / laps / strategy_models / events / sessions
    (races with session_ingests.status in ('ok','partial') and total_laps NOT NULL). One _committed block
    (the same helper ingest.py uses; it moves to f1lab/db.py as db.committed so both modules import it —
    ingest.py keeps a one-line alias, no behaviour change)."""
```

`fit_race_model` uses `statsmodels.api.OLS` (pace.py already depends on statsmodels); parameter se from `bse`; residual sd per driver from `resid` grouped by `Driver`; clamping and the `source` flag exactly as A.3/A.4.

### C.2 Hook into `frames.build_race_frames` (the guard pattern, one owner: the Python package)

Signature grows one keyword with a default so every existing caller and test still works:

```python
def build_race_frames(session, ids, assumption_set_id, *, strategy_globals: strategy.StrategyGlobals | None = None) -> Frames:
```

Inside, after `pits`/`lstatus` are computed (they are inputs):

```python
    fit = _guard(status, "strategy_model",
                 lambda: strategy.fit_race_model(fc_all, lstatus, pits, session.results, session.total_laps,
                                                 strategy_globals)
                 if (lstatus is not None and pits is not None) else None)
    # _guard treats a StrategyFit whose .models is empty as 'empty' via a tiny extension: `len(df)` already works
    # on DataFrames; for StrategyFit define __len__ = len(self.models). No other change to _guard.
```
`fc_all` is the second element of `_laps_frame(...)`, currently discarded as `_`; it is now bound. Translation to the four cast frames follows the existing per-table block style (`_resolve(df["Driver"], d2i, "driver code")`, `_norm_compound`, `cast_frame(..., table)`; `empty_frame(table)` for every one of the four when `fit is None`). `warnings` from the fit (e.g. `strategy_model: SOFT degradation clamped from -0.012 to 0`) are appended to `Frames.warnings` so they show in the race page's assumptions block.

`ingest.py` changes (Python owner): `globals_ = strategy.load_globals(conn)` once at the top of `run_season` (after `assert_schema`), passed to `build_race_frames(..., strategy_globals=globals_)`; after the loop, next to `season.recompute`, `strategy.recompute_circuits(conn, asid)` in its own try/except with the same failure semantics (`final = 'failed'`, error `strategy.recompute_circuits: …`). New flag `--recompute-circuits` (no FastF1 loads; runs only `recompute_circuits`; `--recompute-season` does NOT imply it, they are orthogonal), added to `cli_args_json`. `dry_run` prints the `strategy_model` status like the others (no change: it already prints every non-ok key).

### C.3 `config.py` constants (all enter the assumption snapshot/hash automatically — `assumptions.snapshot()` takes every UPPER_CASE name)

```python
# Strategy simulator (v1.1) — every number here is read by strategy.py and copied, not re-derived, by the browser
SIM_MIN_LAPS_FIT = 200            # OLS rows needed for a race model
SIM_MIN_LAPS_COMPOUND = 30        # pooled age>=2 laps for a compound to be parameterised
SIM_MIN_LAPS_DRIVER = 8           # == pace_ranking min_laps; fewer -> driver has no params
SIM_MIN_LAPS_DRIVER_COMPOUND = 5  # source 'fit' vs 'additive'
SIM_MAX_WET_SHARE = 0.5           # > this share of INTERMEDIATE/WET representative laps -> no model
SIM_NOISE_SD_FLOOR = 0.3          # s; per-driver residual sd floor
SIM_NOISE_T_DF = 5                # Student-t degrees of freedom for lap noise (browser reads it from the payload)
SIM_MIN_GREEN_STOPS = 4           # race-level pit loss needs this many green stops, else circuit fallback
SIM_SC_PRIOR_PERIODS = 100        # pseudo-laps of global prior mixed into a circuit's hazard
SIM_SC_PIT_LOSS_FACTOR = 0.5      # pit loss multiplier when the stop lap is under SC/VSC
SIM_SC_FACTOR_DEFAULT = 1.4       # used only when strategy_globals does not exist yet (fresh DB, first run)
SIM_VSC_FACTOR_DEFAULT = 1.2
SIM_CALIBRATION_WARN_S = 15.0     # amber calibration badge threshold (also 1 % of total)
```
Adding them changes the assumption hash → the next ingest run creates `assumption_sets` row 2. Existing analytics rows keep row 1 until re-ingested; `seasons.mixed_assumption_sets` flips true, which is the v1 mechanism for "converge with --force" (RUNBOOK). `assumptions.CALL_SITE_PARAMS` gains `"strategy_fit_min_tyre_life": 2` and `"strategy_sc_min_laps_for_race_factor": 3`.

### C.4 Tests (`tests/test_strategy.py`, plus one case each in existing files)

- `test_fit_hungary_numbers(hungary_2024)` — no db: fit on the cached session; assert n_fit_laps == 1233, HARD deg in (0.075, 0.095), MEDIUM in (0.06, 0.08), evo < 0, r2 in (0.55, 0.7), pit_loss_s in (19, 21.5) with n == 39, reference_compound == 'HARD', SOFT parameterised (34 laps ≥ 30), every driver × 3 compounds present, `source` == 'additive' for drivers with < 5 SOFT laps.
- `test_fit_calibration_identity(any_session)` — `actual_total_s − actual_total_fc_s == actual_fuel_s` to 1e-6 per driver; `laps_with_time <= laps_completed + 1`.
- `test_fit_synthetic_recovers_params()` — generate 20 drivers × 60 laps from the A.1 equation with known β, deg, evo; assert recovery within 2 se and that a negative injected deg is clamped with `deg_clamped`.
- `test_fit_empty_on_rain()` — synthetic frame with 80 % INTERMEDIATE → empty fit; `test_guards.py` gains `strategy_model` raising `ValueError` → `analytics_status['strategy_model']` starts with `error:` and the session is `partial` with the four tables empty.
- `test_schema_contract.py` — already compares `EXPECTED_COLUMNS` to the live DB; it covers the six tables once 0001 is applied (db-marked).
- `test_recompute_circuits(db_conn)` — after `--force` of 2024: `circuit_hazards` has one row per circuit with ≥ 1 race, `strategy_globals` has exactly one row, `0 < sc_hazard < 0.1`, `sc_mean_len_laps` in (3, 9), `sc_factor` in (1.2, 1.8).
- `test_ingest_cli.py` — `--recompute-circuits` exit 0 and rewrites `recomputed_at`; `--check-schema` fails on a DB without 0001 (skip if applied — or use the existing "missing table" monkeypatch style).

### C.5 Recompute path

No new flag for the per-race fit: `python -m f1lab.ingest --season Y --force` is the (idempotent) way to (re)compute the four per-session tables — it is ~1 min for all three seasons from cache and is already the documented way to converge assumption sets. `--recompute-circuits` exists because the cross-season tables must be refreshed after a partial ingest (e.g. one `--round`) without re-loading anything; `run_season` always ends with it. Order of operations for the first v1.1 deployment: migrate 0001 → `--check-schema` → `--season 2024 --force`, `2025 --force`, `2026 --force` (the third run's `recompute_circuits` sees every race) → done; a second `--force` pass would only change `sc_factor` of races whose `factor_source = 'global'` from the config default to the global row value — documented, and the calibration line makes it visible.

## D. Query + client contract

One export, one payload, in a NEW file `web/lib/queries/strategy.ts` (so `race.ts` is not touched by v1.1 — see G). It follows the §3.3 rules: async, primitives in, plain JSON-serialisable object out, `DriverRef`/`ColourMap` from `shared.ts`, nothing computed that Python did not store (the only "computation" is `COALESCE` for the pit-loss fallback and assembling stints into a strategy).

```ts
// web/lib/queries/strategy.ts
import type { DriverRef } from "@/lib/queries/shared";

export type SimCompoundParams = {
  compound: string;            // upper-case, open vocabulary (§8.1)
  compoundColour: string;      // compound_colours, UNKNOWN fallback
  laps: number;
  offsetS: number;             // β_c
  degSPerLap: number;          // clamped >= 0
  degSe: number;
  degClamped: boolean;
};

export type SimStint = { compound: string; startLap: number; endLap: number };   // contiguous, endLap inclusive; pit stop = between stint i and i+1 at endLap
export type SimStrategy = { stints: SimStint[] };                                  // the editable value; the actual one comes from `stints`

export type SimDriver = DriverRef & {
  lapsFit: number;
  baseS: number;                                   // β_d
  noiseSdS: number;
  baseByCompound: Record<string, { baseS: number; laps: number; source: "fit" | "additive" }>;   // only parameterised compounds
  actual: SimStrategy;                             // from stints ORDER BY start_lap; first startLap may be > 1 (§0.3)
  actualPitLaps: number[];                         // pit_stops.lap_in ORDER BY stop_number (for the editor's reset + lap validation)
  lapsCompleted: number;                           // results.laps_completed
  finishPosition: number | null;
  calibration: { actualTotalS: number; actualTotalFcS: number; actualFuelS: number; lapsWithTime: number };
};

export type SimUnavailableDriver = DriverRef & { reason: "too_few_laps" | "no_stints" };

export type SimRaceModel = {
  sessionId: number;
  totalLaps: number;
  referenceCompound: string;
  evoSPerLap: number;
  residSdS: number;
  r2: number;
  nFitLaps: number;
  pitLoss: { medianS: number; p25S: number; p75S: number; n: number; source: "race" | "circuit" };
  sc: {
    hazard: number; vscHazard: number;           // circuit_hazards (smoothed) — NOT the raw global
    meanLenLaps: number; vscMeanLenLaps: number; // strategy_globals
    factor: number; vscFactor: number; factorSource: "race" | "global";
    pitLossFactor: number;                       // assumption_sets.params.SIM_SC_PIT_LOSS_FACTOR
    circuitRaces: number; circuitPeriods: number; // for the caption ("3 races, 2 SC periods at this circuit")
  };
  noiseTDf: number;                              // assumption_sets.params.SIM_NOISE_T_DF
  calibrationWarnS: number;                      // assumption_sets.params.SIM_CALIBRATION_WARN_S
  lapStatus: ("G" | "V" | "S" | "R")[];          // index = lapNumber − 1, from lap_status.worst_status ('4'→S, '6'|'7'→V, '5'→R, else G); the REAL race for calibration
  compounds: SimCompoundParams[];                // parameterised, ORDER BY offset_s (fastest first)
  drivers: SimDriver[];                          // ORDER BY finish position NULLS LAST (same order as getStints.order)
  unavailable: SimUnavailableDriver[];
  assumptionSetId: number;
};

export type SimPayload =
  | { status: "ok"; model: SimRaceModel }
  | { status: "unavailable"; reason: string };   // analytics_status.strategy_model text, or 'strategy model not computed for this race (re-ingest with --force)' when the key is absent

export async function getStrategyModel(sessionId: number): Promise<SimPayload>;
```

Query plan (one round trip per table, `Promise.all`, all keyed by `session_id`): `strategy_models` (→ `unavailable` if no row: read `session_ingests.analytics_status->>'strategy_model'` for the reason); `strategy_compound_params`; `strategy_driver_params` JOIN `session_entries`/`drivers`/`session_teams` (the same select shape `getStints` uses for `DriverRef`); `strategy_driver_compound_params`; `stints`; `pit_stops`; `results`; `lap_status`; `compound_colours`; `circuit_hazards` via `sessions → events.circuit_key`; `strategy_globals`; `assumption_sets.params` for the three constants (read from `strategy_models.assumption_set_id`, so the browser sees the constants the fit actually used, not the current config). `pitLoss` = race row when `pit_loss_s IS NOT NULL` else `circuit_hazards.pit_loss_median_s` with `p25/p75 = median ∓ 2` (a stated default spread) and `source: 'circuit'`; if both NULL → `unavailable` with reason `no green-flag pit stops at this circuit`.

Drivers with a `strategy_driver_params` row but zero `stints` rows go to `unavailable` (`no_stints`); entries with no params row → `too_few_laps`.

The component (`'use client'`) receives the whole `SimPayload` as a prop from the server page (RSC serialisation, like every other section — §8.4 notes the page is already 500–700 KB; this adds the estimate below and no new fetch path).

### Byte estimate (22 cars, 70 laps, 3 compounds, JSON before RSC framing)

| part | size |
|---|---|
| race scalars + `sc` + `pitLoss` | ~0.6 KB |
| `lapStatus` (70 × `"G",`) | ~0.3 KB |
| `compounds` (3 × ~150 B) | ~0.5 KB |
| `drivers`: DriverRef (~180 B) + scalars (~150 B) + `baseByCompound` (3 × ~60 B) + `actual` (3 stints × ~50 B) + `actualPitLaps` + `calibration` (~120 B) ≈ 800 B × 22 | ~17.6 KB |
| `unavailable` | < 0.5 KB |
| **total** | **≈ 20 KB** (≈ 25 KB after RSC quoting) — 3–5 % of the current page |

The `RaceTrace` payload (22 × 70 × 2 numbers) is 10× larger, so the addition is immaterial; no separate route handler needed.

## E. Browser algorithm (`web/lib/sim/engine.ts`, pure TypeScript, no React, unit-testable with vitest/tsx)

Prototype benchmarked in Node 22 (`output/_bench_sim.mjs`, the exact loop below with closures and no typed-array tricks): N = 4000 draws × 70 laps × 2 strategies = 87 ms average (117 ms cold). Target N = 4000 (≤ 150 ms on a laptop, ≤ 400 ms on a phone); no web worker needed (fixed decision 2). Monte-Carlo se of the median delta at N = 4000 with delta sd ≈ 5 s is ≈ 0.1 s — below the display precision.

### E.1 Inputs

`SimRaceModel` (D) + `driverId` + `edited: SimStrategy` + `seed: number` (default `sessionId * 1000 + driverIndex`, so results are reproducible and the "Run again" control bumps it).

### E.2 PRNG and distributions

`mulberry32(seed)` — 32-bit, ~10 lines, period 2³², uniform in [0,1). Gaussian by Box–Muller (both outputs used); Student-t(ν) = `gauss / sqrt(chisq(ν)/ν)` with `chisq(ν)` = sum of ν squared gaussians (ν = `noiseTDf` = 5 from the payload). All random numbers come from ONE stream in a FIXED consumption order per draw (below) so the edited and actual strategies read identical values — common random numbers — regardless of how many stops either has (pit-loss draws are pre-drawn for `SIM_MAX_STOPS` = 5 stops per draw before the lap loop).

### E.3 Strategy → per-lap plan (once per strategy, O(totalLaps))

```
plan(strategy):  comp[L], age[L] for L = 1..totalLaps; pitAt = Set(endLap of every stint but the last)
  age[L] = L − startLap + 1 within its stint  (age 1 = out-lap; A.7 folds its cost into pit loss, so the
  degradation term uses (age − 1) and the out-lap costs base + 0·deg + pit loss)
  laps before the first stored stint (§0.3: NaN stint) inherit the first stint's compound with age counted from lap 1
```

### E.4 One draw (pseudocode)

```
draw(i):
  deg[c]   = max(0, model.deg[c] + model.degSe[c] · gauss())          for each parameterised compound (consumed in compounds order)
  pitDraw[k] = gauss()                                                  k = 0..SIM_MAX_STOPS−1
  state[L] : shared SC sequence, L = 1..totalLaps:
      L = 1; while L ≤ totalLaps:
        u = uniform()
        if u < sc.hazard:            len = 1 + floor(Exp(mean = sc.meanLenLaps − 1)); state[L..L+len−1] = SC;  L += len
        elif u < hazard + vscHazard: len = 1 + floor(Exp(mean = vscMeanLenLaps − 1)); state[..] = VSC;        L += len
        else state[L] = GREEN; L += 1
  tA = tE = 0
  for L in 1..totalLaps:
      eps = studentT(ν) · driver.noiseSdS                              ONE draw, used by both strategies
      for P in (actual, edited):
          c = P.comp[L]; a = P.age[L]
          t = driver.baseByCompound[c].baseS + deg[c]·(a−1) + model.evoSPerLap·L
          t = state[L]==SC ? t·sc.factor : state[L]==VSC ? t·sc.vscFactor : t + eps      -- no noise under SC/VSC (the field is bunched; A.1)
          if L in P.pitAt: t += (pitLoss.medianS + pitDraw[P.stopIndex++] · pitSd) · (state[L] != GREEN ? sc.pitLossFactor : 1)
          total[P] += t
      gapE[i][L] = tE − tA                                              cumulative edited − actual after lap L
  delta[i] = tE − tA
```
`pitSd = (p75S − p25S) / 1.349` (IQR → sd). Note the pit loss is attached to the in-lap `L = endLap` (the stint's last lap); the out-lap is `L+1` with age 1.

Laps the driver did not complete in reality (`lapsCompleted < totalLaps`, DNF) are still simulated to `totalLaps` for BOTH strategies — the question is hypothetical anyway — and the caption says the driver retired on lap N.

### E.5 Outputs

```ts
export type SimResult = {
  n: number; seed: number;
  deltaS: { median: number; p10: number; p90: number; mean: number };   // edited − actual, seconds; negative = edited faster
  pBetter: number;                                                       // fraction of draws with delta < 0
  histogram: { binEdges: number[]; counts: number[] };                   // 40 bins over [p1, p99]
  perLap: { lap: number; median: number; p10: number; p90: number }[];   // cumulative gap after each lap, from gapE
  calibration: SimCalibration;
  elapsedMs: number;
};
```
Quantiles: sort a copy of `delta` (Float64Array, 4000 elements) — O(N log N), < 1 ms; per-lap quantiles: 70 sorts of 4000 → ~15 ms (fine; or a partial-select if profiling says so). P(better) counts `delta < 0`.

### E.6 Calibration run (fixed decision 6)

```
calibrate(model, driver):
  plan = plan(driver.actual); state[L] = model.lapStatus[L−1] (REAL sequence, R treated as SC); deg = point estimates; eps = 0;
  pit loss = medianS at every actual pit lap (× pitLossFactor if the real lap was not green)
  simFcS   = Σ_{L=1}^{driver.lapsCompleted} t(L)                         -- fuel-corrected, deterministic
  simS     = simFcS + driver.calibration.actualFuelS                       -- re-add the real fuel penalty sum (A.1)
  return { simS, actualS: driver.calibration.actualTotalS, diffS: simS − actualS, diffPct: 100·diffS/actualS,
           lapsCompared: driver.lapsCompleted, warn: |diffS| > model.calibrationWarnS || |diffPct| > 1 }
```
Deterministic (no draws) so it is the same number on every run and every device — "the model, given the real safety cars and the real strategy, predicts a race time X s off the truth". Because the model is fitted on the driver's own representative laps, the discrepancy mostly measures what representative-lap filtering removed: traffic, the laps behind a slower car, damage. That is the honest number the caption points at.

### E.7 Complexity

Per run: O(N · totalLaps · 2) lap evaluations + O(N · maxStops) + sorts. N = 4000, 70 laps: 560 k lap evaluations, ~90 ms measured; memory: `delta` 32 KB + `gapE` N × totalLaps × 8 B = 2.2 MB (Float64Array, allocated once per run, released after quantiles). A 78-lap race (Monaco) is +11 %. If a phone profile shows > 400 ms, the first lever is N = 2000 (se of the median doubles to ~0.15 s, still fine), not a worker.

## F. UI spec

### F.1 Placement and composition

New `SECTIONS` entry `{ id: "simulator", title: "Strategy simulator" }` between `degradation` and `trace` (fixed decision 4, default slot kept: the fan has just seen the degradation slopes the simulator uses, and the race trace afterwards shows what actually happened to the gaps). In `page.tsx`: `getStrategyModel(id)` joins the existing `Promise.all`; the section renders

```tsx
<Section id="simulator" title="Strategy simulator" caption="What if they had pitted on lap 22? Edit one driver's strategy and simulate it against what they actually did — clean air only.">
  <SimulatorSection payload={sim} colours={colours} year={year} reason={reasonFor(status, "strategy_model")} />
</Section>
```
`SimulatorSection` (server component, `components/race/SimulatorSection.tsx`) renders `<EmptyState title="No strategy model for this race" reason={payload.reason ?? reason} />` when `payload.status !== 'ok'`, else `<StrategySimulator model={payload.model} colours={colours} />` — the `'use client'` component in `components/sim/StrategySimulator.tsx`. Charts stay in `components/charts/` (`DeltaHistogram.tsx`, `LapDeltaBand.tsx`) with structural props, per §3.1.

### F.2 Driver selector

`<select>` of `model.drivers` in finish order, labelled `P{n} CODE — Team`; `unavailable` drivers appear disabled with `(too few clean laps)` / `(no stint data)`. Default = winner (first driver in the list; `finishPosition === 1` if present). Changing the driver resets the editor to that driver's `actual`, resets the seed, and re-runs.

### F.3 Stint editor (state: `SimStrategy` + `seed`)

Rendered as a table, one row per stint:

| # | Compound (`<select>` of `model.compounds`, chip-coloured, `source` badge `fit`/`est.` from `driver.baseByCompound`) | Start lap (read-only = previous end + 1; first = actual first startLap) | End lap (`<input type=number>`; last stint read-only = totalLaps) | Laps (derived) | Remove (disabled when 1 stint) |

Controls under the table: **Add stop** (splits the longest stint at its midpoint, same compound), **Reset to actual**, presets: **One-stop** (two stints: current first compound → the hardest parameterised compound at the actual first pit lap, or lap ⌊totalLaps/2⌋ if none), **Pit 3 laps earlier / later** (shifts every stop; disabled at the bounds). `SIM_MAX_STOPS` = 5 stops (6 stints).

Validation (inline error text, run button disabled while invalid): stints contiguous and cover `[firstLap, totalLaps]`; each stint ≥ `SIM_MIN_STINT_LAPS` = 2 laps; end laps strictly increasing; a compound must be in `model.compounds` (the select cannot offer others, so this only guards a stale URL state). No "two compounds" rule — it is a regulation, not a model constraint, but a muted note says when the edited strategy uses a single compound.

Editor state is mirrored into the URL hash (`#sim=VER;M1-22,H23-70;s=42`) so a result can be shared; parsed only for the current race and validated as above.

### F.4 Run control

Runs automatically (debounced 150 ms) on every valid edit — the engine is ~90 ms. A **Re-roll** button increments the seed (label shows `seed 12345 · 4000 draws · 92 ms`). No spinner beyond an `aria-busy` on the results while computing; the page never blocks.

### F.5 Result cards (`StatTile` × 4)

1. **Median gain / loss** — `fmtSigned(−deltaS.median, 1, ' s')` framed as gain: positive number + "faster" when the edited strategy's median delta is negative; hint `p10 … p90: −8.4 … +2.1 s`.
2. **P(edited strategy faster)** — `fmtPct(100·pBetter, 0)`; hint "of 4,000 paired simulations".
3. **Extra pit stops** — `edited.stints.length − actual.stints.length`, hint `pit loss ≈ {pitLoss.medianS 1dp} s ({source === 'circuit' ? 'circuit history' : 'this race'})`.
4. **Calibration** — `fmtSigned(calibration.diffS, 1, ' s')` with hint `model vs real race time over {lapsCompared} laps ({diffPct 2dp} %)`; amber border when `warn`.

### F.6 Charts

**DeltaHistogram** (`components/charts/DeltaHistogram.tsx`, props `{ binEdges, counts, median, p10, p90 }`): ECharts `bar` on a `category` x-axis of bin centres formatted `+1.5 s`, `barCategoryGap: 0`, colour accent for bins < 0 (edited faster) and muted for ≥ 0; `markLine` at the median (labelled) and dashed at p10/p90; x-axis name "Edited − actual race time (s) · negative = edited faster"; y-axis "draws". Height 260.

**LapDeltaBand** (`components/charts/LapDeltaBand.tsx`, props `{ perLap, actualPitLaps, editedPitLaps, totalLaps }`): three `line` series over `lap` — p10 (stacked band trick: `p10` transparent + `p90 − p10` filled with accent at 18 % opacity, `stack: 'band'`) and the median in full accent, width 2; y-axis "Cumulative gap to actual strategy (s)" `inverse: true` (ahead = up, matching the race trace's convention); `markLine` verticals at each `actualPitLaps` (muted, label "actual pit") and `editedPitLaps` (accent, "edited pit"); tooltip `Lap 31 · median −4.2 s (p10 −7.9, p90 −0.8)`. Height 320.

### F.7 Calibration line (verbatim, rendered under the tiles, `text-sm`)

"Calibration: given {CODE}'s real strategy and the real safety-car laps, the model predicts a race time of {simS} against the actual {actualS} — a discrepancy of {diffS} ({diffPct}) over {lapsCompared} laps. That difference is everything the clean-air model does not know about: traffic, damage, lift-and-coast, wet laps." Amber variant appends: "That is larger than {calibrationWarnS} s or 1 %: treat the numbers below as indicative only."

### F.8 Caption (verbatim, via `<Caption>` under the section)

"Both strategies are simulated {n} times under the same race model with the same random numbers, so the difference is the strategy's and nothing else's. The model is a per-race fit to this race's representative laps: driver pace at fresh tyre, one degradation slope per compound ({compound list with ± se; '(clamped to 0)' where degClamped}), track evolution of {evo 3dp} s/lap, and lap noise of {noiseSd 2dp} s for {CODE}. Pit loss {pitLoss.medianS 1dp} s from {n} green-flag stops {'in this race' | 'at this circuit in other seasons'}; safety cars appear at {hazard×100 2dp} % per lap from {circuitRaces} races at this circuit ({circuitPeriods} periods, smoothed towards the all-race average). Fuel is not simulated: it costs both strategies the same seconds lap for lap and cancels exactly. Traffic, blue flags, overtaking and tyre-warm-up are not modelled — this answers how many seconds a strategy would have gained or lost in clean air, never whether they would have finished ahead of anyone. Compounds the driver never raced use the field's compound offset ('est.'). {'CODE retired on lap N; both strategies are simulated to the flag.' when lapsCompleted < totalLaps} Assumption set #{id}."

### F.9 Accessibility and empty states

Every chart container `role="img"` with an `aria-label` summarising the median and P(better); the tiles are the primary readout so the result is available without the canvas. When the selected driver has fewer than 2 parameterised compounds in `baseByCompound` (cannot happen: additive rows cover every compound) the editor still works. If the browser lacks `Float64Array` (it does not) — no fallback.

## G. Work breakdown and file ownership

Four packages. Each file below has EXACTLY ONE owner for the whole of v1.1; anyone else needing a change in it files a one-line request to the owner. Files not listed are untouched.

| file | owner | change |
|---|---|---|
| `web/db/schema/strategy.ts` (new) | **WP-S0 schema** | six `pgTable`s (B.1) |
| `web/db/schema/index.ts` | **WP-S0 schema** | one `export *` line |
| `web/drizzle/0001_strategy_sim.sql`, `web/drizzle/meta/*` | **WP-S0 schema** | generated by drizzle-kit, reviewed against B.1 |
| `f1lab/strategy.py` (new), `tests/test_strategy.py` (new) | **WP-S1 python** | C.1, C.4 |
| `f1lab/frames.py` | **WP-S1 python** | B.3 `TABLE_COLUMNS`/`RACE_TABLE_ORDER`/`ANALYTICS`/`RENAMES`; C.2 hook and translation blocks |
| `f1lab/config.py` | **WP-S1 python** | C.3 constants (append only) |
| `f1lab/assumptions.py` | **WP-S1 python** | two `CALL_SITE_PARAMS` keys |
| `f1lab/ingest.py`, `f1lab/db.py` | **WP-S1 python** | `load_globals`, `recompute_circuits` call, `--recompute-circuits`, `db.committed` move |
| `tests/test_guards.py`, `tests/test_ingest_cli.py`, `tests/test_schema_contract.py` | **WP-S1 python** | added cases only |
| `web/lib/queries/strategy.ts` (new) | **WP-S2 web-data** | D — the single query + exported types |
| `web/lib/sim/engine.ts`, `web/lib/sim/prng.ts`, `web/lib/sim/plan.ts` (new), `web/lib/sim/__tests__/engine.test.ts` (new) | **WP-S2 web-data** | E |
| `web/components/charts/DeltaHistogram.tsx`, `web/components/charts/LapDeltaBand.tsx` (new) | **WP-S3 web-ui** | F.6 |
| `web/components/sim/StrategySimulator.tsx`, `web/components/sim/StintEditor.tsx`, `web/components/sim/ResultTiles.tsx` (new) | **WP-S3 web-ui** | F.2–F.5, F.7–F.9 |
| `web/components/race/SimulatorSection.tsx` (new) | **WP-S3 web-ui** | F.1 server wrapper |
| `web/app/race/[year]/[round]/page.tsx` | **WP-S4 integration** | import, `Promise.all` entry, `SECTIONS` entry, the `<Section>` block (≤ 15 lines) |
| `web/lib/queries/race.ts` | **nobody** (frozen in v1.1; the new query lives in `strategy.ts`) | — |
| `web/package.json` | **WP-S2 web-data** | `vitest` devDependency + `"test": "vitest run"` (only if not already present; tsx-based `node --test` is the fallback that adds nothing) |
| `docs/SPEC.md` (§9 "v1.1 strategy simulator" appendix), `docs/RUNBOOK.md`, `Makefile` (`recompute-circuits` target) | **WP-S4 integration** | after everything lands |

### G.1 Sequencing

```
WP-S0 schema (½ day, SEQUENTIAL FIRST): strategy.ts → generate 0001 → migrate on the local DB → commit.
        Gate: `docker exec f1-postgres psql -U f1 -d f1 -c '\d strategy_models'` shows B.1; `npm run typecheck` clean.
   ├── WP-S1 python (2 days) — starts as soon as B.1 DDL is agreed (can start on day 0 against the DDL text; the DB
   │       gate is `--check-schema` exit 0 once S0 has migrated).
   ├── WP-S2 web-data (1.5 days) — starts on day 0 against D's types (the types are defined by this proposal, not by data).
   └── WP-S3 web-ui (2 days) — starts on day 0 against D's `SimRaceModel` type and E's `SimResult` type, using a
           hand-written fixture payload (`web/lib/sim/__fixtures__/hungary2024.json`, values copied from A.2's numbers).
WP-S4 integration (½ day): page.tsx wiring, `--force` re-ingest of all seasons, browser check, docs.
```

### G.2 What the web package builds before the Python data lands

Everything except the live query result: WP-S2 writes `engine.ts` + tests against synthetic `SimRaceModel` objects (parameter-recovery test: with `noiseSdS = 0`, `degSe = 0`, no SC, the delta of "pit 5 laps later on the same compound" must equal the closed-form `deg · (5·(L_stint2 − 5) − 5·…)` — a deterministic identity; a CRN test: `seed` fixed, `edited == actual` → every draw's delta is exactly 0 and `pBetter = 0`). WP-S3 renders `StrategySimulator` from the fixture JSON in a scratch route `app/dev/sim/page.tsx` (deleted by WP-S4, never committed) or Storybook-less: a Node script with ECharts' SVG renderer as WP4 did in v1. `getStrategyModel` compiles against the Drizzle schema from day 0 (S0) and returns `{ status: 'unavailable' }` until S1's rows exist — the page composes either way.

### G.3 Per-package verification commands

- **S0**: `cd web && npm run db:generate -- --name strategy_sim && npm run db:migrate && npm run db:check && npm run typecheck`; `make psql SQL="\d strategy_globals"`.
- **S1**: `.venv/bin/python -m f1lab.ingest --check-schema` (exit 0); `.venv/bin/pytest tests/test_strategy.py tests/test_frames.py tests/test_guards.py -q`; `.venv/bin/python -m f1lab.ingest --season 2024 --round 13 --force` then `make psql SQL="select * from strategy_models where session_id=16"` (pit_loss ≈ 20.2, n = 39); `--season 2024 --force` twice and hash-compare the six tables (idempotency, the v1 WP2 method); `--recompute-circuits` exit 0; full `.venv/bin/pytest -q` ≥ 135 + new passing.
- **S2**: `cd web && npx vitest run lib/sim` (engine identities, CRN, quantiles, timing < 300 ms in CI); `npm run typecheck`; after S1: `npx tsx -e "import('./lib/queries/strategy').then(m=>m.getStrategyModel(16)).then(p=>console.log(JSON.stringify(p).length, p.status))"` → ~20 KB, `ok`.
- **S3**: `npm run typecheck && npm run lint`; fixture render script produces an SVG with the four tiles' text and both charts; manual: editor validation states.
- **S4**: `python -m f1lab.ingest --season {2024,2025,2026} --force` (~1 min from cache) → `strategy_models` row count == races with a model (expect ≥ 60 of 71; rain races empty); `npm run build` clean; open `/race/2024/13`, pick VER, add a stop, see `P(better)` update, calibration diff < 15 s for the winner; console clean; `/race/2026/6` (red flag) renders the section or the EmptyState without error.

## H. Risks (top 5)

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | **Model misspecification** — linear degradation with one pooled slope per compound, no cliff, no warm-up beyond the out-lap, no traffic: a one-stop hard stint of 48 laps is extrapolated from fits whose max age is ~35. The tool then reports a confident "−20 s" that the real tyre would never have delivered. | High / high — it is the whole feature. | (a) The calibration line (A.9, F.7) is computed on the driver's REAL strategy with the REAL SC laps, so a model that cannot reproduce the real race is exposed before the fan edits anything; the amber threshold is a stored constant, not a UI guess. (b) `deg_se` is sampled per draw, so long extrapolations widen p10–p90 and lower P(better) toward 0.5 instead of lying with a point estimate. (c) The caption states every unmodelled effect verbatim (F.8). (d) Tyre age beyond the fit's observed `x_max` per compound (available from `compound_degradation`) is flagged in the editor as "beyond observed age (max N laps)" — a one-line addition to `SimCompoundParams` (`maxAgeObserved`) if the reviewers want it; recommended. |
| 2 | **Python/TypeScript drift** — a constant, column name or sign convention differs between the fit and the engine (e.g. age−1 vs age; pit loss attached to in-lap vs out-lap; SC factor multiplicative vs additive). | Medium / high — silently wrong numbers. | Every constant the browser uses travels in the payload from `assumption_sets.params` of the fitted row (D), never from a web constant; `TABLE_COLUMNS` ↔ Drizzle checked by `--check-schema` and `test_schema_contract.py`; the engine's deterministic identities (G.2) are also computed in `tests/test_strategy.py` from the same formula in Python for Hungary 2024 VER's actual strategy (`sim_fc_total` stored NOWHERE — computed in the test) and the numbers are pasted into the vitest fixture as expected values, so the two implementations must agree to 1e-6 on one real race. |
| 3 | **Ingest-order dependence / idempotency** — cross-season hazards and the `sc_factor` fallback depend on what else is ingested; `--force` of one season changes another season's `circuit_hazards`. | Medium / medium. | Cross-season values live ONLY in the two run-end tables rewritten from stored rows (B.2), never inside per-session rows except `sc_factor` with an explicit `factor_source`; RUNBOOK documents the three-season `--force` order and that a second pass converges; the idempotency hash test (G.3 S1) covers the per-session tables. |
| 4 | **Assumption-set churn** — adding 13 config constants creates assumption set #2 and marks every season `mixed_assumption_sets` until re-ingested; a partial re-ingest leaves v1 analytics on #1 and strategy rows on #2. | Certain / low. | This is v1's designed mechanism (RUNBOOK "what happens when a constant changes"); WP-S4 re-ingests all three seasons (~1 min) so the DB is single-set again; the payload carries `assumptionSetId` and the caption prints it. |
| 5 | **Rain / red-flag / short races produce no model or a bad one** (2026 R6 red flag, wet 2024/2025 rounds; races with < 200 fit rows). | Certain for some races / low if handled. | A.10 minimums → `analytics_status.strategy_model = 'empty'` → `<EmptyState reason>`; red laps in `lapStatus` are treated as SC only in the calibration run and the caption says the race was red-flagged; `test_fit_empty_on_rain` and the S4 check on `/race/2026/6` cover the paths; the section never throws — same contract as every v1 section. |

Runner-up: browser performance on phones (E.7: N = 2000 lever before any worker), and the RSC payload growth (D: ~25 KB, immaterial next to the trace).

