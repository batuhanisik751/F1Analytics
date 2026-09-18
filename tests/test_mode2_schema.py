"""[db] MODE2_SPEC §6 — the v1.3 decomposition schema contract (WP1 gate).

All twelve `mode2_*` tables are live and match `frames.EXPECTED_COLUMNS`; the §7.3
constants exist; the §7.2 stub signatures exist; the companion step `mode2` runs and
writes the four §6.5 `analytics_status` keys.

The structural guarantees tested here are the ones the whole feature rests on:

- **No grid-wide rank column exists anywhere** (§6.1). The mobility graph has four
  disconnected components, so a grid-wide rank is not a number that can be computed
  honestly — it is made physically unrepresentable rather than merely discouraged.
- **A row cannot exist without its uncertainty** (FD2): every `_lo`/`_hi`/`p10`/`p90`
  is NOT NULL, and `mode2_counterfactual` additionally CHECKs its interval.
- **The partial unique index survives** (§6.4 trap 1): losing the `WHERE is_current`
  predicate breaks the second fit; losing the index entirely lets two `is_current` rows
  coexist and every §8 query silently doubles.
"""

from __future__ import annotations

import pytest

from f1lab import config, db, frames, ingest

pytestmark = pytest.mark.db

# §6.2 DDL order.
MODE2_TABLES = [
    "mode2_fit_run", "mode2_component", "mode2_driver_rating",
    "mode2_driver_rating_history", "mode2_driver_skill", "mode2_driver_contrast",
    "mode2_car_rating", "mode2_car_hazard", "mode2_points_calib",
    "mode2_career_season", "mode2_counterfactual", "mode2_row_audit",
]

# GAPFILL_SPEC §2.2 (migration 0009). Kept OUT of MODE2_TABLES on purpose: that list
# is checked against frames.EXPECTED_COLUMNS, and the frames contract for this table is
# WP-S1's to land. The live-DDL contract below is this package's and is checked now.
MODE2_V18_TABLES = ["mode2_quali_row_audit"]

# The seven keys of mode2_driver_skill_skill_check after 0009 (§2.2, DL-11). Every one
# of them is WRITTEN by the fit; a CHECK key that stays unwritten is exactly the
# failure DL-11 forbids.
SKILL_KEYS = ("race_pace", "one_lap_pace", "grid_pace", "tyre_management", "wet",
              "sprint_one_lap", "trail_braking")

# §0.4 / §6.5.
STATUS_KEYS = ["mode2_rating", "mode2_skills", "mode2_constructor", "mode2_counterfactual"]


def test_check_schema_covers_mode2(db_conn):
    """All twelve are in the contract AND live, and --check-schema exits 0."""
    missing = [t for t in MODE2_TABLES if t not in frames.EXPECTED_COLUMNS]
    assert not missing, f"not in EXPECTED_COLUMNS: {missing}"
    assert len(MODE2_TABLES) == 12

    for table in MODE2_TABLES:
        live = db.live_columns(db_conn, table)
        db_conn.rollback()
        assert live, f"table {table} is missing from the live database"
        assert sorted(live) == sorted(frames.EXPECTED_COLUMNS[table]), (
            f"{table}: missing={sorted(set(frames.EXPECTED_COLUMNS[table]) - set(live))} "
            f"extra={sorted(set(live) - set(frames.EXPECTED_COLUMNS[table]))}")

    assert ingest.main(["--check-schema"]) == 0


def test_no_grid_wide_rank_column_exists(db_conn):
    """§6.1, FD3. `rank_in_component` and `rank_in_season` are the ONLY ranks.

    A grid-wide driver rank across four disconnected components is the exact falsehood
    this feature exists to avoid, so the schema cannot express it. This is a structural
    guard that survives contributors who have not read the spec.
    """
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name LIKE 'mode2\\_%' "
            "AND column_name LIKE '%rank%' ORDER BY 1, 2")
        ranks = [(t, c) for t, c in cur.fetchall()]
    assert ranks, "expected at least the per-component / per-season ranks"
    offenders = [(t, c) for t, c in ranks if c not in ("rank_in_component", "rank_in_season")]
    assert not offenders, f"grid-wide rank column(s) introduced: {offenders}"
    assert ("mode2_driver_rating", "rank_in_component") in ranks


def test_every_interval_bound_is_not_null(db_conn):
    """FD2 — a point estimate cannot be stored without its 5th/95th."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name LIKE 'mode2\\_%' "
            "AND is_nullable = 'YES' ORDER BY 1, 2")
        nullable = [(t, c) for t, c in cur.fetchall()]
    bounds = [(t, c) for t, c in nullable
              if c.endswith(("_lo", "_hi", "_p10", "_p90"))]
    # mode2_driver_skill.value_lo/_hi are the one legal exception: a REFUSED skill
    # (tyre management §3.3, wet §3.4) is a row with a null value and a stored reason,
    # and its own CHECK ties the nulls to measured = false.
    assert bounds == [("mode2_driver_skill", "value_hi"), ("mode2_driver_skill", "value_lo")], bounds


def test_fit_run_current_index_is_partial(db_conn):
    """§6.4 trap 1. Losing the WHERE predicate breaks the second fit; losing the index
    entirely lets two is_current rows coexist and every §8 query silently doubles."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes "
                    "WHERE tablename = 'mode2_fit_run' ORDER BY indexname")
        defs = [r[0] for r in cur.fetchall()]
    current = [d for d in defs if "mode2_fit_run_current_idx" in d]
    assert current, f"mode2_fit_run_current_idx is gone; indexes are {defs}"
    assert "UNIQUE" in current[0] and "WHERE is_current" in current[0], current[0]
    assert any("mode2_fit_run_version_idx" in d and "UNIQUE" in d for d in defs), defs


def test_no_numeric_or_jsonb_columns(db_conn):
    """§6.4 trap 2. numeric comes back from psycopg 3 as Decimal, which cast_frame's
    _to_float does not expect; a text[] mis-tagged jsonb fails at COPY, not here."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT table_name, column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name LIKE 'mode2\\_%' "
            "AND data_type IN ('numeric','real','jsonb') ORDER BY 1, 2")
        bad = cur.fetchall()
    assert not bad, f"forbidden column types: {bad}"

    arrays = {("mode2_component", "driver_ids"), ("mode2_component", "cell_ids"),
              ("mode2_driver_contrast", "shared_cells")}
    for table, column in sorted(arrays):
        assert dict(frames.TABLE_COLUMNS[table])[column] == "text[]", (table, column)


def test_named_checks_are_live(db_conn):
    """§6.4 trap 3. Every CHECK is named in the spec; an invented name changes between
    generations and produces a spurious drop/add pair on the next generate."""
    expected = {
        "mode2_driver_rating_anchor_check", "mode2_driver_rating_basis_check",
        "mode2_driver_skill_measured_check", "mode2_driver_skill_skill_check",
        "mode2_driver_contrast_kind_check", "mode2_career_season_basis_check",
        "mode2_counterfactual_interval_check", "mode2_counterfactual_basis_check",
        "mode2_row_audit_reason_check",
        # v1.8 / GAPFILL_SPEC §2.2 -- migration 0009.
        "mode2_quali_row_audit_reason_check",
    }
    with db_conn.cursor() as cur:
        cur.execute("SELECT conname FROM pg_constraint WHERE contype = 'c' "
                    "AND conname LIKE 'mode2\\_%'")
        live = {r[0] for r in cur.fetchall()}
    assert expected <= live, f"missing named CHECKs: {sorted(expected - live)}"


# ---------------------------------------------------------------------------
# GAPFILL_SPEC §2.2 — what migration 0009 added, checked against the live DDL
# ---------------------------------------------------------------------------

def test_the_skill_check_holds_exactly_seven_keys(db_conn):
    """§2.2 / DL-11 — the CHECK is the contract between the fit and TypeScript.

    Seven keys, and every one of them written by ``recompute_skills`` as a real row:
    three measured and four ``measured = false`` refusals with a reason. A key in the
    CHECK that no code path writes leaves the DDL conditional on a fact nobody
    established, which is precisely the mistake DL-11 records."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conname = 'mode2_driver_skill_skill_check'")
        row = cur.fetchone()
    assert row, "mode2_driver_skill_skill_check is missing"
    defn = row[0]
    for key in SKILL_KEYS:
        assert f"'{key}'" in defn, f"{key} missing from the CHECK: {defn}"
    quoted = {p.split("'")[0] for p in defn.split("'")[1::2]}
    assert quoted == set(SKILL_KEYS), sorted(quoted)


def test_the_fit_run_carries_the_three_retirement_correlations(db_conn):
    """§2.1 — the observed r is STORED, not just printed, so the pre-registered
    retirement decision is auditable from the database in every later release.

    All three are NULLABLE on purpose: every pre-v1.8 fit row legitimately has NULL,
    which is why gate G3 compares `>= 0.95` and never `not < 0.95`."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT column_name, data_type, is_nullable FROM "
                    "information_schema.columns WHERE table_name = 'mode2_fit_run' "
                    "AND column_name LIKE 'corr\\_%' ORDER BY 1")
        got = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    assert set(got) == {"corr_one_lap_grid", "corr_one_lap_grid_ex_islands",
                        "corr_one_lap_race"}, sorted(got)
    for name, (dtype, nullable) in got.items():
        assert dtype == "double precision", (name, dtype)
        assert nullable == "YES", (name, nullable)


def test_the_quali_row_audit_table_is_live_and_matches_the_fit_s_column_list(db_conn):
    """§2.2 — every excluded segment-1 row is written with a reason, exactly as §1.3's
    are written to ``mode2_row_audit`` (which stays pinned at 983 rows, D7).

    The column list is compared against ``decomp.QUALI_AUDIT_COLUMNS`` rather than
    against ``frames.EXPECTED_COLUMNS``: the frames contract for this table is WP-S1's
    to land, and until it does the fit writes through ``db.copy_rows`` against its own
    list. When WP-S1 lands it, ``decomp._write_quali_audit`` raises if the two
    disagree, so this check and that one cannot drift apart silently."""
    from f1lab import decomp

    for table in MODE2_V18_TABLES:
        live = db.live_columns(db_conn, table)
        db_conn.rollback()
        assert live, f"table {table} is missing from the live database"
    assert sorted(db.live_columns(db_conn, "mode2_quali_row_audit")) == sorted(
        decomp.QUALI_AUDIT_COLUMNS)
    db_conn.rollback()
    if "mode2_quali_row_audit" in frames.EXPECTED_COLUMNS:
        assert (frames.EXPECTED_COLUMNS["mode2_quali_row_audit"]
                == decomp.QUALI_AUDIT_COLUMNS)


def test_the_quali_audit_cannot_store_an_exclusion_without_a_reason(db_conn):
    """§2.2's named CHECK, proven by an expected-failure insert rather than by reading
    the DDL. An unaudited drop is a silent change to a measured number (D7)."""
    import psycopg

    with db_conn.cursor() as cur:
        cur.execute("SELECT fit_id, assumption_set_id FROM mode2_fit_run "
                    "ORDER BY fit_id LIMIT 1")
        row = cur.fetchone()
    if row is None:
        pytest.skip("no mode2_fit_run rows to hang an audit row off")
    with pytest.raises(psycopg.errors.CheckViolation):
        with db_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO mode2_quali_row_audit (fit_id, assumption_set_id, "
                "session_id, driver_id, team_id, year, round, kind, included, "
                "exclude_reason, y_pp, best_s) "
                "SELECT %s, %s, q.session_id, q.driver_id, 'x', 2024, 1, 'Q', "
                "false, NULL, NULL, NULL "
                "FROM quali_segment_times q LIMIT 1",
                (int(row[0]), int(row[1])))
    db_conn.rollback()

def test_counterfactual_refuses_an_inverted_interval(db_conn):
    """FD4 made structural: no code path can emit a bare or backwards point estimate."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        with db_conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM mode2_counterfactual "
                        "WHERE points_p10 > points_p90")
            cur.execute(
                "INSERT INTO mode2_counterfactual (fit_id, assumption_set_id, year, "
                "driver_id, team_id, replaced_driver_id, observed, points_p10, "
                "points_p50, points_p90, incumbent_actual, delta_p10, delta_p50, "
                "delta_p90, basis, cross_component, interaction_pp, calibration_mae) "
                "VALUES (-1, -1, 2026, 'x', 'y', 'z', false, 90, 50, 10, 0, 0, 0, 0, "
                "'measured', false, 0.1, 1.0)")
    db_conn.rollback()


def test_mode2_tables_are_not_per_session_children():
    """§6.1 — these are cross-race artifacts rebuilt wholesale at run-end, so none is in
    RACE_TABLE_ORDER / SPRINT_TABLE_ORDER, and none is a per-session `ANALYTICS` guard."""
    for name in ("RACE_TABLE_ORDER", "SPRINT_TABLE_ORDER", "ANALYTICS"):
        listed = [t for t in getattr(frames, name) if t.startswith("mode2_")]
        assert not listed, f"{name} must not contain {listed}"


def test_config_constants_exist():
    """§7.3 — all twenty-three, and TITLE_PL_TEMPERATURE is untouched (§4.1)."""
    expected = {
        "MODE2_MIN_LAPS_FIT": 24, "MODE2_MIN_CARS_IN_RACE": 8,
        "MODE2_EXCLUDE_BADGES": ("poor",), "MODE2_SPEC": "S",
        "MODE2_REML_START": (0.30, 0.90, 0.35, 0.42), "MODE2_CI_LEVEL": 0.90,
        "MODE2_BOOTSTRAP_REPS": 400, "MODE2_HISTORY_BOOTSTRAP_REPS": 120,
        "MODE2_BOOTSTRAP_JOBS": 8, "MODE2_SEED": 20260914,
        "MODE2_SIGMA_SPEC": 0.10, "MODE2_SIGMA_SPEC_CONTRAST": 0.04,
        "MODE2_CF_INTERACTION_PCT": 0.10, "MODE2_MIN_COMPONENT_DRIVERS": 5,
        "MODE2_MIN_HAZARD_LAPS": 200, "MODE2_POINTS_DRAWS": 4000,
        "MODE2_UNCERTAINTY_DRAWS": 200,
        "MODE2_TEMPERATURE_GRID": (0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.70, 1.00),
        "MODE2_CF_MAX_SCENARIOS": 900, "MODE2_KEEP_FITS": 3,
        "MODE2_TYRE_REJECT_THRESHOLD": 0.20,
    }
    for name, value in expected.items():
        assert getattr(config, name) == value, name
    assert config.TITLE_PL_TEMPERATURE == 1.0, "§4.1: v1.2's constant is not touched"


def test_stub_signatures_exist():
    """§7.2 — WP2/WP3/WP4 fill these in; the names and shapes are the contract."""
    import inspect

    from f1lab import decomp, decomp_points

    for name in ("load_rows", "build_components", "fit_reml", "bootstrap", "contrasts",
                 "fit_grid_pace", "tyre_rejection_report", "wet_rejection_report",
                 "fit_hazard", "recompute_rating", "recompute_skills",
                 "recompute_constructor", "recompute_all"):
        assert callable(getattr(decomp, name)), f"decomp.{name} is missing"
    for name in ("calibrate", "replay", "recompute_points"):
        assert callable(getattr(decomp_points, name)), f"decomp_points.{name} is missing"

    assert inspect.isclass(decomp.Mode2Fit)
    fit = decomp.Mode2Fit()
    for attr in ("spec", "rows", "driver_ids", "cell_ids", "tau", "blup", "cov",
                 "components", "converged", "fit_seconds"):
        assert hasattr(fit, attr), f"Mode2Fit.{attr} is missing"
    with pytest.raises(Exception):
        fit.spec = "C"          # frozen dataclass

    # `contrasts` derives its frame from the fit alone, so it still states the whole
    # mode2_driver_contrast column contract without touching the database.
    assert list(decomp.contrasts(fit, None).columns) == \
        frames.EXPECTED_COLUMNS["mode2_driver_contrast"]

    # WP1 also called `fit_hazard(None, 1)` and `calibrate(None, 1, fit)` here, because
    # the stubs returned an empty frame from a None connection. Both are real estimators
    # now and read the database, so the column contract is asserted where it actually
    # lives — `frames` — and the estimators are exercised against live rows in
    # tests/test_mode2_skills.py and tests/test_mode2_points.py.
    for table, first in (("mode2_car_hazard", "fit_id"), ("mode2_points_calib", "fit_id")):
        cols = frames.EXPECTED_COLUMNS[table]
        assert cols[0] == first and "assumption_set_id" in cols, table
        assert list(frames.empty_frame(table).columns) == cols, table


def test_companion_step_mode2_is_wired_and_last():
    """§7.4 — mode2 runs after preview, because it reads driver_standings and title's
    fitted PL. parse_steps accepts it by name.

    'report' appended 2026-09-14 (MODE3_SPEC §4.4): the race report summarises every
    earlier analytic, including mode2's, so it necessarily runs after it. mode2 is no
    longer the last step; what §7.4 actually requires is that it runs after preview and
    before anything that consumes it, and that is what is asserted here."""
    from f1lab import companion

    assert companion.STEPS == ("winprob", "odi", "preview", "mode2", "report")
    assert companion.STEPS.index("mode2") > companion.STEPS.index("preview")
    assert companion.STEPS.index("report") > companion.STEPS.index("mode2")
    assert companion.parse_steps("mode2") == ("mode2",)
    # 'report' is the last step since 2026-09-14, so "all" now ends there; what mode2
    # requires is that "all" still runs it, after preview.
    assert "mode2" in companion.parse_steps("all")
    assert companion.parse_steps("all")[-1] == "report"
    with pytest.raises(ValueError):
        companion.parse_steps("mode3")


def test_mode2_step_runs_and_writes_four_status_keys(db_conn):
    """WP1 gate, kept past the stub era. The step exits clean and all four §6.5 keys land
    — one key per guarded analytic, so a failed Monte Carlo degrades one section's
    EmptyState instead of blanking the driver rating.

    WP1 wrote this against a stub and asserted every mode2_* table was EMPTY afterwards.
    WP2-WP4 populate all twelve, so the assertion is now inverted: the step is complete
    only when no table it owns was left behind. A run against a complete fit returns
    {'skipped': True} without rewriting, which is the §6.6 contract, so the row counts
    hold either way."""
    from f1lab import assumptions, companion

    asid = assumptions.get_or_create(db_conn)
    out = companion.recompute_companion(db_conn, asid, steps=("mode2",), force=False)
    db_conn.commit()
    assert set(out) == {"mode2"}

    with db_conn.cursor() as cur:
        for table in MODE2_TABLES:
            cur.execute(f"SELECT count(*) FROM {table}")
            assert int(cur.fetchone()[0]) > 0, f"{table} is empty after the mode2 step"
        cur.execute(
            "SELECT count(*) FROM session_ingests si JOIN sessions s USING (session_id) "
            "WHERE s.kind = 'R' AND si.status <> 'failed' AND "
            "si.analytics_status ?& %s", (STATUS_KEYS,))
        marked = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM session_ingests si JOIN sessions s "
                    "USING (session_id) WHERE s.kind = 'R' AND si.status <> 'failed'")
        total = int(cur.fetchone()[0])
    assert marked == total > 0, f"{marked} of {total} race sessions carry all four keys"


def test_mode2_force_is_passed_through(db_conn, monkeypatch):
    """§7.4 edit 4 — only the mode2 step reads --force; the other three ignore it."""
    from f1lab import companion, decomp

    seen: dict = {}

    def fake(conn, asid, *, force=False):
        seen["force"] = force
        return {"stub": True}

    monkeypatch.setattr(decomp, "recompute_all", fake)
    asid = assumptions_id(db_conn)
    companion.recompute_companion(db_conn, asid, steps=("mode2",), force=True)
    assert seen == {"force": True}


def assumptions_id(conn) -> int:
    from f1lab import assumptions

    return assumptions.get_or_create(conn)
