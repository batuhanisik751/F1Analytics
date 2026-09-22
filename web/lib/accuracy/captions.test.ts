// ACCURACY_SPEC §2 / §5 — the /accuracy copy guard.
//
//   1. Every export is pinned BYTE-FOR-BYTE: fixed strings by assert.equal, templates called
//      with marker slots `{x}` so the surrounding text is frozen and the slot positions checked.
//   2. No template holds a digit, a driver name or a month: every such value is a slot.
//   3. The forbidden words never appear, and the §6 must-not phrases are present.
import test from "node:test";
import assert from "node:assert/strict";

import * as C from "@/lib/accuracy/captions";

// --- 1. byte-for-byte pins ------------------------------------------------------------

test("fixed strings are byte-for-byte", () => {
  assert.equal(
    C.C_ACC_1,
    "Every other page here tells you what happened. This one tells you how often we were wrong. The numbers below are scored against races the model had never seen — a model graded on races it trained on always looks better than it is, and both figures are shown so you can see the size of that flattery.",
  );
  assert.equal(
    C.C_ACC_2,
    "Brier score measures a probability forecast: lower is better, and 0 would be perfect foresight. On its own it means very little, so each one is shown against a baseline that predicts from grid position alone. The percentage is how much of that baseline's error we remove.",
  );
  assert.equal(
    C.C_ACC_4,
    "A forecast is calibrated when things it calls 30 % likely happen about 30 % of the time. Each dot is a bucket of predictions: where we put it on the horizontal axis, how often it actually happened on the vertical. The dashed line is perfect calibration. Bars are the range the observed rate could plausibly take given how few races sit in that bucket.",
  );
  assert.equal(
    C.C_ACC_6,
    "Containing the answer more often than promised means the ranges are too wide: the model is less sure than it needs to be. Being wide enough to be right is not a virtue on its own, and the width beside this figure says how wide the ranges had to be. The dangerous direction is the other one — a range that misses more often than it claims tells you a prediction is firmer than the evidence behind it, and this one does not do that.",
  );
  assert.equal(
    C.C_ACC_7,
    "Split by season, so you can see whether a miss is one unusual year or the method itself.",
  );
  assert.equal(
    C.C_ACC_11,
    "One number scores width and misses together: the width of the range in places, plus ten places for every place the finish landed outside it, so lower is better. A range can contain the answer more often and still score worse, by being wider than it needs to be.",
  );
  assert.equal(
    C.C_ACC_13_NAIVE,
    "The no-model range scores better. Our range is wider than it needs to be, not sharper than a grid slot.",
  );
  assert.equal(C.C_ACC_13_MODEL, "Our range scores better than the no-model one.");
  assert.equal(
    C.C_ACC_18,
    "Each row pools every driver's projection made in that quarter and checks it against the points that driver actually finished on, including drivers who joined or left mid-season. A projection made from the prior alone, before a driver had raced, is kept and counted. The final-round row of a finished season is left out because it restates the result rather than forecasting it.",
  );
  assert.equal(
    C.C_ACC_EMPTY,
    "No scored predictions yet. This page fills in once the model has been trained and the races it predicted have been run.",
  );
});

test("templates are byte-for-byte around marker slots", () => {
  assert.equal(
    C.cAcc3("{inPct}", "{outPct}"),
    "On races it trained on the model removes {inPct} of the baseline's error. On circuits held out of training it removes {outPct}. The second number is the honest one, and the gap between them is what a model flatters itself by when nobody checks.",
  );
  assert.equal(
    C.cAcc5("{observed}", "{nominal}", "{n}"),
    "Each race preview predicts a finishing position with a range around it. That range is built to contain the true finish {nominal} of the time. Across {n} predictions it actually contained it {observed} of the time.",
  );
  assert.equal(
    C.cAcc8("{firstYear}", "{lastYear}"),
    "These scores cover the seasons in this database and nothing else. They say how well the model did on {firstYear}–{lastYear} under one set of rules and one set of cars; they are not a claim about next season, and a model that scores well here can still be wrong about a race for reasons no score captures.",
  );
  // the deprecated alias is the template with its markers unfilled, never a literal year
  assert.equal(
    C.cAcc9("{total}", "{unscored}", "{scored}", "{dnfAsMiss}"),
    "Not every prediction can be scored. Of {total} race-preview predictions, {unscored} have no classified finishing position to check against — the driver retired, did not start, was disqualified or was never classified — so every figure in this section is over the {scored} that do. Counting each unscorable prediction as a miss instead would put the contained-the-finish figure at {dnfAsMiss}.",
  );
  assert.equal(
    C.cAcc10("{width}", "{gridLo}", "{gridHi}", "{share}"),
    "The typical range ran {width} places wide on grids of {gridLo} to {gridHi} cars, covering about {share} of the finishing positions a driver could take. A range that wide is close to vacuous — it says almost nothing — and being right this often is mostly a matter of being wide.",
  );
  assert.equal(
    C.cAcc10Narrow("{width}", "{gridLo}", "{gridHi}", "{share}"),
    "The typical range ran {width} places wide on grids of {gridLo} to {gridHi} cars, covering about {share} of the finishing positions a driver could take.",
  );
  assert.equal(
    C.cAcc12("{model}", "{k}", "{naive}", "{scored}"),
    "Our range scores {model}. A range needing no model at all — the starting-grid slot plus or minus {k} places, cut off at the ends of the grid — scores {naive} on the same {scored} predictions.",
  );
  assert.equal(
    C.cAcc14("{gridMae}", "{modelMae}"),
    "As a single guess, the grid slot missed the finish by {gridMae} places on average; the model's expected position missed by {modelMae}.",
  );
  assert.equal(
    C.cAcc15("{nominal}"),
    "After every round the title model also projects each driver's end-of-season points, with a range built to contain the final total {nominal} of the time. Once a season is over those projections can be marked against the real final table, by quarter of the season. Only finished seasons are scored, and each season's last projection is left out: by then the total is already known.",
  );
  assert.equal(
    C.cAcc16("{year}", "{covQ1}", "{nominal}", "{maeQ1}", "{covQ4}", "{maeQ4}"),
    "In {year}, the range held the eventual final total for {covQ1} of the projections made in the first quarter of the season, against the {nominal} promised, and the projected total was {maeQ1} points off on average. In the last quarter it held it for {covQ4}, {maeQ4} points off.",
  );
  assert.equal(
    C.cAcc17("{nSeasons}"),
    "That is {nSeasons} finished seasons of evidence, not hundreds of independent trials: every projection made after the same round shares the same standings and the same fitted form, so the rows are counts, not a calibration. This scores the points projection only. It does not say whether the title probabilities themselves are right as often as they claim — {nSeasons} decided titles cannot show that — and it grades no driver.",
  );
});

// --- 2. no literals in copy -----------------------------------------------------------

/** Every export, templates rendered with an empty marker so only the fixed text is swept. */
const ALL: Record<string, string> = Object.fromEntries(
  Object.entries(C).map(([id, v]) => [id, typeof v === "function" ? (v as (...a: string[]) => string)(...Array(v.length).fill("")) : v]),
);

test("every export is covered by the sweep", () => {
  assert.equal(Object.keys(ALL).length, 21);
});

// Spec-listed unchanged strings whose only digits define a scale, not a measurement:
// C_ACC_2 ("0 would be perfect foresight") and C_ACC_4 ("30 % likely ... 30 % of the time").
const DEFINITIONAL = new Set(["C_ACC_2", "C_ACC_4"]);

test("no template holds a digit, a driver name or a month", () => {
  const names = /antonelli|russell|hamilton|norris|leclerc|verstappen|piastri/i;
  const months =
    /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;
  for (const [id, copy] of Object.entries(ALL)) {
    if (!DEFINITIONAL.has(id)) assert.doesNotMatch(copy, /\d/, `${id} holds a literal number`);
    assert.doesNotMatch(copy, names, `${id} holds a driver name`);
    assert.doesNotMatch(copy, months, `${id} holds a date`);
  }
});

test("forbidden words appear nowhere", () => {
  for (const [id, copy] of Object.entries(ALL)) {
    assert.doesNotMatch(copy, /\b(live|real-time|up to date)\b/i, id);
    assert.doesNotMatch(copy, /updated every hour/i, id);
  }
});

// --- 3. the §6 must-not phrases -------------------------------------------------------

test("C_ACC_6 names the dangerous direction and does not call under-confidence safer", () => {
  assert.match(C.C_ACC_6, /dangerous direction/);
  assert.doesNotMatch(C.C_ACC_6, /safer/);
  assert.match(C.C_ACC_6, /not a virtue on its own/);
});

test("cAcc17 refuses per-driver verdicts, calibration claims and a literal season count", () => {
  const out = C.cAcc17("{nSeasons}");
  assert.match(out, /grades no driver/);
  assert.match(out, /not a calibration/);
  assert.match(out, /not hundreds of independent trials/);
  assert.doesNotMatch(out, /\btwo\b/);
});

test("cAcc9 carries both the unscored and the dnf-as-miss slots", () => {
  const out = C.cAcc9("{total}", "{unscored}", "{scored}", "{dnfAsMiss}");
  assert.match(out, /\{unscored\}/);
  assert.match(out, /\{dnfAsMiss\}/);
});

test("cAcc10 names the verdict; cAcc10Narrow does not", () => {
  assert.match(C.cAcc10("{w}", "{lo}", "{hi}", "{s}"), /vacuous/);
  assert.doesNotMatch(C.cAcc10Narrow("{w}", "{lo}", "{hi}", "{s}"), /vacuous/);
  assert.match(C.C_ACC_13_NAIVE, /wider than it needs to be, not sharper/);
});
