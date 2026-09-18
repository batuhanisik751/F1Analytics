// UX_SPEC §3.1 — every displayed statistic goes through here, so that it always carries four
// things: the value, a unit a fan understands, a plain-language definition, and its interval
// where one exists.
//
// §3.3 vocabulary rules are enforced by the helpers below rather than by each call site:
//   - a raw column name never reaches the screen ("normal_score" -> "rank scale");
//   - one value, one unit, per page ("pp" is rendered "% of a lap");
//   - every % of a lap carries its seconds equivalent at a stated reference lap;
//   - correlations round to two decimals and carry a gloss.
// They live in ./metricFormat (pure, no JSX) and are re-exported here for convenience.
import TermTip from "./TermTip";
import type { GlossaryId } from "@/lib/ui/glossary";

import {
  correlationGloss,
  formatCorrelation,
  ppSecondsHint,
  ppToSeconds,
  REFERENCE_LAP_S,
  usedOf,
} from "./metricFormat";

export { correlationGloss, formatCorrelation, ppSecondsHint, ppToSeconds, REFERENCE_LAP_S, usedOf };

export type MetricProps = {
  /** What the number is. Rendered as the caps micro-label. */
  label: React.ReactNode;
  value: React.ReactNode;
  /** Fan-readable unit: "% of a lap", "s per lap", "rank scale". Never a column name. */
  unit?: React.ReactNode;
  /** Glossary term the definition comes from; makes label and unit hoverable/focusable/tappable. */
  term?: GlossaryId;
  /** The interval, already formatted, e.g. "−0.30 to +0.14". Dropping it when collapsing is forbidden (§0). */
  interval?: React.ReactNode;
  /** What kind of interval it is. Shown beside it so the number is never bare. */
  intervalLabel?: string;
  /** Supporting line: the seconds equivalent, the sample size, an honesty note. */
  hint?: React.ReactNode;
  size?: "sm" | "lg";
  className?: string;
};

export default function Metric({
  label,
  value,
  unit,
  term,
  interval,
  intervalLabel = "90 % range",
  hint,
  size = "lg",
  className,
}: MetricProps): React.JSX.Element {
  const labelNode = (
    <span className="tower-label text-[11px] text-muted">{label}</span>
  );
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <div className="flex items-center gap-1">
        {term ? <TermTip term={term}>{labelNode}</TermTip> : labelNode}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
        <span
          className={`tnum font-bold leading-none tracking-tight text-fg ${
            size === "lg" ? "text-[1.75rem]" : "text-lg"
          }`}
        >
          {value}
        </span>
        {unit ? <span className="text-xs text-muted">{unit}</span> : null}
      </div>
      {interval ? (
        <div className="tnum mt-1 text-xs text-muted">
          <span className="tower-label mr-1 text-[10px]">{intervalLabel}</span>
          {interval}
        </div>
      ) : null}
      {hint ? <div className="mt-1 text-xs leading-snug text-muted">{hint}</div> : null}
    </div>
  );
}
