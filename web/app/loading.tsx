// OPS_SPEC §5.1 — the cold-start experience. Neon Free autosuspends after 5 idle minutes and
// every route is force-dynamic, so the first visit after idle used to be 1.5–7 s of blank tab,
// which is indistinguishable from a dead site. This is the Suspense fallback Next renders in
// <main> while the page's queries run: the frame paints at once and the content streams in
// when the database answers. It says what is happening in words, not only in grey blocks.
export default function Loading(): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="animate-pulse">
      <div className="h-3 w-40 rounded bg-grid" aria-hidden />
      <div className="mt-3 h-8 w-2/3 max-w-md rounded bg-raised" aria-hidden />
      <p className="mt-4 text-sm text-muted">Loading the timing data…</p>
      <div className="mt-8 space-y-3" aria-hidden>
        <div className="h-4 w-full rounded bg-surface" />
        <div className="h-4 w-11/12 rounded bg-surface" />
        <div className="h-4 w-4/5 rounded bg-surface" />
        <div className="mt-6 h-48 w-full rounded border border-grid bg-surface/60" />
      </div>
    </div>
  );
}
