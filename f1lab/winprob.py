"""Live win probability — a trained classifier, not a forward simulation (MODE1_SPEC §1).

One row per ``(session_id, driver_id, lap_number)`` of a race session where both
``laps.position`` and ``laps.gap_to_leader_s`` are non-null; the label is
``results.position = 1``, read through :func:`build_labels` alone (§1.3).

Two leakage axes are closed here and nowhere else (§1.4):

* **cross-race** — the fold id is content-addressed (blake2s of the race key), so
  adding one race re-folds that race and nobody else, and a race is never in the
  training set of the fold that predicts it;
* **within-race temporal** — every feature at lap *L* is computed from laps ``<= L``
  only (backward rolling means, expanding medians, ``lap_in <= L`` stop counts), which
  ``test_feature_frame_is_prefix_only`` pins byte-for-byte.

Stored per-lap probabilities are **out-of-fold** (FD2); the full-data model is written
to ``wp_model_artifact`` with ``fold_index = -1`` and never reaches
``wp_lap_probability``, which carries ``CHECK (pred_kind = 'oof')``.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging

import numpy as np
import pandas as pd

from . import config, db, frames

log = logging.getLogger(__name__)

# The §1.2 order, and the single source of truth for it: 17 numeric + 1 categorical.
FEATURE_NAMES: tuple[str, ...] = (
    "position", "gap_to_leader_s", "gap_ahead_s", "gap_behind_s", "tyre_life", "compound",
    "pace_delta_r3", "is_lapped", "is_leader",
    "laps_remaining", "race_progress", "stops_made", "is_green", "cars_running", "team_best_pos",
    "grid_position", "grid_minus_pos", "form_ppr",
)
CATEGORICAL_FEATURES: tuple[str, ...] = ("compound",)

# The identifying columns build_features carries alongside FEATURE_NAMES.
FEATURE_KEY_COLUMNS: tuple[str, ...] = ("session_id", "year", "round", "driver_id", "lap_number")

COMPOUNDS: tuple[str, ...] = ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN")

# Hard 0/1 baselines make log loss infinite; the MEASURED 0.39084 of baseline B (§1.6)
# is this clip, not numpy's eps.
LOGLOSS_EPS = 1e-6

# lap_status.worst_status -> the §1.10 cause vocabulary ('4' SC, '5' red, '6'|'7' VSC).
STATUS_CAUSE: dict[str, str] = {"4": "safety_car", "5": "red_flag", "6": "vsc", "7": "vsc"}


def fold_id(year: int, round_: int, n_folds: int) -> int:
    """Content-addressed leave-one-race-out fold (§1.4.1).

    blake2s of the race key, **not** ``GroupKFold``: ingesting one new race must change
    that race's fold and nobody else's, or every other race's published probability is
    silently rewritten.
    """
    digest = hashlib.blake2s(f"{int(year)}:{int(round_)}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") % int(n_folds)


def model_version(assumption_set_id: int, race_keys: list[tuple[int, int]]) -> str:
    """``wp-<asid>-<blake2s(sorted race keys)>`` (§1.9.1): the --force short-circuit key."""
    keys = "|".join(f"{int(y)}:{int(r)}" for y, r in sorted({(int(y), int(r)) for y, r in race_keys}))
    return f"wp-{int(assumption_set_id)}-{hashlib.blake2s(keys.encode(), digest_size=6).hexdigest()}"


# ---------------------------------------------------------------------------
# Feature frame (§1.2) — prefix-safe by construction
# ---------------------------------------------------------------------------

# Nothing from WP_BANNED_SOURCES appears below: the only `results` column read here is
# grid_position (WP_ALLOWED_RESULT_COLUMNS, a pre-race fact). The label comes from
# build_labels and form_ppr from _form_ppr, both of which the whitelist test skips.
_FEATURE_SQL = """
WITH race AS (
    SELECT s.session_id, s.year, s.round, s.total_laps
    FROM sessions s
    WHERE s.kind = 'R' AND s.total_laps IS NOT NULL
      AND (%(upto)s::int IS NULL OR (s.year * 100 + s.round) <= %(upto)s::int)
)
SELECT l.session_id, rc.year, rc.round, l.driver_id, l.lap_number,
       l.position, l.gap_to_leader_s, l.interval_s, l.tyre_life, l.compound,
       l.lap_time_s, rc.total_laps,
       ls.is_green, ls.drivers_on_lap, se.team_id,
       res.grid_position, st.stops_made
FROM laps l
JOIN race rc ON rc.session_id = l.session_id
JOIN session_entries se ON se.session_id = l.session_id AND se.driver_id = l.driver_id
LEFT JOIN lap_status ls ON ls.session_id = l.session_id AND ls.lap_number = l.lap_number
LEFT JOIN results res ON res.session_id = l.session_id AND res.driver_id = l.driver_id
LEFT JOIN LATERAL (
    SELECT count(*) AS stops_made FROM pit_stops ps
    WHERE ps.session_id = l.session_id AND ps.driver_id = l.driver_id
      AND ps.lap_in <= l.lap_number
) st ON true
WHERE l.position IS NOT NULL AND l.gap_to_leader_s IS NOT NULL
ORDER BY l.session_id, l.driver_id, l.lap_number
"""

_FORM_SQL = """
-- WHITELIST: prior sessions only — results.points is read here for sessions strictly
-- earlier than the one being featurised, which §1.3 allows by name in this function.
SELECT s.year, s.round, s.kind, r.driver_id, r.points
FROM results r
JOIN sessions s ON s.session_id = r.session_id
WHERE s.kind IN ('R', 'S')
"""


def _query(conn, sql: str, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def _form_ppr(conn, n_races: int = config.WP_FORM_RACES) -> pd.DataFrame:
    """Mean points over a driver's previous ``n_races`` race/sprint sessions, strictly
    earlier by ``(year, round)`` — so the current round's own sprint is excluded too."""
    df = _query(conn, _FORM_SQL)
    if df.empty:
        return pd.DataFrame({"driver_id": [], "year": [], "round": [], "form_ppr": []})
    df["key"] = df["year"].astype(int) * 100 + df["round"].astype(int)
    df["kind_order"] = np.where(df["kind"] == "S", 0, 1)   # a sprint precedes its race
    df["points"] = df["points"].astype(float)
    targets = df.loc[df["kind"] == "R", ["driver_id", "year", "round", "key"]].drop_duplicates()
    out: list[tuple] = []
    for driver, grp in df.groupby("driver_id", sort=False):
        g = grp.sort_values(["key", "kind_order"], kind="mergesort")
        keys, pts = g["key"].to_numpy(), g["points"].to_numpy()
        tg = targets[targets["driver_id"] == driver]
        for _, t in tg.iterrows():
            i = int(np.searchsorted(keys, int(t["key"]), side="left"))
            window = pts[max(0, i - n_races):i]
            out.append((driver, int(t["year"]), int(t["round"]),
                        float(window.mean()) if window.size else float("nan")))
    return pd.DataFrame(out, columns=["driver_id", "year", "round", "form_ppr"])


def _derive(raw: pd.DataFrame, form: pd.DataFrame) -> pd.DataFrame:
    """The §1.2 derivations. Every one of them reads laps ``<= lap_number`` only."""
    df = raw.copy()
    for c in ("position", "lap_number", "total_laps", "tyre_life", "grid_position",
              "stops_made", "drivers_on_lap"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    for c in ("gap_to_leader_s", "interval_s", "lap_time_s"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    df = df.sort_values(["session_id", "lap_number", "position"], kind="mergesort").reset_index(drop=True)

    comp = df["compound"].astype(object).where(df["compound"].notna(), "UNKNOWN").astype(str).str.upper()
    df["compound"] = comp.where(comp.isin(COMPOUNDS), "UNKNOWN")

    df["gap_to_leader_s"] = df["gap_to_leader_s"].clip(0.0, config.WP_GAP_LEADER_CLIP_S)
    ahead = df["interval_s"].fillna(0.0).clip(0.0, config.WP_GAP_AHEAD_CLIP_S)
    df["gap_ahead_s"] = np.where(df["position"] == 1, 0.0, ahead)
    # the car one position behind on the same lap (rows are already position-ordered)
    behind = df.groupby(["session_id", "lap_number"], sort=False)["interval_s"].shift(-1)
    df["gap_behind_s"] = behind.fillna(config.WP_GAP_BEHIND_DEFAULT_S)
    df["tyre_life"] = df["tyre_life"].fillna(0.0)

    field_med = df.groupby(["session_id", "lap_number"], sort=False)["lap_time_s"].transform("median")
    delta = df["lap_time_s"] - field_med
    df["__d"] = delta
    roll = (df.sort_values(["session_id", "driver_id", "lap_number"], kind="mergesort")
              .groupby(["session_id", "driver_id"], sort=False)["__d"]
              .rolling(3, min_periods=1).mean().reset_index(level=[0, 1], drop=True))
    df["pace_delta_r3"] = roll.reindex(df.index)
    df = df.drop(columns="__d")

    # "session median lap time" as an EXPANDING median over laps <= L: a session-wide
    # median would read laps after L and break prefix invariance (§1.4).
    per_lap = (df.groupby(["session_id", "lap_number"], sort=True)["lap_time_s"].median()
                 .groupby(level=0).expanding().median().reset_index(level=0, drop=True)
                 .rename("ref_lap_s"))
    df = df.merge(per_lap.reset_index(), on=["session_id", "lap_number"], how="left")
    df["is_lapped"] = (df["gap_to_leader_s"] > df["ref_lap_s"]).astype(float)
    df["is_leader"] = (df["position"] == 1).astype(float)

    df["laps_remaining"] = df["total_laps"] - df["lap_number"]
    df["race_progress"] = df["lap_number"] / df["total_laps"]
    df["stops_made"] = df["stops_made"].fillna(0.0)
    df["is_green"] = df["is_green"].map({True: 1.0, False: 0.0}).astype(float)
    df["cars_running"] = df["drivers_on_lap"]
    df["team_best_pos"] = df.groupby(["session_id", "lap_number", "team_id"], sort=False)["position"].transform("min")
    df["grid_minus_pos"] = df["grid_position"] - df["position"]

    df = df.merge(form, on=["driver_id", "year", "round"], how="left")
    for c in FEATURE_NAMES:
        if c not in CATEGORICAL_FEATURES:
            df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    out = df[list(FEATURE_KEY_COLUMNS) + list(FEATURE_NAMES)].copy()
    out["session_id"] = out["session_id"].astype(int)
    out["year"] = out["year"].astype(int)
    out["round"] = out["round"].astype(int)
    out["lap_number"] = out["lap_number"].astype(int)
    out["driver_id"] = out["driver_id"].astype(str)
    return out.sort_values(["session_id", "driver_id", "lap_number"], kind="mergesort").reset_index(drop=True)


def build_features(conn, *, upto: tuple[int, int] | None = None) -> pd.DataFrame:
    """(session_id, year, round, driver_id, lap_number) + FEATURE_NAMES. Prefix-safe."""
    key = None if upto is None else int(upto[0]) * 100 + int(upto[1])
    return _derive(_query(conn, _FEATURE_SQL, {"upto": key}), _form_ppr(conn))


def build_labels(conn) -> pd.DataFrame:
    """(session_id, driver_id, won) — the label, read through its own function (§1.3)."""
    df = _query(conn, "SELECT r.session_id, r.driver_id, (r.position = 1) AS won "
                      "FROM results r JOIN sessions s ON s.session_id = r.session_id "
                      "WHERE s.kind = 'R'")
    if df.empty:
        return pd.DataFrame({"session_id": [], "driver_id": [], "won": []})
    df["won"] = df["won"].fillna(False).astype(int)
    return df


# ---------------------------------------------------------------------------
# Model (§1.5) — a deliberately tiny HistGradientBoostingClassifier
# ---------------------------------------------------------------------------

def design_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """``FEATURE_NAMES`` in order, ``compound`` as a pinned pandas Categorical."""
    X = df.loc[:, list(FEATURE_NAMES)].copy()
    for c in CATEGORICAL_FEATURES:
        X[c] = pd.Categorical(X[c].astype(object), categories=list(COMPOUNDS))
    return X


def fit_fold(X, y, params: dict):
    """One fitted estimator. ``X`` may be a design matrix or a full feature frame."""
    from sklearn.ensemble import HistGradientBoostingClassifier

    X = design_matrix(X)
    model = HistGradientBoostingClassifier(categorical_features=list(CATEGORICAL_FEATURES), **params)
    return model.fit(X, np.asarray(y).astype(int))


def _score(model, df: pd.DataFrame) -> np.ndarray:
    return model.predict_proba(design_matrix(df))[:, 1]


def normalise_within_lap(df: pd.DataFrame, col: str = "p_win_raw") -> pd.DataFrame:
    """Step 2 of §1.7: divide by the lap's total over the drivers still running.

    A lap whose scores all underflow falls back to uniform ``1/n`` and every row of that
    lap is flagged ``degraded`` — a uniform stripe must never render as a prediction.
    """
    out = df.copy()
    out["__q"] = pd.to_numeric(out[col], errors="coerce").fillna(0.0).clip(lower=0.0)
    grp = out.groupby(["session_id", "lap_number"], sort=False)["__q"]
    total, n = grp.transform("sum"), grp.transform("size")
    ok = total > 0
    out["p_win"] = np.where(ok, out["__q"] / total.where(ok, 1.0), 1.0 / n)
    out["degraded"] = (~ok).to_numpy()
    return out.drop(columns="__q")


def _race_keys(df: pd.DataFrame) -> list[tuple[int, int]]:
    k = df[["year", "round"]].drop_duplicates()
    return sorted((int(y), int(r)) for y, r in zip(k["year"], k["round"]))


def fit_isotonic_nested(feat, lab, train_races, *, inner_folds: int):
    """§1.7: an isotonic map fitted on **inner-out-of-fold** scores of the training races.

    A map fitted on the very predictions it corrects is leakage; this nesting is the
    whole reason the calibration path is heavier than a one-liner.
    """
    from sklearn.isotonic import IsotonicRegression

    df = feat if "won" in feat.columns else feat.merge(lab, on=["session_id", "driver_id"], how="left")
    df = df.copy()
    df["won"] = df["won"].fillna(0).astype(int)
    keys = {(int(y), int(r)) for y, r in train_races}
    df = df[[(int(y), int(r)) in keys for y, r in zip(df["year"], df["round"])]]
    if df.empty or df["won"].nunique() < 2:
        return None
    inner = np.array([fold_id(y, r, inner_folds) for y, r in zip(df["year"], df["round"])])
    scores = np.zeros(len(df))
    for k in np.unique(inner):
        te = inner == k
        if (~te).sum() == 0 or df["won"].to_numpy()[~te].sum() == 0:
            scores[te] = df["won"].mean()
            continue
        scores[te] = _score(fit_fold(df[~te], df["won"].to_numpy()[~te], config.WP_MODEL_PARAMS), df[te])
    return IsotonicRegression(out_of_bounds="clip").fit(scores, df["won"].to_numpy())


def _grouped_oof(df: pd.DataFrame, groups: np.ndarray, *, calibration: str,
                 inner_folds: int = config.WP_INNER_FOLDS,
                 models: dict | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Hold each group out in turn; return ``(score, held_out_group_index)`` per row.

    The group is the race fold for ``loro`` and ``events.circuit_key`` for ``loco``
    (§1.8.1); in both cases a row is never scored by a model that saw its own race.
    """
    raw = np.zeros(len(df), dtype=float)
    y = df["won"].to_numpy().astype(int)
    for g in pd.unique(groups):
        te = groups == g
        train = df[~te]
        if len(train) == 0 or y[~te].sum() == 0:
            raw[te] = float(y.mean())
            continue
        model = fit_fold(train, y[~te], config.WP_MODEL_PARAMS)
        if models is not None:
            models[g] = (model, int(len(_race_keys(train))))
        scores = _score(model, df[te])
        if calibration == "isotonic":
            iso = fit_isotonic_nested(train, None, _race_keys(train), inner_folds=inner_folds)
            if iso is not None:
                scores = np.asarray(iso.predict(scores), dtype=float)
        raw[te] = scores
    return raw, groups


def predict_oof(feat: pd.DataFrame, lab: pd.DataFrame, *, n_folds: int,
                calibration: str) -> pd.DataFrame:
    """Out-of-fold probabilities for every feature row (§1.9): calibrate, then normalise.

    The returned frame carries the feature keys plus ``won``, ``fold_index``,
    ``p_win_raw`` (the pre-normalisation, calibrated-or-raw score), ``p_win`` and
    ``degraded``. Nothing here ever sees a full-data model.
    """
    df = feat.merge(lab, on=["session_id", "driver_id"], how="left") if lab is not None else feat.copy()
    df["won"] = df["won"].fillna(0).astype(int)
    folds = np.array([fold_id(y, r, n_folds) for y, r in zip(df["year"], df["round"])])
    raw, _ = _grouped_oof(df, folds, calibration=calibration)
    df["fold_index"] = folds
    df["p_win_raw"] = raw
    return normalise_within_lap(df, "p_win_raw")


# ---------------------------------------------------------------------------
# Metrics, baselines and the stored reliability artifact (§1.6, §1.8)
# ---------------------------------------------------------------------------

RELIABILITY_NOTE = ("Wilson 95% on (wins, n). Per-lap rows inside a race are heavily "
                    "autocorrelated, so the effective sample size per bin is far smaller "
                    "than n: the bars are the right shape and too tight, optimistically.")


def log_loss_eps(y: np.ndarray, p: np.ndarray, eps: float = LOGLOSS_EPS) -> float:
    y = np.asarray(y, dtype=float)
    p = np.clip(np.asarray(p, dtype=float), eps, 1.0 - eps)
    return float(-(y * np.log(p) + (1.0 - y) * np.log(1.0 - p)).mean())


def brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def _decile(race_progress: pd.Series) -> np.ndarray:
    return np.clip((pd.to_numeric(race_progress, errors="coerce").fillna(0.0) * 10).astype(int), 0, 9)


def baseline_positional(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Baseline A — ``P(win | position, race-fraction decile)``, the bar the model must clear.

    Fitted on ``train`` only, so the lookup table is held to the same honesty as the
    model it is compared against; unseen cells fall back to the training base rate.
    """
    tr = train.assign(__d=_decile(train["race_progress"]))
    te = test.assign(__d=_decile(test["race_progress"]))
    table = tr.groupby(["position", "__d"])["won"].mean()
    p = te.set_index(["position", "__d"]).index.map(table).to_numpy(dtype=float)
    return np.where(np.isnan(p), float(tr["won"].mean()), p)


def baseline_leader(df: pd.DataFrame) -> np.ndarray:
    """Baseline B — the current leader always wins. Easy to beat; its log loss is the point."""
    return (pd.to_numeric(df["is_leader"], errors="coerce").fillna(0.0) == 1).to_numpy(dtype=float)


def attach_baselines(df: pd.DataFrame, groups: np.ndarray | None = None) -> pd.DataFrame:
    """``p_base_pos`` (out-of-group when ``groups`` is given) and ``p_base_lead``."""
    out = df.copy()
    if groups is None:
        out["p_base_pos"] = baseline_positional(out, out)
    else:
        p = np.zeros(len(out))
        for g in pd.unique(groups):
            te = groups == g
            p[te] = baseline_positional(out[~te] if (~te).any() else out, out[te])
        out["p_base_pos"] = p
    out["p_base_lead"] = baseline_leader(out)
    return out


def metrics(df: pd.DataFrame, *, scope: str, variant: str) -> dict:
    """One ``wp_metrics`` row (minus ``assumption_set_id``) for a scored frame."""
    if df.empty:
        return {}
    d = df if "p_base_pos" in df.columns else attach_baselines(df)
    y, p = d["won"].to_numpy(dtype=float), d["p_win"].to_numpy(dtype=float)
    row = {"scope": scope, "variant": variant, "n_rows": int(len(d)),
           "n_races": int(d[["year", "round"]].drop_duplicates().shape[0]),
           "brier": brier(y, p), "log_loss": log_loss_eps(y, p),
           "brier_baseline_pos": brier(y, d["p_base_pos"].to_numpy()),
           "brier_baseline_lead": brier(y, d["p_base_lead"].to_numpy()),
           "brier_fold_min": None, "brier_fold_median": None, "brier_fold_max": None,
           "note": RELIABILITY_NOTE}
    if "fold_index" in d.columns and d["fold_index"].nunique() > 1:
        per = d.groupby("fold_index").apply(lambda g: brier(g["won"], g["p_win"]), include_groups=False)
        row |= {"brier_fold_min": float(per.min()), "brier_fold_median": float(per.median()),
                "brier_fold_max": float(per.max())}
    return row


def _wilson(wins: int, n: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if n <= 0:
        return 0.0, 0.0
    p = wins / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def reliability_bins(df: pd.DataFrame, edges: tuple[float, ...]) -> pd.DataFrame:
    """The stored reliability curve: one row per non-empty bin of the pinned §1.8 edges."""
    cols = ["scope", "variant", "bin_index", "bin_lo", "bin_hi", "n_rows", "n_wins",
            "mean_predicted", "observed_rate", "observed_lo", "observed_hi"]
    if df.empty:
        return pd.DataFrame({c: pd.Series(dtype=object) for c in cols})
    p = df["p_win"].to_numpy(dtype=float)
    y = df["won"].to_numpy(dtype=float)
    idx = np.clip(np.searchsorted(np.asarray(edges, dtype=float), p, side="left") - 1,
                  0, len(edges) - 2)
    rows = []
    for b in range(len(edges) - 1):
        m = idx == b
        n = int(m.sum())
        if n == 0:
            continue
        wins = int(y[m].sum())
        lo, hi = _wilson(wins, n)
        rows.append({"scope": None, "variant": None, "bin_index": b,
                     "bin_lo": float(edges[b]), "bin_hi": float(edges[b + 1]),
                     "n_rows": n, "n_wins": wins, "mean_predicted": float(p[m].mean()),
                     "observed_rate": wins / n, "observed_lo": lo, "observed_hi": hi})
    return pd.DataFrame(rows, columns=cols)


# ---------------------------------------------------------------------------
# Auto-annotated swings (§1.10)
# ---------------------------------------------------------------------------

SWING_COLUMNS = ["session_id", "lap_number", "swing_mass", "cause", "mover_driver_id",
                 "mover_p_before", "mover_p_after", "rank_in_race"]


def _swing_cause(session_id: int, lap: int, movers: list[str], status: dict, stops: set,
                 gone: set) -> str:
    """The §1.10 order: track status, then a pit stop by a top-3 mover, then a retirement."""
    cause = STATUS_CAUSE.get(str(status.get((session_id, lap), "1")))
    if cause:
        return cause
    if any((session_id, lap, d) in stops for d in movers[:3]):
        return "pit_cycle"
    if gone:
        return "retirement"
    return "on_track"


def detect_swings(prob: pd.DataFrame, conn) -> pd.DataFrame:
    """Per-lap transferred probability mass, thresholded, de-duplicated and ranked."""
    if prob.empty:
        return pd.DataFrame({c: pd.Series(dtype=object) for c in SWING_COLUMNS})
    sids = [int(s) for s in sorted(prob["session_id"].unique())]
    ls = _query(conn, "SELECT session_id, lap_number, worst_status FROM lap_status "
                      "WHERE session_id = ANY(%(s)s)", {"s": sids})
    status = {(int(a), int(b)): str(c) for a, b, c in ls.itertuples(index=False, name=None)}
    ps = _query(conn, "SELECT session_id, driver_id, lap_in FROM pit_stops "
                      "WHERE session_id = ANY(%(s)s)", {"s": sids})
    stops = {(int(a), int(c), str(b)) for a, b, c in ps.itertuples(index=False, name=None)}
    rows: list[dict] = []
    for sid, grp in prob.groupby("session_id", sort=True):
        wide = grp.pivot_table(index="lap_number", columns="driver_id", values="p_win",
                               aggfunc="last").sort_index()
        present = wide.notna()
        filled = wide.fillna(0.0)
        delta = filled.diff()
        mass = 0.5 * delta.abs().sum(axis=1)
        flagged = mass[mass >= config.WP_SWING_MIN_MASS].sort_values(ascending=False)
        kept: list[int] = []
        for lap in flagged.index:
            if any(abs(int(lap) - k) <= config.WP_SWING_DEDUP_LAPS for k in kept):
                continue
            kept.append(int(lap))
            if len(kept) >= config.WP_SWING_MAX_ANNOTATIONS:
                break
        for rank, lap in enumerate(sorted(kept, key=lambda l: -float(mass.loc[l])), start=1):
            d = delta.loc[lap].abs().sort_values(ascending=False)
            movers = [str(x) for x in d.index[:3]]
            mover = movers[0]
            prev_lap = wide.index[wide.index.get_loc(lap) - 1]
            gone = {c for c in wide.columns if present.loc[prev_lap, c] and not present.loc[lap, c]}
            rows.append({"session_id": int(sid), "lap_number": int(lap),
                         "swing_mass": float(mass.loc[lap]),
                         "cause": _swing_cause(int(sid), int(lap), movers, status, stops, gone),
                         "mover_driver_id": mover,
                         "mover_p_before": float(filled.loc[prev_lap, mover]),
                         "mover_p_after": float(filled.loc[lap, mover]),
                         "rank_in_race": rank})
    return pd.DataFrame(rows, columns=SWING_COLUMNS)


# ---------------------------------------------------------------------------
# Stored artifacts (§1.9.1)
# ---------------------------------------------------------------------------

def _sklearn_version() -> str:
    import sklearn

    return str(sklearn.__version__)


def artifact_blob(model) -> tuple[bytes, str]:
    """``(joblib blob, sha256)`` — the bytes that go into ``wp_model_artifact.artifact``."""
    import joblib

    buf = io.BytesIO()
    joblib.dump(model, buf)
    blob = buf.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()


def load_artifact(conn, assumption_set_id: int, fold_index: int = -1):
    """Load a stored estimator, **refusing** a version or feature-order mismatch (§1.9.1)."""
    import joblib

    with conn.cursor() as cur:
        cur.execute("SELECT sklearn_version, feature_names, artifact FROM wp_model_artifact "
                    "WHERE assumption_set_id = %s AND fold_index = %s",
                    (int(assumption_set_id), int(fold_index)))
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"no wp_model_artifact for (asid={assumption_set_id}, fold={fold_index})")
    version, names, blob = str(row[0]), list(row[1]), bytes(row[2])
    if version != _sklearn_version():
        raise RuntimeError(f"wp_model_artifact was written by scikit-learn {version}, "
                           f"runtime is {_sklearn_version()}: refusing to unpickle")
    if names != list(FEATURE_NAMES):
        raise RuntimeError("wp_model_artifact.feature_names does not match FEATURE_NAMES")
    return joblib.load(io.BytesIO(blob))


def _scope_scored(df: pd.DataFrame, groups: np.ndarray, *, calibration: str,
                  models: dict | None = None) -> pd.DataFrame:
    """Hold each group out, calibrate (optional), normalise, attach out-of-group baselines."""
    raw, _ = _grouped_oof(df, groups, calibration=calibration, models=models)
    out = df.copy()
    out["fold_index"] = np.asarray(groups)
    out["p_win_raw"] = raw
    return attach_baselines(normalise_within_lap(out), groups)


def _split_scored(df: pd.DataFrame, train_mask: np.ndarray, *, calibration: str) -> pd.DataFrame:
    """The forward-in-time split (§1.6): fit on the past, score the future once."""
    train, test = df[train_mask], df[~train_mask].copy()
    if train.empty or test.empty:
        return test.assign(fold_index=-1, p_win_raw=0.0, p_win=0.0, degraded=False,
                           p_base_pos=0.0, p_base_lead=0.0)
    model = fit_fold(train, train["won"], config.WP_MODEL_PARAMS)
    scores = _score(model, test)
    if calibration == "isotonic":
        iso = fit_isotonic_nested(train, None, _race_keys(train), inner_folds=config.WP_INNER_FOLDS)
        if iso is not None:
            scores = np.asarray(iso.predict(scores), dtype=float)
    test["fold_index"] = -1
    test["p_win_raw"] = scores
    out = normalise_within_lap(test)
    out["p_base_pos"] = baseline_positional(train, out)
    out["p_base_lead"] = baseline_leader(out)
    return out


# ---------------------------------------------------------------------------
# The run-end recompute (§1.9.2, §6.3)
# ---------------------------------------------------------------------------

SCOPE_LORO, SCOPE_LOCO, SCOPE_IN_SAMPLE = "loro", "loco", "in_sample"


def _circuit_groups(conn, df: pd.DataFrame) -> np.ndarray:
    """``events.circuit_key`` per row, for the leave-one-circuit-out scope (§1.8.1)."""
    ev = _query(conn, "SELECT year, round, circuit_key FROM events")
    key = {(int(y), int(r)): (None if pd.isna(c) else int(c))
           for y, r, c in ev.itertuples(index=False, name=None)}
    # an unresolved circuit becomes its own singleton group, never a shared bucket
    return np.array([key.get((int(y), int(r))) or -(int(y) * 100 + int(r))
                     for y, r in zip(df["year"], df["round"])])


def _metric_rows(scored: pd.DataFrame, scope: str, variant: str, asid: int,
                 edges: tuple[float, ...]) -> tuple[dict, pd.DataFrame]:
    row = metrics(scored, scope=scope, variant=variant)
    if not row:
        return {}, pd.DataFrame()
    row = {"assumption_set_id": asid} | row
    bins = reliability_bins(scored, edges)
    if not bins.empty:
        bins = bins.assign(assumption_set_id=asid, scope=scope, variant=variant)
    return row, bins


def _current_run(conn, asid: int, mv: str):
    with conn.cursor() as cur:
        cur.execute("SELECT wp_run_id FROM wp_run WHERE assumption_set_id = %s "
                    "AND model_version = %s AND is_current", (asid, mv))
        return cur.fetchone()


def stored_is_complete(conn, asid: int) -> bool:
    """Does every raced session still carry an out-of-fold row for every one of its laps?

    The short-circuit of §6.3 step 2 keys off ``model_version`` alone, but re-ingesting a
    session runs ``db.delete_session_children``, which (correctly) cascades
    ``wp_lap_probability`` away. Without this check the race-key set is unchanged, the
    refit is skipped, and that session's river silently stays empty forever.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) FROM (
                SELECT l.session_id, count(DISTINCT l.lap_number) AS n
                FROM laps l JOIN sessions s ON s.session_id = l.session_id
                WHERE s.kind = 'R' GROUP BY 1
            ) t LEFT JOIN (
                SELECT session_id, count(DISTINCT lap_number) AS m
                FROM wp_lap_probability WHERE assumption_set_id = %s GROUP BY 1
            ) w ON w.session_id = t.session_id
            WHERE w.m IS NULL OR w.m <> t.n
        """, (int(asid),))
        return int(cur.fetchone()[0]) == 0


def _write_status(cur, asid: int, sessions: list[int], ok_sessions: set[int], reason: str) -> None:
    """§6.3 step 5 — one ``win_probability`` key per race session."""
    from psycopg.types.json import Jsonb

    for sid in sessions:
        value = "ok" if sid in ok_sessions else reason
        # `status <> 'failed'` (2026-09-14): a session whose ingest failed must keep an
        # EMPTY analytics_status (docs/SPEC.md:864). Without the guard this run-end step
        # merged {"win_probability": ...} onto a failed session, so it looked partly
        # successful. Same defect the v1.3 review fixed in preview.odi_status.
        cur.execute("UPDATE session_ingests SET analytics_status = "
                    "coalesce(analytics_status, '{}'::jsonb) || %s::jsonb "
                    "WHERE session_id = %s AND status <> 'failed'",
                    (Jsonb({"win_probability": value}), sid))


def _store_frame(cur, table: str, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    return db.copy_frame(cur, table, frames.cast_frame(df, table))


def _compute_all(conn, df: pd.DataFrame, asid: int) -> tuple[dict, dict, object]:
    """Every stored scope × variant (§6.3 step 3), plus the fold models and the full model."""
    folds = np.array([fold_id(y, r, config.WP_N_FOLDS) for y, r in zip(df["year"], df["round"])])
    models: dict = {}
    scored: dict[tuple[str, str], pd.DataFrame] = {}
    scored[(SCOPE_LORO, "plain")] = _scope_scored(df, folds, calibration="none", models=models)
    scored[(SCOPE_LORO, "isotonic")] = _scope_scored(df, folds, calibration="isotonic")
    circuits = _circuit_groups(conn, df)
    scored[(SCOPE_LOCO, "plain")] = _scope_scored(df, circuits, calibration="none")
    scored[(SCOPE_LOCO, "isotonic")] = _scope_scored(df, circuits, calibration="isotonic")
    latest = int(df["year"].max())
    mask = (df["year"] < latest).to_numpy()
    if mask.any() and (~mask).any():
        for variant, cal in (("plain", "none"), ("isotonic", "isotonic")):
            scored[(f"year:{latest}", variant)] = _split_scored(df, mask, calibration=cal)
    full = fit_fold(df, df["won"], config.WP_MODEL_PARAMS)
    ins = df.copy()
    ins["fold_index"] = -1
    ins["p_win_raw"] = _score(full, df)
    scored[(SCOPE_IN_SAMPLE, "plain")] = attach_baselines(normalise_within_lap(ins))
    iso = fit_isotonic_nested(df, None, _race_keys(df), inner_folds=config.WP_INNER_FOLDS)
    ins_iso = ins.copy()
    if iso is not None:
        ins_iso["p_win_raw"] = np.asarray(iso.predict(ins["p_win_raw"].to_numpy()), dtype=float)
    scored[(SCOPE_IN_SAMPLE, "isotonic")] = attach_baselines(normalise_within_lap(ins_iso))
    return scored, models, full


def _artifact_frame(models: dict, full, mv: str, asid: int, n_races: int) -> pd.DataFrame:
    from datetime import datetime, timezone
    from psycopg.types.json import Jsonb

    now = datetime.now(timezone.utc)
    rows = []
    for fold, (model, n_train) in sorted(models.items(), key=lambda kv: int(kv[0])):
        rows.append((int(fold), model, int(n_train)))
    rows.append((-1, full, int(n_races)))
    out = []
    for fold, model, n_train in rows:
        blob, sha = artifact_blob(model)
        out.append({"assumption_set_id": asid, "fold_index": fold, "model_version": mv,
                    "sklearn_version": _sklearn_version(), "feature_names": Jsonb(list(FEATURE_NAMES)),
                    "n_train_races": n_train, "artifact_sha256": sha, "artifact": blob,
                    "trained_at": now})
    return pd.DataFrame(out)


COUNT_KEYS = ("wp_run", "wp_model_artifact", "wp_lap_probability", "wp_swing",
              "wp_metrics", "wp_reliability_bin")


def recompute_winprob(conn, assumption_set_id: int) -> dict[str, int]:
    """Fit, predict out-of-fold and store the six ``wp_*`` tables (§6.3).

    Short-circuits on an unchanged race-key set (the ``--force`` no-op path): a
    ``--force`` re-ingest must leave every published probability bit-identical.

    Like ``sim.recompute_hazards``, **the caller owns the COMMIT**: ingest wraps
    ``companion.recompute_companion`` in ``ingest._committed``. The inner
    ``conn.transaction()`` here is a savepoint in that block, so a failure half-way
    through the writes leaves the previous run's rows intact; a direct caller on an
    ``autocommit=False`` connection must ``conn.commit()`` itself.
    """
    asid = int(assumption_set_id)
    counts = dict.fromkeys(COUNT_KEYS, 0)
    feat = build_features(conn)
    lab = build_labels(conn)
    if feat.empty or lab.empty or int(lab["won"].sum()) == 0:
        log.info("winprob: no race rows to train on; leaving the wp_* tables empty")
        return counts
    df = feat.merge(lab, on=["session_id", "driver_id"], how="left")
    df["won"] = df["won"].fillna(0).astype(int)
    keys = _race_keys(df)
    mv = model_version(asid, keys)
    if _current_run(conn, asid, mv) is not None and stored_is_complete(conn, asid):
        log.info("winprob: model_version %s is already current — no refit (§6.3 step 2)", mv)
        return db.table_counts(conn, COUNT_KEYS) | {"short_circuit": 1}

    scored, models, full = _compute_all(conn, df, asid)
    stored = scored[(SCOPE_LORO, "isotonic" if config.WP_CALIBRATION == "isotonic" else "plain")]
    y = stored["won"].to_numpy(dtype=float)
    brier_oof = brier(y, stored["p_win"].to_numpy())
    b_pos = brier(y, stored["p_base_pos"].to_numpy())
    b_lead = brier(y, stored["p_base_lead"].to_numpy())
    skill_ok = bool(brier_oof < b_pos)
    swings = detect_swings(stored, conn)

    metric_rows, bin_frames = [], []
    for (scope, variant), sc in scored.items():
        row, bins = _metric_rows(sc, scope, variant, asid, config.WP_RELIABILITY_BINS)
        if row:
            metric_rows.append(row)
        if len(bins):
            bin_frames.append(bins)

    lap_df = stored.loc[:, ["session_id", "driver_id", "lap_number", "fold_index",
                            "p_win_raw", "p_win", "degraded"]].assign(
        assumption_set_id=asid, pred_kind="oof")
    swing_df = swings.assign(assumption_set_id=asid) if len(swings) else swings
    art_df = _artifact_frame(models, full, mv, asid, len(keys))
    met_df = pd.DataFrame(metric_rows)
    bin_df = pd.concat(bin_frames, ignore_index=True) if bin_frames else pd.DataFrame()
    sessions = [int(s) for s in sorted(df["session_id"].unique())]
    covered = _covered_sessions(conn, lap_df)
    reason = ("error: win_prob no skill" if not skill_ok
              else "error: win_probability has no out-of-fold row for every lap")

    with conn.transaction():
        with conn.cursor() as cur:
            # Clear is_current EVERYWHERE, not just within this assumption set
            # (2026-09-14). Scoping the clear to `asid` left the previous set's run
            # flagged current when the assumption hash moved — after the v1.3 constants
            # shifted 254 -> 532 the table held two current runs, and "the current model"
            # stopped being a single row. `is_current` means one run, full stop.
            cur.execute("UPDATE wp_run SET is_current = false WHERE is_current")
            # UPSERT, not INSERT: a refit can legitimately land on an existing
            # model_version. `stored_is_complete` sends a run whose race-key set is
            # unchanged but whose probabilities were cascaded away by a re-ingest down
            # the full-refit path, and `wp_run_model_version_uq` would then reject the
            # row that refit just earned. Rewriting the run in place keeps §6.3's
            # "one current run per assumption set" and makes step 4 idempotent.
            cur.execute(
                "INSERT INTO wp_run (assumption_set_id, model_version, sklearn_version, n_train_races,"
                " n_rows, n_folds, calibration, tuning_scope, brier_oof, brier_baseline_pos,"
                " brier_baseline_lead, skill_ok, is_current, trained_at) VALUES"
                " (%s,%s,%s,%s,%s,%s,%s,'oof',%s,%s,%s,%s,true,now())"
                " ON CONFLICT (assumption_set_id, model_version) DO UPDATE SET"
                " sklearn_version = EXCLUDED.sklearn_version,"
                " n_train_races = EXCLUDED.n_train_races, n_rows = EXCLUDED.n_rows,"
                " n_folds = EXCLUDED.n_folds, calibration = EXCLUDED.calibration,"
                " tuning_scope = EXCLUDED.tuning_scope, brier_oof = EXCLUDED.brier_oof,"
                " brier_baseline_pos = EXCLUDED.brier_baseline_pos,"
                " brier_baseline_lead = EXCLUDED.brier_baseline_lead,"
                " skill_ok = EXCLUDED.skill_ok, is_current = true, trained_at = now()",
                (asid, mv, _sklearn_version(), len(keys), int(len(lap_df)), int(config.WP_N_FOLDS),
                 str(config.WP_CALIBRATION), brier_oof, b_pos, b_lead, skill_ok))
            counts["wp_run"] = 1
            cur.execute("DELETE FROM wp_model_artifact WHERE assumption_set_id = %s", (asid,))
            counts["wp_model_artifact"] = _store_frame(cur, "wp_model_artifact", art_df)
            cur.execute("DELETE FROM wp_lap_probability WHERE session_id = ANY(%s)", (sessions,))
            cur.execute("DELETE FROM wp_swing WHERE session_id = ANY(%s)", (sessions,))
            cur.execute("DELETE FROM wp_metrics WHERE assumption_set_id = %s", (asid,))
            cur.execute("DELETE FROM wp_reliability_bin WHERE assumption_set_id = %s", (asid,))
            counts["wp_lap_probability"] = _store_frame(cur, "wp_lap_probability", lap_df)
            counts["wp_swing"] = _store_frame(cur, "wp_swing", swing_df)
            counts["wp_metrics"] = _store_frame(cur, "wp_metrics", met_df)
            counts["wp_reliability_bin"] = _store_frame(cur, "wp_reliability_bin", bin_df)
            _write_status(cur, asid, sessions, covered if skill_ok else set(), reason)
    log.info("winprob %s: brier_oof=%.5f baseline=%.5f skill_ok=%s", mv, brier_oof, b_pos, skill_ok)
    return counts


def _covered_sessions(conn, lap_df: pd.DataFrame) -> set[int]:
    """Sessions whose every lap of ``laps`` carries at least one out-of-fold row (§1.9.2)."""
    have = lap_df.groupby("session_id")["lap_number"].nunique()
    want = _query(conn, "SELECT l.session_id, count(DISTINCT l.lap_number) AS n FROM laps l "
                        "JOIN sessions s ON s.session_id = l.session_id WHERE s.kind = 'R' "
                        "GROUP BY 1")
    need = {int(a): int(b) for a, b in want.itertuples(index=False, name=None)}
    return {int(sid) for sid, n in have.items() if need.get(int(sid), -1) == int(n)}
