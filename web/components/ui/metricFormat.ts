// UX_SPEC §3.3 — the vocabulary rules as functions, so no call site re-implements them.
// Kept free of JSX and of next/link on purpose: these are the parts every other work package
// imports, and they must be unit-testable without a React renderer.

/** The lap the "% of a lap -> seconds" conversion is quoted against. Stated on screen, never implied. */
export const REFERENCE_LAP_S = 90;

/** 0.772 (% of a lap) -> 0.69 (s) on a 90-second lap. */
export function ppToSeconds(pp: number, referenceLapS: number = REFERENCE_LAP_S): number {
  return (pp / 100) * referenceLapS;
}

/** "about 0.69 s on a 90-second lap" — §3.3, the seconds equivalent of a share of a lap. */
export function ppSecondsHint(pp: number, referenceLapS: number = REFERENCE_LAP_S): string {
  const s = Math.abs(ppToSeconds(pp, referenceLapS));
  return `about ${s.toFixed(2)} s on a ${referenceLapS}-second lap`;
}

/** §3.3 — two decimals and a gloss a reader can act on. */
export function correlationGloss(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.85) return "they say almost the same thing";
  if (a >= 0.6) return "they mostly agree";
  if (a >= 0.3) return "they agree loosely";
  return "they are close to unrelated";
}

/** "r = 0.77 — they mostly agree" */
export function formatCorrelation(r: number): string {
  return `r = ${r.toFixed(2)} — ${correlationGloss(r)}`;
}

/**
 * §3.3 — a count never appears without its complement explained.
 * usedOf(888, 1054, "safety car, in- and out-laps, and first laps")
 *   -> "888 of 1,054 laps used (84.3 %). 166 excluded: safety car, in- and out-laps, and first laps."
 */
export function usedOf(used: number, total: number, excludedReason: string, noun = "laps"): string {
  const pct = total === 0 ? 0 : (used / total) * 100;
  const excluded = total - used;
  return (
    `${used.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} ${noun} used ` +
    `(${pct.toFixed(1)} %). ${excluded.toLocaleString("en-GB")} excluded: ${excludedReason}.`
  );
}
