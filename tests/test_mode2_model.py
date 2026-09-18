"""WP2 — the Mode 2 pace model (MODE2_SPEC §1, §2).

The gate test of this file is :func:`test_island_intervals_are_widest`. The four
drivers who never changed team and whose team-mates never changed team either --
norris, piastri, alonso, stroll -- sit in two-driver components whose *level* the data
do not identify at all (§1.4). A correct inference therefore hands them the WIDEST
bands on the grid. A fixed-effects fit, or a race-cluster bootstrap, hands them the
narrowest (measured: norris +/-0.050 and +/-0.095 respectively, against verstappen's
+/-0.124), i.e. exactly backwards, and that inversion is the single most dangerous
failure this feature can ship because it reads as confidence. §2.3 forbids the
substitutions that cause it and this test is the build gate for the ban.
"""

from __future__ import annotations

import numpy as np
import pytest

from f1lab import config, decomp

pytestmark = pytest.mark.db

ISLAND_DRIVERS = {"norris", "piastri", "alonso", "stroll"}

# §1.4, measured three times independently and reproduced by this suite.
EXPECTED_COMPONENT_SIZES = [15, 9, 2, 2]


@pytest.fixture(scope="module", autouse=True)
def _restore_downstream_tables(db_conn):
    """Put back what `test_refit_is_bit_identical_and_skips_when_complete` destroys.

    That test calls `recompute_rating(force=True)` twice, and each call DELETEs the
    `mode2_fit_run` row at the current `(assumption_set_id, model_version)`. Every other
    `mode2_*` table cascades from `fit_id`, so the skills, constructor and points tables
    are emptied as a side effect — and `tests/test_mode2_skills.py` and
    `tests/test_mode2_points.py` sort AFTER this file, so in a whole-suite run they used
    to fail against empty tables while passing in isolation. Whoever debugs that sees a
    dozen unrelated failures and no cause.

    Restoring costs ~3 minutes once per module. Without it `pytest tests/ -q` — the §9.3
    integration gate — cannot be green in a single pass.
    """
    yield
    from f1lab import assumptions

    decomp.recompute_all(db_conn, assumptions.get_or_create(db_conn), force=True)
    db_conn.commit()


@pytest.fixture(scope="module")
def rows(db_conn):
    """The §1.3 modelled design, loaded once for the whole module."""
    from f1lab import assumptions

    asid = assumptions.get_or_create(db_conn)
    return decomp.load_rows(db_conn, asid)


@pytest.fixture(scope="module")
def components(rows):
    return decomp.build_components(rows)


def test_load_rows_reproduces_the_measured_window(rows):
    """§1.3: 983 simulable race rows -> 930 modelled across 28 drivers / 31 cells."""
    assert len(rows) == 983, "simulable race rows"
    inc = rows[rows["included"]]
    assert len(inc) == 930, "modelled rows after the §1.3 filter"
    assert inc["driver_id"].nunique() == 28
    assert inc["cell_id"].nunique() == 31
    # 52, not §1.3's 56: the four races with fewer than MODE2_MIN_CARS_IN_RACE usable
    # cars (2024 R23, 2025 R6, 2026 R5, 2026 R9 -- 11 rows between them) are dropped
    # whole, so 56 is the count of sessions LOADED and 52 the count MODELLED. The row,
    # driver and cell counts all match §1.3 exactly.
    assert rows["session_id"].nunique() == 56
    assert inc["session_id"].nunique() == 52
    # every excluded row carries a reason; no included row carries one (DDL CHECK)
    assert rows.loc[~rows["included"], "exclude_reason"].notna().all()
    assert rows.loc[rows["included"], "exclude_reason"].isna().all()


def test_components_are_four(components):
    """§1.4 — the headline honesty fact, as a structural assertion."""
    assert len(components) == 4, f"expected 4 components, got {sorted(components)}"
    sizes = [len(components[k]["drivers"]) for k in sorted(components)]
    assert sizes == EXPECTED_COMPONENT_SIZES, dict(zip(sorted(components), sizes))
    islands = {d for k, c in components.items() if c["is_floating"] for d in c["drivers"]}
    assert islands == ISLAND_DRIVERS
    # K3 is Aston, K4 is McLaren; both are pairs, and each owns three cells.
    assert set(components["K3"]["drivers"]) == {"alonso", "stroll"}
    assert set(components["K4"]["drivers"]) == {"norris", "piastri"}
    for k in ("K3", "K4"):
        assert len(components[k]["cells"]) == 3
    assert not components["K1"]["is_floating"] and not components["K2"]["is_floating"]


def test_graph_shape_is_the_measured_one(rows, components):
    """28 drivers, 31 cells, 72 edges, 59 nodes, 17 independent cycles (§1.4)."""
    inc = rows[rows["included"]]
    n_d, n_c = inc["driver_id"].nunique(), inc["cell_id"].nunique()
    edges = inc.groupby(["driver_id", "cell_id"]).size().shape[0]
    assert (n_d, n_c, edges) == (28, 31, 72)
    assert edges - (n_d + n_c) + len(components) == 17, "independent cycles"


# ---------------------------------------------------------------------------
# the fit, and the interval-direction gate
# ---------------------------------------------------------------------------

# A reduced replicate count: the island gap is 0.182 vs 0.126 pp, ~45 % wide, and
# separates cleanly at 64 reps. The shipping run uses MODE2_BOOTSTRAP_REPS (400).
TEST_REPS = 64


@pytest.fixture(scope="module")
def fit(rows):
    f = decomp.fit_reml(rows)
    assert f.converged, "REML did not converge on the live window"
    return f


@pytest.fixture(scope="module")
def draws(fit):
    return decomp.bootstrap(fit, reps=TEST_REPS, n_jobs=config.MODE2_BOOTSTRAP_JOBS,
                            seed=config.MODE2_SEED)


def test_fit_reproduces_the_measured_variance_components(fit):
    """§1.6, Spec S. Tolerances are loose enough for a different BLAS, tight enough
    that a respecification (dropping the slope, unweighting, unpooling) fails."""
    tau = fit.tau
    assert tau["tau_driver"] == pytest.approx(0.264, abs=0.03)
    assert tau["tau_car"] == pytest.approx(0.874, abs=0.08)
    assert tau["tau_slope"] == pytest.approx(0.348, abs=0.06)
    # 0.418 is §1.6's number; this implementation measures 0.385 because the REML
    # criterion is optimised through the exact 91x91 reduced system to |grad| < 3e-6
    # rather than stopped at a 125-iteration simplex. The tolerance is wide enough for
    # both and far too tight for a respecification.
    assert tau["sigma_resid"] == pytest.approx(0.40, abs=0.05)
    assert 0.2 <= tau["sigma_resid"] <= 1.0, "§2.6 residual scale gate"
    # the headline ratio is an SD ratio, ~3.3, and is never squared anywhere.
    assert 2.5 <= tau["tau_car"] / tau["tau_driver"] <= 4.5


def test_island_intervals_are_widest(fit, draws):
    """THE GATE (§2.3). The four floating drivers must hold the WIDEST bands, not the
    narrowest, among the drivers we actually saw a lot of.

    A parametric bootstrap passes because it redraws the driver effects from the prior
    every replicate, so an unidentified level moves by ~tau_driver each time. A
    race-cluster bootstrap cannot resample a transfer that never happened and collapses
    these four to the narrowest bands on the grid (measured: norris +/-0.095 against
    verstappen +/-0.294); a fixed-effects fit does it harder (norris +/-0.050).

    The comparison set is drivers with at least the median number of modelled races, and
    that is measured, not a convenience: Doohan's 5 races give him sd_total 0.182, tied
    with Alonso's 43 -- §2.4 says so in those words. Ranking the islands against a
    five-race rookie tests sample size; ranking them against the well-observed half
    tests identifiability, which is the thing that inverts.
    """
    rating = _rating_table(fit, draws)
    assert decomp.interval_direction_ok(rating), "§2.6 interval-direction gate"

    cut = rating["n_races"].median()
    seen = rating[rating["n_races"] >= cut].sort_values("sd_total", ascending=False)
    assert set(seen.head(4)["driver_id"]) == ISLAND_DRIVERS, (
        "island drivers are not the four widest among well-observed drivers -- "
        "intervals are INVERTED. "
        + seen[["driver_id", "n_races", "sd_total"]].head(8).to_string())

    # The structural half of the same fact, and the one a bad bootstrap destroys first:
    # an island's component-offset SD must dwarf a connected component's.
    parts = decomp._level_uncertainty(fit, draws)
    isl = max(parts[d]["sd_island"] for d in ISLAND_DRIVERS)
    conn_ = max(parts[d]["sd_island"] for d in parts if d not in ISLAND_DRIVERS)
    assert min(parts[d]["sd_island"] for d in ISLAND_DRIVERS) > 1.5 * conn_, (
        f"island offset SD {isl:.3f} is not clear of the connected components' {conn_:.3f}")
    for d in ISLAND_DRIVERS:
        assert parts[d]["frac_floating"] > 0.90, (
            f"{d}: only {parts[d]['frac_floating']:.0%} of the uncertainty is assumption; "
            "§2.4 measured ~94 %")


def test_island_within_contrast_is_tight_though_level_is_not(fit, draws):
    """The other half of §1.4: the level is unknown, the PAIR GAP is a measurement."""
    sd = decomp.level_sds(fit, draws)
    con = decomp.contrasts(fit, draws)
    np_row = con[(con["driver_a"] == "norris") & (con["driver_b"] == "piastri")]
    assert len(np_row) == 1, "norris-piastri team-mate contrast is missing"
    se = float(np_row["delta_se"].iloc[0])
    assert bool(np_row["same_component"].iloc[0])
    assert se < 0.7 * sd["norris"], (
        f"gap se {se:.3f} is not much tighter than the level sd {sd['norris']:.3f}")


def _rating_table(fit, draws):
    """The rating frame as recompute_rating would write it, without touching the DB."""
    return decomp._rating_frame(fit, fit.rows, draws, 0, 0)


def test_shrinkage(fit, rows):
    """§2.6 — pooling must shrink. Unpooled effects would be wild and the wildest ones
    would be the most shareable, which is exactly the failure mode of this product."""
    fitted = float(np.std(fit.blup[:len(fit.driver_ids)], ddof=1))
    raw = decomp.raw_teammate_spread(rows)
    assert fitted < raw, f"sd(delta_hat)={fitted:.3f} not below raw team-mate {raw:.3f}"


def test_contrast_is_not_a_difference_of_marginals(fit, draws):
    """§2.5 — the two effects are strongly negatively correlated; differencing their
    marginal SDs roughly doubles the true width of a team-mate gap."""
    con = decomp.contrasts(fit, draws)
    rating = _rating_table(fit, draws).set_index("driver_id")
    row = con[(con["driver_a"] == "norris") & (con["driver_b"] == "piastri")].iloc[0]
    naive = float(np.hypot(rating.loc["norris", "sd_total"],
                           rating.loc["piastri", "sd_total"]))
    assert float(row["delta_se"]) < 0.5 * naive, (
        f"delta_se {row['delta_se']:.3f} is not far below the naive {naive:.3f}")


def test_anchor_class_matches_the_measured_lists(fit, draws):
    """§2.4 — the badge is graph-derived, so it is identical on every skill surface.
    'anchored' is earned by a TRANSFER, not by racing three seasons for one team."""
    r = _rating_table(fit, draws).set_index("driver_id")["anchor_class"].to_dict()
    assert {d for d, a in r.items() if a == "floating"} == ISLAND_DRIVERS
    assert r["max_verstappen"] == "component-anchored", "3 Red Bull cells, one team"
    for d in ("hamilton", "sainz", "ocon", "hulkenberg", "bottas", "tsunoda"):
        assert r[d] == "anchored", d


def test_no_grid_wide_rank_is_derivable(fit, draws):
    """§6.1 — only rank_in_component exists, and it restarts inside every component."""
    r = _rating_table(fit, draws)
    assert "rank" not in r.columns and "rank_overall" not in r.columns
    assert set(r.groupby("component_id")["rank_in_component"].min()) == {1}
    assert r.groupby("component_id")["rank_in_component"].max().to_dict() == {
        "K1": 15, "K2": 9, "K3": 2, "K4": 2}


# ---------------------------------------------------------------------------
# what recompute_rating actually stored
# ---------------------------------------------------------------------------

def _current_fit_id(conn) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT fit_id FROM mode2_fit_run WHERE is_current ORDER BY fit_id DESC")
        row = cur.fetchone()
    return int(row[0]) if row else None


def _table(conn, sql, params=()):
    import pandas as pd
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


@pytest.fixture(scope="module")
def stored(db_conn):
    fid = _current_fit_id(db_conn)
    if fid is None:
        pytest.skip("no current mode2 fit -- run decomp.recompute_rating first")
    return fid


def test_stored_fit_run_is_the_measured_window(db_conn, stored):
    run = _table(db_conn, "SELECT * FROM mode2_fit_run WHERE fit_id = %s", (stored,)).iloc[0]
    shape = (run["n_components"], run["n_rows"], run["n_drivers"], run["n_cells"])
    assert shape == (4, 930, 28, 31), shape
    assert run["converged"] and run["shrinkage_ok"] and run["interval_dir_ok"]
    assert run["n_rows"] + run["n_rows_excluded"] == 983
    assert run["ci_level"] == pytest.approx(0.90)
    # An SD ratio, never a variance ratio (§1.6): 3.3, not 11.
    assert 2.5 <= run["sd_ratio"] <= 4.5
    assert run["sd_ratio_lo"] < run["sd_ratio"] < run["sd_ratio_hi"]


def test_stored_rows_are_all_accounted_for(db_conn, stored):
    a = _table(db_conn, "SELECT included, exclude_reason FROM mode2_row_audit "
                        "WHERE fit_id = %s", (stored,))
    assert len(a) == 983, "every simulable race row is audited, kept or dropped"
    assert int(a["included"].sum()) == 930
    assert a.loc[~a["included"], "exclude_reason"].notna().all()


def test_no_per_season_refit(db_conn, stored):
    """§7.6 — history rows are CUMULATIVE, so n_races_cumulative never decreases."""
    h = _table(db_conn, "SELECT driver_id, through_year, n_races_cumulative, sd_total, "
                        "switched_this_year FROM mode2_driver_rating_history "
                        "WHERE fit_id = %s ORDER BY driver_id, through_year", (stored,))
    assert not h.empty
    for d, g in h.groupby("driver_id"):
        n = list(g["n_races_cumulative"])
        assert n == sorted(n), f"{d}: {n} is not cumulative -- this is a per-season refit"


def test_band_narrows_at_switch(db_conn, stored):
    """§3.5 — a transfer is the only event that adds identifying information, so the band
    NARROWS at a switch and stays flat-and-wide for the islands. Any caption claiming it
    widens at a switch is wrong.

    Compared as a RATIO to that season's cohort median, not in raw pp, and the reason is
    measured: tau_driver is itself re-estimated on each cumulative window (0.195 on 2024
    alone, 0.298 through 2025, 0.265 through 2026), so a raw width partly tracks the
    prior SD rather than the evidence. Two of the thirteen switch transitions widen in
    raw pp for exactly that reason -- Hulkenberg, who switched in both 2025 and 2026 and
    was already inside the 15-driver component in 2024, so there is no unanchored
    baseline for him to improve on. The aggregate and the named case are what the chart
    claims, and both are asserted here.
    """
    h = _table(db_conn, "SELECT driver_id, through_year, sd_total, anchor_class, "
                        "switched_this_year FROM mode2_driver_rating_history "
                        "WHERE fit_id = %s ORDER BY driver_id, through_year", (stored,))
    med = h.groupby("through_year")["sd_total"].median()
    h["rel"] = h["sd_total"] / h["through_year"].map(med)

    ratios, named = [], {}
    for d, g in h.groupby("driver_id"):
        g = g.reset_index(drop=True)
        for i in range(1, len(g)):
            if g.loc[i, "switched_this_year"]:
                ratios.append(g.loc[i, "rel"] / g.loc[i - 1, "rel"])
                named[(d, int(g.loc[i, "through_year"]))] = ratios[-1]
    assert len(ratios) >= 5, f"only {len(ratios)} switch transitions found"
    assert float(np.median(ratios)) < 1.0, (
        f"switches do not narrow the band on the whole: median ratio "
        f"{np.median(ratios):.3f}; {named}")
    # §3.5's named case: the Mercedes -> Ferrari move is what anchors Hamilton.
    assert named[("hamilton", 2025)] < 0.90, named[("hamilton", 2025)]

    # And the other half: no amount of extra racing in the same car narrows an island.
    for d in ISLAND_DRIVERS:
        g = h[h["driver_id"] == d].sort_values("through_year")
        assert not g["switched_this_year"].any()
        assert g["rel"].iloc[-1] >= g["rel"].iloc[0] - 1e-9, (
            f"{d}: an island band narrowed without a transfer -- {list(g['rel'].round(3))}")


def test_interval_direction_gate_rejects_the_inverted_fit(fit, draws):
    """The gate's negative control: prove it FIRES on the failure it exists to catch.

    A race-cluster bootstrap and a fixed-effects fit both hand the island drivers the
    narrowest bands on the grid. Shrinking their errors by 4x is a faithful stand-in --
    measured, norris goes from 0.175 to about 0.044, right past the fixed-effects 0.050 --
    and the gate must refuse it.
    """
    inverted = draws.copy()
    for d in ISLAND_DRIVERS:
        inverted[:, fit.driver_ids.index(d)] *= 0.25
    assert decomp.interval_direction_ok(_rating_table(fit, draws))
    assert not decomp.interval_direction_ok(_rating_table(fit, inverted)), (
        "the interval-direction gate passed a fit with collapsed island bands")


def test_interval_direction_gate_survives_a_low_race_island_driver(fit, draws):
    """The gate must test IDENTIFIABILITY, not sample size, on both sides of its median.

    `interval_direction_ok` compares the widest bands among drivers with at least the
    median race count against the island set. An island driver who misses half a season
    -- a mid-season McLaren or Aston replacement, or Stroll sitting out -- used to fall
    out of the left-hand set while staying in the right-hand one, so the two sides were
    sized differently, the equality could not hold at all, and `_fit_run_row` raised
    `SimNotEstimable` on data whose identifiability had not changed by one bit.
    """
    rating = _rating_table(fit, draws)
    assert decomp.interval_direction_ok(rating)
    for driver in ("stroll", "norris"):
        thin = rating.copy()
        thin.loc[thin["driver_id"] == driver, "n_races"] = 3
        assert decomp.interval_direction_ok(thin), (
            f"the gate failed closed after {driver} dropped below the median race count, "
            "with his band unchanged and still among the four widest")


def test_car_rating_bands_carry_the_specification_term(db_conn, stored):
    """§2.3 — MODE2_SIGMA_SPEC is on every published LEVEL, and a car rating is one.

    The driver level gets it through `_publish_interval`; the car level used to publish
    sqrt(diag(cov)) alone, so every band on /constructor was ~11 % narrower than its own
    "5th-95th percentile" label, and seven same-season car pairs were drawn as separated
    that the spec's own uncertainty accounting overlaps. The slope is deliberately NOT
    widened: it is a contrast, and widening it would move `slope_significant`.
    """
    rows = _table(db_conn, "SELECT gamma_lo, gamma_hi FROM mode2_car_rating "
                           "WHERE fit_id = %s ORDER BY team_id, year", (stored,))
    assert not rows.empty
    half = (rows["gamma_hi"] - rows["gamma_lo"]) / 2.0
    implied_sd = half / decomp._Z90
    assert (implied_sd >= config.MODE2_SIGMA_SPEC - 1e-9).all(), (
        "a car band is narrower than the specification term alone: "
        f"{float(implied_sd.min()):.4f} pp")


def test_refit_is_bit_identical_and_skips_when_complete(db_conn):
    """§6.6 — the four determinism mechanisms, asserted end to end.

    Explicit ORDER BY on every source query, sorted() level order, a constant REML
    start, and a per-replicate rng keyed on the replicate index: two forced refits must
    agree to the last bit, and an unforced one must not refit at all.

    ``fit_seconds`` and ``bootstrap_seconds`` are excluded from the digest and nothing
    else is. They are wall-clock instrumentation, not model output -- measured, they are
    the ONLY two numeric columns that move between two forced refits (by 0.03 s and
    1.3 s), which is itself the evidence that every estimate is reproducible.
    """
    import hashlib

    from f1lab import assumptions

    asid = assumptions.get_or_create(db_conn)

    def digest() -> str:
        h = hashlib.sha256()
        for table in decomp.RATING_TABLES:
            df = _table(db_conn, f"SELECT * FROM {table} WHERE fit_id IN "
                                 f"(SELECT fit_id FROM mode2_fit_run WHERE is_current)")
            num = (df.select_dtypes("number")
                     .drop(columns=["fit_id", "fit_seconds", "bootstrap_seconds"],
                           errors="ignore")
                     .sort_index(axis=1))
            # Postgres physical order changes between runs; the CONTENT must not, so the
            # digest is taken over deterministically ordered rows (§6.6's own point).
            num = num.sort_values(list(num.columns)).reset_index(drop=True)
            h.update(num.round(12).to_csv(index=False).encode())
        return h.hexdigest()

    decomp.recompute_rating(db_conn, asid, force=True)
    db_conn.commit()
    first = digest()
    decomp.recompute_rating(db_conn, asid, force=True)
    db_conn.commit()
    assert digest() == first, "a forced refit is not bit-identical"

    again = decomp.recompute_rating(db_conn, asid, force=False)
    db_conn.commit()
    assert again.get("skipped") is True, again
    assert digest() == first, "the skipped path wrote something"


def test_forced_refit_upserts_on_the_natural_key(db_conn):
    """§6.6 — `--recompute-companion mode2 --force` on UNCHANGED inputs must succeed.

    `model_version` is content-addressed, so a forced refit of an unchanged window
    reproduces the version already stored. A writer that merely INSERTs then collides
    with the live run on `mode2_fit_run_version_idx` -- v1.1's winprob shipped exactly
    that bug -- and the run-end companion step, and therefore the whole ingest, dies on
    healthy data.

    The first half of this test proves the constraint is LIVE by committing the source
    bug on purpose inside a savepoint: the naive INSERT must raise. If a future schema
    change drops that index, this half fails and says so, rather than leaving the second
    half passing for the wrong reason. The second half then drives the real writer and
    asserts the §6.6 lifecycle: one row at that natural key, one `is_current` row for the
    assumption set, and it is the row just written.
    """
    import psycopg

    from f1lab import assumptions, frames

    asid = assumptions.get_or_create(db_conn)
    with db_conn.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = "
                    "'mode2_fit_run_version_idx'")
        idx = cur.fetchone()
    assert idx and "UNIQUE" in idx[0] and "assumption_set_id" in idx[0] \
        and "model_version" in idx[0], f"the natural-key unique index is gone: {idx}"

    cols = [c for c in frames.EXPECTED_COLUMNS["mode2_fit_run"] if c != "fit_id"]
    with db_conn.cursor() as cur:
        cur.execute("SELECT fit_id, model_version FROM mode2_fit_run WHERE "
                    "assumption_set_id = %s AND is_current", (asid,))
        live = cur.fetchone()
    assert live, "no current fit to refit"
    fit_id, mv = int(live[0]), str(live[1])

    with db_conn.cursor() as cur:
        cur.execute("SAVEPOINT source_bug")
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(f"INSERT INTO mode2_fit_run ({', '.join(cols)}) "
                        f"SELECT {', '.join(cols)} FROM mode2_fit_run WHERE fit_id = %s",
                        (fit_id,))
        cur.execute("ROLLBACK TO SAVEPOINT source_bug")

    out = decomp.recompute_rating(db_conn, asid, force=True)
    db_conn.commit()
    assert out.get("skipped") is False and out["model_version"] == mv, out
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND model_version = %s", (asid, mv))
        assert int(cur.fetchone()[0]) == 1, "the forced refit left a duplicate at the key"
        cur.execute("SELECT fit_id FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND is_current", (asid,))
        flagged = cur.fetchall()
    assert [r[0] for r in flagged] == [out["fit_id"]], flagged
