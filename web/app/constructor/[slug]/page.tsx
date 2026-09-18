// MODE2_SPEC §5.1 — /constructor/[slug]?season=YYYY. Five slots: header, car pace,
// in-season development, retirements, who drove it. Async Server Component, empty-safe.
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import CarPaceSection from "@/components/constructor/CarPaceSection";
import ConstructorHeader from "@/components/constructor/ConstructorHeader";
import DevelopmentSection from "@/components/constructor/DevelopmentSection";
import HazardSection from "@/components/constructor/HazardSection";
import WhoDroveIt, { type WhoDroveItRow } from "@/components/constructor/WhoDroveIt";
import { prettyDriver } from "@/components/constructor/names";
import {
  getAllCarRatings,
  getCarRatings,
  getDevelopment,
  getFitMeta,
  getHazards,
  getSeasonDecomposition,
  resolveConstructor,
} from "@/lib/queries/mode2";

export const dynamic = "force-dynamic";

function parseSeason(season: string | string[] | undefined): number | null {
  const s = Array.isArray(season) ? season[0] : season;
  return typeof s === "string" && /^\d{4}$/.test(s) ? Number(s) : null;
}

function canonical(slug: string): string {
  return slug.trim().toLowerCase().replace(/-/g, "_");
}

export async function generateMetadata({
  params,
}: PageProps<"/constructor/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const team = await resolveConstructor(slug);
  if (!team) return { title: slug };
  return {
    title: `${team.name} — car pace`,
    description: `${team.name}'s car pace with driver effects removed, in-season development and retirement rate, 2024–2026.`,
  };
}

export default async function ConstructorPage({
  params,
  searchParams,
}: PageProps<"/constructor/[slug]">): Promise<React.JSX.Element> {
  const { slug } = await params;
  const { season } = await searchParams;

  if (slug !== canonical(slug)) {
    const s = Array.isArray(season) ? season[0] : season;
    const q = typeof s === "string" && s !== "" ? `?season=${encodeURIComponent(s)}` : "";
    redirect(`/constructor/${canonical(slug)}${q}`);
  }

  const requested = parseSeason(season);
  const team = await resolveConstructor(slug, requested ?? undefined);
  if (!team) notFound();

  const year =
    requested !== null && team.years.includes(requested)
      ? requested
      : (team.years[team.years.length - 1] ?? null);

  const [fit, cars, hazards, decompositions, allDevelopment, everyCarSeason] = await Promise.all([
    getFitMeta(),
    getCarRatings(team.teamId),
    getHazards(team.teamId),
    Promise.all(team.years.map((y) => getSeasonDecomposition(y))),
    Promise.all(team.years.map((y) => getDevelopment(y))),
    // §5.2's multiplicity line counts the WHOLE fit, not this team's own seasons.
    getAllCarRatings(),
  ]);

  // Drivers of this constructor, season by season, from the fitted decomposition.
  const seats = team.years.flatMap((y, i) =>
    decompositions[i]
      .filter((d) => d.car.teamId === team.teamId)
      .map((d) => ({ year: y, rating: d.rating })),
  );
  const lineups = team.years.map((y) => ({
    year: y,
    drivers: seats.filter((s) => s.year === y).map((s) => prettyDriver(s.rating.driverId)),
  }));
  const whoDroveIt: WhoDroveItRow[] = seats.map((s) => ({
    driverId: s.rating.driverId,
    label: prettyDriver(s.rating.driverId),
    year: s.year,
    ratingPp: s.rating.ratingPp,
    ratingLo: s.rating.ratingLo,
    ratingHi: s.rating.ratingHi,
    anchorClass: s.rating.anchorClass,
    basis: s.rating.basis,
    componentLabel: s.rating.componentLabel,
  }));

  // One team across its seasons, so the bar label is the SEASON: labelling all three
  // rows "Ferrari" leaves the reader unable to tell 2024 from 2026, and §5.2 forbids
  // reading these bars across seasons in the first place — the year is the whole point.
  const rows = cars.map((c) => ({
    ...c,
    teamName: `${team.name} ${c.year}`,
    colour: team.colour,
  }));

  // §5.2 — development is read on a shared axis with the highlighted season's other
  // cars, so this section shows the whole field for that year, not this team alone.
  const focusYear = year ?? (team.years[team.years.length - 1] ?? 0);
  const focusDevelopment = allDevelopment[team.years.indexOf(focusYear)] ?? [];
  const devTeams = Array.from(new Set(focusDevelopment.map((r) => r.teamId)));
  const devResolved = await Promise.all(
    devTeams.map((t) => resolveConstructor(t, focusYear)),
  );
  const developmentRows = focusDevelopment.map((r) => {
    const info = devResolved[devTeams.indexOf(r.teamId)];
    return { ...r, teamName: info?.name ?? r.teamId, colour: info?.colour };
  });
  const hazardRows = hazards.map((h) => ({ ...h, teamName: team.name, colour: team.colour }));
  const islandDrivers = Array.from(
    new Set(
      seats
        .filter((s) => s.rating.anchorClass === "floating")
        .map((s) => prettyDriver(s.rating.driverId)),
    ),
  );
  const ciLevel = fit?.ciLevel ?? 0.9;
  const reason = fit
    ? "partial: no car rating for this constructor"
    : "partial: the driver-car model has not been fitted yet";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <ConstructorHeader
        teamId={team.teamId}
        name={team.name}
        colour={team.colour}
        years={team.years}
        current={year}
        lineups={lineups}
      />

      <CarPaceSection
        teamName={team.name}
        rows={rows}
        season={year}
        ciLevel={ciLevel}
        islandDrivers={islandDrivers}
        emptyReason={reason}
      />

      <DevelopmentSection
        rows={developmentRows}
        year={focusYear}
        nSignificant={everyCarSeason.filter((r) => r.slopeSignificant).length}
        nCarSeasons={everyCarSeason.length}
        emptyReason={reason}
      />

      <HazardSection
        rows={hazardRows}
        year={focusYear}
        emptyReason={reason}
      />

      <WhoDroveIt rows={whoDroveIt} ciLevel={ciLevel} emptyReason={reason} />
    </div>
  );
}
