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

Since v1.11 the run ends by publishing (step 4): `scripts/push_remote.py` diffs this machine
against the production database and applies the difference in one remote transaction, but
only when every step above reported success -- a corpus the growth guard did not sign is never
published. On a successful push that moved sessions, step 5 commits the census baseline and
re-publishes the CI fixture so the tree is clean by morning. Between the two, a successful push
tells production to expire its query cache (`/api/revalidate`, REVALIDATE_SPEC §3); if that
call fails the run exits 1 but the data is already right and the cache heals within an hour.
The production credentials are read from `~/.config/f1analytics/remote.env` (mode 600) and
nowhere else; without that file the run is local-only and says so. `--no-push` keeps a run
local, `--push-only` skips ingest and derive
and pushes what is local now, `--dry-run` prints the push plan and writes nothing anywhere.

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
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = str(ROOT / ".venv" / "bin" / "python")
LOCK = ROOT / "output" / "update_season.lock"
BASELINE = ROOT / "db" / "trail_census_baseline.json"
DSN = os.environ.get("DATABASE_URL", "postgres://f1:f1@localhost:5432/f1")
# The production credential (F6): read at run time, never stored anywhere else.
REMOTE_ENV = Path.home() / ".config" / "f1analytics" / "remote.env"
# The cache purge after a push (REVALIDATE_SPEC §3): where it went, and how the last one ended.
LAST_REVALIDATE = ROOT / "output" / "last_revalidate.json"
REVALIDATE_KEYS = ["REVALIDATE_URL", "REVALIDATE_SECRET"]
REVALIDATE_TIMEOUT_S = 20
REVALIDATE_RETRY_AFTER_S = 5

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


def _remote_dsn() -> str | None:
    """The production credential: the environment, else REMOTE_ENV (refused unless 0600)."""
    from scripts.push_remote import load_remote_dsn
    return load_remote_dsn(REMOTE_ENV)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every 3xx: a followed redirect would re-send the bearer header as a GET."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect)


def _http(opener, req: urllib.request.Request) -> tuple[str | None, bool]:
    """One request. (None, False) on 200; else (reason, retryable): a URLError, a timeout or a
    5xx is worth one more try (a cold start); a 4xx or a 3xx is an answer, not a fault."""
    try:
        with opener.open(req, timeout=REVALIDATE_TIMEOUT_S) as r:
            if r.status == 200:
                return None, False
            return f"{r.status} {getattr(r, 'reason', '') or ''}".strip(), 500 <= r.status < 600
    except urllib.error.HTTPError as e:
        return f"{e.code} {e.reason}", 500 <= e.code < 600
    except (urllib.error.URLError, OSError) as e:         # TimeoutError is an OSError
        return type(e).__name__, True


def _write_last_revalidate(status: str, reason: str, host: str | None) -> None:
    LAST_REVALIDATE.parent.mkdir(exist_ok=True)
    LAST_REVALIDATE.write_text(json.dumps({
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "status": status, "reason": reason, "host": host}, indent=1))


def _previous_revalidate() -> dict | None:
    try:
        return json.loads(LAST_REVALIDATE.read_text()) if LAST_REVALIDATE.exists() else None
    except (OSError, ValueError):
        return None


def _last_release_id() -> int | None:
    from scripts.push_remote import LAST_PUSH
    try:
        return json.loads(LAST_PUSH.read_text()).get("release_id") if LAST_PUSH.exists() else None
    except (OSError, ValueError):
        return None


def _revalidate_step(failures: list[str], new_sessions: list[int], dry_run: bool = False) -> None:
    """Step 4b: tell production to expire its query cache, now that the corpus moved.

    Runs only after a successful, non-dry push (REVALIDATE_SPEC §3). One POST to REVALIDATE_URL
    with the last push's release_id, one retry after a cold start, then one smoke GET of the
    origin. A failure is a line in `failures` (exit 1), never a stop: the data is already
    right and the 3600 s expiry heals the cache by itself. The secret stays in this frame and
    is never part of any string that is logged. `new_sessions` is accepted for symmetry with
    `_push_step`; the request body carries only the release id.
    """
    from scripts.push_remote import read_remote_env
    try:
        creds = read_remote_env(REVALIDATE_KEYS, REMOTE_ENV)
    except Exception as e:                      # a refusal on the credential file's mode/owner
        log.error("revalidate: REFUSED: %s", e)
        failures.append(f"revalidate: REFUSED: {e}")
        return
    url, secret = creds.get("REVALIDATE_URL"), creds.get("REVALIDATE_SECRET")
    if not url or not secret:
        log.info("revalidate: no REVALIDATE_URL -- skipped (local only)")
        if not dry_run:
            _write_last_revalidate("skipped", "no REVALIDATE_URL", None)
        return
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or url
    if dry_run:
        log.info("revalidate: would POST %s", host)
        return
    prev = _previous_revalidate()
    if prev and prev.get("status") == "failed":
        log.info("revalidate: previous run FAILED (%s: %s)", prev.get("at"), prev.get("reason"))
    rid = _last_release_id()
    opener = _opener()
    req = urllib.request.Request(
        url, method="POST", data=json.dumps({"release_id": rid}).encode(),
        headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
    started = time.monotonic()
    reason, retry = _http(opener, req)
    if reason and retry:
        log.info("revalidate: %s; retrying in %ds", reason, REVALIDATE_RETRY_AFTER_S)
        time.sleep(REVALIDATE_RETRY_AFTER_S)
        reason, _ = _http(opener, req)
    if reason is None:
        smoke = urllib.request.Request(f"{parts.scheme}://{parts.netloc}/", method="GET")
        reason, _ = _http(opener, smoke)
        reason = f"smoke GET {reason}" if reason else None
    secs = time.monotonic() - started
    if reason is None:
        log.info("revalidate: OK %s release_id=%s in %.1fs", host, rid, secs)
        _write_last_revalidate("ok", f"release_id={rid}", host)
        return
    log.error("revalidate: FAILED %s %s", host, reason)
    failures.append(f"revalidate: {reason}")
    _write_last_revalidate("failed", reason, host)


def _push_step(a, failures: list[str], new_sessions: list[int]) -> None:
    """Step 4: publish the corpus to production; step 5: commit what the push changed.

    Gated on zero failures so far (ingest, derive, the growth guard): only a guard-signed
    corpus is published. A run without the credential file is local-only and says so. The
    push holds the same lock as the ingest, so there is exactly one writer on both ends.
    """
    if a.no_push:
        log.info("push: skipped (--no-push)")
        return
    if failures:
        log.warning("push: SKIPPED because this run reported failures -- production is unchanged")
        return
    try:
        remote = _remote_dsn()
    except Exception as e:                      # a refusal on the credential file's mode/owner
        log.error("push: REFUSED: %s", e)
        failures.append(f"push: REFUSED: {e}")
        return
    if not remote:
        log.info("push: no REMOTE_DATABASE_URL in %s -- local only", REMOTE_ENV)
        return
    from scripts.push_remote import push
    rc, summary = push(local_dsn=DSN, remote_dsn=remote, full=False, retries=3, dry_run=a.dry_run)
    (log.error if rc else log.info)("push: %s", summary)
    if rc != 0:
        failures.append(f"push: {summary}")
        if summary.startswith("FAILED"):
            log.error("PUSH FAILED")
        return
    if a.dry_run:
        _revalidate_step(failures, new_sessions, dry_run=True)
        return
    if not summary.startswith("OK"):
        return
    # 4b. Production's query cache still holds the numbers from before this push (3600 s at
    # most); the hook expires them now. Its outcome never stops step 5.
    _revalidate_step(failures, new_sessions)
    # 5. The baseline moved with the corpus and the CI fixture must follow it, tonight, so the
    # tree is clean by morning and CI never runs against a number the site no longer shows.
    what = f"round(s) {', '.join(map(str, new_sessions))}" if new_sessions else summary
    rc, tail = _run(["git", "commit", "-qm", f"Baseline after {what}", "--", str(BASELINE)],
                    "commit baseline")
    if rc != 0:
        log.warning("baseline commit did not happen (%s); the tree stays as it is until "
                    "morning", tail.strip().splitlines()[-1] if tail.strip() else "no output")
        return
    publisher = ROOT / "scripts" / "publish_fixture.sh"
    if not publisher.exists():
        log.warning("fixture not re-published: %s is missing", publisher)
        return
    rc, tail = _run([str(publisher), "--commit"], "re-publish CI fixture")
    if rc != 0:
        log.warning("fixture re-publish failed (%s); re-run scripts/publish_fixture.sh --commit "
                    "after a green local pytest", tail.strip().splitlines()[-1] if tail.strip()
                    else "no output")


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
                    help="report what would be done, write nothing (locally or remotely)")
    ap.add_argument("--no-push", action="store_true",
                    help="ingest and verify only; do not touch production")
    ap.add_argument("--push-only", action="store_true",
                    help="skip ingest/derive; diff-and-push what is local now")
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

        failures: list[str] = []

        if a.dry_run:
            log.info("dry run: %d telemetried sessions, %d in the census baseline",
                     len(before_sessions), len(before_census))
            if not a.push_only:
                rc, tail = _run([PY, "-m", "f1lab.ingest", "--season", str(a.season),
                                 "--dry-run", "--dsn", DSN], "ingest --dry-run")
                log.info("%s", tail[-1200:])
                if rc != 0:
                    failures.append(f"ingest --dry-run exited {rc}")
            # The push plan is part of the report: `push: nothing to do` is what an armed
            # machine prints on a quiet night (RUNBOOK §9).
            _push_step(a, failures, new_sessions=[])
            return 1 if failures else 0

        if a.push_only:
            log.info("push-only: ingest, derive and the growth check are skipped; the corpus "
                     "as it stands (last guard-signed run) is what gets published")
            _push_step(a, failures, new_sessions=[])
            log.info("=== done in %.0fs: %s ===", (dt.datetime.now() - started).total_seconds(),
                     "OK" if not failures else "FAILURES: " + "; ".join(failures))
            return 1 if failures else 0

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
        new: list[int] = []
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

        # 4-5. Publish, then keep the repo consistent. Still inside the lock: the push and
        # the ingest share it so there is one writer on both ends.
        _push_step(a, failures, new_sessions=new)

        log.info("=== done in %.0fs: %s ===", (dt.datetime.now() - started).total_seconds(),
                 "OK" if not failures else "FAILURES: " + "; ".join(failures))
        return 1 if failures else 0
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
