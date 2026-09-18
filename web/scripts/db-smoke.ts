// Smoke test for the database connection. Run with `npm run db:smoke` (tsx).
// Opens the pool, runs SELECT 1, prints row counts of a few tables, exits 0.
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client";

async function main(): Promise<void> {
  const one = await db.execute(sql`select 1 as ok`);
  console.log("select 1 ->", one.rows[0]);

  for (const table of ["sessions", "laps", "pace_ranking"]) {
    const res = await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)}`,
    );
    console.log(`${table.padEnd(14)} ${String(res.rows[0]?.n ?? 0)} rows`);
  }

  const mig = await db.execute(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  console.log(`migrations     ${String(mig.rows[0]?.n ?? 0)} applied`);
}

main()
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    console.error("db:smoke failed:", err);
    await pool.end();
    process.exit(1);
  });
