"""Mode 2 — the pace→points bridge, car-adjusted career, counterfactuals (§4).

Three quantities, three epistemic grades, and the module exists to keep them apart
(§4.2): ``actual_points`` is **a fact** read from ``driver_standings`` and never
recomputed; ``replay_points`` / ``avg_driver_points`` are **model output** from the same
calibrated simulator, so ``contribution`` differences like with like; a
``mode2_counterfactual`` row is an **extrapolation** and its DDL will not let it exist
without an interval.

``config.TITLE_PL_TEMPERATURE`` is **not** touched (§4.1): ``mode2_points_calib`` stores
a Mode-2-only fitted temperature per season so v1.2's constant never has to move.

FD4: a counterfactual combines two effects never observed together. Its interval is
widened by the measured interaction term of §1.7, the widening is disclosed on the page,
and for a pairing whose ``basis`` is ``by-analogy`` the point estimate is not rendered
at all — the DDL's ``mode2_counterfactual_interval_check`` makes a bandless row
physically unrepresentable.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import minimize, minimize_scalar

from . import config, db, frames, title
from .decomp import Mode2Fit, write_status

log = logging.getLogger(__name__)

STATUS_KEYS: tuple[str, ...] = ("mode2_counterfactual",)

POINTS_TABLES: tuple[str, ...] = (
    "mode2_points_calib", "mode2_career_season", "mode2_counterfactual",
)

#: ``replay`` takes no connection (§7.2), so the per-season simulator inputs that only a
#: database can supply — calendar, DNF rates, points schedule, entry list — are built
#: once by :func:`calibrate` and cached here, keyed by year. ``replay`` is pure given the
#: cache and its ``rng``; nothing random is read from it.
_SETUPS: dict[int, "_Season"] = {}


@dataclass(frozen=True)
class _Season:
    """Everything one season's replay needs, resolved once."""

    year: int
    drivers: list[str]              # entry list, sorted; the column order of every array
    team_ids: list[str]             # the entry's modal team that year
    teams: list[str]                # every team of the entry, most-driven first
    starts: np.ndarray              # race STARTS that year, from `results` -- a fact
    cell_ids: list[str]             # "team_id|year"
    delta: np.ndarray               # fitted driver effect, pp
    gamma: np.ndarray               # fitted car effect, pp, races-weighted over the year
    d_idx: np.ndarray               # index of each entry into fit.driver_ids
    c_idx: np.ndarray               # index of the entry's MODAL cell into fit.cell_ids
    cell_w: np.ndarray              # (n_entries x n_cells) race shares; gamma = cell_w @ g
    dnf: np.ndarray                 # v1.2's beta-binomial rate, per entry
    remaining: list[dict]           # title.simulate's round list
    schedule: title.PointsSchedule
    actual: np.ndarray              # driver_standings points at the final after_round
    theta_free: np.ndarray          # the per-season free PL fit, for the §4.1 bridge
    n_rounds: int


# ---------------------------------------------------------------------------
# §4.1 step 1 — the pace -> strength bridge
# ---------------------------------------------------------------------------

def season_orders(conn, year: int) -> tuple[list[list[str]], np.ndarray]:
    """One season's classified finishing orders, newest last, with v1.2's weights.

    Races and sprints both count (`MODE1_SPEC` §2.2) and the weight is v1.2's own
    exponential recency weight over the season's session sequence. Restricting
    ``title.finishing_orders`` to a single year is the whole difference: v1.2 fits one
    rolling PL, §4.1 wants one PL per season so the slope can be season-specific.
    """
    res = title._read(conn, """
        SELECT s.round, s.kind, r.driver_id, r.position, r.classified_position
        FROM results r JOIN sessions s ON s.session_id = r.session_id
        WHERE s.kind IN ('R', 'S') AND s.year = %s
        ORDER BY s.round, s.kind, r.position""", (int(year),))
    if res.empty:
        return [], np.zeros(0)
    ok = res["classified_position"].astype(str).str.fullmatch(r"\d+") & res["position"].notna()
    res = res[ok]
    orders = [[str(d) for d in grp.sort_values("position")["driver_id"]]
              for _, grp in res.groupby(["round", "kind"], sort=True)]
    orders = [o for o in orders if len(o) >= 2]
    n = len(orders)
    half = float(config.TITLE_PL_HALF_LIFE)
    return orders, np.array([0.5 ** ((n - 1 - i) / half) for i in range(n)])


def entry_pace(fit: Mode2Fit) -> pd.DataFrame:
    """One row per (year, driver) entry: the modal cell, the fitted `delta + gamma`.

    An entry is a driver-season seat. A mid-season switcher's car effect is the
    races-weighted mean of the cells he actually drove (``cell_w`` keeps those shares so
    a parameter draw recombines them the same way), because the PL strength being
    regressed on it is that driver's WHOLE season. ``team_id`` / ``cell_id`` are the
    modal car, which is what the season table and the counterfactual grid key on.
    """
    nd, nc = len(fit.driver_ids), len(fit.cell_ids)
    delta = fit.blup[:nd]
    gamma = fit.blup[nd:nd + nc]
    d_at = {d: i for i, d in enumerate(fit.driver_ids)}
    c_at = {c: i for i, c in enumerate(fit.cell_ids)}
    out = []
    for (year, driver), grp in fit.rows.groupby(["year", "driver_id"], sort=True):
        share = grp["cell_id"].value_counts(normalize=True)
        # Count desc, then cell name asc: `idxmax` breaks a tie on row order, which a
        # --force re-ingest can change (§6.6 bit-identity).
        order = sorted(share.items(), key=lambda kv: (-float(kv[1]), str(kv[0])))
        cell = str(order[0][0])
        di, ci = d_at[str(driver)], c_at[cell]
        w = np.zeros(nc)
        for c, frac in share.items():
            w[c_at[str(c)]] = float(frac)
        g = float(w @ gamma)
        # Every car of the entry, most-driven first (ties by name, so the string is
        # deterministic). `team_id` is the MODAL car and `gamma` is the races-weighted
        # blend of ALL of them: for a two-race stand-in split 1/1 those are different
        # cars, so a surface that prints the modal name alone prints a label its own
        # number does not match. §4.3 -- the entry is the seat, not the team.
        teams = ", ".join(str(c).split("|")[0] for c, _ in order)
        out.append({"year": int(year), "driver_id": str(driver),
                    "team_id": cell.split("|")[0], "cell_id": cell, "teams": teams,
                    "d_idx": di, "c_idx": ci, "cell_w": w,
                    "delta": float(delta[di]), "gamma": g,
                    "pace": float(delta[di] + g), "n_rows": int(len(grp))})
    return pd.DataFrame(out)


def _actual_points(conn, year: int) -> tuple[dict[str, float], int]:
    """``driver_standings.points`` at the season's final ``after_round`` — A FACT (§4.2)."""
    df = title._read(conn, """
        SELECT driver_id, points FROM driver_standings
        WHERE year = %s AND after_round = (SELECT max(after_round) FROM driver_standings
                                           WHERE year = %s)""", (int(year), int(year)))
    rnd = title._read(conn, "SELECT max(after_round) AS r FROM driver_standings WHERE year = %s",
                      (int(year),))
    last = int(rnd["r"].iloc[0]) if not rnd.empty and pd.notna(rnd["r"].iloc[0]) else 0
    return {str(r.driver_id): float(r.points) for r in df.itertuples()}, last


def _starts(conn, year: int, upto: int) -> dict[str, int]:
    """Race starts per driver in one season — A FACT, like ``actual_points`` (§4.2).

    From ``results``, not from the fit: how much of a calendar a seat covered is a fact
    about the season, and the model's own row count is a different and much smaller
    number (2024 Norris drove 24 races; 19 of them survive the §1.3 filter). Printing the
    modelled count against a 24-round calendar would read as five races missed.
    """
    df = title._read(conn, """
        SELECT r.driver_id, count(*) AS n FROM results r JOIN sessions s USING (session_id)
        WHERE s.year = %s AND s.kind = 'R' AND s.round <= %s
        GROUP BY r.driver_id ORDER BY r.driver_id""", (int(year), int(upto)))
    return {str(r.driver_id): int(r.n) for r in df.itertuples()}


def _remaining(conn, year: int, upto: int) -> list[dict]:
    """The rounds actually held, as ``title.simulate``'s round list.

    Built from ``sessions``, not ``events``: 2026 is complete only through R14 and a
    replay must not invent the rounds that have not happened (§0.3).
    """
    cal = title._read(conn, """
        SELECT s.round,
               count(*) FILTER (WHERE s.kind = 'R') AS races,
               count(*) FILTER (WHERE s.kind = 'S') AS sprints
        FROM sessions s WHERE s.year = %s AND s.kind IN ('R', 'S') AND s.round <= %s
        GROUP BY s.round ORDER BY s.round""", (int(year), int(upto)))
    return [{"round": int(r.round), "has_race": int(r.races or 0) > 0,
             "has_sprint": int(r.sprints or 0) > 0} for r in cal.itertuples()
            if int(r.races or 0) > 0]


def _season_setup(conn, year: int, fit: Mode2Fit, ent: pd.DataFrame) -> _Season:
    """Resolve one season's replay inputs and cache them for :func:`replay`."""
    e = ent[ent["year"] == int(year)].sort_values("driver_id").reset_index(drop=True)
    actual, last_round = _actual_points(conn, year)
    rem = _remaining(conn, year, last_round)
    starts = _starts(conn, year, last_round)
    rates = title.dnf_rates(conn, int(year), last_round)
    season_rate = title.season_dnf_rate(conn, int(year), last_round)
    orders, weights = season_orders(conn, year)
    theta = title.fit_plackett_luce(orders, list(weights), config.TITLE_PL_RIDGE)
    setup = _Season(
        year=int(year),
        drivers=[str(d) for d in e["driver_id"]],
        team_ids=[str(t) for t in e["team_id"]],
        teams=[str(t) for t in e["teams"]],
        # A driver in the fit has raced, so `results` always has him; the modelled row
        # count is the floor if it ever does not, never a fabricated 1.
        starts=np.array([int(starts.get(str(d), n)) for d, n in
                         zip(e["driver_id"], e["n_rows"])]),
        cell_ids=[str(c) for c in e["cell_id"]],
        delta=e["delta"].to_numpy(float), gamma=e["gamma"].to_numpy(float),
        d_idx=e["d_idx"].to_numpy(int), c_idx=e["c_idx"].to_numpy(int),
        cell_w=np.vstack(list(e["cell_w"])) if len(e) else np.zeros((0, 0)),
        dnf=np.array([float(rates.get(str(d), season_rate)) for d in e["driver_id"]]),
        remaining=rem, schedule=title.points_schedule(conn, int(year)),
        actual=np.array([float(actual.get(str(d), 0.0)) for d in e["driver_id"]]),
        theta_free=np.array([float(theta.get(str(d), np.nan)) for d in e["driver_id"]]),
        n_rounds=len(rem))
    _SETUPS[int(year)] = setup
    return setup


def bridge(pace: np.ndarray, theta: np.ndarray) -> dict[str, float]:
    """OLS of the free PL strengths on predicted entry pace (§4.1 step 1)."""
    ok = np.isfinite(pace) & np.isfinite(theta)
    p, t = np.asarray(pace, float)[ok], np.asarray(theta, float)[ok]
    n = len(p)
    if n < 3:
        return {"slope": 0.0, "intercept": 0.0, "r2": 0.0, "resid_sd": 0.0,
                "slope_se": 0.0, "n": n}
    x = np.c_[np.ones(n), p]
    beta, *_ = np.linalg.lstsq(x, t, rcond=None)
    resid = t - x @ beta
    sse, sst = float(resid @ resid), float(((t - t.mean()) ** 2).sum())
    resid_sd = float(np.sqrt(sse / (n - 2)))
    xtx_inv = np.linalg.inv(x.T @ x)
    return {"slope": float(beta[1]), "intercept": float(beta[0]),
            "r2": float(1.0 - sse / sst) if sst > 0 else 0.0, "resid_sd": resid_sd,
            "slope_se": float(resid_sd * np.sqrt(xtx_inv[1, 1])), "n": n}


def _run(setup: _Season, th: np.ndarray, temperature: float, rng) -> np.ndarray:
    """``title._run_rounds`` over one season, points only (``counts=None``).

    ``th`` is ``(draws, n)`` or ``(n,)``; v1.2's ``_pl_scores`` broadcasts the first form
    for free, which is what makes a 200-parameter-draw sweep cost one fixed-theta run
    (§4.3).
    """
    n = len(setup.drivers)
    d_n = th.shape[0] if th.ndim == 2 else 1
    total = np.zeros((d_n, n))
    title._run_rounds(th, setup.dnf, setup.remaining, setup.schedule, rng, total, None,
                      race_ladder=title._ladder(setup.schedule.race_points, n),
                      sprint_ladder=title._ladder(setup.schedule.sprint_points, n),
                      temperature=float(temperature))
    return total


def _theta_of(setup: _Season, pace: np.ndarray, slope: float, intercept: float) -> np.ndarray:
    return intercept + slope * pace


def replay(fit: Mode2Fit, calib: pd.DataFrame, year: int, *,
           theta_override: dict[str, float] | None = None,
           draws: int = config.MODE2_POINTS_DRAWS,
           rng: np.random.Generator) -> np.ndarray:
    """(draws × n_entries) season points at the season's fitted slope and temperature.

    ``theta_override`` maps a *seat's* current occupant to the driver effect (pp) to put
    in that seat — ``{driver: 0.0}`` is §4.2's field-average driver, ``{incumbent:
    delta_X}`` is §4.4's counterfactual. Every other seat, every car and the calendar are
    left exactly as observed.

    The season must have been prepared by :func:`calibrate` in this process; ``replay``
    takes no connection by contract (§7.2) and will not silently invent a calendar.
    """
    setup = _SETUPS.get(int(year))
    if setup is None:
        raise KeyError(f"season {year} not prepared: call decomp_points.calibrate first")
    row = calib[calib["year"] == int(year)]
    if row.empty:
        raise KeyError(f"no mode2_points_calib row for {year}")
    slope = float(row["slope_theta_per_pp"].iloc[0])
    intercept = float(row["intercept"].iloc[0])
    temp = float(row["temperature"].iloc[0])
    pace = setup.delta + setup.gamma
    for seat, value in (theta_override or {}).items():
        for i, d in enumerate(setup.drivers):
            if d == seat:
                pace[i] = float(value) + setup.gamma[i]
    th = np.tile(_theta_of(setup, pace, slope, intercept), (max(int(draws), 1), 1))
    return _run(setup, th, temp, rng)


def _replay_stats(sim: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    """sd ratio, MAE and correlation of a replay's mean points against the fact."""
    mean = sim.mean(axis=0)
    sd_a = float(actual.std(ddof=1)) if len(actual) > 1 else 0.0
    sd_s = float(mean.std(ddof=1)) if len(mean) > 1 else 0.0
    corr = float(np.corrcoef(mean, actual)[0, 1]) if len(mean) > 1 and sd_a > 0 else 0.0
    return {"sd_ratio": (sd_s / sd_a) if sd_a > 0 else 0.0,
            "mae": float(np.abs(mean - actual).mean()), "corr": corr}


def calibrate(conn, assumption_set_id: int, fit: Mode2Fit) -> pd.DataFrame:
    """Per season: PL slope/intercept/r2/resid_sd, then the temperature that matches
    sd(simulated season points) to sd(actual), plus the replay MAE (§4.1).

    Step 2 is the bug you only find by running it: v1.2's ``TITLE_PL_TEMPERATURE = 1.0``
    is right for "who wins the title" and returns barely half the real points spread when
    asked for a points TOTAL. The temperature is refitted here, per season, and v1.2's
    own constant is left alone.
    """
    ent = entry_pace(fit)
    out = []
    for year in sorted(int(y) for y in ent["year"].unique()):
        setup = _season_setup(conn, year, fit, ent)
        if not setup.remaining or len(setup.drivers) < 3:
            continue
        b = bridge(setup.delta + setup.gamma, setup.theta_free)
        th = _theta_of(setup, setup.delta + setup.gamma, b["slope"], b["intercept"])
        best = None
        for temp in config.MODE2_TEMPERATURE_GRID:
            rng = np.random.default_rng(config.MODE2_SEED + year)
            st = _replay_stats(_run(setup, np.tile(th, (config.MODE2_POINTS_DRAWS, 1)),
                                    temp, rng), setup.actual)
            key = abs(st["sd_ratio"] - 1.0)
            if best is None or key < best[0]:
                best = (key, float(temp), st)
        _, temperature, st = best
        out.append({"assumption_set_id": int(assumption_set_id), "year": year,
                    "slope_theta_per_pp": b["slope"], "intercept": b["intercept"],
                    "r2": b["r2"], "resid_sd": b["resid_sd"], "temperature": temperature,
                    "sd_ratio_sim_actual": st["sd_ratio"], "replay_mae_points": st["mae"],
                    "replay_corr": st["corr"], "n_entries": int(b["n"])})
        log.info("mode2 calibrate %d: slope=%.3f r2=%.3f T=%.2f sd_ratio=%.3f mae=%.1f",
                 year, b["slope"], b["r2"], temperature, st["sd_ratio"], st["mae"])
    df = pd.DataFrame(out)
    if df.empty:
        return frames.empty_frame("mode2_points_calib")
    df["fit_id"] = 0
    return df[[c for c in frames.EXPECTED_COLUMNS["mode2_points_calib"]]]


def _pl_ll(theta: np.ndarray, idx: np.ndarray, mask: np.ndarray, w: np.ndarray) -> float:
    """Weighted Plackett-Luce log-likelihood — v1.2's own objective, sign flipped."""
    t = np.where(mask, theta[idx], -np.inf)
    s = np.logaddexp.accumulate(t[:, ::-1], axis=1)[:, ::-1]
    return float((w * (np.where(mask, t, 0.0).sum(1) - np.where(mask, s, 0.0).sum(1))).sum())


def _pl_packs(conn, fit: Mode2Fit, ent: pd.DataFrame) -> list[tuple]:
    """Per season: padded order matrix, weights, and each entry's (driver, cell) index."""
    packs = []
    for year in sorted(int(y) for y in ent["year"].unique()):
        e = ent[ent["year"] == year]
        keep = {str(r.driver_id): r for r in e.itertuples()}
        orders, w = season_orders(conn, year)
        orders = [[d for d in o if d in keep] for o in orders]
        sel = [i for i, o in enumerate(orders) if len(o) >= 2]
        orders, w = [orders[i] for i in sel], np.asarray(w)[sel]
        drv = sorted({d for o in orders for d in o})
        idx, mask = title._pad_orders(orders, {d: i for i, d in enumerate(drv)})
        packs.append((idx, mask, w,
                      np.array([keep[d].d_idx for d in drv]),
                      np.vstack([keep[d].cell_w for d in drv]) if drv else np.zeros((0, 1)),
                      np.array([keep[d].pace for d in drv]), len(drv)))
    return packs


def pl_bridge_report(conn, fit: Mode2Fit, ent: pd.DataFrame | None = None) -> dict:
    """§4.1's headline: how much of a FREE Plackett-Luce fit one slope reproduces.

    The free comparator is the additive PL — one strength per driver plus one per
    team-season, ``n_drivers + n_cells`` free parameters, fitted straight on the orders
    with no pace input at all. The one-parameter model constrains every entry to
    ``lambda * (-pace)`` at this model's fitted pace. ``share`` is the fraction of the
    free fit's log-likelihood gain over a no-skill field that the single lambda captures.
    """
    ent = entry_pace(fit) if ent is None else ent
    packs = _pl_packs(conn, fit, ent)
    nd, nc = len(fit.driver_ids), len(fit.cell_ids)
    ll0 = sum(_pl_ll(np.zeros(k), i, m, w) for i, m, w, _, _, _, k in packs)
    one = minimize_scalar(
        lambda lam: -sum(_pl_ll(lam * -p, i, m, w) for i, m, w, _, _, p, _ in packs),
        bounds=(0.05, 8.0), method="bounded")

    def neg_free(theta: np.ndarray) -> float:
        a, b = theta[:nd], theta[nd:]
        return -sum(_pl_ll(a[di] + cw @ b, i, m, w) for i, m, w, di, cw, _, _ in packs) \
            + 1e-6 * float(theta @ theta)

    free = minimize(neg_free, np.zeros(nd + nc), method="L-BFGS-B",
                    options={"maxiter": 4000, "maxfun": 40000})
    gain = -free.fun - ll0
    return {"lambda": float(one.x), "n_free_params": nd + nc, "n_drivers": nd,
            "n_cells": nc, "ll_null": ll0, "ll_one_param": float(-one.fun),
            "ll_free": float(-free.fun),
            "share": float((-one.fun - ll0) / gain) if gain > 0 else 0.0,
            "n_entries": int(sum(k for *_, k in packs))}


# ---------------------------------------------------------------------------
# §1.7 — the additivity test, which is what licenses §4.4 at all
# ---------------------------------------------------------------------------

def additivity_report(rows: pd.DataFrame, fit: Mode2Fit) -> dict:
    """Reproduce §1.7: the driver × car-season interaction SD, and how many cell BLUPs
    clear 2 posterior SE.

    Reported as a **scale**, never as confirmation. The BLUPs are shrunk toward zero by
    construction and the test is low-powered, so "0 of 72 above 2 SE" is close to
    tautological — what survives is that whatever interaction exists is of order 0.1 pp,
    about 40 % of the driver spread, and that 0.1 is the widening §4.4 applies.
    """
    from .decomp import fit_interaction

    tau_i = float(fit_interaction(rows, fit))
    m = fit.rows
    nd, nc = len(fit.driver_ids), len(fit.cell_ids)
    d_at = {d: i for i, d in enumerate(fit.driver_ids)}
    c_at = {c: i for i, c in enumerate(fit.cell_ids)}
    di = np.array([d_at[str(d)] for d in m["driver_id"]])
    ci = np.array([c_at[str(c)] for c in m["cell_id"]])
    pred = fit.blup[:nd][di] + fit.blup[nd:nd + nc][ci]
    if len(fit.blup) >= nd + 2 * nc:
        pred = pred + fit.blup[nd + nc:nd + 2 * nc][ci] * m["u"].to_numpy(float)
    resid = m["y"].to_numpy(float) - pred
    sigma2 = float(fit.tau["sigma_resid"]) ** 2
    t2 = tau_i ** 2
    key = pd.DataFrame({"cell": [f"{d}@{c}" for d, c in zip(m["driver_id"], m["cell_id"])],
                        "r": resid})
    grp = key.groupby("cell")["r"].agg(["mean", "size"])
    n = grp["size"].to_numpy(float)
    blup = (t2 * n / (t2 * n + sigma2)) * grp["mean"].to_numpy(float)
    se = np.sqrt(t2 * sigma2 / (t2 * n + sigma2))
    z = np.abs(blup) / np.where(se > 0, se, np.inf)
    return {"tau_interaction": tau_i, "n_cells": int(len(grp)),
            "n_cells_multi_race": int((n >= 2).sum()),
            "n_beyond_2se": int((z > 2.0).sum()), "max_abs_z": float(z.max() if len(z) else 0.0),
            "tau_driver": float(fit.tau["tau_driver"]),
            "sigma_resid": float(fit.tau["sigma_resid"]),
            "widening_pp": float(config.MODE2_CF_INTERACTION_PCT)}


# ---------------------------------------------------------------------------
# §4.3 — one scenario, its Monte Carlo, and where its uncertainty comes from
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Params:
    """``MODE2_UNCERTAINTY_DRAWS`` joint draws of (delta, gamma, slope) for one season."""

    pace: np.ndarray                # (outer, n_entries) delta + gamma per draw
    delta: np.ndarray               # (outer, n_drivers) the whole grid's delta per draw
    slope: np.ndarray               # (outer,)
    intercept: float
    temperature: float
    mae: float
    outer: int


def _params(setup: _Season, fit: Mode2Fit, boot: np.ndarray, calib_row, *,
            outer: int, rng: np.random.Generator) -> _Params:
    """Joint (delta, gamma) from §2.3's retained posterior, plus the bridge slope.

    The pair is taken **jointly** (§4.4): A^-1 already carries the strong negative
    within-team correlation and the component-offset variance, so nothing further is
    added for an island driver — adding a second `prior_share * tau^2` term would
    double-count exactly the variance the bootstrap already widened.
    """
    nd, nc = len(fit.driver_ids), len(fit.cell_ids)
    b = bridge(setup.delta + setup.gamma, setup.theta_free)
    if boot is None or boot.size == 0:
        log.warning("mode2 points: no bootstrap draws supplied — every band collapses to "
                    "the replay-MAE floor and param_stderr is 0; pass decomp.bootstrap's "
                    "output through recompute_all")
        err = np.zeros((outer, nd + nc))
    else:
        take = np.arange(outer) % boot.shape[0]
        err = np.asarray(boot, float)[take][:, :nd + nc]
    delta = fit.blup[:nd][None, :] - err[:, :nd]
    gamma = fit.blup[nd:nd + nc][None, :] - err[:, nd:nd + nc]
    pace = delta[:, setup.d_idx] + gamma @ setup.cell_w.T
    slope = float(calib_row["slope_theta_per_pp"]) + \
        rng.normal(0.0, b["slope_se"], size=outer)
    return _Params(pace=pace, delta=delta, slope=slope,
                   intercept=float(calib_row["intercept"]),
                   temperature=float(calib_row["temperature"]),
                   mae=float(calib_row["replay_mae_points"]), outer=outer)


def _scenario(setup: _Season, p: _Params, override: dict[int, np.ndarray] | None,
              *, draws: int, seed: int) -> np.ndarray:
    """(draws × n_entries) season points for one seat configuration.

    ``override`` maps a seat index to that seat's per-outer-draw driver effect (pp). The
    inner Monte Carlo is seeded identically for every scenario of a season, so two
    scenarios differ only where their theta differs — the common random numbers are what
    make ``replay - avg_driver`` a paired difference rather than two noisy totals.
    """
    pace = p.pace.copy()
    for seat, value in (override or {}).items():
        pace[:, seat] = np.asarray(value, float) + _gamma_of(p, setup, seat)
    th_outer = p.intercept + p.slope[:, None] * pace
    rep = max(1, int(draws) // p.outer)
    th = np.repeat(th_outer, rep, axis=0)
    return _run(setup, th, p.temperature, np.random.default_rng(int(seed)))


def _gamma_of(p: _Params, setup: _Season, seat: int) -> np.ndarray:
    """The seat's car effect per outer draw: pace minus the incumbent's own delta."""
    return p.pace[:, seat] - p.delta[:, setup.d_idx[seat]]


def _bands(total: np.ndarray, outer: int, mae: float) -> dict[str, np.ndarray]:
    """Split a scenario's spread into parameter and Monte-Carlo parts, then band it.

    The reported interval is **not** the Monte-Carlo standard error (§4.3) — that is the
    small part, and quoting it alone is the classic lie. It is the 5th-95th percentile
    across the ``MODE2_UNCERTAINTY_DRAWS`` parameter draws, with the inner-MC noise that
    contaminates a group mean removed by the usual one-way variance identity, then
    widened by §4.1's replay-MAE floor. ``mc_stderr`` and ``param_stderr`` are stored
    separately so ``C-CAREER-2`` can say which dominates.
    """
    d, n = total.shape
    rep = max(1, d // max(outer, 1))
    g = total[: outer * rep].reshape(outer, rep, n)
    gm = g.mean(axis=1)
    mean = total.mean(axis=0)
    within = g.var(axis=1, ddof=1).mean(axis=0) if rep > 1 else np.zeros(n)
    var_gm = gm.var(axis=0, ddof=1) if outer > 1 else np.zeros(n)
    var_p = np.maximum(var_gm - within / rep, 0.0)
    scale = np.where(var_gm > 0, np.sqrt(var_p / np.where(var_gm > 0, var_gm, 1.0)), 0.0)
    adj = mean + (gm - mean) * scale
    lo, mid, hi = np.percentile(adj, [5, 50, 95], axis=0)
    return {"mean": mean, "p50": mid,
            "lo": mid - np.hypot(mid - lo, mae), "hi": mid + np.hypot(hi - mid, mae),
            "mc_stderr": np.sqrt(np.maximum(within, 0.0) / max(d, 1)),
            "param_stderr": np.sqrt(var_p), "adj": adj}



def _career_season(setup: _Season, p: _Params, base: np.ndarray, meta: dict) -> list[dict]:
    """§4.2's three quantities for every seat of one season.

    A points band is clipped at zero on the low side — a season cannot score fewer than
    no points — while a contribution band is not, because a driver genuinely can be worth
    less than the field average. ``contribution = replay_points - avg_driver_points`` and
    **both sides come from the same simulator**: differencing the fact from a model
    output would fold the simulator's own replay error (50+ points a season at v1.2's
    temperature) into the driver's credit.
    """
    draws = base.shape[0]
    b = _bands(base, p.outer, p.mae)
    out = []
    for i, driver in enumerate(setup.drivers):
        avg = _scenario(setup, p, {i: np.zeros(p.outer)}, draws=draws,
                        seed=config.MODE2_SEED + setup.year)
        a = _bands(avg, p.outer, p.mae)
        c = _bands(base - avg, p.outer, p.mae)
        m = meta.get(driver, {})
        out.append({
            "year": setup.year, "driver_id": driver, "team_id": setup.team_ids[i],
            "actual_points": float(setup.actual[i]),
            "replay_points": float(b["mean"][i]),
            "replay_lo": max(0.0, float(b["lo"][i])), "replay_hi": float(b["hi"][i]),
            "avg_driver_points": float(a["mean"][i]),
            "avg_driver_p10": max(0.0, float(a["lo"][i])),
            "avg_driver_p90": float(a["hi"][i]),
            "contribution": float(b["mean"][i] - a["mean"][i]),
            "contribution_lo": float(c["lo"][i]), "contribution_hi": float(c["hi"][i]),
            "mc_stderr": float(c["mc_stderr"][i]), "param_stderr": float(c["param_stderr"][i]),
            "calibration_mae": float(p.mae),
            "basis": str(m.get("basis", "measured")),
            "anchor_class": str(m.get("anchor_class", "anchored")),
            "rounds_in_season": int(setup.n_rounds),
            # The two facts a full-season replay cannot carry on its own (§4.3): how
            # much of the calendar this seat actually covers, and which cars it covers
            # it in. A two-race stand-in and a 24-race number-one are the same row
            # without them, and the card then reads as a championship the driver never
            # contested, in a car he may never have had a seat in.
            "starts": int(setup.starts[i]),
            "teams": str(setup.teams[i])})
    return out


def _cf_scenarios(setup: _Season, fit: Mode2Fit) -> list[dict]:
    """The deterministic (year, team_id, driver_id) grid, before the §7.7 cap.

    One seat per car: the slower of the two incumbents, by fitted delta — replacing the
    quicker one is the less interesting question and the PK has no room for a seat. A
    driver who actually drove that car is his own ``replaced_driver_id`` and the row is
    the observed season, so the grid always contains the honest anchor next to the
    extrapolations.
    """
    seats: dict[str, list[int]] = {}
    for i, cell in enumerate(setup.cell_ids):
        seats.setdefault(cell, []).append(i)
    out = []
    for cell in sorted(seats):
        members = seats[cell]
        target = max(members, key=lambda i: (setup.delta[i], setup.drivers[i]))
        team = cell.split("|")[0]
        for d_i, driver in enumerate(fit.driver_ids):
            here = [i for i in members if setup.drivers[i] == driver]
            seat = here[0] if here else target
            out.append({"year": setup.year, "team_id": team, "cell_id": cell,
                        "driver_id": driver, "d_i": d_i, "seat": seat,
                        "replaced_driver_id": setup.drivers[seat],
                        "observed": bool(here)})
    out.sort(key=lambda r: (r["year"], r["team_id"], r["driver_id"]))
    return out


def _cf_rows(setup: _Season, p: _Params, base: np.ndarray, scen: list[dict],
             comp_of_driver: dict[str, str], comp_of_cell: dict[str, str],
             floating: set[str], rng: np.random.Generator) -> list[dict]:
    """Run each scenario and band it. Observed pairings reuse the season replay."""
    draws = base.shape[0]
    out = []
    for s in scen:
        seat, d_i = int(s["seat"]), int(s["d_i"])
        if s["observed"]:
            total, inter = base, 0.0
        else:
            inter = float(config.MODE2_CF_INTERACTION_PCT)
            shift = p.delta[:, d_i] + rng.normal(0.0, inter, size=p.outer)
            total = _scenario(setup, p, {seat: shift}, draws=draws,
                              seed=config.MODE2_SEED + setup.year)
        band = _bands(total, p.outer, p.mae)
        dlt = _bands(total - base, p.outer, p.mae)
        cd, cc = comp_of_driver.get(s["driver_id"], ""), comp_of_cell.get(s["cell_id"], "")
        out.append({
            "year": setup.year, "driver_id": s["driver_id"], "team_id": s["team_id"],
            "replaced_driver_id": s["replaced_driver_id"], "observed": bool(s["observed"]),
            "points_p10": max(0.0, float(band["lo"][seat])),
            "points_p50": float(band["p50"][seat]),
            "points_p90": float(band["hi"][seat]),
            "incumbent_actual": float(setup.actual[seat]),
            "delta_p10": float(dlt["lo"][seat]), "delta_p50": float(dlt["p50"][seat]),
            "delta_p90": float(dlt["hi"][seat]),
            "basis": "by-analogy" if (cd in floating or cc in floating) else "measured",
            "cross_component": bool(cd and cc and cd != cc),
            "interaction_pp": inter, "calibration_mae": float(p.mae)})
    return out


# ---------------------------------------------------------------------------
# §7.2 entry point
# ---------------------------------------------------------------------------

def _rating_meta(conn, fit_id: int) -> dict[str, dict]:
    df = title._read(conn, "SELECT driver_id, basis, anchor_class, component_id "
                           "FROM mode2_driver_rating WHERE fit_id = %s", (int(fit_id),))
    return {str(r.driver_id): {"basis": str(r.basis), "anchor_class": str(r.anchor_class),
                               "component_id": str(r.component_id)}
            for r in df.itertuples()}


def _current_fit_id(conn, asid: int) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT fit_id FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND is_current", (int(asid),))
        row = cur.fetchone()
    return int(row[0]) if row else None


def recompute_points(conn, assumption_set_id: int, fit: Mode2Fit,
                     draws: np.ndarray) -> dict:
    """Populate ``mode2_points_calib`` / ``mode2_career_season`` / ``mode2_counterfactual``.

    ``draws`` is §2.3's parametric bootstrap — estimation ERRORS ``u_hat* - u*``, so a
    parameter draw is ``blup - draws[r]``. It already carries the island offset variance
    for a floating driver, which is why nothing further is added for one here (§4.4).
    """
    asid = int(assumption_set_id)
    started = time.time()
    fit_id = _current_fit_id(conn, asid)
    if fit_id is None or fit.rows is None or len(fit.rows) == 0:
        n = write_status(conn, "mode2_counterfactual", "empty")
        return {t: 0 for t in POINTS_TABLES} | {"sessions_marked": n, "skipped": True}

    calib = calibrate(conn, asid, fit)
    meta = _rating_meta(conn, fit_id)
    comp_of_driver = {d: cid for cid, c in fit.components.items() for d in c["drivers"]}
    comp_of_cell = {x: cid for cid, c in fit.components.items() for x in c["cells"]}
    floating = {cid for cid, c in fit.components.items() if c.get("is_floating")}

    years = [int(y) for y in calib["year"]]
    grid = []
    for year in years:
        grid.extend(_cf_scenarios(_SETUPS[year], fit))
    grid.sort(key=lambda r: (r["year"], r["team_id"], r["driver_id"]))
    cap = int(config.MODE2_CF_MAX_SCENARIOS)
    skipped = max(0, len(grid) - cap)
    grid = grid[:cap]

    career, cfs = [], []
    for year in years:
        setup = _SETUPS[year]
        row = calib[calib["year"] == year].iloc[0]
        rng = np.random.default_rng(config.MODE2_SEED + 7919 * year)
        p = _params(setup, fit, draws, row, outer=int(config.MODE2_UNCERTAINTY_DRAWS), rng=rng)
        base = _scenario(setup, p, None, draws=int(config.MODE2_POINTS_DRAWS),
                         seed=config.MODE2_SEED + year)
        career.extend(_career_season(setup, p, base, meta))
        cfs.extend(_cf_rows(setup, p, base, [g for g in grid if g["year"] == year],
                            comp_of_driver, comp_of_cell, floating, rng))
        log.info("mode2 points %d: %d seats, %d counterfactuals, %.0fs elapsed",
                 year, len(setup.drivers), sum(g["year"] == year for g in grid),
                 time.time() - started)
    return _write_points(conn, asid, fit_id, calib, career, cfs, meta, skipped, started)


def _write_points(conn, asid: int, fit_id: int, calib: pd.DataFrame, career: list[dict],
                  cfs: list[dict], meta: dict, skipped: int, started: float) -> dict:
    """One transaction, no commit — the caller (``companion`` / ``ingest``) commits.

    ``fit_id`` is re-resolved here rather than trusted from the start of the run: a
    concurrent ``recompute_rating`` deletes and re-inserts the current fit row, and these
    three tables cascade off it. Attaching to the fit that is current at WRITE time is
    the difference between a foreign-key violation and a coherent set of rows.
    """
    live = _current_fit_id(conn, asid)
    if live is not None and live != fit_id:
        log.warning("mode2 points: current fit moved %d -> %d during the run", fit_id, live)
        fit_id = live
    cal = calib.copy()
    cal["fit_id"] = fit_id
    car = pd.DataFrame(career)
    cf = pd.DataFrame(cfs)
    for df in (car, cf):
        if not df.empty:
            df["fit_id"] = fit_id
            df["assumption_set_id"] = asid
    counts = {}
    with conn.cursor() as cur:
        for table in POINTS_TABLES:
            cur.execute(f"DELETE FROM {table} WHERE fit_id = %s", (int(fit_id),))
        for table, df in (("mode2_points_calib", cal), ("mode2_career_season", car),
                          ("mode2_counterfactual", cf)):
            body = frames.empty_frame(table) if df.empty else frames.cast_frame(df, table)
            counts[table] = db.copy_frame(cur, table, body)
    n = write_status(conn, "mode2_counterfactual", "partial" if skipped else "ok")
    out = counts | {"fit_id": fit_id, "sessions_marked": n, "skipped": False,
                    "n_scenarios_skipped": int(skipped),
                    "seconds": round(time.time() - started, 1)}
    log.info("mode2 recompute_points: %s", out)
    return out
