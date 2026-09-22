// IDEAS_2026-09 §1 #1 (the "this week" strip) and §1 #6 (stale-data honesty) — every word the
// home strip and the footer guard say, in one place.
//
// Every fan-facing string here is VERBATIM and pinned byte-for-byte by captions.test.ts. No
// driver name, round number, date, probability or count is a literal in copy: each is a `{slot}`
// filled from the database at render time, and `fill()` throws if a slot is left unfilled rather
// than printing a brace to a fan.
//
// What this copy must never claim (§1 #1 "must not"): a pre-race favourite is "favoured before
// qualifying" and nothing stronger, because the preview order ranks finishers less well than the
// grid itself does; title odds always carry their band; championship points and simulated
// expected points are never summed; nothing here states a race result as a fact.

// --- the strip -----------------------------------------------------------------------

export const STRIP_TITLE = "This week";
export const STRIP_CAPTION =
  "What is on this weekend, and whether the title is still alive — read from rows the nightly job has already loaded.";

export const NEXT_RACE_LABEL = "Next race";
export const C_NEXT_EVENT = "Round {round}, the {event}, on {date}.";
export const C_NEXT_EVENT_LINK = "Weekend preview →";
export const C_SEASON_OVER =
  "The {year} season has no round left to run. The {nextYear} calendar appears here once it is published.";

export const TITLE_LABEL = "Title fight";
export const C_TITLE_LEADER =
  "After round {afterRound}, {leader} leads the title odds with a {p} chance, in a range of {pLo} to {pHi}, from {draws} simulated seasons. A forecast, with a band.";
export const C_TITLE_POINTS =
  "Championship points: {leaderPoints}, {margin} clear of {second}. Points scored so far, not a forecast.";
export const C_TITLE_ALIVE =
  "{alive} of {total} drivers can still win the title on the arithmetic; {eliminated} cannot.";
export const C_TITLE_CLINCH =
  "The earliest the title can be settled is round {clinchRound}, the {clinchEvent}.";
export const C_TITLE_NO_CLINCH =
  "No round at which the title could be settled has been worked out yet.";
export const C_TITLE_NONE = "Title odds have not been computed for this season yet.";

export const FAVOURED_LABEL = "Favoured before qualifying";
export const C_FAVOURED = "{first}, then {second} and {third} — the preview order for this round.";
export const C_FAVOURED_LIMIT =
  "This order is a weaker guide than the starting grid will be ({spearman} against {gridSpearman} rank correlation in the backtest), so it says who is favoured before qualifying, never a predicted finish.";
export const C_FAVOURED_LIMIT_NO_BACKTEST =
  "This order is a weaker guide than the starting grid will be, so it says who is favoured before qualifying, never a predicted finish.";
export const C_FAVOURED_NONE = "No preview order has been computed for this round yet.";

export const AFTER_LABEL = "After the race";
export const C_AFTER_RACE =
  "The race page for the {event} appears once the nightly push has run; the footer's Data as of line shows when that was.";

// --- the guard (§1 #6) — rendered by the footer AND the strip, from one query -------------

/** The one sentence the footer and the strip share when a round has raced but its race
 *  session is not loaded. It says that, and nothing about why (OPS §1.3 visible-skip rule). */
export const C_NOT_LOADED = "R{round} {event} raced on {date} and is not loaded yet.";

/** Every template above, by ID, so a test can sweep them all for literals. */
export const HOME_COPY: Record<string, string> = {
  STRIP_TITLE,
  STRIP_CAPTION,
  NEXT_RACE_LABEL,
  C_NEXT_EVENT,
  C_NEXT_EVENT_LINK,
  C_SEASON_OVER,
  TITLE_LABEL,
  C_TITLE_LEADER,
  C_TITLE_POINTS,
  C_TITLE_ALIVE,
  C_TITLE_CLINCH,
  C_TITLE_NO_CLINCH,
  C_TITLE_NONE,
  FAVOURED_LABEL,
  C_FAVOURED,
  C_FAVOURED_LIMIT,
  C_FAVOURED_LIMIT_NO_BACKTEST,
  C_FAVOURED_NONE,
  AFTER_LABEL,
  C_AFTER_RACE,
  C_NOT_LOADED,
};

// --- slot filling --------------------------------------------------------------------

export type Slot = string | number;

/** `0.98175` → `98 %`. Whole percentage points: the bootstrap band is wider than a point, so a
 *  decimal would claim precision the model does not have. */
export function fmtProb(p: number): string {
  return `${Math.round(p * 100)} %`;
}

/** Integers with a thousands separator (`20,000` simulated seasons); strings as given. */
export function formatSlot(value: Slot): string {
  return typeof value === "number" ? new Intl.NumberFormat("en-US").format(value) : value;
}

/**
 * Substitutes `{slot}` in a template. Throws on a slot the caller did not supply: a sentence
 * that reaches a fan with a literal `{date}` in it is worse than a crash, and the point of the
 * slots is that these values arrive from the database at render time or not at all.
 */
export function fill(template: string, slots: Record<string, Slot | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = slots[key];
    if (value === undefined || value === null || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`caption slot {${key}} was not supplied`);
    }
    return formatSlot(value);
  });
}
