"""[db] QUALI_SPEC v1.6 §3.6 / §4.3 -- the season qualifying head-to-head aggregate.

Reads the live backfilled database (WP4). The pure-logic cases build their own
``_SeasonData`` stub so they run without touching Postgres.
"""

from __future__ import annotations

import pandas as pd
import pytest

from f1lab import frames, season

pytestmark = pytest.mark.db


# -- pure logic (no database) ------------------------------------------------------------

def test_is_caveated_reads_both_warning_keys():
    assert season._is_caveated(["quali_cross_segment_ok=False", "quali_segment_repairs=0"])
    assert season._is_caveated(["quali_cross_segment_ok=True", "quali_segment_repairs=3"])
    assert not season._is_caveated(["quali_cross_segment_ok=True", "quali_segment_repairs=0"])
    assert not season._is_caveated([])
    assert not season._is_caveated(None)
    # a malformed count must not crash the whole season recompute
    assert not season._is_caveated(["quali_segment_repairs=oops"])


class _Stub:
    """The four attributes ``_season_quali_h2h`` actually reads."""

    def __init__(self, year, results, pairs, caveated=()):
        self.year = year
        self.quali_results = pd.DataFrame(
            results, columns=["session_id", "driver_id", "team_id", "position", "kind"])
        self.quali_pairs = pd.DataFrame(
            pairs, columns=["session_id", "team_id", "driver_a", "driver_b",
                            "delta_s", "delta_pct", "comparable", "kind"])
        self.quali_caveated = set(caveated)


def test_empty_year_returns_the_contract_columns():
    out = season._season_quali_h2h(_Stub(2024, [], []))
    assert list(out.columns) == frames.EXPECTED_COLUMNS["season_quali_h2h"]
    assert out.empty


def _two_driver_stub():
    res, pairs = [], []
    for sid, pa, pb in [(1, 1, 2), (2, 3, 2), (3, 5, 4)]:
        res += [(sid, "alpha", "t", pa, "Q"), (sid, "beta", "t", pb, "Q")]
    # §3.5: driver_a of the per-session row is the QUICKER driver, delta_s > 0.
    pairs.append((1, "t", "alpha", "beta", 0.2, 0.2, True, "Q"))
    pairs.append((2, "t", "beta", "alpha", 0.4, 0.4, True, "Q"))
    pairs.append((3, "t", "alpha", "beta", None, None, False, "Q"))  # crashed out: no delta
    return _Stub(2024, res, pairs, caveated={3})


def test_signs_wins_and_the_comparable_filter():
    out = season._season_quali_h2h(_two_driver_stub())
    assert len(out) == 1
    r = out.iloc[0]
    # canonical ordering is by driver_id, not by who was quicker
    assert (r.driver_a, r.driver_b) == ("alpha", "beta")
    assert (r.sessions_counted, r.a_wins, r.b_wins) == (3, 1, 2)
    # session 3 counts toward the wins but leaves the median (§4.3 non-random missingness)
    assert r.deltas_counted == 2
    # negative = driver_a faster (§3.6); median of (-0.2, +0.4)
    assert r.median_delta_s == pytest.approx(0.1)
    assert r.median_delta_pct == pytest.approx(0.1)
    assert r.mad_delta_pct == pytest.approx(0.3)
    assert r.sessions_caveated == 1


def test_q_and_sq_are_never_pooled():
    """§5.2 / D24: kind is in the primary key, so the same pair yields two rows."""
    res, pairs = [], []
    for sid, kind in [(1, "Q"), (2, "SQ")]:
        res += [(sid, "alpha", "t", 1, kind), (sid, "beta", "t", 2, kind)]
        pairs.append((sid, "t", "alpha", "beta", 0.3, 0.3, True, kind))
    out = season._season_quali_h2h(_Stub(2024, res, pairs))
    assert sorted(out["kind"]) == ["Q", "SQ"]
    assert set(out["sessions_counted"]) == {1}


def test_a_gated_session_still_counts_its_win():
    """D8 suppressed the per-segment tables, so there is no h2h row -- the win survives."""
    res = [(9, "alpha", "t", 1, "Q"), (9, "beta", "t", 2, "Q")]
    out = season._season_quali_h2h(_Stub(2024, res, []))
    r = out.iloc[0]
    assert (r.sessions_counted, r.a_wins, r.deltas_counted) == (1, 1, 0)
    assert r.median_delta_s is None and r.mad_delta_pct is None


# -- against the live backfilled database ------------------------------------------------

@pytest.fixture(scope="module")
def computed(db_conn):
    out = {y: season.compute(db_conn, y)["season_quali_h2h"] for y in (2024, 2025, 2026)}
    db_conn.rollback()
    return out


@pytest.mark.parametrize("year", [2024, 2025, 2026])
def test_live_invariants(computed, year):
    f = computed[year]
    assert len(f), f"{year}: no season_quali_h2h rows built"
    assert list(f.columns) == frames.EXPECTED_COLUMNS["season_quali_h2h"]
    # the two DB CHECKs, before they ever reach the DB
    assert ((f.a_wins + f.b_wins) == f.sessions_counted).all()
    assert set(f["kind"]) <= {"Q", "SQ"}
    # the two WP5 verification queries
    assert not (f.deltas_counted > f.sessions_counted).any()
    assert not (f.sessions_caveated > f.sessions_counted).any()
    assert (f.driver_a < f.driver_b).all(), "driver_a/driver_b must be canonically ordered"
    assert not f.duplicated(["year", "kind", "team_id", "driver_a", "driver_b"]).any()
    # a row with no comparable session must carry no median at all, and vice versa
    assert (f.loc[f.deltas_counted == 0, "median_delta_pct"].isna()).all()
    assert (f.loc[f.deltas_counted > 0, "median_delta_pct"].notna()).all()
    assert (f.loc[f.deltas_counted > 0, "mad_delta_pct"] >= 0).all()


def test_caveated_sessions_are_the_four_measured_ones(db_conn):
    """§4.6: cross_segment_ok false OR a segment repair. Four sessions corpus-wide."""
    found = set()
    for y in (2024, 2025, 2026):
        found |= season._SeasonData(db_conn, y).quali_caveated
    db_conn.rollback()
    assert len(found) == 4, f"expected 4 caveated Q/SQ sessions, found {sorted(found)}"


def test_sao_paulo_2024_is_counted_as_caveated(db_conn):
    """The repaired session (ALB/ALO/PIA seg2 waivers) must show up in sessions_caveated."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id FROM sessions WHERE year = 2024 AND round = 21 AND kind = 'Q'")
        sid = cur.fetchone()[0]
    f = season.compute(db_conn, 2024)["season_quali_h2h"]
    db_conn.rollback()
    assert sid in season._SeasonData(db_conn, 2024).quali_caveated
    db_conn.rollback()
    assert f[f.kind == "Q"]["sessions_caveated"].sum() >= 10
