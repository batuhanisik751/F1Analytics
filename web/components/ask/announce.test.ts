// UX_SPEC §4.8 — the ask box's live-region text.
//
// These assertions exist because the announcement is the ONLY thing a screen-reader user gets when
// the answer replaces the progress panel, and because §0 says the collapsed parts of the answer
// (the query, the caveat) must still be findable — here, by being named out loud.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { askAnnouncement } from "./announce";

test("idle says nothing, so the region never repeats a stale answer", () => {
  assert.equal(askAnnouncement({ kind: "idle" }), "");
});

test("running names the state and the question", () => {
  const s = askAnnouncement({
    kind: "running",
    question: "tyre degradation at Monaco",
    stateTitle: "Checking the query",
  });
  assert.match(s, /Checking the query/);
  assert.match(s, /tyre degradation at Monaco/);
});

test("an answer announces the headline, the row count and the collapsed query", () => {
  const s = askAnnouncement({
    kind: "answer",
    headline: "Hamilton out-qualified his teammate 14 times",
    rowCount: 12,
    hasCaveat: false,
  });
  assert.match(s, /Answer ready/);
  assert.match(s, /Hamilton out-qualified his teammate 14 times/);
  assert.match(s, /12 rows/);
  assert.match(s, /show query/);
  assert.doesNotMatch(s, /caveat/);
});

test("a caveat is announced, never silently collapsed (§0)", () => {
  const s = askAnnouncement({
    kind: "answer",
    headline: "x",
    rowCount: 1,
    hasCaveat: true,
  });
  assert.match(s, /caveat/);
  assert.match(s, /1 row\./);
});

test("zero rows is said in words, not as a count of nothing", () => {
  const s = askAnnouncement({ kind: "answer", headline: "x", rowCount: 0, hasCaveat: false });
  assert.match(s, /returned no rows/);
});

test("a result event that has not arrived yet claims no row count", () => {
  const s = askAnnouncement({ kind: "answer", headline: "x", rowCount: null, hasCaveat: false });
  assert.doesNotMatch(s, /row/);
});

test("clarify, out of scope and failure each say what happened", () => {
  assert.match(
    askAnnouncement({ kind: "clarify", clarification: "Which season?" }),
    /one more detail[\s\S]*Which season\?/,
  );
  assert.match(
    askAnnouncement({ kind: "out_of_scope", reason: "no weather data is stored" }),
    /cannot answer[\s\S]*no weather data is stored/,
  );
  assert.match(askAnnouncement({ kind: "failed" }), /could not be answered/);
});
