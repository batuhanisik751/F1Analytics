// QUALI_SPEC §6.2 (c) — for each driver, a dot at `bestS` per segment they ran,
// connected: the Q1→Q3 improvement that is the real story of a session. A driver with
// `pushLaps < 2` in a segment gets a HOLLOW dot, because that segment has no `spreadS`
// and no `sdS` to stand behind it (§0.4 note 5).
//
// Inline SVG, server-rendered: it must survive an SSR render with no client JS, and the
// whole mark set is one circle and one polyline per driver.
import { fmtGap, fmtLapTime } from "@/lib/format";
import type { QualiSegmentRow } from "@/lib/queries/quali";

const W = 720;
const ROW_H = 18;
const LEFT = 56;
const RIGHT = 84;

export type StripDriver = {
  driverId: string;
  code: string;
  colour: string;
  points: QualiSegmentRow[];
};

/** Groups the long form by driver, preserving the query's position order. */
export function groupByDriver(rows: QualiSegmentRow[]): StripDriver[] {
  const out: StripDriver[] = [];
  const index = new Map<string, StripDriver>();
  for (const r of rows) {
    let d = index.get(r.driverId);
    if (!d) {
      d = { driverId: r.driverId, code: r.code, colour: r.colour, points: [] };
      index.set(r.driverId, d);
      out.push(d);
    }
    d.points.push(r);
  }
  return out;
}

export type QualiSegmentStripProps = { rows: QualiSegmentRow[] };

export default function QualiSegmentStrip({
  rows,
}: QualiSegmentStripProps): React.JSX.Element | null {
  const drivers = groupByDriver(rows).filter((d) => d.points.some((p) => p.bestS !== null));
  if (drivers.length === 0) return null;

  const times = rows.map((r) => r.bestS).filter((v): v is number => v !== null);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const span = hi - lo || 1;
  const x = (t: number): number => LEFT + ((t - lo) / span) * (W - LEFT - RIGHT);
  const height = drivers.length * ROW_H + 26;

  return (
    // §4.5 — a horizontal scroll container a keyboard reader can actually reach and scroll:
    // tabIndex makes it focusable (so the arrow keys work), role+label say what it is, and
    // the focus ring makes that visible.
    <div
      role="region"
      aria-label="Best lap per qualifying segment, one row per driver — scrollable sideways"
      tabIndex={0}
      className="overflow-x-auto border border-grid bg-surface/30 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        role="img"
        aria-label="Best lap per qualifying segment, one row per driver"
        viewBox={`0 0 ${W} ${height}`}
        className="w-full min-w-[520px]"
        style={{ height }}
      >
        {drivers.map((d, i) => {
          const y = i * ROW_H + 12;
          const pts = d.points.filter((p) => p.bestS !== null);
          return (
            <g key={d.driverId}>
              <text x={0} y={y + 4} fill="var(--color-muted, #8B8B97)" fontSize={11} fontFamily="monospace">
                {d.code}
              </text>
              {pts.length > 1 ? (
                <polyline
                  points={pts.map((p) => `${x(p.bestS!)},${y}`).join(" ")}
                  fill="none"
                  stroke={d.colour}
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              ) : null}
              {pts.map((p) => (
                <circle
                  key={p.segment}
                  cx={x(p.bestS!)}
                  cy={y}
                  r={4}
                  fill={p.verified === false || p.pushLaps < 2 ? "none" : d.colour}
                  stroke={d.colour}
                  strokeWidth={1.5}
                  strokeDasharray={p.verified === false ? "2 2" : undefined}
                  opacity={p.verified === false ? 0.55 : 1}
                >
                  <title>
                    {`${d.code} Q${p.segment} ${fmtLapTime(p.bestS)} · ${p.pushLaps} push lap${p.pushLaps === 1 ? "" : "s"} of ${p.lapsRun} run` +
                      (p.spreadS !== null ? ` · spread ${fmtGap(p.spreadS)}` : " · no spread (fewer than two push laps)") +
                      (p.compound ? ` · ${p.compound}` : "") +
                      (p.verified === false
                        ? " · unconfirmed: the official time for this segment duplicates another segment's"
                        : "")}
                  </title>
                </circle>
              ))}
              <text
                x={W - RIGHT + 8}
                y={y + 4}
                fill="var(--color-muted, #8B8B97)"
                fontSize={10}
                fontFamily="monospace"
              >
                {`${pts.reduce((n, p) => n + p.reprLaps, 0)} laps`}
              </text>
            </g>
          );
        })}
        <text x={LEFT} y={height - 4} fill="var(--color-muted, #8B8B97)" fontSize={10}>
          {fmtLapTime(lo)}
        </text>
        <text x={W - RIGHT} y={height - 4} textAnchor="end" fill="var(--color-muted, #8B8B97)" fontSize={10}>
          {fmtLapTime(hi)}
        </text>
      </svg>
      <p className="mt-1 text-[11px] text-muted">
        Hollow marker: fewer than two push laps in that segment, so no spread is shown.
      </p>
      {/* §4.3 — the line colour is the team’s, so it is never the only channel: the
          driver’s code is printed at the start of every row and repeated here in order. */}
      <p className="mt-1 text-[11px] text-muted">
        Rows run in classified order, each labelled with the driver&rsquo;s code:{" "}
        {drivers.map((d) => d.code).join(" \u00b7 ")}. Left is quicker.
      </p>
    </div>
  );
}
