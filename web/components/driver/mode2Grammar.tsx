// MODE2_SPEC §8.4 — the shared visual grammar for the Mode 2 driver-page slots.
// Solid = measured; hatched = assumed. A `floating` driver never gets a plain numeral.
import type { AnchorClass, Basis } from "@/lib/queries/mode2";

/** CSS-only 45 degree hatch, matching the hatch the WP6 charts draw in canvas. */
export const HATCH_BACKGROUND =
  "repeating-linear-gradient(45deg, rgba(232,163,61,0.28) 0 2px, transparent 2px 6px)";

export const FLOATING_CHIP_TEXT = "level not measured";
export const ASSUMED_CHIP_TEXT = "assumed, not measured";

/** 1 pp is about 0.9 s on a 90-second lap (§0.4) — always stated, never implied. */
export function ppToSeconds(pp: number): string {
  return `${(pp * 0.9 >= 0 ? "+" : "")}${(pp * 0.9).toFixed(2)} s`;
}

export function formatPp(pp: number): string {
  return `${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(3)} %`;
}

/**
 * UX_SPEC §3.3 — the same number with NO unit glued to it, for call sites that render the
 * unit themselves ("% of a lap", once, beside the value). The one-value-one-unit rule is why
 * this exists: the page used to print this figure as "%" here and "pp" in the skill panel.
 */
export function formatPpValue(pp: number): string {
  return `${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(3)}`;
}

export function isAssumed(basis: Basis): boolean {
  return basis === "by-analogy";
}

export function isFloating(anchorClass: AnchorClass): boolean {
  return anchorClass === "floating";
}

export type ChipProps = { children: React.ReactNode; hatched?: boolean; className?: string };

/** The chip that REPLACES a headline numeral for an unmeasured level (§8.4.2). */
export function GrammarChip({ children, hatched, className }: ChipProps): React.JSX.Element {
  return (
    <span
      data-hatched={hatched ? "true" : "false"}
      style={hatched ? { backgroundImage: HATCH_BACKGROUND } : undefined}
      className={`inline-flex items-center gap-1 rounded border border-dashed border-accent/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent ${className ?? ""}`}
    >
      {hatched ? <span aria-hidden="true">{"○"}</span> : null}
      {children}
    </span>
  );
}
