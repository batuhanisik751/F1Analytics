// web/lib/queries/sim.ts — SIM_SPEC §4. Reads sim_* tables + stints/pit_stops/results/lap_status/laps; computes nothing.
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  assumptionSets,
  compoundColours,
  drivers,
  events,
  lapStatus,
  laps,
  pitStops,
  results,
  sessionEntries,
  sessionIngests,
  sessionTeams,
  sessions,
  simCircuitHazard,
  simCompoundParams,
  simDriverCompound,
  simDriverParams,
  simRaceParams,
  stints,
} from "@/db/schema";
import { COMPOUND_FALLBACK } from "@/lib/theme";
import type { DriverRef, LineStyle } from "@/lib/queries/shared";
import { cached } from "@/lib/cache";

export type SimCompound = {
  compound: string;                 // upper-case; only parameterised compounds appear
  compoundColour: string;           // compound_colours (UNKNOWN fallback), for chips and chart
  laps: number; ageMax: number;
  offsetS: number; offsetSe: number;
  degSPerLap: number; degSe: number; degRawSPerLap: number; degNegative: boolean;
  stintTauLevelS: number; stintTauSlope: number; stintTauSource: "race" | "prior"; stintsUsed: number;
};

/** §0.3 stint convention: pit at the END of endLap; the last stint's endLap == horizon. */
export type SimStint = { compound: string; endLap: number };

export type SimCalibration = {
  lapsCompleted: number; lapsTimed: number; lapsModelled: number; unmodelledLaps: number; stops: number;
  realTotalS: number; realTotalFcS: number; realFuelS: number; simTotalFcS: number;
  misfitRepS: number; misfitPitS: number; misfitLap1S: number; unmodelledS: number;
  badge: "calibrated" | "rough" | "poor";
};

export type SimDriver = DriverRef & {
  position: number | null;          // results.position (finishing order for the selector)
  lapsFit: number; baseS: number; baseSe: number; noiseSdS: number;
  lapsCompleted: number;            // the horizon H (== calibration.lapsCompleted when simulable)
  dc: Record<string, { dcOffsetS: number; dcSe: number; laps: number }>;  // absent key == never ran it (dc = 0)
  actual: SimStint[];               // from stints (contiguous 1..H); [] when not simulable
  actualStartAge: number;           // laps.tyre_life on lap 1 (used tyres start > 1); 1 when unknown
  actualPitLaps: number[];          // pit_stops.lap_in with lap_out NOT NULL, ascending (editor reset + markers)
  simulable: boolean;
  notSimulableReason: string | null;   // sim_driver_params.not_simulable_reason
  calibration: SimCalibration | null;  // null iff !simulable
};

export type SimUnavailableDriver = DriverRef & { position: number | null; reason: string };  // no sim_driver_params row

export type SimRace = {
  totalLaps: number; refCompound: string; lapsFit: number; driversFit: number;
  r2: number; residSdS: number; residMadS: number; designCond: number;
  evoSPerLap: number; evoSe: number;
  paramNames: string[]; paramMean: number[]; paramChol: number[];   // §2.1; k = paramNames.length; chol is k*k row-major
  fieldDeltaS: number[];            // δ_L, index L-1, length totalLaps
  lapStatus: ("G" | "S" | "V" | "R")[];   // index L-1, from lap_status.worst_status ('4'→S, '6'|'7'→V, '5'→R, else G); 'G' for missing laps
  startPenaltyS: number;
  pitLoss: { medianS: number; madS: number; n: number; samplesS: number[]; source: "race" | "circuit" | "pooled" };
  scPitFactor: number;  scPitFactorSource: "race" | "pooled";
  vscPitFactor: number; vscPitFactorSource: "race" | "pooled";
  nScLaps: number; nVscLaps: number; nRedLaps: number;
};

export type SimHazard = {
  circuitKey: number; races: number; laps: number; scEpisodes: number; vscEpisodes: number;
  scHazard: number; vscHazard: number; scStartP: number; vscStartP: number;
  scDurMean: number; vscDurMean: number;
};

export type SimModel = {
  sessionId: number; assumptionSetId: number;
  race: SimRace;
  compounds: SimCompound[];         // ref compound first, then by laps desc
  hazard: SimHazard | null;         // null when the circuit row is missing (events.circuit_key NULL or hazards never recomputed)
  drivers: SimDriver[];             // ORDER BY results.position NULLS LAST, then code
  unavailable: SimUnavailableDriver[];
  constants: { draws: number; seed: number; kDc: number; degFloor: number; extrapolationLaps: number;
               noiseTDf: number; minStintLaps: 2; maxStops: 4 };   // from assumption_sets.params of the fitted row (SIM_*), + two UI constants
};

export type SimPayload =
  | { status: "ok"; model: SimModel }
  | { status: "unavailable"; reason: string };   // analytics_status.sim text, or 'strategy model not computed for this race (re-ingest with --force)' when the key is absent


// ---------------------------------------------------------------------------------------------
// §4.2 query plan. Every select is keyed by session_id; the only "computation" is the COALESCE
// order for pit loss / SC factors (race → circuit → pooled → prior) and tiling `stints` into
// the §0.3 strategy shape.
// ---------------------------------------------------------------------------------------------

const SIM_UNAVAILABLE_FALLBACK = "strategy model not computed for this race (re-ingest with --force)";
const NO_PIT_LOSS_REASON = "no green-flag pit stops stored for this race";

/** §1.13 defaults, used only when the fitted assumption set predates a constant (never in v1.1 data). */
const CONSTANT_DEFAULTS = {
  SIM_DRAWS: 4000,
  SIM_SEED: 20240101,
  SIM_K_DC: 10,
  SIM_DEG_FLOOR: 0,
  SIM_EXTRAPOLATION_LAPS: 5,
  SIM_NOISE_T_DF: 4,
  SIM_SC_PIT_FACTOR_PRIOR: 0.86,
  SIM_VSC_PIT_FACTOR_PRIOR: 0.95,
  SIM_MIN_DRIVER_LAPS: 8,
} as const;

function numParam(params: Record<string, unknown>, key: keyof typeof CONSTANT_DEFAULTS): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : CONSTANT_DEFAULTS[key];
}

function asLineStyle(s: string): LineStyle {
  return s === "dashed" || s === "dotted" ? s : "solid";
}

function asBadge(s: string | null): SimCalibration["badge"] {
  return s === "rough" || s === "poor" ? s : "calibrated";
}

function asTauSource(s: string): SimCompound["stintTauSource"] {
  return s === "prior" ? "prior" : "race";
}

/** §0.3 track-status vocabulary: '4' → SC, '6'|'7' → VSC, '5' → red, else green. */
function statusCode(worst: string): SimRace["lapStatus"][number] {
  if (worst === "4") return "S";
  if (worst === "6" || worst === "7") return "V";
  if (worst === "5") return "R";
  return "G";
}

const entryColumns = {
  driverId: sessionEntries.driverId,
  code: sessionEntries.code,
  fullName: drivers.fullName,
  lineStyle: sessionEntries.lineStyle,
  teamId: sessionTeams.teamId,
  teamName: sessionTeams.teamName,
  teamColour: sessionTeams.colour,
  position: results.position,
};

type EntryRow = {
  driverId: string;
  code: string;
  fullName: string;
  lineStyle: string;
  teamId: string;
  teamName: string;
  teamColour: string;
  position: number | null;
};

function toDriverRef(r: EntryRow): DriverRef & { position: number | null } {
  return {
    driverId: r.driverId,
    code: r.code,
    fullName: r.fullName,
    lineStyle: asLineStyle(r.lineStyle),
    teamId: r.teamId,
    teamName: r.teamName,
    teamColour: r.teamColour,
    position: r.position ?? null,
  };
}

/** Every entry of the session in selector order (results.position NULLS LAST, then code). */
async function loadEntries(sessionId: number): Promise<EntryRow[]> {
  return db
    .select(entryColumns)
    .from(sessionEntries)
    .innerJoin(
      sessionTeams,
      and(
        eq(sessionTeams.sessionId, sessionEntries.sessionId),
        eq(sessionTeams.teamId, sessionEntries.teamId),
      ),
    )
    .innerJoin(drivers, eq(drivers.driverId, sessionEntries.driverId))
    .leftJoin(
      results,
      and(eq(results.sessionId, sessionEntries.sessionId), eq(results.driverId, sessionEntries.driverId)),
    )
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(sql`${results.position} asc nulls last`, asc(sessionEntries.code));
}

async function loadUnavailableReason(sessionId: number): Promise<string> {
  const rows = await db
    .select({ analyticsStatus: sessionIngests.analyticsStatus })
    .from(sessionIngests)
    .where(eq(sessionIngests.sessionId, sessionId))
    .limit(1);
  const sim = rows[0]?.analyticsStatus?.sim;
  return typeof sim === "string" && sim.length > 0 ? sim : SIM_UNAVAILABLE_FALLBACK;
}

/** Tile the driver's stints into `[{compound, endLap}]` over 1..H; null when they do not tile contiguously. */
function buildActual(
  rows: { compound: string; startLap: number; endLap: number }[],
  H: number,
): SimStint[] | null {
  const used = rows.filter((r) => r.startLap <= H);
  if (used.length === 0) return null;
  const out: SimStint[] = [];
  let expectStart = 1;
  for (const r of used) {
    if (r.startLap !== expectStart) return null;
    const endLap = Math.min(r.endLap, H);
    if (endLap < r.startLap) return null;
    out.push({ compound: r.compound, endLap });
    expectStart = endLap + 1;
  }
  out[out.length - 1] = { ...out[out.length - 1], endLap: H };
  return out;
}

/** §4 — the one query of the simulator: the whole per-race model as a JSON payload. */
async function getSimModelRaw(sessionId: number): Promise<SimPayload> {
  const raceRows = await db
    .select({ race: simRaceParams, params: assumptionSets.params })
    .from(simRaceParams)
    .innerJoin(assumptionSets, eq(assumptionSets.assumptionSetId, simRaceParams.assumptionSetId))
    .where(eq(simRaceParams.sessionId, sessionId))
    .limit(1);
  if (raceRows.length === 0) {
    return { status: "unavailable", reason: await loadUnavailableReason(sessionId) };
  }
  const race = raceRows[0].race;
  const params = raceRows[0].params ?? {};

  const [
    compoundRows,
    colourRows,
    entries,
    driverRows,
    dcRows,
    stintRows,
    pitRows,
    statusRows,
    lap1Rows,
    hazardRows,
  ] = await Promise.all([
    db.select().from(simCompoundParams).where(eq(simCompoundParams.sessionId, sessionId)),
    db
      .select({ compound: compoundColours.compound, colour: compoundColours.colour })
      .from(compoundColours)
      .where(eq(compoundColours.sessionId, sessionId)),
    loadEntries(sessionId),
    db.select().from(simDriverParams).where(eq(simDriverParams.sessionId, sessionId)),
    db.select().from(simDriverCompound).where(eq(simDriverCompound.sessionId, sessionId)),
    db
      .select({
        driverId: stints.driverId,
        compound: stints.compound,
        startLap: stints.startLap,
        endLap: stints.endLap,
      })
      .from(stints)
      .where(eq(stints.sessionId, sessionId))
      .orderBy(asc(stints.driverId), asc(stints.startLap)),
    db
      .select({ driverId: pitStops.driverId, lapIn: pitStops.lapIn })
      .from(pitStops)
      .where(and(eq(pitStops.sessionId, sessionId), isNotNull(pitStops.lapOut)))
      .orderBy(asc(pitStops.driverId), asc(pitStops.lapIn)),
    db
      .select({ lapNumber: lapStatus.lapNumber, worstStatus: lapStatus.worstStatus })
      .from(lapStatus)
      .where(eq(lapStatus.sessionId, sessionId)),
    db
      .select({ driverId: laps.driverId, tyreLife: laps.tyreLife })
      .from(laps)
      .where(and(eq(laps.sessionId, sessionId), eq(laps.lapNumber, 1))),
    db
      .select({ hazard: simCircuitHazard })
      .from(sessions)
      .innerJoin(events, and(eq(events.year, sessions.year), eq(events.round, sessions.round)))
      .innerJoin(simCircuitHazard, eq(simCircuitHazard.circuitKey, events.circuitKey))
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  ]);

  const hz = hazardRows[0]?.hazard ?? null;

  // Pit loss: race → circuit → pooled (§4.2); no source at all → unavailable.
  let pitLoss: SimRace["pitLoss"];
  if (race.pitLossS !== null) {
    pitLoss = {
      medianS: race.pitLossS,
      madS: race.pitLossMadS ?? 0,
      n: race.pitLossN,
      samplesS: race.pitLossSamplesS,
      source: "race",
    };
  } else if (hz && hz.pitLossCircuitS !== null) {
    pitLoss = { medianS: hz.pitLossCircuitS, madS: hz.pitLossPooledMadS, n: 0, samplesS: [], source: "circuit" };
  } else if (hz) {
    pitLoss = { medianS: hz.pitLossPooledS, madS: hz.pitLossPooledMadS, n: 0, samplesS: [], source: "pooled" };
  } else {
    return { status: "unavailable", reason: NO_PIT_LOSS_REASON };
  }

  const scPitFactor =
    race.scPitFactorRace ?? hz?.scPitFactorPooled ?? numParam(params, "SIM_SC_PIT_FACTOR_PRIOR");
  const vscPitFactor =
    race.vscPitFactorRace ?? hz?.vscPitFactorPooled ?? numParam(params, "SIM_VSC_PIT_FACTOR_PRIOR");

  const totalLaps = race.totalLaps;
  const lapStatusArr: SimRace["lapStatus"] = new Array(totalLaps).fill("G");
  for (const r of statusRows) {
    if (r.lapNumber >= 1 && r.lapNumber <= totalLaps) lapStatusArr[r.lapNumber - 1] = statusCode(r.worstStatus);
  }
  const fieldDeltaS = race.fieldDeltaS.slice(0, totalLaps);
  while (fieldDeltaS.length < totalLaps) fieldDeltaS.push(0);

  const simRace: SimRace = {
    totalLaps,
    refCompound: race.refCompound,
    lapsFit: race.lapsFit,
    driversFit: race.driversFit,
    r2: race.r2,
    residSdS: race.residSdS,
    residMadS: race.residMadS,
    designCond: race.designCond,
    evoSPerLap: race.evoSPerLap,
    evoSe: race.evoSe,
    paramNames: race.paramNames,
    paramMean: race.paramMean,
    paramChol: race.paramChol,
    fieldDeltaS,
    lapStatus: lapStatusArr,
    startPenaltyS: race.startPenaltyS,
    pitLoss,
    scPitFactor,
    scPitFactorSource: race.scPitFactorRace !== null ? "race" : "pooled",
    vscPitFactor,
    vscPitFactorSource: race.vscPitFactorRace !== null ? "race" : "pooled",
    nScLaps: race.nScLaps,
    nVscLaps: race.nVscLaps,
    nRedLaps: race.nRedLaps,
  };

  const colourMap = new Map(colourRows.map((r) => [r.compound, r.colour]));
  const compounds: SimCompound[] = compoundRows
    .map((c) => ({
      compound: c.compound,
      compoundColour: colourMap.get(c.compound) ?? COMPOUND_FALLBACK[c.compound] ?? COMPOUND_FALLBACK.UNKNOWN,
      laps: c.laps,
      ageMax: c.ageMax,
      offsetS: c.offsetS,
      offsetSe: c.offsetSe,
      degSPerLap: c.degSPerLap,
      degSe: c.degSe,
      degRawSPerLap: c.degRawSPerLap,
      degNegative: c.degNegative,
      stintTauLevelS: c.stintTauLevelS,
      stintTauSlope: c.stintTauSlope,
      stintTauSource: asTauSource(c.stintTauSource),
      stintsUsed: c.stintsUsed,
    }))
    .sort((a, b) => {
      if (a.compound === race.refCompound) return -1;
      if (b.compound === race.refCompound) return 1;
      return b.laps - a.laps || a.compound.localeCompare(b.compound);
    });

  const hazard: SimHazard | null = hz
    ? {
        circuitKey: hz.circuitKey,
        races: hz.races,
        laps: hz.laps,
        scEpisodes: hz.scEpisodes,
        vscEpisodes: hz.vscEpisodes,
        scHazard: hz.scHazard,
        vscHazard: hz.vscHazard,
        scStartP: hz.scStartP,
        vscStartP: hz.vscStartP,
        scDurMean: hz.scDurMean,
        vscDurMean: hz.vscDurMean,
      }
    : null;

  // Per-driver side tables keyed by driver_id.
  const byDriver = new Map(driverRows.map((r) => [r.driverId, r]));
  const dcByDriver = new Map<string, SimDriver["dc"]>();
  for (const r of dcRows) {
    let m = dcByDriver.get(r.driverId);
    if (!m) dcByDriver.set(r.driverId, (m = {}));
    m[r.compound] = { dcOffsetS: r.dcOffsetS, dcSe: r.dcSe, laps: r.laps };
  }
  const stintsByDriver = new Map<string, { compound: string; startLap: number; endLap: number }[]>();
  for (const r of stintRows) {
    let a = stintsByDriver.get(r.driverId);
    if (!a) stintsByDriver.set(r.driverId, (a = []));
    a.push(r);
  }
  const pitsByDriver = new Map<string, number[]>();
  for (const r of pitRows) {
    let a = pitsByDriver.get(r.driverId);
    if (!a) pitsByDriver.set(r.driverId, (a = []));
    a.push(r.lapIn);
  }
  const startAge = new Map(lap1Rows.map((r) => [r.driverId, r.tyreLife]));
  const minDriverLaps = numParam(params, "SIM_MIN_DRIVER_LAPS");

  const simDrivers: SimDriver[] = [];
  const unavailable: SimUnavailableDriver[] = [];
  for (const e of entries) {
    const ref = toDriverRef(e);
    const p = byDriver.get(e.driverId);
    if (!p) {
      unavailable.push({ ...ref, reason: `fewer than ${minDriverLaps} clean laps` });
      continue;
    }
    const H = p.lapsCompleted;
    let simulable = p.simulable;
    let notSimulableReason = p.notSimulableReason;
    let actual: SimStint[] = [];
    if (simulable) {
      const tiled = buildActual(stintsByDriver.get(e.driverId) ?? [], H);
      if (tiled === null) {
        simulable = false;
        notSimulableReason = "stint data incomplete";
      } else {
        actual = tiled;
      }
    }
    const calibration: SimCalibration | null =
      simulable && p.simTotalFcS !== null
        ? {
            lapsCompleted: p.lapsCompleted,
            lapsTimed: p.lapsTimed,
            lapsModelled: p.lapsModelled,
            unmodelledLaps: p.unmodelledLaps,
            stops: p.stops,
            realTotalS: p.realTotalS ?? 0,
            realTotalFcS: p.realTotalFcS ?? 0,
            realFuelS: p.realFuelS ?? 0,
            simTotalFcS: p.simTotalFcS,
            misfitRepS: p.misfitRepS ?? 0,
            misfitPitS: p.misfitPitS ?? 0,
            misfitLap1S: p.misfitLap1S ?? 0,
            unmodelledS: p.unmodelledS ?? 0,
            badge: asBadge(p.badge),
          }
        : null;
    if (calibration === null && simulable) {
      // Python marks simulable only with a stored replay; without one the driver cannot be trusted.
      simulable = false;
      notSimulableReason = notSimulableReason ?? "calibration not stored";
      actual = [];
    }
    simDrivers.push({
      ...ref,
      lapsFit: p.lapsFit,
      baseS: p.baseS,
      baseSe: p.baseSe,
      noiseSdS: p.noiseSdS,
      lapsCompleted: H,
      dc: dcByDriver.get(e.driverId) ?? {},
      actual,
      actualStartAge: startAge.get(e.driverId) ?? 1,
      actualPitLaps: pitsByDriver.get(e.driverId) ?? [],
      simulable,
      notSimulableReason: simulable ? null : notSimulableReason,
      calibration,
    });
  }

  const model: SimModel = {
    sessionId,
    assumptionSetId: race.assumptionSetId,
    race: simRace,
    compounds,
    hazard,
    drivers: simDrivers,
    unavailable,
    constants: {
      draws: numParam(params, "SIM_DRAWS"),
      seed: numParam(params, "SIM_SEED"),
      kDc: numParam(params, "SIM_K_DC"),
      degFloor: numParam(params, "SIM_DEG_FLOOR"),
      extrapolationLaps: numParam(params, "SIM_EXTRAPOLATION_LAPS"),
      noiseTDf: numParam(params, "SIM_NOISE_T_DF"),
      minStintLaps: 2,
      maxStops: 4,
    },
  };
  return { status: "ok", model };
}
export const getSimModel = cached("sim.getSimModel", getSimModelRaw);
