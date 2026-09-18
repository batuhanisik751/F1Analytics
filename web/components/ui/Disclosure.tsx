// UX_SPEC §2.1 — the same disclosure affordance as `Section`, but INSIDE a section: a long
// caption, a method note, a secondary table.
//
// §0 COLLAPSE, NEVER DELETE: the point of this component is that a caveat too long to leave
// expanded goes BEHIND a control instead of being cut. Put the full original text in `children`
// and write a NEW short line for `summary` — never a truncated copy of the text inside.
//
// Native <details>/<summary>: operable by keyboard, announced by screen readers, and openable by
// browser find-in-page, with no JavaScript. `storageKey` adds per-viewer memory on top.
import DetailsMemory from "./DetailsMemory";

export type DisclosureProps = {
  /** §2.3 — a specific line saying what is inside. "Details" is not a summary. */
  summary: React.ReactNode;
  /** Muted text after the summary, e.g. a count: "9 constants". */
  hint?: React.ReactNode;
  /** Default false: a method note or diagnostic starts closed. A refusal must pass true (§0). */
  defaultOpen?: boolean;
  /** Per-viewer memory of the open state. Omit to not remember. */
  storageKey?: string;
  /** `panel` (default) is a bordered block; `inline` is a bare line under a chart or table. */
  variant?: "panel" | "inline";
  children: React.ReactNode;
  className?: string;
  id?: string;
};

const CHEVRON = (
  <svg
    viewBox="0 0 16 16"
    className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden
  >
    <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Disclosure({
  summary,
  hint,
  defaultOpen = false,
  storageKey,
  variant = "panel",
  children,
  className,
  id,
}: DisclosureProps): React.JSX.Element {
  const panel = variant === "panel";
  return (
    <details
      id={id}
      open={defaultOpen}
      className={`group ${panel ? "mt-4 rounded-lg border border-grid bg-surface/40" : "mt-2"} ${className ?? ""}`}
    >
      {/* Whole row is the hit target and is >= 44px tall for touch (§4.7). */}
      <summary
        className={`flex min-h-[44px] cursor-pointer list-none items-center gap-2 py-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden ${
          panel ? "px-4 text-sm text-fg" : "text-xs text-muted"
        }`}
      >
        {CHEVRON}
        <span className="leading-snug">
          {summary}
          {hint ? <span className="ml-2 text-muted">{hint}</span> : null}
        </span>
      </summary>
      {storageKey ? <DetailsMemory storageKey={storageKey} /> : null}
      <div
        className={
          panel
            ? "border-t border-grid px-4 py-3 text-sm leading-relaxed text-muted"
            : "pb-1 text-xs leading-relaxed text-muted"
        }
      >
        {children}
      </div>
    </details>
  );
}
