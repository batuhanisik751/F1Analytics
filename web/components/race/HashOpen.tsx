"use client";

// UX_SPEC §2.2 + §4.1 — the in-page section nav must keep working now that sections collapse.
// A `#id` link to a closed <details> scrolls to a one-line stub and leaves the reader looking at
// nothing, which reads as a broken link. This opens the target (and any <details> ancestor of it)
// and then scrolls it into view.
//
// Deliberately tiny and defensive: the nav is plain <a href="#id"> markup that already works
// without JavaScript (the browser still scrolls to the stub), so this is an enhancement, never a
// dependency. Nothing here writes state or storage.
import { useEffect } from "react";

function openTarget(hash: string): void {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;

  const open = (): void => {
    // The section's own <details>, and every <details> it is nested inside.
    const own = el instanceof HTMLDetailsElement ? el : el.querySelector("details");
    if (own instanceof HTMLDetailsElement) own.open = true;
    for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
      if (p instanceof HTMLDetailsElement) p.open = true;
    }
  };

  open();
  // Run again on the next frame, for two reasons: `DetailsMemory` restores a remembered open
  // state in its own mount effect, which runs AFTER this component's (it sits deeper in the
  // tree), and would otherwise re-close a section the reader just asked for by name; and the
  // scroll has to measure the opened height, not the collapsed stub.
  requestAnimationFrame(() => {
    open();
    el.scrollIntoView({
      block: "start",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
}

export default function HashOpen(): null {
  useEffect(() => {
    if (window.location.hash) openTarget(window.location.hash);

    const onHashChange = (): void => openTarget(window.location.hash);
    window.addEventListener("hashchange", onHashChange);

    // `hashchange` does not fire when the reader clicks the link for the hash they are already on,
    // which is exactly the case where they closed a section and want it back.
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as Element | null)?.closest?.("a[href^='#']");
      if (!(a instanceof HTMLAnchorElement)) return;
      const hash = a.getAttribute("href") ?? "";
      if (hash.length > 1) openTarget(hash);
    };
    document.addEventListener("click", onClick);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return null;
}
