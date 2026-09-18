// MODE1_SPEC §7.5 — which optimal-stint row supplies the verbatim caption's tokens.
import test from "node:test";
import assert from "node:assert/strict";

import {
  OPTIMAL_STINT_CAPTION_MIN_ACTUAL_LAPS,
  optimalStintCaption,
  optimalStintCaptionRow,
} from "@/components/race/DegradationSection";
import type { OptimalStintRow } from "@/lib/queries/race";

function row(
  compound: string,
  nFits: number,
  slopeSource: string,
  optimalLaps: number,
  actualMedianLaps: number | null,
): OptimalStintRow {
  return {
    compound,
    nFits,
    slopeSource,
    optimalLaps,
    optimalLapsLo: optimalLaps - 5,
    optimalLapsHi: optimalLaps + 5,
    actualMedianLaps,
    slopeSPerLap: 0.05,
    slopeQ1: 0.01,
    slopeQ3: 0.09,
    pitLossS: 22.4,
    pitLossSource: "circuit",
    compoundColour: "#fff",
  } as OptimalStintRow;
}

/** Hungary 2024 as stored: SOFT has by far the most fits and is the least representative row. */
const HUNGARY_2024: OptimalStintRow[] = [
  row("HARD", 30, "session", 21.7, 28),
  row("MEDIUM", 21, "session", 28.1, 20.5),
  row("SOFT", 416, "pooled", 25.8, 6),
];

test("the caption row is not the one with the most fits", () => {
  const best = optimalStintCaptionRow(HUNGARY_2024);
  assert.equal(best?.compound, "HARD");
  assert.equal(best?.slopeSource, "session");
  const caption = optimalStintCaption(HUNGARY_2024);
  assert.ok(caption.includes("the clock says 21.7 laps and the race said 28"));
  assert.ok(!caption.includes("the race said 6"));
});

test("a slope fitted on this session beats a pooled one", () => {
  const best = optimalStintCaptionRow([
    row("HARD", 1100, "pooled", 30.3, 25),
    row("MEDIUM", 9, "session", 28.1, 18),
  ]);
  assert.equal(best?.compound, "MEDIUM");
});

test("splash stints are skipped, but never leave the caption without a row", () => {
  const floor = OPTIMAL_STINT_CAPTION_MIN_ACTUAL_LAPS;
  const best = optimalStintCaptionRow([
    row("SOFT", 400, "session", 25.8, floor),
    row("HARD", 30, "session", 21.7, floor + 1),
  ]);
  assert.equal(best?.compound, "HARD");
  // Every row a cameo: fall back to the whole set rather than render an em-dash caption.
  const cameos = [row("SOFT", 400, "pooled", 25.8, 6), row("MEDIUM", 9, "session", 28.1, 5)];
  assert.equal(optimalStintCaptionRow(cameos)?.compound, "MEDIUM");
  assert.equal(optimalStintCaptionRow([]), undefined);
});

test("no rows at all still produces the §7.5 sentence with em-dashes", () => {
  const caption = optimalStintCaption([]);
  assert.ok(caption.includes("the clock says — laps and the race said —"));
});
