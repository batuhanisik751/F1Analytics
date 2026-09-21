"""QUALI_SPEC §3 and §4 — the qualifying frames, the four tables, the db contract.

Every number asserted here was measured against the warmed FastF1 cache before the code
was written. Nothing here touches the database except the two schema-shape tests.

The corpus is deliberately small: the frames layer is a projection, and the expensive
evidence (that the laps reproduce the official times at all) lives in
``tests/test_quali_clean.py``. What is tested here is the part that can silently lie —
D6's two gaps, D9's percent, and the noise floor that stops a 7 ms teammate gap being
printed as a difference.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from f1lab import clean, db, frames

pytestmark = pytest.mark.cache

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"

BAHRAIN = (2024, 1, "Q")
MONZA = (2026, 13, "Q")
SAO_PAULO = (2024, 21, "Q")
CHINA_SQ = (2024, 5, "SQ")
MONACO = (2024, 8, "Q")

_SESSIONS: dict[tuple, object] = {}
_FRAMES: dict[tuple, object] = {}


def session_of(key):
    if key not in _SESSIONS:
        _SESSIONS[key] = clean.load_quali(key[0], key[1], key[2], cache=CACHE)
    return _SESSIONS[key]


def frames_of(key, session_id=9000):
    """``build_quali_frames`` for one corpus session, built once."""
    if key not in _FRAMES:
        s = session_of(key)
        kw = {}
        if key[2] == "SQ":
            # Measured: every SQ session in the cache has blank DriverId/TeamId. The
            # weekend's Q session is populated and is the fallback the ingest must use.
            q = clean.load_quali(key[0], key[1], "Q", cache=CACHE)
            d, t = frames.identity_maps(q.results)
            kw = {"driver_ids": d, "team_ids": t}
        ids = frames.make_session_ids(s, session_id, **kw)
        _FRAMES[key] = frames.build_quali_frames(s, ids, 532)
    return _FRAMES[key]


# ---------------------------------------------------------------------------
# §3.2 / §3.7 — the contract
# ---------------------------------------------------------------------------

def test_laps_gains_exactly_five_columns_at_the_end():
    cols = frames.EXPECTED_COLUMNS["laps"]
    assert len(cols) == 46
    assert cols[-5:] == list(frames.QUALI_LAP_COLUMNS)
    assert cols[-5:] == ["quali_segment", "segment_source", "is_push_lap",
                         "excl_disallowed", "deleted_inferred"]


@pytest.mark.parametrize("table,n,first,last", [
    ("quali_results", 21, "session_id", "times_source"),
    # v1.6 as-built: 16, not §3.4's 15. `verified` was appended by the integration pass so a
    # waived driver-segment carries its own flag instead of only a warning string.
    ("quali_segment_times", 16, "session_id", "verified"),
    ("quali_teammate_h2h", 14, "session_id", "below_noise"),
    ("season_quali_h2h", 13, "year", "sessions_caveated"),
])
def test_new_tables_match_the_ddl(table, n, first, last):
    cols = frames.EXPECTED_COLUMNS[table]
    assert len(cols) == n and cols[0] == first and cols[-1] == last


def test_quali_table_order_and_child_delete_order():
    assert frames.QUALI_TABLE_ORDER == [
        "session_teams", "session_entries", "laps", "lap_exclusion_report",
        "quali_results", "quali_segment_times", "quali_teammate_h2h"]
    # §3.3: Q/SQ deliberately do NOT write `results`.
    assert "results" not in frames.QUALI_TABLE_ORDER
    order = db.SESSION_CHILD_TABLES
    for t in ("quali_teammate_h2h", "quali_segment_times", "quali_results"):
        assert order.index(t) < order.index("laps"), t
    # quali_results has a composite FK to session_entries, which must still be later.
    assert order.index("quali_results") < order.index("session_entries")
    # §3.6: season-scoped, so it belongs to season.py, not to a session delete.
    assert "season_quali_h2h" not in order


def test_db_check_schema_alias_exists():
    # WP3's verification command in the spec calls db.check_schema; the module has always
    # spelled it assert_schema.
    assert db.check_schema is db.assert_schema


# ---------------------------------------------------------------------------
# §2.1.1 — the empty-string trap
# ---------------------------------------------------------------------------

def test_qualifying_results_really_do_carry_empty_strings():
    """The premise of §2.1.1, measured rather than assumed."""
    res = session_of(BAHRAIN).results
    assert (res["ClassifiedPosition"].astype(str) == "").all()
    assert (res["Status"].astype(str) == "").all()
    assert res["GridPosition"].isna().all()   # §4.7: NaN in every qualifying session


def test_fallback_catches_blank_and_whitespace_not_real_values():
    assert frames._fallback("", "N") == "N"
    assert frames._fallback("   ", "N") == "N"          # the case _is_null did NOT cover
    assert frames._fallback(None, "Unknown") == "Unknown"
    assert frames._fallback(float("nan"), "Unknown") == "Unknown"
    assert frames._fallback("12", "N") == "12"
    assert frames._fallback("Finished", "Unknown") == "Finished"


def test_identity_frames_never_store_an_empty_string_for_a_quali_session():
    s = session_of(BAHRAIN)
    ids = frames.make_session_ids(s, 9000)
    out = frames._identity_frames(s, ids)
    res = out["results"]
    assert (res["classified_position"] == "N").all()
    assert (res["status"] == "Unknown").all()
    assert not res["classified_position"].isna().any()
    assert not res["status"].isna().any()


# ---------------------------------------------------------------------------
# §3.2 cost 1 — the race path must emit the five columns as NULL
# ---------------------------------------------------------------------------

def test_race_laps_write_null_for_all_five_quali_columns(hungary_2024):
    ids = frames.make_session_ids(hungary_2024, 8001)
    laps = frames.build_race_frames(hungary_2024, ids, 1).tables["laps"]
    assert list(laps.columns) == frames.EXPECTED_COLUMNS["laps"]
    for c in frames.QUALI_LAP_COLUMNS:
        assert laps[c].isna().all(), c
    # §0.4 note 9, pinned here too: races load messages=False, so `deleted` is false on
    # every race lap and `excl_deleted` has never excluded one. v1.7 owns that, not v1.6.
    assert not laps["deleted"].fillna(False).any()


# ---------------------------------------------------------------------------
# Sprint qualifying has no identity of its own (measured; NOT in QUALI_SPEC)
# ---------------------------------------------------------------------------

def test_sprint_qualifying_results_carry_no_driver_or_team_id():
    """D3 makes SQ first-class, and FastF1 does not hand it an identity.

    Measured over the whole cache: all 17 SQ sessions (2024 R05/06/11/19/21/23,
    2025 R02/06/13/19/21/23, 2026 R02/04/05/09/12) return '' for DriverId and TeamId on
    every row, while every Q session is populated. TeamName and Abbreviation survive.
    """
    res = session_of(CHINA_SQ).results
    assert (res["DriverId"].astype(str).str.strip() == "").all()
    assert (res["TeamId"].astype(str).str.strip() == "").all()
    assert (res["TeamName"].astype(str).str.strip() != "").all()
    assert (session_of(BAHRAIN).results["DriverId"].astype(str).str.strip() != "").all()


def test_make_session_ids_refuses_to_invent_a_blank_identity():
    with pytest.raises(frames.BlankIdentity) as e:
        frames.make_session_ids(session_of(CHINA_SQ), 1)
    assert "DriverId" in str(e.value)


def test_identity_maps_from_the_weekends_q_session_repairs_it():
    d, t = frames.identity_maps(session_of(BAHRAIN).results)
    assert d["VER"] == "max_verstappen" and t["Ferrari"] == "ferrari"
    ids = frames.make_session_ids(session_of(CHINA_SQ), 1,
                                  **dict(zip(("driver_ids", "team_ids"),
                                             frames.identity_maps(
                                                 clean.load_quali(2024, 5, "Q", cache=CACHE).results))))
    assert ids.code_to_driver_id["VER"] == "max_verstappen"


# ---------------------------------------------------------------------------
# §3.2 — the qualifying laps frame
# ---------------------------------------------------------------------------

def test_quali_laps_frame_is_the_46_column_contract():
    laps = frames_of(BAHRAIN).tables["laps"]
    assert list(laps.columns) == frames.EXPECTED_COLUMNS["laps"]
    # The six race-only columns are NULL on every qualifying lap (§2.3).
    for c in clean.QUALI_NULL_COLUMNS:
        assert laps[c].isna().all(), c
    # is_outlier is always false: the 107% rule is dropped, not merely unused (§2.3 note 7).
    assert not laps["is_outlier"].fillna(False).any()
    # segment_source is set exactly where quali_segment is.
    assert (laps["quali_segment"].isna() == laps["segment_source"].isna()).all()
    assert set(laps["segment_source"].dropna()) <= {"window", "anchor_repair"}
    assert set(laps["quali_segment"].dropna().astype(int)) <= {1, 2, 3}
    # is_representative == passes_rules on this path, because is_outlier is false.
    assert (laps["is_representative"] == laps["passes_rules"]).all()


def test_sao_paulo_carries_its_repair_provenance():
    """The §2.2 stage-3 repairs reach the frames layer as data, not only as a warning.

    Measured: all three Sao Paulo repairs are WP2's duplicate-official waivers (ALB, ALO
    and PIA each have `Q2 == Q3` in the results, so the Q2 value is a copy and cannot gate
    anything). A waiver moves no lap, so `segment_source` stays 'window' on all 425 laps
    and the count of `anchor_repair` rows is zero -- which is why the provenance to assert
    is the warning and the diagnostic, and `anchor_repair` is only ever a subset.
    """
    f = frames_of(SAO_PAULO, 9021)
    laps = f.tables["laps"]
    moved = int((laps["segment_source"] == "anchor_repair").sum())
    assert moved <= f.quali["segment_repairs"] == 3
    assert moved == 0
    assert all(r.startswith("duplicate_official:") for r in f.quali["repairs"])
    assert "quali_segment_repairs=3" in f.warnings
    assert f.quali["anchor_pre"] == 41 and f.quali["anchor_pre_total"] == 44
    assert f.quali["ok"] is True


def test_a_waived_segment_is_named_because_two_stored_numbers_disagree():
    """The one disagreement §3.3 and §3.4 give no column to express.

    A waiver accepts an official Qk that no lap can verify (it is a byte-identical copy of
    another segment's time). `quali_results.q2_s` then keeps the OFFICIAL value while
    `quali_segment_times.best_s` keeps the lap the driver actually set inside the Q2
    window, and at Sao Paulo the two stored numbers disagree by ALO -3.963 s, ALB +1.232 s
    and PIA +0.493 s. Neither table has a flag column, so the affected driver-segments are
    named in `session_ingests.warnings[]` -- otherwise a reader joining the two tables
    finds a four-second contradiction with nothing marking it as unverified.
    """
    f = frames_of(SAO_PAULO, 9021)
    qr, qseg = f.tables["quali_results"], f.tables["quali_segment_times"]
    assert "quali_waived_segments=ALB:2,ALO:2,PIA:2" in f.warnings
    assert sum(w.startswith("quali_repair:") for w in f.warnings) == 3

    measured = {}
    for drv, expected in (("alonso", -3.963), ("albon", +1.232), ("piastri", +0.493)):
        official = float(qr.loc[qr["driver_id"] == drv, "q2_s"].iloc[0])
        run = float(qseg[(qseg["driver_id"] == drv) & (qseg["segment"] == 2)]["best_s"].iloc[0])
        measured[drv] = round(run - official, 3)
        # the waiver's own premise: the official Q2 is a copy of the official Q3
        assert official == float(qr.loc[qr["driver_id"] == drv, "q3_s"].iloc[0])
        assert measured[drv] == expected
    assert max(abs(v) for v in measured.values()) == 3.963


# ---------------------------------------------------------------------------
# §4.1 / D6 — gap to pole is stored twice because one of them is a lie half the time
# ---------------------------------------------------------------------------

def _gap_disagreements(qr: pd.DataFrame) -> pd.Series:
    return (qr["gap_to_pole_s"] - qr["gap_to_pole_common_s"]).abs()


def test_bahrain_the_two_gaps_disagree_for_at_least_ten_of_twenty_drivers():
    """§4.1's measured table, reproduced: Bahrain 12/20, max change 0.852 s."""
    qr = frames_of(BAHRAIN).tables["quali_results"]
    assert len(qr) == 20
    d = _gap_disagreements(qr)
    assert int((d > 1e-9).sum()) == 12
    assert int((d > 1e-9).sum()) >= 10
    assert round(float(d.max()), 3) == 0.852


def test_sao_paulo_is_the_754_second_case_that_makes_d6_load_bearing():
    """The wet session where the TV number and the honest number are 7.539 s apart."""
    qr = frames_of(SAO_PAULO, 9021).tables["quali_results"]
    d = _gap_disagreements(qr)
    assert int((d > 1e-9).sum()) == 11
    assert round(float(d.max()), 3) == 7.539


def test_percent_is_derived_from_the_same_seconds_and_scaled_by_the_right_pole():
    """D9: both units stored, and percent is the one every ranking uses."""
    qr = frames_of(BAHRAIN).tables["quali_results"]
    pole = float(qr.loc[qr["position"] == 1, "best_s"].iloc[0])
    row = qr[qr["gap_to_pole_segment"] == 2].iloc[0]
    assert row["gap_to_pole_pct"] == pytest.approx(100 * row["gap_to_pole_s"] / pole, abs=1e-9)
    # The COMMON gap is scaled by the pole driver's time IN THAT SEGMENT, not by the pole lap.
    pole_q2 = float(qr.loc[qr["position"] == 1, "q2_s"].iloc[0])
    assert row["gap_to_pole_common_pct"] == pytest.approx(
        100 * row["gap_to_pole_common_s"] / pole_q2, abs=1e-9)
    assert pole_q2 != pole


def test_a_tenth_is_not_a_tenth_so_seconds_never_rank_across_circuits():
    """The §4 preamble's reason for D9, measured on three real poles in this corpus.

    0.100 s as a share of the pole lap: 0.142% at Monaco, 0.122% at Monza, 0.112% at
    Bahrain -- exactly the figures §4 quotes, and a 1.27x spread inside one season.
    Ranking on seconds would silently weight Monaco 1.27x against Bahrain.
    """
    pct = {}
    for key, sid, want in ((MONACO, 9008, 0.142), (MONZA, 9013, 0.122), (BAHRAIN, 9000, 0.112)):
        qr = frames_of(key, sid).tables["quali_results"]
        pole = float(qr.loc[qr["position"] == 1, "best_s"].iloc[0])
        pct[key] = 100 * 0.100 / pole
        assert round(pct[key], 3) == want, (key, pct[key])
    assert max(pct.values()) / min(pct.values()) == pytest.approx(1.27, abs=0.01)


# ---------------------------------------------------------------------------
# §4.2 — segments entered, read off lap presence and never off the NaT pattern
# ---------------------------------------------------------------------------

def test_jeddah_hul_advanced_and_set_no_time():
    """§4.2's measured counterexample: the NaT pattern lies.

    2024 R02 Jeddah: HUL is P15 with a Q1 time and `Q2 = NaT`, yet he ran a lap inside the
    Q2 window -- he advanced and set no time. Reading "knocked out in Q1" off the NaT
    pattern would be wrong for him. ZHO is the other edge: one segment, no time at all.
    """
    qr = frames_of((2024, 2, "Q"), 9002).tables["quali_results"]
    hul = qr[qr["driver_id"] == "hulkenberg"].iloc[0]
    assert hul["position"] == 15 and pd.isna(hul["q2_s"]) and not pd.isna(hul["q1_s"])
    assert hul["segments_entered"] == 2 and hul["knocked_out_in"] == 2
    zho = qr[qr["driver_id"] == "zhou"].iloc[0]
    assert zho["position"] == 20 and zho["segments_entered"] == 1
    assert not bool(zho["set_a_time"]) and pd.isna(zho["best_s"])
    assert pd.isna(zho["gap_to_pole_s"]) and pd.isna(zho["gap_to_pole_common_s"])


def test_knocked_out_is_null_only_for_drivers_who_reached_the_last_segment():
    qr = frames_of(BAHRAIN).tables["quali_results"]
    for r in qr.itertuples(index=False):
        assert (r.knocked_out_in is None or pd.isna(r.knocked_out_in)) == (r.segments_entered == 3)
    assert bool(qr["set_a_time"].all())
    # §3.3's CHECK, enforced here too rather than only by Postgres.
    assert qr["segments_entered"].between(1, 3).all()
    assert (qr["set_a_time"].astype(bool) == qr["best_s"].notna()).all()


def test_no_field_size_is_hard_coded():
    """2024 cuts at 15; 2026 Monza is a 22-car grid cutting at 16 (§3.3)."""
    n24 = frames_of(BAHRAIN).tables["quali_results"]
    n26 = frames_of(MONZA, 9013).tables["quali_results"]
    assert len(n24) == 20 and len(n26) == 22
    assert int((n24["segments_entered"] >= 2).sum()) == 15
    assert int((n26["segments_entered"] >= 2).sum()) == 16


# ---------------------------------------------------------------------------
# §4.3 / §0.4 note 2 — the noise floor, encoded rather than documented
# ---------------------------------------------------------------------------

def test_monza_2026_ferrari_is_below_the_sessions_own_noise():
    """The measured example the release exists to not get wrong.

    LEC is +0.007 s (0.009%) on HAM at 2026 Monza. That is 26x smaller than that session's
    own within-segment repeatability, so `below_noise` is true and the UI is forbidden
    (§4.3 hard rule 2) from printing the number as a skill difference.
    """
    h = frames_of(MONZA, 9013).tables["quali_teammate_h2h"]
    f = h[h["team_id"] == "ferrari"].iloc[0]
    assert {f["driver_a"], f["driver_b"]} == {"leclerc", "hamilton"}
    assert f["driver_a"] == "leclerc"                      # the QUICKER of the two (§3.5)
    assert float(f["delta_s"]) == pytest.approx(0.007, abs=1e-9)
    assert float(f["delta_pct"]) == pytest.approx(0.00854, abs=1e-5)
    assert float(f["session_sd_s"]) > 25 * float(f["delta_s"])
    assert bool(f["below_noise"]) is True
    assert bool(f["comparable"]) is True


def test_session_sd_is_stored_for_every_comparable_pair_in_the_corpus():
    """Without it `below_noise` silently defaults to 'this gap is real'."""
    missing = total = below = 0
    for key, sid in ((BAHRAIN, 9000), (MONZA, 9013), (MONACO, 9008), (SAO_PAULO, 9021),
                     (CHINA_SQ, 9005)):
        h = frames_of(key, sid).tables["quali_teammate_h2h"]
        cmp_ = h[h["comparable"].astype(bool)]
        total += len(cmp_)
        missing += int(cmp_["session_sd_s"].isna().sum())
        below += int(cmp_["below_noise"].astype(bool).sum())
    assert total > 40 and missing == 0
    # Measured: over half of all single-session teammate gaps in this corpus are smaller
    # than the session's own repeatability. That is the finding, not a rounding detail.
    assert below / total > 0.4


def test_delta_is_always_positive_and_a_is_always_the_quicker():
    for key, sid in ((BAHRAIN, 9000), (MONACO, 9008), (SAO_PAULO, 9021)):
        h = frames_of(key, sid).tables["quali_teammate_h2h"]
        cmp_ = h[h["comparable"].astype(bool)]
        assert (cmp_["delta_s"] > -1e-12).all()
        assert (cmp_["b_best_s"] >= cmp_["a_best_s"]).all()
        assert (cmp_["segment"].between(1, 3)).all()
        assert (h["divergent"].astype(bool) == (h["classified_ahead"] != h["driver_a"])).all()
        assert h["classified_ahead"].notna().all()


def test_a_pair_that_never_shared_a_segment_is_not_comparable_but_still_has_a_winner():
    """2024 R02 Jeddah HUL/MAG: the win counts, the delta does not (§4.3)."""
    h = frames_of((2024, 2, "Q"), 9002).tables["quali_teammate_h2h"]
    bad = h[~h["comparable"].astype(bool)]
    assert len(bad) == 1
    r = bad.iloc[0]
    assert pd.isna(r["segment"]) and pd.isna(r["delta_s"]) and pd.isna(r["delta_pct"])
    assert r["classified_ahead"] in (r["driver_a"], r["driver_b"])
    assert bool(r["below_noise"]) is False


# ---------------------------------------------------------------------------
# §4.4 — the per-segment long form, and the best-of-n disclosure
# ---------------------------------------------------------------------------

def test_segment_times_carry_the_counts_that_make_best_s_readable():
    qs = frames_of(BAHRAIN).tables["quali_segment_times"]
    assert list(qs.columns) == frames.EXPECTED_COLUMNS["quali_segment_times"]
    assert (qs["laps_run"] >= qs["repr_laps"]).all()      # in/out laps included in laps_run
    assert (qs["repr_laps"] >= qs["push_laps"]).all()
    # spread_s and sd_s exist only with >= 2 push laps; NULL for the rest, never zero.
    assert (qs.loc[qs["push_laps"] < 2, "spread_s"].isna()).all()
    assert (qs.loc[qs["push_laps"] < 2, "sd_s"].isna()).all()
    assert (qs.loc[qs["push_laps"] >= 2, "sd_s"].notna()).all()
    assert (qs["spread_s"].dropna() >= 0).all()
    # One driver is the segment leader in each segment, at exactly zero.
    for k in (1, 2, 3):
        g = qs[qs["segment"] == k]
        assert float(g["gap_to_best_s"].min()) == pytest.approx(0.0, abs=1e-12)
        assert float(g["gap_to_best_pct"].min()) == pytest.approx(0.0, abs=1e-12)


def test_best_of_n_disclosure_is_present_and_the_n_really_varies():
    """§4.4: a two-lap driver is not being compared fairly with an eight-lap driver."""
    qr = frames_of(MONACO, 9008).tables["quali_results"]
    assert qr["n_repr_laps"].min() < qr["n_repr_laps"].max()
    assert (qr["n_repr_laps"] >= qr["push_laps"]).all()
    assert (qr.loc[qr["set_a_time"].astype(bool), "n_repr_laps"] >= 1).all()


def test_segment_best_equals_the_official_time_and_points_at_a_real_lap():
    """The provenance pointer: every stored best is a lap you can open."""
    f = frames_of(BAHRAIN)
    qr, laps = f.tables["quali_results"], f.tables["laps"]
    for r in qr[qr["set_a_time"].astype(bool)].itertuples(index=False):
        official = {1: r.q1_s, 2: r.q2_s, 3: r.q3_s}[int(r.best_segment)]
        assert float(r.best_s) == pytest.approx(float(official), abs=1.5e-3)
        lap = laps[(laps["driver_id"] == r.driver_id) & (laps["lap_number"] == r.best_lap_number)]
        assert len(lap) == 1
        assert float(lap["lap_time_s"].iloc[0]) == pytest.approx(float(r.best_s), abs=1.5e-3)
        assert int(lap["quali_segment"].iloc[0]) == int(r.best_segment)


# ---------------------------------------------------------------------------
# §4.5 / §4.6
# ---------------------------------------------------------------------------

def test_pole_is_the_classified_p1_not_the_quickest_lap_of_the_session():
    """§4.5 is a definitional choice, and Bahrain is a live counterexample to the other one."""
    qr = frames_of(BAHRAIN).tables["quali_results"]
    p1 = qr[qr["position"] == 1].iloc[0]
    assert p1["driver_id"] == "max_verstappen"
    assert float(p1["gap_to_pole_s"]) == pytest.approx(0.0, abs=1e-12)
    # LEC's Q2 was 0.014 s quicker than the pole lap, so a negative TV gap is correct, not
    # a bug: the quickest comparable lap of the session did not belong to P1.
    lec = qr[qr["driver_id"] == "leclerc"].iloc[0]
    assert float(lec["gap_to_pole_s"]) < 0
    assert float(lec["gap_to_pole_common_s"]) > 0     # on Q3 terms he is behind


def test_china_sprint_qualifying_fails_the_cross_segment_gate():
    """§4.6 / §0.4 note 8: SQ1-SQ2 dry, SQ3 wet on intermediates, +23%."""
    f = frames_of(CHINA_SQ, 9005)
    assert f.quali["cross_segment_ok"] is False
    assert "quali_cross_segment_ok=False" in f.warnings
    qs = f.tables["quali_segment_times"]
    wet = {k: bool(qs.loc[qs["segment"] == k, "wet_compound"].any()) for k in (1, 2, 3)}
    # Measured, and finer-grained than §4.6's prose: SQ1 is 109 laps of MEDIUM, SQ2 is 38
    # MEDIUM and 10 INTERMEDIATE as the rain arrived, SQ3 is 30 INTERMEDIATE and no slick.
    # The gate fails on the wet clause alone, before the +23% clause is even reached.
    assert wet == {1: False, 2: True, 3: True}
    best = {k: float(qs.loc[qs["segment"] == k, "best_s"].min()) for k in (1, 2, 3)}
    assert best[2] == pytest.approx(95.606, abs=1e-3)
    assert best[3] == pytest.approx(117.940, abs=1e-3)
    assert best[3] / best[2] - 1 > 0.20
    # A failed gate suppresses nothing: the classification still publishes.
    assert len(f.tables["quali_results"]) == 20
    assert f.tables["quali_results"]["position"].tolist() == list(range(1, 21))


# ---------------------------------------------------------------------------
# §2.5 / §3.1 — provenance, and the rule that `laps` is no longer race-only
# ---------------------------------------------------------------------------

def test_times_source_separates_external_validation_from_self_consistency():
    """§2.5: for Q the official times come from the timing API, for SQ FastF1 computes them."""
    assert set(frames_of(BAHRAIN).tables["quali_results"]["times_source"]) == {"api"}
    assert set(frames_of(CHINA_SQ, 9005).tables["quali_results"]["times_source"]) == {"derived"}


def test_exclusion_report_names_the_rules_that_are_reported_but_never_applied():
    """§2.3 notes 6 and 7: a measured zero must read as a decision, not as a missing rule."""
    rep = frames_of(MONACO, 9008).tables["lap_exclusion_report"]
    rules = list(rep["rule"])
    assert rules[:5] == list(clean._QUALI_EXCL_RULES)
    assert any("excl_not_green (reported, never applied)" == r for r in rules)
    assert any("excl_inaccurate (reported, never applied)" == r for r in rules)
    assert any(r.startswith("is_outlier") for r in rules)
    assert rules[-1] == "SURVIVING (representative)"
    outlier = rep.loc[rep["rule"].str.startswith("is_outlier"), "laps_hit"].iloc[0]
    assert int(outlier) == 0
    # Monaco is §2.3 note 6's case: applying the race green-flag rule would have deleted
    # FIA-classified times. It fires on many laps here and excludes none of them.
    green = rep.loc[rep["rule"].str.startswith("excl_not_green"), "laps_hit"].iloc[0]
    assert int(green) > 0
    assert int(rep.loc[rep["rule"] == "excl_deleted", "laps_hit"].iloc[0]) == 21


def test_quali_segment_is_the_no_join_marker_that_makes_the_d1_rule_enforceable():
    """§3.1: `quali_segment IS NOT NULL` identifies a qualifying lap without a join."""
    q = frames_of(BAHRAIN).tables["laps"]
    assert q["quali_segment"].notna().any()
    assert q["is_push_lap"].notna().all() and q["excl_disallowed"].notna().all()
    assert q["deleted_inferred"].notna().all()
    # deleted_inferred is exactly "the §2.4 net fired where race control did not".
    fired = q["excl_disallowed"].fillna(False).astype(bool)
    assert (q["deleted_inferred"].fillna(False).astype(bool)
            == (fired & ~q["deleted"].fillna(False).astype(bool))).all()


def test_austria_disallowed_is_a_second_net_and_a_leaky_one():
    """§2.4's measured blind spot: 4 real deletions, the diagnostic sees 2."""
    laps = frames_of((2024, 11, "Q"), 9011).tables["laps"]
    assert int(laps["deleted"].fillna(False).sum()) == 4
    assert int(laps["excl_disallowed"].fillna(False).sum()) == 2


def test_sprint_qualifying_identity_frames_survive_the_blank_ids():
    """The regression the blank SQ identity actually caused, at the frame level.

    `_identity_frames` used to read `res.TeamId` directly and de-duplicate on it. With
    every TeamId blank that collapses a 10-team grid to ONE `session_teams` row and then
    fails `session_entries_session_team_fk` on COPY. Both now resolve through `ids`.
    """
    f = frames_of(CHINA_SQ, 9005)
    assert len(f.tables["session_teams"]) == 10
    assert len(f.tables["session_entries"]) == 20
    assert f.tables["session_teams"]["team_id"].notna().all()
    assert f.tables["session_teams"]["team_id"].nunique() == 10
    entries = f.tables["session_entries"]
    assert entries["driver_id"].notna().all() and entries["team_id"].notna().all()
    assert entries["driver_id"].nunique() == 20
    qr = f.tables["quali_results"]
    assert qr["driver_id"].notna().all() and qr["team_id"].notna().all()
    assert set(qr["driver_id"]) == set(entries["driver_id"])


def test_every_quali_frame_matches_its_contract_exactly():
    for key, sid in ((BAHRAIN, 9000), (MONZA, 9013), (SAO_PAULO, 9021), (CHINA_SQ, 9005)):
        f = frames_of(key, sid)
        assert list(f.tables) == frames.QUALI_TABLE_ORDER, key
        for table, df in f.tables.items():
            assert list(df.columns) == frames.EXPECTED_COLUMNS[table], (key, table)
        assert set(f.analytics_status) == set(frames.QUALI_ANALYTICS)
        assert all(v == "ok" for v in f.analytics_status.values()), (key, f.analytics_status)
        assert f.quali["kind"] == key[2]
