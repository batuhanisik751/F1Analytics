"use client";

// UX_SPEC §3.1 / §3.2 — a term with its plain-language definition attached.
//
// The definition must be reachable by HOVER and by KEYBOARD FOCUS and by TAP. `title=` is none of
// those on a phone and unreliable with a screen reader, so instead: a real focusable <button>
// carrying `aria-describedby` to the bubble, revealed by CSS on hover and on focus-within. Tapping
// focuses the button, which is what makes it work on touch. The bubble sits inside the hover group
// so the pointer can travel into it, and Escape dismisses it (WCAG 1.4.13).
//
// The only thing JavaScript does here is generate a unique id and handle Escape; the markup is
// server-rendered and the hover/focus reveal is pure CSS.
import Link from "next/link";
import { useId, useState } from "react";

import { GLOSSARY, glossaryHref, type GlossaryId } from "@/lib/ui/glossary";

export type TermTipProps = {
  term: GlossaryId;
  /** Visible text. Defaults to the glossary term itself. */
  children?: React.ReactNode;
  /** Bubble side. Default "top"; use "bottom" inside a page header. */
  placement?: "top" | "bottom";
  className?: string;
};

export default function TermTip({
  term,
  children,
  placement = "top",
  className,
}: TermTipProps): React.JSX.Element {
  const entry = GLOSSARY[term];
  const tipId = useId();
  const [dismissed, setDismissed] = useState(false);

  return (
    <span
      className={`group/tip relative inline-block ${className ?? ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") setDismissed(true);
      }}
      onMouseLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      <button
        type="button"
        aria-describedby={tipId}
        className="cursor-help border-b border-dotted border-muted/70 py-1 text-left decoration-dotted hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {children ?? entry.term}
      </button>
      <span
        role="tooltip"
        id={tipId}
        className={`invisible absolute left-0 z-40 w-[min(18rem,80vw)] rounded-md border border-grid bg-raised p-3 text-xs leading-relaxed font-normal normal-case tracking-normal text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100 motion-reduce:transition-none ${
          placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
        } ${dismissed ? "hidden" : ""}`}
      >
        <span className="tower-label block text-[11px] text-muted">{entry.term}</span>
        <span className="mt-1 block">{entry.short}</span>
        <Link
          href={glossaryHref(term)}
          className="mt-2 inline-block text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Full definition
        </Link>
      </span>
    </span>
  );
}
