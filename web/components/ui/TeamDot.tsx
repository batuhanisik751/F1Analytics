// A small filled circle in a team's colour. The hex comes from the DB (never computed here).
export type TeamDotProps = {
  colour: string;
  /** Diameter in px; default 10. */
  size?: number;
  title?: string;
  className?: string;
};

export default function TeamDot({
  colour,
  size = 10,
  title,
  className,
}: TeamDotProps): React.JSX.Element {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={`tower-flash inline-block shrink-0 align-middle ${className ?? ""}`}
      style={{
        // A timing tower flags a car with a vertical team bar, not a dot. `size` stays
        // the caller's contract and is read as the bar's height.
        width: Math.max(3, Math.round(size * 0.55)),
        height: Math.round(size * 1.25),
        backgroundColor: colour,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
      }}
    />
  );
}
