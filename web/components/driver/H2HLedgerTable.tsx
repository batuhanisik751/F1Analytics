// H2H_SPEC §2/§6 — Answer 1, the raw same-race ledger: car and driver together.
// Four columns only (Row · A · B · counted) so it fits 375 px with no scroller; each
// counted row's C_H2H_2 sentence is a full-width second <tr> (colSpan=4), never a tooltip.
// Counts arrive from tallyLedger; nothing here subtracts two stored estimates.
import type { Ledger } from "@/lib/driver/h2h";
import { C_H2H_1, C_H2H_2, C_H2H_2Q, C_H2H_3, fill } from "@/lib/driver/h2hCaptions";

export type H2HLedgerTableProps = {
  year: number;
  /** Surnames, as the captions print them ("Norris", "Verstappen"). */
  a: string;
  b: string;
  ledger: Ledger;
};

const TH = "px-2 py-1.5 text-left text-[11px]";
const TD = "px-2 py-1.5 align-top";
const SENTENCE = "px-2 pb-2 text-xs leading-relaxed text-muted";

function CountedRow({
  label,
  counted,
  aWins,
  sentence,
}: {
  label: string;
  counted: number;
  aWins: number;
  sentence: React.ReactNode;
}): React.JSX.Element {
  const bWins = counted - aWins;
  return (
    <>
      <tr className="border-t border-grid/60">
        <th scope="row" className={`${TD} text-left font-medium text-fg`}>{label}</th>
        <td className={`${TD} tnum text-right`}>{aWins} of {counted}</td>
        <td className={`${TD} tnum text-right`}>{bWins} of {counted}</td>
        <td className={`${TD} tnum text-right`}>{counted}</td>
      </tr>
      <tr>
        <td colSpan={4} className={SENTENCE}>{sentence}</td>
      </tr>
    </>
  );
}

export default function H2HLedgerTable({ year, a, b, ledger }: H2HLedgerTableProps): React.JSX.Element {
  const { shared, quali, finish, pace, points } = ledger;
  const line = (wins: number, counted: number): string => fill(C_H2H_2, { a, wins, counted });
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="mb-2 text-left text-xs leading-relaxed text-muted">
        {fill(C_H2H_1, { year, a, b, shared })}
      </caption>
      <thead className="tower-label border-b-2 border-accent/60 bg-raised text-muted">
        <tr>
          <th scope="col" className={TH}>Row</th>
          <th scope="col" className={`${TH} text-right`}>{a}</th>
          <th scope="col" className={`${TH} text-right`}>{b}</th>
          <th scope="col" className={`${TH} text-right`}>counted</th>
        </tr>
      </thead>
      <tbody>
        <CountedRow
          label="Qualified ahead (qualifying position, not grid)"
          counted={quali.counted}
          aWins={quali.aWins}
          sentence={
            <>
              {line(quali.aWins, quali.counted)} {C_H2H_2Q}
            </>
          }
        />
        <CountedRow
          label="Finished ahead"
          counted={finish.counted}
          aWins={finish.aWins}
          sentence={line(finish.aWins, finish.counted)}
        />
        <CountedRow
          label="Faster race pace"
          counted={pace.counted}
          aWins={pace.aWins}
          sentence={line(pace.aWins, pace.counted)}
        />
        <tr className="border-t border-grid/60">
          <th scope="row" className={`${TD} text-left font-medium text-fg`}>Points</th>
          <td className={`${TD} tnum text-right`}>{points.a}</td>
          <td className={`${TD} tnum text-right`}>{points.b}</td>
          <td className={`${TD} tnum text-right`}>{shared}</td>
        </tr>
        <tr>
          <td colSpan={4} className={SENTENCE}>
            {fill(C_H2H_3, { a, b, pointsA: points.a, pointsB: points.b, shared })}
          </td>
        </tr>
        <tr className="border-t border-grid/60">
          <th scope="row" className={`${TD} text-left font-medium text-fg`}>Races one or both did not finish</th>
          <td className={`${TD} tnum text-right`} colSpan={3}>{finish.unclassifiedAny}</td>
        </tr>
      </tbody>
    </table>
  );
}
