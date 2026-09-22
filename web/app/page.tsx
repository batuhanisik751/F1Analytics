// SPEC §4.1 — home: latest race hero, standings snapshot, completed races, season switcher.
//
// UX_SPEC §2.2 / WP-5 — this is a new reader's first page, so it opens with what the site
// measures and where the glossary is, then the answer (latest race, standings). The only thing
// that starts closed is the full list of completed races: a navigation aid, not an answer.
// §0 COLLAPSE, NEVER DELETE — every caption below is unchanged; nothing was shortened.
import type { Metadata } from "next";
import LatestRaceHero from "@/components/home/LatestRaceHero";
import StandingsSnapshot from "@/components/home/StandingsSnapshot";
import ThisWeekStrip from "@/components/home/ThisWeekStrip";
import WhatThisShows from "@/components/home/WhatThisShows";
import RaceList from "@/components/season/RaceList";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import Section from "@/components/ui/Section";
import SeasonSwitcher from "@/components/ui/SeasonSwitcher";
import { STRIP_CAPTION, STRIP_TITLE } from "@/lib/home/captions";
import { getHome } from "@/lib/queries/home";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: "F1 Analytics" } };
}

export default async function HomePage(): Promise<React.JSX.Element> {
  const home = await getHome();

  if (home === null) {
    return (
      <>
        <PageHeader
          title="F1 Analytics"
          subtitle="Fuel-corrected race pace, tyre degradation and teammate gaps — with the assumptions stated."
          actions={<SeasonSwitcher seasons={[]} current={null} />}
        />
        <Section title="No race data yet" caption="The database has no ingested season.">
          <EmptyState
            title="Ingest a season to get started"
            reason="No season has been loaded, so there is nothing to analyse yet."
          >
            <p>
              Run{" "}
              <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-fg">
                python -m f1lab.ingest --season 2026
              </code>{" "}
              at the project root, then reload this page.
            </p>
            <p className="mt-2">
              The full runbook (Docker, migrations, ingest) is in{" "}
              <code className="font-mono text-fg">README.md</code> at the project root and{" "}
              <code className="font-mono text-fg">web/README.md</code>.
            </p>
            <p className="mt-2 font-mono text-xs text-muted">
              Technical reason: seasons.ingested_rounds = 0 everywhere
            </p>
          </EmptyState>
        </Section>
      </>
    );
  }

  const { year, seasons, latest, completed, afterRound, drivers, constructors, thisWeek } = home;
  const raceWord = completed.length === 1 ? "race" : "races";

  return (
    <>
      <PageHeader
        title="F1 Analytics"
        subtitle="Fuel-corrected race pace, tyre degradation and teammate gaps — with the assumptions stated."
        meta={`${year} season · ${completed.length} ${raceWord} analysed`}
        actions={<SeasonSwitcher seasons={seasons} current={year} />}
      />

      {/* IDEAS_2026-09 §1 #1 — the strip sits above "Start here": a returning fan's first
          question is what is on this weekend, and §1 #6's guard line must be the first thing on
          the page the night the nightly job fails. Never collapsible (§0). */}
      <Section title={STRIP_TITLE} caption={STRIP_CAPTION}>
        <ThisWeekStrip year={year} week={thisWeek} />
      </Section>

      <Section
        title="Start here"
        caption="What this site measures, in the words it uses everywhere else."
        collapsible
        storageKey="home:orientation"
        summary="What this site measures, and where every term is defined."
      >
        <WhatThisShows />
      </Section>

      <Section title="Latest race" caption="The most recent race with ingested timing data.">
        {latest ? (
          <LatestRaceHero latest={latest} />
        ) : (
          <EmptyState
            title="No completed race"
            reason="No race in this season has usable timing data yet — no race session with status ok or partial."
          />
        )}
      </Section>

      <Section
        title="Standings snapshot"
        caption={
          afterRound !== null
            ? `Championship standings after round ${afterRound} of the ${year} season.`
            : `Standings for ${year} have not been computed yet.`
        }
      >
        <StandingsSnapshot
          year={year}
          afterRound={afterRound}
          drivers={drivers}
          constructors={constructors}
        />
      </Section>

      <Section
        title="Completed races"
        caption="Newest first. Winner is the official P1; fastest pace is the site's fuel-corrected median ranking."
        collapsible
        defaultOpen={false}
        storageKey="home:completed-races"
        summary={`${completed.length} ${raceWord} analysed so far — winner and fastest race pace for each.`}
      >
        <RaceList
          rows={completed}
          emptyTitle="No completed races"
          emptyReason="No race in this season has usable timing data yet — no race session with status ok or partial."
        />
      </Section>
    </>
  );
}
