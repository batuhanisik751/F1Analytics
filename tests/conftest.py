"""Shared fixtures: three cached race sessions and the ``db`` marker gate.

The sessions are loaded once per test session from the on-disk FastF1 cache at
``<root>/cache`` (never from the network on purpose — a missing cache entry means
the fixture simply fails loudly).

    hungary_2024  (2024, 13)  the notebook's reference race; clean, no quirks
    miami_2025    (2025, 6)   354 laps with the literal string 'nan' as Compound and NaN Stint
    r1_2026       (2026, 1)   22 drivers / 11 teams, two DNS drivers, VSC laps

``db``-marked tests are skipped unless ``DATABASE_URL`` (or the default DSN) is
reachable AND ``drizzle.__drizzle_migrations`` exists, i.e. WP0's migration ran.

Two environment switches make the suite honest on a machine without the cache
(OPS_SPEC §1.3, the visible-skip rule):

    F1_CI=1          the four session fixtures skip with a fixed reason instead of
                     failing, and every ``cache``-marked item skips with its own fixed
                     reason. Both reasons are printed by ``-rs`` and counted by CI.
    F1_REQUIRE_DB=1  an unreachable or unmigrated database is ``pytest.exit(3)``, never
                     a skip: a CI run that lost its database cannot be green.
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

warnings.filterwarnings("ignore")

from fastf1.logger import set_log_level  # noqa: E402

set_log_level("ERROR")

from f1lab import clean  # noqa: E402

FIXTURE_ROUNDS = {
    "hungary_2024": (2024, 13),
    "miami_2025": (2025, 6),
    "r1_2026": (2026, 1),
}


CI = os.environ.get("F1_CI") == "1"
REQUIRE_DB = os.environ.get("F1_REQUIRE_DB") == "1"

# The two fixed skip reasons. CI classifies skips by these strings; do not reword them.
SKIP_FIXTURE_CACHE = "FastF1 cache absent (F1_CI=1)"
SKIP_CACHE_MARKER = "cache marker: needs the FastF1 cache"

# The fixtures that read the on-disk cache. CI counts items by this set (§1.1 shape a).
SESSION_FIXTURES = frozenset({"hungary_2024", "miami_2025", "r1_2026", "any_session"})


def _load(year: int, rnd: int):
    return clean.load_race(year, rnd, "R", cache=ROOT / "cache")


def _ci_skip() -> None:
    """Under F1_CI=1 a session fixture never touches the cache: it skips, visibly."""
    if CI:
        pytest.skip(SKIP_FIXTURE_CACHE)


@pytest.fixture(scope="session")
def hungary_2024():
    _ci_skip()
    return _load(*FIXTURE_ROUNDS["hungary_2024"])


@pytest.fixture(scope="session")
def miami_2025():
    _ci_skip()
    return _load(*FIXTURE_ROUNDS["miami_2025"])


@pytest.fixture(scope="session")
def r1_2026():
    _ci_skip()
    return _load(*FIXTURE_ROUNDS["r1_2026"])


@pytest.fixture(scope="session", params=list(FIXTURE_ROUNDS))
def any_session(request):
    """Parametrised over all three fixtures; each is loaded once per test session."""
    _ci_skip()
    return request.getfixturevalue(request.param)


# ---------------------------------------------------------------------------
# pooled stint seed (no database)
# ---------------------------------------------------------------------------

# SYNTHETIC FIXTURE INPUT — NOT a measured number, never compare it to the DB.
# frames.build_race_frames reads pooled degradation slopes and pit loss from the
# module-level frames.POOLED_STINT (f1lab/frames.py:38, consumed at :992); only
# ingest.run_season populates it (f1lab/ingest.py:450). Called directly from a
# no-database test it is {}, so build_optimal_stint correctly has no pit-loss
# estimate and _guard records optimal_stint='empty' (MODE1_SPEC §4.4 — an empty
# pooled dict is a VALID 'session-only' input). Tests that assert every analytics
# key is 'ok' seed these ROUND, made-up values so the assertion keeps its teeth.
SYNTHETIC_POOLED_STINT = {
    "slope_by_compound": {
        "SOFT": {"n_fits": 400, "median": 0.06, "q1": 0.02, "q3": 0.11},
        "MEDIUM": {"n_fits": 1100, "median": 0.05, "q1": 0.01, "q3": 0.10},
        "HARD": {"n_fits": 1100, "median": 0.04, "q1": 0.02, "q3": 0.08},
    },
    "pit_loss_by_circuit": {},
    "pit_loss_pooled_s": 22.0,
}


@pytest.fixture
def pooled_stint_seed(monkeypatch):
    """Seed frames.POOLED_STINT with SYNTHETIC_POOLED_STINT for the whole test."""
    from f1lab import frames

    monkeypatch.setattr(frames, "POOLED_STINT", dict(SYNTHETIC_POOLED_STINT))
    return SYNTHETIC_POOLED_STINT


# ---------------------------------------------------------------------------
# db marker gate
# ---------------------------------------------------------------------------

def _db_available() -> tuple[bool, str]:
    try:
        from f1lab import db
    except Exception as e:  # noqa: BLE001  (psycopg missing)
        return False, f"psycopg unavailable: {e}"
    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                cur.execute("select to_regclass('drizzle.__drizzle_migrations')")
                exists = cur.fetchone()[0] is not None
        if not exists:
            return False, "drizzle.__drizzle_migrations does not exist (run `npm run db:migrate` in web/)"
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, f"DATABASE_URL not reachable: {type(e).__name__}: {e}"


_DB_STATE: tuple[bool, str] | None = None


def pytest_collection_modifyitems(config, items):
    global _DB_STATE
    if CI:
        # Shape (b) of §1.1: tests that call the loaders directly carry the ``cache``
        # marker. CI deselects them with ``-m "not cache"``; if one is ever collected
        # anyway it skips with a printed reason rather than reaching FastF1's network path.
        cache_skip = pytest.mark.skip(reason=SKIP_CACHE_MARKER)
        for item in items:
            if "cache" in item.keywords:
                item.add_marker(cache_skip)
    if not any("db" in item.keywords for item in items):
        return
    if _DB_STATE is None:
        _DB_STATE = _db_available()
    ok, reason = _DB_STATE
    if ok:
        return
    if REQUIRE_DB:
        # A lost database is a failed run, never a quiet skip (§1.3 mechanism 2).
        pytest.exit(f"F1_REQUIRE_DB=1 and the database is unavailable: {reason}", returncode=3)
    skip = pytest.mark.skip(reason=f"db marker: {reason}")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def db_conn():
    """A committed-autocommit-off psycopg connection; the test decides what to commit."""
    from f1lab import db

    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(scope="session")
def dsn() -> str:
    from f1lab import db

    return os.environ.get("DATABASE_URL") or db.DEFAULT_DSN
