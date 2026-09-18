"""Pace corrections: stripping fuel and tyre effects out of raw lap times.

A raw lap time answers "how fast was this lap?". That is almost never the
question. The question is "how fast was this car, and how fast was this driver?"
— and to get there you have to remove the two large, known, systematic effects
that have nothing to do with either: the fuel load burning off over the race, and
the tyres wearing out over a stint.

What is left after those corrections is the input to everything else: pace
ranking, teammate deltas, and ultimately the driver-vs-car decomposition.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import statsmodels.api as sm
from matplotlib.cbook import boxplot_stats

from .config import (
    FUEL_EFFECT_S_PER_KG,
    FUEL_START_KG,
    MIN_STINT_LAPS_FOR_DEG,
    REFERENCE_LAP_KM,
)


def fuel_correct(laps: pd.DataFrame, total_laps: int, lap_km: float | None = None) -> pd.DataFrame:
    """Normalise every lap to an empty fuel tank.

    A car starts the race carrying up to 100 kg of fuel and finishes carrying
    almost none, which is worth roughly three seconds of lap time. Without this
    correction, every race looks like the whole field got faster, and a driver
    who ran long before pitting looks slower than they were.

    Correcting *to empty* (rather than to full) means the corrected numbers are
    directly comparable to a qualifying lap, which is the intuition most people
    already have.

    ``lap_km`` scales the correction for circuit length, since fuel burn per lap
    is a function of distance. Leave it as None to apply the reference-circuit
    constant unscaled, and say so when you report the result.
    """
    out = laps.copy()

    scale = 1.0 if lap_km is None else lap_km / REFERENCE_LAP_KM

    # Fuel remaining at the midpoint of the lap, assuming a linear burn. Burn is
    # not perfectly linear — lift-and-coast and safety cars both distort it — but
    # the residual error is small next to the effect being removed.
    laps_elapsed = out["LapNumber"] - 0.5
    fuel_kg = FUEL_START_KG * (1.0 - laps_elapsed / total_laps)
    fuel_kg = fuel_kg.clip(lower=0.0)

    out["FuelKg"] = fuel_kg
    out["FuelPenaltyS"] = fuel_kg * FUEL_EFFECT_S_PER_KG * scale
    out["LapTimeFuelCorrected"] = out["LapTimeSeconds"] - out["FuelPenaltyS"]

    return out


def pace_ranking(laps: pd.DataFrame, min_laps: int = 8) -> pd.DataFrame:
    """Median fuel-corrected race pace per driver, fastest first.

    The median rather than the mean, because even after cleaning, the residual
    junk in lap times is one-sided — a lap can be ruined but it cannot be
    accidentally fast. The mean would drag every driver toward whoever had the
    worst luck in traffic.
    """
    g = laps.groupby("Driver", observed=True)

    out = pd.DataFrame({
        "Team": g["Team"].first(),
        "CleanLaps": g["LapTimeFuelCorrected"].count(),
        "MedianPace": g["LapTimeFuelCorrected"].median(),
        "BestPace": g["LapTimeFuelCorrected"].min(),
        # Spread is a genuine signal, not noise: a high IQR usually means the
        # driver spent the race in traffic or nursing a problem.
        "IQR": g["LapTimeFuelCorrected"].quantile(0.75) - g["LapTimeFuelCorrected"].quantile(0.25),
    }).reset_index()

    out = out[out["CleanLaps"] >= min_laps].sort_values("MedianPace").reset_index(drop=True)

    best = out["MedianPace"].iloc[0]
    out["GapS"] = out["MedianPace"] - best
    out["GapPct"] = 100.0 * out["GapS"] / best
    out.insert(0, "Rank", np.arange(1, len(out) + 1))

    return out


def pace_distribution(laps: pd.DataFrame, ranking: pd.DataFrame, whis: float = 1.5) -> pd.DataFrame:
    """The five numbers behind each box of :func:`plots.plot_pace_ranking`.

    One row per Driver in ``ranking['Driver']`` (same order). Columns: Driver, N,
    WhiskerLo, Q1, Median, Q3, WhiskerHi, Mean — from
    ``matplotlib.cbook.boxplot_stats(values, whis=whis)[0]`` over that driver's
    non-null ``LapTimeFuelCorrected``, i.e. exactly what ``ax.boxplot`` computes.
    ``Median`` equals ``ranking.MedianPace``; fliers are not returned because the
    chart does not draw them.
    """
    rows = []
    for drv in ranking["Driver"].tolist():
        values = laps.loc[laps["Driver"] == drv, "LapTimeFuelCorrected"].dropna().to_numpy(dtype=float)
        st = boxplot_stats(values, whis=whis)[0]
        rows.append({
            "Driver": drv,
            "N": int(len(values)),
            "WhiskerLo": float(st["whislo"]),
            "Q1": float(st["q1"]),
            "Median": float(st["med"]),
            "Q3": float(st["q3"]),
            "WhiskerHi": float(st["whishi"]),
            "Mean": float(st["mean"]),
        })
    columns = ["Driver", "N", "WhiskerLo", "Q1", "Median", "Q3", "WhiskerHi", "Mean"]
    return pd.DataFrame(rows, columns=columns)


def compound_degradation(laps: pd.DataFrame, deg: pd.DataFrame,
                         min_laps: int = 10, min_tyre_life: int = 2) -> pd.DataFrame:
    """The pooled per-compound line that :func:`plots.plot_degradation` draws.

    Columns: Compound, Laps, SlopeSPerLap, InterceptS, XMin, XMax. Iterates compounds
    in ``deg['Compound'].value_counts().index`` order (what the plot does); for each,
    ``sub = laps[(Compound == c) & (TyreLife >= min_tyre_life)]``, skipped when it has
    fewer than ``min_laps`` rows, otherwise a first-degree ``np.polyfit`` of
    fuel-corrected lap time on tyre age. Returns an empty DataFrame (no columns)
    when ``deg`` is empty.
    """
    if deg is None or deg.empty or "Compound" not in deg.columns:
        return pd.DataFrame()

    rows = []
    for comp in deg["Compound"].value_counts().index.tolist():
        sub = laps[(laps["Compound"] == comp) & (laps["TyreLife"] >= min_tyre_life)]
        if len(sub) < min_laps:
            continue
        x = sub["TyreLife"].astype(float)
        y = sub["LapTimeFuelCorrected"].astype(float)
        b, a = np.polyfit(x, y, 1)
        rows.append({
            "Compound": comp,
            "Laps": int(len(sub)),
            "SlopeSPerLap": float(b),
            "InterceptS": float(a),
            "XMin": int(x.min()),
            "XMax": int(x.max()),
        })
    columns = ["Compound", "Laps", "SlopeSPerLap", "InterceptS", "XMin", "XMax"]
    return pd.DataFrame(rows, columns=columns)


def degradation(laps: pd.DataFrame) -> pd.DataFrame:
    """Fit a degradation slope to each driver-stint.

    Regresses fuel-corrected lap time on tyre age within a stint, so the slope is
    seconds lost per lap of tyre life with the fuel effect already removed. Laps
    with TyreLife 1 are dropped: the first flying lap of a stint is a warm-up lap
    and consistently reads slow for reasons that are not degradation.

    The standard error matters here. A confident-looking 0.08 s/lap slope fitted
    to six noisy laps is not a finding.
    """
    rows = []

    for (drv, stint), grp in laps.groupby(["Driver", "Stint"], observed=True):
        grp = grp[grp["TyreLife"] >= 2].dropna(subset=["TyreLife", "LapTimeFuelCorrected"])
        if len(grp) < MIN_STINT_LAPS_FOR_DEG:
            continue

        X = sm.add_constant(grp["TyreLife"].astype(float).values)
        y = grp["LapTimeFuelCorrected"].astype(float).values
        fit = sm.OLS(y, X).fit()

        rows.append({
            "Driver": drv,
            "Team": grp["Team"].iloc[0],
            "Stint": int(stint),
            "Compound": grp["Compound"].iloc[0],
            "Laps": len(grp),
            "DegSPerLap": fit.params[1],
            "DegStdErr": fit.bse[1],
            "R2": fit.rsquared,
            # Pace the model implies on a brand new tyre, i.e. the stint's
            # baseline once degradation is projected back to zero.
            "FreshPaceS": fit.params[0] + fit.params[1],
        })

    if not rows:
        return pd.DataFrame()

    return pd.DataFrame(rows).sort_values(["Driver", "Stint"]).reset_index(drop=True)


def teammate_deltas(pace: pd.DataFrame) -> pd.DataFrame:
    """Intra-team pace gaps — the atom of any driver-vs-car model.

    Teammates share a car, so the gap between them is the cleanest single-race
    estimate of driver effect you can get without modelling anything. It is also
    noisy and confounded (different strategies, different traffic, one of them
    may have had damage), which is precisely why the real answer needs a
    hierarchical model pooling thousands of these across seasons rather than a
    single race read in isolation.

    Expressed as a percentage, because a tenth at Monaco and a tenth at Spa are
    not the same amount of driving.
    """
    rows = []

    for team, grp in pace.groupby("Team", observed=True):
        if len(grp) != 2:
            # A team with a DNF or a mid-season driver swap has no clean pair.
            continue
        grp = grp.sort_values("MedianPace")
        faster, slower = grp.iloc[0], grp.iloc[1]
        gap = slower["MedianPace"] - faster["MedianPace"]
        rows.append({
            "Team": team,
            "Faster": faster["Driver"],
            "Slower": slower["Driver"],
            "GapS": gap,
            "GapPct": 100.0 * gap / faster["MedianPace"],
            "LapsCompared": int(min(faster["CleanLaps"], slower["CleanLaps"])),
        })

    if not rows:
        return pd.DataFrame()

    return pd.DataFrame(rows).sort_values("GapPct", ascending=False).reset_index(drop=True)


def fuel_sensitivity(laps: pd.DataFrame, total_laps: int,
                     values: tuple[float, ...] = (0.025, 0.030, 0.035)) -> pd.DataFrame:
    """How much the pace ranking moves if the fuel constant is wrong.

    Run this before publishing any pace number. If the finishing order of the
    ranking is stable across the plausible range of the constant, the result is
    robust and you can say so. If it flips, the result was an artefact of an
    assumption rather than something that happened on track.
    """
    laps_elapsed = laps["LapNumber"] - 0.5
    fuel_kg = (FUEL_START_KG * (1.0 - laps_elapsed / total_laps)).clip(lower=0.0)

    frames = []
    for v in values:
        corrected = laps.copy()
        corrected["LapTimeFuelCorrected"] = corrected["LapTimeSeconds"] - fuel_kg * v
        r = pace_ranking(corrected)[["Driver", "Rank", "GapS"]]
        frames.append(r.rename(columns={"Rank": f"rank@{v}", "GapS": f"gap@{v}"}).set_index("Driver"))

    return pd.concat(frames, axis=1).reset_index()
