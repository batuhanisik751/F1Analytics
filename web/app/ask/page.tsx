// MODE3_SPEC §8.3, §8.6 — the ask page: a server shell with no data call, no secret and no fetch.
// Everything dynamic lives in <AskBox/>, which talks to `/api/ask` and nothing else (§0.2).
//
// UX_SPEC §2.2 / §0 — "open the answer, close the evidence and the method". The standing
// explanation under the box is two paragraphs doing two different jobs, so they get two different
// defaults: "How this works" is a METHOD NOTE and goes behind a closed <Disclosure>; "How much to
// trust it" states a LIMIT ON INTERPRETATION ("when they disagree, believe the pages") and stays
// open, because §2.2 lists that class of copy as always-open. Neither sentence was shortened.
import type { Metadata } from "next";
import Link from "next/link";
import AskBox from "@/components/ask/AskBox";
import Disclosure from "@/components/ui/Disclosure";
import PageHeader from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Ask the data",
  description:
    "Ask a question in English; Claude writes one read-only SQL query against this site's database and the query is always shown.",
};

export default function AskPage(): React.JSX.Element {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Ask the data" subtitle="2024–2026" />

      {/* §8.3: the coverage sentence sits ABOVE the box, before the fan types. Pre-emption is
          worth more than any post-hoc caveat. */}
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Races, sprints and qualifying, 2024–2026. Out-qualifying comes from the qualifying
        sessions themselves; grid position is where a car started, after penalties.
      </p>

      <div className="mt-5 rounded-lg border border-dashed border-accent/40 bg-surface/40 p-4">
        <AskBox />
      </div>

      {/* §8.6's standing explanation: once, under the box, in Caption style. Not a modal, not a
          checkbox, not a legal disclaimer. */}
      <div className="mt-8 max-w-2xl">
        <Disclosure
          summary="How this works — one query, written by Claude, run and shown to you"
          storageKey="ask:how-it-works"
        >
          <p>
            <strong className="text-fg">How this works.</strong> You ask in English; Claude writes
            one read-only SQL query against this site&rsquo;s database; we check it, run it, and
            show you both the query and the rows. Claude never writes the numbers — it only writes
            the question that fetched them.
          </p>
        </Disclosure>

        {/* Stays open on purpose (§2.2, §0): a reader who never opens this acts on a generated
            answer as if it were a computed page. */}
        <p className="mt-4 text-xs leading-relaxed text-muted">
          <strong className="text-fg">How much to trust it.</strong> The rest of this site is
          computed once, at ingest, by code that was tested. An answer here was computed just now.
          The query can be subtly wrong in ways that still return sensible-looking rows — averaging
          laps that should have been excluded, say. That is why the query is always shown, why there
          is a plain-English line above it for readers who don&rsquo;t read SQL, and why we link you
          to the precomputed page whenever there is one.{" "}
          <strong className="text-fg">When they disagree, believe the pages.</strong>
        </p>

        <p className="mt-3 text-xs text-muted">
          Unfamiliar word in an answer?{" "}
          <Link href="/glossary" className="text-accent underline underline-offset-2">
            Every term this site uses is defined in the glossary
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
