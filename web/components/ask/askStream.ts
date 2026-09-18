// MODE3_SPEC §8.2 — the SSE wire, parsed. `event: <type>` + `data: <json>`, blank-line separated.
//
// Kept as a pure function over text chunks so it is testable with no browser and no server: the
// UI's whole transport surface is `parseSseChunk`, and every component above it is driven by the
// AskEvent array it produces (that is what makes the fixture-driven render checks of §9 WP-6 real
// rather than mock-shaped).
import type { AskEvent } from "./types";

export type SseParseState = { buffer: string };

export function newSseState(): SseParseState {
  return { buffer: "" };
}

/**
 * Feeds one decoded chunk in and returns the events that completed. Unknown event types and
 * malformed JSON are DROPPED, never thrown: a stream is a rendering input, and a parse failure
 * must not take the page down mid-answer.
 */
export function parseSseChunk(state: SseParseState, chunk: string): AskEvent[] {
  state.buffer += chunk.replace(/\r\n/g, "\n");
  const out: AskEvent[] = [];
  let idx = state.buffer.indexOf("\n\n");
  while (idx !== -1) {
    const block = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);
    const event = parseBlock(block);
    if (event) out.push(event);
    idx = state.buffer.indexOf("\n\n");
  }
  return out;
}

function parseBlock(block: string): AskEvent | null {
  let name: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : name;
  if (typeof type !== "string") return null;
  const known = ["state", "plan", "clarify", "out_of_scope", "result", "error"];
  if (!known.includes(type)) return null;
  return { ...obj, type } as AskEvent;
}
