"""[db] Milestone 1 gate (SPEC §5.2 step 5): the stored 2024 R13 numbers equal the notebook's.

Runs after ``test_ingest_hungary`` (alphabetical order) against whatever that ingest wrote;
skips when the session has not been ingested. Every expectation below is a number the
notebook ``01_one_race.ipynb`` prints or SPEC §1.14 / §5.2 states — never adjusted to the code.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.db

YEAR, ROUND = 2024, 13


def _rows(conn, sql: str, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    conn.rollback()
    return rows


@pytest.fixture(scope="module")
def sid(db_conn) -> int:
    rows = _rows(db_conn, "SELECT s.session_id FROM sessions s JOIN session_ingests si USING (session_id) "
                          "WHERE s.year = %s AND s.round = %s AND s.kind = 'R' AND si.status IN ('ok', 'partial')",
                 (YEAR, ROUND))
    if not rows:
        pytest.skip("2024 R13 not ingested (run python -m f1lab.ingest --season 2024 --round 13)")
    return int(rows[0][0])


def test_session_row(db_conn, sid):
    assert _rows(db_conn, "SELECT total_laps, winner_driver_id, fastest_pace_driver_id FROM sessions "
                          "WHERE session_id = %s", (sid,)) == [(70, "piastri", "norris")]


def test_laps_counts_and_compounds(db_conn, sid):
    (n, rep, nan_comp, in_laps), = _rows(db_conn, """
        SELECT count(*), count(*) FILTER (WHERE is_representative), count(*) FILTER (WHERE compound = 'nan'),
               count(*) FILTER (WHERE pit_in_time_s IS NOT NULL) FROM laps WHERE session_id = %s""", (sid,))
    assert (n, rep, nan_comp) == (1355, 1233, 0)
    (surviving,), = _rows(db_conn, "SELECT laps_hit FROM lap_exclusion_report WHERE session_id = %s "
                                   "AND rule LIKE 'SURVIVING%%'", (sid,))
    assert surviving == rep == 1233
    (stops,), = _rows(db_conn, "SELECT count(*) FROM pit_stops WHERE session_id = %s", (sid,))
    assert stops == in_laps == 41


def test_pace_ranking_top3(db_conn, sid):
    rows = _rows(db_conn, "SELECT rank, driver_id, round(median_pace_s::numeric, 4) FROM pace_ranking "
                          "WHERE session_id = %s ORDER BY rank LIMIT 3", (sid,))
    assert [(r, d, float(m)) for r, d, m in rows] == [(1, "norris", 81.5796), (2, "piastri", 81.6349),
                                                      (3, "hamilton", 81.8938)]


def test_teammate_deltas(db_conn, sid):
    rows = _rows(db_conn, "SELECT team_id, faster_driver_id, round(gap_pct::numeric, 3) FROM teammate_deltas "
                          "WHERE session_id = %s ORDER BY gap_pct DESC", (sid,))
    assert len(rows) == 10
    team, faster, gap_pct = rows[0]
    assert (team, faster, float(gap_pct)) == ("mercedes", "hamilton", pytest.approx(0.839))


def test_fuel_sensitivity_reproduces_rank(db_conn, sid):
    (n, drivers), = _rows(db_conn, "SELECT count(*), count(DISTINCT driver_id) FROM fuel_sensitivity "
                                   "WHERE session_id = %s", (sid,))
    assert (n, drivers) == (60, 20)
    (mismatched,), = _rows(db_conn, """
        SELECT count(*) FROM fuel_sensitivity f JOIN pace_ranking p USING (session_id, driver_id)
        WHERE f.session_id = %s AND f.fuel_effect_s_per_kg = 0.03 AND f.rank <> p.rank""", (sid,))
    assert mismatched == 0


def test_compound_degradation_slopes(db_conn, sid):
    rows = _rows(db_conn, "SELECT compound, round(slope_s_per_lap::numeric, 3) FROM compound_degradation "
                          "WHERE session_id = %s", (sid,))
    assert {c: float(s) for c, s in rows} == {"HARD": pytest.approx(0.082), "MEDIUM": pytest.approx(0.061),
                                              "SOFT": pytest.approx(-0.037)}


def test_final_lap_gaps_match_classification(db_conn, sid):
    rows = _rows(db_conn, """
        SELECT round(l.gap_to_leader_s::numeric, 3) FROM laps l JOIN results r USING (session_id, driver_id)
        WHERE l.session_id = %s AND l.lap_number = 70 ORDER BY r.position LIMIT 4""", (sid,))
    assert [float(g) for (g,) in rows] == [0.0, 2.141, 14.880, 19.686]


def test_season_aggregates(db_conn, sid):
    (scheduled, ingested_rounds, after), = _rows(
        db_conn, "SELECT scheduled_rounds, ingested_rounds, standings_after_round FROM seasons WHERE year = %s",
        (YEAR,))
    assert scheduled == 24 and after >= ROUND
    (h2h,), = _rows(db_conn, "SELECT count(*) FROM teammate_h2h WHERE year = %s", (YEAR,))
    (summ,), = _rows(db_conn, "SELECT count(*) FROM driver_season_summary WHERE year = %s", (YEAR,))
    if ingested_rounds == 1:
        # Only Hungary is stored (the Milestone 1 state): the race result is the standings.
        assert after == ROUND
        top = _rows(db_conn, "SELECT driver_id, points FROM driver_standings WHERE year = %s AND after_round = %s "
                             "ORDER BY position LIMIT 1", (YEAR, ROUND))
        assert top == [("piastri", 25.0)]
        assert (h2h, summ) == (20, 20)
    else:
        # More of 2024 is stored (WP2): Hungary contributes exactly its race points to every driver.
        delta = _rows(db_conn, """
            SELECT a.driver_id, a.points - coalesce(b.points, 0) FROM driver_standings a
            LEFT JOIN driver_standings b ON b.year = a.year AND b.driver_id = a.driver_id AND b.after_round = %s
            WHERE a.year = %s AND a.after_round = %s ORDER BY 1""", (ROUND - 1, YEAR, ROUND))
        points = dict(_rows(db_conn, "SELECT driver_id, points FROM results WHERE session_id = %s", (sid,)))
        assert {d: float(p) for d, p in delta if d in points} == {d: float(p) for d, p in points.items()}
        assert h2h >= 20 and summ >= 20
