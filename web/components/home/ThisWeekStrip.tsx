// IDEAS_2026-09 §1 #1 — the "this week" strip: what is on this weekend, and is the title still
// alive. Server-safe. Every sentence comes from lib/home/captions.ts with its slots filled from
// the rows in `ThisWeek`; nothing is worded here. §1 #6: when a round has raced and is not
// loaded, the guard sentence is the FIRST thing in the strip, in the open, never collapsed (§0).
import Link from "next/link";
import Caption from "@/components/ui/Caption";
import {
  AFTER_LABEL,
  C_AFTER_RACE,
  C_FAVOURED,
  C_FAVOURED_LIMIT,
  C_FAVOURED_LIMIT_NO_BACKTEST,
  C_FAVOURED_NONE,
  C_NEXT_EVENT,
  C_NEXT_EVENT_LINK,
  C_NOT_LOADED,
  C_SEASON_OVER,
  C_TITLE_ALIVE,
  C_TITLE_CLINCH,
  C_TITLE_LEADER,
  C_TITLE_NONE,
  C_TITLE_NO_CLINCH,
  C_TITLE_EXPECTED,
  C_TITLE_POINTS,
  FAVOURED_LABEL,
  NEXT_RACE_LABEL,
  TITLE_LABEL,
  fill,
  fmtProb,
} from "@/lib/home/captions";
import { fmtDate } from "@/lib/format";
import type { ThisWeek } from "@/lib/queries/home";

export type ThisWeekStripProps = { year: number; week: ThisWeek };

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="tower-label text-[11px] text-muted">{children}</p>;
}

export default function ThisWeekStrip({ year, week }: ThisWeekStripProps): React.JSX.Element {
  const { stale, next, title, favoured } = week;
  const nextHref = next ? `/race/${next.year}/${next.round}` : null;
  return (
    <div className="rounded-lg border border-grid bg-surface p-5 sm:p-6">
      {stale ? (
        <p
          role="status"
          className="mb-4 border-l-2 border-accent pl-3 text-sm font-medium leading-snug text-fg"
        >
          {fill(C_NOT_LOADED, {
            round: stale.round,
            event: stale.eventName,
            date: fmtDate(stale.eventDate),
          })}
        </p>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0">
          <Label>{NEXT_RACE_LABEL}</Label>
          {next && nextHref ? (
            <>
              <p className="mt-1 text-lg font-semibold leading-snug text-fg">
                {fill(C_NEXT_EVENT, {
                  round: next.round,
                  event: next.eventName,
                  date: fmtDate(next.eventDate),
                })}
              </p>
              <p className="mt-2 text-sm">
                <Link href={nextHref} className="font-medium text-accent hover:underline">
                  {C_NEXT_EVENT_LINK}
                </Link>
              </p>
              <Label>{FAVOURED_LABEL}</Label>
              {favoured && favoured.names.length >= 3 ? (
                <>
                  <p className="mt-1 text-sm text-fg">
                    {fill(C_FAVOURED, {
                      first: favoured.names[0],
                      second: favoured.names[1],
                      third: favoured.names[2],
                    })}
                  </p>
                  <Caption>
                    {favoured.spearman !== null && favoured.gridSpearman !== null
                      ? fill(C_FAVOURED_LIMIT, {
                          spearman: favoured.spearman.toFixed(2),
                          gridSpearman: favoured.gridSpearman.toFixed(2),
                        })
                      : C_FAVOURED_LIMIT_NO_BACKTEST}
                  </Caption>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted">{C_FAVOURED_NONE}</p>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-fg">
              {fill(C_SEASON_OVER, { year, nextYear: year + 1 })}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <Label>{TITLE_LABEL}</Label>
          {title ? (
            <>
              <p className="mt-1 text-sm leading-snug text-fg">
                {fill(C_TITLE_LEADER, {
                  afterRound: title.afterRound,
                  leader: title.leader,
                  p: fmtProb(title.p),
                  pLo: fmtProb(title.pLo),
                  pHi: fmtProb(title.pHi),
                  draws: title.draws,
                })}
              </p>
              {title.second ? (
                <p className="tnum mt-2 text-sm text-muted">
                  {fill(C_TITLE_POINTS, {
                    leaderPoints: title.leaderPoints,
                    margin: title.second.margin,
                    second: title.second.name,
                  })}
                </p>
              ) : null}
              {title.expected ? (
                <p className="tnum mt-2 text-sm text-muted">
                  {fill(C_TITLE_EXPECTED, {
                    expected: Math.round(title.expected.points),
                    expectedLo: Math.round(title.expected.lo),
                    expectedHi: Math.round(title.expected.hi),
                  })}
                </p>
              ) : null}
              <p className="tnum mt-2 text-sm text-muted">
                {fill(C_TITLE_ALIVE, {
                  alive: title.alive,
                  total: title.total,
                  eliminated: title.total - title.alive,
                })}
              </p>
              <p className="mt-2 text-sm text-muted">
                {title.clinchRound !== null && title.clinchEvent !== null
                  ? fill(C_TITLE_CLINCH, {
                      clinchRound: title.clinchRound,
                      clinchEvent: title.clinchEvent,
                    })
                  : C_TITLE_NO_CLINCH}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">{C_TITLE_NONE}</p>
          )}
        </div>
        {next ? (
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <Label>{AFTER_LABEL}</Label>
            <p className="mt-1 text-sm leading-snug text-muted">
              {fill(C_AFTER_RACE, { event: next.eventName })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
