// UX_SPEC §3.3 — the header diagnostics are rewritten, never dropped. These tests pin both:
// that every `sim:` string the corpus actually contains gets a plain sentence, and that the
// sentence carries the same numbers the raw string did (§0: no number loses its sample size).
import assert from "node:assert/strict";
import { test } from "node:test";
import { explainWarning, splitWarnings, warningScope, warningsSummary } from "./warnings";

// The distinct shapes present in session_ingests.warnings across all 75 ingested sessions.
const CORPUS = [
  "sim: pit loss not estimable (2 green stops < 5); calibration uses 22.5 s",
  "sim: SOFT not parameterised (12 fit rows < 30)",
  "sim: SOFT not parameterised (1 fit rows < 30)",
  "sim: MEDIUM stint scatter capped (level 0.800, slope 0.087)",
  "sim: HARD degradation -0.002 floored to 0",
  "sim: SC pit factor -0.45 from 13 stops out of range [0.3, 1.3], using pooled",
  "sim: VSC pit factor 1.75 from 6 stops out of range [0.3, 1.3], using pooled",
];

test("every sim warning shape in the corpus becomes a sentence", () => {
  for (const w of CORPUS) {
    const plain = explainWarning(w);
    assert.ok(plain, `no plain sentence for: ${w}`);
    assert.ok(plain.length > 40, `too terse for: ${w}`);
    assert.ok(/[.]$/.test(plain), `not a sentence: ${w}`);
  }
});

test("§0 — the numbers in the raw diagnostic survive the rewrite", () => {
  const plain = explainWarning(CORPUS[0]) ?? "";
  for (const n of ["2", "5", "22.5"]) assert.ok(plain.includes(n), `lost ${n}`);

  const notParam = explainWarning(CORPUS[1]) ?? "";
  for (const n of ["12", "30"]) assert.ok(notParam.includes(n), `lost ${n}`);

  const factor = explainWarning(CORPUS[5]) ?? "";
  for (const n of ["13", "-0.45", "0.3", "1.3"]) assert.ok(factor.includes(n), `lost ${n}`);
});

test("§3.3 — no raw pipeline token reaches the rewritten sentence", () => {
  for (const w of CORPUS) {
    const plain = explainWarning(w) ?? "";
    for (const token of ["sim:", "not parameterised", "fit rows", "green stops", "using pooled"]) {
      assert.ok(!plain.includes(token), `${token} leaked into: ${plain}`);
    }
  }
});

test("an unrecognised string returns null so the caller shows the original", () => {
  assert.equal(explainWarning("sim: something nobody has written yet"), null);
  assert.equal(explainWarning("quali_cross_segment_ok=True"), null);
});

test("only sim warnings are routed out of the page header", () => {
  const all = [...CORPUS, "quali_segment_repairs=0", "telemetry: stroll: argmin of an empty sequence"];
  const { sim, other } = splitWarnings(all);
  assert.equal(sim.length, CORPUS.length);
  assert.deepEqual(other, ["quali_segment_repairs=0", "telemetry: stroll: argmin of an empty sequence"]);
  // §0 — nothing is lost in the split.
  assert.equal(sim.length + other.length, all.length);
  assert.equal(warningScope("quali_anchor_pre=45/45"), "other");
});

test("§2.3 — the summary line carries the count", () => {
  assert.match(warningsSummary(1), /^1 thing /);
  assert.match(warningsSummary(3), /^3 things /);
});
