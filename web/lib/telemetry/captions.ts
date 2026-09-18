// TELEMETRY_SPEC v1.7 §6.3 — the eight verbatim captions of the telemetry layer.
//
// These strings ship EXACTLY as §6.3 writes them. `captions.test.ts` pins every one of
// them character-for-character, so "verbatim" is mechanically enforced rather than
// aspirational (§6.4). A caption is not decoration here: §0.4 lists what this data can
// NEVER support — which driver is faster, which car is faster, how a stint degraded,
// whether a lap was compromised by traffic, fuel load, engine mode, or how much of a
// straight-line advantage was a tow — and these sentences are the only place the page
// says so.
//
// Conventions, following `components/quali/captions.ts`:
//   * plain strings, no JSX and no markdown — §6.3's `**bold**` marks the LEAD SENTENCE
//     of C-TEL-1, C-TEL-2 and C-TEL-8; the lead is exported separately where a surface
//     wants to weight it, and the full caption always contains it.
//   * `{...}` placeholders are substituted by the builders below, never by the caller,
//     so a surface cannot ship a caption with a number the template did not ask for.
//   * every surface renders them through <Caption>, which does not re-wrap or truncate.

/** C-TEL-1's lead sentence (§6.3 sets it bold). */
export const C_TEL_1_LEAD = "One lap against one lap.";

/**
 * C-TEL-1 — above EVERY delta trace, unconditional, never in a footer.
 * The unconditional placement is the point: a caveat under a chart is read after the
 * conclusion has already been drawn.
 */
export const C_TEL_1 =
  "One lap against one lap. These are the two drivers' fastest laps of this session and " +
  "nothing else. They were set on different fuel loads, different tyre ages and a track " +
  "that changed between them. The trace is cumulative, so one held-up corner shifts every " +
  "metre after it — read where the line changes slope, not where it ends up. This chart " +
  "shows where one lap was quicker than the other. It does not show which driver, or which " +
  "car, is faster.";

/** C-TEL-2's template. The three numbers are computed per pair — see `cTel2`. */
export const C_TEL_2_TEMPLATE =
  "Aligned on distance around the lap. The trace closes to within {closure_ms} ms of the " +
  "official gap and matches the drivers' own sector times to within {sector_ms} ms — so " +
  "read the shape of this line, not the third decimal. {n_gaps} stretches of the lap, " +
  "shaded grey, have no measurement in them and are drawn by interpolation.";

/**
 * §6.3: when `closure_ms` exceeds half the official gap, C-TEL-2 is PRECEDED by this.
 * §5.2.2's relative rule — a 399 ms error drawn onto a 180 ms gap must not read as clean
 * merely because it cleared an absolute threshold.
 */
export const C_TEL_2_EXCEEDS_HALF_GAP =
  "The alignment error on this pair is larger than half the gap itself — read the shape of " +
  "the line, not its size.";

/** C-TEL-3 — under the track map. `{n_samples}` is that lap's own sample count. */
export const C_TEL_3_TEMPLATE =
  "Painted from {n_samples} samples taken ten times a second on one lap. The shape is the " +
  "car's path on that lap — not the racing line, not the circuit's centreline.";

/**
 * C-TEL-4 — on the picker, whenever A and B are NOT teammates. It fires the moment a
 * non-teammate pair is chosen and routes the question to the was-it-the-car page, which
 * is the page that can actually answer it.
 */
export const C_TEL_4 =
  "These two drive different cars. Almost everything you can see below is the car, the fuel " +
  "or the tyre, and this page cannot tell you which. Compare teammates to get closer to a " +
  "like-for-like run — and even then, read what this page can't tell you. If you want the " +
  "driver separated from the car, that is the was-it-the-car page, which uses thousands of " +
  "laps and says how uncertain it is.";

/**
 * C-TEL-5 — on a race session, WHERE THE SECOND-DRIVER PICKER WOULD OTHERWISE BE.
 * T10: the cross-driver trace is an absent control, not a disabled button.
 */
export const C_TEL_5 =
  "No cross-driver comparison on a race lap. These laps were run in traffic, on fuel loads " +
  "that fall all race, on tyres of different ages — so a side-by-side trace would look like " +
  "a measurement and would not be one. The map and the channels below are one driver's lap, " +
  "and that is all this data can honestly show for a race.";

/** C-TEL-6 — under the corner card. */
export const C_TEL_6 =
  "Corner numbering and corner positions come from the timing provider's circuit map, not " +
  "from the track's own signage. A blank braking point means the corner was taken flat, not " +
  "that the data is missing. Corners taken in one braking event are bracketed together.";

/**
 * C-TEL-7 — in the channel stack, WHERE DRS WOULD BE. Measured: `drs` was 0 for every
 * sample of every lap in 2026 R13 Q. An empty DRS row would be read as "nobody opened
 * it" — absent and a measured zero must not look the same (§0.3, §6.5).
 */
export const C_TEL_7 =
  "No DRS signal in this session's data. That is a gap in what was recorded, not a lap " +
  "where nobody opened it.";

/** C-TEL-8's template — under the summary strip, wherever `overlap_pct > 3`. */
export const C_TEL_8_TEMPLATE =
  "{overlap_pct}% of this lap reports full throttle and braking at the same time. The two " +
  "channels are separate feeds merged onto one timeline, so this is how they were recorded " +
  "and not how the car was driven. Don't read the throttle and brake shares to the tenth.";

/** The threshold §6.3 attaches to C-TEL-8. */
export const C_TEL_8_OVERLAP_THRESHOLD_PCT = 3;

/** Every caption whose text is fixed — what `captions.test.ts` iterates. */
export const FIXED_CAPTIONS = {
  C_TEL_1,
  C_TEL_2_EXCEEDS_HALF_GAP,
  C_TEL_4,
  C_TEL_5,
  C_TEL_6,
  C_TEL_7,
} as const;

/** Every caption that carries a computed substitution. */
export const CAPTION_TEMPLATES = {
  C_TEL_2_TEMPLATE,
  C_TEL_3_TEMPLATE,
  C_TEL_8_TEMPLATE,
} as const;

function substitute(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const token = `{${key}}`;
    if (!out.includes(token)) {
      throw new Error(`captions: template has no ${token} to substitute`);
    }
    out = out.split(token).join(value);
  }
  const leftover = out.match(/\{[a-z_]+\}/);
  if (leftover) throw new Error(`captions: unsubstituted ${leftover[0]}`);
  return out;
}

export type CTel2Input = {
  /** `closureCheck().closureErrorS`, in SECONDS. Measured 4-109 ms under chord. */
  closureErrorS: number;
  /**
   * The worst sector-boundary residual of this pair, in SECONDS, or null when the
   * sector inputs were absent. Null is honest: the sentence then does not claim a
   * match it did not measure.
   */
  worstSectorResidualS: number | null;
  /** `gapIntervals(...).length` — stretches with no measurement in them. */
  nGaps: number;
  /** `closureCheck().errorExceedsHalfGap` — when true the caption LEADS with the warning. */
  errorExceedsHalfGap?: boolean;
};

/** Milliseconds, rounded to whole ms: §6.2 — anything under a tenth here is alignment noise. */
function ms(seconds: number): string {
  return String(Math.round(Math.abs(seconds) * 1000));
}

/**
 * C-TEL-2 with this pair's own numbers. When the sector residual is unknown the clause
 * that would quote it is dropped rather than filled with a plausible number.
 */
export function cTel2(input: CTel2Input): string {
  const base =
    input.worstSectorResidualS === null
      ? substitute(
          C_TEL_2_TEMPLATE.replace(
            " and matches the drivers' own sector times to within {sector_ms} ms",
            "",
          ),
          { closure_ms: ms(input.closureErrorS), n_gaps: String(input.nGaps) },
        )
      : substitute(C_TEL_2_TEMPLATE, {
          closure_ms: ms(input.closureErrorS),
          sector_ms: ms(input.worstSectorResidualS),
          n_gaps: String(input.nGaps),
        });
  return input.errorExceedsHalfGap ? `${C_TEL_2_EXCEEDS_HALF_GAP} ${base}` : base;
}

/** C-TEL-3 with the lap's own sample count. Measured ~626 on one flying lap. */
export function cTel3(nSamples: number): string {
  return substitute(C_TEL_3_TEMPLATE, { n_samples: String(Math.round(nSamples)) });
}

/**
 * C-TEL-8, or null when `overlap_pct` is at or below the §6.3 threshold — the caption
 * exists to explain an artifact that is present, not to appear on every lap.
 */
export function cTel8(overlapPct: number | null | undefined): string | null {
  if (overlapPct === null || overlapPct === undefined) return null;
  if (!(overlapPct > C_TEL_8_OVERLAP_THRESHOLD_PCT)) return null;
  return substitute(C_TEL_8_TEMPLATE, { overlap_pct: overlapPct.toFixed(1) });
}

// ====================================================================================
// GAPFILL_SPEC v1.8 §5.2 — Gap B: the corner card's "off the brakes" column.
//
// Seven captions, C-BRK-1..7, plus the six C-BRK-3 reason strings. Every one of them is
// VERBATIM in §5.2 (D8) and is pinned byte-for-byte by `captions.test.ts`.
//
// R5 is why this block is written the way it is. A wrong number already shipped in a
// caption here — "sampled about every 15 metres, good to about 8 metres", where 15.45 m
// was a per-zone MAXIMUM reported as a median. It was conservative, it read as careful,
// and it had already been used to calibrate a refusal gate and a rounding rule before
// anyone re-checked it. So: **every number that reaches a caption is either a template
// slot filled from the database or a member of PINNED_CAPTION_NUMBERS below**, and
// `captions.test.ts` fails the build on any numeric literal in any C-BRK string that is
// not in that list. Nothing here is re-derived and nothing is copied from a brief.
// ====================================================================================

/**
 * Every numeric literal permitted to appear in a C-BRK caption, with the provenance
 * that licenses it. The test extracts the digits from each caption and asserts set
 * membership against this table, so adding a number to a caption without adding it
 * here — the exact R5 failure — cannot compile past the test.
 */
export const PINNED_CAPTION_NUMBERS: ReadonlyArray<{
  readonly literal: string;
  readonly value: number;
  readonly provenance: string;
}> = [
  {
    literal: "3,329",
    value: 3329,
    // §3.3's paired-corner table. NOT re-derived by WP-B1; see captions.test.ts for the
    // n-mismatch this caption carries into the shipped copy, reported and not adjusted.
    provenance: "GAPFILL_SPEC §3.3 paired-n table (brake_release_to_apex_m row)",
  },
  {
    literal: "0.001",
    value: 0.001,
    provenance: "GAPFILL_SPEC §3.3 paired-n table (taper row, de-meaned repeat r)",
  },
] as const;

/**
 * WP-B1's re-derived resolution constants, carried here so C-BRK-1's spelled-out prose
 * is mechanically tied to the numbers it paraphrases rather than to a memory of them.
 *
 * REPORT-BOTH: §3.2 and DL-15 pin the release-edge bracketing step at 3.89 m median /
 * 12.21 m p95 over n = 739 on four sessions. WP-B1 re-derived it over all 20,330 braked
 * rows and measured 4.13 m median / 13.34 m p95. Neither figure has been adjusted to
 * agree with the other. C-BRK-1's text survives both readings unchanged, because it
 * says "about four metres", and 3.89 and 4.13 both round to four — which is exactly the
 * tolerance the caption claims. The test below asserts that round-trip rather than
 * trusting it.
 */
export const TRAIL_RELEASE_STEP_MEDIAN_M = 4.13; // WP-B1 pinned; §3.2 reads 3.89
export const TRAIL_RELEASE_STEP_P95_M = 13.34; // WP-B1 pinned; §3.2 reads 12.21
/** §3.2 MEASURED median-of-median in-zone step. Not re-derived by WP-B1. */
export const TRAIL_IN_ZONE_STEP_MEDIAN_M = 4.94;
/** §5.2 / §3.2: displayed to the nearest 5 m, never to sub-5 m precision. */
export const OFF_THE_BRAKES_ROUND_M = 5;
/** §3.2: two drivers within 10 m at one corner have not been shown to differ. */
export const OFF_THE_BRAKES_INDISTINGUISHABLE_M = 2 * OFF_THE_BRAKES_ROUND_M;

/**
 * DL-22 — the discredited v1 detector, recorded as WRONG so nobody rediscovers it.
 *
 * A looser first detector (n >= 5, zone >= 30 m, no edge-guard, no chord-compression
 * refusal) produced a per-driver index with r(Q, SQ) of +0.26 to +0.47. Tightening the
 * gates destroyed it: the apparent driver signal was the compound-section artefact —
 * some drivers' zones were being charged to a later corner's low point more often than
 * others'. This constant exists to be cited, never rendered; `captions.test.ts` asserts
 * neither number reaches any fan-facing string.
 */
export const DISCREDITED_V1_DETECTOR_R = { low: 0.26, high: 0.47, verdict: "wrong" } as const;

/** C-BRK-1 — under the corner card, unconditional. Verbatim §5.2. */
export const C_BRK_1 =
  "\"Off the brakes\" is how far before the apex the brake came off, measured from the " +
  "brake channel, which is on-or-off. A negative number means the brake was still on at " +
  "the apex. Inside a braking zone the channel is sampled about every five metres, and " +
  "the moment it switches off is pinned to about four metres — so we round to the nearest " +
  "five, and two drivers within ten metres of each other have not been shown to differ.";

/**
 * C-BRK-2 — corner card header, beside the column name. Verbatim §5.2.
 * ON THE FORBIDDEN-VOCABULARY EXCEPTION LIST: it exists to say the app cannot measure
 * pressure, so the word has to be allowed to appear in it.
 */
export const C_BRK_2 =
  "This measures how long the brake was touched, not how hard. There is no brake-pressure " +
  "channel in this data, so a driver feathering the brake to the apex and a driver still " +
  "hard on it look exactly the same here.";

/**
 * C-BRK-4 — the refusal card, at the same visual weight as the column.
 * ALSO on the forbidden-vocabulary exception list, and for the same reason.
 */
export const C_BRK_4 =
  "We also tried to measure how the brake pressure tapers off — the part of trail braking " +
  "people actually mean. We cannot. With no pressure channel the only proxy is how the " +
  "deceleration decays across the braking zone, and we measured it: on 3,329 corners where " +
  "the same driver took the same corner twice in one weekend, that number agreed with " +
  "itself at r = 0.001. It is noise, so we are not showing it.";

/** C-BRK-5 — beneath C-BRK-4, unconditional. Verbatim §5.2. States R4's pre-condition. */
export const C_BRK_5 =
  "We also cannot turn this into a rating for a driver. We tried: the same driver, the " +
  "same corner, the same car, two qualifying sessions of one weekend. His number changed " +
  "about as much between his own two laps as it changes between him and everyone else. " +
  "The missing ingredient is not a better brake channel — it is more laps. We store one " +
  "lap per driver per session.";

/** C-BRK-6 — the confound disclosure, above the column. Verbatim §5.2. */
export const C_BRK_6 =
  "Two drivers' braking numbers differ for reasons that have nothing to do with " +
  "technique: how much fuel was in the car, how old the tyres were, how much wing the " +
  "team chose, and where each driver was on the road. None of those are in this data. " +
  "This shows what the brake channel did on one lap. It does not show who brakes better.";

/** C-BRK-7 — scope, in the card header. Verbatim §5.2. */
export const C_BRK_7 =
  "Braking numbers come from qualifying laps. Only one race in this database has " +
  "telemetry, so nothing here describes a race lap.";

/**
 * The six `trail_status` words of migration 0010's CHECK, closed. This union is the
 * component's prop type, so a status the database cannot store is also a status the
 * card cannot be handed.
 */
export const TRAIL_STATUSES = [
  "measured",
  "taken_flat",
  "shared_zone_non_terminal",
  "too_few_samples",
  "release_step_too_wide",
  "implied_decel_impossible",
] as const;

export type TrailStatus = (typeof TRAIL_STATUSES)[number];

/**
 * C-BRK-3 — the reasoned blank. One string per refusal, verbatim §5.2, passed to the
 * card as a prop FROM THE DATABASE and never inferred from a NULL (§4.1). `measured`
 * carries no string because a number is shown instead; it is `null`, not "", so a
 * missing case is a type error rather than an empty cell.
 */
export const C_BRK_3_REASONS: Readonly<Record<TrailStatus, string | null>> = {
  measured: null,
  taken_flat: "Nobody braked for this corner. It is taken flat.",
  shared_zone_non_terminal:
    "This corner shares one braking event with the corner after it, and a shared braking " +
    "event has only one release — it belongs to the last corner in the complex.",
  too_few_samples:
    "The braking zone here has too few samples to say where the brake came off.",
  release_step_too_wide:
    "The gap between samples at the moment the brake came off is wider than the answer " +
    "would be worth.",
  implied_decel_impossible:
    "The speed trace through this corner implies a deceleration no car can produce, so " +
    "the samples here are not trustworthy.",
} as const;

/** §5.2's three states and no fourth: a number, a sentence for flat, a sentence for refused. */
export type OffTheBrakesCell =
  | { kind: "measured"; text: string; releaseToApexM: number }
  | { kind: "taken_flat"; reason: string }
  | { kind: "refused"; status: TrailStatus; reason: string };

/** Every C-BRK caption whose text is fixed — what the caption test iterates. */
export const BRAKE_CAPTIONS = {
  C_BRK_1,
  C_BRK_2,
  C_BRK_4,
  C_BRK_5,
  C_BRK_6,
  C_BRK_7,
} as const;

/** §5.2's forbidden vocabulary, greppable. Matched case-insensitively as substrings. */
export const FORBIDDEN_BRAKE_VOCABULARY = [
  "pressure",
  "taper",
  "modulation",
  "bleeding off",
  "trail-braking score",
] as const;

/** The only two captions allowed to contain it — they exist to say it cannot be measured. */
export const FORBIDDEN_VOCABULARY_EXCEPTIONS = ["C_BRK_2", "C_BRK_4"] as const;

/**
 * §5.2: rendered to the NEAREST 5 m, signed, "at the apex" for a negative value.
 * §5.2.5: never displayed to sub-5 m precision.
 *
 * The rounding is not cosmetic — it is the resolution. The release edge is located to
 * about four metres (TRAIL_RELEASE_STEP_MEDIAN_M) and the tail is three times that, so
 * a tenth of a metre on this column would be a claim the instrument cannot make.
 *
 * A value that rounds to zero prints the words alone rather than "0 m": within +/-2.5 m
 * of the apex is inside the measurement's own error, and a signed zero would invite a
 * reader to tell +1 m from -1 m.
 */
export function roundOffTheBrakesM(releaseToApexM: number): number {
  return Math.round(releaseToApexM / OFF_THE_BRAKES_ROUND_M) * OFF_THE_BRAKES_ROUND_M;
}

export function formatOffTheBrakes(releaseToApexM: number): string {
  const n = roundOffTheBrakesM(releaseToApexM);
  if (n > 0) return `+${n} m`;
  if (n < 0) return `${n} m at the apex`;
  return "at the apex";
}

/**
 * The single place a stored row becomes a rendered cell. Three states, three renderings
 * and no fourth (§5.2.6) — and the refusal reason comes from `trailStatus`, which the
 * database wrote, never from the NULL.
 *
 * A `measured` row with no number is a contradiction the database's own CHECK forbids;
 * it is surfaced as `too_few_samples` rather than as a blank, so a broken write shows up
 * as a wrong reason on the page instead of silently as missing data.
 */
export function offTheBrakesCell(row: {
  trailStatus: TrailStatus;
  brakeReleaseToApexM: number | null;
}): OffTheBrakesCell {
  if (row.trailStatus === "measured" && row.brakeReleaseToApexM !== null) {
    return {
      kind: "measured",
      text: formatOffTheBrakes(row.brakeReleaseToApexM),
      releaseToApexM: row.brakeReleaseToApexM,
    };
  }
  const status: TrailStatus =
    row.trailStatus === "measured" ? "too_few_samples" : row.trailStatus;
  const reason = C_BRK_3_REASONS[status];
  if (status === "taken_flat") return { kind: "taken_flat", reason: reason as string };
  return { kind: "refused", status, reason: reason as string };
}
