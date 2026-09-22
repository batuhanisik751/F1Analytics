# ACCURACY_SPEC — /accuracy revision: points-band scoring (IDEAS §1 #2) and interval sharpness (§1 #5)

Written 2026-09-22 from the scout, three designs and three judges; every number re-run read-only against `f1-postgres` today.
Overriding rules: no tool or assistant named anywhere; no commit/push/deploy; database read-only; no new tables, nightly steps or
fixtures (the per-round ledger, IDEAS §2a, stays out); fan copy verbatim in `web/lib/accuracy/captions.ts`, pinned by a test, every
fitted number a slot; UX_SPEC's three forbidden words absent everywhere.

## §0 Decision

Base design **A** (statistical honesty wins: fair clipped comparator, data-selected verdicts, calendar-based finished-season rule,
final-round row excluded and said so) with the judges' grafts: from **C** the point-forecast sentence (grid slot 2.8 vs model 3.7
places), the label "Driver-rounds", the phrase "projections made in the first quarter", the `cAcc8` year slots and the plainer
"says almost nothing" gloss; from **B** the three-row "Three ways to draw the range" table and C_ACC_6's dangerous-direction caveat
kept byte-intact. Every literal "two" in A's honesty caption becomes the `{nSeasons}` slot; A's share-of-grid is corrected to the
row-weighted (width+1)/grid = 0.773. Cut: the champion p_title path (`getChampionPath`, cAcc15 — it names a driver and its C_NEVER
fill reads "from round never") and the per-round chart (the per-round table is the accessible artefact; a chart adds an aria path).

The two sentences a fan leaves with (headline verdicts, on the page as filled templates cAcc16 and cAcc10):
1. **"In 2024 the range built to hold each driver's final points total 80 % of the time held it for 14 % of the
   projections made in the first quarter of the season."**
2. **"A 15-place range on a 20-car grid is close to vacuous: it contained the finish 95 % of the time mostly by being
   wide, and a grid slot plus or minus 7 places, needing no model at all, scores better."**

Unverified items resolved today: the 100 unscored rows are 86 Retired, 8 Did not start, 2 Disqualified, 1 Lapped, 3 with no
results row (so the copy says "no classified finishing position", not "retirement"); `results.grid_position` holds 0 once (a
pit-lane start), never in a scored backtest row, so `naiveBand` clamps g < 1 to 1; the finished-season rule verifies as
max(driver_standings.after_round) = max(events.round): 24=24, 24=24, 2026 14≠23; floor((r−1)·4/R)+1 gives 1–6 / 7–12 / 13–18 /
19–R−1 for R = 24 and R = 23 (C's 23-round labels were wrong); per-round band coverage inside 2024 Q1 runs 0.048–0.333, so early
failures are broad but the copy claims only non-independence, never "most drivers at once"; `drivers.full_name` exists but is
unneeded once the champion path is cut; `check:invariants` (10 rules, 236 files) and `typecheck` pass today; `DataTable` takes
`caption`, `align: "right"`, `emptyReason`; `Section` takes `caption` above its children, which is where the NULL rule goes.

## §1 Page structure (in DOM order; nothing existing is removed)

| # | Section (id) | Open by default | Content |
|---|---|---|---|
| 0 | thesis | open | `C_ACC_1` unchanged. |
| 1 | Win probability (`skill`) | open | Unchanged: two Metrics, `cAcc3`, closed Disclosure with the scope table. |
| 2 | Is it calibrated? (`calibration`) | open | Unchanged: `C_ACC_4`, ReliabilityChart. |
| 3 | Did the range contain the answer? (`intervals`) | open | Section `caption` = **`cAcc9`** (NULL rule, so it precedes every coverage figure). Metric grid 3 → 4: contained / promised / typical miss / **"How wide the range was"** (mean p90−p10, unit "places, on grids of {gridLo}–{gridHi} cars", hint "Low end to high end, averaged over every scored preview; narrowest {minWidth}, widest {maxWidth}."). Then `cAcc5` (unchanged), rewritten `C_ACC_6`, `cAcc10` or `cAcc10Narrow`, `C_ACC_11`, visible DataTable **"Three ways to draw the range"** (rows: our range · grid ± 7 · grid ± 5; columns Width (places) · Contained the finish · Centre's typical miss (places) · Score), `cAcc12`, `C_ACC_13_NAIVE` or `C_ACC_13_MODEL`, `cAcc14`. Closed Disclosure "Split by season — {n} seasons" keeps `C_ACC_7` and the existing table, which gains columns Not classified · Grid cars · Range width · Score · Grid ± 7 contained · Grid ± 7 score. |
| 4 | **NEW** Did the mid-season points projections hold up? (`points-band`) | open | `cAcc15` as Section caption. Per finished season: `cAcc16` then a visible DataTable "Final-points range scored by quarter, {year}" (columns Quarter (rounds) · Driver-rounds · Range held the final total · Promised · Points off on average · Range width (points)). Then `cAcc17`, `C_ACC_18`. Closed Disclosure "Every round — {n} rows" with the per-round table (Season · After round · Driver-rounds · Held · Points off · Width). EmptyState with `C_ACC_EMPTY` when no season is finished. |
| 5 | What these scores do not say (`limits`) | open | `cAcc8(firstYear, lastYear)` replaces the literal "2024–2026". |

Collapse rule: verdicts and both scoring tables open (the answer); per-season and per-round tables closed (the evidence); summaries carry counts.

## §2 Captions — verbatim templates (`web/lib/accuracy/captions.ts`), slots in `${}`; today's fill after each

Unchanged: `C_ACC_1`, `C_ACC_2`, `cAcc3`, `C_ACC_4`, `cAcc5`, `C_ACC_7`, `C_ACC_EMPTY`. Changed in place (changed.json record each,
verdict "rewritten in place, not deleted", spec IDEAS §1 #5 / rule 4): `C_ACC_6` (its first and last sentences byte-intact; the
sentence "That is the safer way to be wrong." is replaced, because it called under-confidence a virtue) and `C_ACC_8` → `cAcc8`.

- `C_ACC_6` = "Containing the answer more often than promised means the ranges are too wide: the model is less sure than it
  needs to be. Being wide enough to be right is not a virtue on its own, and the width beside this figure says how wide the
  ranges had to be. The dangerous direction is the other one — a range that misses more often than it claims tells you a
  prediction is firmer than the evidence behind it, and this one does not do that."
- `cAcc8(firstYear, lastYear)` = the existing C_ACC_8 text with "2024–2026" → `${firstYear}–${lastYear}`; fill 2024, 2026.
- `cAcc9(total, unscored, scored, dnfAsMiss)` = "Not every prediction can be scored. Of ${total} race-preview predictions,
  ${unscored} have no classified finishing position to check against — the driver retired, did not start, was disqualified or
  was never classified — so every figure in this section is over the ${scored} that do. Counting each unscorable prediction as
  a miss instead would put the contained-the-finish figure at ${dnfAsMiss}." Fill 685, 100, 585, 80.9 %.
- `cAcc10(width, gridLo, gridHi, share)` = "The typical range ran ${width} places wide on grids of ${gridLo} to ${gridHi}
  cars, covering about ${share} of the finishing positions a driver could take. A range that wide is close to vacuous — it
  says almost nothing — and being right this often is mostly a matter of being wide." Fill 15.1, 20, 22, 77 %. Rendered when
  share ≥ 60 %; otherwise `cAcc10Narrow(width, gridLo, gridHi, share)` = the first sentence alone.
- `C_ACC_11` = "One number scores width and misses together: the width of the range in places, plus ten places for every
  place the finish landed outside it, so lower is better. A range can contain the answer more often and still score worse,
  by being wider than it needs to be."
- `cAcc12(model, k, naive, scored)` = "Our range scores ${model}. A range needing no model at all — the starting-grid slot
  plus or minus ${k} places, cut off at the ends of the grid — scores ${naive} on the same ${scored} predictions." Fill 15.9,
  7, 14.0, 585. Followed by exactly one of: `C_ACC_13_NAIVE` = "The no-model range scores better. Our range is wider than it
  needs to be, not sharper than a grid slot." / `C_ACC_13_MODEL` = "Our range scores better than the no-model one." — chosen
  by naive.winkler < model.winkler (today NAIVE).
- `cAcc14(gridMae, modelMae)` = "As a single guess, the grid slot missed the finish by ${gridMae} places on average; the
  model's expected position missed by ${modelMae}." Fill 2.8, 3.7 (agrees with the home strip's "weaker guide than the grid").
- `cAcc15(nominal)` = "After every round the title model also projects each driver's end-of-season points, with a range built
  to contain the final total ${nominal} of the time. Once a season is over those projections can be marked against the real
  final table, by quarter of the season. Only finished seasons are scored, and each season's last projection is left out:
  by then the total is already known." Fill 80 %.
- `cAcc16(year, covQ1, nominal, maeQ1, covQ4, maeQ4)` = "In ${year}, the range held the eventual final total for ${covQ1} of
  the projections made in the first quarter of the season, against the ${nominal} promised, and the projected total was
  ${maeQ1} points off on average. In the last quarter it held it for ${covQ4}, ${maeQ4} points off." Fill 2024: 14.4 %,
  80 %, 80.4, 88.7 %, 9.0; 2025: 50.0 %, 80 %, 46.3, 86.7 %, 9.4.
- `cAcc17(nSeasons)` = "That is ${nSeasons} finished seasons of evidence, not hundreds of independent trials: every
  projection made after the same round shares the same standings and the same fitted form, so the rows are counts, not a
  calibration. This scores the points projection only. It does not say whether the title probabilities themselves are
  right as often as they claim — ${nSeasons} decided titles cannot show that — and it grades no driver." Fill "two" (word).
- `C_ACC_18` = "Each row pools every driver's projection made in that quarter and checks it against the points that driver
  actually finished on, including drivers who joined or left mid-season. A projection made from the prior alone, before a
  driver had raced, is kept and counted. The final-round row of a finished season is left out because it restates the
  result rather than forecasting it."

## §3 Queries (`web/lib/queries/accuracy.ts`; SQL fetches rows, pure functions in `web/lib/queries/accuracyScore.ts` score them)

Existing four queries untouched (the tiles still read them); `getIntervalCoverageRaw`'s doc comment says "too wide", not "safer".

**`getIntervalSharpness()`** = `cached("accuracy.getIntervalSharpness", …)` → `IntervalSharpness | null`. SQL: `preview_backtest`
(pred_kind = 'oof', NO null filter) LEFT JOIN `sessions` (year, round, kind = 'R') LEFT JOIN `results` (session_id, driver_id)
for `grid_position`; plus per-year `max(grid_position)` over race results as `gridSize` (2025 → 20, 2026 → 22). Rows go to
`scoreIntervals(rows, { alpha: 0.2, ks: [7, 5] })`. Conventions: scored = actual_position not null (denominator of every rate
except `dnfAsMissPct` = inside/total); width = p90 − p10; containment inclusive (= stored `inside_interval`, verified); score =
Winkler at α = 0.2: width + 10·max(p10 − a, 0) + 10·max(a − p90, 0); `shareOfGrid` = mean((width + 1)/gridSize); naive band
`naiveBand(g, k, G) = [max(g − k, 1), min(g + k, G)]` (g < 1 clamps to 1), same containment and score, over scored rows with a
grid (`noGrid` counted, 0 today). Return `{ total, scored, unscored, noGrid, coveragePct, dnfAsMissPct, meanWidth, minWidth,
maxWidth, shareOfGrid, meanAbsError, winkler, gridLo, gridHi, naive: { k, meanWidth, coveragePct, meanAbsError, winkler }[],
bySeason: (same fields + year, gridSize)[] }`. Today (all): 685 / 585 / 100 / 0, 94.7, 80.9, 15.09, 7, 19, 0.773, 3.74, 15.86,
20, 22; naive k = 7: 11.36 / 92.8 / 2.81 / 13.99; k = 5: 8.59 / 86.0 / 2.81 / 13.58. 2025: 399/354/45, 94.9, 84.2, 14.11, 3.55,
14.99, G 20, k7 11.10/91.8/2.90/13.93, k5 8.44/85.3/13.78. 2026: 286/231/55, 94.4, 76.2, 16.60, 4.02, 17.20, G 22,
k7 11.74/94.4/2.67/14.08, k5 8.83/87.0/13.29.

**`getPointsBand()`** = `cached("accuracy.getPointsBand", …)` → `PointsBandSeason[]`. SQL: CTE `fin` = per year max(after_round)
of `driver_standings`; CTE `sched` = per year max(round) of `events`; finished ⇔ fin = sched (no year literal; 2026 is 14 ≠ 23
and joins itself in when it ends). Fetch all `title_odds` rows of finished years with `after_round < finalRound`, LEFT JOIN the
driver's `driver_standings` row at `after_round = finalRound` for `finalPoints`; rows `{ year, afterRound, finalRound,
expectedPoints, p10, p90, isShrunk, finalPoints | null }` (972 today) → `scorePointsBand(rows)`. Conventions: quarter =
floor((afterRound − 1)·4/finalRound) + 1; containment inclusive; MAE = |expectedPoints − finalPoints|; width = p90 − p10; all
row-weighted; `isShrunk` rows kept and counted (`shrunkRows`); rows with null `finalPoints` dropped and counted (`droppedRows`).
Return per season `{ year, finalRound, drivers, rows, shrunkRows, droppedRows, nominalPct: 80, quarters: { q, roundLo, roundHi,
n, coveragePct, meanAbsError, meanWidth }[4], rounds: { afterRound, n, coveragePct, meanAbsError, meanWidth }[] }`. Today 2024
(23 drivers with a projection before the final round — a 24th has only a final-round row — 495 rows, 0 shrunk, 0 dropped): Q1 1–6 125 / 14.4 / 80.4 / 77.7; Q2 7–12 126 / 39.7 / 41.7 / 60.6; Q3 13–18 129 /
55.0 / 25.8 / 47.1; Q4 19–23 115 / 88.7 / 9.0 / 25.4. 2025 (21 drivers, 477 rows, 2 shrunk, 0 dropped): 120 / 50.0 / 46.3 /
75.2; 126 / 57.1 / 33.4 / 61.9; 126 / 54.0 / 25.8 / 48.2; 105 / 86.7 / 9.4 / 26.5. Q1–Q3 reproduce IDEAS exactly; Q4 reads
88.7 / 86.7 rather than IDEAS' 90.6 / 88.9 because the after_round-24 row (p10 = p90 = the known total) is excluded.

## §4 Charts and tables

No chart is added. Every new figure is a `DataTable` with a `caption` prop (the screen reader's region label; the `tables.test.ts`
ratchet for `/accuracy` stays 0): "Three ways to draw the range" (3 rows, open), "Final-points range scored by quarter, {year}" (4 rows
per season, open), the extended per-season interval table (closed), "Every round" (46 rows, closed). Numeric columns `align: "right"`.

## §5 Tests

- `web/lib/accuracy/captions.test.ts` (new; WP-COPY adds `lib/accuracy/*.test.ts` to the `test` script): every export pinned
  byte-for-byte (fixed strings by `assert.equal`; templates called with marker slots `{x}`); no digit, driver name or month in
  any template (regex from `lib/home/captions.test.ts`); `/\b(live|real-time|up to date)\b/i` matches nothing; `C_ACC_6`
  contains "dangerous direction" and not "safer"; `cAcc17` contains "grades no driver" and "not a calibration" and no literal
  "two"; `cAcc9` output contains both the `unscored` and `dnfAsMiss` markers; `cAcc10` contains "vacuous", `cAcc10Narrow` not.
- `web/lib/queries/accuracyScore.test.ts` (new, pure, already in the `lib/queries/*.test.ts` glob). Fixture A, 6 backtest rows
  with grid size 20, k = 7, columns (p10, p90, actual, expected, grid): (5,12,8,8,6) (5,12,14,10,10) (1,10,1,4,1)
  (10,19,3,15,18) (3,15,null,9,4) (2,16,9,9,null). Expected: total 6, scored 5, unscored 1, noGrid 1; coveragePct 60.0
  (rows 1, 3, 6 inside; row 3 is the inclusive boundary); dnfAsMissPct 50.0; meanWidth 9.2, min 7, max 14; per-row Winkler
  7, 27, 9, 79, 14 → mean 27.2; meanAbsError 3.8; shareOfGrid 0.51; naive k = 7 over the 4 gridded rows: bands [1,13] [3,17]
  [1,8] [11,20], widths 12, 14, 7, 9 → 10.5, contained 3 of 4 → 75.0, scores 12, 14, 7, 89 → 30.5, gridMae 5.25;
  `naiveBand(0, 7, 20) = [1, 7]`, `naiveBand(19, 7, 20) = [12, 20]`. Fixture B, one season with finalRound 8, drivers A/B/C/D,
  final points 100 / 60 / 20 / none; rows (driver, afterRound, expected, p10, p90, shrunk): A1 80,50,110; A3 90,70,100;
  A5 95,85,105; A7 98,95,101; A8 100,100,100; B1 90,60,120 shrunk; B3 70,55,85; B5 75,65,85; B7 62,58,66; B8 60,60,60;
  C5 30,25,40; C7 21,18,24; C8 20,20,20; D1 40,20,60. Expected: after_round-8 rows excluded (Q4 n = 3, not 6); droppedRows 1
  (D); shrunkRows 1; drivers 3; rows 10; Q1 rounds 1–2 n 2 cov 100.0 mae 25.0 width 60.0; Q2 3–4 n 2 100.0 10.0 30.0;
  Q3 5–6 n 3 33.3 10.0 18.33; Q4 7–7 n 3 100.0 1.67 6.67. Quarter map asserted for R = 24 and R = 23 (both 1–6/7–12/13–18/19–R−1);
  a season with fin ≠ sched yields no entry.
- a11y: `changed.json` gains records for `C_ACC_6` and `C_ACC_8` (precedent: the "Total SD" record); `captions.baseline.json`
  gains hand-typed `/accuracy` entries (capturedAt 2026-09-22) for the fixed strings only (`C_ACC_1`, `2`, `4`, `6`, `7`, `11`,
  `13_NAIVE`, `18`, `EMPTY`); `/accuracy` is added to `POST` in `regenerate-baseline.mts` and the script run last, after
  WP-PAGE, with the diff checked to touch `/accuracy` entries only — any other diff line is a stop, not a commit.
- Gates, all clean today and after: `npm run check:invariants`, `typecheck`, `test`, `test:a11y` (axe, landmarks, tables, captions).

## §6 Must-not list → copy

| Must not | Where the copy refuses it |
|---|---|
| #2 calibration of p_title | no p_title fetched or rendered; `cAcc17` says `${nSeasons}` decided titles cannot show it |
| #2 per-driver verdicts | no driver name in the section; row-weighted quarters; `cAcc17` ends "it grades no driver" |
| #2 independence / n ≈ 1,000 | `cAcc17` "not hundreds of independent trials"; column header "Driver-rounds", never "trials" |
| #5 under-confidence as a virtue | `C_ACC_6` "not a virtue on its own"; `cAcc10` names the verdict; `C_ACC_13_NAIVE` "wider, not sharper" |
| #5 per-circuit splits | none queried; the only split is by season |
| #5 coverage before the NULL rule | `cAcc9` is the `intervals` Section caption, above the tiles; `cAcc17`'s n sits under the table |
| forbidden words, literals, unmeasured causes | regex and digit/name/month tests; no "why the grid wins" sentence anywhere |

## §7 Work packages (no file in two), dependency order: QUERY ∥ COPY → PAGE → COPY's baseline run; DOCS in parallel

- **WP-QUERY**: `web/lib/queries/accuracy.ts` (+~90: two queries, comment fix), `web/lib/queries/accuracyScore.ts` (new ~110:
  `winkler`, `naiveBand`, `scoreIntervals`, `quarterOf`, `scorePointsBand`), `web/lib/queries/accuracyScore.test.ts` (new ~100).
  Imports drizzle, `@/db`, `@/lib/cache` only. Cache names `accuracy.getIntervalSharpness`, `accuracy.getPointsBand` (unique; grep).
- **WP-COPY**: `web/lib/accuracy/captions.ts` (+~70), `web/lib/accuracy/captions.test.ts` (new ~70), `web/package.json` (test glob),
  `web/tests/a11y/changed.json`, `web/tests/a11y/captions.baseline.json`, `web/tests/a11y/regenerate-baseline.mts` (POST line).
- **WP-PAGE**: `web/app/accuracy/page.tsx` (three edits ≤ 80 lines, anchored at `id="intervals"`, `C_ACC_6`, `id="limits"`), new server
  components `web/components/accuracy/RangeComparatorTable.tsx` and `PointsBandSection.tsx` (no chart). Cut if late: (1) "Every round"
  disclosure, (2) grid ± 5 row, (3) per-season extra columns. Never cut: `cAcc9`, `cAcc10`, `cAcc12` + verdict pair, `cAcc16`, `cAcc17`.
- **WP-DOCS**: `docs/MODE1_SPEC.md` §11.3 addendum (points-band scoring as built, both conventions, today's table); `docs/IDEAS_2026-09.md`
  status lines under §1 #2 and #5 (format of line 97; champion path and §2a as follow-ups); `docs/UX_SPEC.md` untouched (no rule
  changes; §0 honoured through changed.json); a §8 "as built" appended to this file.

## §8 As built (2026-09-22)

- Verification: typecheck, lint (0 warnings), 302 web tests (captions pinned byte-for-byte; scorers reproduce
  fixtures A and B), check:invariants (10 rules), a11y 108/108 with every DataTable captioned (tables ratchet 0);
  both queries run read-only against the local database reproduce every §3 "today" number to the stated precision.
  Rendered on the dev server: cAcc9 685/100/585/80.9 %, cAcc10 15.1 places on 20–22-car grids covering 77 %, cAcc12
  15.9 vs 14.0 with C_ACC_13_NAIVE, cAcc14 2.8 vs 3.7, cAcc16 2024 14.4 % / 80.4 / 88.7 % / 9.0 and 2025 50.0 % /
  46.3 / 86.7 % / 9.4, cAcc17 "two", limits 2024–2026.
- Deviations: 2024 counts 23 drivers, not 24 — the 24th has only a final-round row, which §3 excludes at the source
  (§3 corrected). `naiveBand(0, 7, 20)` = [1, 7] (the formula literally; fixture A wins over the §0 gloss). Percentages
  render as "80.9%" without the thin space, matching the page's existing helper. cAcc17's `{nSeasons}` is filled by a
  small number-to-word helper in PointsBandSection. The per-round table carries its own caption "Final-points range
  scored after every round". The digit sweep exempts C_ACC_2 and C_ACC_4 by name (definitional "0" and "30 %").
  Nothing in §7's "cut if late" list was cut. The deprecated C_ACC_8 alias was removed once the page used cAcc8.
- Production: live 40 s after the push of 4ada882 (2026-09-22). From outside, every sentence carries its measured fill:
  cAcc9 685 / 100 / 585 / 80.9 %; cAcc10 15.1 places, 20–22 cars, 77 %; cAcc12 15.9 vs 14.0 on 585 with C_ACC_13_NAIVE;
  cAcc16 2024 14.4 % / 80.4 / 88.7 % / 9.0 and 2025 50.0 % / 46.3 / 86.7 % / 9.4; cAcc17 "two". TTFB 0.27 s then 0.20 s
  (query layer cached, REVALIDATE_SPEC). The per-round ledger (IDEAS §2a) and the Mode-1 change stay open.
