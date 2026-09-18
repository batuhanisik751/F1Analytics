import type { Metadata } from "next";
import { Titillium_Web, Geist_Mono } from "next/font/google";
import Nav from "@/components/ui/Nav";
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
          Computed by f1lab from FastF1 timing data. Every number depends on stated assumptions;
          each race page lists them.
        </footer>
      </body>
    </html>
  );
}
