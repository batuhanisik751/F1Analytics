// Page section: title, optional caption line, content. Every page section uses this.
//
// UX_SPEC §2.1 — this is the single disclosure lever in the app, so it gained
// `collapsible`/`defaultOpen`/`storageKey`/`summary`. Defaults are chosen so that every
// pre-existing call site renders byte-identical markup: `collapsible` is false and the
// non-collapsible branch below is the original component untouched.
//
// UX_SPEC §0 — COLLAPSE, NEVER DELETE. Collapsing hides content with CSS/`<details>`; it
// never removes it. A caption passed alongside a `summary` is still in the DOM when the
// section is closed (it is `hidden`, not absent), so the caption-preservation test passes
// whatever a section's open state is. Do not default-close a refusal or an honesty badge.
import DetailsMemory from "./DetailsMemory";

export type SectionProps = {
  title: string;
  /** Short explanatory text rendered under the title. */
  caption?: React.ReactNode;
  /**
   * Right-aligned controls (links, badges). When `collapsible` is set these move to the
   * top of the section body: a `<summary>` may not contain interactive controls without
   * stealing their clicks. A section whose actions carry an honesty badge should therefore
   * stay open (`defaultOpen` left at true) — see §0.
   */
  actions?: React.ReactNode;
  /** Anchor id for in-page links. */
  id?: string;
  /** §2.1 — render as native `<details>`; keyboard-, screen-reader- and find-in-page-operable. */
  collapsible?: boolean;
  /** Open on first render. Default true. Never false for a refusal (§0). */
  defaultOpen?: boolean;
  /** Per-viewer memory of the open state. Omit to not remember. */
  storageKey?: string;
  /** §2.3 — one specific line shown in place of the caption while closed. */
  summary?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

/** The broadcast lower-third: skewed red flash, caps title, caption. Identical in both branches. */
function Heading({
  title,
  caption,
  summary,
  collapsible,
}: Pick<SectionProps, "title" | "caption" | "summary"> & {
  /** Only a collapsible section has a `group`/`<details>` ancestor, so only it may use
      `group-open:` to swap caption and summary. Without one the caption would stay hidden. */
  collapsible: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="tower-flash h-5 w-1.5 shrink-0 bg-accent" />
      <div>
        <h2 className="tower-label text-base leading-tight text-fg sm:text-lg">{title}</h2>
        {caption ? (
          <p
            className={`mt-1 text-sm leading-snug text-muted${collapsible && summary ? " hidden group-open:block" : ""}`}
          >
            {caption}
          </p>
        ) : null}
        {summary ? (
          <p className={`mt-1 text-sm leading-snug text-muted${collapsible ? " group-open:hidden" : ""}`}>
            {summary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function Section({
  title,
  caption,
  actions,
  id,
  collapsible = false,
  defaultOpen = true,
  storageKey,
  summary,
  children,
  className,
}: SectionProps): React.JSX.Element {
  const wrapper = `mt-12 first:mt-0 scroll-mt-20 ${className ?? ""}`;

  if (!collapsible) {
    return (
      <section id={id} className={wrapper}>
        {/* Broadcast lower-third: a skewed red flash, caps title, and a rule that fades
            out to the right the way an on-screen graphic does. */}
        <header className="mb-4 border-b border-grid pb-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <Heading title={title} caption={caption} summary={summary} collapsible={false} />
            {actions ? <div className="flex items-center gap-2 text-sm">{actions}</div> : null}
          </div>
        </header>
        {children}
      </section>
    );
  }

  return (
    <section id={id} className={wrapper}>
      <details className="group" open={defaultOpen}>
        {/* Whole row is the hit target, >= 44px tall. `list-none` + the webkit rule remove
            the native triangle; the chevron below replaces it and rotates on open. */}
        <summary className="mb-4 flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-2 border-b border-grid py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <Heading title={title} caption={caption} summary={summary} collapsible />
          <span aria-hidden className="ml-auto shrink-0 pr-1 text-muted group-hover:text-accent">
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </summary>
        {storageKey ? <DetailsMemory storageKey={storageKey} /> : null}
        {actions ? (
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-sm">{actions}</div>
        ) : null}
        {children}
      </details>
    </section>
  );
}
