"""Weekend preview for a scheduled-but-unraced round (MODE1_SPEC §3).

Four things are computed here, all from stored rows (no FastF1 loads, no fitting that
``sim.recompute_hazards`` already did):

* **§3.2** the circuit-resolution ladder — ``events.circuit_key`` is NULL for every
  scheduled 2026 round, so the venue is resolved from ``events.location`` and the
  outcome (``native|location|alias|none``) is stored and displayed, never hidden.
* **§3.3** the overtaking difficulty index: adjacent-pair green-flag on-track passes,
  controlled, empirical-Bayes shrunk and mapped onto a *fixed* log-anchored 0-100 scale.
* **§3.4** safety-car / VSC probability and expected pit loss, shrunk toward the pooled
  hazard; no new fitting.
* **§3.5** a predicted finishing order with an 80% interval, from the §2 Plackett-Luce
  strengths and shrunk DNF rates, plus the rolling-origin backtest that produces the
  accuracy number the caption quotes.

Neither control in §3.3.3 is significant at n=61 races and a driver-circuit affinity
term measured *negative* (§3.5); both facts are kept in the code rather than papered
over, because the captions state them.

Nothing here opens a transaction: the caller (``companion.recompute_companion``, itself
inside ``ingest._committed``) owns the commit, exactly like ``sim.recompute_hazards``.
"""

from __future__ import annotations

import datetime as dt
import logging
import math

import numpy as np
import pandas as pd

from . import config, frames, title

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _copy_frame(cur, table: str, df: pd.DataFrame) -> int:
    """COPY a cast frame into ``table``; returns the row count (§0.3: explicit columns)."""
    from psycopg import sql

    if df.empty:
        return 0
    cols = frames.EXPECTED_COLUMNS[table]
    stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(table), sql.SQL(", ").join(sql.Identifier(c) for c in cols))
    n = 0
    with cur.copy(stmt) as copy:
        for row in frames.iter_rows(df):
            copy.write_row(row)
            n += 1
    return n


def _fetch(conn, q: str, params: tuple = (), columns: list[str] | None = None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(q, params)
        cols = columns or [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


# ---------------------------------------------------------------------------
# §3.2 resolving a scheduled round to a circuit
# ---------------------------------------------------------------------------

def resolve_circuit(conn, year: int, round_: int) -> tuple[int | None, str]:
    """``(circuit_key, match_kind)`` with ``match_kind`` in native|location|alias|none.

    The ladder of §3.2, in order: the stored ``events.circuit_key``; an exact match of
    ``events.location`` against ``circuits.location``; the reviewed
    ``config.PREVIEW_CIRCUIT_ALIASES`` map; otherwise no match. ``events.event_name`` is
    **never** consulted — it is the one field that would confidently mis-resolve a brand
    new venue onto an old circuit's history.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT circuit_key, location FROM events WHERE year = %s AND round = %s",
                    (int(year), int(round_)))
        row = cur.fetchone()
        if row is None:
            return (None, "none")
        native, location = row
        if native is not None:
            return (int(native), "native")
        cur.execute("SELECT circuit_key FROM circuits WHERE location = %s", (location,))
        hit = cur.fetchone()
        if hit is not None:
            return (int(hit[0]), "location")
        alias = config.PREVIEW_CIRCUIT_ALIASES.get(location)
        if alias is not None:
            cur.execute("SELECT circuit_key FROM circuits WHERE circuit_key = %s", (int(alias),))
            if cur.fetchone() is not None:
                return (int(alias), "alias")
    return (None, "none")


# ---------------------------------------------------------------------------
# §3.3.1 adjacent-pair green-flag on-track passes
# ---------------------------------------------------------------------------

_PASS_LAPS_SQL = """
SELECT l.session_id, e.circuit_key, l.driver_id, l.lap_number, l.position
  FROM laps l
  JOIN sessions s ON s.session_id = l.session_id
  JOIN events e ON e.year = s.year AND e.round = s.round
  JOIN session_ingests si ON si.session_id = s.session_id
 WHERE s.kind = 'R' AND si.status IN ('ok', 'partial')
   AND e.circuit_key IS NOT NULL AND l.position IS NOT NULL
 ORDER BY l.session_id, l.lap_number, l.position
"""


def _pairs_one_session(laps: pd.DataFrame, green: set[int], pit: set[tuple[str, int]]) -> pd.DataFrame:
    """Adjacent-pair opportunities and passes per lap for one race session (§3.3.1).

    Adjacency is taken over the **full** running order at lap L: a pair separated by a
    car that pitted is dropped, never bridged. Both cars must carry a position on L and
    L+1, both laps must be green, and neither car may have ``pit_stops.lap_in`` in
    {L, L+1} — guarding only the passing car scores a promotion by the other car's stop
    as an overtake, which is the single most common way this metric goes wrong.

    ``pit`` carries ``lap_out`` as well as ``lap_in``: the out-lap of a stop whose
    ``lap_in`` fell earlier is still a car rejoining at pit-lane speed, and guarding it
    is what reproduces the §3.3.2 re-derivation exactly (Monte Carlo 0.0034, Lusail
    0.0140, Singapore 0.0209, Spa 0.0342, Monza 0.0430, Las Vegas 0.0497).
    """
    pos = {}
    for lap, grp in laps.groupby("lap_number", sort=True):
        pos[int(lap)] = dict(zip(grp["driver_id"], grp["position"].astype(int)))
    rows = []
    for lap in sorted(pos):
        nxt = lap + 1
        if nxt not in pos or lap not in green or nxt not in green:
            continue
        here, there = pos[lap], pos[nxt]
        order = sorted(here, key=lambda d: here[d])

        def ok(d: str) -> bool:
            return d in there and (d, lap) not in pit and (d, nxt) not in pit

        opportunities = passes = 0
        for ahead, behind in zip(order, order[1:]):
            if not (ok(ahead) and ok(behind)):
                continue
            opportunities += 1
            if there[behind] < there[ahead]:
                passes += 1
        if opportunities:
            rows.append((lap, passes, opportunities))
    return pd.DataFrame(rows, columns=["lap_number", "passes", "opportunities"])


def pass_events(conn) -> pd.DataFrame:
    """Adjacent-pair green-flag position swaps per (circuit, session, lap) — §3.3.1."""
    laps = _fetch(conn, _PASS_LAPS_SQL,
                  columns=["session_id", "circuit_key", "driver_id", "lap_number", "position"])
    if laps.empty:
        return pd.DataFrame({c: pd.Series(dtype=object) for c in
                             ("circuit_key", "session_id", "lap_number", "passes", "opportunities")})
    sids = sorted({int(s) for s in laps["session_id"]})
    ls = _fetch(conn, "SELECT session_id, lap_number FROM lap_status "
                      "WHERE session_id = ANY(%s) AND is_green", (sids,),
                columns=["session_id", "lap_number"])
    ps = _fetch(conn, "SELECT session_id, driver_id, lap_in, lap_out FROM pit_stops "
                      "WHERE session_id = ANY(%s)", (sids,),
                columns=["session_id", "driver_id", "lap_in", "lap_out"])
    green_by = {sid: set(g["lap_number"].astype(int)) for sid, g in ls.groupby("session_id")}
    pit_by: dict[int, set[tuple[str, int]]] = {}
    for sid, g in ps.groupby("session_id"):
        marked: set[tuple[str, int]] = set()
        for d, li, lo in zip(g["driver_id"], g["lap_in"], g["lap_out"]):
            marked.add((str(d), int(li)))
            if lo is not None and lo == lo:  # noqa: PLR0124 (NaN check)
                marked.add((str(d), int(lo)))
        pit_by[sid] = marked
    out = []
    for (sid, ckey), grp in laps.groupby(["session_id", "circuit_key"], sort=True):
        per_lap = _pairs_one_session(grp, green_by.get(sid, set()), pit_by.get(sid, set()))
        if per_lap.empty:
            continue
        per_lap.insert(0, "session_id", int(sid))
        per_lap.insert(0, "circuit_key", int(ckey))
        out.append(per_lap)
    if not out:
        return pd.DataFrame({c: pd.Series(dtype=object) for c in
                             ("circuit_key", "session_id", "lap_number", "passes", "opportunities")})
    return pd.concat(out, ignore_index=True)[
        ["circuit_key", "session_id", "lap_number", "passes", "opportunities"]]


# ---------------------------------------------------------------------------
# §3.3.3 controls, shrinkage and the fixed log-anchored scale
# ---------------------------------------------------------------------------

_CONTROL_PACE_SQL = """
SELECT l.session_id, l.driver_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY l.lap_time_fc_s) AS med
  FROM laps l
 WHERE l.session_id = ANY(%s) AND l.is_representative AND l.lap_time_fc_s IS NOT NULL
 GROUP BY l.session_id, l.driver_id
"""


def race_controls(conn, session_ids: list[int]) -> pd.DataFrame:
    """Per race: ``spread_pct`` and ``nongreen_frac``, the two §3.3.3 controls.

    ``spread_pct`` = 100 · sd(driver median fuel-corrected representative lap) / fastest
    such median; ``nongreen_frac`` = share of the race's laps with ``is_green`` false.
    """
    pace = _fetch(conn, _CONTROL_PACE_SQL, (session_ids,), columns=["session_id", "driver_id", "med"])
    ls = _fetch(conn, "SELECT session_id, is_green FROM lap_status WHERE session_id = ANY(%s)",
                (session_ids,), columns=["session_id", "is_green"])
    rows = []
    for sid in session_ids:
        m = pd.to_numeric(pace.loc[pace["session_id"] == sid, "med"], errors="coerce").dropna()
        spread = float(100.0 * m.std(ddof=1) / m.min()) if len(m) >= 3 and m.min() > 0 else np.nan
        g = ls.loc[ls["session_id"] == sid, "is_green"]
        nongreen = float(1.0 - g.astype(bool).mean()) if len(g) else np.nan
        rows.append((int(sid), spread, nongreen))
    return pd.DataFrame(rows, columns=["session_id", "spread_pct", "nongreen_frac"])


def _fit_controls(races: pd.DataFrame) -> tuple[pd.Series, float, pd.Series]:
    """OLS of ``logit(pass_rate)`` on the two controls; returns (params, ref_logit, resid).

    MEASURED at n = 61 races: const −3.356, ``spread_pct`` −0.365 (p = 0.19),
    ``nongreen_frac`` +1.138 (p = 0.17). **Neither control is significant.** They stay
    because the specification is right and the signs are the right way round, and the
    caption does not claim they are doing work they are not doing (§3.3.3).

    ``ref_logit`` is the fit evaluated at the mean covariates, so the scale below is
    anchored on a reference race rather than on any one circuit.
    """
    import statsmodels.api as sm

    df = races.dropna(subset=["spread_pct", "nongreen_frac"]).copy()
    # Haldane-Anscombe continuity correction: a race with zero passes has no finite logit.
    df["y"] = np.log((df["passes"] + 0.5) / (df["opportunities"] - df["passes"] + 0.5))
    X = sm.add_constant(df[["spread_pct", "nongreen_frac"]].astype(float))
    fit = sm.OLS(df["y"].astype(float), X).fit()
    ref = float(fit.params["const"]
                + fit.params["spread_pct"] * X["spread_pct"].mean()
                + fit.params["nongreen_frac"] * X["nongreen_frac"].mean())
    resid = pd.Series(fit.resid.values, index=df["session_id"].values)
    return fit.params, ref, resid


def odi_from_rate(rate: float) -> float:
    """The fixed log-anchored 0-100 scale of §3.3.3. Absolute: a new circuit moves no one."""
    lo, hi = math.log(config.OTDI_RATE_EASY), math.log(config.OTDI_RATE_HARD)
    r = max(float(rate), 1e-9)
    return float(100.0 * min(max((lo - math.log(r)) / (lo - hi), 0.0), 1.0))


def odi_frame(pass_df: pd.DataFrame, controls: pd.DataFrame, assumption_set_id: int) -> pd.DataFrame:
    """The whole of §3.3.3 as a pure function: rates -> controls -> shrinkage -> scale."""
    if pass_df.empty:
        return frames.empty_frame("circuit_odi")
    races = (pass_df.groupby(["circuit_key", "session_id"], as_index=False)[["passes", "opportunities"]]
             .sum().merge(controls, on="session_id", how="left"))
    params, ref_logit, resid = _fit_controls(races)
    races = races.assign(resid=races["session_id"].map(resid))

    agg = (pass_df.groupby("circuit_key")
           .agg(races=("session_id", "nunique"), passes=("passes", "sum"),
                opportunities=("opportunities", "sum")))
    by_circuit = races.groupby("circuit_key")["resid"]
    agg["resid_mean"] = by_circuit.mean()
    agg = agg.dropna(subset=["resid_mean"])
    agg = agg[agg["races"] >= int(config.OTDI_MIN_RACES)]
    if agg.empty:
        return frames.empty_frame("circuit_odi")

    k = float(config.OTDI_SHRINKAGE_RACES)
    shrink = agg["races"] / (agg["races"] + k)
    agg["resid_shrunk"] = agg["resid_mean"] * shrink
    agg["raw_pass_rate"] = agg["passes"] / agg["opportunities"]
    agg["adj_pass_rate"] = [_sigmoid(ref_logit + r) for r in agg["resid_shrunk"]]
    agg["odi"] = [odi_from_rate(r) for r in agg["adj_pass_rate"]]

    # The band is the shrinkage posterior: the within-circuit spread of race residuals,
    # thinned by the same factor the mean was. A two-race circuit therefore carries a
    # visibly wider band than a three-race one, which is the honest picture (§3.3.3).
    centred = races["resid"] - races["circuit_key"].map(agg["resid_mean"])
    dof = max(len(races) - races["circuit_key"].nunique(), 1)
    within = float((centred.dropna() ** 2).sum() / dof)
    se = np.sqrt(within / agg["races"]) * shrink
    agg["odi_lo"] = [odi_from_rate(_sigmoid(ref_logit + m + 1.96 * s))
                     for m, s in zip(agg["resid_shrunk"], se)]
    agg["odi_hi"] = [odi_from_rate(_sigmoid(ref_logit + m - 1.96 * s))
                     for m, s in zip(agg["resid_shrunk"], se)]
    agg["assumption_set_id"] = int(assumption_set_id)
    log.info("otdi: n_races=%d ref_logit=%.3f params=%s", len(races), ref_logit, dict(params.round(4)))
    return frames.cast_frame(agg.reset_index(), "circuit_odi")


def recompute_odi(conn, assumption_set_id: int) -> int:
    """Rebuild ``circuit_odi`` for every circuit with >= ``OTDI_MIN_RACES`` races.

    DELETE-then-INSERT inside the caller's transaction; no artifact to version (§6.3).
    """
    pass_df = pass_events(conn)
    sids = sorted({int(s) for s in pass_df["session_id"]}) if not pass_df.empty else []
    controls = race_controls(conn, sids) if sids else pd.DataFrame(
        columns=["session_id", "spread_pct", "nongreen_frac"])
    frame = odi_frame(pass_df, controls, int(assumption_set_id))
    with conn.cursor() as cur:
        cur.execute("DELETE FROM circuit_odi")
        n = _copy_frame(cur, "circuit_odi", frame)
    write_status(conn, "circuit_odi", odi_status(conn))
    return n


# ---------------------------------------------------------------------------
# §3.4 safety-car probability and expected pit loss
# ---------------------------------------------------------------------------

_HAZARD_COLUMNS = ("races", "sc_hazard", "vsc_hazard", "sc_hazard_pooled", "vsc_hazard_pooled",
                   "pit_loss_circuit_s", "pit_loss_pooled_s", "pit_loss_pooled_mad_s")


def expected_total_laps(conn, circuit_key: int | None) -> int | None:
    """Median ``sessions.total_laps`` at this circuit's prior races; else pooled median."""
    with conn.cursor() as cur:
        if circuit_key is not None:
            cur.execute(
                "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.total_laps) "
                "FROM sessions s JOIN events e ON e.year = s.year AND e.round = s.round "
                "WHERE s.kind = 'R' AND s.total_laps IS NOT NULL AND e.circuit_key = %s",
                (int(circuit_key),))
            v = cur.fetchone()[0]
            if v is not None:
                return int(round(float(v)))
        cur.execute("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_laps) "
                    "FROM sessions WHERE kind = 'R' AND total_laps IS NOT NULL")
        v = cur.fetchone()[0]
    return int(round(float(v))) if v is not None else None


def hazard_for(conn, circuit_key: int | None, expected_laps: int) -> dict:
    """Shrunk safety-car / VSC probability and expected pit loss for one circuit (§3.4).

    No new fitting: ``sim_circuit_hazard`` is read as-is and only shrunk toward its own
    pooled column, then turned into a per-race probability::

        h_shrunk = (h·races + h_pooled·PREVIEW_HAZARD_PRIOR_RACES) / (races + PRIOR)
        P(>=1)   = 1 - exp(-h_shrunk · expected_total_laps)

    Honest reading (the caption says it): with two or three races per circuit the shrunk
    probabilities span roughly 0.22-0.47 around a pooled 0.30, so what the number mostly
    says is "about one race in three has a safety car". Pit loss is far better
    differentiated because it is measured per stop, not per race.
    """
    if circuit_key is None or not expected_laps:
        return {}
    cols = ", ".join(_HAZARD_COLUMNS)
    with conn.cursor() as cur:
        cur.execute(f"SELECT {cols} FROM sim_circuit_hazard WHERE circuit_key = %s", (int(circuit_key),))
        row = cur.fetchone()
    if row is None:
        return {}
    h = dict(zip(_HAZARD_COLUMNS, row))
    races = int(h["races"])
    prior = float(config.PREVIEW_HAZARD_PRIOR_RACES)
    laps = int(expected_laps)

    def shrunk(key: str, pooled_key: str) -> float:
        return float((float(h[key]) * races + float(h[pooled_key]) * prior) / (races + prior))

    sc = shrunk("sc_hazard", "sc_hazard_pooled")
    vsc = shrunk("vsc_hazard", "vsc_hazard_pooled")
    pit = h["pit_loss_circuit_s"]
    return {
        "races": races,
        "sc_hazard_shrunk": sc,
        "p_safety_car": float(1.0 - math.exp(-sc * laps)),
        "p_vsc": float(1.0 - math.exp(-vsc * laps)),
        "expected_pit_loss_s": float(pit if pit is not None else h["pit_loss_pooled_s"]),
        "pit_loss_source": "circuit" if pit is not None else "pooled",
        "pit_loss_band_s": float(h["pit_loss_pooled_mad_s"]),
    }


# ---------------------------------------------------------------------------
# §3.5 predicted finishing order — the §2 Plackett-Luce model, prior rounds only
# ---------------------------------------------------------------------------

_ORDERS_SQL = """
SELECT s.session_id, s.year, s.round, s.kind, r.driver_id, r.position
  FROM results r
  JOIN sessions s ON s.session_id = r.session_id
 WHERE s.kind IN ('R', 'S') AND r.position IS NOT NULL
   AND (s.year < %s OR (s.year = %s AND s.round < %s))
 ORDER BY s.year, s.round, s.kind DESC, r.position
"""


def past_orders(conn, year: int, round_: int) -> tuple[list[list[str]], list[float]]:
    """Classified finishing orders strictly before ``(year, round_)``, newest last.

    Sprints are included and weighted the same as races (§2.2). The weight is the
    exponential recency weight ``0.5 ** (races_ago / TITLE_PL_HALF_LIFE)``; leakage
    discipline (§3.5.1) is exactly the ``<`` in the SQL above.
    """
    df = _fetch(conn, _ORDERS_SQL, (int(year), int(year), int(round_)),
                columns=["session_id", "year", "round", "kind", "driver_id", "position"])
    if df.empty:
        return ([], [])
    orders: list[list[str]] = []
    for _, grp in df.groupby(["year", "round", "kind"], sort=True):
        orders.append([str(d) for d in grp.sort_values("position")["driver_id"]])
    n = len(orders)
    half = float(config.TITLE_PL_HALF_LIFE)
    weights = [float(0.5 ** ((n - 1 - i) / half)) for i in range(n)]
    return (orders, weights)


def _fit_pl_local(orders, weights, ridge: float) -> dict[str, float]:
    """Fallback Plackett-Luce fit (§2.2) used when ``title.fit_plackett_luce`` is empty.

    L-BFGS-B on the exact analytic gradient of the weighted rank-ordered logit with a
    ridge penalty; ``theta`` is mean-centred afterwards so it is identified.
    """
    from scipy.optimize import minimize

    drivers = sorted({d for o in orders for d in o})
    if not drivers:
        return {}
    idx = {d: i for i, d in enumerate(drivers)}
    seqs = [np.array([idx[d] for d in o], dtype=int) for o in orders]
    w = np.asarray(weights, dtype=float)

    def nll_grad(theta):
        f = 0.0
        g = np.zeros_like(theta)
        for seq, wt in zip(seqs, w):
            t = theta[seq]
            m = t.max()
            tail = np.cumsum(np.exp(t - m)[::-1])[::-1]          # Σ_{j>=i} exp(θ_j - m)
            f -= wt * float(np.sum(t - (np.log(tail) + m)))
            share = np.exp(t - m) * np.cumsum(1.0 / tail)         # ∂/∂θ_i of the log-denominators
            np.add.at(g, seq, wt * (share - 1.0))
        f += ridge * float(theta @ theta)
        g += 2.0 * ridge * theta
        return f, g

    res = minimize(nll_grad, np.zeros(len(drivers)), jac=True, method="L-BFGS-B",
                   options={"maxiter": 500})
    theta = res.x - res.x.mean()
    return {d: float(theta[i]) for d, i in idx.items()}


def fit_strengths(orders, weights) -> dict[str, float]:
    """``title.fit_plackett_luce`` when it is implemented, the local fit otherwise."""
    if not orders:
        return {}
    try:
        theta = title.fit_plackett_luce(orders, weights, config.TITLE_PL_RIDGE)
    except Exception:  # noqa: BLE001 - a half-built §2 must never break the preview
        theta = {}
    if theta:
        return {str(k): float(v) for k, v in theta.items()}
    return _fit_pl_local(orders, weights, float(config.TITLE_PL_RIDGE))


_DNF_SQL = """
SELECT r.driver_id, r.classified_position
  FROM results r JOIN sessions s ON s.session_id = r.session_id
 WHERE s.kind = 'R' AND s.year = %s AND s.round <= %s
"""


def _dnf_rates_local(conn, year: int, upto_round: int) -> dict[str, float]:
    """Beta-binomial shrinkage toward the **current season's** rate (§2.3).

    The season rate is the prior mean rather than an all-time rate because 2026's 19.6%
    is plainly a different regime from 2024's 9.8%.
    """
    df = _fetch(conn, _DNF_SQL, (int(year), int(upto_round)),
                columns=["driver_id", "classified_position"])
    if df.empty:
        return {}
    df["dnf"] = ~df["classified_position"].astype(str).str.fullmatch(r"\d+")
    season_rate = float(df["dnf"].mean())
    prior = float(config.DNF_PRIOR_STRENGTH)
    g = df.groupby("driver_id")["dnf"].agg(["sum", "count"])
    return {str(d): float((row["sum"] + prior * season_rate) / (row["count"] + prior))
            for d, row in g.iterrows()}


def dnf_for(conn, year: int, upto_round: int) -> dict[str, float]:
    """``title.dnf_rates`` when it is implemented, the local shrinkage otherwise."""
    try:
        rates = title.dnf_rates(conn, int(year), int(upto_round))
    except Exception:  # noqa: BLE001
        rates = {}
    return {str(k): float(v) for k, v in rates.items()} if rates else _dnf_rates_local(
        conn, int(year), int(upto_round))


def simulate_order(drivers, theta, dnf, *, draws: int, rng) -> pd.DataFrame:
    """Gumbel-max Plackett-Luce orderings with independent DNF draws (§2.4 steps 1-2).

    Returns one row per driver: ``expected_position`` (mean), the 80% interval
    ``pos_p10``/``pos_p90``, and ``p_win`` / ``p_podium`` / ``p_points``. Retirements are
    appended to the tail of the order in random relative order, which is why a fragile
    car's interval is wide at the bottom rather than its mean merely being worse.
    """
    n = len(drivers)
    if n == 0 or draws <= 0:
        return pd.DataFrame(columns=["driver_id", "expected_position", "pos_p10", "pos_p90",
                                     "p_win", "p_podium", "p_points", "theta", "dnf_rate"])
    t = np.array([float(theta.get(d, 0.0)) for d in drivers])
    p = np.array([float(dnf.get(d, 0.0)) for d in drivers])
    temp = float(config.TITLE_PL_TEMPERATURE)

    score = t + temp * rng.gumbel(size=(draws, n))
    out = rng.random(size=(draws, n)) < p
    # Retirements are pushed behind every survivor, in a random relative order of their own.
    score = np.where(out, -1e6 + rng.random(size=(draws, n)), score)
    order = np.argsort(-score, axis=1, kind="stable")
    pos = np.empty((draws, n), dtype=np.int16)
    np.put_along_axis(pos, order, np.arange(1, n + 1, dtype=np.int16)[None, :].repeat(draws, 0), axis=1)

    return pd.DataFrame({
        "driver_id": list(drivers),
        "expected_position": pos.mean(axis=0),
        "pos_p10": np.percentile(pos, 10, axis=0, method="lower").astype(int),
        "pos_p90": np.percentile(pos, 90, axis=0, method="higher").astype(int),
        "p_win": (pos == 1).mean(axis=0),
        "p_podium": (pos <= 3).mean(axis=0),
        "p_points": (pos <= 10).mean(axis=0),
        "theta": t,
        "dnf_rate": p,
    })


def entry_list(conn, year: int, round_: int) -> list[str]:
    """The field for a round with no results: the entrants of the season's last race."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT r.driver_id FROM results r JOIN sessions s ON s.session_id = r.session_id "
            "WHERE s.kind = 'R' AND s.year = %s AND s.round < %s "
            "AND s.round = (SELECT max(s2.round) FROM sessions s2 JOIN results r2 "
            "               ON r2.session_id = s2.session_id "
            "               WHERE s2.kind = 'R' AND s2.year = %s AND s2.round < %s) "
            "ORDER BY r.driver_id", (int(year), int(round_), int(year), int(round_)))
        return [str(r[0]) for r in cur.fetchall()]


def predict_order(conn, year: int, round_: int, *, draws: int, rng) -> pd.DataFrame:
    """A ``preview_finish_order``-shaped frame for one round, from prior rounds only.

    §3.5: the §2 Plackett-Luce strengths, the shrunk DNF rates and ``draws`` Gumbel-max
    orderings. **No driver-circuit affinity term** — ``PREVIEW_AFFINITY_WEIGHT = 0.0`` is
    a pinned constant recording a MEASURED negative: at 0.3/0.6/1.0 the PL log-likelihood
    moves by at most 0.002 nats and Spearman rho *falls*. With two or three races per
    circuit a driver has about two observations there, so "X is good at Y" is not
    learnable from this database and the preview says so instead of pretending.

    ``assumption_set_id`` is left at 0 for the caller to stamp.
    """
    drivers = entry_list(conn, int(year), int(round_))
    if not drivers:
        return frames.empty_frame("preview_finish_order")
    orders, weights = past_orders(conn, int(year), int(round_))
    if not orders:
        return frames.empty_frame("preview_finish_order")
    theta = fit_strengths(orders, weights)
    dnf = dnf_for(conn, int(year), int(round_) - 1)
    if config.PREVIEW_AFFINITY_WEIGHT:  # pragma: no cover - pinned to 0.0 by a measurement
        raise NotImplementedError("PREVIEW_AFFINITY_WEIGHT is a recorded negative result (§3.5)")
    sim = simulate_order(drivers, theta, dnf, draws=int(draws), rng=rng)
    sim["year"] = int(year)
    sim["round"] = int(round_)
    sim["assumption_set_id"] = 0
    sim["draws"] = int(draws)
    return frames.cast_frame(sim, "preview_finish_order")


# ---------------------------------------------------------------------------
# §3.5.1 the rolling-origin backtest that produces the quoted accuracy number
# ---------------------------------------------------------------------------

_RACED_SQL = """
SELECT s.year, s.round, s.session_id
  FROM sessions s
 WHERE s.kind = 'R' AND EXISTS (SELECT 1 FROM results r WHERE r.session_id = s.session_id)
   AND (s.year > %s OR (s.year = %s AND s.round >= %s))
 ORDER BY s.year, s.round
"""


def backtest(conn, *, from_year: int, from_round: int) -> pd.DataFrame:
    """What the preview *would have* said for each already-raced round (§3.5.1).

    Rolling origin: for every raced round from ``(from_year, from_round)`` onward the
    strengths, the DNF rates and the field are all taken from rounds strictly before it,
    and the prediction is stored next to what actually happened. ``actual_position`` is
    NULL for a retirement, and such a row is not counted as covered — an interval that
    quietly excused its own misses would be decoration.
    """
    rounds = _fetch(conn, _RACED_SQL, (int(from_year), int(from_year), int(from_round)),
                    columns=["year", "round", "session_id"])
    rng = np.random.default_rng(int(config.TITLE_SEED))
    out = []
    for yr, rd, sid in rounds.itertuples(index=False, name=None):
        pred = predict_order(conn, int(yr), int(rd), draws=int(config.PREVIEW_SIM_DRAWS), rng=rng)
        if pred.empty:
            continue
        actual = _fetch(conn, "SELECT driver_id, position, classified_position FROM results "
                              "WHERE session_id = %s", (int(sid),),
                        columns=["driver_id", "position", "classified_position"])
        # results.position is populated for retirements too (they are ordered behind the
        # finishers), but a retirement has no finishing position to fall inside an
        # interval, so the DDL stores NULL and the coverage denominator excludes it.
        finished = actual["classified_position"].astype(str).str.fullmatch(r"\d+")
        actual["position"] = actual["position"].where(finished, other=None)
        df = pred.merge(actual.drop(columns=["classified_position"]), on="driver_id", how="left")
        pos = pd.to_numeric(df["position"], errors="coerce")
        df["actual_position"] = pos
        df["inside_interval"] = (pos.notna() & (pos >= df["pos_p10"]) & (pos <= df["pos_p90"]))
        df["pred_kind"] = "oof"
        out.append(df[["year", "round", "assumption_set_id", "driver_id", "pred_kind",
                       "expected_position", "pos_p10", "pos_p90", "actual_position",
                       "inside_interval"]])
    if not out:
        return frames.empty_frame("preview_backtest")
    return frames.cast_frame(pd.concat(out, ignore_index=True), "preview_backtest")


def backtest_summary(conn, bt: pd.DataFrame) -> dict:
    """Rank accuracy, the grid-order comparison and the empirical interval coverage.

    The grid comparison is in the caption on purpose: **a dumber method beats this one
    when it is available.** Ordering by the starting grid scores a higher rho than the
    model — but a future round has no grid, because qualifying has not happened, so the
    model's number is the honest ceiling for a preview (§2.2, §3.5.1).
    """
    if bt.empty:
        return {"backtest_spearman": None, "backtest_grid_spearman": None,
                "backtest_coverage": None, "backtest_races": 0}
    grid = _fetch(conn, "SELECT s.year, s.round, r.driver_id, r.grid_position, r.position "
                        "FROM results r JOIN sessions s ON s.session_id = r.session_id "
                        "WHERE s.kind = 'R' AND r.classified_position ~ '^[0-9]+$'",
                  columns=["year", "round", "driver_id", "grid_position", "position"])
    rhos, grid_rhos = [], []
    for (yr, rd), grp in bt.groupby(["year", "round"], sort=True):
        d = grp.dropna(subset=["actual_position"])
        if len(d) >= 3:
            rhos.append(float(pd.Series(d["expected_position"].astype(float).values).corr(
                pd.Series(d["actual_position"].astype(float).values), method="spearman")))
        g = grid[(grid["year"] == yr) & (grid["round"] == rd)].dropna(
            subset=["grid_position", "position"])
        if len(g) >= 3:
            grid_rhos.append(float(pd.Series(g["grid_position"].astype(float).values).corr(
                pd.Series(g["position"].astype(float).values), method="spearman")))
    return {
        "backtest_spearman": float(np.nanmean(rhos)) if rhos else None,
        "backtest_grid_spearman": float(np.nanmean(grid_rhos)) if grid_rhos else None,
        "backtest_coverage": (float(bt.loc[bt["actual_position"].notna(), "inside_interval"]
                                    .astype(bool).mean())
                              if bt["actual_position"].notna().any() else None),
        "backtest_races": int(bt.groupby(["year", "round"]).ngroups),
    }


# ---------------------------------------------------------------------------
# §3.6 / §6.3 the recompute
# ---------------------------------------------------------------------------

_SCHEDULED_SQL = """
SELECT e.year, e.round
  FROM events e
 WHERE NOT EXISTS (
         SELECT 1 FROM sessions s JOIN results r ON r.session_id = s.session_id
          WHERE s.year = e.year AND s.round = e.round AND s.kind = 'R')
 ORDER BY e.year, e.round
"""


def _loco_brier(conn) -> float | None:
    """WP1's leave-one-circuit-out Brier, or NULL until it lands.

    For a brand-new venue the honest accuracy figure is ``loco`` — "tracks it has never
    visited" — not ``loro``; the two answer different questions and the preview asks the
    second (§3.5.1).
    """
    variant = "isotonic" if str(config.WP_CALIBRATION) == "isotonic" else "plain"
    with conn.cursor() as cur:
        cur.execute("SELECT brier FROM wp_metrics WHERE scope = 'loco' AND variant = %s "
                    "ORDER BY assumption_set_id DESC LIMIT 1", (variant,))
        row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None


def _preview_round_row(conn, year: int, round_: int, asid: int, summary: dict,
                       odi: pd.DataFrame, loco: float | None, now) -> dict:
    ckey, match = resolve_circuit(conn, int(year), int(round_))
    laps = expected_total_laps(conn, ckey)
    haz = hazard_for(conn, ckey, laps or 0)
    o = odi.loc[odi["circuit_key"] == ckey] if ckey is not None and not odi.empty else odi.iloc[0:0]
    row = {
        "year": int(year), "round": int(round_), "assumption_set_id": int(asid),
        "circuit_key": ckey, "circuit_match": match,
        "circuit_races": int(haz.get("races", 0)),
        "expected_total_laps": laps if ckey is not None else None,
        "p_safety_car": haz.get("p_safety_car"), "sc_hazard_shrunk": haz.get("sc_hazard_shrunk"),
        "p_vsc": haz.get("p_vsc"), "expected_pit_loss_s": haz.get("expected_pit_loss_s"),
        "pit_loss_band_s": haz.get("pit_loss_band_s"),
        "odi": float(o["odi"].iloc[0]) if len(o) else None,
        "odi_lo": float(o["odi_lo"].iloc[0]) if len(o) else None,
        "odi_hi": float(o["odi_hi"].iloc[0]) if len(o) else None,
        "loco_brier": loco, "computed_at": now,
    }
    row.update(summary)
    return row


def recompute_preview(conn, assumption_set_id: int) -> dict[str, int]:
    """Rebuild ``preview_round`` / ``preview_finish_order`` / ``preview_backtest``.

    A pure recompute from stored rows, idempotent by DELETE-then-INSERT inside the
    caller's transaction; there is no artifact to version (§6.3). A round that does not
    resolve to a circuit still gets its row and its predicted order — the finishing-order
    model needs no circuit data at all — with the circuit-dependent columns NULL so the
    page can render the "first running at this venue" empty state deliberately (§3.6).
    """
    asid = int(assumption_set_id)
    now = dt.datetime.now(dt.timezone.utc)
    scheduled = _fetch(conn, _SCHEDULED_SQL, columns=["year", "round"])
    odi = _fetch(conn, "SELECT circuit_key, odi, odi_lo, odi_hi FROM circuit_odi",
                 columns=["circuit_key", "odi", "odi_lo", "odi_hi"])
    bt = backtest(conn, from_year=int(config.PREVIEW_BACKTEST_FROM[0]),
                  from_round=int(config.PREVIEW_BACKTEST_FROM[1]))
    bt["assumption_set_id"] = asid
    summary = backtest_summary(conn, bt)
    loco = _loco_brier(conn)

    rng = np.random.default_rng(int(config.TITLE_SEED))
    rows, orders = [], []
    for yr, rd in scheduled.itertuples(index=False, name=None):
        rows.append(_preview_round_row(conn, int(yr), int(rd), asid, summary, odi, loco, now))
        fo = predict_order(conn, int(yr), int(rd), draws=int(config.PREVIEW_SIM_DRAWS), rng=rng)
        if not fo.empty:
            fo["assumption_set_id"] = asid
            orders.append(fo)

    pr = frames.cast_frame(pd.DataFrame(rows), "preview_round") if rows else frames.empty_frame(
        "preview_round")
    fo_all = (frames.cast_frame(pd.concat(orders, ignore_index=True), "preview_finish_order")
              if orders else frames.empty_frame("preview_finish_order"))
    with conn.cursor() as cur:
        for t in ("preview_backtest", "preview_finish_order", "preview_round"):
            cur.execute(f"DELETE FROM {t}")
        counts = {"preview_round": _copy_frame(cur, "preview_round", pr),
                  "preview_finish_order": _copy_frame(cur, "preview_finish_order", fo_all),
                  "preview_backtest": _copy_frame(cur, "preview_backtest", bt)}
    write_status(conn, "preview", preview_status(conn))
    log.info("preview: %s summary=%s", counts, summary)
    return counts


# ---------------------------------------------------------------------------
# §5.5 the two run-end analytics_status keys
# ---------------------------------------------------------------------------

def write_status(conn, key: str, statuses: dict[int, str]) -> int:
    """Merge one ``analytics_status`` key into ``session_ingests`` for these sessions.

    ``circuit_odi`` and ``preview`` are cross-race analytics, so they are **not** in
    ``frames.ANALYTICS`` (which is what ``_guard`` iterates inside ``build_race_frames``)
    and must write their own row from the run-end step (§5.5). This only merges a key
    into the stored jsonb; ``session_ingests.status`` is decided at ingest time and is
    not rewritten here.
    """
    from psycopg.types.json import Jsonb

    if not statuses:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE session_ingests SET analytics_status = "
            "coalesce(analytics_status, '{}'::jsonb) || %s::jsonb WHERE session_id = %s",
            [(Jsonb({key: v}), int(sid)) for sid, v in statuses.items()])
    return len(statuses)


def odi_status(conn) -> dict[int, str]:
    """``ok`` for a race session whose circuit carries an index, ``empty`` otherwise."""
    df = _fetch(conn,
                "SELECT s.session_id, (o.circuit_key IS NOT NULL) AS has_odi "
                "FROM sessions s "
                "JOIN session_ingests si ON si.session_id = s.session_id "
                "JOIN events e ON e.year = s.year AND e.round = s.round "
                "LEFT JOIN circuit_odi o ON o.circuit_key = e.circuit_key "
                # a session whose ingest FAILED carries analytics_status '{}' (SPEC §2.5,
                # docs/SPEC.md:864) and is not one of the race sessions D48 scopes this key
                # to; without this filter the run-end step merged 'ok' onto a failed row.
                "WHERE s.kind = 'R' AND si.status <> 'failed'", columns=["session_id", "has_odi"])
    return {int(sid): ("ok" if bool(h) else "empty") for sid, h in
            zip(df["session_id"], df["has_odi"])}


def preview_status(conn) -> dict[int, str]:
    """``ok`` for the race session of a round that has a stored preview row.

    A scheduled round normally has no ``session_ingests`` row at all — nothing has been
    ingested for it — so this writes nothing today. It exists so that a round previewed
    *and* partially ingested carries the key rather than silently lacking it.
    """
    df = _fetch(conn,
                "SELECT s.session_id FROM sessions s "
                "JOIN session_ingests si ON si.session_id = s.session_id "
                "JOIN preview_round p ON p.year = s.year AND p.round = s.round "
                # same reason as odi_status: a failed ingest advertises no successful analytic.
                "WHERE s.kind = 'R' AND si.status <> 'failed'", columns=["session_id"])
    return {int(sid): "ok" for sid in df["session_id"]}
