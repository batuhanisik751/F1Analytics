// MODE2_SPEC §8.6 — /season/[year]/was-it-the-car. Order is deliberate: the lede, the
// decomposition with its island warnings, the spread tiles, then the counterfactual toy.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prettyDriver, prettyTeam } from "@/components/constructor/names";
import type { DecompositionRow } from "@/components/charts/DecompositionBar";
import CounterfactualSection from "@/components/witc/CounterfactualSection";
import DecompositionSection, { type IslandTeam } from "@/components/witc/DecompositionSection";
import RatioTiles from "@/components/witc/RatioTiles";
import WitcLede from "@/components/witc/WitcLede";
import PageHeader from "@/components/ui/PageHeader";
import {
  getCounterfactuals,
  getFitMeta,
  getSeasonDecomposition,
  resolveConstructor,
  type CounterfactualRow,
} from "@/lib/queries/mode2";
import { seasonsWithData } from "@/lib/queries/shared";

export const dynamic = "force-dynamic";

/** 90 % normal quantile — turns one stored interval back into its own SE for drawing. */
const Z90 = 1.6448536269514722;

function parseYear(raw: string): number | null {
  return /^\d{4}$/.test(raw) ? Number(raw) : null;
}

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s !== "" ? s : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/season/[year]/was-it-the-car">): Promise<Metadata> {
  const { year } = await params;
  return {
    title: `Was it the car? ${year}`,
    description: `How much of each ${year} driver's pace was the car and how much was the driver — with the four groups the model cannot compare across.`,
  };
}

export default async function WasItTheCarPage({
  params,
  searchParams,
}: PageProps<"/season/[year]/was-it-the-car">): Promise<React.JSX.Element> {
  const { year: rawYear } = await params;
  const year = parseYear(rawYear);
  if (year === null) notFound();
  // Match the parent /season/[year], which 404s a season we hold no data for. Without
  // this the sub-route answered 200 for, say, 2023 and rendered the fit-wide spread
  // tiles — 2024-2026 numbers — under a 2023 heading. §0.3 forbids exactly that reading.
  const seasons = await seasonsWithData();
  if (!seasons.includes(year)) notFound();
  const sp = await searchParams;
  const selectedDriver = one(sp.driver);
  const selectedTeam = one(sp.car);

  const [fit, decomposition] = await Promise.all([getFitMeta(), getSeasonDecomposition(year)]);

  const teamIds = Array.from(new Set(decomposition.map((d) => d.car.teamId)));
  const resolved = await Promise.all(teamIds.map((t) => resolveConstructor(t, year)));
  const teamName = (teamId: string): string =>
    resolved[teamIds.indexOf(teamId)]?.name ?? prettyTeam(teamId);
  const teamColour = (teamId: string): string | undefined =>
    resolved[teamIds.indexOf(teamId)]?.colour;

  const rows: DecompositionRow[] = decomposition.map((d) => ({
    driverId: d.rating.driverId,
    label: prettyDriver(d.rating.driverId),
    carPp: d.car.gammaPp,
    driverPp: d.rating.ratingPp,
    carSe: Math.max(0, (d.car.gammaHi - d.car.gammaLo) / (2 * Z90)),
    driverSe: d.rating.sdTotal,
    basis: d.rating.basis === "by-analogy" || d.car.basis === "by-analogy" ? "by-analogy" : "measured",
    componentId: d.rating.componentId,
    componentLabel: d.rating.componentLabel,
    carColour: teamColour(d.car.teamId),
  }));

  // Islands: the teams whose car level rests on the pooling prior, in this season.
  const islands: IslandTeam[] = teamIds
    .filter((t) =>
      decomposition.some(
        (d) =>
          d.car.teamId === t &&
          (d.car.basis === "by-analogy" || d.rating.anchorClass === "floating"),
      ),
    )
    .map((t) => {
      const drivers = decomposition
        .filter((d) => d.car.teamId === t)
        .map((d) => prettyDriver(d.rating.driverId));
      return {
        teamId: t,
        teamName: teamName(t),
        drivers,
        measuredInstead:
          drivers.length === 2
            ? `the gap between ${drivers[0]} and ${drivers[1]}, which the model states precisely — and nothing about where either of them sits against the rest of the grid.`
            : "only the gaps between this team's own drivers.",
      };
    });

  // The counterfactual row, if a pairing is selected. Both sides come from the DB.
  let cfRow: CounterfactualRow | null = null;
  if (selectedDriver !== null && selectedTeam !== null) {
    const scenarios = await getCounterfactuals(year, selectedDriver);
    cfRow = scenarios.find((s) => s.teamId === selectedTeam) ?? null;
  }

  const driverOptions = decomposition.map((d) => ({
    id: d.rating.driverId,
    label: prettyDriver(d.rating.driverId),
  }));
  const teamOptions = teamIds.map((t) => ({ id: t, label: teamName(t) }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title={`Was it the car? ${year}`}
        subtitle="Splitting a lap into the car and the driver — and saying where that split cannot be made"
        meta={
          <>
            Fitted on 2024–2026 race pace only ·{" "}
            <Link href={`/season/${year}`} className="text-fg hover:text-accent">
              back to the {year} season
            </Link>
          </>
        }
      >
        <WitcLede />
      </PageHeader>

      <DecompositionSection year={year} rows={rows} islands={islands} />

      <RatioTiles fit={fit} />

      <CounterfactualSection
        year={year}
        drivers={driverOptions}
        teams={teamOptions}
        selectedDriver={selectedDriver}
        selectedTeam={selectedTeam}
        driverName={selectedDriver ? prettyDriver(selectedDriver) : ""}
        teamName={selectedTeam ? teamName(selectedTeam) : ""}
        incumbentName={cfRow ? prettyDriver(cfRow.replacedDriverId) : ""}
        row={cfRow}
      />
    </div>
  );
}
