// UX_SPEC §3.2 — one entry per term a fan meets on screen.
//
// Written for someone who follows F1 and has never taken a statistics course. `short` is the
// tooltip line (<= 12 words, checked by the test); `long` is the /glossary page. No entry may
// contain a raw database column name (§3.3) except to say what it used to be called.
export type GlossaryEntry = {
  /** Display name, exactly as it should appear in a heading. */
  term: string;
  /** <= 12 words. Shown in the `<TermTip>` bubble. */
  short: string;
  /** A sentence or two for /glossary. */
  long: string;
  /** Ids of related entries. Validated against the key set by the test. */
  seeAlso: readonly string[];
};

const ENTRIES = {
  pp: {
    term: "% of a lap (pp)",
    short: "Percent of a lap: a gap measured as a share of laptime.",
    long:
      "A gap written as a share of the lap instead of raw seconds. One percent of a lap is about 0.9 s on a 90-second lap, so a driver 0.77 % of a lap quicker is roughly 0.69 s quicker there. Using a share lets Monza and Monaco sit on one scale. Fan-facing copy says “% of a lap”; the abbreviation pp survives only where a chart axis is labelled and defined.",
    seeAlso: ["normal-score", "percentile-range"],
  },
  "normal-score": {
    term: "Rank scale",
    short: "A rank position on a stretched scale, not a lap time.",
    long:
      "Stored as normal_score, which should never reach the screen. Drivers are put in order, then those ranks are spread onto a scale centred on zero where nearly the whole field falls between −2 and +2. −1.1 means “towards the back of this group”, not “1.1 seconds off”. It cannot be converted to seconds, and two rank scales built from different skills are not the same ruler.",
    seeAlso: ["pp", "component-anchored"],
  },
  "percentile-range": {
    term: "5th–95th percentile range",
    short: "Where 9 of every 10 laps landed; extremes cut off.",
    long:
      "Sort the laps from quickest to slowest, then cut the fastest 5 % and the slowest 5 %. What is left is the range a typical lap lands in. The cut is what makes the bar useful: one safety-car crawl or one hero lap can no longer set its width.",
    seeAlso: ["green-flag-lap", "observation"],
  },
  observation: {
    term: "Observation",
    short: "One usable lap or comparison that fed this particular number.",
    long:
      "A single data point behind a figure — usually one lap, sometimes one qualifying session or one team-mate comparison. Counts differ between skills because each skill can only count the laps that answer it: wet pace can only use wet laps, so it has far fewer observations than race pace. The count is printed so you can see how much the number is resting on.",
    seeAlso: ["evidence-share", "green-flag-lap"],
  },
  "pooling-prior": {
    term: "Pooling prior",
    short: "A cautious starting guess that pulls thin evidence toward average.",
    long:
      "Before any laps are looked at, every driver is assumed to be an average driver. Evidence moves him off that assumption, and more evidence moves him further. Eight laps leaves a driver close to the starting guess; eight hundred moves him almost entirely on his own merit. This is why one strong weekend does not put a rookie top of the chart.",
    seeAlso: ["evidence-share", "total-sd"],
  },
  "total-sd": {
    term: "Total SD",
    short: "How far the real value could sit from the number shown.",
    long:
      "Standard deviation: the typical distance between the figure reported and the truth. About two-thirds of the time the real value is within one SD of it, and about 19 times in 20 within two. A small SD means the estimate is pinned down. A large one means read the direction and ignore the last digit.",
    seeAlso: ["pooling-prior", "evidence-share"],
  },
  "component-anchored": {
    term: "Component-anchored",
    short: "Ranked only against drivers linked by a chain of team-mates.",
    long:
      "Ratings are built by comparing team-mates and then chaining those comparisons: A out-qualified B, B later moved to C’s team. Every driver reachable through such a chain forms one connected group. A driver whose group does not join the rest of the grid can be ranked honestly inside his own group and nowhere else, so his rating is anchored there and says how many drivers it covers.",
    seeAlso: ["island-driver", "normal-score"],
  },
  "evidence-share": {
    term: "Evidence share",
    short: "How much of a number comes from laps, not assumption.",
    long:
      "The part of the reported value carried by this driver’s own laps rather than by the cautious starting guess. “Half of it rests on the prior” means the model is leaning as hard on its default as on the evidence. High evidence share: the figure is measured. Low: trust the direction, not the digits.",
    seeAlso: ["pooling-prior", "observation"],
  },
  "fuel-corrected": {
    term: "Fuel-corrected",
    short: "Lap times adjusted so heavy and light laps compare fairly.",
    long:
      "A car burns roughly 1.5–1.8 kg of fuel a lap and gets quicker as it empties, worth something like 0.03 s per lap. Fuel correction removes that trend so a lap early in a stint can be compared with one at the end. Without it every driver appears to improve as the race goes on, which is the fuel load and not the driver.",
    seeAlso: ["degradation", "stint"],
  },
  degradation: {
    term: "Degradation",
    short: "How much slower each lap gets as the tyre wears.",
    long:
      "The rate lap time falls away within a stint as the tyre loses grip, quoted in seconds per lap. It is measured on fuel-corrected green-flag laps, because fuel burn and safety cars both push lap times the other way. A soft tyre normally degrades faster than a hard one, which is what makes spending 20-odd seconds in the pit lane worth it.",
    seeAlso: ["stint", "fuel-corrected", "green-flag-lap"],
  },
  stint: {
    term: "Stint",
    short: "The run of laps between one pit stop and the next.",
    long:
      "Everything done on one set of tyres: the out-lap, the racing laps, the in-lap. Stint length is the strategy decision — run longer and the tyre gives up, stop earlier and you spend another 20-odd seconds in the pit lane.",
    seeAlso: ["degradation", "green-flag-lap"],
  },
  "green-flag-lap": {
    term: "Green-flag lap",
    short: "A normal racing lap: no safety car, no pit, not lap one.",
    long:
      "A lap run at full racing speed under green flags. Safety-car and virtual safety-car laps are left out, as are the in-lap and out-lap around a pit stop and the first lap of the race, which is decided by the start rather than by pace. This is why the lap count behind a pace figure is smaller than the race distance.",
    seeAlso: ["stint", "observation"],
  },
  "brier-score": {
    term: "Brier score",
    short: "A score for forecasts: lower is better, zero is perfect.",
    long:
      "Scores a probability against what actually happened. Call something 70 % and it happens, you are charged 0.09; call it and it does not, 0.49. Averaged over many races it rewards being confident and right and punishes being confident and wrong. Read it against a baseline: saying 50 % to everything scores 0.25.",
    seeAlso: ["calibration"],
  },
  calibration: {
    term: "Calibration",
    short: "Do things called 70% likely happen about 70% of the time?",
    long:
      "A check on honesty rather than on sharpness. Gather every forecast near 70 % and count how many came in: close to 70 % is well calibrated, 40 % is overconfident. A model can be perfectly calibrated and still useless — always saying “about average” is honest and tells you nothing — so calibration is read next to the Brier score, not instead of it.",
    seeAlso: ["brier-score", "counterfactual"],
  },
  counterfactual: {
    term: "Counterfactual",
    short: "A what-if: same driver, different car or different strategy.",
    long:
      "A re-run of a season or a race with one thing changed and everything else held still — this driver in that car, or this stop three laps later. It is a model’s answer, not a result, and it assumes nobody else would have raced differently. Use it to size a difference, not to settle an argument.",
    seeAlso: ["calibration", "island-driver"],
  },
  "island-driver": {
    term: "Island driver",
    short: "A driver no chain of team-mates connects to the grid.",
    long:
      "Ratings travel through shared team-mates, and an island driver has no such path to the rest of the field — a team whose two drivers raced nowhere else, for example. He can be ranked against the drivers he shared a garage with and honestly nowhere else, so the app says that instead of printing a grid-wide rank it cannot support.",
    seeAlso: ["component-anchored", "normal-score"],
  },
  "correlation-r": {
    term: "Correlation (r)",
    short: "Do two measures move together? 1 yes, 0 no, −1 opposite.",
    long:
      "One number between −1 and +1 for how closely two things track each other. r = 0.77 means they mostly agree; r = 0.10 means knowing one tells you almost nothing about the other. It is rounded to two decimals here because the third is noise. Agreement is not cause: two skills can move together simply because both reward a quick car.",
    seeAlso: ["total-sd", "evidence-share"],
  },
  "chord-distance": {
    term: "Chord distance",
    short: "How different two cornering shapes are, as one number.",
    long:
      "Two drivers’ traces through the same corner are compared point by point and the differences are rolled into a single distance: zero is an identical line, larger is more unalike. It measures how much two styles differ, never which of them is quicker.",
    seeAlso: ["trail-braking"],
  },
  "drs-no-signal": {
    term: "DRS: no signal",
    short: "The car never logged its rear wing opening on these laps.",
    long:
      "The DRS channel in the timing feed is blank or unchanging for the laps in question, so there is nothing to measure. That is not the same as the driver not using DRS: the app refuses to report a figure rather than turn a missing channel into a zero.",
    seeAlso: ["observation"],
  },
  "trail-braking": {
    term: "Trail braking",
    short: "Carrying brake pressure into the corner after turning in.",
    long:
      "Easing off the brake gradually while already turning rather than finishing the braking in a straight line. It keeps load on the front tyres and helps the car rotate. It is measured from the overlap between brake pressure and steering angle, so it describes a style and is not a verdict on speed.",
    seeAlso: ["chord-distance"],
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof ENTRIES;

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = ENTRIES;

/** Insertion order is the order /glossary renders in; it is deliberately grouped, not alphabetical. */
export const GLOSSARY_IDS = Object.keys(ENTRIES) as GlossaryId[];

/** The anchor `<TermTip>` links to. Stable: ids are part of the URL contract. */
export function glossaryHref(id: GlossaryId): string {
  return `/glossary#${id}`;
}

export function glossaryEntry(id: GlossaryId): GlossaryEntry {
  return ENTRIES[id];
}
