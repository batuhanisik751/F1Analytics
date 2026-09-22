// IDEAS_2026-09 §1 #1 / #6 — the home strip's copy guard and the stale-data guard's logic.
//
//   1. Every fan-facing string is pinned BYTE-FOR-BYTE.
//   2. No template holds a digit, a driver name or a date: every such value is a slot.
//   3. `fill()` refuses to render an unfilled slot.
//   4. The query-layer decisions (`staleRoundFrom`, `nextEventFrom`) are pure and are exercised
//      against a fake "today" past the next race, without touching the database.
import test from "node:test";
import assert from "node:assert/strict";

import { HOME_COPY, C_NOT_LOADED, C_TITLE_LEADER, C_FAVOURED_LIMIT, fill, fmtProb } from "@/lib/home/captions";
import { staleRoundFrom, todayUtc, type EventLoadRow } from "@/lib/queries/release";
import { nextEventFrom } from "@/lib/queries/home";

// --- 1. byte-for-byte pins ------------------------------------------------------------

test("every home-strip string is byte-for-byte", () => {
  assert.deepEqual(HOME_COPY, {
    STRIP_TITLE: "This week",
    STRIP_CAPTION:
      "What is on this weekend, and whether the title is still alive — read from rows the nightly job has already loaded.",
    NEXT_RACE_LABEL: "Next race",
    C_NEXT_EVENT: "Round {round}, the {event}, on {date}.",
    C_NEXT_EVENT_LINK: "Weekend preview →",
    C_SEASON_OVER:
      "The {year} season has no round left to run. The {nextYear} calendar appears here once it is published.",
    TITLE_LABEL: "Title fight",
    C_TITLE_LEADER:
      "After round {afterRound}, {leader} leads the title odds with a {p} chance, in a range of {pLo} to {pHi}, from {draws} simulated seasons. A forecast, with a band.",
    C_TITLE_POINTS:
      "Championship points: {leaderPoints}, {margin} clear of {second}. Points scored so far, not a forecast.",
    C_TITLE_ALIVE:
      "{alive} of {total} drivers can still win the title on the arithmetic; {eliminated} cannot.",
    C_TITLE_CLINCH: "The earliest the title can be settled is round {clinchRound}, the {clinchEvent}.",
    C_TITLE_NO_CLINCH: "No round at which the title could be settled has been worked out yet.",
    C_TITLE_NONE: "Title odds have not been computed for this season yet.",
    FAVOURED_LABEL: "Favoured before qualifying",
    C_FAVOURED: "{first}, then {second} and {third} — the preview order for this round.",
    C_FAVOURED_LIMIT:
      "This order is a weaker guide than the starting grid will be ({spearman} against {gridSpearman} rank correlation in the backtest), so it says who is favoured before qualifying, never a predicted finish.",
    C_FAVOURED_LIMIT_NO_BACKTEST:
      "This order is a weaker guide than the starting grid will be, so it says who is favoured before qualifying, never a predicted finish.",
    C_FAVOURED_NONE: "No preview order has been computed for this round yet.",
    AFTER_LABEL: "After the race",
    C_AFTER_RACE:
      "The race page for the {event} appears once the nightly push has run; the footer's Data as of line shows when that was.",
    C_NOT_LOADED: "R{round} {event} raced on {date} and is not loaded yet.",
  });
});

test("§1 #6: the guard sentence has the required form, with the date a slot", () => {
  assert.equal(C_NOT_LOADED, "R{round} {event} raced on {date} and is not loaded yet.");
  assert.equal(
    fill(C_NOT_LOADED, { round: 15, event: "Azerbaijan Grand Prix", date: "26 Sept 2026" }),
    "R15 Azerbaijan Grand Prix raced on 26 Sept 2026 and is not loaded yet.",
  );
});

// --- 2. no literals in copy -----------------------------------------------------------

test("no template holds a digit, a driver name or a month", () => {
  const names = /antonelli|russell|hamilton|norris|leclerc|verstappen|piastri/i;
  // month names and their abbreviations as fmtDate writes them ("26 Sept 2026")
  const months =
    /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;
  for (const [id, copy] of Object.entries(HOME_COPY)) {
    assert.doesNotMatch(copy, /\d/, `${id} holds a literal number`);
    assert.doesNotMatch(copy, names, `${id} holds a driver name`);
    assert.doesNotMatch(copy, months, `${id} holds a date`);
  }
});

test("§1 #1 must-not: odds carry a band; favourites are 'favoured before qualifying'", () => {
  assert.match(C_TITLE_LEADER, /\{pLo\}/);
  assert.match(C_TITLE_LEADER, /\{pHi\}/);
  assert.match(C_FAVOURED_LIMIT, /favoured before qualifying/);
  for (const [id, copy] of Object.entries(HOME_COPY)) {
    assert.doesNotMatch(copy, /will win|will finish|predicted to/i, `${id} predicts a result`);
    // "predicted finish" is allowed only as the thing the copy says it is NOT.
    assert.doesNotMatch(copy.replace(/never a predicted finish/g, ""), /predicted finish/i, id);
  }
});

// --- 3. slots -------------------------------------------------------------------------

test("fill() refuses an unfilled slot and formats counts with a separator", () => {
  assert.throws(() => fill(C_NOT_LOADED, { round: 15, event: "x" }), /\{date\} was not supplied/);
  assert.throws(() => fill("{n}", { n: Number.NaN }), /\{n\} was not supplied/);
  assert.equal(fill("{draws} seasons", { draws: 20000 }), "20,000 seasons");
  assert.equal(fmtProb(0.98175), "98 %");
  assert.equal(fmtProb(1), "100 %");
});

// --- 4. the query-layer decisions, against a fake today ------------------------------

const ev = (round: number, eventDate: string, loaded: boolean): EventLoadRow => ({
  year: 2026,
  round,
  eventName: `Event ${round}`,
  eventDate,
  loaded,
});
const ROWS: EventLoadRow[] = [
  ev(13, "2026-09-06", true),
  ev(14, "2026-09-13", true),
  ev(15, "2026-09-26", false),
  ev(16, "2026-10-04", false),
];

test("staleRoundFrom: quiet while the latest past round is loaded", () => {
  assert.equal(staleRoundFrom(ROWS, "2026-09-22"), null);
  // race day itself: R15 is still "next", not "missing"
  assert.equal(staleRoundFrom(ROWS, "2026-09-26"), null);
  assert.equal(staleRoundFrom([], "2026-09-22"), null);
});

test("staleRoundFrom: the morning after R15 with no loaded race session names R15", () => {
  assert.deepEqual(staleRoundFrom(ROWS, "2026-09-27"), {
    year: 2026,
    round: 15,
    eventName: "Event 15",
    eventDate: "2026-09-26",
  });
  // ...and it stays R15, not R16, until R16 has raced
  assert.equal(staleRoundFrom(ROWS, "2026-10-03")?.round, 15);
  // once R15 is loaded the guard is quiet again
  const loaded = ROWS.map((r) => (r.round === 15 ? { ...r, loaded: true } : r));
  assert.equal(staleRoundFrom(loaded, "2026-09-27"), null);
});

test("nextEventFrom: earliest unloaded round on or after today; null when the season is done", () => {
  assert.equal(nextEventFrom(ROWS, "2026-09-22")?.round, 15);
  assert.equal(nextEventFrom(ROWS, "2026-09-26")?.round, 15);
  assert.equal(nextEventFrom(ROWS, "2026-09-27")?.round, 16);
  assert.equal(nextEventFrom(ROWS, "2026-10-05"), null);
  // a loaded round is never "next", whatever its date
  const early = ROWS.map((r) => (r.round === 15 ? { ...r, loaded: true } : r));
  assert.equal(nextEventFrom(early, "2026-09-22")?.round, 16);
});

test("todayUtc reads the UTC date, not the local one", () => {
  assert.equal(todayUtc(new Date("2026-09-26T23:30:00Z")), "2026-09-26");
  assert.equal(todayUtc(new Date("2026-09-27T00:30:00Z")), "2026-09-27");
});
