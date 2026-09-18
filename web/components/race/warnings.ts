// UX_SPEC §3.3 — "Diagnostics leave the header."
//
// `session_ingests.warnings` is written by the Python ingest in pipeline vocabulary, e.g.
// `sim: pit loss not estimable (2 green stops < 5); calibration uses 22.5 s`. Rendered in the
// page header it is a raw diagnostic in front of a reader who has no idea what a green stop is.
//
// This module does two things and neither of them deletes anything (§0):
//   1. `splitWarnings` routes a warning to the section it is about, so it can be shown there.
//   2. `explainWarning` writes a PLAIN SENTENCE saying the same thing. The original string is
//      still rendered (inside a closed disclosure, and in the assumptions panel), so a
//      caption-preservation check finds it either way.

/** Which part of the page a raw ingest warning is actually about. */
export type WarningScope = "sim" | "other";

export function warningScope(w: string): WarningScope {
  return w.startsWith("sim:") ? "sim" : "other";
}

/** Partitions the header's warnings into the ones a section owns and the ones it does not. */
export function splitWarnings(warnings: readonly string[]): { sim: string[]; other: string[] } {
  const sim: string[] = [];
  const other: string[] = [];
  for (const w of warnings) (warningScope(w) === "sim" ? sim : other).push(w);
  return { sim, other };
}

const PIT_LOSS = /^sim: pit loss not estimable \((\d+) green stops? < (\d+)\); calibration uses ([\d.]+) s$/;
const NOT_PARAM = /^sim: (\w+) not parameterised \((\d+) fit rows? < (\d+)\)$/;
const SCATTER = /^sim: (\w+) stint scatter capped \(level ([\d.]+), slope ([\d.]+)\)$/;
const DEG_FLOOR = /^sim: (\w+) degradation (-?[\d.]+) floored to 0$/;
const PIT_FACTOR = /^sim: (SC|VSC) pit factor (-?[\d.]+) from (\d+) stops out of range \[([\d.]+), ([\d.]+)\], using pooled$/;

const COMPOUND: Record<string, string> = {
  SOFT: "the soft tyre",
  MEDIUM: "the medium tyre",
  HARD: "the hard tyre",
  INTERMEDIATE: "the intermediate tyre",
  WET: "the wet tyre",
};

function tyre(name: string): string {
  return COMPOUND[name] ?? `the ${name.toLowerCase()} tyre`;
}

/**
 * The same diagnostic, as a sentence a fan can read. Returns null when the string is not one
 * this module recognises — the caller then shows the original, which is what it does anyway.
 */
export function explainWarning(w: string): string | null {
  let m = PIT_LOSS.exec(w);
  if (m) {
    return (
      `Time lost in the pit lane could not be measured from this race: only ${m[1]} stops were made ` +
      `under green flags and at least ${m[2]} are needed for a usable median. The simulator uses ` +
      `${m[3]} seconds instead, borrowed from comparable races, so every stop it adds or removes is ` +
      `priced at a typical figure rather than this race's own.`
    );
  }
  m = NOT_PARAM.exec(w);
  if (m) {
    return (
      `${tyre(m[1])} has no wear model of its own in this race: ${m[2]} usable stint ` +
      `${Number(m[2]) === 1 ? "lap-row was" : "lap-rows were"} available and ${m[3]} are needed. ` +
      `Strategies that put a car on it are modelled from the other compounds and should be read as a ` +
      `rough guide, not a measurement.`
    );
  }
  m = SCATTER.exec(w);
  if (m) {
    return (
      `Stints on ${tyre(m[1])} varied so much in this race that the spread was capped before ` +
      `simulating (held at ${m[2]} s of stint-to-stint variation and ${m[3]} s per lap of slope). ` +
      `Without the cap the uncertainty band would be wider than the difference between strategies.`
    );
  }
  m = DEG_FLOOR.exec(w);
  if (m) {
    return (
      `${tyre(m[1])} came out of the fit getting faster with age (${m[2]} s per lap), which no tyre ` +
      `does; it was set to zero wear instead. Treat long runs on that compound as flattered.`
    );
  }
  m = PIT_FACTOR.exec(w);
  if (m) {
    const flag = m[1] === "SC" ? "a full safety car" : "a virtual safety car";
    return (
      `The saving from stopping under ${flag} could not be trusted from this race: ${m[3]} stops ` +
      `gave a factor of ${m[2]}, outside the believable range of ${m[4]} to ${m[5]}. The figure from ` +
      `every ingested race is used instead.`
    );
  }
  return null;
}

/** §2.3 — a specific summary line for the block that holds these notes. */
export function warningsSummary(count: number): string {
  return count === 1
    ? "1 thing the simulator could not measure in this race"
    : `${count} things the simulator could not measure in this race`;
}
