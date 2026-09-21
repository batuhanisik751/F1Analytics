// MODE3_SPEC §8.5 — every failure and empty state, in the site's existing EmptyState chrome.
//
// The pipeline sends a CODE, never prose (§3.7): all fan-facing copy lives here so that no raw
// upstream or Postgres string can reach a reader. Every ending of §3.7 has a row in FAILURES.
import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";

export type AskFailureCopy = {
  title: string;
  body: string;
  /** Show the rejected SQL and the gate that fired (§8.5 row 1). */
  showSql?: boolean;
  /** Show our own detail string (a plan cost, a gate name) — never an upstream message. */
  showDetail?: boolean;
  /** Offer the precomputed pages, which need no API (§8.5 "API down"). */
  offerPages?: boolean;
};

export const FAILURES: Record<string, AskFailureCopy> = {
  rejected: {
    title: "Claude wrote a query we wouldn't run.",
    body: "This is the safety check working. Try rephrasing.",
    showSql: true,
    showDetail: true,
  },
  sql: {
    title: "Claude wrote a query we wouldn't run.",
    body: "This is the safety check working. Try rephrasing.",
    showSql: true,
    showDetail: true,
  },
  denied: {
    title: "Claude wrote a query we wouldn't run.",
    body: "This is the safety check working. Try rephrasing.",
    showSql: true,
    showDetail: true,
  },
  "plan:cost": {
    title: "That question needs a query we won't run here.",
    body: "Try one season, or one circuit.",
    showSql: true,
    showDetail: true,
  },
  "plan:rows": {
    title: "That question needs a query we won't run here.",
    body: "Try one season, or one circuit.",
    showSql: true,
    showDetail: true,
  },
  "plan:width": {
    title: "That question needs a query we won't run here.",
    body: "Try asking for fewer columns, or one season.",
    showSql: true,
    showDetail: true,
  },
  "plan:relation": {
    title: "That question needs a query we won't run here.",
    body: "Try one season, or one circuit.",
    showSql: true,
    showDetail: true,
  },
  "plan:shape": {
    title: "That question needs a query we won't run here.",
    body: "Try one season, or one circuit.",
    showSql: true,
    showDetail: true,
  },
  timeout: {
    title: "The query ran for 4 seconds and was stopped.",
    body: "Try narrowing it to one season or one race.",
    showSql: true,
  },
  busy: {
    title: "Busy right now — try again in a few seconds.",
    body: "The ask box runs two database connections at a time, and both are in use.",
  },
  rate_limit: {
    title: "Busy right now — try again in a few seconds.",
    body: "Claude is rate-limiting us. Nothing is wrong with your question.",
  },
};

const UNREACHABLE: AskFailureCopy = {
  title: "Couldn't reach Claude.",
  body: "Everything else on this site works — it doesn't need an API.",
  offerPages: true,
};

Object.assign(FAILURES, {
  connection: UNREACHABLE,
  upstream: UNREACHABLE,
  no_key: {
    title: "The ask box is switched off on this site.",
    body: "No language model is configured here, so questions cannot be answered. Everything else on this site is precomputed from the timing data and works without one.",
    offerPages: true,
  },
  auth: UNREACHABLE,
  bad_request: UNREACHABLE,
  schema: {
    title: "Claude's answer didn't come back in a form we could use.",
    body: "It was tried twice. Try rephrasing the question.",
  },
  exec: {
    title: "The query failed to run.",
    body: "Nothing was changed — the ask box can only read. Try rephrasing.",
    showSql: true,
  },
  unknown: {
    title: "Something went wrong answering that.",
    body: "Nothing was changed. Try rephrasing, or use the precomputed pages.",
    offerPages: true,
  },
  offline: {
    title: "The ask box is offline.",
    body: "The rest of this site is unaffected — it reads precomputed rows and needs no API.",
    offerPages: true,
  },
  limit_ip: {
    title: "Too many questions at once.",
    body: "Give it a few seconds and ask again.",
  },
  limit_session: {
    title: "That's the last question for today.",
    body: "The ask box allows 20 questions per browser session; the precomputed pages have no limit.",
    offerPages: true,
  },
  limit_budget: {
    title: "The ask box has spent its budget for today.",
    body: "It runs on a fixed daily allowance. The rest of the site is unaffected.",
    offerPages: true,
  },
});

export function failureCopy(code: string): AskFailureCopy {
  return FAILURES[code] ?? FAILURES.unknown;
}

function Pages(): React.JSX.Element {
  return (
    <span className="flex flex-wrap justify-center gap-3">
      <Link href="/" className="text-accent underline">
        Home
      </Link>
      <Link href="/constructor" className="text-accent underline">
        Constructors
      </Link>
      <Link href="/season/2025" className="text-accent underline">
        2025 season
      </Link>
    </span>
  );
}

export default function AskFailure({
  code,
  detail,
  sql,
  gate,
}: {
  code: string;
  /** OUR message (a gate reason, a plan cost). Rendered as a text node, monospace. */
  detail?: string | null;
  sql?: string | null;
  gate?: string | null;
}): React.JSX.Element {
  const copy = failureCopy(code);
  return (
    <EmptyState
      title={copy.title}
      className="border-accent/40"
      reason={copy.showDetail && detail ? detail : null}
    >
      <div className="space-y-3">
        <p>{copy.body}</p>
        {copy.showSql && sql ? (
          <>
            {gate ? <p className="font-mono text-xs text-accent">rejected: {gate}</p> : null}
            <pre className="overflow-x-auto rounded bg-bg/60 p-3 text-left font-mono text-xs text-fg">
              {sql}
            </pre>
          </>
        ) : null}
        {copy.offerPages ? <Pages /> : null}
      </div>
    </EmptyState>
  );
}

/**
 * §8.5's first rule: zero rows is a MECHANICAL FACT and never a statement about the world. The
 * four causes are indistinguishable from the result set, so all four are named.
 */
export function AskEmptyResult({
  children,
}: {
  /** The SQL panel, so the fan can see what actually ran. */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <EmptyState title="The query ran and returned no rows." className="border-accent/40">
      <div className="space-y-2 text-left">
        <p>
          That can mean there were none, or that a name didn&rsquo;t match (this database calls
          Monaco <em>Monte Carlo</em>), or that the season is outside 2024&ndash;2026, or that the
          session&rsquo;s analytics are partial.
        </p>
        <p className="text-xs text-muted">coverage: 2024–2026, 79 sessions</p>
        {children}
      </div>
    </EmptyState>
  );
}

/** §8.5: rows dropped by the 64 KB row cap are never silent. */
export function AskTruncationNotice({ dropped }: { dropped: number }): React.JSX.Element | null {
  if (dropped <= 0) return null;
  return (
    <p className="mt-2 text-xs text-accent">
      {dropped === 1 ? "1 row was" : `${dropped} rows were`} too large to return and{" "}
      {dropped === 1 ? "was" : "were"} skipped.
    </p>
  );
}
