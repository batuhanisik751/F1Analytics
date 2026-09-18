// MODE3_SPEC §1.3 / §1.4 — the SQL validator. Seven gates over a real PostgreSQL parse tree.
//
// This file has no key, no network and no database. It is pure: text in, a verdict out.
//
// The parser is `libpg-query@17.7.4` — the PostgreSQL C parser compiled to WASM — and never a
// regex, because a validator whose grammar disagrees with the server's grammar is bypassable by
// construction. The package exports no deparser, so nothing here re-emits the AST: the model's
// text is never rewritten, only wrapped (§1.4).
//
// THE LESSON THAT SHAPES EVERY GATE (measured with this exact parser):
//
//   "WITH x AS (DELETE FROM laps RETURNING *) SELECT * FROM x"   n=1  SelectStmt
//   "SELECT * INTO newtab FROM laps"                             n=1  SelectStmt
//   "SELECT * FROM laps FOR UPDATE"                              n=1  SelectStmt
//   "SELECT pg_read_file('/etc/passwd')"                         n=1  SelectStmt
//   "SELECT * FROM pg_shadow"                                    n=1  SelectStmt
//   "SELECT * FROM dblink('host=evil','select 1') AS t(a int)"   n=1  SelectStmt
//   "SELECT lo_import('/etc/passwd')"                            n=1  SelectStmt
//   "TABLE laps"                                                 n=1  SelectStmt
//
// "It parses to exactly one SelectStmt" is NOT a safety property. Every gate below assumes the
// candidate is fully attacker-controlled, and anything the walk cannot prove safe is rejected.

import { parse } from "libpg-query";
import askObjects from "./ask-objects.json";
import {
  MAX_PARSE_DEPTH,
  MAX_RELATION_REFS,
  MAX_SET_OPS,
  MAX_SQL_CHARS,
  MAX_INNER_LIMIT,
  WRAP_LIMIT,
  stripTrailingSemicolon,
  wrapCandidate,
} from "./limits";

/** Every object the generated `ask` schema exposes — the allowlist IS the grant (§1.2). */
export const ASK_OBJECTS: ReadonlySet<string> = new Set(Object.keys(askObjects));

/**
 * Gate 5: an explicit allowlist, never a denylist. A denylist is one unknown function away from
 * failing open and is already incomplete — `repeat('x',1e9)` passes one, plans at cost 0.01,
 * finishes in 3.65 s inside every timeout and returns a 1 GB row (measured).
 *
 * The SQL-syntax forms (EXTRACT, SUBSTRING … FROM … FOR, TRIM, POSITION) are emitted by the
 * parser as `pg_catalog`-qualified calls with `funcformat: COERCE_SQL_SYNTAX`, so `extract`,
 * `date_part`, `btrim`, `substring` and `position` must be here for honest SQL to pass.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "stddev", "stddev_samp", "stddev_pop", "variance",
  "var_samp", "var_pop", "corr", "covar_samp", "covar_pop", "regr_slope", "regr_intercept",
  "regr_r2", "bool_and", "bool_or", "every", "mode", "percentile_cont", "percentile_disc",
  // window functions
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  // math
  "abs", "round", "floor", "ceil", "ceiling", "trunc", "sign", "sqrt", "power", "exp", "ln",
  "log", "mod", "div", "pi",
  // date / time
  "date_trunc", "date_part", "extract", "age", "to_char", "to_date", "to_timestamp",
  "make_date", "make_timestamp",
  // strings (short ones only — every value expander is excluded on purpose, below)
  "lower", "upper", "initcap", "length", "char_length", "character_length", "substring",
  "substr", "strpos", "position", "split_part", "replace", "trim", "btrim", "ltrim", "rtrim",
  "concat", "concat_ws", "left", "right", "reverse", "starts_with",
  // arrays and null handling
  "unnest", "array_agg", "string_agg", "array_length", "cardinality", "array_to_string",
  "string_to_array", "coalesce", "nullif", "greatest", "least",
]);

/**
 * Gate 5b — excluded ON PURPOSE, each with its measurement. Reported separately from "unknown
 * function" so the log can tell a fan's typo apart from a resource attack.
 *
 *   repeat/lpad/rpad/format/overlay/translate — value expanders; the 1 GB-row vector.
 *   generate_series — an opaque bound defeats any size regex:
 *       generate_series(1,(SELECT count(*) FROM laps)*1000000) plans at cost 3,174, three orders
 *       of magnitude under every cost gate, and burns the whole statement timeout (measured).
 *   random/now/clock_timestamp — non-determinism breaks the answer cache's promise.
 *   set_config/current_setting — measured to SUCCEED and PERSIST on a pooled connection.
 */
export const EXCLUDED_FUNCTIONS: ReadonlySet<string> = new Set([
  "repeat", "lpad", "rpad", "format", "overlay", "translate", "generate_series",
  "generate_subscripts", "random", "now", "clock_timestamp", "timeofday", "statement_timestamp",
  "set_config", "current_setting", "pg_sleep", "pg_sleep_for", "pg_sleep_until",
]);

/** The one name the wrap adds, permitted only while re-validating the wrapped text (§1.4). */
export const WRAP_FUNCTION = "pg_column_size";

// --- the verdict ------------------------------------------------------------

/** "1" | "2" | "3" | "4" | "5" | "5b" | "6" | "7", plus "0" for a parse failure. */
export type GateNumber = "0" | "1" | "2" | "3" | "4" | "5" | "5b" | "6" | "7";

/**
 * Thrown by every rejection. `gate` is the machine-readable verdict that goes into
 * `ask_query_log.validator_verdict` and into the single retry's feedback (§3.5, §1.10);
 * `message` is the sentence a fan reads next to the rejected SQL.
 */
export class AskValidationError extends Error {
  readonly gate: string;
  readonly gateNumber: GateNumber;
  readonly sql: string;
  constructor(gateNumber: GateNumber, gate: string, message: string, sql: string) {
    super(message);
    this.name = "AskValidationError";
    this.gate = gate;
    this.gateNumber = gateNumber;
    this.sql = sql;
  }
}

export type ValidatedAsk = {
  /** The model's own text, unchanged apart from a stripped trailing `;`. Shown to the fan. */
  candidate: string;
  /** The wrapped, re-validated string `executeAsk` runs. A deterministic function of the above. */
  final: string;
  /** Sorted `ask.*` objects the statement reads — the method line in the SQL panel (§8.4). */
  relations: string[];
  /** Sorted function names used, after allowlisting. */
  functions: string[];
  /** Nesting depth of SELECTs, and the count of relation references, for the log. */
  depth: number;
  relationRefs: number;
};

// --- the walk ---------------------------------------------------------------

type Node = Record<string, unknown>;

/** Everything one pass over the tree collects. Gates 3-6 are then pure checks over this. */
type Collected = {
  writeCtes: string[];
  intoClauses: number;
  lockingClauses: number;
  /**
   * [schemaname|null, relname, boundByAnEnclosingWith] for every RangeVar anywhere in the tree.
   * The third element is the CTE-alias subtraction of gate 4: measured, the walk reports a
   * CTE's own alias as a relname, so a naive allowlist check rejects every legitimate CTE.
   */
  rangeVars: Array<[string | null, string, boolean]>;
  /** Fully-qualified funcname as written, plus the parser's funcformat. */
  funcs: Array<{ name: string[]; format: string }>;
  /** Node types rejected wholesale (SQLValueFunction, XmlExpr, …), by name. */
  opaqueNodes: string[];
  params: number;
  setOps: number;
  recursiveCtes: number;
  /** FROM items whose node type is not on ALLOWED_FROM_ITEMS, by type name. */
  badFromItems: string[];
  /** Every `limitCount` seen: a number, or null when it is not an integer constant. */
  limits: Array<number | null>;
  maxSelectDepth: number;
};

const NODE_KEY = /^[A-Z]/;

/**
 * One iterative pass over the whole parse tree. Iterative, not recursive, because a deeply
 * nested expression from an attacker must not be able to overflow the stack before the shape
 * gate gets to reject it.
 *
 * `depth` counts SELECT nesting only. Generic node depth is not a usable metric here: the
 * honest reference query Q5 of §3.8 is 8 node-levels deep unwrapped and 10 wrapped, so a
 * node-level cap of 8 would reject the spec's own worked examples. SELECT nesting is the
 * metric that actually bounds the blow-up a subquery bomb needs (measured on the ten worked
 * examples: max 2 unwrapped, 3 wrapped — MAX_PARSE_DEPTH of 8 leaves real headroom).
 */
function collect(root: unknown): Collected {
  const c: Collected = {
    writeCtes: [], intoClauses: 0, lockingClauses: 0, rangeVars: [],
    funcs: [], opaqueNodes: [], params: 0, setOps: 0, recursiveCtes: 0, badFromItems: [], limits: [],
    maxSelectDepth: 0,
  };
  type Frame = { v: unknown; d: number; vis: ReadonlySet<string>; selectBody?: boolean };
  const stack: Frame[] = [{ v: root, d: 0, vis: new Set() }];

  /**
   * A SelectStmt's own body. Called for the wrapped `{SelectStmt: {...}}` form AND for the two
   * arms of a set operation, which are BARE bodies with no wrapper key — measured:
   * `{op:"SETOP_UNION", larg:{...}, rarg:{...}}`. A walk that only looks for the wrapper never
   * inspects them, and `SELECT 1 UNION ALL SELECT * FROM ask.laps FOR UPDATE` passes gate 3.
   */
  const handleSelectBody = (node: Node, d: number, vis: ReadonlySet<string>): void => {
    const depth = d + 1;
    if (depth > c.maxSelectDepth) c.maxSelectDepth = depth;
    const names = inspectSelect(node, c);
    // CTE names are visible to THIS SelectStmt and everything under it, and to nothing above it.
    // A global name set would let `SELECT * FROM ingest_runs WHERE 1 IN (WITH ingest_runs AS
    // (SELECT 1) SELECT * FROM ingest_runs)` launder the outer reference past gate 4.
    const childVis: ReadonlySet<string> = names.length > 0 ? new Set([...vis, ...names]) : vis;
    for (const [key, val] of Object.entries(node)) {
      // The arms of a set operation are siblings, not another level of nesting.
      if ((key === "larg" || key === "rarg") && isPlainObject(val)) {
        stack.push({ v: val, d, vis: childVis, selectBody: true });
      } else {
        stack.push({ v: val, d: depth, vis: childVis });
      }
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const v = frame.v;
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, d: frame.d, vis: frame.vis });
      continue;
    }
    if (frame.selectBody) {
      handleSelectBody(v as Node, frame.d, frame.vis);
      continue;
    }
    for (const [key, val] of Object.entries(v as Node)) {
      if (NODE_KEY.test(key) && isPlainObject(val)) {
        const node = val as Node;
        if (key === "SelectStmt") {
          stack.push({ v: node, d: frame.d, vis: frame.vis, selectBody: true });
          continue;
        }
        if (key === "RangeVar") {
          const schema = typeof node.schemaname === "string" ? node.schemaname : null;
          const rel = typeof node.relname === "string" ? node.relname : "";
          c.rangeVars.push([schema, rel, schema === null && frame.vis.has(rel)]);
        } else if (key === "FuncCall") {
          c.funcs.push({ name: funcNameParts(node.funcname), format: String(node.funcformat ?? "") });
        } else if (key === "ParamRef") {
          c.params += 1;
        } else if (OPAQUE_NODES.has(key)) {
          c.opaqueNodes.push(key === "SQLValueFunction" ? `SQLValueFunction:${String(node.op ?? "?")}` : key);
        }
      }
      stack.push({ v: val, d: frame.d, vis: frame.vis });
    }
  }
  return c;
}

function isPlainObject(v: unknown): v is Node {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Node types rejected wholesale. `SQLValueFunction` matters most: `current_date`, `now`'s SQL
 * spellings and `current_user` are NOT FuncCall nodes, so the function allowlist never sees
 * them — a hole the spec's gate table does not name and this walk closes.
 */
const OPAQUE_NODES: ReadonlySet<string> = new Set([
  "SQLValueFunction", "XmlExpr", "XmlSerialize",
]);

/**
 * Gate 4, generically: the only things allowed to appear as a FROM item. An allowlist here means
 * a row-producing grammar this validator has never heard of — `JSON_TABLE` is a PG17 node the
 * PG16.15 server would not even parse, `TABLESAMPLE` and `XMLTABLE` carry their own grammar —
 * is refused by name rather than falling through every gate that looks for RangeVars and
 * FuncCalls.
 */
const ALLOWED_FROM_ITEMS: ReadonlySet<string> = new Set([
  "RangeVar", "RangeSubselect", "JoinExpr", "RangeFunction",
]);

function funcNameParts(funcname: unknown): string[] {
  if (!Array.isArray(funcname)) return ["?"];
  return funcname.map((p) => {
    const s = (p as Node)?.String as Node | undefined;
    return typeof s?.sval === "string" ? s.sval : "?";
  });
}

/** Everything a SelectStmt node itself carries that a gate cares about; returns its CTE names. */
function inspectSelect(node: Node, c: Collected): string[] {
  const names: string[] = [];
  for (const item of collectFromItems(node.fromClause)) {
    if (!ALLOWED_FROM_ITEMS.has(item)) c.badFromItems.push(item);
  }
  if (node.intoClause) c.intoClauses += 1;
  if (Array.isArray(node.lockingClause) && node.lockingClause.length > 0) c.lockingClauses += 1;
  if (typeof node.op === "string" && node.op !== "SETOP_NONE") c.setOps += 1;
  const withClause = node.withClause as Node | undefined;
  if (withClause?.recursive === true) c.recursiveCtes += 1;
  for (const cte of (withClause?.ctes as unknown[]) ?? []) {
    const e = (cte as Node)?.CommonTableExpr as Node | undefined;
    if (!e) continue;
    if (typeof e.ctename === "string") names.push(e.ctename);
    // The CTE's own body: anything but a SelectStmt is a writing CTE. A DELETE here parses as
    // part of exactly ONE SelectStmt, and gate 4 would not catch it — the walk reports the
    // CTE's alias `x` as the relation name, not `laps`.
    const body = e.ctequery as Node | undefined;
    const bodyType = body ? Object.keys(body)[0] : undefined;
    if (bodyType && bodyType !== "SelectStmt") c.writeCtes.push(bodyType);
  }
  if (node.limitCount !== undefined && node.limitCount !== null) {
    c.limits.push(constInt(node.limitCount));
  }
  return names;
}

/** Every FROM item's node type, descending through JoinExpr arms (which are FROM items too). */
function collectFromItems(fromClause: unknown): string[] {
  const types: string[] = [];
  const stack: unknown[] = Array.isArray(fromClause) ? [...fromClause] : [];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!isPlainObject(item)) continue;
    const type = Object.keys(item)[0];
    if (!type) continue;
    types.push(type);
    if (type === "JoinExpr") {
      const join = item[type] as Node;
      stack.push(join.larg, join.rarg);
    }
  }
  return types;
}

/** An integer constant's value, or null when the node is anything else (fail closed). */
function constInt(node: unknown): number | null {
  const constNode = (node as Node)?.A_Const as Node | undefined;
  if (!constNode) return null;
  const ival = constNode.ival as Node | undefined;
  if (ival === undefined) return null;
  const n = ival.ival;
  if (n === undefined) return 0; // `{"ival":{}}` is how the parser spells the integer 0
  return typeof n === "number" ? n : null;
}

// --- gates 1-6 --------------------------------------------------------------

type GateOptions = {
  /** Re-validating the wrapped text: `pg_column_size` is permitted and the wrap's own
   *  subselect is allowed one extra level of SELECT nesting and its own characters. */
  wrapped: boolean;
};

type GateResult = { collected: Collected; relations: string[]; functions: string[] };

function fail(n: GateNumber, gate: string, message: string, sql: string): never {
  throw new AskValidationError(n, gate, message, sql);
}

/** Characters the wrap itself contributes, so gate 6 measures the model's SQL, not our wrap. */
const WRAP_OVERHEAD = wrapCandidate("").length;

function runGates(sql: string, opts: GateOptions, tree: unknown): GateResult {
  const stmts = (tree as { stmts?: unknown[] })?.stmts;

  // Gate 1 — exactly one statement, from the parser and never from a `;` count.
  // `SELECT 1 -- ; DROP TABLE laps` is correctly n=1 with an inert comment, and a `;` inside a
  // string literal correctly does not split.
  if (!Array.isArray(stmts)) fail("0", "parse:shape", "the parser returned no statement list", sql);
  if (stmts.length !== 1) {
    fail("1", `stmts:${stmts.length}`,
      stmts.length === 0
        ? "that was not a SQL statement"
        : `that is ${stmts.length} statements; this feature runs exactly one SELECT`, sql);
  }

  // Gate 2 — it is a SelectStmt, and anything else is rejected BY NAME.
  const stmt = (stmts[0] as { stmt?: Node })?.stmt;
  const stmtType = stmt ? Object.keys(stmt)[0] : undefined;
  if (!stmt || !stmtType) fail("0", "parse:shape", "the parser returned an empty statement", sql);
  if (stmtType !== "SelectStmt") {
    fail("2", `stmt:${stmtType}`, `only a SELECT may run here; that is a ${stmtType}`, sql);
  }

  const c = collect(stmt);

  // Gate 3 — no write, no lock, no table creation ANYWHERE in the tree.
  if (c.writeCtes.length > 0) {
    fail("3", `writeCTE:${c.writeCtes[0]}`,
      `there is a ${c.writeCtes[0]} inside a WITH clause; this connection may only read`, sql);
  }
  if (c.intoClauses > 0) {
    fail("3", "intoClause", "SELECT ... INTO creates a table, and this connection may only read", sql);
  }
  if (c.lockingClauses > 0) {
    fail("3", "lockingClause", "FOR UPDATE / FOR SHARE needs a writable transaction", sql);
  }

  // Gate 4 — relation allowlist over EVERY RangeVar, CTE aliases subtracted.
  if (c.badFromItems.length > 0) {
    fail("4", `from:${c.badFromItems[0]}`,
      `a ${c.badFromItems[0]} is not something this feature can read from`, sql);
  }
  const relations = new Set<string>();
  for (const [schema, rel, boundByWith] of c.rangeVars) {
    if (boundByWith) continue;
    if (opts.wrapped && schema === null && rel === "ask_result") continue;
    if (schema !== null && schema !== "ask") {
      fail("4", `relation:${schema}.${rel}`,
        `${schema}.${rel} is not readable here; every table this feature can read lives in the ask schema`, sql);
    }
    const key = `ask.${rel}`;
    if (!ASK_OBJECTS.has(key)) {
      fail("4", `relation:${rel}`,
        `${rel} is not one of the ${ASK_OBJECTS.size} views this feature can read`, sql);
    }
    relations.add(key);
  }

  // Gate 5 — function allowlist, never a denylist. `funcformat` is set by the PARSER, not by the
  // text, so a `pg_catalog.`-qualified name is only accepted when the parser itself produced it
  // for a SQL-syntax form (EXTRACT/SUBSTRING/TRIM/POSITION). An explicit `pg_catalog.count(*)`
  // carries COERCE_EXPLICIT_CALL and is rejected, exactly as §1.3 requires.
  const functions = new Set<string>();
  for (const f of c.funcs) {
    const written = f.name.join(".");
    const bare = f.name[f.name.length - 1];
    const sqlSyntax = f.format === "COERCE_SQL_SYNTAX" && f.name.length === 2 && f.name[0] === "pg_catalog";
    if (f.name.length > 1 && !sqlSyntax) {
      fail("5", `function:${written}`,
        `${written} is not on the list of functions this feature allows`, sql);
    }
    if (EXCLUDED_FUNCTIONS.has(bare)) {
      fail("5b", `function:${bare}`,
        `${bare}() is excluded on purpose: it can build a result far larger, slower or less repeatable than any honest answer needs`, sql);
    }
    if (opts.wrapped && bare === WRAP_FUNCTION) {
      functions.add(bare);
      continue;
    }
    if (!ALLOWED_FUNCTIONS.has(bare)) {
      fail("5", `function:${bare}`, `${bare}() is not on the list of functions this feature allows`, sql);
    }
    functions.add(bare);
  }
  // Non-FuncCall nodes that would otherwise slip past the function allowlist entirely:
  // current_date / current_user / localtimestamp parse as SQLValueFunction, and XMLTABLE and
  // TABLESAMPLE carry their own grammar. Fail closed on all of them.
  if (c.opaqueNodes.length > 0) {
    fail("5", `node:${c.opaqueNodes[0]}`,
      `${c.opaqueNodes[0]} is not allowed here; this feature answers from stored rows only`, sql);
  }

  // Gate 6 — shape limits.
  const charLimit = MAX_SQL_CHARS + (opts.wrapped ? WRAP_OVERHEAD : 0);
  if (sql.length > charLimit) {
    fail("6", "shape:chars", `that query is ${sql.length} characters, over the ${MAX_SQL_CHARS} limit`, sql);
  }
  if (c.rangeVars.length > MAX_RELATION_REFS) {
    fail("6", "shape:relations",
      `that query names ${c.rangeVars.length} tables, over the ${MAX_RELATION_REFS} limit`, sql);
  }
  const depthLimit = MAX_PARSE_DEPTH + (opts.wrapped ? 1 : 0);
  if (c.maxSelectDepth > depthLimit) {
    fail("6", "shape:depth",
      `that query nests SELECTs ${c.maxSelectDepth} deep, over the ${MAX_PARSE_DEPTH} limit`, sql);
  }
  if (c.params > 0) {
    fail("6", "shape:param", "a parameter placeholder like $1 has no value to bind here", sql);
  }
  // WITH RECURSIVE is the same class of hazard as generate_series (gate 5b): an opaque bound
  // that plans cheaply and then burns the whole statement timeout. None of the ten worked
  // examples needs it and no fan question does, so it is refused rather than estimated.
  if (c.recursiveCtes > 0) {
    fail("6", "shape:recursive",
      "WITH RECURSIVE can generate rows without a bound the planner can see; this feature answers from stored rows", sql);
  }
  if (c.setOps > MAX_SET_OPS) {
    fail("6", "shape:setops",
      `that query uses ${c.setOps} set operations, over the ${MAX_SET_OPS} limit`, sql);
  }
  // The wrap contributes its own `LIMIT 501`, which is the row cap itself, so re-validation
  // allows exactly that one value higher than the model is allowed to ask for.
  const limitCap = opts.wrapped ? WRAP_LIMIT : MAX_INNER_LIMIT;
  for (const lim of c.limits) {
    if (lim === null) {
      fail("6", "shape:limit", "LIMIT has to be a plain number here", sql);
    }
    if (lim > limitCap) {
      fail("6", "shape:limit", `LIMIT ${lim} is over the ${MAX_INNER_LIMIT}-row cap`, sql);
    }
  }

  return { collected: c, relations: [...relations].sort(), functions: [...functions].sort() };
}

// --- the public entry point -------------------------------------------------

/** Parse, or fail closed. A parse error is a rejection, never an exception that escapes. */
async function parseOrFail(sql: string): Promise<unknown> {
  try {
    return await parse(sql);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AskValidationError("0", "parse:error", `that is not valid SQL: ${detail}`, sql);
  }
}

/**
 * Gates 1-7 of §1.3. Resolves with the wrapped string `executeAsk` runs, or rejects with an
 * `AskValidationError` naming the gate that fired. Nothing here touches the network or the
 * database: the whole pass is ~10-20 ms of parsing and tree-walking.
 *
 * The model's text is never rewritten — rewriting attacker-controlled text is how bugs get
 * introduced. It is wrapped by pure string composition (§1.4), and the WRAPPED text is then
 * re-parsed and re-run through gates 1-6, because the string that actually reaches Postgres is
 * the one that has to be proved safe.
 */
export async function validateAskSql(candidate: string): Promise<ValidatedAsk> {
  const raw = candidate.trim();
  if (raw.length === 0) {
    throw new AskValidationError("1", "stmts:0", "that was not a SQL statement", candidate);
  }
  // Gate 6's character cap is checked before parsing too: a multi-megabyte candidate should not
  // reach the WASM parser at all.
  if (raw.length > MAX_SQL_CHARS) {
    throw new AskValidationError("6", "shape:chars",
      `that query is ${raw.length} characters, over the ${MAX_SQL_CHARS} limit`, candidate);
  }

  const tree = await parseOrFail(raw);
  const first = runGates(raw, { wrapped: false }, tree);

  // Gate 7 — the wrap, re-parsed and re-validated.
  const final = wrapCandidate(raw);
  const wrappedTree = await parseOrFail(final).catch((err: unknown) => {
    // A candidate that is legal alone but illegal inside a subselect dies here. Measured:
    // `select 1; drop table laps`, a bare SET, a COPY and a top-level writing CTE are all
    // syntax errors once wrapped.
    const inner = err instanceof AskValidationError ? err.message : String(err);
    throw new AskValidationError("7", "wrap:parse", inner, candidate);
  });
  try {
    runGates(final, { wrapped: true }, wrappedTree);
  } catch (err) {
    if (err instanceof AskValidationError) {
      throw new AskValidationError("7", `wrap:${err.gate}`, err.message, candidate);
    }
    throw err;
  }

  return {
    candidate: stripTrailingSemicolon(raw),
    final,
    relations: first.relations,
    functions: first.functions,
    depth: first.collected.maxSelectDepth,
    relationRefs: first.collected.rangeVars.length,
  };
}
