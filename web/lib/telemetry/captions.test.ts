// TELEMETRY_SPEC v1.7 §6.3 / §6.4 — the drift test. Each caption is pinned here as a
// SECOND, INDEPENDENT literal copy of the spec's text: a one-character edit to
// captions.ts fails this file, which is what makes "verbatim" a property of the build
// rather than a promise in a comment. No database and no React — every assertion is
// over a string or a pure function.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  C_TEL_1,
  C_TEL_2_TEMPLATE,
  C_TEL_2_EXCEEDS_HALF_GAP,
  C_TEL_3_TEMPLATE,
  C_TEL_4,
  C_TEL_5,
  C_TEL_6,
  C_TEL_7,
  C_TEL_8_TEMPLATE,
  C_TEL_8_OVERLAP_THRESHOLD_PCT,
  FIXED_CAPTIONS,
  CAPTION_TEMPLATES,
  cTel2,
  cTel3,
  cTel8,
} from "@/lib/telemetry/captions";

// --- the eight pinned strings -------------------------------------------------------

const SPEC = {
  C_TEL_1:
    "One lap against one lap. These are the two drivers' fastest laps of this session and nothing else. They were set on different fuel loads, different tyre ages and a track that changed between them. The trace is cumulative, so one held-up corner shifts every metre after it — read where the line changes slope, not where it ends up. This chart shows where one lap was quicker than the other. It does not show which driver, or which car, is faster.",
  C_TEL_2_TEMPLATE:
    "Aligned on distance around the lap. The trace closes to within {closure_ms} ms of the official gap and matches the drivers' own sector times to within {sector_ms} ms — so read the shape of this line, not the third decimal. {n_gaps} stretches of the lap, shaded grey, have no measurement in them and are drawn by interpolation.",
  C_TEL_2_EXCEEDS_HALF_GAP:
    "The alignment error on this pair is larger than half the gap itself — read the shape of the line, not its size.",
  C_TEL_3_TEMPLATE:
    "Painted from {n_samples} samples taken ten times a second on one lap. The shape is the car's path on that lap — not the racing line, not the circuit's centreline.",
  C_TEL_4:
    "These two drive different cars. Almost everything you can see below is the car, the fuel or the tyre, and this page cannot tell you which. Compare teammates to get closer to a like-for-like run — and even then, read what this page can't tell you. If you want the driver separated from the car, that is the was-it-the-car page, which uses thousands of laps and says how uncertain it is.",
  C_TEL_5:
    "No cross-driver comparison on a race lap. These laps were run in traffic, on fuel loads that fall all race, on tyres of different ages — so a side-by-side trace would look like a measurement and would not be one. The map and the channels below are one driver's lap, and that is all this data can honestly show for a race.",
  C_TEL_6:
    "Corner numbering and corner positions come from the timing provider's circuit map, not from the track's own signage. A blank braking point means the corner was taken flat, not that the data is missing. Corners taken in one braking event are bracketed together.",
  C_TEL_7:
    "No DRS signal in this session's data. That is a gap in what was recorded, not a lap where nobody opened it.",
  C_TEL_8_TEMPLATE:
    "{overlap_pct}% of this lap reports full throttle and braking at the same time. The two channels are separate feeds merged onto one timeline, so this is how they were recorded and not how the car was driven. Don't read the throttle and brake shares to the tenth.",
} as const;

test("all eight captions are present and verbatim against §6.3", () => {
  assert.equal(C_TEL_1, SPEC.C_TEL_1);
  assert.equal(C_TEL_2_TEMPLATE, SPEC.C_TEL_2_TEMPLATE);
  assert.equal(C_TEL_2_EXCEEDS_HALF_GAP, SPEC.C_TEL_2_EXCEEDS_HALF_GAP);
  assert.equal(C_TEL_3_TEMPLATE, SPEC.C_TEL_3_TEMPLATE);
  assert.equal(C_TEL_4, SPEC.C_TEL_4);
  assert.equal(C_TEL_5, SPEC.C_TEL_5);
  assert.equal(C_TEL_6, SPEC.C_TEL_6);
  assert.equal(C_TEL_7, SPEC.C_TEL_7);
  assert.equal(C_TEL_8_TEMPLATE, SPEC.C_TEL_8_TEMPLATE);
  // Eight captions: six fixed (C-TEL-1 counted once, plus the half-gap preamble) and
  // three templates, C-TEL-2 contributing to both halves.
  assert.equal(Object.keys(FIXED_CAPTIONS).length, 6);
  assert.equal(Object.keys(CAPTION_TEMPLATES).length, 3);
});

// --- the measured numbers actually land in the strings -------------------------------

test("C-TEL-2 substitutes the pair's own measured numbers", () => {
  // 2026 R13 Q, GAS vs RUS: closure 0.10524 s, worst sector residual 0.091063 s
  // (WP-8's golden fixture, which reproduces §1.4's published 4-109 ms band).
  const c = cTel2({ closureErrorS: 0.10524, worstSectorResidualS: 0.091063, nGaps: 15 });
  assert.match(c, /closes to within 105 ms of the official gap/);
  assert.match(c, /sector times to within 91 ms/);
  assert.match(c, /^Aligned on distance around the lap\. /);
  assert.match(c, /\b15 stretches of the lap/);
  assert.equal(c.includes("{"), false);
});

test("C-TEL-2 leads with the half-gap warning when the error is larger than half the gap", () => {
  const c = cTel2({
    closureErrorS: 0.312,
    worstSectorResidualS: 0.312,
    nGaps: 12,
    errorExceedsHalfGap: true,
  });
  assert.ok(c.startsWith(C_TEL_2_EXCEEDS_HALF_GAP));
  assert.ok(c.includes("Aligned on distance around the lap."));
});

test("C-TEL-2 drops the sector clause rather than inventing a residual", () => {
  const c = cTel2({ closureErrorS: 0.042, worstSectorResidualS: null, nGaps: 9 });
  assert.equal(c.includes("sector times"), false);
  assert.match(c, /closes to within 42 ms of the official gap — so read the shape/);
  assert.equal(c.includes("{"), false);
});

test("C-TEL-3 carries the lap's own sample count", () => {
  // ~626 merged samples on one flying lap (§1.3, measured).
  assert.match(cTel3(626), /^Painted from 626 samples taken ten times a second/);
  assert.equal(cTel3(593).includes("{"), false);
});

test("C-TEL-8 fires above 3% and is absent at or below it", () => {
  assert.equal(C_TEL_8_OVERLAP_THRESHOLD_PCT, 3);
  // Measured on GAS's 1:21.786 at Monza: overlap_pct 3.20 (§4.1 states 5.5; WP-4
  // reproduces 3.20 from the merged boolean at a 0.5 threshold).
  const c = cTel8(3.2);
  assert.ok(c !== null);
  assert.match(c as string, /^3\.2% of this lap reports full throttle and braking/);
  assert.equal(cTel8(3), null);
  assert.equal(cTel8(0), null);
  assert.equal(cTel8(null), null);
  assert.equal(cTel8(undefined), null);
});

// --- T11: the semantic trio appears nowhere in the feature ---------------------------

const TELEMETRY_FILES = [
  "lib/telemetry",
  "lib/queries/telemetry.ts",
  "components/charts/TrackMap.tsx",
  "components/charts/ChannelStack.tsx",
  "components/charts/CornerCard.tsx",
  "components/charts/DeltaTrace.tsx",
  "app/race/[year]/[round]/telemetry",
];

function filesUnder(root: string, rel: string): string[] {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return []; // a component another package owns may not have landed yet
  }
  if (st.isFile()) return [abs];
  return readdirSync(abs)
    // this test file names the tokens in its own pattern; scanning it would always fail
    .filter((n) => /\.(ts|tsx|css)$/.test(n) && !n.endsWith(".test.ts"))
    .map((n) => join(abs, n));
}

test("T11 — no --color-fastest/personal/slower in any telemetry file", () => {
  const webRoot = join(import.meta.dirname, "..", "..");
  const files = TELEMETRY_FILES.flatMap((rel) => filesUnder(webRoot, rel));
  assert.ok(files.length >= 4, `expected telemetry files to scan, got ${files.length}`);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (/--color-(fastest|personal|slower)|PALETTE\.(fastest|personal|slower)/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
});

// ====================================================================================
// GAPFILL_SPEC v1.8 §5.2 / §6.3 (WP-B2) — the Gap B drift test.
//
// Same discipline as the C-TEL block above: each string below is a SECOND, INDEPENDENT
// literal copy of §5.2's text. The R5 guard is the new part — `PINNED_CAPTION_NUMBERS`
// is checked against the digits that actually appear in the shipped strings, so the
// "about every 15 metres, good to about 8 metres" failure cannot recur silently.
// ====================================================================================
import {
  C_BRK_1,
  C_BRK_2,
  C_BRK_4,
  C_BRK_5,
  C_BRK_6,
  C_BRK_7,
  C_BRK_3_REASONS,
  BRAKE_CAPTIONS,
  TRAIL_STATUSES,
  PINNED_CAPTION_NUMBERS,
  FORBIDDEN_BRAKE_VOCABULARY,
  FORBIDDEN_VOCABULARY_EXCEPTIONS,
  TRAIL_RELEASE_STEP_MEDIAN_M,
  TRAIL_RELEASE_STEP_P95_M,
  TRAIL_IN_ZONE_STEP_MEDIAN_M,
  OFF_THE_BRAKES_ROUND_M,
  OFF_THE_BRAKES_INDISTINGUISHABLE_M,
  DISCREDITED_V1_DETECTOR_R,
  roundOffTheBrakesM,
  formatOffTheBrakes,
  offTheBrakesCell,
} from "@/lib/telemetry/captions";

const BRK = {
  C_BRK_1:
    "\"Off the brakes\" is how far before the apex the brake came off, measured from the brake channel, which is on-or-off. A negative number means the brake was still on at the apex. Inside a braking zone the channel is sampled about every five metres, and the moment it switches off is pinned to about four metres — so we round to the nearest five, and two drivers within ten metres of each other have not been shown to differ.",
  C_BRK_2:
    "This measures how long the brake was touched, not how hard. There is no brake-pressure channel in this data, so a driver feathering the brake to the apex and a driver still hard on it look exactly the same here.",
  C_BRK_4:
    "We also tried to measure how the brake pressure tapers off — the part of trail braking people actually mean. We cannot. With no pressure channel the only proxy is how the deceleration decays across the braking zone, and we measured it: on 3,329 corners where the same driver took the same corner twice in one weekend, that number agreed with itself at r = 0.001. It is noise, so we are not showing it.",
  C_BRK_5:
    "We also cannot turn this into a rating for a driver. We tried: the same driver, the same corner, the same car, two qualifying sessions of one weekend. His number changed about as much between his own two laps as it changes between him and everyone else. The missing ingredient is not a better brake channel — it is more laps. We store one lap per driver per session.",
  C_BRK_6:
    "Two drivers' braking numbers differ for reasons that have nothing to do with technique: how much fuel was in the car, how old the tyres were, how much wing the team chose, and where each driver was on the road. None of those are in this data. This shows what the brake channel did on one lap. It does not show who brakes better.",
  C_BRK_7:
    "Braking numbers come from qualifying laps. Only one race in this database has telemetry, so nothing here describes a race lap.",
} as const;

const BRK_3 = {
  taken_flat: "Nobody braked for this corner. It is taken flat.",
  shared_zone_non_terminal:
    "This corner shares one braking event with the corner after it, and a shared braking event has only one release — it belongs to the last corner in the complex.",
  too_few_samples:
    "The braking zone here has too few samples to say where the brake came off.",
  release_step_too_wide:
    "The gap between samples at the moment the brake came off is wider than the answer would be worth.",
  implied_decel_impossible:
    "The speed trace through this corner implies a deceleration no car can produce, so the samples here are not trustworthy.",
} as const;

test("C-BRK-1..7 are present and verbatim against §5.2", () => {
  assert.equal(C_BRK_1, BRK.C_BRK_1);
  assert.equal(C_BRK_2, BRK.C_BRK_2);
  assert.equal(C_BRK_4, BRK.C_BRK_4);
  assert.equal(C_BRK_5, BRK.C_BRK_5);
  assert.equal(C_BRK_6, BRK.C_BRK_6);
  assert.equal(C_BRK_7, BRK.C_BRK_7);
  // Seven captions: six fixed strings plus C-BRK-3, which is the six-string table below.
  assert.equal(Object.keys(BRAKE_CAPTIONS).length, 6);
});

test("C-BRK-3 pins all six trail_status strings, and measured carries none", () => {
  assert.deepEqual(
    [...TRAIL_STATUSES],
    [
      "measured",
      "taken_flat",
      "shared_zone_non_terminal",
      "too_few_samples",
      "release_step_too_wide",
      "implied_decel_impossible",
    ],
  );
  // A number is shown for `measured`; null, not "", so an unhandled case is a type error.
  assert.equal(C_BRK_3_REASONS.measured, null);
  assert.equal(C_BRK_3_REASONS.taken_flat, BRK_3.taken_flat);
  assert.equal(C_BRK_3_REASONS.shared_zone_non_terminal, BRK_3.shared_zone_non_terminal);
  assert.equal(C_BRK_3_REASONS.too_few_samples, BRK_3.too_few_samples);
  assert.equal(C_BRK_3_REASONS.release_step_too_wide, BRK_3.release_step_too_wide);
  assert.equal(C_BRK_3_REASONS.implied_decel_impossible, BRK_3.implied_decel_impossible);
  // Six keys, six statuses: the card cannot be handed a status with no rendering.
  assert.deepEqual(Object.keys(C_BRK_3_REASONS).sort(), [...TRAIL_STATUSES].sort());
});

// --- R5: no literal number in a caption that is not a pinned constant ----------------

/**
 * Every digit-bearing token in a string: "3,329", "0.001", "15", "8". The token may not
 * END on a separator, or a sentence-final full stop is swallowed into the number and
 * "0.001." never matches the pinned "0.001" — which would make the guard fire on a
 * caption that is in fact correct, and a guard that cries wolf gets deleted (R2).
 */
function numericLiterals(s: string): string[] {
  return s.match(/\d(?:[\d,.]*\d)?/g) ?? [];
}

test("R5 — every numeric literal in a C-BRK caption is a pinned constant", () => {
  const pinned = new Set(PINNED_CAPTION_NUMBERS.map((p) => p.literal));
  const strings: Array<[string, string]> = [
    ...Object.entries(BRAKE_CAPTIONS),
    ...Object.entries(C_BRK_3_REASONS).filter(([, v]) => v !== null),
  ] as Array<[string, string]>;
  assert.equal(strings.length, 11); // six captions + five reason strings
  const unpinned: string[] = [];
  for (const [name, text] of strings) {
    for (const lit of numericLiterals(text)) {
      if (!pinned.has(lit)) unpinned.push(`${name}: ${lit}`);
    }
  }
  assert.deepEqual(unpinned, [], "a caption carries a number no one pinned — see R5");
  // And every pinned number is actually used: a stale entry is a licence nobody needs.
  const used = new Set(strings.flatMap(([, t]) => numericLiterals(t)));
  for (const p of PINNED_CAPTION_NUMBERS) {
    assert.ok(used.has(p.literal), `pinned but unused: ${p.literal}`);
    assert.ok(p.provenance.length > 0, `pinned without provenance: ${p.literal}`);
  }
  assert.equal(PINNED_CAPTION_NUMBERS.length, 2);
});

test("R5 — the guard actually bites on the caption that failed before", () => {
  // The exact shipped sentence R5 exists to prevent, run through the same extractor.
  const wrong = "sampled about every 15 metres, good to about 8 metres";
  const pinned = new Set(PINNED_CAPTION_NUMBERS.map((p) => p.literal));
  const caught = numericLiterals(wrong).filter((l) => !pinned.has(l));
  assert.deepEqual(caught, ["15", "8"]);
});

test("R5 — C-BRK-1's spelled-out resolution matches WP-B1's pinned constants", () => {
  // The caption says the words; these are the numbers the words stand for. A future
  // re-derive that moves either constant past its rounding boundary fails here, which
  // is the whole point: the prose cannot drift away from the measurement in silence.
  assert.equal(Math.round(TRAIL_IN_ZONE_STEP_MEDIAN_M), 5); // "about every five metres"
  assert.equal(Math.round(TRAIL_RELEASE_STEP_MEDIAN_M), 4); // "pinned to about four metres"
  assert.ok(C_BRK_1.includes("sampled about every five metres"));
  assert.ok(C_BRK_1.includes("pinned to about four metres"));
  assert.ok(C_BRK_1.includes("round to the nearest five"));
  assert.ok(C_BRK_1.includes("within ten metres of each other have not been shown to differ"));
  assert.equal(OFF_THE_BRAKES_ROUND_M, 5);
  assert.equal(OFF_THE_BRAKES_INDISTINGUISHABLE_M, 10);
  // §3.2 reads 3.89 / 12.21 (n = 739, four sessions); WP-B1 re-derived 4.13 / 13.34 over
  // all 20,330 braked rows. Both are recorded, neither adjusted; the caption's claim
  // holds under either, and that is asserted rather than assumed.
  assert.equal(Math.round(3.89), 4);
  assert.ok(TRAIL_RELEASE_STEP_P95_M > TRAIL_RELEASE_STEP_MEDIAN_M);
});

// --- §5.2.1: forbidden vocabulary, greppable -----------------------------------------

test("forbidden vocabulary appears only in C-BRK-2 and C-BRK-4", () => {
  assert.deepEqual([...FORBIDDEN_VOCABULARY_EXCEPTIONS], ["C_BRK_2", "C_BRK_4"]);
  const exceptions = new Set<string>(FORBIDDEN_VOCABULARY_EXCEPTIONS);
  const all: Array<[string, string]> = [
    ...Object.entries(BRAKE_CAPTIONS),
    ...Object.entries(FIXED_CAPTIONS),
    ...Object.entries(CAPTION_TEMPLATES),
    ...Object.entries(C_BRK_3_REASONS).filter(([, v]) => v !== null),
  ] as Array<[string, string]>;
  const offenders: string[] = [];
  for (const [name, text] of all) {
    if (exceptions.has(name)) continue;
    for (const word of FORBIDDEN_BRAKE_VOCABULARY) {
      if (text.toLowerCase().includes(word)) offenders.push(`${name}: ${word}`);
    }
  }
  assert.deepEqual(offenders, []);
  // The two exceptions are on the list because they USE the words, not as a blanket
  // waiver — if either stops saying what it cannot measure, it leaves the list.
  assert.ok(C_BRK_2.toLowerCase().includes("pressure"));
  assert.ok(C_BRK_4.toLowerCase().includes("pressure"));
  assert.ok(C_BRK_4.toLowerCase().includes("taper"));
});

test("forbidden vocabulary appears in no copy string of the corner card", () => {
  const webRoot = join(import.meta.dirname, "..", "..");
  const src = readFileSync(join(webRoot, "components/charts/CornerCard.tsx"), "utf8");
  // Comments are prose ABOUT the rule and may name the words; copy is what a fan reads.
  // Strip block and line comments, then scan what is left.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const offenders = FORBIDDEN_BRAKE_VOCABULARY.filter((w) => code.toLowerCase().includes(w));
  assert.deepEqual(offenders, []);
  // The card must not inline a caption either: it imports them, so a rewrite of a
  // caption cannot leave a stale second copy on the page.
  assert.ok(src.includes("from \"@/lib/telemetry/captions\""));
});

// --- DL-22: the discredited v1 detector is recorded, never rendered ------------------

test("DL-22 — the discredited +0.26 to +0.47 result is published as wrong and shown nowhere", () => {
  assert.equal(DISCREDITED_V1_DETECTOR_R.verdict, "wrong");
  assert.equal(DISCREDITED_V1_DETECTOR_R.low, 0.26);
  assert.equal(DISCREDITED_V1_DETECTOR_R.high, 0.47);
  const all = [
    ...Object.values(BRAKE_CAPTIONS),
    ...Object.values(FIXED_CAPTIONS),
    ...Object.values(CAPTION_TEMPLATES),
    ...Object.values(C_BRK_3_REASONS).filter((v): v is string => v !== null),
  ];
  for (const text of all) {
    assert.equal(text.includes("0.26"), false);
    assert.equal(text.includes("0.47"), false);
    // and the season split-half, which R4 names as "exactly the number someone will quote"
    assert.equal(text.includes("0.874"), false);
    assert.equal(text.includes("0.286"), false);
  }
});

// --- §5.2: the column renders to the nearest 5 m, and never finer --------------------

test("the off-the-brakes column renders to the nearest 5 m", () => {
  assert.equal(roundOffTheBrakesM(63.2), 65);
  assert.equal(roundOffTheBrakesM(32.0), 30);
  assert.equal(roundOffTheBrakesM(12.4), 10);
  assert.equal(roundOffTheBrakesM(12.6), 15);
  assert.equal(roundOffTheBrakesM(-17.3), -15);
  assert.equal(formatOffTheBrakes(63.2), "+65 m");
  assert.equal(formatOffTheBrakes(150.7), "+150 m");
  // §5.2: signed, with "at the apex" for a negative value.
  assert.equal(formatOffTheBrakes(-17.3), "-15 m at the apex");
  // Inside the measurement's own error: the words, not a signed zero.
  assert.equal(formatOffTheBrakes(-0.9), "at the apex");
  assert.equal(formatOffTheBrakes(1.2), "at the apex");
  assert.equal(formatOffTheBrakes(0), "at the apex");
});

test("§5.2.5 — nothing is ever displayed to sub-5 m precision", () => {
  // Every stored value is 0.1 m resolution; sweep the decade and assert the rendered
  // magnitude is always a multiple of 5 and never carries a decimal point.
  for (let v = -200; v <= 200; v += 0.1) {
    const out = formatOffTheBrakes(Number(v.toFixed(1)));
    const digits = out.match(/\d+/);
    if (digits === null) {
      assert.equal(out, "at the apex");
      continue;
    }
    assert.equal(out.includes("."), false, `sub-5 m precision in ${out}`);
    assert.equal(Number(digits[0]) % OFF_THE_BRAKES_ROUND_M, 0, `not a multiple of 5: ${out}`);
  }
});

// --- §5.2.6: three states, three renderings, and no fourth ---------------------------

test("offTheBrakesCell gives a number, a flat sentence, or a named refusal", () => {
  assert.deepEqual(
    offTheBrakesCell({ trailStatus: "measured", brakeReleaseToApexM: 63.2 }),
    { kind: "measured", text: "+65 m", releaseToApexM: 63.2 },
  );
  const flat = offTheBrakesCell({ trailStatus: "taken_flat", brakeReleaseToApexM: null });
  assert.equal(flat.kind, "taken_flat");
  assert.equal(flat.kind === "taken_flat" ? flat.reason : "", BRK_3.taken_flat);
  // Each of the four refusals names WHICH thing happened — never a bare blank (§4.1).
  for (const s of ["shared_zone_non_terminal", "too_few_samples", "release_step_too_wide", "implied_decel_impossible"] as const) {
    const cell = offTheBrakesCell({ trailStatus: s, brakeReleaseToApexM: null });
    assert.equal(cell.kind, "refused");
    assert.equal(cell.kind === "refused" ? cell.status : "", s);
    assert.equal(cell.kind === "refused" ? cell.reason : "", C_BRK_3_REASONS[s]);
  }
  // A 'measured' row with no number is a broken write, not a missing measurement: it
  // surfaces as a wrong reason rather than as an unexplained blank.
  const broken = offTheBrakesCell({ trailStatus: "measured", brakeReleaseToApexM: null });
  assert.equal(broken.kind, "refused");
  assert.equal(broken.kind === "refused" ? broken.status : "", "too_few_samples");
});

// --- the column the fan actually sees, through the component's own path --------------

test("CornerCard's column renders to the nearest 5 m and names every refusal", async () => {
  // Imported dynamically so a failure to resolve the component reports as this test,
  // not as a module-load crash that takes the whole file with it.
  const { offTheBrakes } = await import("@/components/charts/CornerCard");
  const base = {
    driverId: "norris",
    cornerNumber: 2,
    cornerLetter: "",
    apexSpeedKph: 120,
    apexDistanceM: 1000,
    entrySpeedKph: 300,
    exitSpeedKph: 160,
    brakeZoneIdx: 0,
    brakePointM: 800,
    brakeDistanceM: 120,
    throttlePointM: 1010,
    timeInCornerS: 2.1,
  };
  // A measured row: 63.2 m renders +65 m — never 63.2, never 63 (§5.2.5).
  const measured = offTheBrakes({
    ...base,
    trailStatus: "measured",
    brakeReleaseToApexM: 63.2,
  });
  assert.equal(measured?.kind, "measured");
  assert.equal(measured?.kind === "measured" ? measured.text : "", "+65 m");
  // A negative row: still on at the apex, and it says so in the cell.
  const late = offTheBrakes({ ...base, trailStatus: "measured", brakeReleaseToApexM: -12.9 });
  assert.equal(late?.kind === "measured" ? late.text : "", "-15 m at the apex");
  // The 18.6 % of rows that are a positive report, not a gap.
  const flat = offTheBrakes({
    ...base,
    trailStatus: "taken_flat",
    brakeReleaseToApexM: null,
    brakePointM: null,
  });
  assert.equal(flat?.kind, "taken_flat");
  assert.equal(flat?.kind === "taken_flat" ? flat.reason : "", BRK_3.taken_flat);
  // The big one: R2, ~43.6 % of braked rows. The reason is a PROP, never a NULL.
  const shared = offTheBrakes({
    ...base,
    trailStatus: "shared_zone_non_terminal",
    brakeReleaseToApexM: null,
  });
  assert.equal(shared?.kind === "refused" ? shared.reason : "", BRK_3.shared_zone_non_terminal);
  // A driver with no row for this corner is the only case that renders nothing at all.
  assert.equal(offTheBrakes(undefined), null);
});

// --- report-both-and-stop: the n C-BRK-4 carries is not the taper's n ----------------

test("C-BRK-4's 3,329 is §3.3's release-metre n, not the taper's 2,867 — recorded, not fixed", () => {
  // §3.3's paired table, read row by row:
  //   brake_release_to_apex_m   paired n 3,329   de-meaned repeat r 0.286
  //   taper                     paired n 2,867   de-meaned repeat r 0.001
  // C-BRK-4 is about the TAPER (r = 0.001) but quotes 3,329 corners. The two figures
  // come from different rows of the same table. D8 makes the caption verbatim and the
  // spec is not mine to edit, so the string ships exactly as §5.2 writes it and the
  // disagreement is asserted here instead of being quietly corrected in either place.
  // This is the same class of error R5 exists to catch; it is flagged to the spec owner.
  assert.ok(C_BRK_4.includes("on 3,329 corners"));
  assert.ok(C_BRK_4.includes("agreed with itself at r = 0.001"));
  const SPEC_TAPER_PAIRED_N = 2867;
  const SPEC_RELEASE_METRE_PAIRED_N = 3329;
  assert.notEqual(SPEC_TAPER_PAIRED_N, SPEC_RELEASE_METRE_PAIRED_N);
  // Both are pinned in §3.3; neither has been adjusted to agree with the other.
  assert.equal(
    PINNED_CAPTION_NUMBERS.find((p) => p.literal === "3,329")?.value,
    SPEC_RELEASE_METRE_PAIRED_N,
  );
});
