"""The four charts worth building first.

Each of these earns its place for a different reason: the stint chart is the most
shareable F1 graphic format there is, the pace ranking is the payoff from the
fuel correction, the degradation curves are what a strategy simulator consumes,
and the teammate chart is the first visible step toward driver-vs-car.
"""

from __future__ import annotations

import fastf1.plotting as f1plot
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import Patch

BG = "#12100E"
FG = "#EDE6DC"
GRID = "#3A342D"
ACCENT = "#E8A33D"

COMPOUND_FALLBACK = {
    "SOFT": "#E8474B", "MEDIUM": "#E8C547", "HARD": "#EDE6DC",
    "INTERMEDIATE": "#4BAA5E", "WET": "#3C7FD6", "UNKNOWN": "#7A736B",
}


def use_dark_theme() -> None:
    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG,
        "text.color": FG, "axes.labelcolor": FG, "axes.edgecolor": GRID,
        "xtick.color": FG, "ytick.color": FG, "grid.color": GRID,
        "axes.grid": True, "grid.alpha": 0.3, "axes.spines.top": False,
        "axes.spines.right": False, "font.size": 10, "figure.dpi": 130,
    })


def _compound_color(compound: str, session) -> str:
    try:
        return f1plot.get_compound_color(compound, session=session)
    except Exception:
        return COMPOUND_FALLBACK.get(str(compound).upper(), COMPOUND_FALLBACK["UNKNOWN"])


def _team_color(team: str, session) -> str:
    try:
        return f1plot.get_team_color(team, session=session)
    except Exception:
        return ACCENT


def plot_stint_gantt(stints: pd.DataFrame, order: list[str], session, ax=None):
    """Tyre strategy as a horizontal timeline, one row per driver.

    Ordered by finishing position, so strategy and result are readable together —
    the whole point is to spot the row that did something different from the cars
    around it.
    """
    if ax is None:
        _, ax = plt.subplots(figsize=(11, 7))

    drivers = [d for d in order if d in set(stints["Driver"])]
    compounds_seen: set[str] = set()

    for y, drv in enumerate(drivers):
        for _, s in stints[stints["Driver"] == drv].iterrows():
            comp = str(s["Compound"])
            compounds_seen.add(comp)
            ax.barh(y=y, width=s["laps"], left=s["start_lap"] - 1, height=0.62,
                    color=_compound_color(comp, session), edgecolor=BG, linewidth=1.2)
            if s["laps"] >= 6:
                ax.text(s["start_lap"] - 1 + s["laps"] / 2, y, str(int(s["laps"])),
                        ha="center", va="center", fontsize=7.5, color=BG, fontweight="bold")

    ax.set_yticks(range(len(drivers)))
    ax.set_yticklabels(drivers, fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel("Lap")
    ax.set_title("Tyre strategy — drivers ordered by finishing position",
                 fontsize=12, color=FG, pad=12)
    ax.grid(axis="y", visible=False)
    ax.legend(handles=[Patch(facecolor=_compound_color(c, session), label=c.title())
                       for c in sorted(compounds_seen)],
              loc="lower right", frameon=False, fontsize=8, ncol=len(compounds_seen))
    return ax


def plot_pace_ranking(laps: pd.DataFrame, pace: pd.DataFrame, session, ax=None):
    """Distribution of fuel-corrected lap times per driver, fastest median first.

    A box plot rather than a bar chart because the spread is half the story: two
    drivers with the same median but different spreads had very different races,
    and a bar chart would hide that completely.
    """
    if ax is None:
        _, ax = plt.subplots(figsize=(11, 6))

    order = pace["Driver"].tolist()
    data = [laps.loc[laps["Driver"] == d, "LapTimeFuelCorrected"].dropna().values for d in order]

    bp = ax.boxplot(data, positions=range(len(order)), widths=0.62, patch_artist=True,
                    showfliers=False,
                    medianprops=dict(color=BG, linewidth=1.6),
                    whiskerprops=dict(color=GRID), capprops=dict(color=GRID))

    for patch, drv in zip(bp["boxes"], order):
        team = pace.loc[pace["Driver"] == drv, "Team"].iloc[0]
        patch.set_facecolor(_team_color(team, session))
        patch.set_alpha(0.88)
        patch.set_edgecolor(GRID)

    # Gap printed under each driver code rather than floated inside the axes,
    # which keeps it readable regardless of how the y-axis happens to scale.
    labels = [f"{d}\n{'—' if i == 0 else f'+{pace.GapS.iloc[i]:.2f}'}"
              for i, d in enumerate(order)]

    ax.set_xticks(range(len(order)))
    ax.set_xticklabels(labels, fontsize=8.5)
    ax.set_ylabel("Fuel-corrected lap time (s)")
    ax.set_title("Race pace, fuel-corrected to an empty tank\n"
                 "Green-flag laps only; in/out laps and outliers removed",
                 fontsize=12, color=FG, pad=12)
    ax.grid(axis="x", visible=False)
    return ax


def plot_degradation(laps: pd.DataFrame, deg: pd.DataFrame, session,
                     compounds: list[str] | None = None, ax=None):
    """Fuel-corrected lap time against tyre age, with a fitted slope per compound.

    This is the chart a strategy simulator is built on: the slope of each line is
    the per-lap cost of staying out, and the gap between lines is what you gain
    by switching compound.
    """
    if ax is None:
        _, ax = plt.subplots(figsize=(10, 6))

    if compounds is None:
        compounds = [c for c in deg["Compound"].value_counts().index.tolist()]

    for comp in compounds:
        sub = laps[(laps["Compound"] == comp) & (laps["TyreLife"] >= 2)]
        if len(sub) < 10:
            continue
        colour = _compound_color(comp, session)
        ax.scatter(sub["TyreLife"], sub["LapTimeFuelCorrected"],
                   s=9, alpha=0.32, color=colour, edgecolors="none")

        # One pooled slope per compound across the whole field. Individual
        # per-stint fits live in the `deg` table; this line is the field-wide
        # picture of how the compound behaved at this circuit.
        x = sub["TyreLife"].astype(float)
        y = sub["LapTimeFuelCorrected"].astype(float)
        b, a = np.polyfit(x, y, 1)
        xs = np.linspace(x.min(), x.max(), 50)
        ax.plot(xs, a + b * xs, color=colour, linewidth=2.2,
                label=f"{comp.title()}  {b:+.3f} s/lap")

    ax.set_xlabel("Tyre age (laps)")
    ax.set_ylabel("Fuel-corrected lap time (s)")
    ax.set_title("Tyre degradation by compound", fontsize=12, color=FG, pad=12)
    ax.legend(frameon=False, fontsize=9)
    return ax


def plot_teammate_deltas(deltas: pd.DataFrame, session, ax=None):
    """Intra-team pace gap in percent — one bar per team.

    Percent rather than seconds so the number means the same thing at every
    circuit. Read these as noisy single-race observations, not verdicts: this
    chart is the raw material for the driver-vs-car model, not a substitute
    for it.
    """
    if ax is None:
        _, ax = plt.subplots(figsize=(9, 6))

    d = deltas.sort_values("GapPct")
    ypos = range(len(d))

    ax.barh(list(ypos), d["GapPct"], height=0.6,
            color=[_team_color(t, session) for t in d["Team"]], alpha=0.9)

    for y, (_, row) in zip(ypos, d.iterrows()):
        ax.text(row["GapPct"] + 0.015, y, f"{row['Faster']} by {row['GapS']:.2f}s",
                va="center", fontsize=8, color=FG)

    ax.set_yticks(list(ypos))
    ax.set_yticklabels(d["Team"], fontsize=9)
    ax.set_xlabel("Teammate pace gap (% of lap time)")
    ax.set_xlim(0, d["GapPct"].max() * 1.45)
    ax.set_title("Teammate head-to-head on race pace\n"
                 "Same car, so the gap is the cleanest available driver signal",
                 fontsize=12, color=FG, pad=12)
    ax.grid(axis="y", visible=False)
    return ax
