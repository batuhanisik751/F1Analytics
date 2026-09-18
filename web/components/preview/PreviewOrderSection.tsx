// MODE1_SPEC §3.5 / §7.4 — the predicted finishing order with 80% intervals. Needs no
// circuit data at all, so it renders even for a brand-new venue (§3.6).
import PreviewOrderBars from "@/components/charts/PreviewOrderBars";
import Caption from "@/components/ui/Caption";
import { correlationGloss } from "@/components/ui/metricFormat";
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import DriverChip from "@/components/ui/DriverChip";
import EmptyState from "@/components/ui/EmptyState";
import type { PreviewOrderRow, PreviewRound } from "@/lib/queries/preview";

export type PreviewOrderSectionProps = {
  rows: PreviewOrderRow[];
  preview: PreviewRound | null;
  /**
   * The `loro` Brier from `getWinProbTrust()` (race.ts, owned by another package), used
   * only in the new-venue clause of the caption. Omitted renders that number as an
   * em dash; the clause itself only appears when the circuit did not resolve.
   */
  loroBrier?: number | null;
  year?: number;
};

export const PREVIEW_ORDER_TITLE = "Predicted finishing order";
export const PREVIEW_ORDER_HEADER_CAPTION =
  "Form and reliability only — the bar is the range, the tick is the middle of it.";

/** §7.6 — the exact reason string. */
export const PREVIEW_ORDER_EMPTY_REASON = "no results in this season yet";

const DASH = "—";

function num(v: number | null | undefined, dp: number): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(dp) : DASH;
}

/** `preview_round.backtest_coverage` is a share in [0,1]; a value above 1 is already a %. */
function coveragePct(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return DASH;
  return (v <= 1 ? v * 100 : v).toFixed(0);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
}

/** §7.5 verbatim, including the new-venue `locoClause`. */
export function orderCaption(
  preview: PreviewRound | null,
  loroBrier: number | null | undefined,
): string {
  const locoClause =
    preview && preview.circuitKey === null
      ? `This is a circuit the model has never seen. On tracks it had never visited, its win-probability Brier was ${num(preview.locoBrier, 4)} against ${num(loroBrier, 4)} on tracks it knew — expect the same direction of error here.`
      : "";
  const base = `The bar is the range this driver finishes in 8 times out of 10; the tick is the middle of it. There is no qualifying yet, so this is form and reliability only. Replaying the same method over the ${preview?.backtestRaces ?? DASH} races we can check it against, the predicted order matched the real one with a rank correlation of ${num(preview?.backtestSpearman, 2)}, and the actual finish landed inside the bar ${coveragePct(preview?.backtestCoverage)}% of the time. For comparison: once qualifying has happened, simply ordering by the grid scores ${num(preview?.backtestGridSpearman, 2)}.`;
  // §3.3 — a correlation never appears without a plain gloss. Appended as its own sentence so
  // every word of the original caption survives unchanged (§0).
  const s = preview?.backtestSpearman;
  const gloss =
    typeof s === "number" && Number.isFinite(s)
      ? ` A rank correlation of 1 would mean the predicted order came out exactly right and 0 would mean it was no better than shuffling the names, so ${num(s, 2)} means ${correlationGloss(s)}.`
      : "";
  const withGloss = `${base}${gloss}`;
  return locoClause ? `${withGloss} ${locoClause}` : withGloss;
}

export default function PreviewOrderSection({
  rows,
  preview,
  loroBrier,
  year,
}: PreviewOrderSectionProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <EmptyState title="No predicted order for this round" reason={PREVIEW_ORDER_EMPTY_REASON} />
    );
  }
  const columns: DataTableColumn<PreviewOrderRow>[] = [
    {
      key: "driver",
      header: "Driver",
      render: (r) => (
        <DriverChip
          code={r.code}
          teamColour={r.teamColour}
          fullName={r.fullName}
          lineStyle={r.lineStyle}
          href={year ? `/driver/${r.driverId}?season=${year}` : undefined}
          size="sm"
        />
      ),
    },
    {
      key: "expected",
      header: (
        <span className="inline-block leading-tight">
          Expected finish
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            average of the simulated races
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => `P${r.expectedPosition.toFixed(1)}`,
    },
    {
      key: "range",
      header: (
        <span className="inline-block leading-tight">
          8 times in 10
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            the band they finish inside this often
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => `P${r.posP10}–P${r.posP90}`,
    },
    {
      key: "win",
      header: (
        <span className="inline-block leading-tight">
          Win
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            chance of winning
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => pct(r.pWin),
    },
    {
      key: "podium",
      header: (
        <span className="inline-block leading-tight">
          Podium
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            chance of a top-three finish
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => pct(r.pPodium),
    },
    {
      key: "points",
      header: (
        <span className="inline-block leading-tight">
          Points
          <span className="block text-[10px] font-normal normal-case tracking-normal text-muted">
            chance of a top-ten finish
          </span>
        </span>
      ),
      align: "right",
      className: "tnum",
      render: (r) => pct(r.pPoints),
    },
  ];
  return (
    <>
      <div className="rounded-lg border border-grid bg-surface p-3">
        <PreviewOrderBars rows={rows} />
      </div>
      <DataTable
        className="mt-3"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.driverId}
        dense
        caption={`Predicted finishing position for ${rows.length} drivers, with the chance of a win, a podium and a points finish. No qualifying has happened yet, so this is form and reliability only.`}
      />
      <Caption>{orderCaption(preview, loroBrier)}</Caption>
    </>
  );
}
