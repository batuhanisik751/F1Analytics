// MODE2_SPEC §1.4 / §1.5 / §8.4.2 — the island treatment, shared by the constructor
// pages and the "Was it the car?" page. Rendered wherever a car or a driver belongs to a
// floating component (K3 Aston Martin, K4 McLaren): the model has ZERO information about
// that component's level, so no split number may be shown as if it were measured.
//
// A screenshot of this block with no surrounding context must still be honest, which is
// why it carries the whole claim in words and never a headline numeral.
//
// UX_SPEC §2.2 — on a page that repeats this block once per affected team, `variant="summary"`
// renders a per-team ONE-LINER that names the team and still states the refusal in full, with
// the identical body text behind a native <details>. §0: the text below is never shortened and
// never removed, only moved behind a control the reader can open; the shared part of the
// explanation is rendered once, open, by components/witc/IslandExplainer.
import Disclosure from "@/components/ui/Disclosure";

export type CannotSeparateProps = {
  /** Team display name, e.g. "McLaren". */
  teamName: string;
  /** The component's drivers, display names if known. */
  drivers: string[];
  /** What IS measured here — the within-island contrast, in words. */
  measuredInstead?: React.ReactNode;
  /**
   * `full` (default) is the standalone block used on a constructor page, where it appears
   * once. `summary` is the repeated-per-team form: a one-liner carrying the refusal, opening
   * onto exactly the same paragraphs.
   */
  variant?: "full" | "summary";
  className?: string;
};

/** Marker string asserted by the render test; do not reword without updating it. */
export const CANNOT_SEPARATE_TEXT = "cannot separate the car from the driver";

function pairOf(drivers: string[]): string {
  return drivers.length === 0
    ? "this team's drivers"
    : drivers.length === 1
      ? drivers[0]
      : `${drivers.slice(0, -1).join(", ")} and ${drivers[drivers.length - 1]}`;
}

/** The words themselves, identical in both variants. */
function Body({
  teamName,
  pair,
  measuredInstead,
}: {
  teamName: string;
  pair: string;
  measuredInstead?: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <p className="text-sm font-semibold text-fg">
        For {teamName} we {CANNOT_SEPARATE_TEXT}.
      </p>
      <p className="mt-1 text-sm text-muted">
        {pair} never changed team between 2024 and 2026, and neither did any team-mate of
        theirs. Adding the same amount to both drivers and taking it off the car leaves
        every lap time we observed unchanged, so our data contain no information at all
        about which of the two it was. The level shown for this team is borrowed from the
        rest of the grid — we assume its two drivers are an ordinary pair and give the car
        whatever is left over. That assumption, not {teamName}&apos;s results, is what
        decides the number.
      </p>
      {measuredInstead ? (
        <p className="mt-2 text-sm text-fg">
          <span className="font-medium">What is measured:</span> {measuredInstead}
        </p>
      ) : null}
    </>
  );
}

export default function CannotSeparate({
  teamName,
  drivers,
  measuredInstead,
  variant = "full",
  className,
}: CannotSeparateProps): React.JSX.Element {
  const pair = pairOf(drivers);

  if (variant === "summary") {
    return (
      <Disclosure
        // A left accent bar marks the refusal without fighting Disclosure's own border
        // utilities; the summary text carries the claim, so colour is never the only channel (4.3).
        className={`border-l-2 border-l-accent/70 ${className ?? ""}`}
        summary={
          <>
            <span className="font-semibold text-fg">{teamName}</span> — we{" "}
            {CANNOT_SEPARATE_TEXT}
            {drivers.length > 0 ? `: ${pair} never changed team` : ""}, so this car&apos;s
            level is borrowed from the rest of the grid, not measured.
          </>
        }
        hint="open for the full wording"
      >
        <Body teamName={teamName} pair={pair} measuredInstead={measuredInstead} />
      </Disclosure>
    );
  }

  return (
    <div
      role="note"
      className={`rounded-lg border border-dashed border-accent/60 bg-accent/5 px-4 py-3 ${className ?? ""}`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(232,163,61,0.10) 0 6px, transparent 6px 12px)",
      }}
    >
      <Body teamName={teamName} pair={pair} measuredInstead={measuredInstead} />
    </div>
  );
}
