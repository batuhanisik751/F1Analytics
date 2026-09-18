// MODE3_SPEC §6: the three v1.4 tables.
//
// Ownership split (§6.3):
//   - race_report is written by Python (f1lab/report.py) at ingest and read by the
//     race page. It is the ONLY one of the three in frames.TABLE_COLUMNS.
//   - ask_query_log and ask_answer_cache are written by the web, by the f1_ask_log
//     role only. Python never writes them, so they are deliberately absent from
//     frames.TABLE_COLUMNS; tests/test_web_owned_tables.py is their drift check.
//
// Neither ask table is in schema `ask` and neither is granted to f1_ask (§1.2):
// a fan cannot ask the ask box what other fans have asked.
//
// Transcription rules obeyed here (inherited from mode2.ts §6.1):
//   - explicit snake_case for every column, index and constraint name;
//   - every CHECK is named exactly as in §6.1, so a regenerated migration does not
//     invent a name and produce a spurious drop/add pair;
//   - text("x").array() for text[]; jsonb() for jsonb; real() for `real` and
//     doublePrecision() for `double precision` -- §6.1 uses BOTH and they differ;
//   - numeric(10,6) for estimated_cost_usd: psycopg would hand this back as Decimal,
//     but Python never reads this table, so the spec's type stands verbatim.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { assumptionSets, sessions } from "./reference";

// --- §6.1 race_report: written by Python, read by the web -------------------

// Prose is one column per paragraph, NOT markdown. There is then no markdown
// renderer anywhere near generated text (§8.7).
export const raceReport = pgTable(
  "race_report",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    assumptionSetId: integer("assumption_set_id")
      .notNull()
      .references(() => assumptionSets.assumptionSetId),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(), // 'ok' | 'refused' | 'skipped'
    groundingCompleteness: text("grounding_completeness").notNull(), // ok|partial|insufficient
    groundingSha256: text("grounding_sha256").notNull(),
    result: text("result"), // paragraph 1 -- NULL unless status='ok'
    pace: text("pace"), // paragraph 2 -- nullable even when ok
    strategy: text("strategy"), // paragraph 3
    swing: text("swing"), // paragraph 4
    caveats: text("caveats"),
    knownGaps: text("known_gaps")
      .array()
      .notNull()
      .default(sql`'{}'`),
    cites: jsonb("cites")
      .$type<Record<string, string[]>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditFailures: jsonb("audit_failures")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    skippedReason: text("skipped_reason"),
    wordCount: integer("word_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estCostUsd: real("est_cost_usd").notNull().default(0),
    regenerations: integer("regenerations").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "race_report_session_id_assumption_set_id_pk",
      columns: [t.sessionId, t.assumptionSetId],
    }),
    check(
      "race_report_status_check",
      sql`${t.status} = ANY (ARRAY['ok','refused','skipped'])`,
    ),
    check(
      "race_report_completeness_check",
      sql`${t.groundingCompleteness} = ANY (ARRAY['ok','partial','insufficient'])`,
    ),
    check(
      "race_report_body_check",
      sql`(${t.status} = 'ok') = (${t.result} IS NOT NULL)`,
    ),
  ],
);

// --- §6.2 ask_query_log: written by the web (role f1_ask_log, INSERT only) ---

// session_cookie is a random id; ip_hash is sha256(ip + ASK_IP_SALT). The raw IP
// is never stored, and neither column is ever a name.
export const askQueryLog = pgTable(
  "ask_query_log",
  {
    askId: bigserial("ask_id", { mode: "bigint" }).primaryKey(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    sessionCookie: text("session_cookie").notNull(),
    ipHash: text("ip_hash").notNull(),
    question: text("question").notNull(),
    questionNorm: text("question_norm").notNull(),
    intent: text("intent"), // query | clarify | out_of_scope | NULL
    sqlGenerated: text("sql_generated"),
    sqlExecuted: text("sql_executed"), // the wrapped text, or NULL
    validatorVerdict: text("validator_verdict").notNull(), // ok|rejected:<gate>|not_attempted
    retryCount: smallint("retry_count").notNull().default(0),
    outcome: text("outcome").notNull(), // answered|clarify|out_of_scope|rejected|empty|
    // timeout|too_expensive|api_error|limit|cached
    rowCount: integer("row_count"),
    truncated: boolean("truncated").notNull().default(false),
    renderKind: text("render_kind"),
    maxPlanCost: doublePrecision("max_plan_cost"),
    touchedViews: text("touched_views")
      .array()
      .notNull()
      .default(sql`'{}'`),
    // AST-derived (§8.4): 'raw_laps', 'no_asid_filter', 'no_min_sample'
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  (t) => [
    index("ask_query_log_asked_at_idx").on(t.askedAt.desc()),
    index("ask_query_log_cookie_idx").on(t.sessionCookie, t.askedAt.desc()),
    index("ask_query_log_ip_idx").on(t.ipHash, t.askedAt.desc()),
    index("ask_query_log_outcome_idx").on(t.outcome, t.askedAt.desc()),
  ],
);

// --- §6.2 ask_answer_cache --------------------------------------------------

// question_key is sha256(question_norm + PROMPT_PREFIX_SHA256): a prompt change
// changes the prefix hash and therefore invalidates every cached answer.
export const askAnswerCache = pgTable("ask_answer_cache", {
  questionKey: text("question_key").primaryKey(),
  questionNorm: text("question_norm").notNull(),
  prefixSha256: text("prefix_sha256").notNull(),
  // the full AskResult: sql, headline, method, caveat, render
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }).notNull().defaultNow(),
});
