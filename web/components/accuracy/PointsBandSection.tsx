// ACCURACY_SPEC §1 row 4 — "Did the mid-season points projections hold up?": every finished
// season's end-of-season points ranges marked against the real final table, by quarter. The
// verdicts and the quarter tables are open (the answer); the per-round table is closed (the
// evidence). A server component: `getPointsBand` has already scored every row.
import Section from "@/components/ui/Section";
import Caption from "@/components/ui/Caption";
import DataTable from "@/components/ui/DataTable";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import type { PointsBandRound, PointsBandSeason } from "@/lib/queries/accuracyScore";
import * as C from "@/lib/accuracy/captions";

/** Same shape as the page's percent formatter: one decimal, "—" when unknown. */
const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
const one = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toFixed(1);

/** cAcc17 takes its season count as a word ("two"); past ten the digits are clearer. */
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

type RoundRow = PointsBandRound & { year: number };

function QuarterTable({ season }: { season: PointsBandSeason }): React.JSX.Element {
  return (
    <DataTable
      className="mt-3"
      caption={`Final-points range scored by quarter, ${season.year}`}
      columns={[
        {
          key: "q",
          header: "Quarter (rounds)",
          render: (r) => `Q${r.q} (${r.roundLo}–${r.roundHi})`,
        },
        { key: "n", header: "Driver-rounds", align: "right", render: (r) => r.n },
        {
          key: "coveragePct",
          header: "Range held the final total",
          align: "right",
          render: (r) => pct(r.coveragePct),
        },
        { key: "nominal", header: "Promised", align: "right", render: () => pct(season.nominalPct, 0) },
        {
          key: "meanAbsError",
          header: "Points off on average",
          align: "right",
          render: (r) => one(r.meanAbsError),
        },
        {
          key: "meanWidth",
          header: "Range width (points)",
          align: "right",
          render: (r) => one(r.meanWidth),
        },
      ]}
      rowKey={(r) => `${season.year}/q${r.q}`}
      rows={season.quarters}
    />
  );
}

function EveryRound({ rows }: { rows: RoundRow[] }): React.JSX.Element {
  return (
    <DataTable
      dense
      caption="Final-points range scored after every round"
      columns={[
        { key: "year", header: "Season", render: (r) => r.year },
        { key: "afterRound", header: "After round", align: "right", render: (r) => r.afterRound },
        { key: "n", header: "Driver-rounds", align: "right", render: (r) => r.n },
        { key: "coveragePct", header: "Held", align: "right", render: (r) => pct(r.coveragePct) },
        { key: "meanAbsError", header: "Points off", align: "right", render: (r) => one(r.meanAbsError) },
        { key: "meanWidth", header: "Width", align: "right", render: (r) => one(r.meanWidth) },
      ]}
      rowKey={(r) => `${r.year}/${r.afterRound}`}
      rows={rows}
    />
  );
}

export default function PointsBandSection({
  seasons,
}: {
  seasons: PointsBandSeason[];
}): React.JSX.Element {
  // The nominal level is a property of the band, identical across seasons; 80 is the type.
  const nominal = pct(seasons[0]?.nominalPct ?? 80, 0);
  const roundRows: RoundRow[] = seasons.flatMap((s) =>
    s.rounds.map((r) => ({ ...r, year: s.year })),
  );
  return (
    <Section
      id="points-band"
      title="Did the mid-season points projections hold up?"
      caption={C.cAcc15(nominal)}
    >
      {seasons.length === 0 ? (
        <EmptyState title="No finished season to score">{C.C_ACC_EMPTY}</EmptyState>
      ) : (
        <>
          {seasons.map((s) => {
            const q1 = s.quarters[0];
            const q4 = s.quarters[s.quarters.length - 1];
            return (
              <div key={s.year} className="mt-2 first:mt-0">
                {q1 && q4 ? (
                  <Caption>
                    {C.cAcc16(String(s.year), pct(q1.coveragePct), pct(s.nominalPct, 0),
                              one(q1.meanAbsError), pct(q4.coveragePct), one(q4.meanAbsError))}
                  </Caption>
                ) : null}
                <QuarterTable season={s} />
              </div>
            );
          })}
          <Caption>{C.cAcc17(countWord(seasons.length))}</Caption>
          <Caption>{C.C_ACC_18}</Caption>
          <Disclosure className="mt-4" summary={`Every round — ${roundRows.length} rows`}>
            <EveryRound rows={roundRows} />
          </Disclosure>
        </>
      )}
    </Section>
  );
}
