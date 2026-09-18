# F1 Analytics v2.0 — REPLICATION_SPEC

**Status: DESIGNED, COSTED, AND DELIBERATELY NOT BUILT (decided 2026-09-18).** The headline
result below is the deliverable: the ceiling argument, now written into `TELEMETRY_SPEC` §1.1.1
and `GAPFILL_SPEC` §3.4 so it is not re-litigated. No work package here was executed. Sections
4-8 remain valid if a future release wants replication for its SECONDARY benefit — turning every
corner metric from a single draw into an average — which is a different and legitimate reason.

**Original status:** design, pre-implementation. No project file modified by this document. The corpus
is pinned at **75 sessions / 1,518 `lap_telemetry` rows / 24,963 `lap_corner_speeds` rows**;
every number below was obtained SELECT-only against it.

**Supersedes nothing. Amends:** `TELEMETRY_SPEC` §1.1 (the one-lap rule and SR-5),
`GAPFILL_SPEC` §3.4 and DL-21.

---

## HEADLINE RESULT — trail braking still does not ship as a rating

> **We propose buying replication, and we predict in advance that the technique skill still
> does not clear the bar. Section 3 says so with numbers and pre-commits to the refusal.**
>
> This is the fourth refusal in this project (MODE2 tyre management, MODE2 wet, GAPFILL trail
> braking, now GAPFILL trail braking again) and it is a **better** refusal than v1.8's. v1.8
> refused because n = 1 made the question unanswerable. v2.0 refuses because the answer came
> back and was too low. Only the second kind tells you how far away you are and what would
> close the gap.
>
> **The release is still worth doing.** Replication turns every existing corner metric from a
> single draw into an average, and it converts SR-5 from an argument into a measurement for
> every technique metric this corpus is ever asked about — not just this one. That is the
> deliverable. The rating is not.

Do not read this document looking for a shippable skill. It is not here, and Section 3
explains why the ceiling is a fact about driving rather than a fact about the corpus.

---

## Outline

| § | Contents |
|---|---|
| **0** | Scope, fixed decisions, what this can and cannot support |
| **1** | The replicate and the variance argument |
| **2** | The selection rule — implementably precise, with measured coverage |
| **3** | The prediction and the threshold |
| **4** | The contract, migration 0011, backward compatibility |
| **5** | Cost, pipeline, idempotency |
| **6** | The pinned constants and the two no-drift checks |
| **7** | Surfaces and VERBATIM captions |
| **8** | Work packages — single-owner ownership, sequencing, verification |
| **9** | Risks |
| **10** | Decisions log |
| **11** | As built (empty until WP9) |

---

# 0. Scope and fixed decisions

## 0.1 The mechanism sentence that governs the whole document

> **Selecting on lap time stabilises LAP TIME and nothing else.**
> `brake_release_to_apex_m` on the fastest lap of a run is a single free draw from that
> driver's brake-shape distribution — identical in distribution to the draw on the 4th-fastest
> lap. Nothing about being the fastest lap makes the brake shape more typical, more
> repeatable, or more the driver's.

This is why a measured repeat correlation of **0.286** coexists with quarter-second lap-time
repeatability, and it is the reason **no selection rule, however clever, should be expected to
do much.** Every rule in the three source proposals attacks the *lap and session* layer of the
noise. Section 1 shows that layer is the smaller one.

## 0.2 The physical fact that sizes the whole problem

**86.1 % of qualifying runs contain exactly one push lap.** Stated before the rule, because it
means "fastest-3" and "one-per-run" coincide far more often than the trap framing implies, and
it correctly sizes the same-run hazard as *one in eleven*, not *overwhelming*. Measured: the
fastest two push laps of a driver-session share a `stint` **9.4 %** of the time (1,451 pairs),
and of driver-sessions with three or more push laps, **81.4 %** have their fastest three from
distinct runs.

This matters twice. It means the naive rule is not as bad as feared — and it means the
sophisticated rule buys less than hoped, because it is mostly agreeing with the naive one.

## 0.3 Fixed decisions (the full list; each is carried in §10 with its one-line rationale)

| # | Decision |
|---|---|
| D-1 | The replicate is a replicate **of the driver-session**. Never of the run. |
| D-2 | Selection rule = **fastest push lap per run, ranked by lap time, capped at 3**. No stratification by `quali_segment`. |
| D-3 | The anchor keeps **`selection = 'fastest'`, byte-identical to v1.7**. No rename, no re-derive of legacy anchors. |
| D-4 | **Never two laps from one run inside one driver-session**, enforced by a database unique index — with one named, separately-valued fallback (§2.2 step 4, §4.4). |
| D-5 | The repeatability gate is computed **ACROSS sessions**, on the n-lap mean. A within-session repeat correlation is contaminated and is never reported as a reliability. (§1.4 — this is the single most important decision in the document.) |
| D-6 | Races are **excluded from selection** and their 21 existing rows are **left untouched**. |
| D-7 | All variance quantities are reported with **pooled** estimators, stated as such. |
| D-8 | Pinned `TRAIL_*` **counts** are repinned; pinned **shares** are added with a ±1.5 pp band; the three **step quantiles must not move**. (§6) |
| D-9 | `no_drift_telemetry.py` is **not weakened**. It runs twice. A new `replication_census.py` owns the expected change. (§6.3) |
| D-10 | Trail braking ships as a **reading with an error bar**, plus a `measured = false` row with an expiry test. No rating. (§7) |

## 0.4 What this release CAN support

1. **Every existing per-corner value becomes an n-lap mean** where n ≥ 2 (93.7 % of
   driver-sessions). This is the real product and it needs no gate — a mean of 2–3 draws is
   strictly better than one draw for `apex_speed_kph`, `min_speed_kph`,
   `brake_release_to_apex_m` and every other `lap_corner_speeds` column.
2. **A measured per-driver-session error bar**, rendered beside the value.
3. **A measured answer to SR-5** — the first time this project can state the replication limit
   as a number rather than as an argument. §3.5 prices the precision of that answer honestly,
   and it is worse than the source proposals claimed.
4. **A second comparable attempt to display**: two release distances from two separately
   prepared runs, shown side by side.

## 0.5 What this release CANNOT support, named so it is never quietly implied

1. **No trail-braking driver rating.** §3. Refused in advance, with a pre-committed threshold.
2. **No cross-driver corner delta as a ranked surface.** Refused on *missingness*, not on the
   point estimate — §3.6.
3. **No tyre-degradation, traffic, in/out-lap or session-evolution story.** All five exclusions
   of `TELEMETRY_SPEC` §1.1 survive unchanged: 2–3 qualifying laps from separate runs is not a
   lap-15-against-lap-35 comparison, and the race corpus is untouched.
4. **No claim that replication separates driver from car.** The ~15 m between-driver SD in the
   numerator is a driver-*plus-car-plus-setup* quantity. Replication sharpens that confound; it
   does not resolve it. A reliability of 0.8 would be 0.8 for something that is not only the
   driver.
5. **No within-session repeatability number presented as a reliability.** D-5. §1.4 shows such
   a number is unbounded above and means "was this driver consistent on that afternoon".

---

# 1. The replicate and the variance argument

## 1.1 The estimator, declared first (D-7)

Three different estimators of the same two SDs circulate in the source proposals and they
disagree by up to 1.5×. Every downstream reliability number inherits the choice, so it is made
once, here, and never mixed inside a single ratio.

| quantity | median-of-groups | mean-of-group-SDs | **pooled (USED)** |
|---|---|---|---|
| within-run SD of push-lap time | 0.2977 s | 0.3993 s | **0.5984 s** (809 runs) |
| between-run SD of run-bests | 0.4452 s | 0.5200 s | **0.6742 s** (1,405 driver-sessions) |
| ratio (between / within) | 1.50× | 1.30× | **1.13×** |

**The brief's "between-run variation is 1.5× larger" is a median statement.** Under pooling —
the estimator that actually corresponds to a variance component — it is **1.13×**, i.e.
**1.28× in variance, not 2.23×.** The trap is real and the direction is right, but it is
roughly *half* the size the source proposals used to size it. Stating this is D-7's whole
purpose: two of the three proposals computed a load-bearing ratio with a pooled numerator and
a median denominator, which is not a ratio of anything.

**Comparator for the v1.8 gate.** `GAPFILL_SPEC` §3.3 defines the v1.8 repeat correlation as
*de-mean within `(session, corner)`, then correlate* — so the session-level shift common to all
drivers is **already out of 0.286**. The matched across-session comparator is therefore the
**de-meaned** per-session SD: raw paired-difference SD 0.7113 s (n = 242 trimmed) → de-meaned
0.6449 → ÷√2 = **0.456 s**. Not 0.503 (un-de-meaned) and not 0.224 (a dry-SOFT-only
subsample). Any `f` quoted anywhere in this project must state which of these three it used.

## 1.2 The three candidate replicates

| replicate | what varies between the two laps | what is held | the SD estimates |
|---|---|---|---|
| **R-A** two laps, same run | execution, ±1 lap of fuel/tyre | fuel load, tyre age, track state, session | execution noise inside one set of conditions |
| **R-B** two laps, different runs, same session | execution **+** fuel, tyre age, track evolution, traffic | car spec, circuit, **session**, weather band | the driver's brake shape as the session presented it |
| **R-C** two sessions (what v1.8 actually measured) | everything in R-B **+** session, weather, setup, ambient | driver, car, circuit, weekend | technique that survives a session boundary |

## 1.3 The decision, and the symmetry rule that forces it

> **D-1. The replicate is a replicate of the DRIVER-SESSION, not of the RUN.**
> Two stored laps are two attempts at the same lap under the conditions that session actually
> offered. The within-driver SD they estimate is the SD of that driver's brake shape across the
> session's own fuel, tyre and track-state range.

The reason is a rule, not a preference, and it is adopted as a **standing acceptance criterion
for every future technique metric in this project**:

> **SR-6 (new, v2.0). The numerator and denominator of a reported reliability must sample the
> same nuisance variables, or the ratio is not a reliability coefficient.**

The ~15 m between-driver SD in the numerator was measured across drivers sitting at different
fuel loads, tyre ages and track states. Holding those constant in the *denominator alone* is
the inflation. That is why this document refuses `quali_segment` stratification, compound
matching and tyre-age windows as selection clauses, even though each is individually
reasonable-sounding.

**The technique counter-argument is right about the mechanism and wrong about the claim.** A
brake shape that moves 8 m with 30 kg of fuel is the car changing and the driver responding
correctly, and calling that "inconsistency" is wrong. But the app's claim is a claim about a
*driver rendered against other drivers who each also drove a range of fuel loads*. The correct
way to honour the mechanism is to **regress the metric on fuel proxy and tyre age and keep the
RESIDUAL variance in the denominator** — never to condition it away in the selection rule.
That regression is a deferred follow-on (§8, WP-DEFER-1), not smuggled in here.

## 1.4 The trap above the trap — why a within-session repeat correlation is not a reliability

This is the most important subsection in the document and no source proposal states it
cleanly. **D-5 follows from it.**

Decompose the per-corner, per-lap value into four terms, normalised so they sum to 1:

| term | meaning | common across corners of one lap? | common across laps of one session? |
|---|---|---|---|
| **D** | the driver's true brake shape at this corner | no (correlated by ρ_d) | yes |
| **L_sess** | this driver's session-level offset — setup, his afternoon, his read of the track | yes | **yes** |
| **L_lap** | lap-level nuisance — fuel, tyre age, track state, that run's traffic | yes | no |
| **E** | corner-specific execution scatter — the driver getting *this corner* slightly wrong | **no** | no |

v1.8 measured **across sessions**, so `L_sess` sat in its denominator:

  ρ₁.₈ = D / (D + L_sess + L_lap + E) = **0.286**  ⟹ D = 0.286, and L_sess + L_lap + E = 0.714.

**A v2.0 replicate is two laps of the SAME session.** `L_sess` is therefore *shared between the
two replicates* — it moves out of the denominator and into the numerator:

  ρ_v2.0, within-session = (D + L_sess) / (D + L_sess + L_lap + E) ≥ 0.286, **always**.

And with n laps averaged, `L_lap` and `E` shrink by n while `L_sess` does not:

  r_n = (D + L_sess) / ((D + L_sess) + (L_lap + E)/n)  →  **1 as n → ∞.**

> **A within-session repeatability number is unbounded above. It can be driven to any value by
> adding laps, and what it converges on is "was this driver consistent on that particular
> afternoon" — not "is this driver a late braker".** Reporting it as a reliability for a driver
> rating would be the same error as the same-run trap, committed one level up, and it would be
> *invisible*, because the rule would look impeccable: different runs, different fuel loads,
> different tyre ages, nothing obviously held.

**Hence D-5: the gate is computed ACROSS sessions, on the n-lap mean.** What replication
legitimately buys is that each arm of the v1.8 paired-session experiment stops being a single
draw and becomes a mean of n:

  ρ_v2.0, across-session(n) = D / (D + L_sess + (L_lap + E)/n)

This is the only estimator in which replication helps for the right reason and cannot be
inflated by adding laps past the true ceiling. Section 3 evaluates it.

## 1.5 Bounding the ceiling — and it is low

Solve the system using v1.8's two measured altitudes: **0.286** for a single corner and
**0.412** for the driver-lap mean over k ≈ 15 corners. Averaging corners shrinks `E` by k,
leaves `L_sess + L_lap` untouched (both are common across corners), and shrinks the driver term
by the across-corner correlation ρ_d of the driver effect. Sweeping ρ_d over its full plausible
range:

| ρ_d | L_sess + L_lap | E | **corner-level ceiling** = D/(D+E) |
|---|---|---|---|
| 0.3 | 0.101 | 0.613 | **0.318** |
| 0.6 | 0.226 | 0.488 | **0.369** |
| 1.0 (max) | 0.386 | 0.328 | **0.466** |

> **Even if a selection rule eliminated ALL lap- and session-level nuisance — which no rule
> can, and which D-5 forbids you from pretending — the corner-level repeat correlation for a
> single lap tops out between 0.32 and 0.47.**

Corner-specific execution scatter `E` is the binding constraint. **No selection rule touches
`E`.** It is a fact about driving, not a fact about the corpus, and it is why this release was
always going to end in a refusal. Every rule on the table — fastest-per-run, same-segment,
same-compound, tyre-age-windowed — attacks `L`, which is the smaller term.

## 1.6 Declaration of bias direction (adopted verbatim as a standing practice)

Every SD in this document is measured on **lap time**, used as a proxy for the variance
structure of a brake metric. Three named biases all run the same way:

1. **Lap time is a 1-D sum with compensating errors.** A driver who brakes 5 m late and runs
   wide loses at the exit what he gained at entry; the lap time absorbs it, the brake metric
   does not.
2. **Push laps are right-censored at +3 %** by `is_push_lap`, which truncates the upper tail of
   the within-driver distribution.
3. **Lap time is itself the selection variable**, so the selected laps are exactly those where
   lap-time noise was small.

> **Therefore every SD quoted here is a FLOOR, every variance ratio is optimistic, and every
> predicted reliability in §3 is an UPPER bound. The true numbers are worse.**

---

# 2. The selection rule

## 2.1 Candidate set

Per `(session_id, driver_id)`, over the **75 telemetried sessions**, restricted to
`sessions.kind IN ('Q','SQ')`:

```sql
cand = laps
  WHERE is_push_lap
    AND lap_time_s IS NOT NULL
    AND stint IS NOT NULL
```

Measured: **6,779 candidate laps over 1,499 driver-sessions.**

`quali_segment` is **read and stored** for every selected lap, but is **not a filter** (D-2,
§1.3 SR-6). See §2.6 for why, and for the measurement that settled it.

## 2.2 The rule (R-SEL), implementably precise

1. **RUN-BEST.** Partition `cand` by `stint`. Take the single lowest-`lap_time_s` lap in each
   stint; ties break on lower `lap_number`. One lap per run.
2. **RANK AND CAP.** Order the run-bests by `lap_time_s` ascending, ties broken by `stint`
   ascending. Take the first **3**.
3. **ANCHOR.** The rank-1 lap is stored with `selection = 'fastest'` — **the v1.7 value,
   unchanged** (D-3). Ranks 2 and 3 are stored as `selection = 'repl_run_best'`.
4. **FALLBACK, only when step 2 yielded exactly 1 lap** (single-run driver-session): from the
   remaining laps of that one run take the lowest `lap_time_s`, tie-break on `lap_number`, and
   store it as `selection = 'repl_same_run'` — a **different, permanent** value, because it
   answers R-A, not R-B (§1.2). Capped at **1**, giving n = 2 maximum.
5. **NEVER top up.** The fallback fires only at step-2 yield exactly 1. A 2-run driver-session
   stays at n = 2; it is never raised to 3 with a same-run lap. (D-4)
6. **NEVER two laps from one run.** Guaranteed by construction at step 1 and enforced at the
   database layer by the partial unique index in §4.3 — not by a code comment.
7. **Races select nothing.** `kind = 'R'` has an empty candidate set by definition
   (`is_push_lap` is NULL for all 21 stored race laps, measured). The existing 21 race rows are
   **left exactly as they are** (D-6): not deleted, not re-derived, not relabelled.

## 2.3 Measured coverage of R-SEL against the live `laps` table

Distinct runs per driver-session, all 1,499:

| runs | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| driver-sessions | 94 | 251 | 288 | 312 | 266 | 249 | 37 | 2 |

Resulting n per driver-session:

| n | driver-sessions | share | selection values present |
|---|---|---|---|
| **3** | 1,154 | **77.0 %** | `fastest` + 2 × `repl_run_best` |
| **2** | 251 | **16.7 %** | `fastest` + 1 × `repl_run_best` |
| **2** (fallback) | 46 | **3.1 %** | `fastest` + 1 × `repl_same_run` |
| **1** | 48 | **3.2 %** | `fastest` only |

**n ≥ 2 on a between-run replicate: 1,405 driver-sessions = 93.7 %.** Mean n over the
between-run population = 2.71.

**Row totals.**

| | laps | corner rows |
|---|---|---|
| Q/SQ selected by R-SEL (steps 1–3) | **4,058** | ~67,000 |
| Q/SQ fallback (step 4) | **+46** | ~760 |
| Race, untouched (D-6) | **+21** | **231** (unchanged) |
| **`lap_telemetry` total** | **4,125** | |
| **`lap_corner_speeds` total** | | **~68,000** |

Corner-row projection uses the measured Q/SQ rate of **16.52 corner rows per lap**
(24,732 / 1,497). It assumes replicate laps carry the same corners-per-lap as anchors. That
assumption is not asserted — §6.2 turns it into a **tested** quantity via the share bands.

## 2.4 Q3 — short supply, and making mixed precision visible

**48 driver-sessions (3.2 %) ship n = 1.** They **do ship** — they keep their v1.7 anchor row
and every v1.7 reading surface renders them exactly as before — and they are **excluded from
every repeatability statistic and every error bar**, by a `WHERE` clause on `selection`, not by
a caption.

The mechanism that keeps precision visible is **estimand separation at the schema layer**:

- The pooled repeatability gate runs over `selection IN ('fastest','repl_run_best')` **only**.
- `repl_same_run` rows are a different estimand (R-A) and never enter that gate.
- `replicate_n` is a stored column (§4.2), so a surface cannot render a value without being
  able to render its n.
- The 46 fallback driver-sessions are reported as their own population, never pooled.

> A skill measured with different precision per driver is acceptable **only** when the
> precision is queryable. Three selection values and a stored `replicate_n` make it queryable.
> A footnote would not.

## 2.5 Q4 — races

**Excluded from selection, untouched in storage** (D-6). Three reasons, in order of force:

1. **There is no candidate set.** All 21 stored race laps have `is_push_lap` NULL. The rule
   does not need a race clause; it has an empty input.
2. **Race laps within one stint carry traffic, fuel burn and tyre degradation**, so any two of
   them differ by a mechanism the replicate is supposed to average over, not embody. A race
   replicate would be R-A contaminated by degradation — the worst of both.
3. **Coverage is 1 of 71.** Even a correct race rule would produce a statistic from one
   session, which is not a statistic.

The 21 rows keep `selection = 'fastest'`, their existing `derive_version`, and their existing
`ingested_at`. They get `replicate_n = 1`. No race row is written during the backfill.

## 2.6 Why R-SEL does NOT stratify by `quali_segment` — the measurement that settled it

The case for stratifying is that ranking run-bests by lap time gives a Q3 driver replicates
spanning more of the session than a Q1-eliminated driver, which is a **skill-correlated
condition mix**. That is true and it is measured:

| anchor tier | distinct `quali_segment` spanned by the top-3 | realised lap-time spread of the top-3 |
|---|---|---|
| Q1-eliminated | 1.000 | 0.612 s |
| Q2-eliminated | 1.995 | 0.611 s |
| Q3 | 2.311 | **0.616 s** |

> **The condition mix is skill-correlated. The realised denominator is not.** The spread is
> flat to three decimal places, because within-Q1 between-run SD (0.5150 s) is itself larger
> than within-Q3 (0.3644 s) and the two effects cancel.

The unstratified rule is therefore **homoscedastic across driver tiers on the available
proxy**, which removes the affirmative case for stratifying — while SR-6 supplies a positive
case against it, since the ~15 m numerator is not segment-matched either. Stratifying would
also cost coverage catastrophically: an in-segment-only rule reaches n = 3 for **8.6 %** of
driver-sessions against R-SEL's 77.0 %, and strands 21–28 % on a cross-segment pair that
cannot be pooled with the rest.

`quali_segment` is stored on every selected row anyway, and §3.7 requires the gate to report
the cross-segment share alongside the correlation — so a future reader who disagrees with this
decision can test it without a re-derive.

---

# 3. The prediction and the threshold

**Written before the measurement, with a pre-committed refusal. A threshold chosen after
seeing the number is not a threshold.**

## 3.1 The bar, derived rather than borrowed

The between-driver SD of `brake_release_to_apex_m` is ~15 m. At ρ = 0.286 that decomposes into
a **true-skill SD of 15·√0.286 = 8.0 m** and a **noise SD of 15·√0.714 = 12.7 m**. The median
pair of drivers differs in true skill by 0.6745·√2·8.0 = **7.65 m**. The decision that matters
is: *how often does the app order that median pair backwards?*

| reliability r of the reported value | median pair ordered **backwards** | ordered correctly |
|---|---|---|
| 0.40 | 28.5 % | 71.5 % |
| 0.50 | 25.0 % | 75.0 % |
| 0.60 | 19.8 % | 80.2 % |
| **0.70** | **15.1 %** | **84.9 %** |
| 0.80 | 10.0 % | 90.0 % |

> **BAR: a trail-braking driver rating ships at aggregate reliability ≥ 0.70**, the point where
> the median pair is ordered correctly ~85 % of the time. Below that, roughly one comparison in
> four is backwards and the app is asserting a driver difference it cannot see.
>
> Cross-check: the project's own shipped precedent, `one_lap_pace`, has a split-half
> reliability of **0.773**. The 0.70 bar is *below* the standard this project has already
> shipped to, so it is not a stretch bar.

## 3.2 The estimator being predicted (D-5)

**ACROSS sessions, on the n-lap mean:**

  ρ_v2.0(n) = D / ( D + L_sess + (L_lap + E)/n )

with D = 0.286 and L_sess + L_lap + E = 0.714 from §1.4, and the L/E split bounded by the
ρ_d sweep of §1.5. This is the v1.8 experiment with each arm upgraded from one draw to a mean
of n. It is the only estimator that improves for the right reason.

## 3.3 The prediction

At R-SEL's measured coverage (n = 3 for 77.0 %, mean n = 2.71):

| altitude | v1.8 measured (n = 1) | **v2.0 predicted (n = 3)** | bar | verdict |
|---|---|---|---|---|
| **single corner** — the surface users want | 0.286 | **0.36 – 0.52** | 0.70 | **fails, not close** |
| **driver-lap mean** over ~15 corners | 0.412 | **0.42 – 0.68** | 0.70 / 0.773 | **fails at both ends of the range** |

Both bands are **upper** bounds, because §1.6 declares every input SD to be a floor.

**Prediction: trail braking does not ship as a rating. Confidence ~85/15.** The 15 % is the
case where L_sess ≈ 0 *and* ρ_d is low *and* the lap-time proxy understates the addressable
share — three optimistic things at once.

## 3.4 The flattering numbers, priced so they are on the page as REFUSED numbers

Two rules would have cleared the bar while measuring nothing about the driver. Both are
computed in the same framework as §3.3:

| rule | what it holds shared between replicates | reported at n = 3 | clears 0.70? |
|---|---|---|---|
| **R-A, same run** | L_sess **and** L_lap | **0.65 – 0.86** | yes, at the top |
| **within-session between-run** (R-SEL scored the careless way) | L_sess | **0.55 – 0.86** | yes, at the top |
| **R-SEL scored across sessions (D-5)** | nothing | **0.36 – 0.52** | **no** |

> Read the second row twice. **R-SEL is the rule this document proposes, and scored
> within-session it would report up to 0.86 and look shippable.** The rule is not what protects
> this release from the trap — **D-5 is.** A correct rule scored the wrong way produces the
> flattering number just as reliably as a bad rule.

## 3.5 How precisely will we know the answer? — a correction the source proposals got wrong

All three proposals claim the pooled repeat correlation gets a standard error of ~0.03 from
"~1,000–1,400 driver-sessions at n ≥ 2". **That denominator is the within-session population,
which D-5 forbids.** The across-session design has far fewer units, and I measured it:

| | count |
|---|---|
| Q/SQ same-event driver pairs over telemetried sessions | **263** |
| …with n ≥ 2 in **both** arms (usable under D-5) | **212** |
| …with n ≥ 3 in both arms | **140** |

- **Driver-lap-mean estimate: 212 independent pairs → SE(ρ) ≈ 1/√209 = 0.069.**
- **Corner-level estimate:** ~212 × ~15 corner observations, clustered within driver. Effective
  N lies between 212 and ~3,180; **SE ≈ 0.03–0.07** depending on how strong the within-driver
  clustering turns out to be, which §1.5 says is itself uncertain.

This is still worth having — a ±0.07 answer distinguishes 0.45 from 0.70 comfortably — but the
claim "SE 0.03" must not be repeated without the qualifier. **A predicted 0.42–0.68 measured
with SE 0.069 will not resolve to a clean yes or no at the aggregate altitude.** §9 R3 carries
that as a named risk with a pre-committed response.

## 3.6 The cross-driver corner delta is refused separately, on MISSINGNESS

Even at an acceptable ρ, a ranked cross-driver corner delta is refused, because the
availability of a replicate is **not random**:

- 3.2 % of driver-sessions are n = 1 outright, and a further 3.1 % carry only a same-run
  fallback that cannot enter the gate — so **6.3 % have no between-run replicate at all**.
- Under the more conditioned rules the source proposals considered, that figure reaches
  **32.4 %**, with mate availability worst when the anchor is in **Q3 (61.1 %)** against
  **Q1 (74.6 %)** — i.e. missing precisely for the pole laps readers ask about.

> **A cross-driver comparison whose precision is worst exactly where attention is highest is
> not a comparison.** R-SEL's own 6.3 % is far better than 32.4 %, which is one of the reasons
> it is the chosen rule — but the veto is recorded as a standing test, not as a number that
> happened to come out acceptable this time.

## 3.7 Pre-committed responses (written down before WP8 runs)

| measured across-session corner-level ρ | response |
|---|---|
| **< 0.60** | Refuse. Ship §7's reading + `measured = false`. Expected outcome. |
| **0.60 – 0.70** | Refuse the rating; publish the number and the gap; re-open only with a fuel/tyre residual model (WP-DEFER-1). |
| **> 0.70** | **Do not ship on the strength of it.** First check §3.8. A number this far above prediction is more likely a scoring error than a discovery. |
| **≈ 0.65 – 0.86 at any altitude** | Treat as the §3.4 signature. Almost certainly the gate was scored within-session or on same-run pairs. **A bug, not a result.** |

**Change-my-mind threshold, pre-registered:** measured **across-session driver-lap-mean ρ above
0.66** would put the aggregate surface within one SE of the 0.70 bar and would make it
arguable. I do not expect it.

## 3.8 The tripwire that must be reported beside every correlation

> **Every reported repeat correlation must be accompanied by (a) the share of contributing lap
> pairs that share a `stint`, and (b) the share that are within-session.**
>
> Under R-SEL + D-5 both shares must be **exactly 0.00 %**. They are not diagnostics; they are
> the proof that the number means what the caption says. A correlation reported without them is
> not reviewable and must be rejected at review.

---

# 4. The contract, migration 0011, and backward compatibility

## 4.1 The widened CHECK

Current, in `web/db/schema/telemetry.ts` (~line 117) and in the database:

```sql
check("lap_telemetry_selection_check", sql`selection IN ('fastest')`)
```

v2.0:

```sql
CHECK (selection IN ('fastest', 'repl_run_best', 'repl_same_run'))
```

| value | MEANS | estimand | enters the §3 gate? |
|---|---|---|---|
| **`fastest`** | The driver's fastest valid push lap of the session. **Identical meaning to v1.7.** Exactly one per `(session_id, driver_id)`, for qualifying and for races. | anchor | **yes** |
| **`repl_run_best`** | The fastest push lap of a **different run** in the same session, rank 2 or 3 by lap time. | R-B — between-run, within-session | **yes** |
| **`repl_same_run`** | The fallback lap for a **single-run** driver-session: the second-fastest push lap **of the anchor's own run**. Capped at one. | R-A — within-run | **NO, permanently** |

> **`repl_same_run` has its own permanent value precisely so that it can never be blended with
> a between-run replicate inside one driver-session.** It is a different estimand (§1.2) and the
> gate excludes it with a `WHERE`, not with a caption. This is the mechanism that keeps mixed
> precision visible at the schema layer. (D-4)

## 4.2 New columns

```sql
ALTER TABLE lap_telemetry
  ADD COLUMN replicate_rank  smallint NOT NULL DEFAULT 1,   -- 1 = anchor, 2, 3
  ADD COLUMN replicate_n     smallint NOT NULL DEFAULT 1,   -- n stored for this driver-session
  ADD COLUMN stint           smallint,                      -- the run this lap came from; NULL for races
  ADD COLUMN quali_segment   text,                          -- stored, NEVER a filter (§2.6)
  ADD COLUMN same_segment    boolean,                       -- this lap's segment = anchor's segment
  ADD COLUMN selection_pass  smallint NOT NULL DEFAULT 0,   -- 0 = not yet through the v2.0 selector
  ADD COLUMN selection_hash  text;                          -- §5.4 staleness key
```

- **`replicate_n` is stored, not derived at read time**, so no surface can render a value
  without being able to render its n. (§2.4)
- **`same_segment` is a column, not a comment** — §9 R2. It exists so that a future reader who
  wants to test the stratification decision of §2.6 can do it with a `WHERE`, and so that
  cross-segment pairs can never be *silently* pooled.
- **`quali_segment` is stored and is never a filter.** SR-6, §1.3.

## 4.3 The index that makes D-4 a database fact

```sql
-- One anchor per driver-session. Was a property of the selector in v1.7; becomes a fact.
CREATE UNIQUE INDEX lap_telemetry_anchor_unique
  ON lap_telemetry (session_id, driver_id) WHERE selection = 'fastest';

-- Never two laps from one run inside one driver-session (D-4). Exact form in §4.4.
CREATE UNIQUE INDEX lap_telemetry_one_lap_per_run
  ON lap_telemetry (session_id, driver_id, stint)
  WHERE stint IS NOT NULL AND selection <> 'repl_same_run';
```

> **The first index is the backward-compatibility argument, not a footnote to it.** Every
> existing `WHERE selection = 'fastest'` query in the codebase becomes a **stronger** guarantee
> after 0011 than it had in v1.7: the uniqueness it has always implicitly relied on stops being
> a property of the selection code and becomes enforced by the database. v2.0 does not ask
> those queries to change; it hardens them.
>
> The second index makes the same-run trap **unrepresentable** for every selection value that
> enters the §3 gate. The single deliberate exception is `repl_same_run`, and §4.4 states it.

## 4.4 The one exception, stated rather than hidden

`repl_same_run` shares a `stint` with its anchor **by definition** — that is what makes it a
different estimand — so it is excluded from `lap_telemetry_one_lap_per_run` by that index's
`selection <> 'repl_same_run'` clause. The exception is then capped at one row per
driver-session:

```sql
-- at most one fallback per driver-session, and only when there is no repl_run_best
CREATE UNIQUE INDEX lap_telemetry_fallback_unique
  ON lap_telemetry (session_id, driver_id) WHERE selection = 'repl_same_run';
```

The "no `repl_run_best` alongside it" clause is not expressible as an index and is asserted by
`replication_census.py` (§6.3) instead, which is stated here so that the gap is on the record.

## 4.5 How a reader tells a v1.7 row from a v2.0 row

The honest answer is that **the anchor row is byte-identical under v1.7 and v2.0 by design
(D-3), so nothing distinguishes it and nothing should try.** That is the point of D-3, not a
weakness of it.

The question a reader actually needs answered is different, and `selection_pass` answers it:

| `selection_pass` | meaning |
|---|---|
| `0` | This driver-session has **not** been through the v2.0 selector. `n = 1` means *unknown*. |
| `1` | Through the v2.0 selector. `n = 1` means **evaluated and no between-run replicate exists** (48 driver-sessions), which is a finding. |

Without this column, `replicate_n = 1` means two different things and a reader cannot tell
which. Races keep `selection_pass = 0` permanently (D-6), which is correct: they were never
evaluated.

Secondary discriminators, all still true because D-3 forbids relabelling:

- `selection <> 'fastest'` ⟹ v2.0 row, unambiguously. **No v1.7 path could emit those values.**
- `derive_version = 3` ⟹ re-derived under v2.0 (§5.3). Legacy anchors that are not re-derived
  keep `2`.
- `replicate_rank > 1` ⟹ v2.0 row.

## 4.6 Rollback

```sql
DELETE FROM lap_telemetry WHERE selection <> 'fastest';
DELETE FROM lap_corner_speeds cs WHERE NOT EXISTS (
  SELECT 1 FROM lap_telemetry t WHERE t.session_id=cs.session_id
    AND t.driver_id=cs.driver_id AND t.lap_number=cs.lap_number);
UPDATE lap_telemetry SET selection_pass = 0;
-- then revert migration 0011 (drops the columns, the indexes and the widened CHECK)
```

**This restores the exact 1,518-row v1.7 corpus, and it does so because D-3 guaranteed that no
`fastest` row was ever deleted, relabelled or re-derived.** A rule that renamed the anchor could
not offer this. That is the single strongest reason D-3 is a fixed decision.

## 4.7 Backward compatibility, precisely

**The migration is additive in DDL. It is NOT additive in row semantics**, and that distinction
is the whole risk of this release:

- `SELECT ... FROM lap_telemetry WHERE session_id=? AND driver_id=?` returned exactly 1 row in
  v1.7 and returns up to 3 in v2.0.
- `JOIN lap_corner_speeds` on `(session_id, driver_id)` without `lap_number` duplicates every
  corner 2–3×.

Three such call sites exist today and are **verified in source**. §8 WP1 fixes all three and
ships them **before** the DDL. §6.4 lists the full audited surface.

Also changed: `web/db/schema/telemetry.ts` line ~79 `.default("fastest")` stays (the anchor is
still the default write) and line ~117's `check(...)` widens. **The drizzle drift check will
fail against 0011 until the schema file is updated in the same commit.**

---

# 5. Cost, pipeline and idempotency

## 5.1 Q7 — wall clock, read off the corpus rather than modelled

**Zero API calls.** `TELEMETRY_SPEC` §3.5: `--force` re-reads the FastF1 cache. Nothing is
downloaded. The cost is CPU and wall clock only.

**The v1.8 backfill's actual cost is recorded in the corpus and nobody had to guess it:**

```sql
SELECT min(ingested_at), max(ingested_at) FROM lap_telemetry;
-- 2026-09-17 20:26:40.669 -> 2026-09-17 22:20:59.967
```

> **114.3 minutes, for 75 sessions and 1,518 laps.**

Every prior estimate in this project's design round was wrong, all in the same direction: 7–9
minutes (30× low), 17 minutes (6.7× low), 35–45 minutes (3× low). **Model unit costs from the
spec are not a substitute for reading the column.**

## 5.2 Scaling it

Total time T = (75 × F) + (1,518 × P), where F is the per-session FastF1 cache load and P is
the per-lap derive. **The session count does not change; the lap count goes from 1,518 to
4,125 (2.72×).** So the scaling depends entirely on the F/P split — which the corpus does
*not* record, and which nobody has measured:

| assumed F (per session) | implied P | **v2.0 projection** |
|---|---|---|
| 5.1 s (`TELEMETRY_SPEC` §3.2's figure) | 4.27 s/lap | **5.0 h** |
| 40 s | 2.54 s/lap | **3.7 h** |
| 80 s | 0.57 s/lap | **2.3 h** |

> **Budget 4 hours. Honest range 2.5 – 5.2 h. I cannot narrow it without running the pipeline,
> which is forbidden while the corpus is pinned.**

The optimistic end requires F to dominate, and I do not believe it does: `lap_corner_speeds`
goes from 24,963 to ~68,000 rows and the five trail gates run per corner row — that work is
unambiguously per-lap. **The 2.0–2.6 h figure circulating from the design round is the
optimistic endpoint of an unmeasured split, presented as a measurement. It is not one.**

**WP0 replaces this table with one number** (§8): one session, timed, on a scratch copy, before
anything else is scheduled. **Stop-and-re-scope gate at 4 h extrapolated.**

## 5.3 This is deliberately over the investigate-anything threshold

A 2.5–5 h backfill is far past the 30–45 minute mark at which this project investigates a
hang, and this project has been killed four ways by silent long-running work. The backfill is
therefore specified as:

- **Per-session commit**, not one transaction. A kill loses at most one session.
- **Progress to stdout every session**, with a running count and an ETA.
- **Resumable by construction**: the skip condition (§5.4) means a re-run picks up exactly
  where it stopped and re-does nothing.
- **Run under `nohup` with a log file**, never in an agent's foreground.

`derive_version` moves **2 → 3**. `TRAIL_DERIVE_VERSION = 3` (currently `f1lab/telemetry.py:111`).

## 5.4 Idempotency — and the gap that v1.8 did not have

Three keys, and today only two exist:

| key | covers | exists? |
|---|---|---|
| `source_hash` | the raw FastF1 channels for one lap | yes |
| `derive_version` | the derivation recipe | yes (`:111`) |
| **`selection_hash`** | **which laps were picked** | **NEW — §4.2** |

**The gap, stated precisely.** `stored_hashes` (`f1lab/telemetry.py:935`) keys on the laps
**already stored**. If an upstream `laps` repair moves a `stint` boundary or flips an
`is_push_lap`, the correct pick changes — but every stored lap's `source_hash` still matches,
so the skip condition passes and **the stale pick is never noticed.**

> **v1.8 was immune to this only because a minimum is stable.** The fastest lap of a
> driver-session rarely changes when a stint boundary moves. A *rank-2 run-best* changes
> constantly. A multi-lap rule needs a key that v1.8 did not.

**Definition.** `selection_hash` = SHA-256 over the driver-session's full candidate tuple list,
sorted: `[(lap_number, lap_time_s, stint, quali_segment), ...]` from §2.1's `cand`. It is
computed **before** any telemetry is loaded and stored on every row of that driver-session.

**Skip condition, v2.0:**

```
skip a driver-session iff
      selection_hash matches
  AND selection_pass = CURRENT_SELECTION_PASS
  AND every stored lap's source_hash matches
  AND every stored lap's derive_version = TRAIL_DERIVE_VERSION
```

Any mismatch ⟹ **delete the driver-session's non-anchor rows and re-pick.** The anchor row is
re-derived in place, never deleted, so D-3 and §4.6's rollback survive.

## 5.5 `CURRENT_SELECTION_PASS`

A module constant beside `TRAIL_DERIVE_VERSION`, starting at **1** (legacy rows default to 0,
§4.2).

> **Rule: any change to any clause of §2.2 bumps `CURRENT_SELECTION_PASS` in the same commit.**

`source_hash` covers the channels. `derive_version` covers the recipe. **Nothing today covers
the selection rule**, so without this constant a tuning change would leave the table holding a
silent union of two rules with no way to tell which row came from which.

## 5.6 What re-derives and what does not

| | action |
|---|---|
| The 21 race rows | **Nothing.** Not touched, not re-derived, `selection_pass` stays 0. (D-6) |
| The 1,497 Q/SQ anchors | Re-derived in place at `derive_version = 3`; `selection` **unchanged**; new columns populated. |
| 2,559 `repl_run_best` rows | Inserted. |
| 46 `repl_same_run` rows | Inserted. |
| 2 driver-sessions with push laps but **no** `lap_telemetry` row | **Measured and reconciled here so no work package asserts a wrong total.** 1,499 driver-sessions have candidates; only 1,497 have a stored row. The backfill attempts them; if FastF1 yields telemetry the totals rise by up to 2 anchors + 5 replicates. **No acceptance test may hard-assert 1,499 anchors.** It asserts `>= 1,497` and reports the delta. |
| `lap_corner_speeds` | Fully re-derived for every Q/SQ lap (24,732 → ~67,800 rows); the 231 race rows untouched. |

---

# 6. The pinned constants and the two no-drift checks

**This section is the blast radius. Every literal below was read from source, not asserted.**

## 6.1 The count constants that MOVE — `f1lab/telemetry.py:141` and `:143–175`

The backfill **asserts** these. `f1lab/telemetry.py:138`'s own rule applies: *"the build fails
on any other value, because zero is not the only wrong answer."* Under R-SEL, every one of them
scales by ~2.72× and the build fails on session 1 unless they are repinned **in the same commit
as the backfill**.

| constant | line | v1.8 value | v2.0 |
|---|---|---|---|
| `TRAIL_CORNER_ROWS` | 141 | 24,963 | repin |
| `TRAIL_FLAT_ROWS` | 143 | 4,642 | repin |
| `TRAIL_BRAKED_ROWS` | 144 | 20,321 | repin |
| `TRAIL_NON_TERMINAL_ROWS` | 150 | 8,976 | repin |
| `TRAIL_TERMINAL_ROWS` | 152 | 11,345 | repin |
| `TRAIL_EXPECTED_MEASURED_ROWS` | 154 | 9,409 | repin |
| `TRAIL_R3_COST_ROWS` / `_UNCONDITIONAL` | 173–174 | 1,184 / 1,702 | repin |
| `TRAIL_R4_COST_ROWS` / `_UNCONDITIONAL` | 170–171 | 54 / 126 | repin |
| `TRAIL_R5_COST_ROWS` / `_UNCONDITIONAL` | 175–176 | 698 / 1,415 | repin |

## 6.2 The shares — pinned ALONGSIDE the counts, with a ±1.5 pp band (D-8)

**This is the successor to the arithmetic-identity test and the most transferable idea in this
release.** After a deliberate row-count change, an absolute count carries no information: any
new number is "expected". A **share** does.

| share | denominator | v1.8 | band |
|---|---|---|---|
| flat | corner rows | **18.60 %** | ±1.5 pp |
| non-terminal | corner rows | **35.96 %** | ±1.5 pp |
| measured | corner rows | **37.69 %** | ±1.5 pp |
| terminal | corner rows | **45.45 %** | ±1.5 pp |
| R3 unconditional | braked rows | **8.38 %** | ±1.5 pp |
| R4 unconditional | braked rows | **0.62 %** | ±1.5 pp |
| R5 unconditional | braked rows | **6.96 %** | ±1.5 pp |

> **A share that moves more than ±1.5 pp means the selection rule changed *what kind of lap is
> in the corpus* — which is a real finding about R-SEL, and exactly the thing a raw count
> change would have hidden.** Treat it as a release failure and investigate before shipping.

This also **tests** §2.3's unexamined assumption that replicate laps carry the same
corners-per-lap as anchors. If rank-2 and rank-3 run-bests are systematically different laps —
more lifting, more traffic — the flat share moves and the release stops.

## 6.3 The quantile constants that must NOT move — a free correctness check

`TRAIL_RELEASE_STEP_MEDIAN_M = 4.13`, `_P90_M = 10.47`, `_P95_M = 13.34`
(`f1lab/telemetry.py:163–165`) are properties of **10 Hz sampling**, not of the corpus census.

> **2.72× more laps of the same sampling must NOT move them. A move of more than 10 % in the
> p95 is a release failure.**

Nobody noticed there was a free check sitting here. There was.

`tests/test_telemetry.py:260` additionally asserts
`1.7 <= TRAIL_MAX_RELEASE_STEP_M / TRAIL_RELEASE_STEP_P95_M <= 2.3`. That assertion **survives
unchanged** and is the reason the p95 check is not merely advisory.

## 6.4 `tests/test_telemetry.py:251–260` — the test no proposal gave an owner

```python
def test_the_pinned_census_partitions_without_remainder():
    assert T.TRAIL_CORNER_ROWS == T.TRAIL_FLAT_ROWS + T.TRAIL_BRAKED_ROWS
    assert T.TRAIL_BRAKED_ROWS == T.TRAIL_NON_TERMINAL_ROWS + T.TRAIL_TERMINAL_ROWS
    assert T.TRAIL_TERMINAL_ROWS == (T.TRAIL_EXPECTED_MEASURED_ROWS + T.TRAIL_R3_COST_ROWS
                                     + T.TRAIL_R4_COST_ROWS + T.TRAIL_R5_COST_ROWS)
    assert T.TRAIL_CORNER_ROWS == 24_963 and T.TRAIL_NON_TERMINAL_ROWS == 8_976   # <-- line 257
```

- The **three identity equations survive unchanged** — they are a free correctness check that
  v2.0 gets for nothing, and they must not be relaxed.
- **Line 257's two hard literals turn the suite red on repin.** They are edited in the **same
  commit** as §6.1, and the new share assertions of §6.2 are added beside them.
- **Owner: WP5.** This file is in exactly one work package's ownership list (§8), because the
  suite is the one thing nobody is allowed to run to find out.

## 6.5 The two no-drift checks (D-9)

`scripts/verify/no_drift_telemetry.py:185–197` reads its session set from the **pre-re-derive
snapshot** (`corpus_sessions(before)`), not from a literal. So the invariant it actually asserts
is **idempotency of the derivation**, not constancy of the census.

> **It is therefore not weakened. It is run twice.**

| run | when | against | expectation |
|---|---|---|---|
| **1** | before migration 0011 | the v1.7 corpus | zero rows differ — proves the pipeline is idempotent *before* anything changes |
| **2** | after the backfill | a fresh post-backfill snapshot | zero rows differ — proves it is idempotent *after* |

A **new** `scripts/verify/replication_census.py` owns the **expected** change and asserts:

1. `selection` takes only the three permitted values; `CHECK` is present.
2. **≥ 1,497 anchors** exist, all with `selection = 'fastest'` (§5.6 — **not** an equality on
   1,499; the 2 candidate driver-sessions with no telemetry row are reported as a delta).
3. **Zero** qualifying anchors changed `lap_number`. Measured premise: **1,497 of 1,518 stored
   rows are exactly the rank-1 run-best of their driver-session, and the other 21 are the race
   session, which has no push laps. ZERO qualifying rows disagree.**
4. Race rows: exactly **21**, `selection='fastest'`, `selection_pass = 0`, `ingested_at`
   unchanged, `lap_corner_speeds` still **231** rows.
5. n-distribution matches §2.3: 1,154 / 251 / 46 / 48.
6. No driver-session holds both a `repl_run_best` and a `repl_same_run` row (§4.4's
   inexpressible clause).
7. The §6.2 share bands.

> **Neither check is relaxed. One says the derivation is deterministic; the other says the
> selection is the one that was designed.**

## 6.6 The census literal, corrected

The design round circulated **"21 R + 3 Q"** and **"21 R + 2 Q"** as the count of stored rows
that are not the new rank-1 run-best, and one proposal wired a build gate to it. **Both are
wrong. Measured, two ways:**

```
stored rows                                        1518
stored rows == rank-1 run-best                     1497
stored rows with no candidate at all (the race)      21
stored Q/SQ rows that disagree                        0
```

> **The correct literal is 21 R + 0 Q.** An acceptance test asserting 3 or 2 would have failed
> on its first run against the live corpus.

## 6.7 The untyped contract — the ask surface, in FOUR places not two

`ask.lap_telemetry_summary`'s grain is stated in **prose**. No type, no `CHECK`, no test guards
it, and it fails by producing **confidently wrong answers with no error anywhere** — an LLM
told "one lap per driver" and handed three will average nothing and explain nothing.

| file | line | text |
|---|---|---|
| `scripts/ask_manifest.yml` | **155** | `grain: session x driver x lap - ONE lap per driver per session, that driver's fastest, and no other` |
| `scripts/ask_manifest.yml` | **494–512** | the aggregation-ban block |
| `web/lib/ask/schema-doc.txt` | **63** | the same grain sentence |
| `web/lib/ask/schema-doc.txt` | **219+** | the aggregation-ban block |

The design round named only the two ban blocks. **The two grain lines at `:155` and `:63` are
equally false after 0011 and are the ones an LLM reads first.**

**Rule: the ban is rewritten STRICTER, never deleted.** It gains the newly reachable trap — *an
aggregate that fails to filter `selection` silently triples every corner* — and `selection`,
`replicate_n` and `replicate_rank` are exposed on `ask.lap_corner_speeds` and
`ask.lap_telemetry_summary` so that the correct query is expressible at all.

**`not_measured_reason: trail_braking` and the no-rating sentence are kept VERBATIM.** §3 makes
them more true, not less.

## 6.8 Also in the blast radius

- `f1lab/frames.py:514–517` lists `selection` as a **pre-0010** `lap_telemetry` column, so it
  sits under no-drift's zero-difference rule. **D-3 means we never write it on a legacy row**,
  so no exemption is needed. This is a second, independent reason D-3 is not negotiable.
- `f1lab/frames.py` `EXPECTED_COLUMNS` gains the seven new columns of §4.2 — a **type**
  declaration, not a value one.
- `web/db/schema/telemetry.ts:~117` — the widened `check(...)`; drizzle drift fails until updated.
- `scripts/warm_telemetry.py:338–339` prints the `TRAIL_*` constants; cosmetic, but it is a
  reader and belongs on the list.
- `f1lab/telemetry.py:1267` (`"rows": TRAIL_CORNER_ROWS`) — a reporting path that repins with §6.1.

---

# 7. Surfaces and VERBATIM captions

## 7.1 The three read-side bugs, verified in source

All three are **correct today only because exactly one row exists per driver-session**. Each
becomes a silent-wrong-answer bug the instant 0011 lands. None throws; none fails a type check;
none is covered by a test.

| # | site | today | after 0011 |
|---|---|---|---|
| **B1** | `web/lib/queries/telemetry.ts:318–319` — `.where(and(eq(sessionId), eq(driverId))).limit(1)`, **no `selection` filter, no `ORDER BY`** | returns the one row | returns an **arbitrary** row — a Q1 run rendered under a pole-lap caption |
| **B2** | `web/lib/queries/telemetry.ts:466–470` — corner fetch on `sessionId` + `inArray(driverIds)`, **no lap or selection restriction** | one set of corners | **every corner duplicated 2–3×** on the track map and in the corner card |
| **B3** | `web/lib/queries/telemetry.ts:139–145` — `leftJoin(lapTelemetrySummary)` on `(sessionId, driverId)`, **no `lapNumber`** | one pill per driver | **the driver pill list silently triples** |

**Fixes:** B1 gains `eq(lapTelemetry.selection, "fastest")` **and** an explicit
`orderBy(asc(lapTelemetry.replicateRank))`; B2 and B3 gain the same `selection = 'fastest'`
restriction. In every case the anchor is the row the existing caption already promises.

> **These ship ALONE and FIRST (§8 WP1), before any DDL.** Against the pinned corpus they are
> **no-ops** — provably, because §6.6 measured that exactly one `fastest` row exists per
> driver-session — so the commit is fully testable on the release under verification and cannot
> break anything. A CI grep is a weaker instrument than three fixes that have already landed.

## 7.2 Release order (non-negotiable)

```
1. WP1  three query fixes                  -> main.  Zero rows change. Byte-identical render.
2. WP2  migration 0011                     -> DDL only. ZERO ROWS CHANGE.
3. WP3+ the backfill                       -> rows change for the first time.
```

Steps 1 and 2 are **independently revertible** and each is a no-op against a corpus under
verification. For a project whose release is pinned, that ordering is worth more than any
statistic in this document.

## 7.3 What ships on the corner card

**The reading, with its error bar and its n.** Not a rating, not a rank, not a percentile.

- n = 3 or n = 2 (`repl_run_best`): value rendered as the **mean**, with the per-driver-session
  SD beside it and `n` stated.
- n = 2 (`repl_same_run`): value rendered as the mean, `n` stated, and **flagged as same-run**.
  It is not comparable with a between-run error bar and the surface must not present it as one.
- n = 1 (48 driver-sessions): rendered exactly as in v1.7, **greyed**, with no error bar.

## 7.4 VERBATIM captions

Use these strings exactly. They are load-bearing; each was written against a specific way this
release can be misread.

**Corner card, n ≥ 2, between-run:**

> `Brake release to apex: 37 m ± 6 m (mean of 3 laps, one from each of 3 runs).`

**Corner card, the two-attempt reading:**

> `34 m and 41 m on his two Q2 runs.`

**Corner card, n = 2 same-run fallback:**

> `Brake release to apex: 37 m (mean of 2 laps from the same run — this driver ran once. Not comparable with the 3-run figures.)`

**Corner card, n = 1:**

> `Brake release to apex: 37 m. One lap only — no repeat measurement.`

**Method note, wherever a trail-braking number appears:**

> `Each figure is the mean of up to 3 qualifying laps, one per run. Laps from the same run are never combined, because they share fuel load, tyre age and track state and would make the driver look more consistent than he is.`

**The refusal, `measured = false`, `not_measured_reason: trail_braking` (D-10):**

> `We do not rate trail braking. We measured how repeatable it is: a driver's brake shape at one corner repeats across sessions at r = <MEASURED>, against the r = 0.70 a driver rating needs. Most of what varies is execution at that specific corner, which storing more laps does not fix.`

**The tooltip that must exist wherever two values are shown side by side (§3.8):**

> `Two separately-prepared attempts. Seeing them agree does not mean the driver is consistent across sessions — that is a different question, and §3 of REPLICATION_SPEC answers it.`

## 7.5 The caption rule this release adds

> **No trail-braking value may render without `replicate_n` rendered in the same visual unit.**
> Not in a tooltip, not in a legend, not in a footnote. `replicate_n` is a stored column (§4.2)
> precisely so that this rule is enforceable at the query layer rather than trusted at review.

## 7.6 The refusal must be able to expire

The `measured = false` row is accompanied by a test shaped like the existing
`test_tyre_rejection_still_holds`, asserting that the measured correlation is still below the
§3.1 bar. **If a future corpus lifts it, the test fails and the refusal is revisited** — so
that a measured refusal cannot quietly become a permanent omission.

**`TELEMETRY_SPEC` SR-5 is not deleted by this release.** It is either satisfied or **restated
with the measured `E` term as its new reason**. §3's prediction is that the second happens.

---

# 8. Work packages

**Single-owner file ownership. No file appears in two packages.** Sequencing is strict where
arrows are drawn; everything else may run in parallel.

```
WP0 ──> WP1 ──> WP2 ──> WP3 ──> WP4 ──> WP5 ──> WP6 ──> WP7 ──> WP8 ──> WP9
(cost)  (web)   (DDL)  (rule) (backfill)(pins) (verify)(gate) (surfaces)(as-built)
                         └────> WP4a (ask surface, parallel with WP4-WP6)
```

| WP | Owns (exclusively) | Does | Verification |
|---|---|---|---|
| **WP0** | `output/wp0/` only | One session, timed, on a **scratch copy**, to replace §5.2's table with one number. Reports F and P separately. | A measured F/P split. **Stop-and-re-scope gate: extrapolated total > 4 h.** |
| **WP1** | `web/lib/queries/telemetry.ts` | Fix B1, B2, B3 (§7.1). **Ships alone, to main, first.** | Rendered output **byte-identical** against the pinned corpus. Plus an adversarial test seeded with 3 synthetic rows asserting the pill list returns the driver **once** — **this test must FAIL against today's code; if it passes pre-fix, the test is wrong.** |
| **WP2** | `db/migrations/0011_replication.sql`, `web/drizzle/0011_*`, `web/db/schema/telemetry.ts` | Widened `CHECK`, seven columns, three partial unique indexes (§4.1–4.4). | **ZERO ROWS CHANGE.** `SELECT count(*) FROM lap_telemetry` = 1,518 before and after. Drizzle drift check clean. |
| **WP3** | `f1lab/telemetry.py` — `select_laps` (`:287`), `SELECTION` (`:54`), `CURRENT_SELECTION_PASS` (new, beside `:111`) | Implement R-SEL (§2.2) + `selection_hash` (§5.4). **No backfill run.** | Unit test: the rule reproduces §2.3's 1,154 / 251 / 46 / 48 **against `laps` alone**, no telemetry needed. |
| **WP4** | `f1lab/telemetry.py` — `_write_session` (`:1049`), `stored_hashes` (`:935`), the `--force` path | Per-session commit, progress to stdout, resumable skip condition (§5.3–5.4). Then **run the backfill** under `nohup`. | Kill mid-run, restart, confirm it resumes and re-does nothing. |
| **WP4a** | `scripts/ask_manifest.yml`, `web/lib/ask/schema-doc.txt` | Rewrite the grain lines (`:155`, `:63`) and the ban blocks (`:494–512`, `:219+`) **stricter**; expose `selection` / `replicate_n` / `replicate_rank` (§6.7). | `not_measured_reason: trail_braking` and the no-rating sentence **diff-clean (verbatim)**. |
| **WP5** | `tests/test_telemetry.py` | Repin line 257's literals; add the §6.2 share assertions. **Same commit as WP6's repin.** | The three identity equations still pass **unmodified**. The p95 ratio assertion at `:260` still passes. |
| **WP6** | `f1lab/telemetry.py:141`, `:143–176`; `f1lab/frames.py` `EXPECTED_COLUMNS`; `scripts/warm_telemetry.py:338–339` | Repin the count constants; add the shares (§6.1–6.2). | Shares within ±1.5 pp. **Step quantiles moved < 10 %.** |
| **WP7** | `scripts/verify/replication_census.py` (**new**) | The seven census assertions of §6.5. Runs `no_drift_telemetry.py` **twice, unmodified**. | Run 1 (pre-0011) and run 2 (post-backfill) both report **zero rows differing**. Census passes. |
| **WP8** | `scripts/measure_repeatability.py` (**new**), `docs/GAPFILL_SPEC.md` §3.4 / DL-21 | Compute the **across-session** repeat correlation on the n-lap mean (D-5) over the **212 usable pairs** (§3.5). Report the §3.8 tripwires. | **Owns no UI file**, so it cannot ship a skill. §3.7's thresholds are already written; it reports against them and does not choose them. |
| **WP9** | `web/lib/queries/*` (read paths), corner-card components, `docs/REPLICATION_SPEC.md` §11 | Ship §7.3–7.5's reading, error bar and captions. Write the `measured = false` row and its expiry test (§7.6). Fill §11. | No value renders without `replicate_n` in the same visual unit. Expiry test present and passing. |
| **WP-DEFER-1** | — | **Not in this release.** Regress the brake metric on fuel proxy and tyre age; keep the RESIDUAL variance in the denominator (§1.3). Named so it is not smuggled in as a selection clause. | — |

## 8.1 Why WP8 owns no UI file

Deliberate. The package that measures the number must not be able to ship a surface based on
it, and §3.7's thresholds are written into this spec **before** WP8 runs. This project has
refused three skills; the structural way to make a fourth refusal easy is to separate the
measurement from the shipping.

---

# 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **The flattering number arrives LATER**, not now — a future reader "improves" coverage by rescuing n = 1 driver-sessions with same-run laps, or pools `repl_same_run` into the gate, or pools cross-segment pairs silently. | `repl_same_run` is a **permanent separate value** (§4.1); `same_segment` is a **stored column** (§4.2); the gate's `WHERE` is specified in §2.4; the §3.8 tripwires must be reported beside every correlation and must read **0.00 %**. Three database-level guards, not three comments. |
| **R2** | **The gate is scored within-session** and reports 0.55–0.86, looking shippable. This is the single most likely way this release goes wrong, because the *rule* would look impeccable. | **D-5**, §1.4, §3.4's refused-number table, and the §3.8 within-session-share tripwire. WP8's owner reads §1.4 before writing a line. |
| **R3** | **The answer lands at 0.42–0.68 with SE 0.069** and does not resolve cleanly (§3.5). The procedurally worst outcome: a number in the 0.45–0.65 band invites a re-argument. | §3.7 pre-commits the response **before** the measurement: 0.60–0.70 ⟹ refuse the rating, publish the number and the gap, re-open only with WP-DEFER-1. Written down now so it cannot be re-negotiated later. |
| **R4** | **Wall clock is 2.5–5.2 h and the split is unmeasured** (§5.2); this project has been killed four ways by silent long-running work. | WP0's timed probe **before anything is scheduled**, with a stop-and-re-scope gate at 4 h. Per-session commits, progress to stdout, resumable, `nohup` (§5.3). |
| **R5** | **The repin and the test literals drift apart** — WP6 repins `f1lab/telemetry.py` and `tests/test_telemetry.py:257` keeps `24_963`, turning the suite red. The suite takes 25–40 minutes per file and is the one thing nobody may run to find out. | §6.4 gives the test an **explicit owner (WP5)** and mandates the **same commit** as WP6. No proposal in the design round had an owner for this file. |

**Runners-up, carried but not in the top five:** the drizzle drift check failing until
`web/db/schema/telemetry.ts` is updated in the WP2 commit; the 2 driver-sessions with
candidates but no telemetry row breaking any hard-coded 1,499 (§5.6); and `ask` returning 2–3×
rows to an LLM told the grain is one (§6.7) — all three have named mitigations above.

---

# 10. Decisions log

| # | Decision | One-line rationale |
|---|---|---|
| **D-1** | Replicate = the **driver-session**, not the run. | Same-run laps share fuel, tyre and track state; SR-6 requires the denominator to sample what the numerator sampled. |
| **D-2** | R-SEL: fastest per run, ranked, capped at 3. **No segment stratification.** | Measured: the top-3 lap-time spread is flat across driver tiers (0.612 / 0.611 / 0.616 s), so the condition mix is skill-correlated but the denominator is not — the affirmative case for stratifying does not survive measurement, and SR-6 argues against it. |
| **D-3** | Anchor keeps `selection = 'fastest'`, byte-identical. | Preserves every v1.7 reading surface by construction; keeps §4.6's rollback exact; avoids writing a pre-0010 column that sits under no-drift's zero-difference rule. Costs nothing. |
| **D-4** | Never two laps from one run; one named fallback at its own value. | Makes the trap unrepresentable in the database rather than forbidden in prose. |
| **D-5** | **Gate computed ACROSS sessions on the n-lap mean.** | A within-session repeat correlation moves `L_sess` into the numerator and is unbounded above (§1.4) — a correct rule scored the wrong way produces the flattering number just as reliably as a bad rule. |
| **D-6** | Races excluded from selection; 21 rows untouched. | Empty candidate set; race laps carry degradation within a stint; coverage is 1 of 71. |
| **D-7** | Pooled estimators throughout, declared. | The three circulating estimators disagree by 1.5×, and two design-round proposals built a load-bearing ratio from a pooled numerator over a median denominator. |
| **D-8** | Repin counts; **add shares with a ±1.5 pp band**; quantiles must not move. | After a deliberate row-count change a count carries no information and a share does; the quantiles are a property of 10 Hz sampling and give a free correctness check. |
| **D-9** | `no_drift_telemetry.py` unweakened, run twice; new `replication_census.py`. | Its premise is idempotency of the derivation, not constancy of the census; the two concerns are separable and neither should be relaxed to accommodate the other. |
| **D-10** | Reading + error bar + `measured = false` with an expiry test. No rating. | §3 predicts a refusal; a refusal with machinery behind it cannot quietly become a permanent omission. |

## 10.1 Design-round disagreements, each settled with one line

| Disagreement | Settled |
|---|---|
| Rename the anchor to `repl_run_best`, or keep `fastest`? | **Keep `fastest`.** Rename buys nothing and breaks the rollback, the v1.7 discriminator and the pre-0010 column rule. |
| Stratify by `quali_segment`? | **No.** The realised denominator is flat across driver tiers (§2.6) and SR-6 forbids a conditioned denominator against an unconditioned numerator. |
| Match compound and tyre age? | **No.** Maximal denominator shrink, worst coverage (32.4 % n = 1), and the numerator is matched on neither. |
| Is the crux 1.5× or 1.13×? | **1.13× pooled** (1.28× in variance). The 1.5× is a median-of-groups statement. D-7. |
| What is `f` = between-run / across-session variance? | **The question is a distraction.** §1.5's ceiling argument bounds the outcome without it, and `f` is estimator-dependent across a 5× range (0.224 / 0.445 / 0.456 / 0.503 / 0.674 all circulated). Quote the de-meaned **0.456 s** comparator if one is needed, and say so. |
| "21 R + 3 Q" or "21 R + 2 Q" non-conforming rows? | **21 R + 0 Q.** Measured two ways (§6.6). Both circulating literals would have failed a build gate on first run. |
| Wall clock: 7–9 min / 17 min / 35–45 min / 2.0–2.6 h? | **None of them.** 114.3 min measured for v1.8; v2.0 is **2.5–5.2 h**, and the 2.0–2.6 h figure is the optimistic endpoint of an unmeasured F/P split (§5.2). WP0 measures it. |
| SE on the pooled repeat correlation: 0.03? | **0.069 for the lap-mean, 0.03–0.07 at corner level.** The 0.03 figure used the within-session population, which D-5 forbids; the across-session design has **212** usable pairs (§3.5). |
| Total stored laps: 2,698 / 2,699 / 3,054 / 4,079? | **4,125** = 4,058 (R-SEL) + 46 (fallback) + 21 (race, untouched), with `≥ 1,497` anchors asserted rather than `1,499` (§5.6). |

---

# 11. As built

*Empty. Filled by WP9 after the release, with: the measured F/P split from WP0, the actual
backfill wall clock, the measured across-session repeat correlation with its SE and both §3.8
tripwires, the realised n-distribution, the realised share values against their bands, and the
outcome recorded against §3.7's pre-committed responses.*
