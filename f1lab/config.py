"""Modelling assumptions, kept in one place and deliberately visible.

Every number here is an assumption, not a measurement. The whole credibility of a
pace-correction model rests on stating these openly rather than burying them, so
anything downstream that bends a lap time imports its constant from this file.
"""

# ---------------------------------------------------------------------------
# Fuel
# ---------------------------------------------------------------------------

# Regulation maximum fuel load at the start of a race (FIA F1 Technical
# Regulations). Teams routinely underfill, so this is an upper bound and the
# correction it produces is therefore slightly generous.
FUEL_START_KG = 100.0

# Seconds of lap time cost per kilogram of fuel carried, at a reference circuit.
# Commonly quoted in the paddock as 0.03 s/kg/lap; the plausible range is roughly
# 0.025-0.035 depending on how power-limited the circuit is. Sensitivity to this
# value is worth reporting alongside any result that depends on it.
FUEL_EFFECT_S_PER_KG = 0.030

# The reference lap length the constant above is calibrated against, in km.
# Fuel burn per lap scales with distance, so a 7.0 km lap burns roughly 1.6x what
# a 4.3 km lap does, and the per-lap correction is scaled accordingly.
REFERENCE_LAP_KM = 4.3


# ---------------------------------------------------------------------------
# Lap cleaning
# ---------------------------------------------------------------------------

# A lap slower than this multiple of the driver's own median clean lap is treated
# as compromised (traffic, lift-and-coast, a moment off track) rather than as
# representative pace. 107% deliberately echoes the qualifying rule; it is loose
# enough to keep genuine tyre-death laps and tight enough to drop the junk.
OUTLIER_THRESHOLD = 1.07

# Track status codes that FastF1 reports per lap. A lap is only counted as clean
# when every character of its status string is "1" (all green).
GREEN_FLAG = "1"

# Minimum laps a stint must contain before a degradation slope is fitted to it.
# Below this the fit is dominated by the out-lap warm-up and tells you nothing.
MIN_STINT_LAPS_FOR_DEG = 5


# ---------------------------------------------------------------------------
# Strategy simulator (SIM_SPEC v1.1 §1). Every value is copied into the payload;
# the browser never hard-codes one.
# ---------------------------------------------------------------------------

SIM_SLICK_COMPOUNDS = ("SOFT", "MEDIUM", "HARD")
SIM_MIN_COMPOUND_LAPS = 30        # fit rows a compound needs to be parameterised
SIM_MIN_DRIVER_LAPS = 8           # fit rows a driver needs a dummy (matches pace_ranking min_laps)
SIM_MIN_DRIVERS = 6
SIM_MIN_FIT_LAPS = 200
SIM_EVO_PRIOR_SD = 0.01           # s/lap, ridge pseudo-observation on evo
SIM_RESID_SD_GUESS = 0.75         # s, weight of the pseudo-observation
SIM_DESIGN_COND_MAX = 1e6
SIM_K_DC = 10                     # shrinkage laps for driver x compound
SIM_DEG_FLOOR = 0.0               # s/lap
SIM_EXTRAPOLATION_LAPS = 5
SIM_STINT_MIN_LAPS = 8
SIM_STINT_MIN_STINTS = 5
SIM_STINT_TAU_LEVEL_PRIOR = 0.25  # s
SIM_STINT_TAU_SLOPE_PRIOR = 0.04  # s/lap
SIM_STINT_TAU_LEVEL_MAX = 0.8
SIM_STINT_TAU_SLOPE_MAX = 0.10
SIM_NOISE_SD_FLOOR = 0.25
SIM_NOISE_T_DF = 4                # used only by the pooled pit-loss fallback draw
SIM_MIN_GREEN_STOPS = 5
SIM_PIT_SAMPLES_MAX = 60
SIM_MIN_SC_STOPS = 3
SIM_SC_PIT_FACTOR_PRIOR = 0.86    # measured, 99 SC stops / 1328 green stops, 2024-26
SIM_VSC_PIT_FACTOR_PRIOR = 0.95   # measured, 132 VSC stops
# Plausibility band for a per-race SC/VSC pit factor (§1.7). A stop under caution still pays the
# full pit-lane transit, so its cost relative to a green stop cannot be near zero or negative, and it
# cannot plausibly cost far more than a green stop either. Observed across the 57 modelled races the
# in-band per-race factors run 0.60-1.15 (SC median 0.69, VSC median 0.90), while the four out-of-band
# values are -0.45, 1.74, 1.77 and 2.51 - measurement failures from a handful of noisy stops, not
# findings about the race. Outside [MIN, MAX] the race factor is dropped and the race -> pooled ->
# config-prior chain supplies the value instead.
SIM_PIT_FACTOR_MIN = 0.3
SIM_PIT_FACTOR_MAX = 1.3
SIM_MIN_CARS_FOR_DELTA = 3
# delta_L centring (§1.8). The lap model is fit on representative laps only, but delta_L is the median
# over every timed non-pit lap, so it carries a constant level that base pace already represents: across
# the 57 modelled races the median delta over GREEN laps is -0.08 s/lap (per-race -0.31..+0.01, negative
# in 56 of 57), and the calibration replay -- whose representative-lap misfit is exactly -sum(delta) over
# the fit laps -- inherits it as a +0.06 s/lap "model is optimistic" bias. Every delta_L is therefore
# shifted so the ordinary green lap sits at 0; SC/VSC laps keep their full slowdown. The level is a
# symmetrically trimmed mean, not a plain median: the sum that reaches calibration follows the mean, and
# green-lap deltas are right-skewed (yellow-flag / traffic laps that lap_status still calls green), so the
# plain median over-corrects -- measured, it moves median |misfit| 0.067 -> 0.035 s/lap but costs 27
# "calibrated" badges, while the trimmed mean gives 0.067 -> 0.023 s/lap and improves 46 of 55 races.
SIM_DELTA_CENTRE_TRIM = 0.05      # drop the top and bottom 5 % of green deltas before averaging
SIM_DELTA_CENTRE_MIN_LAPS = 10    # fewer known green laps than this -> no centring (offset 0)
SIM_PRIOR_SC_LAPS = 200
SIM_MIN_MODELLED_LAPS = 20
SIM_CALIB_GOOD_S_PER_LAP = 0.15
SIM_CALIB_ROUGH_S_PER_LAP = 0.40
SIM_DRAWS = 4000                  # browser N; copied into the payload so the caption and engine agree
SIM_SEED = 20240101

# ===========================================================================
# v1.2 race companion (MODE1_SPEC §6.4). Every constant below enters the
# assumption snapshot, so tweaking one changes the assumption hash and every
# season needs a recompute -- that is the mechanism, not an accident.
# ===========================================================================

# --- Win probability (MODE1_SPEC §1) ---------------------------------------
WP_N_FOLDS = 10
WP_INNER_FOLDS = 5
WP_MODEL_PARAMS = dict(max_iter=80, learning_rate=0.08, max_leaf_nodes=4,
                       min_samples_leaf=500, l2_regularization=10.0, max_bins=128,
                       early_stopping=False, random_state=7)
WP_CALIBRATION = "none"                 # "none" | "isotonic"; MEASURED negative, §1.7
WP_RELIABILITY_BINS = (0.0, .01, .025, .05, .10, .20, .30, .45, .60, .80, 1.0)
WP_SWING_MIN_MASS = 0.15
WP_SWING_MAX_ANNOTATIONS = 5
WP_SWING_DEDUP_LAPS = 2
WP_GAP_LEADER_CLIP_S = 300.0
WP_GAP_AHEAD_CLIP_S = 120.0
WP_GAP_BEHIND_DEFAULT_S = 60.0
WP_FORM_RACES = 5
WP_LEAKAGE_TRIPWIRE_BRIER = 0.005       # stored OOF Brier must exceed this
# Tables/columns that may never appear in winprob.build_features's SQL (§1.3).
WP_BANNED_SOURCES = (
    "results.status", "results.classified_position", "results.laps_completed",
    "results.result_time_s", "results.points", "results.position",
    "sessions.winner_driver_id",
    "pace_ranking", "degradation_fits", "compound_degradation",
    "teammate_h2h", "driver_season_summary",
    "sim_race_params", "sim_driver_params", "sim_compound_params",
    "sim_driver_compound", "circuit_odi",
)
WP_ALLOWED_RESULT_COLUMNS = ("grid_position",)

# --- Title odds (MODE1_SPEC §2) --------------------------------------------
TITLE_PL_HALF_LIFE = 8.0
TITLE_PL_RIDGE = 1.0
TITLE_PL_TEMPERATURE = 1.0
TITLE_SIM_DRAWS = 20000
TITLE_THETA_BOOTSTRAP = 200
TITLE_MIN_RACES_FOR_PL = 5
TITLE_SEED = 20260913
DNF_PRIOR_STRENGTH = 10.0
# Per-season points overrides; empty means "derive the schedule from that season's own
# results" (§2.1). A single global MAX_RACE_POINTS is wrong -- see §0.4.
POINTS_SCHEDULE_OVERRIDES: dict[int, tuple] = {}

# --- Weekend preview (MODE1_SPEC §3) ---------------------------------------
PREVIEW_CIRCUIT_ALIASES = {"Yas Marina": 70, "Kuala Lumpur": 63}   # §3.2
PREVIEW_HAZARD_PRIOR_RACES = 3.0
PREVIEW_SIM_DRAWS = 20000
PREVIEW_AFFINITY_WEIGHT = 0.0           # MEASURED negative, §3.5
PREVIEW_BACKTEST_FROM = (2025, 5)
OTDI_SHRINKAGE_RACES = 1.7
OTDI_RATE_EASY = 0.050
OTDI_RATE_HARD = 0.005
OTDI_MIN_RACES = 2

# --- Moments + optimal stint (MODE1_SPEC §4) -------------------------------
MOMENTS_FIELD_WIDE_SHARE = 0.30
MOMENTS_MAX_PER_RACE = 8
COLLAPSE_S = 1.5
COLLAPSE_HOLD = 3
UNDERCUT_MAX_GAP = 1
UNDERCUT_WINDOW = 4
CLIFF_TAIL = 4
CLIFF_MIN_S = 1.2
CLIFF_FACTOR = 2.0
PUNCTURE_S = 6.0
PUNCTURE_MIN_LOST = 2
SC_LUCK_MIN_GAIN = 2
SC_RELATIVE_GAIN = 2
OPT_STINT_MIN_SLOPE = 0.01
OPT_STINT_MIN_SESSION_FITS = 6
OPT_STINT_WET_COMPOUNDS = ("INTERMEDIATE", "WET")

# --- Mode 2: driver-vs-car decomposition (MODE2_SPEC §7.3) -----------------
# Every constant below enters the assumption hash. TITLE_PL_TEMPERATURE is NOT
# touched (§4.1): mode2_points_calib carries its own fitted temperature instead.
MODE2_MIN_LAPS_FIT            = 24        # §1.3 inclusion filter
MODE2_MIN_CARS_IN_RACE        = 8
MODE2_EXCLUDE_BADGES          = ("poor",)
MODE2_SPEC                    = "S"       # the shipping specification (§1.6)
MODE2_REML_START              = (0.30, 0.90, 0.35, 0.42)
MODE2_CI_LEVEL                = 0.90
MODE2_BOOTSTRAP_REPS          = 400
MODE2_HISTORY_BOOTSTRAP_REPS  = 120
MODE2_BOOTSTRAP_JOBS          = 8
MODE2_SEED                    = 20260914
MODE2_SIGMA_SPEC              = 0.10      # pp, on LEVELS       (§1.8, §2.3)
MODE2_SIGMA_SPEC_CONTRAST     = 0.04      # pp, on CONTRASTS    (§1.8, §2.3)
MODE2_CF_INTERACTION_PCT      = 0.10      # pp, MEASURED (§1.7), counterfactuals only
MODE2_MIN_COMPONENT_DRIVERS   = 5         # below this a component is 'floating'
MODE2_MIN_HAZARD_LAPS         = 200
MODE2_POINTS_DRAWS            = 4000
MODE2_UNCERTAINTY_DRAWS       = 200
MODE2_TEMPERATURE_GRID        = (0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.70, 1.00)
MODE2_CF_MAX_SCENARIOS        = 900       # §7.7 budget guard
MODE2_KEEP_FITS               = 3
MODE2_TYRE_REJECT_THRESHOLD   = 0.20      # evidence_share above this => build fails (§3.3)

# --- Mode 2 Gap A: the one-lap (qualifying) skill (GAPFILL_SPEC §1.3, §2.4) --
# Every constant below enters the assumption hash via assumptions.snapshot(), so a
# change here produces a NEW assumption_set_id and a NEW fit_id rather than silently
# rewriting a stored number (§2.4, §6.6).
MODE2_QUALI_SEGMENT           = 1         # §1.1 V3: segment 1 only, never the deepest
MODE2_QUALI_MIN_DRIVERS       = 8         # §1.1 minimum segment-1 drivers in a session
MODE2_QUALI_KINDS             = ("Q",)    # §1.8: sprint qualifying is NOT pooled in
MODE2_QUALI_REML_START        = (0.16, 0.56, 0.38)   # §2.1 constant start, not data-dependent
MODE2_QUALI_THIN_N            = 25        # §1.4 thin-data flag threshold on n_obs
MODE2_GRID_RETIRE_R           = 0.95      # §1.6 pre-registered retirement threshold (gate G3)
