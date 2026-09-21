#!/usr/bin/env python3
"""Wait for a URL to answer, with a hard deadline (OPS_SPEC §6.1).

    python scripts/ci_wait.py http://localhost:3000/glossary 90
    python scripts/ci_wait.py postgres://f1:f1@localhost:5432/f1 30

An http(s) URL is polled with GET until it returns a status below 500; a postgres URL is
polled with a psycopg connection plus `SELECT 1`. Prints one line per attempt that fails for
a new reason, then the elapsed time on success. Exit 0 on success, 1 on deadline, 2 on usage.
Nothing here needs a secret: the DSN is the workflow's service database.
"""

from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request

INTERVAL = 1.0


def probe_http(url: str) -> tuple[bool, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "ci_wait"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - CI-local URL
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return False, f"{type(e).__name__}: {getattr(e, 'reason', e)}"
    return status < 500, f"HTTP {status}"


def probe_postgres(dsn: str) -> tuple[bool, str]:
    try:
        import psycopg
    except ImportError:
        return False, "psycopg is not installed (pip install -r requirements-ci.txt)"
    try:
        with psycopg.connect(dsn, connect_timeout=5) as conn:
            conn.execute("SELECT 1")
    except Exception as e:  # noqa: BLE001 - any failure is "not yet"
        return False, f"{type(e).__name__}: {str(e).strip().splitlines()[0] if str(e).strip() else ''}"
    return True, "connected"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    url, deadline_s = argv[0], float(argv[1])
    if url.startswith(("http://", "https://")):
        probe = probe_http
    elif url.startswith(("postgres://", "postgresql://")):
        probe = probe_postgres
    else:
        print(f"ci_wait: unsupported URL scheme: {url}", file=sys.stderr)
        return 2
    start = time.monotonic()
    last_reason = None
    attempts = 0
    while True:
        attempts += 1
        ok, reason = probe(url)
        elapsed = time.monotonic() - start
        if ok:
            print(f"ci_wait: {url} answered ({reason}) after {elapsed:.1f} s, {attempts} attempt(s)")
            return 0
        if reason != last_reason:
            print(f"ci_wait: waiting for {url} — {reason}", flush=True)
            last_reason = reason
        if elapsed >= deadline_s:
            print(f"ci_wait: {url} did not answer within {deadline_s:g} s ({reason})", file=sys.stderr)
            return 1
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
