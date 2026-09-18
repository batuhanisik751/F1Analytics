#!/usr/bin/env python
"""Pick up whatever has been raced since the last run, end to end, unattended.

Nine rounds of 2026 remain (Azerbaijan 26 Sept -> Abu Dhabi 6 Dec). This is the script a
scheduler calls so each one lands without anybody remembering: ingest the new sessions, warm
and derive their telemetry, prove nothing that already existed moved, and refresh the census
baseline so the guard keeps its teeth without failing on legitimate growth.

Everything here is designed around one fact learned the hard way: **there must never be two
writers.** Two concurrent ingests corrupted four sprint sessions earlier in this project, and a
background process that outlived the shell it was launched from widened the telemetry corpus by
42 sessions before anyone noticed. So this script takes an exclusive lock, refuses to start if
any other f1lab process is alive, and holds the lock for the whole run.

It is safe to run when nothing has happened: `ingest --season` is idempotent and skips sessions
that are already stored, so a daily schedule costs seconds on most days and does the real work
on the one day a week it matters. It is also safe to run twice by accident -- the second run
blocks on the lock and then finds nothing to do.

Exit codes: 0 nothing to do or everything succeeded; 1 something failed (details in the log);
2 refused to start (another writer, or the lock is held).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = str(ROOT / ".venv" / "bin" / "python")
LOCK = ROOT / "output" / "update_season.lock"
BASELINE = ROOT / "db" / "trail_census_baseline.json"
DSN = os.environ.get("DATABASE_URL", "postgres://f1:f1@localhost:5432/f1")

log = logging.getLogger("update_season")


def _run(args: list[str], what: str) -> tuple[int, str]:
    """Run a step, capture its output, never let it take the whole script down."""
    log.info("-> %s", what)
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    tail = (p.stdout or "")[-2000:] + (p.stderr or "")[-2000:]
    if p.returncode != 0:
        log.warning("%s exited %d", what, p.returncode)
    return p.returncode, tail


def _other_writers() -> list[str]:
    """Any other f1lab process at all. Cheap, and the cause of the two worst incidents."""
    out = subprocess.run(["pgrep", "-fl", "f1lab"], capture_output=True, text=True).stdout
    mine = str(os.getpid())
    return [ln for ln in out.splitlines()
            if ln.strip() and not ln.startswith(mine) and "update_season" not in ln]


def _failed_telemetry(conn) -> dict[int, str]:
    """Sessions whose telemetry derivation is currently recorded as failed, and why.

    Some failures are permanent facts about the upstream data, not faults to fix: 2026 R14 has
    zero rows in `circuit_corners` so FastF1 offers no corner reference, and Monaco 2026 R6's
    merged frame has no `Date` column. The derive re-attempts them every run -- correctly, since
    a feed can be corrected upstream -- and fails every run. Reporting that as a FAILURE daily
    would train the reader to ignore the one day it means something, so this run compares the
    failing set BEFORE and AFTER: a session that was already failing is a note, a session that
    starts failing is an alert.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT session_id, analytics_status->'telemetry'->>'reason' "
                    "FROM session_ingests "
                    "WHERE analytics_status->'telemetry'->>'state' = 'failed'")
        return {int(sid): (why or "")[:120] for sid, why in cur.fetchall()}


def _session_set(conn) -> set[int]:
    with conn.cursor() as cur:
        cur.execute("SELECT session_id FROM lap_telemetry GROUP BY 1")
        return {int(r[0]) for r in cur.fetchall()}


def _pre_existing_rows_unchanged(conn, before: dict[int, dict[str, int]]) -> list[str]:
    """The growth-not-drift check, per session.

    Adding a race must not alter a single row of any race already stored. This compares the
    per-session census taken before the run against the one after it, for the sessions that
    existed before -- the same check done by hand for the v1.10 releases, here automatically.
    """
    from f1lab.telemetry import trail_census_by_session
    after = trail_census_by_session(conn)
    moved = []
    for sid, want in before.items():
        got = after.get(sid)
        if got is None:
            moved.append(f"session {sid} vanished")
            continue
        for status, n in want.items():
            if int(got.get(status, 0)) != int(n):
                moved.append(f"session {sid} {status}: {n} -> {got.get(status, 0)}")
    return moved


def _write_baseline(conn) -> dict:
    from f1lab.telemetry import trail_census, trail_census_by_session
    by, tot = trail_census_by_session(conn), trail_census(conn)
    prev = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"sessions": {}}
    BASELINE.parent.mkdir(exist_ok=True)
    BASELINE.write_text(json.dumps({
        "note": prev.get("note", "Per-session trail census; see scripts/update_season.py."),
        "written_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "totals_at_write": tot,
        "sessions": {str(k): v for k, v in sorted(by.items())},
    }, indent=1))
    return {"sessions": len(by), "rows": tot["rows"],
            "added": len(by) - len(prev.get("sessions", {}))}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, default=dt.date.today().year)
    ap.add_argument("--telemetry-budget", type=int, default=120,
                    help="charged FastF1 calls this run may spend (default 120; a race "
                         "weekend is ~4 per session)")
    ap.add_argument("--no-telemetry", action="store_true",
                    help="ingest only; skip the warm/derive pass")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be done, write nothing")
    a = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(message)s")
    started = dt.datetime.now()
    log.info("=== update_season %s starting ===", a.season)

    others = _other_writers()
    if others:
        log.error("refusing to start: another f1lab process is running:\n  %s",
                  "\n  ".join(others))
        return 2

    LOCK.parent.mkdir(exist_ok=True)
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        age = dt.datetime.now().timestamp() - LOCK.stat().st_mtime
        log.error("refusing to start: %s held (%.0f min old). If no update is running, "
                  "delete it.", LOCK, age / 60)
        return 2
    os.write(fd, f"{os.getpid()} {started.isoformat(timespec='seconds')}\n".encode())
    os.close(fd)

    try:
        import psycopg
        from f1lab.telemetry import trail_census_by_session
        conn = psycopg.connect(DSN)
        before_census = trail_census_by_session(conn)
        before_sessions = _session_set(conn)
        before_failed = _failed_telemetry(conn)
        conn.rollback()

        if a.dry_run:
            log.info("dry run: %d telemetried sessions, %d in the census baseline",
                     len(before_sessions), len(before_census))
            rc, tail = _run([PY, "-m", "f1lab.ingest", "--season", str(a.season),
                             "--dry-run", "--dsn", DSN], "ingest --dry-run")
            log.info("%s", tail[-1200:])
            return 0 if rc == 0 else 1

        failures: list[str] = []

        # 1. Ingest. Idempotent: already-stored sessions are skipped, failed ones retried.
        rc, tail = _run([PY, "-m", "f1lab.ingest", "--season", str(a.season),
                         "--dsn", DSN, "--sleep", "2"], "ingest")
        if rc != 0:
            failures.append(f"ingest exited {rc}")
        for line in tail.splitlines():
            if "status=ok" in line or "FAILED" in line or "status=partial" in line:
                log.info("   %s", line.strip()[:160])

        # 2. Telemetry. Warm first (rate-limited, budgeted), then derive from the cache.
        if not a.no_telemetry:
            rc, tail = _run([PY, "scripts/warm_telemetry.py", "--seasons", str(a.season),
                             "--budget", str(a.telemetry_budget)], "warm telemetry")
            log.info("   %s", tail.strip().splitlines()[-1] if tail.strip() else "(no output)")
            if rc != 0:
                failures.append(f"warm_telemetry exited {rc}")
            rc, tail = _run([PY, "-m", "f1lab.telemetry", "--year", str(a.season),
                             "--require-cache", "--dsn", DSN], "derive telemetry")
            log.info("   %s", tail.strip().splitlines()[-1] if tail.strip() else "(no output)")
            if rc != 0:
                conn.rollback()
                now_failed = _failed_telemetry(conn)
                fresh = {k: v for k, v in now_failed.items() if k not in before_failed}
                if fresh:
                    for sid, why in fresh.items():
                        log.error("NEW telemetry failure, session %s: %s", sid, why)
                    failures.append(f"{len(fresh)} session(s) newly failed to derive")
                else:
                    log.info("   derive exited %d, but every failing session was already "
                             "failing before this run (%d known: %s) -- not a new fault",
                             rc, len(now_failed), ", ".join(map(str, sorted(now_failed))))

        # 3. Growth, not drift. Nothing that already existed may have moved.
        conn.rollback()
        moved = _pre_existing_rows_unchanged(conn, before_census)
        if moved:
            log.error("PRE-EXISTING DATA CHANGED -- baseline NOT updated. %s",
                      "; ".join(moved[:6]))
            failures.append(f"{len(moved)} pre-existing session counts moved")
        else:
            after_sessions = _session_set(conn)
            new = sorted(after_sessions - before_sessions)
            stats = _write_baseline(conn)
            log.info("growth verified: %d session(s) added %s; baseline now %d sessions, "
                     "%d rows", len(new), new or "", stats["sessions"], stats["rows"])

        log.info("=== done in %.0fs: %s ===", (dt.datetime.now() - started).total_seconds(),
                 "OK" if not failures else "FAILURES: " + "; ".join(failures))
        return 1 if failures else 0
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
