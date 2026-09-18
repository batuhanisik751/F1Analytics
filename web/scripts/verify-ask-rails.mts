// MODE3_SPEC §0 / §1.5 — THE FOUR RAILS THAT WERE EMPIRICALLY BROKEN DURING DESIGN.
//
// `make db-ask-verify` proves the GRANT. This proves the other half: that the four things the
// spec says are NOT boundaries are still not boundaries, and that the things standing in for
// them actually hold when driven through the real module rather than through psql.
//
// It runs against the live container as the real `f1_ask` role and writes nothing.
//   make verify-ask-rails      (needs ASK_DATABASE_URL)
import pg from "pg";
import { validateAskSql, AskValidationError } from "@/lib/ask/validate";
import { executeAsk, AskExecutionError } from "@/lib/ask/execute";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dsn = process.env.ASK_DATABASE_URL;
if (!dsn) {
  console.error("ASK_DATABASE_URL is not set; see docs/RUNBOOK.md §8.1");
  process.exit(3);
}

/** A raw connection as f1_ask, deliberately bypassing every module rail. */
async function raw<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: dsn, application_name: "wp10-rails" });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/** Validation must reject; returns the gate it fired, or null if it wrongly accepted. */
async function gateFor(sql: string): Promise<string | null> {
  try {
    await validateAskSql(sql);
    return null;
  } catch (e) {
    return e instanceof AskValidationError ? `${e.gateNumber}|${e.gate}` : `threw:${String(e)}`;
  }
}

async function main(): Promise<void> {
  // --- RAIL 1: BEGIN READ WRITE escapes default_transaction_read_only ---------------------
  console.log("\nrail 1 — read-only transaction mode is NOT the boundary; the GRANT is");

  const rw = await raw(async (c) => {
    const before = (await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    await c.query("BEGIN READ WRITE");
    const inside = (await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    let write: string;
    try {
      await c.query("CREATE TABLE public.wp10_probe(i int)");
      write = "SUCCEEDED — THE GRANT IS NOT HOLDING";
    } catch (e) {
      write = (e as Error).message;
    }
    await c.query("ROLLBACK").catch(() => {});
    return { before, inside, write };
  });
  check("default_transaction_read_only is on by default", rw.before === "on");
  check("BEGIN READ WRITE really does escape it", rw.inside === "off", `now ${rw.inside}`);
  check(
    "…and the write STILL fails, because the GRANT is the boundary",
    /permission denied/i.test(rw.write),
    rw.write,
  );

  // --- RAIL 2: set_config('statement_timeout','0') persists and poisons a pooled conn -----
  console.log("\nrail 2 — statement_timeout is a USERSET GUC the session can zero");

  const zeroed = await raw(async (c) => {
    const roleDefault = (await c.query("SHOW statement_timeout")).rows[0].statement_timeout;
    await c.query("SELECT set_config('statement_timeout','0',false)");
    const after = (await c.query("SHOW statement_timeout")).rows[0].statement_timeout;
    return { roleDefault, after };
  });
  check("ALTER ROLE gives f1_ask a 4s default", zeroed.roleDefault === "4s", zeroed.roleDefault);
  check(
    "set_config CAN zero it — so the GUC alone is not a rail",
    zeroed.after === "0",
    `became ${zeroed.after}`,
  );

  const setConfigGate = await gateFor("SELECT set_config('statement_timeout','0',false) FROM ask.laps");
  check("gate 5b refuses set_config outright", setConfigGate === "5b|function:set_config",
    setConfigGate ?? "ACCEPTED");
  const multi = await gateFor("SELECT set_config('statement_timeout','0',false); SELECT 1");
  check("…and it cannot arrive as a second statement either", multi !== null, multi ?? "ACCEPTED");
  const bareSet = await gateFor("SET statement_timeout = 0");
  check("…and a bare SET is not a SELECT", bareSet !== null, bareSet ?? "ACCEPTED");

  const t0 = Date.now();
  let slowOutcome = "COMPLETED — NOTHING STOPPED IT";
  try {
    await executeAsk("SELECT pg_sleep(30) AS x");
  } catch (e) {
    slowOutcome = e instanceof AskExecutionError ? e.code : (e as Error).message;
  }
  const elapsed = Date.now() - t0;
  check("a 30s statement is stopped well under 30s by the envelope", elapsed < 12_000,
    `${slowOutcome} after ${elapsed}ms`);

  // --- RAIL 3: node-postgres runs BOTH statements unless `name` is set --------------------
  console.log("\nrail 3 — only a NAMED prepared statement forces the extended protocol");

  const forms: [string, pg.QueryConfig | string][] = [
    ["bare string", "SELECT 1 AS a; SELECT 2 AS a"],
    ["{text}", { text: "SELECT 1 AS a; SELECT 2 AS a" }],
    ["{text,values:[]}", { text: "SELECT 1 AS a; SELECT 2 AS a", values: [] }],
    ["{text,rowMode}", { text: "SELECT 1 AS a; SELECT 2 AS a", rowMode: "array" } as pg.QueryConfig],
  ];
  for (const [label, form] of forms) {
    const got = await raw(async (c) => {
      try {
        // node-postgres returns an ARRAY of results when more than one statement ran under
        // the simple protocol. That array IS the proof: two results means two statements.
        const r = (await c.query(form as string)) as unknown as
          pg.QueryResult | pg.QueryResult[];
        if (Array.isArray(r)) return `ran ${r.length} statements`;
        return `ran 1 statement, rows ${JSON.stringify(r.rows)}`;
      } catch (e) {
        return `raised: ${(e as Error).message}`;
      }
    });
    // Expected to RUN BOTH — that is the point: the unnamed forms are not a rail.
    check(`${label} runs BOTH statements (the rail is needed)`, got === "ran 2 statements", got);
  }
  const named = await raw(async (c) => {
    try {
      await c.query({ name: "wp10_multi", text: "SELECT 1 AS a; SELECT 2 AS a", values: [] });
      return "SUCCEEDED — THE RAIL IS NOT HOLDING";
    } catch (e) {
      return (e as Error).message;
    }
  });
  check("{name,text,values} raises `cannot insert multiple commands`",
    /cannot insert multiple commands/i.test(named), named);

  // And the REAL code path only ever uses the named form.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../lib/ask/execute.ts", import.meta.url), "utf8"));
  const queryCalls = [...src.matchAll(/client\.query\(\s*\{/g)].length;
  const namedCalls = [...src.matchAll(/name:\s*`ask_[ex]_/g)].length;
  check("every object-form query in execute.ts is a NAMED prepare",
    namedCalls >= 2 && namedCalls === queryCalls, `${namedCalls} named / ${queryCalls} object-form`);
  const multiThroughExecute = await executeAsk("SELECT 1 AS a; SELECT 2 AS a")
    .then(() => "SUCCEEDED — THE RAIL IS NOT HOLDING")
    .catch((e) => (e instanceof AskExecutionError ? `${e.code}: ${e.message}` : String(e)));
  check("…so a multi-statement string cannot execute through executeAsk",
    /cannot insert multiple commands|sql|exec/i.test(multiThroughExecute), multiThroughExecute);

  // --- RAIL 4: a DELETE-CTE parses as exactly ONE SelectStmt -----------------------------
  console.log("\nrail 4 — \"is it a single SELECT\" is not a safety property");

  const deleteCte = "WITH x AS (DELETE FROM laps RETURNING *) SELECT * FROM x";
  const dGate = await gateFor(deleteCte);
  check("the DELETE-CTE is rejected by the validator", dGate !== null, dGate ?? "ACCEPTED");
  check("…and it is rejected AS A WRITING CTE, not by accident",
    (dGate ?? "").includes("writeCTE"), dGate ?? "ACCEPTED");
  for (const [label, sql] of [
    ["UPDATE-CTE", "WITH x AS (UPDATE laps SET lap_number = 1 RETURNING *) SELECT * FROM x"],
    ["INSERT-CTE", "WITH x AS (INSERT INTO laps DEFAULT VALUES RETURNING *) SELECT * FROM x"],
  ] as const) {
    const g = await gateFor(sql);
    check(`${label} is rejected too`, (g ?? "").includes("writeCTE"), g ?? "ACCEPTED");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("RAILS BROKEN — do not deploy.");
    process.exit(1);
  }
  process.exit(0);
}

await main();
