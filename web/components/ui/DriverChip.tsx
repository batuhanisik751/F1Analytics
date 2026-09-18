import Link from "next/link";
import TeamDot from "./TeamDot";

// Driver code with a team dot; optionally a link (e.g. `/driver/NOR?season=2025`).
export type DriverChipProps = {
  code: string;
  teamColour: string;
  /** Shown after the code when provided (e.g. on results tables). */
  fullName?: string | null;
  /** Renders the chip as a link when set. */
  href?: string;
  /** Used for the tooltip; default `fullName ?? code`. */
  title?: string;
  /** `dashed`/`dotted` teammates get a hollow dot border so the chip mirrors the chart line style. */
  lineStyle?: "solid" | "dashed" | "dotted";
  size?: "sm" | "md";
  className?: string;
};

export default function DriverChip({
  code,
  teamColour,
  fullName,
  href,
  title,
  lineStyle = "solid",
  size = "md",
  className,
}: DriverChipProps): React.JSX.Element {
  const dot =
    lineStyle === "solid" ? (
      <TeamDot colour={teamColour} size={size === "sm" ? 8 : 10} />
    ) : (
      <span
        aria-hidden
        className="tower-flash inline-block shrink-0 align-middle"
        style={{
          width: size === "sm" ? 8 : 10,
          height: size === "sm" ? 8 : 10,
          border: `2px ${lineStyle} ${teamColour}`,
          boxSizing: "border-box",
        }}
      />
    );
  const body = (
    <>
      {dot}
      <span className={`font-mono font-semibold ${size === "sm" ? "text-xs" : "text-sm"}`}>
        {code}
      </span>
      {fullName ? <span className="text-muted">{fullName}</span> : null}
    </>
  );
  const cls = `inline-flex items-center gap-1.5 whitespace-nowrap ${className ?? ""}`;
  if (href) {
    return (
      <Link
        href={href}
        title={title ?? fullName ?? code}
        className={`${cls} rounded px-1 -mx-1 hover:bg-surface hover:text-accent`}
      >
        {body}
      </Link>
    );
  }
  return (
    <span className={cls} title={title ?? fullName ?? code}>
      {body}
    </span>
  );
}
