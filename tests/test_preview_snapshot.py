"""The preview ledger copy (LEDGER_SPEC §2, §5): shape, SQL and the failure accounting.

Everything but the last test is pure. The contract for the two snapshot tables is derived
from the tables they copy; the SQL is append-only by construction (no DELETE, no DDL, no
``now()``); and the step in ``update_season.py`` that runs it must never raise and must
never reach ``failures`` on its own -- the push is gated on ``failures`` alone.
"""

from __future__ import annotations

import re

import pytest

from f1lab import frames, preview
from scripts import update_season as us

ROUND, ORDER = "preview_snapshot_round", "preview_snapshot_order"
FORBIDDEN = re.compile(r"\b(DELETE|TRUNCATE|CREATE|ALTER|now\(\))", re.IGNORECASE)


def test_snapshot_round_columns_are_preview_round_plus_snapshot_at():
    assert frames.EXPECTED_COLUMNS[ROUND] == frames.EXPECTED_COLUMNS["preview_round"] + ["snapshot_at"]
    assert len(frames.EXPECTED_COLUMNS[ROUND]) == 22


def test_snapshot_order_columns_are_key_then_the_eleven_order_columns():
    rest = [c for c in frames.EXPECTED_COLUMNS["preview_finish_order"] if c not in ("year", "round")]
    assert len(rest) == 11
    assert frames.EXPECTED_COLUMNS[ORDER] == ["year", "round", "computed_at"] + rest + ["snapshot_at"]


def test_snapshot_tables_are_not_per_session():
    for t in (ROUND, ORDER):
        assert t not in frames.RACE_TABLE_ORDER
        assert t not in frames.SPRINT_TABLE_ORDER


def test_snapshot_sql_is_append_only_and_copies_the_preview_date():
    round_sql, order_sql = preview.snapshot_sql()
    for sql in (round_sql, order_sql):
        assert not FORBIDDEN.search(sql), sql
        assert sql.startswith("INSERT INTO ")
    assert f"INSERT INTO {ROUND} (" in round_sql
    assert "ON CONFLICT (year, round, computed_at) DO NOTHING" in round_sql
    assert "FROM preview_round" in round_sql
    # every preview_round column is copied, snapshot_at is left to its default
    for c in frames.EXPECTED_COLUMNS["preview_round"]:
        assert c in round_sql
    assert "snapshot_at" not in round_sql and "snapshot_at" not in order_sql
    assert f"INSERT INTO {ORDER} (year, round, computed_at, " in order_sql
    assert "SELECT o.year, o.round, r.computed_at, o.assumption_set_id, o.driver_id" in order_sql
    assert "FROM preview_finish_order o JOIN preview_round r USING (year, round)" in order_sql
    assert "ON CONFLICT (year, round, computed_at, driver_id) DO NOTHING" in order_sql


def test_snapshot_sql_is_pure():
    assert preview.snapshot_sql() == preview.snapshot_sql()


def test_snapshot_step_defers_a_failure_and_never_raises():
    def boom(dsn):
        raise RuntimeError("connection refused for postgres://f1_push:hunter2@db.example/f1")

    deferred: list[str] = []
    failures: list[str] = []
    us._snapshot_step("after", deferred, connect=boom)        # must not raise
    assert failures == []
    assert deferred == ["snapshot(after) failed: RuntimeError: connection refused for "
                        "postgres://f1_push:***@db.example/f1"]
    assert "hunter2" not in " ".join(deferred)


def test_snapshot_step_closes_a_connection_that_fails_inside_the_transaction():
    class Conn:
        closed = False

        def transaction(self):
            raise LookupError("preview_snapshot_round is missing")

        def close(self):
            self.closed = True

    conn = Conn()
    deferred: list[str] = []
    us._snapshot_step("before", deferred, connect=lambda dsn: conn)
    assert conn.closed
    assert deferred == ["snapshot(before) failed: LookupError: preview_snapshot_round is missing"]


@pytest.mark.db
def test_snapshot_preview_is_idempotent_and_keeps_the_invariants(db_conn):
    """Inside one rolled-back transaction: the first copy carries the whole preview, the
    second inserts nothing, every order row carries its round's ``computed_at``, and the
    ledger invariants hold (nothing dated in the future, ``snapshot_at >= computed_at``,
    no order row without its round row). Nothing is committed."""
    try:
        first = preview.snapshot_preview(db_conn)
        second = preview.snapshot_preview(db_conn)
        assert (second["round"], second["order"]) == (0, 0)
        with db_conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM preview_round")
            n_round = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM preview_finish_order")
            n_order = cur.fetchone()[0]
            # the rows of the current preview, by its own computed_at, are all on record
            cur.execute("SELECT count(*) FROM preview_snapshot_round s "
                        "JOIN preview_round p USING (year, round, computed_at)")
            assert cur.fetchone()[0] == n_round
            cur.execute("SELECT count(*) FROM preview_snapshot_order s "
                        "JOIN preview_round p USING (year, round, computed_at) "
                        "JOIN preview_finish_order o USING (year, round, driver_id)")
            assert cur.fetchone()[0] == n_order
            assert first["round"] <= n_round and first["order"] <= n_order
            if n_round:
                assert first["computed_at"] is not None
            cur.execute("SELECT count(*) FROM preview_snapshot_order o "
                        "LEFT JOIN preview_snapshot_round r USING (year, round, computed_at) "
                        "WHERE r.year IS NULL OR o.computed_at <> r.computed_at")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM preview_snapshot_round "
                        "WHERE computed_at > now() OR snapshot_at < computed_at")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM preview_snapshot_order "
                        "WHERE computed_at > now() OR snapshot_at < computed_at")
            assert cur.fetchone()[0] == 0
    finally:
        db_conn.rollback()
