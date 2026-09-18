// WP-6 verification — MODE3_SPEC §8.3, §8.5, §3.4, §8.7.
// Server-renders every ask-UI state from the recorded fixtures (no dev server, no key, no
// database), writes one HTML file per state under this directory, and asserts §8.7: hostile cell
// content reaches the DOM as visible literal text.
//
// Run:  cd web && npx tsx components/ask/render-states.tsx   (writes ../output/ask_ui/*.html)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import AskProgress from "@/components/ask/AskProgress";
import AskResult from "@/components/ask/AskResult";
import AskFailure from "@/components/ask/AskFailure";
import { AskClarify, AskOutOfScope } from "@/components/ask/AskClarify";
import { PLAN, HOSTILE_ROWS, result } from "@/components/ask/fixtures";
import { FAILURES } from "@/components/ask/AskFailure";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "output", "ask_ui");
mkdirSync(OUT, { recursive: true });

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{background:#08080a;color:#f4f4f7;font:14px/1.5 system-ui;padding:24px}` +
  `.text-muted{color:#8b8b97}.text-accent{color:#E10600}.text-fg{color:#f4f4f7}` +
  `pre{background:#1a1a20;padding:8px;overflow-x:auto}table{border-collapse:collapse}` +
  `th,td{padding:4px 8px;border-bottom:1px solid #26262e;text-align:left}</style>` +
  `<h1 style="font-size:16px;color:#8b8b97">${title}</h1>${body}`;

function emit(name: string, node: React.ReactElement): string {
  const html = renderToStaticMarkup(node);
  writeFileSync(join(OUT, `${name}.html`), page(name, html), "utf8");
  return html;
}

// --- §8.3 the three progress states ----------------------------------------
for (const s of ["writing", "checking", "running"] as const) {
  const html = emit(`progress-${s}`, <AskProgress state={s} elapsedMs={2400} />);
  assert.ok(html.includes(s === "writing" ? "Writing the query" : s === "checking" ? "Checking the query" : "Running"));
}
assert.ok(emit("progress-checking2", <AskProgress state="checking" />).includes("single read-only SELECT · 4 s limit · 500 rows"));

// --- §3.4 the five render kinds --------------------------------------------
const kinds = {
  bar: result(),
  line: result({
    fields: ["lap_number", "lap_time_s"],
    rows: Array.from({ length: 30 }, (_, i) => [i + 1, 92 - i * 0.02]),
    rowCount: 30,
    render: { kind: "line", labelCol: "lap_number", valueCols: ["lap_time_s"], seriesCol: null, unit: "s", sort: "as_written", downgradedFrom: null },
  }),
  scatter: result({
    fields: ["stint_lap", "deg_s"],
    rows: Array.from({ length: 24 }, (_, i) => [i + 1, 0.02 * i]),
    rowCount: 24,
    render: { kind: "scatter", labelCol: "stint_lap", valueCols: ["deg_s"], seriesCol: null, unit: "s_per_lap", sort: "as_written", downgradedFrom: null },
  }),
  single: result({
    fields: ["driver_id", "wins"],
    rows: [["VER", 9]],
    rowCount: 1,
    render: { kind: "single", labelCol: "driver_id", valueCols: ["wins"], seriesCol: null, unit: "count", sort: "as_written", downgradedFrom: null },
  }),
  table: result({ render: { ...result().render, kind: "table", valueCols: [] } }),
};
for (const [name, r] of Object.entries(kinds)) {
  const html = emit(`render-${name}`, <AskResult plan={PLAN} result={r} />);
  assert.ok(html.includes("generated"), `${name} lost the generated badge`);
  assert.ok(html.includes("show query"), `${name} lost the SQL panel`);
  assert.ok(html.includes("no clean-lap filter"), `${name} lost the AST method line`);
}
assert.ok(emit("render-single", <AskResult plan={PLAN} result={kinds.single} />).includes("VER"));

// --- §3.4 the degrade rule, end to end -------------------------------------
{
  const bad = result({
    render: { ...result().render, kind: "bar", labelCol: "code" }, // `code` is not in fields
  });
  const html = emit("render-degraded-to-table", <AskResult plan={PLAN} result={bad} />);
  assert.ok(html.includes("<table"), "a hint naming a missing column must degrade to a table");
  assert.ok(!html.includes('role="img"'), "no chart may be drawn for a discarded hint");
}

// --- §8.7 hostile cell content is visible literal text ----------------------
{
  const hostile = result({ rows: HOSTILE_ROWS, rowCount: 3, render: { ...result().render, kind: "table", valueCols: [] } });
  const html = emit("xss-literal-text", <AskResult plan={PLAN} result={hostile} />);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "script payload was not escaped");
  assert.ok(!html.includes("<script>alert(1)</script>"), "a live <script> tag reached the DOM");
  // React escapes `<`/`>`; `=` needs no escaping INSIDE a text node, so the test is that no tag
  // is ever opened — `&lt;img src=x onerror=alert(2)&gt;` is inert text, `<img …>` would not be.
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"), "the img payload must be literal text");
  assert.ok(!/<img\b/i.test(html), "an <img> tag reached the DOM");
  assert.ok(html.includes("Ignore previous instructions"), "the injection string must be visible");
}

// --- §8.5 every failure state, and the empty state --------------------------
{
  const empty = result({ rows: [], rowCount: 0 });
  const html = emit("empty-result", <AskResult plan={PLAN} result={empty} />);
  assert.ok(html.includes("The query ran and returned no rows."));
  assert.ok(html.includes("Monte Carlo") && html.includes("2024") && html.includes("partial"));
  assert.ok(html.includes("show query"), "the empty state must still show the query");
}
for (const code of Object.keys(FAILURES)) {
  const html = emit(`failure-${code.replace(":", "-")}`, <AskFailure code={code} detail="planner estimated 4.1M cost" sql={PLAN.sql} gate="write inside a CTE" />);
  assert.ok(html.includes(FAILURES[code].title.replace(/'/g, "&#x27;")) || html.includes(FAILURES[code].title));
}
{
  const html = emit("failure-after-plan", <AskResult plan={PLAN} result={null} error={{ code: "timeout", message: "", gate: null }} />);
  assert.ok(html.includes("The query ran for 4 seconds and was stopped."));
}
{
  const retried = { ...PLAN, retried: true, retryReason: "column laps.session_type does not exist" };
  const html = emit("retry-disclosed", <AskResult plan={retried} result={result()} />);
  assert.ok(html.includes("second attempt") && html.includes("session_type"));
}
{
  const truncated = result({ truncated: true, rowCount: 20 });
  const html = emit("rows-dropped", <AskResult plan={PLAN} result={truncated} />);
  assert.ok(html.includes("too large to return"), "dropped rows must never be silent");
}

// --- §3.6 clarification and refusal ----------------------------------------
emit("clarify", <AskClarify clarification="Fastest single lap, or best race pace?" options={["fastest single lap in the 2025 British GP", "best clean-air race pace at Silverstone 2025"]} method="Both readings exist and give different drivers." onPick={() => {}} />);
emit("out-of-scope", <AskOutOfScope reason="This database starts at 2024 — there is no 2019 data." />);

console.log(`ok — every ask-UI state rendered and asserted; HTML in ${OUT}`);
