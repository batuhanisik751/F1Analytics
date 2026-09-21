"""The nightly push, without a database (OPS_SPEC §3.2, §7 WP-7).

Everything here is pure: the constants other packages read (`EXCLUDE_TABLES` is the fixture's
scrub set), the column scrub that keeps `session_ingests.error` and the `ingest_runs` stubs
free of hostnames and paths, the foreign-key ordering derived from a catalogue rather than a
list, the refusal on a table nobody has classified, the credential-file mode check, and the
password redaction in every message the push can print.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from scripts import push_remote as pr
from scripts.push_remote import Refusal, Table


def _cat(*rows: tuple[str, list[str], list[str], set[str]]) -> dict[str, Table]:
    return {name: Table(name, cols, pk, parents) for name, cols, pk, parents in rows}


def test_exclude_tables_is_exactly_the_three_laptop_only_tables():
    assert pr.EXCLUDE_TABLES == frozenset({"ingest_runs", "ask_query_log", "ask_answer_cache"})
    assert pr.UNTOUCHED_SEQUENCES == frozenset({"ask_query_log_ask_id_seq"})
    assert pr.RELEASE_TABLE == "data_release"
    # The stubs are a subset of the excluded set: nothing crosses that is not named there.
    assert pr.STUB_TABLES <= pr.EXCLUDE_TABLES
    assert not (pr.WHOLE_TABLES & pr.EXCLUDE_TABLES)


def test_error_scrub_replaces_the_columns_that_can_carry_a_path_or_hostname():
    assert pr.SCRUB["session_ingests"] == {"error": "NULL::text"}
    assert set(pr.SCRUB["ingest_runs"]) == {"hostname", "error", "cli_args"}
    t = Table("session_ingests", ["session_id", "run_id", "error", "status"], ["session_id"])
    assert pr.row_expr(t, scrubbed=True) == 'ROW("session_id", "run_id", NULL::text, "status")'
    assert pr.row_expr(t, scrubbed=False) == 'ROW("session_id", "run_id", "error", "status")'
    t = Table("ingest_runs", ["run_id", "cli_args", "hostname", "error"], ["run_id"])
    assert pr.row_expr(t, scrubbed=True) == \
        "ROW(\"run_id\", '{}'::jsonb, NULL::text, NULL::text)"


def test_fk_order_is_parents_first_from_the_catalogue():
    cat = _cat(
        ("laps", ["session_id", "driver_id"], ["session_id", "driver_id"], {"sessions", "entries"}),
        ("entries", ["session_id", "driver_id"], ["session_id", "driver_id"], {"sessions", "drivers"}),
        ("sessions", ["session_id"], ["session_id"], {"events"}),
        ("events", ["year", "round"], ["year", "round"], set()),
        ("drivers", ["driver_id"], ["driver_id"], set()),
    )
    order = [t.name for t in pr.fk_order(list(cat.values()))]
    assert order.index("events") < order.index("sessions") < order.index("entries")
    assert order.index("drivers") < order.index("entries") < order.index("laps")
    assert sorted(order) == sorted(cat)


def test_fk_order_ignores_parents_outside_the_pushed_set_and_refuses_cycles():
    cat = _cat(("session_ingests", ["session_id", "run_id"], ["session_id"],
                {"sessions", "ingest_runs"}),
               ("sessions", ["session_id"], ["session_id"], set()))
    assert [t.name for t in pr.fk_order(list(cat.values()))] == ["sessions", "session_ingests"]
    cyc = _cat(("a", ["x"], ["x"], {"b"}), ("b", ["x"], ["x"], {"a"}))
    with pytest.raises(Refusal, match="cycle"):
        pr.fk_order(list(cyc.values()))


def test_classify_refuses_a_table_nobody_has_a_rule_for():
    cat = _cat(("sessions", ["session_id"], ["session_id"], set()),
               ("laps", ["session_id", "lap"], ["session_id", "lap"], {"sessions"}),
               ("drivers", ["driver_id"], ["driver_id"], set()),
               ("ingest_runs", ["run_id", "hostname"], ["run_id"], set()),
               ("ask_query_log", ["ask_id"], ["ask_id"], set()),
               ("data_release", ["release_id"], ["release_id"], set()))
    split = pr.classify(cat)
    assert [t.name for t in split.keyed] == ["laps", "sessions"]
    assert [t.name for t in split.whole] == ["drivers", "ingest_runs"]
    assert split.excluded == ["ask_query_log"] and split.release
    cat["brand_new_aggregate"] = Table("brand_new_aggregate", ["k", "v"], ["k"])
    with pytest.raises(Refusal, match="unclassified table brand_new_aggregate"):
        pr.classify(cat)
    del cat["brand_new_aggregate"]
    cat["laps"] = Table("laps", ["session_id", "lap"], [], {"sessions"})
    with pytest.raises(Refusal, match="no primary key"):
        pr.classify(cat)


def test_whole_tables_all_lack_a_session_id_and_the_split_is_disjoint():
    # A keyed table is recognised by its column, never by name; the whole list is only
    # consulted for tables without one, so no name may sit in more than one set.
    assert not (pr.WHOLE_TABLES & pr.STUB_TABLES)
    assert pr.RELEASE_TABLE not in pr.WHOLE_TABLES | pr.EXCLUDE_TABLES


def test_credential_file_must_be_mode_600(tmp_path: Path):
    f = tmp_path / "remote.env"
    f.write_text("REMOTE_DATABASE_URL=postgres://f1_push:secret@db.example/f1\n")
    f.chmod(0o644)
    with pytest.raises(Refusal, match="0644; it must be 0600"):
        pr.load_remote_dsn(f, env={})
    f.chmod(0o600)
    assert pr.load_remote_dsn(f, env={}) == "postgres://f1_push:secret@db.example/f1"
    assert pr.load_remote_dsn(tmp_path / "missing.env", env={}) is None
    # The environment wins over the file, and is never mode-checked.
    assert pr.load_remote_dsn(f, env={"REMOTE_DATABASE_URL": "postgres://x"}) == "postgres://x"


def test_redact_strips_the_password_from_any_message():
    msg = "production unreachable: postgres://f1_push:hunter2@ep.neon.tech/f1?sslmode=verify-full"
    assert "hunter2" not in pr.redact(msg)
    assert pr.redact(msg).startswith("production unreachable: postgres://f1_push:***@ep.neon.tech")
    assert pr.redact("no dsn here") == "no dsn here"


def test_aggregate_rows_that_point_at_a_session_go_out_and_come_back_with_it():
    # `circuit_layout.ref_session_id -> sessions.session_id` is a NOT-DEFERRABLE foreign key
    # on a table without a `session_id`; replacing a session must delete those rows first and
    # put this machine's copy back after the COPY, in the same transaction.
    t = Table("circuit_layout", ["circuit_id", "ref_session_id", "svg"], ["circuit_id"],
              {"sessions", "circuits"}, session_refs=["ref_session_id"])
    assert pr.ref_delete_sql(t, "ref_session_id") == \
        'DELETE FROM "circuit_layout" WHERE "ref_session_id" = ANY(%s)'
    assert pr.ref_select_sql(t, "ref_session_id") == \
        'SELECT ROW("circuit_id", "ref_session_id", "svg")::text FROM "circuit_layout" ' \
        'WHERE "ref_session_id" = ANY(%s)'
    assert not t.keyed and Table("laps", ["session_id"], ["session_id"]).session_refs == []
    # It sorts after its parent, so the reversed (delete) pass reaches it first.
    order = [x.name for x in pr.fk_order([t, Table("sessions", ["session_id"], ["session_id"])])]
    assert order == ["sessions", "circuit_layout"]


def test_ledger_ids_are_bookkeeping_only():
    """A serial gap on one side must not read as a diverged schema (2026-09-21).

    The local ledger skips id 10 (a rolled-back apply consumed it); Neon's is 1..12. Same
    twelve hashes in the same order is the same schema. check_schema compares hash sequences.
    """
    import pytest
    from scripts.push_remote import compare_ledgers, Refusal
    local = ["h%d" % i for i in range(12)]
    compare_ledgers(local, list(local))                        # identical: no raise
    with pytest.raises(Refusal, match="SCHEMA BEHIND"):
        compare_ledgers(local, local[:11])                     # production one behind: named, refused
    with pytest.raises(Refusal, match="SCHEMA AHEAD"):
        compare_ledgers(local[:11], local)                     # this machine behind
    with pytest.raises(Refusal, match="DIVERGED"):
        compare_ledgers(local, local[:11] + ["other"])         # a different twelfth migration
