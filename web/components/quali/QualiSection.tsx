// QUALI_SPEC §6.2 — the race page's qualifying section. On a sprint weekend both
// sessions render, Q first, each with its own heading; NOTHING about the SQ block is
// degraded (D3). The section is not rendered at all when nothing is ingested (§6.6) —
// that decision belongs to the page, which simply does not mount this component.
//
// UX_SPEC v1.9 §2.2 — the densest block on the race page: five visualisations, each with a
// multi-sentence caption. Every one of those captions is still here, character for
// character; the long ones now sit inside a <Disclosure> under a NEW summary line, and the
// two blocks §2.2 names as evidence (the per-segment strip, qualified-and-started) start
// closed. What never closes: C-QUALI-7, C-QUALI-9 and C-QUALI-10, which are refusals and
// limits on interpretation (§0), and the per-segment block itself whenever it carries one.
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import Section from "@/components/ui/Section";
import GapToPoleBars from "./GapToPoleBars";
import QualiResultTable from "./QualiResultTable";
import QualiSegmentStrip from "./QualiSegmentStrip";
import QualiTeammateTable from "./QualiTeammateTable";
import QualiToGridTable, { shouldRenderToGrid } from "./QualiToGridTable";
import {
  C_QUALI_1,
  C_QUALI_2,
  C_QUALI_3,
  C_QUALI_4,
  C_QUALI_6,
  C_QUALI_7,
  C_QUALI_9,
  PARTIAL_SESSION_NOTE,
  segmentRepairNote,
  C_QUALI_10,
  S_QUALI_1,
  S_QUALI_2,
  S_QUALI_3,
  S_QUALI_4,
  S_QUALI_6,
  qualiSectionSummary,
  segmentStripSummary,
  toGridSummary,
} from "./captions";
import type {
  QualiH2HRow,
  QualiSegmentRow,
  QualiSession,
  QualiToGridRow,
} from "@/lib/queries/quali";

export const QUALI_SECTION_ID = "qualifying";
export const QUALI_SECTION_TITLE = "Qualifying";

export type QualiBlock = {
  session: QualiSession;
  segments: QualiSegmentRow[];
  teammates: QualiH2HRow[];
};

export type QualiSectionProps = { blocks: QualiBlock[]; toGrid: QualiToGridRow[] };

/** A one-line note in the section's own voice: neutral background, no alarm colour. */
function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mt-2 border-l-2 border-grid pl-3 text-xs leading-relaxed text-muted">{children}</p>
  );
}

/**
 * §0 — a long caption moved BEHIND a control, never shortened. `summary` is new copy; the
 * caption itself is passed through untouched and stays in the DOM whether open or closed.
 */
function LongCaption({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Disclosure variant="inline" summary={summary}>
      {children}
    </Disclosure>
  );
}

export default function QualiSection({
  blocks,
  toGrid,
}: QualiSectionProps): React.JSX.Element | null {
  if (blocks.length === 0) return null;
  const drivers = blocks[0].session.rows.length;
  const moved = toGrid.filter((r) => r.placesMoved !== 0).length;
  return (
    <Section
      id={QUALI_SECTION_ID}
      title={QUALI_SECTION_TITLE}
      caption="The official classification, and what the lap data says about it."
      // §2.2 — the classification is an answer, so it is OPEN. Collapsible only so that a
      // reader who has read it can fold the section away; the choice is remembered.
      collapsible
      defaultOpen
      storageKey="race:qualifying"
      summary={qualiSectionSummary(
        blocks.map((b) => b.session.name),
        drivers,
      )}
    >
      {blocks.map(({ session, segments, teammates }) => {
        const unverified = segments.filter((r) => r.verified === false).length;
        const stripDrivers = new Set(segments.map((r) => r.driverId)).size;
        return (
        <div key={session.sessionId} className="mt-8 first:mt-0">
          <h3 className="tower-label text-sm text-fg">{session.name}</h3>
          {session.segmentRepairs > 0 ? <Note>{segmentRepairNote(session.segmentRepairs)}</Note> : null}
          {!session.perSegmentAvailable ? <Note>{PARTIAL_SESSION_NOTE}</Note> : null}

          <div className="mt-3">
            <QualiResultTable session={session} />
            <LongCaption summary={S_QUALI_1}>
              <Caption className="mt-0">{C_QUALI_1}</Caption>
            </LongCaption>
          </div>

          <div className="mt-6">
            <GapToPoleBars session={session} />
            <LongCaption summary={S_QUALI_2}>
              <Caption className="mt-0">{C_QUALI_2}</Caption>
            </LongCaption>
            {/* §0 — a refusal and a limit on interpretation. Never behind a control. */}
            {!session.crossSegmentOk ? <Caption>{C_QUALI_7}</Caption> : null}
            {session.fastestLapDriverId !== null &&
            session.poleDriverId !== null &&
            session.fastestLapDriverId !== session.poleDriverId ? (
              <Caption>{C_QUALI_9}</Caption>
            ) : null}
          </div>

          {session.perSegmentAvailable ? (
            <>
              {/* §2.2 evidence: closed by default — UNLESS it carries C-QUALI-10, which is
                  a refusal and may not be hidden behind a closed control (§0). */}
              <Disclosure
                summary={`Per-segment detail — ${session.name}`}
                hint={segmentStripSummary(stripDrivers, unverified)}
                defaultOpen={unverified > 0}
                storageKey={`race:quali-segments:${session.sessionId}`}
                className="mt-6"
              >
                <QualiSegmentStrip rows={segments} />
                <LongCaption summary={S_QUALI_3}>
                  <Caption className="mt-0">{C_QUALI_3}</Caption>
                </LongCaption>
                {unverified > 0 ? <Caption>{C_QUALI_10}</Caption> : null}
              </Disclosure>
              <div className="mt-6">
                <QualiTeammateTable rows={teammates} kind={session.kind} />
                <LongCaption summary={S_QUALI_4}>
                  <Caption className="mt-0">{C_QUALI_4}</Caption>
                </LongCaption>
              </div>
            </>
          ) : null}
        </div>
        );
      })}

      {shouldRenderToGrid(toGrid) ? (
        <Disclosure
          summary="Qualified and started"
          hint={toGridSummary(moved)}
          storageKey="race:quali-to-grid"
          className="mt-8"
        >
          <QualiToGridTable rows={toGrid} />
          <LongCaption summary={S_QUALI_6}>
            <Caption className="mt-0">{C_QUALI_6}</Caption>
          </LongCaption>
        </Disclosure>
      ) : null}
    </Section>
  );
}
