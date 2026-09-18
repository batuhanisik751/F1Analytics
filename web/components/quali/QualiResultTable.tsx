// QUALI_SPEC §6.2 (a) — the official classification. Pos · driver · team · Q1 · Q2 · Q3
// (the driver's best of the three bolded) · Gap · Gap % · Laps.
//
// The elimination bands are derived per session from `knockedOutIn` — NEVER from a
// hard-coded 15 or 10 — because a session can lose cars to a crash and a sprint
// qualifying can run a different split.
//
// UX_SPEC v1.9 §4.3 — the timing tower's purple/green are MEANING, so a reader with
// colour-vision deficiency must get that meaning too. Each coloured time now also carries a
// shape and a screen-reader word, and the legend under the table names all three states of
// the trio (quickest of the session / this driver's own best / slower than their own best).
// §4.5 — the table gets a real <caption>.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import TermTip from "@/components/ui/TermTip";
import { fmtGap, fmtLapTime, fmtPct } from "@/lib/format";
import type { QualiRow, QualiSegment, QualiSession } from "@/lib/queries/quali";

const DASH = "—";

/** §4.3 — the non-colour channel. A glyph a reader can see, and a word a reader can hear. */
const FASTEST_MARK = "\u25C6"; // ◆ filled diamond: quickest time of the session
const PERSONAL_MARK = "\u25CF"; // ● filled circle: this driver's own best segment

/**
 * The index a band rule is drawn AFTER, mapped to the label of the band that starts on
 * the next row. Derived per session from `knockedOutIn`: a 20-car session that lost two
 * cars in Q1 has its Q1 band start at P15 and its Q2 band end at P14, and a hard-coded
 * 15/10 would draw both rules in the wrong place.
 */
export function bandBreaks(rows: QualiRow[], kind: "Q" | "SQ" = "Q"): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < rows.length - 1; i++) {
    const next = rows[i + 1].knockedOutIn;
    if (next !== null && next !== rows[i].knockedOutIn) {
      out.set(i, `eliminated in ${label(next, kind)}`);
    }
  }
  return out;
}

function label(segment: QualiSegment, kind: "Q" | "SQ" = "Q"): string {
  return `${kind === "SQ" ? "SQ" : "Q"}${segment}`;
}

/**
 * The timing tower's colours ENCODE meaning and are used here for exactly that:
 * `--color-fastest` (purple) is the quickest time in the session, `--color-personal`
 * (green) is this driver's own best of their three segments. Everything else is plain.
 */
function timeCell(
  row: QualiRow,
  segment: QualiSegment,
  sessionBest: number | null,
  waived = false,
): React.ReactNode {
  const v = segment === 1 ? row.q1S : segment === 2 ? row.q2S : row.q3S;
  if (v === null)
    return (
      <span className="text-muted">
        <span aria-hidden>{DASH}</span>
        <span className="sr-only">no time set in this segment</span>
      </span>
    );
  const isSessionBest = sessionBest !== null && v === sessionBest;
  const isPersonalBest = row.bestSegment === segment;
  const colour = isSessionBest
    ? "var(--color-fastest)"
    : isPersonalBest
      ? "var(--color-personal)"
      : undefined;
  // The glyph is the colour-independent channel; the sr-only word is the screen-reader one.
  const mark = isSessionBest ? FASTEST_MARK : isPersonalBest ? PERSONAL_MARK : null;
  const meaning = isSessionBest
    ? "quickest time of the session"
    : isPersonalBest
      ? "this driver's own best segment"
      : null;
  return (
    <span
      className={isPersonalBest ? "font-semibold" : undefined}
      style={colour ? { color: colour } : undefined}
    >
      {mark ? (
        <span aria-hidden className="mr-1 text-[10px] align-[1px]">
          {mark}
        </span>
      ) : null}
      {fmtLapTime(v)}
      {meaning ? <span className="sr-only"> — {meaning}</span> : null}
      {waived ? (
        <>
          <sup aria-hidden className="ml-0.5 text-[10px] text-muted">
            &dagger;
          </sup>
          <span className="sr-only">
            {" "}
            — the official time for this segment and the lap this driver actually set in it do not
            agree; the official time is shown here.
          </span>
        </>
      ) : null}
    </span>
  );
}

export type QualiResultTableProps = { session: QualiSession };

export default function QualiResultTable({ session }: QualiResultTableProps): React.JSX.Element {
  const rows = session.rows;
  const breaks = bandBreaks(rows, session.kind);
  // The driver-segments whose official time disagrees with the lap actually set. The
  // segment strip below shows the lap; this table shows the official time. Marking the
  // cell is the only way in v1.6 to stop the page printing two numbers unannotated.
  const waived = new Set(session.waivedSegments.map((w) => `${w.code}:${w.segment}`));
  const isWaived = (code: string, segment: QualiSegment): boolean =>
    waived.has(`${code}:${segment}`);
  const kind = session.kind;
  const segments = session.segments;
  // The quickest official time anywhere in the session — not necessarily pole's (§4.5).
  const sessionBest = rows.reduce<number | null>(
    (m, r) => (r.bestS !== null && (m === null || r.bestS < m) ? r.bestS : m),
    null,
  );

  const columns: DataTableColumn<QualiRow>[] = [
    {
      key: "pos",
      header: "Pos",
      align: "right",
      className: "w-10 font-semibold",
      render: (r) => r.position,
    },
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip code={r.code} teamColour={r.colour} href={`/driver/${r.code}`} lineStyle={r.lineStyle} />
      ),
    },
    { key: "team", header: "Team", className: "text-muted", render: (r) => r.teamName },
    ...segments.map((s) => ({
      key: `q${s}`,
      header: label(s, kind),
      align: "right" as const,
      render: (r: QualiRow) => timeCell(r, s, sessionBest, isWaived(r.code, s)),
    })),
    {
      key: "gap",
      header: "Gap to pole (s)",
      align: "right",
      render: (r) =>
        r.gapToPoleCommonS === null ? (
          <span className="text-muted">{DASH}</span>
        ) : (
          <span>
            {r.position === 1 ? DASH : fmtGap(r.gapToPoleCommonS)}
            <span className="sr-only">
              {" "}
              measured in the deepest segment this driver and the pole sitter both ran,{" "}
              {label(r.gapToPoleSegment ?? 1, kind)}
            </span>
          </span>
        ),
    },
    {
      // §3.3 — the unit a fan reads, not the abbreviation. The definition is one tap away.
      key: "gappct",
      header: (
        <>
          Gap <TermTip term="pp" placement="bottom">% of a lap</TermTip>
        </>
      ),
      align: "right",
      className: "text-muted",
      render: (r) => (r.position === 1 ? DASH : fmtPct(r.gapToPoleCommonPct)),
    },
    {
      key: "laps",
      header: "Laps set",
      align: "right",
      className: "text-muted",
      render: (r) => r.nReprLaps,
    },
  ];

  return (
    <div className="space-y-0">
      <DataTable
        caption={`${session.name} classification: where each driver was placed, their time in each segment, their gap to pole, and how many laps they set.`}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.driverId}
        rowAccent={(r) => r.colour}
        rowClassName={(r, i) =>
          [breaks.has(i) ? "border-b-2 border-b-grid" : "", r.setATime ? "" : "opacity-60"]
            .filter(Boolean)
            .join(" ")
        }
        emptyTitle="No qualifying classification"
        emptyReason="quali_results has no rows for this session"
      />
      {/* §4.3 — the legend names all three states of the delta trio in words, so the
          purple/green coding is never the only way to read the table. */}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden style={{ color: "var(--color-fastest)" }}>
            {FASTEST_MARK}
          </span>
          quickest time of the session
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden style={{ color: "var(--color-personal)" }}>
            {PERSONAL_MARK}
          </span>
          this driver&rsquo;s own best of their segments
        </span>
        <span>no marker: slower than this driver&rsquo;s own best</span>
      </p>
      {waived.size > 0 ? (
        <p className="mt-2 text-[11px] text-muted">
          &dagger; The official time for this segment and the lap this driver actually set in it
          do not agree. The official time is shown here; the per-segment chart below shows the lap.
        </p>
      ) : null}
      {breaks.size > 0 ? (
        <p className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-muted">
          {[...breaks.entries()].map(([i, text]) => (
            <span key={i}>
              {text}: P{rows[i + 1].position} and below
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
