import Link from "next/link";

// Horizontal list of season links; the current one is highlighted.
export type SeasonSwitcherProps = {
  /** Years to offer, in the order to display (queries return newest first). */
  seasons: number[];
  current: number | null;
  /** Link target per year; default `/season/${year}`. */
  hrefFor?: (year: number) => string;
  label?: string;
  className?: string;
};

export default function SeasonSwitcher({
  seasons,
  current,
  hrefFor = (year) => `/season/${year}`,
  label = "Season",
  className,
}: SeasonSwitcherProps): React.JSX.Element {
  if (seasons.length === 0) {
    return <span className={`text-sm text-muted ${className ?? ""}`}>No seasons ingested</span>;
  }
  return (
    <nav aria-label={label} className={`flex items-center gap-1 text-sm ${className ?? ""}`}>
      <span className="mr-1 text-muted">{label}</span>
      {seasons.map((year) => {
        const active = year === current;
        return (
          <Link
            key={year}
            href={hrefFor(year)}
            aria-current={active ? "page" : undefined}
            className={`rounded-full border px-2.5 py-0.5 tnum ${
              active
                ? "border-accent bg-accent/15 text-accent"
                : "border-grid text-fg hover:border-muted hover:text-accent"
            }`}
          >
            {year}
          </Link>
        );
      })}
    </nav>
  );
}
