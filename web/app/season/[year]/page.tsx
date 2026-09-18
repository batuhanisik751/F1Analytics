// SPEC §4.2 — season page: header, drivers standings, constructors standings, race list, footnote.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ConstructorsTable from "@/components/season/ConstructorsTable";
import MagicNumbersSection from "@/components/season/MagicNumbersSection";
import RaceList from "@/components/season/RaceList";
import StandingsTable from "@/components/season/StandingsTable";
import TitleOddsSection from "@/components/season/TitleOddsSection";
import QualiH2HCard from "@/components/quali/QualiH2HCard";
import SeasonPoleTable from "@/components/quali/SeasonPoleTable";
import { C_QUALI_5, S_QUALI_5 } from "@/components/quali/captions";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import Section from "@/components/ui/Section";
import SeasonSwitcher from "@/components/ui/SeasonSwitcher";
import StatusBadge from "@/components/ui/StatusBadge";
import { getSeasonPoles, getSeasonQualiH2H } from "@/lib/queries/quali";
import { getSeason, getTitleClinch, getTitleOdds } from "@/lib/queries/season";
import { seasonsWithData } from "@/lib/queries/shared";

export const dynamic = "force-dynamic";

function parseYear(raw: string): number | null {
  return /^\d{4}$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: PageProps<"/season/[year]">): Promise<Metadata> {
  const { year } = await params;
  return { title: `${year} season` };
}

export default async function SeasonPage({
  params,
}: PageProps<"/season/[year]">): Promise<React.JSX.Element> {
  const { year: rawYear } = await params;
  const year = parseYear(rawYear);
  if (year === null) notFound();

  const [season, seasons, odds, clinch, poles, qualiH2H] = await Promise.all([
    getSeason(year),
    seasonsWithData(),
    getTitleOdds(year),
    getTitleClinch(year),
    getSeasonPoles(year),
    getSeasonQualiH2H(year),
  ]);
  if (season === null) notFound();

  // MODE1_SPEC §7.4 — the two title sections key off how much of the season has run.
  const completedRounds = season.afterRound ?? 0;
  const remainingRounds = Math.max(0, season.scheduledRounds - completedRounds);

  // afterRound is NULL both before season.recompute ever ran and after a recompute that found no
  // ingested round (e.g. `--season 2026` before the first race); recomputedAt tells them apart.
  const standingsReason =
    season.afterRound !== null
      ? "Nothing is stored for this round — no standings rows for this round."
      : season.recomputedAt === null
        ? "The season totals have never been worked out — season aggregates not yet computed (season.recompute has not run)."
        : "No round of this season has been analysed yet — no round of this season has been ingested yet.";

  const subtitle =
    `${season.ingestedRounds} of ${season.scheduledRounds} rounds analysed · ` +
    (season.afterRound !== null
      ? `standings after round ${season.afterRound}`
      : season.recomputedAt === null
        ? "standings not yet computed"
        : "no standings until a round is ingested");

  // §2.3 — a closed section must say what is inside it, specifically.
  const driverLeader = season.drivers[0];
  const teamLeader = season.constructors[0];
  const roundsWord = season.races.length === 1 ? "round" : "rounds";
  const analysedRounds = season.races.filter((r) => r.ingestStatus === "ok" || r.ingestStatus === "partial").length;

  return (
    <>
      <PageHeader
        title={`${year} season`}
        subtitle={subtitle}
        actions={
          <>
            {season.mixedAssumptionSets ? (
              <StatusBadge
                status="partial"
                label="assumption sets differ between races"
                title="Races in this season were computed under different modelling constants; re-ingest with --force to align them."
              />
            ) : null}
            <SeasonSwitcher seasons={seasons} current={year} />
          </>
        }
      >
        {/* §3.1 — the badge above said this only in a `title=`, which a phone and a keyboard
            never reach, and §2.2 keeps a limit on interpretation in the open. */}
        {season.mixedAssumptionSets ? (
          <p className="border-l-2 border-accent/70 pl-3 text-sm leading-snug text-muted">
            Races in this season were analysed under different modelling constants, so pace numbers
            from different races in {year} are not exactly comparable with each other. The standings
            and results below are unaffected — they are the official published points.
          </p>
        ) : null}
      </PageHeader>

      {/* §2.2 — the standings are the answer a reader came for, so they stay OPEN. They are
          collapsible only so a returning reader can fold them; the state is remembered. */}
      <Section
        title="Drivers standings"
        caption={
          season.afterRound !== null
            ? `After round ${season.afterRound}. Points include sprint results${season.hasSprintResults ? "" : " once ingested"}.`
            : undefined
        }
        collapsible
        storageKey="season:drivers-standings"
        summary={
          driverLeader
            ? `${driverLeader.fullName} leads on ${driverLeader.points} points, from ${season.drivers.length} drivers.`
            : "No drivers standings have been worked out for this season yet."
        }
      >
        <StandingsTable
          rows={season.drivers}
          year={year}
          variant="full"
          showSprintPoints={season.hasSprintResults}
          emptyTitle="No drivers standings"
          emptyReason={standingsReason}
        />
      </Section>

      <Section
        title="Constructors standings"
        caption={season.afterRound !== null ? `After round ${season.afterRound}.` : undefined}
        collapsible
        storageKey="season:constructors-standings"
        summary={
          teamLeader
            ? `${teamLeader.teamName} leads on ${teamLeader.points} points, from ${season.constructors.length} teams.`
            : "No constructors standings have been worked out for this season yet."
        }
      >
        <ConstructorsTable
          rows={season.constructors}
          variant="full"
          emptyTitle="No constructors standings"
          emptyReason={standingsReason}
        />
      </Section>

      {/* MODE2_SPEC §8.5: the was-it-the-car sub-route is reached from this list. */}
      <Section
        title="Was it the car?"
        collapsible
        storageKey="season:was-it-the-car"
        summary={`Separating how quick the ${year} cars were from how quick their drivers were.`}
      >
        <p className="text-sm leading-relaxed text-muted">
          Those standings mix two things that never appear apart: how quick the car was and how
          quick the driver was. The {year} decomposition separates them where the season&rsquo;s
          driver moves make that possible, and says so plainly where they do not.
        </p>
        <Link
          href={`/season/${year}/was-it-the-car`}
          className="mt-3 inline-block text-sm font-semibold text-accent hover:underline"
        >
          Open the {year} driver/car decomposition &rarr;
        </Link>
      </Section>

      <TitleOddsSection
        odds={odds}
        completedRounds={completedRounds}
        remainingRounds={remainingRounds}
      />

      <MagicNumbersSection clinch={clinch} completedRounds={completedRounds} year={year} />

      {/* §2.2 — poles are the answer and stay open; the team-mate records are the evidence
          behind them and start closed, with the warning they carry spelled out in the summary
          so that a reader who never opens the block still reads it (§0). */}
      <Section
        title="Qualifying"
        caption="Pole for every qualifying and sprint-qualifying session of the season, and the teammate record inside each team."
        collapsible
        storageKey="season:qualifying"
        summary={`Who took pole at each of the ${poles.length} qualifying sessions, and the team-mate record inside each team.`}
      >
        <SeasonPoleTable rows={poles} year={year} />
        <div className="mt-6">
          {qualiH2H.length === 0 ? (
            <EmptyState
              title="No season qualifying head-to-head yet"
              reason="The team-mate records for this season have not been built yet — season_quali_h2h has no rows for this year (season.recompute has not built them)."
            />
          ) : (
            <Disclosure
              summary={`Team-mate qualifying record — ${qualiH2H.length} pairing${qualiH2H.length === 1 ? "" : "s"}. Read the band, not the score: a 12–10 record is consistent with either driver being quicker.`}
              storageKey="season:quali-h2h"
            >
              <div className="grid gap-4 lg:grid-cols-2">
                {qualiH2H.map((row) => (
                  <QualiH2HCard key={`${row.kind}-${row.teamId}-${row.driverA}-${row.driverB}`} row={row} />
                ))}
              </div>
            </Disclosure>
          )}
          {/* §0 — C_QUALI_5 is moved behind a control, not shortened, and it renders whether or
              not there are any records, exactly as it did before. S_QUALI_5 is the summary line
              WP-2 wrote for this caption and it carries the warning while closed. */}
          <Disclosure variant="inline" summary={S_QUALI_5} storageKey="season:quali-h2h-caveat">
            <Caption>{C_QUALI_5}</Caption>
          </Disclosure>
        </div>
      </Section>

      <Section
        title="Race list"
        caption="Every scheduled round. Rounds without ingested data are muted; failed ingests are marked data unavailable."
        collapsible
        storageKey="season:race-list"
        summary={`All ${season.races.length} ${roundsWord} of the ${year} season — ${analysedRounds} with timing data analysed. Open a round for its full race analysis.`}
      >
        <RaceList
          rows={season.races}
          emptyTitle="No rounds scheduled"
          emptyReason="No calendar is stored for this season — no events rows for this season."
        />
      </Section>

      {/* §2.2 — a method note starts closed, EXCEPT when it carries a statement about data
          that is missing: "sprint points not yet ingested" is a refusal, so it opens (§0). */}
      <div className="mt-8">
        <Disclosure
          summary="Where these points come from, and what they do not include"
          hint={season.hasSprintResults ? "2 notes" : "3 notes — one is a gap in the data"}
          defaultOpen={!season.hasSprintResults}
          storageKey="season:points-note"
        >
          <p>
            Points sum race and sprint results as published by the timing API; penalties applied later by
            the FIA may not be reflected.
          </p>
          <p className="mt-2">
            A position that changed hours after the flag may therefore still show its on-track order
            here. The race pages say which session each number was taken from.
          </p>
          {!season.hasSprintResults ? (
            <p className="mt-2 text-fg">Sprint points not yet ingested.</p>
          ) : null}
        </Disclosure>
      </div>
    </>
  );
}
