"""Race-model parameters for the browser Monte Carlo (SIM_SPEC §1). Estimation and one deterministic
replay; nothing random happens here. Inputs use FastF1 column names (Driver, LapNumber, Compound,
TyreLife, Stint, LapTimeFuelCorrected ...) exactly as frames._laps_frame's `fc` frame carries them.

Layout (bottom-up, every function pure on DataFrames; the DB is touched only by
``recompute_hazards``):

    fit_rows            §1.2  the representative slick laps, the parameterised compounds, the §1.12 pre-fit rules
    fit_lap_model       §1.2  one WLS per race with the evo ridge pseudo-observation -> LapModel
    predict             §1.1  the one lap formula every other function calls
    driver_compound_dev §1.3  shrunk driver x compound deviation
    stint_scatter       §1.5  per-compound between-stint random-effect variances
    lap_deltas          §1.8  field-wide slowdown per lap
    start_penalty       §1.8  lap-1 excess over the model
    pit_excess/pit_loss §1.6/§1.7  in+out excess over the model per stop; green / SC / VSC samples
    hazard_counts       §1.9  SC / VSC / red lap counts of this race
    replay              §1.10 deterministic per-lap times of a strategy (the TS engine reproduces this)
    calibrate           §1.10 per-driver replay of the real strategy, decomposed
    stint_coverage      §1.10 leave-random-effects-out coverage diagnostic
    fit_race            orchestration with the config constants -> SimFit
    recompute_hazards   §1.9  cross-season circuit hazard table (DB)
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import statsmodels.api as sm

from . import config

MAD_SCALE = 1.4826

# Track status vocabulary (§0.3): '4' SC, '6'|'7' VSC, '5' red, everything else green.
SC_CODES = ("4",)
VSC_CODES = ("6", "7")
RED_CODES = ("5",)


class SimNotEstimable(ValueError):
    """Raised by fit_race when §1.12 says there is no model. Subclasses ValueError so frames._guard
    records 'error: SimNotEstimable: <reason>' and the session goes 'partial', never 'failed'."""


@dataclass(frozen=True)
class LapModel:
    """The joint fit of §1.2. names: ['base:VER', ..., 'off:MEDIUM', ..., 'deg:HARD', ..., 'evo'];
    beta/se aligned with names; cov: full covariance (k_all x k_all); resid: Series aligned with the fit rows;
    r2, resid_sd, resid_mad, design_cond, ref_compound, drivers (list[str]), compounds (list[str])."""

    names: list[str]
    beta: np.ndarray
    se: np.ndarray
    cov: np.ndarray
    resid: pd.Series
    r2: float
    resid_sd: float
    resid_mad: float
    design_cond: float
    ref_compound: str
    drivers: list[str]
    compounds: list[str]
    index: dict[str, int] = field(default_factory=dict)

    # -- convenience lookups (point estimates) ------------------------------------------------
    def coef(self, name: str) -> float:
        return float(self.beta[self.index[name]])

    def base(self, driver: str) -> float:
        return self.coef(f"base:{driver}")

    def offset(self, compound: str) -> float:
        return 0.0 if compound == self.ref_compound else self.coef(f"off:{compound}")

    def deg(self, compound: str) -> float:
        return self.coef(f"deg:{compound}")

    @property
    def evo(self) -> float:
        return self.coef("evo")

    @property
    def theta_names(self) -> list[str]:
        """The sampled block of §1.11: [off:* (non-ref), deg:*, evo] in design order."""
        return [n for n in self.names if not n.startswith("base:")]


@dataclass(frozen=True)
class SimFit:
    race_params: pd.DataFrame       # 1 row; columns == EXPECTED_COLUMNS['sim_race_params'] minus session_id/assumption_set_id
    compound_params: pd.DataFrame   # DB column names; 'compound' upper-case
    driver_params: pd.DataFrame     # column 'Driver' (FastF1 code) instead of driver_id; frames.py resolves ids
    driver_compound: pd.DataFrame   # 'Driver', 'compound', laps, dc_offset_s, dc_se
    warnings: list[str]             # e.g. 'sim: SOFT not parameterised (12 fit rows < 30)'

    def __len__(self) -> int:       # _guard calls len(); 1 when fitted
        return len(self.race_params)


# ---------------------------------------------------------------------------
# §1.2 fit rows and the joint estimator
# ---------------------------------------------------------------------------

def _norm_compound(s: pd.Series) -> pd.Series:
    return pd.Series([str(v).upper() if v is not None and not (isinstance(v, float) and math.isnan(v)) else "NAN"
                      for v in s], index=s.index, dtype=object)


def fit_rows(fc_all: pd.DataFrame, min_compound_laps: int) -> tuple[pd.DataFrame, list[str], dict[str, int]]:
    """(rows, parameterised compounds, dropped {compound: n}) per §1.2. Raises SimNotEstimable on the §1.12 rules
    that are decidable before the fit (rain race, < 2 compounds, < SIM_MIN_FIT_LAPS rows)."""
    rep = fc_all.loc[fc_all["is_representative"].astype(bool) & (fc_all["TyreLife"] >= 2)].copy()
    rep["Compound"] = _norm_compound(rep["Compound"])
    n_rep = int(len(rep))
    n_wet = int(rep["Compound"].isin(["INTERMEDIATE", "WET"]).sum())
    if n_rep and n_wet > 0.5 * n_rep:
        raise SimNotEstimable(f"rain race: {n_wet} of {n_rep} representative laps on INTERMEDIATE/WET")

    counts = rep.loc[rep["Compound"].isin(config.SIM_SLICK_COMPOUNDS), "Compound"].value_counts()
    # Parameterised set ordered by rows desc, then name (the ref compound is the first).
    seen = sorted(((str(c), int(n)) for c, n in counts.items()), key=lambda cn: (-cn[1], cn[0]))
    compounds = [c for c, n in seen if n >= min_compound_laps]
    dropped = {c: n for c, n in seen if n < min_compound_laps}
    if len(compounds) < 2:
        detail = ", ".join(f"{c}: {n}" for c, n in seen) or "no slick laps"
        raise SimNotEstimable(f"only {len(compounds)} parameterised compound"
                              f"{'' if len(compounds) == 1 else 's'} ({detail} fit rows)")

    rows = rep.loc[rep["Compound"].isin(compounds),
                   ["Driver", "Compound", "TyreLife", "LapNumber", "Stint", "LapTimeSeconds",
                    "LapTimeFuelCorrected"]].copy()
    rows["Driver"] = rows["Driver"].astype(str)
    if len(rows) < config.SIM_MIN_FIT_LAPS:
        raise SimNotEstimable(f"fewer than {config.SIM_MIN_FIT_LAPS} fit rows ({len(rows)})")
    return rows, compounds, dropped


def _design(rows: pd.DataFrame, drivers: list[str], compounds: list[str], ref: str) -> tuple[np.ndarray, list[str]]:
    """The un-augmented design matrix of §1.2 and its column names, in the contract order."""
    drv = rows["Driver"].to_numpy()
    comp = rows["Compound"].to_numpy()
    age = rows["TyreLife"].to_numpy(dtype=float) - 1.0
    lap = rows["LapNumber"].to_numpy(dtype=float) - 1.0
    cols: list[np.ndarray] = []
    names: list[str] = []
    for d in drivers:
        cols.append((drv == d).astype(float)); names.append(f"base:{d}")
    for c in compounds:
        if c != ref:
            cols.append((comp == c).astype(float)); names.append(f"off:{c}")
    for c in compounds:
        cols.append((comp == c).astype(float) * age); names.append(f"deg:{c}")
    cols.append(lap); names.append("evo")
    return np.column_stack(cols), names


def fit_lap_model(rows: pd.DataFrame, *, evo_prior_sd: float, resid_sd_guess: float,
                  min_driver_laps: int) -> LapModel:
    """WLS with driver dummies, compound offsets, per-compound deg on (TyreLife-1), evo on (LapNumber-1)
    and the evo ridge pseudo-observation (§1.2). Drivers with < min_driver_laps rows are dropped from the rows
    before the design is built. Raises SimNotEstimable when < SIM_MIN_DRIVERS drivers remain or
    design_cond > SIM_DESIGN_COND_MAX."""
    per_driver = rows["Driver"].value_counts()
    drivers = sorted(str(d) for d, n in per_driver.items() if n >= min_driver_laps)
    if len(drivers) < config.SIM_MIN_DRIVERS:
        raise SimNotEstimable(f"fewer than {config.SIM_MIN_DRIVERS} drivers with >= {min_driver_laps} fit rows "
                              f"({len(drivers)})")
    rows = rows.loc[rows["Driver"].isin(drivers)]
    counts = rows["Compound"].value_counts()
    compounds = sorted((str(c) for c in counts.index), key=lambda c: (-int(counts[c]), c))
    ref = compounds[0]

    X, names = _design(rows, drivers, compounds, ref)
    y = rows["LapTimeFuelCorrected"].to_numpy(dtype=float)
    n, k = X.shape
    design_cond = float(np.linalg.cond(X))

    # Ridge on evo only: one pseudo-row y = 0, X = e_evo, weight (resid_sd_guess / evo_prior_sd)^2.
    pseudo = np.zeros((1, k)); pseudo[0, names.index("evo")] = 1.0
    X_aug = np.vstack([X, pseudo])
    y_aug = np.concatenate([y, [0.0]])
    w = np.concatenate([np.ones(n), [(resid_sd_guess / evo_prior_sd) ** 2]])
    res = sm.WLS(y_aug, X_aug, weights=w).fit()
    beta = np.asarray(res.params, dtype=float)
    cov = np.asarray(res.cov_params(), dtype=float)
    se = np.sqrt(np.diag(cov))

    resid = y - X @ beta
    ss_res = float(np.sum(resid ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    resid_sd = math.sqrt(ss_res / max(n - k, 1))
    resid_mad = MAD_SCALE * float(np.median(np.abs(resid - np.median(resid))))
    if not (np.all(np.isfinite(beta)) and np.all(np.isfinite(cov))):
        raise SimNotEstimable(f"design not estimable (condition number {design_cond:.3g})")
    # §1.12: the condition number that matters is the ridge-augmented one (the ridge makes Belgium 2025 finite).
    cond_aug = float(np.linalg.cond(X_aug * np.sqrt(w)[:, None]))
    if cond_aug > config.SIM_DESIGN_COND_MAX:
        raise SimNotEstimable(f"design condition number {cond_aug:.3g} > {config.SIM_DESIGN_COND_MAX:g} after the ridge")

    return LapModel(
        names=names, beta=beta, se=se, cov=cov,
        resid=pd.Series(resid, index=rows.index, dtype=float),
        r2=float(r2), resid_sd=float(resid_sd), resid_mad=float(resid_mad), design_cond=design_cond,
        ref_compound=ref, drivers=drivers, compounds=compounds,
        index={nm: i for i, nm in enumerate(names)},
    )


def predict(model: LapModel, driver: str, compound: str, age: int, lap: int, dc: float = 0.0) -> float:
    """base_d + off_c + dc + deg_c*(age-1) + evo*(lap-1). The one formula; every other function calls it."""
    return (model.base(driver) + model.offset(compound) + dc
            + model.deg(compound) * (age - 1) + model.evo * (lap - 1))


# ---------------------------------------------------------------------------
# §1.3 driver x compound deviation
# ---------------------------------------------------------------------------

def driver_noise_sd(rows: pd.DataFrame, model: LapModel, floor: float = config.SIM_NOISE_SD_FLOOR) -> pd.Series:
    """noise_sd_s per driver with a dummy: max(1.4826 * MAD(resid_d), floor) (§1.8), indexed by Driver."""
    fit = rows.loc[model.resid.index]
    out: dict[str, float] = {}
    for d in model.drivers:
        r = model.resid.loc[fit["Driver"].to_numpy() == d].to_numpy(dtype=float)
        mad = MAD_SCALE * float(np.median(np.abs(r - np.median(r)))) if len(r) else 0.0
        out[d] = max(mad, float(floor))
    return pd.Series(out, name="noise_sd_s", dtype=float)


def driver_compound_dev(rows: pd.DataFrame, model: LapModel, k_dc: int) -> pd.DataFrame:
    """§1.3: one row per (driver with a dummy, parameterised compound) the driver actually ran.
    dc_offset_s = mean(resid) * n/(n+k), dc_se = noise_sd_d / sqrt(n+k). Columns: Driver, compound, laps,
    dc_offset_s, dc_se. Cells never run are absent (the browser rule dc=0, dc_se=noise/sqrt(k) applies)."""
    fit = rows.loc[model.resid.index, ["Driver", "Compound"]].copy()
    fit["resid"] = model.resid.to_numpy(dtype=float)
    noise = driver_noise_sd(rows, model)
    recs: list[dict] = []
    for d in model.drivers:
        sub = fit.loc[fit["Driver"] == d]
        for c in model.compounds:
            r = sub.loc[sub["Compound"] == c, "resid"]
            n = int(len(r))
            if n == 0:
                continue
            recs.append({"Driver": d, "compound": c, "laps": n,
                         "dc_offset_s": float(r.mean()) * n / (n + k_dc),
                         "dc_se": float(noise[d]) / math.sqrt(n + k_dc)})
    return pd.DataFrame(recs, columns=["Driver", "compound", "laps", "dc_offset_s", "dc_se"])


# ---------------------------------------------------------------------------
# §1.5 between-stint scatter
# ---------------------------------------------------------------------------

def stint_scatter(rows: pd.DataFrame, model: LapModel, *, min_laps: int, min_stints: int,
                  priors: tuple[float, float], caps: tuple[float, float]) -> pd.DataFrame:
    """§1.5, one row per parameterised compound: compound, stints_used, stint_tau_level_s, stint_tau_slope,
    stint_tau_source ('race'|'prior'). Per stint (Driver, Stint) with >= min_laps fit rows on c: OLS
    resid ~ v + w*(age-1); tau^2 = max(0, var(v_i) - mean(se_v_i^2)) (same for w), then sqrt and cap.
    priors = (tau_level_prior, tau_slope_prior), caps = (tau_level_max, tau_slope_max)."""
    fit = rows.loc[model.resid.index, ["Driver", "Compound", "Stint", "TyreLife"]].copy()
    fit["resid"] = model.resid.to_numpy(dtype=float)
    recs: list[dict] = []
    for c in model.compounds:
        v, w, se_v2, se_w2 = [], [], [], []
        for _, g in fit.loc[fit["Compound"] == c].groupby(["Driver", "Stint"], sort=True):
            if len(g) < min_laps:
                continue
            X = np.column_stack([np.ones(len(g)), g["TyreLife"].to_numpy(dtype=float) - 1.0])
            res = sm.OLS(g["resid"].to_numpy(dtype=float), X).fit()
            v.append(float(res.params[0])); w.append(float(res.params[1]))
            se_v2.append(float(res.bse[0]) ** 2); se_w2.append(float(res.bse[1]) ** 2)
        used = len(v)
        if used >= min_stints:
            tl2 = max(0.0, float(np.var(v, ddof=1)) - float(np.mean(se_v2)))
            ts2 = max(0.0, float(np.var(w, ddof=1)) - float(np.mean(se_w2)))
            tau_l, tau_s, src = math.sqrt(tl2), math.sqrt(ts2), "race"
        else:
            tau_l, tau_s, src = float(priors[0]), float(priors[1]), "prior"
        recs.append({"compound": c, "stints_used": int(used),
                     "stint_tau_level_s": min(tau_l, float(caps[0])),
                     "stint_tau_slope": min(tau_s, float(caps[1])),
                     "stint_tau_source": src})
    return pd.DataFrame(recs, columns=["compound", "stints_used", "stint_tau_level_s",
                                       "stint_tau_slope", "stint_tau_source"])


# ---------------------------------------------------------------------------
# §1.4 compound parameters (deg floor, negative flag, age_max)
# ---------------------------------------------------------------------------

def compound_table(rows: pd.DataFrame, model: LapModel, tau: pd.DataFrame | None = None,
                   *, deg_floor: float = config.SIM_DEG_FLOOR) -> tuple[pd.DataFrame, list[str]]:
    """(frame, warnings): the §2.1 sim_compound_params columns minus session_id/assumption_set_id, one row per
    parameterised compound in model.compounds order. deg_s_per_lap = max(deg_raw, deg_floor), deg_negative =
    deg_raw < deg_floor (warning 'sim: <c> degradation <raw> floored to <floor>'), age_max = max TyreLife of the
    fit rows on c. The stint_tau_* columns come from `tau` (stint_scatter output); when tau is None they are
    omitted so the caller can merge later."""
    fit = rows.loc[model.resid.index]
    recs: list[dict] = []
    warnings: list[str] = []
    for c in model.compounds:
        on_c = fit.loc[fit["Compound"] == c]
        raw = model.deg(c)
        neg = bool(raw < deg_floor)
        if neg:
            warnings.append(f"sim: {c} degradation {raw:.3f} floored to {deg_floor:g}")
        is_ref = c == model.ref_compound
        recs.append({
            "compound": c, "laps": int(len(on_c)), "age_max": int(on_c["TyreLife"].max()),
            "offset_s": 0.0 if is_ref else model.offset(c),
            "offset_se": 0.0 if is_ref else float(model.se[model.index[f"off:{c}"]]),
            "deg_raw_s_per_lap": float(raw), "deg_s_per_lap": float(max(raw, deg_floor)),
            "deg_se": float(model.se[model.index[f"deg:{c}"]]), "deg_negative": neg,
        })
    out = pd.DataFrame(recs)
    if tau is not None:
        out = out.merge(tau[["compound", "stint_tau_level_s", "stint_tau_slope", "stint_tau_source",
                             "stints_used"]], on="compound", how="left")
    return out, warnings


# ---------------------------------------------------------------------------
# §1.6–1.8 model-relative lap excesses: field delta, start penalty, pit loss
# ---------------------------------------------------------------------------

def _model_times(fc: pd.DataFrame, model: LapModel, dc: pd.DataFrame,
                 age: pd.Series | None = None) -> pd.Series:
    """model[L] (§1.6) for every row of `fc`: base_d + off_c + dc_{d,c} + deg_c*(age-1) + evo*(L-1).
    NaN for drivers without a dummy or compounds not parameterised. `age` overrides TyreLife (out-laps: 1)."""
    drv = fc["Driver"].astype(str)
    comp = _norm_compound(fc["Compound"])
    lap = pd.to_numeric(fc["LapNumber"], errors="coerce").astype(float)
    a = pd.to_numeric(fc["TyreLife"] if age is None else age, errors="coerce").astype(float)
    base = drv.map({d: model.base(d) for d in model.drivers})
    off = comp.map({c: model.offset(c) for c in model.compounds})
    deg = comp.map({c: model.deg(c) for c in model.compounds})
    dcm = {(str(r.Driver), str(r.compound)): float(r.dc_offset_s) for r in dc.itertuples(index=False)}
    dcv = pd.Series([dcm.get((d, c), 0.0) for d, c in zip(drv, comp)], index=fc.index, dtype=float)
    out = base + off + dcv + deg * (a - 1.0) + model.evo * (lap - 1.0)
    return out.astype(float)


def _pit_lap_keys(pits: pd.DataFrame) -> set[tuple[str, int]]:
    """(Driver, LapNumber) of every in-lap and every out-lap in the pit_stops frame."""
    keys: set[tuple[str, int]] = set()
    for r in pits.itertuples(index=False):
        keys.add((str(r.Driver), int(r.LapIn)))
        if r.LapOut is not None and not pd.isna(r.LapOut):
            keys.add((str(r.Driver), int(r.LapOut)))
    return keys


def green_delta_offset(deltas: list[float], n_cars: list[int], lap_status: pd.DataFrame | None, *,
                       min_cars: int, trim: float = config.SIM_DELTA_CENTRE_TRIM,
                       min_laps: int = config.SIM_DELTA_CENTRE_MIN_LAPS) -> float:
    """§1.8 centring level: the symmetrically `trim`-trimmed mean of δ over the laps that have a known δ
    (n_cars >= min_cars, L >= 2) and a green worst_status ('1'|'2'). 0.0 when lap_status is missing or fewer
    than min_laps such laps exist. See config.SIM_DELTA_CENTRE_TRIM for why this is not a plain median."""
    if lap_status is None or not len(lap_status):
        return 0.0
    ln = lap_status["lap_number"] if "lap_number" in lap_status.columns else lap_status["LapNumber"]
    ws = lap_status["worst_status"] if "worst_status" in lap_status.columns else lap_status["WorstStatus"]
    green = {int(l) for l, st in zip(pd.to_numeric(ln, errors="coerce").fillna(-1).astype(int), ws.astype(str))
             if st in ("1", "2")}
    vals = np.array([d for i, (d, n) in enumerate(zip(deltas, n_cars), start=1)
                     if i >= 2 and n >= min_cars and i in green], dtype=float)
    if len(vals) < min_laps:
        return 0.0
    vals = np.sort(vals)
    k = int(len(vals) * trim)
    core = vals[k:len(vals) - k] if k and len(vals) - 2 * k >= 1 else vals
    return float(np.mean(core))


def lap_deltas(fc_all: pd.DataFrame, pits: pd.DataFrame, model: LapModel, dc: pd.DataFrame,
               total_laps: int, min_cars: int,
               lap_status: pd.DataFrame | None = None) -> tuple[list[float], list[int]]:
    """§1.8 δ_L: per lap L = 2..total_laps the median of lap_time_fc_s - model[L] over cars with a lap time,
    a dummy and a parameterised compound that are not on an in-/out-lap; 0 (and 0 cars) on lap 1 and when
    fewer than min_cars qualify. Returns (deltas, n_cars), both length total_laps, index L-1.
    When `lap_status` is given, every known δ is shifted by -green_delta_offset(...) so that an ordinary green
    lap sits at ~0 and SC/VSC laps keep their full slowdown; laps with an unknown δ stay at exactly 0, which is
    the same "no information" value before and after. The offset is folded into δ itself (no schema change)."""
    t = fc_all.loc[fc_all["LapNumber"].notna() & fc_all["LapTimeFuelCorrected"].notna()].copy()
    t["_model"] = _model_times(t, model, dc)
    t = t.loc[t["_model"].notna()]
    keys = _pit_lap_keys(pits)
    keep = [(str(d), int(l)) not in keys for d, l in zip(t["Driver"], t["LapNumber"])]
    t = t.loc[keep].copy()
    t["_ex"] = t["LapTimeFuelCorrected"].astype(float) - t["_model"]
    deltas = [0.0] * int(total_laps)
    n_cars = [0] * int(total_laps)
    for lap, grp in t.groupby(t["LapNumber"].astype(int)):
        if lap < 2 or lap > total_laps or len(grp) < min_cars:
            continue
        deltas[lap - 1] = float(np.median(grp["_ex"].to_numpy(dtype=float)))
        n_cars[lap - 1] = int(len(grp))
    off = green_delta_offset(deltas, n_cars, lap_status, min_cars=min_cars)
    if off:
        deltas = [d - off if n >= min_cars else 0.0 for d, n in zip(deltas, n_cars)]
    return deltas, n_cars


def start_penalty(fc_all: pd.DataFrame, model: LapModel, dc: pd.DataFrame) -> float:
    """§1.8 start_penalty_s: median over cars with a lap-1 time (and a model prediction) of t_fc[1] - model[1].
    0.0 when no car qualifies (calibration only, so a zero is harmless)."""
    t = fc_all.loc[(pd.to_numeric(fc_all["LapNumber"], errors="coerce") == 1)
                   & fc_all["LapTimeFuelCorrected"].notna()].copy()
    if t.empty:
        return 0.0
    ex = t["LapTimeFuelCorrected"].astype(float) - _model_times(t, model, dc)
    ex = ex.dropna()
    return float(np.median(ex.to_numpy(dtype=float))) if len(ex) else 0.0


def hazard_counts(lap_status: pd.DataFrame) -> dict:
    """§1.9 per-session counts from derive.lap_status: n_sc_laps (WorstStatus '4'), n_vsc_laps ('6'|'7'),
    n_red_laps ('5')."""
    ws = lap_status["WorstStatus"].astype(str)
    return {"n_sc_laps": int((ws == "4").sum()),
            "n_vsc_laps": int(ws.isin(["6", "7"]).sum()),
            "n_red_laps": int((ws == "5").sum())}


def pit_excess(fc_all: pd.DataFrame, pits: pd.DataFrame, lap_status: pd.DataFrame, model: LapModel,
               dc: pd.DataFrame, deltas: list[float], compounds: list[str],
               delta_cars: list[int] | None = None, min_cars: int = config.SIM_MIN_CARS_FOR_DELTA) -> pd.DataFrame:
    """One row per usable stop (§1.6): Driver, stop_number, lap_in, status_in ('1'..'7'), excess_s, plus
    status_out (needed for the green test of §1.6). Usable = lap_out present, lap_in > 1, both laps with a
    fuel-corrected time, both compounds parameterised, driver with a dummy, and (when `delta_cars` is given) a known
    delta on both laps (field_delta_cars >= min_cars; on a lap where every car pits under SC delta is 0 by
    construction and the excess would swallow the whole SC slowdown -- 2024 Qatar laps 35-38).
    excess_s = t_fc[in] + t_fc[out] - model[in] (real age) - model[out] (age 1) - delta[in] - delta[out]."""
    cols = ["Driver", "stop_number", "lap_in", "status_in", "status_out", "excess_s"]
    t = fc_all.loc[fc_all["LapNumber"].notna() & fc_all["LapTimeFuelCorrected"].notna()].copy()
    t["_key"] = list(zip(t["Driver"].astype(str), t["LapNumber"].astype(int)))
    t = t.drop_duplicates("_key").set_index("_key")
    m_in = _model_times(t, model, dc)
    m_out = _model_times(t, model, dc, age=pd.Series(1.0, index=t.index))
    tfc = t["LapTimeFuelCorrected"].astype(float)
    status = dict(zip(lap_status["LapNumber"].astype(int), lap_status["WorstStatus"].astype(str)))
    pset = set(compounds)
    recs: list[dict] = []
    for r in pits.itertuples(index=False):
        if r.LapOut is None or pd.isna(r.LapOut) or int(r.LapIn) <= 1:
            continue
        drv, li, lo = str(r.Driver), int(r.LapIn), int(r.LapOut)
        if drv not in model.drivers or (drv, li) not in t.index or (drv, lo) not in t.index:
            continue
        if str(r.CompoundIn).upper() not in pset or str(r.CompoundOut).upper() not in pset:
            continue
        if lo > len(deltas) or pd.isna(m_in[(drv, li)]) or pd.isna(m_out[(drv, lo)]):
            continue
        if delta_cars is not None and (int(delta_cars[li - 1]) < min_cars or int(delta_cars[lo - 1]) < min_cars):
            continue
        ex = (float(tfc[(drv, li)]) + float(tfc[(drv, lo)]) - float(m_in[(drv, li)]) - float(m_out[(drv, lo)])
              - float(deltas[li - 1]) - float(deltas[lo - 1]))
        recs.append({"Driver": drv, "stop_number": int(r.StopNumber), "lap_in": li,
                     "status_in": status.get(li, "1"), "status_out": status.get(lo, "1"), "excess_s": ex})
    return pd.DataFrame(recs, columns=cols)


def pit_loss(excess: pd.DataFrame, *, min_green: int, min_sc: int, samples_max: int,
             factor_min: float = config.SIM_PIT_FACTOR_MIN,
             factor_max: float = config.SIM_PIT_FACTOR_MAX) -> dict:
    """The pit_* / sc_* columns of sim_race_params (§1.6, §1.7) from a pit_excess frame.
    Green = status_in and status_out in {'1','2'}: pit_loss_s (median), pit_loss_mad_s (raw MAD, the pooled
    draw scales it by 1.4826), pit_loss_n, pit_loss_samples_s (<= samples_max nearest the median). When
    pit_loss_n < min_green: pit_loss_s / pit_loss_mad_s None and an empty sample list. sc_pit_samples_s =
    excess of stops with status_in '4', vsc_pit_samples_s '6'|'7' (<= samples_max each); the *_factor_race
    = median(samples) / pit_loss_s when len >= min_sc and pit_loss_s is not None, else None. A factor outside
    [factor_min, factor_max] is a measurement failure (too few / too noisy caution stops), not a finding about the
    race: it is dropped to None so the browser's race -> pooled -> config-prior chain supplies a sane value, and a
    'sim: ...' string is added to the returned 'warnings' list (fit_race merges it into SimFit.warnings)."""
    st_in = excess["status_in"].astype(str)
    st_out = excess["status_out"].astype(str)
    ex = excess["excess_s"].astype(float)
    green = ex.loc[st_in.isin(["1", "2"]) & st_out.isin(["1", "2"])].to_numpy(dtype=float)
    out: dict = {"pit_loss_s": None, "pit_loss_mad_s": None, "pit_loss_n": int(len(green)),
                 "pit_loss_samples_s": [], "warnings": []}
    if len(green) >= min_green:
        med = float(np.median(green))
        out["pit_loss_s"] = med
        out["pit_loss_mad_s"] = float(np.median(np.abs(green - med)))
        order = np.argsort(np.abs(green - med), kind="stable")[:samples_max]
        out["pit_loss_samples_s"] = [float(v) for v in np.sort(green[order])]
    for key, codes in (("sc", ["4"]), ("vsc", ["6", "7"])):
        s = ex.loc[st_in.isin(codes)].to_numpy(dtype=float)
        if len(s) > samples_max:
            smed = float(np.median(s))
            s = s[np.argsort(np.abs(s - smed), kind="stable")[:samples_max]]
        out[f"{key}_pit_samples_s"] = [float(v) for v in np.sort(s)]
        factor = None
        if len(s) >= min_sc and out["pit_loss_s"] is not None:
            factor = float(np.median(s)) / out["pit_loss_s"]
            if not (factor_min <= factor <= factor_max):
                out["warnings"].append(
                    f"sim: {key.upper()} pit factor {factor:.2f} from {len(s)} stops out of range "
                    f"[{factor_min:g}, {factor_max:g}], using pooled")
                factor = None
        out[f"{key}_pit_factor_race"] = factor
    return out


# ---------------------------------------------------------------------------
# §1.10 deterministic replay (the arithmetic the TS engine reproduces to 1e-9)
# ---------------------------------------------------------------------------

# §1.6 pooled median quoted in the spec; used by calibrate only when this race has no green pit loss.
POOLED_PIT_LOSS_FALLBACK_S = 22.5


def pit_factor(status: str, sc_factor: float, vsc_factor: float) -> float:
    """§1.7 classification of a stop by the worst_status of its in-lap: '4'|'5' -> sc, '6'|'7' -> vsc, else 1."""
    s = str(status)
    if s in SC_CODES or s in RED_CODES:
        return float(sc_factor)
    if s in VSC_CODES:
        return float(vsc_factor)
    return 1.0


def replay(strategy: list[tuple[str, int]], stops_status: list[str], *, model: LapModel, dc: pd.DataFrame | dict,
           deltas: list[float], start_penalty: float, pit_loss_s: float, sc_factor: float, vsc_factor: float,
           horizon: int, start_age: int = 1, use_deltas: bool = True, driver: str,
           deg_floor: float = config.SIM_DEG_FLOOR) -> tuple[float, list[float]]:
    """Deterministic per-lap times (fc) for `driver` on a strategy [(compound, end_lap), ...] over laps 1..horizon
    with the §0.3 stint convention: the in-lap is end_lap (pit_loss_s * pit_factor(stops_status[i]) charged there),
    the out-lap end_lap+1 has age 1; the first stint starts at `start_age`. Per lap:
    base_d + off_c + dc_{d,c} + max(deg_c, deg_floor)*(age-1) + evo*(L-1) + delta[L-1] (use_deltas) + start_penalty
    (lap 1). `dc` is the driver_compound_dev frame (filtered to `driver`) or a {compound: dc} dict. The last
    stint's end_lap must equal horizon. Returns (total, per_lap)."""
    if not strategy or int(strategy[-1][1]) != int(horizon):
        raise ValueError(f"strategy must end at the horizon {horizon}: {strategy}")
    if len(stops_status) < len(strategy) - 1:
        raise ValueError(f"stops_status needs {len(strategy) - 1} entries, got {len(stops_status)}")
    if isinstance(dc, dict):
        dcm = {str(k).upper(): float(v) for k, v in dc.items()}
    else:
        sub = dc.loc[dc["Driver"].astype(str) == str(driver)]
        dcm = {str(c).upper(): float(v) for c, v in zip(sub["compound"], sub["dc_offset_s"])}
    base = model.base(driver)
    evo = model.evo
    per_lap: list[float] = []
    lap = 1
    for i, (comp, end_lap) in enumerate(strategy):
        c = str(comp).upper()
        end_lap = int(end_lap)
        if c not in model.compounds:
            raise ValueError(f"compound {c} not parameterised")
        if end_lap < lap:
            raise ValueError(f"stint {i + 1} ends on lap {end_lap} before it starts on lap {lap}")
        off, deg, dcv = model.offset(c), max(model.deg(c), float(deg_floor)), dcm.get(c, 0.0)
        age0 = int(start_age) if i == 0 else 1
        stint_start = lap
        while lap <= end_lap:
            age = lap - stint_start + age0
            t = base + off + dcv + deg * (age - 1) + evo * (lap - 1)
            if use_deltas:
                t += float(deltas[lap - 1])
            if lap == 1:
                t += float(start_penalty)
            if lap == end_lap and i < len(strategy) - 1:
                t += float(pit_loss_s) * pit_factor(stops_status[i], sc_factor, vsc_factor)
            per_lap.append(float(t))
            lap += 1
    return float(sum(per_lap)), per_lap


def start_age(laps: pd.DataFrame) -> int:
    """Tyre age on lap 1 for one driver's laps (TyreLife of the LapNumber == 1 row); 1 when there is no such row or
    it is NaN. Mirrors web/lib/queries/sim.ts `actualStartAge` so the stored calibration replay and the browser's
    replay of the actual strategy age the first stint identically."""
    tl = laps.loc[laps["LapNumber"] == 1, "TyreLife"] if "TyreLife" in laps.columns else pd.Series(dtype=float)
    if len(tl) == 0 or pd.isna(tl.iloc[0]):
        return 1
    return int(tl.iloc[0])


def driver_strategy(stints: pd.DataFrame, driver: str, horizon: int) -> list[tuple[str, int]] | None:
    """The actual strategy [(compound, end_lap), ...] of `driver` from clean.stint_table rows, truncated to
    `horizon`. None when the rows do not tile 1..horizon contiguously (§1.10 'stint data incomplete')."""
    sub = stints.loc[stints["Driver"].astype(str) == str(driver)].dropna(subset=["start_lap", "end_lap"])
    sub = sub.sort_values("start_lap")
    out: list[tuple[str, int]] = []
    expect = 1
    for r in sub.itertuples(index=False):
        s, e = int(r.start_lap), int(r.end_lap)
        if s != expect or e < s:
            return None
        if s > horizon:
            break
        out.append((str(r.Compound).upper(), min(e, int(horizon))))
        expect = e + 1
        if e >= horizon:
            break
    if not out or out[-1][1] != int(horizon):
        return None
    return out


CALIB_COLUMNS = ["Driver", "laps_completed", "laps_timed", "laps_modelled", "unmodelled_laps", "stops",
                 "simulable", "not_simulable_reason", "real_total_s", "real_total_fc_s", "real_fuel_s",
                 "sim_total_fc_s", "misfit_rep_s", "misfit_pit_s", "misfit_lap1_s", "unmodelled_s", "badge"]
_CALIB_NULLABLE = CALIB_COLUMNS[8:]


def _horizons(results: pd.DataFrame, fc_all: pd.DataFrame) -> dict[str, int]:
    """Driver code -> laps_completed from session.results (Abbreviation, Laps); the driver's max LapNumber
    when the results row is missing or has no lap count."""
    out: dict[str, int] = {}
    if results is not None and "Abbreviation" in results.columns and "Laps" in results.columns:
        for a, n in zip(results["Abbreviation"], results["Laps"]):
            if not pd.isna(n):
                out[str(a)] = int(n)
    mx = fc_all.loc[fc_all["LapNumber"].notna()].groupby(fc_all["Driver"].astype(str))["LapNumber"].max()
    for d, n in mx.items():
        out.setdefault(str(d), int(n))
    return out


def calibrate(fc_all: pd.DataFrame, stints: pd.DataFrame, pits: pd.DataFrame, lap_status: pd.DataFrame,
              results: pd.DataFrame, model: LapModel, dc: pd.DataFrame, deltas: list[float], start_penalty: float,
              pit: dict, compounds: list[str], *, min_modelled: int) -> pd.DataFrame:
    """§1.10: one row per driver with a dummy (CALIB_COLUMNS). The deterministic replay of the real strategy
    (point estimates, deg floored, real δ_L, start penalty, pit_loss_s or POOLED_PIT_LOSS_FALLBACK_S, SC/VSC
    factors = race value or config prior) over laps 1..laps_completed, decomposed so that
    sim_total_fc_s - real_total_fc_s == -(misfit_rep_s + misfit_pit_s + misfit_lap1_s + unmodelled_s) exactly.
    The calibration columns are None when simulable is False."""
    loss = pit.get("pit_loss_s")
    loss = float(loss) if loss is not None else POOLED_PIT_LOSS_FALLBACK_S
    sc_f = pit.get("sc_pit_factor_race") or config.SIM_SC_PIT_FACTOR_PRIOR
    vsc_f = pit.get("vsc_pit_factor_race") or config.SIM_VSC_PIT_FACTOR_PRIOR
    status = dict(zip(lap_status["LapNumber"].astype(int), lap_status["WorstStatus"].astype(str)))
    horizons = _horizons(results, fc_all)
    fit_idx = set(model.resid.index)
    pit_keys = _pit_lap_keys(pits)
    pset = set(compounds)
    n_stops = pits.loc[pits["LapOut"].notna()].groupby(pits["Driver"].astype(str)).size()
    fc = fc_all.loc[fc_all["LapNumber"].notna()].copy()
    fc["_drv"] = fc["Driver"].astype(str)
    fc["_comp"] = _norm_compound(fc["Compound"])
    recs: list[dict] = []
    for d in model.drivers:
        H = int(horizons.get(d, 0))
        laps = fc.loc[(fc["_drv"] == d) & (fc["LapNumber"] <= H)]
        timed = laps.loc[laps["LapTimeSeconds"].notna() & laps["LapTimeFuelCorrected"].notna()]
        tl = timed["LapNumber"].astype(int).to_numpy()
        is_fit = np.array([i in fit_idx for i in timed.index], dtype=bool)
        strat = driver_strategy(stints, d, H) if H >= 2 else None
        bounds = set()
        for _, e in (strat or [])[:-1]:
            bounds.update([e, e + 1])
        is_pit = np.array([((d, int(l)) in pit_keys) or (int(l) in bounds) for l in tl], dtype=bool)
        is_l1 = tl == 1
        is_mod = is_fit & ~is_l1
        is_pitlap = is_pit & ~is_l1 & ~is_mod
        is_unm = ~(is_l1 | is_mod | is_pitlap)
        rec = {"Driver": d, "laps_completed": H, "laps_timed": int(len(timed)), "laps_modelled": int(is_mod.sum()),
               "unmodelled_laps": int(is_unm.sum()), "stops": int(n_stops.get(d, 0)),
               "simulable": True, "not_simulable_reason": None}
        reason = None
        if H < 2:
            reason = f"laps_completed {H} < 2"
        elif strat is None:
            reason = "stint data incomplete"
        elif not timed["_comp"].isin(pset).all() or any(str(c).upper() not in pset for c, _ in strat):
            # a stint compound can be absent from the timed laps (e.g. an untimed final lap), so check both
            bad = sorted(set(timed.loc[~timed["_comp"].isin(pset), "_comp"])
                         | {str(c).upper() for c, _ in strat if str(c).upper() not in pset})
            reason = f"ran non-parameterised compound {', '.join(bad)}"
        elif rec["laps_modelled"] < min_modelled:
            reason = f"laps_modelled {rec['laps_modelled']} < {min_modelled}"
        if reason is not None:
            rec.update({"simulable": False, "not_simulable_reason": reason, **{c: None for c in _CALIB_NULLABLE}})
            recs.append(rec)
            continue
        stops_status = [status.get(int(e), "1") for _, e in strat[:-1]]
        # a used set at the start ages from laps.tyre_life on lap 1 (== the payload's actualStartAge; 1 when unknown)
        _, per_lap = replay(strat, stops_status, model=model, dc=dc, deltas=deltas, start_penalty=start_penalty,
                            pit_loss_s=loss, sc_factor=sc_f, vsc_factor=vsc_f, horizon=H, driver=d,
                            start_age=start_age(laps))
        sim_t = np.array([per_lap[l - 1] for l in tl], dtype=float)
        real = timed["LapTimeSeconds"].to_numpy(dtype=float)
        real_fc = timed["LapTimeFuelCorrected"].to_numpy(dtype=float)
        diff = real_fc - sim_t
        rep = float(diff[is_mod].sum())
        rec.update({"real_total_s": float(real.sum()), "real_total_fc_s": float(real_fc.sum()),
                    "real_fuel_s": float((real - real_fc).sum()), "sim_total_fc_s": float(sim_t.sum()),
                    "misfit_rep_s": rep, "misfit_pit_s": float(diff[is_pitlap].sum()),
                    "misfit_lap1_s": float(diff[is_l1].sum()), "unmodelled_s": float(diff[is_unm].sum())})
        per = abs(rep) / max(rec["laps_modelled"], 1)
        rec["badge"] = ("calibrated" if per <= config.SIM_CALIB_GOOD_S_PER_LAP
                        else "rough" if per <= config.SIM_CALIB_ROUGH_S_PER_LAP else "poor")
        recs.append(rec)
    return pd.DataFrame(recs, columns=CALIB_COLUMNS)


def stint_coverage(rows: pd.DataFrame, model: LapModel, tau: pd.DataFrame, noise_sd: pd.Series,
                   *, min_laps: int = config.SIM_STINT_MIN_LAPS, min_stints: int = 5) -> float | None:
    """§1.10 diagnostic stint_coverage_80: over every (Driver, Stint) with >= min_laps fit rows on a parameterised
    compound, the fraction whose real total lies within +-1.28 * sd_stint of the model total with the stint's
    random effects at 0, sd_stint^2 = n^2 tau_level^2 + tau_slope^2 (sum(age-1))^2 + n noise_sd_d^2.
    None when fewer than min_stints stints qualify."""
    fit = rows.loc[model.resid.index, ["Driver", "Compound", "Stint", "TyreLife"]].copy()
    fit["resid"] = model.resid.to_numpy(dtype=float)
    tl = dict(zip(tau["compound"].astype(str), tau["stint_tau_level_s"].astype(float)))
    ts = dict(zip(tau["compound"].astype(str), tau["stint_tau_slope"].astype(float)))
    hits, used = 0, 0
    for (d, _s), g in fit.groupby(["Driver", "Stint"], sort=True):
        c = str(g["Compound"].iloc[0])
        if len(g) < min_laps or c not in tl:
            continue
        n = len(g)
        s_age = float((g["TyreLife"].to_numpy(dtype=float) - 1.0).sum())
        sd = math.sqrt((n * tl[c]) ** 2 + (ts[c] * s_age) ** 2 + n * float(noise_sd.get(str(d), 0.0)) ** 2)
        used += 1
        hits += int(abs(float(g["resid"].sum())) <= 1.28 * sd)
    return hits / used if used >= min_stints else None


# ---------------------------------------------------------------------------
# fit_race orchestration -> SimFit (DB column names of §2.1 minus session_id/assumption_set_id)
# ---------------------------------------------------------------------------

RACE_PARAM_COLUMNS = [
    "total_laps", "ref_compound", "laps_fit", "drivers_fit", "r2", "resid_sd_s", "resid_mad_s", "design_cond",
    "evo_s_per_lap", "evo_se", "param_names", "param_mean", "param_chol", "field_delta_s", "field_delta_cars",
    "start_penalty_s", "pit_loss_s", "pit_loss_mad_s", "pit_loss_n", "pit_loss_samples_s", "sc_pit_samples_s",
    "vsc_pit_samples_s", "sc_pit_factor_race", "vsc_pit_factor_race", "stint_coverage_80",
    "n_sc_laps", "n_vsc_laps", "n_red_laps",
]
COMPOUND_PARAM_COLUMNS = [
    "compound", "laps", "age_max", "offset_s", "offset_se", "deg_raw_s_per_lap", "deg_s_per_lap", "deg_se",
    "deg_negative", "stint_tau_level_s", "stint_tau_slope", "stint_tau_source", "stints_used",
]
DRIVER_PARAM_COLUMNS = ["Driver", "laps_fit", "base_s", "base_se", "noise_sd_s", *CALIB_COLUMNS[1:]]
DRIVER_COMPOUND_COLUMNS = ["Driver", "compound", "laps", "dc_offset_s", "dc_se"]


def param_block(model: LapModel) -> tuple[list[str], list[float], list[float]]:
    """(param_names, param_mean, param_chol) of §2.1: the [off:*, deg:*, evo] sub-block of model.cov, the Cholesky
    factor of cov_theta + 1e-12 I flattened row-major, every value a plain Python float."""
    names = model.theta_names
    idx = [model.index[n] for n in names]
    cov = model.cov[np.ix_(idx, idx)]
    chol = np.linalg.cholesky(cov + 1e-12 * np.eye(len(idx)))
    return (list(names), [float(model.beta[i]) for i in idx], [float(v) for v in chol.ravel(order="C")])


def _driver_table(rows: pd.DataFrame, model: LapModel, noise: pd.Series, calib: pd.DataFrame) -> pd.DataFrame:
    """sim_driver_params (DRIVER_PARAM_COLUMNS): fit columns per driver with a dummy merged with calibrate()."""
    fit = rows.loc[model.resid.index]
    counts = fit["Driver"].value_counts()
    base = pd.DataFrame({
        "Driver": model.drivers,
        "laps_fit": [int(counts.get(d, 0)) for d in model.drivers],
        "base_s": [model.base(d) for d in model.drivers],
        "base_se": [float(model.se[model.index[f"base:{d}"]]) for d in model.drivers],
        "noise_sd_s": [float(noise[d]) for d in model.drivers],
    })
    out = base.merge(calib, on="Driver", how="left")
    return out[DRIVER_PARAM_COLUMNS]


def fit_race(fc_all: pd.DataFrame, lap_status: pd.DataFrame, pits: pd.DataFrame, stints: pd.DataFrame,
             results: pd.DataFrame, total_laps: int) -> SimFit:
    """Orchestrates everything above with the config constants; the only function frames.py calls.
    Raises SimNotEstimable per §1.12 (from fit_rows / fit_lap_model). Frames carry the §2.1 column names minus
    session_id/assumption_set_id ('Driver' codes instead of driver_id; frames.py resolves ids)."""
    cfg = config
    rows, comps, dropped = fit_rows(fc_all, cfg.SIM_MIN_COMPOUND_LAPS)
    warnings = [f"sim: {c} not parameterised ({n} fit rows < {cfg.SIM_MIN_COMPOUND_LAPS})"
                for c, n in sorted(dropped.items(), key=lambda cn: (-cn[1], cn[0]))]
    model = fit_lap_model(rows, evo_prior_sd=cfg.SIM_EVO_PRIOR_SD, resid_sd_guess=cfg.SIM_RESID_SD_GUESS,
                          min_driver_laps=cfg.SIM_MIN_DRIVER_LAPS)
    noise = driver_noise_sd(rows, model, cfg.SIM_NOISE_SD_FLOOR)
    dc = driver_compound_dev(rows, model, cfg.SIM_K_DC)
    tau = stint_scatter(rows, model, min_laps=cfg.SIM_STINT_MIN_LAPS, min_stints=cfg.SIM_STINT_MIN_STINTS,
                        priors=(cfg.SIM_STINT_TAU_LEVEL_PRIOR, cfg.SIM_STINT_TAU_SLOPE_PRIOR),
                        caps=(cfg.SIM_STINT_TAU_LEVEL_MAX, cfg.SIM_STINT_TAU_SLOPE_MAX))
    compound_params, cw = compound_table(rows, model, tau, deg_floor=cfg.SIM_DEG_FLOOR)
    warnings += cw
    for r in tau.itertuples(index=False):
        if r.stint_tau_source == "race" and (r.stint_tau_level_s >= cfg.SIM_STINT_TAU_LEVEL_MAX
                                             or r.stint_tau_slope >= cfg.SIM_STINT_TAU_SLOPE_MAX):
            warnings.append(f"sim: {r.compound} stint scatter capped (level {r.stint_tau_level_s:.3f}, "
                            f"slope {r.stint_tau_slope:.3f})")
    total = int(total_laps)
    deltas, n_cars = lap_deltas(fc_all, pits, model, dc, total, cfg.SIM_MIN_CARS_FOR_DELTA, lap_status)
    start = start_penalty(fc_all, model, dc)
    ex = pit_excess(fc_all, pits, lap_status, model, dc, deltas, model.compounds, delta_cars=n_cars,
                    min_cars=cfg.SIM_MIN_CARS_FOR_DELTA)
    pit = pit_loss(ex, min_green=cfg.SIM_MIN_GREEN_STOPS, min_sc=cfg.SIM_MIN_SC_STOPS,
                   samples_max=cfg.SIM_PIT_SAMPLES_MAX, factor_min=cfg.SIM_PIT_FACTOR_MIN,
                   factor_max=cfg.SIM_PIT_FACTOR_MAX)
    warnings += pit["warnings"]
    if pit["pit_loss_s"] is None:
        warnings.append(f"sim: pit loss not estimable ({pit['pit_loss_n']} green stops < {cfg.SIM_MIN_GREEN_STOPS}); "
                        f"calibration uses {POOLED_PIT_LOSS_FALLBACK_S} s")
    calib = calibrate(fc_all, stints, pits, lap_status, results, model, dc, deltas, start, pit, model.compounds,
                      min_modelled=cfg.SIM_MIN_MODELLED_LAPS)
    names, mean, chol = param_block(model)
    race = {
        "total_laps": total, "ref_compound": model.ref_compound, "laps_fit": int(len(model.resid)),
        "drivers_fit": int(len(model.drivers)), "r2": float(model.r2), "resid_sd_s": float(model.resid_sd),
        "resid_mad_s": float(model.resid_mad), "design_cond": float(model.design_cond),
        "evo_s_per_lap": float(model.evo), "evo_se": float(model.se[model.index["evo"]]),
        "param_names": names, "param_mean": mean, "param_chol": chol,
        "field_delta_s": deltas, "field_delta_cars": n_cars, "start_penalty_s": float(start),
        **{k: pit[k] for k in ("pit_loss_s", "pit_loss_mad_s", "pit_loss_n", "pit_loss_samples_s",
                               "sc_pit_samples_s", "vsc_pit_samples_s", "sc_pit_factor_race", "vsc_pit_factor_race")},
        "stint_coverage_80": stint_coverage(rows, model, tau, noise, min_laps=cfg.SIM_STINT_MIN_LAPS),
        **hazard_counts(lap_status),
    }
    race_params = pd.DataFrame([race], columns=RACE_PARAM_COLUMNS)
    return SimFit(race_params=race_params,
                  compound_params=compound_params[COMPOUND_PARAM_COLUMNS],
                  driver_params=_driver_table(rows, model, noise, calib),
                  driver_compound=dc[DRIVER_COMPOUND_COLUMNS],
                  warnings=warnings)


# ---------------------------------------------------------------------------
# §1.9 cross-season circuit hazard table (the only DB code in this module)
# ---------------------------------------------------------------------------

HAZARD_COLUMNS = [
    "circuit_key", "assumption_set_id", "recomputed_at", "races", "laps", "sc_episodes", "vsc_episodes",
    "sc_hazard", "vsc_hazard", "pit_loss_circuit_s", "pooled_races", "sc_hazard_pooled", "vsc_hazard_pooled",
    "sc_start_p", "vsc_start_p", "sc_dur_mean", "vsc_dur_mean", "pit_loss_pooled_s", "pit_loss_pooled_mad_s",
    "sc_pit_factor_pooled", "vsc_pit_factor_pooled",
]
# Used only when the DB holds no sim_race_params row / no episode at all (spec field history, §1.6/§1.9).
HAZARD_FALLBACKS = {"pit_loss_pooled_s": POOLED_PIT_LOSS_FALLBACK_S, "pit_loss_pooled_mad_s": 1.8,
                    "sc_dur_mean": 5.44, "vsc_dur_mean": 3.62}


def episodes(lap_status: pd.DataFrame) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """(sc, vsc) episodes of one race as (start_lap, length): maximal runs of consecutive lap numbers with
    worst_status '4' (SC) or '6'|'7' (VSC). Columns lap_number/worst_status (DB) or LapNumber/WorstStatus."""
    ln = lap_status["lap_number"] if "lap_number" in lap_status.columns else lap_status["LapNumber"]
    ws = lap_status["worst_status"] if "worst_status" in lap_status.columns else lap_status["WorstStatus"]
    seq = sorted(zip(pd.to_numeric(ln).astype(int), ws.astype(str)))
    out: dict[str, list[tuple[int, int]]] = {"sc": [], "vsc": []}
    cur_kind, start, prev = None, 0, -10
    for lap, st in seq:
        kind = "sc" if st in SC_CODES else "vsc" if st in VSC_CODES else None
        if kind is not None and kind == cur_kind and lap == prev + 1:
            prev = lap
            continue
        if cur_kind is not None:
            out[cur_kind].append((start, prev - start + 1))
        cur_kind, start, prev = kind, lap, lap
    if cur_kind is not None:
        out[cur_kind].append((start, prev - start + 1))
    return out["sc"], out["vsc"]


def _hazard_frame(races: pd.DataFrame, lap_status: pd.DataFrame, samples: pd.DataFrame,
                  assumption_set_id: int, prior_laps: int, now: dt.datetime) -> pd.DataFrame:
    """The sim_circuit_hazard rows (HAZARD_COLUMNS) from races (session_id, circuit_key), lap_status
    (session_id, lap_number, worst_status) and samples (session_id, pit_loss_samples_s, sc_pit_samples_s,
    vsc_pit_samples_s). Pure; recompute_hazards reads the tables and COPYs the result."""
    per: dict[int, dict] = {}
    for sid, g in lap_status.groupby("session_id"):
        sc, vsc = episodes(g)
        per[int(sid)] = {"laps3": int((pd.to_numeric(g["lap_number"]) >= 3).sum()), "sc": sc, "vsc": vsc}
    ep = {k: [e for sid in per for e in per[sid][k]] for k in ("sc", "vsc")}
    n_races = int(races["session_id"].nunique())
    laps3 = sum(v["laps3"] for v in per.values())
    pooled = {k: (sum(1 for s, _ in ep[k] if s >= 3) / laps3 if laps3 else 0.0) for k in ep}
    start_p = {k: (sum(1 for s, _ in ep[k] if s <= 2) / n_races if n_races else 0.0) for k in ep}
    dur = {k: (float(np.mean([n for _, n in ep[k]])) if ep[k] else HAZARD_FALLBACKS[f"{k}_dur_mean"]) for k in ep}
    green = np.array([v for col in samples["pit_loss_samples_s"] for v in (col or [])], dtype=float)
    scs = np.array([v for col in samples["sc_pit_samples_s"] for v in (col or [])], dtype=float)
    vscs = np.array([v for col in samples["vsc_pit_samples_s"] for v in (col or [])], dtype=float)
    pl = float(np.median(green)) if len(green) else HAZARD_FALLBACKS["pit_loss_pooled_s"]
    mad = float(np.median(np.abs(green - pl))) if len(green) else HAZARD_FALLBACKS["pit_loss_pooled_mad_s"]
    # Same plausibility band as the per-race factor (§1.7): a pooled factor outside it would be a
    # measurement failure, so fall back to the measured config prior rather than ship it.
    def _pooled_factor(sample: np.ndarray, prior: float) -> float:
        if not len(sample):
            return prior
        f = float(np.median(sample)) / pl
        return f if config.SIM_PIT_FACTOR_MIN <= f <= config.SIM_PIT_FACTOR_MAX else prior
    f_sc = _pooled_factor(scs, config.SIM_SC_PIT_FACTOR_PRIOR)
    f_vsc = _pooled_factor(vscs, config.SIM_VSC_PIT_FACTOR_PRIOR)
    by_sid = {int(r.session_id): r for r in samples.itertuples(index=False)}
    recs: list[dict] = []
    for ck, g in races.groupby("circuit_key"):
        sids = [int(s) for s in g["session_id"].unique()]
        l3 = sum(per.get(s, {"laps3": 0})["laps3"] for s in sids)
        k = {kind: sum(1 for s in sids for st, _ in per.get(s, {kind: []})[kind] if st >= 3) for kind in ("sc", "vsc")}
        cg = np.array([v for s in sids if s in by_sid for v in (by_sid[s].pit_loss_samples_s or [])], dtype=float)
        recs.append({"circuit_key": int(ck), "assumption_set_id": int(assumption_set_id), "recomputed_at": now,
                     "races": len(sids), "laps": int(l3), "sc_episodes": int(k["sc"]), "vsc_episodes": int(k["vsc"]),
                     "sc_hazard": (k["sc"] + prior_laps * pooled["sc"]) / (l3 + prior_laps),
                     "vsc_hazard": (k["vsc"] + prior_laps * pooled["vsc"]) / (l3 + prior_laps),
                     "pit_loss_circuit_s": float(np.median(cg)) if len(cg) >= 5 else None,
                     "pooled_races": n_races, "sc_hazard_pooled": pooled["sc"], "vsc_hazard_pooled": pooled["vsc"],
                     "sc_start_p": start_p["sc"], "vsc_start_p": start_p["vsc"],
                     "sc_dur_mean": dur["sc"], "vsc_dur_mean": dur["vsc"], "pit_loss_pooled_s": pl,
                     "pit_loss_pooled_mad_s": mad, "sc_pit_factor_pooled": f_sc, "vsc_pit_factor_pooled": f_vsc})
    return pd.DataFrame(recs, columns=HAZARD_COLUMNS)


def recompute_hazards(conn, assumption_set_id: int) -> int:
    """§1.9: DELETE + COPY sim_circuit_hazard for every circuit with an ok/partial race, in ONE committed block
    The CALLER wraps it in ingest._committed (§3.4); this function opens no transaction, so db.py is not touched.
    Reads lap_status, sessions, events, session_ingests, sim_race_params. Returns the row count."""
    from psycopg import sql  # local: keeps the module importable without a DB driver
    with conn.cursor() as cur:
        cur.execute(
            "SELECT s.session_id, e.circuit_key FROM sessions s "
            "JOIN events e ON e.year = s.year AND e.round = s.round "
            "JOIN session_ingests si ON si.session_id = s.session_id "
            "WHERE s.kind = 'R' AND si.status IN ('ok', 'partial') AND e.circuit_key IS NOT NULL "
            "ORDER BY s.session_id")
        races = pd.DataFrame(cur.fetchall(), columns=["session_id", "circuit_key"])
        sids = [int(s) for s in races["session_id"]]
        cur.execute("SELECT session_id, lap_number, worst_status FROM lap_status WHERE session_id = ANY(%s) "
                    "ORDER BY session_id, lap_number", (sids,))
        ls = pd.DataFrame(cur.fetchall(), columns=["session_id", "lap_number", "worst_status"])
        cur.execute("SELECT session_id, pit_loss_samples_s, sc_pit_samples_s, vsc_pit_samples_s "
                    "FROM sim_race_params WHERE session_id = ANY(%s)", (sids,))
        samples = pd.DataFrame(cur.fetchall(), columns=["session_id", "pit_loss_samples_s", "sc_pit_samples_s",
                                                        "vsc_pit_samples_s"])
        frame = _hazard_frame(races, ls, samples, int(assumption_set_id), config.SIM_PRIOR_SC_LAPS,
                              dt.datetime.now(dt.timezone.utc))
        cur.execute("DELETE FROM sim_circuit_hazard")
        if frame.empty:
            return 0
        stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
            sql.Identifier("sim_circuit_hazard"), sql.SQL(", ").join(sql.Identifier(c) for c in HAZARD_COLUMNS))
        n = 0
        with cur.copy(stmt) as copy:
            for row in frame.itertuples(index=False, name=None):
                copy.write_row(tuple(None if (isinstance(v, float) and math.isnan(v)) else v for v in row))
                n += 1
        return n
