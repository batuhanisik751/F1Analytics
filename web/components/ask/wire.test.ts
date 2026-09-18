// MODE3_SPEC §8.2 — the UI's copy of the wire is pinned to the pipeline's, and the parser is
// exercised on the byte shapes the route actually emits.
//
// The two `Assert` lines below are COMPILE-TIME: `npm run typecheck` fails if `lib/ask/pipeline`'s
// AskEvent and this package's structural copy ever diverge in either direction. They are imported
// as types only, so no server module is pulled into a client bundle.
import test from "node:test";
import assert from "node:assert/strict";

import type { AskEvent as PipelineEvent, AskRenderDecision as PipelineRender } from "@/lib/ask/pipeline";
import type { AskEvent as UiEvent, AskRenderDecision as UiRender } from "@/components/ask/types";
import { newSseState, parseSseChunk } from "@/components/ask/askStream";
import { failureCopy, FAILURES } from "@/components/ask/AskFailure";
import { sqlSummary } from "@/components/ask/SqlPanel";

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _EventsMatch = Assert<Same<PipelineEvent, UiEvent>>;
export type _RenderMatches = Assert<Same<PipelineRender, UiRender>>;

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("events split on the blank line and survive being cut mid-frame", () => {
  const s = newSseState();
  const text = sse("state", { type: "state", state: "writing" }) + sse("state", { type: "state", state: "checking" });
  const a = parseSseChunk(s, text.slice(0, 30));
  const b = parseSseChunk(s, text.slice(30));
  const all = [...a, ...b];
  assert.deepEqual(all.map((e) => e.type), ["state", "state"]);
});

test("an unknown event type and malformed JSON are dropped, not thrown", () => {
  const s = newSseState();
  assert.deepEqual(parseSseChunk(s, "event: gossip\ndata: {\"type\":\"gossip\"}\n\n"), []);
  assert.deepEqual(parseSseChunk(s, "event: result\ndata: {not json}\n\n"), []);
});

test("every §3.7 error code has fan-facing copy and none of it echoes an upstream message", () => {
  const codes = [
    "no_key", "auth", "bad_request", "rate_limit", "upstream", "connection", "schema", "unknown",
    "rejected", "timeout", "plan:cost", "plan:rows", "plan:width", "plan:relation", "plan:shape",
    "denied", "sql", "busy", "exec", "limit_ip", "limit_session", "limit_budget", "offline",
  ];
  for (const c of codes) {
    const copy = failureCopy(c);
    assert.ok(FAILURES[c], `no copy row for ${c}`);
    assert.ok(copy.title.length > 0 && copy.body.length > 0, c);
  }
  // Only OUR OWN detail strings are ever displayed, and only for the gate families.
  assert.equal(failureCopy("connection").showDetail, undefined);
  assert.equal(failureCopy("rejected").showDetail, true);
});

test("the collapsed SQL line names the views, never model prose", () => {
  assert.equal(sqlSummary(["ask.laps"]), "SELECT … FROM ask.laps");
  assert.equal(sqlSummary(["ask.laps", "ask.sessions", "ask.drivers"]), "SELECT … FROM ask.laps, ask.sessions, +1");
  assert.equal(sqlSummary([]), "SELECT …");
});
