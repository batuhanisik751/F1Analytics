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
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { events, sessionIngests, sessions } from "@/db/schema";
import { cached } from "@/lib/cache";

export type DataRelease = {
  releaseId: number;
  /** ISO 8601, UTC. A string, not a Date: the cached value round-trips through JSON (REVALIDATE_SPEC §5). */
  pushedAt: string;
  sessionsPushed: number;
  rowsPushed: number;
};

/** The newest `data_release` row, or null when there is none or it cannot be read. */
async function getLatestReleaseRaw(): Promise<DataRelease | null> {
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
      pushedAt: r.pushed_at.toISOString(),
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
export const getLatestRelease = cached("release.getLatestRelease", getLatestReleaseRaw);

/** `Data as of 19 Sep 2026, 03:20 UTC` — fixed format, UTC, so the same row renders the same
 *  string on every machine and the a11y baseline never depends on a locale. */
export function formatPushedAt(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

// IDEAS_2026-09 §1 #6 — the stale-data guard. The nightly job can fail or not run, and then
// the newest round on the site is silently the PREVIOUS one. This asks the only question that
// matters — has the latest past `event_date` got a loaded race session? — once, in the query
// layer, and the footer and the home strip both render its one sentence (lib/home/captions.ts
// C_NOT_LOADED). It says the round raced and is not loaded, never why (OPS §1.3).

export type EventLoadRow = {
  year: number;
  round: number;
  eventName: string;
  /** `YYYY-MM-DD`, as `events.event_date` is stored. */
  eventDate: string;
  /** the round's race session has `session_ingests.status in ('ok','partial')` */
  loaded: boolean;
};

export type StaleRound = Pick<EventLoadRow, "year" | "round" | "eventName" | "eventDate">;

/** Today as `YYYY-MM-DD` in UTC, the clock every date on the site is read against. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Every event with whether its race session is loaded, oldest first. `[]` if unreadable. */
async function getEventLoadRowsRaw(): Promise<EventLoadRow[]> {
  try {
    const rows = await db
      .select({
        year: events.year,
        round: events.round,
        eventName: events.eventName,
        eventDate: events.eventDate,
        status: sessionIngests.status,
      })
      .from(events)
      .leftJoin(
        sessions,
        and(eq(sessions.year, events.year), eq(sessions.round, events.round), eq(sessions.kind, "R")),
      )
      .leftJoin(
        sessionIngests,
        and(
          eq(sessionIngests.sessionId, sessions.sessionId),
          inArray(sessionIngests.status, ["ok", "partial"]),
        ),
      )
      .orderBy(asc(events.eventDate), asc(events.round));
    return rows.map((r) => ({
      year: r.year,
      round: r.round,
      eventName: r.eventName,
      eventDate: r.eventDate,
      loaded: r.status !== null,
    }));
  } catch (err) {
    console.error("release: events unreadable", err instanceof Error ? err.message : err);
    return [];
  }
}
export const getEventLoadRows = cached("release.getEventLoadRows", getEventLoadRowsRaw);

/**
 * Pure: the latest event strictly before `today` when its race session is NOT loaded; null
 * when it is loaded (the normal night) or when nothing has raced yet. Strictly before, so on
 * race day itself the round is still "next", not "missing".
 */
export function staleRoundFrom(rows: EventLoadRow[], today: string): StaleRound | null {
  let latest: EventLoadRow | null = null;
  for (const r of rows) {
    if (r.eventDate >= today) continue;
    if (latest === null || r.eventDate > latest.eventDate || (r.eventDate === latest.eventDate && r.round > latest.round)) {
      latest = r;
    }
  }
  if (latest === null || latest.loaded) return null;
  const { year, round, eventName, eventDate } = latest;
  return { year, round, eventName, eventDate };
}

export async function getStaleRound(today: string = todayUtc()): Promise<StaleRound | null> {
  return staleRoundFrom(await getEventLoadRows(), today);
}
