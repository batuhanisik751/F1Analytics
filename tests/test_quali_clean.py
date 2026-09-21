"""QUALI_SPEC §2 — the qualifying cleaning path, against the warmed FastF1 cache.

Every number asserted here was measured before the code was written. The corpus is
the §2.5 acceptance corpus — seven Q sessions, two sprint qualifyings, and **2024
R21 Sao Paulo**, which is mandatory: it is the session that separates the window
rule from the anchor gate. It yields exactly three windows, so a window-count
assertion passes, and still fails the strict anchor on 3 of 44 driver-segments.

Nothing here touches the database. Sessions come from ``<root>/cache`` only.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from f1lab import assumptions, clean

pytestmark = pytest.mark.cache

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"

#: §2.5. The spec labels Austria "2024 R09"; FastF1 round 9 of 2024 is Canada and
#: Austria is round 11. Round 11 is the session carrying the four deletions §2.4
#: names (LEC 1:10.750, PIA 1:04.786, GAS 1:05.335, TSU 1:05.725), so the round
#: number in the spec is wrong and the session identity is right.
Q_CORPUS = [
    (2024, 1, "Q", 45),    # Bahrain
    (2024, 2, "Q", 43),    # Jeddah
    (2024, 3, "Q", 44),    # Melbourne
    (2024, 8, "Q", 45),    # Monaco
    (2024, 11, "Q", 45),   # Austria
    (2024, 10, "Q", 44),   # Barcelona
    (2026, 13, "Q", 48),   # Monza
]
SQ_CORPUS = [
    (2024, 5, "SQ", 45),   # Shanghai
    (2024, 6, "SQ", 44),   # Miami
]
SAO_PAULO = (2024, 21, "Q", 44)
CORPUS = Q_CORPUS + SQ_CORPUS + [SAO_PAULO]

_LOADED: dict[tuple, object] = {}
_CLEANED: dict[tuple, tuple] = {}


def session_of(year, rnd, kind):
    key = (year, rnd, kind)
    if key not in _LOADED:
        _LOADED[key] = clean.load_quali(year, rnd, kind, cache=CACHE)
    return _LOADED[key]


def cleaned(year, rnd, kind):
    key = (year, rnd, kind)
    if key not in _CLEANED:
        _CLEANED[key] = clean.clean_quali(session_of(year, rnd, kind))
    return _CLEANED[key]


def ids(case):
    return f"{case[0]}R{case[1]:02d}{case[2]}"


def test_corpus_is_ten_sessions():
    assert len(CORPUS) == 10
    assert len(Q_CORPUS) == 7 and len(SQ_CORPUS) == 2
    assert SAO_PAULO in CORPUS, "2024 R21 Sao Paulo Q is mandatory in the corpus (§2.5)"


# --- §2.2 the anchor gate ------------------------------------------------------

@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_three_windows_but_the_count_is_not_the_gate(case):
    """Every corpus session yields exactly three windows — Sao Paulo included.

    Which is the whole point: at Sao Paulo the count is right and three
    driver-segments are still wrong. See :func:`test_pre_repair_anchor`.
    """
    year, rnd, kind, _ = case
    assert len(clean.quali_segment_windows(session_of(year, rnd, kind))) == 3


def test_aborted_is_ignored_not_treated_as_a_close():
    """2024 R02 Jeddah: Q2 is red-flagged mid-segment and resumes (§2.2 stage 1)."""
    s = session_of(2024, 2, "Q")
    states = [str(v) for v in s.session_status["Status"]]
    assert "Aborted" in states
    assert states.count("Finished") == 3
    windows = clean.quali_segment_windows(s)
    assert len(windows) == 3
    # The Q2 window spans the abort rather than ending at it.
    aborted_at = s.session_status.loc[[v == "Aborted" for v in states], "Time"].iloc[0]
    assert windows[1][0] < aborted_at < windows[1][1]


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_pre_repair_anchor(case):
    """The falsifiable number: none of the five rules reads ``results`` (§2.3)."""
    year, rnd, kind, officials = case
    laps, diag = cleaned(year, rnd, kind)
    assert diag["anchor_pre_total"] == officials
    if (year, rnd) == (2024, 21):
        assert diag["anchor_pre"] == 41
        assert sorted(diag["anchor_pre_failures"]) == [
            "ALB seg2 Δ+1.232s", "ALO seg2 Δ-3.963s", "PIA seg2 Δ+0.493s",
        ]
    else:
        assert diag["anchor_pre"] == officials, diag["anchor_pre_failures"]


def test_pre_repair_subtotals():
    """§2.5: 314/314 on the seven Q sessions, 89/89 on the two SQ.

    Reported separately because they are not the same kind of evidence. For Q,
    FastF1 takes Q1/Q2/Q3 from the timing API, so reproducing them from the laps is
    external validation. For SQ it *computes* them from these same laps plus the
    race-control messages, so reproducing them is self-consistency.
    """
    q = [cleaned(y, r, k) for y, r, k, _ in Q_CORPUS]
    sq = [cleaned(y, r, k) for y, r, k, _ in SQ_CORPUS]
    assert (sum(d["anchor_pre"] for _, d in q), sum(d["anchor_pre_total"] for _, d in q)) == (314, 314)
    assert (sum(d["anchor_pre"] for _, d in sq), sum(d["anchor_pre_total"] for _, d in sq)) == (89, 89)


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_post_repair_anchor_and_repair_count(case):
    """Post-repair must be 100% or the session is written ``partial`` (§2.2 stage 3)."""
    year, rnd, kind, officials = case
    _, diag = cleaned(year, rnd, kind)
    assert diag["anchor_post"] == diag["anchor_post_total"] == officials, diag["anchor_post_failures"]
    assert diag["ok"] is True
    assert diag["segment_repairs"] == (3 if (year, rnd) == (2024, 21) else 0), diag["repairs"]


def test_sao_paulo_repairs_are_duplicated_official_times():
    """All three Sao Paulo failures are FastF1 publishing Q2 == Q3 for one driver."""
    _, diag = cleaned(*SAO_PAULO[:3])
    assert sorted(diag["waived"]) == [("ALB", 2), ("ALO", 2), ("PIA", 2)]
    assert all(r.startswith("duplicate_official:") for r in diag["repairs"])
    official = clean.quali_official_times(session_of(*SAO_PAULO[:3]).results)
    for drv in ("ALO", "ALB", "PIA"):
        assert abs(official[(drv, 2)] - official[(drv, 3)]) <= assumptions.QUALI_ANCHOR_TOLERANCE_S


# --- §1.4 messages=True, and D4's pin on races ---------------------------------

def test_messages_flag_is_what_makes_deletions_visible():
    """2024 R08 Monaco Q: 21 deleted with the flag on, 0 with it off (§1.4)."""
    laps, _ = cleaned(2024, 8, "Q")
    assert int(laps["excl_deleted"].sum()) == 21
    off = clean.load_race(2024, 8, "Q", cache=CACHE)
    assert int(off.laps["Deleted"].fillna(False).astype(bool).sum()) == 0


def test_messages_flag_is_what_makes_sprint_quali_results_exist():
    """2024 R05 China SQ: FastF1 *computes* SQ1/SQ2/SQ3 from laps + messages (§1.4).

    Two of the three source proposals measured sprint qualifying through
    ``messages=False`` and concluded from the artifact that FastF1 publishes no
    results for sprint qualifying. It does.
    """
    res = session_of(2024, 5, "SQ").results
    assert int(res["Position"].notna().sum()) == 20 == len(res)
    assert [int(res[f"Q{i}"].notna().sum()) for i in (1, 2, 3)] == [20, 15, 10]
    off = clean.load_race(2024, 5, "SQ", cache=CACHE)
    assert int(off.results["Position"].notna().sum()) == 0
    assert [int(off.results[f"Q{i}"].notna().sum()) for i in (1, 2, 3)] == [0, 0, 0]


def test_load_race_still_defaults_to_messages_false():
    """D4: R and S stay pinned at messages=False in v1.6 (§0.2).

    Flipping it would re-activate ``excl_deleted`` on 71 races and move the
    representative lap set under pace_ranking, degradation_fits, teammate_deltas,
    every season aggregate and every Mode 2 fit. ``load_quali`` opts in explicitly.
    """
    import inspect

    sig = inspect.signature(clean.load_race)
    assert sig.parameters["messages"].default is False
    assert sig.parameters["messages"].kind is inspect.Parameter.KEYWORD_ONLY


# --- §2.3 the five rules, and the two race rules that do not apply -------------

def test_monaco_q1_bests_on_a_yellow_flag_survive():
    """The green-flag rule INVERTS INTO A FLAG (§2.3 note 6).

    2024 R08 Monaco Q: four drivers' official Q1 bests sit on TrackStatus '12'.
    Applying the race rule would silently delete four FIA-classified times from a
    session whose official times we otherwise reproduce exactly.
    """
    laps, _ = cleaned(2024, 8, "Q")
    for drv, t in [("RUS", 71.492), ("STR", 71.728), ("HUL", 71.876), ("ALO", 72.019)]:
        row = laps[(laps["Driver"] == drv) & (laps["LapTimeSeconds"] - t).abs().le(0.0015)]
        assert len(row) == 1, drv
        assert row["TrackStatus"].iloc[0] == "12"
        assert bool(row["excl_not_green"].iloc[0]) is True     # computed and stored
        assert bool(row["is_representative"].iloc[0]) is True  # and never applied
        assert int(row["quali_segment"].iloc[0]) == 1


def test_applying_the_green_flag_rule_would_destroy_official_times():
    """Counterfactual over the whole corpus, so the decision is not taken on faith."""
    killed = 0
    for year, rnd, kind, _ in Q_CORPUS + SQ_CORPUS:
        laps, _ = cleaned(year, rnd, kind)
        counterfactual = laps.copy()
        counterfactual["is_representative"] &= ~counterfactual["excl_not_green"]
        matched, total, _ = clean.quali_anchor_check(counterfactual, session_of(year, rnd, kind).results)
        killed += total - matched
    assert killed == 8, "the race green-flag rule breaks 8 of the 403 official anchors"


def test_out_lap_exclusion_cannot_rely_on_the_time_being_null():
    """Whether an out-lap gets a lap time is a timing-feed artefact (§2.1).

    Bahrain: 0 of 92 out-laps carry a time. Monaco: 91 of 92 do. So rule 2 excludes
    out-laps *explicitly* and never by NaT.
    """
    counts = {}
    for rnd in (1, 8):
        laps, _ = cleaned(2024, rnd, "Q")
        out = laps[laps["excl_out_lap"]]
        counts[rnd] = (len(out), int(out["LapTimeSeconds"].notna().sum()))
        assert not out["is_representative"].any()
    assert counts[1] == (92, 0)
    assert counts[8] == (92, 91)


def test_outlier_rule_is_dropped_and_would_have_been_destructive():
    """§2.3 note 7. At Monaco the 107% rule would remove 79 of 224 kept laps."""
    laps, _ = cleaned(2024, 8, "Q")
    rep = laps[laps["is_representative"]]
    assert len(rep) == 224
    median = rep.groupby("Driver")["LapTimeSeconds"].transform("median")
    assert int((rep["LapTimeSeconds"] > median * 1.07).sum()) == 79


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_is_outlier_is_always_false(case):
    laps, _ = cleaned(*case[:3])
    assert not laps["is_outlier"].any()
    # is_representative == passes_rules, precisely because is_outlier is always false.
    assert laps["is_representative"].equals(laps["passes_rules"])


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_fuel_and_gap_columns_are_none(case):
    """Fuel correction is meaningless here and there is no leader on track (§2.3)."""
    laps, _ = cleaned(*case[:3])
    for col in clean.QUALI_NULL_COLUMNS:
        assert laps[col].isna().all(), col
    assert "fuel_kg" in clean.QUALI_NULL_COLUMNS
    assert "lap_time_fc_s" in clean.QUALI_NULL_COLUMNS
    assert "gap_to_leader_s" in clean.QUALI_NULL_COLUMNS


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_the_five_rules_are_exactly_the_five_rules(case):
    """And ``excl_not_green`` / ``excl_inaccurate`` are stored but never applied."""
    laps, _ = cleaned(*case[:3])
    expected = ~laps[["excl_no_time", "excl_in_lap", "excl_out_lap",
                      "excl_deleted", "excl_no_segment"]].any(axis=1)
    assert laps["passes_rules"].equals(expected)
    for reported in ("excl_not_green", "excl_inaccurate"):
        assert reported in laps.columns  # stored, and provably not in ``expected``


def test_the_rule_tuples_are_a_public_cross_module_contract():
    """``frames.py`` builds the qualifying ``lap_exclusion_report`` from these tuples.

    They are therefore an interface, not an implementation detail, and they carry
    public names. The underscored spellings stay as aliases because WP3 already
    imports them; both must keep pointing at the same object, or the report and the
    cleaning path would silently disagree about what was measured.
    """
    assert clean.QUALI_EXCL_RULES == (
        "excl_no_time", "excl_in_lap", "excl_out_lap", "excl_deleted", "excl_no_segment",
    )
    assert clean.QUALI_REPORTED_ONLY == ("excl_not_green", "excl_inaccurate")
    assert clean._QUALI_EXCL_RULES is clean.QUALI_EXCL_RULES
    assert clean._QUALI_REPORTED_ONLY is clean.QUALI_REPORTED_ONLY
    # §2.4: the diagnostic is not a rule, and must never drift into the tuple.
    assert "excl_disallowed" not in clean.QUALI_EXCL_RULES
    assert "is_outlier" not in clean.QUALI_EXCL_RULES


def test_reported_only_rules_do_keep_laps_a_race_would_have_dropped():
    """Corpus-wide: both reported-only rules fire on laps that stay representative."""
    kept = {"excl_not_green": 0, "excl_inaccurate": 0}
    for case in CORPUS:
        laps, _ = cleaned(*case[:3])
        for rule in kept:
            kept[rule] += int((laps[rule] & laps["is_representative"]).sum())
    # 79 representative laps across the corpus are not fully green; a race would have
    # dropped every one, and eight of them are official Q1/Q2/Q3 times.
    assert kept["excl_not_green"] == 79
    # Measured zero: IsAccurate is false only on laps the five rules already drop, so
    # in THIS corpus not applying it changes nothing. It is still stored and reported
    # rather than applied, because §3.2 makes that a decision and not an accident.
    assert kept["excl_inaccurate"] == 0


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_laps_outside_every_window_keep_a_null_segment(case):
    """0-15 a session, measured; each one an in-lap or a post-chequered return."""
    laps, _ = cleaned(*case[:3])
    orphans = laps[laps["quali_segment"].isna()]
    assert not orphans["is_representative"].any()
    # Measured 9-56 a session, not the 0-15 §2.2 claims; every one of them is an
    # in-lap, an out-lap or a lap with no time, so none would have been
    # representative even if a window had covered it. That is the claim that matters.
    assert (orphans["excl_in_lap"] | orphans["excl_out_lap"] | orphans["excl_no_time"]).all()
    assert orphans["segment_source"].isna().all()
    assert set(laps.loc[laps["quali_segment"].notna(), "segment_source"]) <= {"window", "anchor_repair"}
    assert set(laps.loc[laps["quali_segment"].notna(), "quali_segment"]) <= {1, 2, 3}


# --- §2.4 excl_disallowed: a diagnostic, never a filter ------------------------

def test_austria_deletions_and_the_diagnostic_blind_spot():
    """2024 Austria Q has 4 genuine deletions; ``excl_disallowed`` sees 2 of them.

    Stated so nobody trusts the diagnostic too far. LEC's deleted 1:10.750 and TSU's
    deleted 1:05.725 are *slower* than those drivers' own Qk, so the rule cannot
    fire. Two of four: a second net under a correct ``messages=True`` load, never a
    replacement for one.
    """
    laps, _ = cleaned(2024, 11, "Q")
    deleted = laps[laps["excl_deleted"]]
    assert len(deleted) == 4
    assert deleted["DeletedReason"].str.contains("TRACK LIMITS").all()
    seen = deleted[deleted["excl_disallowed"]]
    assert sorted(seen["Driver"]) == ["GAS", "PIA"]
    assert sorted(round(t, 3) for t in seen["LapTimeSeconds"]) == [64.786, 65.335]
    assert sorted(round(t, 3) for t in deleted.loc[~deleted["excl_disallowed"], "LapTimeSeconds"]) \
        == [65.725, 70.750]


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_disallowed_is_not_one_of_the_rules(case):
    """If it were, the anchor check would be true by construction in one direction."""
    laps, _ = cleaned(*case[:3])
    assert "excl_disallowed" not in clean._QUALI_EXCL_RULES
    # deleted_inferred is exactly the disagreement between the two nets.
    assert laps["deleted_inferred"].equals(laps["excl_disallowed"] & ~laps["excl_deleted"])


# --- §2.6 push laps ------------------------------------------------------------

def test_push_lap_threshold_and_its_counterexample():
    assert assumptions.QUALI_PUSH_LAP_THRESHOLD == 1.03
    src = (ROOT / "f1lab" / "assumptions.py").read_text()
    assert "China SQ" in src and "1:57.940" in src, "the counterexample must stay beside the constant"


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_push_lap_benchmark_is_per_driver_per_segment(case):
    """Never session-wide, never cross-segment (§2.3, §2.6)."""
    laps, _ = cleaned(*case[:3])
    rep = laps[laps["is_representative"]]
    best = rep.groupby(["Driver", "quali_segment"], observed=True)["LapTimeSeconds"].transform("min")
    expected = rep["LapTimeSeconds"] <= best * assumptions.QUALI_PUSH_LAP_THRESHOLD
    assert rep["is_push_lap"].equals(expected)
    assert not laps.loc[~laps["is_representative"], "is_push_lap"].any()
    # Every driver-segment has at least one push lap: its own best.
    assert rep.groupby(["Driver", "quali_segment"], observed=True)["is_push_lap"].any().all()


def test_a_session_wide_benchmark_would_keep_zero_sq3_drivers():
    """2024 R05 China SQ: SQ2 1:35.606 dry, SQ3 1:57.940 on intermediates, +23.4%."""
    laps, _ = cleaned(2024, 5, "SQ")
    rep = laps[laps["is_representative"]]
    best = rep.groupby("quali_segment", observed=True)["LapTimeSeconds"].min()
    assert [round(best[k], 3) for k in (1, 2, 3)] == [96.110, 95.606, 117.940]
    session_best = rep["LapTimeSeconds"].min()
    sq3 = rep[rep["quali_segment"] == 3]
    assert (sq3["LapTimeSeconds"] > session_best * assumptions.QUALI_PUSH_LAP_THRESHOLD).all()
    assert sq3["Driver"].nunique() == 10


def test_cross_segment_ok_is_false_at_china_sq():
    """§4.6's gate, recomputed here from the cleaned laps alone.

    WP3 owns the canonical implementation and the stored
    ``quali_cross_segment_ok`` warning; this asserts the measured fact underneath
    it, so the cleaning package fails if the segment assignment ever stops
    producing a wet SQ3 against two dry segments.
    """
    wet = {"INTERMEDIATE", "WET"}
    laps, _ = cleaned(2024, 5, "SQ")
    rep = laps[laps["is_representative"]]
    by_seg = {k: g for k, g in rep.groupby("quali_segment", observed=True)}
    wet_seen = {k: bool(set(g["Compound"]) & wet) for k, g in by_seg.items()}
    assert wet_seen == {1: False, 2: False, 3: True}, "mixed conditions clause"
    best = {k: g["LapTimeSeconds"].min() for k, g in by_seg.items()}
    steps = [abs(best[k] / best[k - 1] - 1) for k in (2, 3)]
    assert round(steps[1], 4) == 0.2336 and steps[1] > 0.03, "3% clause"
    cross_segment_ok = not any(wet_seen.values()) and max(steps) <= 0.03
    assert cross_segment_ok is False


@pytest.mark.parametrize("case", Q_CORPUS[:4], ids=lambda c: ids(c))
def test_cross_segment_ok_is_true_on_a_normal_dry_session(case):
    """The gate is not simply always false — the 3% threshold has to discriminate."""
    wet = {"INTERMEDIATE", "WET"}
    laps, _ = cleaned(*case[:3])
    rep = laps[laps["is_representative"]]
    by_seg = {k: g for k, g in rep.groupby("quali_segment", observed=True)}
    assert not any(set(g["Compound"]) & wet for g in by_seg.values())
    best = {k: g["LapTimeSeconds"].min() for k, g in by_seg.items()}
    assert max(abs(best[k] / best[k - 1] - 1) for k in (2, 3)) <= 0.03


# --- the frame contract WP3 and WP4 consume ------------------------------------

@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_every_raw_lap_survives_annotation(case):
    """Nothing is dropped: the ingest stores every lap with the reason it was used."""
    year, rnd, kind, _ = case
    laps, _ = cleaned(year, rnd, kind)
    assert len(laps) == len(session_of(year, rnd, kind).laps)


@pytest.mark.parametrize("case", CORPUS, ids=ids)
def test_the_five_new_lap_columns_are_present_and_typed(case):
    """§3.2's five new columns, plus the verdicts frames.py renames."""
    laps, _ = cleaned(*case[:3])
    for col in ("quali_segment", "segment_source", "is_push_lap",
                "excl_disallowed", "deleted_inferred"):
        assert col in laps.columns, col
    assert laps["is_push_lap"].dtype == bool
    assert laps["excl_disallowed"].dtype == bool
    assert laps["deleted_inferred"].dtype == bool
    assert str(laps["quali_segment"].dtype) == "Int64"
    # frames.py renames is_clean -> passes_rules; both spellings carry the verdict.
    assert laps["is_clean"].equals(laps["passes_rules"])


def test_clean_quali_reports_both_anchor_numbers_and_the_gate():
    """D8: the anchor is a runtime gate, so the ingest gets a machine-readable verdict."""
    _, diag = cleaned(*SAO_PAULO[:3])
    for key in ("anchor_pre", "anchor_pre_total", "anchor_pre_failures",
                "anchor_post", "anchor_post_total", "anchor_post_failures",
                "segment_repairs", "repairs", "waived", "windows", "ok"):
        assert key in diag, key
    assert isinstance(diag["ok"], bool)


def test_the_race_side_deleted_gap_stays_open(hungary_2024):
    """§5.6 / §0.4 note 9 — a real defect this release deliberately does not fix.

    ``load_race`` passes ``messages=False``, so FastF1 never populates ``Deleted``
    and the ``excl_deleted`` rule has never excluded a single race lap (measured
    TRUE on 0 of 69,548 rows). Fixing it here would change the representative lap
    set and therefore pace_ranking, degradation_fits, teammate_deltas, every season
    aggregate and every Mode 2 fit. It is scoped to v1.7; this pins the current
    behaviour so the gap stays visible instead of quietly closing.
    """
    annotated = clean.annotate_laps(hungary_2024)
    assert int(annotated["excl_deleted"].sum()) == 0
    assert hungary_2024.laps["Deleted"].fillna(False).eq(False).all()
