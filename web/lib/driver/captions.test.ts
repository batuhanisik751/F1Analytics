// GAPFILL_SPEC §6.3 row A2 — the Gap A copy guard.
//
//   1. `C-SKILL-2/5/6/7/8` pinned BYTE-FOR-BYTE against §5.1 (D8, DL-26).
//   2. A DOM test asserting no element holds two skills' values (§5.1 rule 1).
//   3. A grep test asserting no driver name, no rank and no "closer together over one lap"
//      appears in copy (DL-10, DL-13).
//
// No database: every assertion is over a verbatim string or over the pure `SkillPanelView`
// server-rendered from fixture rows. The DB-backed half (`getQualiPanelMeta`) is verified by
// the live counts recorded in the WP-A2 report: 1,135 / 56 / 28 / 24 / 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  C_SKILL_2,
  C_SKILL_5,
  C_SKILL_6,
  C_SKILL_7,
  C_SKILL_8,
  DRIVER_COPY,
  FORBIDDEN_COPY,
  ONE_LAP_VERDICT_LINE,
  RANK_NUMERAL,
  SHARED_PP_AXIS,
  SKILL_LABEL,
  SKILL_ORDER,
  SPRINT_ONE_LAP_REASON,
  TRAIL_BRAKING_REASON,
  fill,
  formatSlot,
  type CaptionSlots,
} from "@/lib/driver/captions";
import { SkillPanelView, THIN_DATA_N_OBS } from "@/components/driver/SkillPanel";
import type { SkillRow } from "@/lib/queries/mode2";

/** The live fit-80 slots, so the rendered copy under test is the copy that ships. */
const SLOTS: CaptionSlots = {
  nRows: 1135,
  nSessions: 56,
  nDrivers: 28,
  nCrossZero: 24,
  nQualiLaps: 1135,
  nSqSessions: 17,
  corrOneLapRace: 0.7727457518963315,
  corrOneLapGrid: 0.8392650790967168,
};

// --- 1. byte-for-byte pins (D8, DL-26) ---------------------------------------

test("C-SKILL-2/5/6/7/8 are byte-for-byte GAPFILL_SPEC §5.1", () => {
  assert.equal(
    C_SKILL_2,
    "This is fitted from where the car started. Starting position includes grid penalties and pit-lane starts, and this number does not subtract them — a five-place gearbox penalty enters it as driver slowness. Qualifying pace, above, is fitted on the laps themselves and includes none of that. Where the two bars disagree, the disagreement is the penalties, the pit-lane starts and the sprint-weekend grids. This bar is measured on a rank scale, not in lap time, so the two cannot be subtracted and this bar is not comparable to the two above it.",
  );
  assert.equal(
    C_SKILL_5,
    "This is fitted from each driver's first-segment qualifying lap — Q1, the one segment every driver runs — measured as a percentage of that session's own field average, across {nRows} laps and {nSessions} sessions. Percentages, not seconds, because a tenth at Monaco is not a tenth at Spa. Sprint qualifying is not in this number. Wet sessions are not in this number. A driver who cruises Q1 because his car will walk into Q3 is measured on that cruise, and we cannot tell that apart from being slow: for the drivers who reach Q3, the margin we can see in Q1 is about forty per cent smaller than the margin they show when it counts.",
  );
  assert.equal(
    C_SKILL_6,
    "Qualifying pace and race pace are different numbers on the same scale: percent of a lap, against the field that was actually there. Across {nDrivers} drivers they agree at r = {corrOneLapRace}, so most of what they measure is the same thing measured twice. Starting-grid pace is on a different scale and cannot be put beside them; it agrees with qualifying pace in ranking at r = {corrOneLapGrid}.",
  );
  assert.equal(
    C_SKILL_7,
    "{nCrossZero} of these {nDrivers} qualifying ratings include zero. Where two bars overlap, we have not shown you a difference — we have shown you two numbers we cannot separate.",
  );
  assert.equal(
    C_SKILL_8,
    "Qualifying gave us {nQualiLaps} new laps and not one new transfer. These drivers have never raced for another team in this data, so where they sit against the rest of the grid is an assumption we made, not something we measured. About half of the uncertainty in this bar is that assumption rather than measurement, and more qualifying sessions will never narrow it.",
  );
});

test("the three §5.1 verdict/refusal lines are byte-for-byte", () => {
  assert.equal(
    ONE_LAP_VERDICT_LINE,
    "Fitted from {nRows} first-segment qualifying laps across {nSessions} sessions.",
  );
  assert.equal(
    SPRINT_ONE_LAP_REASON,
    "We fitted it on {nSqSessions} sprint-qualifying sessions. The driver differences came out smaller than their own error bars, and seventeen sessions is not a corpus.",
  );
  assert.equal(
    TRAIL_BRAKING_REASON,
    "We can see where a driver came off the brakes on one lap. We cannot turn that into a rating: the same driver's number at the same corner changes as much between his own two laps of one weekend as it does between him and the rest of the grid.",
  );
});
// --- 2. DL-12: caption IDs are never reassigned -------------------------------

test("C-SKILL-2 is still the starting-grid-pace caption, amended in place", () => {
  // DL-12: one proposal repointed this ID at a different skill, which would silently
  // repoint a drift test. It stays attached to grid pace forever.
  assert.ok(C_SKILL_2.startsWith("This is fitted from where the car started."));
  assert.ok(C_SKILL_2.includes("measured on a rank scale, not in lap time"));
  // The amendment: it now names the new skill and says the disagreement is the penalties.
  assert.ok(C_SKILL_2.includes("Qualifying pace, above, is fitted on the laps themselves"));
  // DL-8: in words only. No per-driver number for what the penalties were worth.
  assert.doesNotMatch(C_SKILL_2, /\d/);
  // The new skill's copy carries new IDs and never reuses this one.
  for (const [id, copy] of Object.entries(DRIVER_COPY)) {
    if (id === "C-SKILL-2") continue;
    assert.notEqual(copy, C_SKILL_2, `${id} must not duplicate C-SKILL-2`);
  }
});

test("DL-13: every fitted count in a caption is a slot, not a literal", () => {
  const slotted = [C_SKILL_5, C_SKILL_6, C_SKILL_7, C_SKILL_8, ONE_LAP_VERDICT_LINE];
  for (const copy of slotted) assert.match(copy, /\{\w+\}/);
  // The one number spelled out in stored copy is a WORD ("seventeen sessions is not a
  // corpus"), and the machine-readable count beside it is left as a slot on purpose.
  assert.ok(SPRINT_ONE_LAP_REASON.includes("{nSqSessions}"));
  assert.ok(SPRINT_ONE_LAP_REASON.includes("seventeen sessions is not a corpus"));
  assert.doesNotMatch(TRAIL_BRAKING_REASON, /\{\w+\}/);
});

test("fill throws rather than printing a brace to a fan", () => {
  assert.throws(() => fill(C_SKILL_7, { nCrossZero: 24 }), /\{nDrivers\}/);
  assert.equal(formatSlot("nRows", 1135), "1,135");
  assert.equal(formatSlot("corrOneLapRace", 0.7727457518963315), "0.7727");
  assert.equal(formatSlot("corrOneLapGrid", 0.8392650790967168), "0.8393");
  assert.equal(
    fill(C_SKILL_7, SLOTS),
    "24 of these 28 qualifying ratings include zero. Where two bars overlap, we have not " +
      "shown you a difference — we have shown you two numbers we cannot separate.",
  );
  // §1.6 / WP-A1: the two PEARSON figures are the stored ones. The Spearman pair
  // (0.8637 / 0.8835) is not stored anywhere and must never appear.
  const six = fill(C_SKILL_6, SLOTS);
  assert.ok(six.includes("r = 0.7727"));
  assert.ok(six.includes("r = 0.8393"));
  assert.ok(!six.includes("0.8637") && !six.includes("0.8835"));
});

// --- 3. the DOM: no element holds two skills' values (§5.1 rule 1) ------------

const REFUSAL_REASON: Partial<Record<SkillRow["skill"], string>> = {
  tyre_management:
    "We fitted it. The differences between drivers came out smaller than their own error bars, so we are not showing a number.",
  wet: "Every wet race in 2024–26 is one our pace model refuses to fit, so we have no wet pace estimates at all.",
  sprint_one_lap: SPRINT_ONE_LAP_REASON,
  trail_braking: TRAIL_BRAKING_REASON,
};

const UNITS: Record<string, string> = { race_pace: "pp", one_lap_pace: "pp", grid_pace: "normal_score" };

function fixture(over: Partial<SkillRow> & { skill: SkillRow["skill"] }): SkillRow {
  const measured = over.skill in UNITS;
  return {
    measured,
    value: measured ? 0.211 : null,
    valueLo: measured ? -0.104 : null,
    valueHi: measured ? 0.526 : null,
    unit: UNITS[over.skill] ?? "none",
    anchorClass: "anchored",
    pctFieldBelow: measured ? 71 : null,
    notMeasuredReason: measured ? null : (REFUSAL_REASON[over.skill] ?? "not measured"),
    nObs: measured ? 56 : 0,
    ...over,
  };
}

const ALL_SEVEN = (over: Partial<SkillRow>[] = []): SkillRow[] =>
  SKILL_ORDER.map((skill) => fixture({ skill, ...(over.find((o) => o.skill === skill) ?? {}) }));

const render = (skills: SkillRow[]): string =>
  renderToStaticMarkup(createElement(SkillPanelView, { skills, fit: null, quali: SLOTS }));

/** Visible text only, with the five characters React escapes put back. */
const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Each `data-skill="..."` card, as the slice of markup from its attribute to the next card. */
const cards = (markup: string): string[] => markup.split('data-skill="').slice(1);

test("the panel renders all seven §5.1 rows, in §5.1's order", () => {
  const markup = render(ALL_SEVEN());
  const order = cards(markup).map((c) => c.slice(0, c.indexOf('"')));
  assert.deepEqual(order, [...SKILL_ORDER]);
  for (const label of Object.values(SKILL_LABEL)) assert.ok(text(markup).includes(label));
  // §5.1: "Qualifying pace", never "One-lap pace" (decomp.ONE_LAP_LABEL, mirror-guarded).
  assert.ok(!markup.includes("One-lap pace") && !markup.includes("One lap pace"));
  // Three measured, four refused, same visual weight.
  assert.equal((markup.match(/data-measured="true"/g) ?? []).length, 3);
  assert.equal((markup.match(/data-measured="false"/g) ?? []).length, 4);
});

test("no element holds two skills' values (§5.1 rule 1 — no aggregate branch)", () => {
  const markup = render(ALL_SEVEN());
  const preamble = markup.split('data-skill="')[0];
  assert.ok(!preamble.includes("data-skill-value="), "a value escaped every skill card");
  for (const card of cards(markup)) {
    const held = (card.match(/data-skill-value="/g) ?? []).length;
    assert.ok(held <= 1, `one card holds ${held} skills' values`);
  }
  // Exactly one value element per measured, non-floating skill — no fourth, no aggregate.
  assert.equal((markup.match(/data-skill-value="/g) ?? []).length, 3);
  for (const card of cards(markup)) {
    const owner = card.slice(0, card.indexOf('"'));
    const tagged = card.match(/data-skill-value="(\w+)"/);
    if (tagged) assert.equal(tagged[1], owner, "a card printed another skill's value");
  }
  // Nothing sums, averages or ranks two skills, so none of these words can appear.
  const body = text(markup).toLowerCase();
  for (const banned of ["overall rating", "combined rating", "radar", "qualifying specialist"]) {
    assert.ok(!body.includes(banned), `forbidden aggregate copy: ${banned}`);
  }
});

test("D4: the two pp skills share one axis and grid_pace never joins them", () => {
  const markup = render(ALL_SEVEN());
  const pp = markup.indexOf('data-axis="pp"');
  const ns = markup.indexOf('data-axis="normal_score"');
  assert.ok(pp >= 0 && ns > pp, "grid pace must sit on its own axis, after the shared one");
  for (const skill of SHARED_PP_AXIS) {
    const at = markup.indexOf(`data-skill="${skill}"`);
    assert.ok(at > pp && at < ns, `${skill} must sit under the shared pp axis`);
  }
  assert.ok(markup.indexOf('data-skill="grid_pace"') > ns);
  assert.ok(text(markup).includes("percent of a lap, relative to the session's own field"));
  // The two pp bars must be drawn on ONE scale: identical intervals render identically.
  const same = render(
    ALL_SEVEN([
      { skill: "race_pace", value: 0.4, valueLo: 0.1, valueHi: 0.7 },
      { skill: "one_lap_pace", value: 0.4, valueLo: 0.1, valueHi: 0.7 },
    ]),
  );
  const geometry = [...same.matchAll(/left:([\d.]+)%;width:([\d.]+)%/g)].map((m) => `${m[1]}/${m[2]}`);
  assert.equal(geometry[0], geometry[1], "equal intervals must draw equally on a shared axis");
});

test("a floating driver gets no numeral, and the island caption rides the hatched bar", () => {
  // §5.1 rule 2: norris, piastri, alonso, stroll. pct_field_below is NULL for all four on
  // all three measured skills; the hatched bar and the chip render, no plain numeral.
  const markup = render(
    ALL_SEVEN(
      (["race_pace", "one_lap_pace", "grid_pace"] as const).map((skill) => ({
        skill,
        anchorClass: "floating" as const,
        pctFieldBelow: null,
      })),
    ),
  );
  assert.ok(!markup.includes("data-skill-value="), "a floating driver was given a level");
  assert.equal((markup.match(/level not measured/g) ?? []).length, 3);
  assert.ok(!text(markup).includes("% of the field"));
  assert.ok(text(markup).includes(fill(C_SKILL_8, SLOTS)));
  // And it is ONLY on the hatched bars: an anchored driver has no island to explain.
  assert.ok(!text(render(ALL_SEVEN())).includes("not one new transfer"));
});

test("§5.1: thin data and the floating badge are two separate marks", () => {
  const markup = render(
    ALL_SEVEN([
      { skill: "one_lap_pace", nObs: 10, anchorClass: "floating", pctFieldBelow: null },
      { skill: "race_pace", nObs: 10 },
    ]),
  );
  // Both marks present, in different elements, never in one undifferentiated column (§1.4).
  assert.equal((markup.match(/thin data/g) ?? []).length, 2);
  assert.equal((markup.match(/level not measured/g) ?? []).length, 1);
  const quali = cards(markup).find((c) => c.startsWith("one_lap_pace"));
  assert.ok(quali && quali.indexOf("thin data") < quali.indexOf("level not measured"));
  // race_pace is thin but anchored: it keeps its numeral and gets no hatch chip.
  const race = cards(markup).find((c) => c.startsWith("race_pace"));
  assert.ok(race?.includes("thin data") && race.includes("data-skill-value="));
  assert.ok(!race?.includes("level not measured"));
  assert.ok(THIN_DATA_N_OBS === 25);
});

test("every §5.1 caption reaches the page filled, and no brace reaches a fan", () => {
  const markup = render(ALL_SEVEN([{ skill: "one_lap_pace", anchorClass: "floating", pctFieldBelow: null }]));
  const body = text(markup);
  for (const [id, copy] of Object.entries(DRIVER_COPY)) {
    assert.ok(body.includes(fill(copy, SLOTS)), `${id} is not on the page, or not verbatim`);
  }
  assert.doesNotMatch(body, /\{\w+\}/, "an unfilled caption slot reached the DOM");
  assert.ok(body.includes("Fitted from 1,135 first-segment qualifying laps across 56 sessions."));
  assert.ok(body.includes("We fitted it on 17 sprint-qualifying sessions."));
});

// --- 4. the grep test: no driver name, no rank, no forbidden phrase -----------

/** The 28 drivers of fit 80, split on `_` so "max_verstappen" also guards "verstappen". */
const DRIVER_NAME_PARTS = [
  "albon", "alonso", "antonelli", "arvid", "lindblad", "bearman", "bortoleto", "bottas",
  "colapinto", "doohan", "gasly", "hadjar", "hamilton", "hulkenberg", "kevin", "magnussen",
  "lawson", "leclerc", "verstappen", "norris", "ocon", "perez", "piastri", "ricciardo",
  "russell", "sainz", "sargeant", "stroll", "tsunoda", "zhou",
];

test("DL-13: no driver name appears in any Gap A copy", () => {
  const surfaces = { ...DRIVER_COPY, "rendered.panel": text(render(ALL_SEVEN())) };
  for (const [id, copy] of Object.entries(surfaces)) {
    for (const name of DRIVER_NAME_PARTS) {
      assert.doesNotMatch(copy, new RegExp(`\\b${name}\\b`, "i"), `${id} names ${name}`);
    }
  }
});

test("DL-13: no caption prints a rank", () => {
  // A rank as a numeral — "#3", "8th", "27th". The WORDS "rank scale" (C-SKILL-2) and
  // "in ranking at r =" (C-SKILL-6) are legitimate and deliberately still pass: they
  // describe a SCALE and a CORRELATION, neither of which is a position awarded to a driver.
  for (const [id, copy] of Object.entries(DRIVER_COPY)) {
    assert.doesNotMatch(copy, RANK_NUMERAL, `${id} prints a rank`);
    assert.doesNotMatch(copy, /\branked\b/i, `${id} ranks a driver`);
  }
  assert.ok(C_SKILL_2.includes("rank scale") && C_SKILL_6.includes("in ranking at r ="));
  assert.match("ranked #3 overall", RANK_NUMERAL);
  assert.match("Hamilton is 8th", RANK_NUMERAL);
});

test("DL-10: \"drivers are closer together over one lap\" is forbidden copy", () => {
  // The measured ratio is tau_car/tau_driver = 3.50 in qualifying against 3.31 in the race —
  // if anything slightly MORE car-dominated. The opposite headline (2.71) is the one
  // conclusion that does not survive a scale-clean construction; every clean fit returns
  // 3.0-3.6, so the phrase is grepped out of the copy rather than merely left unwritten.
  const surfaces = { ...DRIVER_COPY, "rendered.panel": text(render(ALL_SEVEN())) };
  for (const [id, copy] of Object.entries(surfaces)) {
    for (const phrase of FORBIDDEN_COPY) {
      assert.ok(!copy.toLowerCase().includes(phrase), `${id} contains forbidden copy: ${phrase}`);
    }
  }
  assert.ok(FORBIDDEN_COPY.includes("closer together"));
  assert.ok("drivers are closer together over one lap".includes(FORBIDDEN_COPY[0]));
});
