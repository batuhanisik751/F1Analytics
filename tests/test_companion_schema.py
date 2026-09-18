"""[db] MODE1_SPEC §6.6 test 21 — the v1.2 companion schema contract.

``ingest.py --check-schema`` passes, all fourteen new tables appear in
``EXPECTED_COLUMNS``, and the two constraints the whole feature leans on are live:
``wp_lap_probability`` refuses a non-OOF row (FD2) and every session-keyed companion
table cascades on ``session_id`` (§5.7 trap 3).
"""

from __future__ import annotations

import pytest

from f1lab import db, frames, ingest

pytestmark = pytest.mark.db

COMPANION_TABLES = [
    "wp_run", "wp_model_artifact", "wp_lap_probability", "wp_swing", "wp_metrics",
    "wp_reliability_bin", "title_odds", "title_clinch", "circuit_odi", "preview_round",
    "preview_finish_order", "preview_backtest", "race_moment", "optimal_stint",
]


def test_check_schema_covers_companion(db_conn):
    """All fourteen are in the contract AND live, and --check-schema exits 0."""
    missing = [t for t in COMPANION_TABLES if t not in frames.EXPECTED_COLUMNS]
    assert not missing, f"not in EXPECTED_COLUMNS: {missing}"
    assert len(COMPANION_TABLES) == 14

    for table in COMPANION_TABLES:
        live = db.live_columns(db_conn, table)
        db_conn.rollback()
        assert live, f"table {table} is missing from the live database"
        assert sorted(live) == sorted(frames.EXPECTED_COLUMNS[table]), (
            f"{table}: missing={sorted(set(frames.EXPECTED_COLUMNS[table]) - set(live))} "
            f"extra={sorted(set(live) - set(frames.EXPECTED_COLUMNS[table]))}")

    assert ingest.main(["--check-schema"]) == 0


def test_wp_lap_probability_rejects_full_model_rows(db_conn):
    """FD2: OOF-only is a DB CHECK, not a query filter a future caller could forget."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        with db_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO wp_lap_probability (session_id, assumption_set_id, driver_id, "
                "lap_number, pred_kind, fold_index, p_win_raw, p_win) "
                "VALUES (1, 1, 'x', 1, 'full', 0, 0.5, 0.5)")
    db_conn.rollback()


@pytest.mark.parametrize(
    "table", ["race_moment", "optimal_stint", "wp_lap_probability", "wp_swing"])
def test_session_keyed_companion_tables_cascade(db_conn, table):
    """§5.7 trap 3: Drizzle drops the cascade unless it is written out explicitly."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT c.confdeltype FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "JOIN pg_class f ON f.oid = c.confrelid "
            "WHERE t.relname = %s AND f.relname = 'sessions' AND c.contype = 'f'", (table,))
        rows = cur.fetchall()
    db_conn.rollback()
    assert rows, f"{table} has no foreign key to sessions"
    assert all(r[0] == "c" for r in rows), f"{table}.session_id is not ON DELETE CASCADE"


def test_session_child_tables_cover_the_companion_children():
    """db.delete_session_children must clear the four session-keyed companion tables."""
    for table in ("race_moment", "optimal_stint", "wp_lap_probability", "wp_swing"):
        assert table in db.SESSION_CHILD_TABLES
    # Children first: the deletes run in this order, so every companion child must come
    # before the tables it points at.
    order = db.SESSION_CHILD_TABLES
    assert order.index("wp_swing") < order.index("session_ingests")
    assert order.index("race_moment") < order.index("laps")
