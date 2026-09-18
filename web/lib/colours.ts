// SPEC §3.1 / §3.5 — colour lookups for charts and chips. Pure functions, no DB
// access, safe to import from 'use client' components.
import { COMPOUND_FALLBACK, TEAM_FALLBACK } from "./theme";

/** Per-session colour maps keyed by teamId / compound (from getRaceColours). */
export type ColourMap = {
  teams: Record<string, string>;
  compounds: Record<string, string>;
};

export type LineStyle = "solid" | "dashed" | "dotted";

/** `colours.teams[teamId] ?? TEAM_FALLBACK` */
export function teamColour(map: ColourMap | null | undefined, teamId: string): string {
  return map?.teams[teamId] ?? TEAM_FALLBACK;
}

/** `colours.compounds[c] ?? COMPOUND_FALLBACK[c] ?? COMPOUND_FALLBACK.UNKNOWN` */
export function compoundColour(map: ColourMap | null | undefined, compound: string): string {
  return (
    map?.compounds[compound] ??
    COMPOUND_FALLBACK[compound] ??
    COMPOUND_FALLBACK.UNKNOWN
  );
}

/** ECharts `lineStyle` fragment for a session_entries.line_style value: `lineStyleFor('dashed')` → `{ type: 'dashed', width: 1.6 }`. */
export function lineStyleFor(style: LineStyle | string | null | undefined): {
  type: LineStyle;
  width: number;
} {
  const type: LineStyle =
    style === "dashed" || style === "dotted" || style === "solid" ? style : "solid";
  return { type, width: 1.6 };
}
