"""The modelling assumptions a set of analytics was computed under, as a stored row.

Every constant in ``f1lab.config`` plus the call-site parameters that ``frames.py``
passes to the analysis functions form one immutable parameter set. Its sha256 is
the key of ``assumption_sets``; every analytics row references the set it was
computed under, so changing a constant produces a *new* visible set rather than a
silent overwrite. Code versions are not part of the hash — they live on the run rows.
"""

from __future__ import annotations

import hashlib
import json

from . import config

# Parameters that are not config constants but are fixed at the call sites in frames.py.
CALL_SITE_PARAMS: dict[str, object] = {
    "apply_lap_km_scaling": False,           # fuel_correct(lap_km=None) in v1 (decision D2)
    "pace_min_laps": 8,                      # pace_ranking(min_laps=8)
    "fuel_sensitivity_values": [0.025, 0.03, 0.035],
    "deg_min_tyre_life": 2,                  # compound_degradation(min_tyre_life=2); degradation() drops TyreLife 1
    "compound_fit_min_laps": 10,             # compound_degradation(min_laps=10)
    "box_whisker": 1.5,                      # pace_distribution(whis=1.5)
}


def snapshot() -> dict:
    """Every UPPER_CASE name in ``f1lab.config`` plus the call-site parameters."""
    params: dict[str, object] = {
        name: getattr(config, name)
        for name in dir(config)
        if name.isupper() and not name.startswith("_")
    }
    params.update(CALL_SITE_PARAMS)
    return params


def hash_of(params: dict) -> str:
    """sha256 hexdigest of the canonical JSON form of ``params``."""
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_or_create(conn) -> int:
    """Insert the current snapshot if unseen; return its ``assumption_set_id``.

    Runs in the caller's transaction (``conn`` is a psycopg connection).
    """
    from psycopg.types.json import Jsonb

    params = snapshot()
    h = hash_of(params)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO assumption_sets (hash, params) VALUES (%s, %s) ON CONFLICT (hash) DO NOTHING",
            (h, Jsonb(params)),
        )
        cur.execute("SELECT assumption_set_id FROM assumption_sets WHERE hash = %s", (h,))
        row = cur.fetchone()
    if row is None:  # pragma: no cover — impossible after the insert above
        raise RuntimeError("assumption_sets row vanished between insert and select")
    return int(row[0])


# --- Qualifying (v1.6) ---------------------------------------------------------
#
# Deliberately a module constant here and NOT in ``f1lab.config``: ``snapshot()``
# hashes every UPPER_CASE name in ``config``, so adding it there would mint a new
# ``assumption_sets`` row for all 89 existing race/sprint sessions and orphan every
# stored analytics row from the set it was actually computed under. Qualifying
# analytics are not fuel-corrected, not outlier-filtered and share no parameter with
# the race path, so they do not belong in that hash.
QUALI_PUSH_LAP_THRESHOLD = 1.03   # lap_time_s <= 1.03 * driver's own best in THIS segment.
# Insensitive: 1.03 -> 71.9% of representative laps, 1.05 -> 73.4%, 1.10 -> 73.7%.
# The benchmark is per-driver-per-segment and MUST NOT be widened to session-wide or
# cross-segment: 2024 China SQ ran SQ1/SQ2 dry (1:35.606) and SQ3 wet (1:57.940, +23.4%);
# a session-wide benchmark keeps zero SQ3 laps and zero drivers.

# Tolerance for matching a cleaned lap time against the official Q1/Q2/Q3 value
# (QUALI_SPEC §2.2 stage 2). The feed publishes to the millisecond, so this is one
# and a half ticks of the clock, not a fudge factor.
QUALI_ANCHOR_TOLERANCE_S = 0.0015

# A lap in segment k strictly faster than that driver's official Qk by more than this
# was struck out by the stewards (§2.4). A diagnostic, never a filter.
QUALI_DISALLOWED_MARGIN_S = 0.002

# Grace at a segment window's opening flag, for a lap begun just before it (§2.2 stage 1).
QUALI_WINDOW_GRACE_S = 120.0
