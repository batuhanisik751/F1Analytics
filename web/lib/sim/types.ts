// SIM_SPEC §4.1 / §5 — the engine's type surface. Type-only re-exports of the payload types
// (erased at build time, so lib/sim never imports lib/queries at runtime) plus the engine types.
export type {
  SimCalibration,
  SimCompound,
  SimDriver,
  SimHazard,
  SimModel,
  SimPayload,
  SimRace,
  SimStint,
  SimUnavailableDriver,
} from "@/lib/queries/sim";
import type { SimDriver, SimModel, SimStint } from "@/lib/queries/sim";

export type SimMode = "asHappened" | "random";
export type LapStatusCode = "G" | "S" | "V" | "R";

export type SimInput = {
  model: SimModel;
  driver: SimDriver;
  edited: SimStint[];
  mode: SimMode;
  seed?: number;
  draws?: number;
};

export type SimResult = {
  n: number; horizonLaps: number; mode: SimMode; seed: number;
  deltaMedianS: number; deltaP10S: number; deltaP90S: number; deltaMeanS: number;
  pBetter: number;                                          // share of draws with delta < 0 (edited faster)
  histogram: { binStartS: number; binEndS: number; count: number }[];   // 30 equal bins over [p1, p99]
  perLap: { lap: number; medianS: number; p10S: number; p90S: number }[]; // cumulative edited − actual
  editedStops: { lap: number; status: LapStatusCode }[];    // for markers; status per as-happened lapStatus (random mode: "G")
  actualStops: { lap: number; status: LapStatusCode }[];
  scLapsMean: number | null;                                // random mode: mean simulated SC+VSC laps per draw; null otherwise
};

/** §5.1 expanded strategy over the horizon H (arrays are indexed L-1). */
export type Plan = {
  comp: string[];
  age: Int32Array;
  pitAt: Uint8Array;
  stintIdx: Int32Array;
  stops: number[];
};

export type ReplayResult = { totalFcS: number; perLapS: number[] };
