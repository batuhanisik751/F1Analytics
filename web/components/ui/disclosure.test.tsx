// UX_SPEC §0 / §2.1 — the disclosure primitives. The load-bearing assertion in this file is the
// one at the bottom of each "closed" case: a closed section's content is still in the DOM.
// COLLAPSE, NEVER DELETE is a property of the markup, not a promise in a comment.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import Section from "@/components/ui/Section";
import Disclosure from "@/components/ui/Disclosure";

const CAPTION =
  "Fuel-corrected pace over green-flag laps only; safety-car and pit laps are excluded.";
const BODY = "The chart a reader came for.";

test("an existing call site is untouched: no <details>, original header markup", () => {
  const html = renderToStaticMarkup(
    <Section title="Race pace" caption={CAPTION}>
      <p>{BODY}</p>
    </Section>,
  );
  assert.ok(!html.includes("<details"), "default Section must not become collapsible");
  assert.ok(html.includes("<header"), "the original header element is gone");
  assert.ok(html.includes("<h2"), "the section heading is gone");
  assert.ok(html.includes(CAPTION));
  assert.ok(html.includes(BODY));
});

test("collapsible Section is native <details>/<summary>, open by default", () => {
  const html = renderToStaticMarkup(
    <Section title="Race pace" caption={CAPTION} collapsible>
      <p>{BODY}</p>
    </Section>,
  );
  assert.match(html, /<details[^>]*open/, "defaultOpen is true, so the details must be open");
  assert.match(html, /<summary/);
  // Native semantics, not a hand-rolled button+aria-expanded div (§2.1).
  assert.ok(!html.includes("aria-expanded"), "do not hand-roll the disclosure");
  assert.ok(html.includes("min-h-[44px]"), "the summary row must be a 44px touch target (§4.7)");
  assert.ok(html.includes(BODY));
});

test("§0 — a CLOSED section still has its content and its caption in the DOM", () => {
  const html = renderToStaticMarkup(
    <Section
      title="Modelling assumptions"
      caption={CAPTION}
      summary="9 constants, last changed 14 Sept"
      collapsible
      defaultOpen={false}
    >
      <p>{BODY}</p>
      <p>1,054 laps considered.</p>
    </Section>,
  );
  assert.ok(!/<details[^>]*\sopen/.test(html), "defaultOpen={false} must render closed");
  assert.ok(html.includes(BODY), "closed section dropped its content");
  assert.ok(html.includes("1,054 laps considered."), "closed section dropped a count");
  assert.ok(html.includes(CAPTION), "closed section dropped its caption — this is the §0 failure");
  assert.ok(html.includes("9 constants, last changed 14 Sept"), "summary line missing");
});

test("a summary hides the long caption visually but never removes it", () => {
  const html = renderToStaticMarkup(
    <Section title="Assumptions" caption={CAPTION} summary="9 constants" collapsible>
      <p>{BODY}</p>
    </Section>,
  );
  const captionAt = html.indexOf(CAPTION);
  assert.ok(captionAt > -1);
  // The caption's own <p> carries the CSS that reveals it on open; the text ships either way.
  assert.match(html.slice(0, captionAt), /hidden group-open:block[^<]*">$/);
});

test("Disclosure defaults closed, keeps its body in the DOM, and opens for a refusal", () => {
  const note = "Ratings were fitted by chaining team-mate comparisons across 9 seasons.";
  const closed = renderToStaticMarkup(
    <Disclosure summary="How this was fitted" hint="method note">
      <p>{note}</p>
    </Disclosure>,
  );
  assert.ok(!/<details[^>]*\sopen/.test(closed), "a method note starts closed (§2.2)");
  assert.ok(closed.includes(note), "§0 — the note must still be in the DOM when closed");
  assert.ok(closed.includes("How this was fitted"));
  assert.ok(closed.includes("min-h-[44px]"));

  const refusal = renderToStaticMarkup(
    <Disclosure summary="Not measurable here" defaultOpen>
      <p>No DRS signal was logged on these laps.</p>
    </Disclosure>,
  );
  assert.match(refusal, /<details[^>]*open/, "a refusal must be able to render open (§0)");
});

test("storageKey adds the memory hook; omitting it renders no client marker", () => {
  const withKey = renderToStaticMarkup(
    <Section title="Per-segment scatter" collapsible defaultOpen={false} storageKey="quali-segments">
      <p>{BODY}</p>
    </Section>,
  );
  assert.ok(withKey.includes('data-disclosure-memory="quali-segments"'));

  const without = renderToStaticMarkup(
    <Section title="Per-segment scatter" collapsible>
      <p>{BODY}</p>
    </Section>,
  );
  assert.ok(!without.includes("data-disclosure-memory"));
});

test("actions leave the summary row when collapsible — a <summary> may not eat their clicks", () => {
  const html = renderToStaticMarkup(
    <Section title="Report" collapsible actions={<span>badge</span>}>
      <p>{BODY}</p>
    </Section>,
  );
  const summaryEnd = html.indexOf("</summary>");
  assert.ok(summaryEnd > -1);
  assert.ok(html.indexOf("badge") > summaryEnd, "actions must render after the summary element");
});

test("a summary on a NON-collapsible section stays visible — no orphan group-open: class", () => {
  const html = renderToStaticMarkup(
    <Section title="Assumptions" caption={CAPTION} summary="9 constants">
      <p>{BODY}</p>
    </Section>,
  );
  assert.ok(html.includes(CAPTION));
  assert.ok(html.includes("9 constants"));
  // There is no <details> ancestor here, so `group-open:` would never resolve and `hidden`
  // would stick: the caption would vanish for good.
  assert.ok(!html.includes("group-open:"), "group-open: requires a <details> group ancestor");
});
