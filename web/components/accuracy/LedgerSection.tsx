// LEDGER_SPEC §4 — "What we said before each race": the previews as they stood before each
// race, scored against the result once it exists, and the title chances after each round as
// the current model reconstructs them. A server component: `getPreviewLedger` has already
// picked and scored the snapshot of every round; nothing here reads the clock or the database.
import Section from "@/components/ui/Section";
import Caption from "@/components/ui/Caption";
import DataTable from "@/components/ui/DataTable";
import { fmtDate, gpShortName } from "@/lib/format";
import type { LedgerPick, LedgerRow, PreviewLedger, TitleOddsDriver, TitleOddsLine } from "@/lib/queries/ledger";
import * as C from "@/lib/accuracy/captions";

/** Same shape as the page's percent formatter: one decimal, "—" when unknown. */
const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
/** A share (0–1) as a percentage. */
const share = (v: number | null | undefined) => pct(v === null || v === undefined ? v : v * 100);
/** A correlation: three decimals, "—" when unknown. */
const corr = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toFixed(3);
/** cLedEmpty / cLed2 take their counts pre-formatted ("9 previews"), as cAcc17 does. */
const count = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

const UTC_STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  timeZone: "UTC", timeZoneName: "short",
});
/** `computed_at` with its time, so two copies on one day stay distinguishable. */
const stamp = (iso: string) => {
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : UTC_STAMP.format(d);
};
const pick = (p: LedgerPick) => `${p.code} (${p.posP10}–${p.posP90})`;

function LedgerTable({ ledger }: { ledger: PreviewLedger }): React.JSX.Element {
  const emptyReason =
    ledger.previews === 0 ? C.C_LED_EMPTY_NONE : C.cLedEmpty(count(ledger.previews, "preview"));
  return (
    <DataTable
      caption={`Previews scored against the race they preceded, ${ledger.year}`}
      emptyReason={emptyReason}
      columns={[
        {
          key: "round",
          header: "Round",
          render: (r: LedgerRow) => (r.eventName ? `${r.round} · ${gpShortName(r.eventName)}` : r.round),
        },
        { key: "computedAt", header: "Preview dated", render: (r) => stamp(r.computedAt) },
        { key: "ours", header: "Our top three", render: (r) => r.ourTopThree.map(pick).join(", ") || "—" },
        { key: "actual", header: "Actual top three", render: (r) => r.actualTopThree.join(", ") || "—" },
        { key: "spearman", header: "Rank agreement", align: "right", render: (r) => corr(r.spearman) },
        { key: "claimedSpearman", header: "Claimed", align: "right", render: (r) => corr(r.claimedSpearman) },
        { key: "coverage", header: "Bands held", align: "right", render: (r) => share(r.coverage) },
        { key: "claimedCoverage", header: "Claimed", align: "right", render: (r) => share(r.claimedCoverage) },
        { key: "notClassified", header: "Not classified", align: "right", render: (r) => r.notClassified },
      ]}
      rowKey={(r) => `${r.year}/${r.round}/${r.computedAt}`}
      rows={ledger.rows}
    />
  );
}

function TitleCell({ d, afterRound }: { d: TitleOddsDriver; afterRound: number }): React.JSX.Element {
  const c = d.cells.find((x) => x.afterRound === afterRound);
  if (!c) return <>—</>;
  return (
    <>
      <span>{pct(c.pTitle * 100)}</span>
      {c.isShrunkToPrior ? (
        <span className="ml-1 rounded border border-grid px-1 text-[10px] uppercase text-muted">prior</span>
      ) : null}
      <span className="block text-[11px] text-muted">{`${pct(c.pTitleLo * 100)}–${pct(c.pTitleHi * 100)}`}</span>
    </>
  );
}

function TitleTable({ line }: { line: TitleOddsLine }): React.JSX.Element {
  return (
    <DataTable
      dense
      caption={`Title chances after each round, five leading drivers, ${line.year}`}
      columns={[
        { key: "driver", header: "Driver", render: (d: TitleOddsDriver) => d.code },
        ...line.rounds.map((r) => ({
          key: `r${r}`,
          header: `R${r}`,
          align: "right" as const,
          render: (d: TitleOddsDriver) => <TitleCell d={d} afterRound={r} />,
        })),
      ]}
      rowKey={(d) => d.driverId}
      rows={line.drivers}
    />
  );
}

export default function LedgerSection({
  ledger,
  titleLine,
}: {
  ledger: PreviewLedger;
  titleLine: TitleOddsLine | null;
}): React.JSX.Element {
  return (
    <Section id="ledger" title="What we said before each race" caption={C.C_LED_1}>
      <LedgerTable ledger={ledger} />
      {ledger.rows.length > 0 && ledger.firstComputedAt ? (
        <Caption>{C.cLed2(count(ledger.roundsOnRecord, "race"), fmtDate(ledger.firstComputedAt))}</Caption>
      ) : null}
      <Caption>{C.C_LED_3}</Caption>
      {titleLine ? (
        <div id="title-record" className="mt-6">
          <Caption>{C.C_LED_4}</Caption>
          <TitleTable line={titleLine} />
        </div>
      ) : null}
    </Section>
  );
}
