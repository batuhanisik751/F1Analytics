// SIM_SPEC §6.5 / §9 D8 — the four result tiles. Pure presentation from structural props
// (numbers lifted out of SimResult by SimSection); the sign convention (edited − actual,
// negative = edited faster) is translated into words here and never shown as a bare number.
import StatTile from "@/components/ui/StatTile";

export type ResultTilesProps = {
  n: number;
  horizonLaps: number;
  totalLaps: number;
  mode: "asHappened" | "random";
  deltaMedianS: number;
  deltaP10S: number;
  deltaP90S: number;
  pBetter: number;
  scLapsMean: number | null;
  code: string;
  teamColour: string;
  /** `true` when the driver's calibration badge is `poor` (§6.8: prefixes the verdict). */
  lowTrust?: boolean;
  className?: string;
};

/** |median| < 0.2 s reads as "about the same" (§6.5 item 1). */
export const SAME_THRESHOLD_S = 0.2;

/** `-4.2` → "4.2 s faster"; `3.1` → "3.1 s slower"; `0.1` → "about the same". */
export function verdictText(deltaS: number): string {
  if (Math.abs(deltaS) < SAME_THRESHOLD_S) return "about the same";
  return `${Math.abs(deltaS).toFixed(1)} s ${deltaS < 0 ? "faster" : "slower"}`;
}

/** Signed one-decimal with the word: `-8.4` → "8.4 s faster", `3.1` → "3.1 s slower", `0` → "0.0 s". */
export function signedWord(deltaS: number): string {
  const abs = Math.abs(deltaS).toFixed(1);
  if (Number(abs) === 0) return "0.0 s";
  return `${abs} s ${deltaS < 0 ? "faster" : "slower"}`;
}

/** One sentence for aria-labels: "Edited strategy 4.2 s faster in the median, P(faster) 81 %". */
export function verdictSentence(deltaMedianS: number, pBetter: number): string {
  return `Edited strategy ${verdictText(deltaMedianS)} in the median, P(faster) ${Math.round(100 * pBetter)} %`;
}

export default function ResultTiles(p: ResultTilesProps): React.JSX.Element {
  const same = Math.abs(p.deltaMedianS) < SAME_THRESHOLD_S;
  const faster = !same && p.deltaMedianS < 0;
  const verdict = verdictText(p.deltaMedianS);
  const verdictColour = faster ? p.teamColour : undefined;
  const rangeHint =
    "8 in 10 simulated races land here. The spread comes from how much stints on the same tyre varied in this race, how sure the fit is, and how variable the pit stops were" +
    (p.mode === "random"
      ? `, and when a safety car comes (on average ${(p.scLapsMean ?? 0).toFixed(1)} neutralised laps per simulated race).`
      : ".");
  const retired = p.horizonLaps < p.totalLaps ? ` — ${p.code} retired there` : "";
  return (
    <div className={`grid grid-cols-2 gap-3 md:grid-cols-4 ${p.className ?? ""}`}>
      <StatTile
        label="Verdict"
        value={
          <span style={verdictColour ? { color: verdictColour } : undefined} className={faster ? "" : "text-muted"}>
            {p.lowTrust ? "low trust: " : ""}
            {verdict}
          </span>
        }
        hint={`Median of ${p.n.toLocaleString("en-GB")} simulated races, edited minus actual, clean-air time only.`}
      />
      {/* §3.3 — "P(faster)" is model notation. The tile now says what it means; the notation is
          kept in the hint (and in `verdictSentence`) rather than dropped. */}
      <StatTile
        label="Chance it was faster"
        value={`${Math.round(100 * p.pBetter)} %`}
        hint="Share of simulated races where the edited strategy finishes in less time. Written P(faster) in the model."
      />
      <StatTile
        label="Likely range"
        value={<span className="text-lg">{`${signedWord(p.deltaP90S)} … ${signedWord(p.deltaP10S)}`}</span>}
        hint={rangeHint}
      />
      <StatTile
        label="Laps simulated"
        value={p.horizonLaps}
        hint={`Both strategies run to lap ${p.horizonLaps}${retired}.`}
      />
    </div>
  );
}
