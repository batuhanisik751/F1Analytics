// QUALI_SPEC §6.4 — "Qualifying pace at this circuit": the median same-segment gap to
// pole across previous Q sessions at this circuit, with the session count.
//
// READ-ONLY HISTORY. It is not an input to the preview forecast and it does not move
// MODE1 §3.5's 0.653 ceiling (§5.5, §0.4 note 1). Fewer than three previous sessions
// renders greyed, with the count.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import TermTip from "@/components/ui/TermTip";
import { fmtPct } from "@/lib/format";
import { CIRCUIT_HISTORY_MIN_SESSIONS, type CircuitQualiHistoryRow } from "@/lib/queries/quali";

export const CIRCUIT_QUALI_PANEL_TITLE = "Qualifying pace at this circuit";

export default function CircuitQualiHistoryPanel({
  rows,
}: {
  rows: CircuitQualiHistoryRow[];
}): React.JSX.Element | null {
  // §6.6: fewer than one previous session for every driver means the panel is not rendered.
  if (rows.length === 0 || rows.every((r) => r.sessions < 1)) return null;
  const columns: DataTableColumn<CircuitQualiHistoryRow>[] = [
    {
      key: "driver",
      header: "Driver",
      render: (r) => <DriverChip code={r.code} teamColour={r.colour} href={`/driver/${r.code}`} size="sm" />,
    },
    {
      key: "median",
      header: (
        <>
          Typical gap to pole here <TermTip term="pp" placement="bottom">% of a lap</TermTip>
        </>
      ),
      align: "right",
      render: (r) => fmtPct(r.medianGapToPoleCommonPct),
    },
    {
      key: "sessions",
      header: "Sessions counted",
      align: "right",
      className: "text-muted",
      render: (r) => (
        <>
          {r.sessions}
          {r.sessions < CIRCUIT_HISTORY_MIN_SESSIONS ? (
            <span className="sr-only"> — fewer than three, too few to read as a pattern</span>
          ) : null}
        </>
      ),
    },
  ];
  return (
    <DataTable
      caption={`Previous qualifying at this circuit, as the middle gap to pole across those sessions. Rows built on fewer than ${CIRCUIT_HISTORY_MIN_SESSIONS} sessions are greyed, with the count shown.`}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.driverId}
      rowAccent={(r) => r.colour}
      rowClassName={(r) => (r.sessions < CIRCUIT_HISTORY_MIN_SESSIONS ? "opacity-50" : undefined)}
      dense
      emptyTitle="No previous qualifying at this circuit"
      emptyReason="no ingested Q session at this circuit for any entered driver"
    />
  );
}
