# GAPFILL_SPEC — F1 Analytics v1.8

**Two gaps, both cases of data the app already holds and does not use.**

- **Gap A** — Mode 2's one-lap skill is a grid-position surrogate. 77 verified qualifying
  sessions / 1,567 driver-sessions now make the thing itself measurable.
- **Gap B** — the *shape* of a brake application was never specified. `brake` ships as a
  boolean array on 1,518 laps and nothing reads its trailing edge.

This document is the final specification. It is synthesised from three proposals
(`output/gapfill_proposal_{statistics,detector,integration}-first.md`) and three adversarial
judge reviews that re-derived every load-bearing number against the live `f1-postgres`
container. Where the judges found an error, the error is fixed here and the fix is recorded
in §8. Where a judge found something unmeasurable, it is refused here — a documented refusal
is a shipped outcome in this project and has happened twice before (`MODE2_SPEC §3.3`
tyre management, §3.4 wet).

## Outline

| § | Contents |
|---|---|
| 0 | Scope, fixed decisions, and what each gap can and cannot support |
| 1 | Gap A — the model: response, specification, identifiability, MEASURED results |
| 2 | Gap A — migration, the surrogate's fate, exact MODE2_SPEC amendments |
| 3 | Gap B — the definition, its resolution limit, its refusal rule |
| 4 | Gap B — schema and pipeline |
| 5 | Surfaces, with VERBATIM captions and what each must not claim |
| 6 | Work packages: single-owner file ownership, sequencing, verification |
| 7 | Risks (top five) with mitigations |
| 8 | Decisions log |
| 9 | As built *(empty until the release lands)* |

---

# 0. Scope, fixed decisions, and what each gap can support

## 0.1 Fixed decisions (the short version)

| # | Decision |
|---|---|
| D1 | Gap A ships a **new measured skill `one_lap_pace`**, fitted on **segment 1 only, session-mean-centred percent**, `kind = 'Q'`, dry rows only. |
| D2 | **`grid_pace` is kept, unchanged, unrenamed, and not retired.** `QUALI_SPEC §5.1.1` pre-registered retirement at `corr >= 0.95`; measured **0.8393** (all 28) / **0.8663** (ex-island 24). Threshold not met. |
| D3 | **Sprint qualifying is excluded** from the fit and reported as a `measured = false` row (`sprint_one_lap`) in the `§3.6` panel. |
| D4 | `one_lap_pace` and `race_pace` **may share a pp axis**; `grid_pace` may not, ever. `pct_field_below` is **not** comparable across the two pp skills. |
| D5 | Gap B ships **three direct readings on `lap_corner_speeds`** — `brake_release_m`, `brake_release_to_apex_m`, `brake_on_distance_m` — plus one **unrendered diagnostic**, `trail_duty`. |
| D6 | Gap B **refuses** the taper, the normalised `trail_frac`, the late-loss fraction, any driver-versus-driver brake-shape comparison, and any `mode2_driver_skill` row. Refusals are rendered, not omitted. |
| D7 | No stored measured number may change silently. `mode2_row_audit` stays pinned at **983 rows**; every pre-existing `lap_corner_speeds` column is snapshot-diffed across the re-derive with **zero** rows permitted to differ. |
| D8 | Every new fan-facing caption is **verbatim in §5** and pinned byte-for-byte by a caption test. No caption contains a driver name, a rank, or a number that the next ingest can move. |

## 0.2 What Gap A can support

**Can:** a continuous, circuit-free, directly measured one-lap rating for 28 drivers,
on the same percent-of-field-mean scale as race pace, with a posterior SE per driver and
the same anchor-class honesty badge race pace already carries.

**Cannot, and this is structural:**

- **It cannot break the islands.** A qualifying session carries the same
  `session_entries` as its own race. Qualifying adds **rows, not edges**: 28 drivers /
  31 car-cells / **72 edges / 4 components**, member-for-member identical to
  `MODE2_SPEC §1.4`, whether the mobility graph is built on race rows, on qualifying rows
  alone, or on their union. There are **zero qualifying-only edges**. Norris/Piastri and
  Alonso/Stroll remain floating pairs; more qualifying will never fix this — only a
  transfer will.
- **It cannot tell a cruise apart from being slow.** The response is the Q1 lap. On the
  **707 driver-sessions that set a time in both segment 1 and segment 3**, the top-6
  drivers' margin over the same rivals is **−0.279 pp in Q1 against −0.490 pp in Q3** —
  **43 % smaller in Q1**. A driver whose car will walk into Q3 is measured on the lap he
  did not need. §1.1 says why the response is chosen anyway and §1.6 prices the
  alternative that would fix it.
- **It does not buy precision.** Measured: median `evidence_share` **0.813** on
  `grid_pace` against **0.6216** on `one_lap_pace`; median posterior SE as a share of the
  fitted span **8.9 %** against **12.8 %**. *The refit buys validity, not precision.* Any
  release note calling the new skill "more confident" is wrong.
- **It carries no per-row standard error.** Race pace feeds a stage-1 `s_rd` in as a known
  heteroskedastic floor. A qualifying best lap is a single extremum, not an average, so
  `s_sd = 0` for every row and `σ_ε` absorbs it. This is a real difference from `§1.3` and
  it is why the τ_driver of the two skills are not exactly like-for-like (§5.1, C-SKILL-5).

## 0.3 What Gap B can support

**Can:** for one stored lap at one corner, **where the brake came off**, read directly off
the boolean channel's trailing edge, and its distance to the apex. This is a reading, not a
model, so it is compatible with `TELEMETRY_SPEC §4.3`.

**Cannot, and this is the whole of §3.4's refusal:**

- **It cannot measure pressure, taper or modulation.** A boolean cannot distinguish a
  driver feathering 5 bar for 40 m past turn-in from one still at 80 bar. Both read `true`.
- **It cannot support a driver rating, or a driver-versus-driver comparison at a corner.**
  Measured on the only experiment this corpus can run — the same driver, same car, same
  circuit, two qualifying sessions of one sprint weekend — the de-meaned same-driver repeat
  correlation is **0.286** for `brake_release_to_apex_m` and **0.001** for the taper, against
  a between-driver SD of ~15 m. Roughly **70–80 % of the cross-driver spread at a corner does
  not repeat for the same driver.**
- **The binding constraint is replication, not the channel and not the sampling.**
  `lap_telemetry` stores exactly one lap per driver per session (`selection = 'fastest'`,
  DDL-pinned, 0 duplicate `(session_id, driver_id)` pairs). A corner therefore has one draw
  of a quantity whose lap-to-lap SD is as large as its driver-to-driver SD. The fix is
  storing 2–3 representative laps per driver per session — a `TELEMETRY_SPEC` change, named
  here as the pre-condition for any future trail-braking skill and **explicitly not proposed
  for v1.8**.
- **Scope is qualifying.** Telemetry coverage is 60/71 Q, 14/18 SQ, **1/71 R**. Every
  brake-shape surface is a qualifying surface and says so.

---

# 1. Gap A — the model

## 1.1 The response

**Ships:** one row per **driver-session**, on the **first segment only** (Q1), centred within
the session exactly as `MODE2_SPEC §1.2` centres within the race.

    y_sd = 100 · (best_s[d, s, seg=1] − m_s) / m_s        [pp — percent of the session's Q1 field mean]
    m_s  = arithmetic mean of best_s over drivers with a segment-1 time in session s

Negative is faster. Source rows: `quali_segment_times` where
`segment = 1 AND verified AND best_s IS NOT NULL AND NOT wet_compound`, `sessions.kind = 'Q'`,
sessions with `>= MODE2_QUALI_MIN_DRIVERS (8)` such drivers, driver present in the race-pace
fit's component map (same rule as `fit_grid_pace`).

**Why percent and not seconds — the Monaco/Spa rule.** `MODE2_SPEC §1.2` settled this for race
pace: within-session percent centring absorbs the circuit, the date and the conditions *exactly*,
which is why no circuit term appears in `§1.3`. A tenth at Monaco is 0.14 pp; a tenth at Spa is
0.09 pp; the model never sees a second. Qualifying inherits it unchanged.

**Why segment 1 and not the driver's best lap — six candidate responses, all fitted** with the
same `decomp._CrossedDesign` / `_fit_crossed` engine, dry rows only, 28 drivers:

| # | response | rows | sess | τ_driver | τ_car | σ_ε | τ_car/τ_driver | corr(race_pace) |
|---|---|---|---|---|---|---|---|---|
| **V3** | **segment 1, session-centred pct (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **3.50** | **0.773** |
| V2 | all segments, session×segment centred | 2,556 | 57 | 0.143 | 0.506 | 0.487 | 3.54 | 0.761 |
| V4 | deepest segment reached, centred in it | 559 | 57 | 0.233 | 0.226 | 0.722 | 0.97 | 0.592 |
| V5 | deepest lap, **chained** onto the Q1 scale | 1,135 | 56 | 0.233 | 0.633 | 0.607 | 2.72 | — |
| V1 | `gap_to_pole_common_pct` (pre-registered) | 1,146 | 57 | 0.126 | 0.605 | 0.667 | 4.80 | 0.637 |
| — | `grid_pace` today (normal score) | 1,265 | 62 | 0.4562 | 0.4963 | 0.6388 | 1.09 | 0.80 |

**Finding 1 — segments 2 and 3 are a sample selected *on the response*, and a spec that both
centres locally and drops rows breaks its own scale.** Only the fast half reaches Q2 and only ten
drivers reach Q3, so a Q3 row compares a driver to a truncated, faster field. V4 is that effect
in pure form: τ_car collapses to 0.226 and Hülkenberg and Hamilton, who scrape into Q3, come out
among the *slowest*.

A "deepest segment, centred in that segment's full field" variant (kept here because a rival
proposal shipped it) is worse than it looks and was measured: it retains one row per
driver-session but centres it on the **full** field of that `(session, segment)`, and because the
retained subset of each stratum is chosen by the outcome, the retained rows have a **non-zero
stratum mean — +0.767 pp for Q1-eliminated rows, +0.477 pp for Q2-eliminated, 0.000 pp by
construction for Q3 rows**. The model has driver and car terms and **no stratum term**, so a
0.767 pp offset — 4.4× τ_driver — is absorbed into δ and γ. Removing the three offsets drops
τ_driver from 0.176 to **0.072** and raises the car:driver ratio from 2.71 to **4.32**. The
elimination stage a driver reaches is an ordinal signal, and that construction re-imports it into
the very skill that exists to escape an ordinal surrogate. **Rejected.**

> **New rule, written into `MODE2_SPEC §1.2` (§2.3):** within-stratum centring absorbs a
> per-stratum constant *exactly* only if **every row of that stratum is retained**. If a
> specification retains an outcome-selected subset, it must either keep the whole stratum or
> chain onto a common reference — **never both centre locally and drop rows.**

**Finding 2 — the correct repair exists, was built, and costs more than it pays.** V5 measures
the track-evolution offset per session on the drivers present in *both* consecutive segments
(within-driver medians o₂ **−0.486 pp**, o₃ **−0.691 pp**; an independent rebuild gives −0.472 /
−0.238) and chains each driver's best lap back onto the Q1 reference. This is selection-free and
scale-clean. It raises σ_ε to **0.607 pp** and widens every posterior SE by **~50 %**
(Verstappen ±0.083 → ±0.124). The extra laps are the noisy ones. `corr(V5, V3) = 0.825`.
**V5 is named here as the alternative and kept in the spec**: it is the only construction that
answers the sandbagging objection without breaking the scale, and a future release with more
sessions may be able to afford it.

**Finding 3 — segment 1 kills `§5.1.1`'s own stated degradation.** §5.1.1 flagged "missingness
becomes non-random — a Q1 crash produces no time at all". MEASURED: **1,560 of 1,567
driver-sessions have a segment-1 time (99.55 %)**. On a deepest-segment response, missingness is
100 % for every driver eliminated in Q1, by definition.

**Why not the pre-registered `gap_to_pole_common_pct` (V1).** It is referenced to *one lap by one
driver*, so pole's own noise enters every row; refitting on the stored `gap_to_best_pct` moves
τ_driver 0.151 → 0.122 and τ_car 0.543 → **0.676** — pole's noise reappearing as car variance. It
also selects the deepest **common** segment, re-importing the selection above, and measures worst
on every axis. `QUALI_SPEC §4.1` built it as a **display** number for one session, and it is a
good one; it is not a response. The deviation from the pre-registration is written, not silent
(§2.3).

## 1.2 The cost of the response, measured and not hidden

The Q1-only response is the one the sandbagging objection attacks, and it is quantified rather
than captioned away. On the **707 driver-sessions that set a time in both segment 1 and segment
3** — the same drivers, the same sessions, nothing confounded:

| | top-6 drivers' mean `y` | everyone else in that Q3 field | **margin** |
|---|---|---|---|
| their **segment-1** lap | −0.551 pp | −0.272 pp | **−0.279 pp** |
| their **segment-3** lap | −0.215 pp | +0.275 pp | **−0.490 pp** |

The same drivers' advantage over the same rivals is **43 % smaller in Q1 than in Q3**. The
shipped skill is therefore **attenuated at the front of the grid by a factor this spec knows and
publishes**. It is shipped anyway because the alternatives either break the scale (V4 and the
deepest-segment variant above) or cost 50 % of the precision (V5), and because an attenuated
measurement of the right quantity beats an unattenuated measurement of a different one. Caption
`C-SKILL-5` carries this to the reader.

## 1.3 The specification

    y_sd  =  δ_d  +  γ_{c(d,s)}  +  ε_sd

    δ_d   driver one-lap effect, pooled:      δ_d ~ N(0, τ_δ²)
    γ_c   car level, per (team, season) cell: γ_c ~ N(0, τ_γ²)
    ε_sd  residual:                           ε_sd ~ N(0, σ_ε²)

Identical engine, identical cell definition (`team_id | year`), identical pooling discipline to
`MODE2_SPEC §1.3`. **No development slope** — `§3.5` already rules out a per-season driver
rating, and `§3.2` fits without one too. Every inclusion constant enters the assumption hash in
`config.py`. Excluded rows are written to the **new** `mode2_quali_row_audit` table with a
reason, exactly as `§1.3`'s are written to `mode2_row_audit` (which stays pinned at 983 rows —
§2.2, D7).

## 1.4 Identifiability — the island answer, stated plainly

The mobility graph was rebuilt three ways with `decomp.build_components`: on race rows, on
**qualifying rows alone**, and on their union.

    28 drivers · 31 car-cells · 72 edges  ->  EXACTLY 4 CONNECTED COMPONENTS, all three times,
    member-for-member identical.  ZERO qualifying-only edges.

| Component | Drivers | Cells | Identical to `MODE2_SPEC §1.4`? |
|---|---|---|---|
| K1 main grid | 15 (albon, antonelli, bearman, bortoleto, colapinto, doohan, gasly, hamilton, hulkenberg, kevin_magnussen, leclerc, ocon, russell, sainz, sargeant) | 17 | **yes, member-for-member** |
| K2 Red Bull family | 9 (arvid_lindblad, bottas, hadjar, lawson, max_verstappen, perez, ricciardo, tsunoda, zhou) | 8 | **yes** |
| K3 Aston Martin | 2 (alonso, stroll) | 3 | **yes** |
| K4 McLaren | 2 (norris, piastri) | 3 | **yes** |

**The islands survive, and it is arithmetic, not luck.** A qualifying session carries the same
`session_entries` as its own race, so qualifying adds **rows, not edges**. Identification comes
from drivers changing team, and nobody changed team between Saturday and Sunday. The corpus
tripled the observation count and moved the component count by **zero**. More qualifying sessions
will never fix this. Only a transfer will.

**What a one-lap rating may therefore claim — exactly what race pace may claim, no more:**

- **Within K3 and K4 only contrasts are measured.** The skill can say Norris is 0.103 pp of a lap
  quicker than Piastri over 56 sessions. It **cannot** say where either sits on the grid: adding
  a constant to both McLaren drivers and subtracting it from all three McLaren cars leaves every
  stored qualifying time unchanged.
- `pct_field_below` is **NULL** for norris, piastri, alonso, stroll. The existing
  `_pct_field_below` guard applies unchanged.
- `anchor_class` is **not re-derived**. `recompute_skills` overwrites the skill frame's badge
  with the rating table's and `one_lap_pace` goes through the same assignment. The badge is
  graph-derived, so it is identical on all three measured surfaces — which is exactly why `§2.4`
  chose `anchor_class` over `evidence_share` as the badge.

**On `evidence_share`, and this is a correction.** `§2.4` warns that the four island drivers score
a flattering **0.724** on the grid model purely because its τ_γ/τ_δ ratio is ≈1.1. On
`one_lap_pace` the ratio is 3.50 and the islands land at **0.501/0.502** — the four lowest values
among drivers with a full season. This is **not** `evidence_share` behaving better; it is the fit
being *correctly less confident* about the islands, which is `§2.4`'s prediction confirmed, not
repealed. §2.3's amendment to `§2.4` says so in those words. The badge stays `anchor_class`.

**Thin data.** `n_obs < MODE2_QUALI_THIN_N (25)` for six drivers — doohan 6, sargeant 10,
arvid_lindblad 14, ricciardo 16, kevin_magnussen 20, zhou 20 — carrying `§5.1.1`'s thin-data flag.
Note that a thin-data SE and a floating-island SE can print the *same number* (both sargeant at
n_obs = 10 and norris at n_obs = 56 sit at 0.113, the shrinkage ceiling τ_δ = 0.1605) **for
entirely different reasons**. The panel must never show the two in one undifferentiated column:
the thin-data flag and the `floating` badge are separate, and both are rendered (§5.1).

## 1.5 MEASURED — the fit that ships

Engine: `decomp._CrossedDesign` + `_fit_crossed` (REML, Nelder–Mead, two passes) — the same code
path as race pace and grid pace. Fit time **0.2 s**; nothing material against `§7.7`'s run-end
budget.

    1,135 rows / 56 qualifying sessions / 28 drivers
    tau_driver 0.1605 pp   tau_car 0.5620 pp   sigma_eps 0.3846 pp   converged = True
    response SD 0.655 pp   tau_car/tau_driver = 3.50   (race pace 3.31, grid pace 1.09)

| | δ̂ (pp) | 90 % | SE | ev_share | n_obs | anchor_class |
|---|---|---|---|---|---|---|
| max_verstappen | **−0.337** | −0.474 … −0.200 | 0.083 | 0.731 | 55 | component-anchored |
| sainz | −0.127 | −0.270 … +0.016 | 0.087 | 0.707 | 54 | anchored |
| russell | −0.118 | −0.273 … +0.037 | 0.094 | 0.656 | 56 | component-anchored |
| hadjar | −0.115 | −0.272 … +0.042 | 0.096 | 0.646 | 31 | anchored |
| norris | −0.110 | −0.297 … +0.076 | 0.113 | 0.502 | 56 | **floating** |
| leclerc | −0.103 | −0.246 … +0.041 | 0.087 | 0.704 | 56 | component-anchored |
| gasly | −0.074 | −0.216 … +0.067 | 0.086 | 0.712 | 56 | component-anchored |
| alonso | −0.058 | −0.245 … +0.128 | 0.113 | 0.501 | 56 | **floating** |
| … | | | | | | |
| piastri | −0.007 | −0.193 … +0.179 | 0.113 | 0.502 | 56 | **floating** |
| doohan | +0.001 | −0.198 … +0.199 | 0.121 | 0.435 | **6** | component-anchored, **thin** |
| ocon | +0.124 | −0.025 … +0.274 | 0.091 | 0.679 | 55 | anchored |
| stroll | +0.203 | +0.017 … +0.390 | 0.113 | 0.501 | 53 | **floating** |
| sargeant | +0.224 | +0.038 … +0.411 | 0.113 | 0.501 | **10** | component-anchored, **thin** |
| zhou | +0.319 | +0.129 … +0.508 | 0.115 | 0.484 | 20 | component-anchored, **thin** |

Verstappen is the only driver whose 90 % interval clears zero on the fast side; Stroll, Sargeant
and Zhou are the only three clearing it on the slow side. **Twenty-four of twenty-eight
qualifying ratings cross zero.** That is the honest shape of this feature and §5.1 renders it
rather than hiding it.

**The refit buys validity, not precision.** Measured against the surrogate it replaces:
median `evidence_share` **0.813** (grid) against **0.6216** (quali); median posterior SE as a
share of the fitted span **8.9 %** against **12.8 %**. More data did not solve a structural
problem — it replaced a proxy with a measurement and the measurement is *less* certain. Release
notes and captions must not call the new skill "more confident".

## 1.6 The pre-registered retirement decision — MEASURED, and `grid_pace` survives

**Mandatory gate before any comparison is computed** (this is a gate, not a courtesy): refit
`grid_pace` from `decomp.GRID_SQL` and assert `r = 1.000` against the **stored**
`mode2_driver_skill` rows. Verified: the refit reproduces `§3.2` exactly at
**τ_δ 0.4562 / τ_γ 0.4963 / σ_ε 0.6388 on 1,265 rows**, and agrees with the stored rows at
r = 1.000. The comparison below is therefore against what actually ships, not against a
re-derivation that may have drifted.

| pair | Pearson | Spearman |
|---|---|---|
| **one_lap_pace vs grid_pace — all 28** | **0.8393** | **0.8637** |
| **one_lap_pace vs grid_pace — ex-island 24** | **0.8663** | **0.8835** |
| one_lap_pace vs race_pace | 0.7727 | — |
| grid_pace vs race_pace | 0.80 (`§3.2`) | — |

`QUALI_SPEC §5.1.1` pre-registered **r ≥ 0.95 retires `grid_pace`**. **r = 0.839 < 0.95, so both
skills ship.** The pre-registration did its job: the threshold was asserted before the number
existed, and the number is recorded whatever it is.

**The correlation is reported both ways, and this is new.** Four of the 28 drivers (norris,
piastri, alonso, stroll) have levels set by shrinkage toward each fit's own prior rather than by
data, so an all-28 correlation is **14 % a comparison of two priors**. The decision does not flip
(0.8393 and 0.8663 are both far below 0.95), but a statistic that governs a retirement must not be
part prior without saying so. **Both numbers are stored on `mode2_fit_run` and both are printed
in the run log.** Gate G3 (§6) fails the build if *either* crosses 0.95, so retirement stays a
human decision requiring a spec edit.

`§5.1.1` gate 2 prints `corr(one_lap_pace, race_pace)` on the page whatever it is and adds an
"overlapping things" sentence above 0.90. **0.7727 is below that**, so the sentence is not
triggered — but 60 % shared variance is most of an axis, and `C-SKILL-6` says so anyway. Note it
is *lower* than `grid_pace`'s 0.80: the surrogate was more like race pace than the measurement is.

## 1.7 The shared axis — `§3.2`'s prohibition is lifted for the new skill only

`§3.2` forbids plotting grid pace beside race pace because a normal score is an ordinal
compression: "the ordinal scale caps how far apart cars can get, which is why τ_car/τ_driver is
≈1.1 here and ≈3.3 for race pace."

**That objection does not apply to `one_lap_pace`.** Both responses are percent of a lap, centred
within a session on the field actually present. τ_car/τ_driver is **3.50 here against 3.31 for
race pace** — the compression is gone, measured.

**Decision.** `race_pace` and `one_lap_pace` may share one numeric axis, labelled
`pp — percent of a lap, relative to the session's own field`, as two bars. **`grid_pace` keeps
its own axis and its own panel row and never joins them.** Four conditions, all test-enforced:

1. Never summed, averaged, or reduced to an overall rating. A radar stays banned (`§3.6`).
2. `pct_field_below` is **not** comparable across the two — the field spreads differ
   (τ_car 0.562 quali against 0.874 race) — so each bar keeps its own annotation and the two
   percentages are never subtracted.
3. **No cross-scale arithmetic with `grid_pace`, in numbers, ever.** `QUALI_SPEC §5.1.1`
   licenses saying *in words* that the difference between the two bars is the grid penalties and
   the pit-lane starts. It does not license a per-driver "what the penalties were worth": that is
   a subtraction of a normal score from a percentage, and at r = 0.839 the disagreement also
   contains the Q1-cruise attenuation (§1.2), the wet and sprint exclusions, non-random
   missingness and noise. The page says it in words and prints no such number.
4. A shared axis is a shared *scale*, not a shared *claim*. A driver 0.2 pp better in qualifying
   than in the race has not been shown to be a qualifying specialist; with 24 of 28 intervals
   crossing zero almost no such difference is resolvable. `C-SKILL-7` says this.

**The one comparative fact the page may state, and its limit.** The car:driver spread ratio is
**3.50 in qualifying against 3.31 in the race** — i.e. one-lap performance is, if anything,
*slightly more* car-dominated than race pace, and markedly more so than the surrogate's 1.09
suggested. Any claim in the other direction ("drivers are closer together over one lap") is
**forbidden**: it is an artefact of a broken construction. Every scale-clean construction fitted
returns a ratio between 3.0 and 3.6 (V5 chained 2.72–3.02, all-segments 3.54–3.58, V3 3.50); only
the outcome-selected variant rejected in §1.1 returns 2.71, and it does so because unabsorbed
stratum offsets inflate τ_driver. The comparison also carries one caveat that must not be dropped:
race pace has a per-row stage-1 SE as a known floor and this fit does not (§0.2), so part of any
τ_δ difference is modelling, not drivers.

## 1.8 Sprint qualifying — excluded, and the exclusion is measured

Fitted three ways on the segment-1 response:

| fit | rows | sess | τ_driver | τ_car | σ_ε | Verstappen SE | Doohan SE |
|---|---|---|---|---|---|---|---|
| **Q only (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **0.083** | **0.121** |
| Q + SQ pooled | 1,480 | 73 | 0.1689 | 0.6127 | 0.4861 | 0.090 | 0.129 |
| SQ only | 345 | 17 | 0.0760 | 0.7742 | 0.7235 | — | — |

**Adding 345 sprint-qualifying rows makes every driver's estimate *less* precise.** σ_ε rises
0.385 → 0.486 pp and posterior SEs widen both absolutely (Verstappen ±0.083 → ±0.090) and
relatively (SE/τ_δ 0.517 → 0.533). SQ1 fitted alone is τ_car/τ_driver = **10.2** — a single-run,
green-track, limited-practice session that is almost pure car. `corr(Q-only, SQ-only) = 0.605`;
`corr(pooled, Q-only) = 0.967`, so pooling changes the ranking barely while costing precision.

**Decision: `one_lap_pace` is fitted on `kind = 'Q'` only. Sprint qualifying is neither pooled in
nor given its own skill.** A skill whose τ_driver is 0.076 against τ_car 0.774 would be a car
rating with a driver's name on it, and 17 sessions is not a corpus — the same grounds on which
`§3.3` refuses tyre management. **It ships as a `measured = false` row, key `sprint_one_lap`, in
the `§3.6` "What we could not measure" panel**, reusing the existing refusal machinery rather
than inventing a surface. Excluded rows are also written to `mode2_quali_row_audit`
(`reason = 'sprint_qualifying_excluded'`) so the panel reads its own reason from the database
rather than from a hard-coded string. `QUALI_SPEC §5.2` ("sprint qualifying is first-class") is
amended in §2.3: it stays first-class *as a session surface* and is out of *this one fit*.

---

# 2. Gap A — migration and the surrogate's fate

## 2.1 What happens to the stored `grid_pace` rows

**They are kept, unchanged, under the same key, with the same unit, the same 28 rows and the same
caption slot. Nothing is relabelled, nothing is deleted, nothing is refitted.**

The case against each rejected alternative, stated so it is not re-litigated:

- **Relabel `grid_pace` → `one_lap_pace`** — dishonest, and the database would carry the lie. The
  stored numbers are normal scores of *starting position*; they count a five-place gearbox penalty
  as driver slowness. Renaming the key would put `unit = 'normal_score'` under a caption about lap
  times.
- **Delete the rows** — destroys a measured thing. `§5.1.1` pre-registered the only condition
  under which deletion is honest (`r ≥ 0.95`, "the same axis measured worse"). Measured
  **0.8393 / 0.8663**. The condition did not fire.
- **Keep both** — what ships. The two skills answer different questions, and the unshared variance
  is a *product*: driver by driver, the disagreement contains the grid penalties, the pit-lane
  starts and the sprint-weekend grids that `one_lap_pace` excludes. **The page says this in words
  and prints no per-driver number for it** (§1.7 condition 3): the two live on different scales,
  and the disagreement also contains the Q1-cruise attenuation, the wet/sprint exclusions and
  noise. No subtraction, no "what the penalties were worth" column.

The observed `r` is **stored, not just printed**: `mode2_fit_run` gains
`corr_one_lap_grid`, `corr_one_lap_grid_ex_islands` and `corr_one_lap_race`, written by the fit,
so the retirement decision is auditable from the database in every later release.

**Net effect on stored rows: `mode2_driver_skill` goes 112 → 196** (7 keys × 28 drivers).
**No existing row changes value.** WP-A4 asserts exactly that.

## 2.2 Schema changes — migration 0009

`db/migrations/0009_one_lap_pace.sql` + `web/drizzle/0009_one_lap_pace.sql` (hand-transcribed per
`§6.4`'s three traps). All additive, all reversible.

```sql
-- 1. The skill vocabulary. This CHECK is why a migration is mandatory at all.
--    Every key listed here IS written by this release. No key is added speculatively.
ALTER TABLE mode2_driver_skill DROP CONSTRAINT mode2_driver_skill_skill_check;
ALTER TABLE mode2_driver_skill ADD CONSTRAINT mode2_driver_skill_skill_check
  CHECK (skill IN ('race_pace','one_lap_pace','grid_pace',
                   'tyre_management','wet','sprint_one_lap','trail_braking'));

-- 2. The pre-registered decision numbers, stored rather than remembered.
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_grid            double precision;
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_grid_ex_islands double precision;
ALTER TABLE mode2_fit_run ADD COLUMN corr_one_lap_race            double precision;

-- 3. The qualifying row audit. A NEW table, deliberately not mode2_row_audit.
CREATE TABLE mode2_quali_row_audit (
  fit_id            integer NOT NULL REFERENCES mode2_fit_run(fit_id) ON DELETE CASCADE,
  assumption_set_id integer NOT NULL,
  session_id        integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text    NOT NULL,
  year              integer NOT NULL,
  round             integer NOT NULL,
  kind              text    NOT NULL,
  included          boolean NOT NULL,
  exclude_reason    text,
  y_pp              double precision,
  best_s            double precision,
  PRIMARY KEY (fit_id, session_id, driver_id),
  CONSTRAINT mode2_quali_row_audit_reason_check CHECK (included OR exclude_reason IS NOT NULL)
);
CREATE INDEX mode2_quali_row_audit_driver_idx
  ON mode2_quali_row_audit (fit_id, driver_id, year, round);
```

**`sprint_one_lap` and `trail_braking` are written as real `measured = false` rows for all 28
drivers**, exactly as `tyre_management` and `wet` already are. A CHECK key that is never written
is a task disguised as a decision and is forbidden here (§8, DL-11).

**Why a new audit table rather than rows in `mode2_row_audit`.** Its `laps_fit` and `badge`
columns are race-pace vocabulary and `NOT NULL`; its `y_pp` is a fuel-corrected race response and
mixing two responses in one column is precisely the drift this spec exists to prevent; and
`tests/test_quali_integration.py` pins `mode2_row_audit = 983` as its proof that v1.6 moved no
race analytics. **That constant must still read 983 after v1.8**, and with a separate table it
does.

**Rollback:** drop the table, drop the three columns, restore the four-value CHECK after
`DELETE FROM mode2_driver_skill WHERE skill IN ('one_lap_pace','sprint_one_lap','trail_braking')`.
No other table is touched.

## 2.3 Spec amendments — written, not implied

Each is a diff against a named section. All are mandatory: the sentences become false the day
0009 lands.

| Spec | Section | Amendment |
|---|---|---|
| MODE2 | §1.2 | **New rule (§1.1):** within-stratum centring absorbs a per-stratum constant exactly *only* if every row of that stratum is retained. A specification that retains an outcome-selected subset must keep the whole stratum or chain onto a common reference — never both centre locally and drop rows. Measured cost of breaking it: 0.767 pp of unabsorbed offset against a 0.176 pp τ_driver. |
| MODE2 | §1.4 | Add the qualifying-only mobility graph (28 / 31 / 72 / **4 components**, member-identical on race rows, quali rows and their union, zero quali-only edges) and the sentence: a qualifying session carries the same `session_entries` as its race, so it adds rows, not edges. |
| MODE2 | §1.5 item 1 | Extend "the level of any driver in K3 or K4" to state that this now holds on **three** measured skills, and that adding a fourth response would not change it either. |
| MODE2 | **§2.4 `evidence_share` warning box** | **Amend, do not repeal.** Add: on `one_lap_pace` (τ_γ/τ_δ = 3.50) the islands land at 0.501/0.502, the *lowest* among full-season drivers. This is the fit being **correctly less confident** about them, i.e. §2.4's prediction confirmed — *not* `evidence_share` behaving better and *not* a licence to use it. The badge remains `anchor_class` precisely because it does not move between the two fits. |
| MODE2 | §3.0 correction 1 | The surrogate has been **joined**, not replaced; the forward pointer becomes a backward pointer to §3.2b. |
| MODE2 | **§3.2 heading + status note** | "**v1.8 status:** still fitted on `grid_position`, still ships, still never called one-lap pace. It is no longer the *only* one-lap axis — §3.2b is. `corr` between the two is **0.8393** (0.8670 excluding the four island drivers), below the 0.95 the retirement was pre-registered at, so both ship." |
| MODE2 | §3.2 "we cannot subtract it" bullet | Rewrite: the contamination is now *visible* as the disagreement between two shipped skills rather than performed inside one — **in words only**; the difference is not computable as a number across two scales. |
| MODE2 | **NEW §3.2b "One-lap pace — SHIPS, and it is a lap time"** | The whole of §1: response, why segment 1, the six candidate fits, the rejected outcome-selected construction, the sandbagging cost, the specification, the measured fit, the sprint exclusion. |
| MODE2 | §3.3/§3.4 refusal pattern | Unchanged; two new siblings follow it — `sprint_one_lap` (§1.8) and `trail_braking` (§3.4). |
| MODE2 | §3.6 panel | Becomes **seven rows**: three measured (race pace, qualifying pace, starting-grid pace) and four refused (tyre management, wet weather, sprint qualifying, trail braking). The panel's own copy must not hard-code a count that the next refusal moves — it renders `count(*)` from the table. |
| MODE2 | §6.2 DDL, §6.3 `frames.TABLE_COLUMNS`, §6.5 status keys | `skill` CHECK gains three keys; `mode2_fit_run` gains three columns; `mode2_quali_row_audit` added; status keys unchanged. |
| MODE2 | §7.2 / §7.3 / §7.7 | `fit_one_lap_pace` added; six constants added; **+0.2 s** measured against the run-end budget. |
| MODE2 | §8.7 captions | `C-SKILL-2` **amended in place** (it is and remains the starting-grid-pace caption — its ID is never reassigned to another skill); `C-SKILL-5`, `C-SKILL-6`, `C-SKILL-7`, `C-SKILL-8` added (§5.1). |
| QUALI | §5.1.1 | Mark **executed**, record the deviation (response is segment-1 session-centred percent, not `gap_to_pole_common_pct`) with the six-fit table as the reason, and record the observed r both ways. |
| QUALI | §5.2 | Boundary added: sprint qualifying stays first-class *as a session surface* and is excluded from the `one_lap_pace` fit, with §1.8's measurement as the reason. |
| QUALI | §4.1 | One line: `gap_to_pole_common_pct` is a display number for one session; it was measured as a modelling response (V1) and rejected. |

## 2.4 The integration map — every touch point, named

**Python — `f1lab/`**

| File | Change |
|---|---|
| `decomp.py` | new `QUALI_SQL`; new `fit_one_lap_pace(conn, asid, components)` beside `fit_grid_pace` (~L723); `recompute_skills` (~L1570) gains the new frame in the `pd.concat`, the same `anchor_class` overwrite, the `sprint_one_lap` + `trail_braking` refusal frames, and writes `mode2_quali_row_audit` and the three `corr_*` columns; **`fit_grid_pace`'s docstring line "There are no qualifying sessions in this schema (§3.0), so the only one-lap signal is where the car started" is deleted and replaced** — it is factually false as of v1.6 |
| `frames.py` | `TABLE_COLUMNS["mode2_quali_row_audit"]`; three new `lap_corner_speeds` columns (§4) |
| `config.py` | `MODE2_QUALI_SEGMENT = 1`, `MODE2_QUALI_MIN_DRIVERS = 8`, `MODE2_QUALI_KINDS = ("Q",)`, `MODE2_QUALI_REML_START = (0.16, 0.56, 0.38)`, `MODE2_QUALI_THIN_N = 25`, `MODE2_GRID_RETIRE_R = 0.95` — **all enter the assumption hash** via `assumptions.snapshot()` |
| `db/migrations/0009_one_lap_pace.sql` | §2.2 |

**Web — `web/`**

| File | Change |
|---|---|
| `db/schema/mode2.ts` (L209) | CHECK gains three keys; `mode2FitRun` gains three columns; new `mode2QualiRowAudit` |
| `drizzle/0009_one_lap_pace.sql` + `meta/0009_snapshot.json` | hand-transcribed |
| `lib/queries/mode2.ts` (L61, L353) | `SkillRow["skill"]` union gains the three keys; `SKILL_ORDER` becomes `["race_pace","one_lap_pace","grid_pace","tyre_management","wet","sprint_one_lap","trail_braking"]`; `getFitMeta` returns the three `corr_*` values |
| `components/driver/SkillPanel.tsx` | `SKILL_LABEL` / `SKILL_VERDICT_LINE` gain the keys; **the file's own header comment ("Two measured skills and two refusals… race pace and grid pace are on separate axes") is now false and is rewritten**; shared-axis rendering for the two `pp` skills (§1.7); thin-data flag and `floating` badge rendered as **two separate marks** (§1.4) |
| `lib/ask/schema-doc.txt` (L82) | the prose after `ask.mode2_driver_skill` names the seven keys and their units |
| `components/ask/pageLinks.ts` (L37) | **unchanged — verified, listed so nobody "fixes" it** |
| `scripts/sql/0005_ask_views.sql` | `ask.mode2_driver_skill` unchanged; **new** `ask.mode2_quali_row_audit` view, added to the grant list (~L1040) |
| `lib/ask/ask-objects.json` | regenerated |
| `ask_answer_cache` | invalidated on the 0009 apply, per `QUALI_SPEC §5.3.3` |

**Tests that pin a skill name, count or unit — every one, and what it becomes**

| Test | Today | After |
|---|---|---|
| `tests/test_mode2_skills.py` L27 `SKILLS` | 4-tuple | 7-tuple, `one_lap_pace` second |
| `…::test_every_driver_has_all_four_skills` | `set(got) == set(SKILLS)` | renamed `…_all_seven_skills` |
| `…::test_two_skills_measured_and_two_refused` | asserts 2 measured / 2 refused | **3 measured / 4 refused**; renamed |
| `…::test_grid_pace_is_never_called_one_lap_or_qualifying_pace` (L121) | **greps the whole of `decomp.py` for "qualifying pace" / "one-lap pace" and fails unless the line contains "never"** | **RELEASE-BLOCKING: this breaks the moment `fit_one_lap_pace` is written.** Narrow it to `inspect.getsource(fit_grid_pace)` plus the `grid_pace` string literals. **Add a mirror guard** asserting the new skill's rendered label is "Qualifying pace" and never "One-lap pace" — the fit is on Q1 alone, which is narrower than "one lap". The guard survives; its blast radius stops at the surrogate. |
| `…::test_grid_pace_is_not_on_the_same_scale_as_race_pace` | `{race_pace: pp, grid_pace: normal_score}` | `{race_pace: pp, one_lap_pace: pp, grid_pace: normal_score}` + a **new** assertion that `grid_pace` is the only measured skill whose unit is not `pp` |
| `…::test_grid_pace_reproduces_the_measured_fit` | refits | unchanged; **new sibling** `test_one_lap_pace_reproduces_the_measured_fit` pinning τ_δ 0.1605 / τ_γ 0.5620 / σ 0.3846 / 1,135 rows / 56 sessions |
| `…` island and `pct_field_below` tests | across measured skills | pass unchanged, and gain an explicit `one_lap_pace` case — this is §1.4's gate |
| `tests/test_mode2_schema.py` L126 | constraint-name list | add `mode2_quali_row_audit_reason_check` |
| `tests/test_frames.py` L48 | table-name list | add `mode2_quali_row_audit` |
| `tests/test_quali_integration.py` L63 | `mode2_driver_skill: 112` | **196**, commented with v1.8; **`mode2_row_audit: 983` must stay 983** — that is the no-drift proof |

**Does either gap force a recompute of anything already stored?** For Gap A, only
`mode2_driver_skill`, and only by *addition*. `recompute_skills` already does
`DELETE … WHERE fit_id = %s` then rewrites, so the 112 existing rows are rewritten
byte-identically from the same inputs; **WP-A4 snapshots them before and diffs after, with zero
rows permitted to differ**. `mode2_driver_rating`, `mode2_driver_contrast`, `mode2_car_rating`,
`mode2_counterfactual`, `mode2_row_audit` and every Mode 1/3 table are untouched. The new
`config.py` constants change the assumption hash, creating a new `assumption_set_id` and a new
`fit_id` — the intended, audited path (`§6.6`), not drift; the value-equality test runs **across**
the two fit ids.

---

# 3. Gap B — the definition, its resolution limit, its refusal rule

## 3.0 The integration finding that shapes everything below

`f1lab/telemetry.py::brake_zones` (L368) **already computes the release point**: it returns each
lap's debounced applications as `(onset_m, release_m)`. `corner_metrics` (L515) takes
`zones[zi][0]` and **throws `zones[zi][1]` away**. `brake_distance_m` is
`apex_distance_m − brake_point_m` — onset to **apex**, not onset to **release**.

Gap B therefore needs **no new pass over the arrays, no new debounce, no new model**: it needs
three extra keys in a dict `corner_metrics` already builds, from a tuple it already holds. That
is what keeps it inside `TELEMETRY_SPEC §4.3` ("nothing else is precomputed… applying a
fuel-burn model to a 10 Hz trace would dress an assumption up as a measurement").
**The release point is not a model. It is the distance at which the boolean went false.**

## 3.1 The definition

**Trail braking = brake carried past turn-in, toward the apex.** With a boolean channel the only
honest reading of "past turn-in, toward the apex" is *where the brake came off relative to the
apex*.

| stored | definition | reading | rendered? |
|---|---|---|---|
| `brake_release_m` | `zones[zi][1]`, the chord distance of the last `brake = true` sample of the **serving** zone, taken at the **midpoint of the bracketing sample step** | where the brake came off | no (feeds the two below) |
| `brake_release_to_apex_m` | `apex_distance_m − brake_release_m` | **the trail-braking number.** Smaller = brake carried closer to the apex. **Negative = still braking at the apex.** | **yes** |
| `brake_on_distance_m` | `brake_release_m − brake_point_m` | how long the brake was held | yes, secondary |
| `trail_duty` | distance-weighted share of `[brake_point_m, apex_distance_m]` with `brake = true`, in **[0, 1] by construction** | bounded companion | **no — diagnostic only** |

`brake_distance_m` (onset → apex) is unchanged. The new number is its missing half: today the
table says *where he started braking*; it will also say *where he stopped*.

**Why `trail_duty` is stored but never rendered.** The obvious edge-based release is *unbounded*
and it breaks on shared zones: measured on the raw edge definition, `trail_frac` came out **> 1
on 11 % of corner-laps and as high as 3.79**, and `release_to_apex` reached **−132 m**. A duty
cycle over `[onset, apex]` cannot leave [0, 1] and survives adversarial testing at shared zones
(only **12.8 %** of non-terminal shared corner-laps exceed 0.95, SD 0.194 against 0.179 at solo
zones). It is kept as the refusal-resistant diagnostic and the audit companion — and it is
**not** rendered, because its own repeat correlation is **0.198** (§3.3) and because
`corr(trail_duty, apex_speed_kph) = −0.595` makes it mostly a fact about the corner.

**MEASURED over all 20,330 braked corner-rows** (before §3.2's refusals):

    brake_release_to_apex_m   p05 -56.3 | p25 8.4 | median 22.0 | p75 55.6 | p95 153.4
    brake_on_distance_m       p05 32.6  | p25 68.0 | median 90.9 | p75 122.4 | p95 222.1
    14.3 % of braked corners have the brake still on AT the apex.

**MEASURED — face validity by circuit** (measurable rows only):

| circuit | n | median release-to-apex | still braking at the apex |
|---|---|---|---|
| Baku | 345 | **10.8 m** | 6.4 % |
| Monte Carlo | 172 | **12.1 m** | 16.3 % |
| Monaco | 309 | **13.9 m** | 14.6 % |
| Marina Bay | 354 | 19.9 m | 2.5 % |
| … | | | |
| São Paulo | 430 | 86.0 m | 6.0 % |
| Lusail | 529 | 89.9 m | 0.9 % |
| Suzuka | 352 | **123.0 m** | 12.8 % |

Street circuits and slow hairpins sit at the trail-braking end; Suzuka, Lusail and Barcelona sit
at the other. **Named corners:** Monaco T7 (Grand Hotel hairpin, median apex 67.5 km/h) median
release-to-apex **−40.5 m**; Monaco T18 (Rascasse, 60 km/h) **−58.3 m**; Monza T2 (Rettifilo
exit, 71 km/h) **+13.3 m**; Monza T6 (Lesmo 1, 199 km/h) **+28.6 m**. Nothing in the derivation
knows which circuit it is on.

**Named laps, cited so they can be re-checked** (detector-anchored cross-check, Monza Q 2026
`session 16041`, Monaco Q 2026 `session 16023`): Hamilton Monza T2, 313 → 71 km/h over 146.9 m,
34 samples — brake carried to the apex; Verstappen Monza T11 (Parabolica), 293 → 206 km/h over
64.1 m, 9 samples — hard, early, off the brake and rolled in; Sainz Monaco T18, 171 → 54 km/h
over 56.9 m, 18 samples — the deepest trail in the session, brake still on through the slowest
point; Antonelli Monaco T3, 268 → 157 km/h over 93.6 m, 13 samples — released long before the
low point. **Negative values are real, not errors.**

## 3.2 The resolution limit, and the refusal rule

**Correction to the brief, and to two of the three source proposals.** The brief's
"~9 m median, gaps up to ~74 m" is wrong in both directions and both corrections matter.

- **Lap-wide `max_sample_gap_m` is worse than stated: 54.78 m median, 89.72 m p95, 192.69 m
  worst.** Mean step 8.04 m. `TELEMETRY_SPEC` is amended to carry these figures (§4.5).
- **In-brake-zone sampling is far better than either figure**, because samples are uniform in
  **time** and a braking zone is the slowest part of a lap. MEASURED over 1,096 corner-laps on
  four 2026 Q sessions (Bahrain 15887, Monaco 15905, Spa 15919, Monza 15923): median-of-median
  in-zone step **4.94 m**, p95 **8.33 m**, median in-zone **max** step **16.25 m**, median **23
  samples** per `[brake_point, apex]` window, median span **126.4 m**.

**The resolution number is the bracketing step at the release edge itself** — not the window
median, and emphatically not the window maximum. That is the step across which the boolean
actually flips, and it is the only quantity that governs how well the release is located:

    MEASURED bracketing step at the brake-release edge:  3.89 m median | 10.0 m p90 | 12.21 m p95   (n = 739)

> **`brake_release_to_apex_m` is a ±4 m measurement at the median and ±12 m at the tail.** It is
> stored to 0.1 m and **displayed to the nearest 5 m**. **Two drivers within 10 m of each other
> at one corner have not been shown to differ** — and §3.3 says that even outside 10 m they very
> probably have not either. This is the braking-shape analogue of `C-TEL-2`'s "anything smaller
> than a tenth on this chart is alignment noise".

**Refusal rule — five gates. All store `NULL`, never 0**, following `§4.1`'s "absent is not zero"
and `C-TEL-6`'s "a blank braking point means the corner was taken flat".

| # | rule | constant | measured cost |
|---|---|---|---|
| R1 | **Corner taken flat** — `brake_point_m IS NULL`. A positive report, not a gap. | — | 4,633 of 24,963 rows (**18.6 %**) |
| R2 | **Non-terminal corner of a shared brake zone** | — | **~8,900 of 20,330 (~43.6 %)** — see below |
| R3 | fewer than 6 brake-on samples in the zone | `TRAIL_MIN_ZONE_SAMPLES = 6` | 7.1 % of braked rows |
| R4 | bracketing step **at the release edge** wider than 25 m | `TRAIL_MAX_RELEASE_STEP_M = 25.0` | 7.0 % of braked rows |
| R5 | implied deceleration impossible — any consecutive-sample \|Δv/Δt\| > 6.5 g inside `[onset, apex]` | `TRAIL_MAX_DECEL_G = 6.5` | ~1 % of braked rows |

**R2 is the big one and it is not optional.** `§4.2`'s `brake_zone_idx` exists because one
application serves several corners — Monza T1+T2, T8+T9+T10. `brake_zones` merges with
`max(prev_off, release)`, so the merged application has **exactly one release and it belongs to
the last corner of the complex**. Charging it to T1 would report "still braking 120 m past the
apex" for a corner the driver was already off the brakes for. **78.6 % of braked corner-rows
share a zone (15,987 of 20,330).** `brake_point_m` may legitimately be reported for all of them —
an onset is shared honestly — but a release may not.

> **`terminal` is defined exactly, because two independent derivations of its cost disagree
> (8,870 against 8,991):** a corner row is **terminal** in its zone iff no other corner row with
> the same `(session_id, driver_id, lap_number, brake_zone_idx)` has a strictly greater
> `apex_distance_m`. WP-B1's first task is to compute the non-terminal count under **this**
> definition and **pin it as a stored constant** that fails the build on any other value. Until
> that number is pinned, `~43.6 %` is an estimate and is written as one.

**R4 is recalibrated, not inherited.** A 25 m gate was originally justified against a 15.45 m
"median" step that was in fact the per-zone *maximum* (median-of-max 16.25 m, p95 26.26 m). On
the correct release-edge figure, 25 m is **≈2× the p95 (12.21 m)** — which is the right place for
a gate to bite, and coincidentally the same threshold. **The constant survives the correction;
its justification does not, and is rewritten.** The cost must be re-derived in WP-B1 and pinned.

**R5 exists because deceleration from the speed trace is not free.** Differentiating `speed_kph`
against `distance_m` on native samples returns peak decelerations of **46, 64.7, 90.9, 198.4 and
586.2 m/s²** — up to 60 g — because in slow chicanes consecutive chord samples are sub-metre
while speed drops several km/h (`TELEMETRY_SPEC §6.2` already warns that chord under-reads arc
length where curvature is high). **Instantaneous deceleration is not measurable from these
arrays.** Deceleration over a window of **≥ 25 m computed against `time_s`, not `distance_m`**,
is, and lands at a physical 4–23 m/s². This becomes a standing rule in `TELEMETRY_SPEC` (§4.5).

**Coverage after all five gates: ~9,700 measurable rows — ~48 % of braked corner-rows, ~39 % of
all 24,963 corner rows, spread across all 75 sessions.** Every session keeps some corners; no
session goes dark. The exact figure is pinned in WP-B1.

## 3.3 What is measured and REFUSED

**The acceptance gate for any per-lap technique metric in this codebase, from v1.8 onward:**
the same driver, the same car, the same circuit, Q against SQ of one sprint weekend; de-mean
within `(session, corner)`; correlate. **Pool every available paired weekend** — a single
weekend's ~20 drivers gives an SE of ~0.23 and settles nothing. Thirteen to fourteen weekends
carry telemetry on both sessions, giving ~3,000 paired corner cells.

| metric | paired n | de-meaned same-driver repeat corr | between-driver SD in one session |
|---|---|---|---|
| `brake_release_to_apex_m` | 3,329 (independently 2,963) | **0.286** (independently **0.268**) | 14.8 m (16.69 m) |
| `trail_duty` | 2,963 | **0.198** | 0.099 |
| `taper` = median(a, last third) / median(a, first third) | 2,867 | **0.001** | 0.226 |
| `trail_frac` = `brake_on_distance_m / brake_distance_m` | 3,329 | **0.018** | 0.127 |
| `late_loss_frac` (share of speed shed in the final third) | 3 weekends | **signal share 0.00 / 0.12 / 0.00** | — |

Aggregated to driver-weekend (263 cells, ≥ 4 corners): **0.311** for the release metre, **0.355**
for the duty. Driver-level `r(Q, SQ)` over ~20 drivers at a single weekend: **+0.16, −0.21,
+0.23** — consistent with a true r near 0.3, which is what pooling returns.

**Therefore, REFUSED, each on its own number:**

1. **The taper.** `r = 0.001`. It is a second difference of a `smallint` speed channel over a
   ~5 m step; the noise is the whole of it. **This is the metric the gap brief asks for by name,
   and it is not obtainable from a boolean channel.** Refused, printed, not omitted.
2. **`trail_frac`.** `r = 0.018`. Dividing by `brake_distance_m` injects the onset's noise and
   destroys what the raw difference had.
3. **`late_loss_frac`.** Signal share 0.00 on two of three test weekends. A quantity whose
   between-driver spread is entirely within-driver noise is not rendered, not even as prose about
   a single lap.
4. **`decel_ratio_apex`** (mean decel in the last 20 % ÷ peak decel in the first 50 %). Median
   0.083 but **p05 = −0.259 and the lower quartile is negative** — the car is already
   accelerating before the stored apex, because the apex is a speed minimum located to the
   nearest sample. **A metric whose lower quartile has the wrong sign is not a measurement of
   technique.** Kept as an unrendered diagnostic so the next release does not re-derive it.
   *(This sign test becomes a standing, reusable validity screen — §4.5.)*
5. **Brake/turn overlap from `(x, y)` curvature.** Position noise at 4–5 m spacing gave a
   turn-in point so unstable that `brake_after_turn_in / zone_length` came out as exactly 1.00
   and exactly 0.00 for adjacent drivers at the same Monza corner. Noise wearing the clothes of a
   measurement.
6. **Any driver-versus-driver brake-shape comparison, and any `mode2_driver_skill` value.**
   At `r = 0.286` roughly 70–80 % of the cross-driver spread at a corner does not repeat for the
   same driver. `trail_braking` is written as a `measured = false` row for all 28 drivers and
   appears in the `§3.6` panel beside tyre management and wet. **This is the project's third
   refusal and it is reached the same way as the first two: it was built, it was measured against
   a real noise floor, and the noise floor won.**

**The discredited result, published so nobody rediscovers it and ships it.** A looser first
detector (`n ≥ 5`, zone ≥ 30 m, no edge-guard and no chord-compression refusal) produced a
per-driver index with `r(Q, SQ)` of **+0.26 to +0.47**. Tightening the gates destroyed it: the
apparent driver signal was the compound-section artefact — some drivers' zones were being charged
to a later corner's low point more often than others'. **That number is wrong and it is recorded
here as wrong.**

## 3.4 What repeats, at what altitude, and what a pressure trace would add

| unit of aggregation | repeat correlation | verdict |
|---|---|---|
| one corner, one lap | **0.286** | ~8 % of the variance repeats. **Not a fact about a driver.** |
| all corners of one lap (driver-lap mean) | **0.412** | still mostly the lap |
| a driver's whole season (split-half by round parity) | **0.874** | a stable signature — of driver **and car and setup together** |

The 0.874 is genuinely repeatable and is **still not a driver rating**: one lap per driver per
session, no mobility variation, and a split by round parity holds the car fixed all season by
construction. `§4.3` forbids a model laid over telemetry. **The surface therefore aggregates to
the lap and stops there** (§5.2), and the 0.874 is recorded here rather than printed anywhere a
reader can carry it away.

**What a pressure trace would add.** A real brake-percentage channel (which FastF1 does not
expose; the live timing feed carries brake as a threshold flag) would add exactly one thing the
boolean cannot express: **the taper itself** — peak pressure, where the peak falls in the zone,
the release ramp, modulation under lock-up, and honest left-foot overlap instead of `§4.1`'s
1.3–5.5 % stream-merge artefact. **This metric measures how long the brake was touched, not how
hard.**

**What a pressure trace would NOT fix: the refusal in §3.3.** The driver rating fails because
there is one draw per corner against a lap-to-lap SD as large as the driver-to-driver SD, and a
pressure channel on the same one stored lap has exactly the same problem. **The pre-condition for
any future trail-braking skill is more laps per driver per session** — storing 2–3 representative
laps instead of one. That is a `TELEMETRY_SPEC` change, not a channel change. It is named here
and **explicitly not proposed for v1.8**.

---

# 4. Gap B — schema and pipeline

## 4.1 Where it lives: five columns on `lap_corner_speeds`, not a new table

The grain is identical — one row per `(session, driver, lap, corner)` — and `brake_point_m` and
`brake_distance_m` are already there. `§4.2` says this table plus the summary is "the **whole** of
the ask box's telemetry surface, because 'who carried the most speed through Turn 8 this year' is
four lines of SQL here and unanswerable from the arrays". Splitting the release into a second
table would make the obvious braking question a join and would need its own ask view, its own
manifest entry and its own idempotency story.

**Migration 0010, additive, in DDL order after `brake_distance_m`:**

```sql
ALTER TABLE lap_corner_speeds ADD COLUMN brake_release_m         real;
ALTER TABLE lap_corner_speeds ADD COLUMN brake_release_to_apex_m real;
ALTER TABLE lap_corner_speeds ADD COLUMN brake_on_distance_m     real;
ALTER TABLE lap_corner_speeds ADD COLUMN trail_duty              real;   -- diagnostic, never rendered
ALTER TABLE lap_corner_speeds ADD COLUMN trail_status            text NOT NULL DEFAULT 'measured';

ALTER TABLE lap_corner_speeds ADD CONSTRAINT lap_corner_speeds_trail_status_check CHECK (
  trail_status IN ('measured','taken_flat','shared_zone_non_terminal',
                   'too_few_samples','release_step_too_wide','implied_decel_impossible'));

-- the three release numbers are NULL together, always: one CHECK, not three chances to disagree
ALTER TABLE lap_corner_speeds ADD CONSTRAINT lap_corner_speeds_trail_check CHECK (
  (trail_status <> 'measured'
     AND brake_release_m IS NULL AND brake_release_to_apex_m IS NULL
     AND brake_on_distance_m IS NULL)
  OR (trail_status = 'measured'
     AND brake_release_m IS NOT NULL AND brake_release_to_apex_m IS NOT NULL
     AND brake_on_distance_m IS NOT NULL AND brake_point_m IS NOT NULL));
```

**`trail_status` is stored, not inferred.** A blank cell must be able to say *which* of six things
happened, and the component must take the reason as a **prop from the database** rather than
guessing from a NULL — `§6.4`'s "enforcement, not just captions". `trail_duty` is exempt from the
release CHECK: it is computable at a non-terminal shared corner and is stored there as a
diagnostic, but it is never rendered and never leaves the ask view unfiltered (§4.4).

**`lap_telemetry_summary` gets nothing.** A lap-level trail index is
`avg(brake_release_to_apex_m)` over stored rows — four lines of SQL, exactly what `§4.2` promises.
Its repeat correlation is 0.412 (§3.4); that does not earn a column.

**A corner with no braking (Monza 15923 T3 — 20 laps, 0 braked, 282 km/h apex):** `brake_point_m`
is already NULL and the release columns are NULL with it, with `trail_status = 'taken_flat'`.
**NULL, never 0** — `§4.1`'s `drs_distance_m` rule. Flat is a **positive report, not a gap**
(§5.2, `C-BRK-4`).

## 4.2 Where it is computed

`f1lab/telemetry.py::corner_metrics` (L482), inside the loop that already selects the serving
zone. The release comes from `zones[zi][1]`, taken at the **midpoint of the bracketing sample
step** — `0.5 * (d[last_on] + d[last_on + 1])`. New constants beside the existing `BRAKE_*`
block: `TRAIL_MIN_ZONE_SAMPLES = 6`, `TRAIL_MAX_RELEASE_STEP_M = 25.0`, `TRAIL_MAX_DECEL_G = 6.5`,
`TRAIL_DERIVE_VERSION = 2`.

**R2 needs the only non-trivial code in Gap B.** `corner_metrics` currently decides each corner
independently; terminality is a property of the *complex*. The loop becomes two passes: pass 1
assigns `zi` per corner exactly as today; pass 2 marks, for each zone, the corner it serves with
the **strictly greatest `apex_distance_m`** (§3.2's exact definition) and sets
`trail_status = 'shared_zone_non_terminal'` on the others. **No change to `brake_zone_idx`,
`brake_point_m`, `brake_distance_m` or any existing value.**

## 4.3 Idempotency — and the trap that would silently ship 24,963 NULLs

`TELEMETRY_SPEC §3.5`: a `(session_id, driver_id, lap_number)` whose stored `source_hash` matches
is **skipped without a write**, and `source_hash` is a SHA-256 over
`(fastf1_version, lap_number, n_samples, first/last time_s, channel-array checksums)` —
**the raw inputs, not the derivation recipe.**

> **A normal `warm_telemetry.py` run after migration 0010 therefore writes nothing at all. All
> 1,518 laps hash identically, every session is skipped, and the five new columns stay NULL
> forever while the build reports success.** This is the highest-risk defect in Gap B (§7, R1).

Two changes fix it, and the second is the one worth having:

1. **The backfill is `scripts/warm_telemetry.py --force` over the 75 telemetried sessions.**
   `§3.5` guarantees `--force` re-reads the FastF1 cache and makes **zero API calls** — a local
   CPU re-derive, not an 11 GB re-download. It re-`DELETE`s and re-`COPY`s per session inside
   that session's own transaction, so a failure cannot regress a healthy session (`§3.6`).
2. **`lap_telemetry` gains `derive_version smallint NOT NULL DEFAULT 1`**, written from
   `TRAIL_DERIVE_VERSION`, and the skip condition becomes
   `source_hash matches AND derive_version = TRAIL_DERIVE_VERSION`. A future derived-metric
   change is then a constant bump plus a plain re-run instead of an operator remembering
   `--force`. `TELEMETRY_SPEC §3.5` is amended to say this in words.

**Backfill acceptance is a stored expected count, not "> 0".** WP-B1 pins
`TRAIL_EXPECTED_MEASURED_ROWS` (≈ 9,700, exact value derived under §3.2's `terminal` definition)
and the build **fails on any other number, because zero is not the only wrong answer.**

**Every stored value that exists today is rewritten byte-identically.** WP-B4 snapshots
`lap_corner_speeds` and `lap_telemetry_summary` to CSV before the re-derive and diffs every
pre-existing column after. **Zero rows may differ.** Same gate as Gap A's (§2.4).

## 4.4 Coverage, and the query-layer restriction

| | rows | share |
|---|---|---|
| `lap_corner_speeds` total | 24,963 | 100 % |
| `taken_flat` (R1, already NULL today) | 4,633 | 18.6 % |
| braked corners | 20,330 | 81.4 % |
| … `shared_zone_non_terminal` (R2) | ~8,900 | ~35.5 % of all |
| … R3 / R4 / R5 | ~1,900 | ~7.6 % of all |
| **rows with a trail-braking number** | **~9,700** | **~39 %** |

**All 75 telemetried sessions keep measurable corners; none goes dark.** The corner card renders
a mixed table and each blank carries its own reason string (§5.2).

**Query-layer restriction, enforced in the ask manifest, not in a caption:**

1. `brake_release_to_apex_m`, `brake_on_distance_m` and `trail_duty` may be aggregated **only**
   with `GROUP BY session_id, corner_number`. `corr(trail_duty, apex_speed_kph) = −0.595`, so any
   cross-corner average is largely a measurement of the circuit.
2. The brake-shape columns are exposed to the ask box **only filtered to a single
   `(session_id, driver_id, lap_number)`**, never grouped across drivers. A schema restriction
   survives a caption rewrite; a caption does not.
3. `trail_duty` is **not** exposed to the ask box at all and appears on no page. It exists for the
   refusal audit and for the next release's validity work.

## 4.5 Standing rules this gap writes into `TELEMETRY_SPEC`

| Rule | Text |
|---|---|
| **Sampling figures corrected** | `§2.1`: lap-wide `max_sample_gap_m` is **54.78 m median, 89.72 m p95, 192.69 m worst** (not "~74 m"); mean step 8.04 m. In-brake-zone step is **4.94 m median / 8.33 m p95**, and the bracketing step at a brake edge is **3.89 m median / 12.21 m p95**. |
| **Never differentiate against distance** | `§6.2`: never differentiate `speed_kph` against `distance_m` on native samples — it returns 46–586 m/s² (up to 60 g) because chord samples compress in slow chicanes. Use windows of **≥ 25 m against `time_s`**, which yields a physical 4–23 m/s². |
| **The sign test** | `§4.3`: if a candidate metric's lower quartile has the wrong sign, refuse it. Keep it computed as an unrendered diagnostic so the next release does not re-derive it. |
| **The repeatability gate** | `§4.3`: no per-lap technique metric may be rendered as a driver comparison until it has passed the pooled sprint-weekend repeat test of §3.3 at a pre-registered threshold. Pool every available paired weekend; one weekend settles nothing. |
| **Replication is the limit** | `§3.1`: `selection = 'fastest'` stores one lap per driver per session. Any future technique *skill* requires 2–3 representative laps per driver per session. Named, and not proposed for v1.8. |
| **Derived columns need a version** | `§3.5`: `source_hash` covers raw channels only; every derived column set is gated by `derive_version` as well. |

## 4.6 Touch points

| File | Change | Owner |
|---|---|---|
| `f1lab/telemetry.py` | two-pass `corner_metrics`; four constants; `brake_zones` docstring gains "the release is stored as of v1.8" | WP-B1 |
| `f1lab/frames.py` (L520) | `TABLE_COLUMNS["lap_corner_speeds"]` gains five columns **in DDL order** (`EXPECTED_COLUMNS` derives from it, so `db.assert_schema` follows); `lap_telemetry` gains `derive_version` | WP-B1 |
| `scripts/warm_telemetry.py` | skip condition gains `derive_version`; expected-count assertion; `--force` unchanged | WP-B1 |
| `web/db/schema/telemetry.ts` (L180) | five columns + two CHECKs + `deriveVersion` | WP-B0 |
| `db/migrations/0010_trail_braking.sql`, `web/drizzle/0010_*.sql`, `meta/0010_snapshot.json` | §4.1 | WP-B0 |
| `web/lib/queries/telemetry.ts` (L410) | `CornerRow` gains `brakeReleaseToApexM`, `brakeOnDistanceM`, `trailStatus` | WP-B2 |
| `web/components/charts/CornerCard.tsx` | one column, the complex bracket, the six reason strings | WP-B2 |
| `web/lib/telemetry/captions.ts` + `captions.test.ts` | `C-BRK-1..6` as pinned consts; the test is what makes "verbatim" mechanical | WP-B2 |
| `scripts/sql/0005_ask_views.sql` | `ask.lap_corner_speeds` gains three columns under the §4.4 restriction; `trail_duty` excluded | WP-B3 |
| `web/lib/ask/schema-doc.txt`, `ask-objects.json` | regenerate; prose saying a NULL release means flat **or** shared-zone, and naming the GROUP BY rule | WP-B3 |
| `tests/test_telemetry.py`, `tests/test_frames.py` | zone-release unit tests; Monaco T7 / Monza T2 face-validity assertions; column lists | WP-B1 |

**Neither gap touches the other's files.** Gap A owns `decomp.py`, `mode2.ts`, `SkillPanel.tsx`,
migration 0009. Gap B owns `telemetry.py`, `telemetry.ts`, `CornerCard.tsx`, migration 0010. The
only shared files are `f1lab/frames.py` and `scripts/sql/0005_ask_views.sql`, and §6 sequences
them so exactly one package holds each at a time.

---

# 5. Surfaces, with VERBATIM captions

**Caption rule (D8), enforced by `captions.test.ts`:** every string below is pinned byte-for-byte.
`{braces}` are **template slots filled from the database at render time** — never hard-coded —
because a driver name, a rank or a fitted count goes stale on the next ingest. A caption
containing a hard-coded driver name or rank fails the test. Frozen one-off experimental results
(the repeatability numbers) are pinned as literal constants with their provenance in `§9`.

## 5.1 Gap A — the `/driver` skill panel becomes seven rows

Three measured, four refused, **same visual weight** (`§3.6`). Order: **Race pace · Qualifying
pace · Starting-grid pace · Tyre management · Wet weather · Sprint qualifying · Trail braking.**
Race pace and Qualifying pace share one `pp` axis (§1.7); Starting-grid pace keeps its own; no
radar, ever. The panel renders its counts from `count(*)`, never from a hard-coded number.

`§3.6` panel rows added (verbatim one-line reasons):

| Skill | Verdict | Reason |
|---|---|---|
| Qualifying pace | measured | Fitted from {nRows} first-segment qualifying laps across {nSessions} sessions. |
| Sprint qualifying | not measured | We fitted it on {nSqSessions} sprint-qualifying sessions. The driver differences came out smaller than their own error bars, and seventeen sessions is not a corpus. |
| Trail braking | not measured | We can see where a driver came off the brakes on one lap. We cannot turn that into a rating: the same driver's number at the same corner changes as much between his own two laps of one weekend as it does between him and the rest of the grid. |

**`C-SKILL-2` — starting-grid pace. AMENDED IN PLACE. This ID stays attached to this skill
forever; it is never reassigned to another skill.**

> This is fitted from where the car started. Starting position includes grid penalties and
> pit-lane starts, and this number does not subtract them — a five-place gearbox penalty enters
> it as driver slowness. Qualifying pace, above, is fitted on the laps themselves and includes
> none of that. Where the two bars disagree, the disagreement is the penalties, the pit-lane
> starts and the sprint-weekend grids. This bar is measured on a rank scale, not in lap time, so
> the two cannot be subtracted and this bar is not comparable to the two above it.

**`C-SKILL-5` — qualifying pace, under the bar, unconditional. NEW.**

> This is fitted from each driver's first-segment qualifying lap — Q1, the one segment every
> driver runs — measured as a percentage of that session's own field average, across {nRows} laps
> and {nSessions} sessions. Percentages, not seconds, because a tenth at Monaco is not a tenth at
> Spa. Sprint qualifying is not in this number. Wet sessions are not in this number. A driver who
> cruises Q1 because his car will walk into Q3 is measured on that cruise, and we cannot tell
> that apart from being slow: for the drivers who reach Q3, the margin we can see in Q1 is about
> forty per cent smaller than the margin they show when it counts.

**`C-SKILL-6` — under the shared axis, prints both stored correlations. NEW.**

> Qualifying pace and race pace are different numbers on the same scale: percent of a lap,
> against the field that was actually there. Across {nDrivers} drivers they agree at
> r = {corrOneLapRace}, so most of what they measure is the same thing measured twice.
> Starting-grid pace is on a different scale and cannot be put beside them; it agrees with
> qualifying pace in ranking at r = {corrOneLapGrid}.

**`C-SKILL-7` — above the shared axis, unconditional. NEW.**

> {nCrossZero} of these {nDrivers} qualifying ratings include zero. Where two bars overlap, we
> have not shown you a difference — we have shown you two numbers we cannot separate.

**`C-SKILL-8` — the island caption, on the hatched bars, unconditional. NEW.**

> Qualifying gave us {nQualiLaps} new laps and not one new transfer. These drivers have never
> raced for another team in this data, so where they sit against the rest of the grid is an
> assumption we made, not something we measured. About half of the uncertainty in this bar is
> that assumption rather than measurement, and more qualifying sessions will never narrow it.

**Also rendered, not captioned:** the thin-data flag (`n_obs < 25`, six drivers) and the
`floating` badge are **two separate marks**. Both can produce an SE at the shrinkage ceiling for
opposite reasons (§1.4), and the panel must never show them in one undifferentiated column.

**What the Gap A surface must NOT claim — enforced, not caption-only:**

1. **Never a combined or overall rating.** No sum, no mean, no radar, no "ranked #3 overall".
   `SkillPanel` has no aggregate branch and a test asserts the rendered DOM contains no element
   holding two skills' values.
2. **Never a level for Norris, Piastri, Alonso or Stroll.** `pct_field_below` is NULL in the
   database for all four on all three measured skills; the hatched bar and the "level not
   measured" chip render; no plain numeral is printed. `§5.1.1`'s gate fails the **run**, not the
   page, if the floating set ever differs between skills.
3. **Never a per-driver number for what the penalties were worth.** Words only (`C-SKILL-2`). A
   subtraction across a normal score and a percentage is not computable and is not computed.
4. **Never "he's a qualifying specialist".** That needs a resolvable difference between two
   skills and §1.5 shows almost none is resolvable. No "delta vs race pace" is computed or shown.
5. **Never `pct_field_below` compared across the two `pp` skills** — the field spreads differ
   (τ_car 0.562 against 0.874). Each bar keeps its own annotation; the two are never subtracted.
6. **Never "drivers are closer together over one lap".** The measured ratio is 3.50 in qualifying
   against 3.31 in the race — if anything slightly *more* car-dominated. A test greps the copy.
7. **Never a per-season or per-circuit qualifying rating.** `§1.5` item 2 unchanged: a
   driver×season term shatters the graph into 28 components, and qualifying adds no edges.
8. **Never "he out-qualified his team-mate N–M" from this bar.** That is a *count*, it already
   exists in `quali_teammate_h2h` (`QUALI_SPEC §4.3`), and the panel links to it rather than
   restating it.

## 5.2 Gap B — the corner card gains one column, and a refusal card

`§5.4`'s `CornerCard.tsx`, one row per corner, A and B side by side, complexes already bracketed.
New column **"off the brakes"**, rendered **to the nearest 5 m**, signed, with "at the apex" for a
negative value and a reasoned blank for every refusal.

**No new chart, no new page, no braking overlay on the track map** — the track map is a position
trace and a brake release drawn on it would imply a precision a ±4 m median / ±12 m tail
measurement does not have. **No driver-page braking panel; it is booked, not implied.**

**`C-BRK-1` — under the corner card, unconditional. NEW.**

> "Off the brakes" is how far before the apex the brake came off, measured from the brake
> channel, which is on-or-off. A negative number means the brake was still on at the apex.
> Inside a braking zone the channel is sampled about every five metres, and the moment it
> switches off is pinned to about four metres — so we round to the nearest five, and two drivers
> within ten metres of each other have not been shown to differ.

**`C-BRK-2` — corner card header, beside the column name. NEW.**

> This measures how long the brake was touched, not how hard. There is no brake-pressure channel
> in this data, so a driver feathering the brake to the apex and a driver still hard on it look
> exactly the same here.

**`C-BRK-3` — the reasoned blank. Six strings, one per `trail_status`, passed as a prop from the
database, never inferred from a NULL. NEW.**

| `trail_status` | verbatim cell reason |
|---|---|
| `taken_flat` | Nobody braked for this corner. It is taken flat. |
| `shared_zone_non_terminal` | This corner shares one braking event with the corner after it, and a shared braking event has only one release — it belongs to the last corner in the complex. |
| `too_few_samples` | The braking zone here has too few samples to say where the brake came off. |
| `release_step_too_wide` | The gap between samples at the moment the brake came off is wider than the answer would be worth. |
| `implied_decel_impossible` | The speed trace through this corner implies a deceleration no car can produce, so the samples here are not trustworthy. |
| `measured` | *(no string — a number is shown)* |

**`C-BRK-4` — the refusal card, at the same visual weight as the column, mirroring `§3.3`'s
measured-and-refused style. NEW.**

> We also tried to measure how the brake pressure tapers off — the part of trail braking people
> actually mean. We cannot. With no pressure channel the only proxy is how the deceleration
> decays across the braking zone, and we measured it: on 3,329 corners where the same driver took
> the same corner twice in one weekend, that number agreed with itself at r = 0.001. It is noise,
> so we are not showing it.

**`C-BRK-5` — beneath `C-BRK-4`, unconditional. NEW.**

> We also cannot turn this into a rating for a driver. We tried: the same driver, the same
> corner, the same car, two qualifying sessions of one weekend. His number changed about as much
> between his own two laps as it changes between him and everyone else. The missing ingredient is
> not a better brake channel — it is more laps. We store one lap per driver per session.

**`C-BRK-6` — the confound disclosure, above the column. NEW.**

> Two drivers' braking numbers differ for reasons that have nothing to do with technique: how
> much fuel was in the car, how old the tyres were, how much wing the team chose, and where each
> driver was on the road. None of those are in this data. This shows what the brake channel did
> on one lap. It does not show who brakes better.

**`C-BRK-7` — scope, in the card header. NEW.**

> Braking numbers come from qualifying laps. Only one race in this database has telemetry, so
> nothing here describes a race lap.

**What the Gap B surface must NOT claim.** Same trap as the delta trace (`§6.1`), so it inherits
`C-TEL-1` unchanged above the page, and adds this table — which is the enforceable form, checked
row by row in review:

| the conclusion a fan will reach for | what differs between the two laps | in the data? |
|---|---|---|
| "A trail brakes better than B" | fuel load (a Q1 run is not a Q3 run) | **no** |
| | tyre age and compound | header only |
| | downforce level and brake-bias setup | **no** |
| | where he was on the road — traffic, a tow, a scruffy entry | **no** |
| "A is braver on the brakes" | it is one corner, once. Measured repeat correlation **0.286** | — |
| "this is A's braking style" | true only at season aggregate (r = 0.874), and that is driver **and car and setup together** | — |

Enforced, not merely captioned:

1. **Forbidden vocabulary, greppable.** The words **pressure, taper, modulation, bleeding off,
   trail-braking score** may not appear in any copy string, `alt` text, tooltip or ask-box answer
   template — except inside `C-BRK-2` and `C-BRK-4`, which exist to say the app cannot measure
   them. A test enforces the exception list.
2. **No cross-driver braking comparison on a race lap.** `CornerCard` already takes `sessionKind`
   and returns `C-TEL-5` on `'R'`; the new column inherits it.
3. **No braking leaderboard, no season ranking, no driver-level trail-braking number anywhere in
   the app or the ask box.** The query-layer restriction of §4.4 makes the forbidden query
   ungenerable rather than merely discouraged.
4. **The picker keeps defaulting to team-mates** (`§6.1` R6) — the only pairing where downforce
   level and brake bias are close to held constant, and even then not held.
5. **Never displayed to sub-5 m precision**, and never used to break a tie in any other chart.
6. **Flat is a positive report, not a gap.** Three states, three renderings, and no fourth:
   *measured* (a number), *taken flat* (a sentence), *refused* (a sentence naming which of four
   things happened).

---

# 6. Work packages

## 6.1 File ownership — one owner per file, for the whole release

No file appears twice. A package may **read** anything; it may **write** only what it owns.

| Owner | Files |
|---|---|
| **WP-A0** schema (Gap A) | `db/migrations/0009_one_lap_pace.sql`, `web/drizzle/0009_one_lap_pace.sql`, `web/drizzle/meta/0009_snapshot.json`, `web/db/schema/mode2.ts` |
| **WP-A1** the fit | `f1lab/decomp.py`, `f1lab/config.py`, `tests/test_mode2_skills.py`, `tests/test_mode2_schema.py` |
| **WP-A2** Gap A web | `web/lib/queries/mode2.ts`, `web/components/driver/SkillPanel.tsx`, `web/lib/driver/captions.ts`, `web/lib/driver/captions.test.ts` |
| **WP-A3** Gap A ask + specs | `web/lib/ask/schema-doc.txt`, `web/lib/ask/ask-objects.json`, `docs/MODE2_SPEC.md`, `docs/QUALI_SPEC.md` |
| **WP-A4** Gap A no-drift | `tests/test_quali_integration.py`, `scripts/verify/no_drift_mode2.py` *(new)* |
| **WP-B0** schema (Gap B) | `db/migrations/0010_trail_braking.sql`, `web/drizzle/0010_trail_braking.sql`, `web/drizzle/meta/0010_snapshot.json`, `web/db/schema/telemetry.ts` |
| **WP-B1** the derivation | `f1lab/telemetry.py`, `scripts/warm_telemetry.py`, `tests/test_telemetry.py`, `tests/test_frames.py` |
| **WP-B2** Gap B web | `web/lib/queries/telemetry.ts`, `web/components/charts/CornerCard.tsx`, `web/lib/telemetry/captions.ts`, `web/lib/telemetry/captions.test.ts` |
| **WP-B3** Gap B ask + spec | `docs/TELEMETRY_SPEC.md` |
| **WP-B4** Gap B no-drift | `scripts/verify/no_drift_telemetry.py` *(new)* |
| **WP-S1** shared files, held alone | `f1lab/frames.py`, `scripts/sql/0005_ask_views.sql` |

`f1lab/frames.py` and `scripts/sql/0005_ask_views.sql` are the only files both gaps need. **WP-S1
holds both and lands once**, after WP-A1 and WP-B1 have specified their column lists and before
WP-A3/WP-B3 regenerate the ask artefacts. No concurrent edit, ever.

## 6.2 Sequencing

```
WP-A0 ──┐                          WP-B0 ──┐
        ├─ WP-A1 ──┐                       ├─ WP-B1 ──┐
        │          │                       │          │
        └──────────┴────► WP-S1 ◄──────────┴──────────┘     (shared files, held alone)
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
           WP-A2          WP-A3          WP-B2   WP-B3
              │              │              │      │
              └──────► WP-A4 ◄──────────────┴──► WP-B4
```

Gap A and Gap B run **in parallel** up to WP-S1 and again after it. The migrations (A0, B0) are
numbered so either order applies cleanly; 0009 before 0010 by convention.

## 6.3 Per-package verification

**Test-runtime rule, non-negotiable.** `test_frames`, `test_ingest_cli`, `test_ingest_hungary`,
`test_sim_db`, `test_mode2_model`, `test_title`, `test_guards`, `test_companion_schema`,
`test_mode2_schema`, `test_mode3_schema` and `test_report_idempotency` **take 25–40 minutes each**
because they re-ingest real sessions. **Never run one in the foreground.** Launch in the
background, keep working, collect the result. Every package below names its fast checks first so
there is something to verify in seconds.

| WP | Verification |
|---|---|
| **A0** | `docker exec f1-postgres psql -U f1 -d f1 -c "\d mode2_driver_skill"` shows the seven-key CHECK; rollback script re-applied and re-run clean; drizzle snapshot hand-diffed against the hand-written SQL (`§6.4`'s three traps). |
| **A1** | Fast: `fit_one_lap_pace` on the live DB reproduces **1,135 rows / 56 sessions / τ_δ 0.1605 / τ_γ 0.5620 / σ 0.3846** to four decimals. **Gate G1:** refit `grid_pace` from `GRID_SQL` and assert **r = 1.000** against the stored rows *before* any correlation is computed. **Gate G2:** `build_components` on quali rows alone returns 4 components, member-identical to §1.4 — fails the **run**, not the page. **Gate G3:** build fails if either `corr_one_lap_grid` **or** `corr_one_lap_grid_ex_islands` ≥ 0.95. Then background `test_mode2_skills`, `test_mode2_schema`. |
| **A2** | `captions.test.ts` pins `C-SKILL-2/5/6/7/8` byte-for-byte; a DOM test asserts no element holds two skills' values; a grep test asserts no driver name, no rank and no "closer together over one lap" appears in copy. |
| **A3** | `ask-objects.json` regenerated and diffed; `ask_answer_cache` invalidated; every `§2.3` amendment present, checked by a spec-anchor test that greps each named section for its new sentence. |
| **A4** | `no_drift_mode2.py`: `mode2_row_audit` **= 983**; `mode2_driver_skill` **= 196**; the 112 pre-existing rows compared **across the two `fit_id`s** with **zero** value differences; `mode2_driver_rating`, `mode2_driver_contrast`, `mode2_car_rating`, `mode2_counterfactual` untouched. |
| **B0** | `\d lap_corner_speeds` shows five columns in DDL order and both CHECKs; a row violating the status/NULL pairing is **rejected by the database**, proven by an expected-failure insert. |
| **B1** | Fast: the `terminal` definition of §3.2 computed and **pinned** as `TRAIL_NON_TERMINAL_ROWS` and `TRAIL_EXPECTED_MEASURED_ROWS`; R4's cost re-derived against the corrected release-edge step and pinned. Face validity asserted on named corners (Monaco T7 negative, Monza T2 positive, Monza 15923 T3 `taken_flat` on all 20 laps). Then background `test_telemetry`, `test_frames`. |
| **S1** | `db.assert_schema` passes for both tables; `EXPECTED_COLUMNS` derives correctly; `ask.lap_corner_speeds` exposes three columns and **not** `trail_duty`. |
| **B2** | `captions.test.ts` pins `C-BRK-1..7` including all six `trail_status` strings; the forbidden-vocabulary grep passes with only `C-BRK-2`/`C-BRK-4` on the exception list; a test asserts the column renders to the nearest 5 m. |
| **B3** | Manifest asserts the brake-shape columns are unreachable except filtered to one `(session_id, driver_id, lap_number)`, and that no generated query groups them across drivers or corners. |
| **B4** | `no_drift_telemetry.py`: CSV snapshot of `lap_corner_speeds` and `lap_telemetry_summary` taken **before** the `--force` re-derive; every pre-existing column diffed after; **zero rows may differ**. Backfill asserted equal to `TRAIL_EXPECTED_MEASURED_ROWS` — **not "> 0"**. |

**Release gate.** The release does not ship unless: G1, G2, G3 pass; both no-drift scripts report
zero differences; `mode2_row_audit` reads 983; the backfill count equals its pinned constant; and
every caption test passes.

---

# 7. Risks

| # | Risk | Why it is real | Mitigation |
|---|---|---|---|
| **R1** | **The Gap B backfill silently ships ~25,000 NULLs while the build reports success.** | `lap_telemetry.source_hash` covers the raw channels, not the derivation. Every one of the 1,518 laps hashes identically after migration 0010, so a default `warm_telemetry` run skips all of them and exits 0. | `derive_version` added to the skip condition (§4.3); backfill is `--force` (zero API calls); acceptance is a **pinned expected count**, not "> 0", because zero is not the only wrong answer. Owned by WP-B1, verified by WP-B4. |
| **R2** | **`test_mode2_skills.py::test_grid_pace_is_never_called_one_lap_or_qualifying_pace` breaks the moment `fit_one_lap_pace` is written** — it greps the whole of `decomp.py` for "qualifying pace" and fails unless the line contains "never". A developer under time pressure deletes the guard to make the build green. | The guard exists precisely to stop the honesty violation this release is about. Deleting it is the worst possible outcome of shipping the fix. | WP-A1 owns the test and **narrows** it to `inspect.getsource(fit_grid_pace)` plus the `grid_pace` literals, and **adds a mirror guard** on the new skill's label. Named as release-blocking in §2.4 so no other package touches it. |
| **R3** | **A future release refits the qualifying skill on a "richer" response (deepest segment, all segments) and silently re-imports the ordinal signal.** The construction looks obviously better and its τ_driver comes out *larger*, which reads as an improvement. | It has already happened once in the proposal set: a spec that centres locally while dropping outcome-selected rows leaves +0.767 pp of unabsorbed offset against a 0.176 pp τ_driver, and inflates τ_driver by 2.4×. | The stratum-completeness rule is written into `MODE2_SPEC §1.2` (§2.3) with its measured cost. Any candidate response must additionally report its **effect-level correlation against the selection-free Q1 response** — 0.941 passes, 0.754 does not — and V5 chaining stays in the spec as the named legal alternative. |
| **R4** | **Someone builds a per-driver trail-braking number from the shipped column**, in the ask box, in a future driver panel, or in a blog post using the public view. The column is there and averaging it is one line of SQL. | Repeat correlation 0.286; the metric is ~70–80 % non-repeating at the rendered altitude. A season split-half of 0.874 sits in this document and is exactly the number someone will quote. | Enforced at the **schema/manifest layer**, not in a caption: brake-shape columns reachable only filtered to one `(session, driver, lap)`; aggregation only `GROUP BY session_id, corner_number`; `trail_duty` not exposed at all; `trail_braking` written as a `measured = false` row so the refusal is in the database. `C-BRK-5` states the pre-condition (more laps, not a better channel). |
| **R5** | **A wrong measured number reaches fan-facing copy and stays there**, because it was conservative and nobody re-checked. | This release exists partly to fix one: a "sampled about every 15 metres, good to about 8 metres" caption, where the true in-zone step is 4.94 m and the release edge is located to 3.89 m. The 15.45 m figure was a per-zone *maximum* reported as a median, and it had already been used to calibrate a refusal gate and a rounding rule. | Every number in a caption is either a **template slot from the database** or a **pinned constant with its provenance recorded in §9**. WP-B1 re-derives the release-edge step, R4's cost and the non-terminal count **before** WP-B2 writes the caption, and the caption test fails on any literal number not in the pinned-constants list. |

---

# 8. Decisions log

One line per decision where the sources disagreed or a judge found an error. **Fix** = an error a
judge identified, corrected here. **Graft** = an idea taken from a proposal that did not win its
gap.

| # | Decision | Source / resolution |
|---|---|---|
| DL-1 | **Gap A response is segment-1 session-centred percent (V3), not the deepest segment.** | Judged: the deepest-segment construction centres locally while dropping outcome-selected rows, leaving +0.767 / +0.477 pp unabsorbed stratum offsets against a 0.176 pp τ_driver. Rejected on measurement. Judge 3's "re-fit against the deepest-segment unit before shipping" is **honoured as done**: it was fitted (V4), its failure mode named, its repair (V5) built and priced. |
| DL-2 | **The sandbagging measurement is grafted in as a published limitation, not a caption flourish.** | Graft from statistics-first. 707 driver-sessions, margin −0.279 pp in Q1 against −0.490 pp in Q3, 43 % smaller. §1.2 and `C-SKILL-5`. |
| DL-3 | **V5 chaining stays in the spec as the named legal alternative**, rejected on price (σ 0.385 → 0.607, SEs +50 %), not on principle. | Graft. A future release with more sessions may afford it. |
| DL-4 | **"The refit buys validity, not precision"** replaces "the §2.4 artefact goes away". | Fix. Median `evidence_share` 0.813 → 0.653, SE/span 8.9 % → 12.8 %. The islands falling to 0.501 is the fit being correctly *less* confident, i.e. §2.4 confirmed, not repealed. |
| DL-5 | **The pre-registered retirement correlation is reported both ways** — 0.8393 all-28, 0.8670 ex-island — and both are stored and both gated. | New; in no proposal. Four of 28 levels are set by shrinkage toward a prior, so an all-28 statistic is 14 % prior. |
| DL-6 | **Refitting `grid_pace` from `GRID_SQL` and asserting r = 1.000 against the stored rows is a mandatory gate** before any surrogate comparison. | Graft from statistics-first, promoted from courtesy to gate G1. |
| DL-7 | **Sprint qualifying is excluded and shipped as a `measured = false` row (`sprint_one_lap`).** | Detector-first pooled it; integration-first and statistics-first both measured that pooling widens every SE for zero gain (σ 0.385 → 0.486; SQ-only τ_car/τ_driver = 10.2). Exclusion wins. |
| DL-8 | **No per-driver "what the penalties were worth" number, ever.** | Fix. `QUALI_SPEC §5.1.1` licenses saying it in words; two proposals converted it into paired numbers across a normal score and a percentage. `C-SKILL-2` says it in words only. |
| DL-9 | **`pct_field_below` is not comparable across the two `pp` skills.** | Graft from integration-first; the field spreads differ (τ_car 0.562 against 0.874). |
| DL-10 | **"Drivers are closer together over one lap" is forbidden copy.** | Fix. That headline (ratio 2.71) is the one conclusion that does not survive a scale-clean construction; every clean fit returns 3.0–3.6. Grepped by test. |
| DL-11 | **No CHECK key is added that is not written.** `sprint_one_lap` and `trail_braking` are written as real `measured = false` rows for all 28 drivers, as `tyre_management` and `wet` already are. | Fix. One proposal added `trail_braking` to the CHECK, never wrote it, and left the DDL conditional on a fact not yet established. |
| DL-12 | **Caption IDs are never reassigned.** `C-SKILL-2` remains the starting-grid-pace caption and is amended in place; the new skill gets new IDs. | Fix. One proposal reassigned `C-SKILL-2` to a different skill, which would silently repoint a drift test. |
| DL-13 | **No caption contains a driver name, a rank, or a fitted count as a literal.** All such values are template slots; the §3.6 panel renders `count(*)`. | Fix. One proposal shipped "Hamilton is 8th … and 27th …" in copy while its own risk register mandated a test forbidding driver-specific strings; another miscounted its own refusal panel in pinned copy. |
| DL-14 | **Gap B ships the release metre (integration-first's route) and the refusal (detector-first's verdict).** The judges split; both are adopted, because they are not in conflict. | The lap-level reading ships from a value `telemetry.py` already computes and discards; the driver rating is refused on the repeatability floor. |
| DL-15 | **The resolution number is the bracketing step at the release edge — 3.89 m median / 12.21 m p95 — not the window median and not the window maximum.** `C-BRK-1` is rewritten. | Fix. The shipped caption said "about every 15 metres … good to about 8 metres"; 15.45 m was a per-zone *maximum* reported as a median. |
| DL-16 | **`TRAIL_MAX_RELEASE_STEP_M = 25.0` survives the correction; its justification does not.** Re-derived as ≈2× the release-edge p95, and its cost re-measured in WP-B1. | Fix. The constant was originally calibrated off the wrong figure. |
| DL-17 | **"Terminal" is defined exactly** (no other corner in the same zone with a strictly greater `apex_distance_m`) and its cost is **computed and pinned in WP-B1**, because two derivations disagreed (8,870 against 8,991). | Fix. R2 is the largest single refusal; its constant must not be approximate. |
| DL-18 | **`trail_duty` is stored as an unrendered diagnostic, not as a shipped metric.** | Graft from statistics-first (bounded by construction, survives shared-zone adversarial testing at 12.8 % pinned) tempered by its repeat correlation of 0.198 and `corr(trail_duty, apex_speed) = −0.595`. |
| DL-19 | **`late_loss_frac` is dropped entirely, including as single-lap prose.** | Fix. Detector-first rendered it despite measuring signal share 0.00 on two of three weekends. |
| DL-20 | **Apex-anchored, not `slow_m`-anchored.** The 43.6 % non-terminal discard is accepted. | Detector-first's `slow_m` construction avoids the discard but needs a new table and a new unit, breaking the join every existing corner surface uses. Recorded as the named alternative for a future release. |
| DL-21 | **The repeatability gate is pooled across every available paired weekend, not run on one.** | Fix. Three weekends at ~20 drivers give SE ≈ 0.23 and cannot distinguish r = 0 from r = 0.3; pooling 13–14 weekends returns 0.268–0.311 stably. |
| DL-22 | **The discredited v1 detector result (r = +0.26 to +0.47) is published as wrong.** | Graft from detector-first. The flattering number is pre-debunked so nobody rediscovers and ships it. |
| DL-23 | **The statistics-first claim that within-driver repeatability "cannot be estimated from this database at all" is false and is recorded as false.** | Fix. 13–14 sprint weekends carry telemetry on both Q and SQ; the test is the one that decides whether the metric means anything. |
| DL-24 | **Quantisation is not a validity floor.** Cross-driver SD exceeding instrument resolution shows only that the instrument works. The floor is the driver's own repeat variance. | Fix, written into `TELEMETRY_SPEC §4.3` as a standing rule. |
| DL-25 | **The brief's sampling figure is corrected in the spec**: lap-wide `max_sample_gap_m` is 54.78 m median / 89.72 p95 / 192.69 worst, not "~74 m"; in-zone it is 4.94 m. | Fix. The brief understated the lap-wide gap and overstated the in-zone one. |
| DL-26 | **Both gaps' captions are pinned byte-for-byte and both gaps' no-drift checks are snapshot-diffs with zero rows permitted to differ.** | Graft from integration-first, applied to Gap B as well as Gap A. |

---

# 9. As built

## 9.1 Corrections to this document's own measured numbers (2026-09-17)

Three figures in §0-§2 were written by the design panel and **could not be reproduced by the
implementation**. They have been corrected in place to the values the shipping code measures and
stores. The superseded figures are recorded here, not deleted, because the decisions log (DL-4,
DL-5) reasoned from them and those entries are left as written:

| Quantity | Design panel | Implementation | Resolution |
|---|---|---|---|
| `corr` ex-island 24, Pearson | 0.8670 | **0.8663** | Measured across four independent constructions. All-28 (0.8393 / 0.8637) and `corr_one_lap_race` (0.7727) reproduce exactly, so the disagreement is isolated to the ex-island subset. The **stored and gated** value is 0.8663. G3 passes either way; the retirement decision is unaffected. |
| `corr` ex-island 24, Spearman | 0.8830 | **0.8835** | As above. |
| median `evidence_share`, `one_lap_pace` | 0.653 | **0.6216** | The `grid_pace` figure (0.813) reproduces. The claim it supports — *the refit buys validity, not precision* — is unaffected and if anything strengthened. |

`MODE2_SPEC` and `QUALI_SPEC` deliberately record **both** readings rather than reconciling them,
and `tests/test_spec_anchors.py` asserts that they continue to; that guard is correct and is not
relaxed by this correction. The difference is one of role: the living contracts preserve the
disagreement as provenance, while this document states what the code does.

**One panel figure was checked and upheld, against the implementation's objection.** WP-A1
reported §1.1's "1,560 of 1,567 driver-sessions have a segment-1 time" as measuring 1,562.
Re-measured directly: **1,567 joinable, 1,560 timed** — the document is right and the package's
count was wrong. No change made.

*(Still to fill at release: the pinned constants and their provenance —
`TRAIL_NON_TERMINAL_ROWS`, `TRAIL_EXPECTED_MEASURED_ROWS`, R4's re-derived cost, the
release-edge step figures, the repeatability r values and the weekends they were pooled over —
together with the `fit_id` and `assumption_set_id` of the shipping fit, the three stored
`corr_*` values, and the no-drift script outputs.)*
