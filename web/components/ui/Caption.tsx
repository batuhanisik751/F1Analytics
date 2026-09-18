// One-line caveat under a chart card (the notebook's caveat text).
export type CaptionProps = {
  children: React.ReactNode;
  className?: string;
};

export default function Caption({ children, className }: CaptionProps): React.JSX.Element {
  return (
    <p className={`mt-2 text-xs leading-relaxed text-muted ${className ?? ""}`}>{children}</p>
  );
}
