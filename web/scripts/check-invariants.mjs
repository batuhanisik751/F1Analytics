// MODE3_SPEC §9.3 WP-7 — the architectural boundary of §0.2, made into a build step.
//
// WP-10 NOTE ON OWNERSHIP: §9.3 assigns this file to WP-7, whose agent built the race-report UI
// instead, so the guard was never written. It is the permanent, machine-checked form of the one
// sentence the whole of Mode 3 rests on:
//
//   Exactly one file in `web/` may hold a model secret and may call a model at request time:
//   `web/app/api/ask/route.ts`. Every page in the app stays a Server Component reading
//   precomputed rows over the existing Drizzle pool on DATABASE_URL.
//
// A comment saying that decays. This fails the build.
//
// Run: npm run check:invariants   (exit 0 clean, 1 with one line per violation)
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "drizzle", "public"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Every source file under web/, as repo-relative POSIX paths. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(WEB).map((f) => ({
  path: relative(WEB, f).split(sep).join("/"),
  full: f,
}));
const sources = files.filter((f) => SOURCE_EXT.test(f.path));

const violations = [];
const fail = (rule, path, detail) => violations.push({ rule, path, detail });

/** `text` with block and line comments blanked, so a rule about IMPORTS never fires on prose. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (f) => readFileSync(f.full, "utf8");

// --- 1. the secret ----------------------------------------------------------------------
//
// Two separate checks, because they fail for different reasons. The NAME may appear only where
// §0.2 allows it; an actual key VALUE may appear nowhere at all, in any file, ever.
const KEY_NAME_ALLOWED = new Set([
  "app/api/ask/route.ts",
  "lib/ask/anthropic.ts",
  ".env.example",
  // This checker names the variable in order to look for it.
  "scripts/check-invariants.mjs",
  // Gitignored, local-only, and created empty by the integration pass. Listed rather than
  // silently skipped so that the allowlist stays the complete answer to "who may name it".
  ".env.local",
]);

for (const f of files) {
  if (f.path.endsWith(".env.example") || f.path.endsWith(".env.local") || SOURCE_EXT.test(f.path)) {
    const text = read(f);
    if (text.includes("ANTHROPIC_API_KEY") && !KEY_NAME_ALLOWED.has(f.path)) {
      fail("secret-name", f.path, "names ANTHROPIC_API_KEY outside the three files of §0.2");
    }
    // A real key, anywhere, including a test fixture or a committed .env — the failure mode
    // the allowlist above cannot catch, because it is about the value and not the name.
    if (/sk-ant-[A-Za-z0-9_-]{10,}/.test(text)) {
      fail("secret-value", f.path, "contains something shaped like a live Anthropic API key");
    }
  }
}

// --- 2/3. the two privileged pools ------------------------------------------------------
//
// `askPool` carries GENERATED SQL as the unprivileged f1_ask; `logPool` writes the query log as
// f1_ask_log. Neither may be reachable from a page: an import outside lib/ask/ is how a second
// caller of either appears without anyone deciding to add one.
//
// §8.2 permits the route itself to import askPool — it calls `assertAskIdentity()` so a
// half-provisioned deployment costs $0 instead of one model call before failing. §9 WP-7's
// wording ("outside lib/ask/") omits that; the route is allowed here and the deviation is
// recorded in §12.
const POOL_ALLOWED_OUTSIDE_LIB = new Set(["app/api/ask/route.ts"]);

for (const f of sources) {
  if (f.path.startsWith("lib/ask/")) continue;
  const text = stripComments(read(f));
  for (const mod of ["askPool", "execute", "logPool"]) {
    const re = new RegExp(`from\\s+["']@/lib/ask/${mod}["']`);
    if (!re.test(text)) continue;
    if (POOL_ALLOWED_OUTSIDE_LIB.has(f.path) && mod !== "logPool") continue;
    fail("pool-import", f.path, `imports lib/ask/${mod} from outside lib/ask/`);
  }
}

// --- 4. exactly two POST routes ---------------------------------------------------------
//
// REVALIDATE_SPEC §2: `app/api/revalidate/route.ts` is the nightly push's cache hook — bearer
// secret, no database, no model. It is the ONLY other POST; the ask route is still the only
// one that may hold a model secret, and rules 1-3 keep saying so.
const POST_ALLOWED = new Set(["app/api/ask/route.ts", "app/api/revalidate/route.ts"]);
for (const f of sources) {
  if (!f.path.startsWith("app/")) continue;
  if (POST_ALLOWED.has(f.path)) continue;
  if (/\.test\.tsx?$/.test(f.path)) continue;
  const text = stripComments(read(f));
  if (/export\s+(async\s+)?function\s+POST\b/.test(text) || /export\s+const\s+POST\b/.test(text)) {
    fail("second-post", f.path, "exports POST; /api/ask and /api/revalidate are the only routes in this app");
  }
}

// --- 5. the superuser pool never enters lib/ask/ ----------------------------------------
for (const f of sources) {
  if (!f.path.startsWith("lib/ask/")) continue;
  const text = stripComments(read(f));
  if (/from\s+["']@\/db\/client["']/.test(text)) {
    fail("client-in-ask", f.path, "imports db/client (the superuser f1 pool) inside lib/ask/");
  }
}

// --- 6. echarts has exactly one importer ------------------------------------------------
//
// Not a style rule. `EChart.tsx` owns the theme, the resize observer and the dispose path; a
// second importer is how two charts on one page stop looking like the same product.
//
// TYPE-ONLY IMPORTS ARE NOT IMPORTS. Sixteen chart components do `import type { EChartsOption }
// from "echarts"` to type the option object they hand to EChart.tsx; that is erased by the
// compiler, pulls no runtime code into the bundle, and is exactly the composition §3.4 asks
// for. Flagging it would train whoever hits it to disable the rule. Only a VALUE import counts.
for (const f of sources) {
  if (f.path === "components/charts/EChart.tsx") continue;
  const text = stripComments(read(f));
  // `[^;]*?` rather than `[\s\S]*?`: every import statement ends in a semicolon, so the clause
  // cannot run backwards into an earlier one. It may still span newlines, which multi-line
  // `import { … }` blocks need.
  for (const m of text.matchAll(/\bimport\s+([^;]*?)\s*from\s+["']echarts(\/[^"']*)?["']/g)) {
    const clause = m[1];
    if (/^\s*type\s/.test(clause)) continue; // import type { … } from "echarts"
    // `import { type A, type B } from "echarts"` — every named binding is a type.
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named && named[1].split(",").every((s) => s.trim() === "" || /^type\s/.test(s.trim()))) {
      continue;
    }
    fail("echarts-import", f.path, "value-imports echarts; only components/charts/EChart.tsx may");
  }
}

// --- 7. the committed prompt prefix hash ------------------------------------------------
//
// §2.4 — the two cached system blocks are a prompt-cache PREFIX. If schema-doc.txt or
// ASK_INSTRUCTIONS changes and the committed hash does not, the answer cache silently keeps
// serving answers written against the old picture of the database. This is the check that
// makes `make db-ask-gen` impossible to half-finish.
//
// Loaded in a child process: this file must stay dependency-free and runnable by plain `node`,
// and prompt.ts is TypeScript with a path alias.
import { spawnSync } from "node:child_process";

// A temp file inside web/, not `tsx -e`: the `@/…` path alias is resolved from tsconfig
// relative to the ENTRY FILE, and an `-e` script has no path to resolve against, so the import
// fails with ERR_MODULE_NOT_FOUND and the rule would report a mismatch it never measured.
const probePath = join(WEB, `.invariant-probe-${process.pid}.mts`);
writeFileSync(
  probePath,
  'import { promptPrefixSha256, PROMPT_PREFIX_SHA256 } from "@/lib/ask/prompt";\n' +
    'console.log(promptPrefixSha256() === PROMPT_PREFIX_SHA256 ? "MATCH" : ' +
    "`MISMATCH live=${promptPrefixSha256()} committed=${PROMPT_PREFIX_SHA256}`);\n",
);
let probe;
try {
  probe = spawnSync("npx", ["tsx", "--tsconfig", join(WEB, "tsconfig.json"), probePath], {
    cwd: WEB,
    encoding: "utf8",
  });
} finally {
  rmSync(probePath, { force: true });
}
const probeOut = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
if (probe.status !== 0) {
  fail("prompt-hash", "lib/ask/prompt.ts", `could not assemble the prefix: ${probeOut.slice(-300)}`);
} else if (!probeOut.includes("MATCH") || probeOut.includes("MISMATCH")) {
  fail(
    "prompt-hash",
    "lib/ask/prompt.ts",
    `${probeOut.split("\n").pop()} — re-run \`make db-ask-gen\`, paste the new hash into ` +
      "prompt.ts, then re-run `make ask-eval`",
  );
}

// --- 8. no tracked .env file other than .env.example -------------------------------------
//
// OPS_SPEC §4.3 — `.gitignore` says `.env*` + `!.env.example`, and a gitignore is advice:
// `git add -f`, a rename, or an ignore rule edited in a hurry all get past it. The index is
// the fact. Checked across the WHOLE repository (root `.env.remote` counts), not only web/.
// Intent-to-add entries (`git add -N`) are listed too, which is the point: the file is on
// its way in. No git at all is a failure, not a pass; a rule that cannot look must not say ok.
const REPO = join(WEB, "..");
const ls = spawnSync("git", ["-C", REPO, "ls-files", "--full-name"], { encoding: "utf8" });
if (ls.status !== 0) {
  fail("tracked-env", ".", `git ls-files failed, so the rule could not run: ${(ls.stderr ?? "").trim()}`);
} else {
  for (const path of ls.stdout.split("\n").filter(Boolean)) {
    const base = path.split("/").pop();
    if (/^\.env(\..*)?$/.test(base) && base !== ".env.example") {
      fail("tracked-env", path, "a .env file is in the git index; only .env.example may be");
    }
  }
}

// --- 9. nothing is public ----------------------------------------------------------------
//
// OPS_SPEC §4.3 — the `NEXT_PUBLIC_` prefix inlines a variable into the client bundle at
// build time. Every variable this app has is a DSN, a key, a salt or a budget; none of them
// is safe in a browser, and the day one is introduced "because it is only the site name" is
// the day the prefix stops meaning anything. Zero exist (MEASURED); this keeps it at zero.
// The prefix is spelled in two halves here so the checker does not trip itself.
const PUBLIC_PREFIX = "NEXT_" + "PUBLIC_";
for (const f of files) {
  if (!(SOURCE_EXT.test(f.path) || /(^|\/)\.env[^/]*$/.test(f.path) || f.path.endsWith(".md"))) continue;
  if (f.path === "scripts/check-invariants.mjs") continue;
  if (read(f).includes(PUBLIC_PREFIX)) {
    fail("public-env", f.path, `references a ${PUBLIC_PREFIX}* variable; nothing in this app is public-safe`);
  }
}

// --- 10. every query-layer read is cached --------------------------------------------------
//
// REVALIDATE_SPEC §1 / §6 — each read in lib/queries is `export const X = cached("<m>.<X>", XRaw)`
// so the nightly push can expire all of it with one tag. An `export async function` there is a
// read the hook cannot reach, unless it is one of the three clock-reading composers that stay
// plain by design. The key must be the module's own basename and the export's own name, or
// two functions can share a cache entry. And the superuser pool (`@/db/client`) may be imported
// only where a read is defined, never from a page or a component.
const UNCACHED_ALLOWED = new Set(["home.ts:getHome", "home.ts:getThisWeek", "release.ts:getStaleRound"]);
const CLIENT_ALLOWED_PREFIXES = ["lib/queries/", "lib/ask/", "scripts/", "db/"];

for (const f of sources) {
  const inQueries = /^lib\/queries\/[^/]+\.ts$/.test(f.path) && !/\.test\.ts$/.test(f.path);
  const text = stripComments(read(f));
  if (inQueries) {
    const mod = f.path.split("/").pop().replace(/\.ts$/, "");
    for (const m of text.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_$]+)/g)) {
      if (UNCACHED_ALLOWED.has(`${mod}.ts:${m[1]}`)) continue;
      fail("queries-cached", f.path, `export async function ${m[1]} is not wrapped in cached()`);
    }
    for (const m of text.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*cached\(\s*["']([^"']*)["']/g)) {
      const [, name, key] = m;
      if (key !== `${mod}.${name}`) {
        fail("queries-cached", f.path, `cached("${key}") for ${name}; the key must be "${module}.${name}"`);
      }
    }
  }
  const importsClient = /\bimport\s+(?!type\s)[^;]*?from\s+["']@\/db\/client["']/.test(text);
  if (importsClient && !CLIENT_ALLOWED_PREFIXES.some((p) => f.path.startsWith(p))) {
    fail("queries-cached", f.path, "value-imports @/db/client outside lib/queries/, lib/ask/, scripts/, db/");
  }
}

// --- 11. the two head-to-head answers are never subtracted --------------------------------
//
// H2H_SPEC §7 / §8 — the ledger carries counts only and the pooled contrast is the one stored
// pp number. A difference of two ratings, or of two pace gaps, is a third number nobody fitted,
// and it is exactly what a fan would read as "the driver gap". So `ratingPp` may not be an
// operand of `-` or `+`, and `gapPct` may not be an operand of `-`, in the H2H components and
// queries. Files that do not exist yet are skipped: absence is not a violation.
const H2H_FILE = (path) =>
  /^components\/driver\/H2H[^/]*\.tsx$/.test(path) || path === "lib/queries/h2h.ts" || path === "lib/driver/h2h.ts";
for (const f of sources) {
  if (!H2H_FILE(f.path)) continue;
  const text = stripComments(read(f));
  if (/ratingPp\s*[-+]/.test(text)) {
    fail("h2h-no-subtraction", f.path, "ratingPp is an operand of - or +; ratings are shown on separate lines, never differenced");
  }
  if (/gapPct\s*-/.test(text)) {
    fail("h2h-no-subtraction", f.path, "gapPct is an operand of -; the ledger carries counts, never a gap difference");
  }
}

// --- report -----------------------------------------------------------------------------
const RULES = 11;
if (violations.length === 0) {
  console.log(`invariants ok — ${RULES} rules, ${sources.length} source files under web/`);
  process.exit(0);
}
console.error(`MODE3_SPEC §0.2 / OPS_SPEC §4.3 boundary violated — ${violations.length} problem(s):\n`);
for (const v of violations) console.error(`  [${v.rule}] ${v.path}\n      ${v.detail}`);
console.error("\nThe boundary is the feature. Fix the code, not this file.");
process.exit(1);
