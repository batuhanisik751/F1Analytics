# H2H_SPEC — "Norris or Verstappen this year: who has actually been quicker?" (IDEAS §1 #4)

## §0 Decision
- Design B (driver-page section, no new route) wins on honesty and build risk; two grafts: (1) C's computed
  no-call sentence, fired on `sameComponent=false` OR interval spanning 0 OR no stored row; (2) A's one-line
  computed lead so the ten-second answer sits above the tables. C's sign-orientation pin and Q-session
  uniqueness (excluding `SQ`) tests are added. Floating drivers' marginal ratings render hatched (MODE2 §8.4).
- Headline today, verbatim (C_H2H_8 + C_H2H_7 fills): "2026 ledger: Norris ahead on pace in 6 of 11 shared
  races. Car removed: cannot be called." and per row "Norris ahead in 8 of 13 shared races, same car not implied."
- Zero new tables, migrations, nightly steps, fits. All arithmetic is counting over stored rows; every read `cached()`.
- Resolved unverified items: `C-CONTRAST-1` exists (MODE2_SPEC 2400, slot `{nSharedRaces}`); interval label
  "5th–95th" is mandatory (MODE2_SPEC 118/469), so C_H2H_4 names it; `sessions.kind` has `SQ` rows (6 in 2026),
  the Q join filters `kind='Q'`; `season_quali_h2h` counts caveated sessions (f1lab/season.py 351–370 keeps them in
  `sess`, `sessions_caveated` is a side count) so the naive Q join reproduces 9–5; `mode2_career_season` carries
  points/contribution, no rating (f1lab/frames.py 422–430); `cached()` = `unstable_cache(fn,[name])`, args are in
  the key (web/lib/cache.ts 17–20); `lib/driver/*.test.ts` is already in the `test` glob (web/package.json 16);
  C-CONTRAST-2 text lives inline in web/components/driver/CareerH2HTable.tsx:88, copy it verbatim into the captions
  module (pinned there); no `db-smoke`-style test pattern exists in web/, so the DB-equality check is a fixture test.

## §1 Route, navigation, canonical order, metadata
- `/driver/[code]?season=YYYY&vs=CODE`. New section "Compared with {B}" rendered between the season summary and the
  Mode 2 slots. `vs` absent/invalid → the section is the picker alone (no empty tables, no EmptyState).
- `vs` parse: upper-cased, must be a `drivers.latest_code` with ≥1 `results` row in a `kind='R'` session of `year`
  (23 codes in 2026); `vs === code` → absent. Codes only in URLs; `driver_id` only in SQL (`max_verstappen`).
- Column A is always the page's driver; B is `vs`. No canonicalisation: `/driver/VER?vs=NOR` is a legitimate reversed
  view; the stored contrast (driver_a < driver_b) is oriented at read time as `getTeammateContrasts` already does.
- Lower-case redirect (page.tsx 65–70) must carry `vs` as well as `season`.
- Picker: `<form method="GET" action="/driver/{code}">` with hidden `season`, `<label for="vs">Compare with</label>
  <select id="vs" name="vs">` (self excluded, sorted by code), `<button>Compare</button>`. No client JS.
- Entry link: season team-mate card (`H2HCard`) gets "Compare all races" → `?season=&vs={teammate}` (cut if late).
- Metadata when `vs` resolves: title "{A} v {B} {year}", description = C_H2H_1 filled (caveat travels with the
  share text). Otherwise unchanged. Forbidden anywhere: "live", "real-time", "up to date".

## §2 Answer 1 — raw same-race ledger (car + driver together)
- Universe `shared` = `sessions.kind='R' AND year` where BOTH drivers have a `results` row. NOR/VER 2026 = 14.
- Four counted rows, each with its OWN denominator (never `shared`), ties never counted:
  - Qualified ahead: both have `quali_results.position` in the same round's `kind='Q'` session (one per round;
    `SQ` excluded); A wins if `posA < posB`. Header: "Qualified ahead (qualifying position, not grid)".
    DECISION: qualifying, not grid — the fan asked who was quicker and grid penalties are not pace. Team-mate
    parity target = `season_quali_h2h` (kind 'Q': `a_wins/b_wins/sessions_counted`), NOT `teammate_h2h.grid_wins`.
    The row explainer names the difference: the team-mate card above counts grid (NOR/PIA 8–6), this row counts
    qualifying (9–5).
  - Finished ahead: both `classified_position ~ '^\d+$'`; A wins if lower. Fifth row "Races one or both did not
    finish: {u}" — unclassified races are printed, never folded into a win.
  - Faster fuel-corrected pace: both have `pace_ranking.gap_pct` in the current assumption set; A wins if lower.
    Only the count leaves the query; no `gap_pct` difference is computed anywhere.
  - Points in shared races: `sum(results.points)` per driver over `shared`.
- Today: NOR/VER 14 | quali 8 of 13 | finish 6 of 10, 4 unfinished | pace 6 of 11 | points 154 v 133.
  NOR/PIA 14 | quali 9 of 14 | finish 6 of 9, 5 unfinished | pace 9 of 12 | points 154 v 99.
- Team-mate equality rule: for every 2026 team-mate pair, `tallyLedger` finish/pace/points == `teammate_h2h`
  (`finish_wins/losses`, `pace_wins/losses`, `points_for/against`) and quali == `season_quali_h2h` kind 'Q'.
  If a pair fails, fix the denominator rule in `tallyLedger`; never switch the column to grid.
- SQL intent (one query, ≤ 24 rows): `sessions(R,year) ⋈ results a ⋈ results b LEFT JOIN quali_results ×2 (via the
  round's Q session) LEFT JOIN pace_ranking ×2 (current assumption set)`; nulls kept; counting is pure TS.

## §3 Answer 2 — car-removed view (pooled model)
- Source: `mode2_driver_contrast` row for the unordered pair in the `is_current` fit (89 today), oriented A−B
  (sign flip, lo/hi swap-negate, `deltaSe` unchanged — the `getTeammateContrasts` reflection, extracted as
  `orientContrast`). Units pp of the race-centre lap, negative = faster. Interval = `[delta_lo, delta_hi]`, labelled
  "5th–95th". `null` when no row exists (378 rows ≠ all 253 pairs) → the card renders the no-call sentence.
- No per-season car-removed gap exists (`mode2_driver_rating_history` is cumulative through-year; contrasts are pooled
  only; a season-only gap needs a fit = Python). The card is labelled "every season the model has seen ({nA} and
  {nB} races)", never "{year}", and C_H2H_4 says so in the same sentence as the number. Not collapsible (UX §0).
- Context lines, never differenced: each driver's `getDriverRating` row (rating_pp, lo/hi, n_races, component).
  `anchorClass === "floating"` (norris, piastri today) → hollow dot + hatched numeral + "level not measured" chip.
- `sameComponent=false` → C-CONTRAST-2 verbatim inside the card, above the number, with the §8.4 separator, and the
  numeral keeps the hatched "not measured" treatment. `kind='teammate'` → C_H2H_6 with `{nSharedRaces}`.
- Model call (drives C_H2H_7/8): no row → no-call "no stored contrast for this pair"; `sameComponent=false` → no-call
  "the gap is assumed, not measured"; `lo < 0 < hi` → no-call "the 5th–95th range includes zero"; else leader =
  sign of oriented `deltaPp` (negative → A). Ledger call: sign of pace majority; `counted=0` or tie → level.
- Today NOR/VER: oriented +0.538 [+0.176, +0.900], cross, K4 vs K2, 0 shared → no-call (assumed, not measured).
  Ratings: Verstappen −0.772 [−1.007, −0.495] K2 n=44; Norris −0.234 [−0.559, 0.113] K4 n=49 (floating, hatched).
  NOR/PIA: −0.173 [−0.256, −0.090] teammate, 14 shared → call "Norris quicker".

## §4 Captions — `web/lib/driver/h2hCaptions.ts`, VERBATIM, slots in braces, `fill()` throws on an unfilled slot
- `C_H2H_1` (table `<caption>` + metadata description): "In {year} {a} and {b} started the same race {shared} times.
  Each line below counts only the races where both have that number, so the denominators differ. These lines
  compare car and driver together; they do not say who is the better driver."
  → "In 2026 Norris and Verstappen started the same race 14 times. Each line below … better driver."
- `C_H2H_2` (per counted row): "{a} ahead in {wins} of {counted} shared races, same car not implied."
  → quali "Norris ahead in 8 of 13 shared races, same car not implied." finish 6 of 10; pace 6 of 11.
- `C_H2H_2Q` (extra clause under the quali row): "Qualifying position, not grid: the team-mate card above counts
  grid position, which moves with penalties." (fixed text)
- `C_H2H_3` (points row): "{a} {pointsA}, {b} {pointsB} points in the {shared} races both started."
  → "Norris 154, Verstappen 133 points in the 14 races both started."
- `C_H2H_4` (car-removed number): "With the car taken out, the model puts {a} {absDelta} pp of a lap {fasterOrSlower}
  than {b}, 5th–95th {lo} to {hi}, across every season it has seen ({nA} races for {a}, {nB} for {b}). It is not a
  {year} number: the model is fitted once across seasons, never per season."
  → "With the car taken out, the model puts Norris 0.54 pp of a lap slower than Verstappen, 5th–95th 0.18 to 0.90,
  across every season it has seen (49 races for Norris, 44 for Verstappen). It is not a 2026 number: …"
- `C_H2H_5` (fixed, once under both cards): "The two answers are allowed to disagree: the first counts qualifying,
  finishes and pace in whatever car each drove; the second tries to take the car out. Neither is subtracted from
  the other."
- `C_H2H_6` (same_component true): "{a} and {b} shared a car in {nSharedRaces} races, so this gap is measured, not
  assumed." → NOR/PIA: "Norris and Piastri shared a car in 14 races, so this gap is measured, not assumed."
- `C_H2H_7` (no-call, computed): "The model's side cannot be called here: {reason}." `reason` ∈ REASONS =
  {"the gap is assumed, not measured", "the 5th–95th range includes zero", "no stored contrast for this pair"}.
  → NOR/VER: "The model's side cannot be called here: the gap is assumed, not measured."
- `C_H2H_8` (lead line, computed): "{year} ledger: {ledgerCall}. Car removed: {modelCall}." with `ledgerCall` ∈
  {"{leader} ahead on pace in {n} of {d} shared races", "level on pace, {n} each of {d} shared races",
  "no shared race has a pace estimate for both"} and `modelCall` ∈ {"{leader} quicker over every season the model
  has seen", "cannot be called"}. → "2026 ledger: Norris ahead on pace in 6 of 11 shared races. Car removed: cannot
  be called." NOR/PIA → "… Norris ahead on pace in 9 of 12 shared races. Car removed: Norris quicker over every
  season the model has seen."
- `C_CONTRAST_2` copied verbatim from CareerH2HTable.tsx:88 (MODE2_SPEC 2407–2410), pinned here too.

## §5 Queries (all `cached()`, key "<basename>.<export>", check-invariants rule 10)
- `resolveOpponent(year, code)` — `web/lib/queries/h2h.ts`, key `h2h.resolveOpponent`; drivers ⋈ results ⋈ sessions →
  `{driverId, code, fullName, headshotUrl} | null`.
- `getOpponents(year)` — `h2h.ts`, key `h2h.getOpponents` → `{code, fullName}[]` by code (23 today); one extra cached read.
- `getSeasonLedger(year, aId, bId)` — `h2h.ts`, key `h2h.getSeasonLedger`; the §2 SQL, then `tallyLedger(rows)` →
  `Ledger = {shared, quali:{counted,aWins}, finish:{counted,aWins,unclassifiedAny}, pace:{counted,aWins},
  points:{a,b}}`. No signed-gap field exists on the type.
- `tallyLedger(rows: LedgerRow[]): Ledger` — pure, `web/lib/driver/h2h.ts`; `LedgerRow = {round, qA, qB, finA, finB,
  paceA, paceB, ptsA, ptsB}` (nulls kept; `finA/finB` are the raw `classified_position` strings).
- `getPairContrast(aId, bId)` — `h2h.ts`, key `h2h.getPairContrast`; current fit + unordered lookup + `orientContrast`
  (exported from `mode2.ts`, extracted from `getTeammateContrasts`) → `ContrastRow | null`.
- `modelCall(contrast): {kind:"leader", leaderIsA:boolean} | {kind:"nocall", reason: Reason}` and
  `ledgerCall(ledger)` — pure, `web/lib/driver/h2h.ts` (§3 rules). Reuse `getDriverRating(id)` ×2 from mode2.ts.

## §6 UI (server components only, no client JS)
- `web/components/driver/H2HSection.tsx`: picker form; when `vs` resolves: `<h2>` "Compared with {B}", lead `<p>`
  C_H2H_8, then `grid md:grid-cols-2` (ledger first, stacked on phones), then C_H2H_5 once under both.
- `H2HLedgerTable.tsx`: `<table>` with `<caption>`=C_H2H_1; columns "Row · {A} · {B} · counted" (4 cols, fits 375px,
  no scroller); each row's C_H2H_2/2Q/3 sentence in a full-width second `<tr>` cell (`colSpan=4`), not a tooltip and
  not a fifth column; fifth data row "Races one or both did not finish: {u}". Cells are "{n} of {d}" or integers only
  in the points row (its sentence C_H2H_3 explains it).
- `H2HCarRemovedCard.tsx`: C-CONTRAST-2 + §8.4 separator when cross-component → oriented number + 5th–95th bar
  (reuse `RatingBar` styling, hatched when not measured) → C_H2H_4 → C_H2H_6 or C_H2H_7 → two marginal rating lines
  (hatched when floating), never differenced.

## §7 Tests
- `web/lib/driver/h2hCaptions.test.ts`: byte-pins every C_H2H_* string and C_CONTRAST_2; no digit or driver name in
  any template; forbidden words absent ("live", "real-time", "up to date"); `fill()` throws on a missing slot.
- `web/lib/driver/h2h.test.ts`, fixture (qA,qB | finA,finB | paceA,paceB | ptsA,ptsB), 6 rows:
  r1 1,2 | '1','2' | 0.0,0.3 | 25,18; r2 3,1 | '2','1' | 0.5,0.1 | 18,25; r3 null,4 | '5','R' | 0.2,null | 10,0;
  r4 2,5 | 'W','3' | 0.4,0.2 | 0,15; r5 6,7 | '4','6' | 0.3,0.3 | 12,8; r6 8,9 | 'D','D' | null,null | 0,0
  → shared 6; quali 4 of 5; finish 2 of 3, unclassifiedAny 3; pace 1 of 3 (r5 tie not counted); points 65 v 66.
  Plus the measured NOR/VER (14 | 8/13 | 6/10, 4 | 6/11 | 154–133) and NOR/PIA (14 | 9/14 | 6/9, 5 | 9/12 |
  154–99) numbers as expected values of hand-built row sets.
- Orientation pin: stored `{driverA:"max_verstappen", driverB:"norris", deltaPp:-0.538, deltaLo:-0.900,
  deltaHi:-0.176}` oriented to A=norris → `+0.538 [+0.176, +0.900]`; `modelCall` → nocall "assumed" when
  `sameComponent=false`, nocall "zero" for `[-0.1, 0.2]`, leader when `[-0.256,-0.090]`.
- Q uniqueness: the ledger SQL joins `kind='Q'` only; a fixture with an `SQ` session in the same round yields one Q row.
- Never-subtract: type test that `Ledger`/`ContrastRow` carry no field derived from `ratingPp` or `gapPct`
  arithmetic; `check-invariants.mjs` grep forbids `ratingPp\s*[-+]` and `gapPct\s*-` in `web/components/driver/H2H*`
  and `web/lib/queries/h2h.ts`.
- a11y: add `"/driver/VER?season=2026&vs=NOR"` to `web/tests/a11y/dom.ts` ROUTES and `: 0` to both ratchet maps in
  `tables.test.ts`; add the rendered C_H2H_1/2/4/5/7/8 strings for that route to `captions.baseline.json`.
- Team-mate equality (§2): fixture-asserted on NOR/PIA; WP-QUERY checks all 2026 pairs by hand SELECT before hand-off.

## §8 Must-not → copy
- "raw counts say who is the better driver" → C_H2H_1 last sentence + column header "car and driver together".
- "subtract two pace_ranking gaps" → ledger carries counts only; never-subtract grep + type test.
- "caveat in a footnote" → "same car not implied" is inside every C_H2H_2 line (the screenshot unit).
- "difference two ratings" → only pp number is the stored contrast; ratings on separate lines, floating ones hatched.
- "pooled read as this year" → C_H2H_4's "not a {year} number" is in the numeral's paragraph; "`verstappen` id" →
  codes in URLs only, `resolveOpponent` maps `latest_code` → `driver_id`.

## §9 Work packages (no file in two; QUERY ∥ COPY → PAGE; DOCS parallel to all)
- WP-QUERY: `web/lib/queries/h2h.ts` (new), `web/lib/queries/mode2.ts` (+`orientContrast` export only),
  `web/lib/driver/h2h.ts` (new: types, `tallyLedger`, `modelCall`, `ledgerCall`), `web/lib/driver/h2h.test.ts` (new).
- WP-COPY: `web/lib/driver/h2hCaptions.ts` (new), `web/lib/driver/h2hCaptions.test.ts` (new),
  `web/scripts/check-invariants.mjs` (+grep rule), `web/tests/a11y/captions.baseline.json` (+entries).
- WP-PAGE (after QUERY and COPY): `web/components/driver/H2HSection.tsx`, `H2HLedgerTable.tsx`,
  `H2HCarRemovedCard.tsx` (new), `web/app/driver/[code]/page.tsx` (+parse `vs`, redirect, awaits, section, metadata),
  `web/components/driver/H2HCard.tsx` (+link), `web/tests/a11y/dom.ts`, `web/tests/a11y/tables.test.ts`.
- WP-DOCS: `docs/IDEAS_2026-09.md` (#4 status → specified, link here), `docs/UX_SPEC.md` (route/section list line).
- Cuts if late, in order: H2HCard link; UX_SPEC line; check-invariants grep (keep the type test). Never cut captions,
  denominators, the no-call sentence or the "not a {year} number" sentence.

## §10 As built (2026-09-22)
- Built as §1–§9 with these measured corrections: the NOR/PIA contrast in the current fit (89) is −0.176 pp
  [−0.324, −0.027] with `n_shared_races` 46 (the pooled career count), not the −0.173 [−0.256, −0.090] / 14 the §3
  fill guessed; C_H2H_6 therefore prints 46, which is right for a card labelled "every season the model has seen".
  Exact ties are excluded from every counted row's denominator (positions cannot tie; the pace tie in the §7 fixture
  fixes the rule). `{a}`/`{b}` are surnames (last token of `drivers.full_name`).
- Column A is the page's driver, so on `/driver/VER?season=2026&vs=NOR` the ledger reads from Verstappen's side
  ("Verstappen ahead in 5 of 13 shared races, same car not implied.", finish 4 of 10, pace 5 of 11, points 133 v
  154) while the lead line names the pace leader either way: "2026 ledger: Norris ahead on pace in 6 of 11 shared
  races. Car removed: cannot be called." The baseline entries record the rendered orientation.
- Team-mate equality: 22 of 26 stored 2026 team-mate rows equal on finish/pace/points and on qualifying
  (`season_quali_h2h`, kind Q); the four that differ are the two mid-season seat swaps, where the ledger counts every
  race both started (14) and the stored table counts only paired rounds — equal when restricted to the same team.
  The column stays qualifying, not grid (NOR/PIA 9–5 vs the team-mate card's 8–6).
- The ledger table is a hand-rolled `<table>` (DataTable's scroller and `min-w-max` would break the 375 px rule and it
  cannot emit the colSpan sentence rows); 317 px wide at 375 px. The section's separator text duplicates the Mode 2
  client constant because that module is `"use client"`.
- Verification: typecheck, lint (0 warnings), 327 web tests (9 ledger/contrast tests incl. the orientation pin and
  the Q-only join), invariants 11 rules (rule 11 `h2h-no-subtraction`), a11y 115/115 with the new route, db-smoke
  67/67 (the four new reads included); rendered sentences checked on the dev server for VER/NOR, NOR/PIA and the
  picker-only state.
- Production: live 20 s after the push of de0c160. From outside, `/driver/VER?season=2026&vs=NOR` renders the lead
  line, the Verstappen-oriented ledger sentences, the pooled-model sentence, the no-call sentence and the points line
  exactly as on the dev server; `/driver/VER?season=2026` shows the picker alone; the title is "Verstappen v Norris
  2026".
