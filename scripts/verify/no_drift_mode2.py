"""WP-A4 — the Gap A no-drift gate: prove that nothing stored changed (D7).

`GAPFILL_SPEC §6.3` (row A4) asks for four things, and `DL-26` fixes their character:
this is a **snapshot diff with zero rows permitted to differ**, not a spot check.

    mode2_row_audit      = 983
    mode2_driver_skill   = 196
    the 112 pre-existing rows compared ACROSS THE TWO fit_ids, zero value differences
    mode2_driver_rating / _driver_contrast / _car_rating / _counterfactual untouched

**Scoping correction, and it decides whether the release gate passes.** §2.1 and §2.4
state those counts per fit, not table-wide. The six new §2.4 constants enter the
assumption hash, so the v1.8 recompute necessarily lands as a SECOND `fit_id` under a
new `assumption_set_id` — §2.4 calls that the intended audited path, and up to
`config.MODE2_KEEP_FITS` fits coexist. A check written as a table-wide `count(*) = 983`
therefore reads the intended path as a drift failure. This script pins the counts
**per fit_id** and reports the table totals beside them, so neither the per-fit
contract nor an unexpected extra fit can hide.

The check that actually matters is #3. Counts move when rows are added; a skill fit
that quietly moved `race_pace` adds no rows at all. So the 112 pre-existing rows are
compared value-by-value across the two fits with a symmetric `EXCEPT ALL` over every
non-key column, and any row that survives either direction is printed.

Usage (the DSN default is `f1lab.db.resolve_dsn`; there is no host psql):

    .venv/bin/python scripts/verify/no_drift_mode2.py
    .venv/bin/python scripts/verify/no_drift_mode2.py --baseline-fit 79 --fit 80

Exit 0 = zero differences. Exit 1 = a genuine finding; the actual numbers are printed
and no expected constant is ever adjusted to make the script pass.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from f1lab import db  # noqa: E402

# --- The pinned contract (§6.3 row A4, §2.1, D7). Per fit_id, never table-wide. -------
EXPECTED_ROW_AUDIT_ROWS = 983
EXPECTED_SKILL_ROWS_BASELINE = 112   # 4 keys x 28 drivers, pre-v1.8
EXPECTED_SKILL_ROWS_V18 = 196        # 7 keys x 28 drivers, §2.1's "112 -> 196"
EXPECTED_DRIVERS = 28

PRE_EXISTING_SKILLS = ("grid_pace", "race_pace", "tyre_management", "wet")
NEW_SKILLS = ("one_lap_pace", "sprint_one_lap", "trail_braking")

# §6.3's "untouched" four, each with the columns that are not the fit's own identity.
# A table is untouched iff its row count per fit is equal AND every column of every
# row is equal across the two fits.
UNTOUCHED_TABLES = {
    "mode2_driver_rating": 28,
    "mode2_driver_contrast": 378,
    "mode2_car_rating": 31,
    "mode2_counterfactual": 868,
}

# Beyond §6.3's four. Every remaining `mode2_*` child of `mode2_fit_run` is also a
# stored measured number that D7 covers, and all five diff clean today, so they are
# gated rather than left to a later release to discover. Not in §6.3's list; see the
# deviations note in the WP-A4 report.
ALSO_IDENTICAL_TABLES = {
    "mode2_car_hazard": 31,
    "mode2_career_season": 68,
    "mode2_component": 4,
    "mode2_driver_rating_history": 79,
    "mode2_points_calib": 3,
}

# Identity columns: they are expected to differ across fits and are excluded from
# every value comparison. Everything else must match exactly.
IDENTITY_COLUMNS = ("fit_id", "assumption_set_id")

# The cross-fit diff proves the two fits agree with each other. It cannot prove the
# BASELINE fit is still what it was before v1.8 started — if a bad write moved a value
# in fit 79 and the recompute then copied it into fit 80, the diff stays clean. These
# digests close that hole: they are WP-A0's pre-release snapshot, independently
# re-measured and re-confirmed by WP-A1 after its fit landed.
#   md5(string_agg(row::text, '|' ORDER BY row::text)) over one fit_id.
# Keyed by fit_id because `row::text` includes the fit's own identity columns. A fit
# with no pinned digest is reported, not failed, with its measured digest printed so a
# later release can pin it.
BASELINE_DIGESTS = {
    79: {
        "mode2_driver_skill": "a1f3c4a25a1bb654081f2a81b775bc82",   # 112 rows
        "mode2_row_audit": "e74ff85af2bee45ee067256d8a4829ef",      # 983 rows
    },
}


class Report:
    """Collects findings so every check runs; the script never stops at the first one."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures: list[str] = []

    def ok(self, msg: str) -> None:
        self.lines.append(f"  PASS  {msg}")

    def note(self, msg: str) -> None:
        self.lines.append(f"  ....  {msg}")

    def fail(self, msg: str) -> None:
        self.lines.append(f"  FAIL  {msg}")
        self.failures.append(msg)

    def check(self, cond: bool, msg: str) -> bool:
        (self.ok if cond else self.fail)(msg)
        return cond

    def section(self, title: str) -> None:
        self.lines.append("")
        self.lines.append(title)


def _rows(conn, sql: str, args: tuple = ()) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def _one(conn, sql: str, args: tuple = ()):
    row = _rows(conn, sql, args)[0]
    return row[0] if len(row) == 1 else row


def value_columns(conn, table: str) -> list[str]:
    """Every live column of `table` except the fit's own identity, in ordinal order.

    Read from information_schema rather than hard-coded, so a column added by a later
    migration is compared automatically instead of silently escaping the diff.
    """
    cols = [c for (c,) in _rows(conn, """
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = %s
         ORDER BY ordinal_position""", (table,))]
    if not cols:
        raise SystemExit(f"no such table: public.{table}")
    return [c for c in cols if c not in IDENTITY_COLUMNS]


def resolve_fits(conn, baseline: int | None, current: int | None) -> tuple[int, int]:
    """(baseline_fit, v18_fit): the two most recent fits, oldest first.

    The v1.8 fit is the newest by `fitted_at`; the baseline is the one before it. Both
    can be overridden on the command line so the gate can be re-run against a specific
    pair after a prune.
    """
    fits = _rows(conn, "SELECT fit_id, assumption_set_id, model_version, fitted_at "
                       "FROM mode2_fit_run ORDER BY fitted_at, fit_id")
    if current is None or baseline is None:
        if len(fits) < 2:
            raise SystemExit(
                f"mode2_fit_run carries {len(fits)} fit(s); the cross-fit diff needs two. "
                "Run the v1.8 Mode 2 recompute first (§6.2), or pass --baseline-fit/--fit.")
        baseline = baseline if baseline is not None else fits[-2][0]
        current = current if current is not None else fits[-1][0]
    return baseline, current


def diff_across_fits(conn, table: str, baseline: int, current: int,
                     restrict_skills: tuple[str, ...] | None = None) -> tuple[int, int, list]:
    """Symmetric EXCEPT ALL over every non-identity column. (a_only, b_only, samples).

    `EXCEPT ALL` compares NULLs as equal and floats bit-exactly, which is what "zero
    value differences" has to mean for a stored measured number.
    """
    cols = ", ".join(f'"{c}"' for c in value_columns(conn, table))
    where_b = ""
    args: tuple = (baseline, current)
    if restrict_skills is not None:
        where_b = " AND skill = ANY(%s)"
        args = (baseline, current, list(restrict_skills))
    sql = f"""
        WITH a AS (SELECT {cols} FROM {table} WHERE fit_id = %s),
             b AS (SELECT {cols} FROM {table} WHERE fit_id = %s{where_b})
        SELECT 'baseline_only' AS side, * FROM (SELECT * FROM a EXCEPT ALL SELECT * FROM b) x
        UNION ALL
        SELECT 'current_only', * FROM (SELECT * FROM b EXCEPT ALL SELECT * FROM a) y
    """
    rows = _rows(conn, sql, args)
    a_only = sum(1 for r in rows if r[0] == "baseline_only")
    return a_only, len(rows) - a_only, rows[:6]


def check_row_audit(conn, rep: Report, baseline: int, current: int) -> None:
    """D7's headline pin. 983 PER FIT; the table total is reported, not asserted at 983."""
    rep.section("1. mode2_row_audit stays pinned at 983 rows (D7)")
    per_fit = dict(_rows(conn, "SELECT fit_id, count(*) FROM mode2_row_audit GROUP BY 1"))
    for fit in (baseline, current):
        n = per_fit.get(fit, 0)
        rep.check(n == EXPECTED_ROW_AUDIT_ROWS,
                  f"fit {fit}: mode2_row_audit = {n} (expected {EXPECTED_ROW_AUDIT_ROWS})")
    total = sum(per_fit.values())
    rep.note(f"table-wide total = {total} across {len(per_fit)} fit(s) "
             f"{sorted(per_fit)} — §2.4's intended audited path, not drift")
    stray = {f: n for f, n in per_fit.items() if n != EXPECTED_ROW_AUDIT_ROWS}
    if stray:
        rep.fail(f"fits whose mode2_row_audit is not {EXPECTED_ROW_AUDIT_ROWS}: {stray}")
    a, b, sample = diff_across_fits(conn, "mode2_row_audit", baseline, current)
    rep.check(a == 0 and b == 0,
              f"mode2_row_audit content identical across fits {baseline}/{current}: "
              f"{a} baseline-only, {b} current-only")
    for row in sample:
        rep.note(f"    differing row: {row}")


def check_skill_counts(conn, rep: Report, baseline: int, current: int) -> None:
    """§2.1's '112 -> 196', per fit, with the key sets named rather than assumed."""
    rep.section("2. mode2_driver_skill goes 112 -> 196 (7 keys x 28 drivers)")
    wanted = ((baseline, EXPECTED_SKILL_ROWS_BASELINE), (current, EXPECTED_SKILL_ROWS_V18))
    for fit, want in wanted:
        n, keys, drivers = _one(conn, """
            SELECT count(*), array_agg(DISTINCT skill ORDER BY skill),
                   count(DISTINCT driver_id) FROM mode2_driver_skill WHERE fit_id = %s""",
                                (fit,))
        rep.check(n == want, f"fit {fit}: mode2_driver_skill = {n} (expected {want})")
        rep.check(drivers == EXPECTED_DRIVERS,
                  f"fit {fit}: distinct drivers = {drivers} (expected {EXPECTED_DRIVERS})")
        rep.note(f"fit {fit}: keys = {sorted(keys or [])}")
        if fit == current:
            missing = [k for k in PRE_EXISTING_SKILLS + NEW_SKILLS if k not in (keys or [])]
            rep.check(not missing, f"fit {fit}: all seven keys written (missing: {missing})")
    total = _one(conn, "SELECT count(*) FROM mode2_driver_skill")
    rep.note(f"table-wide total = {total} (per-fit contract, not a table-wide ceiling)")


def check_pre_existing_rows(conn, rep: Report, baseline: int, current: int) -> None:
    """THE check. 112 rows, twelve columns, zero differences (DL-26).

    A refit that quietly moved `race_pace` changes no row count anywhere; it changes a
    double. This is the only check in the script that would catch it.
    """
    rep.section("3. the 112 pre-existing rows, compared ACROSS the two fit_ids")
    n_base = _one(conn, "SELECT count(*) FROM mode2_driver_skill "
                        "WHERE fit_id = %s AND skill = ANY(%s)",
                  (baseline, list(PRE_EXISTING_SKILLS)))
    n_cur = _one(conn, "SELECT count(*) FROM mode2_driver_skill "
                       "WHERE fit_id = %s AND skill = ANY(%s)",
                 (current, list(PRE_EXISTING_SKILLS)))
    rep.check(n_base == EXPECTED_SKILL_ROWS_BASELINE,
              f"fit {baseline}: {n_base} rows on {PRE_EXISTING_SKILLS} "
              f"(expected {EXPECTED_SKILL_ROWS_BASELINE})")
    rep.check(n_cur == EXPECTED_SKILL_ROWS_BASELINE,
              f"fit {current}: {n_cur} rows on the same four keys "
              f"(expected {EXPECTED_SKILL_ROWS_BASELINE})")
    cols = value_columns(conn, "mode2_driver_skill")
    a, b, sample = diff_across_fits(conn, "mode2_driver_skill", baseline, current,
                                    restrict_skills=PRE_EXISTING_SKILLS)
    rep.check(a == 0 and b == 0,
              f"symmetric EXCEPT ALL over {len(cols)} columns "
              f"({', '.join(cols)}): {a} baseline-only, {b} current-only")
    for row in sample:
        rep.note(f"    differing row: {row}")
    if a or b:
        rep.note("    ^ a stored measured number MOVED. Do not re-baseline; find the write.")
    # A leftover key the baseline never carried would slip past the restricted diff.
    extra = [k for (k,) in _rows(conn, "SELECT DISTINCT skill FROM mode2_driver_skill "
                                       "WHERE fit_id = %s", (baseline,))
             if k not in PRE_EXISTING_SKILLS]
    rep.check(not extra, f"fit {baseline} carries only the four pre-existing keys "
                         f"(unexpected: {extra})")


def check_untouched_tables(conn, rep: Report, baseline: int, current: int) -> None:
    """§6.3's four tables. Untouched means equal counts AND equal values, per fit."""
    rep.section("4. mode2_driver_rating / _driver_contrast / _car_rating / _counterfactual")
    for table, want in UNTOUCHED_TABLES.items():
        per_fit = dict(_rows(conn, f"SELECT fit_id, count(*) FROM {table} GROUP BY 1"))
        for fit in (baseline, current):
            n = per_fit.get(fit, 0)
            rep.check(n == want, f"fit {fit}: {table} = {n} (expected {want})")
        cols = value_columns(conn, table)
        a, b, sample = diff_across_fits(conn, table, baseline, current)
        rep.check(a == 0 and b == 0,
                  f"{table} identical across fits over {len(cols)} columns: "
                  f"{a} baseline-only, {b} current-only")
        for row in sample:
            rep.note(f"    differing row: {row}")


def fit_digest(conn, table: str, fit: int) -> str:
    return _one(conn, f"SELECT md5(string_agg(x, '|' ORDER BY x)) FROM "
                      f"(SELECT t::text AS x FROM {table} t WHERE fit_id = %s) q", (fit,))


def check_baseline_digests(conn, rep: Report, baseline: int) -> None:
    """The baseline fit is still WP-A0's pre-release snapshot, not just self-consistent."""
    rep.section("6. the baseline fit against WP-A0's pre-v1.8 snapshot digests")
    pinned = BASELINE_DIGESTS.get(baseline)
    if not pinned:
        rep.note(f"no pinned digest for fit {baseline}; measured, for a later release to pin:")
        for table in ("mode2_driver_skill", "mode2_row_audit"):
            rep.note(f"    {table} @ fit {baseline} = {fit_digest(conn, table, baseline)}")
        return
    for table, want in pinned.items():
        got = fit_digest(conn, table, baseline)
        rep.check(got == want, f"{table} @ fit {baseline}: md5 {got} (expected {want})")


def check_remaining_children(conn, rep: Report, baseline: int, current: int) -> None:
    """The five §6.3 does not name. D7 says "no stored measured number", not "these four"."""
    rep.section("5. the remaining mode2_* children (beyond §6.3's four)")
    for table, want in ALSO_IDENTICAL_TABLES.items():
        per_fit = dict(_rows(conn, f"SELECT fit_id, count(*) FROM {table} GROUP BY 1"))
        for fit in (baseline, current):
            n = per_fit.get(fit, 0)
            rep.check(n == want, f"fit {fit}: {table} = {n} (expected {want})")
        a, b, sample = diff_across_fits(conn, table, baseline, current)
        rep.check(a == 0 and b == 0,
                  f"{table} identical across fits: {a} baseline-only, {b} current-only")
        for row in sample:
            rep.note(f"    differing row: {row}")


def check_fit_metadata(conn, rep: Report, baseline: int, current: int) -> None:
    """Context, not a gate: which two fits were compared and why they are two."""
    rep.section("0. the two fits")
    for fit in (baseline, current):
        row = _rows(conn, "SELECT assumption_set_id, model_version, is_current, fitted_at "
                          "FROM mode2_fit_run WHERE fit_id = %s", (fit,))
        if not row:
            rep.fail(f"fit_id {fit} is not in mode2_fit_run")
            continue
        asid, ver, cur_flag, when = row[0]
        rep.note(f"fit {fit}: assumption_set_id {asid}, model_version {ver}, "
                 f"is_current {cur_flag}, fitted_at {when}")
    rep.check(baseline != current, f"baseline {baseline} and v1.8 {current} are two fits")
    asids = _one(conn, "SELECT count(DISTINCT assumption_set_id) FROM mode2_fit_run "
                       "WHERE fit_id = ANY(%s)", ([baseline, current],))
    rep.note(f"distinct assumption_set_ids across the pair = {asids} "
             "(§2.4: the six new constants enter the hash, so a second fit is expected)")


def run(dsn: str | None, baseline: int | None, current: int | None) -> int:
    rep = Report()
    with db.connect(dsn) as conn:
        baseline, current = resolve_fits(conn, baseline, current)
        check_fit_metadata(conn, rep, baseline, current)
        check_row_audit(conn, rep, baseline, current)
        check_skill_counts(conn, rep, baseline, current)
        check_pre_existing_rows(conn, rep, baseline, current)
        check_untouched_tables(conn, rep, baseline, current)
        check_remaining_children(conn, rep, baseline, current)
        check_baseline_digests(conn, rep, baseline)
    print("no_drift_mode2 — GAPFILL_SPEC D7 / §6.3 row A4 / DL-26")
    print("\n".join(rep.lines))
    print("")
    if rep.failures:
        print(f"RESULT: {len(rep.failures)} FINDING(S) — the release gate does not pass.")
        for f in rep.failures:
            print(f"  - {f}")
        print("Report the actual number. Do not adjust an expected constant to make this pass.")
        return 1
    print(f"RESULT: zero differences. {len(rep.lines)} checks/notes, "
          f"fits {baseline} -> {current}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--baseline-fit", type=int, default=None,
                    help="pre-v1.8 fit_id (default: the second-newest in mode2_fit_run)")
    ap.add_argument("--fit", type=int, default=None,
                    help="v1.8 fit_id (default: the newest in mode2_fit_run)")
    a = ap.parse_args(argv)
    return run(a.dsn, a.baseline_fit, a.fit)


if __name__ == "__main__":
    raise SystemExit(main())
