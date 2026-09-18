// UX_SPEC §3.3 — the vocabulary rules, as arithmetic.
import test from "node:test";
import assert from "node:assert/strict";

import {
  correlationGloss,
  formatCorrelation,
  ppSecondsHint,
  ppToSeconds,
  REFERENCE_LAP_S,
  usedOf,
} from "@/components/ui/metricFormat";

test("a share of a lap always carries its seconds equivalent at a stated lap", () => {
  assert.equal(REFERENCE_LAP_S, 90);
  assert.ok(Math.abs(ppToSeconds(-0.772) + 0.6948) < 1e-6);
  // The spec's own worked example: -0.772 % is about 0.69 s on a 90-second lap.
  assert.equal(ppSecondsHint(-0.772), "about 0.69 s on a 90-second lap");
  assert.equal(ppSecondsHint(1, 70), "about 0.70 s on a 70-second lap");
});

test("correlations round to two decimals and say what they mean", () => {
  assert.equal(formatCorrelation(0.7727), "r = 0.77 — they mostly agree");
  assert.equal(correlationGloss(0.91), "they say almost the same thing");
  assert.equal(correlationGloss(-0.72), "they mostly agree");
  assert.equal(correlationGloss(0.42), "they agree loosely");
  assert.equal(correlationGloss(0.05), "they are close to unrelated");
  assert.ok(!formatCorrelation(0.7727).includes("0.7727"), "four decimals must not survive");
});

test("a count never appears without its complement explained", () => {
  assert.equal(
    usedOf(888, 1054, "safety car, in- and out-laps, and first laps"),
    "888 of 1,054 laps used (84.3 %). 166 excluded: safety car, in- and out-laps, and first laps.",
  );
  assert.match(usedOf(0, 0, "no session ingested"), /^0 of 0 laps used \(0\.0 %\)\. 0 excluded/);
  assert.match(usedOf(3, 5, "wet running only", "sessions"), /3 of 5 sessions used/);
});
