"""frames.py against the cached sessions, no database.

Every frame's columns == EXPECTED_COLUMNS[table]; no 'nan' strings; every cell
converts to a plain Python value; the fuel columns on representative laps equal the
notebook pipeline's; Hungary 2024 reproduces the notebook's ranking.
"""

from __future__ import annotations

import datetime as dt
import inspect
import math

import numpy as np
import pandas as pd
import pytest

from f1lab import assumptions, clean, colours, config, frames, pace

ASSUMPTION_SET_ID = 1


@pytest.fixture(scope="module")
def race_frames(any_session):
    ids = frames.make_session_ids(any_session, session_id=42)
    return any_session, ids, frames.build_race_frames(any_session, ids, ASSUMPTION_SET_ID)


PY_TYPES = (int, float, bool, str, dt.datetime, dt.date, type(None))


def test_expected_columns_cover_every_table_of_spec():
    expected = {
        "assumption_sets", "seasons", "circuits", "events", "teams", "drivers", "sessions",
        "session_teams", "session_entries", "compound_colours", "results",
        "laps", "lap_status", "pit_stops", "stints",
        "lap_exclusion_report", "pace_ranking", "degradation_fits", "compound_degradation",
        "teammate_deltas", "fuel_sensitivity", "weather_samples", "track_status_events",
        "driver_standings", "constructor_standings", "driver_season_summary", "teammate_h2h",
        "ingest_runs", "session_ingests",
        # SIM_SPEC §2.1 / §2.3
        "sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound", "sim_circuit_hazard",
        # v1.2 companion tables (MODE1_SPEC §5.5): 14 added, none removed.
        "circuit_odi", "optimal_stint", "preview_backtest", "preview_finish_order", "preview_round", "preview_snapshot_order", "preview_snapshot_round",
        "race_moment", "title_clinch", "title_odds",
        "wp_lap_probability", "wp_metrics", "wp_model_artifact", "wp_reliability_bin", "wp_run", "wp_swing",
        # MODE2_SPEC §6.2 / §6.3: v1.3 appended exactly these twelve, none removed.
        "mode2_fit_run", "mode2_component", "mode2_driver_rating", "mode2_driver_rating_history",
        "mode2_driver_skill", "mode2_driver_contrast", "mode2_car_rating", "mode2_car_hazard",
        "mode2_points_calib", "mode2_career_season", "mode2_counterfactual", "mode2_row_audit",
        # v1.8 (GAPFILL_SPEC §2.2): the per-driver-session audit of the one_lap_pace fit.
        "mode2_quali_row_audit",
        # MODE3_SPEC §6.3: v1.4 appended exactly ONE table to the Python contract. The other two
        # Mode 3 tables (ask_query_log, ask_answer_cache) are web-owned and deliberately absent
        # from EXPECTED_COLUMNS — f1lab never reads or writes them.
        "race_report",
        # QUALI_SPEC §3.3-§3.6: v1.6 appended exactly these four, none removed. `laps` gained
        # five columns in place (41 -> 46) rather than becoming a second table (D1).
        "quali_results", "quali_segment_times", "quali_teammate_h2h", "season_quali_h2h",
        # TELEMETRY_SPEC §2.1 / §2.4: v1.7 appended exactly these five, none removed.
        # circuit_layout and circuit_corners are keyed per (circuit_key, year), not per
        # session, so they are deliberately absent from db.SESSION_CHILD_TABLES (§2.8).
        "circuit_layout", "circuit_corners",
        "lap_telemetry", "lap_telemetry_summary", "lap_corner_speeds",
    }
    assert set(frames.EXPECTED_COLUMNS) == expected
    for t, cols in frames.EXPECTED_COLUMNS.items():
        assert len(cols) == len(set(cols)), t
        assert all(c == c.lower() for c in cols), t
    # SPEC §1.4 counted 41; QUALI_SPEC §3.2 added five in place (D1), so 46 as of v1.6.
    # The five are appended in DDL order and are None on every race and sprint lap.
    assert len(frames.EXPECTED_COLUMNS["laps"]) == 46
    assert frames.EXPECTED_COLUMNS["laps"][-5:] == [
        "quali_segment", "segment_source", "is_push_lap", "excl_disallowed", "deleted_inferred"]
    assert frames.EXPECTED_COLUMNS["laps"][:3] == ["session_id", "driver_id", "lap_number"]
    assert set(frames.RACE_TABLE_ORDER) <= set(frames.EXPECTED_COLUMNS)
    # "sim" is ONE status key covering the four sim_* per-session tables (SIM_SPEC §2.3)
    assert set(frames.ANALYTICS) - {"sim"} <= set(frames.RACE_TABLE_ORDER)
    # MODE1_SPEC §5.5: v1.2 appended exactly two per-session companion tables after the sim block.
    assert frames.RACE_TABLE_ORDER[-6:-2] == ["sim_race_params", "sim_compound_params",
                                              "sim_driver_params", "sim_driver_compound"]
    assert frames.RACE_TABLE_ORDER[-2:] == ["race_moment", "optimal_stint"]


def test_every_race_frame_matches_contract(race_frames):
    session, ids, fr = race_frames
    assert list(fr.tables) == frames.RACE_TABLE_ORDER
    for table, df in fr.tables.items():
        assert list(df.columns) == frames.EXPECTED_COLUMNS[table], table
        text_cols = [c for c, k in frames.TABLE_COLUMNS[table] if k == "text"]
        for c in text_cols:
            vals = df[c].dropna()
            assert not (vals.astype(str) == "nan").any(), (table, c)
            assert not (vals.astype(str) == "").any(), (table, c)
        for row in frames.iter_rows(df):
            for v in row:
                if isinstance(v, list):   # float[] | int[] | text[] columns: plain Python elements only
                    assert all(isinstance(x, (int, float, str)) for x in v), (table, v)
                    assert not any(isinstance(x, float) and math.isnan(x) for x in v), (table, v)
                    continue
                assert isinstance(v, PY_TYPES), (table, type(v), v)
                if isinstance(v, float):
                    assert not math.isnan(v), (table, row)
        if len(df):
            assert (df["session_id"] == ids.session_id).all(), table
        if "assumption_set_id" in df.columns and len(df):
            assert (df["assumption_set_id"] == ASSUMPTION_SET_ID).all(), table

    assert set(fr.analytics_status) == set(frames.ANALYTICS)
    for k, v in fr.analytics_status.items():
        assert v == "ok" or v == "empty" or v.startswith("error: "), (k, v)
    assert fr.raw_laps == len(session.laps)
    assert fr.clean_laps == len(clean.clean_laps(session))
    assert "nan" not in fr.compounds_seen and all(c.isupper() for c in fr.compounds_seen)


def test_not_null_columns_have_no_nulls(race_frames):
    _, _, fr = race_frames
    not_null = {
        "session_teams": ["team_id", "team_name", "colour", "colour_source"],
        "session_entries": ["driver_id", "team_id", "code", "driver_number", "line_style", "line_style_source"],
        "compound_colours": ["compound", "colour"],
        "results": ["driver_id", "classified_position", "points", "status"],
        "laps": ["driver_id", "lap_number", "is_accurate", "deleted", "fastf1_generated", "is_personal_best",
                 "excl_no_time", "excl_in_lap", "excl_out_lap", "excl_not_green", "excl_inaccurate",
                 "excl_deleted", "passes_rules", "is_outlier", "is_representative"],
        "lap_status": ["lap_number", "is_green", "worst_status", "drivers_affected", "drivers_on_lap"],
        "pit_stops": ["driver_id", "stop_number", "lap_in", "pit_in_time_s"],
        "stints": ["driver_id", "stint", "compound", "start_lap", "end_lap", "laps"],
        "lap_exclusion_report": ["rule_order", "rule", "laps_hit", "pct_of_all"],
        "pace_ranking": ["driver_id", "rank", "team_id", "clean_laps", "median_pace_s", "best_pace_s", "iqr_s",
                         "gap_s", "gap_pct", "box_whisker_lo_s", "box_q1_s", "box_q3_s", "box_whisker_hi_s",
                         "box_mean_s"],
        "degradation_fits": ["driver_id", "stint", "team_id", "compound", "laps", "deg_s_per_lap",
                             "deg_std_err", "r2", "fresh_pace_s"],
        "compound_degradation": ["compound", "laps", "slope_s_per_lap", "intercept_s", "x_min", "x_max"],
        "teammate_deltas": ["team_id", "faster_driver_id", "slower_driver_id", "gap_s", "gap_pct", "laps_compared"],
        "fuel_sensitivity": ["driver_id", "fuel_effect_s_per_kg", "rank", "gap_s"],
        "weather_samples": ["sample_idx", "session_time_s"],
        "track_status_events": ["event_idx", "session_time_s", "status"],
    }
    for table, cols in not_null.items():
        df = fr.tables[table]
        for c in cols:
            assert not df[c].isna().any(), (table, c)


def test_primary_keys_are_unique(race_frames):
    _, _, fr = race_frames
    pks = {
        "session_teams": ["session_id", "team_id"], "session_entries": ["session_id", "driver_id"],
        "compound_colours": ["session_id", "compound"], "results": ["session_id", "driver_id"],
        "laps": ["session_id", "driver_id", "lap_number"], "lap_status": ["session_id", "lap_number"],
        "pit_stops": ["session_id", "driver_id", "stop_number"],
        "stints": ["session_id", "driver_id", "stint", "compound"],
        "lap_exclusion_report": ["session_id", "rule"], "pace_ranking": ["session_id", "driver_id"],
        "degradation_fits": ["session_id", "driver_id", "stint"], "compound_degradation": ["session_id", "compound"],
        "teammate_deltas": ["session_id", "team_id"],
        "fuel_sensitivity": ["session_id", "driver_id", "fuel_effect_s_per_kg"],
        "weather_samples": ["session_id", "sample_idx"], "track_status_events": ["session_id", "event_idx"],
    }
    for table, key in pks.items():
        df = fr.tables[table]
        assert not df.duplicated(key).any(), table
    # Extra uniques.
    assert not fr.tables["session_teams"].duplicated(["session_id", "team_name"]).any()
    assert not fr.tables["session_entries"].duplicated(["session_id", "code"]).any()
    assert not fr.tables["session_entries"].duplicated(["session_id", "driver_number"]).any()
    assert not fr.tables["pace_ranking"].duplicated(["session_id", "rank"]).any()


def test_identity_frames_join_back(race_frames):
    session, ids, fr = race_frames
    entries = fr.tables["session_entries"]
    teams = fr.tables["session_teams"]
    assert len(entries) == len(session.results)
    assert set(entries["team_id"]) <= set(teams["team_id"])
    assert set(entries["driver_id"]) == set(ids.code_to_driver_id.values())
    assert set(teams["team_name"]) == set(ids.team_name_to_team_id)
    assert set(teams["colour_source"]) <= {"fastf1", "results", "fallback"}
    assert set(entries["line_style"]) <= {"solid", "dashed", "dotted"}
    assert set(entries["line_style_source"]) <= {"fastf1", "fallback"}
    assert teams["colour"].str.fullmatch(r"#[0-9a-f]{6}").all()
    # Every driver id in every child frame is an entry.
    for table, df in fr.tables.items():
        for c in ("driver_id", "faster_driver_id", "slower_driver_id", "leader_driver_id"):
            if c in df.columns:
                assert set(df[c].dropna()) <= set(entries["driver_id"]), (table, c)
        if "team_id" in df.columns and table != "session_teams":
            assert set(df["team_id"]) <= set(teams["team_id"]), table


def test_laps_frame_equals_raw_and_notebook_pipeline(race_frames):
    session, ids, fr = race_frames
    laps = fr.tables["laps"]
    raw = session.laps
    assert len(laps) == len(raw)
    assert int(laps["is_representative"].sum()) == fr.clean_laps

    # Fuel columns on representative rows equal laps_fc's (same formula, same inputs).
    laps_fc = pace.fuel_correct(clean.clean_laps(session), session.total_laps, lap_km=None)
    inv = {v: k for k, v in ids.code_to_driver_id.items()}
    rep = laps[laps["is_representative"]].copy()
    rep["Driver"] = rep["driver_id"].map(inv)
    rep["LapNumber"] = rep["lap_number"].astype(float)
    m = rep.merge(laps_fc[["Driver", "LapNumber", "FuelKg", "FuelPenaltyS", "LapTimeFuelCorrected"]],
                  on=["Driver", "LapNumber"], how="inner")
    assert len(m) == len(laps_fc) == len(rep)
    np.testing.assert_array_equal(m["fuel_kg"].values, m["FuelKg"].values)
    np.testing.assert_array_equal(m["fuel_penalty_s"].values, m["FuelPenaltyS"].values)
    np.testing.assert_array_equal(m["lap_time_fc_s"].values, m["LapTimeFuelCorrected"].values)

    # Raw values round-trip: lap time in seconds, session time, compound normalised.
    np.testing.assert_allclose(laps["lap_time_s"].values, raw["LapTime"].dt.total_seconds().values, equal_nan=True)
    np.testing.assert_allclose(laps["session_time_s"].values, raw["Time"].dt.total_seconds().values)
    assert laps["compound"].dropna().isin(set(fr.compounds_seen)).all()
    n_nan = int(raw["Compound"].astype(str).eq("nan").sum())
    assert int(laps["compound"].isna().sum()) == n_nan
    if n_nan:
        assert any("normalised" in w for w in fr.warnings)
        assert laps["stint"].isna().sum() >= 1
    # in/out lap markers agree with the raw pit columns.
    assert (laps["pit_in_time_s"].notna().values == raw["PitInTime"].notna().values).all()
    assert (laps["pit_out_time_s"].notna().values == raw["PitOutTime"].notna().values).all()
    # The leader has no interval and a zero gap on every lap.
    lead = laps[laps["leader_driver_id"] == laps["driver_id"]]
    assert (lead["gap_to_leader_s"] == 0).all() and lead["interval_s"].isna().all()


def test_pace_ranking_frame_reproduces_notebook(race_frames):
    session, ids, fr = race_frames
    pr = fr.tables["pace_ranking"]
    if fr.analytics_status["pace_ranking"] != "ok":
        pytest.skip(fr.analytics_status["pace_ranking"])
    laps_fc = pace.fuel_correct(clean.clean_laps(session), session.total_laps, lap_km=None)
    ranking = pace.pace_ranking(laps_fc, min_laps=8)
    assert pr["rank"].tolist() == ranking["Rank"].tolist()
    assert pr["driver_id"].tolist() == [ids.code_to_driver_id[c] for c in ranking["Driver"]]
    np.testing.assert_array_equal(pr["median_pace_s"].values, ranking["MedianPace"].values)
    assert (pr["box_whisker_lo_s"] <= pr["box_q1_s"]).all()
    assert (pr["box_q1_s"] <= pr["median_pace_s"]).all()
    assert (pr["median_pace_s"] <= pr["box_q3_s"]).all()
    assert (pr["box_q3_s"] <= pr["box_whisker_hi_s"]).all()

    # rank@0.03 in fuel_sensitivity reproduces pace_ranking.rank (D2, lap_km=None).
    fs = fr.tables["fuel_sensitivity"]
    base = fs[fs["fuel_effect_s_per_kg"] == 0.03].set_index("driver_id")["rank"]
    assert sorted(set(fs["fuel_effect_s_per_kg"])) == [0.025, 0.03, 0.035]
    assert (pr.set_index("driver_id")["rank"] == base.reindex(pr["driver_id"]).values).all()
    # sens range brackets the base rank wherever it is defined.
    has = pr["sens_rank_lo"].notna()
    assert (pr.loc[has, "sens_rank_lo"] <= pr.loc[has, "rank"]).all()
    assert (pr.loc[has, "sens_rank_hi"] >= pr.loc[has, "rank"]).all()


def test_hungary_2024_numbers(hungary_2024, pooled_stint_seed):
    # pooled_stint_seed: v1.2's optimal_stint needs a pooled slope/pit-loss dict that only
    # ingest.run_season populates; without it analytics_status['optimal_stint'] is a valid
    # 'empty' and the all-ok assertion below could never hold offline. See conftest.
    ids = frames.make_session_ids(hungary_2024, session_id=1)
    fr = frames.build_race_frames(hungary_2024, ids, ASSUMPTION_SET_ID)
    pr = fr.tables["pace_ranking"].sort_values("rank")
    top = list(zip(pr["driver_id"].head(3), pr["median_pace_s"].head(3).round(4)))
    assert top == [("norris", 81.5796), ("piastri", 81.6349), ("hamilton", 81.8938)]
    assert all(v == "ok" for v in fr.analytics_status.values()), fr.analytics_status
    assert fr.warnings == []
    assert fr.tables["lap_exclusion_report"]["rule"].iloc[-1] == "SURVIVING (clean + non-outlier)"
    assert fr.tables["lap_exclusion_report"]["rule_order"].tolist() == list(range(7))
    assert len(fr.tables["stints"]) == len(clean.stint_table(hungary_2024))
    assert len(fr.tables["weather_samples"]) == len(hungary_2024.weather_data)
    assert len(fr.tables["track_status_events"]) == len(hungary_2024.track_status)
    assert fr.tables["compound_colours"]["compound"].tolist() == sorted(
        set(fr.compounds_seen) | {"SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN", "TEST-UNKNOWN"})
    assert fr.tables["session_teams"].set_index("team_name").loc["McLaren", "colour"] == "#ff8000"


def test_miami_2025_nan_compounds(miami_2025):
    ids = frames.make_session_ids(miami_2025, session_id=2)
    fr = frames.build_race_frames(miami_2025, ids, ASSUMPTION_SET_ID)
    laps = fr.tables["laps"]
    assert int(laps["compound"].isna().sum()) == 354
    assert int(laps["stint"].isna().sum()) == 354
    assert int(laps["tyre_life"].isna().sum()) == 354
    assert "compound 'nan' normalised on 354 laps" in fr.warnings
    assert "nan" not in fr.compounds_seen
    assert (fr.tables["stints"]["compound"] != "nan").all()
    assert fr.tables["results"]["driver_id"].nunique() == 20


def test_r1_2026_dns_drivers(r1_2026):
    ids = frames.make_session_ids(r1_2026, session_id=3)
    fr = frames.build_race_frames(r1_2026, ids, ASSUMPTION_SET_ID)
    res = fr.tables["results"]
    assert len(res) == 22 and len(fr.tables["session_teams"]) == 11
    dns = res[res["status"] == "Did not start"]
    assert len(dns) == 2 and (dns["classified_position"] == "W").all() and (dns["laps_completed"] == 0).all()
    assert dns["result_time_s"].isna().all()
    assert set(dns["driver_id"]) <= set(fr.tables["session_entries"]["driver_id"])
    assert not fr.tables["laps"]["driver_id"].isin(dns["driver_id"]).any()


def test_sprint_frames_have_identity_tables_only(hungary_2024):
    ids = frames.make_session_ids(hungary_2024, session_id=9)
    fr = frames.build_sprint_frames(hungary_2024, ids)
    assert list(fr.tables) == frames.SPRINT_TABLE_ORDER
    for table, df in fr.tables.items():
        assert list(df.columns) == frames.EXPECTED_COLUMNS[table]
    assert fr.analytics_status == {} and fr.raw_laps == 0 and fr.clean_laps == 0


def test_id_resolution_error_is_a_key_error(hungary_2024):
    ids = frames.make_session_ids(hungary_2024, session_id=1)
    ids.code_to_driver_id.pop("NOR")
    with pytest.raises(KeyError):
        frames.build_race_frames(hungary_2024, ids, ASSUMPTION_SET_ID)


def test_cast_frame_rules():
    df = pd.DataFrame({
        "session_id": [1, 1], "compound": ["nan", "SOFT"], "colour": [np.nan, "#abc123"],
    })
    out = frames.cast_frame(df, "compound_colours")
    assert list(out.columns) == ["session_id", "compound", "colour"]
    assert out["compound"].iloc[0] is None and out["colour"].iloc[0] is None
    rows = list(frames.iter_rows(out))
    assert rows == [(1, None, None), (1, "SOFT", "#abc123")]

    df = pd.DataFrame({"session_id": [1.0, 1.0], "lap_number": [3.0, np.nan], "is_green": [True, None],
                       "worst_status": ["1", "5"], "drivers_affected": [0, 2], "drivers_on_lap": [20, 20]})
    out = frames.cast_frame(df, "lap_status")
    assert str(out["lap_number"].dtype) == "Int64" and out["lap_number"].iloc[1] is pd.NA
    assert list(frames.iter_rows(out))[0] == (1, 3, True, "1", 0, 20)
    assert list(frames.iter_rows(out))[1][1] is None and list(frames.iter_rows(out))[1][2] is None

    with pytest.raises(ValueError):
        frames.cast_frame(df.assign(lap_number=[3.5, 4.0]), "lap_status")
    with pytest.raises(KeyError):
        frames.cast_frame(df.drop(columns=["is_green"]), "lap_status")

    td = pd.DataFrame({"session_id": [1], "event_idx": [0], "session_time_s": pd.to_timedelta([90.5], unit="s"),
                       "status": ["1"], "message": [None]})
    out = frames.cast_frame(td, "track_status_events")
    assert out["session_time_s"].iloc[0] == 90.5


def test_assumptions_snapshot_and_hash():
    snap = assumptions.snapshot()
    # SIM_SPEC §1.13 / §3.3: every SIM_* config constant joins the snapshot (the hash changed on purpose)
    sim_keys = {k for k in snap if k.startswith("SIM_")}
    assert sim_keys == {k for k in dir(config) if k.startswith("SIM_")} and len(sim_keys) >= 30
    # MODE2_SPEC §7.3: every MODE2_* constant joins the snapshot, the same way the SIM_*
    # block does — the assumption hash moved on purpose when v1.3 landed, and again at v1.8
    # when GAPFILL_SPEC §2.4 added six qualifying constants (21 -> 27). That hash move is
    # the intended mechanism: it is what put the one_lap_pace fit on a new assumption set
    # and a new fit_id rather than overwriting the v1.7 rows.
    mode2_keys = {k for k in snap if k.startswith("MODE2_")}
    assert mode2_keys == {k for k in dir(config) if k.startswith("MODE2_")} and len(mode2_keys) == 27
    assert {k: v for k, v in snap.items() if k not in sim_keys and k not in mode2_keys} == {
        "FUEL_START_KG": 100.0, "FUEL_EFFECT_S_PER_KG": 0.03, "REFERENCE_LAP_KM": 4.3,
        "OUTLIER_THRESHOLD": 1.07, "GREEN_FLAG": "1", "MIN_STINT_LAPS_FOR_DEG": 5,
        "apply_lap_km_scaling": False, "pace_min_laps": 8, "fuel_sensitivity_values": [0.025, 0.03, 0.035],
        "deg_min_tyre_life": 2, "compound_fit_min_laps": 10, "box_whisker": 1.5,
        # v1.2 (MODE1_SPEC §6.4) added exactly these 49 non-SIM constants to the snapshot;
        # all 12 pre-v1.2 entries above are unchanged. CONFIGURED policy values, not measurements.
        "CLIFF_FACTOR": 2.0,
        "CLIFF_MIN_S": 1.2,
        "CLIFF_TAIL": 4,
        "COLLAPSE_HOLD": 3,
        "COLLAPSE_S": 1.5,
        "DNF_PRIOR_STRENGTH": 10.0,
        "MOMENTS_FIELD_WIDE_SHARE": 0.3,
        "MOMENTS_MAX_PER_RACE": 8,
        "OPT_STINT_MIN_SESSION_FITS": 6,
        "OPT_STINT_MIN_SLOPE": 0.01,
        "OPT_STINT_WET_COMPOUNDS": ('INTERMEDIATE', 'WET'),
        "OTDI_MIN_RACES": 2,
        "OTDI_RATE_EASY": 0.05,
        "OTDI_RATE_HARD": 0.005,
        "OTDI_SHRINKAGE_RACES": 1.7,
        "POINTS_SCHEDULE_OVERRIDES": {},
        "PREVIEW_AFFINITY_WEIGHT": 0.0,
        "PREVIEW_BACKTEST_FROM": (2025, 5),
        "PREVIEW_CIRCUIT_ALIASES": {'Yas Marina': 70, 'Kuala Lumpur': 63},
        "PREVIEW_HAZARD_PRIOR_RACES": 3.0,
        "PREVIEW_SIM_DRAWS": 20000,
        "PUNCTURE_MIN_LOST": 2,
        "PUNCTURE_S": 6.0,
        "SC_LUCK_MIN_GAIN": 2,
        "SC_RELATIVE_GAIN": 2,
        "TITLE_MIN_RACES_FOR_PL": 5,
        "TITLE_PL_HALF_LIFE": 8.0,
        "TITLE_PL_RIDGE": 1.0,
        "TITLE_PL_TEMPERATURE": 1.0,
        "TITLE_SEED": 20260913,
        "TITLE_SIM_DRAWS": 20000,
        "TITLE_THETA_BOOTSTRAP": 200,
        "UNDERCUT_MAX_GAP": 1,
        "UNDERCUT_WINDOW": 4,
        "WP_ALLOWED_RESULT_COLUMNS": ('grid_position',),
        "WP_BANNED_SOURCES": ('results.status', 'results.classified_position', 'results.laps_completed', 'results.result_time_s', 'results.points', 'results.position', 'sessions.winner_driver_id', 'pace_ranking', 'degradation_fits', 'compound_degradation', 'teammate_h2h', 'driver_season_summary', 'sim_race_params', 'sim_driver_params', 'sim_compound_params', 'sim_driver_compound', 'circuit_odi'),
        "WP_CALIBRATION": 'none',
        "WP_FORM_RACES": 5,
        "WP_GAP_AHEAD_CLIP_S": 120.0,
        "WP_GAP_BEHIND_DEFAULT_S": 60.0,
        "WP_GAP_LEADER_CLIP_S": 300.0,
        "WP_INNER_FOLDS": 5,
        "WP_LEAKAGE_TRIPWIRE_BRIER": 0.005,
        "WP_MODEL_PARAMS": {'max_iter': 80, 'learning_rate': 0.08, 'max_leaf_nodes': 4, 'min_samples_leaf': 500, 'l2_regularization': 10.0, 'max_bins': 128, 'early_stopping': False, 'random_state': 7},
        "WP_N_FOLDS": 10,
        "WP_RELIABILITY_BINS": (0.0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0),
        "WP_SWING_DEDUP_LAPS": 2,
        "WP_SWING_MAX_ANNOTATIONS": 5,
        "WP_SWING_MIN_MASS": 0.15,
    }
    h = assumptions.hash_of(snap)
    assert len(h) == 64 and h == assumptions.hash_of(dict(reversed(list(snap.items()))))
    assert h != assumptions.hash_of({**snap, "pace_min_laps": 9})


def test_colours_helpers(hungary_2024):
    assert colours.team_colour("McLaren", hungary_2024, "FF8000") == ("#ff8000", "fastf1")
    assert colours.team_colour("No Such Team", hungary_2024, "FF8000") == ("#ff8000", "results")
    assert colours.team_colour("No Such Team", hungary_2024, None) == ("#e8a33d", "fallback")
    assert colours.team_colour("No Such Team", hungary_2024, "xyz") == ("#e8a33d", "fallback")
    cc = colours.compound_colours(hungary_2024, ["HARD", "MEDIUM", "SOFT", "nan"])
    assert cc["SOFT"] == "#da291c" and "nan" not in cc and "TEST-UNKNOWN" in cc
    assert all(v == v.lower() and v.startswith("#") for v in cc.values())
    assert colours.line_style("NOR", hungary_2024, 0) == ("solid", "fastf1")
    assert colours.line_style("PIA", hungary_2024, 1) == ("dashed", "fastf1")
    assert colours.line_style("ZZZ", hungary_2024, 0) == ("solid", "fallback")
    assert colours.line_style("ZZZ", hungary_2024, 1) == ("dashed", "fallback")
    assert colours.line_style("ZZZ", hungary_2024, 5) == ("dotted", "fallback")


def test_sim_hook_translates_four_tables(race_frames):
    """SIM_SPEC §3.2: one 'sim' status key, ids added, driver codes resolved, compounds upper-case."""
    session, ids, fr = race_frames
    assert fr.analytics_status["sim"] in ("ok", "empty") or fr.analytics_status["sim"].startswith("error: SimNotEstimable")
    sim_tables = ["sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound"]
    if fr.analytics_status["sim"] != "ok":
        assert all(len(fr.tables[t]) == 0 for t in sim_tables)
        return
    rp = fr.tables["sim_race_params"]
    assert len(rp) == 1 and rp["session_id"].iloc[0] == 42 and rp["assumption_set_id"].iloc[0] == ASSUMPTION_SET_ID
    assert rp["total_laps"].iloc[0] == int(session.total_laps)
    for t in sim_tables[1:]:
        df = fr.tables[t]
        assert len(df) >= 1 and (df["session_id"] == 42).all() and (df["assumption_set_id"] == ASSUMPTION_SET_ID).all(), t
    known = set(ids.code_to_driver_id.values())
    assert set(fr.tables["sim_driver_params"]["driver_id"]) <= known
    assert set(fr.tables["sim_driver_compound"]["driver_id"]) <= known
    comps = set(fr.tables["sim_compound_params"]["compound"]) | set(fr.tables["sim_driver_compound"]["compound"])
    assert comps and all(c == c.upper() and c != "NAN" for c in comps)
    assert len(fr.tables["sim_driver_params"]) == fr.tables["sim_driver_params"]["driver_id"].nunique()


# ---------------------------------------------------------------------------
# GAPFILL_SPEC v1.8 Gap B -- the column contract WP-S1 lands in frames.py (§4.6).
# Fast: no fixture, no session, no database. These fail until WP-S1 appends the six
# columns, and that is the point -- §6.2 sequences WP-S1 after WP-B1 precisely so the
# column list is specified by a test before it is written.
# ---------------------------------------------------------------------------

TRAIL_COLUMNS = ["brake_release_m", "brake_release_to_apex_m", "brake_on_distance_m",
                 "trail_duty", "trail_status"]


def test_lap_corner_speeds_carries_the_five_trail_columns():
    cols = frames.EXPECTED_COLUMNS["lap_corner_speeds"]
    assert cols[:14] == [
        "session_id", "driver_id", "lap_number", "corner_number", "corner_letter",
        "apex_speed_kph", "apex_distance_m", "entry_speed_kph", "exit_speed_kph",
        "brake_zone_idx", "brake_point_m", "brake_distance_m", "throttle_point_m",
        "time_in_corner_s"], "the fourteen pre-existing columns may not move (D7)"
    # Postgres appends on ADD COLUMN, so the five land at ordinal 15-19 -- that is the
    # true physical order and what copy_frame must reproduce, whatever §4.1's prose
    # "after brake_distance_m" suggests (WP-B0 recorded the same deviation).
    assert cols[14:] == TRAIL_COLUMNS
    assert len(cols) == 19
    types = dict(frames.TABLE_COLUMNS["lap_corner_speeds"])
    assert types["trail_status"] == "text"
    assert all(types[c] == "float" for c in TRAIL_COLUMNS[:4])


def test_lap_telemetry_carries_derive_version():
    # §4.3 / risk R1. Without this column the skip condition cannot see the derivation
    # and a default warm run ships ~25,000 NULLs while the build exits 0.
    cols = frames.EXPECTED_COLUMNS["lap_telemetry"]
    assert cols[-1] == "derive_version"
    assert cols[-2] == "ingested_at"
    assert len(cols) == 21
    assert dict(frames.TABLE_COLUMNS["lap_telemetry"])["derive_version"] == "int"


def test_the_corner_frame_writer_emits_every_trail_column():
    from f1lab import telemetry as t
    src = inspect.getsource(t.corner_metrics) + inspect.getsource(t._apply_trail)
    for col in TRAIL_COLUMNS:
        assert f'"{col}"' in src, f"corner_metrics never writes {col}"
    assert '"derive_version"' in inspect.getsource(t._telemetry_frame)
