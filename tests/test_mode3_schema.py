"""[db] MODE3_SPEC §6 — the v1.4 schema contract (WP-3 gate).

Three tables land in migration 0005, but ownership of them is deliberately split:

- **`race_report` is Python's** (§6.3). It is the only one in `frames.TABLE_COLUMNS`,
  so `db.assert_schema` covers it and `cast_frame` has type information for it.
- **`ask_query_log` and `ask_answer_cache` are the web's.** Python never writes them,
  so asserting over them from `db.assert_schema` would be asserting over tables this
  side does not own. `tests/test_web_owned_tables.py` is their drift check instead.

The one structural trap (§4.4): `race_report` must NOT be in `RACE_TABLE_ORDER` or
`SPRINT_TABLE_ORDER`. Those lists drive the per-session COPY block, which builds its
frames before `report.py` runs — listing `race_report` there raises `KeyError` on
every race ingest rather than on some later edge case.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from f1lab import db, frames, ingest

pytestmark = pytest.mark.db

# §6.1, in DDL order.
RACE_REPORT_COLUMNS = [
    "session_id", "assumption_set_id", "prompt_version", "model", "status",
    "grounding_completeness", "grounding_sha256", "result", "pace", "strategy",
    "swing", "caveats", "known_gaps", "cites", "audit_failures", "skipped_reason",
    "word_count", "input_tokens", "output_tokens", "est_cost_usd", "regenerations",
    "generated_at",
]


def test_race_report_is_in_the_python_contract_and_live(db_conn):
    """§6.3. The contract, the live table and --check-schema all agree."""
    assert frames.EXPECTED_COLUMNS["race_report"] == RACE_REPORT_COLUMNS

    live = db.live_columns(db_conn, "race_report")
    db_conn.rollback()
    assert live, "race_report is missing from the live database"
    assert sorted(live) == sorted(RACE_REPORT_COLUMNS), (
        f"missing={sorted(set(RACE_REPORT_COLUMNS) - set(live))} "
        f"extra={sorted(set(live) - set(RACE_REPORT_COLUMNS))}")

    assert ingest.main(["--check-schema"]) == 0


def test_ask_tables_are_not_in_the_python_contract():
    """§6.3. Python never writes them, so it must not assert over them."""
    for table in ("ask_query_log", "ask_answer_cache"):
        assert table not in frames.TABLE_COLUMNS
        assert table not in frames.EXPECTED_COLUMNS


def test_race_report_is_not_a_per_session_child(db_conn):
    """§4.4. The KeyError trap: race_report is built after the COPY block, not in it."""
    assert "race_report" not in frames.RACE_TABLE_ORDER
    assert "race_report" not in frames.SPRINT_TABLE_ORDER
    assert "race_report" not in frames.ANALYTICS

    # It still cascades on its own FK, which is what makes the list entry unnecessary.
    with db_conn.cursor() as cur:
        cur.execute("""
            SELECT confdeltype FROM pg_constraint
             WHERE conrelid = 'race_report'::regclass AND contype = 'f'
               AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                    WHERE attrelid = 'race_report'::regclass
                                      AND attname = 'session_id')]
        """)
        row = cur.fetchone()
    db_conn.rollback()
    assert row is not None and row[0] == "c", "session_id FK must be ON DELETE CASCADE"


def test_cast_frame_round_trips_text_array_and_jsonb():
    """§6.3. text[], jsonb and timestamptz fall through the object pass-through branch."""
    df = pd.DataFrame([{
        "session_id": np.int64(1), "assumption_set_id": np.int64(1),
        "prompt_version": np.int64(1), "model": "claude-opus-5", "status": "ok",
        "grounding_completeness": "ok", "grounding_sha256": "a" * 64,
        "result": "P1.", "pace": None, "strategy": None, "swing": None,
        "caveats": None, "known_gaps": ["no_weather"],
        "cites": {"result": ["results.csv"]}, "audit_failures": [],
        "skipped_reason": None, "word_count": 2, "input_tokens": 10,
        "output_tokens": 20, "est_cost_usd": 0.053, "regenerations": 0,
        "generated_at": pd.Timestamp("2026-09-14T12:00:00Z"),
    }])
    out = frames.cast_frame(df, "race_report")

    assert list(out.columns) == RACE_REPORT_COLUMNS
    assert out.loc[0, "known_gaps"] == ["no_weather"]
    assert out.loc[0, "cites"] == {"result": ["results.csv"]}
    assert out.loc[0, "audit_failures"] == []
    assert int(out.loc[0, "session_id"]) == 1
    assert out.loc[0, "result"] == "P1."


def test_race_report_check_constraints_are_named_and_present(db_conn):
    """§6.1. Three named CHECKs; an unnamed one changes name between generations."""
    with db_conn.cursor() as cur:
        cur.execute("""
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'race_report'::regclass AND contype = 'c'
             ORDER BY conname
        """)
        names = [r[0] for r in cur.fetchall()]
    db_conn.rollback()
    assert names == [
        "race_report_body_check",
        "race_report_completeness_check",
        "race_report_status_check",
    ]
