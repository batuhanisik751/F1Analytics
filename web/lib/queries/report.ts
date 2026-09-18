// MODE3_SPEC §8.1 — getRaceReport(sessionId, asid). A NORMAL READ, nothing more.
//
// The race report is generated in Python at ingest (f1lab/report.py) and stored in
// `race_report` like any other precomputed row. Reading it adds NO runtime inference,
// NO secret and NO fetch to the web app (§0.2): this module imports the same Drizzle
// pool on DATABASE_URL that every other page query uses, and nothing from lib/ask/*.
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { raceReport, sessionIngests } from "@/db/schema";

/** §6.1 status — the CHECK constraint's three values, nothing else. */
export type RaceReportStatus = "ok" | "refused" | "skipped";

/** §6.1 grounding_completeness — how much of the race the bundle could see. */
export type RaceReportCompleteness = "ok" | "partial" | "insufficient";

/**
 * One stored report. Prose is one field per paragraph (§6.1) precisely so that no
 * markdown renderer is needed anywhere near generated text (§8.7) — every field below
 * is rendered as a React text node.
 *
 * `result` is non-null exactly when status === 'ok' (race_report_body_check enforces
 * it in Postgres), so a 'refused' or 'skipped' row carries no prose at all.
 */
export type RaceReportView = {
  sessionId: number;
  assumptionSetId: number;
  status: RaceReportStatus;
  completeness: RaceReportCompleteness;
  /** Paragraph 1: winner, margin, grid slot, decided by pace or by an event. */
  result: string | null;
  /** Paragraph 2: who was actually quickest in clean air. */
  pace: string | null;
  /** Paragraph 3: the decisive stop or stint. */
  strategy: string | null;
  /** Paragraph 4: the largest win-probability move and its lap. */
  swing: string | null;
  /** One sentence, nullable. */
  caveats: string | null;
  /** Human sentences naming what the bundle could not see (§4.2). */
  knownGaps: string[];
  /** §4.6 — why no report exists. Only set when status === 'skipped'. */
  skippedReason: string | null;
  model: string;
  promptVersion: number;
  generatedAt: string;
};

/**
 * The stored report for one session under one assumption set.
 *
 * `assumptionSetId` is optional only as a convenience: when it is omitted the session's
 * own assumption set is taken from `session_ingests`, which is the same set every other
 * section of the race page was computed under. Joining a report written under one
 * assumption set to analytics written under another would describe numbers the page is
 * not showing, so the two are always pinned together.
 *
 * Returns null when no row exists — which is the normal case for most races until a
 * keyed ingest has run. Callers must treat null as "no report", never as an error.
 */
export async function getRaceReport(
  sessionId: number,
  assumptionSetId?: number | null,
): Promise<RaceReportView | null> {
  const asid = assumptionSetId ?? (await resolveAssumptionSetId(sessionId));
  if (asid == null) return null;

  const rows = await db
    .select({
      sessionId: raceReport.sessionId,
      assumptionSetId: raceReport.assumptionSetId,
      status: raceReport.status,
      completeness: raceReport.groundingCompleteness,
      result: raceReport.result,
      pace: raceReport.pace,
      strategy: raceReport.strategy,
      swing: raceReport.swing,
      caveats: raceReport.caveats,
      knownGaps: raceReport.knownGaps,
      skippedReason: raceReport.skippedReason,
      model: raceReport.model,
      promptVersion: raceReport.promptVersion,
      generatedAt: raceReport.generatedAt,
    })
    .from(raceReport)
    .where(
      and(eq(raceReport.sessionId, sessionId), eq(raceReport.assumptionSetId, asid)),
    )
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return {
    sessionId: r.sessionId,
    assumptionSetId: r.assumptionSetId,
    status: asStatus(r.status),
    completeness: asCompleteness(r.completeness),
    result: r.result,
    pace: r.pace,
    strategy: r.strategy,
    swing: r.swing,
    caveats: r.caveats,
    knownGaps: r.knownGaps ?? [],
    skippedReason: r.skippedReason,
    model: r.model,
    promptVersion: r.promptVersion,
    generatedAt: toIso(r.generatedAt),
  };
}

/** The assumption set this session's analytics were computed under, or null. */
async function resolveAssumptionSetId(sessionId: number): Promise<number | null> {
  const rows = await db
    .select({ assumptionSetId: sessionIngests.assumptionSetId })
    .from(sessionIngests)
    .where(eq(sessionIngests.sessionId, sessionId))
    .limit(1);
  return rows[0]?.assumptionSetId ?? null;
}

// `status` and `grounding_completeness` are enforced by a CHECK, not a pg enum, so
// Drizzle hands them back as plain text. Narrowing here keeps the widening out of the
// component; an unrecognised value degrades to the most cautious member rather than
// throwing, because a page must never fail on a report.
function asStatus(v: string): RaceReportStatus {
  return v === "ok" || v === "refused" || v === "skipped" ? v : "skipped";
}

function asCompleteness(v: string): RaceReportCompleteness {
  return v === "ok" || v === "partial" || v === "insufficient" ? v : "insufficient";
}

function toIso(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}
