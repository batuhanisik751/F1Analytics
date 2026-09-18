// GAPFILL_SPEC §5.1 (v1.8) — every word the /driver skill panel says, in one place.
//
// D8: every fan-facing caption here is VERBATIM from §5.1 and is pinned byte-for-byte by
// captions.test.ts. DL-13: no caption contains a driver name, a rank, or a fitted count as
// a literal — every such value is a `{slot}` filled from `count(*)` at render time, and
// `fill()` throws if a slot is left unfilled rather than printing a brace to a fan.
// DL-12: caption IDs are NEVER reassigned. `C_SKILL_2` is the starting-grid-pace caption and
// stays attached to that skill forever; it is amended in place here, and the new skill's
// copy gets new IDs (C_SKILL_5..8).
// DL-10: "drivers are closer together over one lap" is forbidden copy (ratio 2.71 is the one
// conclusion that does not survive a scale-clean construction; every clean fit returns
// 3.0-3.6). FORBIDDEN_COPY below is the machine-readable half of that rule.

/** The seven §5.1 rows, in §5.1's display order. The query layer sorts on this. */
export const SKILL_ORDER = [
  "race_pace",
  "one_lap_pace",
  "grid_pace",
  "tyre_management",
  "wet",
  "sprint_one_lap",
  "trail_braking",
] as const;

export type SkillKey = (typeof SKILL_ORDER)[number];

/**
 * §5.1's row names. `one_lap_pace` is "Qualifying pace" and never "One-lap pace":
 * `decomp.ONE_LAP_LABEL` is pinned to this string by a mirror guard on the Python side
 * (WP-A1), and `ONE_LAP_FORBIDDEN_LABELS` forbids the other three spellings.
 */
export const SKILL_LABEL: Record<SkillKey, string> = {
  race_pace: "Race pace",
  one_lap_pace: "Qualifying pace",
  grid_pace: "Starting-grid pace",
  tyre_management: "Tyre management",
  wet: "Wet weather",
  sprint_one_lap: "Sprint qualifying",
  trail_braking: "Trail braking",
};

/**
 * §1.7: `race_pace` and `one_lap_pace` share ONE numeric axis; `grid_pace` keeps its own and
 * never joins them (D4). A normal score is an ordinal compression and a percent of a lap is
 * not, so the two cannot be put on one scale.
 */
export const SHARED_PP_AXIS: readonly SkillKey[] = ["race_pace", "one_lap_pace"];
export const SHARED_PP_AXIS_LABEL = "pp — percent of a lap, relative to the session's own field";

// --- §5.1 captions, VERBATIM -------------------------------------------------

/** `C-SKILL-2` — starting-grid pace, under the bar. AMENDED IN PLACE (DL-12): this ID stays
 * attached to this skill forever and is never reassigned. Words only — DL-8 forbids a
 * per-driver "what the penalties were worth" number, because that is a subtraction of a
 * normal score from a percentage and it is not computable. */
export const C_SKILL_2 =
  "This is fitted from where the car started. Starting position includes grid penalties and pit-lane starts, and this number does not subtract them — a five-place gearbox penalty enters it as driver slowness. Qualifying pace, above, is fitted on the laps themselves and includes none of that. Where the two bars disagree, the disagreement is the penalties, the pit-lane starts and the sprint-weekend grids. This bar is measured on a rank scale, not in lap time, so the two cannot be subtracted and this bar is not comparable to the two above it.";

/** `C-SKILL-5` — qualifying pace, under the bar, unconditional. Carries §1.2/DL-2's
 * measured sandbagging limitation as published copy rather than as a footnote. */
export const C_SKILL_5 =
  "This is fitted from each driver's first-segment qualifying lap — Q1, the one segment every driver runs — measured as a percentage of that session's own field average, across {nRows} laps and {nSessions} sessions. Percentages, not seconds, because a tenth at Monaco is not a tenth at Spa. Sprint qualifying is not in this number. Wet sessions are not in this number. A driver who cruises Q1 because his car will walk into Q3 is measured on that cruise, and we cannot tell that apart from being slow: for the drivers who reach Q3, the margin we can see in Q1 is about forty per cent smaller than the margin they show when it counts.";

/** `C-SKILL-6` — under the shared axis. Prints both STORED correlations —
 * `corr_one_lap_race` and `corr_one_lap_grid` off `mode2_fit_run`. The Spearman figures
 * exist nowhere in the database and must never be printed as if they did (WP-A1). */
export const C_SKILL_6 =
  "Qualifying pace and race pace are different numbers on the same scale: percent of a lap, against the field that was actually there. Across {nDrivers} drivers they agree at r = {corrOneLapRace}, so most of what they measure is the same thing measured twice. Starting-grid pace is on a different scale and cannot be put beside them; it agrees with qualifying pace in ranking at r = {corrOneLapGrid}.";

/** `C-SKILL-7` — above the shared axis, unconditional. §1.7 condition 4: a shared axis
 * is a shared SCALE, not a shared CLAIM. */
export const C_SKILL_7 =
  "{nCrossZero} of these {nDrivers} qualifying ratings include zero. Where two bars overlap, we have not shown you a difference — we have shown you two numbers we cannot separate.";

/** `C-SKILL-8` — the island caption, on the hatched bars, unconditional. §0.2: qualifying
 * adds rows, not edges — 72 edges / 4 components either way, zero qualifying-only edges. */
export const C_SKILL_8 =
  "Qualifying gave us {nQualiLaps} new laps and not one new transfer. These drivers have never raced for another team in this data, so where they sit against the rest of the grid is an assumption we made, not something we measured. About half of the uncertainty in this bar is that assumption rather than measurement, and more qualifying sessions will never narrow it.";

/** §5.1 one-line verdict reasons for the panel rows. `{nRows}`/`{nSessions}` are slots. */
export const ONE_LAP_VERDICT_LINE =
  "Fitted from {nRows} first-segment qualifying laps across {nSessions} sessions.";

/**
 * The two new refusal reasons are STORED on `mode2_driver_skill.not_measured_reason`
 * and rendered from there (§4.1: the reason is a prop from the database, not a guess).
 * These copies exist only so the caption test can prove the stored string is verbatim.
 * `sprint_one_lap` deliberately keeps `{nSqSessions}` UNFILLED in the database (DL-13)
 * and the panel substitutes it from `count(DISTINCT session_id)` on the quali audit.
 */
export const SPRINT_ONE_LAP_REASON =
  "We fitted it on {nSqSessions} sprint-qualifying sessions. The driver differences came out smaller than their own error bars, and seventeen sessions is not a corpus.";

export const TRAIL_BRAKING_REASON =
  "We can see where a driver came off the brakes on one lap. We cannot turn that into a rating: the same driver's number at the same corner changes as much between his own two laps of one weekend as it does between him and the rest of the grid.";
// --- slot filling (DL-13) ----------------------------------------------------

/**
 * Every fitted count the §5.1 captions need, all of them `count(*)` off the current fit
 * (§5.1: "The panel renders its counts from `count(*)`, never from a hard-coded number").
 * `corrOneLapRace` and `corrOneLapGrid` are the two PEARSON values stored on
 * `mode2_fit_run`; the Spearman pair is not stored anywhere and is never printed.
 */
export type CaptionSlots = {
  nRows: number;
  nSessions: number;
  nDrivers: number;
  nCrossZero: number;
  nQualiLaps: number;
  nSqSessions: number;
  corrOneLapRace: number;
  corrOneLapGrid: number;
};

const COUNT_SLOTS = new Set([
  "nRows",
  "nSessions",
  "nDrivers",
  "nCrossZero",
  "nQualiLaps",
  "nSqSessions",
]);

/** Counts read as prose ("1,135 laps"); correlations read to four decimals, as §1.6 prints them. */
export function formatSlot(key: string, value: number): string {
  return COUNT_SLOTS.has(key)
    ? new Intl.NumberFormat("en-US").format(Math.round(value))
    : value.toFixed(4);
}

/**
 * Substitutes `{slot}` in a §5.1 template. Throws on a slot the caller did not supply:
 * a caption that reaches a fan with a literal `{nRows}` in it is worse than a crash, and
 * DL-13's whole point is that these values arrive at render time or not at all.
 */
export function fill(template: string, slots: Partial<CaptionSlots>): string {
  const out = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = (slots as Record<string, number | undefined>)[key];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`caption slot {${key}} was not supplied`);
    }
    return formatSlot(key, value);
  });
  return out;
}

// --- the enforcement half (§5.1 "enforced, not caption-only") -----------------

/**
 * DL-10 / §5.1 rule 6 / §1.7. The measured ratio is tau_car/tau_driver = 3.50 in qualifying
 * against 3.31 in the race — one-lap performance is if anything slightly MORE car-dominated.
 * The opposite headline comes from the outcome-selected construction §1.1 rejects (2.71) and
 * is an artefact of unabsorbed stratum offsets, so it is forbidden rather than merely unused.
 * Matched case-insensitively against every string this module and `SkillPanel` render.
 */
export const FORBIDDEN_COPY: readonly string[] = [
  "closer together",
  "qualifying specialist",
  "overall rating",
  "ranked #",
  "out-qualified",
];

/**
 * §5.1 rule 1 and §1.7 condition 1: there is no combined rating, so there is no word for one.
 * These are the phrases an aggregate branch would have to introduce to describe itself.
 */
export const FORBIDDEN_AGGREGATE_COPY: readonly string[] = [
  "overall",
  "combined rating",
  "total rating",
  "radar",
];

/** `#3`, `8th`, `27th` — a rank printed as a numeral. DL-13 forbids it in any caption. */
export const RANK_NUMERAL = /#\s*\d|\b\d{1,3}(?:st|nd|rd|th)\b/i;

/**
 * Every §5.1 string this release ships, keyed by its caption ID, for the grep test.
 * Templates, not filled output — the filled output is checked separately.
 */
export const DRIVER_COPY: Record<string, string> = {
  "C-SKILL-2": C_SKILL_2,
  "C-SKILL-5": C_SKILL_5,
  "C-SKILL-6": C_SKILL_6,
  "C-SKILL-7": C_SKILL_7,
  "C-SKILL-8": C_SKILL_8,
  "verdict.one_lap_pace": ONE_LAP_VERDICT_LINE,
  "reason.sprint_one_lap": SPRINT_ONE_LAP_REASON,
  "reason.trail_braking": TRAIL_BRAKING_REASON,
};
