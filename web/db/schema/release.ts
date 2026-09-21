// OPS_SPEC §3.4 / §6.4: one row per successful nightly push to production.
//
// The root layout renders "Data as of <pushed_at>" from the newest row. The nightly
// push (scripts/push_remote.py) inserts one row inside the same transaction that moves
// the session data, so the footer can never be ahead of, or behind, the rows it describes.
//
// There is deliberately NO source_host column (§4.3): the laptop's hostname never leaves
// the laptop. ingest_runs.hostname stays local for the same reason.
import { bigint, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const dataRelease = pgTable("data_release", {
  releaseId: serial("release_id").primaryKey(),
  pushedAt: timestamp("pushed_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  // How many session-keyed sessions this push replaced remotely (0 on a whole-table-only push).
  sessionsPushed: integer("sessions_pushed").notNull().default(0),
  // Rows copied across all tables in this push.
  rowsPushed: bigint("rows_pushed", { mode: "number" }).notNull().default(0),
  // sha256 of the per-session census the push verified against (§3.2 step 5).
  censusSha256: text("census_sha256").notNull(),
});
