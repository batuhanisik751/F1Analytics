// MODE3_SPEC §2.4 / §3 — the pipeline and the cached prefix, asserted with NO key and NO
// database. The model call and the executor arrive through `AskDeps`' test seams, so every
// ending of §3.7 is a test rather than something only production ever runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_INSTRUCTIONS,
  PROMPT_PREFIX_SHA256,
  SCHEMA_DOC,
  answerCacheKey,
  normaliseQuestion,
  promptPrefixSha256,
  systemBlocks,
} from "@/lib/ask/prompt";
import { ASK_RESULT_SCHEMA, askResultSchema, estimateCostUsd, type AskResult } from "@/lib/ask/anthropic";
import { AskExecutionError, type AskExecution } from "@/lib/ask/execute";
import {
  alwaysTable,
  askFlags,
  memoryAskStore,
  methodLine,
  runAsk,
  type AskDeps,
  type AskEvent,
} from "@/lib/ask/pipeline";

// --- §2.4 the cached prefix -------------------------------------------------

test("the system array is two blocks with ONE breakpoint, on the last one, ttl 1h", () => {
  const blocks = systemBlocks();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].cache_control, undefined);
  assert.deepEqual(blocks[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(blocks[0].text, ASK_INSTRUCTIONS);
  assert.equal(blocks[1].text, SCHEMA_DOC);
});

test("nothing volatile is in the prefix: no date, no clock, no request id", () => {
  const prefix = systemBlocks().map((b) => b.text).join("\n");
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(prefix), false, "an ISO date would break the cache daily");
  assert.equal(/\d{2}:\d{2}:\d{2}/.test(prefix), false);
  assert.equal(/today is|current date|session id|request id/i.test(prefix), false);
});

test("the assembled prefix hashes to the committed PROMPT_PREFIX_SHA256", () => {
  assert.equal(
    promptPrefixSha256(),
    PROMPT_PREFIX_SHA256,
    "the prefix changed: re-run `make ask-eval`, then update PROMPT_PREFIX_SHA256 in prompt.ts",
  );
});

test("normalise collapses the differences that are not different questions", () => {
  assert.equal(normaliseQuestion("  Who won at   Spa? "), "who won at spa");
  assert.equal(normaliseQuestion("who won at spa"), "who won at spa");
  assert.equal(normaliseQuestion("WHO WON AT SPA!!!"), "who won at spa");
  assert.notEqual(normaliseQuestion("who won at spa"), normaliseQuestion("who won at monza"));
});

test("the cache key is deterministic and carries the prefix hash", () => {
  const a = answerCacheKey("who won at spa");
  assert.equal(a, answerCacheKey("who won at spa"));
  assert.notEqual(a, answerCacheKey("who won at monza"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

// --- §3.3 the output contract ----------------------------------------------

test("ASK_RESULT_SCHEMA and the zod schema agree on the required fields", () => {
  const required = [...ASK_RESULT_SCHEMA.required];
  const zodKeys = Object.keys(askResultSchema.shape).sort();
  assert.deepEqual([...required].sort(), zodKeys);
});

test("a headline longer than 90 chars is not a usable result", () => {
  const bad = { ...queryResult(), headline: "x".repeat(91) };
  assert.equal(askResultSchema.safeParse(bad).success, false);
});

test("cost: a cache hit is ~8x cheaper than a cache write at sonnet-5 prices", () => {
  const miss = estimateCostUsd({
    model: "claude-sonnet-5",
    inputTokens: 60,
    outputTokens: 300,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 9600,
  });
  const hit = estimateCostUsd({
    model: "claude-sonnet-5",
    inputTokens: 60,
    outputTokens: 300,
    cacheReadInputTokens: 9600,
    cacheCreationInputTokens: 0,
  });
  assert.ok(miss > hit * 5, `${miss} vs ${hit}`);
});

// --- fixtures ---------------------------------------------------------------

const GOOD_SQL = "SELECT driver_id, median_pace_s FROM ask.pace_ranking WHERE session_id = 412 LIMIT 20";
const BAD_SQL = "SELECT hostname FROM ingest_runs LIMIT 1";

function queryResult(sql: string = GOOD_SQL): AskResult {
  return {
    intent: "query",
    sql,
    headline: "Median clean-air pace, Silverstone 2025",
    method: "Median clean racing lap per driver for one race session.",
    caveat: "Rank gaps inside the uncertainty band are not real gaps.",
    render: {
      kind: "bar",
      label_col: "driver_id",
      value_cols: ["median_pace_s"],
      series_col: null,
      unit: "s_per_lap",
      sort: "value_asc",
    },
    clarification: null,
    options: [],
    reason: null,
  };
}

function usage() {
  return {
    model: "claude-sonnet-5",
    inputTokens: 60,
    outputTokens: 300,
    cacheReadInputTokens: 9600,
    cacheCreationInputTokens: 0,
    estimatedCostUsd: 0.0049,
  };
}

function execution(rows: unknown[][] = [["VER", 92.1]]): AskExecution {
  return {
    fields: ["driver_id", "median_pace_s"],
    rows,
    truncated: false,
    plan: { maxPlanCost: 120.68, topPlanRows: 20, topPlanWidth: 40, relations: ["pace_ranking"] },
    durationMs: 12,
  };
}

/** Runs the pipeline with scripted model answers, collecting events and counting model calls. */
async function run(opts: {
  answers?: AskResult[];
  execute?: AskDeps["execute"];
  seedCache?: AskResult;
}) {
  const events: AskEvent[] = [];
  const store = memoryAskStore();
  const answers = [...(opts.answers ?? [])];
  let modelCalls = 0;
  if (opts.seedCache) {
    await store.putCachedAnswer(answerCacheKey("q"), "q", "sha", opts.seedCache);
  }
  const outcome = await runAsk(
    { question: "who had the best race pace?", questionNorm: "q", sessionCookie: "s1", ipHash: "h1" },
    {
      store,
      emit: (e) => events.push(e),
      callModel: async () => {
        modelCalls += 1;
        const next = answers.shift();
        if (!next) throw new Error("the pipeline asked for more model calls than the test scripted");
        return { result: next, usage: usage(), stopReason: "end_turn" };
      },
      execute: opts.execute ?? (async () => execution()),
    },
  );
  return { ...outcome, events, modelCalls, store };
}

// --- §3 the pipeline --------------------------------------------------------

test("the happy path: one model call, plan before result, SQL only after the gates", async () => {
  const r = await run({ answers: [queryResult()] });
  assert.equal(r.outcome, "answered");
  assert.equal(r.modelCalls, 1);
  const kinds = r.events.map((e) => e.type);
  assert.deepEqual(kinds, ["state", "state", "plan", "state", "result"]);
  const plan = r.events.find((e) => e.type === "plan");
  assert.equal(plan?.sql, GOOD_SQL);
  assert.equal(r.log.validatorVerdict, "ok");
  assert.equal(r.log.retryCount, 0);
  assert.deepEqual(r.log.touchedViews, ["ask.pace_ranking"]);
});

test("§3.5 the retry fires EXACTLY once, is disclosed, and costs a second call at most", async () => {
  const r = await run({ answers: [queryResult(BAD_SQL), queryResult()] });
  assert.equal(r.outcome, "answered");
  assert.equal(r.modelCalls, 2);
  assert.equal(r.log.retryCount, 1);
  const plan = r.events.find((e) => e.type === "plan");
  assert.equal(plan?.retried, true);
  assert.match(String(plan?.retryReason), /relation/);
});

test("§5.2 two rejected queries end the request — there is no third model call", async () => {
  const r = await run({ answers: [queryResult(BAD_SQL), queryResult(BAD_SQL)] });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.modelCalls, 2);
  const err = r.events.find((e) => e.type === "error");
  assert.equal(err?.code, "rejected");
  assert.match(String(err?.gate), /^relation:/);
  assert.equal(r.log.validatorVerdict, "rejected:relation:ingest_runs");
  assert.equal(r.events.some((e) => e.type === "result"), false);
});

test("§3.6 clarify returns chips, runs no query and calls the model once", async () => {
  const r = await run({
    answers: [
      {
        ...queryResult(),
        intent: "clarify",
        sql: null,
        render: null,
        clarification: "Fastest lap, or race pace?",
        options: ["fastest lap at Spa 2025", "best race pace at Spa 2025"],
      },
    ],
  });
  assert.equal(r.outcome, "clarify");
  assert.equal(r.modelCalls, 1);
  assert.equal(r.events.filter((e) => e.type === "plan").length, 0);
  const c = r.events.find((e) => e.type === "clarify");
  assert.equal(c?.options.length, 2);
});

test("§3.6 out_of_scope ends the request instead of returning an empty table", async () => {
  const r = await run({
    answers: [{ ...queryResult(), intent: "out_of_scope", sql: null, render: null, reason: "This database starts at 2024." }],
  });
  assert.equal(r.outcome, "out_of_scope");
  assert.equal(r.events.some((e) => e.type === "result"), false);
  assert.match(String(r.events.find((e) => e.type === "out_of_scope")?.reason), /2024/);
});

test("§3.7 a cache hit spends NOTHING and still validates and executes", async () => {
  const r = await run({ answers: [], seedCache: queryResult() });
  assert.equal(r.outcome, "cached");
  assert.equal(r.modelCalls, 0);
  assert.equal(r.log.estimatedCostUsd, null);
  assert.equal(r.events.some((e) => e.type === "result"), true);
  assert.equal(r.events.find((e) => e.type === "plan")?.cached, true);
});

test("a cached query that no longer validates is discarded, not retried into the fan's face", async () => {
  const r = await run({ answers: [queryResult()], seedCache: queryResult(BAD_SQL) });
  assert.equal(r.outcome, "answered");
  assert.equal(r.modelCalls, 1);
  assert.equal(await r.store.getCachedAnswer(answerCacheKey("q")) !== null, true);
});

test("§3.7 zero rows is an ending of its own, never a chart and never a sentence", async () => {
  const r = await run({ answers: [queryResult()], execute: async () => execution([]) });
  assert.equal(r.outcome, "empty");
  const res = r.events.find((e) => e.type === "result");
  assert.equal(res?.rowCount, 0);
  assert.equal(res?.render.kind, "table");
});

test("§3.7 a plan-cost rejection is too_expensive, with no retry", async () => {
  const r = await run({
    answers: [queryResult()],
    execute: async () => {
      throw new AskExecutionError("plan:cost", "estimated cost 1.4e12");
    },
  });
  assert.equal(r.outcome, "too_expensive");
  assert.equal(r.modelCalls, 1);
  assert.equal(r.log.validatorVerdict, "rejected:plan:cost");
});

test("§3.7 a statement timeout is its own ending, with no retry", async () => {
  const r = await run({
    answers: [queryResult()],
    execute: async () => {
      throw new AskExecutionError("timeout", "the query took too long and was stopped");
    },
  });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.modelCalls, 1);
});

test("an intent of query with no SQL is treated as a rejection, not a crash", async () => {
  const r = await run({ answers: [{ ...queryResult(), sql: null }, { ...queryResult(), sql: null }] });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.modelCalls, 2);
});

// --- §8.4 the method line ---------------------------------------------------

test("raw_laps fires on a lap-grain view with no clean-lap filter, and not otherwise", () => {
  assert.deepEqual(
    askFlags("SELECT driver_id, avg(lap_time_s) FROM ask.laps GROUP BY 1 LIMIT 20", ["ask.laps"]),
    ["raw_laps", "no_min_sample"],
  );
  const filtered = askFlags(
    "SELECT driver_id, avg(lap_time_s) FROM ask.laps WHERE is_representative HAVING count(*) >= 10 GROUP BY 1 LIMIT 20",
    ["ask.laps"],
  );
  assert.equal(filtered.includes("raw_laps"), false);
  assert.equal(filtered.includes("no_min_sample"), false);
});

test("no_asid_filter fires only for a view that actually carries assumption_set_id", () => {
  assert.equal(
    askFlags("SELECT driver_id FROM ask.pace_ranking LIMIT 5", ["ask.pace_ranking"]).includes("no_asid_filter"),
    true,
  );
  assert.equal(
    askFlags("SELECT driver_id FROM ask.drivers LIMIT 5", ["ask.drivers"]).includes("no_asid_filter"),
    false,
  );
});

test("the method line reads as English, not as SQL", () => {
  assert.equal(methodLine(["ask.laps"], ["raw_laps"], 20), "1 view · no clean-lap filter · 20 rows");
  assert.equal(methodLine(["ask.laps", "ask.sessions"], [], 1), "2 views · 1 row");
});

test("the fallback classifier downgrades every hint to a table and says so", () => {
  const d = alwaysTable(execution(), queryResult().render);
  assert.equal(d.kind, "table");
  assert.equal(d.downgradedFrom, "bar");
});

test("§3.5 a SQLSTATE class-42 database error also spends the one retry, and only one", async () => {
  let attempts = 0;
  const r = await run({
    answers: [queryResult(), queryResult()],
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new AskExecutionError("sql", 'column "session_type" does not exist');
      return execution();
    },
  });
  assert.equal(r.outcome, "answered");
  assert.equal(attempts, 2);
  assert.equal(r.modelCalls, 2);
  assert.equal(r.log.retryCount, 1);
});

test("a class-42 error twice ends the request — the retry is not spent a second time", async () => {
  const r = await run({
    answers: [queryResult(), queryResult()],
    execute: async () => {
      throw new AskExecutionError("sql", 'column "session_type" does not exist');
    },
  });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.modelCalls, 2);
  assert.equal(r.log.retryCount, 1);
});
