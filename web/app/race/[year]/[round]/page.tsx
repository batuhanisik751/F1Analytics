// SPEC §4.3 — /race/[year]/[round]. getRaceHeader first, then every other query in one
// Promise.all on header.sessionId. Section order: result → pace → strategy → why → trust.
// Empty analytics render <EmptyState> with the reason from analytics_status; the page only
// calls notFound() when the sessions row itself is missing.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { cache } from "react";
import PreviewHazardSection, {
  PREVIEW_HAZARD_HEADER_CAPTION,
  PREVIEW_HAZARD_TITLE,
} from "@/components/preview/PreviewHazardSection";
import PreviewOrderSection, {
  PREVIEW_ORDER_HEADER_CAPTION,
  PREVIEW_ORDER_TITLE,
} from "@/components/preview/PreviewOrderSection";
import PreviewOvertakingSection, {
  PREVIEW_OVERTAKING_HEADER_CAPTION,
  PREVIEW_OVERTAKING_TITLE,
} from "@/components/preview/PreviewOvertakingSection";
import AssumptionsPanel from "@/components/race/AssumptionsPanel";
import DegradationSection from "@/components/race/DegradationSection";
import ExclusionTable from "@/components/race/ExclusionTable";
import HashOpen from "@/components/race/HashOpen";
import { splitWarnings } from "@/components/race/warnings";
import PaceSection from "@/components/race/PaceSection";
import RaceHeader from "@/components/race/RaceHeader";
import RaceMomentsSection from "@/components/race/RaceMomentsSection";
import RaceReportSection, {
  REPORT_SECTION_ID,
  REPORT_SECTION_TITLE,
  hasReport,
} from "@/components/race/RaceReportSection";
import QualiSection, {
  QUALI_SECTION_ID,
  QUALI_SECTION_TITLE,
  type QualiBlock,
} from "@/components/quali/QualiSection";
import CircuitQualiHistoryPanel, {
  CIRCUIT_QUALI_PANEL_TITLE,
} from "@/components/quali/CircuitQualiHistoryPanel";
import { C_QUALI_8 } from "@/components/quali/captions";
import ResultsTable from "@/components/race/ResultsTable";
import WinProbabilitySection from "@/components/race/WinProbabilitySection";
import SensitivityTable from "@/components/race/SensitivityTable";
import SimSection from "@/components/race/SimSection";
import StintSection from "@/components/race/StintSection";
import TeammateSection from "@/components/race/TeammateSection";
import TraceSection from "@/components/race/TraceSection";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";
import { SIM_SECTION_ID, SIM_SECTION_SUBTITLE, SIM_SECTION_TITLE } from "@/components/sim/simMeta";
import {
  getAssumptions,
  getDegradation,
  getExclusionReport,
  getFuelSensitivity,
  getPaceRanking,
  getRaceColours,
  getRaceHeader,
  getRaceResults,
  getRaceMoments,
  getRaceTrace,
  getOptimalStint,
  getStints,
  getTeammateDeltas,
  getWinProbability,
  getWinProbSwings,
  getWinProbTrust,
  roundHasTelemetryTab,
} from "@/lib/queries/race";
import { getOdiStrip, getPreviewOrder, getPreviewRound } from "@/lib/queries/preview";
import Caption from "@/components/ui/Caption";
import {
  getCircuitQualiHistory,
  getQualiForRound,
  getQualiSegments,
  getQualiTeammates,
  getQualiToGrid,
} from "@/lib/queries/quali";
import { getRaceReport } from "@/lib/queries/report";
import { getSimModel } from "@/lib/queries/sim";

export const dynamic = "force-dynamic";

// Deduplicates the header query between generateMetadata and the page within one request.
const cachedHeader = cache((year: number, round: number) => getRaceHeader(year, round));

function parseRoute(year: string, round: string): { year: number; round: number } | null {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(round)) return null;
  return { year: Number(year), round: Number(round) };
}

/** Reason shown in an EmptyState: the first non-ok analytics_status entry among `keys`. */
function reasonFor(status: Record<string, string> | undefined, ...keys: string[]): string {
  if (!status) return "no analytics recorded for this session";
  for (const k of keys) {
    const v = status[k];
    if (v && v !== "ok") return `${k}: ${v}`;
  }
  return "no rows stored for this section";
}

/**
 * MODE1_SPEC §7.6 lists three distinct optimal-stint empty reasons (no dry fits / flat
 * slope / no pit loss), but `analytics_status.optimal_stint` only carries ok|empty|error
 * (§5.5), so the three cannot be told apart from the stored state. Rows present → no
 * reason; a guarded error → say so; otherwise DegradationSection's own default
 * ("no dry-tyre degradation fits in this race") applies.
 */
function optimalStintReason(
  status: Record<string, string> | undefined,
  rowCount: number,
): string | null {
  if (rowCount > 0) return null;
  const v = status?.["optimal_stint"];
  return v && v !== "ok" && v !== "empty" ? `optimal_stint: ${v}` : null;
}

/** How many analytics steps did not finish. Non-zero is a refusal, so its section stays open (§0). */
function notOkCount(status: Record<string, string> | undefined): number {
  return status ? Object.values(status).filter((v) => v !== "ok").length : 0;
}

/**
 * UX_SPEC §2.3 — "Modelling assumptions" closed must still say what is inside it: how many
 * constants, and when they were recorded. `assumption_sets.params` is the authoritative count.
 */
function assumptionsSummary(view: { params: Record<string, unknown>; ingestedAt: string } | null): string {
  if (!view) return "The constants behind every number on this page — none recorded for this round";
  const n = Object.keys(view.params).length;
  // Postgres hands back `2026-09-14 21:01:58.98408+00`: a space instead of `T`, and a two-digit
  // offset that `Date` rejects in some engines. Both are normalised before parsing.
  const iso = (view.ingestedAt.includes("T") ? view.ingestedAt : view.ingestedAt.replace(" ", "T"))
    .replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  const when = Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${n} constants every number on this page depends on${when ? `, recorded ${when}` : ""}`;
}

/**
 * QUALI_SPEC §6.2 — the qualifying blocks of a round. Returns an empty array when
 * neither Q nor SQ is ingested, and the page then does not mount the section at all
 * (§6.6 row 1: no placeholder, no "coming soon"). A `partial` session (D8's runtime gate
 * fired) comes back with empty per-segment arrays and `perSegmentAvailable` false.
 */
async function getQualiBlocks(year: number, round: number): Promise<QualiBlock[]> {
  const sessions = await getQualiForRound(year, round);
  return Promise.all(
    sessions.map(async (session) => {
      if (!session.perSegmentAvailable) return { session, segments: [], teammates: [] };
      const [segments, teammates] = await Promise.all([
        getQualiSegments(session.sessionId),
        getQualiTeammates(session.sessionId),
      ]);
      return { session, segments, teammates };
    }),
  );
}

const SECTIONS = [
  { id: "results", title: "Results" },
  { id: "winprob", title: "Win probability" },
  { id: "pace", title: "Fuel-corrected race pace" },
  { id: "strategy", title: "Tyre strategy" },
  { id: "degradation", title: "Tyre degradation" },
  { id: SIM_SECTION_ID, title: SIM_SECTION_TITLE },
  { id: "trace", title: "Race trace" },
  { id: "moments", title: "Race moments" },
  { id: "teammates", title: "Teammate head-to-head" },
  { id: "sensitivity", title: "Fuel-constant sensitivity" },
  { id: "exclusions", title: "What was thrown away" },
  { id: "assumptions", title: "Modelling assumptions" },
] as const;

// MODE1_SPEC §7.4 — the preview branch's own nav.
const PREVIEW_SECTIONS = [
  { id: "preview-hazard", title: PREVIEW_HAZARD_TITLE },
  { id: "preview-overtaking", title: PREVIEW_OVERTAKING_TITLE },
  { id: "preview-order", title: PREVIEW_ORDER_TITLE },
  { id: "assumptions", title: "Modelling assumptions" },
] as const;

/**
 * `-mt-4` closes the gap when the nav follows `RaceHeader` directly, which is the race
 * branch. The preview branch puts a "scheduled, not yet raced" `<p>` in between, and that
 * paragraph carries its own `-mt-4`; the nav's then bit into it and the two lines
 * overlapped by 8px (measured on /race/2026/16). `pullUp={false}` is the preview branch.
 */
function SectionNav({
  sections,
  pullUp = true,
  tabs = [],
}: {
  sections: readonly { id: string; title: string }[];
  pullUp?: boolean;
  /**
   * TELEMETRY_SPEC §5.5 calls the telemetry view "a new tab on the existing session page",
   * but it is a separate route, so it cannot be a `#id` anchor. These render after the
   * anchors, separated by a divider, as real cross-page links.
   */
  tabs?: readonly { href: string; title: string }[];
}): React.JSX.Element {
  return (
    <nav
      aria-label="Sections"
      className={`${pullUp ? "-mt-4" : "mt-1"} mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted`}
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="inline-flex min-h-[32px] items-center hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {s.title}
        </a>
      ))}
      {tabs.length > 0 ? <span aria-hidden="true">·</span> : null}
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="inline-flex min-h-[32px] items-center hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t.title}
        </Link>
      ))}
    </nav>
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/race/[year]/[round]">): Promise<Metadata> {
  const raw = await params;
  const parsed = parseRoute(raw.year, raw.round);
  if (!parsed) return { title: "Race not found" };
  const header = await cachedHeader(parsed.year, parsed.round);
  return {
    title: header ? `${header.eventName} ${header.year}` : `Round ${parsed.round}, ${parsed.year}`,
  };
}

export default async function RacePage({
  params,
}: PageProps<"/race/[year]/[round]">): Promise<React.JSX.Element> {
  const raw = await params;
  const parsed = parseRoute(raw.year, raw.round);
  if (!parsed) notFound();

  const header = await cachedHeader(parsed.year, parsed.round);
  if (!header) notFound();

  if (header.ingestStatus === "failed") {
    return (
      <>
        <RaceHeader header={header} />
        <Section title="Ingest failed" caption="FastF1 data for this session could not be loaded or processed.">
          <EmptyState title="Data unavailable for this race" reason="session_ingests.status = failed">
            {header.ingestError ? (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-grid bg-bg p-3 text-left font-mono text-xs text-muted">
                {header.ingestError}
              </pre>
            ) : null}
            <p className="mt-3">
              Re-run <code className="font-mono text-fg">python -m f1lab.ingest --season {header.year} --round {header.round}</code> once the data is available.
            </p>
          </EmptyState>
        </Section>
      </>
    );
  }

  const id = header.sessionId;
  const results = await getRaceResults(id);

  // MODE1_SPEC §3.1 — the branch is a DATA question, never a date question: no `results`
  // rows for the round's race session means the weekend preview renders instead of the
  // race sections. A race that ran but has not been ingested shows the preview, which is
  // correct — the app knows nothing about it yet.
  if (results.length === 0) {
    const [preview, order, odiTicks, trust, assumptions, qualiBlocks, qualiToGrid] =
      await Promise.all([
        getPreviewRound(parsed.year, parsed.round),
        getPreviewOrder(parsed.year, parsed.round),
        getOdiStrip(),
        getWinProbTrust(),
        getAssumptions(id),
        // Qualifying is part of a weekend, not of a race: a round whose race has not been
        // ingested can still have a Q session, and it renders here on its own terms.
        getQualiBlocks(parsed.year, parsed.round),
        getQualiToGrid(parsed.year, parsed.round),
      ]);
    // §6.4 — the panel needs the circuit and the drivers entered, both of which come
    // from queries already awaited above, so it is a second small await, not a fifth
    // member of the batch.
    const circuitQuali =
      preview?.circuitKey != null && order.length > 0
        ? await getCircuitQualiHistory(
            preview.circuitKey,
            order.map((o) => o.driverId),
            { year: parsed.year, round: parsed.round },
          )
        : [];

    return (
      <>
        <RaceHeader header={header} />
        <HashOpen />

        <p className="-mt-4 mb-2 text-sm text-muted">
          Scheduled, not yet raced — this is a weekend preview built from circuit history and this
          season&rsquo;s results so far, not a report on a race that has happened.
          {header.ingestStatus === "pending" ? (
            <>
              {" "}
              Once it runs, ingest it with{" "}
              <code className="font-mono text-fg">
                python -m f1lab.ingest --season {header.year} --round {header.round}
              </code>
              .
            </>
          ) : null}
        </p>

        <SectionNav
          sections={[
            ...(qualiBlocks.length > 0
              ? [{ id: QUALI_SECTION_ID, title: QUALI_SECTION_TITLE }]
              : []),
            ...(circuitQuali.length > 0
              ? [{ id: "quali-history", title: CIRCUIT_QUALI_PANEL_TITLE }]
              : []),
            ...PREVIEW_SECTIONS,
          ]}
          pullUp={false}
        />

        <QualiSection blocks={qualiBlocks} toGrid={qualiToGrid} />

        {/* QUALI_SPEC §6.4 — history only. NOT an input to the forecast below, and it does
            not move MODE1 §3.5's 0.653 ceiling (§5.5). Rendered above the forecast and
            visually separate from it; §6.6 drops the panel when no driver has a session. */}
        {circuitQuali.length > 0 ? (
          <Section
            id="quali-history"
            title={CIRCUIT_QUALI_PANEL_TITLE}
            collapsible
            defaultOpen={false}
            storageKey="race:quali-history"
            summary={`How ${circuitQuali.length} of this weekend's drivers have qualified here before — history only, not an input to the forecast below`}
          >
            <CircuitQualiHistoryPanel rows={circuitQuali} />
            <Caption>{C_QUALI_8}</Caption>
          </Section>
        ) : null}

        <Section
          id="preview-hazard"
          title={PREVIEW_HAZARD_TITLE}
          caption={PREVIEW_HAZARD_HEADER_CAPTION}
          collapsible
          storageKey="preview:hazard"
          summary="How often a safety car has come out at this circuit before, and what that has cost"
        >
          <PreviewHazardSection preview={preview} />
        </Section>

        <Section
          id="preview-overtaking"
          title={PREVIEW_OVERTAKING_TITLE}
          caption={PREVIEW_OVERTAKING_HEADER_CAPTION}
          collapsible
          storageKey="preview:overtaking"
          summary="How hard this circuit is to pass on, scored 0 to 100 against every other circuit"
        >
          <PreviewOvertakingSection preview={preview} ticks={odiTicks} />
        </Section>

        <Section
          id="preview-order"
          title={PREVIEW_ORDER_TITLE}
          caption={PREVIEW_ORDER_HEADER_CAPTION}
          collapsible
          storageKey="preview:order"
          summary={`Where all ${order.length} drivers are expected to finish, from form and reliability alone — no qualifying has happened yet`}
        >
          <PreviewOrderSection
            rows={order}
            preview={preview}
            loroBrier={trust?.scopes.find((s) => s.scope === "loro")?.brier ?? null}
            year={header.year}
          />
        </Section>

        <Section
          id="assumptions"
          title="Modelling assumptions"
          caption="Every number on this page depends on these constants; they are stored with the data, not in the web app."
          collapsible
          defaultOpen={notOkCount(assumptions?.analyticsStatus) > 0}
          storageKey="race:assumptions"
          summary={assumptionsSummary(assumptions)}
        >
          <AssumptionsPanel
            view={assumptions}
            reason="this round has not been ingested, so no assumption snapshot is stored for it"
          />
        </Section>
      </>
    );
  }

  const [
    colours,
    pace,
    stintData,
    deg,
    trace,
    teammates,
    sensitivity,
    exclusion,
    assumptions,
    sim,
    winProb,
    swings,
    trust,
    moments,
    optimalStint,
    // MODE3_SPEC §0.2 — a plain Drizzle read of a precomputed row on the existing
    // DATABASE_URL pool. No fetch, no secret, no runtime inference: the report was written
    // in Python at ingest. The assumption set is deliberately NOT passed — resolving it
    // inside the query keeps this one Promise.all (§9.3 WP-10) instead of forcing a second
    // await on `assumptions`, which is fetched in this same batch.
    report,
    qualiBlocks,
    qualiToGrid,
    // v1.7 §5.6 — whether this round has a telemetry tab at all. In the same batch, so it
    // costs no extra round trip on the page's critical path.
    hasTelemetry,
  ] = await Promise.all([
      getRaceColours(id),
      getPaceRanking(id),
      getStints(id),
      getDegradation(id),
      getRaceTrace(id),
      getTeammateDeltas(id),
      getFuelSensitivity(id),
      getExclusionReport(id),
      getAssumptions(id),
      getSimModel(id),
      getWinProbability(id),
      getWinProbSwings(id),
      getWinProbTrust(),
      getRaceMoments(id),
      getOptimalStint(id),
      getRaceReport(id),
      getQualiBlocks(parsed.year, parsed.round),
      getQualiToGrid(parsed.year, parsed.round),
      roundHasTelemetryTab(parsed.year, parsed.round),
    ]);
  const status = assumptions?.analyticsStatus;
  const year = header.year;
  // §3.3 — the `⚠ sim: …` diagnostics move out of the page header and into the simulator
  // section, where they are rewritten as sentences. Everything else stays in the header: the
  // sections those warnings belong to are not owned by this page (quali) or live on another
  // route (telemetry), and §0 forbids dropping them to tidy the header.
  const { sim: simNotes, other: headerWarnings } = splitWarnings(header.warnings);
  const excludedLaps = exclusion.rawLaps - (assumptions?.cleanLaps ?? exclusion.rawLaps);

  // The anchor only exists when the section does. A `refused`/`skipped`/absent report
  // renders nothing (§9.3 WP-10), so a permanent nav entry would be a dead link on every
  // race that has no report — which is currently all of them.
  const sections = [
    ...(hasReport(report) ? [{ id: REPORT_SECTION_ID, title: REPORT_SECTION_TITLE }] : []),
    // QUALI_SPEC §6.6 row 1: no qualifying data means no section and therefore no nav entry.
    ...(qualiBlocks.length > 0 ? [{ id: QUALI_SECTION_ID, title: QUALI_SECTION_TITLE }] : []),
    ...SECTIONS,
  ];

  return (
    <>
      <RaceHeader header={header} warnings={headerWarnings} />
      {/* §2.2 — a nav link to a collapsed section must OPEN it, not scroll to a closed stub. */}
      <HashOpen />

      <SectionNav
        sections={sections}
        tabs={
          // v1.7 TELEMETRY_SPEC §5.5 / §5.6. Conditional, not decorative: a round the
          // telemetry pass has never touched has no tab at all, and the route 404s.
          hasTelemetry
            ? [{ href: `/race/${header.year}/${header.round}/telemetry`, title: "Telemetry" }]
            : []
        }
      />

      {/* Renders its own <Section>, and returns null outright when there is no report — so
          this line must NOT be wrapped, or every report-less race grows an empty heading. */}
      <RaceReportSection report={report} />

      {/* §6.2 — above the existing race content; returns null when nothing is ingested. */}
      <QualiSection blocks={qualiBlocks} toGrid={qualiToGrid} />

      {/* §2.2 — OPEN: the headline result and the charts a reader came for. They are collapsible
          so a returning reader can fold what they have already read, but they start open. */}
      <Section
        id="results"
        title="Results"
        caption="Official classification from the timing API."
        collapsible
        storageKey="race:results"
        summary={`Where all ${results.length} cars finished, in the official order`}
      >
        <ResultsTable rows={results} year={year} reason="no results rows stored for this session" />
      </Section>

      <Section
        id="winprob"
        title="Win probability"
        caption="A trained classifier's chance of winning for every car on every lap, with the calibration evidence directly underneath."
        collapsible
        storageKey="race:winprob"
        summary={
          winProb
            ? `Each car's chance of winning on every one of ${winProb.laps.length} laps, and how often the model has been right before`
            : "Each car's chance of winning lap by lap, and how often the model has been right before"
        }
      >
        <WinProbabilitySection
          winProb={winProb}
          swings={swings}
          trust={trust}
          reason={reasonFor(status, "win_probability")}
        />
      </Section>


      <Section
        id="pace"
        title="Fuel-corrected race pace"
        caption="Who was actually fast: median fuel-corrected lap time per driver, fastest first."
        collapsible
        storageKey="race:pace"
        summary={`Who was actually quick once the weight of fuel is taken out — ${pace.length} drivers ranked`}
      >
        <PaceSection rows={pace} colours={colours} year={year} reason={reasonFor(status, "pace_ranking")} />
      </Section>

      <Section
        id="strategy"
        title="Tyre strategy"
        caption="One row per driver, one bar per stint, coloured by compound."
        collapsible
        storageKey="race:strategy"
        summary={`Every tyre every car ran — ${stintData.stints.length} stints across ${stintData.order.length} drivers`}
      >
        <StintSection
          order={stintData.order}
          stints={stintData.stints}
          totalLaps={header.totalLaps}
          colours={colours}
          reason={reasonFor(status, "stints")}
        />
      </Section>

      <Section
        id="degradation"
        title="Tyre degradation"
        caption="Fuel-corrected lap time against tyre age, with a pooled slope per compound."
        collapsible
        // §2.2 lists degradation detail as closed — but §0 outranks it: with no fit and no
        // optimal stint the section is a refusal, and a refusal may not start closed.
        defaultOpen={deg.fits.length === 0 || optimalStint.length === 0}
        storageKey="race:degradation"
        summary={
          deg.fits.length > 0
            ? `How fast each tyre gave up — a wear rate fitted for ${deg.fits.length} compound${deg.fits.length === 1 ? "" : "s"} from ${deg.points.length.toLocaleString("en-GB")} clean laps`
            : "How fast each tyre gave up — no compound had enough clean laps in this race to fit one"
        }
      >
        <DegradationSection
          points={deg.points}
          fits={deg.fits}
          perStint={deg.perStint}
          colours={colours}
          year={year}
          optimalStint={optimalStint}
          optimalStintReason={optimalStintReason(status, optimalStint.length)}
          reason={reasonFor(status, "compound_degradation", "degradation_fits", "pace_ranking")}
        />
      </Section>

      <Section
        id={SIM_SECTION_ID}
        title={SIM_SECTION_TITLE}
        caption={SIM_SECTION_SUBTITLE}
        collapsible
        storageKey="race:simulator"
        summary={
          simNotes.length > 0
            ? `Re-run one driver's strategy and see the clean-air time it would have gained or lost — including ${simNotes.length} thing${simNotes.length === 1 ? "" : "s"} the simulator could not measure here`
            : "Re-run one driver's strategy and see the clean-air time it would have gained or lost"
        }
      >
        <SimSection
          payload={sim}
          colours={colours}
          year={year}
          reason={reasonFor(status, "sim")}
          notes={simNotes}
        />
      </Section>

      <Section
        id="trace"
        title="Race trace"
        caption="Gap to the leader at the end of every lap; the leader runs along the top."
        collapsible
        storageKey="race:trace"
        summary={`The shape of the race: every car's gap to the leader over ${trace.totalLaps} laps`}
      >
        <TraceSection
          totalLaps={trace.totalLaps}
          series={trace.series}
          lapStatus={trace.lapStatus}
          colours={colours}
          moments={moments.shown}
          reason={reasonFor(status, "lap_status")}
        />
      </Section>

      <Section
        id="moments"
        title="Race moments"
        caption="The moments marked on the trace above, in order of how far they stand out from the field."
        collapsible
        // A per-moment breakdown of the chart above: evidence, so it starts closed (§2.2).
        defaultOpen={false}
        storageKey="race:moments"
        summary={
          `${moments.shown.length} moment${moments.shown.length === 1 ? "" : "s"} marked on the trace above` +
          (moments.hiddenCount > 0
            ? `, plus ${moments.hiddenCount} that did not stand out far enough from the field to mark`
            : "")
        }
      >
        <RaceMomentsSection moments={moments} reason={reasonFor(status, "race_moment")} />
      </Section>

      <Section
        id="teammates"
        title="Teammate head-to-head"
        caption="Intra-team race-pace gap in percent of lap time — the atom of any driver-vs-car model."
        collapsible
        // §0 — `unpaired` is a list of teams this race cannot compare. That is a refusal, so the
        // section may not start closed whenever one is present.
        defaultOpen={teammates.unpaired.length > 0}
        storageKey="race:teammates"
        summary={
          `Same car, two drivers: the race-pace gap inside ${teammates.rows.length} team${teammates.rows.length === 1 ? "" : "s"}` +
          (teammates.unpaired.length > 0
            ? `, and ${teammates.unpaired.length} team${teammates.unpaired.length === 1 ? "" : "s"} this race cannot compare`
            : "")
        }
      >
        <TeammateSection
          rows={teammates.rows}
          unpaired={teammates.unpaired}
          colours={colours}
          reason={reasonFor(status, "teammate_deltas", "pace_ranking")}
        />
      </Section>

      <Section
        id="sensitivity"
        title="Fuel-constant sensitivity"
        caption="Does the ranking survive the assumption used to produce it?"
        collapsible
        defaultOpen={false}
        storageKey="race:sensitivity"
        // §2.3 — the closed line carries the limit on interpretation, not just a label.
        summary={
          sensitivity.rows.length > 0
            ? `${sensitivity.movers} of ${sensitivity.rows.length} pace placings change when the fuel assumption changes — those gaps are too small to call`
            : "Whether the pace order survives the fuel assumption behind it — not computed for this race"
        }
      >
        <SensitivityTable
          values={sensitivity.values}
          baseValue={sensitivity.baseValue}
          rows={sensitivity.rows}
          movers={sensitivity.movers}
          year={year}
          reason={reasonFor(status, "fuel_sensitivity", "pace_ranking")}
        />
      </Section>

      <Section
        id="exclusions"
        title="What was thrown away"
        caption="How many laps each cleaning rule removed, and why."
        collapsible
        defaultOpen={false}
        storageKey="race:exclusions"
        summary={
          exclusion.rows.length > 0
            ? `${exclusion.rows.length} cleaning rules, and the ${excludedLaps.toLocaleString("en-GB")} of ${exclusion.rawLaps.toLocaleString("en-GB")} laps they removed before anything on this page was measured`
            : "The cleaning rules that decide which laps count — none recorded for this race"
        }
      >
        <ExclusionTable
          rawLaps={exclusion.rawLaps}
          rows={exclusion.rows}
          reason={reasonFor(status, "lap_exclusion_report")}
        />
      </Section>

      <Section
        id="assumptions"
        title="Modelling assumptions"
        caption="Every number on this page depends on these constants; they are stored with the data, not in the web app."
        collapsible
        // §0 — when an analytics step did not finish, this panel is where the page says so.
        defaultOpen={notOkCount(status) > 0}
        storageKey="race:assumptions"
        summary={assumptionsSummary(assumptions)}
      >
        <AssumptionsPanel view={assumptions} reason="no session_ingests row for this session" />
      </Section>
    </>
  );
}
