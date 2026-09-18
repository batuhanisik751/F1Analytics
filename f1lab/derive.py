"""Per-lap facts derived from the raw lap table. Pure pandas, no I/O.

Three things the raw FastF1 lap table implies but does not state:

- the gap to the leader on every lap (the race trace),
- the field-wide flag state per lap number (safety car / VSC / red bands),
- the pit stops, paired from in-lap and out-lap times.

Everything here takes a DataFrame and returns a DataFrame; ``frames.py`` renames
the columns to their database names and resolves driver codes to ids.
"""

from __future__ import annotations

import pandas as pd

from .clean import _is_green

# Most severe first. '5' red, '4' safety car, '6' VSC, '7' VSC ending, '2' yellow, '1' green.
STATUS_SEVERITY: list[str] = ["5", "4", "6", "7", "2", "1"]


def gap_to_leader(laps: pd.DataFrame) -> pd.DataFrame:
    """Columns: Driver, LapNumber, SessionTimeS, GapToLeaderS, IntervalS, LeaderDriver.

    FastF1 ``laps.Time`` is the session time when the car completed ``LapNumber``,
    so the gap on lap N is simply that time minus the smallest such time on lap N.
    ``IntervalS`` is the gap to the car immediately ahead by session time (NaN for
    the leader), computed from the sorted-time diff so rows with NaN ``Position``
    are handled.

    Rows that are not lap completions get NaN in every derived column (their raw
    ``SessionTimeS`` is still reported): rows with NaT ``Time``, and the rows FastF1
    fabricates for a lap a car never finished (``FastF1Generated`` with NaT
    ``LapTime``). The latter carry a synthetic ``Time`` — the leader's own time on
    the lap-1 row of a car that crashed at the start, ``LapStartTime + 150 s`` on a
    retirement row — which would otherwise tie a car with zero laps to the leader at
    gap 0 (2025 R1) or even name it the leader (2024 R24 lap 1, Perez). Exact time
    ties between real laps resolve to the lower ``Position``; the sort is stable.
    """
    t = laps[["Driver", "LapNumber", "Time"]].copy()
    t["SessionTimeS"] = t["Time"].dt.total_seconds()
    valid = t["SessionTimeS"].notna().to_numpy()
    if "FastF1Generated" in laps.columns and "LapTime" in laps.columns:
        generated = laps["FastF1Generated"].astype("boolean").fillna(False).to_numpy(dtype=bool)
        valid &= ~(generated & laps["LapTime"].isna().to_numpy())
    if "Position" in laps.columns:
        t["_pos"] = pd.to_numeric(laps["Position"], errors="coerce").fillna(float("inf")).to_numpy()
    else:
        t["_pos"] = float("inf")
    v = t[valid].sort_values(["LapNumber", "SessionTimeS", "_pos"], kind="mergesort")
    leader_t = v.groupby("LapNumber")["SessionTimeS"].transform("min")
    v["GapToLeaderS"] = v["SessionTimeS"] - leader_t
    v["IntervalS"] = v.groupby("LapNumber")["SessionTimeS"].diff()          # NaN for the leader
    v["LeaderDriver"] = v.groupby("LapNumber")["Driver"].transform("first")  # first == min time after the sort
    return (t.drop(columns=["Time", "_pos"])
            .merge(v[["Driver", "LapNumber", "GapToLeaderS", "IntervalS", "LeaderDriver"]],
                   on=["Driver", "LapNumber"], how="left"))


def _worst_code(statuses: pd.Series) -> str:
    """The most severe single status code seen in a group of TrackStatus strings.

    '0' when no row carries a status at all. A code outside the known list ranks
    just above green ('1'): it is not green, but nothing worse is known about it.
    """
    codes: set[str] = set()
    for s in statuses:
        if isinstance(s, str) and s:
            codes.update(s)
    if not codes:
        return "0"
    for code in STATUS_SEVERITY[:-1]:
        if code in codes:
            return code
    unknown = sorted(c for c in codes if c not in STATUS_SEVERITY)
    if unknown:
        return unknown[0]
    return "1"


def lap_status(laps: pd.DataFrame) -> pd.DataFrame:
    """Field-wide flag state per lap number.

    Columns: LapNumber, IsGreen, WorstStatus, DriversAffected, DriversOnLap.
    ``IsGreen`` is True only when every lap row on that lap number satisfies
    ``clean._is_green``; ``DriversAffected`` counts the rows that do not.
    Accepts the raw ``session.laps`` or the annotated frame (only ``LapNumber`` and
    ``TrackStatus`` are read). Rows without a lap number are ignored.
    """
    t = laps.loc[laps["LapNumber"].notna(), ["LapNumber", "TrackStatus"]].copy()
    t["_green"] = t["TrackStatus"].apply(_is_green)

    rows = []
    for lap, grp in t.groupby("LapNumber", sort=True):
        rows.append({
            "LapNumber": int(lap),
            "IsGreen": bool(grp["_green"].all()),
            "WorstStatus": _worst_code(grp["TrackStatus"]),
            "DriversAffected": int((~grp["_green"]).sum()),
            "DriversOnLap": int(len(grp)),
        })
    columns = ["LapNumber", "IsGreen", "WorstStatus", "DriversAffected", "DriversOnLap"]
    return pd.DataFrame(rows, columns=columns)


def pit_stops(laps: pd.DataFrame) -> pd.DataFrame:
    """Pit stops paired from PitInTime / PitOutTime.

    Columns: Driver, StopNumber, LapIn, LapOut, PitInTimeS, PitOutTimeS, PitLaneS,
    CompoundIn, CompoundOut. A stop is every lap with a ``PitInTime``; it is paired
    with the NEXT lap number of the same driver only if that lap has a
    ``PitOutTime`` — otherwise ``LapOut``/``PitOutTimeS``/``PitLaneS``/``CompoundOut``
    are NaN (retired in the pits, red flag). Out-laps without a preceding in-lap
    (pit-lane starts, restarts) are not stops. ``StopNumber`` is 1-based per driver
    in lap order.
    """
    cols = ["Driver", "LapNumber", "PitInTime", "PitOutTime", "Compound"]
    t = laps.loc[laps["LapNumber"].notna(), cols].copy()
    t["in_s"] = t["PitInTime"].dt.total_seconds()
    t["out_s"] = t["PitOutTime"].dt.total_seconds()

    rows = []
    for drv, grp in t.groupby("Driver", sort=True):
        grp = grp.sort_values("LapNumber")
        by_lap = {int(r.LapNumber): r for r in grp.itertuples(index=False)}
        n = 0
        for lap in sorted(by_lap):
            r = by_lap[lap]
            if pd.isna(r.in_s):
                continue
            n += 1
            nxt = by_lap.get(lap + 1)
            has_out = nxt is not None and not pd.isna(nxt.out_s)
            rows.append({
                "Driver": drv,
                "StopNumber": n,
                "LapIn": lap,
                "LapOut": lap + 1 if has_out else None,
                "PitInTimeS": float(r.in_s),
                "PitOutTimeS": float(nxt.out_s) if has_out else None,
                "PitLaneS": float(nxt.out_s - r.in_s) if has_out else None,
                "CompoundIn": r.Compound,
                "CompoundOut": nxt.Compound if has_out else None,
            })
    columns = ["Driver", "StopNumber", "LapIn", "LapOut", "PitInTimeS", "PitOutTimeS",
               "PitLaneS", "CompoundIn", "CompoundOut"]
    out = pd.DataFrame(rows, columns=columns)
    if not out.empty:
        out["LapOut"] = out["LapOut"].astype("Int64")
    return out
