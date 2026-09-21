"""[db] Ingest 2024 R13 twice: identical row counts per table, same session_id, one extra
ingest_runs row — and the notebook's top-3 pace ranking comes back out of Postgres."""

from __future__ import annotations

import pytest

from f1lab import config, db, frames, ingest

pytestmark = [pytest.mark.db, pytest.mark.cache]

YEAR, ROUND = 2024, 13
PER_SESSION_TABLES = [t for t in frames.EXPECTED_COLUMNS
                      if "session_id" in frames.EXPECTED_COLUMNS[t] and t != "sessions"]
SEASON_TABLES = ["driver_standings", "constructor_standings", "driver_season_summary", "teammate_h2h"]
# v1.2 swept wp_swing into PER_SESSION_TABLES (it carries session_id), but its row count is a
# property of the RACE, not of the ingest: a race with no large win-probability swing correctly
# stores zero rows (8 of the 62 raced sessions do today). Hungary 2024 happens to have 4, so the
# blanket "> 0" passes by luck. Excluded by name and asserted separately below, rather than
# loosening "> 0" to ">= 0" for every table. wp_lap_probability is NOT excluded: the run-end
# companion step writes rows for every race session, so "> 0" is a real claim there.
# wp_swing: a race with no large probability swing legitimately stores zero rows.
# race_report (2026-09-14, MODE3_SPEC §4.4): written by the run-end `report` step, which
# needs ANTHROPIC_API_KEY and skips cleanly without one — so zero rows is the correct
# state for an ingest, not a missing write. Neither is a per-session child of
# build_race_frames; both are asserted elsewhere by their own suites.
# v1.7 (TELEMETRY_SPEC §2.7): the three session-keyed telemetry tables are swept into
# PER_SESSION_TABLES the moment frames.EXPECTED_COLUMNS gains them, and a blanket "> 0" is
# wrong for all three. Telemetry is a SECOND PASS (T7): `f1lab.ingest` never writes these,
# so zero rows is the correct state for an ingest that ran without one, and a non-zero count
# only appears when `python -m f1lab.telemetry` (or WP-5's cache-warm --force hook) has run.
# Excluded by name here and asserted explicitly and separately in
# test_telemetry_tables_are_optional below, exactly as wp_swing and race_report are.
# PRE-EXISTING, found by v1.7 integration when this file was run for the first time since
# v1.6 landed: QUALI_SPEC's three session-keyed qualifying tables are keyed to the Q / SQ
# session, and `two_runs` ingests the RACE session only (`--round 13`, no --only-quali). A
# race session therefore has zero rows in all three BY CONSTRUCTION, and the blanket "> 0"
# has been wrong about them since v1.6. Not a v1.7 regression — no telemetry table is
# involved — but it is what the loop actually fails on, so it is excluded here with its
# reason and asserted explicitly in test_qualifying_tables_belong_to_the_quali_session.
DATA_DEPENDENT_TABLES = {"wp_swing", "race_report",
                         "quali_results", "quali_segment_times", "quali_teammate_h2h",
                         "lap_telemetry", "lap_telemetry_summary", "lap_corner_speeds"}
#: §2.7's explicit claim: a session that HAS had the pass has one stored lap per driver,
#: which is at least this many even after a heavily attrited session.
MIN_TELEMETRY_LAPS = 15


def _session_id(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT session_id FROM sessions WHERE year = %s AND round = %s AND kind = 'R'", (YEAR, ROUND))
        row = cur.fetchone()
    conn.rollback()
    assert row is not None
    return int(row[0])


def _snapshot(conn) -> dict:
    sid = _session_id(conn)
    counts = db.table_counts(conn, PER_SESSION_TABLES, session_id=sid)
    with conn.cursor() as cur:
        for t in SEASON_TABLES:
            cur.execute(f"SELECT count(*) FROM {t} WHERE year = %s", (YEAR,))
            counts[t] = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM ingest_runs")
        runs = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM assumption_sets")
        sets = int(cur.fetchone()[0])
        cur.execute("SELECT status, raw_laps, clean_laps, total_laps FROM session_ingests WHERE session_id = %s",
                    (sid,))
        ingest_row = cur.fetchone()
    conn.rollback()
    return {"session_id": sid, "counts": counts, "runs": runs, "sets": sets, "ingest": ingest_row}


@pytest.fixture(scope="module")
def two_runs(dsn):
    conn = db.connect(dsn)
    try:
        assert ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dsn", dsn, "--sleep", "0"]) == 0
        first = _snapshot(conn)
        assert ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dsn", dsn, "--sleep", "0"]) == 0
        second = _snapshot(conn)
        yield conn, first, second
    finally:
        conn.close()


def test_idempotent(two_runs):
    _, first, second = two_runs
    assert first["session_id"] == second["session_id"]
    assert first["counts"] == second["counts"]
    assert second["runs"] == first["runs"] + 1
    assert first["sets"] == second["sets"]
    assert first["ingest"] == second["ingest"]
    assert first["ingest"][0] == "ok"


def test_every_table_populated(two_runs):
    conn, _, second = two_runs
    c = second["counts"]
    assert c["laps"] == 1355 and c["results"] == 20 and c["session_entries"] == 20 and c["session_teams"] == 10
    assert c["pace_ranking"] == 20 and c["teammate_deltas"] == 10 and c["fuel_sensitivity"] == 60
    assert c["lap_exclusion_report"] == 7 and c["compound_colours"] == 7
    for t in PER_SESSION_TABLES:
        if t != "session_ingests" and t not in DATA_DEPENDENT_TABLES:
            assert c[t] > 0, t
    assert c["session_ingests"] == 1
    assert c["wp_lap_probability"] > 0, "the run-end companion step writes per-lap probabilities"
    # wp_swing is data-dependent (see above), so the stable claim is the §1.9 cap, not a count.
    assert 0 <= c["wp_swing"] <= config.WP_SWING_MAX_ANNOTATIONS
    assert c["driver_standings"] > 0 and c["constructor_standings"] > 0
    assert c["driver_season_summary"] >= 20 and c["teammate_h2h"] >= 20   # == 20 when only Hungary is stored
    with conn.cursor() as cur:
        cur.execute("SELECT scheduled_rounds, ingested_rounds, standings_after_round, mixed_assumption_sets "
                    "FROM seasons WHERE year = %s", (YEAR,))
        scheduled, ingested_rounds, after, mixed = cur.fetchone()
        # Other rounds of 2024 may be ingested too (WP2); the aggregates must describe what is stored.
        cur.execute("SELECT count(*), max(s.round) FROM sessions s JOIN session_ingests si USING (session_id) "
                    "WHERE s.year = %s AND s.kind = 'R' AND si.status IN ('ok', 'partial')", (YEAR,))
        n_ok, max_ok = cur.fetchone()
        assert (scheduled, mixed) == (24, False)
        assert ingested_rounds == n_ok >= 1 and after == max_ok >= ROUND
        cur.execute("SELECT circuit_key FROM events WHERE year = %s AND round = %s", (YEAR, ROUND))
        assert cur.fetchone()[0] == 4
        cur.execute("SELECT total_laps, winner_driver_id, fastest_pace_driver_id FROM sessions WHERE session_id = %s",
                    (second["session_id"],))
        assert cur.fetchone() == (70, "piastri", "norris")
        # PRE-EXISTING, same cause as the DATA_DEPENDENT_TABLES note above and found at the
        # same time: this asserted a hard-coded 1 attempted session, which was right until
        # v1.6 gave every round a Q session. `--round 13` now legitimately attempts the
        # RACE and the QUALIFYING session (2024 R13 is session_id 16 and 15917), so the
        # stable claim is "every session this round has, all of them ok" — derived from
        # `sessions`, not a literal that a later release's new session kind breaks again.
        cur.execute("SELECT count(*) FROM sessions WHERE year = %s AND round = %s", (YEAR, ROUND))
        n_sessions = int(cur.fetchone()[0])
        cur.execute("SELECT status, sessions_attempted, sessions_ok, sessions_failed FROM ingest_runs "
                    "ORDER BY run_id DESC LIMIT 1")
        assert cur.fetchone() == ("ok", n_sessions, n_sessions, 0)
    conn.rollback()


def test_pace_ranking_matches_notebook(two_runs):
    conn, _, second = two_runs
    with conn.cursor() as cur:
        cur.execute("SELECT rank, driver_id, round(median_pace_s::numeric, 4) FROM pace_ranking "
                    "WHERE session_id = %s ORDER BY rank LIMIT 3", (second["session_id"],))
        rows = [(r[0], r[1], float(r[2])) for r in cur.fetchall()]
    conn.rollback()
    assert rows == [(1, "norris", 81.5796), (2, "piastri", 81.6349), (3, "hamilton", 81.8938)]


def test_standings_after_round(two_runs):
    conn, _, _ = two_runs
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id, points, wins, position FROM driver_standings "
                    "WHERE year = %s AND after_round = %s ORDER BY position LIMIT 3", (YEAR, ROUND))
        top = cur.fetchall()
        cur.execute("SELECT count(DISTINCT after_round), max(after_round) FROM driver_standings WHERE year = %s",
                    (YEAR,))
        n_rounds, max_round = cur.fetchone()
        cur.execute("SELECT ingested_rounds FROM seasons WHERE year = %s", (YEAR,))
        ingested_rounds = cur.fetchone()[0]
        cur.execute("SELECT after_round, points, wins FROM driver_standings WHERE year = %s AND driver_id = 'piastri' "
                    "AND after_round IN (%s, %s) ORDER BY after_round", (YEAR, ROUND - 1, ROUND))
        piastri = cur.fetchall()
    conn.rollback()
    if ingested_rounds == 1:
        # Only Hungary is stored: the race result IS the standings, and snapshots 1..12 are empty.
        assert [t[0] for t in top] == ["piastri", "norris", "hamilton"]
        assert top[0][1] == 25.0 and top[0][2] == 1 and top[0][3] == 1
        assert n_rounds == 1
    else:
        # Other rounds are stored (WP2): Hungary still adds exactly its 25 points and one win for Piastri.
        assert n_rounds == max_round >= ROUND
        (r0, p0, w0), (r1, p1, w1) = piastri
        assert (r0, r1) == (ROUND - 1, ROUND) and p1 - p0 == 25.0 and w1 - w0 == 1


def test_telemetry_tables_are_optional(two_runs):
    """TELEMETRY_SPEC §2.7 — the three excluded tables, asserted explicitly.

    T7 makes telemetry a second pass, so an ingest alone writes nothing here. The claim is
    two-sided and the side taken is read from `analytics_status['telemetry']`, never guessed:
    with the pass never run (or dropped, §3.6) the tables hold **exactly zero** rows for this
    session; with it run they hold one stored lap per driver. Either way `session_ingests.status`
    is still `'ok'` — T8's "a telemetry failure never demotes a healthy session".
    """
    conn, _, second = two_runs
    c = second["counts"]
    sid = second["session_id"] if "session_id" in second else _session_id(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT status, analytics_status FROM session_ingests WHERE session_id = %s", (sid,))
        status, analytics = cur.fetchone()
    conn.rollback()

    assert status in ("ok", "partial"), status
    entry = (analytics or {}).get("telemetry")
    state = entry.get("state") if isinstance(entry, dict) else entry

    if state == "ok":
        assert c["lap_telemetry"] >= MIN_TELEMETRY_LAPS, c["lap_telemetry"]
        assert c["lap_telemetry_summary"] == c["lap_telemetry"], "one summary per stored lap (§4.1)"
        assert c["lap_corner_speeds"] > c["lap_telemetry"], "several corners per lap (§4.2)"
    else:
        assert c["lap_telemetry"] == 0 and c["lap_telemetry_summary"] == 0, (state, c["lap_telemetry"])
        assert c["lap_corner_speeds"] == 0, c["lap_corner_speeds"]
        # §2.7's whole point: none of that makes the session unhealthy.
        assert status == "ok" or status == "partial"


def test_qualifying_tables_belong_to_the_quali_session(two_runs):
    """The other half of the exclusion above: zero rows on the RACE session is not an
    absence of data, it is the data being keyed to a different session. Asserted so the
    exclusion cannot quietly hide a real qualifying-ingest regression."""
    conn, _, second = two_runs
    c = second["counts"]
    for t in ("quali_results", "quali_segment_times", "quali_teammate_h2h"):
        assert c[t] == 0, (t, c[t], "a RACE session must never carry qualifying rows")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM quali_results qr JOIN sessions s USING (session_id) "
            "WHERE s.year = %s AND s.kind IN ('Q', 'SQ')", (YEAR,))
        n = int(cur.fetchone()[0])
    conn.rollback()
    assert n > 0, "no qualifying rows anywhere in 2024; run `make ingest-quali SEASON=2024`"
