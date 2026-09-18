"""``python -m f1lab.ingest`` — load sessions from FastF1, compute everything, write Postgres.

    python -m f1lab.ingest --season 2025                     # every completed session not yet 'ok'
    python -m f1lab.ingest --season 2025 --round 13          # one round (up to four sessions), regardless of status
    python -m f1lab.ingest --season 2025 --force             # re-ingest every completed session
    python -m f1lab.ingest --season 2025 --no-sprints        # skip kind='S' sessions
    python -m f1lab.ingest --season 2025 --no-quali          # skip kind IN ('Q','SQ')
    python -m f1lab.ingest --season 2024 --only-quali        # ONLY kind IN ('Q','SQ') (the v1.6 backfill)
    python -m f1lab.ingest --season 2026 --dry-run           # load + compute, print row counts, write nothing
    python -m f1lab.ingest --season 2025 --recompute-season  # only season.recompute from stored rows
    python -m f1lab.ingest --check-schema                    # exit 0 if the live schema matches, else 1
    python -m f1lab.ingest --season 2025 --fail-fast         # stop at the first failed session

Exit codes: 0 every attempted session ok; 1 some failed; 2 aborted (rate limit / schema).
Logging goes to stderr, one line per session with counts and elapsed time.

Per session the algorithm is (§2.5): load from cache/network with backoff → upsert the
dimension rows (teams, drivers, circuits, events.circuit_key) in a short committed
transaction → build every frame in memory → in ONE transaction delete every child row of
the session, COPY the new rows in FK order, update the ``sessions`` row and record the
``session_ingests`` row. Every such transaction is COMMITTED when its block exits (see
``_committed``), so a session that fails, a ``--fail-fast`` stop, a rate-limit abort or a
Ctrl-C never discards a session written earlier in the same run, and the next run resumes
from what is stored. A crash mid-way leaves the previous good data intact.

Qualifying (``kind`` in ``('Q','SQ')``, QUALI_SPEC §1) rides the same machinery with three
differences: the load turns race-control messages ON (D4 -- ``R`` and ``S`` stay pinned at
OFF, §5.6); the cleaning runs inside ``_check_loaded``, both as the "at least one
representative lap" test and as D8's runtime anchor gate, and is handed forward so the
session is cleaned once; and ``write_session`` leaves ``winner_driver_id`` and
``total_laps`` NULL while setting ``fastest_pace_driver_id`` to the classified P1 (§4.5).
When the gate fails, ``build_quali_frames`` writes the laps and the official times and
omits the two per-segment tables, so the session lands 'partial' rather than silently
storing a mis-assigned segment.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import platform
import socket
import sys
import time
import traceback
from pathlib import Path

import fastf1
import pandas as pd
from psycopg.pq import TransactionStatus

from . import __version__, assumptions, clean, companion, db, frames, season, sim, telemetry  # v1.7 §2.8
from .frames import Frames, SessionIds

log = logging.getLogger("f1lab.ingest")

COMPLETED_MARGIN = dt.timedelta(hours=6)

# QUALI_SPEC §1.3 (D5). Races keep going FIRST: a re-ingest of an existing season produces
# byte-identical ordering to v1.5 and the log diff is purely additive, and a half-finished
# backfill always still has the race data the rest of the app depends on. Chronological
# order (SQ, S, Q, R) was proposed and rejected -- ingest is per-session transactional and
# idempotent and nothing in build_*_frames reads another session.
_KIND_RANK = {"R": 0, "S": 1, "Q": 2, "SQ": 3}
QUALI_KINDS = ("Q", "SQ")
LOAD_BACKOFF_S = (10, 30, 90)

# Exceptions worth retrying a FastF1 load on. Anything else (data not available, parse
# errors) is recorded as a failed session and retried on the next run.
try:  # requests is a FastF1 dependency
    from requests.exceptions import RequestException as _RequestException
except Exception:  # pragma: no cover
    _RequestException = ()  # type: ignore[assignment]
RETRYABLE = (ConnectionError, TimeoutError, OSError, _RequestException)

RateLimitExceededError = fastf1.req.RateLimitExceededError


class Abort(Exception):
    """Stop the run (exit 2): rate limit or schema mismatch."""


def _committed(conn):
    """A ``conn.transaction()`` block that really COMMITs on exit.

    The connection is ``autocommit=False`` (§2.4): the first statement after a commit —
    even a plain SELECT — opens an implicit transaction that stays open until the
    connection commits or rolls back, and inside it ``conn.transaction()`` is only a
    SAVEPOINT, so nothing reaches the database and a later ``rollback()`` (or a crash)
    discards every "committed" block since. Every write in this module must be durable on
    its own (§2.5: the failed-session row "in its own transaction", "a crash
    mid-transaction leaves the previous good data intact"), so a block is entered from
    IDLE: an implicit transaction still open from a read is ended first. This module never
    leaves writes pending outside a block, so the rollback can only end a read.
    """
    if conn.info.transaction_status != TransactionStatus.IDLE:
        conn.rollback()
    return conn.transaction()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m f1lab.ingest", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("--season", type=int, help="season year to ingest (required unless --check-schema)")
    p.add_argument("--round", type=int,
                   help="one round only (every session of it: R, S, Q, SQ); re-ingested regardless of status")
    p.add_argument("--force", action="store_true", help="re-ingest every completed session of the season")
    p.add_argument("--no-sprints", action="store_true", help="skip kind='S' sessions")
    p.add_argument("--no-quali", action="store_true", help="skip kind IN ('Q','SQ') sessions")
    p.add_argument("--only-quali", action="store_true",
                   help="ingest ONLY kind IN ('Q','SQ') sessions (the v1.6 backfill flag: adds the new "
                        "sessions without re-reading a single race)")
    p.add_argument("--dry-run", action="store_true",
                   help="load + compute, print per-table row counts, write nothing (no database needed)")
    p.add_argument("--recompute-season", action="store_true",
                   help="only season.recompute(year) from stored rows; no FastF1 loads")
    p.add_argument("--recompute-hazards", action="store_true",
                   help="only sim.recompute_hazards from stored rows (all circuits); no FastF1 loads, no --season")
    p.add_argument("--recompute-companion", nargs="?", const="all", default=None, metavar="STEPS",
                   help="only companion.recompute_companion from stored rows; STEPS is a comma list "
                        "from {winprob,odi,preview,mode2,report,all} (default all); no FastF1 loads, no --season")
    # MODE3_SPEC §4.5 — reports are idempotent on `grounding_sha256`, so `--force` regenerates
    # ZERO reports when the numbers are unchanged. This is the SEPARATE flag for a prompt or
    # model change: it bypasses the hash and re-calls the model for every race, which costs
    # real money. It is not implied by --force and never will be.
    p.add_argument("--regen-reports", action="store_true",
                   help="regenerate every race report even when its grounding hash is unchanged "
                        "(MODE3_SPEC §4.5: for a prompt change; makes one API call per race)")
    p.add_argument("--check-schema", action="store_true", help="exit 0 if assert_schema passes, else 1")
    p.add_argument("--fail-fast", action="store_true", help="stop at the first failed session")
    p.add_argument("--dsn", default=None, help="Postgres URL (default: env DATABASE_URL, then the docker default)")
    p.add_argument("--cache", default=None, help=f"FastF1 cache directory (default {clean.DEFAULT_CACHE})")
    p.add_argument("--sleep", type=float, default=2.0, help="seconds to sleep between FastF1 loads (default 2)")
    return p


def cli_args_json(a: argparse.Namespace) -> dict:
    return {
        "season": a.season, "round": a.round, "force": bool(a.force), "sprints": not a.no_sprints,
        "quali": not a.no_quali, "only_quali": bool(a.only_quali),
        "dry_run": bool(a.dry_run), "recompute_season": bool(a.recompute_season),
        "recompute_hazards": bool(a.recompute_hazards),
        "recompute_companion": a.recompute_companion,
        "regen_reports": bool(a.regen_reports),
        "fail_fast": bool(a.fail_fast), "sleep": a.sleep, "cache": str(a.cache) if a.cache else None,
    }


# ---------------------------------------------------------------------------
# Schedule -> seasons / events / sessions rows
# ---------------------------------------------------------------------------

def _utc(ts) -> dt.datetime | None:
    if ts is None or pd.isna(ts):
        return None
    ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert("UTC").to_pydatetime()


def _session_start(ev, name: str) -> dt.datetime | None:
    """The UTC start of the session named exactly ``name``, or None (QUALI_SPEC §1.2).

    EXACT match, never ``in``: ``"Sprint Qualifying"`` CONTAINS ``"Qualifying"`` as a
    substring, so an ``in``-test hands the Q row the Friday start time and ``_select``'s
    completion check then fires a day early.
    """
    for n in range(1, 6):
        if str(ev.get(f"Session{n}", "")) == name:
            return _utc(ev.get(f"Session{n}DateUtc"))
    return None


def _sprint_start(ev) -> dt.datetime | None:
    return _session_start(ev, "Sprint")


def schedule_rows(year: int) -> tuple[pd.DataFrame, list[dict], list[dict]]:
    """(schedule, events rows, sessions rows) from fastf1.get_event_schedule."""
    sched = fastf1.get_event_schedule(year, include_testing=False)
    events, sessions = [], []
    for _, ev in sched.iterrows():
        rnd = int(ev["RoundNumber"])
        events.append({
            "year": year, "round": rnd, "event_name": str(ev["EventName"]),
            "official_name": str(ev["OfficialEventName"]), "location": str(ev["Location"]),
            "country": str(ev["Country"]), "event_format": str(ev["EventFormat"]),
            "event_date": pd.Timestamp(ev["EventDate"]).date(),
        })
        sessions.append({"year": year, "round": rnd, "kind": "R", "name": "Race",
                         "start_utc": _utc(ev.get("Session5DateUtc"))})
        if str(ev["EventFormat"]) == "sprint_qualifying":
            sessions.append({"year": year, "round": rnd, "kind": "S", "name": "Sprint",
                             "start_utc": _sprint_start(ev)})
        # QUALI_SPEC §1.2: measured on 2024/2025/2026 and both event formats, every event
        # carries a session named exactly "Qualifying", and every sprint_qualifying event
        # also carries one named exactly "Sprint Qualifying".
        sessions.append({"year": year, "round": rnd, "kind": "Q", "name": "Qualifying",
                         "start_utc": _session_start(ev, "Qualifying")})
        if str(ev["EventFormat"]) == "sprint_qualifying":
            sessions.append({"year": year, "round": rnd, "kind": "SQ", "name": "Sprint Qualifying",
                             "start_utc": _session_start(ev, "Sprint Qualifying")})
    return sched, events, sessions


def upsert_schedule(conn, year: int) -> tuple[pd.DataFrame, list[dict]]:
    sched, events, sessions = schedule_rows(year)
    with _committed(conn):
        with conn.cursor() as cur:
            db.upsert_rows(cur, "seasons", ["year", "scheduled_rounds"], ["year"],
                           [(year, len(sched))], ["scheduled_rounds"])
            ev_cols = ["year", "round", "event_name", "official_name", "location", "country", "event_format",
                       "event_date"]
            db.upsert_rows(cur, "events", ev_cols, ["year", "round"],
                           [tuple(e[c] for c in ev_cols) for e in events],
                           [c for c in ev_cols if c not in ("year", "round")])   # never touches circuit_key
            s_cols = ["year", "round", "kind", "name", "start_utc"]
            db.upsert_rows(cur, "sessions", s_cols, ["year", "round", "kind"],
                           [tuple(s[c] for c in s_cols) for s in sessions], ["name", "start_utc"])
    return sched, sessions


def sessions_to_do(conn, a: argparse.Namespace) -> list[dict]:
    """Rows of ``sessions`` (+ ingest status) selected by the CLI flags, ordered round asc, R before S."""
    with _committed(conn):   # a read, but it must not leave a transaction open behind it
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.session_id, s.round, s.kind, s.start_utc, si.status
                FROM sessions s LEFT JOIN session_ingests si ON si.session_id = s.session_id
                WHERE s.year = %s ORDER BY s.round, s.kind""", (a.season,))
            rows = [dict(zip(("session_id", "round", "kind", "start_utc", "status"), r)) for r in cur.fetchall()]
    return _select(rows, a)


def _select(rows: list[dict], a: argparse.Namespace) -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for r in rows:
        if a.no_sprints and r["kind"] == "S":
            continue
        if getattr(a, "no_quali", False) and r["kind"] in QUALI_KINDS:
            continue
        if getattr(a, "only_quali", False) and r["kind"] not in QUALI_KINDS:
            continue
        if a.round is not None:
            if r["round"] == a.round:
                out.append(r)
            continue
        start = r["start_utc"]
        if start is None:
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=dt.timezone.utc)
        completed = start + COMPLETED_MARGIN < now
        if completed and (a.force or r.get("status") != "ok"):
            out.append(r)
    return sorted(out, key=lambda r: (r["round"], _KIND_RANK.get(r["kind"], 9)))


# ---------------------------------------------------------------------------
# Per-session steps
# ---------------------------------------------------------------------------

class DataNotAvailable(RuntimeError):
    """FastF1 loaded a session without timing data (not run yet, or the API has nothing for it)."""


# The sessions of the same weekend whose `results` carry a usable DriverId / TeamId, in the
# order they are consulted. QUALI_SPEC §2.1.1 names exactly this fallback: "a sibling session
# of the same weekend (the Q, S or R session, all of which are populated)".
_IDENTITY_SIBLINGS = {"Q": ("R", "S"), "SQ": ("Q", "R", "S")}


def identity_from(results) -> tuple[dict[str, str], dict[str, str]]:
    """``({code: driver_id}, {team_name: team_id})``, skipping every null-ish id.

    Not ``frames.identity_maps``: that one filters on ``.strip()``, and FastF1 spells a
    missing id as the four-character string ``'None'`` or ``'nan'``, both of which survive a
    strip and then become NULL in ``cast_frame`` — a NOT NULL violation two steps later
    instead of a readable error here. It also takes the FIRST non-null value per key, so one
    driver's missing TeamId cannot erase their team-mate's.
    """
    d: dict[str, str] = {}
    t: dict[str, str] = {}
    for r in results.itertuples(index=False):
        if not frames._is_null(r.DriverId):
            d.setdefault(str(r.Abbreviation), str(r.DriverId))
        if not frames._is_null(r.TeamId):
            t.setdefault(str(r.TeamName), str(r.TeamId))
    return d, t


def _unresolved(results, d: dict, t: dict) -> tuple[list[str], list[str]]:
    miss_d = sorted({str(r.Abbreviation) for r in results.itertuples(index=False)
                     if str(r.Abbreviation) not in d})
    miss_t = sorted({str(r.TeamName) for r in results.itertuples(index=False)
                     if str(r.TeamName) not in t})
    return miss_d, miss_t


def _n_official_q1(res) -> int:
    """Non-null ``Q1`` values in a qualifying results frame (0 when the column is absent)."""
    if "Q1" not in getattr(res, "columns", ()):
        return 0
    return int(res["Q1"].notna().sum())


def _check_loaded(s, year: int, rnd: int, kind: str):
    """FastF1's ``Session.load`` swallows every per-endpoint failure for a session that has not
    happened yet and hands back an object whose properties raise ``DataNotLoadedError`` on first
    access. Turn that into one clear, non-retryable error so the session is recorded as 'failed'
    with a readable reason and picked up again on the next run (§2.5)."""
    needs_laps = kind == "R" or kind in QUALI_KINDS
    try:
        n_results = len(s.results)
        n_laps = len(s.laps) if needs_laps else None
        n_times = _n_official_q1(s.results) if kind in QUALI_KINDS else None
    except Exception as e:  # noqa: BLE001  (fastf1.exceptions.DataNotLoadedError and friends)
        raise DataNotAvailable(
            f"no timing data available for {year} R{rnd:02d} {kind} ({type(e).__name__}: "
            f"session not run yet, or the live-timing API has nothing for it)") from e
    if n_results == 0 or (needs_laps and n_laps == 0):
        raise DataNotAvailable(f"no timing data available for {year} R{rnd:02d} {kind} "
                               f"(results rows={n_results}, laps={n_laps})")
    # QUALI_SPEC §7 WP4: SQ is held to the SAME standard as Q. With messages=True it publishes
    # the same payload (§5.2), so an SQ session that came back with an all-NaT Q1 -- the exact
    # artifact messages=False produces -- must FAIL rather than store a husk of 20 driver rows
    # with no times in them.
    if kind in QUALI_KINDS and not n_times:
        raise DataNotAvailable(f"no timing data available for {year} R{rnd:02d} {kind} "
                               f"(results rows={n_results}, laps={n_laps}, non-null Q1 times=0)")
    if kind in QUALI_KINDS:
        s._f1lab_dropped = drop_non_entries(s)
        if s._f1lab_dropped:
            log.info("%d R%02d %s: dropped %d results row(s) that are not a session entry: %s",
                     year, rnd, kind, len(s._f1lab_dropped), ",".join(s._f1lab_dropped))
        # ...and at least one REPRESENTATIVE lap. The cleaning is the only way to know, so it
        # runs once here and is handed to `build_quali_frames(cleaned=...)` rather than being
        # repeated; `clean.clean_quali` is also the D8 runtime gate, whose verdict travels on
        # the same tuple.
        laps_df, diag = clean.clean_quali(s)
        n_repr = int(laps_df["is_representative"].sum()) if len(laps_df) else 0
        if n_repr == 0:
            raise DataNotAvailable(f"no timing data available for {year} R{rnd:02d} {kind} "
                                   f"(results rows={n_results}, laps={n_laps}, representative laps=0)")
        s._f1lab_cleaned = (laps_df, diag)
    return s


def drop_non_entries(s) -> list[str]:
    """Remove FastF1 ``results`` rows that are not a session entry at all. Returns the codes.

    Measured across the 79 cached qualifying sessions, FastF1 returns rows carrying **nothing**:
    no ``DriverId``, no ``TeamId``, no ``Position``, no ``Q1/Q2/Q3`` and no flying lap —
    2025 R21 Q BOR, 2026 R01 Q STR/VER/SAI, 2026 R02 SQ PER, 2026 R05 SQ ALB/LAW and
    2026 R14 Q STR/BEA: nine rows across five sessions. Stored verbatim they become a
    ``session_entries`` row with a NULL ``driver_id`` and a ``quali_results`` row with a NULL
    ``position``, both NOT NULL. They are dropped here, at the boundary, because a driver who
    ran no lap and set no time did not take part.

    A driver who set a FLYING lap is never dropped, even when FastF1 classifies them nowhere:
    that is real timing data, and QUALI_SPEC §3.3's ``position integer NOT NULL`` (commented
    "always present (Q and SQ)" — measured on 2024 only) then has nowhere to put them, so the
    session fails loudly rather than having the defect papered over here. What IS dropped with
    the row is the empty driver's out-laps and in-laps: 2026 R01 Q VER and 2026 R14 Q STR each
    have exactly one out-lap and one in-lap, no flying lap, no id and no classification. Those
    four rows are excluded by §2.3 anyway (`excl_outlap` / `excl_inlap`, never representative),
    so the cost of dropping them is four raw rows and the benefit is two whole sessions.
    """
    res = s.results
    if not {"DriverId", "TeamId", "Position"} <= set(res.columns):
        return []
    keep, dropped = [], []
    for i, r in zip(res.index, res.itertuples(index=False)):
        code = str(r.Abbreviation)
        empty = (frames._is_null(r.DriverId) and frames._is_null(r.TeamId)
                 and pd.isna(r.Position)
                 and all(pd.isna(getattr(r, q, pd.NaT)) for q in ("Q1", "Q2", "Q3")))
        if empty and not _has_flying_lap(s.laps, code):
            dropped.append(code)
        else:
            keep.append(i)
    if dropped and keep:
        s._results = res.loc[keep].copy()
        if "Driver" in s.laps.columns:
            s._laps = s.laps[~s.laps["Driver"].astype(str).isin(dropped)]
    return dropped


def _has_flying_lap(laps, code: str) -> bool:
    """True if this driver has a lap that is neither an out-lap nor an in-lap and carries a time."""
    if "Driver" not in getattr(laps, "columns", ()):
        return False
    mine = laps[laps["Driver"].astype(str) == code]
    if not len(mine):
        return False
    flying = mine["LapTime"].notna() & mine["PitOutTime"].isna() & mine["PitInTime"].isna()
    return bool(flying.any())


def cleaned_quali(s) -> tuple | None:
    """The ``(laps, diagnostics)`` tuple ``_check_loaded`` already computed, or None."""
    return getattr(s, "_f1lab_cleaned", None)


def load_with_retry(year: int, rnd: int, kind: str, cache: str | Path | None):
    last: Exception | None = None
    for attempt, backoff in enumerate(LOAD_BACKOFF_S, start=1):
        try:
            # D4/§1.4: race-control messages ON for Q/SQ only. R and S stay pinned at False in
            # this release -- turning them on would re-activate `excl_deleted` on 71 races and
            # move the representative lap set under every existing model (§0.2, §5.6).
            s = clean.load_race(year, rnd, kind, cache=cache, messages=(kind in QUALI_KINDS))
            return _check_loaded(s, year, rnd, kind)
        except (RateLimitExceededError, DataNotAvailable):
            raise
        except RETRYABLE as e:  # noqa: PERF203
            last = e
            log.warning("load %s R%02d %s attempt %d failed (%s: %s); retrying in %ds",
                        year, rnd, kind, attempt, type(e).__name__, e, backoff)
            time.sleep(backoff)
    assert last is not None
    raise last


def session_ids_for(s, kind: str, year: int, rnd: int, session_id: int, cache) -> SessionIds:
    """``frames.make_session_ids`` with QUALI_SPEC §2.1.1's sibling fallback, generalised.

    Two measured cases need it, and both are cache reads, not network:

    - Every cached SPRINT QUALIFYING session leaves ``results.DriverId`` and ``results.TeamId``
      blank for all 20-22 drivers. The weekend's Q session supplies them.
    - Some Q sessions leave ONE driver's ids missing, spelled ``'nan'`` rather than blank, so
      ``make_session_ids`` does not raise and a NULL reaches a NOT NULL column instead:
      2025 R21 Q (BOR), 2026 R01 Q (STR/VER/SAI), 2026 R14 Q (STR/BEA). The weekend's RACE
      session supplies every one of them.

    Siblings only ever FILL gaps -- this session's own non-null ids always win -- and anything
    still unresolved is a hard failure, never a NULL id.
    """
    if kind not in QUALI_KINDS:
        return frames.make_session_ids(s, session_id)
    d, t = identity_from(s.results)
    for sib in _IDENTITY_SIBLINGS[kind]:
        if not any(_unresolved(s.results, d, t)):
            break
        try:
            other = clean.load_race(year, rnd, sib, cache=cache, messages=(sib in QUALI_KINDS))
            d2, t2 = identity_from(other.results)
        except Exception as e:  # noqa: BLE001  (no such session this weekend, or it will not load)
            log.debug("%d R%02d %s: sibling %s unusable for identity (%s)", year, rnd, kind, sib,
                      type(e).__name__)
            continue
        filled = [c for c in d2 if c not in d] + [n for n in t2 if n not in t]
        d = {**d2, **d}          # this session's own non-null ids always win
        t = {**t2, **t}
        log.info("%d R%02d %s: identity filled from the weekend's %s session (%d entries)",
                 year, rnd, kind, sib, len(filled))
    miss_d, miss_t = _unresolved(s.results, d, t)
    if miss_d or miss_t:
        # Never write NULL into session_entries.driver_id / session_teams.team_id: fail the
        # session with the names in the message instead.
        raise DataNotAvailable(
            f"{year} R{rnd:02d} {kind}: no DriverId for {miss_d} and no TeamId for {miss_t} in this "
            f"session or any sibling of the weekend {_IDENTITY_SIBLINGS[kind]}")
    return frames.make_session_ids(s, session_id, driver_ids=d, team_ids=t)


def build_frames_for(s, sess: dict, ids: SessionIds, asid: int) -> Frames:
    """The three-way dispatch: race, sprint (results only), qualifying (Q and SQ)."""
    kind = sess["kind"]
    if kind == "R":
        return frames.build_race_frames(s, ids, asid)
    if kind in QUALI_KINDS:
        fr = frames.build_quali_frames(s, ids, asid, kind=kind, cleaned=cleaned_quali(s))
        dropped = list(getattr(s, "_f1lab_dropped", ()) or ())
        if dropped:
            # Named in session_ingests.warnings[] so the row count is explained rather than
            # just short: `session_entries` has fewer rows than FastF1's results frame.
            fr.warnings.append("quali_non_entries_dropped=" + ",".join(dropped))
        return fr
    return frames.build_sprint_frames(s, ids)


def headshot_url(v: object) -> str | None:
    """``drivers.headshot_url`` holds an absolute http(s) URL or NULL, never another string.

    FastF1's ``results.HeadshotUrl`` is a URL, NaN, None, or the four-character string ``'None'``
    (Colapinto in 2025, Tsunoda in 2026 R13); the latter was once stored verbatim and rendered
    as ``<img src="None">``.
    """
    if frames._is_null(v):
        return None
    txt = str(v).strip()
    return txt if txt.startswith(("http://", "https://")) else None


def upsert_dimensions(conn, s, year: int, rnd: int) -> None:
    """teams, drivers, circuits, events.circuit_key — short committed transaction."""
    res = s.results
    with _committed(conn):
        with conn.cursor() as cur:
            teams = {str(r.TeamId): str(r.TeamName) for r in res.itertuples(index=False)}
            db.upsert_rows(cur, "teams", ["team_id", "latest_name"], ["team_id"],
                           list(teams.items()), ["latest_name"])
            d_cols = ["driver_id", "latest_code", "latest_number", "first_name", "last_name", "full_name",
                      "country_code", "headshot_url"]

            def _txt(v: object) -> str | None:
                return None if frames._is_null(v) else str(v)

            drivers = [(str(r.DriverId), str(r.Abbreviation), str(r.DriverNumber), _txt(r.FirstName) or "",
                        _txt(r.LastName) or "", _txt(r.FullName) or "", _txt(r.CountryCode),
                        headshot_url(r.HeadshotUrl))
                       for r in res.itertuples(index=False)]
            # A session without a headshot for a driver must not erase the URL another session gave.
            db.upsert_rows(cur, "drivers", d_cols, ["driver_id"], drivers, d_cols[1:],
                           keep_existing_if_null=["headshot_url"])

            circuit = (s.session_info or {}).get("Meeting", {}).get("Circuit") or {}
            key = circuit.get("Key")
            if key is not None:
                db.upsert_rows(cur, "circuits", ["circuit_key", "short_name", "location", "country"],
                               ["circuit_key"],
                               [(int(key), str(circuit.get("ShortName") or ""), str(s.event["Location"]),
                                 str(s.event["Country"]))],
                               ["short_name", "location", "country"])
                cur.execute("UPDATE events SET circuit_key = %s WHERE year = %s AND round = %s",
                            (int(key), year, rnd))


def session_ingest_row(session_id: int, run_id: int, status: str, fr: Frames | None, total_laps: int | None,
                       asid: int, error: str | None = None) -> tuple[list[str], tuple]:
    from psycopg.types.json import Jsonb

    cols = ["session_id", "run_id", "status", "analytics_status", "warnings", "error", "raw_laps", "clean_laps",
            "total_laps", "assumption_set_id", "lap_km_used", "fuel_scale", "f1lab_version", "fastf1_version"]
    vals = (session_id, run_id, status, Jsonb(fr.analytics_status if fr else {}),
            list(fr.warnings) if fr else [], error, fr.raw_laps if fr else 0, fr.clean_laps if fr else 0,
            total_laps, asid, None, 1.0, __version__, fastf1.__version__)
    return cols, vals


def write_session(conn, sess: dict, s, fr: Frames, run_id: int, asid: int) -> str:
    """The single per-session write transaction. Returns the session_ingests status."""
    session_id = int(sess["session_id"])
    kind = sess["kind"]
    status = "ok" if all(v == "ok" for v in fr.analytics_status.values()) else "partial"
    winner = fastest = None
    total_laps = None
    if kind in QUALI_KINDS:
        # §1.1 / §4.5. `winner_driver_id` stays NULL -- a qualifying session has no
        # classification text and `results.Time` is all-NaT -- and `total_laps` stays NULL,
        # because a qualifying session has no lap count in the race sense.
        # `fastest_pace_driver_id` is the CLASSIFIED P1, a DEFINITIONAL choice and not a
        # measurement: on a drying or cooling track the session's quickest lap can be a Q1 or
        # Q2 lap set by someone else (§6.2's caption C-QUALI-3 says so where they disagree).
        qr = fr.tables["quali_results"]
        pole = qr[qr["position"] == 1]
        if len(pole):
            fastest = str(pole["driver_id"].iloc[0])
    else:
        res = fr.tables["results"]
        p1 = res[res["position"] == 1]
        if len(p1):
            winner = str(p1["driver_id"].iloc[0])
        if kind == "R" and len(fr.tables["pace_ranking"]):
            pr = fr.tables["pace_ranking"]
            fastest = str(pr.loc[pr["rank"] == 1, "driver_id"].iloc[0])
        total_laps = int(s.total_laps) if s.total_laps is not None and not pd.isna(s.total_laps) else None

    with _committed(conn):
        with conn.cursor() as cur:
            db.delete_session_children(cur, session_id)
            for table, df in fr.tables.items():
                db.copy_frame(cur, table, df)
            cur.execute("UPDATE sessions SET total_laps = %s, winner_driver_id = %s, fastest_pace_driver_id = %s "
                        "WHERE session_id = %s", (total_laps, winner, fastest, session_id))
            # v1.7 §2.8 -- a --force rebuild dropped this session's telemetry. Re-derive it from the
            # cache at zero API calls if the artifacts are on disk; otherwise record that it is gone.
            # T8/R5: `status` is computed above, BEFORE this call, so nothing telemetry does can
            # demote a healthy session. `rewrite_after_force` swallows its own exceptions, but a
            # *database* error inside it would leave this transaction aborted and take the
            # session_ingests write below down with it -- which is precisely the demotion R5 forbids
            # -- so it runs inside a SAVEPOINT that is rolled back if it poisoned the transaction.
            cur.execute("SAVEPOINT telemetry_hook")
            telemetry.rewrite_after_force(conn, session_id, fr.analytics_status)
            if conn.info.transaction_status == TransactionStatus.INERROR:
                cur.execute("ROLLBACK TO SAVEPOINT telemetry_hook")
                fr.analytics_status["telemetry"] = {"state": "dropped",
                                                    "reason": "telemetry write aborted the transaction; "
                                                              f"re-run `python -m f1lab.telemetry --session {session_id}`"}
            cur.execute("RELEASE SAVEPOINT telemetry_hook")
            cols, vals = session_ingest_row(session_id, run_id, status, fr, total_laps, asid)
            db.upsert_rows(cur, "session_ingests", cols, ["session_id"], [vals], cols[1:])
    return status


def record_failure(conn, sess: dict, run_id: int, asid: int, exc: BaseException) -> None:
    """The failed session_ingests row, in its own committed transaction (§2.5)."""
    tail = "".join(traceback.format_exception(exc))[-4000:]
    with _committed(conn):   # also ends whatever a failed statement left behind
        with conn.cursor() as cur:
            cols, vals = session_ingest_row(int(sess["session_id"]), run_id, "failed", None, None, asid, error=tail)
            db.upsert_rows(cur, "session_ingests", cols, ["session_id"], [vals], cols[1:])


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

def _counts_line(fr: Frames) -> str:
    return " ".join(f"{t}={len(df)}" for t, df in fr.tables.items())


def dry_run(a: argparse.Namespace) -> int:
    """Load + compute every selected session; print per-table row counts; write nothing."""
    sched, _, sessions = schedule_rows(a.season)
    rows = [{"session_id": 0, "round": s["round"], "kind": s["kind"], "start_utc": s["start_utc"], "status": None}
            for s in sessions]
    todo = _select(rows, argparse.Namespace(**{**vars(a), "force": True}))
    log.info("dry-run %d: %d scheduled rounds, %d sessions selected, nothing will be written",
             a.season, len(sched), len(todo))
    # A dry run WRITES nothing; it still READS. build_race_frames takes the pooled degradation
    # slopes and pit loss from the module-level frames.POOLED_STINT (MODE1_SPEC §4.4), which
    # run_season seeds below. Without seeding it here too, every race dry-run computed
    # optimal_stint session-only, printed 0 rows and reported status=partial for a session the
    # real ingest stores as ok.
    try:
        conn = db.connect(a.dsn)
        try:
            conn.read_only = True        # the server enforces "write nothing" for us
            frames.POOLED_STINT = load_pooled_stint(conn)
            conn.rollback()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001  (no database is a legitimate dry-run mode)
        frames.POOLED_STINT = {}
        print(f"no database ({db.resolve_dsn(a.dsn)}: {type(e).__name__}: {str(e).splitlines()[0]}): "
              "optimal_stint computed session-only, so a printed status may read 'partial'")
    failed = 0
    for i, sess in enumerate(todo):
        t0 = time.perf_counter()
        try:
            s = load_with_retry(a.season, sess["round"], sess["kind"], a.cache)
            ids = session_ids_for(s, sess["kind"], a.season, sess["round"], 0, a.cache)
            fr = build_frames_for(s, sess, ids, 0)
        except RateLimitExceededError as e:
            log.error("rate limited: %s", e)
            return 2
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.error("FAILED %d R%02d %s: %s: %s", a.season, sess["round"], sess["kind"], type(e).__name__, e)
            if a.fail_fast:
                return 1
            continue
        status = "ok" if all(v == "ok" for v in fr.analytics_status.values()) else "partial"
        print(f"{a.season} R{sess['round']:02d} {sess['kind']} {s.event['EventName']}: status={status} "
              f"raw_laps={fr.raw_laps} clean_laps={fr.clean_laps} total_laps={s.total_laps}")
        for table, df in fr.tables.items():
            print(f"    {table:<22} {len(df):>6}")
        not_ok = {k: v for k, v in fr.analytics_status.items() if v != "ok"}
        if not_ok:
            print(f"    analytics_status: {not_ok}")
        if fr.warnings:
            print(f"    warnings: {fr.warnings}")
        log.info("%d R%02d %s %s %.1fs", a.season, sess["round"], sess["kind"], _counts_line(fr),
                 time.perf_counter() - t0)
        if i < len(todo) - 1 and a.sleep > 0:
            time.sleep(a.sleep)
    return 1 if failed else 0


def load_pooled_stint(conn) -> dict:
    """Database-wide constants for moments.build_optimal_stint (MODE1_SPEC §4.4).

    ``build_race_frames`` has no connection, so the pooled numbers are read once per run
    and handed to the detector through ``frames.POOLED_STINT``. The keys are documented
    there; an empty dict is valid and means "no pooled fallback available".
    """
    pooled: dict = {"slope_by_compound": {}, "pit_loss_by_circuit": {}, "pit_loss_pooled_s": None}
    with conn.cursor() as cur:
        # Per-stint fits, not compound_degradation: the pooled table is a median-of-medians
        # and its estimator is not the one sqrt(2T/k) wants (§4.4).
        cur.execute(
            "SELECT compound, count(*), "
            "percentile_cont(0.5) WITHIN GROUP (ORDER BY deg_s_per_lap), "
            "percentile_cont(0.25) WITHIN GROUP (ORDER BY deg_s_per_lap), "
            "percentile_cont(0.75) WITHIN GROUP (ORDER BY deg_s_per_lap) "
            "FROM degradation_fits WHERE deg_s_per_lap IS NOT NULL GROUP BY compound")
        for compound, n, med, q1, q3 in cur.fetchall():
            pooled["slope_by_compound"][str(compound)] = {
                "n_fits": int(n), "median": float(med), "q1": float(q1), "q3": float(q3)}
        cur.execute("SELECT circuit_key, pit_loss_circuit_s, pit_loss_pooled_s FROM sim_circuit_hazard")
        for circuit_key, circuit_s, pooled_s in cur.fetchall():
            if circuit_s is not None:
                pooled["pit_loss_by_circuit"][int(circuit_key)] = float(circuit_s)
            if pooled_s is not None:
                pooled["pit_loss_pooled_s"] = float(pooled_s)
    return pooled


def run_season(conn, a: argparse.Namespace) -> int:
    from psycopg.types.json import Jsonb

    asid = assumptions.get_or_create(conn)
    conn.commit()
    with _committed(conn):
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO ingest_runs (status, cli_args, f1lab_version, fastf1_version, python_version, "
                "assumption_set_id, hostname) VALUES ('running', %s, %s, %s, %s, %s, %s) RETURNING run_id",
                (Jsonb(cli_args_json(a)), __version__, fastf1.__version__, platform.python_version(), asid,
                 socket.gethostname()))
            run_id = int(cur.fetchone()[0])
    log.info("run %d: season %d, assumption set %d, f1lab %s, fastf1 %s", run_id, a.season, asid, __version__,
             fastf1.__version__)

    attempted = ok = failed = partial = 0
    error: str | None = None
    final = "ok"
    todo: list[dict] = []
    try:
        upsert_schedule(conn, a.season)
        with _committed(conn):
            frames.POOLED_STINT = load_pooled_stint(conn)
        todo = sessions_to_do(conn, a)
        log.info("%d sessions to ingest", len(todo))
        for i, sess in enumerate(todo):
            attempted += 1
            t0 = time.perf_counter()
            label = f"{a.season} R{sess['round']:02d} {sess['kind']}"
            try:
                s = load_with_retry(a.season, sess["round"], sess["kind"], a.cache)
                upsert_dimensions(conn, s, a.season, sess["round"])
                ids = session_ids_for(s, sess["kind"], a.season, sess["round"],
                                      int(sess["session_id"]), a.cache)
                fr = build_frames_for(s, sess, ids, asid)
                status = write_session(conn, sess, s, fr, run_id, asid)
            except RateLimitExceededError as e:
                raise Abort(f"FastF1 rate limit exceeded at {label}: {e}") from e
            except Exception as e:  # noqa: BLE001
                failed += 1
                record_failure(conn, sess, run_id, asid, e)
                log.error("FAILED %s: %s: %s", label, type(e).__name__, e)
                if a.fail_fast:
                    raise
                continue
            ok += 1
            partial += status == "partial"
            log.info("%s %s status=%s raw=%d clean=%d %s %.1fs", label, s.event["EventName"], status, fr.raw_laps,
                     fr.clean_laps, _counts_line(fr), time.perf_counter() - t0)
            if i < len(todo) - 1 and a.sleep > 0:
                time.sleep(a.sleep)
    except Abort as e:
        conn.rollback()
        final, error = "aborted", str(e)
        log.error("%s", e)
    except KeyboardInterrupt:
        # Every session so far is committed; only the one in flight is lost. Record the run as
        # aborted (instead of leaving it 'running' forever) and exit 2 like a rate-limit abort.
        conn.rollback()
        final, error = "aborted", "interrupted (KeyboardInterrupt)"
        log.error("interrupted after %d of %d sessions; the run is recorded as aborted", ok + failed, len(todo))
    except Exception as e:  # noqa: BLE001  (--fail-fast re-raise, or an unexpected error)
        conn.rollback()
        final, error = "failed", f"{type(e).__name__}: {e}"
        if not a.fail_fast:
            log.exception("unexpected error")
    else:
        final = "failed" if failed and not ok else ("partial" if failed or partial else "ok")

    # The aggregates always reflect what is stored, also after a --fail-fast stop or a rate-limit
    # abort: a session that just went 'failed' must drop out of ingested_rounds / standings now,
    # not on the next successful run.
    try:
        season.recompute(conn, a.season)
        conn.commit()
        log.info("season %d aggregates recomputed", a.season)
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        log.exception("season %d recompute failed", a.season)
        if final == "ok":
            final, error = "failed", f"season.recompute: {type(e).__name__}: {e}"

    # Circuit hazards pool every stored race (SIM_SPEC §3.4); _committed is the transaction.
    try:
        with _committed(conn):
            n = sim.recompute_hazards(conn, asid)
        log.info("sim hazards recomputed for %d circuits", n)
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        log.exception("sim.recompute_hazards failed")
        if final == "ok":
            final, error = "failed", f"sim.recompute_hazards: {type(e).__name__}: {e}"

    # The four cross-race companion analytics (MODE1_SPEC §6.5, MODE2_SPEC §7.4). Both sim
    # hazards and the season standings are inputs to them, so this runs last;
    # recompute_companion raises CompanionInputsMissing rather than quietly computing from
    # an empty table. --force is passed through; only the mode2 step reads it (§7.8).
    try:
        with _committed(conn):
            counts = companion.recompute_companion(
                conn, asid, force=bool(a.force), regen_reports=bool(a.regen_reports))
        log.info("companion recomputed: %s", counts)
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        log.exception("companion.recompute_companion failed")
        if final == "ok":
            final, error = "failed", f"companion.recompute_companion: {type(e).__name__}: {e}"

    with _committed(conn):
        with conn.cursor() as cur:
            cur.execute("UPDATE ingest_runs SET status = %s, finished_at = now(), sessions_attempted = %s, "
                        "sessions_ok = %s, sessions_failed = %s, error = %s WHERE run_id = %s",
                        (final, attempted, ok, failed, error, run_id))
    log.info("run %d finished: %s (attempted=%d ok=%d failed=%d)", run_id, final, attempted, ok, failed)
    if final == "aborted":
        return 2
    return 1 if failed or final == "failed" else 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        from fastf1.logger import set_log_level
        set_log_level("ERROR")
    except Exception:  # pragma: no cover
        pass
    # set_log_level only lowers FastF1's own console handler; its 'fastf1' logger stays at DEBUG and
    # propagates every "Using cached data for ..." line into the root handler basicConfig just installed.
    logging.getLogger("fastf1").setLevel(logging.ERROR)
    a = build_parser().parse_args(argv)

    # The schedule call below would otherwise silently enable FastF1's default cache.
    cache_dir = Path(a.cache) if a.cache else clean.DEFAULT_CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)

    if a.check_schema:
        try:
            with db.connect(a.dsn) as conn:
                db.assert_schema(conn)
        except db.SchemaMismatch as e:
            print(e, file=sys.stderr)
            return 1
        except Exception as e:  # noqa: BLE001
            print(f"cannot reach the database: {type(e).__name__}: {e}", file=sys.stderr)
            return 1
        print("schema ok: every table in f1lab.frames.EXPECTED_COLUMNS matches the live database")
        return 0

    if a.season is None and not a.recompute_hazards and a.recompute_companion is None:
        build_parser().error("--season is required (or use --check-schema / --recompute-hazards / "
                             "--recompute-companion)")
    if a.recompute_companion is not None:
        try:
            companion.parse_steps(a.recompute_companion)
        except ValueError as e:
            build_parser().error(str(e))

    if a.dry_run:
        return dry_run(a)

    try:
        conn = db.connect(a.dsn)
    except Exception as e:  # noqa: BLE001
        print(f"cannot reach the database ({db.resolve_dsn(a.dsn)}): {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    with conn:
        try:
            db.assert_schema(conn)
        except db.SchemaMismatch as e:
            print(e, file=sys.stderr)
            return 2
        conn.rollback()
        if a.recompute_hazards:
            with _committed(conn):
                asid = assumptions.get_or_create(conn)
                n = sim.recompute_hazards(conn, asid)
            log.info("sim hazards recomputed for %d circuits from stored rows (assumption set %d)", n, asid)
            if a.season is None:
                return 0
        if a.recompute_companion is not None:
            steps = companion.parse_steps(a.recompute_companion)
            with _committed(conn):
                asid = assumptions.get_or_create(conn)
                counts = companion.recompute_companion(
                    conn, asid, steps=steps, force=bool(a.force),
                    regen_reports=bool(a.regen_reports))
            log.info("companion recomputed from stored rows (assumption set %d): %s", asid, counts)
            if a.season is None:
                return 0
        if a.recompute_season:
            season.recompute(conn, a.season)
            conn.commit()
            log.info("season %d aggregates recomputed from stored rows", a.season)
            return 0
        return run_season(conn, a)


if __name__ == "__main__":
    sys.exit(main())
