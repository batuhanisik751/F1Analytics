// MODE2_SPEC §5.1 slot 1 — constructor page header: name, colour, seasons covered.
import PageHeader from "@/components/ui/PageHeader";
import SeasonSwitcher from "@/components/ui/SeasonSwitcher";

export type ConstructorHeaderProps = {
  teamId: string;
  name: string;
  colour: string;
  years: number[];
  current: number | null;
  /** Drivers per season, newest first; empty while the fit has not run. */
  lineups?: { year: number; drivers: string[] }[];
};

export default function ConstructorHeader({
  teamId,
  name,
  colour,
  years,
  current,
  lineups = [],
}: ConstructorHeaderProps): React.JSX.Element {
  const span =
    years.length === 0
      ? "no ingested seasons"
      : years.length === 1
        ? `${years[0]}`
        : `${years[0]}–${years[years.length - 1]}`;

  // UX_SPEC §3.3 — a raw column name must never reach the screen. `team_id mclaren` became
  // the thing it actually is: the code this team is filed under in our data.
  const meta = `Filed in our data as \u201c${teamId}\u201d \u00b7 every rating is relative to its own season's field`;

  return (
    <PageHeader
      title={
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-6 w-2 rounded-sm"
            style={{ backgroundColor: colour }}
          />
          {name}
        </span>
      }
      subtitle={`Car pace with driver effects removed · ${span}`}
      meta={meta}
      actions={
        <SeasonSwitcher
          seasons={years}
          current={current}
          hrefFor={(year) => `/constructor/${teamId}?season=${year}`}
        />
      }
    >
      {lineups.length > 0 ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          {lineups.map((l) => (
            <li key={l.year}>
              <span className="tnum text-fg">{l.year}</span>{" "}
              {l.drivers.length > 0 ? l.drivers.join(", ") : "—"}
            </li>
          ))}
        </ul>
      ) : null}
    </PageHeader>
  );
}
