// REVALIDATE_SPEC §6 — the hook's auth gate, asserted with no database and no Next cache.
//
// The spy is injected through `handle(req, deps)`; `revalidateTag` is never the real one here.
// The property under test: nothing but a ≥ 32-char secret AND an exact bearer match reaches the
// spy, and the token never appears in anything the route prints.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { handle } from "@/app/api/revalidate/route";

const SECRET = "0123456789abcdef0123456789abcdef"; // exactly 32 chars
const TOKEN_WRONG_SAME_LEN = "fedcba9876543210fedcba9876543210";

type Call = [string, { expire: number }];

function spy(impl?: () => void) {
  const calls: Call[] = [];
  const fn = (tag: string, opts: { expire: number }) => {
    calls.push([tag, opts]);
    impl?.();
  };
  return { fn, calls };
}

function post(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request("http://localhost:3000/api/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let captured: string[] = [];
const origError = console.error;
const origLog = console.log;
const origWarn = console.warn;
const originalSecret = process.env.REVALIDATE_SECRET;

beforeEach(() => {
  captured = [];
  const cap = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  console.error = cap;
  console.log = cap;
  console.warn = cap;
  process.env.REVALIDATE_SECRET = SECRET;
});

afterEach(() => {
  console.error = origError;
  console.log = origLog;
  console.warn = origWarn;
  if (originalSecret === undefined) delete process.env.REVALIDATE_SECRET;
  else process.env.REVALIDATE_SECRET = originalSecret;
});

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code?: string }).code ?? "";
}

test("secret unset → 503 off, spy not called", async () => {
  delete process.env.REVALIDATE_SECRET;
  const s = spy();
  const res = await handle(post(bearer(SECRET)), { revalidateTag: s.fn });
  assert.equal(res.status, 503);
  assert.equal(await codeOf(res), "off");
  assert.equal(s.calls.length, 0);
});

test("31-char secret → 503 off, even with a matching bearer", async () => {
  const short = SECRET.slice(0, 31);
  process.env.REVALIDATE_SECRET = short;
  const s = spy();
  const res = await handle(post(bearer(short)), { revalidateTag: s.fn });
  assert.equal(res.status, 503);
  assert.equal(await codeOf(res), "off");
  assert.equal(s.calls.length, 0);
});

for (const [label, headers] of [
  ["no header", {}],
  ["Basic scheme", { authorization: "Basic x" }],
  ["wrong token", bearer("nope")],
  ["wrong token of equal length", bearer(TOKEN_WRONG_SAME_LEN)],
  ["bare token without the scheme", { authorization: SECRET }],
] as const) {
  test(`${label} → 401 unauthorized, spy not called`, async () => {
    const s = spy();
    const res = await handle(post(headers), { revalidateTag: s.fn });
    assert.equal(res.status, 401);
    assert.equal(await codeOf(res), "unauthorized");
    assert.equal(s.calls.length, 0);
  });
}

test("correct bearer → 200 and the spy expires the data tag once", async () => {
  const s = spy();
  const res = await handle(post(bearer(SECRET), { release_id: 42 }), { revalidateTag: s.fn });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.tag, "data");
  assert.equal(body.expire, 0);
  assert.equal(body.release_id, 42);
  assert.equal(typeof body.at, "string");
  assert.ok(!Number.isNaN(Date.parse(body.at as string)));
  assert.deepEqual(s.calls, [["data", { expire: 0 }]]);
});

test("no body / non-numeric release_id → 200 with release_id null", async () => {
  const s = spy();
  const res = await handle(post(bearer(SECRET)), { revalidateTag: s.fn });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { release_id: unknown }).release_id, null);
  const res2 = await handle(post(bearer(SECRET), { release_id: "x" }), { revalidateTag: s.fn });
  assert.equal(((await res2.json()) as { release_id: unknown }).release_id, null);
  assert.equal(s.calls.length, 2);
});

test("spy throwing → 500 failed, and the log line carries the message only", async () => {
  const s = spy(() => {
    throw new Error("tags manifest unavailable");
  });
  const res = await handle(post(bearer(SECRET)), { revalidateTag: s.fn });
  assert.equal(res.status, 500);
  assert.equal(await codeOf(res), "failed");
  assert.ok(captured.some((l) => l.includes("revalidate:") && l.includes("tags manifest unavailable")));
});

test("captured console output never contains the token, on any path", async () => {
  const paths: Array<[Request, () => void]> = [
    [post(bearer(SECRET)), () => {}],
    [post(bearer("nope")), () => {}],
    [post(bearer(SECRET)), () => { throw new Error(`boom`); }],
  ];
  for (const [req, impl] of paths) {
    const res = await handle(req, { revalidateTag: spy(impl).fn });
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "response body echoes the secret");
  }
  const all = captured.join("\n");
  assert.ok(!all.includes(SECRET), "console output contains the token");
  assert.ok(!all.includes("Bearer"), "console output contains the header");
});
