// SPEC §4.3 item 8 — rank and gap per fuel constant; rows that move get an accent border.
import Caption from "@/components/ui/Caption";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import { fmtGap } from "@/lib/format";
import type { SensitivityRow } from "@/lib/queries/race";

export type SensitivityTableProps = {
  values: number[];
  baseValue: number;
  rows: SensitivityRow[];
  movers: number;
  year: number;
  reason?: string | null;
};

export const SENSITIVITY_CAPTION =
  "Our pace numbers depend on a fuel constant that is an assumption, not a measurement. Where the ordering holds across the plausible range, the result is a fact about the race; where it shuffles, it was an artefact of a number we guessed — and those drivers are genuinely too close to separate from one race.";

export default function SensitivityTable({
  values,
  baseValue,
  rows,
  movers,
  year,
  reason,
}: SensitivityTableProps): React.JSX.Element {
  if (rows.length === 0 || values.length === 0) {
    return <EmptyState title="No fuel-sensitivity table for this race" reason={reason} />;
  }

  const columns: DataTableColumn<SensitivityRow>[] = [
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip
          code={r.code}
          teamColour={r.team.teamColour}
          href={`/driver/${r.code}?season=${year}`}
          title={r.team.teamName}
        />
      ),
    },
  ];
  for (const v of values) {
    const isBase = v === baseValue;
    const headerCls = isBase ? "text-accent" : undefined;
    columns.push({
      key: `rank@${v}`,
      header: (
        // §4.3 — the ● used to mean "published constant" only to a reader who could hover it.
        // The meaning is now written out for screen readers and in the legend under the table.
        <span className={headerCls}>
          Rank at {v}
          {isBase ? (
            <>
              {" ●"}
              <span className="sr-only"> — the constant the published ranking uses</span>
            </>
          ) : null}
          <span className="sr-only"> seconds per kilogram of fuel per lap</span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => {
        const c = r.cells.find((x) => x.fuelEffect === v);
        return c ? c.rank : "—";
      },
    });
    columns.push({
      key: `gap@${v}`,
      header: (
        <span className={headerCls}>
          Gap at {v}
          <span className="sr-only"> seconds per kilogram of fuel per lap, gap to the leader in seconds</span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => {
        const c = r.cells.find((x) => x.fuelEffect === v);
        return c ? (c.rank === 1 ? "—" : fmtGap(c.gapS)) : "—";
      },
    });
  }

  return (
    <>
      <p className="mb-3 text-sm text-fg">
        <span className="tnum font-semibold">{movers}</span> of{" "}
        <span className="tnum font-semibold">{rows.length}</span> placings move across the
        plausible range{" "}
        <span className="text-muted">
          ({values[0]}–{values[values.length - 1]} s/kg/lap; published ranking uses {baseValue})
        </span>
      </p>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Each pair of columns re-runs the pace ranking with a different guess at how much a kilogram
        of fuel costs in lap time, in seconds per kilogram per lap. ● marks the guess the published
        ranking uses. A driver with a red line down the left changes position somewhere across the
        range.
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.driverId}
        dense
        rowClassName={(r) => (r.moves ? "border-l-2 border-l-accent" : undefined)}
        caption={`Race-pace rank and gap to the leader for ${rows.length} drivers under ${values.length} different fuel constants.`}
      />
      <Caption>{SENSITIVITY_CAPTION}</Caption>
    </>
  );
}
