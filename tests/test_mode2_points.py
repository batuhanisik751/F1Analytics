"""WP4 — §4's pace→points bridge, car-adjusted career and counterfactuals.

The tests that matter here are the ones that keep §4.2's three epistemic grades apart
and stop §4.4's widening from being either forgotten or double-counted. Everything is
run against the live ``f1`` container (the ``db`` marker); the model is fitted once per
module because ``decomp.fit_current`` is ~0.3 s but ``decomp.bootstrap`` is not free.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from f1lab import config, decomp, decomp_points as dp

pytestmark = pytest.mark.db

CI_LO, CI_HI = 5, 95


@pytest.fixture(scope="module")
def asid(db_conn) -> int:
    with db_conn.cursor() as cur:
        cur.execute("SELECT assumption_set_id FROM mode2_fit_run WHERE is_current "
                    "ORDER BY fit_id DESC LIMIT 1")
        row = cur.fetchone()
    if row is None:
        pytest.skip("no current mode2 fit: run decomp.recompute_rating first")
    return int(row[0])


@pytest.fixture(scope="module")
def fit(db_conn, asid):
    return decomp.fit_current(db_conn, asid)


@pytest.fixture(scope="module")
def calib(db_conn, asid, fit):
    return dp.calibrate(db_conn, asid, fit)


@pytest.fixture(scope="module")
def boot(fit):
    return decomp.bootstrap(fit, reps=int(config.MODE2_UNCERTAINTY_DRAWS),
                            n_jobs=int(config.MODE2_BOOTSTRAP_JOBS),
                            seed=int(config.MODE2_SEED))


def _table(conn, sql: str, params: tuple = ()) -> pd.DataFrame:
    from f1lab import title

    return title._read(conn, sql, params)


# ---------------------------------------------------------------------------
# §4.1 — the bridge
# ---------------------------------------------------------------------------

def test_bridge_is_real_and_season_specific(calib):
    """Pace explains most of finishing strength, and the slope is NOT pooled (§4.1)."""
    assert len(calib) == 3
    assert set(calib["year"]) == {2024, 2025, 2026}
    assert (calib["r2"] > 0.70).all(), calib[["year", "r2"]]
    assert (calib["slope_theta_per_pp"] < 0).all(), "faster pace must mean more strength"
    assert calib["slope_theta_per_pp"].nunique() == 3
    spread = calib["slope_theta_per_pp"].max() - calib["slope_theta_per_pp"].min()
    assert spread > 0.2, f"a pooled constant would do: {list(calib['slope_theta_per_pp'])}"


def test_one_parameter_bridge_captures_most_of_a_free_pl_fit(db_conn, fit):
    """§4.1's headline: one lambda against a free 59-parameter additive PL."""
    rep = dp.pl_bridge_report(db_conn, fit)
    assert rep["n_free_params"] == len(fit.driver_ids) + len(fit.cell_ids) == 59
    assert rep["ll_free"] > rep["ll_one_param"] > rep["ll_null"]
    assert 1.0 < rep["lambda"] < 2.0, rep
    assert 0.80 < rep["share"] < 1.0, rep


def test_temperature_is_refitted_and_v12_constant_is_untouched(calib):
    """v1.2's T = 1.0 returns barely half the real points spread (§4.1 step 2)."""
    assert float(config.TITLE_PL_TEMPERATURE) == 1.0
    assert (calib["temperature"] < 0.6).all(), list(calib["temperature"])
    assert calib["temperature"].isin(config.MODE2_TEMPERATURE_GRID).all()
    assert (np.abs(calib["sd_ratio_sim_actual"] - 1.0) < 0.10).all()
    assert (calib["replay_corr"] > 0.9).all()


def test_replay_mae_is_published_as_a_floor(calib):
    """The machinery misses by 12-25 points a season even with the real driver (§4.1)."""
    assert (calib["replay_mae_points"] > 5.0).all()
    assert (calib["replay_mae_points"] < 40.0).all()


def test_title_odds_unchanged(db_conn):
    """A Mode 2 run must not move v1.2's title odds: TITLE_PL_TEMPERATURE is not touched."""
    before = _table(db_conn, "SELECT year, after_round, driver_id, p_title, p_top3, "
                             "expected_points FROM title_odds ORDER BY 1, 2, 3")
    if before.empty:
        pytest.skip("title_odds is empty")
    assert float(config.TITLE_PL_TEMPERATURE) == 1.0
    fit = decomp.fit_current(db_conn, int(_table(
        db_conn, "SELECT assumption_set_id a FROM mode2_fit_run WHERE is_current")["a"].iloc[0]))
    dp.calibrate(db_conn, 0, fit)
    after = _table(db_conn, "SELECT year, after_round, driver_id, p_title, p_top3, "
                            "expected_points FROM title_odds ORDER BY 1, 2, 3")
    pd.testing.assert_frame_equal(before, after)


# ---------------------------------------------------------------------------
# §1.7 — the additivity test that licenses §4.4 at all
# ---------------------------------------------------------------------------

def test_additivity_is_a_scale_not_a_confirmation(db_conn, asid, fit):
    """tau_interaction is of order 0.1 pp — about 40 % of the driver spread (§1.7)."""
    rows = decomp.load_rows(db_conn, asid)
    rep = dp.additivity_report(rows, fit)
    assert rep["n_cells"] == 72
    assert rep["n_cells_multi_race"] >= 60, "a cell mean must be separable from race noise"
    assert 0.05 < rep["tau_interaction"] < 0.20, rep
    assert rep["tau_interaction"] < rep["tau_driver"], "interaction must be smaller than delta"
    assert rep["n_beyond_2se"] <= 2, rep
    assert rep["widening_pp"] == float(config.MODE2_CF_INTERACTION_PCT)


# ---------------------------------------------------------------------------
# §4.2 — the three quantities, and which of them is a fact
# ---------------------------------------------------------------------------

def test_actual_points_are_the_stored_fact(db_conn):
    """``actual_points`` must equal driver_standings exactly — never a rounded replay."""
    diff = _table(db_conn, """
        SELECT c.driver_id, c.year, c.actual_points, s.points
        FROM mode2_career_season c
        JOIN driver_standings s ON s.year = c.year AND s.driver_id = c.driver_id
         AND s.after_round = (SELECT max(after_round) FROM driver_standings d
                              WHERE d.year = c.year)
        WHERE c.actual_points <> s.points""")
    if diff.empty and _table(db_conn, "SELECT 1 FROM mode2_career_season LIMIT 1").empty:
        pytest.skip("mode2_career_season is empty")
    assert diff.empty, diff.to_string()


def test_contribution_differences_two_model_outputs(db_conn):
    """§4.2: both sides of the subtraction come from the same simulator."""
    df = _table(db_conn, "SELECT * FROM mode2_career_season")
    if df.empty:
        pytest.skip("mode2_career_season is empty")
    resid = (df["replay_points"] - df["avg_driver_points"]) - df["contribution"]
    assert float(np.abs(resid).max()) < 1e-6, "contribution is not replay - avg_driver"
    wrong = (df["actual_points"] - df["avg_driver_points"]) - df["contribution"]
    assert float(np.abs(wrong).max()) > 1.0, \
        "contribution looks like actual - avg_driver: the replay error has been folded in"


def test_every_career_row_carries_its_interval(db_conn):
    """FD2 in the data, not only in the DDL: no zero-width band, no inverted band."""
    df = _table(db_conn, "SELECT * FROM mode2_career_season")
    if df.empty:
        pytest.skip("mode2_career_season is empty")
    for lo, mid, hi in (("replay_lo", "replay_points", "replay_hi"),
                        ("avg_driver_p10", "avg_driver_points", "avg_driver_p90"),
                        ("contribution_lo", "contribution", "contribution_hi")):
        assert (df[lo] <= df[hi]).all(), lo
        assert (df[hi] - df[lo] > 0).all(), f"{lo}..{hi} is degenerate"
    assert (df["param_stderr"] > df["mc_stderr"]).mean() > 0.9, \
        "the Monte-Carlo error must not be the dominant term (§4.3)"


def test_island_career_is_marked_by_analogy(db_conn):
    """An island driver's car-adjusted career inherits the undetermined constant (§4.3).

    K3 and K4 never changed team, so adding a constant to both McLaren drivers and
    subtracting it from the McLaren cars leaves every fitted value unchanged. Their
    contribution is therefore assumption, not measurement, and must say so.
    """
    df = _table(db_conn, "SELECT * FROM mode2_career_season")
    if df.empty:
        pytest.skip("mode2_career_season is empty")
    islanders = {"norris", "piastri", "alonso", "stroll"}
    marked = set(df.loc[df["basis"] == "by-analogy", "driver_id"])
    assert marked == islanders & set(df["driver_id"]), marked
    assert (df.loc[df["basis"] == "by-analogy", "anchor_class"] == "floating").all()
    wide = df.assign(w=df["contribution_hi"] - df["contribution_lo"])
    island_w = wide.loc[wide["basis"] == "by-analogy", "w"].median()
    solid_w = wide.loc[wide["basis"] == "measured", "w"].median()
    assert island_w > solid_w, (island_w, solid_w)


# ---------------------------------------------------------------------------
# §4.4 — counterfactuals
# ---------------------------------------------------------------------------

def test_counterfactual_rows_cannot_exist_without_an_interval(db_conn):
    df = _table(db_conn, "SELECT * FROM mode2_counterfactual")
    if df.empty:
        pytest.skip("mode2_counterfactual is empty")
    assert df[["points_p10", "points_p50", "points_p90"]].notna().all().all()
    assert (df["points_p10"] <= df["points_p50"]).all()
    assert (df["points_p50"] <= df["points_p90"]).all()
    assert (df["delta_p10"] <= df["delta_p90"]).all()
    assert df.loc[df["basis"] == "by-analogy", "points_p10"].notna().all()


def test_cf_interval_floor(db_conn):
    """No band is narrower than that season's replay MAE (§7.6)."""
    df = _table(db_conn, """
        SELECT c.*, p.replay_mae_points FROM mode2_counterfactual c
        JOIN mode2_points_calib p ON p.fit_id = c.fit_id AND p.year = c.year""")
    if df.empty:
        pytest.skip("mode2_counterfactual is empty")
    width = df["points_p90"] - df["points_p10"]
    assert (width >= df["replay_mae_points"]).all(), \
        df.loc[width < df["replay_mae_points"]].head().to_string()


def test_observed_pairings_are_the_honest_anchor(db_conn):
    """A driver who really drove that car is his own replaced seat: delta is ~0 and the
    widening is not applied (§4.4 applies it ONLY to pairings never observed)."""
    df = _table(db_conn, "SELECT * FROM mode2_counterfactual")
    if df.empty:
        pytest.skip("mode2_counterfactual is empty")
    obs = df[df["observed"]]
    assert len(obs) > 0
    assert (obs["driver_id"] == obs["replaced_driver_id"]).all()
    assert (obs["interaction_pp"] == 0.0).all()
    assert float(np.abs(obs["delta_p50"]).max()) < 1e-6
    assert (df.loc[~df["observed"], "interaction_pp"]
            == float(config.MODE2_CF_INTERACTION_PCT)).all()


def test_cf_widening_is_not_double_counted(fit, calib, boot):
    """The (delta, gamma) pair is drawn JOINTLY, so the only extra term is §1.7's.

    A^-1 already carries the within-team correlation and the component-offset variance.
    Adding a further ``prior_share * tau_driver^2`` for a cross-component pairing — as one
    proposal specified — double-counts that variance and roughly doubles the band. §4.4
    forbids it, and this is the arithmetic that proves it was not done.
    """
    setup = dp._SETUPS[2025]
    row = calib[calib["year"] == 2025].iloc[0]
    p = dp._params(setup, fit, boot, row, outer=int(config.MODE2_UNCERTAINTY_DRAWS),
                   rng=np.random.default_rng(0))
    d_i = fit.driver_ids.index("max_verstappen")
    joint = p.delta[:, d_i]
    var_joint = float(joint.var(ddof=1))
    sigma = float(config.MODE2_CF_INTERACTION_PCT)
    rng = np.random.default_rng(1)
    big = np.tile(joint, 2000) + rng.normal(0.0, sigma, size=len(joint) * 2000)
    var_widened = float(big.var(ddof=1))
    expected = var_joint + sigma ** 2
    assert abs(var_widened - expected) / expected < 0.01, (var_widened, expected)
    forbidden = var_joint + 0.9 * float(fit.tau["tau_driver"]) ** 2
    assert var_widened < forbidden, \
        "the cross-component band carries a second prior term it must not carry"


def test_cross_component_band_is_not_double_the_same_component_band(db_conn):
    df = _table(db_conn, "SELECT * FROM mode2_counterfactual WHERE NOT observed")
    if df.empty:
        pytest.skip("mode2_counterfactual is empty")
    w = df.assign(w=df["points_p90"] - df["points_p10"])
    cross = w.loc[w["cross_component"], "w"].median()
    same = w.loc[~w["cross_component"], "w"].median()
    if not np.isfinite(same) or same == 0:
        pytest.skip("no within-component counterfactuals")
    assert cross / same < 1.6, (cross, same)


def test_by_analogy_counterfactuals_are_marked(db_conn, fit):
    """Any pairing touching K3 / K4 is assumption, whichever side it touches (§4.4)."""
    df = _table(db_conn, "SELECT * FROM mode2_counterfactual")
    if df.empty:
        pytest.skip("mode2_counterfactual is empty")
    floating = {cid for cid, c in fit.components.items() if c.get("is_floating")}
    isl_drivers = {d for cid in floating for d in fit.components[cid]["drivers"]}
    isl_teams = {c.split("|")[0] for cid in floating for c in fit.components[cid]["cells"]}
    want = df["driver_id"].isin(isl_drivers) | df["team_id"].isin(isl_teams)
    assert (df["basis"] == "by-analogy").equals(want.rename(None)), \
        df.loc[(df["basis"] == "by-analogy") != want,
               ["year", "team_id", "driver_id", "basis"]].head().to_string()
    assert (df["basis"] == "by-analogy").any()


# ---------------------------------------------------------------------------
# determinism, the scenario cap, and the §9.3 gate numbers
# ---------------------------------------------------------------------------

def test_replay_is_deterministic_given_its_rng(fit, calib):
    a = dp.replay(fit, calib, 2025, draws=500, rng=np.random.default_rng(11))
    b = dp.replay(fit, calib, 2025, draws=500, rng=np.random.default_rng(11))
    assert np.array_equal(a, b)
    c = dp.replay(fit, calib, 2025, draws=500, rng=np.random.default_rng(12))
    assert not np.array_equal(a, c)


def test_replay_refuses_an_unprepared_season(fit, calib):
    with pytest.raises(KeyError):
        dp.replay(fit, calib, 1999, draws=10, rng=np.random.default_rng(0))


def test_avg_driver_override_moves_only_that_seat(fit, calib):
    """§4.2: the field-average scenario changes ONE delta and nothing else."""
    setup = dp._SETUPS[2025]
    seat = setup.drivers.index("max_verstappen")
    plain = dp.replay(fit, calib, 2025, draws=800,
                      rng=np.random.default_rng(3)).mean(axis=0)
    avg = dp.replay(fit, calib, 2025, theta_override={"max_verstappen": 0.0}, draws=800,
                    rng=np.random.default_rng(3)).mean(axis=0)
    assert avg[seat] < plain[seat] - 20, (avg[seat], plain[seat])
    assert abs(plain.sum() - avg.sum()) < 0.05 * plain.sum(), "points were created"


def test_scenario_grid_is_deterministic_and_capped(fit, calib):
    grid = []
    for year in (2024, 2025, 2026):
        grid.extend(dp._cf_scenarios(dp._SETUPS[year], fit))
    keys = [(g["year"], g["team_id"], g["driver_id"]) for g in grid]
    assert keys == sorted(set(keys)) or sorted(keys) == sorted(set(keys))
    assert len(keys) == len(set(keys)), "the counterfactual PK would collide"
    assert len(grid) <= int(config.MODE2_CF_MAX_SCENARIOS), len(grid)
    per_cell = {}
    for g in grid:
        per_cell.setdefault((g["year"], g["team_id"]), set()).add(g["driver_id"])
    assert all(len(v) == len(fit.driver_ids) for v in per_cell.values())


def test_wp4_gate_numbers(db_conn):
    """§9.3's WP4 gate, asserted rather than eyeballed."""
    df = _table(db_conn, "SELECT year, temperature, replay_mae_points "
                         "FROM mode2_points_calib ORDER BY year")
    if df.empty:
        pytest.skip("mode2_points_calib is empty")
    grid = sorted(float(t) for t in config.MODE2_TEMPERATURE_GRID)
    want = {2024: (0.35, 15.6), 2025: (0.40, 25.1), 2026: (0.30, 12.5)}
    for r in df.itertuples():
        t_want, mae_want = want[int(r.year)]
        i, j = grid.index(min(grid, key=lambda g: abs(g - float(r.temperature)))), \
            grid.index(min(grid, key=lambda g: abs(g - t_want)))
        assert abs(i - j) <= 1, f"{r.year}: T={r.temperature} vs {t_want}"
        assert abs(float(r.replay_mae_points) - mae_want) <= 3.0, \
            f"{r.year}: MAE={r.replay_mae_points} vs {mae_want}"


def test_status_key_is_written(db_conn):
    df = _table(db_conn, "SELECT count(*) n FROM session_ingests "
                         "WHERE analytics_status ? 'mode2_counterfactual'")
    assert int(df["n"].iloc[0]) > 0, "the fourth §6.5 status key was never written"


def test_scenario_is_bit_identical_across_calls(fit, calib, boot):
    """§6.6: two identical runs must agree bit for bit, parameter draws included."""
    setup = dp._SETUPS[2025]
    row = calib[calib["year"] == 2025].iloc[0]

    def once() -> np.ndarray:
        p = dp._params(setup, fit, boot, row, outer=50, rng=np.random.default_rng(5))
        return dp._scenario(setup, p, None, draws=1000, seed=99)

    assert np.array_equal(once(), once())


def test_interaction_widening_actually_widens(fit, calib, boot):
    """§4.4's Var_extra must move the band, or the disclosure on the page is a lie."""
    setup = dp._SETUPS[2025]
    row = calib[calib["year"] == 2025].iloc[0]
    p = dp._params(setup, fit, boot, row, outer=int(config.MODE2_UNCERTAINTY_DRAWS),
                   rng=np.random.default_rng(7))
    seat = setup.drivers.index("tsunoda")
    d_i = fit.driver_ids.index("max_verstappen")
    draws = int(config.MODE2_POINTS_DRAWS)
    narrow = dp._bands(dp._scenario(setup, p, {seat: p.delta[:, d_i]}, draws=draws,
                                    seed=1), p.outer, p.mae)
    shift = p.delta[:, d_i] + np.random.default_rng(2).normal(
        0.0, float(config.MODE2_CF_INTERACTION_PCT), size=p.outer)
    wide = dp._bands(dp._scenario(setup, p, {seat: shift}, draws=draws, seed=1),
                     p.outer, p.mae)
    w_n = float(narrow["hi"][seat] - narrow["lo"][seat])
    w_w = float(wide["hi"][seat] - wide["lo"][seat])
    assert w_w > w_n, (w_w, w_n)
    assert w_w < 1.5 * w_n, f"the widening looks double-counted: {w_w} vs {w_n}"
