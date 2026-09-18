// MODE3_SPEC §8.3 — the three progress states. No model output appears here: `checking` shows the
// FIXED envelope the server enforces, not anything the model wrote.
import { ROW_CAP, STATEMENT_TIMEOUT } from "@/lib/ask/limits";

export type AskProgressState = "writing" | "checking" | "running";

const TITLES: Record<AskProgressState, string> = {
  writing: "Writing the query",
  checking: "Checking the query",
  running: "Running",
};

export function askProgressTitle(state: AskProgressState): string {
  return TITLES[state];
}

/** The reassurance line of §8.3: `single read-only SELECT · 4 s limit · 500 rows`. */
export const ENVELOPE_LINE = `single read-only SELECT · ${STATEMENT_TIMEOUT.replace("s", " s")} limit · ${ROW_CAP} rows`;

export default function AskProgress({
  state,
  elapsedMs,
}: {
  state: AskProgressState;
  /** Ticks against the 4 s cap so a slow query feels bounded rather than broken. */
  elapsedMs?: number;
}): React.JSX.Element {
  const secs = Math.min(4, (elapsedMs ?? 0) / 1000);
  return (
    <div className="rounded-lg border border-dashed border-accent/40 bg-surface/40 px-4 py-4">
      <p className="text-sm font-medium text-fg">{TITLES[state]}</p>
      {state === "writing" ? (
        <div className="mt-3 h-2 w-full overflow-hidden rounded bg-grid">
          <div className="h-full w-1/3 animate-pulse rounded bg-accent/70" />
        </div>
      ) : null}
      {state === "checking" ? (
        <p className="mt-2 font-mono text-xs text-muted">{ENVELOPE_LINE}</p>
      ) : null}
      {state === "running" ? (
        <>
          <p className="mt-2 tnum font-mono text-xs text-muted">
            {secs.toFixed(1)} s of 4 s
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded bg-grid">
            <div
              className="h-full rounded bg-accent/70 transition-[width] duration-200"
              style={{ width: `${Math.min(100, (secs / 4) * 100)}%` }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
