// MODE2_SPEC §8.2 — the driver-vs-car query layer (WP5). The only new queries file.
// Read-only selects over the frozen `mode2_*` schema, always filtered on the `is_current`
// fit, always returning `null` / `[]` rather than throwing when the fit is missing (FD6).
// No query computes a difference of two stored estimates (FD1) — `mode2_driver_contrast`
// exists for that. `basis` is never dropped from a row type: a `by-analogy` row must be
// renderable in a different visual grammar from a measured one (§8.4).
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  mode2CarHazard,
  mode2CarRating,
  mode2CareerSeason,
  mode2Component,
  mode2Counterfactual,
  mode2DriverContrast,
  mode2DriverRating,
  mode2DriverRatingHistory,
  mode2DriverSkill,
  mode2FitRun,
  mode2QualiRowAudit,
  mode2RowAudit,
  sessionTeams,
  sessions,
  teams,
} from "@/db/schema";
import { SKILL_ORDER, type SkillKey } from "@/lib/driver/captions";
import { TEAM_FALLBACK } from "@/lib/theme";

export type AnchorClass = "anchored" | "component-anchored" | "floating";
export type Basis = "measured" | "by-analogy";

export type DriverRating = {
  driverId: string;
  ratingPp: number;
  ratingLo: number;
  ratingHi: number;
  sdWithin: number;
  sdIsland: number;
  sdTotal: number;
  fracFloating: number;
  evidenceShare: number;
  anchorClass: AnchorClass;
  basis: Basis;
  componentId: string;
  componentLabel: string;
  rankInComponent: number;
  componentSize: number;
  nRaces: number;
  nCells: number;
  nRacesExcluded: number;
};

export type RatingHistoryPoint = {
  throughYear: number;
  ratingPp: number;
  ratingLo: number;
  ratingHi: number;
  nRacesCumulative: number;
  switchedThisYear: boolean;
};

export type SkillRow = {
  // GAPFILL_SPEC §2.2 (v1.8): seven keys, not four. The union is `SkillKey` from
  // `lib/driver/captions`, which also owns the §5.1 display order and the row labels, so
  // the DDL CHECK, the sort and the copy cannot drift apart.
  skill: SkillKey;
  measured: boolean;
  value: number | null;
  valueLo: number | null;
  valueHi: number | null;
  unit: string;
  anchorClass: AnchorClass;
  pctFieldBelow: number | null;
  notMeasuredReason: string | null;
  nObs: number;
};

export type ContrastRow = {
  driverA: string;
  driverB: string;
  kind: "teammate" | "cross";
  deltaPp: number;
  deltaSe: number;
  deltaLo: number;
  deltaHi: number;
  sameComponent: boolean;
  sharedCells: string[];
  nSharedRaces: number;
};

export type CareerSeasonRow = {
  year: number;
  teamId: string;
  actualPoints: number;
  replayPoints: number;
  replayLo: number;
  replayHi: number;
  avgDriverPoints: number;
  avgDriverP10: number;
  avgDriverP90: number;
  contribution: number;
  contributionLo: number;
  contributionHi: number;
  calibrationMae: number;
  basis: Basis;
  anchorClass: AnchorClass;
  /** Races of this season the seat actually covered, out of `roundsInSeason`. */
  starts: number;
  roundsInSeason: number;
  /** Every car of the seat, most-driven first: "ferrari, haas" for a split season. */
  teams: string;
};

export type CarRatingRow = {
  teamId: string;
  year: number;
  gammaPp: number;
  gammaLo: number;
  gammaHi: number;
  slopePp: number;
  slopeLo: number;
  slopeHi: number;
  startPp: number;
  endPp: number;
  slopeSignificant: boolean;
  rankInSeason: number;
  basis: Basis;
  nRaces: number;
};

export type HazardRow = {
  teamId: string;
  year: number;
  retirements: number;
  racingLaps: number;
  hazardPer1000: number;
  hazardLo: number;
  hazardHi: number;
  hazardCarOnly: number;
  hazardCarLo: number;
  hazardCarHi: number;
  rankInSeason: number;
  sufficient: boolean;
};

export type CounterfactualRow = {
  year: number;
  driverId: string;
  teamId: string;
  replacedDriverId: string;
  observed: boolean;
  pointsP10: number;
  pointsP50: number;
  pointsP90: number;
  incumbentActual: number;
  deltaP10: number;
  deltaP50: number;
  deltaP90: number;
  basis: Basis;
  crossComponent: boolean;
  calibrationMae: number;
};

export type FitMeta = {
  fittedAt: string;
  nRows: number;
  nDrivers: number;
  nSessions: number;
  nComponents: number;
  tauDriver: number;
  tauCar: number;
  sigmaResid: number;
  sdRatio: number;
  sdRatioLo: number;
  sdRatioHi: number;
  ciLevel: number;
  floatingDrivers: string[];
};

// --- internals --------------------------------------------------------------

/**
 * The `is_current` fit. The §6.2 partial unique index is per `assumption_set_id`, so
 * more than one row can carry `is_current` when several assumption sets have been
 * fitted; the newest one wins. Returns null on an empty `mode2_fit_run` (FD6).
 */
async function currentFit(): Promise<{ fitId: number } | null> {
  const rows = await db
    .select({ fitId: mode2FitRun.fitId })
    .from(mode2FitRun)
    .where(eq(mode2FitRun.isCurrent, true))
    .orderBy(desc(mode2FitRun.fittedAt), desc(mode2FitRun.fitId))
    .limit(1);
  return rows[0] ?? null;
}

/** Narrowing casts for the text columns the DDL already CHECK-constrains. */
const asAnchor = (v: string): AnchorClass => v as AnchorClass;
const asBasis = (v: string): Basis => v as Basis;

export async function getFitMeta(): Promise<FitMeta | null> {
  const rows = await db
    .select()
    .from(mode2FitRun)
    .where(eq(mode2FitRun.isCurrent, true))
    .orderBy(desc(mode2FitRun.fittedAt), desc(mode2FitRun.fitId))
    .limit(1);
  const fit = rows[0];
  if (!fit) return null;

  // The floating drivers are content, not a diagnostic (§8.6 caption C-WITC-2 names
  // them). They come from the floating components of this fit, in driver_id order.
  const floating = await db
    .select({ driverIds: mode2Component.driverIds })
    .from(mode2Component)
    .where(and(eq(mode2Component.fitId, fit.fitId), eq(mode2Component.isFloating, true)))
    .orderBy(asc(mode2Component.componentId));

  return {
    fittedAt: fit.fittedAt.toISOString(),
    nRows: fit.nRows,
    nDrivers: fit.nDrivers,
    nSessions: fit.nSessions,
    nComponents: fit.nComponents,
    tauDriver: fit.tauDriver,
    tauCar: fit.tauCar,
    sigmaResid: fit.sigmaResid,
    sdRatio: fit.sdRatio,
    sdRatioLo: fit.sdRatioLo,
    sdRatioHi: fit.sdRatioHi,
    ciLevel: fit.ciLevel,
    floatingDrivers: floating.flatMap((c) => c.driverIds).sort(),
  };
}

// --- §8.5 driver page -------------------------------------------------------

/** Shared projection so `getDriverRating` and `getSeasonDecomposition` agree exactly. */
const driverRatingSelection = {
  driverId: mode2DriverRating.driverId,
  ratingPp: mode2DriverRating.ratingPp,
  ratingLo: mode2DriverRating.ratingLo,
  ratingHi: mode2DriverRating.ratingHi,
  sdWithin: mode2DriverRating.sdWithin,
  sdIsland: mode2DriverRating.sdIsland,
  sdTotal: mode2DriverRating.sdTotal,
  fracFloating: mode2DriverRating.fracFloating,
  evidenceShare: mode2DriverRating.evidenceShare,
  anchorClass: mode2DriverRating.anchorClass,
  basis: mode2DriverRating.basis,
  componentId: mode2DriverRating.componentId,
  componentLabel: mode2Component.label,
  rankInComponent: mode2DriverRating.rankInComponent,
  componentSize: mode2Component.nDrivers,
  nRaces: mode2DriverRating.nRaces,
  nCells: mode2DriverRating.nCells,
  nRacesExcluded: mode2DriverRating.nRacesExcluded,
} as const;

type RawDriverRating = { anchorClass: string; basis: string } & Omit<
  DriverRating,
  "anchorClass" | "basis"
>;

const toDriverRating = (r: RawDriverRating): DriverRating => ({
  ...r,
  anchorClass: asAnchor(r.anchorClass),
  basis: asBasis(r.basis),
});

export async function getDriverRating(driverId: string): Promise<DriverRating | null> {
  const fit = await currentFit();
  if (!fit) return null;
  const rows = await db
    .select(driverRatingSelection)
    .from(mode2DriverRating)
    .innerJoin(
      mode2Component,
      and(
        eq(mode2Component.fitId, mode2DriverRating.fitId),
        eq(mode2Component.componentId, mode2DriverRating.componentId),
      ),
    )
    .where(
      and(
        eq(mode2DriverRating.fitId, fit.fitId),
        eq(mode2DriverRating.driverId, driverId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toDriverRating(row) : null;
}

/**
 * Every driver in the same component as `driverId`, INCLUDING him, ordered by
 * `rank_in_component` — the row set §8.5 slot 1 asks `<RatingBar>` to draw.
 *
 * Deliberately one component and no more: a rating is only comparable to the drivers
 * a chain of shared cars connects it to (§1.4, FD3), so this query can never return a
 * grid-wide ordering and the chart never needs the §8.4 separator on a driver page.
 * Returns [] when there is no fit or the driver is not in it (FD6).
 */
export async function getComponentPeers(driverId: string): Promise<DriverRating[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const self = await getDriverRating(driverId);
  if (!self) return [];
  const rows = await db
    .select(driverRatingSelection)
    .from(mode2DriverRating)
    .innerJoin(
      mode2Component,
      and(
        eq(mode2Component.fitId, mode2DriverRating.fitId),
        eq(mode2Component.componentId, mode2DriverRating.componentId),
      ),
    )
    .where(
      and(
        eq(mode2DriverRating.fitId, fit.fitId),
        eq(mode2DriverRating.componentId, self.componentId),
      ),
    )
    .orderBy(asc(mode2DriverRating.rankInComponent), asc(mode2DriverRating.driverId));
  return rows.map(toDriverRating);
}

export async function getRatingHistory(driverId: string): Promise<RatingHistoryPoint[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select({
      throughYear: mode2DriverRatingHistory.throughYear,
      ratingPp: mode2DriverRatingHistory.ratingPp,
      ratingLo: mode2DriverRatingHistory.ratingLo,
      ratingHi: mode2DriverRatingHistory.ratingHi,
      nRacesCumulative: mode2DriverRatingHistory.nRacesCumulative,
      switchedThisYear: mode2DriverRatingHistory.switchedThisYear,
    })
    .from(mode2DriverRatingHistory)
    .where(
      and(
        eq(mode2DriverRatingHistory.fitId, fit.fitId),
        eq(mode2DriverRatingHistory.driverId, driverId),
      ),
    )
    .orderBy(asc(mode2DriverRatingHistory.throughYear));
  return rows;
}

/**
 * All seven §5.1 skills, measured and refused alike, in `SKILL_ORDER`: Race pace,
 * Qualifying pace, Starting-grid pace, Tyre management, Wet weather, Sprint qualifying,
 * Trail braking. Three measured, four refused, SAME visual weight (§3.6).
 * A refused skill carries `measured=false`, null value/interval and a `notMeasuredReason`
 * — DL-11: every key in the CHECK is written as a real row for all 28 drivers, so a
 * refusal is a row with a reason and never an absence.
 */


export async function getDriverSkills(driverId: string): Promise<SkillRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select({
      skill: mode2DriverSkill.skill,
      measured: mode2DriverSkill.measured,
      value: mode2DriverSkill.value,
      valueLo: mode2DriverSkill.valueLo,
      valueHi: mode2DriverSkill.valueHi,
      unit: mode2DriverSkill.unit,
      anchorClass: mode2DriverSkill.anchorClass,
      pctFieldBelow: mode2DriverSkill.pctFieldBelow,
      notMeasuredReason: mode2DriverSkill.notMeasuredReason,
      nObs: mode2DriverSkill.nObs,
    })
    .from(mode2DriverSkill)
    .where(
      and(eq(mode2DriverSkill.fitId, fit.fitId), eq(mode2DriverSkill.driverId, driverId)),
    );
  return rows
    .map((r) => ({
      ...r,
      skill: r.skill as SkillRow["skill"],
      anchorClass: asAnchor(r.anchorClass),
    }))
    .sort((a, b) => SKILL_ORDER.indexOf(a.skill) - SKILL_ORDER.indexOf(b.skill));
}

/**
 * The §5.1 caption slots, all of them `count(*)` off the CURRENT fit — never a literal
 * (DL-13, §5.1: "The panel renders its counts from `count(*)`, never from a hard-coded
 * number"). One round trip; returns null when no qualifying fit exists, in which case the
 * panel renders the six other rows and drops the four new captions rather than guessing.
 *
 * `corrOneLapRace` / `corrOneLapGrid` are the two PEARSON correlations STORED on
 * `mode2_fit_run` by WP-A1 (§1.6, DL-5). The Spearman pair (0.8637 / 0.8835) is measured
 * but not stored anywhere, so it is not available here and is never printed as if it were.
 * `nSqSessions` fills the slot WP-A1 deliberately left unfilled in the stored
 * `sprint_one_lap` refusal reason, for exactly the same DL-13 reason.
 */
export type QualiPanelMeta = {
  nRows: number;
  nSessions: number;
  nDrivers: number;
  nCrossZero: number;
  nQualiLaps: number;
  nSqSessions: number;
  corrOneLapRace: number | null;
  corrOneLapGrid: number | null;
};

export async function getQualiPanelMeta(): Promise<QualiPanelMeta | null> {
  const fit = await currentFit();
  if (!fit) return null;

  const auditRows = await db
    .select({
      nRows: sql<number>`count(*) FILTER (WHERE ${mode2QualiRowAudit.included})::int`,
      nSessions: sql<number>`count(DISTINCT ${mode2QualiRowAudit.sessionId})
        FILTER (WHERE ${mode2QualiRowAudit.included})::int`,
      nSqSessions: sql<number>`count(DISTINCT ${mode2QualiRowAudit.sessionId})
        FILTER (WHERE ${mode2QualiRowAudit.kind} = 'SQ')::int`,
    })
    .from(mode2QualiRowAudit)
    .where(eq(mode2QualiRowAudit.fitId, fit.fitId));
  const audit = auditRows[0];
  if (!audit || audit.nRows === 0) return null;

  // §5.1 C-SKILL-7 counts the ratings whose interval INCLUDES zero — "where two bars
  // overlap, we have not shown you a difference". Counted over the measured rows of this
  // skill only; DL-9 forbids pooling it with race pace, whose field spread differs.
  const skillRows = await db
    .select({
      nDrivers: sql<number>`count(*)::int`,
      nCrossZero: sql<number>`count(*) FILTER (
        WHERE ${mode2DriverSkill.valueLo} <= 0 AND ${mode2DriverSkill.valueHi} >= 0)::int`,
    })
    .from(mode2DriverSkill)
    .where(
      and(
        eq(mode2DriverSkill.fitId, fit.fitId),
        eq(mode2DriverSkill.skill, "one_lap_pace"),
        eq(mode2DriverSkill.measured, true),
      ),
    );
  const skill = skillRows[0];
  if (!skill || skill.nDrivers === 0) return null;

  const corrRows = await db
    .select({
      corrOneLapRace: mode2FitRun.corrOneLapRace,
      corrOneLapGrid: mode2FitRun.corrOneLapGrid,
    })
    .from(mode2FitRun)
    .where(eq(mode2FitRun.fitId, fit.fitId));

  return {
    nRows: audit.nRows,
    nSessions: audit.nSessions,
    nDrivers: skill.nDrivers,
    nCrossZero: skill.nCrossZero,
    // C-SKILL-8 names the same count "new laps"; it is one query, not two facts.
    nQualiLaps: audit.nRows,
    nSqSessions: audit.nSqSessions,
    corrOneLapRace: corrRows[0]?.corrOneLapRace ?? null,
    corrOneLapGrid: corrRows[0]?.corrOneLapGrid ?? null,
  };
}

/**
 * Career team-mate contrasts involving `driverId` (§2.5 — a proper quadratic form
 * computed in Python; never a difference of two marginal intervals, FD1).
 *
 * Rows are ORIENTED so that `driverA === driverId`: where the stored row has this
 * driver as B the sign of `deltaPp` is flipped and `deltaLo`/`deltaHi` are swapped and
 * negated. That is a reflection of one stored estimate, not a new estimate — `deltaSe`
 * is unchanged. `kind` is always `'teammate'` here; `sameComponent` is carried through
 * so the UI can apply the §8.4 separator, and is `true` for every team-mate pair.
 */
export async function getTeammateContrasts(driverId: string): Promise<ContrastRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select({
      driverA: mode2DriverContrast.driverA,
      driverB: mode2DriverContrast.driverB,
      kind: mode2DriverContrast.kind,
      deltaPp: mode2DriverContrast.deltaPp,
      deltaSe: mode2DriverContrast.deltaSe,
      deltaLo: mode2DriverContrast.deltaLo,
      deltaHi: mode2DriverContrast.deltaHi,
      sameComponent: mode2DriverContrast.sameComponent,
      sharedCells: mode2DriverContrast.sharedCells,
      nSharedRaces: mode2DriverContrast.nSharedRaces,
    })
    .from(mode2DriverContrast)
    .where(
      and(
        eq(mode2DriverContrast.fitId, fit.fitId),
        eq(mode2DriverContrast.kind, "teammate"),
        or(
          eq(mode2DriverContrast.driverA, driverId),
          eq(mode2DriverContrast.driverB, driverId),
        ),
      ),
    )
    .orderBy(desc(mode2DriverContrast.nSharedRaces), asc(mode2DriverContrast.driverB));
  return rows.map((r) => {
    const oriented: ContrastRow =
      r.driverA === driverId
        ? { ...r, kind: r.kind as ContrastRow["kind"] }
        : {
            ...r,
            kind: r.kind as ContrastRow["kind"],
            driverA: r.driverB,
            driverB: r.driverA,
            deltaPp: -r.deltaPp,
            deltaLo: -r.deltaHi,
            deltaHi: -r.deltaLo,
          };
    return oriented;
  });
}

/**
 * Car-adjusted career, one row per season the driver raced (§4.3). `basis` is carried
 * through: a `by-analogy` season rests on the pooling prior for a floating component
 * (§1.4) and must be marked differently from a measured one.
 */
export async function getCareerAdjusted(driverId: string): Promise<CareerSeasonRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select({
      year: mode2CareerSeason.year,
      teamId: mode2CareerSeason.teamId,
      actualPoints: mode2CareerSeason.actualPoints,
      replayPoints: mode2CareerSeason.replayPoints,
      replayLo: mode2CareerSeason.replayLo,
      replayHi: mode2CareerSeason.replayHi,
      avgDriverPoints: mode2CareerSeason.avgDriverPoints,
      avgDriverP10: mode2CareerSeason.avgDriverP10,
      avgDriverP90: mode2CareerSeason.avgDriverP90,
      contribution: mode2CareerSeason.contribution,
      contributionLo: mode2CareerSeason.contributionLo,
      contributionHi: mode2CareerSeason.contributionHi,
      calibrationMae: mode2CareerSeason.calibrationMae,
      basis: mode2CareerSeason.basis,
      anchorClass: mode2CareerSeason.anchorClass,
      starts: mode2CareerSeason.starts,
      roundsInSeason: mode2CareerSeason.roundsInSeason,
      teams: mode2CareerSeason.teams,
    })
    .from(mode2CareerSeason)
    .where(
      and(
        eq(mode2CareerSeason.fitId, fit.fitId),
        eq(mode2CareerSeason.driverId, driverId),
      ),
    )
    .orderBy(asc(mode2CareerSeason.year));
  return rows.map((r) => ({
    ...r,
    basis: asBasis(r.basis),
    anchorClass: asAnchor(r.anchorClass),
  }));
}

// --- §5 constructor surface -------------------------------------------------

/**
 * Resolve a `/constructor/[slug]` segment (§5.1 — slug = `teams.team_id`). Accepts the
 * hyphenated and mixed-case spellings so the page can redirect to the canonical one.
 * `colour` and `name` come from `session_teams` for the newest session of `year` (or of
 * any year when `year` is omitted), falling back to `teams.latest_name` and the neutral
 * grey. `years` are the seasons the team actually appears in, so the page resolves and
 * renders empty states even before the mode2 fit exists (FD6).
 */
export async function resolveConstructor(
  slug: string,
  year?: number,
): Promise<{ teamId: string; name: string; colour: string; years: number[] } | null> {
  const canonical = slug.trim().toLowerCase().replace(/-/g, "_");
  const teamRows = await db
    .select({ teamId: teams.teamId, latestName: teams.latestName })
    .from(teams)
    .where(eq(teams.teamId, canonical))
    .limit(1);
  const team = teamRows[0];
  if (!team) return null;

  const yearRows = await db
    .selectDistinct({ year: sessions.year })
    .from(sessionTeams)
    .innerJoin(sessions, eq(sessions.sessionId, sessionTeams.sessionId))
    .where(eq(sessionTeams.teamId, team.teamId))
    .orderBy(asc(sessions.year));
  const years = yearRows.map((r) => r.year);

  const liveryWhere =
    year === undefined
      ? eq(sessionTeams.teamId, team.teamId)
      : and(eq(sessionTeams.teamId, team.teamId), eq(sessions.year, year));
  const livery = await db
    .select({ teamName: sessionTeams.teamName, colour: sessionTeams.colour })
    .from(sessionTeams)
    .innerJoin(sessions, eq(sessions.sessionId, sessionTeams.sessionId))
    .where(liveryWhere)
    .orderBy(desc(sessions.year), desc(sessions.round))
    .limit(1);

  return {
    teamId: team.teamId,
    name: livery[0]?.teamName ?? team.latestName,
    colour: livery[0]?.colour ?? TEAM_FALLBACK,
    years,
  };
}

const carRatingSelection = {
  teamId: mode2CarRating.teamId,
  year: mode2CarRating.year,
  gammaPp: mode2CarRating.gammaPp,
  gammaLo: mode2CarRating.gammaLo,
  gammaHi: mode2CarRating.gammaHi,
  slopePp: mode2CarRating.slopePp,
  slopeLo: mode2CarRating.slopeLo,
  slopeHi: mode2CarRating.slopeHi,
  startPp: mode2CarRating.startPp,
  endPp: mode2CarRating.endPp,
  slopeSignificant: mode2CarRating.slopeSignificant,
  rankInSeason: mode2CarRating.rankInSeason,
  basis: mode2CarRating.basis,
  nRaces: mode2CarRating.nRaces,
} as const;

type RawCarRating = { basis: string } & Omit<CarRatingRow, "basis">;
const toCarRating = (r: RawCarRating): CarRatingRow => ({ ...r, basis: asBasis(r.basis) });

/** Every car of one season, best first by `rank_in_season` (a within-season rank, §6.1). */
export async function getConstructorIndex(year: number): Promise<CarRatingRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select(carRatingSelection)
    .from(mode2CarRating)
    .where(and(eq(mode2CarRating.fitId, fit.fitId), eq(mode2CarRating.year, year)))
    .orderBy(asc(mode2CarRating.rankInSeason), asc(mode2CarRating.teamId));
  return rows.map(toCarRating);
}

/** One constructor across the 2024-26 window, oldest season first. */
export async function getCarRatings(teamId: string): Promise<CarRatingRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select(carRatingSelection)
    .from(mode2CarRating)
    .where(and(eq(mode2CarRating.fitId, fit.fitId), eq(mode2CarRating.teamId, teamId)))
    .orderBy(asc(mode2CarRating.year));
  return rows.map(toCarRating);
}

/**
 * The §5.2 in-season development segments for one season: the same `CarRatingRow`s,
 * ordered by the slope so the steepest developer reads first. `slopeSignificant === false`
 * rows are returned too — the chart renders them at low opacity rather than hiding them.
 */
export async function getDevelopment(year: number): Promise<CarRatingRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select(carRatingSelection)
    .from(mode2CarRating)
    .where(and(eq(mode2CarRating.fitId, fit.fitId), eq(mode2CarRating.year, year)))
    .orderBy(asc(mode2CarRating.slopePp), asc(mode2CarRating.teamId));
  return rows.map(toCarRating);
}

/**
 * Every car-season in the fit, oldest first. The §5.2 multiplicity line ("{nSignificant}
 * of {nCarSeasons} slopes clear zero") is a statement about the WHOLE fit, so counting it
 * over the seasons one constructor happened to race gives the wrong denominator for a team
 * that appeared in a single year. One round trip instead of one per season.
 */
export async function getAllCarRatings(): Promise<CarRatingRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select(carRatingSelection)
    .from(mode2CarRating)
    .where(eq(mode2CarRating.fitId, fit.fitId))
    .orderBy(asc(mode2CarRating.year), asc(mode2CarRating.rankInSeason), asc(mode2CarRating.teamId));
  return rows.map(toCarRating);
}

/**
 * Retirement hazard per 1,000 racing laps for one constructor, oldest season first
 * (§5.3 — "retirements", never "reliability"). `sufficient=false` seasons are returned
 * so the page can say the exposure was too thin rather than silently dropping a year.
 */
export async function getHazards(teamId: string): Promise<HazardRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  return await db
    .select({
      teamId: mode2CarHazard.teamId,
      year: mode2CarHazard.year,
      retirements: mode2CarHazard.retirements,
      racingLaps: mode2CarHazard.racingLaps,
      hazardPer1000: mode2CarHazard.hazardPer1000,
      hazardLo: mode2CarHazard.hazardLo,
      hazardHi: mode2CarHazard.hazardHi,
      hazardCarOnly: mode2CarHazard.hazardCarOnly,
      hazardCarLo: mode2CarHazard.hazardCarLo,
      hazardCarHi: mode2CarHazard.hazardCarHi,
      rankInSeason: mode2CarHazard.rankInSeason,
      sufficient: mode2CarHazard.sufficient,
    })
    .from(mode2CarHazard)
    .where(and(eq(mode2CarHazard.fitId, fit.fitId), eq(mode2CarHazard.teamId, teamId)))
    .orderBy(asc(mode2CarHazard.year));
}

// --- §8.6 "Was it the car?" -------------------------------------------------

/**
 * The season decomposition: every driver who started a race of `year`, their career
 * rating, the car they drove that year, and the pace actually observed.
 *
 * `observedPace` is the mean of the INCLUDED `mode2_row_audit.y_pp` for that driver in
 * that season — an average of stored observations, not a combination of two estimates
 * (FD1). Where a driver changed team mid-season the car shown is the one they raced most
 * in that year, and `observedPace` still averages the whole season.
 *
 * Rows are grouped by component and ordered fastest-first inside each group: grid-wide
 * ordering is allowed here, and only here, because the §8.4 separator between components
 * is what makes it honest (§8.2).
 */
export async function getSeasonDecomposition(
  year: number,
): Promise<{ rating: DriverRating; car: CarRatingRow; observedPace: number }[]> {
  const fit = await currentFit();
  if (!fit) return [];

  const cells = await db
    .select({
      driverId: mode2RowAudit.driverId,
      teamId: mode2RowAudit.teamId,
      nRaces: sql<number>`count(*)::int`,
      sumPace: sql<number>`sum(${mode2RowAudit.yPp})`,
    })
    .from(mode2RowAudit)
    .where(
      and(
        eq(mode2RowAudit.fitId, fit.fitId),
        eq(mode2RowAudit.year, year),
        eq(mode2RowAudit.included, true),
      ),
    )
    .groupBy(mode2RowAudit.driverId, mode2RowAudit.teamId)
    .orderBy(asc(mode2RowAudit.driverId));
  if (cells.length === 0) return [];

  // Per driver: the dominant team (most included races, team_id breaking ties) and the
  // season-wide mean of y_pp.
  const byDriver = new Map<
    string,
    { teamId: string; topRaces: number; races: number; sum: number }
  >();
  for (const c of cells) {
    const prev = byDriver.get(c.driverId);
    const sumPace = Number(c.sumPace ?? 0);
    if (!prev) {
      byDriver.set(c.driverId, {
        teamId: c.teamId,
        topRaces: c.nRaces,
        races: c.nRaces,
        sum: sumPace,
      });
      continue;
    }
    prev.races += c.nRaces;
    prev.sum += sumPace;
    if (c.nRaces > prev.topRaces) {
      prev.teamId = c.teamId;
      prev.topRaces = c.nRaces;
    }
  }
  return await assembleDecomposition(fit.fitId, year, byDriver);
}

/** Second half of `getSeasonDecomposition`: join the ratings and the cars. */
async function assembleDecomposition(
  fitId: number,
  year: number,
  byDriver: Map<string, { teamId: string; races: number; sum: number }>,
): Promise<{ rating: DriverRating; car: CarRatingRow; observedPace: number }[]> {
  const driverIds = [...byDriver.keys()];
  const teamIds = [...new Set([...byDriver.values()].map((d) => d.teamId))];

  const ratingRows = await db
    .select(driverRatingSelection)
    .from(mode2DriverRating)
    .innerJoin(
      mode2Component,
      and(
        eq(mode2Component.fitId, mode2DriverRating.fitId),
        eq(mode2Component.componentId, mode2DriverRating.componentId),
      ),
    )
    .where(
      and(
        eq(mode2DriverRating.fitId, fitId),
        inArray(mode2DriverRating.driverId, driverIds),
      ),
    );
  const ratings = new Map(ratingRows.map((r) => [r.driverId, toDriverRating(r)]));

  const carRows = await db
    .select(carRatingSelection)
    .from(mode2CarRating)
    .where(
      and(
        eq(mode2CarRating.fitId, fitId),
        eq(mode2CarRating.year, year),
        inArray(mode2CarRating.teamId, teamIds),
      ),
    );
  const cars = new Map(carRows.map((r) => [r.teamId, toCarRating(r)]));

  const out: { rating: DriverRating; car: CarRatingRow; observedPace: number }[] = [];
  for (const [driverId, d] of byDriver) {
    const rating = ratings.get(driverId);
    const car = cars.get(d.teamId);
    // A driver or car without a fitted row is dropped rather than rendered half-known.
    if (!rating || !car || d.races === 0) continue;
    out.push({ rating, car, observedPace: d.sum / d.races });
  }
  out.sort(
    (a, b) =>
      a.rating.componentId.localeCompare(b.rating.componentId) ||
      a.rating.ratingPp - b.rating.ratingPp,
  );
  return out;
}

/**
 * "Driver X in constructor Y's car" for one season (§4.4). Every scenario stored for
 * this driver in `year`, including the `observed` one (the car they actually drove), so
 * the control can show the real season beside the extrapolations.
 *
 * `basis` and `crossComponent` are carried through untouched: FD4 forbids rendering the
 * point estimate of a `by-analogy` pairing at all, and a cross-component pairing gets the
 * §8.4 separator. The interval is already widened by the measured interaction term in
 * Python — do not widen it again in the UI.
 */
export async function getCounterfactuals(
  year: number,
  driverId: string,
): Promise<CounterfactualRow[]> {
  const fit = await currentFit();
  if (!fit) return [];
  const rows = await db
    .select({
      year: mode2Counterfactual.year,
      driverId: mode2Counterfactual.driverId,
      teamId: mode2Counterfactual.teamId,
      replacedDriverId: mode2Counterfactual.replacedDriverId,
      observed: mode2Counterfactual.observed,
      pointsP10: mode2Counterfactual.pointsP10,
      pointsP50: mode2Counterfactual.pointsP50,
      pointsP90: mode2Counterfactual.pointsP90,
      incumbentActual: mode2Counterfactual.incumbentActual,
      deltaP10: mode2Counterfactual.deltaP10,
      deltaP50: mode2Counterfactual.deltaP50,
      deltaP90: mode2Counterfactual.deltaP90,
      basis: mode2Counterfactual.basis,
      crossComponent: mode2Counterfactual.crossComponent,
      calibrationMae: mode2Counterfactual.calibrationMae,
    })
    .from(mode2Counterfactual)
    .where(
      and(
        eq(mode2Counterfactual.fitId, fit.fitId),
        eq(mode2Counterfactual.year, year),
        eq(mode2Counterfactual.driverId, driverId),
      ),
    )
    .orderBy(desc(mode2Counterfactual.pointsP50), asc(mode2Counterfactual.teamId));
  return rows.map((r) => ({ ...r, basis: asBasis(r.basis) }));
}
