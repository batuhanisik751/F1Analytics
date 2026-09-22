// web/lib/queries/ledger.ts — LEDGER_SPEC §4: the previews as they stood before each race.
//
// `preview_snapshot_round` / `preview_snapshot_order` are append-only copies of the preview
// tables, one per nightly recompute. Reads only; the arithmetic lives in lib/accuracy/ledger.ts.
// The scored snapshot of a round is the greatest computed_at STRICTLY before the race's
// start_utc; a snapshot computed after the race had started stays on record and is never
// scored. A round is a row of the ledger once results exist for that race session — until
// then it is "on record", and the section says how many are waiting.
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db/client";
import { previewSnapshotOrder, previewSnapshotRound, titleOdds } from "@/db/schema/companion";
import { drivers, events, sessions } from "@/db/schema/reference";
import { results } from "@/db/schema/session";
import { cached } from "@/lib/cache";
import {
  coverage,
  parseClassified,
  rankAgreement,
  scoredSnapshot,
  topThree,
  type LedgerDriver,
} from "@/lib/accuracy/ledger";

export type LedgerPick = { code: string; posP10: number; posP90: number };

export type LedgerRow = {
  year: number;
  round: number;
  eventName: string | null;
  /** The preview's own `computed_at`, never `snapshot_at`. */
  computedAt: string;
  ourTopThree: LedgerPick[];
  actualTopThree: string[];
  spearman: number | null;
  claimedSpearman: number | null;
  /** Share (0–1) of classified drivers whose finish sat inside p10–p90. */
  coverage: number | null;
  claimedCoverage: number | null;
  classified: number;
  notClassified: number;
};

export type PreviewLedger = {
  year: number;
  /** Rows of `preview_snapshot_round` for the season: what "{previews} on record" counts. */
  previews: number;
  /** Rounds with at least one snapshot. */
  roundsOnRecord: number;
  /** Earliest `computed_at` on record, or null when the record is empty. */
  firstComputedAt: string | null;
  rows: LedgerRow[];
};

async function getPreviewLedgerRaw(year: number): Promise<PreviewLedger> {
  const snaps = await db
    .select({
      round: previewSnapshotRound.round,
      computedAt: previewSnapshotRound.computedAt,
      claimedSpearman: previewSnapshotRound.backtestSpearman,
      claimedCoverage: previewSnapshotRound.backtestCoverage,
      sessionId: sessions.sessionId,
      startUtc: sessions.startUtc,
      eventName: events.eventName,
    })
    .from(previewSnapshotRound)
    .leftJoin(sessions, and(eq(sessions.year, previewSnapshotRound.year),
                            eq(sessions.round, previewSnapshotRound.round),
                            eq(sessions.kind, "R")))
    .leftJoin(events, and(eq(events.year, previewSnapshotRound.year),
                          eq(events.round, previewSnapshotRound.round)))
    .where(eq(previewSnapshotRound.year, year))
    .orderBy(asc(previewSnapshotRound.round), asc(previewSnapshotRound.computedAt));
  const empty: PreviewLedger = { year, previews: 0, roundsOnRecord: 0, firstComputedAt: null, rows: [] };
  if (snaps.length === 0) return empty;

  const byRound = new Map<number, typeof snaps>();
  for (const s of snaps) byRound.set(s.round, [...(byRound.get(s.round) ?? []), s]);
  const scored = [...byRound.values()]
    .map((list) => scoredSnapshot(list, list[0]!.startUtc))
    .filter((s): s is NonNullable<typeof s> => s !== null && s.sessionId !== null);
  const firstComputedAt = snaps.reduce<string | null>(
    (m, s) => (m === null || new Date(s.computedAt) < new Date(m) ? s.computedAt : m), null);
  const base = { ...empty, previews: snaps.length, roundsOnRecord: byRound.size, firstComputedAt };
  if (scored.length === 0) return base;
  return { ...base, rows: await scoreRounds(year, scored) };
}
export const getPreviewLedger = cached("ledger.getPreviewLedger", getPreviewLedgerRaw);

type Scored = { round: number; computedAt: string; claimedSpearman: number | null;
                claimedCoverage: number | null; eventName: string | null };

/** The order rows of each scored snapshot, joined to the race result; rounds without results drop out. */
async function scoreRounds(year: number, scored: Scored[]): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      round: previewSnapshotOrder.round,
      computedAt: previewSnapshotOrder.computedAt,
      driverId: previewSnapshotOrder.driverId,
      code: drivers.latestCode,
      expectedPosition: previewSnapshotOrder.expectedPosition,
      posP10: previewSnapshotOrder.posP10,
      posP90: previewSnapshotOrder.posP90,
      classifiedPosition: results.classifiedPosition,
    })
    .from(previewSnapshotOrder)
    .leftJoin(drivers, eq(drivers.driverId, previewSnapshotOrder.driverId))
    .leftJoin(sessions, and(eq(sessions.year, previewSnapshotOrder.year),
                            eq(sessions.round, previewSnapshotOrder.round),
                            eq(sessions.kind, "R")))
    .leftJoin(results, and(eq(results.sessionId, sessions.sessionId),
                           eq(results.driverId, previewSnapshotOrder.driverId)))
    .where(and(eq(previewSnapshotOrder.year, year),
               inArray(previewSnapshotOrder.round, scored.map((s) => s.round)),
               inArray(previewSnapshotOrder.computedAt, scored.map((s) => s.computedAt))))
    .orderBy(asc(previewSnapshotOrder.round), asc(previewSnapshotOrder.expectedPosition));
  const out: LedgerRow[] = [];
  for (const s of scored) {
    const own = rows.filter((r) => r.round === s.round && r.computedAt === s.computedAt);
    if (!own.some((r) => r.classifiedPosition !== null)) continue;
    const ds: LedgerDriver[] = own.map((r) => ({
      driverId: r.driverId,
      code: r.code ?? r.driverId.toUpperCase().slice(0, 3),
      expectedPosition: r.expectedPosition,
      posP10: r.posP10,
      posP90: r.posP90,
      actual: parseClassified(r.classifiedPosition),
    }));
    const cov = coverage(ds);
    out.push({
      year,
      round: s.round,
      eventName: s.eventName,
      computedAt: s.computedAt,
      ourTopThree: topThree(ds).map((d) => ({ code: d.code, posP10: d.posP10, posP90: d.posP90 })),
      actualTopThree: topThree(ds, "actual").map((d) => d.code),
      spearman: rankAgreement(ds),
      claimedSpearman: s.claimedSpearman,
      coverage: cov.share,
      claimedCoverage: s.claimedCoverage,
      classified: cov.classified,
      notClassified: cov.notClassified,
    });
  }
  return out;
}

export type TitleOddsCell = {
  afterRound: number;
  pTitle: number;
  pTitleLo: number;
  pTitleHi: number;
  isShrunkToPrior: boolean;
};

export type TitleOddsDriver = { driverId: string; code: string; cells: TitleOddsCell[] };

export type TitleOddsLine = {
  year: number;
  /** `after_round` 1..N, every round the table holds for the season. */
  rounds: number[];
  /** The five drivers with the highest `p_title` at the latest `after_round`, in that order. */
  drivers: TitleOddsDriver[];
};

/**
 * Title chances after each round for the five drivers leading at the latest round. `title_odds`
 * is rebuilt nightly from the stored results with the current model: a reconstruction, not a
 * record of what was first published (C_LED_4 says so). Null when the season holds no rows.
 */
async function getTitleOddsLineRaw(year: number): Promise<TitleOddsLine | null> {
  const [latest] = await db
    .select({ afterRound: max(titleOdds.afterRound) })
    .from(titleOdds)
    .where(eq(titleOdds.year, year));
  if (!latest || latest.afterRound === null) return null;
  const leaders = await db
    .select({ driverId: titleOdds.driverId })
    .from(titleOdds)
    .where(and(eq(titleOdds.year, year), eq(titleOdds.afterRound, latest.afterRound)))
    .orderBy(desc(titleOdds.pTitle), asc(titleOdds.driverId))
    .limit(5);
  const ids = leaders.map((l) => l.driverId);
  if (ids.length === 0) return null;
  const rows = await db
    .select({
      afterRound: titleOdds.afterRound,
      driverId: titleOdds.driverId,
      code: drivers.latestCode,
      pTitle: titleOdds.pTitle,
      pTitleLo: titleOdds.pTitleLo,
      pTitleHi: titleOdds.pTitleHi,
      isShrunkToPrior: titleOdds.isShrunkToPrior,
    })
    .from(titleOdds)
    .leftJoin(drivers, eq(drivers.driverId, titleOdds.driverId))
    .where(and(eq(titleOdds.year, year), inArray(titleOdds.driverId, ids)))
    .orderBy(asc(titleOdds.afterRound), asc(titleOdds.driverId));
  const rounds = [...new Set(rows.map((r) => r.afterRound))].sort((a, b) => a - b);
  const out: TitleOddsDriver[] = ids.map((driverId) => {
    const own = rows.filter((r) => r.driverId === driverId);
    return {
      driverId,
      code: own[0]?.code ?? driverId.toUpperCase().slice(0, 3),
      cells: own.map(({ afterRound, pTitle, pTitleLo, pTitleHi, isShrunkToPrior }) =>
        ({ afterRound, pTitle, pTitleLo, pTitleHi, isShrunkToPrior })),
    };
  });
  return { year, rounds, drivers: out };
}
export const getTitleOddsLine = cached("ledger.getTitleOddsLine", getTitleOddsLineRaw);
