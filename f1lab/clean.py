"""Turning raw timing data into lap times you can actually compare.

This is the unglamorous 80% of F1 analytics. A race produces ~1300 lap times and
perhaps 800 of them are meaningless for pace analysis: in-laps, out-laps, laps
behind a safety car, laps spent stuck in dirty air, laps where the driver was
told to save fuel. Every downstream model is only as good as this filter.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import fastf1
import pandas as pd

from .config import GREEN_FLAG, OUTLIER_THRESHOLD

warnings.filterwarnings("ignore", category=FutureWarning)

# Anchored to the project root rather than the working directory, so a notebook
# run from notebooks/ shares one cache with a script run from the root.
DEFAULT_CACHE = Path(__file__).resolve().parent.parent / "cache"


def load_race(
    year: int,
    gp: str | int,
    session: str = "R",
    cache: str | Path | None = None,
    *,
    messages: bool = False,
):
    """Load one session, with the on-disk cache enabled.

    The first call for a session pulls several MB from the F1 timing API and is
    slow; every call after that reads from the cache and is near-instant. Never
    run this without the cache enabled.

    ``messages`` controls whether race-control messages are parsed. It stays
    ``False`` for ``R`` and ``S`` in this release (QUALI_SPEC §0.2/D4): turning it
    on there would re-activate ``excl_deleted`` on every race and move the
    representative lap set under every existing model. Qualifying *needs* it —
    see :func:`load_quali`.
    """
    cache_dir = Path(cache) if cache is not None else DEFAULT_CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)
    s = fastf1.get_session(year, gp, session)
    s.load(telemetry=False, weather=True, messages=messages)
    return s


def load_quali(year: int, gp: str | int, session: str = "Q", cache: str | Path | None = None):
    """Load a qualifying (``Q``) or sprint-qualifying (``SQ``) session.

    ``load_race(..., messages=True)``, and the flag is load-bearing twice over
    (QUALI_SPEC §1.4, both measured):

    - ``Deleted`` / ``DeletedReason`` are derived from race-control messages.
      2024 R08 Monaco Q has **21** deleted laps with the flag on and **0** with it
      off; the whole ``excl_deleted`` rule is inert without it.
    - For sprint qualifying FastF1 *computes* SQ1/SQ2/SQ3 from the laps plus those
      messages. With the flag off it logs "Failed to calculate quali results from
      lap times!" and hands back all-NaT — 2024 R05 China SQ goes from 20/15/10
      official times to 0/0/0, and from 20 to 0 non-null ``Position`` values.
    """
    return load_race(year, gp, session, cache=cache, messages=True)


def load_telemetry(
    year: int,
    gp: str | int,
    session: str = "R",
    cache: str | Path | None = None,
):
    """Load one session **with** the 10 Hz car and position channels.

    This is the only function in the project that passes ``telemetry=True``
    (TELEMETRY_SPEC T7). It is deliberately a *third* entry point rather than a
    flag on :func:`load_race`: ``load_race`` and :func:`load_quali` own
    ``telemetry=False`` as a guarantee that the 160 already-correct ingests keep
    costing 1-2 MB and two seconds each, and a keyword argument is one edit away
    from flipping that for everybody.

    Two measured consequences of the flag, both of which belong to the caller:

    - **2 extra API requests** (``car_data``, ``position_data``) against a
      500/hour ceiling, and **45-100 MB of cache per session** - ~11 GB across
      the full set. ``scripts/warm_telemetry.py`` is what paces that; the write
      pass calls this against an already-warm cache and touches no network.
    - ``weather`` and ``messages`` are off. The telemetry pass reads its lap
      selection from Postgres (§3.4), not from FastF1, so neither the weather
      frame nor race-control messages are needed to pick or store a trace.
    """
    cache_dir = Path(cache) if cache is not None else DEFAULT_CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)
    s = fastf1.get_session(year, gp, session)
    s.load(telemetry=True, weather=False, messages=False)
    return s


def _is_green(status: object) -> bool:
    """True only if the lap ran entirely under green flags.

    FastF1 concatenates a status code for each marshalling sector the car passed
    through, so a lap that began under a safety car and ended green looks like
    "41". Anything other than an unbroken run of "1" means the lap was
    influenced by something other than the driver and the car.
    """
    if not isinstance(status, str) or not status:
        return False
    return set(status) == {GREEN_FLAG}


def annotate_laps(session) -> pd.DataFrame:
    """ALL laps of the session, with the cleaning verdict appended to each row.

    Appended columns, in this order: ``LapTimeSeconds``, ``excl_no_time``,
    ``excl_in_lap``, ``excl_out_lap``, ``excl_not_green``, ``excl_inaccurate``,
    ``excl_deleted``, ``is_clean``, ``is_outlier``, ``is_representative``.

    - ``is_clean``          no ``excl_*`` flag set (the pre-outlier meaning it has always had)
    - ``is_outlier``        ``is_clean`` and slower than ``OUTLIER_THRESHOLD`` times the median
                            ``LapTimeSeconds`` of the driver's own ``is_clean`` laps
    - ``is_representative`` ``is_clean & ~is_outlier`` — exactly the membership of
                            :func:`clean_laps` with ``drop_outliers=True``

    Nothing is dropped here, so a downstream consumer (the ingest) can store every
    lap together with the reason it was or was not used. The flag logic is the one
    that used to live inside :func:`clean_laps`, moved unchanged.
    """
    laps = session.laps.copy()

    laps["LapTimeSeconds"] = laps["LapTime"].dt.total_seconds()

    laps["excl_no_time"] = laps["LapTimeSeconds"].isna()
    laps["excl_in_lap"] = laps["PitInTime"].notna()
    laps["excl_out_lap"] = laps["PitOutTime"].notna()
    laps["excl_not_green"] = ~laps["TrackStatus"].apply(_is_green)

    # FastF1's own composite sanity flag. It catches timing glitches and laps
    # spanning a session interruption that the rules above can miss.
    if "IsAccurate" in laps.columns:
        laps["excl_inaccurate"] = ~laps["IsAccurate"].fillna(False).astype(bool)
    else:
        laps["excl_inaccurate"] = False

    # Laps deleted by the stewards for track limits are not legal lap times.
    if "Deleted" in laps.columns:
        laps["excl_deleted"] = laps["Deleted"].fillna(False).astype(bool)
    else:
        laps["excl_deleted"] = False

    excl_cols = [c for c in laps.columns if c.startswith("excl_")]
    laps["is_clean"] = ~laps[excl_cols].any(axis=1)

    # Compare each driver only against themselves. An absolute cutoff would
    # punish a slow car for being slow, which is exactly the signal we want
    # to keep. The median is taken over the driver's clean laps only, which is
    # what the original filter did by computing it after the rules had run.
    is_outlier = pd.Series(False, index=laps.index, dtype=bool)
    clean_mask = laps["is_clean"]
    if clean_mask.any():
        clean = laps.loc[clean_mask]
        median = clean.groupby("Driver")["LapTimeSeconds"].transform("median")
        is_outlier.loc[clean_mask] = (clean["LapTimeSeconds"] > median * OUTLIER_THRESHOLD).to_numpy()

    laps["is_outlier"] = is_outlier
    laps["is_representative"] = laps["is_clean"] & ~laps["is_outlier"]

    return laps


def clean_laps(session, drop_outliers: bool = True) -> pd.DataFrame:
    """Return representative green-flag racing laps.

    A filter over :func:`annotate_laps`: keeps the ``is_representative`` rows (or the
    ``is_clean`` rows when ``drop_outliers=False``). The ``excl_*`` and ``is_clean``
    columns stay on the result so the notebook can show exactly how many laps each
    rule removed instead of silently shrinking the dataset.
    """
    a = annotate_laps(session)
    keep = a["is_representative"] if drop_outliers else a["is_clean"]
    return a.loc[keep].drop(columns=["is_outlier", "is_representative"]).reset_index(drop=True)


def exclusion_report(session) -> pd.DataFrame:
    """How many laps each cleaning rule removed, and why.

    Worth printing every time you look at a new race. If one rule is eating an
    unexpected share of the field, something odd happened in that race and you
    want to know about it before you trust any number downstream.
    """
    laps = session.laps.copy()
    laps["LapTimeSeconds"] = laps["LapTime"].dt.total_seconds()

    rules = {
        "no lap time recorded": laps["LapTimeSeconds"].isna(),
        "in-lap (pitting)": laps["PitInTime"].notna(),
        "out-lap (leaving pits)": laps["PitOutTime"].notna(),
        "not fully green flag": ~laps["TrackStatus"].apply(_is_green),
    }
    if "IsAccurate" in laps.columns:
        rules["flagged inaccurate"] = ~laps["IsAccurate"].fillna(False).astype(bool)
    if "Deleted" in laps.columns:
        rules["deleted by stewards"] = laps["Deleted"].fillna(False).astype(bool)

    total = len(laps)
    rows = [
        {"rule": name, "laps_hit": int(mask.sum()), "pct_of_all": 100 * mask.sum() / total}
        for name, mask in rules.items()
    ]
    kept = len(clean_laps(session))
    rows.append({"rule": "SURVIVING (clean + non-outlier)", "laps_hit": kept,
                 "pct_of_all": 100 * kept / total})
    return pd.DataFrame(rows)


def stint_table(session) -> pd.DataFrame:
    """One row per driver-stint: compound, start lap, end lap, length.

    Built from all laps rather than clean laps, because a stint's real boundaries
    are defined by the pit stops we deliberately filtered out above.
    """
    laps = session.laps.copy()
    laps = laps[laps["Stint"].notna()]

    stints = (
        laps.groupby(["Driver", "Stint", "Compound"], observed=True)
        .agg(start_lap=("LapNumber", "min"), end_lap=("LapNumber", "max"), laps=("LapNumber", "count"))
        .reset_index()
        .sort_values(["Driver", "start_lap"])
    )
    return stints.reset_index(drop=True)


def finishing_order(session) -> list[str]:
    """Driver abbreviations in classified finishing order."""
    res = session.results.sort_values("Position")
    return res["Abbreviation"].tolist()


# --- Qualifying cleaning (QUALI_SPEC §2) ---------------------------------------
#
# The race rules above are WRONG for qualifying, and that is measured rather than
# assumed. Three of them change:
#
#   * the green-flag rule INVERTS INTO A FLAG. At 2024 R08 Monaco Q four drivers'
#     official Q1 bests sit on TrackStatus '12' (RUS 1:11.492, STR 1:11.728,
#     HUL 1:11.876, ALO 1:12.019). Applying ``excl_not_green`` would delete four
#     FIA-classified times; across the corpus it kills 34 of 356 official times.
#   * the 107%-of-own-median outlier rule is DROPPED. It would remove 0-79 laps a
#     session (79 of 224 at Monaco), all genuine aborted or tow laps, none a
#     segment best. It answers a race question with a race's assumption — that
#     every lap is a push lap — which qualifying breaks by design.
#   * ``excl_inaccurate`` is REPORTED, NEVER APPLIED: FastF1's IsAccurate encodes
#     race expectations and is routinely false on a qualifying out/in pair.
#
# and one is new: a lap must fall inside a Q1/Q2/Q3 window.

#: The five rules of §2.3. ALL of them must be false for a lap to be representative.
#: Public: ``frames.py`` builds the qualifying ``lap_exclusion_report`` from this tuple
#: and the next one, so the pair is a cross-module contract, not an implementation
#: detail. Changing either changes what the report claims was measured.
QUALI_EXCL_RULES = (
    "excl_no_time", "excl_in_lap", "excl_out_lap", "excl_deleted", "excl_no_segment",
)

#: Computed and stored on every Q/SQ lap, and NEVER applied (§2.3 notes 6 and 7).
#: They are written into ``lap_exclusion_report`` with their counts precisely so a
#: later reader sees the measured number as a decision rather than a missing rule.
QUALI_REPORTED_ONLY = ("excl_not_green", "excl_inaccurate")

# Private spellings kept because f1lab/frames.py (WP3) already imports them; the
# public names above are the ones new code should use.
_QUALI_EXCL_RULES = QUALI_EXCL_RULES
_QUALI_REPORTED_ONLY = QUALI_REPORTED_ONLY


def quali_segment_windows(session) -> list[tuple[pd.Timedelta, pd.Timedelta]]:
    """The Q1/Q2/Q3 (or SQ1/SQ2/SQ3) time windows, from ``session.session_status``.

    §2.2 stage 1. Walk the status rows: the first ``Started`` opens a window,
    ``Finished`` closes it, and **``Aborted`` is ignored** — a red flag inside a
    segment interrupts it, it does not end it. The n-th closed window is segment n.

    Returned times are session-relative ``Timedelta``s on the same clock as
    ``laps['LapStartTime']``.

    The window count is NOT a gate. 2024 R21 Sao Paulo yields exactly three windows
    and still mis-assigns three driver-segments; see :func:`quali_anchor_check`.
    """
    status = getattr(session, "session_status", None)
    if status is None or len(status) == 0:
        return []

    windows: list[tuple[pd.Timedelta, pd.Timedelta]] = []
    open_at: pd.Timedelta | None = None
    for _, row in status.iterrows():
        state = str(row["Status"])
        if state == "Started":
            if open_at is None:
                open_at = row["Time"]
        elif state == "Finished":
            if open_at is not None:
                windows.append((open_at, row["Time"]))
                open_at = None
    return windows


def _assign_segments(laps: pd.DataFrame, windows) -> pd.Series:
    """Provisional segment per lap from ``LapStartTime``, with a grace at each open.

    A lap begun just before the flag still belongs to the segment it was run in, so
    the window opens ``QUALI_WINDOW_GRACE_S`` early. Measured, 0-15 laps a session
    fall outside every window; every one inspected is an in-lap or a garage return
    after the chequered flag. Those keep ``NULL`` and are not representative.
    """
    from .assumptions import QUALI_WINDOW_GRACE_S

    seg = pd.Series(pd.NA, index=laps.index, dtype="Int64")
    if not windows or "LapStartTime" not in laps.columns:
        return seg
    grace = pd.Timedelta(seconds=QUALI_WINDOW_GRACE_S)
    start = laps["LapStartTime"]
    # Later windows win, so a lap inside the grace overlap lands in the segment it
    # was actually run in rather than the one that had just closed.
    for n, (open_at, close_at) in enumerate(windows, start=1):
        inside = start.notna() & (start >= open_at - grace) & (start <= close_at)
        seg.loc[inside] = n
    return seg


def quali_official_times(results) -> dict[tuple[str, int], float]:
    """``{(driver_abbreviation, segment): seconds}`` for every non-null Q1/Q2/Q3.

    The official times, verbatim from ``session.results``. Read by the anchor check
    and by the §2.4 diagnostic — never by the five cleaning rules, which is the
    whole reason the anchor check is falsifiable.
    """
    out: dict[tuple[str, int], float] = {}
    if results is None or len(results) == 0:
        return out
    for _, row in results.iterrows():
        drv = str(row.get("Abbreviation") or "").strip()
        if not drv:
            continue
        for k in (1, 2, 3):
            val = row.get(f"Q{k}")
            if val is None or pd.isna(val):
                continue
            out[(drv, k)] = pd.Timedelta(val).total_seconds()
    return out


def _quali_finalise(laps: pd.DataFrame) -> pd.DataFrame:
    """(Re)derive the verdict columns from ``excl_*`` and ``quali_segment``.

    Called once by :func:`annotate_quali_laps` and again after a §2.2 stage-3
    repair, because moving a lap into a segment can turn ``excl_no_segment`` off
    and so change that lap's representativeness and the segment's push-lap best.
    """
    from .assumptions import QUALI_PUSH_LAP_THRESHOLD

    laps["excl_no_segment"] = laps["quali_segment"].isna()
    laps["passes_rules"] = ~laps[list(_QUALI_EXCL_RULES)].any(axis=1)
    # The race path's name for the same verdict, so frames.py's existing rename
    # (is_clean -> passes_rules) keeps working on this frame too.
    laps["is_clean"] = laps["passes_rules"]
    # §2.3 rule 7: the 107% rule is dropped, so this is False on every Q/SQ lap by
    # construction. Written out rather than omitted so the zero is readable as a
    # decision in lap_exclusion_report instead of a bug.
    laps["is_outlier"] = False
    laps["is_representative"] = laps["passes_rules"]

    # Push lap: within THIS driver's THIS segment, never session-wide (see the
    # China-SQ counterexample beside QUALI_PUSH_LAP_THRESHOLD).
    push = pd.Series(False, index=laps.index, dtype=bool)
    repr_mask = laps["is_representative"] & laps["quali_segment"].notna()
    if repr_mask.any():
        sub = laps.loc[repr_mask]
        best = sub.groupby(["Driver", "quali_segment"], observed=True)["LapTimeSeconds"].transform("min")
        push.loc[repr_mask] = (sub["LapTimeSeconds"] <= best * QUALI_PUSH_LAP_THRESHOLD).to_numpy()
    laps["is_push_lap"] = push
    return laps


def _quali_disallowed(laps: pd.DataFrame, official: dict[tuple[str, int], float]) -> pd.DataFrame:
    """§2.4. A lap strictly faster than that driver's own official Qk was struck out.

    A **diagnostic, never a filter**. It is not one of §2.3's five rules, and it must
    never become one: a rule defined off ``results.Qk`` would make the anchor check
    true by construction in one direction and destroy the only falsifiable
    acceptance test this release has.

    Its blind spot, measured at 2024 R09 Austria Q, which has 4 genuine deletions:
    it fires on 2 of them (GAS 1:05.335, PIA 1:04.786). LEC's deleted 1:10.750 and
    TSU's deleted 1:05.725 are *slower* than those drivers' own Qk, so the rule
    cannot see them. Two of four — a second net under a correct ``messages=True``
    load, never a replacement for one.
    """
    from .assumptions import QUALI_DISALLOWED_MARGIN_S

    flag = pd.Series(False, index=laps.index, dtype=bool)
    if official:
        seg = laps["quali_segment"]
        t = laps["LapTimeSeconds"]
        for idx in laps.index[seg.notna() & t.notna() & ~laps["excl_in_lap"] & ~laps["excl_out_lap"]]:
            qk = official.get((str(laps.at[idx, "Driver"]), int(seg.at[idx])))
            if qk is not None and t.at[idx] < qk - QUALI_DISALLOWED_MARGIN_S:
                flag.at[idx] = True
    laps["excl_disallowed"] = flag
    # Provenance of a disagreement between the two nets, queryable in one statement.
    laps["deleted_inferred"] = flag & ~laps["excl_deleted"]
    return laps


#: Columns the race path fills that qualifying deliberately leaves NULL.
#: Fuel correction is meaningless here — every qualifying lap runs on a low, nearly
#: identical fuel load by regulation and by choice, so ``assumptions.FUEL_*`` is never
#: read on this path. And there is no leader on track to be behind.
QUALI_NULL_COLUMNS = (
    "fuel_kg", "fuel_penalty_s", "lap_time_fc_s",
    "gap_to_leader_s", "interval_s", "leader_driver_id",
)


def annotate_quali_laps(session, windows=None, results=None) -> pd.DataFrame:
    """ALL laps of a Q/SQ session, with the qualifying cleaning verdict appended.

    §2.3's five rules — has a time, not an out-lap, not an in-lap, not deleted,
    inside a segment window — decide ``is_representative``. ``excl_not_green`` and
    ``excl_inaccurate`` are computed and stored but **never applied** (§2.3 notes 6
    and the §3.2 note), ``is_outlier`` is always ``False`` (note 7), and the fuel and
    gap columns are ``None``.

    None of the five rules reads ``session.results``. ``results`` is used only for the
    §2.4 ``excl_disallowed`` diagnostic, which is not one of them — so the anchor
    check in :func:`quali_anchor_check` stays two-sided and falsifiable.
    """
    laps = session.laps.copy()
    if windows is None:
        windows = quali_segment_windows(session)
    if results is None:
        results = getattr(session, "results", None)

    laps["LapTimeSeconds"] = laps["LapTime"].dt.total_seconds()

    laps["quali_segment"] = _assign_segments(laps, windows)
    laps["segment_source"] = pd.Series(
        ["window" if pd.notna(v) else None for v in laps["quali_segment"]],
        index=laps.index, dtype="object",
    )

    laps["excl_no_time"] = laps["LapTimeSeconds"].isna()
    laps["excl_in_lap"] = laps["PitInTime"].notna()
    laps["excl_out_lap"] = laps["PitOutTime"].notna()
    # Reported, never applied. Four of Monaco 2024's official Q1 bests are on '12'.
    laps["excl_not_green"] = ~laps["TrackStatus"].apply(_is_green)
    if "IsAccurate" in laps.columns:
        laps["excl_inaccurate"] = ~laps["IsAccurate"].fillna(False).astype(bool)
    else:
        laps["excl_inaccurate"] = False
    # This rule only does anything because of messages=True (§1.4).
    if "Deleted" in laps.columns:
        laps["excl_deleted"] = laps["Deleted"].fillna(False).astype(bool)
    else:
        laps["excl_deleted"] = False

    laps = _quali_finalise(laps)
    laps = _quali_disallowed(laps, quali_official_times(results))

    for col in QUALI_NULL_COLUMNS:
        laps[col] = None
    return laps


def quali_anchor_check(laps_df: pd.DataFrame, results, waived=None) -> tuple[int, int, list[str]]:
    """§2.2 stage 2 — the gate. ``(matched, total, failures)``.

    For every driver and every segment k where ``results.Qk`` is non-null::

        min(lap_time_s over that driver's REPRESENTATIVE laps in segment k) == results.Qk

    **This is equality of the minimum, not existence of a matching lap.** The weaker
    "some lap of this driver matches Qk" test is structurally incapable of detecting a
    mis-assigned segment, and a mis-assigned segment is the most likely way this
    feature breaks: at 2024 R21 Sao Paulo the window rule produces exactly three
    windows — so a window-count assertion passes — and still mis-assigns three
    driver-segments (ALO Q2 -3.963 s, ALB Q2 +1.232 s, PIA Q2 +0.493 s).

    ``waived`` is the set of ``(driver, segment)`` pairs stage 3 established to be
    duplicated official values rather than independent measurements (see
    :func:`quali_repair_segments`). They count as matched and are named in the
    ingest's warnings; nothing else is ever exempt.

    Per D8 this is a runtime gate in the ingest, not only a test.
    """
    from .assumptions import QUALI_ANCHOR_TOLERANCE_S

    official = quali_official_times(results)
    repr_laps = laps_df[laps_df["is_representative"] & laps_df["quali_segment"].notna()]
    mins = repr_laps.groupby(["Driver", "quali_segment"], observed=True)["LapTimeSeconds"].min()

    waived = set(waived or ())
    matched = 0
    failures: list[str] = []
    for (drv, k), qk in sorted(official.items()):
        if (drv, k) in waived:
            matched += 1
            continue
        try:
            got = float(mins.loc[(drv, k)])
        except KeyError:
            failures.append(f"{drv} seg{k} no representative lap (official {qk:.3f}s)")
            continue
        if abs(got - qk) <= QUALI_ANCHOR_TOLERANCE_S:
            matched += 1
        else:
            failures.append(f"{drv} seg{k} Δ{got - qk:+.3f}s")
    return matched, len(official), failures


def _failing_anchors(laps_df: pd.DataFrame, official, tol: float) -> list[tuple[str, int, float | None]]:
    """``[(driver, segment, observed_min_or_None)]`` for every anchor that does not hold."""
    repr_laps = laps_df[laps_df["is_representative"] & laps_df["quali_segment"].notna()]
    mins = repr_laps.groupby(["Driver", "quali_segment"], observed=True)["LapTimeSeconds"].min()
    out = []
    for (drv, k), qk in sorted(official.items()):
        try:
            got = float(mins.loc[(drv, k)])
        except KeyError:
            out.append((drv, k, None))
            continue
        if abs(got - qk) > tol:
            out.append((drv, k, got))
    return out


def _duplicate_of(official, drv: str, k: int, tol: float) -> int | None:
    """The other segment carrying this driver's identical official time, if any."""
    qk = official.get((drv, k))
    if qk is None:
        return None
    for j in (1, 2, 3):
        if j != k and (drv, j) in official and abs(official[(drv, j)] - qk) <= tol:
            return j
    return None


def quali_repair_segments(laps_df: pd.DataFrame, results):
    """§2.2 stage 3 — one bounded repair per failing driver-segment, then re-check.

    The window rule is not sufficient and that is measured, so a failing anchor gets
    exactly one attempt before the session is written ``partial``. Two mechanisms,
    tried in this order, because at 2024 R21 Sao Paulo the second one cannot work:

    **(a) duplicated official value.** FastF1 publishes the *same* time in two of a
    driver's Qk columns. At Sao Paulo all three failures are this: ALO, ALB and PIA
    each carry ``Q2 == Q3`` (1:28.998 / 1:24.657 / 1:24.686), their segment-3 anchor
    holds strictly against the lap they actually ran there, and their segment-2
    anchor fails by -3.963 / +1.232 / +0.493 s against the laps they actually ran in
    the Q2 window. One of the two columns is a copy. The copy is not an independent
    measurement and cannot gate anything, so the failing duplicate is **waived**,
    named in the warnings, and no lap is touched.

    **(b) the lap move.** Otherwise: search that driver's *other* laps for one whose
    time equals ``Qk`` to tolerance, whose provisional segment differs, and which
    would be representative in segment k. If exactly one exists, reassign it and set
    ``segment_source = 'anchor_repair'``.

    Anything else is unresolved and the session is ``partial``.

    Returns ``(laps_df, repairs, waived, unresolved)``.

    Honesty note: (b) uses the official times to place a lap, so the post-repair
    anchor is a tautology *for a repaired driver-segment*. The falsifiable number is
    the **pre-repair** pass rate, which is what §7's acceptance criterion uses.
    """
    from .assumptions import QUALI_ANCHOR_TOLERANCE_S as TOL

    official = quali_official_times(results)
    repairs: list[str] = []
    waived: set[tuple[str, int]] = set()
    unresolved: list[str] = []

    for drv, k, got in _failing_anchors(laps_df, official, TOL):
        qk = official[(drv, k)]
        delta = "no representative lap" if got is None else f"Δ{got - qk:+.3f}s"

        j = _duplicate_of(official, drv, k, TOL)
        if j is not None and not _failing_anchors(laps_df, {(drv, j): official[(drv, j)]}, TOL):
            waived.add((drv, k))
            repairs.append(f"duplicate_official: {drv} seg{k} == seg{j} ({qk:.3f}s), {delta}")
            continue

        own = laps_df["Driver"] == drv
        placeable = ~laps_df[["excl_no_time", "excl_in_lap", "excl_out_lap", "excl_deleted"]].any(axis=1)
        cand = laps_df.index[
            own & placeable
            & (laps_df["quali_segment"] != k)
            & (laps_df["LapTimeSeconds"] - qk).abs().le(TOL)
        ]
        if len(cand) == 1:
            laps_df.loc[cand[0], "quali_segment"] = k
            laps_df.loc[cand[0], "segment_source"] = "anchor_repair"
            repairs.append(f"anchor_repair: {drv} seg{k} lap {laps_df.at[cand[0], 'LapNumber']}")
            # The moved lap may have had no segment at all, so its representativeness
            # and its segment's push-lap best both change before the next iteration.
            laps_df = _quali_finalise(laps_df)
        else:
            unresolved.append(f"quali_anchor_mismatch: {drv} seg{k} {delta}")

    laps_df = _quali_finalise(laps_df)
    laps_df = _quali_disallowed(laps_df, official)
    return laps_df, repairs, waived, unresolved


def clean_quali(session, results=None) -> tuple[pd.DataFrame, dict]:
    """The whole §2 qualifying path, and the D8 runtime gate, in one call.

    Returns ``(laps, diagnostics)``. ``diagnostics`` carries both anchor numbers,
    because they are not the same kind of evidence (§2.2):

    ``anchor_pre``/``anchor_pre_total``/``anchor_pre_failures``
        Two-sided and falsifiable — none of the five cleaning rules reads ``results``.
        This is §7's acceptance criterion. Measured: 314/314 over the seven corpus Q
        sessions, 89/89 over the two SQ, 41/44 at 2024 R21 Sao Paulo.
    ``anchor_post``/``anchor_post_total``/``anchor_post_failures``
        After stage 3. Must be 100% or the session is written ``partial``.
    ``segment_repairs``
        Goes on ``session_ingests.warnings[]`` as ``quali_segment_repairs=<n>``.
        Measured: 0 on all nine clean corpus sessions, 3 at 2024 R21.
    ``ok``
        False -> ``session_ingests.status = 'partial'``: store the laps and
        ``quali_results`` (the official times are still verbatim and correct) but no
        ``quali_segment_times`` and no ``quali_teammate_h2h``, both being per-segment.
    """
    if results is None:
        results = getattr(session, "results", None)
    windows = quali_segment_windows(session)
    laps = annotate_quali_laps(session, windows, results)

    pre_m, pre_t, pre_f = quali_anchor_check(laps, results)
    laps, repairs, waived, unresolved = quali_repair_segments(laps, results)
    post_m, post_t, post_f = quali_anchor_check(laps, results, waived=waived)

    diagnostics = {
        "windows": len(windows),
        "anchor_pre": pre_m, "anchor_pre_total": pre_t, "anchor_pre_failures": pre_f,
        "anchor_post": post_m, "anchor_post_total": post_t,
        "anchor_post_failures": post_f + unresolved,
        "segment_repairs": len(repairs),
        "repairs": repairs,
        "waived": sorted(waived),
        "ok": not unresolved and not post_f,
    }
    return laps, diagnostics
