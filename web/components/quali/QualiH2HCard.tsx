// QUALI_SPEC §6.5 — the season teammate card, rendered as
// "NOR 13 — 9 PIA · median NOR 0.11% faster (±0.09% MAD, 22 sessions)" with the Wilson
// band beneath. The band is what the caption (C-QUALI-5) tells the reader to read: it
// shows how uncertain the RECORD is, not how close the drivers were.
//
// Greyed below five sessions (§6.5) and never shown as a rank.
import { fmtPct } from "@/lib/format";
import TeamDot from "@/components/ui/TeamDot";
import TermTip from "@/components/ui/TermTip";
import { ppSecondsHint } from "@/components/ui/metricFormat";
import { SEASON_H2H_MIN_SESSIONS, type SeasonQualiH2HRow } from "@/lib/queries/quali";

export default function QualiH2HCard({ row }: { row: SeasonQualiH2HRow }): React.JSX.Element {
  const thin = row.sessionsCounted < SEASON_H2H_MIN_SESSIONS;
  const lo = Math.max(0, Math.min(1, row.wilsonLow));
  const hi = Math.max(0, Math.min(1, row.wilsonHigh));
  const share = row.sessionsCounted > 0 ? row.aWins / row.sessionsCounted : 0;
  // medianDeltaS is signed with negative = driverA faster (§6.1); the percent carries
  // the same sign, so the sentence names the faster driver rather than printing a sign.
  const pct = row.medianDeltaPct;
  const fasterCode = pct === null ? null : pct <= 0 ? row.codeA : row.codeB;

  return (
    <div className={`border border-grid bg-surface/30 p-3 ${thin ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 text-xs text-muted">
        {/* §4.3 — the dot is the team colour and the name is beside it, always. */}
        <TeamDot colour={row.colour} size={10} />
        <span>{row.teamName}</span>
        <span className="tower-label">{row.kind === "SQ" ? "Sprint qualifying" : "Qualifying"}</span>
      </div>
      <p className="mt-1.5 tnum text-sm">
        <span className="font-mono font-semibold">{row.codeA}</span>{" "}
        <span className="font-semibold">{row.aWins}</span>
        <span className="mx-1.5 text-muted">&mdash;</span>
        <span className="font-semibold">{row.bWins}</span>{" "}
        <span className="font-mono font-semibold">{row.codeB}</span>
        {pct === null ? null : (
          <span className="text-muted">
            {" · "}in a typical session {fasterCode} is {fmtPct(Math.abs(pct))}{" "}
            <TermTip term="pp">of a lap</TermTip> quicker
          </span>
        )}
      </p>
      {/* §3.3 — a share of a lap never appears without its seconds equivalent and a stated
          reference lap, and the spread is named in words before its abbreviation. */}
      {pct === null ? null : (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          {ppSecondsHint(Math.abs(pct))}. Session to session that gap swings by about{" "}
          {fmtPct(row.madDeltaPct)} of a lap either way (the median absolute deviation, MAD), over{" "}
          {row.deltasCounted} session{row.deltasCounted === 1 ? "" : "s"} where both drivers set a
          time in the same segment.
        </p>
      )}
      <div className="mt-2">
        <div
          className="relative h-2 w-full bg-raised"
          role="img"
          aria-label={`${row.codeA} has won ${(share * 100).toFixed(0)} % of these sessions; the plausible range is ${(lo * 100).toFixed(0)} % to ${(hi * 100).toFixed(0)} %. The tick in the middle marks an even split.`}
        >
          <span
            className="absolute inset-y-0 opacity-40"
            style={{ left: `${lo * 100}%`, width: `${Math.max(1, (hi - lo) * 100)}%`, background: row.colour }}
          />
          <span
            className="absolute inset-y-[-2px] w-0.5 bg-fg"
            style={{ left: `calc(${share * 100}% - 1px)` }}
          />
          <span aria-hidden className="absolute inset-y-[-3px] left-1/2 w-px bg-grid" />
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {thin
            ? `${row.sessionsCounted} session${row.sessionsCounted === 1 ? "" : "s"} — too few to read as a record.`
            : `On this many sessions, ${row.codeA}'s true share of wins could be anywhere from ${(lo * 100).toFixed(0)}% to ${(hi * 100).toFixed(0)}% (a Wilson 95% band). The bar shows that range; the white tick is the score so far.`}
          {row.sessionsCaveated > 0
            ? ` ${row.sessionsCaveated} session${row.sessionsCaveated === 1 ? "" : "s"} had conditions change between segments.`
            : ""}
        </p>
      </div>
    </div>
  );
}
