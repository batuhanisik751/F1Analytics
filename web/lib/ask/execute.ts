// MODE3_SPEC §1.5, §1.6, §1.7 — the execution envelope. The ONLY file that imports askPool.
//
// One question, one connection, then gone. Every rail here was chosen because the obvious
// version of it was measured and found to be escapable:
//
//   * `BEGIN READ WRITE` escapes `default_transaction_read_only`, so read-only transaction mode
//     is not a boundary — the GRANT is (§1.1). BEGIN READ ONLY below is a convenience.
//   * `SELECT set_config('statement_timeout','0',false)` persists and poisons a pooled
//     connection, so the connection is DESTROYED after one question and a hard stop is fired
//     from outside the session (§1.7 layer 3).
//   * node-postgres runs BOTH statements of `select 1; select 2` under every spelling except a
//     named prepared statement. Only `{ name, text, values }` makes Postgres itself say
//     `cannot insert multiple commands into a prepared statement` (measured; `make
//     db-ask-verify` re-measures it on every run).
//   * `EXPLAIN select 1; select 2` plans the first and EXECUTES the second, so EXPLAIN is not a
//     rail on its own — it is here for the cost, rows, width and relation checks of §1.6.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { cancelAskBackend, checkoutAsk, permittedPlanRelations } from "@/lib/ask/askPool";
import {
  assertPlanAcceptable,
  HARD_CANCEL_MS,
  LOCK_TIMEOUT,
  ROW_CAP,
  STATEMENT_TIMEOUT,
  WORK_MEM,
  type PlanVerdict,
} from "@/lib/ask/limits";

export type AskExecution = {
  /** Column names in positional order, read from `result.fields` — see the duplicate-name note. */
  fields: string[];
  /** `rowMode: 'array'` rows, capped at ROW_CAP. */
  rows: unknown[][];
  /** True when the wrap's LIMIT 501 returned a 501st row: the answer shown is not the whole answer. */
  truncated: boolean;
  plan: PlanVerdict;
  durationMs: number;
};

export class AskExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AskExecutionError";
    this.code = code;
  }
}

/**
 * Runs the ALREADY WRAPPED AND ALREADY VALIDATED SQL of §1.4 (WP-4 produces it; this function
 * never inspects or rewrites it). The executed string is a deterministic function of the
 * validated string.
 */
export async function executeAsk(final: string): Promise<AskExecution> {
  const permitted = await permittedPlanRelations();
  const sha = createHash("sha256").update(final).digest("hex").slice(0, 16);
  const started = Date.now();

  const { client, pid } = await checkoutAsk();
  let settled = false;
  // §1.7 layer 3: a hard stop fired from OUTSIDE the session. Even a session whose
  // statement_timeout was somehow zeroed dies here, because the kill does not originate inside
  // the poisoned session.
  const hardStop = setTimeout(() => {
    if (!settled) void cancelBackend(pid);
  }, HARD_CANCEL_MS);

  try {
    const out = await runInTransaction(client, final, sha, permitted);
    settled = true;
    return { ...out, durationMs: Date.now() - started };
  } catch (err) {
    settled = true;
    throw asExecutionError(err);
  } finally {
    clearTimeout(hardStop);
    // DESTROY the connection — never return it to the pool. statement_timeout is a USERSET GUC
    // that persists on a session, so any ask connection returned to a pool is a connection the
    // next fan might inherit in a poisoned state.
    client.release(true);
  }
}

async function runInTransaction(
  client: PoolClient,
  final: string,
  sha: string,
  permitted: ReadonlySet<string>,
): Promise<Omit<AskExecution, "durationMs">> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL work_mem = '${WORK_MEM}'`);

  // Named prepared statement: the rail that holds when the validator is wrong. The two
  // statements MUST carry different names — reusing one name for the EXPLAIN text and then the
  // bare text fails with `Prepared statements must be unique` (measured).
  const explained = await client.query({
    name: `ask_e_${sha}`,
    text: `EXPLAIN (FORMAT JSON, COSTS ON) ${final}`,
    values: [],
    rowMode: "array",
  });
  const plan = assertPlanAcceptable((explained.rows as unknown[][])[0]?.[0], permitted);

  const res = await client.query({
    name: `ask_x_${sha}`,
    text: final,
    values: [],
    rowMode: "array",
  });
  await client.query("COMMIT");

  const allRows = res.rows as unknown[][];
  // `rowMode: 'array'` is mandatory. Measured: `SELECT * FROM (SELECT 1 AS a, 2 AS a) x` returns
  // a | a -> 1 | 2, and node-postgres's default object row mode collapses {a:1,a:2} to one key,
  // silently dropping a column the fan can see in the displayed SQL.
  return {
    fields: res.fields.map((f) => f.name),
    rows: allRows.slice(0, ROW_CAP),
    truncated: allRows.length > ROW_CAP,
    plan,
  };
}

/**
 * §1.7 layer 3. The cancel is issued on a CONNECTION OF ITS OWN, never over the busy askPool
 * client: a session that has poisoned its own settings cannot be relied on to kill itself, and
 * askPool's two connections may both be busy. `pg_cancel_backend` (not terminate) is enough —
 * the statement dies, the transaction aborts, and the socket is destroyed by the finally block.
 *
 * WP-10: that connection is now `f1_ask`'s own, not the superuser `f1` pool — see
 * `cancelAskBackend` in askPool.ts for the measurement that made the downgrade possible. The
 * superuser pool is no longer reachable from anywhere inside lib/ask/ (§9 WP-7).
 */
const cancelBackend = cancelAskBackend;

/** Postgres error codes that have a specific meaning for the fan (§8.5); everything else is generic. */
function asExecutionError(err: unknown): AskExecutionError {
  if (err instanceof AskExecutionError) return err;
  const e = err as { name?: string; code?: string; message?: string; gate?: string };
  // PlanRejected from limits.ts carries its own gate name and is the retry feedback of §3.5.
  if (e?.name === "PlanRejected") {
    return new AskExecutionError(e.gate ?? "plan", e.message ?? "the query plan was rejected");
  }
  switch (e?.code) {
    case "57014":
      return new AskExecutionError("timeout", "the query took too long and was stopped");
    case "55P03":
    case "40P01":
      return new AskExecutionError("timeout", "the query could not get the locks it needed");
    case "42501":
      return new AskExecutionError("denied", "the query asked for something the ask role cannot read");
    case "42P01":
    case "42703":
    case "42601":
      return new AskExecutionError("sql", e.message ?? "the query did not run");
    case "53300":
    case "53400":
      return new AskExecutionError("busy", "too many questions at once");
    default:
      return new AskExecutionError("exec", e?.message ?? "the query did not run");
  }
}
