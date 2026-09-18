// UX_SPEC §6 — THE CAPTION-PRESERVATION TEST. The single most important check in this release.
//
// §0 says: collapse, never delete. This app's identity is that it states what it cannot measure,
// so a caveat moved behind a <details> is progressive disclosure and a caveat removed to make a
// page tidier is a release blocker. This test is the mechanical difference between the two.
//
// It asserts DOM PRESENCE, never visibility. Section and Disclosure keep their bodies in the
// document when closed; asserting visibility would fail legitimately collapsed content and would
// push the next author to leave everything open, which is the opposite of what §2 asks for.
import assert from "node:assert/strict";
import { test, before, describe } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchRoute, parse, serverUp, visibleText } from "./dom";
import { explain, isPreserved } from "./preserved";

type Entry = {
  route: string;
  capturedAt: string;
  text: string;
  changed?: { spec: string; owner: string; verdict: string; why: string };
};

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(here, "captions.baseline.json"), "utf8")) as {
  note: string;
  entries: Entry[];
};

const byRoute = new Map<string, Entry[]>();
for (const e of baseline.entries) {
  const list = byRoute.get(e.route) ?? [];
  list.push(e);
  byRoute.set(e.route, list);
}

const rendered = new Map<string, string>();
let up = false;

before(async () => {
  up = await serverUp();
  if (!up) return;
  for (const route of byRoute.keys()) {
    rendered.set(route, visibleText(parse(await fetchRoute(route)).window.document));
  }
});

describe("caption preservation (UX_SPEC §0, §6)", () => {
  for (const [route, entries] of byRoute) {
    const kept = entries.filter((e) => !e.changed);

    test(`${route} — all ${kept.length} pre-existing strings still in the DOM`, (t) => {
      if (!up) return t.skip("dev server not reachable at A11Y_BASE_URL");
      const page = rendered.get(route)!;
      const lost = kept.filter((e) => !isPreserved(e.text, page));
      assert.deepEqual(
        lost.map((e) => explain(e.text, page)),
        [],
        `${lost.length} string(s) captured on ${route} are no longer in the DOM. §0: collapse, never delete.`,
      );
    });
  }

  // A string may only stop being present if someone wrote down why. This keeps the escape hatch
  // expensive: an author who deletes a caption has to name the spec clause that ordered it.
  test("every adjudicated change records a spec clause, an owner and a reason", () => {
    for (const e of baseline.entries.filter((x) => x.changed)) {
      const c = e.changed!;
      assert.ok(c.spec && c.owner && c.verdict, `incomplete record for ${e.text.slice(0, 60)}`);
      assert.ok(c.why.length > 80, `reason too thin for ${e.text.slice(0, 60)}`);
    }
  });

  test("the baseline still covers every route it claims to", () => {
    assert.ok(byRoute.size >= 9, `baseline covers ${byRoute.size} routes, expected at least 9`);
    for (const [route, entries] of byRoute) {
      assert.ok(entries.length > 0, `no baseline strings for ${route}`);
    }
  });
});
