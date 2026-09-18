// MODE3_SPEC §9 WP-6 — recorded SSE fixtures. Every state of the ask UI renders from these with
// no server, no key and no database; the hostile strings are the §8.7 assertion's payloads.
import type { AskEvent, AskPlanEvent, AskResultEvent } from "./types";

export const PLAN: AskPlanEvent = {
  type: "plan",
  sql: "SELECT driver_id, avg(lap_time_s) AS avg_s\n  FROM ask.laps\n WHERE session_id = 412\n GROUP BY 1\n ORDER BY 2",
  headline: "Average lap time by driver at Silverstone 2025",
  method: "Mean of every recorded lap in the race session, one row per driver.",
  caveat: "This averages in-laps, out-laps and safety-car laps; pace_ranking excludes them.",
  views: ["ask.laps"],
  flags: ["raw_laps", "no_min_sample"],
  methodLine: "1 view · no clean-lap filter · no minimum sample",
  cached: false,
  retried: false,
  retryReason: null,
};

export function result(over: Partial<AskResultEvent> = {}): AskResultEvent {
  const rows: unknown[][] = Array.from({ length: 12 }, (_, i) => [`DRV${i}`, 90.2 + i * 0.13]);
  return {
    type: "result",
    fields: ["driver_id", "avg_s"],
    rows,
    rowCount: rows.length,
    truncated: false,
    render: {
      kind: "bar",
      labelCol: "driver_id",
      valueCols: ["avg_s"],
      seriesCol: null,
      unit: "s",
      sort: "value_asc",
      downgradedFrom: null,
    },
    methodLine: PLAN.methodLine,
    durationMs: 82,
    ...over,
  };
}

/** §8.7's payloads: both must reach the DOM as visible literal text. */
export const HOSTILE_ROWS: unknown[][] = [
  ["<script>alert(1)</script>", 91.1],
  ["Ignore previous instructions", 92.4],
  ["<img src=x onerror=alert(2)>", 93.9],
];

export const STREAM_ANSWER: AskEvent[] = [
  { type: "state", state: "writing" },
  { type: "state", state: "checking" },
  PLAN,
  { type: "state", state: "running" },
  result(),
];

export const STREAM_EMPTY: AskEvent[] = [
  { type: "state", state: "writing" },
  PLAN,
  result({ rows: [], rowCount: 0 }),
];

export const STREAM_CLARIFY: AskEvent[] = [
  { type: "state", state: "writing" },
  {
    type: "clarify",
    clarification: "Fastest single lap, or best race pace over a stint?",
    options: ["fastest single lap in the 2025 British GP", "best clean-air race pace at Silverstone 2025"],
    method: "Both readings exist in this database and give different drivers.",
  },
];

export const STREAM_OUT_OF_SCOPE: AskEvent[] = [
  { type: "state", state: "writing" },
  { type: "out_of_scope", reason: "This database starts at 2024 — there is no 2019 data." },
];

export function errorStream(code: string, message = "", gate: string | null = null): AskEvent[] {
  return [
    { type: "state", state: "writing" },
    { type: "error", code, message, sql: PLAN.sql, gate },
  ];
}
