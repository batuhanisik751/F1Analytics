// GAPFILL_SPEC §5.1 (v1.8) — the /driver skill panel becomes SEVEN rows.
// Three measured, four refused, SAME visual weight (§3.6). Order is `SKILL_ORDER`:
// Race pace · Qualifying pace · Starting-grid pace · Tyre management · Wet weather ·
// Sprint qualifying · Trail braking.
//
// The four rules this file ENFORCES rather than merely captions (§5.1):
//  1. No aggregate branch, ever. There is no code path that sums, averages or ranks two
//     skills, and no element holds two skills' values — `data-skill-value` appears at most
//     once inside any one `data-skill` card, asserted by captions.test.ts.
//  2. D4 / §1.7: `race_pace` and `one_lap_pace` share ONE pp axis, computed once over both
//     intervals. `grid_pace` keeps its own axis and never joins them — a normal score is an
//     ordinal compression and a percent of a lap is not.
//  3. DL-9 / §1.7 condition 2: `pct_field_below` is NOT comparable across the two pp skills
//     (field spreads 0.562 against 0.874), so each bar keeps its own annotation and the two
//     are never subtracted. Nothing here differences two skills.
//  4. §1.4 / §5.1: the thin-data flag (`n_obs < 25`) and the `floating` badge are TWO
//     SEPARATE marks. Both can drive an SE to the shrinkage ceiling for opposite reasons and
//     the panel must never show them in one undifferentiated column.
import Caption from "@/components/ui/Caption";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import TermTip from "@/components/ui/TermTip";
import { formatCorrelation, ppSecondsHint } from "@/components/ui/metricFormat";
import type { GlossaryId } from "@/lib/ui/glossary";
import {
  C_SKILL_2,
  C_SKILL_5,
  C_SKILL_6,
  C_SKILL_7,
  C_SKILL_8,
  ONE_LAP_VERDICT_LINE,
  SHARED_PP_AXIS,
  SHARED_PP_AXIS_LABEL,
  SKILL_LABEL,
  fill,
  type CaptionSlots,
  type SkillKey,
} from "@/lib/driver/captions";
import {
  getQualiPanelMeta,
  type FitMeta,
  type QualiPanelMeta,
  type SkillRow,
} from "@/lib/queries/mode2";
import { GrammarChip } from "./mode2Grammar";

/** §1.5 / §5.1: six drivers sit below this and get a mark of their own, never the hatch. */
export const THIN_DATA_N_OBS = 25;

// UX_SPEC §3.3 — a raw database identifier must never reach the screen, and one value may
// carry only one unit on a page. `pp` is the stored unit and reads "% of a lap" everywhere a
// fan sees it; `normal_score` reads "rank scale" and is never converted to seconds, because a
// rank position is not a lap time (D4 is the same rule, stated as geometry).
const UNIT_LABEL: Record<string, string> = {
  pp: "% of a lap",
  normal_score: "rank scale",
};
const UNIT_TERM: Record<string, GlossaryId> = {
  pp: "pp",
  normal_score: "normal-score",
};
const unitLabel = (unit: string): string => UNIT_LABEL[unit] ?? unit;

/**
 * DL-9 / §1.3.3. Two bugs in one line, both fixed here:
 *   - the top driver used to read "ahead of 100 % of the field", which reads as a rounding
 *     error rather than as "nobody is higher", so the two ends of the scale are named in
 *     words instead of rounded to a percentage;
 *   - the three measured rows used to render this statistic in IDENTICAL words, inviting
 *     exactly the cross-skill comparison DL-9 forbids (the field spreads differ, 0.562
 *     against 0.874), so each line now names its own skill and says it is not comparable.
 */
function fieldPositionLine(row: SkillRow): string | null {
  if (row.pctFieldBelow === null) return null;
  const pct = row.pctFieldBelow;
  const skill = SKILL_LABEL[row.skill].toLowerCase();
  const where =
    pct >= 99.5
      ? `Top of the field on ${skill}: no other driver's estimate is higher`
      : pct <= 0.5
        ? `Bottom of the field on ${skill}: no other driver's estimate is lower`
        : `Ahead of ${Math.round(pct)} % of the field on ${skill}`;
  return `${where} — a position on this row's own scale. The field is spread differently on each skill, so these shares do not compare from row to row.`;
}

/** The one-line §3.6 verdicts that carry no slot. The other three come from §5.1 templates. */
const SKILL_VERDICT_LINE: Record<SkillKey, string | null> = {
  race_pace: null,
  one_lap_pace: null,
  grid_pace:
    "Fitted from starting position; includes grid penalties and pit-lane starts, which we cannot subtract.",
  tyre_management: null,
  wet: null,
  sprint_one_lap: null,
  trail_braking: null,
};

/**
 * Fills a §5.1 template, or returns null when a slot cannot be supplied. DL-13's slots are
 * filled from `count(*)` or not at all: a caption that reaches a fan with a literal
 * `{nSqSessions}` in it is a bug, and so is one that silently drops the number.
 */
function safeFill(template: string | null, slots: Partial<CaptionSlots>): string | null {
  if (!template) return null;
  try {
    return fill(template, slots);
  } catch {
    return null;
  }
}

function verdictLine(
  row: SkillRow,
  fit: FitMeta | null,
  slots: Partial<CaptionSlots>,
): string | null {
  if (row.skill === "race_pace" && fit) {
    return `Fitted from ${fit.nRows} fuel-corrected race pace estimates across ${fit.nSessions} races.`;
  }
  if (row.skill === "one_lap_pace") return safeFill(ONE_LAP_VERDICT_LINE, slots);
  return SKILL_VERDICT_LINE[row.skill];
}

/**
 * One axis half-span covering every interval it is given. Called ONCE for the two pp skills
 * and ONCE for `grid_pace`, which is the whole of D4: a shared span is what makes two bars
 * comparable, so `grid_pace` must never be passed into the same call as the other two.
 */
function axisSpan(rows: SkillRow[]): number {
  let m = 1e-6;
  for (const r of rows) {
    for (const v of [r.value, r.valueLo, r.valueHi]) {
      if (v !== null) m = Math.max(m, Math.abs(v));
    }
  }
  return m * 2;
}

type MeasuredProps = {
  row: SkillRow;
  fit: FitMeta | null;
  slots: Partial<CaptionSlots>;
  span: number;
  /** §5.1: C-SKILL-5 sits under the qualifying bar and nowhere else. */
  caption?: string | null;
  /**
   * UX_SPEC §2.3 — the NEW one-line summary written for `caption`'s disclosure. It is never a
   * truncation of the caption (§0): the full text stays in the DOM behind the control.
   */
  captionSummary?: string;
};

function MeasuredSkill({
  row,
  fit,
  slots,
  span,
  caption,
  captionSummary,
}: MeasuredProps): React.JSX.Element {
  const value = row.value ?? 0;
  const lo = row.valueLo ?? value;
  const hi = row.valueHi ?? value;
  const pos = (v: number): number => ((v + span / 2) / span) * 100;
  const floating = row.anchorClass === "floating";
  const thin = row.nObs < THIN_DATA_N_OBS;
  const verdict = verdictLine(row, fit, slots);
  // C-SKILL-8 rides the hatched bars only: it is the ISLAND caption, and a driver with a
  // measured level has no island to explain (§5.1). Unconditional within that set.
  const island = floating ? safeFill(C_SKILL_8, slots) : null;
  const fieldLine = fieldPositionLine(row);
  return (
    <div data-skill={row.skill} data-measured="true" className="rounded-lg border border-grid bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-fg">{SKILL_LABEL[row.skill]}</span>
        <span className="flex items-center gap-2">
          {/* §5.1: two separate marks. Thin data is a count; floating is a graph fact. */}
          {thin ? <GrammarChip>thin data</GrammarChip> : null}
          {floating ? (
            <GrammarChip hatched>level not measured</GrammarChip>
          ) : (
            <span className="flex items-baseline gap-1">
              <span data-skill-value={row.skill} className="tnum text-lg font-semibold text-fg">
                {value >= 0 ? "+" : "−"}
                {Math.abs(value).toFixed(3)}
              </span>
              {/* §3.3: the fan-facing unit, with its definition on hover, focus AND tap. */}
              <TermTip term={UNIT_TERM[row.unit] ?? "pp"} className="text-xs text-muted">
                {unitLabel(row.unit)}
              </TermTip>
            </span>
          )}
        </span>
      </div>
      <div className="relative mt-3 h-6 rounded bg-bg/60" aria-hidden="true">
        <div
          className="absolute top-1.5 h-3 rounded border border-accent/70"
          style={{
            left: `${pos(Math.min(lo, hi))}%`,
            width: `${Math.max(pos(Math.max(lo, hi)) - pos(Math.min(lo, hi)), 1)}%`,
            backgroundColor: floating ? "transparent" : "rgba(232,163,61,0.55)",
            backgroundImage: floating
              ? "repeating-linear-gradient(45deg, rgba(232,163,61,0.28) 0 2px, transparent 2px 6px)"
              : undefined,
            borderStyle: floating ? "dashed" : "solid",
          }}
        />
      </div>
      {!floating && row.unit === "pp" ? (
        <p className="mt-1 text-xs text-muted">{ppSecondsHint(value)}</p>
      ) : null}
      <p className="tnum mt-1 text-xs text-muted">
        <TermTip term="percentile-range">5th&ndash;95th percentile</TermTip> {lo.toFixed(3)} to{" "}
        {hi.toFixed(3)} {unitLabel(row.unit)} &middot; {row.nObs}{" "}
        <TermTip term="observation">observations</TermTip>
      </p>
      {/* DL-9: this annotation belongs to THIS bar. The two pp skills' field spreads differ
          (tau_car 0.562 against 0.874), so it is never compared across them and never
          subtracted; and it is never printed at all for a floating driver, whose level is
          an assumption rather than a position in the field (§1.4). It now names its own
          skill and its own scale, so the wording cannot be read across rows (§1.3.3). */}
      {!floating && fieldLine ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">{fieldLine}</p>
      ) : null}
      {thin ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Fewer than {THIN_DATA_N_OBS} observations, so this estimate rests more on the model&apos;s
          cautious starting guess than on laps.
        </p>
      ) : null}
      {verdict ? <p className="mt-2 text-xs leading-relaxed text-muted">{verdict}</p> : null}
      {/* §0 COLLAPSE, NEVER DELETE: the method caption moves behind a control, in full, under
          a NEWLY WRITTEN summary line. Nothing is shortened and nothing is dropped. */}
      {caption ? (
        captionSummary ? (
          <Disclosure variant="inline" summary={captionSummary} storageKey={`driver:skill:${row.skill}`}>
            {caption}
          </Disclosure>
        ) : (
          <Caption className="mt-2">{caption}</Caption>
        )
      ) : null}
      {island ? <Caption className="mt-2">{island}</Caption> : null}
    </div>
  );
}

/**
 * §3.6 / D6: the refusal cards ARE the content. DL-11 makes every one of them a real row
 * with a real `not_measured_reason`, so the reason is a prop from the database rather than a
 * string this file invents — and §5.1's two new reasons are byte-verbatim there, pinned on
 * the Python side by tests/test_mode2_skills.py and here by captions.test.ts.
 */
function RefusedSkill({
  row,
  slots,
}: {
  row: SkillRow;
  slots: Partial<CaptionSlots>;
}): React.JSX.Element {
  const stored = safeFill(row.notMeasuredReason, slots);
  const longForm = row.skill === "tyre_management" || row.skill === "wet";
  return (
    <div
      data-skill={row.skill}
      data-measured="false"
      style={{ backgroundImage: "repeating-linear-gradient(45deg, rgba(154,145,135,0.16) 0 2px, transparent 2px 6px)" }}
      className="rounded-lg border border-dashed border-grid bg-surface px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-fg">{SKILL_LABEL[row.skill]}</span>
        <GrammarChip>not measurable</GrammarChip>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-fg">
        {row.skill === "tyre_management" ? (
          <>
            We fitted this and we are not showing a number. Across {row.nObs} stints, the
            differences between drivers came out smaller than their own error bars: how fast a set
            of tyres dies is mostly a property of the track and the compound, with a small team
            component and no driver component we can detect. A ranking here would be a ranking of
            noise.
          </>
        ) : row.skill === "wet" ? (
          <>
            There is no wet-weather rating because there is no wet-weather data we can use. Five
            races since 2024 had real wet-tyre running, and our pace model refuses all five &mdash;
            changing conditions break the fuel correction that everything here is built on. The one
            rainy race it can fit was run entirely on slicks. We would rather show you nothing than
            a number we made up.
          </>
        ) : (
          stored
        )}
      </p>
      {longForm && stored ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">{stored}</p>
      ) : null}
    </div>
  );
}

const NUMBER_WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const word = (n: number): string => NUMBER_WORD[n] ?? String(n);
/**
 * §1.3.2 — the sentence-case bug. The map above is lower case because most of its uses are
 * mid-sentence; three of them start a sentence, and shipped as "three of them we can show
 * you" after a full stop. A number word that opens a sentence goes through here.
 */
const Word = (n: number): string => {
  const w = word(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * §1.3.1 — the section caption on `app/driver/[code]/page.tsx` read "Four latent skills were
 * fitted. Two are shown; two were refused" while this panel rendered "seven … three … four"
 * directly below it. The counts now come from ONE function over the actual rows, so the page
 * and the panel cannot contradict each other again. Never hardcode these numbers.
 */
export function skillCounts(skills: SkillRow[]): {
  total: number;
  measured: number;
  refused: number;
} {
  const measured = skills.filter((r) => r.measured && r.value !== null).length;
  return { total: skills.length, measured, refused: skills.length - measured };
}

/** The derived caption for the section this panel sits in. */
export function skillSectionCaption(skills: SkillRow[]): string {
  const { total, measured, refused } = skillCounts(skills);
  if (total === 0) {
    return "The driver-car model has not been fitted yet, so there is nothing here to show or to refuse.";
  }
  const isAre = (n: number): string => (n === 1 ? "is" : "are");
  const wasWere = (n: number): string => (n === 1 ? "was" : "were");
  if (measured === 0) {
    return (
      `${Word(total)} ${total === 1 ? "skill was" : "skills were"} fitted and none can be shown. ` +
      `All ${word(total)} ${wasWere(total)} refused, and the refusals are the content.`
    );
  }
  return (
    `${Word(total)} ${total === 1 ? "skill was" : "skills were"} fitted. ` +
    `${Word(measured)} ${isAre(measured)} shown; ${word(refused)} ${wasWere(refused)} refused, ` +
    "and the refusals are the content."
  );
}

/** §2.3 — the one-line summary of the same section while it is closed. */
export function skillSectionSummary(skills: SkillRow[]): string {
  const { total, measured, refused } = skillCounts(skills);
  if (total === 0) return "Nothing fitted yet.";
  return `${measured} of ${total} skills carry a number; ${refused} are refusals, each with its reason.`;
}

/** §1.2 — the three observation counts differ per skill and the page never said why. */
const OBSERVATION_COUNTS_SUMMARY =
  "Why the number of observations changes from row to row";

export type SkillPanelViewProps = {
  skills: SkillRow[];
  fit?: FitMeta | null;
  quali?: QualiPanelMeta | null;
};

/**
 * The pure half — no database, no async — so captions.test.ts can server-render it and
 * assert on the DOM. `SkillPanel` below is the server component the page mounts.
 */
export function SkillPanelView({
  skills,
  fit = null,
  quali = null,
}: SkillPanelViewProps): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <EmptyState
        title="What we can and cannot measure"
        reason="SimNotEstimable: mode2 fit did not converge"
      />
    );
  }
  // A stored correlation that is NULL (a pre-v1.8 fit) becomes an absent slot, and
  // `safeFill` then drops the caption rather than printing "r = null" (DL-13).
  const slots: Partial<CaptionSlots> = quali
    ? {
        ...quali,
        corrOneLapRace: quali.corrOneLapRace ?? undefined,
        corrOneLapGrid: quali.corrOneLapGrid ?? undefined,
      }
    : {};
  const shown = (k: SkillKey): SkillRow | undefined => skills.find((s) => s.skill === k);
  const isMeasured = (r: SkillRow): boolean => r.measured && r.value !== null;

  // D4: ONE call for the two pp skills, so they share one scale. `grid_pace` gets its own
  // call and its own panel row and never joins them (§1.7). There is no third call, and no
  // code path where a normal score and a percent reach the same `axisSpan`.
  const sharedRows = SHARED_PP_AXIS.map(shown).filter(
    (r): r is SkillRow => r !== undefined && isMeasured(r),
  );
  const sharedSpan = axisSpan(sharedRows);
  const gridPace = shown("grid_pace");
  const gridMeasured = gridPace !== undefined && isMeasured(gridPace);
  const oneLap = shown("one_lap_pace");
  const oneLapMeasured = oneLap !== undefined && isMeasured(oneLap);
  const refused = skills.filter((r) => !isMeasured(r));
  const measuredCount = skills.length - refused.length;
  // §3.3: a correlation is two decimals plus a gloss a reader can act on. The stored value
  // keeps its four decimals inside C-SKILL-6, which is published copy and stays verbatim.
  const correlationSummary =
    slots.corrOneLapRace !== undefined
      ? `How qualifying pace and race pace relate — ${formatCorrelation(slots.corrOneLapRace)}`
      : "How qualifying pace, race pace and starting-grid pace relate to each other";

  return (
    <>
      <Caption className="mt-0 mb-3 text-sm text-fg">
        We tried to measure {word(skills.length)} things. {Word(measuredCount)} of them we can show
        you. {Word(refused.length)} of them we cannot, and the reasons are below &mdash; they are
        part of the answer, not a disclaimer.
      </Caption>

      {/* §1.2 — "44 observations" / "55 observations" / "62 observations" appeared with no
          statement of why the three differ. Closed by default: it is a method note, and §2.2
          closes method notes. Nothing that was on the page before is inside it. */}
      <Disclosure
        variant="inline"
        summary={OBSERVATION_COUNTS_SUMMARY}
        storageKey="driver:skill-observations"
      >
        An observation is one usable lap, session or team-mate comparison that fed that row. Each
        row can only count the laps that answer its own question: race pace counts fuel-corrected
        race laps, qualifying pace counts first-segment qualifying laps, starting-grid pace counts
        race starts. So the three counts are different sample sizes for three different questions,
        not three measurements of the same thing &mdash; and a row with fewer observations sits
        closer to the model&apos;s cautious starting guess for that reason alone.
      </Disclosure>

      <section data-axis="pp" aria-label={SHARED_PP_AXIS_LABEL}>
        {oneLapMeasured ? (
          <Caption className="mt-0 mb-2 text-fg">{safeFill(C_SKILL_7, slots)}</Caption>
        ) : null}
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
          <TermTip term="pp">{SHARED_PP_AXIS_LABEL}</TermTip>
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {sharedRows.map((row) => (
            <MeasuredSkill
              key={row.skill}
              row={row}
              fit={fit}
              slots={slots}
              span={sharedSpan}
              caption={row.skill === "one_lap_pace" ? safeFill(C_SKILL_5, slots) : null}
              captionSummary={
                row.skill === "one_lap_pace"
                  ? "How this qualifying number is fitted, and why a driver who cruises Q1 is measured on the cruise"
                  : undefined
              }
            />
          ))}
        </div>
        {/* §2.2 names the cross-skill correlation note as CLOSED on this page. The summary
            carries the correlation at §3.3's two decimals with a plain gloss; C-SKILL-6 itself
            is unchanged and unshortened inside (§0). */}
        {oneLapMeasured ? (
          <Disclosure
            variant="inline"
            summary={correlationSummary}
            storageKey="driver:skill-correlation"
          >
            {safeFill(C_SKILL_6, slots)}
          </Disclosure>
        ) : null}
      </section>

      {gridMeasured ? (
        <section data-axis="normal_score" className="mt-4">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
            <TermTip term="normal-score">Rank scale</TermTip> &mdash; a rank position among
            drivers, not a lap time. On its own axis.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <MeasuredSkill
              row={gridPace}
              fit={fit}
              slots={slots}
              span={axisSpan([gridPace])}
              caption={C_SKILL_2}
              captionSummary="Why this bar sits on its own scale, and what it counts as driver slowness"
            />
          </div>
        </section>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {refused.map((row) => (
          <RefusedSkill key={row.skill} row={row} slots={slots} />
        ))}
      </div>
    </>
  );
}

export type SkillPanelProps = { skills: SkillRow[]; fit?: FitMeta | null };

/**
 * The server component `app/driver/[code]/page.tsx` mounts. It fetches its own §5.1 caption
 * slots so the call site does not change: every one of them is a `count(*)` on the current
 * fit, and none of them is a number this file knows (DL-13).
 */
export default async function SkillPanel({
  skills,
  fit = null,
}: SkillPanelProps): Promise<React.JSX.Element> {
  const quali = await getQualiPanelMeta();
  return <SkillPanelView skills={skills} fit={fit} quali={quali} />;
}
