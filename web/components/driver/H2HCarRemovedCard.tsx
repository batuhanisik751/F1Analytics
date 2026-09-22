// H2H_SPEC §3/§6 — Answer 2, the car-removed view. One number: the stored pooled contrast,
// already oriented A−B by getPairContrast (negative = A faster). The two marginal ratings are
// context lines on their own rows and are never differenced; a floating driver's rating is
// hatched (MODE2 §8.4), and a cross-component pair carries C_CONTRAST_2 plus the §8.4 separator.
import type { ModelCall } from "@/lib/driver/h2h";
import {
  C_CONTRAST_2,
  C_H2H_4,
  C_H2H_6,
  C_H2H_7,
  REASON_ASSUMED,
  REASON_NO_ROW,
  REASON_ZERO,
  fill,
} from "@/lib/driver/h2hCaptions";
import type { ContrastRow, DriverRating } from "@/lib/queries/mode2";
import { FLOATING_CHIP_TEXT, GrammarChip, HATCH_BACKGROUND, formatPpValue, isFloating } from "./mode2Grammar";

/** MODE2 §8.4 rule 3, the same words RatingBar draws on its canvas (a client module, so not imported). */
const SEPARATOR_TEXT = "Not comparable to the drivers above";

const REASON_TEXT = { "no-row": REASON_NO_ROW, assumed: REASON_ASSUMED, zero: REASON_ZERO } as const;

export type H2HCarRemovedCardProps = {
  year: number;
  a: string;
  b: string;
  contrast: ContrastRow | null;
  call: ModelCall;
  ratingA: DriverRating | null;
  ratingB: DriverRating | null;
};

/** Two decimals, as the spec prints this number ("0.54 pp"). */
const pp2 = (v: number): string => Math.abs(v).toFixed(2);
const signed2 = (v: number): string => `${v >= 0 ? "+" : "−"}${pp2(v)}`;

/**
 * The interval in the words of the sentence: when it sits on one side of zero it is a range of
 * "how much faster/slower" and prints unsigned, low magnitude first; when it straddles zero the
 * signs are the information and both print signed.
 */
function intervalWords(lo: number, hi: number): { lo: string; hi: string } {
  if (lo >= 0 || hi <= 0) {
    const [m1, m2] = [Math.abs(lo), Math.abs(hi)].sort((x, y) => x - y);
    return { lo: pp2(m1), hi: pp2(m2) };
  }
  return { lo: signed2(lo), hi: signed2(hi) };
}

/** A CSS-only 5th–95th bar: zero at the centre, the interval as a span, the estimate as a dot. */
function IntervalBar({ c, a }: { c: ContrastRow; a: string }): React.JSX.Element {
  const scale = Math.max(1, Math.ceil(Math.max(Math.abs(c.deltaLo), Math.abs(c.deltaHi)) * 2) / 2);
  const x = (v: number): number => 50 + (v / scale) * 50;
  const left = Math.min(x(c.deltaLo), x(c.deltaHi));
  const width = Math.abs(x(c.deltaHi) - x(c.deltaLo));
  return (
    <div
      className="relative mt-3 h-6 w-full rounded border border-grid bg-bg/40"
      data-measured={c.sameComponent ? "true" : "false"}
      aria-hidden="true"
    >
      <span className="absolute inset-y-0 left-1/2 w-px bg-muted/60" />
      <span
        className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm ${c.sameComponent ? "bg-accent/60" : "border border-dashed border-accent/70"}`}
        style={{ left: `${left}%`, width: `${width}%`, backgroundImage: c.sameComponent ? undefined : HATCH_BACKGROUND }}
      />
      <span
        className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${c.sameComponent ? "bg-fg" : "border-2 border-fg bg-transparent"}`}
        style={{ left: `${x(c.deltaPp)}%` }}
      />
      <span className="absolute -bottom-4 left-0 text-[10px] text-muted">−{scale} · {a} faster</span>
      <span className="absolute -bottom-4 right-0 text-[10px] text-muted">+{scale}</span>
    </div>
  );
}

function RatingLine({ name, r }: { name: string; r: DriverRating | null }): React.JSX.Element {
  if (!r) {
    return (
      <p className="text-xs text-muted">
        <span className="font-medium text-fg">{name}</span>: no rating in the current fit.
      </p>
    );
  }
  const floating = isFloating(r.anchorClass);
  return (
    <p className="text-xs text-muted" data-floating={floating ? "true" : "false"}>
      <span className="font-medium text-fg">{name}</span>:{" "}
      {floating ? (
        <>
          <span aria-hidden="true">○ </span>
          <span className="tnum rounded px-1 text-fg" style={{ backgroundImage: HATCH_BACKGROUND }}>
            {formatPpValue(r.ratingPp)}
          </span>{" "}
          <GrammarChip hatched>{FLOATING_CHIP_TEXT}</GrammarChip>
        </>
      ) : (
        <span className="tnum text-fg">{formatPpValue(r.ratingPp)}</span>
      )}{" "}
      % of a lap, 5th–95th {formatPpValue(r.ratingLo)} to {formatPpValue(r.ratingHi)}, {r.nRaces} races,{" "}
      {r.componentLabel}.
    </p>
  );
}

export default function H2HCarRemovedCard({
  year,
  a,
  b,
  contrast,
  call,
  ratingA,
  ratingB,
}: H2HCarRemovedCardProps): React.JSX.Element {
  const cross = contrast !== null && !contrast.sameComponent;
  const iv = contrast ? intervalWords(contrast.deltaLo, contrast.deltaHi) : null;
  return (
    <article className="rounded-lg border border-grid bg-surface p-4" data-h2h-car-removed="true">
      <h3 className="tower-label text-sm text-fg">Car removed, every season the model has seen</h3>
      {cross ? (
        <div
          data-assumed-contrast="true"
          style={{ backgroundImage: HATCH_BACKGROUND }}
          className="mt-3 rounded-lg border border-dashed border-grid px-3 py-2"
        >
          <p className="text-xs leading-relaxed text-fg">{C_CONTRAST_2}</p>
        </div>
      ) : null}
      {contrast && iv ? (
        <>
          <p className="mt-3">
            <span
              className={`tnum text-2xl font-semibold text-fg ${cross ? "rounded px-1" : ""}`}
              style={cross ? { backgroundImage: HATCH_BACKGROUND } : undefined}
              data-hatched={cross ? "true" : "false"}
            >
              {signed2(contrast.deltaPp)}
            </span>
            <span className="ml-1 text-xs text-muted">pp of a lap, {a} − {b}; negative = {a} faster</span>
            {cross ? <GrammarChip hatched className="ml-2">not measured</GrammarChip> : null}
          </p>
          <IntervalBar c={contrast} a={a} />
          {ratingA && ratingB ? (
            <p className="mt-6 text-xs leading-relaxed text-fg">
              {fill(C_H2H_4, {
                a,
                b,
                year,
                absDelta: pp2(contrast.deltaPp),
                fasterOrSlower: contrast.deltaPp < 0 ? "faster" : "slower",
                lo: iv.lo,
                hi: iv.hi,
                nA: ratingA.nRaces,
                nB: ratingB.nRaces,
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {call.kind === "nocall" ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {fill(C_H2H_7, { reason: REASON_TEXT[call.reason] })}
        </p>
      ) : contrast && contrast.kind === "teammate" ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {fill(C_H2H_6, { a, b, nSharedRaces: contrast.nSharedRaces })}
        </p>
      ) : null}
      <div className="mt-3 space-y-1 border-t border-grid/60 pt-3">
        <RatingLine name={a} r={ratingA} />
        {cross ? (
          <div role="separator" className="my-2 border-t-2 border-accent/60 pt-1 text-[11px] uppercase tracking-wide text-muted">
            {SEPARATOR_TEXT}
          </div>
        ) : null}
        <RatingLine name={b} r={ratingB} />
      </div>
    </article>
  );
}
