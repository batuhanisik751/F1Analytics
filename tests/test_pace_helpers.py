"""``pace_distribution`` reproduces ``boxplot_stats``; ``compound_degradation`` reproduces
the inline ``np.polyfit`` in ``plots.plot_degradation``."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from matplotlib.cbook import boxplot_stats

from f1lab import clean, pace


@pytest.fixture(scope="module")
def pipeline(any_session):
    laps_fc = pace.fuel_correct(clean.clean_laps(any_session), any_session.total_laps, lap_km=None)
    ranking = pace.pace_ranking(laps_fc, min_laps=8)
    return any_session, laps_fc, ranking


def test_pace_distribution_matches_boxplot_stats(pipeline):
    _, laps_fc, ranking = pipeline
    dist = pace.pace_distribution(laps_fc, ranking, whis=1.5)

    assert list(dist.columns) == ["Driver", "N", "WhiskerLo", "Q1", "Median", "Q3", "WhiskerHi", "Mean"]
    assert dist["Driver"].tolist() == ranking["Driver"].tolist()
    assert len(dist) == len(ranking)

    for _, row in dist.iterrows():
        values = laps_fc.loc[laps_fc["Driver"] == row["Driver"], "LapTimeFuelCorrected"].dropna().values
        st = boxplot_stats(values, whis=1.5)[0]
        assert row["N"] == len(values)
        assert row["WhiskerLo"] == st["whislo"]
        assert row["Q1"] == st["q1"]
        assert row["Median"] == st["med"]
        assert row["Q3"] == st["q3"]
        assert row["WhiskerHi"] == st["whishi"]
        assert row["Mean"] == st["mean"]
        assert row["WhiskerLo"] <= row["Q1"] <= row["Median"] <= row["Q3"] <= row["WhiskerHi"]

    # The box median is the ranking's median, and N is the ranking's clean-lap count.
    merged = dist.merge(ranking, on="Driver")
    np.testing.assert_allclose(merged["Median"], merged["MedianPace"], rtol=0, atol=1e-9)
    assert (merged["N"] == merged["CleanLaps"]).all()


def test_compound_degradation_matches_inline_polyfit(pipeline):
    _, laps_fc, _ = pipeline
    deg = pace.degradation(laps_fc)
    cd = pace.compound_degradation(laps_fc, deg, min_laps=10, min_tyre_life=2)

    assert list(cd.columns) == ["Compound", "Laps", "SlopeSPerLap", "InterceptS", "XMin", "XMax"]

    # Exactly what plots.plot_degradation does, inline.
    expected = []
    for comp in deg["Compound"].value_counts().index.tolist():
        sub = laps_fc[(laps_fc["Compound"] == comp) & (laps_fc["TyreLife"] >= 2)]
        if len(sub) < 10:
            continue
        x = sub["TyreLife"].astype(float)
        y = sub["LapTimeFuelCorrected"].astype(float)
        b, a = np.polyfit(x, y, 1)
        expected.append((comp, len(sub), b, a, int(x.min()), int(x.max())))

    assert len(cd) == len(expected)
    for row, (comp, n, b, a, xmin, xmax) in zip(cd.itertuples(index=False), expected):
        assert row.Compound == comp
        assert row.Laps == n
        assert row.SlopeSPerLap == b
        assert row.InterceptS == a
        assert row.XMin == xmin and row.XMax == xmax
        assert xmin >= 2


def test_compound_degradation_empty_when_deg_empty():
    laps = pd.DataFrame({"Compound": ["SOFT"] * 3, "TyreLife": [2, 3, 4],
                         "LapTimeFuelCorrected": [80.0, 80.1, 80.2]})
    out = pace.compound_degradation(laps, pd.DataFrame())
    assert out.empty and list(out.columns) == []


def test_compound_degradation_skips_thin_compounds():
    laps = pd.DataFrame({
        "Compound": ["SOFT"] * 12 + ["HARD"] * 4,
        "TyreLife": list(range(1, 13)) + [2, 3, 4, 5],
        "LapTimeFuelCorrected": [80.0 + 0.1 * i for i in range(12)] + [81.0, 81.1, 81.2, 81.3],
    })
    deg = pd.DataFrame({"Compound": ["SOFT", "HARD"]})
    out = pace.compound_degradation(laps, deg, min_laps=10, min_tyre_life=2)
    assert out["Compound"].tolist() == ["SOFT"]   # HARD has 4 < 10 usable laps
    assert out["Laps"].iloc[0] == 11               # TyreLife 1 dropped
    assert abs(out["SlopeSPerLap"].iloc[0] - 0.1) < 1e-9
    assert out["XMin"].iloc[0] == 2 and out["XMax"].iloc[0] == 12
