// REVALIDATE_SPEC §6 — the wrap is a pass-through everywhere except production, and the
// rollback switch (DATA_CACHE=0) makes production a pass-through too. `ON` is fixed at module
// load, so each environment is checked in a child process that loads lib/cache.ts fresh.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const CACHE_TS = path.resolve(__dirname, "cache.ts");

/** Loads lib/cache.ts under `env` in a fresh process and prints whether cached() returned its input. */
function passThroughUnder(env: Record<string, string>): boolean {
  const script =
    // The module may load as CommonJS, in which case its exports sit under `default`.
    `import("${CACHE_TS}").then((m) => { const cached = m.cached ?? m.default.cached;` +
    ` const fn = async () => 1; process.stdout.write(String(cached("t.fn", fn) === fn)); })`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return out.trim() === "true";
}

test("cached() returns the same function under NODE_ENV=test", () => {
  assert.equal(passThroughUnder({ NODE_ENV: "test", DATA_CACHE: "" }), true);
});

test("cached() returns the same function under DATA_CACHE=0, even in production", () => {
  assert.equal(passThroughUnder({ NODE_ENV: "production", DATA_CACHE: "0" }), true);
});

test("DATA_TTL_S is a positive integer and DATA_TAG is the one tag the hook expires", async () => {
  const { DATA_TAG, DATA_TTL_S } = await import("@/lib/cache");
  assert.equal(Number.isInteger(DATA_TTL_S), true);
  assert.ok(DATA_TTL_S > 0);
  assert.equal(DATA_TAG, "data");
});
