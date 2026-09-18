// MODE3_SPEC §1.4, §1.6, §1.7, §5.2, §5.3 — every hard number the ask box obeys, in one file,
// each with the measurement that justifies it. Nothing here is imported by a page: this module
// is part of the ask pipeline and has no database and no network of its own.

// --- §1.4 the wrap, the row cap and the server-side byte cap -----------------

/** Rows the fan may receive. `LIMIT 501` is executed; row 501's existence flips `truncated`. */
export const ROW_CAP = 500;
/** The literal put in the wrap. Never raise it without moving ROW_CAP with it. */
export const WRAP_LIMIT = ROW_CAP + 1;
/**
 * Server-side byte cap per row. Measured: a 200 MB single-row result transfers fully in 2.3 s
 * and every client-side cap fires only after node-postgres has buffered the whole DataRow, so
 * the predicate has to run in the server. 64 KiB.
 */
export const ROW_BYTE_CAP = 65536;

/**
 * The wrap of §1.4 — pure string composition, no interpolation of anything but the candidate.
 * The validator never rewrites the model's SQL; it wraps it, and the wrapped text is re-parsed
 * and re-run through gates 1-6 before execution (WP-4 owns that half).
 */
export function wrapCandidate(candidate: string): string {
  return (
    "SELECT * FROM (\n" +
    stripTrailingSemicolon(candidate) +
    "\n) AS ask_result\n" +
    `WHERE pg_column_size(ask_result.*) <= ${ROW_BYTE_CAP}\n` +
    `LIMIT ${WRAP_LIMIT}`
  );
}

/** Trailing `;` (and trailing whitespace) removed — a `;` inside the wrap is a syntax error. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/[\s;]+$/u, "");
}

// --- §1.3 gate 6 shape limits (the validator, WP-4, reads these) -------------

export const MAX_SQL_CHARS = 4000;
export const MAX_RELATION_REFS = 12;
export const MAX_PARSE_DEPTH = 8;
export const MAX_SET_OPS = 3;
/** No `LIMIT` above this may appear inside the model's own SQL. */
export const MAX_INNER_LIMIT = 500;

// --- §1.6 the EXPLAIN gate --------------------------------------------------

/**
 * Reject when ANY node's `Total Cost` exceeds this. Measured on this database, same plan:
 * top node 41.80, maximum node 14,062,834,088,300 — the outer LIMIT lets the planner report a
 * trivial top cost for a triple Cartesian product, so a top-node gate is close to a no-op
 * against exactly the query class it was written to stop.
 *
 *   SELECT count(*) FROM teammate_h2h           4.04
 *   a realistic join + group + order + limit    22.0
 *   SELECT * FROM laps  (biggest honest read)   4,113
 *   laps a x laps b                             7.3e7
 *   laps a x laps b x laps c                    1.4e13
 *
 * 5,000,000 clears the most expensive honest query by ~1,200x and rejects the cheapest
 * Cartesian bomb by ~15x.
 */
export const MAX_PLAN_COST = 5_000_000;
/** Top node only. */
export const MAX_PLAN_ROWS = 5_000_000;
/**
 * `Plan Width x min(Plan Rows, WRAP_LIMIT)` bytes. A cheap pre-check for an honest wide result,
 * NOT a security control: the planner's width estimate for a synthesised text expression is
 * unreliable, which is why §1.4's pg_column_size predicate exists underneath it.
 */
export const MAX_RESULT_BYTES = 2_000_000;

/** A plan node as EXPLAIN (FORMAT JSON) emits it. Only the fields the gate reads are typed. */
type PlanNode = {
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Plan Width"?: number;
  "Relation Name"?: string;
  Plans?: PlanNode[];
  [k: string]: unknown;
};

/** The reason a query was stopped, carried to the log as `validator_verdict` (§1.10, §5.5). */
export class PlanRejected extends Error {
  readonly gate: string;
  constructor(gate: string, message: string) {
    super(message);
    this.name = "PlanRejected";
    this.gate = gate;
  }
}

export type PlanVerdict = {
  maxPlanCost: number;
  topPlanRows: number;
  topPlanWidth: number;
  relations: string[];
};

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
  // EXPLAIN also hangs CTE / SubPlan / InitPlan trees off these keys in some versions.
  for (const key of ["Subplans", "InitPlan", "SubPlan", "CTE"]) {
    const v = node[key];
    if (Array.isArray(v)) for (const child of v as PlanNode[]) walk(child, visit);
  }
}

/**
 * §1.6. `explainJson` is the single value of `EXPLAIN (FORMAT JSON, COSTS ON)` — with
 * `rowMode: 'array'` that is `rows[0][0]`, an array whose first element holds `{ Plan: ... }`.
 * `permittedRelations` is the set of base relations the `ask` views are allowed to expand to
 * (askPool derives it from pg_depend; views expand and the plan names the underlying tables,
 * which an AST walk over view names structurally cannot see).
 */
export function assertPlanAcceptable(
  explainJson: unknown,
  permittedRelations: ReadonlySet<string>,
): PlanVerdict {
  const root = extractPlanRoot(explainJson);

  let maxPlanCost = 0;
  const relations = new Set<string>();
  walk(root, (n) => {
    const c = n["Total Cost"];
    if (typeof c === "number" && Number.isFinite(c) && c > maxPlanCost) maxPlanCost = c;
    const r = n["Relation Name"];
    if (typeof r === "string" && r.length > 0) relations.add(r);
  });

  if (maxPlanCost > MAX_PLAN_COST) {
    throw new PlanRejected(
      "plan:cost",
      `plan cost ${Math.round(maxPlanCost)} exceeds ${MAX_PLAN_COST} — that query would read far more of the database than any honest answer needs`,
    );
  }

  const topPlanRows = numberOr(root["Plan Rows"], 0);
  const topPlanWidth = numberOr(root["Plan Width"], 0);
  if (topPlanRows > MAX_PLAN_ROWS) {
    throw new PlanRejected("plan:rows", `plan estimates ${topPlanRows} rows, over ${MAX_PLAN_ROWS}`);
  }
  const estimatedBytes = topPlanWidth * Math.min(topPlanRows, WRAP_LIMIT);
  if (estimatedBytes > MAX_RESULT_BYTES) {
    throw new PlanRejected(
      "plan:width",
      `plan estimates ${estimatedBytes} bytes of result, over ${MAX_RESULT_BYTES}`,
    );
  }

  for (const name of relations) {
    if (!permittedRelations.has(name)) {
      throw new PlanRejected("plan:relation", `plan touches relation ${name}, which no ask view expands to`);
    }
  }

  return { maxPlanCost, topPlanRows, topPlanWidth, relations: [...relations].sort() };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function extractPlanRoot(explainJson: unknown): PlanNode {
  let v: unknown = explainJson;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new PlanRejected("plan:shape", "EXPLAIN output was not JSON");
    }
  }
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object" && "Plan" in (v as Record<string, unknown>)) {
    const plan = (v as Record<string, unknown>).Plan;
    if (plan && typeof plan === "object") return plan as PlanNode;
  }
  throw new PlanRejected("plan:shape", "EXPLAIN output had no Plan node");
}

// --- §1.7 timeouts that cannot be turned off --------------------------------

/** Layer 1: the role default AND `SET LOCAL` inside the transaction. Catches honest runaways. */
export const STATEMENT_TIMEOUT = "4s";
export const LOCK_TIMEOUT = "1s";
export const WORK_MEM = "16MB";
/**
 * Layer 3: a client-side hard stop fired from OUTSIDE the session. `set_config` on
 * `statement_timeout` persists on a session (measured), so a session that zeroed its own
 * timeout would otherwise run forever. At this deadline execute.ts cancels the backend by pid
 * over the app's own `f1` pool and destroys the ask socket.
 */
export const HARD_CANCEL_MS = 6000;

// --- §5.2 hard structural caps (not tunable) --------------------------------

/** One generation, at most one retry. No third attempt exists in the code path. */
export const MAX_MODEL_CALLS_PER_QUESTION = 2;
/** Never lower: thinking tokens bill against the same budget and a lowball truncates the SQL. */
export const MAX_OUTPUT_TOKENS = 4000;

// --- §5.3 the three limits, all checked BEFORE the model call ---------------

/** Per session, counted server-side in ask_query_log through the f1_ask_log column grant. */
export const SESSION_QUESTION_LIMIT = 20;
/** The counter appears from here, so the limit is never a surprise. */
export const SESSION_COUNTER_FROM = 15;
export const SESSION_COOKIE_NAME = "f1ask_sid";
export const SESSION_COOKIE_MAX_AGE_S = 24 * 60 * 60;

/** Per IP: 6 questions/minute, burst 3, keyed by sha256(ip + ASK_IP_SALT). Raw IP never stored. */
export const IP_REFILL_PER_MINUTE = 6;
export const IP_BURST = 3;

export const DEFAULT_DAILY_BUDGET_USD = 5.0;

/**
 * §5.3.3 — a tripwire, not a dial. Hitting it twice in a week means the other caps are wrong,
 * not that the budget should be raised. Read from the environment on every call so a deploy is
 * not needed to lower it; a malformed or non-positive value falls back to the default rather
 * than failing open.
 */
export function dailyBudgetUsd(): number {
  const raw = process.env.ASK_DAILY_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_BUDGET_USD;
  return n;
}
