// SIM_SPEC §6.8 — the trust check. Server-renderable: it only needs the driver's calibration
// block and the race's red-lap count, both carried in the payload, so no engine call is made.
import { fmtRaceTime, fmtSigned } from "@/lib/format";

export type TrustCheckCalibration = {
  lapsTimed: number; lapsModelled: number; unmodelledLaps: number;
  realTotalS: number; realFuelS: number; simTotalFcS: number;
  misfitRepS: number; misfitPitS: number; misfitLap1S: number; unmodelledS: number;
  badge: "calibrated" | "rough" | "poor";
};

export type TrustCheckProps = {
  code: string;
  calibration: TrustCheckCalibration;
  nRedLaps: number;
  className?: string;
};

const BADGE: Record<TrustCheckCalibration["badge"], { label: string; cls: string }> = {
  calibrated: { label: "good fit", cls: "border-accent/70 text-accent" },
  rough: { label: "rough fit", cls: "border-amber-500/70 text-amber-300" },
  poor: { label: "poor fit — low trust", cls: "border-red-500/70 text-red-300" },
};

/**
 * The direction word for the clean-air misfit (FINDING F). Derived from `misfitRepS` alone, so
 * it can never disagree in sign with the number printed beside it or with the badge, both of
 * which are computed from the modelled laps only (§1.10, §6.8).
 */
export function trustDirection(misfitRepS: number): "optimistic" | "pessimistic" {
  return misfitRepS >= 0 ? "optimistic" : "pessimistic";
}

/** The badge text alone (SimSection reuses it for the verdict prefix decision). */
export function badgeLabel(badge: TrustCheckCalibration["badge"]): string {
  return BADGE[badge].label;
}

export default function TrustCheck({ code, calibration: c, nRedLaps, className }: TrustCheckProps): React.JSX.Element {
  const modelWall = c.simTotalFcS + c.realFuelS;
  const misfitAbs = Math.abs(c.misfitRepS);
  // FINDING F: the direction word must come from the SAME quantity as the number beside it and
  // as the badge — the modelled-lap misfit — not from the whole-race wall-clock total, which
  // also carries the unmodelled laps (SC, traffic, red flags) the badge deliberately excludes.
  // §1.10: misfit_rep_s = Σ over modelled laps of (real − model − δ), so misfit_rep_s > 0 means
  // the model ran those laps faster than the real car did, i.e. the model is optimistic there.
  const direction = trustDirection(c.misfitRepS);
  const perLap = c.lapsModelled > 0 ? misfitAbs / c.lapsModelled : 0;
  const wallDelta = modelWall - c.realTotalS;
  const b = BADGE[c.badge];
  return (
    <p className={`text-sm leading-relaxed text-muted ${className ?? ""}`}>
      <strong className="text-fg">Trust check.</strong> Replaying {code}&apos;s real strategy lap by lap, the
      model gives <strong className="tnum text-fg">{fmtRaceTime(modelWall)}</strong>; the real time over the same{" "}
      {c.lapsTimed} laps was <strong className="tnum text-fg">{fmtRaceTime(c.realTotalS)}</strong> — a whole-race
      difference of <strong className="tnum text-fg">{fmtSigned(wallDelta, 1, " s")}</strong> across every lap,
      modelled and not. On the {c.lapsModelled} clean-air laps the model was fitted on, and on those laps only, it
      is{" "}
      <strong className="tnum text-fg">
        {misfitAbs.toFixed(1)} s {direction}
      </strong>{" "}
      ({perLap.toFixed(2)} s per lap) —{" "}
      <span
        title="Fit quality judged on the modelled laps only"
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${b.cls}`}
      >
        {b.label}
      </span>
      . The other {c.unmodelledLaps} {c.unmodelledLaps === 1 ? "lap" : "laps"} (traffic, yellow flags, damage,
      lift-and-coast, wet laps) cost{" "}
      <strong className="tnum text-fg">{fmtSigned(c.unmodelledS, 1, " s")}</strong> that the simulator does not see;
      pit laps <span className="tnum">{fmtSigned(c.misfitPitS, 1, " s")}</span> and the start{" "}
      <span className="tnum">{fmtSigned(c.misfitLap1S, 1, " s")}</span>. Both the &ldquo;{direction}&rdquo; above and
      the fit badge are judged on the modelled laps only, which is why they can point the other way from the
      whole-race difference.
      {nRedLaps > 0 ? " This race was red-flagged; the stopped laps are outside the model." : ""}
    </p>
  );
}
