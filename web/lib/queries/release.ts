// OPS_SPEC §3.4 — freshness. The nightly push (scripts/push_remote.py) ends its transaction
// with one row in `data_release`; the root layout's footer reads the newest one so a reader
// can tell "the site has not moved since Sunday" from "the site is broken" without anyone
// tailing a log. One row, one query, on every render; the footer is the only caller.
//
// Raw SQL on the shared pool rather than the Drizzle schema: the table arrives with migration
// 0011 in its own package, and the footer must render on a database that predates it (local
// dev, an old fixture, a fresh Neon project mid-provisioning). A missing table, a role that
// cannot read it, or a dead database all come back as `null` here and as a neutral line on
// the page. It never throws: a footer must not be the reason a race page fails to render.
import { pool } from "@/db/client";

export type DataRelease = {
  releaseId: number;
  pushedAt: Date;
  sessionsPushed: number;
  rowsPushed: number;
};

/** The newest `data_release` row, or null when there is none or it cannot be read. */
export async function getLatestRelease(): Promise<DataRelease | null> {
  try {
    const { rows } = await pool.query<{
      release_id: number;
      pushed_at: Date;
      sessions_pushed: number;
      rows_pushed: number;
    }>(
      "SELECT release_id, pushed_at, sessions_pushed, rows_pushed " +
        "FROM data_release ORDER BY pushed_at DESC, release_id DESC LIMIT 1",
    );
    const r = rows[0];
    if (!r) return null;
    return {
      releaseId: Number(r.release_id),
      pushedAt: r.pushed_at,
      sessionsPushed: Number(r.sessions_pushed),
      rowsPushed: Number(r.rows_pushed),
    };
  } catch (err) {
    // 42P01 is "relation does not exist": expected before migration 0011, so it is quiet.
    // Anything else (connection refused, permission denied) is worth one log line.
    const code = (err as { code?: string }).code;
    if (code !== "42P01") {
      console.error("release: data_release unreadable", err instanceof Error ? err.message : err);
    }
    return null;
  }
}

/** `Data as of 19 Sep 2026, 03:20 UTC` — fixed format, UTC, so the same row renders the same
 *  string on every machine and the a11y baseline never depends on a locale. */
export function formatPushedAt(d: Date): string {
  const day = d.getUTCDate();
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
