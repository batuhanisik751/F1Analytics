"use client";
// MODE3_SPEC §3.6 — clarification is not a failure, and out-of-scope is not an empty table.
//
// The rephrasings are clickable chips: one click re-submits and the fan never retypes. The chip
// text is model-authored and rendered as a text node; clicking it submits that TEXT as a new
// question, which goes through the same §1.8 input gate as anything typed by hand.
import Link from "next/link";
import GeneratedBadge from "./GeneratedBadge";

export function AskClarify({
  clarification,
  options,
  method,
  onPick,
}: {
  clarification: string;
  options: string[];
  method: string;
  onPick: (question: string) => void;
}): React.JSX.Element {
  return (
    <section className="mt-6 border-l-2 border-dashed border-accent/40 pl-4">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-accent/40 pb-2">
        <h2 className="text-lg font-semibold tracking-tight text-fg">{clarification}</h2>
        <GeneratedBadge />
      </header>
      <p className="text-sm text-muted">{method}</p>
      <p className="mt-2 text-xs text-muted">
        Two readings of that question would give materially different numbers, so nothing was run.
        Pick one:
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            className="rounded-full border border-accent/60 px-3 py-1 text-sm text-accent hover:bg-accent/10"
          >
            {o}
          </button>
        ))}
      </div>
    </section>
  );
}

export function AskOutOfScope({ reason }: { reason: string }): React.JSX.Element {
  return (
    <section className="mt-6 border-l-2 border-dashed border-accent/40 pl-4">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-accent/40 pb-2">
        <h2 className="text-lg font-semibold tracking-tight text-fg">
          That&rsquo;s outside what this database holds.
        </h2>
        <GeneratedBadge />
      </header>
      <p className="text-sm text-muted">{reason}</p>
      <p className="mt-3 text-sm">
        <Link href="/season/2024" className="text-accent underline">
          Coverage starts at the 2024 season
        </Link>{" "}
        — race and sprint sessions only.
      </p>
    </section>
  );
}
