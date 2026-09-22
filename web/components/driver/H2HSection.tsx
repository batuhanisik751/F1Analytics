// H2H_SPEC §1/§6 — the "Compared with {B}" section of the driver page. Server component, no
// client JS: the picker is a plain GET form that reloads the page with `?season=&vs=`. Column A
// is always the page's driver; B is `vs`. When `vs` does not resolve the section is the picker
// alone (no empty tables, no EmptyState).
import H2HCarRemovedCard from "@/components/driver/H2HCarRemovedCard";
import H2HLedgerTable from "@/components/driver/H2HLedgerTable";
import Section from "@/components/ui/Section";
import { ledgerCall, modelCall, type Ledger } from "@/lib/driver/h2h";
import {
  C_H2H_5,
  C_H2H_8,
  LEDGER_CALL_LEADER,
  LEDGER_CALL_LEVEL,
  LEDGER_CALL_NONE,
  MODEL_CALL_LEADER,
  MODEL_CALL_NONE,
  fill,
} from "@/lib/driver/h2hCaptions";
import type { Opponent } from "@/lib/queries/h2h";
import type { ContrastRow, DriverRating } from "@/lib/queries/mode2";

/** "Max Verstappen" → "Verstappen": the captions print surnames, as the spec's fills do. */
export function surname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}

export type H2HSectionProps = {
  code: string;
  year: number;
  aFullName: string;
  opponents: { code: string; fullName: string }[];
  /** Null when `vs` is absent, unresolved, or the page's own driver. */
  opponent: Opponent | null;
  ledger: Ledger | null;
  contrast: ContrastRow | null;
  ratingA: DriverRating | null;
  ratingB: DriverRating | null;
};

function leadLine(year: number, a: string, b: string, ledger: Ledger, contrast: ContrastRow | null): string {
  const lc = ledgerCall(ledger);
  const { counted, aWins } = ledger.pace;
  const ledgerText =
    counted === 0
      ? LEDGER_CALL_NONE
      : lc.kind === "leader"
        ? fill(LEDGER_CALL_LEADER, { leader: lc.leaderIsA ? a : b, n: lc.leaderIsA ? aWins : counted - aWins, d: counted })
        : fill(LEDGER_CALL_LEVEL, { n: aWins, d: counted });
  const mc = modelCall(contrast);
  const modelText = mc.kind === "leader" ? fill(MODEL_CALL_LEADER, { leader: mc.leaderIsA ? a : b }) : MODEL_CALL_NONE;
  return fill(C_H2H_8, { year, ledgerCall: ledgerText, modelCall: modelText });
}

function Picker({ code, year, opponents, selected }: { code: string; year: number; opponents: { code: string; fullName: string }[]; selected: string | null }): React.JSX.Element {
  const options = opponents.filter((o) => o.code !== code);
  return (
    <form method="GET" action={`/driver/${code}`} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="season" value={year} />
      <label htmlFor="vs" className="text-sm text-muted">
        Compare with
        <select
          id="vs"
          name="vs"
          defaultValue={selected ?? ""}
          className="ml-2 min-h-[44px] rounded-md border border-grid bg-bg px-2 text-sm text-fg"
        >
          <option value="">Choose a driver</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} · {o.fullName}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="min-h-[44px] rounded-md border border-accent/60 bg-raised px-3 text-sm font-medium text-fg">
        Compare
      </button>
    </form>
  );
}

export default function H2HSection(p: H2HSectionProps): React.JSX.Element {
  const a = surname(p.aFullName);
  const picker = <Picker code={p.code} year={p.year} opponents={p.opponents} selected={p.opponent?.code ?? null} />;
  if (!p.opponent || !p.ledger) {
    return (
      <Section title="Compare with another driver" id="h2h" caption={`Any driver with a ${p.year} race start; the same-race ledger and the car-removed view, side by side.`}>
        {picker}
      </Section>
    );
  }
  const b = surname(p.opponent.fullName);
  return (
    <Section title={`Compared with ${b}`} id="h2h" actions={picker}>
      <p className="mb-4 text-sm leading-relaxed text-fg">{leadLine(p.year, a, b, p.ledger, p.contrast)}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-grid bg-surface p-3">
          <H2HLedgerTable year={p.year} a={a} b={b} ledger={p.ledger} />
        </div>
        <H2HCarRemovedCard
          year={p.year}
          a={a}
          b={b}
          contrast={p.contrast}
          call={modelCall(p.contrast)}
          ratingA={p.ratingA}
          ratingB={p.ratingB}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">{C_H2H_5}</p>
    </Section>
  );
}
