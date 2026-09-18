#!/usr/bin/env python3
"""GAPFILL_SPEC §6.3 (WP-B4) -- prove the Gap B re-derive changed nothing pre-existing.

D7: *no stored measured number may change silently.* Migration 0010 appends five columns
to ``lap_corner_speeds``, and filling them means re-running the whole second pass with
``--force`` over 75 sessions: the same code path that writes ``apex_speed_kph``,
``brake_point_m`` and every ``lap_telemetry_summary`` figure that is already on a page.
A re-derive that quietly moved one of those would be indistinguishable from a successful
backfill, because the backfill's own census only counts the new column.

So this script does two separate things, and both must pass:

1. **Snapshot / diff.** Every column that existed *before* migration 0010 is dumped to
   CSV before the re-derive and compared row-for-row after it. **Zero rows may differ**
   (§4.3). The comparison is keyed on the primary key, not on file order, and it reports
   *which column* and *how many rows* rather than a single boolean, because the finding
   this script exists to produce is a release blocker that someone has to act on.
2. **An exact backfill count.** ``measured`` must equal
   ``telemetry.TRAIL_EXPECTED_MEASURED_ROWS`` -- WP-B1's re-derived 9,408 -- and not
   "> 0". R1 is that the run reports success while shipping ~25,000 NULLs; "> 0" passes
   that. It also passes a run that half-completed, and a run whose gates were loosened
   into producing *more* measured rows than the derivation licenses. **Zero is not the
   only wrong answer**, so the acceptance is an equality on all four census numbers.

Usage (the re-derive is long; run the phases separately and background phase 2):

    python scripts/verify/no_drift_telemetry.py snapshot --dir output/wpB4/pre
    python scripts/verify/no_drift_telemetry.py rederive --dir output/wpB4/pre
    python scripts/verify/no_drift_telemetry.py verify --before output/wpB4/pre

Run the re-derive through this script's ``rederive`` phase, not by hand. A bare
``python -m f1lab.telemetry --force`` is **unscoped**: it derives every eligible session,
including races that have never had telemetry, and grows ``lap_corner_speeds`` past its
pinned 24,963 rows. ``rederive`` passes ``--session`` for each of the snapshot's own
sessions, so the run touches exactly the rows the diff is about to compare.

``all`` runs the three in one process for a release operator who wants a single exit code.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from f1lab import db, frames, telemetry  # noqa: E402

#: The five columns migration 0010 appended to ``lap_corner_speeds``, plus the one it
#: appended to ``lap_telemetry``. Everything else in ``frames.TABLE_COLUMNS`` for the two
#: snapshotted tables is pre-existing and is therefore under the zero-difference rule.
#: This list is the *only* place the exemption is spelled: a sixth new column added
#: without being named here is compared like any other, which fails loudly rather than
#: silently widening the exemption.
NEW_IN_0010: dict[str, tuple[str, ...]] = {
    "lap_corner_speeds": (
        "brake_release_m", "brake_release_to_apex_m", "brake_on_distance_m",
        "trail_duty", "trail_status",
    ),
    "lap_telemetry": ("derive_version",),
    "lap_telemetry_summary": (),
}

#: §6.3's B4 row names these two tables. Values are the primary key, in index order --
#: both verified against ``\d`` on the live database, not assumed.
SNAPSHOT_TABLES: dict[str, tuple[str, ...]] = {
    "lap_corner_speeds": ("session_id", "driver_id", "lap_number",
                          "corner_number", "corner_letter"),
    "lap_telemetry_summary": ("session_id", "driver_id", "lap_number"),
}


def pre_existing_columns(table: str) -> list[str]:
    """The columns under the zero-difference rule, in ``frames`` (= physical) order.

    Derived by subtraction from ``frames.TABLE_COLUMNS`` rather than hand-listed, so a
    column that exists in the database but not in ``frames`` is already a
    ``db.assert_schema`` failure and a column added to ``frames`` without being named in
    ``NEW_IN_0010`` is snapshotted and compared. There is no way to add a column that is
    quietly exempt from this check.
    """
    new = set(NEW_IN_0010.get(table, ()))
    cols = [c for c in frames.EXPECTED_COLUMNS[table] if c not in new]
    missing = new - set(frames.EXPECTED_COLUMNS[table])
    if missing:
        raise SystemExit(
            f"{table}: NEW_IN_0010 names {sorted(missing)}, which frames.EXPECTED_COLUMNS "
            "does not carry. Either migration 0010 has not landed or the exemption list "
            "is stale; refusing to snapshot a table whose shape is not understood.")
    return cols


def snapshot_table(conn, table: str, path: Path) -> dict[str, object]:
    """Dump the pre-existing columns of one table to CSV, ordered by its primary key."""
    cols = pre_existing_columns(table)
    pk = SNAPSHOT_TABLES[table]
    sql = (f"COPY (SELECT {', '.join(cols)} FROM {table} "
           f"ORDER BY {', '.join(pk)}) TO STDOUT WITH CSV HEADER")
    digest = hashlib.sha256()
    n_bytes = 0
    with path.open("wb") as fh, conn.cursor() as cur, cur.copy(sql) as cp:
        for chunk in cp:
            b = bytes(chunk)
            fh.write(b)
            digest.update(b)
            n_bytes += len(b)
    with path.open("r", newline="") as fh:
        rows = sum(1 for _ in fh) - 1
    return {"table": table, "path": str(path), "columns": cols, "pk": list(pk),
            "rows": rows, "bytes": n_bytes, "sha256": digest.hexdigest()}


def snapshot(conn, outdir: Path) -> dict[str, object]:
    """§4.3 -- the CSV snapshot taken **before** the ``--force`` re-derive."""
    outdir.mkdir(parents=True, exist_ok=True)
    tables = {t: snapshot_table(conn, t, outdir / f"{t}.csv") for t in SNAPSHOT_TABLES}
    manifest = {"tables": tables, "census": telemetry.trail_census(conn)}
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    for t, meta in tables.items():
        print(f"snapshot {t}: {meta['rows']:,} rows, {len(meta['columns'])} pre-existing "
              f"columns, sha256 {meta['sha256'][:16]}...")
    return manifest


def load_csv(path: Path, pk: list[str]) -> tuple[list[str], dict[tuple, list[str]]]:
    with path.open("r", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        idx = [header.index(c) for c in pk]
        out: dict[tuple, list[str]] = {}
        for row in reader:
            out[tuple(row[i] for i in idx)] = row
    return header, out


def diff_table(before: Path, after: Path, pk: list[str], limit: int = 8) -> dict[str, object]:
    """Row-for-row comparison keyed on the primary key. Order is never a difference.

    The report is per column and per row rather than a boolean: if this ever fires it is
    a release blocker, and the person who has to act on it needs to know *which* stored
    measured number moved, on how many rows, and on which ones.
    """
    hb, rb = load_csv(before, pk)
    ha, ra = load_csv(after, pk)
    rep: dict[str, object] = {
        "rows_before": len(rb), "rows_after": len(ra),
        "header_changed": hb != ha,
        "header_before": hb, "header_after": ha,
        "keys_missing_after": sorted(set(rb) - set(ra))[:limit],
        "n_keys_missing_after": len(set(rb) - set(ra)),
        "keys_added_after": sorted(set(ra) - set(rb))[:limit],
        "n_keys_added_after": len(set(ra) - set(rb)),
    }
    if hb != ha:
        rep["columns_differing"] = {}
        rep["rows_differing"] = None
        rep["examples"] = []
        return rep
    per_col = {c: 0 for c in hb}
    examples: list[dict[str, str]] = []
    changed_keys = 0
    for key in set(rb) & set(ra):
        b, a = rb[key], ra[key]
        if b == a:
            continue
        changed_keys += 1
        for i, col in enumerate(hb):
            if b[i] != a[i]:
                per_col[col] += 1
                if len(examples) < limit:
                    examples.append({"key": "/".join(key), "column": col,
                                     "before": b[i], "after": a[i]})
    rep["columns_differing"] = {c: n for c, n in per_col.items() if n}
    rep["rows_differing"] = changed_keys
    rep["examples"] = examples
    return rep


def corpus_sessions(before: Path) -> list[int]:
    """The session ids the snapshot was taken over -- §4.3's "the 75 telemetried sessions".

    The backfill is defined over the corpus that already had telemetry, not over every
    eligible session, and the pinned constants (24,963 corner rows, 9,408 measured) are
    counts *of that corpus*. Reading the set out of the pre-re-derive snapshot rather
    than from a literal means the acceptance count is compared against the same 75
    sessions it was derived from even if the database later grows.
    """
    path = before / "lap_telemetry_summary.csv"
    with path.open(newline="") as fh:
        return sorted({int(r["session_id"]) for r in csv.DictReader(fh)})


def trail_census_scoped(conn, sessions: list[int]) -> dict[str, int]:
    """``telemetry.trail_census`` restricted to one session set."""
    out: dict[str, int] = {k: 0 for k in telemetry.TRAIL_STATUSES}
    with conn.cursor() as cur:
        cur.execute("SELECT trail_status, count(*) FROM lap_corner_speeds "
                    "WHERE session_id = ANY(%s) GROUP BY 1", (sessions,))
        for status, n in cur.fetchall():
            out[status] = int(n)
        cur.execute("SELECT count(*) FROM lap_telemetry WHERE session_id = ANY(%s) "
                    "AND derive_version <> %s", (sessions, telemetry.TRAIL_DERIVE_VERSION))
        out["laps_at_stale_derive_version"] = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM lap_corner_speeds WHERE session_id = ANY(%s)",
                    (sessions,))
        out["rows"] = int(cur.fetchone()[0])
        cur.execute("SELECT count(DISTINCT session_id) FROM lap_corner_speeds "
                    "WHERE session_id = ANY(%s)", (sessions,))
        out["sessions"] = int(cur.fetchone()[0])
    return out


def assert_backfill(conn, sessions: list[int]) -> tuple[dict[str, int], list[str]]:
    """The backfill acceptance. An equality on pinned constants, never ``> 0``.

    Checked twice, on purpose. The **scoped** check counts only the snapshot's own
    sessions, which is the population WP-B1 derived the constants over -- §4.3's "the 75
    telemetried sessions". The **unscoped** check is ``telemetry.assert_trail_backfill``,
    the same gate ``--check-trail`` runs; it is called here as well because R2's lesson
    is that the guard which blocks a release is the guard somebody loosens, and a
    no-drift script that delegates its whole verdict to the module it is verifying cannot
    notice that happening. If the two disagree, the database holds telemetry outside the
    corpus the pinned constants describe, which is a finding to report, not absorb.
    """
    census = trail_census_scoped(conn, sessions)
    failures: list[str] = []
    want = {
        telemetry.TRAIL_STATUS_MEASURED: telemetry.TRAIL_EXPECTED_MEASURED_ROWS,
        telemetry.TRAIL_STATUS_FLAT: telemetry.TRAIL_FLAT_ROWS,
        telemetry.TRAIL_STATUS_NON_TERMINAL: telemetry.TRAIL_NON_TERMINAL_ROWS,
        "rows": telemetry.TRAIL_CORNER_ROWS,
        "laps_at_stale_derive_version": 0,
    }
    for key, expected in want.items():
        got = census.get(key, 0)
        if got != expected:
            failures.append(
                f"scoped census {key}: got {got:,}, expected exactly {expected:,}. "
                "This is an EQUALITY against a pinned constant, not a '> 0': zero is "
                "not the only wrong answer, and a half-finished --force run, a gate "
                "quietly loosened into producing more measured rows, and a run that "
                "skipped every lap all pass '> 0'.")
    try:
        telemetry.assert_trail_backfill(conn)
    except telemetry.TelemetryError as exc:
        failures.append(f"unscoped census (whole table against a {len(sessions)}-session "
                        f"corpus): {exc}")
    return census, failures


def verify(conn, before: Path, after: Path) -> int:
    """Snapshot after the re-derive, diff against ``before``, and assert the count."""
    print(f"post-re-derive snapshot -> {after}")
    snapshot(conn, after)
    rc = 0
    drift: dict[str, object] = {}
    for table, pk in SNAPSHOT_TABLES.items():
        rep = diff_table(before / f"{table}.csv", after / f"{table}.csv", list(pk))
        drift[table] = rep
        bad = (rep["header_changed"] or rep["n_keys_missing_after"]
               or rep["n_keys_added_after"] or rep["rows_differing"])
        mark = "DRIFT" if bad else "clean"
        print(f"[{mark}] {table}: {rep['rows_before']:,} -> {rep['rows_after']:,} rows, "
              f"{rep['rows_differing']} rows differ on "
              f"{len(rep['columns_differing'])} pre-existing column(s)")
        if bad:
            rc = 1
            # Named separately because they are different defects with different owners:
            # a changed value is a stored measured number that moved (D7); a missing key
            # is data lost by the re-derive; an added key is the corpus growing, which is
            # what an unscoped --force does.
            if rep["n_keys_missing_after"]:
                print(f"         {rep['n_keys_missing_after']:,} pre-existing key(s) "
                      "are GONE after the re-derive")
            if rep["n_keys_added_after"]:
                print(f"         {rep['n_keys_added_after']:,} key(s) exist only after "
                      "the re-derive -- the corpus grew, which a scoped run cannot do")
            for col, n in sorted(rep["columns_differing"].items(), key=lambda kv: -kv[1]):
                print(f"         {col}: {n:,} rows differ")
            for ex in rep["examples"]:
                print(f"         e.g. {ex['key']} {ex['column']}: "
                      f"{ex['before']} -> {ex['after']}")
    sessions = corpus_sessions(before)
    print(f"corpus: {len(sessions)} sessions, read from the pre-re-derive snapshot")
    census, failures = assert_backfill(conn, sessions)
    print("census: " + json.dumps(census, sort_keys=True))
    for f in failures:
        print(f"[FAIL] {f}")
        rc = 1
    (after / "drift.json").write_text(json.dumps(
        {"drift": drift, "census": census, "backfill_failures": failures}, indent=2))
    print("RESULT: " + ("no drift, backfill accepted" if rc == 0
                        else "RELEASE BLOCKED -- see above"))
    return rc


def rederive(dsn: str | None, sessions: list[int]) -> int:
    """§4.3 -- the backfill is ``python -m f1lab.telemetry --force``, **scoped**.

    Not ``scripts/warm_telemetry.py --force``: that script warms the FastF1 cache, has no
    ``--force`` flag and writes no database rows. §4.3 and §4.6 name it and are wrong;
    the derive path is this module. ``--force`` re-reads the cache and makes zero API
    calls (TELEMETRY_SPEC §3.5), so this is a local CPU re-derive of 1,518 laps.

    The scoping is not cosmetic and it is not optional. An unscoped
    ``python -m f1lab.telemetry --force`` runs over every *eligible* session, which is R,
    Q and SQ across the whole schedule -- not the 75 sessions that carry telemetry today.
    Where the FastF1 cache happens to be warm for a race, it **derives that race for the
    first time**, adding laps and corner rows that never existed. That silently grows
    ``lap_corner_speeds`` past the pinned 24,963, inflates the measured count past 9,408,
    and is a change to stored data that D7 forbids. §4.3 says "over the 75 telemetried
    sessions" and means it; the session list comes from the pre-re-derive snapshot so the
    re-derive touches exactly the rows the diff is about to compare.
    """
    cmd = [sys.executable, "-m", "f1lab.telemetry", "--force"]
    for s in sessions:
        cmd += ["--session", str(s)]
    if dsn:
        cmd += ["--dsn", dsn]
    print(f"re-derive: {len(sessions)} session(s), --force, no API calls")
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    return subprocess.call(cmd, cwd=str(ROOT), env=env)


def selftest() -> int:
    """Prove the diff bites, rather than assuming it does.

    A no-drift script that has only ever been run on data that did not drift has not
    been shown to detect drift; "it printed clean" is exactly what a comparison that
    silently compares nothing prints. This plants one changed value, one deleted row and
    one added row into a copy of the real pre-re-derive snapshot and asserts the report
    names all three, with the right column and the right count.
    """
    import shutil
    import tempfile
    src = Path("output/wpB4/pre/lap_corner_speeds.csv")
    if not src.exists():
        raise SystemExit(f"selftest needs a snapshot at {src}; run the snapshot phase first")
    pk = list(SNAPSHOT_TABLES["lap_corner_speeds"])
    with tempfile.TemporaryDirectory() as tmp:
        a = Path(tmp) / "before.csv"
        b = Path(tmp) / "after.csv"
        shutil.copyfile(src, a)
        with a.open() as fh:
            lines = fh.read().splitlines()
        header = lines[0].split(",")
        col = header.index("apex_speed_kph")
        row = lines[1].split(",")
        row[col] = str(int(row[col]) + 1)
        parsed = next(csv.reader([",".join(row)]))
        planted_key = "/".join(parsed[header.index(c)] for c in pk)
        # The last row is dropped, and a key that exists only "after" replaces it: the
        # last row's PK at lap_number + 900, which no real lap carries.
        extra = lines[-1].split(",")
        lap = header.index("lap_number")
        extra[lap] = str(int(extra[lap]) + 900)
        after_lines = [lines[0], ",".join(row)] + lines[2:-1] + [",".join(extra)]
        b.write_text("\n".join(after_lines) + "\n")
        rep = diff_table(a, b, pk)
    ok = True
    checks = [
        ("planted value change detected", rep["columns_differing"].get("apex_speed_kph") == 1),
        ("exactly one row differs", rep["rows_differing"] == 1),
        ("no other column flagged", set(rep["columns_differing"]) == {"apex_speed_kph"}),
        ("the example names the planted key", any(
            e["key"] == planted_key and e["column"] == "apex_speed_kph"
            for e in rep["examples"])),
        ("the dropped row is reported missing", rep["n_keys_missing_after"] == 1),
        ("the invented row is reported added", rep["n_keys_added_after"] == 1),
    ]
    for label, passed in checks:
        print(f"  [{'ok' if passed else 'FAIL'}] {label}")
        ok = ok and passed
    print("selftest: " + ("the diff bites" if ok else "THE DIFF DOES NOT BITE"))
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="no_drift_telemetry.py",
        description="GAPFILL_SPEC §6.3 WP-B4: prove the Gap B re-derive changed nothing "
                    "pre-existing, and that the backfill hit its pinned count exactly.")
    ap.add_argument("phase", choices=("snapshot", "rederive", "verify", "all", "selftest"),
                    help="snapshot: CSV dump before the re-derive. rederive: run it. "
                         "verify: snapshot again, diff, assert the count. all: the three "
                         "in order (long -- the re-derive re-reads 75 sessions).")
    ap.add_argument("--dir", default="output/wpB4/pre",
                    help="snapshot directory written by 'snapshot' (default %(default)s)")
    ap.add_argument("--before", help="pre-re-derive snapshot dir for 'verify' "
                                     "(default: --dir)")
    ap.add_argument("--after", default="output/wpB4/post",
                    help="post-re-derive snapshot dir (default %(default)s)")
    ap.add_argument("--dsn", help="database DSN (default DATABASE_URL, then the local default)")
    args = ap.parse_args(argv)

    if args.phase == "selftest":
        return selftest()

    before = Path(args.before or args.dir)
    after = Path(args.after)
    if args.phase == "rederive":
        return rederive(args.dsn, corpus_sessions(before))

    conn = db.connect(args.dsn)
    try:
        db.assert_schema(conn)
        if args.phase == "snapshot":
            snapshot(conn, Path(args.dir))
            return 0
        if args.phase == "verify":
            if not (before / "lap_corner_speeds.csv").exists():
                raise SystemExit(
                    f"no pre-re-derive snapshot at {before}. The snapshot must be taken "
                    "BEFORE the re-derive; there is no way to reconstruct it after.")
            return verify(conn, before, after)
        snapshot(conn, Path(args.dir))
    finally:
        conn.close()

    rc = rederive(args.dsn, corpus_sessions(Path(args.dir)))
    if rc != 0:
        print(f"[FAIL] re-derive exited {rc}; not diffing a run that did not finish")
        return rc
    conn = db.connect(args.dsn)
    try:
        return verify(conn, Path(args.dir), after)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
