// SPEC §4.4 — /driver/[code]?season=YYYY (WP5).
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import DriverSeasonChart from "@/components/charts/DriverSeasonChart";
import CareerAdjusted from "@/components/driver/CareerAdjusted";
import CareerH2HTable from "@/components/driver/CareerH2HTable";
import DriverHeader from "@/components/driver/DriverHeader";
import DriverResultsTable from "@/components/driver/DriverResultsTable";
import H2HCard from "@/components/driver/H2HCard";
import DriverQualiRecord from "@/components/quali/DriverQualiRecord";
import QualiH2HCard from "@/components/quali/QualiH2HCard";
import { C_QUALI_5, S_QUALI_5 } from "@/components/quali/captions";
import RatingHistorySlot from "@/components/driver/RatingHistorySlot";
import RatingSlot from "@/components/driver/RatingSlot";
import SkillPanel, { skillSectionCaption, skillSectionSummary } from "@/components/driver/SkillPanel";
import SummaryTiles from "@/components/driver/SummaryTiles";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import Section from "@/components/ui/Section";
import { getDriverSeason, resolveDriver } from "@/lib/queries/driver";
import { getDriverQualiSeasons, getSeasonQualiH2H } from "@/lib/queries/quali";
import {
  getCareerAdjusted,
  getComponentPeers,
  getDriverRating,
  getDriverSkills,
  getFitMeta,
  getRatingHistory,
  getTeammateContrasts,
} from "@/lib/queries/mode2";
import { TEAM_FALLBACK } from "@/lib/theme";

export const dynamic = "force-dynamic";

function parseSeason(season: string | string[] | undefined): number | null {
  const s = Array.isArray(season) ? season[0] : season;
  return typeof s === "string" && /^\d{4}$/.test(s) ? Number(s) : null;
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/driver/[code]">): Promise<Metadata> {
  const { code } = await params;
  const { season } = await searchParams;
  const year = parseSeason(season);
  const resolved = await resolveDriver(code, year);
  if (!resolved) return { title: code.toUpperCase() };
  const data = await getDriverSeason(resolved.driverId, resolved.year);
  if (!data) return { title: code.toUpperCase() };
  return {
    title: `${data.profile.fullName} ${data.year}`,
    description: `${data.profile.fullName}'s ${data.year} season: fuel-corrected pace rank per round, teammate gaps and results.`,
  };
}

export default async function DriverPage({
  params,
  searchParams,
}: PageProps<"/driver/[code]">): Promise<React.JSX.Element> {
  const { code } = await params;
  const { season } = await searchParams;

  // Lower-case codes redirect to upper-case (SPEC §4.4).
  if (code !== code.toUpperCase()) {
    const s = Array.isArray(season) ? season[0] : season;
    const q = typeof s === "string" && s !== "" ? `?season=${encodeURIComponent(s)}` : "";
    redirect(`/driver/${code.toUpperCase()}${q}`);
  }

  const year = parseSeason(season);
  const resolved = await resolveDriver(code, year);
  if (!resolved) notFound();
  const data = await getDriverSeason(resolved.driverId, resolved.year);
  if (!data) notFound();

  // MODE2_SPEC §8.5 — the five v1.3 slots. Every query returns null/[] until the model
  // has been fitted, and every slot renders its own EmptyState for that (FD6).
  const [fit, rating, peers, history, skills, career, contrasts, qualiSeasons, seasonQualiH2H] =
    await Promise.all([
    getFitMeta(),
    getDriverRating(resolved.driverId),
    getComponentPeers(resolved.driverId),
    getRatingHistory(resolved.driverId),
    getDriverSkills(resolved.driverId),
    getCareerAdjusted(resolved.driverId),
    getTeammateContrasts(resolved.driverId),
    // QUALI_SPEC §6.5 — the qualifying record is per season and kind, never pooled.
    getDriverQualiSeasons(resolved.driverId),
    getSeasonQualiH2H(resolved.year),
  ]);

  const { profile, races, summary, h2h } = data;
  // §6.5's season teammate card, restricted to the pairs this driver is in. Both
  // directions are stored on the pair, so the row is the same object on both pages.
  const myQualiH2H = seasonQualiH2H.filter(
    (r) => r.driverA === resolved.driverId || r.driverB === resolved.driverId,
  );
  const latestRace = races.length > 0 ? races[races.length - 1] : null;
  const team = summary?.team ?? latestRace?.team ?? null;
  const teamColour = team?.teamColour ?? TEAM_FALLBACK;
  const rankedRounds = races.filter((r) => r.paceRank !== null).length;
  const pairedRounds = races.filter((r) => r.signedGapPct !== null).length;

  return (
    <>
      <DriverHeader
        profile={profile}
        year={data.year}
        team={team}
        mixedAssumptionSets={data.mixedAssumptionSets}
        races={races.length}
      />

      <Section
        title="Season summary"
        caption="Race and sprint points as published by the timing API."
        collapsible
        storageKey="driver:summary"
        summary={`Points, wins, podiums and average finish across ${races.length} ${
          races.length === 1 ? "race entry" : "race entries"
        } in ${data.year}.`}
      >
        <SummaryTiles summary={summary} year={data.year} />
      </Section>

      <Section
        title="Driver rating, car removed"
        caption="Fitted on 2024-2026 fuel-corrected race pace only. Not an all-time ranking."
        collapsible
        storageKey="driver:rating"
        summary="One number: how much faster or slower than an average 2024-2026 driver, once the car is taken out — with its range and how it moved season by season."
      >
        <RatingSlot
          rating={rating}
          fit={fit}
          peers={peers}
          driverLabel={profile.code}
          teamColour={teamColour}
        />
        <div className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-fg">Rating over time</h3>
          <RatingHistorySlot
            points={history}
            ciLevel={fit?.ciLevel ?? 0.9}
            teamColour={teamColour}
          />
        </div>
      </Section>

      {/* §1.3.1 — this caption used to be a hardcoded "Four … Two … two" while the panel
          below rendered "seven … three … four". Both now come from `skillSectionCaption`
          over the same rows, so they cannot disagree again.
          §0 — deliberately COLLAPSIBLE BUT NOT REMEMBERED: the four refusals live in here,
          and a refusal must be open on every visit, not left closed by a click made weeks
          ago. No `storageKey`, so every load starts open. */}
      <Section
        title="What we can and cannot measure"
        caption={skillSectionCaption(skills)}
        collapsible
        summary={skillSectionSummary(skills)}
      >
        <SkillPanel skills={skills} fit={fit} />
      </Section>

      <Section
        title="Car-adjusted career"
        caption="Points actually scored against what a field-average driver would have scored in the same machinery."
        collapsible
        storageKey="driver:career"
        summary={`Season-by-season replay of ${career.length === 0 ? "this career" : `${career.length} ${career.length === 1 ? "season" : "seasons"}`} against an average driver in the same car, plus every career team-mate gap.`}
      >
        <CareerAdjusted rows={career} />
        <div className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-fg">Team-mates, career</h3>
          <CareerH2HTable rows={contrasts} />
        </div>
      </Section>

      <Section
        title="Pace rank and teammate gap by round"
        caption="Top: fuel-corrected race pace rank (1 = fastest). Bottom: signed pace gap to the teammate, positive = this driver faster."
        collapsible
        storageKey="driver:pace-rank"
        summary={`Round-by-round pace rank and team-mate gap: ${rankedRounds} ranked ${
          rankedRounds === 1 ? "race" : "races"
        }, ${pairedRounds} with a team-mate to compare against.`}
      >
        {races.length === 0 ? (
          <EmptyState
            title={`No race entries in ${data.year}`}
            reason="no session_entries rows for this driver in this season"
          />
        ) : rankedRounds === 0 && pairedRounds === 0 ? (
          <EmptyState
            title="No pace data yet"
            reason="pace_ranking and teammate_deltas are empty for every ingested round of this driver"
          />
        ) : (
          <>
            <DriverSeasonChart races={races} teamColour={teamColour} code={profile.code} />
            {/* §2.1 / §0 — the long caption moves behind an inline control, in full. The
                summary is NEW text and carries the warning itself, so the limit on
                interpretation is on screen whether or not the reader opens it. */}
            <Disclosure
              variant="inline"
              summary="A single race's rank and gap are noisy signals — how both are built, and what makes a marker hollow"
              storageKey="driver:pace-rank-note"
            >
              Pace rank is the driver&apos;s position in the fuel-corrected median-pace ranking of each
              race (drivers with fewer than 8 clean laps are unranked). Hollow markers: the rank moves
              across the plausible fuel-effect range. Bars are missing where no teammate pair could be
              compared. Rank and gap are single-race, single-car signals — noisy and confounded by
              strategy, traffic and damage.
            </Disclosure>
          </>
        )}
      </Section>

      <Section
        title="Qualifying record"
        caption="Official qualifying and sprint-qualifying results, per season. Gaps to pole are same-segment and in percent, because a tenth is worth more at one circuit than another."
        collapsible
        storageKey="driver:quali-record"
        summary={`Qualifying and sprint qualifying across ${qualiSeasons.length} ${
          qualiSeasons.length === 1 ? "season" : "seasons"
        }${myQualiH2H.length > 0 ? `, plus ${myQualiH2H.length} team-mate ${myQualiH2H.length === 1 ? "record" : "records"} for ${data.year}` : ""}.`}
      >
        <DriverQualiRecord rows={qualiSeasons} />
        {myQualiH2H.length > 0 ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {myQualiH2H.map((row) => (
              <QualiH2HCard key={`${row.kind}-${row.teamId}-${row.driverA}-${row.driverB}`} row={row} />
            ))}
          </div>
        ) : null}
        {/* WP-2 wrote S_QUALI_5 for exactly this call site: the warning is in the summary
            line, C-QUALI-5 is unchanged inside it. */}
        <Disclosure variant="inline" summary={S_QUALI_5} storageKey="driver:quali-h2h-note">
          {C_QUALI_5}
        </Disclosure>
      </Section>

      <Section
        title="Race by race"
        caption="Points shown as race points (+ sprint points). Gap vs teammate: positive = this driver faster."
        collapsible
        storageKey="driver:race-by-race"
        summary={`Every ${data.year} round in a table: finish, grid, points and the gap to the team-mate — ${races.length} ${races.length === 1 ? "entry" : "entries"}.`}
      >
        <DriverResultsTable races={races} year={data.year} latestTeamId={team?.teamId ?? null} />
      </Section>

      <Section
        title="Teammate head-to-head"
        caption="One card per teammate this season; both directions are stored, so the teammate's page shows the mirror."
        collapsible
        storageKey="driver:teammate-h2h"
        summary={`${h2h.length === 0 ? "No" : h2h.length} ${h2h.length === 1 ? "team-mate" : "team-mates"} in ${data.year}, counted race by race: pace, finishes, grid and points.`}
      >
        {h2h.length === 0 ? (
          <EmptyState
            title={`No teammate comparison for ${data.year}`}
            reason="teammate_h2h has no rows for this driver in this season"
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {h2h.map((row) => (
              <H2HCard key={row.teammate.driverId} row={row} code={profile.code} year={data.year} />
            ))}
          </div>
        )}
        <Caption>
          Single-season, single-car comparison; confounded by strategy, traffic and damage. The
          pooled hierarchical model is the real answer.
        </Caption>
      </Section>
    </>
  );
}
