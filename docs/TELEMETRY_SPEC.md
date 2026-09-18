# F1 Analytics v1.7 — The Telemetry Layer
**Status:** specification, not yet built. Version 1.7. Written 2026-09-16.
**Supersedes:** nothing. **Extends:** SPEC.md v1 (§2.4–2.6 frames/db/ingest, §3 web),
QUALI_SPEC.md v1.6 (the precedent for adding a new data kind), MODE3_SPEC.md v1.4 (§1.2 ask
allowlist, §2 generated schema doc).

This file is the sole source for the v1.7 build. Implementers work in parallel from §7 and
may not exceed the file ownership stated there.

**v1.8 amendment (2026-09-17, WP-B3).** `GAPFILL_SPEC §4.5` writes six standing rules into this
file and `GAPFILL_SPEC §3.3` records a refusal against them. The amendment is additive and
touches six places: **§1.1** (replication — and §1.1.1, why it is not the limit), **§2.1** (the corrected sampling
figures, `derive_version`, and the five v1.8 `lap_corner_speeds` columns), **§3.5** (derived
columns need a version), **§4.2** (the release metre), **§4.3** (quantisation is not a validity
floor, the sign test, the repeatability gate), **§4.4** (the trail-braking refusal, recorded in
full), **§4.5** (the standing-rule index), and **§6.2** (never differentiate against distance).
Nothing in v1.7 is deleted; where a v1.7 number is corrected, the old number is left visible
beside the new one so the correction can be audited rather than believed.

---

## Table of contents

- **§0** Scope, fixed decisions, conventions, and what telemetry can and cannot support
- **§1** The stored-lap rule and the session set, with measured sizes
- **§2** Schema — DDL, the row-vs-array decision, `EXPECTED_COLUMNS`, migration 0008, ask manifest
- **§3** Ingest and the warm plan under the rate limit
- **§4** Derived analytics — and (v1.8) the release metre, the trail-braking refusal, and the
  standing-rule index
- **§5** Visuals, and the Distance alignment rule
- **§6** Honesty, and the VERBATIM captions
- **§7** Work packages — single-owner file ownership, sequencing, verification
- **§8** Risks
- **§9** Decisions log
- **§10** As built — what shipped, every deviation (D24–D38 + D9′), the real warm, what is still open

---

# §0 Scope, fixed decisions, conventions

## 0.1 What v1.7 is

Every ingest this project has run passes `telemetry=False`. The 10 Hz car and position
channels are 100% unused. v1.7 stores **one lap per driver per session** of those channels
and builds four pictures on them: a track map painted by a channel, a two-driver delta
trace, a channel stack, and a corner report card.

It is an **additive, optional layer**. Migration 0008 creates five tables and alters
nothing. A database with zero telemetry rows renders every existing page byte-identically
(§2.7, asserted by `tests/test_telemetry_optional.py`). The telemetry pass can fail
completely and the app is exactly the v1.6 app.

## 0.2 Fixed decisions

These are settled. An implementer who believes one is wrong raises it as a spec change,
not as a patch.

| # | Decision | Where |
|---|---|---|
| **T1** | Store **native merged samples**, not a resampled distance grid. | §1.3 |
| **T2** | Stored-lap rule: the driver's **fastest valid lap** in the session. One per driver. | §1.1 |
| **T3** | Session set: the **160 lap-bearing sessions** (71 R, 71 Q, 18 SQ). Kind `S` is excluded — it has **0 laps**. | §1.2 |
| **T4** | **Arrays, one row per lap.** Not 2.2M narrow rows. Measured 3.5× smaller and 4× faster to read. | §2.2 |
| **T5** | `lap_telemetry.distance_m` is the **cumulative chord length of (X, Y)**. FastF1's integrated `Distance` is **never stored and never used for alignment**. | §2.1, §5.2 |
| **T6** | The ask box sees **scalars, never arrays**. `lap_telemetry` and `circuit_layout` are excluded at the GRANT level. | §2.6 |
| **T7** | Telemetry is a **second pass** (`python -m f1lab.telemetry`), not part of `f1lab.ingest`. `clean.load_race` / `load_quali` keep `telemetry=False` for ever. | §3.1 |
| **T8** | A telemetry failure writes `session_ingests.analytics_status['telemetry']` and **never downgrades `status` from `'ok'`**. | §3.6 |
| **T9** | Channel values are **rounded before COPY** (pglz then compresses them ~25%). | §2.3 |
| **T10** | The cross-driver delta trace **does not exist outside Q/SQ** — an absent control, not a disabled button. | §5.2, §6.4 |
| **T11** | `--color-fastest` / `--color-personal` / `--color-slower` are **not used anywhere in this feature**. A new `--ramp-*` group carries magnitude. | §5.0 |
| **T12** | The migration is **0008**. `web/drizzle/0007_quali_verified.sql` already exists and is journal entry 7. | §2.5 |

## 0.3 Conventions (extending SPEC §0.3)

- **Distance** always means chord distance in metres from the lap's first sample, `[0] = 0`.
  Any variable named `distance` that is not chord distance is a bug.
- **Time** within a lap is `time_s`, seconds from the lap's first sample, `[0] = 0.0`.
  Never `SessionTime`, never `Date`.
- **Delta sign**: `delta(s) > 0` means **driver A has taken more time to reach `s`**, i.e.
  A is behind. Stated on the axis in driver codes, never as the word "delta".
- **Position units**: `x` / `y` are stored **raw and unrotated**, in FastF1's own units
  (tenths of a metre). Rotation is applied in the browser from `circuit_layout.rotation_deg`.
- **Percentages of a lap are distance-weighted, never sample-weighted.** Samples are uniform
  in time, so a sample-weighted "full throttle %" over-counts slow corners by roughly 3×.
- **Absent is not zero.** A flat channel stores `NULL` in its derived scalar and renders as
  "no signal", never as a measured 0 (§6.5).

## 0.4 What telemetry can and cannot support

**Can:** where on the road one lap was quicker than another; what the car was doing there
(speed, gear, throttle, brake); the geography of a circuit's slow and fast parts; corner-by-
corner apex speeds and braking points for one lap.

**Cannot, ever, from this data:** which driver is faster; which car is faster; how a stint
degraded; whether a lap was compromised by traffic; what fuel load either car carried; what
engine mode was selected; how much of a straight-line advantage was a tow. None of these is
controlled for and none can be recovered from two laps. §6 is not a disclaimer section — it
is the constraint the visuals are built inside.

---

# §1 The stored-lap rule, the session set, and measured sizes

## 1.1 T2 — the stored-lap rule

> **Store the driver's fastest valid lap in each session. One lap per `(session_id,
> driver_id)`. Nothing else, in v1.7.**

Precisely: among that driver's laps in that session, the minimum `lap_time_s` over laps that
are `is_accurate`, not `deleted`, carry a non-NULL `lap_time_s`, and — for kind `R` only —
are green-flag (`track_status` all `'1'`) and are neither an in-lap nor an out-lap.
A driver with no such lap gets **no row**. That is a fact, not a gap, and §3.6 records it.

"Fastest" is chosen as a **limitation, not a virtue**. It is the one lap of the session
where the driver was, as far as the data can tell, trying — the only lap two drivers can be
compared on without adding an argument about *intent* to the arguments about fuel and tyres
that already cannot be settled. Every other candidate (median lap, stint-representative lap)
introduces a selection step whose defensibility the app would then carry into every caption.

**The rule is pinned in the database, not in prose.** `lap_telemetry` has
`PRIMARY KEY (session_id, driver_id, lap_number)` and
`CHECK (selection IN ('fastest'))`. Widening the scope in v1.8 therefore requires migration
0009 and a review; it cannot drift in a Python constant.

**What the rule makes impossible, named now so it is never quietly implied:**

1. **No tyre degradation from telemetry.** One lap per driver cannot show a lap-15 trace
   against a lap-35 trace. The existing `compound_degradation` fits keep that story, in lap
   times, where it belongs.
2. **No traffic or DRS-train analysis.** That needs consecutive race laps plus
   `DistanceToDriverAhead`, neither of which is stored.
3. **No in-lap / out-lap study, no pit-entry trace, no launch analysis.**
4. **No "how the lap evolved across the session."** One lap is the end of the story.
5. **No mini-sector model.** Corner numbers come from `get_circuit_info()`, nothing else.
6. **No per-lap *technique* skill, for any technique, ever, at n = 1.** Added v1.8. See the
   standing rule immediately below; it is the reason the v1.8 trail-braking work ships a
   reading and refuses a rating (§4.4).

### SR-5 — Replication is the limit (standing rule, v1.8 — **superseded 2026-09-18, see §1.1.1**)

> **SUPERSEDED. The rule below was v1.8's reading and it was wrong about which term binds.**
> Replication is *a* limit; it is not *the* limit. §1.1.1 shows the binding constraint is
> corner-specific execution scatter, which no amount of replication reduces, and which caps a
> one-lap technique metric at **0.32–0.47** against the 0.70 a rating needs. The v2.0 release
> that would have lifted the one-lap rule was costed in full and **deliberately not built**.
> Read §1.1.1 before proposing more laps as a route to a technique skill; it is not one.

The original v1.8 text, kept because the rest of this section's reasoning about the channel and
the sampling still stands:

> **`selection = 'fastest'` stores exactly one lap per driver per session. A per-lap technique
> metric therefore has exactly one draw of a quantity whose lap-to-lap SD is as large as its
> driver-to-driver SD. Any future technique *skill* — trail braking or anything else — requires
> storing 2–3 representative laps per driver per session first. That is a change to this file,
> named here as the pre-condition, and it is explicitly NOT proposed for v1.8.**

This is the rule that decides the v1.8 refusal, and it is worth being exact about *what*
binds. The binding constraint is **replication — not the channel and not the sampling.**

- It is **not the channel.** A real brake-pressure trace (which FastF1 does not expose; the
  live timing feed carries brake as a threshold flag) would add the taper, the peak, the
  release ramp and honest left-foot overlap. It would **not** fix the refusal, because a
  pressure channel on the same one stored lap has exactly the same n = 1 problem
  (`GAPFILL_SPEC §3.4`).
- It is **not the sampling.** §2.1's corrected in-zone step is single-digit metres. Resolution
  was never the thing standing between this corpus and a driver rating — see SR-1 in §4.3,
  which exists precisely to stop the next reader from concluding that it was.
- It **is** the one-lap rule, which is pinned in the database
  (`CHECK (selection IN ('fastest'))`, 0 duplicate `(session_id, driver_id)` pairs) and so
  cannot be widened by a Python constant. Widening it is a migration and a review — by design.

**The cost of lifting it, stated so a future release can price it rather than guess.** Storing
2–3 laps instead of 1 multiplies `lap_telemetry` rows and `lap_corner_speeds` rows by the same
factor (≈ 1,518 → 3,000–4,600 laps; ≈ 24,963 → 50,000–75,000 corner rows), needs no new
download (§3.5: `--force` re-reads the cache and makes zero API calls), and changes the primary
key story not at all — `lap_number` is already in it. What it does need is a **defensible
selection rule for laps 2 and 3**, which is the argument §1.1 avoided by choosing "fastest" in
the first place. That argument is the real work, and it is not v1.8's.

### 1.1.1 The price, paid — and the answer (2026-09-18)

§1.1 above asked a future release to *"price it rather than guess"*. It was priced, and the
answer is that **the storage was never the problem.**

Three independent architects and three judges (`docs/REPLICATION_SPEC.md`) designed the
selection rule for laps 2 and 3 using three different variance decompositions that disagree
with each other by up to 5x, and reached the same verdict unanimously. The diagnostic needs
only two numbers this project had already measured: the trail-braking repeat correlation is
**0.286 at one corner** and **0.412 for the driver-lap mean over ~15 corners**. Averaging
fifteen corners shrinks corner-specific scatter by k while leaving lap- and session-level
nuisance untouched — so noise concentrated at the lap or session level would have lifted that
figure far more than 0.286 → 0.412 did. It follows that the variance is **inside the corner**,
in the driver's own execution, and the corner-level ceiling for a single lap is **0.32–0.47**
against the 0.70 a rating requires. Storing three laps was predicted to reach **0.36–0.52**.

**No selection rule touches execution scatter.** Every rule considered — fastest-per-run,
same-segment, same-compound, tyre-age-windowed — attacks the smaller term.

> **Selecting on lap time stabilises lap time and nothing else.** The brake shape on the
> fastest lap of a run is a single free draw from that driver's distribution, identical in
> distribution to the draw on the fourth-fastest lap.

There is also a **trap in the obvious rule**, recorded so nobody walks into it: three laps from
the *same run* share fuel load, tyre age and track state. That shrinks the within-driver
variance, which is the denominator of the repeat correlation, and would report a metric as
roughly 50 % more repeatable than a claim about a driver can support. Within-run SD of push-lap
time is **0.298 s**; between-run is **0.445 s**.

**What replication would still buy, if a future release wants it for this reason alone:** every
existing corner metric becomes an average rather than a single draw, and SR-5 becomes a
measurement rather than an inference for *any* future technique metric. Cost: ~1,518 → 3,000–4,600
`lap_telemetry` rows, ~24,963 → 50,000–75,000 `lap_corner_speeds` rows, a migration widening
`CHECK (selection IN ('fastest'))`, and re-derivation of every pinned `TRAIL_*` constant. **Zero
API calls.** That is a legitimate reason to do it. It is not a route to the rating, and a release
that claims otherwise has not read this section.

## 1.2 T3 — the session set: 160 sessions, not 178

The database holds 178 sessions: 71 R, 18 S, 71 Q, 18 SQ. **Kind `S` has zero laps**
(verified by query), so a telemetry fetch for the 18 sprint sessions would cost ~36–72 API
calls and ~0.7 GB of cache and produce no rows at all. They are excluded.

**Session set = 71 R + 71 Q + 18 SQ = 160 lap-bearing sessions.**

Races are included even though qualifying is where a one-lap trace means most, because the
cost of a session's telemetry is the **download**, not the disk, and a v1.7 that greys the
telemetry tab out on every race page is a worse product than one that ships the track map
and channel stack for races and refuses only the comparison a race lap cannot support (T10,
§6.4). Race sessions get the map, the stack and the corner card — single-driver. They do not
get a cross-driver delta.

## 1.3 T1 — native samples, not a distance grid

The tempting alternative is a uniform distance grid so that two laps align by array index.
Measured on 2026 R13 Q, GAS's 1:21.786 (593 merged samples, median native spacing 8.98 m):

| grid | samples/lap | Speed round-trip RMS | Speed round-trip max | track-map max deviation |
|---|---|---|---|---|
| **native** | **593** | **0 (it is the data)** | **0** | **0** |
| uniform 5 m | 1176 | 1.41 km/h | 23.6 km/h | 1.28 m |
| uniform 10 m | 589 | 4.15 km/h | 64.4 km/h | 3.46 m |
| uniform 25 m | 236 | 4.64 km/h | 72.4 km/h | 6.76 m |

A 10 m grid is **the same size as native and strictly worse**. To beat native fidelity you
need 5 m, which is 2× the storage. Native 10 Hz sampling is already adaptive in the right
direction: ~2 m spacing at the slowest corner (71 km/h), ~9.5 m on the straight (342 km/h) —
dense where the picture is interesting.

**And the index-alignment property a grid appears to buy is an illusion on this data.**
A 10 m grid built on *absolute* distance produces arrays of 574–601 elements with **9
distinct lengths within a single session** (measured), so index `i` is not the same point on
the circuit for two drivers, and any `Math.min(a.n, b.n)` truncation silently drops the tail.
Alignment is a rendering concern, solved at render time on chord distance (§5.2), not a
storage one.

## 1.4 T5's motivation — FastF1 `Distance` cannot align two laps

`Distance` is speed integrated over time and it accumulates that integration's error.
Measured across the fastest laps of 2026 R13 Q — laps of *the same circuit*:

| driver | lap | FastF1 `Distance` total | chord length from (X, Y) |
|---|---|---|---|
| GAS | 1:21.786 | **5872.6 m** | 5760.4 m |
| RUS | 1:21.846 | 5761.7 m | 5751.9 m |
| ANT | 1:21.882 | 5761.1 m | 5756.4 m |
| PIA | 1:21.966 | 5762.6 m | 5751.6 m |
| LEC | 1:22.004 | 5771.3 m | 5756.6 m |
| NOR | 1:22.067 | 5757.9 m | 5764.3 m |
| | **spread** | **114.7 m (2.0%)** | **12.7 m (0.22%)** |

Independently re-measured over the 8 fastest laps of the same session: `Distance` spread
**141.0 m (2.45%)**, chord spread **9.5 m (0.17%)** — chord is **15× better**.

Consequences, measured:

- A delta drawn on raw `Distance` is wrong by **1378–1398 ms** at the flag on pairs
  involving GAS, against true gaps of **60–180 ms**.
- Normalising each lap to its own length (`RelativeDistance`, 0→1) forces the endpoint to
  close **exactly** — and smears the error through the interior instead: checked against the
  drivers' own sector times, the normalised delta is wrong by **+481, −496, +446, −570,
  +453, −573 ms** at sector boundaries. An endpoint check cannot detect this by construction.
- Chord alignment closes to **4–109 ms** at the flag and matches the drivers' own sector
  times to **8, 37, 72, 81, 98, 8 ms**. That is the honest resolution of this chart, and §6
  prints it.

**Therefore T5: `distance_m` is cumulative chord length of (X, Y), computed at ingest, and
there is no integrated-distance column in the schema for anyone to reach for.**

Chord length is not free of bias and §6.2 says so: it under-reads true arc length where
curvature is high and sample spacing is wide — i.e. in slow corners — and (X, Y) carries its
own position noise. The residual is measured (8–98 ms) and captioned; it is not claimed away.

## 1.5 Measured sizes

Measured in this project's own Postgres 16 container with `pg_total_relation_size` on
scratch tables built from 22 real 2026 Monza Q laps replicated to 5,324 laps (3,332,582
samples), then dropped:

| layout | total | per lap | per sample |
|---|---|---|---|
| row-per-sample, narrowed types (`real`/`smallint`/`bool`/`int`) + one index | **315 MB** (244 heap + 71 index) | 62,066 B | 94.5 B |
| **array-per-lap, native samples, 10 channels** | **89 MB** (4.6 heap + 85 TOAST) | **17,569 B** | 28.1 B |
| array-per-lap, 10 m distance grid | 77 MB | 15,102 B | — |

**Like-for-like ratio: 3.5×.** (Not 9×, not 2.8× — both of those pairings were
apples-to-oranges.) One-lap read: arrays **0.060 ms / 3 buffers** vs rows **0.254 ms / 12
buffers**; both trivial, arrays 4× faster.

At the shipped scope — **160 sessions × ~20 drivers ≈ 3,200 laps**, 9 channels:

| table | rows | size |
|---|---|---|
| `lap_telemetry` | ~3,200 | **~50 MB** (≈16 KB/lap after T9 rounding) |
| `lap_telemetry_summary` | ~3,200 | ~0.4 MB |
| `lap_corner_speeds` | ~48,000 | ~5 MB |
| `circuit_corners` | ~600 | <0.1 MB |
| `circuit_layout` | ~35 | <0.1 MB |
| | **database 127 MB →** | **~183 MB** |

The row-per-sample equivalent would be ~199 MB for `lap_telemetry` alone, landing the
database near 330 MB. **Choosing arrays is what makes "all 160 lap-bearing sessions" cost
less than "qualifying only" would have cost as rows**, which is why storage stops being the
binding constraint and §3's rate limit becomes the only real one.

**The number that is not in that table:** the FastF1 cache grows from 757 MB to roughly
**10–12 GB** (§3.2). It is 25–150× the database growth and it lives outside the database.

---

# §2 Schema

## 2.1 The five tables

Written in `web/db/schema/telemetry.ts` (Drizzle), from which migration 0008 is **generated**
(§2.5). The SQL below is the normative shape; the TS module must produce exactly it.

```sql
-- ── 1. Circuit geometry, from session.get_circuit_info().
--       Per circuit-year: a layout can change between seasons and events are keyed by year.
CREATE TABLE circuit_layout (
  circuit_key      integer NOT NULL REFERENCES circuits(circuit_key),
  year             integer NOT NULL,
  rotation_deg     real    NOT NULL,   -- measured 95.0 for 2026 R13; applied in the browser
  n_corners        integer NOT NULL,
  track_length_m   real    NOT NULL,   -- chord length of the reference lap
  ref_session_id   integer NOT NULL REFERENCES sessions(session_id),
  PRIMARY KEY (circuit_key, year)
);

CREATE TABLE circuit_corners (
  circuit_key      integer NOT NULL,
  year             integer NOT NULL,
  corner_number    integer NOT NULL,
  corner_letter    text    NOT NULL DEFAULT '',  -- '' | 'A' | 'B'  — NOT NULL: it is in the PK
  x                real    NOT NULL,   -- FastF1 position units, raw and unrotated
  y                real    NOT NULL,
  angle_deg        real,
  distance_m       real    NOT NULL,   -- CHORD distance along the reference lap (§2.1 note)
  PRIMARY KEY (circuit_key, year, corner_number, corner_letter),
  FOREIGN KEY (circuit_key, year) REFERENCES circuit_layout ON DELETE CASCADE
);

-- ── 2. The channel arrays. One row per stored lap. Never read column-wise, never partially.
CREATE TABLE lap_telemetry (
  session_id       integer NOT NULL,
  driver_id        text    NOT NULL,
  lap_number       integer NOT NULL,
  selection        text    NOT NULL DEFAULT 'fastest',
  n_samples        integer NOT NULL,
  n_car_samples    integer NOT NULL,
  n_pos_samples    integer NOT NULL,
  max_sample_gap_m real    NOT NULL,   -- v1.7 said "worst case 73.7–85.7 m"; CORRECTED v1.8,
                                       -- see "Sampling figures, corrected" below. §5.2 shades it
  track_length_m   real    NOT NULL,   -- = distance_m[n_samples]
  source_hash      text    NOT NULL,   -- §3.5 idempotency key
  distance_m       real[]     NOT NULL,  -- CHORD, monotone non-decreasing, [1] = 0
  time_s           real[]     NOT NULL,  -- seconds from the lap's first sample, [1] = 0
  x                real[]     NOT NULL,
  y                real[]     NOT NULL,
  speed_kph        smallint[] NOT NULL,
  throttle_pct     smallint[] NOT NULL,  -- 0..104 as delivered; NOT clamped (§6.5)
  brake            boolean[]  NOT NULL,
  gear             smallint[] NOT NULL,  -- 1..8; 0 appears and means "no reading"
  drs              smallint[] NOT NULL,  -- raw DRS code, NOT a boolean (§6.5)
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  derive_version   integer NOT NULL DEFAULT 1,  -- v1.8, migration 0010. §3.5: source_hash covers
                                       -- the RAW channels only; every derived column set is
                                       -- gated by this as well. Currently TRAIL_DERIVE_VERSION = 2.
  PRIMARY KEY (session_id, driver_id, lap_number),
  FOREIGN KEY (session_id, driver_id, lap_number)
    REFERENCES laps (session_id, driver_id, lap_number) ON DELETE CASCADE,
  CONSTRAINT lap_telemetry_selection_check CHECK (selection IN ('fastest')),
  CONSTRAINT lap_telemetry_samples_check   CHECK (n_samples BETWEEN 50 AND 5000),
  CONSTRAINT lap_telemetry_lengths_check CHECK (
    array_length(distance_m,1)    = n_samples AND array_length(time_s,1) = n_samples AND
    array_length(x,1)             = n_samples AND array_length(y,1)      = n_samples AND
    array_length(speed_kph,1)     = n_samples AND array_length(brake,1)  = n_samples AND
    array_length(throttle_pct,1)  = n_samples AND array_length(gear,1)   = n_samples AND
    array_length(drs,1)           = n_samples)
);
CREATE INDEX lap_telemetry_session_idx ON lap_telemetry (session_id);
```

`lap_telemetry_lengths_check` is the most valuable line in this file: it is the constraint the
row-per-sample layout **cannot express at all**, and it makes a ragged lap — the failure that
produces a misaligned trace and a fan drawing a false conclusion — unrepresentable. Note its
limit, stated so nobody over-trusts it: it is a **per-row** cardinality check. It cannot see a
*cross-lap* length mismatch, and it does not need to, because §5.2 never compares by index.

`circuit_corners.distance_m` is **not** FastF1's corner `Distance` (that lives in the
discredited integrated space, §1.4). It is the corner's (X, Y) projected onto the reference
lap's path and read off in chord distance, so corner marks and traces share one coordinate
system.

```sql
-- ── 3. Derived scalars, computed once at ingest (§4). The ONLY telemetry the ask box sees.
CREATE TABLE lap_telemetry_summary (
  session_id        integer NOT NULL,
  driver_id         text    NOT NULL,
  lap_number        integer NOT NULL,
  top_speed_kph     smallint NOT NULL,
  min_speed_kph     smallint NOT NULL,
  full_throttle_pct real    NOT NULL,  -- % of lap DISTANCE (§0.3)
  brake_pct         real    NOT NULL,
  lift_pct          real    NOT NULL,  -- measured, NOT 100 − the other two (§4.1)
  overlap_pct       real    NOT NULL,  -- distance reporting full throttle AND brake at once
  n_brake_zones     integer NOT NULL,
  n_gear_changes    integer NOT NULL,
  drs_distance_m    real,              -- NULL when the DRS channel was flat (§6.5). Never 0.
  track_length_m    real    NOT NULL,
  s1_distance_m     real,              -- chord distance at the driver's own S1 time
  s2_distance_m     real,
  n_samples         integer NOT NULL,
  max_sample_gap_m  real    NOT NULL,
  n_gaps_over_50m   integer NOT NULL,
  PRIMARY KEY (session_id, driver_id, lap_number),
  FOREIGN KEY (session_id, driver_id, lap_number) REFERENCES lap_telemetry ON DELETE CASCADE
);

CREATE TABLE lap_corner_speeds (
  session_id        integer NOT NULL,
  driver_id         text    NOT NULL,
  lap_number        integer NOT NULL,
  corner_number     integer NOT NULL,
  corner_letter     text    NOT NULL DEFAULT '',
  apex_speed_kph    smallint NOT NULL,
  apex_distance_m   real    NOT NULL,
  entry_speed_kph   smallint NOT NULL,
  exit_speed_kph    smallint NOT NULL,
  brake_zone_idx    integer,            -- which brake application serves this corner (§4.2)
  brake_point_m     real,               -- NULL when the corner is taken flat
  brake_distance_m  real,
  throttle_point_m  real,
  time_in_corner_s  real    NOT NULL,
  -- ── v1.8, migration 0010. The release metre and its refusal audit (§4.2, §4.4).
  -- Physically APPENDED (ordinals 15–19), not inserted after brake_distance_m: ADD COLUMN
  -- appends, and a mid-table insert is a full table rewrite, which D7's no-silent-change rule
  -- forbids. frames.TABLE_COLUMNS lists them in this same true physical order.
  brake_release_m         real,        -- chord distance of the serving zone's trailing edge
  brake_release_to_apex_m real,        -- apex_distance_m − brake_release_m; may be negative
  brake_on_distance_m     real,        -- brake_release_m − brake_point_m
  trail_duty              real,        -- UNRENDERED DIAGNOSTIC (§4.4). Never on a page, never
                                       -- in the ask view. Exempt from the release CHECK below.
  trail_status            text    NOT NULL DEFAULT 'measured',  -- the reason a cell is blank
  PRIMARY KEY (session_id, driver_id, lap_number, corner_number, corner_letter),
  FOREIGN KEY (session_id, driver_id, lap_number) REFERENCES lap_telemetry ON DELETE CASCADE,
  -- v1.8. Six words, and a blank cell must be able to say which one happened.
  CONSTRAINT lap_corner_speeds_trail_status_check CHECK (
    trail_status IN ('measured','taken_flat','shared_zone_non_terminal',
                     'too_few_samples','release_step_too_wide','implied_decel_impossible')),
  -- the three release numbers are NULL together, always: one CHECK, not three chances to disagree
  CONSTRAINT lap_corner_speeds_trail_check CHECK (
    (trail_status <> 'measured'
       AND brake_release_m IS NULL AND brake_release_to_apex_m IS NULL
       AND brake_on_distance_m IS NULL)
    OR (trail_status = 'measured'
       AND brake_release_m IS NOT NULL AND brake_release_to_apex_m IS NOT NULL
       AND brake_on_distance_m IS NOT NULL AND brake_point_m IS NOT NULL))
);
CREATE INDEX lap_corner_speeds_corner_idx ON lap_corner_speeds (session_id, corner_number);
```

### SR-6 — Sampling figures, corrected (standing rule, v1.8)

> **The v1.7 figures above and the v1.8 gap brief's "~74 m" are both wrong. Lap-wide
> `max_sample_gap_m` is 54.78 m median, 89.72 m p95, 192.69 m worst; mean step 8.04 m. The
> lap-wide gap was UNDERSTATED at the tail and the in-zone step was OVERSTATED as tight.**

`GAPFILL_SPEC` DL-25 is the source. Re-measured live over all **1,518** stored laps while
writing this amendment, and both readings are given because they differ and neither is being
adjusted to agree with the other:

| quantity | DL-25 / §4.5 | re-measured here (n = 1,518) | note |
|---|---|---|---|
| lap-wide `max_sample_gap_m` median | 54.78 m | **54.80 m** | agrees |
| lap-wide `max_sample_gap_m` p95 | 89.72 m | **89.38 m** (linear) | agrees *to the percentile convention*: 89.72 m is the same sample's nearest-rank-above value, 89.38 m its linear interpolation. Not a disagreement about the data. |
| lap-wide `max_sample_gap_m` worst | 192.69 m | **192.69 m** | exact |
| mean step | 8.04 m | **8.07 m** | agrees |
| in-zone step median | 4.94 m | **5.06 m** | agrees to 0.12 m |
| **in-zone step p95** | **8.33 m** | **15.37 m** | **DISAGREES, 1.85×, and it is not a convention artefact.** Recorded both ways, neither adjusted. |

The in-zone re-measurement is over **154,920** consecutive sample steps whose two endpoints
both carry `brake = true`, across every stored lap. The median reproduces; the **p95 does not,
and it fails in the direction that matters** — the tail of in-zone sampling is roughly twice as
coarse as §4.5 states. Anyone tightening a gate on the strength of "in-zone sampling is 8 m at
the p95" is tightening it on a figure this corpus does not support. The gate that actually
depends on this — `TRAIL_MAX_RELEASE_STEP_M = 25.0` — was re-derived in WP-B1 against the
**release-edge bracketing step**, which is a different and better-behaved quantity, and it
survives; see §4.2.

**The release-edge bracketing step is also reported both ways.** DL-15 pins 3.89 m median /
12.21 m p95 (n = 739, four sessions). WP-B1 re-derived it over all **20,330** braked corner
rows and measured **4.13 m median / 10.47 m p90 / 13.34 m p95 / 69.18 m max**, and over the
604 unique release edges of DL-15's own four sessions measured **4.20 / 12.48**. The shipped
constants in `f1lab/telemetry.py` carry the whole-corpus figures. **A fan-facing caption must
use 4.13 / 13.34, not 3.89 / 12.21** — that is what ships.

## 2.2 T4 — rows vs arrays, argued with the measurements

**Decision: one row per stored lap, nine channel arrays.**

**Size.** 3.5× measured, like-for-like, at full-corpus scale (§1.5). The saving is not
compression: it is ~3,200 tuple headers instead of ~2,000,000, the absence of a `sample_idx`
column, and the absence of a 71 MB composite index. At the shipped scope that is **50 MB
against 199 MB**, and it is the difference between "all 160 lap-bearing sessions" and
"qualifying only".

**Read pattern.** Every read of this data is a whole lap. There is no second access pattern.

| the query the app actually issues | rows | arrays |
|---|---|---|
| draw the track map for one lap | index scan + 626 heap tuples, sorted, reassembled in TS | **one PK lookup, 0.060 ms** |
| draw the delta + stack for two laps | 1,252 tuples, two sorts, two groupings | **two PK lookups** |
| the 20 laps of a session, for the picker | 12,520 tuples across the heap | **20 tuples** |
| a partial-lap read | possible, and never wanted | not possible |
| `max(speed)` over samples | idiomatic SQL | needs `unnest` — **so it is precomputed instead** (§4) |

Two properties the row form cannot provide:

1. **Ordering is a property of the datum.** A sample sequence out of order is meaningless. In
   the row form the order is an `ORDER BY sample_idx` every consumer must remember for ever,
   including any SQL a model writes. In the array form it is structural.
2. **Atomicity.** A lap is either stored or not. With 626 rows per lap a half-written lap is
   representable, and eventually happens.

**The row form's one real advantage — `SELECT max(speed) … GROUP BY lap` is idiomatic SQL —
is bought outright by §4**, which precomputes every scalar a fan or a model would aggregate
for, and precomputes it *better*: "top speed" here honestly means "top speed on the stored
lap", a caveat a raw `max()` silently drops.

**And the ask box's cost guard cannot see an array unnest.** Measured, and reproduced twice
independently:

```
EXPLAIN SELECT max(s) FROM lap_telemetry, unnest(speed_kph) s;
  -> Function Scan on unnest s  (cost=0.00..0.10 rows=10)
  estimated 53,240 rows   actual 3,332,582 rows   (62.6× under)   total cost 1,827
  the row-form equivalent over the same data is priced at 49,542
```

`MAX_PLAN_COST` and `MAX_PLAN_ROWS` in `web/lib/ask/limits.ts` read straight off that plan.
An array query reading 2.2M samples sails past a 5,000,000 guard while reporting a cost of
~1,800. **That is a measured hole in an existing safety boundary, not a matter of taste**, and
it is the stated reason `lap_telemetry` is excluded from the ask box (§2.6) rather than
exposed with a warning. It is recorded in the manifest so a future release cannot re-litigate
it from preference.

## 2.3 T9 — round before COPY

Measured: `pg_column_size` on a **rounded** 593-element `real[]` speed array is **1,788 B**
against **2,392 B** uncompressed — pglz compresses it **25%**. The same array unrounded does
not compress at all (2,488 B = 617×4+20, the uncompressed signature). **Rounding the values
is the compression lever, not the column type.** Before COPY:

| channel | rounding |
|---|---|
| `distance_m` | 2 dp (cm) |
| `time_s` | 3 dp (ms) |
| `x`, `y` | 0 dp (FastF1 units are already tenths of a metre) |
| `speed_kph`, `throttle_pct`, `gear`, `drs` | integer (`smallint[]`, already discrete) |

This is worth ~25% of the float channels for one `np.round` per array and costs no fidelity
the visuals can resolve (§1.3's own round-trip table is 1000× coarser than these steps).
Do **not** switch the table's compression method; the lever is the data, not the codec.

## 2.4 `frames.TABLE_COLUMNS`, `EXPECTED_COLUMNS`, and the one real hazard

`EXPECTED_COLUMNS` derives from `TABLE_COLUMNS` (`frames.py:487`), so five new entries in DDL
column order give `db.assert_schema` full coverage with no further edit. Three **new type
tags** are required — `farray`, `iarray`, `barray`:

```python
"lap_telemetry": [("session_id","int"), ("driver_id","text"), ("lap_number","int"),
                  ("selection","text"), ("n_samples","int"), ("n_car_samples","int"),
                  ("n_pos_samples","int"), ("max_sample_gap_m","float"),
                  ("track_length_m","float"), ("source_hash","text"),
                  ("distance_m","farray"), ("time_s","farray"),
                  ("x","farray"), ("y","farray"),
                  ("speed_kph","iarray"), ("throttle_pct","iarray"),
                  ("brake","barray"), ("gear","iarray"), ("drs","iarray")],
```

**v1.8 amendment.** The live lists are longer and `EXPECTED_COLUMNS` must match the **true
physical order**, which for an added column is *appended*, not inserted where §2.1's prose reads
best. As shipped: `lap_telemetry` **20 → 21** entries (`ingested_at` is present in the live DDL
and `derive_version` follows it); `lap_corner_speeds` **14 → 19**, appending
`brake_release_m`, `brake_release_to_apex_m`, `brake_on_distance_m`, `trail_duty`,
`trail_status` at ordinals 15–19. **All five must be listed, including `trail_duty`** —
`db.schema_problems()` compares `EXPECTED_COLUMNS` against `information_schema` and would report
an unlisted live column as *unexpected*, failing `--check-schema` and the ask regeneration. The
`trail_duty` restriction is enforced in the **ask view**, which is the layer that faces the
model; listing a column in `frames` is only what lets `COPY` write it. The two layers are
independent and `GAPFILL_SPEC §2.4`'s "three new `lap_corner_speeds` columns" is the
ask-exposure count, not the `frames` count.

**The hazard.** `frames.cast_frame` falls through to `astype(object)` for an unknown kind, and
`frames._py()` has **no `ndarray` branch** — it converts numpy *scalars* only. A
`numpy.ndarray` cell therefore reaches psycopg as an unadaptable type and dies **deep inside
`db.copy_frame`, after the download**, not at the schema boundary. The three array casters
must call `.tolist()` and sweep elements through `_py()`; psycopg adapts `list[float] →
real[]`, `list[int] → smallint[]`, `list[bool] → boolean[]` natively. **WP-2's gate is the
assertion `type(cell) is list and type(cell[0]) is float`** — this is the single
highest-risk line of plumbing in the release (§8 R1).

## 2.5 Migration 0008, and the mechanism

**`make migrate` runs Drizzle from `web/`** against `web/drizzle/` + `meta/_journal.json`.
`scripts/sql/` is a **separate chain** applied by `make db-ask-views` / `make db-ask-roles`
and is not part of `make migrate`. The five tables are core schema, so they go through
Drizzle:

1. `web/db/schema/telemetry.ts` — new module, the five tables.
2. `web/db/schema/index.ts` — **`export * from "./telemetry";`**. Without this line
   `drizzle-kit` does not see the module and generates nothing.
3. `cd web && npx drizzle-kit generate` → **`web/drizzle/0008_telemetry.sql`**,
   `web/drizzle/meta/0008_snapshot.json`, and journal entry **8**.

**It is 0008, not 0007.** `web/drizzle/0007_quali_verified.sql` already exists and is journal
entry 7. Hand-writing the SQL without the snapshot would make the next `drizzle-kit generate`
try to create these tables a second time.

The migration is **additive only**: five `CREATE TABLE`, three indexes, **no `ALTER` on any
existing table**, no change to any existing row. No new column on `session_ingests` — the
telemetry state lives in the existing `analytics_status jsonb NOT NULL` (§3.6), which is
precisely why nothing has to be altered. It is safe to apply to the live database ahead of
any ingest, and the app renders as it does today until the first telemetry row lands.

**Rollback:** `DROP TABLE lap_corner_speeds, lap_telemetry_summary, lap_telemetry,
circuit_corners, circuit_layout CASCADE;`, revert the three `ask` views and the manifest,
remove the `index.ts` export line and the journal entry. No existing table is touched, so
rollback loses only telemetry — and because the FastF1 cache is never pruned (§3.5), a
re-ingest afterwards costs **zero API calls**.

## 2.6 T6 — how Mode 3's ask box sees it

`scripts/gen_ask_schema.py::partition_tables()` raises `SystemExit` on **any live base table
that is neither included nor excluded**. That gate already exists and it is what stops this
release from drifting: all five new tables must be classified before the generator will run.

**Excluded (GRANT level, never queryable):**

```yaml
exclude_tables:
  lap_telemetry: >-
    10 Hz channel arrays, ~626 values per column per row. The planner prices unnest() at
    10 rows: a query over these reads 2.2M samples while reporting a total cost of ~1,800,
    so MAX_PLAN_COST and MAX_PLAN_ROWS cannot see it (measured: 53,240 estimated against
    3,332,582 actual, 62.6x under). A single SELECT of one array column also blows the
    response byte cap. The answerable half is ask.lap_telemetry_summary and
    ask.corner_speeds, which are honest scalar rows.
  circuit_layout: >-
    Rendering geometry (rotation, reference session). Answers no question a fan asks.
```

**Three new `ask` views** (`scripts/sql/` chain, applied by `make db-ask-views`):

```sql
CREATE VIEW ask.lap_telemetry_summary AS   -- ~3,200 rows, one per stored lap
  SELECT session_id, driver_id, lap_number, top_speed_kph, min_speed_kph,
         full_throttle_pct, brake_pct, lift_pct, overlap_pct, n_brake_zones,
         n_gear_changes, drs_distance_m, track_length_m, n_samples, max_sample_gap_m
  FROM public.lap_telemetry_summary;

CREATE VIEW ask.corner_speeds AS           -- ~48,000 rows, one per lap per corner
  SELECT session_id, driver_id, lap_number, corner_number, corner_letter,
         apex_speed_kph, apex_distance_m, entry_speed_kph, exit_speed_kph,
         brake_zone_idx, brake_point_m, brake_distance_m, throttle_point_m, time_in_corner_s
  FROM public.lap_corner_speeds;

CREATE VIEW ask.circuit_corners AS         -- ~600 rows
  SELECT circuit_key, year, corner_number, corner_letter, distance_m, angle_deg
  FROM public.circuit_corners;
```

**`conventions:` gains two trap lines**, in the voice of the four already there:

> `ask.lap_telemetry_summary` holds ONE lap per driver per session — that driver's fastest —
> and no other lap. Never aggregate it into a season "average top speed"; it is twenty-odd
> single laps at twenty-odd circuits. A question about how a trace changed over a stint, a
> race or a season cannot be answered from these tables: say so instead of answering from
> the single stored lap.

> `drs_distance_m` is NULL when the DRS channel was flat for that lap. NULL means the signal
> was not recorded, not that the driver never opened DRS. Never coalesce it to 0.

**The pinned counts move in three places at once** (all three are real; `check-invariants.mjs`
is the import-boundary linter and holds **no** object count):

| file | constant | 61-era | 0008-era |
|---|---|---|---|
| `tests/test_ask_schema_sync.py:42` | `N_OBJECTS` | 61 | **64** |
| `tests/test_ask_schema_sync.py` | `N_TABLE_VIEWS` | 57 | **60** |
| `web/lib/ask/validate.test.ts:295` | `ASK_OBJECTS.size` | 61 | **64** |

`DOC_TARGET_CHARS` (45,000, ±20%) absorbs three signatures and two prose lines without moving.

**`ask_answer_cache` is invalidated on the 0008 deploy** (QUALI_SPEC §5.3.3 precedent): the
generated schema doc is part of the cached prompt prefix, and every cached answer predates
the two convention lines above.

## 2.7 The guarantee: a database without telemetry serves every existing page

Nothing in migrations 0000–0007 references any new table. No existing view, query or page
joins them. `lap_telemetry` empty is a legal database and the v1.6 app.

**This is asserted, not assumed.** `tests/test_telemetry_optional.py` (WP-7) runs the existing
page-query smoke set against a session ingested with the telemetry pass never run, and asserts
every query returns what it returns today.

**The one existing test that breaks the afternoon the schema lands** is
`tests/test_ingest_hungary.py::test_every_table_populated`. It derives `PER_SESSION_TABLES`
dynamically from `frames.EXPECTED_COLUMNS` (line 13 — any table carrying `session_id`) and
asserts `count > 0` for each. Three of the new tables land in that list automatically. They go
into that file's `DATA_DEPENDENT_TABLES` set with the reason written beside the existing
`wp_swing` and `race_report` precedents, and are then asserted **explicitly and separately**
(`>= 15` rows after a telemetry pass, `== 0` without one). **WP-7 owns that edit and it is the
only change to an existing test file in the release.**

## 2.8 `db.py` and `frames.py` plumbing

- **`db.SESSION_CHILD_TABLES`** (`f1lab/db.py:24-40`, a hand-maintained ordered list) gains
  the three session-keyed tables **before `"laps"`** — children first, and before
  `session_entries`:
  ```python
  "lap_corner_speeds", "lap_telemetry_summary", "lap_telemetry",   # v1.7 §2.8
  "laps", "track_status_events",
  ```
  `circuit_layout` / `circuit_corners` are **not** session-scoped and are **not** in this
  list; they are rebuilt per `(circuit_key, year)` by the telemetry pass.
- **`frames.RACE_TABLE_ORDER` and `QUALI_TABLE_ORDER`** — the telemetry tables are written by
  `f1lab/telemetry.py`, not by `build_race_frames` / `build_quali_frames`, so they are
  **deliberately absent from both lists**. This is stated here because the omission is
  otherwise indistinguishable from the bug: `build_race_frames` does
  `ordered = {t: tables[t] for t in RACE_TABLE_ORDER}` (`frames.py:1269`, `:1701`), so a
  table absent from the list is silently never written. Here that is the intent.
  `SPRINT_TABLE_ORDER` is untouched, which gives kind `S` its "no telemetry" guarantee free.
- **The `--force` interaction, which is the release's sharpest edge.** `lap_telemetry` is in
  `SESSION_CHILD_TABLES` and carries `ON DELETE CASCADE` from `laps`, so **`ingest --force`
  wipes that session's telemetry** — correctly, because the lap identities it is keyed to are
  being rebuilt. Left there, that is a silent data loss with no code path that rewrites it.
  The fix is three lines in `f1lab/ingest.py`, at the end of `write_session`, inside the same
  transaction and inside a `try/except` that can never raise:
  ```python
  # v1.7 §2.8 — a --force rebuild dropped this session's telemetry. Re-derive it from the
  # cache at zero API calls if the artifacts are on disk; otherwise record that it is gone.
  telemetry.rewrite_after_force(conn, session_id, status)
  ```
  If the cache artifacts are present it re-derives and rewrites (zero network). If they are
  not, it writes `analytics_status['telemetry'] = {"state": "dropped", …}`, the telemetry tab
  falls to its empty state (§5.6), and `python -m f1lab.telemetry` restores it. **This is the
  entire diff to `ingest.py`** and `tests/test_force_keeps_telemetry.py` pins it.

---

# §3 Ingest and the warm plan

## 3.1 T7 — telemetry is a second pass

`ingest.write_session` computes `status = 'ok' if all analytics are ok` and writes everything
in one transaction. If telemetry joined that computation, **a FastF1 position-data outage or
a disk-full warm would flip 160 correct sessions from `ok` to `partial`**, and every
`ask.session_health` and `ask.data_coverage` answer with them — a data-quality signal about
lap times corrupted by an unrelated network failure. That is not acceptable for an optional
layer added on top of a complete, verified corpus. Therefore:

> **New entry point `python -m f1lab.telemetry` (`f1lab/telemetry.py`), writing only the five
> new tables.** `f1lab/clean.py`'s `load_race` / `load_quali` keep `telemetry=False`
> unchanged, pinned by `tests/test_clean_no_telemetry.py` for ever. A new
> `clean.load_telemetry(year, gp, kind)` is added beside them. `f1lab/ingest.py` changes by
> exactly the three lines in §2.8.

## 3.2 The measured download cost — and the number that matters

Measured directly on the cache directory:

| | without telemetry | with telemetry |
|---|---|---|
| cache artifacts per session | 8 | **10** (`car_data.ff1pkl`, `position_data.ff1pkl`) |
| cache size, one Q session | 1.2–2 MB | **39–58 MB** |
| cache size, one R session | 1.2–2 MB | **86–116 MB** |
| new API requests | — | **2 measured** (budget **4**: a stream may be fetched multi-part) |
| `session.load(telemetry=True)` | — | **5.0–5.2 s**, plus ~0.43 s per `get_telemetry()` |

The 2026-09-13 weekend proves the disk figure cleanly: Qualifying (telemetry) **58 MB**, Race
(no telemetry) **1.2 MB**, same weekend, both ingested.

- **Calls:** 160 × 2 = **320** measured, **640** at the conservative budget of 4. The ceiling
  is 500/hour. A single unpaced pass is *probably* fine and *might* burn the hour's budget on
  request 251 of a re-run — which is exactly the situation that has cost this project time.
- **Disk: 89 Q/SQ × ~45 MB + 71 R × ~100 MB ≈ 11 GB.** `cache/` is 757 MB today. **This is
  the largest number in the release and it lives outside the database**, at 25–150× the
  database growth. It belongs in `docs/RUNBOOK.md` **as a precondition before the warm step,
  not as a discovery during it.**
- **Wall clock:** ~5 s of parse per session plus 45–100 MB of transfer; at a realistic
  20 MB/s, 40–60 minutes of actual work. The rate limiter, not the work, sets the clock.

**Free-space precondition.** `warm_telemetry.py` **refuses to start below 15 GB free** on the
cache volume and prints the shortfall. This is not caution for its own sake: a warm that runs
out of disk halfway leaves **truncated `.ff1pkl` files that FastF1 reads back as corrupt**,
and finding that is a wasted day. The scope ladder for a constrained machine is
`--kinds Q SQ` alone: ~89 sessions, ~5 GB, and the headline feature still ships whole.

## 3.3 The warm plan — `scripts/warm_telemetry.py`

A **new script**, not a flag on `warm_cache.py`. `warm_cache.py` is the thing that must keep
working when telemetry is broken, and it owns `telemetry=False` as a guarantee.
`scripts/warm_resume.sh` is **not** used for telemetry: its loop greps for a rate-limit error,
sleeps an hour and re-runs, and **an hour of silence is how agents die on this project**.

```
.venv/bin/python scripts/warm_telemetry.py --seasons 2024 2025 2026 \
    --kinds Q SQ R --calls-per-hour 300 --budget 260 [--resume]
```

1. **Order: Q, then SQ, then R, newest season first.** If the run is interrupted after an
   hour, the half that is done is the half where a one-lap trace means most: the app ships
   with qualifying telemetry complete and races on their empty state, which is a coherent
   product, not a broken one. Ingest's `{R:0,S:1,Q:2,SQ:3}` rank is deliberately **not**
   reused here.
2. **Token bucket, default 300 calls/hour** — 40% under the ceiling — charging the
   conservative **4** per session load. A session whose two artifacts are already on disk is
   charged **0** and skipped in milliseconds.
3. **It refuses to *start*** if its own call log (`cache/.telemetry_calls.jsonl`, appended per
   charge) shows **more than 450 calls in the trailing hour**. It then **prints the UTC time
   at which it may proceed and exits 0**. It does **not** sleep. A long silent sleep is a
   worse failure than an early exit, in this harness and in general.
4. **`--budget N` stops cleanly after N charged calls** and prints the exact resume command.
   The intended operation is **three sittings of ~55 sessions**, not one three-hour run.
5. **Idempotency is checked against the filesystem** — the only source of truth that survives
   a killed process. `car_data.ff1pkl` and `position_data.ff1pkl` exist, are non-zero, and
   unpickle → charge 0 and skip. A **truncated artifact is deleted and refetched**; FastF1
   writes the pickle only on success, so the common case is a missing file, not a corrupt one,
   and §3.2's disk-full scenario is the case that produces the other one.
6. **The warmer never raises.** A failed session is logged and the loop continues. Its exit
   line is `warmed=N skipped=M failed=K calls=C`, and `--resume` re-attempts only the K.

**A re-run costs the price of what is missing, never of what is already done.**

## 3.4 The write pass

`f1lab/telemetry.py` never touches the network when the cache is warm: it enables the cache
and calls `load(telemetry=True, weather=False, messages=False)`, which reads the two pickles.
Per session:

1. **Read `laps` from Postgres, not from FastF1**, to pick the fastest lap per driver under
   §1.1 — so the stored trace is the trace of a lap the app has already cleaned, classified
   and published, and the two can never disagree.
2. `lap.get_telemetry()` per selected driver. Drop rows with NULL `X`/`Y`. Compute
   **chord distance** (T5) as `cumsum(hypot(diff(x), diff(y)))` with a leading 0, assert it is
   monotone non-decreasing, and truncate a non-monotone tail with a recorded warning.
3. Build the nine arrays, **round them** (T9), and assert every length equals `n_samples`.
4. Write `circuit_layout` / `circuit_corners` from `get_circuit_info()` **once per
   `(circuit_key, year)`**, with `ref_session_id` recording which session produced them and
   corner `distance_m` projected into chord space (§2.1).
5. Compute §4 and write all five tables in **one transaction per session**.

A per-driver failure never aborts the session: each driver is wrapped in the existing
`frames._guard` pattern, the message lands in `session_ingests.warnings`, and the session
lands `partial` **in `analytics_status['telemetry']` only** (§3.6). **A driver is never stored
with fewer than 50 samples** — the `lap_telemetry_samples_check` floor — because a 12-sample
"lap" would draw a triangle and call it a circuit.

## 3.5 Idempotency and `--force`

`source_hash` = SHA-256 over `(fastf1_version, lap_number, n_samples, first and last
`time_s`, and a checksum of each rounded channel array)`.

- **Default run:** a `(session_id, driver_id, lap_number)` whose stored `source_hash` matches
  is skipped without a write. Re-running the telemetry pass over an already-telemetried
  session is a no-op costing one indexed `SELECT`.
- **`--force`:** re-derive, then `DELETE FROM lap_telemetry WHERE session_id = %s` (cascading
  to the two derived tables) and re-`COPY`, **inside that session's own transaction**. Not
  `TRUNCATE`, and not a whole-table delete: forcing round 11 must not touch round 12.
- **`--force` re-reads the cache; it never re-downloads. Zero API calls.** The iteration loop
  — change a derived metric, re-derive all 160 sessions — stays entirely off the network.
  Re-downloading is a separate, loud, manual act (clear the cache entry), because at
  45–100 MB a session it is the one mistake that costs hours.
- **The cache is never pruned after ingest.** That is what makes a v1.8 widening of the
  stored-lap rule a local re-run rather than a second 11 GB download.

### SR-7 — Derived columns need a version (standing rule, v1.8)

> **`source_hash` covers the raw channels only. Every derived column set is gated by
> `derive_version` as well. The skip condition compares BOTH: a lap is skipped only when its
> stored `source_hash` matches AND its stored `derive_version` equals the current
> `TRAIL_DERIVE_VERSION`.**

The v1.7 skip condition above is a correct idempotency key for **ingest** and a silently wrong
one for **re-derivation**. Nothing about changing `_apply_trail` changes a raw channel, so
`source_hash` matches, so a default run skips every lap and reports success while leaving every
derived column at its old value. That is not a hypothetical: it is the exact failure mode
`GAPFILL_SPEC` R1 names, and the v1.8 re-derive was gated on it.

Three consequences, all load-bearing:

1. **The version lives on `lap_telemetry`, not on the derived tables.** The derived tables
   cascade from it, so one integer per lap is the whole bookkeeping.
2. **Bumping `TRAIL_DERIVE_VERSION` is what makes a default run re-derive.** `--force` is the
   blunt instrument; the version is the precise one, and it is what lets a re-derive be
   *resumable* — a killed run leaves already-re-derived laps at the new version and the rest at
   the old, and the next run picks up exactly where it stopped.
3. **A census assertion, not a log line, is what proves the run happened.**
   `assert_trail_backfill` (reachable as `--check-trail` on both `python -m f1lab.telemetry` and
   `scripts/warm_telemetry.py`) checks an exact four-part census and exits non-zero otherwise:
   **24,963 corner rows; 9,408 `measured`; 4,633 `taken_flat`; 8,991 `shared_zone_non_terminal`;
   and 0 laps at a stale `derive_version`.** Before the backfill it correctly REFUSES — 0
   measured, 24,963 at `too_few_samples`, 1,518 laps stale. A gate that has been seen to fail is
   worth more than one that has only ever been seen to pass.

## 3.6 T8 — what a failed or partial fetch does to a healthy session

**Nothing.** This is a hard requirement, not a nicety: 160 sessions are ingested and correct
today and an optional data kind must not be able to regress any of them.

The mechanism already exists. `session_ingests` has
`status text CHECK (status IN ('ok','partial','failed'))` **and** a separate
`analytics_status jsonb NOT NULL`. Telemetry is an analytics step, not an ingest step:

| what happened | `analytics_status['telemetry']['state']` | what the app shows |
|---|---|---|
| every eligible driver got a trace | `"ok"` | everything |
| some drivers stored, some failed or had no valid lap | `"partial"` | the stored drivers; the picker lists the others greyed, with the count (§5.6) |
| no lap in the session meets §1.1 | `"none"` | the tab renders one sentence and no chart frame |
| the load or the write raised | `"failed"` (reason in `warnings[]`) | the tab renders one sentence and no chart frame |
| an `ingest --force` dropped it and the cache was gone | `"dropped"` (§2.8) | as `"none"`, with the re-run command in the RUNBOOK |

- **`status` is never downgraded from `'ok'` by anything telemetry does.** A session that
  ingested fine and then failed to get telemetry is still `ok`, because every claim the app
  already makes about it is still true.
- Exception text goes to `warnings[]`, **never** to `error` — `error` belongs to the `failed`
  path and is excluded from the ask schema.
- **Release acceptance criterion:** patch `get_telemetry` to raise, run the telemetry pass
  over an already-correct session, and assert `session_ingests.status` is still `'ok'` and
  every existing page query returns what it returned before.

**Interruption mid-warm** loses at most the session in flight: the write pass commits per
session, and the warmer's filesystem check means a restart skips everything already on disk.

---

# §4 Derived analytics

Everything in §4 is computed **once, at ingest, in Python, on the stored arrays**. Two
reasons: the browser should never aggregate 626 samples to print one number, and §2.2's
`unnest` finding means the ask box must be given scalars or nothing.

## 4.1 `lap_telemetry_summary` — one row per stored lap

Distance-weighted throughout (§0.3); segment weight is `diff(distance_m)`.

| field | rule | measured, 2026 R13 Q |
|---|---|---|
| `top_speed_kph` / `min_speed_kph` | max / min of `speed_kph` | GAS 342 / 71; RUS 343 / 69 |
| `full_throttle_pct` | distance with `throttle_pct >= 99 AND NOT brake` | GAS 83.9%, RUS 79.9% |
| `brake_pct` | distance with `brake` | GAS 12.6%, RUS 8.9% |
| `lift_pct` | distance with **neither** — measured, not `100 − the other two` | GAS 9.0%, RUS 11.2% |
| `overlap_pct` | distance with `throttle_pct >= 99 AND brake` | **5.5%** |
| `n_brake_zones` | rising edges of `brake`, debounced (§4.2) | 7 |
| `n_gear_changes` | `diff(gear) != 0` | GAS 35, RUS 33 |
| `drs_distance_m` | distance with `drs` in the open set — **NULL if the array is flat** | **NULL** (see below) |
| `s1_distance_m`, `s2_distance_m` | chord distance at the driver's own sector times | GAS 1894 / 3707 |
| `max_sample_gap_m`, `n_gaps_over_50m` | from `diff(distance_m)` | ~~73.7–85.7 m~~ → **54.78 m median / 89.72 p95 / 192.69 worst** over all 1,518 stored laps (v1.8, SR-6, §2.1); ~15 |

**Three honesty artefacts that are stored rather than tidied away:**

- **The four shares do not sum to 100, and they must not be forced to.** Throttle and brake
  are separate 10 Hz streams merged onto one index, and **5.5% of the lap by distance carries
  `throttle >= 99` and `brake = true` simultaneously**. That is stream-merge skew, not a
  driver left-foot-braking at 300 km/h, and it survives at native resolution so it is not an
  interpolation artifact. `full_throttle` / `brake` / `lift` are each measured independently
  and `overlap_pct` records the disagreement. A lap with a large `overlap_pct` has a channel
  stack that should not be read to the tenth. Computing `lift = 100 − ft − brake` would hide
  exactly this and is forbidden.
- **`drs_distance_m` is NULL, never 0, when the lap's DRS array is flat.** Measured: `drs`
  was **0 for every sample of every lap** in 2026 R13 Q and R. "Nobody used DRS" and "this
  session has no DRS signal" are different claims and the schema must not conflate them.
  **No visual is built on DRS** beyond §5.3's presence/absence row.
- **`throttle_pct` reaches 104 and is stored as delivered.** Clamping to 100 would silently
  change every derived share and invent a value the sensor did not report.

`s1_distance_m` / `s2_distance_m` exist for one purpose: they let the browser compute the
delta trace's own error at the sector boundaries (§5.2.1) from the two rows it already has,
with no extra query. **Without them the closure check degenerates into an endpoint check,
which the §1.4 measurements show is structurally blind to the error that actually occurs.**

## 4.2 `lap_corner_speeds` — the corner report card

Corners come from `session.get_circuit_info()` (11 for 2026 R13: `Number`, `Letter`, `X`,
`Y`, `Angle`, `Distance`). Per lap per corner, over a window of
`±min(150 m, half the chord gap to each neighbouring corner)`:

- `apex_distance_m`, `apex_speed_kph` — the speed minimum in the window.
- `entry_speed_kph` / `exit_speed_kph` — speed 100 m before / after the apex.
- **`brake_zone_idx` — which of the lap's brake applications serves this corner.** Measured at
  Monza, T1+T2 share one application at 778 m and T8+T9+T10 share one at 3930 m. Without this
  index the table reports the same braking point three times and a fan reads three separate
  stops. Brake zones are debounced: applications separated by **< 50 m** of distance or
  **< 20 m** of gap are merged. Measured effect at Monza: 6–10 raw edges become **4–7** zones.
- `brake_point_m` — chord distance of the serving zone's onset; **NULL when the corner is
  taken flat** (measured: T3 at a 300 km/h apex is flat; the other ten are not).
- `brake_distance_m` = `apex_distance_m − brake_point_m`. Measured range **85–400 m**.
- `throttle_point_m` — first distance after the apex with `throttle_pct >= 99`.
- `time_in_corner_s` — window exit time minus entry time.

~15 corners × ~3,200 laps ≈ **48,000 rows, ~5 MB**, and this table plus the summary is the
**whole** of the ask box's telemetry surface — because "who carried the most speed through
Turn 8 this year" is four lines of SQL here and unanswerable from the arrays.

### The release metre (v1.8)

v1.7 stored where the brake went **on**. v1.8 also stores where it came **off**, which is a
value `brake_zones` already computed and discarded. Three readings, one diagnostic, one reason
word — all defined per `(session, driver, lap, corner)`, on the **serving** zone
`brake_zone_idx`, which D7 freezes:

- **`brake_release_m`** — chord distance of the serving zone's trailing edge, taken as the
  **midpoint of the bracketing sample step**, not the last `true` sample. A boolean edge is
  known only to within one step; the midpoint is the unbiased estimator of it and it is what
  `release_edge` returns.
- **`brake_release_to_apex_m`** = `apex_distance_m − brake_release_m`. **Positive means the
  brake was released before the apex; negative means it was still on at the apex.**
- **`brake_on_distance_m`** = `brake_release_m − brake_point_m` — how long the brake was
  touched. `brake_point_m` does not move: `brake_zones` now delegates to `brake_zone_edges` so
  the merge rule cannot drift, and the re-derive reproduced every stored `brake_point_m` to
  1e-6 m with **zero** mismatches.
- **`trail_duty`** ∈ [0, 1] — an unrendered diagnostic (§4.4), bounded by the same midpoint
  partition `_segment_weights` uses.
- **`trail_status`** — one of six words, **stored, not inferred**, so a blank cell takes its
  reason as a prop from the database rather than guessing from a NULL (§6.4, "enforcement, not
  just captions"):

| word | rows | what it means |
|---|---|---|
| `measured` | 9,408 | all three release numbers are present |
| `taken_flat` | 4,633 | no braking at this corner at all. **A positive report, not a gap** — `brake_point_m` was already NULL here in v1.7, and NULL never means 0 |
| `shared_zone_non_terminal` | 8,991 | one brake application serves several corners and this is not the last of them, so the release belongs to a later corner. The largest single refusal |
| `too_few_samples` | — | fewer than `TRAIL_MIN_ZONE_SAMPLES = 6` samples in the zone |
| `release_step_too_wide` | — | the bracketing step exceeds `TRAIL_MAX_RELEASE_STEP_M = 25.0 m`, ≈ 1.9× the release-edge p95 (§2.1) |
| `implied_decel_impossible` | — | `TRAIL_MAX_DECEL_G = 6.5` exceeded inside `[onset, apex]`, against `time_s` (§6.2, SR-2) |

**Coverage: 9,408 of 24,963 rows (37.7 %) carry a number, and all 75 telemetried sessions keep
measurable corners — none goes dark.** The corner surface therefore renders a *mixed* table, and
every blank carries its own word. That is the shape the refusal takes on a page: rendered, not
omitted.

**What `lap_corner_speeds` does NOT gain, and `lap_telemetry_summary` gains nothing.** A
lap-level trail index is `avg(brake_release_to_apex_m)` over stored rows — four lines of SQL,
exactly what this section promises. Its repeat correlation is 0.412 (§4.4); that does not earn a
column.

**Three measured facts that a caption writer must not get from the v1.8 gap brief.** They were
re-derived from the stored arrays and they disagree with `GAPFILL_SPEC §3.1`; both readings are
recorded and neither was adjusted.

1. **The shipped distribution is not §3.1's.** Over all 20,330 braked rows the re-derived
   `brake_release_to_apex_m` reads p05 −0.9 / p25 13.3 / median 32.0 / p75 88.5 / p95 170.7 m
   with **5.9 % negative**, against §3.1's p05 −56.3 / median 22.0 / p95 153.4 with 14.3 %
   negative. Over the **9,408 rows that actually ship** it reads median **63.2 m with 0.9 %
   negative**. **Any copy saying "14.3 % of braked corners have the brake still on at the apex"
   is wrong for what ships.**
2. **The named-corner face-validity figures do not reproduce.** §3.1 expects Monte Carlo T7 at
   −40.5 m and T18 at −58.3 m; re-derived under §3.1's own definition (the release of the
   *serving* zone, which §4.2 of the gap spec forbids changing and D7 freezes) they are
   **+150.7 m** and **+13.1 m**. Cause, measured: at the hairpin the serving zone is a long
   earlier application and the driver brakes again after a ≥ 20 m coast. A "last serving zone"
   rule instead gives T7 = +28.8 m — still not negative — while moving Monza T2 to +14.4 m
   against §3.1's +13.3. The literal definition ships because it is the one that leaves
   `brake_zone_idx` authoritative, and the disagreement is pinned by a test that asserts the
   **measurement** rather than the expectation.
3. **A sixth condition exists that the six-word vocabulary has no room for.** On **1,604 of the
   9,408** measurable rows (**17.0 %**, `TRAIL_RELEASE_REAPPLIED_ROWS`) the brake is `true`
   again somewhere in `(brake_release_m, apex_distance_m]` — the serving zone's release is
   provably *not* the last time the brake was on before that apex. Their median release-to-apex
   is **142.9 m** against **47.7 m** for the other 7,804. Fixing it needs either a seventh
   status word (breaks the CHECK and the pinned captions) or a change to the serving-zone rule
   (changes `brake_zone_idx`, which D7 forbids). **It is reported here, not patched**, and it is
   the first thing the next release should look at.

## 4.3 Nothing else is precomputed

No sector-attribution model, no time-loss decomposition, no optimal-composite lap, **and no
fuel correction**. Each would be a *model* laid over one lap, and one lap does not carry one.
Stated as principle because it will be asked for: **applying a fuel-burn model to a 10 Hz
trace would dress an assumption up as a measurement.** The app's model-shaped answers live in
Mode 2, on thousands of laps, with their uncertainty printed.

### SR-1 — Quantisation is not a validity floor (standing rule, v1.8)

> **Quantisation is not a validity floor. Cross-driver SD exceeding instrument resolution shows
> only that the instrument works. The floor is the driver's own repeat variance.**

This is the most important sentence in the v1.8 amendment, and it is here because the project
got it wrong once and nearly shipped on it.

**The argument it kills** runs: the channel resolves to ~5 m; the drivers spread ~15 m at this
corner; 15 > 5, therefore the spread is real, therefore we can rank the drivers. Every step is
true and the conclusion does not follow. Beating the **instrument's** noise floor licenses
exactly one claim — *this instrument can tell these two numbers apart*. It says nothing whatever
about whether the difference between them is a fact about the **driver**, because the
instrument is not the only source of variation between two drivers' laps, and on this corpus it
is nowhere near the largest one.

**The right floor, and how to measure it.** The floor is the SD of the **same driver, same car,
same circuit**, measured twice. On `brake_release_to_apex_m` that floor is **as large as the
whole between-driver spread**: cross-driver SD ≈ 14.8–16.7 m in one session, de-meaned
same-driver repeat correlation **r = 0.286**, i.e. roughly **70–80 % of the cross-driver spread
at a corner does not repeat for the same driver**. The instrument resolves 5 m and the driver
does not repeat within 15. Resolution was never the binding thing.

**Three corollaries, because the error generalises past braking.**

1. **A resolution sentence in a caption is a statement about the instrument, not a warrant.**
   C-BRK-1 may say the channel is good to ~4 m. It may not use that to imply a comparison is
   sound.
2. **The test is a repeat, not a ratio.** No amount of arithmetic on a single session's spread
   recovers the repeat variance. It has to be *measured*, on a second observation of the same
   driver — which is what SR-4 institutionalises.
3. **This is why more resolution does not help** (§1.1, SR-5). A brake-pressure channel is a
   better instrument, and a better instrument against an unmeasured repeat floor is the same
   mistake at higher precision.

### SR-3 — The sign test (standing rule, v1.8)

> **If a candidate metric's lower quartile has the wrong sign, refuse it. Keep it computed as an
> unrendered diagnostic so the next release does not re-derive it from scratch.**

A quantity that is supposed to be positive by construction and is negative for a quarter of its
rows is not a noisy measurement of the thing — it is a measurement of something else. The v1.8
case: `decel_ratio_apex` (mean decel in the last 20 % ÷ peak decel in the first 50 %) has median
**0.083** but **p05 = −0.259 and a negative lower quartile**, because the car is already
accelerating before the stored apex — the apex being a speed minimum located to the nearest
sample. **A metric whose lower quartile has the wrong sign is not a measurement of technique.**

The test is cheap, it is mechanical, and it runs **before** any correlation, which is the point:
it disqualifies a candidate on its own distribution, with no outcome variable in sight and
therefore no opportunity to be talked out of the result by a flattering correlation found
afterwards. The "keep it computed" half matters as much as the refusal half — a diagnostic that
is deleted is a diagnostic the next release re-derives, re-discovers, and re-argues.

### SR-4 — The repeatability gate (standing rule, v1.8)

> **No per-lap technique metric may be rendered as a driver comparison until it has passed the
> pooled sprint-weekend repeat test at a pre-registered threshold. Pool every available paired
> weekend; one weekend settles nothing.**

**The test, stated once so it is reusable.** Same driver, same car, same circuit: Q against SQ
of one sprint weekend. De-mean within `(session, corner)` — which removes the circuit, the
corner and the session, and leaves the driver. Correlate. **Pool every paired weekend in the
corpus**; on this database that is **13–14 weekends** carrying telemetry on both sessions,
≈ **3,000 paired corner cells**.

**Pooling is not a refinement, it is the test.** A single weekend's ~20 drivers gives an SE of
≈ **0.23**, which cannot distinguish r = 0 from r = 0.3 — and indeed the per-weekend driver-level
`r(Q, SQ)` values measured **+0.16, −0.21, +0.23**, three numbers from which a motivated reader
can extract any conclusion they like. Pooled, the same data returns **0.268–0.311 stably**. Any
version of this test run on one weekend is theatre.

**Pre-register the threshold before the number is known.** `grid_pace`'s retirement at
`corr ≥ 0.95` is the precedent this project already follows; the point of pre-registration is
that the threshold cannot be chosen after the estimate arrives.

**Aggregate honestly, and say what the altitude bought.** The correlation rises with the unit of
aggregation and that rise is not evidence of a driver signal — see §4.4's table, where a
season-level 0.874 is still not a rating.

**The gate has teeth because it has already refused something.** §4.4 is what it refused.

## 4.4 The trail-braking refusal, recorded in full (v1.8)

v1.8 ships **the release metre and refuses the rating**. The two are not in tension: the reading
is a reading of one lap, and the rating would be a claim about a driver. `GAPFILL_SPEC` DL-14
adopts both because they are answers to different questions.

**This is the project's third refusal, and it was reached the same way as the first two: it was
built, it was measured against a real noise floor, and the noise floor won.**

### 4.4.1 What was measured

Under SR-4's test — 13–14 pooled sprint weekends, de-meaned within `(session, corner)`:

| candidate | paired n | de-meaned same-driver repeat `r` | between-driver SD in one session |
|---|---|---|---|
| `brake_release_to_apex_m` | 3,329 (independently 2,963) | **0.286** (independently **0.268**) | 14.8 m (16.69 m) |
| `trail_duty` | 2,963 | **0.198** | 0.099 |
| `taper` = median(a, last third) / median(a, first third) | 2,867 | **0.001** | 0.226 |
| `trail_frac` = `brake_on_distance_m / brake_distance_m` | 3,329 | **0.018** | 0.127 |
| `late_loss_frac` (share of speed shed in the final third) | 3 weekends | **signal share 0.00 / 0.12 / 0.00** | — |

Aggregated to driver-weekend (263 cells, ≥ 4 corners): **0.311** for the release metre, **0.355**
for the duty.

### 4.4.2 What is refused, each on its own number

1. **The taper.** `r = 0.001`. A second difference of a `smallint` speed channel over a ~5 m
   step; the noise is the whole of it. **This is the metric the gap brief asks for by name, and
   it is not obtainable from a boolean channel** — see §4.4.5.
2. **`trail_frac`.** `r = 0.018`. Dividing by `brake_distance_m` injects the onset's noise and
   destroys what the raw difference had.
3. **`late_loss_frac`.** Signal share 0.00 on two of three weekends. Dropped **entirely**,
   including as prose about a single lap.
4. **`decel_ratio_apex`.** Refused by SR-3's sign test; kept as an unrendered diagnostic.
5. **Brake/turn overlap from `(x, y)` curvature.** Position noise at 4–5 m spacing gave a
   turn-in point so unstable that `brake_after_turn_in / zone_length` came out as exactly 1.00
   and exactly 0.00 for adjacent drivers at the same Monza corner. Noise wearing the clothes of
   a measurement.
6. **Any driver-versus-driver brake-shape comparison, and any `mode2_driver_skill` value.** At
   `r = 0.286`, 70–80 % of the cross-driver spread at a corner does not repeat for the same
   driver. `trail_braking` is written as a **`measured = false` row for all 28 drivers** and
   rendered beside tyre management and wet. It is a **row with a reason, not an absence** — a
   refusal that is merely omitted is indistinguishable from an oversight.

### 4.4.3 `trail_duty` is stored and never rendered

`trail_duty` survives adversarial testing (bounded by construction, stable at the shared-zone
boundary) and still does not ship: its repeat correlation is **0.198** and
**`corr(trail_duty, apex_speed_kph) = −0.595`**, so a cross-corner average of it is largely a
measurement of the circuit. It is stored for the refusal audit and for the next release's
validity work, and it is enforced out of reach rather than merely discouraged:

- it is **excluded from the ask schema at the column level** — `ask.lap_corner_speeds` exposes
  18 columns against the base table's 19, and the one difference is `trail_duty`;
- the `f1_ask` role has **no privilege on `public`**, so the base table is not a way around it.

The three brake-shape readings that *are* exposed carry `GAPFILL_SPEC §4.4`'s restriction:
aggregate **only** with `GROUP BY session_id, corner_number`, and expose to the ask box **only
filtered to a single `(session_id, driver_id, lap_number)`** — never grouped across drivers, and
never as a per-driver trail-braking number. **Honest limit on how much of that is enforced
rather than asked for:** the column-level exclusion of `trail_duty` and the `public` grant are
hard, structural and provable; the filtering-and-grouping rule is **prompt-level prose** in the
ask manifest, because `web/lib/ask/validate.ts` has no per-column required-predicate machinery
today. Stated plainly so nobody cites this paragraph as a guarantee it is not.

### 4.4.4 What repeats, at what altitude — and why 0.874 is still not a rating

| unit of aggregation | repeat `r` | verdict |
|---|---|---|
| one corner, one lap | **0.286** | ~8 % of the variance repeats. **Not a fact about a driver.** |
| all corners of one lap (driver-lap mean) | **0.412** | still mostly the lap |
| a driver's whole season (split-half by round parity) | **0.874** | a stable signature — of driver **and car and setup together** |

The 0.874 is genuinely repeatable and is **still not a driver rating**: one lap per driver per
session, no mobility variation, and a split by round parity holds the car fixed all season *by
construction*, so the car cannot be separated from the driver in it. §4.3 forbids a model laid
over telemetry, so there is no fitted route to that separation here either. **The surface
aggregates to the lap and stops there**, and 0.874 is recorded in this file rather than printed
anywhere a reader can carry it away.

**The discredited result, published so nobody rediscovers it and ships it.** A looser first
detector (`n ≥ 5`, zone ≥ 30 m, no edge-guard, no chord-compression refusal) produced a
per-driver index with `r(Q, SQ)` of **+0.26 to +0.47**. Tightening the gates destroyed it: the
apparent driver signal was the compound-section artefact — some drivers' zones were being
charged to a later corner's low point more often than others'. **That number is wrong and it is
recorded here as wrong.**

### 4.4.5 Two corrections to the reasoning, not to the verdict

**DL-23 — "within-driver repeatability cannot be estimated from this database at all" is FALSE,
and is recorded here as false.** It can be, and it was: **13–14 sprint weekends carry telemetry
on both Q and SQ** of the same weekend — same driver, same car, same circuit, two sessions — and
that is exactly the experiment SR-4 needs. The claim matters because it is load-bearing in the
wrong direction: if repeatability were genuinely unmeasurable, a team could argue that shipping
the rating is no worse than not shipping it, since nobody can prove it wrong. It is measurable,
it was measured, and **that test is the one that decides whether the metric means anything.** A
"cannot be measured" claim should always be checked before it is believed; this one cost the
release nothing to check and would have cost it a false skill to accept.

**DL-24 — the taper's refusal is about replication, not resolution.** It would be easy to read
`r = 0.001` as "the boolean channel is too coarse". Both halves of that are wrong in a way SR-1
and SR-5 exist to prevent: the taper's between-driver SD (0.226) comfortably exceeds anything
quantisation imposes, and **a brake-pressure channel on the same one stored lap would fail the
same test for the same reason**. What a pressure trace *would* add is real and worth naming —
peak pressure, where the peak falls in the zone, the release ramp, modulation under lock-up, and
honest left-foot overlap instead of §4.1's 1.3–5.5 % stream-merge artefact. **This metric
measures how long the brake was touched, not how hard.** What a pressure trace would **not** fix
is the refusal. The pre-condition is more laps, not a better channel (§1.1, SR-5).

### 4.4.6 The alternative construction, named for a future release (DL-20)

The shipped metric is **apex-anchored**: it measures to `apex_distance_m`, and it therefore
discards every braked corner that is non-terminal in a shared zone —
**8,991 of 20,330 braked rows**, `shared_zone_non_terminal`. **That discard is accepted,
deliberately**, and it is the single largest refusal in the release.

> **The share is reported both ways and neither is adjusted.** DL-20 states the discard as
> **43.6 %**. That is `8,870 / 20,330`, i.e. it is computed from the *losing* candidate of
> DL-17's two disagreeing derivations. Against DL-17's own settled constant,
> `TRAIL_NON_TERMINAL_ROWS = 8,991`, the same ratio is **44.2 %** (and 36.0 % of all 24,963
> corner rows). The two DL entries are internally inconsistent by one stale numerator; the
> verdict they support is identical either way, and the discard is accepted at both figures.

The named alternative is **`slow_m`-anchored** — anchoring to the zone's own speed minimum
rather than to the stored apex, which avoids the discard entirely. It was not taken because it
needs **a new table and a new unit**, breaking the `(session, driver, lap, corner)` join that
every existing corner surface uses, and §4.1's whole argument for putting the release metre on
`lap_corner_speeds` is that the grain is already right. **It is recorded here as the named
alternative for a future release, not as a rejected idea** — a release that is already paying
for a schema change, or one that has lifted SR-5's one-lap rule and is rebuilding the corner
surface anyway, should price it properly rather than re-derive the argument.

## 4.5 The standing-rule index (v1.8)

`GAPFILL_SPEC §4.5` specifies six rules; DL-24 adds a seventh (SR-1), which is why the count
here is seven and not six. Each is written in full where it is enforced. **This table is an
index, not a second copy** — the enforcing section is authoritative.

| # | Rule | Lives in | One line |
|---|---|---|---|
| **SR-1** | Quantisation is not a validity floor | **§4.3** | Cross-driver SD beating instrument resolution shows only that the instrument works. The floor is the driver's own repeat variance. |
| **SR-2** | Never differentiate against distance | **§6.2** | `dv/dx` on native chord samples returns 46–586 m/s². Use ≥ 25 m windows against `time_s` (4–23 m/s²). |
| **SR-3** | The sign test | **§4.3** | Lower quartile with the wrong sign ⇒ refuse. Keep it computed as an unrendered diagnostic. |
| **SR-4** | The repeatability gate | **§4.3** | No per-lap technique metric renders as a driver comparison until it passes the pooled sprint-weekend repeat test at a pre-registered threshold. Pool every weekend; one settles nothing. |
| **SR-5** | **Replication is NOT the limit — execution scatter is** | **§1.1** | *Revised 2026-09-18.* n = 1 was never the binding constraint. 0.286 at one corner against 0.412 over ~15 corners proves the noise is corner-specific, so averaging laps cannot reach the 0.70 a rating needs: the ceiling is **0.32–0.47**. Costed in full and **deliberately not built**. Do not re-open it as a storage problem. |
| **SR-6** | Sampling figures corrected | **§2.1** | Lap-wide `max_sample_gap_m` 54.78 m median / 89.72 p95 / **192.69 worst**; mean step 8.04 m; in-zone 4.94 m median (**p95 disputed — see §2.1**). Not "~74 m" and not "73.7–85.7 m". |
| **SR-7** | Derived columns need a version | **§3.5** | `source_hash` covers the raw channels only. `derive_version` gates every derived column set, and the skip condition compares both. |

**Scope.** SR-1, SR-3 and SR-4 are about *any* per-lap metric, not about braking. They were
written by the trail-braking work because that is where the corpus pushed back hardest, and the
next candidate — a throttle-application metric, a gear-shift-timing metric, a minimum-speed
consistency metric — meets all three before it meets a page.

---

# §5 Visuals

## 5.0 Shared rules

**One new component file per visual under `web/components/charts/`, each importing only
`EChart`.** SPEC §3.4's "one ECharts importer" rule holds.

**`EChart.tsx` is edited exactly once, by exactly one owner (WP-8), to add
`VisualMapComponent`.** Verified against the file: `echarts.use([...])` registers
`BarChart, BoxplotChart, CustomChart, LineChart, ScatterChart, GridComponent,
TooltipComponent, LegendComponent, DataZoomComponent, MarkAreaComponent, MarkLineComponent,
TitleComponent, AxisPointerComponent, CanvasRenderer` — and **no `VisualMapComponent`**. In a
tree-shaken `echarts/core` build an unregistered component is **silently ignored**, so the
channel-painted track map would ship unpainted with no error. Two lines:

```ts
import { VisualMapComponent } from "echarts/components";   // v1.7 §5.0 — the track map ramp
// ...and VisualMapComponent added to the echarts.use([...]) list.
```

No other chart type or component is needed. `MarkPoint` is **not** registered and is not used.

**Colour (T11).** Drivers take their **team colour from the database** (`lib/colours.ts`,
`session_teams`), never a fixed palette. Two teammates therefore collide, and the rule is
**driver A solid, driver B dashed (`lineStyle.type: 'dashed'`), always**, so a teammate
comparison is legible without inventing a colour the team does not have.

`--color-fastest` (#B45AF2) / `--color-personal` (#00D26A) / `--color-slower` (#FFD500)
**encode meaning and appear nowhere in this feature.** Nothing here is a personal best and
nothing here is "off the pace". Painting a speed ramp with them would tell a fan that purple
means *fastest* when here it would mean *340 km/h*; filling a delta with personal-best green
would tell a fan someone set a personal best when it means *ahead at this point on the road*.
One new token group is added to `globals.css`, documented as what it is:

```css
/* v1.7 — sequential channel ramp. Dark = low, bright = high. MAGNITUDE, NOT MEANING.
   Hues deliberately clear of --color-fastest/personal/slower and of --color-accent. */
--ramp-0: #0A2540; --ramp-1: #17527D; --ramp-2: #2E8FB8; --ramp-3: #6FD3E8; --ramp-4: #DFF6FF;
```

## 5.1 V1 — the track map

**`web/components/charts/TrackMap.tsx`.** Inputs: one lap's `x`, `y`, `distance_m`, the chosen
channel array, this circuit's `circuit_corners` rows, and `circuit_layout.rotation_deg`.

**Orientation.** Applied in the component, not at ingest, so stored X/Y stay raw and
re-orientable: `x' = x·cosθ − y·sinθ`, `y' = x·sinθ + y·cosθ`, `θ = rotation_deg·π/180`.
Measured **95.0°** for 2026 R13 — a map drawn without it is a quarter-turn wrong and a fan
does not recognise the circuit, which is the entire point of drawing it.

**Aspect ratio — the mechanism, not an assertion.** ECharts will happily stretch a circuit to
fill a rectangle. Instead:

1. compute the rotated bounding box; pad it by 4% of the longer side;
2. set the **wrapper div's CSS `aspect-ratio` to the padded box's own ratio** — the container
   becomes the shape of the circuit, rather than the circuit becoming the shape of the
   container;
3. set `xAxis.min/max` and `yAxis.min/max` to the padded box **explicitly**, `grid` to
   `{left: 0, right: 0, top: 0, bottom: 0, containLabel: false}`, both axes
   `{show: false, type: 'value'}`.

One metre is then one metre on both axes **at every viewport width**, with no resize maths and
no dependence on `EChart`'s `ResizeObserver`. Height is bounded by `max-height: 70vh`.

**Series — three, in z-order:**

```ts
series: [
  { // 1. the outline — guarantees continuity where the painted points thin out
    type: 'line', data: pts, showSymbol: false, silent: true, z: 1,
    lineStyle: { color: PALETTE.grid, width: 7, cap: 'round', join: 'round' } },
  { // 2. the painted ribbon.  dim 0 = x', 1 = y', 2 = channel, 3 = distance_m
    type: 'scatter', data: pts, symbolSize: 6, z: 2,
    encode: { x: 0, y: 1, tooltip: [3] } },
  { // 3. corner numbers
    type: 'scatter', data: corners, symbolSize: 1, z: 3, silent: true,
    label: { show: true, formatter: '{@[2]}', color: PALETTE.muted,
             fontSize: 11, fontFamily: 'var(--font-mono)' } },
],
visualMap: { type: 'continuous', dimension: 2, seriesIndex: 1,
  min, max, calculable: false, orient: 'horizontal', bottom: 4, left: 'center',
  itemWidth: 10, itemHeight: 120,
  inRange: { color: ['#0A2540','#17527D','#2E8FB8','#6FD3E8','#DFF6FF'] },  // --ramp-0..4
  textStyle: { color: PALETTE.muted } },
```

**Channel selector:** Speed (default) · Gear · Throttle · Brake. Gear switches `visualMap` to
`type: 'piecewise'` with eight steps of the same ramp. **Brake switches to two pieces**
(`false` → `--color-grid`, `true` → `--ramp-4`), because a brake trace is a binary and a
continuous ramp would imply a magnitude that does not exist.

**Interaction.** Hovering a point publishes `distance_m` on a shared store; V2 and V3 move
their `axisPointer` to the same distance, and a readout under the map shows
`T7 · 184 km/h · 3rd · brake`. Hovering V2/V3 moves a highlight dot on the map. **That
two-way link is the feature**: it is how a fan connects "the line dips here" to "here is
Turn 7".

**What it reveals.** Where the car is slow and where it is fast, as *geography* rather than as
a number — the one picture this app has never had.

## 5.2 V2 — the two-driver delta trace (the flagship)

**`web/components/charts/DeltaTrace.tsx`.** Inputs: two laps' `distance_m` (chord, T5) and
`time_s`, both `laps.lap_time_s`, both `s1_distance_m` / `s2_distance_m`, and the circuit's
corner distances.

**T10: this component does not exist outside Q/SQ.** It takes a `sessionKind` prop and, for
any other kind, returns the C-TEL-5 notice instead of a chart. The second-driver picker is not
rendered on a race page at all. **An absent feature with a stated reason, not a disabled
button** — a race lap cannot support a cross-driver comparison and a caption is a weaker guard
than absence (§6.4).

### 5.2.1 The alignment rule, stated once and enforced by a test

```
1. x is CHORD DISTANCE along the lap (lap_telemetry.distance_m). Never Time.
   Never FastF1's integrated Distance: measured spread 114.7 m (and 141.0 m over
   eight laps) between laps of ONE circuit, against 9.5-12.7 m for chord (§1.4).
2. The common axis is  s in [0, min(L_A, L_B)]  on a 1 m grid. NO normalisation,
   no stretching to a common 0..1. Chord lengths agree to ~10 m, so the trimmed
   tail is metres - not the 111 m that normalisation exists to paper over, and
   not a silent truncation of the longer array by index.
3. delta(s) = interp(s; dist_A, time_A) - interp(s; dist_B, time_B).
4. SIGN: delta > 0 means A took MORE time to reach s, i.e. A is BEHIND.
5. The trace is drawn only after the closure check below passes.
```

**Why not normalise.** Per-lap-length normalisation closes the endpoint **exactly** — and is
therefore self-certifying and useless as a check — while displacing the integration error into
the interior, measured at **+481, −496, +446, −570, +453, −573 ms** at the sector boundaries.
Those are 3–10× the gaps the chart claims to explain. A fan would be told the lap was won
somewhere it was not.

### 5.2.2 The closure check — the chart validates itself before it renders

`delta(s_end)` must equal `lap_time_A − lap_time_B` from `laps`. Measured: chord alignment
closes to **4–109 ms**; raw-`Distance` alignment misses by **1378–1398 ms**.

| measured closure error | behaviour |
|---|---|
| ≤ **150 ms** | render normally |
| 150–400 ms | render, and **C-TEL-2 prints the measured error** |
| > **400 ms** | **do not render the delta trace.** Show the map and the stack, and one line: *these two laps cannot be aligned closely enough to say where the time went.* |

**The same check runs at the two sector boundaries**, using `s1_distance_m` / `s2_distance_m`
(this is why §4.1 stores them). Measured residuals: **8, 37, 72, 81, 98, 8 ms**. Under chord
alignment this is a real assertion; under any length normalisation the endpoint version is a
tautology, which is why §5.2.1 forbids normalisation.

**One relative rule on top of the absolute gates.** When the closure error exceeds
**half the official gap**, the caption **leads** with: *the alignment error on this pair is
larger than half the gap itself — read the shape of the line, not its size.* A 399 ms error
drawn onto a 180 ms gap must not look like a clean chart merely because it cleared an absolute
threshold.

### 5.2.3 Option shape

```ts
xAxis: { type: 'value', min: 0, max: sEnd, name: 'distance (m)',
  axisPointer: { show: true, snap: false, label: { formatter: p => `${p.value|0} m` } } },
yAxis: { type: 'value', min: -m, max: +m,            // ZERO-CENTRED AND SYMMETRIC, always
  name: `<- ${codeB} ahead        ${codeA} ahead ->`,
  axisLabel: { formatter: v => (v > 0 ? '+' : '') + v.toFixed(2) + 's' } },
series: [
  { type: 'line', data: deltaPos, showSymbol: false, smooth: false, z: 3,
    lineStyle: { width: 2, color: PALETTE.fg },
    areaStyle: { origin: 0, opacity: 0.22, color: teamColour(B) },
    markLine: { silent: true, symbol: 'none', data: [
      { yAxis: 0, lineStyle: { color: PALETTE.muted, width: 1, type: 'solid' } },
      ...corners.map(c => ({ xAxis: c.distance_m,
          label: { formatter: `T${c.n}`, position: 'insideEndTop',
                   color: PALETTE.muted, fontSize: 10 },
          lineStyle: { color: PALETTE.grid, width: 1, type: 'dotted' } })) ] },
    markArea: { silent: true, itemStyle: { color: 'rgba(139,139,151,0.10)' },
      data: gapIntervals.map(([a, b]) => [{ xAxis: a }, { xAxis: b }]) } },
  { type: 'line', data: deltaNeg, showSymbol: false, z: 3,       // the same trace, clipped
    lineStyle: { width: 2, color: PALETTE.fg },
    areaStyle: { origin: 0, opacity: 0.22, color: teamColour(A) } },
],
dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' },
           { type: 'slider', xAxisIndex: 0, filterMode: 'none' }],
```

- **The y-axis is zero-centred and symmetric** (`min: -m, max: +m`, `m = max|delta|` rounded
  up). A free-scaled y-axis on a delta chart makes a 0.05 s gap look like a chasm; this is
  the encoding rule that stops the chart exaggerating itself.
- **The zero line is the only solid horizontal rule on the chart**, because it is the only
  one that means anything: *level at this point on the road*.
- **The area is split at zero by sign** — two line series clipped positive and negative,
  filled in **B's team colour above** and **A's team colour below** at 0.22 opacity, so
  colour reads as *who is ahead* without reading the axis. Team colours, never the semantic
  tokens (T11).
- **The y-axis is annotated with driver codes at both ends**, not with the word "delta".
  Nobody has to remember a sign convention.
- **`markArea` shades the sample gaps.** Measured at v1.7 build time on a sample session:
  **~15 gaps > 25 m per lap, worst 73.7–85.7 m**. *(Corpus-wide in v1.8, SR-6: 54.78 m median /
  89.72 p95 / **192.69 worst** — the v1.7 sample understated the tail. The shading is unchanged
  and correct; only the sentence describing it was.)* The shading threshold is **50 m** and the
  bands read *interpolated — no measurement here*. Without this the single largest artifact in the data is invisible: the
  worst apparent delta swing in the sample session (−1.59 s between two laps 0.060 s apart)
  sits at high speed, exactly where the samples are thinnest.
- **The right-hand edge carries a text label with the official gap** from `laps.lap_time_s`,
  not the trace's own endpoint. When they disagree the official number is the one shown and
  the difference **is** the closure error.
- **`dataZoom` is pinned to `filterMode: 'none'`.** Filtering would re-baseline the trace to
  the zoom window — a silent lie.

**What it reveals.** Exactly where, in metres, one lap was quicker — and, through the gap
shading and the closure caption, exactly how much of that is measurement.

## 5.3 V3 — the channel stack

**`web/components/charts/ChannelStack.tsx`** — one `EChart` with four grids sharing one
x-axis, immediately below V2 and on the same x range, so the eye reads straight down from
"he gained here" to "because he braked later". On a race page it renders **one driver**.

| row | height | content |
|---|---|---|
| 1 | 34% | **Speed** — line series, A solid / B dashed, team colours, `showSymbol: false` |
| 2 | 26% | **Throttle** 0–105 with a dotted rule at 100, plus **brake as a `markArea` band** per driver along the bottom 20% of the row |
| 3 | 22% | **Gear** — `step: 'end'`, y 1–8, integer ticks |
| 4 | 18% | **DRS** — a two-state band per driver, **or, when the session's `drs` is flat, the row is replaced by the C-TEL-7 sentence** |

```ts
axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: PALETTE.raised } },
tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
grid: [ {top:'2%',height:'30%'}, {top:'36%',height:'22%'},
        {top:'60%',height:'18%'}, {top:'80%',height:'14%'} ]
      .map(g => ({ ...g, left: 56, right: 16 })),
xAxis: [0,1,2,3].map(i => ({ gridIndex: i, type: 'value', min: 0, max: sEnd,
  axisLabel: { show: i === 3 }, axisLine: { show: i === 3 } })),
yAxis: [ {gridIndex:0}, {gridIndex:1, max:105}, {gridIndex:2, min:1, max:8, interval:1},
         {gridIndex:3, show:false} ],
```

The DRS rule is not cosmetic. Measured, `drs` was **0 for every sample of every lap** in 2026
R13 Q. An empty DRS row would be read as "nobody opened it". **Absent data and a measured
zero must not look the same.**

`throttle_pct` is plotted **as delivered, up to 104** (§4.1) — clamping would hide a real
property of the feed.

## 5.4 V4 — the corner report card

**`web/components/charts/CornerCard.tsx`.** A timing-tower-styled table, not a chart: one row
per corner from `lap_corner_speeds` — *corner · apex km/h · brake point · braking distance ·
Δapex* — with A and B side by side (one column on a race page) and the difference in the
site's tabular figures (`.tnum`). **Corners sharing a `brake_zone_idx` are bracketed as one
complex** (measured at Monza: T1+T2, and T8+T9+T10). Rows sort by `|Δ apex|` on click, so
"where was he actually quicker" is one interaction from an answer in words.

This is the only visual whose numbers a fan can copy into an argument, and the only one the
ask box can also produce (§2.6).

## 5.5 The page, the picker, and the queries

**Route: `web/app/race/[year]/[round]/telemetry/page.tsx`** — a new tab on the existing
session page, a sibling of the qualifying section v1.6 added. **The app's race route is
`[year]/[round]`; there is no `[sessionId]` segment anywhere under `web/app`.**

One new query module `web/lib/queries/telemetry.ts` (single owner), three functions:

```ts
listTelemetryLaps(sessionId: number)                       // for the picker
getLapTelemetry(sessionId: number, driverId: string)       // one lap, one PK lookup
getCornerSpeeds(sessionId: number, driverIds: string[])
```

**Every signature takes exactly one `session_id`.** Cross-session comparison therefore has no
callable shape — honesty enforced by the type system rather than by a footer (§6.4).

The picker is **two driver pills** on Q/SQ and **one** on R, not a lap picker, because §1.1
stores exactly one lap per driver and a dropdown with one entry implies laps that do not
exist.

- **A defaults to the session's fastest-lap driver; B defaults to A's teammate**, falling
  back to P2. The teammate default is deliberate: it is the comparison where car, fuel policy
  and engine mode are closest to equal, i.e. the one §6.1's caveats damage least.
- Each pill shows code, team colour, lap time, compound and tyre life — the four things that
  decide whether the comparison is fair, **shown above the chart, not under it**.
- Drivers with no stored lap are listed greyed with the reason (§3.6), never silently missing.
- Both pills, the channel selector and the hovered distance live in the URL
  (`?a=VER&b=NOR&ch=speed`), so a fan can link someone to a corner.

## 5.6 Empty states

| `analytics_status['telemetry']['state']` | the tab |
|---|---|
| absent (never attempted) | **not rendered at all** |
| `"none"` / `"failed"` / `"dropped"` | renders one sentence and **no chart frame** |
| `"partial"` | everything renders; the picker header says *telemetry stored for 14 of 20 drivers* |
| `"ok"` | everything |

**No skeleton, no placeholder chart.** An empty axis frame is how a site says "there is data
here" when there is not.

---

# §6 Honesty and the verbatim captions

## 6.1 What a delta trace does and does not license

**It licenses exactly one sentence:** *"On these two laps, A reached this point on the road
0.21 s earlier than B."* That is a measurement of two laps. It is not a measurement of two
drivers, two cars, or two anything else.

**It does not license**, and the app must never imply:

| the conclusion a fan will reach for | what differs between the two laps | is it in the data? |
|---|---|---|
| "A is faster than B" | fuel load (a Q1 run is not a Q3 run) | **no** |
| | tyre compound and tyre age | in the header, not in the trace |
| | track temperature and rubber laid since the last run | **no** |
| | engine mode | **no** |
| | wind direction | **no** |
| "A brakes later than B" | which of *his own* laps this was | **no** |
| "A has more straight-line speed" | a tow from the car ahead | **no** — `DistanceToDriverAhead` is deliberately not stored |
| "A's car is better in slow corners" | setup, and everything above | **no** |

Two measurements that kill the second and third rows outright:

- **A driver is not repeatable to the resolution this chart draws at.** The project's own
  prior measurement (QUALI_SPEC §0.4): a driver's push laps *within a single qualifying
  segment* vary by a median **0.186 s at Monza and 0.459 s at Spa**. One corner, once, is not
  a fact about a driver.
- **At 2026 R13 the top four laps were within 0.180 s and top speeds within 1 km/h**
  (342 vs 343). At a low-drag circuit a tow is worth more than either car, and this data
  contains no way to tell one from the other.

**And nothing here licenses anything about a stint, a race or a season.** One lap per driver
per session is stored and no other lap exists in the database (§1.1).

## 6.2 What the measurement itself cannot do

- **Mid-lap accuracy is ~0.1 s, not 0.001 s.** Chord-aligned deltas match the drivers' own
  sector times to **8–98 ms** (§1.4). Anything smaller than a tenth on this chart is
  alignment noise, and the tooltip's third decimal is precision, not accuracy.
- **Chord length has its own bias, in a known direction.** Cumulative chord under-reads true
  arc length where curvature is high and sample spacing is wide — i.e. in slow corners — and
  (X, Y) carries position noise of its own. It is 15× better than integrated `Distance`, not
  perfect, and the residual is the number C-TEL-2 prints rather than rounds away.
- **~15 intervals per lap contain no measurement.** v1.7 said "gaps up to 85.7 m"; **corrected
  in v1.8 (SR-6, §2.1): the median lap's worst gap is 54.78 m, the p95 lap's is 89.72 m, and the
  worst gap in the corpus is 192.69 m** — nearly 2.3× what this bullet claimed. The trace across
  them is interpolation and is shaded as such (§5.2.3), and the shading threshold of 50 m is
  below the *median* lap's worst gap, so essentially every lap shades something. That is the
  honest picture, not a defect in the shading.
- **5.5% of the lap by distance reports full throttle and braking at once** (§4.1). A lap with
  a large `overlap_pct` should not be read to the tenth.
- **No fuel correction is applied, ever** (§4.3).

### SR-2 — Never differentiate against distance (standing rule, v1.8)

> **Never differentiate `speed_kph` against `distance_m` on native samples. It returns
> 46–586 m/s² — up to 60 g — because chord samples compress in slow chicanes, so the
> denominator collapses exactly where the numerator is largest. Differentiate against `time_s`,
> over windows of ≥ 25 m, which yields a physical 4–23 m/s².**

This is the same pathology §6.2 already names above (chord under-reads arc where curvature is
high), met a second time in a form where it does not look like an alignment problem — it looks
like a car decelerating at 60 g, and a reader who does not already know the cause will believe
the arithmetic before they disbelieve the number. **The failure is silent and it is quantitative,
which is the worst combination.** Stated as a rule because it will be rediscovered: every
"instantaneous" quantity anyone wants from this table — decel, jerk, an entry-phase gradient —
reaches for `dv/dx` first, and `dv/dx` is unusable on this sampling.

Two clarifications so the rule is not over- or under-applied:

- **`TRAIL_DECEL_WINDOW_M = 25.0` is the named constant for this rule**, and the v1.8 R5
  plausibility gate deliberately does **not** use it. R5 is specified in `GAPFILL_SPEC §3.2` as
  a *consecutive-sample* `|dv/dt|` test inside `[onset, apex]`, differentiated against `time_s`.
  Consecutive samples against **time** are not the forbidden operation; consecutive samples
  against **distance** are. WP-B1 implemented §3.2's gate literally rather than silently
  widening it to 25 m, and recorded the distinction rather than resolving it by taste.
- **The rule is about differentiation, not about distance.** `brake_release_to_apex_m` and
  `brake_on_distance_m` are *differences* of two chord distances, not derivatives. They inherit
  chord's known bias and nothing worse, which is why they can ship (§4.2) when the taper built
  on top of them cannot (§4.4).

## 6.3 The verbatim captions

These are the shipped strings. They live as pinned `const` exports in
**`web/lib/telemetry/captions.ts`** and `web/lib/telemetry/captions.test.ts` asserts they have
not drifted, so "verbatim" is mechanically enforced rather than aspirational. `{…}` are
per-pair computed substitutions.

> **C-TEL-1** — above every delta trace, unconditional, never in a footer
> **One lap against one lap.** These are the two drivers' fastest laps of this session and
> nothing else. They were set on different fuel loads, different tyre ages and a track that
> changed between them. The trace is cumulative, so one held-up corner shifts every metre
> after it — read where the line changes slope, not where it ends up. This chart shows where
> one lap was quicker than the other. It does not show which driver, or which car, is faster.

> **C-TEL-2** — under every delta trace; the numbers are computed per pair
> Aligned on distance around the lap. The trace closes to within **{closure_ms} ms** of the
> official gap and matches the drivers' own sector times to within **{sector_ms} ms** — so
> read the shape of this line, not the third decimal. **{n_gaps}** stretches of the lap,
> shaded grey, have no measurement in them and are drawn by interpolation.
> *(When `closure_ms` exceeds half the official gap, this caption is preceded by:
> **The alignment error on this pair is larger than half the gap itself — read the shape of
> the line, not its size.**)*

> **C-TEL-3** — under the track map
> Painted from **{n_samples}** samples taken ten times a second on one lap. The shape is the
> car's path on that lap — not the racing line, not the circuit's centreline.

> **C-TEL-4** — on the picker, whenever A and B are **not** teammates
> These two drive different cars. Almost everything you can see below is the car, the fuel or
> the tyre, and this page cannot tell you which. Compare teammates to get closer to a like-
> for-like run — and even then, read what this page can't tell you. If you want the driver
> separated from the car, that is the was-it-the-car page, which uses thousands of laps and
> says how uncertain it is.

> **C-TEL-5** — on a race session, where the second-driver picker would otherwise be
> No cross-driver comparison on a race lap. These laps were run in traffic, on fuel loads
> that fall all race, on tyres of different ages — so a side-by-side trace would look like a
> measurement and would not be one. The map and the channels below are one driver's lap, and
> that is all this data can honestly show for a race.

> **C-TEL-6** — under the corner card
> Corner numbering and corner positions come from the timing provider's circuit map, not from
> the track's own signage. A blank braking point means the corner was taken flat, not that
> the data is missing. Corners taken in one braking event are bracketed together.

> **C-TEL-7** — in the channel stack, where DRS would be
> No DRS signal in this session's data. That is a gap in what was recorded, not a lap where
> nobody opened it.

> **C-TEL-8** — under the summary strip, wherever `overlap_pct > 3`
> **{overlap_pct}%** of this lap reports full throttle and braking at the same time. The two
> channels are separate feeds merged onto one timeline, so this is how they were recorded and
> not how the car was driven. Don't read the throttle and brake shares to the tenth.

## 6.4 Enforcement, not just captions

An app that says the honest thing and then ships the dishonest control has said nothing. Each
claim above is bound to the code that makes it unbreakable:

| the claim | what enforces it | where |
|---|---|---|
| "aligned on distance, never on time" | there is **no** integrated-distance and no time-indexed column in the schema to reach for; `align.ts` takes chord arrays only | §2.1, §5.2.1 |
| "this trace may not be accurate enough to read" | the chart **computes its own closure error and refuses to render above 400 ms** | §5.2.2 |
| "no cross-driver comparison on a race lap" | `DeltaTrace` takes `sessionKind` and returns C-TEL-5 instead of a chart; the second pill is **not rendered** | §5.2, §5.5 |
| "nothing here is about a season" | every query signature takes **one** `session_id`; cross-session comparison has no callable shape | §5.5 |
| "one lap per driver, and no other" | `PRIMARY KEY` + `CHECK (selection IN ('fastest'))` — widening needs migration 0009 | §1.1 |
| "absent is not zero" | `drs_distance_m` is `NULL`, never 0; the DRS row is replaced by C-TEL-7 | §4.1, §5.3 |
| "the captions are verbatim" | `captions.ts` constants + a drift test | §6.3 |
| "the colours don't mean what they mean elsewhere" | `--ramp-*` tokens, documented as magnitude-only; the semantic trio is absent from the feature | §5.0 |

## 6.5 Two channel quirks preserved rather than tidied

- **`throttle_pct` reaches 104.** Stored and plotted as delivered, axis to 105, dotted rule at
  100. Clamping would silently invent a value the sensor did not report and would change every
  derived share.
- **`drs` is an integer code, not a boolean.** Stored raw. The UI maps known codes to
  open/closed and renders unknown codes as **unknown**, because the code set is undocumented
  and guessing at it is how a chart becomes confidently wrong.

## 6.6 The sentence added to `web/lib/ask/prompt.ts`

> Telemetry exists for exactly one lap per driver per session — that driver's fastest — and
> for no other lap. Questions about how a trace changed over a stint, a race or a season
> cannot be answered from `lap_telemetry_summary` or `corner_speeds`; say so rather than
> answering from the single stored lap.

---

# §7 Work packages

## 7.0 File ownership — every file has exactly one owner, for the whole release

No file appears under two owners. A package that believes it needs a file owned by another
raises a spec change; it does not patch across the line.

| WP | Owns (exclusively) | Depends on |
|---|---|---|
| **WP-1 Schema** | `web/db/schema/telemetry.ts`, `web/db/schema/index.ts`, `web/drizzle/0008_telemetry.sql` + `meta/0008_snapshot.json` + `meta/_journal.json`, `f1lab/db.py` | — |
| **WP-2 Frames** | `f1lab/frames.py` (5 `TABLE_COLUMNS` entries + 3 array casters + `_py` ndarray branch) | WP-1 |
| **WP-3 Fetch** | `f1lab/clean.py` (**add** `load_telemetry`, touch nothing else), `scripts/warm_telemetry.py`, `docs/RUNBOOK.md` | — |
| **WP-4 Derive** | `f1lab/telemetry.py` — chord distance, the summary, the corner metrics, `source_hash`, `rewrite_after_force` | WP-2, WP-3 |
| **WP-5 Ingest hook** | `f1lab/ingest.py` (the **three lines** of §2.8 and nothing else) | WP-4 |
| **WP-6 Ask** | `scripts/ask_manifest.yml`, the 3 regenerated artifacts, `scripts/sql/ask_views_telemetry.sql`, `web/lib/ask/prompt.ts`, `tests/test_ask_schema_sync.py`, `web/lib/ask/validate.test.ts` | WP-1 |
| **WP-7 Tests** | `tests/test_telemetry_optional.py`, `tests/test_clean_no_telemetry.py`, `tests/test_force_keeps_telemetry.py`, `tests/test_telemetry_arrays.py`, **the one edit to `tests/test_ingest_hungary.py`** | WP-4, WP-5 |
| **WP-8 Charts A** | `web/lib/queries/telemetry.ts`, `web/lib/telemetry/align.ts`, `web/components/charts/EChart.tsx` (**`VisualMapComponent` only**), `web/components/charts/TrackMap.tsx` | WP-1 |
| **WP-9 Charts B** | `web/components/charts/DeltaTrace.tsx`, `web/components/charts/ChannelStack.tsx`, `web/components/charts/CornerCard.tsx` | WP-8 |
| **WP-10 Page** | `web/app/race/[year]/[round]/telemetry/page.tsx`, `web/lib/telemetry/captions.ts` + `captions.test.ts`, `web/app/globals.css` (**the `--ramp-*` tokens only**) | WP-8, WP-9 |
| **WP-11 Docs** | `docs/TELEMETRY_SPEC.md` §10, `docs/SPEC.md` §8 | all |

`scripts/warm_cache.py`, `scripts/warm_resume.sh` and `f1lab/season.py` are **not modified by
anyone**; telemetry has its own warmer (§3.3). `web/scripts/check-invariants.mjs` is the
import-boundary linter and holds **no object count** — it is not edited.

## 7.1 Sequencing and per-package verification

Verification is stated as a **falsifiable test**, not an intention. The next package does not
start until its predecessor's line is true.

| # | WP | must be true before the next package starts |
|---|---|---|
| 1 | WP-1 | `npx drizzle-kit generate` produces `0008_telemetry.sql` + snapshot + journal entry 8; `make migrate` applies it to a dump of the live DB; `db.assert_schema()` passes; **every existing test still passes with zero telemetry rows** |
| 2 | WP-2 | `cast_frame` round-trips a 626-sample lap and **`type(cell) is list and type(cell[0]) is float`**; a deliberately ragged frame is rejected by `lap_telemetry_lengths_check`, not by `copy_frame` |
| 3 | WP-3 | `warm_telemetry.py --budget 8` warms exactly 2 sessions, charges 8 calls, and **a second run charges 0**; with a fake call log of 460 in the trailing hour it **exits 0 printing a UTC time and downloads nothing**; below 15 GB free it refuses; `load_race`/`load_quali` still assert `telemetry=False` |
| 4 | WP-4 | On 2026 R13 Q: chord lap-length spread **≤ 20 m** across the top 6; sector-boundary delta residual **≤ 150 ms** on all 15 pairs; corner count **= 11**; T1+T2 and T8+T9+T10 share a `brake_zone_idx`; `drs_distance_m IS NULL` for all 22; ingest the session twice → identical row counts and identical `source_hash` |
| 5 | WP-5 | `ingest --force` on a telemetried session leaves the same telemetry row count when the cache is present, and writes `state: "dropped"` when it is not; **patching `get_telemetry` to raise leaves `session_ingests.status = 'ok'`** |
| 6 | WP-6 | `make db-ask-gen` regenerates byte-identically; `gen_ask_schema.py` emits **64** objects and `partition_tables()` does not `SystemExit`; `SELECT * FROM ask.lap_telemetry` → **permission denied**; `pytest tests/test_ask_schema_sync.py` and `npm test -- validate.test.ts` green; `ask_answer_cache` empty after deploy |
| 7 | WP-7 | `make test` green; `test_telemetry_optional.py` runs the page-query smoke set at zero telemetry rows and matches v1.6 output exactly |
| 8 | WP-8 | `align.ts` reproduces WP-4's Python closure numbers to **< 1 ms** on a checked-in golden JSON fixture; track map of 2026 R13 at 400 px and 1400 px wide has measured metres-per-pixel equal on both axes to **< 1%**; rotation 95° applied; **`VisualMapComponent` registered and the ribbon actually paints** |
| 9 | WP-9 | a ≤ 150 ms pair renders clean; a synthetic **500 ms-closure pair refuses to render**; a teammate pair is solid + dashed; `sessionKind: 'R'` returns C-TEL-5 and no chart; the y-axis is symmetric about 0 |
| 10 | WP-10 | all eight captions present with the measured numbers substituted and `captions.test.ts` green; the page renders for a `"none"` session with **no chart frame**; no `--color-fastest/personal/slower` appears in any telemetry file (grep, in CI) |
| 11 | WP-11 | `RUNBOOK.md` states the **~11 GB** cache growth and the **15 GB free-space precondition** *before* the warm step, not after |

## 7.2 Parallelism

After WP-1 lands (the one blocking package), **WP-2/4/5 (Python), WP-6 (manifest + SQL) and
WP-8 (TypeScript)** proceed in parallel across three languages with disjoint file sets. WP-9
and WP-10 serialise behind WP-8 only because they consume `align.ts` and the query module.
WP-3 has no dependency on WP-1 at all and can start immediately — **and should, because it is
the only package whose critical path is wall-clock download time.**

---

# §8 Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **The delta trace ships aligned on FastF1 `Distance`.** It is the obvious column, it is *named* `Distance`, it is what the brief itself said to align on — and it is wrong by **1.39 s** where this data is worst, while the chart still looks entirely plausible. The near-miss variant is normalising to `RelativeDistance`, which closes perfectly at the flag and is wrong by **±450–570 ms** in the middle, where a fan reads it as meaning. | T5 is a fixed decision enforced by absence: `lap_telemetry` has **no** integrated-distance column and `RelativeDistance` is not stored. `align.ts` accepts chord arrays only. WP-8's golden fixture and WP-9's 400 ms refusal both fail loudly if anyone reintroduces either. The closure check runs at the **sector boundaries** as well as the flag, which is the only version of it that can see this class of error. |
| **R2** | **`numpy.ndarray` reaches psycopg and `db.copy_frame` dies mid-ingest** — after the download, deep in the write, with an unadaptable-type error rather than a schema error. `frames.cast_frame` falls through to `astype(object)` for an unknown kind and `_py` has no ndarray branch. | The three new casters call `.tolist()`; WP-2's `type(cell) is list` assertion is a **gate**, not a nice-to-have; `lap_telemetry_lengths_check` catches a ragged write at the database boundary. |
| **R3** | **The warm runs out of disk at ~11 GB**, leaving **truncated `.ff1pkl` files that FastF1 reads back as corrupt** — the ops failure most likely to cost a day, because it presents as unexplained parse errors on sessions that "already downloaded". | Hard precondition: `warm_telemetry.py` **refuses to start below 15 GB free** and prints the shortfall. Its idempotency check unpickles each artifact and **deletes and refetches a truncated one**. The RUNBOOK carries the 11 GB figure before the step. The `--kinds Q SQ` ladder ships the headline feature in ~5 GB. |
| **R4** | **The 500 calls/hour ceiling is hit mid-warm** and the run dies at session 130 of 160 — or, worse, an automated retry sleeps an hour in silence and the agent driving it is killed. | 300/hour token bucket at a conservative 4 calls per session; `--budget N` with a printed resume command; **refuse-and-print-a-UTC-time rather than sleep** when the trailing-hour log exceeds 450; filesystem-based idempotency so a restart charges 0 for everything already on disk; Q/SQ ordered first so an interruption leaves a coherent product. `warm_resume.sh`'s hour-long blind sleep is **not** on the telemetry path. |
| **R5** | **A telemetry failure demotes a healthy session.** 160 sessions are correct today; an unrelated FastF1 position-data outage that flipped them to `partial` would corrupt what `ask.session_health` and `ask.data_coverage` report about **lap-time** quality. | T8: telemetry writes `analytics_status['telemetry']` only, `status` is never downgraded from `'ok'`, exceptions go to `warnings[]`. The release's acceptance criterion is the deliberately-broken-`get_telemetry` test (§7.1 WP-5). The pass is a separate entry point; `ingest.py` changes by three lines and `clean.py`'s `telemetry=False` is pinned by a test. |
| **R6** | **A fan reads the delta trace as a driver ranking.** This is the product risk and it is larger than the five technical ones: the chart is beautiful, it is about two named people, and it invites exactly the conclusion it cannot support. | C-TEL-1 is unconditional and sits **above** the chart; the picker **defaults to teammates**; C-TEL-4 fires the moment a non-teammate pair is chosen and routes the question to the was-it-the-car page; the cross-driver delta **does not exist** on race sessions; the closure caption prints the chart's own error in milliseconds so its resolution is never implied to be infinite; the y-axis is symmetric so the chart cannot exaggerate itself. |

**Deliberately not shipped in v1.7**, recorded so each absence is not mistaken for an
oversight — and each is **free of API calls when it ships**, because the cache is kept (§3.5):
stint-representative race laps, traffic and DRS-train analysis, a time-loss decomposition
model, an optimal-composite lap, elevation (`Z`), `RPM`, and any cross-session telemetry
aggregate.

---

# §9 Decisions log

One line each. Where the three proposals disagreed, the disagreement and its resolution.

| # | Decision | Why |
|---|---|---|
| D1 | Base the spec on the **visual-first** proposal. | Two of three judges picked it, including the storage-and-operations judge under its own lens; its warm plan is the only genuinely interruptible one and its alignment finding decides whether the flagship visual is true. |
| D2 | **Chord distance**, not FastF1 `Distance`, not `RelativeDistance`. | Measured independently twice: `Distance` spreads 114.7 m / 141.0 m across laps of one circuit against 9.5–12.7 m for chord. `RelativeDistance` closes at the flag and is wrong by ±450–570 ms in the interior. |
| D3 | Migration **0008**, generated by **Drizzle** from `web/db/schema/telemetry.ts` with an `index.ts` export. | `0007_quali_verified.sql` already exists as journal entry 7; `scripts/sql/` is a separate chain that `make migrate` does not run, so the winner's placement would never have been applied. |
| D4 | **Arrays**, at a measured **3.5×** advantage — not the 9× or 2.8× claimed. | The 9× paired all-`float8` rows against a resampled grid; 2.8× came from `pg_column_size` against an unmeasured row comparator. 315 MB vs 89 MB at 5,324 laps is the like-for-like number. |
| D5 | `lap_telemetry` **excluded** from the ask box for a **measured** reason, not a preference. | The planner prices `unnest` at 10 rows: 53,240 estimated against 3,332,582 actual, cost 1,827 against a 5,000,000 guard. Recorded in `exclude_tables` so a future release cannot re-litigate it from taste. |
| D6 | Session set **160**, not 178: kind `S` is excluded. | Kind `S` has 0 laps (verified). 18 sessions of download producing zero rows. |
| D7 | **Native samples**, not a 10 m grid. | The grid is the same size and measurably worse (4.15 km/h RMS, 3.46 m map deviation), and its index-alignment property is an illusion — 574–601 elements, 9 distinct lengths, within one session. |
| D8 | Failure state goes in the existing **`analytics_status jsonb`**, not a new `telemetry_status` column. | It keeps migration 0008 purely additive (no `ALTER`, no `frames.TABLE_COLUMNS` edit to `session_ingests`, no regeneration of `ask.session_health`'s shape) and it is the mechanism the codebase already has for exactly this. |
| D9 | `ingest --force` **re-derives telemetry from the cache** (three lines in `ingest.py`), rather than `ingest.py` being untouched. | The winner put `lap_telemetry` in `SESSION_CHILD_TABLES` *and* left `ingest.py` unmodified, so every `--force` would silently wipe the telemetry layer with no path that rewrites it. Three guarded lines are cheaper than that defect. |
| D10 | **No cross-driver delta on race sessions** — an absent control, not a captioned one. | An absent feature with a stated reason is a stronger guard than a footer; race laps still earn their download through the map, the stack and the corner card. |
| D11 | **Round channel values before COPY.** | Measured: a rounded 593-element `real[]` is 1,788 B against 2,392 B uncompressed — pglz compresses 25%. Unrounded float32 does not compress at all. Rounding is the lever, not the codec. |
| D12 | `--force` **re-derives from cache at zero API calls**; re-downloading is a separate manual act. | Keeps the iteration loop entirely off the network, which at 45–100 MB and 2–4 calls per session is the difference between a five-minute and a three-hour edit cycle. |
| D13 | Warmer **refuses to start and prints a UTC time** when the trailing-hour log exceeds 450 calls; it never sleeps. | An hour of silence is how agents die on this project; `warm_resume.sh`'s blind sleep stays off the telemetry path. Combined with the winner's token bucket and `--budget`. |
| D14 | Free-space **precondition of 15 GB**, not 4 GB. | The 4 GB threshold was calibrated to a cache estimate that measured only the HTTP sqlite file and was ~6× low. The real figure is ~11 GB, measured from the `.ff1pkl` artifacts. |
| D15 | `lift_pct` is **measured**, never `100 − ft − brake`; `overlap_pct` is stored. | 5.5% of the lap genuinely reports both at native resolution. Forcing the sum to 100 would hide a real property of the feed. |
| D16 | `drs_distance_m` is **NULL**, never 0, when the channel is flat; no visual is built on DRS. | DRS was 0 for every sample of every lap in the sample sessions. "Absent" and "measured zero" are different claims. |
| D17 | `corner_letter` is **`NOT NULL DEFAULT ''`** inside its primary key. | PK columns are implicitly `NOT NULL` in Postgres; declaring it nullable makes every letterless corner — the majority — un-insertable. |
| D18 | `EChart.tsx` **is** modified, once, to register `VisualMapComponent`. | Verified absent from the `echarts.use` list. In a tree-shaken build an unregistered component is silently ignored, so the flagship map would have shipped unpainted. |
| D19 | Route is `web/app/race/[year]/[round]/telemetry/page.tsx`. | There is no `[sessionId]` segment anywhere under `web/app`. |
| D20 | Pinned ask counts move in **three** places (`N_OBJECTS` 61→64, `N_TABLE_VIEWS` 57→60, `ASK_OBJECTS.size` 61→64). | `check-invariants.mjs` is the import-boundary linter and holds no count; moving only `N_OBJECTS` leaves two red tests. |
| D21 | Closure thresholds stay **absolute** (150 / 400 ms) for rendering, with a **relative** caption rule on top. | A relative-only gate would refuse legitimate charts on small gaps; an absolute-only gate would draw a 399 ms error onto a 180 ms gap and look clean. The caption carries the relative warning. |
| D22 | No fuel correction, no time-loss model, no optimal composite. | Applying a model to a 10 Hz trace would dress an assumption up as a measurement; the app's model-shaped answers live in Mode 2 with their uncertainty printed. |
| D23 | Captions are pinned `const`s in `captions.ts` with a drift test. | "Verbatim" that is not mechanically enforced is aspirational. |

### v1.8 amendment decisions (D39–D46)

Sourced from `GAPFILL_SPEC §8`; the DL number is given so the two logs can be reconciled.

| # | Decision | Why | DL |
|---|---|---|---|
| D39 | **Ship the release metre; refuse the rating.** | Not in tension: one is a reading of one lap, the other a claim about a driver. The reading comes from a value `telemetry.py` already computed and discarded. | DL-14 |
| D40 | **Quantisation is not a validity floor** — written into §4.3 as SR-1. | The project nearly shipped on "15 m spread beats 5 m resolution, therefore rankable". Beating the instrument's floor licenses only that the instrument works; the floor is the driver's own repeat variance, measured at `r = 0.286`. | DL-24 |
| D41 | **`trail_duty` is stored as an unrendered diagnostic, not a shipped metric.** | Bounded by construction and survives shared-zone adversarial testing, but repeat `r = 0.198` and `corr(trail_duty, apex_speed_kph) = −0.595`. Enforced by column-level exclusion from the ask schema, not by a caption. | DL-18 |
| D42 | **Apex-anchored, not `slow_m`-anchored; the 43.6 % non-terminal discard is accepted.** | `slow_m` avoids the discard but needs a new table and a new unit, breaking the join every existing corner surface uses. Recorded as the named alternative for a future release (§4.4.6). | DL-20 |
| D43 | **The repeatability gate is pooled across every available paired weekend, never run on one.** | Three weekends at ~20 drivers give SE ≈ 0.23 and cannot distinguish r = 0 from r = 0.3; the per-weekend values are +0.16, −0.21, +0.23. Pooling 13–14 weekends returns 0.268–0.311 stably. | DL-21 |
| D44 | **"Within-driver repeatability cannot be estimated from this database" is recorded as FALSE.** | 13–14 sprint weekends carry telemetry on both Q and SQ; that test is the one that decides whether the metric means anything, and it was run. | DL-23 |
| D45 | **The sampling figures are corrected in this file**: lap-wide `max_sample_gap_m` 54.78 m median / 89.72 p95 / 192.69 worst, not "~74 m" and not "73.7–85.7 m"; in-zone 4.94 m median. | The brief understated the lap-wide gap and overstated the in-zone one. **The in-zone p95 is left DISPUTED** (§2.1: 8.33 m stated against 15.37 m re-measured over 154,920 braked steps) rather than resolved by preference. | DL-25 |
| D46 | **The v1.8 additions are amendments, not rewrites; every corrected v1.7 number is left visible beside its replacement.** | A spec whose corrections are invisible teaches its readers to trust it exactly as much as a spec that was never wrong, which is the wrong amount. | — |

---

# §10 As built

*Written by WP-11 at integration, 2026-09-16. Every number below was measured on this
machine against the live database and the warm cache; nothing here is copied forward from an
earlier section as an intention.*

## 10.1 What shipped

Eleven packages, 5,085 lines across the files §7.0 names, plus the two `output/verify_wp*.ts`
harnesses. All twelve fixed decisions T1–T12 shipped as written; none was relitigated.

| Layer | File | Lines | State |
|---|---|---|---|
| Schema | `web/db/schema/telemetry.ts`, `web/drizzle/0008_telemetry.sql` | 100 (SQL) | applied; `drizzle.__drizzle_migrations` = **9** rows (0000–0008), public base tables 67 → **72** |
| Casters | `f1lab/frames.py` | +111 | 5 `TABLE_COLUMNS` entries, 3 array casters, the `_py` ndarray branch |
| Fetch | `scripts/warm_telemetry.py`, `clean.load_telemetry` | 426 | all 78 lap-bearing Q/SQ sessions warmed, 0 failures |
| Derive | `f1lab/telemetry.py` | 1,047 | chord distance, summary, corner card, `source_hash`, `rewrite_after_force`, CLI |
| Ingest hook | `f1lab/ingest.py` | +16 | inside a SAVEPOINT; see §10.3 D9′ |
| Ask | `scripts/ask_manifest.yml` + 3 artifacts + `ask_views_telemetry.sql` | — | schema `ask` = **64** views, `ask.lap_telemetry` and `ask.circuit_layout` do not exist |
| Align | `web/lib/telemetry/align.ts` + `align.golden.json` | 351 | branded `ChordDistanceM`; a real `Distance` array is rejected at the type boundary |
| Charts | `TrackMap` / `DeltaTrace` / `ChannelStack` / `CornerCard` | 1,570 | `VisualMapComponent` registered; ribbon measured at 3,439 distinct fills |
| Page + captions | `telemetry/page.tsx`, `captions.ts` (+ test) | 675 | all eight §6.3 captions pinned; `captions.test.ts` now runs under `npm test` |
| Optionality | `tests/test_telemetry_optional.py` | 469 | 7 tests; the release's acceptance criterion, §10.2 |

**Final row counts** (2026 R13 Q + R, and 2024 R13 Q derived by the ingest hook during
integration): `lap_telemetry` **63**, `lap_telemetry_summary` **63**, `lap_corner_speeds`
**793**, `circuit_corners` **27**, `circuit_layout` **2**. Total on-disk size of the five
tables: **2,392 kB**. Cache: **1.1 GB → 4.6 GB**, 78 `car_data.ff1pkl` artifacts; 262 GB free
after. The ratio the RUNBOOK warns about is real and larger than stated for the Q/SQ half:
**3.5 GB of cache for 2.4 MB of database**.

**`session_ingests`: 151 of 158 `ok`, unchanged from before the release.** T8 held — no
session was demoted by any telemetry outcome, including the deliberately-broken ones. The
status/state census at close is `ok`/`ok` × 3 and `ok`/`dropped` × 1.


## 10.2 The optionality guarantee — how it was actually proved

§2.7 promised `tests/test_telemetry_optional.py`. It shipped with **two halves, both
falsifiable**, because either alone is weak.

**Static (4 tests)** — the guarantee's *mechanism*: no pre-0008 migration, none of the ten
v1.6 page-query modules, and none of `frames.RACE_TABLE_ORDER` / `QUALI_TABLE_ORDER` /
`SPRINT_TABLE_ORDER` names any of the five tables. These fail the instant someone joins a
telemetry table into an existing page, which is the change that would break the guarantee.

**Dynamic (3 tests)** — the guarantee's *effect*. **Fifty** v1.6 page queries (the race page's
eighteen, qualifying's seven, season/home/preview's nine, driver and Mode 2's sixteen) are
executed against the live database twice: once as it stands, once with **every row of all five
telemetry tables deleted**. Each result is canonicalised (keys sorted, `Date`/`NaN`/`undefined`
stringified) and SHA-256'd. All fifty digests matched, key for key. The deletion is committed
(the queries run in a separate Node process), taken from `CREATE TABLE … AS TABLE` backups and
restored in a `finally`; fidelity is checked with `md5(row::text)` per table, not a row count,
and `_restore_orphans()` cleans up after a kill mid-test.

Three checks make it non-vacuous, and each was run:

1. **Negative control, in the file.** Perturbing one integer a v1.6 page reads
   (`sessions.total_laps += 1`) changes the digest set, and undoing it restores it. A digest
   set that cannot see a real change proves nothing.
2. **Falsification of the claim itself, run by hand at integration.** A probe that *does* read
   telemetry (`listTelemetryLaps(16041)`) through the same canon-and-digest path goes
   `ba3ebade…:6235` → `17a20413…:7322` across the same delete. The mechanism detects exactly
   the class of regression §2.7 exists to forbid; the fifty v1.6 queries simply do not trip it.
3. **Vacuity guards.** Both dynamic tests refuse to pass against an already-empty telemetry
   layer, naming the command that fixes it.

**The guarantee held — but it was not free, and §2.7 was incomplete.** See §10.3 D24.

## 10.3 What changed from this spec, and why

Every deviation reported by a package, plus the three integration found. **Nothing here is a
package's preference; each is a measurement or a defect in this document.**

### Defects in this spec, found by measurement

| # | Section | What the spec says | What is true | Resolution |
|---|---|---|---|---|
| **D24** | **§2.7** | "a database without telemetry serves every existing page", asserted by the optionality test | **True of every query and false of one page.** §3.6/D8 puts the telemetry state in `analytics_status` as an **object**; `AssumptionsView.analyticsStatus` is typed `Record<string, string>` and `AssumptionsPanel` renders every non-`"ok"` entry as the React child `{k}: {v}`. Measured on `/race/2026/13`: *"Objects are not valid as a React child (found: object with keys {state, layout, corners, drivers, eligible, rows_corner_speeds})"* — the **whole v1.6 race page** to its error boundary, for every session the pass has touched. A query-level digest is structurally blind to this: `analytics_status` lives on `session_ingests`, which the telemetry rows' presence does not change. | **Fixed at the query boundary**, where the type claim is made: `flattenAnalyticsStatus()` in `lib/queries/race.ts` collapses an object to its `state`, appending `reason`. Pinned by `test_every_analytics_status_value_reaching_the_v16_contract_is_a_string`, falsified by reverting the fix. **§2.7 should say the guarantee covers rendering, not only queries.** |
| **D25** | **§2.7** | `test_ingest_hungary.py` is "the only change to an existing test file in the release" | **False, twice.** `tests/test_frames.py::test_expected_columns_cover_every_table_of_spec` hard-codes a literal table set and fails on WP-2's five new `TABLE_COLUMNS` entries; §7.0 gives that file no owner. And `test_ingest_hungary::test_every_table_populated` fails on **`quali_results`**, not on a telemetry table — a **pre-existing v1.6 defect** surfaced by running that file for the first time since v1.6: QUALI_SPEC's three session-keyed tables are keyed to the Q/SQ session, and `two_runs` ingests the **race** session only, so all three are zero by construction. | Integration appended the five names to `test_frames.py` with the QUALI_SPEC precedent comment, and excluded the three qualifying tables in `test_ingest_hungary.py` with their reason plus an explicit `test_qualifying_tables_belong_to_the_quali_session`. **Two** existing test files changed, not one. A *second* pre-existing v1.6 failure sat behind the first in the same test and only became reachable once it was fixed: `assert cur.fetchone() == ("ok", 1, 1, 0)` on `ingest_runs` hard-codes one attempted session, but v1.6 gave every round a Q session, so `--round 13` legitimately attempts **two** (2024 R13 is session_id 16 and 15917). Now derived from `sessions` rather than a literal, so the next new session kind does not break it again. **The lesson is worth recording: `tests/test_ingest_hungary.py` had evidently not been run since v1.6 landed**, and three packages in a row skipped it under the known-slow rule. A test that is never run is not a test. |
| **D26** | **§5.6 / §5.5** | the tab is "not rendered at all" when the state is absent | Correct, and the page implements it as `notFound()` — but nothing said what the **race page's section nav** should do. An unconditional tab link advertises a 404 on **158 of the 160** lap-bearing sessions. | `roundHasTelemetryTab(year, round)` in `lib/queries/race.ts`, in the page's existing `Promise.all` so it costs no extra round trip; the nav entry exists only when some session of the round carries the `telemetry` key. Verified: present on 2026 R13 and 2024 R13, absent on 2026 R12. |
| **D27** | **§7.1 WP-4** | sector-boundary delta residual "≤ 150 ms on all 15 pairs" | **Not true of this data under any pair-residual definition WP-4 could construct.** Worst 312.6 ms; 11/15 pairs clean; none above 400 ms. WP-4 measured the cause (`s1_distance_m` spans 16.3 m across the top 6 against an 8.74 m whole-lap spread — §6.2's chord-under-reads-arc bias at the Rettifilo and Curva Grande) and **disproved** the competing explanation (per-lap origin jitter: 0.0 m offset for 17 of 22 laps, registering by it leaves 312.6 ms unchanged). On the same 30 residuals, chord's max is 312.6 ms against `RelativeDistance` 701.6 ms and FastF1 `Distance` 1,374.8 ms. | **Not patched — the clause needs a spec change and the decision is the spec owner's.** Recommended wording: *"≤ 150 ms on the majority of pairs and 0 pairs above 400 ms"*, or scoped to the three teammate/adjacent pairs §1.4 actually measured (17.5 / 16.3 / 1.0 ms — the 8–98 ms family). The check still discriminates the normalisation pathology it exists to catch, which is its purpose. |
| **D28** | **§4.1** | `full_throttle_pct` rule column reads "throttle ≥ 99 **AND NOT brake**" | Self-contradictory: under that reading the four states partition the lap and the shares sum to exactly 100, which makes the section's own *"they must not be forced to 100"* impossible and contradicts its measured row (83.9 + 12.6 + 9.0 = 105.5). | WP-4 implemented throttle alone — what *"each measured independently"* says two paragraphs later — and reproduces the measured 83.9% to 0.1. **§4.1's rule column needs "AND NOT brake" struck.** Two further §4.1 illustrative numbers do not reproduce and could not be reverse-engineered: `brake_pct` 10.15 vs 12.6 and `overlap_pct` 3.20 vs 5.5 (the difference is confined to the throttle-AND-brake state), and `n_gaps_over_50m` 2 vs "~15". Everything else in that column reproduces exactly. |
| **D29** | **§5.2.3** | y-axis name `<- {codeB} ahead        {codeA} ahead ->` | **Backwards, measured.** ECharts rotates a `nameLocation:'middle'` y-axis name with transform `matrix(0,-1,1,0,16,195)` — `b = -1` puts the **end** of the string at the **top**, and the top of this axis is `delta > 0`, i.e. A is **behind**. The literal string labels A as ahead exactly where B is, and contradicts §5.2.3's own fill rule three bullets later. | WP-9 kept the format and transposed the codes. **§5.2.3 needs the two codes swapped.** |
| **D30** | **§4.2** | T1+T2 share a brake application "at 778 m", T8+T9+T10 "at 3930 m" | The *sharing* property holds (the §7.1 gate passes) but the absolute onsets are 786.9 m and 3809.5 m — 8 m and 120 m out, suggesting a different reference lap or brake-edge rule. | No caption quotes 778/3930; every number in a shipped string comes from the row being rendered. Flagged so a future release does not treat them as reproducible. |
| **D31** | **§5.0 / D18** | an unregistered `VisualMapComponent` means "the flagship map would have shipped unpainted" | **Measured false** in ECharts 5.6.0 by rendering the identical option in a fresh process without it: 209 of the same 211 distinct fills still apply. What silently disappears is the ramp **legend** — 11 text nodes vs 0. | The edit is still required and the failure is still silent. The *reason* is wrong: it ships a map with no **key**, not a map with no **paint**. |
| **D32** | **§2.5** | "the migration creates three indexes" | The normative SQL in §2.1 names **two**, and that is what 0008 creates. | WP-1 implemented the normative SQL. If a third was intended it is missing from §2.1 and needs a spec change. |

### Deliberate deviations from the letter of the spec

| # | Section | Deviation | Why |
|---|---|---|---|
| **D9′** | **§2.8** | The ingest hook is **not** "three lines inside a try/except that can never raise". It is one import plus a 15-line block (7 of them comment) running between `SAVEPOINT telemetry_hook` / `RELEASE SAVEPOINT`, with a `TransactionStatus.INERROR` check. | **A try/except is not sufficient and WP-5 measured why.** `rewrite_after_force` already swallows every Python exception, but a *psycopg* error raised inside it (a constraint violation during the telemetry COPY, a deadlock, a disk-full write) leaves the enclosing transaction **aborted**, and ingest's own `session_ingests` upsert two lines later then raises `InFailedSqlTransaction` — the session rolls back and `record_failure` stores `status='failed'`. That is precisely the R5 demotion §3.6 exists to prevent. Measured directly: a swallowed `SELECT 1/0` makes the next statement on that connection raise. With `derive_session` patched to poison the transaction, `write_session` now returns `ok`, stores `status='ok'` with `telemetry.state='dropped'`, and still writes all 307 laps. **Ratified at integration.** Keeping the literal three lines would make §3.6's "never downgraded from ok" false for every database-level telemetry failure. |
| **D33** | **§1.2 / T3** | The warm set is **140 lap-bearing sessions today, not 160**, and the session list is read from Postgres rather than from a static count. | T3's 160 is the design target; the live corpus is what can actually be warmed. Reading it from the database is the only way the warmer cannot drift from the corpus. |
| **D34** | **§2.6** | The ask view is `ask.lap_corner_speeds`, not §2.6's `CREATE VIEW ask.corner_speeds`. | §2.6 also pins `N_TABLE_VIEWS` 57 → **60**, which requires all three views to be table-backed, and `gen_ask_schema.py::view_sql()` names a table-backed view after its table with no rename hook (and that file has no owner in §7.0). A curated view named `corner_speeds` gives 59 table views and contradicts the pinned 60. **If `corner_speeds` was the intended name, §2.6's counts need a spec change, not a patch.** |
| **D35** | **§7.0** | Three files exist that the ownership table does not name: `web/lib/telemetry/align.golden.json` (WP-8's §7.1 row requires it), `output/verify_wp8.ts` and `output/verify_wp9.ts` (those rows are falsifiable checks with no home). | Recorded rather than hidden. §7.0 should name them, or `package.json`'s test glob should cover the components — see §10.5. |
| **D36** | **§4.1 / §4.2** | `corner_letter` cannot be written through the shared frames pipeline. `frames._is_null` treats `''` as NULL and is applied twice, so the `NOT NULL DEFAULT ''` PK column (D17) never reaches COPY. | WP-4 worked around it inside its own file (`frames.cast_frame`, then `db.copy_rows` with that cell restored). The tidy fix is a `text-notnull` kind in `frames.TABLE_COLUMNS`; that is WP-2's file and the workaround is contained. |
| **D37** | **§5.1** | The map → chart half of the two-way hover link publishes the hovered chord distance from inside the tooltip `formatter`, deferred with `queueMicrotask`. | `EChart.tsx` exposes no event hook and §5.0 permits exactly one edit to it (`VisualMapComponent`). It works and is documented in the file, but it is a side effect in a formatter, not an event subscription. Adding an `onEvents` prop is a spec change. |
| **D38** | **§5.5** | `?a=` / `?b=` / `?kind=` are bound to the URL; **`?ch=` is carried but not bound**, and the hovered distance is not in the URL at all. | `TrackMap`'s `channel` prop is controlled-only (passing it without `onChannelChange` freezes the selector) and both `TrackMap.tsx` and `EChart.tsx` are WP-8's. Binding it needs an `initialChannel` prop or a client wrapper — a file neither §7.0 nor any brief names. **Outstanding.** |

### One ownership breach, recorded rather than smoothed over

§7.0 gives WP-9 exclusive ownership of `DeltaTrace.tsx`, `ChannelStack.tsx` and
`CornerCard.tsx`. WP-10 wrote `CornerCard.tsx` and (almost certainly) `ChannelStack.tsx` so
its page would compile, while WP-9 was running in parallel; WP-9 then created its own
`ChannelStack.tsx` with a shell `>` redirect before knowing this, and **any prior content is
gone** — there is no git repo here to recover it from. WP-9 kept WP-10's `CornerCard.tsx`
unmodified after reviewing all 225 lines against §5.4 and verifying its grouping against real
rows. Integration confirmed the final trio against the page: typecheck, lint, `npm test`
(199/199) and a live browser render are all green, and all three sections mount with real
data. The breach cost nothing measurable, but it should read as a breach, not as WP-9's file
layout. **The root cause is that two briefs assigned the same three files**; §7.0 was right
and the brief was wrong.

## 10.4 The real warm and the real timings

| Measurement | Value |
|---|---|
| Sessions warmed | **78 Q/SQ, 0 failures** — 69 in one 373 s run plus 9 already present |
| Cache growth | 1.1 GB → **4.6 GB** (the spec predicted "~5 GB for the Q/SQ ladder") |
| Per session | 30–125 MB, 4.2–7.5 s, **exactly 2 API calls** |
| Rate limiting | the run stopped itself as R4/D13 designs: `300 calls in the trailing hour, budget 300/h. Stopping, not sleeping. May proceed at 2026-09-17T01:05:36Z` |
| Idempotency | a second run over the same scope charged **0** (`warmed=0 skipped=2 calls=0`) |
| Truncation recovery | a 3 MB truncation of a real 50 MB `car_data.ff1pkl` was caught as `UnpicklingError: pickle data was truncated`, both artifacts deleted, state fell back to `missing` |
| Derive pass | 2026 R13 Q (22 drivers) and R (21) from cache at **zero API calls**; 2024 R13 Q derived by the **ingest hook** during integration, which is the D9′ path working on a real `ingest` |
| Idempotency of derive | three separate `--force` runs reproduced identical row counts (22/22/242) and an identical `source_hash` digest `0663819dffe2ca83e1f8e8907b11cac0`, with `ingested_at` moving each time |

**Still to warm: 59 race sessions and 3 Q/SQ (~6 GB, 248 charged calls).** One further sitting
finishes the set: `make warm-telemetry KINDS="Q SQ R"`. The headline feature is **complete
today**, because T10 gives race sessions no cross-driver delta in the first place.

## 10.5 Known-good, and what is still open

**Verified green at close** (integration, this machine): `npm run typecheck`, `npm run lint`,
`rm -rf .next && npm run build` (the `/race/[year]/[round]/telemetry` route is in the manifest),
`npm test` **199/199**, `pytest -q -m "not db"` **349 passed**,
`python -m f1lab.ingest --check-schema`, the ask deploy gate **32 passed / 0 failed** with the
64-view pins, `tests/ask/run_acceptance.py --check-only`, and
`tests/test_telemetry_optional.py` **7/7**.

**Browser pass, 2026 R13 (Monza), console clean on a fresh tab across three pages:** the
delta trace prints closure **10 ms** and sector **18 ms**; C-TEL-1 sits unconditionally above
it; C-TEL-4 fires on a non-teammate pair and links to `/season/2026/was-it-the-car`;
`?kind=R` shows **C-TEL-5, no delta chart and no Lap B control at all** (T10 as an absent
control); a round with no telemetry 404s per §5.6 and shows no chart frame; the track map
paints **3,439 distinct fills** and is recognisably Monza; and its element aspect ratio is
**1.8617 at 1400 px against 1.8609 at 400 px — 0.04% apart**, with no horizontal overflow at
400 px.

**Open, each with a named owner-shaped decision:**

1. **D27** — the §7.1 WP-4 sector clause is not true of this data. Needs a spec change.
2. **D28, D29, D32, D34** — four further spec sections need editing, not patching.
3. **D38** — `?ch=` is carried but not bound; needs a prop `TrackMap.tsx` does not have.
4. **`make ask-eval` was not run.** §9.4 asks for a re-score when `ASK_INSTRUCTIONS` moves,
   and it did. It needs `ANTHROPIC_API_KEY` and costs money; the twelve standing questions
   have **not** been re-scored against the new prefix `30477d19…`.
5. **The committed ask artifacts are not a pure function of the corpus, and this is the
   sharpest unowned defect the release found.** `teams.latest_name` means *last written*,
   not *chronologically latest*, so `web/lib/ask/schema-doc.txt` line 281 depends on the
   **order** sessions were ingested in. Measured three times during integration, oscillating:
   a force-ingest of 2026 R13 Q wrote `rb / Racing Bulls`; `test_ingest_hungary`'s ingest of
   2024 R13 wrote `rb / RB` back. `schema-doc.txt` feeds `PROMPT_PREFIX_SHA256`, so the pin
   in `prompt.ts` oscillates with it (`7472bb19…` ⇄ `30477d19…`), `pipeline.test.ts` and
   `tests/test_ask_schema_sync.py` go red, and `ask_answer_cache` must be emptied each time.
   It settles at whichever value the last ingest wrote — `7472bb19…` at close, with all 29
   sync tests and all 25 pipeline tests green. This is **not telemetry-specific and not new
   in v1.7**; v1.7 is simply the first release that force-ingested enough to expose it.
   **The fix belongs in `scripts/gen_ask_schema.py`** (derive the display name from the
   latest *season*, not from `latest_name`) **or in the `teams` upsert**, both unowned by
   §7.0, and it is a contract change rather than a patch. Documented meanwhile in
   RUNBOOK §3.14 with the four-command recovery.
6. **`make` is unusable on this machine** (unaccepted Xcode license), so every Makefile
   target added or corrected in this release was verified by running its recipe body
   directly, not by running `make`. Corrected: three stale `61` ask-view pins → **64**, and
   `db-ask-views` now applies `scripts/sql/ask_views_telemetry.sql`, without which the answer
   cache is never invalidated on a fresh machine. Added: `warm-telemetry`, `telemetry`,
   `telemetry-session`, `verify-telemetry`.
7. **An `[ECharts] Can't get DOM width or height` warning fires six times per page load.**
   It is **pre-existing** — measured identically on the v1.6 `/race/2026/13` — and is an
   init-before-layout artifact in `EChart.tsx`. Not a v1.7 regression and not fixed here,
   because §5.0 permits exactly one edit to that file.
8. **`package.json`'s `npm test` glob still excludes `components/charts/*`.** Integration
   extended it to `lib/telemetry/*.test.ts`, so `captions.test.ts` now runs (192 → 199
   tests). WP-8's and WP-9's checks still live only in `output/verify_wp*.ts` and run by hand.
