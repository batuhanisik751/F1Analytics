import Link from "next/link";
import { getLatestRace, seasonsWithData } from "@/lib/queries/shared";

// Site navigation: Home · Seasons · Latest race. Async server component; tolerates an
// empty database (no seasons, no ingested race) and a database that is unreachable
// (the shell still renders, without the data-driven links).
export default async function Nav(): Promise<React.JSX.Element> {
  let seasons: number[] = [];
  let latest: Awaited<ReturnType<typeof getLatestRace>> = null;
  try {
    [seasons, latest] = await Promise.all([seasonsWithData(), getLatestRace()]);
  } catch (err) {
    console.error("Nav: database unavailable", err instanceof Error ? err.message : err);
  }

  return (
    <header className="sticky top-0 z-30 border-b-2 border-accent/70 bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 text-fg">
          {/* Three stacked flashes: the speed-line motif of a race graphic. */}
          <span aria-hidden className="flex items-center gap-[3px]">
            <span className="tower-flash h-4 w-[3px] bg-accent" />
            <span className="tower-flash h-4 w-[3px] bg-accent/60" />
            <span className="tower-flash h-4 w-[3px] bg-accent/30" />
          </span>
          <span className="tower-label text-base">F1 Analytics</span>
        </Link>
        <nav aria-label="Primary" className="tower-label flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <Link href="/" className="text-fg hover:text-accent">
            Home
          </Link>
          <Link href="/constructor" className="text-fg hover:text-accent">
            Constructors
          </Link>
          {/* MODE3_SPEC §0.1 — /ask is the one generated surface; every other entry here is a
              precomputed page. The label stays plain: the distinction is made on the page
              itself (§8.6), not by decorating the link into it. */}
          <Link href="/ask" className="text-fg hover:text-accent">
            Ask
          </Link>
          {/* UX_SPEC §3.2 — the glossary is reachable from every page, not only from a tooltip:
              a reader who met "pp" yesterday should not have to find that tooltip again. */}
          <Link href="/glossary" className="text-fg hover:text-accent">
            Glossary
          </Link>
          <span className="flex items-center gap-2">
            <span className="text-muted">Seasons</span>
            {seasons.length === 0 ? (
              <span className="text-muted/70">—</span>
            ) : (
              seasons.map((year) => (
                <Link key={year} href={`/season/${year}`} className="tnum text-fg hover:text-accent">
                  {year}
                </Link>
              ))
            )}
          </span>
          {latest ? (
            <Link
              href={`/race/${latest.year}/${latest.round}`}
              className="text-fg hover:text-accent"
              title={`${latest.eventName} ${latest.year}`}
            >
              Latest race: <span className="text-accent">{latest.eventName}</span>
            </Link>
          ) : (
            <span className="text-muted">Latest race: none ingested</span>
          )}
        </nav>
      </div>
    </header>
  );
}
