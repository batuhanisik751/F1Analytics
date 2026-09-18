"""The thin psycopg 3 layer: connect, verify the schema, COPY, upsert, delete.

Drizzle Kit (in ``web/``) owns the DDL. Python never issues a CREATE or ALTER; it
verifies the live ``information_schema`` against ``frames.EXPECTED_COLUMNS`` before
writing a single row and refuses to run otherwise, so a drift between the two
sides fails loudly with the table and column names rather than mid-COPY.
"""

from __future__ import annotations

import os
from typing import Iterable

import psycopg
from psycopg import sql

from . import frames

DEFAULT_DSN = "postgres://f1:f1@localhost:5432/f1"

MIGRATE_HINT = "run `npm run db:migrate` in web/."

# Reverse FK order (§2.4): children before parents, session_ingests last.
SESSION_CHILD_TABLES: list[str] = [
    # MODE1_SPEC §5.6 (children first). wp_lap_probability / wp_swing are written by the
    # run-end step, not build_race_frames, but they are keyed by session_id and cascade,
    # so a session delete must clear them here too.
    "wp_swing", "wp_lap_probability", "optimal_stint", "race_moment",
    "sim_driver_compound", "sim_driver_params", "sim_compound_params", "sim_race_params",   # SIM_SPEC §3.4 (children first)
    "fuel_sensitivity", "teammate_deltas", "compound_degradation", "degradation_fits", "pace_ranking",
    "lap_exclusion_report", "stints", "pit_stops", "lap_status",
    # QUALI_SPEC §3.7: the three per-session qualifying tables, children first and BEFORE
    # "laps", so deleting a Q/SQ session still cascades in a legal order. quali_results
    # carries a composite FK to session_entries(session_id, driver_id), which is later in
    # this list, so it must be cleared before it too. season_quali_h2h is season-scoped and
    # deliberately absent: it belongs to season.py's delete-and-rebuild per (year, kind).
    "quali_teammate_h2h", "quali_segment_times", "quali_results",
    # TELEMETRY_SPEC v1.7 §2.8: the three session-keyed telemetry tables, children first
    # and BEFORE "laps" — lap_telemetry carries a composite FK to laps(session_id,
    # driver_id, lap_number) and the other two cascade from it. circuit_layout /
    # circuit_corners are per (circuit_key, year), not per session, and are deliberately
    # absent: the telemetry pass rebuilds them itself.
    "lap_corner_speeds", "lap_telemetry_summary", "lap_telemetry",
    "laps", "track_status_events",
    "weather_samples", "results", "compound_colours", "session_entries", "session_teams", "session_ingests",
]


class SchemaMismatch(RuntimeError):
    """The live database does not match frames.EXPECTED_COLUMNS."""


def resolve_dsn(dsn: str | None = None) -> str:
    return dsn or os.environ.get("DATABASE_URL") or DEFAULT_DSN


def connect(dsn: str | None = None) -> psycopg.Connection:
    """``dsn`` or env ``DATABASE_URL`` or ``DEFAULT_DSN``; ``autocommit=False``."""
    return psycopg.connect(resolve_dsn(dsn), autocommit=False)


def live_columns(conn, table: str, schema: str = "public") -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
            (schema, table),
        )
        return [r[0] for r in cur.fetchall()]


def schema_problems(conn) -> list[str]:
    """Every mismatch between EXPECTED_COLUMNS and the live schema, as human-readable lines."""
    problems: list[str] = []
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('drizzle.__drizzle_migrations')")
        if cur.fetchone()[0] is None:
            problems.append("drizzle.__drizzle_migrations does not exist (no migration has been applied)")
    for table, expected in frames.EXPECTED_COLUMNS.items():
        live = live_columns(conn, table)
        if not live:
            problems.append(f"table {table!r} is missing")
            continue
        missing = [c for c in expected if c not in live]
        extra = [c for c in live if c not in expected]
        if missing or extra:
            problems.append(f"table {table!r}: missing columns {missing}, unexpected columns {extra}")
    return problems


def assert_schema(conn) -> None:
    """Fail fast unless the migration exists and every table's column set matches §1."""
    problems = schema_problems(conn)
    if problems:
        text = "Database schema does not match f1lab.frames.EXPECTED_COLUMNS:\n  - " + "\n  - ".join(problems)
        raise SchemaMismatch(text + "\n" + MIGRATE_HINT)


#: QUALI_SPEC's WP3 block calls this ``db.check_schema``; the module has always spelled it
#: ``assert_schema``. Kept as an alias rather than a rename so no existing caller moves.
check_schema = assert_schema


def copy_rows(cur, table: str, columns: list[str], rows: Iterable[tuple]) -> int:
    """``COPY table (cols) FROM STDIN`` of plain-Python tuples; returns the row count."""
    stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(table), sql.SQL(", ").join(sql.Identifier(c) for c in columns))
    n = 0
    with cur.copy(stmt) as copy:
        for row in rows:
            copy.write_row(row)
            n += 1
    return n


def copy_frame(cur, table: str, df) -> int:
    """COPY a cast DataFrame (columns already == EXPECTED_COLUMNS[table])."""
    cols = list(df.columns)
    if cols != frames.EXPECTED_COLUMNS[table]:
        raise SchemaMismatch(f"{table}: frame columns {cols} != EXPECTED_COLUMNS")
    if len(df) == 0:
        return 0
    return copy_rows(cur, table, cols, frames.iter_rows(df))


def upsert_rows(cur, table: str, columns: list[str], key_columns: list[str], rows,
                update_columns: list[str], keep_existing_if_null: Iterable[str] = ()) -> int:
    """INSERT ... ON CONFLICT (keys) DO UPDATE SET update_columns = EXCLUDED.*; DO NOTHING if none.

    Columns named in ``keep_existing_if_null`` are set to ``COALESCE(EXCLUDED.col, table.col)``:
    a NULL in a later upsert never erases a value learned earlier (``drivers.headshot_url``,
    which FastF1 reports for a driver in some sessions and not in others).
    """
    rows = list(rows)
    if not rows:
        return 0
    insert = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.Identifier(c) for c in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    conflict = sql.SQL(" ON CONFLICT ({})").format(sql.SQL(", ").join(sql.Identifier(c) for c in key_columns))
    keep = set(keep_existing_if_null)

    def _set(c: str) -> sql.Composable:
        if c in keep:
            return sql.SQL("{c} = COALESCE(EXCLUDED.{c}, {t}.{c})").format(c=sql.Identifier(c),
                                                                          t=sql.Identifier(table))
        return sql.SQL("{c} = EXCLUDED.{c}").format(c=sql.Identifier(c))

    if update_columns:
        action = sql.SQL(" DO UPDATE SET ") + sql.SQL(", ").join(_set(c) for c in update_columns)
    else:
        action = sql.SQL(" DO NOTHING")
    cur.executemany(insert + conflict + action, rows)
    return len(rows)


def delete_session_children(cur, session_id: int) -> None:
    """DELETE every per-session child row, children first (§2.4 order)."""
    for table in SESSION_CHILD_TABLES:
        cur.execute(sql.SQL("DELETE FROM {} WHERE session_id = %s").format(sql.Identifier(table)), (session_id,))


def table_counts(conn, tables: Iterable[str], session_id: int | None = None) -> dict[str, int]:
    """Row counts per table (optionally restricted to one session_id). Test/CLI helper."""
    out: dict[str, int] = {}
    with conn.cursor() as cur:
        for t in tables:
            if session_id is not None and "session_id" in frames.EXPECTED_COLUMNS.get(t, []):
                cur.execute(sql.SQL("SELECT count(*) FROM {} WHERE session_id = %s").format(sql.Identifier(t)),
                            (session_id,))
            else:
                cur.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(t)))
            out[t] = int(cur.fetchone()[0])
    return out
