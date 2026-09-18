// UX_SPEC §6 — shared plumbing for the accessibility and caption-preservation checks.
//
// These tests read the RENDERED page, not the source, because §0 is a statement about what a
// reader sees: a caption that still exists as a constant but is no longer composed into a page
// has been deleted as far as a reader is concerned. That means they need a running app. The
// dev server is the app; a route is fetched over HTTP and parsed with jsdom.
import { JSDOM } from "jsdom";

export const BASE = process.env.A11Y_BASE_URL ?? "http://localhost:3000";

/** The nine routes UX_SPEC §6 names. Keep this list and nothing else as the source of truth. */
export const ROUTES = [
  "/",
  "/ask",
  "/glossary",
  "/constructor",
  "/constructor/mclaren",
  "/driver/VER",
  "/season/2026",
  "/season/2026/was-it-the-car",
  "/race/2026/13",
  "/race/2026/13/telemetry",
] as const;

export type Route = (typeof ROUTES)[number];

/** True when the dev server is answering. Every suite here skips loudly rather than failing
 *  when it is not, so `npm run test` stays runnable on a machine with no database. */
export async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE + "/glossary", { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
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
  return new JSDOM(html, { url: BASE, pretendToBeVisual: true, runScripts: "outside-only" });
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
