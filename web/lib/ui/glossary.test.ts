// UX_SPEC §3.2 / §3.3 — the glossary is a contract: the terms it must carry, the length of a
// tooltip line, and the promise that no raw database column name reaches the screen.
import test from "node:test";
import assert from "node:assert/strict";

import { GLOSSARY, GLOSSARY_IDS, glossaryEntry, glossaryHref } from "@/lib/ui/glossary";

/** §3.2 — the minimum set, by the wording of the spec. */
const REQUIRED: Record<string, string> = {
  pp: "pp",
  "normal-score": "normal score",
  "percentile-range": "percentile range",
  observation: "observation",
  "pooling-prior": "pooling prior",
  "total-sd": "total SD",
  "component-anchored": "component / anchored",
  "evidence-share": "evidence share",
  "fuel-corrected": "fuel-corrected",
  degradation: "degradation",
  stint: "stint",
  "green-flag-lap": "green-flag lap",
  "brier-score": "Brier score",
  calibration: "calibration",
  counterfactual: "counterfactual",
  "island-driver": "island driver",
  "correlation-r": "correlation (r)",
  "chord-distance": "chord distance",
  "drs-no-signal": "DRS no signal",
  "trail-braking": "trail braking",
};

test("every term §3.2 requires has an entry", () => {
  for (const [id, spelling] of Object.entries(REQUIRED)) {
    assert.ok(id in GLOSSARY, `missing glossary entry "${id}" (spec: ${spelling})`);
  }
  assert.equal(GLOSSARY_IDS.length >= Object.keys(REQUIRED).length, true);
});

test("short definitions are at most 12 words — they have to fit a tooltip", () => {
  for (const id of GLOSSARY_IDS) {
    const words = GLOSSARY[id].short.trim().split(/\s+/);
    assert.ok(words.length <= 12, `"${id}" short is ${words.length} words: ${GLOSSARY[id].short}`);
    assert.ok(GLOSSARY[id].long.length > GLOSSARY[id].short.length, `"${id}" long is not longer`);
  }
});

test("seeAlso only points at terms that exist, and never at itself", () => {
  for (const id of GLOSSARY_IDS) {
    for (const other of GLOSSARY[id].seeAlso) {
      assert.notEqual(other, id, `"${id}" sees also itself`);
      assert.ok(other in GLOSSARY, `"${id}" sees also unknown term "${other}"`);
    }
  }
});

test("§3.3 — no raw column name is used as a display term", () => {
  for (const id of GLOSSARY_IDS) {
    assert.ok(!/_/.test(GLOSSARY[id].term), `"${id}" term looks like a column: ${GLOSSARY[id].term}`);
    assert.ok(!/_/.test(GLOSSARY[id].short), `"${id}" short contains a column name`);
  }
  // The rank-scale entry is the one place normal_score may be named, and only to retire it.
  assert.equal(GLOSSARY["normal-score"].term, "Rank scale");
  assert.match(GLOSSARY["normal-score"].long, /normal_score/);
  assert.match(GLOSSARY["normal-score"].short, /not a lap time/);
});

test("anchors are stable and slug-shaped — TermTip links to them", () => {
  for (const id of GLOSSARY_IDS) {
    assert.match(id, /^[a-z0-9-]+$/, `id "${id}" is not a URL slug`);
    assert.equal(glossaryHref(id), `/glossary#${id}`);
    assert.equal(glossaryEntry(id), GLOSSARY[id]);
  }
});
