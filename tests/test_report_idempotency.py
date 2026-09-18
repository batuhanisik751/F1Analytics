"""MODE3_SPEC §4.5 -- idempotency, the part that has to be right.

``ingest --force`` is routine on this project. If ``--force`` regenerated every report a
full-season re-ingest would spend real money reproducing identical prose, so the decision
to call a model is made by a hash over the grounding bundle and nothing else:

    skip generation when a race_report row exists with
          grounding_sha256 == computed
      AND prompt_version   == report.PROMPT_VERSION
      AND model            == report.REPORT_MODEL
      AND status           != 'refused'

Everything here is asserted on ``report.API_CALLS``, a module-level counter, rather than
on elapsed time -- a timing assertion would pass for the wrong reason on a slow day.
"""

from __future__ import annotations

import copy
import datetime

import pytest

from f1lab import report as R
from tests.test_report_grounding import _complete, synthetic_bundle


@pytest.fixture
def bundle() -> dict:
    return _complete(synthetic_bundle())


def test_canonical_json_is_stable_across_two_builds(bundle):
    """Sorted keys, repr() floats, no whitespace -- the same rows hash the same twice."""
    again = _complete(synthetic_bundle())
    assert R.canonical_json(bundle) == R.canonical_json(again)
    assert R.grounding_sha256(bundle) == R.grounding_sha256(again)


def test_key_order_does_not_change_the_hash(bundle):
    """Canonicalisation matters or the hash churns on nothing and --force starts costing
    money on every re-ingest."""
    shuffled = {k: bundle[k] for k in reversed(list(bundle))}
    assert R.grounding_sha256(shuffled) == R.grounding_sha256(bundle)


def test_a_timestamp_inside_the_bundle_is_refused(bundle):
    """A generation timestamp in the hashed object would make every hash unique and
    silently turn idempotency off, so it raises instead."""
    poisoned = copy.deepcopy(bundle)
    poisoned["generated_at"] = datetime.datetime(2026, 9, 14, 12, 0, 0)
    with pytest.raises(TypeError, match="timestamp"):
        R.canonical_json(poisoned)


def test_a_changed_number_changes_the_hash(bundle):
    """The coupling that is actually wanted: if a recompute moves a cited number, the
    hash moves with it and the report regenerates by itself."""
    moved = copy.deepcopy(bundle)
    moved["finish"][1]["gap_to_winner_s"]["value"] = 2.432
    assert R.grounding_sha256(moved) != R.grounding_sha256(bundle)


def _stored(sha: str, **over) -> dict:
    row = {"grounding_sha256": sha, "prompt_version": R.PROMPT_VERSION,
           "model": R.REPORT_MODEL, "status": "ok"}
    row.update(over)
    return row


def test_should_skip_is_the_whole_force_decision(bundle):
    sha = R.grounding_sha256(bundle)
    assert R.should_skip(_stored(sha), sha) is True
    assert R.should_skip(None, sha) is False
    assert R.should_skip(_stored("deadbeef"), sha) is False
    assert R.should_skip(_stored(sha, prompt_version=R.PROMPT_VERSION + 1), sha) is False
    assert R.should_skip(_stored(sha, model="claude-sonnet-5"), sha) is False
    # A refusal is a normal, logged outcome (§4.6) -- and it is always retried, because
    # leaving it stored would mean a race that can never get a report back.
    assert R.should_skip(_stored(sha, status="refused"), sha) is False
    # A skip is not retried until the numbers change: the data is still thin.
    assert R.should_skip(_stored(sha, status="skipped"), sha) is True


def test_prompt_version_and_model_are_not_in_config(bundle):
    """§4.5 / decision 8. ``assumptions.snapshot()`` harvests every UPPER_CASE name in
    config.py, and assumption_set_id keys ~20 analytics tables across 79 sessions, so a
    prompt version there would make rewording a sentence force a full numeric recompute
    of the whole database."""
    from f1lab import config
    for name in ("PROMPT_VERSION", "REPORT_MODEL", "REPORT_EFFORT"):
        assert not hasattr(config, name), f"{name} must not live in config.py"
        assert hasattr(R, name)


def test_report_model_and_effort_are_the_fixed_decision():
    """§0.3 decision 7: claude-opus-5 at effort 'high' for reports. ~24 races a year, the
    most publicly visible prose the project produces, regeneration rare."""
    assert R.REPORT_MODEL == "claude-opus-5"
    assert R.REPORT_EFFORT == "high"


def test_cost_per_race_matches_the_estimate():
    """§4.7: input ~6,000 tokens, output ~900, at $5/$25 per MTok -> about $0.053."""
    assert R.est_cost_usd({"input_tokens": 6000, "output_tokens": 900}) == pytest.approx(
        0.053, abs=0.001)


class _Cursor:
    """Enough psycopg surface for the companion step: the session list and the upsert.

    The session list is read from ``session_ingests`` filtered to this assumption set,
    never from ``sessions`` alone -- see the comment on that query in report.py.
    """

    def __init__(self, log: list[tuple[str, object]]):
        self.log = log
        self._rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.log.append((sql, params))
        self._rows = [(1,)] if "FROM session_ingests" in sql else []

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self):
        self.log: list[tuple[str, object]] = []
        self.commits = 0

    def cursor(self):
        return _Cursor(self.log)

    def commit(self):
        self.commits += 1


def _no_calls(*a, **k):
    raise AssertionError("generate_report was called; this path must cost $0")


def test_force_on_an_unchanged_session_makes_zero_api_calls(bundle, monkeypatch):
    """§4.5, the money test. --force recomputes the numbers; unchanged numbers leave the
    hash alone, so the stored prose is still correct and nothing is regenerated."""
    sha = R.grounding_sha256(bundle)
    monkeypatch.setattr(R, "build_grounding", lambda conn, sid, asid: bundle)
    monkeypatch.setattr(R, "_existing", lambda conn, sid, asid: _stored(sha))
    monkeypatch.setattr(R, "generate_report", _no_calls)
    monkeypatch.setattr(R, "has_api_key", lambda: True)
    before = R.API_CALLS
    out = R.recompute_reports(_Conn(), 1, force=True)
    assert out["unchanged"] == 1 and out["generated"] == 0
    assert out["api_calls"] == 0 and out["cost_usd"] == 0.0
    assert R.API_CALLS == before


def test_regen_ignores_the_hash(bundle, monkeypatch):
    """--regen-reports is the separate, explicit flag for 'the prompt or model changed'."""
    sha = R.grounding_sha256(bundle)
    monkeypatch.setattr(R, "build_grounding", lambda conn, sid, asid: bundle)
    monkeypatch.setattr(R, "_existing", lambda conn, sid, asid: _stored(sha))
    monkeypatch.setattr(R, "has_api_key", lambda: True)
    seen = []

    def fake_generate_one(conn, sid, asid):
        seen.append(sid)
        return {"status": "ok", "api_calls": 1, "cost": 0.05}

    monkeypatch.setattr(R, "generate_one", fake_generate_one)
    out = R.recompute_reports(_Conn(), 1, regen=True)
    assert seen == [1] and out["generated"] == 1 and out["api_calls"] == 1


def test_a_thin_race_is_skipped_without_an_api_call(monkeypatch):
    """§4.6: an ``insufficient`` bundle makes NO API call at all. A thin race gets no
    report rather than a vague one -- vague prose over missing data is exactly how a
    reader is misled."""
    thin = synthetic_bundle()
    thin["finish"] = thin["finish"][:2]
    thin.update({"strategy": {"drivers": [], "optimal": []}, "swings": [], "moments": [],
                 "teammates": [], "standings_delta": [], "weather": {"samples": R.fact(0, "0", None)},
                 "coverage": {"status": "partial", "clean_laps": 0, "raw_laps": 0,
                              "total_laps": 0, "warnings": 9}, "known_gaps": []})
    thin["pace"] = []
    assert R.completeness(thin) == "insufficient"
    monkeypatch.setattr(R, "build_grounding", lambda conn, sid, asid: thin)
    monkeypatch.setattr(R, "_existing", lambda conn, sid, asid: None)
    monkeypatch.setattr(R, "generate_report", _no_calls)
    monkeypatch.setattr(R, "has_api_key", lambda: True)
    conn = _Conn()
    out = R.recompute_reports(conn, 1)
    assert out["skipped"] == 1 and out["api_calls"] == 0
    upserts = [p for s, p in conn.log if s is R.UPSERT_SQL]
    assert len(upserts) == 1
    row = upserts[0]
    # race_report_body_check: (status='ok') = (result IS NOT NULL).
    assert row["status"] == "skipped" and row["result"] is None
    assert row["skipped_reason"] and row["completeness"] == "insufficient"


def test_an_ingest_without_a_key_still_succeeds(bundle, monkeypatch):
    """§4.4: an ingest without a key must exit 0. Four other modes depend on ingest and
    none of them depends on this one."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(R, "build_grounding", lambda conn, sid, asid: bundle)
    monkeypatch.setattr(R, "_existing", lambda conn, sid, asid: None)
    monkeypatch.setattr(R, "generate_report", _no_calls)
    assert R.has_api_key() is False
    out = R.recompute_reports(_Conn(), 1, force=True)
    assert out["api_calls"] == 0 and out["generated"] == 0 and out["skipped"] == 1


@pytest.mark.db
def test_the_bundle_hashes_equal_across_two_builds_from_the_same_rows(db_conn):
    """The same assertion as the synthetic test, against real stored rows -- the case
    where a Decimal, a None or a float repr could churn the hash in practice."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id, assumption_set_id FROM session_ingests "
                    " WHERE session_id IN (SELECT session_id FROM sessions WHERE kind='R') "
                    " ORDER BY session_id DESC LIMIT 3")
        pairs = cur.fetchall()
    assert pairs, "no race sessions are ingested"
    for sid, asid in pairs:
        a = R.build_grounding(db_conn, sid, asid)
        b = R.build_grounding(db_conn, sid, asid)
        assert R.grounding_sha256(a) == R.grounding_sha256(b), f"hash churned on {sid}"
        assert R.completeness(a) in ("ok", "partial", "insufficient")
    db_conn.rollback()


@pytest.mark.db
def test_the_step_never_reports_on_another_assumption_sets_races(db_conn, monkeypatch):
    """Every analytics family is keyed by assumption_set_id. A race ingested under an
    older set has no pace, no stints and no swings under this one, and walking
    ``sessions`` alone would store 'this race was too thin for a report' about races that
    are fully ingested elsewhere. Measured during the build: 71 sessions of kind 'R'
    exist and 62 are ingested, so the difference is not hypothetical.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with db_conn.cursor() as cur:
        cur.execute("SELECT si.assumption_set_id, count(*) FROM session_ingests si "
                    "  JOIN sessions s USING (session_id) WHERE s.kind = 'R' "
                    " GROUP BY 1 ORDER BY 2 DESC LIMIT 1")
        asid, n_ingested = cur.fetchone()
        cur.execute("SELECT count(*) FROM sessions WHERE kind = 'R'")
        n_sessions = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM race_report")
        before = cur.fetchone()[0]
    out = R.recompute_reports(db_conn, asid)
    touched = out["generated"] + out["skipped"] + out["refused"] + out["unchanged"]
    assert touched == n_ingested <= n_sessions
    assert out["api_calls"] == 0 and out["generated"] == 0
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM race_report")
        assert cur.fetchone()[0] == before, "a keyless run wrote rows"
    db_conn.rollback()
