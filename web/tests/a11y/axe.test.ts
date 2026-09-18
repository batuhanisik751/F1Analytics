// UX_SPEC §6 — the automated accessibility pass. Zero serious or critical violations on every
// one of the nine routes §6 names (ten here: /constructor/[slug] is a separate render from
// /constructor, and the spec counts them as one line).
//
// axe runs INSIDE the jsdom window rather than against a document handed to a Node-side axe,
// because axe reads `window` at load time and caches it; one axe instance per page is the only
// way to check ten pages in one process without it looking at the wrong document.
//
// What this cannot see: anything that needs layout or paint. jsdom has no CSS cascade for the
// dev server's stylesheet and no box model, so axe reports `color-contrast` as INCOMPLETE, not
// as a pass. Contrast is therefore checked arithmetically instead — see contrast.test.ts, which
// measures the tokens themselves. Target size (§4.7) is likewise a layout property and is
// asserted from the classes that set it, in landmarks.test.ts.
import assert from "node:assert/strict";
import { test, describe, before } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { ROUTES, fetchRoute, parse, serverUp } from "./dom";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

type Violation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { html: string; failureSummary?: string }[];
};

async function runAxe(html: string): Promise<Violation[]> {
  const dom = parse(html);
  const win = dom.window as unknown as {
    eval(src: string): void;
    axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: Violation[] }> };
    document: Document;
    close(): void;
  };
  win.eval(axeSource);
  const res = await win.axe.run(win.document, {
    resultTypes: ["violations"],
    // The dev server's HTML is the server render; client-only affordances are not in it.
    rules: { "color-contrast": { enabled: false } },
  });
  // Copied out of the jsdom realm: an array created inside the window is not the same Array
  // as Node's, and assert.deepEqual refuses to compare across realms.
  const violations: Violation[] = Array.from(res.violations, (v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: Array.from(v.nodes, (n) => ({ html: n.html, failureSummary: n.failureSummary })),
  }));
  win.close();
  return violations;
}

const found = new Map<string, Violation[]>();
let up = false;

before(async () => {
  up = await serverUp();
  if (!up) return;
  for (const route of ROUTES) {
    found.set(route, await runAxe(await fetchRoute(route)));
  }
}, { timeout: 300_000 });

describe("axe-core (UX_SPEC §6)", () => {
  for (const route of ROUTES) {
    test(`${route} — no serious or critical violations`, (t) => {
      if (!up) return t.skip("dev server not reachable at A11Y_BASE_URL");
      const bad = (found.get(route) ?? []).filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      assert.deepEqual(
        bad.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 160)}`),
        [],
      );
    });
  }

  // A pass over ten pages that reports nothing is indistinguishable from a harness that never
  // ran. This canary fails if axe stops finding things it certainly should.
  test("the harness actually detects a violation", async () => {
    const broken = await runAxe(
      "<!doctype html><html lang=\"en\"><body><a href=\"#x\"></a>" +
        "<input type=\"text\"><img src=\"a.png\"></body></html>",
    );
    const ids = broken.map((v) => v.id);
    assert.ok(ids.includes("link-name"), `expected link-name, got ${ids.join(", ")}`);
    assert.ok(ids.includes("image-alt"), `expected image-alt, got ${ids.join(", ")}`);
  });

  test("moderate and minor findings are reported, not asserted", (t) => {
    if (!up) return t.skip("dev server not reachable at A11Y_BASE_URL");
    for (const [route, list] of found) {
      for (const v of list.filter((x) => x.impact !== "serious" && x.impact !== "critical")) {
        t.diagnostic(`${route}: ${v.impact} ${v.id} x${v.nodes.length} — ${v.help}`);
      }
    }
  });
});
