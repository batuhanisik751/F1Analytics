"""No-db tests for f1lab.sim on the cached fixtures (SIM_SPEC §3.5). Link 1: the §1.2–1.5 estimators."""

import numpy as np
import pytest

from f1lab import clean, config, pace, sim


@pytest.fixture(scope="module")
def hungary_fit(hungary_2024):
    fc = pace.fuel_correct(clean.annotate_laps(hungary_2024), hungary_2024.total_laps, lap_km=None)
    rows, comps, dropped = sim.fit_rows(fc, config.SIM_MIN_COMPOUND_LAPS)
    model = sim.fit_lap_model(rows, evo_prior_sd=config.SIM_EVO_PRIOR_SD,
                              resid_sd_guess=config.SIM_RESID_SD_GUESS, min_driver_laps=config.SIM_MIN_DRIVER_LAPS)
    return fc, rows, model


def test_hungary_joint_fit_matches_spec(hungary_fit):
    _, rows, m = hungary_fit
    assert len(rows) == 1233 and m.ref_compound == "HARD" and m.compounds == ["HARD", "MEDIUM", "SOFT"]
    assert 0.55 < m.r2 < 0.65 and 0.70 < m.resid_sd < 0.80 and m.design_cond < 2000
    assert abs(m.deg("HARD") - 0.084) < 0.004 and abs(m.deg("MEDIUM") - 0.070) < 0.006
    assert abs(m.evo + 0.0043) < 0.002
    assert m.offset("HARD") == 0.0 and 0.05 < m.offset("MEDIUM") < 0.20 and 0.4 < m.offset("SOFT") < 1.0


def test_driver_compound_dev_shrinkage(hungary_fit):
    _, rows, m = hungary_fit
    dc = sim.driver_compound_dev(rows, m, config.SIM_K_DC)
    assert list(dc.columns) == ["Driver", "compound", "laps", "dc_offset_s", "dc_se"]
    assert set(dc["Driver"]) == set(m.drivers) and set(dc["compound"]) <= set(m.compounds)
    assert not dc.duplicated(["Driver", "compound"]).any() and (dc["laps"] >= 1).all()
    noise = sim.driver_noise_sd(rows, m)
    assert (noise >= config.SIM_NOISE_SD_FLOOR).all()
    fit = rows.loc[m.resid.index]
    for r in dc.head(5).itertuples():
        mask = (fit["Driver"] == r.Driver) & (fit["Compound"] == r.compound)
        raw = float(m.resid[mask].mean())
        assert np.isclose(r.dc_offset_s, raw * r.laps / (r.laps + config.SIM_K_DC))
        assert np.isclose(r.dc_se, noise[r.Driver] / np.sqrt(r.laps + config.SIM_K_DC))
    assert dc["dc_offset_s"].abs().max() < 1.0


def _tau(rows, m):
    return sim.stint_scatter(rows, m, min_laps=config.SIM_STINT_MIN_LAPS, min_stints=config.SIM_STINT_MIN_STINTS,
                             priors=(config.SIM_STINT_TAU_LEVEL_PRIOR, config.SIM_STINT_TAU_SLOPE_PRIOR),
                             caps=(config.SIM_STINT_TAU_LEVEL_MAX, config.SIM_STINT_TAU_SLOPE_MAX))


def test_stint_scatter_hungary(hungary_fit):
    _, rows, m = hungary_fit
    tau = _tau(rows, m).set_index("compound")
    assert list(tau.index) == m.compounds
    hard = tau.loc["HARD"]
    assert hard["stint_tau_source"] == "race" and hard["stints_used"] >= 20
    assert 0.02 < hard["stint_tau_slope"] < 0.08 and 0.0 < hard["stint_tau_level_s"] <= config.SIM_STINT_TAU_LEVEL_MAX
    soft = tau.loc["SOFT"]
    assert soft["stint_tau_source"] == "prior" and soft["stints_used"] < config.SIM_STINT_MIN_STINTS
    assert soft["stint_tau_level_s"] == config.SIM_STINT_TAU_LEVEL_PRIOR
    assert soft["stint_tau_slope"] == config.SIM_STINT_TAU_SLOPE_PRIOR
    assert (tau["stint_tau_level_s"] <= config.SIM_STINT_TAU_LEVEL_MAX).all()
    assert (tau["stint_tau_slope"] <= config.SIM_STINT_TAU_SLOPE_MAX).all()


def test_compound_table_columns_and_floor(hungary_fit):
    _, rows, m = hungary_fit
    tau = _tau(rows, m)
    ct, warns = sim.compound_table(rows, m, tau)
    expected = ["compound", "laps", "age_max", "offset_s", "offset_se", "deg_raw_s_per_lap", "deg_s_per_lap",
                "deg_se", "deg_negative", "stint_tau_level_s", "stint_tau_slope", "stint_tau_source", "stints_used"]
    assert list(ct.columns) == expected and warns == []
    ct = ct.set_index("compound")
    assert ct.loc["HARD", "laps"] == 806 and ct.loc["SOFT", "laps"] == 34
    assert ct.loc["HARD", "offset_s"] == 0.0 and ct.loc["HARD", "offset_se"] == 0.0
    assert (ct["age_max"] >= 2).all() and not ct["deg_negative"].any()
    assert (ct["deg_s_per_lap"] == ct["deg_raw_s_per_lap"]).all()
    # A high floor exercises the §1.4 negative-slope path without a synthetic frame.
    ct2, w2 = sim.compound_table(rows, m, tau, deg_floor=0.075)
    ct2 = ct2.set_index("compound")
    assert bool(ct2.loc["MEDIUM", "deg_negative"]) and ct2.loc["MEDIUM", "deg_s_per_lap"] == 0.075
    assert not ct2.loc["HARD", "deg_negative"] and any("MEDIUM degradation" in w for w in w2)


# --- Link 2: §1.6–1.9 model-relative excesses ---------------------------------------------------

@pytest.fixture(scope="module")
def hungary_race(hungary_2024, hungary_fit):
    from f1lab import derive
    fc, rows, m = hungary_fit
    ann = clean.annotate_laps(hungary_2024)
    pits = derive.pit_stops(hungary_2024.laps)
    ls = derive.lap_status(ann)
    dc = sim.driver_compound_dev(rows, m, config.SIM_K_DC)
    deltas, n_cars = sim.lap_deltas(fc, pits, m, dc, int(hungary_2024.total_laps),
                                    config.SIM_MIN_CARS_FOR_DELTA, ls)
    return dict(fc=fc, m=m, dc=dc, pits=pits, ls=ls, deltas=deltas, n_cars=n_cars,
                total=int(hungary_2024.total_laps))


def test_lap_deltas_and_start_penalty_hungary(hungary_race):
    r = hungary_race
    deltas, n_cars = r["deltas"], r["n_cars"]
    assert len(deltas) == r["total"] == len(n_cars) == 70
    assert deltas[0] == 0.0 and n_cars[0] == 0
    assert all(isinstance(v, float) for v in deltas) and all(isinstance(v, int) for v in n_cars)
    assert all(n >= config.SIM_MIN_CARS_FOR_DELTA or d == 0.0 for d, n in zip(deltas, n_cars))
    assert max(n_cars) >= 15 and abs(float(np.median(deltas[1:]))) < 0.5   # green race: no SC bands
    sp = sim.start_penalty(r["fc"], r["m"], r["dc"])
    assert 5.0 < sp < 11.0                                                   # spec p10–p90 5.5–10.7
    # §1.8 centring: raw deltas carry a negative green-lap level; after centring the green lap sits at ~0
    raw, raw_n = sim.lap_deltas(r["fc"], r["pits"], r["m"], r["dc"], r["total"], config.SIM_MIN_CARS_FOR_DELTA)
    off = sim.green_delta_offset(raw, raw_n, r["ls"], min_cars=config.SIM_MIN_CARS_FOR_DELTA)
    assert -0.4 < off < -0.005                                  # Hungary 2024 sits in the observed -0.31..+0.01
    assert sum(1 for n in n_cars if n >= config.SIM_MIN_CARS_FOR_DELTA) > 50
    assert all(d == pytest.approx(rd - off) if n >= config.SIM_MIN_CARS_FOR_DELTA else d == 0.0
               for d, rd, n in zip(deltas, raw, n_cars))
    assert abs(sim.green_delta_offset(deltas, n_cars, r["ls"], min_cars=config.SIM_MIN_CARS_FOR_DELTA)) < 1e-9


def test_green_delta_offset_centres_green_laps_only():
    """§1.8: the offset is the trimmed mean of the KNOWN GREEN deltas; SC laps and unknown laps are ignored."""
    import pandas as pd
    # laps 1..12: lap 1 unknown, laps 2-9 green at +0.50 (one anomaly at +9.0), laps 10-12 under SC at +35.
    deltas = [0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 9.0, 35.0, 35.0, 35.0]
    n_cars = [0, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 2]
    ls = pd.DataFrame({"LapNumber": range(1, 13),
                       "WorstStatus": ["1"] * 9 + ["4", "4", "4"]})
    off = sim.green_delta_offset(deltas, n_cars, ls, min_cars=3, trim=0.0, min_laps=5)
    assert off == pytest.approx((0.5 * 7 + 9.0) / 8)            # untrimmed mean is dragged by the anomaly
    trimmed = sim.green_delta_offset(deltas, n_cars, ls, min_cars=3, trim=0.2, min_laps=5)
    assert trimmed == pytest.approx(0.5)                        # trimming drops it
    assert sim.green_delta_offset(deltas, n_cars, None, min_cars=3) == 0.0
    assert sim.green_delta_offset(deltas, n_cars, ls, min_cars=3, min_laps=50) == 0.0   # too few green laps


def test_pit_excess_and_pit_loss_hungary(hungary_race):
    r = hungary_race
    ex = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds)
    assert list(ex.columns)[:4] == ["Driver", "stop_number", "lap_in", "status_in"] and "excess_s" in ex
    assert 36 <= len(ex) <= 41 and (ex["lap_in"] > 1).all() and set(ex["status_in"]) <= {"1", "2"}
    pl = sim.pit_loss(ex, min_green=config.SIM_MIN_GREEN_STOPS, min_sc=config.SIM_MIN_SC_STOPS,
                      samples_max=config.SIM_PIT_SAMPLES_MAX)
    assert 20.0 < pl["pit_loss_s"] < 21.5 and 0.8 < pl["pit_loss_mad_s"] < 2.0     # spec ≈ 20.7, n ≈ 39
    assert pl["pit_loss_n"] == len(ex) == len(pl["pit_loss_samples_s"])
    assert pl["sc_pit_samples_s"] == [] and pl["sc_pit_factor_race"] is None
    assert pl["vsc_pit_samples_s"] == [] and pl["vsc_pit_factor_race"] is None
    assert sim.hazard_counts(r["ls"]) == {"n_sc_laps": 0, "n_vsc_laps": 0, "n_red_laps": 0}


def test_pit_loss_synthetic_paths():
    import pandas as pd
    fake = pd.DataFrame({"Driver": ["A"] * 8, "stop_number": 1, "lap_in": range(2, 10),
                         "status_in": ["1", "2", "1", "1", "4", "4", "4", "6"], "status_out": ["1"] * 8,
                         "excess_s": [20.0, 21.0, 22.0, 23.0, 17.0, 18.0, 19.0, 20.0]})
    few = sim.pit_loss(fake, min_green=5, min_sc=3, samples_max=60)
    assert few["pit_loss_s"] is None and few["pit_loss_n"] == 4 and few["pit_loss_samples_s"] == []
    assert few["sc_pit_samples_s"] == [17.0, 18.0, 19.0] and few["sc_pit_factor_race"] is None
    ok = sim.pit_loss(fake, min_green=3, min_sc=3, samples_max=2)
    assert ok["pit_loss_s"] == 21.5 and ok["pit_loss_mad_s"] == 1.0 and ok["pit_loss_samples_s"] == [21.0, 22.0]
    assert len(ok["sc_pit_samples_s"]) == 2 and ok["sc_pit_factor_race"] is None    # capped below min_sc
    ok2 = sim.pit_loss(fake, min_green=3, min_sc=3, samples_max=60)
    assert ok2["sc_pit_factor_race"] == pytest.approx(18.0 / 21.5) and ok2["vsc_pit_factor_race"] is None
    ls = pd.DataFrame({"LapNumber": [1, 2, 3, 4, 5], "WorstStatus": ["1", "4", "6", "7", "5"]})
    assert sim.hazard_counts(ls) == {"n_sc_laps": 1, "n_vsc_laps": 2, "n_red_laps": 1}
    assert few["warnings"] == ok["warnings"] == ok2["warnings"] == []


def test_pit_factor_band_rejects_implausible_race_factor():
    """§1.7 plausibility band: a factor outside [SIM_PIT_FACTOR_MIN, SIM_PIT_FACTOR_MAX] is a measurement
    failure, so it is dropped to None (browser falls back to pooled) and a warning is recorded."""
    import pandas as pd

    def frame(sc_excess, vsc_excess):
        green = [20.0, 21.0, 22.0, 23.0, 24.0]                     # median 22.0 -> pit_loss_s
        ex = green + list(sc_excess) + list(vsc_excess)
        st = ["1"] * len(green) + ["4"] * len(sc_excess) + ["6"] * len(vsc_excess)
        return pd.DataFrame({"Driver": "A", "stop_number": 1, "lap_in": range(2, 2 + len(ex)),
                             "status_in": st, "status_out": ["1"] * len(ex), "excess_s": ex})

    kw = dict(min_green=5, min_sc=3, samples_max=60,
              factor_min=config.SIM_PIT_FACTOR_MIN, factor_max=config.SIM_PIT_FACTOR_MAX)
    # SC stops that appear to GAIN time (negative excess) and VSC stops far above a green stop.
    bad = sim.pit_loss(frame([-9.0, -10.0, -11.0], [54.0, 55.0, 56.0]), **kw)
    assert bad["pit_loss_s"] == 22.0
    assert bad["sc_pit_factor_race"] is None and bad["vsc_pit_factor_race"] is None
    assert bad["sc_pit_samples_s"] == [-11.0, -10.0, -9.0]          # samples are kept, only the factor is dropped
    assert bad["warnings"] == [
        "sim: SC pit factor -0.45 from 3 stops out of range [0.3, 1.3], using pooled",
        "sim: VSC pit factor 2.50 from 3 stops out of range [0.3, 1.3], using pooled"]
    # In-band factors survive untouched and record nothing.
    good = sim.pit_loss(frame([17.0, 18.0, 19.0], [20.0, 21.0, 22.0]), **kw)
    assert good["sc_pit_factor_race"] == pytest.approx(18.0 / 22.0)
    assert good["vsc_pit_factor_race"] == pytest.approx(21.0 / 22.0) and good["warnings"] == []


def test_miami_vsc_delta_and_factor(miami_2025):
    from f1lab import derive
    s = miami_2025
    ann = clean.annotate_laps(s)
    fc = pace.fuel_correct(ann, s.total_laps, lap_km=None)
    pits, ls = derive.pit_stops(s.laps), derive.lap_status(ann)
    rows, comps, _ = sim.fit_rows(fc, config.SIM_MIN_COMPOUND_LAPS)
    m = sim.fit_lap_model(rows, evo_prior_sd=config.SIM_EVO_PRIOR_SD, resid_sd_guess=config.SIM_RESID_SD_GUESS,
                          min_driver_laps=config.SIM_MIN_DRIVER_LAPS)
    dc = sim.driver_compound_dev(rows, m, config.SIM_K_DC)
    deltas, n_cars = sim.lap_deltas(fc, pits, m, dc, int(s.total_laps), config.SIM_MIN_CARS_FOR_DELTA, ls)
    hz = sim.hazard_counts(ls)
    assert hz["n_vsc_laps"] >= 5 and hz["n_sc_laps"] == 0
    assert 20.0 < deltas[1] < 30.0 and 20.0 < deltas[2] < 30.0        # laps 2–3 fully under VSC (§1.8: 8–28.5)
    ex = sim.pit_excess(fc, pits, ls, m, dc, deltas, comps)
    pl = sim.pit_loss(ex, min_green=config.SIM_MIN_GREEN_STOPS, min_sc=config.SIM_MIN_SC_STOPS,
                      samples_max=config.SIM_PIT_SAMPLES_MAX)
    assert pl["pit_loss_n"] >= 5 and 18.0 < pl["pit_loss_s"] < 21.0
    assert len(pl["vsc_pit_samples_s"]) >= 3 and 0.7 < pl["vsc_pit_factor_race"] < 1.2


# --- Link 3: §1.10 replay, calibration, coverage; fit_race; §1.9 hazards ----------------------

@pytest.fixture(scope="module")
def hungary_calib(hungary_2024, hungary_race):
    from f1lab import derive
    r = hungary_race
    sp = sim.start_penalty(r["fc"], r["m"], r["dc"])
    ex = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds)
    pit = sim.pit_loss(ex, min_green=config.SIM_MIN_GREEN_STOPS, min_sc=config.SIM_MIN_SC_STOPS,
                       samples_max=config.SIM_PIT_SAMPLES_MAX)
    stints = clean.stint_table(hungary_2024)
    cal = sim.calibrate(r["fc"], stints, r["pits"], r["ls"], hungary_2024.results, r["m"], r["dc"], r["deltas"],
                        sp, pit, r["m"].compounds, min_modelled=config.SIM_MIN_MODELLED_LAPS)
    return dict(sp=sp, pit=pit, stints=stints, cal=cal)


def test_replay_arithmetic(hungary_race):
    r = hungary_race
    m, dc, deltas = r["m"], r["dc"], r["deltas"]
    strat = [("MEDIUM", 3), ("HARD", 6)]
    total, pl = sim.replay(strat, ["4"], model=m, dc=dc, deltas=deltas, start_penalty=8.0, pit_loss_s=20.0,
                           sc_factor=0.5, vsc_factor=0.9, horizon=6, driver="VER", start_age=2)
    assert len(pl) == 6 and total == pytest.approx(sum(pl)) and all(isinstance(v, float) for v in pl)
    dcv = dict(zip(dc.loc[dc.Driver == "VER", "compound"], dc.loc[dc.Driver == "VER", "dc_offset_s"]))
    b, ev = m.base("VER"), m.evo
    exp1 = b + m.offset("MEDIUM") + dcv["MEDIUM"] + m.deg("MEDIUM") * (2 - 1) + deltas[0] + 8.0   # age 2 on lap 1
    exp3 = b + m.offset("MEDIUM") + dcv["MEDIUM"] + m.deg("MEDIUM") * 3 + ev * 2 + deltas[2] + 20.0 * 0.5
    exp4 = b + m.offset("HARD") + dcv["HARD"] + ev * 3 + deltas[3]                                  # age 1 out-lap
    assert pl[0] == pytest.approx(exp1, abs=1e-12) and pl[2] == pytest.approx(exp3, abs=1e-12)
    assert pl[3] == pytest.approx(exp4, abs=1e-12)
    _, nd = sim.replay(strat, ["6"], model=m, dc={"MEDIUM": 0.0, "HARD": 0.0}, deltas=deltas, start_penalty=0.0,
                       pit_loss_s=20.0, sc_factor=0.5, vsc_factor=0.9, horizon=6, driver="VER", use_deltas=False)
    assert nd[2] - nd[1] == pytest.approx(m.deg("MEDIUM") + ev + 18.0, abs=1e-12)
    assert sim.pit_factor("5", 0.5, 0.9) == 0.5 and sim.pit_factor("7", 0.5, 0.9) == 0.9 and sim.pit_factor("2", 0.5, 0.9) == 1.0
    with pytest.raises(ValueError):
        sim.replay(strat, ["1"], model=m, dc=dc, deltas=deltas, start_penalty=0, pit_loss_s=20, sc_factor=1,
                   vsc_factor=1, horizon=7, driver="VER")


def test_calibrate_hungary_identity_and_badges(hungary_calib):
    cal = hungary_calib["cal"]
    assert list(cal.columns) == sim.CALIB_COLUMNS and len(cal) == 20 and cal["simulable"].all()
    ident = cal.sim_total_fc_s - cal.real_total_fc_s + (cal.misfit_rep_s + cal.misfit_pit_s + cal.misfit_lap1_s
                                                        + cal.unmodelled_s)
    assert ident.abs().max() < 1e-9
    assert set(cal["badge"]) <= {"calibrated", "rough"} and (cal["badge"] == "calibrated").sum() >= 12
    ver = cal.set_index("Driver").loc["VER"]
    assert ver.laps_completed == 70 == ver.laps_timed and 60 <= ver.laps_modelled <= 66 and ver.stops == 2
    # §1.8 centring removed the systematic 'model optimistic' offset, so the sign is no longer fixed
    assert abs(ver.misfit_rep_s) / ver.laps_modelled < 0.15 and abs(ver.misfit_lap1_s) < 6.0
    assert 100 < ver.real_fuel_s < 110 and abs(ver.sim_total_fc_s - ver.real_total_fc_s) < 20
    assert (cal.real_total_s - cal.real_total_fc_s - cal.real_fuel_s).abs().max() < 1e-9
    assert sim.driver_strategy(hungary_calib["stints"], "VER", 70) == [("MEDIUM", 21), ("HARD", 49), ("MEDIUM", 70)]
    assert sim.driver_strategy(hungary_calib["stints"].iloc[1:], "ALB", 69) is None      # first stint missing


def test_stint_coverage_hungary(hungary_fit):
    _, rows, m = hungary_fit
    tau = _tau(rows, m)
    cov = sim.stint_coverage(rows, m, tau, sim.driver_noise_sd(rows, m))
    assert cov is not None and 0.6 <= cov <= 1.0
    assert sim.stint_coverage(rows, m, tau, sim.driver_noise_sd(rows, m), min_laps=60) is None


def _fit(session):
    from f1lab import derive
    ann = clean.annotate_laps(session)
    fc = pace.fuel_correct(ann, session.total_laps, lap_km=None)
    return fc, lambda f: sim.fit_race(f, derive.lap_status(ann), derive.pit_stops(session.laps),
                                      clean.stint_table(session), session.results, int(session.total_laps))


def test_fit_race_hungary_matches_spec(hungary_2024):
    fc, run = _fit(hungary_2024)
    f = run(fc)
    assert len(f) == 1 and f.warnings == []
    assert list(f.race_params.columns) == sim.RACE_PARAM_COLUMNS
    assert list(f.compound_params.columns) == sim.COMPOUND_PARAM_COLUMNS
    assert list(f.driver_params.columns) == sim.DRIVER_PARAM_COLUMNS
    assert list(f.driver_compound.columns) == sim.DRIVER_COMPOUND_COLUMNS
    rp = f.race_params.iloc[0]
    assert rp.total_laps == 70 and rp.laps_fit == 1233 and rp.drivers_fit == 20 and rp.ref_compound == "HARD"
    assert 0.55 < rp.r2 < 0.65 and rp.design_cond < 5000 and 20.0 < rp.pit_loss_s < 21.5 and 36 <= rp.pit_loss_n <= 41
    assert rp.pit_loss_mad_s > 0 and len(rp.pit_loss_samples_s) == rp.pit_loss_n
    assert rp.sc_pit_factor_race is None and rp.sc_pit_samples_s == [] and rp.n_sc_laps == rp.n_vsc_laps == 0
    assert 5.0 < rp.start_penalty_s < 11.0 and 0.6 <= rp.stint_coverage_80 <= 1.0
    assert rp.param_names == ["off:MEDIUM", "off:SOFT", "deg:HARD", "deg:MEDIUM", "deg:SOFT", "evo"]
    k = len(rp.param_names)
    assert len(rp.param_mean) == k and len(rp.param_chol) == k * k and rp.param_mean[-1] == pytest.approx(rp.evo_s_per_lap)
    L = np.array(rp.param_chol).reshape(k, k)
    assert np.allclose(np.triu(L, 1), 0) and (np.diag(L) > 0).all() and (L @ L.T)[-1, -1] == pytest.approx(rp.evo_se ** 2, rel=1e-6)
    assert len(rp.field_delta_s) == 70 == len(rp.field_delta_cars) and rp.field_delta_s[0] == 0.0
    for arr in (rp.param_names, rp.param_mean, rp.param_chol, rp.field_delta_s, rp.field_delta_cars, rp.pit_loss_samples_s):
        assert isinstance(arr, list) and all(type(v) in (str, float, int) for v in arr)
    cp = f.compound_params.set_index("compound")
    assert list(cp.index) == ["HARD", "MEDIUM", "SOFT"] and not cp.deg_negative.any() and cp.loc["SOFT", "stint_tau_source"] == "prior"
    dp = f.driver_params.set_index("Driver")
    assert len(dp) == 20 and dp.simulable.all() and (dp.noise_sd_s >= config.SIM_NOISE_SD_FLOOR).all()
    assert dp.loc["VER", "laps_fit"] == 64 and abs(dp.loc["VER", "base_s"] - 81.0) < 2.0 and dp.loc["VER", "base_se"] < 0.3
    assert len(f.driver_compound) == 43 and set(f.driver_compound.Driver) == set(dp.index)


def test_fit_race_r1_2026_floor_and_not_simulable(r1_2026):
    fc, run = _fit(r1_2026)
    f = run(fc)
    rp = f.race_params.iloc[0]
    cp = f.compound_params.set_index("compound")
    assert bool(cp.loc["MEDIUM", "deg_negative"]) and cp.loc["MEDIUM", "deg_s_per_lap"] == 0.0 and cp.loc["MEDIUM", "deg_raw_s_per_lap"] < 0
    assert any(w.startswith("sim: MEDIUM degradation") for w in f.warnings)
    assert rp.n_vsc_laps == 13 and rp.vsc_pit_factor_race is not None and len(rp.vsc_pit_samples_s) >= 3
    dp = f.driver_params
    bad = dp.loc[~dp.simulable]
    assert len(bad) >= 1 and bad.not_simulable_reason.notna().all() and bad.badge.isna().all() and bad.sim_total_fc_s.isna().all()
    good = dp.loc[dp.simulable]
    assert good.not_simulable_reason.isna().all() and good.badge.notna().all()
    ident = good.sim_total_fc_s - good.real_total_fc_s + (good.misfit_rep_s + good.misfit_pit_s + good.misfit_lap1_s + good.unmodelled_s)
    assert ident.abs().max() < 1e-9


def test_fit_race_not_estimable_rules(hungary_2024):
    fc, run = _fit(hungary_2024)
    wet = fc.copy(); wet["Compound"] = "INTERMEDIATE"
    with pytest.raises(sim.SimNotEstimable, match="rain race"):
        run(wet)
    one = fc.copy(); one.loc[one["Compound"] != "HARD", "is_representative"] = False
    with pytest.raises(sim.SimNotEstimable, match="only 1 parameterised compound"):
        run(one)
    few = fc.copy(); few.loc[few["LapNumber"] > 12, "is_representative"] = False
    with pytest.raises(sim.SimNotEstimable, match="fewer than 200 fit rows"):
        run(few)
    six = fc.loc[fc["Driver"].isin(sorted(fc["Driver"].unique())[:5])]
    with pytest.raises(sim.SimNotEstimable, match="fewer than 6 drivers"):
        run(six)


def test_hazard_frame_synthetic():
    import datetime as dt
    import pandas as pd
    ls = pd.DataFrame({"LapNumber": range(1, 13), "WorstStatus": list("114466175544")})
    assert sim.episodes(ls) == ([(3, 2), (11, 2)], [(5, 2), (8, 1)])
    # Two circuits, three races: race 1 has an SC episode on laps 1-2 (start) and one on laps 5-7; race 2 a VSC.
    rows = []
    for sid, codes in ((1, "44" + "11" + "444" + "1" * 13), (2, "1" * 6 + "66" + "1" * 12), (3, "1" * 20)):
        rows += [(sid, i + 1, c) for i, c in enumerate(codes)]
    lap_status = pd.DataFrame(rows, columns=["session_id", "lap_number", "worst_status"])
    races = pd.DataFrame({"session_id": [1, 2, 3], "circuit_key": [10, 10, 20]})
    samples = pd.DataFrame({"session_id": [1, 2], "pit_loss_samples_s": [[20.0, 21.0, 22.0], [24.0, 26.0]],
                            "sc_pit_samples_s": [[18.0], []], "vsc_pit_samples_s": [[], [21.0, 23.0]]})
    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    hz = sim._hazard_frame(races, lap_status, samples, 7, 200, now).set_index("circuit_key")
    assert list(hz.columns) == sim.HAZARD_COLUMNS[1:] and list(hz.index) == [10, 20]
    laps3 = 18 * 3
    sc_pooled, vsc_pooled = 1 / laps3, 1 / laps3
    a, b = hz.loc[10], hz.loc[20]
    assert a.races == 2 and a.laps == 36 and a.sc_episodes == 1 and a.vsc_episodes == 1 and b.laps == 18
    assert a.sc_hazard == pytest.approx((1 + 200 * sc_pooled) / (36 + 200))
    assert b.sc_hazard == pytest.approx((0 + 200 * sc_pooled) / (18 + 200)) and b.sc_episodes == 0
    assert a.sc_hazard_pooled == pytest.approx(sc_pooled) == b.sc_hazard_pooled and a.vsc_hazard_pooled == pytest.approx(vsc_pooled)
    assert a.sc_start_p == pytest.approx(1 / 3) and a.vsc_start_p == 0.0 and a.sc_dur_mean == 2.5 and a.vsc_dur_mean == 2.0
    assert a.pooled_races == 3 == b.pooled_races and a.assumption_set_id == 7 and a.recomputed_at == now
    assert a.pit_loss_pooled_s == 22.0 and a.pit_loss_pooled_mad_s == 2.0 and a.pit_loss_circuit_s == 22.0
    assert b.pit_loss_circuit_s is None or np.isnan(b.pit_loss_circuit_s)
    assert a.sc_pit_factor_pooled == pytest.approx(18.0 / 22.0) and a.vsc_pit_factor_pooled == pytest.approx(22.0 / 22.0)
    empty = sim._hazard_frame(races, lap_status, samples.iloc[:0], 7, 200, now).iloc[0]
    assert empty.pit_loss_pooled_s == sim.HAZARD_FALLBACKS["pit_loss_pooled_s"] and empty.sc_pit_factor_pooled == config.SIM_SC_PIT_FACTOR_PRIOR


# --- Link 5: the §3.5 named tests -----------------------------------------------------------------

def _synthetic_rows(pit_lap, *, base=90.0, off_hard=0.5, deg=(0.10, 0.05), evo=-0.01, noise=0.5,
                    drivers=20, laps=60, seed=0):
    """20 drivers x 60 laps from the §1.1 equation: MEDIUM until pit_lap(d), then HARD. Returns an fc_all-shaped
    frame (is_representative True everywhere) plus the truth dict."""
    import pandas as pd
    rng = np.random.default_rng(seed)
    recs = []
    for d in range(drivers):
        name = f"D{d:02d}"
        bd = base + 0.05 * d
        p = int(pit_lap(d))
        for L in range(1, laps + 1):
            comp, age, stint = ("MEDIUM", L, 1) if L <= p else ("HARD", L - p, 2)
            dg = deg[0] if comp == "MEDIUM" else deg[1]
            t = bd + (off_hard if comp == "HARD" else 0.0) + dg * (age - 1) + evo * (L - 1) + rng.normal(0, noise)
            recs.append({"Driver": name, "Compound": comp, "TyreLife": age, "LapNumber": L, "Stint": stint,
                         "LapTimeSeconds": t + 1.0, "LapTimeFuelCorrected": t, "is_representative": True})
    truth = {"base": {f"D{d:02d}": base + 0.05 * d for d in range(drivers)}, "off_hard": off_hard,
             "deg": {"MEDIUM": deg[0], "HARD": deg[1]}, "evo": evo}
    return pd.DataFrame(recs), truth


def test_hungary_fit_numbers(hungary_2024):
    fc, run = _fit(hungary_2024)
    f = run(fc)
    rp = f.race_params.iloc[0]
    cp = f.compound_params.set_index("compound")
    assert rp.laps_fit == 1233 and rp.ref_compound == "HARD"
    assert 0.075 < cp.loc["HARD", "deg_s_per_lap"] < 0.095 and cp.loc["HARD", "deg_se"] < 0.005
    assert 0.06 < cp.loc["MEDIUM", "deg_s_per_lap"] < 0.08
    assert cp.loc["SOFT", "laps"] == 34 and cp.loc["SOFT", "deg_se"] > 0.02
    assert -0.008 < rp.evo_s_per_lap < 0 and 0.55 < rp.r2 < 0.70 and 0.70 < rp.resid_sd_s < 0.80
    assert rp.design_cond < 5000
    assert 19.5 < rp.pit_loss_s < 21.5 and rp.pit_loss_n >= 35 and len(rp.pit_loss_samples_s) == rp.pit_loss_n
    assert 5 < rp.start_penalty_s < 12
    assert 0.02 < cp.loc["HARD", "stint_tau_slope"] < 0.08 and cp.loc["HARD", "stint_tau_source"] == "race"
    # spec §3.5 says (0.6, 0.95) but the §1.10 in-sample diagnostic gives exactly 1.0 at Hungary (reported gap)
    assert 0.6 <= rp.stint_coverage_80 <= 1.0


def test_calibration_identity(any_session):
    fc, run = _fit(any_session)
    dp = run(fc).driver_params
    good = dp.loc[dp.simulable]
    assert len(good) >= 1
    ident = good.sim_total_fc_s - good.real_total_fc_s + (good.misfit_rep_s + good.misfit_pit_s + good.misfit_lap1_s
                                                          + good.unmodelled_s)
    assert ident.abs().max() < 1e-9
    assert (good.real_total_s - good.real_total_fc_s - good.real_fuel_s).abs().max() < 1e-6
    assert (good.laps_modelled + good.unmodelled_laps <= good.laps_timed).all()
    assert (dp.loc[~dp.simulable, "not_simulable_reason"].notna()).all()
    if int(any_session.event["RoundNumber"]) == 13 and any_session.event.year == 2024:
        assert (good.badge == "calibrated").sum() >= 12


def test_replay_matches_calibration(hungary_2024):
    from f1lab import derive
    fc, run = _fit(hungary_2024)
    f = run(fc)
    rp = f.race_params.iloc[0]
    ls = derive.lap_status(clean.annotate_laps(hungary_2024))
    status = dict(zip(ls["LapNumber"].astype(int), ls["WorstStatus"].astype(str)))
    stints = clean.stint_table(hungary_2024)
    rows, _, _ = sim.fit_rows(fc, config.SIM_MIN_COMPOUND_LAPS)
    model = sim.fit_lap_model(rows, evo_prior_sd=config.SIM_EVO_PRIOR_SD, resid_sd_guess=config.SIM_RESID_SD_GUESS,
                              min_driver_laps=config.SIM_MIN_DRIVER_LAPS)
    dc = f.driver_compound
    checked = 0
    for r in f.driver_params.loc[f.driver_params.simulable].itertuples(index=False):
        H = int(r.laps_completed)
        strat = sim.driver_strategy(stints, r.Driver, H)
        stops = [status.get(int(e), "1") for _, e in strat[:-1]]
        total, per_lap = sim.replay(strat, stops, model=model, dc=dc, deltas=list(rp.field_delta_s),
                                    start_penalty=float(rp.start_penalty_s), pit_loss_s=float(rp.pit_loss_s),
                                    sc_factor=rp.sc_pit_factor_race or config.SIM_SC_PIT_FACTOR_PRIOR,
                                    vsc_factor=rp.vsc_pit_factor_race or config.SIM_VSC_PIT_FACTOR_PRIOR,
                                    horizon=H, driver=r.Driver,
                                    start_age=sim.start_age(fc.loc[fc["Driver"].astype(str) == r.Driver]))
        assert len(per_lap) == H
        if r.laps_timed == H:                      # every lap timed: the stored total IS the replay total
            assert abs(total - r.sim_total_fc_s) < 1e-9
            checked += 1
    assert checked >= 12


def _fit_synthetic(fc):
    rows, comps, dropped = sim.fit_rows(fc, config.SIM_MIN_COMPOUND_LAPS)
    m = sim.fit_lap_model(rows, evo_prior_sd=config.SIM_EVO_PRIOR_SD, resid_sd_guess=config.SIM_RESID_SD_GUESS,
                          min_driver_laps=config.SIM_MIN_DRIVER_LAPS)
    return rows, m


def test_synthetic_recovery():
    fc, truth = _synthetic_rows(lambda d: 15 + d % 10)
    rows, m = _fit_synthetic(fc)
    assert m.drivers == sorted(truth["base"]) and set(m.compounds) == {"MEDIUM", "HARD"}
    off_true = {"MEDIUM": 0.0, "HARD": truth["off_hard"]}
    for d, b in truth["base"].items():                       # base is vs the ref compound at age 1, lap 1
        exp = b + off_true[m.ref_compound]
        assert abs(m.base(d) - exp) <= 2 * m.se[m.index[f"base:{d}"]] + 1e-12, d
    for c in m.compounds:
        assert abs(m.deg(c) - truth["deg"][c]) <= 2 * m.se[m.index[f"deg:{c}"]], c
        if c != m.ref_compound:
            assert abs(m.offset(c) - (off_true[c] - off_true[m.ref_compound])) <= 2 * m.se[m.index[f"off:{c}"]]
    assert abs(m.evo - truth["evo"]) <= 2 * m.se[m.index["evo"]]
    assert 0.4 < m.resid_sd < 0.6 and m.design_cond < 5000
    names, mean, chol = sim.param_block(m)
    k = len(names)
    L = np.array(chol).reshape(k, k)
    idx = [m.index[n] for n in names]
    assert np.abs(L @ L.T - m.cov[np.ix_(idx, idx)]).max() < 1e-9
    assert mean == [float(m.beta[i]) for i in idx] and names == m.theta_names
    # injected negative slope on MEDIUM -> deg_negative and the floored value 0
    fc2, _ = _synthetic_rows(lambda d: 15 + d % 10, deg=(-0.05, 0.05), seed=1)
    rows2, m2 = _fit_synthetic(fc2)
    ct, warns = sim.compound_table(rows2, m2)
    ct = ct.set_index("compound")
    assert bool(ct.loc["MEDIUM", "deg_negative"]) and ct.loc["MEDIUM", "deg_s_per_lap"] == 0.0
    assert ct.loc["MEDIUM", "deg_raw_s_per_lap"] < 0 and not bool(ct.loc["HARD", "deg_negative"])
    assert any("MEDIUM degradation" in w for w in warns)


def test_ridge_collinear():
    fc, truth = _synthetic_rows(lambda d: 20, evo=-0.004, seed=2)
    rows, m = _fit_synthetic(fc)
    X, _ = sim._design(rows, m.drivers, m.compounds, m.ref_compound)
    assert np.linalg.cond(X) > 1e12 and m.design_cond > 1e12          # plain OLS: age and lap collinear
    for c in m.compounds:
        assert np.isfinite(m.deg(c)) and abs(m.deg(c) - truth["deg"][c]) < 0.01, c
    assert np.isfinite(m.evo) and abs(m.evo) < 0.005
    assert np.all(np.isfinite(m.se)) and np.all(np.isfinite(m.cov))


def test_miami_soft_dropped(miami_2025, hungary_2024, monkeypatch):
    """§3.5 expects SOFT dropped at Miami, but the cached 2025 R6 has no SOFT lap at all (laps 1-24 carry the
    literal 'nan' compound, so most drivers are 'stint data incomplete'). The drop mechanism is exercised on
    Hungary by raising SIM_MIN_COMPOUND_LAPS above SOFT's 34 fit rows."""
    fc, run = _fit(miami_2025)
    f = run(fc)
    assert list(f.compound_params["compound"]) == ["HARD", "MEDIUM"] and f.warnings == []
    dp = f.driver_params
    assert dp.simulable.sum() >= 4
    assert set(dp.loc[~dp.simulable, "not_simulable_reason"]) == {"stint data incomplete"}
    monkeypatch.setattr(config, "SIM_MIN_COMPOUND_LAPS", 40)
    fc, run = _fit(hungary_2024)
    f = run(fc)
    assert "SOFT" not in set(f.compound_params["compound"]) and list(f.race_params.iloc[0].param_names) == \
        ["off:MEDIUM", "deg:HARD", "deg:MEDIUM", "evo"]
    assert f.warnings[0] == "sim: SOFT not parameterised (34 fit rows < 40)"
    stints = clean.stint_table(hungary_2024)
    ran_soft = set(stints.loc[stints["Compound"].astype(str).str.upper() == "SOFT", "Driver"].astype(str))
    dp = f.driver_params.set_index("Driver")
    assert ran_soft and ran_soft <= set(dp.index)
    for d in dp.index:
        if d in ran_soft:
            assert not bool(dp.loc[d, "simulable"]) and "SOFT" in str(dp.loc[d, "not_simulable_reason"]), d
        else:
            assert bool(dp.loc[d, "simulable"]), d
    assert dp.simulable.sum() >= 6 and "SOFT" not in set(f.driver_compound["compound"])


def test_r1_2025_rain():
    """§3.5 names this test_r1_2026_rain, but the rain race of §1.12 is 2025 R1 (Australia); r1_2026 fits (see
    test_fit_race_r1_2026_floor_and_not_simulable). The cached 2025 R1 is loaded here directly."""
    from tests.conftest import _load
    s = _load(2025, 1)
    fc, run = _fit(s)
    with pytest.raises(sim.SimNotEstimable) as ei:
        run(fc)
    assert str(ei.value).startswith("rain race")
    assert "representative laps on INTERMEDIATE/WET" in str(ei.value)


def test_pit_factor_classification(hungary_race):
    r = hungary_race
    ex = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds)
    laps_in = sorted(ex["lap_in"].unique())
    sc_lap, vsc_lap = laps_in[0], laps_in[-1]
    ls = r["ls"].copy()
    ls.loc[ls["LapNumber"] == sc_lap, "WorstStatus"] = "4"
    ls.loc[ls["LapNumber"] == vsc_lap, "WorstStatus"] = "6"
    ex2 = sim.pit_excess(r["fc"], r["pits"], ls, r["m"], r["dc"], r["deltas"], r["m"].compounds)
    assert len(ex2) == len(ex) and np.allclose(ex2["excess_s"], ex["excess_s"])   # status never changes excess
    assert set(ex2.loc[ex2["lap_in"] == sc_lap, "status_in"]) == {"4"}
    assert set(ex2.loc[ex2["lap_in"] == vsc_lap, "status_in"]) == {"6"}
    n_sc = int((ex2["lap_in"] == sc_lap).sum()); n_vsc = int((ex2["lap_in"] == vsc_lap).sum())
    assert n_sc >= 1 and n_vsc >= 1
    pl = sim.pit_loss(ex2, min_green=config.SIM_MIN_GREEN_STOPS, min_sc=config.SIM_MIN_SC_STOPS,
                      samples_max=config.SIM_PIT_SAMPLES_MAX)
    sc_vals = sorted(ex2.loc[ex2["lap_in"] == sc_lap, "excess_s"].round(6))
    vsc_vals = sorted(ex2.loc[ex2["lap_in"] == vsc_lap, "excess_s"].round(6))
    assert sorted(np.round(pl["sc_pit_samples_s"], 6)) == sc_vals
    assert sorted(np.round(pl["vsc_pit_samples_s"], 6)) == vsc_vals
    # green = status_in AND status_out in {'1','2'} (§1.6): a stop whose out-lap is the new SC lap is neither
    green = ex2.loc[ex2["status_in"].isin(["1", "2"]) & ex2["status_out"].isin(["1", "2"]), "excess_s"]
    assert pl["pit_loss_n"] == len(green) == len(pl["pit_loss_samples_s"]) <= len(ex2) - n_sc - n_vsc
    assert pl["pit_loss_s"] == pytest.approx(float(np.median(green)))
    assert set(np.round(pl["pit_loss_samples_s"], 6)) == set(np.round(green, 6))
    assert n_sc < config.SIM_MIN_SC_STOPS and pl["sc_pit_factor_race"] is None
    assert n_vsc < config.SIM_MIN_SC_STOPS and pl["vsc_pit_factor_race"] is None
    # with the threshold lowered the factors are median(samples) / pit_loss_s
    pl2 = sim.pit_loss(ex2, min_green=config.SIM_MIN_GREEN_STOPS, min_sc=1, samples_max=config.SIM_PIT_SAMPLES_MAX)
    assert pl2["sc_pit_factor_race"] == pytest.approx(float(np.median(sc_vals)) / pl2["pit_loss_s"], rel=1e-5)
    assert pl2["vsc_pit_factor_race"] == pytest.approx(float(np.median(vsc_vals)) / pl2["pit_loss_s"], rel=1e-5)


# --- §3.6 golden fixture ---------------------------------------------------------------------------

GOLDEN_PATH = __import__("pathlib").Path(__file__).resolve().parent / "fixtures" / "sim_golden.json"


def _golden_model():
    """The §3.6 synthetic model: (LapModel, dc dict, SimModel-shaped dict, race inputs)."""
    import pandas as pd
    names = ["base:D1", "off:HARD", "deg:MEDIUM", "deg:HARD", "evo"]
    beta = np.array([90.0, 0.5, 0.10, 0.05, -0.01])
    se = np.array([0.1, 0.05, 0.003, 0.002, 0.001])
    model = sim.LapModel(names=names, beta=beta, se=se, cov=np.diag(se ** 2), resid=pd.Series(dtype=float),
                         r2=0.9, resid_sd=0.5, resid_mad=0.4, design_cond=10.0, ref_compound="MEDIUM",
                         drivers=["D1"], compounds=["MEDIUM", "HARD"], index={n: i for i, n in enumerate(names)})
    dc = {"MEDIUM": 0.1, "HARD": 0.0}
    deltas = [0.0, 0.0, 0.0, 30.0, 30.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    status = ["G", "G", "G", "S", "S", "G", "G", "G", "G", "G"]
    race = {"totalLaps": 10, "refCompound": "MEDIUM", "lapsFit": 10, "driversFit": 1, "r2": 0.9, "residSdS": 0.5,
            "residMadS": 0.4, "designCond": 10.0, "evoSPerLap": -0.01, "evoSe": 0.001,
            "paramNames": ["off:HARD", "deg:MEDIUM", "deg:HARD", "evo"], "paramMean": [0.5, 0.10, 0.05, -0.01],
            "paramChol": [float(v) for v in np.diag([0.05, 0.003, 0.002, 0.001]).ravel()],
            "fieldDeltaS": deltas, "lapStatus": status, "startPenaltyS": 7.0,
            "pitLoss": {"medianS": 20.0, "madS": 1.0, "n": 5, "samplesS": [19.0, 19.5, 20.0, 20.5, 21.0],
                        "source": "race"},
            "scPitFactor": 0.86, "scPitFactorSource": "pooled", "vscPitFactor": 0.95, "vscPitFactorSource": "pooled",
            "nScLaps": 2, "nVscLaps": 0, "nRedLaps": 0}
    comp = lambda c, laps, off, deg: {  # noqa: E731
        "compound": c, "compoundColour": "#ffd200" if c == "MEDIUM" else "#f0f0ec", "laps": laps, "ageMax": 6,
        "offsetS": off, "offsetSe": 0.0 if off == 0 else 0.05, "degSPerLap": deg, "degSe": 0.003 if c == "MEDIUM" else 0.002,
        "degRawSPerLap": deg, "degNegative": False, "stintTauLevelS": 0.25, "stintTauSlope": 0.04,
        "stintTauSource": "prior", "stintsUsed": 1}
    actual = [{"compound": "MEDIUM", "endLap": 4}, {"compound": "HARD", "endLap": 10}]
    driver = {"driverId": "d1", "code": "D1", "fullName": "Driver One", "lineStyle": "solid", "teamId": "t1",
              "teamName": "Team One", "teamColour": "#3671c6", "position": 1, "lapsFit": 10, "baseS": 90.0,
              "baseSe": 0.1, "noiseSdS": 0.3, "lapsCompleted": 10,
              "dc": {"MEDIUM": {"dcOffsetS": 0.1, "dcSe": 0.05, "laps": 4}, "HARD": {"dcOffsetS": 0.0, "dcSe": 0.05, "laps": 6}},
              "actual": actual, "actualStartAge": 1, "actualPitLaps": [4], "simulable": True,
              "notSimulableReason": None, "calibration": None}
    sm = {"sessionId": 0, "assumptionSetId": 0, "race": race,
          "compounds": [comp("MEDIUM", 4, 0.0, 0.10), comp("HARD", 6, 0.5, 0.05)], "hazard": None,
          "drivers": [driver], "unavailable": [],
          "constants": {"draws": config.SIM_DRAWS, "seed": config.SIM_SEED, "kDc": config.SIM_K_DC,
                        "degFloor": config.SIM_DEG_FLOOR, "extrapolationLaps": config.SIM_EXTRAPOLATION_LAPS,
                        "noiseTDf": config.SIM_NOISE_T_DF, "minStintLaps": 2, "maxStops": 4}}
    return model, dc, sm, dict(deltas=deltas, status=status, start=7.0, pit=20.0, sc=0.86, vsc=0.95, horizon=10)


def test_write_golden():
    """Writes tests/fixtures/sim_golden.json (§3.6) on first run; afterwards asserts the committed file is byte-equal,
    so a change to sim.replay is a deliberate change of the fixture. web/lib/sim/engine.test.ts reads it."""
    import json
    model, dc, sm, inp = _golden_model()
    code = {"G": "1", "S": "4", "V": "6", "R": "5"}
    strategies = {"actual": [("MEDIUM", 4), ("HARD", 10)], "edited": [("MEDIUM", 3), ("HARD", 7), ("MEDIUM", 10)]}
    out = {}
    for key, strat in strategies.items():
        stops = [code[inp["status"][e - 1]] for _, e in strat[:-1]]
        total, per_lap = sim.replay(strat, stops, model=model, dc=dc, deltas=inp["deltas"], start_penalty=inp["start"],
                                    pit_loss_s=inp["pit"], sc_factor=inp["sc"], vsc_factor=inp["vsc"],
                                    horizon=inp["horizon"], driver="D1")
        out[key] = {"total": total, "per_lap": per_lap}
    a, e = out["actual"], out["edited"]
    # hand-checked laps: lap 1 = base + dc + start; lap 4 = ... + deg*3 + evo*3 + delta + pit_loss*sc_factor
    assert a["per_lap"][0] == pytest.approx(90.0 + 0.1 + 7.0, abs=1e-12)
    assert a["per_lap"][3] == pytest.approx(90.1 + 0.3 - 0.03 + 30.0 + 20.0 * 0.86, abs=1e-12)
    assert a["per_lap"][4] == pytest.approx(90.0 + 0.5 - 0.04 + 30.0, abs=1e-12)          # HARD out-lap, age 1
    assert e["per_lap"][2] == pytest.approx(90.1 + 0.2 - 0.02 + 20.0, abs=1e-12)          # green stop on lap 3
    assert e["per_lap"][6] == pytest.approx(90.5 + 0.05 * 3 - 0.06 + 20.0, abs=1e-12)     # green stop on lap 7
    assert len(a["per_lap"]) == len(e["per_lap"]) == 10 and a["total"] == sum(a["per_lap"])
    sm["drivers"][0]["calibration"] = {
        "lapsCompleted": 10, "lapsTimed": 10, "lapsModelled": 7, "unmodelledLaps": 0, "stops": 1,
        "realTotalS": a["total"] + 10.0, "realTotalFcS": a["total"], "realFuelS": 10.0, "simTotalFcS": a["total"],
        "misfitRepS": 0.0, "misfitPitS": 0.0, "misfitLap1S": 0.0, "unmodelledS": 0.0, "badge": "calibrated"}
    golden = {"model": sm, "actual": sm["drivers"][0]["actual"],
              "edited": [{"compound": c, "endLap": n} for c, n in strategies["edited"]],
              "replay": out, "delta": e["total"] - a["total"]}
    text = json.dumps(golden, sort_keys=True, indent=1) + "\n"
    if not GOLDEN_PATH.exists():
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(text)
    assert GOLDEN_PATH.read_text() == text, "sim.replay output changed: review and re-commit tests/fixtures/sim_golden.json"


def test_pit_excess_skips_unknown_delta(hungary_race):
    """A stop is unusable when field_delta_cars < SIM_MIN_CARS_FOR_DELTA on its in- or out-lap (2024 Qatar laps 35-38:
    every car pitted under SC, delta 0 by construction, the SC excess swallowed the whole slowdown -> factor 3.6)."""
    r = hungary_race
    ex = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds)
    same = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds,
                          delta_cars=r["n_cars"])
    assert len(same) == len(ex) and np.allclose(same["excess_s"], ex["excess_s"])   # Hungary: every delta known
    lap = int(ex["lap_in"].mode().iloc[0])
    cars = list(r["n_cars"]); cars[lap - 1] = config.SIM_MIN_CARS_FOR_DELTA - 1
    fewer = sim.pit_excess(r["fc"], r["pits"], r["ls"], r["m"], r["dc"], r["deltas"], r["m"].compounds, delta_cars=cars)
    dropped = int((ex["lap_in"] == lap).sum()) + int(((ex["lap_in"] + 1) == lap).sum())
    assert dropped >= 1 and len(fewer) == len(ex) - dropped and not (fewer["lap_in"] == lap).any()
