// SPEC §4.1 (4) / §4.2 (4) — race list table shared by the home page (completed races,
// newest first) and the season page (every scheduled round, ascending). Server-safe.
import Link from "next/link";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import StatusBadge from "@/components/ui/StatusBadge";
import { fmtDate } from "@/lib/format";
import type { RaceListRow } from "@/lib/queries/season";
import type { DriverRef } from "@/lib/queries/shared";

export type RaceListProps = {
  rows: RaceListRow[];
  /** Shown by DataTable when `rows` is empty. */
  emptyReason?: string | null;
  emptyTitle?: string;
  caption?: React.ReactNode;
  className?: string;
};

const DASH = "—";

function driverHref(year: number, ref: DriverRef): string {
  return `/driver/${ref.code}?season=${year}`;
}

function chip(year: number, ref: DriverRef | null, pending: boolean): React.ReactNode {
  if (!ref) return <span className="text-muted">{DASH}</span>;
  return (
    <DriverChip
      code={ref.code}
      teamColour={ref.teamColour}
      lineStyle={ref.lineStyle}
      title={`${ref.fullName} (${ref.teamName})`}
      href={pending ? undefined : driverHref(year, ref)}
    />
  );
}

const columns: DataTableColumn<RaceListRow>[] = [
  {
    key: "round",
    header: "Rd",
    align: "right",
    className: "tnum w-12",
    render: (r) => r.round,
  },
  {
    key: "date",
    header: "Date",
    className: "tnum whitespace-nowrap",
    render: (r) => fmtDate(r.eventDate),
  },
  {
    key: "event",
    header: "Grand Prix",
    render: (r) => {
      const name =
        r.ingestStatus === "pending" ? (
          <span className="text-muted">{r.eventName}</span>
        ) : (
          <Link
            href={`/race/${r.year}/${r.round}`}
            className="font-medium text-fg hover:text-accent"
          >
            {r.eventName}
          </Link>
        );
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          {name}
          {r.hasSprint ? (
            <span
              title="Sprint weekend"
              aria-label="Sprint weekend"
              className="inline-flex items-center rounded border border-accent/60 px-1 font-mono text-[10px] font-semibold uppercase leading-4 tracking-wide text-accent"
            >
              S
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    key: "circuit",
    header: "Circuit",
    render: (r) => (
      <span className="whitespace-nowrap">
        {r.circuitShortName ?? r.location}
        <span className="text-muted"> · {r.country}</span>
      </span>
    ),
  },
  {
    key: "winner",
    header: "Winner",
    render: (r) => chip(r.year, r.winner, r.ingestStatus === "pending"),
  },
  {
    key: "pace",
    header: "Fastest pace",
    render: (r) => {
      const differs =
        r.winner !== null && r.fastestPace !== null && r.winner.driverId !== r.fastestPace.driverId;
      return (
        <span className="inline-flex items-center gap-2">
          {chip(r.year, r.fastestPace, r.ingestStatus === "pending")}
          {differs ? (
            <span
              title="The fastest fuel-corrected race pace was not the winner"
              aria-label="The fastest race pace was not the winner"
              className="rounded border border-accent/60 px-1.5 py-px text-[11px] font-medium text-accent whitespace-nowrap"
            >
              pace ≠ winner
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    key: "status",
    header: "Status",
    render: (r) =>
      r.ingestStatus === "ok" ? null : (
        <StatusBadge
          status={r.ingestStatus}
          title={
            r.ingestStatus === "pending"
              ? "This round has not been run or not yet analysed — not yet ingested."
              : r.ingestStatus === "partial"
                ? "Some timing data for this round is missing, so its pace numbers rest on fewer laps."
                : `The timing feed for this round could not be processed, so it has no pace numbers (ingest status: ${r.ingestStatus}).`
          }
        />
      ),
  },
];

export default function RaceList({
  rows,
  emptyReason,
  emptyTitle,
  caption,
  className,
}: RaceListProps): React.JSX.Element {
  // UX_SPEC §3.1 / §4.3 — the badges in this table carried their meaning only in a `title=`,
  // which a phone and a keyboard never reach. The legend says it on the page instead; the
  // tooltips are left in place, so nothing that was readable before has been removed (§0).
  const hasSprint = rows.some((r) => r.hasSprint);
  const hasPaceFlag = rows.some(
    (r) => r.winner !== null && r.fastestPace !== null && r.winner.driverId !== r.fastestPace.driverId,
  );
  const hasStatus = rows.some((r) => r.ingestStatus !== "ok");

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.year}-${r.round}`}
        rowClassName={(r) => (r.ingestStatus === "pending" ? "opacity-55" : undefined)}
        emptyReason={emptyReason}
        emptyTitle={emptyTitle}
        caption={caption}
        className={className}
      />
      {rows.length > 0 && (hasSprint || hasPaceFlag || hasStatus) ? (
        <dl className="mt-2 space-y-1 text-xs leading-snug text-muted">
          {hasSprint ? (
            <div className="flex gap-2">
              <dt className="shrink-0 font-mono font-semibold text-accent">S</dt>
              <dd>Sprint weekend — a short race on the Saturday, scoring its own points.</dd>
            </div>
          ) : null}
          {hasPaceFlag ? (
            <div className="flex gap-2">
              <dt className="shrink-0 font-medium text-accent whitespace-nowrap">pace ≠ winner</dt>
              <dd>
                The quickest car over the race, once fuel weight is taken out, was not the car that
                won. Track position, strategy or a safety car decided it instead.
              </dd>
            </div>
          ) : null}
          {hasStatus ? (
            <div className="flex gap-2">
              <dt className="shrink-0 font-medium text-fg whitespace-nowrap">Status</dt>
              <dd>
                A round with no badge has complete timing data. &ldquo;Partial data&rdquo; means
                some laps are missing and its pace numbers rest on fewer of them; &ldquo;data
                unavailable&rdquo; means the timing feed could not be processed at all; &ldquo;not
                yet ingested&rdquo; means the round has not been run or not yet analysed.
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}
