"""MODE3_SPEC §4.3 -- the four verifiers, with no key and no network.

Every mechanism that stops a race report inventing a number is pure Python over dicts,
which is what makes it testable at all. These tests are the executable form of the claim
in §4.3: a report with a single digit changed is rejected, an invented lap time is
rejected, a real number on the wrong driver is rejected, and a partial bundle whose prose
does not cite its own limitation is rejected.

The last test in this file is the one §9.4 item 6 asks for: the **false-positive rate**
of the numeric and attribution verifiers. A correct report wrongly refused is the failure
mode to measure here, so a set of hand-written, entirely correct reports is run through
the full audit and every failure is counted against the design.
"""

from __future__ import annotations

import copy

import pytest

from f1lab import report as R


def synthetic_bundle() -> dict:
    """A small but structurally faithful bundle: fact dicts, display strings, subjects,
    and the pairing that §4.2's ``subject`` key exists for."""
    return {
        "event": {"year": 2025, "round": 14, "kind": "R", "event_name": "Test Grand Prix",
                  "circuit": "Testville", "country": "Testland",
                  "total_laps": R.fact(70, "70", None)},
        "entities": {
            "drivers": {
                "verstappen": {"code": "VER", "full_name": "Max Verstappen",
                               "team_id": "redbull"},
                "norris": {"code": "NOR", "full_name": "Lando Norris", "team_id": "mclaren"},
                "piastri": {"code": "PIA", "full_name": "Oscar Piastri", "team_id": "mclaren"},
                "russell": {"code": "RUS", "full_name": "George Russell",
                            "team_id": "mercedes"},
                "leclerc": {"code": "LEC", "full_name": "Charles Leclerc",
                            "team_id": "ferrari"},
            },
            "teams": {"ferrari": "Ferrari", "mclaren": "McLaren",
                      "mercedes": "Mercedes", "redbull": "Red Bull Racing"},
        },
        "finish": [
            {"driver_id": "verstappen", "team_id": "redbull", "status": "Finished",
             "position": R.fact(1, "P1", "verstappen"),
             "grid_position": R.fact(3, "P3", "verstappen"),
             "points": R.fact(25, "25", "verstappen"),
             "laps_completed": R.fact(70, "70", "verstappen"),
             "race_time_s": R.fact(5123.456, "85:23.456", "verstappen")},
            {"driver_id": "norris", "team_id": "mclaren", "status": "Finished",
             "position": R.fact(2, "P2", "norris"),
             "grid_position": R.fact(1, "P1", "norris"),
             "points": R.fact(18, "18", "norris"),
             "laps_completed": R.fact(70, "70", "norris"),
             "gap_to_winner_s": R.fact(2.431, "+2.431 s", ["norris", "verstappen"])},
            {"driver_id": "piastri", "team_id": "mclaren", "status": "Finished",
             "position": R.fact(3, "P3", "piastri"),
             "grid_position": R.fact(2, "P2", "piastri"),
             "points": R.fact(15, "15", "piastri"),
             "laps_completed": R.fact(70, "70", "piastri"),
             "gap_to_winner_s": R.fact(9.874, "+9.874 s", ["piastri", "verstappen"])},
            {"driver_id": "russell", "team_id": "mercedes", "status": "Finished",
             "position": R.fact(4, "P4", "russell"),
             "grid_position": R.fact(4, "P4", "russell"),
             "points": R.fact(12, "12", "russell"),
             "laps_completed": R.fact(70, "70", "russell"),
             "gap_to_winner_s": R.fact(21.006, "+21.006 s", ["russell", "verstappen"])},
            {"driver_id": "leclerc", "team_id": "ferrari", "status": "Finished",
             "position": R.fact(5, "P5", "leclerc"),
             "grid_position": R.fact(6, "P6", "leclerc"),
             "points": R.fact(10, "10", "leclerc"),
             "laps_completed": R.fact(70, "70", "leclerc"),
             "gap_to_winner_s": R.fact(28.512, "+28.512 s", ["leclerc", "verstappen"])},
        ],
        "pace": [
            {"driver_id": "norris", "team_id": "mclaren",
             "rank": R.fact(1, "1", "norris"), "clean_laps": R.fact(47, "47", "norris"),
             "median_pace_s": R.fact(92.345, "1:32.345", "norris"),
             "gap_s": R.fact(0.0, "+0.000 s", "norris"),
             "gap_pct": R.fact(0.0, "0.0%", "norris"),
             "iqr_s": R.fact(0.412, "0.412 s", "norris"),
             "sens_rank_lo": R.fact(1, "1", "norris"),
             "sens_rank_hi": R.fact(2, "2", "norris"), "rank_is_certain": False},
            {"driver_id": "verstappen", "team_id": "redbull",
             "rank": R.fact(2, "2", "verstappen"),
             "clean_laps": R.fact(51, "51", "verstappen"),
             "median_pace_s": R.fact(92.512, "1:32.512", "verstappen"),
             "gap_s": R.fact(0.167, "+0.167 s", "verstappen"),
             "gap_pct": R.fact(0.2, "0.2%", "verstappen"),
             "iqr_s": R.fact(0.385, "0.385 s", "verstappen"),
             "sens_rank_lo": R.fact(1, "1", "verstappen"),
             "sens_rank_hi": R.fact(2, "2", "verstappen"), "rank_is_certain": False},
        ],
    }


def _complete(bundle: dict) -> dict:
    """Add the remaining families so ``completeness`` is 'ok' and coverage is not the
    thing under test."""
    bundle["strategy"] = {
        "drivers": [
            {"driver_id": "verstappen", "compounds": ["MEDIUM", "HARD"],
             "stops": R.fact(1, "1", "verstappen"),
             "stop_laps": [R.fact(26, "26", ["lap:26", "verstappen"])]},
            {"driver_id": "norris", "compounds": ["MEDIUM", "HARD"],
             "stops": R.fact(1, "1", "norris"),
             "stop_laps": [R.fact(32, "32", ["lap:32", "norris"])]},
        ],
        "optimal": [
            {"compound": "HARD", "n_fits": R.fact(1100, "1100", None),
             "degradation_s_per_lap": R.fact(0.043, "0.043 s/lap", None),
             "pit_loss_s": R.fact(21.400, "21.400 s", None),
             "optimal_laps": R.fact(41, "41", None),
             "optimal_laps_lo": R.fact(36, "36", None),
             "optimal_laps_hi": R.fact(47, "47", None),
             "actual_median_laps": R.fact(42.0, "42.0", None)},
        ],
    }
    bundle["teammates"] = [
        {"team_id": "mclaren", "faster_driver_id": "norris", "slower_driver_id": "piastri",
         "gap_s": R.fact(0.183, "0.183 s", ["norris", "piastri"]),
         "laps_compared": R.fact(44, "44", ["norris", "piastri"])},
    ]
    bundle["moments"] = [
        {"moment_type": "undercut_executed", "driver_id": "verstappen",
         "other_driver_id": "norris", "confidence": "likely",
         "detail": "Verstappen stopped on lap 26 and emerged ahead of Norris.",
         "severity": R.fact(0.812, "0.812", "verstappen"),
         "lap": R.fact(26, "26", "lap:26"),
         "magnitude": R.fact(1.904, "1.904 s", ["verstappen", "norris"])},
    ]
    bundle["swings"] = [
        {"cause": "pit_stop", "mover_driver_id": "verstappen",
         "lap": R.fact(26, "26", "lap:26"),
         "swing_mass": R.fact(0.441, "0.441", "verstappen"),
         "p_before_pct": R.fact(31.2, "31.2%", "verstappen"),
         "p_after_pct": R.fact(74.8, "74.8%", "verstappen")},
    ]
    bundle["standings_delta"] = []
    bundle["weather"] = {"samples": R.fact(0, "0", None), "wet": None}
    bundle["coverage"] = {
        "status": "ok", "families": {},
        "clean_laps": R.fact(900, "900", None), "raw_laps": R.fact(900, "900", None),
        "total_laps": R.fact(70, "70", None), "warnings": R.fact(0, "0", None)}
    bundle["known_gaps"] = []
    return bundle


@pytest.fixture
def bundle() -> dict:
    return _complete(synthetic_bundle())


def _cites(**kw) -> dict:
    base = {n: [] for n in R.SECTIONS}
    base.update(kw)
    return base


# A hand-written report that is entirely correct: every numeral is a bundle display
# string or a bundle value, and every numeral sits after the entity its fact names.
CORRECT = {
    "result": (
        "Max Verstappen won the Test Grand Prix from P3 on the grid. Lando Norris, who "
        "started from P1, finished 2.431 s behind after 70 laps. Oscar Piastri completed "
        "the podium at +9.874 s, ahead of George Russell at +21.006 s and Charles "
        "Leclerc at +28.512 s. The lead changed at the first round of stops rather than "
        "on track, so the result was decided by an event and not by outright race pace."),
    "pace": (
        "Lando Norris was the quickest car in clean air, with a median of 1:32.345 over "
        "47 clean laps. Max Verstappen was 0.167 s slower on median pace across 51 clean "
        "laps, and finished ahead of him. The rank uncertainty band spans 1 to 2 for "
        "both cars, so the clean-air order between the top two is not separated by the "
        "data and the pace table should be read as a tie. Oscar Piastri was 0.183 s "
        "behind his own team mate over 44 compared laps."),
    "strategy": (
        "Max Verstappen stopped once, on lap 26, moving from the medium compound to the "
        "hard. Lando Norris also stopped once but waited until lap 32, and took the same "
        "pair of compounds. The pooled model put the optimal hard stint at 41 laps, "
        "inside a band of 36 to 47 laps, against an actual median of 42.0 laps. Pit loss "
        "at this circuit was 21.400 s and hard-compound degradation was 0.043 s/lap, so "
        "the earlier stop carried a cost that had to be recovered on track."),
    "swing": (
        "The largest win-probability move of the race came on lap 26 and carried a swing "
        "mass of 0.441. Max Verstappen moved from 31.2% to 74.8% across that stop, which "
        "the model classes as an undercut and rates likely. Lando Norris led until that "
        "point and lost 1.904 s over the exchange, which was more than the 2.431 s he "
        "eventually finished behind. Nothing later in the race moved the probabilities "
        "by a comparable amount."),
    "caveats": "The clean-air pace order between the top two cars is inside the rank uncertainty band.",
    "cites": {
        "result": ["finish[0].position", "finish[1].gap_to_winner_s", "finish[2].gap_to_winner_s"],
        "pace": ["pace[0].median_pace_s", "pace[1].gap_s", "teammates[0].gap_s"],
        "strategy": ["strategy.drivers[0].stint_laps", "strategy.optimal[0].optimal_laps"],
        "swing": ["swings[0].lap", "swings[0].p_before_pct", "swings[0].p_after_pct"],
    },
}


def test_a_correct_report_passes_every_verifier(bundle):
    assert R.verify_numbers(CORRECT, bundle) == []
    assert R.verify_attribution(CORRECT, bundle) == []
    assert R.verify_coverage(CORRECT, bundle) == []
    assert R.verify_style(CORRECT) == []
    assert R.audit(CORRECT, bundle) == []


def test_one_changed_digit_is_rejected(bundle):
    """§4.3: 'a report with a single digit changed is rejected'. 2.431 -> 2.432 is the
    smallest possible edit and it is the one a reader could never catch."""
    tampered = copy.deepcopy(CORRECT)
    tampered["result"] = tampered["result"].replace("2.431 s behind", "2.432 s behind")
    failures = R.verify_numbers(tampered, bundle)
    assert failures, "a changed digit passed the numeric verifier"
    assert "2.432" in failures[0]
    assert R.audit(tampered, bundle)


def test_an_invented_lap_time_is_rejected(bundle):
    """The §4.3 worked example: a plausible, well-formatted, entirely fictional lap."""
    tampered = copy.deepcopy(CORRECT)
    tampered["pace"] = ("Lando Norris set a 1:18.203 in clean air, the quickest of the "
                        "race.")
    failures = R.verify_numbers(tampered, bundle)
    assert any("1:18.203" in f for f in failures)


def test_a_real_number_on_the_wrong_driver_is_rejected(bundle):
    """§4.3 mechanism 4, the check every source proposal missed. 51 is a real bundle
    number -- it is Verstappen's clean-lap count -- so the numeric verifier passes it and
    only the attribution check catches it."""
    tampered = copy.deepcopy(CORRECT)
    tampered["pace"] = ("Lando Norris was the quickest car in clean air over 51 clean "
                        "laps.")
    assert R.verify_numbers(tampered, bundle) == [], "51 is a real bundle value"
    failures = R.verify_attribution(tampered, bundle)
    assert failures, "a real number on the wrong driver passed the attribution check"
    assert "'51'" in failures[0] and "verstappen" in failures[0]


def test_attribution_passes_when_the_sentence_names_no_entity(bundle):
    """It is an attribution check, not a coverage check: a sentence with no named entity
    cannot misattribute anything, and failing it would refuse correct reports."""
    ok = copy.deepcopy(CORRECT)
    ok["swing"] = "The decisive move came on lap 26 and carried a swing mass of 0.441."
    assert R.verify_attribution(ok, bundle) == []


def test_a_symmetric_gap_is_attributable_to_either_car(bundle):
    """A gap belongs to both cars, which is why §4.2's subject may be a pair. Refusing
    'Verstappen won by +2.431 s' would be a false positive on a correct sentence."""
    both = copy.deepcopy(CORRECT)
    both["result"] = "Max Verstappen won by +2.431 s over Lando Norris."
    assert R.verify_attribution(both, bundle) == []
    both["result"] = "Lando Norris finished +2.431 s behind Max Verstappen."
    assert R.verify_attribution(both, bundle) == []


def test_the_context_whitelist_is_narrow(bundle):
    """A whitelisted numeral needs BOTH a plausible range and the adjacent word. A bare
    numeral is never whitelisted, and a lap number past the race distance is not either."""
    ok = copy.deepcopy(CORRECT)
    ok["swing"] = "The safety car was deployed on lap 43 and the order settled."
    assert R.verify_numbers(ok, bundle) == []
    bad = copy.deepcopy(CORRECT)
    bad["swing"] = "The safety car was deployed on lap 143 and the order settled."
    assert R.verify_numbers(bad, bundle), "a lap past the race distance was whitelisted"
    bare = copy.deepcopy(CORRECT)
    bare["swing"] = "The gap settled at 3.884 by the end of the race."
    assert R.verify_numbers(bare, bundle), "a bare numeral was whitelisted"


def _partial(bundle: dict) -> dict:
    """A rain-affected session: the ingest is partial and pace covers part of the race."""
    bundle["coverage"] = {
        "status": "partial", "families": {},
        "clean_laps": R.fact(31, "31", None), "raw_laps": R.fact(57, "57", None),
        "total_laps": R.fact(70, "70", None), "warnings": R.fact(4, "4", None)}
    bundle["known_gaps"] = R.known_gaps(bundle)
    return bundle


def test_a_partial_bundle_that_does_not_cite_coverage_is_rejected(bundle):
    """§4.3 mechanism 5: a stated limitation is machine-enforced, not prompt-requested."""
    part = _partial(bundle)
    assert R.completeness(part) == "partial"
    assert R.verify_coverage(CORRECT, part), "a partial bundle passed without citing it"


def test_a_partial_bundle_that_cites_coverage_passes(bundle):
    part = _partial(bundle)
    cited = copy.deepcopy(CORRECT)
    cited["cites"]["pace"] = cited["cites"]["pace"] + ["coverage.clean_laps"]
    assert R.verify_coverage(cited, part) == []


def test_an_ok_bundle_needs_no_coverage_citation(bundle):
    assert R.completeness(bundle) == "ok"
    assert R.verify_coverage(CORRECT, bundle) == []


def test_style_prohibitions_are_enforced():
    """§4.1's voice rules are written as prohibitions because prohibitions are checkable."""
    drama = dict(CORRECT, result="Max Verstappen produced a dominant drive from P3.")
    assert any("dominant" in f for f in R.verify_style(drama))
    person = dict(CORRECT, pace="You could see that Lando Norris had the quicker car.")
    assert any("person" in f for f in R.verify_style(person))
    short = {n: "Max Verstappen won." for n in R.SECTIONS}
    assert any("floor" in f for f in R.verify_style(short))


def test_an_insufficient_bundle_is_never_sent_to_a_model():
    """§4.6: fewer than five classified results is a skip, decided before any call."""
    thin = synthetic_bundle()
    thin["finish"] = thin["finish"][:2]
    thin.setdefault("coverage", {"status": "ok"})
    assert R.completeness(thin) == "insufficient"


# §9.4 item 6 -- the false-positive corpus. Every paragraph below is CORRECT: each is
# phrased the way a human editor would phrase it, and each numeral is a real bundle fact
# attached to the right car. A verifier that refuses any of them refuses a good report,
# which is the failure mode this feature has to avoid: a refusal shows the fan nothing.
CORRECT_CORPUS: list[tuple[str, str]] = [
    ("result", "Max Verstappen won from P3, with Lando Norris 2.431 s behind."),
    ("result", "Lando Norris started from P1 and finished second, +2.431 s adrift."),
    ("result", "Oscar Piastri took P3, +9.874 s behind the winner, after starting P2."),
    ("result", "George Russell finished fourth, +21.006 s back, and scored 12 points."),
    ("result", "Charles Leclerc was classified fifth at +28.512 s and took 10 points."),
    ("pace", "Lando Norris held the quickest clean-air median of the race at 1:32.345."),
    ("pace", "Max Verstappen's median of 1:32.512 was 0.167 s off that mark."),
    ("pace", "Over 51 clean laps Max Verstappen showed an interquartile range of 0.385 s."),
    ("pace", "The clean-air ranks are uncertain: both cars span 1 to 2 in the band."),
    ("pace", "Lando Norris was 0.183 s quicker than Oscar Piastri over 44 compared laps."),
    ("pace", "Oscar Piastri was 0.183 s slower than Lando Norris over 44 compared laps."),
    ("strategy", "Max Verstappen made his single stop on lap 26."),
    ("strategy", "Lando Norris stayed out until lap 32 before his only stop."),
    ("strategy", "The optimal hard stint was 41 laps, inside a band of 36 to 47 laps."),
    ("strategy", "Pit loss was 21.400 s against hard degradation of 0.043 s/lap."),
    ("swing", "The decisive move came on lap 26, worth a swing mass of 0.441."),
    ("swing", "Max Verstappen went from 31.2% to 74.8% over that stop."),
    ("swing", "Lando Norris lost 1.904 s in the exchange on lap 26."),
    ("swing", "Max Verstappen gained 1.904 s in the exchange on lap 26."),
    ("swing", "The model classes the move as an undercut and rates it likely."),
]


def test_false_positive_rate_of_the_two_verifiers_is_zero_on_correct_prose(bundle):
    """§9.4 item 6. Measured on a hand-written corpus, because no key is available to
    generate real reports; the corpus is the executable statement of what "correct"
    means and the number below is the one WP-10 should re-measure against real output."""
    numeric_fp, attribution_fp, failures = 0, 0, []
    for section, text in CORRECT_CORPUS:
        sections = {n: None for n in R.SECTIONS}
        sections[section] = text
        sections["cites"] = _cites()
        n = R.verify_numbers(sections, bundle)
        a = R.verify_attribution(sections, bundle)
        numeric_fp += bool(n)
        attribution_fp += bool(a)
        failures.extend(n + a)
    total = len(CORRECT_CORPUS)
    print(f"\nfalse positives over {total} correct paragraphs: "
          f"numeric {numeric_fp}/{total}, attribution {attribution_fp}/{total}")
    assert failures == [], f"{len(failures)} false positives: {failures[:3]}"


def test_the_verifiers_make_no_api_call(bundle):
    """Everything except generate_report is pure over dicts (§7.1). Asserted on the
    module's own call counter, not on the clock."""
    before = R.API_CALLS
    R.audit(CORRECT, bundle)
    R.audit(CORRECT, _partial(copy.deepcopy(bundle)))
    assert R.API_CALLS == before == 0


def test_context_narrowing_does_not_blunt_the_attribution_check(bundle):
    """The lap/position narrowing of ``_refine`` is bounded by the sentence's own words.
    A bare count next to a driver still has to belong to that driver."""
    lap_reading = dict(CORRECT, swing="Lando Norris lost 1.904 s on lap 26.")
    assert R.verify_attribution(lap_reading, bundle) == []
    wrong = dict(CORRECT, pace="Lando Norris held an interquartile range of 0.385 s.")
    failures = R.verify_attribution(wrong, bundle)
    assert failures and "verstappen" in failures[0]


def test_an_ordinal_lap_and_a_lap_count_are_not_the_same_numeral(bundle):
    """The distinction that keeps §4.3's whitelist from swallowing mechanism 4.

    *"on lap 26"* is an ORDINAL: it names a lap of this race, it is whitelistable, and
    it belongs to the lap rather than to whoever is mentioned beside it. *"26 laps"* is
    a CARDINAL count -- a measurement, which must come from a fact and must belong to
    the driver the sentence names. That is precisely the shape of §4.3's own worked
    error, *"Norris led 47 laps"* when 47 is Verstappen's count, so the cardinal form
    stays inside the attribution check.
    """
    ordinal = dict(CORRECT, strategy="Lando Norris made his only stop on lap 26.")
    assert R.verify_numbers(ordinal, bundle) == []
    assert R.verify_attribution(ordinal, bundle) == []
    cardinal = dict(CORRECT, strategy="Lando Norris ran 26 laps on the medium compound.")
    failures = R.verify_attribution(cardinal, bundle)
    assert failures and "verstappen" in failures[0]
    # And past the race distance it is neither: no fact, no whitelist.
    beyond = dict(CORRECT, strategy="The leader pitted on lap 96 of the race.")
    assert R.verify_numbers(beyond, bundle)


def _plain_numbers(node, path: str = "") -> list[str]:
    """Numeric leaves that are NOT inside a fact -- i.e. numbers the verifiers cannot
    see. Prose quoting one of these would be refused even though it is correct."""
    out: list[str] = []
    if isinstance(node, dict):
        if {"value", "display", "subject"} <= set(node):
            return out
        for k, v in node.items():
            out += _plain_numbers(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += _plain_numbers(v, f"{path}[{i}]")
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        out.append(path)
    return out


# event.year and event.round are the two deliberate exceptions: they are identifiers the
# whitelist recognises by name ("round 14", "2025"), not measurements.
ALLOWED_PLAIN = ("event.year", "event.round")


def test_the_fixture_bundle_has_no_unverifiable_numbers(bundle):
    stray = [p for p in _plain_numbers(bundle) if not p.startswith(ALLOWED_PLAIN)]
    assert stray == [], f"numbers the verifiers cannot see: {stray}"


@pytest.mark.db
def test_a_real_bundle_has_no_unverifiable_numbers(db_conn):
    """The same invariant against real stored rows, across a race from each season."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT DISTINCT ON (s.year) si.session_id, si.assumption_set_id "
                    "  FROM session_ingests si JOIN sessions s USING (session_id) "
                    " WHERE s.kind = 'R' ORDER BY s.year, s.round DESC")
        pairs = cur.fetchall()
    assert pairs, "no race sessions are ingested"
    for sid, asid in pairs:
        b = R.build_grounding(db_conn, sid, asid)
        stray = [p for p in _plain_numbers(b) if not p.startswith(ALLOWED_PLAIN)]
        assert stray == [], f"session {sid}: {stray}"
        assert R.verify_numbers({n: None for n in R.SECTIONS}, b) == []
    db_conn.rollback()


def test_the_normal_clean_lap_filter_is_not_reported_as_a_gap(bundle):
    """``laps.is_representative`` removes in-laps, out-laps and safety-car laps on every
    race (SPEC §0.3). Listing that as a known gap 62 times a season would train a reader
    to skip the one place the report admits what it does not know."""
    normal = copy.deepcopy(bundle)
    normal["coverage"]["clean_laps"] = R.fact(980, "980", None)
    normal["coverage"]["raw_laps"] = R.fact(1106, "1106", None)
    assert R.known_gaps(normal) == []
    starved = copy.deepcopy(bundle)
    starved["coverage"]["clean_laps"] = R.fact(439, "439", None)
    starved["coverage"]["raw_laps"] = R.fact(825, "825", None)
    assert any("439 of 825" in g for g in R.known_gaps(starved))
