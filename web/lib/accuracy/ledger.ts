// LEDGER_SPEC §4 — the pure arithmetic behind the preview ledger on /accuracy. No database:
// the query layer (lib/queries/ledger.ts) only fetches rows, so every convention here — the
// strictly-before rule, average ranks for ties, coverage over classified drivers only — is
// pinned by ledger.test.ts to the values the spec states.

/** One driver of one snapshot, joined to the race result (null when there is none). */
export type LedgerDriver = {
  driverId: string;
  code: string;
  expectedPosition: number;
  posP10: number;
  posP90: number;
  /** `classified_position` parsed, or null for D/R/W and for a driver with no result row. */
  actual: number | null;
};

/** `classified_position` is text; only an all-digit value is a classified finish. */
export const CLASSIFIED = /^[0-9]+$/;
export const parseClassified = (v: string | null | undefined): number | null =>
  v !== null && v !== undefined && CLASSIFIED.test(v) ? Number(v) : null;

/**
 * The scored snapshot of a round: the greatest `computedAt` STRICTLY before the race session's
 * `startUtc`. A snapshot at or after the start is never scored; no start (no session row) →
 * nothing is scored. Both are ISO/pg timestamp strings; compared as instants.
 */
export function scoredSnapshot<T extends { computedAt: string }>(
  snapshots: readonly T[],
  startUtc: string | null | undefined,
): T | null {
  if (!startUtc) return null;
  const start = new Date(startUtc).getTime();
  if (Number.isNaN(start)) return null;
  let best: T | null = null;
  for (const s of snapshots) {
    const t = new Date(s.computedAt).getTime();
    if (Number.isNaN(t) || t >= start) continue;
    if (best === null || t > new Date(best.computedAt).getTime()) best = s;
  }
  return best;
}

/** Ranks 1..n with tied values sharing their average rank. */
function averageRanks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let k = 0;
  while (k < order.length) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]!.v === order[k]!.v) j += 1;
    const rank = (k + j) / 2 + 1;
    for (let m = k; m <= j; m += 1) ranks[order[m]!.i] = rank;
    k = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation with average ranks for ties; null when n < 2 or a side is constant. */
export function spearman(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 2) return null;
  const a = averageRanks(pairs.map((p) => p[0]));
  const b = averageRanks(pairs.map((p) => p[1]));
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

export type Coverage = {
  /** Share (0–1) of classified drivers whose finish sat inside p10–p90, inclusive; null when none. */
  share: number | null;
  held: number;
  classified: number;
  notClassified: number;
};

/** The cAcc9 convention: scored over classified drivers only, and says how many were not. */
export function coverage(rows: readonly LedgerDriver[]): Coverage {
  let held = 0;
  let classified = 0;
  for (const r of rows) {
    if (r.actual === null) continue;
    classified += 1;
    if (r.posP10 <= r.actual && r.actual <= r.posP90) held += 1;
  }
  return {
    share: classified === 0 ? null : held / classified,
    held,
    classified,
    notClassified: rows.length - classified,
  };
}

/** Rank agreement of the snapshot's expected order with the classified finish. */
export function rankAgreement(rows: readonly LedgerDriver[]): number | null {
  const pairs: [number, number][] = [];
  for (const r of rows) if (r.actual !== null) pairs.push([r.expectedPosition, r.actual]);
  return spearman(pairs);
}

/**
 * The first three drivers of the snapshot's expected order (ties broken by driver id so the
 * order is stable), or, `by = "actual"`, the drivers classified 1–3 in finishing order.
 */
export function topThree(rows: readonly LedgerDriver[], by: "expected" | "actual" = "expected"): LedgerDriver[] {
  if (by === "actual") {
    return rows
      .filter((r) => r.actual !== null && r.actual <= 3)
      .sort((a, b) => (a.actual as number) - (b.actual as number));
  }
  return [...rows]
    .sort((a, b) => a.expectedPosition - b.expectedPosition || a.driverId.localeCompare(b.driverId))
    .slice(0, 3);
}
