// MODE3_SPEC §8.2 — the SSE wire, restated structurally for the UI.
//
// These types mirror `AskEvent` in `lib/ask/pipeline.ts` deliberately rather than importing it:
// the pipeline module pulls in `execute.ts`/`askPool.ts` (the server-only, secret-holding side of
// §0.2's boundary), and the ask UI is a client bundle. A structural copy keeps the boundary a
// property of the import graph and lets every component be rendered from a fixture with no
// server, no key and no database (§9 WP-6). `components/ask/wire.test.ts` pins the two shapes
// together, so a drift in the pipeline is a failing test and not a silent runtime mismatch.

export type AskRenderKind = "table" | "bar" | "line" | "scatter" | "single";
export type AskUnit = "s" | "s_per_lap" | "pct" | "count" | "position" | "points" | "none";
export type AskSort = "as_written" | "value_desc" | "value_asc";

export type AskRenderDecision = {
  kind: AskRenderKind;
  labelCol: string | null;
  valueCols: string[];
  seriesCol: string | null;
  unit: AskUnit;
  sort: AskSort;
  downgradedFrom: AskRenderKind | null;
};

export type AskPlanEvent = {
  type: "plan";
  sql: string;
  headline: string;
  method: string;
  caveat: string | null;
  views: string[];
  flags: string[];
  methodLine: string;
  cached: boolean;
  retried: boolean;
  retryReason: string | null;
};

export type AskResultEvent = {
  type: "result";
  fields: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  render: AskRenderDecision;
  methodLine: string;
  durationMs: number;
};

export type AskErrorEvent = {
  type: "error";
  code: string;
  message: string;
  sql: string | null;
  gate: string | null;
};

export type AskEvent =
  | { type: "state"; state: "writing" | "checking" | "running" }
  | AskPlanEvent
  | { type: "clarify"; clarification: string; options: string[]; method: string }
  | { type: "out_of_scope"; reason: string }
  | AskResultEvent
  | AskErrorEvent;

/** The route's non-SSE rejections (§5.3): a JSON body at 400/403/413/415/429/503. */
export type AskRejection = {
  code: string;
  message?: string;
  retryAfterS?: number;
  asked?: number;
  limit?: number;
  spent?: number;
  budget?: number;
};
