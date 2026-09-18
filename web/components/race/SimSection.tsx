"use client";

// SIM_SPEC §6 — the strategy simulator section. Owns all client state (driver, mode, stints),
// runs the engine on valid edits with a 150 ms debounce and a fixed seed (§9 D9), mirrors the
// editor into the URL hash (§9 D10) and composes the editor, tiles, charts and trust check.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SimDeltaHistogram from "@/components/charts/SimDeltaHistogram";
import SimGapChart, { toTraceLapStatus } from "@/components/charts/SimGapChart";
import ResultTiles, { verdictSentence } from "@/components/sim/ResultTiles";
import StintEditor from "@/components/sim/StintEditor";
import TrustCheck from "@/components/sim/TrustCheck";
import {
  contextFor,
  decodeHash,
  defaultDriver,
  encodeHash,
  initialState,
  reduce,
  validate,
  type SimAction,
  type SimEditorState,
  type SimMode,
} from "@/components/sim/simState";
import { explainWarning, warningsSummary } from "@/components/race/warnings";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import StatTile from "@/components/ui/StatTile";
import type { ColourMap } from "@/lib/colours";
import { simulate, SimPlanError } from "@/lib/sim/engine";
import type { SimDriver, SimModel, SimPayload, SimResult } from "@/lib/sim/types";

export type SimSectionProps = {
  payload: SimPayload;
  colours: ColourMap;
  year?: number;
  reason?: string | null;
  /**
   * UX_SPEC §3.3 — the raw `sim:` strings from `session_ingests.warnings`, which used to sit in
   * the page header as pipeline diagnostics. They are rewritten as sentences here, in the section
   * they are about, with the originals kept verbatim underneath (§0).
   */
  notes?: readonly string[];
};

/** Nav entry / Section header for the page (§6 intro, §9 D1) — defined in the server-safe `simMeta.ts`. */
export { SIM_SECTION_ID, SIM_SECTION_SUBTITLE, SIM_SECTION_TITLE } from "@/components/sim/simMeta";

/** §6.9 caption; `{scPitFactor}` is filled by `simCaption()`. */
export const SIM_CAPTION =
  "This simulator answers one question only: how much clean-air time a different strategy would have gained or lost for this driver. It does not model traffic, blue flags, overtaking or track position, so it never says whether they would have finished ahead of anyone — a stop that looks 1 s better here can still lose a place on the road. Lap times come from a model fitted to this race's clean laps (driver and tyre base pace, one wear slope per compound, track evolution); wear is a straight line that keeps going past the longest real stint, and the same amount of wear is charged under a safety car as in racing. Pit loss is resampled from this race's own green-flag stops; safety cars either replay the real ones or are drawn from this circuit's history. Fuel load is left out because it is the same on every lap for every strategy of the same driver. A stop under a safety car costs about {scPitPct} % of a normal stop here, not nothing — the \"free stop\" you see on TV is mostly the field bunching up, which is a position effect. The spread of the result is how much stints on the same tyre varied in this race, how sure the fit is and how variable the pit stops were — not lap-to-lap noise, which is the same in both versions of the race. The trust check compares the model with the real race on the clean-air laps it was fitted on; the laps it was not fitted on are shown separately and are not a strategy effect. The rules about mandatory compounds are not enforced. Every number is recomputed from the same fixed random draws, so the same edit always shows the same result.";

export const SIM_UNAVAILABLE_TEXT =
  "Rain races, races with fewer than two slick compounds on enough clean laps, and races ingested before v1.1 (re-ingest with --force) have no model.";

/** The caption with `{scPitPct}` = round(100 · scPitFactor). */
export function simCaption(scPitFactor: number): string {
  return SIM_CAPTION.replace("{scPitPct}", String(Math.round(100 * scPitFactor)));
}

/** Second caption line for a borrowed pit loss (§6.9), or null. */
export function pitLossCaption(source: SimModel["race"]["pitLoss"]["source"]): string | null {
  if (source === "race") return null;
  const from = source === "circuit" ? "other races at this circuit" : "every ingested race";
  return `Pit loss borrowed from ${from} — fewer than 5 usable green-flag stops here.`;
}

export const DESIGN_COND_CAPTION =
  "In this race everyone pitted on the same laps, so tyre wear and track evolution are hard to tell apart; treat pit-later edits with extra caution.";

export const DEBOUNCE_MS = 150;

const FIELD =
  "max-w-full rounded border border-grid bg-bg px-2 py-1 text-sm text-fg focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent focus:outline-none disabled:opacity-50";
const CARD = "rounded-lg border border-grid bg-surface p-3";

// ---------------------------------------------------------------------------
// Engine wrapper: never throws to React.

export type SimRun =
  | { ok: true; result: SimResult }
  | { ok: false; message: string };

/** Run the engine for one editor state; a `SimPlanError` (or anything else) becomes a message. */
export function runSim(model: SimModel, driver: SimDriver, state: SimEditorState): SimRun {
  if (state.mode === "random" && model.hazard === null) {
    return { ok: false, message: "no circuit history stored — random safety cars are unavailable for this race" };
  }
  if (driver.actual.length === 0) {
    return { ok: false, message: `${driver.code} has no strategy on record` };
  }
  try {
    const result = simulate({
      model,
      driver,
      edited: state.stints,
      mode: state.mode,
      seed: model.constants.seed,
      draws: model.constants.draws,
    });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof SimPlanError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

function driverLabel(d: { position: number | null; code: string; fullName: string }): string {
  return `P${d.position ?? "—"} ${d.code} — ${d.fullName}`;
}

function sameState(a: SimEditorState, b: SimEditorState): boolean {
  if (a.driverId !== b.driverId || a.mode !== b.mode || a.stints.length !== b.stints.length) return false;
  return a.stints.every((s, i) => s.compound === b.stints[i].compound && s.endLap === b.stints[i].endLap);
}

/** Placeholder tiles before the first run / while the plan is invalid (§6.4 last paragraph). */
function EmptyTiles({ hint }: { hint: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <StatTile label="Verdict" value="—" hint={hint} />
      <StatTile label="Chance it was faster" value="—" hint={hint} />
      <StatTile label="Likely range" value="—" hint={hint} />
      <StatTile label="Laps simulated" value="—" hint={hint} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section

/**
 * §0 + §3.3 — every note is shown as a plain sentence, OPEN: each one is a statement that the
 * simulator could not measure something, and a refusal the reader never opens is a refusal the
 * reader never sees. The original pipeline strings sit behind a control below them, because they
 * say nothing extra to a fan — but they are never removed.
 */
function SimNotes({ notes }: { notes: readonly string[] }): React.JSX.Element | null {
  if (notes.length === 0) return null;
  const explained = notes.map((w) => ({ raw: w, plain: explainWarning(w) }));
  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-surface/40 p-4">
      <h3 className="text-sm font-semibold text-fg">{warningsSummary(notes.length)}</h3>
      <ul className="mt-2 space-y-2 text-sm leading-relaxed text-muted">
        {explained.map((e) => (
          <li key={e.raw}>{e.plain ?? e.raw}</li>
        ))}
      </ul>
      <Disclosure
        variant="inline"
        summary={`The same notes as the data pipeline wrote them (${notes.length})`}
      >
        <ul className="space-y-1 font-mono">
          {notes.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

export default function SimSection({
  payload,
  colours,
  reason,
  notes = [],
}: SimSectionProps): React.JSX.Element {
  if (payload.status !== "ok") {
    return (
      <>
        <SimNotes notes={notes} />
        <EmptyState title="No strategy model for this race" reason={payload.reason ?? reason}>
          {SIM_UNAVAILABLE_TEXT}
        </EmptyState>
      </>
    );
  }
  const model = payload.model;
  const first = defaultDriver(model);
  if (first === null) {
    const why = model.drivers.find((d) => d.notSimulableReason)?.notSimulableReason ?? reason;
    return (
      <>
        <SimNotes notes={notes} />
        <EmptyState title="No driver of this race can be simulated" reason={why} />
      </>
    );
  }
  return (
    <>
      <SimNotes notes={notes} />
      <SimBody model={model} colours={colours} first={first} />
    </>
  );
}

type SimBodyProps = { model: SimModel; colours: ColourMap; first: SimDriver };

/**
 * Editor state + debounced commit. `state` is what the editor shows; `committed` is what the
 * engine last ran (updated `DEBOUNCE_MS` after the last valid edit); the result is derived
 * synchronously from `committed` so the server render already carries the default run.
 */
function useSimState(model: SimModel, first: SimDriver) {
  const [state, setState] = useState<SimEditorState>(() => initialState(model, first));
  const [committed, setCommitted] = useState<SimEditorState>(state);
  const hydratedRef = useRef(false);
  const touchedRef = useRef(false); // true after the first user edit; the hash is not written before that

  const driverOf = useCallback(
    (id: string): SimDriver => model.drivers.find((d) => d.driverId === id) ?? first,
    [model, first],
  );
  const driver = driverOf(state.driverId);
  const ctx = useMemo(() => contextFor(model, driver), [model, driver]);
  const validation = useMemo(() => validate(state.stints, driver, ctx), [state.stints, driver, ctx]);

  const dispatch = useCallback(
    (action: SimAction) => {
      if (action.type !== "hydrate") touchedRef.current = true;
      setState((s) => reduce(s, action, contextFor(model, driverOf(s.driverId))));
    },
    [model, driverOf],
  );

  // §9 D10: read the hash once on mount (invalid or absent → defaults).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const fromHash = decodeHash(window.location.hash, model);
      if (fromHash) dispatch({ type: "hydrate", state: fromHash });
      hydratedRef.current = true;
    }, 0);
    return () => window.clearTimeout(t);
  }, [model, dispatch]);

  // §9 D9: commit valid edits after a 150 ms debounce; mirror them into the hash.
  useEffect(() => {
    if (!validation.valid) return;
    const t = window.setTimeout(() => {
      setCommitted((c) => (sameState(c, state) ? c : state));
      if (hydratedRef.current && (touchedRef.current || window.location.hash.startsWith("#sim="))) {
        const hash = `#${encodeHash(driver.code, state.stints, state.mode)}`;
        if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [state, validation.valid, driver.code]);

  const committedDriver = driverOf(committed.driverId);
  const run = useMemo(() => runSim(model, committedDriver, committed), [model, committedDriver, committed]);
  const stale = !sameState(state, committed);
  return { state, driver, ctx, validation, dispatch, committed, committedDriver, run, stale };
}

function SimBody({ model, colours, first }: SimBodyProps): React.JSX.Element {
  const sim = useSimState(model, first);
  const { state, driver, ctx, validation, dispatch } = sim;
  const { race, hazard } = model;
  const randomDisabled = hazard === null;
  const modeHint: Record<SimMode, string> = {
    asHappened: `Safety cars on the laps they really came out (${race.nScLaps} SC laps, ${race.nVscLaps} VSC laps in this race).`,
    random: hazard
      ? `Drawn from this circuit's history: ${hazard.scEpisodes} safety cars and ${hazard.vscEpisodes} virtual ones in ${hazard.races} races here, plus the field-wide rate.`
      : "no circuit history stored",
  };
  // §6.4 / FINDING E: `validate` already decides this (it is what makes a real strategy valid).
  const pristine = validation.pristine;
  const notSimulable =
    model.drivers.filter((d) => !d.simulable).length + model.unavailable.length;

  const driverColumn = (
    <div className="flex flex-col gap-3">
      <div className={CARD}>
        <label htmlFor="sim-driver" className="mb-1 block text-xs uppercase tracking-wide text-muted">
          Driver
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="sim-driver"
            className={FIELD}
            value={state.driverId}
            onChange={(e) => {
              const d = model.drivers.find((x) => x.driverId === e.target.value);
              if (d && d.simulable) dispatch({ type: "selectDriver", driver: d });
            }}
          >
            {model.drivers.map((d) => (
              <option key={d.driverId} value={d.driverId} disabled={!d.simulable}>
                {driverLabel(d)}
                {d.simulable ? "" : ` — ${d.notSimulableReason ?? "not simulable"}`}
              </option>
            ))}
            {model.unavailable.map((d) => (
              <option key={d.driverId} value={d.driverId} disabled>
                {driverLabel(d)} — {d.reason}
              </option>
            ))}
          </select>
          <DriverChip code={driver.code} teamColour={driver.teamColour} lineStyle={driver.lineStyle} fullName={driver.fullName} />
        </div>
        <fieldset className="mt-3">
          <legend className="mb-1 text-xs uppercase tracking-wide text-muted">Safety cars</legend>
          {(["asHappened", "random"] as const).map((m) => (
            <label key={m} className={`flex items-start gap-2 py-0.5 text-sm ${m === "random" && randomDisabled ? "opacity-50" : ""}`}>
              <input
                type="radio"
                name="sim-mode"
                value={m}
                className="mt-1"
                checked={state.mode === m}
                disabled={m === "random" && randomDisabled}
                onChange={() => dispatch({ type: "setMode", mode: m })}
              />
              <span>
                <span className="text-fg">{m === "asHappened" ? "As it happened" : "Random safety cars"}</span>
                <span className="block text-xs text-muted">{modeHint[m]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className={CARD}>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Strategy</p>
        <StintEditor
          stints={state.stints}
          compounds={model.compounds}
          colours={colours}
          horizon={ctx.horizon}
          totalLaps={race.totalLaps}
          limits={{ minStintLaps: ctx.minStintLaps, maxStops: ctx.maxStops, extrapolationLaps: ctx.extrapolationLaps }}
          actual={driver.actual}
          driverCode={driver.code}
          validation={validation}
          pristine={pristine}
          onSetCompound={(index, compound) => dispatch({ type: "setCompound", index, compound })}
          onSetPitLap={(index, lap) => dispatch({ type: "setPitLap", index, lap })}
          onAddStop={() => dispatch({ type: "addStop" })}
          onRemoveStint={(index) => dispatch({ type: "removeStint", index })}
          onReset={() => dispatch({ type: "reset", driver })}
          onPreset={(preset) => dispatch({ type: "preset", preset, driver })}
        />
      </div>
      {model.unavailable.length > 0 || model.drivers.some((d) => !d.simulable) ? (
        // §0 — this is a list of refusals, one per driver the simulator will not touch. It used
        // to be a hand-rolled <details> that started CLOSED with no count in its summary, which
        // is the one thing §0 forbids. It now starts open and says how many drivers it is about.
        <Disclosure
          variant="inline"
          defaultOpen
          summary={`${notSimulable} of ${model.drivers.length + model.unavailable.length} drivers cannot be simulated in this race, and why`}
        >
          <ul className="flex flex-col gap-0.5">
            {model.drivers
              .filter((d) => !d.simulable)
              .map((d) => (
                <li key={d.driverId}>
                  <span className="font-mono text-fg">{d.code}</span> — {d.notSimulableReason ?? "not simulable"}
                </li>
              ))}
            {model.unavailable.map((d) => (
              <li key={d.driverId}>
                <span className="font-mono text-fg">{d.code}</span> — {d.reason}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );

  const resultColumn = <SimResults model={model} sim={sim} />;

  const extraCaptions = [pitLossCaption(race.pitLoss.source), race.designCond > 1e4 ? DESIGN_COND_CAPTION : null].filter(
    (c): c is string => c !== null,
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {driverColumn}
        {resultColumn}
      </div>
      {/* §0/§2.1 — the caption is ~370 words of caveat and it is the best part of this section.
          It is not shortened: a NEW summary line goes in front of it and the full text moves
          behind a control, still in the DOM when closed. */}
      <Disclosure
        variant="inline"
        storageKey="race:sim:caption"
        summary="What this simulator does and does not model — clean air only, no traffic or track position"
      >
        {simCaption(race.scPitFactor)}
      </Disclosure>
      {/* Borrowed pit loss and the "everyone pitted together" warning are limits on
          interpretation, so they stay in the open (§2.2). */}
      {extraCaptions.map((c) => (
        <Caption key={c}>{c}</Caption>
      ))}
    </>
  );
}

type SimResultsProps = { model: SimModel; sim: ReturnType<typeof useSimState> };

function SimResults({ model, sim }: SimResultsProps): React.JSX.Element {
  const { validation, committedDriver: driver, committed, run, stale } = sim;
  const draws = model.constants.draws.toLocaleString("en-GB");
  const fade = stale ? "opacity-60 transition-opacity" : "transition-opacity";
  const calibration = driver.calibration;
  const lowTrust = calibration?.badge === "poor";
  const blocking = !validation.valid ? validation.blockingMessage ?? "the strategy is not valid" : null;

  let body: React.ReactNode;
  if (!run.ok) {
    body = (
      <>
        <EmptyTiles hint={`Simulating ${draws} races…`} />
        <p role="alert" className="mt-2 text-sm text-red-400">
          {run.message}
        </p>
      </>
    );
  } else {
    const r = run.result;
    body = (
      <>
        <ResultTiles
          n={r.n}
          horizonLaps={r.horizonLaps}
          totalLaps={model.race.totalLaps}
          mode={r.mode}
          deltaMedianS={r.deltaMedianS}
          deltaP10S={r.deltaP10S}
          deltaP90S={r.deltaP90S}
          pBetter={r.pBetter}
          scLapsMean={r.scLapsMean}
          code={driver.code}
          teamColour={driver.teamColour}
          lowTrust={lowTrust}
        />
        <div className="mt-3">
          <SimDeltaHistogram
            histogram={r.histogram}
            deltaMedianS={r.deltaMedianS}
            deltaP10S={r.deltaP10S}
            deltaP90S={r.deltaP90S}
            n={r.n}
            teamColour={driver.teamColour}
          />
        </div>
        <p className="mt-3 mb-1 text-xs uppercase tracking-wide text-muted">Lap by lap</p>
        <SimGapChart
          perLap={r.perLap}
          editedStops={r.editedStops}
          actualStops={r.actualStops}
          lapStatus={committed.mode === "asHappened" ? toTraceLapStatus(model.race.lapStatus, r.horizonLaps) : null}
          teamColour={driver.teamColour}
          code={driver.code}
          mode={r.mode}
          ariaLabel={verdictSentence(r.deltaMedianS, r.pBetter)}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={`${CARD} ${fade}`} aria-live="polite" aria-busy={stale}>
        {body}
        {stale ? <p className="mt-2 text-xs text-muted">{blocking ? `Not run: ${blocking}` : `Simulating ${draws} races…`}</p> : null}
      </div>
      {calibration ? (
        <div className={CARD}>
          <p className="mb-1 text-xs uppercase tracking-wide text-muted">Trust check</p>
          <TrustCheck code={driver.code} calibration={calibration} nRedLaps={model.race.nRedLaps} />
        </div>
      ) : null}
    </div>
  );
}
