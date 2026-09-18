"""QUALI_SPEC §10 — the v1.6 integration pins.

Three things this release could break silently, and one it did break and this package
fixed:

1. **Race analytics must not move.** `pace_ranking`, `degradation_fits`, `teammate_deltas`
   and every `mode2_*` table were computed before qualifying existed and must be
   byte-identical after it does (D7, §0.2). Their row counts and content digests are
   pinned here against the values measured after the WP4 backfill.
2. **D4's pin.** `laps.deleted` is FALSE on every race and sprint lap, and no race lap
   carries any of the five new qualifying columns. §5.6 scopes the `messages=True` flip
   for races to v1.7 deliberately; this test is what stops it happening by accident.
3. **R2's rule.** Every query against `laps` either constrains `sessions.kind` or is
   scoped to a single `session_id`. §3.1's audit table seeds the list; this test walks
   the tree so the *next* query written is caught.
4. **Waived driver-segments are flagged, not silently stored.** Fixed in this package:
   `quali_segment_times.verified` is false for the three 2024 R21 São Paulo rows whose
   official Qk duplicates another segment's, and the one teammate pair that would have
   compared against a duplicated official time is `comparable = false`.

v1.8 adds a fifth (§6, WP-A4 / `GAPFILL_SPEC §6.3` row A4 / D7 / DL-26):

5. **Nothing stored changed when Gap A shipped.** The v1.8 recompute lands as a second
   `fit_id`, so every `mode2_*` count here is now PER FIT, and the 112 pre-existing
   `mode2_driver_skill` rows are compared value-by-value ACROSS the two fits with zero
   rows permitted to differ. The gate itself lives in
   `scripts/verify/no_drift_mode2.py`; this file imports it, runs it, and — because a
   gate nobody has seen fail is not a gate — proves it bites on a 1e-12 nudge inside a
   rolled-back transaction.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _one(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        row = cur.fetchone()
    return row[0] if row and len(row) == 1 else row


def _rows(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


# ---------------------------------------------------------------------------------------
# 1 / 2. The race side did not move.
# ---------------------------------------------------------------------------------------

# Measured after WP4's backfill and re-measured after this package's re-ingest of
# 2024 R21. A change here is either a real regression or a deliberate recompute that must
# be re-baselined with its reason written into QUALI_SPEC §10.
RACE_TABLE_ROWS = {
    "pace_ranking": 1197,
    "degradation_fits": 2797,
    "teammate_deltas": 567,
    "fuel_sensitivity": 3591,
    "results": 1616,
}

# Every `mode2_*` count below is PER `fit_id`, not table-wide, and that changed in v1.8.
# The six new `§2.4` constants enter the assumption hash, so the v1.8 recompute lands as a
# second `fit_id` under a new `assumption_set_id` (`GAPFILL_SPEC §2.4`'s intended audited
# path) and up to `MODE2_KEEP_FITS = 3` fits coexist. These were table-wide literals
# through v1.6/v1.7, when exactly one fit existed; a table-wide `== 983` now reads the
# intended path as drift. Only `mode2_driver_skill` differs between the two fits
# (112 -> 196, §2.1); everything else is identical per fit and is diffed as such below.
MODE2_TABLE_ROWS_PER_FIT = {
    "mode2_car_hazard": 31, "mode2_car_rating": 31, "mode2_career_season": 68,
    "mode2_component": 4, "mode2_counterfactual": 868, "mode2_driver_contrast": 378,
    "mode2_driver_rating": 28, "mode2_driver_rating_history": 79,
    "mode2_points_calib": 3, "mode2_row_audit": 983,
}

# §2.1: `mode2_driver_skill` goes 112 -> 196. Four keys x 28 drivers before, seven after.
SKILL_ROWS_BEFORE_V18 = 112
SKILL_ROWS_V18 = 196
PRE_EXISTING_SKILLS = ("grid_pace", "race_pace", "tyre_management", "wet")
NEW_SKILLS_V18 = ("one_lap_pace", "sprint_one_lap", "trail_braking")


def _fit_pair(conn):
    """(baseline_fit, v18_fit) — the two most recent fits, oldest first."""
    fits = [r[0] for r in _rows(conn, "SELECT fit_id FROM mode2_fit_run "
                                      "ORDER BY fitted_at, fit_id")]
    if len(fits) < 2:
        pytest.skip(f"mode2_fit_run carries {len(fits)} fit(s); the v1.8 cross-fit "
                    "comparison needs two. Run the §6.2 Mode 2 recompute first.")
    return fits[-2], fits[-1]


@pytest.mark.db
@pytest.mark.parametrize("table,n", sorted(RACE_TABLE_ROWS.items()))
def test_race_analytics_row_counts_are_unchanged_by_v16(db_conn, table, n):
    assert _one(db_conn, f"SELECT count(*) FROM {table}") == n


@pytest.mark.db
@pytest.mark.parametrize("table,n", sorted(MODE2_TABLE_ROWS_PER_FIT.items()))
def test_mode2_row_counts_are_unchanged_per_fit(db_conn, table, n):
    """D7, per fit. A second `fit_id` is the intended v1.8 path; a second *shape* is not."""
    per_fit = dict(_rows(db_conn, f"SELECT fit_id, count(*) FROM {table} GROUP BY 1"))
    assert per_fit, f"{table} is empty"
    assert set(per_fit.values()) == {n}, f"{table} per fit_id: {per_fit}, expected {n} each"


@pytest.mark.db
def test_race_and_sprint_laps_are_untouched(db_conn):
    """69,548 rows, the same digest, and not one of them carrying a qualifying column."""
    n, digest = _rows(db_conn, """
        SELECT count(*), md5(string_agg(x, '|' ORDER BY x)) FROM (
          SELECT l::text AS x FROM laps l JOIN sessions s USING (session_id)
           WHERE s.kind IN ('R', 'S')) q""")[0]
    assert n == 69548
    assert digest == "1b2c3f26a24bbb7cab6f554070f3d7ed"


@pytest.mark.db
def test_d4_race_deleted_is_still_false_everywhere(db_conn):
    """§0.4 note 9 / §5.6: the race-side `deleted` gap stays visible, not quietly closed."""
    assert _one(db_conn, "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
                         "WHERE s.kind IN ('R','S') AND l.deleted") == 0
    assert _one(db_conn, "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
                         "WHERE s.kind IN ('R','S') AND l.deleted_reason IS NOT NULL") == 0
    assert _one(db_conn, """
        SELECT count(*) FROM laps l JOIN sessions s USING (session_id)
         WHERE s.kind IN ('R','S') AND (l.quali_segment IS NOT NULL
            OR l.segment_source IS NOT NULL OR l.is_push_lap IS NOT NULL
            OR l.excl_disallowed IS NOT NULL OR l.deleted_inferred IS NOT NULL)""") == 0


# ---------------------------------------------------------------------------------------
# 3. R2 — `laps` is no longer race-only, and the next query written will not know.
# ---------------------------------------------------------------------------------------

_LAPS_READ = re.compile(r"(FROM|JOIN)\s+laps\b|\.from\(laps\)", re.I)
_KIND_SCOPED = re.compile(r"kind\s*(=|IN)|\.kind\b|eq\(sessions\.kind", re.I)
_SESSION_SCOPED = re.compile(r"session_id\s*(=|IN)\s*(%s|\$\d|ANY|\(|:)|"
                             r"sessionId\s*,\s*session|eq\(\w*\.sessionId", re.I)

# Every file that reads `laps`, with the reason it is safe (§3.1's audit, extended by this
# package with the ninth consumer the table missed: winprob.py:634).
_AUDITED = {
    "f1lab/preview.py", "f1lab/winprob.py", "f1lab/decomp.py",
    "web/lib/queries/race.ts", "web/lib/queries/sim.ts",
}


def _sources():
    for base in ("f1lab", "scripts", "web/lib/queries", "web/db"):
        for p in (ROOT / base).rglob("*"):
            if p.suffix in (".py", ".ts") and "node_modules" not in p.parts:
                yield p


def test_every_laps_reader_is_kind_scoped_or_session_scoped():
    """§8 R2's grep-shaped regression test. It fails loudly on the tenth consumer."""
    offenders = []
    for p in _sources():
        text = p.read_text(encoding="utf-8", errors="ignore")
        for i, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith(("#", "//", "*")) or not _LAPS_READ.search(line):
                continue
            # A statement can span lines; look at a window either side of the hit.
            window = "\n".join(text.splitlines()[max(0, i - 12): i + 12])
            if _KIND_SCOPED.search(window) or _SESSION_SCOPED.search(window):
                continue
            offenders.append(f"{p.relative_to(ROOT)}:{i}: {line.strip()}")
    # The one known unscoped read is the ask-box generator's planner-cost probe, which
    # counts rows to size a cost ceiling and reads no column (§5.3.1).
    offenders = [o for o in offenders if not o.startswith("scripts/gen_ask_schema.py")]
    assert offenders == [], "unscoped `laps` readers:\n" + "\n".join(offenders)


def test_the_audited_consumers_still_exist_and_still_filter():
    """A file dropping off §3.1's audit list is a silent change to the argument for D1."""
    for rel in sorted(_AUDITED):
        text = (ROOT / rel).read_text(encoding="utf-8")
        assert _LAPS_READ.search(text), f"{rel} no longer reads laps; update QUALI_SPEC §3.1"


# ---------------------------------------------------------------------------------------
# 4. Waived driver-segments carry a flag (the defect this package fixed).
# ---------------------------------------------------------------------------------------

@pytest.mark.db
def test_waived_segments_are_flagged_unverified_and_are_the_only_ones(db_conn):
    """Exactly three rows corpus-wide, all at 2024 R21 São Paulo, all in segment 2.

    Before the fix these three rows were written as if verified, and each disagreed with
    the official time in `quali_results` -- ALO by 3.963 s -- with nothing marking it.
    """
    rows = _rows(db_conn, """
        SELECT s.year, s.round, s.kind, t.driver_id, t.segment,
               round(t.best_s::numeric, 3), round(q.q2_s::numeric, 3)
          FROM quali_segment_times t
          JOIN sessions s USING (session_id)
          LEFT JOIN quali_results q
                 ON q.session_id = t.session_id AND q.driver_id = t.driver_id
         WHERE NOT t.verified ORDER BY t.driver_id""")
    assert [(r[0], r[1], r[2], r[3], r[4]) for r in rows] == [
        (2024, 21, "Q", "albon", 2), (2024, 21, "Q", "alonso", 2), (2024, 21, "Q", "piastri", 2)]
    # The disagreement each flag exists to declare, still there and still declared.
    assert [(float(r[5]), float(r[6])) for r in rows] == [
        (85.889, 84.657), (85.035, 88.998), (85.179, 84.686)]


@pytest.mark.db
def test_a_pair_comparing_against_a_waived_official_time_is_not_comparable(db_conn):
    """2024 R21: ALO's official Q2 is a copy of his Q3, so STR-vs-ALO had been a Q3 time
    wearing a Q2 label. The session still counts its win; only the delta is withheld."""
    rows = _rows(db_conn, """
        SELECT h.driver_a, h.driver_b, h.segment, h.comparable, h.delta_s
          FROM quali_teammate_h2h h JOIN sessions s USING (session_id)
         WHERE s.year = 2024 AND s.round = 21 AND s.kind = 'Q' AND NOT h.comparable""")
    assert rows == [("alonso", "stroll", None, False, None)]
    assert _one(db_conn, """
        SELECT count(*) FROM quali_teammate_h2h h JOIN sessions s USING (session_id)
         WHERE s.year = 2024 AND s.round = 21 AND s.kind = 'Q'""") == 10


@pytest.mark.db
def test_the_warning_that_named_the_waived_segments_is_still_written(db_conn):
    """`season.py`'s `sessions_caveated` and §6.3's captions key on these strings."""
    w = _rows(db_conn, """
        SELECT w FROM session_ingests si JOIN sessions s USING (session_id), unnest(si.warnings) w
         WHERE s.year = 2024 AND s.round = 21 AND s.kind = 'Q' AND w LIKE 'quali\\_%%'""")
    flat = [x[0] for x in w]
    assert "quali_waived_segments=ALB:2,ALO:2,PIA:2" in flat
    assert "quali_segment_repairs=3" in flat


# ---------------------------------------------------------------------------------------
# 5. The backfill's shape (§10's as-built numbers, pinned so a drift is visible).
# ---------------------------------------------------------------------------------------

@pytest.mark.db
def test_sessions_by_kind(db_conn):
    assert dict(_rows(db_conn, "SELECT kind, count(*) FROM sessions GROUP BY 1")) == {
        "R": 71, "S": 18, "Q": 71, "SQ": 18}


@pytest.mark.db
def test_quali_ingest_outcomes_and_their_reasons(db_conn):
    """77 ok, 1 partial, 1 failed. Both exceptions are named, measured and deliberate."""
    got = dict(_rows(db_conn, """
        SELECT si.status, count(*) FROM session_ingests si JOIN sessions s USING (session_id)
         WHERE s.kind IN ('Q','SQ') GROUP BY 1"""))
    assert got == {"ok": 77, "partial": 1, "failed": 1}
    # The partial is D8's runtime anchor gate firing for real, with both per-segment
    # tables suppressed and the official times still published.
    partial = _rows(db_conn, """
        SELECT s.year, s.round, s.kind,
               (SELECT count(*) FROM quali_results q WHERE q.session_id = s.session_id),
               (SELECT count(*) FROM quali_segment_times t WHERE t.session_id = s.session_id),
               (SELECT count(*) FROM quali_teammate_h2h h WHERE h.session_id = s.session_id)
          FROM session_ingests si JOIN sessions s USING (session_id)
         WHERE s.kind IN ('Q','SQ') AND si.status = 'partial'""")
    assert partial == [(2025, 7, "Q", 20, 0, 0)]
    failed = _rows(db_conn, """
        SELECT s.year, s.round, s.kind FROM session_ingests si JOIN sessions s USING (session_id)
         WHERE s.kind IN ('Q','SQ') AND si.status = 'failed'""")
    assert failed == [(2025, 6, "Q")]


@pytest.mark.db
def test_anchor_repairs_are_three_and_all_of_them_are_sao_paulo(db_conn):
    assert _rows(db_conn, """
        SELECT s.year, s.round, s.kind, w FROM session_ingests si
          JOIN sessions s USING (session_id), unnest(si.warnings) w
         WHERE w LIKE 'quali\\_segment\\_repairs=%%' AND w <> 'quali_segment_repairs=0'
      """) == [(2024, 21, "Q", "quali_segment_repairs=3")]


@pytest.mark.db
def test_stage_three_anchor_repair_is_exercised_by_zero_laps(db_conn):
    """§2.2's literal stage-3 lap reassignment has NO measured coverage anywhere in 79
    sessions (§10). Every São Paulo repair is a duplicate-official waiver, which moves no
    lap. Pinned so the day a session does exercise it, this test is what says so."""
    assert _one(db_conn, "SELECT count(*) FROM laps WHERE segment_source = 'anchor_repair'") == 0
    assert _one(db_conn, "SELECT count(*) FROM laps WHERE segment_source = 'window'") > 20000


@pytest.mark.db
def test_times_source_splits_exactly_on_kind(db_conn):
    """§5.2: Q's segment times come from the timing API, SQ's are derived by FastF1."""
    assert sorted(_rows(db_conn, """
        SELECT s.kind, q.times_source, count(*) FROM quali_results q
          JOIN sessions s USING (session_id) GROUP BY 1, 2""")) == [
        ("Q", "api", 1241), ("SQ", "derived", 347)]


# ---------------------------------------------------------------------------------------
# 6. WP-A4 — D7's no-drift gate. Nothing stored changed (GAPFILL_SPEC §6.3 row A4, DL-26).
# ---------------------------------------------------------------------------------------

import importlib.util  # noqa: E402  (kept next to the tests that use it)

_NO_DRIFT = ROOT / "scripts" / "verify" / "no_drift_mode2.py"


def _no_drift_module():
    spec = importlib.util.spec_from_file_location("no_drift_mode2", _NO_DRIFT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_no_drift_script_exists_and_pins_the_spec_literals():
    """The constants are the contract; a future edit that softens one fails here."""
    assert _NO_DRIFT.is_file(), f"{_NO_DRIFT} is missing — §6.3 row A4 is unverifiable"
    nd = _no_drift_module()
    assert nd.EXPECTED_ROW_AUDIT_ROWS == 983
    assert nd.EXPECTED_SKILL_ROWS_BASELINE == SKILL_ROWS_BEFORE_V18 == 112
    assert nd.EXPECTED_SKILL_ROWS_V18 == SKILL_ROWS_V18 == 196
    assert nd.EXPECTED_DRIVERS == 28
    assert sorted(nd.PRE_EXISTING_SKILLS) == sorted(PRE_EXISTING_SKILLS)
    assert sorted(nd.UNTOUCHED_TABLES) == [
        "mode2_car_rating", "mode2_counterfactual",
        "mode2_driver_contrast", "mode2_driver_rating"]


@pytest.mark.db
def test_mode2_row_audit_is_983_rows_for_every_fit(db_conn):
    """D7's headline. 983 PER fit; the table total is 983 x the number of fits kept."""
    per_fit = dict(_rows(db_conn, "SELECT fit_id, count(*) FROM mode2_row_audit GROUP BY 1"))
    assert set(per_fit.values()) == {983}, f"mode2_row_audit per fit_id: {per_fit}"
    assert _one(db_conn, "SELECT count(*) FROM mode2_row_audit") == 983 * len(per_fit)


@pytest.mark.db
def test_mode2_driver_skill_goes_112_to_196(db_conn):
    """§2.1's net effect on stored rows, with the key sets named rather than counted."""
    baseline, current = _fit_pair(db_conn)
    assert _one(db_conn, "SELECT count(*) FROM mode2_driver_skill WHERE fit_id = %s",
                (baseline,)) == SKILL_ROWS_BEFORE_V18
    assert _one(db_conn, "SELECT count(*) FROM mode2_driver_skill WHERE fit_id = %s",
                (current,)) == SKILL_ROWS_V18
    keys = lambda f: sorted(  # noqa: E731
        k for (k,) in _rows(db_conn, "SELECT DISTINCT skill FROM mode2_driver_skill "
                                     "WHERE fit_id = %s", (f,)))
    assert keys(baseline) == sorted(PRE_EXISTING_SKILLS)
    assert keys(current) == sorted(PRE_EXISTING_SKILLS + NEW_SKILLS_V18)
    for f in (baseline, current):
        assert _one(db_conn, "SELECT count(DISTINCT driver_id) FROM mode2_driver_skill "
                             "WHERE fit_id = %s", (f,)) == 28


@pytest.mark.db
def test_the_112_pre_existing_rows_are_identical_across_the_two_fits(db_conn):
    """THE check (DL-26). Not a spot check: twelve columns, 112 rows, zero differences.

    A skill fit that quietly moved `race_pace` adds no row anywhere, so every count in
    this file would still pass. This is the only assertion that would catch it.
    """
    nd = _no_drift_module()
    baseline, current = _fit_pair(db_conn)
    cols = nd.value_columns(db_conn, "mode2_driver_skill")
    assert len(cols) == 12 and "fit_id" not in cols and "assumption_set_id" not in cols
    a_only, b_only, sample = nd.diff_across_fits(
        db_conn, "mode2_driver_skill", baseline, current,
        restrict_skills=PRE_EXISTING_SKILLS)
    assert (a_only, b_only) == (0, 0), (
        f"a stored measured number MOVED between fit {baseline} and fit {current}: "
        f"{a_only} baseline-only, {b_only} current-only. Sample: {sample}")


@pytest.mark.db
@pytest.mark.parametrize("table", ["mode2_driver_rating", "mode2_driver_contrast",
                                   "mode2_car_rating", "mode2_counterfactual"])
def test_the_four_untouched_tables_are_identical_across_the_two_fits(db_conn, table):
    """§6.3 row A4's "untouched" — equal counts AND equal values, column by column."""
    nd = _no_drift_module()
    baseline, current = _fit_pair(db_conn)
    a_only, b_only, sample = nd.diff_across_fits(db_conn, table, baseline, current)
    assert (a_only, b_only) == (0, 0), f"{table} moved across fits: {sample}"


@pytest.mark.db
def test_mode2_row_audit_content_is_identical_across_the_two_fits(db_conn):
    """983 rows is a count; this is the value-level half of the same pin."""
    nd = _no_drift_module()
    baseline, current = _fit_pair(db_conn)
    assert nd.diff_across_fits(db_conn, "mode2_row_audit", baseline, current)[:2] == (0, 0)


@pytest.mark.db
def test_the_cross_fit_diff_actually_bites(db_conn):
    """Negative control, rolled back. A gate nobody has seen fail is not a gate.

    Three nudges, each the smallest thing the diff must catch: a 1e-12 change to a
    stored double, a non-NULL flipped to NULL, and the same 1e-12 in `mode2_row_audit`.
    `db_conn` is autocommit-off and this test commits nothing.
    """
    nd = _no_drift_module()
    baseline, current = _fit_pair(db_conn)
    try:
        with db_conn.cursor() as cur:
            cur.execute("UPDATE mode2_driver_skill SET value = value + 1e-12 "
                        "WHERE fit_id = %s AND skill = 'race_pace' AND driver_id = "
                        "(SELECT min(driver_id) FROM mode2_driver_skill "
                        " WHERE fit_id = %s AND skill = 'race_pace')", (current, current))
            assert cur.rowcount == 1
        assert nd.diff_across_fits(db_conn, "mode2_driver_skill", baseline, current,
                                   restrict_skills=PRE_EXISTING_SKILLS)[:2] == (1, 1)
        db_conn.rollback()

        with db_conn.cursor() as cur:
            cur.execute("UPDATE mode2_driver_skill SET pct_field_below = NULL "
                        "WHERE fit_id = %s AND skill = 'race_pace' AND driver_id = "
                        "(SELECT min(driver_id) FROM mode2_driver_skill WHERE fit_id = %s "
                        "  AND skill = 'race_pace' AND pct_field_below IS NOT NULL)",
                        (current, current))
            assert cur.rowcount == 1
        assert nd.diff_across_fits(db_conn, "mode2_driver_skill", baseline, current,
                                   restrict_skills=PRE_EXISTING_SKILLS)[:2] == (1, 1)
        db_conn.rollback()

        with db_conn.cursor() as cur:
            cur.execute("UPDATE mode2_row_audit SET y_pp = y_pp + 1e-12 WHERE ctid = "
                        "(SELECT min(ctid) FROM mode2_row_audit WHERE fit_id = %s "
                        " AND y_pp IS NOT NULL)", (current,))
            assert cur.rowcount == 1
        assert nd.diff_across_fits(db_conn, "mode2_row_audit", baseline, current)[:2] == (1, 1)
    finally:
        db_conn.rollback()
    # and the rollback really restored it
    assert nd.diff_across_fits(db_conn, "mode2_driver_skill", baseline, current,
                               restrict_skills=PRE_EXISTING_SKILLS)[:2] == (0, 0)
    assert nd.diff_across_fits(db_conn, "mode2_row_audit", baseline, current)[:2] == (0, 0)


@pytest.mark.db
def test_the_no_drift_script_runs_clean_end_to_end(capsys):
    """The release gate as release engineering will actually invoke it: exit 0."""
    nd = _no_drift_module()
    rc = nd.main([])
    out = capsys.readouterr().out
    assert "FAIL" not in out, out
    assert rc == 0, out
    assert "RESULT: zero differences" in out


@pytest.mark.db
def test_the_baseline_fit_still_matches_wp_a0s_pre_release_digest(db_conn):
    """The cross-fit diff cannot catch a bad write that BOTH fits carry. This can.

    `a1f3c4a2…` / `e74ff85a…` are WP-A0's pre-v1.8 snapshot of fit 79, re-confirmed by
    WP-A1 after its fit landed and re-confirmed here a third time.
    """
    nd = _no_drift_module()
    baseline, _ = _fit_pair(db_conn)
    pinned = nd.BASELINE_DIGESTS.get(baseline)
    if not pinned:
        pytest.skip(f"no pinned pre-release digest for baseline fit {baseline}; "
                    "the script prints the measured one for a later release to pin")
    for table, want in pinned.items():
        assert nd.fit_digest(db_conn, table, baseline) == want, f"{table} @ fit {baseline}"
