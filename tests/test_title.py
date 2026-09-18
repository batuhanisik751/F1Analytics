"""MODE1_SPEC §2 — title odds (Monte Carlo) and magic numbers (exact arithmetic).

The pinned numbers of §0.4 / §2.5 are acceptance tests: the points schedule is derived
per season (the fastest-lap bonus is 2024-only), so 2026 after R13 has
``max_available = 258`` and nine mathematically eliminated drivers. A single global
``MAX_RACE_POINTS = 26`` would read 268 here and declare those nine alive — that is the
failure this file exists to catch.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from f1lab import config, frames, title

pytestmark = pytest.mark.db

YEAR, AFTER = 2026, 13


@pytest.fixture(scope="module")
def schedule_2026(db_conn):
    return title.points_schedule(db_conn, YEAR)


@pytest.fixture(scope="module")
def clinch_2026(db_conn, schedule_2026):
    return title.clinch_table(db_conn, YEAR, AFTER, schedule_2026)


# ---------------------------------------------------------------------------
# §2.1 / §0.4 — the points schedule is per season
# ---------------------------------------------------------------------------

def test_points_schedule_per_season(db_conn):
    """★ §6.6.8 — the fastest-lap bonus exists in 2024 only."""
    s24 = title.points_schedule(db_conn, 2024)
    s25 = title.points_schedule(db_conn, 2025)
    s26 = title.points_schedule(db_conn, 2026)
    assert s24.max_race_points == 26
    assert s25.max_race_points == 25
    assert s26.max_race_points == 25
    assert (s24.has_fastest_lap_bonus, s25.has_fastest_lap_bonus,
            s26.has_fastest_lap_bonus) == (True, False, False)
    for s in (s24, s25, s26):
        assert s.race_points[:4] == (25, 18, 15, 12)
        assert s.sprint_points[:4] == (8, 7, 6, 5)
        assert s.max_sprint_points == 8


def test_bonus_is_not_defined_as_max_26():
    """§2.1 step 2 — a bonus that never lands on P1 must still be detected.

    ``max(points) == 26`` reads 25 here and would undercount the maximum by one, in the
    unsafe direction (it declares a live driver eliminated).
    """
    race = pd.DataFrame({"position": [1, 2, 3], "min_points": [25, 18, 15],
                         "n_distinct": [1, 2, 1]})
    sprint = pd.DataFrame({"position": [1], "min_points": [8], "n_distinct": [1]})
    s = title._schedule_from_rows(2099, race, sprint)
    assert s.has_fastest_lap_bonus is True
    assert s.max_race_points == 26


def test_points_schedule_at_helpers(schedule_2026):
    assert schedule_2026.race_points_at(1) == 25
    assert schedule_2026.race_points_at(0) == 0
    assert schedule_2026.race_points_at(99) == 0
    assert schedule_2026.sprint_points_at(1) == 8


# ---------------------------------------------------------------------------
# §2.5 — magic numbers, exact arithmetic
# ---------------------------------------------------------------------------

ELIMINATED_2026_R13 = {"sainz", "hulkenberg", "albon", "ocon", "alonso",
                       "tsunoda", "perez", "stroll", "bottas"}


def test_clinch_2026_after_r13(clinch_2026):
    """★ §6.6.9 — every MEASURED number of §2.5's table."""
    c = clinch_2026
    assert list(c.columns) == frames.EXPECTED_COLUMNS["title_clinch"]
    assert len(c) == 23
    assert int(c["max_available"].max()) == 258
    assert int(c["leader_points"].max()) == 267
    assert int(c["is_eliminated"].sum()) == 9
    assert set(c.loc[c["is_eliminated"], "driver_id"]) == ELIMINATED_2026_R13
    assert not bool(c["has_fastest_lap_bonus"].any())
    assert int(c["race_points_max"].max()) == 25
    assert int(c["sprint_points_max"].max()) == 8


def test_bortoleto_is_alive_on_the_boundary(clinch_2026):
    """§2.5 — 10 + 258 = 268 > 267, so bortoleto is alive by one point."""
    row = clinch_2026.set_index("driver_id").loc["bortoleto"]
    assert int(row["points_now"]) == 10
    assert int(row["max_possible_total"]) == 268
    assert bool(row["is_eliminated"]) is False


def test_no_clinch_and_earliest_is_round_17(clinch_2026):
    """§2.5 — nobody can clinch at R14; the earliest arithmetic clinch is R17."""
    lead = clinch_2026.set_index("driver_id").loc["antonelli"]
    assert bool(lead["has_clinched"]) is False
    assert pd.isna(lead["clinch_position"])              # no finish at R14 clinches
    assert int(lead["earliest_clinch_round"]) == 17
    assert int(lead["clinch_margin_needed"]) == 234      # M(14) + 1
    assert int(lead["swing_needed"]) == 234 - (267 - 201)
    assert bool(lead["next_round_has_sprint"]) is False
    others = clinch_2026[clinch_2026["driver_id"] != "antonelli"]
    assert others["clinch_margin_needed"].isna().all()
    assert others["earliest_clinch_round"].isna().all()


def test_max_available_matches_the_calendar(db_conn, schedule_2026):
    """§2.5 — M(k) for the 2026 tail, and 2024's bonus-carrying M(0)."""
    cal = title._calendar(db_conn, YEAR)
    assert title.max_available(cal, 13, schedule_2026) == 10 * 25 + 1 * 8 == 258
    assert title.max_available(cal, 14, schedule_2026) == 233
    assert title.max_available(cal, 16, schedule_2026) == 183
    assert title.max_available(cal, 17, schedule_2026) == 150
    assert title.max_available(cal, 23, schedule_2026) == 0
    cal24 = title._calendar(db_conn, 2024)
    s24 = title.points_schedule(db_conn, 2024)
    assert title.max_available(cal24, 0, s24) == 24 * 26 + 6 * 8


def test_clinch_rival_conditioned(schedule_2026):
    """§6.6.11 — if the leader takes P1 the rival can only take P2.

    Hand-computed: leader 20 clear, one conventional round left (M(k+1) = 25).
    Conditioned, a P1 gives 20 + 25 - 18 = 27 > 25 — a clinch. Crediting the rival an
    unconditional P1 gives 20 + 25 - 25 = 20, not a clinch, and would report the title
    one round later than the arithmetic allows (FD4).
    """
    assert title._clinch_position(120, 100, 25, schedule_2026) == 1
    # At M = 13 the P1 margin (27) still clears but a P2 (13) does not.
    assert title._clinch_position(120, 100, 13, schedule_2026) == 1
    assert title._clinch_position(120, 100, 12, schedule_2026) == 2
    # A wider gap walks the answer down the ladder.
    assert title._clinch_position(140, 100, 25, schedule_2026) == 4


def test_clinch_position_honours_the_bonus(db_conn):
    """§2.5 — the rival is credited the fastest-lap point in a bonus season, the leader never."""
    s24 = title.points_schedule(db_conn, 2024)
    assert s24.has_fastest_lap_bonus is True
    # leader P1 (25, no bonus) vs rival P2 + bonus (19): 20 + 25 - 19 = 26 > 25.
    assert title._clinch_position(120, 100, 26, s24) is None
    assert title._clinch_position(120, 100, 25, s24) == 1


def _fake_conn(monkeypatch, standings: pd.DataFrame, cal: pd.DataFrame):
    """Route :func:`title._read` to canned frames so the arithmetic can be exercised alone."""
    def fake(conn, query, params=()):
        return cal.copy() if "FROM events" in query else standings.copy()
    monkeypatch.setattr(title, "_read", fake)


def test_clinch_boundary_is_alive(monkeypatch, schedule_2026):
    """§6.6.10 — ``points_now + M == leader_points`` is alive, not eliminated.

    A driver who takes every remaining point to draw level has taken every remaining
    win and wins the countback, so elimination is a strict inequality.
    """
    cal = pd.DataFrame({"round": [1, 2], "races": [1, 1], "sprints": [0, 0]})
    stand = pd.DataFrame({
        "after_round": [1, 1, 1],
        "driver_id": ["leader", "edge", "dead"],
        "points": [50, 25, 24],
        "position": [1, 2, 3],
    })
    _fake_conn(monkeypatch, stand, cal)
    c = title.clinch_table(None, 2099, 1, schedule_2026).set_index("driver_id")
    assert int(c.loc["edge", "max_available"]) == 25
    assert bool(c.loc["edge", "is_eliminated"]) is False     # 25 + 25 == 50 exactly
    assert bool(c.loc["dead", "is_eliminated"]) is True      # 24 + 25 == 49 < 50
    assert bool(c.loc["leader", "is_eliminated"]) is False


# ---------------------------------------------------------------------------
# §2.2 / §2.3 — the model halves
# ---------------------------------------------------------------------------

def test_plackett_luce_recovers_a_known_order():
    """§2.2 — θ is mean-centred and orders the field the way the data does."""
    orders = [["a", "b", "c", "d"]] * 20
    theta = title.fit_plackett_luce(orders, [1.0] * 20, config.TITLE_PL_RIDGE)
    assert set(theta) == {"a", "b", "c", "d"}
    assert abs(sum(theta.values())) < 1e-9                      # mean-centred
    assert theta["a"] > theta["b"] > theta["c"] > theta["d"]


def test_plackett_luce_ridge_shrinks_thin_evidence():
    """§2.2 — the ridge *is* the small-sample shrinkage: two races move θ barely."""
    thin = title.fit_plackett_luce([["a", "b"]], [1.0], config.TITLE_PL_RIDGE)
    thick = title.fit_plackett_luce([["a", "b"]] * 40, [1.0] * 40, config.TITLE_PL_RIDGE)
    assert 0.0 < thin["a"] < thick["a"]


def test_plackett_luce_degrades_on_empty_input():
    assert title.fit_plackett_luce([], [], config.TITLE_PL_RIDGE) == {}
    assert title.fit_plackett_luce([["a"]], [1.0], config.TITLE_PL_RIDGE) == {}


def test_finishing_orders_are_prefix_only(db_conn):
    """§2.2 — the fit for ``after_round = k`` may not see round k+1 or any later year."""
    early, _ = title.finishing_orders(db_conn, YEAR, 5)
    late, weights = title.finishing_orders(db_conn, YEAR, AFTER)
    assert 0 < len(early) < len(late)
    assert late[: len(early)] == early                          # strictly a prefix
    assert weights[-1] == pytest.approx(1.0)                    # most recent race weighs 1
    assert weights == sorted(weights)                           # exponential recency


def test_dnf_shrinkage_matches_spec(db_conn):
    """§2.3 MEASURED — Stroll 0.692 -> 0.476, Hamilton 0.000 -> 0.085."""
    assert title.season_dnf_rate(db_conn, YEAR, AFTER) == pytest.approx(0.196, abs=5e-4)
    rates = title.dnf_rates(db_conn, YEAR, AFTER)
    assert rates["stroll"] == pytest.approx(0.476, abs=5e-4)
    assert rates["hamilton"] == pytest.approx(0.085, abs=5e-4)
    assert all(0.0 <= v <= 1.0 for v in rates.values())


# ---------------------------------------------------------------------------
# §2.4 / §2.6 — the Monte Carlo, and its consistency with the arithmetic
# ---------------------------------------------------------------------------

def test_simulate_excludes_the_eliminated_by_construction(schedule_2026):
    """§2.6 — exclusion from the ranking, not reliance on losing 20,000 times."""
    theta = {"a": 1.0, "b": 0.0, "c": -1.0}
    dnf = {d: 0.0 for d in theta}
    rng = np.random.default_rng(7)
    remaining = [{"round": 1, "has_race": True, "has_sprint": False}]
    sim = title.simulate(theta, dnf, remaining, schedule_2026, draws=2000, rng=rng,
                         points_now={"a": 10.0, "b": 8.0, "c": 0.0},
                         eliminated=("a",)).set_index("driver_id")
    assert float(sim.loc["a", "p_title"]) == 0.0
    assert sim["p_title"].sum() == pytest.approx(1.0, abs=1e-9)
    assert float(sim.loc["b", "p_title"]) > float(sim.loc["c", "p_title"])
    # Points are still simulated for an eliminated driver; only the ranking excludes it.
    assert float(sim.loc["a", "expected_points"]) > 10.0


def test_simulate_awards_the_bonus_only_in_a_bonus_season(db_conn):
    """§2.4 step 3 — the fastest-lap point is 2024-only, and lands inside the top ten."""
    theta = {d: 0.0 for d in "abcdefghij"}
    dnf = {d: 0.0 for d in theta}
    remaining = [{"round": 1, "has_race": True, "has_sprint": False}]
    pts = {d: 0.0 for d in theta}
    totals = {}
    for year in (2024, 2026):
        s = title.points_schedule(db_conn, year)
        sim = title.simulate(theta, dnf, remaining, s, draws=4000,
                             rng=np.random.default_rng(11), points_now=pts)
        totals[year] = float(sim["expected_points"].sum())
    assert totals[2026] == pytest.approx(sum(title.points_schedule(db_conn, 2026).race_points))
    assert totals[2024] == pytest.approx(totals[2026] + 1.0)


def test_simulate_handles_a_finished_season(schedule_2026):
    """§2.7 — with no rounds remaining every p_title is 0 or 1."""
    sim = title.simulate({"a": 0.0, "b": 0.0}, {}, [], schedule_2026, draws=100,
                         rng=np.random.default_rng(1),
                         points_now={"a": 40.0, "b": 10.0}).set_index("driver_id")
    assert float(sim.loc["a", "p_title"]) == 1.0
    assert float(sim.loc["b", "p_title"]) == 0.0


@pytest.fixture(scope="module")
def stored(db_conn):
    """The written ``title_odds`` / ``title_clinch`` rows, joined.

    If the tables are empty the fixture recomputes 2026 inside the connection's own
    transaction and rolls it back, so the assertions hold on a database that has not
    had ``--recompute-season`` run against it yet.
    """
    joined = title._read(db_conn, """
        SELECT c.year, c.after_round, c.driver_id, c.is_eliminated, c.points_now,
               c.leader_points, o.p_title, o.p_title_lo, o.p_title_hi, o.p_top3,
               o.points_p10, o.points_p90, o.mc_stderr, o.draws
        FROM title_clinch c JOIN title_odds o USING (year, after_round, driver_id)""")
    if not joined.empty:
        yield joined
        return
    from f1lab import assumptions
    asid = assumptions.get_or_create(db_conn)
    title.recompute_title(db_conn, YEAR, asid)
    try:
        yield title._read(db_conn, """
            SELECT c.year, c.after_round, c.driver_id, c.is_eliminated, c.points_now,
                   c.leader_points, o.p_title, o.p_title_lo, o.p_title_hi, o.p_top3,
                   o.points_p10, o.points_p90, o.mc_stderr, o.draws
            FROM title_clinch c JOIN title_odds o USING (year, after_round, driver_id)""")
    finally:
        db_conn.rollback()


def test_mc_respects_arithmetic(stored):
    """★ §6.6.12 / §2.6 — the forecast may never contradict the arithmetic."""
    assert not stored.empty
    for (year, rnd), grp in stored.groupby(["year", "after_round"]):
        assert grp["p_title"].sum() == pytest.approx(1.0, abs=1e-9), f"{year} R{rnd}"
        dead = grp[grp["is_eliminated"]]
        assert (dead["p_title"] == 0.0).all(), f"{year} R{rnd}"
        leader = int(grp["leader_points"].max())
        assert (dead["points_p90"] <= leader).all(), f"{year} R{rnd}"


def test_stored_probabilities_are_well_formed(stored):
    """§5.2 — probabilities in [0,1], bootstrap band ordered and bracketing nothing absurd."""
    for col in ("p_title", "p_title_lo", "p_title_hi", "p_top3"):
        assert stored[col].between(0.0, 1.0).all(), col
    assert (stored["p_title_lo"] <= stored["p_title_hi"]).all()
    assert (stored["points_p10"] <= stored["points_p90"]).all()
    assert (stored["points_p10"] >= stored["points_now"] - 1e-9).all()
    assert (stored["draws"] == int(config.TITLE_SIM_DRAWS)).all()


def test_bootstrap_band_is_wider_than_monte_carlo_error(stored):
    """§2.4.1 — the band covers model uncertainty in θ, not the draw count.

    At N = 20,000 the binomial half-width is ~0.007 at p = 0.5. Drawing *that* as the
    interval would be dishonest; the bootstrap band is several times wider.
    """
    contested = stored[(stored["p_title"] > 0.02) & (stored["p_title"] < 0.98)]
    assert len(contested) > 20
    width = contested["p_title_hi"] - contested["p_title_lo"]
    assert (width > 4.0 * contested["mc_stderr"]).mean() > 0.9


# ---------------------------------------------------------------------------
# §2.7 — empty and degraded states
# ---------------------------------------------------------------------------

def test_recompute_title_writes_nothing_for_an_unrun_season(db_conn):
    """§2.7 — a season with zero completed rounds produces no rows rather than raising."""
    from f1lab import assumptions
    asid = assumptions.get_or_create(db_conn)
    try:
        assert title.recompute_title(db_conn, 2099, asid) == {"title_odds": 0, "title_clinch": 0}
    finally:
        db_conn.rollback()


def test_points_schedule_falls_back_to_the_last_derivable_season(db_conn):
    """§2.1 — a season with no race results borrows the most recent schedule, tagged with its own year."""
    s = title.points_schedule(db_conn, 2099)
    assert s.year == 2099
    assert s.race_points[:3] == (25, 18, 15)
    assert s.max_race_points == 25            # 2026's schedule, not 2024's bonus


def test_clinch_table_is_empty_for_an_unrun_season(db_conn, schedule_2026):
    c = title.clinch_table(db_conn, 2099, 1, schedule_2026)
    assert c.empty
    assert list(c.columns) == frames.EXPECTED_COLUMNS["title_clinch"]


def test_recompute_title_is_wired_into_season_recompute():
    """§5.6 / §6.2 — the odds are rebuilt inside the same transaction as the standings."""
    import inspect

    from f1lab import season

    src = inspect.getsource(season.recompute)
    assert "recompute_title" in src
