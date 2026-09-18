// UX_SPEC §2.2 / §1.1 — the ONE shared island explanation on /season/[year]/was-it-the-car.
//
// Before this release the same ~90-word explanation was printed once per floating team and
// then restated a third time as caption C-WITC-2 under the chart. This component is the single
// copy of the shared part. It is OPEN and always rendered, never collapsed: it is a limit on
// interpretation a reader would otherwise act wrongly on (§2.2), and it carries the two things
// §0 says must stay at least as prominent as they were — the four floating drivers by name, and
// the admission that their car level is borrowed from the rest of the grid.
//
// The body paragraph is caption C-WITC-2 VERBATIM, moved here from a muted <Caption> below the
// chart into a bordered note above it. Nothing was shortened: the per-team detail now lives in
// the per-team one-liners (CannotSeparate variant="summary"), which expand to their full text.
export type IslandExplainerTeam = {
  teamId: string;
  teamName: string;
  drivers: string[];
};

export type IslandExplainerProps = {
  /** Floating teams in this season, used only to name them in the lead line. */
  teams: IslandExplainerTeam[];
  className?: string;
};

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function IslandExplainer({
  teams,
  className,
}: IslandExplainerProps): React.JSX.Element {
  const named = joinNames(teams.map((t) => t.teamName));

  return (
    <div
      role="note"
      className={`rounded-lg border border-dashed border-accent/60 bg-accent/5 px-4 py-3 ${className ?? ""}`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(232,163,61,0.10) 0 6px, transparent 6px 12px)",
      }}
    >
      <h3 className="text-sm font-semibold text-fg">
        Read this first: some cars have a level we did not measure
        {named ? ` — ${named} this season` : ""}.
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Splitting a lap into &ldquo;car&rdquo; and &ldquo;driver&rdquo; only works when
        drivers move between teams, and in 2024–2026 only twelve of twenty-eight did. That
        leaves four separate groups of drivers that cannot be compared with each other at
        all, and four drivers — Lando Norris, Oscar Piastri, Fernando Alonso and Lance
        Stroll — whose own results say nothing about how good their cars were. For them we
        borrow the answer from the rest of the grid: we assume their team&apos;s two
        drivers are an ordinary pair and give the car whatever is left over. That
        assumption, not their results, is what decides how much credit McLaren and Aston
        Martin get here.
      </p>
      {teams.length > 0 ? (
        <p className="mt-2 text-sm text-fg">
          Below, one line per affected team says what that means for it. Open a line for the
          full wording.
        </p>
      ) : null}
    </div>
  );
}
