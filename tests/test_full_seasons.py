"""[db] Season-level invariants once the full seasons are ingested (SPEC §5.3 WP2 verification).

Each test skips unless the season it needs is fully ingested, so the suite stays green on a
database that only holds the 2024 R13 fixture. The championship expectations are the official
final classifications, never adjusted to the code.
"""

from __future__ import annotations

import os
import pytest

pytestmark = pytest.mark.db

# (year, scheduled rounds, rounds expected ingested, champion, constructor champion)
SEASONS = {
    2024: (24, 24, "max_verstappen", "mclaren"),
    2025: (24, 24, "norris", "mclaren"),
    # 14 (was 13): 2026 R14 Madrid raced during the v1.2 build, 2026-09-13.
    2026: (23, 14, None, None),          # in progress: 14 of 23 complete as of 2026-09-13
}


def _rows(conn, sql: str, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    conn.rollback()
    return rows


def _require(conn, year: int) -> tuple:
    row = _rows(conn, "SELECT scheduled_rounds, ingested_rounds, standings_after_round, mixed_assumption_sets, "
                      "has_sprint_results FROM seasons WHERE year = %s", (year,))
    scheduled, want, *_ = SEASONS[year]
    if not row or row[0][1] < want:
        pytest.skip(f"season {year} not fully ingested (run python -m f1lab.ingest --season {year})")
    return row[0]


@pytest.mark.parametrize("year", sorted(SEASONS))
def test_seasons_row(db_conn, year):
    scheduled, want, _, _ = SEASONS[year]
    row = _require(db_conn, year)
    assert row == (scheduled, want, want, False, True)


# QUALI_SPEC §10.3. One session in three seasons cannot be ingested and never will be from the
# cache as it stands: loaded with `messages=True`, 2025 R06 Q Miami returns 20 results rows with
# `Position` on 20 of 20 and Q1/Q2/Q3 on 0 of 20, plus 314 laps. There is nothing to reconstruct
# the official classification from, so the ingest refuses the husk rather than storing invented
# times -- which is the behaviour this file exists to protect, not an exception to it. If a
# future FastF1 release publishes those times, `--season 2025 --only-quali` picks it up on its
# own (failed rows are retried) and this entry should be deleted.
#
# NOTHING ELSE BELONGS HERE. A `failed` row that is stale test residue is a bug in the database,
# not an allowlist entry: 2024 R05 S carried `simulated: no timing data available` left behind by
# a `tests/test_ingest_cli.py` run, which silently removed that sprint from 2024's sprint points
# (180 instead of 216) until the v1.6 integration pass re-ingested it.
PERMANENTLY_UNAVAILABLE = {
    (2025, 6, "Q"): "no timing data available for 2025 R06 Q",
}


@pytest.mark.parametrize("year", sorted(SEASONS))
def test_every_completed_session_is_ok_or_partial_with_a_reason(db_conn, year):
    _require(db_conn, year)
    rows = _rows(db_conn, """
        SELECT s.round, s.kind, si.status, si.error, si.analytics_status
        FROM sessions s JOIN session_ingests si USING (session_id) WHERE s.year = %s ORDER BY s.round, s.kind""",
                 (year,))
    assert rows, year
    for rnd, kind, status, error, analytics in rows:
        if (year, rnd, kind) in PERMANENTLY_UNAVAILABLE:
            # The allowlist is one session and it is a fact about the source, not about this
            # code. Assert the reason is still the recorded one, so a DIFFERENT failure at the
            # same round cannot hide behind the entry.
            assert status == "failed", (rnd, kind, status)
            # The CI fixture scrubs session_ingests.error to NULL (it can carry local
            # filesystem paths), so under F1_CI the reason text is not available to check;
            # the status assertion above still holds there. Locally the text is asserted.
            if error is None and os.environ.get("F1_CI"):
                continue
            assert PERMANENTLY_UNAVAILABLE[(year, rnd, kind)] in (error or ""), error
            continue
        assert status in ("ok", "partial"), (rnd, kind, status, error)
        if status == "partial":
            assert any(v != "ok" for v in analytics.values()), (rnd, kind, analytics)
    # Pending rounds have a sessions row but no session_ingests row.
    pending = _rows(db_conn, "SELECT count(*) FROM sessions s LEFT JOIN session_ingests si USING (session_id) "
                             "WHERE s.year = %s AND si.session_id IS NULL", (year,))[0][0]
    n_sessions = _rows(db_conn, "SELECT count(*) FROM sessions WHERE year = %s", (year,))[0][0]
    assert pending == n_sessions - len(rows)
    # A sprint row exists exactly for sprint_qualifying events.
    sprint_rounds = _rows(db_conn, "SELECT round FROM sessions WHERE year = %s AND kind = 'S' ORDER BY 1", (year,))
    sq_rounds = _rows(db_conn, "SELECT round FROM events WHERE year = %s AND event_format = 'sprint_qualifying' "
                               "ORDER BY 1", (year,))
    assert sprint_rounds == sq_rounds


@pytest.mark.parametrize("year", sorted(SEASONS))
def test_standings_snapshots_and_champions(db_conn, year):
    _, want, champion, constructor = SEASONS[year]
    _require(db_conn, year)
    snaps = _rows(db_conn, "SELECT DISTINCT after_round FROM driver_standings WHERE year = %s ORDER BY 1", (year,))
    assert [r[0] for r in snaps] == list(range(1, want + 1))
    top = _rows(db_conn, "SELECT driver_id, points, sprint_points FROM driver_standings "
                         "WHERE year = %s AND after_round = %s ORDER BY position LIMIT 1", (year, want))[0]
    if champion:
        assert top[0] == champion
    assert top[2] > 0          # sprint points are included
    if constructor:
        assert _rows(db_conn, "SELECT team_id FROM constructor_standings WHERE year = %s AND after_round = %s "
                              "ORDER BY position LIMIT 1", (year, want))[0][0] == constructor
    # Positions are 1..n with no gaps, and driver points sum to constructor points on every snapshot.
    for rnd in range(1, want + 1):
        pos = _rows(db_conn, "SELECT position FROM driver_standings WHERE year = %s AND after_round = %s "
                             "ORDER BY 1", (year, rnd))
        assert [p[0] for p in pos] == list(range(1, len(pos) + 1)), rnd
        d, c = _rows(db_conn, "SELECT (SELECT sum(points) FROM driver_standings WHERE year = %s AND after_round = %s), "
                              "(SELECT sum(points) FROM constructor_standings WHERE year = %s AND after_round = %s)",
                     (year, rnd, year, rnd))[0]
        assert d == pytest.approx(c), rnd
    # Points are monotone non-decreasing across snapshots for every driver.
    bad = _rows(db_conn, """
        SELECT a.driver_id, a.after_round FROM driver_standings a JOIN driver_standings b
          ON a.year = b.year AND a.driver_id = b.driver_id AND b.after_round = a.after_round + 1
        WHERE a.year = %s AND b.points < a.points""", (year,))
    assert bad == []


@pytest.mark.parametrize("year", sorted(SEASONS))
def test_driver_summary_and_h2h_cover_every_race_entry(db_conn, year):
    _, want, _, _ = SEASONS[year]
    _require(db_conn, year)
    race_drivers = {r[0] for r in _rows(db_conn, "SELECT DISTINCT r.driver_id FROM results r JOIN sessions s "
                                                 "USING (session_id) WHERE s.year = %s AND s.kind = 'R'", (year,))}
    summary = {r[0] for r in _rows(db_conn, "SELECT driver_id FROM driver_season_summary WHERE year = %s", (year,))}
    assert summary == race_drivers
    h2h = _rows(db_conn, "SELECT driver_id, teammate_driver_id, races_paired, pace_wins, pace_losses, "
                         "mean_signed_gap_pct FROM teammate_h2h WHERE year = %s", (year,))
    assert {r[0] for r in h2h} == race_drivers
    mirror = {(a, b): (n, w, l, g) for a, b, n, w, l, g in h2h}
    for (a, b), (n, w, l, g) in mirror.items():
        n2, w2, l2, g2 = mirror[(b, a)]
        assert (n2, w2, l2) == (n, l, w)
        assert (g2 == pytest.approx(-g)) if g is not None else g2 is None
    champ_pos = _rows(db_conn, "SELECT championship_position FROM driver_season_summary WHERE year = %s "
                               "ORDER BY championship_position", (year,))
    assert [p[0] for p in champ_pos] == list(range(1, len(champ_pos) + 1))


def test_2025_known_edge_cases(db_conn):
    _require(db_conn, 2025)
    sid = {r[0]: r[1] for r in _rows(db_conn, "SELECT round, session_id FROM sessions WHERE year = 2025 AND kind = 'R'")}
    # Miami: 354 laps with the literal 'nan' compound and NaN stint are stored as NULL, never 'nan'.
    assert _rows(db_conn, "SELECT count(*) FILTER (WHERE compound IS NULL), count(*) FILTER (WHERE compound = 'nan'), "
                          "count(*) FILTER (WHERE stint IS NULL) FROM laps WHERE session_id = %s", (sid[6],)) == \
        [(354, 0, 354)]
    assert _rows(db_conn, "SELECT warnings FROM session_ingests WHERE session_id = %s", (sid[6],)) == \
        [(["compound 'nan' normalised on 354 laps"],)]
    # Spain: 19-row results (one Aston Martin driver), so 9 teammate pairs and 19 entries.
    assert _rows(db_conn, "SELECT (SELECT count(*) FROM results WHERE session_id = %s), "
                          "(SELECT count(*) FROM session_entries WHERE session_id = %s), "
                          "(SELECT count(*) FROM teammate_deltas WHERE session_id = %s)",
                 (sid[9],) * 3) == [(19, 19, 9)]
    # Belgium: FastF1's compound 'NONE' is kept verbatim and has its own colour row.
    assert _rows(db_conn, "SELECT count(*) FROM laps WHERE session_id = %s AND compound = 'NONE'", (sid[13],))[0][0] > 0
    assert _rows(db_conn, "SELECT count(*) FROM compound_colours WHERE session_id = %s AND compound = 'NONE'",
                 (sid[13],)) == [(1,)]
    # Every in-lap is a pit stop, in every race of the season.
    assert _rows(db_conn, """
        SELECT count(*) FROM sessions s WHERE s.year = 2025 AND s.kind = 'R' AND
          (SELECT count(*) FROM laps l WHERE l.session_id = s.session_id AND l.pit_in_time_s IS NOT NULL)
          <> (SELECT count(*) FROM pit_stops p WHERE p.session_id = s.session_id)""") == [(0,)]
    # rank@0.03 reproduces pace_ranking.rank everywhere (D2).
    assert _rows(db_conn, """
        SELECT count(*) FROM fuel_sensitivity f JOIN pace_ranking p USING (session_id, driver_id)
        JOIN sessions s USING (session_id) WHERE s.year = 2025 AND f.fuel_effect_s_per_kg = 0.03 AND f.rank <> p.rank
        """) == [(0,)]


def test_2026_red_flags_and_dns(db_conn):
    _require(db_conn, 2026)
    sid = {r[0]: r[1] for r in _rows(db_conn, "SELECT round, session_id FROM sessions WHERE year = 2026 AND kind = 'R'")}
    red = _rows(db_conn, "SELECT s.round, ls.lap_number FROM lap_status ls JOIN sessions s USING (session_id) "
                         "WHERE s.year = 2026 AND ls.worst_status = '5' ORDER BY 1, 2")
    assert {r[0] for r in red} == {6, 12, 13}
    assert all(not g for (g,) in _rows(db_conn, "SELECT is_green FROM lap_status WHERE worst_status = '5'"))
    dns = _rows(db_conn, "SELECT count(*) FROM results r JOIN sessions s USING (session_id) "
                         "WHERE s.year = 2026 AND s.kind = 'R' AND r.status = 'Did not start' "
                         "AND r.classified_position = 'W' AND r.laps_completed = 0 AND r.result_time_s IS NULL")
    assert dns[0][0] >= 2
    assert _rows(db_conn, "SELECT count(*) FROM session_teams WHERE session_id = %s", (sid[1],)) == [(11,)]
    assert _rows(db_conn, "SELECT count(*) FROM session_entries WHERE session_id = %s", (sid[1],)) == [(22,)]
    # Rounds after the last completed one are pending: no total_laps, no winner, no ingest row.
    # Boundary 14 (was 13): 2026 R14 Madrid raced 2026-09-13, so the last completed round is now 14.
    # The expectation stays 0 — asserting 1 here would assert that a pending round is NOT pending.
    assert _rows(db_conn, """
        SELECT count(*) FROM sessions s LEFT JOIN session_ingests si USING (session_id)
        WHERE s.year = 2026 AND s.round > 14 AND (si.session_id IS NOT NULL OR s.total_laps IS NOT NULL
                                                  OR s.winner_driver_id IS NOT NULL)""") == [(0,)]
