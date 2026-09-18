// UX_SPEC §3.2 / WP-5 — the home page is the first thing a new reader sees, so it is the right
// place to say what the site measures, in which words, and where the full glossary is.
//
// §0 COLLAPSE, NEVER DELETE: nothing here replaces an existing caption. This is new orienting
// copy, and the one paragraph a returning reader does not need (how the pace number is built)
// sits behind a Disclosure rather than being cut.
import Link from "next/link";
import Disclosure from "@/components/ui/Disclosure";
import TermTip from "@/components/ui/TermTip";

export default function WhatThisShows(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-grid bg-surface p-5">
      <p className="text-sm leading-relaxed text-fg">
        Official results tell you who finished where. This site also estimates{" "}
        <strong className="font-semibold">how quick each car and driver actually was</strong>, from
        lap-by-lap timing — and states plainly where the timing data is not good enough to answer.
      </p>

      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        <li className="min-w-0">
          <p className="tower-label text-[11px] text-muted">Race pace</p>
          <p className="mt-1 text-sm leading-snug text-muted">
            A driver&rsquo;s typical lap once the{" "}
            <TermTip term="fuel-corrected">
              <span className="underline decoration-dotted underline-offset-2">
                weight of the fuel
              </span>
            </TermTip>{" "}
            and the laps behind a safety car are taken out.
          </p>
        </li>
        <li className="min-w-0">
          <p className="tower-label text-[11px] text-muted">Gaps</p>
          <p className="mt-1 text-sm leading-snug text-muted">
            Written as seconds per lap, or as a{" "}
            <TermTip term="pp">
              <span className="underline decoration-dotted underline-offset-2">% of a lap</span>
            </TermTip>{" "}
            so that a slow circuit and a fast one can be compared.
          </p>
        </li>
        <li className="min-w-0">
          <p className="tower-label text-[11px] text-muted">Uncertainty</p>
          <p className="mt-1 text-sm leading-snug text-muted">
            Most numbers carry a range. When the range covers zero, the honest answer is
            &ldquo;too close to call&rdquo;, and the page says so.
          </p>
        </li>
      </ul>

      <Disclosure
        summary="How a &ldquo;fastest race pace&rdquo; is worked out"
        hint="3 steps"
        storageKey="home:pace-method"
      >
        <p>
          Every lap a driver completed under green flags is taken, minus in-laps, out-laps and the
          first lap. Each lap is corrected for how much fuel was still on board, because a car gets
          quicker as it empties. The driver&rsquo;s middle lap time after that correction — the
          median, not the average, so one bad lap cannot swing it — is their race pace. The quickest
          of those is the &ldquo;fastest race pace&rdquo;, which is often not the winner.
        </p>
      </Disclosure>

      <p className="mt-4 text-sm">
        <Link
          href="/glossary"
          className="font-semibold text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Every term on this site, explained &rarr;
        </Link>
      </p>
    </div>
  );
}
