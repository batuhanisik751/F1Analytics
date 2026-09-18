"""derive.py against the cached sessions: gap rank == Position, leader == Position 1,
pit stops == paired in/out laps, lap_status severity."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from f1lab import clean, derive

CACHE = Path(__file__).resolve().parent.parent / "cache"


def test_gap_to_leader_rank_equals_position(any_session):
    laps = any_session.laps
    g = derive.gap_to_leader(laps)
    assert list(g.columns) == ["Driver", "LapNumber", "SessionTimeS", "GapToLeaderS", "IntervalS", "LeaderDriver"]
    assert len(g) == len(laps)
    # Row order is preserved (left merge), so we can attach Position positionally.
    assert (g["Driver"].values == laps["Driver"].values).all()
    assert np.array_equal(g["LapNumber"].values, laps["LapNumber"].values)
    g = g.assign(Position=laps["Position"].values)

    valid = g["SessionTimeS"].notna() & g["Position"].notna()
    ranks = g[valid].groupby("LapNumber")["SessionTimeS"].rank(method="first")
    assert (ranks.values == g.loc[valid, "Position"].values).all()

    # Leader on every lap is the Position == 1 car and has gap 0 and no interval.
    lead = g[g["Position"] == 1]
    assert (lead["LeaderDriver"] == lead["Driver"]).all()
    assert (lead["GapToLeaderS"] == 0).all()
    assert lead["IntervalS"].isna().all()
    # Everyone else: positive gap, positive interval, and the leader named consistently per lap.
    others = g[valid & (g["Position"] > 1)]
    assert (others["GapToLeaderS"] > 0).all()
    assert (others["IntervalS"] > 0).all()
    assert (g[valid].groupby("LapNumber")["LeaderDriver"].nunique() == 1).all()


def test_gap_to_leader_ignores_fastf1_generated_rows():
    """2024 R24 lap 1 in miniature: FastF1 fabricates a lap-1 row for Perez (crashed at the
    start) with NOR's own Time, LapTime NaT, Position NaN, FastF1Generated True — and lists it
    BEFORE the leader's row. It must get no gap/interval/leader and must not become the leader."""
    td = pd.to_timedelta
    laps = pd.DataFrame({
        "Driver": ["PER", "NOR", "SAI", "LAW", "NOR", "SAI"],
        "LapNumber": [1.0, 1.0, 1.0, 2.0, 2.0, 2.0],
        "Time": td(["0:58:19.229", "0:58:19.229", "0:58:20.500", "1:01:49.000", "0:59:45.000", "0:59:46.271"]),
        "LapTime": td([pd.NaT, "0:01:40.100", "0:01:41.300", pd.NaT, "0:01:25.800", "0:01:25.700"]),
        "Position": [np.nan, 1.0, 2.0, np.nan, 1.0, 2.0],
        "FastF1Generated": [True, False, False, True, False, False],   # LAW: retirement row, LapStart + 150 s
    })
    g = derive.gap_to_leader(laps)
    assert list(g.columns) == ["Driver", "LapNumber", "SessionTimeS", "GapToLeaderS", "IntervalS", "LeaderDriver"]
    assert (g["Driver"].values == laps["Driver"].values).all()
    g = g.set_index(["Driver", "LapNumber"])

    for synthetic in (("PER", 1.0), ("LAW", 2.0)):
        row = g.loc[synthetic]
        assert row[["GapToLeaderS", "IntervalS"]].isna().all() and pd.isna(row["LeaderDriver"])
    assert g.loc[("PER", 1.0), "SessionTimeS"] == pytest.approx(3499.229)   # the raw time is still reported

    nor = g.loc[("NOR", 1.0)]
    assert nor["LeaderDriver"] == "NOR" and nor["GapToLeaderS"] == 0 and pd.isna(nor["IntervalS"])
    sai = g.loc[("SAI", 1.0)]
    assert sai["LeaderDriver"] == "NOR" and sai["GapToLeaderS"] == pytest.approx(1.271)
    assert sai["IntervalS"] == pytest.approx(1.271)
    assert g.loc[("SAI", 2.0), "IntervalS"] == pytest.approx(1.271)
    assert (g.loc[[("NOR", 2.0), ("SAI", 2.0)], "LeaderDriver"] == "NOR").all()


def test_gap_to_leader_exact_tie_resolves_to_the_classified_leader():
    """Two real laps completed at the same instant: the Position 1 car leads, whatever the row order."""
    td = pd.to_timedelta
    laps = pd.DataFrame({
        "Driver": ["B", "A"],
        "LapNumber": [7.0, 7.0],
        "Time": td(["0:20:00.000", "0:20:00.000"]),
        "LapTime": td(["0:01:30.000", "0:01:30.000"]),
        "Position": [2.0, 1.0],
        "FastF1Generated": [False, False],
    })
    g = derive.gap_to_leader(laps).set_index("Driver")
    assert (g["LeaderDriver"] == "A").all()
    assert pd.isna(g.loc["A", "IntervalS"]) and g.loc["B", "IntervalS"] == 0
    assert (g["GapToLeaderS"] == 0).all()


@pytest.mark.parametrize("year, rnd, n_generated", [(2024, 24, 2), (2025, 1, 6)])
def test_gap_to_leader_lap_one_retirements_from_cache(year, rnd, n_generated):
    """The real cases behind the rule: 2024 Abu Dhabi (Perez's generated lap-1 row is listed before
    Norris's and shares his Time), 2025 Australia (DOO/HAD/SAI tied with NOR at gap 0)."""
    s = clean.load_race(year, rnd, "R", cache=CACHE)
    laps = s.laps
    g = derive.gap_to_leader(laps).assign(Position=laps["Position"].values,
                                          Generated=laps["FastF1Generated"].fillna(False).astype(bool).values,
                                          NoLapTime=laps["LapTime"].isna().values)
    synthetic = g[g["Generated"] & g["NoLapTime"]]
    assert len(synthetic) == n_generated
    assert synthetic[["GapToLeaderS", "IntervalS", "LeaderDriver"]].isna().all().all()
    assert synthetic["SessionTimeS"].notna().all()

    lead = g[g["Position"] == 1]
    assert (lead["LeaderDriver"] == lead["Driver"]).all()
    assert (lead["GapToLeaderS"] == 0).all() and lead["IntervalS"].isna().all()
    # Exactly one car at gap 0 per lap, never a fabricated row (a REAL leader lap may lack a LapTime:
    # NOR's safety-car laps 2-4 in 2025 R1), and never a car that completed zero laps.
    at_zero = g[g["GapToLeaderS"] == 0]
    assert (at_zero.groupby("LapNumber").size() == 1).all()
    assert not at_zero["Generated"].any()
    laps_done = s.results.set_index("Abbreviation")["Laps"]
    zero_lap_cars = [d for d in at_zero["Driver"].unique() if laps_done.get(d, 1) == 0]
    assert zero_lap_cars == []


def test_gap_to_leader_hungary_final_lap_matches_classification(hungary_2024):
    g = derive.gap_to_leader(hungary_2024.laps)
    final = g[g["LapNumber"] == hungary_2024.total_laps].set_index("Driver")
    assert abs(final.loc["NOR", "GapToLeaderS"] - 2.141) < 0.01
    assert abs(final.loc["HAM", "GapToLeaderS"] - 14.880) < 0.01
    assert abs(final.loc["LEC", "GapToLeaderS"] - 19.686) < 0.01
    assert final.loc["PIA", "LeaderDriver"] == "PIA"


def test_pit_stops_pair_in_lap_with_next_out_lap(any_session):
    laps = any_session.laps
    ps = derive.pit_stops(laps)
    assert list(ps.columns) == ["Driver", "StopNumber", "LapIn", "LapOut", "PitInTimeS", "PitOutTimeS",
                                "PitLaneS", "CompoundIn", "CompoundOut"]

    # One stop per in-lap.
    assert len(ps) == int(laps["PitInTime"].notna().sum())

    # Paired stops == in-laps whose next lap (same driver) has a PitOutTime.
    key = laps.set_index(["Driver", laps["LapNumber"].astype(int)])["PitOutTime"]
    expected_paired = 0
    for r in laps[laps["PitInTime"].notna()].itertuples(index=False):
        k = (r.Driver, int(r.LapNumber) + 1)
        if k in key.index and pd.notna(key.loc[k]):
            expected_paired += 1
    assert int(ps["LapOut"].notna().sum()) == expected_paired

    paired = ps[ps["LapOut"].notna()]
    assert (paired["LapOut"] == paired["LapIn"] + 1).all()
    assert (paired["PitLaneS"] > 0).all()
    assert np.allclose(paired["PitLaneS"], paired["PitOutTimeS"] - paired["PitInTimeS"])
    unpaired = ps[ps["LapOut"].isna()]
    assert unpaired["PitOutTimeS"].isna().all() and unpaired["PitLaneS"].isna().all()

    # StopNumber is 1..n per driver in lap order.
    for _, grp in ps.groupby("Driver"):
        assert grp["StopNumber"].tolist() == list(range(1, len(grp) + 1))
        assert grp["LapIn"].is_monotonic_increasing


def test_lap_status_against_annotated_laps(any_session):
    a = clean.annotate_laps(any_session)
    ls = derive.lap_status(a)
    assert list(ls.columns) == ["LapNumber", "IsGreen", "WorstStatus", "DriversAffected", "DriversOnLap"]
    assert ls["LapNumber"].tolist() == sorted(a["LapNumber"].dropna().astype(int).unique().tolist())

    per_lap = a.groupby(a["LapNumber"].astype(int))
    expected_green = ~per_lap["excl_not_green"].any()
    assert ls.set_index("LapNumber")["IsGreen"].equals(expected_green.rename("IsGreen"))
    assert (ls.set_index("LapNumber")["DriversAffected"] == per_lap["excl_not_green"].sum()).all()
    assert (ls.set_index("LapNumber")["DriversOnLap"] == per_lap.size()).all()

    # Green laps report '1'; non-green laps report the most severe code present.
    assert (ls.loc[ls["IsGreen"], "WorstStatus"] == "1").all()
    assert (ls.loc[~ls["IsGreen"], "WorstStatus"] != "1").all()
    assert (ls.loc[~ls["IsGreen"], "DriversAffected"] > 0).all()


def test_lap_status_severity_order():
    rows = [
        (1, "1"), (1, "1"),               # all green
        (2, "1"), (2, "12"),              # yellow somewhere
        (3, "4"), (3, "2"),               # SC beats yellow
        (4, "6"), (4, "4"),               # SC beats VSC
        (5, "7"), (5, "6"),               # VSC beats VSC-ending
        (6, "5"), (6, "4"), (6, "1"),     # red beats everything
        (7, None), (7, ""),               # no status at all
        (8, "67"), (8, "1"),              # VSC in a composite string
    ]
    laps = pd.DataFrame(rows, columns=["LapNumber", "TrackStatus"])
    laps["LapNumber"] = laps["LapNumber"].astype(float)
    ls = derive.lap_status(laps).set_index("LapNumber")
    assert ls.loc[1, "IsGreen"] and ls.loc[1, "WorstStatus"] == "1" and ls.loc[1, "DriversAffected"] == 0
    assert not ls.loc[2, "IsGreen"] and ls.loc[2, "WorstStatus"] == "2" and ls.loc[2, "DriversAffected"] == 1
    assert ls.loc[3, "WorstStatus"] == "4"
    assert ls.loc[4, "WorstStatus"] == "4"
    assert ls.loc[5, "WorstStatus"] == "6"
    assert ls.loc[6, "WorstStatus"] == "5" and ls.loc[6, "DriversAffected"] == 2
    assert ls.loc[7, "WorstStatus"] == "0" and not ls.loc[7, "IsGreen"] and ls.loc[7, "DriversAffected"] == 2
    assert ls.loc[8, "WorstStatus"] == "6"
    assert ls["DriversOnLap"].tolist() == [2, 2, 2, 2, 2, 3, 2, 2]
