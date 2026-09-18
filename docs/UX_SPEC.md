# UX_SPEC — F1 Analytics v1.9: accessibility, progressive disclosure, and plain numbers

**The brief, in the user's words:** *"make everything more accessible and easier on the user
view. On some pages there is a lot that should be in a dropdown view to make it easier to view.
Also there is a lot on the page that has somewhat unexplainable numbers that doesn't make sense
to a user, make them make more sense."*

---

# 0. The one rule that governs everything else

**COLLAPSE, NEVER DELETE.** This app's identity is that it says what it cannot measure. Four of
its seven driver skills ship as refusals. Its charts carry caveats longer than their titles. That
is the product, not clutter.

So progressive disclosure here means **moving a caveat behind a control the reader can open**, and
it must never mean removing one. A reviewer who finds a caveat deleted rather than collapsed should
treat it as a release blocker. Specifically:

- No caption text may be shortened to fit a summary line. Write a new short summary; keep the long
  text inside.
- No refusal (`measured = false`, "not measurable", "no signal") may be collapsed **closed** by
  default. A refusal the reader never opens is a refusal the reader never sees.
- No number may lose its interval, its sample size, or its honesty badge when collapsed.

# 1. What is actually wrong (measured, not assumed)

Findings from reading the running app on 2026-09-17, not from inspecting source.

## 1.1 Density

| Page | Problem |
|---|---|
| `/race/[year]/[round]` | **13 sections, every one expanded.** Qualifying alone stacks five visualisations (classification table, gap bars, per-segment scatter, team-mate table, qualified-vs-started table) each with its own multi-sentence caption. The page has **one** collapse control in total ("Show full classification"). |
| `/race/.../telemetry` | Lap A and Lap B are rendered as **two flat lists of 22 drivers = 44 rows of chrome** before any content. |
| `/season/[year]/was-it-the-car` | The island explanation is repeated **verbatim per affected team** — two near-identical 90-word paragraphs, then a third that restates both. |
| `/driver/[code]` | Seven skill blocks, each with a long caption, plus a ratings-over-time explainer, all expanded. |

## 1.2 Numbers a fan cannot read

Verbatim from the running app:

| Rendered | Problem |
|---|---|
| `−1.100 normal_score` | **A raw database identifier is being rendered as a unit.** |
| `−0.772 %` and `−0.772 pp` | The **same value, two units, one page**. |
| `Total SD 0.120 pp, of which 50.8 % rests on the pooling prior.` | Undefined: "total SD", "pooling prior". |
| `component-anchored - ranked only against the 9 drivers a chain of team moves connects him to.` | "component-anchored" is model vocabulary. |
| `44 observations` / `55 observations` / `62 observations` | "Observation" is unexplained, and the three counts differ per skill with no reason given. |
| `they agree at r = 0.7727` | Four decimals of a statistic most readers cannot interpret. |
| `888 of 1054 laps used (84.3%)` | No statement of why 166 laps were not used. |
| `⚠ sim: pit loss not estimable (2 green stops < 5); calibration uses 22.5 s` | Raw diagnostic text in the page header. |
| `5TH-95TH PERCENTILE RANGE` | Correct, but unexplained as a tile label. |

## 1.3 Confirmed bugs

1. **`app/driver/[code]/page.tsx:142`** — section caption reads *"Four latent skills were fitted.
   Two are shown; two were refused"* while the panel immediately below renders *"seven … three …
   four"*. Stale since v1.8: WP-A2 updated the panel and did not own the page file. **The two
   statements contradict each other on screen.**
2. **Sentence-case bug** — *"We tried to measure seven things. three of them we can show you. four
   of them we cannot"*. The number-word map emits lowercase mid-sentence after a full stop.
3. **`pct_field_below` renders as "ahead of 100 % of the field"** for the top-rated driver. Literally
   true (he leads the field) but reads as a rounding error. Also `GAPFILL_SPEC` DL-9 states this
   statistic is **not comparable across the two `pp` skills**, and the page currently renders it
   identically under all three.

# 2. The disclosure contract

## 2.1 The primitive

`components/ui/Section.tsx` is used by **every page section in the app**, so it is the single lever.
It gains:

```ts
collapsible?: boolean;      // default false — existing call sites are unchanged
defaultOpen?: boolean;      // default true
storageKey?: string;        // per-viewer memory; omit to not remember
summary?: React.ReactNode;  // one line shown when closed — see 2.3
```

Built on native `<details>`/`<summary>` so it is keyboard-operable, screen-reader-announced and
findable by in-page search **without any JavaScript**. Do not hand-roll a button + `aria-expanded`
div; native `<details>` already carries the right semantics, and browser find-in-page can open it.

A separate `components/ui/Disclosure.tsx` provides the same affordance **inside** a section, for
sub-blocks (a long caption, a method note, a secondary table).

## 2.2 What opens and what closes

The rule: **open the answer, close the evidence and the method.**

| Default | Content |
|---|---|
| **OPEN** | The headline result. The chart or table a reader came for. **Every refusal.** Every honesty badge. Anything stating a limit on interpretation that a reader would otherwise act wrongly on. |
| **CLOSED** | Method notes ("how this was fitted"). Diagnostic tables. Full classifications beyond the podium. Per-segment breakdowns. Sensitivity analyses. Assumption panels. Repeated per-entity explanations after the first. |

Per page:

- **Race** — open: qualifying classification, results summary, win probability, race pace, strategy.
  Closed: per-segment scatter, qualified-vs-started, fuel-constant sensitivity, what-was-thrown-away,
  modelling assumptions, degradation detail.
- **Driver** — open: season summary, the rating, all seven skill rows including the four refusals.
  Closed: rating-over-time method note, the cross-skill correlation note.
- **Was it the car?** — open: the split, the spread tiles, the counterfactual picker. Closed: the
  **second and subsequent** per-team island explanations, replaced by one shared explainer plus a
  per-team one-liner naming the team.
- **Telemetry** — the two driver pickers become **comboboxes**, not lists.

## 2.3 The summary line

A closed section must say what is inside it, specifically. `"Details"` is not a summary.
`"Modelling assumptions — 9 constants, last changed 14 Sept"` is. Where a count is available, show
it; a reader deciding whether to open something is deciding whether it is worth the scroll.

# 3. Making the numbers make sense

## 3.1 The `<Metric>` primitive

Every displayed statistic renders through one component that carries four things: **value, unit a
fan understands, plain-language definition, and (where it exists) the interval**. The definition is
reachable by hover **and** by keyboard focus **and** by tap — a tooltip that only works on hover is
inaccessible on a phone and to keyboard users.

## 3.2 The glossary

`web/lib/ui/glossary.ts` holds one entry per term: `term`, `short` (≤ 12 words, for the tooltip),
`long` (a sentence or two, for the glossary page), and `seeAlso`. Terms required at minimum:

`pp` · `normal score` · `percentile range` · `observation` · `pooling prior` · `total SD` ·
`component / anchored` · `evidence share` · `fuel-corrected` · `degradation` · `stint` ·
`green-flag lap` · `Brier score` · `calibration` · `counterfactual` · `island driver` ·
`correlation (r)` · `chord distance` · `DRS no signal` · `trail braking`

A `/glossary` page renders all of them, and every `<Metric>` tooltip links to its anchor.

## 3.3 Fixed vocabulary rules

- **A raw column name must never reach the screen.** `normal_score` renders as
  **"rank scale"**; the unit line explains it is a rank position, not a lap time.
- **One value, one unit, per page.** `pp` is the unit; render it as **"% of a lap"** in fan-facing
  copy and keep `pp` only where the axis is labelled and defined.
- **Every percentage of a lap gets its seconds equivalent** at a stated reference lap, as the
  driver page already does well: `−0.772 % · about 0.69 s on a 90-second lap`.
- **Correlations round to two decimals** and carry a plain gloss: `r = 0.77 — they mostly agree`.
- **Counts get their complement explained**: `888 of 1,054 laps used` gains *"166 excluded: safety
  car, in- and out-laps, and first laps."*
- **Diagnostics leave the header.** The `⚠ sim: pit loss not estimable…` string moves into the
  section it belongs to, rewritten as a sentence.

# 4. Accessibility floor

Non-negotiable, and testable:

1. **Keyboard.** Every control reachable and operable by keyboard, in a sensible order, with a
   visible focus ring. `:focus-visible` must be styled — the current palette has no focus style.
2. **Landmarks and headings.** One `<h1>` per page; `<h2>` per section in document order with no
   skipped levels; `<nav>`, `<main>` present; a **skip-to-content** link as the first focusable element.
3. **Colour is never the only channel.** Team colour, compound colour and the delta trio
   (fastest/personal/slower) must each be paired with text or shape. A reader with colour-vision
   deficiency must get the same information.
4. **Contrast.** Body text ≥ 4.5:1 against its background, large text ≥ 3:1. `--color-muted`
   (`#8b8b97`) on `--color-surface` (`#121216`) must be measured and raised if it fails.
5. **Tables.** Real `<th scope>`, a `<caption>` or `aria-label`, and horizontal scroll containers
   that are themselves keyboard-scrollable and labelled.
6. **Motion.** Honour `prefers-reduced-motion`; no chart animation for readers who ask for none.
7. **Targets.** Interactive targets ≥ 44×44 px on touch.
8. **Live regions.** The ask box announces its result to screen readers.

# 5. Work packages

One owner per file. A package may read anything; it may write only what it owns.

| WP | Owns | Job |
|---|---|---|
| **WP-1** primitives | `components/ui/**`, `web/lib/ui/glossary.ts`, `app/glossary/page.tsx` | `Section` gains disclosure; new `Disclosure`, `Metric`, `TermTip`; the glossary and its page. Ships with its own tests. **Everything else depends on this**, so it lands alone and first. |
| **WP-2** shared consumers | `components/quali/**`, `components/charts/**` | Used by three pages each. Apply the primitives; no page files. |
| **WP-3** race | `app/race/[year]/[round]/page.tsx`, `components/race/**`, `components/sim/**`, `components/preview/**` | The 13-section page. The biggest win. |
| **WP-4** driver | `app/driver/[code]/page.tsx`, `components/driver/**` | Fix the three §1.3 bugs. Disclosure on method notes. Units. |
| **WP-5** season + home | `app/season/[year]/page.tsx`, `app/page.tsx`, `components/season/**`, `components/home/**` | |
| **WP-6** was-it-the-car + constructor | `app/season/[year]/was-it-the-car/page.tsx`, `app/constructor/**`, `components/witc/**`, `components/constructor/**` | De-duplicate the island explanation per §2.2. |
| **WP-7** ask + telemetry | `app/ask/page.tsx`, `app/race/[year]/[round]/telemetry/page.tsx`, `components/ask/**` | Driver pickers → comboboxes. Ask box live region. |
| **WP-8** a11y sweep | `app/globals.css`, `app/layout.tsx`, `tests/a11y/**` | Focus rings, skip link, contrast, reduced motion, and an automated axe pass over every route. |

**Sequencing:** WP-1 alone → WP-2 alone → WP-3…WP-7 in parallel → WP-8.

# 6. Verification

- `npm run typecheck` and `npm run test` clean.
- An **automated accessibility pass** (axe-core) over all nine routes with **zero serious or
  critical violations**; WP-8 owns it and it runs in CI.
- **A caption-preservation test**: every caption string present before this release is still present
  in the DOM after it, open or closed. This is the mechanical enforcement of §0 — collapse, never
  delete — and it is the single most important check in this release.
- Keyboard walk of each page: skip link → nav → each section → each control, focus always visible.
- Every route renders at 400 px wide with no horizontal body scroll.

# 7. As built

*(empty until the release lands)*
