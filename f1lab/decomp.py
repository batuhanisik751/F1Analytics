"""Mode 2 — the driver-vs-car pace decomposition (MODE2_SPEC §1, §2, §3, §5).

The pace model is live (WP2): ``load_rows``, ``build_components``, ``fit_reml``,
``bootstrap``, ``contrasts`` and ``recompute_rating`` compute and store the real fit.
The skill and constructor surfaces (``fit_grid_pace``, the two rejection reports,
``fit_hazard``, ``recompute_skills``, ``recompute_constructor``) are still stubs that
write their ``analytics_status`` key as ``empty``, so every Mode 2 surface that is not
yet built renders its ``EmptyState`` instead of throwing.

Measured on the live window, reproducing §1.3/§1.4/§1.6 exactly: 983 simulable race
rows -> 930 modelled, 28 drivers, 31 cells, 72 edges, 17 independent cycles, 4
components sized 15/9/2/2; tau_driver 0.265, tau_car 0.876, SD ratio 3.31.

Two facts about this feature that the implementations must not lose:

- The driver×cell mobility graph has **four disconnected components** (§1.4), not one.
  K3 (Aston) and K4 (McLaren) are floating islands: adding a constant to both McLaren
  drivers and subtracting it from all three McLaren cars leaves every fitted value
  unchanged, so the data contain **zero** information about that constant. Rows resting
  on the pooling prior carry ``basis = 'by-analogy'`` and are rendered differently from
  measured rows. There is no grid-wide rank, only ``rank_in_component``.
- Two of the four latent skills were measured and refused: tyre management is ~half car
  with a near-null driver signal (§3.3) and wet weather has effectively zero usable
  observations (§3.4). They ship as rows with ``measured = false`` and a stored reason,
  never as numbers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config, db, frames
from .sim import SimNotEstimable

log = logging.getLogger(__name__)

# The §1.3 exclusion vocabulary. Stored verbatim in mode2_row_audit.exclude_reason,
# so /driver can say *why* a round was not usable instead of silently dropping it.
REASON_LAPS = "laps_fit below MODE2_MIN_LAPS_FIT"
REASON_BADGE = "stage-1 badge 'poor'"
REASON_RACE = "race had fewer than MODE2_MIN_CARS_IN_RACE usable cars"

# The 90 % interval of §0.4, as the normal quantile the stored _lo/_hi columns use.
# 90, not 95, is a readability choice and is disclosed in every caption; it is never a
# licence to pick whichever band looks narrower, so it lives here as one constant.
_Z90: float = 1.6448536269514722

# contrasts() emits the full mode2_driver_contrast column contract, with fit_id and
# assumption_set_id as 0 placeholders that _contrast_frame stamps at write time -- so a
# caller can hand the frame straight to frames.cast_frame without knowing which columns
# are analysis and which are provenance.
CONTRAST_COLUMNS: tuple[str, ...] = (
    "fit_id", "assumption_set_id",
    "driver_a", "driver_b", "kind", "delta_pp", "delta_se", "delta_lo", "delta_hi",
    "same_component", "shared_cells", "n_shared_races", "n_races_a", "n_races_b",
)

# §1.4 component labels, used only as a fallback: a one-team component is labelled from
# its own cells (see _component_label), because "McLaren" is the honest name for a
# component whose level is the McLaren car's level plus an unknowable constant.
COMPONENT_LABELS: dict[str, str] = {
    "K1": "the main grid", "K2": "the Red Bull family",
    "K3": "Aston Martin", "K4": "McLaren",
}

# The §6.5 keys this module owns. decomp_points owns 'mode2_counterfactual'.
STATUS_KEYS: tuple[str, ...] = ("mode2_rating", "mode2_skills", "mode2_constructor")

# Every table decomp.py writes, in DDL order. Used by stored_is_complete.
RATING_TABLES: tuple[str, ...] = (
    "mode2_fit_run", "mode2_component", "mode2_driver_rating",
    "mode2_driver_rating_history", "mode2_driver_contrast", "mode2_row_audit",
)
SKILL_TABLES: tuple[str, ...] = ("mode2_driver_skill",)
CONSTRUCTOR_TABLES: tuple[str, ...] = ("mode2_car_rating", "mode2_car_hazard")


@dataclass(frozen=True)
class Mode2Fit:
    """One fitted decomposition (§7.2). Frozen so a fit cannot be mutated after use."""

    spec: str = config.MODE2_SPEC              # 'S' (ships) | 'C' (crossed, no slope)
    rows: pd.DataFrame = field(default_factory=lambda: frames.empty_frame("mode2_row_audit"))
    driver_ids: list[str] = field(default_factory=list)   # sorted; level order of delta
    cell_ids: list[str] = field(default_factory=list)     # sorted; "team_id|year"
    tau: dict[str, float] = field(default_factory=dict)   # tau_driver/car/slope, sigma_resid
    blup: np.ndarray = field(default_factory=lambda: np.empty(0))   # [delta | gamma | beta]
    cov: np.ndarray = field(default_factory=lambda: np.empty((0, 0)))  # A^-1 block (§2.1)
    components: dict[str, dict] = field(default_factory=dict)
    converged: bool = False
    fit_seconds: float = 0.0


DESIGN_COLUMNS: tuple[str, ...] = (
    "session_id", "year", "round", "driver_id", "team_id", "cell_id",
    "laps_fit", "badge", "base_s", "base_se", "y", "se", "u",
    "included", "exclude_reason",
)


def _empty_design() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="object") for c in DESIGN_COLUMNS})


def _prepare_design(raw: pd.DataFrame, assumption_set_id: int) -> pd.DataFrame:
    """Apply the §1.3 filter, then the §1.2 within-race centring, in that order."""
    df = raw.copy()
    df["cell_id"] = df["team_id"].astype(str) + "|" + df["year"].astype(int).astype(str)

    reason = pd.Series(pd.NA, index=df.index, dtype="object")
    reason[df["laps_fit"].astype(int) < config.MODE2_MIN_LAPS_FIT] = REASON_LAPS
    reason[df["badge"].isin(config.MODE2_EXCLUDE_BADGES)] = REASON_BADGE
    keep = reason.isna()

    # The race-level rule is applied to what survived the row rule, so a race is judged
    # on its usable cars, not its entry list.
    per_race = keep.groupby(df["session_id"]).transform("sum")
    too_small = keep & (per_race < config.MODE2_MIN_CARS_IN_RACE)
    reason[too_small] = REASON_RACE
    df["included"] = reason.isna()
    df["exclude_reason"] = reason

    # §1.2: m_r over the rows that survived the ROW rule, so a race dropped whole still
    # gets a y for its audit rows; for every modelled race the two sets are identical.
    centre = df.loc[keep, "base_s"].groupby(df.loc[keep, "session_id"]).mean()
    m = df["session_id"].map(centre)
    df["y"] = 100.0 * (df["base_s"] - m) / m
    df["se"] = 100.0 * df["base_se"] / m
    df["u"] = _season_progress(df)

    sets = sorted({int(v) for v in raw["input_asid"]})
    log.info("mode2 load_rows: %d simulable race rows -> %d modelled across %d drivers / "
             "%d cells / %d sessions; stamping asid=%d; stage-1 input sets present=%s",
             len(df), int(df["included"].sum()), df.loc[df["included"], "driver_id"].nunique(),
             df.loc[df["included"], "cell_id"].nunique(),
             df.loc[df["included"], "session_id"].nunique(), assumption_set_id, sets)
    return df[list(DESIGN_COLUMNS)].reset_index(drop=True)


def _season_progress(df: pd.DataFrame) -> pd.Series:
    """u_r = (round-1)/(rounds-1) - 0.5, in [-0.5, +0.5] (§1.3).

    ``rounds`` is the last round of that season **that is in the modelled window**, not
    the scheduled count: 2026 is complete only through R14 here, and scaling its slope
    against 24 scheduled rounds would report two thirds of a season's development as if
    it were the whole thing. What ``slope_pp`` means is therefore "across the racing we
    have", which is what §5.2's caption says.
    """
    last = df.loc[df["included"]].groupby("year")["round"].max()
    span = (df["year"].map(last).astype("float") - 1.0).replace(0.0, np.nan)
    u = (df["round"].astype(float) - 1.0) / span - 0.5
    return u.fillna(0.0)


def load_rows(conn, assumption_set_id: int) -> pd.DataFrame:
    """sim_driver_params ⋈ sessions ⋈ session_entries, race sessions, ORDER BY
    (year, round, driver_id). Returns every simulable row with ``included`` and
    ``exclude_reason`` already set by the §1.3 filter.

    The explicit ORDER BY is a correctness requirement, not tidiness: Postgres physical
    order changes after a --force re-ingest and row order changes float summation (§6.6).

    **The stage-1 input is NOT filtered by assumption_set_id, and that is deliberate.**
    ``sim_driver_params`` is keyed ``(session_id, driver_id)`` with no assumption set in
    the primary key, so the table physically cannot hold two competing versions of a
    row: the most recent ingest of a session wins outright and stamps its own
    ``assumption_set_id``. Filtering by one set therefore returns an arbitrary *subset*
    of the sessions -- whichever happened to be ingested under that set -- never a
    consistent window. Measured on the live DB: the union is 1,124 race rows across 58
    sessions (the §1.3 measured window), while the single largest per-set view is 1,084
    across 56, silently missing two 2024 races. ``assumption_set_id`` is used as the
    stamp on the rows this module *writes*, and the sets actually present in the input
    are logged so a mixed window is visible rather than silent.
    """
    sql = """
        SELECT s.session_id, s.year, s.round, p.driver_id, e.team_id,
               p.laps_fit, p.badge, p.base_s, p.base_se, p.assumption_set_id AS input_asid
        FROM sim_driver_params p
        JOIN sessions s        ON s.session_id = p.session_id
        JOIN session_entries e ON e.session_id = p.session_id AND e.driver_id = p.driver_id
        WHERE s.kind = 'R' AND p.simulable
        ORDER BY s.year, s.round, p.driver_id
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d.name for d in cur.description]
        rows = pd.DataFrame(cur.fetchall(), columns=cols)
    if rows.empty:
        return _empty_design()
    return _prepare_design(rows, int(assumption_set_id))


def build_components(rows: pd.DataFrame) -> dict[str, dict]:
    """The §1.4 bipartite driver×cell graph, via scipy.sparse.csgraph.connected_components.

    Component ids are K1..Kn in descending driver count, ties broken by the
    alphabetically first driver, so ids are stable across runs. The measured answer on
    the 2024–26 window is four components: K1 the main grid (15), K2 the Red Bull family
    (9), K3 Aston (2), K4 McLaren (2).
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    inc = rows[rows["included"]] if "included" in rows else rows
    drivers = sorted(set(inc["driver_id"]))
    cells = sorted(set(inc["cell_id"]))
    if not drivers:
        return {}
    di = {d: i for i, d in enumerate(drivers)}
    ci = {c: len(drivers) + i for i, c in enumerate(cells)}
    edges = sorted({(di[d], ci[c]) for d, c in zip(inc["driver_id"], inc["cell_id"])})
    n = len(drivers) + len(cells)
    rr = np.array([e[0] for e in edges])
    cc = np.array([e[1] for e in edges])
    adj = coo_matrix((np.ones(len(edges)), (rr, cc)), shape=(n, n))
    n_comp, labels = connected_components(adj, directed=False)

    groups: list[dict] = []
    for k in range(n_comp):
        ds = [d for d in drivers if labels[di[d]] == k]
        cs = [c for c in cells if labels[ci[c]] == k]
        if ds:
            groups.append({"drivers": ds, "cells": cs})
    # Descending driver count, ties broken by the alphabetically first driver, so the
    # ids are a stable contract across runs rather than a scipy labelling accident.
    groups.sort(key=lambda g: (-len(g["drivers"]), g["drivers"][0]))
    out: dict[str, dict] = {}
    for i, g in enumerate(groups, start=1):
        cid = f"K{i}"
        g["is_floating"] = len(g["drivers"]) < config.MODE2_MIN_COMPONENT_DRIVERS
        g["label"] = _component_label(cid, g["cells"])
        out[cid] = g
    log.info("mode2 components: %s", {k: len(v["drivers"]) for k, v in out.items()})
    return out


TEAM_LABELS: dict[str, str] = {
    "mclaren": "McLaren", "aston_martin": "Aston Martin", "red_bull": "Red Bull",
    "rb": "RB", "haas": "Haas", "kick_sauber": "Kick Sauber",
}


def _component_label(component_id: str, cells: list[str]) -> str:
    """Prefer a label derived from the data; fall back to the §1.4 names.

    A one-team component IS that team's island, and saying so is the whole point of the
    label. The fixed names are only a fallback for the two large components, so a future
    graph change cannot leave 'McLaren' attached to something that is not McLaren.
    """
    teams = {c.rsplit("|", 1)[0] for c in cells}
    if len(teams) == 1:
        t = next(iter(teams))
        return TEAM_LABELS.get(t, t.replace("_", " ").title())
    return COMPONENT_LABELS.get(component_id, f"component {component_id}")


class _Design:
    """The §1.3 design as plain arrays: y, the known SE floor, and the crossed Z.

    Z is built dense (930 x 90) on purpose. The whole point of §2.1's engine choice is
    that the reduced 91x91 system is small enough for exact dense algebra, so no part of
    this fit ever needs a sampler or an iterative solver.
    """

    __slots__ = ("y", "s2", "Z", "n", "k", "blocks", "driver_ids", "cell_ids", "spec")

    def __init__(self, rows: pd.DataFrame, spec: str):
        inc = rows[rows["included"]].reset_index(drop=True) if "included" in rows else rows
        self.spec = spec
        self.driver_ids = sorted(set(inc["driver_id"]))     # sorted(), never first-seen
        self.cell_ids = sorted(set(inc["cell_id"]))
        di = {d: i for i, d in enumerate(self.driver_ids)}
        ci = {c: i for i, c in enumerate(self.cell_ids)}
        n, nd, nc = len(inc), len(self.driver_ids), len(self.cell_ids)
        self.n, self.k = n, nd + nc + (nc if spec == "S" else 0)
        self.y = inc["y"].to_numpy(float)
        self.s2 = inc["se"].to_numpy(float) ** 2
        u = inc["u"].to_numpy(float)
        Z = np.zeros((n, self.k))
        ri = np.arange(n)
        Z[ri, [di[d] for d in inc["driver_id"]]] = 1.0
        cidx = np.array([ci[c] for c in inc["cell_id"]])
        Z[ri, nd + cidx] = 1.0
        if spec == "S":
            Z[ri, nd + nc + cidx] = u
        self.Z = Z
        self.blocks = ((0, nd), (nd, nd + nc), (nd + nc, self.k))


def _g_diag(d: _Design, tau: np.ndarray) -> np.ndarray:
    """The prior variance of each random effect, in level order."""
    g = np.empty(d.k)
    for (a, b), t in zip(d.blocks, tau):
        if b > a:
            g[a:b] = t ** 2
    return g


def _reml_nll(theta: np.ndarray, d: _Design) -> float:
    """Half the §2.1 REML criterion at log-scale variance components.

    Evaluated through the 91x91 reduced system, never the 930x930 V: with R diagonal,
    |V| = |G||R||Z'R^-1 Z + G^-1| and V^-1 x = Wx - WZ C^-1 Z'Wx exactly.
    """
    tau = np.exp(theta)
    if not np.all(np.isfinite(tau)):
        return 1e12
    w = 1.0 / (tau[-1] ** 2 + d.s2)
    g = _g_diag(d, tau)
    ZtW = d.Z.T * w
    C = ZtW @ d.Z + np.diag(1.0 / g)
    try:
        L = np.linalg.cholesky(C)
    except np.linalg.LinAlgError:
        return 1e12

    def vinv(x: np.ndarray) -> np.ndarray:
        t = np.linalg.solve(C, ZtW @ x)
        return w * x - w * (d.Z @ t)

    x = np.ones(d.n)
    xvx = float(x @ vinv(x))
    b = float(x @ vinv(d.y)) / xvx
    r = d.y - b
    logdet_v = float(-np.log(w).sum() + np.log(g).sum() + 2.0 * np.log(np.diag(L)).sum())
    return 0.5 * (logdet_v + float(r @ vinv(r)) + np.log(xvx))


def fit_reml(rows: pd.DataFrame, *, spec: str = "S",
             start: tuple[float, ...] = config.MODE2_REML_START) -> Mode2Fit:
    """REML fit of the §1.3 specification. Starts from a constant, never from data.

    ``start`` is ``config.MODE2_REML_START`` and is deliberately *not* derived from the
    data: a data-dependent start makes ``--force`` reruns only approximately identical,
    which §6.6's bit-identity contract does not allow.
    """
    import time

    from scipy.optimize import minimize

    t0 = time.perf_counter()
    d = _Design(rows, spec)
    if d.n == 0:
        return Mode2Fit(spec=spec)
    s = np.asarray(start, float)[: 4 if spec == "S" else 4].copy()
    if spec != "S":
        s[2] = 1.0  # unused; kept in the vector so the objective signature is fixed
    theta0 = np.log(s)
    opt = minimize(_reml_nll, theta0, args=(d,), method="Nelder-Mead",
                   options={"xatol": 1e-8, "fatol": 1e-10, "maxiter": 4000})
    # Nelder-Mead reports no gradient, and §2.6 gates on one, so it is measured here by
    # central differences at the solution and the simplex is restarted once from its own
    # answer -- the standard cure for a simplex that collapsed early.
    opt = minimize(_reml_nll, opt.x, args=(d,), method="Nelder-Mead",
                   options={"xatol": 1e-10, "fatol": 1e-12, "maxiter": 4000})
    tau = np.exp(opt.x)
    if spec != "S":
        tau[2] = 0.0
    grad = _numeric_grad(opt.x, d)
    converged = bool(opt.success) and float(np.max(np.abs(grad))) < 1e-4
    blup, cov = _blup(d, tau)
    fit_seconds = time.perf_counter() - t0
    log.info("mode2 fit_reml spec=%s: tau_driver=%.4f tau_car=%.4f tau_slope=%.4f "
             "sigma=%.4f grad_inf=%.2e nit=%d in %.2fs", spec, tau[0], tau[1], tau[2],
             tau[3], float(np.max(np.abs(grad))), int(opt.nit), fit_seconds)
    return Mode2Fit(
        spec=spec,
        rows=rows[rows["included"]].reset_index(drop=True) if "included" in rows else rows,
        driver_ids=d.driver_ids, cell_ids=d.cell_ids,
        tau={"tau_driver": float(tau[0]), "tau_car": float(tau[1]),
             "tau_slope": float(tau[2]), "sigma_resid": float(tau[3])},
        blup=blup, cov=cov,
        components=build_components(rows),
        converged=converged, fit_seconds=float(fit_seconds),
    )


def _numeric_grad(theta: np.ndarray, d: _Design, h: float = 1e-5) -> np.ndarray:
    """Central-difference gradient of the REML criterion, for the §2.6 gate."""
    g = np.zeros_like(theta)
    for i in range(len(theta)):
        a = theta.copy(); a[i] += h
        b = theta.copy(); b[i] -= h
        g[i] = (_reml_nll(a, d) - _reml_nll(b, d)) / (2 * h)
    return g


def _blup(d: _Design, tau: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Henderson's mixed-model equations (§2.1); returns (u_hat, A^-1 random block).

    The FULL inverse is returned, not just its diagonal, because every contrast in §2.5
    is a quadratic form c' A^-1 c against it. Differencing two marginal SDs instead is
    the mistake ``mode2_driver_contrast`` exists to make impossible.
    """
    w = 1.0 / (tau[-1] ** 2 + d.s2)
    g = _g_diag(d, tau)
    X = np.ones((d.n, 1))
    XtW, ZtW = X.T * w, d.Z.T * w
    A = np.block([[XtW @ X, XtW @ d.Z],
                  [ZtW @ X, ZtW @ d.Z + np.diag(1.0 / g)]])
    rhs = np.concatenate([XtW @ d.y, ZtW @ d.y])
    sol = np.linalg.solve(A, rhs)
    Ainv = np.linalg.inv(A)
    return sol[1:], Ainv[1:, 1:]


def bootstrap(fit: Mode2Fit, *, reps: int, n_jobs: int, seed: int) -> np.ndarray:
    """(reps × n_effects) parametric bootstrap draws (§2.3).

    Non-parametric / cluster resampling is forbidden here: it collapses the island
    widening that test_island_intervals_are_widest asserts. Each replicate draws from
    ``np.random.default_rng(seed + rep_index)`` so joblib scheduling cannot perturb it.

    Returns the **estimation error** ``u_hat* - u*`` of every effect, not the effect
    itself. That is what makes the island widening appear: for a two-driver component
    the refit shrinks ``u_hat*`` toward zero no matter what ``u*`` was, so the error is
    almost the whole simulated level and its SD is ~tau_driver. For a well-connected
    driver the same quantity is small because the data actually pin him. Resampling
    races instead cannot resample a transfer that never happened, produces the smallest
    errors exactly where the truth is least known, and is banned by §2.3.
    """
    full = _bootstrap_full(fit, reps=reps, n_jobs=n_jobs, seed=seed)
    return full[:, :fit.blup.shape[0]] if full.size else full


def _bootstrap_full(fit: Mode2Fit, *, reps: int, n_jobs: int, seed: int) -> np.ndarray:
    """``bootstrap`` plus the four refitted variance components per replicate.

    The tau columns are what ``mode2_fit_run.tau_*_lo/_hi`` and ``sd_ratio_lo/_hi`` are
    made of. They come from the same replicates as the effect errors rather than a
    second bootstrap, so the published car:driver ratio and the published driver bands
    can never disagree about how uncertain the variance components are.
    """
    from joblib import Parallel, delayed

    if fit.rows is None or len(fit.rows) == 0 or fit.blup.size == 0:
        return np.empty((0, 0))
    d = _Design(fit.rows, fit.spec)
    tau = np.array([fit.tau["tau_driver"], fit.tau["tau_car"],
                    fit.tau["tau_slope"], fit.tau["sigma_resid"]], float)
    out = Parallel(n_jobs=int(n_jobs), batch_size=8)(
        delayed(_boot_one)(d, tau, int(seed) + i) for i in range(int(reps)))
    return np.vstack([o for o in out if o is not None])


def _boot_one(d: _Design, tau: np.ndarray, seed: int) -> np.ndarray | None:
    """One parametric replicate: simulate from the fitted components, refit, return
    the BLUP error. Its rng is keyed on the replicate index, never on joblib order."""
    from scipy.optimize import minimize

    rng = np.random.default_rng(seed)
    g = _g_diag(d, tau)
    u_true = rng.normal(0.0, np.sqrt(g))
    eps = rng.normal(0.0, np.sqrt(tau[-1] ** 2 + d.s2))
    sim = _Design.__new__(_Design)
    for slot in _Design.__slots__:
        setattr(sim, slot, getattr(d, slot))
    sim.y = d.Z @ u_true + eps
    theta0 = np.log(np.where(tau > 0, tau, 1.0))
    opt = minimize(_reml_nll, theta0, args=(sim,), method="Nelder-Mead",
                   options={"xatol": 1e-7, "fatol": 1e-9, "maxiter": 2000})
    tau_star = np.exp(opt.x)
    if d.spec != "S":
        tau_star[2] = 0.0
    u_hat, _ = _blup(sim, tau_star)
    return np.concatenate([u_hat - u_true, tau_star])[None, :]


def fit_interaction(rows: pd.DataFrame, fit: Mode2Fit) -> float:
    """§1.7 — the driver x car-season interaction SD, PROFILED at the fitted tau's.

    67 of the 72 cells contain two or more races, so a cell mean is separable from
    within-cell race noise and this is estimable. It is fitted as a one-dimensional
    REML profile with tau_driver / tau_car / tau_slope / sigma held at their Spec-S
    values, not as a joint five-component refit: the joint fit trades interaction
    against residual almost freely at this signal level, and §4.4 wants a *scale* for
    the widening term, not a fifth headline estimate.

    This number is NOT evidence that drivers and cars add. It is a low-power test whose
    BLUPs are shrunk toward zero by construction, and §1.7 says so at length.
    """
    from scipy.optimize import minimize_scalar

    inc = rows[rows["included"]].reset_index(drop=True) if "included" in rows else rows
    if len(inc) == 0:
        return 0.0
    base = _Design(inc, fit.spec)
    pairs = sorted({(d, c) for d, c in zip(inc["driver_id"], inc["cell_id"])})
    pi = {p: i for i, p in enumerate(pairs)}
    Zi = np.zeros((base.n, len(pairs)))
    Zi[np.arange(base.n), [pi[(d, c)] for d, c in zip(inc["driver_id"], inc["cell_id"])]] = 1.0

    aug = _Design.__new__(_Design)
    for slot in _Design.__slots__:
        setattr(aug, slot, getattr(base, slot))
    aug.Z = np.hstack([base.Z, Zi])
    aug.k = base.k + len(pairs)
    aug.blocks = base.blocks + ((base.k, aug.k),)
    t = [fit.tau["tau_driver"], fit.tau["tau_car"], fit.tau["tau_slope"]]

    def nll(log_ti: float) -> float:
        return _reml_nll(np.log(np.array(t + [float(np.exp(log_ti)), fit.tau["sigma_resid"]])),
                         aug)

    res = minimize_scalar(nll, bounds=(np.log(1e-4), np.log(1.0)), method="bounded")
    tau_i = float(np.exp(res.x))
    log.info("mode2 tau_interaction: %.4f over %d driver-cell pairs (tau_driver=%.3f)",
             tau_i, len(pairs), fit.tau["tau_driver"])
    return tau_i


def raw_teammate_spread(rows: pd.DataFrame) -> float:
    """SD across drivers of their mean raw team-mate gap -- the §2.6 shrinkage yardstick.

    Unpooled, unshrunk, computed straight off y within each (session, cell): if the
    fitted delta spread is not smaller than this, the pooling prior is not doing its
    job and the fit must not ship.
    """
    inc = rows[rows["included"]] if "included" in rows else rows
    gaps: dict[str, list[float]] = {}
    for _, g in inc.groupby(["session_id", "cell_id"]):
        if len(g) < 2:
            continue
        ys = g["y"].to_numpy(float)
        ids = list(g["driver_id"])
        for i, d in enumerate(ids):
            others = np.delete(ys, i)
            gaps.setdefault(d, []).append(float(ys[i] - others.mean()))
    if len(gaps) < 2:
        return float("inf")
    return float(np.std([np.mean(v) for v in gaps.values()], ddof=1))


def level_sds(fit: Mode2Fit, draws: np.ndarray) -> dict[str, float]:
    """``sd_total`` per driver (§2.2), the quantity §7.6's interval-direction gate ranks.

    ``sd_total^2 = sd_within^2 + sd_island^2 + MODE2_SIGMA_SPEC^2``: measurement,
    assumption, and the §1.8 disagreement between two reasonable specifications.
    """
    parts = _level_uncertainty(fit, draws)
    return {d: float(v["sd_total"]) for d, v in parts.items()}


def _level_uncertainty(fit: Mode2Fit, draws: np.ndarray) -> dict[str, dict]:
    """Split each driver's bootstrap error into the §2.2 within/island parts."""
    nd = len(fit.driver_ids)
    err = draws[:, :nd]
    idx = {d: i for i, d in enumerate(fit.driver_ids)}
    out: dict[str, dict] = {}
    for comp in fit.components.values():
        cols = [idx[d] for d in comp["drivers"] if d in idx]
        if not cols:
            continue
        island = err[:, cols].mean(axis=1)              # the component's own offset
        sd_island = float(island.std(ddof=1))
        for d in comp["drivers"]:
            if d not in idx:
                continue
            within = err[:, idx[d]] - island
            sd_within = float(within.std(ddof=1))
            # sd_total is the MODEL's own uncertainty: measurement + assumption, and
            # nothing else. MODE2_SIGMA_SPEC is added on top when a LEVEL is published
            # (see _publish_sd), not folded in here. §2.2 states both the formula with
            # sigma_spec inside and the measured table -- norris 0.043 / 0.176 / 0.182
            # at frac_floating 94.3 % -- and only this reading reproduces the table, the
            # "+/-0.181" of §1.8 and §2.3, and the "94 % of it is assumption" copy.
            sd_total = float(np.hypot(sd_within, sd_island))
            out[d] = {"sd_within": sd_within, "sd_island": sd_island,
                      "sd_total": sd_total, "err": err[:, idx[d]],
                      "frac_floating": float(sd_island ** 2 / sd_total ** 2)
                      if sd_total > 0 else 0.0}
    return out


def contrasts(fit: Mode2Fit, draws: np.ndarray) -> pd.DataFrame:
    """Every team-mate pair that shared a cell, plus every cross-component pair the
    /was-it-the-car page can show. se = sqrt(cᵀ A⁻¹ c) ⊕ MODE2_SIGMA_SPEC_CONTRAST.

    This table exists so the web never differences two marginal intervals: the effects
    are strongly negatively correlated and the naive combination is ~twice too wide.

    ``draws`` is not decoration: the bootstrap SE of the same contrast is computed and
    compared to the quadratic form, and a disagreement is logged. Measured on the live
    window the two agree to 0.003 pp (norris-piastri 0.081 analytic vs 0.082 bootstrap),
    which is the evidence that the retained ``A^-1`` really is the posterior covariance.
    """
    if not fit.driver_ids or fit.cov.size == 0:
        return pd.DataFrame(columns=list(CONTRAST_COLUMNS))
    idx = {d: i for i, d in enumerate(fit.driver_ids)}
    comp_of = {d: k for k, v in fit.components.items() for d in v["drivers"]}
    rows = fit.rows
    cells = {d: set(g) for d, g in rows.groupby("driver_id")["cell_id"]}
    per_session = {sid: dict(zip(g["driver_id"], g["cell_id"]))
                   for sid, g in rows.groupby("session_id")}
    n_races = rows.groupby("driver_id").size().to_dict()
    has_draws = draws is not None and getattr(draws, "size", 0) > 0

    out = []
    ids = list(fit.driver_ids)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            shared = sorted(cells.get(a, set()) & cells.get(b, set()))
            c = np.zeros(fit.cov.shape[0])
            c[idx[a]], c[idx[b]] = 1.0, -1.0
            se_q = float(np.sqrt(max(c @ fit.cov @ c, 0.0)))
            if has_draws and draws.shape[0] >= 200:
                # Below ~200 replicates the bootstrap SE of a cross-island contrast is
                # itself noisy enough to trip this, so the cross-check only runs at the
                # replicate counts the shipping path actually uses.
                se_b = float((draws[:, idx[a]] - draws[:, idx[b]]).std(ddof=1))
                if se_q > 0 and abs(se_b - se_q) / se_q > 0.20:
                    log.warning("mode2 contrast %s-%s: quadratic form %.3f vs bootstrap "
                                "%.3f -- A^-1 and the bootstrap disagree", a, b, se_q, se_b)
            se = float(np.hypot(se_q, config.MODE2_SIGMA_SPEC_CONTRAST))
            delta = float(fit.blup[idx[a]] - fit.blup[idx[b]])
            n_shared = sum(1 for m in per_session.values()
                           if m.get(a) is not None and m.get(a) == m.get(b))
            out.append({
                "fit_id": 0, "assumption_set_id": 0,
                "driver_a": a, "driver_b": b,
                "kind": "teammate" if shared else "cross",
                "delta_pp": delta, "delta_se": se,
                "delta_lo": delta - _Z90 * se, "delta_hi": delta + _Z90 * se,
                "same_component": comp_of.get(a) == comp_of.get(b),
                "shared_cells": shared, "n_shared_races": int(n_shared),
                "n_races_a": int(n_races.get(a, 0)), "n_races_b": int(n_races.get(b, 0)),
            })
    df = pd.DataFrame(out, columns=list(CONTRAST_COLUMNS))
    log.info("mode2 contrasts: %d pairs (%d teammate, %d cross)", len(df),
             int((df["kind"] == "teammate").sum()), int((df["kind"] == "cross").sum()))
    return df


class _CrossedDesign:
    """A crossed random-effects design with an ARBITRARY number of grouping factors.

    ``_Design`` is the §1.3 design and nothing else: driver, car-cell, car-cell×progress.
    §3.2 needs two factors and no slope, §3.3 needs three (driver, car-cell,
    session×compound) and §5.3 needs two on the logit scale, so this is the same algebra
    with the level blocks supplied by the caller. It deliberately exposes the exact
    attribute names ``_reml_nll`` / ``_g_diag`` / ``_blup`` read, so the REML criterion
    of §2.1 is shared code rather than a second, subtly different implementation.
    """

    __slots__ = ("y", "s2", "Z", "n", "k", "blocks", "levels", "names")

    def __init__(self, y, s2, factors: list[tuple[str, list]]):
        self.y = np.asarray(y, float)
        self.s2 = np.asarray(s2, float)
        self.n = len(self.y)
        self.names = [name for name, _ in factors]
        self.levels = [sorted(set(map(str, codes))) for _, codes in factors]
        widths = [len(lv) for lv in self.levels]
        self.k = int(sum(widths))
        self.blocks = []
        Z = np.zeros((self.n, self.k))
        off = 0
        ri = np.arange(self.n)
        for (_, codes), lv, w in zip(factors, self.levels, widths):
            idx = {v: i for i, v in enumerate(lv)}
            Z[ri, off + np.array([idx[str(c)] for c in codes])] = 1.0
            self.blocks.append((off, off + w))
            off += w
        self.Z = Z

    def index(self, factor: str, level: str) -> int:
        """Column of ``blup`` / row of ``cov`` holding one level of one factor."""
        j = self.names.index(factor)
        return self.blocks[j][0] + self.levels[j].index(str(level))


def _blup_full(d, tau: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """``_blup`` keeping the intercept: (mu_hat, u_hat, full A^-1 with the intercept).

    §5.3 publishes ``expit(mu + eta_c)``, so the covariance between the intercept and a
    car effect is part of the published interval and cannot be dropped.
    """
    w = 1.0 / (tau[-1] ** 2 + d.s2)
    g = _g_diag(d, tau)
    X = np.ones((d.n, 1))
    XtW, ZtW = X.T * w, d.Z.T * w
    A = np.block([[XtW @ X, XtW @ d.Z], [ZtW @ X, ZtW @ d.Z + np.diag(1.0 / g)]])
    sol = np.linalg.solve(A, np.concatenate([XtW @ d.y, ZtW @ d.y]))
    return float(sol[0]), sol[1:], np.linalg.inv(A)


def _fit_crossed(d, start: tuple[float, ...], *, maxiter: int = 4000) -> dict:
    """REML fit of a ``_CrossedDesign``, by the §2.1 engine and the §2.1 restart.

    Returns tau (one per factor plus the residual), the BLUPs, the retained A^-1 and the
    convergence flag. The start is a caller-supplied constant for the same reason
    ``fit_reml``'s is: a data-dependent start makes a --force rerun only approximately
    identical (§6.6).
    """
    from scipy.optimize import minimize

    theta0 = np.log(np.asarray(start, float))
    opt = minimize(_reml_nll, theta0, args=(d,), method="Nelder-Mead",
                   options={"xatol": 1e-8, "fatol": 1e-10, "maxiter": maxiter})
    opt = minimize(_reml_nll, opt.x, args=(d,), method="Nelder-Mead",
                   options={"xatol": 1e-10, "fatol": 1e-12, "maxiter": maxiter})
    tau = np.exp(opt.x)
    mu, blup, ainv = _blup_full(d, tau)
    grad = float(np.max(np.abs(_numeric_grad(opt.x, d))))
    return {"tau": tau, "mu": mu, "blup": blup, "cov": ainv[1:, 1:], "ainv": ainv,
            "converged": bool(opt.success) and grad < 1e-4, "grad": grad}


GRID_SQL = """
    SELECT s.session_id, s.year, r.driver_id, e.team_id, r.grid_position
    FROM results r
    JOIN sessions s        ON s.session_id = r.session_id
    JOIN session_entries e ON e.session_id = r.session_id AND e.driver_id = r.driver_id
    WHERE s.kind = 'R' AND r.grid_position IS NOT NULL AND r.grid_position > 0
    ORDER BY s.year, s.round, r.driver_id
"""


def fit_grid_pace(conn, assumption_set_id: int, components: dict) -> pd.DataFrame:
    """The grid-pace skill (§3.2). Never labelled "one-lap pace" in any fan-facing string.

    CORRECTED in v1.8 (GAPFILL_SPEC §2.4). The old sentence here -- "there are no
    qualifying sessions in this schema, so the only one-lap signal is where the car
    started" -- was true at §3.0 and is false as of v1.6: ``quali_segment_times``
    carries segment times for **77** sessions (71 ``kind = 'Q'`` + 18 ``kind = 'SQ'``
    exist; 77 of those 89 are ingested), and 56 of them now feed the measured skill
    fitted by ``fit_one_lap_pace``.
    This surface survives anyway because the pre-registered retirement test did not
    fire: r = 0.8393 over all 28 drivers, 0.8663 over the 24 non-island drivers
    (§1.6 prints the latter as 0.8670; this code measures 0.8663 -- see WP-A1's report),
    against a threshold of ``config.MODE2_GRID_RETIRE_R`` = 0.95 (§1.6, §2.1). What
    this function measures is **where the car started** -- gearbox penalties, pit-lane
    starts and sprint-weekend grids included -- which is a different quantity from a
    lap time, and that is exactly why it keeps its own key, its own unit and its own
    caption slot, and is never given the other skill's name.

    Grid position is converted to a within-race normal score
    ``z = Phi^-1((grid - 0.5)/N_r)`` and fed to the same crossed model as §1.3 with NO
    development slope: an ordinal response cannot support one, because the scale itself
    caps how far apart two cars can get.

    The scale is **not** comparable to race pace and the two are never plotted on a
    shared axis (§3.2). ``anchor_class`` is the mobility graph's, so the four island
    drivers are floating here too -- their comfortable ``evidence_share`` is an artefact
    of this model's much smaller tau_car/tau_driver ratio and must never style anything.
    """
    from scipy.stats import norm

    with conn.cursor() as cur:
        cur.execute(GRID_SQL)
        cols = [d.name for d in cur.description]
        raw = pd.DataFrame(cur.fetchall(), columns=cols)
    keep = {d for c in components.values() for d in c["drivers"]}
    if raw.empty or not keep:
        return frames.empty_frame("mode2_driver_skill")
    raw["cell_id"] = raw["team_id"].astype(str) + "|" + raw["year"].astype(int).astype(str)
    n_r = raw.groupby("session_id")["driver_id"].transform("size").to_numpy(float)
    raw["z"] = norm.ppf((raw["grid_position"].to_numpy(float) - 0.5) / n_r)
    dropped = raw[~raw["driver_id"].isin(keep)]
    if len(dropped):
        log.info("mode2 grid pace: dropping %d rows for %d drivers outside the pace fit",
                 len(dropped), dropped["driver_id"].nunique())
    rows = raw[raw["driver_id"].isin(keep)].reset_index(drop=True)

    d = _CrossedDesign(rows["z"], np.zeros(len(rows)),
                       [("driver", rows["driver_id"]), ("cell", rows["cell_id"])])
    res = _fit_crossed(d, (0.45, 0.50, 0.64))
    tau = res["tau"]
    log.info("mode2 grid pace: %d rows / %d sessions / %d drivers -- tau_driver=%.3f "
             "tau_car=%.3f sigma=%.3f converged=%s", len(rows),
             rows["session_id"].nunique(), rows["driver_id"].nunique(),
             tau[0], tau[1], tau[2], res["converged"])

    drivers = d.levels[0]
    est = np.array([res["blup"][d.index("driver", x)] for x in drivers])
    se = np.array([float(np.sqrt(max(res["cov"][d.index("driver", x),
                                     d.index("driver", x)], 0.0))) for x in drivers])
    n_obs = rows.groupby("driver_id").size().to_dict()
    comp_of = {x: (cid, c) for cid, c in components.items() for x in c["drivers"]}
    n_teams = rows.groupby("driver_id")["team_id"].nunique().to_dict()
    out = []
    for i, x in enumerate(drivers):
        cid, comp = comp_of[x]
        ac = _anchor_class(x, comp, int(n_teams.get(x, 0)))
        out.append({
            "fit_id": 0, "assumption_set_id": int(assumption_set_id), "driver_id": x,
            "skill": "grid_pace", "measured": True,
            "value": float(est[i]),
            "value_lo": float(est[i] - _Z90 * se[i]),
            "value_hi": float(est[i] + _Z90 * se[i]),
            "unit": "normal_score",
            "evidence_share": float(1.0 - (se[i] ** 2) / tau[0] ** 2) if tau[0] > 0 else 0.0,
            "anchor_class": ac,
            "pct_field_below": _pct_field_below(est, i, ac),
            "not_measured_reason": None, "n_obs": int(n_obs.get(x, 0)),
        })
    return frames.cast_frame(pd.DataFrame(out).sort_values("driver_id"),
                             "mode2_driver_skill")


def _pct_field_below(values: np.ndarray, i: int, anchor_class: str) -> float | None:
    """Percent of the field this driver is ahead of. Negative = faster, so "below" is a
    LARGER value. Reported per skill and never pooled across skills (§3.2).

    ``None`` for a ``floating`` driver, and that is the point (§1.5 item 1, §8.4 rule 2).
    A percent-of-the-field is an ordinal placement of this driver's LEVEL against all 28,
    and the 28 span four disconnected components: for Norris, Piastri, Alonso and Stroll
    the level is the pooling prior's, not the data's, so the placement is a statement
    about a quantity §1.4 says the window contains zero information about. Storing NULL
    rather than filtering it in TypeScript keeps the grid-wide claim out of the database
    as well as off the page (§6.1's structural guard); the DDL already allows NULL, and
    the two refused skills already use it.
    """
    if str(anchor_class) == "floating":
        return None
    v = np.asarray(values, float)
    if len(v) < 2:
        return 0.0
    return float(100.0 * (v > v[i]).sum() / (len(v) - 1))


# --- GAPFILL_SPEC §1 -- Gap A: the measured one-lap (qualifying) skill ------
#
# The response is §1.1's V3: segment 1 only, session-mean-centred percent. Five other
# responses were fitted and rejected; the two that matter are recorded in the spec and
# not re-litigated here. The engine is the same ``_CrossedDesign`` / ``_fit_crossed``
# REML path as §1.3 and §3.2, so the three skills are one implementation.
#
# SQ rows are pulled deliberately even though §1.8 excludes them from the fit: the
# "What we could not measure" panel reads its reason out of mode2_quali_row_audit
# rather than out of a hard-coded TypeScript string, so the exclusion has to be a
# stored row with a reason, not an absent row.
QUALI_SQL = """
    SELECT s.session_id, s.year, s.round, s.kind, q.driver_id, e.team_id,
           q.best_s, q.verified, q.wet_compound
    FROM quali_segment_times q
    JOIN sessions s        ON s.session_id = q.session_id
    JOIN session_entries e ON e.session_id = q.session_id AND e.driver_id = q.driver_id
    WHERE q.segment = %s AND s.kind IN ('Q', 'SQ')
    ORDER BY s.year, s.round, s.kind, q.driver_id
"""

# DDL order of mode2_quali_row_audit (migration 0009, §2.2). frames.TABLE_COLUMNS is
# WP-S1's file; until its entry lands, cast_frame/copy_frame raise KeyError on this
# table, so the audit is written through db.copy_rows against this list and switches
# to the frames contract automatically the moment WP-S1 adds it.
QUALI_AUDIT_COLUMNS = [
    "fit_id", "assumption_set_id", "session_id", "driver_id", "team_id", "year",
    "round", "kind", "included", "exclude_reason", "y_pp", "best_s",
]

# The exclusion vocabulary of §1.1 + §1.8. The CHECK on the table only enforces
# "included OR exclude_reason IS NOT NULL", so the vocabulary is pinned here and by
# test rather than by the database.
QUALI_EXCLUDE_REASONS = (
    "sprint_qualifying_excluded",      # §1.8 / D3 -- kind = 'SQ'
    "no_segment_1_time",               # best_s IS NULL
    "segment_time_not_verified",       # NOT verified
    "wet_compound",                    # D1: dry rows only
    "session_below_min_drivers",       # fewer than MODE2_QUALI_MIN_DRIVERS
    "driver_not_in_pace_fit",          # same rule as fit_grid_pace
)


def _quali_design(conn, assumption_set_id: int, components: dict) -> dict:
    """§1.1's V3 response, plus the audit frame that records every row it did not use.

    Returns ``{"rows": included rows with y_pp, "audit": every segment-1 row}``.

    The centring mean ``m_s`` is taken over **every** driver with a usable segment-1
    time in that session, not over the component-mapped subset: §1.1's stratum-
    completeness rule (R3) says within-stratum centring absorbs the session constant
    exactly only if the whole stratum is retained, so the field mean is computed
    before the component filter drops anyone, never after.
    """
    with conn.cursor() as cur:
        cur.execute(QUALI_SQL, (int(config.MODE2_QUALI_SEGMENT),))
        cols = [d.name for d in cur.description]
        raw = pd.DataFrame(cur.fetchall(), columns=cols)
    if raw.empty:
        return {"rows": raw, "audit": pd.DataFrame(columns=QUALI_AUDIT_COLUMNS)}

    raw["best_s"] = pd.to_numeric(raw["best_s"], errors="coerce")
    raw["cell_id"] = raw["team_id"].astype(str) + "|" + raw["year"].astype(int).astype(str)
    keep = {d for c in components.values() for d in c["drivers"]}

    reason = pd.Series([None] * len(raw), index=raw.index, dtype=object)

    def _mark(mask, why: str) -> None:
        reason.loc[mask & reason.isna()] = why

    _mark(~raw["kind"].isin(config.MODE2_QUALI_KINDS), "sprint_qualifying_excluded")
    _mark(raw["best_s"].isna(), "no_segment_1_time")
    _mark(~raw["verified"].astype(bool), "segment_time_not_verified")
    _mark(raw["wet_compound"].astype(bool), "wet_compound")

    # The field of the stratum: everything that survives the row filters, component
    # membership not yet consulted. m_s and the minimum-drivers test both read this.
    field = raw[reason.isna()]
    n_field = field.groupby("session_id")["driver_id"].size()
    thin = set(n_field[n_field < int(config.MODE2_QUALI_MIN_DRIVERS)].index)
    _mark(raw["session_id"].isin(thin), "session_below_min_drivers")

    field = raw[reason.isna()]
    m_s = field.groupby("session_id")["best_s"].mean()
    y = 100.0 * (raw["best_s"] - raw["session_id"].map(m_s)) / raw["session_id"].map(m_s)
    raw["y_pp"] = y

    _mark(~raw["driver_id"].isin(keep), "driver_not_in_pace_fit")
    raw["exclude_reason"] = reason
    raw["included"] = reason.isna()
    raw.loc[~raw["included"], "y_pp"] = np.nan

    rows = raw[raw["included"]].reset_index(drop=True)
    dropped = raw[raw["exclude_reason"] == "driver_not_in_pace_fit"]
    if len(dropped):
        log.info("mode2 one-lap: dropping %d rows for %d drivers outside the pace fit",
                 len(dropped), dropped["driver_id"].nunique())
    log.info("mode2 one-lap: audit %d rows, %d included, reasons %s", len(raw),
             int(raw["included"].sum()),
             raw["exclude_reason"].value_counts(dropna=True).to_dict())
    return {"rows": rows, "audit": raw}


def quali_components(conn, assumption_set_id: int, components: dict) -> dict[str, dict]:
    """GATE G2 (§6.3): the mobility graph rebuilt on QUALIFYING ROWS ALONE.

    §1.4's whole answer in one call. A qualifying session carries the same
    ``session_entries`` as its own race, so qualifying adds rows, not edges -- and the
    component count must come back 4, member-for-member identical to the race graph.
    This is asserted by ``assert_quali_islands_hold``, which fails the RUN.
    """
    rows = _quali_design(conn, assumption_set_id, components)["rows"]
    if rows.empty:
        return {}
    return build_components(rows[["driver_id", "cell_id", "included"]])


# The rendered label of the measured qualifying skill, pinned here so the Python guard
# has something to assert against. The fit is on Q1 ALONE, which is narrower than a
# lap, so the label is the session's name and never the phrase the surrogate is
# forbidden to use -- see test_mode2_skills.py's mirror guard.
ONE_LAP_LABEL = "Qualifying pace"
ONE_LAP_FORBIDDEN_LABELS = ("One-lap pace", "One lap pace", "Starting-grid pace")


def assert_quali_islands_hold(quali: dict, race: dict) -> None:
    """GATE G2 (§6.3, §1.4). Fails the RUN, not the page.

    Qualifying adds rows, not edges: identification comes from drivers changing team
    and nobody changed team between Saturday and Sunday. If the qualifying-only graph
    ever disagrees with the race graph, either the corpus really did gain a transfer --
    in which case the island captions are now false and a human must re-read §1.4 --
    or the join is wrong. Both are build-stopping.
    """
    def members(g: dict) -> set[frozenset[str]]:
        return {frozenset(c["drivers"]) for c in g.values()}

    if len(quali) != len(race) or members(quali) != members(race):
        raise SimNotEstimable(
            f"gate G2: the qualifying-only mobility graph has {len(quali)} components "
            f"against the race graph's {len(race)}, or differs in membership. §1.4 "
            f"pins 4, member-for-member identical. quali="
            f"{ {k: sorted(v['drivers']) for k, v in quali.items()} }")


def one_lap_pace_report(conn, assumption_set_id: int, components: dict) -> dict:
    """The §1.3 one-lap fit: skill frame, audit frame and the diagnostics §1.5 pins.

    y_sd = delta_d + gamma_c(d,s) + eps_sd on the segment-1 session-centred percent of
    §1.1. Same engine, same cell definition (``team_id|year``), same pooling discipline
    as §1.3, and NO development slope (§3.5 already rules out a per-season rating and
    §3.2 fits without one too).

    There is no per-row standard error and that is structural: race pace feeds a
    stage-1 ``s_rd`` in as a known heteroskedastic floor, but a qualifying best lap is
    a single extremum, not an average, so ``s_sd = 0`` on every row and sigma_eps
    absorbs it. The tau_driver of the two skills are therefore not exactly like-for-
    like (§0.2 final bullet, C-SKILL-5).
    """
    des = _quali_design(conn, assumption_set_id, components)
    rows, audit = des["rows"], des["audit"]
    if rows.empty:
        return {"skill": frames.empty_frame("mode2_driver_skill"), "audit": audit,
                "n_rows": 0, "n_sessions": 0, "n_drivers": 0, "converged": False,
                "tau_driver": 0.0, "tau_car": 0.0, "sigma_eps": 0.0, "est": {}}

    d = _CrossedDesign(rows["y_pp"], np.zeros(len(rows)),
                       [("driver", rows["driver_id"]), ("cell", rows["cell_id"])])
    res = _fit_crossed(d, tuple(config.MODE2_QUALI_REML_START))
    tau = res["tau"]
    n_sessions = int(rows["session_id"].nunique())
    log.info("mode2 one-lap pace: %d rows / %d sessions / %d drivers -- "
             "tau_driver=%.4f tau_car=%.4f sigma=%.4f converged=%s", len(rows),
             n_sessions, rows["driver_id"].nunique(), tau[0], tau[1], tau[2],
             res["converged"])

    drivers = d.levels[0]
    est = np.array([res["blup"][d.index("driver", x)] for x in drivers])
    se = np.array([float(np.sqrt(max(res["cov"][d.index("driver", x),
                                     d.index("driver", x)], 0.0))) for x in drivers])
    n_obs = rows.groupby("driver_id").size().to_dict()
    comp_of = {x: c for c in components.values() for x in c["drivers"]}
    n_teams = rows.groupby("driver_id")["team_id"].nunique().to_dict()
    out = []
    for i, x in enumerate(drivers):
        ac = _anchor_class(x, comp_of[x], int(n_teams.get(x, 0)))
        out.append({
            "fit_id": 0, "assumption_set_id": int(assumption_set_id), "driver_id": x,
            "skill": "one_lap_pace", "measured": True,
            "value": float(est[i]),
            "value_lo": float(est[i] - _Z90 * se[i]),
            "value_hi": float(est[i] + _Z90 * se[i]),
            "unit": "pp",
            "evidence_share": float(1.0 - (se[i] ** 2) / tau[0] ** 2) if tau[0] > 0 else 0.0,
            "anchor_class": ac,
            "pct_field_below": _pct_field_below(est, i, ac),
            "not_measured_reason": None, "n_obs": int(n_obs.get(x, 0)),
        })
    skill = frames.cast_frame(pd.DataFrame(out).sort_values("driver_id"),
                              "mode2_driver_skill")
    return {"skill": skill, "audit": audit, "n_rows": int(len(rows)),
            "n_sessions": n_sessions, "n_drivers": int(len(drivers)),
            "converged": bool(res["converged"]), "tau_driver": float(tau[0]),
            "tau_car": float(tau[1]), "sigma_eps": float(tau[2]),
            "est": dict(zip(drivers, est.tolist()))}


def fit_one_lap_pace(conn, assumption_set_id: int, components: dict) -> pd.DataFrame:
    """§1.3's measured qualifying skill as ``mode2_driver_skill`` rows.

    The named entry point of §2.4, beside ``fit_grid_pace``. ``one_lap_pace_report``
    is the same fit with the audit frame and the §1.5 diagnostics attached.
    """
    return one_lap_pace_report(conn, assumption_set_id, components)["skill"]


TYRE_SQL = """
    SELECT d.session_id, s.year, d.driver_id, d.team_id, d.compound, d.laps,
           d.deg_s_per_lap, d.deg_std_err
    FROM degradation_fits d
    JOIN sessions s ON s.session_id = d.session_id
    WHERE s.kind = 'R'
    ORDER BY d.session_id, d.driver_id, d.stint
"""


def tyre_rejection_report(conn, assumption_set_id: int) -> dict:
    """§3.3 — MEASURED AND REFUSED. Tyre management is ~half car with a near-null driver
    signal, so it ships as a ``measured = false`` row with a reason, not as a number.
    An evidence_share above MODE2_TYRE_REJECT_THRESHOLD means the refusal no longer
    holds and the build must fail rather than quietly resurrect the skill.

    Three fits and one moment test, because the refusal has to survive the obvious
    objection that it is an artefact of the specification:

    * ``primary`` — §3.3's fit: per-stint slopes with ``deg_std_err`` carried into the
      residual and a session×compound control. This is the honest one and its
      ``tau_driver`` is ~0.
    * ``naive`` — the same design with the per-stint standard error *dropped*. This is
      the mistake §3.3 names: measurement noise is then absorbed as driver skill and a
      large driver share appears out of nothing.
    * ``driver_only`` — driver effects with no car and no session control at all.
    * the moment test — between-driver SD against the within-driver standard error of
      the mean, with the chi-square that goes with it.
    """
    from scipy import stats

    with conn.cursor() as cur:
        cur.execute(TYRE_SQL)
        cols = [c.name for c in cur.description]
        raw = pd.DataFrame(cur.fetchall(), columns=cols)
    if raw.empty:
        return {"n_rows": 0, "n_rows_all": 0, "refused": True}
    raw["cell_id"] = raw["team_id"].astype(str) + "|" + raw["year"].astype(int).astype(str)
    raw["sc"] = raw["session_id"].astype(str) + "|" + raw["compound"].astype(str)
    r = raw[(raw["laps"] >= 8) & (raw["deg_std_err"] > 0)
            & (raw["deg_std_err"] < 0.15)].reset_index(drop=True)
    y = r["deg_s_per_lap"].to_numpy(float)
    s2 = r["deg_std_err"].to_numpy(float) ** 2
    fac3 = [("driver", r["driver_id"]), ("cell", r["cell_id"]), ("sc", r["sc"])]

    primary = _fit_crossed(_CrossedDesign(y, s2, fac3), (0.003, 0.005, 0.02, 0.04),
                           maxiter=600)
    naive = _fit_crossed(_CrossedDesign(y, np.zeros(len(r)), fac3),
                         (0.003, 0.005, 0.02, 0.04), maxiter=600)
    donly = _CrossedDesign(y, np.zeros(len(r)), [("driver", r["driver_id"])])
    driver_only = _fit_crossed(donly, (0.005, 0.04), maxiter=600)

    dp = _CrossedDesign(y, s2, fac3)
    nd = len(dp.levels[0])
    tau_d = float(primary["tau"][0])
    ev = (1.0 - np.diag(primary["cov"])[:nd] / tau_d ** 2) if tau_d > 1e-9 else np.zeros(nd)
    share = lambda t: float(t[0] ** 2 / np.sum(np.asarray(t, float) ** 2))  # noqa: E731
    rank_corr = float(stats.spearmanr(naive["blup"][:nd], driver_only["blup"]).statistic)
    rank_corr_primary = float(
        stats.spearmanr(primary["blup"][:nd], driver_only["blup"]).statistic)

    # The independent moment test: no prior and no pooling, only the two-way adjustment
    # without which it is a test of who raced where. A stint's slope is compared to its
    # own car-season and its own session x compound, and each driver's adjusted mean is
    # weighted by the noise that stint actually carries (per-stint SE + residual).
    adj = y - primary["mu"]
    for name in ("cell", "sc"):
        j = dp.names.index(name)
        a, b = dp.blocks[j]
        adj = adj - dp.Z[:, a:b] @ primary["blup"][a:b]
    sig2 = s2 + float(primary["tau"][3]) ** 2
    frame = pd.DataFrame({"driver_id": r["driver_id"], "adj": adj, "w": 1.0 / sig2})
    gb = frame.groupby("driver_id")
    means = gb.apply(lambda f: float((f["adj"] * f["w"]).sum() / f["w"].sum()),
                     include_groups=False)
    sem = 1.0 / np.sqrt(gb["w"].sum())
    counts = gb.size()
    between = float(means.std(ddof=1))
    within = float(np.sqrt((sem ** 2).mean()))
    chi2 = float((((means - means.mean()) / sem) ** 2).sum())
    out = {
        "n_rows": int(len(r)), "n_rows_all": int(len(raw)), "n_drivers": nd,
        "n_sess_compound": int(len(dp.levels[2])),
        "tau_driver": tau_d, "tau_car": float(primary["tau"][1]),
        "tau_sess_compound": float(primary["tau"][2]),
        "sigma_resid": float(primary["tau"][3]),
        "driver_share": share(primary["tau"]),
        "tau_driver_naive": float(naive["tau"][0]),
        "driver_share_naive": share(naive["tau"]),
        "rank_corr_naive_vs_driver_only": rank_corr,
        "rank_corr_primary_vs_driver_only": rank_corr_primary,
        "max_evidence_share": float(np.max(ev)) if nd else 0.0,
        "min_evidence_share": float(np.min(ev)) if nd else 0.0,
        "between_driver_sd": between, "within_driver_sem": within,
        "chi2": chi2, "df": int(nd - 1),
        "p_value": float(stats.chi2.sf(chi2, nd - 1)),
        "mean_slope": float(y.mean()), "mean_std_err": float(r["deg_std_err"].mean()),
        "median_std_err": float(r["deg_std_err"].median()),
        "mean_std_err_all": float(raw["deg_std_err"].mean()),
        "median_std_err_all": float(raw["deg_std_err"].median()),
        "stints_per_driver": {k: int(v) for k, v in counts.items()},
        "evidence_share": {x: float(ev[i]) for i, x in enumerate(dp.levels[0])},
        "refused": True,
    }
    log.info("mode2 tyre rejection: %d rows tau_driver=%.5f tau_car=%.5f sigma=%.4f "
             "max_evidence=%.3f chi2=%.1f/%d p=%.3f (naive share %.1f%%)", out["n_rows"],
             out["tau_driver"], out["tau_car"], out["sigma_resid"],
             out["max_evidence_share"], chi2, out["df"], out["p_value"],
             100 * out["driver_share_naive"])
    return out


WET_COMPOUNDS: tuple[str, ...] = ("INTERMEDIATE", "WET")

WET_SQL = """
    SELECT s.session_id, s.year, s.round,
           COALESCE(w.frac_rain, 0)      AS frac_rain,
           COALESCE(l.wet_laps, 0)       AS wet_laps,
           COALESCE(p.simulable_rows, 0) AS simulable_rows
    FROM sessions s
    LEFT JOIN (SELECT session_id, AVG(CASE WHEN rainfall THEN 1.0 ELSE 0.0 END) frac_rain
               FROM weather_samples GROUP BY session_id) w ON w.session_id = s.session_id
    LEFT JOIN (SELECT session_id, COUNT(*) wet_laps FROM laps
               WHERE is_representative AND compound = ANY(%s)
               GROUP BY session_id) l ON l.session_id = s.session_id
    LEFT JOIN (SELECT session_id, COUNT(*) simulable_rows FROM sim_driver_params
               WHERE simulable GROUP BY session_id) p ON p.session_id = s.session_id
    WHERE s.kind = 'R'
    ORDER BY s.year, s.round
"""


def wet_rejection_report(conn, assumption_set_id: int) -> dict:
    """§3.4 — MEASURED AND REFUSED. Not thin: effectively zero usable observations.

    The count of rainy races was never the problem, so this does not count them. It
    counts the intersection: races with real wet-tyre running that ALSO have usable
    fuel-corrected pace estimates. v1.1 refuses every wet race outright (``rain race``),
    for the correct reason that changing conditions break the fuel correction, so in the
    currency this feature is denominated in the answer is exactly zero.

    It also counts the wet running that *does* exist, because a caption claiming named
    drivers have no wet laps would be false: 26 of 28 have some (§3.4).
    """
    with conn.cursor() as cur:
        cur.execute(WET_SQL, (list(WET_COMPOUNDS),))
        cols = [c.name for c in cur.description]
        df = pd.DataFrame(cur.fetchall(), columns=cols)
        cur.execute("SELECT l.driver_id, COUNT(*) FROM laps l JOIN sessions s "
                    "ON s.session_id = l.session_id WHERE s.kind = 'R' "
                    "AND l.is_representative AND l.compound = ANY(%s) "
                    "GROUP BY 1 ORDER BY 2 DESC", (list(WET_COMPOUNDS),))
        per_driver = {str(k): int(v) for k, v in cur.fetchall()}
    if df.empty:
        return {"usable_wet_rows": 0, "refused": True}
    for c in ("frac_rain", "wet_laps", "simulable_rows"):
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    wet = df[df["wet_laps"] > 0]
    rain = df[df["frac_rain"] > 0]
    # §3.0's own threshold for a race that was actually wet, rather than one with a
    # handful of damp samples. It gates a COUNT in a report, never a published estimate,
    # which is why it lives here and not in the §7.3 assumption hash.
    heavy = rain[rain["frac_rain"] >= 0.15]
    out = {
        "n_race_sessions": int(len(df)),
        "n_sessions_any_rain": int(len(rain)),
        "n_sessions_rain_over_15pct": int((df["frac_rain"] >= 0.15).sum()),
        "n_sessions_with_wet_running": int(len(wet)),
        "wet_representative_laps": int(df["wet_laps"].sum()),
        # THE number: races with wet-tyre running AND usable pace estimates.
        "usable_wet_rows": int(wet["simulable_rows"].sum()),
        "n_sessions_rain_with_usable_rows": int((heavy["simulable_rows"] > 0).sum()),
        "slick_rain_sessions": [f"{int(r.year)} R{int(r.round)}" for r in heavy.itertuples()
                                if r.wet_laps == 0 and r.simulable_rows > 0],
        "n_drivers_with_wet_running": int(len(per_driver)),
        "wet_laps_per_driver": per_driver,
        "sessions": [{"year": int(r.year), "round": int(r.round),
                      "frac_rain": round(float(r.frac_rain), 3),
                      "wet_laps": int(r.wet_laps),
                      "simulable_rows": int(r.simulable_rows)}
                     for r in rain.itertuples()],
        "refused": True,
    }
    log.info("mode2 wet rejection: %d sessions with wet running (%d representative laps), "
             "%d usable pace rows in them; %d rain-flagged sessions have usable rows and "
             "ran on slicks (%s)", out["n_sessions_with_wet_running"],
             out["wet_representative_laps"], out["usable_wet_rows"],
             out["n_sessions_rain_with_usable_rows"], ", ".join(out["slick_rain_sessions"]))
    return out


HAZARD_SQL = """
    SELECT e.team_id, s.year, r.driver_id,
           COUNT(*) FILTER (WHERE r.status = 'Retired')      AS retirements,
           COALESCE(SUM(r.laps_completed), 0)                AS racing_laps
    FROM results r
    JOIN sessions s        ON s.session_id = r.session_id
    JOIN session_entries e ON e.session_id = r.session_id AND e.driver_id = r.driver_id
    WHERE s.kind = 'R'
    GROUP BY e.team_id, s.year, r.driver_id
    ORDER BY s.year, e.team_id, r.driver_id
"""


def fit_hazard(conn, assumption_set_id: int) -> pd.DataFrame:
    """Retirement hazard per team-season (§5.3). Never called "reliability".

    A per-lap hazard, not a DNF percentage, so a car that breaks on lap 3 and one that
    breaks on lap 50 are not scored alike. Numerator and denominator are both race-only
    and the numerator is ``status = 'Retired'`` alone: ``Did not start`` is excluded
    because a DNS never ran the laps in the denominator.

    The split into a car and a driver component is the point (§5.3): ``results.status``
    has no mechanical-vs-accident vocabulary anywhere in the schema, so a raw hazard on a
    *constructor* page silently charges a driver's crashes to the car. The estimator is
    the two-way random-effects logistic hazard of §5.3, fitted on the per-(car-season,
    driver) empirical logit with its exact binomial variance carried as the known SE --
    the same REML engine as §2.1, on the logit scale.
    """
    from scipy.special import expit
    from scipy.stats import beta

    with conn.cursor() as cur:
        cur.execute(HAZARD_SQL)
        cols = [c.name for c in cur.description]
        cd = pd.DataFrame(cur.fetchall(), columns=cols)
    if cd.empty:
        return frames.empty_frame("mode2_car_hazard")
    cd["retirements"] = cd["retirements"].astype(int)
    cd["racing_laps"] = cd["racing_laps"].astype(int)
    cd = cd[cd["racing_laps"] > 0].reset_index(drop=True)
    cd["cell_id"] = cd["team_id"].astype(str) + "|" + cd["year"].astype(int).astype(str)

    k = cd["retirements"].to_numpy(float)
    n = cd["racing_laps"].to_numpy(float)
    y = np.log((k + 0.5) / (n - k + 0.5))
    s2 = 1.0 / (k + 0.5) + 1.0 / (n - k + 0.5)
    d = _CrossedDesign(y, s2, [("cell", cd["cell_id"]), ("driver", cd["driver_id"])])
    res = _fit_crossed(d, (0.5, 0.4, 0.3), maxiter=2000)
    mu, ainv = res["mu"], res["ainv"]
    log.info("mode2 hazard: %d car-driver cells, tau_car=%.3f tau_driver=%.3f "
             "sigma=%.3f converged=%s", len(cd), res["tau"][0], res["tau"][1],
             res["tau"][2], res["converged"])

    g = cd.groupby(["team_id", "year"], as_index=False)[["retirements", "racing_laps"]].sum()
    out = []
    for r in g.itertuples(index=False):
        cell = f"{r.team_id}|{int(r.year)}"
        j = d.index("cell", cell) + 1                      # +1: ainv keeps the intercept
        a = np.zeros(ainv.shape[0]); a[0] = 1.0; a[j] = 1.0
        eta = mu + float(res["blup"][j - 1])
        se = float(np.sqrt(max(a @ ainv @ a, 0.0)))
        kk, nn = int(r.retirements), int(r.racing_laps)
        out.append({
            "fit_id": 0, "assumption_set_id": int(assumption_set_id),
            "team_id": str(r.team_id), "year": int(r.year),
            "retirements": kk, "racing_laps": nn,
            "hazard_per_1000": 1000.0 * kk / nn,
            "hazard_lo": 1000.0 * float(beta.ppf(0.05, kk + 0.5, nn - kk + 0.5)),
            "hazard_hi": 1000.0 * float(beta.ppf(0.95, kk + 0.5, nn - kk + 0.5)),
            "hazard_car_only": 1000.0 * float(expit(eta)),
            "hazard_car_lo": 1000.0 * float(expit(eta - _Z90 * se)),
            "hazard_car_hi": 1000.0 * float(expit(eta + _Z90 * se)),
            "rank_in_season": 0,
            "sufficient": nn >= int(config.MODE2_MIN_HAZARD_LAPS),
        })
    df = pd.DataFrame(out)
    # Within-season only (§5.3): 2026 is a regulation reset and its hazard is more than
    # double 2024's, so a cross-season rank would be a rank of the era.
    df["rank_in_season"] = (df.groupby("year")["hazard_per_1000"]
                            .rank(method="min").astype(int))
    return frames.cast_frame(df.sort_values(["year", "team_id"]), "mode2_car_hazard")


def model_version(rows: pd.DataFrame, spec: str) -> str:
    """sha256(raced sessions || the §7.3 constants || spec)[:16] (§6.6).

    Keyed on the sessions that actually RACED and passed the §1.3 filter, so 2026's
    scheduled-but-unraced rounds do not perturb it and a rerun after an empty week is
    correctly a no-op.
    """
    import hashlib
    import json

    inc = rows[rows["included"]] if "included" in rows else rows
    sessions = sorted({(int(y), int(r)) for y, r in zip(inc["year"], inc["round"])})
    consts = {n: getattr(config, n) for n in sorted(dir(config))
              if n.startswith("MODE2_")}
    payload = json.dumps({"sessions": sessions, "constants": consts, "spec": spec},
                         sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def stored_is_complete(conn, fit_id: int) -> bool:
    """True iff every table that hangs off this fit has at least one row (§6.6).

    ALL TWELVE, the points tables included: a run that died after the constructor step
    must be retried, not declared done, and the §6.6 skip is the only thing standing
    between a half-written fit and a driver page that silently loses its career section.
    """
    from . import decomp_points

    tables = (RATING_TABLES[1:] + SKILL_TABLES + CONSTRUCTOR_TABLES
              + tuple(getattr(decomp_points, "POINTS_TABLES", ())))
    with conn.cursor() as cur:
        for table in tables:
            cur.execute(f"SELECT 1 FROM {table} WHERE fit_id = %s LIMIT 1", (int(fit_id),))
            if cur.fetchone() is None:
                return False
    return True


def write_status(conn, key: str, value: str) -> int:
    """Merge one §6.5 key onto every race session's ``analytics_status``.

    Mode 2 is cross-race, so it is not in ``frames.ANALYTICS`` and must write its own
    key from the run-end step, exactly as ``circuit_odi`` and ``preview`` do (§5.5).
    """
    from . import preview

    with conn.cursor() as cur:
        cur.execute("SELECT s.session_id FROM sessions s "
                    "JOIN session_ingests si ON si.session_id = s.session_id "
                    "WHERE s.kind = 'R' AND si.status <> 'failed'")
        ids = [int(r[0]) for r in cur.fetchall()]
    return preview.write_status(conn, key, {sid: value for sid in ids})


def _anchor_class(driver: str, comp: dict, n_teams: int) -> str:
    """§2.4's third diagnostic. Graph-derived, so it is IDENTICAL on every skill surface.

    ``evidence_share`` deliberately is not the badge: on the grid-pace model the four
    island drivers score 0.724 -- apparently well identified -- while holding the four
    widest posterior SEs on the grid, purely because tau_car/tau_driver is ~1.1 there
    instead of ~3.3. Badging on it would hatch Norris on one skill and not the next.

    ``n_teams`` counts distinct TEAMS, not cells: every driver who raced all three
    seasons has three (team, season) cells without having moved anywhere, and §2.4's
    measured list puts Verstappen -- three Red Bull cells, one team -- in
    ``component-anchored``. What earns ``anchored`` is a transfer, nothing else.
    """
    if comp["is_floating"]:
        return "floating"
    return "anchored" if n_teams >= 2 else "component-anchored"


def _audit_frame(rows: pd.DataFrame, fit_id: int, asid: int) -> pd.DataFrame:
    """Every simulable race row, kept or dropped, with the reason it was dropped.

    This is what lets /driver say "3 of Sainz's 24 rounds were not usable" instead of
    quietly modelling 21 and calling it a career.
    """
    a = rows.rename(columns={"y": "y_pp", "se": "se_pp"}).copy()
    a["fit_id"] = fit_id
    a["assumption_set_id"] = asid
    return frames.cast_frame(a[list(frames.EXPECTED_COLUMNS["mode2_row_audit"])],
                             "mode2_row_audit")


def _component_frame(components: dict, fit_id: int, asid: int) -> pd.DataFrame:
    out = [{"fit_id": fit_id, "assumption_set_id": asid, "component_id": cid,
            "label": c["label"], "n_drivers": len(c["drivers"]), "n_cells": len(c["cells"]),
            "is_floating": bool(c["is_floating"]), "driver_ids": list(c["drivers"]),
            "cell_ids": list(c["cells"])}
           for cid, c in sorted(components.items())]
    return frames.cast_frame(pd.DataFrame(out), "mode2_component")


def _publish_interval(est: float, u: dict) -> tuple[float, float]:
    """The published 5th/95th of a LEVEL (§2.3).

    The shape is the bootstrap's own: the pivot is ``delta_hat - error`` and the
    percentiles are empirical. The width is then rescaled so the interval's SD is
    ``hypot(sd_total, MODE2_SIGMA_SPEC)`` -- that is how §2.3's "specification
    uncertainty added in quadrature on every published level" enters, without throwing
    away the asymmetry the bootstrap actually found. The contrast tables use
    MODE2_SIGMA_SPEC_CONTRAST (0.04) instead, because §1.8 measured the two at very
    different sizes and applying the level term to a team-mate gap would inflate it from
    +/-0.083 to +/-0.13, contradicting the measurement that makes gaps trustworthy.
    """
    sd_boot = float(u["err"].std(ddof=1))
    if sd_boot <= 0:
        return est, est
    scale = float(np.hypot(u["sd_total"], config.MODE2_SIGMA_SPEC)) / sd_boot
    return (est - scale * float(np.percentile(u["err"], 95)),
            est - scale * float(np.percentile(u["err"], 5)))


def _rating_frame(fit: Mode2Fit, rows: pd.DataFrame, draws: np.ndarray,
                  fit_id: int, asid: int) -> pd.DataFrame:
    """One row per driver: the level, its §2.2 split, and the §2.4 diagnostics.

    The interval is the bootstrap's own 5th/95th percentile of the pivot
    ``delta_hat - error``, rescaled so its SD is exactly the stored ``sd_total`` -- which
    is how MODE2_SIGMA_SPEC enters a published level without discarding the shape of
    the bootstrap distribution.
    """
    unc = _level_uncertainty(fit, draws)
    tau_d2 = fit.tau["tau_driver"] ** 2
    comp_of = {d: (cid, c) for cid, c in fit.components.items() for d in c["drivers"]}
    inc = rows[rows["included"]]
    n_races = inc.groupby("driver_id").size().to_dict()
    n_cells = inc.groupby("driver_id")["cell_id"].nunique().to_dict()
    n_teams = inc.groupby("driver_id")["team_id"].nunique().to_dict()
    n_excl = rows[~rows["included"]].groupby("driver_id").size().to_dict()

    out = []
    for i, d in enumerate(fit.driver_ids):
        cid, comp = comp_of[d]
        u = unc[d]
        est = float(fit.blup[i])
        lo, hi = _publish_interval(est, u)
        cells_d = int(n_cells.get(d, 0))
        out.append({
            "fit_id": fit_id, "assumption_set_id": asid, "driver_id": d,
            "rating_pp": est, "rating_lo": lo, "rating_hi": hi,
            "sd_within": u["sd_within"], "sd_island": u["sd_island"],
            "sd_total": u["sd_total"], "frac_floating": u["frac_floating"],
            "evidence_share": float(1.0 - fit.cov[i, i] / tau_d2),
            "anchor_class": _anchor_class(d, comp, int(n_teams.get(d, 0))),
            "basis": "by-analogy" if comp["is_floating"] else "measured",
            "component_id": cid, "rank_in_component": 0,
            "n_races": int(n_races.get(d, 0)), "n_cells": cells_d,
            "n_races_excluded": int(n_excl.get(d, 0)),
        })
    df = pd.DataFrame(out)
    # The ONLY rank in this schema (§6.1): fastest first, WITHIN a component. A grid-wide
    # rank across four disconnected components is the exact falsehood this feature exists
    # to avoid, and the DDL makes it unrepresentable.
    df["rank_in_component"] = (df.groupby("component_id")["rating_pp"]
                               .rank(method="min").astype(int))
    return frames.cast_frame(df.sort_values("driver_id"), "mode2_driver_rating")


def recompute_rating(conn, assumption_set_id: int, *, force: bool = False) -> dict:
    """WP2. Writes mode2_fit_run / _component / _driver_rating / _driver_rating_history
    / _driver_contrast / _row_audit and the ``mode2_rating`` status key.

    §6.6 lifecycle: a fit already stored under this ``(assumption_set_id,
    model_version)`` whose rating tables are populated is returned as
    ``{"skipped": True}`` unless ``force``; otherwise everything is written inside ONE
    transaction, ``is_current`` is flipped in that same transaction, and old fits are
    pruned to ``MODE2_KEEP_FITS``.
    """
    import time

    asid = int(assumption_set_id)
    rows = load_rows(conn, asid)
    if rows.empty or not bool(rows["included"].any()):
        n = write_status(conn, "mode2_rating", "empty")
        return {t: 0 for t in RATING_TABLES} | {"sessions_marked": n, "empty": True}

    spec = config.MODE2_SPEC
    mv = model_version(rows, spec)
    prior = _find_fit(conn, asid, mv)
    if prior is not None and not force and _rating_is_complete(conn, prior):
        log.info("mode2 recompute_rating: fit %d already complete at version %s", prior, mv)
        return {"skipped": True, "fit_id": prior, "model_version": mv}

    fit = fit_reml(rows, spec=spec)
    if not fit.converged:
        raise SimNotEstimable("mode2 fit did not converge")
    t0 = time.perf_counter()
    full = _bootstrap_full(fit, reps=config.MODE2_BOOTSTRAP_REPS,
                           n_jobs=config.MODE2_BOOTSTRAP_JOBS, seed=config.MODE2_SEED)
    boot_seconds = time.perf_counter() - t0
    draws = full[:, :fit.blup.shape[0]]
    return _write_rating(conn, asid, rows, fit, full, draws, mv, boot_seconds)


def fit_current(conn, assumption_set_id: int) -> Mode2Fit:
    """The Spec-S fit of the current window, with no bootstrap. ~0.7 s.

    ``recompute_all`` needs a real ``Mode2Fit`` to hand to ``recompute_skills`` and
    ``recompute_constructor``, and ``recompute_rating`` cannot return one through a dict
    that ``companion`` logs. This is the seam: fit once more (the fit is 0.3 s; it is the
    400-replicate bootstrap that costs minutes, and that is not repeated here).
    """
    return fit_reml(load_rows(conn, int(assumption_set_id)), spec=config.MODE2_SPEC)


def _find_fit(conn, asid: int, mv: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT fit_id FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND model_version = %s", (asid, mv))
        row = cur.fetchone()
    return int(row[0]) if row else None


def _rating_is_complete(conn, fit_id: int) -> bool:
    """Every table WP2 owns has at least one row for this fit (the §6.6 test, narrowed
    to the rating tables so a missing skill table does not force a refit of the model)."""
    with conn.cursor() as cur:
        for table in RATING_TABLES[1:]:
            cur.execute(f"SELECT 1 FROM {table} WHERE fit_id = %s LIMIT 1", (int(fit_id),))
            if cur.fetchone() is None:
                return False
    return True


def interval_direction_ok(rating: pd.DataFrame) -> bool:
    """§2.6 — the four ``floating`` drivers must hold the widest bands, NOT the narrowest.

    Compared against the well-observed half of the grid rather than the whole of it, and
    the reason is measured, not a convenience: Doohan has 5 modelled races and a
    ``sd_total`` of 0.208 pp, which is within noise of Alonso's 0.211 on 43 races. Both
    are badly identified, for opposite reasons -- Doohan because we barely saw him,
    Alonso because we saw him 43 times in the same car. Ranking the islands against a
    five-race rookie tests sample size, not identifiability. Ranking them against every
    driver with at least the median number of races tests exactly the inversion §2.3
    exists to prevent, and a race-cluster bootstrap or a fixed-effects fit still fails
    it by a mile (norris would come out at 0.050-0.095 against verstappen's 0.124+).
    """
    if rating.empty:
        return False
    cut = float(rating["n_races"].median())
    floating = rating["anchor_class"] == "floating"
    # The median cut drops badly-SAMPLED drivers from the comparison set; it must never
    # drop a badly-IDENTIFIED one, because those are the drivers the gate is about. An
    # island driver who misses half a season (a mid-season Aston or McLaren replacement)
    # used to leave `seen` while `islands` kept him, so the two sides were sized
    # differently and the equality could not hold at all -- the gate then failed closed
    # and aborted the run on data whose identifiability had not changed.
    seen = rating[(rating["n_races"] >= cut) | floating]
    islands = set(rating.loc[floating, "driver_id"])
    if not islands or len(seen) <= len(islands):
        return False
    widest = set(seen.sort_values("sd_total", ascending=False)
                 .head(len(islands))["driver_id"])
    return widest == islands


def _switch_years(rows: pd.DataFrame) -> set[tuple[str, int]]:
    """(driver, year) pairs where the driver's team is not the team of the year before,
    or where he drove for two teams inside the one year."""
    inc = rows[rows["included"]]
    by = {(d, int(y)): set(g) for (d, y), g in inc.groupby(["driver_id", "year"])["team_id"]}
    out: set[tuple[str, int]] = set()
    for (d, y), teams in by.items():
        prev = by.get((d, y - 1))
        if len(teams) > 1 or (prev and not (teams & prev)):
            out.add((d, y))
    return out


def _history_frame(rows: pd.DataFrame, fit_id: int, asid: int) -> pd.DataFrame:
    """§3.5 — LEAVE-FUTURE-OUT CUMULATIVE refits, one per season, never a per-season refit.

    Each point is a full fit on everything up to the end of that season, with its own
    bootstrap band at MODE2_HISTORY_BOOTSTRAP_REPS. A per-season refit is not estimable
    (§1.5: the driver x season graph has 28 components) and is forbidden.

    **The band NARROWS at a team switch and that is the point of the chart.** A transfer
    is the only event that adds identifying information, so Hamilton's 2025 point is much
    tighter than his 2024 one; Norris, Piastri, Alonso and Stroll stay flat and wide
    across all three seasons because more racing in the same car narrows nothing.
    """
    inc = rows[rows["included"]]
    years = sorted({int(y) for y in inc["year"]})
    switched = _switch_years(rows)
    out = []
    for y in years:
        upto = rows[rows["year"].astype(int) <= y]
        if not bool(upto["included"].any()):
            continue
        hfit = fit_reml(upto, spec=config.MODE2_SPEC)
        hdraws = bootstrap(hfit, reps=config.MODE2_HISTORY_BOOTSTRAP_REPS,
                           n_jobs=config.MODE2_BOOTSTRAP_JOBS, seed=config.MODE2_SEED)
        unc = _level_uncertainty(hfit, hdraws)
        comp_of = {d: c for c in hfit.components.values() for d in c["drivers"]}
        hinc = upto[upto["included"]]
        n_cum = hinc.groupby("driver_id").size().to_dict()
        n_teams = hinc.groupby("driver_id")["team_id"].nunique().to_dict()
        for i, d in enumerate(hfit.driver_ids):
            u = unc[d]
            est = float(hfit.blup[i])
            hlo, hhi = _publish_interval(est, u)
            out.append({
                "fit_id": fit_id, "assumption_set_id": asid, "driver_id": d,
                "through_year": y, "rating_pp": est,
                "rating_lo": hlo, "rating_hi": hhi,
                "sd_total": u["sd_total"],
                "anchor_class": _anchor_class(d, comp_of[d], int(n_teams.get(d, 0))),
                "n_races_cumulative": int(n_cum.get(d, 0)),
                "switched_this_year": (d, y) in switched,
            })
        log.info("mode2 history: through %d -> %d drivers, %d components",
                 y, len(hfit.driver_ids), len(hfit.components))
    df = pd.DataFrame(out).sort_values(["driver_id", "through_year"])
    return frames.cast_frame(df, "mode2_driver_rating_history")


def _fit_run_row(fit: Mode2Fit, rows: pd.DataFrame, full: np.ndarray, rating: pd.DataFrame,
                 mv: str, asid: int, boot_seconds: float) -> dict:
    """The one row every other Mode 2 row hangs off, diagnostics included (§2.6)."""
    import datetime as dt

    k = fit.blup.shape[0]
    taus = full[:, k:] if full.shape[1] > k else np.empty((0, 4))
    lo, hi = (5.0, 95.0)

    def pct(col: np.ndarray, q: float) -> float:
        return float(np.percentile(col, q)) if col.size else 0.0

    ratio = taus[:, 1] / taus[:, 0] if taus.size else np.empty(0)
    inc = rows[rows["included"]]
    spread_fitted = float(np.std(fit.blup[:len(fit.driver_ids)], ddof=1))
    spread_raw = raw_teammate_spread(rows)
    shrinkage_ok = spread_fitted < spread_raw
    dir_ok = interval_direction_ok(rating)
    if not shrinkage_ok:
        raise SimNotEstimable(
            f"shrinkage check failed: sd(delta_hat)={spread_fitted:.3f} is not below the "
            f"raw team-mate spread {spread_raw:.3f}")
    if not dir_ok:
        raise SimNotEstimable(
            "interval direction check failed: the floating drivers do not hold the "
            "widest bands among well-observed drivers -- see §2.3, this is the "
            "cluster-bootstrap / fixed-effects inversion")
    return {
        "assumption_set_id": asid, "model_version": mv, "spec": fit.spec,
        "n_rows": int(len(inc)), "n_rows_excluded": int((~rows["included"]).sum()),
        "n_drivers": len(fit.driver_ids), "n_cells": len(fit.cell_ids),
        "n_sessions": int(inc["session_id"].nunique()), "n_components": len(fit.components),
        "tau_driver": fit.tau["tau_driver"], "tau_car": fit.tau["tau_car"],
        "tau_slope": fit.tau["tau_slope"], "sigma_resid": fit.tau["sigma_resid"],
        "tau_driver_lo": pct(taus[:, 0], lo) if taus.size else fit.tau["tau_driver"],
        "tau_driver_hi": pct(taus[:, 0], hi) if taus.size else fit.tau["tau_driver"],
        "tau_car_lo": pct(taus[:, 1], lo) if taus.size else fit.tau["tau_car"],
        "tau_car_hi": pct(taus[:, 1], hi) if taus.size else fit.tau["tau_car"],
        # An SD ratio, never a variance ratio: the variance ratio is 11 and a fan reads
        # "11x" as "the car matters eleven times more", three times the truth (§1.6).
        "sd_ratio": fit.tau["tau_car"] / fit.tau["tau_driver"],
        "sd_ratio_lo": pct(ratio, lo), "sd_ratio_hi": pct(ratio, hi),
        "tau_interaction": fit_interaction(rows, fit),
        "sigma_spec": float(config.MODE2_SIGMA_SPEC),
        "ci_level": float(config.MODE2_CI_LEVEL),
        "bootstrap_reps": int(full.shape[0]),
        "converged": bool(fit.converged), "shrinkage_ok": bool(shrinkage_ok),
        "interval_dir_ok": bool(dir_ok), "fit_seconds": float(fit.fit_seconds),
        "bootstrap_seconds": float(boot_seconds), "is_current": True,
        "fitted_at": dt.datetime.now(dt.timezone.utc),
        # v1.8 (2026-09-17). These three are filled by _write_fit_run_correlations AFTER the
        # one_lap_pace fit runs, because they are correlations BETWEEN skills and cannot exist
        # until both are fitted. They must still be present here as NULL: _write_rating INSERTs
        # by enumerating frames.EXPECTED_COLUMNS["mode2_fit_run"], so a key the schema knows
        # about and this dict does not is a KeyError on every rating write, not a NULL column.
        # The columns are nullable exactly so this ordering is legal (GAPFILL_SPEC §2.2).
        "corr_one_lap_grid": None,
        "corr_one_lap_grid_ex_islands": None,
        "corr_one_lap_race": None,
    }


def _write_rating(conn, asid: int, rows: pd.DataFrame, fit: Mode2Fit, full: np.ndarray,
                  draws: np.ndarray, mv: str, boot_seconds: float) -> dict:
    """Everything in ONE transaction, then flip ``is_current`` in that same transaction
    (§6.6): a half-written fit must never be the one the web reads."""
    rating = _rating_frame(fit, rows, draws, 0, asid)
    run = _fit_run_row(fit, rows, full, rating, mv, asid, boot_seconds)
    con = contrasts(fit, draws)
    hist = _history_frame(rows, 0, asid)

    cols = [c for c in frames.EXPECTED_COLUMNS["mode2_fit_run"] if c != "fit_id"]
    with conn.cursor() as cur:
        cur.execute("DELETE FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND model_version = %s", (asid, mv))
        cur.execute("UPDATE mode2_fit_run SET is_current = false "
                    "WHERE assumption_set_id = %s AND is_current", (asid,))
        ph = ", ".join(["%s"] * len(cols))
        cur.execute(f"INSERT INTO mode2_fit_run ({', '.join(cols)}) VALUES ({ph}) "
                    "RETURNING fit_id", tuple(frames._py(run[c]) for c in cols))
        fit_id = int(cur.fetchone()[0])

        counts = {"mode2_fit_run": 1}
        for table, df in (("mode2_component", _component_frame(fit.components, fit_id, asid)),
                          ("mode2_driver_rating", rating.assign(fit_id=fit_id)),
                          ("mode2_driver_rating_history", hist.assign(fit_id=fit_id)),
                          ("mode2_driver_contrast", _contrast_frame(con, fit_id, asid)),
                          ("mode2_row_audit", _audit_frame(rows, fit_id, asid))):
            counts[table] = db.copy_frame(cur, table, frames.cast_frame(df, table))
        _prune_fits(cur, asid)
    n = write_status(conn, "mode2_rating", "ok")
    log.info("mode2 recompute_rating: fit_id=%d version=%s %s", fit_id, mv, counts)
    return counts | {"fit_id": fit_id, "model_version": mv, "sessions_marked": n,
                     "sd_ratio": run["sd_ratio"], "skipped": False}


def _contrast_frame(con: pd.DataFrame, fit_id: int, asid: int) -> pd.DataFrame:
    c = con.copy()
    c["fit_id"] = fit_id
    c["assumption_set_id"] = asid
    return frames.cast_frame(c, "mode2_driver_contrast")


def _prune_fits(cur, asid: int) -> int:
    """Keep the most recent MODE2_KEEP_FITS fits; the cascade takes their children."""
    cur.execute("DELETE FROM mode2_fit_run WHERE assumption_set_id = %s AND fit_id NOT IN "
                "(SELECT fit_id FROM mode2_fit_run WHERE assumption_set_id = %s "
                " ORDER BY fitted_at DESC, fit_id DESC LIMIT %s)",
                (asid, asid, int(config.MODE2_KEEP_FITS)))
    return cur.rowcount


# §3.6, verbatim. These strings are the product, not an apology, and they are stored
# rather than hard-coded in TypeScript so the page cannot drift from what was measured.
TYRE_NOT_MEASURED = (
    "We fitted it. The differences between drivers came out smaller than their own "
    "error bars, so we are not showing a number."
)
WET_NOT_MEASURED = (
    "Every wet race in 2024–26 is one our pace model refuses to fit, so we have no wet "
    "pace estimates at all."
)


# §5.1's verbatim §3.6 panel reasons for the two new refusals (DL-11: no CHECK key is
# added that is not written). ``{nSqSessions}`` is left as a TEMPLATE SLOT rather than
# interpolated here, because DL-13 forbids a fitted count as a literal in stored copy;
# the panel fills it from count(*) exactly as it fills C-SKILL-5's slots.
SPRINT_NOT_MEASURED = (
    "We fitted it on {nSqSessions} sprint-qualifying sessions. The driver differences "
    "came out smaller than their own error bars, and seventeen sessions is not a corpus."
)
TRAIL_NOT_MEASURED = (
    "We can see where a driver came off the brakes on one lap. We cannot turn that into "
    "a rating: the same driver's number at the same corner changes as much between his "
    "own two laps of one weekend as it does between him and the rest of the grid."
)


def _quali_audit_frame(audit: pd.DataFrame, fit_id: int, asid: int) -> pd.DataFrame:
    """``mode2_quali_row_audit`` rows: every segment-1 row, used or refused, with a
    reason (§1.3, §1.8). The §3.6 panel reads the sprint exclusion out of this table
    rather than out of a hard-coded string."""
    if audit.empty:
        return pd.DataFrame(columns=QUALI_AUDIT_COLUMNS)
    out = pd.DataFrame({
        "fit_id": int(fit_id), "assumption_set_id": int(asid),
        "session_id": audit["session_id"].astype(int),
        "driver_id": audit["driver_id"].astype(str),
        "team_id": audit["team_id"].astype(str),
        "year": audit["year"].astype(int), "round": audit["round"].astype(int),
        "kind": audit["kind"].astype(str), "included": audit["included"].astype(bool),
        "exclude_reason": audit["exclude_reason"],
        "y_pp": pd.to_numeric(audit["y_pp"], errors="coerce"),
        "best_s": pd.to_numeric(audit["best_s"], errors="coerce"),
    })[QUALI_AUDIT_COLUMNS]
    bad = set(out.loc[~out["included"], "exclude_reason"].dropna()) - set(QUALI_EXCLUDE_REASONS)
    if bad:
        raise SimNotEstimable(f"mode2_quali_row_audit: unknown exclude reasons {sorted(bad)}")
    return out


def _write_quali_audit(cur, audit: pd.DataFrame) -> int:
    """COPY the audit frame. ``frames.TABLE_COLUMNS`` is WP-S1's file; until its entry
    for this table lands, cast_frame/copy_frame raise KeyError, so the write goes
    through db.copy_rows against ``QUALI_AUDIT_COLUMNS`` -- which is checked against
    the frames contract the moment that contract exists, so the two cannot drift."""
    if "mode2_quali_row_audit" in frames.EXPECTED_COLUMNS:
        expected = frames.EXPECTED_COLUMNS["mode2_quali_row_audit"]
        if expected != QUALI_AUDIT_COLUMNS:
            raise SimNotEstimable(
                f"mode2_quali_row_audit: frames.EXPECTED_COLUMNS {expected} != "
                f"decomp.QUALI_AUDIT_COLUMNS {QUALI_AUDIT_COLUMNS}")
    if audit.empty:
        return 0
    rows = (tuple(None if (v is not None and v != v) else v for v in rec)
            for rec in audit.itertuples(index=False, name=None))
    return db.copy_rows(cur, "mode2_quali_row_audit", QUALI_AUDIT_COLUMNS, rows)


def _write_fit_run_correlations(cur, fit_id: int, corr: dict) -> None:
    """§2.1: the observed r is STORED, not just printed, so the retirement decision is
    auditable from the database in every later release."""
    cur.execute("UPDATE mode2_fit_run SET corr_one_lap_grid = %s, "
                "corr_one_lap_grid_ex_islands = %s, corr_one_lap_race = %s "
                "WHERE fit_id = %s",
                (corr.get("corr_one_lap_grid"), corr.get("corr_one_lap_grid_ex_islands"),
                 corr.get("corr_one_lap_race"), int(fit_id)))



def _current_fit_id(conn, asid: int) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT fit_id FROM mode2_fit_run WHERE assumption_set_id = %s "
                    "AND is_current", (int(asid),))
        row = cur.fetchone()
    return int(row[0]) if row else None


def _race_pace_skill(conn, fit_id: int, asid: int) -> pd.DataFrame:
    """The headline rating, restated as a skill row (§3.1). A projection of
    ``mode2_driver_rating``, never a second estimate of the same thing."""
    with conn.cursor() as cur:
        cur.execute("SELECT driver_id, rating_pp, rating_lo, rating_hi, evidence_share, "
                    "anchor_class, n_races FROM mode2_driver_rating WHERE fit_id = %s "
                    "ORDER BY driver_id", (int(fit_id),))
        r = pd.DataFrame(cur.fetchall(), columns=["driver_id", "value", "value_lo",
                                                  "value_hi", "evidence_share",
                                                  "anchor_class", "n_obs"])
    if r.empty:
        return frames.empty_frame("mode2_driver_skill")
    vals = r["value"].to_numpy(float)
    r["fit_id"] = int(fit_id)
    r["assumption_set_id"] = int(asid)
    r["skill"] = "race_pace"
    r["measured"] = True
    r["unit"] = "pp"
    r["pct_field_below"] = [_pct_field_below(vals, i, str(a))
                            for i, a in enumerate(r["anchor_class"])]
    r["not_measured_reason"] = None
    return frames.cast_frame(r, "mode2_driver_skill")


def _refused_skill(skill: str, reason: str, drivers: pd.DataFrame, fit_id: int,
                   asid: int, n_obs: dict, evidence: dict | None = None) -> pd.DataFrame:
    """One refused skill as 28 stored rows (§3.6). Absence is invisible; a row that says
    "we looked, here is what we found, and it is not a number" is not."""
    out = []
    for r in drivers.itertuples(index=False):
        out.append({
            "fit_id": int(fit_id), "assumption_set_id": int(asid),
            "driver_id": str(r.driver_id), "skill": skill, "measured": False,
            "value": None, "value_lo": None, "value_hi": None, "unit": "none",
            "evidence_share": (None if evidence is None
                               else float(evidence.get(str(r.driver_id), 0.0))),
            "anchor_class": str(r.anchor_class), "pct_field_below": None,
            "not_measured_reason": reason, "n_obs": int(n_obs.get(str(r.driver_id), 0)),
        })
    return frames.cast_frame(pd.DataFrame(out), "mode2_driver_skill")


def assert_grid_pace_reproduces(conn, refit: pd.DataFrame) -> dict:
    """GATE G1 (§6.3, §1.6, DL-6). MANDATORY, and it runs BEFORE any correlation.

    Refit the surrogate from ``GRID_SQL`` and check it against what is actually stored.
    If the refit does not reproduce the stored rows at r = 1.000, every correlation
    computed afterwards is measuring a bug in the re-derivation, not the data -- and a
    pre-registered retirement decision would then be taken against a number that does
    not describe anything that ships. Promoted from courtesy to gate by DL-6.
    """
    if refit.empty:
        return {"r": None, "n": 0, "compared_fit_id": None, "vacuous": True}
    with conn.cursor() as cur:
        cur.execute("SELECT fit_id FROM mode2_driver_skill WHERE skill = 'grid_pace' "
                    "AND measured ORDER BY fit_id DESC LIMIT 1")
        row = cur.fetchone()
        if row is None:
            log.info("mode2 gate G1: no stored grid_pace rows yet -- vacuous on a "
                     "first-ever fit, enforced on every later one")
            return {"r": None, "n": 0, "compared_fit_id": None, "vacuous": True}
        prev = int(row[0])
        cur.execute("SELECT driver_id, value FROM mode2_driver_skill WHERE fit_id = %s "
                    "AND skill = 'grid_pace' ORDER BY driver_id", (prev,))
        stored = {str(d): float(v) for d, v in cur.fetchall() if v is not None}
    g = refit[refit["driver_id"].isin(stored)].sort_values("driver_id")
    if len(g) < 3:
        raise SimNotEstimable(
            f"gate G1: only {len(g)} drivers overlap between the grid_pace refit and "
            f"the stored rows of fit {prev}; the surrogate cannot be checked")
    a = np.asarray([float(v) for v in g["value"]], float)
    b = np.asarray([stored[str(d)] for d in g["driver_id"]], float)
    r = float(np.corrcoef(a, b)[0, 1])
    max_abs = float(np.max(np.abs(a - b)))
    log.info("mode2 gate G1: grid_pace refit vs stored fit %d -- n=%d r=%.6f "
             "max|diff|=%.3e", prev, len(a), r, max_abs)
    if round(r, 3) != 1.000:
        raise SimNotEstimable(
            f"gate G1 FAILED: the grid_pace refit from GRID_SQL agrees with the stored "
            f"rows of fit {prev} at r={r:.6f}, not 1.000 (max|diff|={max_abs:.3e}). "
            f"Every §1.6 correlation below would be measuring this discrepancy.")
    return {"r": r, "n": int(len(a)), "compared_fit_id": prev, "max_abs_diff": max_abs,
            "vacuous": False}


def skill_correlations(one_lap: pd.DataFrame, grid: pd.DataFrame,
                       race: pd.DataFrame) -> dict:
    """§1.6's three stored correlations, reported BOTH ways (DL-5), and GATE G3.

    Four of the 28 drivers have levels set by shrinkage toward each fit's own prior
    rather than by data, so an all-28 correlation is 14 % a comparison of two priors.
    The decision does not flip at 0.839 against 0.867, but a statistic that governs a
    retirement must not be part prior without saying so, so both are stored and both
    are gated. G3 fails the BUILD if either reaches
    ``config.MODE2_GRID_RETIRE_R``: retirement stays a human decision requiring a
    spec edit, never something a run does to itself.
    """
    def pair(a: pd.DataFrame, b: pd.DataFrame, drop: set[str] | None = None):
        if a.empty or b.empty:
            return None, 0
        x = dict(zip(a["driver_id"].astype(str), a["value"]))
        y = dict(zip(b["driver_id"].astype(str), b["value"]))
        keys = sorted(set(x) & set(y) - (drop or set()))
        keys = [k for k in keys if x[k] is not None and y[k] is not None]
        if len(keys) < 3:
            return None, len(keys)
        u = np.asarray([float(x[k]) for k in keys], float)
        v = np.asarray([float(y[k]) for k in keys], float)
        return float(np.corrcoef(u, v)[0, 1]), len(keys)

    floating = {str(r.driver_id) for r in one_lap.itertuples(index=False)
                if str(r.anchor_class) == "floating"}
    r_grid, n_all = pair(one_lap, grid)
    r_ex, n_ex = pair(one_lap, grid, drop=floating)
    r_race, n_race = pair(one_lap, race)
    out = {"corr_one_lap_grid": r_grid, "corr_one_lap_grid_ex_islands": r_ex,
           "corr_one_lap_race": r_race, "n_all": n_all, "n_ex_islands": n_ex,
           "n_race": n_race, "floating": sorted(floating)}
    log.info("mode2 §1.6 correlations: one_lap~grid r=%s (n=%d), ex-islands r=%s "
             "(n=%d), one_lap~race r=%s (n=%d)",
             None if r_grid is None else f"{r_grid:.4f}", n_all,
             None if r_ex is None else f"{r_ex:.4f}", n_ex,
             None if r_race is None else f"{r_race:.4f}", n_race)
    thr = float(config.MODE2_GRID_RETIRE_R)
    # `>=`, never `not <`: the three columns are nullable on purpose (every pre-v1.8
    # fit row legitimately has NULL) and a NULL must not read as a failure.
    crossed = {k: v for k, v in (("corr_one_lap_grid", r_grid),
                                 ("corr_one_lap_grid_ex_islands", r_ex))
               if v is not None and v >= thr}
    if crossed:
        raise SimNotEstimable(
            f"gate G3 FAILED: {crossed} reached the pre-registered retirement threshold "
            f"{thr}. QUALI_SPEC §5.1.1 retires grid_pace at r >= {thr}; that is a human "
            f"decision requiring a spec edit (§2.1), not something this run may take.")
    return out


def recompute_skills(conn, assumption_set_id: int, fit: Mode2Fit) -> dict:
    """WP3. Writes mode2_driver_skill — including the refused skills — plus, as of
    v1.8, ``mode2_quali_row_audit`` and the three ``mode2_fit_run.corr_*`` columns, and
    the ``mode2_skills`` status key.

    **Seven** skills, 28 drivers, **196 rows** (GAPFILL_SPEC §2.1): three measured --
    race pace, the new measured ``one_lap_pace`` (§1.3) and the ``grid_pace`` surrogate
    it did NOT retire (§1.6: r = 0.839 against a pre-registered 0.95) -- and four stored
    as refusals with the §3.6 reason. The refusals are rows rather than absences because
    the panel that replaces the radar is the product (§3.6), and because a refusal that
    is merely omitted becomes a permanent silent gap instead of a measured decision.
    DL-11 is a runtime obligation on this function: no CHECK key exists that this does
    not write, so ``sprint_one_lap`` and ``trail_braking`` are written here as real
    ``measured = false`` rows for every driver.

    Three release-blocking gates run here, in this order (§6.3):
    G1 the ``grid_pace`` refit must reproduce the stored rows at r = 1.000 *before* any
    correlation is computed; G2 the qualifying-only mobility graph must still be §1.4's
    four components; G3 the build fails if either stored correlation reaches
    ``MODE2_GRID_RETIRE_R``.
    """
    asid = int(assumption_set_id)
    fit_id = _current_fit_id(conn, asid)
    if fit_id is None:
        n = write_status(conn, "mode2_skills", "empty")
        return {t: 0 for t in SKILL_TABLES} | {"sessions_marked": n, "empty": True}

    race = _race_pace_skill(conn, fit_id, asid)
    if race.empty:
        n = write_status(conn, "mode2_skills", "empty")
        return {t: 0 for t in SKILL_TABLES} | {"sessions_marked": n, "empty": True}
    who = race[["driver_id", "anchor_class"]]
    anchor = dict(zip(race["driver_id"], race["anchor_class"]))

    components = fit.components or build_components(load_rows(conn, asid))
    grid = fit_grid_pace(conn, asid, components)
    # GATE G1 -- runs before the fit below and long before any correlation (DL-6).
    gate_g1 = assert_grid_pace_reproduces(conn, grid)
    if not grid.empty:
        # §3.2: anchor_class is graph-derived and IDENTICAL across skills, so the rating
        # table is authoritative and this surface never re-derives its own badge.
        grid = grid.assign(fit_id=fit_id,
                           anchor_class=[anchor.get(x, a) for x, a
                                         in zip(grid["driver_id"], grid["anchor_class"])])
        grid = grid[grid["driver_id"].isin(anchor)]

    # §1.3 -- the measured one-lap skill, and §1.4's gate on top of it.
    one_lap_rep = one_lap_pace_report(conn, asid, components)
    one_lap = one_lap_rep["skill"]
    if not one_lap.empty:
        # GATE G2: qualifying adds rows, not edges. Fails the RUN, not the page.
        assert_quali_islands_hold(
            build_components(one_lap_rep["audit"].loc[
                one_lap_rep["audit"]["included"],
                ["driver_id", "cell_id", "included"]]),
            components)
        one_lap = one_lap.assign(
            fit_id=fit_id,
            anchor_class=[anchor.get(x, a) for x, a
                          in zip(one_lap["driver_id"], one_lap["anchor_class"])])
        one_lap = one_lap[one_lap["driver_id"].isin(anchor)]

    tyre = tyre_rejection_report(conn, asid)
    wet = wet_rejection_report(conn, asid)
    tyre_rows = _refused_skill("tyre_management", TYRE_NOT_MEASURED, who, fit_id, asid,
                               tyre.get("stints_per_driver", {}),
                               tyre.get("evidence_share", {}))
    # n_obs is the count in the currency this feature is denominated in: usable wet-pace
    # observations, which is zero. 26 of 28 drivers DO have wet laps (§3.4) and the
    # caption must not claim otherwise -- that count is in the returned report.
    wet_rows = _refused_skill("wet", WET_NOT_MEASURED, who, fit_id, asid, {})

    # DL-11. n_obs is the count in the currency each refusal is denominated in: the
    # sprint-qualifying segment-1 rows this fit looked at and excluded (§1.8), and zero
    # for trail braking, whose refusal is a replication floor and not a shortage of
    # this fit's rows (§3.2, §0.3 -- Gap B owns the number, and it is not a skill).
    audit = one_lap_rep["audit"]
    sq = audit[audit["exclude_reason"] == "sprint_qualifying_excluded"]
    sq_per_driver = sq.groupby("driver_id").size().to_dict() if len(sq) else {}
    sprint_rows = _refused_skill("sprint_one_lap", SPRINT_NOT_MEASURED, who, fit_id,
                                 asid, sq_per_driver)
    trail_rows = _refused_skill("trail_braking", TRAIL_NOT_MEASURED, who, fit_id, asid, {})

    # GATE G3 -- both ways (DL-5), and it raises rather than returning a flag.
    corr = skill_correlations(one_lap, grid, race)

    df = pd.concat([race, one_lap, grid, tyre_rows, wet_rows, sprint_rows, trail_rows],
                   ignore_index=True)
    audit_frame = _quali_audit_frame(audit, fit_id, asid)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM mode2_driver_skill WHERE fit_id = %s", (fit_id,))
        written = db.copy_frame(cur, "mode2_driver_skill",
                                frames.cast_frame(df, "mode2_driver_skill"))
        cur.execute("DELETE FROM mode2_quali_row_audit WHERE fit_id = %s", (fit_id,))
        audited = _write_quali_audit(cur, audit_frame)
        _write_fit_run_correlations(cur, fit_id, corr)
    n = write_status(conn, "mode2_skills", "ok")
    log.info("mode2 recompute_skills: fit_id=%d %d rows (%d measured), %d quali audit "
             "rows, corr(one_lap,grid)=%s / ex-islands %s", fit_id, written,
             int(df["measured"].sum()), audited,
             corr["corr_one_lap_grid"], corr["corr_one_lap_grid_ex_islands"])
    return {"mode2_driver_skill": written, "mode2_quali_row_audit": audited,
            "fit_id": fit_id, "sessions_marked": n, "tyre": tyre, "wet": wet,
            "one_lap": {k: v for k, v in one_lap_rep.items()
                        if k not in ("skill", "audit", "est")},
            "gate_g1": gate_g1, "corr": corr, "skipped": False}


def _car_rating_frame(fit: Mode2Fit, fit_id: int, asid: int) -> pd.DataFrame:
    """γ̂ and β̂ per car-season, straight out of the §1.3 fit (§5.2).

    Driver effects are removed **by construction**, not by a second regression, so a
    mid-season driver change cannot masquerade as car performance. The development curve
    is the β_c random slope of the same fit -- two points and a band, never a curve
    through per-round estimates, because a curve invites reading wiggles that a linear
    slope on 24 rounds and a 0.39 pp residual cannot support.

    A car in a floating component carries ``basis = 'by-analogy'``: the McLaren car's
    level is its own level plus a constant the data contain no information about, and
    every surface must mark that differently from a measured one.
    """
    nd, nc = len(fit.driver_ids), len(fit.cell_ids)
    if nc == 0:
        return frames.empty_frame("mode2_car_rating")
    has_slope = fit.spec == "S" and fit.blup.shape[0] >= nd + 2 * nc
    sd = np.sqrt(np.clip(np.diag(fit.cov), 0.0, None))
    comp_of = {c: (cid, v) for cid, v in fit.components.items() for c in v["cells"]}
    n_races = fit.rows.groupby("cell_id")["session_id"].nunique().to_dict()

    out = []
    for j, cell in enumerate(fit.cell_ids):
        team, year = cell.rsplit("|", 1)
        cid, comp = comp_of.get(cell, ("K0", {"is_floating": False}))
        gamma, g_sd = float(fit.blup[nd + j]), float(sd[nd + j])
        # §2.3: MODE2_SIGMA_SPEC is added in quadrature to every published LEVEL, and a
        # car rating is one. The slope below is a CONTRAST of two points on the same
        # car's own curve, so it keeps the raw posterior SD -- widening it would move
        # `slope_significant`, which is a different claim from "how wide is the band".
        g_sd_pub = float(np.hypot(g_sd, config.MODE2_SIGMA_SPEC))
        beta = float(fit.blup[nd + nc + j]) if has_slope else 0.0
        b_sd = float(sd[nd + nc + j]) if has_slope else 0.0
        b_lo, b_hi = beta - _Z90 * b_sd, beta + _Z90 * b_sd
        out.append({
            "fit_id": int(fit_id), "assumption_set_id": int(asid),
            "team_id": team, "year": int(year),
            "gamma_pp": gamma, "gamma_lo": gamma - _Z90 * g_sd_pub,
            "gamma_hi": gamma + _Z90 * g_sd_pub,
            "slope_pp": beta, "slope_lo": b_lo, "slope_hi": b_hi,
            "start_pp": gamma - beta / 2.0, "end_pp": gamma + beta / 2.0,
            # The multiplicity statement leads the caption (§5.2): 31 tests at alpha=0.05
            # produce about 1.6 by chance, so this flag exists to GREY OUT segments, not
            # to publish a list of findings.
            "slope_significant": bool(has_slope and (b_lo > 0.0 or b_hi < 0.0)),
            "rank_in_season": 0, "component_id": cid,
            "basis": "by-analogy" if comp.get("is_floating") else "measured",
            "n_races": int(n_races.get(cell, 0)),
        })
    df = pd.DataFrame(out)
    # Within-season only (§5.2): gamma is field-relative inside its own season, so a
    # cross-season rank would compare two different zeroes.
    df["rank_in_season"] = df.groupby("year")["gamma_pp"].rank(method="min").astype(int)
    return frames.cast_frame(df.sort_values(["year", "team_id"]), "mode2_car_rating")


def recompute_constructor(conn, assumption_set_id: int, fit: Mode2Fit) -> dict:
    """WP3. Writes mode2_car_rating / mode2_car_hazard and ``mode2_constructor``."""
    asid = int(assumption_set_id)
    fit_id = _current_fit_id(conn, asid)
    if fit_id is None or not fit.cell_ids:
        n = write_status(conn, "mode2_constructor", "empty")
        return {t: 0 for t in CONSTRUCTOR_TABLES} | {"sessions_marked": n, "empty": True}

    car = _car_rating_frame(fit, fit_id, asid)
    haz = fit_hazard(conn, asid)
    if not haz.empty:
        haz = haz.assign(fit_id=fit_id)
    counts = {}
    with conn.cursor() as cur:
        for table, df in (("mode2_car_rating", car), ("mode2_car_hazard", haz)):
            cur.execute(f"DELETE FROM {table} WHERE fit_id = %s", (fit_id,))
            counts[table] = db.copy_frame(cur, table, frames.cast_frame(df, table))
    n = write_status(conn, "mode2_constructor", "ok")
    log.info("mode2 recompute_constructor: fit_id=%d %s (%d of %d slopes significant)",
             fit_id, counts, int(car["slope_significant"].sum()) if len(car) else 0,
             len(car))
    return counts | {"fit_id": fit_id, "sessions_marked": n, "skipped": False}


def recompute_all(conn, assumption_set_id: int, *, force: bool = False) -> dict:
    """The run-end entry point, called by ``companion`` step ``mode2`` (§7.4).

    Real shape (§6.6): compute ``model_version``; return ``{"skipped": True}`` early if
    a fit with that ``(assumption_set_id, model_version)`` exists and
    ``stored_is_complete`` unless ``force``; otherwise fit, bootstrap, write every table
    in ONE transaction, flip ``is_current`` in that same transaction, and prune to
    ``config.MODE2_KEEP_FITS``.

    Each sub-step still writes its own ``analytics_status`` key so a partial failure
    degrades one section's EmptyState rather than blanking the driver page, and
    ``decomp_points`` writes the fourth.

    The skip decision covers ALL FOUR steps, not just the rating: ``stored_is_complete``
    asks whether every table hanging off the stored fit has rows, so a run that died
    after the rating is retried rather than declared done.
    """
    from . import decomp_points

    asid = int(assumption_set_id)
    out: dict = {"force": bool(force), "assumption_set_id": asid}
    rows = load_rows(conn, asid)
    if not rows.empty and bool(rows["included"].any()):
        prior = _find_fit(conn, asid, model_version(rows, config.MODE2_SPEC))
        if prior is not None and not force and stored_is_complete(conn, prior):
            log.info("decomp.recompute_all: fit %d is complete; nothing to do", prior)
            return out | {"skipped": True, "fit_id": prior}

    out["rating"] = recompute_rating(conn, asid, force=force)
    # One more 0.3 s fit rather than threading a Mode2Fit through a dict companion logs.
    # The expensive half is the bootstrap, and the draws below are computed once and
    # shared by every downstream step.
    fit = fit_current(conn, asid)
    draws = (bootstrap(fit, reps=config.MODE2_BOOTSTRAP_REPS,
                       n_jobs=config.MODE2_BOOTSTRAP_JOBS, seed=config.MODE2_SEED)
             if fit.blup.size else np.empty((0, 0)))
    out["skills"] = recompute_skills(conn, asid, fit)
    out["constructor"] = recompute_constructor(conn, asid, fit)
    out["points"] = decomp_points.recompute_points(conn, asid, fit, draws)
    log.info("decomp.recompute_all: %s", {k: (v.get("fit_id") if isinstance(v, dict) else v)
                                          for k, v in out.items()})
    return out
