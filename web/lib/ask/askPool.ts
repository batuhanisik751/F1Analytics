// MODE3_SPEC §1.1, §1.5 — the pool that runs model-generated SQL, and nothing else.
//
// Role `f1_ask`: no grant at all in schema public, SELECT on the 61 generated views of schema
// `ask`, CONNECTION LIMIT 4. `max: 2` here so the feature cannot starve the app's own pool and
// cannot open more than four sessions even if the route leaks.
//
// THE ONLY FILE THAT MAY IMPORT THIS IS lib/ask/execute.ts (CI-enforced, §9 WP-7).
import { Client, Pool, type PoolClient } from "pg";

const ASK_DSN = process.env.ASK_DATABASE_URL;

const g = globalThis as unknown as {
  __f1AskPool?: Pool;
  __f1AskAssertion?: Promise<AskIdentity>;
  __f1AskRelations?: Promise<ReadonlySet<string>>;
};

/**
 * `ASK_DATABASE_URL` has no fallback on purpose. `db/client.ts` may default to the local f1 DSN
 * because it is the superuser pool either way; defaulting HERE would silently run generated SQL
 * as `f1`, which is the worst provisioning mistake available in this project.
 */
export const askPool: Pool =
  g.__f1AskPool ??
  (g.__f1AskPool = new Pool({
    connectionString: ASK_DSN,
    max: 2,
    // A question that cannot get a connection inside 3 s is a queue, not an answer.
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    application_name: "f1-ask",
  }));

export type AskIdentity = {
  user: string;
  isSuperuser: boolean;
  hasPublicUsage: boolean;
  hasLapsSelect: boolean;
};

export class AskPoolMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskPoolMisconfigured";
  }
}

/**
 * §1.1 — the assertion at first checkout. The route REFUSES TO SERVE if it fails: it is the
 * single check that catches a half-finished deployment leaving ASK_DATABASE_URL pointed at the
 * SUPERUSER `f1`. Memoised on success; a failure is not cached, so fixing the environment and
 * retrying works without a restart.
 *
 * Measured quirk: `has_table_privilege(current_user,'public.laps','SELECT')` does not return
 * false for `f1_ask` — it RAISES `permission denied for schema public`, because the name cannot
 * be resolved without USAGE. The raise is therefore a pass, and only a literal `true` is a
 * failure. The unconditional half of the check is the grant count, which cannot raise.
 */
export async function assertAskIdentity(): Promise<AskIdentity> {
  if (g.__f1AskAssertion) return g.__f1AskAssertion;
  const p = runAssertion().catch((e) => {
    g.__f1AskAssertion = undefined;
    throw e;
  });
  g.__f1AskAssertion = p;
  return p;
}

async function runAssertion(): Promise<AskIdentity> {
  if (!ASK_DSN) {
    throw new AskPoolMisconfigured(
      "ASK_DATABASE_URL is not set. The ask box runs generated SQL as the unprivileged role f1_ask and has no fallback; see docs/RUNBOOK.md section 8.",
    );
  }
  const client = await askPool.connect();
  try {
    const who = await client.query<{ current_user: string; usesuper: boolean }>(
      "SELECT current_user, usesuper FROM pg_user WHERE usename = current_user",
    );
    const user = who.rows[0]?.current_user ?? "(unknown)";
    const isSuperuser = who.rows[0]?.usesuper === true;

    const usage = await client.query<{ has: boolean }>(
      "SELECT has_schema_privilege(current_user,'public','USAGE') AS has",
    );
    const hasPublicUsage = usage.rows[0]?.has === true;

    let hasLapsSelect = false;
    try {
      const t = await client.query<{ has: boolean }>(
        "SELECT has_table_privilege(current_user,'public.laps','SELECT') AS has",
      );
      hasLapsSelect = t.rows[0]?.has === true;
    } catch {
      // `permission denied for schema public` — the name is not even resolvable. That is the
      // expected answer for a correctly provisioned f1_ask.
      hasLapsSelect = false;
    }

    const grants = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.table_privileges WHERE grantee = current_user AND table_schema = 'public'",
    );
    const publicGrants = Number(grants.rows[0]?.n ?? "1");

    if (user !== "f1_ask" || isSuperuser || hasPublicUsage || hasLapsSelect || publicGrants !== 0) {
      throw new AskPoolMisconfigured(
        `ASK_DATABASE_URL does not point at a correctly provisioned f1_ask: ` +
          `current_user=${user} usesuper=${isSuperuser} public.USAGE=${hasPublicUsage} ` +
          `public.laps.SELECT=${hasLapsSelect} grants_in_public=${publicGrants}. ` +
          `Run \`make db-ask-roles\` then \`make db-ask-verify\`.`,
      );
    }
    return { user, isSuperuser, hasPublicUsage, hasLapsSelect };
  } finally {
    client.release(true);
  }
}

/**
 * §1.6 job 4 — the set of relations a plan is permitted to name. Views expand, and the plan
 * names the underlying `public` tables, which an AST walk over view names structurally cannot
 * see. The set is derived from pg_depend rather than from a hand-kept list, so it is exactly
 * "whatever the generated ask views actually read" and cannot drift from the generator.
 *
 * Memoised for the life of the process. It fails CLOSED: if the query errors, nothing is
 * cached and execute.ts propagates the error rather than running with an empty allowlist.
 */
export async function permittedPlanRelations(): Promise<ReadonlySet<string>> {
  if (g.__f1AskRelations) return g.__f1AskRelations;
  const p = loadPermittedRelations().catch((e) => {
    g.__f1AskRelations = undefined;
    throw e;
  });
  g.__f1AskRelations = p;
  return p;
}

const RELATION_SQL = `
  SELECT DISTINCT c.relname
  FROM pg_depend d
  JOIN pg_rewrite  r  ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
  JOIN pg_class    v  ON v.oid = r.ev_class
  JOIN pg_namespace vn ON vn.oid = v.relnamespace AND vn.nspname = 'ask'
  JOIN pg_class    c  ON c.oid = d.refobjid
  WHERE c.relkind IN ('r','v','m','p','f')
`;

async function loadPermittedRelations(): Promise<ReadonlySet<string>> {
  const client = await askPool.connect();
  try {
    const res = await client.query<{ relname: string }>(RELATION_SQL);
    const set = new Set(res.rows.map((r) => r.relname));
    if (set.size === 0) {
      throw new AskPoolMisconfigured(
        "schema `ask` has no views, or f1_ask cannot see them. Run `make db-ask-views`.",
      );
    }
    return set;
  } finally {
    client.release(true);
  }
}

/**
 * A connection for one question, with its backend pid captured at checkout so §1.7's layer 3
 * can cancel it from the app's own pool. Always released with `release(true)` by the caller.
 */
export async function checkoutAsk(): Promise<{ client: PoolClient; pid: number }> {
  await assertAskIdentity();
  const client = await askPool.connect();
  try {
    const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return { client, pid: r.rows[0].pid };
  } catch (e) {
    client.release(true);
    throw e;
  }
}

/**
 * §1.5's hard stop, on a connection of its own.
 *
 * WP-10 CHANGE, and the reason for it: this used to be `pool.query('SELECT pg_cancel_backend')`
 * on the app's `DATABASE_URL` pool — i.e. as the SUPERUSER `f1` — which made `db/client.ts`
 * reachable from inside `lib/ask/` and broke §9 WP-7's invariant ("db/client.ts is imported
 * inside lib/ask/" fails the build). It is not necessary: MEASURED against the live container,
 * `f1_ask` can cancel its OWN backend from a second connection (`pg_cancel_backend` is
 * permitted within a role), so the hard stop works at the feature's own privilege level and the
 * superuser pool is now unreachable from this module.
 *
 * A one-off Client rather than `askPool`: both pool slots are plausibly busy at exactly the
 * moment a cancel is needed, and waiting for one is the opposite of a hard stop. `f1_ask` has
 * CONNECTION LIMIT 4 against `max: 2`, so the spare capacity is already reserved for this.
 *
 * Failures are logged and swallowed — the request is already being failed, and the statement
 * timeout plus the destroyed socket remain the backstop.
 */
export async function cancelAskBackend(pid: number): Promise<void> {
  const client = new Client({
    connectionString: ASK_DSN,
    connectionTimeoutMillis: 2000,
    application_name: "f1-ask-cancel",
  });
  try {
    await client.connect();
    await client.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch (e) {
    console.error("[ask] hard-stop cancel failed for pid", pid, e instanceof Error ? e.message : e);
  } finally {
    await client.end().catch(() => {});
  }
}
