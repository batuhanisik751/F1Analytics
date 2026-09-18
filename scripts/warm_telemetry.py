"""Pre-fetch the 10 Hz car and position streams for every lap-bearing session.

This is a *separate* warmer from ``scripts/warm_cache.py`` on purpose
(TELEMETRY_SPEC §3.3). ``warm_cache.py`` owns ``telemetry=False`` as a guarantee
and must keep working when telemetry is broken; this script is the only thing in
the project that ever asks FastF1 for ``telemetry=True``.

Three measured facts shape every line below:

- **Disk, not the database, is the big number.** Telemetry adds two artifacts per
  session, ~45 MB for a Q/SQ and ~100 MB for a race: **~11 GB across the full
  160-session set** (140 are lap-bearing today; the rest of the 2026 calendar
  has not been run yet), against ~62 MB of database growth. A warm that runs out of disk
  halfway leaves *truncated* ``.ff1pkl`` files that FastF1 reads back as corrupt
  on sessions that "already downloaded" (§8 R3), so this refuses to start below
  15 GB free and unpickles what it finds before trusting it.
- **The API ceiling is 500 calls/hour** and this project has hit it. A session
  load costs 2 measured calls; this charges a conservative 4.
- **Never sleep.** When the trailing hour is already spent, this prints the UTC
  time at which it may proceed and exits 0 (§8 R4). ``warm_resume.sh``'s
  hour-long blind sleep is not on the telemetry path.

Usage:
    .venv/bin/python scripts/warm_telemetry.py --seasons 2024 2025 2026 \\
        --kinds Q SQ R --calls-per-hour 300 --budget 260
    .venv/bin/python scripts/warm_telemetry.py --kinds Q SQ      # ~89 sessions, ~5 GB
    .venv/bin/python scripts/warm_telemetry.py --resume          # only what failed

The exit line is ``warmed=N skipped=M failed=K calls=C``.

**This script warms the FastF1 cache; it writes no database rows.** The v1.8 Gap B
backfill (GAPFILL_SPEC §4.3) is therefore::

    .venv/bin/python -m f1lab.telemetry --force --check-trail

``--force`` re-reads the already-warm cache and makes **zero API calls** -- a local CPU
re-derive, not an 11 GB re-download -- and ``--check-trail`` asserts the pinned census.
``scripts/warm_telemetry.py --check-trail`` runs that same assertion on its own, which is
the half of §4.6 this file can honestly own.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import pickle
import shutil
import sys
import time
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DEFAULT_CACHE = ROOT / "cache"

# A session load costs 2 measured API calls (car_data, position_data). 4 is the
# conservative budget: a stream may come back multi-part.
CALLS_PER_SESSION = 4
DEFAULT_CALLS_PER_HOUR = 300          # 40% under the 500/hour ceiling
REFUSE_ABOVE = 450                    # trailing-hour calls that make us refuse to start
MIN_FREE_BYTES = 15 * 1024**3         # §3.2 free-space precondition, checked at startup
MIN_FREE_PER_SESSION = 2 * 1024**3    # and re-checked per session: ~16x the largest artifact seen
CALL_LOG_NAME = ".telemetry_calls.jsonl"
ARTIFACTS = ("car_data.ff1pkl", "position_data.ff1pkl")

# Q first, then SQ, then R: if the run is interrupted the half that is done is the
# half where a one-lap trace means most. Ingest's {R:0,S:1,Q:2,SQ:3} rank is
# deliberately NOT reused here (§3.3).
KIND_RANK = {"Q": 0, "SQ": 1, "R": 2}
ALL_KINDS = ("Q", "SQ", "R")

# T3's session set, stated as a query. Two exclusions, both measured:
#   - kind 'S' has **zero laps** and is excluded by T3 itself.
#   - a session with no rows in `laps` is not lap-bearing. The `sessions` table
#     carries the whole 2026 calendar including rounds that have not been run
#     yet (start_utc into December), and asking the API for a future session
#     costs 4 charged calls and returns a DataNotLoadedError. "Lap-bearing" is
#     the literal filter, so it is the literal WHERE clause.
SESSION_QUERY = """
    SELECT s.year, s.round, s.kind, s.name
    FROM sessions s
    WHERE s.kind = ANY(%s)
      AND EXISTS (SELECT 1 FROM laps l WHERE l.session_id = s.session_id)
    ORDER BY s.year DESC, s.round DESC, s.kind
"""


def _dsn() -> str:
    """The project DSN, without importing ``f1lab.frames`` if we can help it."""
    return os.environ.get("DATABASE_URL") or "postgres://f1:f1@localhost:5432/f1"


def list_sessions(kinds: list[str], seasons: list[int] | None,
                  rounds: list[int] | None = None) -> list[tuple[int, int, str, str]]:
    """The T3 session set, straight from the database, in warm order.

    The database is the authority on which sessions exist: it holds the 160
    lap-bearing R/Q/SQ sessions plus the 18 ``S`` sessions that T3 excludes. We do
    not re-derive the calendar from FastF1, so the warmer can never fetch a
    session the app has never ingested.
    """
    import psycopg

    with psycopg.connect(_dsn(), autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(SESSION_QUERY, (list(kinds),))
            rows = [(int(y), int(r), str(k), str(n)) for y, r, k, n in cur.fetchall()]
    if seasons:
        rows = [row for row in rows if row[0] in set(seasons)]
    if rounds:
        rows = [row for row in rows if row[1] in set(rounds)]
    rows.sort(key=lambda row: (KIND_RANK.get(row[2], 9), -row[0], -row[1]))
    return rows


def free_bytes(path: Path) -> int:
    probe = path if path.exists() else path.parent
    return shutil.disk_usage(probe).free


def gb(n: float) -> str:
    return f"{n / 1024**3:.1f} GB"


def check_disk(cache_dir: Path) -> int | None:
    """Return the shortfall in bytes, or None when there is room to start."""
    free = free_bytes(cache_dir)
    return None if free >= MIN_FREE_BYTES else MIN_FREE_BYTES - free


# ---------------------------------------------------------------------------
# The call log: cache/.telemetry_calls.jsonl, one JSON object per charge.
# It is the only thing that survives a killed process, which is exactly the
# situation the 500/hour ceiling produces.
# ---------------------------------------------------------------------------

def read_calls(log_path: Path, now: datetime) -> list[tuple[datetime, int]]:
    """(timestamp, calls) for every charge in the trailing hour, oldest first."""
    if not log_path.exists():
        return []
    cutoff = now - timedelta(hours=1)
    out: list[tuple[datetime, int]] = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            ts = datetime.fromisoformat(str(rec["ts"]).replace("Z", "+00:00"))
            calls = int(rec.get("calls", CALLS_PER_SESSION))
        except Exception:  # noqa: BLE001 - a corrupt line must not stop the warm
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts > cutoff:
            out.append((ts, calls))
    out.sort()
    return out


def append_call(log_path: Path, session_label: str, calls: int, now: datetime) -> None:
    rec = {"ts": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
           "calls": calls, "session": session_label}
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


def resume_at(entries: list[tuple[datetime, int]], allowance: int, now: datetime) -> datetime:
    """The UTC moment the trailing-hour total first drops to ``allowance``.

    Charges age out one at a time, an hour after they were made, so the answer is
    the timestamp of the last charge we have to shed, plus one hour. This is
    printed and the process exits; it is never slept on (§8 R4).
    """
    total = sum(c for _, c in entries)
    if total <= allowance:
        return now
    running = total
    for ts, calls in entries:  # oldest first
        running -= calls
        if running <= allowance:
            return ts + timedelta(hours=1)
    return now + timedelta(hours=1)


def stamp(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Filesystem idempotency (§3.3 step 5, §8 R3)
# ---------------------------------------------------------------------------

def session_cache_dir(cache_dir: Path, api_path: str) -> Path:
    """FastF1's own layout: cache/<api_path minus the leading '/static/'>."""
    return cache_dir / api_path[len("/static/"):].strip("/")


def artifact_state(sess_dir: Path) -> tuple[str, str]:
    """``('ok'|'missing'|'corrupt', detail)`` for one session's two artifacts.

    'corrupt' is the expensive case to get wrong: a warm that ran out of disk
    leaves a *truncated* pickle that FastF1 reads back as a parse error on a
    session that looks downloaded. So each artifact is actually unpickled, not
    merely stat-ed, and a truncated one is deleted so the next fetch replaces it.
    """
    missing = [n for n in ARTIFACTS
               if not (sess_dir / n).is_file() or (sess_dir / n).stat().st_size == 0]
    if missing:
        return "missing", ", ".join(missing)
    for name in ARTIFACTS:
        path = sess_dir / name
        try:
            with path.open("rb") as fh:
                obj = pickle.load(fh)
            if not isinstance(obj, dict) or "data" not in obj:
                raise ValueError("not a FastF1 cache pickle")
        except Exception as exc:  # noqa: BLE001 - any read failure means refetch
            for victim in ARTIFACTS:
                (sess_dir / victim).unlink(missing_ok=True)
            return "corrupt", f"{name}: {type(exc).__name__}: {exc}"
    return "ok", ""


def assert_t7() -> None:
    """T7: ``clean.load_race`` / ``load_quali`` keep ``telemetry=False`` for ever.

    Checked here, at the top of the one script that asks for ``telemetry=True``,
    because this is the file most likely to be tempted into flipping it.
    """
    from f1lab import clean

    try:
        src = inspect.getsource(clean.load_race)
        quali_src = inspect.getsource(clean.load_quali)
    except (OSError, TypeError):  # no source on disk: cannot check, must not die
        print("note: clean.py source unavailable, T7 not verifiable here", flush=True)
        return
    if "telemetry=False" not in src:
        raise SystemExit("T7 violated: clean.load_race no longer passes telemetry=False")
    if "load_race(" not in quali_src:
        raise SystemExit("T7 violated: clean.load_quali no longer delegates to load_race")
    if not hasattr(clean, "load_telemetry"):
        raise SystemExit("clean.load_telemetry is missing (TELEMETRY_SPEC §3.3/§3.4)")


def failures_path(cache_dir: Path) -> Path:
    return cache_dir / ".telemetry_failed.json"


def read_failures(cache_dir: Path) -> set[tuple[int, int, str]]:
    path = failures_path(cache_dir)
    if not path.exists():
        return set()
    try:
        return {(int(r["year"]), int(r["round"]), str(r["kind"]))
                for r in json.loads(path.read_text(encoding="utf-8"))}
    except Exception:  # noqa: BLE001
        return set()


def write_failures(cache_dir: Path, failed: set[tuple[int, int, str]]) -> None:
    rows = [{"year": y, "round": r, "kind": k} for y, r, k in sorted(failed)]
    failures_path(cache_dir).write_text(json.dumps(rows, indent=1), encoding="utf-8")


def dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Warm the FastF1 telemetry cache (TELEMETRY_SPEC §3.3).")
    p.add_argument("--seasons", type=int, nargs="*", default=None, help="default: every season in the database")
    p.add_argument("--kinds", nargs="*", default=list(ALL_KINDS), choices=list(ALL_KINDS),
                   help="kind 'S' has zero laps and cannot be requested (T3)")
    p.add_argument("--rounds", type=int, nargs="*", default=None,
                   help="restrict to these round numbers (a scope narrow enough to re-run exactly)")
    p.add_argument("--calls-per-hour", type=int, default=DEFAULT_CALLS_PER_HOUR)
    p.add_argument("--budget", type=int, default=None, help="stop cleanly after N charged calls")
    p.add_argument("--resume", action="store_true", help="re-attempt only the sessions that failed")
    p.add_argument("--cache", default=None)
    p.add_argument("--dry-run", action="store_true", help="report what would be fetched; charge nothing")
    # GAPFILL_SPEC §4.3/§4.6 -- the Gap B backfill acceptance gate. This warmer fetches
    # FastF1 artifacts and writes no database rows, so it cannot itself run the
    # re-derive (see the module docstring); what it can do, and what §4.6 asks it for,
    # is refuse to report success when the derived columns are not what they must be.
    p.add_argument("--check-trail", action="store_true",
                   help="write and fetch nothing: assert the §4.3 trail-braking backfill "
                        "census against f1lab.telemetry's pinned constants and exit "
                        "non-zero on any mismatch (acceptance is an exact count, not > 0)")
    return p.parse_args(argv)


def resume_command(args: argparse.Namespace) -> str:
    parts = ["  .venv/bin/python scripts/warm_telemetry.py"]
    if args.seasons:
        parts.append("--seasons " + " ".join(str(s) for s in args.seasons))
    parts.append("--kinds " + " ".join(args.kinds))
    if args.rounds:
        parts.append("--rounds " + " ".join(str(r) for r in args.rounds))
    parts.append(f"--calls-per-hour {args.calls_per_hour}")
    if args.budget is not None:
        parts.append(f"--budget {args.budget}")
    return " ".join(parts)


def check_trail() -> int:
    """GAPFILL_SPEC §4.3 -- the pinned backfill census, printed and enforced.

    Risk R1: `source_hash` covers the raw channels, not the derivation, so after
    migration 0010 every one of the 1,518 laps hashes identically and a default derive
    run skips all 75 sessions, leaves five columns NULL and exits 0. The two defences
    are `derive_version` in the skip condition (f1lab.telemetry.stored_hashes) and this
    exact-count acceptance. "> 0" would pass a run that measured one row.
    """
    from f1lab import db, telemetry
    conn = db.connect()
    try:
        census = telemetry.trail_census(conn)
        for k in sorted(census):
            print(f"  {k:32s} {census[k]:>7,}", flush=True)
        telemetry.assert_trail_backfill(conn)
    except telemetry.TelemetryError as exc:
        print(f"REFUSED: {exc}", flush=True)
        return 1
    finally:
        conn.close()
    print(f"trail backfill OK: measured={telemetry.TRAIL_EXPECTED_MEASURED_ROWS:,} "
          f"non_terminal={telemetry.TRAIL_NON_TERMINAL_ROWS:,} "
          f"flat={telemetry.TRAIL_FLAT_ROWS:,}", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cache_dir = Path(args.cache) if args.cache else DEFAULT_CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    log_path = cache_dir / CALL_LOG_NAME

    assert_t7()

    if args.check_trail:
        return check_trail()

    shortfall = check_disk(cache_dir)
    if shortfall is not None:
        print(f"REFUSED: {gb(free_bytes(cache_dir))} free on {cache_dir}, "
              f"{gb(MIN_FREE_BYTES)} required — short by {gb(shortfall)}.", flush=True)
        print("  A warm that runs out of disk leaves truncated .ff1pkl files that read back "
              "as corrupt (§8 R3).", flush=True)
        print("  The full set needs ~11 GB; `--kinds Q SQ` alone is ~5 GB and ships the "
              "headline feature whole.", flush=True)
        return 1

    now = datetime.now(timezone.utc)
    entries = read_calls(log_path, now)
    spent = sum(c for _, c in entries)
    if spent > REFUSE_ABOVE and not args.dry_run:
        when = resume_at(entries, REFUSE_ABOVE, now)
        print(f"REFUSED: {spent} calls charged in the trailing hour (ceiling 500, limit "
              f"{REFUSE_ABOVE}). Nothing downloaded.", flush=True)
        print(f"  May proceed at {stamp(when)} (UTC). Not sleeping — re-run then:", flush=True)
        print(resume_command(args), flush=True)
        return 0

    sessions = list_sessions(args.kinds, args.seasons, args.rounds)
    if args.resume:
        want = read_failures(cache_dir)
        sessions = [s for s in sessions if (s[0], s[1], s[2]) in want]
    print(f"== {len(sessions)} sessions in scope ({', '.join(args.kinds)}); "
          f"{spent} calls in the trailing hour; {gb(free_bytes(cache_dir))} free", flush=True)
    return run(args, sessions, cache_dir, log_path)


def run(args, sessions, cache_dir: Path, log_path: Path) -> int:
    import fastf1
    from fastf1.logger import set_log_level

    from f1lab import clean

    fastf1.Cache.enable_cache(cache_dir)
    set_log_level("ERROR")

    failed = read_failures(cache_dir)
    warmed = skipped = failures = charged = planned = 0
    t0 = time.time()

    for year, rnd, kind, name in sessions:
        label = f"{year} R{rnd:02d} {kind}"
        try:
            sess = fastf1.get_session(year, rnd, kind)
            sess_dir = session_cache_dir(cache_dir, sess.api_path)
        except Exception as exc:  # noqa: BLE001 - the warmer never raises (§3.3.6)
            print(f"  FAIL {label} {name}: {type(exc).__name__}: {exc}", flush=True)
            failures += 1
            failed.add((year, rnd, kind))
            continue

        state, detail = artifact_state(sess_dir)
        if state == "ok":
            skipped += 1
            failed.discard((year, rnd, kind))
            print(f"  skip {label} {name}  (cached)", flush=True)
            continue
        if state == "corrupt":
            print(f"  BAD  {label} {name}: {detail} — deleted, refetching", flush=True)

        if args.budget is not None and planned + CALLS_PER_SESSION > args.budget:
            print(f"-- budget {args.budget} reached. Resume with:", flush=True)
            print(resume_command(args), flush=True)
            break

        now = datetime.now(timezone.utc)
        in_hour = sum(c for _, c in read_calls(log_path, now))
        # The rate limiter and the disk floor gate *fetches*. A dry run charges
        # nothing and writes nothing, so it must be able to answer "what is left?"
        # during a spent hour — which is exactly when an operator asks.
        if not args.dry_run and in_hour + CALLS_PER_SESSION > args.calls_per_hour:
            when = resume_at(read_calls(log_path, now), args.calls_per_hour - CALLS_PER_SESSION, now)
            print(f"-- {in_hour} calls in the trailing hour, budget {args.calls_per_hour}/h. "
                  f"Stopping, not sleeping. May proceed at {stamp(when)} (UTC):", flush=True)
            print(resume_command(args), flush=True)
            break

        # Re-checked per session, not only at startup: the truncated-pickle failure of
        # §8 R3 happens when the disk fills *during* a warm, and one statvfs is free.
        free = free_bytes(cache_dir)
        if not args.dry_run and free < MIN_FREE_PER_SESSION:
            print(f"-- {gb(free)} free, below the {gb(MIN_FREE_PER_SESSION)} per-session "
                  f"floor. Stopping before a truncated artifact can be written.", flush=True)
            print(resume_command(args), flush=True)
            break

        planned += CALLS_PER_SESSION
        if args.dry_run:
            print(f"  DRY  {label} {name}  ({state}: {detail})", flush=True)
            continue

        before = dir_bytes(sess_dir)
        append_call(log_path, label, CALLS_PER_SESSION, now)
        charged += CALLS_PER_SESSION
        t = time.time()
        try:
            s = clean.load_telemetry(year, rnd, kind, cache=cache_dir)
            n_laps = len(s.laps)
        except Exception as exc:  # noqa: BLE001 - a failed session never stops the loop
            print(f"  FAIL {label} {name}: {type(exc).__name__}: {exc}", flush=True)
            failures += 1
            failed.add((year, rnd, kind))
            continue
        grew = dir_bytes(sess_dir) - before
        warmed += 1
        failed.discard((year, rnd, kind))
        print(f"  ok   {label} {name}  laps={n_laps} +{grew / 1024**2:.0f} MB "
              f"{time.time() - t:.1f}s", flush=True)

    write_failures(cache_dir, failed)
    print(f"warmed={warmed} skipped={skipped} failed={failures} calls={charged}", flush=True)
    print(f"-- {time.time() - t0:.0f}s wall, {gb(free_bytes(cache_dir))} free, "
          f"cache {gb(dir_bytes(cache_dir))}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
