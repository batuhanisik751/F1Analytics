// MODE3_SPEC §8.4 — the SQL is always present, always one click away, and never dominates.
//
// The collapsed line's middle field comes from the VALIDATOR'S AST walk (`plan.methodLine`), not
// from the model: it is the only honesty signal here that model output cannot influence, and it
// is the one a fan who does not read SQL can still read.
//
// UX_SPEC §2.1 — this used to be a hand-rolled button + `aria-expanded` div, which §2.1 rules out.
// It is now <Disclosure>, i.e. native <details>/<summary>: keyboard-operable, announced by screen
// readers, openable by browser find-in-page and working with no JavaScript at all. It stays CLOSED
// by default (§2.2 — the answer is what was asked for; the query is the method), and nothing that
// was on screen before has been removed: the summary, the AST line, the row count, the flag notes
// and the "why we show it" paragraph are all still here.
import Disclosure from "@/components/ui/Disclosure";
import type { AskPlanEvent } from "./types";

/** §8.4's leading fragment: `SELECT … FROM ask.laps`. Derived from the views, never from prose. */
export function sqlSummary(views: string[]): string {
  if (views.length === 0) return "SELECT …";
  const shown = views.slice(0, 2).join(", ");
  const more = views.length > 2 ? `, +${views.length - 2}` : "";
  return `SELECT … FROM ${shown}${more}`;
}

/** Why each flag matters, in a sentence a fan can act on (§8.4's three detectable conditions). */
export const FLAG_EXPLAIN: Record<string, string> = {
  "no clean-lap filter":
    "This read lap-level rows without is_representative, so in-laps, out-laps and safety-car laps are included in the average.",
  "no assumption-set filter":
    "This read an analytics view without pinning assumption_set_id; rows from two assumption sets can double-count.",
  "no minimum sample":
    "This grouped and averaged with no minimum number of laps per group, so a one-lap group ranks beside a fifty-lap one.",
};

export default function SqlPanel({
  plan,
  rowCount,
}: {
  plan: AskPlanEvent;
  /** Executed row count; appended to the AST line once it is known. */
  rowCount: number | null;
}): React.JSX.Element {
  const line =
    rowCount === null
      ? plan.methodLine
      : `${plan.methodLine} · ${rowCount === 1 ? "1 row" : `${rowCount} rows`}`;
  const flagNotes = plan.methodLine
    .split(" · ")
    .map((p) => FLAG_EXPLAIN[p])
    .filter((x): x is string => typeof x === "string");

  return (
    <Disclosure
      summary={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="font-mono text-fg">{sqlSummary(plan.views)}</span>{" "}
          <span aria-hidden>·</span>{" "}
          <span>{line}</span>{" "}
          {flagNotes.length > 0 ? (
            <span className="text-accent">
              {flagNotes.length === 1
                ? "1 thing to know about this query"
                : `${flagNotes.length} things to know about this query`}
            </span>
          ) : null}{" "}
          <span className="text-accent underline group-open:hidden">show query</span>
          <span className="hidden text-accent underline group-open:inline">hide query</span>
        </span>
      }
    >
      <pre className="overflow-x-auto rounded bg-bg/60 p-3 font-mono text-xs leading-relaxed text-fg">
        {plan.sql}
      </pre>
      {flagNotes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {flagNotes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        The query is shown because it can be subtly wrong in ways the rows do not reveal. The
        line above it is written by our own parser, not by Claude.
      </p>
    </Disclosure>
  );
}
