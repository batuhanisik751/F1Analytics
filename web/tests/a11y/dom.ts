// UX_SPEC §6 — shared plumbing for the accessibility and caption-preservation checks.
//
// These tests read the RENDERED page, not the source, because §0 is a statement about what a
// reader sees: a caption that still exists as a constant but is no longer composed into a page
// has been deleted as far as a reader is concerned. That means they need a running app. The
// dev server is the app; a route is fetched over HTTP and parsed with jsdom.
import { JSDOM } from "jsdom";

export const BASE = process.env.A11Y_BASE_URL ?? "http://localhost:3000";

/** Every route, and the only source of truth for what the a11y suite covers. A page added
    without a line here ships unchecked, which is how /accuracy nearly shipped unchecked. */
export const ROUTES = [
  "/",
  "/accuracy",
  "/ask",
  "/glossary",
  "/constructor",
  "/constructor/mclaren",
  "/driver/VER",
  "/driver/VER?season=2026&vs=NOR",
  "/season/2026",
  "/season/2026/was-it-the-car",
  "/race/2026/13",
  "/race/2026/13/telemetry",
] as const;

export type Route = (typeof ROUTES)[number];

/** OPS_SPEC §1.3 rule 3 — set to 1 in CI. A missing server is then a FAILURE, never a skip:
 *  107 skipped tests print green, and green is exactly what a lost server must not be. */
export const REQUIRE = process.env.A11Y_REQUIRE === "1";

/** True when the dev server is answering. Locally every suite here skips loudly rather than
 *  failing when it is not, so `npm run test` stays runnable on a machine with no database.
 *  Under A11Y_REQUIRE=1 it throws instead, which fails every suite's `before()` hook. */
export async function serverUp(): Promise<boolean> {
  let up = false;
  let why = "";
  try {
    const r = await fetch(BASE + "/glossary", { signal: AbortSignal.timeout(8000) });
    up = r.ok;
    if (!up) why = `${BASE}/glossary returned ${r.status}`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (!up && REQUIRE) {
    throw new Error(
      `A11Y_REQUIRE=1 and no server is answering at ${BASE} (${why}). ` +
        "Refusing to skip: a suite that cannot reach the app has not tested it.",
    );
  }
  return up;
}

export async function fetchRoute(route: string): Promise<string> {
  const r = await fetch(BASE + route, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`${route} returned ${r.status}`);
  return await r.text();
}

export function parse(html: string): JSDOM {
  // runScripts "outside-only" does NOT run the page's own scripts — it only gives us a window
  // we can eval axe-core into. The dev server's HTML is the server render, which is what we
  // want to audit: everything here must work before any client JavaScript arrives.
  const dom = new JSDOM(html, { url: BASE, pretendToBeVisual: true, runScripts: "outside-only" });
  settleStreamedBoundaries(dom.window.document);
  return dom;
}

/** OPS_SPEC §5.1 — `app/loading.tsx` is a Suspense boundary, so the server now STREAMS: the
 *  response carries the loading fallback in place and the real page later, as
 *  `<div hidden id="S:n">` plus the inline swap that React's own runtime performs before any
 *  application script runs. Nothing here runs scripts, so the swap is replayed by hand:
 *  otherwise every heading, table and caption would sit in a hidden div and the audit would
 *  be of the spinner. The result is the server render as a reader sees it once it has arrived. */
export function settleStreamedBoundaries(doc: Document): void {
  // Segments first (`$RS`): a boundary's content may arrive as `<template id="P:n">` inside
  // one hidden div with the real nodes in another, and the placeholder must be filled before
  // the boundary that contains it is swapped in. Repeated because segments nest.
  for (let pass = 0; pass < 8; pass++) {
    const segs = Array.from(doc.querySelectorAll<HTMLTemplateElement>("template[id^='P:']"));
    let moved = 0;
    for (const tpl of segs) {
      const content = doc.getElementById("S:" + tpl.id.slice(2));
      const parent = tpl.parentNode;
      if (!content || !parent) continue;
      while (content.firstChild) parent.insertBefore(content.firstChild, tpl);
      parent.removeChild(tpl);
      // A segment that must parse inside a table arrives as `<table hidden><tr id="S:n">`;
      // React's own swap leaves that empty wrapper behind, where it would be counted as one
      // more unnamed table. Take the wrapper out with the segment.
      let wrapper: Node | null = content.parentNode;
      content.remove();
      while (wrapper && wrapper !== doc.body && wrapper.childNodes.length === 0) {
        const up: Node | null = wrapper.parentNode;
        (wrapper as ChildNode).remove();
        wrapper = up;
      }
      moved++;
    }
    if (moved === 0) break;
  }
  // Boundaries (`$RC`): drop the fallback, put the content in its place.
  for (const tpl of Array.from(doc.querySelectorAll<HTMLTemplateElement>("template[id^='B:']"))) {
    const content = doc.getElementById("S:" + tpl.id.slice(2));
    const parent = tpl.parentNode;
    if (!content || !parent) continue;
    // Remove the fallback: everything after the template up to the boundary's own closing
    // comment, counting nested boundaries so an inner `<!--/$-->` does not end the outer one.
    let depth = 0;
    let node: Node | null = tpl.nextSibling;
    while (node) {
      const next: Node | null = node.nextSibling;
      if (node.nodeType === 8 /* COMMENT */) {
        const v = node.nodeValue ?? "";
        if (v === "/$") {
          if (depth === 0) break;
          depth--;
        } else if (v === "$" || v === "$?" || v === "$!") depth++;
      }
      parent.removeChild(node);
      node = next;
    }
    while (content.firstChild) parent.insertBefore(content.firstChild, node);
    parent.removeChild(tpl);
    content.remove();
  }
}

export const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every word the page renders, in order, with element boundaries dissolved. `<details>` bodies
 *  are included on purpose: §0 says a collapsed caveat is still present, so the assertion is
 *  presence in the DOM, never visibility. */
export function visibleText(doc: Document): string {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll("script,style,noscript,template"))) {
    el.remove();
  }
  // Text nodes joined with a SPACE, not concatenated. `textContent` glues the last word of one
  // element to the first word of the next ("McLaren" + "Car pace…" -> "mclarencar pace"), which
  // reads as two missing words on every element boundary in the document.
  const parts: string[] = [];
  const walk = clone.ownerDocument.createTreeWalker(clone, 4 /* SHOW_TEXT */);
  let node: Node | null;
  while ((node = walk.nextNode())) parts.push(node.nodeValue ?? "");
  return normalise(parts.join(" "));
}
