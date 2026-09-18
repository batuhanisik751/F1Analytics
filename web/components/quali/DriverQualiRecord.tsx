// QUALI_SPEC §6.5 — the driver page's qualifying record: season · kind · sessions ·
// poles · final-segment appearances · median gap to pole (%) · best gap to pole (%).
// ONE ROW PER YEAR AND KIND, and no pooled career figure: pooling a sprint-qualifying
// gap with a qualifying gap, or 2024 with 2026, is exactly what §0.4 note 7 forbids.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import EmptyState from "@/components/ui/EmptyState";
import TermTip from "@/components/ui/TermTip";
import { fmtPct } from "@/lib/format";
import type { DriverQualiSeason } from "@/lib/queries/quali";
import { NO_DRIVER_QUALI } from "./captions";

export default function DriverQualiRecord({
  rows,
}: {
  rows: DriverQualiSeason[];
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={NO_DRIVER_QUALI}
        reason="quali_results has no rows for this driver in any ingested session"
      />
    );
  }
  const columns: DataTableColumn<DriverQualiSeason>[] = [
    { key: "year", header: "Season", render: (r) => r.year },
    {
      key: "kind",
      header: "Session",
      render: (r) => (r.kind === "SQ" ? "Sprint qualifying" : "Qualifying"),
    },
    { key: "sessions", header: "Sessions", align: "right", render: (r) => r.sessions },
    {
      key: "poles",
      header: "Poles",
      align: "right",
      render: (r) =>
        r.poles > 0 ? (
          <span style={{ color: "var(--color-fastest)" }} className="font-semibold">
            {r.poles}
          </span>
        ) : (
          <span className="text-muted">0</span>
        ),
    },
    {
      key: "final",
      header: "Final segment",
      align: "right",
      render: (r) => r.finalSegmentAppearances,
    },
    {
      // §3.3 — one unit, named the way a fan says it, with its definition one tap away.
      key: "median",
      header: (
        <>
          Typical gap to pole <TermTip term="pp" placement="bottom">% of a lap</TermTip>
        </>
      ),
      align: "right",
      render: (r) => fmtPct(r.medianGapToPoleCommonPct),
    },
    {
      key: "best",
      header: (
        <>
          Best gap to pole <TermTip term="pp" placement="bottom">% of a lap</TermTip>
        </>
      ),
      align: "right",
      className: "text-muted",
      render: (r) => fmtPct(r.bestGapToPoleCommonPct),
    },
  ];
  return (
    <DataTable
      caption="One row per season and per session type — a sprint-qualifying gap and a qualifying gap are not the same measurement, and neither are two different seasons, so they are never pooled into a career figure."
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.year}-${r.kind}`}
      dense
      emptyTitle={NO_DRIVER_QUALI}
    />
  );
}
