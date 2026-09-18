"""Race moments and optimal stint length — MODE1_SPEC §4, §6.6 tests 14–17.

The two pinned regression tests are ``test_moments_silverstone_2025_single_cliff``
(the field-relative fix: eleven simultaneous cliff claims became one) and
``test_undercut_british_2024`` (the victim's places-lost sign).

``db``-marked tests read the stored tables through ``moments.build_ctx``, which is the
same context the FastF1 path builds, so a detector is exercised identically either way.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from f1lab import config, frames, moments

pytestmark = []


def _q(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


def _session_id(conn, year: int, rnd: int) -> int:
    row = _q(conn, "SELECT session_id FROM sessions WHERE year=%s AND round=%s AND kind='R'", (year, rnd))
    assert len(row) == 1, f"no race session for {year} R{rnd}"
    return int(row["session_id"].iloc[0])


def _ctx(conn, year: int, rnd: int) -> dict:
    sid = _session_id(conn, year, rnd)
    laps = _q(conn, "SELECT driver_id, lap_number, stint, compound, tyre_life, position, lap_time_s, "
                    "pit_in_time_s, pit_out_time_s FROM laps WHERE session_id=%s", (sid,))
    lap_status = _q(conn, "SELECT lap_number, is_green FROM lap_status WHERE session_id=%s", (sid,))
    pits = _q(conn, "SELECT driver_id, lap_in, lap_out FROM pit_stops WHERE session_id=%s", (sid,))
    stints = _q(conn, "SELECT driver_id, stint, compound, start_lap, end_lap, laps "
                      "FROM stints WHERE session_id=%s", (sid,))
    results = _q(conn, "SELECT driver_id, status, position FROM results WHERE session_id=%s", (sid,))
    total = _q(conn, "SELECT total_laps FROM sessions WHERE session_id=%s", (sid,))["total_laps"].iloc[0]
    return moments.build_ctx(laps, lap_status, pits, stints, results, int(total or 0))


# ---------------------------------------------------------------------------
# §4.1 — the field-relative rule and its blanket suppression (no database needed)
# ---------------------------------------------------------------------------

def _synth_laps(times: dict[str, list[float]]) -> pd.DataFrame:
    rows = []
    for drv, ts in times.items():
        for i, t in enumerate(ts, start=1):
            rows.append({"driver_id": drv, "lap_number": i, "stint": 1, "compound": "HARD",
                         "tyre_life": i, "position": 1, "lap_time_s": t,
                         "pit_in": False, "pit_out": False})
    return pd.DataFrame(rows)


def test_rel_pace_is_blind_to_a_field_wide_slowdown():
    """A track that slows every car by the same amount must move no rel_s (§4.1)."""
    base = {"a": [90.0, 90.0, 90.0], "b": [91.0, 91.0, 91.0], "c": [92.0, 92.0, 92.0]}
    slow = {d: [t if i != 2 else t + 5.0 for i, t in enumerate(ts, start=1)] for d, ts in base.items()}
    r1 = moments.rel_pace(_synth_laps(base))["rel_s"].to_numpy()
    r2 = moments.rel_pace(_synth_laps(slow))["rel_s"].to_numpy()
    assert np.allclose(r1, r2)


def test_rel_pace_counts_running_cars():
    laps = _synth_laps({"a": [90.0, 90.0], "b": [91.0, 91.0], "c": [92.0, np.nan]})
    out = moments.rel_pace(laps)
    assert out.loc[out["lap_number"] == 1, "n_running"].iloc[0] == 3
    assert out.loc[out["lap_number"] == 2, "n_running"].iloc[0] == 2


def test_suppress_field_wide_drops_the_cluster_not_the_singleton():
    """Eleven cars do not hit the cliff on the same lap; one car might (§4.1)."""
    df = moments._candidates(
        [{"moment_type": "tyre_cliff", "lap_number": 49, "driver_id": f"d{i}", "other_driver_id": None,
          "magnitude": 2.0, "magnitude_unit": "s", "severity": 0.0, "confidence": "likely",
          "detail": ""} for i in range(11)]
        + [{"moment_type": "tyre_cliff", "lap_number": 35, "driver_id": "tsunoda", "other_driver_id": None,
            "magnitude": 2.0, "magnitude_unit": "s", "severity": 0.0, "confidence": "likely",
            "detail": ""}])
    n_running = pd.Series({49: 20, 35: 20})
    kept = moments.suppress_field_wide(df, n_running, config.MOMENTS_FIELD_WIDE_SHARE)
    assert list(kept["lap_number"]) == [35]
    assert list(kept["driver_id"]) == ["tsunoda"]


def test_suppress_field_wide_keeps_an_empty_frame_usable():
    out = moments.suppress_field_wide(moments._no_candidates(), pd.Series(dtype=int), 0.3)
    assert list(out.columns) == list(moments.MOMENT_CANDIDATE_COLUMNS)
    assert len(out) == 0


# ---------------------------------------------------------------------------
# §4.4 — the break-even formula and its guards (no database needed)
# ---------------------------------------------------------------------------

def test_optimal_laps_reproduces_the_shipped_numbers():
    """MEASURED §4.4 with T = 22.4 s: SOFT 26.7, MEDIUM 29.1, HARD 30.3 laps."""
    assert round(moments.optimal_laps(22.4, 0.0629, 70), 1) == 26.7
    assert round(moments.optimal_laps(22.4, 0.0529, 70), 1) == 29.1
    assert round(moments.optimal_laps(22.4, 0.0488, 70), 1) == 30.3


def test_optimal_laps_is_clipped_to_the_race():
    """The SOFT upper bound of 122 laps is absurd and is clipped, not hidden (§4.4)."""
    assert moments.optimal_laps(22.4, 0.0030, 70) == 70.0
    assert moments.optimal_laps(22.4, 10.0, 70) == 5.0


def test_optimal_stint_ordering_is_softer_tyre_shorter_stint():
    ns = [moments.optimal_laps(22.4, k, 70) for k in (0.0629, 0.0529, 0.0488)]
    assert ns[0] < ns[1] < ns[2]


class _FakeIds:
    session_id = 1
    code_to_driver_id: dict[str, str] = {}
    team_name_to_team_id: dict[str, str] = {}


class _FakeSession:
    """Just enough of a FastF1 session for build_optimal_stint's guard paths."""

    total_laps = 70
    session_info = {"Meeting": {"Circuit": {"Key": 999}}}


def _fits(**by_compound: int) -> pd.DataFrame:
    """A ``_session_slopes`` frame: n fits of the given slope per compound."""
    rows = [(c, float(k)) for c, (n, k) in by_compound.items() for _ in range(n)]
    return pd.DataFrame(rows, columns=["compound", "deg_s_per_lap"])


def test_optimal_stint_refuses_flat_slope(monkeypatch):
    """§6.6 test 17: k below OPT_STINT_MIN_SLOPE produces no row, not a four-figure n*."""
    monkeypatch.setattr(moments, "_session_slopes", lambda s: _fits(HARD=(8, 0.004)))
    stints = pd.DataFrame({"Driver": ["a", "b"], "Stint": [1, 1], "Compound": ["HARD", "HARD"],
                           "start_lap": [1, 1], "end_lap": [20, 20], "laps": [20, 20]})
    import f1lab.clean as clean_mod
    monkeypatch.setattr(clean_mod, "stint_table", lambda s: stints)
    pooled = {"pit_loss_by_circuit": {999: 22.4},
              "slope_by_compound": {"HARD": {"n_fits": 100, "median": 0.004, "q1": 0.001, "q3": 0.02}}}
    assert moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, pooled) is None
    monkeypatch.setattr(moments, "_session_slopes", lambda s: _fits(HARD=(8, 0.0488)))
    out = moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, pooled)
    assert list(out["compound"]) == ["HARD"]
    assert out["slope_source"].iloc[0] == "session"
    assert out["pit_loss_source"].iloc[0] == "circuit"
    assert round(float(out["optimal_laps"].iloc[0]), 1) == 30.3
    assert float(out["actual_median_laps"].iloc[0]) == 20.0


def test_optimal_stint_is_empty_when_the_race_has_no_dry_fits(monkeypatch):
    """§4.5: a wet race must not borrow the database-wide dry break-even.

    Regression for 2025 R1 (Australia), whose ``degradation_fits`` hold 31 INTERMEDIATE
    rows and nothing dry, yet which stored two pooled rows carrying the whole-database
    1127/1100 fit counts as if they were this race's evidence.
    """
    import f1lab.clean as clean_mod
    monkeypatch.setattr(moments, "_session_slopes", lambda s: _fits(INTERMEDIATE=(31, -0.17)))
    monkeypatch.setattr(clean_mod, "stint_table", lambda s: pd.DataFrame(
        {"Driver": ["a", "b"], "Stint": [2, 2], "Compound": ["MEDIUM", "HARD"],
         "start_lap": [40, 40], "end_lap": [51, 51], "laps": [11, 11]}))
    pooled = {"pit_loss_by_circuit": {999: 22.4},
              "slope_by_compound": {"MEDIUM": {"n_fits": 1127, "median": 0.0529, "q1": 0.0091, "q3": 0.0960},
                                    "HARD": {"n_fits": 1100, "median": 0.0488, "q1": 0.0162, "q3": 0.0824}}}
    assert moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, pooled) is None


def test_optimal_stint_keeps_the_pooled_fallback_when_the_race_ran_dry(monkeypatch):
    """§4.4: the gate is per race, the fallback stays per compound.

    MEDIUM clears OPT_STINT_MIN_SESSION_FITS on its own, so the race is a dry one and
    HARD -- run, but with too few fits of its own -- still takes the pooled slope.
    """
    import f1lab.clean as clean_mod
    monkeypatch.setattr(moments, "_session_slopes",
                        lambda s: _fits(MEDIUM=(6, 0.0529), HARD=(2, 0.0488)))
    monkeypatch.setattr(clean_mod, "stint_table", lambda s: pd.DataFrame(
        {"Driver": ["a", "b"], "Stint": [1, 2], "Compound": ["MEDIUM", "HARD"],
         "start_lap": [1, 22], "end_lap": [21, 50], "laps": [21, 29]}))
    pooled = {"pit_loss_by_circuit": {999: 22.4},
              "slope_by_compound": {"HARD": {"n_fits": 1100, "median": 0.0488, "q1": 0.0162, "q3": 0.0824}}}
    out = moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, pooled)
    assert list(out["compound"]) == ["HARD", "MEDIUM"]
    assert list(out["slope_source"]) == ["pooled", "session"]
    assert list(out["n_fits"]) == [1100, 6]


def test_optimal_stint_needs_a_pit_loss(monkeypatch):
    """§4.5: no circuit hazard row and no pooled pit loss -> whole readout empty."""
    import f1lab.clean as clean_mod
    monkeypatch.setattr(clean_mod, "stint_table", lambda s: pd.DataFrame(
        {"Driver": ["a"], "Stint": [1], "Compound": ["HARD"], "start_lap": [1],
         "end_lap": [20], "laps": [20]}))
    assert moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, {}) is None


def test_optimal_stint_excludes_wet_compounds(monkeypatch):
    """§4.4 assumption 4: INTERMEDIATE fits a negative slope because the track dries."""
    import f1lab.clean as clean_mod
    monkeypatch.setattr(moments, "_session_slopes",
                        lambda s: pd.DataFrame({"compound": [], "deg_s_per_lap": []}))
    monkeypatch.setattr(clean_mod, "stint_table", lambda s: pd.DataFrame(
        {"Driver": ["a"], "Stint": [1], "Compound": ["INTERMEDIATE"], "start_lap": [1],
         "end_lap": [12], "laps": [12]}))
    pooled = {"pit_loss_pooled_s": 22.4,
              "slope_by_compound": {"INTERMEDIATE": {"n_fits": 115, "median": -0.1705,
                                                     "q1": -0.3, "q3": 0.05}}}
    assert moments.build_optimal_stint(_FakeSession(), _FakeIds(), 1, pooled) is None


# ---------------------------------------------------------------------------
# §4.2 / §4.3 — the detectors against the stored races
# ---------------------------------------------------------------------------

@pytest.mark.db
def test_moments_silverstone_2025_single_cliff(db_conn):
    """§6.6 test 14. The absolute-pace rule fired for eleven drivers on lap 49 of this
    race; field-relative pace leaves exactly one cliff, Tsunoda on lap 35 (§4.3)."""
    ctx = _ctx(db_conn, 2025, 12)
    cliffs = moments.detect_tyre_cliff(ctx)
    assert len(cliffs) == 1, cliffs[["lap_number", "driver_id"]].to_dict("records")
    assert cliffs["driver_id"].iloc[0] == "tsunoda"
    assert int(cliffs["lap_number"].iloc[0]) == 35


@pytest.mark.db
def test_undercut_british_2024(db_conn):
    """§6.6 test 15. Hamilton stops L38, Norris L39, Hamilton ahead from L40, and the
    magnitude is the victim's position change (positive = places lost, §4.2)."""
    ctx = _ctx(db_conn, 2024, 12)
    uc = moments.detect_undercut(ctx)
    hit = uc[(uc["driver_id"] == "hamilton") & (uc["other_driver_id"] == "norris")]
    assert len(hit) == 1, uc.to_dict("records")
    assert int(hit["lap_number"].iloc[0]) == 38
    assert hit["magnitude_unit"].iloc[0] == "places"
    assert float(hit["magnitude"].iloc[0]) > 0


@pytest.mark.db
def test_undercut_italian_2024_norris_over_leclerc(db_conn):
    """The second raw-table confirmation of the undercut rule (§4.3)."""
    ctx = _ctx(db_conn, 2024, 16)
    uc = moments.detect_undercut(ctx)
    hit = uc[(uc["driver_id"] == "norris") & (uc["other_driver_id"] == "leclerc")]
    assert len(hit) == 1 and int(hit["lap_number"].iloc[0]) == 14


@pytest.mark.db
def test_undercut_hungarian_2024_norris_over_piastri(db_conn):
    ctx = _ctx(db_conn, 2024, 13)
    uc = moments.detect_undercut(ctx)
    hit = uc[(uc["driver_id"] == "norris") & (uc["other_driver_id"] == "piastri")]
    assert len(hit) == 1 and int(hit["lap_number"].iloc[0]) == 45


@pytest.mark.db
def test_safety_car_luck_australia_2025(db_conn):
    """§4.3: the decisive window of 2025 R1 is lap 44 -- a cluster of lucky stops plus
    two undercuts, which §1's independent model puts at lap 46."""
    ctx = _ctx(db_conn, 2025, 1)
    luck = moments.detect_sc_luck(ctx)
    assert len(luck) >= 4
    assert set(luck["lap_number"]) == {44}
    assert {"antonelli", "hulkenberg", "stroll", "albon"} <= set(luck["driver_id"])
    uc = moments.detect_undercut(ctx)
    assert int((uc["lap_number"] == 44).sum()) == 2


@pytest.mark.db
def test_safety_car_luck_relative_clause_bites(db_conn):
    """When the whole field pits under a safety car nobody has been lucky (§4.2)."""
    ctx = _ctx(db_conn, 2025, 12)
    luck = moments.detect_sc_luck(ctx)
    assert len(luck) == 1
    assert luck["driver_id"].iloc[0] == "albon" and int(luck["lap_number"].iloc[0]) == 42


@pytest.mark.db
@pytest.mark.parametrize("year,rnd,driver,lap", [(2024, 9, "leclerc", 30), (2026, 12, "albon", 65)])
def test_damage_named_checks(db_conn, year, rnd, driver, lap):
    """Both cars ran a lap many seconds off their own rhythm, pitted and retired (§4.3)."""
    dmg = moments.detect_damage(_ctx(db_conn, year, rnd))
    hit = dmg[(dmg["driver_id"] == driver) & (dmg["lap_number"] == lap)]
    assert len(hit) == 1, dmg.to_dict("records")
    assert float(hit["magnitude"].iloc[0]) >= config.PUNCTURE_S
    assert hit["confidence"].iloc[0] == "high"


@pytest.mark.db
def test_optimal_stint_uses_degradation_fits(db_conn):
    """§6.6 test 16. The medians come from the 416/1140/1126 per-stint fits, not from
    compound_degradation's 43/58/58 median-of-medians, and n* orders SOFT < MEDIUM < HARD."""
    from f1lab import ingest

    # MEASURED 2026-09-13: 2026 R14 Madrid raced and added 45 fits (SOFT 6, MEDIUM 13, HARD 26),
    # moving 410/1127/1100 -> 416/1140/1126 and 0.0629/0.0529/0.0488 -> 0.0635/0.0528/0.0483.
    # Re-running the same query with R14 excluded still reproduces the old values exactly, so
    # Madrid joining the pool accounts for the whole change. INTERMEDIATE is untouched (115 / -0.1705).
    pooled = ingest.load_pooled_stint(db_conn)["slope_by_compound"]
    assert round(pooled["SOFT"]["median"], 4) == 0.0635
    assert round(pooled["MEDIUM"]["median"], 4) == 0.0528
    assert round(pooled["HARD"]["median"], 4) == 0.0483
    assert (pooled["SOFT"]["n_fits"], pooled["MEDIUM"]["n_fits"], pooled["HARD"]["n_fits"]) == (416, 1140, 1126)
    ns = [moments.optimal_laps(22.4, pooled[c]["median"], 70) for c in ("SOFT", "MEDIUM", "HARD")]
    assert ns[0] < ns[1] < ns[2]
    # §4.4 assumption 4: the wet compound fits a negative slope and is excluded outright.
    assert pooled["INTERMEDIATE"]["median"] < 0


@pytest.mark.db
def test_stored_frames_match_the_table_columns(db_conn):
    """FD7: what the builders return is what cast_frame is asked to store."""
    for table in ("race_moment", "optimal_stint"):
        cols = _q(db_conn, "SELECT * FROM " + table + " LIMIT 0").columns.tolist()
        assert cols == frames.EXPECTED_COLUMNS[table]


@pytest.mark.db
def test_detect_all_is_ordered_and_typed(db_conn):
    ctx = _ctx(db_conn, 2025, 1)
    df = moments.detect_all(ctx)
    assert list(df.columns) == list(moments.MOMENT_CANDIDATE_COLUMNS)
    assert list(df["lap_number"]) == sorted(df["lap_number"])
    assert set(df["moment_type"]) <= set(moments.MOMENT_TYPES)
    assert set(df["confidence"]) <= {"high", "likely"}
    assert set(df["magnitude_unit"]) <= {"s", "places"}
    assert df["detail"].map(lambda s: isinstance(s, str) and len(s) > 0).all()


@pytest.mark.db
def test_yield_is_about_six_moments_per_race(db_conn):
    """§4.2's whole point: about six per race, not the 1,825 the absolute-pace rule gave.

    The bound is deliberately loose -- this guards the order of magnitude, the pinned
    per-race tests above guard the detail.
    """
    sids = _q(db_conn, "SELECT s.year, s.round FROM sessions s WHERE s.kind='R' "
                       "AND EXISTS (SELECT 1 FROM laps l WHERE l.session_id = s.session_id)")
    counts = []
    for r in sids.itertuples():
        counts.append(len(moments.detect_all(_ctx(db_conn, int(r.year), int(r.round)))))
    total = sum(counts)
    assert len(counts) >= 60
    assert 3.0 <= total / len(counts) <= 9.0, total
    assert max(counts) <= 60


@pytest.mark.db
def test_a_race_with_no_laps_yields_no_moments(db_conn):
    """§4.5: a scheduled-but-unraced round has nothing to detect and must not raise."""
    empty = moments.build_ctx(
        pd.DataFrame(columns=["driver_id", "lap_number", "stint", "compound", "tyre_life",
                              "position", "lap_time_s", "pit_in_time_s", "pit_out_time_s"]),
        pd.DataFrame(columns=["lap_number", "is_green"]),
        pd.DataFrame(columns=["driver_id", "lap_in", "lap_out"]),
        pd.DataFrame(columns=["driver_id", "stint", "compound", "start_lap", "end_lap", "laps"]),
        pd.DataFrame(columns=["driver_id", "status", "position"]), 0)
    assert len(moments.detect_all(empty)) == 0


@pytest.mark.db
def test_pit_flags_survive_the_fastf1_timedelta_columns(hungary_2024, db_conn):
    """The FastF1 path and the stored-table path must produce the same moments.

    FastF1 hands PitInTime/PitOutTime over as timedelta64; coercing those with
    ``pd.to_numeric`` turns NaT into a number, flags every lap as both an in- and an
    out-lap, and silently empties every pace detector while the pit-driven ones keep
    firing. That failure is invisible in the row count, so it is pinned here.
    """
    sid = _session_id(db_conn, 2024, 13)
    ids = frames.make_session_ids(hungary_2024, sid)
    from_session = moments._session_ctx(hungary_2024, ids)
    assert int(from_session["laps"]["pit_in"].sum()) < len(from_session["laps"]) / 4
    assert from_session["laps"]["is_clean"].sum() > 0
    a = moments.detect_all(from_session)[["moment_type", "lap_number", "driver_id"]]
    b = moments.detect_all(_ctx(db_conn, 2024, 13))[["moment_type", "lap_number", "driver_id"]]
    pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True))
