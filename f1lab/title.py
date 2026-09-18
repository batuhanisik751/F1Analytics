"""Title odds (Monte Carlo) and magic numbers (exact arithmetic) — MODE1_SPEC §2.

The two halves are computed by different machinery on purpose (FD4): ``clinch_table``
is integer arithmetic over the points that can still be scored — a clinch is a fact —
while ``simulate`` is a Plackett-Luce Monte Carlo — a forecast. They are reconciled
only in the one direction §2.6 allows: an arithmetically eliminated driver is excluded
from the championship ranking of the simulation, so its ``p_title`` is exactly 0.

The one number this module turns on is the points schedule (§2.1 / §0.4): the
fastest-lap bonus exists in 2024 only, so the maximum is derived **per season** from
that season's own results, never from a pooled global constant.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from psycopg import sql
from scipy.optimize import minimize

from . import config, frames

COUNTBACK_POSITIONS = 20


def _read(conn, query: str, params: tuple = ()) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(query, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


@dataclass(frozen=True)
class PointsSchedule:
    """One season's points schedule, derived from that season's own results (§2.1)."""

    year: int
    race_points: tuple[int, ...]        # index 0 = P1
    sprint_points: tuple[int, ...]
    has_fastest_lap_bonus: bool
    max_race_points: int                # race_points[0] + (1 if bonus else 0)
    max_sprint_points: int              # sprint_points[0]

    def race_points_at(self, position: int) -> int:
        """Points for finishing ``position`` in a race (0 outside the schedule)."""
        idx = int(position) - 1
        if idx < 0 or idx >= len(self.race_points):
            return 0
        return int(self.race_points[idx])

    def sprint_points_at(self, position: int) -> int:
        idx = int(position) - 1
        if idx < 0 or idx >= len(self.sprint_points):
            return 0
        return int(self.sprint_points[idx])


def _schedule_rows(conn, year: int, kind: str) -> pd.DataFrame:
    return _read(conn, """
        SELECT r.position, min(r.points) AS min_points, count(DISTINCT r.points) AS n_distinct
        FROM results r JOIN sessions s ON s.session_id = r.session_id
        WHERE s.year = %s AND s.kind = %s AND r.position IS NOT NULL
        GROUP BY r.position ORDER BY r.position""", (year, kind))


def _schedule_from_rows(year: int, race: pd.DataFrame, sprint: pd.DataFrame) -> PointsSchedule:
    def ladder(df: pd.DataFrame) -> tuple[int, ...]:
        if df.empty:
            return ()
        top = int(df["position"].max())
        by_pos = {int(p): int(v) for p, v in zip(df["position"], df["min_points"])}
        return tuple(by_pos.get(p, 0) for p in range(1, top + 1))

    race_points = ladder(race)
    sprint_points = ladder(sprint)
    # §2.1 step 2: the bonus is "some position carries more than one distinct points
    # value", never "max == 26" — the latter fails when the bonus never lands on P1.
    bonus = bool(not race.empty and (race["n_distinct"] > 1).any())
    return PointsSchedule(
        year=int(year), race_points=race_points, sprint_points=sprint_points,
        has_fastest_lap_bonus=bonus,
        max_race_points=(race_points[0] if race_points else 0) + (1 if bonus else 0),
        max_sprint_points=sprint_points[0] if sprint_points else 0,
    )


def points_schedule(conn, year: int) -> PointsSchedule:
    """Derive ``year``'s points schedule from that season's own results (§2.1).

    Falls back to the most recent derivable season when ``year`` has no race results,
    and to ``config.POINTS_SCHEDULE_OVERRIDES[year]`` when one is configured.
    """
    override = getattr(config, "POINTS_SCHEDULE_OVERRIDES", {}).get(int(year))
    if override is not None:
        return override if isinstance(override, PointsSchedule) else PointsSchedule(*override)
    race = _schedule_rows(conn, year, "R")
    if race.empty:
        prior = _read(conn, """
            SELECT DISTINCT s.year FROM results r JOIN sessions s ON s.session_id = r.session_id
            WHERE s.kind = 'R' AND s.year < %s ORDER BY s.year DESC LIMIT 1""", (year,))
        if prior.empty:
            return PointsSchedule(int(year), (), (), False, 0, 0)
        src = int(prior["year"].iloc[0])
        fallback = _schedule_from_rows(src, _schedule_rows(conn, src, "R"), _schedule_rows(conn, src, "S"))
        return PointsSchedule(int(year), fallback.race_points, fallback.sprint_points,
                              fallback.has_fastest_lap_bonus, fallback.max_race_points,
                              fallback.max_sprint_points)
    return _schedule_from_rows(year, race, _schedule_rows(conn, year, "S"))


# ---------------------------------------------------------------------------
# §2.5 Magic numbers — exact integer arithmetic, never the Monte Carlo
# ---------------------------------------------------------------------------

def _calendar(conn, year: int) -> pd.DataFrame:
    """One row per round of ``year``: round, has_race, has_sprint."""
    return _read(conn, """
        SELECT e.round,
               count(*) FILTER (WHERE s.kind = 'R') AS races,
               count(*) FILTER (WHERE s.kind = 'S') AS sprints
        FROM events e LEFT JOIN sessions s ON s.year = e.year AND s.round = e.round
        WHERE e.year = %s GROUP BY e.round ORDER BY e.round""", (year,))


def _max_points_for_round(cal: pd.DataFrame, rnd: int, schedule: PointsSchedule) -> int:
    row = cal[cal["round"] == rnd]
    if row.empty:
        return 0
    races = int(row["races"].iloc[0] or 0)
    sprints = int(row["sprints"].iloc[0] or 0)
    return schedule.max_race_points * min(races, 1) + schedule.max_sprint_points * min(sprints, 1)


def max_available(cal: pd.DataFrame, after_round: int, schedule: PointsSchedule) -> int:
    """``M(k)`` of §2.5 — every point still on the table after round ``k``."""
    return sum(_max_points_for_round(cal, int(r), schedule)
               for r in cal["round"] if int(r) > int(after_round))


def _clinch_position(p_lead: int, p_rival: int, m_next: int, schedule: PointsSchedule) -> int | None:
    """Worst race finish that still clinches at the next (conventional) round (§2.5)."""
    bonus = 1 if schedule.has_fastest_lap_bonus else 0
    best = None
    for p in range(1, len(schedule.race_points) + 1):
        rival_best = schedule.race_points_at(2 if p == 1 else 1) + bonus
        if (p_lead + schedule.race_points_at(p)) - (p_rival + rival_best) > m_next:
            best = p
    return best


def _earliest_clinch_round(cal: pd.DataFrame, after_round: int, gap: int,
                           schedule: PointsSchedule) -> int | None:
    """Smallest k' > k at which the leader could clinch in the best case (§2.5)."""
    taken = 0
    for r in [int(x) for x in cal["round"] if int(x) > int(after_round)]:
        taken += _max_points_for_round(cal, r, schedule)
        if gap + taken > max_available(cal, r, schedule):
            return r
    return None


def clinch_table(conn, year: int, after_round: int, schedule: PointsSchedule) -> pd.DataFrame:
    """The exact-arithmetic half of §2 for one ``(year, after_round)`` snapshot.

    Nothing here consults the Monte Carlo. ``assumption_set_id`` is left unset and is
    filled in by :func:`recompute_title` before the frame is written.
    """
    stand = _read(conn, "SELECT after_round, driver_id, points, position FROM driver_standings "
                        "WHERE year = %s AND after_round <= %s", (year, after_round))
    now = stand[stand["after_round"] == int(after_round)]
    if now.empty:
        return frames.empty_frame("title_clinch")
    cal = _calendar(conn, year)
    m_now = max_available(cal, after_round, schedule)
    pts = {str(d): int(p) for d, p in zip(now["driver_id"], now["points"])}
    leader_points = max(pts.values())
    leaders = [d for d, p in pts.items() if p == leader_points]
    leader_id = str(now.sort_values("position")["driver_id"].iloc[0]) if len(leaders) > 1 else leaders[0]
    rest = sorted((p for d, p in pts.items() if d != leader_id), reverse=True)
    runner_up = rest[0] if rest else 0
    gap = leader_points - runner_up

    rounds = [int(r) for r in cal["round"]]
    next_round = min((r for r in rounds if r > int(after_round)), default=None)
    m_next = max_available(cal, next_round, schedule) if next_round is not None else None
    next_sprint = bool(next_round is not None and
                       int(cal.loc[cal["round"] == next_round, "sprints"].iloc[0] or 0) > 0)
    clinch_margin = (m_next + 1) if m_next is not None else None
    swing = (clinch_margin - gap) if clinch_margin is not None else None
    clinch_pos = (None if (next_round is None or next_sprint)
                  else _clinch_position(leader_points, runner_up, m_next, schedule))
    earliest = _earliest_clinch_round(cal, after_round, gap, schedule)
    clinched = gap > m_now

    # eliminated_at_round: the first round at which P_i + M(k') < P_L(k') became true.
    elim_at: dict[str, int] = {}
    for k in sorted({int(r) for r in stand["after_round"]}):
        snap = stand[stand["after_round"] == k]
        if snap.empty:
            continue
        lead_k = int(snap["points"].max())
        m_k = max_available(cal, k, schedule)
        for d, p in zip(snap["driver_id"], snap["points"]):
            if int(p) + m_k < lead_k:
                elim_at.setdefault(str(d), k)

    rows = []
    for d in sorted(pts):
        p = pts[d]
        is_lead = d == leader_id
        rows.append({
            "year": int(year), "after_round": int(after_round), "assumption_set_id": None,
            "driver_id": d, "points_now": p, "max_available": m_now,
            "max_possible_total": p + m_now, "leader_points": leader_points,
            "is_eliminated": bool(p + m_now < leader_points),
            "eliminated_at_round": elim_at.get(d),
            "has_clinched": bool(is_lead and (clinched or m_now == 0)),
            "clinch_margin_needed": clinch_margin if is_lead else None,
            "swing_needed": swing if is_lead else None,
            "clinch_position": clinch_pos if is_lead else None,
            "earliest_clinch_round": earliest if is_lead else None,
            "next_round_has_sprint": next_sprint,
            "race_points_max": schedule.max_race_points,
            "sprint_points_max": schedule.max_sprint_points,
            "has_fastest_lap_bonus": schedule.has_fastest_lap_bonus,
        })
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["title_clinch"])


# ---------------------------------------------------------------------------
# §2.2 Plackett-Luce latent strength
# ---------------------------------------------------------------------------

def _pad_orders(orders, index: dict[str, int]) -> tuple[np.ndarray, np.ndarray]:
    """Padded (n_orders, max_len) driver-index matrix and its validity mask."""
    width = max((len(o) for o in orders), default=0)
    idx = np.zeros((len(orders), width), dtype=np.int64)
    mask = np.zeros((len(orders), width), dtype=bool)
    for r, order in enumerate(orders):
        for c, d in enumerate(order):
            idx[r, c] = index[d]
            mask[r, c] = True
    return idx, mask


def _pl_objective(theta: np.ndarray, idx: np.ndarray, mask: np.ndarray,
                  w: np.ndarray, ridge: float) -> tuple[float, np.ndarray]:
    """Weighted negative PL log-likelihood + ridge, and its exact analytic gradient."""
    t = np.where(mask, theta[idx], -np.inf)
    s = np.logaddexp.accumulate(t[:, ::-1], axis=1)[:, ::-1]      # s[:, i] = logsumexp(t[:, i:])
    ll = float((w * (np.where(mask, t, 0.0).sum(1) - np.where(mask, s, 0.0).sum(1))).sum())
    inv = np.where(mask, np.exp(-np.where(mask, s, 0.0)), 0.0)
    g = np.where(mask, 1.0 - np.exp(np.where(mask, t, 0.0)) * np.cumsum(inv, axis=1), 0.0)
    grad = np.zeros_like(theta)
    np.add.at(grad, idx[mask], (w[:, None] * g)[mask])
    return -ll + ridge * float(theta @ theta), -grad + 2.0 * ridge * theta


def fit_plackett_luce(orders, weights, ridge: float) -> dict[str, float]:
    """Fit mean-centred latent strengths θ by L-BFGS-B on the exact gradient (§2.2)."""
    orders = [list(o) for o in orders if len(o) >= 2]
    weights = list(weights)[: len(orders)]
    drivers = sorted({d for o in orders for d in o})
    if not drivers or not orders:
        return {}
    index = {d: i for i, d in enumerate(drivers)}
    idx, mask = _pad_orders(orders, index)
    w = np.asarray(weights, dtype=float)
    res = minimize(_pl_objective, np.zeros(len(drivers)), args=(idx, mask, w, float(ridge)),
                   jac=True, method="L-BFGS-B")
    theta = np.asarray(res.x, dtype=float)
    theta = theta - theta.mean()
    return {d: float(theta[i]) for d, i in index.items()}


def finishing_orders(conn, year: int, upto_round: int) -> tuple[list[list[str]], list[float]]:
    """Classified finishing orders of every race/sprint strictly before ``(year, upto_round)``.

    Sprints count the same as races (§2.2); the weight is the exponential recency
    weight ``0.5 ** (races_ago / TITLE_PL_HALF_LIFE)`` over the session sequence.
    """
    res = _read(conn, """
        SELECT s.year, s.round, s.kind, s.session_id, r.driver_id, r.position, r.classified_position
        FROM results r JOIN sessions s ON s.session_id = r.session_id
        WHERE s.kind IN ('R', 'S') AND (s.year < %s OR (s.year = %s AND s.round <= %s))
        ORDER BY s.year, s.round, s.kind, r.position""", (year, year, upto_round))
    if res.empty:
        return [], []
    res = res[res["classified_position"].astype(str).str.fullmatch(r"\d+") & res["position"].notna()]
    keys, orders = [], []
    for key, grp in res.groupby(["year", "round", "kind"], sort=True):
        grp = grp.sort_values("position")
        drivers = [str(d) for d in grp["driver_id"]]
        if len(drivers) >= 2:
            keys.append(key)
            orders.append(drivers)
    order = sorted(range(len(keys)), key=lambda i: keys[i])
    orders = [orders[i] for i in order]
    n = len(orders)
    half = float(config.TITLE_PL_HALF_LIFE)
    weights = [0.5 ** ((n - 1 - i) / half) for i in range(n)]
    return orders, weights


# ---------------------------------------------------------------------------
# §2.3 DNF model — beta-binomial shrinkage toward the current season's rate
# ---------------------------------------------------------------------------

def season_dnf_rate(conn, year: int, upto_round: int) -> float:
    df = _read(conn, """
        SELECT r.classified_position FROM results r JOIN sessions s ON s.session_id = r.session_id
        WHERE s.kind = 'R' AND s.year = %s AND s.round <= %s""", (year, upto_round))
    if df.empty:
        return 0.0
    finished = df["classified_position"].astype(str).str.fullmatch(r"\d+")
    return float((~finished).mean())


def dnf_rates(conn, year: int, upto_round: int) -> dict[str, float]:
    """Per-driver DNF rate, shrunk toward the season rate with a 10-race prior (§2.3)."""
    df = _read(conn, """
        SELECT r.driver_id, r.classified_position FROM results r
        JOIN sessions s ON s.session_id = r.session_id
        WHERE s.kind = 'R' AND s.year = %s AND s.round <= %s""", (year, upto_round))
    rate = season_dnf_rate(conn, year, upto_round)
    if df.empty:
        return {}
    df = df.assign(dnf=~df["classified_position"].astype(str).str.fullmatch(r"\d+"))
    k = float(config.DNF_PRIOR_STRENGTH)
    grp = df.groupby("driver_id")["dnf"].agg(["sum", "count"])
    return {str(d): float((row["sum"] + k * rate) / (row["count"] + k))
            for d, row in grp.iterrows()}


# ---------------------------------------------------------------------------
# §2.4 The Monte Carlo
# ---------------------------------------------------------------------------

def _ladder(points: tuple[int, ...], n: int) -> np.ndarray:
    out = np.zeros(n, dtype=np.float64)
    out[: min(n, len(points))] = np.asarray(points[:n], dtype=np.float64)
    return out


def _pl_scores(theta: np.ndarray, dn: np.ndarray, rng, draws: int, temperature: float
               ) -> tuple[np.ndarray, np.ndarray]:
    """Gumbel-max Plackett-Luce scores per draw, plus the "was running" mask (§2.4 1-2).

    Retirements are drawn first and scored below every survivor, in random relative
    order, so sorting the scores puts them at the tail where they score nothing.
    """
    th = np.atleast_2d(theta)
    n = th.shape[1]
    survive = rng.random((draws, n)) >= dn[None, :]
    score = th + rng.gumbel(0.0, temperature, size=(draws, n))
    return np.where(survive, score, -1e9 - rng.random((draws, n))), survive


def _accumulate_counts(counts: np.ndarray, order: np.ndarray, running: np.ndarray) -> None:
    """Add one to ``counts[draw, driver, position]`` for every classified finish (§2.4 step 5)."""
    draws, n, positions = counts.shape
    head, ok = order[:, :positions], running[:, :positions]
    if not ok.any():
        return
    dra = np.broadcast_to(np.arange(draws)[:, None], head.shape)
    pos = np.broadcast_to(np.arange(head.shape[1])[None, :], head.shape)
    flat = ((dra[ok] * n) + head[ok]) * positions + pos[ok]
    counts += np.bincount(flat, minlength=draws * n * positions).reshape(counts.shape).astype(counts.dtype)


def _top_k(score: np.ndarray, k: int) -> np.ndarray:
    """The ``k`` best-scoring driver indices per draw, in finishing order."""
    if k >= score.shape[1]:
        return np.argsort(-score, axis=1)
    part = np.argpartition(-score, k, axis=1)[:, :k]
    return np.take_along_axis(part, np.argsort(-np.take_along_axis(score, part, axis=1), axis=1), axis=1)


def _run_rounds(th, dn, remaining, schedule, rng, total, counts, *, race_ladder,
                sprint_ladder, temperature) -> None:
    """Draw every remaining round in place (§2.4 steps 1-4).

    ``th`` is either one θ vector or one per draw; ``counts`` may be ``None`` when the
    caller only needs points (the bootstrap band, which reads ``p_title`` alone) — in
    that case only the scoring positions are ordered, which is the same arithmetic for
    strictly less work.
    """
    d_n, n = total.shape
    rows = np.arange(d_n)[:, None]
    n_scoring = max(int(np.count_nonzero(race_ladder)), 10 if schedule.has_fastest_lap_bonus else 0)
    k_race = n if counts is not None else min(n, max(n_scoring, 1))
    k_sprint = n if counts is not None else min(n, max(int(np.count_nonzero(sprint_ladder)), 1))
    for rnd in remaining:
        if rnd.get("has_race", True):
            score, survive = _pl_scores(th, dn, rng, d_n, temperature)
            order = _top_k(score, k_race)
            running = np.take_along_axis(survive, order, axis=1)
            total[rows, order] += np.where(running, race_ladder[None, :order.shape[1]], 0.0)
            if schedule.has_fastest_lap_bonus:
                top = order[:, : min(10, order.shape[1])]
                total[np.arange(d_n), top[np.arange(d_n), rng.integers(0, top.shape[1], size=d_n)]] += 1.0
            if counts is not None:
                _accumulate_counts(counts, order, running)
        if rnd.get("has_sprint", False):
            s_score, s_survive = _pl_scores(th, dn, rng, d_n, temperature)
            s_order = _top_k(s_score, k_sprint)
            s_running = np.take_along_axis(s_survive, s_order, axis=1)
            total[rows, s_order] += np.where(s_running, sprint_ladder[None, :s_order.shape[1]], 0.0)


_KEY_POSITIONS = 4          # countback positions packed into the sortable key
_KEY_CAP = 63


def _composite_key(total: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """Points-then-countback sort key, exact in int64 (§2.4 step 5)."""
    key = np.rint(total).astype(np.int64) << (6 * _KEY_POSITIONS)
    for i in range(_KEY_POSITIONS):
        key += np.minimum(counts[:, :, i], _KEY_CAP).astype(np.int64) << (6 * (_KEY_POSITIONS - 1 - i))
    return key


def _resolve_champion(key: np.ndarray, counts: np.ndarray, alive: np.ndarray,
                      drivers: list[str]) -> np.ndarray:
    """Champion driver index per draw: best key among the alive, ties by full countback."""
    masked = np.where(alive[None, :], key, np.iinfo(np.int64).min)
    best = masked.max(axis=1)
    tied = masked == best[:, None]
    champ = np.argmax(tied, axis=1)
    for d in np.flatnonzero(tied.sum(axis=1) > 1):
        cands = np.flatnonzero(tied[d])
        champ[d] = min(cands, key=lambda i: (tuple(-int(c) for c in counts[d, i]), drivers[i]))
    return champ


def simulate(theta, dnf, remaining, schedule, *, draws, rng,
             points_now=None, countback_now=None, eliminated=()) -> pd.DataFrame:
    """Monte-Carlo the remaining calendar (§2.4).

    ``remaining`` is a list of ``{'round': int, 'has_race': bool, 'has_sprint': bool}``.
    ``points_now`` / ``countback_now`` are the standings this snapshot starts from
    (``driver_standings.points`` already includes historical sprint points, §2.4), and
    ``eliminated`` are the drivers the arithmetic has already knocked out — they are
    excluded from the championship ranking rather than relied on to lose every draw
    (§2.6). Returns one row per driver with the §2.4.1 summaries.
    """
    points_now = dict(points_now or {})
    drivers = sorted(set(theta) | set(points_now))
    n, d_n = len(drivers), int(draws)
    cols = ["driver_id", "p_title", "p_top3", "expected_points", "points_p10", "points_p90",
            "mc_stderr"]
    if n == 0 or d_n <= 0:
        return pd.DataFrame(columns=cols)
    th = np.array([float(theta.get(x, 0.0)) for x in drivers])
    dn = np.array([float(dnf.get(x, 0.0)) for x in drivers])
    start = np.array([float(points_now.get(x, 0.0)) for x in drivers])
    total = np.tile(start, (d_n, 1))
    counts = np.zeros((d_n, n, COUNTBACK_POSITIONS), dtype=np.int16)
    if countback_now:
        for i, x in enumerate(drivers):
            for p, c in enumerate(countback_now.get(x, ())[:COUNTBACK_POSITIONS]):
                counts[:, i, p] += int(c)
    race_ladder = _ladder(schedule.race_points, n)
    sprint_ladder = _ladder(schedule.sprint_points, n)
    temp = float(config.TITLE_PL_TEMPERATURE)

    _run_rounds(th, dn, remaining, schedule, rng, total, counts,
                race_ladder=race_ladder, sprint_ladder=sprint_ladder, temperature=temp)

    key = _composite_key(total, counts)
    alive = np.array([x not in set(eliminated) for x in drivers])
    champ = _resolve_champion(key, counts, alive, drivers) if alive.any() else None
    p_title = (np.bincount(champ, minlength=n) / d_n) if champ is not None else np.zeros(n)
    standing = 1 + (key[:, :, None] < key[:, None, :]).sum(axis=2)
    p_top3 = (standing <= 3).mean(axis=0)
    return pd.DataFrame({
        "driver_id": drivers, "p_title": p_title, "p_top3": p_top3,
        "expected_points": total.mean(axis=0),
        "points_p10": np.percentile(total, 10, axis=0),
        "points_p90": np.percentile(total, 90, axis=0),
        "mc_stderr": np.sqrt(np.maximum(p_title * (1 - p_title), 0.0) / d_n),
    }, columns=cols)


def _bootstrap_band(orders, weights, drivers, dnf, remaining, schedule, *, points_now,
                    countback_now, eliminated, rng) -> tuple[np.ndarray, np.ndarray]:
    """2.5 / 97.5 percentiles of ``p_title`` over ``TITLE_THETA_BOOTSTRAP`` refits (§2.4.1).

    The band covers **model** uncertainty (θ), not Monte-Carlo error; the latter is
    stored separately as ``mc_stderr``. Only ``p_title`` is needed here, so the draws
    skip the countback bookkeeping and the bootstraps are run in stacked batches.
    """
    reps = int(config.TITLE_THETA_BOOTSTRAP)
    sub = max(1, int(config.TITLE_SIM_DRAWS) // 20)
    n_orders, n = len(orders), len(drivers)
    if reps <= 0 or n_orders == 0 or n == 0:
        return np.zeros(n), np.zeros(n)
    dn = np.array([float(dnf.get(d, 0.0)) for d in drivers])
    start = np.array([float(points_now.get(d, 0.0)) for d in drivers])
    alive = np.array([d not in set(eliminated) for d in drivers])
    race_ladder, sprint_ladder = _ladder(schedule.race_points, n), _ladder(schedule.sprint_points, n)
    temp = float(config.TITLE_PL_TEMPERATURE)
    shares = np.zeros((reps, n))
    batch = max(1, 50000 // sub)
    for lo in range(0, reps, batch):
        block = list(range(lo, min(lo + batch, reps)))
        thetas = []
        for _ in block:
            pick = rng.integers(0, n_orders, size=n_orders)
            fit = fit_plackett_luce([orders[i] for i in pick], [weights[i] for i in pick],
                                    config.TITLE_PL_RIDGE)
            thetas.append([float(fit.get(d, 0.0)) for d in drivers])
        th = np.repeat(np.asarray(thetas), sub, axis=0)
        total = np.tile(start, (len(block) * sub, 1))
        _run_rounds(th, dn, remaining, schedule, rng, total, None,
                    race_ladder=race_ladder, sprint_ladder=sprint_ladder, temperature=temp)
        masked = np.where(alive[None, :], total, -np.inf)
        champ = np.argmax(masked, axis=1).reshape(len(block), sub)
        for j, b in enumerate(block):
            shares[b] = np.bincount(champ[j], minlength=n) / sub
    return np.percentile(shares, 2.5, axis=0), np.percentile(shares, 97.5, axis=0)


def _countbacks(conn, year: int, after_round: int) -> dict[str, tuple[int, ...]]:
    """Per-driver classified race-position counts P1..P20 of ``year`` up to ``after_round``."""
    df = _read(conn, """
        SELECT r.driver_id, r.position, r.classified_position FROM results r
        JOIN sessions s ON s.session_id = r.session_id
        WHERE s.kind = 'R' AND s.year = %s AND s.round <= %s""", (year, after_round))
    if df.empty:
        return {}
    df = df[df["classified_position"].astype(str).str.fullmatch(r"\d+") & df["position"].notna()]
    out: dict[str, list[int]] = {}
    for d, p in zip(df["driver_id"], df["position"]):
        row = out.setdefault(str(d), [0] * COUNTBACK_POSITIONS)
        if 1 <= int(p) <= COUNTBACK_POSITIONS:
            row[int(p) - 1] += 1
    return {d: tuple(v) for d, v in out.items()}


def _completed_race_sessions(conn) -> int:
    df = _read(conn, "SELECT count(DISTINCT r.session_id) AS n FROM results r "
                     "JOIN sessions s ON s.session_id = r.session_id WHERE s.kind = 'R'")
    return int(df["n"].iloc[0]) if not df.empty else 0


def _write(cur, table: str, df: pd.DataFrame) -> int:
    if df is None or len(df) == 0:
        return 0
    cast = frames.cast_frame(df, table)
    cols = list(cast.columns)
    stmt = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(table), sql.SQL(", ").join(sql.Identifier(c) for c in cols),
        sql.SQL(", ").join(sql.Placeholder() for _ in cols))
    cur.executemany(stmt, list(frames.iter_rows(cast)))
    return len(cast)


def _odds_for_round(conn, year: int, after_round: int, schedule: PointsSchedule,
                    clinch: pd.DataFrame, cal: pd.DataFrame) -> pd.DataFrame:
    """One ``(year, after_round)`` snapshot of the simulated half (§2.4)."""
    orders, weights = finishing_orders(conn, year, after_round)
    fitted = fit_plackett_luce(orders, weights, config.TITLE_PL_RIDGE)
    dnf = dnf_rates(conn, year, after_round)
    season_rate = season_dnf_rate(conn, year, after_round)
    points_now = {str(d): float(p) for d, p in zip(clinch["driver_id"], clinch["points_now"])}
    # The field is exactly this season's ``driver_standings`` entrants (§2.7): θ is
    # fitted on every season's history, but a driver who has left the grid must not
    # take points off the drivers who are still on it.
    theta = {d: v for d, v in fitted.items() if d in points_now}
    for d in points_now:
        dnf.setdefault(d, season_rate)
    eliminated = {str(d) for d, e in zip(clinch["driver_id"], clinch["is_eliminated"]) if e}
    remaining = [{"round": int(r), "has_race": int(cal.loc[cal["round"] == r, "races"].iloc[0] or 0) > 0,
                  "has_sprint": int(cal.loc[cal["round"] == r, "sprints"].iloc[0] or 0) > 0}
                 for r in cal["round"] if int(r) > int(after_round)]
    countback = _countbacks(conn, year, after_round)
    rng = np.random.default_rng(int(config.TITLE_SEED) + int(year) * 100 + int(after_round))
    sim = simulate(theta, dnf, remaining, schedule, draws=int(config.TITLE_SIM_DRAWS), rng=rng,
                   points_now=points_now, countback_now=countback, eliminated=eliminated)
    drivers = list(sim["driver_id"])
    lo, hi = _bootstrap_band(orders, weights, drivers, dnf, remaining, schedule,
                             points_now=points_now, countback_now=countback,
                             eliminated=eliminated, rng=rng)
    return pd.DataFrame({
        "year": int(year), "after_round": int(after_round), "assumption_set_id": None,
        "driver_id": drivers, "p_title": sim["p_title"].to_numpy(),
        "p_title_lo": lo, "p_title_hi": hi, "mc_stderr": sim["mc_stderr"].to_numpy(),
        "p_top3": sim["p_top3"].to_numpy(), "expected_points": sim["expected_points"].to_numpy(),
        "points_p10": sim["points_p10"].to_numpy(), "points_p90": sim["points_p90"].to_numpy(),
        "theta": [float(theta.get(d, 0.0)) for d in drivers],
        "dnf_rate": [float(dnf.get(d, season_rate)) for d in drivers],
        "is_shrunk_to_prior": [d not in theta for d in drivers],
        "draws": int(config.TITLE_SIM_DRAWS),
    }, columns=frames.EXPECTED_COLUMNS["title_odds"])


def _assert_consistent(odds: pd.DataFrame, clinch: pd.DataFrame, year: int, after_round: int) -> None:
    """§2.6 — the forecast may never contradict the arithmetic."""
    if odds.empty:
        return
    total = float(odds["p_title"].sum())
    if not math.isclose(total, 1.0, abs_tol=1e-9):
        raise AssertionError(f"title_odds {year} R{after_round}: sum(p_title) = {total!r}")
    elim = dict(zip(clinch["driver_id"], clinch["is_eliminated"]))
    leader = int(clinch["leader_points"].iloc[0]) if not clinch.empty else 0
    for d, p, p90 in zip(odds["driver_id"], odds["p_title"], odds["points_p90"]):
        if elim.get(d):
            if float(p) != 0.0:
                raise AssertionError(f"eliminated {d} has p_title = {p!r} at {year} R{after_round}")
            if float(p90) > leader:
                raise AssertionError(f"eliminated {d} has points_p90 = {p90!r} > {leader}")


def recompute_title(conn, year: int, assumption_set_id: int) -> dict[str, int]:
    """Rebuild ``title_odds`` / ``title_clinch`` for ``year`` (§2, §6.3).

    Called at the end of ``season.recompute`` so the season page's odds are always
    consistent with the standings computed in the same transaction (§5.6). Pure
    recompute from stored rows, idempotent by DELETE-then-INSERT; it neither opens a
    transaction of its own nor commits.
    """
    year = int(year)
    rounds = _read(conn, "SELECT DISTINCT after_round FROM driver_standings WHERE year = %s "
                         "ORDER BY after_round", (year,))
    with conn.cursor() as cur:
        for table in ("title_odds", "title_clinch"):
            cur.execute(sql.SQL("DELETE FROM {} WHERE year = %s").format(sql.Identifier(table)),
                        (year,))
        if rounds.empty:                       # §2.7: season with zero completed rounds
            return {"title_odds": 0, "title_clinch": 0}

        schedule = points_schedule(conn, year)     # §2.1: derived once per recompute
        cal = _calendar(conn, year)
        enough = _completed_race_sessions(conn) >= int(config.TITLE_MIN_RACES_FOR_PL)
        n_odds = n_clinch = 0
        for k in [int(r) for r in rounds["after_round"]]:
            clinch = clinch_table(conn, year, k, schedule)
            if clinch.empty:
                continue
            clinch["assumption_set_id"] = int(assumption_set_id)
            n_clinch += _write(cur, "title_clinch", clinch)
            if not enough or not schedule.race_points:
                continue                        # §2.7: θ is not identifiable
            odds = _odds_for_round(conn, year, k, schedule, clinch, cal)
            _assert_consistent(odds, clinch, year, k)
            odds["assumption_set_id"] = int(assumption_set_id)
            n_odds += _write(cur, "title_odds", odds)
    return {"title_odds": n_odds, "title_clinch": n_clinch}
