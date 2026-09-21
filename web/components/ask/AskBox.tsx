"use client";
// MODE3_SPEC §8.3, §8.5, §5.4 — the input, the examples, the SSE consumer and the limit counter.
//
// This component holds no secret and talks to exactly one endpoint, `/api/ask` (§0.2). It renders
// model-authored strings only through the components below it, all of which use text nodes.
import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_QUESTION_LIMIT } from "@/lib/ask/limits";
import AskFailure from "./AskFailure";
import AskProgress, { askProgressTitle, type AskProgressState } from "./AskProgress";
import AskResult from "./AskResult";
import { AskClarify, AskOutOfScope } from "./AskClarify";
import { askAnnouncement } from "./announce";
import { newSseState, parseSseChunk } from "./askStream";
import type { AskEvent, AskPlanEvent, AskResultEvent, AskRejection } from "./types";

export const EXAMPLES = [
  "tyre degradation at Monaco",
  "2025 title odds after Spa",
  "which drivers out-qualified a teammate most in 2025?",
];

type Phase =
  | { k: "idle" }
  | { k: "running"; state: AskProgressState; startedAt: number }
  | { k: "clarify"; clarification: string; options: string[]; method: string }
  | { k: "out_of_scope"; reason: string }
  | { k: "answer" }
  | { k: "failed"; code: string; message: string; sql: string | null; gate: string | null };

export type AskBoxProps = {
  /** The site has no model configured: render the box inert. Every string stays in the DOM (the
   *  copy is pinned), nothing can be submitted, and the page above says why. */
  offline?: boolean;
  /** Replays a recorded stream instead of calling /api/ask (fixture-driven rendering, §9 WP-6). */
  replay?: (question: string) => AsyncIterable<AskEvent>;
};

export default function AskBox({ replay, offline = false }: AskBoxProps): React.JSX.Element {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [plan, setPlan] = useState<AskPlanEvent | null>(null);
  const [result, setResult] = useState<AskResultEvent | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const busy = phase.k === "running";
  const startedAt = phase.k === "running" ? phase.startedAt : null;
  const abortRef = useRef<AbortController | null>(null);

  // The elapsed counter of §8.3: seconds ticking against the 4 s cap.
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, [startedAt]);

  const apply = useCallback((e: AskEvent) => {
    if (e.type === "state") {
      setPhase((p) => (p.k === "running" ? { ...p, state: e.state } : p));
    } else if (e.type === "plan") {
      setPlan(e);
      setPhase({ k: "answer" });
    } else if (e.type === "result") {
      setResult(e);
      setPhase({ k: "answer" });
    } else if (e.type === "clarify") {
      setPhase({ k: "clarify", clarification: e.clarification, options: e.options, method: e.method });
    } else if (e.type === "out_of_scope") {
      setPhase({ k: "out_of_scope", reason: e.reason });
    } else if (e.type === "error") {
      setPhase({ k: "failed", code: e.code, message: e.message, sql: e.sql, gate: e.gate });
    }
  }, []);

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (q.length < 3 || busy) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setAsked(q);
      setQuestion(q);
      setPlan(null);
      setResult(null);
      setElapsed(0);
      setPhase({ k: "running", state: "writing", startedAt: Date.now() });

      if (replay) {
        for await (const e of replay(q)) apply(e);
        return;
      }
      try {
        if (offline) return;
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q }),
          signal: ctrl.signal,
        });
        const header = res.headers.get("x-ask-remaining");
        if (header !== null && /^\d+$/.test(header)) setRemaining(Number(header));
        if (!res.ok || !res.body) {
          // §5.3's rejections are JSON, not SSE; the code selects the copy in AskFailure.
          let body: AskRejection = { code: "unknown" };
          try {
            body = (await res.json()) as AskRejection;
          } catch {
            /* a proxy error page: fall through to the generic copy */
          }
          setPhase({
            k: "failed",
            code: typeof body.code === "string" ? body.code : "unknown",
            message: "",
            sql: null,
            gate: null,
          });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const state = newSseState();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const e of parseSseChunk(state, decoder.decode(value, { stream: true }))) apply(e);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setPhase({ k: "failed", code: "connection", message: "", sql: null, gate: null });
      }
    },
    [apply, busy, offline, replay],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  // §4.8 — the live region. It is ALWAYS in the DOM (a `role="status"` node inserted at the same
  // moment as its text is not reliably announced), it is visually hidden, and it names the parts
  // of the answer that are on screen but collapsed rather than pretending they are not there.
  const announcement = askAnnouncement(
    phase.k === "running"
      ? { kind: "running", question: asked ?? question, stateTitle: askProgressTitle(phase.state) }
      : phase.k === "answer" && plan
        ? {
            kind: "answer",
            headline: plan.headline,
            rowCount: result ? result.rows.length : null,
            hasCaveat: Boolean(plan.caveat),
          }
        : phase.k === "clarify"
          ? { kind: "clarify", clarification: phase.clarification }
          : phase.k === "out_of_scope"
            ? { kind: "out_of_scope", reason: phase.reason }
            : phase.k === "failed"
              ? { kind: "failed" }
              : { kind: "idle" },
  );

  return (
    <div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="ask-question" className="sr-only">
          Ask a question about this database
        </label>
        <input
          id="ask-question"
          name="question"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          // Enter submits. A single-input form has implicit submission in principle, but it
          // did not fire here (verified in the browser: the question stayed in the box and
          // nothing was asked), and Enter is how a fan sends a question — waiting for them to
          // find the button is a dead end, not a nudge. Guarded the same way the button is.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (busy || question.trim().length < 3) return;
            void ask(question);
          }}
          maxLength={300}
          autoComplete="off"
          placeholder="which drivers out-qualified a teammate most in 2025?"
          // §4.1/§4.7 — a visible focus ring (the old `focus:outline-none` left keyboard users
          // with nothing) and a 44 px tall target.
          className="min-h-[44px] w-full rounded-lg border border-grid bg-surface/60 px-3 py-2 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-xs text-muted">
            Claude writes one read-only SQL query and we run it. The query is always shown.
          </p>
          <button
            type="submit"
            disabled={offline || busy || question.trim().length < 3}
            className="ml-auto min-h-[44px] rounded-lg border border-accent px-4 py-1.5 text-sm font-medium text-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={offline || busy}
            onClick={() => void ask(ex)}
            className="inline-flex min-h-[44px] items-center rounded-full border border-grid px-3 py-0.5 hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            &ldquo;{ex}&rdquo;
          </button>
        ))}
        {remaining !== null ? (
          <span className="ml-auto tnum text-accent">
            {remaining} of {SESSION_QUESTION_LIMIT} questions left today
          </span>
        ) : null}
      </div>

      {asked !== null ? (
        <h2 className="mt-8 text-base font-semibold tracking-tight text-fg">{asked}</h2>
      ) : null}

      {phase.k === "running" ? (
        <div className="mt-3">
          <AskProgress state={phase.state} elapsedMs={elapsed} />
        </div>
      ) : null}
      {phase.k === "answer" && plan ? <AskResult plan={plan} result={result} /> : null}
      {phase.k === "clarify" ? (
        <AskClarify
          clarification={phase.clarification}
          options={phase.options}
          method={phase.method}
          onPick={(q) => void ask(q)}
        />
      ) : null}
      {phase.k === "out_of_scope" ? <AskOutOfScope reason={phase.reason} /> : null}
      {phase.k === "failed" ? (
        plan ? (
          <AskResult
            plan={plan}
            result={null}
            error={{ code: phase.code, message: phase.message, gate: phase.gate }}
          />
        ) : (
          <div className="mt-6">
            <AskFailure code={phase.code} detail={phase.message} sql={phase.sql} gate={phase.gate} />
          </div>
        )
      ) : null}
    </div>
  );
}
