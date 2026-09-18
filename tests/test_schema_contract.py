"""[db] EXPECTED_COLUMNS == the live information_schema (tables + columns).

Deliberately reads ``information_schema`` rather than parsing ``0000_init.sql`` (D17),
so it keeps working once a ``0001`` migration exists.
"""

from __future__ import annotations

import pytest

from f1lab import db, frames

pytestmark = pytest.mark.db


def test_migration_table_exists(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM drizzle.__drizzle_migrations")
        assert cur.fetchone()[0] >= 1
    db_conn.rollback()


@pytest.mark.parametrize("table", sorted(frames.EXPECTED_COLUMNS))
def test_table_columns_match_contract(db_conn, table):
    live = db.live_columns(db_conn, table)
    db_conn.rollback()
    assert live, f"table {table} is missing from the live database"
    expected = frames.EXPECTED_COLUMNS[table]
    assert sorted(live) == sorted(expected), (
        f"{table}: missing={sorted(set(expected) - set(live))} extra={sorted(set(live) - set(expected))}")


def test_assert_schema_passes(db_conn):
    db.assert_schema(db_conn)
    db_conn.rollback()
