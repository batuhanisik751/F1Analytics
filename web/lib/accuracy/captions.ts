// Fan-facing copy for /accuracy. Every number here is a template slot filled from the
// database — nothing is a literal, because the whole point of this page is that it changes
// when the model changes and a hardcoded figure would eventually be a lie.

/** The page's thesis, above everything. */
export const C_ACC_1 =
  "Every other page here tells you what happened. This one tells you how often we were " +
  "wrong. The numbers below are scored against races the model had never seen — a model " +
  "graded on races it trained on always looks better than it is, and both figures are " +
  "shown so you can see the size of that flattery.";

/** Above the skill table. */
export const C_ACC_2 =
  "Brier score measures a probability forecast: lower is better, and 0 would be perfect " +
  "foresight. On its own it means very little, so each one is shown against a baseline " +
  "that predicts from grid position alone. The percentage is how much of that baseline's " +
  "error we remove.";

/** The in-sample versus out-of-sample gap. Slots: inPct, outPct. */
export const cAcc3 = (inPct: string, outPct: string) =>
  `On races it trained on the model removes ${inPct} of the baseline's error. On circuits ` +
  `held out of training it removes ${outPct}. The second number is the honest one, and the ` +
  `gap between them is what a model flatters itself by when nobody checks.`;

/** Above the reliability chart. */
export const C_ACC_4 =
  "A forecast is calibrated when things it calls 30 % likely happen about 30 % of the time. " +
  "Each dot is a bucket of predictions: where we put it on the horizontal axis, how often " +
  "it actually happened on the vertical. The dashed line is perfect calibration. Bars are " +
  "the range the observed rate could plausibly take given how few races sit in that bucket.";

/** The interval-coverage headline. Slots: observed, nominal, n. */
export const cAcc5 = (observed: string, nominal: string, n: string) =>
  `Each race preview predicts a finishing position with a range around it. That range is ` +
  `built to contain the true finish ${nominal} of the time. Across ${n} predictions it ` +
  `actually contained it ${observed} of the time.`;

/**
 * What over-coverage means. Deliberately says which direction is the dangerous one, and
 * refuses to call the safe direction a virtue (ACCURACY_SPEC §2 / IDEAS §1 #5).
 */
export const C_ACC_6 =
  "Containing the answer more often than promised means the ranges are too wide: the model " +
  "is less sure than it needs to be. Being wide enough to be right is not a virtue on its " +
  "own, and the width beside this figure says how wide the ranges had to be. The dangerous " +
  "direction is the other one — a range that misses more often than it claims tells you a " +
  "prediction is firmer than the evidence behind it, and this one does not do that.";

/** Above the per-season table. */
export const C_ACC_7 =
  "Split by season, so you can see whether a miss is one unusual year or the method itself.";

/** The standing limitation. Slots: firstYear, lastYear — four-digit years ("2024", "2026"). */
export const cAcc8 = (firstYear: string, lastYear: string) =>
  `These scores cover the seasons in this database and nothing else. They say how well the ` +
  `model did on ${firstYear}–${lastYear} under one set of rules and one set of cars; they are ` +
  `not a claim about next season, and a model that scores well here can still be wrong about ` +
  `a race for reasons no score captures.`;


/**
 * The NULL rule, above the interval tiles. Slots: total, unscored, scored — counts ("685");
 * dnfAsMiss — a percentage ("80.9 %").
 */
export const cAcc9 = (total: string, unscored: string, scored: string, dnfAsMiss: string) =>
  `Not every prediction can be scored. Of ${total} race-preview predictions, ${unscored} have ` +
  `no classified finishing position to check against — the driver retired, did not start, ` +
  `was disqualified or was never classified — so every figure in this section is over the ` +
  `${scored} that do. Counting each unscorable prediction as a miss instead would put the ` +
  `contained-the-finish figure at ${dnfAsMiss}.`;

/**
 * Width verdict, rendered when share ≥ 60 %. Slots: width — places, one decimal ("15.1");
 * gridLo, gridHi — car counts ("20", "22"); share — a percentage ("77 %").
 */
export const cAcc10 = (width: string, gridLo: string, gridHi: string, share: string) =>
  `${cAcc10Narrow(width, gridLo, gridHi, share)} A range that wide is close to vacuous — it ` +
  `says almost nothing — and being right this often is mostly a matter of being wide.`;

/** The first sentence of cAcc10 alone, rendered when share < 60 %. Same slots and formats. */
export const cAcc10Narrow = (width: string, gridLo: string, gridHi: string, share: string) =>
  `The typical range ran ${width} places wide on grids of ${gridLo} to ${gridHi} cars, ` +
  `covering about ${share} of the finishing positions a driver could take.`;

/** What the interval score is. */
export const C_ACC_11 =
  "One number scores width and misses together: the width of the range in places, plus ten " +
  "places for every place the finish landed outside it, so lower is better. A range can " +
  "contain the answer more often and still score worse, by being wider than it needs to be.";

/**
 * Model score against the no-model range. Slots: model, naive — scores, one decimal ("15.9",
 * "14.0"); k — places ("7"); scored — a count ("585").
 */
export const cAcc12 = (model: string, k: string, naive: string, scored: string) =>
  `Our range scores ${model}. A range needing no model at all — the starting-grid slot plus ` +
  `or minus ${k} places, cut off at the ends of the grid — scores ${naive} on the same ` +
  `${scored} predictions.`;

/** Follows cAcc12 when the no-model range scores better (naive < model). */
export const C_ACC_13_NAIVE =
  "The no-model range scores better. Our range is wider than it needs to be, not sharper " +
  "than a grid slot.";

/** Follows cAcc12 when our range scores better (model < naive). */
export const C_ACC_13_MODEL = "Our range scores better than the no-model one.";

/** Point-guess error. Slots: gridMae, modelMae — places, one decimal ("2.8", "3.7"). */
export const cAcc14 = (gridMae: string, modelMae: string) =>
  `As a single guess, the grid slot missed the finish by ${gridMae} places on average; the ` +
  `model's expected position missed by ${modelMae}.`;

/** What the season-points projection check is. Slot: nominal — a percentage ("80 %"). */
export const cAcc15 = (nominal: string) =>
  `After every round the title model also projects each driver's end-of-season points, with ` +
  `a range built to contain the final total ${nominal} of the time. Once a season is over ` +
  `those projections can be marked against the real final table, by quarter of the season. ` +
  `Only finished seasons are scored, and each season's last projection is left out: by then ` +
  `the total is already known.`;

/**
 * One finished season's first and last quarter. Slots: year — a four-digit year ("2024");
 * covQ1, nominal, covQ4 — percentages ("14.4 %", "80 %", "88.7 %"); maeQ1, maeQ4 — points,
 * one decimal ("80.4", "9.0").
 */
export const cAcc16 = (
  year: string,
  covQ1: string,
  nominal: string,
  maeQ1: string,
  covQ4: string,
  maeQ4: string,
) =>
  `In ${year}, the range held the eventual final total for ${covQ1} of the projections made ` +
  `in the first quarter of the season, against the ${nominal} promised, and the projected ` +
  `total was ${maeQ1} points off on average. In the last quarter it held it for ${covQ4}, ` +
  `${maeQ4} points off.`;

/** The evidence limit under the quarters table. Slot: nSeasons — a count as a word ("two"). */
export const cAcc17 = (nSeasons: string) =>
  `That is ${nSeasons} finished seasons of evidence, not hundreds of independent trials: every ` +
  `projection made after the same round shares the same standings and the same fitted form, ` +
  `so the rows are counts, not a calibration. This scores the points projection only. It does ` +
  `not say whether the title probabilities themselves are right as often as they claim — ` +
  `${nSeasons} decided titles cannot show that — and it grades no driver.`;

/** How each quarter row is built. */
export const C_ACC_18 =
  "Each row pools every driver's projection made in that quarter and checks it against the " +
  "points that driver actually finished on, including drivers who joined or left mid-season. " +
  "A projection made from the prior alone, before a driver had raced, is kept and counted. " +
  "The final-round row of a finished season is left out because it restates the result " +
  "rather than forecasting it.";

/** Shown when a scope has no rows yet. */
export const C_ACC_EMPTY =
  "No scored predictions yet. This page fills in once the model has been trained and the " +
  "races it predicted have been run.";
