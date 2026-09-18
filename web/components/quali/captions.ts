// QUALI_SPEC v1.6 §6.3 — the nine verbatim captions. These strings ship EXACTLY as
// written in the spec: each one says what the number is NOT, and that is the content.
// Kept in one module so a diff against §6.3 is a diff of this file, and so the test
// that pins them has one import.
//
// Apostrophes are U+2019 and the strings contain no JSX; every surface renders them
// through <Caption>, which does not re-wrap or truncate.

export const C_QUALI_1 =
  "These are the official FIA times from the session, not a model. Every time here was also " +
  "reproduced from this session's own lap data by the same filter the rest of the app uses — " +
  "flying laps only, deleted laps removed, each lap matched to the segment it was set in. A blank " +
  "cell means no time was set in that segment, which is not the same as not reaching it.";

export const C_QUALI_2 =
  "The solid bar compares each driver to the pole sitter in the deepest segment they both set a " +
  "time in. The ghosted bar behind it is the headline gap you see on television: the driver's best " +
  "lap of the session against the pole lap. Those two are not the same thing. A driver knocked out " +
  "in Q1 set their best lap on a greener, slower track than the one pole was set on, and the " +
  "ghosted bar charges them for it. Use the percentage to compare circuits: one tenth of a second " +
  "is 0.142% of a lap at Monaco and 0.105% at Shanghai, so a tenth is not the same amount of car " +
  "everywhere.";

export const C_QUALI_3 =
  "Each driver's best lap in each segment they ran. A hollow marker means the driver set fewer " +
  "than two push laps in that segment, so there is nothing to compare it against. The spread shown " +
  "is not a consistency measure — it also contains the track getting faster between runs. Drivers " +
  "with more laps get more chances at a good one, so the lap count is shown beside every row, and " +
  "a driver with two laps is not being compared fairly with one who had eight.";

export const C_QUALI_4 =
  "Both times come from the deepest segment both drivers reached, so this is a like-for-like " +
  "comparison. Where it is marked, the driver who was quicker is not the driver who was classified " +
  "ahead — that happens when one teammate progressed to the next segment and the other set a " +
  "faster time before going out. Treat a single session's gap as noise: measured across 301 " +
  "driver-segments, a driver's own push laps within one segment vary by a median of 0.45 seconds, " +
  "which is larger than most teammate gaps. At Monza in 2026 the two Ferraris were seven " +
  "thousandths apart — twenty-six times smaller than that session's own lap-to-lap variation.";

export const C_QUALI_5 =
  "Wins count the sessions where both drivers took part and one qualified ahead. The median gap is " +
  "taken only over sessions where both set a time in the same segment, which quietly leaves out " +
  "the sessions where one of them crashed — so it flatters whoever makes fewer mistakes. The band " +
  "shows how uncertain this record is, not how close the drivers were. Over a single season a " +
  "12–10 qualifying head-to-head is consistent with anything from a driver who is genuinely a " +
  "little slower to one who is genuinely a little quicker. Treat the band, not the score.";

export const C_QUALI_6 =
  "Where each driver qualified and where they actually started. A difference can be that driver's " +
  "own penalty or simply the effect of someone else's; this table does not say which, and a " +
  "pit-lane start is not a grid position at all.";

export const C_QUALI_7 =
  "Conditions changed between the segments of this session, so times from different segments are " +
  "not comparable. The classification and the per-segment times below are unaffected; the " +
  "session-wide gap to pole is not shown.";

export const C_QUALI_8 =
  "How each driver has qualified at this circuit before, as a median gap to pole. This is history, " +
  "not a prediction. It is not part of the forecast below, and the forecast's accuracy is " +
  "unchanged by it. Fewer than three previous sessions is shown greyed, with the count.";

export const C_QUALI_9 =
  "The quickest comparable lap of this session was not the pole lap. That happens when the track " +
  "was faster earlier in the session than it was at the end. Pole is the classified result; the " +
  "fastest lap is just the fastest lap.";

/**
 * §6.2's provenance note, shown under the section heading when `segmentRepairs > 0`.
 * The spec writes the three-repair case verbatim; the count is spelled for 1..3 and
 * falls back to the digit beyond that, because only 2024 São Paulo has any (3).
 */
const WORDS = ["", "One", "Two", "Three"];
export function segmentRepairNote(n: number): string {
  const count = n < WORDS.length ? WORDS[n] : String(n);
  const noun = n === 1 ? "lap time" : "lap times";
  return (
    `${count} ${noun} in this session ${n === 1 ? "was" : "were"} matched to their segment using ` +
    "the official times, because the timing feed's segment boundaries did not account for a red flag."
  );
}

/**
 * v1.6 as-built (QUALI_SPEC §10), not one of §6.3's nine. Shown under the segment strip when
 * any row on it has `verified = false`. A waived driver-segment's official time is a
 * byte-identical copy of another segment's, so no lap can confirm which segment the lap
 * below belongs to; the app marks the dot rather than printing it as a measured time.
 */
export const C_QUALI_10 =
  "One or more segment times here could not be confirmed against the official result, because the " +
  "official time for that segment is an exact copy of another segment's. The lap shown is the one " +
  "set inside that segment's window; it is marked, and it is not used for any teammate comparison.";

/** §6.6 row 3 — the one-line note on a `partial` session. Verbatim. */
export const PARTIAL_SESSION_NOTE =
  "Per-segment analysis is not available for this session because its lap times could not be " +
  "matched to the segments they were set in.";

/** §6.6 row 5 — the driver page's empty qualifying record. A fact, not an apology. */
export const NO_DRIVER_QUALI = "No qualifying sessions in the database for this driver.";

// ---------------------------------------------------------------------------
// UX_SPEC v1.9 §2.3 — summary lines.
//
// §0 COLLAPSE, NEVER DELETE: not one character of the captions above changed. These are
// NEW, additional one-liners that sit in the open, saying what is behind the control so a
// reader can decide whether the long version is worth the scroll. Where the long caption
// carries a warning, the summary carries it too — the warning is never the thing hidden.
// ---------------------------------------------------------------------------

/** Above C-QUALI-1 (the classification table). */
export const S_QUALI_1 =
  "Official FIA times, each one re-found in this session's own lap data. How that was checked.";

/** Above C-QUALI-2 — carries the warning, because the two bars are two different numbers. */
export const S_QUALI_2 =
  "Two gaps, not one: the solid bar and the ghost behind it measure different things. Why, and which to trust.";

/** Above C-QUALI-3 (the per-segment strip). */
export const S_QUALI_3 =
  "Best lap per segment. The spread shown is not consistency, and lap counts differ by driver.";

/** Above C-QUALI-4 — the warning is in the summary; the evidence for it is inside. */
export const S_QUALI_4 =
  "One session's teammate gap is mostly noise: a driver's own push laps vary by a median of 0.45 s. The evidence.";

/** Above C-QUALI-5 (the season teammate card). */
export const S_QUALI_5 =
  "Read the band, not the score: a 12–10 record is consistent with either driver being quicker. Why.";

/** Above C-QUALI-6 (qualified and started). */
export const S_QUALI_6 =
  "Qualified position against grid position. This table does not say whose penalty caused a move.";

/** Above C-QUALI-8 (this circuit's qualifying history). */
export const S_QUALI_8 =
  "History, not a prediction: it is not an input to the forecast below.";

/** §2.3 — the closed-state line for the whole qualifying section. Counts, so it is specific. */
export function qualiSectionSummary(sessionNames: string[], drivers: number): string {
  const which = sessionNames.length > 1 ? sessionNames.join(" and ") : (sessionNames[0] ?? "Qualifying");
  return `${which} — classification, gap to pole and teammate gaps for ${drivers} drivers.`;
}

/** §2.3 — the per-segment block's line, with its count. */
export function segmentStripSummary(drivers: number, unverified: number): string {
  const head = `Best lap in each segment for ${drivers} driver${drivers === 1 ? "" : "s"}, and how many push laps each got`;
  return unverified > 0
    ? `${head}. ${unverified} segment time${unverified === 1 ? "" : "s"} could not be confirmed.`
    : `${head}.`;
}

/** §2.3 — the qualified-and-started block's line, with its count. */
export function toGridSummary(moved: number): string {
  return `${moved} driver${moved === 1 ? "" : "s"} started somewhere other than where they qualified.`;
}
