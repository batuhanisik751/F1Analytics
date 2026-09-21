"""WP4 — the ingest side of qualifying (QUALI_SPEC §1, §4.5, §7).

What this file pins, in the order the ingest meets it:

1. `_session_start` matches a session name EXACTLY. "Sprint Qualifying" contains
   "Qualifying" as a substring; an `in`-test hands the Q row the Friday start time and the
   completion check in `_select` then fires a day early (§1.2).
2. `schedule_rows` emits a Q row for every event and an SQ row for every
   `sprint_qualifying` event, on top of the R and S rows v1.5 already produced.
3. `_KIND_RANK` keeps RACES FIRST (D5), and `--only-quali` / `--no-quali` select by it.
4. `messages=True` for Q/SQ only -- R and S stay pinned at False (D4, §0.2/§5.6).
5. The session row a Q/SQ ingest writes: `fastest_pace_driver_id` = classified P1,
   `winner_driver_id` and `total_laps` NULL (§1.1, §4.5).

Everything above the [db] marker runs off the cached FastF1 schedule and needs no database.
"""

from __future__ import annotations

import argparse

import pandas as pd
import pytest

from f1lab import ingest


def _args(**kw) -> argparse.Namespace:
    base = dict(no_sprints=False, no_quali=False, only_quali=False, round=None, force=True, season=2024)
    return argparse.Namespace(**{**base, **kw})


def _rows(*kinds, rnd: int = 1) -> list[dict]:
    import datetime as dt
    old = dt.datetime(2024, 3, 1, tzinfo=dt.timezone.utc)
    return [{"session_id": i, "round": rnd, "kind": k, "start_utc": old, "status": None}
            for i, k in enumerate(kinds)]


# ---------------------------------------------------------------------------
# §1.2 the substring trap
# ---------------------------------------------------------------------------

def test_session_start_matches_the_name_exactly():
    """'Sprint Qualifying' CONTAINS 'Qualifying'. An `in`-test would give the Q row the
    Friday start time; the exact match gives it Saturday's."""
    ev = {
        "Session1": "Practice 1", "Session1DateUtc": "2024-11-01T14:30:00",
        "Session2": "Sprint Qualifying", "Session2DateUtc": "2024-11-01T18:30:00",
        "Session3": "Sprint", "Session3DateUtc": "2024-11-02T14:00:00",
        "Session4": "Qualifying", "Session4DateUtc": "2024-11-02T18:00:00",
        "Session5": "Race", "Session5DateUtc": "2024-11-03T17:00:00",
    }
    assert ingest._session_start(ev, "Qualifying").isoformat() == "2024-11-02T18:00:00+00:00"
    assert ingest._session_start(ev, "Sprint Qualifying").isoformat() == "2024-11-01T18:30:00+00:00"
    assert ingest._session_start(ev, "Sprint").isoformat() == "2024-11-02T14:00:00+00:00"
    assert ingest._sprint_start(ev) == ingest._session_start(ev, "Sprint")
    assert ingest._session_start(ev, "Qualifying") != ingest._session_start(ev, "Sprint Qualifying")
    assert ingest._session_start(ev, "Practice 3") is None


# ---------------------------------------------------------------------------
# §1.2 schedule_rows
# ---------------------------------------------------------------------------

# 24 + 24 + 23 = 71 Q rows and 6 + 6 + 6 = 18 SQ rows -- the counts §1.1's table predicts
# for the backfill.
@pytest.mark.cache
@pytest.mark.parametrize("year, events, sprints", [(2024, 24, 6), (2025, 24, 6), (2026, 23, 6)])
def test_schedule_rows_add_one_q_per_event_and_one_sq_per_sprint_weekend(year, events, sprints):
    """Measured on all three seasons and both event formats: every event has a session named
    exactly `Qualifying`, and every `sprint_qualifying` event also has `Sprint Qualifying`."""
    sched, evs, sessions = ingest.schedule_rows(year)
    assert len(evs) == events
    by_kind: dict[str, list[dict]] = {}
    for s in sessions:
        by_kind.setdefault(s["kind"], []).append(s)
    assert len(by_kind["R"]) == events and len(by_kind["Q"]) == events
    assert len(by_kind["S"]) == sprints and len(by_kind["SQ"]) == sprints
    assert {s["name"] for s in by_kind["Q"]} == {"Qualifying"}
    assert {s["name"] for s in by_kind["SQ"]} == {"Sprint Qualifying"}
    # Every event got its qualifying row, and no round got two of them.
    assert sorted(s["round"] for s in by_kind["Q"]) == sorted(e["round"] for e in evs)
    assert len({s["round"] for s in by_kind["SQ"]}) == sprints
    # The start time is the session's own, never a sibling's (the substring trap, §1.2).
    sq_rounds = {s["round"]: s["start_utc"] for s in by_kind["SQ"]}
    for q in by_kind["Q"]:
        if q["round"] in sq_rounds and q["start_utc"] is not None:
            assert q["start_utc"] != sq_rounds[q["round"]]
            assert q["start_utc"] > sq_rounds[q["round"]]      # Saturday after Friday


@pytest.mark.cache
def test_schedule_rows_leave_the_r_and_s_rows_byte_identical():
    """`upsert_schedule` re-runs over 71 existing races; the R/S rows it writes must not move."""
    _, _, sessions = ingest.schedule_rows(2024)
    rs = [s for s in sessions if s["kind"] in ("R", "S")]
    assert len(rs) == 30
    for s in rs:
        assert s["name"] == ("Race" if s["kind"] == "R" else "Sprint")
        assert s["start_utc"] is not None


# ---------------------------------------------------------------------------
# §1.3 ordering (D5) and the two new flags
# ---------------------------------------------------------------------------

def test_kind_rank_keeps_races_first():
    """D5. Chronological order (SQ, S, Q, R) was proposed and rejected: a half-finished
    backfill under the R-first rule always still has the race data the app depends on."""
    assert ingest._KIND_RANK == {"R": 0, "S": 1, "Q": 2, "SQ": 3}
    got = ingest._select(_rows("SQ", "Q", "S", "R"), _args())
    assert [r["kind"] for r in got] == ["R", "S", "Q", "SQ"]
    # and across rounds, round still wins over kind
    rows = _rows("Q", "R", rnd=2) + _rows("Q", "R", rnd=1)
    got = ingest._select(rows, _args())
    assert [(r["round"], r["kind"]) for r in got] == [(1, "R"), (1, "Q"), (2, "R"), (2, "Q")]


def test_only_quali_and_no_quali_are_symmetric_with_no_sprints():
    rows = _rows("R", "S", "Q", "SQ")
    assert [r["kind"] for r in ingest._select(rows, _args())] == ["R", "S", "Q", "SQ"]
    assert [r["kind"] for r in ingest._select(rows, _args(only_quali=True))] == ["Q", "SQ"]
    assert [r["kind"] for r in ingest._select(rows, _args(no_quali=True))] == ["R", "S"]
    assert [r["kind"] for r in ingest._select(rows, _args(no_sprints=True))] == ["R", "Q", "SQ"]
    assert ingest._select(rows, _args(no_quali=True, only_quali=True)) == []
    # --round keeps its meaning of "every session of this round", now up to four of them.
    assert [r["kind"] for r in ingest._select(rows, _args(round=1))] == ["R", "S", "Q", "SQ"]
    assert [r["kind"] for r in ingest._select(rows, _args(round=1, only_quali=True))] == ["Q", "SQ"]


def test_the_flags_reach_the_parser_and_the_run_record():
    a = ingest.build_parser().parse_args(["--season", "2024", "--only-quali"])
    assert a.only_quali and not a.no_quali
    assert ingest.cli_args_json(a)["only_quali"] is True and ingest.cli_args_json(a)["quali"] is True
    b = ingest.build_parser().parse_args(["--season", "2024", "--no-quali"])
    assert b.no_quali and not b.only_quali and ingest.cli_args_json(b)["quali"] is False


# ---------------------------------------------------------------------------
# §1.4 / D4 — the load flag, and the three-way dispatch
# ---------------------------------------------------------------------------

class _FakeQuali:
    results = pd.DataFrame({"Abbreviation": ["NOR"], "Q1": [pd.Timedelta(seconds=71.4)]})
    laps = pd.DataFrame({"LapNumber": [1.0]})


class _FakeRace:
    results = pd.DataFrame({"Abbreviation": ["NOR"]})
    laps = pd.DataFrame({"LapNumber": [1.0]})


def test_messages_is_true_for_quali_and_pinned_false_for_race_and_sprint(monkeypatch):
    """D4 and §5.6. Flipping `messages` on for R would re-activate `excl_deleted` on 71 races
    -- measured TRUE on 0 of 69,548 rows today -- and move the representative lap set under
    `pace_ranking`, `degradation_fits`, `teammate_deltas` and every Mode 2 fit. It is pinned
    here so v1.6 cannot change it by accident."""
    seen: dict[str, object] = {}

    def load(year, gp, session="R", cache=None, *, messages=False):
        seen[session] = messages
        return _FakeQuali() if session in ("Q", "SQ") else _FakeRace()

    monkeypatch.setattr(ingest.clean, "load_race", load)
    monkeypatch.setattr(ingest.clean, "clean_quali",
                        lambda s, results=None: (pd.DataFrame({"is_representative": [True]}), {"ok": True}))
    for kind in ("R", "S", "Q", "SQ"):
        ingest.load_with_retry(2024, 1, kind, None)
    assert seen == {"R": False, "S": False, "Q": True, "SQ": True}
    # ...and the default on the function itself is False, so an unkeyworded call is race-safe.
    import inspect
    assert inspect.signature(ingest.clean.load_race).parameters["messages"].default is False


def test_build_frames_for_dispatches_three_ways(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(ingest.frames, "build_race_frames", lambda s, i, a: calls.append("race"))
    monkeypatch.setattr(ingest.frames, "build_sprint_frames", lambda s, i: calls.append("sprint"))
    monkeypatch.setattr(ingest.frames, "build_quali_frames",
                        lambda s, i, a, kind=None, cleaned=None: calls.append(f"quali:{kind}"))
    for kind in ("R", "S", "Q", "SQ"):
        ingest.build_frames_for(_FakeRace(), {"kind": kind}, None, 1)
    assert calls == ["race", "sprint", "quali:Q", "quali:SQ"]


def test_build_frames_for_hands_the_cleaning_forward(monkeypatch):
    """`_check_loaded` already ran `clean_quali` (it is the D8 gate and the representative-lap
    check); the frames builder must reuse that tuple, not clean the session a second time."""
    cleaned = (pd.DataFrame({"is_representative": [True]}), {"ok": True})
    s = _FakeQuali()
    s._f1lab_cleaned = cleaned
    got: dict = {}
    monkeypatch.setattr(ingest.frames, "build_quali_frames",
                        lambda ses, i, a, kind=None, cleaned=None: got.update(kind=kind, cleaned=cleaned))
    ingest.build_frames_for(s, {"kind": "SQ"}, None, 1)
    assert got["kind"] == "SQ" and got["cleaned"] is cleaned


# ---------------------------------------------------------------------------
# §2.1.1 identity, and FastF1's non-entry rows
# ---------------------------------------------------------------------------

class _Session:
    def __init__(self, results, laps=None):
        self._results = results
        self._laps = laps if laps is not None else pd.DataFrame(
            columns=["Driver", "LapTime", "PitOutTime", "PitInTime"])

    @property
    def results(self):
        return self._results

    @property
    def laps(self):
        return self._laps


def _res(rows):
    cols = ["Abbreviation", "DriverId", "TeamName", "TeamId", "Position", "Q1", "Q2", "Q3"]
    return pd.DataFrame([dict(zip(cols, r)) for r in rows], columns=cols)


def test_identity_from_skips_the_string_nan_and_keeps_the_first_non_null():
    """`frames.identity_maps` filters on `.strip()`, and FastF1 spells a missing id 'nan' --
    which survives a strip, becomes NULL in `cast_frame`, and violates NOT NULL two steps
    later. The first non-null per key wins, so one driver's missing TeamId cannot erase their
    team-mate's (2025 R21 Q: HUL has 'sauber', BOR has 'nan', both are 'Kick Sauber')."""
    res = _res([("HUL", "hulkenberg", "Kick Sauber", "sauber", 10.0, pd.NaT, pd.NaT, pd.NaT),
                ("BOR", "nan", "Kick Sauber", "nan", float("nan"), pd.NaT, pd.NaT, pd.NaT)])
    d, t = ingest.identity_from(res)
    assert d == {"HUL": "hulkenberg"} and t == {"Kick Sauber": "sauber"}
    assert ingest._unresolved(res, d, t) == (["BOR"], [])


def test_drop_non_entries_drops_the_empty_row_and_its_out_and_in_laps():
    """2025 R21 Q BOR, 2026 R02 SQ PER, 2026 R05 SQ ALB/LAW: no id, no team id, no position,
    no time, no lap. 2026 R01 Q VER and 2026 R14 Q STR are the same row with one out-lap and
    one in-lap, which go with it."""
    res = _res([("HUL", "hulkenberg", "Kick Sauber", "sauber", 10.0, pd.Timedelta(seconds=71), pd.NaT, pd.NaT),
                ("VER", "nan", "Red Bull Racing", "nan", float("nan"), pd.NaT, pd.NaT, pd.NaT)])
    laps = pd.DataFrame({
        "Driver": ["HUL", "VER", "VER"],
        "LapTime": [pd.Timedelta(seconds=71), pd.Timedelta(seconds=102), pd.NaT],
        "PitOutTime": [pd.NaT, pd.Timedelta(seconds=1), pd.NaT],
        "PitInTime": [pd.NaT, pd.NaT, pd.Timedelta(seconds=9)],
    })
    s = _Session(res, laps)
    assert ingest.drop_non_entries(s) == ["VER"]
    assert list(s.results["Abbreviation"]) == ["HUL"]
    assert list(s.laps["Driver"]) == ["HUL"]


def test_drop_non_entries_keeps_a_driver_who_set_a_flying_lap():
    """The line this function will not cross. A flying lap is real timing data; §3.3's
    `position integer NOT NULL` then has nowhere to put the driver, and the session must fail
    loudly instead of having the defect papered over here."""
    res = _res([("HUL", "hulkenberg", "Kick Sauber", "sauber", 10.0, pd.Timedelta(seconds=71), pd.NaT, pd.NaT),
                ("VER", "nan", "Red Bull Racing", "nan", float("nan"), pd.NaT, pd.NaT, pd.NaT)])
    laps = pd.DataFrame({"Driver": ["VER"], "LapTime": [pd.Timedelta(seconds=89)],
                         "PitOutTime": [pd.NaT], "PitInTime": [pd.NaT]})
    s = _Session(res, laps)
    assert ingest.drop_non_entries(s) == []
    assert len(s.results) == 2


def test_session_ids_for_fills_identity_from_a_sibling_and_refuses_to_write_null(monkeypatch):
    """§2.1.1's fallback, generalised: EVERY cached SQ session has blank ids, and 2025/2026
    turned up Q sessions with one driver's id missing. Both are filled from the weekend's
    populated sibling; anything still unresolved raises rather than writing a NULL id."""
    quali = _res([("HUL", "", "Kick Sauber", "", 10.0, pd.Timedelta(seconds=71), pd.NaT, pd.NaT)])
    race = _res([("HUL", "hulkenberg", "Kick Sauber", "sauber", 1.0, pd.NaT, pd.NaT, pd.NaT)])
    got = {}
    monkeypatch.setattr(ingest.clean, "load_race",
                        lambda y, r, k, cache=None, *, messages=False: _Session(race))
    monkeypatch.setattr(ingest.frames, "make_session_ids",
                        lambda s, sid, driver_ids=None, team_ids=None: got.update(
                            d=driver_ids, t=team_ids) or "IDS")
    assert ingest.session_ids_for(_Session(quali), "SQ", 2025, 2, 7, None) == "IDS"
    assert got["d"] == {"HUL": "hulkenberg"} and got["t"] == {"Kick Sauber": "sauber"}
    # Nothing anywhere can supply it -> a readable failure, never a NULL driver_id.
    monkeypatch.setattr(ingest.clean, "load_race",
                        lambda y, r, k, cache=None, *, messages=False: _Session(_res([])))
    with pytest.raises(ingest.DataNotAvailable, match=r"no DriverId for \['HUL'\]"):
        ingest.session_ids_for(_Session(quali), "Q", 2025, 2, 7, None)


# ---------------------------------------------------------------------------
# [db] What the backfill actually wrote (§1.1, §4.5, D8)
# ---------------------------------------------------------------------------

db = pytest.mark.db


@pytest.fixture(scope="module")
def conn(dsn):
    from f1lab import db as _db
    c = _db.connect(dsn)
    try:
        yield c
    finally:
        c.close()


def _q(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    conn.rollback()
    return rows


@db
def test_the_backfill_wrote_71_q_and_18_sq_sessions(conn):
    """§1.1's table, made falsifiable. 2026 rounds 15-23 are unraced, so they have a `sessions`
    row and no ingest -- the counts here are of SESSIONS, not of ingests."""
    assert dict(_q(conn, "SELECT kind, count(*) FROM sessions GROUP BY kind")) == \
        {"R": 71, "S": 18, "Q": 71, "SQ": 18}


@db
def test_quali_sessions_have_a_pole_sitter_no_winner_and_no_total_laps(conn):
    """§1.1 / §4.5: `fastest_pace_driver_id` is the CLASSIFIED P1 -- a definitional choice, not
    a measurement -- while `winner_driver_id` and `total_laps` stay NULL."""
    bad = _q(conn, """
        SELECT s.session_id, s.kind, s.winner_driver_id, s.total_laps
        FROM sessions s JOIN session_ingests si USING (session_id)
        WHERE s.kind IN ('Q','SQ') AND si.status <> 'failed'
          AND (s.winner_driver_id IS NOT NULL OR s.total_laps IS NOT NULL)""")
    assert bad == [], bad
    mismatched = _q(conn, """
        SELECT s.session_id, s.fastest_pace_driver_id, q.driver_id
        FROM sessions s
        JOIN session_ingests si USING (session_id)
        LEFT JOIN quali_results q ON q.session_id = s.session_id AND q.position = 1
        WHERE s.kind IN ('Q','SQ') AND si.status <> 'failed'
          AND s.fastest_pace_driver_id IS DISTINCT FROM q.driver_id""")
    assert mismatched == [], mismatched


@db
def test_a_pole_sitter_without_a_time_is_impossible(conn):
    assert _q(conn, "SELECT s.kind, count(*) FROM quali_results q JOIN sessions s USING (session_id) "
                    "WHERE q.position = 1 AND q.best_s IS NULL GROUP BY 1") == []


@db
def test_times_source_is_api_for_q_and_derived_for_sq(conn):
    """§5.2: Q's segment times come from the timing API; SQ's are computed by FastF1 from the
    laps plus race-control messages. Nothing branches on it -- it is stored so a future
    discrepancy is diagnosable in one query instead of a day."""
    got = {(k, src) for k, src, _ in
           _q(conn, "SELECT s.kind, q.times_source, count(*) FROM quali_results q "
                    "JOIN sessions s USING (session_id) GROUP BY 1,2")}
    assert got == {("Q", "api"), ("SQ", "derived")}


@db
def test_the_race_side_did_not_move(conn):
    """The whole point of `--only-quali`. `laps.deleted` is still FALSE on every race lap
    (§0.4 note 9: measured TRUE on 0 of 69,548 rows, and v1.6 does NOT fix it -- §5.6), and no
    race or sprint lap carries a qualifying column."""
    assert _q(conn, "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
                    "WHERE s.kind IN ('R','S') AND l.deleted")[0][0] == 0
    assert _q(conn, "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
                    "WHERE s.kind IN ('R','S') AND (l.quali_segment IS NOT NULL "
                    "OR l.segment_source IS NOT NULL OR l.is_push_lap IS NOT NULL)")[0][0] == 0
    # `quali_segment IS NOT NULL` is a one-sided kind test: every lap carrying one is a
    # qualifying lap (asserted above), but NOT every qualifying lap carries one -- 2,847 of
    # 23,415 sit outside all three Started->Finished windows (in the pit lane between
    # segments, or after the chequered flag) and keep a NULL segment. `is_push_lap` is the
    # column that is non-NULL on every Q/SQ lap and NULL on every R/S lap.
    assert _q(conn, "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
                    "WHERE s.kind IN ('Q','SQ') AND l.is_push_lap IS NULL")[0][0] == 0
    with_seg, without = _q(conn, "SELECT count(*) FILTER (WHERE quali_segment IS NOT NULL), "
                                 "count(*) FILTER (WHERE quali_segment IS NULL) FROM laps l "
                                 "JOIN sessions s USING (session_id) WHERE s.kind IN ('Q','SQ')")[0]
    assert with_seg > 0 and without > 0 and with_seg > without


@db
def test_the_runtime_gate_left_no_half_written_session(conn):
    """D8. A session whose per-segment tables were suppressed is 'partial', and a session that
    is NOT partial has all three qualifying tables populated -- never a `quali_results` row
    with an empty `quali_segment_times` beside it."""
    bad = _q(conn, """
        SELECT s.session_id, si.status,
               (SELECT count(*) FROM quali_results r WHERE r.session_id = s.session_id),
               (SELECT count(*) FROM quali_segment_times t WHERE t.session_id = s.session_id),
               (SELECT count(*) FROM quali_teammate_h2h h WHERE h.session_id = s.session_id)
        FROM sessions s JOIN session_ingests si USING (session_id)
        WHERE s.kind IN ('Q','SQ') AND si.status = 'ok'""")
    assert bad and all(r[2] > 0 and r[3] > 0 and r[4] > 0 for r in bad), \
        [r for r in bad if not (r[2] > 0 and r[3] > 0 and r[4] > 0)]
    # Every Q/SQ ingest records the gate's verdict, whichever way it went.
    missing = _q(conn, """
        SELECT s.session_id FROM sessions s JOIN session_ingests si USING (session_id)
        WHERE s.kind IN ('Q','SQ') AND si.status <> 'failed'
          AND NOT EXISTS (SELECT 1 FROM unnest(si.warnings) w WHERE w LIKE 'quali_anchor_pre=%%')""")
    assert missing == [], missing
