// MODE3_SPEC §3.3 / §3.7 — the Anthropic client and THE ONLY MODEL CALL IN THIS PROJECT'S WEB APP.
//
// §0.2's boundary sentence: exactly one file in `web/` may hold a model secret and may call a
// model at request time. This file holds the secret; `app/api/ask/route.ts` is the only importer.
// Nothing here ever returns the key, echoes it into an error, or writes it anywhere.
//
// §3.2 is the shape of this module and the reason it has no second entry point: ONE call per
// question produces SQL + a claim-free headline + method + caveat + a render hint, ALL BEFORE
// ANY ROW EXISTS, and then the pipeline stops calling models. There is deliberately no
// `summarise(rows)` function here and there must never be one.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MAX_OUTPUT_TOKENS } from "@/lib/ask/limits";
import { systemBlocks } from "@/lib/ask/prompt";

/** §0.3 decision 7 / §5.1. WP-9 is the ONLY package permitted to change these two constants. */
export const ASK_MODEL = "claude-sonnet-5";
export const ASK_EFFORT: "low" | "medium" | "high" | "xhigh" | "max" = "medium";

/** $/MTok, list price. Cache read is 0.1x input; a 1h cache write is 2.0x input (§2.4). */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * §3.7's error taxonomy, caught MOST-SPECIFIC-FIRST. A single broad catch retries a 400 forever
 * and never retries a 429, which is the failure this enum exists to prevent.
 */
export type AskApiCode =
  | "no_key" // ANTHROPIC_API_KEY unset — degrade to the §8.5 failure UI, never a 500
  | "auth" // 401
  | "bad_request" // 400 — our request shape is wrong; never retried
  | "rate_limit" // 429 — one retry after retry-after
  | "upstream" // >= 500
  | "connection" // network
  | "schema" // a 200 whose content did not parse as ASK_RESULT_SCHEMA
  | "unknown";

export class AskApiError extends Error {
  readonly code: AskApiCode;
  /** Populated from `retry-after` on a 429, in milliseconds. */
  readonly retryAfterMs?: number;
  constructor(code: AskApiCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "AskApiError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

let client: Anthropic | null = null;

/**
 * The lazily-built client. Reading the key at module scope would make an unset key a build-time
 * crash on a page that has nothing to do with the ask box; reading it here makes it §8.5 copy.
 */
export function askClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new AskApiError("no_key", "ANTHROPIC_API_KEY is not set");
  }
  client = new Anthropic({ apiKey, maxRetries: 1 });
  return client;
}

/** True when a key is present. Never returns the key, and never any prefix of it. */
export function askKeyPresent(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  return typeof k === "string" && k.trim() !== "";
}

// --- the structured output contract (§3.3) ----------------------------------
//
// Sent on the wire as `output_config.format.schema`. NOTE, measured against the pinned SDK:
// `JSONOutputFormat` in @anthropic-ai/sdk@0.125.0 declares exactly `{ type: 'json_schema';
// schema }` — there is no `name` and no `strict` field. §3.3 writes both; they are dropped here
// rather than sent as unknown keys. The schema itself is unchanged, `additionalProperties:
// false` plus a full `required` list does the same job, and the wire shape is the SDK's own.

export const ASK_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "sql",
    "headline",
    "method",
    "caveat",
    "render",
    "clarification",
    "options",
    "reason",
  ],
  properties: {
    intent: { type: "string", enum: ["query", "clarify", "out_of_scope"] },
    sql: { type: ["string", "null"], maxLength: 4000 },
    headline: { type: "string", maxLength: 90 },
    method: { type: "string", maxLength: 240 },
    caveat: { type: ["string", "null"], maxLength: 240 },
    render: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "label_col", "value_cols", "series_col", "unit", "sort"],
      properties: {
        kind: { type: "string", enum: ["table", "bar", "line", "scatter", "single"] },
        label_col: { type: ["string", "null"] },
        value_cols: { type: "array", items: { type: "string" }, maxItems: 4 },
        series_col: { type: ["string", "null"] },
        unit: {
          type: "string",
          enum: ["s", "s_per_lap", "pct", "count", "position", "points", "none"],
        },
        sort: { type: "string", enum: ["as_written", "value_desc", "value_asc"] },
      },
    },
    clarification: { type: ["string", "null"], maxLength: 160 },
    options: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 4 },
    reason: { type: ["string", "null"], maxLength: 240 },
  },
} as const;

/** The same contract as a zod schema — the thing that actually decides whether output is usable. */
export const renderHintSchema = z.object({
  kind: z.enum(["table", "bar", "line", "scatter", "single"]),
  label_col: z.string().nullable(),
  value_cols: z.array(z.string()).max(4),
  series_col: z.string().nullable(),
  unit: z.enum(["s", "s_per_lap", "pct", "count", "position", "points", "none"]),
  sort: z.enum(["as_written", "value_desc", "value_asc"]),
});

export const askResultSchema = z.object({
  intent: z.enum(["query", "clarify", "out_of_scope"]),
  sql: z.string().max(4000).nullable(),
  headline: z.string().max(90),
  method: z.string().max(240),
  caveat: z.string().max(240).nullable(),
  render: renderHintSchema.nullable(),
  clarification: z.string().max(160).nullable(),
  options: z.array(z.string().max(80)).max(4),
  reason: z.string().max(240).nullable(),
});

export type RenderHint = z.infer<typeof renderHintSchema>;
export type AskResult = z.infer<typeof askResultSchema>;

export type AskUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCostUsd: number;
};

export type AskModelCall = {
  result: AskResult;
  usage: AskUsage;
  /** `stop_reason` — `max_tokens` means a truncated SQL string, which §5.2 exists to prevent. */
  stopReason: string | null;
};

/** One prior (assistant output, rejection reason) pair — §3.5's single retry turn. */
export type AskRetryTurn = { priorOutput: AskResult; rejection: string };

/** §2.4's cost model, applied to the usage the API actually reported. */
export function estimateCostUsd(u: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): number {
  const price = PRICING[u.model] ?? PRICING["claude-sonnet-5"];
  const usd =
    (u.inputTokens * price.input +
      u.cacheReadInputTokens * price.input * CACHE_READ_MULTIPLIER +
      u.cacheCreationInputTokens * price.input * CACHE_WRITE_1H_MULTIPLIER +
      u.outputTokens * price.output) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6; // numeric(10,6) in ask_query_log
}

/**
 * §3.5's single retry turn, as `messages`. It lives in `messages` and not in `system` on
 * purpose: the cached prefix is untouched, so a retry costs a cache READ, not a cache write.
 */
function buildMessages(question: string, retry?: AskRetryTurn) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: question }] },
  ];
  if (retry) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(retry.priorOutput) }],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `That query was rejected: ${retry.rejection} ` +
            `Only the views in the schema document are readable. ` +
            `Rewrite the query, or set intent to out_of_scope if the data is not available.`,
        },
      ],
    });
  }
  return messages;
}

/** Concatenates every text block. Thinking blocks are not text blocks and are skipped. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * THE ONE MODEL CALL (§3.3). No tools (a tool array would sit in front of `system` in the cache
 * prefix and lengthen it for nothing); no assistant prefill (removed on Sonnet 5 / Opus 5,
 * returns 400); `thinking: {type:"adaptive"}` with NO budget_tokens (removed, 400s);
 * `max_tokens` never lowballed, because thinking bills against the same output budget and
 * hitting the cap truncates a half-written SQL string.
 */
export async function callAskModel(
  question: string,
  retry?: AskRetryTurn,
): Promise<AskModelCall> {
  const anthropic = askClient();
  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: ASK_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      output_config: {
        effort: ASK_EFFORT,
        format: { type: "json_schema", schema: ASK_RESULT_SCHEMA as unknown as Record<string, unknown> },
      },
      system: systemBlocks(),
      messages: buildMessages(question, retry),
    });
  } catch (err) {
    throw toAskApiError(err);
  }

  const usage: AskUsage = {
    model: message.model ?? ASK_MODEL,
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    estimatedCostUsd: 0,
  };
  usage.estimatedCostUsd = estimateCostUsd(usage);

  const raw = textOf(message);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new AskApiError(
      "schema",
      `model output was not JSON (stop_reason=${message.stop_reason ?? "?"}, ${raw.length} chars)`,
    );
  }
  const parsed = askResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AskApiError(
      "schema",
      `model output did not match ASK_RESULT_SCHEMA: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return { result: parsed.data, usage, stopReason: message.stop_reason ?? null };
}

/**
 * §3.7, most-specific-first. `instanceof` order is load-bearing: every one of these extends
 * `APIError`, so a single `APIStatusError` branch placed first would swallow 400 and 429 alike.
 * No message from the SDK reaches the fan — the route maps `code` to fixed copy (§8.5).
 */
export function toAskApiError(err: unknown): AskApiError {
  if (err instanceof AskApiError) return err;
  if (err instanceof Anthropic.BadRequestError) {
    return new AskApiError("bad_request", `400 from the API: ${err.message}`);
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AskApiError("auth", "401 from the API (the key is missing or not valid)");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AskApiError("auth", "403 from the API");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AskApiError("rate_limit", "429 from the API", retryAfterMsOf(err));
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AskApiError("connection", "could not reach the API");
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    if (status >= 500) return new AskApiError("upstream", `${status} from the API`);
    return new AskApiError("bad_request", `${status} from the API: ${err.message}`);
  }
  return new AskApiError("unknown", err instanceof Error ? err.message : String(err));
}

function retryAfterMsOf(err: { headers?: Headers }): number | undefined {
  const raw = err.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, 30) * 1000;
}

/**
 * §9.4 item 1: the real token count of the assembled system blocks, against the 9,600 estimate.
 * Not on the request path — it is a measurement helper, and it costs a (free) API round trip.
 */
export async function countSystemTokens(question = "x"): Promise<number> {
  const res = await askClient().messages.countTokens({
    model: ASK_MODEL,
    system: systemBlocks(),
    messages: [{ role: "user", content: [{ type: "text", text: question }] }],
  });
  return res.input_tokens;
}
