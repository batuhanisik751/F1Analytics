"""WP3 — the three skills that ship, the four that are refused, and the constructor
surface (MODE2_SPEC §3, §5; GAPFILL_SPEC §1, §2).

v1.8 added the measured qualifying skill ``one_lap_pace`` (GAPFILL_SPEC §1.3) and did
NOT retire the ``grid_pace`` surrogate it was pre-registered to replace: the retirement
test measured r = 0.8393 over all 28 drivers against a threshold of 0.95, so both ship
and the disagreement between them is the grid penalties, the pit-lane starts and the
sprint-weekend grids -- said in words and never as a per-driver number (DL-8).

Three release-blocking gates live in this file. G1 refits ``grid_pace`` from GRID_SQL
and asserts r = 1.000 against the stored rows BEFORE any correlation is computed; G2
rebuilds the mobility graph on qualifying rows alone and asserts §1.4's four components
member-for-member; G3 fails if either stored correlation reaches the retirement
threshold, so retirement stays a human decision requiring a spec edit.

``test_grid_pace_is_never_called_one_lap_or_qualifying_pace`` is GAPFILL_SPEC R2 and is
NARROWED, never deleted: see its own docstring.

The gate tests of this file are the two refusals. §3.3 fitted tyre management four ways
and every driver's point estimate came out smaller than its own standard error; §3.4
found that in the currency this feature is denominated in -- fuel-corrected race pace --
the number of usable wet observations is exactly zero. Both are stored as rows with a
reason rather than left as absences, because the "What we could not measure" panel is
the product and not an apology (§3.6).

:func:`test_tyre_rejection_still_holds` is a refusal with an expiry date: it refits §3.3
on whatever data is in the database now and fails the build when the skill becomes
fittable, so that a measured rejection cannot silently harden into a permanent omission.
"""

from __future__ import annotations

import numpy as np
import pytest

from f1lab import config, decomp

pytestmark = pytest.mark.db

ISLAND_DRIVERS = {"norris", "piastri", "alonso", "stroll"}
FLOATING_TEAMS = {"mclaren", "aston_martin"}
# GAPFILL_SPEC §2.4 / §5.1, in panel order: three measured, four refused.
SKILLS = ("race_pace", "one_lap_pace", "grid_pace", "tyre_management", "wet",
          "sprint_one_lap", "trail_braking")
MEASURED_SKILLS = ("race_pace", "one_lap_pace", "grid_pace")
REFUSED_SKILLS = ("tyre_management", "wet", "sprint_one_lap", "trail_braking")


@pytest.fixture(scope="module")
def asid(db_conn):
    from f1lab import assumptions

    return assumptions.get_or_create(db_conn)


@pytest.fixture(scope="module")
def components(db_conn, asid):
    return decomp.build_components(decomp.load_rows(db_conn, asid))


@pytest.fixture(scope="module")
def fit_id(db_conn, asid):
    """The fit whose stored rows these tests read.

    NOT keyed on ``asid``. GAPFILL_SPEC §2.4 adds six constants to ``config.py`` and
    every one of them enters the assumption hash, so v1.8 runs under a NEW
    ``assumption_set_id`` and a NEW ``fit_id`` -- the intended, audited path of §6.6,
    not drift. Keying this fixture on the current process's hash would make every
    stored-row test skip for a reason that has nothing to do with the data, so it
    takes the current fit whatever set it was computed under, and skips only when the
    v1.8 skill rows genuinely are not there yet (§6.2 sequencing: the fit has to be
    run before the rows can be checked).
    """
    fid = decomp._current_fit_id(db_conn, asid)
    if fid is None:
        with db_conn.cursor() as cur:
            cur.execute("SELECT fit_id FROM mode2_fit_run WHERE is_current "
                        "ORDER BY fitted_at DESC, fit_id DESC LIMIT 1")
            row = cur.fetchone()
        fid = int(row[0]) if row else None
    if fid is None:
        pytest.skip("no current mode2 fit; run decomp.recompute_all first")
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM mode2_driver_skill WHERE fit_id = %s "
                    "AND skill = 'one_lap_pace'", (fid,))
        if int(cur.fetchone()[0]) == 0:
            pytest.skip(
                f"fit {fid} predates GAPFILL_SPEC v1.8: it carries no one_lap_pace "
                f"rows. Run decomp.recompute_all under the v1.8 assumption set "
                f"before collecting these gates (§6.2).")
    return fid


def _rows(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


# ---------------------------------------------------------------------------
# The skill table: four skills, 28 drivers, two of them refusals
# ---------------------------------------------------------------------------

def test_every_driver_has_all_seven_skills(db_conn, fit_id):
    got = dict(_rows(db_conn, "SELECT skill, count(*) FROM mode2_driver_skill "
                              "WHERE fit_id = %s GROUP BY 1", (fit_id,)))
    assert set(got) == set(SKILLS)
    assert len(set(got.values())) == 1, f"skills cover different driver sets: {got}"


def test_three_skills_measured_and_four_refused(db_conn, fit_id):
    """§2.1 — 7 keys x 28 drivers = 196 rows. DL-11: no CHECK key is added that is not
    written, so sprint_one_lap and trail_braking are real rows, not an empty key."""
    got = {s: (int(m), int(n)) for s, m, n in _rows(
        db_conn, "SELECT skill, count(*) FILTER (WHERE measured), count(*) "
                 "FROM mode2_driver_skill WHERE fit_id = %s GROUP BY 1", (fit_id,))}
    n = got["race_pace"][1]
    for skill in MEASURED_SKILLS:
        assert got[skill] == (n, n), (skill, got[skill])
    for skill in REFUSED_SKILLS:
        assert got[skill] == (0, n), (skill, got[skill])
    assert sum(v[1] for v in got.values()) == 7 * n


def test_refusals_are_rows_with_a_reason_not_absences(db_conn, fit_id):
    """§3.6 — a fan cannot misread a number that is not there, but they can misread an
    omission. The refusal ships as a row carrying the sentence that explains it."""
    for skill, expected in (("tyre_management", decomp.TYRE_NOT_MEASURED),
                            ("wet", decomp.WET_NOT_MEASURED),
                            ("sprint_one_lap", decomp.SPRINT_NOT_MEASURED),
                            ("trail_braking", decomp.TRAIL_NOT_MEASURED)):
        rows = _rows(db_conn, "SELECT value, value_lo, value_hi, not_measured_reason, unit "
                              "FROM mode2_driver_skill WHERE fit_id = %s AND skill = %s",
                     (fit_id, skill))
        assert rows
        for value, lo, hi, reason, unit in rows:
            assert value is None and lo is None and hi is None
            assert reason == expected
            assert unit == "none"


def test_measured_skills_always_carry_an_interval(db_conn, fit_id):
    """FD2 — a point estimate rendered without its uncertainty is a bug in this feature."""
    bad = _rows(db_conn, "SELECT driver_id, skill FROM mode2_driver_skill WHERE fit_id = %s "
                         "AND measured AND (value IS NULL OR value_lo IS NULL "
                         "OR value_hi IS NULL OR value_lo > value OR value > value_hi)",
                (fit_id,))
    assert bad == []


def test_anchor_class_is_identical_across_skills(db_conn, fit_id):
    """§2.4/§3.2 — the badge is graph-derived, so it cannot hatch a driver on one skill
    and not the next. evidence_share deliberately is NOT the badge: the island drivers
    score a comfortable 0.72 on grid pace purely because tau_car/tau_driver is ~1.1
    there instead of ~3.3."""
    bad = _rows(db_conn, "SELECT driver_id, count(DISTINCT anchor_class) FROM "
                         "mode2_driver_skill WHERE fit_id = %s GROUP BY 1 HAVING "
                         "count(DISTINCT anchor_class) > 1", (fit_id,))
    assert bad == []


# ---------------------------------------------------------------------------
# §3.2 — starting-grid pace, and the name it must never be given
# ---------------------------------------------------------------------------
# GAPFILL_SPEC §1 — the measured qualifying skill, and the three release gates
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def one_lap(db_conn, asid, components):
    return decomp.one_lap_pace_report(db_conn, asid, components)


def test_one_lap_pace_reproduces_the_measured_fit(one_lap):
    """§1.5 MEASURED, to four decimals: 1,135 rows / 56 sessions / 28 drivers,
    tau_delta 0.1605, tau_gamma 0.5620, sigma 0.3846.

    The sibling of ``test_grid_pace_reproduces_the_measured_fit``. These are not
    plausibility bands: §1.1 fitted six candidate responses and this is the one that
    ships, so a run that lands anywhere else is fitting a different response and the
    spec's published limitations (§1.2's 43 % attenuation, §1.4's islands, §1.8's
    sprint exclusion) no longer describe what shipped.
    """
    assert one_lap["n_rows"] == 1135
    assert one_lap["n_sessions"] == 56
    assert one_lap["n_drivers"] == 28
    assert one_lap["converged"] is True
    assert round(one_lap["tau_driver"], 4) == 0.1605
    assert round(one_lap["tau_car"], 4) == 0.5620
    assert round(one_lap["sigma_eps"], 4) == 0.3846


def test_one_lap_pace_is_more_car_dominated_than_race_pace_not_less(one_lap):
    """DL-10 / §5.1 forbidden claim 6 — "drivers are closer together over one lap" is
    the one headline that does not survive a scale-clean construction. Measured 3.50 in
    qualifying against 3.31 in the race, so if anything it is slightly MORE car-
    dominated. The copy grep lives in the web tests; this is the number behind it."""
    ratio = one_lap["tau_car"] / one_lap["tau_driver"]
    assert round(ratio, 2) == 3.50
    assert ratio > 3.31


def test_verstappen_is_the_only_rating_clearing_zero_on_the_fast_side(one_lap):
    """§1.5 — twenty-four of twenty-eight qualifying ratings cross zero, and that is the
    honest shape of this feature rather than a defect to be tuned away (C-SKILL-7)."""
    sk = one_lap["skill"]
    fast = sorted(sk.loc[sk["value_hi"].astype(float) < 0, "driver_id"])
    slow = sorted(sk.loc[sk["value_lo"].astype(float) > 0, "driver_id"])
    assert fast == ["max_verstappen"]
    assert slow == ["sargeant", "stroll", "zhou"]
    assert len(sk) - len(fast) - len(slow) == 24


def test_gate_g1_grid_pace_refit_reproduces_the_stored_rows(db_conn, asid, components):
    """GATE G1 (§6.3, DL-6) — MANDATORY, and it runs before any correlation exists.

    If the surrogate does not reproduce from GRID_SQL at r = 1.000, the §1.6 retirement
    comparison is measuring a bug in the re-derivation rather than the data, and a
    pre-registered decision would be taken against a number describing nothing that
    ships."""
    refit = decomp.fit_grid_pace(db_conn, asid, components)
    gate = decomp.assert_grid_pace_reproduces(db_conn, refit)
    assert gate["vacuous"] is False
    assert round(gate["r"], 3) == 1.000
    assert gate["max_abs_diff"] == pytest.approx(0.0, abs=1e-9)


def test_gate_g2_qualifying_adds_rows_not_edges(db_conn, asid, components):
    """GATE G2 (§6.3, §1.4) — fails the RUN, not the page.

    A qualifying session carries the same ``session_entries`` as its own race, so the
    mobility graph built on qualifying rows ALONE must come back member-for-member
    identical: K1 15, K2 9, K3 alonso+stroll, K4 norris+piastri. More qualifying will
    never break the islands; only a transfer will."""
    quali = decomp.quali_components(db_conn, asid, components)
    assert len(quali) == 4
    assert {k: len(v["drivers"]) for k, v in quali.items()} == {
        "K1": 15, "K2": 9, "K3": 2, "K4": 2}
    assert set(quali["K3"]["drivers"]) == {"alonso", "stroll"}
    assert set(quali["K4"]["drivers"]) == {"norris", "piastri"}
    assert ({frozenset(c["drivers"]) for c in quali.values()}
            == {frozenset(c["drivers"]) for c in components.values()})
    decomp.assert_quali_islands_hold(quali, components)


def test_gate_g3_the_retirement_threshold_did_not_fire(db_conn, asid, components, one_lap):
    """GATE G3 (§6.3, §1.6, D2, DL-5) — the build fails if EITHER correlation reaches
    ``MODE2_GRID_RETIRE_R``.

    ``QUALI_SPEC §5.1.1`` pre-registered r >= 0.95 retires ``grid_pace``. Measured
    0.8393 over all 28 and 0.8663 over the 24 non-island drivers, so both skills ship
    and retirement stays a human decision requiring a spec edit. Reported BOTH ways
    because four of 28 levels are set by shrinkage toward each fit's own prior, making
    an all-28 statistic 14 % a comparison of two priors.

    The comparison is `>=`, never `not <`: the three ``corr_*`` columns are nullable on
    purpose and a NULL must not read as a failure.
    """
    grid = decomp.fit_grid_pace(db_conn, asid, components)
    with db_conn.cursor() as cur:
        # Not keyed on ``asid``: the six new §2.4 constants change the assumption hash,
        # so this run's assumption_set_id has no fit under it until recompute_all has
        # been run for v1.8 (§6.6's intended path). The correlation is against the
        # ratings that actually ship, whichever fit holds them.
        cur.execute("SELECT driver_id, rating_pp FROM mode2_driver_rating WHERE fit_id = "
                    "(SELECT fit_id FROM mode2_fit_run WHERE is_current "
                    " ORDER BY fitted_at DESC, fit_id DESC LIMIT 1)")
        race = cur.fetchall()
    if not race:
        pytest.skip("no current mode2 fit; run decomp.recompute_all first")
    import pandas as pd

    race = pd.DataFrame(race, columns=["driver_id", "value"])
    race["anchor_class"] = "anchored"
    corr = decomp.skill_correlations(one_lap["skill"], grid, race)

    assert corr["n_all"] == 28 and corr["n_ex_islands"] == 24
    assert sorted(corr["floating"]) == sorted(ISLAND_DRIVERS)
    assert corr["corr_one_lap_grid"] == pytest.approx(0.8393, abs=0.0005)
    assert corr["corr_one_lap_grid_ex_islands"] == pytest.approx(0.8663, abs=0.0005)
    assert corr["corr_one_lap_race"] == pytest.approx(0.7727, abs=0.0005)
    for key in ("corr_one_lap_grid", "corr_one_lap_grid_ex_islands"):
        assert corr[key] < config.MODE2_GRID_RETIRE_R, (
            f"{key} reached the pre-registered retirement threshold; §2.1 must be "
            f"re-read and edited by a human, not this threshold raised")
    # §1.6: the measurement is LESS like race pace than the surrogate was (0.80).
    assert corr["corr_one_lap_race"] < 0.90


def test_the_refit_buys_validity_not_precision(db_conn, fit_id):
    """DL-4 / §1.5 — the honesty check with teeth. Median evidence_share falls 0.813 ->
    0.653 and the median posterior SE as a share of the fitted span rises 8.9 % ->
    12.8 %. Any release note calling the new skill "more confident" is wrong, and this
    test is the number in front of whoever writes one."""
    import numpy as np

    got = {}
    for skill in ("grid_pace", "one_lap_pace"):
        rows = _rows(db_conn, "SELECT value, value_hi, evidence_share FROM "
                              "mode2_driver_skill WHERE fit_id = %s AND skill = %s",
                     (fit_id, skill))
        v = np.array([float(r[0]) for r in rows])
        se = np.array([(float(r[1]) - float(r[0])) / 1.6448536269514722 for r in rows])
        got[skill] = (float(np.median([float(r[2]) for r in rows])),
                      float(np.median(se) / (v.max() - v.min())))
    assert got["one_lap_pace"][0] < got["grid_pace"][0], got
    assert got["one_lap_pace"][1] > got["grid_pace"][1], got


def test_the_islands_are_thin_data_s_twin_and_not_its_synonym(db_conn, fit_id):
    """§1.4 — a thin-data SE and a floating-island SE can print the SAME number for
    entirely different reasons: sargeant at n_obs 10 and norris at n_obs 56 both sit at
    the shrinkage ceiling tau_delta. The panel renders two separate marks, so the two
    populations must be disjoint in the data as well as on the page."""
    rows = _rows(db_conn, "SELECT driver_id, n_obs, anchor_class, (value_hi - value) "
                          "FROM mode2_driver_skill WHERE fit_id = %s AND "
                          "skill = 'one_lap_pace'", (fit_id,))
    thin = {r[0] for r in rows if int(r[1]) < config.MODE2_QUALI_THIN_N}
    floating = {r[0] for r in rows if str(r[2]) == "floating"}
    assert floating == ISLAND_DRIVERS
    assert thin and not (thin & floating), (sorted(thin), sorted(floating))
    ceiling = {r[0]: round(float(r[3]) / 1.6448536269514722, 3) for r in rows}
    assert ceiling["norris"] == ceiling["sargeant"], ceiling


def test_sprint_qualifying_is_excluded_and_the_panel_reads_its_own_reason(db_conn, fit_id):
    """§1.8 / D3 / DL-7 — sprint qualifying is neither pooled in nor given its own
    skill, and the exclusion is a STORED ROW rather than a hard-coded TypeScript
    string. Pooling 345 SQ rows widens every driver's SE for a ranking that barely
    moves; SQ fitted alone is tau_car/tau_driver = 10.2, a car rating with a driver's
    name on it."""
    reasons = dict(_rows(db_conn, "SELECT coalesce(exclude_reason, '<included>'), "
                                  "count(*) FROM mode2_quali_row_audit WHERE fit_id = %s "
                                  "GROUP BY 1", (fit_id,)))
    assert reasons["<included>"] == 1135
    assert reasons["sprint_qualifying_excluded"] > 300
    assert "wet_compound" in reasons          # D1: dry rows only
    assert set(reasons) - {"<included>"} <= set(decomp.QUALI_EXCLUDE_REASONS)
    kinds = dict(_rows(db_conn, "SELECT kind, count(*) FROM mode2_quali_row_audit "
                                "WHERE fit_id = %s AND included GROUP BY 1", (fit_id,)))
    assert set(kinds) == {"Q"}, kinds


def test_the_quali_audit_accounts_for_every_segment_one_row(db_conn, fit_id):
    """§1.3 — excluded rows are written with a reason exactly as §1.3's are written to
    ``mode2_row_audit``, which itself stays pinned at 983 (D7). An unaudited drop is a
    silent change to a measured number."""
    n_audit = _rows(db_conn, "SELECT count(*) FROM mode2_quali_row_audit WHERE fit_id = %s",
                    (fit_id,))[0][0]
    n_src = _rows(db_conn,
                  "SELECT count(*) FROM quali_segment_times q "
                  "JOIN sessions s USING (session_id) "
                  "JOIN session_entries e ON e.session_id = q.session_id "
                  "                      AND e.driver_id = q.driver_id "
                  "WHERE q.segment = %s AND s.kind IN ('Q','SQ')",
                  (config.MODE2_QUALI_SEGMENT,))[0][0]
    assert int(n_audit) == int(n_src)
    bad = _rows(db_conn, "SELECT count(*) FROM mode2_quali_row_audit WHERE fit_id = %s "
                         "AND ((included AND (exclude_reason IS NOT NULL OR y_pp IS NULL)) "
                         "  OR (NOT included AND exclude_reason IS NULL))", (fit_id,))
    assert int(bad[0][0]) == 0
    # D7's 983 is PER FIT, and after v1.8 that distinction is load-bearing. The six
    # new §2.4 constants change the assumption hash, so the release necessarily creates
    # a second fit_id (§2.4: "the intended, audited path, not drift") and the table
    # holds 983 rows for each -- 1,966 in total, up to 3 x 983 under MODE2_KEEP_FITS.
    # A table-wide `== 983` would read the intended path as a drift failure.
    assert _rows(db_conn, "SELECT count(*) FROM mode2_row_audit WHERE fit_id = %s",
                 (fit_id,))[0][0] == 983
    per_fit = _rows(db_conn, "SELECT count(DISTINCT n) FROM (SELECT count(*) n FROM "
                             "mode2_row_audit GROUP BY fit_id) t")
    assert int(per_fit[0][0]) == 1, "mode2_row_audit row count differs between fits"

# ---------------------------------------------------------------------------

def test_grid_pace_is_never_called_one_lap_or_qualifying_pace():
    """§3.2 + GAPFILL_SPEC R2 / §2.4 — THE GUARD SURVIVES, NARROWED. DO NOT DELETE.

    The original form of this test grepped the WHOLE of decomp.py for "qualifying pace"
    and "one-lap pace" and failed unless the offending line contained the word "never".
    v1.8 ships a real measured qualifying skill, so that form breaks the moment
    ``fit_one_lap_pace`` exists -- and R2 names deleting this guard, to make the build
    green, as the worst possible outcome of shipping the fix. It is therefore narrowed
    to its actual blast radius rather than removed:

      * the source of ``fit_grid_pace`` itself, and
      * every ``grid_pace`` string literal decomp.py writes to the database,

    which is exactly the surface the honesty rule was ever about. ``grid_pace``'s
    stored numbers are normal scores of STARTING POSITION -- they count a five-place
    gearbox penalty as driver slowness (§2.1) -- so the surrogate may never wear the
    measurement's name, whether or not the measurement exists.
    """
    import inspect

    src = inspect.getsource(decomp.fit_grid_pace).lower()
    for banned in ("one-lap pace", "one lap pace", "qualifying pace"):
        for line in src.splitlines():
            if banned in line:
                assert "never" in line, f"{banned!r} used as a label: {line.strip()!r}"

    # The stored key and unit are the part TypeScript reads, so they are pinned here
    # too: a rename in the DDL would have to come past this assertion.
    grid_src = inspect.getsource(decomp.fit_grid_pace)
    assert '"skill": "grid_pace"' in grid_src
    assert '"unit": "normal_score"' in grid_src
    # The corrected docstring legitimately NAMES fit_one_lap_pace (§2.4 required the
    # old "there are no qualifying sessions" sentence to be replaced, not softened),
    # so the guard is on the STORED KEY, which is what TypeScript reads.
    assert '"skill": "one_lap_pace"' not in grid_src


def test_the_new_skill_is_labelled_qualifying_pace_and_never_one_lap_pace():
    """§2.4's MIRROR GUARD on the measurement, the twin of the guard above.

    The fit is on segment 1 ALONE -- Q1, the one segment every driver runs -- which is
    narrower than "one lap", so the rendered label is the session's name. The database
    key stays ``one_lap_pace`` because that is what the CHECK and §2.4 pin; the string
    a fan reads is ``Qualifying pace``. Nothing may render it as "One-lap pace", which
    would over-claim the response, or as "Starting-grid pace", which is the surrogate.
    """
    import inspect

    assert decomp.ONE_LAP_LABEL == "Qualifying pace"
    for bad in decomp.ONE_LAP_FORBIDDEN_LABELS:
        assert bad != decomp.ONE_LAP_LABEL
        assert bad.lower() not in decomp.ONE_LAP_LABEL.lower()

    src = inspect.getsource(decomp.one_lap_pace_report)
    assert '"skill": "one_lap_pace"' in src
    assert '"unit": "pp"' in src
    assert "grid_pace" not in src
    assert "Starting-grid pace" not in src


def test_grid_pace_is_not_on_the_same_scale_as_race_pace(db_conn, fit_id):
    """§3.2 — a rank is a compressed measure; the two are never plotted on a shared axis
    and the stored unit is what stops that happening in TypeScript."""
    units = dict(_rows(db_conn, "SELECT skill, min(unit) FROM mode2_driver_skill "
                                "WHERE fit_id = %s AND measured GROUP BY 1", (fit_id,)))
    assert units == {"race_pace": "pp", "one_lap_pace": "pp",
                     "grid_pace": "normal_score"}
    # §1.7 / D4: race pace and qualifying pace MAY share a pp axis; grid pace may not,
    # ever. grid_pace is the only measured skill whose unit is not pp, and that is the
    # structural fact the shared-axis rendering is allowed to key off.
    not_pp = {s for s, u in units.items() if u != "pp"}
    assert not_pp == {"grid_pace"}, not_pp


def test_grid_pace_reproduces_the_measured_fit(db_conn, asid, components):
    """§3.2 MEASURED: 1,265 rows / 62 sessions / 28 drivers, tau_driver 0.456,
    tau_car 0.496, sigma 0.639, verstappen -1.100 +/- 0.167."""
    skill = decomp.fit_grid_pace(db_conn, asid, components)
    assert len(skill) == len(components and {d for c in components.values()
                                             for d in c["drivers"]})
    best = skill.sort_values("value").iloc[0]
    assert best["driver_id"] == "max_verstappen"
    assert best["value"] == pytest.approx(-1.100, abs=0.05)
    se = (best["value_hi"] - best["value"]) / 1.6448536269514722
    assert se == pytest.approx(0.167, abs=0.02)


def test_grid_pace_islands_hold_the_widest_standard_errors(db_conn, fit_id):
    """§3.2 — the mobility graph is the same graph, so the same four drivers are the
    least identified here, however comfortable their evidence_share looks.

    Among WELL-OBSERVED drivers, as §2.4's own table requires: a seven-race rookie is
    also poorly identified, for the ordinary reason that he has barely raced, and §3.2's
    own measured list already has zhou (+/-0.242) outside the four islands (+/-0.235).
    The claim this test defends is that no amount of racing in the SAME car narrows an
    unidentified level, not that a rookie must be beaten."""
    rows = _rows(db_conn, "SELECT driver_id, (value_hi - value) FROM mode2_driver_skill "
                          "WHERE fit_id = %s AND skill = 'grid_pace' AND n_obs >= "
                          "(SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n_obs) "
                          " FROM mode2_driver_skill WHERE fit_id = %s "
                          " AND skill = 'grid_pace') "
                          "ORDER BY (value_hi - value) DESC LIMIT 4", (fit_id, fit_id))
    assert {r[0] for r in rows} == ISLAND_DRIVERS


def test_one_lap_pace_islands_hold_the_widest_standard_errors(db_conn, fit_id):
    """§1.4 — the same graph, so the same four drivers, on the measured skill too.

    This is the gate §2.4 asks for in words: the island and pct_field_below tests
    "pass unchanged, and gain an explicit one_lap_pace case". Here the four are not
    merely widest, they sit exactly at the shrinkage ceiling tau_delta = 0.1605,
    because a level nothing in the data identifies is the prior's SD by definition."""
    rows = _rows(db_conn, "SELECT driver_id, (value_hi - value) FROM mode2_driver_skill "
                          "WHERE fit_id = %s AND skill = 'one_lap_pace' AND n_obs >= "
                          "(SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n_obs) "
                          " FROM mode2_driver_skill WHERE fit_id = %s "
                          " AND skill = 'one_lap_pace') "
                          "ORDER BY (value_hi - value) DESC LIMIT 4", (fit_id, fit_id))
    assert {r[0] for r in rows} == ISLAND_DRIVERS
    # MEASURED 0.1134 for all four, which is §1.5's published 0.113 for norris,
    # piastri, alonso and stroll alike. Note this is the POSTERIOR SE ceiling, not
    # tau_delta: §1.4 calls 0.113 "the shrinkage ceiling tau_delta = 0.1605", which
    # runs the two numbers together. For a two-driver island the posterior SE tops out
    # at tau_delta / sqrt(2) = 0.1135, because the pair's CONTRAST is measured over 56
    # sessions and only their common level is the prior's.
    for _, half in rows:
        se = float(half) / 1.6448536269514722
        assert se == pytest.approx(0.113, abs=0.002), se
        assert se == pytest.approx(0.1605 / (2 ** 0.5), abs=0.002), se


def test_pct_field_below_is_a_percentage_within_one_skill(db_conn, fit_id):
    rows = _rows(db_conn, "SELECT pct_field_below FROM mode2_driver_skill "
                          "WHERE fit_id = %s AND measured AND anchor_class <> 'floating'",
                 (fit_id,))
    vals = [float(r[0]) for r in rows]
    assert vals and min(vals) == pytest.approx(0.0) and max(vals) == pytest.approx(100.0)


def test_pct_field_below_is_null_for_every_floating_driver(db_conn, fit_id):
    """§1.5 item 1 / §8.4 rule 2 — a floating driver has no place in the field.

    "Ahead of 96 % of the field" is an ordinal statement about a driver's LEVEL against
    all 28, and the 28 span four disconnected components. For norris, piastri, alonso
    and stroll that level is the pooling prior's, not the data's, so the percentile is a
    point estimate of a quantity §1.4 says the window contains no information about --
    and it used to be printed two lines under the "level not measured" chip that exists
    to refuse exactly that number. NULL is stored rather than filtered in TypeScript so
    the claim is not representable in the database either (§6.1).
    """
    rows = _rows(db_conn, "SELECT driver_id, skill, pct_field_below "
                          "FROM mode2_driver_skill WHERE fit_id = %s AND measured "
                          "AND anchor_class = 'floating'", (fit_id,))
    assert {r[0] for r in rows} == ISLAND_DRIVERS
    assert all(r[2] is None for r in rows), [r for r in rows if r[2] is not None]
    # §1.4's gate, made explicit for the new skill: qualifying added 1,135 rows and
    # zero edges, so the four floating drivers are floating HERE too and the level the
    # bar would print is still the pooling prior's rather than the data's.
    assert {r[1] for r in rows} == set(MEASURED_SKILLS)
    assert {r[0] for r in rows if r[1] == "one_lap_pace"} == ISLAND_DRIVERS


# ---------------------------------------------------------------------------
# §3.3 / §3.4 — the two refusals, refitted rather than remembered
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tyre(db_conn, asid):
    return decomp.tyre_rejection_report(db_conn, asid)


def test_tyre_rejection_still_holds(tyre):
    """THE EXPIRY DATE (§3.3). This refits the model on whatever is in the database now.
    When enough new data makes the skill fittable this FAILS, and the failure is the
    point: it forces a decision instead of letting a measured rejection harden into a
    permanent omission."""
    assert tyre["max_evidence_share"] < config.MODE2_TYRE_REJECT_THRESHOLD, (
        f"tyre management has become fittable (max evidence_share "
        f"{tyre['max_evidence_share']:.3f}); §3.3 must be re-run and the product "
        f"decision re-taken, not this threshold raised")


def test_tyre_driver_signal_is_smaller_than_its_own_noise(tyre):
    """§3.3's independent moment test: no mixed model, no prior. Between-driver spread
    of car- and session-adjusted stint slopes against the within-driver standard error
    of the mean, and the chi-square that goes with it."""
    assert tyre["p_value"] > 0.05
    assert tyre["between_driver_sd"] < 2.0 * tyre["within_driver_sem"]
    assert tyre["tau_driver"] < tyre["tau_car"]


def test_tyre_is_mostly_track_and_compound(tyre):
    """The session x compound term dwarfs both the car and the driver -- how fast a set
    of tyres dies is a property of the track and the compound (C-SKILL-3)."""
    assert tyre["tau_sess_compound"] > 5 * tyre["tau_car"]
    assert tyre["driver_share"] < 0.05


@pytest.fixture(scope="module")
def wet(db_conn, asid):
    return decomp.wet_rejection_report(db_conn, asid)


def test_wet_has_no_usable_rows(wet):
    """§3.4 — not thin: zero. Every session with real wet-tyre running is one v1.1
    refuses to fit, so no wet-weather pace estimate exists to rate."""
    assert wet["usable_wet_rows"] == 0
    assert wet["n_sessions_with_wet_running"] >= 1


def test_wet_copy_may_not_claim_drivers_have_no_wet_running(wet):
    """§3.4 — 26 of 28 drivers DO have wet laps. A caption saying otherwise is false,
    and this test exists so the number is in front of whoever writes it."""
    assert wet["n_drivers_with_wet_running"] >= 20
    assert wet["wet_representative_laps"] > 1000


def test_the_one_rainy_race_we_can_fit_ran_on_slicks(wet):
    """§3.4 — the only rain-flagged session with usable pace estimates has zero
    wet-compound laps, which is why counting rainy races was never the measurement."""
    assert wet["n_sessions_rain_with_usable_rows"] == len(wet["slick_rain_sessions"])


# ---------------------------------------------------------------------------
# §5.2 — the constructor surface
# ---------------------------------------------------------------------------

def test_red_bull_2024_declines(db_conn, fit_id):
    """§5.2's one external validation: the model, knowing nothing but fuel-corrected lap
    times, independently recovers the best-known development story of the period."""
    row = _rows(db_conn, "SELECT slope_pp, slope_lo, slope_significant FROM "
                         "mode2_car_rating WHERE fit_id = %s AND team_id = 'red_bull' "
                         "AND year = 2024", (fit_id,))
    assert row, "no red_bull 2024 car rating"
    slope, lo, sig = row[0]
    assert slope > 0 and lo > 0 and sig


def test_development_is_mostly_not_distinguishable_from_flat(db_conn, fit_id):
    """§5.2's mandatory multiplicity statement: 31 tests at alpha = 0.05 produce about
    1.6 by chance. A development chart where five-sixths of the segments are flat grey
    is the correct chart, so a majority of significant slopes is a defect."""
    n, sig = _rows(db_conn, "SELECT count(*), count(*) FILTER (WHERE slope_significant) "
                            "FROM mode2_car_rating WHERE fit_id = %s", (fit_id,))[0]
    assert sig < n / 3, f"{sig} of {n} slopes significant -- too many to be believable"


def test_slope_flag_agrees_with_the_stored_band(db_conn, fit_id):
    """The chart greys out what the flag says, and the flag must be the band: a segment
    whose interval straddles zero cannot be drawn as a finding."""
    bad = _rows(db_conn, "SELECT team_id, year FROM mode2_car_rating WHERE fit_id = %s "
                         "AND slope_significant <> (slope_lo > 0 OR slope_hi < 0)",
                (fit_id,))
    assert bad == []


def test_floating_component_cars_are_by_analogy(db_conn, fit_id):
    """THE ONE THING (§1.4). Adding a constant to both McLaren drivers and subtracting it
    from all three McLaren cars leaves every fitted value unchanged, so the McLaren car's
    level rests on the pooling prior and must never be rendered as a measured one."""
    rows = _rows(db_conn, "SELECT team_id, basis FROM mode2_car_rating WHERE fit_id = %s",
                 (fit_id,))
    for team, basis in rows:
        assert basis == ("by-analogy" if team in FLOATING_TEAMS else "measured"), team


def test_car_rating_rank_restarts_each_season(db_conn, fit_id):
    """§5.2 — gamma is field-relative WITHIN its own season, so a cross-season rank would
    compare two different zeroes."""
    rows = _rows(db_conn, "SELECT year, min(rank_in_season), count(*), "
                          "count(DISTINCT rank_in_season) FROM mode2_car_rating "
                          "WHERE fit_id = %s GROUP BY 1", (fit_id,))
    assert rows
    for _year, lo, n, distinct in rows:
        assert lo == 1 and distinct == n


def test_car_intervals_bracket_every_estimate(db_conn, fit_id):
    bad = _rows(db_conn, "SELECT team_id, year FROM mode2_car_rating WHERE fit_id = %s "
                         "AND (gamma_lo > gamma_pp OR gamma_pp > gamma_hi "
                         "OR slope_lo > slope_pp OR slope_pp > slope_hi)", (fit_id,))
    assert bad == []


def test_start_and_end_are_the_segment_not_a_curve(db_conn, fit_id):
    """§5.2 — two points and a band, never a fitted curve through per-round estimates."""
    rows = _rows(db_conn, "SELECT gamma_pp, slope_pp, start_pp, end_pp FROM "
                          "mode2_car_rating WHERE fit_id = %s", (fit_id,))
    for g, b, start, end in rows:
        assert start == pytest.approx(g - b / 2, abs=1e-9)
        assert end == pytest.approx(g + b / 2, abs=1e-9)


# ---------------------------------------------------------------------------
# §5.3 — retirements, and the word this section may never use
# ---------------------------------------------------------------------------

def test_status_vocabulary_is_race_only(db_conn, fit_id):
    """§5.3 — sprints are a separate 315/12/20/2/1 and must not be pooled with races.
    One proposal's table was sprint-contaminated and disagreed with its own numerator."""
    stored = {(t, int(y)): (int(k), int(n)) for t, y, k, n in _rows(
        db_conn, "SELECT team_id, year, retirements, racing_laps FROM mode2_car_hazard "
                 "WHERE fit_id = %s", (fit_id,))}
    race_only = {(t, int(y)): (int(k), int(n)) for t, y, k, n in _rows(
        db_conn, "SELECT e.team_id, s.year, count(*) FILTER (WHERE r.status = 'Retired'), "
                 "coalesce(sum(r.laps_completed), 0) FROM results r "
                 "JOIN sessions s ON s.session_id = r.session_id "
                 "JOIN session_entries e ON e.session_id = r.session_id "
                 "AND e.driver_id = r.driver_id WHERE s.kind = 'R' GROUP BY 1, 2")}
    assert stored == race_only
    pooled = _rows(db_conn, "SELECT count(*) FILTER (WHERE r.status = 'Retired') "
                            "FROM results r JOIN sessions s ON s.session_id = r.session_id")
    assert sum(v[0] for v in stored.values()) < int(pooled[0][0]), (
        "the numerator equals the sprint-pooled count -- sprint rows leaked in")


def test_did_not_start_is_not_a_retirement(db_conn, fit_id):
    """§5.3 — a DNS never ran the laps in the denominator, so it cannot be in the
    numerator either."""
    with_dns = _rows(db_conn, "SELECT count(*) FROM results r JOIN sessions s "
                              "ON s.session_id = r.session_id WHERE s.kind = 'R' "
                              "AND r.status IN ('Retired', 'Did not start')")[0][0]
    stored = _rows(db_conn, "SELECT sum(retirements) FROM mode2_car_hazard "
                            "WHERE fit_id = %s", (fit_id,))[0][0]
    assert int(stored) < int(with_dns)


def test_hazard_is_a_jeffreys_interval_on_a_per_lap_rate(db_conn, fit_id):
    """§5.3 — a per-lap hazard, so a car that breaks on lap 3 and one that breaks on lap
    50 are not scored alike, and short races do not distort it."""
    from scipy.stats import beta

    rows = _rows(db_conn, "SELECT retirements, racing_laps, hazard_per_1000, hazard_lo, "
                          "hazard_hi FROM mode2_car_hazard WHERE fit_id = %s", (fit_id,))
    assert rows
    for k, n, h, lo, hi in rows:
        assert h == pytest.approx(1000.0 * k / n, rel=1e-9)
        assert lo == pytest.approx(1000.0 * beta.ppf(0.05, k + 0.5, n - k + 0.5), rel=1e-6)
        assert hi == pytest.approx(1000.0 * beta.ppf(0.95, k + 0.5, n - k + 0.5), rel=1e-6)
        # A Jeffreys interval does not contain the point estimate when k = 0: the
        # posterior 5th sits just above zero, which is the honest statement that a car
        # that has not broken yet is not a car that cannot break. The band is always
        # ordered and always brackets the estimate from above.
        assert 0 < lo < hi and h <= hi


def test_hazard_carries_a_car_only_component(db_conn, fit_id):
    """§5.3 — results.status has no mechanical-vs-accident vocabulary anywhere in the
    schema, so the split is fitted, not captioned, and it ships with its own interval."""
    bad = _rows(db_conn, "SELECT team_id, year FROM mode2_car_hazard WHERE fit_id = %s "
                         "AND (hazard_car_lo > hazard_car_only "
                         "OR hazard_car_only > hazard_car_hi)", (fit_id,))
    assert bad == []


def test_retirements_are_never_called_reliability():
    """§5.3 — the data record that a car stopped, never why. The section is titled
    Retirements, and the word "reliability" does not belong to anything we measured."""
    from pathlib import Path

    src = Path(decomp.__file__).read_text(encoding="utf-8")
    for line in src.splitlines():
        if "eliabilit" in line:
            assert "never" in line.lower(), f"reliability used as a label: {line.strip()!r}"


def test_hazard_rank_is_within_season_only(db_conn, fit_id):
    """§5.3 — 2026 is a regulation reset and its hazard is roughly double 2024's, so a
    cross-season rank would be a rank of the era, not of the team."""
    rows = _rows(db_conn, "SELECT year, min(rank_in_season), count(*) FROM "
                          "mode2_car_hazard WHERE fit_id = %s GROUP BY 1", (fit_id,))
    assert rows
    for _year, lo, n in rows:
        assert lo == 1 and n > 1


def test_short_car_seasons_are_marked_insufficient(db_conn, fit_id):
    bad = _rows(db_conn, "SELECT team_id, year FROM mode2_car_hazard WHERE fit_id = %s "
                         "AND sufficient <> (racing_laps >= %s)",
                (fit_id, config.MODE2_MIN_HAZARD_LAPS))
    assert bad == []
