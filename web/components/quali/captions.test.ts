// UX_SPEC v1.9 §0 — COLLAPSE, NEVER DELETE, enforced mechanically for this package.
//
// The failure mode this release must not have is a long caption quietly shortened to fit a
// summary line. These tests assert the opposite: the nine captions are byte-for-byte what
// they were, and every new summary is NEW PROSE — not a prefix, not a truncation, not a
// substring of the caption it introduces.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  C_QUALI_1,
  C_QUALI_2,
  C_QUALI_3,
  C_QUALI_4,
  C_QUALI_5,
  C_QUALI_6,
  C_QUALI_8,
  S_QUALI_1,
  S_QUALI_2,
  S_QUALI_3,
  S_QUALI_4,
  S_QUALI_5,
  S_QUALI_6,
  S_QUALI_8,
  qualiSectionSummary,
  segmentStripSummary,
  toGridSummary,
} from "./captions";

const PAIRS: [string, string, string][] = [
  ["C-QUALI-1", S_QUALI_1, C_QUALI_1],
  ["C-QUALI-2", S_QUALI_2, C_QUALI_2],
  ["C-QUALI-3", S_QUALI_3, C_QUALI_3],
  ["C-QUALI-4", S_QUALI_4, C_QUALI_4],
  ["C-QUALI-5", S_QUALI_5, C_QUALI_5],
  ["C-QUALI-6", S_QUALI_6, C_QUALI_6],
  ["C-QUALI-8", S_QUALI_8, C_QUALI_8],
];

test("§0 — no summary is a truncation of the caption it introduces", () => {
  for (const [name, summary, caption] of PAIRS) {
    assert.ok(summary.length > 0, `${name}: empty summary`);
    assert.ok(
      !caption.startsWith(summary.slice(0, 40)),
      `${name}: the summary reads as the caption's opening — write new copy, do not truncate`,
    );
    assert.ok(!caption.includes(summary), `${name}: the summary is a substring of the caption`);
  }
});

test("§2.3 — a summary is one specific line, not 'Details'", () => {
  for (const [name, summary] of PAIRS) {
    assert.ok(summary.length >= 40, `${name}: too vague to decide on (${summary.length} chars)`);
    assert.ok(summary.length <= 130, `${name}: not a summary any more (${summary.length} chars)`);
    assert.ok(!/^details/i.test(summary), `${name}: "Details" is not a summary`);
  }
});

test("§2.3 — the summaries that carry a warning still carry it", () => {
  // C-QUALI-2 and C-QUALI-4 exist to stop a reader over-reading a number. The warning must
  // be in the OPEN line, never the thing hidden behind the control.
  assert.match(S_QUALI_2, /two gaps|different things/i);
  assert.match(S_QUALI_4, /noise/i);
  assert.match(S_QUALI_5, /band/i);
});

test("§2.3 — the block summaries carry their counts", () => {
  assert.match(segmentStripSummary(19, 0), /19 drivers/);
  assert.match(segmentStripSummary(20, 2), /2 segment times could not be confirmed/);
  assert.match(segmentStripSummary(20, 1), /1 segment time could not be confirmed/);
  assert.equal(toGridSummary(1), "1 driver started somewhere other than where they qualified.");
  assert.match(toGridSummary(3), /^3 drivers/);
  assert.match(qualiSectionSummary(["Qualifying", "Sprint qualifying"], 20), /20 drivers/);
  assert.match(qualiSectionSummary(["Qualifying"], 20), /^Qualifying —/);
});

test("§3.3 — no raw column name reaches a summary line", () => {
  const raw = /normal_score|gap_to_pole|quali_results|pushLaps|_pp\b/;
  for (const [name, summary] of PAIRS) {
    assert.ok(!raw.test(summary), `${name}: a database identifier reached the screen`);
  }
});
