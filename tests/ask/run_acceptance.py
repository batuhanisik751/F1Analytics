#!/usr/bin/env python3
"""The MODE 3 ask-box acceptance harness (spec docs/MODE3_SPEC.md 3.8, WP-9).

Runs the questions in tests/ask/questions.yaml through the REAL request path -
web/lib/ask/pipeline.ts, the real validator, the real ask role, the real database - and
scores each answer against the assertions in the catalogue.

Two things this harness deliberately does NOT do:

  * it never asks a model to judge an answer. Every assertion is structural (which views the
    validated SQL touched, which gate fired, whether a row exists, whether the caveat names
    the thing the schema document says it must name). The one genuinely subjective column,
    `hand_grade`, is printed for a human and never scored;
  * it never edits a project file to sweep the model matrix. ASK_MODEL / ASK_EFFORT live in
    web/lib/ask/anthropic.ts; for any (model, effort) other than those constants the harness
    supplies its own `callModel` to `runAsk`, built from the SAME exported systemBlocks(),
    ASK_RESULT_SCHEMA, askResultSchema, estimateCostUsd and toAskApiError. The wire shape is
    the shipped one with two constants substituted.

Usage
  python3 tests/ask/run_acceptance.py --check-only            # no key, no database
  python3 tests/ask/run_acceptance.py                         # live, shipped model constants
  python3 tests/ask/run_acceptance.py --matrix                # the 9.4 item 4 sweep
  python3 tests/ask/run_acceptance.py --model claude-opus-5 --effort high --ids Q9,Q10

Environment
  ANTHROPIC_API_KEY   required for every live run. Never read from a file, never printed.
  ASK_DATABASE_URL    the f1_ask DSN. Defaults to the Makefile's local-dev form.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("pyyaml is missing: use the project venv (.venv/bin/python)")

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
CATALOGUE = ROOT / "tests" / "ask" / "questions.yaml"
ASK_OBJECTS = WEB / "lib" / "ask" / "ask-objects.json"
DEFAULT_OUT = ROOT / "output" / "ask_eval"

MODELS = ("claude-sonnet-5", "claude-opus-5")
EFFORTS = ("low", "medium", "high", "xhigh", "max")

OUTCOMES = {
    "answered", "empty", "clarify", "out_of_scope", "rejected",
    "too_expensive", "timeout", "api_error", "limit", "cached",
}
INTENTS = {"query", "clarify", "out_of_scope"}
RENDERS = {"table", "bar", "line", "scatter", "single"}

KNOWN_KEYS = {
    "id", "tier", "question", "why", "expect_intent", "expect_outcome",
    "must_touch_any", "must_touch_all", "must_not_touch", "sql_must_match",
    "sql_must_not_match", "caveat_all", "render_any", "require_rows",
    "must_not_execute", "expect_gate_any", "hand_grade",
}


def ask_views() -> set[str]:
    return set(json.loads(ASK_OBJECTS.read_text()))


def default_dsn() -> str:
    dsn = os.environ.get("ASK_DATABASE_URL")
    if dsn:
        return dsn
    pw = os.environ.get("ASK_PASSWORD", "f1_ask_local_dev")  # the Makefile's local-dev default
    return f"postgres://f1_ask:{pw}@localhost:5432/f1"


# --------------------------------------------------------------------------- catalogue


@dataclass
class Entry:
    id: str
    tier: str
    question: str
    raw: dict

    def get(self, key, default=None):
        return self.raw.get(key, default)


def load_catalogue(path: Path = CATALOGUE) -> list[Entry]:
    doc = yaml.safe_load(path.read_text())
    if not isinstance(doc, dict) or "entries" not in doc:
        raise ValueError(f"{path}: expected a mapping with an `entries` list")
    return [Entry(e["id"], e.get("tier", "extended"), e["question"], e) for e in doc["entries"]]


def check_catalogue(entries: list[Entry]) -> list[str]:
    """Static validation - runs with no key, no network and no database.

    Everything checkable about the catalogue without spending a token is checked here, so a
    typo in a view name fails in a second rather than after 48 model calls.
    """
    problems: list[str] = []
    views = ask_views()
    seen: set[str] = set()
    for e in entries:
        where = f"{e.id}"
        if e.id in seen:
            problems.append(f"{where}: duplicate id")
        seen.add(e.id)
        if e.tier not in ("standing", "extended"):
            problems.append(f"{where}: tier must be standing|extended, got {e.tier!r}")
        if not e.question.strip():
            problems.append(f"{where}: empty question")
        if not e.get("why"):
            problems.append(f"{where}: no `why` - an assertion nobody can explain is noise")
        for key in e.raw:
            if key not in KNOWN_KEYS:
                problems.append(f"{where}: unknown key {key!r}")
        for key in ("must_touch_any", "must_touch_all", "must_not_touch"):
            for v in e.get(key, []) or []:
                if v not in views:
                    problems.append(f"{where}.{key}: {v} is not one of the 57 ask views")
        for v in e.get("expect_intent", []) or []:
            if v not in INTENTS:
                problems.append(f"{where}.expect_intent: unknown intent {v!r}")
        for v in e.get("expect_outcome", []) or []:
            if v not in OUTCOMES:
                problems.append(f"{where}.expect_outcome: unknown outcome {v!r}")
        for v in e.get("render_any", []) or []:
            if v not in RENDERS:
                problems.append(f"{where}.render_any: unknown render kind {v!r}")
        for key in ("sql_must_match", "sql_must_not_match"):
            for rule in e.get(key, []) or []:
                if not isinstance(rule, dict) or "pattern" not in rule or "note" not in rule:
                    problems.append(f"{where}.{key}: each rule needs {{pattern, note}}")
                    continue
                try:
                    re.compile(rule["pattern"], re.I)
                except re.error as err:
                    problems.append(f"{where}.{key}: bad regex {rule['pattern']!r}: {err}")
        for group in e.get("caveat_all", []) or []:
            if not isinstance(group, list) or not group:
                problems.append(f"{where}.caveat_all: each entry must be a non-empty synonym list")
        if e.get("must_not_execute") and e.get("require_rows"):
            problems.append(f"{where}: must_not_execute and require_rows contradict each other")
    standing = [e for e in entries if e.tier == "standing"]
    if len(standing) != 12:
        problems.append(f"3.8 names twelve standing questions; the catalogue has {len(standing)}")
    return problems


# --------------------------------------------------------------------------- the driver
#
# Written to a temp file at run time and executed with `npx tsx` from web/. It is NOT a
# project file: WP-9 owns two files and this harness creates nothing inside web/.

DRIVER_TS = r'''
import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  ASK_MODEL, ASK_EFFORT, ASK_RESULT_SCHEMA, askResultSchema, estimateCostUsd, toAskApiError,
  askClient, AskApiError,
  type AskModelCall, type AskRetryTurn, type AskUsage,
} from "@WEB@/lib/ask/anthropic.ts";
import { systemBlocks } from "@WEB@/lib/ask/prompt.ts";
import { normaliseQuestion } from "@WEB@/lib/ask/prompt.ts";
import { MAX_OUTPUT_TOKENS } from "@WEB@/lib/ask/limits.ts";
import { runAsk, memoryAskStore, type AskEvent } from "@WEB@/lib/ask/pipeline.ts";

type Job = { model: string; effort: string; questions: { id: string; question: string }[] };
const job: Job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outPath = process.argv[3];

/**
 * The shipped call with two constants substituted (3.3's wire shape, unchanged otherwise).
 * Used ONLY when the requested pair differs from the constants in anthropic.ts, so an
 * ordinary run exercises the real `callAskModel` byte for byte.
 */
function overrideCall(model: string, effort: string) {
  return async function callModelAt(
    question: string,
    retry?: AskRetryTurn,
  ): Promise<AskModelCall> {
    const anthropic: Anthropic = askClient();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: question }] },
    ];
    if (retry) {
      messages.push({ role: "assistant", content: [{ type: "text", text: JSON.stringify(retry.priorOutput) }] });
      messages.push({ role: "user", content: [{ type: "text",
        text: `That query was rejected: ${retry.rejection} Only the views in the schema document are readable. Rewrite the query, or set intent to out_of_scope if the data is not available.` }] });
    }
    let message: Anthropic.Message;
    try {
      message = await anthropic.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: "adaptive" },
        output_config: {
          effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
          format: { type: "json_schema", schema: ASK_RESULT_SCHEMA as unknown as Record<string, unknown> },
        },
        system: systemBlocks() as unknown as Anthropic.TextBlockParam[],
        messages,
      });
    } catch (err) {
      throw toAskApiError(err);
    }
    const usage: AskUsage = {
      model: message.model ?? model,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      estimatedCostUsd: 0,
    };
    usage.estimatedCostUsd = estimateCostUsd(usage);
    const raw = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw); }
    catch { throw new AskApiError("schema", `model output was not JSON (${raw.length} chars)`); }
    const parsed = askResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AskApiError("schema", `output did not match ASK_RESULT_SCHEMA: ${parsed.error.issues.slice(0,3).map((i) => i.path.join(".") || "(root)").join("; ")}`);
    }
    return { result: parsed.data, usage, stopReason: message.stop_reason ?? null };
  };
}
'''

DRIVER_TS += r'''
async function runOne(q: { id: string; question: string }) {
  const events: AskEvent[] = [];
  const store = memoryAskStore();
  const useOverride = job.model !== ASK_MODEL || job.effort !== ASK_EFFORT;
  const started = Date.now();
  try {
    const { outcome, log } = await runAsk(
      {
        question: q.question,
        questionNorm: normaliseQuestion(q.question),
        sessionCookie: `acceptance-${q.id}`,
        ipHash: "acceptance",
      },
      {
        store,
        emit: (e) => events.push(e),
        ...(useOverride ? { callModel: overrideCall(job.model, job.effort) } : {}),
      },
    );
    const plan = events.find((e) => e.type === "plan") as Extract<AskEvent, { type: "plan" }> | undefined;
    const result = events.find((e) => e.type === "result") as Extract<AskEvent, { type: "result" }> | undefined;
    const clarify = events.find((e) => e.type === "clarify") as Extract<AskEvent, { type: "clarify" }> | undefined;
    const oos = events.find((e) => e.type === "out_of_scope") as Extract<AskEvent, { type: "out_of_scope" }> | undefined;
    const err = events.find((e) => e.type === "error") as Extract<AskEvent, { type: "error" }> | undefined;
    return {
      id: q.id,
      ok: true,
      outcome,
      intent: log.intent,
      sql_generated: log.sqlGenerated,
      sql_executed: log.sqlExecuted,
      validator_verdict: log.validatorVerdict,
      gate: err?.gate ?? null,
      error_code: err?.code ?? null,
      error_message: err?.message ?? null,
      retry_count: log.retryCount,
      touched_views: log.touchedViews,
      flags: log.flags,
      row_count: log.rowCount,
      truncated: log.truncated,
      render_kind: log.renderKind,
      max_plan_cost: log.maxPlanCost,
      headline: plan?.headline ?? null,
      method: plan?.method ?? clarify?.method ?? null,
      caveat: plan?.caveat ?? null,
      method_line: plan?.methodLine ?? null,
      clarification: clarify?.clarification ?? null,
      options: clarify?.options ?? [],
      reason: oos?.reason ?? null,
      fields: result?.fields ?? [],
      sample_rows: (result?.rows ?? []).slice(0, 3),
      model: log.model,
      input_tokens: log.inputTokens,
      output_tokens: log.outputTokens,
      cache_read_input_tokens: log.cacheReadInputTokens,
      cache_creation_input_tokens: log.cacheCreationInputTokens,
      estimated_cost_usd: log.estimatedCostUsd,
      duration_ms: log.durationMs,
    };
  } catch (e) {
    return {
      id: q.id, ok: false, outcome: "harness_error",
      error_message: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - started,
    };
  }
}

// No top-level await: tsx transforms a plain .ts under CJS semantics and TLA fails there.
async function main() {
  const out: unknown[] = [];
  for (const q of job.questions) {
    const row = await runOne(q);
    out.push(row);
    process.stderr.write(`  ${q.id} -> ${(row as { outcome: string }).outcome}\n`);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.exit(0);
}
main().catch((e) => {
  process.stderr.write(`driver: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
'''


def run_driver(entries: list[Entry], model: str, effort: str, dsn: str, timeout_s: int) -> dict:
    """Execute the catalogue through the real pipeline. Returns {id: result}."""
    src = DRIVER_TS.replace("@WEB@", str(WEB))
    with tempfile.TemporaryDirectory(prefix="ask-acceptance-") as tmp:
        tmpd = Path(tmp)
        driver = tmpd / "driver.mts"
        job = tmpd / "job.json"
        out = tmpd / "out.json"
        driver.write_text(src)
        job.write_text(json.dumps({
            "model": model, "effort": effort,
            "questions": [{"id": e.id, "question": e.question} for e in entries],
        }))
        env = dict(os.environ)
        env["ASK_DATABASE_URL"] = dsn
        env.setdefault("ASK_IP_SALT", "acceptance-suite")
        proc = subprocess.run(
            ["npx", "tsx", "--tsconfig", str(WEB / "tsconfig.json"), str(driver),
             str(job), str(out)],
            cwd=str(WEB), env=env, timeout=timeout_s,
            stdout=subprocess.PIPE, stderr=None, text=True,
        )
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError(
                f"driver failed (exit {proc.returncode}); stdout tail:\n{(proc.stdout or '')[-2000:]}"
            )
        return {r["id"]: r for r in json.loads(out.read_text())}


# --------------------------------------------------------------------------- scoring


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class Score:
    id: str
    tier: str
    checks: list[Check] = field(default_factory=list)
    result: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


def _views(result: dict) -> list[str]:
    return [v.lower() for v in (result.get("touched_views") or [])]


def score_entry(e: Entry, r: dict) -> Score:
    s = Score(e.id, e.tier, result=r)
    add = s.checks.append
    if not r.get("ok", False):
        add(Check("harness", False, r.get("error_message", "driver error")))
        return s

    outcome = r.get("outcome")
    intent = r.get("intent")
    sql = (r.get("sql_executed") or r.get("sql_generated") or "")
    prose = " ".join(str(r.get(k) or "") for k in ("caveat", "method", "reason", "clarification")).lower()
    views = _views(r)

    if e.get("expect_outcome"):
        add(Check("outcome", outcome in e.get("expect_outcome"),
                  f"{outcome} not in {e.get('expect_outcome')}"))
    if e.get("expect_intent"):
        add(Check("intent", intent in e.get("expect_intent"),
                  f"{intent} not in {e.get('expect_intent')}"))
    if e.get("must_not_execute"):
        add(Check("must_not_execute", not r.get("sql_executed"),
                  "SQL reached Postgres and must not have"))

    # A refusal or a clarification is a legitimate ending wherever the entry allows it, and
    # every assertion about SQL, views, rows and rendering is then vacuous: there is no query.
    # Scoring them anyway would mark the most honest answer the model can give as a failure.
    answered_path = outcome in ("answered", "empty", "cached")
    if not answered_path:
        if e.get("expect_gate_any") and outcome == "rejected":
            gate = r.get("gate") or ""
            add(Check("gate", any(gate.startswith(g) for g in e.get("expect_gate_any")),
                      f"gate {gate!r} not in {e.get('expect_gate_any')}"))
        return s

    for v in e.get("must_touch_all", []) or []:
        add(Check(f"touch:{v}", v.lower() in views, f"touched {views}"))
    any_req = e.get("must_touch_any") or []
    if any_req:
        add(Check("touch_any", any(v.lower() in views for v in any_req),
                  f"touched {views}, wanted one of {any_req}"))
    for v in e.get("must_not_touch", []) or []:
        add(Check(f"not_touch:{v}", v.lower() not in views, f"touched {views}"))

    for rule in e.get("sql_must_match", []) or []:
        add(Check(f"sql~{rule['pattern']}", bool(re.search(rule["pattern"], sql, re.I)),
                  rule["note"]))
    for rule in e.get("sql_must_not_match", []) or []:
        add(Check(f"sql!~{rule['pattern']}", not re.search(rule["pattern"], sql, re.I),
                  rule["note"]))
    for group in e.get("caveat_all", []) or []:
        add(Check("caveat:" + "|".join(group)[:40],
                  any(w.lower() in prose for w in group),
                  f"none of {group} appears in caveat/method"))
    if e.get("render_any"):
        add(Check("render", r.get("render_kind") in e.get("render_any"),
                  f"{r.get('render_kind')} not in {e.get('render_any')}"))
    if e.get("require_rows"):
        add(Check("rows", (r.get("row_count") or 0) > 0,
                  f"row_count={r.get('row_count')}; an empty table is not an answer"))
    return s


# --------------------------------------------------------------------------- reporting


def summarise(scores: list[Score], model: str, effort: str, wall_s: float) -> dict:
    standing = [s for s in scores if s.tier == "standing"]
    cost = sum(float(s.result.get("estimated_cost_usd") or 0) for s in scores)
    retries = sum(int(s.result.get("retry_count") or 0) for s in scores)
    first_try_valid = sum(
        1 for s in scores
        if s.result.get("validator_verdict") == "accepted" and not s.result.get("retry_count")
    )
    post_retry_valid = sum(1 for s in scores if s.result.get("validator_verdict") == "accepted")
    cache_reads = sum(int(s.result.get("cache_read_input_tokens") or 0) for s in scores)
    return {
        "model": model,
        "effort": effort,
        "ran": len(scores),
        "standing_total": len(standing),
        "standing_passed": sum(1 for s in standing if s.passed),
        "standing_gate": all(s.passed for s in standing) and len(standing) == 12,
        "extended_total": len(scores) - len(standing),
        "extended_passed": sum(1 for s in scores if s.tier != "standing" and s.passed),
        "first_try_valid": first_try_valid,
        "post_retry_valid": post_retry_valid,
        "retries": retries,
        "cache_read_input_tokens": cache_reads,
        "estimated_cost_usd": round(cost, 6),
        "cost_per_question_usd": round(cost / max(len(scores), 1), 6),
        "wall_seconds": round(wall_s, 1),
        "failures": [
            {"id": s.id, "checks": [c.name for c in s.checks if not c.passed]}
            for s in scores if not s.passed
        ],
    }


def write_report(out_dir: Path, summary: dict, scores: list[Score], entries: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S")
    slug = f"{summary['model']}-{summary['effort']}-{stamp}"
    payload = {
        "summary": summary,
        "runs": [
            {
                "id": s.id, "tier": s.tier, "passed": s.passed,
                "question": entries[s.id].question,
                "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in s.checks],
                "hand_grade": entries[s.id].get("hand_grade"),
                "result": s.result,
            }
            for s in scores
        ],
    }
    path = out_dir / f"{slug}.json"
    path.write_text(json.dumps(payload, indent=2, default=str))
    (out_dir / "latest.json").write_text(json.dumps(payload, indent=2, default=str))
    return path


def print_table(scores: list[Score], summary: dict) -> None:
    print(f"\n  {summary['model']} / effort={summary['effort']}")
    print(f"  {'id':<5} {'tier':<9} {'outcome':<13} {'pass':<5} failing checks")
    for s in scores:
        bad = ", ".join(c.name for c in s.checks if not c.passed) or "-"
        print(f"  {s.id:<5} {s.tier:<9} {str(s.result.get('outcome')):<13} "
              f"{'PASS' if s.passed else 'FAIL':<5} {bad[:70]}")
    print(f"  standing gate: {summary['standing_passed']}/{summary['standing_total']}"
          f"  extended: {summary['extended_passed']}/{summary['extended_total']}"
          f"  cost ${summary['estimated_cost_usd']:.4f}"
          f"  cache_read {summary['cache_read_input_tokens']} tok")


# --------------------------------------------------------------------------- cli


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="MODE 3 ask-box acceptance suite (spec 3.8)")
    ap.add_argument("--check-only", action="store_true",
                    help="validate the catalogue only: no key, no network, no database")
    ap.add_argument("--model", action="append", choices=list(MODELS), default=None)
    ap.add_argument("--effort", action="append", choices=list(EFFORTS), default=None)
    ap.add_argument("--matrix", action="store_true",
                    help="9.4 item 4: both models at medium and high effort")
    ap.add_argument("--tier", choices=["standing", "extended", "all"], default="standing")
    ap.add_argument("--ids", default=None, help="comma-separated subset, e.g. Q9,Q10,R1")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args(argv)

    entries = load_catalogue()
    problems = check_catalogue(entries)
    for p in problems:
        print(f"catalogue: {p}", file=sys.stderr)
    if problems:
        return 2
    print(f"catalogue OK: {len(entries)} questions "
          f"({sum(1 for e in entries if e.tier == 'standing')} standing, "
          f"{sum(1 for e in entries if e.tier != 'standing')} extended)")
    if args.check_only:
        return 0

    if args.ids:
        wanted = {x.strip() for x in args.ids.split(",") if x.strip()}
        selected = [e for e in entries if e.id in wanted]
        missing = wanted - {e.id for e in selected}
        if missing:
            print(f"unknown ids: {sorted(missing)}", file=sys.stderr)
            return 2
    elif args.tier == "all":
        selected = entries
    else:
        selected = [e for e in entries if e.tier == args.tier]

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set: a live run is impossible.\n"
              "Set it in the environment (never in a file this repo tracks) and re-run, or "
              "use --check-only.", file=sys.stderr)
        return 3

    if args.matrix:
        combos = [(m, ef) for m in MODELS for ef in ("medium", "high")]
    else:
        combos = [(m, ef) for m in (args.model or [None]) for ef in (args.effort or [None])]

    dsn = args.dsn or default_dsn()
    out_dir = Path(args.out)
    failed = False
    for model, effort in combos:
        # None means "whatever anthropic.ts ships"; the driver then uses the real callAskModel.
        m = model or _shipped("ASK_MODEL")
        ef = effort or _shipped("ASK_EFFORT")
        print(f"\nrunning {len(selected)} questions at {m} / {ef} ...", file=sys.stderr)
        t0 = time.time()
        results = run_driver(selected, m, ef, dsn, args.timeout)
        scores = [score_entry(e, results.get(e.id, {"ok": False, "error_message": "no result"}))
                  for e in selected]
        summary = summarise(scores, m, ef, time.time() - t0)
        path = write_report(out_dir, summary, scores, {e.id: e for e in selected})
        print_table(scores, summary)
        print(f"  report: {path}")
        if args.tier in ("standing", "all") and not args.ids and not summary["standing_gate"]:
            failed = True
    return 1 if failed else 0


def _shipped(name: str) -> str:
    """Read ASK_MODEL / ASK_EFFORT out of web/lib/ask/anthropic.ts without importing it."""
    src = (WEB / "lib" / "ask" / "anthropic.ts").read_text()
    m = re.search(rf'export const {name}[^=]*=\s*"([^"]+)"', src)
    if not m:
        raise RuntimeError(f"could not read {name} from lib/ask/anthropic.ts")
    return m.group(1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
