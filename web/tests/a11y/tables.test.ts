// UX_SPEC §4.5 and §6 — tables, their scroll containers, and 400 px.
import assert from "node:assert/strict";
import { test, describe, before } from "node:test";

import { ROUTES, fetchRoute, parse, serverUp } from "./dom";

const SCROLLER = "[class*='overflow-x-auto'],[class*='overflow-x-scroll']";

// §4.5: "horizontal scroll containers that are themselves keyboard-scrollable and labelled".
// Every one of these is the same div in components/ui/DataTable.tsx, which is WP-1's file:
// `tabIndex={0}` + `role="region"` + an aria-label from the existing `caption` prop fixes all
// of them at once. WP-2, WP-3, WP-5 and WP-6 have each filed it; this is the mechanical version.
//
// A RATCHET, not a snooze: the count may fall, never rise. When DataTable is fixed these all go
// to 0 and the test asks you to update the numbers.
const UNLABELLED_SCROLLERS: Record<string, number> = {
  "/": 3,
  "/ask": 0,
  "/glossary": 0,
  "/constructor": 0,
  "/constructor/mclaren": 1,
  "/driver/VER": 3,
  "/season/2026": 5,
  "/season/2026/was-it-the-car": 0,
  "/race/2026/13": 10,
  "/race/2026/13/telemetry": 0,
};

// §4.5 also wants every table named. Four are not: WP-1 (home), WP-5 (season) and WP-3 (race).
const TABLES_WITHOUT_A_NAME: Record<string, number> = {
  "/": 1,
  "/season/2026": 1,
  "/race/2026/13": 2,
};

const docs = new Map<string, Document>();
let up = false;

before(async () => {
  up = await serverUp();
  if (!up) return;
  for (const route of ROUTES) docs.set(route, parse(await fetchRoute(route)).window.document);
}, { timeout: 300_000 });

describe("tables and narrow viewports (UX_SPEC §4.5, §6)", () => {
  for (const route of ROUTES) {
    test(`${route} — every <th> declares a scope`, (t) => {
      if (!up) return t.skip("dev server not reachable");
      const loose = Array.from(docs.get(route)!.querySelectorAll("th")).filter(
        (th) => !th.getAttribute("scope"),
      );
      assert.deepEqual(loose.map((th) => th.textContent?.slice(0, 40)), []);
    });

    test(`${route} — unlabelled scroll containers do not increase`, (t) => {
      if (!up) return t.skip("dev server not reachable");
      const doc = docs.get(route)!;
      const bad = Array.from(doc.querySelectorAll(SCROLLER)).filter(
        (el) =>
          el.getAttribute("tabindex") === null ||
          !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")),
      ).length;
      const allowed = UNLABELLED_SCROLLERS[route] ?? 0;
      assert.ok(bad <= allowed, `${bad} unlabelled scroll containers, budget is ${allowed}`);
      if (bad < allowed) t.diagnostic(`${route}: now ${bad}, lower the budget from ${allowed}`);
    });

    test(`${route} — tables without a caption or label do not increase`, (t) => {
      if (!up) return t.skip("dev server not reachable");
      const doc = docs.get(route)!;
      const bad = Array.from(doc.querySelectorAll("table")).filter(
        (tbl) =>
          !tbl.querySelector("caption") &&
          !tbl.getAttribute("aria-label") &&
          !tbl.getAttribute("aria-labelledby"),
      ).length;
      const allowed = TABLES_WITHOUT_A_NAME[route] ?? 0;
      assert.ok(bad <= allowed, `${bad} unnamed tables, budget is ${allowed}`);
      if (bad < allowed) t.diagnostic(`${route}: now ${bad}, lower the budget from ${allowed}`);
    });

    // §6 — no horizontal BODY scroll at 400 px. jsdom has no layout, so the assertion is on the
    // cause rather than the symptom: anything declaring a width wider than the viewport has to
    // sit inside a scroll container, which keeps the overflow local to that element.
    test(`${route} — nothing wider than 400 px escapes a scroll container`, (t) => {
      if (!up) return t.skip("dev server not reachable");
      const doc = docs.get(route)!;
      const wide = Array.from(doc.querySelectorAll("[class*='w-[']")).filter((el) => {
        const m = (el.getAttribute("class") ?? "").match(/(?:^|\s)(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem)\]/);
        if (!m) return false;
        const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
        return px > 400 && !el.closest(SCROLLER);
      });
      assert.deepEqual(
        wide.map((el) => `${el.tagName} ${el.getAttribute("class")?.slice(0, 80)}`),
        [],
      );
    });
  }
});
