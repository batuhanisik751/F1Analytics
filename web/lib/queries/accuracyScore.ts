// web/lib/queries/accuracyScore.ts — the pure half of the /accuracy revision (ACCURACY_SPEC §3).
// No database, no imports: accuracy.ts fetches rows and these functions score them, so every
// convention (inclusive containment, the Winkler penalty, the clipped naive band, the quarter
// map, the finished-season exclusion) is testable against the §5 fixtures without a database.
//
// Everything is row-weighted: a mean over rows, never a mean of per-season means.

/** One out-of-fold race-preview prediction joined to the driver's grid slot. */
export type IntervalRow = {
  year: number;
  p10: number;
  p90: number;
  /** Null when the driver had no classified finishing position: the row is counted, not scored. */
  actual: number | null;
  expected: number;
  /** Starting grid position, null when no results row was found. */
  grid: number | null;
  /** The season's grid size (max grid position over race results), null when unknown. */
  gridSize: number | null;
};

export type NaiveScore = {
  k: number;
  meanWidth: number;
  coveragePct: number;
  /** Mean |grid − actual|: the grid slot as a point forecast. */
  meanAbsError: number;
  winkler: number;
};

export type IntervalScore = {
  total: number;
  /** Rows with an actual position: the denominator of every rate except `dnfAsMissPct`. */
  scored: number;
  unscored: number;
  /** Scored rows without a grid slot (or a grid size), excluded from the naive comparator. */
  noGrid: number;
  coveragePct: number;
  /** Inside / total: what coverage reads if every unclassified finish counts as a miss. */
  dnfAsMissPct: number;
  meanWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Mean (width + 1) / gridSize: the share of the grid the band spans. */
  shareOfGrid: number;
  meanAbsError: number;
  winkler: number;
  gridLo: number;
  gridHi: number;
  naive: NaiveScore[];
};

export type IntervalSeasonScore = IntervalScore & { year: number; gridSize: number };

export type IntervalSharpness = IntervalScore & { bySeason: IntervalSeasonScore[] };

export type IntervalOptions = { alpha: number; ks: number[] };

/** Winkler interval score: width plus 2/α per place the actual lands outside the band. */
export function winkler(p10: number, p90: number, actual: number, alpha: number): number {
  const penalty = 2 / alpha;
  return p90 - p10 + penalty * Math.max(p10 - actual, 0) + penalty * Math.max(actual - p90, 0);
}

/** Inclusive containment, the same rule as the stored `inside_interval`. */
export function contains(lo: number, hi: number, actual: number): boolean {
  return actual >= lo && actual <= hi;
}

/**
 * The no-model comparator: the grid slot ± k, clipped to the grid. The lower bound never
 * drops below 1, so a pit-lane start recorded as grid 0 still yields a band inside the grid.
 */
export function naiveBand(g: number, k: number, gridSize: number): [number, number] {
  return [Math.max(g - k, 1), Math.min(g + k, gridSize)];
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (num: number, den: number): number => (den > 0 ? (num / den) * 100 : 0);

function scoreIntervalRows(rows: IntervalRow[], opts: IntervalOptions): IntervalScore {
  const scored = rows.filter((r): r is IntervalRow & { actual: number } => r.actual != null);
  const widths = scored.map((r) => r.p90 - r.p10);
  const inside = scored.filter((r) => contains(r.p10, r.p90, r.actual)).length;
  const sized = scored.filter((r) => r.gridSize != null);
  const gridded = sized.filter((r) => r.grid != null);
  const gridSizes = rows.flatMap((r) => (r.gridSize == null ? [] : [r.gridSize]));
  return {
    total: rows.length,
    scored: scored.length,
    unscored: rows.length - scored.length,
    noGrid: scored.length - gridded.length,
    coveragePct: pct(inside, scored.length),
    dnfAsMissPct: pct(inside, rows.length),
    meanWidth: widths.length ? mean(widths) : 0,
    minWidth: widths.length ? Math.min(...widths) : 0,
    maxWidth: widths.length ? Math.max(...widths) : 0,
    shareOfGrid: sized.length ? mean(sized.map((r) => (r.p90 - r.p10 + 1) / (r.gridSize as number))) : 0,
    meanAbsError: scored.length ? mean(scored.map((r) => Math.abs(r.expected - r.actual))) : 0,
    winkler: scored.length ? mean(scored.map((r) => winkler(r.p10, r.p90, r.actual, opts.alpha))) : 0,
    gridLo: gridSizes.length ? Math.min(...gridSizes) : 0,
    gridHi: gridSizes.length ? Math.max(...gridSizes) : 0,
    naive: opts.ks.map((k) => {
      const bands = gridded.map((r) => {
        const [lo, hi] = naiveBand(r.grid as number, k, r.gridSize as number);
        return { lo, hi, actual: r.actual, grid: r.grid as number };
      });
      const n = bands.length;
      return {
        k,
        meanWidth: n ? mean(bands.map((b) => b.hi - b.lo)) : 0,
        coveragePct: pct(bands.filter((b) => contains(b.lo, b.hi, b.actual)).length, n),
        meanAbsError: n ? mean(bands.map((b) => Math.abs(b.grid - b.actual))) : 0,
        winkler: n ? mean(bands.map((b) => winkler(b.lo, b.hi, b.actual, opts.alpha))) : 0,
      };
    }),
  };
}

/**
 * Score the p10-p90 finishing-position bands against a naive grid ± k comparator, over all
 * rows and per season. Rows without an actual position are counted (`unscored`) and enter
 * only `total` and `dnfAsMissPct`.
 */
export function scoreIntervals(rows: IntervalRow[], opts: IntervalOptions): IntervalSharpness {
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const bySeason = years.map((year) => {
    const season = rows.filter((r) => r.year === year);
    const s = scoreIntervalRows(season, opts);
    return { ...s, year, gridSize: s.gridHi };
  });
  return { ...scoreIntervalRows(rows, opts), bySeason };
}

// --- Points band (title_odds expected_points p10-p90 against the season's final total) ---

/** One title_odds row for a finished season, joined to the driver's final standings total. */
export type PointsBandRow = {
  year: number;
  driverId: string;
  afterRound: number;
  finalRound: number;
  expectedPoints: number;
  p10: number;
  p90: number;
  isShrunk: boolean;
  /** Null when the driver has no standings row at the final round: dropped and counted. */
  finalPoints: number | null;
};

export type PointsBandBucket = {
  n: number;
  /** Null when the bucket has no rows. */
  coveragePct: number | null;
  meanAbsError: number | null;
  meanWidth: number | null;
};

export type PointsBandQuarter = PointsBandBucket & { q: number; roundLo: number; roundHi: number };
export type PointsBandRound = PointsBandBucket & { afterRound: number };

export type PointsBandSeason = {
  year: number;
  finalRound: number;
  drivers: number;
  rows: number;
  shrunkRows: number;
  droppedRows: number;
  nominalPct: 80;
  quarters: PointsBandQuarter[];
  rounds: PointsBandRound[];
};

/** Which quarter of an R-round season a projection made after round r belongs to (1–4). */
export function quarterOf(afterRound: number, finalRound: number): number {
  return Math.floor(((afterRound - 1) * 4) / finalRound) + 1;
}

type Scorable = PointsBandRow & { finalPoints: number };

function bucket(rows: Scorable[]): PointsBandBucket {
  if (rows.length === 0) return { n: 0, coveragePct: null, meanAbsError: null, meanWidth: null };
  return {
    n: rows.length,
    coveragePct: pct(rows.filter((r) => contains(r.p10, r.p90, r.finalPoints)).length, rows.length),
    meanAbsError: mean(rows.map((r) => Math.abs(r.expectedPoints - r.finalPoints))),
    meanWidth: mean(rows.map((r) => r.p90 - r.p10)),
  };
}

/**
 * Score each finished season's points band by quarter and by round. The final-round row is
 * excluded (its band is the known total), shrunk rows are kept and counted, and rows whose
 * driver has no final total are dropped and counted. Seasons arrive already filtered to
 * finished ones by the query; an unfinished season has no rows here and so no entry.
 */
export function scorePointsBand(input: PointsBandRow[]): PointsBandSeason[] {
  const years = [...new Set(input.map((r) => r.year))].sort((a, b) => a - b);
  return years.map((year) => {
    const season = input.filter((r) => r.year === year);
    const finalRound = Math.max(...season.map((r) => r.finalRound));
    const before = season.filter((r) => r.afterRound < finalRound);
    const rows = before.filter((r): r is Scorable => r.finalPoints != null);
    const range = Array.from({ length: finalRound - 1 }, (_, i) => i + 1);
    const quarters = [1, 2, 3, 4].map((q) => {
      const inQ = range.filter((r) => quarterOf(r, finalRound) === q);
      return {
        q,
        roundLo: inQ.length ? inQ[0] : 0,
        roundHi: inQ.length ? inQ[inQ.length - 1] : 0,
        ...bucket(rows.filter((r) => quarterOf(r.afterRound, finalRound) === q)),
      };
    });
    const rounds = range
      .filter((ar) => rows.some((r) => r.afterRound === ar))
      .map((ar) => ({ afterRound: ar, ...bucket(rows.filter((r) => r.afterRound === ar)) }));
    return {
      year,
      finalRound,
      drivers: new Set(rows.map((r) => r.driverId)).size,
      rows: rows.length,
      shrunkRows: rows.filter((r) => r.isShrunk).length,
      droppedRows: before.length - rows.length,
      nominalPct: 80,
      quarters,
      rounds,
    };
  });
}
