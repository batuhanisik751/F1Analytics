// QUALI_SPEC §6.2 (d) — one row per team pair, the delta in the deepest common segment.
//
// The one rule this component exists to enforce (§4.3, §0.4 note 2): a `belowNoise` row
// renders the words "no measurable difference" and NEVER a number. The session's own
// repeatability is in the hover, so the reader can see why.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import TermTip from "@/components/ui/TermTip";
import { fmtGap, fmtPct } from "@/lib/format";
import type { QualiH2HRow } from "@/lib/queries/quali";

const DASH = "—";

export default function QualiTeammateTable({
  rows,
  kind = "Q",
}: {
  rows: QualiH2HRow[];
  kind?: "Q" | "SQ";
}): React.JSX.Element {
  const columns: DataTableColumn<QualiH2HRow>[] = [
    { key: "team", header: "Team", render: (r) => r.teamName },
    {
      key: "pair",
      header: "Pair",
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <DriverChip code={r.codeA} teamColour={r.colour} href={`/driver/${r.codeA}`} size="sm" />
          <span className="text-muted">v</span>
          <DriverChip code={r.codeB} teamColour={r.colour} href={`/driver/${r.codeB}`} size="sm" />
        </span>
      ),
    },
    {
      key: "segment",
      header: "Segment",
      align: "center",
      className: "text-muted",
      render: (r) => (r.segment === null ? DASH : `${kind === "SQ" ? "SQ" : "Q"}${r.segment}`),
    },
    {
      key: "delta",
      header: "Gap",
      align: "right",
      render: (r) => {
        if (!r.comparable || r.deltaS === null) {
          return <span className="text-muted">{DASH}</span>;
        }
        if (r.belowNoise) {
          // UX_SPEC §3.1 — the reason was in a `title`, which a phone and a keyboard never
          // reach. It is now on the page, under the refusal it explains.
          return (
            <span className="block text-muted">
              no measurable difference
              <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                {r.sessionSdS === null
                  ? "below what this session can repeat"
                  : `their own push laps here vary by ${fmtGap(r.sessionSdS)} — more than the gap`}
              </span>
            </span>
          );
        }
        return (
          <span style={{ color: "var(--color-personal)" }} className="font-semibold">
            {r.codeA} by {fmtGap(r.deltaS).replace("+", "")}
          </span>
        );
      },
    },
    {
      key: "deltapct",
      header: (
        <>
          Gap <TermTip term="pp" placement="bottom">% of a lap</TermTip>
        </>
      ),
      align: "right",
      className: "text-muted",
      render: (r) => (r.comparable && !r.belowNoise ? fmtPct(r.deltaPct) : DASH),
    },
    {
      key: "classified",
      header: "Classified ahead",
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">
            {r.classifiedAhead === r.driverA ? r.codeA : r.codeB}
          </span>
          {r.divergent ? (
            <span
              className="rounded-sm px-1 text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-slower)", border: "1px solid currentColor" }}
            >
              split
              <span className="sr-only">
                {" "}
                — the quicker lap and the better classification belong to different drivers
              </span>
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      caption="Teammate against teammate in the deepest segment both drivers reached: the gap, and which of them was classified ahead. A gap smaller than the session's own lap-to-lap variation is reported as no measurable difference rather than as a number."
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.teamId}-${r.driverA}-${r.driverB}`}
      rowAccent={(r) => r.colour}
      rowClassName={(r) => (r.comparable ? undefined : "opacity-60")}
      emptyTitle="No teammate comparison for this session"
      emptyReason="quali_teammate_h2h has no rows for this session"
    />
  );
}
