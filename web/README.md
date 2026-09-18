# F1 Analytics — web

Read-only Next.js 16 (App Router) front end over the Postgres tables that `f1lab` fills at ingest
time. Nothing is computed on request beyond formatting and sorting. The contract for every table,
query and component lives in `../docs/SPEC.md`; this README covers how to run and where things are.

## Prerequisites

- Node 22 / npm 10 (`package-lock.json` is authoritative; npm only).
- Postgres 16 running via `docker compose up -d` at the project root.
- `DATABASE_URL` (optional) — defaults to `postgres://f1:f1@localhost:5432/f1` on both the web and
  Python sides. Copy `.env.example` to `.env.local` to override.

## Setup

```bash
cd web
npm ci
npm run db:migrate      # applies drizzle/*.sql; creates drizzle.__drizzle_migrations (Python checks it)
npm run db:smoke        # SELECT 1 + row counts of sessions / laps / pace_ranking
npm run dev             # http://localhost:3000
```

Then, at the project root, ingest data: `python -m f1lab.ingest --season 2026` — the full
procedure (first run, per-weekend runs, re-ingest, changing an assumption) is `../docs/RUNBOOK.md`,
and the root `Makefile` wraps every step (`make db`, `make migrate`, `make ingest SEASON=2026`, `make web`).

## Scripts

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Next.js dev server / production build / serve the build |
| `lint` | ESLint 9 (flat config from `eslint-config-next`) |
| `typecheck` | `next typegen` (route types → `<distDir>/types`) then `tsc --noEmit --incremental false` |
| `db:generate` | `drizzle-kit generate` — writes a new migration when `db/schema` changed (must produce nothing on a clean tree) |
| `db:migrate` | `drizzle-kit migrate` — applies pending migrations |
| `db:check` | `drizzle-kit check` — validates the migration folder |
| `db:studio` | `drizzle-kit studio` — browse the DB |
| `db:smoke` | `tsx scripts/db-smoke.ts` |

Build output always goes to `.next` (`next dev` uses `.next/dev`, so a dev server and a production
build can run side by side; two builds cannot). Do not point `distDir` anywhere else: Next appends
`<distDir>/types/**` globs to `tsconfig.json` `include` and rewrites `next-env.d.ts` for every
custom dist dir it sees and never removes them (see SPEC §8.6). Both files must stay at the
scaffold state plus the two `.next/` globs; `npm run typecheck` regenerates `next-env.d.ts`.

## Layout

```
db/client.ts          pg Pool singleton (cached on globalThis) + drizzle(pool, { schema })
db/schema/*.ts        Drizzle transcription of SPEC §1 (explicit snake_case column names)
drizzle/              generated migrations (committed); Drizzle Kit owns the DDL
scripts/db-smoke.ts   connection smoke test
lib/theme.ts          PALETTE, f1darkTheme (ECharts theme), COMPOUND_FALLBACK, TEAM_FALLBACK
lib/format.ts         fmtLapTime, fmtRaceTime, fmtGap, fmtPct, fmtDate, fmtSigned, gpShortName
lib/colours.ts        ColourMap, teamColour, compoundColour, lineStyleFor
lib/queries/shared.ts shared row types + seasonsWithData, latestSeasonWithData, getLatestRace, sessionIdFor
lib/queries/*.ts      per-page query modules (home, season, race, driver)
components/charts/    EChart.tsx (the only 'use client' importer of echarts) + per-page charts
components/ui/        Nav, PageHeader, Section, DataTable, StatTile, TeamDot, DriverChip,
                      CompoundChip, StatusBadge, EmptyState, Caption, SeasonSwitcher
app/                  layout, globals.css (tokens), error, not-found, and the four routes:
                      /, /season/[year], /race/[year]/[round], /driver/[code]?season=YYYY
```

## Conventions

- Every `page.tsx` is an async Server Component with `export const dynamic = 'force-dynamic'` and a
  `generateMetadata`. `params` / `searchParams` are Promises (`const { year } = await params`); use the
  global `PageProps<'/race/[year]/[round]'>` helper.
- Only `components/charts/*` are `'use client'`; nothing there imports `db/` or `lib/queries`.
- Colours are never computed in the web app: queries return hex strings from `session_teams` /
  `compound_colours` / denormalised standings columns and components apply them with inline `style`.
- Dark theme only. Tokens: bg `#12100E`, fg `#EDE6DC`, grid `#3A342D`, accent `#E8A33D`, surface
  `#1C1916`, muted `#9A9187` — as Tailwind colours `bg-bg`, `text-fg`, `border-grid`, `text-accent`, ...
- Pages never throw on empty analytics; sections render `<EmptyState reason>`. `notFound()` only when
  the `sessions` / `seasons` / `drivers` row is missing.

## Schema changes

The schema is frozen after WP0. If a change is unavoidable: edit `db/schema/*.ts` → `npm run db:generate`
→ `npm run db:migrate` → update `f1lab/frames.py::EXPECTED_COLUMNS` → both sides sign off.
