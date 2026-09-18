// MODE2_SPEC §5.1 / §8.5 — /constructor index: season switcher, car-pace bars for that
// season, the development segments, and the links through to each constructor.
import type { Metadata } from "next";
import Link from "next/link";
import CarPaceSection from "@/components/constructor/CarPaceSection";
import DevelopmentSection from "@/components/constructor/DevelopmentSection";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import Section from "@/components/ui/Section";
import SeasonSwitcher from "@/components/ui/SeasonSwitcher";
import {
  getConstructorIndex,
  getAllCarRatings,
  getDevelopment,
  getFitMeta,
  resolveConstructor,
  type CarRatingRow,
} from "@/lib/queries/mode2";
import { seasonsWithData } from "@/lib/queries/shared";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Constructors",
  description:
    "Car pace with driver effects removed, in-season development and retirement rates for every constructor, 2024–2026.",
};

function parseSeason(season: string | string[] | undefined): number | null {
  const s = Array.isArray(season) ? season[0] : season;
  return typeof s === "string" && /^\d{4}$/.test(s) ? Number(s) : null;
}

type Decorated = CarRatingRow & { teamName?: string; colour?: string };

async function decorate(rows: CarRatingRow[], year: number): Promise<Decorated[]> {
  const resolved = await Promise.all(rows.map((r) => resolveConstructor(r.teamId, year)));
  return rows.map((r, i) => ({
    ...r,
    teamName: resolved[i]?.name,
    colour: resolved[i]?.colour,
  }));
}

export default async function ConstructorIndexPage({
  searchParams,
}: PageProps<"/constructor">): Promise<React.JSX.Element> {
  const { season } = await searchParams;
  const seasons = await seasonsWithData();
  const requested = parseSeason(season);
  const year =
    requested !== null && seasons.includes(requested)
      ? requested
      : (seasons[0] ?? new Date().getUTCFullYear());

  const [fit, index, development, everyCarSeason] = await Promise.all([
    getFitMeta(),
    getConstructorIndex(year),
    getDevelopment(year),
    // §5.2's multiplicity line counts the whole fit; one round trip, not one per season.
    getAllCarRatings(),
  ]);

  const [bars, segments] = await Promise.all([
    decorate(index, year),
    decorate(development, year),
  ]);
  const nCarSeasons = everyCarSeason.length;
  const nSignificant = everyCarSeason.filter((r) => r.slopeSignificant).length;
  const ciLevel = fit?.ciLevel ?? 0.9;
  const reason = fit
    ? "partial: no car ratings for this season"
    : "partial: the driver-car model has not been fitted yet";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Constructors"
        subtitle="Car pace with the drivers taken out, season by season"
        meta="Fitted on 2024–2026 race pace only. Every rating is relative to its own season's field."
        actions={
          <SeasonSwitcher
            seasons={seasons}
            current={year}
            hrefFor={(y) => `/constructor?season=${y}`}
          />
        }
      />

      {/* No focus row on the index: see CarPaceSection's `showFocus`. Every bar carries
          its own hatching and its own chip, which is the per-car statement §8.4 wants
          here; a single headline tile would belong to a car this page never names. */}
      <CarPaceSection
        teamName={`the ${year} field`}
        rows={bars}
        season={year}
        ciLevel={ciLevel}
        showFocus={false}
        emptyReason={reason}
      />

      <DevelopmentSection
        rows={segments}
        year={year}
        nSignificant={nSignificant}
        nCarSeasons={nCarSeasons}
        emptyReason={reason}
      />

      <Section
        title={`Every constructor in ${year}`}
        caption="Jump to a team's own page: its car pace season by season, its in-season development, its retirements and its drivers."
        collapsible
        storageKey="constructor-index:teams"
        summary={`${bars.length} team${bars.length === 1 ? "" : "s"} raced in ${year}. Open for the full list.`}
      >
        {bars.length === 0 ? (
          <EmptyState reason={reason} />
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {bars.map((r) => (
              <li key={r.teamId}>
                <Link
                  href={`/constructor/${r.teamId}?season=${year}`}
                  className="flex items-center gap-2 rounded-lg border border-grid bg-surface px-3 py-2 text-sm text-fg hover:border-accent hover:text-accent"
                >
                  <span
                    aria-hidden
                    className="inline-block h-4 w-1.5 rounded-sm"
                    style={{ backgroundColor: r.colour ?? "currentColor" }}
                  />
                  <span className="truncate">{r.teamName ?? r.teamId}</span>
                  {r.basis === "by-analogy" ? (
                    <span className="ml-auto text-xs text-accent">assumed</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Caption>
          Constructors marked &ldquo;assumed&rdquo; have a car level the data cannot
          measure: neither of their drivers changed team inside 2024–2026, so the split
          between car and driver rests on an assumption rather than on evidence.
        </Caption>
      </Section>
    </div>
  );
}
