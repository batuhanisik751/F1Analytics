// UX_SPEC §4.1, §4.2, §4.6, §4.7 — the rules that live in the stylesheet rather than the DOM.
// jsdom does not apply the dev server's stylesheet, so these assert the CSS source directly.
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(web, "app", "globals.css"), "utf8");
const layout = readFileSync(join(web, "app", "layout.tsx"), "utf8");

describe("stylesheet floor (UX_SPEC §4)", () => {
  // §4.1 — before v1.9 there was no focus style in the palette at all.
  test("a site-wide :focus-visible ring exists", () => {
    const block = css.match(/:focus-visible\s*\{([^}]*)\}/);
    assert.ok(block, "no :focus-visible rule in globals.css");
    assert.match(block![1], /outline:/, ":focus-visible sets no outline");
    assert.match(block![1], /outline-offset:/, "the ring sits on the control's own border");
    // The shadow is the belt to the outline's braces: Tailwind's `outline-none` beats a
    // single-selector :focus-visible on specificity, and at least one component still uses it.
    assert.match(block![1], /box-shadow:/, "no box-shadow ring to survive `outline-none`");
  });

  test("the ring is defined from a token, not a literal", () => {
    assert.match(css, /--color-focus:\s*#[0-9a-f]{6}/i, "no --color-focus token");
    const block = css.match(/:focus-visible\s*\{([^}]*)\}/)![1];
    assert.match(block, /var\(--color-focus\)/);
  });

  test("forced-colors mode hands the ring back to the system", () => {
    assert.match(css, /@media \(forced-colors: active\)/);
  });

  // §4.2 — the skip link. Off-screen by transform: `display:none` or `visibility:hidden` would
  // take it out of the tab order, which is the one thing it must not lose.
  test("the skip link is styled to stay focusable", () => {
    const block = css.match(/\.skip-link\s*\{([^}]*)\}/);
    assert.ok(block, "no .skip-link rule");
    assert.doesNotMatch(block![1], /display:\s*none/);
    assert.doesNotMatch(block![1], /visibility:\s*hidden/);
    assert.match(block![1], /min-height:\s*44px/, "§4.7 — 44 px minimum target");
    assert.match(css, /\.skip-link:focus/, "nothing brings the skip link on screen");
  });

  test("layout.tsx renders the skip link before the nav", () => {
    const link = layout.indexOf('className="skip-link"');
    const nav = layout.indexOf("<Nav />");
    assert.ok(link > -1, "no skip link in layout.tsx");
    assert.ok(link < nav, "the skip link must come before <Nav> in the document");
    assert.match(layout, /id="main-content"/);
    assert.match(layout, /tabIndex=\{-1\}/);
  });

  // §4.6 — motion.
  test("prefers-reduced-motion is honoured globally", () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, "no prefers-reduced-motion block");
    assert.match(m![1], /animation-duration/);
    assert.match(m![1], /transition-duration/);
    assert.match(m![1], /\*,/, "the block must cover every element, not one component");
  });

  // §4.1 again, from the other side: a component may restyle the ring, but not remove it.
  // This is a ratchet on the one file that still does.
  test("outline-none is not spreading", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
        else if (e.isFile() && /\.tsx?$/.test(e.name)) {
          for (const line of readFileSync(p, "utf8").split("\n")) {
            // Strip line comments first: three files DISCUSS `focus:outline-none` in a comment
            // explaining that they removed it, and a naive grep counts those as offenders.
            if (/focus:outline-none/.test(line.replace(/\/\/.*$/, ""))) offenders.push(p);
          }
        }
      }
    };
    walk(join(web, "components"));
    walk(join(web, "app"));
    const unique = [...new Set(offenders)].map((p) => p.slice(web.length + 1));
    assert.deepEqual(unique, [
      // Keeps its own focus-visible ring alongside it, so the control is still indicated.
      "components/race/SimSection.tsx",
      // HAND-OFF WP-3: no replacement ring. It relies on the global box-shadow alone.
      "components/sim/StintEditor.tsx",
    ]);
  });
});
