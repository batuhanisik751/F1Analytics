// SPEC §4.1 (2) — latest race hero: event, date, location, podium chips, the site's own
// "fastest race pace" line (shown before the result), and a link to the race page. Server-safe.
import Link from "next/link";
import DriverChip from "@/components/ui/DriverChip";
import StatusBadge from "@/components/ui/StatusBadge";
import TermTip from "@/components/ui/TermTip";
import { fmtDate, fmtGap } from "@/lib/format";
import type { HomeData } from "@/lib/queries/home";

export type LatestRaceHeroProps = {
  latest: NonNullable<HomeData["latest"]>;
};

const ORDINAL = ["P1", "P2", "P3"];

/** UX_SPEC §3.3 — a plain sentence in place of the default "ingest status: …" tooltip. The same
 *  sentence is rendered as visible text below, so the information is not hover-only (§3.1). */
const STATUS_NOTE: Record<string, string> = {
  partial:
    "Some timing data for this race is missing, so the pace numbers below rest on fewer laps than usual.",
  failed: "The timing feed for this race could not be processed, so its pace numbers are missing.",
  pending: "This race has not been analysed yet.",
};

export default function LatestRaceHero({ latest }: LatestRaceHeroProps): React.JSX.Element {
  const raceHref = `/race/${latest.year}/${latest.round}`;
  const driverHref = (code: string) => `/driver/${code}?season=${latest.year}`;
  const fp = latest.fastestPace;
  const ru = latest.runnerUpPace;

  return (
    <div className="rounded-lg border border-grid bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Round {latest.round} · {latest.year}
          </p>
          <h3 className="mt-1 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
            <Link href={raceHref} className="hover:text-accent">
              {latest.eventName}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-muted">
            {fmtDate(latest.eventDate)} · {latest.location}, {latest.country}
            {latest.circuitShortName ? ` · ${latest.circuitShortName}` : ""}
            {latest.totalLaps !== null ? ` · ${latest.totalLaps} laps` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {latest.ingestStatus !== "ok" ? (
            <StatusBadge
              status={latest.ingestStatus}
              title={STATUS_NOTE[latest.ingestStatus] ?? `ingest status: ${latest.ingestStatus}`}
            />
          ) : null}
          <Link
            href={raceHref}
            className="rounded-full border border-accent px-3 py-1 text-sm font-medium text-accent hover:bg-accent/15"
          >
            Race analysis →
          </Link>
        </div>
      </div>

      {/* §0 / §2.2 — a limit on interpretation stays in the open, never behind a control. */}
      {latest.ingestStatus !== "ok" && STATUS_NOTE[latest.ingestStatus] ? (
        <p className="mt-3 border-l-2 border-accent/70 pl-3 text-sm leading-snug text-muted">
          {STATUS_NOTE[latest.ingestStatus]}
        </p>
      ) : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Fastest race pace</p>
          {fp ? (
            <p className="mt-1 text-base text-fg">
              <DriverChip
                code={fp.code}
                teamColour={fp.teamColour}
                lineStyle={fp.lineStyle}
                title={fp.fullName}
                href={driverHref(fp.code)}
              />
              <span className="text-muted"> ({fp.teamName})</span>
              {ru ? (
                <span className="tnum">
                  {" — "}
                  <Link href={driverHref(ru.code)} className="font-mono font-semibold hover:text-accent">
                    {ru.code}
                  </Link>{" "}
                  {fmtGap(ru.gapS)}
                  <span className="ml-1 text-xs font-normal text-muted">
                    slower per lap, on average
                  </span>
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">No pace ranking for this race.</p>
          )}
          <p className="mt-1 text-xs text-muted">
            Median{" "}
            <TermTip term="fuel-corrected">
              <span className="underline decoration-dotted underline-offset-2">fuel-corrected</span>
            </TermTip>{" "}
            lap time over clean{" "}
            <TermTip term="green-flag-lap">
              <span className="underline decoration-dotted underline-offset-2">green-flag</span>
            </TermTip>{" "}
            laps — the site&apos;s own number.
          </p>
          <p className="mt-1 text-xs text-muted">
            This is a measure of speed, not of result: the quickest car over a race is often not the
            one that won it.
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Podium</p>
          {latest.podium.length > 0 ? (
            <ol className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-2">
              {latest.podium.map((d, i) => (
                <li key={d.driverId} className="flex items-center gap-2">
                  <span className="tnum text-xs font-medium text-muted">{ORDINAL[i] ?? `P${i + 1}`}</span>
                  <DriverChip
                    code={d.code}
                    teamColour={d.teamColour}
                    lineStyle={d.lineStyle}
                    title={`${d.fullName} (${d.teamName})`}
                    href={driverHref(d.code)}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-sm text-muted">No classified results stored.</p>
          )}
        </div>
      </div>
    </div>
  );
}
