"""[db] MODE3_SPEC §6.3 — the drift check for the two tables Python does NOT own.

`ask_query_log` and `ask_answer_cache` are written by the web (role `f1_ask_log`), so
they are deliberately absent from `frames.TABLE_COLUMNS`: `db.assert_schema` must not
assert over tables this side does not own. They get the equivalent guarantee here
instead — the live columns are compared against a literal list transcribed by hand
from `web/drizzle/0005_mode3.sql`. The drift check therefore exists on both sides even
though ownership does not.

Neither table is in schema `ask` and neither is granted to `f1_ask` (§1.2): a fan
cannot ask the ask box what other fans have asked. That grant property is WP-2's
`make db-ask-verify`; what is asserted here is only the shape.
"""

from __future__ import annotations

import pytest

from f1lab import db, frames

pytestmark = pytest.mark.db

# §6.2, transcribed from web/drizzle/0005_mode3.sql in DDL order.
ASK_QUERY_LOG_COLUMNS = [
    "ask_id", "asked_at", "session_cookie", "ip_hash", "question", "question_norm",
    "intent", "sql_generated", "sql_executed", "validator_verdict", "retry_count",
    "outcome", "row_count", "truncated", "render_kind", "max_plan_cost",
    "touched_views", "flags", "model", "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "estimated_cost_usd",
    "duration_ms", "error",
]

ASK_ANSWER_CACHE_COLUMNS = [
    "question_key", "question_norm", "prefix_sha256", "payload", "hit_count",
    "created_at", "last_hit_at",
]

ASK_QUERY_LOG_INDEXES = [
    "ask_query_log_asked_at_idx",
    "ask_query_log_cookie_idx",
    "ask_query_log_ip_idx",
    "ask_query_log_outcome_idx",
]


@pytest.mark.parametrize(
    ("table", "expected"),
    [
        ("ask_query_log", ASK_QUERY_LOG_COLUMNS),
        ("ask_answer_cache", ASK_ANSWER_CACHE_COLUMNS),
    ],
)
def test_web_owned_table_columns_match_the_migration(db_conn, table, expected):
    live = db.live_columns(db_conn, table)
    db_conn.rollback()
    assert live, f"table {table} is missing from the live database"
    assert sorted(live) == sorted(expected), (
        f"{table}: missing={sorted(set(expected) - set(live))} "
        f"extra={sorted(set(live) - set(expected))}")


def test_web_owned_tables_stay_out_of_the_python_contract():
    """Adding either to TABLE_COLUMNS would make db.assert_schema own them."""
    for table in ("ask_query_log", "ask_answer_cache"):
        assert table not in frames.TABLE_COLUMNS
        assert table not in frames.RACE_TABLE_ORDER
        assert table not in frames.SPRINT_TABLE_ORDER


def test_ask_query_log_indexes_exist(db_conn):
    """§6.2. The four read paths of the log: recency, cookie, ip, outcome."""
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes "
            " WHERE tablename = 'ask_query_log' ORDER BY indexname"
        )
        names = [r[0] for r in cur.fetchall()]
    db_conn.rollback()
    for want in ASK_QUERY_LOG_INDEXES:
        assert want in names, f"missing index {want} (have {names})"


def test_ask_answer_cache_is_keyed_on_the_prompt_prefix(db_conn):
    """question_key = sha256(question_norm + PROMPT_PREFIX_SHA256): PK, and text."""
    with db_conn.cursor() as cur:
        cur.execute("""
            SELECT a.attname, format_type(a.atttypid, a.atttypmod)
              FROM pg_constraint c
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.conrelid = 'ask_answer_cache'::regclass AND c.contype = 'p'
        """)
        rows = cur.fetchall()
    db_conn.rollback()
    assert rows == [("question_key", "text")]
