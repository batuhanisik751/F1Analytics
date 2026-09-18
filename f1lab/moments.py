"""Race moments and optimal stint length (MODE1_SPEC §4).

Five detectors run over one race session and emit annotated "moments"; a separate
builder turns pooled degradation fits into the pure lap-time break-even stint length
``n* = sqrt(2T/k)`` (§4.4).

The rule everything follows from (§4.1) is that every pace threshold is expressed on
**field-relative** pace ``rel_s = lap_time_s - median(lap_time_s over cars running on
that lap)``, with a blanket suppression of any cluster where more than
``MOMENTS_FIELD_WIDE_SHARE`` of the running field fires the same moment type on the
same lap. Absolute pace measured the weather, not the tyres: it produced 1,825
detections over 61 races including eleven simultaneous "tyre cliffs" on lap 49 of the
2025 British Grand Prix.

The detectors take a ``ctx`` -- the mapping ``build_ctx`` returns -- so that exactly the
same code runs over a freshly loaded FastF1 session (``build_race_moments``) and over
the stored tables (the tests and the validation harness).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import config

# Candidate columns the five detectors agree on, before build_race_moments assigns
# moment_idx and translates to the DB shape of frames.TABLE_COLUMNS["race_moment"].
MOMENT_CANDIDATE_COLUMNS: tuple[str, ...] = (
    "moment_type", "lap_number", "driver_id", "other_driver_id",
    "magnitude", "magnitude_unit", "severity", "confidence", "detail",
)

# The lap columns every detector relies on; build_ctx guarantees all of them exist.
CTX_LAP_COLUMNS: tuple[str, ...] = (
    "driver_id", "lap_number", "stint", "compound", "tyre_life", "position",
    "lap_time_s", "pit_in", "pit_out", "is_green", "rel_s", "n_running", "is_clean",
)

MOMENT_TYPES: tuple[str, ...] = (
    "pace_collapse", "undercut_executed", "tyre_cliff", "damage_or_puncture", "safety_car_luck",
)


def _no_candidates() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype=object) for c in MOMENT_CANDIDATE_COLUMNS})


def _candidates(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return _no_candidates()
    return pd.DataFrame(rows, columns=list(MOMENT_CANDIDATE_COLUMNS))


def rel_pace(laps: pd.DataFrame) -> pd.DataFrame:
    """Add field-relative pace to a lap frame (§4.1).

    ``rel_s`` is §4.1's formula verbatim -- the lap time minus the median lap time over
    the cars running on that lap, in- and out-laps included, because they are cars that
    are running. ``n_running`` is how many cars set a time on the lap, which is what the
    field-wide suppression share is taken of.
    """
    out = laps.copy()
    t = pd.to_numeric(out["lap_time_s"], errors="coerce")
    out["rel_s"] = t - t.groupby(out["lap_number"]).transform("median")
    out["n_running"] = t.notna().groupby(out["lap_number"]).transform("sum").astype(int)
    return out


def _present(col, index) -> pd.Series:
    """True where a column has a value, for float, timedelta or a missing column."""
    if col is None:
        return pd.Series(False, index=index, dtype=bool)
    return pd.Series(pd.notna(col), index=index, dtype=bool)


def build_ctx(laps: pd.DataFrame, lap_status: pd.DataFrame, pits: pd.DataFrame,
              stints: pd.DataFrame, results: pd.DataFrame, total_laps: int) -> dict:
    """Normalise one race's frames into the mapping every detector reads.

    ``laps`` needs driver_id, lap_number, stint, compound, tyre_life, position,
    lap_time_s and the two pit time columns; ``lap_status`` needs lap_number/is_green;
    ``pits`` needs driver_id/lap_in/lap_out; ``results`` needs driver_id/status.
    """
    lp = pd.DataFrame({
        "driver_id": laps["driver_id"].astype(str),
        "lap_number": pd.to_numeric(laps["lap_number"], errors="coerce").astype("Int64"),
        "stint": pd.to_numeric(laps.get("stint"), errors="coerce").astype("Int64"),
        "compound": laps.get("compound"),
        "tyre_life": pd.to_numeric(laps.get("tyre_life"), errors="coerce"),
        "position": pd.to_numeric(laps.get("position"), errors="coerce"),
        "lap_time_s": pd.to_numeric(laps["lap_time_s"], errors="coerce"),
        # NOT pd.to_numeric here: FastF1 hands these over as timedelta64, and
        # to_numeric turns even NaT into a number, which flags every lap as both an
        # in- and an out-lap and silently empties every pace detector.
        "pit_in": _present(laps.get("pit_in_time_s"), laps.index),
        "pit_out": _present(laps.get("pit_out_time_s"), laps.index),
    })
    lp = lp[lp["lap_number"].notna()].copy()
    lp["lap_number"] = lp["lap_number"].astype(int)

    ls = pd.DataFrame({
        "lap_number": pd.to_numeric(lap_status["lap_number"], errors="coerce").astype(int),
        "is_green": lap_status["is_green"].astype(bool),
    }) if lap_status is not None and len(lap_status) else pd.DataFrame(
        {"lap_number": pd.Series(dtype=int), "is_green": pd.Series(dtype=bool)})
    green = dict(zip(ls["lap_number"], ls["is_green"]))
    lp["is_green"] = lp["lap_number"].map(lambda n: bool(green.get(n, True)))
    lp = rel_pace(lp)
    lp["is_clean"] = lp["is_green"] & ~lp["pit_in"] & ~lp["pit_out"] & lp["lap_time_s"].notna()
    lp = lp.sort_values(["driver_id", "lap_number"]).reset_index(drop=True)

    ps = pd.DataFrame(columns=["driver_id", "lap_in", "lap_out"]) if pits is None or not len(pits) else \
        pd.DataFrame({"driver_id": pits["driver_id"].astype(str),
                      "lap_in": pd.to_numeric(pits["lap_in"], errors="coerce"),
                      "lap_out": pd.to_numeric(pits["lap_out"], errors="coerce")})
    ps = ps.dropna(subset=["lap_in"]).copy()
    if len(ps):
        ps["lap_in"] = ps["lap_in"].astype(int)
        ps["lap_out"] = ps["lap_out"].fillna(ps["lap_in"] + 1).astype(int)
    ps = ps.sort_values(["driver_id", "lap_in"]).reset_index(drop=True)

    st = pd.DataFrame(columns=["driver_id", "stint", "compound", "start_lap", "end_lap", "laps"]) \
        if stints is None or not len(stints) else pd.DataFrame({
            "driver_id": stints["driver_id"].astype(str),
            "stint": pd.to_numeric(stints["stint"], errors="coerce"),
            "compound": stints["compound"].astype(str),
            "start_lap": pd.to_numeric(stints["start_lap"], errors="coerce"),
            "end_lap": pd.to_numeric(stints["end_lap"], errors="coerce"),
            "laps": pd.to_numeric(stints["laps"], errors="coerce"),
        })

    rs = pd.DataFrame(columns=["driver_id", "status", "position"]) if results is None or not len(results) else \
        pd.DataFrame({"driver_id": results["driver_id"].astype(str),
                      "status": results["status"].astype(str) if "status" in results.columns else "",
                      "position": pd.to_numeric(results.get("position"), errors="coerce")})

    return {"laps": lp, "lap_status": ls, "pits": ps, "stints": st, "results": rs,
            "total_laps": int(total_laps or (lp["lap_number"].max() if len(lp) else 0))}


_NON_FINISH_OK = ("Finished", "+1 Lap", "+2 Laps", "+3 Laps", "+4 Laps", "+5 Laps", "+6 Laps")


def _retired(ctx: dict) -> dict[str, bool]:
    """driver_id -> results.status is a non-finish (§4.2 confidence corroboration)."""
    rs = ctx["results"]
    if not len(rs):
        return {}
    return {str(d): not (str(s).startswith("+") or str(s) in _NON_FINISH_OK)
            for d, s in zip(rs["driver_id"], rs["status"])}


def _pit_laps(ctx: dict) -> dict[str, set[int]]:
    ps = ctx["pits"]
    out: dict[str, set[int]] = {}
    for d, li in zip(ps["driver_id"], ps["lap_in"]):
        out.setdefault(str(d), set()).add(int(li))
    return out


def _confidence(driver: str, lap: int, pit_laps: dict, retired: dict) -> str:
    """'high' when an independent record corroborates the moment, else 'likely' (§4.2)."""
    near = any(abs(int(lap) - p) <= 1 for p in pit_laps.get(str(driver), ()))
    return "high" if (near or retired.get(str(driver), False)) else "likely"


def detect_pace_collapse(ctx) -> pd.DataFrame:
    """3-lap rolling mean of rel_s >= COLLAPSE_S worse than the driver's own prior
    5-lap rolling median, held for COLLAPSE_HOLD laps. First onset per driver (§4.2)."""
    lp = ctx["laps"]
    clean = lp[lp["is_clean"]]
    pit_laps, retired = _pit_laps(ctx), _retired(ctx)
    hold = int(config.COLLAPSE_HOLD)
    rows: list[dict] = []
    for drv, g in clean.groupby("driver_id", sort=True):
        g = g.sort_values("lap_number")
        rel = g["rel_s"]
        roll3 = rel.rolling(3, min_periods=3).mean()
        prior5 = rel.shift(1).rolling(5, min_periods=5).median()
        excess = (roll3 - prior5)
        flag = (excess >= float(config.COLLAPSE_S)).to_numpy()
        laps_n = g["lap_number"].to_numpy()
        exc = excess.to_numpy()
        for i in range(len(flag) - hold + 1):
            if flag[i:i + hold].all():
                rows.append({
                    "moment_type": "pace_collapse", "lap_number": int(laps_n[i]),
                    "driver_id": str(drv), "other_driver_id": None,
                    "magnitude": round(float(exc[i]), 3), "magnitude_unit": "s",
                    "severity": 0.0,
                    "confidence": _confidence(drv, int(laps_n[i]), pit_laps, retired),
                    "detail": (f"pace fell {float(exc[i]):.1f} s/lap below this driver's own "
                               f"earlier rhythm from lap {int(laps_n[i])}"),
                })
                break
    return _candidates(rows)


def suppress_field_wide(df: pd.DataFrame, n_running: pd.Series, share: float) -> pd.DataFrame:
    """Drop any (lap, moment_type) cluster larger than ``share`` of the running field (§4.1).

    Eleven cars do not hit the tyre cliff on the same lap; the track changed. This is the
    blanket guard that sits on top of every individual detector's own thresholds.
    """
    if df is None or not len(df):
        return _no_candidates() if df is None else df
    running = {int(k): int(v) for k, v in n_running.items()} if n_running is not None else {}
    # "cars trigger" -- distinct drivers, not rows: one attacker can undercut two cars
    # on the same lap and that is one car triggering, not two.
    counts = df.groupby(["lap_number", "moment_type"])["driver_id"].nunique()
    keep = []
    for lap, mtype in zip(df["lap_number"], df["moment_type"]):
        n = running.get(int(lap), 0)
        fired = int(counts.loc[(lap, mtype)])
        keep.append(not (n > 0 and fired > float(share) * n))
    return df[pd.Series(keep, index=df.index)].reset_index(drop=True)


def detect_undercut(ctx) -> pd.DataFrame:
    """A pits on lap L with B exactly one place ahead at L-1; B pits within
    UNDERCUT_WINDOW laps; A is ahead at M = max(lap_out)+1. Magnitude is the places
    the *victim* lost -- the attacker's gain double-counts third parties (§4.2)."""
    lp, ps = ctx["laps"], ctx["pits"]
    if not len(ps):
        return _no_candidates()
    pos = {(str(d), int(n)): (None if pd.isna(p) else int(p))
           for d, n, p in zip(lp["driver_id"], lp["lap_number"], lp["position"])}
    pit_laps, retired = _pit_laps(ctx), _retired(ctx)
    stops = [(str(r.driver_id), int(r.lap_in), int(r.lap_out)) for r in ps.itertuples()]
    by_driver: dict[str, list[tuple[int, int]]] = {}
    for d, li, lo in stops:
        by_driver.setdefault(d, []).append((li, lo))
    rows: list[dict] = []
    for a, la_in, la_out in stops:
        pa_before = pos.get((a, la_in - 1))
        if pa_before is None:
            continue
        for b, lb_in, lb_out in stops:
            if b == a or not (la_in < lb_in <= la_in + int(config.UNDERCUT_WINDOW)):
                continue
            pb_before = pos.get((b, la_in - 1))
            if pb_before is None or pa_before - pb_before != int(config.UNDERCUT_MAX_GAP):
                continue
            m = max(la_out, lb_out) + 1
            pa_after, pb_after = pos.get((a, m)), pos.get((b, m))
            if pa_after is None or pb_after is None or pa_after >= pb_after:
                continue
            # Magnitude is §4.2's formula verbatim: the victim's position change, so a
            # positive value means places lost. A zero or negative value is kept -- the
            # attacker still passed the victim and the places went to or from third
            # parties; filtering on it drops 9 of the 123 MEASURED undercuts.
            lost = pb_after - pb_before
            rows.append({
                "moment_type": "undercut_executed", "lap_number": la_in,
                "driver_id": a, "other_driver_id": b,
                "magnitude": float(lost), "magnitude_unit": "places",
                "severity": 0.0,
                "confidence": _confidence(a, la_in, pit_laps, retired),
                "detail": (f"undercut on lap {la_in}: stopped {lb_in - la_in} lap(s) before the car "
                           f"ahead and came out in front by lap {m}; the victim lost "
                           f"{lost} place(s)" if lost > 0 else
                           f"undercut on lap {la_in}: stopped {lb_in - la_in} lap(s) before the car "
                           f"ahead and came out in front by lap {m}"),
            })
    return _candidates(rows)


def _slope(x: np.ndarray, y: np.ndarray) -> float:
    """OLS slope of y on x; 0.0 when x has no spread."""
    if len(x) < 2:
        return 0.0
    xm, ym = float(np.mean(x)), float(np.mean(y))
    den = float(np.sum((x - xm) ** 2))
    if den <= 0:
        return 0.0
    return float(np.sum((x - xm) * (y - ym)) / den)


def detect_tyre_cliff(ctx) -> pd.DataFrame:
    """Within a stint of >= 8 clean laps, fit rel_s ~ tyre_life on all but the last
    CLIFF_TAIL laps; the tail must exceed the extrapolation by >= CLIFF_MIN_S on
    average AND its slope must be >= CLIFF_FACTOR x the head slope (§4.2).

    Both clauses are required: the first alone fires on traffic, the second on noise.
    """
    lp = ctx["laps"]
    clean = lp[lp["is_clean"] & lp["tyre_life"].notna()]
    tail_n = int(config.CLIFF_TAIL)
    pit_laps, retired = _pit_laps(ctx), _retired(ctx)
    rows: list[dict] = []
    for (drv, _stint), g in clean.groupby(["driver_id", "stint"], sort=True):
        g = g.sort_values("lap_number")
        if len(g) < 8:
            continue
        x = g["tyre_life"].to_numpy(dtype=float)
        y = g["rel_s"].to_numpy(dtype=float)
        laps_n = g["lap_number"].to_numpy()
        hx, hy = x[:-tail_n], y[:-tail_n]
        tx, ty = x[-tail_n:], y[-tail_n:]
        head_slope = _slope(hx, hy)
        intercept = float(np.mean(hy) - head_slope * np.mean(hx))
        excess = float(np.mean(ty - (intercept + head_slope * tx)))
        tail_slope = _slope(tx, ty)
        if excess < float(config.CLIFF_MIN_S) or tail_slope < float(config.CLIFF_FACTOR) * head_slope:
            continue
        lap = int(laps_n[-tail_n])
        rows.append({
            "moment_type": "tyre_cliff", "lap_number": lap, "driver_id": str(drv),
            "other_driver_id": None, "magnitude": round(excess, 3), "magnitude_unit": "s",
            "severity": 0.0, "confidence": _confidence(drv, lap, pit_laps, retired),
            "detail": (f"tyre cliff from lap {lap}: the last {tail_n} laps of the stint ran "
                       f"{excess:.1f} s/lap worse than the stint's own degradation line"),
        })
    return _candidates(rows)


# The moment types a shared race-wide event can fake, and so the ones the field-wide
# cluster guard is applied to. `undercut_executed` is the one exception: it is not a
# pace measurement, and seven cars each undercutting the car ahead inside one big pit
# window is a strategy, not weather. Suppressing that cluster costs five of the 123
# MEASURED undercuts (§4.2) and buys nothing -- the undercut rule already requires an
# adjacent pair and a completed swap.
FIELD_WIDE_TYPES: tuple[str, ...] = ("pace_collapse", "tyre_cliff", "damage_or_puncture",
                                     "safety_car_luck")


def detect_damage(ctx) -> pd.DataFrame:
    """A single green lap >= PUNCTURE_S above the driver's own centred 5-lap rolling
    median of rel_s, corroborated either by a stop on that lap or the next together
    with >= PUNCTURE_MIN_LOST places lost over the next two laps, or by it being the
    driver's last lap of the race (§4.2).

    The position-loss clause is the rule, not decoration: without it the detector fired
    20x at 2024 Singapore and 18x at 2025 Monaco, where a slow lap on a street circuit
    means traffic. It cut the yield from 170 to 48.
    """
    lp = ctx["laps"]
    clean = lp[lp["is_clean"]]
    pos = {(str(d), int(n)): (None if pd.isna(p) else int(p))
           for d, n, p in zip(lp["driver_id"], lp["lap_number"], lp["position"])}
    last_lap = lp.groupby("driver_id")["lap_number"].max().to_dict()
    pit_laps, retired = _pit_laps(ctx), _retired(ctx)
    rows: list[dict] = []
    for drv, g in clean.groupby("driver_id", sort=True):
        g = g.sort_values("lap_number")
        rel = g["rel_s"]
        base = rel.rolling(5, center=True, min_periods=3).median()
        excess = (rel - base).to_numpy()
        laps_n = g["lap_number"].to_numpy()
        for i, lap in enumerate(laps_n):
            if not (excess[i] >= float(config.PUNCTURE_S)):
                continue
            lap = int(lap)
            stopped = bool({lap, lap + 1} & pit_laps.get(str(drv), set()))
            here, later = pos.get((str(drv), lap)), pos.get((str(drv), lap + 2))
            lost = (later - here) if (here is not None and later is not None) else None
            final = lap == int(last_lap.get(drv, lap))
            # The position-loss clause cannot fire for a car that is already last or whose
            # race ends before lap L+2, and both of §4.3's named checks are exactly that
            # case (2024 R9 Leclerc L30, P19 at the time; 2026 R12 Albon L65). A
            # non-finishing results.status is the same kind of independent corroboration
            # the clause is reaching for, so it stands in for it.
            hurt = (lost is not None and lost >= int(config.PUNCTURE_MIN_LOST)) or retired.get(str(drv), False)
            if not ((stopped and hurt) or final):
                continue
            if final:
                why = "retired at the end of it"
            elif lost is not None and lost >= int(config.PUNCTURE_MIN_LOST):
                why = f"pitted and lost {lost} place(s)"
            else:
                why = "pitted and did not see the flag"
            rows.append({
                "moment_type": "damage_or_puncture", "lap_number": lap, "driver_id": str(drv),
                "other_driver_id": None, "magnitude": round(float(excess[i]), 3),
                "magnitude_unit": "s", "severity": 0.0,
                "confidence": _confidence(drv, lap, pit_laps, retired),
                "detail": (f"lap {lap} ran {float(excess[i]):.1f} s slower than this driver's own "
                           f"surrounding laps and the car {why}"),
            })
    return _candidates(rows)


def detect_sc_luck(ctx) -> pd.DataFrame:
    """A stop taken under (or one lap after) a non-green lap that is worth
    >= SC_LUCK_MIN_GAIN places by the first green lap after the stop, and beats the
    median gain of everyone who pitted in the same window by >= SC_RELATIVE_GAIN (§4.2).

    The relative clause is what makes it luck rather than arithmetic: when the whole
    field pits under a safety car, nobody has been lucky. 2026 Monaco reported 26
    "lucky" drivers without it.
    """
    lp, ps = ctx["laps"], ctx["pits"]
    if not len(ps):
        return _no_candidates()
    green = dict(zip(ctx["lap_status"]["lap_number"], ctx["lap_status"]["is_green"]))
    pos = {(str(d), int(n)): (None if pd.isna(p) else int(p))
           for d, n, p in zip(lp["driver_id"], lp["lap_number"], lp["position"])}
    laps_sorted = sorted({int(n) for n in lp["lap_number"]})

    # Contiguous runs of non-green laps are the windows the relative clause is taken over.
    episode: dict[int, int] = {}
    idx, prev_non_green = -1, False
    for n in laps_sorted:
        non_green = not bool(green.get(n, True))
        if non_green and not prev_non_green:
            idx += 1
        if non_green:
            episode[n] = idx
        prev_non_green = non_green

    def first_green_after(lap: int) -> int | None:
        for n in laps_sorted:
            if n > lap and bool(green.get(n, True)):
                return n
        return None

    cand: list[dict] = []
    for r in ps.itertuples():
        drv, li, lo = str(r.driver_id), int(r.lap_in), int(r.lap_out)
        ep = episode.get(li, episode.get(li - 1))
        if ep is None:
            continue
        g = first_green_after(lo)
        before, after = pos.get((drv, li - 1)), (None if g is None else pos.get((drv, g)))
        if before is None or after is None:
            continue
        cand.append({"driver_id": drv, "lap_in": li, "episode": ep,
                     "gain": before - after, "green_lap": int(g)})
    if not cand:
        return _no_candidates()
    cd = pd.DataFrame(cand)
    cd["window_median"] = cd.groupby("episode")["gain"].transform("median")
    pit_laps, retired = _pit_laps(ctx), _retired(ctx)
    rows: list[dict] = []
    for r in cd.itertuples():
        if r.gain < int(config.SC_LUCK_MIN_GAIN):
            continue
        if (r.gain - r.window_median) < int(config.SC_RELATIVE_GAIN):
            continue
        rows.append({
            "moment_type": "safety_car_luck", "lap_number": int(r.lap_in),
            "driver_id": str(r.driver_id), "other_driver_id": None,
            "magnitude": float(r.gain), "magnitude_unit": "places", "severity": 0.0,
            "confidence": _confidence(r.driver_id, int(r.lap_in), pit_laps, retired),
            "detail": (f"stopped on lap {int(r.lap_in)} while the race was neutralised and gained "
                       f"{int(r.gain)} place(s) by lap {int(r.green_lap)}, "
                       f"{r.gain - r.window_median:.0f} more than the median stop in that window"),
        })
    return _candidates(rows)


# MEASURED per-type |magnitude| distribution over the 61 raced sessions in the database
# (mean, sd), used to z-score `severity` so that a race with a single moment of a type
# still ranks it honestly. A within-race z would be 0.0 for every singleton and the
# MOMENTS_MAX_PER_RACE display cap would then rank arbitrarily. Display only: no
# stored number depends on it, so it is not an assumption-snapshot constant.
SEVERITY_SCALE: dict[str, tuple[float, float]] = {
    "pace_collapse": (2.41, 0.91),
    "undercut_executed": (4.86, 2.97),
    "tyre_cliff": (1.97, 1.28),
    "damage_or_puncture": (10.40, 4.00),
    "safety_car_luck": (3.11, 0.98),
}


def _severity(moment_type: str, magnitude: float) -> float:
    mu, sd = SEVERITY_SCALE.get(str(moment_type), (0.0, 1.0))
    if sd <= 0:
        return 0.0
    return round((abs(float(magnitude)) - mu) / sd, 4)


def detect_all(ctx) -> pd.DataFrame:
    """The five detectors plus §4.1's field-wide suppression, severity and ordering.

    Returns MOMENT_CANDIDATE_COLUMNS ordered by lap then driver, which is the order
    ``moment_idx`` is assigned in.
    """
    parts = [detect_pace_collapse(ctx), detect_undercut(ctx), detect_tyre_cliff(ctx),
             detect_damage(ctx), detect_sc_luck(ctx)]
    parts = [p for p in parts if len(p)]
    if not parts:
        return _no_candidates()
    df = pd.concat(parts, ignore_index=True)
    n_running = ctx["laps"].groupby("lap_number")["n_running"].first()
    pace_like = df[df["moment_type"].isin(FIELD_WIDE_TYPES)]
    other = df[~df["moment_type"].isin(FIELD_WIDE_TYPES)]
    kept = suppress_field_wide(pace_like, n_running, float(config.MOMENTS_FIELD_WIDE_SHARE))
    df = pd.concat([kept, other], ignore_index=True) if len(other) else kept
    if not len(df):
        return _no_candidates()
    df["severity"] = [_severity(t, m) for t, m in zip(df["moment_type"], df["magnitude"])]
    df = df.sort_values(["lap_number", "driver_id", "moment_type"], kind="stable").reset_index(drop=True)
    return df[list(MOMENT_CANDIDATE_COLUMNS)]


def _session_ctx(session, ids) -> dict:
    """The detector context for a freshly loaded FastF1 race session.

    ``build_race_frames`` hands the analytics the session, not its already-derived
    frames, so the same three helpers it uses are re-run here. Driver codes are mapped
    through ``ids`` so every frame speaks the stored ``driver_id``.
    """
    from . import clean, derive

    code_to_id = dict(ids.code_to_driver_id)
    annotated = clean.annotate_laps(session)
    laps = pd.DataFrame({
        "driver_id": annotated["Driver"].map(code_to_id),
        "lap_number": annotated["LapNumber"],
        "stint": annotated.get("Stint"),
        "compound": annotated.get("Compound"),
        "tyre_life": annotated.get("TyreLife"),
        "position": annotated.get("Position"),
        "lap_time_s": annotated["LapTimeSeconds"],
        "pit_in_time_s": annotated.get("PitInTime"),
        "pit_out_time_s": annotated.get("PitOutTime"),
    })
    laps = laps[laps["driver_id"].notna()]

    ls = derive.lap_status(annotated)
    lap_status = pd.DataFrame({"lap_number": ls["LapNumber"], "is_green": ls["IsGreen"]})

    pt = derive.pit_stops(session.laps)
    pits = pd.DataFrame({"driver_id": pt["Driver"].map(code_to_id),
                         "lap_in": pt["LapIn"], "lap_out": pt["LapOut"]})
    pits = pits[pits["driver_id"].notna()]

    st = clean.stint_table(session)
    stints = pd.DataFrame({"driver_id": st["Driver"].map(code_to_id), "stint": st["Stint"],
                           "compound": st["Compound"], "start_lap": st["start_lap"],
                           "end_lap": st["end_lap"], "laps": st["laps"]})
    stints = stints[stints["driver_id"].notna()]

    res = session.results
    results = pd.DataFrame({"driver_id": res["DriverId"].astype(str),
                            "status": [("Unknown" if pd.isna(v) else str(v)) for v in res["Status"]],
                            "position": res["Position"]})
    return build_ctx(laps, lap_status, pits, stints, results, int(session.total_laps or 0))


def build_race_moments(session, ids, assumption_set_id) -> pd.DataFrame | None:
    """race_moment rows for one session, in frames.TABLE_COLUMNS order (§4.2).

    Returns None when nothing crossed the thresholds -- a processional race genuinely
    has no moments and §4.5 renders that as an honest empty state, not an error.
    """
    ctx = _session_ctx(session, ids)
    if not len(ctx["laps"]):
        return None
    df = detect_all(ctx)
    if not len(df):
        return None
    out = pd.DataFrame({
        "session_id": int(ids.session_id), "assumption_set_id": int(assumption_set_id),
        "moment_idx": range(len(df)), "moment_type": df["moment_type"].astype(str),
        "lap_number": df["lap_number"].astype(int), "driver_id": df["driver_id"].astype(str),
        "other_driver_id": df["other_driver_id"], "magnitude": df["magnitude"].astype(float),
        "magnitude_unit": df["magnitude_unit"].astype(str), "severity": df["severity"].astype(float),
        "confidence": df["confidence"].astype(str), "detail": df["detail"].astype(str),
    })
    return out


def _circuit_key(session) -> int | None:
    circuit = (getattr(session, "session_info", None) or {}).get("Meeting", {}).get("Circuit") or {}
    key = circuit.get("Key")
    return None if key is None else int(key)


def optimal_laps(pit_loss_s: float, slope_s_per_lap: float, total_laps: int) -> float:
    """n* = sqrt(2T/k), clipped to [5, total_laps] (§4.4).

    Staying out one more lap costs k seconds on every remaining lap of the stint;
    stopping costs T once. n* is where those balance, and it is independent of race
    length -- the clipping is a display bound, not part of the derivation.
    """
    n = float(np.sqrt(2.0 * float(pit_loss_s) / float(slope_s_per_lap)))
    hi = float(total_laps) if total_laps and total_laps > 5 else 5.0
    return float(min(max(n, 5.0), hi))


def _session_slopes(session) -> pd.DataFrame:
    """This session's per-stint degradation fits (compound, deg_s_per_lap), §4.4.

    ``degradation_fits``, never ``compound_degradation``: the pooled table is a
    median-of-medians and its estimator is not the one sqrt(2T/k) wants.
    """
    from . import clean, pace

    laps_fc = pace.fuel_correct(clean.clean_laps(session), session.total_laps, lap_km=None)
    deg = pace.degradation(laps_fc)
    if deg is None or not len(deg):
        return pd.DataFrame({"compound": pd.Series(dtype=str), "deg_s_per_lap": pd.Series(dtype=float)})
    return pd.DataFrame({"compound": deg["Compound"].astype(str).str.upper(),
                         "deg_s_per_lap": pd.to_numeric(deg["DegSPerLap"], errors="coerce")}).dropna()


def _dry_fit_count(sess_fits: pd.DataFrame, wet: set[str]) -> int:
    """Largest per-compound count of *this session's* dry degradation fits (§4.5).

    Wet compounds and UNKNOWN never count: §4.4 assumption 4 excludes them outright
    because a drying track fits a negative slope. Returns 0 when the session produced
    no dry fits at all, which is what a wet race looks like.
    """
    if sess_fits is None or not len(sess_fits):
        return 0
    compound = sess_fits["compound"].astype(str).str.upper()
    dry = sess_fits.loc[~compound.isin(wet) & (compound != "UNKNOWN")]
    if not len(dry):
        return 0
    return int(dry.groupby(compound.loc[dry.index]).size().max())


def build_optimal_stint(session, ids, assumption_set_id, pooled: dict) -> pd.DataFrame | None:
    """optimal_stint rows for one session, in frames.TABLE_COLUMNS order (§4.4).

    ``pooled`` carries the database-wide constants this analytic needs but cannot read
    itself (``build_race_frames`` has no connection); see ``frames.POOLED_STINT`` for
    the key contract. Returns None when there is no pit-loss estimate for the circuit,
    when this race produced no dry-tyre degradation fits of its own (a wet or
    intermediate race: no dry compound reaches ``OPT_STINT_MIN_SESSION_FITS`` fits in
    *this* session), or when no dry-compound slope survives the flat-slope guard --
    §4.5's whole-readout empty states. The pooled-slope fallback in §4.4 is a
    per-compound fallback that operates below that gate, never around it: without it a
    wet race would borrow the database-wide dry break-even and print it as this race's
    number.
    """
    pooled = dict(pooled or {})
    circuit = _circuit_key(session)
    pit_loss = (pooled.get("pit_loss_by_circuit") or {}).get(circuit)
    pit_loss_source = "circuit"
    if pit_loss is None:
        pit_loss, pit_loss_source = pooled.get("pit_loss_pooled_s"), "pooled"
    if pit_loss is None or float(pit_loss) <= 0:
        return None

    from . import clean

    total_laps = int(session.total_laps or 0)
    sess_fits = _session_slopes(session)
    pooled_slopes = pooled.get("slope_by_compound") or {}
    wet = {c.upper() for c in config.OPT_STINT_WET_COMPOUNDS}

    # §4.5: "wet or intermediate race (no dry compound has >= OPT_STINT_MIN_SESSION_FITS
    # fits) -> whole readout <EmptyState reason='no dry-tyre degradation fits in this
    # race' />". This gate runs before the per-compound loop so the pooled fallback
    # cannot resurrect a cross-season dry number for a race that ran no dry tyres.
    if _dry_fit_count(sess_fits, wet) < int(config.OPT_STINT_MIN_SESSION_FITS):
        return None

    stints = clean.stint_table(session)
    stints = stints.assign(Compound=stints["Compound"].astype(str).str.upper())
    actual = stints.groupby("Compound")["laps"].median().to_dict()

    compounds = sorted({c for c in stints["Compound"] if c and c not in wet and c != "UNKNOWN"})
    rows: list[dict] = []
    for compound in compounds:
        own = sess_fits.loc[sess_fits["compound"] == compound, "deg_s_per_lap"]
        if len(own) >= int(config.OPT_STINT_MIN_SESSION_FITS):
            k, q1, q3, n_fits, slope_source = (float(own.median()), float(own.quantile(0.25)),
                                               float(own.quantile(0.75)), int(len(own)), "session")
        else:
            p = pooled_slopes.get(compound)
            if not p:
                continue
            k, q1, q3, n_fits, slope_source = (float(p["median"]), float(p["q1"]), float(p["q3"]),
                                               int(p["n_fits"]), "pooled")
        # §4.4 assumption 3: n* explodes as k -> 0, so a slope this flat is refused
        # outright rather than shipped as a four-figure lap count.
        if k < float(config.OPT_STINT_MIN_SLOPE):
            continue
        lo_slope = max(q3, float(config.OPT_STINT_MIN_SLOPE))
        hi_slope = max(q1, float(config.OPT_STINT_MIN_SLOPE))
        med = actual.get(compound)
        rows.append({
            "session_id": int(ids.session_id), "assumption_set_id": int(assumption_set_id),
            "compound": compound, "n_fits": n_fits, "slope_s_per_lap": k,
            "slope_q1": q1, "slope_q3": q3, "pit_loss_s": float(pit_loss),
            "pit_loss_source": pit_loss_source,
            "optimal_laps": optimal_laps(pit_loss, k, total_laps),
            "optimal_laps_lo": optimal_laps(pit_loss, lo_slope, total_laps),
            "optimal_laps_hi": optimal_laps(pit_loss, hi_slope, total_laps),
            "actual_median_laps": None if med is None or pd.isna(med) else float(med),
            "slope_source": slope_source,
        })
    if not rows:
        return None
    return pd.DataFrame(rows)
