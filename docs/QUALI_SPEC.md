# F1 Analytics v1.6 — Qualifying Ingestion

Status: **built and verified, 2026-09-15.** Written to be implemented in parallel from this
file alone; §10 is the as-built record and is the authority wherever it and §§1–7 disagree.

This release gives the app its first qualifying sessions. The database today holds 71 race
sessions (`kind='R'`) and 18 sprint sessions (`kind='S'`) and has never held a qualifying
session. v1.6 adds **71 Qualifying + 18 Sprint Qualifying = 89 sessions**, their laps, and
four new analytics tables.

This spec is the synthesis of three independent proposals
(`output/quali_proposal_{data-first,analytics-first,integration-first}.md`) and three
adversarial judge reviews (data correctness, shippability, honesty). Where the sources
disagreed, §9 records the decision and the reason in one line. Where a judge proved a
source claim false against the cache, the false claim is **not** in this document and the
correction is recorded in §9.

## Contents

- **§0** Scope, fixed decisions, conventions, and what qualifying data can and cannot support
- **§1** The session model — kinds, schedule rows, ingest ordering, selection flags
- **§2** Cleaning — the qualifying lap rules, segment assignment, measured survival counts
- **§3** Schema — DDL, `EXPECTED_COLUMNS`, migration 0006, Drizzle notes, rollback
- **§4** Analytics — estimators, storage, claims and non-claims
- **§5** Downstream — Mode 2, sprint qualifying, the ask box, every spec needing amendment
- **§6** Web — query signatures, page slots, chart shapes, verbatim captions, empty states
- **§7** Work packages — single-owner ownership, sequencing, verification
- **§8** Risks
- **§9** Decisions log
- **§10** As built — the record, the deviations and what is booked for v1.7

## Conventions inherited from SPEC §0.3

Times in seconds as `double precision`, suffixed `_s`. Percentages as `double precision`
in percentage points, suffixed `_pct`. All timestamps UTC. `driver_id` / `team_id` are the
project's stable text ids. Every derived table is **delete-and-rebuild per session**, never
upserted row-by-row. Every number rendered in the web layer carries a caption that states
what it is not.

New in v1.6: a lap belongs to exactly one **segment** (1, 2 or 3 — Q1/Q2/Q3, and SQ1/SQ2/SQ3
for sprint qualifying, which share the column and the code path). "Pole" means the driver
classified P1 in that session, for both kinds.

---

# §0 Scope and fixed decisions

## 0.1 In scope

1. `sessions.kind` widens from `{R,S}` to `{R,S,Q,SQ}`; 89 new session rows across 2024–2026.
2. Qualifying laps ingested into the **existing `laps` table**, with two new columns.
3. A qualifying-specific cleaning path (`messages=True`, segment assignment, no fuel
   correction, no 107% outlier rule, green-flag *reported* not *applied*).
4. Four new tables: `quali_results`, `quali_segment_times`, `quali_teammate_h2h`,
   `season_quali_h2h`.
5. Web: a qualifying section on the race page, a qualifying record on the driver page, a
   pole column and season head-to-head on the season page, a historical circuit panel on
   the weekend preview.
6. The ask box learns the new tables and **unlearns** the four places it is currently told
   qualifying does not exist.

## 0.2 Explicitly out of scope (each is a decision, not an omission)

| Not in v1.6 | Why | Where it goes |
|---|---|---|
| Refitting MODE2 §3.2's grid-pace surrogate onto qualifying times | A surrogate becoming a measurement is a **refit**, not a relabel: a new response (continuous, not ordinal) needs its own identifiability run, and validating it against rows produced by this release's brand-new ingest leaves no independent check | **DONE in v1.8 — this deferral is discharged, not outstanding.** The refit ships as `MODE2_SPEC §3.2b`, key `one_lap_pace`. See the amendment note below and §5.1.1 |
| Flipping `messages=True` for `kind='R'` | It would re-activate `excl_deleted` on 71 races, change the representative lap set, and therefore `pace_ranking`, `degradation_fits`, `teammate_deltas`, every season aggregate and every Mode 2 fit | v1.7, sized in §5.6 |
| Sector-level / purple-sector attribution | Needs mini-sector telemetry the ingest does not load. Sectors *are* stored | v1.7+ |
| Cross-season gap-to-pole comparison | A regulation change moves lap times by seconds; the percent normalisation does not survive it | Never, unless normalised per season |
| Strategy simulator changes | `SIM_SPEC` is parameterised from race stints and race degradation. Qualifying has no stints worth the name | No change; stated so the absence is a decision |
| Qualifying as an input to the MODE1 weekend preview forecast | See §0.4 | Never in this form |

> **v1.8 amendment to row 1 — what the deferral bought, and what it cost.** The deferral was
> correct and it is now spent. The refit was run in v1.8 against a backfill that §2.5's anchor
> test had already passed, and it got its own identifiability run: `MODE2_SPEC §3.2b` gate G2
> rebuilds the mobility graph on qualifying rows alone and returns the same four components, with
> the same members, as the race-row graph. **The one thing the deferral did not buy is the
> response**: the refit does **not** use `gap_to_pole_common_pct` as §5.1.1 pre-registered. Six
> candidate responses were fitted and the shipped one is the **segment-1 session-mean-centred
> percent** (V3); the deviation and its reason are recorded in §5.1.1 rather than left silent.
> **And the retirement threshold pre-registered in §5.1.1 was measured and NOT met**: `corr` is
> **0.8393** across all 28 drivers and **0.8670** excluding the four island drivers, against a
> pre-registered **0.95**, so `grid_pace` is kept — unchanged, unrenamed, undeleted.

## 0.3 Fixed decisions (settled; do not re-litigate during implementation)

| # | Decision |
|---|---|
| D1 | Qualifying laps live in **`laps`**, not a separate `quali_laps` table (§3.1) |
| D2 | `kind` widens to `('R','S','Q','SQ')`; `kind` stays `text`, not an enum |
| D3 | Sprint qualifying is **first-class**: same laps, same cleaning, same four tables (§5.2) |
| D4 | Q/SQ load with `messages=True`; **`R`/`S` stay pinned at `messages=False`**, with a test |
| D5 | Ingest order keeps races first: kind rank `{R:0, S:1, Q:2, SQ:3}` |
| D6 | Gap to pole is stored **twice** — the TV number and the same-segment number (§4.1) |
| D7 | Mode 2 is untouched in v1.6. No new skill key, no deleted `grid_pace` rows (§5.1) |
| D8 | The per-driver-per-segment **anchor check is a runtime gate**, not only a test (§2.5) |
| D9 | Ranking and every cross-circuit aggregate is on **percent**; seconds only within a session |

## 0.4 What qualifying data can and cannot support

This section is the honesty contract for the release. Every caption in §6 is downstream of it.

**It can support:**

- **Official classification and segment times, exactly.** Q1/Q2/Q3 arrive with the session
  results and are stored verbatim. Independently, the cleaned laps reproduce them
  (§2.5) — so the app can point at the lap a time was set on, its compound, its tyre age.
- **Gap to pole in two honest forms** (§4.1), in seconds *and* percent, because a tenth at
  Monaco is 0.142% of the lap and a tenth at Shanghai is 0.105% — a **1.36×** spread inside
  one dataset.
- **Which segment a driver was knocked out in** — as a *fact derived from lap presence*, not
  inferred from a NaT pattern (§4.2).
- **Teammate qualifying head-to-head**, as a win count with an interval and a same-segment
  median delta (§4.3) — the thing fans argue about most, finally measurable.
- **What qualifying pace has historically looked like at a circuit** (§6.4) — as history.

**It cannot support, and nothing in this release may imply otherwise:**

1. **It does not raise MODE1 §3.5's 0.653 ceiling.** §3.5 measured that ordering drivers by
   grid predicts the finish at ρ = 0.755 against the form model's ρ = 0.653, and records
   0.653 as the honest ceiling **because a future race has no grid yet**. A future race has
   no qualifying time either. Nothing here is an input to the preview forecast, and
   `MODE1_SPEC §3.5` gains a paragraph saying so (§5.5) so the new tables are not mistaken
   for a fix.
2. **A single session's teammate gap is not a measurement of who is faster.** Measured: a
   driver's own push laps *within one segment* have a median standard deviation of
   **0.186 s** (2026 Monza), **0.357 s** (2024 Monaco), **0.459 s** (2024 Spa), and span a
   median of **0.447 s** across 301 driver-segments. A 0.007 s Ferrari teammate gap at 2026
   Monza is **26× smaller** than that session's own repeatability. Gaps below the session's
   repeatability render as "no measurable difference", never as a number (§4.3).
3. **A driver eliminated in Q1 was not necessarily slower than every Q2 driver.** Store the
   fact, not the inference.
4. **`spread_s` is not a consistency metric.** It contains track evolution, changing fuel
   between runs, and traffic.
5. **A best lap is a minimum over n laps and is biased downward in n.** Measured 1–18
   representative laps per driver per session. `n_repr_laps` is shown beside every ranked
   row and the caption says a two-lap driver is not being compared fairly with an eight-lap
   driver.
6. **Qualifying position minus race grid position is not "a penalty".** A driver can start
   ahead of where they qualified because someone *else* took a penalty, and a pit-lane start
   is not a grid position at all. The app says "qualified P*n*, started P*m*" and stops.
7. **Percent gaps are not comparable across seasons** at the same circuit.
8. **Q1, Q2 and Q3 are three different sessions on a changing track.** A cross-segment
   comparison is gated by `cross_segment_ok` (§4.6). 2024 China Sprint Qualifying ran SQ1/SQ2
   dry (1:35.606) and SQ3 wet on intermediates (**1:57.940**, +23.4%) — a session-wide
   benchmark there would keep zero SQ3 laps and zero drivers.
9. **`laps.deleted` is `false` on every race lap in this database and always has been**
   (measured: TRUE on 0 of 69,548 rows, `deleted_reason` NULL on all of them) because race
   sessions load with `messages=False`. After v1.6 the column is *correct for Q/SQ and inert
   for R/S*. That asymmetry is documented in the schema comment and in the ask manifest so
   nothing — human or model — reads the race zero as a fact about racing (§5.6).

---

# §1 The session model

## 1.1 The widened `kind` CHECK

`sessions.kind` is today `CHECK (kind = ANY (ARRAY['R','S']))`, authored in
`web/db/schema/reference.ts:112`. v1.6 widens it to four values:

```sql
ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE sessions ADD  CONSTRAINT sessions_kind_check
  CHECK (kind = ANY (ARRAY['R','S','Q','SQ']));
```

| kind | `sessions.name` | sets | event formats that have it | count after backfill |
|---|---|---|---|---|
| `R`  | `Race`              | —               | both | 71 |
| `S`  | `Sprint`            | —               | `sprint_qualifying` | 18 |
| `Q`  | `Qualifying`        | the race grid   | both | 71 |
| `SQ` | `Sprint Qualifying` | the sprint grid | `sprint_qualifying` | 18 |

`kind` stays `text`. The existing `unique(year, round, kind)` and the three-character value
`'SQ'` cost nothing; a Postgres enum would need a migration every time a format changes.

Per-session column behaviour for Q/SQ:

- `total_laps` — NULL. A qualifying session has no lap count in the race sense.
- `winner_driver_id` — NULL. **Measured:** `results.Status` is the empty string and
  `results.Time` is all-NaT for every qualifying session; there is no classification text
  and no gap-to-winner column.
- `fastest_pace_driver_id` — set to the **classified P1 driver** (the pole sitter). This is a
  **definitional choice, not a measurement**: on a drying or cooling track the session's
  quickest lap can be a Q1 or Q2 lap set by someone else. §4.5 states the rule and §6.2's
  caption `C-QUALI-3` states the consequence where the two disagree.

## 1.2 Creating the Q/SQ rows from the schedule

`ingest.schedule_rows` (`f1lab/ingest.py:150`) already walks the FastF1 schedule, appending a
Race row plus, on sprint weekends, a Sprint row found by scanning `Session1..Session5` for the
exact name `"Sprint"`.

**Measured on 2024, 2025 and 2026, both event formats:** every event carries a session named
exactly `Qualifying`, and every `sprint_qualifying` event also carries one named exactly
`Sprint Qualifying`.

```python
def _session_start(ev, name: str) -> dt.datetime | None:
    """Exact match, never `in`.  'Sprint Qualifying' CONTAINS 'Qualifying' as a substring:
    an `in`-test gives the Q row the Friday start time, and the ingest's completion check
    then fires a day early."""
    for n in range(1, 6):
        if str(ev.get(f"Session{n}", "")) == name:
            return _utc(ev.get(f"Session{n}DateUtc"))
    return None
```

`_sprint_start` becomes `_session_start(ev, "Sprint")`. Then, per event:

```python
sessions.append({..., "kind": "Q",  "name": "Qualifying",
                 "start_utc": _session_start(ev, "Qualifying")})
if str(ev["EventFormat"]) == "sprint_qualifying":
    sessions.append({..., "kind": "SQ", "name": "Sprint Qualifying",
                     "start_utc": _session_start(ev, "Sprint Qualifying")})
```

`upsert_schedule` is unchanged: it already upserts on `(year, round, kind)` and only
overwrites `name` / `start_utc`, so re-running it on an existing season adds the 89 new rows
without touching a single R or S row.

## 1.3 Ingest ordering and `--season` selection

`_select` currently sorts `(round, 0 if kind == "R" else 1)`. v1.6 replaces the tiebreak with
an explicit rank:

```python
_KIND_RANK = {"R": 0, "S": 1, "Q": 2, "SQ": 3}
```

**Races keep going first.** A re-ingest of an existing season therefore produces byte-identical
ordering to v1.5 and the log diff is purely additive. Chronological order (SQ, S, Q, R) was
proposed and rejected: ingest is per-session transactional and idempotent, every parent row
(`drivers`, `teams`, `events`) is upserted by whichever session touches it first, nothing in
`build_*_frames` reads another session, and a half-finished backfill under the R-first rule
always still has the race data the rest of the app depends on. Chronological order would also
change the meaning of `tests/test_ingest_cli.py`'s existing assertions about a race being
written before its sprint, for no gain.

Default `--season` selection is unchanged in mechanism — "completed (`start_utc` + margin <
now) and not already `ok`" — and therefore picks up the new Q and SQ rows automatically.

Two new flags, symmetric with the existing `--no-sprints`:

- `--no-quali` — skip `kind IN ('Q','SQ')`.
- `--only-quali` — ingest **only** `kind IN ('Q','SQ')`. **This is the flag the v1.6 backfill
  uses.** `python -m f1lab.ingest --season 2024 --only-quali` adds the new sessions without
  re-reading a single race, so 121 MB of existing rows is never rewritten and
  `session_ingests` rows for races keep their original `run_id` and timestamp.

`--round N` keeps its meaning of "every session of this round regardless of status", which now
means up to **four** sessions instead of two. That change breaks four existing test
assertions; they are listed and owned in §7 (WP4).

## 1.4 Loading: `messages=True` for Q/SQ only

`clean.load_race` today calls `s.load(telemetry=False, weather=True, messages=False)`
(`f1lab/clean.py:37`). It gains a keyword:

```python
def load_race(year, gp, session, cache=None, *, messages: bool = False): ...
```

and `ingest.load_with_retry` passes `messages=(kind in ("Q", "SQ"))`.

**This flag is load-bearing twice over, and both are measured:**

| symptom | `messages=False` | `messages=True` |
|---|---|---|
| 2024 R08 Monaco Q deleted laps | **0** of 426 | **21** of 426 (18 of them flying), reasons like `TRACK LIMITS AT TURN 10 LAP 9` |
| 2024 R01 Bahrain Q deleted laps | 0 of 267 | **2** of 267 |
| 2024 R11 Austria Q deleted laps | 0 of 320 (all `None`) | **4**, with reasons (LEC lap 21 1:10.750 `TRACK LIMITS T9`; PIA lap 16 1:04.786; GAS lap 17 1:05.335; TSU lap 5 1:05.725) |
| 2024 R05 China **SQ** `results.Position` | **0** of 20 non-null | **20** of 20 |
| 2024 R05 China **SQ** `results.Q1/Q2/Q3` | 0 / 0 / 0 | **20 / 15 / 10** |

FastF1 derives `Deleted` / `DeletedReason` from race-control messages, and it derives sprint
qualifying's segment times from the laps *plus* those messages — with them off it logs
`Failed to calculate quali results from lap times!` and hands back all-NaT. Two of the three
source proposals measured sprint qualifying through `messages=False` and concluded from the
artifact that **FastF1 publishes no results for sprint qualifying**. It does. That conclusion,
and every design consequence drawn from it, is absent from this spec by decision (§9, D3).

**`R` and `S` stay pinned at `messages=False` in this release** (§0.2), enforced by a test
(§7, WP4). `scripts/warm_cache.py:62` already loads with `messages=True`, so the in-flight
cache warm has the race-control messages on disk and this costs no network.

---

# §2 Cleaning

## 2.1 What a qualifying session actually contains (measured)

Loaded from the warmed cache with `messages=True`. `kept` is the §2.3 rule set.

| session | drivers | laps | no time | out-laps | in-laps | in-laps **with** a time | deleted | kept | kept % |
|---|---|---|---|---|---|---|---|---|---|
| 2024 R01 Q Bahrain | 20 | 267 | 98 | 92 | 92 | 84 | 2 | 83 | 31.1% |
| 2024 R02 Q Jeddah | 20 | 316 | 102 | 93 | 93 | 82 | 1 | 130 | 41.1% |
| 2024 R03 Q Melbourne | 19 | 310 | 78 | 86 | 80 | 6 | 2 | 143 | 46.1% |
| 2024 R05 SQ Shanghai | 20 | 218 | 59 | 53 | 51 | 40 | 6 | 113 | 51.8% |
| 2024 R08 Q Monaco | 20 | 426 | 81 | 92 | 92 | 12 | 21 | 224 | 52.6% |
| 2024 R11 Q Austria | 20 | 320 | — | — | — | — | 4 | — | — |
| 2026 R13 Q Monza | 22 | 307 | 109 | 101 | 101 | 91 | 2 | 103 | 33.6% |

One driver's session, verbatim (2024 R01 Q, LEC): out-lap with **no** lap time → flying
91.260 s `IsPersonalBest=True` → in-lap 111.926 s → out-lap → flying 90.243 → in-lap 108.538
→ … Six out/fly/in triplets.

Four facts that shape the rules:

- **An out-lap usually carries no lap time, but not always.** Bahrain: 0 of 92 out-laps have a
  time. Monaco: 91 of 92 do. Melbourne: 81 of 86. Whether the out-lap gets a time is a
  timing-feed artefact that varies by circuit, so the rule must exclude out-laps **explicitly**
  and must not rely on the time being NaT.
- **An in-lap almost always carries a time and it is enormous** — 108–122 s against an 89 s
  flying lap.
- **`results` supplies only `Position`, `Q1`, `Q2`, `Q3`.** `Status` and `ClassifiedPosition`
  are the **empty string** (not null), `Time` is all-NaT, `Points` is NaN, `Laps` is NaN.
- **`results.GridPosition` is NaN for every driver in every qualifying session** (20 of 20 in
  each 2024 session measured, 22 of 22 at 2026 R13). A qualifying result does not know the
  race grid; §4.7 gets it from the race session instead.

### 2.1.1 The empty-string trap (`frames._identity_frames`)

`_identity_frames` maps null → `'N'` for `classified_position` and null → `'Unknown'` for
`status`. FastF1 hands qualifying an **empty string**, which is not null, so 89 sessions × ~21
rows would store `''` in two `NOT NULL text` columns. One-line fix in `f1lab/frames.py`:

```python
def _fallback(v, default):
    return default if _is_null(v) or not str(v).strip() else str(v)
```

Applied to `classified_position` and `status`. Race and sprint rows are unaffected — measured,
no existing session has an empty `Status`.

## 2.2 Segment assignment — windows, then a strict anchor, then a bounded repair

### Stage 1: windows from `session_status`

`session.session_status` is available with `messages=False` **and** `messages=True`. Walk its
rows: open a window on the first `Started`, **ignore `Aborted`** (a red flag inside a segment;
the segment resumes), close the window on `Finished`. The *n*-th closed window is segment *n*.

Example, 2024 R02 Q Jeddah: `Started 13:55 → Finished 31:55` (Q1); `Started 38:55 → Aborted
42:57 → Started 47:55 → Finished 58:54` (Q2, red-flagged mid-segment); `Started 1:06:55 →
Finished 1:18:55` (Q3).

A lap is provisionally assigned to segment *n* when `LapStartTime` falls inside window *n*,
with **120 s of grace** at the window start for a lap begun just before the flag. Measured:
0–15 laps per session fall outside every window; every one inspected is an in-lap or a
garage-return lap after the chequered flag. Those laps keep `quali_segment = NULL` and are
therefore not representative (rule 5 of §2.3).

### Stage 2: the strict anchor check (the gate)

For every driver and every segment *k* where `results.Qk` is non-null:

```
min(lap_time_s over that driver's representative laps in segment k)  ==  results.Qk   (±1.5 ms)
```

**This is equality of the minimum, not existence of a matching lap.** The weaker "some lap
matches Qk" test is structurally incapable of detecting a mis-assigned segment, and a
mis-assigned segment is the most likely way this feature breaks.

### Stage 3: bounded anchor repair (the window rule is not sufficient — measured)

The window rule breaks on a session shape the source corpus did not contain. **2024 R21 São
Paulo Qualifying** (wet, four `Aborted` events, status stream `Started/Aborted/Inactive/
Started/Finished` repeatedly) yields **exactly 3 windows** — so a window-count assertion
passes — and still fails the strict anchor on **3 of 44** driver-segments: ALO Q2 off by
−3.963 s, ALB Q2 by +1.232 s, PIA Q2 by +0.493 s. ALO's own results row carries
`Q2 == Q3 == 1:28.998`.

So the window count is **not** the gate. The gate is the anchor, and one bounded repair is
allowed before it fires:

1. For each driver-segment that fails stage 2, search that driver's **other** laps in the
   session for a lap whose time equals `results.Qk` to ±1.5 ms and whose provisional segment
   differs. If exactly one such lap exists, reassign it to segment *k* and set
   `laps.segment_source = 'anchor_repair'` on it (default `'window'`).
2. Re-run stage 2 for that driver-segment.
3. If any driver-segment still fails, or if a repair is ambiguous (zero or more than one
   candidate), the **session is written with `session_ingests.status = 'partial'`** and the
   reason `quali_anchor_mismatch: <driver> seg<k> Δ<seconds>`. Partial sessions store laps and
   `quali_results` (the official times are still verbatim and correct) but **no**
   `quali_segment_times` and **no** `quali_teammate_h2h`, because both are per-segment.

`quali_session_summary`-style counters live on `session_ingests.warnings[]`:
`quali_segment_repairs=<n>`. Measured expectation: 0 on all nine clean corpus sessions, and 3
on 2024 R21.

**Honesty note on the repair.** Stage 3 uses the official times to place a lap. That makes the
anchor check *for a repaired driver-segment* a tautology, so the ingest reports two numbers and
§7's acceptance criterion uses the first: **pre-repair anchor pass rate** (two-sided, falsifiable)
and **post-repair pass rate** (must be 100% or the session is partial).

## 2.3 The qualifying cleaning rules

A lap is **representative** (`laps.is_representative`) iff **all five** hold. None of these
five rules reads `results`, which is what keeps §2.2's anchor check two-sided:

| # | Rule | Column | Relation to the race rule (`clean.clean_laps`) |
|---|---|---|---|
| 1 | has a lap time | `excl_no_time = false` | **same** |
| 2 | not an out-lap (`PitOutTime` null) | `excl_out_lap = false` | **same rule, opposite reason.** In a race an out-lap is slow because the tyre is cold; in qualifying it is slow *on purpose*, and it is the lap on which the tyre was prepared for the one that counts |
| 3 | not an in-lap (`PitInTime` null) | `excl_in_lap = false` | **same** |
| 4 | not deleted (`Deleted` false) | `excl_deleted = false` | **same rule, far more often triggered**: 21 deletions in one Monaco qualifying against a race's 0 (see §0.4 note 9). This rule only works because of `messages=True` (§1.4) |
| 5 | inside a Q1/Q2/Q3 window (`quali_segment IS NOT NULL`) | `excl_no_segment = false` | **new; no race analogue** |

And two race rules that **do not apply**:

**6. The green-flag rule inverts into a flag.** In a race, `excl_not_green` is an exclusion. In
qualifying it must not be. **Measured, 2024 R08 Monaco Q: four drivers' official Q1 bests sit on
`TrackStatus '12'`** — RUS 1:11.492, STR 1:11.728, HUL 1:11.876, ALO 1:12.019. Applying the race
rule would silently delete four FIA-classified times from a session whose official times we can
otherwise reproduce exactly. Across the corpus the race rule would kill **34 of 356** official
times (9.6%). `TrackStatus` is still stored per lap and `excl_not_green` is still computed and
written to `lap_exclusion_report`, but for Q/SQ it is **reported, never applied**: the yellow was
in another sector and the lap stood.

**7. The 107%-of-own-median outlier rule is dropped.** Measured over 1,100 representative laps
from eight sessions it would remove 0–79 laps per session (79 of 224 at Monaco) — all of them
genuine aborted or tow laps, none of them a segment best. It answers a race question ("was this
lap compromised?") with a race's assumption (every lap is a push lap), which qualifying breaks.
`laps.is_outlier` is therefore **always `false`** for Q/SQ, and the fact is written into
`lap_exclusion_report` so nobody later reads the zero as a bug.

**Fuel correction is meaningless and is not run.** Every qualifying lap runs on a low, nearly
identical fuel load by regulation and by choice. `fuel_kg`, `fuel_penalty_s` and `lap_time_fc_s`
are **NULL** for Q/SQ laps, and `assumptions.FUEL_*` is never read on this path. Likewise
`gap_to_leader_s`, `interval_s` and `leader_driver_id` are NULL: there is no leader on track.

**Any benchmark used in cleaning is per-driver-per-segment, never session-wide and never
cross-segment.** This is a hard rule with a counterexample in `assumptions.py` beside
`QUALI_PUSH_LAP_THRESHOLD`: **2024 China SQ ran SQ1 1:36.110 and SQ2 1:35.606 on mediums and SQ3
1:57.940 on intermediates (+23.4%)**. A session-wide benchmark there keeps zero SQ3 laps and zero
drivers. Do not "simplify" it later.

## 2.4 `excl_disallowed` — a diagnostic, never a filter

A lap in segment *k* strictly faster than that driver's official `results.Qk` (by > 2 ms) was
struck out by the stewards. This is computed and stored as `laps.excl_disallowed`, and it is
**not** part of the five-rule representative test.

- **Why it is kept:** it is a cheap, independent second net under the race-control deletion
  feed, for the case where a deletion is missing or late in the messages.
- **Why it is not a filter:** including a rule defined off `results.Qk` would make §2.2's
  anchor check true by construction in one direction, destroying the only falsifiable
  acceptance test this release has.
- **Its measured blind spot, stated so nobody trusts it too far:** at **2024 R11 Austria Q**,
  which has **4** genuine deletions, `excl_disallowed` fires on only **2** of them — GAS
  1:05.335 and PIA 1:04.786. LEC's deleted 1:10.750 (his officials are 65.509/65.104/65.044)
  and TSU's deleted 1:05.725 (65.563/65.412/—) are *slower* than the driver's own Qk, so the
  rule cannot fire. **Two of four.** Useful as a second net under a correct `messages=True`
  load; dangerous as a replacement for one.
- A lap with `excl_disallowed = true` and `deleted = false` also sets
  `laps.deleted_inferred = true`, so the provenance of the disagreement is queryable in one
  statement rather than a day.

## 2.5 The acceptance test: reconstruct the official times

For each session: take every representative lap, group by (driver, segment), take the minimum,
compare against the official `Q1`/`Q2`/`Q3` in `session.results` to **1.5 ms**.

| session | official times | reproduced (pre-repair) | mismatches |
|---|---|---|---|
| 2024 R01 Q Bahrain | 45 | 45 | 0 |
| 2024 R02 Q Jeddah | 43 | 43 | 0 |
| 2024 R03 Q Melbourne | 44 | 44 | 0 |
| 2024 R08 Q Monaco | 45 | 45 | 0 |
| 2024 R11 Q Austria | 45 | 45 | 0 |
| 2024 R10 Q Barcelona | 44 | 44 | 0 |
| 2026 R13 Q Monza | 48 | 48 | 0 |
| **Q subtotal (7 sessions)** | **314** | **314** | **0** |
| 2024 R05 SQ Shanghai | 45 | 45 | 0 |
| 2024 R06 SQ Miami | 44 | 44 | 0 |
| **SQ subtotal (2 sessions)** | **89** | **89** | **0** |
| **corpus total** | **403** | **403** | **0** |
| **2024 R21 Q São Paulo** | **44** | **41** | **3** → repaired by §2.2 stage 3 |

**The Q and SQ subtotals are reported separately and they are not the same kind of evidence.**
For `kind='Q'`, FastF1 takes Q1/Q2/Q3 from the timing API, so reproducing them from the laps is
**external validation**. For `kind='SQ'`, FastF1 *computes* them from these same laps plus
race-control messages, so reproducing them is **self-consistency**. Both are worth having; only
the first is proof. `quali_results.times_source` records which (`'api'` | `'derived'`).

**2024 R21 São Paulo Qualifying is mandatory in the acceptance corpus.** It is the session that
separates the window rule from the anchor gate, and it must be in the fixture set before a line
of §2.2 is written.

## 2.6 Push laps: a flag, not an exclusion

Over the same 1,100 representative laps, the ratio of a lap to **that driver's own best in that
segment** is sharply bimodal: p50 = 1.0047, p70 = 1.0179, then a jump to 1.128 at p75 and 1.257
at p80. **There is no mass between 1.03 and 1.13.**

```python
# f1lab/assumptions.py
QUALI_PUSH_LAP_THRESHOLD = 1.03   # lap_time_s <= 1.03 * driver's own best in THIS segment.
# Insensitive: 1.03 -> 71.9% of representative laps, 1.05 -> 73.4%, 1.10 -> 73.7%.
# The benchmark is per-driver-per-segment and MUST NOT be widened to session-wide or
# cross-segment: 2024 China SQ ran SQ1/SQ2 dry (1:35.606) and SQ3 wet (1:57.940, +23.4%);
# a session-wide benchmark keeps zero SQ3 laps and zero drivers.
```

`laps.is_push_lap` is the flag. Median push laps per driver-segment is **2**, and **83.6%** of
driver-segments have at least two — which is what makes §4.4's repeatability estimator possible
at all, and what makes it absent for the other 16.4%.

`IsPersonalBest` is true on 70.3% of representative laps. That is a similar *magnitude*, not a
corroboration: `IsPersonalBest` means best-so-far within the session, which is a different
population by definition. It is stored, not used as evidence.

## 2.7 Code shape

New in `f1lab/clean.py` (WP2 owns the file):

```python
def load_quali(year, gp, session, cache=None):
    """load_race(..., messages=True). Q1/Q2/Q3 for SQ and every Deleted flag depend on it."""

def quali_segment_windows(session) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """§2.2 stage 1. Started opens, Aborted is ignored, Finished closes."""

def annotate_quali_laps(session, windows) -> pd.DataFrame:
    """Emits the same excl_* columns as clean_laps, plus quali_segment, segment_source,
    is_push_lap, excl_disallowed, deleted_inferred.  is_outlier is always False.
    Fuel and gap columns are None.  Never reads results except in §2.2 stage 3."""

def quali_anchor_check(laps_df, results) -> tuple[int, int, list[str]]:
    """(matched, total, failures). Called pre-repair and post-repair."""
```

---

# §3 Schema

## 3.1 Decision D1: qualifying laps go in `laps`, with five new columns

**Decision: reuse `laps`. Not a separate `quali_laps`.** The argument is the column list.

`laps` has **41 columns** (verified: `SELECT count(*) FROM information_schema.columns WHERE
table_name='laps'` → 41). Exactly six are race-specific — `fuel_kg`, `fuel_penalty_s`,
`lap_time_fc_s`, `gap_to_leader_s`, `interval_s`, `leader_driver_id` — and **all six are already
nullable**, because a race lap can lack them too. A seventh, `position`, is populated by FastF1
in qualifying but means "order at that moment", which is close to meaningless: it is stored and
never read.

The other 34 columns are exactly as meaningful for a qualifying lap, and several are **more**
meaningful: `compound` and `tyre_life` (new versus scrubbed softs is the whole story of a Q3
lap), `sector1_s/2/3`, `speed_i1/i2/fl/st` (a tow at Monza shows up in `speed_st`), and
`deleted` / `deleted_reason`, which in a race are dead columns (§0.4 note 9) and in qualifying
carry the single most common reason a lap does not count.

A separate `quali_laps` would duplicate 34 of 41 columns and fork `frames._laps_frame`,
`frames.cast_frame`, `frames.TABLE_COLUMNS`, `db.SESSION_CHILD_TABLES`, `db.check_schema`'s
comparison loop, the Drizzle schema file, the ask allowlist, the generated schema doc, and every
web query that joins laps to `session_entries` for a colour. In exchange it buys `NOT NULL` on
six columns that are not read on the race path either.

**The three real costs of reuse, stated plainly rather than argued away:**

1. **`cast_frame` drift.** `frames.cast_frame` raises `KeyError("frame columns differ from
   EXPECTED_COLUMNS")` on any column-set change, so `build_race_frames` must emit the five new
   columns as `None`. That is an edit to the hottest function in `f1lab`, and every race
   re-ingest then flows through a changed builder. It is one line per column and it is covered
   by the existing parametrised schema-contract test.
2. **The `laps_session_repr_idx ... WHERE is_representative` predicate now covers rows where
   "representative" means something different.** This is a semantics-of-index concern, not a
   correctness one: every consumer is scoped by `session_id` or by `sessions.kind` (audited
   below), so the index is never used to mean "race laps".
3. **`laps` stops being race-only, and the next unscoped query will not know.** Mitigated by a
   rule, a schema comment and a grep-shaped test (§8, R2).

**The consumer audit — verified line by line, and it is the accurate one.** (One source
proposal claimed six *unfiltered* readers of `laps`; a judge re-read all six and found every one
already constrained. The separate-table decision does not rest on a claim that is false.)

| consumer | why it is safe today |
|---|---|
| `f1lab/preview.py:115` `_PASS_LAPS_SQL` | `WHERE s.kind = 'R'` |
| `f1lab/preview.py:205` `_CONTROL_PACE_SQL` | `session_id = ANY(%s)` with race ids **and** `lap_time_fc_s IS NOT NULL`, which is NULL on every Q/SQ lap |
| `f1lab/winprob.py:93` | joins a kind-filtered `race` CTE |
| `f1lab/winprob.py:822` | `WHERE s.kind = 'R'` |
| `f1lab/decomp.py:934` | subquery LEFT JOINed onto `FROM sessions ... WHERE s.kind = 'R'` |
| `f1lab/decomp.py:961` | `JOIN sessions s` with a kind filter |
| `tests/test_moments.py:345` | `WHERE s.kind='R'` |
| `web/lib/queries/race.ts:617`, `race.ts:681`, `sim.ts:285` | parameterised by a race `sessionId` from the route |

**The rule, to be written into `SPEC §1.4` and into `web/db/schema/laps.ts`'s comment:** *every
query against `laps` that is not already scoped to a single `session_id` must constrain
`sessions.kind`.*

**Size.** `laps` today is 69,548 rows / 40 MB for 71 races. 89 qualifying sessions at the
measured 218–426 laps each add **≈27,000 rows (+39%)** and, because 13 of the 46 columns are
NULL on this path, an estimated **+12–15 MB** on a 121 MB database.

## 3.2 Five new columns on `laps` (41 → 46)

```sql
ALTER TABLE laps ADD COLUMN quali_segment    integer;   -- 1|2|3 for Q/SQ laps, NULL otherwise
ALTER TABLE laps ADD COLUMN segment_source   text;      -- 'window'|'anchor_repair', NULL for R/S
ALTER TABLE laps ADD COLUMN is_push_lap      boolean;   -- NULL for R/S
ALTER TABLE laps ADD COLUMN excl_disallowed  boolean;   -- §2.4 diagnostic, NULL for R/S
ALTER TABLE laps ADD COLUMN deleted_inferred boolean;   -- excl_disallowed true while deleted false

ALTER TABLE laps ADD CONSTRAINT laps_quali_segment_check
  CHECK (quali_segment IS NULL OR quali_segment BETWEEN 1 AND 3);
ALTER TABLE laps ADD CONSTRAINT laps_segment_source_check
  CHECK (segment_source IS NULL OR segment_source IN ('window','anchor_repair'));

CREATE INDEX laps_quali_segment_idx ON laps (session_id, quali_segment)
  WHERE quali_segment IS NOT NULL;
```

All five are **nullable rather than `NOT NULL DEFAULT`**, so the column itself answers "is this a
qualifying lap?" without a join, and the migration does not rewrite 69,548 existing rows.

`quali_segment IS NULL` on a Q/SQ lap is meaningful: it is a lap outside every window (0–15 per
session, measured) — a garage return or a post-chequered lap.

**`excl_inaccurate` for Q/SQ: reported, never applied.** FastF1's `IsAccurate` encodes race
expectations (a plausible pit sequence, sane sector sums) and is frequently false on a qualifying
out/in pair. It is stored and written to `lap_exclusion_report` exactly like `excl_not_green`,
and it is not one of §2.3's five rules. **`laps.passes_rules` for a Q/SQ lap means "passes the
five qualifying rules"**, and `is_representative = passes_rules` because `is_outlier` is always
false here.

`frames.TABLE_COLUMNS["laps"]` gains, at the end of the list:

```python
("quali_segment", "int"), ("segment_source", "str"), ("is_push_lap", "bool"),
("excl_disallowed", "bool"), ("deleted_inferred", "bool"),
```

so `EXPECTED_COLUMNS["laps"]` and therefore `--check-schema` pick them up with no other change.
`build_race_frames` and `build_sprint_frames` write `None` for all five; `cast_frame` already
handles `None` for `int`, `str` and `bool`.

## 3.3 New table: `quali_results`

`results` cannot hold qualifying. Its payload is `position, classified_position, grid_position,
points, status, laps_completed, result_time_s` — and measured, a Q session supplies **only**
`Position` (§2.1). Meanwhile the three numbers that matter have nowhere to go. So Q/SQ write
`session_entries` and `session_teams` like every session, plus this table — and **not** `results`,
which stays "the classification of a race or sprint".

```sql
CREATE TABLE quali_results (
  session_id        integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id         text    NOT NULL REFERENCES drivers(driver_id),
  team_id           text    NOT NULL,
  position          integer NOT NULL,      -- results.Position, 1..N, always present (Q and SQ)
  q1_s              double precision,      -- official segment times; NULL = no time set
  q2_s              double precision,
  q3_s              double precision,
  best_s            double precision,      -- least non-null of q1..q3; NULL for a no-time driver
  best_segment      integer,               -- which segment best_s came from (1|2|3)
  best_lap_number   integer,               -- provenance pointer into laps
  segments_entered  integer NOT NULL,      -- highest segment in which the driver ran ANY lap
  knocked_out_in    integer,               -- = segments_entered, or NULL if they reached the last
  set_a_time        boolean NOT NULL,
  -- §4.1: two gaps, because one of them is a lie half the time
  gap_to_pole_s          double precision, -- best_s - pole best_s          "the TV number"
  gap_to_pole_pct        double precision,
  gap_to_pole_common_s   double precision, -- same-segment comparison       "the honest number"
  gap_to_pole_common_pct double precision,
  gap_to_pole_segment    integer,          -- the segment the common gap used (1|2|3)
  n_repr_laps       integer NOT NULL,      -- §4.4 best-of-n disclosure
  push_laps         integer NOT NULL,      -- §2.6, across all segments
  times_source      text    NOT NULL,      -- 'api' for Q, 'derived' for SQ (§2.5)
  PRIMARY KEY (session_id, driver_id),
  FOREIGN KEY (session_id, driver_id)
    REFERENCES session_entries(session_id, driver_id) ON DELETE CASCADE,
  CONSTRAINT quali_results_best_segment_check
    CHECK (best_segment IS NULL OR best_segment BETWEEN 1 AND 3),
  CONSTRAINT quali_results_pole_segment_check
    CHECK (gap_to_pole_segment IS NULL OR gap_to_pole_segment BETWEEN 1 AND 3),
  CONSTRAINT quali_results_entered_check
    CHECK (segments_entered BETWEEN 1 AND 3),
  CONSTRAINT quali_results_time_check
    CHECK (set_a_time = (best_s IS NOT NULL)),
  CONSTRAINT quali_results_times_source_check
    CHECK (times_source IN ('api','derived'))
);
CREATE INDEX quali_results_driver_idx ON quali_results (driver_id);
```

**Why `segments_entered` is stored rather than read off the NaT pattern: the NaT pattern lies.**
Measured, 2024 R02 Q Jeddah: HUL is P15 with a Q1 time and `Q2 = NaT`, yet he ran a lap inside
the Q2 window — he **advanced and set no time**. Reading "knocked out in Q1" off the NaT pattern
would be wrong for him: `segments_entered = 2`, `knocked_out_in = 2`, `q2_s = NULL`. The other
edge in the same session is ZHO: `segments_entered = 1`, `set_a_time = false`, `best_s` and both
gaps NULL, `position = 20`.

**No field size is ever hard-coded.** Measured: the Q1→Q2 cut is 15 drivers in 2024 and **16** in
2026 (22-car grid: nQ1=22, nQ2=16, nQ3=10), and 2024 R10 Barcelona had only **9** drivers set a
Q3 time. Nothing in §3 or §4 reads a band size; band boundaries are only ever *rendered*, derived
per session from `knocked_out_in`.

## 3.4 New table: `quali_segment_times`

`quali_results` is the wide row the pages want. This is the long form, and the only place a
per-segment gap or a repeatability estimate can live.

```sql
CREATE TABLE quali_segment_times (
  session_id      integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  driver_id       text    NOT NULL REFERENCES drivers(driver_id),
  segment         integer NOT NULL,          -- 1|2|3
  laps_run        integer NOT NULL,          -- every lap inside the window, in/out included
  repr_laps       integer NOT NULL,          -- §2.3 survivors
  push_laps       integer NOT NULL,          -- §2.6
  best_s          double precision,          -- NULL = ran the segment, set no time
  best_lap_number integer,
  gap_to_best_s   double precision,          -- to the fastest time in THIS segment
  gap_to_best_pct double precision,
  spread_s        double precision,          -- slowest push lap - best push lap; NULL if <2
  sd_s            double precision,          -- sd of this driver's push laps; NULL if <2
  compound        text,                      -- compound on the best lap
  tyre_life       integer,                   -- tyre age on the best lap
  wet_compound    boolean NOT NULL,          -- any INTERMEDIATE/WET lap in this segment
  PRIMARY KEY (session_id, driver_id, segment),
  CONSTRAINT quali_segment_times_segment_check CHECK (segment BETWEEN 1 AND 3)
);
```

`spread_s` and `sd_s` exist because 83.6% of driver-segments have ≥2 push laps; both are NULL
for the other 16.4% and the UI renders that as a hollow marker, never as zero.

## 3.5 New table: `quali_teammate_h2h` (per session, per team pair)

```sql
CREATE TABLE quali_teammate_h2h (
  session_id     integer NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  team_id        text    NOT NULL,
  driver_a       text    NOT NULL REFERENCES drivers(driver_id),  -- the QUICKER of the two
  driver_b       text    NOT NULL REFERENCES drivers(driver_id),
  segment        integer,                     -- deepest segment BOTH set a time in; NULL if none
  a_best_s       double precision,
  b_best_s       double precision,
  delta_s        double precision,            -- b_best_s - a_best_s, > 0 by construction
  delta_pct      double precision,
  comparable     boolean NOT NULL,            -- false when they never shared a segment
  classified_ahead text  NOT NULL REFERENCES drivers(driver_id),  -- by quali position
  divergent      boolean NOT NULL,            -- classified_ahead <> driver_a
  session_sd_s   double precision,            -- median of both drivers' sd_s in that segment
  below_noise    boolean NOT NULL,            -- delta_s < session_sd_s  (§0.4 note 2)
  PRIMARY KEY (session_id, team_id, driver_a, driver_b),
  CONSTRAINT quali_teammate_h2h_segment_check CHECK (segment IS NULL OR segment BETWEEN 1 AND 3)
);
```

A three-car or mid-season-substitute team produces more than one pair per session, which the
composite PK allows. **`classified_ahead` is separated from `driver_a` on purpose**: who was
classified ahead and who was quicker legitimately disagree — one teammate progresses to the next
segment and the other sets a faster time before going out. `divergent` marks it and §6.3's
caption explains it. `below_noise` is the flag that forbids the UI from printing a number
(§4.3).

## 3.6 New table: `season_quali_h2h`

```sql
CREATE TABLE season_quali_h2h (
  year             integer NOT NULL,
  kind             text    NOT NULL,          -- 'Q' or 'SQ', NEVER pooled (§5.2)
  team_id          text    NOT NULL,
  driver_a         text    NOT NULL REFERENCES drivers(driver_id),
  driver_b         text    NOT NULL REFERENCES drivers(driver_id),
  sessions_counted integer NOT NULL,          -- both entered
  a_wins           integer NOT NULL,          -- by classified position
  b_wins           integer NOT NULL,
  deltas_counted   integer NOT NULL,          -- subset with comparable = true
  median_delta_s   double precision,          -- signed: negative = driver_a faster
  median_delta_pct double precision,
  mad_delta_pct    double precision,          -- median absolute deviation = the uncertainty
  sessions_caveated integer NOT NULL,         -- cross_segment_ok false, or anchor-repaired
  PRIMARY KEY (year, kind, team_id, driver_a, driver_b),
  CONSTRAINT season_quali_h2h_kind_check CHECK (kind IN ('Q','SQ')),
  CONSTRAINT season_quali_h2h_wins_check CHECK (a_wins + b_wins = sessions_counted)
);
```

`kind` is in the primary key from the start — a sprint-qualifying gap and a qualifying gap are
set on different tyre rules and different track states, and a fan asking "who out-qualified whom
in 2025" means the Saturday session.

**Median-and-MAD, not mean-and-SD**: with 12–24 sessions and one wet session capable of a 3%
outlier, the mean is not the number a fan means by "he's a tenth quicker".

**No pooled cross-season mean exists anywhere.** Career head-to-head is published as *counts,
per year*, never as one averaged figure (§4.3).

## 3.7 Migration 0006, `EXPECTED_COLUMNS`, Drizzle

Drizzle owns the DDL. Migrations live in **`web/drizzle/`** (`0000_init.sql` … `0005_mode3.sql`
are applied); `web/db/schema/*.ts` is the source.

1. New file `web/db/schema/quali.ts` with the four tables, exported from `web/db/schema/index.ts`.
2. `web/db/schema/reference.ts` — the widened `kind` check (currently line 112).
3. `web/db/schema/laps.ts` — the five new columns, the two checks, the partial index, and the
   §3.1 comment rule replacing "§1.4 — race sessions only".
4. `npx drizzle-kit generate --name quali` emits `web/drizzle/0006_quali.sql`, which **must be inspected** to
   confirm it contains only: the `kind` constraint drop+add; five `ADD COLUMN`s + two checks +
   one partial index; four `CREATE TABLE`s + two indexes. **No `DROP TABLE`, no `ALTER COLUMN`,
   no data movement.** 0006 is purely additive: no existing column changes type, nullability or
   name.

`frames.TABLE_COLUMNS` gains the four new tables verbatim in the column order above;
`EXPECTED_COLUMNS` follows for free. `db.SESSION_CHILD_TABLES` gains
`"quali_teammate_h2h", "quali_segment_times", "quali_results"` placed **before `"laps"`**
(children first) so a session delete still cascades in a legal order. `season_quali_h2h` is
season-scoped and belongs to `season.py`'s own delete-and-rebuild, **not** to
`SESSION_CHILD_TABLES`.

New constants in `frames.py`:

```python
QUALI_TABLE_ORDER: list[str] = [
    "session_teams", "session_entries", "laps", "lap_exclusion_report",
    "quali_results", "quali_segment_times", "quali_teammate_h2h",
]

def build_quali_frames(session, ids) -> Frames: ...
```

`_identity_frames` is reused unchanged apart from §2.1.1's `_fallback`. `ingest.py`'s dispatch
becomes three-way: `build_race_frames` for `R`, `build_sprint_frames` for `S`,
`build_quali_frames` for `Q`/`SQ`.

## 3.8 Rollback

0006 is additive, so the rollback is complete and mechanical:

```sql
DROP TABLE IF EXISTS season_quali_h2h, quali_teammate_h2h, quali_segment_times,
                     quali_results CASCADE;
DELETE FROM sessions WHERE kind IN ('Q','SQ');          -- cascades laps + lap_exclusion_report
ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE sessions ADD  CONSTRAINT sessions_kind_check
  CHECK (kind = ANY (ARRAY['R','S']));
DROP INDEX IF EXISTS laps_quali_segment_idx;
ALTER TABLE laps DROP CONSTRAINT IF EXISTS laps_quali_segment_check,
                 DROP CONSTRAINT IF EXISTS laps_segment_source_check;
ALTER TABLE laps DROP COLUMN quali_segment, DROP COLUMN segment_source,
                 DROP COLUMN is_push_lap, DROP COLUMN excl_disallowed,
                 DROP COLUMN deleted_inferred;
```

Then revert `frames.TABLE_COLUMNS`, re-run `scripts/gen_ask_schema.py`, and clear
`ask_answer_cache` (§5.3). No race, sprint or Mode 2 row is touched by either direction.

---

# §4 Analytics

Everything here is computed at ingest from the session's own laps and official results, and
written to §3's tables. Nothing is fitted across sessions except §4.3's season roll-up, which
lives in `season.py`.

**Two constants govern the section.**

- **The noise floor.** A driver's own push laps within one segment have a median standard
  deviation of **0.186 s** (2026 Monza), **0.357 s** (2024 Monaco), **0.459 s** (2024 Spa), and
  span (slowest push lap − best) a median of **0.447 s** across 301 driver-segments (p25
  0.231 s, p75 0.874 s, p95 1.454 s). Part of the spread is track evolution inside the segment,
  so it is an **upper bound** on single-lap repeatability — which is the correct direction to
  hedge. It is the same order as a whole season's teammate gap.
- **A tenth is not a tenth.** 0.100 s as a share of the pole lap: 0.105% at Shanghai, 0.112% at
  Bahrain, 0.122% at Monza, 0.139% at Montréal, **0.142% at Monaco** — a **1.36×** spread, and
  1.6× against Spa's 0.088%. **Percent is the comparable unit; seconds is the legible one.** Both
  are stored; every cross-circuit aggregate and every ranking uses percent.

## 4.1 Gap to pole — two numbers, because one of them is a lie half the time

**The TV number.** `gap_to_pole_s = best_s − pole_s`, where `pole_s` is the P1 driver's best in
the deepest segment they set one in. `gap_to_pole_pct = 100 · gap_to_pole_s / pole_s`.

It mixes segments. Pole is a Q3 lap on a rubbered-in track with fresh softs; a Q1-eliminated
driver's best was set twenty minutes earlier on a greener surface.

**The honest number.** `gap_to_pole_common_s = driver[seg] − pole[seg]` for the deepest `seg` in
{3, 2, 1} where both are non-null. `gap_to_pole_segment` stores `seg`.

Measured across 8 cached 2024 sessions, the two disagree for **10–14 of 20 drivers per session**:

| session | pole | drivers whose gap changes | max change |
|---|---|---|---|
| Bahrain | 1:29.179 | 12 / 20 | 0.852 s |
| China | 1:33.660 | 10 / 20 | 1.082 s |
| Monaco | 1:10.270 | 11 / 20 | 1.314 s |
| Austria | 1:04.314 | 13 / 20 | 1.022 s |
| Hungary | 1:15.227 | 14 / 20 | 2.528 s |
| Baku | 1:41.365 | 12 / 20 | 1.410 s |
| São Paulo (wet) | 1:23.405 | 11 / 20 | **7.539 s** |
| Japan | 1:28.197 | 10 / 20 | 0.669 s |

Storing only one would be a choice about which readers to mislead, so both are stored and the
chart shows both (§6.2): the common-segment gap as the solid bar, the TV gap ghosted behind it.

**Uncertainty:** none, and none is claimed. These are measured times. The only judgement is the
segment choice, and it is stored.

**Must not claim:** that `gap_to_pole_common_s` is condition-free. Both drivers ran the same
segment, not the same lap, the same tow, or the same minute of track evolution. It removes the
segment confound only.

**Must not claim:** that `gap_to_pole_pct` is comparable **across seasons** at the same circuit.

**v1.8 — one line, so it is not mistaken for a modelling response.** `gap_to_pole_common_pct` is a
**display number for one session**, and a good one. It **was** measured as a modelling response —
it is candidate V1 in `MODE2_SPEC §3.2b`'s six-fit table — and it was **rejected**: it is
referenced to one lap by one driver, so pole's own noise enters every row (τ_car 0.543 → 0.676 on
the stored `gap_to_best_pct`), and selecting the deepest **common** segment re-imports the
outcome-selection that `MODE2_SPEC §1.2`'s stratum-completeness rule forbids. It measured worst on
every axis in that table. **It remains what it was built to be, and it is not the `one_lap_pace`
response.**

## 4.2 Segment reached, and knocked out in

**Estimator.** `segments_entered` = the highest segment index in which the driver appears in
**any** lap, out-laps included, from §2.2's windows. `knocked_out_in = segments_entered` unless
`segments_entered` equals the number of segments the session actually ran, in which case NULL.

It deliberately does **not** read the Q1/Q2/Q3 NaT pattern (§3.3, HUL and ZHO at 2024 R02).

The number of segments comes from the session's own `session_status` windows; the elimination
band sizes are never assumed.

**Stored:** `quali_results.segments_entered`, `knocked_out_in`, `set_a_time`.

**Must not claim:** that a driver eliminated in Q1 was slower than every Q2 driver. Store the
fact, not the inference.

## 4.3 Teammate qualifying head-to-head

**Per session** (`quali_teammate_h2h`), per team pair:

- `segment` = the deepest segment in which **both** set a time. Comparing a driver's Q3 against a
  teammate's Q1 compares two track conditions and two tyre choices; "deepest common segment" is
  the only apples-to-apples rule available, and it is what a broadcast means by "two tenths up on
  his teammate".
- `delta_s = slower_best − faster_best` within that segment; `delta_pct = 100 · delta_s /
  faster_best`.
- If they never share a segment with two times: `comparable = false`, `segment` NULL, deltas
  NULL, and the pair is **excluded from every delta average downstream** — but the session still
  counts toward `sessions_counted` and the win, because who qualified ahead is defined even when
  one crashed in Q1.
- `classified_ahead` records who was classified ahead, which is **not always `driver_a`**
  (§3.5). `divergent` marks the disagreement.
- `below_noise = delta_s < session_sd_s`. **Measured example to keep:** 2026 Monza, LEC +0.007 s
  over HAM (0.009%) — **26× smaller** than that session's median within-segment repeatability
  (0.186 s). That is not a skill difference and the UI must not print it as one.

**Per season** (`season_quali_h2h`): `a_wins`/`b_wins` count sessions where both entered and one
qualified ahead. `median_delta_pct` is the median over `comparable = true` sessions only, with
`mad_delta_pct` as its uncertainty.

**Uncertainty, rendered not hidden.** The web layer computes a **Wilson 95% interval** on
`a_wins / sessions_counted` (query layer, never stored — §6.5) and renders it as a band. A 12–10
season head-to-head is consistent with a driver who is genuinely a little slower and one who is
genuinely a little quicker.

**Career head-to-head is published as counts, one row per year. There is no pooled cross-season
mean, anywhere.** A career mean would average across different cars, different teammates'
form, and different regulations.

**Non-random missingness, stated in the caption.** A driver who crashes out of Q1 sets no time
and the session leaves the *delta* comparison — which quietly flatters whoever makes fewer
mistakes. The win count still includes it; the median does not.

**Hard UI rules:**

1. A single session's delta is **not** a measurement of who is faster. Rendered greyed, with the
   session count, and never as a rank.
2. `below_noise = true` renders as **"no measurable difference"**, not as a number.
3. `sessions_counted < 5` renders the season delta greyed with the count, and never as a rank.

## 4.4 Per-session qualifying pace ranking

A row per driver, ordered by `gap_to_pole_common_pct` (percent, per D9), with `best_s` shown.
Stored in `quali_results` (`position`, the four gap columns, `n_repr_laps`, `push_laps`) plus,
per segment, `quali_segment_times.spread_s` / `sd_s`.

**This is not `pace_ranking` and must never be written into it.** `pace_ranking`'s
`median_pace_s` / `iqr_s` / box-plot columns describe a distribution of ~40 comparable race laps;
a qualifying driver-segment has a **median of 2 push laps**. An IQR from two laps is a
number-shaped decoration. `quali_segment_times` stores min, spread, sd and count, and the UI
shows the count.

**Best-of-n bias, disclosed rather than corrected.** `best_s` is a minimum over `n_repr_laps`
laps, measured **1–18** per driver per session, and a minimum is biased downward in n. There is
no defensible correction at n=2, so the app shows `n_repr_laps` beside every ranked row and the
caption says a two-lap driver is not being compared fairly with an eight-lap driver.

**Must not claim:** that `spread_s` or `sd_s` is a "consistency" metric. Both contain track
evolution, a changing fuel load between runs, and traffic. Label: "spread across this driver's
push laps in the segment", with the lap count beside it.

## 4.5 Pole and `sessions.fastest_pace_driver_id`

For Q/SQ, `sessions.fastest_pace_driver_id` is set to the **classified P1 driver**, and
`winner_driver_id` stays NULL. This is a **definitional choice**, made so the existing season
pages can list a qualifying session without a special case.

It is not a claim that P1 set the session's quickest lap. On a drying or cooling track a Q1 or Q2
lap can be the quickest of the session (2024 São Paulo is the measured case, where the TV and
same-segment gaps disagree by 7.539 s). Where the quickest comparable lap belongs to someone
other than P1, §6.2's caption `C-QUALI-3` says so on the page.

## 4.6 Segment comparability: `cross_segment_ok`

A per-session gate, stored on `session_ingests.warnings[]` as
`quali_cross_segment_ok=<bool>` and recomputed by any consumer from `quali_segment_times`:

```
cross_segment_ok = (no segment has wet_compound laps while another has none)
                   AND (max over consecutive segments of |best_k / best_{k-1} - 1| <= 0.03)
```

3% because the measured segment-to-segment improvement on a normal dry session is small and
one-directional: Monaco 71.492 → 70.732 → 70.270 (−1.06%, −0.65%); Spa 114.835 → 113.837 →
113.159 (−0.87%, −0.60%); Monza 82.612 → 81.882 → 81.786 (−0.88%, −0.12%). **2024 China SQ breaks
it spectacularly: SQ2 1:35.606 → SQ3 1:57.940, +23.4%.**

When `cross_segment_ok` is false the session **still publishes its official classification and
its per-segment numbers**; what is suppressed is every cross-segment aggregate — the TV gap is
ghosted with the "conditions changed between segments" caveat, and the session counts toward
`season_quali_h2h.sessions_caveated`.

## 4.7 Qualified versus started — derived, never stored, never called a penalty

`results.GridPosition` is NaN in every qualifying session (measured). The race grid lives on the
race session's own `results.GridPosition`, so the comparison is a join of two stored facts:

```sql
SELECT q.driver_id, q.position AS quali_position, r.grid_position,
       r.grid_position - q.position AS places_moved
FROM quali_results q
JOIN sessions sq ON sq.session_id = q.session_id AND sq.kind = 'Q'
JOIN sessions sr ON sr.year = sq.year AND sr.round = sq.round AND sr.kind = 'R'
JOIN results  r  ON r.session_id = sr.session_id AND r.driver_id = q.driver_id
```

Exposed as a query in `web/lib/queries/quali.ts` and **not stored**: storing it would create a
third thing to keep consistent. It is **not** called a penalty (§0.4 note 6). The caption says
"qualified P*n*, started P*m*" and nothing more.

## 4.8 Deliberately not built in v1.6

No fitted qualifying-pace model (§5.1). No sector-level or purple-sector attribution. No
cross-session "qualifying form" trend line — it is one query away once the data exists, and it is
a v1.7 decision made on real rows rather than on a guess made before the backfill.

---

# §5 Downstream

## 5.1 Mode 2 — the grid-pace surrogate is **not** replaced in this release

> **v1.8 status: this section is history, and its deferral has been discharged.** Everything below
> describes why the refit was **not** done in v1.6, and every word of it about v1.6 remains true.
> The refit **was** done in v1.8: `MODE2_SPEC §3.2b`, key `one_lap_pace`, fitted on segment-1
> session-mean-centred percent over 1,135 rows / 56 sessions / 28 drivers. **The surrogate was
> joined, not replaced.** The three reasons below were all discharged rather than overruled:
> reason 1 (the gain worth having is a different response) is exactly what shipped — the ordinal
> response was abandoned, not swapped; reason 2 (the rows do not exist until v1.6 has run) was
> satisfied by two intervening releases of real backfill with §2.5's anchor test passing on it;
> reason 3 (scope) was met by giving the refit its own release and its own gates.

`MODE2_SPEC §3.2` ships "Starting-grid pace": grid position → normal score
`z = Φ⁻¹((grid − 0.5)/N)`, fitted with the crossed driver/car mixed model (1,265 rows, 62
sessions, 28 drivers, τ_driver 0.456, τ_car 0.496, σ 0.639), and forbidden from being called
one-lap pace because `grid_position` absorbs penalties and pit-lane starts that, in §3.2's own
words at line 554, "we cannot subtract, because there are no qualifying times to subtract it
from". v1.6 removes that impossibility. It does not make the refit safe to ship in the same
release, for three reasons.

**1. The rank-level gain is small; the gain worth having is a different response, which is a
bigger change.** Measured over 161 driver-rounds (2024 R01/R02/R03/R05/R08/R09/R10 + 2026 R13),
qualifying position versus the race `GridPosition` that §3.2 actually fits: 33 of 161 (20.5%)
differ at all, 10 differ by ≥3 places, worst case −12; overall Spearman **ρ = 0.970**, per
session 1.000 (Bahrain, Jeddah, Shanghai) down to **0.844** (2026 R13 Monza, where 19 of 22
drivers moved). Swapping the *ordinal* input would move the estimates very little. The change
worth making abandons the ordinal response entirely — and that is a new model, not a new column.

**2. The rows do not exist until v1.6 has run.** Shipping the refit in the same release means
validating a model against data produced by ingest code written in that same release, with no
independent check available. §2.5's anchor test is the check, and it has to pass on the real
backfill first.

**3. Scope.** v1.6 touches the ingest, the schema and three pages. A Mode 2 refit touches 12
tables, the anchor classes, `evidence_share`, the rendering gates in §2.6 and the caption
contract.

### 5.1.1 What v1.7 does, specified now so it is not re-litigated

> # EXECUTED — in v1.8, not v1.7. This pre-registration has been discharged.
>
> **Read the bullets below as the pre-registration they are.** They were written before the
> numbers existed; the numbers now exist and are recorded here whatever they are. Three things
> happened, and all three are written rather than implied:
>
> **1. The response deviates from the pre-registration, and the deviation is recorded, not
> silent.** This section pre-registered a fit on `gap_to_pole_common_pct` (§4.1). **That is not
> what shipped.** `one_lap_pace` is fitted on the **segment-1 session-mean-centred percent**
> response (V3). The reason is the six-fit table in `MODE2_SPEC §3.2b`, reproduced here because a
> deviation from a pre-registration must carry its evidence with it:
>
> | # | response | rows | sess | τ_driver | τ_car | σ_ε | τ_car/τ_driver | corr(race_pace) |
> |---|---|---|---|---|---|---|---|---|
> | **V3** | **segment 1, session-centred pct (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **3.50** | **0.773** |
> | V2 | all segments, session×segment centred | 2,556 | 57 | 0.143 | 0.506 | 0.487 | 3.54 | 0.761 |
> | V4 | deepest segment reached, centred in it | 559 | 57 | 0.233 | 0.226 | 0.722 | 0.97 | 0.592 |
> | V5 | deepest lap, **chained** onto the Q1 scale | 1,135 | 56 | 0.233 | 0.633 | 0.607 | 2.72 | — |
> | V1 | `gap_to_pole_common_pct` (**pre-registered here**) | 1,146 | 57 | 0.126 | 0.605 | 0.667 | 4.80 | 0.637 |
> | — | `grid_pace` today (normal score) | 1,265 | 62 | 0.4562 | 0.4963 | 0.6388 | 1.09 | 0.80 |
>
> V1 measures worst on every axis. It is referenced to **one lap by one driver**, so pole's own
> noise enters every row — refitting on the stored `gap_to_best_pct` moves τ_driver 0.151 → 0.122
> and τ_car 0.543 → **0.676**, which is pole's noise reappearing as car variance — and selecting
> the deepest **common** segment re-imports the outcome selection that `MODE2_SPEC §1.2`'s
> stratum-completeness rule forbids. §4.1 is amended to say so in one line. The instinct behind
> the pre-registration was right: it named the contamination (a Q1-eliminated driver's
> track-evolution deficit read as slowness) and rejected raw `gap_to_pole_pct` for it. **V3
> removes that contamination more completely than V1 does**, by centring within the session on the
> field actually present rather than referencing a single lap.
>
> **2. The retirement threshold was measured and NOT met. `grid_pace` is kept.** This section
> pre-registered **r ≥ 0.95 retires `grid_pace`** — delete its rows, remove `C-SKILL-2`, rename
> the axis. Measured:
>
> | pair | Pearson | Spearman |
> |---|---|---|
> | **one_lap_pace vs grid_pace — all 28** | **0.8393** | **0.8637** |
> | **one_lap_pace vs grid_pace — ex-island 24** | **0.8670** | **0.8830** |
> | one_lap_pace vs race_pace | **0.7727** | — |
>
> **0.8393 < 0.95, so the condition did not fire and both skills ship.** Nothing was deleted,
> nothing was relabelled, `C-SKILL-2` was amended in place and never reassigned. The
> pre-registration did its job exactly as intended: the threshold was fixed before the number
> existed, and the number is recorded whatever it is.
>
> **The correlation is reported BOTH ways, which this section did not ask for and should have.**
> Four of the 28 drivers (norris, piastri, alonso, stroll) have levels set by shrinkage toward
> each fit's own prior rather than by data, so an all-28 correlation is **14 % a comparison of two
> priors**. The decision does not flip — 0.839 and 0.867 are both far below 0.95 — but a statistic
> that governs a retirement must not be part prior without saying so. **Both numbers are stored on
> `mode2_fit_run` (`corr_one_lap_grid`, `corr_one_lap_grid_ex_islands`), both are printed in the
> run log, and gate G3 fails the build if either ever reaches 0.95** — so retirement stays a human
> decision requiring a spec edit, in this release and in every later one.
>
> *(Measurement note, reported and not reconciled: the implementation measures the ex-island
> Pearson at **0.8663** (Spearman 0.8835) across four independent constructions, against the
> **0.8670** (0.8830) pinned in the v1.8 source material. The all-28 figures and 0.7727 reproduce
> exactly, so the disagreement is isolated to the ex-island subset; the stored and gated value is
> the measured one, and the decision is unaffected because both are far below 0.95.)*
>
> **3. Both hard gates held, and one of them is now a run-time assertion.** Gate 1 — the floating
> set under `one_lap_pace` equals the set under `race_pace` — holds: **norris, piastri, alonso and
> stroll remain floating**, `pct_field_below` is NULL for all four, and `MODE2_SPEC §3.2b`'s gate
> G2 rebuilds the mobility graph on qualifying rows alone at run time and fails the **run** if it
> ever returns anything but four components with those members. The prediction behind it was
> confirmed exactly: **a qualifying session carries the same `session_entries` as its race, so it
> adds rows, not edges** — 28 drivers / 31 car-cells / 72 edges / 4 components, zero
> qualifying-only edges. Gate 2 — `corr(one_lap_pace, race_pace)` printed whatever it is, with an
> "overlapping things" sentence above 0.90 — holds: **0.7727**, below the trigger, so the sentence
> is not required; `C-SKILL-6` prints the correlation anyway and says it in words, because 60 % of
> shared variance is most of an axis. Note it is *lower* than `grid_pace`'s 0.80: the surrogate was
> more like race pace than the measurement is.
>
> **The degradation this section told us to watch did not occur.** "Missingness becomes
> non-random — a Q1 crash produces no time at all": measured, **1,560 of 1,567 driver-sessions
> have a segment-1 time (99.55 %)**. That is a property of the *segment-1* response and not of the
> pre-registered one — on a deepest-segment response, missingness is 100 % for every driver
> eliminated in Q1, by definition. The `n_obs < 25` flag was kept anyway (`MODE2_QUALI_THIN_N`)
> and is rendered as a mark separate from the `floating` badge.
>
> **Two things this pre-registration got right and that are worth preserving as rules.** (a)
> Keeping the existing `grid_pace` rows rather than relabelling them — a surrogate becoming a
> measurement is a refit, not a rename, and the database must not carry the lie. (b) Fixing the
> retirement criterion as a number agreed in advance, so the decision was made by arithmetic
> rather than by whoever was in the room when the correlation printed.

- New skill key **`one_lap_pace`** in `mode2_driver_skill`, rendered as **"Qualifying pace"**,
  fitted on **`gap_to_pole_common_pct`** (§4.1) — *not* on raw `gap_to_pole_pct`. Fitting on the
  TV number would absorb Q1-eliminated drivers' track-evolution deficit as driver slowness, which
  is the same class of contamination §3.2 complains about with grid penalties.
- **Existing `grid_pace` rows are kept, not deleted, and no row is relabelled.** They are a valid
  fit of a *different* quantity: where you **started**, penalties included. A surrogate becoming
  a measurement is a refit, not a rename.
- **Retirement is decided by a number agreed in advance.** After both fits exist, compute
  `corr(one_lap_pace δ̂, grid_pace δ̂)` over the shared drivers. **If r ≥ 0.95**, retire
  `grid_pace` — delete its rows, remove `C-SKILL-2`, rename the axis — because it is then the
  same axis measured worse. **If r < 0.95**, both ship and the page says in words that their
  difference *is* the penalty and the sprint-grid contamination. (This threshold is asserted, not
  measured: it is a pre-registration device, and v1.7 records the observed r whatever it is.)
- **Two hard gates, both run-time, both fail the run rather than warn:**
  1. The set of `floating` `driver_id`s under `one_lap_pace` **must equal** the set under
     `race_pace` in the same fit. A new skill axis is a new response over the same design matrix;
     it adds no edge to the driver→car-cell membership graph, because qualifying sessions carry
     **exactly the same `session_entries` as their own race**. **norris, piastri, alonso and
     stroll remain floating.** `pct_field_below` stays NULL for all four.
  2. `corr(one_lap_pace, race_pace)` is printed on the page whatever it is; above 0.90 the page
     says in words that the two measure overlapping things.
- Known degradation to watch: missingness becomes non-random. `grid_position` was present on
  1,265 of 1,265 rows; a Q1 crash produces no time at all, and that absence correlates with the
  driver's own mistakes. Flag `n_obs < 25`.

### 5.1.2 MODE2_SPEC amendments required **in v1.6 itself**

These are not optional: the sentences become false the day 0006 lands.

| Section | Amendment |
|---|---|
| `MODE2_SPEC §3.0`, correction 1 (line ~518) | "There are no Q1/Q2/Q3 columns and no qualifying sessions" → qualifying sessions exist as of v1.6; the §3.2 fit is still run on `grid_position`; why (§5.1); forward pointer to the v1.7 refit |
| `MODE2_SPEC §3.2` (line ~554) | "we cannot subtract it, because there are no qualifying times" becomes false. Replace with: qualifying times exist as of v1.6 and the subtraction is now possible; the surrogate remains until the refit specified in `QUALI_SPEC §5.1.1`, and why |
| `MODE2_SPEC` caption `C-SKILL-2` (line ~1847) | "because there are no qualifying lap times in this database" is false. Replace with: "this is fitted from where the car started, which includes grid penalties. Qualifying times are in the database as of v1.6 but this axis has not yet been refitted onto them." |
| `MODE2_SPEC §3.2` heading | add a "v1.6 status" note |

**No `mode2_*` row is written, deleted or refitted in v1.6.** These are text-only amendments.

## 5.2 Sprint qualifying is first-class

`kind = 'SQ'` gets the same laps, the same cleaning, the same `quali_results`,
`quali_segment_times` and `quali_teammate_h2h`. **Not** results-only like `kind = 'S'`.

> **v1.8 boundary — first-class as a session surface, and out of one fit.** Sprint qualifying
> **stays first-class exactly as this section specifies**: same laps, same cleaning, same three
> tables, same season aggregate, same pages, nothing demoted. **It is excluded from the
> `one_lap_pace` fit** (`MODE2_SPEC §3.2b`), and that exclusion is a statement about one model's
> response, not about the data's status. The reason is measured, not stylistic:
>
> | fit | rows | sess | τ_driver | τ_car | σ_ε | Verstappen SE | Doohan SE |
> |---|---|---|---|---|---|---|---|
> | **Q only (SHIPS)** | **1,135** | **56** | **0.1605** | **0.5620** | **0.3846** | **0.083** | **0.121** |
> | Q + SQ pooled | 1,480 | 73 | 0.1689 | 0.6127 | 0.4861 | 0.090 | 0.129 |
> | SQ only | 345 | 17 | 0.0760 | 0.7742 | 0.7235 | — | — |
>
> **Adding 345 sprint-qualifying rows makes every driver's estimate *less* precise** — σ_ε rises
> 0.385 → 0.486 pp and every posterior SE widens, absolutely and relative to τ_δ — while changing
> the ranking barely (`corr(pooled, Q-only) = 0.967`). Fitted alone, SQ1 has
> τ_car/τ_driver = **10.2**: a single-run, green-track, limited-practice session that is almost
> pure car, and a skill with those variance components would be **a car rating with a driver's
> name on it**. Seventeen sessions is not a corpus. **So it is neither pooled in nor given its own
> skill; it ships as a `measured = false` row, key `sprint_one_lap`**, in the `MODE2_SPEC §3.6`
> panel, reusing the existing refusal machinery rather than inventing a surface — and the excluded
> rows are written to `mode2_quali_row_audit` with `reason = 'sprint_qualifying_excluded'` (347 of
> them per fit), so the panel reads its reason from the database rather than from a hard-coded
> string. **This is not a demotion of `kind = 'SQ'` and must not be rendered as one.**

Two of the three source proposals demoted SQ to a laps-only, second-class tier on the measured
claim that *FastF1 publishes no results for sprint qualifying in any season*. **That claim is
false and it was an artifact of `messages=False`** (§1.4): 2024 R05 China SQ returns `Position`
non-null on 20 of 20 drivers and `Q1/Q2/Q3` on 20/15/10 when messages are loaded. Everything
built on the false claim — a `results_available` boolean, a `source IN ('official','laps')`
column, taking pole from the fastest lap instead of the classification, excluding SQ from the
season aggregate, and a user-facing caption reading "There is no official classification
published for sprint qualifying" — is **absent from this spec by decision** (§9, D3).

Justification for first-class treatment, beyond the data supporting it identically:

1. **It reproduces exactly.** 2024 R05 SQ Shanghai and 2024 R06 SQ Miami give three
   `Started→Finished` windows and reproduce **89 of 89** official SQ segment times (§2.5).
2. **It is the only pace signal on the day it happens.** A sprint weekend has one practice
   session; sprint qualifying is the weekend's first competitive lap time and the only thing that
   sets the sprint grid. Leaving it results-only would put the biggest hole in the dataset exactly
   where the weekend has the least other data.
3. **18 of 89 new sessions = 20% more teammate head-to-head samples**, and §4.3's uncertainty
   analysis says the season median is only meaningful with enough sessions.
4. **`kind='S'` is results-only for a reason that does not apply here.** The sprint is a 100 km
   race whose pace analytics would need a separate fuel model and a 17-lap degradation fit — a
   *modelling* cost. SQ needs no new model: it is the same code path as Q with a different
   `session_id`.

**The one real difference is stored, not hidden.** Q's segment times come from the timing API;
SQ's are computed by FastF1 from the laps plus race-control messages.
`quali_results.times_source` is `'api'` for Q and `'derived'` for SQ. Nothing in v1.6 branches on
it — §2.5 shows both are exact — but §2.5 reports the Q and SQ anchor totals separately because
they are not the same kind of evidence, and a future discrepancy will be diagnosable in one query
instead of a day.

**Aggregates never pool Q and SQ** (`season_quali_h2h.kind` is in the primary key, §3.6).

## 5.3 The ask box (MODE3)

MODE3's schema doc is **generated** from the live database plus `scripts/ask_manifest.yml`. But
`web/lib/ask/prompt.ts` is **hand-written and is not regenerated** — `scripts/gen_ask_schema.py`
writes only `web/lib/ask/schema-doc.txt` and `web/lib/ask/ask-objects.json`. Miss `prompt.ts` and
the feature ships **dead**: the ask box will refuse the capability it just gained.

### 5.3.1 Manifest edits (generated half) — all mandatory

Each is the **removal of a statement that becomes false**. A stale schema doc is worse than an
absent one, because the model trusts it.

| location | today | v1.6 |
|---|---|---|
| `ask_manifest.yml:209` `sessions.purpose` | "kind is 'R' or 'S' only - there are no qualifying sessions in this database." | "Session dimension. kind is 'R' (race), 'S' (sprint), 'Q' (qualifying, sets the race grid) or 'SQ' (sprint qualifying, sets the sprint grid). Q and SQ sessions have laps and quali_* tables but no rows in results." |
| `ask_manifest.yml:241` `teammate_h2h.purpose` | "grid_wins is the only out-qualifying measure in this database." | grid_wins is the **starting**-position measure (penalties included); out-qualifying comes from `quali_results` / `season_quali_h2h` |
| `ask_manifest.yml:368` `conventions` | "…THERE ARE NO QUALIFYING SESSIONS IN THIS DATABASE" | deleted; replaced by the five traps below |
| `ask_manifest.yml:438` worked example | "There are no qualifying sessions in this database. grid_wins - races where…" | rewritten to query `ask.season_quali_h2h`, keeping `grid_wins` as the starting-position measure |
| `laps.purpose` | — | add: "`deleted` is always false on race and sprint laps — race sessions do not load the race-control messages it is derived from. It is meaningful only for Q and SQ." |

The five conventions that replace the deleted paragraph:

1. `sessions.kind` is one of 'R', 'S', 'Q', 'SQ'. **Any query about pace must say which.** An
   unfiltered `ask.laps` aggregate now mixes race and qualifying laps, which are not comparable.
2. Out-qualifying is answered from `ask.quali_results` / `ask.season_quali_h2h`, **not** from
   `ask.teammate_h2h.grid_wins`. Grid position includes penalties.
3. `laps.is_representative` means "clean racing lap" for R/S and "clean flying lap inside a
   Q1/Q2/Q3 window" for Q/SQ. `laps.quali_segment IS NOT NULL` identifies a qualifying lap
   without a join.
4. `quali_results.q1_s/q2_s/q3_s` are NULL when no time was set in that segment, which is **not**
   the same as not reaching it — use `segments_entered` / `knocked_out_in`.
5. `fuel_kg`, `lap_time_fc_s`, `gap_to_leader_s` are NULL on every qualifying lap. A query
   averaging `lap_time_fc_s` silently excludes all of qualifying.

**New views:** four base tables → four views, taking the generated surface from **57 to 61**:
`ask.quali_results`, `ask.quali_segment_times`, `ask.quali_teammate_h2h`,
`ask.season_quali_h2h`. None carries hostnames, paths or pickles, so none is in
`exclude_tables`. The existing `ask.laps` view has an explicit column list and must gain
`quali_segment`, `is_push_lap` and `excl_disallowed` by hand. Two new worked examples: *"who has
the biggest qualifying gap to his teammate in 2025"* and *"how far off pole was Ferrari at
Monaco"*.

### 5.3.2 `prompt.ts` edits (hand-written half) — all mandatory

| line | today | v1.6 |
|---|---|---|
| `web/lib/ask/prompt.ts:70` | the worked example *"Norris out-qualified Piastri 14 times"* is given as **out of bounds** | it is now **in bounds** from `season_quali_h2h`, and out of bounds only from `grid_wins` |
| `web/lib/ask/prompt.ts:84` | `out_of_scope` triggers include "a qualifying session" | qualifying for 2024–2026 is **in scope**; the trigger stays only for seasons outside the window |
| `web/lib/ask/prompt.ts:102` | "grid position is a proxy because this database has no qualifying sessions" | grid position is the **post-penalty** starting position; qualifying position is `quali_results.position` |

Also update the user-facing empty-state string and `MODE3_SPEC:141, 628, 913, 1508-1520`.

### 5.3.3 `ask_answer_cache` invalidation — missed by all three source proposals

Regenerating `schema-doc.txt` changes `prefix_sha256`. Cached answers keyed on the **old** prefix
were produced by a model that had been told qualifying does not exist, and they will keep being
served. The package that regenerates the artifacts must also run:

```sql
DELETE FROM ask_answer_cache WHERE prefix_sha256 <> '<the new prefix>';
```

**Definition of done for the ask box:** `grep -rn "no qualifying sessions\|NO QUALIFYING" scripts/
web/lib/ask/ docs/` returns nothing outside a changelog entry, **and** the ask box answers "who
out-qualified whom at Monaco 2024" from `quali_results`.

> **v1.8 — this rule fired a second time, and it is recorded rather than assumed.** The v1.8 gap
> fill regenerated `web/lib/ask/schema-doc.txt` and `web/lib/ask/ask-objects.json` (65 objects, was
> 64: the new `ask.mode2_quali_row_audit` view, plus four new `ask.lap_corner_speeds` columns), so
> the assembled prefix changed again. **Measured live prefix after the v1.8 regeneration:**
> `4c93e88444b54de147d66283884abfe3de293e68de84b5672d5420fd4190939d`. The §5.3.3 `DELETE` was run
> against it and matched **0 rows** — the table was empty before and after — so the invalidation is
> a verified no-op for the second release running, not an unexecuted step.
>
> **The committed constant is the thing that goes stale, and it is not this document's to move.**
> `web/lib/ask/prompt.ts`'s `PROMPT_PREFIX_SHA256` still reads
> `7472bb19c17302c3aac8d1ff14f2ea6a33c567c6d7c1fa3c331abfd565eac29b`, so
> `promptPrefixMatchesCommitted()` is **false** and its test is red until the owner of that file
> copies the measured value above into it. This is the gate working: a regenerated schema document
> that did *not* move the prefix hash would mean the document never reached the model. Note the
> cache key itself is built from the **live** prefix (`promptPrefixSha256()`), not the committed
> constant, so a stale constant cannot serve a stale answer — it only fails the build.

## 5.4 Every other spec needing amendment, with its section named

| Spec | Section | Amendment |
|---|---|---|
| `SPEC.md` | §1.2 | the widened `kind` CHECK and the two new session kinds |
| `SPEC.md` | §1.3 | Q/SQ session identity: `winner_driver_id` NULL, `fastest_pace_driver_id` = pole sitter (definitional, §4.5), `results` not written |
| `SPEC.md` | §1.4 | `laps` is no longer "race sessions only"; the five new columns; **the rule that any unscoped query must constrain `sessions.kind`**; the `deleted` asymmetry (§0.4 note 9) |
| `SPEC.md` | §1.6 | the four new analytics tables |
| `SPEC.md` | §1.8 | `season_quali_h2h` in the season aggregates |
| `SPEC.md` | §2.4–2.6 | `build_quali_frames`, `QUALI_TABLE_ORDER`, the `messages=True` load for Q/SQ only, `--only-quali` / `--no-quali`, the kind rank |
| `SPEC.md` | §8 (as-built) | 64 tables, 178 sessions, ~96,500 lap rows — copied from the verified database, not from this file |
| `MODE1_SPEC.md` | §3.5 | **the 0.653 ceiling does not move.** One paragraph saying so explicitly, with the reason: grid beats the form model 0.755 vs 0.653 *because a future race has no grid yet*, and a future race has no qualifying time either. Without this, a reader will assume the new tables moved it |
| `MODE1_SPEC.md` | weekend-preview section | the new "qualifying pace at this circuit" panel (§6.4) is **historical** and is not an input to the preview model |
| `MODE2_SPEC.md` | §3.0, §3.2, `C-SKILL-2` | per §5.1.2 — text only, no refit |
| `MODE3_SPEC.md` | §1.2 | the view count 57 → 61 and the exclusions table |
| `MODE3_SPEC.md` | §2 | the generated schema doc description, its worked examples, and the paragraph documenting the "no qualifying sessions" guidance as a deliberate instruction |
| `MODE3_SPEC.md` | :141, :628, :913, :1508-1520 | stale copies of the "no qualifying" claim |
| `SIM_SPEC.md` | — | **no change.** The simulator is parameterised from race stints and race degradation; qualifying has no stints worth the name. Stated explicitly so the absence is a decision, not an oversight |
| `RUNBOOK.md` | ingest section | the three-season `--only-quali` backfill, its verification queries (§7), and the §3.8 rollback |

## 5.5 `MODE1_SPEC §3.5` — the exact boundary

Qualifying data does **not** change the weekend preview's accuracy, and this release adds nothing
to its inputs. §3.5's measurement stands unchanged: ordering by grid gives ρ = 0.755, the form
model gives ρ = 0.653, and 0.653 remains the honest ceiling for a *future* race. What the preview
gains is a **history panel** (§6.4): what qualifying pace has looked like at this circuit. It sits
visually apart from the forecast, is captioned as history, and feeds nothing.

## 5.6 The race-side `deleted` defect, scoped out and booked

Measured in the live database:

```
SELECT count(*) FILTER (WHERE deleted), count(*) FILTER (WHERE deleted_reason IS NOT NULL),
       count(*) FROM laps;
--   0 | 0 | 69548
```

**`laps.deleted` has been `false` on all 69,548 rows for the life of the project and
`excl_deleted` has never excluded a single lap** — because `clean.load_race` passes
`messages=False`. The rule was written, shipped and tested; the data source was switched off one
function away.

**v1.6 fixes it for Q/SQ only.** Flipping it for `R` would re-activate `excl_deleted` on 71
races, change the representative lap set, and therefore `pace_ranking`, `degradation_fits`,
`teammate_deltas`, `fuel_sensitivity`, every season aggregate and every Mode 2 fit built on them —
a full re-ingest plus a full refit. Measured deltas if it were flipped: Bahrain 2/267, Monaco
21/426, São Paulo 28/425, China 0/279.

**v1.7 item, sized now:** re-ingest 71 races with `messages=True`, re-run `season.py`, refit
Mode 2, and diff every affected table before and after. Until then, `messages=False` for `R` is
**pinned by a test** so the flip cannot happen silently, and the asymmetry is documented in the
schema comment and the ask manifest (§5.3.1).

---

# §6 Web

One new query module, `web/lib/queries/quali.ts`, Drizzle in the existing style — parameterised
by ids from the route, computing nothing except the Wilson interval (§6.5). **No new route:**
qualifying appears on pages that already exist, because a qualifying session is part of a
weekend, not a destination.

## 6.1 Query signatures

```ts
// web/lib/queries/quali.ts
export type QualiSegment = 1 | 2 | 3;

export type QualiRow = {
  driverId: string;
  code: string;                        // session_entries.code
  teamId: string;
  teamName: string;
  colour: string;                      // '#rrggbb', session_teams
  lineStyle: "solid" | "dashed" | "dotted";
  position: number;
  q1S: number | null;
  q2S: number | null;
  q3S: number | null;
  bestS: number | null;
  bestSegment: QualiSegment | null;
  segmentsEntered: QualiSegment;
  knockedOutIn: QualiSegment | null;   // null = reached the final segment
  setATime: boolean;
  gapToPoleS: number | null;           // the TV number
  gapToPolePct: number | null;
  gapToPoleCommonS: number | null;     // the honest number
  gapToPoleCommonPct: number | null;
  gapToPoleSegment: QualiSegment | null;
  nReprLaps: number;                   // best-of-n disclosure (§4.4)
  pushLaps: number;
};

export type QualiSession = {
  sessionId: number;
  kind: "Q" | "SQ";
  name: string;                        // 'Qualifying' | 'Sprint Qualifying'
  startUtc: string | null;
  poleDriverId: string | null;
  poleBestS: number | null;
  segments: QualiSegment[];            // distinct segments actually run
  timesSource: "api" | "derived";
  crossSegmentOk: boolean;             // §4.6
  segmentRepairs: number;              // §2.2 stage 3; > 0 renders a provenance note
  fastestLapDriverId: string | null;   // may differ from poleDriverId (§4.5)
  rows: QualiRow[];
};

/** Both qualifying sessions of a round, Q first. Empty array when neither is ingested. */
export async function getQualiForRound(year: number, round: number): Promise<QualiSession[]>;

export type QualiSegmentRow = {
  driverId: string; code: string; colour: string;
  segment: QualiSegment;
  lapsRun: number; reprLaps: number; pushLaps: number;
  bestS: number | null; gapToBestS: number | null; gapToBestPct: number | null;
  spreadS: number | null;              // null when pushLaps < 2
  sdS: number | null;                  // null when pushLaps < 2
  compound: string | null; tyreLife: number | null; wetCompound: boolean;
};
export async function getQualiSegments(sessionId: number): Promise<QualiSegmentRow[]>;
```

```ts
export type QualiH2HRow = {
  teamId: string; teamName: string; colour: string;
  driverA: string; codeA: string;      // the QUICKER driver
  driverB: string; codeB: string;
  segment: QualiSegment | null;
  aBestS: number | null; bBestS: number | null;
  deltaS: number | null; deltaPct: number | null;
  comparable: boolean;
  classifiedAhead: string;             // driverId; may be driverB
  divergent: boolean;
  belowNoise: boolean;                 // render "no measurable difference", not a number
  sessionSdS: number | null;
};
export async function getQualiTeammates(sessionId: number): Promise<QualiH2HRow[]>;

export type SeasonQualiH2HRow = {
  teamId: string; teamName: string; colour: string;
  driverA: string; codeA: string; driverB: string; codeB: string;
  kind: "Q" | "SQ";
  sessionsCounted: number; aWins: number; bWins: number;
  deltasCounted: number; sessionsCaveated: number;
  medianDeltaS: number | null;         // signed, negative = driverA faster
  medianDeltaPct: number | null;
  madDeltaPct: number | null;
  /** Wilson 95% interval on aWins/sessionsCounted. Computed here, NEVER stored (§4.3). */
  wilsonLow: number; wilsonHigh: number;
};
export async function getSeasonQualiH2H(year: number): Promise<SeasonQualiH2HRow[]>;

/** §4.7. One row per driver who both qualified and started. Never called a penalty. */
export type QualiToGridRow = {
  driverId: string; code: string; colour: string;
  qualiPosition: number; gridPosition: number; placesMoved: number;
};
export async function getQualiToGrid(year: number, round: number): Promise<QualiToGridRow[]>;

/** Driver page: one row per season and kind. No pooled career mean (§4.3). */
export type DriverQualiSeason = {
  year: number; kind: "Q" | "SQ";
  sessions: number; poles: number;
  finalSegmentAppearances: number;
  medianGapToPoleCommonPct: number | null;
  bestGapToPoleCommonPct: number | null;
};
export async function getDriverQualiSeasons(driverId: string): Promise<DriverQualiSeason[]>;

/** §6.4. History only; not an input to the preview forecast. */
export type CircuitQualiHistoryRow = {
  driverId: string; code: string; colour: string;
  sessions: number;                    // previous Q sessions at this circuit
  medianGapToPoleCommonPct: number | null;
};
export async function getCircuitQualiHistory(
  circuitId: string, driverIds: string[]
): Promise<CircuitQualiHistoryRow[]>;
```

## 6.2 Race page — `web/app/race/[year]/[round]/page.tsx`

A new **"Qualifying"** section above the existing race content, rendering `getQualiForRound`,
`getQualiSegments`, `getQualiTeammates` and `getQualiToGrid`. On a sprint weekend both sessions
render, Q first, each with its own heading; nothing about the SQ block is degraded.

**(a) `QualiResultTable`.** One row per driver, ordered by position. Columns: Pos · driver
(colour chip + code) · team · Q1 · Q2 · Q3 (blank when NULL, the driver's best of the three
bolded) · Gap · Gap % · Laps (`nReprLaps`). A thin rule after the last driver of each elimination
band carries the band label ("eliminated in Q1"), with the boundary derived per session from
`knockedOutIn` — never from a hard-coded 15 or 10. A driver with `setATime = false` sits in
position order with an em dash in every time cell.

**(b) `GapToPoleBars`.** Horizontal bars, one per driver, team colour, sorted by position. The
**solid bar is `gapToPoleCommonS`**; the **ghosted bar behind it is `gapToPoleS`**, the TV
number. A secondary axis label gives the same distance in percent. The axis range is data-driven:
the measured P1→last span is 2.00% (Bahrain) to 4.20% (Monza), so a fixed axis would waste half
the width at one and clip at the other. When `crossSegmentOk` is false the ghosted bar is
suppressed entirely and the caveat replaces it.

**(c) `QualiSegmentStrip`** (from `getQualiSegments`): for each driver, a dot at `bestS` per
segment they ran, connected — it shows the Q1→Q3 improvement that is the real story of a session.
A driver with `pushLaps < 2` in a segment gets a **hollow** dot (no `spreadS`, no `sdS`).

**(d) `QualiTeammateTable`** (from `getQualiTeammates`): one row per pair, the delta in the
deepest common segment. `belowNoise` rows render **"no measurable difference"** in place of the
number, with the session's repeatability in the hover. `divergent` rows carry an inline marker.
`comparable = false` rows show the classification result and an em dash for the delta.

**(e) `QualiToGridTable`**, rendered **only when at least one row has `placesMoved !== 0`**
(measured: 20.5% of driver-rounds move, but 5 of 8 sessions had ≤2 drivers move — a table of
twenty zeroes is noise).

When `segmentRepairs > 0`, a one-line provenance note sits under the section heading: *"Three lap
times in this session were matched to their segment using the official times, because the timing
feed's segment boundaries did not account for a red flag."*

## 6.3 Verbatim captions

These strings ship exactly as written. Each says what the number is **not**.

> **C-QUALI-1** (under `QualiResultTable`, always).
> These are the official FIA times from the session, not a model. Every time here was also
> reproduced from this session's own lap data by the same filter the rest of the app uses —
> flying laps only, deleted laps removed, each lap matched to the segment it was set in. A blank
> cell means no time was set in that segment, which is not the same as not reaching it.

> **C-QUALI-2** (under `GapToPoleBars`, always).
> The solid bar compares each driver to the pole sitter in the deepest segment they both set a
> time in. The ghosted bar behind it is the headline gap you see on television: the driver's best
> lap of the session against the pole lap. Those two are not the same thing. A driver knocked out
> in Q1 set their best lap on a greener, slower track than the one pole was set on, and the
> ghosted bar charges them for it. Use the percentage to compare circuits: one tenth of a second
> is 0.142% of a lap at Monaco and 0.105% at Shanghai, so a tenth is not the same amount of car
> everywhere.

> **C-QUALI-3** (under `QualiSegmentStrip`, always).
> Each driver's best lap in each segment they ran. A hollow marker means the driver set fewer
> than two push laps in that segment, so there is nothing to compare it against. The spread shown
> is not a consistency measure — it also contains the track getting faster between runs. Drivers
> with more laps get more chances at a good one, so the lap count is shown beside every row, and
> a driver with two laps is not being compared fairly with one who had eight.

> **C-QUALI-4** (under `QualiTeammateTable`, always).
> Both times come from the deepest segment both drivers reached, so this is a like-for-like
> comparison. Where it is marked, the driver who was quicker is not the driver who was classified
> ahead — that happens when one teammate progressed to the next segment and the other set a
> faster time before going out. Treat a single session's gap as noise: measured across 301
> driver-segments, a driver's own push laps within one segment vary by a median of 0.45 seconds,
> which is larger than most teammate gaps. At Monza in 2026 the two Ferraris were seven
> thousandths apart — twenty-six times smaller than that session's own lap-to-lap variation.

> **C-QUALI-5** (under the season `QualiH2HCard`, always).
> Wins count the sessions where both drivers took part and one qualified ahead. The median gap is
> taken only over sessions where both set a time in the same segment, which quietly leaves out
> the sessions where one of them crashed — so it flatters whoever makes fewer mistakes. The band
> shows how uncertain this record is, not how close the drivers were. Over a single season a
> 12–10 qualifying head-to-head is consistent with anything from a driver who is genuinely a
> little slower to one who is genuinely a little quicker. Treat the band, not the score.

> **C-QUALI-6** (under `QualiToGridTable`, whenever it renders).
> Where each driver qualified and where they actually started. A difference can be that driver's
> own penalty or simply the effect of someone else's; this table does not say which, and a
> pit-lane start is not a grid position at all.

> **C-QUALI-7** (on any session where `crossSegmentOk` is false).
> Conditions changed between the segments of this session, so times from different segments are
> not comparable. The classification and the per-segment times below are unaffected; the
> session-wide gap to pole is not shown.

> **C-QUALI-8** (on the weekend preview panel, always).
> How each driver has qualified at this circuit before, as a median gap to pole. This is history,
> not a prediction. It is not part of the forecast below, and the forecast's accuracy is
> unchanged by it. Fewer than three previous sessions is shown greyed, with the count.

> **C-QUALI-9** (wherever a session's fastest comparable lap was not set by the pole sitter).
> The quickest comparable lap of this session was not the pole lap. That happens when the track
> was faster earlier in the session than it was at the end. Pole is the classified result; the
> fastest lap is just the fastest lap.

## 6.4 Weekend preview — a historical panel only

The preview page gains **"Qualifying pace at this circuit"**: for each driver entered, the median
`gapToPoleCommonPct` across previous **Q** sessions at this circuit, with the session count.
Read-only history, visually separated from the forecast, captioned `C-QUALI-8`. **It is not an
input to the preview model and it does not move MODE1 §3.5's 0.653 ceiling** (§5.5). Fewer than
three previous sessions renders greyed with the count.

## 6.5 Driver page and season page

**Driver page** (`web/app/driver/[code]/page.tsx`): a compact table from
`getDriverQualiSeasons` — season · kind · sessions · poles · final-segment appearances · median
gap to pole (%) · best gap to pole (%). **One row per year; no pooled career figure.** Plus the
season teammate card from `getSeasonQualiH2H`, rendered as
*"NOR 13 — 9 PIA · median NOR 0.11% faster (±0.09% MAD, 22 sessions)"* with the Wilson band
beneath, captioned `C-QUALI-5`.

The Wilson 95% interval is computed in the query layer, never stored:

```ts
function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = wins / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(c - m) / d, (c + m) / d];
}
```

**Season page** (`web/app/season/[year]/page.tsx`): each round in the weekend list gains a **pole**
column (driver code + time). The `season_quali_h2h` table renders per team as a bar of wins with
the median gap beside it, **greyed when `sessionsCounted < 5`** and never as a rank.

## 6.6 Empty states

Every surface must render correctly on a database where the backfill has not run, or where only
part of it has. No component may throw on an empty array.

| surface | condition | rendering |
|---|---|---|
| Race page Qualifying section | `getQualiForRound` returns `[]` | The section is **not rendered at all.** No placeholder, no "coming soon" |
| Sprint weekend, Q ingested but SQ not | one element returned | Render the Q block; omit the SQ heading entirely |
| `QualiSegmentStrip` / `QualiTeammateTable` | session is `partial` (§2.2) — laps and `quali_results` present, per-segment tables empty | Render the results table and the gap bars from `quali_results`; omit the strip and the teammate table; show the one-line note *"Per-segment analysis is not available for this session because its lap times could not be matched to the segments they were set in."* |
| `QualiToGridTable` | all `placesMoved === 0`, or the race is not yet ingested | Not rendered |
| Driver page qualifying record | no rows | *"No qualifying sessions in the database for this driver."* — a fact, not an apology |
| Preview panel | fewer than 1 previous session for every driver | Panel not rendered |
| Season page pole column | round has no Q session | Em dash |

---

# §7 Work packages

**Strict single-owner file ownership: no file appears in two packages.** Two files are touched by
exactly one package each and are the critical path: `f1lab/frames.py` (WP3) and
`f1lab/ingest.py` (WP4).

**Success criterion for the release as a whole:** `f1lab/preview.py`, `f1lab/decomp.py`,
`f1lab/winprob.py`, `f1lab/sim.py`, `f1lab/moments.py`, `f1lab/report.py`, `f1lab/companion.py`,
`f1lab/pace.py` and every `mode2_*` table are touched by **nobody**. If a package needs to edit
one of them, stop and re-read §3.1.

## WP1 — Schema and migration (merges alone)

**Owns:** `web/db/schema/quali.ts` (new), `web/db/schema/reference.ts`,
`web/db/schema/laps.ts`, `web/db/schema/index.ts`, `web/drizzle/0006_quali.sql` (generated).
**Does:** §3.2–§3.7 DDL and the widened `kind` CHECK.
**Why it merges alone:** the `EXPECTED_COLUMNS` additions in WP3 turn the parametrised
schema-contract test red for every table until 0006 is applied.

```bash
cd web && npx drizzle-kit generate --name quali    # this project uses npm, not pnpm
grep -cE '^(DROP TABLE|ALTER COLUMN|ALTER TABLE .* ALTER )' web/drizzle/0006_quali.sql   # expect 0
make migrate
Q="docker exec f1-postgres psql -U f1 -d f1 -c"
$Q "\\d+ quali_results"; $Q "\\d+ quali_segment_times"
$Q "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='sessions_kind_check'"
# expect: CHECK (kind = ANY (ARRAY['R'::text,'S'::text,'Q'::text,'SQ'::text]))
docker exec f1-postgres psql -U f1 -d f1 -c \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='laps'
   AND table_schema='public'"                                                 # expect 46
#  (without the table_schema filter this returns 87: the MODE3 `ask` schema also has a
#   view named `laps`, and before `make db-ask-gen` is re-run it still shows 41 columns.)
docker exec f1-postgres psql -U f1 -d f1 -c \
  "SELECT count(*) FROM laps WHERE quali_segment IS NOT NULL"                 # expect 0
```

## WP2 — Cleaning

**Owns:** `f1lab/clean.py`, `f1lab/assumptions.py`, `tests/test_quali_clean.py` (new).
**Does:** `load_race(..., messages=...)`; `load_quali`; `quali_segment_windows`;
`annotate_quali_laps` (§2.3 five rules, §2.4 diagnostic, §2.6 push laps, `is_outlier` always
false, fuel/gap columns None); `quali_anchor_check`; §2.2 stage 3 repair;
`QUALI_PUSH_LAP_THRESHOLD = 1.03` with the China-SQ counterexample in the comment.
**Depends on:** nothing. Can start immediately, in parallel with WP1.

```bash
.venv/bin/python -m pytest tests/test_quali_clean.py -q
# asserts, against the warmed cache:
#   - 10 sessions: 7 Q + 2 SQ + 2024 R21 Sao Paulo Q
#   - pre-repair anchor: 314/314 on the 7 Q sessions, 89/89 on the 2 SQ, 41/44 on R21
#   - post-repair anchor: 100% on all 10, segment_repairs == 3 on R21 and 0 elsewhere
#   - Monaco Q: 21 deleted with messages=True, 0 with messages=False
#   - Monaco Q: 4 official Q1 bests on TrackStatus '12' survive cleaning
#   - 2024 R11 Austria: 4 deleted laps; excl_disallowed fires on exactly 2 of them
#   - 2024 R05 China SQ: results Position 20/20, Q1/Q2/Q3 20/15/10; cross_segment_ok False
#   - is_outlier all False; fuel_kg / lap_time_fc_s / gap_to_leader_s all None
```

## WP3 — Frames, analytics, db contract

**Owns:** `f1lab/frames.py`, `f1lab/db.py`, `tests/test_quali_frames.py` (new).
**Does:** `TABLE_COLUMNS` for the four new tables and the five `laps` columns;
`QUALI_TABLE_ORDER`; `build_quali_frames`; the §4 estimators; §2.1.1's `_fallback`;
`build_race_frames` / `build_sprint_frames` emitting `None` for the five new columns;
`SESSION_CHILD_TABLES` insertion before `"laps"`.
**Depends on:** WP1 (migrated), WP2 (function signatures).

```bash
.venv/bin/python -c "from f1lab import db; import psycopg; \
  c=db.connect(); db.check_schema(c)"   # no SchemaMismatch (db.DEFAULT_DSN carries the password;
                                        #  a bare postgresql://f1@localhost/f1 fails fe_sendauth)
.venv/bin/python -m pytest tests/test_quali_frames.py tests/test_schema_contract.py -q
# asserts: no empty-string classified_position/status; gap_to_pole vs gap_to_pole_common
#          differ for >=10 of 20 drivers at 2024 Bahrain; below_noise true for 2026 Monza LEC/HAM
```

## WP4 — Ingest and the backfill

**Owns:** `f1lab/ingest.py`, `tests/test_ingest_cli.py`, `tests/test_guards.py`,
`tests/test_quali_ingest.py` (new).
**Does:** `_session_start` (exact match); the Q/SQ schedule rows; `_KIND_RANK`;
`--only-quali` / `--no-quali`; `messages=(kind in ("Q","SQ"))` in `load_with_retry`; the
three-way `build_*_frames` dispatch; kind-aware `_check_loaded`; the §2.2 partial-write path.
**Depends on:** WP3.

**Existing tests this package must fix — found by grep, not by hope:**

| test | breakage | fix |
|---|---|---|
| `tests/test_ingest_cli.py:192` | `assert set(rows) == {"R","S"}` on 2024 R05, a sprint round that now has four sessions | `{"R","S","Q","SQ"}` |
| `tests/test_ingest_cli.py:206-248` | the sprint-failure and interrupted-run tests stub `load` by kind and assert run counters `("ok",2,2,0)` and `("partial",2,1,1)`; `--round` now attempts four loads | stubs gain `Q`/`SQ` and the `messages` kwarg; counters become 4-session |
| `tests/test_guards.py:85-86` | `def load(year, rnd, kind, cache=None)` breaks on the new `messages` kwarg | add the kwarg |
| `tests/test_guards.py:74-77` | `_check_loaded` becomes kind-aware | add `Q` and `SQ` cases |

**`_check_loaded` for Q/SQ:** require at least one non-null `Q1` in `results` **and** at least one
representative lap. SQ is held to the **same** standard as Q — with `messages=True` it publishes
the same payload (§5.2), so a genuinely broken SQ ingest must fail rather than store a husk.

**A test pins the race-side flag:** `load_with_retry(kind="R")` must call with
`messages=False`, so the 71 existing races cannot silently change (§5.6).

```bash
.venv/bin/python -m pytest tests/test_ingest_cli.py tests/test_guards.py tests/test_quali_ingest.py -q
make ingest SEASON=2024 ARGS="--only-quali"
make ingest SEASON=2025 ARGS="--only-quali"
make ingest SEASON=2026 ARGS="--only-quali"
Q="docker exec f1-postgres psql -U f1 -d f1 -c"
# expect R 71, S 18, Q 71, SQ 18 (178 sessions):
$Q "SELECT kind, count(*) FROM sessions GROUP BY kind ORDER BY kind"
$Q "SELECT count(*) FROM quali_results"
$Q "SELECT count(*) FROM quali_results WHERE NOT set_a_time"
$Q "SELECT count(*) FROM laps WHERE quali_segment IS NOT NULL"
# a pole-sitter with no time is impossible; expect 0 rows:
$Q "SELECT s.kind, count(*) FROM quali_results q JOIN sessions s USING (session_id)
    WHERE q.position = 1 AND q.best_s IS NULL GROUP BY 1"
$Q "SELECT status, count(*) FROM session_ingests WHERE kind IN ('Q','SQ') GROUP BY 1"
# every SQ row and no Q row is 'derived':
$Q "SELECT s.kind, q.times_source, count(*) FROM quali_results q
    JOIN sessions s USING (session_id) GROUP BY 1,2 ORDER BY 1,2"
# idempotency (§1.3) made falsifiable:
make ingest SEASON=2025 ARGS="--only-quali"     # run twice; no row count anywhere changes
docker exec f1-postgres psql -U f1 -d f1 -c \
  "SELECT max(si.ingested_at), max(si.run_id) FROM session_ingests si
   JOIN sessions s USING (session_id) WHERE s.kind='R'"          # unchanged from before WP4
#  (session_ingests has neither an `updated_at` nor a `kind` column; kind lives on `sessions`.)
```

## WP5 — Season aggregate

**Owns:** `f1lab/season.py`, `tests/test_season_quali.py` (new).
**Does:** the `season_quali_h2h` delete-and-rebuild — median/MAD, `comparable` filter, the
`kind` split, `sessions_caveated`.
**Depends on:** WP4's backfill. Parallel with WP6 and WP7.

```bash
make recompute SEASON=2025
Q="docker exec f1-postgres psql -U f1 -d f1 -c"
$Q "SELECT year, kind, count(*), sum(a_wins+b_wins) FROM season_quali_h2h GROUP BY 1,2 ORDER BY 1,2"
$Q "SELECT count(*) FROM season_quali_h2h WHERE a_wins + b_wins <> sessions_counted"  # expect 0
$Q "SELECT count(*) FROM season_quali_h2h WHERE deltas_counted > sessions_counted"    # expect 0
```

## WP6 — Ask box

**Owns:** `scripts/ask_manifest.yml`, `scripts/gen_ask_schema.py`,
`scripts/sql/0005_ask_views.sql`, `web/lib/ask/schema-doc.txt`, `web/lib/ask/ask-objects.json`,
`web/lib/ask/prompt.ts`, `tests/test_ask_schema_sync.py`.
**Does:** §5.3.1, §5.3.2 and §5.3.3 — including the hand-written `prompt.ts` and the
`ask_answer_cache` invalidation.
**Depends on:** WP4's backfill (the generator cross-checks the live `information_schema`).

```bash
.venv/bin/python scripts/gen_ask_schema.py
grep -rci "there are no qualifying sessions" web/lib/ask/ scripts/       # expect 0
grep -c "CREATE OR REPLACE VIEW" scripts/sql/0005_ask_views.sql          # expect 61
grep -n "qualifying" web/lib/ask/prompt.ts                               # lines 70/84/102 updated
docker exec -i f1-postgres psql -U f1 -d f1 < scripts/sql/0005_ask_views.sql
docker exec f1-postgres psql -U f1 -d f1 -c \
  "DELETE FROM ask_answer_cache WHERE prefix_sha256 <> '<new prefix from the generator log>'"
cd web && npx tsx --test lib/ask/*.test.ts
# manual: ask "who out-qualified whom at Monaco in 2024" -> answered from quali_results
```

## WP7 — Web

**Owns:** `web/lib/queries/quali.ts` (new), `web/components/quali/**` (new),
`web/app/race/[year]/[round]/page.tsx`, `web/app/driver/[code]/page.tsx`,
`web/app/season/[year]/page.tsx`, `web/lib/queries/quali.test.ts` (new).
**Does:** §6 in full. May start against hand-written fixtures as soon as WP1 lands, since it
shares no file with any other package; its verification needs WP4's backfill.

```bash
make build                      # from the REPO ROOT, not web/: the Makefile lives at the root
#                               # and the target is `cd web && npm run typecheck && lint && build`
# then load and check the captions render verbatim:
#   /race/2024/8   (Monaco: 21 deletions, 4 non-green official times, C-QUALI-1..4, C-QUALI-6)
#   /race/2024/21  (Sao Paulo: wet, C-QUALI-7 and the segment-repair provenance note)
#   /race/2024/5   (Shanghai: a sprint weekend, both Q and SQ blocks, neither degraded)
#   /driver/VER    (C-QUALI-5 with the Wilson band)
#   /season/2025   (pole column; greyed h2h under 5 sessions)
```

## WP8 — Specs

**Owns:** `docs/SPEC.md`, `docs/MODE1_SPEC.md`, `docs/MODE2_SPEC.md`, `docs/MODE3_SPEC.md`,
`docs/RUNBOOK.md`, and §10 of this file. Exactly the amendments tabulated in §5.4 and §5.1.2.
**Last**, so the as-built numbers are copied from the verified database rather than from this
file.

```bash
grep -rn "no qualifying sessions\|NO QUALIFYING SESSIONS" docs/ scripts/ web/   # expect 0 outside changelogs
grep -n "0.653" docs/MODE1_SPEC.md    # the ceiling paragraph is present and unchanged in value
```

## Sequencing

```
WP1 ──┬─> WP3 ──> WP4 ──┬─> WP5 ──┐
WP2 ──┘                 ├─> WP6 ──┼─> WP8
WP7 (fixtures) ─────────┴─────────┘
```

WP1 and WP2 run in parallel from day one. WP7 may develop in parallel throughout and verifies
after WP4. WP5, WP6 and WP7 are genuinely parallel: they share no file and all three read only
what WP4 wrote.

---

# §8 Risks

**R1 — The segment-window rule breaks on a session shape outside the corpus, and the obvious
assertion does not catch it.** This is the highest-probability failure in the release and it has
already been demonstrated: **2024 R21 São Paulo Q** yields exactly 3 `Started→Finished` windows —
so a window-count assertion passes — and still mis-assigns 3 of 44 driver-segments (ALO Q2
−3.963 s, ALB Q2 +1.232 s, PIA Q2 +0.493 s; ALO's results row carries `Q2 == Q3 == 1:28.998`).
*Mitigation:* the **strict per-driver-per-segment anchor is the runtime gate**, never the window
count (§2.2 stage 2, decision D8). One bounded repair is allowed; anything still failing marks the
session `partial` with the per-segment tables omitted. São Paulo is mandatory in the acceptance
fixtures (§7, WP2).

**R2 — `laps` stops being race-only and an unaudited query starts reading qualifying laps.**
All nine current consumers were verified safe (§3.1), but the *next* query written will not know
the rule.
*Mitigation:* the rule in `SPEC §1.4` and in `web/db/schema/laps.ts`'s comment, plus a
grep-shaped regression test asserting that every `FROM laps` / `.from(laps)` occurrence either
constrains `sessions.kind` or is parameterised by a single `session_id`. The seed list is exactly
the eight rows of §3.1's audit table; the test fails loudly on the ninth.

**R3 — `messages=True` is unavailable or incomplete for some cached session.** Without race-control
messages, deletions are invisible (Monaco 21 → 0) **and** every sprint-qualifying segment time
comes back NaT. The in-flight warm calls `s.load(..., messages=True)`
(`scripts/warm_cache.py:62`), so the pickles should be there — but a partially warmed session
would otherwise fail silently and plausibly.
*Mitigation:* the anchor gate catches it — a session loaded without messages cannot reproduce its
official times once deleted laps are back in the population — and marks the session `partial`
rather than storing wrong segment times. `--only-quali --kinds Q,SQ` retries never re-read a race.
`excl_disallowed` (§2.4) is the second, weaker net, with its measured 2-of-4 blind spot stated.

**R4 — Field sizes are not constant and something hard-codes 20/15/10.** Measured: 2026 runs
22/16/10; 2024 R10 Barcelona had only **9** Q3 times; 2024 R03 Melbourne had 19 drivers.
*Mitigation:* nothing in §3 or §4 reads a band size — `segments_entered` comes from lap presence,
band boundaries are only ever rendered per session from `knocked_out_in`. A test asserts
`quali_results` row counts of 20, 19 and 22 on three named sessions, and that
`quali_segment_times` has a segment-3 row count of 9 for 2024 R10.

**R5 — The Mode 2 refit gets pulled into this release.** The data will exist, the temptation is
immediate, and ρ = 0.970 between qualifying position and race grid makes the rank-level swap look
nearly free. It is not: the change worth making is the continuous response, which is a new model,
and validating it against rows produced by this release's own brand-new ingest leaves no
independent check.
*Mitigation:* v1.6 ships MODE2_SPEC §3.0/§3.2/`C-SKILL-2` amended to say the surrogate **remains**
and why, with the v1.7 retirement criterion (r ≥ 0.95) and both identifiability gates written down
in advance (§5.1.1), so it is decided by a number rather than by whoever is in the room.

**R6 (watch item) — a stale ask-box answer outlives the regeneration.** `ask_answer_cache` rows
keyed on the old `prefix_sha256` were produced by a model told qualifying does not exist.
*Mitigation:* §5.3.3's `DELETE` is part of WP6's definition of done, not a follow-up.

---

# §9 Decisions log

One line each. "P1" = data-first, "P2" = analytics-first, "P3" = integration-first.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | `laps` reuse vs a separate `quali_laps` | **Reuse `laps`** (P1) | 34 of 41 columns are identical and more meaningful in qualifying; the audited consumer list is clean; P3's "six unfiltered readers" argument for a separate table was verified false, and its surviving grounds (cast_frame drift, index predicate) are one edit and a perf non-event |
| D2 | `kind` as text or enum | **text** (P1, P2, P3 agree) | the unique key already covers it; an enum costs a migration per format change |
| D3 | Does sprint qualifying publish results? | **Yes — 20/20 Position, 20/15/10 Q1/Q2/Q3** (P1) | P2 and P3 measured through `messages=False` and concluded FastF1 publishes nothing for SQ; two judges reproduced 20/15/10 with `messages=True`. Every design consequence of the false claim is deleted |
| D4 | SQ first-class or results-only | **First-class** (P1) | follows from D3; SQ is the only pace signal on a sprint Friday and adds 20% more teammate samples |
| D5 | Ingest order | **kind rank `{R:0,S:1,Q:2,SQ:3}`** (P1) over chronological (P3) | additive log diff, byte-identical ordering for existing rounds, and it does not invert existing test assertions; per-session transactional idempotency already gives what chronological order was buying |
| D6 | Is FastF1's `Deleted` broken for 2024? | **No — the caller passes `messages=False`** (P1, P3) | P2 attributed it to the library and invented `excl_disallowed` to patch it; 2024 Austria goes 0 → 4 deletions with the flag on |
| D7 | Keep `excl_disallowed`? | **Yes, as a diagnostic, never as a filter** (P2's idea, re-justified) | as a filter it makes the anchor test true by construction; as a net it catches only deletions faster than the driver's own Qk — measured 2 of 4 at 2024 Austria |
| D8 | Green-flag rule in qualifying | **Reported, never applied** (P1, P2) | four official Monaco Q1 bests sit on TrackStatus '12'; applying the race rule kills 34 of 356 official times corpus-wide |
| D9 | 107% outlier rule | **Dropped for Q/SQ; `is_outlier` always false** (P1) | it would remove 79 of 224 legitimate Monaco laps; it assumes every lap is a push lap |
| D10 | Outlier / push-lap benchmark scope | **Per-driver-per-segment, never session-wide** (P2's argument, P1's mechanism) | 2024 China SQ ran SQ3 wet at +23.4%; a session-wide benchmark keeps zero SQ3 drivers |
| D11 | What is the acceptance gate? | **Strict per-driver-per-segment anchor**, not window count, not lap existence (judge 1) | São Paulo yields 3 windows and still mis-assigns 3 of 44; existence-matching cannot detect it |
| D12 | Anchor failures: partial or repair? | **One bounded repair, then partial** (this spec) | P1 marked partial immediately, losing recoverable sessions; the repair is bounded, counted, and its effect on the test's two-sidedness is reported separately |
| D13 | Anchor totals reported | **Q and SQ separately: 314 external, 89 self-consistent** (judge 3) | FastF1 computes SQ's segment times from these same laps, so reproducing them is consistency, not validation. P1's pooled "403 of 403" overstated the evidence |
| D14 | Gap to pole: one number or two | **Two — TV and same-segment** (P3) | they disagree for 10–14 of 20 drivers per session and by 7.539 s at wet São Paulo |
| D15 | Ranking unit | **Percent** (P2, P1) | a tenth is 0.142% at Monaco and 0.088% at Spa — a 1.6× spread |
| D16 | Mode 2 refit in this release? | **No — v1.7, pre-specified** (P1, P3) over P2's gated in-release refit | the new response is a new model; validating it against rows from this release's own new ingest leaves no independent check |
| D17 | Mode 2 response when it is refit | **`gap_to_pole_common_pct`**, not raw gap-to-pole percent (P3's column, P2's fit) | the TV number absorbs Q1-eliminated drivers' track-evolution deficit as driver slowness |
| D18 | Do the floating drivers unfloat? | **No — norris, piastri, alonso, stroll stay floating**, and it is a run-time gate in v1.7 (P1's mechanism, P2's gate) | a new skill axis is a new response over the same design matrix; qualifying carries the same `session_entries` as its own race, so no team-switch edge is added |
| D19 | `grid_pace` rows when the refit lands | **Kept, retired only if r ≥ 0.95** (P1) | they measure a different quantity — where you *started*, penalties included — not a worse version of the same one |
| D20 | MODE2 §3.2 / `C-SKILL-2` in v1.6 | **Amended, text only** (P3) | "we cannot subtract it, because there are no qualifying times" becomes false the day 0006 ships |
| D21 | MODE1 §3.5's 0.653 ceiling | **Unchanged, and §3.5 must say so explicitly** (P1, P2, P3 agree) | a future race has no qualifying time any more than it has a grid; without the paragraph a reader will assume otherwise |
| D22 | Race-side `messages` flip | **Out of scope; pinned by a test; booked for v1.7** (P3) | it would change `pace_ranking`, `degradation_fits`, `teammate_deltas` and every Mode 2 fit on 71 races |
| D23 | `fastest_pace_driver_id` for Q/SQ | **Pole sitter, as a definitional choice with caption `C-QUALI-9`** | P1 justified it by claiming the fastest lap and the result are the same thing in qualifying; on a drying track they are not |
| D24 | `season_quali_h2h` pooling Q and SQ | **Never — `kind` is in the primary key from the start** | different tyre rules, different track states; also fixes P1's internal inconsistency between its §C.6 DDL and its §E.2 amendment |
| D25 | `prompt.ts` | **In scope, hand-edited (lines 70, 84, 102)** (P3) | the generator writes only `schema-doc.txt` and `ask-objects.json`; without this the ask box refuses the feature it just gained |
| D26 | `ask_answer_cache` | **Invalidated in the same package that regenerates the doc** (missed by all three) | cached answers keyed on the old prefix came from a model told qualifying does not exist |
| D27 | Uncertainty floor | **Session repeatability governs every teammate number; below it, print words not digits** (P2) | LEC's 0.007 s over HAM at 2026 Monza is 26× smaller than that session's 0.186 s |
| D28 | Best-of-n bias | **Disclosed via `n_repr_laps`, not corrected** (P3) | there is no defensible correction at n = 2; the honest move is to show the count |
| D29 | Career teammate head-to-head | **Counts per year; no pooled cross-season mean** (P2) | different cars, teammates and regulations |
| D30 | Migration location | **`web/drizzle/0006_quali.sql`** | P1 named `web/db/migrations/`, which does not exist |
| D31 | `laps` column count baseline | **41** (P1) | verified against `information_schema`; P2's 44 was wrong and it was the census the reuse-vs-new decision was costed on |
| D32 | Empty-string `ClassifiedPosition` / `Status` | **`_fallback` in `frames.py`** (P3) | FastF1 hands qualifying `''`, not null, so the existing null→`'N'`/`'Unknown'` mapping misses it and 89 × ~21 rows would store `''` in NOT NULL columns |

---

# §10 As built

*Integration record, 2026-09-15. Every number below was read out of the live database after the
backfill, not copied from this file. Where the built thing differs from what §§1–7 specify, the
difference is stated here rather than quietly corrected upstream — the spec is the plan and this
section is the record of what the plan met.*

## 10.1 The database

| Quantity | Before v1.6 | After |
|---|---|---|
| tables (`public`, base tables) | 63 | **67** |
| sessions | 89 (R 71, S 18) | **178** — R 71, S 18, **Q 71, SQ 18** |
| `laps` rows | 69,548 | **92,963** (+23,415, **+33.7%**; §3.1 estimated ≈27,000 / +39%) |
| `laps` columns | 41 | **46** |
| database size | 121 MB | **126 MB** (+5 MB; §3.1 estimated +12–15 MB) |
| `quali_results` | — | **1,588** (Q 1,241 `api`, SQ 347 `derived`; 14 with `set_a_time` false; **0** poles without a time) |
| `quali_segment_times` | — | **3,503** (18.2% with `repr_laps < 2`, so §4.3's noise-floor fallback is the common case, not the edge) |
| `quali_teammate_h2h` | — | **779** (371 = **47.6%** `below_noise`, 13 not comparable) |
| `season_quali_h2h` | — | **80** rows over 789 pair-sessions, 726 of them with a delta |
| `laps.deleted` true | 0 of 69,548 | **341**, every one of them a qualifying lap (Q 274, SQ 67); still **0** on all 69,548 race and sprint laps |

`excl_deleted` — the rule that had never excluded a single lap in the life of the project —
excluded **21 of 426** at 2024 R08 Monaco Q, exactly the measurement §2.3 was built on. It
remains inert for `R`/`S` by decision (§5.6, v1.7), pinned by two tests.

**D6 is justified more strongly than §4.1 claimed.** Of the 1,574 `quali_results` rows carrying
both gaps, **978 (62%)** disagree by more than half a millisecond — §4.1 said "half the time".

`segments_entered` splits **403 / 410 / 775**.

## 10.2 The anchor, which is the whole gate

Across the 78 ingestible Q/SQ sessions the **pre-repair** per-driver-per-segment anchor is
**3,501 of 3,505 (99.89%)**, and **76 of 78 sessions are 100%**. The two that are not are the
two the spec named as the release's hardest cases:

| session | pre-repair | outcome |
|---|---|---|
| 2024 R21 Q São Paulo | **41 / 44** | 3 waived (ALO Q2 −3.963 s, ALB Q2 +1.232 s, PIA Q2 +0.493 s), session `ok`, `segment_repairs = 3` |
| 2025 R07 Q Imola | **42 / 43** | unrepairable (BEA segment 1, Δ−0.841 s) → **`partial`**, both per-segment tables empty |

Four sessions are caveated corpus-wide (`cross_segment_ok` false **or** `segment_repairs > 0`):
**2024 R05 SQ** Shanghai (the wet SQ3, +23.4%), **2024 R12 Q** Silverstone, **2024 R21 Q** São
Paulo and **2025 R07 Q** Imola. Only Imola is `partial`; the other three publish everything.

**`segment_source = 'anchor_repair'` is true on ZERO of 20,568 stored qualifying laps.** §2.2's
stage 3 — move a lap into the segment its official time proves it belongs to — has **no measured
exercise anywhere in 79 sessions**. The implementation carries the value, the CHECK allows it and
`frames.py` handles it, but nothing has ever produced one. The three São Paulo "repairs" are a
*different, prior mechanism* the implementation had to add (§10.4 A). Treat stage 3 as
speculative until a session exercises it.


## 10.3 The backfill, and the two sessions that are not `ok`

Six runs (`ingest_runs` 535–545), `--only-quali --sleep 0` per season plus a
`--recompute-season` per season. **Zero FastF1 API calls** — the cache covered everything — and
no rate limit was hit. Per-season wall clock 3 m 39 s / 2 m 29 s / 1 m 40 s, of which each
session's load + compute + write is **0.5–1.3 s**; the rest is the per-run companion recompute.

**77 ok, 1 partial, 1 failed.**

- **2025 R07 Q Imola — `partial`.** D8's runtime gate firing for real, which is the evidence
  that the gate is not decorative. `analytics_status` is
  `{quali_segment_times: empty, quali_teammate_h2h: empty, lap_exclusion_report: ok}`; 20
  `quali_results` rows and 281 laps are written. Any query assuming a `quali_results` row
  implies a `quali_segment_times` row is wrong on this session.
- **2025 R06 Q Miami — `failed`, and the cache is therefore NOT complete for this release.**
  §7's environment note says all 62 Q + 17 SQ sessions are warmed; 78 of 79 are. Loaded with
  `messages=True` this one returns 20 results rows with `Position` on 20/20 and Q1/Q2/Q3 on
  **0/0/0**, plus 314 laps. There is nothing to reconstruct the classification from, so
  `_check_loaded` refuses the husk rather than storing invented times. It is invisible to the
  whole web surface and its season-page pole cell is an em dash. It was **not** re-fetched
  (rate-limit risk); someone should confirm whether a fresh pull fixes it before v1.6 ships.

**Idempotency, proven three ways.** A 12-row count snapshot was byte-identical across a repeat
`--season 2025 --only-quali` and a forced re-ingest of 2024 R21. Across all six runs the race
side never moved: `session_ingests` for `R`/`S` still max at `run_id` 534 with the same
`ingested_at`. And a full content digest (row count + `md5(string_agg(row::text))`) of
`pace_ranking`, `degradation_fits`, `teammate_deltas`, `fuel_sensitivity`, `results`,
`race_report`, all twelve `mode2_*` tables and the 69,548 race/sprint `laps` rows is
**identical before and after the entire release**, pinned in
`tests/test_quali_integration.py`. **D7 holds: no `mode2_*` row was written, deleted or
refitted.** A plain `--only-quali` run logs `mode2: skipped=True`; do not add `--force`.

## 10.4 What was built differently, and why

### A. The São Paulo "repair" is not §2.2 stage 3, and it needed its own mechanism

§2.2 stage 3 as written moves a lap. It resolves nothing at São Paulo: ALO's official Q2 **is**
his Q3 (`1:28.998` twice), so the only lap matching Q2 is the Q3 lap that is already correctly
assigned, and moving it would break the Q3 anchor. The implementation added a prior mechanism:
**waive** a failing driver-segment whose official value is a byte-identical copy of another
segment's, provided that other segment's anchor holds strictly. `clean_quali` returns the waived
pairs as `diag['waived']`.

**This created the release's worst defect, and it is now fixed.** `frames.py` originally never
received that list, so the three waived rows were written **as if verified**, and the two tables
disagreed in the live database with nothing marking it:

| driver | `quali_results.q2_s` | `quali_segment_times.best_s` | Δ |
|---|---|---|---|
| alonso | 88.998 | 85.035 | **−3.963 s** |
| albon | 84.657 | 85.889 | +1.232 s |
| piastri | 84.686 | 85.179 | +0.493 s |

Measured in rendered markup: `/race/2024/21` printed `1:28.998` in the result table and
`1:25.035` in the segment strip, 3.963 s apart, on one page.

**The fix, and it is a schema change the spec did not have.** Migration **`0007_quali_verified`**
adds `quali_segment_times.verified boolean NOT NULL DEFAULT true` (§3.4's column list is
therefore **16**, not 15). `clean_quali`'s waived list is threaded into
`frames.quali_segment_times` and `frames.quali_teammate_h2h`, so:

- the three rows carry `verified = false` — the only three in 3,503;
- the one pair whose deepest common segment was waived (2024 R21 STR v ALO, segment 2) is
  `comparable = false` with NULL deltas, so the season aggregate no longer counts a Q3 time
  wearing a Q2 label as a measured teammate gap (2024 Q `deltas_counted` 235 → **234**; the win
  still counts, exactly as a pair with no shared segment does);
- `web/lib/queries/quali.ts` exposes `verified` on `QualiSegmentRow`, the segment strip draws
  those dots dashed and hollow with the reason in the tooltip, and a new caption **`C-QUALI-10`**
  (not one of §6.3's nine) appears under the strip. The dagger on the official cell that WP7
  added from the warning string stays — it marks the other half of the same disagreement;
- `ask_manifest.yml` gains the column's purpose and a sixth qualifying convention telling the
  model an unverified segment best must never be reported as a measured time.

The warnings (`quali_waived_segments=ALB:2,ALO:2,PIA:2`) remain, because `season.py`'s
`sessions_caveated` and §6.3's captions key on them.

### B. `quali_results.position` is not always present, and unclassified rows are dropped

§3.3 declares `position integer NOT NULL, -- results.Position, 1..N, always present (Q and SQ)`.
That was measured on 2024 and is **false for 2025/2026**. Nine results rows across five sessions
carry no `DriverId`, no `TeamId`, no `Position`, no Q1/Q2/Q3 and at most an out-lap and an
in-lap: 2025 R21 Q (BOR), 2026 R01 Q (STR, VER, SAI), 2026 R02 SQ (PER), 2026 R05 SQ (ALB, LAW),
2026 R14 Q (STR, BEA). Written verbatim they produce NULLs in two NOT NULL columns and the first
backfill pass lost all five sessions.

**Policy added by the implementation, recorded here because the spec does not contain it:**
`ingest.drop_non_entries` removes such a row before the frames are built and names the codes in
`session_ingests.warnings[]` as `quali_non_entries_dropped=<CODES>`. **The line it will not
cross is a flying lap** — a driver who actually set a time is never dropped, so §3.3's defect
fails loudly instead of being papered over. Cost: four raw out/in-lap rows, all of which §2.3
excludes anyway. Benefit: five sessions that would otherwise be lost. `session_entries` is
therefore shorter than FastF1's results frame on exactly those five sessions.
`quali_non_entries_dropped` is a **completeness** note, not a data-quality caveat about the
times, and `season._is_caveated` deliberately ignores it.

FastF1 also spells a missing `DriverId`/`TeamId` as the literal string `'nan'` on some 2025/2026
Q sessions; `ingest.identity_from` skips those and fills the gap from the weekend's sibling
sessions. Two orphan rows survive in the reference tables — `drivers.driver_id = 'nan'` and
`teams.team_id = 'nan'` — duplicating `bearman` and `haas`. They are filtered out of the ask
box's vocabulary block (so the model is never taught to write `= 'nan'`) but remain queryable
through `ask.drivers` / `ask.teams`. **Open; a data fix for v1.7.**

### C. Numbers in this spec that the implementation does not reproduce

- **The 0.186 s noise floor and "26×" (§0.4 note 2, §4's preamble, caption `C-QUALI-4`).** At
  2026 Monza the median `quali_segment_times.sd_s` across the session is **0.218 s**, and the
  value actually *stored* beside the Ferrari pair — the median of LEC's and HAM's own Q3 `sd_s`,
  which is what §3.5 defines `session_sd_s` to be — is **0.302 s**. The 0.007 s gap is therefore
  **43× below the floor**, not 26×. Direction, conclusion and `below_noise = true` are unchanged.
  `C-QUALI-4` ships §6.3's wording verbatim because §6.3 says these strings ship exactly as
  written and a test pins them to it; **the caption and §0.4 must be amended together in v1.7**,
  and whoever does it must re-run the caption diff or that test goes red.
- **The Austria round number.** §1.4/§2.1/§2.4/§7 said "2024 R09 Austria". FastF1 round 9 of 2024
  is the **Canadian** GP (5 deleted laps, `excl_disallowed` firing on 0 of them); Austria is
  **round 11** and carries exactly the four deletions §2.4 names with the diagnostic firing on
  exactly 2. **Corrected in this file.**
- **`sessions.fastest_pace_driver_id` cannot answer `C-QUALI-9`'s question.** §4.5 defines it as
  the classified P1, so it *is* pole by construction and can never disagree with pole. §6.1's
  `fastestLapDriverId` is therefore derived instead as the driver holding
  `min(quali_segment_times.best_s)`, null when `crossSegmentOk` is false (comparing across
  incomparable segments is exactly the error §4.6 gates) and null on a `partial` session. That is
  a defensible reading but it is not what §6.1's field comment says. It fires on **three**
  sessions — 2024 R01 Q (LEC 89.165 < VER 89.179), 2024 R06 SQ, 2025 R14 Q — and is correctly
  suppressed on the fourth, 2024 R05 SQ, whose segments are not comparable. §7's WP7 fixture list
  named none of them; **2024/1 should be in it.**
- **§7's WP7 fixture list says 2024/5 Shanghai is "neither degraded".** 2024 R05 SQ has
  `cross_segment_ok` false — the wet SQ3, +23.4%, exactly §0.4 note 8's case — so the SQ block
  renders `C-QUALI-7` and suppresses the ghosted television bar while its Q sibling keeps it.
  Not degraded in the D3 sense; it does and must carry the comparability caveat.

### D. Signatures that differ from §6.1

- `getCircuitQualiHistory(circuitKey: number, driverIds: string[], exclude?: {year, round})` —
  §6.1 says `circuitId: string`, but there is no circuit id column; a circuit is
  `events.circuit_key`, an integer. The third argument is not in §6.1 and is necessary: without
  it a round's own qualifying session counts as one of its "previous" sessions.
- `QualiSession` carries two fields beyond §6.1: `perSegmentAvailable: boolean`, forced by §6.6
  row 3, and `waivedSegments`, from §10.4 A. `QualiSegmentRow` carries `verified`.
- §6.4 calls the historical panel a "weekend preview" page. There is no `/preview` route and
  never was (`MODE1_SPEC §3.1`); the panel renders inside the unraced-round branch of
  `app/race/[year]/[round]/page.tsx`, above and visually separate from the forecast.

### E. Verification commands in §7 that do not run as written

| Written | Actually |
|---|---|
| `pnpm drizzle-kit generate` (WP1) | this project is **npm**: `npx drizzle-kit generate --name quali`, then `npm run db:migrate` |
| `SELECT count(*) … WHERE table_name='laps'` → 46 (WP1) | returns **87** without `AND table_schema='public'`; the MODE3 `ask` schema also has a view named `laps` |
| `psycopg.connect('postgresql://f1@localhost/f1')` (WP3) | fails `fe_sendauth: no password supplied`; use `db.connect()` |
| `SELECT max(updated_at) FROM session_ingests WHERE kind='R'` (WP4) | `session_ingests` has neither column; join `sessions` and use `ingested_at` |
| `cd web && make build` (WP7) | there is no `web/Makefile`; the target is `make build` from the repo root |
| **any `make` target at all** | `/usr/bin/make` on this Mac is an Xcode shim and exits 69 with *"You have not agreed to the Xcode license agreements"* before any recipe line runs. **Every Makefile-based command in every spec is dead on this machine** until `sudo xcodebuild -license` is accepted. Recorded in `RUNBOOK §6`; each target's body was run directly instead |

All six are corrected in this file.

### F. Fixes made in files no work package owned

Five surfaces were left saying something the release had just made false, in files that appear in
no WP's ownership block. The integration pass fixed them:

| file | was | now |
|---|---|---|
| `web/app/ask/page.tsx` | *"there are no qualifying sessions in this database"* — the **first sentence a fan reads** above the ask box | the §5.3.2 replacement: races, sprints and qualifying, and what the two similar-sounding measures are |
| `web/components/driver/SkillPanel.tsx` (`C-SKILL-2`) | *"because there are no qualifying lap times in our data at all"* | §5.1.2's wording. `MODE2_SPEC` amendments change the spec; only this changes the rendered string |
| `web/lib/ask/validate.test.ts` | `ASK_OBJECTS.size === 57`; ten reference queries whose Q1 used `teammate_h2h.grid_wins` | 61; Q1 rewritten to `season_quali_h2h` and two qualifying queries added, matching the manifest's twelve |
| `web/lib/ask/askPool.ts` | *"the 57 generated views"* | 61 |
| `web/package.json` | the `test` script enumerated files and **omitted `lib/queries/quali.test.ts`**, so WP7's 13 tests never ran in CI | `lib/queries/*.test.ts` added |
| `tests/test_frames.py` | `EXPECTED_COLUMNS` set without the four new tables and `len(laps) == 41` — **the non-db suite was red before this pass** | the four tables, 46, and the five new columns asserted in DDL order |
| `scripts/gen_ask_schema.py` COVERAGE block | *"158 ingested sessions … 92,963 laps"* — one total, in the one block the model always reads, now that `laps` is no longer race-only | the session count split by kind, and the lap count split into 23,415 qualifying and 69,548 race/sprint with the sentence that an unfiltered `ask.laps` aggregate mixes them |

`PROMPT_PREFIX_SHA256` was re-derived after every regeneration and is
`3704a1a071379187c4dccea5c21a3540e4e879816398e3ca16f8c204eac70457`. §5.3.3's
`DELETE FROM ask_answer_cache WHERE prefix_sha256 <> …` is a **no-op**: the table holds zero
rows, verified, so no answer produced by a model told qualifying does not exist can be served.

### G. One bug fixed that v1.6 did not cause

`tests/test_full_seasons.py` was failing on two `failed` session rows. One is 2025 R06 Q Miami
above. The other was **2024 R05 S**, whose error read `simulated: no timing data available for
2024 R05 S` — **stale residue from a `tests/test_ingest_cli.py` run that never restored the
row.** Its 20 `results` rows were in the database all along; only the status was wrong, which
was enough to drop that sprint out of `season.py`'s `sprint_ok` set: 2024's season-end sprint
points read **180 instead of 216**. `--season 2024 --no-quali` selects exactly the non-`ok`
race/sprint sessions of the year, so it re-ingested that one session and nothing else; the
content digest of every race analytics table and the 69,548 race/sprint laps is **still
identical** afterwards, because no analytics row had ever been wrong — only the standings
derived from a status.

`test_every_completed_session_is_ok_or_partial_with_a_reason` now carries a one-entry
`PERMANENTLY_UNAVAILABLE` allowlist (Miami) that also asserts the *recorded reason*, so a
different failure at the same round cannot hide behind it, with a comment saying in as many
words that stale test residue is a bug in the database and does not belong in the list.

## 10.5 Where this leaves v1.7

Booked, in priority order: (1) the race-side `messages=True` flip and everything it re-computes
(§5.6); (2) the Mode 2 refit onto `gap_to_pole_common_pct` (§5.1.1); (3) amend §0.4 note 2, §4's
preamble and `C-QUALI-4` to the measured 0.302 s / 43× together; (4) delete the two `'nan'`
orphan rows and stop `drop_non_entries` from being load-bearing by nulling `quali_results.position`
for unclassified entrants; (5) a `sessions_divergent` column on `season_quali_h2h` — §3.5 stores a
per-session `divergent` flag and §3.6 aggregates nothing, so a season row can show a driver losing
the count while holding a negative median (2025 SQ rb hadjar/tsunoda) with no marker; (6) suppress
`mad_delta_pct` in the database, not only in the UI, below three deltas.

## 10.6 Verification run at the end of the integration pass

| Command | Result |
|---|---|
| `cd web && npm run typecheck && npm run lint && npm run build` | all three clean; `rm -rf .next` first, 10 routes emitted |
| `cd web && npm test` | **113 pass, 0 fail** (100 ask + 13 quali, the latter newly in the script) |
| `.venv/bin/pytest -q -m "not db"` | **349 passed**, 358 deselected |
| `.venv/bin/pytest -q tests/test_quali_integration.py` | **29 passed** (race-analytics digests, D4's pin, the R2 grep test, the three unverified rows, the backfill census) |
| `.venv/bin/pytest -q tests/test_quali_clean.py tests/test_quali_frames.py tests/test_quali_ingest.py tests/test_quali_ask*.py tests/test_season_quali.py tests/test_ask_schema_sync.py tests/test_guards.py tests/test_schema_contract.py` | all pass |
| `.venv/bin/python -m f1lab.ingest --check-schema` | `schema ok` |
| `.venv/bin/python scripts/gen_ask_schema.py --check` | `ask contract is up to date` (61 views, doc 46,307 chars) |
| `grep -rn "no qualifying sessions\|NO QUALIFYING SESSIONS" docs/ scripts/ web/` | only past-tense / changelog references remain |
| browser pass, console clean on all seven | `/race/2024/21` (3 daggers + `C-QUALI-10`, ALO v STR not comparable), `/race/2024/5` (Q **and** SQ blocks, television gap suppressed on SQ), `/race/2024/8` (`excl_deleted` 21 of 426 — the rule's first firing in the life of the project), `/race/2025/7` (`partial`: table and bars, no strip, no teammate table), `/race/2025/6` (failed Q absent, SQ present), `/race/2026/15` (unraced: the history panel, captioned, no forecast input), `/driver/NOR?season=2025`, `/season/2025` (Miami pole cell an em dash) |
