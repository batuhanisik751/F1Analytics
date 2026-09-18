"""[db] The CLI modes of ``python -m f1lab.ingest`` beyond a plain season run (SPEC §2.5).

Every test drives ``ingest.main`` with the real argument parser against the live database and
the cached 2024 R13 session, so nothing here touches the network:

- ``--check-schema``      exit 0 and no ``ingest_runs`` row
- ``--dry-run``           loads + computes, prints per-table counts, writes nothing
- ``--recompute-season``  rewrites the aggregates from stored rows only (no FastF1 load)
- ``--fail-fast``         a load failure is recorded as a ``failed`` session_ingests row, the run
                          is ``failed`` (exit 1), and the previous good child rows are left intact
- rate limit              ``RateLimitExceededError`` aborts the run (exit 2, status ``aborted``)
                          without touching the session's rows
- sprint weekend          a sprint that fails AFTER the race of the same round was written leaves
                          the race committed (each session is its own transaction, §2.5); a Ctrl-C
                          likewise keeps the committed sessions and records the run as ``aborted``

The failure tests simulate the load error by monkeypatching ``ingest.load_with_retry``; the
session is re-ingested afterwards so the database is left exactly as it was found. The sprint
tests use the cached 2024 R5 (Chinese GP: race + sprint), so they too stay off the network.
"""

from __future__ import annotations

import pytest

from f1lab import db, ingest

pytestmark = pytest.mark.db

YEAR, ROUND = 2024, 13


def _one(conn, sql: str, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    conn.rollback()
    return row


def _session_id(conn) -> int:
    row = _one(conn, "SELECT session_id FROM sessions WHERE year = %s AND round = %s AND kind = 'R'", (YEAR, ROUND))
    assert row is not None, "2024 R13 has no sessions row (run the ingest once first)"
    return int(row[0])


def _latest_run(conn):
    return _one(conn, "SELECT run_id, status, sessions_attempted, sessions_ok, sessions_failed, error "
                      "FROM ingest_runs ORDER BY run_id DESC LIMIT 1")


@pytest.fixture(scope="module")
def conn(dsn):
    c = db.connect(dsn)
    try:
        yield c
    finally:
        c.close()


@pytest.fixture(scope="module")
def ingested(conn, dsn) -> int:
    """Make sure 2024 R13 is 'ok' before the failure tests run, and give back its session_id."""
    row = _one(conn, "SELECT si.status FROM session_ingests si JOIN sessions s USING (session_id) "
                     "WHERE s.year = %s AND s.round = %s AND s.kind = 'R'", (YEAR, ROUND))
    if row is None or row[0] != "ok":
        assert ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dsn", dsn, "--sleep", "0"]) == 0
    return _session_id(conn)


def test_check_schema_exit_0_and_writes_no_run(conn, dsn, capsys):
    before = _one(conn, "SELECT count(*) FROM ingest_runs")[0]
    assert ingest.main(["--check-schema", "--dsn", dsn]) == 0
    assert "schema ok" in capsys.readouterr().out
    assert _one(conn, "SELECT count(*) FROM ingest_runs")[0] == before


def test_dry_run_prints_counts_and_writes_nothing(conn, dsn, ingested, capsys):
    before = _one(conn, "SELECT count(*) FROM ingest_runs")[0]
    ingested_at = _one(conn, "SELECT ingested_at FROM session_ingests WHERE session_id = %s", (ingested,))[0]
    assert ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dry-run", "--sleep", "0"]) == 0
    out = capsys.readouterr().out
    assert f"{YEAR} R{ROUND:02d} R Hungarian Grand Prix: status=ok raw_laps=1355 clean_laps=1233 total_laps=70" in out
    assert "laps                     1355" in out and "pace_ranking               20" in out
    assert _one(conn, "SELECT count(*) FROM ingest_runs")[0] == before
    assert _one(conn, "SELECT ingested_at FROM session_ingests WHERE session_id = %s", (ingested,))[0] == ingested_at


def test_recompute_season_rewrites_aggregates_only(conn, dsn, ingested):
    before_runs = _one(conn, "SELECT count(*) FROM ingest_runs")[0]
    before = _one(conn, "SELECT recomputed_at, ingested_rounds, standings_after_round FROM seasons WHERE year = %s",
                  (YEAR,))
    counts_before = _one(conn, "SELECT (SELECT count(*) FROM driver_standings WHERE year = %s), "
                               "(SELECT count(*) FROM constructor_standings WHERE year = %s), "
                               "(SELECT count(*) FROM driver_season_summary WHERE year = %s), "
                               "(SELECT count(*) FROM teammate_h2h WHERE year = %s)", (YEAR,) * 4)
    assert ingest.main(["--season", str(YEAR), "--recompute-season", "--dsn", dsn]) == 0
    after = _one(conn, "SELECT recomputed_at, ingested_rounds, standings_after_round FROM seasons WHERE year = %s",
                 (YEAR,))
    counts_after = _one(conn, "SELECT (SELECT count(*) FROM driver_standings WHERE year = %s), "
                              "(SELECT count(*) FROM constructor_standings WHERE year = %s), "
                              "(SELECT count(*) FROM driver_season_summary WHERE year = %s), "
                              "(SELECT count(*) FROM teammate_h2h WHERE year = %s)", (YEAR,) * 4)
    assert after[0] > before[0] and after[1:] == before[1:]
    assert counts_after == counts_before
    assert _one(conn, "SELECT count(*) FROM ingest_runs")[0] == before_runs     # no run row for a recompute


def test_fail_fast_records_failed_session_and_keeps_old_rows(conn, dsn, ingested, monkeypatch):
    laps_before = _one(conn, "SELECT count(*) FROM laps WHERE session_id = %s", (ingested,))[0]
    assert laps_before == 1355

    def boom(year, rnd, kind, cache):
        raise RuntimeError("simulated: data not yet available")

    monkeypatch.setattr(ingest, "load_with_retry", boom)
    try:
        rc = ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--fail-fast", "--dsn", dsn, "--sleep", "0"])
        monkeypatch.undo()
        _assert_failed_state(conn, ingested, laps_before, rc)
    finally:
        # Whatever happened above, leave the database as it was found: 2024 R13 back to 'ok'.
        monkeypatch.undo()
        assert ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dsn", dsn, "--sleep", "0"]) == 0
    assert _one(conn, "SELECT status, error FROM session_ingests WHERE session_id = %s", (ingested,)) == ("ok", None)
    assert _latest_run(conn)[1:5] == ("ok", 2, 2, 0)   # 2024 R13 is R + Q (§1.3)


def _assert_failed_state(conn, ingested: int, laps_before: int, rc: int) -> None:
    assert rc == 1
    run = _latest_run(conn)
    assert run[1:] == ("failed", 1, 0, 1, "RuntimeError: simulated: data not yet available")
    si = _one(conn, "SELECT status, error, analytics_status, raw_laps, clean_laps, run_id FROM session_ingests "
                    "WHERE session_id = %s", (ingested,))
    assert si[0] == "failed" and "simulated: data not yet available" in si[1]
    assert si[2] == {} and si[3] == 0 and si[4] == 0 and si[5] == run[0]
    # The previous good data is intact: only session_ingests changed.
    assert _one(conn, "SELECT count(*) FROM laps WHERE session_id = %s", (ingested,))[0] == laps_before
    assert _one(conn, "SELECT total_laps, winner_driver_id FROM sessions WHERE session_id = %s",
                (ingested,)) == (70, "piastri")
    # A failed round contributes nothing to the season, and the aggregates are recomputed even
    # after a --fail-fast stop, so seasons.ingested_rounds already reflects it.
    assert _one(conn, "SELECT ingested_rounds FROM seasons WHERE year = %s", (YEAR,))[0] == \
        _one(conn, "SELECT count(*) FROM sessions s JOIN session_ingests si USING (session_id) "
                   "WHERE s.year = %s AND s.kind = 'R' AND si.status IN ('ok', 'partial')", (YEAR,))[0]


def test_rate_limit_aborts_with_exit_2(conn, dsn, ingested, monkeypatch):
    before = _one(conn, "SELECT status, run_id FROM session_ingests WHERE session_id = %s", (ingested,))
    assert before[0] == "ok"

    def limited(year, rnd, kind, cache):
        raise ingest.RateLimitExceededError("simulated: too many requests")

    monkeypatch.setattr(ingest, "load_with_retry", limited)
    rc = ingest.main(["--season", str(YEAR), "--round", str(ROUND), "--dsn", dsn, "--sleep", "0"])
    monkeypatch.undo()
    assert rc == 2

    run = _latest_run(conn)
    assert run[1] == "aborted" and run[2:5] == (1, 0, 0)
    assert "rate limit exceeded" in run[5] and f"{YEAR} R{ROUND:02d} R" in run[5]
    # An abort never writes a session_ingests row: the session is still 'ok' from its previous run.
    assert _one(conn, "SELECT status, run_id FROM session_ingests WHERE session_id = %s", (ingested,)) == before


def test_unknown_selection_is_empty_and_ok(conn, dsn):
    """A --round that does not exist selects no session, recomputes the season, and exits 0."""
    assert ingest.main(["--season", str(YEAR), "--round", "99", "--dsn", dsn, "--sleep", "0"]) == 0
    assert _latest_run(conn)[1:5] == ("ok", 0, 0, 0)


# ---------------------------------------------------------------------------
# A round with two sessions: the race is committed before the sprint fails / the run is interrupted
# ---------------------------------------------------------------------------

SPRINT_YEAR, SPRINT_ROUND = 2024, 5   # Chinese GP, sprint weekend; both sessions are in the cache


def _round_state(conn, year: int, rnd: int) -> dict:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT s.kind, si.status, si.run_id,
                   (SELECT count(*) FROM laps l WHERE l.session_id = s.session_id),
                   (SELECT count(*) FROM results r WHERE r.session_id = s.session_id),
                   s.total_laps, s.winner_driver_id
            FROM sessions s LEFT JOIN session_ingests si USING (session_id)
            WHERE s.year = %s AND s.round = %s ORDER BY s.kind""", (year, rnd))
        rows = {r[0]: {"status": r[1], "run_id": r[2], "laps": r[3], "results": r[4], "total_laps": r[5],
                       "winner": r[6]} for r in cur.fetchall()}
    conn.rollback()
    # QUALI_SPEC §1.3: --round now means "every session of this round", which on a sprint
    # weekend is four sessions, not two.
    assert set(rows) == {"R", "S", "Q", "SQ"}, rows
    return rows


def _restore_round(dsn: str, year: int, rnd: int) -> None:
    assert ingest.main(["--season", str(year), "--round", str(rnd), "--dsn", dsn, "--sleep", "0"]) == 0


def test_failed_sprint_keeps_the_race_written_earlier_in_the_run(conn, dsn, monkeypatch):
    """R is ingested before S (§2.5 order). When S then fails, the race's rows, its 'ok'
    session_ingests row and the run's counters must all survive: per-session transactions are
    committed one by one, not rolled back together by the failure path."""
    real = ingest.load_with_retry

    def sprint_missing(year, rnd, kind, cache):
        if kind == "S":
            raise ingest.DataNotAvailable(f"simulated: no timing data available for {year} R{rnd:02d} S")
        return real(year, rnd, kind, cache)

    before = _round_state(conn, SPRINT_YEAR, SPRINT_ROUND)
    monkeypatch.setattr(ingest, "load_with_retry", sprint_missing)
    try:
        rc = ingest.main(["--season", str(SPRINT_YEAR), "--round", str(SPRINT_ROUND), "--dsn", dsn, "--sleep", "0"])
        monkeypatch.undo()
        assert rc == 1
        run = _latest_run(conn)
        assert run[1:5] == ("partial", 4, 3, 1)   # R, Q, SQ ok; S failed
        state = _round_state(conn, SPRINT_YEAR, SPRINT_ROUND)
        assert state["R"]["status"] == "ok" and state["R"]["run_id"] == run[0]      # written by THIS run
        assert state["R"]["laps"] > 1000 and state["R"]["results"] == 20
        assert state["R"]["total_laps"] == 56 and state["R"]["winner"] == "max_verstappen"
        assert state["S"]["status"] == "failed" and state["S"]["run_id"] == run[0]
        # A failure only records the failed row; the sprint's previous good rows stay (§2.5).
        assert state["S"]["results"] == before["S"]["results"] and state["S"]["laps"] == 0
        # The race counts for the season even though its sprint failed.
        assert _one(conn, "SELECT ingested_rounds FROM seasons WHERE year = %s", (SPRINT_YEAR,))[0] == \
            _one(conn, "SELECT count(*) FROM sessions s JOIN session_ingests si USING (session_id) "
                       "WHERE s.year = %s AND s.kind = 'R' AND si.status IN ('ok', 'partial')", (SPRINT_YEAR,))[0]
    finally:
        monkeypatch.undo()
        _restore_round(dsn, SPRINT_YEAR, SPRINT_ROUND)
    state = _round_state(conn, SPRINT_YEAR, SPRINT_ROUND)
    assert state["R"]["status"] == "ok" and state["S"]["status"] == "ok" and state["S"]["results"] == 20
    assert _latest_run(conn)[1:5] == ("ok", 4, 4, 0)


def test_interrupt_keeps_committed_sessions_and_marks_the_run_aborted(conn, dsn, monkeypatch):
    """Ctrl-C while the sprint loads: the race written just before stays, the sprint's previous
    row is untouched, and ingest_runs says 'aborted' (not 'running') with exit code 2."""
    _restore_round(dsn, SPRINT_YEAR, SPRINT_ROUND)   # a known starting point: both sessions 'ok'
    before = _round_state(conn, SPRINT_YEAR, SPRINT_ROUND)
    real = ingest.load_with_retry

    def interrupted(year, rnd, kind, cache):
        if kind == "S":
            raise KeyboardInterrupt
        return real(year, rnd, kind, cache)

    monkeypatch.setattr(ingest, "load_with_retry", interrupted)
    try:
        rc = ingest.main(["--season", str(SPRINT_YEAR), "--round", str(SPRINT_ROUND), "--dsn", dsn, "--sleep", "0"])
        monkeypatch.undo()
        assert rc == 2
        run = _latest_run(conn)
        assert run[1:5] == ("aborted", 2, 1, 0) and "interrupted" in run[5]
        assert _one(conn, "SELECT finished_at IS NOT NULL FROM ingest_runs WHERE run_id = %s", (run[0],))[0]
        state = _round_state(conn, SPRINT_YEAR, SPRINT_ROUND)
        assert state["R"]["status"] == "ok" and state["R"]["run_id"] == run[0]      # written by THIS run
        assert state["R"]["laps"] == before["R"]["laps"] and state["R"]["winner"] == "max_verstappen"
        assert state["S"] == before["S"]                                             # never touched
    finally:
        monkeypatch.undo()
        _restore_round(dsn, SPRINT_YEAR, SPRINT_ROUND)
    assert _latest_run(conn)[1:5] == ("ok", 4, 4, 0)


def test_cli_recompute_hazards_exits_0_and_bumps_recomputed_at(conn, dsn, ingested):
    """SIM_SPEC §3.5 test_cli_recompute_hazards: the standalone flag rewrites sim_circuit_hazard from stored rows."""
    before = _one(conn, "SELECT count(*), max(recomputed_at) FROM sim_circuit_hazard")
    assert before[0] >= 1
    assert ingest.main(["--recompute-hazards", "--dsn", dsn]) == 0
    after = _one(conn, "SELECT count(*), max(recomputed_at) FROM sim_circuit_hazard")
    assert after[0] == before[0] and after[1] > before[1]
    assert _one(conn, "SELECT count(*) FROM sim_circuit_hazard WHERE recomputed_at < %s", (after[1],))[0] == 0
