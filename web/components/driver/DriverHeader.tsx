// SPEC §4.4 (1): full name, number, country, headshot with initials fallback, team chip,
// season switcher over the driver's seasons, and a warning badge when assumption sets differ.
import PageHeader from "@/components/ui/PageHeader";
import SeasonSwitcher from "@/components/ui/SeasonSwitcher";
import StatusBadge from "@/components/ui/StatusBadge";
import TeamDot from "@/components/ui/TeamDot";
import type { DriverProfile } from "@/lib/queries/driver";
import type { TeamRef } from "@/lib/queries/shared";

export type DriverHeaderProps = {
  profile: DriverProfile;
  year: number;
  /** Team of the latest race this season; null when the driver has no race entries in `year`. */
  team: TeamRef | null;
  mixedAssumptionSets: boolean;
  /** Number of race entries this season (meta line). */
  races: number;
};

function initials(fullName: string, code: string): string {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return code.slice(0, 2).toUpperCase();
}

export default function DriverHeader({
  profile,
  year,
  team,
  mixedAssumptionSets,
  races,
}: DriverHeaderProps): React.JSX.Element {
  const ini = initials(profile.fullName, profile.code);
  const ringColour = team?.teamColour ?? "var(--color-grid)";
  // Only an absolute http(s) URL becomes an <img>; anything else (NULL, or a non-URL string an
  // older ingest may have stored) leaves the initials alone instead of requesting /driver/<junk>.
  const headshotUrl =
    profile.headshotUrl && /^https?:\/\//.test(profile.headshotUrl) ? profile.headshotUrl : null;
  return (
    <PageHeader
      title={
        <span className="flex items-center gap-4">
          {/* Initials sit underneath; the <img> (alt="") paints over them when it loads and
              draws nothing when the URL is missing or broken, so the fallback shows through. */}
          <span
            role="img"
            aria-label={`${profile.fullName} headshot`}
            className="relative inline-flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-surface text-xl font-semibold text-muted sm:h-20 sm:w-20"
            style={{ borderColor: ringColour }}
          >
            <span aria-hidden>{ini}</span>
            {headshotUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external F1 media URL from the DB; plain <img> per SPEC §4.4
              <img
                src={headshotUrl}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            ) : null}
          </span>
          <span className="min-w-0">
            <span className="block">{profile.fullName}</span>
            <span className="mt-1 flex flex-wrap items-center gap-2 text-base font-normal text-muted">
              <span className="font-mono text-fg">{profile.code}</span>
              <span className="tnum">#{profile.number}</span>
              {profile.countryCode ? <span>{profile.countryCode}</span> : null}
              {team ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-grid px-2 py-0.5 text-sm text-fg"
                  title={`Team of the latest race in ${year}`}
                >
                  <TeamDot colour={team.teamColour} />
                  {team.teamName}
                </span>
              ) : null}
              {mixedAssumptionSets ? (
                <StatusBadge
                  status="partial"
                  label="assumption sets differ between races"
                  title={`Races in ${year} were computed under different modelling assumption sets`}
                />
              ) : null}
            </span>
          </span>
        </span>
      }
      meta={`${year} season · ${races} race ${races === 1 ? "entry" : "entries"}`}
      actions={
        <SeasonSwitcher
          seasons={profile.seasons}
          current={year}
          hrefFor={(y) => `/driver/${profile.code}?season=${y}`}
        />
      }
    />
  );
}
