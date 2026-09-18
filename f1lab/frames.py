"""Turning f1lab's DataFrames into the rows the database stores.

This module is the Python half of the schema contract (docs/SPEC.md §1). Two
things live here and nowhere else:

- ``EXPECTED_COLUMNS`` — every column of every table Python writes, in DDL order.
  ``db.assert_schema`` compares it with the live ``information_schema`` before
  any write; the Drizzle schema on the web side is transcribed from the same §1.
- ``RENAMES`` — the single greppable map from f1lab DataFrame column names to
  database column names.

``build_race_frames`` runs exactly the notebook's pipeline (``annotate_laps`` /
``clean_laps`` → ``fuel_correct(lap_km=None)`` → ``pace_ranking`` → …) so every
stored number equals the notebook's, wraps each analytic individually so one
failing analytic never fails a session, and applies the casting rules of §0.3:
the string ``'nan'`` → NULL, NaN/NaT → NULL, integer-valued floats → int,
timedeltas → seconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Iterator, Sequence

import numpy as np
import pandas as pd

from . import clean, colours, derive, moments, pace, sim

# Database-wide constants moments.build_optimal_stint needs but cannot read itself:
# build_race_frames has no connection. ingest.run_season refreshes this once per run
# (ingest.load_pooled_stint) and an empty dict is a valid input meaning "session-only".
# Keys (MODE1_SPEC §4.4):
#   "slope_by_compound": {COMPOUND: {"median": float, "q1": float, "q3": float, "n_fits": int}}
#   "pit_loss_by_circuit": {circuit_key: float}   -- sim_circuit_hazard.pit_loss_circuit_s
#   "pit_loss_pooled_s": float | None             -- sim_circuit_hazard.pit_loss_pooled_s
POOLED_STINT: dict = {}

# ---------------------------------------------------------------------------
# The contract: every table Python writes, every column, in DDL order
# ---------------------------------------------------------------------------

# Column kinds drive the casting in cast_frame(): int | float | real | bool | text |
# timestamptz | date | jsonb | text[] | float[] | int[] | serial. Tables written only via INSERT/UPDATE
# (dimension, provenance, season aggregates) are listed too — assert_schema checks them all.
TABLE_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "assumption_sets": [
        ("assumption_set_id", "serial"), ("hash", "text"), ("params", "jsonb"), ("created_at", "timestamptz"),
    ],
    "seasons": [
        ("year", "int"), ("scheduled_rounds", "int"), ("ingested_rounds", "int"),
        ("standings_after_round", "int"), ("assumption_set_id", "int"), ("mixed_assumption_sets", "bool"),
        ("has_sprint_results", "bool"), ("recomputed_at", "timestamptz"),
    ],
    "circuits": [
        ("circuit_key", "int"), ("short_name", "text"), ("location", "text"), ("country", "text"),
        ("lap_km", "float"),
    ],
    "events": [
        ("year", "int"), ("round", "int"), ("event_name", "text"), ("official_name", "text"),
        ("location", "text"), ("country", "text"), ("event_format", "text"), ("event_date", "date"),
        ("circuit_key", "int"),
    ],
    "teams": [("team_id", "text"), ("latest_name", "text")],
    "drivers": [
        ("driver_id", "text"), ("latest_code", "text"), ("latest_number", "text"), ("first_name", "text"),
        ("last_name", "text"), ("full_name", "text"), ("country_code", "text"), ("headshot_url", "text"),
    ],
    "sessions": [
        ("session_id", "serial"), ("year", "int"), ("round", "int"), ("kind", "text"), ("name", "text"),
        ("start_utc", "timestamptz"), ("total_laps", "int"), ("winner_driver_id", "text"),
        ("fastest_pace_driver_id", "text"),
    ],
    "session_teams": [
        ("session_id", "int"), ("team_id", "text"), ("team_name", "text"), ("colour", "text"),
        ("colour_source", "text"),
    ],
    "session_entries": [
        ("session_id", "int"), ("driver_id", "text"), ("team_id", "text"), ("code", "text"),
        ("driver_number", "text"), ("line_style", "text"), ("line_style_source", "text"),
    ],
    "compound_colours": [("session_id", "int"), ("compound", "text"), ("colour", "text")],
    "results": [
        ("session_id", "int"), ("driver_id", "text"), ("position", "int"), ("classified_position", "text"),
        ("grid_position", "int"), ("points", "float"), ("status", "text"), ("laps_completed", "int"),
        ("result_time_s", "float"),
    ],
    "laps": [
        ("session_id", "int"), ("driver_id", "text"), ("lap_number", "int"),
        ("stint", "int"), ("compound", "text"), ("tyre_life", "int"), ("fresh_tyre", "bool"),
        ("position", "int"), ("track_status", "text"), ("lap_time_s", "float"), ("session_time_s", "float"),
        ("lap_start_time_s", "float"), ("sector1_s", "float"), ("sector2_s", "float"), ("sector3_s", "float"),
        ("speed_i1", "real"), ("speed_i2", "real"), ("speed_fl", "real"), ("speed_st", "real"),
        ("pit_in_time_s", "float"), ("pit_out_time_s", "float"),
        ("is_accurate", "bool"), ("deleted", "bool"), ("deleted_reason", "text"), ("fastf1_generated", "bool"),
        ("is_personal_best", "bool"),
        ("excl_no_time", "bool"), ("excl_in_lap", "bool"), ("excl_out_lap", "bool"), ("excl_not_green", "bool"),
        ("excl_inaccurate", "bool"), ("excl_deleted", "bool"), ("passes_rules", "bool"), ("is_outlier", "bool"),
        ("is_representative", "bool"),
        ("fuel_kg", "float"), ("fuel_penalty_s", "float"), ("lap_time_fc_s", "float"),
        ("gap_to_leader_s", "float"), ("interval_s", "float"), ("leader_driver_id", "text"),
        # QUALI_SPEC §3.2 (D1). Five nullable columns appended for Q/SQ laps; NULL on every
        # race and sprint lap, so `quali_segment IS NOT NULL` identifies a qualifying lap
        # with no join. `laps` is NO LONGER race-only: every query against it that is not
        # already scoped to a single session_id must constrain sessions.kind (§3.1).
        # (§3.7 writes segment_source's kind as "str"; this module's kind vocabulary calls a
        # text column "text" -- "str" would fall through cast_frame's pass-through branch.)
        ("quali_segment", "int"), ("segment_source", "text"), ("is_push_lap", "bool"),
        ("excl_disallowed", "bool"), ("deleted_inferred", "bool"),
    ],
    "lap_status": [
        ("session_id", "int"), ("lap_number", "int"), ("is_green", "bool"), ("worst_status", "text"),
        ("drivers_affected", "int"), ("drivers_on_lap", "int"),
    ],
    "pit_stops": [
        ("session_id", "int"), ("driver_id", "text"), ("stop_number", "int"), ("lap_in", "int"),
        ("lap_out", "int"), ("pit_in_time_s", "float"), ("pit_out_time_s", "float"), ("pit_lane_s", "float"),
        ("compound_in", "text"), ("compound_out", "text"),
    ],
    "stints": [
        ("session_id", "int"), ("driver_id", "text"), ("stint", "int"), ("compound", "text"),
        ("start_lap", "int"), ("end_lap", "int"), ("laps", "int"),
    ],
    "lap_exclusion_report": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("rule_order", "int"), ("rule", "text"),
        ("laps_hit", "int"), ("pct_of_all", "float"),
    ],
    "pace_ranking": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"), ("rank", "int"),
        ("team_id", "text"), ("clean_laps", "int"), ("median_pace_s", "float"), ("best_pace_s", "float"),
        ("iqr_s", "float"), ("gap_s", "float"), ("gap_pct", "float"),
        ("box_whisker_lo_s", "float"), ("box_q1_s", "float"), ("box_q3_s", "float"),
        ("box_whisker_hi_s", "float"), ("box_mean_s", "float"),
        ("sens_rank_lo", "int"), ("sens_rank_hi", "int"),
    ],
    "degradation_fits": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"), ("stint", "int"),
        ("team_id", "text"), ("compound", "text"), ("laps", "int"), ("deg_s_per_lap", "float"),
        ("deg_std_err", "float"), ("r2", "float"), ("fresh_pace_s", "float"),
    ],
    "compound_degradation": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("compound", "text"), ("laps", "int"),
        ("slope_s_per_lap", "float"), ("intercept_s", "float"), ("x_min", "int"), ("x_max", "int"),
    ],
    "teammate_deltas": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("team_id", "text"), ("faster_driver_id", "text"),
        ("slower_driver_id", "text"), ("gap_s", "float"), ("gap_pct", "float"), ("laps_compared", "int"),
    ],
    "fuel_sensitivity": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("fuel_effect_s_per_kg", "float"), ("rank", "int"), ("gap_s", "float"),
    ],
    "weather_samples": [
        ("session_id", "int"), ("sample_idx", "int"), ("session_time_s", "float"), ("air_temp", "real"),
        ("humidity", "real"), ("pressure", "real"), ("rainfall", "bool"), ("track_temp", "real"),
        ("wind_direction", "int"), ("wind_speed", "real"),
    ],
    "track_status_events": [
        ("session_id", "int"), ("event_idx", "int"), ("session_time_s", "float"), ("status", "text"),
        ("message", "text"),
    ],
    "driver_standings": [
        ("year", "int"), ("after_round", "int"), ("driver_id", "text"), ("team_id", "text"),
        ("team_name", "text"), ("team_colour", "text"), ("position", "int"), ("points", "float"),
        ("sprint_points", "float"), ("wins", "int"), ("podiums", "int"), ("races", "int"),
    ],
    "constructor_standings": [
        ("year", "int"), ("after_round", "int"), ("team_id", "text"), ("team_name", "text"),
        ("team_colour", "text"), ("position", "int"), ("points", "float"), ("wins", "int"), ("podiums", "int"),
    ],
    "driver_season_summary": [
        ("year", "int"), ("driver_id", "text"), ("assumption_set_id", "int"), ("team_id", "text"),
        ("team_name", "text"), ("team_colour", "text"), ("races", "int"), ("points", "float"), ("wins", "int"),
        ("podiums", "int"), ("dnfs", "int"), ("championship_position", "int"), ("best_finish", "int"),
        ("avg_finish", "float"), ("avg_grid", "float"), ("mean_pace_rank", "float"), ("races_ranked", "int"),
    ],
    "teammate_h2h": [
        ("year", "int"), ("driver_id", "text"), ("teammate_driver_id", "text"), ("assumption_set_id", "int"),
        ("team_id", "text"), ("races_paired", "int"), ("pace_wins", "int"), ("pace_losses", "int"),
        ("mean_signed_gap_pct", "float"), ("median_signed_gap_pct", "float"), ("finish_wins", "int"),
        ("finish_losses", "int"), ("grid_wins", "int"), ("grid_losses", "int"), ("points_for", "float"),
        ("points_against", "float"),
    ],
    "ingest_runs": [
        ("run_id", "serial"), ("started_at", "timestamptz"), ("finished_at", "timestamptz"), ("status", "text"),
        ("cli_args", "jsonb"), ("f1lab_version", "text"), ("fastf1_version", "text"), ("python_version", "text"),
        ("assumption_set_id", "int"), ("hostname", "text"), ("sessions_attempted", "int"),
        ("sessions_ok", "int"), ("sessions_failed", "int"), ("error", "text"),
    ],
    "session_ingests": [
        ("session_id", "int"), ("run_id", "int"), ("ingested_at", "timestamptz"), ("status", "text"),
        ("analytics_status", "jsonb"), ("warnings", "text[]"), ("error", "text"), ("raw_laps", "int"),
        ("clean_laps", "int"), ("total_laps", "int"), ("assumption_set_id", "int"), ("lap_km_used", "float"),
        ("fuel_scale", "float"), ("f1lab_version", "text"), ("fastf1_version", "text"),
    ],
    # --- strategy simulator (SIM_SPEC §2.1/§2.3); arrays are plain Python lists ---
    "sim_race_params": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("total_laps", "int"),
        ("ref_compound", "text"), ("laps_fit", "int"), ("drivers_fit", "int"), ("r2", "float"), ("resid_sd_s", "float"),
        ("resid_mad_s", "float"), ("design_cond", "float"), ("evo_s_per_lap", "float"), ("evo_se", "float"),
        ("param_names", "text[]"), ("param_mean", "float[]"), ("param_chol", "float[]"), ("field_delta_s", "float[]"),
        ("field_delta_cars", "int[]"), ("start_penalty_s", "float"), ("pit_loss_s", "float"), ("pit_loss_mad_s", "float"),
        ("pit_loss_n", "int"), ("pit_loss_samples_s", "float[]"), ("sc_pit_samples_s", "float[]"),
        ("vsc_pit_samples_s", "float[]"), ("sc_pit_factor_race", "float"), ("vsc_pit_factor_race", "float"),
        ("stint_coverage_80", "float"), ("n_sc_laps", "int"), ("n_vsc_laps", "int"), ("n_red_laps", "int"),
    ],
    "sim_compound_params": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("compound", "text"),
        ("laps", "int"), ("age_max", "int"), ("offset_s", "float"), ("offset_se", "float"), ("deg_raw_s_per_lap", "float"),
        ("deg_s_per_lap", "float"), ("deg_se", "float"), ("deg_negative", "bool"), ("stint_tau_level_s", "float"),
        ("stint_tau_slope", "float"), ("stint_tau_source", "text"), ("stints_used", "int"),
    ],
    "sim_driver_params": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("laps_fit", "int"), ("base_s", "float"), ("base_se", "float"), ("noise_sd_s", "float"), ("laps_completed", "int"),
        ("laps_timed", "int"), ("laps_modelled", "int"), ("unmodelled_laps", "int"), ("stops", "int"), ("simulable", "bool"),
        ("not_simulable_reason", "text"), ("real_total_s", "float"), ("real_total_fc_s", "float"), ("real_fuel_s", "float"),
        ("sim_total_fc_s", "float"), ("misfit_rep_s", "float"), ("misfit_pit_s", "float"), ("misfit_lap1_s", "float"),
        ("unmodelled_s", "float"), ("badge", "text"),
    ],
    "sim_driver_compound": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("compound", "text"), ("laps", "int"), ("dc_offset_s", "float"), ("dc_se", "float"),
    ],
    "sim_circuit_hazard": [
        ("circuit_key", "int"), ("assumption_set_id", "int"), ("recomputed_at", "timestamptz"),
        ("races", "int"), ("laps", "int"), ("sc_episodes", "int"), ("vsc_episodes", "int"), ("sc_hazard", "float"),
        ("vsc_hazard", "float"), ("pit_loss_circuit_s", "float"), ("pooled_races", "int"), ("sc_hazard_pooled", "float"),
        ("vsc_hazard_pooled", "float"), ("sc_start_p", "float"), ("vsc_start_p", "float"), ("sc_dur_mean", "float"),
        ("vsc_dur_mean", "float"), ("pit_loss_pooled_s", "float"), ("pit_loss_pooled_mad_s", "float"),
        ("sc_pit_factor_pooled", "float"), ("vsc_pit_factor_pooled", "float"),
    ],

    # --- v1.2 companion (MODE1_SPEC §5) -------------------------------------------------------
    # Twelve of the fourteen are cross-race artifacts and are not per-session; they are listed
    # here anyway (the precedent is driver_standings / sim_circuit_hazard) because --check-schema
    # is the only defence against the Python and Drizzle column names drifting apart.
    "wp_run": [
        ("wp_run_id", "serial"), ("assumption_set_id", "int"), ("model_version", "text"),
        ("sklearn_version", "text"), ("n_train_races", "int"), ("n_rows", "int"), ("n_folds", "int"),
        ("calibration", "text"), ("tuning_scope", "text"), ("brier_oof", "float"),
        ("brier_baseline_pos", "float"), ("brier_baseline_lead", "float"), ("skill_ok", "bool"),
        ("is_current", "bool"), ("trained_at", "timestamptz"),
    ],
    "wp_model_artifact": [
        ("assumption_set_id", "int"), ("fold_index", "int"), ("model_version", "text"),
        ("sklearn_version", "text"), ("feature_names", "jsonb"), ("n_train_races", "int"),
        ("artifact_sha256", "text"), ("artifact", "bytea"), ("trained_at", "timestamptz"),
    ],
    "wp_lap_probability": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("lap_number", "int"), ("pred_kind", "text"), ("fold_index", "int"),
        ("p_win_raw", "float"), ("p_win", "float"), ("degraded", "bool"),
    ],
    "wp_swing": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("lap_number", "int"),
        ("swing_mass", "float"), ("cause", "text"), ("mover_driver_id", "text"),
        ("mover_p_before", "float"), ("mover_p_after", "float"), ("rank_in_race", "int"),
    ],
    "wp_metrics": [
        ("assumption_set_id", "int"), ("scope", "text"), ("variant", "text"), ("n_rows", "int"),
        ("n_races", "int"), ("brier", "float"), ("log_loss", "float"),
        ("brier_baseline_pos", "float"), ("brier_baseline_lead", "float"),
        ("brier_fold_min", "float"), ("brier_fold_median", "float"), ("brier_fold_max", "float"),
        ("note", "text"),
    ],
    "wp_reliability_bin": [
        ("assumption_set_id", "int"), ("scope", "text"), ("variant", "text"), ("bin_index", "int"),
        ("bin_lo", "float"), ("bin_hi", "float"), ("n_rows", "int"), ("n_wins", "int"),
        ("mean_predicted", "float"), ("observed_rate", "float"), ("observed_lo", "float"),
        ("observed_hi", "float"),
    ],
    "title_odds": [
        ("year", "int"), ("after_round", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("p_title", "float"), ("p_title_lo", "float"), ("p_title_hi", "float"), ("mc_stderr", "float"),
        ("p_top3", "float"), ("expected_points", "float"), ("points_p10", "float"),
        ("points_p90", "float"), ("theta", "float"), ("dnf_rate", "float"),
        ("is_shrunk_to_prior", "bool"), ("draws", "int"),
    ],
    "title_clinch": [
        ("year", "int"), ("after_round", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("points_now", "int"), ("max_available", "int"), ("max_possible_total", "int"),
        ("leader_points", "int"), ("is_eliminated", "bool"), ("eliminated_at_round", "int"),
        ("has_clinched", "bool"), ("clinch_margin_needed", "int"), ("swing_needed", "int"),
        ("clinch_position", "int"), ("earliest_clinch_round", "int"), ("next_round_has_sprint", "bool"),
        ("race_points_max", "int"), ("sprint_points_max", "int"), ("has_fastest_lap_bonus", "bool"),
    ],
    "circuit_odi": [
        ("circuit_key", "int"), ("assumption_set_id", "int"), ("races", "int"), ("passes", "int"),
        ("opportunities", "int"), ("raw_pass_rate", "float"), ("resid_mean", "float"),
        ("resid_shrunk", "float"), ("adj_pass_rate", "float"), ("odi", "float"),
        ("odi_lo", "float"), ("odi_hi", "float"),
    ],
    "preview_round": [
        ("year", "int"), ("round", "int"), ("assumption_set_id", "int"), ("circuit_key", "int"),
        ("circuit_match", "text"), ("circuit_races", "int"), ("expected_total_laps", "int"),
        ("p_safety_car", "float"), ("sc_hazard_shrunk", "float"), ("p_vsc", "float"),
        ("expected_pit_loss_s", "float"), ("pit_loss_band_s", "float"), ("odi", "float"),
        ("odi_lo", "float"), ("odi_hi", "float"), ("backtest_spearman", "float"),
        ("backtest_grid_spearman", "float"), ("backtest_coverage", "float"),
        ("backtest_races", "int"), ("loco_brier", "float"), ("computed_at", "timestamptz"),
    ],
    "preview_finish_order": [
        ("year", "int"), ("round", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("expected_position", "float"), ("pos_p10", "int"), ("pos_p90", "int"), ("p_win", "float"),
        ("p_podium", "float"), ("p_points", "float"), ("theta", "float"), ("dnf_rate", "float"),
        ("draws", "int"),
    ],
    "preview_backtest": [
        ("year", "int"), ("round", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("pred_kind", "text"), ("expected_position", "float"), ("pos_p10", "int"), ("pos_p90", "int"),
        ("actual_position", "int"), ("inside_interval", "bool"),
    ],
    # The only two companion tables written by build_race_frames (§5.6).
    "race_moment": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("moment_idx", "int"),
        ("moment_type", "text"), ("lap_number", "int"), ("driver_id", "text"),
        ("other_driver_id", "text"), ("magnitude", "float"), ("magnitude_unit", "text"),
        ("severity", "float"), ("confidence", "text"), ("detail", "text"),
    ],
    "optimal_stint": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("compound", "text"), ("n_fits", "int"),
        ("slope_s_per_lap", "float"), ("slope_q1", "float"), ("slope_q3", "float"),
        ("pit_loss_s", "float"), ("pit_loss_source", "text"), ("optimal_laps", "float"),
        ("optimal_laps_lo", "float"), ("optimal_laps_hi", "float"), ("actual_median_laps", "float"),
        ("slope_source", "text"),
    ],
    # --- MODE2_SPEC §6.3: the twelve v1.3 decomposition tables, in DDL order. ---
    # None is added to RACE_TABLE_ORDER / SPRINT_TABLE_ORDER / ANALYTICS (§6.1, §6.5):
    # they are cross-race artifacts rebuilt wholesale at run-end. text[] is tagged
    # "text[]", never "jsonb" -- mis-tagging makes COPY fail at run-end, not here.
    "mode2_fit_run": [
        ("fit_id", "serial"), ("assumption_set_id", "int"), ("model_version", "text"),
        ("spec", "text"), ("n_rows", "int"), ("n_rows_excluded", "int"), ("n_drivers", "int"),
        ("n_cells", "int"), ("n_sessions", "int"), ("n_components", "int"),
        ("tau_driver", "float"), ("tau_car", "float"), ("tau_slope", "float"),
        ("sigma_resid", "float"), ("tau_driver_lo", "float"), ("tau_driver_hi", "float"),
        ("tau_car_lo", "float"), ("tau_car_hi", "float"), ("sd_ratio", "float"),
        ("sd_ratio_lo", "float"), ("sd_ratio_hi", "float"), ("tau_interaction", "float"),
        ("sigma_spec", "float"), ("ci_level", "float"), ("bootstrap_reps", "int"),
        ("converged", "bool"), ("shrinkage_ok", "bool"), ("interval_dir_ok", "bool"),
        ("fit_seconds", "float"), ("bootstrap_seconds", "float"), ("is_current", "bool"),
        ("fitted_at", "timestamptz"),
        # GAPFILL_SPEC §2.2 (migration 0009): three nullable correlation diagnostics written
        # by decomp after the one_lap_pace fit. Appended in DDL order after fitted_at. All
        # three are legitimately NULL on every pre-v1.8 fit row, which is why §1.6's
        # retirement gate must test `>= 0.95` rather than `NOT < 0.95`.
        ("corr_one_lap_grid", "float"), ("corr_one_lap_grid_ex_islands", "float"),
        ("corr_one_lap_race", "float"),
    ],
    # GAPFILL_SPEC §2.2 / §1.3: per-row audit of the qualifying fit. One row per candidate
    # segment-1 driver-session, included or not, with the reason. y_pp is NULL on every
    # excluded row by design; best_s is preserved on all of them so an auditor can recompute.
    # Order is the live DDL order and must equal decomp.QUALI_AUDIT_COLUMNS -- decomp raises
    # SimNotEstimable if the two ever disagree.
    "mode2_quali_row_audit": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("session_id", "int"),
        ("driver_id", "text"), ("team_id", "text"), ("year", "int"), ("round", "int"),
        ("kind", "text"), ("included", "bool"), ("exclude_reason", "text"),
        ("y_pp", "float"), ("best_s", "float"),
    ],
    "mode2_component": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("component_id", "text"),
        ("label", "text"), ("n_drivers", "int"), ("n_cells", "int"), ("is_floating", "bool"),
        ("driver_ids", "text[]"), ("cell_ids", "text[]"),
    ],
    # rank_in_component is the ONLY driver rank in this schema: the mobility graph has
    # four disconnected components, so a grid-wide rank is not computable (§6.1).
    "mode2_driver_rating": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("rating_pp", "float"), ("rating_lo", "float"), ("rating_hi", "float"),
        ("sd_within", "float"), ("sd_island", "float"), ("sd_total", "float"),
        ("frac_floating", "float"), ("evidence_share", "float"), ("anchor_class", "text"),
        ("basis", "text"), ("component_id", "text"), ("rank_in_component", "int"),
        ("n_races", "int"), ("n_cells", "int"), ("n_races_excluded", "int"),
    ],
    "mode2_driver_rating_history": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("through_year", "int"), ("rating_pp", "float"), ("rating_lo", "float"),
        ("rating_hi", "float"), ("sd_total", "float"), ("anchor_class", "text"),
        ("n_races_cumulative", "int"), ("switched_this_year", "bool"),
    ],
    # Includes the two refused skills (tyre_management, wet) as rows with value NULL
    # and a stored not_measured_reason -- the refusals are product (§3.6).
    "mode2_driver_skill": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("skill", "text"), ("measured", "bool"), ("value", "float"), ("value_lo", "float"),
        ("value_hi", "float"), ("unit", "text"), ("evidence_share", "float"),
        ("anchor_class", "text"), ("pct_field_below", "float"),
        ("not_measured_reason", "text"), ("n_obs", "int"),
    ],
    "mode2_driver_contrast": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("driver_a", "text"),
        ("driver_b", "text"), ("kind", "text"), ("delta_pp", "float"), ("delta_se", "float"),
        ("delta_lo", "float"), ("delta_hi", "float"), ("same_component", "bool"),
        ("shared_cells", "text[]"), ("n_shared_races", "int"), ("n_races_a", "int"),
        ("n_races_b", "int"),
    ],
    "mode2_car_rating": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("team_id", "text"), ("year", "int"),
        ("gamma_pp", "float"), ("gamma_lo", "float"), ("gamma_hi", "float"),
        ("slope_pp", "float"), ("slope_lo", "float"), ("slope_hi", "float"),
        ("start_pp", "float"), ("end_pp", "float"), ("slope_significant", "bool"),
        ("rank_in_season", "int"), ("component_id", "text"), ("basis", "text"),
        ("n_races", "int"),
    ],
    "mode2_car_hazard": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("team_id", "text"), ("year", "int"),
        ("retirements", "int"), ("racing_laps", "int"), ("hazard_per_1000", "float"),
        ("hazard_lo", "float"), ("hazard_hi", "float"), ("hazard_car_only", "float"),
        ("hazard_car_lo", "float"), ("hazard_car_hi", "float"), ("rank_in_season", "int"),
        ("sufficient", "bool"),
    ],
    "mode2_points_calib": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("year", "int"),
        ("slope_theta_per_pp", "float"), ("intercept", "float"), ("r2", "float"),
        ("resid_sd", "float"), ("temperature", "float"), ("sd_ratio_sim_actual", "float"),
        ("replay_mae_points", "float"), ("replay_corr", "float"), ("n_entries", "int"),
    ],
    "mode2_career_season": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("driver_id", "text"),
        ("year", "int"), ("team_id", "text"), ("actual_points", "float"),
        ("replay_points", "float"), ("replay_lo", "float"), ("replay_hi", "float"),
        ("avg_driver_points", "float"), ("avg_driver_p10", "float"),
        ("avg_driver_p90", "float"), ("contribution", "float"), ("contribution_lo", "float"),
        ("contribution_hi", "float"), ("mc_stderr", "float"), ("param_stderr", "float"),
        ("calibration_mae", "float"), ("basis", "text"), ("anchor_class", "text"),
        ("rounds_in_season", "int"), ("starts", "int"), ("teams", "text"),
    ],
    "mode2_counterfactual": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("year", "int"),
        ("driver_id", "text"), ("team_id", "text"), ("replaced_driver_id", "text"),
        ("observed", "bool"), ("points_p10", "float"), ("points_p50", "float"),
        ("points_p90", "float"), ("incumbent_actual", "float"), ("delta_p10", "float"),
        ("delta_p50", "float"), ("delta_p90", "float"), ("basis", "text"),
        ("cross_component", "bool"), ("interaction_pp", "float"),
        ("calibration_mae", "float"),
    ],
    "mode2_row_audit": [
        ("fit_id", "int"), ("assumption_set_id", "int"), ("session_id", "int"),
        ("driver_id", "text"), ("team_id", "text"), ("year", "int"), ("round", "int"),
        ("included", "bool"), ("exclude_reason", "text"), ("y_pp", "float"),
        ("se_pp", "float"), ("laps_fit", "int"), ("badge", "text"),
    ],
    # --- MODE3_SPEC §6.3: the one v1.4 table Python writes. -------------------
    # race_report is NOT added to RACE_TABLE_ORDER / SPRINT_TABLE_ORDER / ANALYTICS
    # (§4.4): it is written by f1lab/report.py after the per-session COPY block, and
    # listing it there raises KeyError on every race ingest.
    # ask_query_log and ask_answer_cache are deliberately absent from this dict --
    # Python never writes them, so db.assert_schema must not assert over them;
    # tests/test_web_owned_tables.py is their drift check instead.
    # text[], jsonb and timestamptz all fall through cast_frame's object
    # pass-through branch, so no new casting rule is needed.
    # --- QUALI_SPEC §3.3-§3.6. Column order is the DDL order, verbatim. ------------------
    "quali_results": [
        ("session_id", "int"), ("driver_id", "text"), ("team_id", "text"), ("position", "int"),
        ("q1_s", "float"), ("q2_s", "float"), ("q3_s", "float"),
        ("best_s", "float"), ("best_segment", "int"), ("best_lap_number", "int"),
        ("segments_entered", "int"), ("knocked_out_in", "int"), ("set_a_time", "bool"),
        # §4.1 / D6: two gaps, because one of them is a lie half the time.
        ("gap_to_pole_s", "float"), ("gap_to_pole_pct", "float"),
        ("gap_to_pole_common_s", "float"), ("gap_to_pole_common_pct", "float"),
        ("gap_to_pole_segment", "int"),
        ("n_repr_laps", "int"), ("push_laps", "int"), ("times_source", "text"),
    ],
    "quali_segment_times": [
        ("session_id", "int"), ("driver_id", "text"), ("segment", "int"),
        ("laps_run", "int"), ("repr_laps", "int"), ("push_laps", "int"),
        ("best_s", "float"), ("best_lap_number", "int"),
        ("gap_to_best_s", "float"), ("gap_to_best_pct", "float"),
        ("spread_s", "float"), ("sd_s", "float"),
        ("compound", "text"), ("tyre_life", "int"), ("wet_compound", "bool"),
        # v1.6 as-built: false when no lap can verify this driver-segment because the
        # official Qk duplicates another segment's value (see quali_segment_times docstring).
        ("verified", "bool"),
    ],
    "quali_teammate_h2h": [
        ("session_id", "int"), ("team_id", "text"), ("driver_a", "text"), ("driver_b", "text"),
        ("segment", "int"), ("a_best_s", "float"), ("b_best_s", "float"),
        ("delta_s", "float"), ("delta_pct", "float"), ("comparable", "bool"),
        ("classified_ahead", "text"), ("divergent", "bool"),
        ("session_sd_s", "float"), ("below_noise", "bool"),
    ],
    "season_quali_h2h": [
        ("year", "int"), ("kind", "text"), ("team_id", "text"),
        ("driver_a", "text"), ("driver_b", "text"),
        ("sessions_counted", "int"), ("a_wins", "int"), ("b_wins", "int"),
        ("deltas_counted", "int"), ("median_delta_s", "float"), ("median_delta_pct", "float"),
        ("mad_delta_pct", "float"), ("sessions_caveated", "int"),
    ],
    "race_report": [
        ("session_id", "int"), ("assumption_set_id", "int"), ("prompt_version", "int"),
        ("model", "text"), ("status", "text"), ("grounding_completeness", "text"),
        ("grounding_sha256", "text"), ("result", "text"), ("pace", "text"),
        ("strategy", "text"), ("swing", "text"), ("caveats", "text"),
        ("known_gaps", "text[]"), ("cites", "jsonb"), ("audit_failures", "jsonb"),
        ("skipped_reason", "text"), ("word_count", "int"), ("input_tokens", "int"),
        ("output_tokens", "int"), ("est_cost_usd", "real"), ("regenerations", "int"),
        ("generated_at", "timestamptz"),
    ],
    # --- v1.7 telemetry layer (TELEMETRY_SPEC §2.1/§2.4). Columns in DDL order.
    #     The three array kinds farray/iarray/barray are cast by _to_farray/_to_iarray/
    #     _to_barray below; they exist because psycopg cannot adapt a numpy.ndarray (§8 R2).
    "circuit_layout": [
        ("circuit_key", "int"), ("year", "int"), ("rotation_deg", "float"),
        ("n_corners", "int"), ("track_length_m", "float"), ("ref_session_id", "int"),
    ],
    "circuit_corners": [
        ("circuit_key", "int"), ("year", "int"), ("corner_number", "int"),
        ("corner_letter", "text"), ("x", "float"), ("y", "float"),
        ("angle_deg", "float"), ("distance_m", "float"),
    ],
    "lap_telemetry": [
        ("session_id", "int"), ("driver_id", "text"), ("lap_number", "int"),
        ("selection", "text"), ("n_samples", "int"), ("n_car_samples", "int"),
        ("n_pos_samples", "int"), ("max_sample_gap_m", "float"),
        ("track_length_m", "float"), ("source_hash", "text"),
        ("distance_m", "farray"), ("time_s", "farray"),
        ("x", "farray"), ("y", "farray"),
        ("speed_kph", "iarray"), ("throttle_pct", "iarray"),
        ("brake", "barray"), ("gear", "iarray"), ("drs", "iarray"),
        # 20th column: the live table has it and db.schema_problems() flags any live column
        # absent from EXPECTED_COLUMNS as "unexpected", exactly as session_ingests.ingested_at
        # is carried above. The writer supplies it; the DDL default is never reached by COPY.
        ("ingested_at", "timestamptz"),
        # GAPFILL_SPEC §4.3 / R1: 21st column, appended by migration 0010. source_hash covers
        # the raw channels only, so it cannot tell a re-derivation apart from a no-op; the skip
        # condition is `source_hash matches AND derive_version = TRAIL_DERIVE_VERSION`.
        ("derive_version", "int"),
    ],
    "lap_telemetry_summary": [
        ("session_id", "int"), ("driver_id", "text"), ("lap_number", "int"),
        ("top_speed_kph", "int"), ("min_speed_kph", "int"),
        ("full_throttle_pct", "float"), ("brake_pct", "float"), ("lift_pct", "float"),
        ("overlap_pct", "float"), ("n_brake_zones", "int"), ("n_gear_changes", "int"),
        ("drs_distance_m", "float"), ("track_length_m", "float"),
        ("s1_distance_m", "float"), ("s2_distance_m", "float"),
        ("n_samples", "int"), ("max_sample_gap_m", "float"), ("n_gaps_over_50m", "int"),
    ],
    "lap_corner_speeds": [
        ("session_id", "int"), ("driver_id", "text"), ("lap_number", "int"),
        ("corner_number", "int"), ("corner_letter", "text"),
        ("apex_speed_kph", "int"), ("apex_distance_m", "float"),
        ("entry_speed_kph", "int"), ("exit_speed_kph", "int"),
        ("brake_zone_idx", "int"), ("brake_point_m", "float"),
        ("brake_distance_m", "float"), ("throttle_point_m", "float"),
        ("time_in_corner_s", "float"),
        # GAPFILL_SPEC §4.1: five columns added by migration 0010. §4.1 writes them "in DDL
        # order after brake_distance_m"; Postgres appends on ADD COLUMN, so the true physical
        # order is ordinals 15-19, after time_in_corner_s. These are appended here to match the
        # database, because db.schema_problems() and gen_ask_schema.cross_check_frames both
        # compare against information_schema.
        #
        # trail_duty is the §4.4.3 unrendered diagnostic: it is stored and it is listed here
        # (COPY must name it), but it is NOT exposed in scripts/sql/0005_ask_views.sql and it
        # appears on no page. R4 is enforced at that layer, not in a caption.
        ("brake_release_m", "float"), ("brake_release_to_apex_m", "float"),
        ("brake_on_distance_m", "float"), ("trail_duty", "float"),
        ("trail_status", "text"),
    ],
}

EXPECTED_COLUMNS: dict[str, list[str]] = {t: [c for c, _ in cols] for t, cols in TABLE_COLUMNS.items()}

# Per-session child tables in FK (COPY) order. delete_session_children uses the reverse.
RACE_TABLE_ORDER: list[str] = [
    "session_teams", "session_entries", "compound_colours", "results", "laps", "lap_status", "pit_stops",
    "stints", "lap_exclusion_report", "pace_ranking", "degradation_fits", "compound_degradation",
    "teammate_deltas", "fuel_sensitivity", "weather_samples", "track_status_events",
    "sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound",   # SIM_SPEC §2.3
    "race_moment", "optimal_stint",   # MODE1_SPEC §5.6 (the only two companion tables built here)
]
SPRINT_TABLE_ORDER: list[str] = ["session_teams", "session_entries", "results"]

# QUALI_SPEC §3.7. Q/SQ write session_entries and session_teams like every session, plus the
# three per-session qualifying tables -- and deliberately NOT `results`, which stays "the
# classification of a race or sprint" (§3.3). `season_quali_h2h` is season-scoped and belongs
# to season.py's own delete-and-rebuild, not here.
QUALI_TABLE_ORDER: list[str] = [
    "session_teams", "session_entries", "laps", "lap_exclusion_report",
    "quali_results", "quali_segment_times", "quali_teammate_h2h",
]

# Analytics whose failure is recorded rather than failing a Q/SQ session. quali_results is
# NOT here: the official times are the session's reason to exist, so a session that cannot
# produce them fails (§4).
QUALI_ANALYTICS: list[str] = ["lap_exclusion_report", "quali_segment_times", "quali_teammate_h2h"]

#: The five §3.2 columns, in DDL order. NULL on every R/S lap, populated on every Q/SQ lap.
QUALI_LAP_COLUMNS: tuple[str, ...] = (
    "quali_segment", "segment_source", "is_push_lap", "excl_disallowed", "deleted_inferred",
)

# Analytics whose failure is recorded in analytics_status rather than failing the session.
ANALYTICS: list[str] = [
    "lap_exclusion_report", "pace_ranking", "degradation_fits", "compound_degradation",
    "teammate_deltas", "fuel_sensitivity", "stints", "lap_status", "pit_stops",
    "weather_samples", "track_status_events",
    "sim",   # ONE status key for the four sim_* per-session tables (SIM_SPEC §2.3)
    # MODE1_SPEC §5.5. The four cross-race companion analytics (win_probability,
    # title_odds, preview, circuit_odi) write their own analytics_status rows from the
    # run-end step and are deliberately NOT listed here -- _guard only iterates this list
    # inside build_race_frames.
    "race_moment", "optimal_stint",
]

# ---------------------------------------------------------------------------
# DataFrame column -> DB column, per table (the single greppable name map)
# ---------------------------------------------------------------------------

# MODE1_SPEC §5.5: the v1.2 companion tables add NOTHING here on purpose. Every
# companion frame is built in Python with snake_case column names already, never from a
# FastF1 DataFrame, so there is no name to map. The dict is still owned by WP0 so no
# other package edits frames.py.
RENAMES: dict[str, dict[str, str]] = {
    "session_teams": {"TeamId": "team_id", "TeamName": "team_name"},
    "session_entries": {"DriverId": "driver_id", "TeamId": "team_id", "Abbreviation": "code",
                        "DriverNumber": "driver_number"},
    "compound_colours": {"Compound": "compound", "Colour": "colour"},
    "results": {"DriverId": "driver_id", "Position": "position", "ClassifiedPosition": "classified_position",
                "GridPosition": "grid_position", "Points": "points", "Status": "status",
                "Laps": "laps_completed", "Time": "result_time_s"},
    "laps": {
        "Driver": "driver_id", "LapNumber": "lap_number", "Stint": "stint", "Compound": "compound",
        "TyreLife": "tyre_life", "FreshTyre": "fresh_tyre", "Position": "position", "TrackStatus": "track_status",
        "LapTimeSeconds": "lap_time_s", "Time": "session_time_s", "LapStartTime": "lap_start_time_s",
        "Sector1Time": "sector1_s", "Sector2Time": "sector2_s", "Sector3Time": "sector3_s",
        "SpeedI1": "speed_i1", "SpeedI2": "speed_i2", "SpeedFL": "speed_fl", "SpeedST": "speed_st",
        "PitInTime": "pit_in_time_s", "PitOutTime": "pit_out_time_s",
        "IsAccurate": "is_accurate", "Deleted": "deleted", "DeletedReason": "deleted_reason",
        "FastF1Generated": "fastf1_generated", "IsPersonalBest": "is_personal_best",
        "excl_no_time": "excl_no_time", "excl_in_lap": "excl_in_lap", "excl_out_lap": "excl_out_lap",
        "excl_not_green": "excl_not_green", "excl_inaccurate": "excl_inaccurate", "excl_deleted": "excl_deleted",
        "is_clean": "passes_rules", "is_outlier": "is_outlier", "is_representative": "is_representative",
        "FuelKg": "fuel_kg", "FuelPenaltyS": "fuel_penalty_s", "LapTimeFuelCorrected": "lap_time_fc_s",
        "GapToLeaderS": "gap_to_leader_s", "IntervalS": "interval_s", "LeaderDriver": "leader_driver_id",
    },
    "lap_status": {"LapNumber": "lap_number", "IsGreen": "is_green", "WorstStatus": "worst_status",
                   "DriversAffected": "drivers_affected", "DriversOnLap": "drivers_on_lap"},
    "pit_stops": {"Driver": "driver_id", "StopNumber": "stop_number", "LapIn": "lap_in", "LapOut": "lap_out",
                  "PitInTimeS": "pit_in_time_s", "PitOutTimeS": "pit_out_time_s", "PitLaneS": "pit_lane_s",
                  "CompoundIn": "compound_in", "CompoundOut": "compound_out"},
    "stints": {"Driver": "driver_id", "Stint": "stint", "Compound": "compound", "start_lap": "start_lap",
               "end_lap": "end_lap", "laps": "laps"},
    "lap_exclusion_report": {"index": "rule_order", "rule": "rule", "laps_hit": "laps_hit",
                             "pct_of_all": "pct_of_all"},
    "pace_ranking": {"Driver": "driver_id", "Rank": "rank", "Team": "team_id", "CleanLaps": "clean_laps",
                     "MedianPace": "median_pace_s", "BestPace": "best_pace_s", "IQR": "iqr_s", "GapS": "gap_s",
                     "GapPct": "gap_pct", "WhiskerLo": "box_whisker_lo_s", "Q1": "box_q1_s", "Q3": "box_q3_s",
                     "WhiskerHi": "box_whisker_hi_s", "Mean": "box_mean_s",
                     "SensRankLo": "sens_rank_lo", "SensRankHi": "sens_rank_hi"},
    "degradation_fits": {"Driver": "driver_id", "Stint": "stint", "Team": "team_id", "Compound": "compound",
                         "Laps": "laps", "DegSPerLap": "deg_s_per_lap", "DegStdErr": "deg_std_err", "R2": "r2",
                         "FreshPaceS": "fresh_pace_s"},
    "compound_degradation": {"Compound": "compound", "Laps": "laps", "SlopeSPerLap": "slope_s_per_lap",
                             "InterceptS": "intercept_s", "XMin": "x_min", "XMax": "x_max"},
    "teammate_deltas": {"Team": "team_id", "Faster": "faster_driver_id", "Slower": "slower_driver_id",
                        "GapS": "gap_s", "GapPct": "gap_pct", "LapsCompared": "laps_compared"},
    "fuel_sensitivity": {"Driver": "driver_id", "rank@v": "rank", "gap@v": "gap_s",
                         "v": "fuel_effect_s_per_kg"},
    "weather_samples": {"index": "sample_idx", "Time": "session_time_s", "AirTemp": "air_temp",
                        "Humidity": "humidity", "Pressure": "pressure", "Rainfall": "rainfall",
                        "TrackTemp": "track_temp", "WindDirection": "wind_direction", "WindSpeed": "wind_speed"},
    "track_status_events": {"index": "event_idx", "Time": "session_time_s", "Status": "status",
                            "Message": "message"},
    # sim.py frames already carry DB column names except the driver code (SIM_SPEC §2.3, identity entries)
    "sim_race_params": {},
    "sim_compound_params": {"compound": "compound"},
    "sim_driver_params": {"Driver": "driver_id"},
    "sim_driver_compound": {"Driver": "driver_id", "compound": "compound"},
    "sim_circuit_hazard": {},
}


# ---------------------------------------------------------------------------
# Public data structures
# ---------------------------------------------------------------------------

@dataclass
class SessionIds:
    """Built from ``session.results`` before any analytics (§1.11)."""
    session_id: int
    code_to_driver_id: dict[str, str]
    team_name_to_team_id: dict[str, str]


@dataclass
class Frames:
    tables: dict[str, pd.DataFrame]        # key = table name, columns already renamed to DB names, ids resolved
    analytics_status: dict[str, str]       # per analytic: 'ok' | 'empty' | 'error: <ExcType>: <msg>'
    warnings: list[str] = field(default_factory=list)
    raw_laps: int = 0
    clean_laps: int = 0
    compounds_seen: list[str] = field(default_factory=list)
    #: QUALI_SPEC §2.5/D8. `clean.clean_quali`'s diagnostics, verbatim, plus `kind` and
    #: `cross_segment_ok`. Empty on a race or sprint. The ingest reads `quali["ok"]` to
    #: decide `session_ingests.status = 'partial'`; the numbers also appear in `warnings`.
    quali: dict = field(default_factory=dict)


class IdResolutionError(KeyError):
    """A driver code or team name in an analytic frame is missing from session.results."""


# ---------------------------------------------------------------------------
# Casting (§0.3)
# ---------------------------------------------------------------------------

def _is_null(v: object) -> bool:
    if v is None or v is pd.NA or v is pd.NaT:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    if isinstance(v, (np.floating,)) and np.isnan(v):
        return True
    if isinstance(v, str):
        # Only 'nan' (FastF1's stringified NaN: Compound, Miami 2025) and '' are NULL here. The
        # string 'None' is NOT: FastF1 uses it as a compound label (stored upper-cased as 'NONE',
        # §8.1) and as a missing HeadshotUrl, which ingest.upsert_dimensions filters by itself.
        return v == "nan" or v == ""
    try:
        return bool(pd.isna(v)) if not isinstance(v, (list, dict, tuple)) else False
    except (TypeError, ValueError):
        return False


def _fallback(v: object, default: str) -> str:
    """QUALI_SPEC §2.1.1 — the empty-string trap, for two ``NOT NULL text`` columns.

    FastF1 hands a qualifying session an **empty string** for ``ClassifiedPosition`` and
    ``Status`` (measured, every row of every Q/SQ session), not a null. ``_is_null`` already
    treats ``''`` as null, so the literal empty string was never the live defect the spec
    describes; a whitespace-only value would have been, and this closes that too. Race and
    sprint rows are unaffected — measured, no existing session has a blank ``Status``.
    """
    return default if _is_null(v) or not str(v).strip() else str(v)


def _to_text(s: pd.Series) -> pd.Series:
    return pd.Series([None if _is_null(v) else str(v) for v in s], index=s.index, dtype=object)


def _to_float(s: pd.Series) -> pd.Series:
    if pd.api.types.is_timedelta64_dtype(s):
        return s.dt.total_seconds().astype(float)
    if pd.api.types.is_bool_dtype(s):
        return s.astype(float)
    vals = [None if _is_null(v) else v for v in s] if s.dtype == object else s
    return pd.to_numeric(pd.Series(vals, index=s.index), errors="raise").astype(float)


def _to_int(s: pd.Series) -> pd.Series:
    if pd.api.types.is_timedelta64_dtype(s):
        raise TypeError("timedelta column cannot be cast to int")
    vals = [None if _is_null(v) else v for v in s] if s.dtype == object else s
    num = pd.to_numeric(pd.Series(vals, index=s.index), errors="raise")
    # Integer-valued floats become ints; a non-integral value is a bug and must be loud.
    if pd.api.types.is_float_dtype(num):
        finite = num.dropna()
        if not np.all(np.isclose(finite, np.round(finite))):
            bad = finite[~np.isclose(finite, np.round(finite))].head(3).tolist()
            raise ValueError(f"non-integral values in integer column: {bad}")
        num = num.round()
    return num.astype("Int64")


def _to_bool(s: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(s) and not isinstance(s.dtype, pd.BooleanDtype):
        return s.astype("boolean")
    return pd.Series([None if _is_null(v) else bool(v) for v in s], index=s.index, dtype="boolean")


def _as_list(v: object) -> list | None:
    """One array cell as a plain Python list, or None when the cell itself is null.

    TELEMETRY_SPEC §8 R2: a ``numpy.ndarray`` reaches psycopg as an unadaptable type and
    dies deep inside ``db.copy_frame``, *after* the download. ``.tolist()`` is the fix, and
    it is applied here rather than at the writer so no caller can forget it.
    """
    if v is None:
        return None
    if isinstance(v, np.ndarray):
        return v.tolist()          # also converts numpy scalars to Python scalars
    if isinstance(v, pd.Series):
        return v.to_list()
    if isinstance(v, (list, tuple)):
        return list(v)
    if np.isscalar(v) and _is_null(v):   # a NaN standing in for a missing array
        return None
    raise TypeError(f"array column: expected ndarray/Series/list, got {type(v).__name__}")


def _to_farray(s: pd.Series) -> pd.Series:
    """real[] — every element a Python float (or None). Rounding is the writer's job (§2.3)."""
    out = []
    for v in s:
        lst = _as_list(v)
        out.append(None if lst is None else [None if _is_null(e) else float(e) for e in lst])
    return pd.Series(out, index=s.index, dtype=object)


def _to_iarray(s: pd.Series) -> pd.Series:
    """smallint[] — every element a Python int (or None). Fractional values are rounded."""
    out = []
    for v in s:
        lst = _as_list(v)
        out.append(None if lst is None else
                   [None if _is_null(e) else int(round(float(e))) for e in lst])
    return pd.Series(out, index=s.index, dtype=object)


def _to_barray(s: pd.Series) -> pd.Series:
    """boolean[] — every element a Python bool (or None). Floats threshold at 0.5 (§2.3)."""
    out = []
    for v in s:
        lst = _as_list(v)
        out.append(None if lst is None else
                   [None if _is_null(e) else
                    (float(e) >= 0.5 if isinstance(e, (float, np.floating)) else bool(e))
                    for e in lst])
    return pd.Series(out, index=s.index, dtype=object)


def cast_frame(df: pd.DataFrame, table: str) -> pd.DataFrame:
    """Reorder to ``EXPECTED_COLUMNS[table]`` and apply the §0.3 casting rules.

    Raises ``KeyError`` when the frame's column set differs from the contract.
    """
    cols = TABLE_COLUMNS[table]
    expected = [c for c, _ in cols]
    missing = [c for c in expected if c not in df.columns]
    extra = [c for c in df.columns if c not in expected]
    if missing or extra:
        raise KeyError(f"{table}: frame columns differ from EXPECTED_COLUMNS; missing={missing} extra={extra}")

    out = pd.DataFrame(index=df.index)
    for c, kind in cols:
        s = df[c]
        if kind in ("int", "serial"):
            out[c] = _to_int(s)
        elif kind in ("float", "real"):
            out[c] = _to_float(s)
        elif kind == "bool":
            out[c] = _to_bool(s)
        elif kind == "text":
            out[c] = _to_text(s)
        elif kind == "farray":
            out[c] = _to_farray(s)
        elif kind == "iarray":
            out[c] = _to_iarray(s)
        elif kind == "barray":
            out[c] = _to_barray(s)
        else:  # timestamptz | date | jsonb | text[] — passed through as objects
            out[c] = s.astype(object)
    return out[expected]


def _py(v: object) -> object:
    """A single cell as a plain Python value (None for every null)."""
    if _is_null(v):
        return None
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return float(v)
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    if isinstance(v, pd.Timedelta):
        return v.total_seconds()
    if isinstance(v, np.ndarray):
        # §8 R2 — the last line of defence. A cast frame never reaches here with an ndarray
        # (the array casters have already flattened it); an uncast one would otherwise die
        # inside db.copy_frame with an unadaptable-type error rather than a schema error.
        return v.tolist()
    if isinstance(v, (list, tuple)):
        # Numpy scalars inside an existing list[...] column would be unadaptable too. This is
        # deliberately NOT a recursive _py() sweep: _py maps '' to None, and text[] columns
        # (session_ingests.warnings, race_report.known_gaps) may legitimately hold ''.
        return [e.item() if isinstance(e, np.generic) else e for e in v]
    return v


def iter_rows(df: pd.DataFrame) -> Iterator[tuple]:
    """Rows of a cast frame as tuples of plain Python values, ready for COPY."""
    for row in df.itertuples(index=False, name=None):
        yield tuple(_py(v) for v in row)


def empty_frame(table: str) -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype=object) for c in EXPECTED_COLUMNS[table]})


# ---------------------------------------------------------------------------
# Identity from session.results
# ---------------------------------------------------------------------------

class BlankIdentity(IdResolutionError):
    """``session.results`` carries no DriverId/TeamId, so nothing can be keyed to a driver.

    **Measured, and not in QUALI_SPEC: every one of the 17 sprint-qualifying sessions in the
    cache (2024 R05/06/11/19/21/23, 2025 R02/06/13/19/21/23, 2026 R02/04/05/09/12) returns an
    EMPTY STRING for `DriverId` and `TeamId` on every row.** Qualifying (`Q`) sessions are
    populated normally; so are `R` and `S`. `TeamName`, `Abbreviation` and `DriverNumber` are
    present on SQ, so the identity is recoverable — but only from outside the session.

    Silently accepting the blanks would write NULL into `session_entries.driver_id`
    (`NOT NULL`) or, worse, succeed with a NULL `quali_results.team_id`. D3 makes sprint
    qualifying first-class, so this fails loudly instead and the caller supplies the map.
    """


def identity_maps(results) -> tuple[dict[str, str], dict[str, str]]:
    """``({abbreviation: driver_id}, {team_name: team_id})`` from any populated results frame.

    The one-liner a caller needs to build ``make_session_ids``' fallback out of a sibling
    session of the same weekend (the `Q`, `S` or `R` session, all of which are populated) or
    out of the database's own ``session_entries`` / ``session_teams``.
    """
    d = {str(r.Abbreviation): str(r.DriverId) for r in results.itertuples(index=False)
         if str(r.DriverId).strip()}
    t = {str(r.TeamName): str(r.TeamId) for r in results.itertuples(index=False)
         if str(r.TeamId).strip()}
    return d, t


def make_session_ids(session, session_id: int, *, driver_ids: dict[str, str] | None = None,
                     team_ids: dict[str, str] | None = None) -> SessionIds:
    """Built from ``session.results`` before any analytics (§1.11).

    ``driver_ids`` / ``team_ids`` override the session's own identity columns and are
    REQUIRED for ``kind='SQ'``, where FastF1 leaves both blank (see :class:`BlankIdentity`).
    """
    res = session.results
    codes = {str(r.Abbreviation): str(r.DriverId) for r in res.itertuples(index=False)}
    teams = {str(r.TeamName): str(r.TeamId) for r in res.itertuples(index=False)}
    if driver_ids:
        codes = {c: driver_ids.get(c, v) or v for c, v in codes.items()}
    if team_ids:
        teams = {n: team_ids.get(n, v) or v for n, v in teams.items()}
    blank_d = sorted(c for c, v in codes.items() if not v.strip())
    blank_t = sorted(n for n, v in teams.items() if not v.strip())
    if blank_d or blank_t:
        raise BlankIdentity(
            f"session.results has no DriverId for {blank_d} and no TeamId for {blank_t}; "
            "pass driver_ids=/team_ids= (see frames.identity_maps) — every sprint-qualifying "
            "session in the cache needs this")
    return SessionIds(session_id=int(session_id), code_to_driver_id=codes,
                      team_name_to_team_id=teams)


def _resolve(series: pd.Series, mapping: dict[str, str], what: str) -> pd.Series:
    out = []
    for v in series:
        if _is_null(v):
            out.append(None)
            continue
        key = str(v)
        if key not in mapping:
            raise IdResolutionError(f"{what} {key!r} not in session.results")
        out.append(mapping[key])
    return pd.Series(out, index=series.index, dtype=object)


def _norm_compound(s: pd.Series) -> pd.Series:
    """The literal string 'nan' (and NaN) become None; everything else upper-case text."""
    return pd.Series([None if _is_null(v) else str(v).upper() for v in s], index=s.index, dtype=object)


def _number_rank(res: pd.DataFrame) -> dict[str, int]:
    """0-based rank of each driver's number within their team (line-style fallback)."""
    ranks: dict[str, int] = {}
    for _, grp in res.groupby("TeamId", sort=False):
        def _num(v: object) -> int:
            try:
                return int(str(v))
            except ValueError:
                return 10 ** 6
        ordered = sorted(grp.itertuples(index=False), key=lambda r: _num(r.DriverNumber))
        for i, r in enumerate(ordered):
            ranks[str(r.Abbreviation)] = i
    return ranks


def _identity_frames(session, ids: SessionIds) -> dict[str, pd.DataFrame]:
    """session_teams, session_entries, results — every session kind.

    Identity comes from ``ids``, never from ``res.DriverId`` / ``res.TeamId`` directly:
    those two columns are blank on every sprint-qualifying session (see
    :class:`BlankIdentity`), and ``make_session_ids`` is where the fallback is applied.
    """
    res = session.results.copy()
    sid = ids.session_id

    # De-duplicate on the RESOLVED id, not on res.TeamId: on a sprint-qualifying session
    # every TeamId is '' and drop_duplicates would collapse the whole grid to one team.
    teams = res.assign(_tid=[ids.team_name_to_team_id[str(n)] for n in res["TeamName"]])
    teams = teams.drop_duplicates("_tid")
    team_rows = []
    for r in teams.itertuples(index=False):
        hx, src = colours.team_colour(str(r.TeamName), session, getattr(r, "TeamColor", None))
        team_rows.append({"session_id": sid, "team_id": ids.team_name_to_team_id[str(r.TeamName)],
                          "team_name": str(r.TeamName),
                          "colour": hx, "colour_source": src})
    session_teams = pd.DataFrame(team_rows, columns=EXPECTED_COLUMNS["session_teams"])

    ranks = _number_rank(res)
    entry_rows = []
    for r in res.itertuples(index=False):
        code = str(r.Abbreviation)
        style, src = colours.line_style(code, session, ranks.get(code, 0))
        entry_rows.append({"session_id": sid, "driver_id": ids.code_to_driver_id[code],
                           "team_id": ids.team_name_to_team_id[str(r.TeamName)],
                           "code": code, "driver_number": str(r.DriverNumber),
                           "line_style": style, "line_style_source": src})
    session_entries = pd.DataFrame(entry_rows, columns=EXPECTED_COLUMNS["session_entries"])

    results = pd.DataFrame({
        "session_id": sid,
        "driver_id": [ids.code_to_driver_id[str(v)] for v in res["Abbreviation"]],
        "position": res["Position"].values,
        "classified_position": [_fallback(v, "N") for v in res["ClassifiedPosition"]],
        "grid_position": res["GridPosition"].values,
        "points": res["Points"].fillna(0.0).astype(float).values,
        "status": [_fallback(v, "Unknown") for v in res["Status"]],
        "laps_completed": res["Laps"].values,
        "result_time_s": res["Time"].dt.total_seconds().values,
    })

    return {
        "session_teams": cast_frame(session_teams, "session_teams"),
        "session_entries": cast_frame(session_entries, "session_entries"),
        "results": cast_frame(results, "results"),
    }


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def build_sprint_frames(session, ids: SessionIds) -> Frames:
    """session_teams, session_entries, results only (D4: sprint results, no laps)."""
    tables = _identity_frames(session, ids)
    return Frames(tables=tables, analytics_status={}, warnings=[], raw_laps=0, clean_laps=0, compounds_seen=[])


def _guard(status: dict[str, str], name: str, fn: Callable[[], pd.DataFrame | None]) -> pd.DataFrame | None:
    """Run one analytic; record 'ok' | 'empty' | 'error: ...' and return its raw frame or None."""
    try:
        df = fn()
    except (IndexError, KeyError, ValueError) as e:
        msg = str(e).strip().splitlines()[0] if str(e).strip() else ""
        status[name] = f"error: {type(e).__name__}: {msg}"[:500]
        return None
    if df is None or len(df) == 0:
        status[name] = "empty"
        return None
    status[name] = "ok"
    return df


def _laps_core(merged: pd.DataFrame, ids: SessionIds) -> pd.DataFrame:
    """The 35 columns a race lap and a qualifying lap fill identically.

    QUALI_SPEC §3.1: 34 of `laps`' 41 original columns mean exactly the same thing in
    qualifying, and several mean more (compound, tyre_life, deleted/deleted_reason).
    Shared here rather than forked so the two paths cannot drift.
    """
    def col(name: str, default=None) -> pd.Series:
        if name in merged.columns:
            return merged[name]
        return pd.Series([default] * len(merged), index=merged.index, dtype=object)

    def bool_not_null(name: str) -> pd.Series:
        return pd.Series([False if _is_null(v) else bool(v) for v in col(name, False)],
                         index=merged.index, dtype=bool)

    out = pd.DataFrame(index=merged.index)
    out["session_id"] = ids.session_id
    out["driver_id"] = _resolve(merged["Driver"], ids.code_to_driver_id, "driver code")
    out["lap_number"] = merged["LapNumber"]
    out["stint"] = merged["Stint"]
    out["compound"] = _norm_compound(merged["Compound"])
    out["tyre_life"] = merged["TyreLife"]
    out["fresh_tyre"] = col("FreshTyre")
    out["position"] = merged["Position"]
    out["track_status"] = col("TrackStatus")
    out["lap_time_s"] = merged["LapTimeSeconds"]
    out["session_time_s"] = merged["Time"]
    out["lap_start_time_s"] = col("LapStartTime")
    out["sector1_s"] = col("Sector1Time")
    out["sector2_s"] = col("Sector2Time")
    out["sector3_s"] = col("Sector3Time")
    out["speed_i1"] = col("SpeedI1")
    out["speed_i2"] = col("SpeedI2")
    out["speed_fl"] = col("SpeedFL")
    out["speed_st"] = col("SpeedST")
    out["pit_in_time_s"] = merged["PitInTime"]
    out["pit_out_time_s"] = merged["PitOutTime"]
    out["is_accurate"] = bool_not_null("IsAccurate")
    out["deleted"] = bool_not_null("Deleted")
    out["deleted_reason"] = col("DeletedReason")
    out["fastf1_generated"] = bool_not_null("FastF1Generated")
    out["is_personal_best"] = bool_not_null("IsPersonalBest")
    for c in ("excl_no_time", "excl_in_lap", "excl_out_lap", "excl_not_green", "excl_inaccurate",
              "excl_deleted"):
        out[c] = merged[c]
    out["passes_rules"] = merged["is_clean"]
    out["is_outlier"] = merged["is_outlier"]
    out["is_representative"] = merged["is_representative"]
    return out


def _laps_frame(session, ids: SessionIds, annotated: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(cast laps frame, laps_fc_all) where laps_fc_all = fuel_correct(annotated, total_laps)."""
    fc = pace.fuel_correct(annotated, session.total_laps, lap_km=None)
    gaps = derive.gap_to_leader(annotated)
    merged = fc.merge(gaps[["Driver", "LapNumber", "GapToLeaderS", "IntervalS", "LeaderDriver"]],
                      on=["Driver", "LapNumber"], how="left")

    out = _laps_core(merged, ids)
    out["fuel_kg"] = merged["FuelKg"]
    out["fuel_penalty_s"] = merged["FuelPenaltyS"]
    out["lap_time_fc_s"] = merged["LapTimeFuelCorrected"]
    out["gap_to_leader_s"] = merged["GapToLeaderS"]
    out["interval_s"] = merged["IntervalS"]
    out["leader_driver_id"] = _resolve(merged["LeaderDriver"], ids.code_to_driver_id, "leader code")
    # QUALI_SPEC §3.2, cost 1 of D1: cast_frame raises on any column-set change, so the race
    # path must emit the five qualifying columns as NULL. They are nullable precisely so this
    # is a write of None and not a rewrite of 69,548 rows.
    for c in QUALI_LAP_COLUMNS:
        out[c] = None
    assert set(RENAMES["laps"].values()) <= set(out.columns)
    return cast_frame(out, "laps"), fc


def build_race_frames(session, ids: SessionIds, assumption_set_id: int) -> Frames:
    """Every per-session table for a race session (§1.10), the notebook's pipeline exactly."""
    sid = ids.session_id
    asid = int(assumption_set_id)
    status: dict[str, str] = {}
    warnings: list[str] = []
    tables: dict[str, pd.DataFrame] = _identity_frames(session, ids)

    raw = session.laps
    raw_laps = int(len(raw))
    n_nan_compound = int(raw["Compound"].astype(str).eq("nan").sum()) if "Compound" in raw.columns else 0
    if n_nan_compound:
        warnings.append(f"compound 'nan' normalised on {n_nan_compound} laps")
    compounds_seen = sorted({str(c).upper() for c in raw["Compound"].dropna().astype(str) if c != "nan"})

    # --- laps: annotate -> fuel_correct(all) -> gap_to_leader ------------------------------
    annotated = clean.annotate_laps(session)
    tables["laps"], fc_all = _laps_frame(session, ids, annotated)   # fc_all == laps.lap_time_fc_s (SIM_SPEC §3.2)
    clean_count = int(annotated["is_representative"].sum())

    # --- compound colours --------------------------------------------------------------------
    cmap = colours.compound_colours(session, compounds_seen)
    tables["compound_colours"] = cast_frame(pd.DataFrame(
        [{"session_id": sid, "compound": k, "colour": v} for k, v in cmap.items()],
        columns=EXPECTED_COLUMNS["compound_colours"]), "compound_colours")

    # --- the notebook pipeline ------------------------------------------------------------------
    clean_only = clean.clean_laps(session)
    laps_fc = pace.fuel_correct(clean_only, session.total_laps, lap_km=None)

    ranking = _guard(status, "pace_ranking", lambda: pace.pace_ranking(laps_fc, min_laps=8))
    deg = _guard(status, "degradation_fits", lambda: pace.degradation(laps_fc))
    cdeg = _guard(status, "compound_degradation",
                  lambda: pace.compound_degradation(laps_fc, deg, min_laps=10, min_tyre_life=2)
                  if deg is not None else pd.DataFrame())

    if ranking is not None:
        dist = _guard(status, "_pace_distribution", lambda: pace.pace_distribution(laps_fc, ranking, whis=1.5))
        deltas = _guard(status, "teammate_deltas", lambda: pace.teammate_deltas(ranking))
        sens = _guard(status, "fuel_sensitivity",
                      lambda: pace.fuel_sensitivity(clean.clean_laps(session), session.total_laps))
    else:
        dist = deltas = sens = None
        status["teammate_deltas"] = "empty"
        status["fuel_sensitivity"] = "empty"
    dist_status = status.pop("_pace_distribution", "empty")
    if ranking is not None and dist is None:
        # The box columns are NOT NULL: a ranking without its distribution cannot be stored.
        status["pace_ranking"] = f"error: pace_distribution {dist_status}"
        ranking = None

    excl = _guard(status, "lap_exclusion_report", lambda: clean.exclusion_report(session))
    stints = _guard(status, "stints", lambda: clean.stint_table(session))
    lstatus = _guard(status, "lap_status", lambda: derive.lap_status(annotated))
    pits = _guard(status, "pit_stops", lambda: derive.pit_stops(raw))
    weather = _guard(status, "weather_samples", lambda: session.weather_data)
    tstatus = _guard(status, "track_status_events", lambda: session.track_status)
    simfit = _guard(status, "sim", lambda: sim.fit_race(
        fc_all, lstatus, pits, stints, session.results, int(session.total_laps))
        if (lstatus is not None and pits is not None and stints is not None) else None)

    # --- translate each analytic frame to its DB shape ---------------------------------------
    d2i = ids.code_to_driver_id
    t2i = ids.team_name_to_team_id

    if ranking is not None:
        r = ranking.merge(dist.drop(columns=["N", "Median"]), on="Driver", how="left")
        rank_cols = [c for c in sens.columns if c.startswith("rank@")] if sens is not None else []
        lo, hi = [], []
        sens_idx = sens.set_index("Driver") if sens is not None else None
        for drv in r["Driver"]:
            if sens_idx is None or drv not in sens_idx.index or not rank_cols:
                lo.append(None); hi.append(None); continue
            vals = sens_idx.loc[drv, rank_cols]
            if vals.isna().any():
                lo.append(None); hi.append(None)
            else:
                lo.append(int(vals.min())); hi.append(int(vals.max()))
        r["SensRankLo"] = lo
        r["SensRankHi"] = hi
        pr = pd.DataFrame({
            "session_id": sid, "assumption_set_id": asid,
            "driver_id": _resolve(r["Driver"], d2i, "driver code"),
            "rank": r["Rank"],
            "team_id": _resolve(r["Team"], t2i, "team name"),
            "clean_laps": r["CleanLaps"], "median_pace_s": r["MedianPace"], "best_pace_s": r["BestPace"],
            "iqr_s": r["IQR"], "gap_s": r["GapS"], "gap_pct": r["GapPct"],
            "box_whisker_lo_s": r["WhiskerLo"], "box_q1_s": r["Q1"], "box_q3_s": r["Q3"],
            "box_whisker_hi_s": r["WhiskerHi"], "box_mean_s": r["Mean"],
            "sens_rank_lo": r["SensRankLo"], "sens_rank_hi": r["SensRankHi"],
        })
        tables["pace_ranking"] = cast_frame(pr, "pace_ranking")
    else:
        tables["pace_ranking"] = empty_frame("pace_ranking")

    if deg is not None:
        comp = _norm_compound(deg["Compound"])
        if comp.isna().any():
            warnings.append(f"degradation_fits: {int(comp.isna().sum())} stints with unknown compound stored as UNKNOWN")
            comp = comp.fillna("UNKNOWN")
        df = pd.DataFrame({
            "session_id": sid, "assumption_set_id": asid,
            "driver_id": _resolve(deg["Driver"], d2i, "driver code"),
            "stint": deg["Stint"], "team_id": _resolve(deg["Team"], t2i, "team name"),
            "compound": comp, "laps": deg["Laps"], "deg_s_per_lap": deg["DegSPerLap"],
            "deg_std_err": deg["DegStdErr"], "r2": deg["R2"], "fresh_pace_s": deg["FreshPaceS"],
        })
        tables["degradation_fits"] = cast_frame(df, "degradation_fits")
    else:
        tables["degradation_fits"] = empty_frame("degradation_fits")

    if cdeg is not None:
        df = pd.DataFrame({
            "session_id": sid, "assumption_set_id": asid,
            "compound": _norm_compound(cdeg["Compound"]).fillna("UNKNOWN"), "laps": cdeg["Laps"],
            "slope_s_per_lap": cdeg["SlopeSPerLap"], "intercept_s": cdeg["InterceptS"],
            "x_min": cdeg["XMin"], "x_max": cdeg["XMax"],
        })
        tables["compound_degradation"] = cast_frame(df, "compound_degradation")
    else:
        tables["compound_degradation"] = empty_frame("compound_degradation")

    if deltas is not None:
        df = pd.DataFrame({
            "session_id": sid, "assumption_set_id": asid,
            "team_id": _resolve(deltas["Team"], t2i, "team name"),
            "faster_driver_id": _resolve(deltas["Faster"], d2i, "driver code"),
            "slower_driver_id": _resolve(deltas["Slower"], d2i, "driver code"),
            "gap_s": deltas["GapS"], "gap_pct": deltas["GapPct"], "laps_compared": deltas["LapsCompared"],
        })
        tables["teammate_deltas"] = cast_frame(df, "teammate_deltas")
    else:
        tables["teammate_deltas"] = empty_frame("teammate_deltas")

    if sens is not None:
        # Wide (rank@v, gap@v) -> long; the suffix is parsed with float() (§0.3: 'rank@0.03', not '0.030').
        rows = []
        driver_ids = _resolve(sens["Driver"], d2i, "driver code")
        suffixes = [c.split("@", 1)[1] for c in sens.columns if c.startswith("rank@")]
        for suffix in suffixes:
            v = float(suffix)
            part = pd.DataFrame({
                "session_id": sid, "assumption_set_id": asid, "driver_id": driver_ids.values,
                "fuel_effect_s_per_kg": v, "rank": sens[f"rank@{suffix}"].values,
                "gap_s": sens[f"gap@{suffix}"].values,
            })
            rows.append(part[part["rank"].notna() & part["gap_s"].notna()])   # absent at this value -> no row
        long = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=EXPECTED_COLUMNS["fuel_sensitivity"])
        if len(long):
            tables["fuel_sensitivity"] = cast_frame(long, "fuel_sensitivity")
        else:
            tables["fuel_sensitivity"] = empty_frame("fuel_sensitivity")
            status["fuel_sensitivity"] = "empty"
    else:
        tables["fuel_sensitivity"] = empty_frame("fuel_sensitivity")

    if excl is not None:
        df = pd.DataFrame({
            "session_id": sid, "assumption_set_id": asid,
            "rule_order": excl.index.to_numpy(), "rule": excl["rule"],
            "laps_hit": excl["laps_hit"], "pct_of_all": excl["pct_of_all"],
        })
        tables["lap_exclusion_report"] = cast_frame(df, "lap_exclusion_report")
    else:
        tables["lap_exclusion_report"] = empty_frame("lap_exclusion_report")

    if stints is not None:
        comp = _norm_compound(stints["Compound"])
        if comp.isna().any():
            warnings.append(f"stints: {int(comp.isna().sum())} stints with unknown compound stored as UNKNOWN")
            comp = comp.fillna("UNKNOWN")
        df = pd.DataFrame({
            "session_id": sid,
            "driver_id": _resolve(stints["Driver"], d2i, "driver code"),
            "stint": stints["Stint"], "compound": comp,
            "start_lap": stints["start_lap"], "end_lap": stints["end_lap"], "laps": stints["laps"],
        })
        tables["stints"] = cast_frame(df, "stints")
    else:
        tables["stints"] = empty_frame("stints")

    if lstatus is not None:
        df = pd.DataFrame({
            "session_id": sid, "lap_number": lstatus["LapNumber"], "is_green": lstatus["IsGreen"],
            "worst_status": lstatus["WorstStatus"], "drivers_affected": lstatus["DriversAffected"],
            "drivers_on_lap": lstatus["DriversOnLap"],
        })
        tables["lap_status"] = cast_frame(df, "lap_status")
    else:
        tables["lap_status"] = empty_frame("lap_status")

    if pits is not None:
        df = pd.DataFrame({
            "session_id": sid,
            "driver_id": _resolve(pits["Driver"], d2i, "driver code"),
            "stop_number": pits["StopNumber"], "lap_in": pits["LapIn"], "lap_out": pits["LapOut"],
            "pit_in_time_s": pits["PitInTimeS"], "pit_out_time_s": pits["PitOutTimeS"],
            "pit_lane_s": pits["PitLaneS"],
            "compound_in": _norm_compound(pits["CompoundIn"]), "compound_out": _norm_compound(pits["CompoundOut"]),
        })
        tables["pit_stops"] = cast_frame(df, "pit_stops")
    else:
        tables["pit_stops"] = empty_frame("pit_stops")

    if weather is not None:
        w = weather.reset_index(drop=True)
        df = pd.DataFrame({
            "session_id": sid, "sample_idx": w.index.to_numpy(),
            "session_time_s": w["Time"], "air_temp": w.get("AirTemp"), "humidity": w.get("Humidity"),
            "pressure": w.get("Pressure"), "rainfall": w.get("Rainfall"), "track_temp": w.get("TrackTemp"),
            "wind_direction": w.get("WindDirection"), "wind_speed": w.get("WindSpeed"),
        })
        tables["weather_samples"] = cast_frame(df, "weather_samples")
    else:
        tables["weather_samples"] = empty_frame("weather_samples")

    if tstatus is not None:
        ts = tstatus.reset_index(drop=True)
        df = pd.DataFrame({
            "session_id": sid, "event_idx": ts.index.to_numpy(), "session_time_s": ts["Time"],
            "status": ts["Status"], "message": ts.get("Message"),
        })
        tables["track_status_events"] = cast_frame(df, "track_status_events")
    else:
        tables["track_status_events"] = empty_frame("track_status_events")

    # --- strategy simulator (SIM_SPEC §3.2): four tables, one status key ----------------------
    if simfit is not None:
        rp = simfit.race_params.copy()
        rp.insert(0, "assumption_set_id", asid)
        rp.insert(0, "session_id", sid)
        tables["sim_race_params"] = cast_frame(rp, "sim_race_params")

        cp = simfit.compound_params.copy()
        cp["compound"] = _norm_compound(cp["compound"]).fillna("UNKNOWN")
        cp.insert(0, "assumption_set_id", asid)
        cp.insert(0, "session_id", sid)
        tables["sim_compound_params"] = cast_frame(cp, "sim_compound_params")

        dp = simfit.driver_params.copy()
        dp["driver_id"] = _resolve(dp["Driver"], d2i, "driver code")
        dp = dp.drop(columns=["Driver"])
        dp.insert(0, "assumption_set_id", asid)
        dp.insert(0, "session_id", sid)
        tables["sim_driver_params"] = cast_frame(dp, "sim_driver_params")

        dc = simfit.driver_compound.copy()
        dc["driver_id"] = _resolve(dc["Driver"], d2i, "driver code")
        dc["compound"] = _norm_compound(dc["compound"]).fillna("UNKNOWN")
        dc = dc.drop(columns=["Driver"])
        dc.insert(0, "assumption_set_id", asid)
        dc.insert(0, "session_id", sid)
        tables["sim_driver_compound"] = cast_frame(dc, "sim_driver_compound")
        warnings.extend(simfit.warnings)
    else:
        for t in ("sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound"):
            tables[t] = empty_frame(t)

    # --- race moments + optimal stint (MODE1_SPEC §5.6) --------------------------------------
    # Both depend only on this session's own laps plus pooled constants, so they are honest
    # per-session children. Each is guarded on its own key: a detector raising records
    # analytics_status and leaves an empty table rather than failing the session.
    mom = _guard(status, "race_moment", lambda: moments.build_race_moments(session, ids, asid))
    tables["race_moment"] = cast_frame(mom, "race_moment") if mom is not None else empty_frame("race_moment")

    stint = _guard(status, "optimal_stint",
                   lambda: moments.build_optimal_stint(session, ids, asid, dict(POOLED_STINT)))
    tables["optimal_stint"] = (cast_frame(stint, "optimal_stint") if stint is not None
                               else empty_frame("optimal_stint"))

    # --- warnings ----------------------------------------------------------------------------
    if raw_laps and clean_count < 0.5 * raw_laps:
        warnings.append(f"SURVIVING laps {100 * clean_count / raw_laps:.0f}% of raw (< 50%)")

    ordered = {t: tables[t] for t in RACE_TABLE_ORDER}
    return Frames(tables=ordered, analytics_status={k: status[k] for k in ANALYTICS},
                  warnings=warnings, raw_laps=raw_laps, clean_laps=clean_count,
                  compounds_seen=compounds_seen)


# ---------------------------------------------------------------------------
# QUALI_SPEC §4 — the qualifying estimators
# ---------------------------------------------------------------------------
#
# Two constants govern this whole section (§4 preamble):
#
#   The noise floor. A driver's own push laps inside ONE segment have a median standard
#   deviation of 0.186 s (2026 Monza), 0.357 s (2024 Monaco), 0.459 s (2024 Spa). Part of
#   that is track evolution inside the segment, so it is an UPPER bound on single-lap
#   repeatability -- the correct direction to hedge. `quali_teammate_h2h.session_sd_s`
#   stores it beside every gap so a surface can refuse to call 0.007 s a difference.
#
#   A tenth is not a tenth. 0.100 s is 0.088% of a Spa pole lap and 0.155% of an Austria
#   one -- a 1.76x spread. D9: percent is the comparable unit and seconds the legible one.
#   Both are stored; every ranking and every cross-circuit aggregate uses percent.

_SEGMENTS = (1, 2, 3)


def _quali_laps_frame(ids: SessionIds, laps_df: pd.DataFrame) -> pd.DataFrame:
    """The 46-column `laps` frame for a Q/SQ session (§3.2).

    `clean.annotate_quali_laps` already emits the six race-only columns under their
    DATABASE names (`fuel_kg`, `gap_to_leader_s`, ...), not FastF1's, so the fuel/gap block
    is a straight copy rather than `_laps_frame`'s rename.
    """
    out = _laps_core(laps_df, ids)
    for c in clean.QUALI_NULL_COLUMNS:
        out[c] = laps_df[c]
    for c in QUALI_LAP_COLUMNS:
        out[c] = laps_df[c]
    return cast_frame(out, "laps")


def quali_exclusion_report(laps_df: pd.DataFrame) -> pd.DataFrame:
    """`lap_exclusion_report` rows for a Q/SQ session — five applied, three reported-only.

    §2.3 notes 6 and 7 and §3.2: `excl_not_green`, `excl_inaccurate` and `is_outlier` are
    written out with their counts even though nothing filters on them, so a later reader
    sees a measured zero (or a measured 34) as a decision rather than as a missing rule.
    """
    total = int(len(laps_df))
    rules: list[tuple[str, int]] = []
    for c in clean._QUALI_EXCL_RULES:
        rules.append((c, int(laps_df[c].sum())))
    for c in clean._QUALI_REPORTED_ONLY:
        rules.append((f"{c} (reported, never applied)", int(laps_df[c].sum())))
    rules.append(("excl_disallowed (§2.4 diagnostic, never a filter)",
                  int(laps_df["excl_disallowed"].sum())))
    rules.append(("is_outlier (107% rule dropped for Q/SQ, always false)",
                  int(laps_df["is_outlier"].sum())))
    rules.append(("SURVIVING (representative)", int(laps_df["is_representative"].sum())))
    return pd.DataFrame(
        [{"rule": name, "laps_hit": n, "pct_of_all": (100.0 * n / total) if total else 0.0}
         for name, n in rules])


_WET_COMPOUNDS = ("INTERMEDIATE", "WET")


def quali_segment_times(ids: SessionIds, laps_df: pd.DataFrame,
                        waived: Sequence[tuple[str, int]] = ()) -> pd.DataFrame:
    """§3.4 / §4.4 — the long form: one row per (driver, segment) the driver ran a lap in.

    `spread_s` and `sd_s` describe this driver's PUSH laps inside this segment and are NULL
    below two of them (16.4% of driver-segments, measured). They are NOT consistency
    metrics: both contain track evolution, a changing fuel load between runs, and traffic
    (§4.4). `best_s` is a minimum over `repr_laps` laps and is biased downward in n, which
    is why the count is stored beside it rather than corrected away.
    """
    # §2.2 / v1.6 as-built. A WAIVED driver-segment is one the strict anchor could not
    # verify because the official Qk is a byte-identical copy of another segment's value.
    # The lap found in that window is stored, but nothing confirms it belongs to segment k,
    # so `verified` is false and every surface must suppress or mark the row instead of
    # printing it beside `quali_results.q{k}_s` as if the two agreed.
    waived_set = {(str(d), int(k)) for d, k in (waived or ())}
    rows: list[dict] = []
    seg = laps_df["quali_segment"]
    for k in _SEGMENTS:
        inseg = laps_df[seg == k]
        if inseg.empty:
            continue
        for drv, g in inseg.groupby("Driver", sort=True, observed=True):
            repr_g = g[g["is_representative"].astype(bool)]
            push = repr_g[repr_g["is_push_lap"].astype(bool)]["LapTimeSeconds"].dropna()
            best_s = best_lap = compound = tyre_life = None
            if len(repr_g) and repr_g["LapTimeSeconds"].notna().any():
                i = repr_g["LapTimeSeconds"].idxmin()
                best_s = float(repr_g.at[i, "LapTimeSeconds"])
                best_lap = _py(repr_g.at[i, "LapNumber"])
                compound = (None if _is_null(repr_g.at[i, "Compound"])
                            else str(repr_g.at[i, "Compound"]).upper())
                tyre_life = _py(repr_g.at[i, "TyreLife"])
            comps = {str(c).upper() for c in g["Compound"] if not _is_null(c)}
            rows.append({
                "session_id": ids.session_id,
                "driver_id": ids.code_to_driver_id[str(drv)],
                "segment": k,
                "laps_run": int(len(g)),                 # in-laps and out-laps included
                "repr_laps": int(len(repr_g)),
                "push_laps": int(len(push)),
                "best_s": best_s, "best_lap_number": best_lap,
                "gap_to_best_s": None, "gap_to_best_pct": None,
                "spread_s": float(push.max() - push.min()) if len(push) >= 2 else None,
                "sd_s": float(push.std(ddof=1)) if len(push) >= 2 else None,
                "compound": compound, "tyre_life": tyre_life,
                "wet_compound": bool(comps & set(_WET_COMPOUNDS)),
                "verified": (str(drv), int(k)) not in waived_set,
            })
    df = pd.DataFrame(rows, columns=EXPECTED_COLUMNS["quali_segment_times"])
    if df.empty:
        return df
    # Gap to the fastest time in THIS segment -- seconds and percent, per D9.
    for k in _SEGMENTS:
        m = (df["segment"] == k) & df["best_s"].notna()
        if not m.any():
            continue
        lead = float(df.loc[m, "best_s"].min())
        df.loc[m, "gap_to_best_s"] = df.loc[m, "best_s"] - lead
        df.loc[m, "gap_to_best_pct"] = 100.0 * (df.loc[m, "best_s"] - lead) / lead
    return df.sort_values(["segment", "gap_to_best_s"], na_position="last").reset_index(drop=True)


def _deepest(times: dict[int, float]) -> int | None:
    """The deepest segment (3, then 2, then 1) with a non-null official time."""
    for k in (3, 2, 1):
        if times.get(k) is not None:
            return k
    return None


def quali_results(ids: SessionIds, laps_df: pd.DataFrame, results, kind: str,
                  n_segments: int) -> pd.DataFrame:
    """§3.3 / §4.1 / §4.2 — the wide row, and D6's two gaps to pole.

    **D6, and why one number was never enough.** `gap_to_pole_s` is the TV number: the
    driver's best against the pole lap. It mixes segments -- pole is a Q3 lap on a
    rubbered-in track and a Q1-eliminated driver's best was set twenty minutes earlier on a
    greener one. `gap_to_pole_common_s` compares the two inside the deepest segment BOTH
    ran. Measured across eight 2024 sessions the two disagree for 10-14 of 20 drivers per
    session, by up to 7.539 s at wet Sao Paulo. Storing one would be a choice about which
    readers to mislead.

    **Must not claim** that the common-segment gap is condition-free: both drivers ran the
    same segment, not the same lap, the same tow or the same minute of track evolution. It
    removes the segment confound and nothing else. Nor is `gap_to_pole_pct` comparable
    across seasons at the same circuit (§0.4 note 7).

    `segments_entered` is read off LAP PRESENCE, never off the Q1/Q2/Q3 NaT pattern, which
    lies: 2024 R02 Jeddah HUL is P15 with a Q1 time and `Q2 = NaT` yet ran a lap in the Q2
    window -- he advanced and set no time (§4.2). No field size is ever hard-coded.
    """
    official = clean.quali_official_times(results)
    by_drv: dict[str, dict[int, float]] = {}
    for (drv, k), v in official.items():
        by_drv.setdefault(drv, {})[k] = v

    seg = laps_df["quali_segment"]
    entered = {str(d): int(g.max()) for d, g in
               laps_df.loc[seg.notna()].groupby("Driver", observed=True)["quali_segment"]}
    repr_n = laps_df[laps_df["is_representative"].astype(bool)].groupby(
        "Driver", observed=True).size().to_dict()
    push_n = laps_df[laps_df["is_push_lap"].astype(bool)].groupby(
        "Driver", observed=True).size().to_dict()

    res = results.sort_values("Position")
    pole_row = res.iloc[0]
    pole_abbr = str(pole_row["Abbreviation"])
    pole_times = by_drv.get(pole_abbr, {})
    pole_seg = _deepest(pole_times)
    pole_s = pole_times.get(pole_seg) if pole_seg else None

    rows: list[dict] = []
    for r in res.itertuples(index=False):
        abbr = str(r.Abbreviation)
        t = by_drv.get(abbr, {})
        best_seg = min((k for k in _SEGMENTS if t.get(k) is not None),
                       key=lambda k: t[k], default=None)
        best_s = t.get(best_seg) if best_seg else None
        ent = entered.get(abbr)
        if ent is None:
            # No lap inside any window (a DNS, or a car that never left the garage). The
            # CHECK requires 1..3, and "entered the session" is the honest floor.
            ent = 1
        common = next((k for k in (3, 2, 1) if t.get(k) is not None and pole_times.get(k) is not None),
                      None)
        best_lap = None
        if best_seg is not None:
            m = ((laps_df["Driver"] == abbr) & (seg == best_seg)
                 & laps_df["is_representative"].astype(bool) & laps_df["LapTimeSeconds"].notna())
            if m.any():
                best_lap = _py(laps_df.loc[laps_df.loc[m, "LapTimeSeconds"].idxmin(), "LapNumber"])
        rows.append({
            "session_id": ids.session_id,
            "driver_id": ids.code_to_driver_id[abbr],
            "team_id": ids.team_name_to_team_id[str(r.TeamName)],
            "position": _py(r.Position),
            "q1_s": t.get(1), "q2_s": t.get(2), "q3_s": t.get(3),
            "best_s": best_s, "best_segment": best_seg, "best_lap_number": best_lap,
            "segments_entered": ent,
            "knocked_out_in": None if ent >= n_segments else ent,
            "set_a_time": best_s is not None,
            "gap_to_pole_s": None if (best_s is None or pole_s is None) else best_s - pole_s,
            "gap_to_pole_pct": None if (best_s is None or pole_s is None)
            else 100.0 * (best_s - pole_s) / pole_s,
            "gap_to_pole_common_s": None if common is None else t[common] - pole_times[common],
            "gap_to_pole_common_pct": None if common is None
            else 100.0 * (t[common] - pole_times[common]) / pole_times[common],
            "gap_to_pole_segment": common,
            "n_repr_laps": int(repr_n.get(abbr, 0)),
            "push_laps": int(push_n.get(abbr, 0)),
            "times_source": "api" if str(kind).upper() == "Q" else "derived",
        })
    return pd.DataFrame(rows, columns=EXPECTED_COLUMNS["quali_results"])


def quali_teammate_h2h(ids: SessionIds, qres: pd.DataFrame, qseg: pd.DataFrame,
                       waived: Sequence[tuple[str, int]] = ()) -> pd.DataFrame:
    """§3.5 / §4.3 — one row per team pair, with the session's own noise floor beside it.

    `segment` is the deepest segment in which BOTH set a time. Comparing a driver's Q3
    against a teammate's Q1 compares two track conditions and two tyre choices; "deepest
    common segment" is the only apples-to-apples rule available and it is what a broadcast
    means by "two tenths up on his teammate".

    **`session_sd_s` is the honesty column and is not optional.** A single session's gap can
    sit far below the session's own repeatability: 2026 Monza Ferrari, LEC +0.007 s over HAM
    (0.009%), is **26x smaller** than that session's 0.186 s median within-segment sd. Storing
    the repeatability beside the gap is what lets a surface render "no measurable difference"
    instead of a number (§4.3 hard UI rule 2). `below_noise` is that verdict, precomputed.

    `classified_ahead` is separate from `driver_a` on purpose: who was classified ahead and
    who was quicker legitimately disagree when one teammate progresses and the other sets a
    faster time before going out. `divergent` marks it.

    A pair with no shared segment is `comparable = false` with NULL deltas and is excluded
    from every delta average downstream -- but the session still counts toward
    `sessions_counted` and the win, because who qualified ahead is defined even when one
    crashed in Q1. That missingness is not random and §6.3's caption says so.
    """
    # v1.6 as-built: a pair whose deepest common segment is UNVERIFIED for either driver is
    # `comparable = false` with NULL deltas. The delta is taken from the official `q{k}_s`,
    # and a waived segment's official value is a duplicate of another segment's -- at 2024
    # R21 Sao Paulo that would have made STR vs ALO a comparison against ALO's Q3 time
    # wearing a Q2 label. The session still counts toward `sessions_counted` and the win,
    # exactly as a pair with no shared segment does; only the delta is withheld.
    unverified = {(str(ids.code_to_driver_id.get(str(d), str(d))), int(k))
                  for d, k in (waived or ())}
    sd_lookup = {(str(r.driver_id), int(r.segment)): (None if _is_null(r.sd_s) else float(r.sd_s))
                 for r in qseg.itertuples(index=False)} if len(qseg) else {}
    # The pair's own two sd_s values are the preferred noise floor, but 16.4% of
    # driver-segments have fewer than two push laps and so have none. Falling back to the
    # SESSION's repeatability in that segment, then to the session's overall, is what §0.4
    # note 2 already quotes ("that session's own repeatability", 0.186 s at 2026 Monza) --
    # and the alternative is worse: 2024 China SQ Haas is a 0.005 s gap that would otherwise
    # be printed as a number because neither driver set a second push lap in SQ2.
    seg_median: dict[int, float] = {}
    if len(qseg):
        for k in _SEGMENTS:
            v = qseg.loc[qseg["segment"] == k, "sd_s"].dropna()
            if len(v):
                seg_median[k] = float(v.median())
    all_sd = qseg["sd_s"].dropna() if len(qseg) else []
    session_median = float(all_sd.median()) if len(all_sd) else None
    rows: list[dict] = []
    for team_id, g in qres.groupby("team_id", sort=True):
        members = list(g.sort_values("position").itertuples(index=False))
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                x, y = members[i], members[j]        # x is classified ahead of y
                tx = {k: getattr(x, f"q{k}_s") for k in _SEGMENTS}
                ty = {k: getattr(y, f"q{k}_s") for k in _SEGMENTS}
                segment = next((k for k in (3, 2, 1)
                                if not _is_null(tx[k]) and not _is_null(ty[k])), None)
                if segment is not None and ((str(x.driver_id), segment) in unverified
                                            or (str(y.driver_id), segment) in unverified):
                    segment = None
                if segment is None:
                    a, b, a_s, b_s, delta = x, y, None, None, None
                else:
                    a, b = (x, y) if float(tx[segment]) <= float(ty[segment]) else (y, x)
                    a_s = float((tx if a is x else ty)[segment])
                    b_s = float((ty if a is x else tx)[segment])
                    delta = b_s - a_s
                sds = [v for v in (sd_lookup.get((str(a.driver_id), segment)),
                                   sd_lookup.get((str(b.driver_id), segment)))
                       if v is not None] if segment is not None else []
                session_sd = (float(np.median(sds)) if sds
                              else seg_median.get(segment, session_median) if segment is not None
                              else None)
                rows.append({
                    "session_id": ids.session_id, "team_id": str(team_id),
                    "driver_a": str(a.driver_id), "driver_b": str(b.driver_id),
                    "segment": segment, "a_best_s": a_s, "b_best_s": b_s,
                    "delta_s": delta,
                    "delta_pct": None if delta is None else 100.0 * delta / a_s,
                    "comparable": segment is not None,
                    "classified_ahead": str(x.driver_id),
                    "divergent": str(x.driver_id) != str(a.driver_id),
                    "session_sd_s": session_sd,
                    "below_noise": bool(delta is not None and session_sd is not None
                                        and delta < session_sd),
                })
    return pd.DataFrame(rows, columns=EXPECTED_COLUMNS["quali_teammate_h2h"])


def quali_cross_segment_ok(qseg: pd.DataFrame) -> bool:
    """§4.6 — may this session's numbers be compared ACROSS segments at all?

    False when one segment ran on wets/inters and another did not, or when the segment
    leader's time moves by more than 3% between consecutive segments. 3% because the
    measured dry improvement is small and one-directional (Monaco -1.06%/-0.65%, Spa
    -0.87%/-0.60%, Monza -0.88%/-0.12%), while 2024 China SQ breaks it outright: SQ2
    1:35.606 -> SQ3 1:57.940, +23.4%.

    False does NOT suppress the session: the official classification and every per-segment
    number still publish. What is suppressed is every cross-segment aggregate.
    """
    if qseg is None or len(qseg) == 0:
        return True
    best: dict[int, float] = {}
    wet: dict[int, bool] = {}
    for k in _SEGMENTS:
        m = qseg["segment"] == k
        if not m.any():
            continue
        wet[k] = bool(qseg.loc[m, "wet_compound"].astype(bool).any())
        vals = qseg.loc[m, "best_s"].dropna()
        if len(vals):
            best[k] = float(vals.min())
    if wet and len(set(wet.values())) > 1:
        return False
    ks = sorted(best)
    return all(abs(best[b] / best[a] - 1.0) <= 0.03 for a, b in zip(ks, ks[1:]))


def build_quali_frames(session, ids: SessionIds, assumption_set_id: int,
                       kind: str | None = None,
                       cleaned: tuple[pd.DataFrame, dict] | None = None) -> Frames:
    """Every per-session table for a Q or SQ session (QUALI_SPEC §3.7).

    Writes `session_teams`, `session_entries`, `laps`, `lap_exclusion_report` and the three
    qualifying tables -- and deliberately **not** `results`, which stays "the classification
    of a race or sprint" (§3.3): a Q session supplies only `Position`, and the three numbers
    that matter have nowhere to go in it.

    `clean.clean_quali` is the D8 runtime gate. When it reports `ok = False` the official
    times are still verbatim and correct, so `laps` and `quali_results` are written and the
    two PER-SEGMENT tables are not; the caller writes `session_ingests.status = 'partial'`.
    """
    sid = ids.session_id
    if kind is None:
        # session.name is 'Qualifying' or 'Sprint Qualifying' on every cached session; the
        # caller should still pass the kind it wrote into `sessions.kind`.
        kind = "SQ" if "sprint" in str(getattr(session, "name", "")).lower() else "Q"
    kind = str(kind).upper()
    if kind not in ("Q", "SQ"):
        raise ValueError(f"build_quali_frames: kind must be 'Q' or 'SQ', got {kind!r}")
    status: dict[str, str] = {}
    warnings: list[str] = []

    tables = _identity_frames(session, ids)
    tables.pop("results", None)

    laps_df, diag = cleaned if cleaned is not None else clean.clean_quali(session)
    raw_laps = int(len(laps_df))
    repr_count = int(laps_df["is_representative"].sum())
    tables["laps"] = _quali_laps_frame(ids, laps_df)

    excl = _guard(status, "lap_exclusion_report", lambda: quali_exclusion_report(laps_df))
    if excl is not None:
        tables["lap_exclusion_report"] = cast_frame(pd.DataFrame({
            "session_id": sid, "assumption_set_id": int(assumption_set_id),
            "rule_order": excl.index.to_numpy(), "rule": excl["rule"],
            "laps_hit": excl["laps_hit"], "pct_of_all": excl["pct_of_all"],
        }), "lap_exclusion_report")
    else:
        tables["lap_exclusion_report"] = empty_frame("lap_exclusion_report")

    # quali_results is NOT guarded: the official times are the session's reason to exist.
    tables["quali_results"] = cast_frame(
        quali_results(ids, laps_df, session.results, kind, int(diag["windows"])), "quali_results")

    ok = bool(diag.get("ok", True))
    if ok:
        qseg = _guard(status, "quali_segment_times",
                      lambda: quali_segment_times(ids, laps_df, diag.get("waived", ())))
    else:
        qseg = None
        status["quali_segment_times"] = "empty"
        warnings.append("quali_anchor_unresolved: per-segment tables suppressed")
    tables["quali_segment_times"] = (cast_frame(qseg, "quali_segment_times") if qseg is not None
                                     else empty_frame("quali_segment_times"))

    if qseg is not None:
        h2h = _guard(status, "quali_teammate_h2h",
                     lambda: quali_teammate_h2h(ids, tables["quali_results"], qseg,
                                                diag.get("waived", ())))
    else:
        h2h = None
        status["quali_teammate_h2h"] = "empty"
    tables["quali_teammate_h2h"] = (cast_frame(h2h, "quali_teammate_h2h") if h2h is not None
                                    else empty_frame("quali_teammate_h2h"))

    cross_ok = quali_cross_segment_ok(qseg) if qseg is not None else False
    warnings.append(f"quali_cross_segment_ok={cross_ok}")
    warnings.append(f"quali_segment_repairs={int(diag.get('segment_repairs', 0))}")
    # QUALI_SPEC §2.2, and the one disagreement the four tables cannot express. A WAIVED
    # driver-segment is one whose OFFICIAL Qk is a byte-identical copy of another segment's,
    # so no lap can verify it: `quali_results.q{k}_s` keeps the official value while
    # `quali_segment_times.best_s` keeps the lap the driver actually set in that window, and
    # at 2024 R21 Sao Paulo the two stored numbers disagree by ALO -3.963 s, ALB +1.232 s,
    # PIA +0.493 s. As of the v1.6 as-built (§10) the row itself carries the flag --
    # `quali_segment_times.verified = false`, and the pair whose deepest common segment is
    # waived is `quali_teammate_h2h.comparable = false` with NULL deltas -- so no surface has
    # to read a warning string to avoid printing two contradictory numbers. The warning stays
    # because it is what `season.py`'s `sessions_caveated` and §6.3's captions key on.
    for r in diag.get("repairs", []):
        warnings.append(f"quali_repair: {r}")
    if diag.get("waived"):
        warnings.append("quali_waived_segments="
                        + ",".join(f"{d}:{k}" for d, k in diag["waived"]))
    warnings.append(f"quali_anchor_pre={diag.get('anchor_pre')}/{diag.get('anchor_pre_total')}")
    for f in diag.get("anchor_post_failures", []):
        warnings.append(str(f))

    ordered = {t: tables[t] for t in QUALI_TABLE_ORDER}
    frames_out = Frames(tables=ordered,
                        analytics_status={k: status.get(k, "empty") for k in QUALI_ANALYTICS},
                        warnings=warnings, raw_laps=raw_laps, clean_laps=repr_count,
                        compounds_seen=sorted({str(c).upper() for c in laps_df["Compound"]
                                               if not _is_null(c)}))
    frames_out.quali = {**diag, "kind": kind, "cross_segment_ok": cross_ok}
    return frames_out
