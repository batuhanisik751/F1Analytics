// QUALI_SPEC §6.2 (b) — gap to pole, both numbers (D6). The SOLID bar is
// `gapToPoleCommonS`, the same-segment gap; the GHOSTED bar behind it is
// `gapToPoleS`, the television number. When `crossSegmentOk` is false the ghost is
// suppressed entirely and C-QUALI-7 replaces it (§4.6).
//
// Server-rendered CSS bars rather than an ECharts canvas: the whole surface has to
// render correctly with no client JavaScript (§6.6 is verified by an SSR script), and a
// bar-behind-a-bar with a per-row team colour is one div, not a custom series.
import { fmtGap, fmtPct } from "@/lib/format";
import type { QualiSession } from "@/lib/queries/quali";

/**
 * Data-driven axis (§6.2 b): the measured P1→last span runs 2.00% (Bahrain) to 4.20%
 * (Monza), so a fixed axis wastes half the width at one end and clips at the other.
 * Headroom of 8% keeps the longest label off the edge.
 */
export function axisMax(values: number[]): number {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  return max > 0 ? max * 1.08 : 1;
}

export type GapToPoleBarsProps = { session: QualiSession };

export default function GapToPoleBars({ session }: GapToPoleBarsProps): React.JSX.Element | null {
  const rows = session.rows.filter((r) => r.gapToPoleCommonS !== null || r.gapToPoleS !== null);
  if (rows.length === 0) return null;
  const showGhost = session.crossSegmentOk;
  const scale = axisMax(
    rows.flatMap((r) =>
      [r.gapToPoleCommonS, showGhost ? r.gapToPoleS : null].filter(
        (v): v is number => v !== null && v > 0,
      ),
    ),
  );
  const pct = (v: number | null): number =>
    v === null || v <= 0 ? 0 : Math.min(100, (v / scale) * 100);

  return (
    <div className="border border-grid bg-surface/30 p-3">
      <ol className="space-y-1">
        {rows.map((r) => (
          <li key={r.driverId} className="grid grid-cols-[2.2rem_3rem_1fr_9rem] items-center gap-2">
            <span className="tnum text-right text-xs text-muted">{r.position}</span>
            <span className="tnum font-mono text-xs font-semibold">{r.code}</span>
            <span className="relative block h-4 bg-raised/60">
              {showGhost && r.gapToPoleS !== null ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 opacity-25"
                  style={{ width: `${pct(r.gapToPoleS)}%`, background: r.colour }}
                />
              ) : null}
              <span
                aria-hidden
                className="absolute inset-y-[3px] left-0"
                style={{ width: `${pct(r.gapToPoleCommonS)}%`, background: r.colour }}
              />
              {/* §4.3 / §4.5 — the bars are decoration; this sentence is the data, and it
                  reads the same to a screen reader and to a colour-blind reader. */}
              <span className="sr-only">
                {r.gapToPoleCommonS === null
                  ? `${r.code} shared no segment with the pole sitter, so no comparable gap.`
                  : `${r.code}: ${fmtGap(r.gapToPoleCommonS)} behind pole in Q${r.gapToPoleSegment ?? "?"}` +
                    (showGhost && r.gapToPoleS !== null
                      ? `, ${fmtGap(r.gapToPoleS)} on best laps of the session.`
                      : ".")}
              </span>
            </span>
            <span className="tnum text-right text-xs">
              {r.gapToPoleCommonS === null ? (
                <span className="text-muted">&mdash;</span>
              ) : (
                <>
                  {fmtGap(r.gapToPoleCommonS)}
                  <span className="ml-2 text-muted">{fmtPct(r.gapToPoleCommonPct)}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-5 bg-fg/70" /> same-segment gap to pole
        </span>
        {showGhost ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3.5 w-5 bg-fg/70 opacity-25" /> television gap
            (best lap of the session)
          </span>
        ) : (
          <span>Television gap suppressed: the segments of this session are not comparable.</span>
        )}
        <span>
          Bar length is the gap in seconds; the axis runs 0 to {fmtGap(scale)}. The figures on the
          right are that gap in seconds and as a share of a lap.
        </span>
      </p>
    </div>
  );
}
