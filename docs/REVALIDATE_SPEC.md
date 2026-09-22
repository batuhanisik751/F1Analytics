# REVALIDATE_SPEC — cache the query layer, purge it from the nightly push (2026-09-22)

## §0 Decision
Design C (per-query `unstable_cache`, every `force-dynamic` kept) is adopted: it is the only design whose
build, CI and Vercel behaviour is unchanged and fully verified in `web/node_modules/next/dist`. Two grafts
from the judges: the hook calls `revalidateTag("data", { expire: 0 })` (hard expiry, no stale serve) instead
of `"max"`, and the expiry drops from 21 600 s to **3600 s**. A third correction: a hook failure is appended
to `failures` (exit 1), never exit 0.
**Expiry: 3600 s.** Recorded as a departure from OPS §5.1 row 3 (600 s): the hook is the invalidator; the
timer only bounds a missed hook to one hour, and at 600 s a crawler keeps Neon awake ~144×/day per entry.
**SPEC D20 becomes, verbatim:** `force-dynamic` on all pages; `cacheComponents` off; every `lib/queries`
read is cached under tag `data` for at most 3600 s and recomputed on the first request after the nightly
push calls `/api/revalidate`. The footer names the push the numbers come from. | Data changes only at the
push; the guard sentence's date side is computed per request; only `/api/ask` and `/api/revalidate` bypass.
Forbidden copy anywhere: "live", "real-time", "up to date", "updated every hour". No fan-facing string changes;
`web/lib/home/captions.ts` and its pinning test are untouched.

## §1 Mechanism, per file
Verified Next 16.3.5 facts this rests on: `unstable_cache` is NOT bypassed under `force-dynamic`
(unstable-cache.js:160 lists only nested/force-no-store/on-demand/draft); its key is sha256 of
`cb.toString()+keyParts+JSON(args)` (unstable-cache.js:58, incremental-cache/index.js:84), so a query-body
edit changes the key on deploy; `revalidate: 0` THROWS E57 at wrap time (unstable-cache.js:38) — never pass 0;
`{ expire: 0 }` normalises (cache-life-profile.js:37,49: number, finite) and file-system-cache.js:56-64 sets
`expired = now`, so `areTagsExpired` (tags-manifest.external.js) is true and incremental-cache/index.js:410
returns null → blocking refill, no stale serve; `next start` defaults NODE_ENV to production (bin/next:84).
- `web/lib/cache.ts` (new): `export const DATA_TAG = "data"; export const DATA_TTL_S = 3600;`
  `const ON = process.env.NODE_ENV === "production" && process.env.DATA_CACHE !== "0";`
  `export function cached<A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>)` returns
  `ON ? unstable_cache(fn, [name], { tags: [DATA_TAG], revalidate: DATA_TTL_S }) : fn`. Dev = cache off.
- Every exported async function in `web/lib/queries/*.ts` (69 today: accuracy 4, driver 2, home 2, mode2 16,
  preview 3, quali 8, race 17, release 3, report 1, season 5, shared 4, sim 1, telemetry 3) is wrapped the
  same way: body keeps its name with `Raw` suffix and loses `export`; one line
  `export const getSeason = cached("season.getSeason", getSeasonRaw);` (key = `<module>.<name>`, unique).
  Internal callers keep calling the exported (wrapped) name; a wrapped call nested inside another wrapped
  call runs uncached within the outer entry (unstable-cache.js:160) — correct, only redundant.
- EXCEPTIONS, never wrapped (they read the clock): `home.getHome`, `home.getThisWeek`, `release.getStaleRound`.
  They stay `export async function` and compose wrapped leaves only. The one direct `db.select` in
  `getThisWeek` (home.ts:178, title_odds expected points) moves to a new wrapped leaf
  `getLeaderExpectedPoints(year, afterRound, driverId)`. Pure helpers (`todayUtc`, `staleRoundFrom`,
  `nextEventFrom`, `formatPushedAt`, quali/season constants) are untouched.
- `web/lib/queries/release.ts`: `DataRelease.pushedAt` becomes an ISO `string` (`r.pushed_at.toISOString()`);
  `formatPushedAt(iso: string)` does `new Date(iso)` first. Only consumer: `web/app/layout.tsx` (unchanged call).
- `web/app/layout.tsx`: NO change. `Freshness` keeps `getStaleRound()`: cached rows, per-request date.
  `components/ui/Nav.tsx`: NO change (its two reads are wrapped at `shared.ts`).
- Pages, ALL unchanged in source and all keep `export const dynamic = "force-dynamic"`: `app/page.tsx`,
  `season/[year]`, `season/[year]/was-it-the-car`, `race/[year]/[round]`, `race/[year]/[round]/telemetry`,
  `driver/[code]`, `constructor`, `constructor/[slug]`, `accuracy`. `ask` (no DB) and `glossary`
  (`force-static`) unchanged. `app/api/ask/route.ts` unchanged and uncached (`lib/ask` imports no `lib/queries`).
- The five `searchParams` pages stay route-dynamic; their data is cached below them, one entry per argument
  tuple (`getDriverSeason(driverId, 2025)` ≠ `(…, 2026)`); `generateMetadata` re-calls hit the same entry.

## §2 `web/app/api/revalidate/route.ts` (new)
- `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` POST only (no GET export → Next
  answers 405). `export function handle(req: Request, deps = { revalidateTag })` and `export const POST =
  (req: Request) => handle(req);` so the test injects a spy.
- Auth: `const secret = process.env.REVALIDATE_SECRET`. Unset or shorter than 32 chars → `503 {code:"off"}`
  (the route is simply off until the orchestrator provisions a ≥ 32-char secret in Vercel). Header `authorization` must be exactly `Bearer <token>`; compare `sha256(token)` with
  `sha256(secret)` via `crypto.timingSafeEqual` (equal-length digests, so no length leak and no throw) →
  otherwise `401 {code:"unauthorized"}`. The header value is never logged, never echoed.
- Body: ignored except `release_id` (optional number) which is echoed back for the log line.
- Action: `deps.revalidateTag(DATA_TAG, { expire: 0 })` — every `data` entry becomes a hard miss on its next
  read (verified chain in §1). Response `200 {ok:true, tag:"data", expire:0, release_id, at:<ISO>}`.
- Any thrown error → `500 {code:"failed"}` with `console.error("revalidate:", err.message)` only.
- `web/scripts/check-invariants.mjs` rule 4 (`second-post`, line 104): the skip set becomes
  `{app/api/ask/route.ts, app/api/revalidate/route.ts}` with a comment naming this spec.
- `web/.env.example` gains `REVALIDATE_SECRET=` with a comment: production only, `openssl rand -hex 32`,
  entered with `vercel env add`, never on a command line, never in Preview; unset locally = route off.

## §3 `scripts/update_season.py` hook
- Placement: in `_push_step`, immediately after `if a.dry_run or not summary.startswith("OK"): return`
  (line 171) and before the baseline commit (line 173): `_revalidate_step(failures, new_sessions)`.
  Condition: therefore only after a SUCCESSFUL, non-dry push; `--no-push` never reaches it. The baseline
  commit and fixture republish still run afterwards regardless of the hook's outcome.
- Credentials: `scripts/push_remote.py` factors the file check + line parse out of `load_remote_dsn` into
  `read_remote_env(names: list[str], path=REMOTE_ENV, env=None) -> dict[str, str]` (environment first, then
  the file; same regular-file / owner / mode-exactly-0600 `Refusal`; single-quoted values stripped; parsed
  line by line in Python; never sourced). `load_remote_dsn` becomes a one-line caller. The hook reads
  `REVALIDATE_URL` and `REVALIDATE_SECRET`; the orchestrator adds those two lines to `remote.env`.
- Request: `urllib.request.Request(url, method="POST", data=json({"release_id": <output/last_push.json
  release_id>}), headers={Authorization: "Bearer "+secret, Content-Type: application/json})` through an
  opener whose `HTTPRedirectHandler.redirect_request` returns None, so any 3xx raises `HTTPError` (a redirect
  would otherwise re-send the header as a GET). `timeout=20`; on `URLError`/timeout/5xx one retry after 5 s
  (Vercel cold start). Then one smoke `GET <origin>/` (timeout 20) expecting 200 — nothing is parsed from
  the body; the cross-language footer comparison of Design C is dropped because `{expire: 0}` leaves no stale
  serve to detect. The secret is held in a local variable, never formatted into any string that is logged.
- Outcomes: 200 → `log.info("revalidate: OK %s release_id=%s in %.1fs", host, rid, secs)`. Anything else →
  `log.error("revalidate: FAILED %s %s", host, "<status> <code>" | exception class name)` and
  `failures.append(f"revalidate: {reason}")`, so the `=== done … FAILURES: …` line and exit code 1 make it
  visible in `output/update_season.log`; production data is correct and the 3600 s expiry heals the cache.
  Also written every time: `output/last_revalidate.json` `{at, status:"ok"|"failed"|"skipped", reason, host}`;
  the next run's `_revalidate_step` logs `revalidate: previous run FAILED (<at>: <reason>)` from that file
  before it fires, so two bad nights read as a pattern in the log, beside the telemetry known-failure lines.
- Local dev: neither key in `remote.env` (or no file) → `log.info("revalidate: no REVALIDATE_URL -- skipped
  (local only)")`, status `skipped`, not a failure. `next dev` has the cache OFF (NODE_ENV), so a local
  ingest is visible immediately, as today. `--dry-run` → `log.info("revalidate: would POST %s", host)`.
- Tests (`tests/test_update_season_revalidate.py`, offline, no DB): a fake `urlopen` returning 200 / 401 /
  URLError-then-200 / 301; assert the log lines, the `failures` list, `last_revalidate.json`, and that the
  secret string never appears in captured log output. `read_remote_env`: 0644 file → `Refusal`.
- `docs/RUNBOOK.md` §9 gains "9.4 Revalidating production by hand": the curl (`-H "Authorization: Bearer
  $REVALIDATE_SECRET"` read from `remote.env` by the operator, never pasted), expected 200/401/503, and the
  morning-check line `revalidate: OK|FAILED` added to §9.3.

## §4 CI
`.github/workflows/ci.yml`: NO change. `force-dynamic` stays on every page, so `next build` prerenders no
data page and runs no `unstable_cache` body; the `web` job still builds with no database; `py-db` runs
`next start` (NODE_ENV=production → cache ON) so the 107 a11y checks exercise the wrapped path against the
fixture. Vercel build unchanged. CI delta 0 min. New test files join `npm test` via `web/package.json`
`test` glob additions `app/api/revalidate/*.test.ts lib/*.test.ts`; the Python test joins `pytest` (offline tier).

## §5 Serialization and size
`unstable_cache` stores `JSON.stringify(result)` and revives with `JSON.parse` (unstable-cache.js:24,182).
Concrete field audit (scout §2, re-read today): the ONLY value whose type changes is
`getLatestRelease().pushedAt` (pg timestamptz → `Date`; `formatPushedAt` would throw on the revived string)
— fixed in §1 at the source. Already JSON-safe: `mode2.getFitMeta.fittedAt` (`.toISOString()`),
`report.getRaceReport.generatedAt` (`toIso`), `race.getAssumptions.ingestedAt` (drizzle mode "string"),
`events.eventDate`/`sessions.startUtc`/`data_release.pushedAt` schema columns (mode "string"/"number"),
all Map/Set usage internal (no exported Map/Set), `undefined` normalised with `?? null`, arrays plain
`number[]`. Rules for new code: a wrapped function may return only JSON scalars, plain objects and arrays;
NaN/Infinity become `null` on revival, so a query must never emit them.
Guard: `web/scripts/db-smoke.ts` (`npm run db:smoke`, needs a DB, runs in `py-db` against the fixture)
gains a pass over every wrapped export, arguments taken from the fixture (2026 R14, driver `ANT`, first constructor):
`assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), v)` and `JSON.stringify(v).length < 1_048_576`.
Size limit: 2 MiB per entry (incremental-cache/index.js:517-524; dev throws E1003, prod warns and serves
uncached). Largest entries are per-lap telemetry: `getLapTelemetry(session, driver, lap)` is one row of
9 arrays × ≤ 897 samples (max `n_samples` in `lap_telemetry` today), well inside the 1 MiB assertion.

## §6 Verification
- `web/app/api/revalidate/route.test.ts` (node:test, no DB): secret unset → 503 `off`, spy not called;
  31-char secret → 503; no header / `Basic x` / wrong token / wrong token of equal length → 401, spy not
  called; correct bearer → 200 body `{ok:true, tag:"data", expire:0}` and spy called once with
  `("data", { expire: 0 })`; spy throwing → 500 `failed`; captured console output never contains the token.
- `web/lib/cache.test.ts`: with `NODE_ENV=test` `cached()` returns the same function (pass-through); with
  `DATA_CACHE=0` likewise; `DATA_TTL_S` is a positive integer (never 0, E57).
- `web/lib/queries/release.test.ts`: `formatPushedAt("2026-09-19T03:20:00.000Z") === "19 Sep 2026, 03:20 UTC"`.
- `check-invariants.mjs` rule 10 `queries-cached` (RULES = 10): in `lib/queries/*.ts` (not tests) any
  `export async function` fails unless in `{home.ts:getHome, home.ts:getThisWeek, release.ts:getStaleRound}`;
  every `export const X = cached("<m>.<X>"` must use its own module basename and its own name; no
  `from "@/db/client"` value import outside `lib/queries/`, `lib/ask/`, `scripts/`, `db/`.
- Local: `npm run build && npm run start -- -p 3001`; `curl -o /dev/null -w '%{time_starttransfer}\n'`
  on `/` and `/driver/ANT?season=2026` twice; `docker exec f1-postgres psql -U f1 -d f1 -c "select count(*)
  from pg_stat_activity where usename='f1' and state='active'"` shows no query during the second request.
- After deploy (orchestrator): `curl -sI https://f1-analytics-lac.vercel.app/` twice ≥ 6 min apart —
  headers stay `cache-control: private, no-cache, no-store, max-age=0, must-revalidate`,
  `x-vercel-cache: MISS`, `age: 0` (the page is still dynamic; that is expected). Evidence is
  `%{time_starttransfer}`: second pair < 0.5 s where today's cold is ~1.5 s. Then a POST with the bearer →
  200 and the next `/` is cold again (~1.5 s): this is the ONLY proof that Vercel's cache handler honours
  `{ expire: 0 }` the way the installed FileSystemCache does (not verifiable from the repo); if the next hit
  is warm, the fallback is `"max"` plus the hook GETting `/` twice — a decision, not a silent default.
- Neon evidence: the OPS §5.1 fortnight reading (console compute-hours/day and "last active" gaps for
  `f1_web`), one week before the deploy and two weeks after; target ≥ 60 % fewer wakes at unchanged traffic.
  Nightly: `revalidate: OK` in `output/update_season.log` each push night.

## §7 Rollback
`DATA_CACHE=0` in Vercel (Production scope) + redeploy → `cached()` is a pass-through, every request reads
Neon as today; the route and hook stay harmless (they expire nothing). Code-level: `const ON = false` in
`web/lib/cache.ts`. Never `DATA_TTL_S = 0` (E57 at import). Reverting `pushedAt` is not needed either way.

## §8 Work packages (no file in two packages; the orchestrator alone provisions REVALIDATE_SECRET in
Vercel and the two `remote.env` lines, and touches Vercel)
- **WP-WEB**: `web/lib/cache.ts`, `web/lib/cache.test.ts`, `web/lib/queries/{accuracy,driver,home,mode2,
  preview,quali,race,release,report,season,shared,sim,telemetry}.ts`, `web/lib/queries/release.test.ts`,
  `web/app/api/revalidate/route.ts`, `web/app/api/revalidate/route.test.ts`, `web/scripts/check-invariants.mjs`,
  `web/scripts/db-smoke.ts`, `web/package.json`, `web/.env.example`. (No page, layout or Nav file.)
- **WP-PY**: `scripts/update_season.py`, `scripts/push_remote.py`, `tests/test_update_season_revalidate.py`,
  `docs/RUNBOOK.md`.
- **WP-DOCS**: `docs/OPS_SPEC.md` (§5.1 row 3 → 3600 s, decided, reason from §0), `docs/SPEC.md` (D20 → §0
  text verbatim), `docs/IDEAS_2026-09.md` (§1 #3 status: adopted, see REVALIDATE_SPEC).
Order: WP-WEB and WP-PY in parallel; WP-DOCS after both; the orchestrator deploys, then runs §6 outside checks.

## §9 As built (2026-09-22, commit 7c01909)
- Built as §1–§8 with one addition: `getHome` (an exception) called three private helpers
  (`getPodium`, `getRunnerUpPace`, `raceSessionId`) that still read the database per request; they are
  now wrapped leaves (`home.<name>` keys, not exported). `season.ts` was wrapped by the orchestrator.
- Local proof under `next start` against the Docker database (pg_stat_user_tables scans): `/` warm +0,
  `/driver/ANT?season=2026` cold +271 / warm +0; bearer POST → 200; next `/` +176; then +0. The a11y
  sweep (107) passes on the cached path. The cache is off under `next dev`, so this check needs a
  production build; the preview tool starts `next dev` whatever launch entry is named — use
  `next start -p 3001` from the shell and `A11Y_BASE_URL` for the sweep.
- Production proof (Neon `pg_stat_user_tables` through the push role, the site public, no other writer):
  `/` warm +0, +0; POST with the production bearer → 200; next `/` **+28**; then +0. Vercel's cache handler
  honours `{ expire: 0 }` as a hard expiry — §6's fallback (`"max"` plus warm GETs) is not needed.
  Route from outside: no header 401, wrong token 401, GET 405. Footer after the change renders
  `Data as of 21 Sep 2026, 04:06 UTC · last push 178 sessions, 274,435 rows` from the ISO string.
- TTFB from outside, warm Neon: before ~0.15–0.26 s, after ~0.17–0.28 s (unchanged — the function still
  renders); cold before: 2.34 s. The cold-after number and the Neon compute-hours reading are the
  §6 fortnight measurement, not yet taken. First `revalidate: OK` line expected in
  `output/update_season.log` on the night of 2026-09-26/27.
