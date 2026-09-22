"""The ask contract cannot drift (MODE3_SPEC §1.2, §2.2, §9 WP-1).

`scripts/gen_ask_schema.py` generates three artifacts from one source. These tests regenerate
all three and fail if any byte differs from what is committed — the same discipline
`db.assert_schema` applies to `EXPECTED_COLUMNS` — and then assert the properties that make
the generated surface a safety boundary rather than a convention:

* the seven sensitive tables are objects in none of the three artifacts;
* `assumption_sets.params` is in none of them;
* every view has an explicit column list and there is no `SELECT *`;
* the enumerated GRANT and the validator's allowlist name the same 64 objects;
* the two v1.7 telemetry exclusions (T6) are objects in none of the three artifacts either,
  and the scalar half is;
* the prompt document carries the four measured traps that otherwise produce SQL which
  runs, returns rows, and is wrong;
* nothing volatile leaks into the cached prompt prefix (§2.4).

Everything here is `db`-marked: the generator reads the live `information_schema` and
compiles its own DDL into a throwaway schema that is always rolled back.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import gen_ask_schema as gen  # noqa: E402

pytestmark = pytest.mark.db

MANIFEST = ROOT / "scripts" / "ask_manifest.yml"
SQL_PATH = ROOT / "scripts" / "sql" / "0005_ask_views.sql"
DOC_PATH = ROOT / "web" / "lib" / "ask" / "schema-doc.txt"
JSON_PATH = ROOT / "web" / "lib" / "ask" / "ask-objects.json"

# v1.8 (2026-09-17) +1 of each: ask.mode2_quali_row_audit, the per-driver-session audit of
# the one_lap_pace fit (GAPFILL_SPEC §2.4). Its siblings mode2_row_audit and mode2_fit_run
# stay excluded at the GRANT level as fit internals; this one is exposed deliberately, so a
# reader can see which driver-sessions entered the qualifying fit and why the rest did not.
N_OBJECTS = 65
N_TABLE_VIEWS = 61
# v1.6 re-based the budget. MODE3_SPEC §2.1 estimated 33,000 chars for the 57-object v1.4
# surface; the v1.4 document actually generated at 38,533. v1.6 adds four qualifying views
# (63 columns of signature), five conventions, two worked examples and five `laps` columns,
# and generates at 45,016. The tolerance is unchanged, so the gate still catches a document
# that doubles or halves — it no longer pretends to the v1.4 number. QUALI_SPEC WP8 should
# amend MODE3_SPEC §2.1 to match.
DOC_TARGET_CHARS = 45_000
DOC_TOLERANCE = 0.20


@pytest.fixture(scope="module")
def manifest() -> dict:
    with MANIFEST.open() as fh:
        return yaml.safe_load(fh)


@pytest.fixture(scope="module")
def generated() -> dict[Path, str]:
    """One regeneration, reused by every test in the module."""
    return gen.generate()


@pytest.fixture(scope="module")
def sql() -> str:
    return SQL_PATH.read_text()


@pytest.fixture(scope="module")
def doc() -> str:
    return DOC_PATH.read_text()


@pytest.fixture(scope="module")
def objects() -> dict[str, list[dict[str, str]]]:
    return json.loads(JSON_PATH.read_text())


# ---------------------------------------------------------------------------
# The committed artifacts are exactly what the generator produces, twice running
# ---------------------------------------------------------------------------

def _diff(committed: str, fresh: str) -> str:
    import difflib

    lines = list(difflib.unified_diff(
        committed.splitlines(), fresh.splitlines(),
        fromfile="committed", tofile="regenerated", lineterm="", n=0,
    ))
    return "\n".join(lines[:20])


def test_committed_artifacts_match_a_fresh_regeneration(generated):
    for path, text in generated.items():
        assert path.exists(), f"{path.relative_to(ROOT)} has never been generated"
        committed = path.read_text()
        assert committed == text, (
            f"{path.relative_to(ROOT)} is stale - regenerate with "
            f"`python scripts/gen_ask_schema.py`.\n"
            "If the only difference is inside the COVERAGE block, the database has changed "
            "since the artifacts were generated (an ingest, or a test that re-ingests a "
            "session); that block is deliberately volatile across ingests (§2.4) and a "
            "regeneration is exactly what is required.\n" + _diff(committed, text)
        )


def test_regeneration_is_byte_identical_twice_running(generated):
    again = gen.generate()
    assert {str(p): t for p, t in again.items()} == {str(p): t for p, t in generated.items()}


def test_check_mode_agrees(generated):
    """The CI entry point and the fixture must not disagree about staleness."""
    stale = [p for p, t in generated.items() if p.read_text() != t]
    assert stale == []


# ---------------------------------------------------------------------------
# The exclusions are structural, not editorial
# ---------------------------------------------------------------------------

# v1.11: nine -> ten with data_release, the production-push bookkeeping table (excluded: the
# footer reads it directly and it is operational, not a fact about a race).
# v1.12: ten -> twelve with preview_snapshot_round and preview_snapshot_order, the history
# copies served scored on /accuracy (LEDGER_SPEC §3: raw rows invite quoting a stale preview
# as today's).
def test_twelve_grant_level_exclusions_are_objects_in_no_artifact(manifest, sql, doc, objects):
    """Seven sensitive tables (§1.2), the two v1.7 telemetry exclusions (TELEMETRY_SPEC T6),
    data_release (v1.11) and the two v1.12 preview-snapshot copies (LEDGER_SPEC §3)."""
    excluded = sorted(manifest["exclude_tables"])
    assert len(excluded) == 12, excluded
    assert {"lap_telemetry", "circuit_layout"} <= set(excluded)
    assert {"preview_snapshot_round", "preview_snapshot_order"} <= set(excluded)
    for table in excluded:
        assert f"ask.{table}" not in objects, f"{table} is in the validator's allowlist"
        assert f"VIEW ask.{table} AS" not in sql, f"{table} has a view"
        assert f"ask.{table}," not in sql, f"{table} is named in the GRANT"
        assert not re.search(rf"^ask\.{table}\(", doc, re.M), f"{table} has a signature line"
    # They appear in the prompt exactly once each, in the non-grants paragraph, because
    # telling the model the boundary turns a hard rejection into a correct query (§2.3 item 7).
    body = doc.split("WHAT IS NOT READABLE")[1]
    for table in excluded:
        assert f"`{table}`" in body


def test_mode3_tables_are_never_queryable(manifest, sql, doc, objects):
    for table in manifest["exclude_mode3_tables"]:
        assert f"ask.{table}" not in objects
        assert f"VIEW ask.{table} AS" not in sql
        assert not re.search(rf"^ask\.{table}\(", doc, re.M)


def test_assumption_sets_params_is_in_no_artifact(sql, doc, objects):
    assert "params" not in [c["col"] for c in objects["ask.assumption_sets"]]
    assert not any(c["col"] == "params" for cols in objects.values() for c in cols)
    signature = next(line for line in doc.splitlines() if line.startswith("ask.assumption_sets("))
    assert "params" not in signature
    body = sql.split("VIEW ask.assumption_sets AS")[1].split(";")[0]
    assert "params" not in body


def test_no_sensitive_column_is_projected_anywhere(sql, objects):
    """hostname, cli_args, error, warnings and the pickled model blob (§0.4)."""
    forbidden = {"hostname", "cli_args", "error", "warnings", "artifact"}
    leaked = sorted({c["col"] for cols in objects.values() for c in cols} & forbidden)
    assert leaked == []
    for col in forbidden:
        assert not re.search(rf"^\s+{col},?$", sql, re.M), f"{col} is projected by a view"


def test_no_measured_sensitive_value_leaks(sql, doc, objects):
    """The design-time measurements themselves must never be copied into an artifact."""
    for text in (sql, doc, json.dumps(objects)):
        assert "MacBook" not in text
    for text in (doc, json.dumps(objects)):
        assert "/Users/" not in text


# ---------------------------------------------------------------------------
# Shape of the generated DDL
# ---------------------------------------------------------------------------

def test_every_view_has_an_explicit_column_list(sql):
    creates = re.findall(r"CREATE OR REPLACE VIEW ask\.(\w+) AS\n(.*?);\n", sql, re.S)
    assert len(creates) == N_OBJECTS
    assert "SELECT *" not in sql
    for name, body in creates:
        assert not re.search(r"SELECT\s+\*", body), f"ask.{name} star-selects"
        assert body.lstrip().upper().startswith("SELECT"), name
        # count(*) is an aggregate, not a projection: it is the only legitimate star.
        for star in re.finditer(r"\*", body):
            assert body[max(0, star.start() - 7):star.start()].endswith("count("), name


def test_table_backed_views_project_from_public(manifest, sql):
    for table in manifest["tables"]:
        body = sql.split(f"VIEW ask.{table} AS")[1].split(";")[0]
        assert f"FROM public.{table}" in body


def test_views_are_owner_rights(sql):
    """security_invoker would fail with `permission denied for table laps` (§1.2)."""
    ddl = sql.split("\nBEGIN;\n", 1)[1]
    assert "security_invoker" not in ddl


def test_grant_and_allowlist_name_the_same_objects(sql, objects):
    grant_body = sql.split("GRANT SELECT ON")[1].split("TO f1_ask")[0]
    granted = sorted(line.strip().rstrip(",") for line in grant_body.strip().splitlines())
    assert len(granted) == N_OBJECTS
    assert granted == sorted(objects)


def test_object_count(manifest, objects, doc):
    assert len(manifest["tables"]) == N_TABLE_VIEWS
    assert len(manifest["curated_views"]) == 4
    assert len(objects) == N_OBJECTS
    assert sum(1 for line in doc.splitlines() if line.startswith("ask.")) == N_OBJECTS


# ---------------------------------------------------------------------------
# The prompt document (§2.3) — size, order, the four measured traps, and cache safety
# ---------------------------------------------------------------------------

def test_doc_size_is_within_twenty_percent_of_the_design_estimate(doc):
    lo = DOC_TARGET_CHARS * (1 - DOC_TOLERANCE)
    hi = DOC_TARGET_CHARS * (1 + DOC_TOLERANCE)
    assert lo <= len(doc) <= hi, (
        f"schema-doc.txt is {len(doc):,} chars; §2.1 budgets {DOC_TARGET_CHARS:,} "
        f"+/-{DOC_TOLERANCE:.0%} ({lo:,.0f}..{hi:,.0f})"
    )


def test_doc_sections_are_in_prompt_order(doc):
    order = [
        "DIALECT AND HARD RULES",
        "OBJECTS YOU MAY QUERY",
        "CONVENTIONS AND TRAPS",
        "IDENTITY AND VOCABULARY",
        "COVERAGE",
        "WORKED EXAMPLES",
        "WHAT IS NOT READABLE",
    ]
    found = [doc.index(section) for section in order]
    assert found == sorted(found), "schema-doc.txt sections are out of §2.3 order"


def test_the_four_measured_traps_are_spelled_out(doc):
    """Each of these was an actual wrong guess made at design time (§0.4, §2.3)."""
    assert "latest_code" in doc and "NOT `code`" in doc
    assert "latest_name" in doc
    assert "Monte Carlo" in doc and "ZERO ROWS" in doc
    assert "LIKE '%4%'" in doc and "track_status = '4'" in doc
    assert "grid_wins" in doc
    assert "is_representative" in doc
    assert "POSITIVE = THIS DRIVER FASTER" in doc


def test_the_v14_no_qualifying_claim_is_gone_everywhere(doc, sql, objects, manifest):
    """v1.4 told the model qualifying does not exist. It does now (QUALI_SPEC §5.3.1).

    A stale schema document is worse than an absent one, because the model trusts it.
    """
    haystacks = [doc, sql, json.dumps(objects), MANIFEST.read_text()]
    for text in haystacks:
        lowered = text.lower()
        assert "no qualifying sessions" not in lowered
        assert "there are no qualifying" not in lowered
    assert "NO QUALIFYING SESSIONS" not in doc


def test_the_five_qualifying_traps_are_spelled_out(doc):
    """QUALI_SPEC §5.3.1's five conventions, each a measured way to get qualifying wrong."""
    conventions = doc.split("CONVENTIONS AND TRAPS")[1].split("IDENTITY AND VOCABULARY")[0]
    assert "'R' (race), 'S' (sprint), 'Q' (qualifying)" in conventions
    assert "ANY QUESTION ABOUT PACE MUST SAY" in conventions
    assert "ask.season_quali_h2h" in conventions and "NOT" in conventions
    assert "quali_segment IS NOT NULL" in conventions
    assert "segments_entered" in conventions and "knocked_out_in" in conventions
    assert "lap_time_fc_s" in conventions and "NULL on every qualifying lap" in conventions


def test_the_two_telemetry_traps_are_spelled_out(doc):
    """TELEMETRY_SPEC §2.6. Both are measured ways to get a telemetry answer wrong."""
    conventions = doc.split("CONVENTIONS AND TRAPS")[1].split("IDENTITY AND VOCABULARY")[0]
    # T2: one lap per driver per session, so no aggregate over time means anything.
    assert "ask.lap_telemetry_summary" in conventions
    assert "ONE lap per driver per session" in conventions
    assert "over\n  a stint, a race or a season cannot be answered" in conventions
    # §0.3: absent is not zero. Coalescing a flat DRS channel to 0 invents a measurement.
    assert "drs_distance_m" in conventions
    assert "Never coalesce it to 0." in conventions


def test_the_telemetry_array_tables_are_excluded_and_the_scalars_are_not(sql, doc, objects):
    """T6: the ask box sees scalars, never arrays — enforced by the GRANT, not by a prompt rule."""
    for hidden in ("lap_telemetry", "circuit_layout"):
        assert f"ask.{hidden}" not in objects
        assert f"VIEW ask.{hidden} AS" not in sql
        assert not re.search(rf"^ask\.{hidden}\(", doc, re.M)
    for shown in ("lap_telemetry_summary", "lap_corner_speeds", "circuit_corners"):
        assert f"ask.{shown}" in objects, f"{shown} is not in the validator's allowlist"
        assert f"CREATE OR REPLACE VIEW ask.{shown} AS" in sql
        assert re.search(rf"^ask\.{shown}\(", doc, re.M), f"{shown} has no signature line"
    # No CHANNEL array may reach the allowlist by any route (§2.6): the planner misprices
    # unnest() by 63x, so MAX_PLAN_COST cannot see a query that reads 2.2M samples. Small
    # fixed-width arrays elsewhere (sim_race_params.param_chol, mode2_component.cell_ids)
    # are not the hazard and are untouched; a ~626-element channel is.
    channels = {"distance_m", "time_s", "x", "y", "speed_kph", "throttle_pct", "brake",
                "gear", "drs"}
    leaked = sorted(
        f"{name}.{c['col']}" for name, cols in objects.items() for c in cols
        if c["type"].endswith("[]") and c["col"] in channels
    )
    assert leaked == [], leaked
    # x/y are raw unrotated FastF1 units and rotation_deg is not granted: they would be
    # meaningless numbers with a metres-looking magnitude.
    corner_cols = {c["col"] for c in objects["ask.circuit_corners"]}
    assert "x" not in corner_cols and "y" not in corner_cols


def test_the_four_qualifying_views_are_documented_and_granted(doc, sql, objects):
    for name in ("quali_results", "quali_segment_times", "quali_teammate_h2h",
                 "season_quali_h2h"):
        assert f"ask.{name}" in objects, f"{name} is not in the validator's allowlist"
        assert f"CREATE OR REPLACE VIEW ask.{name} AS" in sql
        assert re.search(rf"^ask\.{name}\(", doc, re.M), f"{name} has no signature line"
    cols = {name: {c["col"] for c in columns} for name, columns in objects.items()}
    # D6: both gap-to-pole numbers are queryable, or the model can only tell half the story.
    assert {"gap_to_pole_s", "gap_to_pole_common_s", "gap_to_pole_pct",
            "gap_to_pole_common_pct"} <= cols["ask.quali_results"]
    assert {"segments_entered", "knocked_out_in", "position"} <= cols["ask.quali_results"]
    assert {"a_wins", "b_wins", "median_delta_pct", "kind"} <= cols["ask.season_quali_h2h"]
    assert "below_noise" in cols["ask.quali_teammate_h2h"]
    # These four are timing data, not a fit: inventing an assumption_set_id filter on them
    # is a query that does not run, so the document must not imply one exists.
    for name in ("ask.quali_results", "ask.quali_segment_times", "ask.quali_teammate_h2h",
                 "ask.season_quali_h2h"):
        assert "assumption_set_id" not in cols[name]
    assert "do NOT have that column" in doc


def test_the_five_new_laps_columns_are_exposed(objects, doc):
    """WP1 took laps from 41 to 46 columns; the ask surface is generated, so it follows."""
    cols = {c["col"] for c in objects["ask.laps"]}
    assert {"quali_segment", "segment_source", "is_push_lap", "excl_disallowed",
            "deleted_inferred"} <= cols
    laps_line = next(line for line in doc.splitlines() if line.startswith("ask.laps("))
    assert "quali_segment int" in laps_line


def test_identity_lookup_rule_names_all_four_columns(doc):
    rule = doc.split("IDENTITY AND VOCABULARY")[1].split("COVERAGE")[0]
    for column in ("event_name", "location", "country", "circuit_short_name"):
        assert column in rule
    assert "never one column alone" in rule


def test_coverage_comes_from_the_database(doc):
    coverage = doc.split("\nCOVERAGE\n")[1].split("WORKED EXAMPLES")[0]
    assert "2024" in coverage and "2025" in coverage and "2026" in coverage
    assert "THERE IS NO DATA BEFORE 2024" in coverage
    assert re.search(r"assumption_set_id = \d+", coverage)


def test_vocabulary_is_generated_from_the_database(doc, manifest):
    # The count is read from the database, not written down. It is the number of drivers that
    # actually appear in a session, which is what the vocabulary block lists: an id with no
    # session_entries row cannot be matched by any query, so listing it would be a trap.
    with gen.db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM drivers d WHERE EXISTS "
            "(SELECT 1 FROM session_entries se WHERE se.driver_id = d.driver_id)"
        )
        (n_drivers,) = cur.fetchone()
    conn_free = doc.split("Drivers (")[1].split("\n")[0]
    assert conn_free.startswith(f"{n_drivers})"), (
        f"driver vocabulary is not the live {n_drivers} drivers: {conn_free!r}"
    )
    assert n_drivers >= 28
    assert "max_verstappen" in doc and "hamilton" in doc
    assert "red_bull" in doc and "ferrari" in doc
    assert "Monte Carlo" in doc
    # The orphan identity rows v1.6's backfill left behind must never be taught as ids.
    assert "\n  nan /" not in doc, "the 'nan' identity row is in the prompt vocabulary"
    assert "bearman" in doc and "haas" in doc


def test_fourteen_worked_examples_two_of_them_refusals(manifest, doc):
    examples = manifest["examples"]
    assert len(examples) == 14
    assert sum(1 for e in examples if e.get("refuse")) == 2
    assert doc.count("-> REFUSE") == 2
    for i in range(1, 15):
        assert f"\nQ{i}. " in doc
    # The out-qualifying example is the one v1.4 got wrong, and two of the fourteen are
    # qualifying questions (QUALI_SPEC §5.3.1).
    quali = [e for e in examples if "qualif" in e["question"].lower() or "pole" in e["question"].lower()]
    assert len(quali) == 3, [e["question"] for e in quali]
    for ex in quali:
        assert "teammate_h2h" not in (ex.get("sql") or "")


def test_nothing_volatile_enters_the_cached_prefix(doc):
    """One volatile byte sends the cache hit rate to zero and nobody notices but the bill."""
    assert not re.search(r"\b20\d\d-\d\d-\d\d\b", doc), "an ISO date is in the cached prefix"
    assert not re.search(r"\b\d\d:\d\d:\d\d\b", doc), "a clock time is in the cached prefix"
    for word in ("today", "Today", "current date", "request id", "session cookie"):
        assert word not in doc


# ---------------------------------------------------------------------------
# The allowlist is usable by the validator
# ---------------------------------------------------------------------------

def test_allowlist_entries_are_col_type_pairs(objects):
    for name, columns in objects.items():
        assert name.startswith("ask.")
        assert columns, f"{name} has no columns"
        for column in columns:
            assert set(column) == {"col", "type"}, column
            assert column["col"] and column["type"]


def test_allowlist_carries_the_columns_the_traps_depend_on(objects):
    cols = {name: {c["col"] for c in columns} for name, columns in objects.items()}
    assert "latest_code" in cols["ask.drivers"] and "code" not in cols["ask.drivers"]
    assert "latest_name" in cols["ask.teams"]
    assert "kind" in cols["ask.sessions"] and "session_type" not in cols["ask.sessions"]
    assert "track_status" in cols["ask.laps"] and "is_representative" in cols["ask.laps"]
    assert "grid_wins" in cols["ask.teammate_h2h"]
    assert "circuit_short_name" in cols["ask.race_index"]
    assert "sessions_ok" in cols["ask.data_coverage"]
    assert "warning_count" in cols["ask.session_health"]
