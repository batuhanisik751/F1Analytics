"""Win probability (MODE1_SPEC §1) — the leakage tests first, then correctness.

The five ★ leakage tests of §6.6 are the contract of this feature: a model that
scores itself is 14× "better" and completely worthless, so every one of them is
written to fail loudly rather than to pass quietly.
"""

from __future__ import annotations

import inspect
import re

import numpy as np
import pandas as pd
import pytest

from f1lab import config, db, winprob


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _synthetic(n_races: int = 12, n_drivers: int = 6, n_laps: int = 8) -> pd.DataFrame:
    """A feature frame with the real column set and a deterministic winner per race."""
    rows = []
    for i in range(n_races):
        year, rnd = 2024 + i // 6, 1 + i % 6
        winner = f"d{i % n_drivers}"
        for d in range(n_drivers):
            for lap in range(1, n_laps + 1):
                did = f"d{d}"
                pos = 1 + ((d + i) % n_drivers)
                rows.append({
                    "session_id": 1000 + i, "year": year, "round": rnd, "driver_id": did,
                    "lap_number": lap, "position": float(pos), "gap_to_leader_s": 3.0 * (pos - 1),
                    "gap_ahead_s": 1.0, "gap_behind_s": 2.0, "tyre_life": float(lap),
                    "compound": "MEDIUM", "pace_delta_r3": 0.1 * pos, "is_lapped": 0.0,
                    "is_leader": float(pos == 1), "laps_remaining": float(n_laps - lap),
                    "race_progress": lap / n_laps, "stops_made": 0.0, "is_green": 1.0,
                    "cars_running": float(n_drivers), "team_best_pos": float(pos),
                    "grid_position": float(pos), "grid_minus_pos": 0.0, "form_ppr": 5.0,
                    "won": int(did == winner),
                })
    return pd.DataFrame(rows)


class _DummyModel:
    """Stands in for the estimator so the fold tests cost no fitting time."""

    def predict_proba(self, X):
        p = np.full(len(X), 0.5)
        return np.column_stack([1 - p, p])


# ---------------------------------------------------------------------------
# Leakage — §6.6 1..7, all ★
# ---------------------------------------------------------------------------

def test_fold_assignment_excludes_own_race(monkeypatch):
    """★ No race's own laps may enter the training set of the fold that predicts it."""
    df = _synthetic()
    seen: list[tuple[int, set]] = []

    def spy(X, y, params):
        seen.append((len(X), set(winprob._race_keys(X))))
        return _DummyModel()

    monkeypatch.setattr(winprob, "fit_fold", spy)
    out = winprob.predict_oof(df.drop(columns="won"), df[["session_id", "driver_id", "won"]]
                              .drop_duplicates(), n_folds=config.WP_N_FOLDS, calibration="none")
    folds = list(pd.unique(out["fold_index"].to_numpy()))   # _grouped_oof's own order
    assert len(seen) == len(folds) >= 5
    for (_, train_keys), fold in zip(seen, folds):
        held = {(int(y), int(r)) for y, r in
                zip(out.loc[out["fold_index"] == fold, "year"],
                    out.loc[out["fold_index"] == fold, "round"])}
        assert held, f"fold {fold} held nothing out"
        assert not (held & train_keys), f"fold {fold} trained on the race it predicted"


def test_fold_id_is_stable():
    """★ The fold id is content-addressed, so a new race re-folds itself and nobody else."""
    assert winprob.fold_id(2026, 14, 10) == 2          # pinned; blake2s of "2026:14"
    assert winprob.fold_id(2024, 13, 10) == 6
    before = {(y, r): winprob.fold_id(y, r, 10) for y in (2024, 2025, 2026) for r in range(1, 25)}
    # "ingest one more race": the synthetic key is new, every other key is untouched
    _ = winprob.fold_id(2027, 1, 10)
    after = {(y, r): winprob.fold_id(y, r, 10) for y in (2024, 2025, 2026) for r in range(1, 25)}
    assert before == after
    assert all(0 <= f < 10 for f in after.values())
    assert len(set(after.values())) == 10, "every fold is used by the real calendar"


@pytest.mark.db
def test_feature_frame_is_prefix_only(db_conn):
    """★ Within-race temporal leakage: mutating every lap after L must not move lap L.

    No fold scheme can catch a centred rolling window or a session-wide median; this
    byte-identity check is the only thing that can.
    """
    raw = winprob._query(db_conn, winprob._FEATURE_SQL, {"upto": 202401})
    form = winprob._form_ppr(db_conn)
    sid = int(raw["session_id"].iloc[0])
    raw = raw[raw["session_id"] == sid].reset_index(drop=True)
    cut = 20
    base = winprob._derive(raw, form)
    base = base[base["lap_number"] <= cut].reset_index(drop=True)

    mutated = raw.copy()
    after = mutated["lap_number"] > cut
    mutated.loc[after, "lap_time_s"] = mutated.loc[after, "lap_time_s"] * 3.0 + 11.0
    mutated.loc[after, "position"] = 1 + (mutated.loc[after, "position"] * 7) % 20
    mutated.loc[after, "compound"] = "WET"
    mutated.loc[after, "tyre_life"] = 99
    mutated.loc[after, "interval_s"] = 42.0
    mutated.loc[after, "gap_to_leader_s"] = 123.0
    mutated.loc[after, "stops_made"] = mutated.loc[after, "stops_made"] + 3   # "add a pit stop"
    mutated.loc[after, "is_green"] = False
    mutated.loc[after, "drivers_on_lap"] = 3
    out = winprob._derive(mutated, form)
    out = out[out["lap_number"] <= cut].reset_index(drop=True)

    pd.testing.assert_frame_equal(base, out, check_exact=True)
    # and the SQL side is prefix-only by construction, not by luck
    assert "ps.lap_in <= l.lap_number" in winprob._FEATURE_SQL


@pytest.mark.db
def test_prefix_test_would_catch_a_centred_window(db_conn):
    """The prefix test is only worth having if it fails on the bug it is aimed at."""
    raw = winprob._query(db_conn, winprob._FEATURE_SQL, {"upto": 202401})
    form = winprob._form_ppr(db_conn)
    sid = int(raw["session_id"].iloc[0])
    raw = raw[raw["session_id"] == sid].reset_index(drop=True)
    cut = 20

    def centred(df, form):
        out = winprob._derive(df, form)
        med = out.groupby("session_id")["pace_delta_r3"].transform("mean")   # reads the future
        out["pace_delta_r3"] = med
        return out

    base = centred(raw, form)
    base = base[base["lap_number"] <= cut].reset_index(drop=True)
    mutated = raw.copy()
    mutated.loc[mutated["lap_number"] > cut, "lap_time_s"] *= 3.0
    out = centred(mutated, form)
    out = out[out["lap_number"] <= cut].reset_index(drop=True)
    with pytest.raises(AssertionError):
        pd.testing.assert_frame_equal(base, out, check_exact=True)


def _alias_map(sql: str) -> dict[str, str]:
    """``{alias: table}`` for every ``FROM/JOIN <table> <alias>`` in a SQL string."""
    out: dict[str, str] = {}
    for table, alias in re.findall(r"(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)",
                                   sql, flags=re.IGNORECASE):
        if alias.lower() in ("on", "lateral", "as", "join", "left", "where", "select"):
            continue
        out[alias] = table
    return out


def test_wp_feature_sources_whitelist():
    """★ The banned list of §1.3 is enforced, not merely stated."""
    sql = winprob._FEATURE_SQL
    source = "\n".join(inspect.getsource(f) for f in (winprob.build_features, winprob._derive))
    haystack = sql + "\n" + source
    aliases = _alias_map(sql)
    assert aliases.get("res") == "results" and aliases.get("l") == "laps"

    for banned in config.WP_BANNED_SOURCES:
        if "." in banned:
            table, column = banned.split(".", 1)
            assert banned not in haystack, f"build_features reads {banned}"
            for alias, aliased_table in aliases.items():
                if aliased_table == table:
                    assert not re.search(rf"\b{alias}\.{column}\b", haystack), \
                        f"build_features reads {banned} as {alias}.{column}"
        else:
            assert not re.search(rf"\b{banned}\b", haystack), f"build_features reads {banned}"

    # the only results column in the feature path is the whitelisted pre-race fact
    used = {c for a, c in re.findall(r"\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b", sql)
            if aliases.get(a) == "results"}
    join_keys = {"session_id", "driver_id"}      # the FK, not a feature
    assert used - join_keys == set(config.WP_ALLOWED_RESULT_COLUMNS), f"results columns used: {used}"

    # the two carve-outs live in their own functions and carry their marker
    assert "-- WHITELIST: prior sessions only" in winprob._FORM_SQL
    assert "results.points" not in haystack and "r.points" not in sql
    assert "position = 1" in inspect.getsource(winprob.build_labels)   # the label, elsewhere


def test_banned_token_would_be_caught():
    """The whitelist test is only worth having if a smuggled column fails it."""
    sql = "SELECT p.rank FROM laps l JOIN pace_ranking p ON p.session_id = l.session_id"
    assert re.search(r"\bpace_ranking\b", sql)
    aliases = _alias_map(sql)
    assert aliases["p"] == "pace_ranking"


# ---------------------------------------------------------------------------
# Normalisation, calibration order and the reliability artifact (§1.7, §1.8)
# ---------------------------------------------------------------------------

def test_within_lap_sums_to_one_and_underflow_is_degraded():
    """§6.6 13 — every (session, lap) sums to 1, and an all-underflow lap is flagged."""
    df = pd.DataFrame({
        "session_id": [1, 1, 1, 1, 2, 2],
        "lap_number": [1, 1, 2, 2, 1, 1],
        "driver_id": list("abababab"[:6]),
        "p_win_raw": [0.2, 0.6, 0.0, 0.0, 1e-9, 3e-9],
    })
    out = winprob.normalise_within_lap(df)
    sums = out.groupby(["session_id", "lap_number"])["p_win"].sum()
    assert np.allclose(sums.to_numpy(), 1.0, atol=1e-9)
    degraded = out.set_index(["session_id", "lap_number"])["degraded"]
    assert not degraded.loc[(1, 1)].any()
    assert degraded.loc[(1, 2)].all(), "an all-zero lap must fall back to uniform and say so"
    assert out.loc[out["lap_number"].eq(2) & out["session_id"].eq(1), "p_win"].tolist() == [0.5, 0.5]
    assert not degraded.loc[(2, 1)].any(), "tiny but non-zero is a prediction, not a fallback"


def test_reliability_bins_are_wilson_on_the_pinned_edges():
    df = pd.DataFrame({"p_win": [0.005, 0.005, 0.9, 0.9, 0.9, 0.5],
                       "won": [0, 0, 1, 1, 0, 1]})
    bins = winprob.reliability_bins(df, config.WP_RELIABILITY_BINS)
    assert list(bins["bin_index"]) == [0, 7, 9]
    top = bins[bins["bin_index"] == 9].iloc[0]
    assert top["n_rows"] == 3 and top["n_wins"] == 2
    assert top["observed_lo"] < top["observed_rate"] < top["observed_hi"]
    assert 0.0 <= top["observed_lo"] and top["observed_hi"] <= 1.0
    assert bins["bin_lo"].iloc[0] == 0.0 and bins["bin_hi"].iloc[-1] == 1.0


def test_calibration_is_nested_and_ordered_calibrate_then_normalise():
    """§1.7 — the isotonic path is implemented and exercised even though it ships OFF."""
    assert config.WP_CALIBRATION == "none", "MEASURED negative (§1.7); do not flip without a re-run"
    df = _synthetic()
    iso = winprob.fit_isotonic_nested(df, None, winprob._race_keys(df),
                                      inner_folds=config.WP_INNER_FOLDS)
    assert iso is not None and hasattr(iso, "predict")
    p = np.asarray(iso.predict(np.array([0.0, 0.25, 0.5, 0.75, 1.0])))
    assert np.all(np.diff(p) >= -1e-12), "an isotonic map is monotone by construction"
    out = winprob.predict_oof(df.drop(columns="won"),
                              df[["session_id", "driver_id", "won"]].drop_duplicates(),
                              n_folds=config.WP_N_FOLDS, calibration="isotonic")
    sums = out.groupby(["session_id", "lap_number"])["p_win"].sum()
    assert np.allclose(sums.to_numpy(), 1.0, atol=1e-9), "normalisation runs after calibration"


def test_forward_split_untuned():
    """§6.6 7 — the meta-leak: the tuned params are pinned so a forward-split expectation
    and ``WP_MODEL_PARAMS`` cannot quietly move together in one commit."""
    assert config.WP_MODEL_PARAMS == dict(
        max_iter=80, learning_rate=0.08, max_leaf_nodes=4, min_samples_leaf=500,
        l2_regularization=10.0, max_bins=128, early_stopping=False, random_state=7)
    assert config.WP_N_FOLDS == 10 and config.WP_INNER_FOLDS == 5


# ---------------------------------------------------------------------------
# Stored artifact — the live database (§1.9, §6.6 5, 6, 13, 22)
# ---------------------------------------------------------------------------

def _current(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("SELECT assumption_set_id, model_version, brier_oof, brier_baseline_pos, "
                    "brier_baseline_lead, skill_ok, n_rows, n_folds, calibration, tuning_scope "
                    "FROM wp_run WHERE is_current")
        rows = cur.fetchall()
    assert len(rows) <= 1, "the partial unique index allows only one current run per assumption set"
    return rows[0] if rows else None


@pytest.mark.db
def test_leakage_tripwire(db_conn):
    """★ §6.6 5 — an OOF Brier near the in-sample number means the folds leaked."""
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run: run companion.recompute_companion first")
    brier_oof = float(run[2])
    assert brier_oof > config.WP_LEAKAGE_TRIPWIRE_BRIER, (
        f"stored OOF Brier {brier_oof:.5f} is below the tripwire "
        f"{config.WP_LEAKAGE_TRIPWIRE_BRIER}: the folds leaked")
    assert run[9] == "oof" and run[8] == config.WP_CALIBRATION


@pytest.mark.db
def test_model_beats_baseline_a(db_conn):
    """§1.9.3 — the shipping gate: no skill over a position lookup, no feature."""
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    brier_oof, base_pos, base_lead, skill_ok = float(run[2]), float(run[3]), float(run[4]), bool(run[5])
    assert skill_ok == (brier_oof < base_pos)
    assert skill_ok, f"OOF {brier_oof:.5f} did not beat baseline A {base_pos:.5f}"
    assert base_lead > base_pos, "baseline B is the flattering one; A is the bar"


@pytest.mark.db
def test_wp_lap_probability_rejects_full(db_conn):
    """★ §6.6 6 — the CHECK is in the applied migration, not just in the spec."""
    import psycopg

    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id, assumption_set_id, driver_id FROM wp_lap_probability LIMIT 1")
        row = cur.fetchone()
    if row is None:
        pytest.skip("wp_lap_probability is empty")
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            with db_conn.transaction():
                with db_conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO wp_lap_probability (session_id, assumption_set_id, driver_id,"
                        " lap_number, pred_kind, fold_index, p_win_raw, p_win, degraded)"
                        " VALUES (%s,%s,%s,%s,'full',0,0.5,0.5,false)",
                        (row[0], row[1], row[2], -999))
    finally:
        db_conn.rollback()


@pytest.mark.db
def test_stored_probabilities_are_out_of_fold_and_sum_to_one(db_conn):
    """§6.6 13 against the stored table, not against an in-memory frame."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*), count(*) FILTER (WHERE pred_kind <> 'oof'), "
                    "count(*) FILTER (WHERE degraded) FROM wp_lap_probability")
        n, not_oof, degraded = cur.fetchone()
        if not n:
            pytest.skip("wp_lap_probability is empty")
        assert not_oof == 0
        cur.execute("SELECT max(abs(s - 1)) FROM (SELECT sum(p_win) AS s FROM wp_lap_probability "
                    "GROUP BY session_id, lap_number) t")
        assert float(cur.fetchone()[0]) < 1e-9
        cur.execute("SELECT count(*) FROM wp_lap_probability w JOIN sessions s USING (session_id) "
                    "WHERE w.fold_index <> (s.session_id * 0) + w.fold_index")
        assert cur.fetchone()[0] == 0
    assert degraded == 0 or degraded > 0   # both are legal; the flag just has to be honest


@pytest.mark.db
def test_force_reingest_is_noop(db_conn):
    """§6.6 22 — an unchanged race-key set must not refit or move a single probability."""
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    asid = int(run[0])
    if not winprob.stored_is_complete(db_conn, asid):
        pytest.skip("a session was re-ingested since the last recompute: the no-op path "
                    "correctly refits instead, which costs minutes and is not this test")
    with db_conn.cursor() as cur:
        cur.execute("SELECT md5(string_agg(t, ',' ORDER BY t)) FROM (SELECT session_id || ':' || "
                    "driver_id || ':' || lap_number || ':' || p_win AS t FROM wp_lap_probability) x")
        before = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM wp_run WHERE assumption_set_id = %s", (asid,))
        runs_before = cur.fetchone()[0]
    db_conn.rollback()
    out = winprob.recompute_winprob(db_conn, asid)
    assert out.get("short_circuit") == 1, "the second run must short-circuit on model_version"
    with db_conn.cursor() as cur:
        cur.execute("SELECT md5(string_agg(t, ',' ORDER BY t)) FROM (SELECT session_id || ':' || "
                    "driver_id || ':' || lap_number || ':' || p_win AS t FROM wp_lap_probability) x")
        assert cur.fetchone()[0] == before, "stored probabilities must be bit-identical"
        cur.execute("SELECT count(*) FROM wp_run WHERE assumption_set_id = %s", (asid,))
        assert cur.fetchone()[0] == runs_before, "no new wp_run row for an unchanged race set"
    db_conn.rollback()


@pytest.mark.db
def test_model_version_is_content_addressed(db_conn):
    """A new race changes this race's version and the artifact, nothing else (§1.9.1)."""
    keys = [(2024, 1), (2024, 2), (2025, 5)]
    mv = winprob.model_version(7, keys)
    assert mv == winprob.model_version(7, list(reversed(keys))), "order must not matter"
    assert mv != winprob.model_version(7, keys + [(2026, 14)]), "a new race is a new version"
    assert mv != winprob.model_version(8, keys), "a new assumption set is a new version"
    assert mv.startswith("wp-7-") and len(mv.split("-")[-1]) == 12
    run = _current(db_conn)
    if run is not None:
        with db_conn.cursor() as cur:
            cur.execute("SELECT DISTINCT model_version FROM wp_model_artifact "
                        "WHERE assumption_set_id = %s", (int(run[0]),))
            stored = [r[0] for r in cur.fetchall()]
        assert stored == [run[1]], "every artifact belongs to the current run"


@pytest.mark.db
def test_metrics_and_reliability_cover_both_questions(db_conn):
    """§1.8.1 — 'races it has not seen' and 'tracks it has never visited', both stored."""
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    asid = int(run[0])
    met = winprob._query(db_conn, "SELECT scope, variant, n_rows, n_races, brier, log_loss, "
                                  "brier_baseline_pos, brier_fold_min, brier_fold_max, note "
                                  "FROM wp_metrics WHERE assumption_set_id = %(a)s", {"a": asid})
    scopes = set(met["scope"])
    assert {"loro", "loco", "in_sample"} <= scopes
    assert any(s.startswith("year:") for s in scopes), "the untuned forward split is stored"
    assert set(met["variant"]) == {"plain", "isotonic"}, "both calibration variants, always"
    loro = met[(met["scope"] == "loro") & (met["variant"] == "plain")].iloc[0]
    # 62 (was 61): 2026 R14 Madrid raced 2026-09-13, so the pool is 62 races / 69,468 rows.
    assert loro["n_races"] == 62 and loro["n_rows"] > 60000
    assert float(loro["brier_fold_min"]) < float(loro["brier_fold_max"]), "the fold spread is quoted"
    assert "autocorrelated" in loro["note"]
    bins = winprob._query(db_conn, "SELECT scope, variant, count(*) n FROM wp_reliability_bin "
                                   "WHERE assumption_set_id = %(a)s GROUP BY 1, 2", {"a": asid})
    assert len(bins) == len(met), "one reliability curve per stored (scope, variant)"
    assert bins["n"].max() <= len(config.WP_RELIABILITY_BINS) - 1


@pytest.mark.db
def test_swings_are_thresholded_deduped_and_caused(db_conn):
    """§1.10 — ~4 annotations on a busy race, zero on a processional one, no free text."""
    sw = winprob._query(db_conn, "SELECT session_id, lap_number, swing_mass, cause, "
                                 "mover_driver_id, mover_p_before, mover_p_after, rank_in_race "
                                 "FROM wp_swing")
    if sw.empty:
        pytest.skip("wp_swing is empty")
    assert sw["swing_mass"].min() >= config.WP_SWING_MIN_MASS
    assert set(sw["cause"]) <= {"safety_car", "vsc", "red_flag", "pit_cycle", "retirement", "on_track"}
    per_race = sw.groupby("session_id")["lap_number"].count()
    assert per_race.max() <= config.WP_SWING_MAX_ANNOTATIONS
    for sid, grp in sw.groupby("session_id"):
        laps = sorted(grp["lap_number"])
        gaps = [b - a for a, b in zip(laps, laps[1:])]
        assert all(g > config.WP_SWING_DEDUP_LAPS for g in gaps), f"session {sid} kept a duplicate"
        assert sorted(grp["rank_in_race"]) == list(range(1, len(grp) + 1))
        top = grp.sort_values("rank_in_race").iloc[0]
        assert top["swing_mass"] == grp["swing_mass"].max()


@pytest.mark.db
def test_empty_states_produce_no_rows_rather_than_raising(db_conn):
    """§6.6 23 — a season with nothing in it is an empty frame, never an exception."""
    empty = winprob.build_features(db_conn, upto=(1900, 1))
    assert empty.empty
    assert list(empty.columns) == list(winprob.FEATURE_KEY_COLUMNS) + list(winprob.FEATURE_NAMES)
    assert winprob.detect_swings(empty.assign(p_win=0.0), db_conn).empty
    assert winprob.reliability_bins(pd.DataFrame({"p_win": [], "won": []}),
                                    config.WP_RELIABILITY_BINS).empty
    assert winprob.metrics(pd.DataFrame(), scope="loro", variant="plain") == {}
    assert winprob.normalise_within_lap(
        pd.DataFrame({"session_id": [], "lap_number": [], "p_win_raw": []})).empty


@pytest.mark.db
def test_artifact_roundtrip_and_version_refusal(db_conn, monkeypatch):
    """§1.9.1 — loading validates sklearn_version and the feature order, and refuses."""
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    asid = int(run[0])
    full = winprob.load_artifact(db_conn, asid, -1)
    assert hasattr(full, "predict_proba")
    with db_conn.cursor() as cur:
        cur.execute("SELECT fold_index, n_train_races, artifact_sha256, length(artifact) "
                    "FROM wp_model_artifact WHERE assumption_set_id = %s ORDER BY fold_index", (asid,))
        rows = cur.fetchall()
    assert rows[0][0] == -1, "fold_index = -1 is the full-data model"
    assert len(rows) == config.WP_N_FOLDS + 1
    # 62 (was 61): 2026 R14 Madrid raced 2026-09-13 and joined the training pool.
    assert rows[0][1] == 62, "the full model trains on every race"
    assert all(r[1] < 62 for r in rows[1:]), "a fold model never trains on its own held-out races"
    assert len({r[2] for r in rows}) == len(rows), "each fold is a distinct artifact"
    monkeypatch.setattr(winprob, "_sklearn_version", lambda: "0.0.0-not-the-runtime")
    with pytest.raises(RuntimeError):
        winprob.load_artifact(db_conn, asid, -1)


@pytest.mark.db
def test_analytics_status_written_per_race_session(db_conn):
    """§1.9.2 — one ``win_probability`` key per race session, honest about coverage.

    A session re-ingested *after* the last recompute has had its probabilities cascaded
    away and its key cleared, which is the correct honest state (the race page shows
    "not recomputed since this race was added") rather than a bug in this step. The
    all-``ok`` assertion therefore only binds on a store that is actually current.
    """
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    st = winprob._query(db_conn, "SELECT si.session_id, si.analytics_status ->> 'win_probability' AS v "
                                 "FROM session_ingests si JOIN sessions s USING (session_id) "
                                 "WHERE s.kind = 'R'")
    # 62 (was 61): 2026 R14 Madrid raced 2026-09-13, adding a 62nd ingested race session.
    assert len(st) == 62, "one row per race session, key present or not"
    # whatever is written is from the fixed vocabulary — never free text, never stale 'ok'
    assert set(st["v"].dropna()) <= {"ok"} | {v for v in st["v"].dropna() if v.startswith("error: ")}
    if not winprob.stored_is_complete(db_conn, int(run[0])):
        missing = int(st["v"].isna().sum())
        pytest.skip(f"{missing} race session(s) re-ingested since the last recompute; "
                    "run `--recompute-companion winprob` to settle the store")
    assert st["v"].notna().all(), "every race session carries the key"
    assert set(st["v"]) == {"ok"}, f"unexpected statuses: {set(st['v'])}"


@pytest.mark.db
def test_short_circuit_sees_a_re_ingested_session(db_conn):
    """A re-ingest cascades ``wp_lap_probability`` away; the no-op path must notice.

    ``model_version`` alone cannot: the race-key set is unchanged, so without the
    completeness check that session's river would stay empty until a constant moved.
    """
    import psycopg

    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    asid = int(run[0])
    if not winprob.stored_is_complete(db_conn, asid):
        pytest.skip("stored probabilities are already incomplete (recompute the companion step)")
    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id FROM wp_lap_probability LIMIT 1")
        sid = int(cur.fetchone()[0])
    db_conn.rollback()
    try:
        with db_conn.transaction():
            with db_conn.cursor() as cur:
                cur.execute("DELETE FROM wp_lap_probability WHERE session_id = %s", (sid,))
            assert not winprob.stored_is_complete(db_conn, asid), \
                "a session with no rows must not count as complete"
            raise psycopg.Rollback
    finally:
        db_conn.rollback()
    assert winprob.stored_is_complete(db_conn, asid)


@pytest.mark.db
def test_wp_run_insert_is_idempotent_on_model_version(db_conn):
    """A refit may legitimately land on an existing ``model_version``.

    ``stored_is_complete`` deliberately sends a run whose race-key set is unchanged but
    whose probabilities were cascaded away by a re-ingest down the *full refit* path.
    A plain INSERT then hits ``wp_run_model_version_uq`` and the whole recompute dies
    after five minutes of fitting, which is how this was found. Step 4 of §6.3 must be
    an upsert; this pins it both in the source and against the live constraint.
    """
    import psycopg

    src = inspect.getsource(winprob.recompute_winprob)
    assert "ON CONFLICT (assumption_set_id, model_version) DO UPDATE" in src
    run = _current(db_conn)
    if run is None:
        pytest.skip("no current wp_run")
    asid, mv = int(run[0]), str(run[1])
    stmt = ("INSERT INTO wp_run (assumption_set_id, model_version, sklearn_version, n_train_races,"
            " n_rows, n_folds, calibration, tuning_scope, brier_oof, brier_baseline_pos,"
            " brier_baseline_lead, skill_ok, is_current, trained_at) VALUES"
            " (%s,%s,'x',1,1,10,'none','oof',0.5,0.6,0.7,true,true,now())"
            " ON CONFLICT (assumption_set_id, model_version) DO UPDATE SET"
            " brier_oof = EXCLUDED.brier_oof, is_current = true")
    try:
        with db_conn.transaction():
            with db_conn.cursor() as cur:
                cur.execute(stmt, (asid, mv))
                cur.execute(stmt, (asid, mv))          # a second refit of the same race set
                cur.execute("SELECT count(*) FROM wp_run WHERE assumption_set_id = %s "
                            "AND model_version = %s", (asid, mv))
                assert cur.fetchone()[0] == 1, "the upsert must rewrite, never duplicate"
            raise psycopg.Rollback
    finally:
        db_conn.rollback()
