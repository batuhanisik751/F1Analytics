// UX_SPEC §4.4 — contrast, measured rather than eyeballed.
//
// axe cannot do this for us: jsdom has no cascade and no paint, so axe reports `color-contrast`
// as incomplete on every node. The tokens are the whole palette though, and they are literals in
// app/globals.css, so the ratios can be computed exactly. This test reads the file, so a future
// repalette is checked by the same arithmetic instead of by somebody's eye.
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "globals.css"),
  "utf8",
);

function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `--color-${name} is not a six-digit hex literal in globals.css`);
  return m![1].toLowerCase();
}

const channel = (v: number): number =>
  v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const BACKGROUNDS = ["bg", "surface", "raised"] as const;

describe("contrast (UX_SPEC §4.4)", () => {
  // Body text. --color-muted is the app's secondary copy and carries most of the small type on
  // every page, so it is held to the body floor, not the large-text one, on all three surfaces.
  for (const fg of ["fg", "muted", "accent"] as const) {
    for (const bg of BACKGROUNDS) {
      test(`--color-${fg} on --color-${bg} >= 4.5:1`, () => {
        const r = ratio(token(fg), token(bg));
        assert.ok(r >= 4.5, `measured ${r.toFixed(2)}:1 — body text needs 4.5:1`);
      });
    }
  }

  // The delta trio encodes meaning (fastest / personal best / slower) and is drawn as text and
  // as marks, so it is held to the large-text and non-text floor of 3:1.
  for (const fg of ["fastest", "personal", "slower"] as const) {
    for (const bg of BACKGROUNDS) {
      test(`--color-${fg} on --color-${bg} >= 3:1`, () => {
        const r = ratio(token(fg), token(bg));
        assert.ok(r >= 3, `measured ${r.toFixed(2)}:1 — large text and marks need 3:1`);
      });
    }
  }

  test("the focus ring clears 3:1 against every token background", () => {
    for (const bg of [...BACKGROUNDS, "grid", "accent"] as const) {
      const r = ratio(token("focus"), token(bg));
      assert.ok(r >= 3, `--color-focus on --color-${bg} measured ${r.toFixed(2)}:1`);
    }
  });

  test("the arithmetic itself is right", () => {
    assert.equal(ratio("#ffffff", "#000000").toFixed(0), "21");
    assert.equal(ratio("#8b8b97", "#121216").toFixed(2), "5.55");
  });
});
