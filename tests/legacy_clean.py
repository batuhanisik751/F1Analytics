"""VERBATIM copy of the pre-refactor ``clean_laps()`` and ``exclusion_report()``.

This is the test oracle for ``tests/test_clean_refactor.py``. It was copied from
``f1lab/clean.py`` BEFORE ``annotate_laps`` was introduced and must never be
edited to "keep up" with the library — its whole value is that it does not move.
Only the imports differ from the original (``_is_green`` is reused from the live
module because it is unchanged by the refactor).
"""

from __future__ import annotations

import pandas as pd

from f1lab.clean import _is_green
from f1lab.config import OUTLIER_THRESHOLD


def clean_laps(session, drop_outliers: bool = True) -> pd.DataFrame:
    """Return representative green-flag racing laps.

    Adds a set of boolean ``excl_*`` columns before filtering, so the notebook
    can show exactly how many laps each rule removed instead of silently
    shrinking the dataset.
    """
    laps = session.laps.copy()

    laps["LapTimeSeconds"] = laps["LapTime"].dt.total_seconds()

    laps["excl_no_time"] = laps["LapTimeSeconds"].isna()
    laps["excl_in_lap"] = laps["PitInTime"].notna()
    laps["excl_out_lap"] = laps["PitOutTime"].notna()
    laps["excl_not_green"] = ~laps["TrackStatus"].apply(_is_green)

    # FastF1's own composite sanity flag. It catches timing glitches and laps
    # spanning a session interruption that the rules above can miss.
    if "IsAccurate" in laps.columns:
        laps["excl_inaccurate"] = ~laps["IsAccurate"].fillna(False).astype(bool)
    else:
        laps["excl_inaccurate"] = False

    # Laps deleted by the stewards for track limits are not legal lap times.
    if "Deleted" in laps.columns:
        laps["excl_deleted"] = laps["Deleted"].fillna(False).astype(bool)
    else:
        laps["excl_deleted"] = False

    excl_cols = [c for c in laps.columns if c.startswith("excl_")]
    laps["is_clean"] = ~laps[excl_cols].any(axis=1)

    clean = laps[laps["is_clean"]].copy()

    if drop_outliers and not clean.empty:
        # Compare each driver only against themselves. An absolute cutoff would
        # punish a slow car for being slow, which is exactly the signal we want
        # to keep.
        median = clean.groupby("Driver")["LapTimeSeconds"].transform("median")
        keep = clean["LapTimeSeconds"] <= median * OUTLIER_THRESHOLD
        clean = clean[keep].copy()

    return clean.reset_index(drop=True)


def exclusion_report(session) -> pd.DataFrame:
    """How many laps each cleaning rule removed, and why.

    Worth printing every time you look at a new race. If one rule is eating an
    unexpected share of the field, something odd happened in that race and you
    want to know about it before you trust any number downstream.
    """
    laps = session.laps.copy()
    laps["LapTimeSeconds"] = laps["LapTime"].dt.total_seconds()

    rules = {
        "no lap time recorded": laps["LapTimeSeconds"].isna(),
        "in-lap (pitting)": laps["PitInTime"].notna(),
        "out-lap (leaving pits)": laps["PitOutTime"].notna(),
        "not fully green flag": ~laps["TrackStatus"].apply(_is_green),
    }
    if "IsAccurate" in laps.columns:
        rules["flagged inaccurate"] = ~laps["IsAccurate"].fillna(False).astype(bool)
    if "Deleted" in laps.columns:
        rules["deleted by stewards"] = laps["Deleted"].fillna(False).astype(bool)

    total = len(laps)
    rows = [
        {"rule": name, "laps_hit": int(mask.sum()), "pct_of_all": 100 * mask.sum() / total}
        for name, mask in rules.items()
    ]
    kept = len(clean_laps(session))
    rows.append({"rule": "SURVIVING (clean + non-outlier)", "laps_hit": kept,
                 "pct_of_all": 100 * kept / total})
    return pd.DataFrame(rows)
