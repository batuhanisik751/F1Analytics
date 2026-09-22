// SPEC §4.4 (5): one card per teammate_h2h row — races paired, pace wins/losses
// ("9 of 13 races faster"), mean and median signed gap %, finish H2H, grid H2H,
// points for/against. Positive gap = this driver faster (§0.3).
import DriverChip from "@/components/ui/DriverChip";
import { fmtPct } from "@/lib/format";
import type { H2HRow } from "@/lib/queries/driver";

export type H2HCardProps = {
  row: H2HRow;
  /** This driver's code (left side of every "X – Y" pair). */
  code: string;
  year: number;
};

function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

function Pair({
  label,
  left,
  right,
  hint,
}: {
  label: string;
  left: React.ReactNode;
  right: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-grid/70 bg-bg/40 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tnum mt-0.5 text-lg font-semibold text-fg">
        {left}
        <span className="mx-1.5 text-muted">–</span>
        {right}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

function signClass(v: number | null): string {
  if (v === null) return "";
  return v > 0 ? "text-emerald-300" : v < 0 ? "text-red-300" : "";
}

export default function H2HCard({ row, code, year }: H2HCardProps): React.JSX.Element {
  const t = row.teammate;
  const paceTotal = row.paceWins + row.paceLosses;
  const paceLine =
    paceTotal === 0
      ? "no race where both were ranked"
      : `${row.paceWins} of ${paceTotal} ${paceTotal === 1 ? "race" : "races"} faster`;
  return (
    <article className="rounded-lg border border-grid bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono font-semibold text-fg">{code}</span>
          <span className="text-muted">vs</span>
          <DriverChip
            code={t.code}
            teamColour={t.teamColour}
            lineStyle={t.lineStyle}
            fullName={t.fullName}
            href={`/driver/${t.code}?season=${year}`}
          />
        </div>
        <span className="text-xs text-muted">
          {t.teamName} · {row.racesPaired} {row.racesPaired === 1 ? "race" : "races"} paired
          {" · "}
          {/* H2H_SPEC §1 — entry to the "Compared with" section: qualifying, finishes, pace, points and the car-removed view. */}
          <a href={`/driver/${code}?season=${year}&vs=${t.code}#h2h`} className="underline decoration-grid underline-offset-2 hover:text-accent">
            Compare all races
          </a>
        </span>
      </header>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Pair label="Pace H2H" left={row.paceWins} right={row.paceLosses} hint={paceLine} />
        <div className="rounded-md border border-grid/70 bg-bg/40 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Signed pace gap</div>
          <div className={`tnum mt-0.5 text-lg font-semibold ${signClass(row.meanSignedGapPct)}`}>
            {fmtPct(row.meanSignedGapPct, { signed: true })}
            <span className="ml-1 text-xs font-normal text-muted">mean</span>
          </div>
          <div className={`tnum text-sm ${signClass(row.medianSignedGapPct)}`}>
            {fmtPct(row.medianSignedGapPct, { signed: true })}
            <span className="ml-1 text-xs text-muted">median · + = {code} faster</span>
          </div>
        </div>
        <Pair label="Finish H2H" left={row.finishWins} right={row.finishLosses} hint="both classified" />
        <Pair label="Grid H2H" left={row.gridWins} right={row.gridLosses} hint="both started from the grid" />
        <Pair
          label="Points"
          left={fmtPoints(row.pointsFor)}
          right={fmtPoints(row.pointsAgainst)}
          hint="race points in paired races"
        />
      </div>
    </article>
  );
}
