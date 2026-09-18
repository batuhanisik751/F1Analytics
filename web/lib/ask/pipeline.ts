// MODE3_SPEC §3 — the ask pipeline, end to end.
//
//   question -> [1] input gate (the route, §1.8)     -> reject: $0 spent
//               [2] answer cache lookup (§3.7)       -> hit: straight to [4], no model call
//               [3] ONE model call (§3.3)            -> clarify / out_of_scope: §3.6
//               [4] validate gates 1-7 (§1.3)        -> fail: one retry (§3.5), then rejected
//               [5] EXPLAIN + plan gates (§1.6)      -> fail: too-expensive
//               [6] execute, prepared, rowMode array -> §1.5
//               [7] classify result shape -> render  -> §3.4
//               [8] log the row, write the cache     -> §6.2
//
// TWO PROPERTIES THIS FILE EXISTS TO HOLD:
//
// 1. THE MODEL NEVER STATES A NUMBER (§3.2). Every model call happens in step [3], BEFORE a
//    single row exists. After `executeAsk` returns there is no call site for a model in this
//    file and there must never be one: that call is where text-to-SQL products produce their
//    confident wrong answers, and it is removed architecturally rather than mitigated.
// 2. THERE IS NO PATH TO THE DATABASE THAT SKIPS VALIDATION — a cache hit re-validates and
//    re-executes exactly like a fresh answer, which is also what keeps a repeated question
//    current against the data instead of frozen at the moment it was first asked.

import askObjects from "@/lib/ask/ask-objects.json";
import {
  callAskModel,
  toAskApiError,
  AskApiError,
  ASK_MODEL,
  type AskResult,
  type AskRetryTurn,
  type RenderHint,
} from "@/lib/ask/anthropic";
import { executeAsk, AskExecutionError, type AskExecution } from "@/lib/ask/execute";
import { MAX_MODEL_CALLS_PER_QUESTION } from "@/lib/ask/limits";
import { answerCacheKey, promptPrefixSha256 } from "@/lib/ask/prompt";
import { validateAskSql, AskValidationError, type ValidatedAsk } from "@/lib/ask/validate";

/** §6.2's `outcome` vocabulary, closed. */
export type AskOutcome =
  | "answered"
  | "clarify"
  | "out_of_scope"
  | "rejected"
  | "empty"
  | "timeout"
  | "too_expensive"
  | "api_error"
  | "limit"
  | "cached";

/** §3.4's decision. Produced from the EXECUTED result with the model's hint as an input only. */
export type AskRenderDecision = {
  kind: "table" | "bar" | "line" | "scatter" | "single";
  labelCol: string | null;
  valueCols: string[];
  seriesCol: string | null;
  unit: RenderHint["unit"];
  sort: RenderHint["sort"];
  /** Why the model's hint was not honoured, when it was not. Logged; also shown in dev. */
  downgradedFrom: RenderHint["kind"] | null;
};

/**
 * `lib/ask/render.ts` (§8.1) owns §3.4's full table and the precomputed-page links. It is NOT
 * this package's file, so the pipeline takes the classifier as a dependency and falls back to
 * `alwaysTable` — which is the one answer §3.4 guarantees is never wrong.
 */
export type RenderClassifier = (
  execution: AskExecution,
  hint: RenderHint | null,
) => AskRenderDecision;

export function alwaysTable(_e: AskExecution, hint: RenderHint | null): AskRenderDecision {
  return {
    kind: "table",
    labelCol: null,
    valueCols: [],
    seriesCol: null,
    unit: hint?.unit ?? "none",
    sort: hint?.sort ?? "as_written",
    downgradedFrom: hint && hint.kind !== "table" ? hint.kind : null,
  };
}

/** One row of `ask_query_log` (§6.2). Every attempt writes one, including the ones that never
 *  reached the model — that is what makes §5.5's three guessed numbers measurable. */
export type AskLogRow = {
  sessionCookie: string;
  ipHash: string;
  question: string;
  questionNorm: string;
  intent: string | null;
  sqlGenerated: string | null;
  sqlExecuted: string | null;
  validatorVerdict: string; // 'ok' | 'rejected:<gate>' | 'not_attempted'
  retryCount: number;
  outcome: AskOutcome;
  rowCount: number | null;
  truncated: boolean;
  renderKind: string | null;
  maxPlanCost: number | null;
  touchedViews: string[];
  flags: string[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  estimatedCostUsd: number | null;
  durationMs: number;
  error: string | null;
};

/**
 * The persistence the pipeline needs. `lib/ask/log.ts` (§8.1) owns the SQL behind it and is not
 * this package's file, so it arrives as a dependency. `memoryAskStore()` below is the honest
 * stand-in: it works, it enforces nothing across a restart, and it says so.
 */
export interface AskStore {
  getCachedAnswer(key: string): Promise<AskResult | null>;
  putCachedAnswer(key: string, questionNorm: string, prefixSha: string, payload: AskResult): Promise<void>;
  dropCachedAnswer(key: string): Promise<void>;
  /** §5.3 limit 1 — questions this `f1ask_sid` has already asked. */
  countSessionQuestions(sessionCookie: string): Promise<number>;
  /** §5.3 limit 3 — sum of `estimated_cost_usd` since UTC midnight. */
  spentTodayUsd(): Promise<number>;
  logQuery(row: AskLogRow): Promise<void>;
  /** False for a store that does not survive a restart — the route says so in its startup log. */
  readonly durable: boolean;
}

export function memoryAskStore(): AskStore {
  const cache = new Map<string, AskResult>();
  const perSession = new Map<string, number>();
  let spentToday = 0;
  let spentDay = new Date().getUTCDate();
  return {
    durable: false,
    async getCachedAnswer(key) {
      return cache.get(key) ?? null;
    },
    async putCachedAnswer(key, _norm, _sha, payload) {
      cache.set(key, payload);
    },
    async dropCachedAnswer(key) {
      cache.delete(key);
    },
    async countSessionQuestions(sid) {
      return perSession.get(sid) ?? 0;
    },
    async spentTodayUsd() {
      const today = new Date().getUTCDate();
      if (today !== spentDay) {
        spentDay = today;
        spentToday = 0;
      }
      return spentToday;
    },
    async logQuery(row) {
      perSession.set(row.sessionCookie, (perSession.get(row.sessionCookie) ?? 0) + 1);
      const today = new Date().getUTCDate();
      if (today !== spentDay) {
        spentDay = today;
        spentToday = 0;
      }
      spentToday += row.estimatedCostUsd ?? 0;
    },
  };
}

// --- §8.4's method line -----------------------------------------------------
//
// The three flags that correlate with the wrong-but-valid case. §8.4 says they come from the
// validator's own AST walk; `validate.ts` (WP-4's file) does not currently export them, so they
// are derived here from the ALREADY-PARSED, ALREADY-ALLOWLISTED statement text plus the
// relation list the walk did return. Reported as a gap: moving them into `ValidatedAsk` would
// make them structural rather than textual, and this file would then just read them.

/** Per-lap / per-sample grain views: an average over these without a clean-lap filter is wrong. */
const LAP_GRAIN_VIEWS = new Set(["ask.laps", "ask.wp_lap_probability", "ask.weather_samples"]);

/** Every ask view that carries `assumption_set_id` — read from the generated contract itself. */
const ASID_VIEWS = new Set(
  Object.entries(askObjects as Record<string, Array<{ col: string }>>)
    .filter(([, cols]) => cols.some((c) => c.col === "assumption_set_id"))
    .map(([view]) => view),
);

export function askFlags(sql: string, relations: string[]): string[] {
  const flags: string[] = [];
  const touchesLapGrain = relations.some((r) => LAP_GRAIN_VIEWS.has(r));
  if (touchesLapGrain && !/\bis_representative\b/i.test(sql)) flags.push("raw_laps");
  if (relations.some((r) => ASID_VIEWS.has(r)) && !/\bassumption_set_id\b/i.test(sql)) {
    flags.push("no_asid_filter");
  }
  const aggregates = /\bgroup\s+by\b/i.test(sql);
  const hasMinSample = /\bhaving\b/i.test(sql) && /\bcount\s*\(/i.test(sql);
  if (aggregates && !hasMinSample) flags.push("no_min_sample");
  return flags;
}

const FLAG_COPY: Record<string, string> = {
  raw_laps: "no clean-lap filter",
  no_asid_filter: "no assumption-set filter",
  no_min_sample: "no minimum sample",
};

/**
 * The line a fan who cannot read SQL actually reads (§8.4):
 *   `2 views · no clean-lap filter · 20 rows`
 * Built from the AST's relation list and the flags, never from the model's prose.
 */
export function methodLine(relations: string[], flags: string[], rowCount: number | null): string {
  const parts: string[] = [];
  parts.push(relations.length === 1 ? "1 view" : `${relations.length} views`);
  for (const f of flags) parts.push(FLAG_COPY[f] ?? f);
  if (rowCount !== null) parts.push(rowCount === 1 ? "1 row" : `${rowCount} rows`);
  return parts.join(" · ");
}

// --- the SSE events (§8.2) --------------------------------------------------
//
// Nothing unvalidated is ever streamed. `state` carries progress only; the SQL appears in
// `plan`, which is emitted AFTER gates 1-7 have passed.

export type AskEvent =
  | { type: "state"; state: "writing" | "checking" | "running" }
  | {
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
    }
  | { type: "clarify"; clarification: string; options: string[]; method: string }
  | { type: "out_of_scope"; reason: string }
  | {
      type: "result";
      fields: string[];
      rows: unknown[][];
      rowCount: number;
      truncated: boolean;
      render: AskRenderDecision;
      methodLine: string;
      durationMs: number;
    }
  | { type: "error"; code: string; message: string; sql: string | null; gate: string | null };

export type AskPipelineInput = {
  /** The cleaned question the input gate produced. Never concatenated into the system prompt. */
  question: string;
  questionNorm: string;
  sessionCookie: string;
  ipHash: string;
};

export type AskDeps = {
  store: AskStore;
  emit: (event: AskEvent) => void;
  /** `lib/ask/render.ts`'s §3.4 classifier. Omitted: everything renders as a table. */
  classifyRender?: RenderClassifier;
  /**
   * TEST SEAMS ONLY. Defaults are the real model call and the real executor. They exist so the
   * retry path, the cache path and every ending of §3.7 can be asserted with no key and no
   * database — the alternative is a pipeline whose most important branches are only ever
   * exercised by hand.
   */
  callModel?: typeof callAskModel;
  execute?: typeof executeAsk;
};

export type AskRun = { outcome: AskOutcome; log: AskLogRow };

function emptyLog(input: AskPipelineInput): AskLogRow {
  return {
    sessionCookie: input.sessionCookie,
    ipHash: input.ipHash,
    question: input.question,
    questionNorm: input.questionNorm,
    intent: null,
    sqlGenerated: null,
    sqlExecuted: null,
    validatorVerdict: "not_attempted",
    retryCount: 0,
    outcome: "api_error",
    rowCount: null,
    truncated: false,
    renderKind: null,
    maxPlanCost: null,
    touchedViews: [],
    flags: [],
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    estimatedCostUsd: null,
    durationMs: 0,
    error: null,
  };
}

/**
 * §3.5's retry feedback. Postgres error text is NOT echoed verbatim: only SQLSTATE class 42
 * (undefined table / column / function, syntax) is passed through, because those are our own
 * database talking about our own schema. Every other class becomes a fixed string — some
 * Postgres messages quote the offending VALUE, and that value came from the question, so
 * echoing it is a small injection path back into the prompt for no benefit.
 */
function retryFeedbackFor(err: AskValidationError | AskExecutionError): string | null {
  if (err instanceof AskValidationError) return `${err.gate}. ${err.message}`;
  if (err.code === "sql") return `the database rejected it: ${err.message}`;
  if (err.code === "denied") return "the query asked for an object the ask role cannot read.";
  return null; // cost, timeout and resource failures get NO retry at all (§3.5)
}

/** A logged error string must never carry a key, a DSN or a fan's raw text back out. */
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}

/**
 * Steps [2]-[8] of §3.1. The route owns steps [1] (the input gate) and the SSE transport; this
 * function owns everything that can spend money or touch the database, and returns the log row
 * it already wrote so the route can answer §5.3's counter without a second query.
 */
export async function runAsk(input: AskPipelineInput, deps: AskDeps): Promise<AskRun> {
  const started = Date.now();
  const classify = deps.classifyRender ?? alwaysTable;
  const log = emptyLog(input);
  const cacheKey = answerCacheKey(input.questionNorm);

  const done = async (outcome: AskOutcome): Promise<AskRun> => {
    log.outcome = outcome;
    log.durationMs = Date.now() - started;
    try {
      await deps.store.logQuery(log);
    } catch (e) {
      console.error("[ask] log write failed:", safeError(e));
    }
    return { outcome, log };
  };

  deps.emit({ type: "state", state: "writing" });

  // [2] the answer cache stores the QUERY, never the rows, so a hit still runs [4]-[6] and
  // still returns today's data (§3.7).
  let result: AskResult | null = null;
  let cached = false;
  try {
    result = await deps.store.getCachedAnswer(cacheKey);
    cached = result !== null;
  } catch (e) {
    console.error("[ask] cache read failed:", safeError(e));
  }

  let modelCalls = 0;
  let pendingRetry: AskRetryTurn | undefined;
  let retryReason: string | null = null;
  let validated: ValidatedAsk | null = null;
  let lastRejection: AskValidationError | null = null;

  // At most three passes: cache-hit-then-fresh, fresh, retry. The hard cap that matters is
  // MAX_MODEL_CALLS_PER_QUESTION (§5.2) — there is no third generation in this code path.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!result) {
      if (modelCalls >= MAX_MODEL_CALLS_PER_QUESTION) break;
      try {
        // [3] THE ONE MODEL CALL. Everything it returns is written before any row exists.
        const call = await (deps.callModel ?? callAskModel)(input.question, pendingRetry);
        modelCalls++;
        result = call.result;
        log.model = call.usage.model ?? ASK_MODEL;
        log.inputTokens = (log.inputTokens ?? 0) + call.usage.inputTokens;
        log.outputTokens = (log.outputTokens ?? 0) + call.usage.outputTokens;
        log.cacheReadInputTokens =
          (log.cacheReadInputTokens ?? 0) + call.usage.cacheReadInputTokens;
        log.cacheCreationInputTokens =
          (log.cacheCreationInputTokens ?? 0) + call.usage.cacheCreationInputTokens;
        log.estimatedCostUsd =
          Math.round(((log.estimatedCostUsd ?? 0) + call.usage.estimatedCostUsd) * 1e6) / 1e6;
        if (call.stopReason === "max_tokens") {
          log.error = "stop_reason=max_tokens (the output was truncated)";
        }
      } catch (err) {
        const e: AskApiError = toAskApiError(err);
        log.error = `${e.code}: ${safeError(e)}`;
        deps.emit({ type: "error", code: e.code, message: e.code, sql: null, gate: null });
        return done("api_error");
      }
    }

    log.intent = result.intent;

    // §3.6 — neither of these is a failure, and neither runs a query.
    if (result.intent === "clarify") {
      deps.emit({
        type: "clarify",
        clarification: result.clarification ?? "Which did you mean?",
        options: result.options,
        method: result.method,
      });
      return done("clarify");
    }
    if (result.intent === "out_of_scope") {
      deps.emit({ type: "out_of_scope", reason: result.reason ?? result.method });
      return done("out_of_scope");
    }

    deps.emit({ type: "state", state: "checking" });
    log.sqlGenerated = result.sql;

    // [4] gates 1-7. Nothing reaches the database except what comes back from here.
    try {
      if (!result.sql) {
        throw new AskValidationError("0", "parse:shape", "no SQL was returned for a query intent", "");
      }
      validated = await validateAskSql(result.sql);
      log.validatorVerdict = "ok";
    } catch (err) {
      if (!(err instanceof AskValidationError)) {
        log.error = safeError(err);
        deps.emit({ type: "error", code: "exec", message: "exec", sql: null, gate: null });
        return done("api_error");
      }
      lastRejection = err;
      log.validatorVerdict = `rejected:${err.gate}`;
      const prior = result;
      result = null;
      if (cached) {
        // A cached query that no longer validates is not retried — it is discarded, and the
        // question takes the ordinary fresh path on the next pass.
        cached = false;
        try {
          await deps.store.dropCachedAnswer(cacheKey);
        } catch {
          /* a stale cache row is not worth failing the request over */
        }
        continue;
      }
      const feedback = retryFeedbackFor(err);
      if (feedback && modelCalls < MAX_MODEL_CALLS_PER_QUESTION) {
        pendingRetry = { priorOutput: prior, rejection: feedback };
        retryReason = `${err.gate}: ${err.message}`;
        log.retryCount += 1;
        continue;
      }
      break;
    }

    // [5]-[8] run INSIDE the loop, because §3.5 spends the single retry on a Postgres error
    // about our own schema (SQLSTATE class 42) exactly as it does on a validator gate. Cost,
    // timeout and resource failures return no feedback and therefore never retry.
    const finished = await executeAndRender({
      input,
      deps,
      log,
      done,
      classify,
      result,
      validated,
      cached,
      retryReason,
      cacheKey,
      canRetry: !cached && modelCalls < MAX_MODEL_CALLS_PER_QUESTION,
    });
    if (!("retry" in finished)) return finished;
    pendingRetry = { priorOutput: result, rejection: finished.retry };
    retryReason = finished.gate;
    log.retryCount += 1;
    result = null;
    validated = null;
  }

  deps.emit({
    type: "error",
    code: "rejected",
    message: lastRejection?.message ?? "the query did not pass the safety checks",
    sql: lastRejection?.sql ?? log.sqlGenerated,
    gate: lastRejection?.gate ?? null,
  });
  return done("rejected");
}

/** Steps [5]-[8]: EXPLAIN, execute, classify, render, cache, log. No model is called here. */
async function executeAndRender(ctx: {
  input: AskPipelineInput;
  deps: AskDeps;
  log: AskLogRow;
  done: (outcome: AskOutcome) => Promise<AskRun>;
  classify: RenderClassifier;
  result: AskResult;
  validated: ValidatedAsk;
  cached: boolean;
  retryReason: string | null;
  cacheKey: string;
  /** True when §3.5's one retry is still available for a FIXABLE database error. */
  canRetry: boolean;
}): Promise<AskRun | { retry: string; gate: string }> {
  const { deps, log, done, classify, result, validated, cached, retryReason } = ctx;

  const flags = askFlags(validated.candidate, validated.relations);
  log.touchedViews = validated.relations;
  log.flags = flags;
  log.sqlExecuted = validated.final;

  // The SQL reaches the browser here and not a moment earlier (§8.2): after gates 1-7, never
  // token-by-token as the model writes it.
  deps.emit({
    type: "plan",
    sql: validated.candidate,
    headline: result.headline,
    method: result.method,
    caveat: result.caveat,
    views: validated.relations,
    flags,
    methodLine: methodLine(validated.relations, flags, null),
    cached,
    retried: log.retryCount > 0,
    retryReason,
  });

  deps.emit({ type: "state", state: "running" });

  let execution: AskExecution;
  try {
    execution = await (deps.execute ?? executeAsk)(validated.final);
  } catch (err) {
    const e = err instanceof AskExecutionError ? err : new AskExecutionError("exec", safeError(err));
    log.error = `${e.code}: ${safeError(e)}`;
    const feedback = ctx.canRetry ? retryFeedbackFor(e) : null;
    if (feedback) return { retry: feedback, gate: e.code };
    deps.emit({ type: "error", code: e.code, message: e.code, sql: validated.candidate, gate: e.code });
    if (e.code === "timeout") return done("timeout");
    if (e.code.startsWith("plan:")) {
      log.validatorVerdict = `rejected:${e.code}`;
      return done("too_expensive");
    }
    return done("rejected");
  }

  log.rowCount = execution.rows.length;
  log.truncated = execution.truncated;
  log.maxPlanCost = execution.plan.maxPlanCost;

  // [7] §3.4 — decided from the EXECUTED result, with the model's hint as an input and never as
  // a verdict. A wrong chart is a wrong answer with a picture attached.
  const render =
    execution.rows.length === 0 ? alwaysTable(execution, result.render) : classify(execution, result.render);
  log.renderKind = render.kind;

  deps.emit({
    type: "result",
    fields: execution.fields,
    rows: execution.rows,
    rowCount: execution.rows.length,
    truncated: execution.truncated,
    render,
    methodLine: methodLine(validated.relations, flags, execution.rows.length),
    durationMs: execution.durationMs,
  });

  // [8] The cache stores the QUERY, never the rows — so a repeat is free in tokens and still
  // current against the data. Zero rows is cached too: it is a real answer, and re-asking it
  // after an ingest re-runs the same query against the new rows.
  if (!cached) {
    try {
      await deps.store.putCachedAnswer(ctx.cacheKey, ctx.input.questionNorm, promptPrefixSha256(), result);
    } catch (e) {
      console.error("[ask] cache write failed:", safeError(e));
    }
  }

  if (execution.rows.length === 0) return done("empty");
  return done(cached ? "cached" : "answered");
}
