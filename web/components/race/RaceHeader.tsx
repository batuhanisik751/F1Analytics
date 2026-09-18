// SPEC §4.3 item 1 — event name, official name, date/location/circuit/laps, podium chips,
// winner time, data-quality chip, ingest status + warnings, prev/next race links.
import Link from "next/link";
import DriverChip from "@/components/ui/DriverChip";
import PageHeader from "@/components/ui/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import { usedOf } from "@/components/ui/metricFormat";
import { fmtDate, fmtRaceTime, gpShortName } from "@/lib/format";
import type { RaceHeader as RaceHeaderData } from "@/lib/queries/race";

export type RaceHeaderProps = {
  header: RaceHeaderData;
  /**
   * UX_SPEC §3.3 — "diagnostics leave the header". The page passes only the warnings that no
   * section on it owns; the `sim:` ones are rendered as sentences inside the simulator section
   * instead (see `components/race/warnings.ts`). Omit to show every warning, which is what the
   * ingest-failed and preview branches do.
   */
  warnings?: readonly string[];
};

/** §3.3 — the complement of "laps used" spelled out, not left to the reader to infer. */
export const LAPS_EXCLUDED_REASON =
  "safety-car and non-green laps, in- and out-laps, laps flagged by the timing data, and laps far slower than that driver's own median";

/** The text this chip used to hide in a `title=` attribute, which a phone and a keyboard never reach. */
export const LAPS_USED_DEFINITION =
  "Representative laps (green flag, no in/out laps, not flagged, not an outlier) over raw laps in the timing data";

const ORDINAL = ["1st", "2nd", "3rd"];

export default function RaceHeader({ header, warnings }: RaceHeaderProps): React.JSX.Element {
  const h = header;
  const shownWarnings = warnings ?? h.warnings;
  const metaParts = [
    fmtDate(h.eventDate),
    `${h.location}, ${h.country}`,
    h.circuitShortName ?? null,
    h.totalLaps !== null ? `${h.totalLaps} laps` : null,
  ].filter((p): p is string => p !== null);

  const pct =
    h.lapsUsed && h.lapsUsed.raw > 0
      ? ((100 * h.lapsUsed.representative) / h.lapsUsed.raw).toFixed(1)
      : null;

  return (
    <PageHeader
      title={h.eventName}
      subtitle={h.officialName}
      meta={metaParts.join(" · ")}
      actions={
        <>
          {h.prev ? (
            <Link
              href={`/race/${h.prev.year}/${h.prev.round}`}
              className="rounded-full border border-grid px-3 py-1 text-sm text-fg hover:border-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              title={`${h.prev.eventName} ${h.prev.year}`}
              aria-label={`Previous race: ${h.prev.eventName} ${h.prev.year}`}
            >
              ← {gpShortName(h.prev.eventName)}
            </Link>
          ) : null}
          <Link
            href={`/season/${h.year}`}
            className="rounded-full border border-grid px-3 py-1 text-sm tnum text-fg hover:border-muted hover:text-accent"
          >
            {h.year} · Rd {h.round}
          </Link>
          {h.next ? (
            <Link
              href={`/race/${h.next.year}/${h.next.round}`}
              className="rounded-full border border-grid px-3 py-1 text-sm text-fg hover:border-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              title={`${h.next.eventName} ${h.next.year}`}
              aria-label={`Next race: ${h.next.eventName} ${h.next.year}`}
            >
              {gpShortName(h.next.eventName)} →
            </Link>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {h.podium.length > 0 ? (
          <ol className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Podium">
            {h.podium.map((p) => (
              <li key={p.driverId} className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">
                  {ORDINAL[p.position - 1] ?? `P${p.position}`}
                </span>
                <DriverChip
                  code={p.code}
                  fullName={p.fullName}
                  teamColour={p.teamColour}
                  lineStyle={p.lineStyle}
                  href={`/driver/${p.code}?season=${h.year}`}
                  title={`${p.fullName} · ${p.teamName}`}
                />
                {p.position === 1 && h.winnerTimeS !== null ? (
                  <span className="tnum text-sm text-muted">{fmtRaceTime(h.winnerTimeS)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={h.ingestStatus} />
          {h.lapsUsed ? (
            <span className="inline-flex items-center rounded-full border border-grid px-2 py-0.5 text-xs tnum text-muted">
              {h.lapsUsed.representative.toLocaleString("en-GB")} of{" "}
              {h.lapsUsed.raw.toLocaleString("en-GB")} laps used
              {pct !== null ? ` (${pct}%)` : ""}
            </span>
          ) : null}
        </div>
      </div>
      {/* §3.3 — a count never appears without its complement explained, and never behind a
          hover-only `title=`. Both sentences are visible text. */}
      {h.lapsUsed && h.lapsUsed.raw > 0 ? (
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
          {usedOf(h.lapsUsed.representative, h.lapsUsed.raw, LAPS_EXCLUDED_REASON)}{" "}
          {LAPS_USED_DEFINITION}.{" "}
          <a href="#exclusions" className="text-fg underline decoration-grid underline-offset-2 hover:text-accent">
            See how many laps each cleaning rule removed
          </a>
          .
        </p>
      ) : null}
      {shownWarnings.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm text-fg">
            Notes from the data pipeline — things it could not do cleanly for this session:
          </p>
          <ul className="mt-1 space-y-1 text-sm text-accent" aria-label="Ingest warnings">
            {shownWarnings.map((w) => (
              <li key={w} className="font-mono text-xs">
                ⚠ {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PageHeader>
  );
}
