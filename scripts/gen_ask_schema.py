#!/usr/bin/env python3
"""Generate the three artifacts of the ask contract from one source (MODE3_SPEC §1.2, §2.2).

    scripts/ask_manifest.yml  +  live information_schema  +  f1lab.frames.TABLE_COLUMNS
        |
        +-- scripts/sql/0005_ask_views.sql   61 CREATE OR REPLACE VIEW + the enumerated GRANT
        +-- web/lib/ask/schema-doc.txt       the cached prompt prefix, in §2.3 order
        +-- web/lib/ask/ask-objects.json     {view: [{col, type}]} - the validator's allowlist

The model's picture of the database, the validator's allowlist and the actual grants are
therefore the same object and cannot drift apart. Nothing here is hand-written.

How types are obtained: the generated DDL is compiled into a throwaway probe schema inside a
transaction that is ALWAYS rolled back, and the resulting view columns are read from
pg_catalog. That gives exact types for the curated views (which are joins and aggregates, not
column projections) and proves at generation time that every statement in the emitted file
actually parses and plans. The real `ask` schema is never touched by this script.

Usage:
    python scripts/gen_ask_schema.py            # write the three artifacts
    python scripts/gen_ask_schema.py --check     # regenerate in memory, diff, exit 1 on drift
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import psycopg
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from f1lab import db  # noqa: E402
from f1lab.frames import TABLE_COLUMNS  # noqa: E402

MANIFEST = ROOT / "scripts" / "ask_manifest.yml"
OUT_SQL = ROOT / "scripts" / "sql" / "0005_ask_views.sql"
OUT_DOC = ROOT / "web" / "lib" / "ask" / "schema-doc.txt"
OUT_JSON = ROOT / "web" / "lib" / "ask" / "ask-objects.json"

PROBE_SCHEMA = "ask_gen_probe"
GENERATED_BY = "scripts/gen_ask_schema.py"

# Wide, high-grain views the model must never star-select (named in the dialect rules too).
LAP_GRAIN = ("laps", "wp_lap_probability", "weather_samples")

# format_type() output -> the short name used in the prompt document and in ask-objects.json.
TYPE_SHORT = {
    "integer": "int",
    "bigint": "bigint",
    "smallint": "int",
    "double precision": "float",
    "real": "real",
    "numeric": "numeric",
    "text": "text",
    "boolean": "bool",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "date": "date",
    "jsonb": "jsonb",
    "json": "json",
    "bytea": "bytea",
    "text[]": "text[]",
    "double precision[]": "float[]",
    "integer[]": "int[]",
    "character varying": "text",
}


def short_type(formatted: str) -> str:
    return TYPE_SHORT.get(formatted, formatted)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def load_manifest() -> dict:
    with MANIFEST.open() as fh:
        return yaml.safe_load(fh)


def base_tables(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
        )
        return [r[0] for r in cur.fetchall()]


def public_columns(conn) -> dict[str, list[tuple[str, str]]]:
    """{table: [(column, formatted_type)]} in DDL order, from pg_catalog."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) "
            "  FROM pg_class c "
            "  JOIN pg_namespace n ON n.oid = c.relnamespace "
            "  JOIN pg_attribute a ON a.attrelid = c.oid "
            " WHERE n.nspname = 'public' AND c.relkind = 'r' "
            "   AND a.attnum > 0 AND NOT a.attisdropped "
            " ORDER BY c.relname, a.attnum"
        )
        out: dict[str, list[tuple[str, str]]] = {}
        for table, column, formatted in cur.fetchall():
            out.setdefault(table, []).append((column, formatted))
    return out


def partition_tables(manifest: dict, live: list[str]) -> list[str]:
    """The 57 included tables, and a hard failure if the manifest and the database disagree."""
    excluded = set(manifest["exclude_tables"]) | set(manifest["exclude_mode3_tables"])
    declared = set(manifest["tables"])
    live_set = set(live)

    problems = []
    missing_in_db = sorted(declared - live_set)
    if missing_in_db:
        problems.append(f"manifest names tables that do not exist: {missing_in_db}")
    unclassified = sorted(live_set - declared - excluded)
    if unclassified:
        problems.append(
            "these base tables are neither included nor excluded by the manifest - classify "
            f"them before regenerating: {unclassified}"
        )
    excluded_but_absent = sorted(excluded - live_set - set(manifest["exclude_mode3_tables"]))
    if excluded_but_absent:
        problems.append(f"manifest excludes tables that do not exist: {excluded_but_absent}")
    if problems:
        raise SystemExit("ask manifest is out of sync with the database:\n  " + "\n  ".join(problems))
    return sorted(declared)


def cross_check_frames(included: list[str], live_cols: dict[str, list[tuple[str, str]]]) -> None:
    """The same discipline db.assert_schema applies: frames.TABLE_COLUMNS must agree."""
    problems = []
    for table in included:
        if table not in TABLE_COLUMNS:
            continue  # web-owned or hand-maintained table; the database is the authority
        expected = [c for c, _ in TABLE_COLUMNS[table]]
        actual = [c for c, _ in live_cols[table]]
        if expected != actual:
            problems.append(f"{table}: frames.TABLE_COLUMNS {expected} != database {actual}")
    if problems:
        raise SystemExit("frames.TABLE_COLUMNS disagrees with the database:\n  " + "\n  ".join(problems))


# ---------------------------------------------------------------------------
# Artifact 1: scripts/sql/0005_ask_views.sql
# ---------------------------------------------------------------------------

def view_sql(schema: str, table: str, columns: list[str]) -> str:
    """CREATE VIEW <schema>.<t> AS SELECT <explicit column list> FROM public.<t>; never SELECT *."""
    body = ",\n         ".join(columns)
    return (
        f"CREATE OR REPLACE VIEW {schema}.{table} AS\n"
        f"  SELECT {body}\n"
        f"    FROM public.{table};\n"
    )


def curated_sql(schema: str, view: dict) -> str:
    body = view["body"].format(ask=schema).rstrip().rstrip(";")
    indented = "\n".join("  " + line if line.strip() else "" for line in body.splitlines())
    return f"CREATE OR REPLACE VIEW {schema}.{view['name']} AS\n{indented};\n"


def grant_sql(schema: str, role: str, objects: list[str]) -> str:
    """The enumerated grant. The allowlist IS the grant: a view added to `ask` by hand is not
    queryable until this file is regenerated and re-run. Guarded so a fresh machine can run
    this file before scripts/sql/0005_roles.sql has created the role."""
    names = ",\n           ".join(f"{schema}.{name}" for name in objects)
    return (
        "DO $ask_grant$\n"
        "BEGIN\n"
        f"  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN\n"
        f"    EXECUTE $g$GRANT USAGE ON SCHEMA {schema} TO {role}$g$;\n"
        f"    EXECUTE $g$GRANT SELECT ON\n"
        f"           {names}\n"
        f"      TO {role}$g$;\n"
        "  ELSE\n"
        f"    RAISE NOTICE 'role {role} does not exist yet - run scripts/sql/0005_roles.sql, "
        "then re-run this file so the enumerated GRANT is applied';\n"
        "  END IF;\n"
        "END\n"
        "$ask_grant$;\n"
    )


def build_sql(manifest: dict, schema: str, included: list[str],
              cols: dict[str, list[tuple[str, str]]], objects: list[str],
              *, transaction: bool = True, include_grant: bool = True,
              header: bool = True) -> str:
    excl_cols = manifest.get("exclude_columns") or {}
    role = manifest["role"]
    out = [] if not header else [
        f"-- GENERATED BY {GENERATED_BY} FROM scripts/ask_manifest.yml + the live database.\n"
        "-- DO NOT EDIT. Regenerate with `make db-ask-gen`; tests/test_ask_schema_sync.py fails\n"
        "-- the build if this file differs by one byte from a fresh regeneration.\n"
        "--\n"
        f"-- {len(included)} table-backed views + {len(manifest['curated_views'])} curated views "
        f"= {len(objects)} objects.\n"
        "-- Views are OWNER-RIGHTS (the PostgreSQL default), never security_invoker: that is what\n"
        f"-- lets {role} hold no privilege at all on any base table. They carry no row predicates.\n"
        "--\n"
        "-- Excluded at the GRANT level, so a compromised model gets `permission denied`:\n"
        + "".join(
            f"--   {name:<22} {reason.strip().splitlines()[0]}\n"
            for name, reason in sorted(
                (manifest["exclude_tables"] | manifest["exclude_mode3_tables"]).items()
            )
        )
        + "-- Excluded at the column level:\n"
        + "".join(f"--   {t}.{c}\n" for t, cs in sorted(excl_cols.items()) for c in cs)
    ]
    if transaction:
        out.append("\nBEGIN;\n")
    out.append(f"\nCREATE SCHEMA IF NOT EXISTS {schema};\n")
    out.append(f"\n-- {len(included)} table-backed views\n\n")
    for table in included:
        keep = [c for c, _ in cols[table] if c not in set(excl_cols.get(table, []))]
        out.append(view_sql(schema, table, keep))
        out.append("\n")
    out.append(f"-- {len(manifest['curated_views'])} curated views\n\n")
    for view in manifest["curated_views"]:
        out.append(curated_sql(schema, view))
        out.append("\n")
    if include_grant:
        out.append(f"-- The allowlist IS the grant: {len(objects)} objects, named one by one.\n\n")
        out.append(grant_sql(schema, role, objects))
    if transaction:
        out.append("\nCOMMIT;\n")
    return "".join(out)


# ---------------------------------------------------------------------------
# The probe: compile the generated DDL into a throwaway schema, read the real column types
# back out of pg_catalog, then ROLL BACK. The real `ask` schema is never touched.
# ---------------------------------------------------------------------------

def probe_view_columns(conn, manifest: dict, included: list[str],
                       cols: dict[str, list[tuple[str, str]]],
                       examples: list[str]) -> dict[str, list[dict[str, str]]]:
    ddl = build_sql(manifest, PROBE_SCHEMA, included, cols, [],
                    transaction=False, include_grant=False, header=False)
    out: dict[str, list[dict[str, str]]] = {}
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP SCHEMA IF EXISTS {PROBE_SCHEMA} CASCADE")
            cur.execute(ddl)
            cur.execute(
                "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) "
                "  FROM pg_class c "
                "  JOIN pg_namespace n ON n.oid = c.relnamespace "
                "  JOIN pg_attribute a ON a.attrelid = c.oid "
                " WHERE n.nspname = %s AND c.relkind = 'v' "
                "   AND a.attnum > 0 AND NOT a.attisdropped "
                " ORDER BY c.relname, a.attnum",
                (PROBE_SCHEMA,),
            )
            for view, column, formatted in cur.fetchall():
                out.setdefault(view, []).append({"col": column, "type": short_type(formatted)})
            # Every worked example in the prompt must actually run. A prompt that teaches the
            # model SQL which does not parse is worse than no example at all.
            for i, stmt in enumerate(examples, start=1):
                probed = stmt.replace("ask.", f"{PROBE_SCHEMA}.")
                try:
                    cur.execute(f"EXPLAIN {probed}")
                except psycopg.Error as exc:  # pragma: no cover - a manifest authoring error
                    raise SystemExit(
                        f"worked example {i} in ask_manifest.yml does not plan: {exc}\n{stmt}"
                    ) from exc
    finally:
        conn.rollback()
    return out


# ---------------------------------------------------------------------------
# Artifact 2: web/lib/ask/schema-doc.txt - the cached prompt prefix, in §2.3 order.
#
# NOTHING VOLATILE MAY ENTER THIS FILE except the coverage block, which is volatile across
# ingests on purpose (§2.4): no date, no session id, no request id, no rendering of a
# question. One volatile byte sends the cache hit rate to zero.
# ---------------------------------------------------------------------------

def signature(name: str, columns: list[dict[str, str]]) -> str:
    inner = ", ".join(f"{c['col']} {c['type']}" for c in columns)
    return f"ask.{name}({inner})"


def describe(entry: dict) -> str:
    bits = [entry["purpose"].strip()]
    grain = (entry.get("grain") or "").strip()
    joins = (entry.get("joins") or "").strip()
    if grain:
        bits.append(f"Grain: {grain}.")
    if joins and joins.lower() != "none":
        bits.append(f"Joins: {joins}.")
    return " ".join(bits)


def current_assumption_set(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT assumption_set_id FROM seasons ORDER BY assumption_set_id")
        ids = [r[0] for r in cur.fetchall()]
    if not ids:
        raise SystemExit("no rows in seasons: cannot name the current assumption set")
    return ids[-1]


def coverage_block(conn, asid: int) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT year, ingested_rounds, scheduled_rounds FROM seasons ORDER BY year"
        )
        seasons = cur.fetchall()
        cur.execute(
            "SELECT status, count(*) FROM session_ingests GROUP BY status ORDER BY status"
        )
        by_status = cur.fetchall()
        n_sessions = sum(n for _, n in by_status)
        cur.execute("SELECT count(*) FROM laps")
        (n_laps,) = cur.fetchone()
        # v1.6: `laps` is no longer race-only, so a bare total invites the model to read it as
        # a race-lap count. Split it, and name the kinds, in the one block it always reads.
        cur.execute(
            "SELECT s.kind, count(*) FROM sessions s JOIN session_ingests si USING (session_id) "
            "GROUP BY 1 ORDER BY 1"
        )
        by_kind = cur.fetchall()
        cur.execute(
            "SELECT count(*) FROM laps l JOIN sessions s USING (session_id) "
            "WHERE s.kind IN ('Q','SQ')"
        )
        (n_quali_laps,) = cur.fetchone()
    lines = ["COVERAGE", "What this database actually contains:"]
    for year, ingested, scheduled in seasons:
        state = "complete" if ingested >= scheduled else f"through round {ingested}"
        lines.append(f"  {year}: {state} ({ingested} of {scheduled} rounds ingested)")
    first_year = seasons[0][0]
    gloss = {"partial": " (rain-shortened or incomplete)", "failed": " (no usable laps)"}
    breakdown = ", ".join(f"{n} {status}{gloss.get(status, '')}" for status, n in by_status)
    kinds = ", ".join(f"{n} {k}" for k, n in by_kind)
    lines.append(f"  {n_sessions} ingested sessions ({kinds}): {breakdown}.")
    lines.append(
        f"  {n_laps:,} laps in total, of which {n_quali_laps:,} are QUALIFYING laps (kind 'Q' or "
        f"'SQ') and {n_laps - n_quali_laps:,} are race or sprint laps. An aggregate over "
        f"ask.laps without a kind filter mixes the two and is almost always wrong."
    )
    lines.append(
        f"  THERE IS NO DATA BEFORE {first_year}. A question about an earlier season, or about a "
        f"round that has not happened yet, is out of scope - refuse it, do not answer it with an "
        f"empty table."
    )
    lines.append(
        f"  The current assumption set is assumption_set_id = {asid}. Filter every analytics view "
        f"to it."
    )
    return "\n".join(lines) + "\n"


def vocabulary_block(conn) -> str:
    with conn.cursor() as cur:
        # Only identities that actually appear in a session are listed. An id with no
        # session_entries / session_teams row cannot be matched by any query the model can
        # write, so printing it is misinformation, not coverage. This is not hypothetical:
        # v1.6's qualifying backfill left orphan `drivers.driver_id = 'nan'` (Oliver Bearman)
        # and `teams.team_id = 'nan'` (Haas) rows behind, duplicates of the real `bearman` and
        # `haas` rows, and an unfiltered vocabulary taught the model to write `= 'nan'`.
        cur.execute(
            "SELECT d.driver_id, coalesce(d.latest_code, '???'), d.full_name "
            "  FROM drivers d "
            " WHERE EXISTS (SELECT 1 FROM session_entries se WHERE se.driver_id = d.driver_id) "
            " ORDER BY d.driver_id"
        )
        drivers = cur.fetchall()
        cur.execute(
            "SELECT t.team_id, t.latest_name "
            "  FROM teams t "
            " WHERE EXISTS (SELECT 1 FROM session_teams st WHERE st.team_id = t.team_id) "
            " ORDER BY t.team_id"
        )
        teams = cur.fetchall()
        cur.execute(
            "SELECT circuit_key, short_name, location, country FROM circuits ORDER BY circuit_key"
        )
        circuits = cur.fetchall()
    lines = [f"Drivers ({len(drivers)}), as driver_id / code / name:"]
    lines += [f"  {d} / {c} / {n}" for d, c, n in drivers]
    lines.append(f"Teams ({len(teams)}), as team_id / latest_name:")
    lines += [f"  {t} / {n}" for t, n in teams]
    lines.append(f"Circuits ({len(circuits)}), as circuit_key / short_name / location / country:")
    lines += [f"  {k} / {s} / {loc} / {country}" for k, s, loc, country in circuits]
    return "\n".join(lines) + "\n"


def examples_block(manifest: dict, asid: int) -> str:
    lines = [
        "WORKED EXAMPLES",
        "These are the shapes that are right. Copy their habits: schema-qualified names, an",
        "assumption-set filter, an explicit LIMIT, a minimum-sample HAVING where one is needed,",
        "and a refusal where the data does not exist.",
        "",
    ]
    for i, ex in enumerate(manifest["examples"], start=1):
        lines.append(f"Q{i}. {ex['question'].strip()}")
        if ex.get("refuse"):
            lines.append("  -> REFUSE. This is out of scope.")
        else:
            sql = ex["sql"].format(asid=asid).strip()
            lines += ["  " + line for line in sql.splitlines()]
        lines.append(f"  Why: {ex['note'].strip()}")
        lines.append("")
    return "\n".join(lines)


def example_statements(manifest: dict, asid: int) -> list[str]:
    return [
        ex["sql"].format(asid=asid).strip().rstrip(";")
        for ex in manifest["examples"]
        if not ex.get("refuse")
    ]


def build_doc(conn, manifest: dict, included: list[str], objects: list[str],
              view_cols: dict[str, list[dict[str, str]]], asid: int) -> str:
    prose = manifest["prose"]
    curated = {v["name"]: v for v in manifest["curated_views"]}
    parts = [
        prose["dialect_rules"].rstrip() + "\n",
        "",
        f"THE {len(objects)} OBJECTS YOU MAY QUERY",
        f"{len(included)} views over the analytics tables, then "
        f"{len(curated)} curated views. Each signature is followed by what the view is for, its",
        "grain, and the keys it joins on.",
        "",
    ]
    for name in included:
        parts.append(signature(name, view_cols[name]))
        parts.append("  " + describe(manifest["tables"][name]))
    parts.append("")
    for view in manifest["curated_views"]:
        parts.append(signature(view["name"], view_cols[view["name"]]))
        parts.append("  " + describe(view))
    parts += [
        "",
        prose["conventions"].rstrip(),
        "",
        prose["identity_rule"].rstrip(),
        "",
        vocabulary_block(conn).rstrip(),
        "",
        coverage_block(conn, asid).rstrip(),
        "",
        examples_block(manifest, asid).rstrip(),
        "",
        prose["non_grants"].rstrip(),
        "",
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Artifact 3: web/lib/ask/ask-objects.json - the validator's allowlist
# ---------------------------------------------------------------------------

def build_objects_json(objects: list[str], view_cols: dict[str, list[dict[str, str]]]) -> str:
    payload = {f"ask.{name}": view_cols[name] for name in objects}
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# Drive
# ---------------------------------------------------------------------------

def generate() -> dict[Path, str]:
    manifest = load_manifest()
    schema = manifest["schema"]
    with db.connect() as conn:
        live = base_tables(conn)
        included = partition_tables(manifest, live)
        cols = public_columns(conn)
        cross_check_frames(included, cols)
        objects = included + [v["name"] for v in manifest["curated_views"]]
        asid = current_assumption_set(conn)
        view_cols = probe_view_columns(conn, manifest, included, cols,
                                       example_statements(manifest, asid))
        missing = [name for name in objects if name not in view_cols]
        if missing:
            raise SystemExit(f"probe did not produce these views: {missing}")
        # The no-star rule only bites if the wide views are named where the model reads it.
        rules = manifest["prose"]["dialect_rules"]
        unnamed = [v for v in LAP_GRAIN if v not in objects or v not in rules]
        if unnamed:
            raise SystemExit(
                "these lap-grain views are not named in the never-SELECT-* rule: " f"{unnamed}"
            )
        artifacts = {
            OUT_SQL: build_sql(manifest, schema, included, cols, objects),
            OUT_DOC: build_doc(conn, manifest, included, objects, view_cols, asid),
            OUT_JSON: build_objects_json(objects, view_cols),
        }
    return artifacts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="regenerate in memory and fail if the committed files differ")
    args = ap.parse_args()

    artifacts = generate()
    if args.check:
        drift = []
        for path, text in artifacts.items():
            current = path.read_text() if path.exists() else None
            if current != text:
                drift.append(str(path.relative_to(ROOT)))
        if drift:
            print("ask contract is stale, regenerate with `make db-ask-gen`:", file=sys.stderr)
            for name in drift:
                print(f"  {name}", file=sys.stderr)
            return 1
        print("ask contract is up to date")
        return 0

    for path, text in artifacts.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        print(f"{str(path.relative_to(ROOT)):<40} {len(text):>7,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
