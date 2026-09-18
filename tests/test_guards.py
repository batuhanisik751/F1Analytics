"""The two guards that keep a bad session from becoming 'failed' for the wrong reason (no database).

- ``frames.build_race_frames``: a ``pace_ranking`` ``IndexError`` (no driver with >= 8 clean laps,
  §0.5) yields a *partial* session — laps still stored, the dependent analytics 'empty', the
  reason in ``analytics_status`` — never an exception.
- ``ingest._check_loaded``: a FastF1 session whose data never loaded (a race that has not been
  run) raises ``DataNotAvailable`` with a readable reason instead of FastF1's generic
  ``DataNotLoadedError`` on first property access.
"""

from __future__ import annotations

import pandas as pd
import pytest

from f1lab import frames, ingest, pace


def test_pace_ranking_index_error_makes_session_partial(hungary_2024, monkeypatch):
    def no_driver_qualifies(laps, min_laps=8):
        raise IndexError("single positional indexer is out-of-bounds")

    monkeypatch.setattr(pace, "pace_ranking", no_driver_qualifies)
    ids = frames.make_session_ids(hungary_2024, session_id=7)
    fr = frames.build_race_frames(hungary_2024, ids, 1)

    st = fr.analytics_status
    assert st["pace_ranking"].startswith("error: IndexError:")
    assert st["teammate_deltas"] == "empty" and st["fuel_sensitivity"] == "empty"
    for t in ("pace_ranking", "teammate_deltas", "fuel_sensitivity"):
        assert len(fr.tables[t]) == 0 and list(fr.tables[t].columns) == frames.EXPECTED_COLUMNS[t]
    # Everything that does not depend on the ranking is untouched.
    assert st["degradation_fits"] == "ok" and st["lap_exclusion_report"] == "ok" and st["stints"] == "ok"
    assert len(fr.tables["laps"]) == 1355 and fr.clean_laps == 1233
    assert len(fr.tables["degradation_fits"]) == 54
    status = "ok" if all(v == "ok" for v in st.values()) else "partial"
    assert status == "partial"


def test_pace_ranking_really_raises_index_error_without_qualifying_drivers(hungary_2024):
    """The guard exists because of this: pace_ranking on too few clean laps is an IndexError."""
    from f1lab import clean

    laps_fc = pace.fuel_correct(clean.clean_laps(hungary_2024), hungary_2024.total_laps, lap_km=None)
    few = laps_fc.groupby("Driver", observed=True).head(3)
    with pytest.raises(IndexError):
        pace.pace_ranking(few, min_laps=8)


class _NotLoaded:
    """Mimics fastf1.core.Session after a load() that could fetch nothing."""

    @property
    def results(self):
        raise RuntimeError("The data you are trying to access has not been loaded yet. See `Session.load`")

    laps = results


class _Empty:
    results = pd.DataFrame()
    laps = pd.DataFrame()


class _Loaded:
    results = pd.DataFrame({"Abbreviation": ["NOR"]})
    laps = pd.DataFrame({"LapNumber": [1.0]})


class _LoadedQuali:
    """A qualifying session that really did load: results with a Q1 time, and laps."""

    results = pd.DataFrame({"Abbreviation": ["NOR"], "Q1": [pd.Timedelta(seconds=71.4)]})
    laps = pd.DataFrame({"LapNumber": [1.0]})


class _QualiHusk:
    """What `messages=False` produces for sprint qualifying: 20 driver rows, all-NaT times."""

    results = pd.DataFrame({"Abbreviation": ["NOR"], "Q1": [pd.NaT]})
    laps = pd.DataFrame({"LapNumber": [1.0]})


def test_check_loaded_raises_data_not_available():
    with pytest.raises(ingest.DataNotAvailable, match=r"no timing data available for 2026 R14 R \(RuntimeError"):
        ingest._check_loaded(_NotLoaded(), 2026, 14, "R")
    with pytest.raises(ingest.DataNotAvailable, match=r"results rows=0"):
        ingest._check_loaded(_Empty(), 2026, 14, "S")
    s = _Loaded()
    assert ingest._check_loaded(s, 2026, 13, "R") is s
    assert ingest._check_loaded(s, 2026, 13, "S") is s
    # DataNotAvailable is not retried (it would be a 130 s wait for a race that has not happened).
    assert not issubclass(ingest.DataNotAvailable, ingest.RETRYABLE)


def test_check_loaded_is_kind_aware_for_quali(monkeypatch):
    """QUALI_SPEC §7 WP4: Q and SQ require a non-null Q1 AND a representative lap, and SQ is
    held to the SAME standard as Q -- the all-NaT husk `messages=False` produces must fail."""
    # An unloaded / empty qualifying session fails the way a race does.
    for kind in ("Q", "SQ"):
        with pytest.raises(ingest.DataNotAvailable, match=r"RuntimeError"):
            ingest._check_loaded(_NotLoaded(), 2026, 14, kind)
        with pytest.raises(ingest.DataNotAvailable, match=r"results rows=0"):
            ingest._check_loaded(_Empty(), 2026, 14, kind)
        # 20 rows of drivers with no times in them is a husk, not a session.
        with pytest.raises(ingest.DataNotAvailable, match=r"non-null Q1 times=0"):
            ingest._check_loaded(_QualiHusk(), 2026, 14, kind)
    # Q1 present but nothing survives cleaning is also not a session.
    monkeypatch.setattr(ingest.clean, "clean_quali",
                        lambda s, results=None: (pd.DataFrame({"is_representative": [False]}), {}))
    for kind in ("Q", "SQ"):
        with pytest.raises(ingest.DataNotAvailable, match=r"representative laps=0"):
            ingest._check_loaded(_LoadedQuali(), 2026, 14, kind)
    # A real one passes, and hands the cleaning forward instead of repeating it (§2.7).
    cleaned = (pd.DataFrame({"is_representative": [True]}), {"ok": True})
    monkeypatch.setattr(ingest.clean, "clean_quali", lambda s, results=None: cleaned)
    for kind in ("Q", "SQ"):
        s = _LoadedQuali()
        assert ingest._check_loaded(s, 2026, 13, kind) is s
        got = ingest.cleaned_quali(s)
        assert got is not None and got[0] is cleaned[0] and got[1] is cleaned[1]
    assert ingest.cleaned_quali(_Loaded()) is None


def test_load_with_retry_pins_messages_by_kind(monkeypatch):
    """D4 / §0.2: Q and SQ load with race-control messages ON; R and S stay pinned at OFF, so
    the 71 existing races cannot silently change their representative lap set (§5.6)."""
    seen: dict[str, object] = {}

    def load(year, rnd, kind, cache=None, *, messages=False):
        seen[kind] = messages
        return _LoadedQuali() if kind in ("Q", "SQ") else _Loaded()

    monkeypatch.setattr(ingest.clean, "load_race", load)
    monkeypatch.setattr(ingest.clean, "clean_quali",
                        lambda s, results=None: (pd.DataFrame({"is_representative": [True]}), {"ok": True}))
    for kind in ("R", "S", "Q", "SQ"):
        ingest.load_with_retry(2024, 1, kind, None)
    assert seen == {"R": False, "S": False, "Q": True, "SQ": True}


def test_load_with_retry_does_not_retry_data_not_available(monkeypatch):
    calls = []

    def load(year, rnd, kind, cache=None, *, messages=False):
        calls.append((year, rnd, kind))
        return _NotLoaded()

    monkeypatch.setattr(ingest.clean, "load_race", load)
    monkeypatch.setattr(ingest.time, "sleep", lambda s: (_ for _ in ()).throw(AssertionError("slept")))
    with pytest.raises(ingest.DataNotAvailable):
        ingest.load_with_retry(2026, 14, "R", None)
    assert calls == [(2026, 14, "R")]


def test_headshot_url_filter():
    """drivers.headshot_url takes an absolute http(s) URL or NULL; FastF1's stringified None ('None',
    Colapinto 2025) and anything else become NULL. The string 'None' is NOT a null literal for
    frames._is_null, because it is also FastF1's raw compound label behind the 'NONE' rows (§8.1)."""
    url = "https://media.formula1.com/d_driver_fallback_image.png/content/dam/fom-website/x.png"
    assert ingest.headshot_url(url) == url
    assert ingest.headshot_url(f"  {url} ") == url
    for bad in ("None", "nan", "", None, float("nan"), pd.NA, "media.formula1.com/x.png", "ftp://x/y.png", 42):
        assert ingest.headshot_url(bad) is None, bad
    assert not frames._is_null("None") and frames._is_null("nan") and frames._is_null("")


def test_guard_partial(hungary_2024, monkeypatch, pooled_stint_seed):
    """SIM_SPEC §3.5: SimNotEstimable is caught by _guard('sim') (session partial, four empty frames); a RuntimeError
    is NOT caught — the session fails. Documents the boundary.

    pooled_stint_seed supplies synthetic pooled slopes/pit loss (conftest): v1.2's optimal_stint
    reads frames.POOLED_STINT, which only ingest.run_season fills, so without the seed the
    'every other key is ok' assertion below would trip on a legitimate optimal_stint='empty'."""
    from f1lab import sim

    def not_estimable(*a, **k):
        raise sim.SimNotEstimable("x")

    monkeypatch.setattr(sim, "fit_race", not_estimable)
    ids = frames.make_session_ids(hungary_2024, session_id=7)
    fr = frames.build_race_frames(hungary_2024, ids, 1)
    st = fr.analytics_status
    assert st["sim"].startswith("error: SimNotEstimable") and st["sim"] == "error: SimNotEstimable: x"
    for t in ("sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound"):
        assert len(fr.tables[t]) == 0 and list(fr.tables[t].columns) == frames.EXPECTED_COLUMNS[t]
    assert all(v == "ok" for k, v in st.items() if k != "sim")
    status = "ok" if all(v == "ok" for v in st.values()) else "partial"
    assert status == "partial"
    assert not any("SimNotEstimable" in w for w in fr.warnings)

    def boom(*a, **k):
        raise RuntimeError("not a data problem")

    monkeypatch.setattr(sim, "fit_race", boom)
    with pytest.raises(RuntimeError, match="not a data problem"):
        frames.build_race_frames(hungary_2024, ids, 1)
