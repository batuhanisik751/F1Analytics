// web/lib/queries/preview.ts — MODE1_SPEC §3 / §7.1–7.2. Weekend preview reads.
// Reads preview_round, preview_finish_order and circuit_odi; computes nothing.
// Every function returns null or [] on missing input and never throws.
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  circuitOdi,
  circuits,
  drivers,
  events,
  previewFinishOrder,
  previewRound as previewRoundTable,
  sessionEntries,
  sessionTeams,
  sessions,
} from "@/db/schema";
import { TEAM_FALLBACK } from "@/lib/theme";
import type { DriverRef, LineStyle } from "@/lib/queries/shared";
import { cached } from "@/lib/cache";

export type CircuitMatch = "native" | "location" | "alias" | "none";

export type PreviewRound = {
  year: number;
  round: number;
  eventName: string;
  location: string;
  circuitKey: number | null;
  circuitShortName: string | null;
  circuitMatch: CircuitMatch;
  circuitRaces: number;
  pSafetyCar: number | null;
  pVsc: number | null;
  expectedPitLossS: number | null;
  pitLossBandS: number | null;
  odi: number | null;
  odiLo: number | null;
  odiHi: number | null;
  backtestSpearman: number | null;
  backtestGridSpearman: number | null;
  backtestCoverage: number | null;
  backtestRaces: number | null;
  locoBrier: number | null;
};

export type PreviewOrderRow = DriverRef & {
  expectedPosition: number;
  posP10: number;
  posP90: number;
  pWin: number;
  pPodium: number;
  pPoints: number;
};

export type OdiTick = { circuitKey: number; shortName: string; odi: number };

function asLineStyle(v: string | null | undefined): LineStyle {
  return v === "dashed" || v === "dotted" ? v : "solid";
}

function asCircuitMatch(v: string | null | undefined): CircuitMatch {
  return v === "native" || v === "location" || v === "alias" ? v : "none";
}

/**
 * §7.2 — the preview row for one round, joined to its event (name, location) and,
 * when the circuit resolved, to `circuits.short_name`. `null` when the round has no
 * `preview_round` row (the preview has not been recomputed for it yet).
 */
async function getPreviewRoundRaw(
  year: number,
  round: number,
): Promise<PreviewRound | null> {
  const rows = await db
    .select({
      row: previewRoundTable,
      eventName: events.eventName,
      location: events.location,
      circuitShortName: circuits.shortName,
    })
    .from(previewRoundTable)
    .innerJoin(
      events,
      and(eq(events.year, previewRoundTable.year), eq(events.round, previewRoundTable.round)),
    )
    .leftJoin(circuits, eq(circuits.circuitKey, previewRoundTable.circuitKey))
    .where(and(eq(previewRoundTable.year, year), eq(previewRoundTable.round, round)))
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  const r = hit.row;
  return {
    year: r.year,
    round: r.round,
    eventName: hit.eventName,
    location: hit.location,
    circuitKey: r.circuitKey ?? null,
    circuitShortName: hit.circuitShortName ?? null,
    circuitMatch: asCircuitMatch(r.circuitMatch),
    circuitRaces: r.circuitRaces ?? 0,
    pSafetyCar: r.pSafetyCar ?? null,
    pVsc: r.pVsc ?? null,
    expectedPitLossS: r.expectedPitLossS ?? null,
    pitLossBandS: r.pitLossBandS ?? null,
    odi: r.odi ?? null,
    odiLo: r.odiLo ?? null,
    odiHi: r.odiHi ?? null,
    backtestSpearman: r.backtestSpearman ?? null,
    backtestGridSpearman: r.backtestGridSpearman ?? null,
    backtestCoverage: r.backtestCoverage ?? null,
    backtestRaces: r.backtestRaces ?? null,
    locoBrier: r.locoBrier ?? null,
  };
}
export const getPreviewRound = cached("preview.getPreviewRound", getPreviewRoundRaw);

/**
 * The most recent `session_entries` row of the season for each driver, as a DriverRef.
 * A scheduled round has no entries of its own, so the driver's identity and team colour
 * come from the latest session of the same season they actually appeared in.
 */
async function loadSeasonDriverRefs(year: number): Promise<Map<string, DriverRef>> {
  const rows = await db
    .selectDistinctOn([sessionEntries.driverId], {
      driverId: sessionEntries.driverId,
      code: sessionEntries.code,
      fullName: drivers.fullName,
      lineStyle: sessionEntries.lineStyle,
      teamId: sessionTeams.teamId,
      teamName: sessionTeams.teamName,
      teamColour: sessionTeams.colour,
    })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.sessionId, sessionEntries.sessionId))
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .where(eq(sessions.year, year))
    .orderBy(sessionEntries.driverId, desc(sessions.round), desc(sessions.sessionId));
  return new Map(
    rows.map((r) => [
      r.driverId,
      {
        driverId: r.driverId,
        code: r.code,
        fullName: r.fullName,
        lineStyle: asLineStyle(r.lineStyle),
        teamId: r.teamId,
        teamName: r.teamName,
        teamColour: r.teamColour,
      },
    ]),
  );
}

/**
 * §7.2 — the predicted finishing order for a scheduled round, best expected position
 * first. `[]` when the round has no `preview_finish_order` rows. A driver with no
 * `session_entries` row anywhere in the season still appears, with the fallback colour.
 */
async function getPreviewOrderRaw(
  year: number,
  round: number,
): Promise<PreviewOrderRow[]> {
  const rows = await db
    .select({
      driverId: previewFinishOrder.driverId,
      expectedPosition: previewFinishOrder.expectedPosition,
      posP10: previewFinishOrder.posP10,
      posP90: previewFinishOrder.posP90,
      pWin: previewFinishOrder.pWin,
      pPodium: previewFinishOrder.pPodium,
      pPoints: previewFinishOrder.pPoints,
    })
    .from(previewFinishOrder)
    .where(and(eq(previewFinishOrder.year, year), eq(previewFinishOrder.round, round)))
    .orderBy(asc(previewFinishOrder.expectedPosition), asc(previewFinishOrder.driverId));
  if (rows.length === 0) return [];
  const refs = await loadSeasonDriverRefs(year);
  const missing = rows.filter((r) => !refs.has(r.driverId)).map((r) => r.driverId);
  if (missing.length > 0) {
    const names = await db
      .select({ driverId: drivers.driverId, fullName: drivers.fullName })
      .from(drivers);
    const byId = new Map(names.map((n) => [n.driverId, n.fullName]));
    for (const id of missing) {
      refs.set(id, {
        driverId: id,
        code: id.slice(0, 3).toUpperCase(),
        fullName: byId.get(id) ?? id,
        lineStyle: "solid",
        teamId: "",
        teamName: "",
        teamColour: TEAM_FALLBACK,
      });
    }
  }
  return rows.map((r) => ({
    ...(refs.get(r.driverId) as DriverRef),
    expectedPosition: r.expectedPosition,
    posP10: r.posP10,
    posP90: r.posP90,
    pWin: r.pWin,
    pPodium: r.pPodium,
    pPoints: r.pPoints,
  }));
}
export const getPreviewOrder = cached("preview.getPreviewOrder", getPreviewOrderRaw);

/**
 * §7.2 / §7.3 — every circuit that has an overtaking difficulty index, easiest first,
 * for the fixed 0–100 strip. `[]` when `circuit_odi` is empty.
 */
async function getOdiStripRaw(): Promise<OdiTick[]> {
  const rows = await db
    .select({
      circuitKey: circuitOdi.circuitKey,
      shortName: circuits.shortName,
      odi: circuitOdi.odi,
    })
    .from(circuitOdi)
    .innerJoin(circuits, eq(circuits.circuitKey, circuitOdi.circuitKey))
    .orderBy(asc(circuitOdi.odi), asc(circuits.shortName));
  return rows.map((r) => ({ circuitKey: r.circuitKey, shortName: r.shortName, odi: r.odi }));
}
export const getOdiStrip = cached("preview.getOdiStrip", getOdiStripRaw);
