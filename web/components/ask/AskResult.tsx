"use client";
// MODE3_SPEC §3.4, §8.4, §8.6, §8.7 — one generated answer, in the visual grammar of §8.6:
// dashed accent border, a persistent `generated` badge, the SQL panel and the method line always
// present. Every model-authored string (headline, method, caveat) is a React text node.
import Link from "next/link";
import AskChart from "@/components/charts/AskChart";
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import AskFailure, { AskEmptyResult, AskTruncationNotice } from "./AskFailure";
import AskTable from "./AskTable";
import GeneratedBadge from "./GeneratedBadge";
import SqlPanel from "./SqlPanel";
import { formatValue, safeRender } from "./format";
import { pageLinkForViews } from "./pageLinks";
import type { AskPlanEvent, AskResultEvent } from "./types";

function SingleFigure({
  result,
}: {
  result: AskResultEvent;
}): React.JSX.Element {
  const valueIdx = result.fields.indexOf(result.render.valueCols[0]);
  const labelIdx = result.render.labelCol ? result.fields.indexOf(result.render.labelCol) : -1;
  const row = result.rows[0] ?? [];
  const label = labelIdx >= 0 ? row[labelIdx] : null;
  return (
    <div className="rounded-lg border border-accent/40 bg-surface/40 px-4 py-6 text-center">
      <p className="tnum text-4xl font-semibold tracking-tight text-fg">
        {formatValue(row[valueIdx], result.render.unit)}
      </p>
      {label !== null && label !== undefined ? (
        <p className="mt-1 text-sm text-muted">{String(label)}</p>
      ) : null}
    </div>
  );
}

export default function AskResult({
  plan,
  result,
  error,
}: {
  plan: AskPlanEvent;
  result: AskResultEvent | null;
  /** Set when execution failed after the plan was shown (§3.7). */
  error?: { code: string; message: string; gate: string | null } | null;
}): React.JSX.Element {
  const render = result ? safeRender(result.render, result.fields, result.rows) : null;
  const dropped = result && result.truncated ? Math.max(0, result.rowCount - result.rows.length) : 0;
  const pageLink = pageLinkForViews(plan.views);
  const chart =
    result && render && render.kind !== "table" && render.kind !== "single" ? (
      <AskChart
        fields={result.fields}
        rows={result.rows}
        render={render}
        ariaLabel={plan.headline}
      />
    ) : null;

  return (
    <section className="mt-6 border-l-2 border-dashed border-accent/40 pl-4">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-accent/40 pb-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">{plan.headline}</h2>
          <p className="mt-0.5 text-sm text-muted">{plan.method}</p>
        </div>
        <GeneratedBadge />
      </header>

      {plan.retried ? (
        <p className="mb-3 rounded border border-accent/40 bg-surface/40 px-3 py-2 text-xs text-muted">
          Claude&rsquo;s first query didn&rsquo;t pass
          {plan.retryReason ? <> (<span className="font-mono">{plan.retryReason}</span>)</> : null}.
          This is the second attempt.
        </p>
      ) : null}

      {error ? (
        <AskFailure code={error.code} detail={error.message} sql={plan.sql} gate={error.gate} />
      ) : result === null ? null : result.rows.length === 0 ? (
        <AskEmptyResult>
          <SqlPanel plan={plan} rowCount={0} />
        </AskEmptyResult>
      ) : (
        <>
          {render?.kind === "single" ? <SingleFigure result={result} /> : null}
          {chart}
          {chart ? (
            // A chart alone is a claim; a chart over its own rows is evidence (§3.4). §2.2 files
            // evidence under CLOSED, which is where it already was — this is the same native
            // <details>, now through the shared primitive so the hit target and the chevron match
            // every other disclosure in the app.
            <Disclosure
              variant="inline"
              summary={`show the ${result.rows.length} rows behind this chart`}
            >
              <AskTable fields={result.fields} rows={result.rows} />
            </Disclosure>
          ) : render?.kind === "single" ? null : (
            <AskTable fields={result.fields} rows={result.rows} />
          )}
          <AskTruncationNotice dropped={dropped} />
        </>
      )}

      {plan.caveat ? <Caption>{plan.caveat}</Caption> : null}

      {result && result.rows.length > 0 ? <SqlPanel plan={plan} rowCount={result.rowCount} /> : null}
      {result === null && !error ? <SqlPanel plan={plan} rowCount={null} /> : null}

      {pageLink ? (
        <p className="mt-3 rounded-lg border border-grid bg-surface/50 px-3 py-2 text-sm text-muted">
          <strong className="text-fg">There&rsquo;s a proper page for this.</strong>{" "}
          <Link href={pageLink.href} className="text-accent underline">
            {pageLink.label}
          </Link>{" "}
          {pageLink.why}. It was computed once, checked, and does not change.
        </p>
      ) : null}
    </section>
  );
}
