"""Apply the preview-snapshot migration to Neon and re-grant the push role — nothing else.

Why not scripts/neon_migrate.sh: that script re-applies every role file and needs all four role
passwords; given a wrong one it would rotate a production credential. The migration here adds two
tables, and only two things follow from that on Neon: the Drizzle ledger must reach head, and
f1_push (which has no default privileges, by design — 0012_push_role.sql) must be granted on the new
tables. f1_web already has default SELECT on new tables (0011_web_role.sql). The push password is
taken from the DSN the nightly job already uses, so re-applying 0012_push_role.sql changes nothing
but the grants.

    .venv/bin/python scripts/neon_apply_0012.py --check   # prove the inputs, touch nothing
    .venv/bin/python scripts/neon_apply_0012.py           # migrate + re-grant + print the state

Values are read from the mode-600 files with Python and passed as arguments or environment; they are
never sourced, never printed (every output line is redacted against them).
"""
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

CFG = os.path.expanduser("~/.config/f1analytics")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def kv(name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(os.path.join(CFG, name), encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m:
                out[m.group(1)] = m.group(2).strip().strip("'").strip('"')
    return out


def main() -> int:
    owner_url = kv("owner.env")["OWNER_URL"]
    push_dsn = kv("remote.env")["REMOTE_DATABASE_URL"]
    push_pw = unquote(urlsplit(push_dsn).password or "")
    if urlsplit(push_dsn).username != "f1_push" or len(push_pw) < 8:
        print("remote.env does not hold an f1_push DSN with a password", file=sys.stderr)
        return 2
    if "sslmode=verify-full" not in owner_url:
        print("OWNER_URL must carry sslmode=verify-full", file=sys.stderr)
        return 2
    secrets = [owner_url, push_dsn, push_pw]

    def redact(s: str) -> str:
        for x in secrets:
            s = s.replace(x, "[redacted]")
        return s

    def run(label: str, cmd: list[str], **kw) -> None:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, **kw)
        print(f"--- {label}: exit {r.returncode}\n{redact((r.stdout + r.stderr)[-2500:])}")
        if r.returncode:
            sys.exit(r.returncode)

    if "--check" in sys.argv:
        print("inputs ok: f1_push DSN with password; owner DSN with verify-full; nothing touched")
        return 0

    # 1. Drizzle ledger to head. node-postgres opens `sslrootcert` as a file path, so that parameter
    #    is dropped for the migrate step exactly as neon_migrate.sh does; verify-full stays.
    drizzle_url = re.sub(r"[&?]sslrootcert=system", "", owner_url)
    run("db:migrate on Neon (owner)", ["npm", "--prefix", os.path.join(ROOT, "web"), "run", "--silent", "db:migrate"],
        env={**os.environ, "DATABASE_URL": drizzle_url})

    # 2. Re-grant the push role on every public table (the file enumerates pg_tables at run time).
    with open(os.path.join(ROOT, "scripts/sql/0012_push_role.sql"), encoding="utf-8") as fh:
        run("0012_push_role.sql (re-grant f1_push)",
            ["docker", "exec", "-i", "f1-postgres", "psql", owner_url, "-X", "-q", "-v", "ON_ERROR_STOP=1",
             "-v", f"push_password={push_pw}", "-f", "-"], stdin=fh)

    # 3. The state the runbook checks.
    run("state", ["docker", "exec", "-i", "f1-postgres", "psql", owner_url, "-X", "-Atc",
        "select 'migrations applied: ' || count(*) from drizzle.__drizzle_migrations "
        "union all select 'f1_push INSERT on preview_snapshot_order: ' || has_table_privilege('f1_push', 'public.preview_snapshot_order', 'INSERT') "
        "union all select 'f1_web SELECT on preview_snapshot_round: ' || has_table_privilege('f1_web', 'public.preview_snapshot_round', 'SELECT')"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
