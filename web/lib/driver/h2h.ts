// H2H_SPEC §2/§3/§5 — the pure half of the head-to-head section. No database, no copy:
// `tallyLedger` counts over rows the query layer returns, `modelCall`/`ledgerCall` turn a
// stored contrast or a ledger into a verdict key the captions module renders.
//
// Every comparison here is an ordering (`<`), never a subtraction: no `gapPct` difference
// and no `ratingPp` difference exists anywhere in this file or on the types it exports.
import type { ContrastRow } from "@/lib/queries/mode2";

/** One race both drivers started, with the round's Q session and pace rows LEFT-joined (nulls kept). */
export type LedgerRow = {
  round: number;
  qA: number | null;
  qB: number | null;
  /** Raw `results.classified_position` strings: `'3'`, `'R'`, `'W'`, `'D'`, ... */
  finA: string;
  finB: string;
  paceA: number | null;
  paceB: number | null;
  ptsA: number;
  ptsB: number;
};

/** Counts only. Each row has its OWN denominator (`counted`), never `shared`; ties are not counted. */
export type Ledger = {
  shared: number;
  quali: { counted: number; aWins: number };
  finish: { counted: number; aWins: number; unclassifiedAny: number };
  pace: { counted: number; aWins: number };
  points: { a: number; b: number };
};

const CLASSIFIED = /^\d+$/;

export function tallyLedger(rows: LedgerRow[]): Ledger {
  const ledger: Ledger = {
    shared: rows.length,
    quali: { counted: 0, aWins: 0 },
    finish: { counted: 0, aWins: 0, unclassifiedAny: 0 },
    pace: { counted: 0, aWins: 0 },
    points: { a: 0, b: 0 },
  };
  // A row is counted only when both values exist AND one is strictly ahead: a tie
  // is neither a win nor a loss, so it leaves the denominator too (§2, §7 r5).
  for (const r of rows) {
    if (r.qA !== null && r.qB !== null && r.qA !== r.qB) {
      ledger.quali.counted += 1;
      if (r.qA < r.qB) ledger.quali.aWins += 1;
    }
    if (CLASSIFIED.test(r.finA) && CLASSIFIED.test(r.finB)) {
      if (r.finA !== r.finB) {
        ledger.finish.counted += 1;
        if (Number(r.finA) < Number(r.finB)) ledger.finish.aWins += 1;
      }
    } else {
      ledger.finish.unclassifiedAny += 1;
    }
    if (r.paceA !== null && r.paceB !== null && r.paceA !== r.paceB) {
      ledger.pace.counted += 1;
      if (r.paceA < r.paceB) ledger.pace.aWins += 1;
    }
    ledger.points.a += r.ptsA;
    ledger.points.b += r.ptsB;
  }
  return ledger;
}

/** Why the car-removed view cannot be called; the captions module owns the sentence for each. */
export type NoCallReason = "no-row" | "assumed" | "zero";

export type ModelCall = { kind: "leader"; leaderIsA: boolean } | { kind: "nocall"; reason: NoCallReason };

/** §3: `contrast` is already oriented A−B (negative = A faster). */
export function modelCall(contrast: ContrastRow | null): ModelCall {
  if (!contrast) return { kind: "nocall", reason: "no-row" };
  if (!contrast.sameComponent) return { kind: "nocall", reason: "assumed" };
  if (contrast.deltaLo < 0 && 0 < contrast.deltaHi) return { kind: "nocall", reason: "zero" };
  return { kind: "leader", leaderIsA: contrast.deltaPp < 0 };
}

export type LedgerCall = { kind: "leader"; leaderIsA: boolean } | { kind: "level" };

/** §3: the sign of the pace majority; nothing counted or a tie → level. */
export function ledgerCall(ledger: Ledger): LedgerCall {
  const { counted, aWins } = ledger.pace;
  const bWins = counted - aWins;
  if (counted === 0 || aWins === bWins) return { kind: "level" };
  return { kind: "leader", leaderIsA: aWins > bWins };
}
