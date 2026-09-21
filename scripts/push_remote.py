#!/usr/bin/env python
"""Move what changed locally to the production database, in one transaction (OPS_SPEC §3).

The laptop is the only writer of the corpus; production only reads it. So the push is a
stateless diff, not a replay: every run asks both sides what they hold, works out the
difference, and applies exactly that inside one remote transaction under ROW EXCLUSIVE locks.
Readers never block; they see the old rows until COMMIT and the new rows after. A run that dies
mid-way leaves production untouched, and the next run repairs whatever the last one did not
finish, because the diff is the mechanism rather than the run's memory.

Unit of change for the 35 session-keyed tables is `(table, session_id)`: a session is pushed
when its fingerprint (ingest status, analytics status, trail census, per-table row counts)
differs or it is absent remotely, and deleted remotely when it no longer exists locally. The
season/driver aggregates without a `session_id` are diffed row by row on their primary key and
upserted or deleted. Three tables never leave the laptop (`EXCLUDE_TABLES`); `ingest_runs` is
the one exception forced by the schema -- `session_ingests.run_id` is a NOT NULL foreign key to
it -- so it crosses as stub rows with the hostname, the argument list and the error blanked.

Refusals happen before any write and are loud: a migration ledger that differs (exit 2, names
`scripts/neon_migrate.sh`), a table this script has no rule for (exit 2), a credential file
that is not mode 600 (exit 2), or the update lock held by another run (exit 2).

    .venv/bin/python scripts/push_remote.py                 # diff and push
    .venv/bin/python scripts/push_remote.py --dry-run       # print the plan, write nothing
    .venv/bin/python scripts/push_remote.py --verify-only   # remote == local ?
    .venv/bin/python scripts/push_remote.py --full          # every session, every aggregate row
    .venv/bin/python scripts/push_remote.py --sessions 2026:17   # remove one round remotely

Exit codes: 0 nothing to do or pushed and verified; 1 push or verification failed;
2 refused before writing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import re
import stat
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "output" / "update_season.lock"
LAST_PUSH = ROOT / "output" / "last_push.json"
SNAPSHOT_DIR = ROOT / "output" / "snapshots"
SNAPSHOT_KEEP = 7
CONTAINER = "f1-postgres"
REMOTE_ENV = Path.home() / ".config" / "f1analytics" / "remote.env"
REMOTE_ENV_KEY = "REMOTE_DATABASE_URL"
LOCAL_DSN = os.environ.get("DATABASE_URL", "postgres://f1:f1@localhost:5432/f1")

# Never diffed, never copied. `ingest_runs` is listed here because its content (hostname,
# argument lists, error text) must not leave the laptop; see STUB_TABLES for the rows that do.
EXCLUDE_TABLES = frozenset({"ingest_runs", "ask_query_log", "ask_answer_cache"})
# Sequences the push never reads or sets. Production owns `ask_query_log` entirely.
UNTOUCHED_SEQUENCES = frozenset({"ask_query_log_ask_id_seq"})
# Written by the push after every successful apply, never diffed.
RELEASE_TABLE = "data_release"
# An excluded table that a pushed table references through a NOT NULL foreign key: its rows
# cross as stubs, every sensitive column rewritten by SCRUB.
STUB_TABLES = frozenset({"ingest_runs"})
# Column -> SQL expression used in place of the column when rows leave the laptop.
SCRUB: dict[str, dict[str, str]] = {
    "session_ingests": {"error": "NULL::text"},
    "ingest_runs": {"hostname": "NULL::text", "error": "NULL::text", "cli_args": "'{}'::jsonb"},
}
SESSION_KEY = "session_id"
BACKOFF = (30, 120, 300)
# Tables without a `session_id`, replaced row by row on their primary key. This list is a
# decision, not a discovery: a new table that carries no `session_id` and is not named here
# is refused until somebody classifies it (keyed, whole, excluded or push-owned).
WHOLE_TABLES = frozenset({
    'assumption_sets', 'circuit_corners', 'circuit_layout', 'circuit_odi', 'circuits',
    'constructor_standings', 'driver_season_summary', 'driver_standings', 'drivers', 'events',
    'mode2_car_hazard', 'mode2_car_rating', 'mode2_career_season', 'mode2_component',
    'mode2_counterfactual', 'mode2_driver_contrast', 'mode2_driver_rating',
    'mode2_driver_rating_history', 'mode2_driver_skill', 'mode2_fit_run', 'mode2_points_calib',
    'preview_backtest', 'preview_finish_order', 'preview_round', 'season_quali_h2h', 'seasons',
    'sim_circuit_hazard', 'teammate_h2h', 'teams', 'title_clinch', 'title_odds', 'wp_metrics',
    'wp_model_artifact', 'wp_reliability_bin', 'wp_run',
})

log = logging.getLogger("push_remote")


class Refusal(Exception):
    """Raised before any remote write; the CLI maps it to exit 2."""


def redact(text: str) -> str:
    """Strip the password from any DSN that found its way into a message."""
    return re.sub(r"(://[^:/@\s]+:)[^@\s]+@", r"\1***@", str(text))


def load_remote_dsn(path: Path = REMOTE_ENV, env: dict[str, str] | None = None) -> str | None:
    """The push credential: the environment, else `~/.config/f1analytics/remote.env`.

    The file must be a regular file owned by this user with mode exactly 0600 (F6). Anything
    looser is a refusal rather than a warning, because the value is the only secret the nightly
    job holds and a group- or world-readable file is how it would leak.
    """
    env = os.environ if env is None else env
    if env.get(REMOTE_ENV_KEY):
        log.info("target credential: %s from the environment", REMOTE_ENV_KEY)
        return env[REMOTE_ENV_KEY]
    if not path.exists():
        return None
    st = path.stat()
    if not stat.S_ISREG(st.st_mode):
        raise Refusal(f"{path} is not a regular file")
    if st.st_uid != os.getuid():
        raise Refusal(f"{path} is not owned by uid {os.getuid()}")
    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o600:
        raise Refusal(f"{path} is mode {mode:04o}; it must be 0600 (chmod 600 {path})")
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith(REMOTE_ENV_KEY + "="):
            value = line.split("=", 1)[1].strip().strip("'\"")
            log.info("target credential: %s from %s", REMOTE_ENV_KEY, path)
            return value or None
    return None


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal", "f1-postgres"}


def target_host(dsn: str) -> str:
    m = re.search(r"@([^/:?]+)", dsn)
    return m.group(1) if m else "?"


def assert_not_local(dsn: str, allow_local: bool) -> None:
    """A production push must never land on a local database by accident (2026-09-21).

    The first production load did exactly that: the credential file still held the test
    target `f1_remote` in the Docker container, the push reported 178 sessions OK and the
    verify reported remote == local -- trivially, since remote WAS local -- while Neon stayed
    empty and the deployed site showed its empty state. The push tool now names its target
    on every run and refuses a local host unless told, in so many words, that local is intended.
    """
    host = target_host(dsn)
    log.info("target host: %s", host)
    if host in LOCAL_HOSTS and not allow_local:
        raise Refusal(f"target host {host!r} is local; a production push never is. "
                      f"Pass --allow-local only for a test database.")


@dataclass
class Table:
    name: str
    columns: list[str]
    pk: list[str]
    parents: set[str] = field(default_factory=set)
    # Columns of a table WITHOUT a `session_id` that reference a keyed table's `session_id`
    # (today: `circuit_layout.ref_session_id`). Their rows must go before, and come back after,
    # the session they point at is replaced, or the parent DELETE is refused by the FK.
    session_refs: list[str] = field(default_factory=list)

    @property
    def keyed(self) -> bool:
        return SESSION_KEY in self.columns


def read_catalogue(conn) -> dict[str, Table]:
    """Every ordinary table in `public`, its columns in order, its primary key, its parents."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT c.relname, a.attname, a.attnum
            FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY c.relname, a.attnum""")
        tables: dict[str, Table] = {}
        for rel, col, _ in cur.fetchall():
            tables.setdefault(rel, Table(rel, [], [])).columns.append(col)
        cur.execute("""
            SELECT c.relname, k.attname
            FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid
            JOIN LATERAL unnest(p.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
            JOIN pg_attribute k ON k.attrelid = c.oid AND k.attnum = u.attnum
            WHERE p.contype = 'p' AND c.relnamespace = 'public'::regnamespace
            ORDER BY c.relname, u.ord""")
        for rel, col in cur.fetchall():
            tables[rel].pk.append(col)
        cur.execute("""
            SELECT c.relname, r.relname,
                   (SELECT a.attname FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum = p.conkey[1]),
                   (SELECT a.attname FROM pg_attribute a
                    WHERE a.attrelid = r.oid AND a.attnum = p.confkey[1]),
                   cardinality(p.conkey)
            FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid
            JOIN pg_class r ON r.oid = p.confrelid
            WHERE p.contype = 'f' AND c.relnamespace = 'public'::regnamespace""")
        for rel, parent, col, pcol, width in cur.fetchall():
            if rel != parent:
                tables[rel].parents.add(parent)
            child = tables[rel]
            if (width == 1 and pcol == SESSION_KEY and not child.keyed
                    and tables[parent].keyed and col not in child.session_refs):
                child.session_refs.append(col)
    return tables


@dataclass
class Split:
    keyed: list[Table]
    whole: list[Table]          # WHOLE_TABLES plus the stubs, in name order
    excluded: list[str]
    release: bool               # RELEASE_TABLE present


def classify(cat: dict[str, Table]) -> Split:
    """Every table gets exactly one rule or the run is refused before it touches anything."""
    keyed, whole, excluded, unknown, release = [], [], [], [], False
    for name in sorted(cat):
        t = cat[name]
        if name == RELEASE_TABLE:
            release = True
        elif name in STUB_TABLES:
            whole.append(t)
        elif name in EXCLUDE_TABLES:
            excluded.append(name)
        elif t.keyed:
            keyed.append(t)
        elif name in WHOLE_TABLES:
            whole.append(t)
        else:
            unknown.append(name)
    if unknown:
        raise Refusal("unclassified table " + ", ".join(unknown)
                      + " (no session_id and not in WHOLE_TABLES / EXCLUDE_TABLES)")
    for t in keyed + whole:
        if not t.pk:
            raise Refusal(f"table {t.name} has no primary key")
    return Split(keyed, whole, excluded, release)


def fk_order(tables: list[Table]) -> list[Table]:
    """Parents first, from the foreign keys among these tables. Reverse it for deletes."""
    names = {t.name for t in tables}
    by = {t.name: t for t in tables}
    pending = {t.name: {p for p in t.parents if p in names} for t in tables}
    out: list[Table] = []
    while pending:
        ready = sorted(n for n, deps in pending.items() if not deps)
        if not ready:
            raise Refusal("foreign-key cycle among " + ", ".join(sorted(pending)))
        for n in ready:
            out.append(by[n])
            del pending[n]
        for deps in pending.values():
            deps.difference_update(ready)
    return out


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def row_expr(t: Table, scrubbed: bool) -> str:
    """`ROW(c1, c2, ...)` over every column in order; the laptop side substitutes SCRUB."""
    subs = SCRUB.get(t.name, {}) if scrubbed else {}
    return "ROW(" + ", ".join(subs.get(c, _q(c)) for c in t.columns) + ")"


def key_expr(t: Table) -> str:
    return "ROW(" + ", ".join(_q(c) for c in t.pk) + ")::text"


def _settings(conn) -> None:
    """Identical text rendering on both sides, so hashes and record literals agree."""
    with conn.cursor() as cur:
        cur.execute("SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres'; "
                    "SET TimeZone = 'UTC'; SET extra_float_digits = 3; SET bytea_output = 'hex'")


def migrations(conn) -> list[str]:
    with conn.cursor() as cur:
        # Hashes only, in apply order. The serial `id` is bookkeeping: a migration that was
        # applied and rolled back consumes a number on one side and not the other, and the
        # local ledger already skips id 10 for exactly that reason while Neon's is contiguous.
        # Comparing ids blocked the first production push over an identical schema (2026-09-21).
        cur.execute("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id")
        return [h for (h,) in cur.fetchall()]


def check_schema(local, remote) -> None:
    """Refuse on any ledger difference, before a single write (§3.2 step 1, §9-D4)."""
    compare_ledgers(migrations(local), migrations(remote))


def compare_ledgers(l: list[str], r: list[str]) -> None:
    """Pure: ordered hash sequences. Equal, or one a strict prefix of the other, or diverged."""
    if l == r:
        return
    if r[:len(l)] == l:
        raise Refusal(f"SCHEMA AHEAD: production has {len(r)} migrations, this machine {len(l)}")
    if l[:len(r)] == r:
        raise Refusal(f"SCHEMA BEHIND: run scripts/neon_migrate.sh "
                      f"(production has {len(r)} migrations, this machine {len(l)})")
    raise Refusal("SCHEMA DIVERGED: the migration ledgers share no common history; "
                  "run scripts/neon_migrate.sh by hand")


def session_fingerprints(conn, keyed: list[Table], scrubbed: bool) -> dict[int, str]:
    """One sha256 per session over everything that can change without a row count moving."""
    facts: dict[int, dict] = {}
    with conn.cursor() as cur:
        for t in keyed:
            cur.execute(f"SELECT {_q(SESSION_KEY)}, count(*) FROM {_q(t.name)} GROUP BY 1")
            for sid, n in cur.fetchall():
                facts.setdefault(int(sid), {})[t.name] = int(n)
        cur.execute("SELECT session_id, status, ingested_at::text, analytics_status::text, "
                    "warnings::text FROM session_ingests")
        for sid, status, at, analytics, warnings in cur.fetchall():
            facts.setdefault(int(sid), {})["_ingest"] = [status, at, analytics, warnings]
        cur.execute("SELECT session_id, trail_status, count(*) FROM lap_corner_speeds "
                    "GROUP BY 1, 2 ORDER BY 1, 2")
        for sid, status, n in cur.fetchall():
            facts.setdefault(int(sid), {}).setdefault("_census", {})[status] = int(n)
    return {sid: hashlib.sha256(json.dumps(f, sort_keys=True).encode()).hexdigest()
            for sid, f in facts.items()}


def whole_fingerprints(conn, whole: list[Table], scrubbed: bool) -> dict[str, tuple[int, str]]:
    """Per aggregate table: (row count, md5 over every row in primary-key order)."""
    out = {}
    with conn.cursor() as cur:
        for t in whole:
            order = ", ".join(_q(c) for c in t.pk)
            cur.execute(f"SELECT count(*), md5(coalesce(string_agg({row_expr(t, scrubbed)}::text, "
                        f"'|' ORDER BY {order}), '')) FROM {_q(t.name)}")
            n, h = cur.fetchone()
            out[t.name] = (int(n), h)
    return out


def row_hashes(conn, t: Table, scrubbed: bool) -> dict[str, str]:
    with conn.cursor() as cur:
        cur.execute(f"SELECT {key_expr(t)}, md5({row_expr(t, scrubbed)}::text) FROM {_q(t.name)}")
        return {k: h for k, h in cur.fetchall()}


@dataclass
class Plan:
    push_sessions: list[int] = field(default_factory=list)
    delete_sessions: list[int] = field(default_factory=list)
    whole: dict[str, tuple[list[str], list[str]]] = field(default_factory=dict)  # (delete, upsert)
    behind: int = 0                                 # sessions production lacks or has stale

    @property
    def empty(self) -> bool:
        return not (self.push_sessions or self.delete_sessions or self.whole)

    def describe(self) -> str:
        rows = sum(len(d) + len(u) for d, u in self.whole.values())
        return (f"{len(self.push_sessions)} session(s) to push, {len(self.delete_sessions)} to "
                f"delete remotely, {len(self.whole)} aggregate table(s) with {rows} row change(s)")


def diff(local, remote, split: Split, full: bool = False) -> Plan:
    """What production must receive to equal this machine. Reads only."""
    plan = Plan()
    lf = session_fingerprints(local, split.keyed, True)
    rf = session_fingerprints(remote, split.keyed, False)
    plan.delete_sessions = sorted(set(rf) - set(lf))
    changed = sorted(s for s, h in lf.items() if rf.get(s) != h)
    plan.behind = len(changed)
    plan.push_sessions = sorted(lf) if full else changed
    lw = whole_fingerprints(local, split.whole, True)
    rw = whole_fingerprints(remote, split.whole, False)
    for t in split.whole:
        if not full and lw[t.name] == rw[t.name]:
            continue
        lrows, rrows = row_hashes(local, t, True), row_hashes(remote, t, False)
        delete = sorted(set(rrows) - set(lrows))
        upsert = sorted(lrows) if full else sorted(k for k, h in lrows.items() if rrows.get(k) != h)
        if delete or upsert:
            plan.whole[t.name] = (delete, upsert)
    return plan


def _chunks(items: list, n: int = 2000):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _upsert_sql(t: Table) -> str:
    cols = ", ".join(_q(c) for c in t.columns)
    pk = ", ".join(_q(c) for c in t.pk)
    rest = [c for c in t.columns if c not in t.pk]
    action = ("DO UPDATE SET " + ", ".join(f"{_q(c)} = EXCLUDED.{_q(c)}" for c in rest)
              if rest else "DO NOTHING")
    return (f"INSERT INTO {_q(t.name)} ({cols}) SELECT (r::{_q(t.name)}).* "
            f"FROM unnest(%s::text[]) AS r ON CONFLICT ({pk}) {action}")


def ref_delete_sql(t: Table, col: str) -> str:
    """Rows of an aggregate table that point at sessions about to be replaced or removed."""
    return f"DELETE FROM {_q(t.name)} WHERE {_q(col)} = ANY(%s)"


def ref_select_sql(t: Table, col: str) -> str:
    """The same rows, from this machine, as record literals for the upsert after the COPY."""
    return f"SELECT {row_expr(t, True)}::text FROM {_q(t.name)} WHERE {_q(col)} = ANY(%s)"


def apply(local, remote, split: Split, plan: Plan, census_sha: str) -> tuple[int, int | None]:
    """Everything in `plan`, in ONE remote transaction: deletes children first, then inserts
    parents first, then the release row. Returns (rows written, release_id)."""
    order = fk_order(split.keyed + split.whole)
    whole_by = {t.name: t for t in split.whole}
    gone = sorted(set(plan.push_sessions) | set(plan.delete_sessions))
    rows = 0
    with remote.transaction(), remote.cursor() as rc, local.cursor() as lc:
        for t in reversed(order):
            if t.keyed and gone:
                rc.execute(f"DELETE FROM {_q(t.name)} WHERE {_q(SESSION_KEY)} = ANY(%s)", (gone,))
                continue
            for col in t.session_refs if gone else ():
                rc.execute(ref_delete_sql(t, col), (gone,))
            if t.name in plan.whole and plan.whole[t.name][0]:
                rc.execute(f"DELETE FROM {_q(t.name)} WHERE {key_expr(t)} = ANY(%s)",
                           (plan.whole[t.name][0],))
        for t in order:
            if not t.keyed:
                for col in t.session_refs if plan.push_sessions else ():
                    lc.execute(ref_select_sql(t, col), (plan.push_sessions,))
                    literals = [r[0] for r in lc.fetchall()]
                    if literals:
                        rc.execute(_upsert_sql(t), (literals,))
                        rows += len(literals)
                if t.name in plan.whole and plan.whole[t.name][1]:
                    for keys in _chunks(plan.whole[t.name][1]):
                        lc.execute(f"SELECT {row_expr(t, True)}::text FROM {_q(t.name)} "
                                   f"WHERE {key_expr(t)} = ANY(%s)", (keys,))
                        literals = [r[0] for r in lc.fetchall()]
                        rc.execute(_upsert_sql(t), (literals,))
                        rows += len(literals)
            elif t.keyed and plan.push_sessions:
                cols = ", ".join(_q(c) for c in t.columns)
                subs = SCRUB.get(t.name, {})
                src = ", ".join(subs.get(c, _q(c)) for c in t.columns)
                with lc.copy(f"COPY (SELECT {src} FROM {_q(t.name)} WHERE {_q(SESSION_KEY)} = "
                             f"ANY(%s)) TO STDOUT (FORMAT binary)", (plan.push_sessions,)) as out, \
                        rc.copy(f"COPY {_q(t.name)} ({cols}) FROM STDIN (FORMAT binary)") as inp:
                    for data in out:
                        inp.write(data)
                rows += rc.rowcount if rc.rowcount and rc.rowcount > 0 else 0
        release_id = None
        if split.release:
            rc.execute(f"INSERT INTO {_q(RELEASE_TABLE)} (pushed_at, sessions_pushed, rows_pushed, "
                       "census_sha256) VALUES (now(), %s, %s, %s) RETURNING release_id",
                       (len(plan.push_sessions), rows, census_sha))
            release_id = int(rc.fetchone()[0])
    return rows, release_id


def census_sha(fps: dict[int, str]) -> str:
    return hashlib.sha256(json.dumps(sorted(fps.items())).encode()).hexdigest()


def verify(local, remote, split: Split, sessions: list[int] | None = None) -> list[str]:
    """After COMMIT (or on --verify-only): production must equal this machine, and the two
    privilege invariants of §4.2 plus the untouched ask sequence must hold. Empty = OK."""
    bad: list[str] = []
    lf = session_fingerprints(local, split.keyed, True)
    rf = session_fingerprints(remote, split.keyed, False)
    for s in sorted(set(lf) | set(rf)) if sessions is None else sessions:
        if lf.get(s) != rf.get(s):
            bad.append(f"session {s}: " + ("absent remotely" if s not in rf else
                                            "absent locally" if s not in lf else "fingerprint differs"))
    lw = whole_fingerprints(local, split.whole, True)
    rw = whole_fingerprints(remote, split.whole, False)
    for name in lw:
        if lw[name] != rw[name]:
            bad.append(f"table {name}: {lw[name][0]} rows locally, {rw[name][0]} remotely, "
                       + ("same" if lw[name][1] == rw[name][1] else "different") + " content")
    with remote.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'f1_ask'")
        if cur.fetchone() is None:
            bad.append("role f1_ask does not exist remotely")
        else:
            cur.execute("SELECT has_schema_privilege('f1_ask', 'public', 'USAGE'), "
                        "has_schema_privilege('f1_ask', 'ask', 'USAGE')")
            pub, ask = cur.fetchone()
            if pub:
                bad.append("f1_ask has USAGE on schema public (must be false)")
            if not ask:
                bad.append("f1_ask lacks USAGE on schema ask (must be true)")
        # The ask log is production's own; `f1_push` may lack SELECT on it by design (§4.2),
        # in which case this invariant is simply not this credential's to check.
        cur.execute("SAVEPOINT seq_check")
        try:
            cur.execute("SELECT coalesce((SELECT last_value FROM pg_sequences WHERE schemaname "
                        "= 'public' AND sequencename = 'ask_query_log_ask_id_seq'), 0), "
                        "coalesce((SELECT max(ask_id) FROM ask_query_log), 0)")
            last, mx = cur.fetchone()
            if int(last) < int(mx):
                bad.append(f"ask_query_log_ask_id_seq.last_value {last} < max(ask_id) {mx}")
        except Exception as e:
            cur.execute("ROLLBACK TO SAVEPOINT seq_check")
            if "permission denied" not in str(e):
                raise
            log.info("ask sequence invariant not checked: this role has no SELECT on the ask log")
    return bad


def snapshot(local_dsn: str, keep: int = SNAPSHOT_KEEP) -> Path:
    """`output/snapshots/f1-YYYYMMDD.dump` from the container's pg_dump, before any write;
    the rollback in RUNBOOK §9 restores it locally and re-runs `--full`. Last `keep` kept."""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    dbname = local_dsn.rsplit("/", 1)[-1].split("?", 1)[0] or "f1"
    path = SNAPSHOT_DIR / f"{dbname}-{dt.date.today():%Y%m%d}.dump"
    with open(path, "wb") as fh:
        p = subprocess.run(["docker", "exec", CONTAINER, "pg_dump", "-U", "f1", "-d", dbname,
                            "-Fc"], stdout=fh, stderr=subprocess.PIPE)
    if p.returncode != 0 or path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        raise RuntimeError("snapshot failed: " + redact(p.stderr.decode(errors="replace")[-300:]))
    for old in sorted(SNAPSHOT_DIR.glob(f"{dbname}-*.dump"))[:-keep]:
        old.unlink()
    return path


def resolve_sessions(local, spec: str) -> list[int]:
    """`YEAR:ROUND[,YEAR:ROUND...]` -> session ids, from this machine's `sessions` table."""
    out: list[int] = []
    with local.cursor() as cur:
        for item in spec.split(","):
            year, rnd = item.split(":")
            cur.execute("SELECT session_id FROM sessions WHERE year = %s AND round = %s ORDER BY 1",
                        (int(year), int(rnd)))
            found = [int(r[0]) for r in cur.fetchall()]
            if not found:
                raise Refusal(f"no session for {item} on this machine")
            out.extend(found)
    return out


def _connect(dsn: str, what: str):
    import psycopg
    try:
        conn = psycopg.connect(dsn, connect_timeout=20, application_name="f1analytics-push")
    except psycopg.Error as e:
        raise ConnectionError(f"{what} unreachable: {redact(e)}") from e
    _settings(conn)
    conn.commit()
    return conn


def _same_shape(split: Split, remote_cat: dict[str, Table]) -> None:
    for t in split.keyed + split.whole:
        r = remote_cat.get(t.name)
        if r is None:
            raise Refusal(f"SCHEMA MISMATCH: table {t.name} missing remotely")
        if r.columns != t.columns or r.pk != t.pk:
            raise Refusal(f"SCHEMA MISMATCH: table {t.name} has different columns remotely")


def _attempt(local_dsn: str, remote_dsn: str, *, full: bool, dry_run: bool, verify_only: bool,
             sessions: str | None, state: dict) -> tuple[int, str]:
    """One try of the whole procedure; ConnectionError and psycopg errors are retried by push()."""
    import psycopg
    started = time.monotonic()
    with _connect(local_dsn, "local database") as local, _connect(remote_dsn, "production") as remote:
        local.read_only = True          # this side is only ever read
        split = classify(read_catalogue(local))
        _same_shape(split, read_catalogue(remote))
        check_schema(local, remote)
        state.setdefault("split", split)
        if verify_only:
            try:
                bad = verify(local, remote, split)
            except psycopg.Error as e:
                return 1, "VERIFY FAILED: " + redact(e)
            if bad:
                return 1, "VERIFY FAILED: " + "; ".join(bad[:8])
            return 0, (f"remote == local ({len(split.keyed)} session-keyed tables, "
                       f"{len(split.whole)} aggregate tables); privilege invariants OK")
        if sessions:
            plan = Plan(delete_sessions=resolve_sessions(local, sessions))
            plan.behind = 0
        else:
            plan = diff(local, remote, split, full=full)
        state["behind"] = plan.behind
        if plan.empty:
            _write_last_push(0, 0, True, None)
            return 0, "nothing to do"
        log.info("plan: %s", plan.describe())
        if dry_run:
            return 0, "DRY RUN (nothing written): " + plan.describe()
        if not state.get("snapshot"):
            state["snapshot"] = snapshot(local_dsn)
            log.info("snapshot: %s", state["snapshot"])
        sha = census_sha(session_fingerprints(local, split.keyed, True))
        try:
            rows, release_id = apply(local, remote, split, plan, sha)
        except psycopg.Error as e:
            raise ConnectionError(f"apply rolled back: {redact(e)}") from e
        secs = time.monotonic() - started
        try:
            if sessions:
                left = set(session_fingerprints(remote, split.keyed, False)) & set(plan.delete_sessions)
                bad = [f"session {s} still present remotely" for s in sorted(left)]
            else:
                bad = verify(local, remote, split, plan.push_sessions)
        except psycopg.Error as e:               # committed, but the read-back itself failed
            bad = ["read-back failed: " + redact(e)]
        if bad:
            _write_last_push(len(plan.push_sessions), rows, False, release_id)
            return 1, "PUSH VERIFY FAILED: " + "; ".join(bad[:8])
        _write_last_push(len(plan.push_sessions), rows, True, release_id)
        if sessions:
            return 0, f"OK removed {len(plan.delete_sessions)} session(s) remotely, {secs:.0f}s"
        return 0, f"OK {len(plan.push_sessions)} sessions, {rows:,} rows, {secs:.0f}s"


def _write_last_push(sessions: int, rows: int, ok: bool, release_id: int | None) -> None:
    LAST_PUSH.parent.mkdir(exist_ok=True)
    LAST_PUSH.write_text(json.dumps({
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "sessions": sessions, "rows": rows, "ok": ok, "release_id": release_id}, indent=1))


def push(local_dsn: str = LOCAL_DSN, remote_dsn: str | None = None, *, full: bool = False,
         retries: int = 3, dry_run: bool = False, verify_only: bool = False,
         sessions: str | None = None, backoff: tuple[float, ...] = BACKOFF) -> tuple[int, str]:
    """The importable entry point (step 4 of update_season.py). Returns (exit code, summary):
    "nothing to do" | "OK n sessions, r rows, s" | "FAILED: ..." | "SCHEMA BEHIND: ..." ."""
    if not remote_dsn:
        return 2, f"REFUSED: no {REMOTE_ENV_KEY}"
    state: dict = {}
    attempts = 1 + max(0, retries)
    last = "unknown"
    for i in range(attempts):
        try:
            return _attempt(local_dsn, remote_dsn, full=full, dry_run=dry_run,
                            verify_only=verify_only, sessions=sessions, state=state)
        except Refusal as e:
            msg = str(e)
            return 2, msg if msg.startswith("SCHEMA") else "REFUSED: " + msg
        except (ConnectionError, OSError, RuntimeError) as e:
            last = redact(e)
            log.warning("attempt %d/%d failed: %s", i + 1, attempts, last)
            if i + 1 < attempts:
                wait = backoff[min(i, len(backoff) - 1)] if backoff else 0
                log.info("retrying in %.0fs", wait)
                time.sleep(wait)
    behind = state.get("behind")
    where = f"{behind} session(s)" if behind is not None else "an unknown number of sessions"
    _write_last_push(0, 0, False, None)
    return 1, f"FAILED: production is {where} behind: {last}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="push every session and aggregate row")
    ap.add_argument("--sessions", metavar="YEAR:ROUND[,..]",
                    help="remove these rounds from production (rollback of one push)")
    ap.add_argument("--verify-only", action="store_true", help="compare, write nothing")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--allow-local", action="store_true",
                    help="permit a localhost/container target (test databases only)")
    ap.add_argument("--remote-env", type=Path, default=REMOTE_ENV,
                    help=f"file holding {REMOTE_ENV_KEY} (mode 600)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        remote = load_remote_dsn(a.remote_env)
        if remote:
            assert_not_local(remote, getattr(a, 'allow_local', False))
    except Refusal as e:
        log.error("push: REFUSED: %s", e)
        return 2
    if not remote:
        log.error("push: no %s in the environment or %s", REMOTE_ENV_KEY, a.remote_env)
        return 2
    writes = not (a.verify_only or a.dry_run)
    fd = None
    if writes:
        LOCK.parent.mkdir(exist_ok=True)
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            log.error("push: REFUSED: %s is held by another run", LOCK)
            return 2
        os.write(fd, f"{os.getpid()} push_remote\n".encode())
        os.close(fd)
    try:
        rc, summary = push(LOCAL_DSN, remote, full=a.full, retries=a.retries, dry_run=a.dry_run,
                           verify_only=a.verify_only, sessions=a.sessions)
    finally:
        if fd is not None:
            LOCK.unlink(missing_ok=True)
    (log.error if rc else log.info)("push: %s", summary)
    if rc == 1 and summary.startswith("FAILED"):
        log.error("PUSH FAILED")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
