"""Weekend preview — MODE1_SPEC §3, tests §6.6 items 18-20 and the §3 half of 23.

The DB-backed tests read the live database; they are gated by the ``db`` marker and
never write to it. The pure tests exercise ``odi_frame`` / ``simulate_order`` /
``_fit_pl_local`` on synthetic frames, so the two failure modes that matter — a scale
that moves when the circuit set changes, and a prediction that has seen its own race —
are caught without a database at all.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from f1lab import config, frames, preview


# ---------------------------------------------------------------------------
# §3.2 circuit resolution
# ---------------------------------------------------------------------------

@pytest.mark.db
def test_circuit_resolution_2026(db_conn):
    """★ §6.6.18: the nine still-unraced 2026 rounds (15-23) all resolve to a circuit.

    2026 R14 Madrid raced on 2026-09-13 and took its own circuit row (circuit_key 153,
    'Madring'), so it now resolves natively at step 1 of the §3.2 ladder and is no longer
    the one unresolved round; it is asserted separately below to keep the new-venue coverage.
    R16 is a *fixture defect* — the 2026 Bahrain Grand Prix row carries location
    'Kuala Lumpur' — and resolves to Sakhir (63) through the reviewed alias map; there is
    deliberately no test asserting it is a new venue.
    """
    got = {r: preview.resolve_circuit(db_conn, 2026, r) for r in range(15, 24)}
    unresolved = [r for r, (k, m) in got.items() if k is None]
    assert unresolved == [], got
    assert all(m != "none" for k, m in got.values())
    assert got[16] == (63, "alias")
    assert got[23] == (70, "alias")
    assert len({k for k, _ in got.values() if k is not None}) == 9
    # 153/'native' (was None/'none'): Madrid raced 2026-09-13 and now has its own circuit row.
    assert preview.resolve_circuit(db_conn, 2026, 14) == (153, "native")


@pytest.mark.db
def test_event_name_is_never_used_for_matching(db_conn):
    """The 2026 Spanish GP must NOT inherit Barcelona's history from its event_name."""
    key, match = preview.resolve_circuit(db_conn, 2026, 14)
    assert key != 15, "the 2026 Spanish GP must not inherit Catalunya (15) from its event name"
    # (153, 'native') (was (None, 'none')): Madrid raced 2026-09-13 and now has its own
    # circuit row, so the round resolves at step 1 instead of falling through unmatched.
    assert (key, match) == (153, "native")
    assert "Madrid" not in config.PREVIEW_CIRCUIT_ALIASES


# ---------------------------------------------------------------------------
# §3.3 the overtaking difficulty index
# ---------------------------------------------------------------------------

MONTE_CARLO, MONZA = 22, 39


@pytest.mark.db
def test_odi_monaco_vs_monza(db_conn):
    """§6.6.19: Monaco is at least 8x harder than Monza on the raw measure, and its
    index is the highest of all circuits. MEASURED: 0.0034 vs 0.0430, a factor of 12.6.
    """
    pe = preview.pass_events(db_conn)
    agg = pe.groupby("circuit_key")[["passes", "opportunities"]].sum()
    rate = agg["passes"] / agg["opportunities"]
    assert rate[MONZA] / rate[MONTE_CARLO] >= 8.0, rate[[MONTE_CARLO, MONZA]]

    odi = preview._fetch(db_conn, "SELECT circuit_key, odi FROM circuit_odi",
                         columns=["circuit_key", "odi"])
    assert not odi.empty, "circuit_odi is empty: run --recompute-companion odi"
    assert int(odi.loc[odi["odi"].astype(float).idxmax(), "circuit_key"]) == MONTE_CARLO


@pytest.mark.db
def test_pass_guard_excludes_pit_cycles(db_conn):
    """A promotion by the other car's pit stop is not an overtake (§3.3.1).

    Every circuit's rate must stay well under the naive "count every position gain"
    figure; the guard is what keeps Marina Bay out of mid-field. Sanity-check the shape:
    passes are a small fraction of opportunities everywhere.
    """
    pe = preview.pass_events(db_conn)
    agg = pe.groupby("circuit_key")[["passes", "opportunities"]].sum()
    rate = agg["passes"] / agg["opportunities"]
    assert rate.max() < 0.10 and rate.min() > 0.0
    assert (agg["opportunities"] > 500).all()


def _minmax(rates: pd.Series) -> pd.Series:
    """The rejected alternative (§3.3.3), for contrast: a scale defined by the data."""
    lo, hi = float(rates.min()), float(rates.max())
    return 100.0 * (hi - rates.astype(float)) / (hi - lo)


@pytest.mark.db
def test_odi_scale_is_absolute(db_conn):
    """§6.6.20: a circuit joining the data does not republish everyone else's number.

    The synthetic 25th circuit runs three races at the pooled pass rate and the mean
    covariates, so it carries no news: every existing index must stay put. MEASURED
    largest move: 0.07 of an index point. The same addition under the **rejected**
    min-max scale moves circuits by whole points, which is exactly why the anchors are
    two fixed rates and not the current circuit set.
    """
    pe = preview.pass_events(db_conn)
    ctl = preview.race_controls(db_conn, [int(s) for s in pe["session_id"].unique()])
    before = preview.odi_frame(pe, ctl, 1).set_index("circuit_key")

    pooled = float(pe["passes"].sum() / pe["opportunities"].sum())
    sids = [990001, 990002, 990003]
    syn = pd.DataFrame([(999, sid, lap, int(round(pooled * 600)), 600)
                        for sid in sids for lap in range(1, 51)], columns=pe.columns)
    syn_ctl = pd.DataFrame({"session_id": sids,
                            "spread_pct": [float(ctl["spread_pct"].mean())] * 3,
                            "nongreen_frac": [float(ctl["nongreen_frac"].mean())] * 3})
    after = preview.odi_frame(pd.concat([pe, syn], ignore_index=True),
                              pd.concat([ctl, syn_ctl], ignore_index=True), 1).set_index("circuit_key")

    assert 999 in after.index
    delta = (after.loc[before.index, "odi"].astype(float)
             - before["odi"].astype(float)).abs()
    assert delta.max() < 0.5, delta.sort_values().tail()

def test_minmax_scale_would_move_everyone():
    """Why the anchors are fixed: the rejected min-max scale is defined by its own data.

    Append one circuit easier than every existing one and the fixed log-anchored index is
    unchanged for all of them, while min-max republishes every number — and puts whichever
    circuit happens to be easiest at exactly 0.0, which reads as "zero overtaking
    difficulty" and is false of every circuit on earth (§3.3.3).
    """
    rates = pd.Series({1: 0.004, 2: 0.02, 3: 0.035}, name="adj_pass_rate")
    wider = pd.concat([rates, pd.Series({4: 0.09})])

    fixed_before = rates.map(preview.odi_from_rate)
    fixed_after = wider.map(preview.odi_from_rate).loc[rates.index]
    assert (fixed_after - fixed_before).abs().max() == 0.0

    mm_before = _minmax(rates)
    mm_after = _minmax(wider).loc[rates.index]
    assert (mm_after - mm_before).abs().max() > 5.0
    assert _minmax(wider).min() == 0.0


def test_odi_is_bounded_and_monotone():
    """The index is 0..100 (the DB CHECK) and decreases as passing gets easier."""
    assert preview.odi_from_rate(1.0) == 0.0
    assert preview.odi_from_rate(1e-9) == 100.0
    seq = [preview.odi_from_rate(r) for r in (0.002, 0.005, 0.02, 0.05, 0.2)]
    assert seq == sorted(seq, reverse=True)
    assert all(0.0 <= v <= 100.0 for v in seq)


@pytest.mark.db
def test_odi_needs_min_races(db_conn):
    """§3.3.3 / §3.6: a circuit with one race gets no index at all, not a wide one."""
    assert config.OTDI_MIN_RACES == 2
    pe = preview.pass_events(db_conn)
    ctl = preview.race_controls(db_conn, [int(s) for s in pe["session_id"].unique()])
    solo = pd.DataFrame([(998, 990101, lap, 1, 30) for lap in range(1, 51)], columns=pe.columns)
    solo_ctl = pd.DataFrame({"session_id": [990101], "spread_pct": [1.4], "nongreen_frac": [0.08]})
    out = preview.odi_frame(pd.concat([pe, solo], ignore_index=True),
                            pd.concat([ctl, solo_ctl], ignore_index=True), 1)
    assert 998 not in set(out["circuit_key"])


# ---------------------------------------------------------------------------
# §3.4 safety car and pit loss
# ---------------------------------------------------------------------------

@pytest.mark.db
@pytest.mark.parametrize("circuit_key,name,p_sc,pit", [
    (55, "Zandvoort", 0.472, 21.2),
    (22, "Monte Carlo", 0.442, 19.5),
    (150, "Lusail", 0.387, 26.6),
    (61, "Singapore", 0.309, 27.4),
    (39, "Monza", 0.253, 25.5),
    (7, "Spa-Francorchamps", 0.220, 18.9),
])
def test_hazard_matches_measured_table(db_conn, circuit_key, name, p_sc, pit):
    """§3.4's MEASURED table, reproduced from sim_circuit_hazard with no new fitting.

    The tolerance on P(SC) is 0.01 rather than a hairline: the shrinkage pulls toward
    ``sc_hazard_pooled``, which moves in the third decimal whenever any session in the
    database is re-ingested. Pit loss is per-stop and is pinned to 0.05 s.
    """
    laps = preview.expected_total_laps(db_conn, circuit_key)
    h = preview.hazard_for(db_conn, circuit_key, laps)
    assert h["p_safety_car"] == pytest.approx(p_sc, abs=0.01), name
    assert h["expected_pit_loss_s"] == pytest.approx(pit, abs=0.05), name
    assert 0.0 <= h["p_vsc"] <= 1.0


@pytest.mark.db
def test_hazard_is_empty_for_an_unresolved_venue(db_conn):
    """§3.6: no circuit, no hazard panel — an empty dict, never a fabricated number."""
    assert preview.hazard_for(db_conn, None, 60) == {}
    assert preview.expected_total_laps(db_conn, None) is not None  # pooled median


@pytest.mark.db
def test_sc_shrinkage_pulls_toward_the_pooled_rate(db_conn):
    """The honest reading of §3.4: two or three races cannot separate these circuits."""
    probs = []
    for ckey in (55, 22, 150, 61, 39, 7):
        laps = preview.expected_total_laps(db_conn, ckey)
        probs.append(preview.hazard_for(db_conn, ckey, laps)["p_safety_car"])
    assert 0.20 < min(probs) and max(probs) < 0.50


# ---------------------------------------------------------------------------
# §3.5 / §3.5.1 predicted order and leakage discipline
# ---------------------------------------------------------------------------

@pytest.mark.db
def test_past_orders_are_strictly_prior(db_conn):
    """★ The one leakage rule of §3.5.1: round r is fitted on rounds strictly before r."""
    orders_before, _ = preview.past_orders(db_conn, 2026, 13)
    orders_after, _ = preview.past_orders(db_conn, 2026, 14)
    assert len(orders_after) > len(orders_before)
    assert orders_after[:len(orders_before)] == orders_before

    actual = preview._fetch(
        db_conn, "SELECT r.driver_id FROM results r JOIN sessions s ON s.session_id = r.session_id "
                 "WHERE s.year = 2026 AND s.round = 13 AND s.kind = 'R' AND r.position = 1",
        columns=["driver_id"])
    winner = str(actual["driver_id"].iloc[0])
    # The 2026 R13 order must be absent from the fit used to predict 2026 R13 itself.
    assert all(o[0] != winner or o not in orders_after[len(orders_before):] for o in orders_before)
    assert len(orders_after) - len(orders_before) >= 1


@pytest.mark.db
def test_recency_weights_decay(db_conn):
    """`0.5 ** (races_ago / TITLE_PL_HALF_LIFE)`: newest race weighs 1.0 (§2.2)."""
    _, w = preview.past_orders(db_conn, 2026, 14)
    assert w[-1] == pytest.approx(1.0)
    assert w[0] < w[-1]
    assert w == sorted(w)


@pytest.mark.db
def test_predict_order_is_a_distribution(db_conn):
    """Probabilities are coherent and the 80% interval brackets the point estimate."""
    rng = np.random.default_rng(config.TITLE_SEED)
    df = preview.predict_order(db_conn, 2026, 14, draws=4000, rng=rng)
    assert not df.empty
    assert list(df.columns) == frames.EXPECTED_COLUMNS["preview_finish_order"]
    assert float(df["p_win"].astype(float).sum()) == pytest.approx(1.0, abs=1e-9)
    assert float(df["p_podium"].astype(float).sum()) == pytest.approx(3.0, abs=1e-9)
    assert (df["p_podium"].astype(float) >= df["p_win"].astype(float)).all()
    assert (df["pos_p10"].astype(int) <= df["expected_position"].astype(float)).all()
    assert (df["pos_p90"].astype(int) >= df["expected_position"].astype(float)).all()


def test_affinity_weight_is_a_pinned_negative_result():
    """§3.5: driver-circuit affinity MEASURED not to help, so it is pinned at 0.0."""
    assert config.PREVIEW_AFFINITY_WEIGHT == 0.0


def test_simulate_order_respects_strength_and_dnf():
    """A stronger theta wins more; a certain retirement finishes last, every draw."""
    rng = np.random.default_rng(7)
    drivers = ["strong", "mid", "weak", "broken"]
    theta = {"strong": 1.5, "mid": 0.0, "weak": -1.5, "broken": 2.0}
    dnf = {"strong": 0.0, "mid": 0.0, "weak": 0.0, "broken": 1.0}
    out = preview.simulate_order(drivers, theta, dnf, draws=3000, rng=rng).set_index("driver_id")
    assert out.loc["strong", "p_win"] > out.loc["mid", "p_win"] > out.loc["weak", "p_win"]
    assert out.loc["broken", "p_win"] == 0.0
    assert out.loc["broken", "expected_position"] == pytest.approx(4.0)
    assert float(out["p_win"].sum()) == pytest.approx(1.0)


def test_fit_pl_recovers_a_planted_ordering():
    """The local Plackett-Luce fallback fits the model it claims to, and mean-centres."""
    rng = np.random.default_rng(11)
    truth = {"a": 1.2, "b": 0.4, "c": -0.4, "d": -1.2}
    names = list(truth)
    orders = []
    for _ in range(400):
        score = np.array([truth[n] for n in names]) + rng.gumbel(size=len(names))
        orders.append([names[i] for i in np.argsort(-score)])
    theta = preview._fit_pl_local(orders, [1.0] * len(orders), 0.1)
    assert sum(theta.values()) == pytest.approx(0.0, abs=1e-8)
    assert [k for k, _ in sorted(theta.items(), key=lambda kv: -kv[1])] == names


# ---------------------------------------------------------------------------
# §3.5.1 backtest and §3.6 empty states
# ---------------------------------------------------------------------------

@pytest.mark.db
def test_backtest_rows_are_oof_and_honest(db_conn):
    """Every stored row is `oof`, and a retirement stores NULL rather than a rank.

    `results.position` is populated for retirements too (they are ordered behind the
    finishers), but a retirement has no finishing position to fall inside an interval.
    """
    bt = preview._fetch(db_conn, "SELECT pred_kind, actual_position, inside_interval, "
                                 "pos_p10, pos_p90, expected_position, year, round "
                                 "FROM preview_backtest",
                        columns=["pred_kind", "actual_position", "inside_interval",
                                 "pos_p10", "pos_p90", "expected_position", "year", "round"])
    if bt.empty:
        pytest.skip("preview_backtest is empty: run --recompute-companion preview")
    assert set(bt["pred_kind"]) == {"oof"}
    assert bt["actual_position"].isna().any()
    assert not bt.loc[bt["actual_position"].isna(), "inside_interval"].any()
    assert (bt["pos_p10"] <= bt["pos_p90"]).all()
    earliest = bt[["year", "round"]].apply(tuple, axis=1).min()
    assert earliest >= tuple(config.PREVIEW_BACKTEST_FROM)


@pytest.mark.db
def test_backtest_is_worse_than_the_grid(db_conn):
    """§3.5.1: the caption admits a dumber method wins when it is available.

    MEASURED: grid order scores rho = 0.754, this model 0.597 over the same 32 rounds.
    A future round has no grid, so the model's number is the honest ceiling.
    """
    row = preview._fetch(db_conn, "SELECT backtest_spearman, backtest_grid_spearman, "
                                  "backtest_coverage, backtest_races FROM preview_round LIMIT 1",
                         columns=["rho", "grid", "cov", "races"])
    if row.empty:
        pytest.skip("preview_round is empty: run --recompute-companion preview")
    rho, grid, cov, races = (float(row["rho"][0]), float(row["grid"][0]),
                             float(row["cov"][0]), int(row["races"][0]))
    assert 0.4 < rho < grid
    assert grid == pytest.approx(0.754, abs=0.01)
    assert races >= 30
    assert 0.80 <= cov <= 1.0    # an 80% interval that is, if anything, conservative


@pytest.mark.db
def test_empty_states(db_conn):
    """§6.6.23 / §3.6: every degraded path produces no rows rather than raising."""
    rng = np.random.default_rng(1)
    # A season with no completed rounds yet.
    assert preview.predict_order(db_conn, 2024, 1, draws=100, rng=rng).empty
    # A venue that does not resolve still gets its predicted order (§3.6).
    assert not preview.predict_order(db_conn, 2026, 14, draws=100, rng=rng).empty
    # No pass events at all -> an empty, correctly shaped circuit_odi frame.
    out = preview.odi_frame(pd.DataFrame(columns=["circuit_key", "session_id", "lap_number",
                                                  "passes", "opportunities"]),
                            pd.DataFrame(columns=["session_id", "spread_pct", "nongreen_frac"]), 1)
    assert out.empty and list(out.columns) == frames.EXPECTED_COLUMNS["circuit_odi"]


@pytest.mark.db
def test_preview_rounds_cover_every_unraced_round(db_conn):
    """★ §8 WP3: nine unraced 2026 rounds, all resolved, and both aliases.

    Was ten rounds (14-23) with one unresolved; 2026 R14 Madrid raced on 2026-09-13, so it
    is no longer an unraced round and carries no preview_round row.
    """
    pr = preview._fetch(db_conn, "SELECT round, circuit_key, circuit_match FROM preview_round "
                                 "WHERE year = 2026 ORDER BY round",
                        columns=["round", "circuit_key", "circuit_match"])
    if pr.empty:
        pytest.skip("preview_round is empty: run --recompute-companion preview")
    # rounds 15-23 and zero NULL keys (were 14-23 and one NULL): Madrid raced 2026-09-13.
    assert list(pr["round"]) == list(range(15, 24))
    assert int(pr["circuit_key"].isna().sum()) == 0
    by_round = {int(r): (k, m) for r, k, m in
                zip(pr["round"], pr["circuit_key"], pr["circuit_match"])}
    assert by_round[16] == (63, "alias")
    assert by_round[23] == (70, "alias")
    assert set(pr["circuit_match"]) <= {"native", "location", "alias", "none"}
