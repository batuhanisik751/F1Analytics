// H2H_SPEC §4 — every word the head-to-head section says, in one place.
//
// Every fan-facing string here is VERBATIM and pinned byte-for-byte by h2hCaptions.test.ts. No
// driver name, year, count or pp figure is a literal in copy: each is a `{slot}` filled at render
// time, and `fill()` throws if a slot is left unfilled rather than printing a brace to a fan.
// Callers pass pp figures and intervals as already-formatted strings; a bare number is printed as
// is (no thousands separator: a `{year}` must never come out as "2,026", and no count here exceeds
// a few hundred). Same shape as lib/home's `fill()`, which is not reused for that one reason.
//
// §8 must-nots carried by this copy: raw counts never say who is the better driver (C_H2H_1's last
// sentence); "same car not implied" is inside every counted line (C_H2H_2), never a footnote; the
// pooled number is "not a {year} number" in the numeral's own paragraph (C_H2H_4); the two answers
// are never subtracted from each other (C_H2H_5).

export type Slot = string | number;

/**
 * Substitutes `{slot}` in a template. Throws on a slot the caller did not supply, or on a
 * non-finite number: these values arrive from the database at render time or not at all.
 */
export function fill(template: string, slots: Record<string, Slot | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = slots[key];
    if (value === undefined || value === null || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`caption slot {${key}} was not supplied`);
    }
    return String(value);
  });
}

// --- Answer 1: the same-race ledger -----------------------------------------------------

/** Table `<caption>` and the page's metadata description when `vs` resolves. */
export const C_H2H_1 =
  "In {year} {a} and {b} started the same race {shared} times. Each line below counts only the races where both have that number, so the denominators differ. These lines compare car and driver together; they do not say who is the better driver.";

/** One per counted row (qualifying, finish, pace); `counted` is that row's own denominator. */
export const C_H2H_2 = "{a} ahead in {wins} of {counted} shared races, same car not implied.";

/** Extra clause under the qualifying row only. */
export const C_H2H_2Q =
  "Qualifying position, not grid: the team-mate card above counts grid position, which moves with penalties.";

/** Points row. */
export const C_H2H_3 = "{a} {pointsA}, {b} {pointsB} points in the {shared} races both started.";

// --- Answer 2: the car-removed view ------------------------------------------------------

/** The pooled number, with its interval and "not a {year} number" in the same paragraph. */
export const C_H2H_4 =
  "With the car taken out, the model puts {a} {absDelta} pp of a lap {fasterOrSlower} than {b}, 5th–95th {lo} to {hi}, across every season it has seen ({nA} races for {a}, {nB} for {b}). It is not a {year} number: the model is fitted once across seasons, never per season.";

/** Fixed, rendered once under both cards. */
export const C_H2H_5 =
  "The two answers are allowed to disagree: the first counts qualifying, finishes and pace in whatever car each drove; the second tries to take the car out. Neither is subtracted from the other.";

/** `kind='teammate'` contrast: the gap is measured. */
export const C_H2H_6 =
  "{a} and {b} shared a car in {nSharedRaces} races, so this gap is measured, not assumed.";

/** No-call sentence; `reason` is always one of REASONS. */
export const C_H2H_7 = "The model's side cannot be called here: {reason}.";
export const REASON_ASSUMED = "the gap is assumed, not measured";
export const REASON_ZERO = "the 5th–95th range includes zero";
export const REASON_NO_ROW = "no stored contrast for this pair";
export const REASONS = [REASON_ASSUMED, REASON_ZERO, REASON_NO_ROW] as const;
export type Reason = (typeof REASONS)[number];

/** Lead line: fill `ledgerCall` and `modelCall` from their variants first, then this. */
export const C_H2H_8 = "{year} ledger: {ledgerCall}. Car removed: {modelCall}.";
export const LEDGER_CALL_LEADER = "{leader} ahead on pace in {n} of {d} shared races";
export const LEDGER_CALL_LEVEL = "level on pace, {n} each of {d} shared races";
export const LEDGER_CALL_NONE = "no shared race has a pace estimate for both";
export const MODEL_CALL_LEADER = "{leader} quicker over every season the model has seen";
export const MODEL_CALL_NONE = "cannot be called";

/** Copied verbatim from components/driver/CareerH2HTable.tsx (MODE2_SPEC 2407–2410). */
export const C_CONTRAST_2 =
  "These two drivers have never shared a car, and no chain of team moves connects them. This gap is what the model assumes, not what it measured.";

/** Every template above, by ID, so a test can sweep them all for literals. */
export const H2H_COPY: Record<string, string> = {
  C_H2H_1,
  C_H2H_2,
  C_H2H_2Q,
  C_H2H_3,
  C_H2H_4,
  C_H2H_5,
  C_H2H_6,
  C_H2H_7,
  REASON_ASSUMED,
  REASON_ZERO,
  REASON_NO_ROW,
  C_H2H_8,
  LEDGER_CALL_LEADER,
  LEDGER_CALL_LEVEL,
  LEDGER_CALL_NONE,
  MODEL_CALL_LEADER,
  MODEL_CALL_NONE,
  C_CONTRAST_2,
};
