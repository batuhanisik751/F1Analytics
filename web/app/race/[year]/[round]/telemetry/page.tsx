// TELEMETRY_SPEC v1.7 §5.5 / §5.6 — the telemetry tab: /race/[year]/[round]/telemetry.
// A sibling of the qualifying section v1.6 added; the app's race route is [year]/[round]
// and there is no [sessionId] segment anywhere under web/app, so the session is resolved
// here from the round and a kind.
//
// §0.4 is the constraint this page is built inside, not a disclaimer under it: this data
// can show WHERE on the road one lap was quicker than another and what the car was doing
// there. It can never show which driver is faster, which car is faster, how a stint
// degraded, whether a lap was compromised by traffic, what fuel load either car carried,
// what engine mode was selected, or how much of a straight-line advantage was a tow.
// C-TEL-1 therefore sits ABOVE the chart and unconditionally, and C-TEL-4 fires the
// moment a non-teammate pair is chosen.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { cache } from "react";
import Section from "@/components/ui/Section";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import TermTip from "@/components/ui/TermTip";
import EmptyState from "@/components/ui/EmptyState";
import TrackMap from "@/components/charts/TrackMap";
import ChannelStack from "@/components/charts/ChannelStack";
import DeltaTrace from "@/components/charts/DeltaTrace";
import CornerCard from "@/components/charts/CornerCard";
import {
  C_TEL_1,
  C_TEL_4,
  C_TEL_5,
  C_TEL_6,
  cTel2,
  cTel3,
  cTel8,
} from "@/lib/telemetry/captions";
import {
  alignLaps,
  chordLap,
  closureCheck,
  gapIntervals,
  CLOSURE_REFUSE_MS,
} from "@/lib/telemetry/align";
import {
  getCornerSpeeds,
  getLapTelemetry,
  listTelemetryLaps,
  type StoredLapTelemetry,
  type TelemetryLapPill,
  type TelemetryPicker,
} from "@/lib/queries/telemetry";
import { getQualiForRound } from "@/lib/queries/quali";
import { getRaceHeader } from "@/lib/queries/race";

export const dynamic = "force-dynamic";

function parseRoute(year: string, round: string): { year: number; round: number } | null {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(round)) return null;
  return { year: Number(year), round: Number(round) };
}

/**
 * Which session this tab shows. Q first, then SQ, then the race — T10: the cross-driver
 * trace exists only on Q/SQ, so the session that can carry the flagship visual wins.
 * `?kind=R` switches deliberately; there is no cross-SESSION shape anywhere (§6.4).
 */
const cachedSessionId = cache(
  async (year: number, round: number, kind: string | undefined): Promise<number | null> => {
    const quali = await getQualiForRound(year, round);
    const q = quali.find((s) => s.kind === "Q");
    const sq = quali.find((s) => s.kind === "SQ");
    if (kind === "Q" && q) return q.sessionId;
    if (kind === "SQ" && sq) return sq.sessionId;
    if (kind === "R") {
      const header = await getRaceHeader(year, round);
      return header?.sessionId ?? null;
    }
    if (q) return q.sessionId;
    if (sq) return sq.sessionId;
    const header = await getRaceHeader(year, round);
    return header?.sessionId ?? null;
  },
);

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * §5.5 — A defaults to the session's fastest-lap driver; B defaults to A's TEAMMATE,
 * falling back to P2. The teammate default is deliberate: it is the comparison where
 * car, fuel policy and engine mode are closest to equal, i.e. the one §6.1's caveats
 * damage least. A non-teammate pair is allowed, and C-TEL-4 says what it costs.
 */
export function pickDrivers(
  pills: readonly TelemetryLapPill[],
  wantA: string | undefined,
  wantB: string | undefined,
  allowsCrossDriver: boolean,
): { a: TelemetryLapPill | null; b: TelemetryLapPill | null } {
  const withLap = pills.filter((p) => p.hasTelemetry && p.lapTimeS !== null);
  const byTime = [...withLap].sort((p, q) => (p.lapTimeS ?? 0) - (q.lapTimeS ?? 0));
  const find = (code: string | undefined) =>
    code
      ? withLap.find((p) => p.code.toUpperCase() === code.toUpperCase() || p.driverId === code) ??
        null
      : null;
  const a = find(wantA) ?? byTime[0] ?? null;
  if (!a || !allowsCrossDriver) return { a, b: null };
  const explicitB = find(wantB);
  const teammate = byTime.find((p) => p.teamId === a.teamId && p.driverId !== a.driverId);
  const p2 = byTime.find((p) => p.driverId !== a.driverId);
  const b = explicitB && explicitB.driverId !== a.driverId ? explicitB : teammate ?? p2 ?? null;
  return { a, b };
}

function lapTime(s: number | null): string {
  if (s === null) return "—";
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * §5.5 / UX_SPEC §2.2 — the two driver pickers, as COMBOBOXES.
 *
 * They were two flat lists of 22 driver pills: 44 rows of chrome above the chart, and 44 tab
 * stops before a keyboard reader reached any content. They are now two labelled <select>
 * controls inside one GET form — the accessible default, operable by keyboard, announced by a
 * screen reader as a listbox with a current value, and working with NO JavaScript, which matters
 * on a page that is otherwise a pure server render.
 *
 * §0 COLLAPSE, NEVER DELETE. A pill carried code, team colour, lap time, compound and tyre life,
 * and for a driver with no stored lap the REASON there is none. Every one of those survives: the
 * colour swatch becomes the team's NAME (which says the same thing to a reader who cannot see the
 * colour, §4.3), and the reasons appear both in a labelled `No stored lap` group inside the
 * control and, in full, in the always-open block under the form.
 */
function driverOptionLabel(pill: TelemetryLapPill): string {
  if (!pill.hasTelemetry) {
    return `${pill.code} · ${pill.teamName} — no stored lap (${pill.reason ?? "no reason recorded"})`;
  }
  const tyre = [
    pill.compound,
    pill.tyreLife !== null ? `${pill.tyreLife} lap${pill.tyreLife === 1 ? "" : "s"} old` : null,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(", ");
  return `${pill.code} · ${pill.teamName} — ${lapTime(pill.lapTimeS)}${tyre ? ` · ${tyre}` : ""}`;
}

const SELECT_CLASS =
  "mt-1 min-h-[44px] w-full rounded border border-grid bg-surface/60 px-2 py-2 text-sm text-fg " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function LapSelect({
  id,
  name,
  label,
  hint,
  pills,
  selectedCode,
}: {
  id: string;
  name: "a" | "b";
  label: string;
  hint: string;
  pills: readonly TelemetryLapPill[];
  selectedCode: string | null;
}): React.JSX.Element {
  const withLap = pills.filter((p) => p.hasTelemetry);
  const without = pills.filter((p) => !p.hasTelemetry);
  return (
    <div className="min-w-[15rem] flex-1">
      <label htmlFor={id} className="tower-label block text-xs text-muted">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={selectedCode ?? ""}
        className={SELECT_CLASS}
        aria-describedby={`${id}-hint`}
      >
        <optgroup label={`Drivers with a stored lap (${withLap.length})`}>
          {withLap.map((p) => (
            <option key={p.driverId} value={p.code}>
              {driverOptionLabel(p)}
            </option>
          ))}
        </optgroup>
        {without.length > 0 ? (
          <optgroup label={`No stored lap (${without.length})`}>
            {without.map((p) => (
              <option key={p.driverId} value={p.code} disabled>
                {driverOptionLabel(p)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {hint}
      </p>
    </div>
  );
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "no signal" : `${v.toFixed(1)}%`;
}

/**
 * §5.2 — the delta trace's own numbers, computed here so C-TEL-2 quotes a MEASUREMENT
 * and not a constant. The chart validates itself before it renders: above
 * CLOSURE_REFUSE_MS the pair is refused, and refusing means no chart frame at all.
 */
function deltaReport(a: StoredLapTelemetry, b: StoredLapTelemetry) {
  try {
    const la = chordLap({ code: a.code, x: a.x, y: a.y, timeS: a.timeS, distanceM: a.distanceM });
    const lb = chordLap({ code: b.code, x: b.x, y: b.y, timeS: b.timeS, distanceM: b.distanceM });
    const aligned = alignLaps(la, lb);
    const check = closureCheck(aligned, la, lb, {
      lapTimeAS: a.lapTimeS ?? 0,
      lapTimeBS: b.lapTimeS ?? 0,
      s1DistanceAM: a.summary?.s1DistanceM ?? null,
      s1DistanceBM: b.summary?.s1DistanceM ?? null,
      s2DistanceAM: a.summary?.s2DistanceM ?? null,
      s2DistanceBM: b.summary?.s2DistanceM ?? null,
      s1TimeAS: a.s1TimeS,
      s1TimeBS: b.s1TimeS,
      s2TimeAS: a.s2TimeS,
      s2TimeBS: b.s2TimeS,
    });
    const worstSector = check.sectors.length
      ? Math.max(...check.sectors.map((s) => Math.abs(s.residualS)))
      : null;
    const nGaps = gapIntervals([la, lb]).length;
    return { aligned, check, worstSector, nGaps, error: null as string | null };
  } catch (e) {
    // T5 is enforced by `chordLap`, which REJECTS a distance array that is not the chord
    // length of its own (x, y). A rejection is reported, never drawn around.
    return {
      aligned: null,
      check: null,
      worstSector: null,
      nGaps: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function generateMetadata({
  params,
}: PageProps<"/race/[year]/[round]/telemetry">): Promise<Metadata> {
  const raw = await params;
  const parsed = parseRoute(raw.year, raw.round);
  if (!parsed) return { title: "Telemetry not found" };
  return { title: `Telemetry — round ${parsed.round}, ${parsed.year}` };
}

/** §5.6 — the one sentence a session with no telemetry gets. No chart frame, ever. */
function stateSentence(picker: TelemetryPicker): string | null {
  switch (picker.state) {
    case "none":
      return "No telemetry was stored for this session. The 10 Hz car and position channels were not available for it, so there is nothing here to draw.";
    case "failed":
      return "The telemetry pass failed for this session. Everything else on this weekend is unaffected — a telemetry failure never changes what the rest of the app knows.";
    case "dropped":
      return "This session was re-ingested without its telemetry cache, so the stored laps were dropped. Re-run the telemetry pass to bring them back.";
    default:
      return null;
  }
}

export default async function TelemetryPage({
  params,
  searchParams,
}: PageProps<"/race/[year]/[round]/telemetry">): Promise<React.JSX.Element> {
  const raw = await params;
  const sp = await searchParams;
  const parsed = parseRoute(raw.year, raw.round);
  if (!parsed) notFound();

  const sessionId = await cachedSessionId(parsed.year, parsed.round, one(sp.kind));
  if (sessionId === null) notFound();
  const picker = await listTelemetryLaps(sessionId);
  if (!picker) notFound();
  // §5.6 — "absent (never attempted)": the tab is NOT RENDERED AT ALL, which for a route
  // of its own means it does not exist.
  if (picker.state === "absent") notFound();

  const base = `/race/${parsed.year}/${parsed.round}/telemetry`;
  const kindLabel =
    picker.kind === "Q" ? "Qualifying" : picker.kind === "SQ" ? "Sprint qualifying" : "Race";
  const sentence = stateSentence(picker);

  // §5.6 — one sentence and NO CHART FRAME. No skeleton and no placeholder chart: an
  // empty axis frame is how a site says "there is data here" when there is not.
  if (sentence) {
    return (
      <Section title={`${picker.eventName} ${picker.year} — telemetry`} caption={kindLabel}>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{sentence}</p>
      </Section>
    );
  }

  const { a: pillA, b: pillB } = pickDrivers(
    picker.pills,
    one(sp.a),
    one(sp.b),
    picker.allowsCrossDriver,
  );
  if (!pillA) {
    return (
      <Section title={`${picker.eventName} ${picker.year} — telemetry`} caption={kindLabel}>
        <EmptyState title="No stored lap for any driver in this session" reason={`telemetry state: ${picker.state}`} />
      </Section>
    );
  }

  const [lapA, lapB] = await Promise.all([
    getLapTelemetry(sessionId, pillA.driverId),
    pillB ? getLapTelemetry(sessionId, pillB.driverId) : Promise.resolve(null),
  ]);
  if (!lapA) {
    return (
      <Section title={`${picker.eventName} ${picker.year} — telemetry`} caption={kindLabel}>
        <EmptyState title={`No stored lap for ${pillA.code}`} reason={pillA.reason ?? "no row in lap_telemetry"} />
      </Section>
    );
  }
  const corners = await getCornerSpeeds(
    sessionId,
    [lapA.driverId, lapB?.driverId].filter((d): d is string => Boolean(d)),
  );

  const report = lapB ? deltaReport(lapA, lapB) : null;
  const notTeammates = Boolean(pillB && pillA.teamId !== pillB.teamId);
  const laps = [lapA, ...(lapB ? [lapB] : [])];
  const sEndM = report?.aligned?.sEndM ?? lapA.trackLengthM;
  /** §0 — never omitted, and never behind a closed control: these are refusals with reasons. */
  const missing = picker.pills.filter((p) => !p.hasTelemetry);

  return (
    <>
      <Section
        title={`${picker.eventName} ${picker.year} — telemetry`}
        caption={
          picker.state === "partial"
            ? `${kindLabel} · a lap is stored for ${picker.nWithTelemetry} of the ${picker.nEntered} drivers who took part; the other ${picker.nEntered - picker.nWithTelemetry} are named below, with the reason`
            : `${kindLabel} · one lap per driver — each driver's fastest of the session, and no other lap`
        }
      >
        {/* One GET form, two comboboxes, one submit. No JavaScript: changing a driver is a
            navigation to the same route with new query parameters, exactly as the 44 links it
            replaces were — but as two tab stops instead of forty-four. */}
        <form method="get" action={base} className="flex flex-wrap items-end gap-4">
          {one(sp.kind) ? <input type="hidden" name="kind" value={one(sp.kind)} /> : null}
          {one(sp.ch) ? <input type="hidden" name="ch" value={one(sp.ch)} /> : null}
          <LapSelect
            id="lap-a"
            name="a"
            label="Lap A"
            hint="Each driver's fastest lap of this session. Lap time, tyre compound and how old the tyre was are in the list, because those are what decide whether the comparison is fair."
            pills={picker.pills}
            selectedCode={pillA.code}
          />
          {picker.allowsCrossDriver ? (
            <LapSelect
              id="lap-b"
              name="b"
              label="Lap B"
              hint="Compared against Lap A. Defaults to Lap A's teammate — the same car, so the closest thing to a like-for-like run this data has."
              pills={picker.pills.filter((p) => p.driverId !== pillA.driverId)}
              selectedCode={pillB?.code ?? null}
            />
          ) : null}
          <button
            type="submit"
            className="min-h-[44px] rounded border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {picker.allowsCrossDriver ? "Compare these laps" : "Show this lap"}
          </button>
        </form>
        {picker.allowsCrossDriver ? null : (
          // T10 / C-TEL-5 — an ABSENT control, not a disabled button. The second picker
          // does not exist on a race session, and this sentence is what stands where it
          // would have been.
          <p className="mt-3 max-w-3xl rounded border border-grid bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
            {C_TEL_5}
          </p>
        )}
        {/* §0 — a driver with no stored lap is still named, with the reason, and NOT behind a
            closed control: this is a refusal, and §2.2 keeps every refusal open. It is a short
            list where the picker used to be forty-four rows. */}
        {missing.length > 0 ? (
          <div className="mt-4 max-w-3xl rounded border border-grid bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
            <p className="text-fg">
              {missing.length === 1
                ? "One driver in this session has no stored lap, so they cannot be picked above:"
                : `${missing.length} drivers in this session have no stored lap, so they cannot be picked above:`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {missing.map((p) => (
                <li key={`missing-${p.driverId}`}>
                  <span className="font-semibold text-fg">{p.code}</span>{" "}
                  <span>({p.teamName})</span> — {p.reason ?? "no stored lap"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {notTeammates ? (
          <p className="mt-3 max-w-3xl rounded border border-grid bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
            {C_TEL_4}{" "}
            <Link
              href={`/season/${parsed.year}/was-it-the-car`}
              className="text-fg underline underline-offset-2"
            >
              Open the was-it-the-car page
            </Link>
            .
          </p>
        ) : null}
      </Section>

      {picker.allowsCrossDriver && lapB && report ? (
        <Section
          title="Where one lap was quicker"
          caption={
            <>
              {lapA.code} against {lapB.code}, lined up on{" "}
              <TermTip term="chord-distance">chord distance</TermTip> around the lap — metres
              travelled, so both laps are compared at the same point on the road
            </>
          }
        >
          {/* C-TEL-1 — ABOVE the chart, unconditional, never in a footer. A caveat
              printed under a chart is read after the conclusion has been drawn. */}
          <p className="mb-3 max-w-3xl rounded border border-grid bg-raised px-3 py-2 text-xs leading-relaxed text-fg">
            {C_TEL_1}
          </p>
          {report.error ? (
            <EmptyState title="This pair cannot be aligned" reason={report.error} />
          ) : report.check && !report.check.render ? (
            // §5.2.2 / §6.4 — the chart computes its own closure error and REFUSES to
            // render above 400 ms. No frame, no greyed chart: a refusal is a sentence.
            <p className="max-w-3xl text-sm leading-relaxed text-muted">
              These two laps cannot be aligned closely enough to draw. The trace misses the
              official gap by {Math.round(report.check.closureErrorS * 1000)} ms, past the{" "}
              {CLOSURE_REFUSE_MS} ms limit this chart refuses at, so no trace is drawn —
              a line this wrong would look like a measurement and would not be one.
            </p>
          ) : (
            // The trace itself (WP-9). `showCaptions` stays false: C-TEL-1 is printed
            // above this mount point and C-TEL-2 below it, and a doubled caveat reads as
            // boilerplate — which is how a caveat stops being read.
            <DeltaTrace
              sessionKind={picker.kind}
              lapA={lapA}
              lapB={lapB}
              corners={lapA.circuit?.corners ?? []}
            />
          )}
          {report.check ? (
            // §2.2 — C-TEL-2 is the alignment METHOD NOTE, the longest caption on this page, so it
            // goes behind a control. §0: the caption is NOT shortened, and the summary line that
            // stands in front of it carries both of its honesty numbers (closure error, number of
            // unmeasured stretches) AND its instruction to the reader, so nothing that changes how
            // the chart should be read is hidden. When the error exceeds half the gap the block
            // opens by default, because that variant is a warning and §0 keeps warnings open.
            <Disclosure
              variant="inline"
              defaultOpen={Boolean(report.check.errorExceedsHalfGap)}
              summary={
                report.check.errorExceedsHalfGap
                  ? `Read the shape of this line, not its size — the alignment error here is larger than the gap itself is (${Math.round(Math.abs(report.check.closureErrorS) * 1000)} ms, ${report.nGaps} unmeasured ${report.nGaps === 1 ? "stretch" : "stretches"} of the lap)`
                  : `Read the shape of this line, not the third decimal — it closes to within ${Math.round(Math.abs(report.check.closureErrorS) * 1000)} ms of the official gap, with ${report.nGaps} unmeasured ${report.nGaps === 1 ? "stretch" : "stretches"} of the lap drawn by interpolation`
              }
            >
              {cTel2({
                closureErrorS: report.check.closureErrorS,
                worstSectorResidualS: report.worstSector,
                nGaps: report.nGaps,
                errorExceedsHalfGap: report.check.errorExceedsHalfGap,
              })}
            </Disclosure>
          ) : null}
        </Section>
      ) : null}

      <Section title="The lap on the road" caption={`${lapA.code}'s fastest lap, painted by one channel`}>
        {lapA.circuit ? (
          <>
            <TrackMap
              lap={lapA}
              corners={lapA.circuit.corners}
              rotationDeg={lapA.circuit.rotationDeg}
            />
            <Caption>{cTel3(lapA.nSamples)}</Caption>
          </>
        ) : (
          <EmptyState title="No circuit geometry stored" reason="no circuit_layout row for this circuit and year" />
        )}
      </Section>

      <Section
        title="What the car was doing"
        caption="Speed, throttle with braking, gear and DRS on the same metres of road as the trace above"
      >
        {/* The summary strip. Distance-weighted shares, never sample-weighted (§0.3) —
            samples are uniform in TIME, so sample-weighting over-counts slow corners
            about threefold. `drs_distance_m` NULL renders "no signal", never 0.
            UX_SPEC §3.3 / §4.5: every figure now has a real <dt> naming it AND its unit, so no
            number is bare and none of them is a bare abbreviation ("lifting", "min") either. */}
        {laps.map((lap) => (
          <div key={lap.driverId} className="mb-5">
            <h3 className="tower-label mb-1 flex items-center gap-2 text-[11px] text-fg">
              <span
                aria-hidden
                className="inline-block h-3 w-1 shrink-0"
                style={{ background: lap.colour }}
              />
              <span>
                {lap.code} · lap {lap.lapNumber} · {lapTime(lap.lapTimeS)}
              </span>
            </h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted">Top speed</dt>
                <dd className="tnum text-fg">
                  {lap.summary?.topSpeedKph ?? "—"} km/h
                </dd>
              </div>
              <div>
                <dt className="text-muted">Slowest point of the lap</dt>
                <dd className="tnum text-fg">
                  {lap.summary?.minSpeedKph ?? "—"} km/h
                </dd>
              </div>
              <div>
                <dt className="text-muted">Full throttle</dt>
                <dd className="tnum text-fg">
                  {pct(lap.summary?.fullThrottlePct)}{" "}
                  <span className="text-muted">of the lap&rsquo;s distance</span>
                </dd>
              </div>
              <div>
                <dt className="text-muted">On the brakes</dt>
                <dd className="tnum text-fg">
                  {pct(lap.summary?.brakePct)}{" "}
                  <span className="text-muted">of the lap&rsquo;s distance</span>
                </dd>
              </div>
              <div>
                <dt className="text-muted">Coasting (off the throttle, not braking)</dt>
                <dd className="tnum text-fg">
                  {pct(lap.summary?.liftPct)}{" "}
                  <span className="text-muted">of the lap&rsquo;s distance</span>
                </dd>
              </div>
              <div>
                <dt className="text-muted">Separate braking zones</dt>
                <dd className="tnum text-fg">{lap.summary?.nBrakeZones ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted">
                  Distance with <TermTip term="drs-no-signal">DRS</TermTip> open
                </dt>
                <dd className="tnum text-fg">
                  {lap.summary?.drsDistanceM === null || lap.summary?.drsDistanceM === undefined
                    ? "no signal"
                    : `${Math.round(lap.summary.drsDistanceM).toLocaleString("en-GB")} m of the lap`}
                </dd>
              </div>
            </dl>
          </div>
        ))}
        {/* §2.2 CLOSED — a method note. It was only ever a source comment before, so nothing is
            being hidden here: this is copy the page did not previously have. */}
        <Disclosure
          summary="How these shares are measured — by distance, not by time"
          storageKey="telemetry:shares-method"
        >
          <p>
            The three shares above are shares of the lap&rsquo;s <strong className="text-fg">distance</strong>,
            not of its time. The car reports ten times a second, so a slow corner produces far more
            readings than a straight of the same length; counting readings would over-count the
            corners by roughly three to one and make every driver look as though they brake more
            than they do. Each reading is therefore weighted by the metres it covers.
          </p>
          <p className="mt-2">
            &ldquo;No signal&rdquo; is not zero. It means the channel was not recorded for this
            session at all — a gap in what was stored, not a lap on which nothing happened.
          </p>
        </Disclosure>
        {(() => {
          // C-TEL-8 fires wherever overlap_pct > 3 — on A's lap, the reference column.
          const c8 = cTel8(lapA.summary?.overlapPct);
          return c8 ? <Caption className="mb-4">{c8}</Caption> : null;
        })()}
        <ChannelStack laps={laps} sEndM={sEndM} />
      </Section>

      <Section
        title="Corner by corner"
        caption="Apex speed, braking point and braking distance for every corner of the circuit map"
      >
        <CornerCard
          rows={corners}
          drivers={laps.map((l) => ({ driverId: l.driverId, code: l.code, colour: l.colour }))}
        />
        <Caption>{C_TEL_6}</Caption>
      </Section>
    </>
  );
}
