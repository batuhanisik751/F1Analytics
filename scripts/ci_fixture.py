#!/usr/bin/env python3
"""CI helpers around the database fixture (OPS_SPEC §2.4, §6.1).

    python scripts/ci_fixture.py pin                    print the pin as key=value lines
    python scripts/ci_fixture.py check-asset PATH       sha256 + size of the downloaded asset
    python scripts/ci_fixture.py assert-not-newer       fixture ledger <= repo migrations
    python scripts/ci_fixture.py assert-at-head         ledger == repo migrations

`pin` reads tests/ci_fixture.txt (key=value lines, `#` comments) and refuses an empty pin, so a
workflow that reaches the download step always has a tag, an asset name and a sha256.
The two ledger assertions read drizzle.__drizzle_migrations on DATABASE_URL and count the
entries of web/drizzle/meta/_journal.json (cross-checked against web/drizzle/*.sql); they are
run before and after `npm run db:migrate` so a stale or over-new fixture is a red run, never a
quiet one. Exit codes: 0 ok, 1 assertion failed, 2 usage or unreadable input.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN_FILE = ROOT / "tests" / "ci_fixture.txt"
JOURNAL = ROOT / "web" / "drizzle" / "meta" / "_journal.json"
MIGRATIONS_DIR = ROOT / "web" / "drizzle"
LEDGER = "drizzle.__drizzle_migrations"
REQUIRED_PIN_KEYS = ("tag", "release", "asset", "sha256")


def die(msg: str, code: int = 1) -> "NoReturn":  # noqa: F821 - typing only
    print(f"ci_fixture: {msg}", file=sys.stderr)
    sys.exit(code)


def read_pin(path: Path = PIN_FILE) -> dict[str, str]:
    """key=value lines; blank lines and `#` comments ignored; later keys win."""
    if not path.is_file():
        die(f"{path.relative_to(ROOT)} is missing", 2)
    pin: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        pin[key.strip()] = value.strip()
    return pin


def cmd_pin(args: list[str]) -> int:
    pin = read_pin(Path(args[0]) if args else PIN_FILE)
    missing = [k for k in REQUIRED_PIN_KEYS if not pin.get(k)]
    if missing:
        die(
            "no fixture is pinned (empty: "
            + ", ".join(missing)
            + "); publish one with scripts/publish_fixture.sh --commit and commit tests/ci_fixture.txt"
        )
    if len(pin["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in pin["sha256"].lower()):
        die(f"sha256 in the pin is not a 64-hex digest: {pin['sha256']!r}")
    for key, value in pin.items():
        print(f"{key}={value}")
    return 0


def cmd_check_asset(args: list[str]) -> int:
    if not args:
        die("usage: check-asset PATH [PIN_FILE]", 2)
    asset = Path(args[0])
    pin = read_pin(Path(args[1]) if len(args) > 1 else PIN_FILE)
    if not asset.is_file():
        die(f"{asset} does not exist")
    digest = hashlib.sha256()
    with asset.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    size = asset.stat().st_size
    if actual != pin["sha256"].lower():
        die(f"sha256 mismatch for {asset.name}: pinned {pin['sha256']} got {actual}")
    if pin.get("bytes") and int(pin["bytes"]) != size:
        die(f"size mismatch for {asset.name}: pinned {pin['bytes']} bytes got {size}")
    print(f"ci_fixture: {asset.name} ok — sha256 {actual[:12]}… {size:,} bytes (tag {pin['tag']})")
    return 0


def repo_migrations() -> int:
    """Entries in web/drizzle/meta/_journal.json, cross-checked against web/drizzle/*.sql."""
    try:
        entries = json.loads(JOURNAL.read_text(encoding="utf-8"))["entries"]
    except (OSError, KeyError, ValueError) as e:
        die(f"cannot read {JOURNAL.relative_to(ROOT)}: {e}", 2)
    sql_files = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    if len(sql_files) != len(entries):
        die(
            f"web/drizzle has {len(sql_files)} .sql files but the journal lists {len(entries)} entries; "
            "regenerate with `npm run db:generate` before asserting the ledger",
            2,
        )
    return len(entries)


def ledger_rows(dsn: str) -> int | None:
    """Rows in drizzle.__drizzle_migrations, or None when the ledger table does not exist."""
    try:
        import psycopg
    except ImportError:
        die("psycopg is not installed (pip install -r requirements-ci.txt)", 2)
    try:
        with psycopg.connect(dsn, connect_timeout=10) as conn:
            exists = conn.execute("SELECT to_regclass(%s)", (LEDGER,)).fetchone()[0]
            if exists is None:
                return None
            return conn.execute(f"SELECT count(*) FROM {LEDGER}").fetchone()[0]
    except psycopg.Error as e:
        die(f"cannot read {LEDGER} on DATABASE_URL: {type(e).__name__}: {str(e).strip()}", 2)


def cmd_assert_not_newer(_: list[str]) -> int:
    repo = repo_migrations()
    ledger = ledger_rows(dsn())
    have = 0 if ledger is None else ledger
    if have > repo:
        die(f"fixture is NEWER than the repo — wrong branch or wrong asset (ledger {have} > repo {repo})")
    print(f"ci_fixture: ledger {have} <= repo migrations {repo} — ok" + (" (no ledger table yet)" if ledger is None else ""))
    return 0


def cmd_assert_at_head(_: list[str]) -> int:
    repo = repo_migrations()
    ledger = ledger_rows(dsn())
    if ledger is None:
        die(f"db:migrate did not bring the fixture to head ({LEDGER} does not exist; repo has {repo})")
    if ledger != repo:
        die(f"db:migrate did not bring the fixture to head (ledger {ledger} != repo migrations {repo})")
    print(f"ci_fixture: ledger {ledger} == repo migrations {repo} — at head")
    return 0


def dsn() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        die("DATABASE_URL is not set", 2)
    return value


COMMANDS = {
    "pin": cmd_pin,
    "check-asset": cmd_check_asset,
    "assert-not-newer": cmd_assert_not_newer,
    "assert-at-head": cmd_assert_at_head,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
