import type { Metadata } from "next";
import { Titillium_Web, Geist_Mono } from "next/font/google";
import Nav from "@/components/ui/Nav";
import { C_NOT_LOADED, fill } from "@/lib/home/captions";
import { fmtDate } from "@/lib/format";
import { formatPushedAt, getLatestRelease, getStaleRound } from "@/lib/queries/release";
import "./globals.css";

// Titillium Web was Formula 1's own typeface from 2014–2017 and is the closest free
// match to the current one: narrow, technical, with the flat terminals a timing screen
// wants. Geist (the Next.js default) is what made the site read as a generic dashboard.
const titillium = Titillium_Web({
  variable: "--font-titillium",
  subsets: ["latin"],
  weight: ["300", "400", "600", "700", "900"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "F1 Analytics",
    template: "%s · F1 Analytics",
  },
  description:
    "Fuel-corrected race pace, tyre degradation and teammate comparisons computed from FastF1 timing data.",
};

// Data changes only at ingest, but every page reads Postgres per request (SPEC D20).
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${titillium.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* UX_SPEC §4.2 — the skip link, and it must be the FIRST focusable element in the
            document, before <Nav>. Without it a keyboard reader crosses nine navigation links
            on every page before reaching the content; on /ask that is nine tab stops before
            the question box. Styled in globals.css (.skip-link): off-screen by transform, so
            it stays in the tab order, and it slides in on focus. */}
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <Nav />
        {/* tabIndex={-1} so the skip link can move focus here, not just the scroll position —
            without it Safari and Firefox scroll but leave focus in the link, and the next Tab
            goes back into the nav. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus-visible:outline-none sm:px-6"
        >
          {children}
        </main>
        <footer className="mt-12 border-t-2 border-accent/70 bg-surface/40 px-4 py-5 text-center text-xs text-muted">
          <p>
            Computed by f1lab from FastF1 timing data. Every number depends on stated assumptions;
            each race page lists them.
          </p>
          <Freshness />
        </footer>
      </body>
    </html>
  );
}

// OPS_SPEC §3.4 — the freshness line. An async server component rendered beside <Nav>, which
// already awaits two queries, so this one costs no extra round trip on the shell. Short and
// number-heavy on purpose: the caption baseline (tests/a11y) freezes wordy sentences, and a
// line that changes every night must never be one of them. With no `data_release` row yet
// (local dev, a fresh Neon project) it says so in one neutral clause and never throws.
//
// IDEAS_2026-09 §1 #6 — and the stale-data guard beside it: when the latest past round has no
// loaded race session, one sentence (lib/home/captions.ts C_NOT_LOADED, shared with the home
// strip) says so, rather than letting "Data as of" imply the previous round is current.
async function Freshness(): Promise<React.JSX.Element> {
  const [rel, stale] = await Promise.all([getLatestRelease(), getStaleRound()]);
  const staleLine = stale ? (
    <p role="status" className="mt-1 font-medium text-fg">
      {fill(C_NOT_LOADED, { round: stale.round, event: stale.eventName, date: fmtDate(stale.eventDate) })}
    </p>
  ) : null;
  if (rel === null) {
    return (
      <>
        <p className="mt-1 tnum">Data as of: no push recorded yet.</p>
        {staleLine}
      </>
    );
  }
  const rows = rel.rowsPushed.toLocaleString("en-GB");
  return (
    <>
      <p className="mt-1 tnum">
        Data as of {formatPushedAt(rel.pushedAt)} · last push {rel.sessionsPushed} session
        {rel.sessionsPushed === 1 ? "" : "s"}, {rows} rows
      </p>
      {staleLine}
    </>
  );
}
