import type { Metadata } from "next";
import Link from "next/link";

import PageHeader from "@/components/ui/PageHeader";
import Section from "@/components/ui/Section";
import TermTip from "@/components/ui/TermTip";
import { GLOSSARY, GLOSSARY_IDS, glossaryHref, type GlossaryId } from "@/lib/ui/glossary";

// UX_SPEC §3.2 — every term on the site, in plain language, at a stable anchor that every
// <TermTip> links to. The page is static: no database, so it renders even when Postgres is down.
export const metadata: Metadata = { title: "Glossary" };
export const dynamic = "force-static";

/** Themed, not alphabetical: a reader arrives from a tooltip and then browses its neighbours. */
const GROUPS: ReadonlyArray<{ title: string; blurb: string; ids: readonly GlossaryId[] }> = [
  {
    title: "Gaps and scales",
    blurb: "What the numbers on the charts are measured in.",
    ids: ["pp", "normal-score", "percentile-range", "correlation-r"],
  },
  {
    title: "How sure the numbers are",
    blurb: "Every figure here says how much evidence is behind it. This is that vocabulary.",
    ids: ["observation", "evidence-share", "pooling-prior", "total-sd"],
  },
  {
    title: "Ratings, and who can be compared with whom",
    blurb: "Driver ratings are chains of team-mate comparisons, and the chains sometimes break.",
    ids: ["component-anchored", "island-driver", "counterfactual"],
  },
  {
    title: "Tyres, fuel and laps",
    blurb: "Which laps count, and what is taken out of them before anything is compared.",
    ids: ["green-flag-lap", "stint", "fuel-corrected", "degradation"],
  },
  {
    title: "Forecasts",
    blurb: "How a prediction is scored after the race has happened.",
    ids: ["brier-score", "calibration"],
  },
  {
    title: "Telemetry",
    blurb: "Terms from the corner-by-corner traces.",
    ids: ["chord-distance", "trail-braking", "drs-no-signal"],
  },
];

const GROUPED = new Set(GROUPS.flatMap((g) => g.ids));
/** Anything added to the glossary and not filed above still renders — the page cannot drop a term. */
const UNGROUPED = GLOSSARY_IDS.filter((id) => !GROUPED.has(id));

function Entry({ id }: { id: GlossaryId }): React.JSX.Element {
  const entry = GLOSSARY[id];
  return (
    <div id={id} className="scroll-mt-24 border-t border-grid py-4 first:border-t-0 first:pt-0">
      <dt className="tower-label text-sm text-fg">
        <Link href={glossaryHref(id)} className="hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {entry.term}
        </Link>
      </dt>
      <dd className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
        <p className="text-fg">{entry.short}</p>
        <p className="mt-2">{entry.long}</p>
        {entry.seeAlso.length > 0 ? (
          <p className="mt-2 text-xs">
            <span className="tower-label text-[10px]">See also</span>{" "}
            {entry.seeAlso.map((other, i) => (
              <span key={other}>
                {i > 0 ? ", " : ""}
                <Link
                  href={`#${other}`}
                  className="text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {GLOSSARY[other as GlossaryId].term}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

export default function GlossaryPage(): React.JSX.Element {
  const groups = UNGROUPED.length
    ? [...GROUPS, { title: "Other terms", blurb: "", ids: UNGROUPED as readonly GlossaryId[] }]
    : GROUPS;

  return (
    <>
      <PageHeader
        title="Glossary"
        subtitle="Every unit, score and refusal on this site, in plain language."
        meta={`${GLOSSARY_IDS.length} terms. Each one is linked from the tooltip where it appears.`}
      />
      <p className="mb-6 max-w-prose text-sm leading-relaxed text-muted">
        Wherever one of these words appears on the site it is underlined with dots, like{" "}
        <TermTip term="pp" placement="bottom" />. Hover it, tab to it, or tap it to get the short
        version; the link in the bubble brings you here for the long one.
      </p>
      <nav aria-label="Glossary terms" className="mb-8 flex flex-wrap gap-x-3 gap-y-2 border-y border-grid py-3 text-xs">
        {GLOSSARY_IDS.map((id) => (
          <Link
            key={id}
            href={`#${id}`}
            className="inline-flex min-h-[32px] items-center text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {GLOSSARY[id].term}
          </Link>
        ))}
      </nav>
      {groups.map((group) => (
        <Section key={group.title} title={group.title} caption={group.blurb || undefined}>
          <dl>
            {group.ids.map((id) => (
              <Entry key={id} id={id} />
            ))}
          </dl>
        </Section>
      ))}
    </>
  );
}
