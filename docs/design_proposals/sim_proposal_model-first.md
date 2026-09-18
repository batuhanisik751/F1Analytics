# F1 Analytics v1.1 — Monte Carlo Strategy Simulator (model-first proposal)

Angle: design from the statistical model outward. Every parameter below was fitted on real laps from the v1 database (scratch scripts in `output/`), and the numbers quoted are what those fits returned.

## Outline
- A. The race model
- B. Schema
- C. Python
- D. Query + client contract
- E. Browser algorithm
- F. UI spec
- G. Work breakdown
- H. Risks

## A. The race model

Scratch scripts: `output/mc_fit_model.py`, `mc_ident.py`, `mc_pitloss.py`, `mc_sc.py`, `mc_calib.py`, `mc_calib2.py`, `mc_decomp.py` (all read the live DB via psycopg; nothing written to the project).

### A.1 Lap-time model (fuel-corrected seconds)

For driver d, compound c, tyre age a (= `tyre_life`, 1 on the out-lap), lap L:

```
t_fc(d, c, a, L) = base_d + off_c + dc_{d,c} + deg_c · (a − 1) + evo · (L − 1) + δ_L + ε_{d,L}
```

| Term | Meaning | Estimator (rows from `laps` of this session) |
|---|---|---|
| `base_d` | driver's clean-air pace on the reference compound at age 1, lap 1 | OLS driver dummy (no global intercept), fitted jointly with everything below on **representative slick laps**: `is_representative AND tyre_life >= 2 AND compound IN (parameterised set)` |
| `off_c` | pooled compound offset vs the reference compound (the compound with most representative laps; `off_ref = 0`) | OLS dummy in the same fit |
| `dc_{d,c}` | driver×compound deviation, **partially pooled** | mean OLS residual of driver d on compound c × `n/(n + K_DC)`, `K_DC = 10` laps. Zero (pure pooled offset) when the driver never ran c — this *is* the fallback, and the payload flags it (`dcLaps = 0`) so the UI can say "pace on HARD is the field's offset, not Norris's" |
| `deg_c` | degradation, s per lap of age, pooled per compound | OLS slope on `(tyre_life − 1)` in the same fit. Requires ≥ `MIN_COMPOUND_LAPS_FOR_SIM = 30` representative laps on c, else c is **not parameterised** (not selectable in the editor). Negative slopes are kept as fitted (they happen: 2026 R1 MEDIUM −0.02 ± 0.01) but clamped at `DEG_FLOOR = −0.05` s/lap and flagged `degNegative`; the clamp exists to stop an absurd "run the stint forever" answer, the flag exists so the caption can say the compound barely degraded in the data |
| `evo` | track evolution, s per lap | same fit, with a ridge pseudo-observation `evo ~ N(0, EVO_PRIOR_SD = 0.01)`; **needed** because when the whole field pits on the same laps, age and lap number are collinear (2025 R13: condition number 4e17, OLS gives deg −8.9 / evo +8.9; the ridge returns deg −0.006 / evo 0.000). On well-conditioned races (cond 400–1100) the ridge moves nothing (2026 R7: ridge −0.0134 vs OLS −0.0137) |
| `δ_L` | field-wide slowdown on lap L (SC, VSC, red-flag restart, rain shower) | median over the field of `lap_time_fc_s − model` on non-pit laps of lap L (all drivers, representative or not), 0 on lap 1 and where fewer than 3 cars; stored per lap. Shared by both strategies at the same lap number → **cancels in the delta**; used for the calibration and for "as it happened" pit-loss reduction |
| `ε_{d,L}` | lap noise | per-driver robust sd `sd_d = 1.4826·MAD(residuals of d)`; the residuals are heavy-tailed and right-skewed (excess kurtosis 3–7, skew 1.3–1.8, 1.5–2.5 % beyond 3σ), so the draw is `sd_d · t_ν` with `NOISE_T_DF = 4`, not Gaussian. Drawn **once per (draw, lap)** and shared by both strategies (common random numbers) — a lap that was slow because of a moment is slow in both worlds |

Fuel: simulated entirely in fuel-corrected time. The fuel term `fuel_penalty_s(L)` depends only on L and `total_laps`, so it is identical for the edited and the actual strategy on every lap and cancels exactly in the delta. The calibration compares fuel-corrected totals on both sides, so it cancels there too; the absolute number shown to the fan is the real `Σ lap_time_s` and the sim's `Σ (t_fc + fuel_penalty_s)`.

Numbers the fit returned (representative slick laps, ridge on evo):

| Race | n | comps | resid sd (OLS / MAD) | deg S / M / H (s/lap ± se) | evo | per-driver sd median |
|---|---|---|---|---|---|---|
| 2024 R13 Hungary | 1233 | S,M,H | 0.748 / 0.558 | 0.002±0.036 / 0.069±0.006 / 0.084±0.003 | −0.004 | 0.50 |
| 2025 R6 Miami | 539 | M,H (SOFT < 30 laps) | 0.428 / 0.281 | – / 0.080±0.006 / 0.067±0.006 | −0.024 | 0.30 |
| 2026 R1 | 833 | S,M,H | 0.769 / 0.514 | 0.066±0.014 / −0.020±0.010 / 0.045±0.005 | +0.006 | 0.47 |
| 2024 R24 Abu Dhabi | 859 | M,H | 0.426 / 0.304 | – / 0.080±0.005 / 0.054±0.003 | −0.005 | 0.29 |
| 2026 R7 | 1010 | S,M,H | 0.614 / 0.425 | 0.220±0.019 / 0.180±0.008 / 0.128±0.004 | −0.013 | 0.42 |
| 2025 R16 Monza | 873 | M,H | 0.380 / 0.304 | – / 0.018±0.002 / 0.015±0.002 | −0.007 | 0.22 |

R² 0.60–0.85. A full driver×compound interaction improves sd only 0.748→0.716 (2024 R13) and 0.614→0.594 (2026 R7): the additive model with the shrunk `dc` term is the right size. Per-stint slopes scatter around the pooled slope with sd 0.02–0.09 s/lap (n ≥ 8 laps), i.e. per-driver-stint degradation is mostly noise on top of the pooled compound line — pooled it is.

### A.2 Pit stops

`pit_loss` for THIS race = median over green stops of `(t_fc(in-lap) + t_fc(out-lap)) − (model(in) + model(out)) − δ_in − δ_out`, a **green stop** meaning `lap_status.is_green` on both `lap_in` and `lap_out`, both laps with a lap time, both compounds parameterised. It bundles in-lap, pit lane, out-lap and tyre warm-up, so the simulator needs no separate warm-up term (the model's age-1 lap is never observed in clean air; all age-1 laps are out-laps or lap 1). Results: 20.7 (Hungary, n=39, MAD 1.6), 19.0 (Miami), 24.2 (2026 R1, n=9, MAD 3.8), 23.4 (Abu Dhabi), 24.3 (2026 R7, n=31, MAD 1.2), 25.7 (Monza), 23.6 (Japan 2025), 22.0 (Las Vegas 2025). Pooled over 203 green stops: p25 20.8 / median 22.5 / p75 24.4. Per draw the loss of each stop is `pit_loss + pit_loss_mad · 1.4826 · t_4` (MAD from the same stops). If fewer than `MIN_GREEN_STOPS = 5` green stops exist, `pit_loss` falls back to the field-wide pooled prior (22.5, MAD 1.8) and the payload flags `pitLossSource = 'prior'`. Stops under VSC (54 stops, median 22.0) cost about the same *in fuel-corrected excess over the already-slow lap* — the saving is that δ_L is paid anyway, not that the stop is cheaper; stops taken under a full SC (43 stops) cost far more than the model on the pitting car's laps (median 75.6) because the in-lap includes the SC crawl that δ_L (median over non-pitting cars) only partly captures. Therefore: in **"as it happened"** mode a stop on a lap with `δ_L > SC_DELTA_THRESHOLD = 10 s` pays `pit_loss · SC_PIT_LOSS_FACTOR` where the factor is estimated per race when ≥ 3 such stops exist, otherwise the pooled `0.45` (a stop under SC "costs" ~10 s of race time relative to staying out, once the field's δ_L is common to both) — this is the *only* place the neutralisation timeline changes the delta.

### A.3 Neutralisations (SC / VSC / red)

Field history (61 races, 3,686 laps): SC episodes 0.59/race (hazard 0.0098/lap, duration median 5 laps, p25–p75 4–7); VSC 0.64/race (0.0106/lap, median 3 laps); red 0.10/race. 31 % of SCs start on lap ≤ 2. Field slowdown δ_L on laps with ≥ 80 % of cars affected: SC median +36.8 s (p10 34.0, p90 37.9); VSC median +23.8 s (p10 8.1, p90 28.5). Per circuit (`events.circuit_key`, 2–3 races each) the SC rate ranges 0 – 0.026/lap — 2–3 races is not enough to estimate a circuit rate, so the per-circuit hazard is a **Beta-binomial posterior**: `h_sc = (k_sc + PRIOR_SC_LAPS·0.0098) / (n_laps + PRIOR_SC_LAPS)` with `PRIOR_SC_LAPS = 200` (≈ 3 races of prior weight), same for VSC.

Two simulation modes, both in the payload:
- **As it happened** (default): the actual δ_L timeline is a fixed input; no random SCs. The delta is then driven by tyre/pit parameters and the SC-pit interaction. This is the question the fan asked ("what if *in this race*").
- **Generic race**: the actual δ_L is zeroed and SC/VSC episodes are drawn per lap from `h_sc`, `h_vsc` (Bernoulli per lap, duration Geometric with the pooled mean, δ per lap drawn from the pooled SC/VSC δ distribution as `median + MAD·t_4`); the draw is **shared** between both strategies. This answers "at this circuit, on average".

### A.4 What is sampled per draw vs fixed

Sampled per draw (shared across the two strategies): `deg_c` ~ N(fit, se) for each compound (independent), `off_c` ~ N(fit, se), `dc_{d,c}` ~ N(shrunk mean, sd_d/√(n+K)), `evo` ~ N(fit, se), per-stop pit loss, per-lap noise `ε_L`, per-lap SC state in generic mode. Fixed: `base_d` (cancels), `δ_L` in as-happened mode, `sd_d`, the hazard rates, `total_laps`, lap 1 start penalty (field median lap-1 residual, 6–12 s; cancels). Parameter uncertainty is the point: with common random numbers the lap noise cancels lap-for-lap, so the width of the delta distribution is exactly the model's statistical uncertainty about degradation/offsets plus pit-stop variance — an honest interval, not a decorative one.

### A.5 Calibration (fixed decision 6, made precise)

For the selected driver, the deterministic model (every sampled parameter at its point estimate, ε = 0) is run over the **actual** strategy with the actual δ_L and the actual number of stops, and compared with the real `Σ lap_time_fc_s` over the driver's laps with a lap time. The discrepancy is decomposed per lap category (`mc_decomp.py`):

| Race | clean-air laps (rep) misfit, field median | laps outside the model (non-rep: traffic, yellow, outliers) | count | pit laps per stop | lap 1 |
|---|---|---|---|---|---|
| 2024 R13 | +5.7 s over ~64 laps | −0.2 s | 1 | ~20.7 | +8.3 |
| 2025 R21 | +2.3 s | +2.0 s | 7 | ~22 | +9.1 |
| 2026 R1 | +3.7 s | +4.2 s | 5 | ~24 | +12.2 |
| 2026 R7 | −1.5 s | **+21.9 s** | 5 | ~24 | +7.5 |

The clean-air part calibrates within 2–6 s over a race (≈ 0.05–0.1 s/lap, i.e. within the driver's own lap noise). The part the model does not claim to describe — laps the cleaner threw out because of traffic or yellow flags — can be 20–50 s (2026 R7 Ocon: 6 laps, +48 s). The calibration line therefore shows **both** numbers separately: `Model vs reality on the laps it models: −1.5 s over 51 laps · 6 laps outside the model (traffic/yellows) cost 48 s that the simulator does not see`. The trust badge is computed from the modelled part only: `|misfit| / laps_modelled <= 0.15 s` → "calibrated", `<= 0.4` → "rough", else "poor" (section F); the second number is shown unconditionally so a poor calibration can never hide behind it. Races where the driver ran a non-parameterised compound on any lap (wet, intermediate, `NONE`, or a slick with < 30 field laps), or where fewer than `MIN_MODELLED_LAPS = 20` laps are modelled, render `<EmptyState>` for that driver.

## B. Schema (migration `web/drizzle/0001_sim.sql`, Drizzle file `web/db/schema/sim.ts`)

Six per-session tables (all `ON DELETE CASCADE`, all carrying `assumption_set_id`) plus one circuit-level table. The driver's actual strategy is NOT duplicated: it is read from the existing `stints` and `pit_stops`. All durations in seconds `double precision` (§0.3).

```sql
-- One row per race: race-level parameters of the simulator (f1lab.sim.race_params).
CREATE TABLE sim_race_params (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  ref_compound          text NOT NULL,              -- compound whose offset is 0 (most representative laps)
  evo_s_per_lap         double precision NOT NULL,  -- ridge estimate
  evo_se                double precision NOT NULL,
  resid_sd_s            double precision NOT NULL,  -- OLS residual sd of the joint fit
  resid_mad_s           double precision NOT NULL,  -- 1.4826 * MAD of the residuals
  r2                    double precision NOT NULL,
  laps_fit              integer NOT NULL,           -- representative slick laps in the fit
  design_cond           double precision NOT NULL,  -- condition number of the design (diagnostic, shown in caption when > 1e4)
  pit_loss_s            double precision NOT NULL,  -- median green-stop loss (A.2)
  pit_loss_mad_s        double precision NOT NULL,
  pit_loss_n            integer NOT NULL,           -- green stops used (0 when prior)
  pit_loss_source       text NOT NULL CHECK (pit_loss_source IN ('race','prior')),
  sc_pit_loss_factor    double precision NOT NULL,  -- multiplier applied to pit_loss_s on laps with delta_s > SC_DELTA_THRESHOLD
  sc_pit_factor_source  text NOT NULL CHECK (sc_pit_factor_source IN ('race','prior')),
  start_penalty_s       double precision NOT NULL,  -- field median lap-1 residual
  sc_delta_threshold_s  double precision NOT NULL,  -- copy of config.SC_DELTA_THRESHOLD, so the browser never hard-codes it
  PRIMARY KEY (session_id)
);

-- One row per parameterised compound (>= MIN_COMPOUND_LAPS_FOR_SIM representative laps).
CREATE TABLE sim_compound_params (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  compound           text NOT NULL,
  offset_s           double precision NOT NULL,     -- vs ref_compound (0 for ref)
  offset_se          double precision NOT NULL,
  deg_s_per_lap      double precision NOT NULL,     -- after the DEG_FLOOR clamp
  deg_se             double precision NOT NULL,
  deg_raw_s_per_lap  double precision NOT NULL,     -- before the clamp
  deg_clamped        boolean NOT NULL,
  laps               integer NOT NULL,
  age_max            integer NOT NULL,              -- longest tyre_life observed on this compound (extrapolation warning past it)
  PRIMARY KEY (session_id, compound)
);

-- One row per driver with a driver dummy in the fit (>= MIN_DRIVER_LAPS_FOR_SIM representative laps).
CREATE TABLE sim_driver_params (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id          text NOT NULL,
  base_s             double precision NOT NULL,     -- driver dummy (ref compound, age 1, lap 1)
  base_se            double precision NOT NULL,
  noise_sd_s         double precision NOT NULL,     -- 1.4826 * MAD of the driver's residuals
  laps_fit           integer NOT NULL,
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Shrunk driver x compound deviation; a row exists only where the driver ran the compound (laps > 0).
CREATE TABLE sim_driver_compound (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id          text NOT NULL,
  compound           text NOT NULL,
  dc_offset_s        double precision NOT NULL,     -- mean residual * n / (n + K_DC)
  dc_se              double precision NOT NULL,     -- noise_sd_s / sqrt(n + K_DC)
  laps               integer NOT NULL,
  PRIMARY KEY (session_id, driver_id, compound),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Field-wide slowdown per lap (A.1 delta_L). One row per lap 1..total_laps.
CREATE TABLE sim_lap_deltas (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  lap_number         integer NOT NULL,
  delta_s            double precision NOT NULL,     -- 0 when < 3 non-pit cars, and on lap 1
  cars               integer NOT NULL,              -- non-pit cars the median was taken over
  PRIMARY KEY (session_id, lap_number)
);

-- Deterministic calibration of the actual strategy (A.5); one row per driver in sim_driver_params
-- whose every timed lap is on a parameterised compound. Absence of a row == the driver is not simulable.
CREATE TABLE sim_calibration (
  session_id         integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id          text NOT NULL,
  laps_real          integer NOT NULL,              -- laps with a lap time
  laps_modelled      integer NOT NULL,              -- representative laps among them
  stops              integer NOT NULL,              -- pit_stops rows with lap_out NOT NULL
  real_total_fc_s    double precision NOT NULL,     -- sum lap_time_fc_s over laps_real
  sim_total_fc_s     double precision NOT NULL,     -- deterministic model incl. delta_L, stops, start penalty
  misfit_rep_s       double precision NOT NULL,     -- sum(real - model - delta) over representative laps
  misfit_pit_s       double precision NOT NULL,     -- sum over in/out laps minus stops*pit_loss (SC-adjusted)
  misfit_lap1_s      double precision NOT NULL,     -- lap-1 residual minus start_penalty_s
  unmodelled_s       double precision NOT NULL,     -- sum(real - model - delta) over non-representative non-pit laps
  unmodelled_laps    integer NOT NULL,
  badge              text NOT NULL CHECK (badge IN ('calibrated','rough','poor')),
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Circuit-level neutralisation hazard, rewritten for every circuit at the end of each ingest run
-- from lap_status of every ok/partial race (f1lab.sim.recompute_circuit_hazards). Not per session:
-- no cascade; a circuit row is deleted only when it has no races left.
CREATE TABLE sim_circuit_hazard (
  circuit_key        integer NOT NULL REFERENCES circuits(circuit_key),
  assumption_set_id  integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  computed_at        timestamptz NOT NULL DEFAULT now(),
  races              integer NOT NULL,
  laps               integer NOT NULL,
  sc_episodes        integer NOT NULL,
  vsc_episodes       integer NOT NULL,
  sc_hazard          double precision NOT NULL,     -- (sc_episodes + PRIOR_SC_LAPS*pooled) / (laps + PRIOR_SC_LAPS)
  vsc_hazard         double precision NOT NULL,
  sc_dur_mean        double precision NOT NULL,     -- pooled over all circuits (per-circuit n is too small)
  vsc_dur_mean       double precision NOT NULL,
  sc_delta_med_s     double precision NOT NULL,     -- pooled delta_L on SC laps with >= 80 % cars affected
  sc_delta_mad_s     double precision NOT NULL,
  vsc_delta_med_s    double precision NOT NULL,
  vsc_delta_mad_s    double precision NOT NULL,
  PRIMARY KEY (circuit_key)
);
```

Populating functions (all in `f1lab/sim.py`, section C): `race_params`, `compound_params`, `driver_params`, `driver_compound`, `lap_deltas`, `calibration` are the six outputs of ONE call `sim.fit_race(annotated_laps, lap_status, pit_stops, total_laps)`; `recompute_circuit_hazards(conn)` writes the seventh. `frames.EXPECTED_COLUMNS` gains the seven tables in DDL order; `RACE_TABLE_ORDER` gains the six per-session tables after `track_status_events`; `ANALYTICS` gains a single key `"sim"` (all six tables succeed or fail together, since they come from one fit). `db.delete_session_children` needs no change (it iterates `RACE_TABLE_ORDER` reversed). Row volume: 1 + ≤ 3 + ≤ 22 + ≤ 66 + ≤ 78 + ≤ 22 ≈ 190 rows per race, ~13 k rows for 71 races.

## C. Python

### C.1 New module `f1lab/sim.py`

```python
"""Race-model parameters for the browser Monte Carlo (SPEC v1.1 §A). Estimation only; nothing simulates here."""

@dataclass(frozen=True)
class SimFit:
    race_params: pd.DataFrame        # 1 row, DB columns of sim_race_params minus session_id/assumption_set_id
    compound_params: pd.DataFrame    # per parameterised compound
    driver_params: pd.DataFrame      # per driver in the fit  (column 'Driver' = FastF1 code; frames.py resolves ids)
    driver_compound: pd.DataFrame
    lap_deltas: pd.DataFrame         # lap_number, delta_s, cars
    calibration: pd.DataFrame        # per simulable driver
    compounds_dropped: dict[str, int]  # compound -> representative laps, for the warning text

def slick_representative(annotated: pd.DataFrame) -> pd.DataFrame:
    """Rows: is_representative & TyreLife >= 2 & Compound in SLICK_COMPOUNDS (config)."""

def fit_lap_model(rep: pd.DataFrame, evo_prior_sd: float) -> LapModel:
    """Joint OLS with driver dummies, compound offsets, per-compound deg on (TyreLife-1), evo on (LapNumber-1),
    plus the ridge pseudo-observation on evo (A.1). Returns params, standard errors, residuals, design cond."""

def shrink_driver_compound(rep, model, k: int) -> pd.DataFrame
def lap_deltas(laps_all, model, min_cars: int) -> pd.DataFrame          # A.1 delta_L, non-pit laps, lap 1 -> 0
def pit_loss(laps_all, pits, lap_status, model, deltas) -> tuple[float, float, int, str, float, str]
    # (loss, mad, n_green, source, sc_factor, sc_factor_source), A.2
def start_penalty(laps_all, model) -> float
def calibrate(laps_all, pits, model, deltas, race) -> pd.DataFrame       # A.5 decomposition + badge

def fit_race(annotated: pd.DataFrame, lap_status: pd.DataFrame, pits: pd.DataFrame, total_laps: int) -> SimFit
    # orchestrates the above; raises SimNotEstimable(reason) when no compound has MIN_COMPOUND_LAPS_FOR_SIM laps
    # or fewer than MIN_DRIVERS_FOR_SIM drivers have MIN_DRIVER_LAPS_FOR_SIM laps

def recompute_circuit_hazards(conn) -> int
    # SELECT lap_status x sessions x events for every ok/partial race; episode detection as in output/mc_sc.py;
    # Beta-binomial per circuit with pooled prior; pooled durations and delta distributions; rewrites sim_circuit_hazard.
```

`annotated` is the frame `clean.annotate_laps(session)` already produces inside `build_race_frames`. It does not carry `LapTimeFuelCorrected` (in v1 fuel correction is applied to `clean_only` for the analytics and separately for the laps table), so `sim.fit_race` receives `pace.fuel_correct(annotated, session.total_laps, lap_km=None)` — the same call `_laps_frame` uses — and the sim inputs equal `laps.lap_time_fc_s` exactly.

### C.2 Hook in `frames.build_race_frames` (owner: Python package, see G)

After `tstatus = _guard(...)`:
```python
simfit = _guard(status, "sim", lambda: sim.fit_race(
    pace.fuel_correct(annotated, session.total_laps, lap_km=None),
    lstatus, pits, int(session.total_laps)) if (lstatus is not None and pits is not None) else None)
```
`_guard` already maps an exception to `error: SimNotEstimable: <reason>` and an empty result to `empty`; the six tables get `empty_frame(...)` in that case and the race page shows `<EmptyState reason="sim: error: SimNotEstimable: no slick compound with >= 30 representative laps">`. `ANALYTICS += ["sim"]`, `RACE_TABLE_ORDER += [six tables]`, `TABLE_COLUMNS` += seven entries (types as in B), `COLUMN_MAP` entries for the six frames. A session whose sim fails is `partial`, not failed — consistent with every other analytic. `compounds_dropped` becomes a warning line (`sim: SOFT dropped (12 representative laps < 30)`).

`ingest.run_season`: after `season.recompute(conn, a.season)` add `sim.recompute_circuit_hazards(conn)` inside the same committed block (and in the `--recompute-season` branch). Because the hazard rows are cross-season, `--recompute-season` on any year refreshes them.

### C.3 New constants (`f1lab/config.py`) — every one enters the assumption snapshot, so the hash changes and a new `assumption_sets` row appears on the first run

```python
# Monte Carlo race model (SPEC v1.1)
SLICK_COMPOUNDS = ("SOFT", "MEDIUM", "HARD")
MIN_COMPOUND_LAPS_FOR_SIM = 30     # representative laps a compound needs to be parameterised
MIN_DRIVER_LAPS_FOR_SIM = 8        # representative laps a driver needs a dummy (matches pace_ranking min_laps)
MIN_DRIVERS_FOR_SIM = 6
EVO_PRIOR_SD = 0.01                # s/lap, ridge on track evolution (A.1)
K_DC = 10                          # shrinkage laps for driver x compound
DEG_FLOOR = -0.05                  # s/lap
NOISE_T_DF = 4
MIN_GREEN_STOPS = 5
PIT_LOSS_PRIOR_S = 22.5;  PIT_LOSS_PRIOR_MAD_S = 1.8      # pooled 203 green stops, 2024-26
SC_DELTA_THRESHOLD = 10.0          # s; a lap with delta_L above this counts as neutralised for pit loss
SC_PIT_LOSS_FACTOR_PRIOR = 0.45
PRIOR_SC_LAPS = 200;  SC_HAZARD_POOLED = 0.0098;  VSC_HAZARD_POOLED = 0.0106
MIN_CARS_FOR_DELTA = 3
MIN_MODELLED_LAPS = 20
CALIB_GOOD_S_PER_LAP = 0.15;  CALIB_ROUGH_S_PER_LAP = 0.40
```
`assumptions.CALL_SITE_PARAMS` is unchanged (every sim parameter is a config constant).

### C.4 Tests (`tests/test_sim.py`, no DB; `tests/test_sim_db.py`, `db` marker)

- Synthetic frame (2 drivers, 2 compounds, known deg/evo/offset, Gaussian noise): `fit_lap_model` recovers within 2 se; the collinear case (everyone pits on lap 20) returns finite deg and `|evo| < 0.005` — the ridge test.
- `hungary_2024` fixture: HARD deg 0.084 ± 0.01, pit loss 20.7 ± 1, calibration `misfit_rep_s` median within ±8 s, badge `calibrated` for ≥ 15 drivers; every column of every frame in `EXPECTED_COLUMNS` order (`cast_frame` must not raise).
- `miami_2025`: SOFT dropped (`compounds_dropped == {'SOFT': n<30}`), Stroll simulable, 4 calibration rows only for drivers whose every lap is on M/H — asserts the "non-parameterised compound → no calibration row" rule.
- `r1_2026`: VSC laps 2–3 have `delta_s > 10`; a driver whose lap_out is NULL (retired in pits) counts 0 stops.
- `test_schema_contract.py` already compares `EXPECTED_COLUMNS` with `information_schema`; it will fail until migration 0001 is applied — that is the intended gate.
- `recompute_circuit_hazards`: with the three seasons ingested, every circuit row has `sc_hazard` in (0.002, 0.03) and `races >= 1`; circuit 15 (Barcelona, two event names) yields ONE row.

### C.5 Recompute path

`--force` re-ingest (about a minute from cache for three seasons) is the only way to populate the six per-session tables; no new flag. Rationale: the sim fit consumes the same `annotated` frame as everything else, and a partial recompute path would need to re-run `clean.annotate_laps` from FastF1 anyway. The RUNBOOK gets one line: "v1.1 needs `make migrate` then `--force` for every season; sessions ingested under the old assumption set show the `mixed_assumption_sets` badge until then". `--check-schema` covers the seven new tables for free.

## D. Query + client contract

New file `web/lib/queries/sim.ts` (so `race.ts` is untouched — G). One export, one JSON payload per race; the page calls it inside the existing `Promise.all`.

```ts
// web/lib/queries/sim.ts — SPEC v1.1 §D. Reads sim_* tables + stints/laps/pit_stops; computes nothing.
import type { DriverRef } from "@/lib/queries/shared";

export type SimCompound = {
  compound: string;          // 'SOFT' | 'MEDIUM' | 'HARD' (only parameterised ones appear)
  offsetS: number; offsetSe: number;
  degSPerLap: number; degSe: number; degRawSPerLap: number; degClamped: boolean;
  laps: number; ageMax: number;
};

export type SimStint = { compound: string; startLap: number; endLap: number; startAge: number };
// startAge = laps.tyre_life at startLap (used tyres start > 1); the editor's default for a new stint is 1.

export type SimCalibration = {
  lapsReal: number; lapsModelled: number; stops: number;
  realTotalFcS: number; simTotalFcS: number;         // both fuel-corrected (A.5)
  misfitRepS: number; misfitPitS: number; misfitLap1S: number;
  unmodelledS: number; unmodelledLaps: number;
  badge: "calibrated" | "rough" | "poor";
};

export type SimDriver = DriverRef & {
  baseS: number; baseSe: number; noiseSdS: number; lapsFit: number;
  compounds: Record<string, { dcOffsetS: number; dcSe: number; laps: number }>; // absent key == never ran it
  actual: SimStint[];                                  // from stints (+ tyre_life at start); [] when stints has a NaN gap
  actualStops: number[];                               // pit_stops.lap_in for stops with lap_out NOT NULL
  lapsCompleted: number;                               // results.laps_completed ?? max lap_number
  calibration: SimCalibration | null;                  // null == not simulable (reason below)
  notSimulableReason: string | null;                   // e.g. 'ran INTERMEDIATE on 9 laps', 'fewer than 20 modelled laps'
};

export type SimRaceParams = {
  refCompound: string; evoSPerLap: number; evoSe: number;
  residSdS: number; residMadS: number; r2: number; lapsFit: number; designCond: number;
  pitLossS: number; pitLossMadS: number; pitLossN: number; pitLossSource: "race" | "prior";
  scPitLossFactor: number; scPitFactorSource: "race" | "prior";
  startPenaltyS: number; scDeltaThresholdS: number;
};

export type SimHazard = {
  circuitKey: number; races: number; laps: number;
  scHazard: number; vscHazard: number; scDurMean: number; vscDurMean: number;
  scDeltaMedS: number; scDeltaMadS: number; vscDeltaMedS: number; vscDeltaMadS: number;
};

export type SimModel = {
  sessionId: number; totalLaps: number; assumptionSetId: number;
  race: SimRaceParams;
  compounds: SimCompound[];                            // ordered: ref compound first, then by laps desc
  lapDeltas: number[];                                 // index L-1, length totalLaps; A.1 delta_L
  hazard: SimHazard | null;                            // null when the circuit row is missing (events.circuit_key NULL)
  drivers: SimDriver[];                                // ordered by results.position nulls last; simulable and not
  constants: { noiseTDf: number; kDc: number };        // from assumption_sets.params, so the browser never hard-codes
};

/** null when sim_race_params has no row for the session (analytics_status.sim tells why). */
export async function getSimModel(sessionId: number): Promise<SimModel | null>;
```

Six selects run in one `Promise.all` (race params; compounds; drivers joined to `session_entries`/`session_teams`/`drivers` via the existing `entryColumns` pattern; driver×compound; lap deltas; calibration), plus `stints` and `pit_stops` and one `laps` select of `(driver_id, lap_number, tyre_life)` restricted to stint start laps (`WHERE (driver_id, lap_number) IN (...)` built from the stints result — or simply select `tyre_life` for `lap_number = start_lap` with a join on `stints`), plus `sim_circuit_hazard` via `sessions → events.circuit_key`. `notSimulableReason` is derived in the query from data, not computed: a driver with `sim_driver_params` but no `sim_calibration` row gets the reason from the compounds in their `stints` rows that are not in `compounds` ("ran INTERMEDIATE on 9 laps"), else "fewer than 20 modelled laps"; a driver with no `sim_driver_params` row gets "fewer than 8 representative laps".

Byte estimate for 22 cars: race 0.5 KB + 3 compounds 0.6 KB + 70 lap deltas 0.6 KB + hazard 0.3 KB + 22 × (DriverRef 0.2 + params 0.15 + 3 dc 0.2 + 3 stints 0.25 + calibration 0.35) ≈ 22 × 1.15 = 25 KB → **~28 KB of JSON** (RSC-serialised into the page, on top of the existing 500–700 KB). No lap-level series is sent; the browser regenerates everything from the parameters.

## E. Browser algorithm (`web/lib/sim/engine.ts`, pure TypeScript, no React, unit-testable in Node)

Prototype: `output/mc_engine_proto.mjs` — N = 4000 draws × 70 laps with Student-t noise for lap and pit draws runs in **107–120 ms** (Node 22, M-series), per-lap quantiles another 12 ms. Well under a second; N = 4000 is the default, `N = 2000` on `navigator.hardwareConcurrency <= 4`. No web worker.

### E.1 Inputs

`SimModel` (D), the selected `SimDriver`, `edited: SimStint[]`, `mode: "asHappened" | "generic"`, `seed: number` (fixed default 20240101 so results are reproducible; a "re-roll" button changes it).

### E.2 Strategy expansion (once per run, not per draw)

```
expand(stints, totalLaps) -> { comp[L], age[L], pitAt[L] }   // L = 0..totalLaps-1
  for each stint s: for L in s.startLap..s.endLap: comp = s.compound, age = s.startAge + (L - s.startLap)
  pitAt[s.endLap - 1] = true for every stint but the last
  validation (also enforced by the editor, F): stints contiguous from 1 to lapsCompleted, endLap >= startLap,
  every compound in model.compounds, at most MAX_STOPS = 5, min stint length 1
```
The actual strategy is expanded the same way from `driver.actual`, and the simulated horizon is `driver.lapsCompleted` (not `totalLaps`): a driver who retired on lap 42 is compared over 42 laps and the UI says so.

### E.3 One draw (common random numbers)

```
draw(n):
  // shared parameter sample
  for c in compounds:  off[c] = offsetS + offsetSe·z ;  deg[c] = max(DEG_FLOOR, degSPerLap + degSe·z)
                       dc[c]  = driver.compounds[c] ? dcOffsetS + dcSe·z : 0
  evo = evoSPerLap + evoSe·z
  if mode == generic:  sc[L] = drawNeutralisations(hazard)   // per-lap delta_s array, same for both strategies
  else:                sc[L] = model.lapDeltas[L]
  cum = 0
  for L in 0..H-1:
     eps    = driver.noiseSdS · t(NOISE_T_DF)                      // ONE draw, used by both
     pit    = pitLossS + pitLossMadS·1.4826·t(NOISE_T_DF)          // ONE draw, used by both (if both pit on L)
     f      = sc[L] > scDeltaThresholdS ? scPitLossFactor : 1
     tA     = off[cA[L]] + dc[cA[L]] + deg[cA[L]]·(ageA[L]-1) + evo·L + sc[L] + eps + (pitA[L] ? pit·f : 0)
     tE     = same with the edited arrays
     cum   += tE − tA ;  perLap[n][L] = cum
  delta[n] = cum
```
`base_d`, fuel, lap-1 start penalty and δ_L are identical on both sides and are omitted from the delta (they are added back only in calibration mode, E.5). Pit loss is booked on the in-lap; the per-lap view therefore shows the whole stop as one step at the in-lap.

`drawNeutralisations`: for L in 0..H-1, if no episode active: with prob `scHazard` start an SC (duration `1 + Geometric(1/(scDurMean−1))` laps, per-lap delta `scDeltaMedS + scDeltaMadS·1.4826·t4` drawn once per episode), else with prob `vscHazard` a VSC likewise. Episodes never overlap. 31 % of real SCs start on lap ≤ 2, which a constant hazard under-represents; accepted and stated in the caption (generic mode is the secondary mode).

### E.4 PRNG and distributions

`mulberry32(seed)` (32-bit, ~2^32 period, 4 lines, deterministic across browsers); normals by Box–Muller; `t_ν = z / sqrt(χ²_ν/ν)` with χ²_4 as the sum of four squared normals (5 normals per t draw; that is the whole cost, measured above). Streams: one PRNG per run; the order of draws is fixed by the loop so the same seed reproduces the same result regardless of the edited strategy — this is what makes two consecutive edits comparable.

### E.5 Outputs

```ts
export type SimResult = {
  n: number; horizonLaps: number;
  deltaMedianS: number; deltaP10S: number; deltaP90S: number; deltaMeanS: number;
  pBetter: number;                                  // share of draws with delta < 0 (edited faster)
  histogram: { binStartS: number; count: number }[]; // 40 bins over [p1, p99]
  perLap: { lap: number; medianS: number; p10S: number; p90S: number }[]; // cumulative edited − actual
  stops: { lap: number; underNeutralisation: boolean }[];   // edited stops, for markers
  calibration: { simActualTotalS: number; realTotalS: number; discrepancyS: number } // E.6
};
```
Quantiles by sorting the `Float64Array` of deltas (N log N, 4000 → < 1 ms) and, per lap, a column sort (70 × 4000 log 4000 ≈ 12 ms measured). Sign convention: the engine returns `edited − actual`, so **negative = edited strategy faster**. To avoid the fan having to remember a sign, the cards spell it out ("gain 12.3 s" / "loss 4.1 s") and the chart axis is labelled "edited − actual (s), below zero = edited ahead".

### E.6 Calibration in the browser

The stored `sim_calibration` row is the source of truth (computed in Python from the same parameters); the browser recomputes `simActualTotalS` deterministically (ε = 0, point estimates, actual δ_L, actual stops, start penalty, + Σ fuel_penalty) as a self-check and shows the stored numbers. If the browser's deterministic total differs from `simTotalFcS + Σfuel` by more than 0.5 s the section renders a visible warning `engine/parameter mismatch: X s` — a cheap contract test that would catch a bookkeeping bug in either implementation (fuel penalty is recomputed as `FUEL_START_KG·(1−(L−0.5)/total)·FUEL_EFFECT_S_PER_KG` from `assumption_sets.params`, which the page already loads).

### E.7 Complexity

Per run O(N·H) with ~12 normals per lap-pair → 4000 × 70 × 12 ≈ 3.4 M normals ≈ 110 ms; memory: `perLap` Float64Array of N·H = 280 k doubles = 2.2 MB, freed after quantiles. Runs are triggered by an explicit "Run" button and by debounced (300 ms) editor changes; a run never blocks paint for more than ~150 ms.

## F. UI spec — section "Strategy simulator" (`id="simulator"`, slot after "Tyre degradation", before "Race trace")

Slot argument: the fan needs the gantt (what was done) and the degradation chart (why compounds differ) in view before editing; the trace (traffic, who finished where) is exactly what the simulator does *not* answer, so it follows, not precedes. `SECTIONS` in `page.tsx` gains `{ id: "simulator", title: "Strategy simulator" }` in that position.

Files: `components/race/SimulatorSection.tsx` (`'use client'`; owns state), `components/sim/StintEditor.tsx`, `components/sim/ResultCards.tsx`, `components/charts/DeltaHistogram.tsx`, `components/charts/DeltaPerLap.tsx`, `lib/sim/engine.ts`, `lib/sim/prng.ts`, `lib/sim/validate.ts`. The page passes `model` (from `getSimModel`), `colours`, `year`, `reason={reasonFor(status, "sim", "stints", "pit_stops")}`.

### F.1 Empty states
- `model === null` → `<EmptyState title="Race model not estimated for this race" reason={reason}>` (reason is the `analytics_status.sim` string, e.g. `sim: error: SimNotEstimable: no slick compound with >= 30 representative laps`).
- selected driver `calibration === null` → `<EmptyState title="{code} cannot be simulated" reason={notSimulableReason}>` with the driver selector still shown so the fan can pick another.

### F.2 Controls (top row)
- **Driver selector**: `<select>` of `model.drivers` in finishing order, label `P{n} CODE — Team`; non-simulable drivers listed but marked "(not simulable)". Default: the winner (`results.position === 1`) if simulable, else the first simulable driver. `DriverChip` next to it.
- **Mode**: two radio chips "As it happened" (default) / "Generic race at this circuit" (disabled with tooltip when `hazard === null`).
- **Seed**: small "re-roll" button (changes seed; label shows `seed 20240101`).
- **Run**: primary button; auto-run on every valid edit, debounced 300 ms; a spinner-free 120 ms run needs no progress UI. `Reset to actual` restores `driver.actual`.
- **Presets** (one click, all derived from the actual strategy, only offered when valid): "Pit 3 laps earlier", "Pit 3 laps later", "One stop fewer (merge last two stints, keep the first compound)", "Swap the compounds of stints 1 and 2".

### F.3 Stint editor (table, one row per stint)
| # | Compound (`<select>` limited to `model.compounds`, chip-coloured from `colours`) | Start lap (read-only, = previous end + 1; stint 1 = 1) | End lap (number input) | Laps (derived) | Starting age (number, default 1; shown as "used" when > 1) | remove |
- Last stint's end lap is fixed at `driver.lapsCompleted`. Editing an end lap shifts the next stint's start; `validate.ts` returns a list of messages rendered inline: "stint 2 would have 0 laps", "lap 61 is after the last lap this driver completed (58)", "more than 5 stops", "compound INTERMEDIATE is not parameterised for this race". Invalid → Run disabled, last valid result stays visible greyed.
- "Add stop" splits the longest stint at its midpoint, new stint inherits the compound. A stint row shows a small warning icon when `laps > compound.ageMax` ("longer than any stint seen on this compound (max 31) — degradation is extrapolated"), and when `driver.compounds[c]` is absent ("{code} never ran {c} in this race: pace uses the field's compound offset").
- Stops landing on a lap with `lapDeltas[L] > scDeltaThresholdS` get a badge "under SC/VSC" in as-happened mode.

### F.4 Result cards (`StatTile` × 4)
1. **Median gain/loss**: `−12.3 s` labelled "gain" / "+4.1 s loss", subtitle "p10 −16.8 · p90 −7.9".
2. **P(edited faster)**: `93 %` of 4000 draws.
3. **Horizon**: "58 laps simulated (lapsCompleted)" + "1 → 2 stops".
4. **Calibration** (F.6).

### F.5 Charts (both `EChart`, `ariaLabel` set)
- `DeltaHistogram`: `bar` series over `histogram`, x "edited − actual, s", a `markLine` at 0 labelled "no change" and at the median; bars left of 0 in `PALETTE.accent`, right of 0 in `PALETTE.muted`. Option shape: `{ grid, xAxis:{type:'value'}, yAxis:{type:'value', name:'draws'}, series:[{type:'bar', barCategoryGap:0, data:[[binStartS,count],...], itemStyle:{color: cb}}], tooltip:{trigger:'axis'} }`.
- `DeltaPerLap`: x lap 1..H; three `line` series (p10, p90 with `stack` + `areaStyle` for the band, median on top in accent); `markLine` verticals at each edited stop (label "pit L{n}") and at each actual stop (dashed, muted); `markArea` for laps with `lapDeltas > threshold` (label "SC/VSC", same helper as `RaceTrace.statusBands` but keyed on δ). y "cumulative edited − actual (s)"; `yAxis.inverse: false` with a `markLine` at 0. Tooltip: "Lap 31: −8.2 s (p10 −11.0, p90 −5.4)".

### F.6 Calibration line (always rendered above the charts when a result exists)
```
Model check — {code}'s actual strategy: simulated {sim} vs real {real} over {lapsReal} laps → {sign}{disc} s
({badge}). On the {lapsModelled} laps the model describes it misses by {misfitRepS} s; {unmodelledLaps} laps outside the
model (traffic, yellow flags, outliers) cost {unmodelledS} s that no strategy here can recover.
```
Badge colours: `calibrated` accent, `rough` amber `#e8c547`, `poor` red `#e8474b`; `poor` also prefixes the result cards with "low trust —". `sim`/`real` are wall-clock seconds formatted `m:ss.s` via `lib/format.ts`; `disc = sim − real`.

### F.7 Caption (verbatim, `Caption` under the charts)
> Clean-air model only: the simulator asks how much time a strategy would have gained or lost for this driver with no traffic, no blue flags and no overtaking, so it never says whether they would have finished ahead of anyone. Lap times come from a per-race fit (driver pace + compound offset + degradation per lap of tyre age + track evolution) on this race's representative laps; the pit loss is this race's median green-flag stop; the spread of the result is the model's own uncertainty about degradation, compound offsets and pit-stop time, not lap-to-lap noise, which is shared between the two strategies. Fuel is simulated in fuel-corrected time and cancels. "As it happened" keeps this race's safety-car and VSC laps where they were and makes a stop under one cheaper; "Generic race" replaces them with random neutralisations at this circuit's historical rate (2–3 races of history plus a prior — it is a rough prior, not a forecast). Tyre behaviour beyond the longest stint seen on a compound is extrapolated, and a driver's pace on a compound they never ran is the field's. Compounds with fewer than 30 representative laps in this race cannot be selected.

Appended per race when applicable: "Pit loss for this race fell back to the three-season prior (fewer than 5 green stops)."; "The degradation slope of {c} was clamped from {raw} to −0.05 s/lap."; "Design condition number {n}: degradation and evolution are weakly identified in this race; the evolution prior is doing real work."

## G. Work breakdown and file ownership

Three packages; every file has exactly one owner. Nothing outside the listed files changes.

| Package | Owner of (edit) | Creates |
|---|---|---|
| **WP-S0 Schema + contract** (sequential first, ~2 h) | `web/db/schema/index.ts` (one added `export * from "./sim"`), `f1lab/frames.py` (TABLE_COLUMNS/EXPECTED_COLUMNS, RACE_TABLE_ORDER, ANALYTICS, COLUMN_MAP entries only — the `_guard` hook line is added by S1 but S0 leaves a `# v1.1 sim hook` comment where), `f1lab/db.py` (`SESSION_CHILD_TABLES` += six tables, reverse order), `docs/SPEC.md` (new §9 v1.1 contract, pasted from this proposal's A, B, D) | `web/db/schema/sim.ts`, `web/drizzle/0001_sim.sql` + `meta/0001_snapshot.json`/journal via `npm run db:generate`, `web/lib/queries/sim.ts` **types only + stub returning null** (so S2 can build immediately) |
| **WP-S1 Python model** (~1.5 days) | `f1lab/config.py` (C.3 constants), `f1lab/frames.py` — **no**: S0 owns it; S1 hands S0 the one `_guard` line and the six `tables[...] = cast_frame(...)` blocks as a patch to apply (S0 stays owner and applies it; in practice S0 finishes in hours and the same person then does S1, which dissolves the handoff), `f1lab/ingest.py` (two `sim.recompute_circuit_hazards(conn)` calls), `docs/RUNBOOK.md` (one paragraph) | `f1lab/sim.py`, `tests/test_sim.py`, `tests/test_sim_db.py` |
| **WP-S2 Web** (~2 days, parallel with S1 after S0) | `web/lib/queries/sim.ts` (fills the stub), `web/app/race/[year]/[round]/page.tsx` (import, `getSimModel(id)` in the `Promise.all`, the `SECTIONS` entry, the `<Section id="simulator">` block) | `web/lib/sim/{engine,prng,validate}.ts`, `web/components/race/SimulatorSection.tsx`, `web/components/sim/{StintEditor,ResultCards}.tsx`, `web/components/charts/{DeltaHistogram,DeltaPerLap}.tsx`, `web/lib/sim/__tests__/engine.test.ts` (node `--test` via `tsx`, no new test runner) |
| **WP-S3 Integration** (~half day) | `docs/SPEC.md` §8 "as built" additions | — |

Untouched by anyone: `web/lib/queries/race.ts`, `web/lib/queries/shared.ts`, every existing chart/section component, `f1lab/pace.py`, `f1lab/derive.py`, `f1lab/clean.py`, `f1lab/assumptions.py` (the snapshot picks up the new constants automatically).

Sequencing: S0 → (S1 ‖ S2) → S3. S2 can build everything before Python data lands: the engine and charts are driven by a hand-written `SimModel` fixture (`web/lib/sim/__fixtures__/hungary2024.ts`, numbers copied from A.1's table); `page.tsx` renders `<EmptyState>` while `getSimModel` returns null. S1 can run `pytest tests/test_sim.py` without the DB (synthetic + cached fixtures) before migration 0001 is applied; `tests/test_sim_db.py` and `test_schema_contract.py` need S0's migration.

Per-package verification:
- S0: `cd web && npm run db:generate && npm run db:migrate && npm run typecheck`; `python -m f1lab.ingest --check-schema` prints `schema ok` (seven new tables, columns in DDL order); `pytest tests/test_schema_contract.py`.
- S1: `pytest tests/test_sim.py tests/test_sim_db.py tests/test_frames.py tests/test_guards.py`; `python -m f1lab.ingest --season 2024 --round 13 --force` then `docker exec f1-postgres psql -U f1 -d f1 -c "select badge,count(*) from sim_calibration group by 1"` shows ≥ 15 `calibrated`; `--season 2024/2025/2026 --force` (≈ 1 min total) with every session `ok` or `partial` where `analytics_status.sim` names the reason (expected partials: wet races such as 2025 R13 with < 30 slick laps for a compound still fit; `2025 R1` — 33 representative laps — must be `sim: error: SimNotEstimable`); `select count(*) from sim_race_params` = number of ok races minus the not-estimable ones, listed in the S3 record.
- S2: `npm run typecheck && npm run lint && npm run build`; `npx tsx --test web/lib/sim/__tests__/engine.test.ts` (seed determinism, `delta === 0` when edited == actual for every seed, CRN check: the same seed with a 1-lap-later stop changes only laps ≥ that lap, calibration self-check < 0.5 s on the fixture, N = 4000 × 70 laps < 400 ms in CI); the section on `/race/2024/13` in the running dev server on :3000 (do not start a second one) renders the winner by default, runs on load, histogram + per-lap chart painted (canvas present under `role="img"`), console empty.
- S3: full `pytest` (135 + new), the §8.5 crawl script over all race routes with the extra check that every ingested race shows either the simulator cards or an `<EmptyState>` whose reason starts with `sim:`; SPEC §8 updated; `Makefile` unchanged.

## H. Risks (top 5)

1. **Model misspecification (biggest).** A pooled linear degradation with a fixed offset is wrong for a compound that cliffs (2026 R7 SOFT 0.22 s/lap on ≤ 12-lap stints, extrapolated to 30 laps says −6.6 s, reality is a cliff) and for evolution that is not linear (2025 R6: −0.024 s/lap early, flat later). *Mitigation:* the calibration row is computed by Python from the same parameters and shown per driver with a badge that can say `poor`; the browser re-derives it and flags a mismatch; the editor warns when a stint exceeds `ageMax`; the caption states extrapolation. The honest limit is stated as such: a calibrated actual strategy does not validate a counterfactual, and the caption says the spread is model uncertainty, not truth.
2. **Degradation/evolution collinearity** when the field pits on the same laps (2025 R13: condition number 4e17). *Mitigation:* the evo ridge (`EVO_PRIOR_SD = 0.01`) makes the fit finite and near-neutral; `design_cond` is stored and surfaced in the caption above 1e4; tested on a synthetic collinear frame. Residual risk: on such a race the degradation slope carries the evolution — the delta for a "pit later" edit is then biased toward the pooled evolution sign; the caption line covers it.
3. **SC pit-loss interaction is the whole game in "as it happened" mode, and it rests on a factor estimated from 43 SC stops pooled across races (median 0.45, but the per-race spread is wide).** *Mitigation:* per-race factor when ≥ 3 SC stops, pooled prior otherwise with `sc_pit_factor_source` shown; the stop badge "under SC/VSC" makes it visible which edits depend on it; the `SC_DELTA_THRESHOLD` and factor are assumption constants (hash-tracked, in the assumptions panel).
4. **Silent contract drift between Python and TypeScript** (two implementations of the same lap formula). *Mitigation:* E.6 self-check with a 0.5 s tolerance rendered as a visible warning; `test_sim_db.py` and `engine.test.ts` share the Hungary 2024 numbers via the fixture file copied from `sim_calibration` (the S3 record lists the copy); the model formula lives in SPEC §9 once, quoted in both files' headers.
5. **Assumption-set churn and re-ingest cost.** Adding 20 constants changes the hash; every session shows `mixed_assumption_sets` until `--force` for all three seasons (~1 min from cache, but the cache must be present on the machine). *Mitigation:* RUNBOOK line; `--check-schema` before the run; the season page badge is exactly the existing mechanism for this state. A secondary risk is FastF1 rate limiting if the cache is cold — the existing retry/abort path handles it and the run is resumable.

Not a risk but a stated non-goal, repeated so nobody adds it later: positions, traffic, undercut/overcut against other cars. The simulator's unit is seconds of clean-air race time for one driver; the caption says it in its first sentence.
