"""[db] TELEMETRY_SPEC §2.7 (WP-7) — the optionality guarantee, proved rather than assumed.

v1.7 claims that a database which has never run the telemetry pass is **byte-identically
the v1.6 app**. §0.1 states it, §2.7 promises this file asserts it, and §7.1 row 7 makes it
the release's acceptance criterion. It is the most load-bearing claim in the release: it is
what makes a telemetry failure (T8) harmless, and it is the reason migration 0008 was
allowed to be additive-only.

The proof has two halves, and both are falsifiable.

**Static** — the guarantee's *mechanism*. No v1.6 artifact names a v1.7 table: not
migrations 0000-0007, not any of the nine page-query modules the v1.6 pages call, not
`frames.RACE_TABLE_ORDER` / `QUALI_TABLE_ORDER` / `SPRINT_TABLE_ORDER` (§2.8 — the
omission from those lists is the intent, and is otherwise indistinguishable from the bug).
These tests fail the moment someone joins a telemetry table into an existing page.

**Dynamic** — the guarantee's *effect*. The fifty v1.6 page queries are executed against
the live database twice: once as it stands, and once with **every row of all five telemetry
tables deleted**. Each result is canonicalised (keys sorted, dates and non-finite numbers
stringified) and digested. The two digests must match for all fifty, key for key.

The deletion is committed, because the page queries run in a separate Node process and
would not otherwise see it. It is undone in a `finally` from full-fidelity backup tables
taken in the same transaction, and `_restore_orphans()` cleans up after a kill -9 mid-test.
The five tables are re-derivable from the FastF1 cache at zero API calls in any case
(`python -m f1lab.telemetry --session <id>`, §3.5/D12), so the worst case is recoverable.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess

import pytest

from f1lab import db, frames

pytestmark = pytest.mark.db

ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

#: TELEMETRY_SPEC §2.1. The whole of v1.7's storage footprint.
TELEMETRY_TABLES = (
    "lap_telemetry",
    "lap_telemetry_summary",
    "lap_corner_speeds",
    "circuit_corners",
    "circuit_layout",
)

#: Children first. lap_corner_speeds and lap_telemetry_summary -> lap_telemetry -> laps;
#: circuit_corners -> circuit_layout. Verified against pg_constraint, not assumed.
DELETE_ORDER = (
    "lap_corner_speeds",
    "lap_telemetry_summary",
    "lap_telemetry",
    "circuit_corners",
    "circuit_layout",
)
RESTORE_ORDER = tuple(reversed(DELETE_ORDER))

#: The nine modules every v1.6 page imports. `lib/queries/telemetry.ts` is WP-8's and is
#: deliberately NOT in this list: it is the one module that may name these tables.
V16_QUERY_MODULES = (
    "race.ts", "quali.ts", "season.ts", "driver.ts", "home.ts",
    "mode2.ts", "preview.ts", "report.ts", "sim.ts", "shared.ts",
)


# ---------------------------------------------------------------------------
# Static half: the mechanism. No db needed, but the module is db-marked as a whole.
# ---------------------------------------------------------------------------

def test_no_pre_v17_migration_references_a_telemetry_table():
    """§2.7: 'Nothing in migrations 0000-0007 references any new table.'"""
    offenders = {}
    for sql in sorted((WEB / "drizzle").glob("0*.sql")):
        # The contract is about the migrations that predate telemetry: 0000-0007. 0008
        # introduced the tables, and every later migration is free to name them -- 0010
        # (v1.8, GAPFILL_SPEC §4.1) adds five columns to lap_corner_speeds and
        # derive_version to lap_telemetry, so it must. Selecting by "not 0008" made this
        # guard fire on any future telemetry migration, which is not what it is for.
        if sql.name[:4] >= "0008":
            continue
        body = sql.read_text()
        hits = [t for t in TELEMETRY_TABLES if re.search(rf"\b{t}\b", body)]
        if hits:
            offenders[sql.name] = hits
    assert offenders == {}, offenders


def test_no_v16_page_query_module_names_a_telemetry_table():
    """§2.7: 'No existing view, query or page joins them.'

    Falsifiable by construction: add `lap_telemetry` to any v1.6 page query and this
    fails, which is exactly the change that would break the guarantee.
    """
    offenders = {}
    for name in V16_QUERY_MODULES:
        path = WEB / "lib" / "queries" / name
        assert path.exists(), path
        body = path.read_text()
        hits = [t for t in TELEMETRY_TABLES if re.search(rf"\b{t}\b", body)]
        if re.search(r'from "@/lib/queries/telemetry"', body):
            hits.append("imports lib/queries/telemetry")
        if hits:
            offenders[name] = hits
    assert offenders == {}, offenders


def test_telemetry_tables_are_absent_from_every_frames_table_order():
    """§2.8 — stated in the spec *because* the omission looks like the bug.

    `build_race_frames` does `{t: tables[t] for t in RACE_TABLE_ORDER}`, so a table absent
    from the list is silently never written. Here that is the intent: the telemetry tables
    are written by `f1lab/telemetry.py`, and `SPRINT_TABLE_ORDER` staying empty of them is
    what gives kind `S` its no-telemetry guarantee for free.
    """
    for order_name in ("RACE_TABLE_ORDER", "QUALI_TABLE_ORDER", "SPRINT_TABLE_ORDER"):
        order = getattr(frames, order_name)
        assert not (set(order) & set(TELEMETRY_TABLES)), (order_name, order)


def test_the_five_tables_are_known_to_the_schema_contract():
    """The flip side: they are absent from the write path but present in the contract,
    so `db.assert_schema` still guards their shape (§2.4)."""
    for t in TELEMETRY_TABLES:
        assert t in frames.EXPECTED_COLUMNS, t


# ---------------------------------------------------------------------------
# Dynamic half: the effect. The v1.6 page-query surface, run for real.
# ---------------------------------------------------------------------------

#: The harness is written to a tmp dir and run as `cd web && npx tsx <file>` so that
#: web/tsconfig.json resolves the `@/` aliases the query modules import each other
#: through. It is embedded here rather than checked in because §7.0 gives WP-7 exactly
#: one file, and a helper beside it would be a file with no owner.
SMOKE_HARNESS = r"""
import { createHash } from "node:crypto";
import { pool } from "@/db/client";
import * as race from "@/lib/queries/race";
import * as quali from "@/lib/queries/quali";
import * as season from "@/lib/queries/season";
import * as driver from "@/lib/queries/driver";
import * as home from "@/lib/queries/home";
import * as mode2 from "@/lib/queries/mode2";
import * as preview from "@/lib/queries/preview";
import * as report from "@/lib/queries/report";
import * as sim from "@/lib/queries/sim";

const YEAR = 2026;
const ROUND = 13;

/** Key-sorted, NaN/Date/undefined-safe stringify, so the digest cannot depend on key or
 *  row identity ordering that the driver is free to vary between connections. */
function canon(v: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === undefined) return "__undefined__";
    if (typeof x === "number" && !Number.isFinite(x)) return `__num_${String(x)}__`;
    if (typeof x === "bigint") return `__bigint_${x.toString()}__`;
    if (x instanceof Date) return `__date_${x.toISOString()}__`;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      if (seen.has(x)) return "__cycle__";
      seen.add(x);
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

const results: Record<string, string> = {};
async function probe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const s = canon(await fn());
    results[name] = `${createHash("sha256").update(s).digest("hex")}:${s.length}`;
  } catch (err) {
    results[name] = `ERROR:${err instanceof Error ? err.message : String(err)}`;
  }
}

const header = await race.getRaceHeader(YEAR, ROUND);
if (!header) throw new Error(`no race header for ${YEAR} R${ROUND}`);
const raceSid = header.sessionId;
const qualiSessions = await quali.getQualiForRound(YEAR, ROUND);
const qSid = qualiSessions[0]?.sessionId ?? raceSid;
"""

SMOKE_HARNESS += r"""
// ---- SPEC §4.3, the race page --------------------------------------------
await probe("race.header", async () => header);
await probe("race.colours", () => race.getRaceColours(raceSid));
await probe("race.results", () => race.getRaceResults(raceSid));
await probe("race.pace", () => race.getPaceRanking(raceSid));
await probe("race.stints", () => race.getStints(raceSid));
await probe("race.degradation", () => race.getDegradation(raceSid));
await probe("race.trace", () => race.getRaceTrace(raceSid));
await probe("race.teammates", () => race.getTeammateDeltas(raceSid));
await probe("race.sensitivity", () => race.getFuelSensitivity(raceSid));
await probe("race.exclusions", () => race.getExclusionReport(raceSid));
await probe("race.assumptions", () => race.getAssumptions(raceSid));
await probe("race.winprob", () => race.getWinProbability(raceSid));
await probe("race.winprobSwings", () => race.getWinProbSwings(raceSid));
await probe("race.winprobTrust", () => race.getWinProbTrust());
await probe("race.moments", () => race.getRaceMoments(raceSid));
await probe("race.optimalStint", () => race.getOptimalStint(raceSid));
await probe("race.report", () => report.getRaceReport(raceSid));
await probe("race.sim", () => sim.getSimModel(raceSid));

// ---- QUALI_SPEC §6, the qualifying surface --------------------------------
await probe("quali.forRound", async () => qualiSessions);
await probe("quali.segments", () => quali.getQualiSegments(qSid));
await probe("quali.teammates", () => quali.getQualiTeammates(qSid));
await probe("quali.toGrid", () => quali.getQualiToGrid(YEAR, ROUND));
await probe("quali.seasonH2H", () => quali.getSeasonQualiH2H(YEAR));
await probe("quali.seasonPoles", () => quali.getSeasonPoles(YEAR));
await probe("quali.circuitHistory", () =>
  quali.getCircuitQualiHistory(39, ["norris", "russell"]));

// ---- season / home / preview ----------------------------------------------
await probe("season.raceList", () => season.getRaceList(YEAR));
await probe("season.standings", () => season.getStandings(YEAR));
await probe("season.season", () => season.getSeason(YEAR));
await probe("season.titleOdds", () => season.getTitleOdds(YEAR));
await probe("season.titleClinch", () => season.getTitleClinch(YEAR));
await probe("home.home", () => home.getHome());
await probe("preview.round", () => preview.getPreviewRound(YEAR, ROUND));
await probe("preview.order", () => preview.getPreviewOrder(YEAR, ROUND));
await probe("preview.odiStrip", () => preview.getOdiStrip());

// ---- driver page / MODE2_SPEC ---------------------------------------------
const resolved = await driver.resolveDriver("NOR", YEAR);
await probe("driver.resolve", async () => resolved);
await probe("driver.season", () => driver.getDriverSeason(resolved?.driverId ?? "norris", YEAR));
await probe("mode2.fitMeta", () => mode2.getFitMeta());
await probe("mode2.rating", () => mode2.getDriverRating("norris"));
await probe("mode2.peers", () => mode2.getComponentPeers("norris"));
await probe("mode2.history", () => mode2.getRatingHistory("norris"));
await probe("mode2.skills", () => mode2.getDriverSkills("norris"));
await probe("mode2.contrasts", () => mode2.getTeammateContrasts("norris"));
await probe("mode2.career", () => mode2.getCareerAdjusted("norris"));
await probe("mode2.constructorIndex", () => mode2.getConstructorIndex(YEAR));
await probe("mode2.carRatings", () => mode2.getCarRatings("mclaren"));
await probe("mode2.development", () => mode2.getDevelopment(YEAR));
await probe("mode2.allCarRatings", () => mode2.getAllCarRatings());
await probe("mode2.hazards", () => mode2.getHazards("mclaren"));
await probe("mode2.decomposition", () => mode2.getSeasonDecomposition(YEAR));
await probe("mode2.counterfactuals", () => mode2.getCounterfactuals(YEAR, "norris"));

process.stdout.write("---DIGEST---\n" + JSON.stringify(results) + "\n");
await pool.end();
"""

#: Fewer than this many probes means the harness silently lost coverage.
MIN_PROBES = 50


BACKUP_PREFIX = "_v17_optional_backup_"


def _counts(conn) -> dict[str, int]:
    with conn.cursor() as cur:
        return {t: (cur.execute(f"SELECT count(*) FROM {t}").fetchone() or (0,))[0]
                for t in TELEMETRY_TABLES}


def _fingerprint(conn) -> dict[str, str]:
    """A content digest per table, so the restore is checked for fidelity, not row count.

    `md5(t::text)` over the whole row renders arrays and floats through Postgres' own
    output routines, which is exactly the representation a COPY round-trip must preserve.
    """
    out = {}
    with conn.cursor() as cur:
        for t in TELEMETRY_TABLES:
            cur.execute(
                f"SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), '') "
                f"FROM (SELECT md5(t::text) AS h FROM {t} t) s"
            )
            out[t] = (cur.fetchone() or ("",))[0]
    return out


def _restore_orphans(conn) -> None:
    """Undo a backup left behind by a previous run that died between delete and restore."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE %s",
            (BACKUP_PREFIX + "%",),
        )
        orphans = {r[0] for r in cur.fetchall()}
        if not orphans:
            return
        for t in RESTORE_ORDER:
            b = BACKUP_PREFIX + t
            if b in orphans:
                cur.execute(f"INSERT INTO {t} SELECT * FROM {b} ON CONFLICT DO NOTHING")
        for b in orphans:
            cur.execute(f"DROP TABLE {b}")
    conn.commit()


def _run_smoke(harness_path: pathlib.Path) -> dict[str, str]:
    env = dict(os.environ)
    env["NODE_PATH"] = str(WEB / "node_modules")
    proc = subprocess.run(
        ["npx", "tsx", str(harness_path)],
        cwd=WEB, env=env, capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, f"harness failed:\n{proc.stdout[-4000:]}\n{proc.stderr[-4000:]}"
    marker = "---DIGEST---\n"
    assert marker in proc.stdout, proc.stdout[-2000:]
    digest = json.loads(proc.stdout.split(marker, 1)[1].strip().splitlines()[0])
    errors = {k: v for k, v in digest.items() if v.startswith("ERROR")}
    assert errors == {}, errors
    assert len(digest) >= MIN_PROBES, f"only {len(digest)} probes ran"
    return digest


def test_page_query_smoke_set_is_identical_at_zero_telemetry_rows(db_conn, tmp_path):
    """§2.7 / §7.1 row 7 — THE release acceptance criterion.

    Fifty v1.6 page queries, run twice against the live database: once as it stands, and
    once with every row of all five telemetry tables gone. Every digest must match.
    """
    _restore_orphans(db_conn)
    harness = tmp_path / "v16_smoke.mts"
    harness.write_text(SMOKE_HARNESS)

    before_counts = _counts(db_conn)
    assert sum(before_counts.values()) > 0, (
        "this test is vacuous with an already-empty telemetry layer; derive a session "
        "first: python -m f1lab.telemetry --session 16041 --require-cache"
    )
    before_fp = _fingerprint(db_conn)
    with_telemetry = _run_smoke(harness)

    try:
        with db_conn.cursor() as cur:
            for t in DELETE_ORDER:
                cur.execute(
                    f"CREATE TABLE {BACKUP_PREFIX}{t} AS TABLE {t}"  # noqa: S608 - fixed names
                )
                cur.execute(f"DELETE FROM {t}")
        db_conn.commit()
        assert _counts(db_conn) == dict.fromkeys(TELEMETRY_TABLES, 0)

        # The schema contract still holds with the tables empty (§2.4).
        db.assert_schema(db_conn)
        without_telemetry = _run_smoke(harness)
    finally:
        with db_conn.cursor() as cur:
            for t in RESTORE_ORDER:
                cur.execute(f"INSERT INTO {t} SELECT * FROM {BACKUP_PREFIX}{t}")
                cur.execute(f"DROP TABLE {BACKUP_PREFIX}{t}")
        db_conn.commit()

    # The restore was exact, so this test left the corpus as it found it.
    assert _counts(db_conn) == before_counts
    assert _fingerprint(db_conn) == before_fp

    assert set(with_telemetry) == set(without_telemetry)
    drift = {
        k: (with_telemetry[k], without_telemetry[k])
        for k in sorted(with_telemetry)
        if with_telemetry[k] != without_telemetry[k]
    }
    assert drift == {}, (
        f"{len(drift)} of {len(with_telemetry)} v1.6 page queries changed when the "
        f"telemetry rows were removed; §2.7's guarantee is broken: {drift}"
    )


def test_the_smoke_set_would_notice_a_change(db_conn, tmp_path):
    """The negative control. A digest set that cannot see a difference proves nothing, so
    perturb one row the v1.6 pages DO read and confirm the harness reports drift."""
    _restore_orphans(db_conn)
    harness = tmp_path / "v16_smoke.mts"
    harness.write_text(SMOKE_HARNESS)
    baseline = _run_smoke(harness)
    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id FROM sessions WHERE year=2026 AND round=13 AND kind='R'")
        sid = (cur.fetchone() or (None,))[0]
        assert sid is not None
        cur.execute("UPDATE sessions SET total_laps = total_laps + 1 WHERE session_id = %s", (sid,))
    db_conn.commit()
    try:
        perturbed = _run_smoke(harness)
    finally:
        with db_conn.cursor() as cur:
            cur.execute("UPDATE sessions SET total_laps = total_laps - 1 WHERE session_id = %s", (sid,))
        db_conn.commit()
    assert perturbed != baseline, "the harness is blind: it did not see a real data change"
    assert _run_smoke(harness) == baseline, "the perturbation was not undone"


#: Falsified against the unpatched code on 2026 R13: `getAssumptions` returned the raw
#: jsonb, `AssumptionsPanel` renders every non-"ok" entry as the React child `{k}: {v}`,
#: and the WHOLE v1.6 race page went to its error boundary with "Objects are not valid as
#: a React child (found: object with keys {state, layout, corners, drivers, eligible,
#: rows_corner_speeds})". A query-level digest cannot see this: `analytics_status` lives on
#: `session_ingests`, which the telemetry rows' presence does not change. It is the one
#: v1.7 regression that reached an existing page, so it gets its own guard.
STATUS_HARNESS = r"""
import { pool } from "@/db/client";
import { getAssumptions } from "@/lib/queries/race";
const SIDS = __SIDS__;
const bad: Record<string, unknown> = {};
for (const sid of SIDS) {
  const view = await getAssumptions(sid);
  if (!view) continue;
  for (const [k, v] of Object.entries(view.analyticsStatus)) {
    if (typeof v !== "string") bad[`${sid}.${k}`] = v;
  }
}
process.stdout.write("---DIGEST---\n" + JSON.stringify(bad) + "\n");
await pool.end();
"""


def test_every_analytics_status_value_reaching_the_v16_contract_is_a_string(db_conn, tmp_path):
    """§3.6 / D8 put the telemetry state in `analytics_status` as an OBJECT, deliberately, to
    keep migration 0008 additive. `AssumptionsView.analyticsStatus` is typed
    `Record<string, string>` and the panel renders the values. The query boundary must
    therefore flatten, and this asserts it over every session that actually has a
    telemetry entry — not a synthetic one.
    """
    _restore_orphans(db_conn)
    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT session_id FROM session_ingests "
            "WHERE analytics_status ? 'telemetry' ORDER BY session_id"
        )
        sids = [int(r[0]) for r in cur.fetchall()]
        cur.execute(
            "SELECT count(*) FROM session_ingests "
            "WHERE jsonb_typeof(analytics_status -> 'telemetry') = 'object'"
        )
        n_object = int((cur.fetchone() or (0,))[0])
    db_conn.rollback()

    assert sids, (
        "vacuous: no session carries analytics_status['telemetry'] yet. Run the telemetry "
        "pass first: python -m f1lab.telemetry --session 16041 --require-cache"
    )
    assert n_object > 0, (
        "vacuous: every telemetry entry is a bare string, so the object case this test "
        "exists for is not exercised"
    )

    harness = tmp_path / "status.mts"
    harness.write_text(STATUS_HARNESS.replace("__SIDS__", json.dumps(sids)))
    env = dict(os.environ)
    env["NODE_PATH"] = str(WEB / "node_modules")
    proc = subprocess.run(
        ["npx", "tsx", str(harness)],
        cwd=WEB, env=env, capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, f"{proc.stdout[-3000:]}\n{proc.stderr[-3000:]}"
    bad = json.loads(proc.stdout.split("---DIGEST---\n", 1)[1].strip().splitlines()[0])
    assert bad == {}, (
        "a non-string reached AssumptionsView.analyticsStatus; AssumptionsPanel renders "
        f"these as React children and the whole race page will 500: {bad}"
    )
