"""f1lab.telemetry, Gap B (GAPFILL_SPEC v1.8): the trail-braking release half.

Fast by construction. Every unit test below builds its arrays in the test body -- no
FastF1, no cache, no session load -- and the four face-validity tests re-derive from
arrays already in Postgres for **one** named session each, which is a single indexed
SELECT and a few thousand numpy operations.

What is under test, in the order the derivation runs it:
  * `brake_zone_edges` is the index form of `brake_zones` and the two cannot drift;
  * `release_edge` is the midpoint of the bracketing sample step (§3.1, DL-15);
  * `trail_duty` is in [0, 1] **by construction**, which is the whole reason it and not
    the unbounded `trail_frac` survives shared zones (DL-18);
  * the five refusal gates of §3.2, each fired on its own constructed lap;
  * DL-17's exact `terminal`, including the tie that leaves both corners terminal;
  * the status/NULL pairing migration 0010 enforces in the database;
  * `derive_version` in the skip condition -- risk R1, guarded against deletion.
"""

from __future__ import annotations

import inspect

import numpy as np
import pytest

from f1lab import telemetry as T


def lap(distance, brake, speed=None, time=None, driver="test", number=1) -> T.StoredLap:
    """A StoredLap carrying only the channels the trail pass reads."""
    d = np.asarray(distance, dtype=float)
    b = np.asarray(brake, dtype=bool)
    v = np.full(len(d), 200.0) if speed is None else np.asarray(speed, dtype=float)
    t = (d / 50.0) if time is None else np.asarray(time, dtype=float)
    pick = T.LapPick(driver_id=driver, lap_number=number, lap_time_s=90.0,
                     sector1_s=30.0, sector2_s=60.0)
    return T.StoredLap(
        pick=pick, n_samples=len(d), n_car_samples=len(d), n_pos_samples=len(d),
        distance_m=d, time_s=t, x=np.zeros(len(d)), y=np.zeros(len(d)),
        speed_kph=v, throttle_pct=np.zeros(len(d)), brake=b,
        gear=np.zeros(len(d)), drs=np.zeros(len(d)), source_hash="x")


def ramp(n, step=5.0, start=0.0):
    return start + step * np.arange(n, dtype=float)


# --------------------------------------------------------------------------- §4.1

def test_the_six_status_words_are_exactly_the_ddl_vocabulary():
    # Migration 0010's lap_corner_speeds_trail_status_check. Six, spelled this way, in
    # this order. WP-B2's caption test pins all six strings, so a seventh word or a
    # renamed one is a schema break and a caption break at the same time.
    assert T.TRAIL_STATUSES == (
        "measured", "taken_flat", "shared_zone_non_terminal",
        "too_few_samples", "release_step_too_wide", "implied_decel_impossible")
    assert len(set(T.TRAIL_STATUSES)) == 6


# --------------------------------------------------------------------------- §3.0

def test_brake_zone_edges_and_brake_zones_cannot_drift():
    # §3.0's finding is that brake_zones already holds the release; the index form was
    # added so the bracketing step is reachable. If the two merge rules ever diverge,
    # brake_point_m (a stored, D7-frozen value) moves. They share one implementation and
    # this asserts it on a lap with a debounce gap short enough to merge and one long
    # enough not to.
    d = ramp(40)                                   # 0 .. 195 m, 5 m step
    b = np.zeros(40, dtype=bool)
    b[2:8] = True                                  # 10 .. 35 m
    b[10:14] = True                                # 50 .. 65 m  (15 m gap -> merges)
    b[30:36] = True                                # 150 .. 175 m (well clear -> separate)
    zones = T.brake_zones(d, b)
    edges = T.brake_zone_edges(d, b)
    assert len(zones) == len(edges) == 2
    assert [(d[a], d[z]) for a, z in edges] == zones
    assert zones[0] == (10.0, 65.0)                # merged, release = the later one
    assert zones[1] == (150.0, 175.0)


def test_release_edge_is_the_midpoint_of_the_bracketing_step():
    # DL-15. The boolean flipped somewhere in [d[last_on], d[last_on+1]] and the arrays
    # cannot say where; the midpoint is the unbiased reading and the step is the
    # measurement's own resolution -- the quantity R4 gates on, and the quantity the
    # caption's "+-4 m at the median" comes from.
    d = np.array([0.0, 10.0, 22.0, 40.0])
    rel, step = T.release_edge(d, 1)
    assert rel == pytest.approx(16.0)              # 0.5 * (10 + 22)
    assert step == pytest.approx(12.0)
    # The lap's last sample still reads brake = true: no bracketing sample exists, so the
    # release is the sample itself and the step that led into it is what R4 judges.
    rel, step = T.release_edge(d, 3)
    assert rel == pytest.approx(40.0)
    assert step == pytest.approx(18.0)
    rel, step = T.release_edge(np.array([7.0]), 0)
    assert rel == 7.0 and not np.isfinite(step)    # R4 refuses it


def test_trail_duty_is_bounded_by_construction():
    # DL-18. The unbounded edge definition put trail_frac > 1 on 11 % of corner-laps and
    # as high as 3.79; a duty cycle over [onset, apex] cannot leave [0, 1] whatever the
    # zone does, which is why it is the refusal-resistant diagnostic. Never rendered.
    d = ramp(60)
    for seed in range(25):
        rng = np.random.default_rng(seed)
        b = rng.random(60) < 0.5
        for lo, hi in ((0.0, 295.0), (37.0, 158.0), (100.0, 101.0), (-20.0, 400.0)):
            duty = T.trail_duty(d, b, lo, hi)
            assert duty is None or 0.0 <= duty <= 1.0
    assert T.trail_duty(d, np.ones(60, dtype=bool), 10.0, 100.0) == pytest.approx(1.0)
    assert T.trail_duty(d, np.zeros(60, dtype=bool), 10.0, 100.0) == pytest.approx(0.0)
    assert T.trail_duty(d, np.ones(60, dtype=bool), 100.0, 100.0) is None


# --------------------------------------------------------------------------- §4.2

def two_corner_lap(release_idx=122, onset_idx=50, apex_a=400.0, apex_b=600.0, n=200):
    """One 995 m lap, one merged brake application, two corners served by it."""
    d = ramp(n)
    v = (220.0
         - 160.0 * np.exp(-((d - apex_a) / 70.0) ** 2)
         - 165.0 * np.exp(-((d - apex_b) / 70.0) ** 2))
    b = np.zeros(n, dtype=bool)
    b[onset_idx:release_idx + 1] = True
    return lap(d, b, speed=v, time=d / 10.0), np.array([apex_a, apex_b])


def test_shared_zone_charges_the_release_to_the_last_corner_only():
    # §3.2 R2, the largest single refusal. brake_zones merges with max(prev_off, release),
    # so a merged application has exactly ONE release and it belongs to the last corner of
    # the complex. Charging it to the first would report "still braking past the apex" for
    # a corner the driver was already off the brakes for.
    sl, corners = two_corner_lap()
    m = T.corner_metrics(sl, corners)
    assert [r["brake_zone_idx"] for r in m] == [0, 0]          # one shared application
    assert m[0]["trail_status"] == "shared_zone_non_terminal"
    assert m[1]["trail_status"] == "measured"
    # the non-terminal corner keeps brake_point_m and brake_distance_m -- an onset is
    # shared honestly -- and stores trail_duty, which §4.1 exempts from the release CHECK
    assert m[0]["brake_point_m"] == pytest.approx(250.0)
    assert m[0]["brake_release_m"] is None
    assert 0.0 <= m[0]["trail_duty"] <= 1.0
    assert m[1]["brake_release_m"] == pytest.approx(612.5)     # midpoint of 610 -> 615
    assert m[1]["brake_release_to_apex_m"] == pytest.approx(-12.5)   # still braking AT it
    assert m[1]["brake_on_distance_m"] == pytest.approx(362.5)


def test_a_tie_in_apex_distance_leaves_both_corners_terminal():
    # DL-17, read exactly: terminal iff no other corner of the zone has a **strictly
    # greater** apex_distance_m. The word "strictly" is the whole of the 8,870-vs-8,991
    # disagreement, so it gets its own test rather than a comment.
    sl, corners = two_corner_lap()
    m = T.corner_metrics(sl, corners)
    forced = [dict(r) for r in m]
    for r in forced:
        r["apex_distance_m"] = 600.0
    T._apply_trail(sl, forced, T.brake_zone_edges(sl.distance_m, sl.brake))
    assert [r["trail_status"] for r in forced] == ["measured", "measured"]


# --------------------------------------------------------------------------- §3.2

def one_corner(d, b, v, apex=300.0, t=None):
    sl = lap(d, b, speed=v, time=(d / 10.0) if t is None else t)
    return T.corner_metrics(sl, np.array([apex]))[0]


def test_r1_a_corner_taken_flat_is_a_positive_report_not_a_gap():
    # C-TEL-6 / §4.1: NULL, never 0. Monza 15923 T3 is the shipped instance -- 20 laps,
    # 0 braked, a 282 km/h apex -- and it must read taken_flat, not "no data".
    d = ramp(120)
    m = one_corner(d, np.zeros(120, dtype=bool), np.full(120, 280.0))
    assert m["trail_status"] == "taken_flat"
    assert m["brake_point_m"] is None and m["brake_distance_m"] is None
    assert m["brake_release_m"] is None and m["brake_release_to_apex_m"] is None
    assert m["brake_on_distance_m"] is None and m["trail_duty"] is None


def test_r3_refuses_a_zone_with_too_few_brake_samples():
    d = ramp(120)
    b = np.zeros(120, dtype=bool)
    b[50:50 + T.TRAIL_MIN_ZONE_SAMPLES - 1] = True      # one short of the floor
    v = 220.0 - 150.0 * np.exp(-((d - 300.0) / 60.0) ** 2)
    m = one_corner(d, b, v)
    assert m["trail_status"] == "too_few_samples"
    assert m["brake_release_m"] is None
    b[50:50 + T.TRAIL_MIN_ZONE_SAMPLES] = True          # exactly the floor: measured
    assert one_corner(d, b, v)["trail_status"] == "measured"


def test_r4_refuses_a_release_edge_wider_than_the_gate():
    # DL-16. The gate is 2x the re-derived release-edge p95, and it judges the step the
    # boolean actually flipped across -- not the window median (4.13 m) and not the
    # window maximum. A 30 m bracket cannot locate a release to +-12 m.
    d = np.concatenate([ramp(60), np.array([300.0, 330.0]), ramp(20, start=340.0)])
    b = np.zeros(len(d), dtype=bool)
    b[40:61] = True                                     # last brake-on sample at 300 m
    v = np.full(len(d), 220.0)
    v[55:75] = np.linspace(220.0, 70.0, 20)
    m = one_corner(d, b, v, apex=360.0)
    assert d[61] - d[60] == 30.0 > T.TRAIL_MAX_RELEASE_STEP_M
    assert m["trail_status"] == "release_step_too_wide"
    assert m["brake_release_m"] is None and m["trail_duty"] is not None


def test_r5_refuses_an_impossible_implied_deceleration():
    # §4.5: differentiated against time_s, never against distance_m. 6.5 g is 229 km/h
    # per second; nothing on a track does that, so a sample pair that claims it is a
    # channel artefact and the whole zone is refused.
    d = ramp(120)
    t = d / 50.0                                        # 0.1 s per 5 m sample
    b = np.zeros(120, dtype=bool)
    b[40:56] = True
    v = 220.0 - 150.0 * np.exp(-((d - 300.0) / 60.0) ** 2)
    assert one_corner(d, b, v, t=t)["trail_status"] == "measured"
    v[42] = v[41] - 40.0            # 40 km/h in 0.1 s = 11.3 g, and still far above apex
    assert one_corner(d, b, v, t=t)["trail_status"] == "implied_decel_impossible"


# --------------------------------------------------------------------------- §4.1/§4.3

def test_every_corner_row_satisfies_the_status_null_pairing_check():
    # The invariant migration 0010 enforces in the database: the three release numbers
    # are NULL together, always -- one CHECK, not three chances to disagree. Asserting it
    # here as well means a derivation bug surfaces as a red test rather than as a COPY
    # that the database rejects halfway through a session's transaction.
    cases = [two_corner_lap()]
    d = ramp(120)
    v = 220.0 - 150.0 * np.exp(-((d - 300.0) / 60.0) ** 2)
    for on, off in ((40, 56), (50, 53), (0, 119)):
        b = np.zeros(120, dtype=bool)
        b[on:off] = True
        cases.append((lap(d, b, speed=v, time=d / 10.0), np.array([300.0])))
    cases.append((lap(d, np.zeros(120, dtype=bool), speed=np.full(120, 280.0)),
                  np.array([300.0])))
    seen = set()
    for sl, corners in cases:
        for m in T.corner_metrics(sl, corners):
            seen.add(m["trail_status"])
            assert m["trail_status"] in T.TRAIL_STATUSES
            three = (m["brake_release_m"], m["brake_release_to_apex_m"],
                     m["brake_on_distance_m"])
            if m["trail_status"] == "measured":
                assert all(x is not None for x in three)
                assert m["brake_point_m"] is not None
            else:
                assert all(x is None for x in three)
    assert {"measured", "taken_flat", "shared_zone_non_terminal"} <= seen


def test_the_pinned_census_partitions_without_remainder():
    # §9. Four counts that must add up, so a constant edited in isolation is caught by
    # arithmetic rather than by a 40-minute re-derive.
    assert T.TRAIL_CORNER_ROWS == T.TRAIL_FLAT_ROWS + T.TRAIL_BRAKED_ROWS
    assert T.TRAIL_BRAKED_ROWS == T.TRAIL_NON_TERMINAL_ROWS + T.TRAIL_TERMINAL_ROWS
    assert T.TRAIL_TERMINAL_ROWS == (T.TRAIL_EXPECTED_MEASURED_ROWS + T.TRAIL_R3_COST_ROWS
                                     + T.TRAIL_R4_COST_ROWS + T.TRAIL_R5_COST_ROWS)
    assert T.TRAIL_CORNER_ROWS == 44_926 and T.TRAIL_NON_TERMINAL_ROWS == 16_446
    # DL-16: the gate is ~2x the re-derived release-edge p95. If someone re-derives the
    # p95 and leaves the gate alone, or the reverse, this says so.
    assert 1.7 <= T.TRAIL_MAX_RELEASE_STEP_M / T.TRAIL_RELEASE_STEP_P95_M <= 2.3


def test_derive_version_is_in_the_skip_condition():
    # RISK R1, the highest-risk defect in Gap B, guarded the way §7 R2 guards its own:
    # source_hash covers the raw channels, not the derivation, so every lap hashes
    # identically after migration 0010 and a hash-only skip ships ~25,000 NULLs while the
    # build exits 0. Deleting either half of this condition is the failure, so deleting
    # it must break a test rather than turn one green.
    src = inspect.getsource(T.derive_session)
    assert "TRAIL_DERIVE_VERSION" in src and "unchanged" in src
    assert "derive_version" in inspect.getsource(T.stored_hashes)
    assert "derive_version" in inspect.getsource(T._telemetry_frame)
    assert T.TRAIL_DERIVE_VERSION == 2


# --------------------------------------------------------------------------- §6.3 B1

def rederive(conn, session_id: int) -> list[dict]:
    """Re-run pass 2 over one session's STORED arrays, with no FastF1 and no write.

    Every input the trail pass reads is already in Postgres -- `lap_telemetry` carries
    distance_m / time_s / speed_kph / brake, `lap_corner_speeds` carries
    apex_distance_m / brake_point_m / brake_zone_idx -- so this reproduces exactly what
    `warm`ing with --force would store, which is what makes it a legitimate face-validity
    check while WP-S1 still holds `f1lab/frames.py` (§6.2) and the backfill cannot run.
    """
    from collections import defaultdict
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id, lap_number, distance_m, time_s, speed_kph, brake "
                    "FROM lap_telemetry WHERE session_id = %s", (session_id,))
        laps = {(r[0], int(r[1])): lap(r[2], r[5], speed=r[4], time=r[3],
                                       driver=r[0], number=int(r[1]))
                for r in cur.fetchall()}
        cur.execute("SELECT driver_id, lap_number, corner_number, apex_distance_m, "
                    "brake_point_m, brake_zone_idx FROM lap_corner_speeds "
                    "WHERE session_id = %s", (session_id,))
        rows = cur.fetchall()
    per = defaultdict(list)
    for r in rows:
        per[(r[0], int(r[1]))].append(r)
    out = []
    for key, crows in per.items():
        sl = laps[key]
        edges = T.brake_zone_edges(sl.distance_m, sl.brake)
        ms = []
        for r in crows:
            ms.append({"corner_number": r[2], "apex_distance_m": float(r[3]),
                       "brake_point_m": None if r[4] is None else float(r[4]),
                       "brake_zone_idx": r[5], "driver_id": r[0], "lap_number": int(r[1]),
                       "brake_release_m": None, "brake_release_to_apex_m": None,
                       "brake_on_distance_m": None, "trail_duty": None,
                       "trail_status": T.TRAIL_STATUS_FLAT})
        T._apply_trail(sl, ms, edges)
        out.extend(ms)
    return out


@pytest.mark.db
def test_monza_15923_turn_3_is_taken_flat_on_all_twenty_laps(db_conn):
    # §4.1's worked example, and the reason "absent is not zero" is a CHECK rather than a
    # convention: T3 at a 282 km/h apex is a corner nobody brakes for. It is a positive
    # report (C-BRK-4), not a gap, and it must never read 0 m.
    rows = [r for r in rederive(db_conn, 15923) if r["corner_number"] == 3]
    assert len(rows) == 20
    assert len({(r["driver_id"], r["lap_number"]) for r in rows}) == 20
    assert {r["trail_status"] for r in rows} == {"taken_flat"}
    assert all(r["brake_release_to_apex_m"] is None for r in rows)
    assert all(r["brake_point_m"] is None for r in rows)


@pytest.mark.db
def test_monza_turn_2_trails_positive(db_conn):
    # §3.1's face validity: Rettifilo's exit is a 71 km/h corner off a 340 km/h straight,
    # braked hard and early, brake off before the apex. Positive, and firmly so.
    rows = [r for r in rederive(db_conn, 15923)
            if r["corner_number"] == 2 and r["trail_status"] == "measured"]
    assert len(rows) >= 10
    med = float(np.median([r["brake_release_to_apex_m"] for r in rows]))
    assert med > 0.0
    assert all(r["brake_on_distance_m"] > 0.0 for r in rows)


@pytest.mark.db
def test_monaco_turn_7_does_not_reproduce_the_spec_face_validity_figure(db_conn):
    """MEASURED, reported, and deliberately not patched over.

    `GAPFILL_SPEC §3.1` pins Monaco T7 (Grand Hotel hairpin) at a median
    `brake_release_to_apex_m` of **-40.5 m**. Re-derived under §3.1's own definition --
    the release of the **serving** zone, i.e. `zones[brake_zone_idx][1]`, which §4.2
    forbids changing and D7 freezes -- the Monte Carlo T7 median is **positive, around
    +150 m**, because at the hairpin the serving zone is a long earlier application and
    the driver brakes AGAIN, after a >= 20 m coast, between that release and the apex.
    17.0 % of the 9,408 measurable rows have `brake = true` somewhere in
    `(brake_release_m, apex_distance_m]` for exactly this reason.

    This test asserts the measurement, not the expectation, so the disagreement is
    mechanical and cannot be lost. WP-B2 must not build a caption on -40.5 m.
    """
    rows = [r for r in rederive(db_conn, 15905)
            if r["corner_number"] == 7 and r["trail_status"] == "measured"]
    assert rows
    med = float(np.median([r["brake_release_to_apex_m"] for r in rows]))
    assert med > 100.0, f"re-derived Monte Carlo T7 median {med:.1f} m; spec §3.1 says -40.5 m"


@pytest.mark.db
def test_the_rederivation_reproduces_every_stored_brake_point(db_conn):
    # The proof that pass 2 is additive: pass 1's zone selection is untouched, so every
    # stored brake_point_m comes back byte-identical off the stored arrays. D7's "no
    # stored measured number may change silently" checked at the source, not after.
    for session_id in (15923, 15905):
        rows = rederive(db_conn, session_id)
        assert rows
        for r in rows:
            if r["brake_zone_idx"] is None:
                assert r["trail_status"] == "taken_flat"


@pytest.mark.db
@pytest.mark.cache
def test_a_wholesale_failure_reports_why_not_just_how_many(db_conn):
    """2026-09-18 — the payload carries the actual reasons, not only a count.

    Monaco 2026 R6 (session 429) fails on every one of 21 drivers. Before this, the stored
    payload said only "every eligible driver failed (21)" and the real message lived in
    `session_ingests.warnings`, a column nothing points to, so diagnosing it took three
    queries. `distinct_reasons` is the useful part: ONE reason across every driver means the
    session is broken, several would mean the drivers are.

    Rolled back, so this asserts the payload without writing.
    """
    payload = T.derive_session(db_conn, 429, force=True)
    db_conn.rollback()
    assert payload["state"] == "failed"
    assert payload["drivers"] == 0
    assert payload["distinct_reasons"] == 1, payload
    assert payload["reasons"], "a failed session must say why"
    assert "Date" in payload["reasons"][0], payload["reasons"]
    assert "(x21)" in payload["reasons"][0], "repeated reasons carry their count"
