// UX_SPEC §4.8 — "the ask box announces its result to screen readers".
//
// The ask box replaces its own contents asynchronously: a sighted reader sees the progress panel
// become an answer, a screen-reader user gets nothing at all unless the change is announced. This
// module is the announcement text, kept pure (no JSX, no React, no imports) so it can be unit
// tested and so the live region in AskBox stays a one-liner.
//
// §0 COLLAPSE, NEVER DELETE applies here too: the announcement NAMES the parts that are on screen
// but collapsed — the query, and the caveat — instead of pretending the answer arrived bare.

export type AskAnnouncementInput =
  | { kind: "idle" }
  | { kind: "running"; question: string; stateTitle: string }
  | {
      kind: "answer";
      headline: string;
      /** Rows actually rendered; null before the result event arrives. */
      rowCount: number | null;
      hasCaveat: boolean;
    }
  | { kind: "clarify"; clarification: string }
  | { kind: "out_of_scope"; reason: string }
  | { kind: "failed" };

function rowPhrase(rowCount: number | null): string {
  if (rowCount === null) return "";
  if (rowCount === 0) return " The query ran and returned no rows.";
  return rowCount === 1 ? " 1 row." : ` ${rowCount} rows.`;
}

/**
 * One sentence for `role="status"`. Returns "" when there is nothing to say, so the live region
 * is empty rather than repeating a stale answer.
 */
export function askAnnouncement(input: AskAnnouncementInput): string {
  switch (input.kind) {
    case "idle":
      return "";
    case "running":
      return `${input.stateTitle} for “${input.question}”.`;
    case "answer":
      return (
        `Answer ready. ${input.headline}.` +
        rowPhrase(input.rowCount) +
        (input.hasCaveat ? " There is a caveat with this answer, below it." : "") +
        " The SQL query that produced it is under “show query”."
      );
    case "clarify":
      return `That question needs one more detail before it can be answered. ${input.clarification}`;
    case "out_of_scope":
      return `This database cannot answer that question. ${input.reason}`;
    case "failed":
      return "That question could not be answered. The reason is shown in place of the answer.";
  }
}
