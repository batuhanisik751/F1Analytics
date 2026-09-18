// MODE3_SPEC §4.1 + §8 — the race report slot on /race/[year]/[round]: below RaceHeader,
// above the results table. A SERVER COMPONENT that renders stored rows, nothing else. No
// fetch, no secret, no client boundary, no runtime inference (§0.2).
//
// Three rules this file exists to hold:
//
//  1. The report is SUBORDINATE to the numbers it summarises. It is never the authoritative
//     source: the caption says so before the prose, and the footer says so after it. The
//     sections below prove every figure; this only carries a reader to them.
//  2. A report that is `refused` or `skipped`, or a race that has none, renders NOTHING —
//     not an error, not a placeholder. The page is complete without it, exactly as it is
//     today (§9.3 WP-10). `emptyState` opts into a visible explanation instead.
//  3. Prose is rendered as React TEXT NODES (§8.7). One column per paragraph, so there is
//     no markdown renderer, no dangerouslySetInnerHTML and no auto-linking anywhere near
//     generated text.
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";
import StatusBadge from "@/components/ui/StatusBadge";
import type { RaceReportView } from "@/lib/queries/report";

export const REPORT_SECTION_ID = "report";
export const REPORT_SECTION_TITLE = "Race report";

/** Said before the prose, so subordination is read first, not discovered afterwards. */
export const REPORT_SECTION_CAPTION =
  "A summary of the sections below, not a source of its own. Where the two disagree, believe the sections.";

/** §4.6 — shown only when a reader has explicitly asked why there is no report. */
export const REPORT_EMPTY_TITLE = "No written report for this race";
export const REPORT_EMPTY_REASON =
  "the report is generated once at ingest; this race has not had one generated";

/**
 * §8.6 "Reports, the same standard" — the permanent footer, VERBATIM, calibrated to
 * exactly what the mechanism delivers and no further. The three trailing facts are the
 * report's own provenance and are the only part that varies.
 */
export function reportFooter(report: RaceReportView): string {
  const day = report.generatedAt.slice(0, 10);
  return (
    "Written by Claude from this race's stored numbers. Every figure above appears in the " +
    "sections below and was checked against them before this was saved; the wording was not " +
    `checked by anyone. Generated ${day} · prompt v${report.promptVersion} · assumption set ` +
    `${report.assumptionSetId}.`
  );
}

/**
 * §4.1 — a race whose analytics were partial must SAY SO rather than get a confident
 * narrative. The completeness of the grounding bundle is a property of the numbers, not
 * of the prose, so it is stated by this component and not left to the model.
 */
export function completenessNote(report: RaceReportView): string | null {
  if (report.completeness === "ok") return null;
  if (report.completeness === "partial") {
    return "This race's analytics are partial, so the report was written from an incomplete picture of it.";
  }
  return "This race's analytics were too incomplete to summarise with confidence.";
}

export type RaceReportSectionProps = {
  /** The stored row, or null when this race has no report. */
  report: RaceReportView | null;
  /**
   * Render a visible explanation instead of nothing when there is no report to show.
   * OFF by default: §9.3 requires the race page to be visually unchanged where no
   * report exists, and most races have none.
   */
  emptyState?: boolean;
};

/** The paragraphs, in the fixed order of §4.1, skipping any the model left null. */
function paragraphs(report: RaceReportView): { key: string; text: string }[] {
  const ordered: [string, string | null][] = [
    ["result", report.result],
    ["pace", report.pace],
    ["strategy", report.strategy],
    ["swing", report.swing],
  ];
  const out: { key: string; text: string }[] = [];
  for (const [key, text] of ordered) {
    if (text != null && text.trim() !== "") out.push({ key, text });
  }
  return out;
}

/** True when there is prose to show. `status='ok'` implies a non-null `result` (§6.1). */
export function hasReport(report: RaceReportView | null): boolean {
  return report != null && report.status === "ok" && paragraphs(report).length > 0;
}

export default function RaceReportSection({
  report,
  emptyState = false,
}: RaceReportSectionProps): React.JSX.Element | null {
  if (!hasReport(report) || report == null) {
    // Rule 2: nothing, not an error. A refused report and an absent one are the same
    // thing to a reader — there is no report — and `skippedReason` is an ingest-time
    // diagnostic, not page copy.
    if (!emptyState) return null;
    return (
      <Section id={REPORT_SECTION_ID} title={REPORT_SECTION_TITLE}>
        <EmptyState
          title={REPORT_EMPTY_TITLE}
          reason={report?.skippedReason ?? REPORT_EMPTY_REASON}
        />
      </Section>
    );
  }

  const note = completenessNote(report);
  return (
    <Section
      id={REPORT_SECTION_ID}
      title={REPORT_SECTION_TITLE}
      caption={REPORT_SECTION_CAPTION}
      actions={<StatusBadge status="generated" title={`generated by ${report.model}`} />}
    >
      {/* §8.6 visual grammar: a generated block never looks like a precomputed one. */}
      <div className="border-l-2 border-dashed border-accent/40 pl-4">
        {note ? (
          <p className="mb-3 text-sm font-medium text-accent">{note}</p>
        ) : null}
        {paragraphs(report).map((p) => (
          <p key={p.key} className="mt-3 text-sm leading-relaxed text-fg first:mt-0">
            {p.text}
          </p>
        ))}
        {report.caveats ? (
          <p className="mt-3 text-sm leading-relaxed text-muted">{report.caveats}</p>
        ) : null}
        {report.knownGaps.length > 0 ? (
          <ul className="mt-3 list-disc pl-5 text-sm leading-relaxed text-muted">
            {report.knownGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : null}
        <Caption>{reportFooter(report)}</Caption>
      </div>
    </Section>
  );
}
