// ACCURACY_SPEC §1 row 3 / §4 — "Three ways to draw the range": our p10–p90 band beside the
// no-model comparators (grid slot ± k, clipped to the grid), scored on the same predictions.
// A server component with no state; every number arrives scored from `getIntervalSharpness`.
import DataTable from "@/components/ui/DataTable";
import type { IntervalSharpness } from "@/lib/queries/accuracyScore";

/** Same shape as the page's percent formatter: one decimal, "—" when unknown. */
const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
const one = (v: number) => v.toFixed(1);

type Row = {
  key: string;
  label: string;
  meanWidth: number;
  coveragePct: number;
  meanAbsError: number;
  winkler: number;
};

export default function RangeComparatorTable({
  sharpness,
}: {
  sharpness: IntervalSharpness;
}): React.JSX.Element {
  const rows: Row[] = [
    {
      key: "model",
      label: "Our range (p10–p90)",
      meanWidth: sharpness.meanWidth,
      coveragePct: sharpness.coveragePct,
      meanAbsError: sharpness.meanAbsError,
      winkler: sharpness.winkler,
    },
    ...sharpness.naive.map((n) => ({
      key: `grid${n.k}`,
      label: `Grid slot ± ${n.k}`,
      meanWidth: n.meanWidth,
      coveragePct: n.coveragePct,
      meanAbsError: n.meanAbsError,
      winkler: n.winkler,
    })),
  ];
  return (
    <DataTable
      className="mt-4"
      caption="Three ways to draw the range"
      columns={[
        { key: "label", header: "Range", render: (r) => r.label },
        { key: "meanWidth", header: "Width (places)", align: "right", render: (r) => one(r.meanWidth) },
        {
          key: "coveragePct",
          header: "Contained the finish",
          align: "right",
          render: (r) => pct(r.coveragePct),
        },
        {
          key: "meanAbsError",
          header: "Centre's typical miss (places)",
          align: "right",
          render: (r) => one(r.meanAbsError),
        },
        { key: "winkler", header: "Score", align: "right", render: (r) => one(r.winkler) },
      ]}
      rowKey={(r) => r.key}
      rows={rows}
    />
  );
}
