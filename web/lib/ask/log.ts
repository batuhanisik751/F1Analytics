// MODE3_SPEC §5.3 / §6.2 / §3.7 — the durable `AskStore`: every attempt logged, the answer
// cache, and the two limit counters that must survive a restart to mean anything.
//
// WP-10 NOTE ON OWNERSHIP: §9.3 assigns this file to WP-5, which did not deliver it; the route
// shipped wired to `memoryAskStore()`, which enforces the per-session cap and the daily budget
// within ONE server process and writes no `ask_query_log` row at all. This is the integration
// package supplying the missing wiring point.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT:
//
//  1. IT RUNS AS `f1_ask_log`, WHICH CANNOT READ THE QUESTION BACK. The role holds INSERT on
//     `ask_query_log` plus a four-column SELECT grant (asked_at, session_cookie, ip_hash,
//     estimated_cost_usd) — exactly what the two pre-call limit checks of §5.3 need and nothing
//     more. So there is no "show me recent questions" query in here and there cannot be one.
//  2. THE INSERT HAS NO `RETURNING`. `ask_id` is outside that column grant, so
//     `INSERT ... RETURNING ask_id` fails with `permission denied for table ask_query_log`
//     (measured by WP-2). The row id is not needed; the insert is fire-and-forget.
//  3. A LOGGING FAILURE MUST NOT COST A FAN THEIR ANSWER, BUT A LIMIT FAILURE MUST.
//     `logQuery` and the cache writes swallow their errors and warn. `countSessionQuestions`
//     and `spentTodayUsd` DO NOT: if the budget counter cannot be read, the route fails closed
//     with 503 rather than serving unmetered — the budget is the limit that protects the owner.
import { logPool, assertLogPoolConfigured, logPoolConfigured } from "@/lib/ask/logPool";
import { askResultSchema, type AskResult } from "@/lib/ask/anthropic";
import { memoryAskStore, type AskLogRow, type AskStore } from "@/lib/ask/pipeline";

/** §5.3's windows are UTC days, matching `ask_query_log.asked_at`'s timezone-aware column. */
const DAY_START = "date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'";

const INSERT_SQL = `
  INSERT INTO ask_query_log (
    session_cookie, ip_hash, question, question_norm, intent,
    sql_generated, sql_executed, validator_verdict, retry_count, outcome,
    row_count, truncated, render_kind, max_plan_cost, touched_views, flags,
    model, input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, estimated_cost_usd, duration_ms, error
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
  )`;

function insertParams(r: AskLogRow): unknown[] {
  return [
    r.sessionCookie,
    r.ipHash,
    r.question,
    r.questionNorm,
    r.intent,
    r.sqlGenerated,
    r.sqlExecuted,
    r.validatorVerdict,
    r.retryCount,
    r.outcome,
    r.rowCount,
    r.truncated,
    r.renderKind,
    r.maxPlanCost,
    r.touchedViews,
    r.flags,
    r.model,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadInputTokens,
    r.cacheCreationInputTokens,
    r.estimatedCostUsd,
    r.durationMs,
    r.error,
  ];
}

function warn(what: string, e: unknown): void {
  // The message only — a pg error's `detail` can echo a parameter, and parameter 3 is the
  // fan's question. Nothing from a log failure should widen what gets printed.
  console.warn(`[ask/log] ${what} failed:`, e instanceof Error ? e.message : e);
}

/**
 * The durable store. Every method runs on the `f1_ask_log` pool — never on `askPool` (which
 * must only ever carry generated SQL) and never on the app's `DATABASE_URL` pool (which is the
 * superuser `f1`, and §0.2's whole point is that no request-time write goes through it).
 */
export function pgAskStore(): AskStore {
  assertLogPoolConfigured();
  return {
    durable: true,

    async getCachedAnswer(key: string): Promise<AskResult | null> {
      try {
        const res = await logPool.query(
          `UPDATE ask_answer_cache
              SET hit_count = hit_count + 1, last_hit_at = now()
            WHERE question_key = $1
        RETURNING payload`,
          [key],
        );
        const payload = res.rows[0]?.payload;
        if (payload === undefined) return null;
        // The cache is the one place a stored MODEL output re-enters the pipeline, so it is
        // re-parsed against the same schema a fresh response is. A row written by an older
        // shape of `AskResult` is treated as a miss, not trusted because it is ours.
        const parsed = askResultSchema.safeParse(payload);
        if (!parsed.success) {
          await this.dropCachedAnswer(key);
          return null;
        }
        return parsed.data;
      } catch (e) {
        warn("cache read", e);
        return null; // a broken cache is a slow answer, never a failed one
      }
    },

    async putCachedAnswer(key, questionNorm, prefixSha, payload): Promise<void> {
      try {
        await logPool.query(
          `INSERT INTO ask_answer_cache (question_key, question_norm, prefix_sha256, payload)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (question_key)
           DO UPDATE SET payload = EXCLUDED.payload,
                         prefix_sha256 = EXCLUDED.prefix_sha256,
                         last_hit_at = now()`,
          [key, questionNorm, prefixSha, JSON.stringify(payload)],
        );
      } catch (e) {
        warn("cache write", e);
      }
    },

    async dropCachedAnswer(key: string): Promise<void> {
      try {
        await logPool.query(`DELETE FROM ask_answer_cache WHERE question_key = $1`, [key]);
      } catch (e) {
        warn("cache drop", e);
      }
    },

    // --- the two limit counters. These deliberately do NOT catch. -----------------------
    //
    // §5.3's budget cap is the limit that protects the OWNER, not the fan. A counter that
    // returns 0 when the database is unreachable fails OPEN — unmetered spend for as long as
    // the outage lasts. The route turns a throw here into a 503 `offline`, which is the
    // correct answer to "I cannot tell whether you are over your limit".

    async countSessionQuestions(sessionCookie: string): Promise<number> {
      const res = await logPool.query(
        `SELECT count(session_cookie)::int AS n
           FROM ask_query_log
          WHERE session_cookie = $1 AND asked_at >= ${DAY_START}`,
        [sessionCookie],
      );
      return res.rows[0]?.n ?? 0;
    },

    async spentTodayUsd(): Promise<number> {
      const res = await logPool.query(
        `SELECT coalesce(sum(estimated_cost_usd), 0)::float8 AS spent
           FROM ask_query_log
          WHERE asked_at >= ${DAY_START}`,
      );
      return res.rows[0]?.spent ?? 0;
    },

    async logQuery(row: AskLogRow): Promise<void> {
      try {
        // No RETURNING: `ask_id` is outside f1_ask_log's column grant (§9.3 WP-2).
        await logPool.query(INSERT_SQL, insertParams(row));
      } catch (e) {
        warn("insert", e);
      }
    },
  };
}

/**
 * What the route calls. A configured `ASK_LOG_DATABASE_URL` gives the durable store; without
 * one the process falls back to the in-memory store and SAYS SO, rather than either crashing a
 * dev machine or pretending the limits are enforced. `store.durable` is the flag the route
 * prints, so the degraded mode is visible in the log rather than inferred from missing rows.
 */
export function askStoreFromEnv(): AskStore {
  if (!logPoolConfigured()) return memoryAskStore();
  try {
    return pgAskStore();
  } catch (e) {
    warn("log pool unavailable, falling back to the in-memory store", e);
    return memoryAskStore();
  }
}
