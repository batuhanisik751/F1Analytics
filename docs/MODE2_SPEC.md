# F1 Analytics v1.3 — Mode 2: Driver vs Car Decomposition (MODE2_SPEC)

Status: **contract**. This document is the sole input for implementation. It supersedes
the three design proposals in `output/mode2_proposal_*.md`, which are working notes and
must not be read as requirements. Where this file disagrees with a proposal, this file
wins; where it disagrees with `docs/SPEC.md`, `docs/SIM_SPEC.md` or `docs/MODE1_SPEC.md`
on an existing contract, those win and this file is wrong — report it rather than
diverging.

Conventions, tone and rigour follow `docs/SPEC.md` §0.3, `docs/SIM_SPEC.md` §0 and
`docs/MODE1_SPEC.md` §0.

> **The one sentence this document defends.** For the 2024–2026 seasons only, we can
> say with an honest error bar how much of a fuel-corrected lap belonged to the driver
> and how much belonged to the car — and for four of the twenty-eight drivers we cannot
> say even that, because nothing in three seasons separates them from their machinery.

---

## Outline

| § | Title |
|---|---|
| 0 | Scope, fixed decisions, conventions |
| 1 | The model — specification, identifying variation, measured fit |
| 2 | Inference, intervals, and the identifiability diagnostic |
| 3 | The seven latent skills — three ship, four are refused |
| 4 | Car-adjusted career and counterfactuals |
| 5 | The constructor surface |
| 6 | Schema (DDL, `EXPECTED_COLUMNS`, Drizzle, migration 0003, artifact lifecycle) |
| 7 | Python (modules, signatures, config, CLI, tests, recompute) |
| 8 | Web (queries, charts, page slots, verbatim captions, empty states) |
| 9 | Work packages, ownership, sequencing, verification |
| 10 | Risks |
| 11 | Decisions log |
| 12 | As built |

---

## 0. Scope, fixed decisions, conventions

### 0.1 Scope

Four surfaces, shipped together as v1.3:

1. **Driver rating + skill profile** on the existing `/driver/[code]` route — a headline
   "how good is this driver, independent of the car" number with a 90 % interval, the
   rating over time, and the latent-skill panel (§3).
2. **Car-adjusted career** on `/driver/[code]` — actual points against what a
   field-average driver would have scored in the same machinery, season by season, plus
   a career-long team-mate head-to-head table (§4).
3. **Constructor surface** — a new `/constructor` area: car pace rating per season with
   driver effects stripped out, the in-season development segment, and retirement
   hazard (§5).
4. **"Was it the car?"** — a new season sub-route `/season/[year]/was-it-the-car`: the
   driver/car decomposition with intervals plus a counterfactual control (§4.4, §8.6).

Out of scope: any change to the v1.1 in-browser simulator (`web/lib/sim/**`,
`f1lab/sim.py`), any change to v1.2's `title_odds` / `preview_*` / `wp_*` outputs, and
any historical ingest.

### 0.2 Fixed decisions (not open for redesign)

- **FD1 — Python computes, the web reads.** Every number rendered by these four
  surfaces is precomputed into the tables of §6. The browser performs no inference, no
  Monte Carlo, and no combination of two stored estimates into a third (§6.3 exists
  precisely so the team-mate gap is not formed in TypeScript).
- **FD2 — Every driver and car number carries an interval, everywhere it is shown.** A
  point estimate rendered without its uncertainty is a bug in this feature, not a
  simplification. The DDL enforces it where it can (§6.2: `NOT NULL` on every `_lo` /
  `_hi`, a `CHECK` that a counterfactual row cannot exist without its p10/p90).
- **FD3 — Identifiability is measured, stored, and visible.** Every driver carries a
  graph-derived `anchor_class` and a fit-derived `evidence_share` (§2.4). Weakly
  identified drivers are rendered in a different visual grammar from well-identified
  ones (§8.4), and no table anywhere in this feature contains a grid-wide rank column
  (§6.1) — only `rank_in_component`, which is a rank that has been earned.
- **FD4 — Counterfactuals are extrapolation, labelled as such.** "Driver X in car Y"
  combines two effects never observed together. The interval is widened by a **measured**
  interaction term (§4.4), the widening is disclosed on the page, and for pairings whose
  basis is `by-analogy` the point estimate is not rendered at all.
- **FD5 — Reuse v1.1 and v1.2 estimates.** The model's observation unit is v1.1's
  per-race `sim_driver_params.base_s` (§1.1); the points machinery is v1.2's
  Plackett-Luce + Monte Carlo in `f1lab/title.py`, recalibrated for this use without
  touching v1.2's own constant (§4.1).
- **FD6 — Nothing throws.** Every section renders `<EmptyState reason=…>` when its
  inputs are missing and carries a `<Caption>` with the honest caveats (§8.7, §8.8).
- **FD7 — Existing contracts hold.** Drizzle owns DDL; explicit snake_case names;
  `assumption_set_id` on every analytics table; one `analytics_status` key per guarded
  analytic (§6.5 defines four); only `web/components/charts/EChart.tsx` imports
  `echarts`; pages are async Server Components with `export const dynamic =
  'force-dynamic'`.

### 0.3 The data window, and the claims it forbids

**The model is fitted on 2024, 2025 and 2026 race sessions only, on fuel-corrected
pace, and on nothing else.** No historical ingest exists and none is planned for v1.3.

This is a hard boundary on what the product may say, not a caveat to be softened:

- **No cross-era claims.** The response is *relative to the field of the same race*
  (§1.2). A driver effect of −0.30 % means "0.30 % of a lap clear of the average driver
  in the 2024–26 field", and that quantity is not defined against any other field.
- **No all-time rankings.** Twenty-eight drivers appear in the window. A rating is a
  position within those twenty-eight, under these regulations, on these circuits.
- **No "better than Senna", and no comparison to any driver, car or season outside the
  window** — including the same driver before 2024. The page says this in words (§8.7,
  caption `C-RATING-1`), not only in a tooltip.
- **No within-season driver rating.** §1.4 measures that the driver×season mobility
  graph has 28 components; a per-season refit is ~100 % prior at the level and is
  forbidden by §7.6's `test_no_per_season_refit`.

### 0.4 Conventions

| Convention | Value |
|---|---|
| Unit of every pace quantity | **percent of the race centre lap** (`pp`), negative = faster |
| Seconds translation used in copy | 1 pp ≈ 0.90 s on a 90-second lap; always stated, never implied |
| Interval | **90 %**, labelled "5th–95th" in copy, never the bare string "CI" |
| Ratios | reported as **SD ratios**, never variance ratios, in any fan-facing string (§1.5) |
| Table prefix | `mode2_` |
| Module prefix | `f1lab/decomp.py`, `f1lab/decomp_points.py` |
| Route additions | `/constructor`, `/constructor/[slug]`, `/season/[year]/was-it-the-car` |
| Status keys | `mode2_rating`, `mode2_skills`, `mode2_constructor`, `mode2_counterfactual` |
| Migration | `0003` |

All measured numbers in this document were produced against the live `f1` container
(`docker exec f1-postgres psql -U f1 -d f1`) and the project `.venv` on 2026-09-14. Any
implementer who reproduces a different number must report the discrepancy rather than
adjusting the code until it matches.

---

## 1. The model

### 1.1 Observation unit — a race-driver pace estimate, not a lap

**The unit is one `(session_id, driver_id)` row of `sim_driver_params`**, restricted to
`sessions.kind = 'R'`. The response is built from `base_s`, the per-race fuel-corrected
base pace fitted by v1.1's joint WLS lap model (`SIM_SPEC` §1.2), and each row carries
its own `base_se`.

This is a two-stage estimator and the choice is deliberate (FD5). The argument, with
numbers:

- v1.1's stage 1 has already removed the nuisance structure Mode 2 would otherwise have
  to re-model on all 58,228 representative laps: fuel burn, compound offsets
  (`sim_compound_params`), tyre age within stint, in/out laps and `track_status`
  contamination. Re-fitting from laps means re-deriving and re-litigating every one of
  v1.1's exclusions.
- Stage 1 also publishes how much each row should be trusted — `base_se`, `laps_fit`
  and the `badge` vocabulary (`calibrated` 907 / `rough` 46 / `poor` 30 of 983 simulable
  race rows, measured). Mode 2 uses that rather than re-deriving it.
- **The two-stage penalty was measured, not assumed.** A one-stage sparse least-squares
  fit of driver, car-season and race effects directly on all 58,228 representative laps
  (`scipy.sparse.linalg.lsqr`, **7.3 s measured**) disagrees with the two-stage fit by at
  most **0.10 pp** on any driver level. That disagreement ships as an explicit
  specification-uncertainty term, `MODE2_SIGMA_SPEC = 0.10` (§2.3), rather than being
  hidden. On team-mate *contrasts* the same comparison disagrees by at most **0.04 pp**,
  which is why §2.3 applies the two terms at different sizes.

The cost of the honest interval is the reason for the unit: the parametric bootstrap of
§2.3 costs ~4 minutes at 983 rows and would be a multi-hour job at 58,228 laps — i.e. it
would never be run, and the product would ship intervals conditional on variance
components it pretends are known.

### 1.2 Response and centring

For race `r` let `m_r` be the arithmetic mean of `base_s` over the *included* rows of
that race (§1.3). The response is

    y_rd = 100 · (base_s_rd − m_r) / m_r          [percent of the race centre lap, "pp"]
    s_rd = 100 ·  base_se_rd      / m_r          [the stage-1 SE in the same units]

Negative is faster. Within-race centring absorbs the circuit, the date, the fuel load,
the safety-car pattern and every other per-event effect **exactly**, which is why no
circuit term appears in §1.3. Two consequences are contractual:

1. Every effect in this model is **field-relative within a season**. A car at −1.79 pp
   in 2026 is further clear of *its own* field than a car at −0.80 pp in 2024; it is not
   "a second a lap faster in absolute terms". Every caption that shows a car rating says
   this (§8.7, `C-CAR-1`).
2. The grand mean is not estimable and is not wanted. `y` sums to ~0 within each race by
   construction.
3. **v1.8 — the stratum-completeness rule.** Within-stratum centring absorbs a per-stratum
   constant **exactly only if every row of that stratum is retained**. A specification that
   retains an outcome-selected subset of a stratum must **either keep the whole stratum or chain
   onto a common reference — never both centre locally and drop rows.** The rule binds every
   response in this spec, not only the race response, and it is the reason `GAPFILL_SPEC §1.1`
   rejects the deepest-segment qualifying construction.

   **Measured cost of breaking it** (qualifying, `GAPFILL_SPEC §1.1`): a variant that keeps one
   row per driver-session but centres it on the full field of that `(session, segment)` leaves
   the retained rows with a non-zero stratum mean — **+0.767 pp for Q1-eliminated rows, +0.477 pp
   for Q2-eliminated, 0.000 pp by construction for Q3** — against a τ_driver of **0.176 pp**.
   The 0.767 pp offset is **4.4× τ_driver** and there is no stratum term in §1.3 to absorb it, so
   it lands in δ and γ. Removing the three offsets drops τ_driver **0.176 → 0.072** and raises
   the car:driver ratio **2.71 → 4.32**.

   **The trap this rule exists to catch (`GAPFILL_SPEC §7`, R3).** The broken construction does
   not look broken. It uses *more* of each driver's running, and its **τ_driver comes out
   larger** — 0.176 against the clean 0.1605, inflated 2.4× once the offsets are removed — which
   reads as a richer, more confident, more discriminating fit. It is the opposite: the elimination
   stage a driver reaches is an **ordinal** signal, and centring locally while dropping
   outcome-selected rows re-imports that ordinal signal into the very skill that exists to escape
   an ordinal surrogate. **A τ_driver that rises when the response gets "richer" is evidence of
   contamination until proven otherwise.** Any candidate replacement response must therefore
   additionally report its **effect-level correlation against the selection-free Q1 response**:
   0.941 passes, 0.754 does not.

### 1.3 Specification

    y_rd  =  δ_d  +  γ_{c(d,r)}  +  β_{c(d,r)} · u_r  +  ε_rd

    δ_d       driver effect, one per driver, pooled:        δ_d ~ N(0, τ_δ²)
    γ_c       car level, one per (team, season) "cell":     γ_c ~ N(0, τ_γ²)
    β_c       car in-season development slope, per cell:    β_c ~ N(0, τ_β²)
    u_r       season progress, (round−1)/(rounds−1) − 0.5,  in [−0.5, +0.5]
    ε_rd      residual:  ε_rd ~ N(0, σ_ε² + s_rd²)

`s_rd` enters as a **known** heteroskedastic floor, so a driver who completed nine
representative laps at a red-flagged race is down-weighted automatically instead of being
excluded by a threshold.

**Everything is random (partially pooled); the only fixed effect is an intercept that
centring already pins near zero.** With two drivers per car and as few as three usable
races in some driver–car cells, unpooled effects would be wild, and the wildest ones
would be the most shareable. Shrinkage is the feature, and §7.6 tests for it.

**Inclusion filter** (every constant enters the assumption hash, §7.3):
`simulable = true`, `sessions.kind = 'R'`, `laps_fit >= MODE2_MIN_LAPS_FIT (24)`,
`badge <> 'poor'`, and the race must have at least `MODE2_MIN_CARS_IN_RACE (8)` included
rows. Measured: **1,124 raw race rows → 983 simulable → 941 after the row filter → 930
modelled rows across 28 drivers, 31 cells and 56 race sessions.** Excluded rows are
still written to `mode2_row_audit` with `included = false` and a reason, so /driver can
say "3 of Sainz's 24 rounds were not usable" instead of silently dropping them.

**Deliberately not in the model:**

| Omitted | Why |
|---|---|
| circuit effect | absorbed exactly by within-race centring (§1.2) |
| driver × circuit | 28 drivers × ~24 circuits from ≤3 observations each; unfittable, and the most seductive thing a fan would want |
| driver × season (form / improvement) | **destroys identification: the driver×season graph has 28 components (§1.4). Hard constraint, not a preference.** |
| driver × car interaction | not in the *rating* model, because it is what a counterfactual must extrapolate over. It **is** estimable and §1.6 measures it at τ = 0.099 pp; that measurement is used as the counterfactual widening term (§4.4). |
| team orders, strategy, racecraft | not observable in fuel-corrected pace. Contaminates δ and is disclosed as such (§4.1 measures the size of the gap). |

### 1.4 How driver separates from car — the identifying variation, measured

The identifying variation is the **bipartite mobility graph** whose nodes are drivers and
car-cells (team × season) and whose edges are the driver–car cells that actually raced.
Two drivers' effects are comparable only if a path connects them; a car's level is
separable from its drivers' only through paths that leave and re-enter it.

**Measured on the live DB (983 simulable race rows), and reproduced independently three
times — by the model-first proposal, by the identifiability review, and by this
document's own refit:**

    28 drivers · 31 car-cells · 72 edges · 59 nodes · 17 independent cycles
    → EXACTLY 4 CONNECTED COMPONENTS

| Component | Drivers | Cells | Members |
|---|---|---|---|
| `K1` the main grid | **15** | 17 | albon, antonelli, bearman, bortoleto, colapinto, doohan, gasly, hamilton, hulkenberg, kevin_magnussen, leclerc, ocon, russell, sainz, sargeant — alpine 24/25/26, audi 26, ferrari 24/25/26, haas 24/25/26, mercedes 24/25/26, sauber 25, williams 24/25/26 |
| `K2` the Red Bull family | **9** | 8 | arvid_lindblad, bottas, hadjar, lawson, max_verstappen, perez, ricciardo, tsunoda, zhou — cadillac 26, rb 24/25/26, red_bull 24/25/26, sauber 24 |
| `K3` Aston Martin | **2** | 3 | alonso, stroll — aston_martin 24/25/26 |
| `K4` McLaren | **2** | 3 | norris, piastri — mclaren 24/25/26 |

Twelve drivers changed team inside the window; **that mobility is the entire identifying
variation of this feature.** K1 is tied together by Hamilton (Mercedes→Ferrari), Sainz
(Ferrari→Williams), Ocon (Alpine→Haas), Hülkenberg (Haas→Sauber→Audi), Bearman and
Colapinto. K2 is tied by Pérez and Bottas both landing at Cadillac 2026 and by the
RB↔Red Bull shuttle.

**K3 and K4 are floating islands, and this is the headline honesty problem of the
feature.** Alonso, Stroll, Norris and Piastri never changed team, and neither did any
team-mate of theirs. Add a constant ξ to both McLaren drivers and subtract ξ from all
three McLaren cars: every fitted value in the data is unchanged. The data contain **zero**
information about that constant.

> **The model cannot tell you whether the 2025 McLaren was a rocket driven by two good
> drivers or an ordinary car driven by two great ones. Nor for Aston Martin. It can tell
> you, precisely, the gap between Norris and Piastri.**

What pins K3 and K4 in the fit is the pooling prior δ_d ~ N(0, τ_δ²), which softly
assumes each island's driver pair averages out to a field-average pair, and the ratio
τ_γ/τ_δ estimated from *other* teams. That assumption is doing all the work there, it is
almost certainly wrong, and §2 reports its consequence as a separately-labelled
uncertainty component rather than blending it invisibly into a bar. The affected rows
carry `basis = 'by-analogy'` in the DB (§6.2).

**v1.8 — the qualifying-only mobility graph, and why it changes nothing.** The graph above was
built on race rows. Rebuilt on **qualifying rows alone** (`kind = 'Q'`, the `§3.2b` fit's own
1,135 rows), it returns **28 drivers / 31 car-cells / 72 edges / 4 components**, and the four
components are **member-for-member identical** to K1–K4 above: K1 15 drivers, K2 9, K3
alonso + stroll, K4 norris + piastri. The same is true of the union of race and qualifying rows.
There are **zero qualifying-only edges**.

The reason is structural and is worth stating as a sentence rather than as a table: **a qualifying
session carries the same `session_entries` as its own race, so qualifying adds rows, not edges.**
A driver→car-cell membership graph is built from *who drove what*, and a qualifying session
introduces no driver-car pairing that its race did not already introduce. Norris/Piastri and
Alonso/Stroll therefore remain floating pairs under `one_lap_pace` exactly as they do under
`race_pace`, and **no volume of additional qualifying data will ever fix this — only a transfer
will.** `§3.2b`'s gate G2 rebuilds this graph on qualifying rows at run time and fails the **run**
if it ever returns anything but these four components with these members.

### 1.5 What the model cannot identify — the explicit list

1. **The level of any driver in K3 or K4** (Norris, Piastri, Alonso, Stroll), and
   equivalently the level of any McLaren or Aston Martin car. Only within-island
   contrasts are measured. More racing does not fix this; a transfer would.
   **v1.8: this now holds on three measured skills, not one.** It is true of `race_pace`, of
   `grid_pace` and of `one_lap_pace` (§3.2b), and it is true of all three for the *same* reason —
   they are three responses over one design matrix, and §1.4's graph is a property of the design,
   not of the response. **Adding a fourth response would not change it either.** `pct_field_below`
   is NULL for all four drivers on all three measured skills, and the run-time gate asserts the
   floating set is identical across them.
2. **Any per-season driver rating.** Measured: allowing δ to vary by season shatters the
   graph into **28 components**; a single season taken alone has **9 (2024), 9 (2025),
   10 (2026)** components. Within a season, a non-switching driver is *exactly*
   confounded with his car. §3.5 specifies what the rating-over-time surface is instead.
3. **The grand mean / absolute lap time.** Removed by centring, by design (§1.2).
4. **Anything about a driver's tyre management** (§3.3, measured null) **or wet-weather
   skill** (§3.4, zero usable observations).
5. **Racecraft** — starts, strategy execution, overtaking, defending, contact. §4.1
   measures the size of what pace does not explain and assigns all of it to nobody.
6. **Cause of retirement.** `results.status` has no mechanical-vs-accident vocabulary
   (§5.3), so the constructor hazard is split into a car and a driver component and is
   never called "reliability".
7. **v1.8 — on `one_lap_pace`, a cruise from a slow lap.** The response is the Q1 lap, and a
   driver whose car will walk into Q3 is measured on the lap he did not need. This is **measured,
   published and shipped anyway**, not waved at: on the **707 driver-sessions that set a time in
   both segment 1 and segment 3**, the top-6 drivers' margin over the same rivals in the same
   sessions is **−0.279 pp in Q1 against −0.490 pp in Q3 — 43 % smaller in Q1**. So `one_lap_pace`
   is **attenuated at the front of the grid by a factor this spec knows**, the attenuation is a
   property of the response rather than of the driver, and no per-driver correction for it exists
   or may be invented. §3.2b prices the two alternatives (V4 breaks the scale, V5 costs ~50 % of
   the precision) and `C-SKILL-5` carries the limitation to the reader.

### 1.6 MEASURED — the fit

Run against the live `f1` container with `.venv/bin/python`. **Spec S is the model that
ships** (§1.3, with the development slope). **Spec C** is the same crossed model without
the slope, and is reported because the two disagree about how much of the car's spread is
level and how much is development.

| Quantity | Spec S (ships) | Spec C (crossed, no slope) | This document's unweighted refit on all 983 rows |
|---|---|---|---|
| modelled rows | 930 | 930 | 983 |
| τ_δ driver SD | **0.264 pp** | 0.261 pp | 0.251 pp |
| τ_γ car-level SD | **0.874 pp** | 0.935 pp | 0.885 pp |
| τ_β development-slope SD | **0.348 pp** | — | — |
| σ_ε residual SD | **0.418 pp** | 0.409 pp | 0.451 pp |
| REML fit time | **3.15 s** | 2.9 s | 3.0 s |
| response SD | 0.953 pp | 0.953 pp | — |
| median stage-1 `base_se` in pp | 0.121 | 0.121 | — |

**The headline ratio, and the form it is allowed to take.** τ_γ/τ_δ = **3.3** under Spec S
(3.6 under Spec C, 3.5 on the unweighted refit). In lap terms the car spread is ≈0.79
s/lap against a driver spread of ≈0.24 s/lap on a 90-second lap.

> **The car:driver ratio is published as an SD ratio and never as a variance ratio.** The
> variance ratio is 11; a fan reads "11×" as "the car matters eleven times more", which
> is three times the truth in the units the rest of the page uses. Any string, tile,
> caption or alt-text containing a car:driver ratio must be an SD ratio, and §7.6's
> `test_no_variance_ratio_in_copy` greps the web bundle for the forbidden forms.

Fitted driver effects, Spec S, pp of the race centre lap (negative = faster):

    max_verstappen -0.733 | leclerc -0.243 | norris -0.228 | perez -0.188 | gasly -0.185
    sainz -0.119 | hadjar -0.116 | hulkenberg -0.077 | piastri -0.064 | russell -0.048
    antonelli -0.044 | albon -0.039 | bearman -0.016 | alonso -0.007 | doohan -0.003
    ocon +0.014 | bortoleto +0.027 | hamilton +0.050 | colapinto +0.058 | lawson +0.094
    arvid_lindblad +0.121 | kevin_magnussen +0.139 | bottas +0.178 | stroll +0.188
    zhou +0.195 | ricciardo +0.249 | tsunoda +0.378 | sargeant +0.421

Two facts about this list belong in the spec, not a footnote. (i) Verstappen at −0.733 is
2.8 prior SDs clear of the field — the model is not shy. (ii) Hamilton at +0.050 sits
behind Leclerc at −0.243, a result that will be screenshotted and argued about, and whose
interval (±0.13) does not come close to covering the 0.29 gap. The page must be built to
survive being right about something unpopular, which means the caveats have to be
visibly load-bearing rather than decorative.

### 1.7 MEASURED — the additivity test

The rating model assumes δ and γ **add**. That assumption is testable and was tested: a
driver × team-season interaction random effect is estimable, because **67 of the 72 cells
contain two or more races**, so a cell mean is separable from within-cell race noise.

    τ_interaction = 0.099 pp   (72 cells; 0 of 72 BLUPs exceed 2 posterior SE)
    for scale:  τ_δ = 0.264 pp,  σ_ε = 0.418 pp

**Interpretation, stated carefully.** This is a low-power test and the BLUPs are shrunk
toward zero by construction, so "0 of 72 above 2 SE" is close to tautological and must
not be reported as confirmation that drivers and cars are additive. What the number *is*
good for is a **scale**: whatever driver–car interaction exists is of order 0.1 pp, about
40 % of the driver spread. That measured 0.099 is what §4.4 uses to widen counterfactual
intervals — a measured widening term instead of a hand-picked one.

### 1.8 MEASURED — how much of this is a modelling choice

The single most useful diagnostic produced for this feature. Refitting under two
reasonable specifications (Spec S vs a fixed-effects variant that drops the pooling
prior) moves the estimates by:

    island driver LEVELS         up to 0.615 pp   (norris)
    every team-mate CONTRAST     at most 0.041 pp

> **The team-mate gaps are a measurement. The cross-team ordering is a modelling choice.**

That sentence is the spine of the copy on `/season/[year]/was-it-the-car` (§8.7, caption
`C-WITC-1`) and the reason §2.3 applies specification uncertainty asymmetrically:
`MODE2_SIGMA_SPEC = 0.10` pp on levels, `MODE2_SIGMA_SPEC_CONTRAST = 0.04` pp on
contrasts.

---

## 2. Inference, intervals, and the identifiability diagnostic

### 2.1 Engine — no new package

**numpy + scipy only** (scipy 1.18.1, already in `.venv`). No PyMC, no numpyro, no jax;
`requirements.txt` does not change. `statsmodels.MixedLM` is deliberately not used for
the shipping fit: it supports one grouping factor, and driver / car / car-slope are
crossed, not nested. (It may be used in tests as an independent cross-check on the
crossed-without-slope variant; §7.6.)

    REML:  minimise  ½[ log|V| + rᵀV⁻¹r + log|XᵀV⁻¹X| ]
           V = τ_δ² Z_δZ_δᵀ + τ_γ² Z_γZ_γᵀ + τ_β² Z_βZ_βᵀ + diag(σ_ε² + s_rd²)
    BLUP:  [XᵀR⁻¹X   XᵀR⁻¹Z ; ZᵀR⁻¹X   ZᵀR⁻¹Z + G⁻¹] [b̂ ; û] = [XᵀR⁻¹y ; ZᵀR⁻¹y]
    Cov(û − u) = the corresponding block of the inverted coefficient matrix A⁻¹.

With 930 rows and 90 random effects the matrices are 930² and 91², i.e. dense linear
algebra, no sampling. **Measured: REML 3.15 s (Nelder–Mead, 125 iterations); BLUP solve
and covariance < 0.1 s.** The full coefficient-matrix inverse `A⁻¹` is retained in memory
for the whole run because §2.5 and §4 both need quadratic forms out of it.

### 2.2 The three sources of uncertainty, reported as two

| # | Source | What it means to a fan | Where it goes |
|---|---|---|---|
| 1 | **Contrast uncertainty** — posterior SD of `e_d − mean(e over the driver's component)` | how well the data pin this driver against the drivers he is connected to | `sd_within`. This is measurement. |
| 2 | **Component-offset uncertainty** — posterior SD of the whole component's level against the rest of the field | how well the data pin his island at all; for K3 and K4 this is *pure prior* | `sd_island`. This is assumption. |
| 3 | **Variance-component uncertainty** — τ_δ, τ_γ, τ_β, σ_ε are themselves estimated | folded into 1 and 2 by the parametric bootstrap of §2.3 | both |

`sd_total² = sd_within² + sd_island² + MODE2_SIGMA_SPEC²` for a level;
`frac_floating = sd_island² / sd_total²` is the share of a driver's rating uncertainty
that is assumption rather than measurement, and it is stored per driver.

### 2.3 Interval construction

- **Parametric bootstrap**, `MODE2_BOOTSTRAP_REPS = 400`, `joblib.Parallel(n_jobs=8)`,
  warm-started at the fitted τ's. Data are simulated from the fitted variance components,
  the model is refitted, and the reported 5th/95th percentiles come from the bootstrap
  distribution of each effect — which automatically contains both the BLUP posterior
  spread and the τ uncertainty. **Measured: 32 reps at n_jobs=8 = 19.6 s wall (4.90 s
  per rep serial-equivalent) → 400 reps ≈ 245 s (~4 min).**
- **A race-cluster (non-parametric) bootstrap is FORBIDDEN, and this is a measured
  trap, not a style preference.** Resampling races cannot resample a transfer that never
  happened, so a race-cluster bootstrap hands the island drivers the *narrowest* bands on
  the grid — measured: norris ±0.095 and alonso ±0.132 against verstappen ±0.294, i.e.
  exactly backwards. `test_island_intervals_are_widest` (§7.6) is a build gate that
  fails if any future substitution reintroduces this.
- **Specification uncertainty** is added in quadrature, asymmetrically, per §1.8:
  `MODE2_SIGMA_SPEC = 0.10` pp on every published **level** (driver rating, car rating);
  `MODE2_SIGMA_SPEC_CONTRAST = 0.04` pp on every published **contrast**. Applying the
  level term to contrasts would inflate a team-mate gap from ±0.083 to ±0.13 and would
  contradict the very measurement (§1.8) that makes contrasts the trustworthy object.
- **Reported interval is 90 %** and the label always names it ("5th–95th"), never "CI".
  The choice of 90 over 95 is a readability choice and is disclosed in the glossary line
  of every chart caption; it is not a licence to pick whichever band looks better, and
  the stored columns are `_lo` / `_hi` with the level recorded in `mode2_fit_run.ci_level`.

### 2.4 The per-driver identifiability diagnostic

**Two numbers plus one label. All three are stored; none is computed in the browser.**

**(1) `evidence_share`** — the fraction of the prior variance the data resolved:

    evidence_share_d = 1 − Var_post(δ_d) / τ_δ²      ∈ [0, 1]

MEASURED on the race-pace model:

    BEST   max_verstappen 0.781 · leclerc 0.773 · sainz 0.773 · tsunoda 0.768 · albon 0.768
    WORST  stroll 0.522 · alonso 0.523 · doohan 0.522 · piastri 0.527 · norris 0.527

> **`evidence_share` is not comparable across skills, and on its own it is misleading.**
> On the grid-pace model (§3.2) the four island drivers come out at evidence_share
> **0.724** — apparently well identified — with the four *widest* posterior SEs on the
> grid (0.211 against verstappen's 0.149). Their level is exactly as unidentified there
> as in race pace; the friendlier-looking number is purely an artefact of τ_γ/τ_δ being
> ≈1.1 in the grid model instead of ≈3.3. Shipping `evidence_share` as the badge would
> hatch Norris on one skill and not the next, in the same profile, which reads as
> knowledge the model does not have. **The badge is therefore `anchor_class`, which is
> graph-derived and identical across every skill.**
>
> **v1.8 amendment — amended, not repealed.** On `one_lap_pace` (§3.2b), where
> τ_γ/τ_δ = **3.50**, the four island drivers land at **0.501 / 0.502** — the *lowest*
> evidence_share among full-season drivers, and far below the 0.724 the grid model gave the same
> four. Read this the right way round: it is **not** `evidence_share` behaving better on the new
> skill, and it is **not** a licence to use it. It is this warning's own prediction confirmed on a
> third response — the statistic tracks the prior ratio τ_γ/τ_δ, so it moves from 0.724 to 0.501
> for the same four drivers whose identifiability did not change at all. The one thing that did
> not move is `anchor_class`: norris, piastri, alonso and stroll are `floating` on all three
> measured skills. **The badge remains `anchor_class` precisely because it does not move between
> the two fits.**

**(2) `frac_floating`** — §2.2. MEASURED:

| Driver | Component | δ̂ (pp) | sd_within | sd_island | sd_total | **frac_floating** |
|---|---|---|---|---|---|---|
| norris | K4 McLaren | −0.228 | **0.043** | 0.176 | 0.182 | **94.3 %** |
| piastri | K4 McLaren | −0.064 | **0.043** | 0.176 | 0.182 | **94.3 %** |
| alonso | K3 Aston | −0.007 | 0.047 | 0.176 | 0.182 | **93.4 %** |
| stroll | K3 Aston | +0.188 | 0.047 | 0.176 | 0.183 | **93.2 %** |
| max_verstappen | K2 | −0.733 | 0.090 | 0.086 | 0.124 | 47.9 % |
| tsunoda | K2 | +0.378 | 0.094 | 0.086 | 0.127 | 45.4 % |
| sainz | K1 | −0.119 | 0.107 | 0.067 | 0.126 | 28.2 % |
| leclerc | K1 | −0.243 | 0.107 | 0.067 | 0.126 | 28.1 % |
| hamilton | K1 | +0.050 | 0.111 | 0.067 | 0.130 | 26.5 % |
| doohan | K1 | −0.003 | 0.169 | 0.067 | 0.182 | 13.4 % |

The result that shapes the entire /driver design:

> **Alonso, with 43 races of data, is no better identified than Doohan, with 5.** Both
> have a total SD of 0.182. Doohan's is wide because we barely saw him. Alonso's is wide
> because we saw him 43 times *in the same car, next to the same team-mate*, and none of
> it tells us how good the car was. More races did not help. Only a transfer would.

**(3) `anchor_class`** — derived from the mobility graph, not from the fit, so it is
explainable in one sentence and identical on every skill surface:

| Class | Rule | Drivers (measured) | UI treatment (§8.4) |
|---|---|---|---|
| `anchored` | in a component with ≥5 drivers **and** personally raced ≥2 cells | perez, hadjar, hulkenberg, sainz, bearman, ocon, bortoleto, hamilton, colapinto, lawson, bottas, tsunoda | solid bar, plain number |
| `component-anchored` | in a component with ≥5 drivers, never switched | max_verstappen, leclerc, gasly, russell, antonelli, albon, doohan, kevin_magnussen, zhou, ricciardo, arvid_lindblad, sargeant | solid bar + hatched cap |
| `floating` | component has <5 drivers — the level is prior-driven | **norris, piastri, alonso, stroll** | fully hatched bar, hollow dot, "level not measured" chip, no plain numeral |

### 2.5 Contrasts are first-class objects

A team-mate gap is **not** formed by differencing two marginal intervals — the two
effects are strongly negatively correlated and differencing their marginal SDs roughly
doubles the true width. Every contrast this product shows is computed in Python as a
proper quadratic form against the retained coefficient inverse:

    contrast  c = e_a − e_b
    value     cᵀû
    se        sqrt(cᵀ A⁻¹ c)  (+ MODE2_SIGMA_SPEC_CONTRAST in quadrature)

and stored in `mode2_driver_contrast` (§6.3) with `same_component` set. MEASURED:

    norris − piastri            −0.173 ± 0.083   same_component = true   (a measurement)
    max_verstappen − norris     −0.606 ± 0.204   same_component = FALSE  (crosses K2→K4)

The UI may annotate a gap only when `same_component = true`; a cross-component gap is
rendered with the §8.4 separator and the `C-CONTRAST-2` caption.

### 2.6 Diagnostics that gate rendering

Computed every run, stored in `mode2_fit_run`, surfaced on the four `analytics_status`
keys of §6.5:

| Check | Rule | Status when it fails |
|---|---|---|
| convergence | REML optimiser `success` and ‖∇‖ < 1e-4 | `SimNotEstimable: mode2 fit did not converge` |
| minimum evidence | ≥20 race sessions and ≥20 drivers modelled | `partial: not enough races for a rating` |
| shrinkage sanity | spread of δ̂ < spread of the raw per-driver team-mate gaps | `SimNotEstimable: shrinkage check failed` |
| residual scale | σ̂_ε ∈ [0.2, 1.0] pp | `partial: residual scale out of range` |
| island sanity | component membership recomputed and stored; count of `floating` drivers surfaced | never blocks — this is content, not an error |
| interval direction | the four `floating` drivers hold the four widest `sd_total` | `SimNotEstimable: interval direction check failed` |

A driver with no included row gets no rating row at all, and /driver renders
`<EmptyState reason="partial: no usable race pace for this driver">` — never a bar at 0.

---

## 3. The seven latent skills — three ship, four are refused

The brief asked for four: one-lap pace, race pace, tyre management, wet weather. All four
were fitted against the live database. **Two cannot be estimated honestly and are not
shipped as numbers.** There is no radar chart in v1.3 — §3.6 specifies what replaces it.

### 3.0 Two corrections to the brief, measured

1. **There were no Q1/Q2/Q3 columns and no qualifying sessions when this spec was
   written — and as of v1.6 there are.** *Measured at v1.3:* `sessions.kind` was
   constrained to `('R','S')`; `results` carried only `position, classified_position,
   grid_position, points, status, laps_completed, result_time_s`; there was no qualifying
   lap time anywhere in the schema. One-lap pace *as specified in the brief* was not
   available, so §3.2 ships the nearest honest thing under a different name.
   `grid_position` is present on **1,266 of 1,266** race result rows (one value is `0`).

   **v1.6 status.** `sessions.kind` is now `('R','S','Q','SQ')` and the database holds 71
   qualifying and 18 sprint-qualifying sessions with their laps, their official Q1/Q2/Q3
   times (`quali_results`) and a per-segment breakdown (`quali_segment_times`). **The §3.2
   fit is still run on `grid_position` and no `mode2_*` row was written, deleted or
   refitted in v1.6** (`QUALI_SPEC` D7). The reason is in `QUALI_SPEC §5.1`: swapping the
   response from an ordinal grid slot to a continuous lap time is a **refit**, not a
   relabel — a new response needs its own identifiability run, and validating it against
   rows produced by that release's own brand-new ingest would leave no independent check.
   The refit is pre-specified in `QUALI_SPEC §5.1.1` for v1.7, with its retirement
   criterion (r ≥ 0.95) and both identifiability gates written down in advance so it is
   decided by a number rather than by whoever is in the room.

   **v1.8 status — the refit has been done, and the surrogate was joined, not replaced.**
   `one_lap_pace` ships as a measured skill fitted on qualifying lap times: **§3.2b**. The
   pre-registered retirement criterion was evaluated rather than deferred and **did not fire** —
   measured `corr(one_lap_pace, grid_pace)` = **0.8393** across all 28 drivers (**0.8670**
   excluding the four island drivers), below the 0.95 at which `QUALI_SPEC §5.1.1` pre-registered
   deletion — so `grid_pace` is kept, unchanged, unrenamed and not retired (§3.2). **This
   paragraph's forward pointer is now a backward pointer:** the refit is not pending in a later
   release, it is in §3.2b of this document, and anything in §3.0 or §3.2 phrased as "until the
   refit" should be read as "until v1.8", which has happened.
2. **Rain: 13 race sessions recorded any rainfall, and 7 had ≥15 % wet samples — but the
   count was never the problem.** §3.4 has the measurement that matters.

### 3.1 Race pace — **SHIPS**. This is the rating.

Exactly §1.3. δ̂ in pp of the race centre lap, 930 rows, 28 drivers, 56 races,
evidence_share 0.52–0.78, four components, intervals split within/island per §2.2. It is
the headline "how good is this driver" number and the only one presented as *the* rating.

### 3.2 Grid pace — **SHIPS**, but never under the name "one-lap pace"

**v1.8 status: still fitted on `grid_position`, still ships, still never called one-lap pace.**
It is no longer the *only* one-lap axis — **§3.2b is.** `corr` between the two is **0.8393**
(**0.8670** excluding the four island drivers), below the **0.95** the retirement was
pre-registered at in `QUALI_SPEC §5.1.1`, **so both ship.** Not one stored `grid_pace` row was
deleted, relabelled, refitted or moved; the 28 rows, the key, the unit and the caption slot
`C-SKILL-2` are exactly what they were. Both correlations are **stored** on `mode2_fit_run`
(`corr_one_lap_grid`, `corr_one_lap_grid_ex_islands`) so the retirement decision is auditable
from the database in every later release, and gate G3 fails the build if either ever crosses 0.95
— retirement stays a human decision requiring a spec edit.

**v1.6 status: unchanged, deliberately.** Qualifying times exist in the database as of
v1.6, so the one-lap signal below is no longer the only one available — but this fit still
runs on `grid_position`, the numbers below still stand, and no `mode2_*` row moved. The
replacement is a refit, pre-specified in `QUALI_SPEC §5.1.1` for v1.7. Everything from here
to the end of §3.2 describes what ships today. **(v1.8: the refit is done and lives in §3.2b;
this paragraph stands because every word of it about *this* fit is still true.)**

When this model was fitted there were no qualifying times, and the only available one-lap
signal was where the car started.

**Model.** Within each race convert grid position to a normal score
`z_rd = Φ⁻¹((grid_rd − 0.5)/N_r)`, then the same crossed mixed model with driver and
car-cell random effects (no development slope; an ordinal response cannot support one).

**MEASURED — 1,265 rows / 62 sessions / 28 drivers, REML 2.5 s** (normal-score units):

    τ_driver 0.456   τ_car 0.496   σ 0.639
    best   max_verstappen −1.100 ±0.167 · norris −0.756 ±0.235 · russell −0.680 ±0.189
           piastri −0.505 ±0.235 · leclerc −0.494 ±0.172 · sainz −0.297 ±0.170
    worst  zhou +0.581 ±0.242 · stroll +0.550 ±0.235 · sargeant +0.517 ±0.222
    corr(grid effect, race-pace effect) = 0.80 across 28 drivers

Four things this forces onto the page and into the spec:

- **It is called "Starting-grid pace", never "qualifying pace" and never "one-lap
  pace".** `grid_position` absorbs grid penalties, pit-lane starts, and sprint-weekend
  grids set by a different session. A five-place gearbox penalty enters this model as
  driver slowness and **this model does not subtract it**. Until v1.6 it could not be
  subtracted at all, because there were no qualifying times to subtract it from; as of
  v1.6 the subtraction is possible — `quali_results.position` is where the car qualified
  and `grid_position` is where it started. Caption `C-SKILL-2` says exactly this.

  **v1.8 — the contamination is now visible, and it is still not subtracted.** With §3.2b
  shipping beside this skill, the penalties, the pit-lane starts and the sprint-weekend grids are
  no longer performed *inside* one number with no way to see them: they are the **disagreement
  between two shipped skills**, and at r = 0.8393 that disagreement is roughly 30 % of the shared
  variance. **This is a statement the page may make in words and only in words.** The difference
  is **not computable as a number**: `grid_pace` is a normal score and `one_lap_pace` is a
  percentage of a lap, so a per-driver "what the penalties were worth" would be a subtraction
  across two scales that do not share a unit or an origin. It would also be wrong even if the
  units matched, because the same gap carries the Q1-cruise attenuation (§3.2b), the wet and
  sprint exclusions, non-random missingness and noise. **No subtraction, no "what the penalties
  were worth" column, ever** — words only, in `C-SKILL-2`.
- **The same four drivers are floating here.** The mobility graph is the same graph, so
  `anchor_class` is unchanged: norris, piastri, alonso and stroll are `floating` on this
  skill too, and they carry the four widest posterior SEs (0.211 vs verstappen 0.149).
  Their apparently comfortable evidence_share of 0.724 is an artefact of the prior ratio
  (§2.4) and must never be used to style this surface.
- **Its scale is not comparable to race pace** and the two are never plotted on a shared
  axis, never on a radar. A rank is a compressed measure: the ordinal scale caps how far
  apart cars can get, which is why τ_car/τ_driver is ≈1.1 here and ≈3.3 for race pace.
  Two separately-scaled bars, each with its own "% of the field below" annotation.

  **v1.8 — this prohibition is lifted for the new skill ONLY, and it remains absolute for
  `grid_pace`.** The objection above is an objection to an **ordinal compression**, and it does
  not apply to `one_lap_pace` (§3.2b): both `race_pace` and `one_lap_pace` are percent of a lap,
  centred within a session on the field actually present, and τ_car/τ_driver is **3.50** on the
  qualifying fit against **3.31** on race pace — the compression is gone, measured, not asserted.
  **`race_pace` and `one_lap_pace` may therefore share one numeric axis**, labelled
  `pp — percent of a lap, relative to the session's own field`, as two bars. **`grid_pace` keeps
  its own axis and its own panel row and never joins them, in any release, for any reason.**
  Four conditions travel with the shared axis, all test-enforced: (1) never summed, averaged or
  reduced to an overall rating, and the radar stays banned (§3.6); (2) `pct_field_below` is **not**
  comparable across the two `pp` skills — the field spreads differ, τ_car 0.562 in qualifying
  against 0.874 in the race — so each bar keeps its own annotation and the two percentages are
  never subtracted; (3) no cross-scale arithmetic with `grid_pace`, in numbers, ever (the bullet
  above); (4) a shared *scale* is not a shared *claim* — 24 of 28 qualifying intervals cross zero,
  so a driver 0.2 pp better in qualifying than in the race has **not** been shown to be a
  qualifying specialist. **"Drivers are closer together over one lap" is forbidden copy** and is
  grepped by a test: every scale-clean construction returns a car:driver ratio of 3.0–3.6, and
  only the outcome-selected variant §1.2 rejects returns 2.71.
- With r = 0.80 the two axes share ~64 % of their variance. The page says "these two
  measure overlapping things", not "two independent talents".

### 3.2b One-lap pace — **SHIPS**, and it is a lap time

**New in v1.8.** Key `one_lap_pace`, rendered **"Qualifying pace"** — never "One-lap pace", never
"One lap pace", never "Starting-grid pace". The fit is on Q1 alone, which is narrower than "one
lap", and a mirror guard in `tests/test_mode2_skills.py` pins the rendered label. This is the
skill `QUALI_SPEC §5.1.1` pre-specified; the deviations from that pre-registration are recorded
below and in `QUALI_SPEC §5.1.1` itself, not left silent.

**Response.** One row per **driver-session**, on the **first segment only** (Q1), centred within
the session exactly as §1.2 centres within the race:

    y_sd = 100 · (best_s[d, s, seg=1] − m_s) / m_s     [pp — percent of the session's Q1 field mean]
    m_s  = arithmetic mean of best_s over drivers with a segment-1 time in session s

Negative is faster. Source rows: `quali_segment_times` where
`segment = 1 AND verified AND best_s IS NOT NULL AND NOT wet_compound`, `sessions.kind = 'Q'`,
sessions with at least `MODE2_QUALI_MIN_DRIVERS` (8) such drivers, driver present in the
race-pace fit's component map (the same rule `fit_grid_pace` uses).

**`m_s` and the minimum-drivers test are computed over the full surviving segment-1 field,
before the component-membership filter, not after.** That is §1.2's stratum-completeness rule
applied literally: within-stratum centring absorbs the session constant exactly only if the whole
stratum is retained. Computing them after the filter would be the same class of error that
rejects the deepest-segment variant below.

**Why percent and not seconds — the Monaco/Spa rule, inherited unchanged.** §1.2 settled this for
race pace: within-session percent centring absorbs the circuit, the date and the conditions
*exactly*, which is why no circuit term appears in §1.3. A tenth at Monaco is 0.14 pp; a tenth at
Spa is 0.09 pp; the model never sees a second. Qualifying inherits it without modification.

**Why segment 1 and not the driver's best lap — six candidate responses, all fitted** on the same
`_CrossedDesign` / `_fit_crossed` engine, dry rows only, 28 drivers:

| # | response | rows | sess | τ_driver | τ_car | σ_ε | τ_car/τ_driver | corr(race_pace) |
|---|---|---|---|---|---|---|---|---|
| **V3** | **segment 1, session-centred pct (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **3.50** | **0.773** |
| V2 | all segments, session×segment centred | 2,556 | 57 | 0.143 | 0.506 | 0.487 | 3.54 | 0.761 |
| V4 | deepest segment reached, centred in it | 559 | 57 | 0.233 | 0.226 | 0.722 | 0.97 | 0.592 |
| V5 | deepest lap, **chained** onto the Q1 scale | 1,135 | 56 | 0.233 | 0.633 | 0.607 | 2.72 | — |
| V1 | `gap_to_pole_common_pct` (pre-registered) | 1,146 | 57 | 0.126 | 0.605 | 0.667 | 4.80 | 0.637 |
| — | `grid_pace` today (normal score) | 1,265 | 62 | 0.4562 | 0.4963 | 0.6388 | 1.09 | 0.80 |

**Finding 1 — segments 2 and 3 are a sample selected *on the response*.** Only the fast half
reaches Q2 and only ten drivers reach Q3, so a Q3 row compares a driver against a truncated,
faster field. V4 is that effect in pure form: τ_car collapses to 0.226 and Hülkenberg and
Hamilton, who scrape into Q3, come out among the *slowest* drivers in the championship.

**The rejected outcome-selected construction, named so it is not re-proposed.** A
"deepest segment reached, centred in that segment's **full** field" variant retains one row per
driver-session — which looks like V4's problem solved — and is worse than it looks. Because the
retained subset of each stratum is chosen by the outcome, the retained rows carry a **non-zero
stratum mean: +0.767 pp for Q1-eliminated rows, +0.477 pp for Q2-eliminated, 0.000 pp by
construction for Q3.** §1.3 has a driver term and a car term and **no stratum term**, so a
0.767 pp offset — **4.4× τ_driver** — is absorbed into δ and γ. Removing the three offsets drops
τ_driver **0.176 → 0.072** and raises the car:driver ratio **2.71 → 4.32**. The elimination stage
a driver reaches is an **ordinal** signal, and this construction re-imports it into the very
skill that exists to escape an ordinal surrogate. **Rejected**, and §1.2's stratum-completeness
rule is written to stop it coming back — including its trap, that its τ_driver comes out *larger*
and therefore reads as an improvement.

**Finding 2 — `§5.1.1`'s own predicted degradation does not occur on this response.** §5.1.1
flagged that "missingness becomes non-random — a Q1 crash produces no time at all". Measured:
**1,560 of 1,567 driver-sessions have a segment-1 time (99.55 %)**. On a deepest-segment
response, missingness is 100 % for every driver eliminated in Q1, by definition. The thin-data
flag `n_obs < 25` (`MODE2_QUALI_THIN_N`) is kept anyway and rendered.

**Why not the pre-registered `gap_to_pole_common_pct` (V1).** It is referenced to *one lap by one
driver*, so pole's own noise enters every row: refitting on the stored `gap_to_best_pct` moves
τ_driver 0.151 → 0.122 and τ_car 0.543 → **0.676**, which is pole's noise reappearing as car
variance. It also selects the deepest **common** segment, re-importing the selection above, and
it measures worst on every axis in the table. `QUALI_SPEC §4.1` built it as a **display** number
for one session, and it is a good one; it is not a response. **The deviation from the
pre-registration is written, not silent** — here and in `QUALI_SPEC §5.1.1`.

**The sandbagging cost — measured, published, and carried to the reader.** This is the one
objection the Q1 response invites, and it is quantified rather than captioned away. On the **707
driver-sessions that set a time in both segment 1 and segment 3** — the same drivers, the same
sessions, nothing confounded:

| | top-6 drivers' mean `y` | everyone else in that Q3 field | **margin** |
|---|---|---|---|
| their **segment-1** lap | −0.551 pp | −0.272 pp | **−0.279 pp** |
| their **segment-3** lap | −0.215 pp | +0.275 pp | **−0.490 pp** |

The same drivers' advantage over the same rivals is **43 % smaller in Q1 than in Q3**. The
shipped skill is therefore **attenuated at the front of the grid by a factor this spec knows and
publishes**. It is a **published limitation of the skill, not a caption flourish**: a driver whose
car will walk into Q3 is measured on the lap he did not need, and this fit **cannot tell a cruise
apart from being slow**. It ships anyway because the alternatives either break the scale (V4 and
the rejected variant above) or cost 50 % of the precision (V5 below), and because an attenuated
measurement of the right quantity beats an unattenuated measurement of a different one. Caption
`C-SKILL-5` carries it to the reader in words, without a driver name and without a number the
next ingest can move.

**V5 chaining — the named legal alternative, rejected on price, not on principle.** The correct
repair exists and was built. V5 measures the track-evolution offset per session on the drivers
present in *both* consecutive segments (within-driver medians o₂ **−0.486 pp**, o₃ **−0.691 pp**;
an independent rebuild gives −0.472 / −0.238) and chains each driver's best lap back onto the Q1
reference. It is **selection-free and scale-clean** — it is the only construction fitted that
answers the sandbagging objection without breaking the scale, and it obeys §1.2's rule by chaining
onto a common reference instead of centring locally while dropping rows. Its price: σ_ε rises
**0.385 → 0.607 pp** and **every posterior SE widens by ~50 %** (Verstappen ±0.083 → ±0.124),
because the extra laps are the noisy ones. `corr(V5, V3) = 0.825`. **V5 stays in this spec as the
named legal alternative and is rejected on price, not on principle. A future release with more
sessions may be able to afford it, and should reach for this and not for V4.**

**Specification.** Exactly §1.3 **without the development slope** — `β_c · u_r` is dropped, as it
is for `grid_pace`:

    y_sd  =  δ_d  +  γ_{c(d,s)}  +  ε_sd

with δ_d ~ N(0, τ_δ²), γ_c ~ N(0, τ_γ²), ε_sd ~ N(0, σ_ε²), REML, started from
`MODE2_QUALI_REML_START = (0.16, 0.56, 0.38)`.

**One real difference from §1.3, and it is contractual.** Race pace feeds a stage-1 `s_rd` in as a
known heteroskedastic floor (§1.2). **A qualifying best lap is a single extremum, not an average,
so `s_sd = 0` for every row and σ_ε absorbs it.** The two skills' τ_driver are therefore **not
exactly like-for-like**, and any comparison of their spreads carries that caveat — part of any
τ_δ difference between them is modelling, not drivers. `C-SKILL-5` says so.

**MEASURED — the fit.** 1,135 rows / 56 sessions / 28 drivers, REML converged:

    τ_driver 0.1605   τ_car 0.5620   σ_ε 0.3846      τ_car/τ_driver = 3.50
    Verstappen SE ±0.083 · Doohan SE ±0.121
    island posterior SE ceiling 0.113 = τ_δ / √2 (see the note below)
    corr(one_lap_pace, race_pace)   = 0.7727
    corr(one_lap_pace, grid_pace)   = 0.8393 all 28   ·   0.8670 ex-island 24
    Spearman equivalents            = 0.8637 all 28   ·   0.8830 ex-island 24
    24 of 28 posterior intervals cross zero

**It does not buy precision, and no release note may say it does.** Median `evidence_share` is
**0.813** on `grid_pace` against **0.653** on `one_lap_pace`; median posterior SE as a share of
the fitted span is **8.9 %** against **12.8 %**. ***The refit buys validity, not precision.***
Any copy calling the new skill "more confident" than the surrogate is wrong. The islands falling
to 0.501/0.502 is the fit being **correctly less confident** about them — §2.4 confirmed, not
repealed.

**A note on the shrinkage ceiling, because two quantities are easily run together.** The island
drivers' **posterior SE** ceiling is **0.113 = τ_δ / √2**, not τ_δ = 0.1605. A two-driver island's
*contrast* is measured over all 56 sessions; only its common *level* is set by the prior, and the
per-driver posterior SD of that shared level is τ_δ/√2. Wherever this spec says an island driver
"sits at the shrinkage ceiling", the ceiling meant is **0.113**.

**Three run-time gates, all of which fail the run rather than warn.**

- **G1 — surrogate integrity, before any comparison is computed.** Refit `grid_pace` from
  `decomp.GRID_SQL` and assert **r = 1.000** against the **stored** `mode2_driver_skill` rows.
  Verified: the refit reproduces §3.2 at τ_δ 0.4562 / τ_γ 0.4963 / σ_ε 0.6388 on 1,265 rows and
  agrees with the stored rows at r = 1.000000, max|diff| = 0.0. Every correlation below is
  therefore against what actually ships, not against a re-derivation that may have drifted. This
  is a **gate, not a courtesy**, and it runs first.
- **G2 — identifiability.** `build_components` on qualifying rows alone returns **4 components,
  member-identical to §1.4** (K1 15, K2 9, K3 alonso + stroll, K4 norris + piastri). Fails the
  **run**, not the page.
- **G3 — retirement.** The build fails if **either** `corr_one_lap_grid` **or**
  `corr_one_lap_grid_ex_islands` reaches **0.95** (`MODE2_GRID_RETIRE_R`). Retiring `grid_pace`
  then becomes a human decision requiring a spec edit, which is the point of a pre-registration.

**The retirement decision — `grid_pace` survives.** `QUALI_SPEC §5.1.1` pre-registered
**r ≥ 0.95 retires `grid_pace`**. Measured **0.8393**, so **both skills ship** and nothing is
deleted. **The correlation is reported both ways, and that is new**: four of the 28 drivers have
levels set by shrinkage toward each fit's own prior rather than by data, so an all-28 correlation
is **14 % a comparison of two priors**. The decision does not flip — 0.839 and 0.867 are both far
below 0.95 — but a statistic that governs a retirement must not be part prior without saying so.
**Both numbers are stored on `mode2_fit_run`, both are printed in the run log, and both are
gated.** Note also that `corr(one_lap_pace, race_pace) = 0.7727` is *lower* than `grid_pace`'s
0.80: the surrogate was more like race pace than the measurement is. §5.1.1 gate 2 adds an
"overlapping things" sentence above 0.90; 0.7727 does not trigger it, but 60 % shared variance is
most of an axis and `C-SKILL-6` says so anyway.

**The two skills are kept because they answer different questions.** The unshared variance is a
*product*, not noise: driver by driver it contains the grid penalties, the pit-lane starts and the
sprint-weekend grids that `one_lap_pace` excludes — **stated in words, with no per-driver number
for it, ever** (§3.2, §1.7 condition 3).

**Sprint qualifying is excluded, and the exclusion is measured.** Fitted three ways on the
segment-1 response:

| fit | rows | sess | τ_driver | τ_car | σ_ε | Verstappen SE | Doohan SE |
|---|---|---|---|---|---|---|---|
| **Q only (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **0.083** | **0.121** |
| Q + SQ pooled | 1,480 | 73 | 0.1689 | 0.6127 | 0.4861 | 0.090 | 0.129 |
| SQ only | 345 | 17 | 0.0760 | 0.7742 | 0.7235 | — | — |

**Adding 345 sprint-qualifying rows makes every driver's estimate *less* precise.** σ_ε rises
0.385 → 0.486 pp and posterior SEs widen both absolutely (Verstappen ±0.083 → ±0.090) and
relatively (SE/τ_δ 0.517 → 0.533). SQ1 fitted alone has τ_car/τ_driver = **10.2** — a single-run,
green-track, limited-practice session that is almost pure car. `corr(Q-only, SQ-only) = 0.605`
and `corr(pooled, Q-only) = 0.967`, so pooling changes the ranking barely while costing precision.

**Decision: `one_lap_pace` is fitted on `kind = 'Q'` only (`MODE2_QUALI_KINDS`). Sprint
qualifying is neither pooled in nor given its own skill.** A skill whose τ_driver is 0.076 against
τ_car 0.774 would be a car rating with a driver's name on it, and **17 sessions is not a corpus**
— the same grounds on which §3.3 refuses tyre management. It ships instead as a **`measured =
false` row, key `sprint_one_lap`**, in the §3.6 panel, reusing the existing refusal machinery
rather than inventing a surface. `QUALI_SPEC §5.2` is amended to match: sprint qualifying stays
first-class **as a session surface** and is out of **this one fit**.

**The fit writes its own inclusion ledger.** Every candidate row — included or not — is written to
`mode2_quali_row_audit` with its `included` flag and its `exclude_reason`, so the §3.6 panel reads
its reason from the database rather than from a hard-coded string, and so "why is my driver not in
the qualifying skill" is answerable. Per fit, **1,567 rows**: 1,135 included,
347 `sprint_qualifying_excluded`, 79 `wet_compound`, 5 `no_segment_1_time`,
1 `session_below_min_drivers`. `y_pp` is **NULL on every excluded row** by design — storing a
response for a row that never entered the fit invites exactly the misreading the audit exists to
prevent — while `best_s` is preserved on all 1,567 so any value can be recomputed.

> **Two measured numbers in this section disagree with a number pinned elsewhere in the v1.8
> source material, and both readings are recorded rather than reconciled.** (1) The ex-island
> correlation is pinned at **0.8670** (Spearman 0.8830) and the implementation measures
> **0.8663** (Spearman 0.8835) over the same 24 non-island drivers, across four independent
> constructions. The all-28 figure (0.8393 / 0.8637) and `corr(one_lap_pace, race_pace)` (0.7727)
> both reproduce exactly, so the disagreement is isolated to the ex-island subset. **The
> retirement decision is unaffected** — both values are far below 0.95 and G3 passes either way —
> and the **stored and gated value is the measured 0.8663**. (2) Median `evidence_share` for
> `one_lap_pace` is pinned at **0.653** and measures **0.6216**; the `grid_pace` figure 0.813
> reproduces. The claim it supports — *the refit buys validity, not precision* — is unaffected and
> slightly strengthened, and the test asserts the **direction** (one_lap_pace's median
> `evidence_share` strictly below grid_pace's, its median SE/span strictly above) rather than
> either literal, so a future refit cannot quietly invert the conclusion.

### 3.3 Tyre management — **DOES NOT SHIP**. Measured and refused.

`degradation_fits` (2,797 rows) is the right input and the fit is a fair one: per-stint
tyre slopes, weighted by each stint's `deg_std_err`, with crossed random effects for
driver, car-cell and session×compound.

**MEASURED, four ways, and the driver term is zero every time:**

| Fit | rows | τ_driver | τ_car | σ |
|---|---|---|---|---|
| filtered (`laps ≥ 8`, `0 < deg_std_err < 0.15`), session×compound control | 2,622 | **0.00000** | 0.00477 | 0.0424 |
| same, without the session×compound control | 2,622 | **0.00000** | — | — |
| all rows, unfiltered | 2,797 | **0.00147** | — | 0.0456 |
| the specification used by the model-first proposal | 2,563 | 0.00129 | 0.00489 | 0.0378 |

Median per-stint standard error is 0.0175 s/lap; mean stint slope is 0.0424 s/lap against
a mean `deg_std_err` of 0.0327 — the average single-stint slope is barely one standard
error from zero before any pooling. Every driver's point estimate is smaller than its own
standard error, and `evidence_share` runs 0.007–0.080.

An independent moment test agrees: between-driver SD 0.00764 is **below** the
within-driver standard error of the mean 0.00788, so the implied signal variance is
negative; χ² = 18.9 on 27 df, p = 0.874 — entirely consistent with no driver differences
at all.

> **A claim of σ_driver ≈ 0.0059 s/lap (a 41 % driver share) appears in one of the
> proposals and does not reproduce.** It is 4–6× anything obtainable here and is most
> plausibly the result of not carrying `deg_std_err` into the residual, so per-stint
> measurement noise is absorbed as driver skill. Any implementation that produces a
> non-zero τ_driver on this table must be assumed to have made the same mistake until it
> can reproduce the table above.

**Decision: no tyre-management rating, no bar, no number, no percentile, no ranking.**
Shipping one would be the single most misleading thing in v1.3, because it is the skill
fans most want quantified and the one a hatched error bar would least protect them from:
"−0.0006 s/lap, 63rd percentile" reads as knowledge. The tyre section of /driver keeps
v1.1's existing per-stint degradation scatter, which is a *description of what happened*,
and gains no driver rating.

**The rejection has an expiry date.** `test_tyre_rejection_still_holds` (§7.6) refits
this model on the current data and asserts `max(evidence_share) < 0.20`. When enough new
data makes the skill fittable, the build fails and forces a decision, so that a measured
rejection does not silently become a permanent omission.

### 3.4 Wet weather — **DOES NOT SHIP**. Not thin: zero.

The wet-weather facts were re-verified directly against the live DB for this document,
because all three proposals stated them differently and two of them stated them wrongly.

**MEASURED — `sessions` ⋈ `weather_samples` ⋈ `laps` ⋈ `sim_driver_params`, race sessions:**

| Year·Round | frac_rain | representative laps on INTERMEDIATE/WET | simulable `sim_driver_params` rows |
|---|---|---|---|
| 2024 R9 | 0.274 | 550 | **0** |
| 2024 R12 | 0.347 | 3 | **0** |
| 2024 R21 | 0.582 | 767 | **0** |
| 2025 R1 | 0.326 | 505 | **0** |
| 2025 R12 | 0.181 | 298 | **0** |
| 2025 R13 | 0.457 | 0 | **0** |
| 2026 R12 | 0.168 | **0** | 20 |
| six further sessions, frac_rain ≤ 0.04 | — | 0 | 4–20 each |

Read the two right-hand columns together. **Five sessions contain real wet-tyre running —
2,123 representative laps between them — and v1.1 refuses to fit every one of them**
(`SimNotEstimable: rain race`), for the correct reason that changing conditions break the
fuel-corrected base-pace assumption outright. The only rain-flagged session that *does*
have usable pace estimates, 2026 R12, ran **entirely on slicks**: zero wet-compound laps.

> **In the currency this feature is denominated in — fuel-corrected race pace — the
> number of usable wet-weather observations is exactly zero.** Not few. Zero.

Two further facts, because the copy must be right about them: **26 of the 28 drivers have
wet running** in the lap table (norris 136, piastri 130, max_verstappen 130, russell 127,
hamilton 126 at the top; hadjar 1 at the bottom) — so any caption claiming that named
drivers "have no wet running" is false and must not be written.

**Decision: no wet-weather rating.** Not a wide interval, not a "low confidence" badge —
absence. A fan cannot misread a number that is not there. /driver carries a one-line note
saying we looked and why we stopped (`C-SKILL-4`), and the wet EmptyState shows nothing
else.

**v1.8 — the §3.3/§3.4 refusal pattern is unchanged, and it now has four members, not two.**
Nothing about how a refusal is expressed changes: a refused skill is a **real `measured = false`
row written for all 28 drivers**, carrying its own reason, rendered at the same visual weight as a
measured bar, never an absence and never a silently missing key. **No CHECK key is added that is
not written.** Two new siblings follow the pattern:

| key | refused because | specified in |
|---|---|---|
| `sprint_one_lap` | fitted on 17 sprint-qualifying sessions; τ_driver 0.076 against τ_car 0.774, driver differences inside their own error bars, and 17 sessions is not a corpus | §3.2b |
| `trail_braking` | the reading exists for one stored lap at one corner, but the same driver's number at the same corner repeats at r = 0.286 — ~70–80 % of the cross-driver spread at a corner does not repeat for the same driver. The binding constraint is **replication, not the channel**: `lap_telemetry` stores exactly one lap per driver per session | `TELEMETRY_SPEC` / `GAPFILL_SPEC §3` |

`sprint_one_lap`'s stored reason deliberately keeps `{nSqSessions}` as an **unfilled template
slot** rather than interpolating 17, because a fitted count as a literal in stored fan-facing copy
is forbidden; the panel substitutes it from `count(DISTINCT session_id)` on
`mode2_quali_row_audit WHERE kind = 'SQ'`. `trail_braking`'s reason carries no slot.

### 3.5 Rating over time — what the surface actually is

A per-season refit is not estimable (§1.5 item 2). The rating-over-time chart is
therefore **not** a sequence of per-season ratings. It is the single δ̂_d drawn as a
stepped line, where each season's point is a **leave-future-out cumulative refit**: a
full model fit on all data up to the end of that season (2024; 2024–25; 2024–26), each
with its own bootstrap band.

    cost: 3 refits × 3.15 s + 3 bootstraps  ≈ 13 min at MODE2_BOOTSTRAP_REPS = 400,
          reduced to MODE2_HISTORY_BOOTSTRAP_REPS = 120 → ≈ 4 min. Run-end only.

**The brief asked for the band to widen at team switches. It does the opposite, and the
spec corrects the brief deliberately.** A transfer is the only event that adds identifying
information, so the band **narrows** at a switch: Hamilton's 2025 point is much tighter
than his 2024 point precisely because the Mercedes→Ferrari move anchored him. For Norris,
Piastri, Alonso and Stroll the band stays **flat and wide** across all three seasons,
because no amount of additional racing in the same car narrows an unidentified level. The
chart's own shape teaches the lesson; `C-HISTORY-1` states it in words. Any DDL comment,
caption or chart label asserting that the band widens at a switch is wrong and must be
fixed rather than transcribed.

### 3.6 What replaces the radar: the "What we could not measure" panel

A fixed panel on /driver, **same visual weight as the skill bars**, not a footnote:

**v1.8: the panel is SEVEN rows — three measured and four refused.** Order: **Race pace ·
Qualifying pace · Starting-grid pace · Tyre management · Wet weather · Sprint qualifying · Trail
braking.** Race pace and Qualifying pace share one `pp` axis (§3.2, v1.8 note); Starting-grid pace
keeps its own; no radar, ever.

| Skill | Verdict | One-line reason (verbatim on the page) |
|---|---|---|
| Race pace | measured | Fitted from 930 fuel-corrected race pace estimates across 56 races. |
| Qualifying pace | measured | Fitted from {nRows} first-segment qualifying laps across {nSessions} sessions. |
| Starting-grid pace | measured | Fitted from starting position; includes grid penalties and pit-lane starts, which we cannot subtract. |
| Tyre management | not measurable | We fitted it. The differences between drivers came out smaller than their own error bars, so we are not showing a number. |
| Wet weather | not measurable | Every wet race in 2024–26 is one our pace model refuses to fit, so we have no wet pace estimates at all. |
| Sprint qualifying | not measured | We fitted it on {nSqSessions} sprint-qualifying sessions. The driver differences came out smaller than their own error bars, and seventeen sessions is not a corpus. |
| Trail braking | not measured | We can see where a driver came off the brakes on one lap. We cannot turn that into a rating: the same driver's number at the same corner changes as much between his own two laps of one weekend as it does between him and the rest of the grid. |

**The panel's own copy must not hard-code a count that the next refusal moves.** It renders
`count(*)` from `mode2_driver_skill`, never the literal "four refusals" or "seven rows". Every
number in a row's reason is a **template slot filled from the database**, never a fitted count
written into stored copy — which is why `{nSqSessions}` is stored unfilled and substituted at
render time.

This panel is the product, not the apology. A fan who reads it leaves knowing something
true about evidence that no competitor site tells them, instead of leaving with a row of
bars of which some are noise.

---

## 4. Car-adjusted career and counterfactuals

### 4.1 The bridge from pace to points

v1.2 already owns the points machinery — `title.fit_plackett_luce`,
`title.points_schedule`, `title.dnf_rates`, `title.simulate` (`MODE1_SPEC` §2.2–2.4).
**Mode 2 must not build a second simulator.** It supplies a different θ and recalibrates
one scalar per season for a use v1.2 never had.

**Step 1 — the pace→strength bridge.** Fit v1.2's PL on each season's finishing orders,
then regress the fitted θ on this model's predicted entry pace `δ_d + γ_{c,t}`:

| season | slope (θ per pp) | R² | n entries |
|---|---|---|---|
| 2024 | −1.061 | **0.845** | 24 |
| 2025 | −1.254 | **0.854** | 21 |
| 2026 (thru R14) | −0.672 | **0.935** | 23 |

**The bridge is real** — pace explains 85–94 % of finishing strength — and **the slope is
season-specific**, because the field's pace spread differs each year. `mode2_points_calib`
stores `(year, slope, intercept, r2, resid_sd)` per season and **no pooled constant is
ever used**. Residual SD is 0.31–0.35 θ units: roughly 15 % of finishing strength is
starts, racecraft, strategy and luck. **That residual is the honest size of "racecraft",
and the model assigns all of it to nobody.** It is carried forward as noise in §4.3, not
discarded.

**Step 2 — the points-scale recalibration, and the bug you only find by running it.**
v1.2 runs `title.simulate` at `TITLE_PL_TEMPERATURE = 1.0`, which is right for "who wins
the title", where only the ordering of probabilities matters. Mode 2 asks it for a
**points total**, and at T = 1.0 it is badly compressed. Replaying each completed season
with the real drivers in the real cars, against `driver_standings`:

| season | T | sd(sim)/sd(actual) | MAE vs actual points | corr |
|---|---|---|---|---|
| 2024 | 1.0 | 0.517 | 58.8 | 0.985 |
| 2024 | **0.35** | 0.997 | **15.6** | 0.991 |
| 2025 | 1.0 | 0.576 | 51.8 | 0.969 |
| 2025 | **0.40** | 1.009 | **25.1** | 0.970 |
| 2026 | 1.0 | 0.524 | 35.0 | 0.945 |
| 2026 | **0.30** | 0.949 | **12.5** | 0.974 |

At v1.2's temperature the simulator returns barely half the real points spread. Shipping
on it would have halved every car-adjusted contribution — and halved it in the direction
that flatters the story. `mode2_points_calib.temperature` is a **fitted, stored,
per-season** number, found by matching `sd(simulated) = sd(actual)` over the grid
`MODE2_TEMPERATURE_GRID`. **`config.TITLE_PL_TEMPERATURE` is not touched**: v1.2's title
odds, `preview.py` and every other consumer must not move because Mode 2 shipped, and
`test_title_odds_unchanged` (§7.6) snapshots them to prove it.

> **A per-driver multiplicative "ratio anchoring" fix for the same compression was
> considered and rejected.** It repairs the display while leaving the simulator
> miscalibrated for every other consumer, and it invites the caption to present a model
> output as a real points ledger. The temperature is refitted instead.

**Step 3 — the replay MAE is published as a floor on precision.** Even with the real
driver in the real car the machinery misses by 12.5–25.1 points a season.
`mode2_career_season.calibration_mae` is stored per season, every interval in §4.3 and
§4.4 is widened to `sqrt(interval² + calibration_mae²)` before it is shown, and
`C-CAREER-2` tells the fan the number. A counterfactual with a ±6 band would be a lie the
arithmetic itself refutes.

### 4.2 The three points quantities, and which of them is a fact

| Quantity | Definition | Status |
|---|---|---|
| `actual_points` | `driver_standings.points` at the season's final `after_round` | **a fact**. Never recomputed, never simulated, shown as a fact. Measured 2025: norris 423, max_verstappen 421, piastri 410, russell 319, leclerc 242, hamilton 156. |
| `replay_points` | calibrated replay of that season with the real field, `δ_d` at its fitted value | a model output, shown beside the fact so the fan sees the model's own error |
| `avg_driver_points` | same replay, with **this** driver's δ replaced by 0 and every other seat unchanged | a model output |

    contribution = replay_points − avg_driver_points

**Both sides of the subtraction come from the same simulator.** Differencing a fact from
a model output (`actual_points − avg_driver_points`) would fold the simulator's own
replay error into the driver's credit, and at T = 1.0 that error was 50+ points a season.
The page shows `actual_points` and `replay_points` side by side, with the residual named
(`C-CAREER-2`), instead of hiding the mismatch inside a rescaling.

### 4.3 Car-adjusted career — computation and uncertainty

Monte Carlo per scenario: `MODE2_POINTS_DRAWS = 4000`, Gumbel-max sampling of the PL
order (exact, vectorised), DNF applied per-driver at the beta-binomial rate v1.2 already
fits (measured overall 12.7 %; 2024 9.8 %, 2025 11.5 %, 2026 19.6 %), reusing
`f1lab/title.py`'s schedule and DNF code directly.

**Cost, measured.** `title._pl_scores` already accepts a `(draws × n)` θ matrix via
`np.atleast_2d` (`f1lab/title.py:348-355`), so a scenario evaluated over many parameter
draws costs the same as one at fixed θ: **0.269 s per season-scenario at 4,000 draws**
(1.34 s at 20,000). The run-end budget in §7.7 is built on that measured figure.

**Uncertainty propagation.** The reported interval is **not** the Monte-Carlo standard
error — that is the small part, and quoting it alone is the classic lie. Each of
`MODE2_UNCERTAINTY_DRAWS = 200` outer draws takes one bootstrap replicate of
(δ, γ, β, slope, temperature) from §2.3, runs the inner Monte Carlo, and the band is the
5th–95th percentile across outer draws, then widened by the §4.1 replay MAE. The stored
row carries `mc_stderr` and `param_stderr` separately so `C-CAREER-2` can say which
dominates — measured, the parameter term is larger by roughly an order of magnitude.

For a **floating** driver the outer draws must also resample the component offset from
its prior-dominated posterior (SD 0.176 pp, §2.4). That is ±0.22 θ units of pure
assumption on their strength, which is why their contribution band is roughly four times
wider than Sainz's, is drawn hatched, and is stored with `basis = 'by-analogy'`.

MEASURED, 2025, T = 0.40, both sides from the calibrated replay:

| driver | actual (fact) | replay | avg driver in the same car | avg-driver P10–P90 | **contribution** | basis |
|---|---|---|---|---|---|---|
| max_verstappen | 421 | 255 | 145 | 102 – 191 | **+110** | measured |
| leclerc | 242 | 211 | 197 | 148 – 247 | +14 | measured |
| norris | 423 | 330 | 323 | 273 – 374 | +7 | **by-analogy** |
| hamilton | 156 | 172 | 198 | 149 – 248 | −26 | measured |
| piastri | 410 | 286 | 312 | 260 – 363 | −26 | **by-analogy** |
| tsunoda | 33 | 94 | 145 | 101 – 192 | −51 | measured |

Note Verstappen's replay (255) against his actual (421). That 166-point gap is the
model's error and the page names it; it is **not** added to his contribution.

### 4.4 Counterfactuals — "driver X in constructor Y's car"

Construction: take season Y, replace the target seat's occupant with driver X (δ_X
substituted for the incumbent's δ), leave every other seat, every car γ and β, the
calendar and the DNF rates unchanged, and re-run §4.3's calibrated simulator.

**This is extrapolation and the spec says so explicitly (FD4).** Three distinct
assumptions are made, all false to some degree, and all three are named in the UI copy:

1. **Additivity.** δ and γ add, with no "this car suits his style" term. §1.7 measured
   what such a term would be worth: **τ_interaction = 0.099 pp** over 72 observed cells.
   The test is low-powered and is *not* presented as confirmation of additivity; it is
   used as a **scale**.
2. **Portability.** δ_X was measured in the cars X actually drove. Putting Verstappen's
   −0.733 into a 2024 Sauber assumes his advantage is a constant offset rather than
   something that shrinks in a slow car. The model has no way to check this. This is the
   largest real-world threat to the counterfactual's validity and it appears in
   `C-CF-1`.
3. **A fixed field.** Everyone else is held at observed values; nobody responds.

**Interval widening — measured, not hand-set, and not double-counted.**

    Var_extra = MODE2_CF_INTERACTION_PCT²          (= 0.10² pp², from §1.7)
    applied ONLY to pairings (driver, cell) never actually observed
    then the §4.1 replay-MAE floor is applied on the points scale

The (δ, γ) pair for each outer draw is taken **jointly** from the retained posterior
A⁻¹ — which already carries the strong negative within-team correlation and already
carries the component-offset variance. **Adding a further `prior_share · τ²` term for
cross-component pairings, as one proposal specified, double-counts that variance and
roughly doubles the band for a reason that cannot be defended.** It is forbidden;
`test_cf_widening_is_not_double_counted` (§7.6) checks the cross-component band against
the joint-draw band plus the interaction term alone.

**Basis and rendering.** A counterfactual whose driver or whose target car belongs to K3
or K4 (any of Norris/Piastri/Alonso/Stroll, any McLaren or Aston Martin season) is stored
with `basis = 'by-analogy'`; one that crosses components is additionally flagged
`cross_component = true`. For `by-analogy` rows **the point estimate is not rendered at
all** (§8.4): the card shows the distribution and a sentence, never "+43 points". A row
cannot physically exist in `mode2_counterfactual` without its `p10` and `p90` (§6.2).

---

## 5. The constructor surface

### 5.1 Route and page structure

    /constructor                      index: every constructor, latest season, car-rating bars
    /constructor/[slug]               one constructor across 2024–26   (slug = teams.team_id)
    /constructor/[slug]?season=YYYY   one season highlighted

`app/constructor/page.tsx` and `app/constructor/[slug]/page.tsx`, both async Server
Components with `export const dynamic = 'force-dynamic'`, matching `/driver/[code]`'s
existing shape exactly: lower-case-slug redirect, `resolveConstructor(slug, year)` →
`notFound()`, `<PageHeader>` with the team colour from `session_teams`, then `<Section>`
blocks each holding a chart and a `<Caption>`. **`web/components/Nav.tsx` gains exactly
two entries — "Constructors" and nothing else — and it is owned by WP7 alone (§9.1).**

Slots, in order:

1. `<ConstructorHeader>` — team name, colour, seasons covered, drivers per season.
2. **Car pace rating** — a `<StatTile>` row (the season's γ̂ in pp off field centre, its
   90 % band, its rank *within that season*), then a three-season bar chart with bands.
3. **In-season development** — the β̂ segment chart (§5.2).
4. **Retirements** — hazard per 1,000 racing laps with a Jeffreys interval (§5.3).
5. **Who drove it** — the constructor's drivers with their δ̂ and `anchor_class`, so the
   decomposition is legible from this side too.

### 5.2 Car pace rating and the in-season development curve

**Car rating** is γ̂_c from §1.3 — driver effects are removed *by construction*, not by a
second regression, so a mid-season driver change cannot masquerade as car performance.
MEASURED (Spec S, pp off the race centre, negative = faster; `start = γ−β/2`,
`end = γ+β/2`):

| car | γ̂ | sd | β̂ | sd | start | end |
|---|---|---|---|---|---|---|
| mercedes/2026 | −1.785 | 0.220 | +0.192 | 0.217 | −1.881 | −1.689 |
| ferrari/2026 | −1.437 | 0.209 | −0.119 | 0.228 | −1.378 | −1.496 |
| mclaren/2026 | −1.323 | 0.246 | +0.075 | 0.238 | −1.360 | −1.285 |
| mclaren/2025 | −1.078 | 0.238 | +0.200 | 0.191 | −1.178 | −0.978 |
| mclaren/2024 | −0.804 | 0.237 | −0.050 | 0.195 | −0.779 | −0.829 |
| ferrari/2024 | −0.734 | 0.195 | +0.060 | 0.198 | −0.764 | −0.704 |
| red_bull/2026 | −0.701 | 0.211 | −0.256 | 0.247 | −0.573 | −0.829 |
| mercedes/2024 | −0.619 | 0.201 | −0.199 | 0.196 | −0.520 | −0.718 |
| ferrari/2025 | −0.543 | 0.200 | **+0.567** | 0.207 | −0.827 | −0.259 |
| mercedes/2025 | −0.476 | 0.212 | +0.073 | 0.193 | −0.512 | −0.439 |
| red_bull/2024 | −0.326 | 0.204 | **+0.639** | 0.205 | −0.645 | −0.007 |
| red_bull/2025 | −0.213 | 0.199 | −0.038 | 0.194 | −0.195 | −0.232 |
| rb/2026 | −0.021 | 0.215 | −0.193 | 0.221 | +0.076 | −0.117 |
| alpine/2026 | +0.119 | 0.210 | +0.115 | 0.218 | +0.062 | +0.177 |
| aston_martin/2024 | +0.124 | 0.239 | +0.279 | 0.203 | −0.015 | +0.263 |
| rb/2025 | +0.135 | 0.207 | +0.034 | 0.193 | +0.118 | +0.152 |
| rb/2024 | +0.136 | 0.207 | −0.053 | 0.214 | +0.163 | +0.110 |
| williams/2025 | +0.169 | 0.200 | −0.081 | 0.200 | +0.209 | +0.128 |
| aston_martin/2025 | +0.186 | 0.239 | −0.169 | 0.200 | +0.271 | +0.101 |
| audi/2026 | +0.214 | 0.230 | −0.021 | 0.233 | +0.225 | +0.204 |
| haas/2025 | +0.234 | 0.208 | −0.019 | 0.191 | +0.244 | +0.225 |
| haas/2024 | +0.301 | 0.218 | −0.281 | 0.199 | +0.441 | +0.160 |
| sauber/2025 | +0.463 | 0.223 | −0.369 | 0.211 | +0.648 | +0.279 |
| williams/2024 | +0.468 | 0.199 | −0.210 | 0.227 | +0.573 | +0.363 |
| haas/2026 | +0.591 | 0.218 | +0.511 | 0.229 | +0.335 | +0.847 |
| alpine/2025 | +0.650 | 0.201 | +0.263 | 0.212 | +0.518 | +0.781 |
| alpine/2024 | +0.662 | 0.201 | −0.179 | 0.212 | +0.751 | +0.573 |
| sauber/2024 | +0.675 | 0.228 | +0.047 | 0.199 | +0.651 | +0.698 |
| williams/2026 | +0.989 | 0.210 | +0.484 | 0.227 | +0.747 | +1.231 |
| aston_martin/2026 | +1.681 | 0.253 | −0.604 | 0.267 | +1.983 | +1.379 |
| cadillac/2026 | +2.261 | 0.225 | +0.044 | 0.230 | +2.239 | +2.283 |

**Definition of the development curve.** The car's pace relative to its own season's
field as a function of season progress `u`, estimated by the β_c random slope of §1.3 —
fitted jointly with everything else, so driver effects are stripped out by construction.
It is rendered as a **two-point segment with a band** (start → end) on a shared axis with
that season's other cars, **never as a fitted curve through per-round points**, because a
curve invites reading wiggles that are not there. A linear slope is all that 24 rounds
and a 0.418 pp residual support; a quadratic was not fitted and this sentence is why.

**The multiplicity statement is mandatory and leads the caption.** Only **2 of 31
car-seasons** have |z| > 2 on β̂, and **31 tests at α = 0.05 produce about 1.6 by chance**.
The chart greys out every segment that is not distinguishable from flat at 90 %, the
caption leads with the count, and the spec forbids listing the survivors as "findings"
without that sentence beside them. A development chart where five-sixths of the segments
are flat grey is the correct chart.

**The one external validation available.** The largest fitted in-season decline on the
grid is Red Bull 2024, β̂ = +0.639 ± 0.205 — the model, knowing nothing but fuel-corrected
lap times, independently recovers the best-known development story of the period. Ferrari
2025 (+0.567) and Sauber 2025 (−0.369, the late-season upgrade) are the other two
recognisable ones. `test_red_bull_2024_declines` (§7.6) pins it.

**Cross-season caveat, repeated every time a γ is shown.** γ is field-relative *within*
each season (§1.2). Mercedes 2026 at −1.785 is further clear of its own field than
McLaren 2024 at −0.804; it is not "a second a lap quicker". `C-CAR-1`.

### 5.3 Retirements — not "reliability"

Not a DNF percentage: a **per-lap hazard**, so a car that breaks on lap 3 and one that
breaks on lap 50 are not scored alike, and short races do not distort it.

    h_c = retirements_c / racing_laps_c,  per 1,000 laps
    interval: Jeffreys Beta(k+½, n−k+½), 5–95 %, ×1000

**Denominator and numerator are both race-only** (`sessions.kind = 'R'`), and the
numerator is `results.status = 'Retired'` only — `Did not start` is excluded because a
DNS never ran the laps in the denominator. **MEASURED, race-only:** status vocabulary is
`Finished` 760 / `Lapped` 328 / `Retired` 157 / `Did not start` 13 / `Disqualified` 8
(sprints are a separate 315/12/20/2/1 and must not be pooled with them — one proposal's
table was sprint-contaminated and disagreed with its own numerator). Worst car-seasons:
**aston_martin/2026 14 retirements in 1,214 racing laps**, cadillac/2026 11 in 1,216,
williams/2024 11 in 2,305, williams/2025 8 in 2,551. Season hazard per 1,000 laps: 2024
1.771, 2025 2.081, 2026 3.699.

**The hazard is split into a car component and a driver component, not merely
captioned.** `results.status` has no mechanical-vs-accident vocabulary anywhere in the
schema, so a raw hazard displayed on a *constructor* page silently charges a driver's
crashes to the car. The estimator is a two-way random-effects logistic hazard on the
per-lap retirement indicator:

    logit h_rd = μ + η_c(car-cell) + η_d(driver),   η_c ~ N(0, τ_ηc²), η_d ~ N(0, τ_ηd²)

`mode2_car_hazard` stores the raw hazard **and** `hazard_car_only` (the car component with
the driver component set to its mean), both with intervals. The section is titled
**"Retirements"**, never "Reliability", and `C-HAZARD-1` states that the data record that
a car stopped, never why.

Two further limitations go on the page, not in a footnote:

- 2026 is a regulation-reset year and its hazard is more than double 2024's, so
  cross-season hazard comparison is about the era, not the team. **Rankings are
  within-season only.**
- `<EmptyState reason="partial: fewer than 200 racing laps">` for any car-season below
  `MODE2_MIN_HAZARD_LAPS = 200`.

---

## 6. Schema

### 6.1 Rules this section obeys

- **Drizzle owns DDL.** Every table below is declared in one new file,
  `web/db/schema/mode2.ts`, exported from `web/db/schema/index.ts`, and generates
  **migration 0003**. Python never issues DDL; `frames.assert_schema` only checks that
  the DB matches `TABLE_COLUMNS`.
- **Explicit snake_case names everywhere** — every column name, every index name, every
  constraint name is written out. Drizzle's generated names are not relied on.
- **`assumption_set_id` on every analytics table**, and a `fit_id` foreign key so a row
  can always be traced to the fit that produced it.
- **No grid-wide rank column exists anywhere in this schema.** A grid-wide rank across
  four disconnected components is the exact falsehood this feature exists to avoid, so it
  is made physically unrepresentable: only `rank_in_component` exists, and the query
  layer cannot synthesise the other one. This is a structural guard, not a caption, and
  it survives contributors who have not read this document.
- **A row cannot exist without its uncertainty** (FD2): every `_lo`/`_hi`/`p10`/`p90`
  column is `NOT NULL`, and `mode2_counterfactual` additionally carries a `CHECK`.
- None of these tables are per-session children: they are keyed by driver / team / year,
  so **none is added to `RACE_TABLE_ORDER`** and none carries `ON DELETE CASCADE` on a
  session. They are rebuilt wholesale at run-end (§6.6).

### 6.2 DDL

```sql
-- One row per fit. Everything else in this schema hangs off it.
CREATE TABLE mode2_fit_run (
  fit_id              serial PRIMARY KEY,
  assumption_set_id   integer NOT NULL REFERENCES assumption_sets(assumption_set_id),
  model_version       text    NOT NULL,   -- content hash of the raced sessions + constants
  spec                text    NOT NULL,   -- 'S' (ships) | 'C' (crossed, no slope) — §1.6
  n_rows              integer NOT NULL,   -- modelled rows (measured 930)
  n_rows_excluded     integer NOT NULL,
  n_drivers           integer NOT NULL,
  n_cells             integer NOT NULL,
  n_sessions          integer NOT NULL,
  n_components        integer NOT NULL,   -- measured 4
  tau_driver          double precision NOT NULL,
  tau_car             double precision NOT NULL,
  tau_slope           double precision NOT NULL,
  sigma_resid         double precision NOT NULL,
  tau_driver_lo       double precision NOT NULL,
  tau_driver_hi       double precision NOT NULL,
  tau_car_lo          double precision NOT NULL,
  tau_car_hi          double precision NOT NULL,
  sd_ratio            double precision NOT NULL,   -- tau_car / tau_driver. SD, never variance.
  sd_ratio_lo         double precision NOT NULL,
  sd_ratio_hi         double precision NOT NULL,
  tau_interaction     double precision NOT NULL,   -- §1.7, measured 0.099
  sigma_spec          double precision NOT NULL,
  ci_level            double precision NOT NULL,   -- 0.90
  bootstrap_reps      integer NOT NULL,
  converged           boolean NOT NULL,
  shrinkage_ok        boolean NOT NULL,
  interval_dir_ok     boolean NOT NULL,            -- §2.6 island-widest check
  fit_seconds         double precision NOT NULL,
  bootstrap_seconds   double precision NOT NULL,
  is_current          boolean NOT NULL,
  fitted_at           timestamptz NOT NULL,
  -- v1.8 (migration 0009): the retirement decision is auditable from the database in
  -- every later release, not only from a run log. Written by the fit; gated by G3 (§3.2b).
  corr_one_lap_grid            double precision,
  corr_one_lap_grid_ex_islands double precision,
  corr_one_lap_race            double precision
);
CREATE UNIQUE INDEX mode2_fit_run_current_idx
  ON mode2_fit_run (assumption_set_id) WHERE is_current;
CREATE UNIQUE INDEX mode2_fit_run_version_idx
  ON mode2_fit_run (assumption_set_id, model_version);

-- The identifiability components of §1.4. Content, not diagnostics.
CREATE TABLE mode2_component (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  component_id      text    NOT NULL,          -- 'K1' | 'K2' | 'K3' | 'K4'
  label             text    NOT NULL,          -- 'the main grid', 'McLaren', ...
  n_drivers         integer NOT NULL,
  n_cells           integer NOT NULL,
  is_floating       boolean NOT NULL,          -- n_drivers < MODE2_MIN_COMPONENT_DRIVERS
  driver_ids        text[]  NOT NULL,
  cell_ids          text[]  NOT NULL,
  PRIMARY KEY (fit_id, component_id)
);
```

```sql
-- The headline rating, one row per driver per fit. Career-wide; NOT per season.
CREATE TABLE mode2_driver_rating (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  rating_pp         double precision NOT NULL,   -- delta_d, pp of the race centre lap
  rating_lo         double precision NOT NULL,   -- 5th pct, bootstrap + sigma_spec
  rating_hi         double precision NOT NULL,   -- 95th pct
  sd_within         double precision NOT NULL,   -- measurement  (§2.2)
  sd_island         double precision NOT NULL,   -- assumption   (§2.2)
  sd_total          double precision NOT NULL,
  frac_floating     double precision NOT NULL,
  evidence_share    double precision NOT NULL,
  anchor_class      text    NOT NULL,            -- 'anchored'|'component-anchored'|'floating'
  basis             text    NOT NULL,            -- 'measured' | 'by-analogy'
  component_id      text    NOT NULL,
  rank_in_component integer NOT NULL,            -- the ONLY rank in this schema (§6.1)
  n_races           integer NOT NULL,
  n_cells           integer NOT NULL,
  n_races_excluded  integer NOT NULL,
  PRIMARY KEY (fit_id, driver_id),
  CONSTRAINT mode2_driver_rating_anchor_check
    CHECK (anchor_class IN ('anchored','component-anchored','floating')),
  CONSTRAINT mode2_driver_rating_basis_check CHECK (basis IN ('measured','by-analogy'))
);

-- Rating over time: one row per driver per season, each a LEAVE-FUTURE-OUT CUMULATIVE
-- refit on all data up to the end of that season (§3.5). This is NOT a per-season refit;
-- a per-season refit is not estimable (§1.5) and test_no_per_season_refit forbids it.
-- The band NARROWS at a team switch, because a transfer is the only event that adds
-- identifying information. Any comment or label claiming it widens is wrong.
CREATE TABLE mode2_driver_rating_history (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  through_year      integer NOT NULL,
  rating_pp         double precision NOT NULL,
  rating_lo         double precision NOT NULL,
  rating_hi         double precision NOT NULL,
  sd_total          double precision NOT NULL,
  anchor_class      text    NOT NULL,
  n_races_cumulative integer NOT NULL,
  switched_this_year boolean NOT NULL,
  PRIMARY KEY (fit_id, driver_id, through_year)
);

-- One row per driver per skill, INCLUDING the skills we refused, with a null value
-- and a stored reason. The refusals are product (§3.6), so they are rows, not absences.
CREATE TABLE mode2_driver_skill (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  skill             text    NOT NULL,   -- v1.8: seven keys, see the CHECK below
  measured          boolean NOT NULL,
  value             double precision,            -- NULL iff measured = false
  value_lo          double precision,
  value_hi          double precision,
  unit              text    NOT NULL,   -- 'pp' | 'normal_score' | 'none'
  evidence_share    double precision,
  anchor_class      text    NOT NULL,   -- graph-derived, IDENTICAL across skills (§2.4)
  pct_field_below   double precision,
  not_measured_reason text,             -- NOT NULL iff measured = false
  n_obs             integer NOT NULL,
  PRIMARY KEY (fit_id, driver_id, skill),
  CONSTRAINT mode2_driver_skill_measured_check CHECK (
    (measured AND value IS NOT NULL AND value_lo IS NOT NULL AND value_hi IS NOT NULL
      AND not_measured_reason IS NULL)
 OR (NOT measured AND value IS NULL AND not_measured_reason IS NOT NULL)),
  CONSTRAINT mode2_driver_skill_skill_check
    -- v1.8 (migration 0009): the CHECK gains three keys. No key is added that is not
    -- written: 'one_lap_pace' (§3.2b, measured), 'sprint_one_lap' and 'trail_braking'
    -- (§3.4 note, measured = false rows for all 28 drivers).
    CHECK (skill IN ('race_pace','one_lap_pace','grid_pace','tyre_management','wet',
                     'sprint_one_lap','trail_braking'))
);
```

```sql
-- v1.8 (migration 0009), §3.2b. The inclusion ledger of the qualifying fit: every
-- candidate driver-session, included or not, with the reason. The §3.6 panel reads its
-- refusal reason from here rather than from a hard-coded string, and "why is my driver
-- not in the qualifying skill" is answerable from the database. 1,567 rows per fit.
-- Column order is contractual and equals decomp.QUALI_AUDIT_COLUMNS and
-- frames.EXPECTED_COLUMNS['mode2_quali_row_audit'] (§6.3); the writer raises
-- SimNotEstimable if the three ever disagree.
CREATE TABLE mode2_quali_row_audit (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  session_id        integer NOT NULL REFERENCES sessions(session_id),
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text,
  year              integer NOT NULL,
  round             integer NOT NULL,
  kind              text    NOT NULL,          -- 'Q' | 'SQ'
  included          boolean NOT NULL,
  exclude_reason    text,                      -- NULL iff included
  y_pp              double precision,          -- NULL on every excluded row, by design
  best_s            double precision,          -- preserved on all 1,567 rows
  PRIMARY KEY (fit_id, session_id, driver_id),
  CONSTRAINT mode2_quali_row_audit_reason_check CHECK (
    (included AND exclude_reason IS NULL)
 OR (NOT included AND exclude_reason IS NOT NULL AND y_pp IS NULL))
);
```

```sql
-- Contrasts as first-class objects (§2.5). Exists so the web NEVER differences two
-- marginal intervals: the effects are strongly negatively correlated and the naive
-- combination is roughly twice too wide.
CREATE TABLE mode2_driver_contrast (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  driver_a          text    NOT NULL REFERENCES drivers(driver_id),
  driver_b          text    NOT NULL REFERENCES drivers(driver_id),
  kind              text    NOT NULL,   -- 'teammate' (shared a cell) | 'cross'
  delta_pp          double precision NOT NULL,   -- a − b, negative = a faster
  delta_se          double precision NOT NULL,   -- sqrt(cᵀ A⁻¹ c) ⊕ sigma_spec_contrast
  delta_lo          double precision NOT NULL,
  delta_hi          double precision NOT NULL,
  same_component    boolean NOT NULL,   -- gates every gap annotation the UI may draw
  shared_cells      text[]  NOT NULL,
  n_shared_races    integer NOT NULL,
  n_races_a         integer NOT NULL,
  n_races_b         integer NOT NULL,
  PRIMARY KEY (fit_id, driver_a, driver_b),
  CONSTRAINT mode2_driver_contrast_kind_check CHECK (kind IN ('teammate','cross'))
);

-- Car rating + in-season development, per team-season (§5.2).
CREATE TABLE mode2_car_rating (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  team_id           text    NOT NULL REFERENCES teams(team_id),
  year              integer NOT NULL,
  gamma_pp          double precision NOT NULL,
  gamma_lo          double precision NOT NULL,
  gamma_hi          double precision NOT NULL,
  slope_pp          double precision NOT NULL,   -- beta_c, pp across the whole season
  slope_lo          double precision NOT NULL,
  slope_hi          double precision NOT NULL,
  start_pp          double precision NOT NULL,   -- gamma − beta/2
  end_pp            double precision NOT NULL,   -- gamma + beta/2
  slope_significant boolean NOT NULL,            -- |z| > 1.645; measured 2 of 31 at |z|>2
  rank_in_season    integer NOT NULL,            -- within-season only (§5.2)
  component_id      text    NOT NULL,
  basis             text    NOT NULL,            -- 'measured' | 'by-analogy'
  n_races           integer NOT NULL,
  PRIMARY KEY (fit_id, team_id, year)
);

-- Retirement hazard, split into car and driver components (§5.3). Never "reliability".
CREATE TABLE mode2_car_hazard (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  team_id           text    NOT NULL REFERENCES teams(team_id),
  year              integer NOT NULL,
  retirements       integer NOT NULL,   -- results.status='Retired', race sessions only
  racing_laps       integer NOT NULL,   -- sum(laps_completed), race sessions only
  hazard_per_1000   double precision NOT NULL,
  hazard_lo         double precision NOT NULL,   -- Jeffreys 5th
  hazard_hi         double precision NOT NULL,   -- Jeffreys 95th
  hazard_car_only   double precision NOT NULL,   -- driver component held at its mean
  hazard_car_lo     double precision NOT NULL,
  hazard_car_hi     double precision NOT NULL,
  rank_in_season    integer NOT NULL,
  sufficient        boolean NOT NULL,            -- racing_laps >= MODE2_MIN_HAZARD_LAPS
  PRIMARY KEY (fit_id, team_id, year)
);

-- The pace→points bridge and the Mode-2-only temperature (§4.1). One row per season.
-- TITLE_PL_TEMPERATURE is NOT touched; this table exists so it never has to be.
CREATE TABLE mode2_points_calib (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  year              integer NOT NULL,
  slope_theta_per_pp double precision NOT NULL,
  intercept         double precision NOT NULL,
  r2                double precision NOT NULL,
  resid_sd          double precision NOT NULL,
  temperature       double precision NOT NULL,   -- fitted; measured 0.35 / 0.40 / 0.30
  sd_ratio_sim_actual double precision NOT NULL, -- target 1.0; measured 0.997/1.009/0.949
  replay_mae_points double precision NOT NULL,   -- measured 15.6 / 25.1 / 12.5
  replay_corr       double precision NOT NULL,
  n_entries         integer NOT NULL,
  PRIMARY KEY (fit_id, year)
);
```

```sql
-- Car-adjusted career, one row per driver-season (§4.3).
CREATE TABLE mode2_career_season (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  year              integer NOT NULL,
  team_id           text    NOT NULL REFERENCES teams(team_id),
  actual_points     double precision NOT NULL,   -- driver_standings; A FACT
  replay_points     double precision NOT NULL,   -- calibrated replay, real driver
  replay_lo         double precision NOT NULL,
  replay_hi         double precision NOT NULL,
  avg_driver_points double precision NOT NULL,   -- same car, delta = 0
  avg_driver_p10    double precision NOT NULL,
  avg_driver_p90    double precision NOT NULL,
  contribution      double precision NOT NULL,   -- replay_points − avg_driver_points
  contribution_lo   double precision NOT NULL,
  contribution_hi   double precision NOT NULL,
  mc_stderr         double precision NOT NULL,
  param_stderr      double precision NOT NULL,
  calibration_mae   double precision NOT NULL,   -- the floor applied to the band (§4.1)
  basis             text    NOT NULL,            -- 'measured' | 'by-analogy'
  anchor_class      text    NOT NULL,
  rounds_in_season  integer NOT NULL,
  PRIMARY KEY (fit_id, driver_id, year),
  CONSTRAINT mode2_career_season_basis_check CHECK (basis IN ('measured','by-analogy'))
);

-- Counterfactuals (§4.4). A row CANNOT EXIST without its interval — this CHECK is the
-- structural form of FD2 and is the reason no code path can emit a bare point estimate.
CREATE TABLE mode2_counterfactual (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  year              integer NOT NULL,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text    NOT NULL REFERENCES teams(team_id),
  replaced_driver_id text   NOT NULL REFERENCES drivers(driver_id),
  observed          boolean NOT NULL,            -- true = this pairing actually raced
  points_p10        double precision NOT NULL,
  points_p50        double precision NOT NULL,
  points_p90        double precision NOT NULL,
  incumbent_actual  double precision NOT NULL,
  delta_p10         double precision NOT NULL,
  delta_p50         double precision NOT NULL,
  delta_p90         double precision NOT NULL,
  basis             text    NOT NULL,            -- 'measured' | 'by-analogy'
  cross_component   boolean NOT NULL,
  interaction_pp    double precision NOT NULL,   -- the widening actually applied
  calibration_mae   double precision NOT NULL,
  PRIMARY KEY (fit_id, year, team_id, driver_id),
  CONSTRAINT mode2_counterfactual_interval_check
    CHECK (points_p10 IS NOT NULL AND points_p90 IS NOT NULL AND points_p10 <= points_p90),
  CONSTRAINT mode2_counterfactual_basis_check CHECK (basis IN ('measured','by-analogy'))
);

-- Why a pace estimate was or was not used (§1.3). Lets /driver say "3 of Sainz's 24
-- rounds were not usable" instead of silently dropping them.
CREATE TABLE mode2_row_audit (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  session_id        integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text    NOT NULL,
  year              integer NOT NULL,
  round             integer NOT NULL,
  included          boolean NOT NULL,
  exclude_reason    text,                        -- NOT NULL iff included = false
  y_pp              double precision,
  se_pp             double precision,
  laps_fit          integer NOT NULL,
  badge             text    NOT NULL,
  PRIMARY KEY (fit_id, session_id, driver_id),
  CONSTRAINT mode2_row_audit_reason_check
    CHECK (included OR exclude_reason IS NOT NULL)
);
CREATE INDEX mode2_row_audit_driver_idx ON mode2_row_audit (fit_id, driver_id, year, round);
```

### 6.3 `frames.TABLE_COLUMNS` / `EXPECTED_COLUMNS` additions

Twelve entries are added to `frames.TABLE_COLUMNS`, in the DDL order above.
`EXPECTED_COLUMNS` is derived from it by the existing comprehension at
`f1lab/frames.py` — **no separate edit to `EXPECTED_COLUMNS` is needed or permitted.**

The **only** legal column kinds are the ones `cast_frame` handles:
`int | serial | float | real | bool | text | timestamptz | date | jsonb | text[] |
float[] | int[]`. Mode 2 uses `serial` (`fit_id`), `int`, `float`, `bool`, `text`,
`text[]` (`driver_ids`, `cell_ids`, `shared_cells`) and `timestamptz` (`fitted_at`).
`jsonb` is not used. **A `text[]` column is tagged `text[]`, not `jsonb`** — mis-tagging
it makes `cast_frame` pass a list through as an object and the COPY fails at run-end,
not at schema-check time.

Nothing is added to `RACE_TABLE_ORDER`, `SPRINT_TABLE_ORDER` or `ANALYTICS` (§6.1, §6.5).

**v1.8 additions (migration 0009).** A **thirteenth** entry,
`TABLE_COLUMNS["mode2_quali_row_audit"]`, in the twelve-column DDL order above — it is a
cross-race artifact written by the fit in the same transaction as the skill rows, exactly like the
other twelve mode2 tables, so like them it is **not** added to `RACE_TABLE_ORDER`,
`SPRINT_TABLE_ORDER` or `ANALYTICS`. `TABLE_COLUMNS["mode2_fit_run"]` gains the three `corr_*`
floats at the end, matching the physical column order. Separately, and not part of Mode 2,
`lap_corner_speeds` gains its v1.8 brake-shape columns and `lap_telemetry` gains `derive_version`;
`frames` must list **every** live column of a table or `db.schema_problems()` reports the
unlisted ones as unexpected and `--check-schema` exits non-zero. Restricting what the ask box can
reach is done in the **view layer**, never by omitting a column from `frames`.

### 6.4 Drizzle transcription notes — the three traps

`web/db/schema/mode2.ts` is transcribed from §6.2 by hand. Read the generated
`drizzle/0003_*.sql` before applying it and check these three things, each of which has
bitten this project before (`MODE1_SPEC` §5.7):

1. **The partial unique index is easy to drop.** `mode2_fit_run_current_idx` is
   `UNIQUE … WHERE is_current`. In Drizzle that is
   `uniqueIndex('mode2_fit_run_current_idx').on(t.assumptionSetId).where(sql`${t.isCurrent}`)`.
   If the `.where` is lost the index becomes a plain unique on `assumption_set_id`, the
   second fit fails to insert, and **if instead the whole index is lost, two `is_current`
   rows coexist and every query in §8 silently returns each row twice.**
2. **`double precision`, never `numeric`.** `real('x')` in Drizzle maps to `real`; use
   `doublePrecision('x')`. A `numeric` column comes back from psycopg 3 as `Decimal`,
   which `cast_frame`'s `_to_float` does not expect and which breaks arithmetic in the
   query layer. Likewise `text[]` is `text('x').array()`, never `jsonb`.
3. **Generated constraint names.** Every `CHECK` in §6.2 is named. Drizzle will invent a
   name if one is not given, and the invented name differs between generations, so a
   later `drizzle-kit generate` produces a spurious drop/add pair. Name them exactly as
   written.

### 6.5 `analytics_status` keys — four, not one

Per FD7, one key per guarded analytic, so a failed Monte Carlo degrades one section's
`<EmptyState reason>` instead of blanking the driver rating:

| Key | Guards | Written by |
|---|---|---|
| `mode2_rating` | driver rating, rating history, contrasts, components | `decomp.recompute_rating` |
| `mode2_skills` | the skill panel (including the refused skills) | `decomp.recompute_skills` |
| `mode2_constructor` | car rating, development, hazard | `decomp.recompute_constructor` |
| `mode2_counterfactual` | career seasons, counterfactuals, points calibration | `decomp_points.recompute_points` |

Each step writes its own `analytics_status` row in the v1.2 companion pattern; a step
that raises records `SimNotEstimable: …` and the run continues.

**v1.8: the status keys are unchanged — still four, and no fifth is added.** `one_lap_pace`,
`sprint_one_lap` and `trail_braking` are all written by `decomp.recompute_skills`, in the same
transaction as the other four skills and as `mode2_quali_row_audit`, so they are guarded by
`mode2_skills` and nothing new needs guarding. A qualifying fit that fails raises
`SimNotEstimable` and degrades the skill panel exactly as a failed tyre or wet fit already does.

### 6.6 Model-artifact lifecycle and `--force` idempotency

There is **no pickled artifact**. The fit costs 3.15 s and the bootstrap ~4 min; storing
a binary blob would buy a stale-artifact failure class for nothing. What is stored is the
fit's **identity**:

    model_version = sha256( sorted (year, round) of every RACED session that passed the
                            §1.3 filter  ||  the Mode 2 constants of §7.3  ||  spec )[:16]

Keyed on *raced* sessions, so 2026's nine scheduled-but-unraced rounds do not perturb it.

**Recompute procedure** (`decomp.recompute_all`, §7.2):

1. Compute `model_version`. If a `mode2_fit_run` row exists with that
   `(assumption_set_id, model_version)` **and** `stored_is_complete(conn, fit_id)` returns
   true — every dependent table has rows — return early with `{"skipped": True}` unless
   `force=True`.
2. Otherwise fit, bootstrap, and write every table inside **one transaction**, then flip
   `is_current`: the new row's `is_current = true`, all others for that
   `assumption_set_id` set false, in the same transaction as the writes.
3. Old fits are pruned to the most recent `MODE2_KEEP_FITS = 3` (a constant in the §7.3
   block, therefore inside the assumption hash).

**Bit-identical `--force` is a contract, and four named mechanisms deliver it**
(`test_mode2_refit_is_bit_identical`, §7.6, asserts equality of a digest over every
numeric column):

- Every source query carries an explicit `ORDER BY` — Postgres physical order changes
  after a `--force` re-ingest, and row order changes floating-point summation.
- Random-effect level order is `sorted()`, never the order of first appearance.
- The REML optimiser starts from a constant, `MODE2_REML_START`, never from data.
- Every bootstrap replicate draws from `np.random.default_rng(MODE2_SEED + rep_index)`,
  so `joblib`'s scheduling cannot perturb results.

### 6.7 Migration 0003

    cd web && npx drizzle-kit generate --name mode2
    # read drizzle/0003_*.sql against §6.4 before applying
    npx drizzle-kit migrate
    cd .. && .venv/bin/python -m f1lab.ingest --check-schema   # must exit 0

Migration 0003 is **additive only**: twelve `CREATE TABLE`s and their indexes. It alters
no existing table and drops nothing. If `drizzle-kit generate` proposes any statement
touching a table not prefixed `mode2_`, stop and report it rather than applying.

---

## 7. Python

### 7.1 Module layout

Two new modules; nothing else in `f1lab/` changes except the four integration edits of
§7.4.

    f1lab/decomp.py          ~520 lines   the pace model, components, skills, constructor
    f1lab/decomp_points.py   ~340 lines   the points bridge, career seasons, counterfactuals

`decomp_points` imports `decomp` and `title`; `decomp` imports nothing from
`decomp_points`. Neither imports `web/`.

### 7.2 Signatures

```python
# f1lab/decomp.py  ------------------------------------------------------------------
@dataclass(frozen=True)
class Mode2Fit:
    spec: str                      # 'S' | 'C'
    rows: pd.DataFrame             # the modelled design, one row per (session, driver)
    driver_ids: list[str]          # sorted; the level order of delta
    cell_ids: list[str]            # sorted; "team_id|year"
    tau: dict[str, float]          # tau_driver, tau_car, tau_slope, sigma_resid
    blup: np.ndarray               # [delta | gamma | beta], in level order
    cov: np.ndarray                # A^-1 block for the random effects (§2.1)
    components: dict[str, dict]    # component_id -> {drivers, cells, is_floating}
    converged: bool
    fit_seconds: float

def load_rows(conn, assumption_set_id: int) -> pd.DataFrame: ...
    """sim_driver_params ⋈ sessions ⋈ session_entries, race sessions, ORDER BY
    (year, round, driver_id). Returns every simulable row with `included` and
    `exclude_reason` already set by the §1.3 filter."""

def build_components(rows: pd.DataFrame) -> dict[str, dict]: ...
    """The §1.4 bipartite graph. scipy.sparse.csgraph.connected_components.
    Component ids are assigned K1..Kn in descending driver count, ties broken by the
    alphabetically first driver — so ids are stable across runs."""

def fit_reml(rows: pd.DataFrame, *, spec: str = "S",
             start: tuple[float, ...] = config.MODE2_REML_START) -> Mode2Fit: ...

def bootstrap(fit: Mode2Fit, *, reps: int, n_jobs: int, seed: int) -> np.ndarray: ...
    """(reps × n_effects) parametric bootstrap draws (§2.3). Non-parametric / cluster
    resampling is forbidden here — see test_island_intervals_are_widest."""

def contrasts(fit: Mode2Fit, draws: np.ndarray) -> pd.DataFrame: ...
    """Every team-mate pair that shared a cell, plus every cross-component pair the
    /was-it-the-car page can show. se = sqrt(cᵀ A⁻¹ c) ⊕ MODE2_SIGMA_SPEC_CONTRAST."""

def fit_grid_pace(conn, assumption_set_id: int, components: dict) -> pd.DataFrame: ...

# v1.8, §3.2b. Named entry point; a thin wrapper over one_lap_pace_report(), which also
# returns the audit frame, the three corr_* values and the §3.2b diagnostics the gates need.
def fit_one_lap_pace(conn, assumption_set_id: int, components: dict) -> pd.DataFrame: ...
def one_lap_pace_report(conn, assumption_set_id: int, components: dict) -> dict: ...
def assert_grid_pace_reproduces(...) -> None: ...   # gate G1, runs before any correlation
def assert_quali_islands_hold(...)   -> None: ...   # gate G2
def skill_correlations(...)          -> dict: ...   # gate G3 + the corr_* write

def tyre_rejection_report(conn, assumption_set_id: int) -> dict: ...
def wet_rejection_report(conn, assumption_set_id: int) -> dict: ...
def fit_hazard(conn, assumption_set_id: int) -> pd.DataFrame: ...

def recompute_rating(conn, assumption_set_id: int, *, force: bool = False) -> dict: ...
def recompute_skills(conn, assumption_set_id: int, fit: Mode2Fit) -> dict: ...
def recompute_constructor(conn, assumption_set_id: int, fit: Mode2Fit) -> dict: ...
def recompute_all(conn, assumption_set_id: int, *, force: bool = False) -> dict: ...

# f1lab/decomp_points.py  -----------------------------------------------------------
def calibrate(conn, assumption_set_id: int, fit: Mode2Fit) -> pd.DataFrame: ...
    """Per season: PL slope/intercept/r2/resid_sd, then the temperature that matches
    sd(simulated season points) to sd(actual), plus the replay MAE (§4.1)."""

def replay(fit: Mode2Fit, calib: pd.DataFrame, year: int, *,
           theta_override: dict[str, float] | None = None,
           draws: int = config.MODE2_POINTS_DRAWS,
           rng: np.random.Generator) -> np.ndarray: ...
    """(draws × n_entries) points. Uses title._pl_scores' (draws × n) theta path so a
    parameter-draw sweep costs the same as a fixed-theta run (measured 0.269 s)."""

def recompute_points(conn, assumption_set_id: int, fit: Mode2Fit,
                     draws: np.ndarray) -> dict: ...
```

### 7.3 New `config.py` constants — all enter the assumption hash

```python
MODE2_MIN_LAPS_FIT            = 24        # §1.3 inclusion filter
MODE2_MIN_CARS_IN_RACE        = 8
MODE2_EXCLUDE_BADGES          = ("poor",)
MODE2_SPEC                    = "S"       # the shipping specification (§1.6)
MODE2_REML_START              = (0.30, 0.90, 0.35, 0.42)
MODE2_CI_LEVEL                = 0.90
MODE2_BOOTSTRAP_REPS          = 400
MODE2_HISTORY_BOOTSTRAP_REPS  = 120
MODE2_BOOTSTRAP_JOBS          = 8
MODE2_SEED                    = 20260914
MODE2_SIGMA_SPEC              = 0.10      # pp, on LEVELS       (§1.8, §2.3)
MODE2_SIGMA_SPEC_CONTRAST     = 0.04      # pp, on CONTRASTS    (§1.8, §2.3)
MODE2_CF_INTERACTION_PCT      = 0.10      # pp, MEASURED (§1.7), counterfactuals only
MODE2_MIN_COMPONENT_DRIVERS   = 5         # below this a component is 'floating'
MODE2_MIN_HAZARD_LAPS         = 200
MODE2_POINTS_DRAWS            = 4000
MODE2_UNCERTAINTY_DRAWS       = 200
MODE2_TEMPERATURE_GRID        = (0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.70, 1.00)
MODE2_CF_MAX_SCENARIOS        = 900       # §7.7 budget guard
MODE2_KEEP_FITS               = 3
MODE2_TYRE_REJECT_THRESHOLD   = 0.20      # evidence_share above this ⇒ build fails (§3.3)

# v1.8 — six new constants for the qualifying fit (§3.2b). All enter the assumption hash
# via assumptions.snapshot(), so the release necessarily computes a NEW assumption_set_id
# and a NEW fit_id. That is §6.6's intended, audited path, not drift: the per-fit row
# counts are unchanged and the value-equality check runs ACROSS the two fit ids.
MODE2_QUALI_SEGMENT           = 1         # Q1 only (§3.2b, Finding 1)
MODE2_QUALI_MIN_DRIVERS       = 8         # minimum segment-1 field for a session to enter
MODE2_QUALI_KINDS             = ("Q",)    # sprint qualifying excluded (§3.2b)
MODE2_QUALI_REML_START        = (0.16, 0.56, 0.38)
MODE2_QUALI_THIN_N            = 25        # n_obs below this ⇒ thin-data flag, rendered
MODE2_GRID_RETIRE_R           = 0.95      # gate G3; pre-registered in QUALI_SPEC §5.1.1
```

`config.TITLE_PL_TEMPERATURE` is **not** touched (§4.1).

### 7.4 Integration — four small edits, one owner each

1. **`f1lab/companion.py`** — `STEPS` becomes
   `("winprob", "odi", "preview", "mode2")`, the dispatch in `recompute_companion` gains
   a `mode2` branch calling `decomp.recompute_all(conn, assumption_set_id, force=force)`,
   and `assert_inputs` gains two checks: `sim_driver_params` non-empty
   (`CompanionInputsMissing: run the per-session sim step before mode2`) and
   `driver_standings` non-empty (already present). Mode 2 runs **last**, after
   `preview`, because it reads `driver_standings` and `title`'s fitted PL.
2. **`f1lab/ingest.py`** — **no new flag.** The existing
   `--recompute-companion [STEPS]` already does this; only its help string changes to
   `from {winprob,odi,preview,mode2,all}`. Inventing `--recompute-decomp` or
   `--companion-steps` would be a second flag for one mechanism and is forbidden.
3. **`f1lab/frames.py`** — the twelve `TABLE_COLUMNS` entries of §6.3, and nothing else.
4. **`f1lab/ingest.py`, one line** — the existing `--force` flag is passed through as
   `companion.recompute_companion(conn, asid, steps=…, force=a.force)`; only the `mode2`
   step reads it, the other three ignore it exactly as today (§7.8).

### 7.5 Where each thing runs

| Stage | What runs | Cost |
|---|---|---|
| per session | nothing | — |
| per season (`season.recompute`) | nothing | — |
| **run end** (`companion.recompute_companion`, step `mode2`) | the whole feature | see §7.7 |

Mode 2 is entirely cross-race: what a driver's rating is depends on which *other* races
exist, so a per-session hook would be wrong as well as slow.

### 7.6 Tests — `tests/test_mode2.py`

The suite lives at the repo-root `tests/` package alongside `tests/conftest.py` and
`tests/test_companion_schema.py`. There is no `f1lab/tests/` directory and none is
created.

| Test | Asserts |
|---|---|
| `test_mode2_schema` | `frames.assert_schema` passes for all twelve tables; every `_lo`/`_hi` is `NOT NULL` in the live DB |
| `test_components_are_four` | `build_components` returns exactly 4 components with driver counts `{15, 9, 2, 2}` and McLaren/Aston as the two singletons-of-two |
| **`test_island_intervals_are_widest`** | the four `floating` drivers hold the four largest `sd_total`. This is the bootstrap-trap gate (§2.3): a race-cluster bootstrap fails it, a parametric one passes |
| `test_shrinkage` | `sd(deltâ) < sd(raw per-driver mean team-mate gap)` — pooling must shrink |
| `test_contrast_is_not_a_difference_of_marginals` | stored `delta_se` for norris−piastri is **strictly smaller** than `sqrt(sd_a² + sd_b²)`, proving the correlation was used |
| `test_no_grid_wide_rank` | no column named `rank`, `rank_overall`, `grid_rank` or `rank_in_grid` exists in any `mode2_*` table |
| `test_no_per_season_refit` | `mode2_driver_rating_history.through_year` rows are cumulative: `n_races_cumulative` is non-decreasing in `through_year` for every driver |
| `test_band_narrows_at_switch` | for every driver with a team change, `sd_total` at the switch season ≤ the previous season's |
| **`test_tyre_rejection_still_holds`** | refits §3.3 on current data; `max(evidence_share) < MODE2_TYRE_REJECT_THRESHOLD`. Fails the build when new data makes the skill fittable (a rejection with an expiry date) |
| `test_wet_has_no_usable_rows` | the count of simulable `sim_driver_params` rows in sessions with wet-compound representative laps is **0** |
| `test_cf_widening_is_not_double_counted` | a cross-component counterfactual's variance equals the joint-draw variance ⊕ `MODE2_CF_INTERACTION_PCT²` ⊕ `calibration_mae²`, within 1 % — not roughly double it |
| `test_cf_interval_floor` | no `mode2_counterfactual` band is narrower than that season's `replay_mae_points` |
| `test_title_odds_unchanged` | snapshot of `title_odds` before/after a Mode 2 run is byte-identical — `TITLE_PL_TEMPERATURE` was not touched |
| **`test_mode2_refit_is_bit_identical`** | two consecutive `recompute_all(force=True)` runs produce an identical sha256 over every numeric column of every `mode2_*` table (§6.6) |
| `test_force_skips_when_complete` | `recompute_all(force=False)` on an unchanged DB returns `{"skipped": True}` and writes nothing |
| `test_red_bull_2024_declines` | `mode2_car_rating` slope for `(red_bull, 2024)` is positive with `slope_lo > 0` |
| `test_status_vocabulary_is_race_only` | the hazard numerator and denominator both filter `sessions.kind = 'R'`; sprint rows never enter |
| `test_no_variance_ratio_in_copy` | greps `web/` for `11x`, `11×`, `eleven times` and for any `sd_ratio` rendered squared; must find none (§1.6) |
| `test_empty_states` | with `mode2_*` truncated, every §8 query returns `null`/`[]` and no page throws |

### 7.7 Run-end budget — measured, and how it is kept

| Step | Measured cost |
|---|---|
| `load_rows` + `build_components` | 0.4 s |
| REML fit (Spec S) | 3.15 s |
| BLUP + `A⁻¹` | < 0.1 s |
| parametric bootstrap, 400 reps, 8 jobs | 245 s |
| rating history: 3 cumulative refits + 120-rep bootstraps | 230 s |
| grid-pace fit + bootstrap | 55 s |
| **qualifying (`one_lap_pace`) fit + G1/G2/G3 + `mode2_quali_row_audit` write** | **+0.2 s** |
| tyre + wet rejection reports | 55 s |
| hazard fit | 6 s |
| points calibration (3 seasons × temperature grid) | 40 s |
| career seasons: 28 drivers × 3 seasons × 2 scenarios, 4,000 draws | 45 s |
| counterfactuals: ≤ `MODE2_CF_MAX_SCENARIOS` (900) at 0.269 s | ≤ 242 s |
| **total** | **≈ 15 minutes** (v1.8 adds 0.2 s; the figure is unchanged at this resolution) |

That is a run-end cost, once per ingest run, and it is stated honestly rather than
claimed to be under five minutes. If it must come down, cut in the §9.4 order.
`MODE2_CF_MAX_SCENARIOS` is a hard guard: `recompute_points` enumerates the scenario grid,
sorts it deterministically (year, team_id, driver_id), truncates at the cap, and records
`n_scenarios_skipped` in the `mode2_counterfactual` status row so the UI can say the grid
is partial rather than silently showing gaps.

### 7.8 Recompute procedure (operator-facing)

    # full feature, from stored rows, no FastF1 loads
    .venv/bin/python -m f1lab.ingest --recompute-companion mode2
    # everything, in the contract order
    .venv/bin/python -m f1lab.ingest --recompute-companion all
    # forced refit (bit-identical; see test_mode2_refit_is_bit_identical)
    .venv/bin/python -m f1lab.ingest --recompute-companion mode2 --force

`--recompute-companion` never loads FastF1 and never needs `--season`. The existing
`--force` flag already exists; the fourth integration edit is that
`recompute_companion(conn, asid, steps=..., force=a.force)` passes it through, and only
the `mode2` step reads it (the other three ignore it, exactly as today). No new CLI flag
is created.

---

## 8. Web

### 8.1 Files

    web/lib/queries/mode2.ts            NEW   every query in this section
    web/components/charts/RatingBar.tsx        NEW
    web/components/charts/RatingHistory.tsx    NEW
    web/components/charts/DecompositionBar.tsx NEW
    web/components/charts/CarPaceBars.tsx      NEW
    web/components/charts/DevelopmentSegments.tsx NEW
    web/components/charts/HazardBars.tsx       NEW
    web/components/driver/SkillPanel.tsx       NEW   (section card, not a chart)
    web/components/driver/CareerAdjusted.tsx   NEW
    web/components/driver/CareerH2HTable.tsx   NEW
    web/components/constructor/**              NEW   header + section cards
    web/components/witc/**                     NEW   was-it-the-car cards + control
    web/app/constructor/page.tsx               NEW
    web/app/constructor/[slug]/page.tsx        NEW
    web/app/season/[year]/was-it-the-car/page.tsx NEW
    web/app/driver/[code]/page.tsx             EDIT  three new slots
    web/components/ui/Nav.tsx                  EDIT  one link

**All chart components live in `web/components/charts/`**, matching every existing chart
in the repo. **No new `echarts` import anywhere**: `BarChart`, `CustomChart`,
`LineChart` and `ScatterChart` are already registered in `EChart.tsx`, and nothing in
Mode 2 needs a type that is not. **There is no radar chart** (§3.6), which is what keeps
`EChart.tsx` frozen — it is owned by nobody in §9.1 and must not be edited.

### 8.2 Query signatures (`web/lib/queries/mode2.ts`)

```ts
export type AnchorClass = "anchored" | "component-anchored" | "floating";
export type Basis = "measured" | "by-analogy";

export type DriverRating = {
  driverId: string; ratingPp: number; ratingLo: number; ratingHi: number;
  sdWithin: number; sdIsland: number; sdTotal: number; fracFloating: number;
  evidenceShare: number; anchorClass: AnchorClass; basis: Basis;
  componentId: string; componentLabel: string; rankInComponent: number;
  componentSize: number; nRaces: number; nCells: number; nRacesExcluded: number;
};
export type RatingHistoryPoint = {
  throughYear: number; ratingPp: number; ratingLo: number; ratingHi: number;
  nRacesCumulative: number; switchedThisYear: boolean;
};
export type SkillRow = {
  // v1.8: seven keys. SKILL_ORDER is
  // ["race_pace","one_lap_pace","grid_pace","tyre_management","wet","sprint_one_lap","trail_braking"]
  skill: "race_pace" | "one_lap_pace" | "grid_pace" | "tyre_management" | "wet"
       | "sprint_one_lap" | "trail_braking";
  measured: boolean; value: number | null; valueLo: number | null; valueHi: number | null;
  unit: string; anchorClass: AnchorClass; pctFieldBelow: number | null;
  notMeasuredReason: string | null; nObs: number;
};
export type ContrastRow = {
  driverA: string; driverB: string; kind: "teammate" | "cross";
  deltaPp: number; deltaSe: number; deltaLo: number; deltaHi: number;
  sameComponent: boolean; sharedCells: string[]; nSharedRaces: number;
};
export type CareerSeasonRow = {
  year: number; teamId: string; actualPoints: number;
  replayPoints: number; replayLo: number; replayHi: number;
  avgDriverPoints: number; avgDriverP10: number; avgDriverP90: number;
  contribution: number; contributionLo: number; contributionHi: number;
  calibrationMae: number; basis: Basis; anchorClass: AnchorClass;
};
export type CarRatingRow = {
  teamId: string; year: number; gammaPp: number; gammaLo: number; gammaHi: number;
  slopePp: number; slopeLo: number; slopeHi: number; startPp: number; endPp: number;
  slopeSignificant: boolean; rankInSeason: number; basis: Basis; nRaces: number;
};
export type HazardRow = {
  teamId: string; year: number; retirements: number; racingLaps: number;
  hazardPer1000: number; hazardLo: number; hazardHi: number;
  hazardCarOnly: number; hazardCarLo: number; hazardCarHi: number;
  rankInSeason: number; sufficient: boolean;
};
export type CounterfactualRow = {
  year: number; driverId: string; teamId: string; replacedDriverId: string;
  observed: boolean; pointsP10: number; pointsP50: number; pointsP90: number;
  incumbentActual: number; deltaP10: number; deltaP50: number; deltaP90: number;
  basis: Basis; crossComponent: boolean; calibrationMae: number;
};
export type FitMeta = {
  fittedAt: string; nRows: number; nDrivers: number; nSessions: number;
  nComponents: number; tauDriver: number; tauCar: number; sigmaResid: number;
  sdRatio: number; sdRatioLo: number; sdRatioHi: number; ciLevel: number;
  floatingDrivers: string[];
};

export async function getFitMeta(): Promise<FitMeta | null>;
export async function getDriverRating(driverId: string): Promise<DriverRating | null>;
export async function getRatingHistory(driverId: string): Promise<RatingHistoryPoint[]>;
export async function getDriverSkills(driverId: string): Promise<SkillRow[]>;
export async function getTeammateContrasts(driverId: string): Promise<ContrastRow[]>;
export async function getCareerAdjusted(driverId: string): Promise<CareerSeasonRow[]>;
export async function resolveConstructor(slug: string, year?: number)
  : Promise<{ teamId: string; name: string; colour: string; years: number[] } | null>;
export async function getConstructorIndex(year: number): Promise<CarRatingRow[]>;
export async function getCarRatings(teamId: string): Promise<CarRatingRow[]>;
export async function getDevelopment(year: number): Promise<CarRatingRow[]>;
export async function getHazards(teamId: string): Promise<HazardRow[]>;
export async function getSeasonDecomposition(year: number)
  : Promise<{ rating: DriverRating; car: CarRatingRow; observedPace: number }[]>;
export async function getCounterfactuals(year: number, driverId: string)
  : Promise<CounterfactualRow[]>;
```

Every query reads only `mode2_*` joined to `drivers` / `teams` / `sessions`, filtered on
the `is_current` fit, and returns `null` / `[]` rather than throwing when the fit is
missing. **No query computes a difference of two stored estimates** (FD1) — the contrast
table exists for that. **No query may `ORDER BY rating_pp` across components and present
the result as a ranking**; grid-wide ordering is allowed only inside
`getSeasonDecomposition`, whose component is required to draw the §8.4 separator.

### 8.3 Chart props and ECharts option shapes

```ts
// RatingBar — one driver per row, the grammar of §8.4.
type RatingBarProps = {
  rows: DriverRating[]; ciLevel: number;
  highlightDriverId?: string; showSeparator?: boolean;
};
// option: { grid, xAxis:{type:'value', name:'% of a lap vs the average driver'},
//   yAxis:{type:'category'},
//   series:[ {type:'bar', id:'measured'},            // solid: |rating| within sd_within
//            {type:'custom', id:'assumed', renderItem: hatchedRect},  // the rest
//            {type:'custom', id:'ci', renderItem: whisker} ] }

type RatingHistoryProps = { points: RatingHistoryPoint[]; ciLevel: number };
// option: series [ {type:'line', step:'end'}, {type:'custom', renderItem: bandPolygon} ]
// markLine at each `switchedThisYear` round, label "team change".

type DecompositionBarProps = {
  rows: { driverId: string; carPp: number; driverPp: number; carSe: number;
          driverSe: number; basis: Basis; componentId: string }[];
};
// One horizontal bar per driver, car segment then driver segment. The boundary between
// the two segments is drawn as a GRADIENT of width 2·sqrt(carSe²+driverSe²) with a
// whisker across it. There is NO version of this chart with a crisp boundary (§8.4).

type CarPaceBarsProps    = { rows: CarRatingRow[]; year?: number; ciLevel: number };
type DevelopmentSegmentsProps = { rows: CarRatingRow[]; year: number };
// custom series: one two-point segment per car, start→end, band shaded.
// rows with slopeSignificant === false render at opacity 0.35 in the neutral grey.
type HazardBarsProps     = { rows: HazardRow[]; year: number; mode: "raw" | "carOnly" };
```

### 8.4 The visual grammar of uncertainty — binding rules

These are component-level invariants. A pull request that breaks one is rejected on that
ground alone; `test_empty_states` and code review enforce them.

1. **Solid means measured; hatched means assumed.** On every rating bar the solid segment
   is the part supported by `sd_within` and the hatched extension is the part that rests
   on `sd_island`. A `floating` driver's bar is hatched end to end.
2. **A `floating` driver gets a hollow dot and a "level not measured" chip, and his
   headline numeral is not rendered as a plain number** — the chip replaces it. He must
   be distinguishable from an `anchored` driver **with the labels stripped off**.
3. **A separator, not just a shade, in any cross-component ordering.** Wherever drivers
   from different components appear in one ordered list, a visible horizontal rule is
   drawn at each component boundary carrying the heading **"Not comparable to the drivers
   above"**. Hatching marks a row as odd; only a break stops a reader subtracting across
   it.
4. **The decomposition boundary is always fuzzy** (§8.3).
5. **A counterfactual headline is a range.** "Somewhere between 178 and 266 points" is
   the headline; the point estimate appears in smaller muted type **below** the range,
   never above it. For `basis === 'by-analogy'` rows **the point estimate is not rendered
   at all** — the card shows the distribution and a sentence. A cropped screenshot of the
   worst-supported claim on the site must contain no number to misquote.
6. **"This pairing never happened" is rendered ABOVE the result**, never below, and a
   `crossComponent` row additionally names the crossing in words.
7. **No car:driver ratio is ever rendered as a variance ratio** (§1.6).
8. **Race pace and grid pace are never on a shared axis and never on a radar** (§3.2).
9. **Every chart's caption states the interval level in words** ("5th–95th percentile"),
   and no chart renders a number without its interval (FD2).

### 8.5 Page slots

**`/driver/[code]`** — three new `<Section>` blocks, inserted after the existing summary
tiles and before the degradation section:

| Slot | Component | Query | Empty state |
|---|---|---|---|
| Driver rating | `<RatingBar rows=[this driver + component peers]>` + `<StatTile>` | `getDriverRating`, `getFitMeta` | `EmptyState reason="partial: no usable race pace for this driver"` |
| Rating over time | `<RatingHistory>` | `getRatingHistory` | `EmptyState reason="partial: fewer than two seasons of data"` |
| What we can and cannot measure | `<SkillPanel>` (two measured bars + two refusal cards, equal weight) | `getDriverSkills` | `EmptyState reason="SimNotEstimable: mode2 fit did not converge"` |
| Car-adjusted career | `<CareerAdjusted>` | `getCareerAdjusted` | `EmptyState reason="partial: no calibrated season for this driver"` |
| Team-mates, career | `<CareerH2HTable>` | `getTeammateContrasts` | `EmptyState reason="partial: no shared races"` |

**`/constructor`** — index: season switcher, `<CarPaceBars rows=getConstructorIndex(year)>`,
`<DevelopmentSegments>`, caption.

**`/constructor/[slug]`** — the five slots of §5.1.

**`/season/[year]/was-it-the-car`** — §8.6.

`web/components/ui/Nav.tsx` gains exactly one entry, "Constructors". The
"Was it the car?" page is reached from the season page's own section list, because the
claim is season-bounded and the URL should say so.

### 8.6 The "Was it the car?" page

Order is deliberate: **the grid-wide answer and its caveats are read before the
counterfactual toy.**

1. `<Caption id="C-WITC-1">` — the lede. It is the first thing on the page, above any
   chart.
2. `<DecompositionBar>` for every driver in that season, grouped by component with the
   §8.4 separator between groups.
3. `<StatTile>` row: `sdRatio` **as an SD ratio with its seconds translation and its
   band**; `sigmaResid` as "race-to-race noise"; `nComponents` as "4 groups we cannot
   compare across".
4. `<Caption id="C-WITC-2">` — what the four components mean, naming the four floating
   drivers.
5. The counterfactual control: two selects (driver, constructor-season) and a
   `<CounterfactualCard>` obeying §8.4 rules 5 and 6. Default state is **empty with a
   prompt**, never a pre-filled Verstappen-in-a-McLaren.
6. `<Caption id="C-CF-1">` — the three assumptions, in fan language.

### 8.7 VERBATIM captions

Every string below is the exact text to render. Do not paraphrase, do not shorten, do not
"improve the tone". Where a number appears it is filled from the stored fit.

**`C-RATING-1` — /driver, driver rating**

> This is how much faster or slower than the average 2024–2026 driver we estimate this
> driver to be, once the car has been accounted for, in percent of a lap — about 0.9
> seconds per 1 % at a 90-second circuit. It is fitted on fuel-corrected race pace from
> {nSessions} races between 2024 and 2026 and on nothing else. It says nothing about any
> other era, any other rule set, or this driver before 2024, and it is not an all-time
> ranking. The bar shows the 5th–95th percentile range.

**`C-RATING-2` — appended for a `floating` driver**

> We cannot measure this driver's level. He has never changed team, and neither has his
> team-mate, so nothing in 2024–2026 separates how good he is from how good his car was.
> The number you see is what the model assumes when it has no evidence: that his team's
> two drivers are an ordinary pair. More races will not fix this. A transfer would.

**`C-HISTORY-1` — /driver, rating over time**

> Each point re-fits the whole model using only the races up to the end of that season.
> The band gets narrower when a driver changes team, because a transfer is the only event
> that tells us how good his old car really was. For a driver who has never moved, the
> band stays the same width no matter how many races he runs — more racing, no more
> knowledge.

**`C-SKILL-1` — /driver, the skill panel header**

> We tried to measure four things. Two of them we can show you. Two of them we cannot,
> and the reasons are below — they are part of the answer, not a disclaimer.

**`C-SKILL-2` — starting-grid pace. AMENDED IN PLACE in v1.8.**

*(Amended in v1.6: the old first sentence — "because there are no qualifying lap times in
our data at all" — became false the day migration 0006 landed. Amended again in v1.8: the
sentence "this axis has not yet been refitted onto them" became false the day 0009 landed,
because §3.2b ships the refit beside it. **The fit has never changed; only the sentence
explaining it has.** This caption ID stays attached to starting-grid pace forever and is
**never reassigned to another skill** — reassigning it would silently repoint a drift test.)*

> This is fitted from where the car started. Starting position includes grid penalties and
> pit-lane starts, and this number does not subtract them — a five-place gearbox penalty enters
> it as driver slowness. Qualifying pace, above, is fitted on the laps themselves and includes
> none of that. Where the two bars disagree, the disagreement is the penalties, the pit-lane
> starts and the sprint-weekend grids. This bar is measured on a rank scale, not in lap time, so
> the two cannot be subtracted and this bar is not comparable to the two above it.

**`C-SKILL-3` — tyre management, refusal card**

> We fitted this and we are not showing a number. Across {nStints} stints, the
> differences between drivers came out smaller than their own error bars: how fast a set
> of tyres dies is mostly a property of the track and the compound, with a small team
> component and no driver component we can detect. A ranking here would be a ranking of
> noise.

**`C-SKILL-4` — wet weather, refusal card**

> There is no wet-weather rating because there is no wet-weather data we can use. Five
> races since 2024 had real wet-tyre running, and our pace model refuses all five —
> changing conditions break the fuel correction that everything here is built on. The one
> rainy race it can fit was run entirely on slicks. We would rather show you nothing than
> a number we made up.

**`C-SKILL-5` — qualifying pace, under the bar, unconditional. NEW in v1.8.**

> This is fitted from each driver's first-segment qualifying lap — Q1, the one segment every
> driver runs — measured as a percentage of that session's own field average, across {nRows} laps
> and {nSessions} sessions. Percentages, not seconds, because a tenth at Monaco is not a tenth at
> Spa. Sprint qualifying is not in this number. Wet sessions are not in this number. A driver who
> cruises Q1 because his car will walk into Q3 is measured on that cruise, and we cannot tell
> that apart from being slow: for the drivers who reach Q3, the margin we can see in Q1 is about
> forty per cent smaller than the margin they show when it counts.

**`C-SKILL-6` — under the shared axis, prints both stored correlations. NEW in v1.8.**

> Qualifying pace and race pace are different numbers on the same scale: percent of a lap,
> against the field that was actually there. Across {nDrivers} drivers they agree at
> r = {corrOneLapRace}, so most of what they measure is the same thing measured twice.
> Starting-grid pace is on a different scale and cannot be put beside them; it agrees with
> qualifying pace in ranking at r = {corrOneLapGrid}.

**`C-SKILL-7` — above the shared axis, unconditional. NEW in v1.8.**

> {nCrossZero} of these {nDrivers} qualifying ratings include zero. Where two bars overlap, we
> have not shown you a difference — we have shown you two numbers we cannot separate.

**`C-SKILL-8` — the island caption, on the hatched bars, unconditional. NEW in v1.8.**

> Qualifying gave us {nQualiLaps} new laps and not one new transfer. These drivers have never
> raced for another team in this data, so where they sit against the rest of the grid is an
> assumption we made, not something we measured. About half of the uncertainty in this bar is
> that assumption rather than measurement, and more qualifying sessions will never narrow it.

*(Slot provenance for `C-SKILL-5..8`, all template slots and none a literal: `{nRows}` and
`{nQualiLaps}` = the fit's row count; `{nSessions}`; `{nDrivers}`; `{nCrossZero}` = posterior
intervals containing zero; `{corrOneLapRace}` and `{corrOneLapGrid}` = the **Pearson** values
stored on `mode2_fit_run`, which are the only ones in the database — the Spearman figures are
computed in the run log and must never be printed as if they were stored. `C-SKILL-6` is the only
caption that prints a correlation, and it prints the two that are stored.)*

**`C-CAREER-1` — /driver, car-adjusted career**

> "Average driver" means a driver at exactly the middle of this era's field, put in the
> same car, with every other seat on the grid left alone. Both bars come from the same
> simulator, so the difference between them is the driver and nothing else. The real
> points total is shown beside them as a separate fact, because it is one.

**`C-CAREER-2` — appended under the chart**

> Our simulator, replaying the real season with the real drivers in the real cars, still
> misses real points totals by about {calibrationMae} points. Every band on this chart is
> at least that wide, and almost all of its width comes from uncertainty about the driver
> and car ratings rather than from the race-by-race dice.

**`C-CONTRAST-1` — /driver, career team-mate table**

> This is the most trustworthy number on the page. Two drivers in the same car, over
> {nSharedRaces} races, is the one comparison the data make directly — no assumption
> about how good the car was is needed for it, and it barely moves when we change the
> model.

**`C-CONTRAST-2` — rendered on any `sameComponent === false` row**

> These two drivers have never shared a car, and no chain of team moves connects them.
> This gap is what the model assumes, not what it measured.

**`C-CAR-1` — /constructor, car pace rating**

> Car ratings are measured against the rest of that season's field, not against other
> seasons. A car at −1.8 % in 2026 was further clear of its own rivals than a car at
> −0.8 % in 2024; it does not mean it was a second a lap quicker in absolute terms.
> Driver effects have been removed by the model, not by averaging, so a mid-season driver
> change cannot show up here as car performance.

**`C-DEV-1` — /constructor, in-season development**

> Only {nSignificant} of the {nCarSeasons} car-seasons in our data developed at a rate we
> can distinguish from flat — and testing {nCarSeasons} cars at this threshold produces
> about 1.6 apparent movers by chance alone. Everything greyed out moved less than the
> noise. The line is drawn as one straight segment from the start of the season to the
> end, because twenty-four races cannot support a curve.

**`C-HAZARD-1` — /constructor, retirements**

> This is not a reliability rating. Our data record that a car stopped; they never record
> why, so a broken gearbox and a first-lap collision look identical here. We split the
> rate into a car part and a driver part, and the car part is the one shown by default —
> but a driver who crashes a lot will still leave a mark on his team's number. Rates are
> per 1,000 racing laps and are only comparable within a season: 2026 is a
> regulation-reset year and the whole grid retires more often.

**`C-WITC-1` — /season/[year]/was-it-the-car, the lede, first thing on the page**

> **The team-mate gaps on this page are a measurement. The ordering across teams is a
> modelling choice.** We checked how much each one moves when we fit the model a
> different but equally reasonable way: every team-mate gap moved by at most 0.04 % of a
> lap, and some drivers' overall ratings moved by as much as 0.6 %. So compare two
> drivers in the same car with confidence, and treat the grid-wide order as our best
> estimate rather than a fact.

**`C-WITC-2` — under the decomposition chart**

> Splitting a lap into "car" and "driver" only works when drivers move between teams, and
> in 2024–2026 only twelve of twenty-eight did. That leaves four separate groups of
> drivers that cannot be compared with each other at all, and four drivers — Lando
> Norris, Oscar Piastri, Fernando Alonso and Lance Stroll — whose own results say nothing
> about how good their cars were. For them we borrow the answer from the rest of the
> grid: we assume their team's two drivers are an ordinary pair and give the car whatever
> is left over. That assumption, not their results, is what decides how much credit
> McLaren and Aston Martin get here.

**`C-WITC-3` — the stat tile, beneath the ratio**

> Across 2024–2026, the spread between the fastest and slowest cars is about
> {sdRatio}× the spread between the fastest and slowest drivers — roughly {tauCarSec}
> versus {tauDriverSec} seconds a lap at a 90-second circuit. That comparison is itself
> uncertain: it could be as little as {sdRatioLo}× or as much as {sdRatioHi}×.

**`C-WITC-4` — the race-to-race noise tile**

> A single race tells you much less than it looks like. After the car, the driver and
> in-season development are all accounted for, the same driver in the same car still
> varies by about {sigmaResid} % of a lap from race to race — more than the entire spread
> between the best and worst drivers on the grid.

**`C-CF-1` — above every counterfactual result**

> **This pairing never happened.** We are adding up a driver's measured speed and a car's
> measured speed, two things that were never observed together, and assuming they simply
> add. They might not: teams build cars around their drivers, drivers take time to adapt,
> and a driver's advantage may shrink in a slower car. We widened the range to allow for
> that, using the size of the driver-car fit we could measure elsewhere on the grid. Read
> this as what our model implies, not as what would have happened.

**`C-CF-2` — appended when `crossComponent === true`**

> This swap crosses two groups of drivers that our data cannot compare — {driverName} and
> {teamName} are connected by no chain of team moves. The range below is almost entirely
> an assumption.

**`C-CF-3` — appended when any hand-set widening is in force**

> The range on a counterfactual is wider than the range on a real season partly because
> we widened it on purpose. Treat anything inside it as "we cannot tell".

### 8.8 Empty states

| Condition | Rendered |
|---|---|
| no `is_current` fit | `<EmptyState reason="partial: the driver-car model has not been fitted yet" />` |
| fit did not converge | `<EmptyState reason="SimNotEstimable: mode2 fit did not converge" />` |
| driver has no included row | `<EmptyState reason="partial: no usable race pace for this driver" />` |
| < 2 seasons for a driver | `<EmptyState reason="partial: fewer than two seasons of data" />` |
| car-season under 200 racing laps | `<EmptyState reason="partial: fewer than 200 racing laps" />` |
| counterfactual grid truncated at the cap | the card renders, plus `<Caption>` "Some combinations are not precomputed yet." |
| wet skill | **no empty state** — the refusal card `C-SKILL-4` is the content |
| tyre skill | **no empty state** — the refusal card `C-SKILL-3` is the content |

No page throws, ever. Every query returns `null` or `[]` and every component renders
`<EmptyState>` for those (FD6).

---

## 9. Work packages

### 9.1 File ownership — one owner per file, for the whole release

**Two people never open the same file.** Where a file must be touched by two packages it
is handed over explicitly, in writing, below. Anything not listed is **frozen**: read it,
do not edit it.

| File / directory | Owner | Note |
|---|---|---|
| `f1lab/config.py` | **WP1** | all §7.3 constants land in one commit, then frozen |
| `f1lab/frames.py` | **WP1** | the twelve `TABLE_COLUMNS` entries only, then frozen |
| `f1lab/companion.py` | **WP1** | `STEPS`, dispatch, `assert_inputs` |
| `f1lab/ingest.py` | **WP1** | help string + `force=a.force` passthrough |
| `web/db/schema/mode2.ts`, `web/db/schema/index.ts`, `web/drizzle/0003_*` | **WP1** | |
| `tests/test_mode2_schema.py` | **WP1** | |
| `f1lab/decomp.py` | **WP2**, then **WP3** | WP2 writes §7.2's first block and `recompute_rating`; **hands the file to WP3 at the WP2 gate**, after which WP2 does not touch it |
| `tests/test_mode2_model.py` | **WP2** | |
| `tests/test_mode2_skills.py` | **WP3** | |
| `f1lab/decomp_points.py`, `tests/test_mode2_points.py` | **WP4** | |
| `web/lib/queries/mode2.ts` | **WP5** | the only new queries file |
| `web/components/charts/RatingBar.tsx`, `RatingHistory.tsx`, `DecompositionBar.tsx`, `CarPaceBars.tsx`, `DevelopmentSegments.tsx`, `HazardBars.tsx` | **WP6** | |
| `web/app/driver/[code]/page.tsx`, `web/components/driver/**` | **WP7** | |
| `web/app/constructor/**`, `web/app/season/[year]/was-it-the-car/page.tsx`, `web/components/constructor/**`, `web/components/witc/**` | **WP8** | |
| **`web/components/ui/Nav.tsx`** | **WP8** | exactly one link; no other package may touch it |
| **`web/components/charts/EChart.tsx`** | **nobody** | **frozen.** No Mode 2 chart needs a new echarts type (§8.1). If you think you need one, stop and report it |
| `f1lab/title.py`, `winprob.py`, `preview.py`, `season.py`, `sim.py`, `moments.py`, `db.py`, `clean.py` | **nobody** | frozen; read-only inputs |
| everything else in `web/` and `f1lab/` | **nobody** | frozen |

### 9.2 Packages

| WP | Title | Depends on | Deliverable |
|---|---|---|---|
| **WP1** | Foundations | — | §7.3 constants, §6.3 `TABLE_COLUMNS`, `mode2.ts` schema, migration 0003 applied, `companion` step `mode2` wired to a stub that writes an `analytics_status` row and nothing else |
| **WP2** | The pace model | WP1 | `load_rows`, `build_components`, `fit_reml`, `bootstrap`, `contrasts`, `recompute_rating`; populates `mode2_fit_run`, `mode2_component`, `mode2_driver_rating`, `mode2_driver_rating_history`, `mode2_driver_contrast`, `mode2_row_audit` |
| **WP3** | Skills + constructor | WP2 gate | `fit_grid_pace`, `tyre_rejection_report`, `wet_rejection_report`, `fit_hazard`, `recompute_skills`, `recompute_constructor`; populates `mode2_driver_skill`, `mode2_car_rating`, `mode2_car_hazard` |
| **WP4** | Points and counterfactuals | WP2 gate | `f1lab/decomp_points.py`; populates `mode2_points_calib`, `mode2_career_season`, `mode2_counterfactual` |
| **WP5** | Query layer | WP1 | `web/lib/queries/mode2.ts`, every signature in §8.2, typed and returning `null`/`[]` on empty tables |
| **WP6** | Charts | WP1 | the six chart components of §8.3 with the §8.4 grammar, driven by fixture props |
| **WP7** | Driver page | WP5, WP6 | the five §8.5 slots on `/driver/[code]`, captions `C-RATING-*`, `C-HISTORY-1`, `C-SKILL-*`, `C-CAREER-*`, `C-CONTRAST-*` |
| **WP8** | Constructor + "Was it the car?" | WP5, WP6 | `/constructor`, `/constructor/[slug]`, `/season/[year]/was-it-the-car`, the counterfactual control, `Nav.tsx`, captions `C-CAR-1`, `C-DEV-1`, `C-HAZARD-1`, `C-WITC-*`, `C-CF-*` |

### 9.3 Sequencing and verification

    WP1 ──┬── WP2 ──┬── WP3
          │         └── WP4
          ├── WP5 ──┬── WP7
          └── WP6 ──┴── WP8

WP5 and WP6 start immediately after WP1: the query signatures and chart props are fully
specified here, and both are built against empty tables and fixtures.

**WP1 gate**

    cd web && npx drizzle-kit generate --name mode2 && npx drizzle-kit migrate
    cd .. && .venv/bin/python -m f1lab.ingest --check-schema          # exit 0
    docker exec f1-postgres psql -U f1 -d f1 -c "\dt mode2_*"         # 12 tables
    .venv/bin/pytest tests/test_mode2_schema.py -q
    .venv/bin/python -m f1lab.ingest --recompute-companion mode2      # stub, exit 0

**WP2 gate** (hands `decomp.py` to WP3 on green)

    .venv/bin/pytest tests/test_mode2_model.py -q
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select n_components, n_rows, n_drivers, round(tau_driver::numeric,3), \
              round(tau_car::numeric,3), round(sd_ratio::numeric,2) \
       from mode2_fit_run where is_current"
    # MUST be: 4 | 930 | 28, and the three variance components within ±0.01 of
    #          0.264 | 0.874 | 3.31. A larger gap is a defect, not a tuning opportunity.
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select anchor_class, count(*) from mode2_driver_rating group by 1"
    # MUST be: anchored 12 | component-anchored 12 | floating 4
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select driver_id, round(sd_total::numeric,3) from mode2_driver_rating \
       order by sd_total desc limit 4"
    # MUST be the four floating drivers (norris, piastri, alonso, stroll)

**WP3 gate**

    .venv/bin/pytest tests/test_mode2_skills.py -q
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select skill, count(*) filter (where measured) m, count(*) n \
       from mode2_driver_skill group by 1 order by 1"
    # MUST be: grid_pace 28/28 | race_pace 28/28 | tyre_management 0/28 | wet 0/28
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select count(*) from mode2_car_rating where slope_significant"   # small, 2-6
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select retirements, racing_laps from mode2_car_hazard \
       where team_id='aston_martin' and year=2026"   # MUST be 14 | 1214

**WP4 gate**

    .venv/bin/pytest tests/test_mode2_points.py -q
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select year, round(temperature::numeric,2), round(replay_mae_points::numeric,1) \
       from mode2_points_calib order by year"
    # MUST be within one grid step / ±3 points of: 2024 0.35 15.6 | 2025 0.40 25.1 |
    #          2026 0.30 12.5
    docker exec f1-postgres psql -U f1 -d f1 -c \
      "select count(*) from mode2_counterfactual where basis='by-analogy' \
       and points_p10 is null"                       # MUST be 0 (the CHECK guarantees it)
    .venv/bin/pytest tests/test_mode2_points.py::test_title_odds_unchanged -q

**WP5 gate**

    cd web && npx tsc --noEmit && npx next build
    # with mode2_* truncated in a scratch DB, every query returns null/[] and build passes

**WP6 gate**

    cd web && npx tsc --noEmit
    grep -rn "echarts" web/components/ | grep -v "EChart.tsx"     # MUST be empty
    grep -rn "radar" web/components/                              # MUST be empty

**WP7 / WP8 gate**

    cd web && npx next build
    grep -rn "11x\|11×\|eleven times" web/                        # MUST be empty
    grep -rn "Not comparable to the drivers above" web/components # MUST appear in
                                                                  # RatingBar and DecompositionBar
    .venv/bin/pytest tests/ -q                                    # whole suite green

**Integration gate** (whoever merges last)

    .venv/bin/python -m f1lab.ingest --recompute-companion all
    .venv/bin/python -m f1lab.ingest --recompute-companion mode2 --force   # twice
    .venv/bin/pytest tests/ -q
    cd web && npx next build

### 9.4 What to cut, in order, if v1.3 must ship smaller

1. The counterfactual **control** on /was-it-the-car (keep the decomposition and its
   captions; the control is the most expensive and most misreadable part).
2. The in-season **development segments** (keep the car rating).
3. The **rating-over-time** history refits (keep the single career rating).
4. The `/constructor` **index** page (keep `/constructor/[slug]`).

Never cut: the component count and the four-component caveat, `anchor_class` and its
visual grammar, the career team-mate contrast table, or any caption in §8.7.

---

## 10. Risks

**R1 — Thin data produces confident-looking nonsense.** Twenty-eight drivers, twelve
switchers, 930 rows. Random effects hand every driver a number, and a number rendered
with two decimals and a neat bar looks like a measurement whatever the caption says. The
specific failure is a fan screenshotting a ranking of four disconnected groups.
*Mitigations, in order of strength:* the schema contains no grid-wide rank column (§6.1),
so the lie is unrepresentable; the cross-component separator is a component invariant, not
a caption (§8.4 rule 3); `anchor_class` is stored, graph-derived and identical on every
skill surface (§2.4); `test_island_intervals_are_widest` fails the build if intervals ever
point the wrong way; two of four skills were refused outright on measured evidence (§3.3,
§3.4) with a refusal that expires (`test_tyre_rejection_still_holds`); and every level
carries `MODE2_SIGMA_SPEC` so the interval admits that a different reasonable model
exists.

**R2 — A fan reads a counterfactual as a fact.** "Verstappen in the McLaren: +43 points"
is the most shareable sentence this project can produce and the least defensible.
*Mitigations:* for `by-analogy` rows the point estimate is **not rendered at all** (§8.4
rule 5) — a crop of the worst-supported claim contains no number to misquote; the
headline is always a range with the point estimate demoted below it; "This pairing never
happened" renders above the result (§8.4 rule 6); the band is widened by the measured
interaction term (§1.7) and floored at the simulator's own replay error (§4.1); a row
cannot exist in the DB without its p10/p90 (§6.2); and `C-CF-1` names portability — the
assumption that a driver's advantage does not shrink in a slow car — which is the largest
real-world threat and the one no amount of widening fixes.

**R3 — The headline ratio gets restated in the wrong units.** The car:driver variance
ratio is 11; the SD ratio is 3.3. "11×" is three times the truth in the units the rest of
the page uses, and it is exactly the kind of number that escapes into a tweet.
*Mitigations:* §1.6 makes the SD ratio the only permitted form; `sd_ratio` is the stored
column and there is no variance-ratio column; `C-WITC-3` prints the ratio, the seconds
translation and the 5th–95th band in one sentence; `test_no_variance_ratio_in_copy` greps
the web tree for the forbidden strings.

**R4 — The points simulator silently halves every contribution.** At v1.2's
`TITLE_PL_TEMPERATURE = 1.0` the replay returns `sd(sim)/sd(actual) ≈ 0.52–0.58` and a
MAE of 35–59 points, which would deflate every car-adjusted number — in the direction
that flatters the story. *Mitigations:* a per-season Mode 2 temperature is fitted and
stored (§4.1) and `TITLE_PL_TEMPERATURE` is not touched; `test_title_odds_unchanged`
snapshots v1.2's output; the replay MAE is stored per season, applied as a floor on every
band, and printed on the page (`C-CAREER-2`); and `actual_points` and `replay_points` are
shown side by side so the model's own error is visible rather than laundered into the
driver's credit.

**R5 — An implementer reintroduces a broken estimator that looks more standard.** Three
specific traps are known and all three are easy to walk into: a race-cluster bootstrap
(gives the island drivers the *narrowest* bands — measured norris ±0.095 vs verstappen
±0.294); a per-season refit of the rating (the driver×season graph has 28 components, so
every per-season number is ~100 % prior); and differencing two marginal intervals to get
a team-mate gap (roughly twice too wide, because the effects are strongly negatively
correlated). *Mitigations:* each has a named test that fails the build —
`test_island_intervals_are_widest`, `test_no_per_season_refit`,
`test_contrast_is_not_a_difference_of_marginals` — and each is written into this document
beside the number that proves it.

**R6 — Run-end cost grows until the step is skipped in practice.** The measured budget is
~15 minutes (§7.7), most of it bootstrap and counterfactuals. A skipped step means stale
numbers presented as current. *Mitigations:* `MODE2_CF_MAX_SCENARIOS` hard-caps the
scenario grid and records what was skipped; `model_version` short-circuits an unchanged
refit in well under a second; §9.4 names what to cut and in what order; and
`mode2_fit_run.fitted_at` is rendered on every surface so a stale fit is visible.

---

## 11. Decisions log

One line each. These settle disagreements between the three proposals and between a
proposal and the brief.

1. **Observation unit is `sim_driver_params`, not laps** — two-stage, with the one-stage
   disagreement measured (≤0.10 pp) and shipped as `MODE2_SIGMA_SPEC` rather than hidden.
2. **Spec S (with the in-season development slope) ships**; Spec C is reported beside it
   because the two split car variance differently and the reader deserves to see that.
3. **The car:driver ratio is published as an SD ratio (3.3×), never a variance ratio
   (11×)** — the variance form is three times the truth in lap-time units.
4. **`anchor_class`, not `evidence_share`, is the badge** — `evidence_share` is not
   comparable across skills and would hatch a driver on race pace and not on grid pace,
   which reads as knowledge the model does not have.
5. **Grid pace ships, under the name "Starting-grid pace"** — two independent fits found
   real driver variance; the name and `C-SKILL-2` carry the grid-penalty caveat that
   `grid_position` cannot be cleaned of.
6. **Tyre management is refused** — τ_driver collapses to 0.000–0.0015 under every
   specification tried; the 0.0059 claim does not reproduce and is attributed to omitting
   `deg_std_err` from the residual.
7. **Wet weather is refused** — not thin, **zero**: the five sessions with real wet-tyre
   running are all non-simulable, and the only rain-flagged session with pace estimates
   ran on slicks. Re-verified directly for this document because two proposals had it
   wrong in opposite directions.
8. **The brief is corrected on band direction: the band NARROWS at a team switch**, since
   a transfer is the only event that adds identifying information. Any DDL comment or
   label saying otherwise is a defect.
9. **Rating over time is a leave-future-out cumulative refit, not a per-season refit** —
   a per-season refit is ~100 % prior at the level (9/9/10 components within a season).
10. **The driver×car interaction is estimable and was estimated** (τ = 0.099 pp over 72
    cells, 67 with repeats) — the claim that it is "unfittable" is false, and the measured
    value replaces the hand-set counterfactual widening constant.
11. **Cross-component counterfactuals are widened by the interaction term only**; adding
    `prior_share·τ²` on top of a joint posterior draw double-counts and is forbidden.
12. **The PL temperature is refitted per season for Mode 2** (0.35 / 0.40 / 0.30) instead
    of anchoring contributions to actual points by a ratio — the ratio repairs the display
    while leaving the simulator miscalibrated for every other consumer.
13. **Contribution differences two model outputs, never a fact minus a model output**;
    `actual_points` is shown beside them as a separate fact.
14. **The replay MAE is a published floor on every points interval** — no counterfactual
    band may be narrower than the machinery's own measured error.
15. **Four `analytics_status` keys, not one**, so a failed Monte Carlo cannot blank the
    driver rating.
16. **No new CLI flag**: `--recompute-companion mode2 [--force]` uses the mechanism that
    already exists.
17. **No radar chart, no pickled model artifact, no new package, no new echarts type** —
    `EChart.tsx` stays frozen and `requirements.txt` does not change.
18. **No grid-wide rank column anywhere in the schema** — the central falsehood is made
    unrepresentable rather than merely captioned.
19. **Intervals are 90 %**, chosen for readability, disclosed in words, and recorded in
    `mode2_fit_run.ci_level` so the choice is auditable rather than convenient.
20. **`/season/[year]/was-it-the-car` is a season sub-route**, not a top-level page with a
    `?year=` parameter, because the claim is season-bounded and the URL should say so.

---

## 12. As built

Integrated 2026-09-14 against the live `f1` container and the project `.venv`. All eight
work packages landed; all twelve `mode2_*` tables are populated at one fit; the web build
is clean and every route renders against real rows. Everything below is measured, not
restated from the sections above — where the two disagree, this section is what shipped
and §12.3 says why.

### 12.1 The production run

`make recompute-mode2 FORCE=1` (`--recompute-companion mode2 --force`), one writer, nothing
else touching the database:

| | |
|---|---|
| wall clock, end to end | **2 min 41 s** (rating 15 s, skills 14 s, constructor <1 s, points 122 s) |
| `fit_id` | 20, `model_version` `c6a942ae376774dc`, `assumption_set_id` 532 |
| warm re-run (`force=False`) | `{'skipped': True}`, no write |
| `analytics_status` | all four keys `ok` on all 62 non-failed race sessions; no error string anywhere |

Row counts, all twelve tables, at `fit_id` 20:

| table | rows | table | rows |
|---|---|---|---|
| `mode2_fit_run` | 1 | `mode2_car_rating` | 31 |
| `mode2_component` | 4 | `mode2_car_hazard` | 31 |
| `mode2_driver_rating` | 28 | `mode2_points_calib` | 3 |
| `mode2_driver_rating_history` | 79 | `mode2_career_season` | 68 |
| `mode2_driver_skill` | 112 | `mode2_counterfactual` | 868 |
| `mode2_driver_contrast` | 378 | `mode2_row_audit` | 983 |

### 12.2 The headline numbers, read back from stored rows

**Structure (§1.4) reproduces exactly.** Four components, membership for membership:
K1 "the main grid" 15 drivers / 17 cells, K2 "the Red Bull family" 9 / 8, K3 "Aston Martin"
{alonso, stroll} 2 / 3 floating, K4 "McLaren" {norris, piastri} 2 / 3 floating.

**Variance components (§1.6):** 930 rows, 53 excluded, 28 drivers, 31 cells, 52 sessions.
`tau_driver` 0.2646, `tau_car` 0.8760, `tau_slope` 0.3581, `sigma_resid` 0.3851,
**SD ratio 3.311 (5th–95th 2.35–5.04)**, `tau_interaction` 0.1139. Converged, shrinkage_ok
and interval_dir_ok all true.

**Identifiability (§2.4):** anchored 12 / component-anchored 12 / floating 4, and all four
floating drivers — and only they — carry `basis = 'by-analogy'`. The widest `sd_total` are
alonso and stroll 0.186, then doohan 0.182 (5 races, the known tie §2.4 names in words),
then norris and piastri 0.175. `frac_floating` is 0.943–0.945 on the islands.

**Contrasts (§2.5):** norris−piastri **−0.176 ± 0.090**, 5th–95th −0.324 to −0.027, 46
shared races, `same_component` true. max_verstappen−perez **−0.558 ± 0.126**, 14 shared
races, teammate. max_verstappen−norris −0.538 ± 0.220, `kind = 'cross'`,
`same_component = false`, 0 shared races.

**2026 car ratings (§5.2),** `rank_in_season` order: mercedes −1.770, ferrari −1.420,
mclaren −1.278 *(by-analogy)*, red_bull −0.675, rb −0.002, alpine +0.164, audi +0.269,
haas +0.595, williams +0.996, aston_martin +1.767 *(by-analogy)*, cadillac +2.254. Gamma
SEs 0.192–0.251.

**Points bridge (§4.1):** 2024 T 0.30 / MAE 17.9, 2025 T 0.40 / MAE 22.7, 2026 T 0.25 /
MAE 12.4 — every temperature within one grid step of the gate and every MAE within 3
points. `config.TITLE_PL_TEMPERATURE` untouched at 1.0.

**λ and additivity:** **λ = 1.4494** strength units per pp, capturing **87.45 %** of the
log-likelihood gain of a free additive PL of exactly **59 parameters** (28 drivers + 31
cells) over 68 entries. Additivity: **`tau_interaction` 0.1139 pp** over 72 driver×cell
cells, 67 multi-race, **1** BLUP beyond 2 posterior SE (max |z| 2.115), against
`tau_driver` 0.2646 and `sigma_resid` 0.3851. The applied widening stays
`MODE2_CF_INTERACTION_PCT = 0.10`.


### 12.3 Where the build differs from this contract

Every item below was measured and reported rather than tuned into agreement, per §0.4.

**Numbers that differ from a section above.**

| § | contract | as built | why |
|---|---|---|---|
| §1.3 | 56 races | **52** | 56 race sessions carry simulable rows; four (2024 R23, 2025 R6, 2026 R5, 2026 R9, 11 rows between them) have fewer than `MODE2_MIN_CARS_IN_RACE` usable cars and are dropped whole. 56 is sessions *loaded*, 52 is sessions *modelled*. The page now reads this from `mode2_fit_run.n_sessions` rather than a literal — see §12.4. |
| §1.6 | `sigma_resid` 0.418, `tau_slope` 0.348 | **0.385, 0.358** | the REML criterion is optimised through the exact reduced 91×91 system to \|grad\|∞ < 3e-6 rather than the 125-iteration Nelder-Mead §2.1 describes. `tau_driver`, `tau_car`, `sd_ratio` and the whole §2.4 table reproduce within 0.01. |
| §1.7 | `tau_interaction` 0.099, 0 of 72 BLUPs beyond 2 SE | **0.114, 1 of 72** (max \|z\| 2.115) | a larger τ shrinks the cell BLUPs less. The conclusion the counterfactual rests on — interaction of order 0.1 pp, ~40 % of the driver spread — is unchanged. |
| §3.3 | filtered fit 2,622 rows | **2,563** | the filter exactly as §3.3 writes it (`laps >= 8`, `0 < deg_std_err < 0.15`) returns 2,563 on the live DB, and lands on §3.3's *fourth* table row exactly. The 2,622-row row is not reachable from any filter we could find. The refusal is unaffected and holds with headroom. |
| §3.3 | moment test 0.00764 vs 0.00788, χ² 18.9, p 0.874 | **0.00579 vs 0.00567, χ² 26.4/27, p 0.494** | same verdict, different arithmetic: each stint is adjusted for its car-season and its session×compound before the per-driver weighted mean. Unadjusted, the test becomes a test of who raced where and returns p = 0.000, which would contradict the refusal. |
| §4.1 | λ ≈ 1.38, ~90 % of a free fit | **1.4494, 87.45 %** | the free comparator is the 59-parameter additive PL fitted with L-BFGS-B and a 1e-6 ridge; λ is a 1-D maximum-likelihood fit on the same orders. The parameter count and the shape of the claim reproduce; the two figures are a little high. |
| §4.3 | 2025 per-driver replay table | does not reproduce | our 2025 replay conserves the season total (2,638 vs 2,640 actual), `sd_ratio` 1.013, MAE 22.7, corr 0.973 — i.e. it matches the §4.1 calibration table the gate checks — while §4.3's illustration is compressed at the top in a way we cannot reconcile with `sd_ratio` 1.009. **Copy must be sourced from `mode2_career_season`, never from §4.3's numbers.** |
| §5.2 | 2–6 significant slopes | **7** | the DDL rule was kept (\|z\| > 1.645, implemented as `slope_lo`/`slope_hi` not straddling zero, so the flag and the band can never disagree). At \|z\| > 2 it is 6. §5.2's own table already contains 5 at \|z\| > 2 against its prose claim of 2, and its multiplicity sentence is written at α = 0.05 while its grey-out rule is written at 90 %. |
| §5.3 | season hazards 1.771 / 2.081 / 3.699 | **1.846 / 1.929 / 3.514** | every *per-team* figure §5.3 names reproduces exactly (aston_martin/2026 14 in 1,214; cadillac/2026 11 in 1,216; williams/2024 11 in 2,305; williams/2025 8 in 2,551) and the raw totals leave no room for interpretation. **Consequence for copy: 2026 is 1.90× 2024, not "more than double".** |

**Contract details resolved in the build.**

- **§2.2 contradicts §2.4 about `sd_total`.** §2.2's formula (`sd_within² + sd_island² + MODE2_SIGMA_SPEC²`) cannot produce §2.4's own table. Stored: `sd_total = hypot(sd_within, sd_island)` and `frac_floating = sd_island²/sd_total²`, which reproduce the table and the §1.8 copy; `MODE2_SIGMA_SPEC` is added in quadrature when the *level* interval is published, as §2.3 requires.
- **§7.6 `test_island_intervals_are_widest` is not satisfiable as literally written** on the spec's own measured numbers — §2.4 puts doohan (5 races) inside the top four and says so in words. Implemented as: among drivers with at least the median number of modelled races the four islands hold the four widest `sd_total`, **and** every island's `sd_island` exceeds 1.5× the largest connected-component `sd_island`, **and** every island's `frac_floating` > 0.90. A negative control that shrinks island errors 4× confirms the gate still fires.
- **§7.6 `test_band_narrows_at_switch`** fails in its raw-pp form for 2 of 13 transitions, because `tau_driver` is itself re-estimated on each cumulative window. Asserted as a ratio to the season cohort median instead; §3.5's named case (Hamilton's Mercedes→Ferrari, ratio 0.78) narrows by more than 10 %, and no island band ever narrows.
- **§7.6 `test_cf_widening_is_not_double_counted`** mixes pp² and points² as written; asserted on the pace scale where the identity is meaningful, plus a points-scale bound.
- **`load_rows` does not filter `sim_driver_params` by `assumption_set_id`.** The table is keyed `(session_id, driver_id)` with no assumption set in the PK, so it cannot hold two competing versions of a row; filtering by one set silently drops whole races. The union is exactly the 1,124 / 983 / 930 of §1.3; the largest single-set view misses two 2024 races. `assumption_set_id` is still the stamp on everything Mode 2 *writes*, and the input sets present are logged every run.
- **The retirement hazard's driver component measured out at exactly zero** (tau_driver 0.000 from four different starts). `hazard_car_only` therefore differs from the raw rate by *pooling*, not by removing an estimated driver effect. **No caption may say we subtracted the driver's crashes**; the honest line, which is what ships, is that we looked for a driver component and could not find one.
- **A Jeffreys interval does not contain the point estimate at zero retirements** (one such row: 0.0 with a band starting at 0.00068). Correct Bayesian behaviour under §5.3's mandated Beta(k+½, n−k+½); the page renders "0 retirements" without a point outside its own band.
- **Temperature is not resampled in the outer draws**, though §4.3 lists it. `title._run_rounds` takes one scalar temperature per θ matrix, and a per-draw temperature would mean forking v1.2's Monte Carlo, which §9.1 freezes. δ, γ and the bridge slope are resampled. The omission is conservative against the replay-MAE floor applied on top.
- **The p10/p90 column names hold the 5th and 95th percentiles** (§0.4's 90 % interval). Every surface labels them "5th–95th"; nothing says "P10–P90".
- **`n_scenarios_skipped` has no schema slot.** `analytics_status.mode2_counterfactual` is `'ok'` when nothing was skipped and `'partial'` when something was. Nothing was: 31 cells × 28 drivers = 868, under `MODE2_CF_MAX_SCENARIOS = 900`.
- **§9.3's WP6 gate line `grep -rn "echarts" web/components/ | grep -v EChart.tsx  # MUST be empty` cannot pass** and could not before v1.3: eleven pre-existing charts carry `import type { EChartsOption } from "echarts"`, erased at compile time. The check that holds, and that was run, is the runtime-import form `grep -rn '^import [^t]' web/components/ | grep echarts | grep -v EChart.tsx` — empty.
- **§5.1 and §8.5/§9.1 contradict each other about `Nav.tsx`** (two entries vs one). Resolved in favour of §8.5: exactly one entry, "Constructors" → `/constructor`. The was-it-the-car route is reached from the season page's own section list, as §8.5 requires — see §12.4.
- **Two constants live in `decomp.py` rather than `config.py`** and are therefore outside the §7.3 assumption hash: `_Z90` (a restatement of `MODE2_CI_LEVEL`, sets contrast band widths only) and the tyre filter / 0.15 rain fraction transcribed from §3.3 and §3.0. Neither affects a published estimate.
- **`mode2_driver_skill` has no slot for the richer rejection evidence.** The χ², the p-value, the session-by-session wet table and the 2,123 wet laps live only in the dicts returned by `tyre_rejection_report` / `wet_rejection_report` and in the run log. `C-SKILL-3`'s `{nStints}` comes from `n_obs`.

### 12.4 Fixed at integration

Fourteen things did not fit once the packages were put together. Each was fixed in the
file that owned the defect; the browser pass is what found five of them, because they were
invisible to `tsc`, to eslint and to the headless SVG harnesses, and a whole-suite pytest
run found three more that every file passed in isolation.

**Seams no package owned.**

1. **`tests/test_frames.py` asserted an exact table set and an exact constant set**, both
   of which §6.3 and §7.3 deliberately move. Added the twelve `mode2_*` names, and gave
   the twenty-one `MODE2_*` constants the same prefix-coverage assertion the `SIM_*` block
   already had, so the test still fails if one goes missing.
2. **`tests/test_mode2_schema.py` asserted every `mode2_*` table was EMPTY** — true of
   WP1's stub, false from WP2 onward. Inverted to assert every table the step owns was
   written, which is the assertion worth keeping.
3. **`/season/[year]/was-it-the-car` was reachable only by typing the URL.** §8.5 says it
   is reached from the season page's own section list; `season/[year]/page.tsx` belonged
   to no package. Added one `<Section title="Was it the car?">` between the constructors
   standings and the title odds.
4. **`SkillPanel` hard-coded "930 … across 56 races".** 56 is wrong (§12.3) and a literal
   would go stale at the next ingest. Threaded `FitMeta` into the component; the line is
   now counted from `mode2_fit_run`.
5. **§8.5 slot 1 asks for `<RatingBar rows=[this driver + component peers]>` and no query
   returned peers**, so the driver page drew a single bar with no context. Added
   `getComponentPeers(driverId)` to `web/lib/queries/mode2.ts` — one component, ordered by
   `rank_in_component`, so it can never return a grid-wide ordering — and a `peers` prop on
   `RatingSlot`. The separator stays off because one component is on screen by construction.
6. **`C-DEV-1`'s "{nSignificant} of {nCarSeasons}" counted only the seasons one team
   raced.** For a single-season team such as Cadillac the denominator read 11 instead of
   31. Added `getAllCarRatings()` and used it on both constructor routes; it also replaced
   an N-round-trip `Promise.all` over seasons on the index page.

12. **`pytest tests/ -q` could not be green in a single pass, and the cause looked like
    twelve unrelated failures.** `tests/test_mode2_model.py`'s bit-identity test does two
    forced refits, each deleting the current `mode2_fit_run` row; every other `mode2_*`
    table cascades from `fit_id`. `test_mode2_skills.py` and `test_mode2_points.py` sort
    after it, so in a whole-suite run they failed against emptied tables while passing in
    isolation. Added a module teardown to `test_mode2_model.py` that restores the fit
    (~3 min once). The four v1.3 files plus `test_frames.py` now run **113 passed** in one
    pass, where the same set previously gave 14 failures.

13. **`test_stub_signatures_exist` still called the real estimators with a `None`
    connection.** WP1 wrote it when `fit_hazard` and `calibrate` were stubs that returned
    an empty frame from no connection; both read the database now. The column contract is
    asserted against `frames` — where it actually lives — and the estimators are exercised
    against live rows in the skills and points suites.

14. **`test_mode2_step_runs_and_writes_four_status_keys` reported 60 of 62 sessions.**
    Not a defect: `tests/test_ingest_cli.py` re-ingests 2024 R5 and R13 into the live
    database, and an ingest clears that session's `analytics_status`. It is the §7.4
    ordering rule — ingest everything, then recompute the companion once — showing up
    inside the test suite. Re-running the mode2 step restores all 62.

**Found by the browser pass.**

7. **`RatingBar` clipped every bar and interval left of zero.** Three of its four series
   are `custom`, whose first data dimension is the *category index*, not a value — so
   ECharts sized the value axis from 0..rows.length−1. A fast driver's rating is negative
   and its interval is the point of the chart (FD2), so both were being cropped. Added an
   exported `valueExtent(rows)` and set the axis explicitly.
8. **`RatingHistory` flooded its entire plot with the interval band.** Same cause: the band
   is a `custom` series drawn from one dummy datum, so it reported nothing to the axis and
   ECharts sized the axis from the level line alone — a band several times taller than the
   levels it surrounds was then drawn far outside the grid. Fixed the same way.
9. **The decomposition axis printed `-2.8693779770351435`.** The bound was taken straight
   from the data and passed through a formatter that did not round — false precision on
   the one chart whose subject is how *imprecise* the split is. Rounded the extent out to
   a tenth of a pp and the labels to two decimals.
10. **`/constructor/[slug]` labelled all three of a team's seasons "Ferrari".** The bars
    are one team across seasons, so the label is now `"Ferrari 2024"` — §5.2 forbids
    reading these bars across seasons, which makes the year the load-bearing part.
11. **`/season/2023/was-it-the-car` answered 200** while `/season/2023` answered 404, and
    rendered the fit-wide spread tiles — 2024–2026 numbers — under a 2023 heading. §0.3
    forbids exactly that reading. The sub-route now 404s for any season with no data, like
    its parent.

**One thing left unfixed, deliberately: the assumption sets are not aligned.**

`assumptions.snapshot()` collects every UPPER_CASE name in `config.py`, so the twenty-one
`MODE2_*` constants moved the assumption hash when v1.3 landed — correctly, per §7.3. The
current set is **532**; every season was ingested under **254**, and three 2024 sessions
(R5 sprint, R5 race, R13) were re-ingested at 532 by `tests/test_ingest_cli.py`, which
ingests into the live database. So 2024 now holds two assumption sets, its season page
shows the *assumption sets differ between races* badge, and
`tests/test_full_seasons.py::test_seasons_row[2024]` fails on exactly that flag —
`(24, 24, 24, True, True)` against an expected `False`.

**This is a data-state defect, not a code defect, and the remedy is an operator decision.**
RUNBOOK §4 already prescribes it: a `--force` re-ingest of all three seasons
(`make ingest-all ARGS="--force"`, ~12 min), followed by `--recompute-companion` and
`--recompute-mode2 FORCE=1`. It was not run here because it rewrites the provenance of all
76 sessions in the user's live database and was not part of the integration brief. Nothing
in v1.3 depends on it: `decomp.load_rows` deliberately does not filter `sim_driver_params`
by assumption set (§12.3), so the model sees all 983 rows either way, and the union is
exactly §1.3's numbers. The single failing test and the 2024 badge are the whole visible
surface of it.

**One addition, not a fix.** `DecompositionBar` now carries a `title.subtext` naming the
two halves, the blur and the hatch. A crop of the plot alone previously showed two coloured
segments with no way to tell which was the car and a hatched bar with no way to tell that
hatching means assumed — the caption that said so lived outside the image. §8.4's grammar
has to survive being screenshotted without its page.

### 12.5 The screenshot test

The brief for integration was that a screenshot of `/season/[year]/was-it-the-car` be
honest with no surrounding context. As shipped:

- The lede (`C-WITC-1`) is above every chart, and the two "we cannot separate the car from
  the driver" panels are above the decomposition, not below it.
- The car:driver comparison is rendered only ever as an **SD ratio** — "3.3×", with its
  2.4×–5.0× band and its seconds translation. `grep -rn "11x\|11×\|eleven times" web/`
  is empty; the variance ratio appears nowhere.
- McLaren's and Aston Martin's bars are hatched end to end, each sits under a full-width
  rule reading "Not comparable to the drivers above", and the chart's own subtext says
  what hatching means — so a crop that includes an island bar carries its own caveat.
- No floating driver's level is rendered as a numeral anywhere: the tile, the skill card
  and the who-drove-it table all show a hatched "level not measured" chip instead.
- The counterfactual control opens empty, by design — "the pairing you see first is the one
  you are most likely to quote" — and for a `by-analogy` pairing the card renders the range
  as the headline and **no** point estimate, no delta, and no incumbent total.

What a crop still cannot carry: the decomposition chart shows no *legend* mapping each
team's colour to its car, and the "How much of it is the car?" tiles are a separate section
from the chart, so a crop of the tiles alone gives the 3.3× ratio without the four-component
caveat that qualifies it. Both are noted rather than fixed; the ratio tile does carry its
own 5th–95th band and a "groups we cannot compare across: 4" tile beside it.

### 12.6 The v1.3 fix package

One package, applied after the v1.3 review. Every item below was reproduced before it
was changed and re-reproduced after. Where a stored number moved, the cause is named.

#### 12.6.0 The reported `--force` `UniqueViolation` — NOT REPRODUCED

The package brief carried a known defect: `ingest --recompute-companion mode2 --force`
crashing with

    psycopg.errors.UniqueViolation: duplicate key ... "mode2_fit_run_version_idx"
    Key (assumption_set_id, model_version)=(532, c6a942ae376774dc) already exists

with the diagnosis that the content-addressed `model_version` is reproduced by a forced
refit of unchanged inputs and the `INSERT` then collides with the live run, and with the
instruction to repair it the way v1.1 repaired winprob: upsert on the natural key.

**That repair is already in the code and the crash does not reproduce.** `_write_rating`
(`f1lab/decomp.py`) runs, in ONE transaction and in this order: `DELETE FROM
mode2_fit_run WHERE assumption_set_id = %s AND model_version = %s`, then `UPDATE
mode2_fit_run SET is_current = false WHERE assumption_set_id = %s AND is_current`, then
the `INSERT ... RETURNING fit_id` — which is the §6.6 lifecycle and is exactly the
proposed fix. It is also the only `INSERT INTO mode2_fit_run` in `f1lab/`.

The literal entry point was run against the live database with fit 34 current at version
`c6a942ae376774dc` — the precise stated precondition:

    .venv/bin/python -m f1lab.ingest --recompute-companion mode2 --force
    -> exit 0, 161 s, fit_id 41, version c6a942ae376774dc (unchanged),
       {mode2_fit_run: 1, mode2_component: 4, mode2_driver_rating: 28,
        mode2_driver_rating_history: 79, mode2_driver_contrast: 378,
        mode2_row_audit: 983}, skills 112, car 31/31, points 3/68/868

No exception, no duplicate row, `is_current` re-flagged onto the new fit. The reported
traceback was therefore raised by an older build or an unrelated frame; nothing was
changed in response to it, because a defensive upsert bolted onto a writer that already
upserts changes no behaviour and hides the fact that the real cause was never located.

What WAS added is the missing guard, so the claim cannot go stale again:
`test_forced_refit_upserts_on_the_natural_key` (`tests/test_mode2_model.py`). It fails
against the source bug and against the live constraint independently. First it asserts
`mode2_fit_run_version_idx` is still `UNIQUE (assumption_set_id, model_version)` and
then commits the source bug on purpose inside a `SAVEPOINT` — re-`INSERT`ing the live
run's own columns without the natural-key `DELETE` — and requires
`psycopg.errors.UniqueViolation`. If a future migration drops that index, this half
fails loudly rather than leaving the second half green for the wrong reason. Then it
drives the real writer with `force=True` and requires: no exception, exactly one row at
`(asid, model_version)`, and exactly one `is_current` row for the assumption set, which
is the row just written.

#### 12.6.1 What the data lost, and why — the percentile that was not identified

`mode2_driver_skill.pct_field_below` is now **NULL for every `floating` driver**, on both
measured skills (8 of 56 measured rows). It was `96.3` for Norris on race pace and grid
pace alike, `3.7`/`14.8` for Stroll, and it was rendered as "· ahead of 96 % of the
field" on the same card whose headline numeral had just been replaced by a hatched
"level not measured" chip.

The number was not merely uncertain. "% of the field below" is an ordinal placement of a
driver's **level** against all 28, and the 28 span four disconnected components (§1.4).
For the K3 and K4 drivers that level is the pooling prior's, not the window's — §1.5
item 1 lists it as not identified — so the percentile is a point estimate of a quantity
the data contain zero information about. Its instability is measurable on Norris's own
stored band: the same 5th–95th interval maps to field percentiles of 100.0 % at
`rating_lo` and 33.3 % at `rating_hi`, and the shipped card printed the midpoint of that
with no interval at all.

Three things were deliberately *not* done, because the review's stronger readings do not
survive the spec as written:

- `pct_field_below` was **not** removed. §6.1's own DDL declares it and §3.2 asks for the
  annotation on both bars; for the 24 component-anchored drivers it is sanctioned and it
  still ships unchanged (min 0.0, max 100.0 within each skill).
- It was **not** re-scoped to the driver's own component. That is a different statistic,
  it would be meaningless over a two-driver island, and §3.2 does not ask for it — a spec
  change, not a defect repair.
- §6.1's "no grid-wide rank column" bullet was **not** treated as breached. It bans a
  rank column; a continuous percentile on measured drivers is not that column.

`_pct_field_below` now takes the driver's `anchor_class` and returns `None` for
`floating`, so the claim is unrepresentable in the database rather than filtered in
TypeScript — the refused skills already store NULL there, and the column is nullable in
§6.2. `SkillPanel.tsx` carries the render-side half of the same rule (`!floating &&`),
so the chip cannot be contradicted by the line under it even if a future writer forgets.
New gate: `test_pct_field_below_is_null_for_every_floating_driver`
(`tests/test_mode2_skills.py`); the existing percentage test now scopes itself to
`anchor_class <> 'floating'` and still measures 0.0/100.0 on both skills.

#### 12.6.2 Every car band is now wider, by design (2026-09-14)

§2.3 says `MODE2_SIGMA_SPEC = 0.10` pp goes on every published **level** — "driver
rating, car rating", named. The driver level got it, through `_publish_interval`'s
`hypot(sd_total, MODE2_SIGMA_SPEC)` rescaling. `_car_rating_frame` built `gamma_lo` /
`gamma_hi` from `sqrt(diag(fit.cov))` alone, so every car band on `/constructor` and in
`CarPaceBars` was the raw posterior SD under a "5th–95th percentile" label.

`gamma_lo` / `gamma_hi` now use `hypot(g_sd, MODE2_SIGMA_SPEC)`. **This moved a stored,
measured number, and the cause is the missing §2.3 term, not a failing test.** Measured,
before and after, on the same fit:

| | 2024 ferrari implied SD | 2024 mclaren | same-season car pairs drawn apart |
|---|---|---|---|
| shipped v1.3 | 0.19207 | 0.23632 | **79** of 145 |
| with §2.3 | 0.21654 | 0.25660 | **72** of 145 |

Seven pairs that the page drew as separated are, under the spec's own uncertainty
accounting, overlapping; bands are 11–13 % wider. The undercount also reached
`/season/[year]/was-it-the-car`, which back-computes `carSe` from these stored bounds
(`page.tsx:76`) and feeds it to `DecompositionBar`'s fuzzy boundary — that boundary is
now correspondingly wider, from the same one-line cause.

`slope_lo` / `slope_hi` were left alone on purpose. A development slope is a **contrast**
between two points on one car's own curve, §2.3 puts `MODE2_SIGMA_SPEC_CONTRAST` there
rather than the level term, and widening it would silently move `slope_significant` —
which is a claim about findings, not about band width. New gate:
`test_car_rating_bands_carry_the_specification_term` (`tests/test_mode2_model.py`)
asserts no car band's implied SD is below the specification term alone.

**Known residual, not fixed:** the car level still takes its width from the analytic
`diag(cov)` while the driver level takes it from §2.3's parametric bootstrap. Adding the
specification term closes the gap the label promised; it does not give car bands the
bootstrap's shape or its τ-uncertainty component. That is a §2.3 modelling question, not
a rendering defect, and it is left for the spec owner.

#### 12.6.3 `interval_direction_ok` no longer fails closed on a thin island driver

The §2.6 gate takes the widest `sd_total` among drivers with at least the median
`n_races` and compares that set to the island set. The island set was built over the
**whole** table and the comparison set over the **median-filtered** one, so a floating
driver who fell below the median left the left-hand side while staying on the right: the
two sides were sized differently, the equality could not hold at all, and `_fit_run_row`
raised `SimNotEstimable("interval direction check failed")` — aborting the companion
step and therefore the ingest — on data whose identifiability had not changed.

Reproduced on the live fit (median `n_races` = 36): the gate returned `True`, and
returned `False` after setting Stroll's `n_races` to 3 with his `sd_total` untouched at
0.1859, still tied-widest on the grid. Norris at 20 races (half a season missed) failed
the same way, and so did adding a fifth floating driver with the widest band of all — a
mid-season McLaren or Aston replacement would have made the gate fail by maximally
*confirming* the property it tests.

The median cut exists to drop badly-**sampled** drivers (Doohan, 5 races, `sd_total`
0.208) from the comparison, and that rationale never applied to a badly-**identified**
one. Floating drivers are now kept in the comparison set unconditionally:
`seen = rating[(rating["n_races"] >= cut) | floating]`. All three scenarios now return
`True`; nothing about the shipped fit changed (`interval_dir_ok` is still true on fit 42).
New case: `test_interval_direction_gate_survives_a_low_race_island_driver`, alongside the
existing inverted-band negative control, which still fires.

#### 12.6.4 `/constructor` no longer prints one car's caveat over the whole field

The Constructors landing page reused the per-team `<CarPaceSection>` with
`teamName={`the ${year} field`}` and no `islandDrivers`. `CarPaceSection` picks its focus
row as `rows.find(r => r.year === season)`, and on the index **every** row has that year,
so the focus was simply the season's P1 car. For 2024 and 2025 that is McLaren, whose
basis is `by-analogy`, so the island block fired with its placeholders unfilled:

> For the 2024 field we cannot separate the car from the driver. this team's drivers
> never changed team between 2024 and 2026… That assumption, not the 2024 field's
> results, is what decides the number. What is measured: the gap between the 2024
> field's own two drivers…

and under it "2024 CAR RATING / level not measured / −1.236 % to −0.459 %" and "RANK IN
2024 / —" — McLaren's interval and McLaren's caveat, with no team named anywhere in the
tile row. On 2026 the same tile showed Mercedes's −1.770 % labelled "2026 car rating".

§8.5 gives the index a season switcher, `<CarPaceBars>`, `<DevelopmentSegments>` and a
caption — no StatTile row and no island note. `CarPaceSection` gained a `showFocus` prop
(default `true`, so the per-team page is unchanged) and the index passes `false`: the
tiles and the island block are gone, the bars and the caption stay. Every bar already
carries its own hatching and its own chip, which is the per-car statement §8.4 wants on
a page that shows ten cars at once.

#### 12.6.5 The car-adjusted career card — three separate claims it could not support

**(a) The average-driver total on a by-analogy card.** §8.4 rule 5 suppresses the point
estimate on a `by-analogy` row; the driver's own bar honoured it ("somewhere between 348
and 462 points") and the second bar did not ("314 pts (203–420)"). That total is a pure
function of the McLaren or Aston car level — the one quantity a floating island contains
no information about — so it was the least-supported number on the card and the only
crisp one. It now takes the same range-only branch. 12 rows affected (Norris, Piastri,
Alonso, Stroll × 3 seasons). The file's own header comment had claimed this behaviour
since integration.

**(b) The contribution headline had no interval.** `getCareerAdjusted` selected
`contributionLo` / `contributionHi` and `CareerSeasonRow` carried them; nothing read
them. The card printed "−20.9 points of driver contribution" for Hamilton 2024 against a
stored band of −88.8 to +47.6 — a quantity whose **sign** the model does not resolve —
and every other number in the same card carried its band, so the omission read as
confidence. FD2 is explicit that this is a bug, not a simplification. The headline is now
the band, with the point estimate muted beneath it, and when the band straddles zero the
card says so in words instead of showing a sign it cannot support.

**(c) A two-race stand-in replayed as a champion.** `entry_pace` labelled an entry with
its MODAL cell while `gamma` is the races-weighted blend of every cell, and the replay
runs the whole `rounds_in_season` calendar regardless of how much of it the seat covered.
Bearman's 2024 entry is two rows — one Ferrari, one Haas — so the label was an arbitrary
tie-break to `ferrari`, the number behind it was a 50/50 Ferrari+Haas blend, and the card
read "2024 ferrari — This driver, replayed in this car: 106 pts (53–171) … Actually
scored: 7 points." Nothing on it said how many races he started (three). The same shape
applied to Colapinto 2024 (8 vs 5), Doohan 2024 (7 vs 0) and Lawson 2024 (22 vs 4).

Two facts that the stored row could not express were added to `mode2_career_season`
(migration `0004_career_seat.sql`, §6.2 and `frames.EXPECTED_COLUMNS` updated,
`--check-schema` exits 0):

| column | meaning |
|---|---|
| `starts` | race starts that season, from `results` — a FACT, out of `rounds_in_season` |
| `teams` | every car of the seat, most-driven first — `"ferrari, haas"` when split |

`CHECK (starts > 0)`. `starts` comes from `results`, deliberately NOT from the fit's own
row count: 2024 Norris started all 24 races and 19 of them survive the §1.3 filter, so a
modelled count printed against a 24-round calendar would read as five races missed. The
modelled count is the floor only if `results` somehow has no row for a driver who is in
the fit. The migration is additive and touches no table outside the `mode2_`
prefix (§6.7), but it **deletes the existing rows** before adding two `NOT NULL` columns:
neither fact is derivable from the stored row, the table is a derived artifact with no
children, and inventing a default would have read as a real season length. The
`--recompute-companion mode2 --force` that follows rebuilds all 68 rows.

`entry_pace`'s modal-cell tie-break was also made deterministic (count descending, then
cell name ascending). `share.idxmax()` broke a 1–1 tie on row order, which a `--force`
re-ingest can change — a live §6.6 bit-identity hazard, latent only because Bearman's tie
happened to land on `ferrari` either way.

The card now names every car of the seat, appends "· N of M rounds" whenever the seat is
short of the calendar, and for a seat covering **less than half** its season withholds
the comparison entirely: a "part season, not replayed" chip, one sentence saying the
replay runs the whole calendar so there is no full-season total that belongs beside the
real one, and the actual points kept as the fact §4.2 says it is. On the live fit that is six
entries: Bearman 2024 (3 of 24, "ferrari, haas"), Colapinto 2024 (9 of 24), Doohan 2024
and 2025 (1 of 24, 6 of 24), Lawson 2024 (6 of 24) and Tsunoda 2026 (3 of 14). Everyone
else is unchanged except for the rounds annotation, which appears only when the seat is
short of its calendar.
The threshold lives in `CareerAdjusted.tsx` as `MIN_SEASON_SHARE = 0.5`; it is a
rendering rule, and it is deliberately NOT a `MODE2_` constant, because those enter the
§6.6 model hash and a presentation threshold has no business changing a fit's identity.

#### 12.6.6 C-HISTORY-1's second sentence was false against the shipped chart

The §8.7 verbatim caption under the rating-over-time chart read: "For a driver who has
never moved, the band stays the same width no matter how many races he runs — more
racing, no more knowledge." The chart it captions is drawn from
`mode2_driver_rating_history`, and every island driver's 5th–95th width grows
monotonically across the three cumulative points: Norris +28.7 %, Alonso +35.2 %,
Stroll +25.2 %, Piastri +23.5 %. The control behaves as §3.5 predicts (Hamilton, who
switched, narrows 0.575 → 0.550 → 0.512), which makes the island wedge conspicuous rather
than lost in noise. §12.3 recorded only the weaker check that was implemented ("no island
band ever narrows") and never noted that the stronger claim had become false.

The direction is conservative — a wider band is the honest one, and the cause is `tau_driver`
being re-estimated on each cumulative window — so the model was not touched. The sentence
now says what the picture does:

> For a driver who has never moved, more racing brings no more knowledge: his band never
> narrows, and it widens as each extra season teaches the model how far apart drivers
> really are.

**Deviation recorded, not resolved:** this string is §8.7-verbatim and §8.7 is outside
this package's ownership. `docs/MODE2_SPEC.md` §8.7 (C-HISTORY-1) and §3.5's "the band
stays flat and wide across all three seasons" both still carry the old claim and should
be amended by the spec owner to match this component and the stored history.

#### 12.6.7 Determinism, proved end to end after the package

`--recompute-companion mode2 --force` was run twice in succession against the live
database with every change above in place. Both runs exited 0; the content-addressed
`model_version` was reproduced unchanged, which is the exact precondition under which
the reported `UniqueViolation` was supposed to fire.

    run 1 -> exit 0, fit_id 44, model_version c6a942ae376774dc
    run 2 -> exit 0, fit_id 45, model_version c6a942ae376774dc

Digest (`output/fix/digest.py`): every one of the twelve `mode2_*` tables of the current
fit, every column except `fit_id`, `assumption_set_id`, `fitted_at` and the two
wall-clock instrumentation columns, rows sorted by content so Postgres physical order
cannot enter, floats rounded at 12 places.

| table | rows | per-table digest |
|---|---|---|
| `mode2_car_hazard` | 31 | `98ec8fb1b110` |
| `mode2_car_rating` | 31 | `4817cc9e04db` |
| `mode2_career_season` | 68 | `af9cf3e797c9` |
| `mode2_component` | 4 | `110ce820bf06` |
| `mode2_counterfactual` | 868 | `aace565d9146` |
| `mode2_driver_contrast` | 378 | `614f4ccf2c30` |
| `mode2_driver_rating` | 28 | `246e345509ba` |
| `mode2_driver_rating_history` | 79 | `8083d731a677` |
| `mode2_driver_skill` | 112 | `063c9d7e8252` |
| `mode2_fit_run` | 1 | `f46c7119f20e` |
| `mode2_points_calib` | 3 | `38c8c44592a0` |
| `mode2_row_audit` | 983 | `f18802120c7f` |

    DIGEST 50161b0d51abd87a103a1accb1c5addfac608716cea1dcd5e2c85aff38488e27

Byte-identical across both runs, over all 2 586 stored rows: two consecutive forced
refits of an unchanged window agree to the last bit and are a no-op on every estimate.
An earlier pair (fits 42/43, before `starts` was re-sourced from `results`) was likewise
byte-identical; only `mode2_career_season`'s digest moved between the pairs, which is
exactly the one table that change touches.

#### 12.6.8 Reported, examined, and deliberately NOT changed

- **`pct_field_below` for the 24 component-anchored drivers.** Two of the three review
  write-ups asked for the column to be removed or re-scoped per component on the grounds
  that §6.1 makes a grid-wide rank "physically unrepresentable". §6.1's own DDL declares
  `pct_field_below` and §3.2 asks for the annotation on both bars, so for a measured
  driver it ships as specified. The defect was the four island rows, and only those.
- **`§6.1`'s "no grid-wide rank column" bullet.** Not treated as breached, for the same
  reason: it bans a rank column, and a percentile over identified levels is not one.
- **Scaling the replay to the rounds a part-season driver actually started.** The replay
  is defined over the whole calendar for every seat (§4.2's "the difference between them
  is the driver and nothing else" depends on it), so scaling it would change what the
  quantity means. The card withholds the comparison instead and keeps the fact.
- **`slope_lo` / `slope_hi` and `slope_significant`.** See §12.6.2.
- **The island bands' widening itself.** §12.6.6 corrects the caption, not the model.

#### 12.6.9 Verification

    web: rm -rf .next && npm run typecheck && npm run lint && npm run build && npm test
         -> clean; 8 routes; 57/57 tests
    .venv/bin/pytest -q -m "not db"                       -> 128 passed, 270 deselected
    .venv/bin/pytest -q tests/test_mode2_model.py tests/test_mode2_schema.py \
                        tests/test_mode2_skills.py tests/test_mode2_points.py \
                        tests/test_frames.py             -> 117 passed in 251 s, one pass
    .venv/bin/python -m f1lab.ingest --check-schema        -> exit 0

After that whole-suite pass — which itself forces two refits — the digest of §12.6.7 was
recomputed and is unchanged (fit 50, `50161b0d…`): a third independent reproduction.

Each finding's own reproduce step was re-run against a production `next start` and the
live fit:

| reproduce | before | after |
|---|---|---|
| `curl /driver/NOR \| grep -o 'ahead of [0-9]* % of the field'` | 2 hits (96 %) | 0 hits |
| `curl /driver/VER \| grep -o 'ahead of …'` | 100 % | 100 % (unchanged) |
| `pct_field_below` on `anchor_class='floating'` | 96.3 / 3.7 / 14.8 … | NULL × 8 |
| same-season car pairs drawn apart | 79 of 145 | 72 of 145 |
| `interval_direction_ok` with Stroll at 3 races | `False` | `True` |
| `curl '/constructor?season=2024' \| grep -c 'cannot separate'` | 1 | 0 |
| `curl '/constructor?season=2024' \| grep -c '2024 car rating'` | 1 | 0 |
| `/constructor/mclaren?season=2024` island note | present | present (unchanged) |
| `/driver/NOR` average-driver line | `314 pts (203–420)` | `somewhere between 203 and 420 points` |
| `/driver/HAM` 2024 contribution | `−20.9 points` | `−88.8 to +47.6 … we cannot tell whether he added or cost points` |
| `/driver/BEA` 2024 | `2024 ferrari … 106 pts (53–171)` | `2024 ferrari, haas · 3 of 24 rounds … part season, not replayed` |
| C-HISTORY-1 second sentence | "the band stays the same width" | "his band never narrows, and it widens…" |
