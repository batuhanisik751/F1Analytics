// MODE3_SPEC §1.1 — the pool that writes the query log, and nothing else.
//
// Role `f1_ask_log`: INSERT on ask_query_log, SELECT on exactly four of its columns
// (asked_at, session_cookie, ip_hash, estimated_cost_usd — what §5.3's pre-call limit checks
// need and nothing more), SELECT/INSERT/UPDATE on ask_answer_cache, and no privilege on any F1
// table or on schema `ask`.
//
// The reason this pool exists at all: the web app must not write attacker-supplied question
// text over the SUPERUSER pool. A stranger's question is untrusted free text, and the row it
// lands in is written by a role that cannot read it back.
//
// Consumers: lib/ask/log.ts and lib/ask/limits.ts callers only (CI-enforced, §9 WP-7).
import { Pool } from "pg";

const LOG_DSN = process.env.ASK_LOG_DATABASE_URL;

const g = globalThis as unknown as { __f1AskLogPool?: Pool };

/**
 * No fallback, for the same reason as askPool: a default would silently write the log over the
 * superuser connection and quietly remove the separation this role exists to create.
 */
export const logPool: Pool =
  g.__f1AskLogPool ??
  (g.__f1AskLogPool = new Pool({
    connectionString: LOG_DSN,
    max: 2,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    application_name: "f1-ask-log",
  }));

export class LogPoolMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogPoolMisconfigured";
  }
}

/**
 * Throws when `ASK_LOG_DATABASE_URL` is absent. Call it before using `logPool` so the failure
 * is a clear message rather than node-postgres falling back to libpq's environment defaults.
 *
 * NOTE for callers: `f1_ask_log` holds INSERT but not SELECT on `ask_query_log.ask_id`, so
 * `INSERT ... RETURNING ask_id` is `permission denied for table ask_query_log` (measured).
 * Insert without RETURNING, or widen the column grant in scripts/sql/0005_roles.sql first.
 *
 * Unlike askPool there is no identity assertion here: this role's blast radius is one INSERT
 * into a log table, and a failed limit check is not a security event. The provisioning mistake
 * that matters is the one askPool catches.
 */
export function assertLogPoolConfigured(): void {
  if (!LOG_DSN) {
    throw new LogPoolMisconfigured(
      "ASK_LOG_DATABASE_URL is not set. The ask box writes its query log as the INSERT-only role f1_ask_log and has no fallback; see docs/RUNBOOK.md section 8.",
    );
  }
}

/** True when the log pool can be used at all — for a caller that prefers to degrade, not throw. */
export function logPoolConfigured(): boolean {
  return Boolean(LOG_DSN);
}
