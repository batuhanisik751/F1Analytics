"""Auto-generated race reports (MODE3_SPEC §4).

Four paragraphs of prose at the top of ``/race/[year]/[round]``, generated **once at
ingest** from stored rows, verified by deterministic Python, and stored in
``race_report``. The web app performs no runtime inference for this feature: it reads a
precomputed row like every other section of the page.

The load-bearing property of this module is negative. The model is called **once**, and
it is called *before any row of prose exists* — it receives a grounding bundle of
pre-rounded facts and returns prose plus cites. There is no second "summarise the
results" call, because that call is where text-to-SQL and text-over-rows products
produce confident wrong answers (§3.2). After generation the pipeline stops calling
models and runs four deterministic verifiers (§4.3):

    verify_numbers       every numeral in the prose is a bundle number
    verify_attribution   every numeral is attached to the entity the bundle attaches it to
    verify_coverage      a non-ok bundle's limitation is actually cited
    verify_style         the banned-adjective list and the word-count band

Everything except :func:`generate_report` is pure over dicts, so the whole
anti-invention machinery is unit-testable with no key and no network. That split is the
point, not an implementation detail.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from typing import Any, Iterator

log = logging.getLogger(__name__)

# §4.5: these live here and NEVER in config.py. ``assumptions.snapshot()`` harvests every
# UPPER_CASE name in config.py, and assumption_set_id keys ~20 analytics tables across 79
# sessions -- so a prompt reword there would mint a new assumption set and force a full
# numeric recompute. The prompt version is stored on the row instead.
PROMPT_VERSION: int = 1
REPORT_MODEL: str = "claude-opus-5"
REPORT_EFFORT: str = "high"

# §4.7 -- claude-opus-5 list price, used only for the est_cost_usd column.
PRICE_IN_PER_MTOK = 5.0
PRICE_OUT_PER_MTOK = 25.0

MAX_REGENERATIONS = 1  # §4.3: one regeneration, then 'refused'.

SECTIONS: tuple[str, ...] = ("result", "pace", "strategy", "swing")

# §4.1 -- prohibitions, because prohibitions are checkable.
BANNED_WORDS: tuple[str, ...] = (
    "stunning", "masterclass", "incredible", "dominant", "brilliant", "disaster",
    "demolished", "crushed", "thrilling", "dramatic",
)
WORD_COUNT_MIN = 240
WORD_COUNT_MAX = 320

F1_POINTS = {0, 1, 2, 4, 6, 8, 10, 12, 15, 18, 25}
MAX_STOPS = 5
CLEAN_LAP_GAP_FRACTION = 0.6
NUMERAL_RE = re.compile(r"-?\d+(?:[.,]\d+)?")
VALUE_TOL = 0.0005


# --------------------------------------------------------------------------------------
# §4.2 -- display formatting. Every number in the bundle is pre-rounded to display
# precision **in Python**, and carries the exact string the model is expected to copy.
# The model therefore never formats a float, and verify_numbers can match a whole
# formatted token (``1:19.847``) verbatim instead of trying to reassemble it.
# --------------------------------------------------------------------------------------

def fmt_laptime(seconds: float) -> str:
    """``92.345 -> '1:32.345'``; under a minute stays as ``'59.412'``."""
    s = round(float(seconds), 3)
    minutes, rem = divmod(s, 60.0)
    if minutes < 1:
        return f"{rem:.3f}"
    return f"{int(minutes)}:{rem:06.3f}"


def fmt_gap(seconds: float) -> str:
    """``2.431 -> '+2.431 s'`` -- signed, because a gap without a sign is ambiguous."""
    return f"{float(seconds):+.3f} s"


def fmt_seconds(seconds: float) -> str:
    return f"{float(seconds):.3f} s"


def fmt_slap(value: float) -> str:
    """Degradation, always ``s/lap`` (SPEC §0.3: seconds, never milliseconds)."""
    return f"{float(value):.3f} s/lap"


def fmt_pct(value: float) -> str:
    """One decimal (§4.1)."""
    return f"{float(value):.1f}%"


def fmt_int(value: int) -> str:
    return str(int(value))


def fact(value: Any, display: str, subject: str | list[str] | None) -> dict[str, Any]:
    """One bundle fact: what it is, how to write it, and **who it belongs to**.

    ``subject`` is the whole reason §4.3's attribution check is possible. It is a
    driver_id, a ``lap:<n>``, a team_id, or None for a fact that belongs to the race
    rather than to an entity.

    It may also be a **list** of ids, and that is not a loophole -- it is where a
    symmetric fact belongs. A gap is information about a pair: ``+2.431 s`` is equally
    "Norris's gap to the winner" and "Verstappen's winning margin", and a strict
    nearest-subject check over a single-owner gap rejects the perfectly correct sentence
    *"Verstappen won by +2.431 s over Norris"*. The fix belongs in the bundle, where the
    fact really does have two owners, and not in the verifier, where it would have had
    to be a weakening.
    """
    return {"value": value, "display": display, "subject": subject}


def _subject_ids(f: dict[str, Any]) -> set[str]:
    s = f.get("subject")
    if s is None:
        return set()
    if isinstance(s, str):
        return {s}
    return {x for x in s if isinstance(x, str)}


def _v(x: Any) -> Any:
    """Unwrap a fact, or pass a plain scalar through.

    Every number the prose is allowed to state must be a *fact*, or the verifiers cannot
    see it and correct prose gets refused -- that is why ``coverage.clean_laps`` is a
    fact and not an int. Code that reads the bundle for its own logic goes through here.
    """
    return x.get("value") if isinstance(x, dict) and "value" in x else x


def _round(value: Any, digits: int) -> Any:
    return None if value is None else round(float(value), digits)


# --------------------------------------------------------------------------------------
# §4.2 -- the grounding bundle. Hand-written queries, run identically every time. The
# model never sees a connection, never sees SQL and never chooses a query; there is no
# path from its output back into the database.
# --------------------------------------------------------------------------------------

def _rows(cur) -> list[dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _event(conn, session_id: int) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT s.session_id, s.year, s.round, s.kind, s.name, s.total_laps, "
            "       e.event_name, e.location, e.country "
            "  FROM sessions s JOIN events e ON e.year = s.year AND e.round = s.round "
            " WHERE s.session_id = %s",
            (session_id,),
        )
        got = _rows(cur)
    if not got:
        raise ValueError(f"no session {session_id}")
    r = got[0]
    return {
        "year": int(r["year"]),
        "round": int(r["round"]),
        "kind": r["kind"],
        "event_name": r["event_name"],
        "circuit": r["location"],
        "country": r["country"],
        "total_laps": (fact(int(r["total_laps"]), fmt_int(r["total_laps"]), None)
                       if r["total_laps"] is not None else None),
    }


def _entities(conn, session_id: int) -> dict[str, Any]:
    """Names the attribution check matches against -- code, full name, team name."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT se.driver_id, COALESCE(se.code, d.latest_code) AS code, d.full_name, "
            "       se.team_id, t.latest_name AS team_name "
            "  FROM session_entries se "
            "  JOIN drivers d ON d.driver_id = se.driver_id "
            "  LEFT JOIN teams t ON t.team_id = se.team_id "
            " WHERE se.session_id = %s ORDER BY se.driver_id",
            (session_id,),
        )
        got = _rows(cur)
    drivers = {
        r["driver_id"]: {"code": r["code"], "full_name": r["full_name"], "team_id": r["team_id"]}
        for r in got
    }
    teams = {r["team_id"]: r["team_name"] for r in got if r["team_id"]}
    return {"drivers": drivers, "teams": dict(sorted(teams.items()))}


def _finish(conn, session_id: int) -> list[dict[str, Any]]:
    """Top 10 plus every retirement. ``result_time_s`` is a total for P1 and a gap for
    lead-lap finishers -- and **not a gap** for lapped cars (SPEC §0.3), so a lapped
    car's time is omitted rather than mislabelled."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT r.driver_id, r.position, r.classified_position, r.grid_position, "
            "       r.points, r.status, r.laps_completed, r.result_time_s, se.team_id "
            "  FROM results r LEFT JOIN session_entries se "
            "       ON se.session_id = r.session_id AND se.driver_id = r.driver_id "
            " WHERE r.session_id = %s ORDER BY r.position NULLS LAST, r.driver_id",
            (session_id,),
        )
        got = _rows(cur)
    leader_laps = max((r["laps_completed"] or 0) for r in got) if got else 0
    out: list[dict[str, Any]] = []
    for r in got:
        pos = r["position"]
        finished = (r["status"] or "").lower().startswith("finish") or str(
            r["classified_position"] or "").isdigit()
        retired = not finished
        if pos is not None and int(pos) > 10 and not retired:
            continue
        did = r["driver_id"]
        row: dict[str, Any] = {
            "driver_id": did,
            "team_id": r["team_id"],
            "status": r["status"],
            "position": fact(int(pos), f"P{int(pos)}", did) if pos is not None else None,
            "grid_position": (
                fact(int(r["grid_position"]), f"P{int(r['grid_position'])}", did)
                if r["grid_position"] is not None else None),
            "points": fact(_round(r["points"], 1), fmt_int(r["points"] or 0), did),
            "laps_completed": fact(int(r["laps_completed"] or 0),
                                   fmt_int(r["laps_completed"] or 0), did),
        }
        t = r["result_time_s"]
        lapped = (r["laps_completed"] or 0) < leader_laps
        if t is not None and not lapped:
            if pos is not None and int(pos) == 1:
                row["race_time_s"] = fact(_round(t, 3), fmt_laptime(t), did)
            else:
                row["gap_to_winner_s"] = fact(_round(t, 3), fmt_gap(t), did)
        elif lapped:
            row["laps_down"] = fact(int(leader_laps - (r["laps_completed"] or 0)),
                                    fmt_int(leader_laps - (r["laps_completed"] or 0)), did)
        out.append(row)
    # A gap to the winner is owned by both cars: it is the follower's deficit and the
    # winner's margin, and both readings are correct English (see :func:`fact`).
    winner = next((r["driver_id"] for r in out
                   if r.get("position") and r["position"]["value"] == 1), None)
    if winner:
        for row in out:
            g = row.get("gap_to_winner_s")
            if g is not None and row["driver_id"] != winner:
                g["subject"] = [row["driver_id"], winner]
    return out


def _pace(conn, session_id: int, asid: int) -> list[dict[str, Any]]:
    """Clean-air pace for every driver, with the rank-uncertainty band. ``pace_ranking``
    is already built from ``laps.is_representative`` rows only (SPEC §0.3), which is why
    the report may never compute a lap average of its own."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT driver_id, rank, team_id, clean_laps, median_pace_s, best_pace_s, "
            "       iqr_s, gap_s, gap_pct, sens_rank_lo, sens_rank_hi "
            "  FROM pace_ranking WHERE session_id = %s AND assumption_set_id = %s "
            " ORDER BY rank, driver_id",
            (session_id, asid),
        )
        got = _rows(cur)
    out = []
    for r in got:
        did = r["driver_id"]
        row = {
            "driver_id": did,
            "team_id": r["team_id"],
            "rank": fact(int(r["rank"]), fmt_int(r["rank"]), did),
            "clean_laps": fact(int(r["clean_laps"] or 0), fmt_int(r["clean_laps"] or 0), did),
            "median_pace_s": fact(_round(r["median_pace_s"], 3),
                                  fmt_laptime(r["median_pace_s"]), did),
            "gap_s": fact(_round(r["gap_s"], 3), fmt_gap(r["gap_s"] or 0.0), did),
            "iqr_s": fact(_round(r["iqr_s"], 3), fmt_seconds(r["iqr_s"] or 0.0), did),
        }
        # §4.1 asks for the band "when ranks overlap", so it is carried only when it
        # actually overlaps. Twenty certain bands per race are 20 facts the model can
        # misread and ~2,000 characters of prompt that say nothing.
        lo, hi = r["sens_rank_lo"], r["sens_rank_hi"]
        if lo is not None and hi is not None and int(lo) != int(hi):
            row["sens_rank_lo"] = fact(int(lo), fmt_int(lo), did)
            row["sens_rank_hi"] = fact(int(hi), fmt_int(hi), did)
        out.append(row)
    return out


def _teammates(conn, session_id: int, asid: int) -> list[dict[str, Any]]:
    """SPEC §0.3: positive gap = the faster driver is faster. The sign convention is
    baked into the display string so the model cannot invert it."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT team_id, faster_driver_id, slower_driver_id, gap_s, gap_pct, laps_compared "
            "  FROM teammate_deltas WHERE session_id = %s AND assumption_set_id = %s "
            " ORDER BY gap_s DESC NULLS LAST, team_id",
            (session_id, asid),
        )
        got = _rows(cur)
    return [{
        "team_id": r["team_id"],
        "faster_driver_id": r["faster_driver_id"],
        "slower_driver_id": r["slower_driver_id"],
        # Symmetric: "A was 0.183 s quicker than B" and "B was 0.183 s slower than A"
        # are the same stored row (SPEC §0.3: positive = the faster driver is faster).
        "gap_s": fact(_round(r["gap_s"], 3), fmt_seconds(r["gap_s"] or 0.0),
                      [r["faster_driver_id"], r["slower_driver_id"]]),
        "laps_compared": fact(int(r["laps_compared"] or 0), fmt_int(r["laps_compared"] or 0),
                              r["faster_driver_id"]),
    } for r in got]


def _strategy(conn, session_id: int, asid: int) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT driver_id, stint, compound, start_lap, end_lap, laps "
            "  FROM stints WHERE session_id = %s ORDER BY driver_id, stint",
            (session_id,),
        )
        stints = _rows(cur)
        cur.execute(
            "SELECT compound, n_fits, slope_s_per_lap, pit_loss_s, optimal_laps, "
            "       optimal_laps_lo, optimal_laps_hi, actual_median_laps "
            "  FROM optimal_stint WHERE session_id = %s AND assumption_set_id = %s "
            " ORDER BY compound",
            (session_id, asid),
        )
        optimal = _rows(cur)
    by_driver: dict[str, list[dict[str, Any]]] = {}
    for s in stints:
        by_driver.setdefault(s["driver_id"], []).append(s)
    drivers = []
    for did in sorted(by_driver):
        rows = by_driver[did]
        stops = max(len(rows) - 1, 0)
        # §4.2 measures this family at ~1,400 characters, which is only achievable as a
        # compound sequence plus a stop count plus the laps the stops happened on. Per
        # stint lap counts are derivable from those and were pure prompt weight.
        drivers.append({
            "driver_id": did,
            "compounds": [r["compound"] for r in rows],
            "stops": fact(stops, fmt_int(stops), did),
            "stop_laps": [fact(int(r["start_lap"]), fmt_int(r["start_lap"]),
                               [f"lap:{int(r['start_lap'])}", did])
                          for r in rows[1:] if r["start_lap"] is not None],
        })
    opt = [{
        "compound": o["compound"],
        "n_fits": fact(int(o["n_fits"] or 0), fmt_int(o["n_fits"] or 0), None),
        "degradation_s_per_lap": fact(_round(o["slope_s_per_lap"], 3),
                                      fmt_slap(o["slope_s_per_lap"] or 0.0), None),
        "pit_loss_s": fact(_round(o["pit_loss_s"], 3), fmt_seconds(o["pit_loss_s"] or 0.0), None),
        "optimal_laps": fact(int(o["optimal_laps"] or 0), fmt_int(o["optimal_laps"] or 0), None),
        "optimal_laps_lo": fact(int(o["optimal_laps_lo"] or 0),
                                fmt_int(o["optimal_laps_lo"] or 0), None),
        "optimal_laps_hi": fact(int(o["optimal_laps_hi"] or 0),
                                fmt_int(o["optimal_laps_hi"] or 0), None),
        "actual_median_laps": fact(_round(o["actual_median_laps"], 1),
                                   f"{float(o['actual_median_laps'] or 0.0):.1f}", None),
    } for o in optimal]
    return {"drivers": drivers, "optimal": opt}


def _moments(conn, session_id: int, asid: int, limit: int = 20) -> list[dict[str, Any]]:
    """Each moment arrives with its already-written English ``detail`` and its stored
    ``confidence`` word. §4.1: a cause may be attributed only when the confidence
    supports it, **using the stored word** -- so the word is handed over verbatim."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT moment_idx, moment_type, lap_number, driver_id, other_driver_id, "
            "       magnitude, magnitude_unit, severity, confidence, detail "
            "  FROM race_moment WHERE session_id = %s AND assumption_set_id = %s "
            " ORDER BY severity DESC NULLS LAST, moment_idx LIMIT %s",
            (session_id, asid, limit),
        )
        got = _rows(cur)
    out = []
    for m in got:
        did = m["driver_id"]
        unit = (m["magnitude_unit"] or "").strip()
        mag = m["magnitude"]
        if mag is None:
            disp = None
        elif unit in ("s/lap", "s per lap"):
            disp = fmt_slap(mag)
        elif unit == "s":
            disp = fmt_seconds(mag)
        elif unit in ("%", "pct"):
            disp = fmt_pct(mag)
        else:
            disp = f"{float(mag):.3f}" + (f" {unit}" if unit else "")
        row = {
            "moment_type": m["moment_type"],
            "driver_id": did,
            "other_driver_id": m["other_driver_id"],
            "confidence": m["confidence"],
            "detail": m["detail"],
            "severity": fact(_round(m["severity"], 3), f"{float(m['severity'] or 0.0):.3f}", did),
        }
        if m["lap_number"] is not None:
            row["lap"] = fact(int(m["lap_number"]), fmt_int(m["lap_number"]),
                              f"lap:{int(m['lap_number'])}")
        if disp is not None:
            subj = [did, m["other_driver_id"]] if m["other_driver_id"] else did
            row["magnitude"] = fact(_round(mag, 3), disp, subj)
        out.append(row)
    return out


def _swings(conn, session_id: int, asid: int, limit: int = 5) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT lap_number, swing_mass, cause, mover_driver_id, mover_p_before, "
            "       mover_p_after, rank_in_race "
            "  FROM wp_swing WHERE session_id = %s AND assumption_set_id = %s "
            " ORDER BY rank_in_race, lap_number LIMIT %s",
            (session_id, asid, limit),
        )
        got = _rows(cur)
    return [{
        "cause": s["cause"],
        "mover_driver_id": s["mover_driver_id"],
        "lap": fact(int(s["lap_number"]), fmt_int(s["lap_number"]),
                    f"lap:{int(s['lap_number'])}"),
        "swing_mass": fact(_round(s["swing_mass"], 3),
                           f"{float(s['swing_mass'] or 0.0):.3f}", s["mover_driver_id"]),
        "p_before_pct": fact(_round((s["mover_p_before"] or 0.0) * 100.0, 1),
                             fmt_pct((s["mover_p_before"] or 0.0) * 100.0),
                             s["mover_driver_id"]),
        "p_after_pct": fact(_round((s["mover_p_after"] or 0.0) * 100.0, 1),
                            fmt_pct((s["mover_p_after"] or 0.0) * 100.0),
                            s["mover_driver_id"]),
    } for s in got]


def _standings_delta(conn, year: int, rnd: int) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.driver_id, a.position AS pos_after, a.points AS pts_after, "
            "       b.position AS pos_before, b.points AS pts_before "
            "  FROM driver_standings a "
            "  LEFT JOIN driver_standings b "
            "         ON b.year = a.year AND b.after_round = a.after_round - 1 "
            "        AND b.driver_id = a.driver_id "
            " WHERE a.year = %s AND a.after_round = %s AND a.position <= 5 "
            " ORDER BY a.position",
            (year, rnd),
        )
        got = _rows(cur)
    return [{
        "driver_id": r["driver_id"],
        "position_after": fact(int(r["pos_after"]), f"P{int(r['pos_after'])}", r["driver_id"]),
        "points_after": fact(_round(r["pts_after"], 1), fmt_int(r["pts_after"] or 0),
                             r["driver_id"]),
        "position_before": (fact(int(r["pos_before"]), f"P{int(r['pos_before'])}", r["driver_id"])
                            if r["pos_before"] is not None else None),
        "points_before": (fact(_round(r["pts_before"], 1), fmt_int(r["pts_before"] or 0),
                               r["driver_id"]) if r["pts_before"] is not None else None),
    } for r in got]


def _weather(conn, session_id: int) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) AS n, bool_or(rainfall) AS any_rain, "
            "       min(track_temp) AS tt_lo, max(track_temp) AS tt_hi, "
            "       min(air_temp) AS at_lo, max(air_temp) AS at_hi "
            "  FROM weather_samples WHERE session_id = %s",
            (session_id,),
        )
        r = _rows(cur)[0]
    if not r["n"]:
        return {"samples": fact(0, "0", None), "wet": None}
    return {
        "samples": fact(int(r["n"]), fmt_int(r["n"]), None),
        "wet": bool(r["any_rain"]),
        "track_temp_lo_c": fact(_round(r["tt_lo"], 1), f"{float(r['tt_lo']):.1f}", None),
        "track_temp_hi_c": fact(_round(r["tt_hi"], 1), f"{float(r['tt_hi']):.1f}", None),
        "air_temp_lo_c": fact(_round(r["at_lo"], 1), f"{float(r['at_lo']):.1f}", None),
        "air_temp_hi_c": fact(_round(r["at_hi"], 1), f"{float(r['at_hi']):.1f}", None),
    }


def _coverage(conn, session_id: int) -> dict[str, Any]:
    """**What we do not know.** Deliberately a first-class member of the bundle: §4.3
    mechanism 5 machine-enforces that a non-ok coverage is actually cited in the prose.

    ``session_ingests.error`` and ``session_ingests.warnings`` carry tracebacks with
    local filesystem paths. Only the **count** of warnings crosses into the bundle;
    neither text column is ever read here."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, analytics_status, clean_laps, raw_laps, total_laps, "
            "       coalesce(array_length(warnings, 1), 0) AS n_warnings "
            "  FROM session_ingests WHERE session_id = %s",
            (session_id,),
        )
        got = _rows(cur)
    if not got:
        return {"status": "missing", "families": {}, "clean_laps": 0, "warnings": 0}
    r = got[0]
    fams = r["analytics_status"] or {}
    families = {k: bool(fams.get(k)) for k in sorted(fams)}
    counts = {"clean_laps": r["clean_laps"], "raw_laps": r["raw_laps"],
              "total_laps": r["total_laps"], "warnings": r["n_warnings"]}
    out: dict[str, Any] = {"status": r["status"], "families": families}
    # Facts, not ints: §4.6 asks the prose to say "the pace table covers 31 of 57 laps",
    # and a number the verifier cannot find in the bundle is a refused report.
    for k, val in counts.items():
        out[k] = fact(int(val or 0), fmt_int(val or 0), None)
    return out


def build_grounding(conn, session_id: int, asid: int) -> dict[str, Any]:
    """The complete set of knowable facts for one race. Pure SQL, no API call."""
    event = _event(conn, session_id)
    bundle: dict[str, Any] = {
        "event": event,
        "entities": _entities(conn, session_id),
        "finish": _finish(conn, session_id),
        "pace": _pace(conn, session_id, asid),
        "strategy": _strategy(conn, session_id, asid),
        "teammates": _teammates(conn, session_id, asid),
        "moments": _moments(conn, session_id, asid),
        "swings": _swings(conn, session_id, asid),
        "standings_delta": _standings_delta(conn, event["year"], event["round"]),
        "weather": _weather(conn, session_id),
        "coverage": _coverage(conn, session_id),
    }
    bundle["known_gaps"] = known_gaps(bundle)
    return bundle


def known_gaps(bundle: dict[str, Any]) -> list[str]:
    """What the prose is not allowed to pretend it knows."""
    gaps: list[str] = []
    cov = bundle.get("coverage", {})
    if not bundle.get("pace"):
        gaps.append("no clean-air pace ranking for this session")
    if not bundle.get("strategy", {}).get("drivers"):
        gaps.append("no stint data for this session")
    if not bundle.get("strategy", {}).get("optimal"):
        gaps.append("no optimal-stint model for this session")
    if not bundle.get("swings"):
        gaps.append("no win-probability swings for this session")
    if not bundle.get("moments"):
        gaps.append("no race moments were detected")
    if not bundle.get("teammates"):
        gaps.append("no teammate comparison for this session")
    if cov.get("status") and cov["status"] != "ok":
        gaps.append(f"session ingest status is {cov['status']}")
    clean, total = _v(cov.get("clean_laps", 0)), _v(cov.get("raw_laps", 0))
    # Only when the shortfall is MATERIAL. Every race loses laps to in-laps, out-laps
    # and safety cars -- that is what `laps.is_representative` is for, and reporting it
    # as a gap on all 62 races would make `known_gaps` noise that a reader learns to
    # skip. Below this fraction the pace table really is covering part of the race
    # (§4.6: "the pace table covers 31 of 57 laps").
    if total and clean < total * CLEAN_LAP_GAP_FRACTION:
        gaps.append(f"pace covers {clean} of {total} recorded laps")
    return gaps


FAMILIES: tuple[str, ...] = ("finish", "pace", "strategy", "swings")


def _family_present(bundle: dict[str, Any], name: str) -> bool:
    if name == "strategy":
        return bool(bundle.get("strategy", {}).get("drivers"))
    return bool(bundle.get(name))


def completeness(bundle: dict[str, Any]) -> str:
    """``ok`` | ``partial`` | ``insufficient`` (§4.6). A thin race gets no report at all
    rather than a vague one: vague prose over missing data is how a reader is misled."""
    present = [f for f in FAMILIES if _family_present(bundle, f)]
    classified = [r for r in bundle.get("finish", []) if r.get("position")]
    if len(present) < 3 or not bundle.get("pace") or len(classified) < 5:
        return "insufficient"
    if len(present) < len(FAMILIES) or bundle.get("coverage", {}).get("status") != "ok":
        return "partial"
    return "ok"


# --------------------------------------------------------------------------------------
# §4.5 -- canonical JSON and the idempotency hash. Canonicalisation matters or the hash
# churns on nothing and --force starts costing money on every re-ingest.
# --------------------------------------------------------------------------------------

def _json_default(obj: Any) -> Any:
    import datetime
    import decimal
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    if isinstance(obj, (datetime.datetime, datetime.date)):
        raise TypeError(
            "a timestamp reached the grounding bundle; the hash would churn every run")
    raise TypeError(f"{type(obj).__name__} is not groundable")


def canonical_json(bundle: dict[str, Any]) -> str:
    """Sorted keys, no whitespace, ``repr()`` floats (json.dumps uses float.__repr__),
    and **no generation timestamp anywhere inside the hashed object**."""
    return json.dumps(bundle, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=_json_default, allow_nan=False)


def grounding_sha256(bundle: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(bundle).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------
# §4.3 -- the verifiers. Deterministic, pure over dicts, no key and no network.
# --------------------------------------------------------------------------------------

def iter_facts(bundle: Any, path: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """Every ``{'value', 'display', 'subject'}`` leaf, with its bundle path."""
    if isinstance(bundle, dict):
        if "value" in bundle and "display" in bundle and "subject" in bundle:
            yield path, bundle
            return
        for k in sorted(bundle):
            yield from iter_facts(bundle[k], f"{path}.{k}" if path else k)
    elif isinstance(bundle, list):
        for i, item in enumerate(bundle):
            yield from iter_facts(item, f"{path}[{i}]")


_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _sentences(text: str) -> list[tuple[int, str]]:
    """``(offset, sentence)`` pairs, offsets into the original paragraph."""
    out, pos = [], 0
    for part in _SENT_SPLIT.split(text):
        idx = text.find(part, pos)
        if idx < 0:
            idx = pos
        out.append((idx, part))
        pos = idx + len(part)
    return out


def _display_index(bundle: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """Longest display string first, so ``1:32.345`` is consumed before ``32.345``."""
    idx = [(f["display"], p, f) for p, f in iter_facts(bundle)
           if isinstance(f.get("display"), str) and NUMERAL_RE.search(f["display"])]
    idx.sort(key=lambda t: (-len(t[0]), t[1]))
    return idx


def _value_index(bundle: dict[str, Any]) -> list[tuple[float, str, dict[str, Any]]]:
    out = []
    for p, f in iter_facts(bundle):
        v = f.get("value")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        out.append((float(v), p, f))
    return out


def _parse_numeral(tok: str) -> float | None:
    for cand in (tok, tok.replace(",", ".")):
        try:
            return float(cand)
        except ValueError:
            continue
    return None


def _whitelisted(tok: str, num: float, before: str, after: str,
                 bundle: dict[str, Any]) -> str | None:
    """The narrow context whitelist of §4.3 mechanism 3. Every branch requires **both**
    a plausible range and the adjacent word -- a bare numeral is never whitelisted."""
    is_int = float(num).is_integer()
    n = int(num) if is_int else None
    b, a = before.lower(), after.lower()
    event = bundle.get("event", {})
    total_laps = _v(event.get("total_laps")) or 0
    n_entries = len(bundle.get("finish", [])) or len(bundle.get("pace", [])) or 20
    # Only the ORDINAL form. "on lap 43" names a lap of this race; "43 laps" is a COUNT
    # of laps, and a count is a measurement that must come from a fact -- it is exactly
    # the shape of §4.3's own worked error, "Norris led 47 laps" when 47 is Verstappen's.
    if is_int and 1 <= n <= max(total_laps, 1) and re.search(r"\blaps?\s*$", b):
        return "lap"
    if is_int and re.search(r"\bround\s*$", b) and n == _v(event.get("round")):
        return "round"
    if is_int and (before.endswith("P") or re.search(
            r"\b(position|place|positions|grid|from|to|finished)\s*$", b)):
        if 1 <= n <= max(n_entries, 20):
            return "position"
    if is_int and re.match(r"\s*[-‑-―]?\s*stop", a) and 0 <= n <= MAX_STOPS:
        return "stops"
    if is_int and re.match(r"\s*point", a) and n in F1_POINTS:
        return "points"
    if is_int and 1950 <= n <= 2100 and n == _v(event.get("year")):
        return "year"
    return None


# §4.3 writes the token regex as ``-?\d+(?:[.,]\d+)?``. This is that regex with one
# addition: a clock-form lap time is captured as a SINGLE token, so ``1:32.345`` can
# never be read as "the lap number 1" followed by a stray 32.345. That is strictly
# stricter on the minute digit and identical everywhere else.
TOKEN_RE = re.compile(r"-?\d+:\d{2}(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?")
_ADJACENT = set("0123456789.,:")


def _clock_seconds(tok: str) -> float | None:
    if ":" not in tok:
        return None
    mins, _, rest = tok.partition(":")
    try:
        return float(mins) * 60.0 + float(rest.replace(",", "."))
    except ValueError:
        return None


def _refine(sent: str, i: int, j: int, cands: list[tuple[str, dict]],
            bundle: dict[str, Any]) -> list[tuple[str, dict]]:
    """Narrow a numeral's candidate facts using what the sentence says the numeral *is*.

    Values collide: ``26`` is both "lap 26" and "Verstappen's 26-lap first stint". Left
    unrefined, *"Norris lost 1.904 s on lap 26"* is refused, because the only
    driver-owned candidate belongs to Verstappen -- a false positive on a correct
    sentence. The sentence has already told us the numeral is a lap, so the lap-owned
    candidate is the one it matched. This narrows candidates by stated context; it never
    admits a numeral the value check would have rejected.
    """
    tok = sent[i:j]
    num = _parse_numeral(tok)
    if num is None:
        return cands
    kind = _whitelisted(tok, num, sent[:i], sent[j:], bundle)
    if kind == "lap":
        # Prefer a fact that belongs to the lap and to nobody else; a stop lap carries
        # both its lap and its driver, and reading "on lap 26" as the driver's fact is
        # what produced a false positive on correct prose.
        pure = [c for c in cands if _subject_ids(c[1]) == {f"lap:{int(num)}"}]
        lapped = [c for c in cands if f"lap:{int(num)}" in _subject_ids(c[1])]
        return pure or lapped or cands
    if kind == "position":
        pos = [c for c in cands
               if c[0].endswith(("position", "grid_position", "position_after",
                                 "position_before", "rank"))]
        return pos or cands
    if kind == "points":
        pts = [c for c in cands if c[0].endswith(("points", "points_after", "points_before"))]
        return pts or cands
    if kind == "stops":
        stops = [c for c in cands if c[0].endswith("stops")]
        return stops or cands
    return cands


def _account(sections: dict[str, Any], bundle: dict[str, Any]
             ) -> tuple[list[dict[str, Any]], list[str]]:
    """Walk the prose once and classify every numeric token.

    Returns ``(accounted, failures)``. ``accounted`` feeds :func:`verify_attribution`,
    which is why the two checks share one pass: an attribution check over tokens the
    numeric check never matched would be checking nothing.
    """
    displays = _display_index(bundle)
    values = _value_index(bundle)
    accounted: list[dict[str, Any]] = []
    failures: list[str] = []
    for name in SECTIONS:
        text = sections.get(name)
        if not text:
            continue
        for _off, sent in _sentences(text):
            masked = bytearray(len(sent))
            hits: list[tuple[int, int, list[tuple[str, dict]]]] = []
            for disp, path, f in displays:
                start = 0
                while True:
                    i = sent.find(disp, start)
                    if i < 0:
                        break
                    j = i + len(disp)
                    start = i + 1
                    if any(masked[i:j]):
                        continue
                    if i and sent[i - 1] in _ADJACENT:
                        continue
                    if j < len(sent) and sent[j] in _ADJACENT:
                        continue
                    masked[i:j] = b"\x01" * (j - i)
                    same = [(p, g) for d2, p, g in displays if d2 == disp]
                    hits.append((i, j, same))
            for m in TOKEN_RE.finditer(sent):
                if any(masked[m.start():m.end()]):
                    continue
                tok = m.group(0)
                num = _parse_numeral(tok)
                if num is None:
                    num = _clock_seconds(tok)
                cands = ([(p, f) for v, p, f in values if abs(v - num) <= VALUE_TOL]
                         if num is not None else [])
                if cands:
                    hits.append((m.start(), m.end(), cands))
                    continue
                kind = None if num is None else _whitelisted(
                    tok, num, sent[:m.start()], sent[m.end():], bundle)
                if kind:
                    hits.append((m.start(), m.end(), []))
                    continue
                failures.append(
                    f"{name}: the value {tok!r} does not appear in the data you were given "
                    f"(sentence: {sent.strip()!r})")
            for i, j, cands in hits:
                accounted.append({"section": name, "sentence": sent, "start": i, "end": j,
                                  "text": sent[i:j],
                                  "candidates": _refine(sent, i, j, cands, bundle)})
    return accounted, failures


def verify_numbers(sections: dict[str, Any], bundle: dict[str, Any]) -> list[str]:
    """Every numeric token in the prose is a bundle number. ``[]`` means clean."""
    return _account(sections, bundle)[1]


def _name_index(bundle: dict[str, Any]) -> list[tuple[str, set[str]]]:
    """Surface form -> the ids it can denote, longest form first.

    A form may be ambiguous (two drivers sharing a surname), so it maps to a **set**:
    an ambiguous mention is not by itself an attribution error.
    """
    forms: dict[str, set[str]] = {}
    ents = bundle.get("entities", {})
    for did, d in (ents.get("drivers") or {}).items():
        for form in (d.get("full_name"), d.get("code"),
                     (d.get("full_name") or "").split(" ")[-1]):
            if form and len(form) >= 2:
                forms.setdefault(form, set()).add(did)
    for tid, tname in (ents.get("teams") or {}).items():
        if tname:
            forms.setdefault(tname, set()).add(tid)
    return sorted(forms.items(), key=lambda t: (-len(t[0]), t[0]))


def _nearest_subject(sentence: str, upto: int,
                     names: list[tuple[str, set[str]]]) -> tuple[str, set[str]] | None:
    """The nearest **preceding** named entity, or None where the sentence names none."""
    best: tuple[int, str, set[str]] | None = None
    head = sentence[:upto]
    for form, ids in names:
        for m in re.finditer(re.escape(form), head):
            i = m.start()
            if i and (head[i - 1].isalnum() or head[i - 1] == "'"):
                continue
            j = m.end()
            if j < len(head) and (head[j].isalnum() or head[j] in "'"):
                continue
            if best is None or i > best[0]:
                best = (i, form, ids)
    return (best[1], best[2]) if best else None


def verify_attribution(sections: dict[str, Any], bundle: dict[str, Any]) -> list[str]:
    """The check every source proposal was missing (§4.3 mechanism 4).

    Value-membership alone passes *"Norris led 47 laps"* when 47 is Verstappen's count:
    the number is real, the subject is wrong, and that is the most plausible-looking
    error a generated report can make. So for each verified numeral, read the matched
    fact's ``subject`` and require the nearest preceding named entity to **be** that
    subject.

    Two deliberate passes, both chosen to hold the false-positive rate down: a sentence
    that names no entity passes (this is an attribution check, not a coverage check),
    and a numeral whose every candidate fact belongs to the race or to a lap rather than
    to a driver passes -- *"the lead changed on lap 43"* names a driver and cites a lap.
    """
    accounted, _ = _account(sections, bundle)
    names = _name_index(bundle)
    out: list[str] = []
    for hit in accounted:
        cands = hit["candidates"]
        if not cands:
            continue
        subjects: set[str] = set()
        for _p, f in cands:
            subjects |= _subject_ids(f)
        entity_subjects = {s for s in subjects if not s.startswith("lap:")}
        if not entity_subjects:
            continue
        near = _nearest_subject(hit["sentence"], hit["start"], names)
        if near is None:
            continue
        form, ids = near
        if ids & subjects:
            continue
        paths = ", ".join(sorted(p for p, _f in cands)[:3])
        out.append(
            f"{hit['section']}: {hit['text']!r} is attributed to {form!r} but belongs to "
            f"{sorted(entity_subjects)} ({paths}) -- sentence: {hit['sentence'].strip()!r}")
    return out


def verify_coverage(sections: dict[str, Any], bundle: dict[str, Any]) -> list[str]:
    """§4.3 mechanism 5. A stated limitation is machine-enforced, not prompt-requested.

    Triggered on ``completeness(bundle) != 'ok'`` rather than on ``coverage.status``
    alone: a session whose ingest says ``ok`` but which is missing a whole data family
    is exactly as capable of misleading a reader, and §4.6 asks the prose to lead with
    the gap in both cases.
    """
    if completeness(bundle) == "ok":
        return []
    cites = sections.get("cites") or {}
    paths = [p for v in cites.values() for p in (v or [])]
    if any(str(p).startswith("coverage") or str(p).startswith("known_gaps") for p in paths):
        return []
    return ["coverage: the grounding is not complete but no paragraph cites "
            "'coverage' or 'known_gaps'; the limitation must be stated, not implied"]


_SECOND_PERSON = re.compile(r"\b(you|your|yours|we|our|ours|us)\b", re.I)


def verify_style(sections: dict[str, Any]) -> list[str]:
    """The voice rules of §4.1, written as prohibitions because prohibitions are
    checkable: banned adjectives of drama, second person, markdown headings, and the
    word-count band."""
    out: list[str] = []
    texts = {n: sections.get(n) for n in SECTIONS}
    joined = " ".join(t for t in texts.values() if t)
    for word in BANNED_WORDS:
        if re.search(rf"\b{word}\w*\b", joined, re.I):
            out.append(f"style: the banned word {word!r} appears in the report")
    m = _SECOND_PERSON.search(joined)
    if m:
        out.append(f"style: second/first person {m.group(0)!r}; the voice is third person past tense")
    for name, text in texts.items():
        if text and re.search(r"^\s*(#{1,6}\s|\*\*|\d+\.\s)", text, re.M):
            out.append(f"style: {name} looks like markdown; paragraphs are plain prose")
    words = len(re.findall(r"\S+", joined))
    if all(texts[n] for n in SECTIONS) and words < WORD_COUNT_MIN:
        out.append(f"style: {words} words, below the {WORD_COUNT_MIN}-word floor")
    if words > WORD_COUNT_MAX:
        out.append(f"style: {words} words, above the {WORD_COUNT_MAX}-word ceiling")
    return out


def word_count(sections: dict[str, Any]) -> int:
    return len(re.findall(r"\S+", " ".join(sections.get(n) or "" for n in SECTIONS)))


def audit(sections: dict[str, Any], bundle: dict[str, Any]) -> list[str]:
    """All four verifiers, in the order §4.3 trusts them. ``[]`` means storable."""
    return (verify_numbers(sections, bundle) + verify_attribution(sections, bundle)
            + verify_coverage(sections, bundle) + verify_style(sections))


# --------------------------------------------------------------------------------------
# §4.3 mechanism 1+2 -- the prompt. Nothing else is in it: no web tool, no other race,
# no season context beyond the bundle. The model is told the bundle is the complete set
# of knowable facts, and returns one field per paragraph with a cites list -- all of it
# BEFORE any prose about results exists. This is the only API call in the whole feature.
# --------------------------------------------------------------------------------------

INSTRUCTIONS = """You write the race report for a Formula 1 analytics site.

The JSON below is the COMPLETE set of facts you are permitted to use. You know a great
deal about Formula 1 that is not in it; every one of those facts is unverifiable here and
must not appear. If something is not in the bundle, it did not happen as far as this
report is concerned.

Write four paragraphs, 240-320 words in total, no headings, one job each:
1. result   - winner, margin, grid slot, and whether the race was decided by pace or by
              an event. 2-3 sentences.
2. pace     - who was actually quickest in clean air, from `pace`, with the rank
              uncertainty band when sens_rank_lo and sens_rank_hi differ. This is often
              NOT the winner; when it is not, say so plainly - it is the single most
              useful sentence the report can contain.
3. strategy - the decisive stop or stint, from `strategy` and the undercut_executed /
              tyre_cliff / pace_collapse rows of `moments`.
4. swing    - the largest win-probability move and the lap it happened on, from `swings`.

Rules, all of which are checked by a program before the report is stored:
- Every number you write must be COPIED from a `display` string in the bundle. Do not
  compute, convert, round, sum or average anything. If the difference you want is not a
  supplied field, do not write it.
- A number belongs to its fact's `subject`. Writing a real number next to the wrong
  driver is the worst error you can make here and it is detected.
- Past tense, third person. Never "you" or "we".
- No adjectives of drama: stunning, masterclass, incredible, dominant, brilliant,
  disaster, demolished, crushed, thrilling, dramatic. State what happened instead.
- No intent, no emotion, no blame. "Perez lost 1.9 s/lap from lap 27", never "Perez
  struggled", never "Ferrari gambled".
- Attribute a cause only when a moment's `confidence` supports it, and use that stored
  word.
- If `coverage.status` is not "ok" or `known_gaps` is non-empty, lead with the gap where
  it is material and cite a `coverage` or `known_gaps` path.
- A paragraph with no supporting rows must be returned as null. Do not fill it.

`cites` maps each paragraph you wrote to the bundle paths you used, e.g.
"pace[3].gap_s", "moments[0].lap", "coverage.status".
"""

REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["result", "pace", "strategy", "swing", "caveats", "cites"],
    "properties": {
        **{n: {"type": ["string", "null"]} for n in SECTIONS},
        "caveats": {"type": ["string", "null"],
                    "description": "one sentence, or null"},
        "cites": {
            "type": "object",
            "additionalProperties": False,
            "required": list(SECTIONS),
            "properties": {n: {"type": "array", "items": {"type": "string"}}
                           for n in SECTIONS},
        },
    },
}

API_CALLS = 0  # §4.5's idempotency test asserts on this, not on the clock.


class NoApiKey(RuntimeError):
    """``ANTHROPIC_API_KEY`` is not in the environment (§4.4: the step skips, exit 0)."""


def has_api_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def est_cost_usd(usage: dict[str, Any]) -> float:
    return round(
        usage.get("input_tokens", 0) / 1e6 * PRICE_IN_PER_MTOK
        + usage.get("output_tokens", 0) / 1e6 * PRICE_OUT_PER_MTOK, 6)


def _client():
    """Imported lazily so that importing this module -- which every unit test does --
    never requires the SDK. ``requirements.txt`` pins ``anthropic>=1.0,<2``."""
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise NoApiKey("the anthropic SDK is not installed") from exc
    if not has_api_key():
        raise NoApiKey("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic()


def generate_report(bundle: dict[str, Any], *, failures: list[str] | None = None,
                    previous: dict[str, Any] | None = None,
                    cache_instructions: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    """The ONLY API call in this feature. Returns ``(sections, usage)``.

    ``failures``/``previous`` carry §4.3's single regeneration: the offending tokens are
    quoted back verbatim. Note what is *not* here -- the bundle is unchanged and the rows
    are not re-read, because there is no second call that sees results and summarises
    them. The model still writes prose about facts it was given up front.

    ``cache_instructions`` is the §4.7 backfill lever: 79 sequential calls in one run
    turn 79 instruction-block writes into 1 write and 78 reads. In normal operation the
    bundle differs every race and 24 calls spread over a season survive no TTL, so it is
    off by default and that is a decision, not an omission.
    """
    global API_CALLS
    client = _client()
    system: list[dict[str, Any]] = [{"type": "text", "text": INSTRUCTIONS}]
    if cache_instructions:
        system[0]["cache_control"] = {"type": "ephemeral"}
    parts = [f"<grounding>\n{json.dumps(bundle, ensure_ascii=False, sort_keys=True)}\n</grounding>"]
    if failures:
        quoted = "\n".join(f"- {f}" for f in failures)
        parts.append(
            "Your previous attempt was rejected by the checker:\n" + quoted
            + "\n\nRewrite the report using only the supplied values, and attach every "
              "number to the driver or team its fact names as `subject`.")
        if previous:
            parts.append("Your previous attempt was:\n"
                         + json.dumps({n: previous.get(n) for n in SECTIONS},
                                      ensure_ascii=False))
    API_CALLS += 1
    resp = client.messages.create(
        model=REPORT_MODEL,
        max_tokens=2000,
        system=system,
        thinking={"type": "adaptive"},
        output_config={"effort": REPORT_EFFORT,
                       "format": {"type": "json_schema", "schema": REPORT_SCHEMA,
                                  "name": "race_report", "strict": True}},
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    sections = json.loads(text)
    usage = {"input_tokens": getattr(resp.usage, "input_tokens", 0),
             "output_tokens": getattr(resp.usage, "output_tokens", 0),
             "cache_read_input_tokens": getattr(resp.usage, "cache_read_input_tokens", 0)}
    return sections, usage


# --------------------------------------------------------------------------------------
# §4.4 / §4.5 -- the companion step. Runs LAST, at run end, because the report reads
# wp_swing and would otherwise describe a stale model generation. Reads only stored rows,
# makes no FastF1 call, and writes race_report one upsert at a time.
#
# race_report is NOT a per-session frame and must never be added to RACE_TABLE_ORDER or
# SPRINT_TABLE_ORDER: build_race_frames does `{t: tables[t] for t in RACE_TABLE_ORDER}`,
# so adding it there raises KeyError on every race ingest.
# --------------------------------------------------------------------------------------

UPSERT_SQL = """
INSERT INTO race_report (
    session_id, assumption_set_id, prompt_version, model, status,
    grounding_completeness, grounding_sha256, result, pace, strategy, swing, caveats,
    known_gaps, cites, audit_failures, skipped_reason, word_count, input_tokens,
    output_tokens, est_cost_usd, regenerations, generated_at)
VALUES (%(session_id)s, %(asid)s, %(prompt_version)s, %(model)s, %(status)s,
        %(completeness)s, %(sha)s, %(result)s, %(pace)s, %(strategy)s, %(swing)s,
        %(caveats)s, %(known_gaps)s, %(cites)s, %(audit_failures)s, %(skipped_reason)s,
        %(word_count)s, %(input_tokens)s, %(output_tokens)s, %(est_cost_usd)s,
        %(regenerations)s, now())
ON CONFLICT (session_id, assumption_set_id) DO UPDATE SET
    prompt_version = EXCLUDED.prompt_version, model = EXCLUDED.model,
    status = EXCLUDED.status, grounding_completeness = EXCLUDED.grounding_completeness,
    grounding_sha256 = EXCLUDED.grounding_sha256, result = EXCLUDED.result,
    pace = EXCLUDED.pace, strategy = EXCLUDED.strategy, swing = EXCLUDED.swing,
    caveats = EXCLUDED.caveats, known_gaps = EXCLUDED.known_gaps,
    cites = EXCLUDED.cites, audit_failures = EXCLUDED.audit_failures,
    skipped_reason = EXCLUDED.skipped_reason, word_count = EXCLUDED.word_count,
    input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
    est_cost_usd = EXCLUDED.est_cost_usd, regenerations = EXCLUDED.regenerations,
    generated_at = now()
"""


def _row_params(session_id: int, asid: int, bundle: dict[str, Any], sha: str,
                status: str, sections: dict[str, Any] | None, *,
                failures: list[str] | None = None, skipped_reason: str | None = None,
                usage: dict[str, Any] | None = None, regenerations: int = 0
                ) -> dict[str, Any]:
    from psycopg.types.json import Json
    s = sections or {}
    ok = status == "ok"
    usage = usage or {}
    return {
        "session_id": session_id, "asid": asid, "prompt_version": PROMPT_VERSION,
        "model": REPORT_MODEL, "status": status,
        "completeness": completeness(bundle), "sha": sha,
        # race_report_body_check: (status='ok') = (result IS NOT NULL). Nothing but an
        # 'ok' row may carry prose, and an 'ok' row without paragraph 1 cannot exist.
        "result": s.get("result") if ok else None,
        "pace": s.get("pace") if ok else None,
        "strategy": s.get("strategy") if ok else None,
        "swing": s.get("swing") if ok else None,
        "caveats": s.get("caveats") if ok else None,
        "known_gaps": list(bundle.get("known_gaps") or []),
        "cites": Json(s.get("cites") or {}),
        "audit_failures": Json(list(failures or [])),
        "skipped_reason": skipped_reason,
        "word_count": word_count(s) if ok else 0,
        "input_tokens": int(usage.get("input_tokens", 0)),
        "output_tokens": int(usage.get("output_tokens", 0)),
        "est_cost_usd": est_cost_usd(usage),
        "regenerations": regenerations,
    }


def should_skip(existing: dict[str, Any] | None, sha: str) -> bool:
    """§4.5 -- the whole point of the hash. ``--force`` recomputes the numbers; if the
    numbers did not change the hash did not change and the stored prose is still
    correct, so ``--force`` regenerates ZERO reports and costs $0. If a recompute *did*
    move a cited number the hash moves with it and the report regenerates by itself,
    which is exactly the coupling wanted."""
    return bool(existing
                and existing["grounding_sha256"] == sha
                and existing["prompt_version"] == PROMPT_VERSION
                and existing["model"] == REPORT_MODEL
                and existing["status"] != "refused")


def _existing(conn, session_id: int, asid: int) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT grounding_sha256, prompt_version, model, status FROM race_report "
            " WHERE session_id = %s AND assumption_set_id = %s", (session_id, asid))
        got = _rows(cur)
    return got[0] if got else None


def generate_one(conn, session_id: int, asid: int) -> dict[str, Any]:
    """Build, decide, generate at most twice, verify, upsert. Returns a status dict."""
    bundle = build_grounding(conn, session_id, asid)
    sha = grounding_sha256(bundle)
    comp = completeness(bundle)
    if comp == "insufficient":
        # §4.6: no API call at all. A thin race gets NO report rather than a vague one.
        reason = ("fewer than three data families, no pace ranking, or fewer than five "
                  "classified results")
        with conn.cursor() as cur:
            cur.execute(UPSERT_SQL, _row_params(session_id, asid, bundle, sha, "skipped",
                                                None, skipped_reason=reason))
        return {"status": "skipped", "api_calls": 0, "cost": 0.0}
    sections: dict[str, Any] = {}
    usage: dict[str, Any] = {}
    failures: list[str] = []
    total_in = total_out = 0
    for attempt in range(MAX_REGENERATIONS + 1):
        sections, usage = generate_report(
            bundle, failures=failures or None, previous=sections or None)
        total_in += int(usage.get("input_tokens", 0))
        total_out += int(usage.get("output_tokens", 0))
        failures = audit(sections, bundle)
        if not sections.get("result"):
            failures.append("result: paragraph 1 is empty; an 'ok' report must state the "
                            "finishing order")
        if not failures:
            break
    spend = {"input_tokens": total_in, "output_tokens": total_out}
    status = "ok" if not failures else "refused"
    with conn.cursor() as cur:
        cur.execute(UPSERT_SQL, _row_params(
            session_id, asid, bundle, sha, status, sections, failures=failures,
            usage=spend, regenerations=attempt))
    return {"status": status, "api_calls": attempt + 1, "cost": est_cost_usd(spend),
            "failures": failures}


def recompute_reports(conn, asid: int, *, force: bool = False,
                      regen: bool = False, commit: bool = True) -> dict[str, Any]:
    """The run-end companion step (§4.4).

    ``force`` is deliberately **not** a regeneration trigger: it recomputes numbers, and
    unchanged numbers leave the hash and therefore the prose alone. ``regen`` is the
    separate, explicit flag for "the prompt or the model changed".

    If ``ANTHROPIC_API_KEY`` is absent the step logs ``report: skipped (no key)`` and
    returns. An ingest without a key must still exit 0 -- four other modes depend on
    ingest and none of them depends on this one.

    ``commit`` (WP-10): commit after each race. That is what a BACKFILL wants -- 62
    sequential API calls, and a crash at race 50 must not throw away the 49 already paid
    for. But ``ingest.py`` runs every companion step inside ``with _committed(conn)``, and
    psycopg3 raises ``ProgrammingError: Explicit commit() forbidden within a Transaction
    context``, so ``companion.py`` passes ``commit=False`` and the caller's context commits
    once. Default stays ``True`` for direct/standalone use.
    """
    out = {"generated": 0, "skipped": 0, "refused": 0, "unchanged": 0,
           "api_calls": 0, "cost_usd": 0.0}
    with conn.cursor() as cur:
        # Joined to session_ingests ON THIS assumption set, not to sessions alone. Every
        # analytics family is keyed by assumption_set_id, so a race ingested under an
        # older set has no pace_ranking, no stints and no swings under this one -- and
        # walking `sessions` alone marks all of them 'skipped', recording "this race was
        # too thin for a report" about races that are fully ingested elsewhere. Measured:
        # 71 sessions of kind 'R' exist, 62 are ingested, and the newest assumption set
        # covers fewer still.
        cur.execute(
            "SELECT si.session_id FROM session_ingests si "
            "  JOIN sessions s ON s.session_id = si.session_id "
            " WHERE s.kind = 'R' AND si.assumption_set_id = %s "
            " ORDER BY si.session_id", (asid,))
        session_ids = [r[0] for r in cur.fetchall()]
    keyed = has_api_key()
    if not keyed:
        log.info("report: skipped (no key)")
    for sid in session_ids:
        try:
            bundle = build_grounding(conn, sid, asid)
        except ValueError:
            continue
        sha = grounding_sha256(bundle)
        existing = _existing(conn, sid, asid)
        if not regen and should_skip(existing, sha):
            out["unchanged"] += 1
            continue
        if completeness(bundle) == "insufficient":
            with conn.cursor() as cur:
                cur.execute(UPSERT_SQL, _row_params(
                    sid, asid, bundle, sha, "skipped", None,
                    skipped_reason=("fewer than three data families, no pace ranking, or "
                                    "fewer than five classified results")))
            out["skipped"] += 1
            if commit:
                conn.commit()
            continue
        if not keyed:
            out["skipped"] += 1
            continue
        res = generate_one(conn, sid, asid)
        out["api_calls"] += res["api_calls"]
        out["cost_usd"] = round(out["cost_usd"] + res["cost"], 6)
        out["refused" if res["status"] == "refused" else "generated"] += 1
        if commit:
            conn.commit()
        log.info("report: session %s -> %s ($%.4f)", sid, res["status"], res["cost"])
    if commit:
        conn.commit()
    return out
