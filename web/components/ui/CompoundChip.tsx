// Tyre compound label in the session's compound colour (hex from compound_colours).
export type CompoundChipProps = {
  compound: string;
  colour: string;
  /** Short form (`S`, `M`, `H`, `I`, `W`) instead of the full name. */
  short?: boolean;
  className?: string;
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[-\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export default function CompoundChip({
  compound,
  colour,
  short = false,
  className,
}: CompoundChipProps): React.JSX.Element {
  const label = short ? compound.charAt(0).toUpperCase() : titleCase(compound);
  return (
    <span
      title={titleCase(compound)}
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${className ?? ""}`}
      style={{ borderColor: colour, color: colour }}
    >
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: colour }}
      />
      {label}
    </span>
  );
}
