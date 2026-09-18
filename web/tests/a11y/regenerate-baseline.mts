// Rebuilds captions.baseline.json. NOT a test — run it by hand, and only when you can explain
// every line the diff adds or removes:
//
//   cd web && npx tsx tests/a11y/regenerate-baseline.mts
//
// The pre-release side comes from output/review/*.html, captured 2026-09-14 against the same
// pinned corpus, three days before v1.9 started. Those four files are the only genuine
// pre-release DOM on disk — the project is not a git repository — so they are the real baseline
// and they must not be deleted. The other six routes have no pre-release capture, so their copy
// is frozen as it shipped; §0 is enforced forwards there rather than retroactively.
//
// A string that stops being present must be added to changed.json with a spec clause, an owner
// and a reason, or this script refuses to write.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchRoute, normalise, parse, visibleText } from "./dom";
import { isPreserved } from "./preserved";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

const PRE: [string, string][] = [
  ["output/review/VER.html", "/driver/VER"],
  ["output/review/witc2026.html", "/season/2026/was-it-the-car"],
  ["output/review/con26.html", "/constructor"],
  ["output/review/mcl.html", "/constructor/mclaren"],
];
const POST = ["/", "/ask", "/glossary", "/season/2026", "/race/2026/13", "/race/2026/13/telemetry"];

type Changed = { startsWith: string; record: Record<string, string> };
const CHANGED = JSON.parse(readFileSync(join(here, "changed.json"), "utf8")) as Changed[];

/** One text node = one caption-sized string. 40 characters is the shortest thing on these pages
 *  that reads as a sentence rather than as a label or a number. */
function strings(html: string): string[] {
  const doc = parse(html).window.document;
  for (const el of Array.from(doc.querySelectorAll("script,style,noscript,svg"))) el.remove();
  const out = new Set<string>();
  const walk = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  let n: Node | null;
  while ((n = walk.nextNode())) {
    const t = normalise(n.nodeValue ?? "");
    if (t.length >= 40 && /\s/.test(t)) out.add(t);
  }
  return [...out];
}

const entries: unknown[] = [];
for (const [file, route] of PRE) {
  const live = visibleText(parse(await fetchRoute(route)).window.document);
  for (const text of strings(readFileSync(join(repo, file), "utf8"))) {
    if (isPreserved(text, live)) entries.push({ route, capturedAt: "2026-09-14", text });
    else {
      const c = CHANGED.find((x) => text.startsWith(x.startsWith));
      if (!c) throw new Error(`unadjudicated: ${route} ${JSON.stringify(text)}`);
      entries.push({ route, capturedAt: "2026-09-14", text, changed: c.record });
    }
  }
}

// Number-heavy fragments are excluded from the forward freeze: they are data, and pinning them
// would turn a re-ingest into a caption-preservation failure, which is the wrong alarm.
const wordy = (t: string): boolean =>
  t.split(/\s+/).length >= 12 && t.replace(/[^0-9]/g, "").length / t.length <= 0.3;

for (const route of POST) {
  for (const text of strings(await fetchRoute(route)).filter(wordy)) {
    entries.push({ route, capturedAt: "2026-09-17", text });
  }
}

const note =
  "UX_SPEC §0/§6. Every string here was on screen before this release (capturedAt 2026-09-14, " +
  "from output/review/*.html) or is frozen as shipped in v1.9. A string may move behind a " +
  "disclosure; it may not leave the DOM. Entries carrying `changed` were altered on the spec's " +
  "own orders and record why. Rebuild with tests/a11y/regenerate-baseline.mts.";
writeFileSync(join(here, "captions.baseline.json"), JSON.stringify({ note, entries }, null, 2) + "\n");
console.log(`${entries.length} entries written`);
