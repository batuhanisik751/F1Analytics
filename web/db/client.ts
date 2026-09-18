import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// One pool per process, cached on globalThis so Next's dev-server module
// reloads do not leak connections.
const g = globalThis as unknown as { __f1Pool?: Pool };
export const pool =
  g.__f1Pool ??
  (g.__f1Pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://f1:f1@localhost:5432/f1",
    max: 5,
  }));
export const db = drizzle(pool, { schema });
export type Db = typeof db;
