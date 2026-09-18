# F1 Analytics — v1.1 Specification: Interactive Monte Carlo Strategy Simulator

Companion to `docs/SPEC.md` (v1). Everything in SPEC.md §0–§8 stays in force; this document
adds one race-page section, one Python analytic, five Postgres tables, one query module and one
client engine. Three implementers build in parallel from this file alone (§7). It was synthesised
from three proposals (model-first, product-first, data-first) and three judges' scorecards; every
judge-flagged error is fixed here and every disagreement is decided in §9.

## Outline

0. Scope, fixed decisions, conventions
1. The race model (terms, estimators, rows used, fallbacks, constants → `config.py` names)
2. Schema (DDL for every new table, `EXPECTED_COLUMNS` additions, Drizzle transcription notes)
3. Python (module layout, signatures, `build_race_frames` hook, `analytics_status` keys, tests, recompute)
4. Query + client contract (TypeScript types, exported function, payload example)
5. Browser algorithm (one draw, PRNG, N, common random numbers, outputs, calibration, complexity)
6. UI spec (controls, validation, presets, result cards, chart options, verbatim caption, empty states)
7. Work packages (strict single-owner file ownership, sequencing, verification commands)
8. Risks
9. Decisions log

---

## 0. Scope, fixed decisions, conventions

> **v1.6 (qualifying) changes nothing in this spec, and that is a decision rather than an
> oversight.** `QUALI_SPEC §5.4` names `SIM_SPEC` explicitly as the one spec that gains no
> amendment. The simulator is parameterised from **race** stints and **race** degradation
> (§1.1–§1.4): a driver base pace, one linear wear slope per compound over stints of ten laps
> and more, a pit loss and a hazard model. Qualifying has no stints worth the name — a segment
> is a handful of laps, most of them out-laps and in-laps, on tyres chosen to be fastest once
> rather than to last — so there is nothing here for it to feed. `sim_*` tables read `laps`
> only through session ids that are already race sessions, which is why the "`laps` is no longer
> race-only" rule in `SPEC §1.4` does not touch this feature.

### 0.1 What v1.1 is

One new section on `/race/[year]/[round]`, id `simulator`, title **"What if they had pitted on
lap 22?"**, placed after "Tyre degradation" and before "Race trace" (§9 D1). The fan picks a
driver, edits that driver's strategy (compound per stint, pit lap per stop, add/remove a stop) and
a Monte Carlo runs in the browser: the edited strategy and the driver's actual strategy are
simulated under the same per-race model with common random numbers, and the page shows the
distribution of the finishing-time delta, P(edited beats actual), the median gain/loss, a
lap-by-lap view and a calibration line. Python estimates every model parameter at ingest; the
browser only evaluates the model.

### 0.2 Fixed decisions (do not relitigate)

1. **Python estimates, browser simulates.** Every parameter lives in four new Postgres tables
   (§2), written by `f1lab.sim` inside `frames.build_race_frames` under the v1 `_guard`; new
   constants live in `f1lab/config.py`, so the assumption snapshot/hash changes and the first
   run after deployment creates a new `assumption_sets` row (SPEC §1.1). Nothing is estimated
   in the browser.
2. **Client engine.** `web/lib/sim/engine.ts` is pure TypeScript (no React, no DOM), driven by a
   seeded PRNG, with common random numbers between the edited and the actual strategy (paired
   design), `N = 4000` draws (§5.4), no web worker.
3. **Fuel-corrected time.** The simulation runs in `lap_time_fc_s` units. The fuel term
   `fuel_penalty_s(L)` depends only on the lap number and the race length, so it is identical
   lap-for-lap for two strategies of the same driver and cancels exactly in the delta; the
   calibration line re-adds the driver's real fuel sum once so the fan sees a wall-clock time.
4. **Slot, empty state, caption.** The section renders `<EmptyState reason>` when the race has no
   model or the selected driver has none, and always carries the verbatim caption of §6.9.
5. **"Nothing computed on request"** (SPEC §0.2) is relaxed only for the simulation itself.
6. **Calibration is part of the feature** (§1.10, §6.8): the deterministic replay of the
   driver's actual strategy vs the real fuel-corrected total, decomposed into the laps the
   model claims to describe and the laps it does not.
7. **Traffic, blue flags and overtaking are not modelled.** The answer is "how much time this
   strategy would have gained or lost in clean air", never "would they have finished ahead of
   X". The UI says so in the first sentence of the caption.

Additional decisions made here (rationale in §9):

8. Two neutralisation modes in one engine: **"As it happened"** (default; the real per-lap
   track status is replayed) and **"Random safety cars"** (circuit hazard with a prior). Both
   strategies always share the same neutralisation timeline within a draw.
9. Per-lap noise is **not drawn** in the delta engine: with common random numbers an additive
   shared noise term cancels identically, so drawing it only costs time. The delta's spread
   comes from (a) the joint parameter draw from the OLS covariance, (b) a per-stint degradation
   random effect calibrated to the observed between-stint slope scatter, (c) pit-loss
   resampling from the race's own stops, (d) in random mode, the safety-car timeline.
10. The simulation horizon for both strategies is the driver's `laps_completed`; a retired
    driver is never simulated to the flag.

### 0.3 Conventions

All SPEC §0.3 conventions hold. In addition:

- **Stint convention (written once):** a strategy is an ordered list of stints
  `{compound, endLap}`; the driver pits at the **end** of `endLap` (the in-lap is `endLap`, the
  out-lap is `endLap + 1` with tyre age 1); the last stint's `endLap` equals the horizon
  `lapsCompleted`. Tyre age `a` on a lap is `lap − stintStartLap + 1` (= `tyre_life`
  semantics, 1 on the out-lap). Pit loss is charged on the in-lap.
- **Delta sign:** `delta = edited − actual` in seconds; negative = edited faster. The UI never
  shows a bare signed number for the verdict: it says "faster"/"slower"/"about the same".
- **Lap indexing:** laps are `1..lapsCompleted`; arrays in the payload that are indexed by lap
  have length `totalLaps` and index `L − 1`.
- **Track status vocabulary** (from `lap_status.worst_status`): `'4'` = SC, `'6'|'7'` = VSC,
  `'5'` = red, everything else = green for the purposes of this feature.
- **Parameterised compound** = a slick compound with at least `SIM_MIN_COMPOUND_LAPS` (30)
  fit rows in this race. Only parameterised compounds are simulable or selectable.
- **Owner-per-file** (§7): every file named in §7 has exactly one owner; nobody else edits it.
- New `config.py` names all start with `SIM_`; new tables all start with `sim_`; the new
  `analytics_status` key is `sim` (one key, one guard).
- Seconds are shown to the fan with one decimal (`format.ts`), never more; per-lap slopes in
  the caption with three decimals (`0.084 s/lap`).

---

## 1. The race model

Everything in this section is estimated by `f1lab/sim.py` at ingest from this race's `laps`,
`lap_status`, `pit_stops` and `stints` rows (plus, for the two cross-season quantities in §1.8
and §1.9, every ingested race). Numbers quoted were verified against the live DB (2024 R13
Hungary `session_id` 16, 2025 R6 Miami 397, 2026 R1 421, 2025 R13 Belgium 405) unless marked
"expected".

### 1.1 Lap-time equation (fuel-corrected seconds)

For driver `d`, compound `c`, tyre age `a` (1 on the out-lap), race lap `L`:

```
t_fc(d, c, a, L) = base_d                       -- driver's clean-air pace on the reference compound, age 1, lap 1
                 + off_c                        -- pooled compound offset vs the reference compound (off_ref = 0)
                 + dc_{d,c}                     -- shrunk driver×compound deviation (0 when never run)
                 + (deg_c + u_slope) · (a − 1)  -- linear degradation per lap of age; u_slope = per-stint random effect
                 + u_level                      -- per-stint level random effect
                 + evo · (L − 1)                -- track evolution (negative = track gets faster)
                 + δ_L                          -- field-wide slowdown on lap L (SC/VSC/red restart/rain), shared
                 + start · 1[L == 1]            -- standing-start penalty (calibration only; cancels in the delta)
                 + ε_{d,L}                      -- lap noise (calibration/diagnostics only; NOT drawn in the delta engine)
```

Total time of a strategy over the horizon `H = laps_completed`:
`Σ_{L=1..H} t_fc + Σ_stops pit_loss_k · f(status of the in-lap)` (§1.6).

Which terms cancel in `delta = edited − actual` (same driver, same horizon, common random
numbers): `base_d`, `evo·(L−1)`, `δ_L`, `start`, `ε_{d,L}` cancel exactly lap-for-lap. They are
still estimated because the calibration replay (§1.10) needs the absolute total and because
`evo` de-confounds `deg_c`. What does not cancel: `off_c`, `dc_{d,c}`, `deg_c`, the stint random
effects (on stints that differ), pit losses of stops that differ, and the SC/VSC pit factor.

Fuel (fixed decision 3): the simulation runs in `lap_time_fc_s`; the fuel term is identical for
both strategies and cancels. The calibration line re-adds the driver's real fuel sum
`real_fuel_s = Σ(lap_time_s − lap_time_fc_s)` once (§1.10).

### 1.2 Fit rows and the joint estimator (`sim.fit_lap_model`)

Rows: this race's `laps` where `is_representative AND tyre_life >= 2 AND compound IN
parameterised set`. `is_representative` already excludes in/out-laps, non-green laps, deleted
and inaccurate laps and >107 % outliers (SPEC §1.4); `tyre_life >= 2` is a guard only (every
representative lap already has `tyre_life >= 2`, verified). The parameterised set is every
slick compound (`SIM_SLICK_COMPOUNDS`) with at least `SIM_MIN_COMPOUND_LAPS = 30` such rows;
INTERMEDIATE, WET and `NONE` are never parameterised.

Design (one `statsmodels.OLS` per race, weighted least squares with a ridge pseudo-observation):

```
y = lap_time_fc_s
X = [1{driver = d} for every driver with >= SIM_MIN_DRIVER_LAPS (8) rows]     -> base_d   (no global intercept)
  + [1{compound = c} for every parameterised c except ref]                     -> off_c    (ref = most rows)
  + [1{compound = c} · (tyre_life − 1) for every parameterised c]              -> deg_c
  + [lap_number − 1]                                                           -> evo
plus one pseudo-row: y = 0, X = 0 except evo column = 1, weight = (resid_sd_guess / SIM_EVO_PRIOR_SD)²
```

The pseudo-row is a Gaussian prior `evo ~ N(0, SIM_EVO_PRIOR_SD = 0.01 s/lap)` (ridge on evo
only). It is load-bearing exactly once in 61 races: 2025 R13 Belgium is exactly collinear (the
field pitted on the same laps; design condition number 3.8e17; plain OLS returns deg −8.3 s/lap
with se 0.009 and evo +8.3) and the ridge returns HARD 0.038, evo 0. On every other race
(condition number 400–1100) the ridge moves the estimates by < 0.001 s/lap. Implementation:
fit with `sm.WLS` on the augmented rows, `resid_sd_guess` = 0.75 s (`SIM_RESID_SD_GUESS`),
one pass; store `design_cond = np.linalg.cond(X_unaugmented)`.

Stored from the fit: the parameter vector, its full covariance for the block
`θ = [off_c (non-ref)…, deg_c…, evo]` as a Cholesky factor (§1.11), residuals, `r2`,
`resid_sd_s`, `resid_mad_s = 1.4826·MAD`, `laps_fit`, `design_cond`. Verified on Hungary 2024:
n = 1233, R² 0.61, resid sd 0.756, HARD 0.084 ± 0.003, MEDIUM 0.070 ± 0.006, SOFT 0.002 ±
0.036 (34 rows), evo −0.0043 ± 0.0013, MEDIUM +0.12 s and SOFT +0.70 s vs HARD.

Why one joint fit instead of the v1 `degradation_fits`/`compound_degradation`: 627 of the
per-stint v1 fits have a negative slope because evolution and fuel-correction leftovers dominate
a short stint; the joint fit separates evolution from degradation and driver pace from compound
offset, which is exactly the decomposition a strategy delta needs. The v1 tables are untouched.

### 1.3 Driver × compound base pace and fallbacks

`base_d` is the driver dummy (stored with its se, never sampled — it cancels). For every
(driver, parameterised compound) cell the driver actually ran (n ≥ 1 fit rows):

```
dc_{d,c}  = mean(residual of d on c) · n / (n + SIM_K_DC)        SIM_K_DC = 10 laps
dc_se     = noise_sd_d / sqrt(n + SIM_K_DC)
```

When the driver never ran `c` there is no row: `dc = 0`, `dc_se = noise_sd_d / sqrt(SIM_K_DC)`
(browser rule), and the payload cell carries `dcLaps = 0` so the editor can say "pace on HARD
uses the field's offset, not this driver's". A full driver×compound interaction improves the
residual sd only 0.748 → 0.716 (Hungary), so the additive model with shrinkage is the right
size. `dc` is sampled per draw (`N(dc, dc_se)`, independent across cells) because it does not
cancel when the edited strategy changes compounds.

A driver with fewer than `SIM_MIN_DRIVER_LAPS = 8` fit rows has no dummy and no
`sim_driver_params` row (selector: "not enough clean laps to model").

### 1.4 Degradation per compound, negative slopes, extrapolation

`deg_c` is pooled per compound from the joint fit (driver- and evolution-adjusted), never per
driver-stint: per-stint slopes scatter with sd 0.045 (HARD, 30 stints) / 0.056 (MEDIUM) around
the pooled value at Hungary, about 15× the pooled se — per-stint slopes are mostly noise on top
of the compound line, and that scatter is what §1.5 models. Rules:

- `deg_raw_s_per_lap` is stored as fitted. The simulated slope is `deg_s_per_lap =
  max(deg_raw, SIM_DEG_FLOOR)` with `SIM_DEG_FLOOR = 0.0` (§9 D3: a tyre is never simulated as
  getting faster with age; 2026 R1 MEDIUM −0.020 ± 0.010 becomes 0 with `deg_negative = true`).
  The editor shows "no measurable degradation on this tyre in this race" next to such a
  compound; the sampled slope is clamped at the floor after sampling too.
- `age_max` = max `tyre_life` among the fit rows of `c`. A planned stint longer than
  `age_max + SIM_EXTRAPOLATION_LAPS (5)` is flagged in the editor ("longer than any real stint
  on this tyre — the line is extrapolated"). Linear extrapolation, no cliff model.
- SOFT at Hungary 2024 has exactly 34 fit rows: parameterised (≥ 30) with se 0.036, which the
  editor surfaces as "± 0.036 s/lap".

### 1.5 Between-stint scatter (the predictive part of the interval)

With common random numbers the parameter-se-only interval is model-conditional: a pit-on-20 vs
pit-on-25 edit at Hungary gives delta 12.2 s with a p10–p90 band of 10.8–13.5 s from the fit
covariance alone, while real stints on the same compound scatter 15× more. So the model
carries a per-stint random effect per compound, estimated from the fit residuals
(`sim.stint_scatter`):

```
for every stint i of the fit rows with n_i >= SIM_STINT_MIN_LAPS (8) on compound c:
    r_i(a) = residual of the joint fit on that stint's rows
    OLS r_i ~ v_i + w_i · (a − 1)            -> level v_i (se_v_i), slope w_i (se_w_i)
tau_level_c² = max(0, var(v_i) − mean(se_v_i²))       sample variance over stints of c
tau_slope_c² = max(0, var(w_i) − mean(se_w_i²))
```
Requires `stints_used >= SIM_STINT_MIN_STINTS (5)` on `c`; otherwise the pooled priors
`SIM_STINT_TAU_LEVEL_PRIOR = 0.25 s` and `SIM_STINT_TAU_SLOPE_PRIOR = 0.04 s/lap` are stored
with `stint_tau_source = 'prior'`. Both are capped (`SIM_STINT_TAU_LEVEL_MAX = 0.8`,
`SIM_STINT_TAU_SLOPE_MAX = 0.10`). Per draw and per stint index `k` the engine draws
`u_level ~ N(0, tau_level_c)`, `u_slope ~ N(0, tau_slope_c)` (§5.3 pairing rule: an edited stint
`k` shares the draw of actual stint `k` when it uses the same compound; otherwise it gets its
own). Expected magnitude (Hungary, HARD 25-lap stint): sd ≈ sqrt((0.25·25)² + (0.045·300)²)
≈ 15 s — the honest predictive spread of one stint. Python also stores a leave-one-stint-out
coverage diagnostic (§1.10, `stint_coverage_80`).

### 1.6 Pit loss for THIS race (`sim.pit_loss`)

For every `pit_stops` row of the race with `lap_out IS NOT NULL`, `lap_in > 1`, both laps with a
`lap_time_s`, and both `compound_in`/`compound_out` parameterised:

```
excess_k = (t_fc[lap_in] + t_fc[lap_out]) − (model[lap_in] + model[lap_out]) − δ[lap_in] − δ[lap_out]
model[L] = base_d + off_c + dc_{d,c} + deg_c · (a − 1) + evo · (L − 1)   (point estimates, with the in-lap's real age
                                                                          and the out-lap at age 1)
```
Measuring against the **model** (not the driver's median lap) nets out the in-lap's tyre age
and the race-time position of the stop, so the ~1–2 s age penalty of an old-tyre in-lap is not
double-counted with `deg·(a−1)` in the simulator (§9 D4). The out-lap's warm-up is inside
`excess_k`; there is no separate warm-up term (tyre_life 2 vs 3 medians differ by < 0.05 s).

- **Green stops** = `worst_status ∈ {'1','2'}` on both `lap_in` and `lap_out`. Stored:
  `pit_loss_samples_s` (every green `excess_k`, at most `SIM_PIT_SAMPLES_MAX = 60`, the
  ones nearest the median kept), `pit_loss_s` (median), `pit_loss_mad_s`, `pit_loss_n`.
  Verified: Hungary 20.2 s (P3 definition) / 20.7 s (this definition, n = 39, MAD 1.6);
  pooled over 203 green stops p25 20.8 / median 22.5 / p75 24.4.
- When `pit_loss_n < SIM_MIN_GREEN_STOPS (5)` the race row stores `pit_loss_s = NULL`,
  `pit_loss_n`, an empty sample array; the browser falls back to the pooled value from the
  hazard row (§1.9, `pit_loss_pooled_s`, `pit_loss_pooled_mad_s`) and the payload says
  `pitLossSource = 'pooled'`. Nothing per-session depends on other sessions (§9 D6).
- Per draw, each stop index `k` resamples one value from `pit_loss_samples_s` (with
  replacement; `pooled` source → `median + mad·1.4826·t_4`); the same value is used for stop `k`
  of both strategies (common random numbers). A stop that exists only in the edited strategy
  gets the next sample.

### 1.7 Stops under SC / VSC (`sim.sc_pit_factor`)

Measured, not asserted (§9 D5). Verified against the live DB with the raw-time analogue of
`excess_k` (in-lap + out-lap minus the field median of non-pitting cars on those laps, 61
races): green stops n = 1328 median 22.4 s (p25 20.1, p75 25.1); stops whose in-lap **and**
out-lap were SC laps n = 99 median 19.3 s (p25 10.6, p75 27.4); stops whose in-lap was a VSC
lap n = 132 median 21.2 s (p25 16.4, p75 32.2). Relative to the field on the same laps a stop
under a full SC costs about 0.86 of a green stop and under VSC about 0.95 — the "free stop"
fans see on TV is the field bunching up, a position effect this simulator does not model, and
the caption says so verbatim.

Per race: `sc_pit_samples_s` = `excess_k` (model-based, §1.6) of every stop with
`worst_status = '4'` on `lap_in` (at most 60); `vsc_pit_samples_s` likewise for `'6'|'7'`.
`sc_pit_factor_race = median(sc_pit_samples_s) / pit_loss_s` when both `len >= SIM_MIN_SC_STOPS
(3)` and `pit_loss_s` is not NULL, else NULL; same for `vsc_pit_factor_race`. The browser uses
the race value when present, else the pooled factor from the hazard row (§1.9), else the config
priors `SIM_SC_PIT_FACTOR_PRIOR = 0.86`, `SIM_VSC_PIT_FACTOR_PRIOR = 0.95` (which the payload
also carries). Classification is by `worst_status` of the in-lap, never by a δ threshold (fixes
the VSC inconsistency the judges found): `'4'` and `'5'` → `f_sc`, `'6'|'7'` → `f_vsc`, else 1.
In "as it happened" mode the factor multiplies the resampled loss of that stop; in random mode
it applies when the drawn state of the in-lap is SC/VSC.

### 1.8 Field-wide slowdown δ_L, start penalty, noise

- `δ_L` (`sim.lap_deltas`): for every lap `L = 2..total_laps`, the median over all cars with a
  lap time on `L` that are not on an in-lap or out-lap of `lap_time_fc_s − model[L]` (model as
  in §1.6, drivers without a dummy excluded); 0 on lap 1 and when fewer than
  `SIM_MIN_CARS_FOR_DELTA (3)` cars qualify. Stored as `field_delta_s double precision[]`
  (length `total_laps`, index `L−1`) and `field_delta_cars integer[]`. Verified: SC laps with
  ≥ 80 % of cars affected have δ median +36.8 s (p10 34.0, p90 37.9); VSC +23.8 s (8.1–28.5);
  the per-race SC ratio spans 1.12–1.54, which is why a global SC factor is not used anywhere.
  δ is shared lap-for-lap and cancels in the delta; it is used by the calibration replay and by
  the lap-by-lap chart's SC bands.
- `start_penalty_s` (`sim.start_penalty`): median over all cars with a lap-1 time of
  `t_fc[1] − model[1]` (verified median 7.0 s, p10–p90 5.5–10.7 across races). Calibration only.
- `noise_sd_s` per driver = `1.4826·MAD(residuals of d)`, floored at `SIM_NOISE_SD_FLOOR = 0.25`
  (residuals have kurtosis 7.1 and skew 1.8 at Hungary, so a robust scale is used). It enters
  `dc_se` (§1.3) and the coverage diagnostic; it is **not** drawn in the delta engine
  (fixed decision 9) and the caption does not quote it.

### 1.9 Circuit neutralisation hazard and pooled priors (cross-season, `sim.recompute_hazards`)

Rewritten for every circuit at the end of every ingest run and by `--recompute-hazards`, from
the stored rows of every ok/partial race (`lap_status`, `sessions`, `events.circuit_key`,
`sim_race_params`); never read during a session's own fit, so per-session rows are
ingest-order independent (§9 D6).

Episodes: a maximal run of consecutive `worst_status = '4'` laps is one SC episode; `'6'|'7'`
one VSC episode; `'5'` laps are ignored (10 laps in 61 races; a red flag rewrites the race).
Field history (61 races, 3,686 laps): 36 SC episodes (hazard 0.0098/lap, mean length 5.44,
median 5), 39 VSC (0.0106/lap, mean 3.62); 31 % of SC episodes start on lap ≤ 2.

```
sc_hazard_c   = (k_sc_c(laps >= 3) + SIM_PRIOR_SC_LAPS · sc_pooled) / (n_laps_c(laps >= 3) + SIM_PRIOR_SC_LAPS)
vsc_hazard_c  = same with VSC                                  SIM_PRIOR_SC_LAPS = 200 (≈ 3 races of weight)
sc_pooled     = episodes / laps over all races, laps >= 3     (≈ 0.0075 expected; stored, not hard-coded)
sc_start_p    = SC episodes starting on lap 1 or 2 / races    (pooled, ≈ 0.18; applied once per simulated race)
vsc_start_p   = same for VSC
```
Durations: Geometric on {1, 2, …} with `p = 1/mean` (`sc_dur_mean`, `vsc_dur_mean`, pooled;
§9 D7). The per-circuit row also carries the pooled fallbacks the browser needs:
`pit_loss_pooled_s`, `pit_loss_pooled_mad_s` (median/MAD over every race's green samples),
`sc_pit_factor_pooled`, `vsc_pit_factor_pooled` (median over all races' SC/VSC samples divided
by the pooled green median). Per-circuit `pit_loss_circuit_s` (median over the circuit's races'
green samples, NULL when < 5 samples) is stored for the caption; the browser prefers race >
circuit > pooled for pit loss.

### 1.10 Calibration (fixed decision 6, made precise; `sim.calibrate`)

For every driver with a dummy whose **every timed lap** is on a parameterised compound (or is
a pit in/out-lap), Python runs the deterministic model (every parameter at its point estimate,
random effects 0, ε = 0, pit loss = `pit_loss_s` or the pooled value, SC/VSC factors as §1.7)
over the actual strategy (from `stints` and `pit_stops`) with the real `δ_L` and the start
penalty, for laps `1..laps_completed`, and stores per driver:

| column | definition |
|---|---|
| `laps_completed` | `results.laps` (the horizon `H`) |
| `laps_timed` | laps with a `lap_time_s` |
| `laps_modelled` | timed laps that are fit rows (representative) |
| `unmodelled_laps` | timed laps that are neither fit rows nor in/out-laps nor lap 1 |
| `stops` | `pit_stops` rows with `lap_out NOT NULL` |
| `real_total_fc_s` | Σ `lap_time_fc_s` over timed laps |
| `real_fuel_s` | Σ (`lap_time_s − lap_time_fc_s`) over timed laps |
| `real_total_s` | Σ `lap_time_s` over timed laps |
| `sim_total_fc_s` | deterministic replay total over timed laps (model + δ + start + stops) |
| `misfit_rep_s` | Σ over modelled laps of (real − model − δ) |
| `misfit_pit_s` | Σ over in/out-laps of (real − model − δ) − Σ_stops charged loss |
| `misfit_lap1_s` | lap-1 real − model − start_penalty |
| `unmodelled_s` | Σ over unmodelled laps of (real − model − δ) |
| `badge` | `'calibrated'` if `abs(misfit_rep_s)/laps_modelled <= SIM_CALIB_GOOD_S_PER_LAP (0.15)`, `'rough'` if `<= SIM_CALIB_ROUGH_S_PER_LAP (0.40)`, else `'poor'` |
| `simulable` / `not_simulable_reason` | `false` with a reason when the driver ran a non-parameterised compound on any timed lap, or `laps_modelled < SIM_MIN_MODELLED_LAPS (20)`, or `laps_completed < 2`, or the driver's `stints` rows do not tile `1..laps_completed` contiguously (reason `stint data incomplete`) |

`sim_total_fc_s − real_total_fc_s == misfit_rep_s + misfit_pit_s + misfit_lap1_s + unmodelled_s`
(sign flipped) holds to 1e-9 — a stored identity the tests assert. Measured decomposition
(field median): clean-air misfit +2 … +6 s per race (0.05–0.1 s/lap, within lap noise);
unmodelled laps −0.2 … +22 s (2026 R7 Ocon: 6 laps, +48 s); lap 1 within ±3 s of the start
penalty. The fan-facing line (§6.8) shows the modelled and unmodelled parts separately and
converts totals to wall-clock by adding `real_fuel_s` to both sides; the badge is computed
from the modelled part only and the caption says so.

Coverage diagnostic (`stint_coverage_80`, per race): for every stint used in §1.5, predict the
stint's total from the model with the stint's own random effects set to 0 and compare with the
real total; the fraction of stints whose real total lies within ±1.28·sd_stint (sd from
`tau_level`, `tau_slope`, `noise_sd`) is stored. Expected 0.7–0.9; the Hungary test asserts
[0.6, 0.95]. Not shown to the fan.

### 1.11 Sampled per draw vs fixed

| Sampled per draw (shared between edited and actual) | How | Fixed |
|---|---|---|
| `θ = [off_c…, deg_c…, evo]` | one joint draw `θ = θ̂ + Lz`, `z ~ N(0, I)`, `L` = Cholesky factor of the OLS covariance (§9 D2); `deg` clamped at `SIM_DEG_FLOOR` after the draw | `base_d`, `δ_L`, `start`, `noise_sd`, hazards, `age_max`, `H` |
| `dc_{d,c}` per cell the driver's strategies use | `N(dc, dc_se)`, independent | |
| `u_level_k`, `u_slope_k` per stint index | `N(0, tau_level_c)`, `N(0, tau_slope_c)`; pairing rule §5.3 | |
| pit loss per stop index | resample from `pit_loss_samples_s` (or `median + mad·1.4826·t_4`) | SC/VSC pit factors |
| SC/VSC timeline (random mode only) | lap-1/2 start draw, then per-lap Bernoulli; Geometric duration | in as-happened mode the real `worst_status` per lap |

`ε_{d,L}` is not drawn (fixed decision 9). `evo` is sampled only because it is in `θ`; it
cancels anyway.

### 1.12 When there is no model (`analytics_status.sim`)

`sim.fit_race` raises `SimNotEstimable(ValueError)` (→ `_guard` records `error:
SimNotEstimable: <reason>`, session `partial`, every sim table `empty_frame`) when: fewer than
2 parameterised compounds; fewer than `SIM_MIN_FIT_LAPS (200)` fit rows; more than 50 % of the
race's representative laps on INTERMEDIATE/WET (rain race: 2025 R1 has 35 slick vs 505
INTERMEDIATE representative laps); fewer than `SIM_MIN_DRIVERS (6)` drivers with a dummy; or
`design_cond > SIM_DESIGN_COND_MAX (1e6)` **after** the ridge (never observed; the ridge makes
Belgium 2025 well-conditioned). A race that fits but has no simulable driver still writes its
tables; the page then shows the section's empty state "no driver of this race can be simulated".

### 1.13 Constants → `f1lab/config.py` (all enter the assumption snapshot)

```python
# --- Strategy simulator (SPEC v1.1 §1). Every value is copied into the payload; the browser never hard-codes one.
SIM_SLICK_COMPOUNDS = ("SOFT", "MEDIUM", "HARD")
SIM_MIN_COMPOUND_LAPS = 30        # fit rows a compound needs to be parameterised
SIM_MIN_DRIVER_LAPS = 8           # fit rows a driver needs a dummy (matches pace_ranking min_laps)
SIM_MIN_DRIVERS = 6
SIM_MIN_FIT_LAPS = 200
SIM_EVO_PRIOR_SD = 0.01           # s/lap, ridge pseudo-observation on evo
SIM_RESID_SD_GUESS = 0.75         # s, weight of the pseudo-observation
SIM_DESIGN_COND_MAX = 1e6
SIM_K_DC = 10                     # shrinkage laps for driver x compound
SIM_DEG_FLOOR = 0.0               # s/lap
SIM_EXTRAPOLATION_LAPS = 5
SIM_STINT_MIN_LAPS = 8
SIM_STINT_MIN_STINTS = 5
SIM_STINT_TAU_LEVEL_PRIOR = 0.25  # s
SIM_STINT_TAU_SLOPE_PRIOR = 0.04  # s/lap
SIM_STINT_TAU_LEVEL_MAX = 0.8
SIM_STINT_TAU_SLOPE_MAX = 0.10
SIM_NOISE_SD_FLOOR = 0.25
SIM_NOISE_T_DF = 4                # used only by the pooled pit-loss fallback draw
SIM_MIN_GREEN_STOPS = 5
SIM_PIT_SAMPLES_MAX = 60
SIM_MIN_SC_STOPS = 3
SIM_SC_PIT_FACTOR_PRIOR = 0.86    # measured, 99 SC stops / 1328 green stops, 2024-26
SIM_VSC_PIT_FACTOR_PRIOR = 0.95   # measured, 132 VSC stops
SIM_MIN_CARS_FOR_DELTA = 3
SIM_PRIOR_SC_LAPS = 200
SIM_MIN_MODELLED_LAPS = 20
SIM_CALIB_GOOD_S_PER_LAP = 0.15
SIM_CALIB_ROUGH_S_PER_LAP = 0.40
SIM_DRAWS = 4000                  # browser N; copied into the payload so the caption and engine agree
SIM_SEED = 20240101
```

---

## 2. Schema

Five new tables: four per-session (all `session_id … ON DELETE CASCADE`, all with
`assumption_set_id`, all written by `COPY` inside the session's transaction like every other
analytic) and one circuit-level table rewritten at the end of every run. The driver's actual
strategy is **not** duplicated — the query layer reads it from `stints`/`pit_stops`/`results`.
Arrays are `double precision[]` / `integer[]` / `text[]` (psycopg 3 `COPY` writes a Python
`list` as a Postgres array; see §3.4 for the one `frames.py` helper change this needs).

### 2.1 DDL (`web/drizzle/0001_sim.sql`, generated from `web/db/schema/sim.ts`)

```sql
-- One row per race with a model (f1lab.sim.fit_race → SimFit.race_params).
CREATE TABLE sim_race_params (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  total_laps            integer NOT NULL,
  ref_compound          text NOT NULL,                 -- compound whose offset is 0 (most fit rows)
  laps_fit              integer NOT NULL,              -- fit rows (§1.2)
  drivers_fit           integer NOT NULL,              -- drivers with a dummy
  r2                    double precision NOT NULL,
  resid_sd_s            double precision NOT NULL,
  resid_mad_s           double precision NOT NULL,     -- 1.4826 * MAD of the residuals
  design_cond           double precision NOT NULL,     -- condition number of the un-augmented design (diagnostic)
  evo_s_per_lap         double precision NOT NULL,     -- ridge estimate (point value; also inside param_mean)
  evo_se                double precision NOT NULL,
  param_names           text[] NOT NULL,               -- e.g. {off:MEDIUM,off:SOFT,deg:HARD,deg:MEDIUM,deg:SOFT,evo}
  param_mean            double precision[] NOT NULL,   -- same order as param_names (k values)
  param_chol            double precision[] NOT NULL,   -- k*k row-major lower-triangular Cholesky factor of cov(θ)
  field_delta_s         double precision[] NOT NULL,   -- δ_L, length total_laps, index L-1 (§1.8)
  field_delta_cars      integer[] NOT NULL,            -- cars behind each median (0 → δ = 0)
  start_penalty_s       double precision NOT NULL,     -- field median lap-1 excess over the model
  pit_loss_s            double precision,              -- median green-stop excess (§1.6); NULL when pit_loss_n < SIM_MIN_GREEN_STOPS
  pit_loss_mad_s        double precision,
  pit_loss_n            integer NOT NULL,
  pit_loss_samples_s    double precision[] NOT NULL,   -- ≤ SIM_PIT_SAMPLES_MAX green excesses; {} when pit_loss_s IS NULL
  sc_pit_samples_s      double precision[] NOT NULL,   -- excess of stops whose in-lap was an SC lap (≤ 60)
  vsc_pit_samples_s     double precision[] NOT NULL,   -- … a VSC lap
  sc_pit_factor_race    double precision,              -- median(sc_pit_samples)/pit_loss_s when ≥ SIM_MIN_SC_STOPS and pit_loss_s NOT NULL
  vsc_pit_factor_race   double precision,
  stint_coverage_80     double precision,              -- §1.10 diagnostic; NULL when < 5 stints qualified
  n_sc_laps             integer NOT NULL,              -- worst_status = '4' laps in this race
  n_vsc_laps            integer NOT NULL,              -- '6' | '7'
  n_red_laps            integer NOT NULL,              -- '5'
  PRIMARY KEY (session_id)
);

-- One row per parameterised compound (§1.2, §1.4, §1.5).
CREATE TABLE sim_compound_params (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  compound              text NOT NULL,
  laps                  integer NOT NULL,              -- fit rows on this compound
  age_max               integer NOT NULL,              -- longest tyre_life among the fit rows
  offset_s              double precision NOT NULL,     -- vs ref_compound (0 for ref)
  offset_se             double precision NOT NULL,     -- 0 for ref
  deg_raw_s_per_lap     double precision NOT NULL,     -- as fitted
  deg_s_per_lap         double precision NOT NULL,     -- max(deg_raw, SIM_DEG_FLOOR)
  deg_se                double precision NOT NULL,
  deg_negative          boolean NOT NULL,              -- deg_raw < SIM_DEG_FLOOR
  stint_tau_level_s     double precision NOT NULL,     -- §1.5 (after cap)
  stint_tau_slope       double precision NOT NULL,     -- s/lap
  stint_tau_source      text NOT NULL CHECK (stint_tau_source IN ('race','prior')),
  stints_used           integer NOT NULL,              -- stints with >= SIM_STINT_MIN_LAPS rows on this compound
  PRIMARY KEY (session_id, compound)
);

-- One row per driver with a dummy in the fit; calibration columns are NULL when simulable = false.
CREATE TABLE sim_driver_params (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id             text NOT NULL,
  laps_fit              integer NOT NULL,
  base_s                double precision NOT NULL,     -- driver dummy (ref compound, age 1, lap 1)
  base_se               double precision NOT NULL,
  noise_sd_s            double precision NOT NULL,     -- max(1.4826*MAD(resid_d), SIM_NOISE_SD_FLOOR)
  laps_completed        integer NOT NULL,              -- results.laps_completed (the horizon H)
  laps_timed            integer NOT NULL,
  laps_modelled         integer NOT NULL,
  unmodelled_laps       integer NOT NULL,
  stops                 integer NOT NULL,              -- pit_stops rows with lap_out NOT NULL
  simulable             boolean NOT NULL,
  not_simulable_reason  text,                          -- NULL iff simulable
  real_total_s          double precision,              -- Σ lap_time_s over timed laps
  real_total_fc_s       double precision,              -- Σ lap_time_fc_s
  real_fuel_s           double precision,              -- Σ (lap_time_s − lap_time_fc_s)
  sim_total_fc_s        double precision,              -- deterministic replay (§1.10)
  misfit_rep_s          double precision,
  misfit_pit_s          double precision,
  misfit_lap1_s         double precision,
  unmodelled_s          double precision,
  badge                 text CHECK (badge IN ('calibrated','rough','poor')),
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Shrunk driver × compound deviation; a row exists only where the driver has >= 1 fit row on the compound.
CREATE TABLE sim_driver_compound (
  session_id            integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  driver_id             text NOT NULL,
  compound              text NOT NULL,
  laps                  integer NOT NULL,
  dc_offset_s           double precision NOT NULL,     -- mean residual · n/(n + SIM_K_DC)
  dc_se                 double precision NOT NULL,     -- noise_sd_s / sqrt(n + SIM_K_DC)
  PRIMARY KEY (session_id, driver_id, compound),
  FOREIGN KEY (session_id, driver_id) REFERENCES session_entries(session_id, driver_id)
);

-- Circuit hazard + pooled fallbacks (§1.9). Rewritten for EVERY circuit that has an ok/partial race
-- at the end of each ingest run and by --recompute-hazards; rows of circuits with no race left are deleted.
-- Not a session child: no cascade. Pooled columns repeat the same value on every row on purpose
-- (one query reads one row).
CREATE TABLE sim_circuit_hazard (
  circuit_key           integer NOT NULL REFERENCES circuits(circuit_key),
  assumption_set_id     integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  recomputed_at         timestamptz NOT NULL,
  races                 integer NOT NULL,              -- races of this circuit used
  laps                  integer NOT NULL,              -- lap_status rows with lap_number >= 3
  sc_episodes           integer NOT NULL,              -- episodes starting on lap >= 3
  vsc_episodes          integer NOT NULL,
  sc_hazard             double precision NOT NULL,     -- Beta-binomial posterior (§1.9)
  vsc_hazard            double precision NOT NULL,
  pit_loss_circuit_s    double precision,              -- median of the circuit's races' green samples; NULL when < 5
  -- pooled over every ingested race (identical on every row):
  pooled_races          integer NOT NULL,
  sc_hazard_pooled      double precision NOT NULL,
  vsc_hazard_pooled     double precision NOT NULL,
  sc_start_p            double precision NOT NULL,     -- P(an SC episode starts on lap 1 or 2) per race
  vsc_start_p           double precision NOT NULL,
  sc_dur_mean           double precision NOT NULL,     -- mean episode length in laps
  vsc_dur_mean          double precision NOT NULL,
  pit_loss_pooled_s     double precision NOT NULL,
  pit_loss_pooled_mad_s double precision NOT NULL,
  sc_pit_factor_pooled  double precision NOT NULL,     -- median(all sc samples) / pit_loss_pooled_s
  vsc_pit_factor_pooled double precision NOT NULL,
  PRIMARY KEY (circuit_key)
);
```

Row volume per race: 1 + ≤ 3 + ≤ 22 + ≤ 66 ≈ 90 rows; 71 races ≈ 6.5 k rows plus ≤ 30 circuit
rows. No new indexes: every read is by primary key.

### 2.2 Populating functions (Python owns every value; §3.1)

| table | producer | rows |
|---|---|---|
| `sim_race_params` | `sim.fit_race(...)` → `SimFit.race_params` (1 row) | 1 |
| `sim_compound_params` | `SimFit.compound_params` | parameterised compounds |
| `sim_driver_params` | `SimFit.driver_params` (fit + `sim.calibrate` merged) | drivers with a dummy |
| `sim_driver_compound` | `SimFit.driver_compound` | cells with ≥ 1 fit row |
| `sim_circuit_hazard` | `sim.recompute_hazards(conn, assumption_set_id)` — `DELETE` + `COPY` in one `_committed` block | one per circuit with a race |

### 2.3 `frames.py` contract additions (owner: Python package)

```python
TABLE_COLUMNS["sim_race_params"] = [("session_id","int"),("assumption_set_id","int"),("total_laps","int"),
    ("ref_compound","text"),("laps_fit","int"),("drivers_fit","int"),("r2","float"),("resid_sd_s","float"),
    ("resid_mad_s","float"),("design_cond","float"),("evo_s_per_lap","float"),("evo_se","float"),
    ("param_names","text[]"),("param_mean","float[]"),("param_chol","float[]"),("field_delta_s","float[]"),
    ("field_delta_cars","int[]"),("start_penalty_s","float"),("pit_loss_s","float"),("pit_loss_mad_s","float"),
    ("pit_loss_n","int"),("pit_loss_samples_s","float[]"),("sc_pit_samples_s","float[]"),("vsc_pit_samples_s","float[]"),
    ("sc_pit_factor_race","float"),("vsc_pit_factor_race","float"),("stint_coverage_80","float"),
    ("n_sc_laps","int"),("n_vsc_laps","int"),("n_red_laps","int")]
TABLE_COLUMNS["sim_compound_params"] = [("session_id","int"),("assumption_set_id","int"),("compound","text"),
    ("laps","int"),("age_max","int"),("offset_s","float"),("offset_se","float"),("deg_raw_s_per_lap","float"),
    ("deg_s_per_lap","float"),("deg_se","float"),("deg_negative","bool"),("stint_tau_level_s","float"),
    ("stint_tau_slope","float"),("stint_tau_source","text"),("stints_used","int")]
TABLE_COLUMNS["sim_driver_params"] = [("session_id","int"),("assumption_set_id","int"),("driver_id","text"),
    ("laps_fit","int"),("base_s","float"),("base_se","float"),("noise_sd_s","float"),("laps_completed","int"),
    ("laps_timed","int"),("laps_modelled","int"),("unmodelled_laps","int"),("stops","int"),("simulable","bool"),
    ("not_simulable_reason","text"),("real_total_s","float"),("real_total_fc_s","float"),("real_fuel_s","float"),
    ("sim_total_fc_s","float"),("misfit_rep_s","float"),("misfit_pit_s","float"),("misfit_lap1_s","float"),
    ("unmodelled_s","float"),("badge","text")]
TABLE_COLUMNS["sim_driver_compound"] = [("session_id","int"),("assumption_set_id","int"),("driver_id","text"),
    ("compound","text"),("laps","int"),("dc_offset_s","float"),("dc_se","float")]
TABLE_COLUMNS["sim_circuit_hazard"] = [("circuit_key","int"),("assumption_set_id","int"),("recomputed_at","timestamptz"),
    ("races","int"),("laps","int"),("sc_episodes","int"),("vsc_episodes","int"),("sc_hazard","float"),("vsc_hazard","float"),
    ("pit_loss_circuit_s","float"),("pooled_races","int"),("sc_hazard_pooled","float"),("vsc_hazard_pooled","float"),
    ("sc_start_p","float"),("vsc_start_p","float"),("sc_dur_mean","float"),("vsc_dur_mean","float"),
    ("pit_loss_pooled_s","float"),("pit_loss_pooled_mad_s","float"),("sc_pit_factor_pooled","float"),
    ("vsc_pit_factor_pooled","float")]

RACE_TABLE_ORDER += ["sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound"]  # after track_status_events
ANALYTICS += ["sim"]                                       # ONE status key for the four per-session tables
```
`EXPECTED_COLUMNS` derives from `TABLE_COLUMNS`, so `db.assert_schema` / `--check-schema`
demands the five tables until migration 0001 is applied (the intended gate, as in v1 WP1
Milestone 1). The kinds comment gains `float[] | int[]`; `cast_frame` needs no change (unknown
kinds pass through as objects; `_is_null` already returns `False` for `list` and `_py`
returns it unchanged — `sim.py` must build arrays as lists of plain Python `float`/`int`/`str`,
never numpy scalars or arrays). `db.SESSION_CHILD_TABLES`
(an explicit list — NOT derived from `RACE_TABLE_ORDER`) gains the four per-session tables at
its **front** (they reference `session_entries`, which is deleted later in the list).
`RENAMES` gains identity entries for the four tables (frames from `sim.py` already use DB
column names; the entry exists for greppability).

### 2.4 Drizzle transcription notes (owner: web schema package)

- `web/db/schema/sim.ts`: five `pgTable`s with explicit snake_case names (SPEC §3.2);
  `doublePrecision('x').array().notNull()`, `integer('x').array().notNull()`,
  `text('param_names').array().notNull()`; `timestamp('recomputed_at', { withTimezone: true,
  mode: 'string' })`; `check('sim_compound_params_tau_source', sql\`stint_tau_source IN
  ('race','prior')\`)`, `check('sim_driver_params_badge', sql\`badge IN
  ('calibrated','rough','poor')\`)`; composite FKs to `session_entries` via `foreignKey({...})`
  (no cascade on that one, as in `pace_ranking`); `circuits` import from `./reference`.
- `web/db/schema/index.ts` gains `export * from "./sim";` (the only edit to that file).
- `cd web && npx drizzle-kit generate --name sim` → `drizzle/0001_sim.sql` + snapshot + journal
  entry; review by eye against §2.1 (drizzle emits `CREATE TABLE` then `ALTER TABLE … ADD
  CONSTRAINT … FOREIGN KEY`; that is fine). `npm run db:migrate`; then
  `python -m f1lab.ingest --check-schema` must exit 0 once §2.3 is in — the drift detector
  between the two languages.
- Never hand-edit the generated SQL; if the DDL and the TS disagree, the TS is wrong.

---

## 3. Python

### 3.1 Module layout

```
f1lab/sim.py              NEW  estimation + deterministic replay (pure functions on DataFrames; DB only in recompute_hazards)
f1lab/config.py           +    the SIM_* constants of §1.13 (nothing else changes)
f1lab/frames.py           +    §2.3 contract lines, the fc_all binding, the _guard hook and four cast blocks (§3.2)
f1lab/db.py               +    SESSION_CHILD_TABLES gains the four sim tables at the front (§2.3)
f1lab/ingest.py           +    sim.recompute_hazards at run end; --recompute-hazards flag (§3.4)
f1lab/assumptions.py      unchanged (every sim parameter is a config constant; CALL_SITE_PARAMS untouched)
tests/test_sim.py         NEW  no-db tests on the cached fixtures + synthetic frames (§3.5)
tests/test_sim_db.py      NEW  db-marked: schema, hazards, idempotency
tests/fixtures/sim_golden.json   NEW  generated by tests/test_sim.py::test_write_golden (§3.6); read by the web engine test
```

`f1lab/sim.py` signatures (docstrings are the contract):

```python
"""Race-model parameters for the browser Monte Carlo (SIM_SPEC §1). Estimation and one deterministic
replay; nothing random happens here. Inputs use FastF1 column names (Driver, LapNumber, Compound,
TyreLife, Stint, LapTimeFuelCorrected ...) exactly as frames._laps_frame's `fc` frame carries them."""

class SimNotEstimable(ValueError):
    """Raised by fit_race when §1.12 says there is no model. Subclasses ValueError so frames._guard
    records 'error: SimNotEstimable: <reason>' and the session goes 'partial', never 'failed'."""

@dataclass(frozen=True)
class LapModel:
    """The joint fit of §1.2. names: ['base:VER', ..., 'off:MEDIUM', ..., 'deg:HARD', ..., 'evo'];
    beta/se aligned with names; cov: full covariance (k_all x k_all); resid: Series aligned with the fit rows;
    r2, resid_sd, resid_mad, design_cond, ref_compound, drivers (list[str]), compounds (list[str])."""

@dataclass(frozen=True)
class SimFit:
    race_params: pd.DataFrame       # 1 row; columns == EXPECTED_COLUMNS['sim_race_params'] minus session_id/assumption_set_id
    compound_params: pd.DataFrame   # DB column names; 'compound' upper-case
    driver_params: pd.DataFrame     # column 'Driver' (FastF1 code) instead of driver_id; frames.py resolves ids
    driver_compound: pd.DataFrame   # 'Driver', 'compound', laps, dc_offset_s, dc_se
    warnings: list[str]             # e.g. 'sim: SOFT not parameterised (12 fit rows < 30)', 'sim: MEDIUM degradation -0.020 floored to 0'
    def __len__(self) -> int: return len(self.race_params)   # _guard calls len(); 1 when fitted

def fit_rows(fc_all: pd.DataFrame, min_compound_laps: int) -> tuple[pd.DataFrame, list[str], dict[str, int]]:
    """(rows, parameterised compounds, dropped {compound: n}) per §1.2. Raises SimNotEstimable on the §1.12 rules
    that are decidable before the fit (rain race, < 2 compounds, < SIM_MIN_FIT_LAPS rows)."""

def fit_lap_model(rows: pd.DataFrame, *, evo_prior_sd: float, resid_sd_guess: float,
                  min_driver_laps: int) -> LapModel:
    """WLS with driver dummies, compound offsets, per-compound deg on (TyreLife-1), evo on (LapNumber-1)
    and the evo ridge pseudo-observation (§1.2). Drivers with < min_driver_laps rows are dropped from the rows
    before the design is built. Raises SimNotEstimable when < SIM_MIN_DRIVERS drivers remain or
    design_cond > SIM_DESIGN_COND_MAX."""

def predict(model: LapModel, driver: str, compound: str, age: int, lap: int, dc: float = 0.0) -> float:
    """base_d + off_c + dc + deg_c*(age-1) + evo*(lap-1). The one formula; every other function calls it."""

def driver_compound_dev(rows, model, k_dc: int) -> pd.DataFrame          # §1.3
def stint_scatter(rows, model, *, min_laps, min_stints, priors, caps) -> pd.DataFrame   # §1.5, per compound
def lap_deltas(fc_all, pits, model, dc: pd.DataFrame, total_laps: int, min_cars: int) -> tuple[list[float], list[int]]  # §1.8
def start_penalty(fc_all, model, dc) -> float                                          # §1.8
def pit_excess(fc_all, pits, lap_status, model, dc, deltas, compounds) -> pd.DataFrame
    """One row per usable stop: Driver, stop_number, lap_in, status_in ('1'..'7'), excess_s (§1.6)."""
def pit_loss(excess: pd.DataFrame, *, min_green, min_sc, samples_max) -> dict           # the pit_* / sc_* columns of §2.1
def hazard_counts(lap_status: pd.DataFrame) -> dict                                     # n_sc_laps, n_vsc_laps, n_red_laps
def replay(strategy: list[tuple[str, int]], stops_status: list[str], *, model, dc, deltas, start_penalty,
           pit_loss_s, sc_factor, vsc_factor, horizon: int, start_age: int = 1, use_deltas: bool = True) -> tuple[float, list[float]]
    """Deterministic per-lap times (fc) for a strategy [(compound, end_lap), ...] over laps 1..horizon with the
    §0.3 stint convention; charges pit_loss_s * factor(status of the in-lap) on each in-lap. Returns (total, per_lap).
    This is the arithmetic the TS engine must reproduce to 1e-9 (§3.6)."""
def calibrate(fc_all, stints, pits, lap_status, results, model, dc, deltas, start_penalty, pit: dict,
              compounds: list[str], *, min_modelled) -> pd.DataFrame                   # §1.10, per Driver
def stint_coverage(rows, model, tau: pd.DataFrame, noise_sd: pd.Series) -> float | None   # §1.10 diagnostic

def fit_race(fc_all: pd.DataFrame, lap_status: pd.DataFrame, pits: pd.DataFrame, stints: pd.DataFrame,
             results: pd.DataFrame, total_laps: int) -> SimFit:
    """Orchestrates everything above with the config constants; the only function frames.py calls."""

def recompute_hazards(conn, assumption_set_id: int) -> int:
    """§1.9: DELETE + COPY sim_circuit_hazard for every circuit with an ok/partial race, in ONE committed block
    The CALLER wraps it in ingest._committed (§3.4); this function opens no transaction, so db.py is not touched.
    Reads lap_status, sessions, events, session_ingests, sim_race_params. Returns the row count."""
```

Every array column is built as a `list` of plain Python `float`/`int`/`str`
(`[float(x) for x in ...]`), never a numpy array (§2.3). `param_chol` comes from
`np.linalg.cholesky(cov_θ + 1e-12·I)` flattened row-major; `cov_θ` is the sub-block of
`model.cov` for `[off:*, deg:*, evo]` in `param_names` order.

### 3.2 Hook in `frames.build_race_frames` (owner: Python package)

1. `tables["laps"], fc_all = _laps_frame(session, ids, annotated)` — the second element is
   already computed and currently discarded as `_`; bind it. It equals `laps.lap_time_fc_s`
   exactly (same `pace.fuel_correct(annotated, session.total_laps, lap_km=None)` call).
2. After `tstatus = _guard(...)`:
   ```python
   simfit = _guard(status, "sim", lambda: sim.fit_race(
       fc_all, lstatus, pits, stints, session.results, int(session.total_laps))
       if (lstatus is not None and pits is not None and stints is not None) else None)
   ```
   `lstatus`/`pits`/`stints` are the raw frames the guards above return (FastF1 names). When any
   is `None` the lambda returns `None` → `status["sim"] = "empty"`.
3. Translation blocks, one per table, in the existing style (`_resolve(df["Driver"], d2i, "driver
   code")`, `_norm_compound`, `cast_frame(df, table)`), `empty_frame(table)` for all four when
   `simfit is None`. `session_id`/`assumption_set_id` columns are added here as for every other
   analytic. `simfit.warnings` are appended to `Frames.warnings` (they render in the race page's
   assumptions block).
4. `RACE_TABLE_ORDER`/`ANALYTICS`/`TABLE_COLUMNS`/`RENAMES` per §2.3. `write_session` needs no
   change: it loops `RACE_TABLE_ORDER` and calls `copy_frame`.

`analytics_status.sim` values: `ok` | `empty` (a prerequisite frame was missing) |
`error: SimNotEstimable: <reason>` (e.g. `rain race: 505 of 540 representative laps on
INTERMEDIATE/WET`, `only 1 parameterised compound (SOFT: 12, MEDIUM: 18 fit rows)`, `fewer than
200 fit rows (143)`) | `error: KeyError|IndexError|ValueError: …` (a bug; still `partial`).

### 3.3 `config.py`

Append the §1.13 block verbatim. Nothing else in the file changes. `assumptions.snapshot()`
picks every `UPPER_CASE` name up, so the hash changes and `get_or_create` writes a new
`assumption_sets` row on the first run; until every season is re-ingested with `--force` the
season page shows the `mixed_assumption_sets` badge (documented in RUNBOOK, §3.7).

### 3.4 `ingest.py` and `db.py`

- `db.SESSION_CHILD_TABLES = ["sim_driver_compound", "sim_driver_params", "sim_compound_params",
  "sim_race_params", *existing]` (children first; the two driver tables reference
  `session_entries`).
- `run_season`: after the `season.recompute` try/except, an identical block:
  ```python
  try:
      with _committed(conn):
          n = sim.recompute_hazards(conn, asid)
      log.info("sim hazards recomputed for %d circuits", n)
  except Exception as e:
      conn.rollback(); log.exception("sim.recompute_hazards failed")
      if final == "ok": final, error = "failed", f"sim.recompute_hazards: {type(e).__name__}: {e}"
  ```
  (`recompute_hazards` does not open transactions itself; the caller's `_committed` block is the
  transaction, which keeps SPEC §8.6 F1 semantics untouched and leaves `_committed` where it is.)
- New flag `--recompute-hazards` (no FastF1 loads, no `--season` required): runs only the block
  above with the current assumption set. `--recompute-season` does NOT imply it (orthogonal).
  Added to `cli_args_json`. `main()` handles it next to `--recompute-season`.
- `--check-schema` covers the five new tables with no change.

### 3.5 Tests

`tests/test_sim.py` (no db; uses `hungary_2024`, `miami_2025`, `r1_2026`, `any_session`):

- `test_hungary_fit_numbers`: `laps_fit == 1233`, `ref_compound == 'HARD'`, HARD `deg` in
  (0.075, 0.095) with `deg_se < 0.005`, MEDIUM in (0.06, 0.08), SOFT parameterised with
  `laps == 34` and `deg_se > 0.02`, `evo_s_per_lap` in (−0.008, 0), `r2` in (0.55, 0.70),
  `resid_sd_s` in (0.70, 0.80), `design_cond < 5000`; `pit_loss_s` in (19.5, 21.5), `pit_loss_n
  >= 35`, `len(pit_loss_samples_s) == pit_loss_n`; `start_penalty_s` in (5, 12); `stint_tau_slope`
  of HARD in (0.02, 0.08) with `stint_tau_source == 'race'`; `stint_coverage_80` in (0.6, 0.95).
- `test_calibration_identity(any_session)`: for every simulable driver `sim_total_fc_s −
  real_total_fc_s == −(misfit_rep_s + misfit_pit_s + misfit_lap1_s + unmodelled_s)` to 1e-9;
  `real_total_s − real_total_fc_s == real_fuel_s` to 1e-6; `laps_modelled + unmodelled_laps <=
  laps_timed`; badge `'calibrated'` for ≥ 12 drivers at Hungary.
- `test_replay_matches_calibration(hungary_2024)`: `replay(actual strategy, …)` total equals the
  stored `sim_total_fc_s` to 1e-9 for every simulable driver (the browser reproduces this).
- `test_synthetic_recovery`: 20 drivers × 60 laps generated from §1.1 with known parameters,
  Gaussian noise 0.5 s; recovery within 2 se; an injected negative slope gives `deg_negative`
  and `deg_s_per_lap == 0`; `param_chol @ param_chol.T` equals `cov_θ` to 1e-9.
- `test_ridge_collinear`: synthetic race where every driver pits on lap 20 (age and lap
  collinear): plain OLS `design_cond > 1e12`, ridge fit returns finite `deg` within 0.01 of
  truth and `|evo| < 0.005`.
- `test_miami_soft_dropped`: SOFT not parameterised (`warnings` names it with its count), every
  driver whose stints include SOFT has `simulable == False` with reason mentioning SOFT.
- `test_r1_2026_rain`: `fit_race` raises `SimNotEstimable` whose message starts with `rain race`.
- `test_pit_factor_classification`: synthetic frame with a stop whose in-lap is `'4'` → its
  excess lands in `sc_pit_samples_s`, a `'6'` in-lap → `vsc_pit_samples_s`, a green stop in
  `pit_loss_samples_s`; `sc_pit_factor_race is None` below `SIM_MIN_SC_STOPS`.
- `test_guard_partial` (in `tests/test_guards.py` style): monkeypatch `sim.fit_race` to raise
  `SimNotEstimable("x")` → `analytics_status["sim"]` starts with `error: SimNotEstimable`, the four
  frames are empty, the session status is `partial`; a `RuntimeError` is NOT caught (session
  fails) — documents the boundary.
- `test_write_golden`: writes `tests/fixtures/sim_golden.json` (§3.6) and asserts it equals the
  committed file (so a change to `replay` is a deliberate, reviewed change of the fixture).

`tests/test_sim_db.py` (`db` marker, skips unless the three seasons are ingested):
`test_schema_contract` already covers `EXPECTED_COLUMNS` vs `information_schema`;
`test_hazard_rows`: one row per circuit with ≥ 1 ok/partial race, every `sc_hazard` in
(0.002, 0.03), `sc_dur_mean` in (3, 9), `sc_pit_factor_pooled` in (0.6, 1.1),
`pit_loss_pooled_s` in (20, 25), `pooled_races == count of ok/partial races`; `test_idempotent`:
hash of every `sim_*` row before/after `--season 2024 --round 13 --force` is identical (the v1
property extended); `test_cli_recompute_hazards`: `--recompute-hazards` exits 0 and bumps
`recomputed_at`.

### 3.6 Golden fixture (`tests/fixtures/sim_golden.json`)

A synthetic model small enough to read: `totalLaps = 10`, compounds MEDIUM (ref, deg 0.10) and
HARD (offset +0.5, deg 0.05), one driver (`base 90.0`, `dc MEDIUM 0.1`, `dc HARD 0`), `evo
−0.01`, `field_delta_s = [0,0,0,30,30,0,0,0,0,0]` (SC on laps 4–5, `worst_status` `'4'` on 4–5),
`start_penalty 7`, `pit_loss 20`, `sc factor 0.86`, `vsc factor 0.95`, horizon 10.
Strategies: actual `[(MEDIUM, 4), (HARD, 10)]` (stop under SC on lap 4), edited `[(MEDIUM, 3),
(HARD, 7), (MEDIUM, 10)]`. The file stores the model (in the exact `SimModel` JSON shape of §4
so the TS test loads it as a payload), the per-lap `replay` output of both strategies, both
totals and `delta = edited − actual`, written by Python with `json.dumps(..., sort_keys=True)`.
`web/lib/sim/engine.test.ts` asserts `replay()` reproduces every number to 1e-9.

### 3.7 Recompute procedure (RUNBOOK addition)

1. `cd web && npm run db:migrate` (0001) → `python -m f1lab.ingest --check-schema` exits 0.
2. `python -m f1lab.ingest --season 2024 --force`, then 2025, then 2026 (≈ 1 min total from
   cache). Each run ends with `season.recompute` and `sim.recompute_hazards`; the last run sees
   every race. No new per-race flag: `--force` is the idempotent way to (re)compute the four
   per-session tables, and none of them depends on any other session, so the order of the
   three runs does not change a single per-session row (§9 D6).
3. Later partial runs (`--round N`) refresh the hazard table automatically; `--recompute-hazards`
   exists for a refresh without loads (e.g. after deleting a failed session).
4. Changing any `SIM_*` constant → new assumption set → `--force` every season to converge
   (as in v1).

---

## 4. Query + client contract

New file `web/lib/queries/sim.ts`; `race.ts` and `shared.ts` are not edited. One export, one
JSON payload per race, called inside the page's existing `Promise.all`. SPEC §3.3 rules hold:
async, primitives in, plain JSON-serialisable object out, `DriverRef` from `shared.ts`, nothing
computed that Python did not store — the only "computation" is choosing the pit-loss / SC-factor
source by `COALESCE` order (race → circuit → pooled) and assembling `stints` rows into a strategy.

### 4.1 Types (verbatim; `web/lib/sim/types.ts` re-exports them so the engine never imports `lib/queries`)

```ts
// web/lib/queries/sim.ts — SIM_SPEC §4. Reads sim_* tables + stints/pit_stops/results/lap_status/laps; computes nothing.
import type { DriverRef } from "@/lib/queries/shared";

export type SimCompound = {
  compound: string;                 // upper-case; only parameterised compounds appear
  compoundColour: string;           // compound_colours (UNKNOWN fallback), for chips and chart
  laps: number; ageMax: number;
  offsetS: number; offsetSe: number;
  degSPerLap: number; degSe: number; degRawSPerLap: number; degNegative: boolean;
  stintTauLevelS: number; stintTauSlope: number; stintTauSource: "race" | "prior"; stintsUsed: number;
};

/** §0.3 stint convention: pit at the END of endLap; the last stint's endLap == horizon. */
export type SimStint = { compound: string; endLap: number };

export type SimCalibration = {
  lapsCompleted: number; lapsTimed: number; lapsModelled: number; unmodelledLaps: number; stops: number;
  realTotalS: number; realTotalFcS: number; realFuelS: number; simTotalFcS: number;
  misfitRepS: number; misfitPitS: number; misfitLap1S: number; unmodelledS: number;
  badge: "calibrated" | "rough" | "poor";
};

export type SimDriver = DriverRef & {
  position: number | null;          // results.position (finishing order for the selector)
  lapsFit: number; baseS: number; baseSe: number; noiseSdS: number;
  lapsCompleted: number;            // the horizon H (== calibration.lapsCompleted when simulable)
  dc: Record<string, { dcOffsetS: number; dcSe: number; laps: number }>;  // absent key == never ran it (dc = 0)
  actual: SimStint[];               // from stints (contiguous 1..H); [] when not simulable
  actualStartAge: number;           // laps.tyre_life on lap 1 (used tyres start > 1); 1 when unknown
  actualPitLaps: number[];          // pit_stops.lap_in with lap_out NOT NULL, ascending (editor reset + markers)
  simulable: boolean;
  notSimulableReason: string | null;   // sim_driver_params.not_simulable_reason
  calibration: SimCalibration | null;  // null iff !simulable
};

export type SimUnavailableDriver = DriverRef & { position: number | null; reason: string };  // no sim_driver_params row

export type SimRace = {
  totalLaps: number; refCompound: string; lapsFit: number; driversFit: number;
  r2: number; residSdS: number; residMadS: number; designCond: number;
  evoSPerLap: number; evoSe: number;
  paramNames: string[]; paramMean: number[]; paramChol: number[];   // §2.1; k = paramNames.length; chol is k*k row-major
  fieldDeltaS: number[];            // δ_L, index L-1, length totalLaps
  lapStatus: ("G" | "S" | "V" | "R")[];   // index L-1, from lap_status.worst_status ('4'→S, '6'|'7'→V, '5'→R, else G); 'G' for missing laps
  startPenaltyS: number;
  pitLoss: { medianS: number; madS: number; n: number; samplesS: number[]; source: "race" | "circuit" | "pooled" };
  scPitFactor: number;  scPitFactorSource: "race" | "pooled";
  vscPitFactor: number; vscPitFactorSource: "race" | "pooled";
  nScLaps: number; nVscLaps: number; nRedLaps: number;
};

export type SimHazard = {
  circuitKey: number; races: number; laps: number; scEpisodes: number; vscEpisodes: number;
  scHazard: number; vscHazard: number; scStartP: number; vscStartP: number;
  scDurMean: number; vscDurMean: number;
};

export type SimModel = {
  sessionId: number; assumptionSetId: number;
  race: SimRace;
  compounds: SimCompound[];         // ref compound first, then by laps desc
  hazard: SimHazard | null;         // null when the circuit row is missing (events.circuit_key NULL or hazards never recomputed)
  drivers: SimDriver[];             // ORDER BY results.position NULLS LAST, then code
  unavailable: SimUnavailableDriver[];
  constants: { draws: number; seed: number; kDc: number; degFloor: number; extrapolationLaps: number;
               noiseTDf: number; minStintLaps: 2; maxStops: 4 };   // from assumption_sets.params of the fitted row (SIM_*), + two UI constants
};

export type SimPayload =
  | { status: "ok"; model: SimModel }
  | { status: "unavailable"; reason: string };   // analytics_status.sim text, or 'strategy model not computed for this race (re-ingest with --force)' when the key is absent

export async function getSimModel(sessionId: number): Promise<SimPayload>;
```

### 4.2 Query plan (`Promise.all`, every select keyed by `session_id`)

1. `sim_race_params` — no row → `{status:'unavailable', reason}` from
   `session_ingests.analytics_status->>'sim'` (or the fallback text above). Read
   `assumption_sets.params` for `sim_race_params.assumption_set_id` (the constants the fit used,
   not the current config).
2. `sim_compound_params` + `compound_colours` (colour fallback as `getStints`).
3. `sim_driver_params` joined to `session_entries`/`session_teams`/`drivers` with the same
   select shape `loadDriverOrder` uses for `DriverRef`, plus `results.position`; entries without a
   row → `unavailable` with reason `fewer than 8 clean laps` (or `not in the fit`).
4. `sim_driver_compound`; `stints` (ORDER BY start_lap); `pit_stops` (lap_out NOT NULL);
   `lap_status`; `laps` restricted to `lap_number = 1` for `tyre_life` (start age).
5. `sim_circuit_hazard` via `sessions → events.circuit_key` (`hazard: null` when absent).

`actual` is built from `stints`: `[{compound, endLap: min(end_lap, lapsCompleted)}, …]` for
stints with `start_lap <= lapsCompleted`, the last one forced to `endLap = lapsCompleted`; when
the stints do not tile `1..lapsCompleted` contiguously the driver is reported as Python stored it
(`simulable = false`, reason `stint data incomplete`), `actual = []`.
`pitLoss`: race row when `pit_loss_s` is not NULL (`source:'race'`); else hazard row's
`pit_loss_circuit_s` with `madS = pit_loss_pooled_mad_s`, `samplesS = []`, `source:'circuit'`;
else `pit_loss_pooled_s`/`pit_loss_pooled_mad_s`, `source:'pooled'`; if no hazard row and no race
value → `{status:'unavailable', reason:'no green-flag pit stops stored for this race'}`.
`scPitFactor`: `sc_pit_factor_race ?? sc_pit_factor_pooled ?? params.SIM_SC_PIT_FACTOR_PRIOR`
(source `'race'` only for the first). Same for VSC.

### 4.3 Payload example (one driver, abridged)

```json
{ "status": "ok", "model": {
  "sessionId": 16, "assumptionSetId": 3,
  "race": { "totalLaps": 70, "refCompound": "HARD", "lapsFit": 1233, "driversFit": 20, "r2": 0.61,
    "residSdS": 0.756, "residMadS": 0.558, "designCond": 812, "evoSPerLap": -0.0043, "evoSe": 0.0013,
    "paramNames": ["off:MEDIUM","off:SOFT","deg:HARD","deg:MEDIUM","deg:SOFT","evo"],
    "paramMean": [0.12, 0.70, 0.084, 0.070, 0.002, -0.0043],
    "paramChol": [0.05,0,0,0,0,0, 0.01,0.11,0,0,0,0, "…36 values…"],
    "fieldDeltaS": [0, 0.3, -0.1, "…70 values…"], "lapStatus": ["G","G","G","…70…"],
    "startPenaltyS": 8.3,
    "pitLoss": { "medianS": 20.7, "madS": 1.6, "n": 39, "samplesS": [19.8, 20.1, "…39…"], "source": "race" },
    "scPitFactor": 0.86, "scPitFactorSource": "pooled", "vscPitFactor": 0.95, "vscPitFactorSource": "pooled",
    "nScLaps": 0, "nVscLaps": 0, "nRedLaps": 0 },
  "compounds": [
    { "compound": "HARD", "compoundColour": "#f0f0ec", "laps": 741, "ageMax": 41, "offsetS": 0, "offsetSe": 0,
      "degSPerLap": 0.084, "degSe": 0.003, "degRawSPerLap": 0.084, "degNegative": false,
      "stintTauLevelS": 0.22, "stintTauSlope": 0.045, "stintTauSource": "race", "stintsUsed": 30 },
    { "compound": "MEDIUM", "…": "…" }, { "compound": "SOFT", "laps": 34, "degSe": 0.036, "…": "…" } ],
  "hazard": { "circuitKey": 4, "races": 3, "laps": 204, "scEpisodes": 1, "vscEpisodes": 2, "scHazard": 0.0084,
    "vscHazard": 0.0109, "scStartP": 0.18, "vscStartP": 0.05, "scDurMean": 5.44, "vscDurMean": 3.62 },
  "drivers": [ {
    "driverId": "piastri", "code": "PIA", "fullName": "Oscar Piastri", "lineStyle": "solid",
    "teamId": "mclaren", "teamName": "McLaren", "teamColour": "#ff8000", "position": 1,
    "lapsFit": 62, "baseS": 81.9, "baseSe": 0.09, "noiseSdS": 0.41, "lapsCompleted": 70,
    "dc": { "MEDIUM": { "dcOffsetS": -0.08, "dcSe": 0.09, "laps": 14 }, "HARD": { "dcOffsetS": 0.03, "dcSe": 0.05, "laps": 48 } },
    "actual": [ { "compound": "MEDIUM", "endLap": 16 }, { "compound": "HARD", "endLap": 46 }, { "compound": "HARD", "endLap": 70 } ],
    "actualStartAge": 1, "actualPitLaps": [16, 46], "simulable": true, "notSimulableReason": null,
    "calibration": { "lapsCompleted": 70, "lapsTimed": 70, "lapsModelled": 62, "unmodelledLaps": 3, "stops": 2,
      "realTotalS": 5854.3, "realTotalFcS": 5799.1, "realFuelS": 55.2, "simTotalFcS": 5793.6,
      "misfitRepS": 3.9, "misfitPitS": 0.8, "misfitLap1S": -0.6, "unmodelledS": 1.4, "badge": "calibrated" } } ],
  "unavailable": [],
  "constants": { "draws": 4000, "seed": 20240101, "kDc": 10, "degFloor": 0, "extrapolationLaps": 5, "noiseTDf": 4,
                 "minStintLaps": 2, "maxStops": 4 } } }
```

### 4.4 Byte estimate (22 cars, 70 laps, 3 compounds; JSON before RSC quoting)

| part | size |
|---|---|
| race scalars + names | ~0.5 KB |
| `paramChol` 36 + `paramMean` 6 doubles | ~0.8 KB |
| `fieldDeltaS` 70 doubles + `lapStatus` 70 | ~1.4 KB |
| `pitLoss.samplesS` ≤ 60 doubles | ~0.7 KB |
| `compounds` 3 × ~330 B | ~1.0 KB |
| `hazard` | ~0.3 KB |
| `drivers` 22 × (DriverRef ~180 B + scalars ~200 B + `dc` 3 × 60 B + `actual` 3 × 35 B + `actualPitLaps` + calibration ~330 B ≈ 1.1 KB) | ~24 KB |
| `unavailable`, `constants` | < 0.5 KB |
| **total** | **≈ 29 KB** (≈ 35 KB after RSC quoting) — about 5 % of the current 500–700 KB race page; no separate route |

---

## 5. Browser algorithm (`web/lib/sim/engine.ts`, pure TypeScript; `web/lib/sim/prng.ts`)

No React, no DOM, no imports from `lib/queries` (types come from `lib/sim/types.ts`). Unit-tested
in Node with `tsx --test` (no new dev dependency: `tsx` is already present; `node:test` +
`node:assert`).

### 5.1 Inputs and strategy expansion

```ts
export type SimMode = "asHappened" | "random";
export type SimInput = { model: SimModel; driver: SimDriver; edited: SimStint[]; mode: SimMode; seed?: number; draws?: number };

expand(stints: SimStint[], H: number, startAge: number): Plan
  // Plan = { comp: string[H], age: Int32Array(H), pitAt: Uint8Array(H), stintIdx: Int32Array(H), stops: number[] }
  // start = 1; for k, s of stints: for L in start..s.endLap: comp[L-1] = s.compound; age[L-1] = (k == 0 ? startAge : 1) + (L - start);
  //   stintIdx[L-1] = k;  if k < last: pitAt[s.endLap-1] = 1, stops.push(s.endLap);  start = s.endLap + 1
  // throws SimPlanError unless: stints.length in 1..maxStops+1, endLaps strictly increasing, last endLap == H,
  //   every stint >= minStintLaps laps (the first may be 1 lap only if H == 1), every compound in model.compounds.
```
Both strategies are expanded over the same horizon `H = driver.lapsCompleted` (fixed decision
10); `actualStartAge` applies to the actual plan's first stint and to the edited plan's first
stint when its compound equals the actual first compound (a used set stays used), else 1.

### 5.2 PRNG and distributions (`prng.ts`)

`mulberry32(seed)` → `() => number` in [0, 1); `normal()` by Box–Muller (both values used);
`t(df)` = `z / sqrt(chi2(df)/df)` with `chi2(df)` = sum of `df` squared normals; `geometric(p)` =
`ceil(ln(1 − u) / ln(1 − p))` on {1, 2, …}. Two independent streams per run:
`main = mulberry32(seed)` and `sc = mulberry32((seed ^ 0x9e3779b9) >>> 0)`, so the random SC
timeline never shifts the parameter/pit draws. Within `main` the consumption order per draw is
**fixed and independent of the edited strategy** (§5.3 pre-draws every slot), which is what
makes two consecutive edits comparable under one seed. Default `seed = constants.seed`,
`draws = constants.draws` (4000); no re-roll control in the UI (§9 D9).

### 5.3 One draw (common random numbers)

```
K      = model.race.paramNames.length;  C = compounds used by either plan (sorted, fixed order)
MAXS   = constants.maxStops + 1 (stints), MAXP = constants.maxStops (stops)
theta0 = paramMean; Lc = paramChol (K×K lower)
per draw n:
  // 1. joint parameter draw (shared)
  z[0..K-1] ~ normal;  theta = theta0 + Lc·z;   off[c] = theta[off:c] (0 for ref); deg[c] = max(degFloor, theta[deg:c])
  // 2. driver×compound deviation (shared per cell; a cell absent from driver.dc uses dc=0, se = noiseSdS/sqrt(kDc))
  for c in C: dc[c] = dcOffsetS[c] + dcSe[c]·normal()
  // 3. stint random effects: MAXS slots for "actual" and MAXS slots for "edited-own", always drawn
  for k < MAXS: uLevA[k], uSlpA[k], uLevE[k], uSlpE[k] ~ normal            (unit normals; scaled by tau of the stint's compound at use)
  // 4. pit draws: MAXP slots, always drawn (uniform u for resampling; and 5 normals for the pooled t4 fallback)
  for k < MAXP: uPit[k] ~ uniform; tPit[k] ~ t(noiseTDf)
  // 5. neutralisation timeline (shared)
  status[L] = mode == 'asHappened' ? race.lapStatus[L] : drawTimeline(sc stream, hazard, H)
  // 6. lap loop — evo, δ_L, start penalty, base_d and lap noise are omitted: identical on both sides (§1.1)
  cum = 0
  for L in 0..H-1:
     tA = lapTerm(planA, L, uLevA, uSlpA)   // off[c] + dc[c] + (deg[c] + tauSlope[c]·uSlp)·(age-1) + tauLevel[c]·uLev
     tE = lapTerm(planE, L, uLevE', uSlpE') // uLev'/uSlp' = pairing rule below
     if planA.pitAt[L]: tA += pitLoss(stopIndexA(L)) · factor(status[L])
     if planE.pitAt[L]: tE += pitLoss(stopIndexE(L)) · factor(status[L])
     cum += tE − tA;  perLap[n·H + L] = cum
  delta[n] = cum
```
- **Pairing rule (stint random effects):** edited stint `k` uses `(uLevA[k], uSlpA[k])` when
  `edited[k].compound === actual[k].compound` (same tyre, same behaviour — a pit-lap shift changes
  the delta only through the laps that differ), else `(uLevE[k], uSlpE[k])`.
- **Pit loss per stop index `k`:** `source === 'race'` → `samplesS[floor(uPit[k]·samplesS.length)]`;
  otherwise `medianS + madS·1.4826·tPit[k]`. Stop `k` of both strategies uses the same slot.
- **factor(status):** `'S' | 'R'` → `scPitFactor`, `'V'` → `vscPitFactor`, `'G'` → 1.
- **drawTimeline(hazard, H):** lap 1: with prob `scStartP` an SC episode of `geometric(1/scDurMean)`
  laps starts, else with prob `vscStartP` a VSC episode of `geometric(1/vscDurMean)`; for every
  later lap with no active episode: SC with prob `scHazard`, else VSC with prob `vscHazard`;
  episodes never overlap; tyre age advances under SC (stated in the caption). When
  `hazard === null` random mode is disabled in the UI. Only the pit factor depends on the
  timeline in the delta (δ cancels), so no δ is drawn.
- Deterministic identities the tests assert: `edited ≡ actual` ⇒ every `delta[n] === 0` exactly;
  moving one pit lap on the same compounds changes `perLap` only from the earlier of the two
  pit laps on; with `tau = 0`, `paramChol = 0`, `dcSe = 0` and one pit sample the delta equals
  the closed-form `Σ_L (model_E − model_A)` to 1e-9.

### 5.4 N, outputs, quantiles

`N = 4000` (fixed; `constants.draws`). Per draw the work is `K + C + 4·MAXS + 2·MAXP` normals
(≈ 40) plus `2·H` multiply-adds; 4000 × 70 → ≈ 0.6 M flops + 0.16 M normals — expected
10–30 ms (P1's prototype measured 107–120 ms *with* 12 normals per lap for the noise that is no
longer drawn). Quantile = `sorted[floor(p·(N−1))]` (lower nearest rank) on a sorted copy;
per-lap quantiles by sorting each of the `H` columns (measured ≈ 12 ms). Memory: `perLap` is one
`Float64Array(N·H)` = 2.2 MB, released after the quantiles.

```ts
export type SimResult = {
  n: number; horizonLaps: number; mode: SimMode; seed: number;
  deltaMedianS: number; deltaP10S: number; deltaP90S: number; deltaMeanS: number;
  pBetter: number;                                          // share of draws with delta < 0 (edited faster)
  histogram: { binStartS: number; binEndS: number; count: number }[];   // 30 equal bins over [p1, p99]
  perLap: { lap: number; medianS: number; p10S: number; p90S: number }[]; // cumulative edited − actual
  editedStops: { lap: number; status: "G" | "S" | "V" | "R" }[];        // for markers; status per as-happened lapStatus (random mode: "G")
  actualStops: { lap: number; status: "G" | "S" | "V" | "R" }[];
  scLapsMean: number | null;                                // random mode: mean simulated SC+VSC laps per draw; null otherwise
};
export function simulate(input: SimInput): SimResult;
```
Sign: `delta = edited − actual`, negative = edited faster; the UI translates (§6.6).

### 5.5 Calibration (`replay`)

```ts
export function replay(model: SimModel, driver: SimDriver, stints: SimStint[], opts?: { useDeltas?: boolean }): { totalFcS: number; perLapS: number[] }
```
Deterministic: `θ = paramMean` (deg floored), `dc` means, random effects 0, pit loss `medianS`,
factors by `race.lapStatus` of the in-lap, plus `base_d`, `evo·(L−1)`, `fieldDeltaS[L]`,
`startPenaltyS` on lap 1, over `1..H` — the exact arithmetic of Python `sim.replay` (§3.1).
Used by (a) `engine.test.ts` against the golden fixture (1e-9) and against
`driver.calibration.simTotalFcS` for every driver of a live payload fixture (1e-6), and (b) a
dev-only `console.warn` in the section when `|replay(actual).totalFcS − simTotalFcS| > 1e-3`.
The fan-facing calibration line renders the **stored** Python numbers (server-rendered, present
before hydration); the browser never displays its own replay.

### 5.6 Complexity and budget

`simulate` is O(N·(H + K + MAXS + MAXP)) time, O(N·H) memory; target ≤ 50 ms on a laptop,
≤ 200 ms on a phone. Runs are triggered by editor changes with a 150 ms debounce and by the
mode/driver switch; there is no Run button and no worker. If a measured run exceeds 300 ms the
component halves `draws` once (to 2000) and says so in the tile hint ("2,000 simulated races").

---

## 6. UI spec — `components/race/SimSection.tsx` (`'use client'`), slot `id="simulator"`

Placement: after "Tyre degradation", before "Race trace" (§9 D1). `SECTIONS` nav entry
`{ id: "simulator", title: "Strategy simulator" }`. Section title **"What if they had pitted on
lap 22?"**; section caption *"Edit one driver's strategy and simulate it against what they really
did — clean-air time only."* Visual language: the same `rounded-lg border border-grid bg-surface
p-3` cards, `StatTile`, `CompoundChip`, `DriverChip`, `EChart` (`f1dark`), `Caption`,
`EmptyState`. No new colours: edited strategy in the driver's team colour, actual strategy in
`PALETTE.muted`, SC/VSC/red bands via `statusBands()` exported from `RaceTrace.tsx`. No new
runtime dependency.

Props: `{ payload: SimPayload; colours: ColourMap; year: number; reason?: string | null }`.
The server page passes the whole payload; the section owns all client state:
`{ driverId, mode, stints: SimStint[], result: SimResult | null, drawsUsed }`.

### 6.1 Layout (single column < `lg`, two columns ≥ `lg`)

```
┌ Driver ─────────────────────────────┐ ┌ Result (aria-live="polite") ────────────────────────┐
│ [P1 PIA — Oscar Piastri ▾] (chip)   │ │ [Verdict]  [P(faster)]  [Likely range]  [Laps simulated] │
│ Safety cars: (•) As it happened     │ │ one-sentence hint under every tile                    │
│              ( ) Random, from this  │ ├ Lap by lap ─────────────────────────────────────────┤
│                  circuit's history  │ │ SimGapChart: median line, p10–p90 band, pit markers, │
├ Strategy ───────────────────────────┤ │ SC/VSC bands (as-happened mode)                      │
│ Stint 1 [MEDIUM ▾] laps 1–[16]      │ ├ Trust check ────────────────────────────────────────┤
│ Stint 2 [HARD   ▾] laps 17–[46]  ×  │ │ decomposed calibration line + badge (server-rendered)│
│ Stint 3 [HARD   ▾] laps 47–70    ×  │ └──────────────────────────────────────────────────────┘
│ [+ add stop] [Reset to actual] [Presets ▾]                                                     │
│ Actual: M 1–16 · H 17–46 · H 47–70  │
└─────────────────────────────────────┘
Caption (verbatim, §6.9)
```

### 6.2 Driver selector

Native `<select>` (styled like `SeasonSwitcher`), every driver in `drivers` then `unavailable`
in finishing order, label `P{position ?? "—"} {code} — {fullName}`. Non-simulable drivers are
`disabled` with the suffix `— {notSimulableReason}` (e.g. `— ran INTERMEDIATE on 9 laps`,
`— not enough clean laps`). **Default = the first simulable driver in finishing order** (usually
the winner). Changing driver resets the editor to that driver's `actual`, keeps the mode, reruns.
A `DriverChip` (team colour, line style) sits next to the select.

### 6.3 Mode

Two radios. *As it happened* (default): hint "Safety cars on the laps they really came out
({nScLaps} SC laps, {nVscLaps} VSC laps in this race)." *Random safety cars*: hint "Drawn from
this circuit's history: {scEpisodes} safety cars and {vscEpisodes} virtual ones in {races}
races here, plus the field-wide rate." Disabled with the hint "no circuit history stored" when
`hazard === null`. Switching reruns immediately.

### 6.4 Stint editor

One row per stint: stint number; a `<select>` of **parameterised compounds only**, each option
rendered with its `CompoundChip` colour, `degNegative` compounds suffixed "· no measurable
degradation on this tyre in this race"; the derived start lap (read-only); an editable **last
lap** `<input type="number">` (= the pit lap) — except the final stint, whose last lap is `H`
and read-only. Editing is by pit lap, because that is how fans talk. Below the rows the actual
strategy in words with coloured chips: `Actual: M 1–16 · H 17–46 · H 47–70` (and `· retired
after lap 42` when `H < totalLaps`).

Validation (inline red text under the row; the simulation does not run while any error exists):

| rule | message |
|---|---|
| pit lap of stint i in `[start_i + minStintLaps − 1, start_{i+1}' − minStintLaps]` where `start_{i+1}'` is the next stint's current pit lap (or `H`) | "pit lap must be between {lo} and {hi}" |
| every stint ≥ `constants.minStintLaps` (2) laps | "a stint needs at least 2 laps — an in-lap needs an out-lap" |
| at most `constants.maxStops` (4) stops | "+ add stop" disabled, tooltip "4 stops is the most this editor allows" |
| compound not in `driver.dc` (driver never ran it) — **amber, not blocking** | "{code} never ran the {compound} in this race — pace uses the field's offset, not {code}'s" |
| stint length > `ageMax + constants.extrapolationLaps` — **amber, not blocking** | "longer than any real stint on this tyre ({ageMax} laps) — the wear line is extrapolated" |
| single-compound strategy — **muted note, not blocking** | "one compound only — the two-compound rule is not enforced here" |

No regulatory checks otherwise (mandatory stop, compound rules): a 0-stop strategy is allowed.

Controls: **+ add stop** splits the longest stint at its midpoint (new stint inherits the
compound); **×** per row (hidden with one stint) merges the stint into the previous one (the
first row merges into the next); **Reset to actual** restores `driver.actual`; **Presets ▾**:
*Pit 3 laps earlier*, *Pit 3 laps later* (shift every pit lap ∓/± 3, clamped to validity),
*One stop fewer* (drop the last stop, extend the previous stint), *Swap compounds* (each stint
takes the next parameterised compound in `compounds` order). Presets and every valid edit run
immediately (150 ms debounce). While a result is stale the tiles fade (`opacity-60`); the very
first client render shows "Simulating 4,000 races…" under empty tiles until the first run.

The editor state is mirrored into the URL hash `#sim=PIA;M16,H46,H70;a` (code; compound
initial + endLap per stint; mode `a`|`r`) on every valid change and read once on mount (invalid
or absent hash → defaults), so a fan can share a result (§9 D10).

### 6.5 Result tiles (`StatTile` × 4, each with a one-sentence hint)

1. **Verdict** — `"{|median|, 1 dp} s faster"` (team colour) / `"… s slower"` (muted) /
   `"about the same"` when `|median| < 0.2 s`. Hint: "Median of {n} simulated races, edited
   minus actual, clean-air time only."
2. **P(faster)** — `{round(100·pBetter)} %`. Hint: "Share of simulated races where the edited
   strategy finishes in less time."
3. **Likely range** — `{p10} … {p90} s` as signed one-decimal numbers with the words *faster* /
   *slower* (e.g. "3.1 s slower … 8.4 s faster"). Hint (as-happened): "8 in 10 simulated races
   land here. The spread comes from how much stints on the same tyre varied in this race, how
   sure the fit is, and how variable the pit stops were." Random mode appends: "…, and when a
   safety car comes (on average {scLapsMean, 1 dp} neutralised laps per simulated race)."
4. **Laps simulated** — `{H}` with hint "Both strategies run to lap {H}{H < totalLaps ? ' — ' +
   code + ' retired there' : ''}." (replaces any signed median tile: the verdict already carries
   the number; §9 D8).

### 6.6 Lap-by-lap chart (`components/charts/SimGapChart.tsx`, `EChart`, height 360, structural props)

Props: `{ perLap: SimResult["perLap"]; editedStops; actualStops; lapStatus: TraceLapStatus[] | null;
teamColour: string; code: string; mode: SimMode; ariaLabel: string }` (no import from `lib/queries`).
- x: `category` laps `1..H`; y: value, **inverted** (ahead is up, as the race trace), name
  "Edited car vs actual car (s) — above the line = ahead".
- Series: `bandLo` (`line`, `stack:'b'`, `lineStyle.opacity 0`, `data = p10`), `bandHi` (`line`,
  `stack:'b'`, `data = p90 − p10`, `areaStyle:{color: teamColour, opacity: 0.18}`, `lineStyle.opacity
  0`), `median` (`line`, width 2, `teamColour`, `symbol:'none'`), zero `markLine` on the median series,
  `markPoint` triangles at `editedStops` (team colour, label "pit") and `actualStops` (`PALETTE.muted`,
  label "pit (actual)"), and — as-happened mode only — a data-less "Track status" series with the
  `statusBands()` `markArea` (as `RaceTrace`). Random mode omits the bands and adds a legend note
  "safety cars vary per simulated race".
- Tooltip per lap: `Lap 22 · edited car 19.8 s behind (p10 19.5, p90 20.1) · pit stop (edited, under SC)`.
- Option shape: `{ grid:{left:64,right:36,top:40,bottom:48}, tooltip:{trigger:'axis', confine:true},
  legend:{show:false}, xAxis:{type:'category', data:laps}, yAxis:{type:'value', inverse:true, name:…,
  nameLocation:'middle', nameGap:48}, series:[bandLo, bandHi, median, status] }`.
- `ariaLabel` = the verdict sentence (e.g. "Edited strategy 4.2 s faster in the median, P(faster) 81 %").

### 6.7 Delta histogram (`components/charts/SimDeltaHistogram.tsx`, `EChart`, height 180)

`bar` series over `result.histogram` (`category` x = bin start, 1 dp), team colour, a
`markLine` at 0 labelled "same time" and one at the median; x name "edited − actual (s), left of
zero = edited faster". Rendered under the tiles, above the lap chart; `ariaLabel` "Distribution
of the finishing-time difference over {n} simulated races".

### 6.8 Trust check (always rendered when a simulable driver is selected; server-renderable from the payload)

Verbatim template (numbers from `driver.calibration`, wall-clock = fc + `realFuelS`):

> **Trust check.** Replaying {code}'s real strategy lap by lap, the model gives
> **{fmtRaceTime(simTotalFcS + realFuelS)}**; the real time over the same {lapsTimed} laps was
> **{fmtRaceTime(realTotalS)}**. On the {lapsModelled} clean-air laps the model was fitted on it
> is **{|misfitRepS|, 1 dp} s {optimistic|pessimistic}** ({|misfitRepS|/lapsModelled, 2 dp} s per
> lap) — [badge]. The other {unmodelledLaps} laps (traffic, yellow flags, damage,
> lift-and-coast, wet laps) cost **{unmodelledS, signed 1 dp} s** that the simulator does not
> see; pit laps {misfitPitS, signed 1 dp} s and the start {misfitLap1S, signed 1 dp} s.

Badge: `calibrated` → "good fit" (accent), `rough` → "rough fit" (amber), `poor` → "poor fit —
low trust" (red); a `poor` badge also prefixes the Verdict tile value with "low trust:". The
badge is computed from the modelled laps only, and the caption says so. When
`nRedLaps > 0` append: "This race was red-flagged; the stopped laps are outside the model."
`optimistic` = model total smaller than real.

### 6.9 Caption (verbatim; `SIM_CAPTION` export, `<Caption>` under the whole section)

> This simulator answers one question only: how much clean-air time a different strategy would
> have gained or lost for this driver. It does not model traffic, blue flags, overtaking or track
> position, so it never says whether they would have finished ahead of anyone — a stop that looks
> 1 s better here can still lose a place on the road. Lap times come from a model fitted to this
> race's clean laps (driver and tyre base pace, one wear slope per compound, track evolution);
> wear is a straight line that keeps going past the longest real stint, and the same amount of
> wear is charged under a safety car as in racing. Pit loss is resampled from this race's own
> green-flag stops; safety cars either replay the real ones or are drawn from this circuit's
> history. Fuel load is left out because it is the same on every lap for every strategy of the
> same driver. A stop under a safety car costs about {round(100·scPitFactor)} % of a normal stop
> here, not nothing — the "free stop" you see on TV is mostly the field bunching up, which is a
> position effect. The spread of the result is how much stints on the same tyre varied in this
> race, how sure the fit is and how variable the pit stops were — not lap-to-lap noise, which is
> the same in both versions of the race. The trust check compares the model with the real race
> on the clean-air laps it was fitted on; the laps it was not fitted on are shown separately and
> are not a strategy effect. The rules about mandatory compounds are not enforced. Every number
> is recomputed from the same fixed random draws, so the same edit always shows the same result.

When `pitLoss.source !== 'race'` a second `<Caption>` line: "Pit loss borrowed from
{other races at this circuit | every ingested race} — fewer than 5 usable green-flag stops here."
When `designCond > 1e4`: "In this race everyone pitted on the same laps, so tyre wear and track
evolution are hard to tell apart; treat pit-later edits with extra caution."

### 6.10 Empty and degraded states

- `payload.status === 'unavailable'` → `<EmptyState title="No strategy model for this race"
  reason={payload.reason}>` with the child text "Rain races, races with fewer than two slick
  compounds on enough clean laps, and races ingested before v1.1 (re-ingest with `--force`) have
  no model."
- `drivers.every(d => !d.simulable)` → `<EmptyState title="No driver of this race can be
  simulated" reason={first notSimulableReason}>`.
- A selected driver that is not simulable cannot be selected (disabled); if the URL hash names
  one, fall back to the default driver.
- `hazard === null` → random mode disabled (§6.3); everything else works.
- Accessibility: every control has a `<label>`; results region `aria-live="polite"`; both charts
  `role="img"` (via `EChart`) with `ariaLabel`s as above; the compound `<select>` options carry
  the full compound name.

---

## 7. Work packages — strict single-owner file ownership, sequencing, verification

Five packages. Every file below has **exactly one owner** for the whole of v1.1; anyone else
needing a change in it sends the owner a one-line request. Files not listed are untouched.
`web/lib/queries/race.ts` and `web/lib/queries/shared.ts` are **frozen** (nobody edits them).

### 7.1 Ownership table

| file | owner | change |
|---|---|---|
| `web/db/schema/sim.ts` (new) | **WP-S0 schema** | five `pgTable`s (§2.1, §2.4) |
| `web/db/schema/index.ts` | **WP-S0 schema** | one `export * from "./sim";` line |
| `web/drizzle/0001_sim.sql`, `web/drizzle/meta/*` | **WP-S0 schema** | generated by drizzle-kit, reviewed against §2.1 |
| `f1lab/sim.py` (new) | **WP-S1 python** | §1, §3.1 |
| `f1lab/config.py` | **WP-S1 python** | §1.13 block, append only |
| `f1lab/frames.py` | **WP-S1 python** | §2.3 contract lines + §3.2 hook and four cast blocks (the ONLY editor of this file) |
| `f1lab/db.py` | **WP-S1 python** | `SESSION_CHILD_TABLES` (§3.4) |
| `f1lab/ingest.py` | **WP-S1 python** | hazards block, `--recompute-hazards` (§3.4) |
| `tests/test_sim.py`, `tests/test_sim_db.py`, `tests/fixtures/sim_golden.json` (new); added cases in `tests/test_guards.py`, `tests/test_ingest_cli.py` | **WP-S1 python** | §3.5, §3.6 |
| `web/lib/queries/sim.ts` (new) | **WP-S2 web-engine** | §4 — the single query + exported types |
| `web/lib/sim/types.ts`, `web/lib/sim/prng.ts`, `web/lib/sim/plan.ts`, `web/lib/sim/engine.ts`, `web/lib/sim/engine.test.ts`, `web/lib/sim/__fixtures__/hungary2024.json` (new) | **WP-S2 web-engine** | §5; the fixture is a hand-written `SimPayload` with §1 numbers until S1 lands, then replaced by a real `getSimModel(16)` dump |
| `web/package.json` | **WP-S2 web-engine** | one script: `"test": "tsx --test lib/sim/*.test.ts"` (no new dependency) |
| `web/components/race/SimSection.tsx`, `web/components/sim/StintEditor.tsx`, `web/components/sim/ResultTiles.tsx`, `web/components/sim/TrustCheck.tsx`, `web/components/sim/simState.ts` (hash codec + reducer) (new) | **WP-S3 web-ui** | §6.1–6.5, 6.8–6.10 |
| `web/components/charts/SimGapChart.tsx`, `web/components/charts/SimDeltaHistogram.tsx` (new) | **WP-S3 web-ui** | §6.6, §6.7 (structural props; no `lib/queries` import) |
| `web/app/race/[year]/[round]/page.tsx` | **WP-S4 integration** | import, `Promise.all` entry, `SECTIONS` entry, one `<Section>` block (≤ 15 lines) |
| `docs/SPEC.md` (one "v1.1 → SIM_SPEC.md" pointer in §0.1), `docs/SIM_SPEC.md` §10 "as built", `docs/RUNBOOK.md`, `Makefile` (`recompute-hazards`, `test-web` targets) | **WP-S4 integration** | after everything lands |

### 7.2 Sequencing

```
WP-S0 schema (½ day, FIRST): sim.ts → generate 0001 → migrate the local DB → commit.
   Gate: `docker exec f1-postgres psql -U f1 -d f1 -c '\d sim_race_params'` shows §2.1; `npm run typecheck` clean.
   ├── WP-S1 python (2–3 days): starts day 0 against the §2.1 DDL text; DB gate = `--check-schema` exit 0 after S0.
   ├── WP-S2 web-engine (1.5 days): starts day 0 against §4/§5 types; `getSimModel` compiles against S0's schema
   │       and returns {status:'unavailable'} until S1's rows exist. Golden-fixture test waits for S1's file.
   └── WP-S3 web-ui (2 days): starts day 0 against §4 `SimPayload` and §5 `SimResult`, rendering from
           S2's `__fixtures__/hungary2024.json` (S2 commits the hand-written fixture on day 0, first thing).
WP-S4 integration (½ day): page.tsx wiring, `--force` re-ingest of all seasons, browser check, docs, §10 as-built.
```

What the web packages build before the Python data lands: everything. S2's engine is tested on
synthetic models (identities in §5.3) and on the fixture; S3 renders the section from the
fixture through a Node script with ECharts' SVG renderer (as WP4 did in v1) — no scratch route
is committed. The only artefacts that wait for S1 are the golden-fixture parity test and the
live `getSimModel(16)` dump.

### 7.3 Per-package verification commands

- **S0**: `cd web && npx drizzle-kit generate --name sim && npm run db:migrate && npm run db:check
  && npm run typecheck`; `make psql SQL="\d sim_driver_params"` shows the two FKs and the badge check.
- **S1**: `.venv/bin/python -m f1lab.ingest --check-schema` (exit 0); `.venv/bin/pytest
  tests/test_sim.py tests/test_frames.py tests/test_guards.py -q`; `.venv/bin/python -m f1lab.ingest
  --season 2024 --round 13 --force` then `make psql SQL="select laps_fit, r2, pit_loss_s, pit_loss_n,
  design_cond from sim_race_params where session_id=16"` (1233, ≈ 0.61, ≈ 20.7, 39, < 5000);
  `--season 2024 --force` twice and hash-compare the four sim tables (identical); `--recompute-hazards`
  exit 0 and `select count(*) from sim_circuit_hazard` ≥ 20; full `.venv/bin/pytest -q` = 135 + new, 0 failed.
- **S2**: `cd web && npm test` (identities, CRN, quantiles, golden 1e-9, timing < 300 ms); `npm run
  typecheck`; after S1: `npx tsx -e "import('./lib/queries/sim').then(m=>m.getSimModel(16)).then(p=>console.log(p.status, JSON.stringify(p).length))"`
  → `ok` and ≈ 30 000; `replay(actual)` equals `calibration.simTotalFcS` to 1e-6 for every simulable driver of that dump.
- **S3**: `npm run typecheck && npm run lint`; the SVG render script shows four tiles, the trust
  line and both charts from the fixture; the validation table of §6.4 exercised by a `node:test`
  on `simState.ts` (reducer + hash codec round-trip).
- **S4**: `for y in 2024 2025 2026; do .venv/bin/python -m f1lab.ingest --season $y --force; done`
  (≈ 1 min from cache) → `select count(*) from sim_race_params` ≥ 60 of 71 (rain races empty);
  `npm run build` clean; open `/race/2024/13`: default driver simulable, "Pit 3 laps later" changes
  the verdict, trust check badge `good fit` for the winner; `/race/2025/13` (collinear) shows the
  design-condition caption line; `/race/2025/1` (rain) shows the EmptyState; `/race/2026/6` (red
  flag) renders without error; console clean; the artifact record goes into §10.

---

## 8. Risks (top 5)

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | **Model misspecification** — one pooled linear slope per compound, no cliff, no thermal/traffic effects; a 48-lap hard stint is extrapolated from fits whose `age_max` is ~35; evolution may be non-linear. A confident "−20 s" the real tyre would never deliver. | High / high — it is the whole feature. | (a) The trust check is computed by Python on the driver's REAL strategy with the REAL neutralisations and decomposed: the clean-air misfit per modelled lap drives the badge (0.15/0.40 s per lap — tight enough to catch a 0.03 s/lap slope error over a 25-lap stint), and the unmodelled part is always shown next to it so a poor fit cannot hide behind traffic. (b) The interval is predictive, not model-conditional: the per-stint random effects (§1.5, calibrated to the observed between-stint scatter and checked by `stint_coverage_80`) plus the joint covariance draw widen p10–p90 and pull P(faster) toward 50 % on long extrapolations instead of lying with a point estimate. (c) The editor flags stints beyond `age_max + 5` and compounds the driver never ran; the caption states every unmodelled effect verbatim. |
| 2 | **Degradation/evolution collinearity** when the field pits on the same laps (2025 R13, cond 3.8e17). | Certain for ~1 race in 60 / high on that race. | The evo ridge makes the fit finite and near-neutral (verified); `design_cond` is stored, the caption line fires above 1e4, and the synthetic collinear test pins the behaviour. Residual: on such a race the slope carries the evolution — "pit later" edits are biased toward the evolution sign; the caption says so. |
| 3 | **SC/VSC pit factor** — the whole "pit under the safety car" answer rests on a factor measured from ~100 SC stops pooled across races with a wide IQR (10.6–27.4 s), per-race from a handful. | Medium / medium. | Measured (0.86 / 0.95), never asserted; per-race when ≥ 3 stops, pooled otherwise, source shown; classification by `worst_status` of the in-lap (no δ threshold); the caption's position-effect sentence explains why the answer is smaller than TV suggests; the chart marks which edited stops fall under a neutralisation. |
| 4 | **Python/TypeScript drift** — two implementations of one lap formula (age−1 vs age, pit loss on in-lap vs out-lap, factor semantics, Cholesky layout). | Medium / high — silently wrong numbers. | One `predict`/`replay` in Python and one `replay` in TS, pinned to 1e-9 by the golden fixture (§3.6) and to 1e-6 by every driver's stored `sim_total_fc_s` on a live dump; every constant the browser uses travels in the payload from the fitted row's assumption set; `--check-schema` and `test_schema_contract.py` pin the columns; the dev-only `console.warn` on the section catches a regression on any page. |
| 5 | **Ingest-order dependence / assumption-set churn** — cross-season fallbacks could leak into per-session rows; 31 new constants create assumption set #N+1 and `mixed_assumption_sets` until every season is re-ingested. | Certain / low if handled. | No per-session row reads any other session (§1.9, §4.2: fallbacks are resolved in the query layer from the run-end hazard table); the idempotency hash test covers the four sim tables; RUNBOOK documents the three-season `--force` order (~1 min from cache) and `--recompute-hazards`; the payload carries `assumptionSetId`. |

Runner-ups: phone performance (§5.6: the 2000-draw lever before any worker); RSC payload growth
(≈ 35 KB, immaterial next to the trace); rain/red-flag/short races (handled by §1.12 and the
empty states — the section never throws, same contract as every v1 section).

Stated non-goal, repeated so nobody adds it later: positions, traffic, undercut/overcut against
other cars. The unit is seconds of clean-air race time for one driver; the caption says it in
its first sentence.

---

## 9. Decisions log

| # | Decision | Why (one line) |
|---|---|---|
| D1 | Slot after "Tyre degradation", before "Race trace". | The fan has just read the two inputs (stints, slopes); the trace afterwards is the reality check the caption points to. |
| D2 | `(off, deg, evo)` drawn jointly from the OLS covariance via a stored Cholesky factor, not as independent normals. | On a race with cond ~1000 the deg–evo correlation is the collinearity; independent draws mis-state the joint uncertainty (statistics judge). |
| D3 | `SIM_DEG_FLOOR = 0` with `deg_negative` kept (P1 had −0.05). | A tyre is never simulated as getting faster with age; the flag keeps the caption honest. |
| D4 | Pit loss = in+out excess over the **model** (P1), stored as the race's own samples and resampled per stop index (P2). | Avoids the 1–2 s age double count of driver-median definitions; keeps the crew-variance shape without a distributional assumption. |
| D5 | SC/VSC pit factors **measured** (0.86 / 0.95 pooled; per race when ≥ 3 stops), classified by `worst_status` of the in-lap. | P1's asserted 0.45 was never derived and its δ-threshold rule gave VSC stops a discount its own data denied; the live DB gives 19.3/22.4 and 21.2/22.4. |
| D6 | No per-session row reads another session; cross-season values live only in the run-end `sim_circuit_hazard` table; fallbacks resolved in the query layer. | Keeps v1's `--force` row-hash idempotency (P2's per-session hazard and P3's `sc_factor` fallback broke it). |
| D7 | SC duration Geometric on {1,2,…} with `p = 1/mean` (P3 had two distributions). | One stored mean, one distribution, in both languages. |
| D8 | Four tiles: Verdict / P(faster) / Likely range / Laps simulated; no signed median tile, no seed label, no re-roll, no Run button. | P2's verdict tile already carries the number; a re-roll undermines "the same edit shows the same result" (interpretability judge). |
| D9 | Fixed seed, auto-run on valid edits with a 150 ms debounce. | Reproducible screenshots; a run costs tens of ms. |
| D10 | URL-hash mirroring of driver/strategy/mode (`#sim=PIA;M16,H46,H70;a`). | The one fan-useful sharing feature (P3); zero server cost. |
| D11 | Lap noise is stored but **not drawn** in the delta engine; the interval is parameter covariance + per-stint random effects + pit resampling (+ SC timeline). | Additive shared noise cancels exactly under common random numbers (all three proposals mis-stated this); the stint random effect makes the band predictive instead of model-conditional. |
| D12 | Horizon `H = laps_completed` for both strategies; a retired driver is never simulated to the flag. | P2/P3 simulated DNF drivers to `totalLaps` with an undefined actual plan past retirement. |
| D13 | Random-safety-car mode kept as the secondary mode, with a separate lap-1/2 start probability. | The brief asks for the circuit hazard; a constant hazard under-represents the 31 % of SCs on lap ≤ 2. |
| D14 | Calibration line: wall-clock totals (fc + real fuel sum) with the misfit decomposed; badge from modelled laps only, thresholds per modelled lap. | P1's A.5/F.6 disagreed on the units; P2's 1 %/3 % (55/165 s) badge carried no information. |
| D15 | Calibration totals are Python-stored and server-rendered; the browser `replay` exists for tests and a dev-only warning. | P2 defined the line as both a median of draws and a deterministic replay; one deterministic number, one owner. |
| D16 | `SIM_MIN_COMPOUND_LAPS = 30` (not P2's 10). | 10 would parameterise slicks on 17–18 laps next to 505 intermediate laps (2025 R1) and put an 11-lap SOFT in the picker. |
| D17 | Min stint 2 laps, max 4 stops (P2), presets from P2. | An in-lap needs an out-lap; a 1-lap stint is nonsense a fan produces by accident. |
| D18 | One `analytics_status` key `sim`; `SimNotEstimable(ValueError)`; `fc_all` bound from the existing `_laps_frame` return. | Fits `_guard` without touching it; the frame the fit consumes equals `laps.lap_time_fc_s` exactly. |
| D19 | Rain rule: > 50 % of representative laps on INTERMEDIATE/WET → no model. | P3's rule; a slick model from 35 laps is not a model. |
| D20 | Web tests via `tsx --test` (`node:test`), no vitest. | No new dependency; `tsx` is already a devDependency. |
| D21 | Five tables (calibration merged into `sim_driver_params`, δ_L as an array column). | P1's seven tables duplicated derivable rows; arrays keep one read per table by primary key. |
| D22 | `hazard === null` disables random mode instead of failing the section. | Events without a `circuit_key` or a DB where hazards were never recomputed must still simulate "as it happened". |

## 10. As built (integration record, 2026-09-12)

What the delivered simulator does differently from §1–§6, collected from every package's report
and from the integration pass (WP-S4). Everything not listed here was built as specified and
verified: the four `sim_*` tables (`web/drizzle/0001_sim.sql`, `--check-schema` exit 0), every
§4 type with the spec's names, the §5 engine pinned to Python by the golden fixture (17/17 at
1e-9) and to every live driver's stored calibration (§10.4), the §6 section mounted on
`/race/[year]/[round]` as the fifth nav entry (after *Tyre degradation*, before *Race trace*).

Data at integration: 2024 R1–R24, 2025 R1–R24 and 2026 R1–R13 re-ingested with `--force`
under one assumption set (id 116, `mixed_assumption_sets = false` for all three seasons);
`sim_race_params` holds 57 of the 61 races, `sim_circuit_hazard` 24 circuits. The four races
without a model are the rain races (`analytics_status.sim = 'error: SimNotEstimable: rain
race: N of M representative laps on INTERMEDIATE/WET'`, session status `partial`): 2024 R9
Canada, 2024 R21 São Paulo, 2025 R1 Australia, 2025 R12 Great Britain. No `sim` entry of any
other kind exists (no `KeyError`/`ValueError`/`IndexError`); all 17 sprint sessions carry no
`sim` key (the guard runs for races only). §7.3's "≥ 60 of 71" counted sessions; per race it is
57 of 61 (93 %).

### 10.1 Python estimation (§1, §3)

| Ref | As built | Why |
|---|---|---|
| §1.7 pit loss, Hungary 2024 | `pit_loss_s = 20.889`, `pit_loss_n = 40`, `pit_loss_mad_s = 1.216` (spec text: ≈ 20.7 from 39 stops). | The live green-flag filter (`pit_excess`: in-lap and out-lap both status `'1'`, both cars' timed) admits one more stop than the notebook count; the stored filter is the truth. |
| §1.10 `stint_coverage_80` | Hungary = 1.0 (spec expected 0.6–0.95); most races are 0.9–1.0. | It is an in-sample diagnostic: the per-stint random effects were calibrated on the same stints, so ±1.28 sd covers nearly all of them. Kept as a column (it still flags a race whose stints do not fit at all); not used by the UI. |
| §1.10 `replay()` | Takes a keyword-only `driver` (`replay(strategy, stops_status, *, driver, model, dc, …)`) and accepts `dc` as either the `driver_compound_dev` frame or a `{compound: offset}` dict. | The driver's base pace and compound deviations are looked up inside; the golden fixture generator and `calibrate` share one call shape. |
| §1.10 calibration replay start age | `calibrate` replays the actual strategy with `start_age = laps.tyre_life on lap 1` (1 when NaN), via the new `sim.start_age(laps)`. The spec's §1.10 table left it at the default 1 while §5.1 gives the browser `actualStartAge`; 162 of 1,231 lap-1 rows are on used tyres (e.g. Hungary 2024 STR age 4, ALO 3, BOT/ZHO 2), which put the stored `sim_total_fc_s` up to 1.1 s away from the browser's replay of the same strategy. | Fixed in WP-S4 (one Python change + `test_replay_matches_calibration` passes the same age); every season re-ingested afterwards. The golden fixture is unchanged (its drivers start on new tyres). |
| §1.6–1.7 `pit_excess` / `pit_loss` status rule | `pit_excess` rows carry `status_out` as well as `status_in`; a stop counts as green only when **both** the in-lap and the out-lap have `worst_status` in `{'1','2'}`; SC (`'4'`) and VSC (`'6'|'7'`) samples are classified by the in-lap. A stop is unusable when `field_delta_cars < SIM_MIN_CARS_FOR_DELTA` on either lap. | On a lap where every car pits under the SC the field δ is 0 by construction and the excess would swallow the whole SC slowdown (2024 Qatar laps 35–38); a stop whose out-lap is neutralised is not a green stop. |
| §1.5 `field_delta_cars` | `0` on lap 1 (the start lap has no δ) and low on red-flag / restart laps; δ is `0` wherever `cars < SIM_MIN_CARS_FOR_DELTA`. | — |

### 10.2 Query and engine (§4, §5)

| Ref | As built | Why |
|---|---|---|
| §1.10 / §5 "the browser reproduces `sim_total_fc_s`" | Holds only over the driver's **timed** laps and under the **calibration's own inputs**. `sim_total_fc_s` is, per the §1.10 table, the replay summed over laps with a `lap_time_s` (so the misfit identity closes); `replay(model, driver, driver.actual).totalFcS` sums all `1..lapsCompleted` laps, and the payload's `race.pitLoss` / `scPitFactor` / `vscPitFactor` follow the §4 chain (race → circuit → pooled) while `calibrate` uses the race's own pit loss (else `POOLED_PIT_LOSS_FALLBACK_S = 22.5`) and the race's own SC/VSC factors (else the `config` priors 0.86 / 0.95). The parity script (`output/sim_parity.mts`) therefore replays under the calibration's inputs and sums the timed laps: worst \|diff\| 2.7e-12 for every simulable driver of sessions 16, 395, 429 and 438 (Hungary 2024, Bahrain 2025, Monaco 2026, Italy 2026). The bare identity holds as written only for a driver with every lap timed in a race whose inputs are all its own: 54 of the 57 races have their own pit loss, 7 their own SC factor, 13 their own VSC factor, 2 all three, and 16 have their own pit loss with no SC/VSC lap at all (Hungary 2024 among them — there the full-horizon replay matches the stored total to 2.7e-12 for all 20 drivers). | `calibrate` runs inside one session's ingest and must not read `sim_circuit_hazard` (§9 D6: no per-session row depends on another session); the untimed-lap restriction is what makes `sim_total_fc_s − real_total_fc_s` decompose exactly. The dev-only `console.warn` of §5.4 (b) was consequently not built — it would fire on every race with a red flag or a borrowed factor. |
| §4 `SimPayload` | `getSimModel` also marks a driver `not simulable` with reason `stint data incomplete` when the stored `stints` rows do not tile `1..lapsCompleted`, mirroring `sim.driver_strategy`. Miami 2025 (session 397): FastF1 carries the literal `nan` compound and NaN `Stint` for laps 1–24, so 13 of 17 drivers are unavailable there; unrecoverable from the data. | Same rule on both sides, so the picker never offers a strategy the engine cannot expand. |
| §4 `model.unavailable` | Drivers without a `sim_driver_params` row (no driver dummy — fewer than `SIM_MIN_DRIVER_LAPS` fit laps) are listed with `reason = 'fewer than 8 clean laps'` and shown disabled in the picker (e.g. LEC, Italy 2026). | §6.2 wants every entrant visible with a reason. |
| §5.4 timing | The debounced edit-to-verdict latency measured in the dev server on Hungary (70 laps, N = 4000) is 292 ms: the 150 ms debounce plus run and React dev-mode render. The engine's own budget (< 300 ms) is asserted by `engine.test.ts`. | Within budget; the production build renders faster. |

### 10.3 Section, page and integration (§6, §7)

| Ref | As built | Why |
|---|---|---|
| §6 section constants | `SIM_SECTION_ID/TITLE/SUBTITLE` live in the new server-safe `web/components/sim/simMeta.ts`; `SimSection.tsx` re-exports them. The page imports them from `simMeta`. | Exports of a `"use client"` module become client references on the server — the nav link rendered `href="#function() { throw … }"` when the page read the constants from `SimSection.tsx` (found in the browser check). |
| §6.9 caption | `SimSection` renders the §6.9 caption (with the race's SC-stop percentage) and the borrowed-pit-loss / design-condition lines itself; the page's `<Section caption>` carries `SIM_SECTION_SUBTITLE`. | One `<Caption>` under the whole section, as specified; the subtitle is the header line. |
| §6.10 / §7.3 `/race/2025/13` | Belgium 2025 (`design_cond = 3.5e17`, the collinear race) shows the *No driver of this race can be simulated — ran non-parameterised compound INTERMEDIATE* empty state, not the design-condition caption: every driver's first stint was on intermediates, so no strategy is expandable. The caption line is exercised only when `designCond > 1e4` **and** a driver is simulable; no such race exists in the 57 (next-highest `design_cond` is 554, Italy 2026). | Data fact (rolling start behind the SC on a wet track). |
| §7.3 S4 "trust badge `good fit` for the winner" at Hungary | PIA (P1) is `rough` at 0.1512 s/lap and NOR at 0.1504 s/lap — both a hair over `SIM_CALIB_GOOD_S_PER_LAP = 0.15`; HAM (P3) is `calibrated` at 0.094; 12+ drivers are `calibrated`. | The winner's clean laps were run in a controlled McLaren 1–2; the badge threshold was not moved to make the example pass. |
| §7.2 re-ingest | `--season 2025/2026/2024 --force` from cache takes ≈ 30 s per season (1.5 s per race, sprints 0.7 s), not 1–2 min; `--recompute-hazards` ≈ 2 s. A `.claude/launch.json` (`f1-web`, `npm run dev -- --port 3000` in `web/`) was added for the browser check. | — |
| Browser check (§7.3 S4) | `/race/2024/13`: PIA default, four tiles, trust line, both charts painted on canvas (550×360 and 550×180 CSS px); *Pit 3 laps later* → `0.4 s faster`, P(faster) 54 %, hash `#sim=PIA;M21,H50,M70;a`; reloading that URL restores the editor and verdict; a +3 pit-lap edit re-ran in 292 ms. `/race/2025/1`: rain empty state with the stored reason. `/race/2026/6`: 12 SC laps + 2 red laps replayed (bands via the shared `statusBands`). `/race/2026/13`: STR (retired lap 26) → *Both strategies run to lap 26 — STR retired there*, trust line over his 23 timed laps; ALO disabled with *laps_modelled 16 < 20*, LEC disabled with *fewer than 8 clean laps*; *Pit loss borrowed from other races at this circuit* line present (2 green stops). Console: no errors on any page; the only warnings are ECharts *Can't get DOM width* lines emitted while the preview pane was still hidden on first load (v1 `EChart` wrapper, all seven charts alike, none on later loads). | — |

### 10.4 Verification record (§7.3 S4, run 2026-09-12)

| Check | Result |
|---|---|
| `cd web && npm run typecheck && npm run lint` | clean (after the `simMeta.ts` fix) |
| `rm -rf web/.next && npm run build` | clean, 0 warnings; five dynamic routes |
| `cd web && npm test` | 17/17 (golden fixture byte-identical after the start-age fix — its drivers start on new tyres) |
| `npx tsx --test components/sim/simState.test.ts` | 23/23 |
| `output/sim_parity.mts 16,395,405,429,438` | PARITY OK — worst \|diff\| 2.7e-12 over timed laps under the calibration's inputs (405 has no simulable driver) |
| `.venv/bin/pytest -q` | 176 passed in 28 s |
| `.venv/bin/python -m f1lab.ingest --check-schema` | schema ok |
| `for y in 2025 2026 2024: --season $y --force --sleep 0; --recompute-hazards` | exit 0 ×4, twice (before and after the start-age fix); 57 `sim_race_params`, 24 `sim_circuit_hazard`, 74 sessions `ok` + 4 `partial` (the rain races), all seasons on assumption set 116, `mixed_assumption_sets = false` |
| Dev server | stopped; port 3000 has no listener |

Files touched by WP-S4 outside its own list (cross-package fixes, each explained above): `f1lab/sim.py` (`start_age()`, `calibrate` passes it), `tests/test_sim.py` (`test_replay_matches_calibration` passes the same age), `web/components/race/SimSection.tsx` (constants re-exported from `simMeta.ts`), new `web/components/sim/simMeta.ts`, new `.claude/launch.json`, scratch `output/sim_parity.mts` / `output/sim_dump.mts` (run with `cd web && npx tsx ../output/<file> <sessionIds>`; not part of the app).

### 10.5 As built — review fixes (2026-09-12)

A four-lens adversarial review of the delivered v1.1 confirmed six findings (and refuted
fourteen others). All six were fixed and re-verified; the table says what the shipped code does
now, so where §1–§6 and §10.1–§10.4 disagree with this table, **this table is the truth**.
The fixes changed stored numbers: every season was re-ingested, so the assumption set moved
from **116 to 198** (`mixed_assumption_sets = false` for 2024, 2025 and 2026).

| # | Finding | What changed | Where |
|---|---|---|---|
| A | A per-race SC/VSC pit factor measured from a handful of stops could be implausible (−0.45, 1.74, 1.77, 2.51 on four races) and was used as-is. | A plausibility band `SIM_PIT_FACTOR_MIN = 0.3` / `SIM_PIT_FACTOR_MAX = 1.3`, justified from the measured distribution over all 57 modelled races (in-band per-race factors run 0.60–1.15). `pit_loss()` drops an out-of-band race factor to `None` and appends a warning, so the §4 race → pooled → config-prior chain supplies the value; `_hazard_frame` applies the same band to the pooled factor. The warnings are persisted in `session_ingests.warnings` (sessions 401, 427, 429, 436). The stored pit-loss *samples* are untouched — only the factor is dropped. Amends §1.7. | `f1lab/config.py`, `f1lab/sim.py` |
| B | δ_L (the field delta) carried a level of about −0.081 s/lap over green laps. Because the lap model has an unpenalised per-driver base dummy, `misfit_rep_s` is essentially −Σδ over the fit laps, so that level propagated straight into the trust badge as a **+0.059 s/lap "model optimistic" bias** on 845 of 963 drivers. | δ is now centred on its own green-lap level inside `lap_deltas` (`green_delta_offset`, a 5 % symmetrically trimmed mean of δ over laps that are green **and** have a known δ; `SIM_DELTA_CENTRE_TRIM`, `SIM_DELTA_CENTRE_MIN_LAPS`). Laps with an unknown δ stay at exactly 0; SC/VSC laps keep their full slowdown. No schema change — the offset is folded into the stored `field_delta_s` array and is **not** recoverable from the DB. Measured over 963 drivers: median signed misfit/lap +0.0594 → −0.0095, median \|misfit\|/lap 0.0665 → 0.0226; badges `calibrated` 884 → 887, `rough` 56 → 46, `poor` 23 → 30. **Deviation:** the reviewer prescribed a plain median; it was implemented, measured (calibrated 884 → 857, poor 23 → 32) and rejected in favour of the trimmed mean, because green-lap δ is right-skewed while the sum reaching calibration follows the mean. Amends §1.8. | `f1lab/config.py`, `f1lab/sim.py` |
| C | Drivers whose real strategy had more than `maxStops` stops produced **NaN** through delta, per-lap, histogram and quantiles (18 drivers in sessions 402 and 429). | The cause was not expansion but the fixed-size random-effect buffers: `uLevA/uSlpA/uLevE/uSlpE` were sized `constants.maxStops + 1` while the hot loop indexes them by the plan's stint index, so a 6-stop driver read past the end of a `Float64Array` (→ `undefined` → NaN). `MAXP` is now `planSlots(actual, edited, constants.maxStops)` and `MAXS = MAXP + 1`. The count depends only on the driver's actual strategy and the constants, so it does not move when the user edits and CRN across two edits under one seed is preserved. Amends §5.3 (`MAXS`/`MAXP` are no longer `constants`-derived). | `web/lib/sim/engine.ts`, `web/lib/sim/plan.ts` (new export `planSlots`) |
| D | `simulate()` threw *"a stint needs at least 2 laps"* / *"4 stops is the most this editor allows"* whenever the edited strategy equalled the actual one — i.e. for the pristine editor state of any driver whose real strategy is outside the editor limits. | The actual strategy is **data** and is always expanded with `LENIENT_LIMITS` (now an exported, documented constant of `plan.ts`: `minStintLaps: 1`, `maxStops: Infinity`). The strict `constants.minStintLaps` / `maxStops` apply to the **edited** strategy only, except when `sameStrategy(edited, actual)` — then the real strategy replays as data. A genuine edit is still rejected with `tooManyStops` / `stintTooShort`. Amends §5.1 (the limits are edited-only). | `web/lib/sim/engine.ts`, `web/lib/sim/plan.ts` |
| E | The editor's own `validate()` gated the **seeded** actual strategy the same way: 105 of 963 simulable driver-races (in 21 races) opened in an invalid state, the page's default driver among them in four races (10/LEC, 28/VER, 4/VER `stintTooShort`; 402/RUS `tooManyStops`). | `validate()` now distinguishes **pristine** (`sameStrategy(stints, driver.actual)`) from **edited**. A pristine strategy is expanded with `LENIENT_LIMITS`, never carries a row error and always runs; a 1-lap stint earns a muted per-row *note* and a >`maxStops` strategy a muted whole-strategy note. `SimValidation` gained `pristine` and `blockingMessage`, and `StintIssue.level` a third value `note` (muted, never blocking); `valid = planError === null && no row error`. `+ add stop` stays disabled past `maxStops` as a guard on the ADD action. `decodeHash` accepts a >`maxStops` hash when it reproduces that driver's own actual strategy. **Deviation:** an *edited* state is still gated as a whole (not per row), because `engine.ts` draws the same line at `sameStrategy`; the two sides must move together. Amends §6.4. | `web/components/sim/simState.ts`, `StintEditor.tsx`, `SimSection.tsx` |
| F | The trust caption's direction word was derived from the **whole-race** totals while the badge is computed from the **modelled-lap** misfit, so the word contradicted the number and badge beside it on 442 of 963 rows. | The word comes from `misfitRepS` alone (new exported `trustDirection()`: `>= 0` → *optimistic*, i.e. the model ran the modelled laps faster than the real car — the same quantity the badge thresholds on). The misfit sentence says "and on those laps only"; the whole-race total gets its own neutral signed clause ("a whole-race difference of −7.2 s across every lap, modelled and not"); the closing sentence explains why the two can point opposite ways. Amends §6.8 — *optimistic* is now defined as `misfit_rep_s > 0`, not "model total smaller than real". | `web/components/sim/TrustCheck.tsx` |

**Final verification (2026-09-12, after all six fixes).** `rm -rf web/.next && npm run typecheck
&& npm run lint && npm run build` clean; `npm test` 22/22; `npx tsx --test
components/sim/simState.test.ts` 31/31; `.venv/bin/pytest -q` **178 passed**;
`python -m f1lab.ingest --check-schema` ok. DB: 57 `sim_race_params`, 24 `sim_circuit_hazard`,
`analytics_status->>'sim'` is `ok` (57), the four rain `SimNotEstimable` reasons and NULL for
the 17 sprints — no `KeyError`/`IndexError`/`ValueError` of any kind; all three seasons on
assumption set 198 with `mixed_assumption_sets = false`; **no** `sim_race_params` row outside
the pit-factor band (in-band range: SC 0.597–0.842 over 5 races, VSC 0.623–1.151 over 11).
Regression sweep over every modelled race and every simulable driver (963 drivers, both modes,
300 draws): `simulate(edited = actual)` returns delta exactly 0 with every output number finite
for **963/963**; `validate()` calls the pristine strategy valid for 963/963; all 105
out-of-limits strategies carry a muted note; *Reset to actual* returns a valid state for
963/963. Badge/word agreement: `badge` equals the threshold function of
\|`misfit_rep_s`\|/`laps_modelled` for 963/963 rows (0 mismatches, 0 rows exactly at 0), and
SSR-rendering `TrustCheck` for all 963 real calibration rows gives **0** sign disagreements
between the word and the number (442 before the fix). Browser (dev, port 3000): `/race/2024/13`
four tiles, trust line, both charts, *Pit 3 laps later* → **0.4 s faster**, P(faster) 54 %, hash
`#sim=PIA;M21,H50,M70;a` mirrored and restored on reload; `/race/2025/10` (RUS, 5 stops) and
`/race/2026/6` (ANT; BOR with 7 stops and four 1-lap stints) load with a real verdict, muted
notes, no NaN and no editor error; `/race/2024/4` (red flag) the same; `/race/2025/1` shows the
rain empty state with its stored reason; `/race/2026/13` STR (retired lap 26) reports *Both
strategies run to lap 26 — STR retired there* with ALO and LEC disabled and their reasons.
Console: no errors — only the pre-existing ECharts *Can't get DOM width* warnings of §10.3.
Production (`npx next start -p 3000`): all 71 scheduled race pages 200 (61 ingested +
2026 R14–R23 *not yet ingested*), no *Application error*, *Internal Server Error*, `NaN` or
*Invalid Date* outside script tags on any of them, `id="simulator"` on all 61 ingested races
(57 modelled + the 4 rain races carrying the empty state). Screenshot of the edited section:
`output/sim_section_live.png`.
