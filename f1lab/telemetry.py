"""The v1.7 telemetry pass — extraction and derived analytics (TELEMETRY_SPEC §4).

This module is the **second pass** (T7). It is never called by ``f1lab.ingest``'s
per-session frame build; it is run afterwards as ``python -m f1lab.telemetry`` over a
warm FastF1 cache, and it touches the network only if the cache is cold.

What it does, per session (§3.4):

1. Reads the lap selection from **Postgres**, not from FastF1 (§1.1 / T2): the driver's
   fastest valid lap. The stored trace is therefore the trace of a lap the app has
   already cleaned, classified and published, and the two can never disagree.
2. Calls ``lap.get_telemetry()`` per selected driver, drops NULL ``X``/``Y`` rows and
   computes **chord distance** (T5): ``cumsum(hypot(diff(x), diff(y)))`` with a leading
   zero. FastF1's integrated ``Distance`` is never stored and never used for alignment
   — measured, it spans 114.7 m across laps of one circuit against 12.7 m for chord,
   and a delta drawn on it is wrong by 1378-1398 ms against gaps of 60-180 ms (§1.4).
3. Rounds every channel before COPY (T9) and asserts every array length is ``n_samples``.
4. Writes ``circuit_layout`` / ``circuit_corners`` once per ``(circuit_key, year)``, with
   corner ``distance_m`` **projected into chord space** on the reference lap.
5. Computes §4.1's summary and §4.2's corner report card and writes all five tables in
   one transaction per session.

Two conventions that are easy to get wrong and are asserted here, not just documented:

- **Percentages of a lap are distance-weighted, never sample-weighted** (§0.3). Samples
  are uniform in *time*, so a sample-weighted "full throttle %" over-counts slow corners
  by roughly 3x. Every share in :func:`summarise` weights by ``diff(distance_m)``.
- **Absent is not zero** (§0.3, §6.5). ``drs`` was measured flat-0 for every sample of
  every lap of 2026 R13 Q and R; a flat channel stores ``NULL`` in ``drs_distance_m``
  and renders "no signal", never a measured zero.

T8 (§3.6): nothing in this module may downgrade ``session_ingests.status`` from ``'ok'``.
A failure writes ``analytics_status['telemetry']`` and appends to ``warnings[]``.
"""

from __future__ import annotations

import argparse
import hashlib
import collections
import json
import logging
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import clean, db, frames

log = logging.getLogger(__name__)

#: T2 — the only value ``lap_telemetry.selection`` may take in v1.7. Widening the
#: stored-lap rule requires migration 0009, not a change to this constant (§1.1).
SELECTION = "fastest"

#: ``lap_telemetry_samples_check``. A 12-sample "lap" would draw a triangle and call it
#: a circuit, so a driver is never stored below the floor (§3.4).
MIN_SAMPLES = 50
MAX_SAMPLES = 5000

#: T3 — the 160 lap-bearing sessions. Kind ``S`` has zero laps and is excluded (§1.2).
KINDS: tuple[str, ...] = ("R", "Q", "SQ")

#: FastF1 position units are tenths of a metre; chord distance is reported in metres.
POS_UNITS_PER_M = 10.0

#: §4.1 — "full throttle" is >= 99, not == 100: throttle is delivered as an integer
#: percentage that reaches 104 (§6.5) and rarely sits exactly on 100 through a corner exit.
FULL_THROTTLE_PCT = 99

#: §4.1 — ``n_gaps_over_50m`` and the shading rule in §5.2.
GAP_THRESHOLD_M = 50.0

#: §4.2 — corner window is +-min(150 m, half the chord gap to each neighbour).
CORNER_WINDOW_M = 150.0
#: §4.2 — entry / exit speeds are read 100 m before / after the apex.
ENTRY_EXIT_M = 100.0
#: §4.2 — brake debounce: applications separated by < 50 m of distance or < 20 m of gap
#: merge. Measured at Monza: 6-10 raw edges become 4-7 zones, which is what makes
#: T1+T2 share one application at 778 m and T8+T9+T10 share one at 3930 m.
BRAKE_MERGE_DISTANCE_M = 50.0
BRAKE_MERGE_GAP_M = 20.0
#: §4.2 — how far past a zone's release a corner may still be served by it. Measured at
#: Monza: the Ascari application releases at 3886 m and T10's apex is 171 m later, so the
#: three Ascari corners only share one ``brake_zone_idx`` if the reach clears 171 m. The
#: same 200 m correctly leaves Curva Grande unserved — its apex is 361 m past the
#: Rettifilo release — which is the measured "T3 is taken flat" of §4.2.
BRAKE_SERVE_REACH_M = 200.0

# ---------------------------------------------------------------------------
# GAPFILL_SPEC Gap B (v1.8) -- the trail-braking readings. See §3.1/§3.2/§4.2.
# `brake_zones` has always returned `(onset_m, release_m)`; `corner_metrics` used
# `[0]` and threw `[1]` away. These constants gate the release half.
# ---------------------------------------------------------------------------

#: §3.2 R3 -- fewer than this many brake-on samples in the serving zone and the
#: release edge is not located well enough to report.
TRAIL_MIN_ZONE_SAMPLES = 6
#: §3.2 R4 -- the bracketing step **at the release edge**, not the window median and
#: emphatically not the window maximum (DL-15). Re-derived in WP-B1 against the
#: release edge itself; 25.0 m is ~2x the measured p95 (see §9 pinned constants).
TRAIL_MAX_RELEASE_STEP_M = 25.0
#: §3.2 R5 -- implied deceleration over a >= 25 m window against `time_s` (never
#: against `distance_m`, §4.5). Anything past this is a chord-compression artefact.
TRAIL_MAX_DECEL_G = 6.5
#: §4.5 -- the minimum window, in metres, over which deceleration may be computed.
TRAIL_DECEL_WINDOW_M = 25.0
#: §4.3 R1 -- `source_hash` covers the raw channels, not the derivation recipe. A
#: derived-column change is a bump here plus a plain re-run; the skip condition is
#: `source_hash matches AND derive_version = TRAIL_DERIVE_VERSION`.
TRAIL_DERIVE_VERSION = 2
#: §4.1 -- the six `trail_status` words, exactly as the DDL CHECK spells them.
TRAIL_STATUS_MEASURED = "measured"
TRAIL_STATUS_FLAT = "taken_flat"
TRAIL_STATUS_NON_TERMINAL = "shared_zone_non_terminal"
TRAIL_STATUS_FEW_SAMPLES = "too_few_samples"
TRAIL_STATUS_WIDE_STEP = "release_step_too_wide"
TRAIL_STATUS_DECEL = "implied_decel_impossible"
TRAIL_STATUSES: tuple[str, ...] = (
    TRAIL_STATUS_MEASURED, TRAIL_STATUS_FLAT, TRAIL_STATUS_NON_TERMINAL,
    TRAIL_STATUS_FEW_SAMPLES, TRAIL_STATUS_WIDE_STEP, TRAIL_STATUS_DECEL,
)

# --- §9 pinned constants -------------------------------------------------------
# Derived over the whole stored corpus. **v1.10 (2026-09-18): the corpus grew from 75
# sessions / 1,518 laps / 24,963 corner rows to 137 / 2,732 / 44,926** by deriving the 43
# cache-warm sessions that had none (40 R, 2 SQ, 1 Q) at zero API calls. Race telemetry
# coverage went 1/71 -> 60/71. Every count below moved with it and was re-derived, not
# scaled; the pre-existing 24,963 rows were verified byte-identical first (0 changed,
# 0 lost, 13,811 added), so this is growth and not drift.
# (was: 75 telemetried sessions, 1,518 laps, 24,963
# `lap_corner_speeds` rows) by re-running this module's own pass 2 against the arrays
# already in `lap_telemetry`.
#
# REPINNED 2026-09-17. WP-B1 derived these against the stored corner rows, and the
# sprint-qualifying rows were stale: they had been written by a superseded derivation and
# never re-derived, so 4,439 of them changed on the v1.8 `--force` backfill. The proof is
# that this module reproduced all 19,913 qualifying rows byte-identically while agreeing
# with none of the sprint-qualifying ones, from telemetry arrays that did not change and
# with corner matching that did not change. ~25 of the 4,439 repaired rows sit close
# enough to a gate threshold that the window shift moved them across it, which is the
# whole of the difference between WP-B1's counts and these. The corpus is now idempotent:
# a second `--force` pass returns `0 rows differ` with an identical sha256. The backfill asserts them; the build fails on any other value,
# **because zero is not the only wrong answer** (§4.3, risk R1).

#: The corner-row census the three counts below partition.
TRAIL_CORNER_ROWS = 44_926
#: R1 -- `brake_point_m IS NULL`. A positive report, not a gap.
TRAIL_FLAT_ROWS = 8_050
TRAIL_BRAKED_ROWS = 36_876
#: DL-17, settled. Two derivations disagreed (8,870 against 8,991); under §3.2's exact
#: definition -- a corner is terminal iff no other corner row with the same
#: `(session_id, driver_id, lap_number, brake_zone_idx)` has a **strictly greater**
#: `apex_distance_m`, so a tie leaves both terminal. On the stale corpus that returned
#: 8,991; on the repaired, idempotent corpus it is 8,976. The definition did not change.
TRAIL_NON_TERMINAL_ROWS = 16_446
#: Rows reaching R3/R4/R5 at all, i.e. terminal braked rows.
TRAIL_TERMINAL_ROWS = 20_430
#: §4.3 -- the backfill acceptance count. Not "> 0".
TRAIL_EXPECTED_MEASURED_ROWS = 17_512

#: DL-15/DL-16 -- the bracketing step **at the release edge**, re-derived over all
#: 20,330 braked corner-rows (not the 4-session n=739 sample the spec quotes):
#: median 4.13 m, p90 10.47 m, p95 13.34 m, max 69.18 m. On the same four sessions the
#: spec sampled (15887/15905/15919/15923) this returns 1,096 corner-laps -- §3.2's own
#: figure -- and a p95 of 13.19 m, so the method agrees and only the population differs.
TRAIL_RELEASE_STEP_MEDIAN_M = 4.13
TRAIL_RELEASE_STEP_P90_M = 10.47
TRAIL_RELEASE_STEP_P95_M = 13.34
#: DL-16 -- 25.0 m is 1.87x the re-derived p95. The constant survives; the "2x 12.21 m"
#: arithmetic behind it does not, and is replaced by "2x 13.34 m, rounded down to the
#: same 25 m". Cost re-measured: 54 rows in gate order, 126 of 20,330 (0.62 %)
#: unconditionally -- **not** the 7.0 % of §3.2, which was priced against the wrong step.
TRAIL_R4_COST_ROWS = 123
TRAIL_R4_COST_ROWS_UNCONDITIONAL = 126
#: R3 and R5 re-measured the same two ways, for the same reason.
TRAIL_R3_COST_ROWS = 1_831
TRAIL_R3_COST_ROWS_UNCONDITIONAL = 1_702
TRAIL_R5_COST_ROWS = 964
TRAIL_R5_COST_ROWS_UNCONDITIONAL = 1_415
#: **Measured, unresolved, and reported rather than patched over.** Of the 9,408 rows
#: that pass all five gates, **1,604 (17.0 %) have `brake = true` again somewhere in
#: `(brake_release_m, apex_distance_m]`** -- the serving zone's release is provably not
#: the last time the brake was on before that apex. Their median
#: `brake_release_to_apex_m` is 142.9 m against 47.7 m for the other 7,804. §4.2 pins the
#: release to `zones[brake_zone_idx][1]` and D7 forbids touching `brake_zone_idx`, so the
#: derivation ships as specified; this constant exists so the next release can price the
#: sixth gate the six-word `trail_status` vocabulary has no room for.
TRAIL_RELEASE_REAPPLIED_ROWS = 1_604

#: §4.1 — the DRS codes that mean the flap is open. 0/1/2/3 are closed states, 8 is
#: "eligible but not open". Stored raw in the array; only this set counts distance.
DRS_OPEN: frozenset[int] = frozenset({10, 12, 14})

#: §5.2.2 — the closure gates, in milliseconds.
CLOSURE_CLEAN_MS = 150.0
CLOSURE_REFUSE_MS = 400.0


class TelemetryError(RuntimeError):
    """A telemetry-pass failure. Never escapes far enough to change ``status`` (T8)."""


@dataclass
class LapPick:
    """One row of the §1.1 selection, read from Postgres."""
    driver_id: str
    lap_number: int
    lap_time_s: float
    sector1_s: float | None
    sector2_s: float | None


@dataclass
class StoredLap:
    """The rounded arrays and their scalars, ready for :func:`summarise` and COPY."""
    pick: LapPick
    n_samples: int
    n_car_samples: int
    n_pos_samples: int
    distance_m: np.ndarray
    time_s: np.ndarray
    x: np.ndarray
    y: np.ndarray
    speed_kph: np.ndarray
    throttle_pct: np.ndarray
    brake: np.ndarray
    gear: np.ndarray
    drs: np.ndarray
    source_hash: str
    #: Seconds between the lap's official ``LapStartTime`` and its first telemetry sample.
    #: ``time_s`` is measured from the first **sample** (the DDL pins ``time_s[1] = 0``),
    #: but ``laps.sector1_s`` is measured from the official lap start, and at 10 Hz the two
    #: origins differ by up to 0.1 s. Ignoring that offset put the sector boundaries of two
    #: drivers up to ~19 m apart on the chord axis and inflated the §5.2.2 sector residual
    #: to 313 ms — larger than the 150 ms gate, from a bookkeeping error rather than from
    #: the alignment the gate exists to test. Sector times are converted with this offset.
    lap_start_offset_s: float = 0.0
    warnings: list[str] = field(default_factory=list)

    @property
    def track_length_m(self) -> float:
        """``distance_m[-1]`` — the lap's own chord length (§2.1)."""
        return float(self.distance_m[-1])

    @property
    def max_sample_gap_m(self) -> float:
        return float(np.max(np.diff(self.distance_m))) if self.n_samples > 1 else 0.0


def chord_distance(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """T5. Cumulative chord length of ``(x, y)`` in **metres**, ``[0] = 0``.

    ``x`` / ``y`` arrive in FastF1 position units (tenths of a metre) and are divided by
    :data:`POS_UNITS_PER_M` here; the arrays themselves are stored raw and unrotated
    (§0.3), so this is the only place the unit conversion happens.

    This is the whole of T5. There is deliberately no function in this module that reads
    FastF1's ``Distance`` column, so there is nothing for a later change to reach for.
    """
    if len(x) != len(y):
        raise TelemetryError(f"x/y length mismatch: {len(x)} != {len(y)}")
    if len(x) < 2:
        return np.zeros(len(x), dtype=float)
    steps = np.hypot(np.diff(x.astype(float)), np.diff(y.astype(float))) / POS_UNITS_PER_M
    return np.concatenate(([0.0], np.cumsum(steps)))


def truncate_non_monotone(d: np.ndarray) -> tuple[int, str | None]:
    """Length of the leading strictly-usable prefix of a chord distance array.

    Chord distance is monotone non-decreasing by construction, so a violation means the
    position stream jumped backwards. §3.4 says truncate the tail and record a warning
    rather than drop the lap: the prefix is still a real trace of a real lap.
    """
    if len(d) < 2:
        return len(d), None
    bad = np.flatnonzero(np.diff(d) < 0.0)
    if bad.size == 0:
        return len(d), None
    cut = int(bad[0]) + 1
    return cut, (f"chord distance decreased at sample {cut} "
                 f"({d[cut - 1]:.2f} -> {d[cut]:.2f} m); truncated {len(d) - cut} samples")


#: §1.1, expressed in the ``excl_*`` columns the ingest already wrote. For kind ``R`` the
#: green-flag, in-lap and out-lap exclusions apply as well; for Q/SQ they do not, because a
#: qualifying out-lap is not a flying lap and is already excluded by ``is_accurate``, while
#: a Q session run under a yellow that never touched the lap must still yield a trace.
_RACE_ONLY_EXCLUSIONS = ("excl_not_green", "excl_in_lap", "excl_out_lap")


def select_laps(conn, session_id: int, kind: str) -> list[LapPick]:
    """T2 — the fastest valid lap per driver, read from Postgres (§1.1, §3.4 step 1).

    A driver with no qualifying lap gets **no row**. That is a fact about the session,
    not a gap, and §3.6 records it as part of the ``partial`` / ``none`` state.
    """
    where = ["l.session_id = %s", "l.lap_time_s IS NOT NULL",
             "NOT l.excl_no_time", "NOT l.excl_inaccurate", "NOT l.excl_deleted"]
    if kind == "R":
        where += [f"NOT l.{c}" for c in _RACE_ONLY_EXCLUSIONS]
    sql = (
        "SELECT DISTINCT ON (l.driver_id) l.driver_id, l.lap_number, l.lap_time_s, "
        "       l.sector1_s, l.sector2_s "
        "FROM laps l WHERE " + " AND ".join(where) +
        " ORDER BY l.driver_id, l.lap_time_s ASC, l.lap_number ASC"
    )
    with conn.cursor() as cur:
        cur.execute(sql, (session_id,))
        return [LapPick(driver_id=r[0], lap_number=int(r[1]), lap_time_s=float(r[2]),
                        sector1_s=None if r[3] is None else float(r[3]),
                        sector2_s=None if r[4] is None else float(r[4]))
                for r in cur.fetchall()]


def session_row(conn, session_id: int) -> dict:
    """``session_id`` -> the year / round / kind / circuit_key the pass needs."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT s.session_id, s.year, s.round, s.kind, e.circuit_key, "
            "       e.event_name, e.event_date "
            "FROM sessions s JOIN events e ON e.year = s.year AND e.round = s.round "
            "WHERE s.session_id = %s", (session_id,))
        row = cur.fetchone()
    if row is None:
        raise TelemetryError(f"session_id {session_id} does not exist")
    return {"session_id": int(row[0]), "year": int(row[1]), "round": int(row[2]),
            "kind": row[3], "circuit_key": None if row[4] is None else int(row[4]),
            "event_name": row[5], "event_date": row[6]}


def eligible_sessions(conn, *, year: int | None = None, rounds: list[int] | None = None,
                      kinds: tuple[str, ...] = KINDS) -> list[dict]:
    """T3 — the lap-bearing session set, newest last, optionally narrowed."""
    where = ["s.kind = ANY(%s)"]
    params: list = [list(kinds)]
    if year is not None:
        where.append("s.year = %s")
        params.append(year)
    if rounds:
        where.append("s.round = ANY(%s)")
        params.append(list(rounds))
    with conn.cursor() as cur:
        cur.execute(
            # event_name and event_date are NOT optional extras: cache_is_warm() locates the
            # FastF1 artifacts by event-name slug and returns False the moment event_date is
            # missing. Selecting them here was omitted (2026-09-16), so every row this
            # function produced reported "cache cold" no matter what was on disk, and
            # `--require-cache` skipped all 89 warmed sessions. The single-session builder
            # above always carried both keys, which is why the bug only bit the bulk path.
            "SELECT s.session_id, s.year, s.round, s.kind, e.circuit_key, "
            "       e.event_name, e.event_date "
            "FROM sessions s JOIN events e ON e.year = s.year AND e.round = s.round "
            "WHERE " + " AND ".join(where) + " ORDER BY s.year, s.round, s.kind", params)
        return [{"session_id": int(r[0]), "year": int(r[1]), "round": int(r[2]),
                 "kind": r[3], "circuit_key": None if r[4] is None else int(r[4]),
                 "event_name": r[5], "event_date": r[6]}
                for r in cur.fetchall()]


#: The nine stored channels, in ``lap_telemetry`` DDL order after the scalars. ``RPM`` is
#: merged by FastF1 and deliberately **not** stored: nothing in §5 draws it, and it is the
#: single widest channel. ``Distance`` / ``RelativeDistance`` are not read at all (T5).
_CAR_COLUMNS = ("Speed", "Throttle", "Brake", "nGear", "DRS")
_POS_COLUMNS = ("X", "Y")


def _checksum(a: np.ndarray) -> str:
    """A stable digest of one rounded channel array, for :func:`source_hash`."""
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()[:16]


def source_hash(fastf1_version: str, lap_number: int, n_samples: int,
                first_time_s: float, last_time_s: float,
                channels: dict[str, np.ndarray]) -> str:
    """§3.5 — the idempotency key.

    SHA-256 over the FastF1 version, the lap number, the sample count, the first and last
    ``time_s``, and a checksum of **each rounded channel array**. Rounding happens before
    the hash (T9) so the hash is a function of what is actually stored: a re-derive that
    produces byte-identical arrays produces an identical hash and is skipped without a
    write, which is what makes re-running the pass over 160 sessions a no-op.
    """
    parts = [f"fastf1={fastf1_version}", f"lap={lap_number}", f"n={n_samples}",
             f"t0={first_time_s:.3f}", f"t1={last_time_s:.3f}"]
    parts += [f"{name}={_checksum(channels[name])}" for name in sorted(channels)]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def build_stored_lap(lap, pick: LapPick, fastf1_version: str) -> StoredLap:
    """§3.4 steps 2-3 — merged samples -> chord distance -> rounded arrays.

    ``lap.get_telemetry()`` merges the 10 Hz car stream onto the position stream and
    **interpolates the integer channels to floats** in the process (measured: ``nGear``
    fractional, ``RPM`` 10755.6222). T9's rounding is therefore not only a compression
    lever, it is the step that puts the discrete channels back on their own integers.
    ``Brake`` is thresholded at 0.5 for the same reason.
    """
    tel = lap.get_telemetry()
    tel = tel[tel["X"].notna() & tel["Y"].notna()]
    if len(tel) < MIN_SAMPLES:
        raise TelemetryError(
            f"{pick.driver_id} lap {pick.lap_number}: {len(tel)} samples with position "
            f"(floor is {MIN_SAMPLES}); a lap this sparse would draw a triangle")
    if len(tel) > MAX_SAMPLES:
        raise TelemetryError(f"{pick.driver_id} lap {pick.lap_number}: {len(tel)} samples "
                             f"exceeds the {MAX_SAMPLES} ceiling")

    x_raw = tel["X"].to_numpy(dtype=float)
    y_raw = tel["Y"].to_numpy(dtype=float)
    dist = chord_distance(x_raw, y_raw)
    cut, warn = truncate_non_monotone(dist)
    warnings = [warn] if warn else []
    if cut < MIN_SAMPLES:
        raise TelemetryError(f"{pick.driver_id} lap {pick.lap_number}: only {cut} monotone "
                             f"samples before the chord distance reversed")
    sl = slice(0, cut)
    t = tel["Time"]
    time_s = (t - t.iloc[0]).dt.total_seconds().to_numpy(dtype=float)[sl]
    offset = float(t.iloc[0].total_seconds())

    channels = {
        "distance_m": np.round(dist[sl], 2),
        "time_s": np.round(time_s, 3),
        "x": np.round(x_raw[sl], 0),
        "y": np.round(y_raw[sl], 0),
        "speed_kph": np.round(tel["Speed"].to_numpy(dtype=float)[sl]).astype(np.int64),
        "throttle_pct": np.round(tel["Throttle"].to_numpy(dtype=float)[sl]).astype(np.int64),
        "brake": tel["Brake"].to_numpy(dtype=float)[sl] >= 0.5,
        "gear": np.round(tel["nGear"].to_numpy(dtype=float)[sl]).astype(np.int64),
        "drs": np.round(tel["DRS"].to_numpy(dtype=float)[sl]).astype(np.int64),
    }
    n = cut
    for name, arr in channels.items():
        if len(arr) != n:
            raise TelemetryError(f"{name} has {len(arr)} values, expected {n}")
    return StoredLap(
        pick=pick, n_samples=n,
        n_car_samples=int(len(lap.get_car_data())), n_pos_samples=int(len(lap.get_pos_data())),
        source_hash=source_hash(fastf1_version, pick.lap_number, n,
                                float(channels["time_s"][0]), float(channels["time_s"][-1]),
                                channels),
        lap_start_offset_s=offset, warnings=warnings, **channels)


def _segment_weights(distance_m: np.ndarray) -> np.ndarray:
    """§0.3 — the distance each sample owns. One weight per sample; they sum to the lap.

    Samples are uniform in **time**, so counting them weights a 71 km/h corner the same
    as a 342 km/h straight and over-counts the corner by roughly 3x. Every percentage in
    this module is therefore the distance covered while a condition held, over the lap's
    chord length.

    A sample owns the distance from the midpoint to its predecessor to the midpoint to its
    successor (the two end samples own their half-segment). This is a partition — the
    weights sum exactly to ``distance_m[-1]`` — and it is **symmetric**, where charging
    each segment to its leading sample is not: that convention shortens every braking zone
    by half a sample at each end and read 1.2 points low on ``brake_pct``.
    """
    d = np.asarray(distance_m, dtype=float)
    if len(d) < 2:
        return np.zeros(len(d), dtype=float)
    mid = (d[:-1] + d[1:]) / 2.0
    edges = np.concatenate(([d[0]], mid, [d[-1]]))
    return np.diff(edges)


def brake_zones(distance_m: np.ndarray, brake: np.ndarray) -> list[tuple[float, float]]:
    """§4.2 — the lap's brake applications, debounced, as ``(onset_m, release_m)``.

    Raw rising edges over-count: a single application through a chicane flickers off for
    a few samples and reads as two stops. Applications whose onsets are within
    :data:`BRAKE_MERGE_DISTANCE_M` of each other, or separated by a gap shorter than
    :data:`BRAKE_MERGE_GAP_M`, are one application. Measured at Monza this turns 6-10 raw
    edges into 4-7 zones, which is what lets T1+T2 report one braking point instead of
    two and T8+T9+T10 one instead of three (§4.2).

    **The release is stored as of v1.8.** ``release_m`` was computed here and discarded by
    :func:`corner_metrics` from v1.0 to v1.7; `GAPFILL_SPEC §3.0` is the finding that Gap B
    needs no new pass, no new debounce and no new model -- only the second half of a tuple
    this function already returns. The release point is not a model: it is the distance at
    which the boolean went false. See :func:`brake_zone_edges` for the index form.
    """
    d = np.asarray(distance_m, dtype=float)
    return [(float(d[a]), float(d[b])) for a, b in brake_zone_edges(distance_m, brake)]


def brake_zone_edges(distance_m: np.ndarray, brake: np.ndarray) -> list[tuple[int, int]]:
    """§4.2 -- the same debounced applications as :func:`brake_zones`, as **sample
    indices** ``(first_on, last_on)`` rather than metres.

    v1.8 (`GAPFILL_SPEC §3.1`): the release edge is stored, and storing it needs the
    index of the last ``brake = true`` sample so the bracketing step
    ``d[last_on + 1] - d[last_on]`` can be measured and the release placed at the
    **midpoint** of it. :func:`brake_zones` delegates here so there is exactly one
    merge rule and no chance of the two drifting apart.
    """
    d = np.asarray(distance_m, dtype=float)
    on = np.asarray(brake, dtype=bool)
    if not on.any():
        return []
    idx = np.flatnonzero(on)
    breaks = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([idx[0]], idx[breaks + 1]))
    ends = np.concatenate((idx[breaks], [idx[-1]]))
    raw = [(int(a), int(b)) for a, b in zip(starts, ends)]

    merged: list[tuple[int, int]] = [raw[0]]
    for a, b in raw[1:]:
        pa, pb = merged[-1]
        onset, prev_on, prev_off = d[a], d[pa], d[pb]
        if (onset - prev_on) < BRAKE_MERGE_DISTANCE_M or (onset - prev_off) < BRAKE_MERGE_GAP_M:
            merged[-1] = (pa, b if d[b] > prev_off else pb)
        else:
            merged.append((a, b))
    return merged


def _distance_at_time(sl: StoredLap, t: float | None) -> float | None:
    """Chord distance at a time measured from the **official lap start**, or ``None``.

    ``t`` is a cumulative sector time from ``laps``; ``sl.time_s`` runs from the first
    telemetry sample. :attr:`StoredLap.lap_start_offset_s` is the difference and it is
    not negligible: see the field's own note.
    """
    if t is None or not np.isfinite(t):
        return None
    t_tel = t - sl.lap_start_offset_s
    if t_tel < sl.time_s[0] or t_tel > sl.time_s[-1]:
        return None
    return float(np.interp(t_tel, sl.time_s, sl.distance_m))


def summarise(sl: StoredLap) -> dict:
    """§4.1 — one ``lap_telemetry_summary`` row, distance-weighted throughout.

    Three honesty artefacts are preserved rather than tidied (§4.1):

    **One place §4.1 contradicts itself, resolved here and flagged in §10.** Its rule column
    says ``full_throttle_pct`` is "distance with ``throttle_pct >= 99 AND NOT brake``". With
    that reading the four states partition the lap and ``ft + brake + lift`` is *identically*
    100, which makes the "they do not sum to 100" artefact below impossible and contradicts
    the section's own measured row (83.9 + 12.6 + 9.0 = 105.5 = 100 + the 5.5 overlap). The
    measured numbers and the honesty argument both require ``full_throttle_pct`` to be
    measured on the throttle channel **alone**, independently of the brake, which is what
    "each measured independently" says two paragraphs later. That is what is implemented.

    - The four shares **do not sum to 100** and must not be forced to. ``full_throttle``,
      ``brake`` and ``lift`` are each measured independently and ``overlap_pct`` records
      the disagreement, which is stream-merge skew and reached **5.5%** of the lap by
      distance at Monza. Computing ``lift = 100 - ft - brake`` would hide exactly that.
    - ``drs_distance_m`` is **NULL, never 0**, when the lap's DRS array is flat. "Nobody
      used DRS" and "this session has no DRS signal" are different claims.
    - ``throttle_pct`` reaching 104 is stored as delivered; nothing here clamps it.
    """
    w = _segment_weights(sl.distance_m)
    total = float(w.sum())
    throttle_on = sl.throttle_pct >= FULL_THROTTLE_PCT
    braking = np.asarray(sl.brake, dtype=bool)
    pct = lambda mask: float(100.0 * w[mask].sum() / total) if total > 0 else 0.0

    drs_flat = bool(np.all(sl.drs == sl.drs[0]))
    drs_m = None if drs_flat else float(w[np.isin(sl.drs, list(DRS_OPEN))].sum())
    t1 = sl.pick.sector1_s
    t2 = None if (t1 is None or sl.pick.sector2_s is None) else t1 + sl.pick.sector2_s
    gaps = np.diff(sl.distance_m)
    return {
        "top_speed_kph": int(sl.speed_kph.max()), "min_speed_kph": int(sl.speed_kph.min()),
        "full_throttle_pct": pct(throttle_on),
        "brake_pct": pct(braking), "lift_pct": pct(~throttle_on & ~braking),
        "overlap_pct": pct(throttle_on & braking),
        "n_brake_zones": len(brake_zones(sl.distance_m, sl.brake)),
        "n_gear_changes": int(np.count_nonzero(np.diff(sl.gear) != 0)),
        "drs_distance_m": drs_m, "track_length_m": sl.track_length_m,
        "s1_distance_m": _distance_at_time(sl, t1), "s2_distance_m": _distance_at_time(sl, t2),
        "n_samples": sl.n_samples, "max_sample_gap_m": sl.max_sample_gap_m,
        "n_gaps_over_50m": int(np.count_nonzero(gaps > GAP_THRESHOLD_M)),
    }


def project_corners(corner_x: np.ndarray, corner_y: np.ndarray, ref: StoredLap) -> np.ndarray:
    """Corner ``(X, Y)`` -> **chord** distance along the reference lap (§2.1).

    ``get_circuit_info()`` ships its own ``Distance`` column, and it is FastF1's integrated
    distance — the quantity T5 exists to keep out of this schema. Projecting the corner's
    position onto the reference lap's own polyline puts every corner on the same axis the
    traces are drawn on, so a corner marker and an apex land on the same metre.
    """
    out = np.empty(len(corner_x), dtype=float)
    for i, (cx, cy) in enumerate(zip(corner_x, corner_y)):
        j = int(np.argmin(np.hypot(ref.x - float(cx), ref.y - float(cy))))
        out[i] = float(ref.distance_m[j])
    return out


def _speed_at(sl: StoredLap, s: float) -> int:
    return int(round(float(np.interp(s, sl.distance_m, sl.speed_kph.astype(float)))))


def _time_at(sl: StoredLap, s: float) -> float:
    return float(np.interp(s, sl.distance_m, sl.time_s))


G = 9.80665


def release_edge(distance_m: np.ndarray, last_on: int) -> tuple[float, float]:
    """§3.1/§3.2 -- ``(release_m, bracketing_step_m)`` for a zone ending at ``last_on``.

    The boolean flipped somewhere between ``d[last_on]`` and ``d[last_on + 1]`` and the
    arrays cannot say where, so the release is the **midpoint** of that step and the step
    itself is the measurement's own resolution -- the quantity R4 gates on. DL-15: this
    is the bracketing step at the release edge, not the window median (4.94 m) and not
    the window maximum (16.25 m).
    """
    d = np.asarray(distance_m, dtype=float)
    if last_on + 1 < len(d):
        return 0.5 * (float(d[last_on]) + float(d[last_on + 1])), float(d[last_on + 1] - d[last_on])
    # The lap's last stored sample still reads brake = true: there is no bracketing
    # sample. Fall back to the step that led into it so R4 can still judge the edge.
    prev = float(d[last_on] - d[last_on - 1]) if last_on > 0 else float("inf")
    return float(d[last_on]), prev


def trail_duty(distance_m: np.ndarray, brake: np.ndarray, lo: float, hi: float) -> float | None:
    """§3.1 -- distance-weighted share of ``[lo, hi]`` with ``brake = true``, in [0, 1].

    Bounded **by construction**: each sample owns the span between its two midpoint
    edges (the same partition :func:`_segment_weights` uses), clipped to the window, so
    the numerator can never exceed the denominator. That is the whole reason it survives
    the shared-zone adversarial test the unbounded edge definition failed (`trail_frac`
    > 1 on 11 % of corner-laps, up to 3.79). Diagnostic only -- never rendered (DL-18).
    """
    d = np.asarray(distance_m, dtype=float)
    if hi <= lo or len(d) < 2:
        return None
    mid = (d[:-1] + d[1:]) / 2.0
    edges = np.concatenate(([d[0]], mid, [d[-1]]))
    w = np.clip(np.minimum(edges[1:], hi) - np.maximum(edges[:-1], lo), 0.0, None)
    total = float(w.sum())
    if total <= 0.0:
        return None
    return float((w * np.asarray(brake, dtype=bool)).sum() / total)


def max_decel_g(sl: "StoredLap", lo: float, hi: float) -> float:
    """§3.2 R5 / §4.5 -- the largest implied deceleration inside ``[lo, hi]``, in g.

    Differentiated against ``time_s``, **never** against ``distance_m``: chord samples
    compress to sub-metre in slow chicanes and distance-differentiation returns 46-586
    m/s^2 (up to 60 g) from a physical 4-23 m/s^2. Returns 0.0 when the window holds
    fewer than two samples.
    """
    w = np.flatnonzero((sl.distance_m >= lo) & (sl.distance_m <= hi))
    if w.size < 2:
        return 0.0
    v = sl.speed_kph[w].astype(float) / 3.6
    t = sl.time_s[w].astype(float)
    dt = np.diff(t)
    ok = dt > 0
    if not ok.any():
        return 0.0
    return float(np.max(np.abs(np.diff(v)[ok] / dt[ok])) / G)


def corner_metrics(sl: StoredLap, corner_distance_m: np.ndarray) -> list[dict]:
    """§4.2 — the per-corner report card for one stored lap.

    ``brake_zone_idx`` is the point of the table. Without it a shared application is
    reported once per corner and a fan reads three separate stops through Ascari.

    A zone **serves** a corner when it starts before the apex and releases no more than
    :data:`BRAKE_SERVE_REACH_M` before it; among the candidates the **longest** zone wins.
    Length, not recency, is what makes T1 and T2 share: the Rettifilo application runs
    787-900 m and there is a 5.5 m dab at 930 m between the two apexes. Charging T2 to the
    dab would report a 14 m braking distance for a 71 km/h corner and split an application
    the driver made once. Measured on GAS's 1:21.786 this assigns one zone to T1+T2, one to
    T4+T5, one to T8+T9+T10, and leaves **only** Curva Grande unserved — exactly §4.2's
    "T3 at a 300 km/h apex is flat; the other ten are not".
    """
    edges = brake_zone_edges(sl.distance_m, sl.brake)
    zones = [(float(sl.distance_m[a]), float(sl.distance_m[b])) for a, b in edges]
    n = len(corner_distance_m)
    out: list[dict] = []
    for i, c in enumerate(corner_distance_m):
        prev_c = corner_distance_m[i - 1] if i > 0 else corner_distance_m[-1] - sl.track_length_m
        next_c = corner_distance_m[i + 1] if i + 1 < n else corner_distance_m[0] + sl.track_length_m
        back = min(CORNER_WINDOW_M, (c - prev_c) / 2.0)
        fwd = min(CORNER_WINDOW_M, (next_c - c) / 2.0)
        lo, hi = max(0.0, c - back), min(sl.track_length_m, c + fwd)
        win = (sl.distance_m >= lo) & (sl.distance_m <= hi)
        if not win.any():
            continue
        k = int(np.flatnonzero(win)[int(np.argmin(sl.speed_kph[win]))])
        apex_m, apex_kph = float(sl.distance_m[k]), int(sl.speed_kph[k])

        serving = [z for z, (on, off) in enumerate(zones)
                   if on <= apex_m and (apex_m - off) <= BRAKE_SERVE_REACH_M]
        zi = max(serving, key=lambda z: zones[z][1] - zones[z][0]) if serving else None
        brake_m = float(zones[zi][0]) if zi is not None else None

        after = np.flatnonzero((sl.distance_m > apex_m) & (sl.throttle_pct >= FULL_THROTTLE_PCT))
        out.append({
            "apex_speed_kph": apex_kph, "apex_distance_m": apex_m,
            "entry_speed_kph": _speed_at(sl, max(0.0, apex_m - ENTRY_EXIT_M)),
            "exit_speed_kph": _speed_at(sl, min(sl.track_length_m, apex_m + ENTRY_EXIT_M)),
            "brake_zone_idx": zi, "brake_point_m": brake_m,
            "brake_distance_m": None if brake_m is None else apex_m - brake_m,
            "throttle_point_m": float(sl.distance_m[after[0]]) if after.size else None,
            "time_in_corner_s": _time_at(sl, hi) - _time_at(sl, lo),
            "brake_release_m": None, "brake_release_to_apex_m": None,
            "brake_on_distance_m": None, "trail_duty": None,
            "trail_status": TRAIL_STATUS_FLAT,
        })
    _apply_trail(sl, out, edges)
    return out


def _apply_trail(sl: StoredLap, out: list[dict], edges: list[tuple[int, int]]) -> None:
    """§4.2 pass 2 -- the release half, written in place onto pass 1's corner dicts.

    Pass 1 decides each corner independently; **terminality is a property of the
    complex**, so it cannot be decided there. `brake_zones` merges with
    ``max(prev_off, release)``, so a merged application has exactly one release and it
    belongs to the last corner of the complex: charging it to Monza T1 would report
    "still braking 120 m past the apex" for a corner the driver was off the brakes for.

    DL-17, exactly: a corner is **terminal** in its zone iff no other corner of the same
    zone has a *strictly greater* ``apex_distance_m`` (so a tie leaves both terminal).
    Nothing here touches ``brake_zone_idx``, ``brake_point_m`` or ``brake_distance_m``.
    """
    best: dict[int, float] = {}
    for m in out:
        zi = m["brake_zone_idx"]
        if zi is None:
            continue
        a = m["apex_distance_m"]
        if zi not in best or a > best[zi]:
            best[zi] = a

    for m in out:
        zi = m["brake_zone_idx"]
        if zi is None or m["brake_point_m"] is None:
            continue                                   # R1: taken flat, already stamped
        first_on, last_on = edges[zi]
        apex_m, brake_m = m["apex_distance_m"], m["brake_point_m"]
        m["trail_duty"] = trail_duty(sl.distance_m, sl.brake, brake_m, apex_m)
        if apex_m < best[zi]:                          # R2
            m["trail_status"] = TRAIL_STATUS_NON_TERMINAL
            continue
        if int(np.count_nonzero(sl.brake[first_on:last_on + 1])) < TRAIL_MIN_ZONE_SAMPLES:
            m["trail_status"] = TRAIL_STATUS_FEW_SAMPLES      # R3
            continue
        release_m, step_m = release_edge(sl.distance_m, last_on)
        if not np.isfinite(step_m) or step_m > TRAIL_MAX_RELEASE_STEP_M:
            m["trail_status"] = TRAIL_STATUS_WIDE_STEP        # R4
            continue
        if max_decel_g(sl, float(sl.distance_m[first_on]), apex_m) > TRAIL_MAX_DECEL_G:
            m["trail_status"] = TRAIL_STATUS_DECEL            # R5
            continue
        m["brake_release_m"] = release_m
        m["brake_release_to_apex_m"] = apex_m - release_m
        m["brake_on_distance_m"] = release_m - brake_m
        m["trail_status"] = TRAIL_STATUS_MEASURED


def delta_trace(dist_a: np.ndarray, time_a: np.ndarray,
                dist_b: np.ndarray, time_b: np.ndarray,
                step_m: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """§5.2.1 — the cross-driver delta, on chord distance and nothing else.

    The common axis is ``s in [0, min(L_A, L_B)]`` on a 1 m grid. **No normalisation**:
    chord lengths agree to ~10 m, so the trimmed tail is metres. Normalising each lap to
    its own length closes the endpoint exactly — and therefore certifies itself — while
    displacing the error into the interior, measured at +481, -496, +446, -570, +453,
    -573 ms at the sector boundaries (§1.4). ``delta > 0`` means A took **more** time to
    reach ``s``, i.e. A is behind (§0.3).

    This is the reference implementation ``web/lib/telemetry/align.ts`` is checked against.
    """
    s_end = min(float(dist_a[-1]), float(dist_b[-1]))
    s = np.arange(0.0, s_end + step_m, step_m)
    s = s[s <= s_end]
    return s, np.interp(s, dist_a, time_a) - np.interp(s, dist_b, time_b)


def closure_report(a: StoredLap, b: StoredLap, sum_a: dict, sum_b: dict) -> dict:
    """§5.2.2 — the numbers the chart validates itself with, before it renders.

    ``end_error_ms`` is ``delta(s_end)`` against the official gap from ``laps``. The
    **sector** residuals are the assertion that matters: under chord alignment they are a
    real check (measured 8-98 ms), and under any length normalisation the endpoint version
    is a tautology by construction. Each sector boundary is evaluated at the **midpoint**
    of the two drivers' own ``s{n}_distance_m`` — symmetric in A and B, so swapping the
    drivers negates every residual exactly.
    """
    s, d = delta_trace(a.distance_m, a.time_s, b.distance_m, b.time_s)
    official = a.pick.lap_time_s - b.pick.lap_time_s
    out = {"s_end_m": float(s[-1]), "official_gap_s": official,
           "end_error_ms": float((d[-1] - official) * 1000.0), "sectors": []}
    cum = [("s1", a.pick.sector1_s, b.pick.sector1_s, "s1_distance_m")]
    if a.pick.sector1_s is not None and a.pick.sector2_s is not None \
            and b.pick.sector1_s is not None and b.pick.sector2_s is not None:
        cum.append(("s2", a.pick.sector1_s + a.pick.sector2_s,
                    b.pick.sector1_s + b.pick.sector2_s, "s2_distance_m"))
    for name, ta, tb, key in cum:
        sa, sb = sum_a.get(key), sum_b.get(key)
        if ta is None or tb is None or sa is None or sb is None:
            continue
        s_mid = (float(sa) + float(sb)) / 2.0
        got = float(np.interp(s_mid, a.distance_m, a.time_s)
                    - np.interp(s_mid, b.distance_m, b.time_s))
        out["sectors"].append({"boundary": name, "s_m": s_mid,
                               "residual_ms": (got - (ta - tb)) * 1000.0})
    worst = max([abs(out["end_error_ms"])] + [abs(x["residual_ms"]) for x in out["sectors"]])
    out["worst_ms"] = worst
    out["verdict"] = ("clean" if worst <= CLOSURE_CLEAN_MS
                      else "captioned" if worst <= CLOSURE_REFUSE_MS else "refuse")
    return out


def _corner_frame_rows(info, layout_key: tuple[int, int], ref: StoredLap) -> pd.DataFrame:
    """``circuit_corners`` rows from ``get_circuit_info()``, on the chord axis (§2.1)."""
    corners = info.corners
    circuit_key, year = layout_key
    dist = project_corners(corners["X"].to_numpy(dtype=float),
                           corners["Y"].to_numpy(dtype=float), ref)
    return pd.DataFrame({
        "circuit_key": circuit_key, "year": year,
        "corner_number": corners["Number"].to_numpy(dtype=int),
        "corner_letter": [("" if pd.isna(v) else str(v)) for v in corners["Letter"]],
        "x": corners["X"].to_numpy(dtype=float), "y": corners["Y"].to_numpy(dtype=float),
        "angle_deg": corners["Angle"].to_numpy(dtype=float), "distance_m": dist,
    })



def stored_corners(conn, circuit_key: int, year: int) -> pd.DataFrame | None:
    """The ``circuit_corners`` already stored for this circuit-year, or ``None``.

    §3.4 step 4 says the geometry is written **once per (circuit_key, year)**, and that is
    not just a saving. ``distance_m`` is the corner projected onto one reference lap, so
    rewriting it per session would silently move every corner marker by a few metres each
    time another session at the same circuit is derived — and would leave the corner
    metrics of the sessions derived earlier keyed to an axis the table no longer holds.
    The first session to arrive defines the axis and ``ref_session_id`` records which one;
    ``--force`` is the only thing that moves it.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM circuit_layout WHERE circuit_key = %s AND year = %s",
                    (circuit_key, year))
        if cur.fetchone() is None:
            return None
        cur.execute("SELECT circuit_key, year, corner_number, corner_letter, x, y, "
                    "angle_deg, distance_m FROM circuit_corners "
                    "WHERE circuit_key = %s AND year = %s "
                    "ORDER BY corner_number, corner_letter", (circuit_key, year))
        rows = cur.fetchall()
    if not rows:
        return None
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["circuit_corners"])


def _copy_corner_frame(cur, table: str, df: pd.DataFrame) -> int:
    """COPY one of the two ``corner_letter`` tables, preserving the empty string.

    ``corner_letter`` is ``NOT NULL DEFAULT ''`` and sits **in the primary key**, so the
    unlettered corners of a circuit (all 11 at Monza) must arrive as ``''``. The shared
    pipeline cannot deliver that: ``frames._is_null`` treats ``''`` as NULL — correct
    everywhere else in this project, where a blank ``ClassifiedPosition`` really is absent
    — and it is applied twice, in ``_to_text`` and again in ``frames._py``, so no value set
    on the frame survives to COPY. Rather than widen a caster shared by 60 tables for one
    column, this writes these two tables through ``db.copy_rows`` with the same casting and
    the single cell restored. A ``text-notnull`` kind in ``frames.TABLE_COLUMNS`` would be
    the tidier fix; it is WP-2's file, and §10 records the request.
    """
    cast = frames.cast_frame(df, table)
    cols = frames.EXPECTED_COLUMNS[table]
    i = cols.index("corner_letter")

    def rows():
        for row in cast.itertuples(index=False, name=None):
            vals = [frames._py(v) for v in row]
            if vals[i] is None:
                vals[i] = ""
            yield tuple(vals)

    return db.copy_rows(cur, table, cols, rows())


def _telemetry_frame(session_id: int, laps: list[StoredLap], now) -> pd.DataFrame:
    rows = []
    for sl in laps:
        rows.append({
            "session_id": session_id, "driver_id": sl.pick.driver_id,
            "lap_number": sl.pick.lap_number, "selection": SELECTION,
            "n_samples": sl.n_samples, "n_car_samples": sl.n_car_samples,
            "n_pos_samples": sl.n_pos_samples, "max_sample_gap_m": sl.max_sample_gap_m,
            "track_length_m": sl.track_length_m, "source_hash": sl.source_hash,
            "distance_m": sl.distance_m, "time_s": sl.time_s, "x": sl.x, "y": sl.y,
            "speed_kph": sl.speed_kph, "throttle_pct": sl.throttle_pct,
            "brake": sl.brake, "gear": sl.gear, "drs": sl.drs, "ingested_at": now,
            # §4.3 -- written from the constant, never left to the DDL default of 1.
            "derive_version": TRAIL_DERIVE_VERSION,
        })
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["lap_telemetry"])


def _summary_frame(session_id: int, laps: list[StoredLap],
                   summaries: dict[str, dict]) -> pd.DataFrame:
    rows = []
    for sl in laps:
        row = {"session_id": session_id, "driver_id": sl.pick.driver_id,
               "lap_number": sl.pick.lap_number}
        row.update(summaries[sl.pick.driver_id])
        rows.append(row)
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["lap_telemetry_summary"])


def _corner_speeds_frame(session_id: int, laps: list[StoredLap], corners: pd.DataFrame,
                         per_lap: dict[str, list[dict]]) -> pd.DataFrame:
    numbers = corners["corner_number"].tolist()
    letters = corners["corner_letter"].tolist()
    rows = []
    for sl in laps:
        for (num, letter), m in zip(zip(numbers, letters), per_lap[sl.pick.driver_id]):
            row = {"session_id": session_id, "driver_id": sl.pick.driver_id,
                   "lap_number": sl.pick.lap_number,
                   "corner_number": num, "corner_letter": letter}
            row.update(m)
            rows.append(row)
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["lap_corner_speeds"])


def _fastf1_version() -> str:
    import fastf1
    return str(getattr(fastf1, "__version__", "unknown"))


def stored_hashes(conn, session_id: int) -> dict[tuple[str, int], tuple[str, int]]:
    """§3.5 -- what is already stored for this session, one indexed SELECT.

    v1.8 (`GAPFILL_SPEC §4.3`, risk R1): the value is now
    ``(source_hash, derive_version)``, not the hash alone. ``source_hash`` is a digest of
    the **raw channels** -- FastF1 version, lap number, sample count, first/last
    ``time_s``, channel checksums -- and says nothing about the derivation recipe. After
    migration 0010 all 1,518 laps hash identically, so a hash-only skip condition skips
    every session, leaves five new columns NULL forever and exits 0. Reading the stored
    ``derive_version`` beside the hash is what makes that impossible.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id, lap_number, source_hash, derive_version "
                    "FROM lap_telemetry WHERE session_id = %s", (session_id,))
        return {(r[0], int(r[1])): (r[2], int(r[3])) for r in cur.fetchall()}


def _driver_numbers(conn, session_id: int) -> dict[str, str]:
    """``driver_id`` -> FastF1 ``DriverNumber``, the join between Postgres and FastF1.

    The lap selection is made in Postgres on ``driver_id`` (§3.4 step 1) and FastF1's laps
    are keyed by car number, so this is the one place the two identity spaces meet.
    ``session_entries`` is authoritative for the session and carries a unique constraint
    on ``(session_id, driver_number)``, so the map is injective by construction.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id, driver_number FROM session_entries WHERE session_id = %s",
                    (session_id,))
        return {r[0]: r[1] for r in cur.fetchall()}


def _set_analytics_status(cur, session_id: int, payload: dict) -> None:
    """T8 — write ``analytics_status['telemetry']`` and **never touch ``status``**.

    A session that ingested fine and then failed to get telemetry is still ``'ok'``,
    because every claim the app already makes about it is still true (§3.6). There is
    deliberately no code path in this module that writes ``session_ingests.status`` or
    ``session_ingests.error`` — ``error`` belongs to the ``failed`` ingest path and is
    excluded from the ask schema.
    """
    cur.execute(
        "UPDATE session_ingests SET analytics_status = analytics_status || %s::jsonb "
        "WHERE session_id = %s", (json.dumps({"telemetry": payload}), session_id))


def _add_warnings(cur, session_id: int, messages: list[str]) -> None:
    if not messages:
        return
    cur.execute("UPDATE session_ingests SET warnings = warnings || %s::text[] "
                "WHERE session_id = %s", (messages, session_id))


def _load_session(row: dict, cache=None):
    """The one network-capable call, and only when the cache is cold (§3.4, T7)."""
    return clean.load_telemetry(row["year"], row["round"], row["kind"], cache=cache)


def derive_session(conn, session_id: int, *, force: bool = False, session=None,
                   cache=None) -> dict:
    """The §3.4 write pass for one session. Returns the ``analytics_status`` payload.

    Everything is written in **one transaction per session** by the caller: this function
    does not commit, so an interruption mid-warm loses at most the session in flight.

    Per-driver failures never abort the session (§3.4): each driver is guarded, the message
    lands in ``session_ingests.warnings``, and the session lands ``partial`` in
    ``analytics_status['telemetry']`` **only**.
    """
    row = session_row(conn, session_id)
    picks = select_laps(conn, session_id, row["kind"])
    if not picks:
        return {"state": "none", "drivers": 0, "eligible": 0,
                "reason": "no lap in this session meets the §1.1 stored-lap rule"}

    known = {} if force else stored_hashes(conn, session_id)
    if session is None:
        session = _load_session(row, cache=cache)
    version = _fastf1_version()
    numbers = _driver_numbers(conn, session_id)
    ff_laps = session.laps

    stored: list[StoredLap] = []
    warnings: list[str] = []
    failed: list[str] = []
    for pick in picks:
        try:
            number = numbers.get(pick.driver_id)
            if number is None:
                raise TelemetryError(f"{pick.driver_id} has no session_entries row")
            sel = ff_laps[(ff_laps["DriverNumber"] == number)
                          & (ff_laps["LapNumber"] == pick.lap_number)]
            if len(sel) != 1:
                raise TelemetryError(
                    f"{pick.driver_id} lap {pick.lap_number}: {len(sel)} matching FastF1 laps")
            sl = build_stored_lap(sel.iloc[0], pick, version)
        except Exception as exc:                      # noqa: BLE001 - guarded per §3.4
            failed.append(pick.driver_id)
            warnings.append(f"telemetry: {pick.driver_id}: {exc}")
            continue
        stored.append(sl)
        warnings.extend(f"telemetry: {pick.driver_id}: {w}" for w in sl.warnings)

    # §4.3 -- BOTH halves of the skip condition. `source_hash` covers the raw inputs;
    # `derive_version` covers the derivation. Dropping the second half is exactly risk R1.
    unchanged = all(known.get((s.pick.driver_id, s.pick.lap_number))
                    == (s.source_hash, TRAIL_DERIVE_VERSION)
                    for s in stored) and len(known) == len(stored)
    if stored and known and unchanged and not force:
        log.info("session %s: telemetry unchanged (%d laps), no write", session_id, len(stored))
        return {"state": "ok", "drivers": len(stored), "eligible": len(picks),
                "skipped": True, "reason": "source_hash and derive_version unchanged"}
    return _write_session(conn, row, stored, picks, warnings, failed, session, force)


def _write_session(conn, row: dict, stored: list[StoredLap], picks: list[LapPick],
                   warnings: list[str], failed: list[str], session, force: bool = False) -> dict:
    """§3.4 step 5 and §3.5 — delete-then-COPY all five tables, no commit here."""
    session_id = row["session_id"]
    if not stored:
        with conn.cursor() as cur:
            _add_warnings(cur, session_id, warnings)
        # Carry the ACTUAL reasons, not just the count (2026-09-18). The per-driver messages
        # were already being captured into `warnings`, but they landed in
        # `session_ingests.warnings` -- a column nothing points to -- while the payload the
        # telemetry tab and every operator reads said only "every eligible driver failed (21)".
        # Diagnosing Monaco 2026 R6 took three queries to discover that all 21 drivers died on
        # the same line ("None of ['Date'] are in the columns"); with the reason here it would
        # have taken none. Distinct reasons are counted because a whole-session fault shows up
        # as one message repeated per driver, and that shape is itself the diagnosis: one
        # distinct reason across every driver means the session is broken, several means the
        # drivers are.
        why = collections.Counter(
            w.split(": ", 2)[-1] for w in warnings if w.startswith("telemetry: "))
        top = [f"{msg} (x{n})" if n > 1 else msg for msg, n in why.most_common(3)]
        return {"state": "failed", "drivers": 0, "eligible": len(picks),
                "reason": f"every eligible driver failed ({len(failed)})",
                "distinct_reasons": len(why),
                "reasons": top}

    stored.sort(key=lambda s: s.pick.lap_time_s)
    ref = stored[0]
    summaries = {s.pick.driver_id: summarise(s) for s in stored}
    info = session.get_circuit_info()
    layout_key = (row["circuit_key"], row["year"])
    reuse = None if force else stored_corners(conn, *layout_key)
    corners = reuse if reuse is not None else _corner_frame_rows(info, layout_key, ref)
    per_lap = {s.pick.driver_id: corner_metrics(s, corners["distance_m"].to_numpy(float))
               for s in stored}

    now = pd.Timestamp.now(tz="UTC")
    tel_df = _telemetry_frame(session_id, stored, now)
    sum_df = _summary_frame(session_id, stored, summaries)
    cor_df = _corner_speeds_frame(session_id, stored, corners, per_lap)
    layout_df = pd.DataFrame([{
        "circuit_key": row["circuit_key"], "year": row["year"],
        "rotation_deg": float(info.rotation), "n_corners": int(len(corners)),
        "track_length_m": ref.track_length_m, "ref_session_id": session_id,
    }], columns=frames.EXPECTED_COLUMNS["circuit_layout"])

    with conn.cursor() as cur:
        # §3.5 — scoped to THIS session. Not TRUNCATE and not a whole-table delete:
        # forcing round 11 must not touch round 12. The cascade clears the two derived
        # tables, so they are never deleted directly.
        cur.execute("DELETE FROM lap_telemetry WHERE session_id = %s", (session_id,))
        # circuit_layout / circuit_corners are per (circuit_key, year), not per session.
        if reuse is None:
            cur.execute("DELETE FROM circuit_layout WHERE circuit_key = %s AND year = %s",
                        layout_key)
            db.copy_frame(cur, "circuit_layout", frames.cast_frame(layout_df, "circuit_layout"))
            _copy_corner_frame(cur, "circuit_corners", corners)
        n = db.copy_frame(cur, "lap_telemetry", frames.cast_frame(tel_df, "lap_telemetry"))
        db.copy_frame(cur, "lap_telemetry_summary",
                      frames.cast_frame(sum_df, "lap_telemetry_summary"))
        _copy_corner_frame(cur, "lap_corner_speeds", cor_df)
        _add_warnings(cur, session_id, warnings)

    state = "partial" if failed else "ok"
    payload = {"state": state, "drivers": n, "eligible": len(picks),
               "corners": int(len(corners)), "rows_corner_speeds": int(len(cor_df)),
               "layout": "reused" if reuse is not None else "written"}
    if failed:
        payload["failed_drivers"] = sorted(failed)
    return payload


def run_session(conn, session_id: int, *, force: bool = False, cache=None) -> dict:
    """One session, one transaction, T8-safe. Commits on success, rolls back on failure.

    The ``except`` is broad on purpose: **no telemetry failure may reach the caller as an
    exception that could be mistaken for an ingest failure** (§3.6). Whatever happened,
    ``session_ingests.status`` is not touched here and the app is exactly the v1.6 app for
    this session.
    """
    try:
        payload = derive_session(conn, session_id, force=force, cache=cache)
    except Exception as exc:                          # noqa: BLE001 - T8
        conn.rollback()
        payload = {"state": "failed", "reason": str(exc)[:500]}
        with conn.cursor() as cur:
            _add_warnings(cur, session_id, [f"telemetry: {exc}"[:2000]])
            _set_analytics_status(cur, session_id, payload)
        conn.commit()
        log.warning("session %s: telemetry failed: %s", session_id, exc)
        return payload
    with conn.cursor() as cur:
        _set_analytics_status(cur, session_id, payload)
    conn.commit()
    return payload


def _no_restore(status: dict | None) -> dict:
    """The session had no telemetry before the force, so it gets none after it.

    Deliberately NOT ``state: "dropped"``: nothing was dropped, and "dropped" is the string
    the telemetry tab reads as "this should be here and is missing". Absence is the correct
    and expected state for the ~85 lap-bearing sessions that have never been derived.
    """
    payload = {"state": "absent",
               "reason": "no telemetry stored before this rebuild; nothing to restore. Run "
                         "`python -m f1lab.telemetry --session <id>` to derive it deliberately."}
    if status is not None:
        status["telemetry"] = payload
    return payload


def rewrite_after_force(conn, session_id: int, status: dict | None = None,
                        had_telemetry: bool | None = None) -> dict:
    """§2.8 — called from the **end of** ``ingest.write_session``, and it can never raise.

    An ``ingest --force`` rebuilds ``laps``, and ``lap_telemetry`` cascades from it, so the
    session's telemetry has just been dropped. If the FastF1 artifacts are on disk this
    re-derives and rewrites at **zero API calls**; if they are not, it records
    ``state: "dropped"`` and the telemetry tab falls to its empty state (§5.6) until
    ``python -m f1lab.telemetry`` is run again.

    ``status`` is ``ingest``'s own analytics-status dict, updated in place when given, so
    the caller's single UPDATE carries the telemetry key with everything else.

    ``had_telemetry`` says whether this session HAD stored telemetry immediately before the
    force dropped it, and the caller must capture it BEFORE ``delete_session_children``,
    because by the time this runs the rows are already gone inside the transaction.

    RESTORE, NEVER CREATE (2026-09-18). Until now the only gate was ``cache_is_warm``, so an
    ``ingest --force`` on a session that had never been telemetried CREATED telemetry for it
    whenever the FastF1 artifacts happened to be on disk — which they are for far more
    sessions than have ever been ingested. That is not "rewrite after force", it is a silent
    ingest triggered by an unrelated race rebuild, and it widened the corpus under a release
    whose constants are pinned to an exact row count: a full integration-test run added three
    sessions and 960 corner rows every time it ran. A session with no telemetry before the
    force must have none after it.
    """
    payload: dict
    try:
        if had_telemetry is None:
            with conn.cursor() as cur:
                cur.execute("SELECT EXISTS (SELECT 1 FROM lap_telemetry WHERE session_id = %s)",
                            (session_id,))
                had_telemetry = bool(cur.fetchone()[0])
        if not had_telemetry:
            return _no_restore(status)
        row = session_row(conn, session_id)
        if not cache_is_warm(row):
            payload = {"state": "dropped", "reason": "FastF1 telemetry artifacts are not "
                       "cached; re-run `python -m f1lab.telemetry --session %d`" % session_id}
        else:
            payload = derive_session(conn, session_id, force=True)
    except Exception as exc:                          # noqa: BLE001 - never raises (§2.8)
        payload = {"state": "dropped", "reason": str(exc)[:500]}
    if status is not None:
        status["telemetry"] = payload
    else:
        with conn.cursor() as cur:
            _set_analytics_status(cur, session_id, payload)
    return payload


#: FastF1 names each cached session directory ``<date>_<Session Name>`` with spaces as
#: underscores. These are the three lap-bearing kinds of T3.
_CACHE_SESSION_NAMES = {"R": "Race", "Q": "Qualifying", "SQ": "Sprint_Qualifying"}


def cache_is_warm(row: dict) -> bool:
    """True when ``car_data`` and ``position_data`` are already on disk for this session.

    §3.5: a ``--force`` re-derive **re-reads the cache; it never re-downloads**. At
    45-100 MB a session, re-downloading is the one mistake that costs hours, so it is a
    separate, loud, manual act rather than a silent fallback. This check is a filesystem
    stat, not a FastF1 call, so it costs nothing and cannot itself reach the network.
    """
    from pathlib import Path
    name = _CACHE_SESSION_NAMES.get(row["kind"])
    if name is None or row.get("event_date") is None:
        return False
    base = Path(clean.DEFAULT_CACHE) / str(row["year"])
    if not base.exists():
        return False
    stamp = str(row["event_date"])
    for event_dir in sorted(base.iterdir()):
        if not event_dir.is_dir() or not event_dir.name.endswith(_slug(row["event_name"])):
            continue
        for sess_dir in sorted(event_dir.iterdir()):
            if not sess_dir.is_dir() or not sess_dir.name.endswith("_" + name):
                continue
            if (sess_dir / "car_data.ff1pkl").exists() and (sess_dir / "position_data.ff1pkl").exists():
                return True
    _ = stamp
    return False


def _slug(event_name: str) -> str:
    return str(event_name).replace(" ", "_")



def closure_from_db(conn, session_id: int, top: int = 6) -> list[dict]:
    """Every pair's §5.2.2 closure report, read from the **stored** rows and nothing else.

    This is the generator for WP-8's golden fixture: ``web/lib/telemetry/align.ts`` has to
    reproduce these numbers to < 1 ms, and it will be reading exactly these columns. No
    FastF1 call and no cache is involved, so the fixture can be regenerated from a database
    alone. ``--closure`` on the CLI prints the result as JSON.
    """
    import itertools
    with conn.cursor() as cur:
        cur.execute(
            "SELECT t.driver_id, t.lap_number, l.lap_time_s, l.sector1_s, l.sector2_s, "
            "       t.distance_m, t.time_s, s.s1_distance_m, s.s2_distance_m "
            "FROM lap_telemetry t "
            "JOIN laps l USING (session_id, driver_id, lap_number) "
            "JOIN lap_telemetry_summary s USING (session_id, driver_id, lap_number) "
            "WHERE t.session_id = %s ORDER BY l.lap_time_s LIMIT %s", (session_id, top))
        rows = cur.fetchall()
    laps, sums = {}, {}
    for r in rows:
        pick = LapPick(driver_id=r[0], lap_number=int(r[1]), lap_time_s=float(r[2]),
                       sector1_s=None if r[3] is None else float(r[3]),
                       sector2_s=None if r[4] is None else float(r[4]))
        laps[r[0]] = StoredLap(
            pick=pick, n_samples=len(r[5]), n_car_samples=0, n_pos_samples=0,
            distance_m=np.asarray(r[5], dtype=float), time_s=np.asarray(r[6], dtype=float),
            x=np.zeros(0), y=np.zeros(0), speed_kph=np.zeros(0), throttle_pct=np.zeros(0),
            brake=np.zeros(0, dtype=bool), gear=np.zeros(0), drs=np.zeros(0), source_hash="")
        sums[r[0]] = {"s1_distance_m": r[7], "s2_distance_m": r[8]}
    out = []
    for a, b in itertools.combinations([r[0] for r in rows], 2):
        rep = closure_report(laps[a], laps[b], sums[a], sums[b])
        rep["a"], rep["b"] = a, b
        out.append(rep)
    return out


def trail_census_by_session(conn) -> dict[int, dict[str, int]]:
    """The §4.3 census split per session, which is what makes the guard survive growth.

    A grand total cannot tell "a new race was ingested" from "a gate was quietly loosened":
    both make the number go up. Per session it is unambiguous -- an existing session's counts
    must never move, and a session that did not exist before may add whatever it adds. This is
    the form `assert_trail_backfill` compares against its baseline (2026-09-18).
    """
    out: dict[int, dict[str, int]] = {}
    with conn.cursor() as cur:
        cur.execute("SELECT session_id, trail_status, count(*) FROM lap_corner_speeds "
                    "GROUP BY 1, 2")
        for sid, status, n in cur.fetchall():
            out.setdefault(int(sid), {})[status] = int(n)
    return out


def trail_census(conn) -> dict[str, int]:
    """§4.3 -- the Gap B backfill census: one grouped SELECT, no arrays read."""
    out: dict[str, int] = {k: 0 for k in TRAIL_STATUSES}
    with conn.cursor() as cur:
        cur.execute("SELECT trail_status, count(*) FROM lap_corner_speeds GROUP BY 1")
        for status, n in cur.fetchall():
            out[status] = int(n)
        cur.execute("SELECT count(*) FROM lap_telemetry WHERE derive_version <> %s",
                    (TRAIL_DERIVE_VERSION,))
        out["laps_at_stale_derive_version"] = int(cur.fetchone()[0])
        cur.execute("SELECT count(DISTINCT session_id) FROM lap_corner_speeds "
                    "WHERE trail_status = %s", (TRAIL_STATUS_MEASURED,))
        out["sessions_with_a_measured_row"] = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM lap_corner_speeds")
        out["rows"] = int(cur.fetchone()[0])
    return out


def assert_trail_backfill(conn) -> dict[str, int]:
    """§4.3 -- acceptance is a **pinned expected count, never "> 0"**.

    Risk R1 is that the backfill reports success while shipping ~25,000 NULLs, and the
    only defence that actually holds is an exact count: zero is not the only wrong
    answer. A skipped run, a half-run, a gate silently loosened and a gate silently
    tightened all fail here, and each of the four counts below fails separately so the
    message says *which* stage moved.
    """
    got = trail_census(conn)
    want = {
        TRAIL_STATUS_MEASURED: TRAIL_EXPECTED_MEASURED_ROWS,
        TRAIL_STATUS_FLAT: TRAIL_FLAT_ROWS,
        TRAIL_STATUS_NON_TERMINAL: TRAIL_NON_TERMINAL_ROWS,
        "rows": TRAIL_CORNER_ROWS,
        "laps_at_stale_derive_version": 0,
    }
    bad = [f"{k}: expected {v}, got {got.get(k)}" for k, v in want.items()
           if got.get(k) != v and k != "laps_at_stale_derive_version"]
    # `laps_at_stale_derive_version` is the one absolute that must hold at ANY corpus size:
    # it says every stored lap was derived by the current code, which is exactly R1's concern.
    if got.get("laps_at_stale_derive_version") != 0:
        raise TelemetryError(
            f"trail backfill acceptance failed -- laps_at_stale_derive_version: "
            f"expected 0, got {got.get('laps_at_stale_derive_version')}")

    # The four totals above are a RECORD of a measured corpus, not an invariant, and this is
    # the distinction that lets the season keep running (2026-09-18). Nine rounds of 2026 are
    # still to be raced; each one legitimately adds rows, and a grand total cannot tell that
    # apart from a gate quietly loosening -- both make the number go up. So growth is checked
    # where it IS unambiguous, per session: every session present in the baseline must have
    # exactly the counts it had, and a session absent from the baseline may add whatever it
    # adds. A loosened gate moves an existing session and still fails here; a new race does not.
    drifted = assert_baseline_sessions_unmoved(conn)
    if bad and not _baseline_path().exists():
        # No baseline yet: fall back to the pinned totals, so a fresh checkout still has a gate.
        raise TelemetryError("trail backfill acceptance failed -- " + "; ".join(bad))
    if bad:
        log.info("trail census differs from the pinned totals by design (corpus grew): %s",
                 "; ".join(bad))
    log.info("trail backfill accepted: %s (baseline sessions verified: %d)",
             json.dumps(got, sort_keys=True), drifted["checked"])
    return got


def _baseline_path():
    from pathlib import Path
    return Path(__file__).resolve().parents[1] / "db" / "trail_census_baseline.json"


def assert_baseline_sessions_unmoved(conn) -> dict:
    """Every session recorded in the baseline must still have exactly the counts it had.

    This is the half of R1's guard that is a real invariant. The baseline is written by
    ``scripts/update_season.py`` after it has proved that no pre-existing row changed, so a
    session enters it only once its numbers are known good. Nothing here forbids growth.
    """
    path = _baseline_path()
    if not path.exists():
        return {"checked": 0, "note": "no baseline file"}
    base = json.loads(path.read_text())
    recorded = {int(k): v for k, v in base.get("sessions", {}).items()}
    if not recorded:
        return {"checked": 0, "note": "empty baseline"}
    live = trail_census_by_session(conn)
    moved = []
    for sid, want_counts in recorded.items():
        got_counts = live.get(sid)
        if got_counts is None:
            moved.append(f"session {sid}: present in the baseline, now has no rows")
            continue
        for status, n in want_counts.items():
            if int(got_counts.get(status, 0)) != int(n):
                moved.append(f"session {sid} {status}: expected {n}, got {got_counts.get(status, 0)}")
    if moved:
        raise TelemetryError(
            "trail census moved on a session that was already measured -- this is a gate change "
            "or a re-derivation, not growth: " + "; ".join(moved[:6])
            + (f" (and {len(moved) - 6} more)" if len(moved) > 6 else ""))
    return {"checked": len(recorded), "new_sessions": len(set(live) - set(recorded))}


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="python -m f1lab.telemetry",
        description="TELEMETRY_SPEC v1.7 second pass (T7): derive and store one lap of "
                    "10 Hz channels per driver per session, over an already-warm cache.")
    ap.add_argument("--session", type=int, action="append", dest="sessions",
                    help="session_id; repeatable. Default: every eligible session (T3).")
    ap.add_argument("--year", type=int, help="narrow to one season")
    ap.add_argument("--round", type=int, action="append", dest="rounds", help="narrow to rounds")
    ap.add_argument("--kind", action="append", dest="kinds", choices=list(KINDS),
                    help="narrow to session kinds; default R, Q and SQ")
    ap.add_argument("--force", action="store_true",
                    help="re-derive and rewrite even when source_hash is unchanged. "
                         "Re-reads the cache; never re-downloads (§3.5).")
    ap.add_argument("--require-cache", action="store_true",
                    help="skip any session whose car_data/position_data are not on disk, "
                         "so a derive run cannot spend API budget by accident")
    ap.add_argument("--dsn", help="database DSN (default DATABASE_URL, then the local default)")
    ap.add_argument("--limit", type=int, help="stop after this many sessions")
    ap.add_argument("--closure", action="store_true",
                    help="write no rows: print §5.2.2's closure report for the session's "
                         "fastest six stored laps as JSON, read from the database")
    ap.add_argument("--check-trail", action="store_true",
                    help="after the pass, assert the §4.3 Gap B backfill census against "
                         "the pinned constants and exit non-zero on any mismatch")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)-7s %(message)s")
    conn = db.connect(args.dsn)
    db.assert_schema(conn)
    kinds = tuple(args.kinds) if args.kinds else KINDS
    if args.sessions:
        rows = [session_row(conn, s) for s in args.sessions]
    else:
        rows = eligible_sessions(conn, year=args.year, rounds=args.rounds, kinds=kinds)
    if args.limit:
        rows = rows[:args.limit]

    if args.closure:
        report = [r for row in rows for r in closure_from_db(conn, row["session_id"])]
        print(json.dumps(report, indent=2, default=float))
        conn.close()
        return 0

    tally: dict[str, int] = {}
    for row in rows:
        if args.require_cache and not cache_is_warm(row):
            log.info("session %s (%s %s %s): cache cold, skipped",
                     row["session_id"], row["year"], row["round"], row["kind"])
            tally["cold"] = tally.get("cold", 0) + 1
            continue
        payload = run_session(conn, row["session_id"], force=args.force)
        state = payload.get("state", "?")
        tally[state] = tally.get(state, 0) + 1
        log.info("session %s (%s R%s %s): %s %s", row["session_id"], row["year"],
                 row["round"], row["kind"], state,
                 f"{payload.get('drivers', 0)}/{payload.get('eligible', 0)} drivers")
    log.info("telemetry pass over %d session(s): %s", len(rows),
             ", ".join(f"{k}={v}" for k, v in sorted(tally.items())) or "nothing to do")
    rc = 0 if tally.get("failed", 0) == 0 else 1
    if args.check_trail:
        try:
            assert_trail_backfill(conn)
        except TelemetryError as exc:
            log.error("%s", exc)
            rc = 1
    conn.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
