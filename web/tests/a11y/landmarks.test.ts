// UX_SPEC §4.1, §4.2, §4.5, §4.6, §4.7 and §2.1 — the parts of the floor axe cannot see from a
// server render, asserted directly against the DOM of all ten routes.
import assert from "node:assert/strict";
import { test, describe, before } from "node:test";

import { ROUTES, fetchRoute, parse, serverUp } from "./dom";

const FOCUSABLE = "a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex='-1'])";

// One documented exception, with an owner. §4.2 wants one <h1> per page; the telemetry route
// opens at <h2>. app/race/[year]/[round]/telemetry/page.tsx belongs to WP-7, so this is a
// hand-off, recorded here rather than quietly dropped from the assertion.
const NO_H1: Record<string, string> = {
  "/race/2026/13/telemetry":
    "HAND-OFF WP-7: the page renders five <h2> and no <h1>. Its PageHeader is not used, so the " +
    "lap-comparison title needs promoting to <h1>. Delete this entry when it lands.",
};

const docs = new Map<string, Document>();
let up = false;

before(async () => {
  up = await serverUp();
  if (!up) return;
  for (const route of ROUTES) docs.set(route, parse(await fetchRoute(route)).window.document);
}, { timeout: 300_000 });

describe("landmarks, headings and focus order (UX_SPEC §4.2)", () => {
  for (const route of ROUTES) {
    test(`${route}`, (t) => {
      if (!up) return t.skip("dev server not reachable at A11Y_BASE_URL");
      const doc = docs.get(route)!;

      // §4.2 — the skip link is the FIRST focusable element, before the nav, and it lands on a
      // real element. A skip link pointing at nothing is worse than none: it moves focus nowhere
      // and the reader cannot tell.
      const first = doc.querySelector(FOCUSABLE);
      assert.equal(first?.getAttribute("class"), "skip-link", "first focusable is not the skip link");
      const href = first!.getAttribute("href") ?? "";
      assert.ok(href.startsWith("#"), "skip link must be a same-page fragment");
      const target = doc.getElementById(href.slice(1));
      assert.ok(target, `skip link points at ${href}, which is not in the document`);
      assert.equal(target!.tagName, "MAIN", "skip link should land on <main>");
      assert.equal(target!.getAttribute("tabindex"), "-1", "<main> needs tabindex=-1 to receive focus");

      // §4.2 — landmarks.
      assert.ok(doc.querySelector("nav"), "no <nav> landmark");
      assert.equal(doc.querySelectorAll("main").length, 1, "expected exactly one <main>");

      // §4.2 — one <h1>, and no skipped levels below it.
      const h1s = doc.querySelectorAll("h1");
      if (NO_H1[route]) {
        assert.equal(h1s.length, 0, `${route} now has an <h1>; remove its NO_H1 exception`);
        t.diagnostic(NO_H1[route]);
      } else {
        assert.equal(h1s.length, 1, `expected one <h1>, found ${h1s.length}`);
      }
      const levels = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) =>
        Number(h.tagName[1]),
      );
      for (let i = 1; i < levels.length; i++) {
        assert.ok(
          levels[i] <= levels[i - 1] + 1,
          `heading level jumps h${levels[i - 1]} -> h${levels[i]}`,
        );
      }

      // §2.1 — disclosure is native <details>/<summary>. A hand-rolled button + aria-expanded
      // div is not keyboard-equivalent and browser find-in-page cannot open it.
      assert.equal(
        doc.querySelectorAll("[aria-expanded]").length,
        0,
        "aria-expanded found: disclosure must be native <details>",
      );
    });
  }
});
