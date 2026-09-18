// /accuracy — the app's own track record.
//
// This is the page a statistics project owes its reader. Every other route answers "what
// happened"; this one answers "how often were we wrong", using scores the model already
// records and nothing else. It leads with the out-of-sample number, shows the in-sample one
// beside it so the difference is visible, and states the one check that has a target rather
// than a vibe: a p10-p90 interval claims 80 % coverage by construction, so its measured
// coverage is falsifiable.
import type { Metadata } from "next";
import PageHeader from "@/components/ui/PageHeader";
import Section from "@/components/ui/Section";
import Caption from "@/components/ui/Caption";
import Metric from "@/components/ui/Metric";
import DataTable from "@/components/ui/DataTable";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import ReliabilityChart from "@/components/charts/ReliabilityChart";
import {
  getSkill,
  getReliability,
  getIntervalCoverage,
  getCoverageBySeason,
} from "@/lib/queries/accuracy";
import * as C from "@/lib/accuracy/captions";

export const dynamic = "force-dynamic";

// The layout supplies the "· F1 Analytics" suffix; repeating it here doubled it.
export const metadata: Metadata = {
  title: "How right were we?",
  description:
    "The app's own prediction record, scored against races the model never saw.",
};

const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;

/** Scope labels a fan can read. The raw keys are model vocabulary. */
const SCOPE_LABEL: Record<string, string> = {
  in_sample: "Races it trained on",
  loco: "Circuits held out",
  loro: "Rounds held out",
};
const scopeLabel = (s: string) =>
  SCOPE_LABEL[s] ?? (s.startsWith("year:") ? `${s.slice(5)} season only` : s);

export default async function AccuracyPage(): Promise<React.JSX.Element> {
  const [skill, reliability, coverage, bySeason] = await Promise.all([
    getSkill(),
    getReliability("loco"),
    getIntervalCoverage(),
    getCoverageBySeason(),
  ]);

  // "plain" is the shipped variant; isotonic is the calibrated alternative kept for comparison.
  const inSample = skill.find((s) => s.scope === "in_sample" && s.variant === "plain");
  const heldOut = skill.find((s) => s.scope === "loco" && s.variant === "plain");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <PageHeader
        title="How right were we?"
        subtitle="The model's own record, scored on races it had never seen"
      />
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">{C.C_ACC_1}</p>

      <Section
        id="skill"
        title="Win probability"
        caption={C.C_ACC_2}
        className="mt-10"
      >
        {skill.length === 0 ? (
          <EmptyState title="Not scored yet">{C.C_ACC_EMPTY}</EmptyState>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Metric
                label="Better than grid position alone"
                value={pct(heldOut?.skillVsPosition)}
                unit="on circuits held out of training"
                hint="The honest number: scored only on circuits the model never saw."
              />
              <Metric
                label="Better on races it trained on"
                value={pct(inSample?.skillVsPosition)}
                unit="in-sample, shown for contrast"
                hint="Always the larger number. The gap is the flattery."
              />
            </div>
            {inSample?.skillVsPosition != null && heldOut?.skillVsPosition != null ? (
              <Caption>
                {C.cAcc3(pct(inSample.skillVsPosition), pct(heldOut.skillVsPosition))}
              </Caption>
            ) : null}

            <Disclosure
              className="mt-4"
              summary={`Every scope scored — ${skill.length} rows, Brier against two baselines`}
            >
              <DataTable
                caption="Win-probability skill by evaluation scope"
                columns={[
                  { key: "scope", header: "Scored on", render: (r) => scopeLabel(r.scope) },
                  { key: "variant", header: "Variant", render: (r) => r.variant },
                  { key: "nRaces", header: "Races", align: "right", render: (r) => r.nRaces },
                  {
                    key: "brier",
                    header: "Brier",
                    align: "right",
                    render: (r) => r.brier.toFixed(5),
                  },
                  {
                    key: "baselinePosition",
                    header: "Grid baseline",
                    align: "right",
                    render: (r) => r.baselinePosition?.toFixed(5) ?? "—",
                  },
                  {
                    key: "skillVsPosition",
                    header: "Better by",
                    align: "right",
                    render: (r) => pct(r.skillVsPosition),
                  },
                ]}
                rowKey={(r) => `${r.scope}/${r.variant}`}
                rows={skill}
              />
            </Disclosure>
          </>
        )}
      </Section>

      <Section id="calibration" title="Is it calibrated?" caption={C.C_ACC_4}>
        {reliability.length === 0 ? (
          <EmptyState title="No calibration data">{C.C_ACC_EMPTY}</EmptyState>
        ) : (
          <ReliabilityChart
            scopes={[
              {
                scope: "loco",
                label: "Circuits held out of training",
                brier: heldOut?.brier ?? 0,
                bins: reliability.map((b) => ({
                  binLo: b.binLo,
                  binHi: b.binHi,
                  nRows: b.nRows,
                  meanPredicted: b.meanPredicted,
                  observedRate: b.observedRate,
                  observedLo: b.observedLo ?? b.observedRate,
                  observedHi: b.observedHi ?? b.observedRate,
                })),
              },
            ]}
          />
        )}
      </Section>

      <Section id="intervals" title="Did the range contain the answer?">
        {coverage === null ? (
          <EmptyState title="No scored previews">{C.C_ACC_EMPTY}</EmptyState>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Metric
                label="Range contained the finish"
                value={pct(coverage.coveragePct)}
                unit={`of ${coverage.predictions.toLocaleString()} predictions`}
                hint="Measured. Compare with what the range promises, beside it."
              />
              <Metric
                label="What the range promises"
                value={pct(coverage.nominalPct, 0)}
                unit="by construction"
                hint="A p10–p90 band is built to contain the answer 80% of the time."
              />
              <Metric
                label="Typical miss"
                value={coverage.meanAbsError.toFixed(1)}
                unit="places off, on average"
                hint={`Median ${coverage.medianAbsError.toFixed(1)} places.`}
              />
            </div>
            <Caption>
              {C.cAcc5(pct(coverage.coveragePct), pct(coverage.nominalPct, 0),
                       coverage.predictions.toLocaleString())}
            </Caption>
            <Caption>{C.C_ACC_6}</Caption>

            {bySeason.length > 0 ? (
              <Disclosure className="mt-4" summary={`Split by season — ${bySeason.length} seasons`}>
                <p className="mb-2 text-xs text-muted">{C.C_ACC_7}</p>
                <DataTable
                  caption="Interval coverage and mean error by season"
                  columns={[
                    { key: "year", header: "Season", render: (r) => r.year },
                    { key: "predictions", header: "Predictions", align: "right", render: (r) => r.predictions },
                    {
                      key: "coveragePct",
                      header: "Contained the finish",
                      align: "right",
                      render: (r) => pct(r.coveragePct),
                    },
                    {
                      key: "meanAbsError",
                      header: "Mean miss (places)",
                      align: "right",
                      render: (r) => r.meanAbsError.toFixed(2),
                    },
                  ]}
                  rowKey={(r) => String(r.year)}
                  rows={bySeason}
                />
              </Disclosure>
            ) : null}
          </>
        )}
      </Section>

      <Section id="limits" title="What these scores do not say">
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{C.C_ACC_8}</p>
      </Section>
    </div>
  );
}
