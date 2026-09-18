"use client";

// UX_SPEC §2.1 — per-viewer memory of one <details> open state.
//
// Deliberately NOT the whole disclosure: `Section` and `Disclosure` stay server components and
// render real <details>/<summary>, so they are keyboard-operable, screen-reader-announced and
// findable by browser find-in-page with JavaScript off. This component only remembers what the
// viewer did. If it never runs, or localStorage throws (private window, blocked site data), the
// section still renders and still opens — it just forgets.
import { useEffect, useRef } from "react";

export const STORAGE_PREFIX = "f1a:disclosure:";

/** Namespaced so a key like "quali-segments" cannot collide with unrelated site storage. */
export function storageName(storageKey: string): string {
  return `${STORAGE_PREFIX}${storageKey}`;
}

/** Reads a remembered state. `null` means "nothing remembered" — the markup default wins. */
export function readRemembered(storageKey: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(storageName(storageKey));
    if (raw === "open") return true;
    if (raw === "closed") return false;
    return null;
  } catch {
    return null;
  }
}

export function writeRemembered(storageKey: string, open: boolean): void {
  try {
    window.localStorage.setItem(storageName(storageKey), open ? "open" : "closed");
  } catch {
    /* Private window or blocked site data: forgetting is the correct fallback. */
  }
}

export default function DetailsMemory({ storageKey }: { storageKey: string }): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const details = anchor.current?.closest("details");
    if (!details) return;

    const remembered = readRemembered(storageKey);
    if (remembered !== null && remembered !== details.open) details.open = remembered;

    const onToggle = (): void => writeRemembered(storageKey, details.open);
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, [storageKey]);

  return <span ref={anchor} hidden aria-hidden data-disclosure-memory={storageKey} />;
}
