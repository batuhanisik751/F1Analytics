"use client";
// TELEMETRY_SPEC v1.7 §5.4 — V4, the corner report card. A timing-tower-styled TABLE,
// not a chart: this is the only visual whose numbers a fan can copy into an argument,
// and the only one the ask box can also produce (§2.6).
//
// No ECharts import: a table is a table (SPEC §3.4 is about the charting stack, and
// this component never enters it).
//
// T11: the semantic timing-tower tokens appear nowhere here. A quicker apex is not a
// "personal best" and a slower one is not "off the pace" — they are two laps.
import { useMemo, useState } from "react";
import {
  C_BRK_1,
  C_BRK_2,
  C_BRK_4,
  C_BRK_5,
  C_BRK_6,
  C_BRK_7,
  C_TEL_5,
  offTheBrakesCell,
  type OffTheBrakesCell,
  type TrailStatus,
} from "@/lib/telemetry/captions";

/** One stored corner for one driver — the shape `getCornerSpeeds` returns (§5.5). */
export type CornerCardRow = {
  driverId: string;
  cornerNumber: number;
  cornerLetter: string;
  apexSpeedKph: number;
  apexDistanceM: number;
  entrySpeedKph: number;
  exitSpeedKph: number;
  /** Corners sharing this are ONE braking event and are bracketed together (§5.4). */
  brakeZoneIdx: number | null;
  /** NULL means the corner was taken flat, NOT that the data is missing (C-TEL-6). */
  brakePointM: number | null;
  brakeDistanceM: number | null;
  throttlePointM: number | null;
  timeInCornerS: number;
  // ---- GAPFILL §5.2 — the "off the brakes" column. Where the brake came OFF.
  /** apex - release. NEGATIVE means the brake was still on at the apex (C-BRK-1). */
  brakeReleaseToApexM: number | null;
  /**
   * WHICH of six things happened, straight from the database (§4.1). The card never
   * infers a reason from a NULL, so a blank cell can always say why it is blank.
   */
  trailStatus: TrailStatus;
};

export type CornerCardDriver = {
  driverId: string;
  code: string;
  colour: string;
};

export type CornerCardProps = {
  rows: readonly CornerCardRow[];
  /** One driver on a race page, two on Q/SQ. A is first and is the reference column. */
  drivers: readonly CornerCardDriver[];
  /**
   * §5.2.2 — the off-the-brakes column inherits C-TEL-5: no cross-driver braking
   * comparison on a race lap. On 'R' the column is absent and C-TEL-5 stands in its
   * place, because an absent control reads as a refusal and a disabled one reads as a
   * missing feature (T10). Optional so the component still renders where the caller
   * has not yet been given the session kind; the brake-shape block then shows nothing,
   * which fails closed rather than open.
   */
  sessionKind?: "Q" | "SQ" | "R";
  className?: string;
};

export type CornerKey = string;

export function cornerKey(number: number, letter: string): CornerKey {
  return `${number}${letter ?? ""}`;
}

export type CornerCardLine = {
  key: CornerKey;
  cornerNumber: number;
  cornerLetter: string;
  /** Per driverId; a driver with no row for this corner is simply absent from the map. */
  byDriver: Map<string, CornerCardRow>;
  /** A's brake zone, which is what groups the complex (the reference column). */
  brakeZoneIdx: number | null;
  /** `apex(A) - apex(B)` in km/h, or null with fewer than two drivers. */
  deltaApexKph: number | null;
};

/**
 * Pivots the flat rows into one line per corner, in track order, and computes Δapex.
 * Pure and exported so the grouping can be asserted without a browser.
 */
export function cornerLines(
  rows: readonly CornerCardRow[],
  drivers: readonly CornerCardDriver[],
): CornerCardLine[] {
  const byKey = new Map<CornerKey, CornerCardLine>();
  for (const r of rows) {
    const key = cornerKey(r.cornerNumber, r.cornerLetter);
    let line = byKey.get(key);
    if (!line) {
      line = {
        key,
        cornerNumber: r.cornerNumber,
        cornerLetter: r.cornerLetter,
        byDriver: new Map(),
        brakeZoneIdx: null,
        deltaApexKph: null,
      };
      byKey.set(key, line);
    }
    line.byDriver.set(r.driverId, r);
  }
  const a = drivers[0]?.driverId;
  const b = drivers[1]?.driverId;
  const lines = [...byKey.values()].sort(
    (p, q) => p.cornerNumber - q.cornerNumber || p.cornerLetter.localeCompare(q.cornerLetter),
  );
  for (const line of lines) {
    const ra = a ? line.byDriver.get(a) : undefined;
    const rb = b ? line.byDriver.get(b) : undefined;
    line.brakeZoneIdx = ra?.brakeZoneIdx ?? null;
    line.deltaApexKph = ra && rb ? ra.apexSpeedKph - rb.apexSpeedKph : null;
  }
  return lines;
}

/**
 * §5.4 — corners sharing a `brake_zone_idx` are ONE complex. Measured at Monza:
 * T1+T2 share zone 0 and T8+T9+T10 share zone 5. A complex is a bracket, not a merge:
 * every corner keeps its own row and its own apex.
 */
export function complexIndex(lines: readonly CornerCardLine[]): Map<CornerKey, number> {
  const counts = new Map<number, number>();
  for (const l of lines) {
    if (l.brakeZoneIdx === null) continue;
    counts.set(l.brakeZoneIdx, (counts.get(l.brakeZoneIdx) ?? 0) + 1);
  }
  const out = new Map<CornerKey, number>();
  for (const l of lines) {
    if (l.brakeZoneIdx !== null && (counts.get(l.brakeZoneIdx) ?? 0) > 1) {
      out.set(l.key, l.brakeZoneIdx);
    }
  }
  return out;
}

/**
 * §5.2 — one row's "off the brakes" cell. Pure, exported, and the only place the column
 * is produced: three states (a number, taken flat, a named refusal) and no fourth.
 */
export function offTheBrakes(row: CornerCardRow | undefined): OffTheBrakesCell | null {
  if (!row) return null;
  return offTheBrakesCell(row);
}

function m(v: number | null): string {
  // C-TEL-6: a blank braking point means the corner was taken FLAT, not that the data
  // is missing. An em dash, never a 0 — absent is not zero (§0.3).
  return v === null ? "—" : `${Math.round(v)} m`;
}

export default function CornerCard({
  rows,
  drivers,
  sessionKind,
  className,
}: CornerCardProps): React.JSX.Element {
  const [sortByDelta, setSortByDelta] = useState(false);
  // §5.2.2: on a race lap the column is not shown at all.
  const showBrakeRelease = sessionKind !== undefined && sessionKind !== "R";
  const lines = useMemo(() => cornerLines(rows, drivers), [rows, drivers]);
  const complexes = useMemo(() => complexIndex(lines), [lines]);
  const twoUp = drivers.length > 1;

  const ordered = useMemo(() => {
    if (!sortByDelta) return lines;
    // "Where was he actually quicker" is one click from an answer in words (§5.4).
    return [...lines].sort(
      (p, q) => Math.abs(q.deltaApexKph ?? 0) - Math.abs(p.deltaApexKph ?? 0),
    );
  }, [lines, sortByDelta]);

  if (lines.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed border-grid bg-surface/50 px-4 py-6 text-center text-sm text-muted ${className ?? ""}`}>
        No corner geometry stored for this circuit.
      </div>
    );
  }

  return (
    <div className={className ?? ""}>
      {/* §5.2 — the header block. C-BRK-7 (scope) and C-BRK-2 (what the column is not)
          sit ABOVE the table beside the column they qualify, and C-BRK-6 (the confound
          disclosure) sits above the column, because a caveat placed under a table is
          read after the conclusion has already been drawn. */}
      {showBrakeRelease ? (
        <div className="mb-3 space-y-2 border-l-2 border-grid pl-3 text-xs leading-relaxed text-muted">
          <p>{C_BRK_7}</p>
          <p>{C_BRK_2}</p>
          <p>{C_BRK_6}</p>
        </div>
      ) : sessionKind === "R" ? (
        <div className="mb-3 border-l-2 border-grid pl-3 text-xs leading-relaxed text-muted">
          <p>{C_TEL_5}</p>
        </div>
      ) : null}
      {/* UX_SPEC §4.5 — the scroll container is focusable, so a keyboard reader can scroll
          it with the arrow keys, and it is labelled so they know what they have landed in. */}
      <div
        role="region"
        aria-label="Corner-by-corner table — scrollable sideways"
        tabIndex={0}
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
      {/* The refusal strings are sentences, not dashes, so the table needs room for one
          more readable column when the brake-shape column is present (§5.2.6). */}
      <table
        className={`w-full border-collapse text-sm ${showBrakeRelease ? "min-w-[46rem]" : "min-w-[34rem]"}`}
      >
        {/* §4.5 — a real caption, and the units named once here instead of being guessed
            from the cells. */}
        <caption className="pb-2 text-left text-xs leading-relaxed text-muted">
          One row per corner: the speed each driver carried through the apex in km/h, how far
          before the corner they first touched the brakes and for how many metres they stayed on
          them.
        </caption>
        <thead>
          <tr className="tower-label border-b border-grid text-xs text-muted">
            <th scope="col" className="py-2 pr-3 text-left">
              Corner
            </th>
            {drivers.map((d) => (
              <th
                key={d.driverId}
                scope="col"
                className="px-3 py-2 text-right"
                style={{ color: d.colour }}
              >
                {d.code} apex <span className="normal-case">km/h</span>
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right">
              Brake point <span className="normal-case">m</span>
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Braking <span className="normal-case">m</span>
            </th>
            {showBrakeRelease ? (
              <th scope="col" className="w-[13rem] min-w-[13rem] px-3 py-2 text-right">
                Off the brakes
              </th>
            ) : null}
            {twoUp ? (
              <th scope="col" className="py-2 pl-3 text-right">
                <button
                  type="button"
                  onClick={() => setSortByDelta((v) => !v)}
                  className="tower-label min-h-[44px] text-xs text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  aria-pressed={sortByDelta}
                >
                  {"Δ apex"} <span className="normal-case">km/h</span>
                  <span className="sr-only">
                    {sortByDelta
                      ? " — sorted by biggest apex-speed difference; activate to return to lap order"
                      : " — activate to sort by biggest apex-speed difference"}
                  </span>
                </button>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="tnum">
          {ordered.map((line) => {
            const zone = complexes.get(line.key);
            const a = drivers[0] ? line.byDriver.get(drivers[0].driverId) : undefined;
            return (
              <tr
                key={line.key}
                className="team-edge border-b border-grid/60"
                style={{ "--team": drivers[0]?.colour } as React.CSSProperties}
              >
                {/* §4.5 — the corner is this row's header, so it is a th, not a td. */}
                <th scope="row" className="py-1.5 pl-2 pr-3 text-left font-normal">
                  <span className="text-fg">
                    T{line.cornerNumber}
                    {line.cornerLetter}
                  </span>
                  {zone !== undefined ? (
                    <span className="ml-2 rounded border border-grid px-1 text-[10px] text-muted">
                      one braking event
                    </span>
                  ) : null}
                </th>
                {drivers.map((d) => {
                  const r = line.byDriver.get(d.driverId);
                  return (
                    <td key={d.driverId} className="px-3 py-1.5 text-right text-fg">
                      {r ? `${r.apexSpeedKph} km/h` : "—"}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right text-muted">{m(a?.brakePointM ?? null)}</td>
                <td className="px-3 py-1.5 text-right text-muted">{m(a?.brakeDistanceM ?? null)}</td>
                {showBrakeRelease ? <OffTheBrakesCellTd cell={offTheBrakes(a)} /> : null}
                {twoUp ? (
                  <td className="py-1.5 pl-3 text-right text-fg">
                    {line.deltaApexKph === null
                      ? "—"
                      : `${line.deltaApexKph > 0 ? "+" : ""}${line.deltaApexKph} km/h`}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {showBrakeRelease ? (
        <>
          {/* C-BRK-1 — under the corner card, unconditional. */}
          <p className="mt-3 text-xs leading-relaxed text-muted">{C_BRK_1}</p>
          {/* C-BRK-4 / C-BRK-5 — the refusal card, at the SAME visual weight as the
              column (§5.2): a bordered block, not a footnote. §3.3's measured-and-refused
              style — this is the project's third refusal and it is rendered, not omitted
              (D6). */}
          <div className="mt-4 rounded-lg border border-grid bg-surface/50 px-4 py-3">
            <p className="tower-label mb-2 text-xs text-muted">What we could not measure</p>
            <p className="text-sm leading-relaxed text-fg">{C_BRK_4}</p>
            <p className="mt-2 text-sm leading-relaxed text-fg">{C_BRK_5}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The cell. A refusal is rendered as the reason IN the cell, at reading size, not as an
 * em dash with a tooltip: §5.2.6's "flat is a positive report, not a gap" only holds if
 * the report is legible without hovering.
 */
function OffTheBrakesCellTd({ cell }: { cell: OffTheBrakesCell | null }): React.JSX.Element {
  if (cell === null) {
    return <td className="px-3 py-1.5 text-right text-muted">{"\u2014"}</td>;
  }
  if (cell.kind === "measured") {
    return <td className="px-3 py-1.5 text-right text-fg">{cell.text}</td>;
  }
  return (
    <td className="px-3 py-1.5 text-right text-[11px] font-normal leading-snug text-muted">
      {cell.reason}
    </td>
  );
}
