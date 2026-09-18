// MODE1_SPEC §3.2 / §3.6 — the circuit resolution is displayed copy, not a hidden flag.
// An alias-matched preview says so on screen; a one-race circuit carries a warning band.
import type { CircuitMatch } from "@/lib/queries/preview";

export type CircuitMatchNoteProps = {
  circuitMatch: CircuitMatch;
  circuitShortName: string | null;
  circuitRaces: number;
  className?: string;
};

export default function CircuitMatchNote({
  circuitMatch,
  circuitShortName,
  circuitRaces,
  className,
}: CircuitMatchNoteProps): React.JSX.Element | null {
  const lines: string[] = [];
  if (circuitMatch === "alias" && circuitShortName) {
    lines.push(`Using history from ${circuitShortName}`);
  }
  if (circuitMatch !== "none" && circuitRaces === 1) {
    lines.push("One race of history at this circuit — read every number below as a single sample.");
  }
  if (lines.length === 0) return null;
  return (
    <div
      className={`mb-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-fg ${className ?? ""}`}
    >
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}
