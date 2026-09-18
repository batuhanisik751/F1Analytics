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

/** What over-coverage means. Deliberately says which direction is the dangerous one. */
export const C_ACC_6 =
  "Containing the answer more often than promised means the ranges are too wide: the model " +
  "is less sure than it needs to be. That is the safer way to be wrong. The dangerous " +
  "direction is the other one — a range that misses more often than it claims tells you a " +
  "prediction is firmer than the evidence behind it, and this one does not do that.";

/** Above the per-season table. */
export const C_ACC_7 =
  "Split by season, so you can see whether a miss is one unusual year or the method itself.";

/** The standing limitation. */
export const C_ACC_8 =
  "These scores cover the seasons in this database and nothing else. They say how well the " +
  "model did on 2024–2026 under one set of rules and one set of cars; they are not a claim " +
  "about next season, and a model that scores well here can still be wrong about a race " +
  "for reasons no score captures.";

/** Shown when a scope has no rows yet. */
export const C_ACC_EMPTY =
  "No scored predictions yet. This page fills in once the model has been trained and the " +
  "races it predicted have been run.";
